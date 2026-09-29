/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { PageActions } from "resource:///modules/PageActions.sys.mjs";
import { DISCOVERY_PREF } from "resource:///modules/FeedConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FeedPreview: "resource:///modules/FeedPreview.sys.mjs",
  FeedSubscribePanel: "resource:///modules/FeedSubscribePanel.sys.mjs",
  LiveBookmarks: "resource:///modules/LiveBookmarks.sys.mjs",
});

const ACTION_ID = "waterfox-feeds";
const MAX_PREFETCH_FEEDS = 20;
const PREFETCH_CONCURRENCY = 3;

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
        onCommand: (event, button) => {
          const win = button?.documentGlobal;
          const state = win && this._currentState(win);
          if (state?.feeds.length === 1) {
            this._subscribe(win, state.feeds[0], null, event).catch(
              console.error
            );
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
    return Services.prefs.getBoolPref(DISCOVERY_PREF, true) &&
      !win.closed &&
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
    if (!Services.prefs.getBoolPref(DISCOVERY_PREF, true)) {
      this._states.delete(win);
      this._hidePanel(win);
      this._hideButton(win);
      lazy.FeedSubscribePanel.hideIfStale(win, []);
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
    const preview = lazy.FeedPreview.get(
      browser.browsingContext,
      global?.documentURI?.spec
    );
    if (!global || (!preview && !/^https?:/.test(browser.currentURI.spec))) {
      return;
    }
    let feeds = [];
    try {
      await lazy.LiveBookmarks.init();
      if (this._currentState(win) !== state || state.token !== token) {
        return;
      }
      feeds = preview
        ? [{ feedURL: preview.feedURL, title: preview.feed.title }]
        : await global.getActor("FeedDiscovery").discover();
    } catch {
      // Navigation may replace the document before its actor is available.
    }
    if (this._currentState(win) !== state || state.token !== token) {
      return;
    }
    feeds = feeds.slice(0, MAX_PREFETCH_FEEDS);
    // Drain superseded workers before starting another batch for this state.
    const preload = (state.preload || Promise.resolve()).then(() =>
      this._preloadFeeds(win, state, token, feeds)
    );
    state.preload = preload;
    const { loaded, attempted } = await preload;
    if (this._currentState(win) !== state || state.token !== token) {
      return;
    }
    const title = await win.document.l10n.formatValue("feeds-page-action");
    if (this._currentState(win) !== state || state.token !== token) {
      return;
    }
    state.candidates = feeds;
    state.attemptedFeedURLs = attempted;
    state.discoveredFeeds = feeds.filter(feed => loaded.has(feed.feedURL));
    lazy.FeedSubscribePanel.hideIfStale(win, feeds);
    state.title = title;
    this.subscriptionsChanged(win);
  },

  async _preloadFeeds(win, state, token, feeds) {
    const loaded = new Set();
    const attempted = new Set();
    let index = 0;
    const worker = async () => {
      while (this._currentState(win) === state && state.token === token) {
        const feed = feeds[index++];
        if (!feed) {
          return;
        }
        if (lazy.LiveBookmarks.getByFeedURL(feed.feedURL)) {
          continue;
        }
        attempted.add(feed.feedURL);
        try {
          await lazy.FeedPreview.load(state.global, feed.feedURL);
          loaded.add(feed.feedURL);
        } catch {
          // Failed previews stay hidden; load() briefly caches failures.
        }
      }
    };
    await Promise.all(
      Array.from({ length: PREFETCH_CONCURRENCY }, () => worker())
    );
    return { loaded, attempted };
  },

  subscriptionsChanged(win) {
    lazy.FeedSubscribePanel.subscriptionsChanged(win);
    if (!Services.prefs.getBoolPref(DISCOVERY_PREF, true)) {
      return;
    }
    const state = this._currentState(win);
    if (!state?.discoveredFeeds) {
      return;
    }
    if (
      state.candidates.some(
        feed =>
          !state.attemptedFeedURLs.has(feed.feedURL) &&
          !lazy.LiveBookmarks.getByFeedURL(feed.feedURL)
      )
    ) {
      this.update(win).catch(console.error);
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

  async _subscribe(win, feed, panel = null, triggerEvent = null) {
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
      await lazy.FeedSubscribePanel.open(win, feed, triggerEvent);
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
      button.addEventListener("command", event => {
        if (this._currentState(win) === state) {
          this._subscribe(win, feed, panel, event).catch(console.error);
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
