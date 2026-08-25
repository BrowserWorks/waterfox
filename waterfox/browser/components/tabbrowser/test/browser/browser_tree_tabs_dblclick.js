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

add_task(async function test_disclosure_double_click_never_closes_a_tree() {
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.closeTabByDblclick", true]],
  });
  SidebarController._state.launcherExpanded = true;
  await waitForTreeCondition(
    () => gBrowser.tabContainer.hasAttribute("expanded"),
    "Waiting for expanded rows"
  );
  const parent = gBrowser.selectedTab;
  const child = await openTabWithTree(parent);
  const disclosure = parent.querySelector(".tab-tree-disclosure");
  try {
    for (const behavior of [0, 1, 2]) {
      Services.prefs.setIntPref(PREF_TREE_DOUBLE_CLICK_BEHAVIOR, behavior);
      const collapsed = gBrowser.TreeTabsService.isCollapsed(parent);
      EventUtils.synthesizeMouseAtCenter(disclosure, {
        clickCount: 1,
        button: 0,
      });
      EventUtils.synthesizeMouseAtCenter(disclosure, {
        clickCount: 2,
        button: 0,
      });
      ok(
        !parent.closing && !child.closing,
        "Neither native nor tree double-click closes the disclosure's tree"
      );
      is(
        gBrowser.TreeTabsService.isCollapsed(parent),
        collapsed,
        "Two disclosure clicks toggle twice, without a third double-click action"
      );
    }
  } finally {
    await SpecialPowers.popPrefEnv();
    await BrowserTestUtils.removeTab(child);
  }
});
