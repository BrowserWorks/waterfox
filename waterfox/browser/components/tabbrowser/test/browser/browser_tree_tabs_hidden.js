/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_hidden_tab_keeps_tree_links() {
  await enableTreeTabs();

  const parentTab = gBrowser.selectedTab;
  const childTab = await openTabWithTree(parentTab, "about:blank");
  const grandchildTab = await openTabWithTree(childTab, "about:blank");

  is(getTreeParent(childTab), parentTab, "Child is under parent before hide");
  is(
    getTreeParent(grandchildTab),
    childTab,
    "Grandchild is under child before hide"
  );

  // Hidden tabs cannot be selected.
  if (gBrowser.selectedTab != parentTab) {
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
  }
  gBrowser.hideTab(childTab);
  await waitForTreeCondition(
    () => childTab.hidden,
    "Waiting for tab to become hidden"
  );
  await waitForTreeUpdate();

  is(getTreeParent(childTab), parentTab, "Hidden child keeps its tree parent");
  is(
    getTreeParent(grandchildTab),
    childTab,
    "Grandchild stays under hidden child"
  );

  gBrowser.showTab(childTab);
  await waitForTreeCondition(
    () => !childTab.hidden,
    "Waiting for tab to become visible"
  );
  await waitForTreeUpdate();

  is(
    getTreeParent(childTab),
    parentTab,
    "Shown child is still under its parent"
  );
  is(
    getTreeParent(grandchildTab),
    childTab,
    "Grandchild still under child after show"
  );

  BrowserTestUtils.removeTab(grandchildTab);
  BrowserTestUtils.removeTab(childTab);
});

add_task(async function test_new_child_placed_before_trailing_hidden_tab() {
  await enableTreeTabs();

  const parentTab = gBrowser.selectedTab;
  const visibleChild = await openTabWithTree(parentTab, "about:blank");
  const hiddenChild = await openTabWithTree(parentTab, "about:blank");

  if (gBrowser.selectedTab != parentTab) {
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
  }
  gBrowser.hideTab(hiddenChild);
  await waitForTreeCondition(
    () => hiddenChild.hidden,
    "Waiting for tab to become hidden"
  );
  await waitForTreeUpdate();

  const anchor = gBrowser.TreeTabsService.getSubtreeEndAnchor(parentTab);
  is(
    anchor,
    visibleChild,
    "Subtree anchor skips the trailing hidden child, so new tabs land before it"
  );

  gBrowser.showTab(hiddenChild);
  BrowserTestUtils.removeTab(hiddenChild);
  BrowserTestUtils.removeTab(visibleChild);
});

add_task(async function test_hidden_tab_parent_closed_while_hidden() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?hidden-parent"
  );
  if (gBrowser.selectedTab != parentTab) {
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
  }
  const childTab = await openTabWithTree(parentTab, "about:blank");

  // Hidden tabs cannot be selected.
  if (gBrowser.selectedTab != parentTab) {
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
  }
  gBrowser.hideTab(childTab);
  await waitForTreeCondition(
    () => childTab.hidden,
    "Waiting for tab to become hidden"
  );
  await waitForTreeUpdate();

  BrowserTestUtils.removeTab(parentTab);
  await waitForTreeCondition(
    () => !gBrowser.tabs.includes(parentTab),
    "Waiting for parent to close"
  );
  await waitForTreeUpdate();

  is(
    getTreeParent(childTab),
    null,
    "Only child is promoted to root when its parent closes"
  );

  gBrowser.showTab(childTab);
  await waitForTreeCondition(
    () => !childTab.hidden,
    "Waiting for tab to become visible"
  );
  await waitForTreeUpdate();

  is(getTreeParent(childTab), null, "Shown child stays a root");

  BrowserTestUtils.removeTab(childTab);
});
