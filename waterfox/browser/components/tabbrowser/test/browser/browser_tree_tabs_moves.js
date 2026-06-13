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
