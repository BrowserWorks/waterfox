/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PageActions } from "resource:///modules/PageActions.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FeedSubscribePanel: "resource:///modules/FeedSubscribePanel.sys.mjs",
  LiveBookmarks: "resource:///modules/LiveBookmarks.sys.mjs",
});

const ACTION_ID = "waterfox-feeds";

export const FeedLocationBar = {
  _windows: new WeakSet(),
  _states: new WeakMap(),
  _announcedDocuments: new WeakSet(),

  init(openManager) {
    this._openManager = openManager;
    this._action = PageActions.addAction(
      new PageActions.Action({
        id: ACTION_ID,
        disabled: true,
        pinnedToUrlbar: true,
        wantsSubview: true,
        _transient: true,
        iconURL: "chrome://browser/content/feeds/feed.svg",
        onLocationChange: win => this.update(win).catch(console.error),
        onCommand: (_event, button) => {
          const win = button?.documentGlobal;
          const state = win && this._currentState(win);
          if (state?.feeds.length === 1) {
            this._subscribe(win, state.feeds[0]).catch(console.error);
          }
        },
        onPlacedInUrlbar: button => this._placeButton(button),
        onSubviewShowing: view => this._showFeeds(view),
      })
    );
  },

  onWindowOpened(win) {
    this._windows.add(win);
    this.update(win).catch(console.error);
  },

  _currentState(win) {
    const state = this._states.get(win);
    return !win.closed &&
      state?.browser === win.gBrowser.selectedBrowser &&
      state.global === state.browser.browsingContext.currentWindowGlobal &&
      state.global?.isCurrentGlobal
      ? state
      : null;
  },

  _hidePanel(win) {
    const panel = win.BrowserPageActions.activatedActionPanelNode;
    if (panel?.getAttribute("actionID") === ACTION_ID) {
      win.PanelMultiView.hidePopup(panel);
    }
  },

  _hideButton(win) {
    const button =
      win.BrowserPageActions.urlbarButtonNodeForActionID(ACTION_ID);
    if (button?.contains(win.document.activeElement)) {
      win.gURLBar.focus();
    }
    this._action.setDisabled(true, win);
  },

  async update(win) {
    if (win.closed || !this._windows.has(win)) {
      return;
    }
    lazy.FeedSubscribePanel.hideIfStale(win);
    const browser = win.gBrowser.selectedBrowser;
    const global = browser.browsingContext.currentWindowGlobal;
    let state = this._currentState(win);
    if (!state) {
      this._hidePanel(win);
      this._hideButton(win);
      state = { browser, global, feeds: [] };
      this._states.set(win, state);
    }
    const token = (state.token = {});
    if (!global || !/^https?:/.test(browser.currentURI.spec)) {
      return;
    }
    let feeds = [];
    try {
      await lazy.LiveBookmarks.init();
      feeds = await global.getActor("FeedDiscovery").discover();
    } catch {
      // Navigation may replace the document before its actor is available.
    }
    const title = await win.document.l10n.formatValue("feeds-page-action");
    if (this._currentState(win) !== state || state.token !== token) {
      return;
    }
    state.discoveredFeeds = feeds;
    lazy.FeedSubscribePanel.hideIfStale(win, feeds);
    state.title = title;
    this.subscriptionsChanged(win);
  },

  subscriptionsChanged(win) {
    lazy.FeedSubscribePanel.subscriptionsChanged(win);
    const state = this._currentState(win);
    if (!state?.discoveredFeeds) {
      return;
    }
    const feeds = state.discoveredFeeds.filter(
      feed => !lazy.LiveBookmarks.getByFeedURL(feed.feedURL)
    );
    if (
      feeds.length !== state.feeds.length ||
      feeds.some((feed, index) => feed.feedURL !== state.feeds[index]?.feedURL)
    ) {
      this._hidePanel(win);
    }
    state.feeds = feeds;
    this._action.setWantsSubview(feeds.length > 1, win);
    if (!feeds.length) {
      this._hideButton(win);
      return;
    }
    this._action.setTitle(state.title, win);
    this._action.setDisabled(false, win);
  },

  async _subscribe(win, feed, panel = null) {
    const state = this._currentState(win);
    if (panel && panel.state !== "closed") {
      await new Promise(resolve => {
        panel.addEventListener("popuphidden", resolve, { once: true });
        win.PanelMultiView.hidePopup(panel);
      });
    }
    if (
      state &&
      this._currentState(win) === state &&
      state.feeds.some(item => item.feedURL === feed.feedURL) &&
      !lazy.LiveBookmarks.getByFeedURL(feed.feedURL)
    ) {
      await lazy.FeedSubscribePanel.open(win, feed);
    }
  },

  _placeButton(button) {
    const win = button.documentGlobal;
    const state = this._currentState(win);
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");
    if (state && !this._announcedDocuments.has(state.global)) {
      this._announcedDocuments.add(state.global);
      button.setAttribute("data-feed-discovered", "true");
      button.addEventListener(
        "animationend",
        () => {
          button.removeAttribute("data-feed-discovered");
        },
        { once: true }
      );
    }
  },

  _showFeeds(view) {
    const doc = view.ownerDocument;
    const win = view.documentGlobal;
    const state = this._currentState(win);
    const body = view.querySelector(".panel-subview-body");
    const panel = view.closest("panel");
    const title = this._action.getTitle(win);
    view.setAttribute("aria-label", title);
    if (panel.getAttribute("actionID") === ACTION_ID) {
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", title);
    }
    const anchor =
      win.BrowserPageActions.urlbarButtonNodeForActionID(ACTION_ID);
    anchor?.setAttribute("aria-expanded", "true");
    panel.addEventListener(
      "popuphidden",
      () => {
        anchor?.setAttribute("aria-expanded", "false");
      },
      { once: true }
    );
    body.replaceChildren();
    for (const feed of state?.feeds || []) {
      const button = doc.createXULElement("toolbarbutton");
      button.className = "subviewbutton";
      doc.l10n.setAttributes(button, "feeds-menu-subscribe", {
        title: feed.title || feed.feedURL,
        url: feed.feedURL,
      });
      button.addEventListener("command", () => {
        if (this._currentState(win) === state) {
          this._subscribe(win, feed, panel).catch(console.error);
        }
      });
      body.appendChild(button);
    }
    body.appendChild(doc.createXULElement("toolbarseparator"));
    const manage = doc.createXULElement("toolbarbutton");
    manage.className = "subviewbutton";
    doc.l10n.setAttributes(manage, "feeds-menu-manage");
    manage.addEventListener("command", () => {
      win.PanelMultiView.hidePopup(panel);
      this._openManager(win);
    });
    body.appendChild(manage);
  },
};
