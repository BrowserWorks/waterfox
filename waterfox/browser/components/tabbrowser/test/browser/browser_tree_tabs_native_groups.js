/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TreeTabsUI } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsUI.sys.mjs"
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.groups.enabled", true],
      ["browser.tabs.verticalTabs.tree.expandNativeGroupOnTreeExpand", true],
    ],
  });
});

function getTreeTabsController() {
  const controller = TreeTabsUI._controllers.get(window);
  ok(controller, "Tree tabs controller is available for the browser window");
  return controller;
}

function createNativeGroupTarget(name) {
  const targetTab = BrowserTestUtils.addTab(
    gBrowser,
    `about:blank?tree-native-group-${name}`
  );
  gBrowser.TreeTabsService.detachTab(targetTab);
  const group = gBrowser.addTabGroup([targetTab], {
    label: `Tree tabs ${name}`,
  });
  ok(group, "Native tab group was created");
  return { group, targetTab };
}

async function cleanupNativeGroupTabs(group, tabs) {
  if (group?.isConnected && group.collapsed) {
    group.collapsed = false;
  }

  for (const tab of [...new Set(tabs)].reverse()) {
    if (tab && gBrowser.tabs.includes(tab) && !tab.closing) {
      await BrowserTestUtils.removeTab(tab);
    }
  }

  if (group?.isConnected) {
    await waitForTreeCondition(
      () => !group.isConnected,
      "Waiting for native tab group cleanup"
    );
  }
}

add_task(async function test_dropped_links_open_as_grouped_tree_children() {
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_AUTO_ATTACH, 0);

  const controller = getTreeTabsController();
  const { group, targetTab } = createNativeGroupTarget("children");
  const openedTabs = [];

  try {
    const existingTabs = new Set(gBrowser.tabs);
    const urls = [
      "about:blank?tree-native-group-child-1",
      "about:blank?tree-native-group-child-2",
    ];

    await controller._openDroppedLinksOnTab({
      behavior: 2,
      inBackground: true,
      policyContainer: null,
      targetGroup: group,
      targetTab,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      urls,
    });

    await waitForTreeCondition(
      () =>
        gBrowser.tabs.filter(tab => !existingTabs.has(tab)).length ==
        urls.length,
      "Waiting for dropped links to open"
    );
    openedTabs.push(...gBrowser.tabs.filter(tab => !existingTabs.has(tab)));
    await waitForTreeCondition(
      () =>
        openedTabs.every(
          tab => getTreeParent(tab) == targetTab && tab.group == group
        ),
      "Waiting for dropped links to join the tree and native group"
    );

    is(openedTabs.length, urls.length, "Both dropped links opened in new tabs");
    is(
      gBrowser.TreeTabsService.getChildren(targetTab).length,
      urls.length,
      "Target tab owns both dropped links as tree children"
    );
    for (const tab of openedTabs) {
      is(getTreeParent(tab), targetTab, "Dropped link is a tree child");
      is(tab.group, group, "Dropped link remains in the native group");
      ok(group.tabs.includes(tab), "Native group lists the dropped link tab");
    }
  } finally {
    await cleanupNativeGroupTabs(group, [targetTab, ...openedTabs]);
  }
});

add_task(async function test_replacement_drop_extras_remain_grouped() {
  await enableTreeTabs();

  const controller = getTreeTabsController();
  const { group, targetTab } = createNativeGroupTarget("replace");
  const extraTabs = [];

  try {
    const existingTabs = new Set(gBrowser.tabs);
    const urls = [
      "data:text/plain,tree-native-group-replacement",
      "data:text/plain,tree-native-group-replacement-extra",
    ];
    const targetLoaded = BrowserTestUtils.browserLoaded(
      targetTab.linkedBrowser,
      false,
      urls[0]
    );

    await controller._openDroppedLinksOnTab({
      behavior: 0,
      inBackground: true,
      policyContainer: null,
      targetGroup: group,
      targetTab,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      urls,
    });
    await targetLoaded;

    await waitForTreeCondition(
      () =>
        gBrowser.tabs.filter(tab => !existingTabs.has(tab)).length ==
        urls.length - 1,
      "Waiting for replacement drop extras to open"
    );
    extraTabs.push(...gBrowser.tabs.filter(tab => !existingTabs.has(tab)));

    is(
      targetTab.linkedBrowser.currentURI.spec,
      urls[0],
      "First dropped URL replaces the target tab"
    );
    is(extraTabs.length, 1, "Second dropped URL opens one extra tab");
    is(
      targetTab.group,
      group,
      "Replacement target remains in its native group"
    );
    for (const tab of extraTabs) {
      is(tab.group, group, "Replacement extra remains in the native group");
      ok(group.tabs.includes(tab), "Native group lists the replacement extra");
    }
  } finally {
    await cleanupNativeGroupTabs(group, [targetTab, ...extraTabs]);
  }
});

add_task(async function test_tree_expand_expands_native_group() {
  await enableTreeTabs();

  const outsideTab = gBrowser.selectedTab;
  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?tree-native-group-expand-parent"
  );
  gBrowser.TreeTabsService.detachTab(parentTab);
  const childTab = await openTabWithTree(
    parentTab,
    "about:blank?tree-native-group-expand-child"
  );
  const group = gBrowser.addTabGroup([parentTab, childTab], {
    label: "Tree expand",
  });

  try {
    await waitForTreeCondition(
      () => getTreeParent(childTab) == parentTab,
      "Waiting for grouped tabs to retain their tree relationship"
    );
    await BrowserTestUtils.switchTab(gBrowser, outsideTab);

    gBrowser.TreeTabsService.collapseSubtree(parentTab);
    await waitForTreeCondition(
      () => gBrowser.TreeTabsService.isCollapsed(parentTab),
      "Waiting for member tree to collapse"
    );

    const groupCollapsed = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupCollapse"
    );
    group.collapsed = true;
    await groupCollapsed;

    const groupExpanded = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupExpand"
    );
    gBrowser.TreeTabsService.expandSubtree(parentTab);
    await groupExpanded;

    ok(
      !gBrowser.TreeTabsService.isCollapsed(parentTab),
      "Member tree is expanded"
    );
    ok(!group.collapsed, "Expanding a member tree expands its native group");
  } finally {
    await cleanupNativeGroupTabs(group, [parentTab, childTab]);
  }
});

add_task(async function test_collapsed_group_uses_only_native_counter() {
  await enableTreeTabs();

  const outsideTab = gBrowser.selectedTab;
  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?tree-native-group-counter-parent"
  );
  gBrowser.TreeTabsService.detachTab(parentTab);
  const childTab = await openTabWithTree(
    parentTab,
    "about:blank?tree-native-group-counter-child"
  );
  const group = gBrowser.addTabGroup([parentTab, childTab], {
    label: "Tree counter",
  });

  try {
    gBrowser.TreeTabsService.collapseSubtree(parentTab);
    if (gBrowser.selectedTab != parentTab) {
      await BrowserTestUtils.switchTab(gBrowser, parentTab);
    }

    const groupCollapsed = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupCollapse"
    );
    group.collapsed = true;
    await groupCollapsed;
    await waitForTreeCondition(
      () =>
        window.getComputedStyle(
          parentTab.querySelector(".tab-content"),
          "::before"
        ).content == "none",
      "Waiting for the tree counter to yield to the native group counter"
    );

    is(
      parentTab
        .querySelector(".tab-content")
        ?.getAttribute("data-tree-counter"),
      "1",
      "The logical descendant count remains available"
    );
    is(
      window.getComputedStyle(
        parentTab.querySelector(".tab-content"),
        "::before"
      ).content,
      "none",
      "The tree count is not rendered beside the native group count"
    );
    is(
      window.getComputedStyle(group.overflowContainer).display,
      "flex",
      "The native group count remains visible"
    );
  } finally {
    if (gBrowser.selectedTab != outsideTab) {
      await BrowserTestUtils.switchTab(gBrowser, outsideTab);
    }
    await cleanupNativeGroupTabs(group, [parentTab, childTab]);
  }
});

add_task(async function test_native_groups_reject_cross_group_tree_edges() {
  await enableTreeTabs();

  const first = createNativeGroupTarget("cross-edge-parent");
  const second = createNativeGroupTarget("cross-edge-child");

  try {
    ok(
      !gBrowser.TreeTabsService.attachTab(second.targetTab, first.targetTab),
      "Attaching tabs across native group boundaries is rejected"
    );
    is(
      getTreeParent(second.targetTab),
      null,
      "Rejected cross-group attachment leaves the tab detached"
    );

    second.targetTab.openerTab = first.targetTab;
    gBrowser._tabAttrModified(second.targetTab, ["openerTab"]);
    await waitForTreeUpdate();
    is(
      getTreeParent(second.targetTab),
      null,
      "Cross-group opener synchronization does not create a tree edge"
    );
  } finally {
    await cleanupNativeGroupTabs(first.group, [first.targetTab]);
    await cleanupNativeGroupTabs(second.group, [second.targetTab]);
  }
});

async function checkCrossWindowMultiselectionGroupDrop(treeEnabled) {
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_TREE_ENABLED, treeEnabled],
      [PREF_TREE_AUTO_ATTACH, 0],
      [PREF_TREE_AUTO_COLLAPSE_ON_SELECT, false],
    ],
  });

  const originalTabs = new Set(gBrowser.tabs);
  const initialTab = gBrowser.selectedTab;
  const reduceMotion = gReduceMotionOverride;
  const { group, targetTab } = createNativeGroupTarget("cross-window-order");
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
    await waitForTreeCondition(
      () => sourceBrowser.tabContainer.verticalMode,
      "Waiting for vertical tabs in the source window"
    );
    const urls = ["first", "second", "third"].map(
      name => `about:blank?tree-cross-window-group-${name}`
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
    await waitForTreeCondition(
      () => sourceBrowser.selectedTabs.length == sourceTabs.length,
      "Waiting for the source multiselection"
    );
    is(
      sourceBrowser.selectedTab,
      sourceTabs[0],
      "The first moving tab is selected"
    );
    is(
      sourceBrowser.TreeTabsService.enabled,
      treeEnabled,
      "Source tree mode matches the case"
    );
    is(
      gBrowser.TreeTabsService.enabled,
      treeEnabled,
      "Target tree mode matches the case"
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

    await waitForTreeCondition(
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
    window.TreeTabsDnD?._endDrop();
    gBrowser.clearMultiSelectedTabs();
    gBrowser.selectedTab = initialTab;
    if (sourceWindow && !sourceWindow.closed) {
      await BrowserTestUtils.closeWindow(sourceWindow);
    }
    await cleanupNativeGroupTabs(
      group,
      gBrowser.tabs.filter(tab => !originalTabs.has(tab))
    );
    gReduceMotionOverride = reduceMotion;
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_cross_window_multiselection_group_drop_order() {
  await checkCrossWindowMultiselectionGroupDrop(true);
});

add_task(async function test_cross_window_group_drop_order_without_tree_tabs() {
  await checkCrossWindowMultiselectionGroupDrop(false);
});

add_task(async function test_drag_auto_expanded_native_group_is_restored() {
  await enableTreeTabs();

  const controller = getTreeTabsController();
  const { group, targetTab } = createNativeGroupTarget("drag-restore");

  try {
    const groupCollapsed = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupCollapse"
    );
    group.collapsed = true;
    await groupCollapsed;

    controller._dragAutoExpandedGroups.add(group);
    const groupExpanded = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupExpand"
    );
    group.collapsed = false;
    await groupExpanded;

    const groupRecollapsed = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupCollapse"
    );
    controller._restoreDragAutoExpandedTabs();
    await groupRecollapsed;

    ok(group.collapsed, "Drag-auto-expanded native group is re-collapsed");
    ok(
      !controller._dragAutoExpandedGroups.has(group),
      "Restored native group is removed from the drag expansion set"
    );
  } finally {
    controller._dragAutoExpandedGroups.delete(group);
    await cleanupNativeGroupTabs(group, [targetTab]);
  }
});
