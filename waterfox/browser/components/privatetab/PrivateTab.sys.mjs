/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ContentSearch: "resource:///actors/ContentSearchParent.sys.mjs",
  ContextualIdentityService:
    "resource://gre/modules/ContextualIdentityService.sys.mjs",
  PlacesUIUtils: "moz-src:///browser/components/places/PlacesUIUtils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  StyleSheetUtils: "resource:///modules/StyleSheetUtils.sys.mjs",
  TabStateCache: "resource:///modules/sessionstore/TabStateCache.sys.mjs",
  TabStateFlusher: "resource:///modules/sessionstore/TabStateFlusher.sys.mjs",
});

const CONTAINER_NAME = "Private";
const SHOW_BUTTON_PREF = "browser.privateTab.showNewTabButton";
const SELECTED_PRIVATE_PREF = "browser.tabs.selectedTabPrivate";
const CSS_URI = "chrome://browser/content/waterfox/privatetab/privatetab.css";

const PLACES_ITEMS = [
  { id: "openPrivate", l10nId: "open-private-tab" },
  { id: "openAllPrivate", l10nId: "open-all-private" },
  { id: "openAllLinksPrivate", l10nId: "open-all-links-private" },
];

export const PrivateTab = {
  _initialized: false,
  _windows: new WeakSet(),
  container: null,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    this.container = this._ensureContainer();
    if (!this.container) {
      console.error("PrivateTab: could not create the private container");
      return;
    }
    // Whatever the previous session left behind in the container.
    this.clearData();

    // The pref is runtime state but lives on the user branch, so a stale
    // value can survive a crash.
    Services.prefs.clearUserPref(SELECTED_PRIVATE_PREF);

    lazy.StyleSheetUtils.registerStylesheet(
      CSS_URI,
      Ci.nsIStyleSheetService.AUTHOR_SHEET
    );

    this._overrideContentSearch();
    Services.obs.addObserver(this, "domwindowclosed");
  },

  _ensureContainer() {
    const find = () =>
      lazy.ContextualIdentityService.getPublicIdentities().find(
        identity => identity.name == CONTAINER_NAME
      );
    let identity = find();
    if (!identity) {
      lazy.ContextualIdentityService.create(
        CONTAINER_NAME,
        "fingerprint",
        "purple"
      );
      identity = find();
    }
    return identity ?? null;
  },

  get userContextId() {
    return this.container?.userContextId;
  },

  isPrivate(tab) {
    return (
      !!this.container && tab?.userContextId == this.container.userContextId
    );
  },

  _isPrivateBrowser(browser) {
    const contextId = parseInt(
      browser?.getAttribute?.("usercontextid") || "0",
      10
    );
    return !!contextId && contextId == this.container?.userContextId;
  },

  observe(_subject, topic) {
    if (topic == "domwindowclosed" && !this._anyPrivateTabs()) {
      this.clearData();
    }
  },

  _anyPrivateTabs() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (win.closed || !win.gBrowser) {
        continue;
      }
      if (win.gBrowser.tabs.some(tab => !tab.closing && this.isPrivate(tab))) {
        return true;
      }
    }
    return false;
  },

  clearData() {
    if (!this.container) {
      return;
    }
    try {
      Services.clearData.deleteDataFromOriginAttributesPattern({
        userContextId: this.container.userContextId,
      });
    } catch (error) {
      console.error("PrivateTab failed to clear container data:", error);
    }
  },

  onWindowOpened(win) {
    if (
      !this.container ||
      this._windows.has(win) ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(win)
    ) {
      return;
    }
    this._windows.add(win);

    this._discardRestoredPrivateTabs(win);
    for (const tab of win.gBrowser.tabs) {
      if (this.isPrivate(tab)) {
        this._markPrivateTab(tab);
      }
    }
    this._initTabListeners(win);
    this._initMenus(win);
    this._initShortcuts(win);
    this._initUrlbar(win);
    this._initNewTabButtons(win);
    this._updatePrivateUI(win);
  },

  _initTabListeners(win) {
    const tabContainer = win.gBrowser.tabContainer;
    tabContainer.addEventListener("TabOpen", event => {
      const tab = event.target;
      if (this.isPrivate(tab)) {
        this._markPrivateTab(tab);
      }
    });
    win.addEventListener("XULFrameLoaderCreated", event => {
      const browser = event.target;
      if (this._isPrivateBrowser(browser)) {
        this._disableBrowserHistory(browser);
        const tab = win.gBrowser.getTabForBrowser(browser);
        if (tab) {
          this._markSessionStatePrivate(tab);
        }
      }
    });
    tabContainer.addEventListener("TabSelect", event => {
      this._updatePrivateUI(win);
      if (this.isPrivate(event.target)) {
        this._markPrivateTab(event.target);
      }
    });
    tabContainer.addEventListener("TabClose", event => {
      if (this.isPrivate(event.target) && !this._anyPrivateTabs()) {
        this.clearData();
      }
    });
    win.addEventListener("activate", () => this._updatePrivateUI(win));
  },

  _updatePrivateUI(win) {
    const isPrivate = this.isPrivate(win.gBrowser.selectedTab);
    Services.prefs.setBoolPref(SELECTED_PRIVATE_PREF, isPrivate);
    win.document.documentElement.toggleAttribute(
      "waterfox-private-tab",
      isPrivate
    );
  },

  _discardRestoredPrivateTabs(win) {
    const privateTabs = win.gBrowser.tabs.filter(tab => this.isPrivate(tab));
    if (!privateTabs.length) {
      return;
    }
    if (privateTabs.length == win.gBrowser.tabs.length) {
      win.gBrowser.selectedTab = win.gBrowser.addTrustedTab(
        win.BROWSER_NEW_TAB_URL,
        {
          skipAnimation: true,
        }
      );
    }
    for (const tab of privateTabs) {
      win.gBrowser.removeTab(tab, {
        animate: false,
        skipPermitUnload: true,
        skipSessionStore: true,
      });
    }
    this.clearData();
  },

  _markPrivateTab(tab) {
    tab.toggleAttribute("waterfox-private", true);
    this._disableBrowserHistory(tab.linkedBrowser);
    this._markSessionStatePrivate(tab);
  },

  _disableBrowserHistory(browser) {
    try {
      if (browser?.browsingContext && !browser.browsingContext.closed) {
        browser.browsingContext.useGlobalHistory = false;
      }
    } catch (_error) {}
  },

  _markSessionStatePrivate(tab) {
    const key = tab.linkedBrowser?.permanentKey;
    if (!key) {
      return;
    }
    lazy.TabStateCache.update(key, {
      isPrivate: true,
      storage: null,
      formdata: null,
    });
  },

  async togglePrivate(win, tab = win.gBrowser.selectedTab) {
    if (
      !this.container ||
      !tab ||
      lazy.PrivateBrowsingUtils.isWindowPrivate(win)
    ) {
      return null;
    }
    const { gBrowser, gURLBar } = win;
    const targetContextId = this.isPrivate(tab)
      ? 0
      : this.container.userContextId;

    await lazy.TabStateFlusher.flush(tab.linkedBrowser);
    if (tab.closing) {
      return null;
    }
    const state = JSON.parse(lazy.SessionStore.getTabState(tab));
    if (targetContextId) {
      state.userContextId = targetContextId;
      state.isPrivate = true;
    } else {
      delete state.userContextId;
      delete state.isPrivate;
    }
    delete state.pinned;

    const selected = tab == gBrowser.selectedTab;
    const focusUrlbar = selected && gURLBar.focused;

    const newTab = gBrowser.addTrustedTab(null, {
      userContextId: targetContextId,
      tabIndex: tab._tPos + 1,
      tabGroup: tab.group ?? undefined,
      skipLoad: true,
    });
    if (targetContextId) {
      this._markPrivateTab(newTab);
    }
    lazy.SessionStore.setTabState(newTab, JSON.stringify(state));
    if (tab.pinned) {
      gBrowser.pinTab(newTab);
    }
    if (selected) {
      gBrowser.selectedTab = newTab;
      if (focusUrlbar) {
        gURLBar.focus();
      }
    }
    gBrowser.removeTab(tab);
    return newTab;
  },

  openNewPrivateTab(win) {
    if (!this.container || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return null;
    }
    const tab = win.gBrowser.addTrustedTab(win.BROWSER_NEW_TAB_URL, {
      userContextId: this.container.userContextId,
      focusUrlBar: true,
    });
    this._markPrivateTab(tab);
    win.gBrowser.selectedTab = tab;
    return tab;
  },

  _initMenus(win) {
    const doc = win.document;

    const toggleItem = doc.getElementById("toggleTabPrivateState");
    doc
      .getElementById("tabContextMenu")
      .addEventListener("popupshowing", () => {
        const tab = win.TabContextMenu?.contextTab;
        toggleItem.hidden = !tab;
        toggleItem.setAttribute(
          "data-l10n-args",
          JSON.stringify({ isPrivate: this.isPrivate(tab) })
        );
      });
    toggleItem.addEventListener("command", () => {
      const tab = win.TabContextMenu?.contextTab;
      if (tab) {
        this.togglePrivate(win, tab);
      }
    });

    doc
      .getElementById("menu_newPrivateTab")
      .addEventListener("command", () => this.openNewPrivateTab(win));

    // webext-panels.xhtml does not load browser/waterfox/private-tabs.ftl;
    // browser.xhtml supplies it here.
    const linkItem = doc.getElementById("openLinkInPrivateTab");
    linkItem.setAttribute("data-l10n-id", "open-link-private");
    linkItem.setAttribute("data-usercontextid", this.container.userContextId);
    const contentContext = doc.getElementById("contentAreaContextMenu");
    contentContext.addEventListener("popupshowing", event => {
      if (event.target != contentContext) {
        return;
      }
      const openInTab = doc.getElementById("context-openlinkintab");
      linkItem.hidden = !openInTab || openInTab.hidden;
    });
    linkItem.addEventListener("command", event => {
      win.gContextMenu?.openLinkInTab(event);
    });

    // The Library window keeps these items hidden and untranslated;
    // browser.xhtml supplies browser/waterfox/private-tabs.ftl here.
    for (const { id, l10nId } of PLACES_ITEMS) {
      doc.getElementById(id)?.setAttribute("data-l10n-id", l10nId);
    }
    const placesContext = doc.getElementById("placesContext");
    placesContext?.addEventListener("popupshowing", () => {
      const shown = stockId => {
        const item = doc.getElementById(stockId);
        return !!item && !item.hidden;
      };
      doc.getElementById("openPrivate").hidden = !shown(
        "placesContext_open:newtab"
      );
      doc.getElementById("openAllPrivate").hidden =
        !shown("placesContext_openContainer:tabs") &&
        !shown("placesContext_openBookmarkContainer:tabs");
      doc.getElementById("openAllLinksPrivate").hidden =
        !shown("placesContext_openLinks:tabs") &&
        !shown("placesContext_openBookmarkLinks:tabs");
    });
    doc
      .getElementById("openPrivate")
      ?.addEventListener("command", () =>
        this._openPlacesPrivate(win, "single")
      );
    doc
      .getElementById("openAllPrivate")
      ?.addEventListener("command", () =>
        this._openPlacesPrivate(win, "container")
      );
    doc
      .getElementById("openAllLinksPrivate")
      ?.addEventListener("command", () =>
        this._openPlacesPrivate(win, "links")
      );
  },

  _openPlacesPrivate(win, mode) {
    const popup = win.document.getElementById("placesContext");
    const view =
      popup.triggerNode && lazy.PlacesUIUtils.getViewForNode(popup.triggerNode);
    const node = view?.selectedNode;
    let urls = [];
    if (mode == "single") {
      if (node?.uri) {
        urls = [node.uri];
      }
    } else if (mode == "container" && node) {
      urls = lazy.PlacesUtils.getURLsForContainerNode(node).map(
        item => item.uri
      );
    } else if (mode == "links") {
      urls = (view?.selectedNodes ?? [])
        .filter(linkNode => linkNode.uri)
        .map(linkNode => linkNode.uri);
    }
    if (!urls.length) {
      return;
    }
    win.gBrowser.loadTabs(urls, {
      userContextId: this.container.userContextId,
      inBackground: Services.prefs.getBoolPref(
        "browser.tabs.loadBookmarksInBackground",
        false
      ),
      replace: false,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  },

  _initShortcuts(win) {
    win.document.addEventListener(
      "keydown",
      event => {
        const accel =
          AppConstants.platform == "macosx" ? event.metaKey : event.ctrlKey;
        if (!accel || !event.altKey || event.shiftKey) {
          return;
        }
        const key = event.key?.toLowerCase();
        if (key == "t") {
          this.togglePrivate(win);
        } else if (key == "p") {
          this.openNewPrivateTab(win);
        } else {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
      },
      true
    );
  },

  _initUrlbar(win) {
    const urlbar = win.gURLBar;
    if (!urlbar) {
      return;
    }
    // The constructor stores a per window snapshot; turn it into a live
    // check so the selected private container tab behaves like a private
    // window for engine choice, history writes and query privacy.
    const windowPrivate = urlbar.isPrivate;
    Object.defineProperty(urlbar, "isPrivate", {
      configurable: true,
      get: () => windowPrivate || this.isPrivate(win.gBrowser.selectedTab),
    });

    const origHandoff = urlbar.handoff.bind(urlbar);
    urlbar.handoff = (searchString, searchEngine, newtabSessionId) => {
      if (this.isPrivate(win.gBrowser.selectedTab)) {
        const privateEngine = lazy.SearchService.defaultPrivateEngine;
        if (
          privateEngine &&
          (!searchEngine ||
            searchEngine.name == lazy.SearchService.defaultEngine?.name)
        ) {
          searchEngine = privateEngine;
        }
      }
      return origHandoff(searchString, searchEngine, newtabSessionId);
    };
  },

  _initNewTabButtons(win) {
    const doc = win.document;
    const buttons = [];
    for (const [anchorId, buttonId] of [
      ["tabs-newtab-button", "newPrivateTab-button"],
      ["vertical-tabs-newtab-button", "newPrivateTab-button-vertical"],
    ]) {
      const anchor = doc.getElementById(anchorId);
      if (!anchor) {
        continue;
      }
      const button = doc.createXULElement("toolbarbutton");
      button.id = buttonId;
      button.className = anchor.className;
      button.setAttribute("data-l10n-id", "new-private-tab");
      button.addEventListener("command", () => this.openNewPrivateTab(win));
      anchor.insertAdjacentElement("afterend", button);
      buttons.push(button);
    }
    if (!buttons.length) {
      return;
    }
    const update = () => {
      const show = Services.prefs.getBoolPref(SHOW_BUTTON_PREF, false);
      for (const button of buttons) {
        button.hidden = !show;
      }
    };
    update();
    Services.prefs.addObserver(SHOW_BUTTON_PREF, update);
    win.addEventListener(
      "unload",
      () => Services.prefs.removeObserver(SHOW_BUTTON_PREF, update),
      { once: true }
    );
  },

  // about:newtab and about:home talk to the parent for their search box;
  // the in-content side cannot tell a private container tab apart, so the
  // parent answers with the private engine and drops form history writes.
  _overrideContentSearch() {
    const search = lazy.ContentSearch;

    const origAddFormHistoryEntry = search.addFormHistoryEntry.bind(search);
    search.addFormHistoryEntry = async (browser, entry = null) => {
      if (this._isPrivateBrowser(browser)) {
        return false;
      }
      return origAddFormHistoryEntry(browser, entry);
    };

    const origOnMessageGetEngine = search._onMessageGetEngine.bind(search);
    search._onMessageGetEngine = async ({ actor }) => {
      const browser = actor?.browsingContext?.top?.embedderElement;
      if (this._isPrivateBrowser(browser)) {
        const state = await search.currentStateObj();
        return search._reply(actor, "Engine", {
          isPrivateEngine: true,
          engine: state.currentPrivateEngine,
        });
      }
      return origOnMessageGetEngine({ actor });
    };
  },
};
