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
    TreeTabsStore._restoreGuardTimers.clear();
    TreeTabsStore._manualRestoreCompleted = new WeakSet();
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
