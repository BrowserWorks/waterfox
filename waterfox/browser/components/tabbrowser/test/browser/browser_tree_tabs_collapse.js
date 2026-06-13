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

add_task(async function test_closing_collapsed_parent_closes_subtree() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?collapsed-close-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childTab = await openTabWithTree(parentTab, "about:blank");
  const grandchildTab = await openTabWithTree(childTab, "about:blank");
  const otherTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?collapsed-close-other"
  );

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childTab),
    "Waiting for the subtree to collapse"
  );

  BrowserTestUtils.removeTab(parentTab, { isUserTriggered: true });
  await waitForTreeCondition(
    () =>
      !gBrowser.tabs.includes(childTab) &&
      !gBrowser.tabs.includes(grandchildTab),
    "Waiting for the collapsed subtree to close with its parent"
  );

  ok(
    !gBrowser.tabs.includes(childTab),
    "Child closed together with its collapsed parent"
  );
  ok(
    !gBrowser.tabs.includes(grandchildTab),
    "Grandchild closed together with its collapsed parent"
  );
  ok(gBrowser.tabs.includes(otherTab), "Unrelated tab stays open");

  BrowserTestUtils.removeTab(otherTab);
});

add_task(async function test_programmatic_close_of_collapsed_parent_promotes() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?programmatic-close-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childA = await openTabWithTree(parentTab, "about:blank");
  const childB = await openTabWithTree(parentTab, "about:blank");

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childA),
    "Waiting for the subtree to collapse"
  );

  // No isUserTriggered: this is how an extension's tabs.remove arrives.
  BrowserTestUtils.removeTab(parentTab);
  await waitForTreeCondition(
    () => !gBrowser.tabs.includes(parentTab),
    "Waiting for the parent to close"
  );

  ok(gBrowser.tabs.includes(childA), "First child survives programmatic close");
  ok(
    gBrowser.tabs.includes(childB),
    "Second child survives programmatic close"
  );
  is(getTreeParent(childA), null, "First child is promoted");
  is(getTreeParent(childB), childA, "Second child moves under the first");

  BrowserTestUtils.removeTab(childB);
  BrowserTestUtils.removeTab(childA);
});
