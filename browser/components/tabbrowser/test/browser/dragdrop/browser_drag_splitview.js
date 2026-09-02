/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let currentReduceMotionOverride;

add_setup(() => {
  currentReduceMotionOverride = gReduceMotionOverride;
  // Disable tab animations
  gReduceMotionOverride = true;
});

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed");
  Services.prefs.clearUserPref("sidebar.verticalTabs.dragToPinPromo.dismissed");
});

add_task(async function test_drag_splitview_tab() {
  let [tab1, tab2, tab3] = await Promise.all(
    Array.from({ length: 3 }).map((_, index) =>
      addTab(`data:text/plain,tab${index + 1}`)
    )
  );

  const startingTab = gBrowser.tabs[0];
  let splitview = gBrowser.addTabSplitView([tab2, tab3]);
  Assert.equal(splitview.tabs.length, 2, "Split view has 2 tabs");

  Assert.deepEqual(
    gBrowser.tabs,
    [startingTab, tab1, tab2, tab3],
    "confirm tabs' starting order"
  );
  try {
    info("Drag a splitview tab");
    await customDragAndDrop(tab3, tab1, null, waitForTabMove(tab3));

    Assert.deepEqual(
      gBrowser.tabs,
      [startingTab, tab2, tab3, tab1],
      "Confirm that tab3 and tab2 in a splitview move together before tab1"
    );

    info("Drag a tab in between a splitview");
    await customDragAndDrop(tab1, tab2, null, waitForTabMove(tab1));

    Assert.deepEqual(
      gBrowser.tabs,
      [startingTab, tab1, tab2, tab3],
      "Confirm that tab1 cannot be dragged in between splitview tabs"
    );

    let group = gBrowser.addTabGroup([tab1, splitview]);
    Assert.equal(group.tabs.length, 3, "group has 3 tabs");

    Assert.deepEqual(
      gBrowser.tabs,
      [startingTab, tab1, tab2, tab3],
      "Confirm that splitview tabs can be reordered within a tab group"
    );
    // ensure we drag before tab 1, not after
    let event = getDragEvent();
    info("Drag splitview tabs within a tab group");
    await customDragAndDrop(tab2, tab1, null, null, event);

    Assert.deepEqual(
      gBrowser.tabs,
      [startingTab, tab2, tab3, tab1],
      "Confirm that splitview tabs can be reordered within a tab group"
    );
  } finally {
    BrowserTestUtils.removeTab(tab1);
    BrowserTestUtils.removeTab(tab2);
    BrowserTestUtils.removeTab(tab3);
  }
});

add_task(async function test_dragging_splitview_second_window() {
  let win2 = await BrowserTestUtils.openNewBrowserWindow();
  let [tab1, tab2] = await Promise.all(
    Array.from({ length: 2 }).map((_, index) =>
      addTab(`data:text/plain,tab${index + 1}`)
    )
  );

  let splitview = window.gBrowser.addTabSplitView([tab1, tab2]);
  Assert.equal(splitview.tabs.length, 2, "Split view has 2 tabs");

  let secondWindowTab1 = win2.gBrowser.tabs[0];
  let secondWindowTab2 = BrowserTestUtils.addTab(
    win2.gBrowser,
    "data:text/plain,tab4"
  );

  is(win2.gBrowser.tabs.length, 2, "win2 contains 2 tabs");

  let awaitCloseEvent = BrowserTestUtils.waitForEvent(tab1, "TabClose");
  let awaitOpenEvent = BrowserTestUtils.waitForEvent(win2, "TabOpen");

  let effect = EventUtils.synthesizeDrop(
    tab1,
    secondWindowTab1,
    [[{ type: TAB_DROP_TYPE, data: tab1 }]],
    null,
    window,
    win2
  );
  is(effect, "move", "Tabs should be moved from win1 to win2.");

  let closeEvent = await awaitCloseEvent;
  let openEvent = await awaitOpenEvent;

  is(openEvent.detail.adoptedTab, tab1, "New tab adopted old tab");

  is(
    closeEvent.detail.adoptedBy,
    openEvent.target,
    "Old tab adopted by new tab"
  );

  is(
    win2.gBrowser.tabs.length,
    4,
    "win2 contains 2 new tabs, for a total of 4"
  );

  let [secondWindowTab3, secondWindowTab4] = win2.gBrowser.tabs.slice(1, 3);

  Assert.deepEqual(
    win2.gBrowser.tabs,
    [secondWindowTab1, secondWindowTab3, secondWindowTab4, secondWindowTab2],
    "Two new tabs were inserted in the correct position in the second window"
  );

  ok(
    secondWindowTab3.splitview && secondWindowTab4.splitview,
    "Two new tabs in second window are splitview tabs"
  );

  await BrowserTestUtils.closeWindow(win2);
});

add_task(async function test_drag_link_before_or_after_splitview_tabs() {
  // Setup: [Tab1, (Tab2, Tab3), Tab4]
  const tab1 = gBrowser.tabs[0];
  const tab2 = await addTab("data:text/plain,tab2");
  const tab3 = await addTab("data:text/plain,tab3");
  gBrowser.addTabSplitView([tab2, tab3]);
  const tab4 = await addTab("data:text/plain,tab4");
  Assert.deepEqual(
    gBrowser.tabs,
    [tab1, tab2, tab3, tab4],
    "confirm tabs' starting order"
  );

  // Create a draggable link
  let linkEl = document.createXULElement("label");
  linkEl.setAttribute("value", "Draggable Link");
  linkEl.setAttribute("draggable", "true");
  document.documentElement.appendChild(linkEl);

  info("Drag and drop the link before the Split View.");
  const url = "https://example.com/";
  let rect = tab2.getBoundingClientRect();
  let promiseTabOpen = BrowserTestUtils.waitForEvent(window, "TabOpen");
  EventUtils.synthesizeDrop(
    linkEl,
    tab2,
    [[{ type: "text/uri-list", data: url }]],
    "link",
    window,
    window,
    {
      clientX: rect.left + 10,
      clientY: rect.top + rect.height / 2,
    }
  );
  await promiseTabOpen;

  // Verify Result: [Tab1, NEW, (Tab2, Tab3), Tab4]
  Assert.equal(gBrowser.tabs.length, 5, "Should have 5 tabs after drop.");
  let newTab = gBrowser.tabs[1];
  await BrowserTestUtils.browserLoaded(newTab.linkedBrowser, { wantLoad: url });
  Assert.ok(!newTab.splitview, "New tab is not part of the split view.");
  Assert.deepEqual(
    gBrowser.tabs,
    [tab1, newTab, tab2, tab3, tab4],
    "Order should be [A, New, B, C, D]"
  );
  BrowserTestUtils.removeTab(newTab);

  info("Drag and drop the link after the Split View.");
  rect = tab3.getBoundingClientRect();
  promiseTabOpen = BrowserTestUtils.waitForEvent(window, "TabOpen");
  EventUtils.synthesizeDrop(
    linkEl,
    tab3,
    [[{ type: "text/uri-list", data: url }]],
    "link",
    window,
    window,
    {
      clientX: rect.right - 10,
      clientY: rect.top + rect.height / 2,
    }
  );
  await promiseTabOpen;

  // Verify Result: [Tab1, (Tab2, Tab3), NEW, Tab4]
  Assert.equal(gBrowser.tabs.length, 5, "Should have 5 tabs after drop.");
  newTab = gBrowser.tabs[3];
  await BrowserTestUtils.browserLoaded(newTab.linkedBrowser, { wantLoad: url });
  Assert.ok(!newTab.splitview, "New tab is not part of the split view.");
  Assert.deepEqual(
    gBrowser.tabs,
    [tab1, tab2, tab3, newTab, tab4],
    "Order should be [A, B, C, New, D]"
  );
  BrowserTestUtils.removeTab(newTab);

  info("Drag and drop the link within the margins of the Split View wrapper.");
  const splitViewBox = tab2.splitview.getBoundingClientRect();
  promiseTabOpen = BrowserTestUtils.waitForEvent(window, "TabOpen");
  EventUtils.synthesizeDrop(
    linkEl,
    gBrowser.tabContainer.arrowScrollbox,
    [[{ type: "text/uri-list", data: url }]],
    "link",
    window,
    window,
    {
      clientX: splitViewBox.left + splitViewBox.width * 0.75,
      clientY: splitViewBox.bottom + 1,
    }
  );
  await promiseTabOpen;

  // Verify Result: [Tab1, (Tab2, Tab3), NEW, Tab4]
  Assert.equal(gBrowser.tabs.length, 5, "Should have 5 tabs after drop.");
  newTab = gBrowser.tabs[3];
  await BrowserTestUtils.browserLoaded(newTab.linkedBrowser, { wantLoad: url });
  Assert.ok(!newTab.splitview, "New tab is not part of the split view.");
  Assert.deepEqual(
    gBrowser.tabs,
    [tab1, tab2, tab3, newTab, tab4],
    "Order should be [A, B, C, New, D]"
  );
  BrowserTestUtils.removeTab(newTab);

  // Cleanup
  BrowserTestUtils.removeTab(tab2);
  BrowserTestUtils.removeTab(tab3);
  BrowserTestUtils.removeTab(tab4);
  linkEl.remove();
});

async function test_drag_link_onto_splitview_tabs(isRTL) {
  const tab1 = await addTab("data:text/plain,tab1");
  const tab2 = await addTab("data:text/plain,tab2");
  const splitView = gBrowser.addTabSplitView([tab1, tab2]);

  // Determine visual position for targeting.
  // LTR: Tab 1 is Left, Tab 2 is Right
  // RTL: Tab 2 is Left, Tab 1 is Right
  const leftTab = isRTL ? tab2 : tab1;
  const rightTab = isRTL ? tab1 : tab2;

  // Create a draggable link
  let linkEl = document.createXULElement("label");
  linkEl.setAttribute("value", "Draggable Link");
  linkEl.setAttribute("draggable", "true");
  document.documentElement.appendChild(linkEl);

  async function dropLink(target, clientX, clientY) {
    const promiseLoaded = BrowserTestUtils.browserLoaded(target.linkedBrowser, {
      wantLoad: url,
    });
    EventUtils.synthesizeDrop(
      linkEl,
      target,
      [[{ type: "text/uri-list", data: url }]],
      "link",
      window,
      window,
      { clientX, clientY }
    );
    await promiseLoaded;
  }

  info("Drop a link onto the left tab.");
  const url = "https://example.com/";
  let rect = leftTab.getBoundingClientRect();
  await dropLink(leftTab, rect.right - 10, rect.top + rect.height / 2);
  Assert.equal(gBrowser.tabs.length, 3, "No new tabs opened.");

  info("Drop a link onto the right tab.");
  rect = rightTab.getBoundingClientRect();
  await dropLink(rightTab, rect.left + 10, rect.top + rect.height / 2);
  Assert.equal(gBrowser.tabs.length, 3, "No new tabs opened.");

  splitView.close();
}

add_task(async function test_drag_link_onto_splitview_tabs_ltr() {
  await test_drag_link_onto_splitview_tabs(false);
});

add_task(async function test_drag_link_onto_splitview_tabs_rtl() {
  try {
    await BrowserTestUtils.enableRtlLocale();
    await test_drag_link_onto_splitview_tabs(true);
  } finally {
    await BrowserTestUtils.disableRtlLocale();
  }
});

add_task(
  async function test_drag_group_label_with_splitview_to_second_window_pinned_area() {
    let win2 = await BrowserTestUtils.openNewBrowserWindow();
    // Two pinned tabs guarantee the drop index lands within the pinned area
    // regardless of whether synthesizeDrop places the cursor before or after
    // the midpoint of the target tab.
    let win2PinnedTab1 = BrowserTestUtils.addTab(win2.gBrowser, "about:blank", {
      pinned: true,
    });
    BrowserTestUtils.addTab(win2.gBrowser, "about:blank", { pinned: true });
    is(win2.gBrowser.pinnedTabCount, 2, "Two pinned tabs in win2");

    let normalTab = await addTab();
    let splitTab1 = await addTab();
    let splitTab2 = await addTab();
    let splitview = gBrowser.addTabSplitView([splitTab1, splitTab2]);
    let group = gBrowser.addTabGroup([normalTab, splitview]);

    is(group.tabs.length, 3, "Group has 3 tabs (1 normal + 2 split view)");

    let tabsClosePromise = Promise.all([
      BrowserTestUtils.waitForEvent(normalTab, "TabClose"),
      BrowserTestUtils.waitForEvent(splitTab1, "TabClose"),
      BrowserTestUtils.waitForEvent(splitTab2, "TabClose"),
    ]);

    let groupLabel = group.labelElement;
    EventUtils.synthesizeDrop(
      groupLabel,
      win2PinnedTab1,
      [[{ type: TAB_DROP_TYPE, data: groupLabel }]],
      null,
      window,
      win2
    );

    await tabsClosePromise;

    is(
      win2.gBrowser.pinnedTabCount,
      2,
      "Pinned tab count is unchanged after adopting group containing a split view"
    );
    let adoptedSplitTabs = win2.gBrowser.tabs.filter(
      t => !t.pinned && t.splitview
    );
    is(
      adoptedSplitTabs.length,
      2,
      "Two unpinned split view tabs adopted into win2"
    );
    let unpinnedNonSplitTabs = win2.gBrowser.tabs.filter(
      t => !t.pinned && !t.splitview
    );
    +is(
      unpinnedNonSplitTabs.length,
      2,
      "Default tab + adopted normal tab, both unpinned in win2"
    );

    await BrowserTestUtils.closeWindow(win2);
  }
);

add_task(async function test_drag_tab_group_label_with_splitview() {
  // [(startingTab, tab1), tab2, [Group: (tab3 | tab4)], tab5]
  const startingTab = gBrowser.tabs[0];
  let [tab1, tab2, tab3, tab4] = await Promise.all(
    Array.from({ length: 4 }).map((_, index) =>
      addTab(`data:text/plain,tab${index + 1}`)
    )
  );

  let splitView = gBrowser.addTabSplitView([startingTab, tab1]);
  let splitView2 = gBrowser.addTabSplitView([tab3, tab4]);
  let group = gBrowser.addTabGroup([splitView2]);

  // Select a tab in a splitview before checking for the blue outline that should be visible
  gBrowser.selectedTab = tab1;
  Assert.equal(
    gBrowser.selectedTab,
    tab1,
    "Tab 1 in a splitview is the selected tab"
  );
  const tab1Panel = document.getElementById(tab1.linkedPanel);
  const tab1BrowserContainer = tab1Panel.querySelector(".browserContainer");
  const splitViewOutlineSelector =
    "#tabbrowser-tabpanels[splitview] .split-view-panel.deck-selected > .browserContainer";
  await BrowserTestUtils.waitForMutationCondition(
    tab1Panel,
    { attributes: true, attributeFilter: ["class"] },
    () => tab1BrowserContainer.matches(splitViewOutlineSelector)
  );
  Assert.ok(
    tab1BrowserContainer.matches(splitViewOutlineSelector),
    "Tab panel has blue outline"
  );

  let tab5 = await addTab("data:text/plain,tab5");
  gBrowser.selectedTab = tab5;
  Assert.equal(gBrowser.selectedTab, tab5, "Tab 5 is the selected tab");

  Assert.deepEqual(
    gBrowser.tabs,
    [tab2, startingTab, tab1, tab3, tab4, tab5],
    "confirm tabs' starting order"
  );

  info("Drag and drop tab group containing splitview tabs");
  let dragend = BrowserTestUtils.waitForEvent(group.labelElement, "dragend");
  EventUtils.synthesizePlainDragAndDrop({
    srcElement: group.labelElement,
    destElement: tab2,
  });
  await dragend;

  Assert.deepEqual(
    gBrowser.tabs,
    [tab2, tab3, tab4, startingTab, tab1, tab5],
    "Group with split view moved after tab2"
  );

  // Select a non-splitview tab before checking for the blue outline that shouldn't be
  // visible (only in the content area for tabs in a splitview).
  gBrowser.selectedTab = tab5;
  Assert.equal(gBrowser.selectedTab, tab5, "Tab 5 is the selected tab");

  await BrowserTestUtils.waitForMutationCondition(
    tab1Panel,
    { attributes: true, attributeFilter: ["class"] },
    () => !tab1BrowserContainer.matches(splitViewOutlineSelector)
  );
  Assert.ok(
    !tab1BrowserContainer.matches(splitViewOutlineSelector),
    "Tab panel does not have blue outline"
  );

  // cleanup
  splitView.close();
  splitView2.close();
  await removeTabGroup(group);
  BrowserTestUtils.removeTab(tab5);
});

add_task(
  async function test_drag_splitview_to_second_window_before_tab_group() {
    let win2 = await BrowserTestUtils.openNewBrowserWindow();

    // Set up window 2: [win2StartingTab, Group(win2GroupTab)]
    let win2StartingTab = win2.gBrowser.tabs[0];
    let win2GroupTab = BrowserTestUtils.addTab(win2.gBrowser, "about:blank");
    let win2Group = win2.gBrowser.addTabGroup([win2GroupTab]);
    is(win2.gBrowser.tabs.length, 2, "win2 has 2 tabs");

    // Set up window 1: splitview(splitTab1, splitTab2)
    let [splitTab1, splitTab2] = await Promise.all(
      Array.from({ length: 2 }).map((_, index) =>
        addTab(`data:text/plain,tab${index + 1}`)
      )
    );
    let splitview = gBrowser.addTabSplitView([splitTab1, splitTab2]);
    is(splitview.tabs.length, 2, "splitview has 2 tabs");

    let tabsClosePromise = Promise.all([
      BrowserTestUtils.waitForEvent(splitTab1, "TabClose"),
      BrowserTestUtils.waitForEvent(splitTab2, "TabClose"),
    ]);

    // Drop the split view onto the group label in win2 before the midpoint,
    // so the drop index lands at the group label's element index (before the group).
    let win2GroupLabel = win2Group.labelElement;
    let rect = win2GroupLabel.getBoundingClientRect();
    EventUtils.synthesizeDrop(
      splitTab1,
      win2GroupLabel,
      [[{ type: TAB_DROP_TYPE, data: splitTab1 }]],
      null,
      window,
      win2,
      { clientX: rect.left + 1 }
    );

    await tabsClosePromise;

    is(
      win2.gBrowser.tabs.length,
      4,
      "win2 has 4 tabs after split view adoption"
    );

    let [, adoptedSplitTab1, adoptedSplitTab2] = win2.gBrowser.tabs;

    Assert.deepEqual(
      win2.gBrowser.tabs,
      [win2StartingTab, adoptedSplitTab1, adoptedSplitTab2, win2GroupTab],
      "Split view tabs are inserted before the tab group"
    );

    Assert.ok(
      adoptedSplitTab1.splitview && adoptedSplitTab2.splitview,
      "Adopted tabs are in a split view in win2"
    );

    Assert.ok(
      !adoptedSplitTab1.group && !adoptedSplitTab2.group,
      "Adopted split view tabs are not inside the tab group"
    );

    await BrowserTestUtils.closeWindow(win2);
  }
);

add_task(async function test_dragstart_below_splitview_does_not_grab() {
  // Test that dragging in the margin below a split view (the gap between the
  // wrapper and the nav bar) does not grab the split view.
  const tab2 = await addTab("data:text/plain,tab2");
  const tab3 = await addTab("data:text/plain,tab3");
  const splitView = gBrowser.addTabSplitView([tab2, tab3]);

  const tabOrder = [...gBrowser.tabs];

  const arrowScrollbox = gBrowser.tabContainer.arrowScrollbox;
  const scrollboxRect = arrowScrollbox.getBoundingClientRect();
  const splitViewRect = splitView.getBoundingClientRect();
  Assert.greater(
    scrollboxRect.bottom,
    splitViewRect.bottom,
    "The scrollbox extends below the split view wrapper"
  );

  // Compute drag source centered on the wrapper, but in its bottom margin.
  const srcX =
    splitViewRect.left + splitViewRect.width / 2 - scrollboxRect.left;
  const srcY =
    (splitViewRect.bottom + scrollboxRect.bottom) / 2 - scrollboxRect.top;

  info("Drag horizontally through the bottom margin of split view wrapper.");
  // FIXME Bug 2044440 - synthesizePlainDragAndDrop() should suppress a11y checks for expectCancelDragStart
  AccessibilityUtils.setEnv({ mustHaveAccessibleRule: false });
  await EventUtils.synthesizePlainDragAndDrop({
    srcElement: arrowScrollbox,
    srcX,
    srcY,
    stepX: 9,
    stepY: 0,
    expectCancelDragStart: true,
  });
  AccessibilityUtils.resetEnv();

  Assert.deepEqual(
    gBrowser.tabs,
    tabOrder,
    "Tab order is unchanged after dragging below the split view wrapper"
  );

  splitView.close();
});
