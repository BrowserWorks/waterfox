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

const PREFS = {
  ENABLED: "browser.tabs.autoGroupNewTabs",
  PLACEMENT: "browser.tabs.autoGroupNewTabs.placement",
  DELAY_ENABLED: "browser.tabs.autoGroupNewTabs.delayEnabled",
  DELAY_MS: "browser.tabs.autoGroupNewTabs.delayMs",
  CANCEL_SHORTCUT: "browser.tabs.autoGroupNewTabs.cancelShortcut",
};

const PLACEMENT_MODES = {
  AFTER: "after",
  FIRST: "first",
  LAST: "last",
};

export const TabGrouping = {
  _initialized: false,
  _enabled: true,
  _placement: PLACEMENT_MODES.AFTER,
  _delayEnabled: false,
  _delayMs: 1000,
  _cancelShortcut: "",
  _skipCreatedTabs: new WeakSet(),

  // Active tab tracking
  _lastActiveTab: null,
  _activeHistory: new Map(), // windowId → [current, previous]
  _snapshotInterval: null,

  // Pending operations
  _pendingTimers: new Map(), // tabId → timer
  _cancelShortcutActive: false,

  init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;

    // Load preferences
    this._loadPreferences();
    this._setupPrefObservers();

    // Start active tab tracking
    this._startActiveTabTracking();

    // Add tab event listeners
    this._addEventListeners();

    // Register collapse listeners across windows
    this._registerCollapseListeners();

    // Setup keyboard shortcuts
    this._setupKeyboardShortcuts();
  },

  shutdown() {
    if (!this._initialized) {
      return;
    }

    this._initialized = false;

    // Stop tracking
    if (this._snapshotInterval) {
      lazy.clearInterval(this._snapshotInterval);
      this._snapshotInterval = null;
    }

    // Clear pending timers
    this._cancelAllPending();

    // Remove event listeners
    this._removeEventListeners();

    // Unregister collapse listeners
    this._unregisterCollapseListeners();

    // Remove keyboard shortcuts
    this._cleanupKeyboardShortcuts();

    // Clear state
    this._lastActiveTab = null;
    this._activeHistory.clear();
  },

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
      Services.appinfo.OS === "Darwin" ? "Alt+`" : "Ctrl+`"
    );
  },

  _setupPrefObservers() {
    this._prefObservers = [
      lazy.PrefUtils.addObserver(PREFS.ENABLED, (value) => {
        this._enabled = value;
        if (!value) {
          this._cancelAllPending();
        }
      }),
      lazy.PrefUtils.addObserver(PREFS.PLACEMENT, (value) => {
        this._placement = value;
      }),
      lazy.PrefUtils.addObserver(PREFS.DELAY_ENABLED, (value) => {
        this._delayEnabled = value;
        if (!value) {
          this._cancelAllPending();
        }
      }),
      lazy.PrefUtils.addObserver(PREFS.DELAY_MS, (value) => {
        this._delayMs = value;
      }),
      lazy.PrefUtils.addObserver(PREFS.CANCEL_SHORTCUT, (value) => {
        this._cancelShortcut = value;
        this._updateKeyboardShortcut();
      }),
    ];
  },

  _startActiveTabTracking() {
    this._refreshSnapshot();
    this._snapshotInterval = lazy.setInterval(
      () => this._refreshSnapshot(),
      5000
    );

    // Listen for tab switches
    Services.obs.addObserver(this, "browser-tab-activated");
    Services.obs.addObserver(this, "browser-window-focus-changed");
  },

  _refreshSnapshot() {
    const window = Services.wm.getMostRecentWindow("navigator:browser");
    if (window && window.gBrowser) {
      const tab = window.gBrowser.selectedTab;
      if (tab) {
        this._lastActiveTab = tab;
      }
    }
  },

  _addEventListeners() {
    Services.obs.addObserver(this, "browser-tab-created");
    Services.obs.addObserver(this, "browser-tab-removed");
  },

  _removeEventListeners() {
    Services.obs.removeObserver(this, "browser-tab-created");
    Services.obs.removeObserver(this, "browser-tab-removed");
    Services.obs.removeObserver(this, "browser-tab-activated");
    Services.obs.removeObserver(this, "browser-window-focus-changed");
  },

  observe(subject, topic, data) {
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
    }
  },

  _handleTabActivated(tab) {
    if (!tab || !tab.ownerGlobal) {
      return;
    }

    const window = tab.ownerGlobal;
    const windowId = window.docShell.outerWindowID;
    const history = this._activeHistory.get(windowId) || [];

    // Update history: [current, previous]
    if (history[0] && history[0] !== tab) {
      history.unshift(tab);
    } else {
      history[0] = tab;
    }

    this._activeHistory.set(windowId, history.slice(0, 2));
    this._lastActiveTab = tab;
  },

  async _handleTabCreated(newTab) {
    if (!this._enabled || !newTab || !newTab.ownerGlobal) {
      return;
    }

    const window = newTab.ownerGlobal;
    const gBrowser = window.gBrowser;

    if (this._skipCreatedTabs.has(newTab)) {
      return;
    }

    // Skip once after a TabGroupCollapse fallback new tab so it remains ungrouped.
    if (window.__tabGroupingSkipNextCreated) {
      return;
    }

    // Find source tab
    const sourceTab = this._findSourceTab(newTab, window);
    if (!sourceTab || !sourceTab.group) {
      return;
    }

    // Apply grouping with delay if enabled
    if (this._delayEnabled) {
      this._scheduleGrouping(newTab, sourceTab, gBrowser);
    } else {
      this._groupTab(newTab, sourceTab, gBrowser);
    }
  },

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

  _scheduleGrouping(newTab, sourceTab, gBrowser) {
    // Cancel any existing timer for this tab
    this._cancelPendingForTab(newTab);

    // Enable cancel shortcut if needed
    if (!this._cancelShortcutActive) {
      this._enableCancelShortcut();
    }

    // Schedule grouping
    const timer = lazy.setTimeout(() => {
      this._pendingTimers.delete(newTab);
      if (this._pendingTimers.size === 0) {
        this._disableCancelShortcut();
      }
      this._groupTab(newTab, sourceTab, gBrowser);
    }, this._delayMs);

    this._pendingTimers.set(newTab, timer);
  },

  async _groupTab(newTab, sourceTab, gBrowser) {
    try {
      // Ensure tabs are still valid and in same window
      if (!sourceTab.group || newTab.ownerGlobal !== sourceTab.ownerGlobal) {
        return;
      }

      // Move tab to group

      gBrowser.moveTabToGroup(newTab, sourceTab.group);

      // Apply placement
      await this._applyPlacement(newTab, sourceTab, gBrowser);
    } catch (error) {
      Cu.reportError(`TabGrouping: Failed to group tab: ${error}`);
    }
  },

  async _applyPlacement(newTab, sourceTab, gBrowser) {
    switch (this._placement) {
      case PLACEMENT_MODES.AFTER: {
        // Keep the tab inside the group by moving relative to a tab in the same group.
        gBrowser.moveTabAfter(newTab, sourceTab);
        break;
      }

      case PLACEMENT_MODES.FIRST: {
        // Find the first tab in the same group (excluding the new tab itself)
        const groupTabs = gBrowser.tabs.filter(
          (tab) => tab.group === sourceTab.group && tab !== newTab
        );
        if (groupTabs.length > 0) {
          const firstTab = groupTabs.reduce(
            (min, t) => (t._tPos < min._tPos ? t : min),
            groupTabs[0]
          );
          gBrowser.moveTabBefore(newTab, firstTab);
        } else {
          // If there are no other tabs yet, place before the source tab.
          gBrowser.moveTabBefore(newTab, sourceTab);
        }
        break;
      }

      case PLACEMENT_MODES.LAST: {
        // Explicitly move to the last tab in the source group
        const groupTabs = gBrowser.tabs.filter(
          (tab) => tab.group === sourceTab.group && tab !== newTab
        );
        if (groupTabs.length > 0) {
          const lastTab = groupTabs.reduce(
            (max, t) => (t._tPos > max._tPos ? t : max),
            groupTabs[0]
          );
          gBrowser.moveTabAfter(newTab, lastTab);
        } else {
          // If there are no other tabs yet, place after the source tab.
          gBrowser.moveTabAfter(newTab, sourceTab);
        }
        return;
      }
    }
  },

  _handleTabRemoved(tab) {
    this._cancelPendingForTab(tab);
  },

  _cancelPendingForTab(tab) {
    if (this._pendingTimers.has(tab)) {
      lazy.clearTimeout(this._pendingTimers.get(tab));
      this._pendingTimers.delete(tab);

      if (this._pendingTimers.size === 0) {
        this._disableCancelShortcut();
      }
    }
  },

  _cancelAllPending() {
    for (const timer of this._pendingTimers.values()) {
      lazy.clearTimeout(timer);
    }
    this._pendingTimers.clear();
    this._disableCancelShortcut();
  },

  _enableCancelShortcut() {
    this._cancelShortcutActive = true;
    // Enable the keyboard shortcut
    this._updateKeyboardShortcut();
  },

  _disableCancelShortcut() {
    this._cancelShortcutActive = false;
    // Disable the keyboard shortcut
    this._unregisterKeyboardShortcut();
  },

  // Public API for canceling pending operations
  cancelPendingGrouping() {
    this._cancelAllPending();
  },

  _setupKeyboardShortcuts() {
    // Register observer for keyboard shortcut notifications
    Services.obs.addObserver(this, "browser-cancel-auto-grouping");
  },

  _cleanupKeyboardShortcuts() {
    try {
      Services.obs.removeObserver(this, "browser-cancel-auto-grouping");
    } catch (e) {
      // Observer might not be registered
    }
    this._unregisterKeyboardShortcut();
  },

  _updateKeyboardShortcut() {
    if (this._cancelShortcutActive && this._cancelShortcut) {
      this._registerKeyboardShortcut();
    } else {
      this._unregisterKeyboardShortcut();
    }
  },

  _registerKeyboardShortcut() {
    // Register the shortcut with all browser windows
    for (const window of Services.wm.getEnumerator("navigator:browser")) {
      this._addShortcutToWindow(window);
    }
  },

  _unregisterKeyboardShortcut() {
    // Unregister the shortcut from all browser windows
    for (const window of Services.wm.getEnumerator("navigator:browser")) {
      this._removeShortcutFromWindow(window);
    }
  },

  _addShortcutToWindow(window) {
    if (!window.gBrowser || !this._cancelShortcut) {
      return;
    }

    // Parse the shortcut
    const [modifiers, key] = this._parseShortcut(this._cancelShortcut);
    if (!key) {
      return;
    }

    // Create keyboard event handler
    const handler = (event) => {
      if (this._matchesShortcut(event, modifiers, key)) {
        event.preventDefault();
        event.stopPropagation();
        Services.obs.notifyObservers(null, "browser-cancel-auto-grouping");
      }
    };

    // Store handler reference
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

  _registerCollapseListeners() {
    // Attach collapse listeners to all current and future browser windows
    for (const window of Services.wm.getEnumerator("navigator:browser")) {
      this._addCollapseListenerToWindow(window);
    }
    if (!this._windowOpenObserver) {
      this._windowOpenObserver = (subject, topic, data) => {
        if (topic !== "domwindowopened") {
          return;
        }
        // Wait for load before checking window type
        subject.addEventListener(
          "load",
          () => {
            try {
              if (
                subject.document?.documentElement?.getAttribute(
                  "windowtype"
                ) === "navigator:browser"
              ) {
                this._addCollapseListenerToWindow(subject);
              }
            } catch (_) {}
          },
          { once: true }
        );
      };
      Services.obs.addObserver(this._windowOpenObserver, "domwindowopened");
    }
  },

  _unregisterCollapseListeners() {
    for (const window of Services.wm.getEnumerator("navigator:browser")) {
      this._removeCollapseListenerFromWindow(window);
    }
    if (this._windowOpenObserver) {
      try {
        Services.obs.removeObserver(
          this._windowOpenObserver,
          "domwindowopened"
        );
      } catch (_) {}
      this._windowOpenObserver = null;
    }
  },

  _addCollapseListenerToWindow(window) {
    if (!window?.gBrowser) {
      return;
    }
    const collapseHandler = () => {
      // Mark to skip the next created tab in this window (created by collapse fallback)
      window.__tabGroupingSkipNextCreated = true;
    };
    const tabOpenHandler = (evt) => {
      if (!window.__tabGroupingSkipNextCreated) {
        return;
      }
      // Clear the flag and ensure the fallback tab is ungrouped
      window.__tabGroupingSkipNextCreated = false;
      const tab = evt.target;
      this._skipCreatedTabs.add(tab);

      try {
        if (tab?.group) {
          window.gBrowser.ungroupTab(tab);
        }
      } catch (e) {}
    };
    if (window.__tabGroupingCollapseHandler) {
      window.removeEventListener(
        "TabGroupCollapse",
        window.__tabGroupingCollapseHandler,
        true
      );
    }
    if (window.__tabGroupingTabOpenHandler) {
      window.removeEventListener(
        "TabOpen",
        window.__tabGroupingTabOpenHandler,
        true
      );
    }
    window.__tabGroupingCollapseHandler = collapseHandler;
    window.__tabGroupingTabOpenHandler = tabOpenHandler;
    window.addEventListener("TabGroupCollapse", collapseHandler, true);
    window.addEventListener("TabOpen", tabOpenHandler, true);
  },

  _removeCollapseListenerFromWindow(window) {
    if (window.__tabGroupingCollapseHandler) {
      window.removeEventListener(
        "TabGroupCollapse",
        window.__tabGroupingCollapseHandler,
        true
      );
      delete window.__tabGroupingCollapseHandler;
    }
    if (window.__tabGroupingTabOpenHandler) {
      window.removeEventListener(
        "TabOpen",
        window.__tabGroupingTabOpenHandler,
        true
      );
      delete window.__tabGroupingTabOpenHandler;
    }
  },

  _parseShortcut(shortcut) {
    const parts = shortcut.split("+");
    const rawKey = (parts.pop() || "").trim();
    const modifiers = new Set(parts.map((m) => m.trim().toLowerCase()));
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
};
