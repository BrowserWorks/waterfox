/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_keyboard_navigation() {
  await enableTreeTabs();
  Services.prefs.setBoolPref("browser.ctrlTab.sortByRecentlyUsed", false);

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-keyboard-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-keyboard-child"
  );
  const grandchildTab = await openTabWithTree(
    childTab,
    "https://example.com/?waterfox-tree-keyboard-grandchild"
  );
  const otherRootTab = BrowserTestUtils.addTab(gBrowser, "about:blank");

  function focusTreeTabs() {
    Services.focus.setFocus(gBrowser.tabContainer, Services.focus.FLAG_BYKEY);
    gBrowser.selectedTab.focus();
  }

  function dispatchTreeArrowKey(key) {
    gBrowser.tabContainer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      })
    );
  }

  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  focusTreeTabs();
  dispatchTreeArrowKey("ArrowLeft");
  await waitForTreeCondition(
    () => gBrowser.TreeTabsService.isCollapsed(parentTab),
    "Waiting for ArrowLeft to collapse parent"
  );
  ok(
    gBrowser.TreeTabsService.isCollapsed(parentTab),
    "ArrowLeft collapses expanded tree parent"
  );

  focusTreeTabs();
  dispatchTreeArrowKey("ArrowRight");
  await waitForTreeCondition(
    () => !gBrowser.TreeTabsService.isCollapsed(parentTab),
    "Waiting for ArrowRight to expand parent"
  );
  ok(
    !gBrowser.TreeTabsService.isCollapsed(parentTab),
    "ArrowRight expands collapsed tree parent"
  );

  gBrowser.TreeTabsService.collapseSubtree(childTab);
  await waitForTreeCondition(
    () => gBrowser.TreeTabsService.isCollapsed(childTab),
    "Waiting for child subtree collapse"
  );

  await BrowserTestUtils.switchTab(gBrowser, childTab);
  focusTreeTabs();
  dispatchTreeArrowKey("ArrowLeft");
  await waitForTreeCondition(
    () => gBrowser.selectedTab == parentTab,
    "Waiting for ArrowLeft to move focus to parent"
  );
  is(
    gBrowser.selectedTab,
    parentTab,
    "ArrowLeft on collapsed child selects parent"
  );

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () =>
      gBrowser.TreeTabsService.isCollapsed(parentTab) && isTreeHidden(childTab),
    "Waiting for parent subtree collapse before ArrowRight setup"
  );
  gBrowser.TreeTabsService.expandSubtree(parentTab);
  await waitForTreeCondition(
    () =>
      !gBrowser.TreeTabsService.isCollapsed(parentTab) &&
      !isTreeHidden(childTab),
    "Waiting for parent subtree expansion before ArrowRight"
  );

  if (gBrowser.selectedTab != parentTab) {
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
  }
  focusTreeTabs();
  dispatchTreeArrowKey("ArrowRight");
  await waitForTreeCondition(
    () => gBrowser.selectedTab == childTab,
    "Waiting for ArrowRight to move focus to first child"
  );
  is(
    gBrowser.selectedTab,
    childTab,
    "ArrowRight on expanded parent selects first child"
  );

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childTab) && isTreeHidden(grandchildTab),
    "Waiting for descendants to be hidden for Ctrl+Tab test"
  );
  ok(
    !gBrowser.tabContainer._canAdvanceToTab(childTab),
    "Hidden child is skipped by tab advance filter"
  );
  ok(
    !gBrowser.tabContainer._canAdvanceToTab(grandchildTab),
    "Hidden grandchild is skipped by tab advance filter"
  );

  BrowserTestUtils.removeTab(otherRootTab);
});
