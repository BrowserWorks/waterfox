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
