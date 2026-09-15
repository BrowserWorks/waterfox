/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
  FeedLocationBar: "resource:///modules/FeedLocationBar.sys.mjs",
  FeedSubscribePanel: "resource:///modules/FeedSubscribePanel.sys.mjs",
  LiveBookmarks: "resource:///modules/LiveBookmarks.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

const TOPIC = "waterfox-live-bookmarks-changed";
const ICON = "chrome://browser/content/feeds/feed.svg";

export const LiveBookmarksUI = {
  _windows: new WeakSet(),
  _ready: false,

  init() {
    ChromeUtils.registerWindowActor("FeedDiscovery", {
      parent: { esModuleURI: "resource:///actors/FeedDiscoveryParent.sys.mjs" },
      child: {
        esModuleURI: "resource:///actors/FeedDiscoveryChild.sys.mjs",
        events: {
          DOMContentLoaded: {},
          pageshow: {},
          pagehide: { createActor: false },
        },
      },
      matches: ["http://*/*", "https://*/*"],
      allFrames: false,
      messageManagerGroups: ["browsers"],
    });
    ChromeUtils.registerWindowActor("FeedPage", {
      parent: { esModuleURI: "resource:///actors/FeedPageParent.sys.mjs" },
      child: {
        esModuleURI: "resource:///actors/FeedPageChild.sys.mjs",
        events: { "FeedPage:Request": { capture: true, wantUntrusted: true } },
      },
      matches: ["about:feeds", "about:feeds?*"],
      allFrames: false,
      remoteTypes: ["privilegedabout"],
      messageManagerGroups: ["browsers"],
    });
    lazy.FeedLocationBar.init((win, feedURL) => this.openManager(win, feedURL));
    Services.obs.addObserver(this, TOPIC);
    Services.obs.addObserver(this, "quit-application-granted");
    lazy.CustomizableUI.createWidget({
      id: "waterfox-feeds-button",
      type: "custom",
      onBuild: doc => {
        const button = doc.createXULElement("toolbarbutton");
        button.id = "waterfox-feeds-button";
        button.className = "toolbarbutton-1 chromeclass-toolbar-additional";
        button.setAttribute("type", "menu");
        button.setAttribute("image", ICON);
        doc.defaultView.MozXULElement.insertFTLIfNeeded(
          "browser/waterfox/feeds.ftl"
        );
        doc.l10n.setAttributes(button, "feeds-toolbar-button");
        const popup = doc.createXULElement("menupopup");
        popup.addEventListener("popupshowing", event => {
          if (event.target == popup) {
            this.populateDiscovery(popup);
          }
        });
        button.appendChild(popup);
        return button;
      },
    });
    lazy.LiveBookmarks.init()
      .then(() => {
        this._ready = true;
        this.updateWindows();
      })
      .catch(console.error);
  },

  onWindowOpened(win) {
    if (this._windows.has(win)) {
      return;
    }
    this._windows.add(win);
    win.WaterfoxLiveBookmarks = this;
    const doc = win.document;
    win.MozXULElement.insertFTLIfNeeded("browser/waterfox/feeds.ftl");
    const style = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
    style.rel = "stylesheet";
    style.href = "chrome://browser/content/feeds/bookmarks.css";
    doc.documentElement.appendChild(style);

    const menu = doc.createXULElement("menu");
    menu.id = "waterfox-feeds-menu";
    menu.className = "menu-iconic";
    menu.setAttribute("image", ICON);
    doc.l10n.setAttributes(menu, "feeds-menu-label");
    const popup = doc.createXULElement("menupopup");
    popup.addEventListener("popupshowing", event => {
      if (event.target == popup) {
        this.populateDiscovery(popup);
      }
    });
    menu.appendChild(popup);
    const bookmarks = doc.getElementById("bookmarksMenuPopup");
    bookmarks?.insertBefore(menu, bookmarks.firstElementChild);
    this.decorateWindow(win);
    lazy.FeedLocationBar.onWindowOpened(win);
  },

  updateFeedButton(win) {
    return lazy.FeedLocationBar.update(win).catch(console.error);
  },

  observe(subject, topic) {
    if (topic == "quit-application-granted") {
      Services.obs.removeObserver(this, TOPIC);
      Services.obs.removeObserver(this, "quit-application-granted");
      return;
    }
    if (this._ready) {
      this.updateWindows();
    }
  },

  updateWindows() {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (this._windows.has(win)) {
        this.decorateWindow(win);
        lazy.FeedLocationBar.subscriptionsChanged(win);
      }
    }
  },

  decorateWindow(win) {
    for (const element of win.document.querySelectorAll(
      ".bookmark-item[container]"
    )) {
      this.decorateFolder(element, element._placesNode);
    }
  },

  decorateFolder(element, node) {
    if (
      !this._ready ||
      !node ||
      !lazy.PlacesUtils.nodeIsFolderOrShortcut(node)
    ) {
      return;
    }
    const guid = lazy.PlacesUtils.getConcreteItemGuid(node);
    element.classList.toggle(
      "waterfox-live-bookmark",
      !!lazy.LiveBookmarks.get(guid)
    );
  },

  openManager(win, feedURL = "", title = "") {
    const params = new URLSearchParams();
    if (feedURL) {
      params.set("url", feedURL);
      if (title) {
        params.set("title", title);
      }
    }
    const url = params.size ? `about:feeds?${params}` : "about:feeds";
    win.openTrustedLinkIn(url, "tab");
  },

  _command(popup, id, callback) {
    const item = popup.ownerDocument.createXULElement("menuitem");
    popup.ownerDocument.l10n.setAttributes(item, id);
    item.addEventListener("command", event => {
      event.stopPropagation();
      callback?.(event);
    });
    popup.appendChild(item);
    return item;
  },

  async populateDiscovery(popup) {
    const win = popup.documentGlobal;
    const browser = win.gBrowser.selectedBrowser;
    const global = browser.browsingContext.currentWindowGlobal;
    const token = {};
    popup._feedDiscoveryToken = token;
    popup.replaceChildren();
    this._command(popup, "feeds-menu-manage", () => this.openManager(win));
    popup.appendChild(popup.ownerDocument.createXULElement("menuseparator"));
    const status = this._command(popup, "feeds-menu-discovering");
    status.disabled = true;
    let feeds = [];
    try {
      await lazy.LiveBookmarks.init();
      if (/^https?:/.test(browser.currentURI.spec)) {
        feeds = await global.getActor("FeedDiscovery").discover();
      }
    } catch (error) {
      console.error("Live Bookmarks discovery failed", error);
    }
    if (
      popup._feedDiscoveryToken != token ||
      !popup.isConnected ||
      browser != win.gBrowser.selectedBrowser ||
      global != browser.browsingContext.currentWindowGlobal
    ) {
      return;
    }
    const available = feeds.filter(
      feed => !lazy.LiveBookmarks.getByFeedURL(feed.feedURL)
    );
    if (!available.length) {
      popup.ownerDocument.l10n.setAttributes(
        status,
        feeds.length ? "feeds-menu-all-subscribed" : "feeds-menu-no-feeds"
      );
      return;
    }
    status.remove();
    for (const feed of available) {
      const item = this._command(popup, "feeds-menu-subscribe", () => {
        if (
          browser === win.gBrowser.selectedBrowser &&
          global === browser.browsingContext.currentWindowGlobal &&
          !lazy.LiveBookmarks.getByFeedURL(feed.feedURL)
        ) {
          lazy.FeedSubscribePanel.open(win, feed).catch(console.error);
        }
      });
      popup.ownerDocument.l10n.setAttributes(item, "feeds-menu-subscribe", {
        title: feed.title || feed.feedURL,
        url: feed.feedURL,
      });
    }
  },

  populatePopup(popup) {
    const node = popup._placesNode;
    if (
      !this._ready ||
      !node ||
      !lazy.PlacesUtils.nodeIsFolderOrShortcut(node)
    ) {
      return;
    }
    const guid = lazy.PlacesUtils.getConcreteItemGuid(node);
    if (!lazy.LiveBookmarks.get(guid)) {
      this._clearItems(popup);
      return;
    }
    this._renderPopup(popup, guid);
    if (!lazy.PrivateBrowsingUtils.isWindowPrivate(popup.documentGlobal)) {
      lazy.LiveBookmarks.refresh(guid)
        .catch(() => {})
        .finally(() => {
          // Native macOS menus cannot safely rebuild while they are open.
          if (
            popup.isConnected &&
            popup.hasAttribute("nonnative") &&
            popup.state == "open" &&
            lazy.LiveBookmarks.get(guid)
          ) {
            this._renderPopup(popup, guid);
          }
        });
    }
  },

  _clearItems(popup) {
    for (const item of popup.querySelectorAll(":scope > [data-feed-item]")) {
      item.remove();
    }
  },

  _renderPopup(popup, guid) {
    const sub = lazy.LiveBookmarks.get(guid);
    if (!sub) {
      return;
    }
    const state = lazy.LiveBookmarks.peek(guid);
    // Keep selected commands/items stable when a background refresh completes.
    if (
      popup.state == "open" &&
      popup.querySelector(":scope > [data-feed-item][_moz-menuactive]")
    ) {
      return;
    }
    this._clearItems(popup);
    popup._emptyMenuitem?.remove();
    popup.removeAttribute("emptyplacesresult");
    const doc = popup.ownerDocument;
    const win = doc.defaultView;

    const fragment = doc.createDocumentFragment();
    const add = item => {
      item.setAttribute("data-feed-item", "true");
      fragment.appendChild(item);
      return item;
    };
    if (popup._placesNode.childCount) {
      add(doc.createXULElement("menuseparator"));
    }
    const siteURL = state?.siteURL || sub.siteURL;
    if (siteURL) {
      const site = add(
        this._linkItem(doc, { url: siteURL, title: sub.title || siteURL })
      );
      doc.l10n.setAttributes(site, "feeds-menu-open-site", { url: siteURL });
      add(doc.createXULElement("menuseparator"));
    }
    for (const entry of state?.items || []) {
      add(this._linkItem(doc, entry, true));
    }
    if (!state?.items.length || state.status == "error") {
      const status = add(doc.createXULElement("menuitem"));
      status.disabled = true;
      let message = "feeds-menu-loading";
      if (state?.status == "error") {
        message = "feeds-menu-error";
      } else if (state?.status == "ready") {
        message = "feeds-menu-empty";
      } else if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
        message = "feeds-menu-no-cache";
      }
      doc.l10n.setAttributes(status, message);
    }
    add(doc.createXULElement("menuseparator"));
    const reload = this._command(fragment, "feeds-menu-reload", () => {
      lazy.LiveBookmarks.refresh(guid, { force: true }).catch(console.error);
    });
    reload.setAttribute("data-feed-item", "true");
    reload.disabled = lazy.PrivateBrowsingUtils.isWindowPrivate(win);
    const manage = this._command(fragment, "feeds-menu-manage", () =>
      this.openManager(win)
    );
    manage.setAttribute("data-feed-item", "true");
    popup.insertBefore(fragment, popup._endMarker?.nextSibling || null);
  },

  _linkItem(doc, entry, visitedState = false) {
    const item = doc.createXULElement("menuitem");
    item.className =
      "menuitem-iconic menuitem-with-favicon waterfox-feed-entry";
    item.setAttribute("label", entry.title || entry.url);
    item.setAttribute("tooltiptext", entry.url);
    try {
      const iconURL = new URL(entry.url);
      if (
        ["http:", "https:"].includes(iconURL.protocol) &&
        !iconURL.username &&
        !iconURL.password
      ) {
        item.setAttribute(
          "image",
          "page-icon:" + ChromeUtils.encodeURIForSrcset(entry.url)
        );
      }
    } catch {}
    const open = event => {
      event.stopPropagation();
      const url = new URL(entry.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      ) {
        return;
      }
      const win = doc.defaultView;
      win.openWebLinkIn(
        url.href,
        lazy.BrowserUtils.whereToOpenLink(event, false, true),
        {
          allowInheritPrincipal: false,
        }
      );
    };
    item.addEventListener("command", open);
    item.addEventListener("click", event => {
      event.stopPropagation();
      if (event.button == 1) {
        open(event);
        doc.defaultView.closeMenus(item);
      }
    });
    item.addEventListener("contextmenu", event => {
      event.preventDefault();
      event.stopPropagation();
    });
    item.addEventListener("dragstart", event => {
      event.stopPropagation();
      event.dataTransfer.setData(
        "text/x-moz-url",
        `${entry.url}\n${entry.title}`
      );
      event.dataTransfer.setData("text/uri-list", entry.url);
      event.dataTransfer.setData("text/plain", entry.url);
      event.dataTransfer.effectAllowed = "copyLink";
    });
    if (visitedState) {
      lazy.PlacesUtils.history
        .hasVisits(entry.url)
        .then(visited => {
          item.classList.toggle("waterfox-feed-unread", !visited);
          doc.l10n.setAttributes(
            item,
            visited ? "feeds-entry-visited" : "feeds-entry-unvisited",
            {
              title: entry.title || entry.url,
              url: entry.url,
            }
          );
        })
        .catch(console.error);
    }
    return item;
  },
};
