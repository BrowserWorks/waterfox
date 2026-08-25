/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { clearTimeout } = ChromeUtils.importESModule(
  "resource://gre/modules/Timer.sys.mjs"
);
const { TreeTabsMigration } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsMigration.sys.mjs"
);
const { TreeTabsService } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsService.sys.mjs"
);
const { TreeTabsStore } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsStore.sys.mjs"
);

const LEGACY_PREFIX = "extension:sidebar@waterfox.net:";
const NATIVE_PREFIX = "treeTabs:";

function createMockSessionStore() {
  const tabValues = new Map();
  const windowValues = new Map();
  const writes = { tab: [], window: [] };

  return {
    getCustomTabValue(tab, key) {
      return tabValues.get(tab)?.get(key) || "";
    },
    setCustomTabValue(tab, key, value) {
      if (!tabValues.has(tab)) {
        tabValues.set(tab, new Map());
      }
      tabValues.get(tab).set(key, value);
      writes.tab.push({ tab, key, value });
    },
    deleteCustomTabValue(tab, key) {
      tabValues.get(tab)?.delete(key);
    },
    getCustomWindowValue(win, key) {
      return windowValues.get(win)?.get(key) || "";
    },
    setCustomWindowValue(win, key, value) {
      if (!windowValues.has(win)) {
        windowValues.set(win, new Map());
      }
      windowValues.get(win).set(key, value);
      writes.window.push({ window: win, key, value });
    },
    _tabValues: tabValues,
    _windowValues: windowValues,
    _writes: writes,
  };
}

function clearTreeStoreState() {
  if (TreeTabsStore._initialized) {
    TreeTabsStore.uninit();
  } else {
    TreeTabsStore._cancelAllPendingSaves();
    for (const timeoutId of TreeTabsStore._restoreGuardTimers.values()) {
      clearTimeout(timeoutId);
    }
    TreeTabsStore._windowStates.clear();
    TreeTabsStore._restoringWindows = new WeakSet();
    TreeTabsStore._sessionRestoringWindows = new WeakSet();
    TreeTabsStore._pendingWindowRestores = new WeakSet();
    TreeTabsStore._restoreGuardTimers.clear();
    TreeTabsStore._manualRestoreCompleted = new WeakSet();
    TreeTabsStore._activeClosedTreeSets.clear();
    TreeTabsStore._closedTreeSets.clear();
    TreeTabsStore._pendingClosedTreeRestores.clear();
    TreeTabsStore._frozenCloseTabs = new WeakSet();
    TreeTabsStore._restoringClosedTreeSets = new WeakSet();
    TreeTabsStore._closedSetRestoringTabs = new WeakSet();
  }
  TreeTabsStore._tabGuids = new WeakMap();
  TreeTabsService._windowStates.clear();
}

function setupStore({ enabled = true } = {}) {
  clearTreeStoreState();
  resetTreeTestPrefs();
  Services.prefs.setBoolPref(TREE_PREF_ENABLED, enabled);

  const mockStore = createMockSessionStore();
  TreeTabsMigration._setSessionStoreForTests(mockStore);
  return mockStore;
}

function putTabJSON(mockStore, tab, key, value, { legacy = false } = {}) {
  const prefix = legacy ? LEGACY_PREFIX : NATIVE_PREFIX;
  if (!mockStore._tabValues.has(tab)) {
    mockStore._tabValues.set(tab, new Map());
  }
  mockStore._tabValues.get(tab).set(`${prefix}${key}`, JSON.stringify(value));
}

function putWindowJSON(mockStore, window, key, value, { legacy = false } = {}) {
  const prefix = legacy ? LEGACY_PREFIX : NATIVE_PREFIX;
  if (!mockStore._windowValues.has(window)) {
    mockStore._windowValues.set(window, new Map());
  }
  mockStore._windowValues
    .get(window)
    .set(`${prefix}${key}`, JSON.stringify(value));
}

function getTabJSON(mockStore, tab, key) {
  const raw = mockStore._tabValues.get(tab)?.get(`${NATIVE_PREFIX}${key}`);
  return raw ? JSON.parse(raw) : null;
}

function getWindowJSON(mockStore, window, key) {
  const raw = mockStore._windowValues
    .get(window)
    ?.get(`${NATIVE_PREFIX}${key}`);
  return raw ? JSON.parse(raw) : null;
}

function resetWrites(mockStore) {
  mockStore._writes.tab.length = 0;
  mockStore._writes.window.length = 0;
}

function waitForTimers(ms = 250) {
  return new Promise(resolve => do_timeout(ms, resolve));
}

function createStoredTab(
  mockStore,
  window,
  guid,
  { lazy = false, legacy = false } = {}
) {
  const tab = createMockTab(window);
  if (lazy) {
    tab.linkedPanel = "";
  }
  if (guid != null) {
    putTabJSON(mockStore, tab, "data-persistent-id", guid, { legacy });
  }
  return tab;
}

function putTreeLink(mockStore, parent, child, key, { legacy = false } = {}) {
  const [tab, target] = key == "ancestors" ? [child, parent] : [parent, child];
  const prefix = legacy ? LEGACY_PREFIX : NATIVE_PREFIX;
  const id = JSON.parse(
    mockStore._tabValues.get(target).get(`${prefix}data-persistent-id`)
  );
  putTabJSON(mockStore, tab, key, [id], { legacy });
}

function getStoredData(mockStore) {
  const entries = values =>
    [...values].map(([target, data]) => [target, [...data]]);
  return {
    tabs: entries(mockStore._tabValues),
    windows: entries(mockStore._windowValues),
  };
}

function assertSavesBlocked(mockStore, window, savedData) {
  for (const tab of window.gBrowser.tabs) {
    TreeTabsStore.saveTabState(tab, { force: true });
  }
  TreeTabsStore.saveWindowStructure(window);
  TreeTabsStore.onTreeEvent("tree-tabs-structure-changed", { window });
  Assert.ok(!TreeTabsStore._pendingSaves.has(window), "No save is queued");
  Assert.ok(
    !TreeTabsStore._manualRestoreCompleted.has(window),
    "Blocked saves cannot mark an incomplete restore as complete"
  );
  Assert.deepEqual(
    getStoredData(mockStore),
    savedData,
    "Forced saves preserve all tab and window extData after guard timeout"
  );
  Assert.equal(mockStore._writes.tab.length, 0, "No tab writes");
  Assert.equal(mockStore._writes.window.length, 0, "No window writes");
}

registerCleanupFunction(() => {
  TreeTabsMigration._setSessionStoreForTests(null);
  clearTreeStoreState();
  resetTreeTestPrefs();
});

add_task(function test_save_tab_state_writes_native_keys_and_expected_json() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const parent = createMockTab(window);
  const child = createMockTab(window);

  Assert.ok(
    TreeTabsService.attachTab(child, parent),
    "Child is attached under parent"
  );
  TreeTabsService.collapseSubtree(child);

  TreeTabsStore.saveTabState(child);

  const stored = mockStore._tabValues.get(child);
  Assert.ok(stored, "Stored tab value map exists");
  for (const key of [
    "treeTabs:ancestors",
    "treeTabs:children",
    "treeTabs:special-tab-states",
    "treeTabs:insert-before",
    "treeTabs:insert-after",
  ]) {
    Assert.ok(stored.has(key), `Key written: ${key}`);
  }

  const ancestors = JSON.parse(stored.get("treeTabs:ancestors"));
  Assert.equal(ancestors.length, 1, "Ancestors include the parent reference");
  Assert.equal(
    ancestors[0].id,
    parent.linkedPanel,
    "Ancestor reference carries the linkedPanel"
  );
  Assert.equal(
    typeof ancestors[0].uniqueId,
    "string",
    "Ancestor reference carries a persistent id"
  );
  Assert.deepEqual(
    JSON.parse(stored.get("treeTabs:children")),
    [],
    "Leaf tab has an empty children array"
  );
  Assert.deepEqual(
    JSON.parse(stored.get("treeTabs:special-tab-states")),
    ["subtree-collapsed"],
    "Collapsed state is persisted"
  );
  Assert.equal(
    JSON.parse(stored.get("treeTabs:insert-before")),
    null,
    "No insert-before hint for only child"
  );
  Assert.equal(
    JSON.parse(stored.get("treeTabs:insert-after")),
    null,
    "No insert-after hint for first child"
  );
});

add_task(function test_save_tab_state_is_skipped_when_tree_is_disabled() {
  const mockStore = setupStore({ enabled: false });
  const window = createMockWindow();
  const tab = createMockTab(window);

  TreeTabsStore.saveTabState(tab);

  Assert.equal(mockStore._writes.tab.length, 0, "No tab values are written");
});

add_task(
  function test_save_window_structure_writes_positional_parent_indices() {
    const mockStore = setupStore();
    const window = createMockWindow();
    const root = createMockTab(window);
    const child = createMockTab(window);
    const grandchild = createMockTab(window);

    Assert.ok(TreeTabsService.attachTab(child, root), "Child attached to root");
    Assert.ok(
      TreeTabsService.attachTab(grandchild, child),
      "Grandchild attached to child"
    );
    TreeTabsService.collapseSubtree(child);

    TreeTabsStore.saveWindowStructure(window);

    const structure = getWindowJSON(mockStore, window, "tree-structure");
    Assert.ok(Array.isArray(structure), "Window structure is written");
    Assert.deepEqual(
      structure.map(entry => entry.parent),
      [null, 0, 1],
      "Structure stores parent references by tab index"
    );
    Assert.equal(structure[1].collapsed, true, "Collapsed state is persisted");
    Assert.ok(
      structure.every(entry => typeof entry.id == "string"),
      "Every entry carries a persistent id"
    );
  }
);

add_task(
  function test_save_window_structure_is_skipped_when_tree_is_disabled() {
    const mockStore = setupStore({ enabled: false });
    const window = createMockWindow();
    createMockTab(window);

    TreeTabsStore.saveWindowStructure(window);

    Assert.equal(
      mockStore._writes.window.length,
      0,
      "No window values are written"
    );
  }
);

add_task(function test_load_tab_state_parses_native_json_values() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tab = createMockTab(window);

  putTabJSON(mockStore, tab, "ancestors", [
    { id: "panel-parent", uniqueId: null },
  ]);
  putTabJSON(mockStore, tab, "children", [
    { id: "panel-child", uniqueId: null },
  ]);
  putTabJSON(mockStore, tab, "insert-before", {
    id: "panel-before",
    uniqueId: null,
  });
  putTabJSON(mockStore, tab, "insert-after", {
    id: "panel-after",
    uniqueId: null,
  });
  putTabJSON(mockStore, tab, "special-tab-states", ["subtree-collapsed"]);
  putTabJSON(mockStore, tab, "data-persistent-id", { id: "legacy-uid-123" });

  const state = TreeTabsStore.loadTabState(tab);
  Assert.deepEqual(
    state.ancestors,
    [{ id: "panel-parent", uniqueId: null }],
    "Ancestors are parsed from JSON"
  );
  Assert.deepEqual(
    state.children,
    [{ id: "panel-child", uniqueId: null }],
    "Children are parsed from JSON"
  );
  Assert.deepEqual(
    state.insertBefore,
    { id: "panel-before", uniqueId: null },
    "insertBefore is parsed from JSON"
  );
  Assert.deepEqual(
    state.insertAfter,
    { id: "panel-after", uniqueId: null },
    "insertAfter is parsed from JSON"
  );
  Assert.deepEqual(
    state.specialStates,
    ["subtree-collapsed"],
    "special states are parsed from JSON"
  );
  Assert.ok(state.hasSpecialStateData, "Special state data is explicit");
  Assert.equal(
    state.legacyUniqueId,
    "legacy-uid-123",
    "Legacy unique id is parsed"
  );
});

add_task(function test_load_tab_state_falls_back_to_legacy_namespace() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tab = createMockTab(window);

  if (!mockStore._tabValues.has(tab)) {
    mockStore._tabValues.set(tab, new Map());
  }
  mockStore._tabValues.get(tab).set("treeTabs:ancestors", "");
  putTabJSON(mockStore, tab, "ancestors", [{ id: "legacy-parent" }], {
    legacy: true,
  });

  const state = TreeTabsStore.loadTabState(tab);
  Assert.deepEqual(
    state.ancestors,
    [{ id: "legacy-parent" }],
    "Ancestors are loaded from legacy namespace when native value is empty"
  );
});

add_task(
  function test_load_window_structure_reads_json_and_missing_returns_null() {
    const mockStore = setupStore();
    const window = createMockWindow();

    const expected = [
      { parent: null, collapsed: false },
      { parent: 0, collapsed: true },
    ];
    putWindowJSON(mockStore, window, "tree-structure", expected);

    Assert.deepEqual(
      TreeTabsStore.loadWindowStructure(window),
      expected,
      "Window structure is parsed from JSON"
    );

    const otherWindow = createMockWindow();
    Assert.equal(
      TreeTabsStore.loadWindowStructure(otherWindow),
      null,
      "Missing window structure returns null"
    );
  }
);

add_task(function test_tab_restore_reattaches_from_session_data() {
  setupStore();
  const window = createMockWindow();
  const parent = createMockTab(window);
  const child = createMockTab(window);
  const sibling = createMockTab(window);

  TreeTabsService.attachTab(child, parent);
  TreeTabsService.attachTab(sibling, parent);
  TreeTabsService.collapseSubtree(child);

  TreeTabsStore.saveTabState(child);

  TreeTabsService.detachTab(child);
  TreeTabsService.expandSubtree(child);
  Assert.equal(TreeTabsService.getParent(child), null, "Child is detached");
  Assert.equal(
    TreeTabsService.isCollapsed(child),
    false,
    "Child starts expanded"
  );

  // Simulate undo close with saved session data.
  TreeTabsStore.onTabRestoring(child);
  TreeTabsStore.onTabRestored(child);
  Assert.equal(
    TreeTabsService.getParent(child),
    parent,
    "Child reattached to parent"
  );
  Assert.equal(
    TreeTabsService.isCollapsed(child),
    true,
    "Child collapsed state is restored"
  );
  assertTabOrder(
    TreeTabsService.getChildren(parent),
    [child, sibling],
    "Insert hints place the restored tab back before its sibling"
  );
});

add_task(function test_tab_restore_replays_explicit_expanded_state() {
  setupStore();
  const window = createMockWindow();
  const parent = createMockTab(window);
  const child = createMockTab(window);

  TreeTabsService.attachTab(child, parent);
  TreeTabsStore.saveTabState(child);
  TreeTabsService.collapseSubtree(child);

  TreeTabsStore.onTabRestoring(child);
  TreeTabsStore.onTabRestored(child);

  Assert.equal(
    TreeTabsService.isCollapsed(child),
    false,
    "An explicitly saved expanded state replaces stale model collapse"
  );
});

add_task(function test_disclosure_changes_override_pending_restore_data() {
  for (const initiallyCollapsed of [false, true]) {
    for (const beforeRestoring of [false, true]) {
      const mockStore = setupStore();
      const window = createMockWindow();
      const tab = createStoredTab(mockStore, window, "pending-parent");
      TreeTabsStore.getTabGuid(tab);
      putTabJSON(
        mockStore,
        tab,
        "special-tab-states",
        initiallyCollapsed ? ["subtree-collapsed"] : []
      );
      tab.hasAttribute = name => name == "pending" && beforeRestoring;
      if (!beforeRestoring) {
        TreeTabsStore.onTabRestoring(tab);
      }
      TreeTabsStore.onTreeEvent("tree-tabs-subtree-collapsed-changed", {
        tab,
        collapsed: !initiallyCollapsed,
      });
      if (beforeRestoring) {
        TreeTabsStore.onTabRestoring(tab);
      }
      TreeTabsStore.onTabRestored(tab);
      Assert.equal(
        TreeTabsService.isCollapsed(tab),
        !initiallyCollapsed,
        "A disclosure choice before or during loading overrides saved metadata"
      );
      Assert.ok(
        !TreeTabsStore._getWindowState(window).collapseStates.has(tab),
        "The override is consumed when restoration finishes"
      );

      TreeTabsStore.onTabRestoring(tab);
      TreeTabsStore.onTabRestored(tab);
      Assert.equal(
        TreeTabsService.isCollapsed(tab),
        initiallyCollapsed,
        "An independent later restore still applies its saved disclosure state"
      );
    }
  }
});

add_task(
  function test_tab_restore_leaves_unspecified_collapse_state_unchanged() {
    setupStore();
    const window = createMockWindow();
    const tab = createMockTab(window);

    TreeTabsService.collapseSubtree(tab);
    TreeTabsStore.onTabRestoring(tab);
    TreeTabsStore.onTabRestored(tab);

    Assert.equal(
      TreeTabsService.isCollapsed(tab),
      true,
      "Missing legacy collapse data does not imply expansion"
    );
  }
);

add_task(function test_tab_restore_reclaims_root_children() {
  setupStore();
  const window = createMockWindow();
  const parent = createMockTab(window);
  const childA = createMockTab(window);
  const childB = createMockTab(window);

  TreeTabsService.attachTab(childA, parent);
  TreeTabsService.attachTab(childB, parent);

  // Save parent state while it has children.
  TreeTabsStore.saveTabState(parent);

  // Simulate close: promote children to roots and clear parent links.
  TreeTabsService.detachAllChildren(parent);
  TreeTabsService.detachTab(parent);
  Assert.equal(
    TreeTabsService.getParent(childA),
    null,
    "childA is root after parent close"
  );
  Assert.equal(
    TreeTabsService.getParent(childB),
    null,
    "childB is root after parent close"
  );

  // Simulate undo-close: parent comes back and reclaims children.
  TreeTabsStore.onTabRestoring(parent);
  TreeTabsStore.onTabRestored(parent);
  Assert.equal(
    TreeTabsService.getParent(childA),
    parent,
    "childA reclaimed by restored parent"
  );
  Assert.equal(
    TreeTabsService.getParent(childB),
    parent,
    "childB reclaimed by restored parent"
  );
});

add_task(function test_try_manual_restore_successfully_restores_parent_links() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tabs = [
    createMockTab(window),
    createMockTab(window),
    createMockTab(window),
  ];

  putWindowJSON(mockStore, window, "tree-structure", [
    { parent: null },
    { parent: 0 },
    { parent: 1 },
  ]);

  Assert.ok(TreeTabsStore.tryManualRestore(window), "Manual restore succeeds");
  Assert.equal(
    TreeTabsService.getParent(tabs[1]),
    tabs[0],
    "Tab 1 parent is restored from structure"
  );
  Assert.equal(
    TreeTabsService.getParent(tabs[2]),
    tabs[1],
    "Tab 2 parent is restored from structure"
  );
});

add_task(function test_try_manual_restore_restores_collapsed_state() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tabs = [
    createMockTab(window),
    createMockTab(window),
    createMockTab(window),
  ];

  putWindowJSON(mockStore, window, "tree-structure", [
    { parent: null, collapsed: false },
    { parent: 0, collapsed: true },
    { parent: 1, collapsed: false },
  ]);
  TreeTabsService.collapseSubtree(tabs[0]);
  TreeTabsService.collapseSubtree(tabs[2]);

  Assert.ok(TreeTabsStore.tryManualRestore(window), "Manual restore succeeds");
  Assert.ok(
    !TreeTabsService.isCollapsed(tabs[0]),
    "Explicitly expanded root replaces stale model collapse"
  );
  Assert.ok(
    TreeTabsService.isCollapsed(tabs[1]),
    "Collapsed state is restored from window structure"
  );
  Assert.ok(
    !TreeTabsService.isCollapsed(tabs[2]),
    "Explicitly expanded descendant replaces stale model collapse"
  );
});

add_task(
  function test_try_manual_restore_returns_false_when_structure_is_null() {
    setupStore();
    const window = createMockWindow();
    createMockTab(window);
    createMockTab(window);

    Assert.equal(
      TreeTabsStore.tryManualRestore(window),
      false,
      "Manual restore is skipped when no structure is available"
    );
  }
);

add_task(
  function test_try_manual_restore_returns_false_when_tabs_do_not_match() {
    const mockStore = setupStore();
    const window = createMockWindow();
    createMockTab(window);
    createMockTab(window);

    putWindowJSON(mockStore, window, "tree-structure", [
      { parent: null },
      { parent: 0 },
      { parent: 1 },
    ]);

    Assert.equal(
      TreeTabsStore.tryManualRestore(window),
      false,
      "Manual restore is skipped when fewer tabs are available than structure entries"
    );
  }
);

add_task(
  function test_try_manual_restore_returns_false_when_no_parent_links_exist() {
    const mockStore = setupStore();
    const window = createMockWindow();
    createMockTab(window);
    createMockTab(window);
    createMockTab(window);

    putWindowJSON(mockStore, window, "tree-structure", [
      { parent: null },
      { parent: null },
      { parent: null },
    ]);

    Assert.equal(
      TreeTabsStore.tryManualRestore(window),
      false,
      "Manual restore is skipped when structure has no parent relationships"
    );
  }
);

add_task(function test_try_manual_restore_only_runs_once_per_window() {
  const mockStore = setupStore();
  const window = createMockWindow();
  createMockTab(window);
  createMockTab(window);

  putWindowJSON(mockStore, window, "tree-structure", [
    { parent: null },
    { parent: 0 },
  ]);

  Assert.ok(
    TreeTabsStore.tryManualRestore(window),
    "First manual restore succeeds"
  );
  Assert.equal(
    TreeTabsStore.tryManualRestore(window),
    false,
    "Second manual restore is skipped for the same window"
  );
});

add_task(function test_try_manual_restore_is_skipped_when_tree_is_disabled() {
  const mockStore = setupStore({ enabled: false });
  const window = createMockWindow();
  createMockTab(window);
  createMockTab(window);

  putWindowJSON(mockStore, window, "tree-structure", [
    { parent: null },
    { parent: 0 },
  ]);

  Assert.equal(
    TreeTabsStore.tryManualRestore(window),
    false,
    "Manual restore is skipped when tree tabs are disabled"
  );
});

add_task(function test_restore_guard_suppresses_direct_save_operations() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const parent = createMockTab(window);
  const child = createMockTab(window);
  TreeTabsService.attachTab(child, parent);

  TreeTabsStore.ensureRestoreGuard(window);
  TreeTabsStore.saveWindowStructure(window);
  TreeTabsStore.saveTabState(child);

  Assert.equal(
    mockStore._writes.window.length,
    0,
    "Window writes are suppressed"
  );
  Assert.equal(mockStore._writes.tab.length, 0, "Tab writes are suppressed");
});

add_task(async function test_restore_guard_suppresses_on_tree_event_saves() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const parent = createMockTab(window);
  const child = createMockTab(window);
  TreeTabsService.attachTab(child, parent);

  TreeTabsStore.ensureRestoreGuard(window);
  TreeTabsStore.onTreeEvent("tree-tabs-structure-changed", {
    window,
    tab: child,
  });

  await waitForTimers(275);
  Assert.equal(
    mockStore._writes.window.length,
    0,
    "Window writes remain suppressed"
  );
  Assert.equal(mockStore._writes.tab.length, 0, "Tab writes remain suppressed");
});

add_task(function test_restore_guard_clears_after_successful_manual_restore() {
  const mockStore = setupStore();
  const window = createMockWindow();
  createMockTab(window);
  createMockTab(window);

  putWindowJSON(mockStore, window, "tree-structure", [
    { parent: null },
    { parent: 0 },
  ]);
  resetWrites(mockStore);

  TreeTabsStore.ensureRestoreGuard(window);
  Assert.ok(TreeTabsStore.tryManualRestore(window), "Manual restore succeeds");
  Assert.ok(
    !TreeTabsStore._restoringWindows.has(window),
    "Restore guard is cleared after successful restore"
  );

  TreeTabsStore.saveWindowStructure(window);
  Assert.equal(
    mockStore._writes.window.length,
    1,
    "Writes resume after guard is cleared"
  );
});

add_task(async function test_restore_guard_clears_after_timeout() {
  const mockStore = setupStore();
  const window = createMockWindow();
  createMockTab(window);

  TreeTabsStore.ensureRestoreGuard(window);
  Assert.ok(
    TreeTabsStore._restoringWindows.has(window),
    "Restore guard is active"
  );

  const timeoutId = TreeTabsStore._restoreGuardTimers.get(window);
  Assert.ok(timeoutId, "Restore guard timeout is scheduled");
  clearTimeout(timeoutId);
  do_timeout(25, () => {
    TreeTabsStore.clearRestoreGuard(window);
  });

  await waitForTimers(80);
  Assert.ok(
    !TreeTabsStore._restoringWindows.has(window),
    "Restore guard clears after timeout callback"
  );

  TreeTabsStore.saveWindowStructure(window);
  Assert.equal(
    mockStore._writes.window.length,
    1,
    "Writes resume after timeout clears guard"
  );
});

add_task(function test_on_window_restored_does_not_overwrite_empty_tree() {
  const mockStore = setupStore();
  const window = createMockWindow();
  createMockTab(window);
  createMockTab(window);
  createMockTab(window);

  const originalStructure = JSON.stringify([
    { parent: null, collapsed: false },
    { parent: 0, collapsed: true },
    { parent: 1, collapsed: false },
  ]);
  if (!mockStore._windowValues.has(window)) {
    mockStore._windowValues.set(window, new Map());
  }
  mockStore._windowValues
    .get(window)
    .set("treeTabs:tree-structure", originalStructure);
  resetWrites(mockStore);

  TreeTabsStore.ensureRestoreGuard(window);
  TreeTabsStore.onWindowRestored(window);

  Assert.equal(
    mockStore._writes.window.length,
    0,
    "Window restore does not write when no tree model is present"
  );
  Assert.equal(
    mockStore._windowValues.get(window).get("treeTabs:tree-structure"),
    originalStructure,
    "Previously persisted structure remains unchanged"
  );
});

add_task(
  function test_fixup_window_tree_detaches_tabs_with_invalid_pinned_parent() {
    setupStore();
    const window = createMockWindow();
    const parent = createMockTab(window);
    const child = createMockTab(window);
    TreeTabsService.attachTab(child, parent);

    parent.pinned = true;
    TreeTabsStore._fixupWindowTree(window);

    Assert.equal(
      TreeTabsService.getParent(child),
      null,
      "Child is detached from pinned parent"
    );
  }
);

add_task(function test_fixup_window_tree_breaks_detected_cycles() {
  setupStore();
  const window = createMockWindow();
  const root = createMockTab(window);
  const child = createMockTab(window);
  TreeTabsService.attachTab(child, root);
  Assert.equal(
    TreeTabsService.getParent(child),
    root,
    "Precondition: child is attached"
  );

  const originalGetAncestors = TreeTabsService.getAncestors;
  TreeTabsService.getAncestors = function (tab) {
    if (tab === root) {
      return [child];
    }
    return originalGetAncestors.call(this, tab);
  };

  try {
    TreeTabsStore._fixupWindowTree(window);
  } finally {
    TreeTabsService.getAncestors = originalGetAncestors;
  }

  Assert.equal(
    TreeTabsService.getParent(child),
    null,
    "Cycle-detected child is detached"
  );
});

add_task(async function test_debounced_saves_batch_multiple_tree_events() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tab = createMockTab(window);

  TreeTabsStore.onTreeEvent("tree-tabs-subtree-collapsed-changed", {
    window,
    tab,
  });
  TreeTabsStore.onTreeEvent("tree-tabs-subtree-collapsed-changed", {
    window,
    tab,
  });
  TreeTabsStore.onTreeEvent("tree-tabs-subtree-collapsed-changed", {
    window,
    tab,
  });

  await waitForTimers(275);
  Assert.equal(
    mockStore._writes.window.length,
    1,
    "Window structure is written once"
  );
  Assert.equal(
    mockStore._writes.tab.length,
    6,
    "Tab state and the persistent id are written once for a single tab"
  );
});

add_task(
  async function test_structure_changed_event_triggers_full_window_save() {
    const mockStore = setupStore();
    const window = createMockWindow();
    const root = createMockTab(window);
    const child = createMockTab(window);
    const otherRoot = createMockTab(window);
    TreeTabsService.attachTab(child, root);

    TreeTabsStore.onTreeEvent("tree-tabs-structure-changed", {
      window,
      tab: child,
    });

    await waitForTimers(275);
    Assert.equal(
      mockStore._writes.window.length,
      1,
      "Window structure is saved once"
    );
    Assert.equal(
      mockStore._writes.tab.length,
      18,
      "All three tabs and their persistent ids are saved during full-window save"
    );

    for (const tab of [root, child, otherRoot]) {
      Assert.notStrictEqual(
        getTabJSON(mockStore, tab, "ancestors"),
        null,
        `Ancestors saved for tab ${tab.id}`
      );
      Assert.notStrictEqual(
        getTabJSON(mockStore, tab, "children"),
        null,
        `Children saved for tab ${tab.id}`
      );
    }
  }
);

add_task(function test_try_manual_restore_matches_by_persistent_id() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tabB = createMockTab(window);
  const extra = createMockTab(window);
  const tabA = createMockTab(window);
  const tabC = createMockTab(window);
  putTabJSON(mockStore, tabA, "data-persistent-id", "guid-a");
  putTabJSON(mockStore, tabB, "data-persistent-id", "guid-b");
  putTabJSON(mockStore, tabC, "data-persistent-id", "guid-c");

  putWindowJSON(mockStore, window, "tree-structure", [
    { id: "guid-a", parent: null },
    { id: "guid-b", parent: 0 },
    { id: "guid-c", parent: 1, collapsed: true },
  ]);

  Assert.ok(TreeTabsStore.tryManualRestore(window), "Manual restore succeeds");
  Assert.equal(
    TreeTabsService.getParent(tabB),
    tabA,
    "Parent link resolved by persistent id despite the reordered strip"
  );
  Assert.equal(
    TreeTabsService.getParent(tabC),
    tabB,
    "Grandchild link resolved by persistent id"
  );
  Assert.equal(
    TreeTabsService.getParent(extra),
    null,
    "The tab without an entry is left alone"
  );
  Assert.ok(
    TreeTabsService.isCollapsed(tabC),
    "Collapsed state follows the id-matched entry"
  );
});

add_task(function test_try_manual_restore_by_id_survives_missing_tabs() {
  const mockStore = setupStore();
  const window = createMockWindow();

  const tabA = createMockTab(window);
  const tabC = createMockTab(window);
  putTabJSON(mockStore, tabA, "data-persistent-id", "guid-a");
  putTabJSON(mockStore, tabC, "data-persistent-id", "guid-c");

  putWindowJSON(mockStore, window, "tree-structure", [
    { id: "guid-a", parent: null },
    { id: "guid-gone", parent: 0 },
    { id: "guid-c", parent: 0 },
  ]);

  Assert.ok(
    TreeTabsStore.tryManualRestore(window),
    "Manual restore still succeeds with entries whose tabs are gone"
  );
  Assert.equal(
    TreeTabsService.getParent(tabC),
    tabA,
    "Surviving parent link is restored"
  );
});

add_task(
  function test_save_window_structure_keeps_stored_tree_until_restored() {
    const mockStore = setupStore();
    const window = createMockWindow();
    const first = createMockTab(window);
    const second = createMockTab(window);

    const storedStructure = [
      { id: "guid-old-a", parent: null },
      { id: "guid-old-b", parent: 0 },
    ];
    putWindowJSON(mockStore, window, "tree-structure", storedStructure);

    TreeTabsStore.saveWindowStructure(window);
    Assert.deepEqual(
      getWindowJSON(mockStore, window, "tree-structure"),
      storedStructure,
      "Flat snapshot does not clobber the stored tree"
    );

    TreeTabsService.attachTab(second, first);
    TreeTabsStore.saveWindowStructure(window);
    Assert.deepEqual(
      getWindowJSON(mockStore, window, "tree-structure").map(
        entry => entry.parent
      ),
      [null, 0],
      "A live tree is saved over the stale structure"
    );

    TreeTabsService.detachTab(second);
    TreeTabsStore.saveWindowStructure(window);
    Assert.deepEqual(
      getWindowJSON(mockStore, window, "tree-structure").map(
        entry => entry.parent
      ),
      [null, null],
      "Flattening after a save with a tree is persisted"
    );
  }
);

function countGuidRestoreWork(callback) {
  const counts = {
    windowEnumerations: 0,
    guidLookups: 0,
    persistentIDReads: 0,
  };
  const methods = {
    _getWindowTabs: "windowEnumerations",
    _getTabGuid: "guidLookups",
    _readLegacyUniqueId: "persistentIDReads",
  };
  const originals = new Map();
  for (const [method, counter] of Object.entries(methods)) {
    const original = TreeTabsStore[method];
    originals.set(method, original);
    TreeTabsStore[method] = function (...args) {
      counts[counter]++;
      return original.apply(this, args);
    };
  }
  try {
    callback();
  } finally {
    for (const [method, original] of originals) {
      TreeTabsStore[method] = original;
    }
  }
  return counts;
}

add_task(function test_bulk_guid_checks_refresh_ids_with_linear_work() {
  for (const enabled of [false, true]) {
    for (const count of [64, 128]) {
      const mockStore = setupStore({ enabled });
      const window = createMockWindow();
      const tabs = Array.from({ length: count }, (_, index) => {
        const tab = createStoredTab(mockStore, window, `previous-${index}`);
        TreeTabsStore.getTabGuid(tab);
        putTabJSON(mockStore, tab, "data-persistent-id", `unique-${index}`);
        return tab;
      });
      const counts = countGuidRestoreWork(() =>
        TreeTabsStore.ensureUniqueTabGuids(window)
      );
      info(`Bulk GUID work: ${JSON.stringify({ enabled, count, ...counts })}`);
      Assert.deepEqual(
        counts,
        { windowEnumerations: 1, guidLookups: count, persistentIDReads: count },
        "A bulk check enumerates once and reads each tab's current ID once"
      );
      Assert.equal(
        mockStore._writes.tab.length,
        0,
        "Unique IDs are not rewritten"
      );
      for (const [index, tab] of tabs.entries()) {
        Assert.equal(TreeTabsStore.getTabGuid(tab), `unique-${index}`);
        putTabJSON(mockStore, tab, "data-persistent-id", "shared-guid");
      }

      const duplicates = countGuidRestoreWork(() =>
        TreeTabsStore.ensureUniqueTabGuids(window)
      );
      Assert.deepEqual(
        duplicates,
        counts,
        "Copied IDs require the same bounded work"
      );
      const guids = tabs.map(tab =>
        getTabJSON(mockStore, tab, "data-persistent-id")
      );
      Assert.equal(new Set(guids).size, count);
      Assert.equal(
        guids[0],
        "shared-guid",
        "The first live owner keeps its ID"
      );
      Assert.equal(mockStore._writes.tab.length, count - 1);
    }
  }
});

add_task(
  function test_many_copied_guids_remain_unique_after_repeated_restores() {
    for (const enabled of [false, true]) {
      const mockStore = setupStore({ enabled });
      const window = createMockWindow();
      const tabs = Array.from({ length: 64 }, () =>
        createStoredTab(mockStore, window, "shared-guid")
      );
      for (const tab of tabs.toReversed()) {
        TreeTabsStore.onTabRestoring(tab);
      }
      const guids = tabs.map(tab =>
        getTabJSON(mockStore, tab, "data-persistent-id")
      );
      Assert.equal(
        new Set(guids).size,
        tabs.length,
        "All copied tabs have distinct persistent IDs after their restore events"
      );
      Assert.equal(
        guids.filter(guid => guid == "shared-guid").length,
        1,
        "Exactly one tab retains the copied ID"
      );
      resetWrites(mockStore);
      for (const tab of tabs) {
        TreeTabsStore.onTabRestoring(tab);
      }
      Assert.deepEqual(
        tabs.map(tab => getTabJSON(mockStore, tab, "data-persistent-id")),
        guids,
        "Repeated restore notifications do not change the normalized IDs"
      );
      Assert.equal(mockStore._writes.tab.length, 0);
    }
  }
);

add_task(
  function test_guid_checks_track_open_generated_and_closed_tabs_when_disabled() {
    const mockStore = setupStore({ enabled: false });
    const window = createMockWindow();
    const original = createStoredTab(mockStore, window, "original-guid");
    TreeTabsStore.onTabRestoring(original);

    for (const generated of [false, true]) {
      const opened = createMockTab(window);
      TreeTabsStore.handleEvent({ type: "TabOpen", target: opened });
      if (!generated) {
        putTabJSON(mockStore, opened, "data-persistent-id", "opened-guid");
      }
      const guid = generated
        ? TreeTabsStore.getTabGuid(opened, { create: true })
        : "opened-guid";
      const duplicate = createStoredTab(mockStore, window, guid);
      TreeTabsStore.onTabRestoring(duplicate);
      Assert.notEqual(
        TreeTabsStore.getTabGuid(duplicate),
        guid,
        `${generated ? "Generated" : "Incoming"} IDs are owned before a restore event`
      );
    }

    original.closing = true;
    TreeTabsStore.handleEvent({ type: "TabClose", target: original });
    const reopened = createStoredTab(mockStore, window, "original-guid");
    TreeTabsStore.onTabRestoring(reopened);
    Assert.equal(TreeTabsStore.getTabGuid(reopened), "original-guid");
    Assert.ok(
      !TreeTabsStore._tabGuids.has(original),
      "Close clears the cached ID"
    );
    Assert.ok(
      !TreeTabsStore._windowStates.has(window),
      "Disabled checks do not create tree restore state"
    );
  }
);

add_task(function test_guid_cache_tracks_both_adoption_paths() {
  for (const enabled of [false, true]) {
    for (const type of ["TabOpen", "TabClose"]) {
      const mockStore = setupStore({ enabled });
      const sourceWindow = createMockWindow();
      const targetWindow = createMockWindow();
      const source = createStoredTab(mockStore, sourceWindow, "adopted-guid");
      const target = createStoredTab(
        mockStore,
        targetWindow,
        "placeholder-guid"
      );
      TreeTabsStore.onTabRestoring(source);
      TreeTabsStore.onTabRestoring(target);

      mockStore._tabValues.set(target, mockStore._tabValues.get(source));
      mockStore._tabValues.delete(source);
      TreeTabsStore.handleEvent(
        type == "TabOpen"
          ? { type, target, detail: { adoptedTab: source } }
          : { type, target: source, detail: { adoptedBy: target } }
      );
      Assert.equal(
        TreeTabsStore.getTabGuid(target),
        "adopted-guid",
        `${type} refreshes the target after SessionStore transfers metadata`
      );
      Assert.equal(TreeTabsStore.getTabGuid(source), null);
      if (enabled) {
        const sourceState = TreeTabsStore._windowStates.get(sourceWindow);
        const targetState = TreeTabsStore._windowStates.get(targetWindow);
        Assert.ok(!sourceState.uniqueIdToTab.has("adopted-guid"));
        Assert.ok(
          !sourceState.tabData.has(source),
          "Adoption releases source restore data"
        );
        Assert.ok(!targetState.uniqueIdToTab.has("placeholder-guid"));
        Assert.ok(
          !targetState.tabData.has(target),
          "Target restore data must be reloaded"
        );
        TreeTabsStore.onTabRestored(target);
        Assert.ok(
          !targetState.uniqueIdToTab.has("placeholder-guid"),
          "A later restore cannot resurrect the target's superseded identity"
        );
      }

      const sourceReplacement = createStoredTab(
        mockStore,
        sourceWindow,
        "adopted-guid"
      );
      TreeTabsStore.onTabRestoring(sourceReplacement);
      Assert.equal(
        TreeTabsStore.getTabGuid(sourceReplacement),
        "adopted-guid",
        "The source window no longer reports a collision with the adopted tab"
      );
      source.closing = true;
      TreeTabsStore.handleEvent({
        type: "TabClose",
        target: source,
        detail: { adoptedBy: target },
      });
      const targetDuplicate = createStoredTab(
        mockStore,
        targetWindow,
        "adopted-guid"
      );
      TreeTabsStore.onTabRestoring(targetDuplicate);
      Assert.notEqual(
        TreeTabsStore.getTabGuid(targetDuplicate),
        "adopted-guid",
        "The adopted tab owns its ID in the destination in both modes"
      );
      Assert.equal(TreeTabsStore.getTabGuid(target), "adopted-guid");
    }
  }
});

add_task(
  function test_adoption_reloads_restore_data_even_when_guid_is_unchanged() {
    for (const type of ["TabOpen", "TabClose"]) {
      const mockStore = setupStore();
      const source = createStoredTab(
        mockStore,
        createMockWindow(),
        "shared-guid"
      );
      const targetWindow = createMockWindow();
      const target = createStoredTab(mockStore, targetWindow, "shared-guid");
      putTabJSON(mockStore, target, "special-tab-states", [
        "subtree-collapsed",
      ]);
      TreeTabsStore.onTabRestoring(source);
      TreeTabsStore.onTabRestoring(target);
      mockStore._tabValues.set(target, mockStore._tabValues.get(source));
      mockStore._tabValues.delete(source);
      TreeTabsStore.handleEvent(
        type == "TabOpen"
          ? { type, target, detail: { adoptedTab: source } }
          : { type, target: source, detail: { adoptedBy: target } }
      );
      Assert.ok(
        !TreeTabsStore._windowStates.get(targetWindow).tabData.has(target),
        "The transferred session data supersedes the placeholder even with the same ID"
      );
      TreeTabsStore.onTabRestored(target);
      Assert.ok(
        !TreeTabsService.isCollapsed(target),
        "Old target metadata is not restored"
      );
      Assert.equal(TreeTabsStore.getTabGuid(target), "shared-guid");
    }
  }
);

add_task(function test_guid_checks_preserve_idless_restore_data_until_close() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tab = createMockTab(window);
  const counts = countGuidRestoreWork(() => TreeTabsStore.onTabRestoring(tab));
  Assert.equal(
    counts.windowEnumerations,
    0,
    "ID-less tabs need no collision scan"
  );
  const state = TreeTabsStore._windowStates.get(window);
  const tabData = state.tabData.get(tab);
  const other = createStoredTab(mockStore, window, "other-guid");
  TreeTabsStore.onTabRestoring(other);
  Assert.equal(
    state.tabData.get(tab),
    tabData,
    "Reading an unchanged missing ID does not invalidate restore data"
  );
  TreeTabsStore.handleEvent({ type: "TabClose", target: tab });
  Assert.ok(
    !state.tabData.has(tab),
    "Close releases restore data even without an ID"
  );

  const restored = createStoredTab(mockStore, window, "directly-restored");
  TreeTabsStore.onTabRestored(restored);
  Assert.equal(state.uniqueIdToTab.get("directly-restored"), restored);
  TreeTabsStore.handleEvent({ type: "TabClose", target: restored });
  Assert.ok(
    !state.uniqueIdToTab.has("directly-restored"),
    "Close also releases references registered without an earlier restoring event"
  );
});

add_task(function test_guid_cache_refreshes_reused_and_cleared_tab_ids() {
  for (const enabled of [false, true]) {
    const mockStore = setupStore({ enabled });
    const window = createMockWindow();
    const tab = createStoredTab(mockStore, window, "old-guid");
    TreeTabsStore.onTabRestoring(tab);
    putTabJSON(mockStore, tab, "data-persistent-id", "new-guid");
    TreeTabsStore.onTabRestoring(tab);
    Assert.equal(TreeTabsStore.getTabGuid(tab), "new-guid");

    if (enabled) {
      Assert.ok(
        !TreeTabsStore._windowStates.get(window).uniqueIdToTab.has("old-guid"),
        "A reused tab does not remain a restore reference for its old identity"
      );
    }
    mockStore._tabValues.get(tab).delete("treeTabs:data-persistent-id");
    TreeTabsStore.onTabRestoring(tab);
    Assert.equal(TreeTabsStore.getTabGuid(tab), null);
    Assert.ok(
      !TreeTabsStore._tabGuids.has(tab),
      "Restoring without an ID clears the cache"
    );
    if (enabled) {
      Assert.ok(
        !TreeTabsStore._windowStates.get(window).uniqueIdToTab.has("new-guid")
      );
    }
    const replacement = createStoredTab(mockStore, window, "new-guid");
    TreeTabsStore.onTabRestoring(replacement);
    Assert.equal(TreeTabsStore.getTabGuid(replacement), "new-guid");
  }
});

add_task(
  function test_guid_checks_find_new_owners_before_their_restore_event() {
    for (const enabled of [false, true]) {
      for (const previousGuid of [null, "previous-guid"]) {
        const mockStore = setupStore({ enabled });
        const window = createMockWindow();
        const owner = createStoredTab(mockStore, window, previousGuid, {
          lazy: true,
        });
        const restored = createStoredTab(
          mockStore,
          window,
          "restored-previous",
          {
            lazy: true,
          }
        );
        TreeTabsStore.onTabRestoring(owner);
        TreeTabsStore.onTabRestoring(restored);

        putTabJSON(mockStore, owner, "data-persistent-id", {
          id: "shared-guid",
        });
        putTabJSON(mockStore, restored, "data-persistent-id", "shared-guid");
        TreeTabsStore.onTabRestoring(restored);
        const restoredGuid = TreeTabsStore.getTabGuid(restored);
        Assert.notEqual(
          restoredGuid,
          "shared-guid",
          "A tab with cached metadata can acquire a matching GUID without a notification"
        );
        Assert.equal(
          TreeTabsStore.getTabGuid(owner),
          "shared-guid",
          "The unactivated owner keeps its incoming session ID"
        );
        Assert.deepEqual(
          getTabJSON(mockStore, owner, "data-persistent-id"),
          { id: "shared-guid" },
          "The owner's legacy-format value is not rewritten"
        );
        if (enabled) {
          const state = TreeTabsStore._windowStates.get(window);
          Assert.ok(!state.uniqueIdToTab.has("restored-previous"));
          Assert.ok(
            !state.tabData.has(owner),
            "Superseded restore data is discarded"
          );
          TreeTabsStore.onTabRestored(owner);
          Assert.ok(
            !state.uniqueIdToTab.has("previous-guid"),
            "Delayed completion cannot re-register the owner's previous ID"
          );
          Assert.equal(
            TreeTabsStore._findTabByReference(window, "shared-guid", state),
            owner
          );
        }
        TreeTabsStore.onTabRestoring(owner);
        TreeTabsStore.onTabRestoring(restored);
        Assert.equal(TreeTabsStore.getTabGuid(owner), "shared-guid");
        Assert.equal(
          TreeTabsStore.getTabGuid(restored),
          restoredGuid,
          "Activating the owner later does not swap the two identities"
        );
      }
    }
  }
);

add_task(function test_guid_checks_revalidate_changed_collision_candidates() {
  const mockStore = setupStore({ enabled: false });
  const window = createMockWindow();
  const original = createStoredTab(mockStore, window, "before-guid");
  TreeTabsStore.onTabRestoring(original);
  putTabJSON(mockStore, original, "data-persistent-id", "after-guid");
  const restored = createStoredTab(mockStore, window, "before-guid");
  TreeTabsStore.onTabRestoring(restored);
  Assert.equal(
    TreeTabsStore.getTabGuid(restored),
    "before-guid",
    "A candidate's superseded metadata cannot force an unnecessary replacement ID"
  );
  Assert.equal(
    TreeTabsStore.getTabGuid(original),
    "after-guid",
    "The candidate is refreshed before its own restore event arrives"
  );
  const duplicate = createStoredTab(mockStore, window, "after-guid");
  TreeTabsStore.onTabRestoring(duplicate);
  Assert.notEqual(TreeTabsStore.getTabGuid(duplicate), "after-guid");
});

add_task(function test_guid_checks_ignore_no_longer_live_owners() {
  for (const state of ["closing", "disconnected", "other-window"]) {
    const mockStore = setupStore({ enabled: false });
    const window = createMockWindow();
    const old = createStoredTab(mockStore, window, "reusable-guid");
    TreeTabsStore.onTabRestoring(old);
    if (state == "closing") {
      old.closing = true;
    } else if (state == "disconnected") {
      old.isConnected = false;
    } else {
      old.documentGlobal = createMockWindow();
    }
    const restored = createStoredTab(mockStore, window, "reusable-guid");
    TreeTabsStore.ensureUniqueTabGuids(window);
    Assert.equal(
      TreeTabsStore.getTabGuid(restored),
      "reusable-guid",
      `Bulk checks ignore ${state} owners`
    );
    TreeTabsStore.onTabRestoring(restored);
    Assert.equal(TreeTabsStore.getTabGuid(restored), "reusable-guid", state);
  }
});

add_task(
  function test_guid_checks_refresh_ids_across_window_restore_boundaries() {
    for (const enabled of [false, true]) {
      const mockStore = setupStore({ enabled });
      const window = createMockWindow();
      const tab = createStoredTab(mockStore, window, "previous-session");
      TreeTabsStore.onTabRestoring(tab);
      TreeTabsStore.onWindowRestoring(window);
      putTabJSON(mockStore, tab, "data-persistent-id", "incoming-session");
      const duplicate = createStoredTab(mockStore, window, "incoming-session");
      TreeTabsStore.onTabRestoring(duplicate);
      Assert.equal(
        TreeTabsStore.getTabGuid(tab),
        "incoming-session",
        "Duplicate checks refresh reused tabs, including in disabled mode"
      );
      Assert.notEqual(TreeTabsStore.getTabGuid(duplicate), "incoming-session");
      const duplicateGuid = TreeTabsStore.getTabGuid(duplicate);
      TreeTabsStore.onWindowRestored(window);
      TreeTabsStore.onTabRestoring(tab);
      TreeTabsStore.onTabRestoring(duplicate);
      Assert.equal(TreeTabsStore.getTabGuid(tab), "incoming-session");
      Assert.equal(
        TreeTabsStore.getTabGuid(duplicate),
        duplicateGuid,
        "Completing the window restore does not change the normalized IDs"
      );
    }
  }
);

add_task(function test_guid_cache_window_listeners_and_teardown() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const listeners = new Map();
  window.addEventListener = (type, listener, capture = false) => {
    listeners.set(type, { listener, capture });
  };
  window.removeEventListener = (type, listener, capture = false) => {
    Assert.equal(listeners.get(type).listener, listener);
    Assert.equal(listeners.get(type).capture, capture);
    listeners.delete(type);
  };
  const tab = createStoredTab(mockStore, window, "teardown-guid");
  TreeTabsStore.initWindow(window);
  try {
    Assert.equal(
      listeners.get("TabOpen").capture,
      false,
      "Ownership is refreshed after SessionStore's capture listener transfers metadata"
    );
    Assert.equal(listeners.get("TabClose").capture, false);
    TreeTabsStore.onTabRestoring(tab);
    Assert.equal(TreeTabsStore.getTabGuid(tab), "teardown-guid");
    const state = TreeTabsStore._windowStates.get(window);
    tab.closing = true;
    TreeTabsStore.handleEvent({ type: "TabClose", target: tab });
    Assert.ok(!TreeTabsStore._tabGuids.has(tab));
    Assert.ok(!state.uniqueIdToTab.has("teardown-guid"));
    Assert.ok(!state.tabData.has(tab), "Close releases the tab's restore data");
  } finally {
    TreeTabsStore.uninitWindow(window);
  }
  Assert.ok(!TreeTabsStore._windowStates.has(window));
  Assert.ok(!TreeTabsStore._restoreGuardTimers.has(window));
  Assert.equal(listeners.size, 0, "All window listeners are removed");
});

add_task(function test_duplicate_tab_gets_a_fresh_persistent_id() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const original = createMockTab(window);
  const duplicate = createMockTab(window);
  putTabJSON(mockStore, original, "data-persistent-id", "dup-guid");
  putTabJSON(mockStore, duplicate, "data-persistent-id", "dup-guid");

  TreeTabsStore.onTabRestoring(duplicate);

  const duplicateGuid = getTabJSON(mockStore, duplicate, "data-persistent-id");
  Assert.equal(typeof duplicateGuid, "string", "Duplicate has a persistent id");
  Assert.notEqual(
    duplicateGuid,
    "dup-guid",
    "Duplicate no longer shares the original's id"
  );
  Assert.equal(
    getTabJSON(mockStore, original, "data-persistent-id"),
    "dup-guid",
    "The original keeps its id"
  );
});

add_task(function test_references_resolve_by_persistent_id_for_lazy_tabs() {
  setupStore();
  const window = createMockWindow();
  const parent = createMockTab(window);
  // An empty linkedPanel simulates a lazy tab.
  parent.linkedPanel = "";
  const child = createMockTab(window);

  TreeTabsService.attachTab(child, parent);
  TreeTabsStore.saveTabState(child);
  TreeTabsService.detachTab(child);

  TreeTabsStore.onTabRestoring(child);
  TreeTabsStore.onTabRestored(child);
  Assert.equal(
    TreeTabsService.getParent(child),
    parent,
    "Ancestor reference resolves through the persistent id"
  );
});

add_task(function test_external_restore_refreshes_all_tab_references() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const surroundingParent = createMockTab(window);
  const importedRoot = createMockTab(window);
  const importedChild = createMockTab(window);

  TreeTabsStore.saveTabState(surroundingParent);
  TreeTabsService.attachTab(importedRoot, surroundingParent);
  TreeTabsService.attachTab(importedChild, importedRoot);
  TreeTabsStore.ensureRestoreGuard(window);
  resetWrites(mockStore);

  TreeTabsStore.completeExternalRestore(window);

  const savedChildren = getTabJSON(mockStore, surroundingParent, "children");
  Assert.equal(savedChildren.length, 1, "The surrounding parent is refreshed");
  Assert.equal(
    savedChildren[0].uniqueId,
    getTabJSON(mockStore, importedRoot, "data-persistent-id"),
    "The surrounding parent references the imported root"
  );
  Assert.ok(
    !TreeTabsStore._restoringWindows.has(window),
    "The external restore guard is cleared"
  );
  Assert.deepEqual(
    getWindowJSON(mockStore, window, "tree-structure").map(
      entry => entry.parent
    ),
    [null, 0, 1],
    "The complete imported structure is persisted"
  );
});

add_task(function test_partial_closed_set_restore_clears_consumed_set_id() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tab = createMockTab(window);
  const guid = "partial-restore-guid";
  const setId = "partial-restore-set";
  putTabJSON(mockStore, tab, "data-persistent-id", guid);
  putTabJSON(mockStore, tab, "closed-tree-set-id", setId);

  const restore = {
    requestedTab: tab,
    snapshot: {
      id: setId,
      entries: [{ guid, collapsed: false }],
      beforeGuid: null,
      afterGuid: null,
    },
  };
  TreeTabsStore._pendingClosedTreeRestores.set(window, restore);

  TreeTabsStore._restoreClosedTreeSet(window, restore);

  Assert.equal(
    getTabJSON(mockStore, tab, "closed-tree-set-id"),
    null,
    "A consumed closed-set id is removed after partial recovery"
  );
  Assert.ok(
    !TreeTabsStore._pendingClosedTreeRestores.has(window),
    "The partial restore transaction is finished"
  );
});
