/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TreeTabsService: "resource:///modules/TreeTabsService.sys.mjs",
  TreeTabsMigration: "resource:///modules/TreeTabsMigration.sys.mjs",
});

const PREF_ENABLED = "browser.tabs.verticalTabs.tree.enabled";
const WINDOW_KEY = "tree-structure";
const LEGACY_UNIQUE_ID_KEY = "data-persistent-id";
const SAVE_DEBOUNCE_MS = 150;
const RESTORE_GUARD_TIMEOUT_MS = 10000;

// Custom topics the service raises through Services.obs. They are app wide.
const TREE_EVENT_TOPICS = [
  "tree-tabs-attached",
  "tree-tabs-detached",
  "tree-tabs-subtree-collapsed-changed",
  "tree-tabs-structure-changed",
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
  _restoringWindows: new WeakSet(),
  _restoreGuardTimers: new Map(),
  _manualRestoreCompleted: new WeakSet(),
  _tabGuids: new WeakMap(),

  init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;
    lazy.TreeTabsMigration.maybeMigrate();
    for (const topic of TREE_EVENT_TOPICS) {
      Services.obs.addObserver(this, topic);
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
    for (const topic of TREE_EVENT_TOPICS) {
      Services.obs.removeObserver(this, topic);
    }
    for (const browserWindow of Services.wm.getEnumerator(
      "navigator:browser"
    )) {
      this.uninitWindow(browserWindow);
    }
    this._cancelAllPendingSaves();
    for (const timeoutId of this._restoreGuardTimers.values()) {
      clearTimeout(timeoutId);
    }
    this._windowStates.clear();
    this._wiredWindows = new WeakSet();
    this._restoringWindows = new WeakSet();
    this._restoreGuardTimers.clear();
    this._manualRestoreCompleted = new WeakSet();
  },

  initWindow(window) {
    if (!window || this._wiredWindows.has(window)) {
      return;
    }
    this._wiredWindows.add(window);
    // Set a guard before restore starts so stray saves do not clobber the
    // persisted structure. The delayed startup hook can run after the window's
    // own restore has begun, so the timeout and the manual restore path are the
    // real recovery mechanisms.
    this.ensureRestoreGuard(window);
    for (const type of SS_RESTORE_EVENTS) {
      window.addEventListener(type, this, true);
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
    this._cancelWindowSave(window);
    this.clearRestoreGuard(window);
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
    if (this._restoringWindows.has(window)) {
      return;
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
  _getTabGuid(tab, { create = false } = {}) {
    if (!tab) {
      return null;
    }
    let guid = this._tabGuids.get(tab);
    if (guid) {
      return guid;
    }
    guid = this._readLegacyUniqueId(tab);
    if (!guid && create) {
      guid = Services.uuid.generateUUID().toString().slice(1, -1);
      this._writeTabJSON(tab, LEGACY_UNIQUE_ID_KEY, guid);
    }
    if (guid) {
      this._tabGuids.set(tab, guid);
    }
    return guid;
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
    if (!this._isEnabled() || !tab) {
      return;
    }
    const force = options.force === true;
    const window = this._getWindowForTab(tab);
    if (!force && window && this._restoringWindows.has(window)) {
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
    if (this._restoringWindows.has(window)) {
      return;
    }

    const tabs = this._getWindowTabs(window);
    if (!tabs.length) {
      return;
    }
    const structure = tabs.map(tab => {
      const parent = lazy.TreeTabsService.getParent(tab);
      let parentIndex = null;
      if (parent) {
        const index = tabs.indexOf(parent);
        parentIndex = index === -1 ? null : index;
      }
      return {
        id: this._getTabGuid(tab, { create: true }),
        parent: parentIndex,
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
    if (!this._isEnabled() || !window) {
      return;
    }
    this.ensureRestoreGuard(window);
    lazy.TreeTabsService.init(window);
    this._cancelWindowSave(window);
    const state = this._getWindowState(window, { create: true });
    state.structure = this.loadWindowStructure(window);
    state.tabData = new Map();
    state.uniqueIdToTab = new Map();
  },

  onTabRestoring(tab) {
    if (!this._isEnabled() || !tab) {
      return;
    }
    const window = this._getWindowForTab(tab);
    const state = this._getWindowState(window, { create: true });
    if (!state) {
      return;
    }
    const tabState = this.loadTabState(tab);
    this._resetDuplicateGuid(window, tab, tabState);
    state.tabData.set(tab, tabState);
    if (tabState?.legacyUniqueId) {
      state.uniqueIdToTab.set(tabState.legacyUniqueId, tab);
    }
  },

  // duplicateTab copies session data, so replace a copied persistent ID to
  // keep lookups unique.
  _resetDuplicateGuid(window, tab, tabState) {
    const guid = tabState?.legacyUniqueId;
    if (!guid) {
      return;
    }
    const taken = this._getWindowTabs(window).some(
      other =>
        other !== tab && !other.closing && this._getTabGuid(other) === guid
    );
    if (!taken) {
      return;
    }
    const fresh = Services.uuid.generateUUID().toString().slice(1, -1);
    this._writeTabJSON(tab, LEGACY_UNIQUE_ID_KEY, fresh);
    this._tabGuids.set(tab, fresh);
    tabState.legacyUniqueId = fresh;
  },

  onTabRestored(tab) {
    if (!this._isEnabled() || !tab) {
      return;
    }
    const window = this._getWindowForTab(tab);
    const state = this._getWindowState(window, { create: true });
    if (!state) {
      return;
    }
    const tabData = state.tabData.get(tab) || this.loadTabState(tab);
    if (tabData?.legacyUniqueId) {
      state.uniqueIdToTab.set(tabData.legacyUniqueId, tab);
    }

    const structureEntry = this._getStructureEntry(window, state, tab);

    // A link set by manual restore or auto attach wins over the session
    // references, which stop resolving once linkedPanel ids change. Only
    // detach when the data affirmatively says the tab was a root, or a
    // lazily restored child loses its parent on first activation.
    if (!lazy.TreeTabsService.getParent(tab)) {
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
      } else if (this._isPersistedAsRoot(tabData, structureEntry)) {
        lazy.TreeTabsService.detachTab(tab);
        const rootIndex = this._getRootIndexFromStructure(window, state, tab);
        if (Number.isFinite(rootIndex)) {
          lazy.TreeTabsService.moveTabSubtree(tab, rootIndex);
        }
      }
    }

    this._reclaimChildren(window, state, tab, tabData);

    // After the children, so their attach does not expand this tab again.
    const collapsed = this._isCollapsedFromRestoreData(tabData, structureEntry);
    if (collapsed === true) {
      lazy.TreeTabsService.collapseSubtree(tab);
    } else if (collapsed === false) {
      lazy.TreeTabsService.expandSubtree(tab);
    }
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
  _reclaimChildren(window, state, tab, tabData) {
    if (!tabData?.children?.length) {
      return;
    }
    for (const childRef of tabData.children) {
      const childTab = this._findTabByReference(window, childRef, state);
      if (
        childTab &&
        childTab !== tab &&
        !childTab.closing &&
        !lazy.TreeTabsService.getParent(childTab)
      ) {
        lazy.TreeTabsService.attachTab(childTab, tab, {
          suppressAutoExpand: true,
        });
      }
    }
  },

  onWindowRestored(window) {
    if (!window) {
      return;
    }
    if (!this._isEnabled()) {
      return;
    }
    const state = this._getWindowState(window);
    if (state) {
      this._fixupWindowTree(window);
    }

    // No save here: the restore guard is usually still up, and a save now
    // would overwrite the stored structure before the manual restore path
    // has read it.
    this._cancelWindowSave(window);
    this._windowStates.delete(window);
  },

  tryManualRestore(window) {
    const structure = window ? this.loadWindowStructure(window) : null;

    if (
      !this._isEnabled() ||
      !window ||
      this._manualRestoreCompleted.has(window)
    ) {
      return false;
    }

    if (!Array.isArray(structure) || !structure.length) {
      return false;
    }

    const tabs = this._getWindowTabs(window);
    if (!tabs.length) {
      return false;
    }

    const resolved = this._resolveStructureTabs(tabs, structure);
    if (!resolved) {
      return false;
    }

    const hasParentRelationships = resolved.some(
      pair =>
        pair.tab &&
        Number.isInteger(pair.entry?.parent) &&
        pair.entry.parent >= 0 &&
        pair.entry.parent < resolved.length
    );
    if (!hasParentRelationships) {
      return false;
    }

    // Guard only once there is a structure to apply; arming on every failed
    // attempt would keep suppressing saves and move fixups indefinitely in
    // windows with nothing to restore.
    this.ensureRestoreGuard(window);

    lazy.TreeTabsService.init(window);

    let restoredParentLinks = false;
    for (let index = 0; index < resolved.length; index += 1) {
      const { entry, tab } = resolved[index];
      if (!tab || !Number.isInteger(entry?.parent) || entry.parent < 0) {
        continue;
      }
      const parent = resolved[entry.parent]?.tab || null;
      if (!parent || parent === tab || parent.pinned) {
        continue;
      }

      let insertAfter = null;
      for (let i = index - 1; i >= 0; i -= 1) {
        if (resolved[i].tab && resolved[i].entry?.parent === entry.parent) {
          insertAfter = resolved[i].tab;
          break;
        }
      }

      if (
        lazy.TreeTabsService.attachTab(tab, parent, {
          insertAfter,
          suppressAutoExpand: true,
        })
      ) {
        restoredParentLinks = true;
      }
    }

    if (!restoredParentLinks) {
      return false;
    }

    this._manualRestoreCompleted.add(window);

    for (const { entry, tab } of resolved) {
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
    this.clearRestoreGuard(window);
    return true;
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

  ensureRestoreGuard(window) {
    if (!window) {
      return;
    }

    this._restoringWindows.add(window);

    const existingTimer = this._restoreGuardTimers.get(window);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timeoutId = setTimeout(() => {
      this.clearRestoreGuard(window);
    }, RESTORE_GUARD_TIMEOUT_MS);
    this._restoreGuardTimers.set(window, timeoutId);
  },

  clearRestoreGuard(window) {
    if (!window) {
      return;
    }

    this._restoringWindows.delete(window);
    const timeoutId = this._restoreGuardTimers.get(window);
    if (timeoutId) {
      clearTimeout(timeoutId);
      this._restoreGuardTimers.delete(window);
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
    if (this._restoringWindows.has(window)) {
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
      state = { structure: null, tabData: new Map(), uniqueIdToTab: new Map() };
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

    if (!ref || typeof ref !== "object") {
      return null;
    }

    const tabs = this._getWindowTabs(window);
    const uniqueIdMap = state?.uniqueIdToTab || null;
    const id = ref.id;
    const guid = ref.uniqueId || (typeof id === "string" ? id : null);
    if (guid) {
      const byGuid =
        uniqueIdMap?.get(guid) ||
        tabs.find(tab => this._getTabGuid(tab) === guid);
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

  _writeWindowJSON(window, key, value) {
    const json = serializeJSON(value);
    if (json === null) {
      return;
    }
    lazy.TreeTabsMigration.writeWindowKey(window, key, json);
  },
};
