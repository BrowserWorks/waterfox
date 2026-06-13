/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_session_store_save_and_manual_restore() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?restore-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-restore-child"
  );

  // Force a save; do not rely on debounce timing.
  const { TreeTabsStore } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsStore.sys.mjs"
  );
  TreeTabsStore.clearRestoreGuard(window);
  TreeTabsStore.saveWindowStructure(window);
  const rawStructure = SessionStore.getCustomWindowValue(
    window,
    "treeTabs:tree-structure"
  );
  ok(rawStructure, "treeTabs:tree-structure is persisted after explicit save");

  const structure = JSON.parse(rawStructure);
  const tabOrder = Array.from(gBrowser.tabs);
  const parentIndex = tabOrder.indexOf(parentTab);
  const childIndex = tabOrder.indexOf(childTab);
  is(
    structure[childIndex].parent,
    parentIndex,
    "Persisted structure has correct parent index"
  );

  // Now test restore: detach the child, then restore from saved data
  gBrowser.TreeTabsService.detachTab(childTab);
  await waitForTreeUpdate();
  await waitForTreeCondition(
    () => getTreeParent(childTab) == null,
    "Waiting for child detach"
  );

  // Re-write the saved structure because detach may have overwritten it.
  SessionStore.setCustomWindowValue(
    window,
    "treeTabs:tree-structure",
    rawStructure
  );
  TreeTabsStore._manualRestoreCompleted.delete(window);
  TreeTabsStore.clearRestoreGuard(window);

  const restored = TreeTabsStore.tryManualRestore(window);
  ok(restored, "tryManualRestore succeeds");
  is(getTreeParent(childTab), parentTab, "Restore re-attaches child to parent");

  BrowserTestUtils.removeTab(childTab);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(async function test_undo_close_restores_tree_position() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "https://example.com/?undo-parent"
  );
  await BrowserTestUtils.browserLoaded(parentTab.linkedBrowser);
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?undo-child"
  );

  const { TreeTabsStore } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsStore.sys.mjs"
  );
  TreeTabsStore.clearRestoreGuard(window);
  TreeTabsStore.saveTabState(childTab);
  ok(
    SessionStore.getCustomTabValue(childTab, "treeTabs:ancestors"),
    "Child tab ancestors are saved before close"
  );

  const closedTabCount = SessionStore.getClosedTabCountForWindow(window);
  BrowserTestUtils.removeTab(childTab);
  await waitForTreeCondition(
    () => SessionStore.getClosedTabCountForWindow(window) > closedTabCount,
    "Waiting for closed tab to be recorded"
  );

  const restoredTab = SessionStore.undoCloseTab(window, 0);
  await BrowserTestUtils.browserLoaded(restoredTab.linkedBrowser);
  await waitForTreeUpdate();
  await waitForTreeCondition(
    () => getTreeParent(restoredTab) === parentTab,
    "Waiting for restored tab to reattach to parent"
  );

  is(
    getTreeParent(restoredTab),
    parentTab,
    "Undo-closed tab restores tree parent"
  );
  is(getTreeLevel(restoredTab), 1, "Undo-closed tab restores at correct level");

  BrowserTestUtils.removeTab(restoredTab);
  BrowserTestUtils.removeTab(parentTab);
});
