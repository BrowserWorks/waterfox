/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
});

let gTestSessionStore = null;

function getSessionStore() {
  return gTestSessionStore || lazy.SessionStore;
}

const MIGRATION_PREF = "browser.tabs.verticalTabs.tree.migrated";
const OLD_EXT_ID = "sidebar@waterfox.net";
const OLD_PREFIX = `extension:${OLD_EXT_ID}:`;
const NEW_PREFIX = "treeTabs:";

function getTabValue(tab, key) {
  const sessionStore = getSessionStore();
  if (!sessionStore) {
    return null;
  }
  try {
    return sessionStore.getCustomTabValue(tab, key);
  } catch (error) {
    return null;
  }
}

function getWindowValue(window, key) {
  const sessionStore = getSessionStore();
  if (!sessionStore) {
    return null;
  }
  try {
    return sessionStore.getCustomWindowValue(window, key);
  } catch (error) {
    return null;
  }
}

function setTabValue(tab, key, value) {
  const sessionStore = getSessionStore();
  if (!sessionStore) {
    return;
  }
  try {
    sessionStore.setCustomTabValue(tab, key, value);
  } catch (error) {
    // Ignore store failures during early startup/shutdown.
  }
}

function setWindowValue(window, key, value) {
  const sessionStore = getSessionStore();
  if (!sessionStore) {
    return;
  }
  try {
    sessionStore.setCustomWindowValue(window, key, value);
  } catch (error) {
    // Ignore store failures during early startup/shutdown.
  }
}

export function maybeMigrate() {
  if (Services.prefs.getBoolPref(MIGRATION_PREF, false)) {
    return;
  }

  migratePrefs();

  Services.prefs.setBoolPref(MIGRATION_PREF, true);
}

export function readTabKey(tab, key) {
  let value = getTabValue(tab, `${NEW_PREFIX}${key}`);
  if (value) {
    return value;
  }

  value = getTabValue(tab, `${OLD_PREFIX}${key}`);
  return value || null;
}

export function readWindowKey(window, key) {
  let value = getWindowValue(window, `${NEW_PREFIX}${key}`);
  if (value) {
    return value;
  }

  value = getWindowValue(window, `${OLD_PREFIX}${key}`);
  return value || null;
}

export function writeTabKey(tab, key, value) {
  setTabValue(tab, `${NEW_PREFIX}${key}`, value);
}

export function writeWindowKey(window, key, value) {
  setWindowValue(window, `${NEW_PREFIX}${key}`, value);
}

function migratePrefs() {
  const prefMap = {
    "browser.sidebar.autoCollapseExpandSubtreeOnSelect": {
      newKey: "browser.tabs.verticalTabs.tree.autoCollapse.onSelect",
      type: "bool",
    },
    "browser.sidebar.autoCollapseExpandSubtreeOnAttach": {
      newKey: "browser.tabs.verticalTabs.tree.autoCollapse.onAttach",
      type: "bool",
    },
    "browser.sidebar.successorTabControlLevel": {
      newKey: "browser.tabs.verticalTabs.tree.successorControl",
      type: "int",
    },
    "browser.sidebar.treeDoubleClickBehavior": {
      newKey: "browser.tabs.verticalTabs.tree.doubleClickBehavior",
      type: "int",
    },
    "browser.sidebar.stickyActiveTab": {
      newKey: "browser.tabs.verticalTabs.tree.sticky.activeTab",
      type: "bool",
    },
    "browser.sidebar.autoAttachOnOpenedWithOwner": {
      newKey: "browser.tabs.verticalTabs.tree.autoAttach",
      type: "int",
      valueMap: { "-1": 0, 0: 0, 5: 1, 6: 1, 7: 1, 2: 2, 3: 2 },
    },
    "browser.sidebar.closeParentBehavior_outsideSidebar_expanded": {
      newKey: "browser.tabs.verticalTabs.tree.closeParentBehavior",
      type: "int",
    },
    "browser.sidebar.maxTreeLevel": {
      newKey: "browser.tabs.verticalTabs.tree.maxDepth",
      type: "int",
    },
  };

  for (const [oldKey, spec] of Object.entries(prefMap)) {
    if (!Services.prefs.prefHasUserValue(oldKey)) {
      continue;
    }

    if (spec.type === "bool") {
      const val = Services.prefs.getBoolPref(oldKey);
      Services.prefs.setBoolPref(spec.newKey, val);
      continue;
    }

    const prefType = Services.prefs.getPrefType(oldKey);
    let raw = "";
    let val;

    if (prefType == Services.prefs.PREF_INT) {
      val = Services.prefs.getIntPref(oldKey);
      raw = String(val);
    } else {
      raw = Services.prefs.getStringPref(oldKey, "");
      val = parseInt(raw, 10);
    }

    if (spec.valueMap) {
      val = spec.valueMap[raw] ?? 0;
    }
    if (!Number.isNaN(val)) {
      Services.prefs.setIntPref(spec.newKey, val);
    }
  }
}

export const TreeTabsMigration = {
  maybeMigrate,
  readTabKey,
  readWindowKey,
  writeTabKey,
  writeWindowKey,
  _setSessionStoreForTests(sessionStore) {
    gTestSessionStore = sessionStore;
  },
};
