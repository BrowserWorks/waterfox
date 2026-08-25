/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  TreeTabsGroups: "resource:///modules/TreeTabsGroups.sys.mjs",
  TreeTabsService: "resource:///modules/TreeTabsService.sys.mjs",
  TreeTabsMigration: "resource:///modules/TreeTabsMigration.sys.mjs",
});

const PREF_ENABLED = "browser.tabs.verticalTabs.tree.enabled";
const WINDOW_KEY = "tree-structure";
const LEGACY_UNIQUE_ID_KEY = "data-persistent-id";
const CLOSED_TREE_SET_ID_KEY = "closed-tree-set-id";
const SAVE_DEBOUNCE_MS = 150;
const RESTORE_GUARD_TIMEOUT_MS = 10000;
const UNDO_PREFS = [
  "browser.sessionstore.max_tabs_undo",
  "browser.sessionstore.max_windows_undo",
];

// These Services.obs topics are app wide.
const OBSERVER_TOPICS = [
  "tree-tabs-attached",
  "tree-tabs-detached",
  "tree-tabs-subtree-collapsed-changed",
  "tree-tabs-structure-changed",
  "sessionstore-closed-objects-changed",
  "browser:purge-session-history",
];

// SessionStore restore notifications are DOM events that bubble to the chrome
// window (SSWindowRestoring/SSWindowRestored fire on the window, the tab events
// fire on the tab and bubble up), so they are wired per window, not through
// Services.obs.
const SS_RESTORE_EVENTS = [
  "SSWindowRestoring",
  "SSTabRestoring",
  "SSTabRestored",
  "SSWindowRestored",
];
const TAB_GUID_EVENTS = ["TabOpen", "TabClose"];

function getBoolPref(name, fallback) {
  try {
    return Services.prefs.getBoolPref(name, fallback);
  } catch (error) {
    return fallback;
  }
}

function parseJSON(value) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function serializeJSON(value) {
  try {
    return JSON.stringify(value);
  } catch (error) {
    return null;
  }
}

function getTabIdentity(tab) {
  // linkedPanel is unavailable for lazy tabs and unstable across sessions;
  // references also carry a persistent ID.
  return tab?.linkedPanel || null;
}

export const TreeTabsStore = {
  _windowStates: new Map(),
  _pendingSaves: new Map(),
  _initialized: false,
  _wiredWindows: new WeakSet(),
  _restoringWindows: new Map(),
  _sessionRestoringWindows: new WeakSet(),
  _pendingWindowRestores: new WeakSet(),
  _manualRestoreCompleted: new WeakSet(),
  _treeRestoredTabs: new WeakSet(),
  _tabGuids: new WeakMap(),
  _activeClosedTreeSets: new Map(),
  _closedTreeSets: new Map(),
  _closedTreeSetPruneTimer: null,
  _pendingClosedTreeRestores: new Map(),
  _frozenCloseTabs: new WeakSet(),
  _restoringClosedTreeSets: new WeakSet(),
  _closedSetRestoringTabs: new WeakSet(),

  init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;
    lazy.TreeTabsMigration.maybeMigrate();
    for (const topic of OBSERVER_TOPICS) {
      Services.obs.addObserver(this, topic);
    }
    for (const pref of UNDO_PREFS) {
      Services.prefs.addObserver(pref, this);
    }

    for (const browserWindow of Services.wm.getEnumerator(
      "navigator:browser"
    )) {
      this.initWindow(browserWindow);
    }
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;
    for (const topic of OBSERVER_TOPICS) {
      Services.obs.removeObserver(this, topic);
    }
    for (const pref of UNDO_PREFS) {
      Services.prefs.removeObserver(pref, this);
    }
    for (const browserWindow of Services.wm.getEnumerator(
      "navigator:browser"
    )) {
      this.uninitWindow(browserWindow);
    }
    this._cancelAllPendingSaves();
    for (const timeoutId of this._restoringWindows.values()) {
      clearTimeout(timeoutId);
    }
    this._windowStates.clear();
    this._tabGuids = new WeakMap();
    this._wiredWindows = new WeakSet();
    this._restoringWindows.clear();
    this._sessionRestoringWindows = new WeakSet();
    this._pendingWindowRestores = new WeakSet();
    this._manualRestoreCompleted = new WeakSet();
    this._treeRestoredTabs = new WeakSet();
    this._purgeClosedTreeSets();
  },

  initWindow(window) {
    if (!window || this._wiredWindows.has(window)) {
      return;
    }
    this._wiredWindows.add(window);
    this.ensureUniqueTabGuids(window);
    // Set a guard before restore starts so stray saves do not clobber the
    // persisted structure. The delayed startup hook can run after the window's
    // own restore has begun, so the timeout and the manual restore path are the
    // real recovery mechanisms.
    this.ensureRestoreGuard(window);
    for (const type of SS_RESTORE_EVENTS) {
      window.addEventListener(type, this, true);
    }
    // SessionStore transfers adopted tabs' extData during capture.
    for (const type of TAB_GUID_EVENTS) {
      window.addEventListener(type, this);
    }
  },

  uninitWindow(window) {
    if (!window || !this._wiredWindows.has(window)) {
      return;
    }
    this._wiredWindows.delete(window);
    for (const type of SS_RESTORE_EVENTS) {
      window.removeEventListener(type, this, true);
    }
    for (const type of TAB_GUID_EVENTS) {
      window.removeEventListener(type, this);
    }
    this._cancelWindowSave(window);
    this.clearRestoreGuard(window);
    this.cancelClosedTreeSet(window);
    this._cancelClosedTreeSetRestore(window);
    for (const tab of this._getWindowTabs(window)) {
      this._treeRestoredTabs.delete(tab);
    }
    this._sessionRestoringWindows.delete(window);
    this._pendingWindowRestores.delete(window);
    this._manualRestoreCompleted.delete(window);
    this._windowStates.delete(window);
  },

  handleEvent(event) {
    const target = event.target;
    switch (event.type) {
      case "SSWindowRestoring":
        this.onWindowRestoring(target);
        break;
      case "SSTabRestoring":
        this.onTabRestoring(target);
        break;
      case "SSTabRestored":
        this.onTabRestored(target);
        break;
      case "SSWindowRestored":
        this.onWindowRestored(target);
        break;
      case "TabOpen":
        if (event.detail?.adoptedTab) {
          this._forgetTabGuid(event.detail.adoptedTab);
        }
        this._forgetTabGuid(target);
        this._getTabGuid(target);
        break;
      case "TabClose":
        this._forgetTabGuid(target);
        if (event.detail?.adoptedBy) {
          const adoptedTab = event.detail.adoptedBy;
          this._forgetTabGuid(adoptedTab);
          this._getTabGuid(adoptedTab);
        }
        break;
      default:
        break;
    }
  },

  observe(subject, topic) {
    const target = subject?.wrappedJSObject ?? subject;
    switch (topic) {
      case "tree-tabs-attached":
      case "tree-tabs-detached":
      case "tree-tabs-subtree-collapsed-changed":
      case "tree-tabs-structure-changed":
        this.onTreeEvent(topic, target);
        break;
      case "sessionstore-closed-objects-changed":
      case "nsPref:changed":
        this._scheduleClosedTreeSetPrune();
        break;
      case "browser:purge-session-history":
        this._purgeClosedTreeSets();
        break;
      default:
        break;
    }
  },

  onTreeEvent(topic, payload) {
    if (!this._isEnabled()) {
      return;
    }

    const tab = payload?.tab || null;
    const parent = payload?.parent || null;
    const previousParent = payload?.previousParent || null;
    const window =
      payload?.window ||
      tab?.documentGlobal ||
      parent?.documentGlobal ||
      previousParent?.documentGlobal ||
      null;

    if (!window) {
      return;
    }
    if (
      this.isRestorePending(window) ||
      this._restoringClosedTreeSets.has(window)
    ) {
      return;
    }

    if (
      topic === "tree-tabs-subtree-collapsed-changed" &&
      tab &&
      (tab.hasAttribute?.("pending") ||
        this._getWindowState(window)?.collapseStates.has(tab) ||
        lazy.SessionStore.isTabRestoring(tab))
    ) {
      this._getWindowState(window, { create: true }).collapseStates.set(
        tab,
        payload.collapsed
      );
    }

    const pending = this._getPendingSave(window, { create: true });
    if (tab) {
      pending.tabs.add(tab);
    }
    if (parent) {
      pending.tabs.add(parent);
    }
    if (previousParent) {
      pending.tabs.add(previousParent);
    }
    if (topic === "tree-tabs-structure-changed") {
      pending.fullWindowSave = true;
    }
    this._scheduleWindowSave(window);
  },

  // Reuse the legacy data-persistent-id so migrated and lazy tabs have a stable
  // identity across sessions.
  _getTabGuid(tab, { create = false, refresh = false } = {}) {
    if (!tab) {
      return null;
    }
    let guid = !refresh && this._tabGuids.get(tab);
    if (guid) {
      return guid;
    }
    guid = this._readLegacyUniqueId(tab);
    if (!guid && create) {
      guid = Services.uuid.generateUUID().toString().slice(1, -1);
      this._writeTabJSON(tab, LEGACY_UNIQUE_ID_KEY, guid);
    }
    this._cacheTabGuid(tab, guid);
    return guid;
  },

  _cacheTabGuid(tab, guid = null) {
    const previousGuid = this._tabGuids.get(tab) || null;
    if (guid) {
      this._tabGuids.set(tab, guid);
    } else {
      this._tabGuids.delete(tab);
    }
    const window = this._getWindowForTab(tab);
    const restoreState = this._getWindowState(window);
    if (previousGuid !== guid) {
      this._treeRestoredTabs.delete(tab);
      if (restoreState) {
        if (restoreState.uniqueIdToTab.get(previousGuid) === tab) {
          restoreState.uniqueIdToTab.delete(previousGuid);
        }
        restoreState.tabData.delete(tab);
        restoreState.collapseStates.delete(tab);
      }
    }
  },

  _forgetTabGuid(tab) {
    this._treeRestoredTabs.delete(tab);
    this._cacheTabGuid(tab, null);
    const state = this._getWindowState(this._getWindowForTab(tab));
    state?.tabData.delete(tab);
    state?.collapseStates.delete(tab);
  },

  getTabGuid(tab, options) {
    return this._getTabGuid(tab, options);
  },

  ensureUniqueTabGuids(window) {
    const seen = new Set();
    for (const tab of this._getWindowTabs(window)) {
      if (
        tab.closing ||
        tab.isConnected === false ||
        this._getWindowForTab(tab) !== window
      ) {
        continue;
      }
      let guid = this._getTabGuid(tab, { refresh: true });
      if (!guid) {
        continue;
      }
      if (seen.has(guid)) {
        guid = Services.uuid.generateUUID().toString().slice(1, -1);
        this._writeTabJSON(tab, LEGACY_UNIQUE_ID_KEY, guid);
        this._cacheTabGuid(tab, guid);
      }
      seen.add(guid);
    }
  },

  completeExternalRestore(window) {
    if (!window) {
      return;
    }
    this.ensureUniqueTabGuids(window);
    this._cancelWindowSave(window);
    this.clearRestoreGuard(window);
    this._manualRestoreCompleted.add(window);
    this._pendingWindowRestores.delete(window);
    for (const tab of this._getWindowTabs(window)) {
      if (!tab.closing) {
        this.saveTabState(tab, { force: true });
      }
    }
    this.saveWindowStructure(window);
  },

  hasActiveClosedTreeSet(window) {
    return this._activeClosedTreeSets.has(window);
  },

  isRestoringClosedTreeSet(window) {
    return this._restoringClosedTreeSets.has(window);
  },

  isTabStateFrozen(tab) {
    return this._frozenCloseTabs.has(tab);
  },

  beginClosedTreeSet(window, tabs) {
    if (!window || this._activeClosedTreeSets.has(window)) {
      return this._activeClosedTreeSets.get(window) || null;
    }

    const members = [...new Set(tabs)]
      .filter(
        tab => tab && !tab.closing && this._getWindowForTab(tab) == window
      )
      .sort(
        (a, b) => this._getTabIndex(window, a) - this._getTabIndex(window, b)
      );
    if (!members.length) {
      return null;
    }

    this.ensureUniqueTabGuids(window);
    const id = Services.uuid.generateUUID().toString().slice(1, -1);
    const memberSet = new Set(members);
    const allTabs = this._getWindowTabs(window);
    const firstIndex = allTabs.indexOf(members[0]);
    const lastIndex = allTabs.indexOf(members.at(-1));
    const before = allTabs
      .slice(0, Math.max(firstIndex, 0))
      .reverse()
      .find(tab => !memberSet.has(tab));
    const after = allTabs.slice(lastIndex + 1).find(tab => !memberSet.has(tab));

    for (const tab of members) {
      this._getTabGuid(tab, { create: true });
      this._writeTabJSON(tab, CLOSED_TREE_SET_ID_KEY, id);
      this.saveTabState(tab, { force: true, ignoreFreeze: true });
      this._frozenCloseTabs.add(tab);
    }

    const entries = members.map(tab => {
      const parent = lazy.TreeTabsService.getParent(tab);
      const siblings = parent
        ? lazy.TreeTabsService.getChildren(parent)
        : lazy.TreeTabsService.getRootTabs(window);
      const siblingIndex = siblings.indexOf(tab);
      let state = null;
      try {
        state = JSON.parse(lazy.SessionStore.getTabState(tab));
      } catch {}
      return {
        guid: this._getTabGuid(tab, { create: true }),
        tab,
        parentGuid: this._getTabGuid(parent, { create: true }),
        insertBeforeGuid: this._getTabGuid(siblings[siblingIndex + 1], {
          create: true,
        }),
        insertAfterGuid: this._getTabGuid(siblings[siblingIndex - 1], {
          create: true,
        }),
        siblingIndex,
        stripIndex: this._getTabIndex(window, tab),
        collapsed: lazy.TreeTabsService.isCollapsed(tab),
        state,
        closedId: null,
      };
    });

    const snapshot = {
      id,
      entries,
      sourceWindow: new WeakRef(window),
      beforeGuid: this._getTabGuid(before, { create: true }),
      afterGuid: this._getTabGuid(after, { create: true }),
    };
    this._activeClosedTreeSets.set(window, snapshot);
    return snapshot;
  },

  _getClosedTabsByGuid(window) {
    let closedTabs = [];
    try {
      closedTabs = lazy.SessionStore.getClosedTabDataForWindow(window);
    } catch {}
    const closedByGuid = new Map();
    for (const closed of closedTabs) {
      const guid = this.readClosedTabGuid(closed);
      if (guid && !closedByGuid.has(guid)) {
        closedByGuid.set(guid, closed);
      }
    }
    return closedByGuid;
  },

  finishClosedTreeSet(window) {
    const snapshot = this._activeClosedTreeSets.get(window);
    if (!snapshot) {
      return null;
    }
    const closedByGuid = this._getClosedTabsByGuid(window);
    snapshot.entries = snapshot.entries.filter(entry => {
      const closed = closedByGuid.get(entry.guid);
      const actuallyClosed = Boolean(closed || entry.tab?.closing);
      this._frozenCloseTabs.delete(entry.tab);
      if (!actuallyClosed && entry.tab) {
        this._deleteTabJSON(entry.tab, CLOSED_TREE_SET_ID_KEY);
      }
      entry.closedId = closed?.closedId ?? null;
      return actuallyClosed;
    });

    if (this._activeClosedTreeSets.get(window) !== snapshot) {
      return null;
    }
    this._activeClosedTreeSets.delete(window);
    for (const entry of snapshot.entries) {
      entry.tab = null;
    }
    if (snapshot.entries.length > 1) {
      this._closedTreeSets.set(snapshot.id, snapshot);
      this._pruneClosedTreeSets();
      return snapshot;
    }
    return null;
  },

  _purgeClosedTreeSets() {
    clearTimeout(this._closedTreeSetPruneTimer);
    this._closedTreeSetPruneTimer = null;
    this._closedTreeSets.clear();
    for (const window of this._activeClosedTreeSets.keys()) {
      this.cancelClosedTreeSet(window);
    }
    for (const window of this._pendingClosedTreeRestores.keys()) {
      this._cancelClosedTreeSetRestore(window);
    }
    this._frozenCloseTabs = new WeakSet();
    this._restoringClosedTreeSets = new WeakSet();
    this._closedSetRestoringTabs = new WeakSet();
  },

  _scheduleClosedTreeSetPrune() {
    if (!this._closedTreeSets.size || this._closedTreeSetPruneTimer != null) {
      return;
    }
    this._closedTreeSetPruneTimer = setTimeout(() => {
      this._closedTreeSetPruneTimer = null;
      this._pruneClosedTreeSets();
    }, 0);
  },

  _isTabRestorePending(tab) {
    return (
      !tab.closing &&
      (tab.hasAttribute?.("pending") || lazy.SessionStore.isTabRestoring(tab))
    );
  },

  _getClosedTreeSetUndoData() {
    const closedTabs = lazy.SessionStore.getClosedTabDataFromClosedWindows();
    const restoringSetIds = new Set();
    for (const isPrivate of [false, true]) {
      for (const window of lazy.SessionStore.getWindows({
        private: isPrivate,
      })) {
        closedTabs.push(...lazy.SessionStore.getClosedTabDataForWindow(window));
        for (const tab of this._getWindowTabs(window)) {
          if (this._isTabRestorePending(tab)) {
            restoringSetIds.add(this._readTabJSON(tab, CLOSED_TREE_SET_ID_KEY));
          }
        }
      }
    }
    return { closedTabs, restoringSetIds };
  },

  _pruneClosedTreeSets() {
    if (!this._closedTreeSets.size) {
      return;
    }
    let undoData;
    try {
      undoData = this._getClosedTreeSetUndoData();
    } catch {
      return;
    }
    const closedBySet = new Map();
    const closedById = new Map();
    for (const closed of undoData.closedTabs) {
      const setId = parseJSON(
        closed.state?.extData?.[`treeTabs:${CLOSED_TREE_SET_ID_KEY}`]
      );
      if (setId) {
        if (!closedBySet.has(setId)) {
          closedBySet.set(setId, new Map());
        }
        closedBySet.get(setId).set(this.readClosedTabGuid(closed), closed);
      } else {
        closedById.set(closed.closedId, closed);
      }
    }
    const provisional = [];
    for (const [id, snapshot] of this._closedTreeSets) {
      let undoable = undoData.restoringSetIds.has(id);
      for (const entry of snapshot.entries) {
        const closed =
          closedBySet.get(id)?.get(entry.guid) ||
          closedById.get(entry.closedId);
        if (closed && this.readClosedTabGuid(closed) === entry.guid) {
          entry.closedId = closed.closedId;
          undoable = true;
        }
      }
      if (undoable) {
        continue;
      }
      const sourceWindow = snapshot.sourceWindow?.deref();
      if (
        snapshot.entries.some(entry => entry.closedId != null) ||
        !sourceWindow ||
        sourceWindow.closed
      ) {
        this._closedTreeSets.delete(id);
      } else {
        provisional.push(id);
      }
    }
    // Final content updates can make previously unsaveable tabs undoable.
    // Bound those unconfirmed sets without evicting any eligible undo history.
    const limit = Math.max(0, Services.prefs.getIntPref(UNDO_PREFS[0], 25));
    for (const id of provisional.slice(
      0,
      Math.max(0, provisional.length - limit)
    )) {
      this._closedTreeSets.delete(id);
    }
  },

  cancelClosedTreeSet(window) {
    const snapshot = this._activeClosedTreeSets.get(window);
    if (!snapshot) {
      return;
    }
    this._activeClosedTreeSets.delete(window);
    for (const entry of snapshot.entries) {
      this._frozenCloseTabs.delete(entry.tab);
      this._deleteTabJSON(entry.tab, CLOSED_TREE_SET_ID_KEY);
    }
  },

  // The persistent ID inside a SessionStore closed-tab record, for matching
  // closed tabs against tabs that were closed as one tree.
  readClosedTabGuid(closedData) {
    const extData = closedData?.state?.extData;
    if (!extData) {
      return null;
    }
    const raw =
      extData[`treeTabs:${LEGACY_UNIQUE_ID_KEY}`] ||
      extData[`extension:sidebar@waterfox.net:${LEGACY_UNIQUE_ID_KEY}`];
    return this._extractLegacyUniqueId(parseJSON(raw));
  },

  _toReference(tab) {
    const id = getTabIdentity(tab);
    const uniqueId = this._getTabGuid(tab, { create: true });
    if (!id && !uniqueId) {
      return null;
    }
    return { id, uniqueId };
  },

  saveTabState(tab, options = {}) {
    if (
      !this._isEnabled() ||
      !tab ||
      (!options.ignoreFreeze && this._frozenCloseTabs.has(tab))
    ) {
      return;
    }
    const force = options.force === true;
    const window = this._getWindowForTab(tab);
    if (
      this._sessionRestoringWindows.has(window) ||
      this._pendingWindowRestores.has(window) ||
      (!force && this._restoringWindows.has(window))
    ) {
      return;
    }

    const ancestors = lazy.TreeTabsService.getAncestors(tab)
      .map(ancestor => this._toReference(ancestor))
      .filter(Boolean);
    const children = lazy.TreeTabsService.getChildren(tab)
      .map(child => this._toReference(child))
      .filter(Boolean);

    const specialStates = [];
    if (lazy.TreeTabsService.isCollapsed(tab)) {
      specialStates.push("subtree-collapsed");
    }

    const { insertBefore, insertAfter } = this._getSiblingHints(tab);

    this._writeTabJSON(tab, "ancestors", ancestors);
    this._writeTabJSON(tab, "children", children);
    this._writeTabJSON(tab, "special-tab-states", specialStates);
    this._writeTabJSON(tab, "insert-before", insertBefore);
    this._writeTabJSON(tab, "insert-after", insertAfter);
  },

  saveWindowStructure(window) {
    if (!this._isEnabled() || !window) {
      return;
    }
    if (this.isRestorePending(window)) {
      return;
    }

    const tabs = this._getWindowTabs(window);
    if (!tabs.length) {
      return;
    }
    const tabIndices = new Map(tabs.map((tab, index) => [tab, index]));
    const structure = tabs.map(tab => {
      const parent = lazy.TreeTabsService.getParent(tab);
      return {
        id: this._getTabGuid(tab, { create: true }),
        parent: tabIndices.get(parent) ?? null,
        collapsed: lazy.TreeTabsService.isCollapsed(tab),
      };
    });

    // Preserve an unrestored saved tree instead of replacing it with a
    // transient flat model.
    const hasTree = structure.some(entry => entry.parent != null);
    if (!this._manualRestoreCompleted.has(window)) {
      if (hasTree) {
        this._manualRestoreCompleted.add(window);
      } else {
        const stored = this.loadWindowStructure(window);
        if (
          Array.isArray(stored) &&
          stored.some(entry => entry && Number.isInteger(entry.parent))
        ) {
          return;
        }
      }
    }

    this._writeWindowJSON(window, WINDOW_KEY, structure);
  },

  loadTabState(tab) {
    if (!tab) {
      return null;
    }
    const rawAncestors = lazy.TreeTabsMigration.readTabKey(tab, "ancestors");
    const rawSpecialStates = lazy.TreeTabsMigration.readTabKey(
      tab,
      "special-tab-states"
    );
    const state = {
      ancestors: parseJSON(rawAncestors) || [],
      // Distinguishes "saved as a root" from "no tree data at all".
      hasAncestorData: rawAncestors != null,
      children: this._readTabJSON(tab, "children") || [],
      insertBefore: this._readTabJSON(tab, "insert-before"),
      insertAfter: this._readTabJSON(tab, "insert-after"),
      specialStates: parseJSON(rawSpecialStates) || [],
      hasSpecialStateData: rawSpecialStates != null,
      legacyUniqueId: this._readLegacyUniqueId(tab),
      closedTreeSetId: this._readTabJSON(tab, CLOSED_TREE_SET_ID_KEY),
    };

    return state;
  },

  loadWindowStructure(window) {
    if (!window) {
      return null;
    }
    return this._readWindowJSON(window, WINDOW_KEY);
  },

  onWindowRestoring(window) {
    for (const tab of this._getWindowTabs(window)) {
      this._treeRestoredTabs.delete(tab);
    }
    if (!this._isEnabled() || !window) {
      return;
    }
    this._sessionRestoringWindows.add(window);
    this._pendingWindowRestores.delete(window);
    this._manualRestoreCompleted.delete(window);
    this.ensureRestoreGuard(window);
    lazy.TreeTabsService.init(window);
    this._cancelWindowSave(window);
    const state = this._getWindowState(window, { create: true });
    // SessionStore installs the incoming extData after SSWindowRestoring.
    state.structure = null;
    state.collapseStates = new WeakMap();
    state.tabData = new Map();
    state.uniqueIdToTab = new Map();
  },

  onTabRestoring(tab) {
    if (!tab) {
      return;
    }
    const window = this._getWindowForTab(tab);
    const tabState = this.loadTabState(tab);
    const copiedState = this._resetDuplicateGuid(window, tab, tabState);
    if (
      copiedState &&
      this._isEnabled() &&
      !this._sessionRestoringWindows.has(window) &&
      window?.gBrowser?.tabContainer?.verticalMode === false
    ) {
      // A live GUID collision identifies copied data, not an ordinary undo.
      tabState.ancestors = [];
      tabState.children = [];
      tabState.hasAncestorData = true;
      this._writeTabJSON(tab, "ancestors", []);
      this._writeTabJSON(tab, "children", []);
    }
    this._recordTabRestoreState(window, tab, tabState);
  },

  _recordTabRestoreState(window, tab, tabState) {
    if (!this._isEnabled()) {
      return;
    }
    const state = this._getWindowState(window, { create: true });
    if (!state) {
      return;
    }
    state.tabData.set(tab, tabState);
    if (!state.collapseStates.has(tab)) {
      state.collapseStates.set(tab, null);
    }
    if (tabState?.legacyUniqueId) {
      state.uniqueIdToTab.set(tabState.legacyUniqueId, tab);
      this._trackClosedTreeSetRestore(
        window,
        tab,
        tabState.legacyUniqueId,
        tabState.closedTreeSetId
      );
    }
  },

  // duplicateTab copies session data, so replace a copied persistent ID to
  // keep lookups unique.
  _resetDuplicateGuid(window, tab, tabState) {
    const guid = tabState?.legacyUniqueId;
    this._cacheTabGuid(tab, guid);
    if (!guid || !window) {
      return false;
    }
    // Lazy tabs can receive new extData before SSTabRestoring. A cached owner
    // index cannot detect a different tab acquiring this GUID in the meantime.
    const taken = this._getWindowTabs(window).some(
      other =>
        other !== tab &&
        !other.closing &&
        other.isConnected !== false &&
        this._getWindowForTab(other) === window &&
        this._getTabGuid(other, { refresh: true }) === guid
    );
    if (!taken) {
      return false;
    }
    const fresh = Services.uuid.generateUUID().toString().slice(1, -1);
    this._writeTabJSON(tab, LEGACY_UNIQUE_ID_KEY, fresh);
    this._cacheTabGuid(tab, fresh);
    tabState.legacyUniqueId = fresh;
    return true;
  },

  onTabRestored(tab, { structureEntries = null } = {}) {
    if (!this._isEnabled() || !tab) {
      this._treeRestoredTabs.delete(tab);
      return;
    }
    const window = this._getWindowForTab(tab);
    if (this._closedSetRestoringTabs.has(tab)) {
      this._closedSetRestoringTabs.delete(tab);
      this._treeRestoredTabs.delete(tab);
      this._getWindowState(window)?.collapseStates.delete(tab);
      return;
    }
    if (this._sessionRestoringWindows.has(window)) {
      return;
    }
    const state = this._getWindowState(window, { create: true });
    if (!state) {
      return;
    }
    const tabData = state.tabData.get(tab) || this.loadTabState(tab);
    this._cacheTabGuid(tab, tabData?.legacyUniqueId);
    if (tabData?.legacyUniqueId) {
      state.uniqueIdToTab.set(tabData.legacyUniqueId, tab);
    }

    if (!structureEntries && this._treeRestoredTabs.delete(tab)) {
      state.tabData.delete(tab);
      state.collapseStates.delete(tab);
      return;
    }

    const structureEntry = structureEntries
      ? structureEntries.get(tab)
      : this._getStructureEntry(window, state, tab);

    // A link set by manual restore or auto attach wins over the session
    // references, which stop resolving once linkedPanel ids change. Only
    // detach when the data affirmatively says the tab was a root, or a
    // lazily restored child loses its parent on first activation.
    if (this._isPersistedAsRoot(tabData, structureEntry)) {
      lazy.TreeTabsService.detachTab(tab);
      if (!structureEntries?.has(tab)) {
        const rootIndex = this._getRootIndexFromStructure(window, state, tab);
        if (Number.isFinite(rootIndex)) {
          lazy.TreeTabsService.moveTabSubtree(tab, rootIndex);
        }
      }
    } else if (
      !structureEntries?.has(tab) &&
      !lazy.TreeTabsService.getParent(tab)
    ) {
      const parent =
        this._resolveParentFromStructure(window, state, tab, structureEntry) ||
        this._resolveParentFromAncestors(window, state, tabData);

      if (parent && parent !== tab) {
        let insertBefore = null;
        let insertAfter = this._getPreviousSiblingFromStructure(
          window,
          state,
          tab,
          structureEntry
        );
        if (!insertAfter && !structureEntry) {
          insertBefore = this._findTabByReference(
            window,
            tabData?.insertBefore,
            state
          );
          insertAfter = this._findTabByReference(
            window,
            tabData?.insertAfter,
            state
          );
        }
        lazy.TreeTabsService.attachTab(tab, parent, {
          insertBefore,
          insertAfter,
          suppressAutoExpand: true,
        });
      }
    }

    this._reclaimChildren(window, state, tab, tabData, structureEntries);

    // After the children, so their attach does not expand this tab again.
    // A disclosure change made while pending/loading wins over saved metadata.
    const collapsed =
      state.collapseStates.get(tab) ??
      this._isCollapsedFromRestoreData(tabData, structureEntry);
    if (collapsed === true) {
      lazy.TreeTabsService.collapseSubtree(tab);
    } else if (collapsed === false) {
      lazy.TreeTabsService.expandSubtree(tab);
    }
    state.collapseStates.delete(tab);
  },

  _trackClosedTreeSetRestore(window, tab, guid, setId) {
    const pending = this._pendingClosedTreeRestores.get(window);
    if (pending) {
      if (pending.snapshot.entries.some(entry => entry.guid == guid)) {
        this._closedSetRestoringTabs.add(tab);
      }
      return;
    }

    let snapshot = setId ? this._closedTreeSets.get(setId) : null;
    if (!snapshot) {
      snapshot = Array.from(this._closedTreeSets.values()).find(candidate =>
        candidate.entries.some(entry => entry.guid == guid)
      );
    }
    if (!snapshot || !snapshot.entries.some(entry => entry.guid == guid)) {
      return;
    }
    this._closedTreeSets.delete(snapshot.id);
    const restore = { snapshot, requestedTab: tab, timerId: null };
    this._pendingClosedTreeRestores.set(window, restore);
    this._closedSetRestoringTabs.add(tab);
    restore.timerId = setTimeout(
      () => this._restoreClosedTreeSet(window, restore),
      0
    );
  },

  _cancelClosedTreeSetRestore(window) {
    const restore = this._pendingClosedTreeRestores.get(window);
    if (!restore) {
      return;
    }
    this._pendingClosedTreeRestores.delete(window);
    clearTimeout(restore.timerId);
    restore.timerId = null;
    this._restoringClosedTreeSets.delete(window);
    const state = this._getWindowState(window);
    for (const tab of this._getWindowTabs(window)) {
      this._closedSetRestoringTabs.delete(tab);
      const tabData = state?.tabData.get(tab);
      if (tabData?.closedTreeSetId === restore.snapshot.id) {
        tabData.closedTreeSetId = null;
      }
      if (
        this._readTabJSON(tab, CLOSED_TREE_SET_ID_KEY) === restore.snapshot.id
      ) {
        this._deleteTabJSON(tab, CLOSED_TREE_SET_ID_KEY);
      }
    }
  },

  _restoreClosedTreeSet(window, restore) {
    if (this._pendingClosedTreeRestores.get(window) != restore) {
      return;
    }
    clearTimeout(restore.timerId);
    restore.timerId = null;
    const { snapshot, requestedTab } = restore;
    this._restoringClosedTreeSets.add(window);
    try {
      this.ensureUniqueTabGuids(window);
      const guidToTab = new Map();
      for (const tab of this._getWindowTabs(window)) {
        if (!tab.closing) {
          const guid = this._getTabGuid(tab);
          if (guid) {
            guidToTab.set(guid, tab);
          }
        }
      }

      const closedByGuid = this._getClosedTabsByGuid(window);
      for (const entry of snapshot.entries) {
        if (this._pendingClosedTreeRestores.get(window) !== restore) {
          return;
        }
        if (entry.closedId == null) {
          entry.closedId = closedByGuid.get(entry.guid)?.closedId ?? null;
        }
        const tab =
          guidToTab.get(entry.guid) ||
          this._restoreClosedTreeTab(window, restore, entry);
        if (this._pendingClosedTreeRestores.get(window) !== restore) {
          return;
        }
        if (tab) {
          guidToTab.set(entry.guid, tab);
          this._closedSetRestoringTabs.add(tab);
        }
      }

      const restoredTabs = snapshot.entries
        .map(entry => guidToTab.get(entry.guid))
        .filter(Boolean);
      if (restoredTabs.length < 2) {
        return;
      }

      const before = guidToTab.get(snapshot.beforeGuid);
      const after = guidToTab.get(snapshot.afterGuid);
      if (after && !restoredTabs.includes(after)) {
        window.gBrowser.moveTabsBefore(restoredTabs, after);
      } else if (before && !restoredTabs.includes(before)) {
        window.gBrowser.moveTabsAfter(restoredTabs, before);
      } else {
        let index = Math.min(
          snapshot.entries[0].stripIndex,
          window.gBrowser.tabs.length - restoredTabs.length
        );
        for (const tab of restoredTabs) {
          window.gBrowser.moveTabTo(tab, { tabIndex: index++ });
        }
      }

      for (const tab of restoredTabs) {
        lazy.TreeTabsService.detachTab(tab);
      }

      for (const entry of snapshot.entries) {
        const tab = guidToTab.get(entry.guid);
        if (!tab) {
          continue;
        }
        const parent = guidToTab.get(entry.parentGuid);
        if (parent && !parent.pinned) {
          const insertBefore = guidToTab.get(entry.insertBeforeGuid);
          const insertAfter = guidToTab.get(entry.insertAfterGuid);
          lazy.TreeTabsService.attachTab(tab, parent, {
            insertBefore,
            insertAfter,
            index: entry.siblingIndex,
            suppressAutoExpand: true,
          });
        } else {
          lazy.TreeTabsService.detachTab(tab);
          lazy.TreeTabsService.moveTabSubtree(tab, entry.siblingIndex);
        }
      }

      if (requestedTab?.isConnected && !requestedTab.closing) {
        window.gBrowser.selectedTab = requestedTab;
      }
      for (const entry of snapshot.entries) {
        const tab = guidToTab.get(entry.guid);
        if (!tab) {
          continue;
        }
        if (entry.collapsed) {
          lazy.TreeTabsService.collapseSubtree(tab);
        } else {
          lazy.TreeTabsService.expandSubtree(tab);
        }
      }
    } finally {
      if (this._pendingClosedTreeRestores.get(window) === restore) {
        this._pendingClosedTreeRestores.delete(window);
        this._restoringClosedTreeSets.delete(window);
        for (const entry of snapshot.entries) {
          const tab = this._getWindowTabs(window).find(
            candidate => this._getTabGuid(candidate) == entry.guid
          );
          if (tab) {
            this._deleteTabJSON(tab, CLOSED_TREE_SET_ID_KEY);
            this.saveTabState(tab, { force: true });
          }
        }
        this.saveWindowStructure(window);
      }
    }
  },

  _restoreClosedTreeTab(window, restore, entry) {
    let tab;
    if (entry.closedId != null) {
      try {
        tab = lazy.SessionStore.undoCloseById(entry.closedId, true, window);
      } catch {}
    }
    if (
      !tab &&
      entry.state &&
      this._pendingClosedTreeRestores.get(window) === restore
    ) {
      tab = window.gBrowser.addTrustedTab("about:blank", {
        createLazyBrowser: true,
        skipAnimation: true,
      });
      if (this._pendingClosedTreeRestores.get(window) === restore) {
        lazy.SessionStore.setTabState(tab, entry.state);
      }
    }
    return tab;
  },

  _isPersistedAsRoot(tabData, structureEntry) {
    if (structureEntry) {
      // The legacy extension snapshot uses -1 for roots, ours uses null.
      return structureEntry.parent == null || structureEntry.parent < 0;
    }
    return Boolean(tabData?.hasAncestorData) && !tabData.ancestors.length;
  },

  // Reattach saved children that are currently roots, for undo close of a
  // parent whose children were promoted when it closed.
  _reclaimChildren(window, state, tab, tabData, structureEntries = null) {
    if (!tabData?.children?.length) {
      return;
    }
    const replacementGroups = new Set();
    for (const childRef of tabData.children) {
      const childTab = this._findTabByReference(window, childRef, state);
      if (structureEntries?.has(childTab)) {
        continue;
      }
      const currentParent = childTab
        ? lazy.TreeTabsService.getParent(childTab)
        : null;
      const replacementParent =
        currentParent &&
        lazy.TreeTabsGroups.isGroupTab(currentParent) &&
        lazy.TreeTabsGroups.getReplacedParentCount(currentParent)
          ? currentParent
          : null;
      if (
        childTab &&
        childTab !== tab &&
        !childTab.closing &&
        (!currentParent || replacementParent)
      ) {
        lazy.TreeTabsService.attachTab(childTab, tab, {
          suppressAutoExpand: true,
        });
        if (replacementParent) {
          replacementGroups.add(replacementParent);
        }
      }
    }
    if (replacementGroups.size) {
      lazy.TreeTabsGroups.cleanupNeedlessGroupTabs(window, [
        ...replacementGroups,
      ]);
    }
  },

  onWindowRestored(window) {
    if (!window) {
      return;
    }
    this._sessionRestoringWindows.delete(window);
    if (!this._isEnabled()) {
      return;
    }
    this._pendingWindowRestores.add(window);
    this._manualRestoreCompleted.delete(window);
    // Lazy background tabs do not send SSTabRestoring until activation.
    this.tryManualRestore(window);
    this._cancelWindowSave(window);
    this._windowStates.delete(window);
    lazy.TreeTabsService._notifyStructureChanged(window);
  },

  _restoreTabMetadata(
    window,
    state,
    tabs,
    resolved = null,
    { requireRestoredLink = false } = {}
  ) {
    const structureEntries = new Map(
      (resolved || [])
        .filter(({ entry, tab }) => entry && tab)
        .map(({ entry, tab }) => [tab, entry])
    );
    // Read metadata in bulk without per-tab duplicate scans.
    state.tabData.clear();
    state.uniqueIdToTab.clear();
    for (const tab of tabs) {
      const tabData = this.loadTabState(tab);
      this._cacheTabGuid(tab, tabData?.legacyUniqueId);
      this._recordTabRestoreState(window, tab, tabData);
    }
    // Covered parents may name extra children, but metadata cannot reparent
    // snapshot-covered tabs, including roots.
    for (const tab of tabs) {
      this.onTabRestored(tab, { structureEntries });
    }
    this._fixupWindowTree(window);
    return this._hasCompleteTabRestore(window, state, tabs, {
      structureEntries,
      resolved,
      requireRestoredLink,
    });
  },

  _hasCompleteTabRestore(
    window,
    state,
    tabs,
    {
      structureEntries = null,
      resolved = null,
      requireRestoredLink = true,
    } = {}
  ) {
    let hasRestoredLink = false;
    for (const tab of tabs) {
      if (tab.closing || tab.pinned) {
        continue;
      }
      const tabData = state.tabData.get(tab);
      const entry = structureEntries?.get(tab);
      const covered = structureEntries?.has(tab);
      let parent = null;
      if (covered) {
        if (Number.isInteger(entry.parent) && entry.parent >= 0) {
          parent = resolved?.[entry.parent]?.tab || null;
        }
      } else {
        parent = this._resolveParentFromAncestors(window, state, tabData);
      }
      const restoredParent = lazy.TreeTabsService.getParent(tab);
      if (
        (parent &&
          parent !== tab &&
          !parent.pinned &&
          (restoredParent !== parent ||
            (parent.group || null) !== (tab.group || null))) ||
        (this._isPersistedAsRoot(tabData, entry) && restoredParent)
      ) {
        return false;
      }
      hasRestoredLink ||= !!parent && restoredParent === parent;
      const children = (tabData?.children || [])
        .map(ref => this._findTabByReference(window, ref, state))
        .filter(
          child =>
            child &&
            child !== tab &&
            !child.closing &&
            !child.pinned &&
            !structureEntries?.has(child)
        );
      if (
        children.some(
          child =>
            lazy.TreeTabsService.getParent(child) !== tab ||
            (child.group || null) !== (tab.group || null)
        )
      ) {
        return false;
      }
      hasRestoredLink ||= !!children.length;
    }
    // An unmatched saved tree cannot be replaced by a flat fallback.
    return !requireRestoredLink || hasRestoredLink;
  },

  tryManualRestore(window) {
    if (
      !this._isEnabled() ||
      !window ||
      this._sessionRestoringWindows.has(window) ||
      this._manualRestoreCompleted.has(window)
    ) {
      return false;
    }

    const structure = this.loadWindowStructure(window);
    const hasParentRelationships =
      Array.isArray(structure) &&
      structure.some(
        entry =>
          Number.isInteger(entry?.parent) &&
          entry.parent >= 0 &&
          entry.parent < structure.length
      );
    if (!hasParentRelationships && !this._pendingWindowRestores.has(window)) {
      return false;
    }

    const tabs = this._getWindowTabs(window);
    if (!tabs.length) {
      return false;
    }
    this._pendingWindowRestores.add(window);
    // Refresh lazy tabs whose extData arrived without SSTabRestoring.
    this.ensureUniqueTabGuids(window);
    const resolved = Array.isArray(structure)
      ? this._resolveStructureTabs(tabs, structure)
      : null;
    const state = this._getWindowState(window, { create: true });
    state.structure = resolved?.length ? structure : null;

    this.ensureRestoreGuard(window);
    lazy.TreeTabsService.init(window);
    for (const { entry, tab } of resolved || []) {
      if (tab && entry && (entry.parent == null || entry.parent < 0)) {
        lazy.TreeTabsService.detachTab(tab);
      }
    }

    const { pendingParentLinks } = this._restoreParentLinks(resolved || []);
    const coveredTabs = new Set(
      (resolved || []).filter(({ entry }) => entry).map(({ tab }) => tab)
    );
    const completeTabRestore =
      hasParentRelationships && tabs.every(tab => coveredTabs.has(tab))
        ? true
        : this._restoreTabMetadata(window, state, tabs, resolved, {
            requireRestoredLink: hasParentRelationships && !resolved,
          });
    if (pendingParentLinks || !completeTabRestore) {
      return false;
    }

    this._manualRestoreCompleted.add(window);
    this._pendingWindowRestores.delete(window);

    for (const { entry, tab } of resolved || []) {
      if (!tab || typeof entry?.collapsed != "boolean") {
        continue;
      }
      if (entry.collapsed) {
        lazy.TreeTabsService.collapseSubtree(tab);
      } else {
        lazy.TreeTabsService.expandSubtree(tab);
      }
    }

    this._fixupWindowTree(window);
    // The completed tree wins over stale metadata on first lazy activation.
    for (const tab of tabs) {
      if (this._isTabRestorePending(tab)) {
        this._treeRestoredTabs.add(tab);
      }
    }
    this.clearRestoreGuard(window);
    return true;
  },

  _restoreParentLinks(resolved) {
    let restoredParentLinks = false;
    let pendingParentLinks = false;
    const previousSiblings = new Map();
    for (const { entry, tab } of resolved) {
      if (!tab || !Number.isInteger(entry?.parent) || entry.parent < 0) {
        continue;
      }
      const insertAfter = previousSiblings.get(entry.parent) || null;
      previousSiblings.set(entry.parent, tab);
      const parent = resolved[entry.parent]?.tab || null;
      if (!parent || parent === tab || parent.pinned || tab.pinned) {
        continue;
      }

      if (
        lazy.TreeTabsService.attachTab(tab, parent, {
          insertAfter,
          suppressAutoExpand: true,
        })
      ) {
        restoredParentLinks = true;
      } else {
        pendingParentLinks = true;
      }
    }
    return { restoredParentLinks, pendingParentLinks };
  },

  // Match modern entries by persistent ID; only legacy ID-less entries depend
  // on exact strip position.
  _resolveStructureTabs(tabs, structure) {
    const hasIds = structure.some(entry => typeof entry?.id === "string");
    if (hasIds) {
      const guidToTab = new Map();
      for (const tab of tabs) {
        const guid = this._getTabGuid(tab);
        if (guid && !guidToTab.has(guid)) {
          guidToTab.set(guid, tab);
        }
      }
      const resolved = structure.map(entry => ({
        entry: entry && typeof entry === "object" ? entry : null,
        tab:
          typeof entry?.id === "string"
            ? guidToTab.get(entry.id) || null
            : null,
      }));
      return resolved.some(pair => pair.tab) ? resolved : null;
    }

    if (tabs.length < structure.length) {
      return null;
    }
    return structure.map((entry, index) => ({
      entry: entry && typeof entry === "object" ? entry : null,
      tab: tabs[index] || null,
    }));
  },

  isRestorePending(window) {
    return (
      this._sessionRestoringWindows.has(window) ||
      this._pendingWindowRestores.has(window) ||
      this._restoringWindows.has(window)
    );
  },

  ensureRestoreGuard(window) {
    if (!window) {
      return;
    }

    const existingTimer = this._restoringWindows.get(window);
    if (existingTimer != null) {
      clearTimeout(existingTimer);
    }

    const timeoutId = setTimeout(() => {
      this.clearRestoreGuard(window);
    }, RESTORE_GUARD_TIMEOUT_MS);
    this._restoringWindows.set(window, timeoutId);
  },

  clearRestoreGuard(window) {
    if (!window) {
      return;
    }

    const timeoutId = this._restoringWindows.get(window);
    if (timeoutId != null) {
      clearTimeout(timeoutId);
      this._restoringWindows.delete(window);
    }
  },

  _getPendingSave(window, { create = false } = {}) {
    if (!window) {
      return null;
    }
    let pending = this._pendingSaves.get(window);
    if (!pending && create) {
      pending = {
        tabs: new Set(),
        fullWindowSave: false,
        timerId: null,
      };
      this._pendingSaves.set(window, pending);
    }
    return pending || null;
  },

  _scheduleWindowSave(window) {
    const pending = this._getPendingSave(window, { create: true });
    if (pending.timerId) {
      clearTimeout(pending.timerId);
    }
    pending.timerId = setTimeout(() => {
      this._flushWindowSave(window);
    }, SAVE_DEBOUNCE_MS);
  },

  _flushWindowSave(window) {
    const pending = this._getPendingSave(window);
    if (!pending) {
      return;
    }

    pending.timerId = null;
    if (!this._isEnabled()) {
      this._pendingSaves.delete(window);
      return;
    }
    if (
      this.isRestorePending(window) ||
      this._restoringClosedTreeSets.has(window)
    ) {
      this._pendingSaves.delete(window);
      return;
    }

    if (pending.fullWindowSave) {
      for (const tab of this._getWindowTabs(window)) {
        this.saveTabState(tab);
      }
    } else {
      for (const tab of pending.tabs) {
        if (!tab?.closing) {
          this.saveTabState(tab);
        }
      }
    }
    this.saveWindowStructure(window);
    this._pendingSaves.delete(window);
  },

  _cancelWindowSave(window) {
    const pending = this._getPendingSave(window);
    if (!pending) {
      return;
    }
    if (pending.timerId) {
      clearTimeout(pending.timerId);
    }
    this._pendingSaves.delete(window);
  },

  _cancelAllPendingSaves() {
    for (const pending of this._pendingSaves.values()) {
      if (pending.timerId) {
        clearTimeout(pending.timerId);
      }
    }
    this._pendingSaves.clear();
  },

  _fixupWindowTree(window) {
    const tabs = this._getWindowTabs(window);
    const tabsSet = new Set(tabs);
    for (const tab of tabs) {
      const parent = lazy.TreeTabsService.getParent(tab);
      if (!parent) {
        continue;
      }
      const cycleDetected =
        lazy.TreeTabsService.getAncestors(parent).includes(tab);
      if (parent.pinned || !tabsSet.has(parent) || cycleDetected) {
        lazy.TreeTabsService.detachTab(tab);
      }
    }
  },

  _readLegacyUniqueId(tab) {
    const raw = this._readTabJSON(tab, LEGACY_UNIQUE_ID_KEY);
    return this._extractLegacyUniqueId(raw);
  },

  _extractLegacyUniqueId(raw) {
    if (!raw) {
      return null;
    }
    if (typeof raw === "string") {
      return raw;
    }
    if (typeof raw === "object" && typeof raw.id === "string") {
      return raw.id;
    }
    return null;
  },

  _isEnabled() {
    return getBoolPref(PREF_ENABLED, false);
  },

  _getWindowForTab(tab) {
    return tab?.documentGlobal || null;
  },

  _getWindowState(window, { create = false } = {}) {
    if (!window) {
      return null;
    }
    let state = this._windowStates.get(window);
    if (!state && create) {
      state = {
        structure: null,
        tabData: new Map(),
        uniqueIdToTab: new Map(),
        collapseStates: new WeakMap(),
      };
      this._windowStates.set(window, state);
    }
    return state || null;
  },

  _getWindowTabs(window) {
    return window?.gBrowser?.tabs ? Array.from(window.gBrowser.tabs) : [];
  },

  _getTabIndex(window, tab) {
    if (!window || !tab) {
      return -1;
    }
    if (Number.isInteger(tab._tPos)) {
      return tab._tPos;
    }
    return this._getWindowTabs(window).indexOf(tab);
  },

  _getStructureEntry(window, state, tab) {
    if (!state?.structure || !Array.isArray(state.structure)) {
      return null;
    }
    return (
      this._resolveStructureTabs(
        this._getWindowTabs(window),
        state.structure
      )?.find(pair => pair.tab === tab)?.entry || null
    );
  },

  _resolveParentFromStructure(window, state, tab, entry) {
    if (!entry || !window) {
      return null;
    }
    const parentIndex = entry.parent;
    if (!Number.isInteger(parentIndex)) {
      return null;
    }
    const resolved = this._resolveStructureTabs(
      this._getWindowTabs(window),
      state.structure
    );
    const parent = resolved?.[parentIndex]?.tab || null;
    if (parent === tab) {
      return null;
    }
    return parent;
  },

  _resolveParentFromAncestors(window, state, tabData) {
    if (!window || !tabData?.ancestors?.length) {
      return null;
    }
    const ancestors = tabData.ancestors;
    for (const candidate of ancestors) {
      const match = this._findTabByReference(window, candidate, state);
      if (match) {
        return match;
      }
    }
    return null;
  },

  _findTabByReference(window, ref, state = null) {
    if (!ref || !window) {
      return null;
    }

    if (typeof ref === "string" || Number.isInteger(ref)) {
      ref = { id: ref, uniqueId: typeof ref === "string" ? ref : null };
    }

    if (typeof ref !== "object") {
      return null;
    }

    const uniqueIdMap = state?.uniqueIdToTab || null;
    const id = ref.id;
    const guid = ref.uniqueId || (typeof id === "string" ? id : null);
    const cached = guid && uniqueIdMap?.get(guid);
    if (cached) {
      return cached;
    }
    const tabs = this._getWindowTabs(window);
    if (guid) {
      const byGuid = tabs.find(tab => this._getTabGuid(tab) === guid);
      if (byGuid) {
        return byGuid;
      }
    }

    if (typeof id === "string" && uniqueIdMap?.has(id)) {
      return uniqueIdMap.get(id);
    }

    if (typeof ref.uniqueId === "string" && uniqueIdMap?.has(ref.uniqueId)) {
      return uniqueIdMap.get(ref.uniqueId);
    }

    if (typeof id === "string") {
      const direct = tabs.find(tab => tab.linkedPanel === id);
      if (direct) {
        return direct;
      }
      const numeric = /^\d+$/.test(id) ? Number(id) : NaN;
      if (!Number.isNaN(numeric) && numeric >= 0 && numeric < tabs.length) {
        return tabs[numeric];
      }
    }
    if (Number.isInteger(id) && id >= 0 && id < tabs.length) {
      return tabs[id];
    }
    if (typeof ref.uniqueId === "string") {
      const byUniqueId = tabs.find(tab => tab.linkedPanel === ref.uniqueId);
      if (byUniqueId) {
        return byUniqueId;
      }
    }
    return null;
  },

  _getPreviousSiblingFromStructure(window, state, tab, entry) {
    if (!entry || !window || !state?.structure) {
      return null;
    }
    const resolved = this._resolveStructureTabs(
      this._getWindowTabs(window),
      state.structure
    );
    const index = resolved?.findIndex(pair => pair.tab === tab) ?? -1;
    if (index <= 0) {
      return null;
    }
    const parentIndex = entry.parent;
    for (let i = index - 1; i >= 0; i -= 1) {
      const previousEntry = resolved[i].entry;
      if (!previousEntry || previousEntry.parent !== parentIndex) {
        continue;
      }
      const previousTab = resolved[i].tab;
      if (previousTab) {
        return previousTab;
      }
    }
    return null;
  },

  _getRootIndexFromStructure(window, state, tab) {
    if (!state?.structure || !window) {
      return null;
    }
    const resolved = this._resolveStructureTabs(
      this._getWindowTabs(window),
      state.structure
    );
    const index = resolved?.findIndex(pair => pair.tab === tab) ?? -1;
    if (index < 0) {
      return null;
    }
    let rootIndex = 0;
    for (let i = 0; i < index; i += 1) {
      const entry = resolved[i].entry;
      if (entry && (entry.parent == null || entry.parent < 0)) {
        rootIndex += 1;
      }
    }
    return rootIndex;
  },

  _isCollapsedFromRestoreData(tabData, entry) {
    if (typeof entry?.collapsed == "boolean") {
      return entry.collapsed;
    }
    if (tabData?.hasSpecialStateData) {
      return tabData.specialStates.includes("subtree-collapsed");
    }
    return null;
  },

  _getSiblingHints(tab) {
    const parent = lazy.TreeTabsService.getParent(tab);
    const siblings = parent
      ? lazy.TreeTabsService.getChildren(parent)
      : lazy.TreeTabsService.getRootTabs(this._getWindowForTab(tab));
    const index = siblings.indexOf(tab);
    const insertBefore =
      index !== -1 && index + 1 < siblings.length
        ? this._toReference(siblings[index + 1])
        : null;
    const insertAfter =
      index > 0 ? this._toReference(siblings[index - 1]) : null;
    return { insertBefore, insertAfter };
  },

  _readTabJSON(tab, key) {
    const raw = lazy.TreeTabsMigration.readTabKey(tab, key);
    return parseJSON(raw);
  },

  _readWindowJSON(window, key) {
    const raw = lazy.TreeTabsMigration.readWindowKey(window, key);
    return parseJSON(raw);
  },

  _writeTabJSON(tab, key, value) {
    const json = serializeJSON(value);
    if (json === null) {
      return;
    }
    lazy.TreeTabsMigration.writeTabKey(tab, key, json);
  },

  _deleteTabJSON(tab, key) {
    if (tab) {
      lazy.TreeTabsMigration.deleteTabKey(tab, key);
    }
  },

  _writeWindowJSON(window, key, value) {
    const json = serializeJSON(value);
    if (json === null) {
      return;
    }
    lazy.TreeTabsMigration.writeWindowKey(window, key, json);
  },
};
