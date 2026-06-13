/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_hidden_tab_detaches_and_reattaches() {
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

  is(getTreeParent(childTab), null, "Hidden child is detached from tree");
  is(
    getTreeParent(grandchildTab),
    childTab,
    "Grandchild stays under detached child"
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
    "Shown child reattaches to original parent"
  );
  is(
    getTreeParent(grandchildTab),
    childTab,
    "Grandchild still under child after reattach"
  );

  BrowserTestUtils.removeTab(grandchildTab);
  BrowserTestUtils.removeTab(childTab);
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

  gBrowser.showTab(childTab);
  await waitForTreeCondition(
    () => !childTab.hidden,
    "Waiting for tab to become visible"
  );
  await waitForTreeUpdate();

  is(
    getTreeParent(childTab),
    null,
    "Shown child stays as root when saved parent is gone"
  );

  BrowserTestUtils.removeTab(childTab);
});
