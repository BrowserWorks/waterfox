/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function createGroupTarget(name) {
  const targetTab = BrowserTestUtils.addTab(
    gBrowser,
    `about:blank?native-group-${name}`
  );
  const group = gBrowser.addTabGroup([targetTab], {
    label: `Tabs ${name}`,
  });
  ok(group, "Native tab group was created");
  return { group, targetTab };
}

async function cleanupGroupTabs(group, tabs) {
  if (group?.isConnected && group.collapsed) {
    group.collapsed = false;
  }

  for (const tab of [...new Set(tabs)].reverse()) {
    if (tab && gBrowser.tabs.includes(tab) && !tab.closing) {
      await BrowserTestUtils.removeTab(tab);
    }
  }

  if (group?.isConnected) {
    await BrowserTestUtils.waitForCondition(
      () => !group.isConnected,
      "Waiting for native tab group cleanup"
    );
  }
}

add_task(async function test_cross_window_group_drop_order_without_tree_tabs() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["sidebar.revamp", true],
      ["sidebar.verticalTabs", true],
      ["browser.tabs.groups.enabled", true],
      ["browser.tabs.verticalTabs.tree.enabled", false],
    ],
  });

  await BrowserTestUtils.waitForCondition(
    () => gBrowser.tabContainer.verticalMode,
    "Waiting for vertical tabs in the target window"
  );

  const originalTabs = new Set(gBrowser.tabs);
  const initialTab = gBrowser.selectedTab;
  const reduceMotion = gReduceMotionOverride;
  const { group, targetTab } = createGroupTarget("cross-window-order");
  const adoptedTabs = new Map();
  let sourceWindow;
  let sourceTabs;
  let dragOver;
  const onTabOpen = event => {
    const source = event.detail?.adoptedTab;
    if (sourceTabs?.includes(source)) {
      adoptedTabs.set(source, event.target);
    }
  };
  const onDragOver = event => {
    const dragAndDrop = gBrowser.tabContainer.tabDragAndDrop;
    dragOver = {
      target: dragAndDrop._getDragTarget(event, { ignoreSides: true }),
      index: dragAndDrop._getDropIndex(event),
    };
  };
  gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen);
  gBrowser.tabContainer.addEventListener("dragover", onDragOver, true);

  try {
    sourceWindow = await BrowserTestUtils.openNewBrowserWindow();
    const sourceBrowser = sourceWindow.gBrowser;
    gReduceMotionOverride = true;
    sourceWindow.gReduceMotionOverride = true;
    await BrowserTestUtils.waitForCondition(
      () => sourceBrowser.tabContainer.verticalMode,
      "Waiting for vertical tabs in the source window"
    );
    const urls = ["first", "second", "third"].map(
      name => `about:blank?cross-window-group-${name}`
    );
    sourceTabs = urls.map(url =>
      sourceBrowser.addTrustedTab(url, { skipAnimation: true })
    );
    await Promise.all(
      sourceTabs.map((tab, index) =>
        BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, urls[index])
      )
    );
    await BrowserTestUtils.switchTab(sourceBrowser, sourceTabs[0]);
    sourceBrowser.addRangeToMultiSelectedTabs(sourceTabs[0], sourceTabs[2]);
    await BrowserTestUtils.waitForCondition(
      () => sourceBrowser.selectedTabs.length == sourceTabs.length,
      "Waiting for the source multiselection"
    );
    is(
      sourceBrowser.selectedTab,
      sourceTabs[0],
      "The first moving tab is selected"
    );

    await window.promiseDocumentFlushed(() => {});
    await sourceWindow.promiseDocumentFlushed(() => {});
    const label = group.labelElement;
    const rect = label.getBoundingClientRect();
    const dragEvent = {
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height * 0.375,
    };
    EventUtils.startDragSession(sourceWindow, "move");
    const [result, dataTransfer] = EventUtils.synthesizeDragOver(
      sourceTabs[0],
      label,
      null,
      "move",
      sourceWindow,
      window,
      dragEvent
    );
    ok(dragOver, "The real cross-window dragover reaches the target");
    is(
      dragOver.target,
      label,
      "The drop is inside the group label's central region"
    );
    is(
      dragOver.index,
      label.elementIndex,
      "The leading-center drop initially places adopted tabs before the group"
    );
    Assert.deepEqual(
      sourceTabs[0]._dragData.movingTabs,
      sourceTabs,
      "Native dragstart retains the physical multiselection order"
    );
    is(
      EventUtils.synthesizeDropAfterDragOver(
        result,
        dataTransfer,
        label,
        window,
        dragEvent
      ),
      "move",
      "The native cross-window drop is accepted"
    );
    sourceWindow.windowUtils.dragSession?.endDragSession(true, 0);

    await BrowserTestUtils.waitForCondition(
      () => group.tabs.length == sourceTabs.length + 1,
      "Waiting for the adopted multiselection to join the target group"
    );
    Assert.deepEqual(
      [...adoptedTabs.keys()],
      [sourceTabs[1], sourceTabs[2], sourceTabs[0]],
      "The selected tab is still adopted last"
    );
    Assert.deepEqual(
      group.tabs,
      [targetTab, ...sourceTabs.map(tab => adoptedTabs.get(tab))],
      "Grouping uses physical order, not selected-last adoption order"
    );
    is(
      gBrowser.selectedTab,
      adoptedTabs.get(sourceTabs[0]),
      "The dragged tab stays selected"
    );
    ok(
      sourceTabs.every(tab => !tab.isConnected),
      "All selected source tabs were adopted"
    );
  } finally {
    gBrowser.tabContainer.removeEventListener("TabOpen", onTabOpen);
    gBrowser.tabContainer.removeEventListener("dragover", onDragOver, true);
    sourceWindow?.windowUtils.dragSession?.endDragSession(true, 0);
    gBrowser.clearMultiSelectedTabs();
    gBrowser.selectedTab = initialTab;
    if (sourceWindow && !sourceWindow.closed) {
      await BrowserTestUtils.closeWindow(sourceWindow);
    }
    await cleanupGroupTabs(
      group,
      gBrowser.tabs.filter(tab => !originalTabs.has(tab))
    );
    gReduceMotionOverride = reduceMotion;
    await SpecialPowers.popPrefEnv();
  }
});
