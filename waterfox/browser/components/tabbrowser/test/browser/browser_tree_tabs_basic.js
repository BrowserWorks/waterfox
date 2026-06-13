/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_basic_formation() {
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_CLOSE_PARENT_BEHAVIOR, 1);

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-basic-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  info("Opening child tab from current parent");
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-basic-child"
  );

  info("Waiting for child tree level to settle");
  await waitForTreeCondition(
    () => getTreeLevel(childTab) == 1,
    "Waiting for child tree level attribute"
  );

  is(getTreeLevel(childTab), 1, "Child tab is rendered at level 1");
  is(
    childTab.getAttribute("data-tree-parent"),
    parentTab.linkedPanel,
    "Child tab has data-tree-parent set"
  );
  ok(hasTreeChildren(parentTab), "Parent tab has data-tree-has-children");
  is(
    getTreeParent(childTab),
    parentTab,
    "Service resolves parent for child tab"
  );
  ok(
    gBrowser.TreeTabsService.getChildren(parentTab).includes(childTab),
    "Service resolves child for parent tab"
  );

  info("Opening a new tab via Ctrl+T");
  const initialTabCount = gBrowser.tabs.length;
  EventUtils.synthesizeKey("t", { accelKey: true });
  await waitForTreeCondition(
    () => gBrowser.tabs.length == initialTabCount + 1,
    "Waiting for Ctrl+T to open a new tab"
  );
  const newRootTab = gBrowser.tabs[gBrowser.tabs.length - 1];

  is(getTreeLevel(newRootTab), 0, "Ctrl+T tab is a root tab");
  is(getTreeParent(newRootTab), null, "Ctrl+T tab has no tree parent");

  info("Closing parent tab and waiting for promotion");
  BrowserTestUtils.removeTab(parentTab);
  await waitForTreeCondition(
    () => !gBrowser.tabs.includes(parentTab),
    "Waiting for parent tab to close"
  );

  await waitForTreeUpdate();
  await waitForTreeCondition(
    () => getTreeParent(childTab) == null,
    "Waiting for child to be promoted after parent close"
  );

  is(
    getTreeLevel(childTab),
    0,
    "Child is promoted to tree root after parent close"
  );

  BrowserTestUtils.removeTab(newRootTab);
  BrowserTestUtils.removeTab(childTab);
});

add_task(async function test_auto_attach_from_link_click() {
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_AUTO_ATTACH, 1);

  const parentTab = BrowserTestUtils.addTab(gBrowser, "https://example.com/");
  await BrowserTestUtils.browserLoaded(parentTab.linkedBrowser);
  await BrowserTestUtils.switchTab(gBrowser, parentTab);

  const childTab = await openLinkInNewTab(
    parentTab,
    "https://example.com/?child-from-link"
  );

  await waitForTreeCondition(
    () => getTreeParent(childTab) === parentTab,
    "Waiting for auto-attach to fire from link click"
  );

  is(
    getTreeParent(childTab),
    parentTab,
    "Link-opened tab is auto-attached as child of opener"
  );
  is(getTreeLevel(childTab), 1, "Link-opened tab is at level 1");

  BrowserTestUtils.removeTab(childTab);
  BrowserTestUtils.removeTab(parentTab);
});
