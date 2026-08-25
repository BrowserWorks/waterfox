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

add_task(
  function test_window_restore_waits_for_final_extdata_and_lazy_groups() {
    const mockStore = setupStore();
    const window = createMockWindow();
    const tabs = Array.from({ length: 4 }, () => createMockTab(window));
    const [outside, outsideChild, grouped, groupedChild] = tabs;
    const structure = tabs.map((tab, index) => ({
      id: `restored-${index}`,
      parent: index % 2 ? index - 1 : null,
      collapsed: index == 2,
    }));

    putTabJSON(mockStore, outside, "data-persistent-id", "old-id");
    TreeTabsStore.getTabGuid(outside);
    TreeTabsStore._manualRestoreCompleted.add(window);
    TreeTabsStore.onWindowRestoring(window);
    putWindowJSON(mockStore, window, "tree-structure", structure);
    for (let index = 0; index < tabs.length; index++) {
      putTabJSON(
        mockStore,
        tabs[index],
        "data-persistent-id",
        structure[index].id
      );
    }
    grouped.group = {};
    resetWrites(mockStore);

    Assert.ok(
      !TreeTabsStore.tryManualRestore(window),
      "TabOpen-time attempts cannot complete an in-progress window restore"
    );
    TreeTabsStore.clearRestoreGuard(window);
    TreeTabsStore.saveTabState(outsideChild, { force: true });
    TreeTabsStore.saveWindowStructure(window);
    Assert.equal(mockStore._writes.tab.length, 0, "Even forced saves wait");
    Assert.equal(
      mockStore._writes.window.length,
      0,
      "Window data stays intact"
    );

    groupedChild.group = grouped.group;
    TreeTabsStore.onWindowRestored(window);
    Assert.equal(TreeTabsService.getParent(outsideChild), outside);
    Assert.equal(TreeTabsService.getParent(groupedChild), grouped);
    Assert.ok(TreeTabsService.isCollapsed(grouped));
    Assert.equal(TreeTabsStore.getTabGuid(outside), "restored-0");
    Assert.ok(!TreeTabsStore.isRestorePending(window));
    Assert.deepEqual(
      getWindowJSON(mockStore, window, "tree-structure"),
      structure,
      "Restore reads the incoming structure without rewriting it"
    );
  }
);

add_task(function test_window_restore_merges_extra_lazy_tree() {
  for (const referenceKey of ["ancestors", "children"]) {
    const mockStore = setupStore();
    const window = createMockWindow();
    const tabs = Array.from({ length: 4 }, (_, index) =>
      createStoredTab(mockStore, window, `extra-${index}`, { lazy: true })
    );
    const [parent, child, extraParent, extraChild] = tabs;
    const structure = [
      { id: "extra-0", parent: null, collapsed: false },
      { id: "extra-1", parent: 0, collapsed: false },
    ];
    putWindowJSON(mockStore, window, "tree-structure", structure);
    putTabJSON(mockStore, extraParent, "ancestors", []);
    putTreeLink(mockStore, extraParent, extraChild, referenceKey);
    putTabJSON(mockStore, extraParent, "special-tab-states", [
      "subtree-collapsed",
    ]);
    const savedData = getStoredData(mockStore);

    TreeTabsStore.onWindowRestoring(window);
    TreeTabsStore.onWindowRestored(window);
    Assert.equal(TreeTabsService.getParent(child), parent);
    Assert.equal(
      TreeTabsService.getParent(extraChild),
      extraParent,
      `Extra lazy tabs restore from ${referenceKey} without activation`
    );
    Assert.ok(TreeTabsService.isCollapsed(extraParent));
    Assert.ok(!TreeTabsStore.isRestorePending(window));
    Assert.ok(TreeTabsStore._manualRestoreCompleted.has(window));
    Assert.deepEqual(
      getStoredData(mockStore),
      savedData,
      "Merging metadata does not rewrite persisted tab or window data"
    );

    TreeTabsStore.onTreeEvent("tree-tabs-structure-changed", { window });
    const pending = TreeTabsStore._pendingSaves.get(window);
    Assert.ok(pending, "A completed merge permits the full-window save");
    clearTimeout(pending.timerId);
    TreeTabsStore._flushWindowSave(window);
    Assert.deepEqual(
      getWindowJSON(mockStore, window, "tree-structure").map(
        entry => entry.parent
      ),
      [null, 0, null, 2],
      "The first full-window save includes both restored trees"
    );
    Assert.equal(
      getTabJSON(mockStore, extraChild, "ancestors")[0].uniqueId,
      "extra-2"
    );
    Assert.equal(
      getTabJSON(mockStore, extraParent, "children")[0].uniqueId,
      "extra-3"
    );
    TreeTabsStore.onTabRestoring(extraChild);
    TreeTabsStore.onTabRestored(extraChild);
    Assert.equal(
      TreeTabsService.getParent(extraChild),
      extraParent,
      "Later lazy activation retains the merged relationship"
    );
  }
});

add_task(function test_window_restore_merges_cross_snapshot_metadata() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tabs = [
    "extra-parent",
    "extra-ancestor",
    "extra-child",
    "covered-root",
    "covered-child",
    "other-root",
  ].map(id => createStoredTab(mockStore, window, id, { lazy: true }));
  const [extraParent, byAncestor, byChildren, root, child, otherRoot] = tabs;
  putWindowJSON(mockStore, window, "tree-structure", [
    { id: "covered-root", parent: null, collapsed: true },
    { id: "covered-child", parent: 0, collapsed: false },
    { id: "other-root", parent: null, collapsed: false },
  ]);
  putTabJSON(mockStore, extraParent, "ancestors", []);
  putTabJSON(mockStore, extraParent, "children", [
    "covered-root",
    "covered-child",
    "other-root",
  ]);
  for (const tab of [root, child, otherRoot]) {
    putTabJSON(mockStore, tab, "ancestors", ["extra-parent"]);
  }
  putTabJSON(mockStore, root, "children", [
    "covered-child",
    "other-root",
    "extra-child",
  ]);
  putTabJSON(mockStore, root, "special-tab-states", []);
  putTabJSON(mockStore, child, "special-tab-states", ["subtree-collapsed"]);
  putTabJSON(mockStore, byAncestor, "ancestors", ["covered-child"]);
  TreeTabsService.attachTab(root, extraParent);
  TreeTabsService.collapseSubtree(child);

  TreeTabsStore.onWindowRestoring(window);
  TreeTabsStore.onWindowRestored(window);
  Assert.equal(TreeTabsService.getParent(root), null, "Snapshot root wins");
  Assert.equal(
    TreeTabsService.getParent(child),
    root,
    "Snapshot ancestry wins over conflicting tab metadata"
  );
  Assert.equal(
    TreeTabsService.getParent(otherRoot),
    null,
    "Neither covered nor extra parents can reclaim a snapshot root"
  );
  Assert.equal(TreeTabsService.getParent(extraParent), null);
  Assert.equal(
    TreeTabsService.getParent(byAncestor),
    child,
    "An extra tab can name a snapshot-covered ancestor"
  );
  Assert.equal(
    TreeTabsService.getParent(byChildren),
    root,
    "A covered parent's children-only reference restores an extra tab"
  );
  Assert.ok(TreeTabsService.isCollapsed(root), "Snapshot collapse wins");
  Assert.ok(!TreeTabsService.isCollapsed(child), "Snapshot expansion wins");
  Assert.ok(
    !TreeTabsStore.isRestorePending(window),
    "Superseded metadata for covered tabs does not block completion"
  );

  for (const tab of tabs) {
    TreeTabsStore.saveTabState(tab);
  }
  TreeTabsStore.saveWindowStructure(window);
  Assert.deepEqual(getTabJSON(mockStore, root, "ancestors"), []);
  Assert.deepEqual(getTabJSON(mockStore, otherRoot, "ancestors"), []);
  Assert.deepEqual(getTabJSON(mockStore, extraParent, "children"), []);
  for (const [tab, parentGuid] of [
    [child, "covered-root"],
    [byAncestor, "covered-child"],
    [byChildren, "covered-root"],
  ]) {
    Assert.equal(
      getTabJSON(mockStore, tab, "ancestors")[0].uniqueId,
      parentGuid
    );
  }
});

add_task(function test_window_restore_guards_incomplete_extra_metadata() {
  for (const parentCoverage of ["covered", "extra"]) {
    for (const referenceKey of ["ancestors", "children"]) {
      const mockStore = setupStore();
      const window = createMockWindow();
      const tabs = Array.from({ length: 4 }, (_, index) =>
        createStoredTab(mockStore, window, `guarded-${index}`)
      );
      const [parent, child, extraParent, extraChild] = tabs;
      const metadataParent = parentCoverage == "covered" ? parent : extraParent;
      const parentIndex = tabs.indexOf(metadataParent);
      const structure = [
        { id: "guarded-0", parent: null },
        { id: "guarded-1", parent: 0 },
      ];
      putWindowJSON(mockStore, window, "tree-structure", structure);
      putTabJSON(mockStore, extraParent, "ancestors", []);
      putTreeLink(mockStore, metadataParent, extraChild, referenceKey);
      const savedData = getStoredData(mockStore);
      extraChild.group = {};

      TreeTabsStore.onWindowRestoring(window);
      TreeTabsStore.onWindowRestored(window);
      Assert.equal(TreeTabsService.getParent(child), parent);
      Assert.equal(TreeTabsService.getParent(extraChild), null);
      Assert.ok(
        TreeTabsStore.isRestorePending(window),
        `Unapplied ${referenceKey} for a ${parentCoverage} parent stays pending`
      );
      Assert.ok(!TreeTabsStore._manualRestoreCompleted.has(window));
      TreeTabsStore.clearRestoreGuard(window);
      assertSavesBlocked(mockStore, window, savedData);

      extraChild.group = metadataParent.group;
      Assert.ok(
        TreeTabsStore.tryManualRestore(window),
        "A manual retry merges extra metadata before completing restoration"
      );
      Assert.equal(TreeTabsService.getParent(extraChild), metadataParent);
      Assert.ok(!TreeTabsStore.isRestorePending(window));
      TreeTabsStore.saveTabState(extraChild, { force: true });
      TreeTabsStore.saveWindowStructure(window);
      Assert.equal(
        getTabJSON(mockStore, extraChild, "ancestors")[0].uniqueId,
        `guarded-${parentIndex}`
      );
      Assert.equal(
        getWindowJSON(mockStore, window, "tree-structure")[3].parent,
        parentIndex,
        "The recovered extra relationship can now be persisted"
      );
    }
  }
});

add_task(function test_idless_window_snapshot_fallback_completion() {
  for (const recovery of ["complete", "flat", "partial"]) {
    const referenceKeys =
      recovery == "flat" ? [null] : ["ancestors", "children"];
    for (const referenceKey of referenceKeys) {
      info(`ID-less snapshot: ${recovery}, references=${referenceKey}`);
      const mockStore = setupStore();
      const window = createMockWindow();
      const tabs = Array.from({ length: 4 }, (_, index) =>
        createStoredTab(mockStore, window, `idless-${index}`, {
          lazy: true,
          legacy: true,
        })
      );
      const [child, parent, otherParent, otherChild] = tabs;
      const structure = Array.from({ length: 5 }, (_, index) => ({
        parent: index % 2 ? index - 1 : -1,
        collapsed: false,
      }));
      putWindowJSON(mockStore, window, "tree-structure", structure, {
        legacy: true,
      });
      for (const [parentTab, childTab] of [
        [parent, child],
        [otherParent, otherChild],
      ]) {
        putTabJSON(mockStore, parentTab, "ancestors", [], { legacy: true });
        if (recovery != "flat") {
          putTreeLink(mockStore, parentTab, childTab, referenceKey, {
            legacy: true,
          });
        }
      }
      putTabJSON(
        mockStore,
        parent,
        "special-tab-states",
        ["subtree-collapsed"],
        { legacy: true }
      );
      if (recovery == "partial") {
        otherChild.group = {};
      }
      const savedData = getStoredData(mockStore);

      TreeTabsStore.onWindowRestoring(window);
      TreeTabsStore.onWindowRestored(window);
      Assert.equal(
        TreeTabsService.getParent(child),
        recovery == "flat" ? null : parent,
        "Fallback uses persistent references, not the unmatched legacy positions"
      );
      Assert.equal(
        TreeTabsService.getParent(otherChild),
        recovery == "complete" ? otherParent : null
      );
      Assert.ok(TreeTabsService.isCollapsed(parent));
      Assert.equal(
        TreeTabsStore.isRestorePending(window),
        recovery != "complete"
      );
      Assert.equal(
        TreeTabsStore._manualRestoreCompleted.has(window),
        recovery == "complete"
      );
      Assert.deepEqual(
        TreeTabsStore.loadWindowStructure(window),
        structure,
        "Restoration does not synchronously rewrite the legacy snapshot"
      );

      TreeTabsStore.clearRestoreGuard(window);
      if (recovery == "complete") {
        for (const tab of tabs) {
          TreeTabsStore.saveTabState(tab, { force: true });
        }
        TreeTabsStore.saveWindowStructure(window);
        Assert.ok(mockStore._writes.tab.length, "Forced tab saves resume");
        Assert.deepEqual(
          getWindowJSON(mockStore, window, "tree-structure").map(
            entry => entry.parent
          ),
          [1, null, null, 2],
          "A complete fallback can replace an oversized ID-less snapshot"
        );
      } else {
        assertSavesBlocked(mockStore, window, savedData);
      }
    }
  }
});

add_task(function test_unmatched_window_tree_completes_from_tab_metadata() {
  for (const legacy of [false, true]) {
    const mockStore = setupStore();
    const window = createMockWindow();
    const parent = createStoredTab(mockStore, window, "live-parent", {
      legacy,
    });
    const child = createStoredTab(mockStore, window, "live-child", { legacy });
    const storedStructure = [
      { id: "stale-parent", parent: null },
      { id: "stale-child", parent: 0 },
    ];
    putWindowJSON(mockStore, window, "tree-structure", storedStructure);
    putTabJSON(mockStore, parent, "ancestors", [], { legacy });
    putTabJSON(mockStore, parent, "children", ["live-child"], { legacy });
    putTabJSON(mockStore, parent, "special-tab-states", ["subtree-collapsed"], {
      legacy,
    });
    putTabJSON(mockStore, child, "ancestors", ["live-parent"], { legacy });

    TreeTabsStore.onWindowRestoring(window);
    TreeTabsStore.onWindowRestored(window);
    Assert.equal(TreeTabsService.getParent(child), parent);
    Assert.ok(TreeTabsService.isCollapsed(parent));
    Assert.ok(
      !TreeTabsStore.isRestorePending(window),
      "A complete tab-level fallback releases the unmatched-snapshot guard"
    );
    Assert.ok(TreeTabsStore._manualRestoreCompleted.has(window));
    Assert.deepEqual(
      getWindowJSON(mockStore, window, "tree-structure"),
      storedStructure,
      "Completion does not synchronously overwrite the old snapshot"
    );

    resetWrites(mockStore);
    TreeTabsStore.saveTabState(child, { force: true });
    Assert.ok(mockStore._writes.tab.length, "Forced tab saves resume");
    TreeTabsStore.onTreeEvent("tree-tabs-structure-changed", { window });
    Assert.ok(
      TreeTabsStore._pendingSaves.has(window),
      "Tree events can save again"
    );
    TreeTabsStore._cancelWindowSave(window);
    TreeTabsStore.saveWindowStructure(window);
    Assert.deepEqual(
      getWindowJSON(mockStore, window, "tree-structure").map(entry => entry.id),
      ["live-parent", "live-child"],
      "The recovered live tree can replace the stale identities"
    );
    TreeTabsService.detachTab(child);
    TreeTabsStore.saveWindowStructure(window);
    Assert.deepEqual(
      getWindowJSON(mockStore, window, "tree-structure").map(
        entry => entry.parent
      ),
      [null, null],
      "Subsequent deliberate flattening is persisted"
    );
  }
});

add_task(function test_unmatched_window_tree_guards_incomplete_tab_fallback() {
  for (const referenceKey of [null, "ancestors", "children"]) {
    info(`Unmatched snapshot: ${referenceKey || "flat"} fallback`);
    const mockStore = setupStore();
    const window = createMockWindow();
    const tabs = Array.from({ length: referenceKey ? 4 : 2 }, (_, index) =>
      createStoredTab(mockStore, window, `live-${index}`)
    );
    const structure = tabs.map((tab, index) => ({
      id: `stale-${index}`,
      parent: index % 2 ? index - 1 : null,
    }));
    putWindowJSON(mockStore, window, "tree-structure", structure);
    if (referenceKey) {
      for (const index of [0, 2]) {
        putTreeLink(mockStore, tabs[index], tabs[index + 1], referenceKey);
      }
      tabs[2].group = {};
    }
    const savedData = getStoredData(mockStore);

    TreeTabsStore.onWindowRestoring(window);
    TreeTabsStore.onWindowRestored(window);
    Assert.equal(
      TreeTabsService.getParent(tabs[1]),
      referenceKey ? tabs[0] : null
    );
    if (referenceKey) {
      Assert.equal(TreeTabsService.getParent(tabs[3]), null);
    }
    Assert.ok(TreeTabsStore.isRestorePending(window));
    Assert.ok(!TreeTabsStore._manualRestoreCompleted.has(window));
    TreeTabsStore.clearRestoreGuard(window);
    assertSavesBlocked(mockStore, window, savedData);
  }
});

add_task(function test_empty_window_snapshot_saves_only_complete_metadata() {
  for (const referenceKey of [null, "ancestors", "children"]) {
    info(`Empty snapshot: ${referenceKey || "flat"} metadata`);
    const mockStore = setupStore();
    const window = createMockWindow();
    const parent = createStoredTab(mockStore, window, "empty-parent");
    const child = createStoredTab(mockStore, window, "empty-child");
    const tabs = [parent, child];
    putWindowJSON(mockStore, window, "tree-structure", []);
    if (referenceKey) {
      putTreeLink(mockStore, parent, child, referenceKey);
      child.group = {};
    }
    const savedData = getStoredData(mockStore);

    TreeTabsStore.onWindowRestoring(window);
    TreeTabsStore.onWindowRestored(window);
    Assert.equal(TreeTabsService.getParent(child), null);
    Assert.equal(
      TreeTabsStore.isRestorePending(window),
      !!referenceKey,
      "An empty snapshot needs no parent link unless metadata supplies one"
    );
    Assert.equal(
      TreeTabsStore._manualRestoreCompleted.has(window),
      !referenceKey
    );
    Assert.deepEqual(getWindowJSON(mockStore, window, "tree-structure"), []);

    if (referenceKey) {
      TreeTabsStore.clearRestoreGuard(window);
      assertSavesBlocked(mockStore, window, savedData);
    } else {
      assertTabOrder(TreeTabsService.getRootTabs(window), tabs);
      for (const tab of tabs) {
        TreeTabsStore.saveTabState(tab, { force: true });
      }
      TreeTabsStore.saveWindowStructure(window);
      Assert.ok(mockStore._writes.tab.length, "Forced tab saves are allowed");
      Assert.deepEqual(
        getWindowJSON(mockStore, window, "tree-structure").map(
          entry => entry.parent
        ),
        [null, null],
        "The flat window can be persisted without waiting for another restore"
      );
    }
  }
});

add_task(function test_restore_completion_checks_snapshot_links() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const child = createStoredTab(mockStore, window, "checked-child");
  const parent = createStoredTab(mockStore, window, "checked-parent");
  const otherRoot = createStoredTab(mockStore, window, "checked-root");
  const tabs = [child, parent, otherRoot];
  putTabJSON(mockStore, child, "ancestors", ["checked-root"]);
  putTabJSON(mockStore, parent, "ancestors", ["checked-child"]);
  const structure = [
    { id: "checked-parent", parent: null },
    { id: "checked-child", parent: 0 },
    { id: "checked-root", parent: -1 },
  ];
  const resolved = TreeTabsStore._resolveStructureTabs(tabs, structure);
  const structureEntries = new Map(
    resolved.map(({ entry, tab }) => [tab, entry])
  );
  const state = TreeTabsStore._getWindowState(window, { create: true });
  state.structure = structure;
  for (const tab of tabs) {
    TreeTabsStore._recordTabRestoreState(
      window,
      tab,
      TreeTabsStore.loadTabState(tab)
    );
  }
  TreeTabsService.init(window);
  const isComplete = () =>
    TreeTabsStore._hasCompleteTabRestore(window, state, tabs, {
      structureEntries,
      resolved,
      requireRestoredLink: false,
    });

  Assert.ok(!isComplete(), "Covered non-root entries cannot remain flat");
  TreeTabsService.attachTab(child, parent);
  const counts = countGuidRestoreWork(() => {
    Assert.ok(
      isComplete(),
      "Resolved snapshot parents and roots override stale tab ancestors"
    );
  });
  Assert.deepEqual(
    counts,
    { windowEnumerations: 0, guidLookups: 0, persistentIDReads: 0 },
    "Completion reuses the resolved snapshot mapping without additional work"
  );

  TreeTabsService.attachTab(child, otherRoot);
  Assert.ok(
    !isComplete(),
    "A different live parent does not satisfy the snapshot"
  );
  TreeTabsService.attachTab(child, parent);
  TreeTabsService.attachTab(parent, otherRoot);
  Assert.ok(!isComplete(), "An explicit snapshot root must remain a root");
  TreeTabsService.detachTab(parent);
  TreeTabsService.attachTab(otherRoot, parent);
  Assert.ok(!isComplete(), "Legacy -1 root entries are also verified");
  TreeTabsService.detachTab(otherRoot);

  child.group = {};
  Assert.equal(TreeTabsService.getParent(child), parent);
  Assert.ok(
    !isComplete(),
    "An existing link across native groups is not a complete snapshot restore"
  );
  child.group = parent.group;
  Assert.ok(
    isComplete(),
    "Completion succeeds once all snapshot links are valid"
  );
});

add_task(function test_window_restore_guards_blocked_snapshot_links() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tabs = Array.from({ length: 4 }, (_, index) =>
    createStoredTab(mockStore, window, `blocked-${index}`)
  );
  for (const tab of tabs) {
    putTabJSON(mockStore, tab, "ancestors", []);
  }
  const structure = tabs.map((tab, index) => ({
    id: `blocked-${index}`,
    parent: index % 2 ? index - 1 : null,
  }));
  putWindowJSON(mockStore, window, "tree-structure", structure);
  const savedData = getStoredData(mockStore);
  tabs[3].group = {};

  TreeTabsStore.onWindowRestoring(window);
  TreeTabsStore.onWindowRestored(window);
  Assert.equal(TreeTabsService.getParent(tabs[1]), tabs[0]);
  Assert.equal(TreeTabsService.getParent(tabs[3]), null);
  Assert.ok(TreeTabsStore.isRestorePending(window));
  Assert.ok(!TreeTabsStore._manualRestoreCompleted.has(window));
  TreeTabsStore.clearRestoreGuard(window);
  assertSavesBlocked(mockStore, window, savedData);

  tabs[3].group = tabs[2].group;
  Assert.ok(TreeTabsStore.tryManualRestore(window));
  Assert.equal(TreeTabsService.getParent(tabs[3]), tabs[2]);
  Assert.ok(!TreeTabsStore.isRestorePending(window));
  for (const tab of tabs) {
    TreeTabsStore.saveTabState(tab, { force: true });
  }
  TreeTabsStore.saveWindowStructure(window);
  Assert.equal(
    getTabJSON(mockStore, tabs[3], "ancestors")[0].uniqueId,
    "blocked-2",
    "Saves resume only after the covered relationship has been restored"
  );
});

add_task(function test_flat_window_restore_normalizes_guids_once() {
  for (const count of [64, 128]) {
    const mockStore = setupStore();
    const window = createMockWindow();
    const tabs = Array.from({ length: count }, (_, index) =>
      createStoredTab(mockStore, window, `flat-${index}`)
    );
    TreeTabsStore.onWindowRestoring(window);
    const counts = countGuidRestoreWork(() =>
      TreeTabsStore.onWindowRestored(window)
    );
    info(`flat-window-restore ${JSON.stringify({ tabs: count, ...counts })}`);
    Assert.lessOrEqual(
      counts.persistentIDReads,
      3 * count,
      "Bulk restoration reads each persistent ID a bounded number of times"
    );
    assertTabOrder(
      TreeTabsService.getRootTabs(window),
      tabs,
      "All normalized tabs remain roots"
    );
    for (let index = 0; index < count; index++) {
      Assert.equal(
        TreeTabsStore.getTabGuid(tabs[index]),
        `flat-${index}`,
        "Bulk loading preserves each unique ID"
      );
    }
  }
});

add_task(function test_window_restore_registers_tabs_without_tree_metadata() {
  setupStore();
  const window = createMockWindow();
  createMockTab(window);
  TreeTabsStore.onWindowRestoring(window);
  window.gBrowser.tabs = [];
  const tabs = Array.from({ length: 3 }, () => createMockTab(window));
  for (const tab of tabs) {
    tab.linkedPanel = "";
  }
  tabs[1].hidden = true;
  TreeTabsStore.onWindowRestored(window);
  assertTabOrder(
    TreeTabsService.getRootTabs(window),
    tabs,
    "Restored tabs with no Waterfox metadata all enter the model as roots"
  );
  Assert.ok(tabs[1].hidden, "The store does not unhide extension-hidden tabs");
});

add_task(function test_partial_group_restore_preserves_all_saved_extdata() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const tabs = Array.from({ length: 4 }, (_, index) =>
    createStoredTab(mockStore, window, `partial-${index}`)
  );
  const structure = tabs.map((tab, index) => ({
    id: `partial-${index}`,
    parent: index % 2 ? index - 1 : null,
    collapsed: index == 2,
  }));
  for (let index = 0; index < tabs.length; index++) {
    putTabJSON(
      mockStore,
      tabs[index],
      "ancestors",
      index % 2 ? [structure[index - 1].id] : []
    );
  }
  putWindowJSON(mockStore, window, "tree-structure", structure);
  const savedData = getStoredData(mockStore);
  tabs[2].group = {};

  Assert.ok(!TreeTabsStore.tryManualRestore(window), "Partial is not complete");
  Assert.equal(TreeTabsService.getParent(tabs[1]), tabs[0]);
  Assert.equal(TreeTabsService.getParent(tabs[3]), null);
  Assert.ok(!TreeTabsStore._manualRestoreCompleted.has(window));
  TreeTabsStore.clearRestoreGuard(window);
  assertSavesBlocked(mockStore, window, savedData);

  tabs[3].group = tabs[2].group;
  Assert.ok(
    TreeTabsStore.tryManualRestore(window),
    "Retry restores both branches"
  );
  Assert.equal(TreeTabsService.getParent(tabs[3]), tabs[2]);
  Assert.ok(TreeTabsService.isCollapsed(tabs[2]));
  Assert.ok(!TreeTabsStore.isRestorePending(window));
});

add_task(function test_window_restore_reads_legacy_data_for_unactivated_tabs() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const child = createStoredTab(mockStore, window, null, { lazy: true });
  const unrelated = createMockTab(window);
  const parent = createStoredTab(
    mockStore,
    window,
    { id: "1legacy-parent" },
    { lazy: true, legacy: true }
  );
  putTabJSON(mockStore, child, "ancestors", ["1legacy-parent"], {
    legacy: true,
  });
  putTabJSON(mockStore, parent, "special-tab-states", ["subtree-collapsed"], {
    legacy: true,
  });

  TreeTabsStore.onWindowRestoring(window);
  TreeTabsStore.onWindowRestored(window);
  Assert.equal(
    TreeTabsService.getParent(child),
    parent,
    "Persistent ids starting with digits are not treated as strip indices"
  );
  Assert.equal(TreeTabsService.getParent(unrelated), null);
  Assert.ok(
    TreeTabsService.isCollapsed(parent),
    "Lazy legacy collapse is restored"
  );
});

add_task(function test_tab_restore_resolves_structure_by_id_not_position() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const child = createStoredTab(mockStore, window, "child-guid");
  const unrelated = createMockTab(window);
  const parent = createStoredTab(mockStore, window, "parent-guid");
  const state = TreeTabsStore._getWindowState(window, { create: true });
  state.structure = [
    { id: "parent-guid", parent: null },
    { id: "child-guid", parent: 0 },
  ];
  TreeTabsStore.onTabRestored(child);
  Assert.equal(TreeTabsService.getParent(child), parent);
  Assert.equal(TreeTabsService.getParent(unrelated), null);
});

add_task(function test_persistent_reference_wins_over_reused_panel_id() {
  const mockStore = setupStore();
  const window = createMockWindow();
  const unrelated = createMockTab(window);
  const parent = createStoredTab(mockStore, window, "parent-guid");
  Assert.equal(
    TreeTabsStore._findTabByReference(window, {
      id: unrelated.linkedPanel,
      uniqueId: "parent-guid",
    }),
    parent,
    "A previous session's panel id cannot override the persistent id"
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

add_task(function test_horizontal_duplicate_drops_only_copied_tree_links() {
  const mockStore = setupStore();
  const window = createMockWindow();
  window.gBrowser.tabContainer = { verticalMode: false };
  const parent = createMockTab(window);
  const original = createMockTab(window);
  const descendant = createMockTab(window);
  TreeTabsService.attachTab(original, parent);
  TreeTabsService.attachTab(descendant, original);
  TreeTabsStore.saveWindowStructure(window);
  TreeTabsStore.saveTabState(original);
  const originalData = [...mockStore._tabValues.get(original)];
  const originalGuid = TreeTabsStore.getTabGuid(original);
  const duplicate = createMockTab(window);
  mockStore._tabValues.set(duplicate, new Map(originalData));
  TreeTabsService.onTabOpened(duplicate, { opener: original, duplicate: true });
  TreeTabsService.detachTab(descendant);

  TreeTabsStore.onTabRestoring(duplicate);
  TreeTabsStore.onTabRestored(duplicate);
  Assert.notEqual(TreeTabsStore.getTabGuid(duplicate), originalGuid);
  Assert.equal(TreeTabsService.getParent(duplicate), null);
  Assert.deepEqual(TreeTabsService.getChildren(duplicate), []);
  Assert.equal(
    TreeTabsService.getParent(descendant),
    null,
    "A horizontal duplicate cannot reclaim children from copied metadata"
  );
  Assert.deepEqual(getTabJSON(mockStore, duplicate, "ancestors"), []);
  Assert.deepEqual(getTabJSON(mockStore, duplicate, "children"), []);
  Assert.deepEqual(
    [...mockStore._tabValues.get(original)],
    originalData,
    "The original tab's metadata is untouched"
  );
  Assert.equal(TreeTabsService.getParent(original), parent);

  window.gBrowser.tabContainer.verticalMode = true;
  TreeTabsStore.onTabRestoring(duplicate);
  TreeTabsStore.onTabRestored(duplicate);
  Assert.equal(
    TreeTabsService.getParent(duplicate),
    null,
    "A later restore cannot resurrect the duplicate's copied ancestry"
  );
});

add_task(function test_horizontal_undo_and_window_restore_keep_saved_links() {
  for (const mode of ["undo", "window", "disabled"]) {
    const mockStore = setupStore({ enabled: mode != "disabled" });
    const window = createMockWindow();
    window.gBrowser.tabContainer = { verticalMode: false };
    const parent = createStoredTab(mockStore, window, "parent-guid");
    const original = createStoredTab(mockStore, window, "copied-guid");
    original.closing = mode == "undo";
    const restored = createStoredTab(mockStore, window, "copied-guid");
    putTabJSON(mockStore, restored, "ancestors", ["parent-guid"]);
    if (mode == "window") {
      TreeTabsStore.onWindowRestoring(window);
    }
    TreeTabsStore.onTabRestoring(restored);
    Assert.deepEqual(
      getTabJSON(mockStore, restored, "ancestors"),
      ["parent-guid"],
      `${mode} is not treated as a horizontal duplicate`
    );
    if (mode == "window") {
      TreeTabsStore.onWindowRestored(window);
    } else if (mode == "undo") {
      Assert.equal(TreeTabsStore.getTabGuid(restored), "copied-guid");
      TreeTabsStore.onTabRestored(restored);
    } else {
      Services.prefs.setBoolPref(TREE_PREF_ENABLED, true);
      TreeTabsStore.onTabRestoring(restored);
      TreeTabsStore.onTabRestored(restored);
    }
    Assert.equal(TreeTabsService.getParent(restored), parent, mode);
  }
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
