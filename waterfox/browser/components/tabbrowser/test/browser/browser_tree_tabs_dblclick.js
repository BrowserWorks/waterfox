/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_double_click_behavior() {
  await enableTreeTabs();

  const parentTab = gBrowser.selectedTab;
  await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-dblclick-child"
  );

  Services.prefs.setIntPref(PREF_TREE_DOUBLE_CLICK_BEHAVIOR, 0);

  await doubleClickTab(parentTab);
  await waitForTreeCondition(
    () => gBrowser.TreeTabsService.isCollapsed(parentTab),
    "Waiting for collapse after double-click"
  );
  ok(
    gBrowser.TreeTabsService.isCollapsed(parentTab),
    "Double-click collapses subtree when behavior=0"
  );

  await doubleClickTab(parentTab);
  await waitForTreeCondition(
    () => !gBrowser.TreeTabsService.isCollapsed(parentTab),
    "Waiting for expand after second double-click"
  );
  ok(
    !gBrowser.TreeTabsService.isCollapsed(parentTab),
    "Second double-click expands subtree when behavior=0"
  );

  Services.prefs.setIntPref(PREF_TREE_DOUBLE_CLICK_BEHAVIOR, 2);
  const collapsedBefore = gBrowser.TreeTabsService.isCollapsed(parentTab);

  await doubleClickTab(parentTab);
  is(
    gBrowser.TreeTabsService.isCollapsed(parentTab),
    collapsedBefore,
    "Double-click does not change collapse state when behavior=2"
  );
});
