/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_collapse_and_expand() {
  await enableTreeTabs();

  const parentTab = gBrowser.selectedTab;
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-collapse-child"
  );
  const grandchildTab = await openTabWithTree(
    childTab,
    "https://example.com/?waterfox-tree-collapse-grandchild"
  );

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childTab) && isTreeHidden(grandchildTab),
    "Waiting for descendant tabs to become hidden"
  );

  ok(
    isTreeHidden(childTab),
    "Child is marked hidden while parent is collapsed"
  );
  ok(
    isTreeHidden(grandchildTab),
    "Grandchild is marked hidden while parent is collapsed"
  );
  is(
    window.getComputedStyle(childTab).display,
    "none",
    "Child is not visible in tab strip while collapsed"
  );
  is(
    window.getComputedStyle(grandchildTab).display,
    "none",
    "Grandchild is not visible in tab strip while collapsed"
  );

  gBrowser.TreeTabsService.expandSubtree(parentTab);
  await waitForTreeCondition(
    () => !isTreeHidden(childTab) && !isTreeHidden(grandchildTab),
    "Waiting for descendant tabs to become visible"
  );

  ok(!isTreeHidden(childTab), "Child is visible again after expand");
  ok(!isTreeHidden(grandchildTab), "Grandchild is visible again after expand");

  gBrowser.TreeTabsService.collapseSubtree(childTab);
  await waitForTreeCondition(
    () => isTreeHidden(grandchildTab),
    "Waiting for nested grandchild to become hidden"
  );
  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childTab) && isTreeHidden(grandchildTab),
    "Waiting for full subtree to become hidden"
  );

  gBrowser.TreeTabsService.expandSubtree(parentTab);
  await waitForTreeCondition(
    () => !isTreeHidden(childTab),
    "Waiting for collapsed child to become visible after expanding parent"
  );

  ok(!isTreeHidden(childTab), "Child is visible when parent is re-expanded");
  ok(
    isTreeHidden(grandchildTab),
    "Grandchild remains hidden because child stays collapsed"
  );

  BrowserTestUtils.removeTab(grandchildTab);
  BrowserTestUtils.removeTab(childTab);
});
