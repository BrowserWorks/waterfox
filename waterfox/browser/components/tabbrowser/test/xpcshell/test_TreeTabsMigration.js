/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TreeTabsMigration } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsMigration.sys.mjs"
);
const { maybeMigrate, readTabKey, writeTabKey } = TreeTabsMigration;

function withMockedSessionStore(overrides, callback) {
  const mockSessionStore = {
    getCustomTabValue() {
      return null;
    },
    getCustomWindowValue() {
      return null;
    },
    setCustomTabValue() {},
    setCustomWindowValue() {},
    ...overrides,
  };
  TreeTabsMigration._setSessionStoreForTests(mockSessionStore);

  try {
    return callback();
  } finally {
    TreeTabsMigration._setSessionStoreForTests(null);
  }
}

registerCleanupFunction(() => {
  TreeTabsMigration._setSessionStoreForTests(null);
  resetTreeMigrationTestPrefs();
});

add_task(function test_read_tab_key_prefers_native_namespace() {
  resetTreeMigrationTestPrefs();

  const queriedKeys = [];
  const tab = {};

  const value = withMockedSessionStore(
    {
      getCustomTabValue(_tab, key) {
        queriedKeys.push(key);
        if (key === "treeTabs:children") {
          return "native-value";
        }
        return "legacy-value";
      },
    },
    () => readTabKey(tab, "children")
  );

  Assert.equal(value, "native-value", "Native namespace is preferred");
  Assert.deepEqual(
    queriedKeys,
    ["treeTabs:children"],
    "Legacy key is not read when native value exists"
  );
});

add_task(function test_read_tab_key_falls_back_to_extension_namespace() {
  resetTreeMigrationTestPrefs();

  const queriedKeys = [];
  const tab = {};

  const value = withMockedSessionStore(
    {
      getCustomTabValue(_tab, key) {
        queriedKeys.push(key);
        if (key === "treeTabs:children") {
          return null;
        }
        if (key === "extension:sidebar@waterfox.net:children") {
          return "legacy-value";
        }
        return null;
      },
    },
    () => readTabKey(tab, "children")
  );

  Assert.equal(value, "legacy-value", "Legacy namespace is used as fallback");
  Assert.deepEqual(
    queriedKeys,
    ["treeTabs:children", "extension:sidebar@waterfox.net:children"],
    "Native namespace is checked first, then legacy"
  );
});

add_task(
  function test_external_tst_data_is_not_merged_with_native_or_bundled_data() {
    const externalPrefix = "extension:treestyletab@piro.sakura.ne.jp:";
    const values = new Map([
      [`${externalPrefix}ancestors`, '["external-parent"]'],
      [`${externalPrefix}tree-structure`, '[{"parent":-1},{"parent":0}]'],
    ]);
    const writes = [];
    withMockedSessionStore(
      {
        getCustomTabValue: (tab, key) => values.get(key),
        getCustomWindowValue: (window, key) => values.get(key),
        setCustomTabValue: (tab, key, value) => writes.push({ key, value }),
      },
      () => {
        Assert.equal(
          readTabKey({}, "ancestors"),
          null,
          "An independent extension's tree is not an implicit import source"
        );
        Assert.equal(
          TreeTabsMigration.readWindowKey({}, "tree-structure"),
          null
        );
        values.set(
          "extension:sidebar@waterfox.net:ancestors",
          '["bundled-parent"]'
        );
        Assert.equal(readTabKey({}, "ancestors"), '["bundled-parent"]');
        values.set("treeTabs:ancestors", "[]");
        Assert.equal(
          readTabKey({}, "ancestors"),
          "[]",
          "A deliberately detached native root does not fall back to an old tree"
        );
        writeTabKey({}, "ancestors", "[]");
        Assert.deepEqual(writes, [{ key: "treeTabs:ancestors", value: "[]" }]);
        Assert.equal(
          values.get(`${externalPrefix}ancestors`),
          '["external-parent"]',
          "External extension metadata stays untouched"
        );
      }
    );
  }
);

add_task(function test_write_tab_key_uses_native_namespace() {
  resetTreeMigrationTestPrefs();

  const writes = [];
  withMockedSessionStore(
    {
      setCustomTabValue(tab, key, value) {
        writes.push({ tab, key, value });
      },
    },
    () => {
      const tab = {};
      writeTabKey(tab, "ancestors", "[1,2]");
    }
  );

  Assert.equal(writes.length, 1, "Exactly one write is attempted");
  Assert.equal(
    writes[0].key,
    "treeTabs:ancestors",
    "Writes to native key namespace"
  );
  Assert.equal(writes[0].value, "[1,2]", "Original value is written unchanged");
});

add_task(function test_migrate_prefs_copies_known_old_values() {
  resetTreeMigrationTestPrefs();

  Services.prefs.setBoolPref(OLD_TREE_PREF_AUTO_COLLAPSE_ON_SELECT, true);
  Services.prefs.setBoolPref(OLD_TREE_PREF_AUTO_COLLAPSE_ON_ATTACH, false);
  Services.prefs.setIntPref(OLD_TREE_PREF_SUCCESSOR_CONTROL, 2);
  Services.prefs.setIntPref(OLD_TREE_PREF_DOUBLE_CLICK_BEHAVIOR, 1);
  Services.prefs.setBoolPref(OLD_TREE_PREF_STICKY_ACTIVE_TAB, true);
  Services.prefs.setIntPref(OLD_TREE_PREF_CLOSE_PARENT_BEHAVIOR, 3);
  Services.prefs.setIntPref(OLD_TREE_PREF_MAX_DEPTH, 8);
  Services.prefs.setStringPref(OLD_TREE_PREF_AUTO_ATTACH, "6");

  maybeMigrate();

  Assert.equal(
    Services.prefs.getBoolPref(
      "browser.tabs.verticalTabs.tree.autoCollapse.onSelect"
    ),
    true,
    "autoCollapse.onSelect migrated"
  );
  Assert.equal(
    Services.prefs.getBoolPref(
      "browser.tabs.verticalTabs.tree.autoExpand.onAttach"
    ),
    false,
    "autoExpand.onAttach migrated"
  );
  Assert.equal(
    Services.prefs.prefHasUserValue(
      "browser.tabs.verticalTabs.tree.successorControl"
    ),
    false,
    "successorControl is not carried over"
  );
  Assert.equal(
    Services.prefs.getIntPref(
      "browser.tabs.verticalTabs.tree.doubleClickBehavior"
    ),
    1,
    "doubleClickBehavior migrated"
  );
  Assert.equal(
    Services.prefs.getBoolPref(
      "browser.tabs.verticalTabs.tree.sticky.activeTab"
    ),
    true,
    "sticky.activeTab migrated"
  );
  Assert.equal(
    Services.prefs.getIntPref(
      "browser.tabs.verticalTabs.tree.closeParentBehavior"
    ),
    0,
    "closeParentBehavior old promote-first value maps to 0"
  );
  Assert.equal(
    Services.prefs.getIntPref("browser.tabs.verticalTabs.tree.maxDepth"),
    8,
    "maxDepth migrated"
  );
  Assert.equal(
    Services.prefs.getIntPref(TREE_PREF_AUTO_ATTACH),
    1,
    "autoAttach old value maps to simplified enum"
  );
  Assert.equal(
    Services.prefs.getBoolPref(TREE_MIGRATION_PREF),
    true,
    "Migration guard pref is set"
  );
});

add_task(function test_migrate_prefs_auto_attach_value_map() {
  const mappingCases = [
    { oldValue: "-1", expected: 0 },
    { oldValue: "0", expected: 0 },
    { oldValue: "5", expected: 1 },
    { oldValue: "6", expected: 1 },
    { oldValue: "7", expected: 1 },
    { oldValue: "2", expected: 2 },
    { oldValue: "3", expected: 2 },
  ];

  for (const { oldValue, expected } of mappingCases) {
    resetTreeMigrationTestPrefs();

    Services.prefs.setStringPref(OLD_TREE_PREF_AUTO_ATTACH, oldValue);
    maybeMigrate();

    Assert.equal(
      Services.prefs.getIntPref(TREE_PREF_AUTO_ATTACH),
      expected,
      `Old autoAttach ${oldValue} maps to ${expected}`
    );
  }
});

add_task(function test_migration_runs_only_once() {
  resetTreeMigrationTestPrefs();

  Services.prefs.setBoolPref(OLD_TREE_PREF_AUTO_COLLAPSE_ON_SELECT, true);
  Services.prefs.setBoolPref(TREE_MIGRATION_PREF, true);

  maybeMigrate();

  Assert.equal(
    Services.prefs.prefHasUserValue(
      "browser.tabs.verticalTabs.tree.autoCollapse.onSelect"
    ),
    false,
    "No migration occurs when guard pref is already true"
  );
  Assert.equal(
    Services.prefs.getBoolPref(TREE_MIGRATION_PREF),
    true,
    "Guard pref remains true"
  );
});

add_task(
  function test_missing_old_prefs_are_skipped_without_writing_new_prefs() {
    resetTreeMigrationTestPrefs();

    maybeMigrate();

    for (const prefName of [
      "browser.tabs.verticalTabs.tree.autoCollapse.onSelect",
      "browser.tabs.verticalTabs.tree.autoExpand.onAttach",
      "browser.tabs.verticalTabs.tree.successorControl",
      "browser.tabs.verticalTabs.tree.doubleClickBehavior",
      "browser.tabs.verticalTabs.tree.sticky.activeTab",
      TREE_PREF_AUTO_ATTACH,
      TREE_PREF_CLOSE_PARENT_BEHAVIOR,
      TREE_PREF_MAX_DEPTH,
    ]) {
      Assert.equal(
        Services.prefs.prefHasUserValue(prefName),
        false,
        `No value was written for missing old pref: ${prefName}`
      );
    }

    Assert.equal(
      Services.prefs.getBoolPref(TREE_MIGRATION_PREF),
      true,
      "Migration still records completion"
    );
  }
);
