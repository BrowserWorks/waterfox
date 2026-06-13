/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_auto_collapse_on_select() {
  await enableTreeTabs();

  const rootA = gBrowser.selectedTab;
  info("Opening childA under rootA");
  const childA = await openTabWithTree(rootA, "about:blank");

  info("Opening rootB");
  const rootB = BrowserTestUtils.addTab(gBrowser, "about:blank", {
    relatedToCurrent: false,
  });
  info("Opening childB under rootB");
  const childB = await openTabWithTree(rootB, "about:blank");

  ok(
    !Services.prefs.getBoolPref(PREF_TREE_AUTO_COLLAPSE_ON_SELECT),
    "Automatic collapse is off without a user override"
  );
  await userSelectTab(childA);
  await userSelectTab(rootB);
  ok(
    !gBrowser.TreeTabsService.isCollapsed(rootA) &&
      !gBrowser.TreeTabsService.isCollapsed(rootB),
    "Selecting another branch leaves both branches expanded by default"
  );
  Services.prefs.setBoolPref(PREF_TREE_AUTO_COLLAPSE_ON_SELECT, true);

  gBrowser.TreeTabsService.expandSubtree(rootA);
  gBrowser.TreeTabsService.expandSubtree(rootB);

  info("Selecting tree A child tab");
  await userSelectTab(childA);

  await waitForTreeCondition(
    () =>
      !gBrowser.TreeTabsService.isCollapsed(rootA) &&
      gBrowser.TreeTabsService.isCollapsed(rootB),
    "Waiting for selecting tree A to collapse tree B"
  );

  ok(
    gBrowser.TreeTabsService.isCollapsed(rootB),
    "Selecting a tab in tree A collapses tree B"
  );

  info("Selecting tree B root tab");
  await userSelectTab(rootB);
  await waitForTreeCondition(
    () =>
      gBrowser.TreeTabsService.isCollapsed(rootA) &&
      !gBrowser.TreeTabsService.isCollapsed(rootB),
    "Waiting for selecting tree B to collapse tree A"
  );

  ok(
    gBrowser.TreeTabsService.isCollapsed(rootA),
    "Selecting a tab in tree B collapses tree A"
  );
  ok(
    !gBrowser.TreeTabsService.isCollapsed(rootB),
    "Selected tree B is expanded"
  );

  Services.prefs.setBoolPref(PREF_TREE_AUTO_COLLAPSE_ON_SELECT, false);
  gBrowser.TreeTabsService.expandSubtree(rootA);
  gBrowser.TreeTabsService.expandSubtree(rootB);

  await selectTabByClick(rootA);
  await selectTabByClick(rootB);
  await waitForTreeUpdate();

  ok(
    !gBrowser.TreeTabsService.isCollapsed(rootA),
    "Tree A remains expanded when auto-collapse-on-select is disabled"
  );
  ok(
    !gBrowser.TreeTabsService.isCollapsed(rootB),
    "Tree B remains expanded when auto-collapse-on-select is disabled"
  );

  BrowserTestUtils.removeTab(childA);
  BrowserTestUtils.removeTab(childB);
  BrowserTestUtils.removeTab(rootB);
});
