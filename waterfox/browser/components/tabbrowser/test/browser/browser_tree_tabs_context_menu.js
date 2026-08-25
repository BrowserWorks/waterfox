/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_context_menu_commands() {
  await enableTreeTabs();

  const parentTab = gBrowser.selectedTab;
  const childOne = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-context-child-1"
  );
  const childTwo = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-context-child-2"
  );

  let menu = await openTabContextMenu(parentTab);
  const separator = document.getElementById("context_treeTabCommandsSeparator");
  const collapseItem = document.getElementById("context_collapseTree");
  const expandItem = document.getElementById("context_expandTree");
  const closeTreeItem = document.getElementById("context_closeTree");
  const closeDescendantsItem = document.getElementById(
    "context_closeDescendants"
  );

  ok(separator, "Tree context separator exists");
  ok(collapseItem, "Collapse tree menu item exists");
  ok(expandItem, "Expand tree menu item exists");
  ok(closeTreeItem, "Close tree menu item exists");
  ok(closeDescendantsItem, "Close descendants menu item exists");

  ok(!collapseItem.hidden, "Collapse This Tree is visible when expanded");
  ok(expandItem.hidden, "Expand This Tree is hidden while expanded");

  let hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(collapseItem);
  await hidden;

  await waitForTreeCondition(
    () => gBrowser.TreeTabsService.isCollapsed(parentTab),
    "Waiting for collapse command to apply"
  );
  ok(
    gBrowser.TreeTabsService.isCollapsed(parentTab),
    "Collapse command collapses tree"
  );

  menu = await openTabContextMenu(parentTab);
  ok(
    collapseItem.hidden,
    "Collapse This Tree is hidden when already collapsed"
  );
  ok(!expandItem.hidden, "Expand This Tree is visible when collapsed");

  hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(closeDescendantsItem);
  await hidden;

  await waitForTreeCondition(
    () =>
      !gBrowser.tabs.includes(childOne) && !gBrowser.tabs.includes(childTwo),
    "Waiting for descendants to close"
  );

  ok(
    gBrowser.tabs.includes(parentTab),
    "Parent tab remains after Close Descendants"
  );
  is(
    gBrowser.TreeTabsService.getChildren(parentTab).length,
    0,
    "Parent no longer has descendants"
  );

  await disableTreeTabs();
  menu = await openTabContextMenu(parentTab);

  ok(separator.hidden, "Tree menu separator hidden when feature is disabled");
  ok(collapseItem.hidden, "Collapse menu item hidden when feature is disabled");
  ok(expandItem.hidden, "Expand menu item hidden when feature is disabled");
  ok(
    closeTreeItem.hidden,
    "Close tree menu item hidden when feature is disabled"
  );
  ok(
    closeDescendantsItem.hidden,
    "Close descendants menu item hidden when feature is disabled"
  );

  await closeTabContextMenu();
});

add_task(async function test_tree_tabs_context_menu_copy_links() {
  await enableTreeTabs();

  const parentURL = "https://example.com/?waterfox-tree-context-copy-parent";
  const childOneURL = "https://example.com/?waterfox-tree-context-copy-child-1";
  const grandchildURL =
    "https://example.com/?waterfox-tree-context-copy-grandchild";
  const childTwoURL = "https://example.com/?waterfox-tree-context-copy-child-2";
  const parentTab = BrowserTestUtils.addTab(gBrowser, parentURL);
  await BrowserTestUtils.browserLoaded(
    parentTab.linkedBrowser,
    false,
    parentURL
  );
  const childOne = await openTabWithTree(parentTab, childOneURL);
  const grandchild = await openTabWithTree(childOne, grandchildURL);
  const childTwo = await openTabWithTree(parentTab, childTwoURL);

  let menu = await openTabContextMenu(parentTab);
  const copyTreeItem = document.getElementById("context_copyTreeLinks");
  const copyDescendantsItem = document.getElementById(
    "context_copyDescendantsLinks"
  );

  ok(copyTreeItem, "Copy Tree menu item exists");
  ok(copyDescendantsItem, "Copy Descendants menu item exists");
  ok(!copyTreeItem.hidden, "Copy Tree is visible for a tree");
  ok(!copyDescendantsItem.hidden, "Copy Descendants is visible for a tree");

  let hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(copyTreeItem);
  await hidden;

  is(
    SpecialPowers.getClipboardData("text/plain"),
    [
      `* ${parentURL}`,
      `  * ${childOneURL}`,
      `    * ${grandchildURL}`,
      `  * ${childTwoURL}`,
    ].join("\n"),
    "Copy Tree writes the exact recursive plain-text tree"
  );

  menu = await openTabContextMenu(parentTab);
  hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(copyDescendantsItem);
  await hidden;

  const copiedDescendants = SpecialPowers.getClipboardData("text/plain");
  is(
    copiedDescendants,
    [`* ${childOneURL}`, `  * ${grandchildURL}`, `* ${childTwoURL}`].join("\n"),
    "Copy Descendants writes the exact recursive descendants"
  );
  ok(
    !copiedDescendants.includes(parentURL),
    "Copy Descendants omits the parent"
  );

  await closeTabContextMenu();
  BrowserTestUtils.removeTab(childTwo);
  BrowserTestUtils.removeTab(grandchild);
  BrowserTestUtils.removeTab(childOne);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(async function test_recursive_and_native_tree_context_actions() {
  await enableTreeTabs();

  const rootTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-context-actions-root"
  );
  const childTab = await openTabWithTree(
    rootTab,
    "about:blank?waterfox-tree-context-actions-child"
  );
  const grandchildTab = await openTabWithTree(
    childTab,
    "about:blank?waterfox-tree-context-actions-grandchild"
  );
  const collapseRecursive = document.getElementById(
    "context_collapseTreeRecursively"
  );
  const expandRecursive = document.getElementById(
    "context_expandTreeRecursively"
  );
  const unloadTree = document.getElementById("context_unloadTree");

  let menu = await openTabContextMenu(rootTab);
  let hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(collapseRecursive);
  await hidden;
  await waitForTreeCondition(
    () =>
      gBrowser.TreeTabsService.isCollapsed(rootTab) &&
      gBrowser.TreeTabsService.isCollapsed(childTab),
    "Waiting for recursive collapse"
  );
  ok(
    gBrowser.TreeTabsService.isCollapsed(childTab),
    "Recursive collapse folds nested branches"
  );

  menu = await openTabContextMenu(rootTab);
  hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(expandRecursive);
  await hidden;
  await waitForTreeCondition(
    () =>
      !gBrowser.TreeTabsService.isCollapsed(rootTab) &&
      !gBrowser.TreeTabsService.isCollapsed(childTab),
    "Waiting for recursive expansion"
  );

  const originalExplicitUnloadTabs = gBrowser.explicitUnloadTabs;
  let unloadedTabs = null;
  gBrowser.explicitUnloadTabs = tabs => {
    unloadedTabs = tabs;
    return Promise.resolve();
  };
  try {
    menu = await openTabContextMenu(rootTab);
    hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
    menu.activateItem(unloadTree);
    await hidden;
    Assert.deepEqual(
      unloadedTabs,
      [rootTab, childTab, grandchildTab],
      "Unload Tree delegates the complete tree to Firefox's explicit unload path"
    );
  } finally {
    gBrowser.explicitUnloadTabs = originalExplicitUnloadTabs;
  }

  BrowserTestUtils.removeTab(grandchildTab);
  BrowserTestUtils.removeTab(childTab);
  BrowserTestUtils.removeTab(rootTab);
});
