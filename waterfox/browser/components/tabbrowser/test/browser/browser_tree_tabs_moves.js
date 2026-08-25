/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_external_move_of_expanded_parent_promotes_first() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?move-expanded-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childA = await openTabWithTree(parentTab, "about:blank");
  const childB = await openTabWithTree(parentTab, "about:blank");
  const otherTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?move-expanded-other"
  );

  gBrowser.moveTabToEnd(parentTab);
  await waitForTreeCondition(
    () => getTreeParent(childA) == null,
    "Waiting for the first child to take the moved parent's place"
  );

  is(getTreeParent(childA), null, "First child is promoted in place");
  is(
    getTreeParent(childB),
    childA,
    "Second child moves under the promoted first child"
  );
  is(
    gBrowser.TreeTabsService.getChildren(parentTab).length,
    0,
    "Moved parent leaves its children behind"
  );
  Assert.greater(
    parentTab._tPos,
    otherTab._tPos,
    "Parent physically moved to the end alone"
  );

  BrowserTestUtils.removeTab(otherTab);
  BrowserTestUtils.removeTab(childB);
  BrowserTestUtils.removeTab(childA);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(async function test_external_move_of_collapsed_parent_takes_subtree() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?move-collapsed-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childA = await openTabWithTree(parentTab, "about:blank");
  const childB = await openTabWithTree(parentTab, "about:blank");
  const otherTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?move-collapsed-other"
  );

  if (gBrowser.selectedTab != parentTab) {
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
  }
  gBrowser.hideTab(childB);
  await waitForTreeCondition(
    () => childB.hidden,
    "Waiting for the hidden child"
  );

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childA),
    "Waiting for the subtree to collapse"
  );

  gBrowser.moveTabToEnd(parentTab);
  await waitForTreeCondition(
    () => childA._tPos == parentTab._tPos + 1,
    "Waiting for the subtree to follow the moved parent"
  );

  is(getTreeParent(childA), parentTab, "First child stays attached");
  is(getTreeParent(childB), parentTab, "Hidden child stays attached");
  is(childA._tPos, parentTab._tPos + 1, "First child follows the parent");
  is(
    childB._tPos,
    parentTab._tPos + 2,
    "Hidden child is carried along behind the subtree"
  );
  ok(childB.hidden, "Hidden child stays hidden across the move");
  Assert.greater(
    parentTab._tPos,
    otherTab._tPos,
    "The whole subtree sits after the other tab"
  );

  gBrowser.showTab(childB);
  BrowserTestUtils.removeTab(childB);
  BrowserTestUtils.removeTab(childA);
  BrowserTestUtils.removeTab(parentTab, { isUserTriggered: true });
  BrowserTestUtils.removeTab(otherTab);
});

add_task(
  async function test_collapsed_external_move_carries_split_descendants() {
    await enableTreeTabs();
    const parent = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?move-split-parent"
    );
    const primary = await openTabWithTree(parent);
    const companion = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?move-split-companion"
    );
    const child = await openTabWithTree(primary);
    const other = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?move-split-other"
    );
    const wrapper = gBrowser.addTabSplitView([primary, companion], {
      insertBefore: primary,
    });

    try {
      await BrowserTestUtils.switchTab(gBrowser, parent);
      gBrowser.TreeTabsService.collapseSubtree(parent);
      await waitForTreeCondition(
        () => isTreeHidden(primary) && isTreeHidden(child),
        "Waiting for the split subtree to collapse"
      );
      gBrowser.moveTabToEnd(parent);
      await waitForTreeCondition(
        () => child._tPos == parent._tPos + 3,
        "Waiting for both split panes and their child to follow the moved parent"
      );
      Assert.deepEqual(
        Array.from(gBrowser.tabs).slice(parent._tPos),
        [parent, primary, companion, child],
        "The complete logical subtree moves in preorder without splitting the row"
      );
      is(primary.splitview, wrapper, "The primary retains its wrapper");
      is(companion.splitview, wrapper, "The companion retains its wrapper");
      is(getTreeParent(primary), parent, "The split owner retains its parent");
      is(getTreeParent(child), primary, "The split row retains its child");
      Assert.greater(
        parent._tPos,
        other._tPos,
        "The subtree moved after the other tab"
      );
    } finally {
      gBrowser.TreeTabsService.expandSubtree(parent);
      wrapper.unsplitTabs();
      for (const tab of [child, companion, primary, parent, other]) {
        if (tab.isConnected && !tab.closing) {
          await BrowserTestUtils.removeTab(tab);
        }
      }
    }
  }
);

add_task(async function test_close_tabs_to_left_promotes_survivors() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?close-left-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childA = await openTabWithTree(parentTab, "about:blank");
  const childB = await openTabWithTree(parentTab, "about:blank");
  // Closing to the start also takes the window's initial tab, so keep a
  // trailing tab alive or removing childB would close the window.
  const trailingTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?close-left-trailing"
  );

  await BrowserTestUtils.switchTab(gBrowser, childB);
  gBrowser.removeTabsToTheStartFrom(childB);
  await waitForTreeCondition(
    () => !gBrowser.tabs.includes(parentTab) && !gBrowser.tabs.includes(childA),
    "Waiting for tabs to the left to close"
  );

  ok(gBrowser.tabs.includes(childB), "The anchor tab survives");
  is(
    getTreeParent(childB),
    null,
    "The surviving child of closed ancestors ends up a root"
  );

  await BrowserTestUtils.switchTab(gBrowser, trailingTab);
  BrowserTestUtils.removeTab(childB);
});

add_task(async function test_owner_tab_wins_over_tree_successor() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?owner-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childA = await openTabWithTree(parentTab, "about:blank");

  if (gBrowser.selectedTab != parentTab) {
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
  }
  const ownedTab = gBrowser.addTrustedTab("about:blank?owner-owned", {
    ownerTab: parentTab,
  });
  gBrowser.TreeTabsService.attachTab(ownedTab, parentTab);
  await waitForTreeUpdate();
  await BrowserTestUtils.switchTab(gBrowser, ownedTab);

  BrowserTestUtils.removeTab(ownedTab);
  await waitForTreeCondition(
    () => !gBrowser.tabs.includes(ownedTab),
    "Waiting for the owned tab to close"
  );

  is(
    gBrowser.selectedTab,
    parentTab,
    "The owner tab wins over the tree successor (previous sibling)"
  );

  BrowserTestUtils.removeTab(childA);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(async function test_successor_of_pinned_tab_is_pinned() {
  await enableTreeTabs();
  const initialTab = gBrowser.selectedTab;
  const pinnedA = BrowserTestUtils.addTab(gBrowser, "about:blank?pinned-a");
  const pinnedB = BrowserTestUtils.addTab(gBrowser, "about:blank?pinned-b");
  gBrowser.pinTab(pinnedA);
  gBrowser.pinTab(pinnedB);
  const normalTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?pinned-normal"
  );

  // Full tab switches never report completion for pinned tabs in this
  // headless configuration, so set the selection directly; the successor
  // pick only depends on which tab is selected.
  gBrowser.selectedTab = normalTab;
  gBrowser.selectedTab = pinnedB;
  is(gBrowser.selectedTab, pinnedB, "Pinned tab is selected");

  BrowserTestUtils.removeTab(pinnedB);
  await waitForTreeCondition(
    () => !gBrowser.tabs.includes(pinnedB),
    "Waiting for the pinned tab to close"
  );

  is(
    gBrowser.selectedTab,
    pinnedA,
    "Closing a pinned tab hands off to another pinned tab"
  );

  gBrowser.selectedTab = initialTab;
  BrowserTestUtils.removeTab(pinnedA);
  BrowserTestUtils.removeTab(normalTab);
});

add_task(async function test_move_tree_to_new_window_preserves_topology() {
  await enableTreeTabs();

  const parentURL = "about:blank?waterfox-tree-new-window-parent";
  const childURL = "about:blank?waterfox-tree-new-window-child";
  const grandchildURL = "about:blank?waterfox-tree-new-window-grandchild";
  const parentTab = BrowserTestUtils.addTab(gBrowser, parentURL);
  const childTab = await openTabWithTree(parentTab, childURL);
  await openTabWithTree(childTab, grandchildURL);
  gBrowser.TreeTabsService.collapseSubtree(childTab);

  const delayedStartup = BrowserTestUtils.waitForNewWindow();
  const newWindow = gBrowser.replaceTabsWithWindow(parentTab);
  await delayedStartup;

  try {
    const findTab = url =>
      Array.from(newWindow.gBrowser.tabs).find(
        tab => tab.linkedBrowser.currentURI.spec == url
      );
    await waitForTreeCondition(() => {
      const movedParent = findTab(parentURL);
      const movedChild = findTab(childURL);
      const movedGrandchild = findTab(grandchildURL);
      return (
        movedParent &&
        movedChild &&
        movedGrandchild &&
        newWindow.gBrowser.TreeTabsService.getParent(movedChild) ==
          movedParent &&
        newWindow.gBrowser.TreeTabsService.getParent(movedGrandchild) ==
          movedChild &&
        newWindow.gBrowser.TreeTabsService.isCollapsed(movedChild)
      );
    }, "Waiting for the moved tree to be restored in the new window");

    const movedParent = findTab(parentURL);
    const movedChild = findTab(childURL);
    const movedGrandchild = findTab(grandchildURL);
    is(
      newWindow.gBrowser.TreeTabsService.getParent(movedChild),
      movedParent,
      "Moved child retains its parent"
    );
    is(
      newWindow.gBrowser.TreeTabsService.getParent(movedGrandchild),
      movedChild,
      "Moved grandchild retains its parent"
    );
    ok(
      newWindow.gBrowser.TreeTabsService.isCollapsed(movedChild),
      "Moved subtree retains its collapsed state"
    );
    ok(
      SessionStore.getCustomWindowValue(newWindow, "treeTabs:tree-structure"),
      "Moved tree is persisted immediately after delayed startup"
    );
  } finally {
    await BrowserTestUtils.closeWindow(newWindow);
  }
});
