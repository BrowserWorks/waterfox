/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_horizontal_duplicate_and_undo_restore() {
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [[PREF_TREE_AUTO_COLLAPSE_ON_SELECT, false]],
  });
  const { TreeTabsStore } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsStore.sys.mjs"
  );
  const initialTabs = new Set(gBrowser.tabs);
  try {
    const parent = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank#horizontal-duplicate-parent"
    );
    const child = await openTabWithTree(
      parent,
      "about:blank#horizontal-duplicate-child"
    );
    TreeTabsStore.saveWindowStructure(window);
    TreeTabsStore.saveTabState(child);
    const childGuid = TreeTabsStore.getTabGuid(child);
    ok(childGuid, "The source has a saved persistent identity");

    Services.prefs.setBoolPref(PREF_VERTICAL_TABS, false);
    await waitForTreeCondition(
      () => !gBrowser.tabContainer.verticalMode,
      "Waiting for horizontal mode before duplication"
    );
    const duplicate = gBrowser.duplicateTab(child, true, {
      inBackground: true,
    });
    const duplicated = BrowserTestUtils.waitForEvent(
      duplicate,
      "SSTabRestored"
    );
    is(
      getTreeParent(duplicate),
      null,
      "The synchronous opening hook leaves a root"
    );
    await duplicated;
    is(
      getTreeParent(duplicate),
      null,
      "SessionStore's copied extData cannot reattach a horizontal duplicate"
    );
    isnot(
      TreeTabsStore.getTabGuid(duplicate),
      childGuid,
      "The copy gets a new ID"
    );
    Assert.deepEqual(
      JSON.parse(
        SessionStore.getCustomTabValue(duplicate, "treeTabs:ancestors")
      ),
      [],
      "The duplicate is persistently recorded without copied ancestors"
    );
    Assert.deepEqual(
      JSON.parse(
        SessionStore.getCustomTabValue(duplicate, "treeTabs:children")
      ),
      [],
      "The duplicate cannot reclaim the source's children"
    );
    is(getTreeParent(child), parent, "The source tree is retained");

    const closedCount = SessionStore.getClosedTabCountForWindow(window);
    await BrowserTestUtils.removeTab(child);
    await waitForTreeCondition(
      () => SessionStore.getClosedTabCountForWindow(window) > closedCount,
      "Waiting for the original child to be recorded as closed"
    );
    const restored = SessionStore.undoCloseTab(window, 0);
    await BrowserTestUtils.waitForEvent(restored, "SSTabRestored");
    is(
      getTreeParent(restored),
      parent,
      "A genuine horizontal undo-close still restores the saved parent"
    );
    is(
      TreeTabsStore.getTabGuid(restored),
      childGuid,
      "Undo retains the original ID"
    );
    is(
      getTreeParent(duplicate),
      null,
      "Undo does not change the independent copy"
    );
  } finally {
    await ensureVerticalTabs();
    for (const tab of [...gBrowser.tabs].reverse()) {
      if (!initialTabs.has(tab) && !tab.closing) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_vertical_mode_reveals_the_selected_descendant() {
  await enableTreeTabs();
  const parent = gBrowser.selectedTab;
  const child = await openTabWithTree(parent, "about:blank");
  try {
    gBrowser.TreeTabsService.collapseSubtree(parent);
    Services.prefs.setBoolPref(PREF_VERTICAL_TABS, false);
    await waitForTreeCondition(
      () => !gBrowser.tabContainer.verticalMode,
      "Waiting for horizontal tabs"
    );
    await BrowserTestUtils.switchTab(gBrowser, child);
    ok(
      gBrowser.TreeTabsService.isCollapsed(parent),
      "Horizontal selection preserves the saved collapse state"
    );
    await ensureVerticalTabs();
    await waitForTreeCondition(
      () => !isTreeHidden(child),
      "Returning to vertical tabs reveals the selected child"
    );
    is(
      gBrowser.selectedTab,
      child,
      "Returning to vertical tabs keeps selection"
    );
    ok(BrowserTestUtils.isVisible(child), "The active child has a visible row");
    is(getTreeParent(child), parent, "The existing relationship is retained");
  } finally {
    await ensureVerticalTabs();
    await BrowserTestUtils.removeTab(child);
  }
});

add_task(async function test_horizontal_mode_suspends_automatic_tree_groups() {
  await enableTreeTabs();
  Services.prefs.setBoolPref(PREF_TREE_AUTO_COLLAPSE_ON_SELECT, false);
  Services.prefs.setIntPref(PREF_TREE_CLOSE_PARENT_BEHAVIOR, 4);
  const { TreeTabsGroups } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsGroups.sys.mjs"
  );
  const { TreeTabsStore } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsStore.sys.mjs"
  );
  const initialTabs = new Set(gBrowser.tabs);
  try {
    const parent = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank#horizontal-parent"
    );
    const first = await openTabWithTree(parent, "about:blank#horizontal-first");
    const second = await openTabWithTree(
      parent,
      "about:blank#horizontal-second"
    );
    const grandchild = await openTabWithTree(
      first,
      "about:blank#horizontal-grandchild"
    );
    const pinned = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank#horizontal-pinned"
    );
    gBrowser.pinTab(pinned);
    await BrowserTestUtils.switchTab(gBrowser, pinned);
    gBrowser.TreeTabsService.collapseSubtree(parent);
    TreeTabsStore.saveWindowStructure(window);

    Services.prefs.setBoolPref(PREF_VERTICAL_TABS, false);
    await waitForTreeCondition(
      () => !gBrowser.tabContainer.verticalMode,
      "Waiting for horizontal mode"
    );
    ok(
      Services.prefs.getBoolPref(PREF_TREE_ENABLED),
      "The tree preference is retained"
    );
    ok(
      !gBrowser.TreeTabsService.isActive(window),
      "Automatic tree behavior is inactive"
    );
    is(
      getTreeParent(first),
      parent,
      "Switching mode keeps saved relationships"
    );
    ok(
      gBrowser.TreeTabsService.isCollapsed(parent),
      "Switching mode keeps saved collapse"
    );

    await BrowserTestUtils.switchTab(gBrowser, second);
    ok(
      gBrowser.TreeTabsService.isCollapsed(parent),
      "Selecting a horizontal child does not expand the saved invisible tree"
    );
    await BrowserTestUtils.switchTab(gBrowser, pinned);

    for (const openerTab of [parent, pinned, pinned]) {
      const tab = gBrowser.addTrustedTab("about:blank#horizontal-opened", {
        openerTab,
      });
      is(
        getTreeParent(tab),
        null,
        "New horizontal tabs do not acquire invisible parents"
      );
    }
    await BrowserTestUtils.removeTab(parent, { isUserTriggered: true });
    await waitForTreeUpdate();
    ok(
      gBrowser.tabs.includes(first) && gBrowser.tabs.includes(second),
      "Closing a collapsed horizontal parent keeps its children open"
    );
    is(
      getTreeParent(first),
      null,
      "First child is promoted without a replacement group"
    );
    is(getTreeParent(second), null, "Second child stays independent");
    is(
      getTreeParent(grandchild),
      first,
      "The remaining saved subtree survives"
    );
    ok(
      gBrowser.tabs
        .filter(tab => !initialTabs.has(tab))
        .every(tab => !TreeTabsGroups.isGroupTab(tab)),
      "No empty group pages are created in horizontal mode"
    );

    await ensureVerticalTabs();
    is(
      getTreeParent(grandchild),
      first,
      "Returning to vertical mode retains the remaining tree"
    );
    await waitForTreeCondition(
      () => hasTreeChildren(first),
      "The remaining parent exposes its tree controls again"
    );

    Services.prefs.setBoolPref(PREF_VERTICAL_TABS, false);
    await waitForTreeCondition(
      () => !gBrowser.tabContainer.verticalMode,
      "Waiting for horizontal mode before pinning a parent"
    );
    const tabCount = gBrowser.tabs.length;
    gBrowser.pinTab(first);
    is(
      gBrowser.tabs.length,
      tabCount,
      "Horizontal pinning does not create a group page"
    );
    is(
      getTreeParent(grandchild),
      null,
      "Horizontal pinning promotes children instead of leaving a pinned parent"
    );
  } finally {
    await ensureVerticalTabs();
    for (const tab of [...gBrowser.tabs].reverse()) {
      if (!initialTabs.has(tab) && !tab.closing) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
  }
});
