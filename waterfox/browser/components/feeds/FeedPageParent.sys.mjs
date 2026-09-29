/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  isFeedReaderURL,
  MAX_ITEM_DESCRIPTION_LENGTH,
} from "resource:///modules/FeedConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  LiveBookmarks: "resource:///modules/LiveBookmarks.sys.mjs",
  FeedPreview: "resource:///modules/FeedPreview.sys.mjs",
  FeedReaderBridge: "resource:///modules/FeedReaderBridge.sys.mjs",
  sanitizeFeedArticleContent: "resource:///modules/FeedArticleContent.sys.mjs",
  FeedReaderState: "resource:///modules/FeedReaderState.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  PrivateTab: "resource:///modules/PrivateTab.sys.mjs",
});

const CHANGE_TOPIC = "waterfox-live-bookmarks-changed";
const READER_TOPIC = "waterfox-feed-reader-state-changed";
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 1024;
const MAX_PREVIEW_ITEMS = 200;
const MAX_ITEM_ID_LENGTH = 1000;
const PREFERENCES = {
  opening: {
    pref: "browser.feeds.articleOpening",
    values: ["reader", "original"],
  },
  filter: { pref: "browser.feeds.filter", values: ["all", "unread"] },
  display: { pref: "browser.feeds.display", values: ["list", "grid"] },
  order: { pref: "browser.feeds.order", values: ["newest", "oldest"] },
  loadImages: { pref: "browser.feeds.loadImages", values: [true, false] },
};

const GUID_PATTERN = /^[a-zA-Z0-9_-]{12}$/;
const MUTATIONS = new Set([
  "Create",
  "Remove",
  "Refresh",
  "MarkRead",
  "Save",
  "SetPreference",
]);
const READ_ONLY = new Set(["List", "Preview", "DirectPreview", "PreviewURL"]);
const REQUEST_FIELDS = new Map([
  ["List", []],
  ["DirectPreview", []],
  ["PreviewURL", ["feedURL"]],
  ["Create", ["feedURL", "title", "parentGuid"]],
  ["Remove", ["guid"]],
  ["Preview", ["guid"]],
  ["Refresh", ["guid"]],
  ["MarkRead", ["feedURL", "id", "read"]],
  ["Save", ["feedURL", "id", "saved"]],
  ["SetPreference", ["name", "value"]],
  ["OpenSettings", []],
  ["OpenReader", ["feedURL", "id"]],
]);

/** An error identifier safe to expose to about:feeds. */
class FeedPageError extends Error {
  constructor(id) {
    super(id);
    this.id = id;
  }
}

function text(value) {
  return typeof value === "string" ? value.slice(0, MAX_TITLE_LENGTH) : "";
}

function description(value) {
  return typeof value === "string"
    ? value.slice(0, MAX_ITEM_DESCRIPTION_LENGTH)
    : "";
}

function snapshotText(value, maxLength = 1000, preserveLines = false) {
  return typeof value === "string"
    ? value
        .slice(0, maxLength)
        .toWellFormed()
        .replace(/[<>\p{Cc}]/gu, character =>
          preserveLines && character === "\n" ? "\n" : ""
        )
    : "";
}

function feedURL(value, principal, stripRef = true) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_URL_LENGTH ||
    /[\p{Cc}\s]/u.test(value)
  ) {
    throw new FeedPageError("feeds-error-invalid-url");
  }
  try {
    const uri = Services.io.newURI(value);
    if ((!uri.schemeIs("https") && !uri.schemeIs("http")) || uri.userPass) {
      throw new Error("Not an HTTP(S) URL without credentials");
    }
    const normalized = stripRef ? uri.mutate().setRef("").finalize() : uri;
    Services.scriptSecurityManager.checkLoadURIWithPrincipal(
      principal,
      normalized,
      Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL
    );
    if (normalized.spec.length > MAX_URL_LENGTH) {
      throw new Error("URL too long");
    }
    return normalized.spec;
  } catch {
    throw new FeedPageError("feeds-error-invalid-url");
  }
}

/** Grants narrow feed operations to the current, non-system about:feeds page. */
export class FeedPageParent extends JSWindowActorParent {
  #observing = false;
  #busy = false;
  #themeWindow = null;

  #assertPage() {
    try {
      const manager = this.manager;
      const context = this.browsingContext;
      const { documentURI, documentPrincipal } = manager;
      if (
        !context.parent &&
        context.currentWindowGlobal === manager &&
        manager.isCurrentGlobal &&
        manager.remoteType === "privilegedabout" &&
        context.embedderElement &&
        documentURI?.spec.split(/[?#]/, 1)[0] === "about:feeds" &&
        !isFeedReaderURL(documentURI.spec) &&
        documentPrincipal.isContentPrincipal &&
        documentPrincipal.URI?.spec.split(/[?#]/, 1)[0] === "about:feeds"
      ) {
        return;
      }
    } catch {
      // Actor getters can throw after navigation destroys the manager.
    }
    throw new FeedPageError("feeds-error-unavailable");
  }

  get #isPrivate() {
    const browser = this.browsingContext.embedderElement;
    const tab = browser.documentGlobal?.gBrowser?.getTabForBrowser(browser);
    return (
      this.manager.documentPrincipal.originAttributes.privateBrowsingId !== 0 ||
      lazy.PrivateBrowsingUtils.isBrowserPrivate(browser) ||
      (tab && lazy.PrivateTab.isPrivate(tab))
    );
  }

  #assertAllowed(command) {
    this.#assertPage();
    if (MUTATIONS.has(command) && this.#isPrivate) {
      throw new FeedPageError("feeds-error-private");
    }
  }

  #validateRequest(command, data) {
    const fields = REQUEST_FIELDS.get(command);
    if (
      !fields ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      Object.keys(data).some(key => !fields.includes(key)) ||
      (fields.includes("guid") &&
        (typeof data.guid !== "string" || !GUID_PATTERN.test(data.guid))) ||
      (command === "Create" &&
        data.parentGuid !== undefined &&
        (typeof data.parentGuid !== "string" ||
          !GUID_PATTERN.test(data.parentGuid))) ||
      (fields.includes("id") &&
        (typeof data.id !== "string" ||
          !data.id ||
          data.id.length > MAX_ITEM_ID_LENGTH ||
          /\p{Cc}/u.test(data.id))) ||
      ((command === "MarkRead" || command === "Save") &&
        typeof data[command === "MarkRead" ? "read" : "saved"] !== "boolean") ||
      (command === "SetPreference" &&
        (!Object.hasOwn(PREFERENCES, data.name) ||
          !PREFERENCES[data.name].values.includes(data.value))) ||
      (command === "Create" &&
        data.title !== undefined &&
        (typeof data.title !== "string" ||
          data.title.length > MAX_TITLE_LENGTH))
    ) {
      console.error(
        "FeedPage rejected request:",
        command,
        fields ? "Invalid arguments" : "Unknown command"
      );
      throw new FeedPageError("feeds-error-invalid-request");
    }
    if (fields.includes("feedURL")) {
      return {
        ...data,
        feedURL: feedURL(data.feedURL, this.manager.documentPrincipal),
        ...(command === "Create" ? { title: data.title?.trim() || "" } : {}),
      };
    }
    return data;
  }

  async receiveMessage({ name, data }) {
    let acquired = false;
    try {
      this.#assertPage();
      const command = name.startsWith("Feeds:") ? name.slice(6) : "";
      this.#assertAllowed(command);
      const request = this.#validateRequest(command, data);
      if (command === "List") {
        this.#themeWindow?.removeEventListener(
          "windowlwthemeupdate",
          this.#onColorSchemeChange
        );
        this.#themeWindow = this.browsingContext.embedderElement.documentGlobal;
        this.#themeWindow.addEventListener(
          "windowlwthemeupdate",
          this.#onColorSchemeChange
        );
        this.#onColorSchemeChange();
      }
      if (!READ_ONLY.has(command)) {
        if (this.#busy) {
          throw new FeedPageError("feeds-error-busy");
        }
        this.#busy = true;
        acquired = true;
      }
      await lazy.LiveBookmarks.init();
      if (["List", "MarkRead", "Save", "OpenReader"].includes(command)) {
        await lazy.FeedReaderState.init();
      }
      this.#assertAllowed(command);

      let value;
      switch (command) {
        case "List":
          value = await this.#list();
          break;
        case "DirectPreview":
          value = await this.#directPreview();
          break;
        case "PreviewURL": {
          const feed = await lazy.LiveBookmarks.previewURL(
            request.feedURL,
            this.manager.documentPrincipal.originAttributes
          );
          this.#assertAllowed(command);
          const sub = lazy.LiveBookmarks.getByFeedURL(request.feedURL);
          const preview = this.#preview(
            sub || { feedURL: request.feedURL },
            feed
          );
          value = {
            previewURL: lazy.FeedPreview.set(this.browsingContext, {
              feedURL: request.feedURL,
              feed,
            }),
            feedURL: request.feedURL,
            title: preview.title,
            description: preview.description,
            siteURL: preview.siteURL,
            items: preview.items,
            existingGuid: sub?.guid || null,
          };
          break;
        }
        case "Create": {
          const result = await lazy.LiveBookmarks.createWithResult({
            ...request,
            parentGuid:
              request.parentGuid || lazy.PlacesUtils.bookmarks.menuGuid,
          });
          value = {
            ...this.#metadata(result.subscription),
            created: result.created,
          };
          break;
        }
        case "Remove":
          this.#getSubscription(request.guid);
          await lazy.LiveBookmarks.remove(request.guid);
          break;
        case "Preview": {
          const sub = this.#getSubscription(request.guid);
          value = this.#preview(sub, lazy.LiveBookmarks.peek(sub.guid) || {});
          break;
        }
        case "Refresh": {
          const sub = this.#getSubscription(request.guid);
          let result;
          try {
            result = await lazy.LiveBookmarks.refresh(sub.guid, {
              force: true,
            });
          } catch (error) {
            if (error.message?.startsWith("Feed refresh is in backoff")) {
              throw new FeedPageError("feeds-error-retry-later");
            }
            throw error;
          }
          this.#assertAllowed(command);
          value = this.#preview(sub, result);
          break;
        }
        case "OpenReader": {
          const { feedURL: url, snapshot } = this.#findArticle(request);
          const readerURL = lazy.FeedReaderBridge.prepare(this, snapshot);
          if (!this.#isPrivate) {
            lazy.FeedReaderState.setRead(url, request.id, true);
          }
          value = {
            readerURL,
            state: lazy.FeedReaderState.get(url, request.id),
          };
          break;
        }
        case "MarkRead":
        case "Save":
          value = this.#setArticleState(command, request);
          break;
        case "SetPreference":
          if (typeof request.value === "boolean") {
            Services.prefs.setBoolPref(
              PREFERENCES[request.name].pref,
              request.value
            );
          } else {
            Services.prefs.setStringPref(
              PREFERENCES[request.name].pref,
              request.value
            );
          }
          value = this.#preferences();
          break;
        case "OpenSettings":
          this.browsingContext.embedderElement.documentGlobal.openPreferences(
            "paneFeeds"
          );
          break;
      }
      this.#assertPage();
      return { ok: true, value };
    } catch (error) {
      if (!(error instanceof FeedPageError)) {
        console.error("FeedPage operation failed", error);
      }
      return {
        ok: false,
        error:
          error instanceof FeedPageError ? error.id : "feeds-error-operation",
      };
    } finally {
      if (acquired) {
        this.#busy = false;
      }
    }
  }

  async #list() {
    if (!this.#observing) {
      Services.obs.addObserver(this.#onChange, CHANGE_TOPIC);
      Services.obs.addObserver(this.#onChange, READER_TOPIC);
      Services.prefs.addObserver("browser.feeds.", this.#onChange);
      this.#observing = true;
    }
    const folderCache = new Map();
    const getFolder = guid => {
      if (!folderCache.has(guid)) {
        folderCache.set(guid, lazy.PlacesUtils.bookmarks.fetch(guid));
      }
      return folderCache.get(guid);
    };
    const folderGuids = new Set([
      lazy.PlacesUtils.bookmarks.menuGuid,
      lazy.PlacesUtils.bookmarks.toolbarGuid,
      lazy.PlacesUtils.bookmarks.unfiledGuid,
      lazy.PlacesUtils.bookmarks.mobileGuid,
    ]);
    const subscriptions = (
      await Promise.all(
        lazy.LiveBookmarks.list().map(async sub => {
          const metadata = this.#metadata(sub);
          if (!metadata) {
            return null;
          }
          const folder = await getFolder(sub.guid);
          if (folder?.type != lazy.PlacesUtils.bookmarks.TYPE_FOLDER) {
            return null;
          }
          const parent = await getFolder(folder.parentGuid);
          if (
            parent?.type != lazy.PlacesUtils.bookmarks.TYPE_FOLDER ||
            [
              lazy.PlacesUtils.bookmarks.rootGuid,
              lazy.PlacesUtils.bookmarks.tagsGuid,
            ].includes(parent.guid)
          ) {
            return null;
          }
          folderGuids.add(parent.guid);
          return {
            ...metadata,
            parentGuid: parent.guid,
            parentTitle: text(
              lazy.PlacesUtils.bookmarks.getLocalizedTitle(parent)
            ),
          };
        })
      )
    ).filter(Boolean);
    const folders = (
      await Promise.all(
        [...folderGuids].map(async guid => {
          const folder = await getFolder(guid);
          return folder?.type == lazy.PlacesUtils.bookmarks.TYPE_FOLDER
            ? {
                guid: folder.guid,
                title: text(
                  lazy.PlacesUtils.bookmarks.getLocalizedTitle(folder)
                ),
              }
            : null;
        })
      )
    ).filter(Boolean);
    const preferences = this.#preferences();
    const ordered = [...subscriptions].sort(
      (a, b) =>
        a.title.localeCompare(b.title) || a.feedURL.localeCompare(b.feedURL)
    );
    const articles = [];
    for (const sub of ordered) {
      const cached = lazy.LiveBookmarks.cachedFeed(sub.guid);
      if (!cached) {
        continue;
      }
      for (const item of cached.items) {
        const article = this.#article(sub, item, sub.lastUpdated);
        if (article) {
          articles.push(article);
        }
      }
    }
    const subscriptionsByURL = new Map(
      subscriptions.map(sub => [sub.feedURL, sub])
    );
    const savedArticles = lazy.FeedReaderState.listSaved()
      .map(item => {
        const sub = subscriptionsByURL.get(item.feedURL);
        return this.#article(sub, item, sub?.lastUpdated ?? null, {
          read: item.read,
          saved: true,
        });
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          a.source.localeCompare(b.source) ||
          a.feedURL.localeCompare(b.feedURL) ||
          a.id.localeCompare(b.id)
      );
    return {
      isPrivate: this.#isPrivate,
      subscriptions,
      articles,
      savedArticles,
      preferences,
      folders,
    };
  }

  async #directPreview() {
    let direct = lazy.FeedPreview.get(
      this.browsingContext,
      this.manager.documentURI.spec
    );
    if (!direct) {
      const source = lazy.FeedPreview.getFeedURL(this.manager.documentURI.spec);
      if (!source) {
        throw new FeedPageError("feeds-error-preview-expired");
      }
      const url = feedURL(source, this.manager.documentPrincipal);
      const subscription = lazy.LiveBookmarks.getByFeedURL(url);
      const feed =
        (subscription && lazy.LiveBookmarks.cachedFeed(subscription.guid)) ||
        (await lazy.LiveBookmarks.previewURL(
          url,
          this.manager.documentPrincipal.originAttributes
        ));
      this.#assertAllowed("DirectPreview");
      direct = { feedURL: url, feed };
      lazy.FeedPreview.set(this.browsingContext, direct);
      const win = this.browsingContext.embedderElement.documentGlobal;
      win.WaterfoxLiveBookmarks?.updateFeedButton(win);
    }
    const sub = lazy.LiveBookmarks.getByFeedURL(direct.feedURL);
    return {
      ...this.#preview(sub || {}, direct.feed),
      feedURL: direct.feedURL,
      guid: sub?.guid || null,
      existingGuid: sub?.guid || null,
    };
  }

  #setArticleState(command, request) {
    const { feedURL: url, snapshot } = this.#findArticle(request);
    if (command === "MarkRead") {
      lazy.FeedReaderState.setRead(url, request.id, request.read);
    } else {
      try {
        lazy.FeedReaderState.setSaved(url, request.id, request.saved, snapshot);
      } catch (error) {
        if (
          error instanceof RangeError &&
          error.message === "Saved feed entry limit reached"
        ) {
          throw new FeedPageError("feeds-error-saved-limit");
        }
        throw error;
      }
    }
    return lazy.FeedReaderState.get(url, request.id);
  }

  #preferences() {
    return Object.fromEntries(
      Object.entries(PREFERENCES).map(([name, { pref, values }]) => {
        const value =
          typeof values[0] === "boolean"
            ? Services.prefs.getBoolPref(pref, values[0])
            : Services.prefs.getStringPref(pref, values[0]);
        return [name, values.includes(value) ? value : values[0]];
      })
    );
  }

  #article(sub, item, lastUpdated, state) {
    if (
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > MAX_ITEM_ID_LENGTH ||
      /\p{Cc}/u.test(item.id)
    ) {
      return null;
    }
    const url = this.#optionalURL(item.url, false);
    const feed = this.#optionalURL(sub?.feedURL || item.feedURL);
    const title = text(item.title);
    if (!url || !feed || !title.trim()) {
      return null;
    }
    state ||= lazy.FeedReaderState.get(feed, item.id);
    return {
      guid: sub?.guid || null,
      feedURL: feed,
      id: item.id,
      title,
      description: description(item.description),
      url,
      source: text(item.source ?? sub?.title),
      published: item.published ?? null,
      lastUpdated,
      read: state.read,
      saved: state.saved,
    };
  }

  #findArticle({ feedURL: url, id }) {
    const sub = lazy.LiveBookmarks.getByFeedURL(url);
    const item = sub
      ? lazy.LiveBookmarks.cachedFeed(sub.guid)?.items.find(
          entry => entry.id === id
        )
      : null;
    if (item) {
      const link = this.#optionalURL(item.url, false);
      const title = snapshotText(item.title);
      if (link && title.trim()) {
        return {
          feedURL: sub.feedURL,
          snapshot: {
            title,
            url: link,
            description: snapshotText(
              item.description,
              MAX_ITEM_DESCRIPTION_LENGTH,
              true
            ),
            content: lazy.sanitizeFeedArticleContent(item.content, link),
            source: snapshotText(sub.title),
            published: item.published ?? null,
          },
        };
      }
    }
    const saved = lazy.FeedReaderState.listSaved().find(
      entry => entry.feedURL === url && entry.id === id
    );
    if (saved && this.#optionalURL(saved.url, false)) {
      return { feedURL: saved.feedURL, snapshot: saved };
    }
    throw new FeedPageError("feeds-error-not-found");
  }

  #getSubscription(guid) {
    const sub = lazy.LiveBookmarks.get(guid);
    if (!sub) {
      throw new FeedPageError("feeds-error-not-found");
    }
    return sub;
  }

  #optionalURL(value, stripRef = true) {
    try {
      return feedURL(value, this.manager.documentPrincipal, stripRef);
    } catch {
      return "";
    }
  }

  #metadata(sub) {
    if (!sub || !GUID_PATTERN.test(sub.guid)) {
      return null;
    }
    const url = this.#optionalURL(sub.feedURL);
    const cached = lazy.LiveBookmarks.peek(sub.guid);
    return url
      ? {
          guid: sub.guid,
          feedURL: url,
          title: text(sub.title),
          siteURL: this.#optionalURL(sub.siteURL),
          status: cached?.status || "idle",
          lastUpdated: cached?.lastUpdated || null,
        }
      : null;
  }

  #preview(sub, cached = {}) {
    return {
      ...this.#metadata(sub),
      title: text(cached.title) || text(sub.title) || sub.feedURL,
      description: text(cached.description),
      siteURL: this.#optionalURL(cached.siteURL || sub.siteURL),
      items: (Array.isArray(cached.items) ? cached.items : [])
        .slice(0, MAX_PREVIEW_ITEMS)
        .filter(item => item && typeof item === "object")
        .map(item => ({
          id: text(item.id),
          title: text(item.title),
          description: description(item.description),
          url: this.#optionalURL(item.url, false),
          published: item.published ?? null,
        })),
    };
  }

  #onColorSchemeChange = () => {
    try {
      this.#assertPage();
      const win = this.#themeWindow;
      let colorScheme = win.browsingContext.prefersColorSchemeOverride;
      if (colorScheme === "none") {
        colorScheme = win.matchMedia("(-moz-system-dark-theme)").matches
          ? "dark"
          : "light";
      }
      this.sendAsyncMessage("Feeds:ColorScheme", { colorScheme });
    } catch {}
  };

  #onChange = () => {
    try {
      this.#assertPage();
      this.sendAsyncMessage("Feeds:Changed");
    } catch {
      // Inactive and navigating documents must not receive subscription data.
    }
  };

  didDestroy() {
    this.#themeWindow?.removeEventListener(
      "windowlwthemeupdate",
      this.#onColorSchemeChange
    );
    this.#themeWindow = null;
    if (this.#observing) {
      Services.obs.removeObserver(this.#onChange, CHANGE_TOPIC);
      Services.obs.removeObserver(this.#onChange, READER_TOPIC);
      Services.prefs.removeObserver("browser.feeds.", this.#onChange);
      this.#observing = false;
    }
  }
}
