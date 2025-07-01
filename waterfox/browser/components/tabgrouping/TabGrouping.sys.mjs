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

    // Remove keyboard shortcuts
    this._cleanupKeyboardShortcuts();

    // Clear state
    this._lastActiveTab = null;
    this._activeHistory.clear();
  },

  _loadPreferences() {
    this._enabled = lazy.PrefUtils.get(PREFS.ENABLED, true);
    this._placement = lazy.PrefUtils.get(PREFS.PLACEMENT, PLACEMENT_MODES.AFTER);
    this._delayEnabled = lazy.PrefUtils.get(PREFS.DELAY_ENABLED, false);
    this._delayMs = lazy.PrefUtils.get(PREFS.DELAY_MS, 1000);
    this._cancelShortcut = lazy.PrefUtils.get(PREFS.CANCEL_SHORTCUT, 
      Services.appinfo.OS === "Darwin" ? "Alt+`" : "Ctrl+`");
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
    this._snapshotInterval = lazy.setInterval(() => this._refreshSnapshot(), 5000);

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

    // Find source tab
    let sourceTab = this._findSourceTab(newTab, window);
    if (!sourceTab || !sourceTab.group || sourceTab.group === newTab.group) {
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
    let targetIndex;

    switch (this._placement) {
      case PLACEMENT_MODES.AFTER:
        targetIndex = sourceTab._tPos + 1;
        break;

      case PLACEMENT_MODES.FIRST:
        // Find first tab in group
        const groupTabs = gBrowser.tabs.filter(
          tab => tab.group === sourceTab.group && tab !== newTab
        );
        if (groupTabs.length > 0) {
          targetIndex = Math.min(...groupTabs.map(tab => tab._tPos));
        } else {
          targetIndex = sourceTab._tPos;
        }
        break;

      case PLACEMENT_MODES.LAST:
        // No move needed - tab is already at end
        return;
    }

    // Move tab if needed
    if (targetIndex !== undefined && targetIndex !== newTab._tPos) {
      gBrowser.moveTabTo(newTab, targetIndex);
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
    window.__tabGroupingShortcutHandler = handler;
    window.addEventListener("keydown", handler, true);
  },

  _removeShortcutFromWindow(window) {
    if (window.__tabGroupingShortcutHandler) {
      window.removeEventListener("keydown", window.__tabGroupingShortcutHandler, true);
      delete window.__tabGroupingShortcutHandler;
    }
  },

  _parseShortcut(shortcut) {
    const parts = shortcut.split("+");
    const key = parts.pop();
    const modifiers = new Set(parts.map(m => m.toLowerCase()));
    return [modifiers, key];
  },

  _matchesShortcut(event, modifiers, key) {
    // Check key
    if (event.key !== key && event.code !== key) {
      return false;
    }

    // Check modifiers
    const hasCtrl = event.ctrlKey || event.metaKey;
    const hasAlt = event.altKey;
    const hasShift = event.shiftKey;

    const needsCtrl = modifiers.has("ctrl") || modifiers.has("cmd") || modifiers.has("meta");
    const needsAlt = modifiers.has("alt");
    const needsShift = modifiers.has("shift");

    return hasCtrl === needsCtrl && hasAlt === needsAlt && hasShift === needsShift;
  },
};