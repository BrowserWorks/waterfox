/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PrefUtils: "resource:///modules/PrefUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
});

/**
 * Preferences used by the TabGrouping module.
 * - ENABLED: Master switch for auto-grouping.
 * - PLACEMENT: Positioning of the newly grouped tab within the source group.
 * - DELAY_ENABLED: Whether to delay grouping to allow cancellation.
 * - DELAY_MS: Delay window duration in milliseconds.
 * - CANCEL_SHORTCUT: Temporary shortcut to cancel pending grouping.
 * - BYPASS_SHORTCUT: Always-on shortcut to open a standard new tab without grouping.
 */
const PREFS = {
  ENABLED: "browser.tabs.autoGroupNewTabs",
  PLACEMENT: "browser.tabs.autoGroupNewTabs.placement",
  DELAY_ENABLED: "browser.tabs.autoGroupNewTabs.delayEnabled",
  DELAY_MS: "browser.tabs.autoGroupNewTabs.delayMs",
  CANCEL_SHORTCUT: "browser.tabs.autoGroupNewTabs.cancelShortcut",
  BYPASS_SHORTCUT: "browser.tabs.autoGroupNewTabs.bypassShortcut",
  DEBUG_LOG: "browser.tabs.autoGroupNewTabs.debugLog",
  RESUME_GRACE_MS: "browser.tabs.autoGroupNewTabs.resumeGraceMs",
};

/**
 * Enumerates placement modes for positioning a new tab within a group.
 * - AFTER: Immediately after the source tab.
 * - FIRST: At the beginning of the group.
 * - LAST: At the end of the group (no explicit move post-grouping).
 */
const PLACEMENT_MODES = {
  AFTER: "after",
  FIRST: "first",
  LAST: "last",
};

/**
 * Core module that implements automatic tab grouping.
 *
 * Responsibilities:
 * - Track active tab snapshot and per-window history to infer source tab.
 * - Group newly created tabs into the source tab’s group.
 * - Optionally delay grouping with a cancel window.
 * - Provide an always-on bypass shortcut to open a standard new tab (no grouping).
 *
 * State fields:
 * - _enabled, _placement, _delayEnabled, _delayMs, _cancelShortcut, _bypassShortcut
 * - _lastActiveTab, _activeHistory, _snapshotInterval
 * - _pendingTimers, _cancelShortcutActive, _suspended
 *
 * Public API:
 * - init(): Initialize listeners and state.
 * - shutdown(): Tear down listeners and timers.
 * - cancelPendingGrouping(): Cancel all pending delayed groupings.
 */
export const TabGrouping = {
  _initialized: false,
  _enabled: true,
  _placement: PLACEMENT_MODES.AFTER,
  _delayEnabled: false,
  _delayMs: 1000,
  _cancelShortcut: "",
  _bypassShortcut: "",
  /** Enable verbose debug logging for TabGrouping. */
  _debugLog: false,
  _lastActiveTab: null,
  _activeHistory: new Map(),
  _snapshotInterval: null,
  _pendingTimers: new Map(),
  _cancelShortcutActive: false,
  /** True while grouping is suspended (e.g., during session restore/startup). */
  _suspended: false,
  /** Grace period (ms) after restore before resuming grouping. */
  _resumeGraceMs: 1000,
  /** Timer handle for delayed resume after restore. */
  _resumeTimer: null,

  /**
   * Initialize the TabGrouping module.
   * - Loads preferences and observers
   * - Starts active tab tracking (snapshot + history)
   * - Registers tab listeners and keyboard shortcuts
   */
  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    // 1) Preferences
    this._loadPreferences();
    this._setupPrefObservers();

    // 2) Active tab tracking (snapshot + history)
    this._startActiveTabTracking();

    // 3) Tab lifecycle listeners
    this._addEventListeners();

    // 4) Cancel shortcut wiring (observer)
    this._setupKeyboardShortcuts();
    this._updateBypassShortcut();
    // Register collapse guards
    this._registerCollapseGuards();
    // Start in suspended mode during startup/session restore; resume once ready.
    this._suspended = true;
    Services.obs.addObserver(this, "sessionstore-windows-restored");
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
  },

  /**
   * Shutdown the TabGrouping module.
   * Cleans up timers, observers, and keyboard shortcuts and clears state.
   */
  shutdown() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;

    // Stop snapshot
    if (this._snapshotInterval) {
      lazy.clearInterval(this._snapshotInterval);
      this._snapshotInterval = null;
    }

    // Cancel pending
    this._cancelAllPending();

    // Remove observers
    this._removeEventListeners();

    // Shortcut cleanup
    this._cleanupKeyboardShortcuts();
    this._unregisterBypassShortcut();
    this._unregisterCollapseGuards();
    if (this._resumeTimer) {
      lazy.clearTimeout(this._resumeTimer);
      this._resumeTimer = null;
    }
    try {
      Services.obs.removeObserver(this, "sessionstore-windows-restored");
    } catch (_e) {}
    try {
      Services.obs.removeObserver(this, "browser-delayed-startup-finished");
    } catch (_e) {}

    // Clear state
    this._lastActiveTab = null;
    this._activeHistory.clear();
  },

  /**
   * Load user preferences for automatic tab grouping.
   * Reads current values for feature enablement, placement mode, delay settings,
   * cancel shortcut, and bypass shortcut.
   */
  _loadPreferences() {
    this._enabled = lazy.PrefUtils.get(PREFS.ENABLED, true);
    this._placement = lazy.PrefUtils.get(
      PREFS.PLACEMENT,
      PLACEMENT_MODES.AFTER
    );
    this._delayEnabled = lazy.PrefUtils.get(PREFS.DELAY_ENABLED, false);
    this._delayMs = lazy.PrefUtils.get(PREFS.DELAY_MS, 1000);
    this._cancelShortcut = lazy.PrefUtils.get(
      PREFS.CANCEL_SHORTCUT,
      Services.appinfo.OS === "Darwin" ? "Option+`" : "Ctrl+`"
    );
    this._bypassShortcut = lazy.PrefUtils.get(
      PREFS.BYPASS_SHORTCUT,
      Services.appinfo.OS === "Darwin" ? "Option+Shift+T" : "Alt+Shift+T"
    );
    this._resumeGraceMs = lazy.PrefUtils.get(PREFS.RESUME_GRACE_MS, 1000);
    this._debugLog = lazy.PrefUtils.get(PREFS.DEBUG_LOG, false);
  },

  /**
   * Register observers for preference changes that affect tab grouping behavior.
   * Updates in-memory state and toggles runtime listeners as needed.
   */
  _setupPrefObservers() {
    this._prefObservers = [
      lazy.PrefUtils.addObserver(PREFS.ENABLED, (v) => {
        this._enabled = v;
        if (!v) {
          this._cancelAllPending();
        }
      }),
      lazy.PrefUtils.addObserver(PREFS.PLACEMENT, (v) => {
        this._placement = v;
      }),
      lazy.PrefUtils.addObserver(PREFS.DELAY_ENABLED, (v) => {
        this._delayEnabled = v;
        if (!v) {
          this._cancelAllPending();
        }
      }),
      lazy.PrefUtils.addObserver(PREFS.BYPASS_SHORTCUT, (v) => {
        this._bypassShortcut = v;
        this._updateBypassShortcut();
      }),
      lazy.PrefUtils.addObserver(PREFS.DEBUG_LOG, (v) => {
        this._debugLog = v;
      }),
    ];
  },

  /**
   * Start tracking the active tab via periodic snapshot and activation events.
   * Maintains a per-window history [current, previous] to support robust
   * source tab detection during tab creation.
   */
  _startActiveTabTracking() {
    this._refreshSnapshot();
    this._snapshotInterval = lazy.setInterval(
      () => this._refreshSnapshot(),
      5000
    );

    // Observe tab/window activation to maintain per-window history
    Services.obs.addObserver(this, "browser-tab-activated");
    Services.obs.addObserver(this, "browser-window-focus-changed");
  },

  _refreshSnapshot() {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (win?.gBrowser) {
      const tab = win.gBrowser.selectedTab;
      if (tab) {
        this._lastActiveTab = tab;
      }
    }
  },

  _handleTabActivated(tab) {
    if (!tab || !tab.ownerGlobal) {
      return;
    }
    const window = tab.ownerGlobal;
    const windowId = window.docShell.outerWindowID;
    const history = this._activeHistory.get(windowId) || [];

    // [current, previous]
    if (history[0] && history[0] !== tab) {
      history.unshift(tab);
    } else {
      history[0] = tab;
    }
    this._activeHistory.set(windowId, history.slice(0, 2));
    this._lastActiveTab = tab;
  },

  _addEventListeners() {
    Services.obs.addObserver(this, "browser-tab-created");
    Services.obs.addObserver(this, "browser-tab-removed");
  },

  _removeEventListeners() {
    try {
      Services.obs.removeObserver(this, "browser-tab-created");
    } catch (_) {}
    try {
      Services.obs.removeObserver(this, "browser-tab-removed");
    } catch (_) {}
    try {
      Services.obs.removeObserver(this, "browser-tab-activated");
    } catch (_) {}
    try {
      Services.obs.removeObserver(this, "browser-window-focus-changed");
    } catch (_) {}
  },

  /**
   * Global observer entry point for tab and window events.
   * Handles: tab created/removed/activated, window focus changes,
   * and cancel-auto-grouping notifications.
   *
   * @param {any} subject - Event subject (often a tab element)
   * @param {string} topic - Observer topic identifier
   * @param {string} _data - Reserved extra data (unused)
   */
  observe(subject, topic, _data) {
    switch (topic) {
      case "browser-tab-created":
        this._handleTabCreated(subject);
        break;
      case "browser-tab-removed":
        this._handleTabRemoved(subject);
        break;
      case "browser-tab-activated":
        this._handleTabActivated(subject);
        break;
      case "browser-window-focus-changed":
        this._refreshSnapshot();
        break;
      case "browser-cancel-auto-grouping":
        this.cancelPendingGrouping();
        break;
      case "sessionstore-windows-restored":
        // Schedule resume after grace period to avoid acting during restore churn
        if (this._resumeTimer) {
          lazy.clearTimeout(this._resumeTimer);
          this._resumeTimer = null;
        }
        this._resumeTimer = lazy.setTimeout(() => {
          this._suspended = false;
          this._resumeTimer = null;
          this._log(
            `Session restore complete: resuming grouping after ${this._resumeGraceMs}ms`
          );
        }, this._resumeGraceMs);
        try {
          Services.obs.removeObserver(this, "sessionstore-windows-restored");
        } catch (_e) {}
        try {
          Services.obs.removeObserver(this, "browser-delayed-startup-finished");
        } catch (_e) {}
        break;
      case "browser-delayed-startup-finished":
        // Defensive: if sessionstore didn't notify (e.g., no restore), schedule resume now
        if (this._suspended) {
          if (this._resumeTimer) {
            lazy.clearTimeout(this._resumeTimer);
            this._resumeTimer = null;
          }
          this._resumeTimer = lazy.setTimeout(() => {
            this._suspended = false;
            this._resumeTimer = null;
            this._log(
              `Delayed startup finished: resuming grouping after ${this._resumeGraceMs}ms`
            );
          }, this._resumeGraceMs);
        }
        try {
          Services.obs.removeObserver(this, "browser-delayed-startup-finished");
        } catch (_e) {}
        try {
          Services.obs.removeObserver(this, "sessionstore-windows-restored");
        } catch (_e) {}
        break;
    }
  },

  /**
   * Handle new tab creation:
   * - Determines the source tab via snapshot + per-window history fallback.
   * - Skips grouping during session restore while grouping is suspended (_suspended is true).
   * - Skips grouping if a bypass-open was just requested for this window.
   * - Skips grouping if the new tab already has a group (e.g., from session restore).
   * - Applies optional delay window to allow cancellation via the cancel shortcut.
   * @param {XULElement} newTab - The newly created tab element.
   * @returns {Promise<void>}
   */
  async _handleTabCreated(newTab) {
    if (!this._enabled || !newTab || !newTab.ownerGlobal) {
      return;
    }

    // Skip grouping during session restore
    if (this._suspended) {
      this._log("Suspended (session restore): skipping grouping for new tab");
      return;
    }
    const window = newTab.ownerGlobal;
    const gBrowser = window.gBrowser;

    // If tab groups are collapsed in this window, skip grouping to avoid reverse order/merging
    if (window.__tabGroupingCollapsed) {
      this._log("Groups collapsed: skipping grouping for new tab");
      return;
    }

    // Bypass shortcut: skip grouping for this creation
    if (window.__tabGroupingBypassNext) {
      this._log("Bypass flag detected for new tab: skipping grouping");
      window.__tabGroupingBypassNext = false;
      return;
    }

    // If the new tab already has a group (e.g., session restore), do not regroup.
    if (newTab.group) {
      this._log(
        "New tab already has a group (likely restore): skipping regrouping"
      );
      return;
    }
    // 1) Snapshot source
    const sourceTab = this._findSourceTab(newTab, window);
    if (!sourceTab || !sourceTab.group) {
      this._log(
        "No valid source tab or source has no group: skipping grouping"
      );
      return;
    }

    // 2) Delay or immediate
    if (this._delayEnabled) {
      this._log("Scheduling delayed grouping");
      this._scheduleGrouping(newTab, sourceTab, gBrowser);
    } else {
      this._log("Grouping immediately");
      this._groupTab(newTab, sourceTab, gBrowser);
    }
  },

  /**
   * Resolve the source tab for grouping a newly created tab.
   * Prefers the last active snapshot, with a history fallback:
   * - If the new tab is selected and snapshot points to itself, use previous active in history.
   * - Otherwise use current active in history for that window.
   * @param {XULElement} newTab - The new tab being grouped.
   * @param {Window} window - The browser window where the tab was created.
   * @returns {XULElement|null} The inferred source tab or null if not found.
   */
  _findSourceTab(newTab, window) {
    // Start with snapshot
    let source = this._lastActiveTab;

    // Fallback to history if snapshot is self or missing
    if (newTab.selected && source && source === newTab) {
      source = null;
    }
    if (!source || source.ownerGlobal !== window) {
      const windowId = window.docShell.outerWindowID;
      const history = this._activeHistory.get(windowId) || [];
      source = newTab.selected ? history[1] : history[0];
    }
    return source;
  },

  /**
   * Schedule grouping after a delay to allow cancellation.
   * Enables the cancel shortcut only while at least one pending timer exists.
   * @param {XULElement} newTab - The newly created tab.
   * @param {XULElement} sourceTab - The inferred source tab (must have a group).
   * @param {object} gBrowser - The tab browser instance for the window.
   */
  _scheduleGrouping(newTab, sourceTab, gBrowser) {
    // Cancel existing timer for this tab
    this._cancelPendingForTab(newTab);

    // Enable cancel shortcut while something is pending
    if (!this._cancelShortcutActive) {
      this._enableCancelShortcut();
    }

    const timer = lazy.setTimeout(() => {
      this._pendingTimers.delete(newTab);
      if (this._pendingTimers.size === 0) {
        this._disableCancelShortcut();
      }
      this._groupTab(newTab, sourceTab, gBrowser);
    }, this._delayMs);

    this._pendingTimers.set(newTab, timer);
  },

  /**
   * Group the new tab into the source tab's group and apply placement policy.
   * Validates both tabs are still in the same window and the source has a group.
   * @param {XULElement} newTab - The newly created tab.
   * @param {XULElement} sourceTab - The source tab providing the group.
   * @param {object} gBrowser - The tab browser instance for the window.
   * @returns {Promise<void>}
   */
  async _groupTab(newTab, sourceTab, gBrowser) {
    try {
      // Ensure tabs are still valid and in same window
      if (
        !sourceTab ||
        sourceTab === newTab ||
        !sourceTab.group ||
        newTab.group ||
        newTab.ownerGlobal !== sourceTab.ownerGlobal
      ) {
        return;
      }

      // Add to the same group
      this._log("Grouping new tab into source group");
      gBrowser.moveTabToGroup(newTab, sourceTab.group);

      // Apply placement
      await this._applyPlacement(newTab, sourceTab, gBrowser);
    } catch (error) {
      Cu.reportError(`TabGrouping: Failed to group tab: ${error}`);
    }
  },

  /**
   * Apply placement mode for the newly grouped tab within the source group.
   * Modes:
   * - "after": Move after the source tab.
   * - "first": Move to the beginning of the group (or before source if it is the only other tab).
   * - "last": Do not explicitly move; rely on default placement at the end.
   * @param {XULElement} newTab - The newly grouped tab.
   * @param {XULElement} sourceTab - The source tab within the same group.
   * @param {object} gBrowser - The tab browser instance for the window.
   * @returns {Promise<void>}
   */
  async _applyPlacement(newTab, sourceTab, gBrowser) {
    // Defensive: tabs may have moved or been restored; ensure we are still in same window and group
    if (!newTab || !sourceTab) {
      return;
    }
    if (newTab.ownerGlobal !== sourceTab.ownerGlobal) {
      return;
    }
    if (!newTab.group || !sourceTab.group) {
      return;
    }
    if (newTab.group !== sourceTab.group) {
      return;
    }
    switch (this._placement) {
      case PLACEMENT_MODES.AFTER: {
        // Move after the source tab (keeps inside the group)
        gBrowser.moveTabAfter(newTab, sourceTab);
        break;
      }

      case PLACEMENT_MODES.FIRST: {
        // Move to the first position in the group
        const groupTabs = gBrowser.tabs.filter(
          (t) => t.group === sourceTab.group && t !== newTab
        );
        if (groupTabs.length > 0) {
          const firstTab = groupTabs.reduce(
            (min, t) => (t._tPos < min._tPos ? t : min),
            groupTabs[0]
          );
          gBrowser.moveTabBefore(newTab, firstTab);
        } else {
          // No other tabs yet: place before source
          gBrowser.moveTabBefore(newTab, sourceTab);
        }
        break;
      }

      case PLACEMENT_MODES.LAST: {
        // Match addon behavior: don't move explicitly after grouping
        // (rely on default placement of moveTabToGroup for "end" semantics)
        break;
      }
    }
  },

  /**
   * Handle tab removal by canceling any pending delayed grouping for that tab.
   * @param {XULElement} tab - The removed tab element.
   */
  _handleTabRemoved(tab) {
    this._cancelPendingForTab(tab);
  },

  /**
   * Cancel a pending delayed grouping timer for a specific tab, if present.
   * Disables the cancel shortcut when no timers remain.
   * @param {XULElement} tab - The tab whose pending timer should be canceled.
   */
  _cancelPendingForTab(tab) {
    if (this._pendingTimers.has(tab)) {
      lazy.clearTimeout(this._pendingTimers.get(tab));
      this._pendingTimers.delete(tab);

      if (this._pendingTimers.size === 0) {
        this._disableCancelShortcut();
      }
    }
  },

  /**
   * Cancel all pending delayed grouping timers and disable the cancel shortcut.
   */
  _cancelAllPending() {
    this._log("Cancel all pending grouping operations");
    for (const timer of this._pendingTimers.values()) {
      lazy.clearTimeout(timer);
    }
    this._pendingTimers.clear();
    this._disableCancelShortcut();
  },

  /**
   * Cancel all pending delayed grouping operations and disable the cancel shortcut.
   */
  cancelPendingGrouping() {
    this._log("Cancel pending grouping requested");
    this._cancelAllPending();
  },

  /**
   * Register the observer used by the temporary cancel shortcut.
   * This observer is active only while delayed operations are pending.
   */
  _setupKeyboardShortcuts() {
    Services.obs.addObserver(this, "browser-cancel-auto-grouping");
  },

  /**
   * Remove the observer for the temporary cancel shortcut and unregister it
   * from all browser windows.
   */
  _cleanupKeyboardShortcuts() {
    try {
      Services.obs.removeObserver(this, "browser-cancel-auto-grouping");
    } catch (_e) {}
    this._unregisterKeyboardShortcut();
  },

  /**
   * Enable the temporary cancel shortcut globally while timers are pending.
   */
  _enableCancelShortcut() {
    this._cancelShortcutActive = true;
    this._log("Cancel shortcut enabled");
    this._updateKeyboardShortcut();
  },

  /**
   * Disable the temporary cancel shortcut when no timers remain.
   */
  _disableCancelShortcut() {
    this._cancelShortcutActive = false;
    this._log("Cancel shortcut disabled");
    this._unregisterKeyboardShortcut();
  },

  /**
   * Register or unregister the temporary cancel shortcut based on current state.
   */
  _updateKeyboardShortcut() {
    if (this._cancelShortcutActive && this._cancelShortcut) {
      this._registerKeyboardShortcut();
    } else {
      this._unregisterKeyboardShortcut();
    }
  },

  /**
   * Register the temporary cancel shortcut on all open browser windows.
   */
  _registerKeyboardShortcut() {
    for (const window of Services.wm.getEnumerator("navigator:browser")) {
      this._addShortcutToWindow(window);
    }
  },

  /**
   * Unregister the temporary cancel shortcut from all open browser windows.
   */
  _unregisterKeyboardShortcut() {
    // Unregister the shortcut from all browser windows
    for (const window of Services.wm.getEnumerator("navigator:browser")) {
      this._removeShortcutFromWindow(window);
    }
  },

  /**
   * Register or unregister the always-on bypass shortcut depending on preference.
   * When set, the shortcut opens a standard new tab and bypasses grouping.
   */
  _updateBypassShortcut() {
    // Always-on: register if a non-empty shortcut is configured
    if (this._bypassShortcut) {
      this._registerBypassShortcut();
    } else {
      this._unregisterBypassShortcut();
    }
  },

  /**
   * Register the bypass shortcut on all open browser windows.
   */
  _registerBypassShortcut() {
    for (const window of Services.wm.getEnumerator("navigator:browser")) {
      this._addBypassShortcutToWindow(window);
    }
  },

  /**
   * Unregister the bypass shortcut from all open browser windows.
   */
  _unregisterBypassShortcut() {
    for (const window of Services.wm.getEnumerator("navigator:browser")) {
      this._removeBypassShortcutFromWindow(window);
    }
  },

  /**
   * Attach the bypass shortcut keydown handler to a browser window.
   * @param {Window} window - The target browser window.
   */
  _addBypassShortcutToWindow(window) {
    if (!window?.gBrowser || !this._bypassShortcut) {
      return;
    }

    const [modifiers, key] = this._parseShortcut(this._bypassShortcut);
    if (!key) {
      return;
    }

    const handler = (event) => {
      if (this._matchesShortcut(event, modifiers, key)) {
        event.preventDefault();
        event.stopPropagation();
        try {
          this._log(
            "Bypass new tab shortcut triggered: opening standard new tab"
          );
          // Mark bypass for the next created tab in this window
          window.__tabGroupingBypassNext = true;
          // Open a new tab "standard way" (no grouping)
          if (typeof window.BrowserOpenTab === "function") {
            window.BrowserOpenTab();
          } else if (window.gBrowser?.addTab) {
            window.gBrowser.selectedTab =
              window.gBrowser.addTab("about:newtab");
          }
        } catch (_e) {}
      }
    };

    if (window.__tabGroupingBypassHandler) {
      window.removeEventListener(
        "keydown",
        window.__tabGroupingBypassHandler,
        true
      );
    }
    window.__tabGroupingBypassHandler = handler;
    window.addEventListener("keydown", handler, true);
  },

  /**
   * Detach the bypass shortcut keydown handler from a browser window.
   * @param {Window} window - The target browser window.
   */
  _removeBypassShortcutFromWindow(window) {
    if (window.__tabGroupingBypassHandler) {
      window.removeEventListener(
        "keydown",
        window.__tabGroupingBypassHandler,
        true
      );
      delete window.__tabGroupingBypassHandler;
    }
  },

  /**
   * Attach the temporary cancel shortcut keydown handler to a browser window.
   * Active only while delayed grouping operations are pending.
   * @param {Window} window - The target browser window.
   */
  _addShortcutToWindow(window) {
    if (!window?.gBrowser || !this._cancelShortcut) {
      return;
    }

    const [modifiers, key] = this._parseShortcut(this._cancelShortcut);
    if (!key) {
      return;
    }

    const handler = (event) => {
      if (this._matchesShortcut(event, modifiers, key)) {
        event.preventDefault();
        event.stopPropagation();
        Services.obs.notifyObservers(null, "browser-cancel-auto-grouping");
      }
    };

    if (window.__tabGroupingShortcutHandler) {
      window.removeEventListener(
        "keydown",
        window.__tabGroupingShortcutHandler,
        true
      );
    }
    window.__tabGroupingShortcutHandler = handler;
    window.addEventListener("keydown", handler, true);
  },

  /**
   * Detach the temporary cancel shortcut keydown handler from a browser window.
   * @param {Window} window - The target browser window.
   */
  _removeShortcutFromWindow(window) {
    if (window.__tabGroupingShortcutHandler) {
      window.removeEventListener(
        "keydown",
        window.__tabGroupingShortcutHandler,
        true
      );
      delete window.__tabGroupingShortcutHandler;
    }
  },

  /**
   * Parse a human-readable shortcut string into modifiers and a normalized key.
   * Supports synonyms for the backquote key and normalizes to event.code "Backquote".
   * @param {string} shortcut - Shortcut string (e.g., "Alt+Shift+T").
   * @returns {[Set<string>, string]} Tuple of (modifiers, keyCodeOrKey).
   */
  _parseShortcut(shortcut) {
    const parts = shortcut.split("+");
    const rawKey = (parts.pop() || "").trim();
    const normalized = parts.map((m) => {
      const s = m.trim().toLowerCase();
      return s === "option" || s === "opt" ? "alt" : s;
    });
    const modifiers = new Set(normalized);
    // Normalize backquote variants to event.code 'Backquote' for reliable matching
    const lower = rawKey.toLowerCase();
    const key =
      rawKey === "`" ||
      lower === "backquote" ||
      lower === "backtick" ||
      lower === "grave"
        ? "Backquote"
        : rawKey;
    return [modifiers, key];
  },

  /**
   * Check whether a keyboard event matches the given shortcut definition.
   * Requires exact modifier match (no extra modifiers).
   * Special-cases Backquote to accept either event.key or event.code.
   * @param {KeyboardEvent} event - The keydown event to test.
   * @param {Set<string>} modifiers - Required modifiers (e.g., "ctrl", "alt", "shift", "cmd"|"meta").
   * @param {string} key - Normalized key or code (e.g., "Backquote", "T").
   * @returns {boolean} True if the event matches the shortcut.
   */
  _matchesShortcut(event, modifiers, key) {
    // Key match: accept either event.key or event.code for Backquote
    const isBackquote = key === "Backquote" || key === "`";
    const keyOk = isBackquote
      ? event.key === "`" || event.code === "Backquote"
      : event.key === key || event.code === key;
    if (!keyOk) {
      return false;
    }

    // Required modifiers
    const requiresCtrl = modifiers.has("ctrl");
    const requiresMeta = modifiers.has("cmd") || modifiers.has("meta");
    const requiresAlt = modifiers.has("alt");
    const requiresShift = modifiers.has("shift");

    // Pressed modifiers
    const pressedCtrl = event.ctrlKey;
    const pressedMeta = event.metaKey; // Cmd on macOS
    const pressedAlt = event.altKey;
    const pressedShift = event.shiftKey;

    // Exact match: required present, others absent
    if (pressedCtrl !== requiresCtrl) return false;
    if (pressedMeta !== requiresMeta) return false;
    if (pressedAlt !== requiresAlt) return false;
    if (pressedShift !== requiresShift) return false;

    return true;
  },

  /**
   * Debug log helper. Logs when debug pref is enabled.
   * @param {...any} args - Values to log to the console.
   */
  _log(...args) {
    if (!this._debugLog) {
      return;
    }
    try {
      console.log("[TabGrouping]", ...args);
    } catch (_e) {}
  },
  /**
   * Register collapse guards across browser windows:
   * - TabGroupCollapse: mark window as collapsed and skip the very next reopen
   * - TabGroupExpand: clear collapsed state
   * - TabOpen: if collapse-skip is set, ensure first reopen is not grouped
   */
  _registerCollapseGuards() {
    // Attach to existing windows
    for (const window of Services.wm.getEnumerator("navigator:browser")) {
      this._addCollapseGuardsToWindow(window);
    }
    // Attach to future windows
    if (!this._windowOpenObserver) {
      this._windowOpenObserver = (subject, topic, _data) => {
        if (topic !== "domwindowopened") {
          return;
        }
        subject.addEventListener(
          "load",
          () => {
            try {
              if (
                subject.document?.documentElement?.getAttribute(
                  "windowtype"
                ) === "navigator:browser"
              ) {
                this._addCollapseGuardsToWindow(subject);
              }
            } catch (_e) {}
          },
          { once: true }
        );
      };
      Services.obs.addObserver(this._windowOpenObserver, "domwindowopened");
    }
  },

  /**
   * Unregister collapse guards across browser windows.
   */
  _unregisterCollapseGuards() {
    // Detach from existing windows
    for (const window of Services.wm.getEnumerator("navigator:browser")) {
      this._removeCollapseGuardsFromWindow(window);
    }
    // Detach from future windows
    if (this._windowOpenObserver) {
      try {
        Services.obs.removeObserver(
          this._windowOpenObserver,
          "domwindowopened"
        );
      } catch (_e) {}
      this._windowOpenObserver = null;
    }
  },

  /**
   * Add collapse/expand and TabOpen guards to a specific browser window.
   * @param {Window} window - The browser window.
   */
  _addCollapseGuardsToWindow(window) {
    if (!window?.gBrowser) {
      return;
    }

    const collapseHandler = () => {
      window.__tabGroupingCollapsed = true;
      window.__tabGroupingSkipNextCreated = true; // do not regroup the very next reopen
      this._log(
        "TabGroupCollapse detected: marking window as collapsed and skipping next reopen"
      );
    };

    const expandHandler = () => {
      window.__tabGroupingCollapsed = false;
      this._log("TabGroupExpand detected: clearing collapsed state");
    };

    const tabOpenHandler = (evt) => {
      // If we just collapsed, ensure the very next reopen is not grouped
      if (window.__tabGroupingSkipNextCreated) {
        window.__tabGroupingSkipNextCreated = false;
        const tab = evt.target;
        try {
          if (tab?.group && window.gBrowser?.ungroupTab) {
            window.gBrowser.ungroupTab(tab);
          }
        } catch (_e) {}
        this._log("First reopen after collapse: ensured ungrouped");
      }
    };

    // Remove previous handlers if present
    if (window.__tabGroupingCollapseGuard) {
      window.removeEventListener(
        "TabGroupCollapse",
        window.__tabGroupingCollapseGuard,
        true
      );
    }
    if (window.__tabGroupingExpandGuard) {
      window.removeEventListener(
        "TabGroupExpand",
        window.__tabGroupingExpandGuard,
        true
      );
    }
    if (window.__tabGroupingTabOpenGuard) {
      window.removeEventListener(
        "TabOpen",
        window.__tabGroupingTabOpenGuard,
        true
      );
    }

    // Store and add
    window.__tabGroupingCollapseGuard = collapseHandler;
    window.__tabGroupingExpandGuard = expandHandler;
    window.__tabGroupingTabOpenGuard = tabOpenHandler;

    window.addEventListener("TabGroupCollapse", collapseHandler, true);
    window.addEventListener("TabGroupExpand", expandHandler, true);
    window.addEventListener("TabOpen", tabOpenHandler, true);
  },

  /**
   * Remove collapse/expand and TabOpen guards from a browser window.
   * @param {Window} window - The browser window.
   */
  _removeCollapseGuardsFromWindow(window) {
    if (window.__tabGroupingCollapseGuard) {
      window.removeEventListener(
        "TabGroupCollapse",
        window.__tabGroupingCollapseGuard,
        true
      );
      delete window.__tabGroupingCollapseGuard;
    }
    if (window.__tabGroupingExpandGuard) {
      window.removeEventListener(
        "TabGroupExpand",
        window.__tabGroupingExpandGuard,
        true
      );
      delete window.__tabGroupingExpandGuard;
    }
    if (window.__tabGroupingTabOpenGuard) {
      window.removeEventListener(
        "TabOpen",
        window.__tabGroupingTabOpenGuard,
        true
      );
      delete window.__tabGroupingTabOpenGuard;
    }
  },
};
