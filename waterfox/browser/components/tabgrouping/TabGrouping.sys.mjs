/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logger", () =>
  console.createInstance({ prefix: "TabGrouping", maxLogLevel: "Debug" })
);

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

/*
 * Groups a newly opened tab into the group of the tab it came from. The
 * source tab is inferred from the last active tab, with a per window
 * [current, previous] history as the fallback for tabs that open
 * selected. Grouping can be delayed to allow cancellation by shortcut,
 * and a bypass shortcut opens a plain ungrouped tab. Grouping stays
 * suspended through session restore so restored windows reassemble
 * untouched.
 */
export const TabGrouping = {
  _initialized: false,
  _lastActiveTab: null,
  _activeHistory: new Map(),
  _pendingTimers: new Map(),
  _cancelShortcutActive: false,
  _suspended: true,
  _resumeTimer: null,
  // Per window state: collapsed, skipNextCreated, bypassNext, plus the
  // dynamic cancel shortcut handler.
  _windowState: new WeakMap(),

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    for (const pref of Object.values(PREFS)) {
      Services.prefs.addObserver(pref, this);
    }
    Services.obs.addObserver(this, "sessionstore-windows-restored");
  },

  get enabled() {
    return Services.prefs.getBoolPref(PREFS.ENABLED, false);
  },

  observe(_subject, topic, data) {
    switch (topic) {
      case "nsPref:changed":
        if (
          (data == PREFS.ENABLED && !this.enabled) ||
          (data == PREFS.DELAY_ENABLED &&
            !Services.prefs.getBoolPref(PREFS.DELAY_ENABLED, false))
        ) {
          this._cancelAllPending();
        }
        break;
      case "sessionstore-windows-restored": {
        const grace = Services.prefs.getIntPref(PREFS.RESUME_GRACE_MS, 1000);
        this._resumeTimer = lazy.setTimeout(() => {
          this._suspended = false;
          this._resumeTimer = null;
          this._log(`Resuming grouping ${grace}ms after session restore`);
        }, grace);
        Services.obs.removeObserver(this, "sessionstore-windows-restored");
        break;
      }
    }
  },

  onWindowOpened(win) {
    if (this._windowState.has(win)) {
      return;
    }
    const state = {};
    this._windowState.set(win, state);

    const container = win.gBrowser.tabContainer;
    container.addEventListener("TabOpen", event =>
      this._onTabOpen(win, state, event.target)
    );
    container.addEventListener("TabClose", event =>
      this._cancelPendingForTab(event.target)
    );
    container.addEventListener("TabSelect", event =>
      this._onTabActivated(event.target)
    );
    win.addEventListener("activate", () => {
      this._onTabActivated(win.gBrowser.selectedTab);
    });

    // While a group is collapsed, new tabs must not be pulled into it,
    // and the first reopen after a collapse stays ungrouped.
    win.addEventListener("TabGroupCollapse", () => {
      state.collapsed = true;
      state.skipNextCreated = true;
    });
    win.addEventListener("TabGroupExpand", () => {
      state.collapsed = false;
    });

    win.addEventListener(
      "keydown",
      event => this._onKeyDown(win, state, event),
      true
    );

    this._onTabActivated(win.gBrowser.selectedTab);
  },

  _onTabActivated(tab) {
    if (!tab?.documentGlobal) {
      return;
    }
    const windowId = tab.documentGlobal.docShell.outerWindowID;
    const history = this._activeHistory.get(windowId) || [];
    if (history[0] && history[0] !== tab) {
      history.unshift(tab);
    } else {
      history[0] = tab;
    }
    this._activeHistory.set(windowId, history.slice(0, 2));
    this._lastActiveTab = tab;
  },

  _onTabOpen(win, state, newTab) {
    if (state.skipNextCreated) {
      state.skipNextCreated = false;
      if (newTab.group && win.gBrowser.ungroupTab) {
        try {
          win.gBrowser.ungroupTab(newTab);
        } catch (_e) {}
      }
      return;
    }
    if (!this.enabled || this._suspended || state.collapsed) {
      return;
    }
    if (state.bypassNext) {
      state.bypassNext = false;
      return;
    }
    // A tab that arrives with a group came from session restore or undo.
    if (newTab.group) {
      return;
    }

    const sourceTab = this._findSourceTab(newTab, win);
    if (!sourceTab?.group) {
      return;
    }

    if (Services.prefs.getBoolPref(PREFS.DELAY_ENABLED, false)) {
      this._scheduleGrouping(newTab, sourceTab, win.gBrowser);
    } else {
      this._groupTab(newTab, sourceTab, win.gBrowser);
    }
  },

  _findSourceTab(newTab, win) {
    let source = this._lastActiveTab;
    if (newTab.selected && source === newTab) {
      source = null;
    }
    if (!source || source.documentGlobal !== win) {
      const history = this._activeHistory.get(win.docShell.outerWindowID) || [];
      source = newTab.selected ? history[1] : history[0];
    }
    return source;
  },

  _scheduleGrouping(newTab, sourceTab, gBrowser) {
    this._cancelPendingForTab(newTab);
    this._cancelShortcutActive = true;

    const timer = lazy.setTimeout(
      () => {
        this._pendingTimers.delete(newTab);
        if (!this._pendingTimers.size) {
          this._cancelShortcutActive = false;
        }
        this._groupTab(newTab, sourceTab, gBrowser);
      },
      Services.prefs.getIntPref(PREFS.DELAY_MS, 1000)
    );

    this._pendingTimers.set(newTab, timer);
  },

  async _groupTab(newTab, sourceTab, gBrowser) {
    try {
      if (
        !sourceTab ||
        sourceTab === newTab ||
        !sourceTab.group ||
        newTab.group ||
        newTab.documentGlobal !== sourceTab.documentGlobal
      ) {
        return;
      }
      this._log("Grouping new tab into the source group");
      gBrowser.moveTabToExistingGroup(newTab, sourceTab.group);
      this._applyPlacement(newTab, sourceTab, gBrowser);
    } catch (error) {
      console.error("TabGrouping: failed to group tab:", error);
    }
  },

  _applyPlacement(newTab, sourceTab, gBrowser) {
    if (!newTab.group || newTab.group !== sourceTab.group) {
      return;
    }
    switch (Services.prefs.getStringPref(PREFS.PLACEMENT, "after")) {
      case "after":
        gBrowser.moveTabAfter(newTab, sourceTab);
        break;
      case "first": {
        const others = gBrowser.tabs.filter(
          tab => tab.group === sourceTab.group && tab !== newTab
        );
        const first = others.length
          ? others.reduce((min, tab) => (tab._tPos < min._tPos ? tab : min))
          : sourceTab;
        gBrowser.moveTabBefore(newTab, first);
        break;
      }
      // "last" relies on moveTabToGroup appending at the end.
    }
  },

  _onKeyDown(win, state, event) {
    if (this._cancelShortcutActive) {
      const cancel = Services.prefs.getStringPref(PREFS.CANCEL_SHORTCUT, "");
      if (cancel && this._matchesShortcut(event, cancel)) {
        event.preventDefault();
        event.stopPropagation();
        this.cancelPendingGrouping();
        return;
      }
    }

    const bypass = Services.prefs.getStringPref(PREFS.BYPASS_SHORTCUT, "");
    if (this.enabled && bypass && this._matchesShortcut(event, bypass)) {
      event.preventDefault();
      event.stopPropagation();
      state.bypassNext = true;
      win.BrowserCommands.openTab();
    }
  },

  _cancelPendingForTab(tab) {
    const timer = this._pendingTimers.get(tab);
    if (timer) {
      lazy.clearTimeout(timer);
      this._pendingTimers.delete(tab);
      if (!this._pendingTimers.size) {
        this._cancelShortcutActive = false;
      }
    }
  },

  _cancelAllPending() {
    for (const timer of this._pendingTimers.values()) {
      lazy.clearTimeout(timer);
    }
    this._pendingTimers.clear();
    this._cancelShortcutActive = false;
  },

  cancelPendingGrouping() {
    this._log("Cancelling pending grouping");
    this._cancelAllPending();
  },

  _matchesShortcut(event, shortcut) {
    const parts = shortcut.split("+");
    const rawKey = (parts.pop() || "").trim();
    const modifiers = new Set(
      parts.map(part => {
        const name = part.trim().toLowerCase();
        return name == "option" || name == "opt" ? "alt" : name;
      })
    );

    const isBackquote = ["`", "backquote", "backtick", "grave"].includes(
      rawKey.toLowerCase()
    );
    const keyMatches = isBackquote
      ? event.key == "`" || event.code == "Backquote"
      : event.key == rawKey || event.code == rawKey;
    if (!keyMatches) {
      return false;
    }

    return (
      event.ctrlKey == modifiers.has("ctrl") &&
      event.metaKey == (modifiers.has("cmd") || modifiers.has("meta")) &&
      event.altKey == modifiers.has("alt") &&
      event.shiftKey == modifiers.has("shift")
    );
  },

  _log(...args) {
    if (Services.prefs.getBoolPref(PREFS.DEBUG_LOG, false)) {
      lazy.logger.debug(...args);
    }
  },
};
