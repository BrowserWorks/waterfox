/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  parseFeed: "resource:///modules/FeedParser.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const VERSION = 1;
const CACHE_VERSION = 1;
const MAX_CACHED_FEED_BYTES = 128 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const MAX_SUBSCRIPTIONS = 200;
export const MAX_FEED_URL_LENGTH = 4096;
const MAX_BYTES = 2 * 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const MAX_BACKOFF = 24 * HOUR;
const SCHEDULE_INTERVAL = 60 * 1000;
const TOPIC = "waterfox-live-bookmarks-changed";
const PLACES_EVENTS = ["bookmark-removed", "bookmark-title-changed"];

function httpURL(value) {
  if (typeof value != "string") {
    throw new Error("A feed URL must be an HTTP(S) URL without credentials");
  }
  if (value.length > MAX_FEED_URL_LENGTH) {
    throw new Error("Feed URLs must not exceed 4096 characters");
  }
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    /^https?:\/\/[^/?#]*@/i.test(value.trim().replace(/\\/g, "/"))
  ) {
    throw new Error("A feed URL must be an HTTP(S) URL without credentials");
  }
  if (url.href.length > MAX_FEED_URL_LENGTH) {
    throw new Error(
      "Feed URLs must not exceed 4096 characters after normalization"
    );
  }
  return url.href;
}

export function validateSubscriptionURL(value) {
  const url = new URL(httpURL(value));
  url.hash = "";
  return url.href;
}

function titleText(value) {
  if (typeof value != "string") {
    throw new Error("A subscription title must be plain text");
  }
  return value
    .slice(0, 4096)
    .toWellFormed()
    .replace(/\p{Cc}|[\ufffe\uffff]/gu, char =>
      ["\t", "\r", "\n"].includes(char) ? char : ""
    );
}

function checkXML(xml) {
  if (
    typeof xml != "string" ||
    xml.length > MAX_BYTES ||
    new TextEncoder().encode(xml).length > MAX_BYTES
  ) {
    throw new Error("XML exceeds the 2 MiB limit");
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error(
      "XML document types and entity declarations are not allowed"
    );
  }
}

export function parseOPML(xml) {
  checkXML(xml);
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const root = doc.documentElement;
  if (
    doc.doctype ||
    root?.nodeName != "opml" ||
    root.namespaceURI ||
    doc.getElementsByTagNameNS(
      "http://www.mozilla.org/newlayout/xml/parsererror.xml",
      "parsererror"
    ).length
  ) {
    throw new Error("Invalid OPML document");
  }
  const bodies = Array.from(root.children).filter(
    node => node.nodeName == "body"
  );
  if (bodies.length != 1) {
    throw new Error("OPML must contain one body");
  }
  const entries = new Map();
  for (const outline of bodies[0].getElementsByTagName("outline")) {
    if (!outline.hasAttribute("xmlUrl")) {
      if (outline.getAttribute("type")?.toLowerCase() == "rss") {
        throw new Error("An OPML feed outline is missing xmlUrl");
      }
      continue;
    }
    const feedURL = validateSubscriptionURL(outline.getAttribute("xmlUrl"));
    const title = titleText(
      outline.getAttribute("title") ?? outline.getAttribute("text") ?? feedURL
    );
    if (!entries.has(feedURL)) {
      entries.set(feedURL, { title, feedURL });
    }
    if (entries.size > MAX_SUBSCRIPTIONS) {
      throw new Error("At most 200 live bookmark subscriptions are supported");
    }
  }
  return Array.from(entries.values());
}

export function serializeOPML(subscriptions) {
  const xmlEscape = value =>
    value.replace(
      /[&<>"'\t\r\n]/g,
      char =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
          "\t": "&#9;",
          "\r": "&#13;",
          "\n": "&#10;",
        })[char]
    );
  const entries = Array.from(subscriptions);
  if (entries.length > MAX_SUBSCRIPTIONS) {
    throw new Error("At most 200 live bookmark subscriptions are supported");
  }
  const outlines = entries.map(
    ({ title, feedURL }) =>
      `    <outline type="rss" text="${xmlEscape(titleText(title))}" xmlUrl="${xmlEscape(validateSubscriptionURL(feedURL))}"/>`
  );
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>Live Bookmarks</title></head>\n  <body>\n' +
    outlines.join("\n") +
    "\n  </body>\n</opml>\n";
  checkXML(xml);
  return xml;
}

function decodeXML(bytes, charset) {
  if (bytes.byteLength > MAX_BYTES) {
    throw new Error("Feed exceeds the 2 MiB decoded size limit");
  }
  let encoding;
  if (bytes[0] == 0xef && bytes[1] == 0xbb && bytes[2] == 0xbf) {
    encoding = "utf-8";
  } else if (bytes[0] == 0xff && bytes[1] == 0xfe) {
    encoding = "utf-16le";
  } else if (bytes[0] == 0xfe && bytes[1] == 0xff) {
    encoding = "utf-16be";
  } else if (charset) {
    encoding = charset;
  } else if (
    bytes[0] == 0 &&
    bytes[1] == 0x3c &&
    bytes[2] == 0 &&
    bytes[3] == 0x3f
  ) {
    encoding = "utf-16be";
  } else if (
    bytes[0] == 0x3c &&
    bytes[1] == 0 &&
    bytes[2] == 0x3f &&
    bytes[3] == 0
  ) {
    encoding = "utf-16le";
  } else {
    const prefix = String.fromCharCode(...bytes.subarray(0, 1024));
    encoding =
      /^<\?xml\s[^?]*\bencoding\s*=\s*(["'])([^"']+)\1/i.exec(prefix)?.[2] ||
      "utf-8";
  }
  const decoder = new TextDecoder(encoding, { fatal: true });
  if (decoder.encoding == "replacement") {
    throw new Error("Unsupported feed character encoding");
  }
  const xml = decoder.decode(bytes);
  // Byte limits apply before decoding, not to a UTF-8 re-encoding of legacy XML.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml)) {
    throw new Error(
      "Feed document types and entity declarations are not allowed"
    );
  }
  return xml;
}

function responseHeader(channel, name) {
  try {
    return channel.getResponseHeader(name);
  } catch {
    return "";
  }
}

function downloadFeed(feedURL, { signal, etag, lastModified, validatorURL }) {
  return new Promise((resolve, reject) => {
    let channel = lazy.NetUtil.newChannel({
      uri: httpURL(feedURL),
      loadUsingSystemPrincipal: true,
      securityFlags:
        Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL |
        Ci.nsILoadInfo.SEC_COOKIES_OMIT,
    }).QueryInterface(Ci.nsIHttpChannel);
    let settled = false;
    let redirectChannel = null;
    let redirects = 0;
    let received = 0;
    let decoded = 0;
    const chunks = [];
    let downstream;
    let response;
    const cancelRequests = () => {
      for (const request of [channel, redirectChannel]) {
        if (request) {
          try {
            request.cancel(Cr.NS_BINDING_ABORTED);
          } catch (error) {
            console.error("Live Bookmarks could not cancel a channel", error);
          }
        }
      }
    };
    const finish = (error, value) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) {
        reject(error);
        cancelRequests();
      } else {
        resolve(value);
      }
    };
    const abort = () =>
      finish(signal.reason || new Error("Feed download cancelled"));
    const configure = request => {
      request.loadFlags |=
        Ci.nsIRequest.LOAD_ANONYMOUS |
        Ci.nsIRequest.LOAD_BYPASS_CACHE |
        Ci.nsIRequest.INHIBIT_CACHING;
      request.QueryInterface(Ci.nsIEncodedChannel).applyConversion = false;
      request.setRequestHeader(
        "Accept",
        "application/atom+xml, application/rss+xml, application/xml, text/xml",
        false
      );
      request.setRequestHeader("Accept-Encoding", "gzip, deflate", false);
      const matchesCache =
        validateSubscriptionURL(request.URI.spec) == validatorURL;
      request.setRequestHeader(
        "If-None-Match",
        matchesCache ? etag : "",
        false
      );
      request.setRequestHeader(
        "If-Modified-Since",
        matchesCache ? lastModified : "",
        false
      );
    };
    const decodedListener = {
      QueryInterface: ChromeUtils.generateQI(["nsIStreamListener"]),
      onStartRequest() {},
      onDataAvailable(request, stream, offset, count) {
        if (settled) {
          throw Components.Exception(
            "Feed download cancelled",
            Cr.NS_BINDING_ABORTED
          );
        }
        decoded += count;
        if (decoded > MAX_BYTES) {
          finish(new Error("Feed exceeds the 2 MiB decoded size limit"));
          throw Components.Exception(
            "Feed too large",
            Cr.NS_ERROR_FILE_TOO_BIG
          );
        }
        chunks.push(
          new Uint8Array(lazy.NetUtil.readInputStream(stream, count))
        );
      },
      onStopRequest(request, status) {
        if (settled) {
          return;
        }
        if (!Components.isSuccessCode(status)) {
          finish(new Error(`Feed download failed (network status ${status})`));
          return;
        }
        const bytes = new Uint8Array(decoded);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        finish(null, { ...response, bytes });
      },
    };
    const listener = {
      QueryInterface: ChromeUtils.generateQI([
        "nsIStreamListener",
        "nsIChannelEventSink",
        "nsIInterfaceRequestor",
      ]),
      getInterface(iid) {
        return this.QueryInterface(iid);
      },
      asyncOnChannelRedirect(oldChannel, newChannel, flags, callback) {
        channel = oldChannel;
        redirectChannel = newChannel;
        if (settled || signal.aborted) {
          cancelRequests();
          callback.onRedirectVerifyCallback(Cr.NS_ERROR_ABORT);
          return;
        }
        let result = Cr.NS_OK;
        try {
          httpURL(newChannel.URI.spec);
          if (++redirects > 5) {
            throw new Error("Too many feed redirects");
          }
          const next = newChannel.QueryInterface(Ci.nsIHttpChannel);
          configure(next);

          next.notificationCallbacks = listener;
        } catch (error) {
          // A redirect veto alone does not stop the original response body.
          finish(error);
          result = Cr.NS_ERROR_ABORT;
        }
        callback.onRedirectVerifyCallback(result);
      },
      onStartRequest(request) {
        try {
          channel = request.QueryInterface(Ci.nsIHttpChannel);
          redirectChannel = null;
          if (settled) {
            request.cancel(Cr.NS_BINDING_ABORTED);
            return;
          }
          response = {
            url: httpURL(channel.URI.spec),
            status: channel.responseStatus,
            charset: channel.contentCharset,
            etag: responseHeader(channel, "ETag"),
            lastModified: responseHeader(channel, "Last-Modified"),
            retryAfter: responseHeader(channel, "Retry-After"),
          };
          if (response.status != 200) {
            finish(null, response);
            request.cancel(Cr.NS_BINDING_ABORTED);
            return;
          }
          if (channel.contentLength > MAX_BYTES) {
            throw new Error("Feed exceeds the 2 MiB received size limit");
          }
          const encoding = responseHeader(channel, "Content-Encoding")
            .trim()
            .toLowerCase();
          if (encoding && !["identity", "gzip", "deflate"].includes(encoding)) {
            throw new Error("Unsupported feed Content-Encoding");
          }
          // Bound both sides of decompression; channel progress alone is insufficient.
          downstream =
            !encoding || encoding == "identity"
              ? decodedListener
              : Cc["@mozilla.org/streamConverters;1"]
                  .getService(Ci.nsIStreamConverterService)
                  .asyncConvertData(
                    encoding,
                    "uncompressed",
                    decodedListener,
                    null
                  );
          downstream.onStartRequest(request);
        } catch (error) {
          finish(error);
        }
      },
      onDataAvailable(request, stream, offset, count) {
        if (settled) {
          return;
        }
        received += count;
        if (received > MAX_BYTES) {
          finish(new Error("Feed exceeds the 2 MiB received size limit"));
          return;
        }
        try {
          downstream.onDataAvailable(request, stream, offset, count);
        } catch (error) {
          finish(error);
        }
      },
      onStopRequest(request, status) {
        try {
          (downstream || decodedListener).onStopRequest(request, status);
        } catch (error) {
          finish(error);
        }
      },
    };
    try {
      configure(channel);
      channel.notificationCallbacks = listener;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      } else {
        channel.asyncOpen(listener);
      }
    } catch (error) {
      finish(error);
    }
  });
}

function feedSnapshot(feed) {
  return Object.freeze({
    title: titleText(feed.title),
    siteURL: feed.siteURL ? httpURL(feed.siteURL) : null,
    items: Object.freeze(
      feed.items.slice(0, 200).map(item =>
        Object.freeze({
          id: String(item.id),
          title: titleText(item.title),
          url: httpURL(item.url),
        })
      )
    ),
  });
}

function cacheRecord(subscription, feed) {
  const record = {
    guid: subscription.guid,
    feedURL: subscription.feedURL,
    feed: { title: feed.title, siteURL: feed.siteURL, items: [] },
  };
  const encoder = new TextEncoder();
  let size = encoder.encode(JSON.stringify(record)).length;
  for (const item of feed.items) {
    const bytes =
      encoder.encode(JSON.stringify(item)).length +
      (record.feed.items.length ? 1 : 0);
    if (size + bytes > MAX_CACHED_FEED_BYTES) {
      break;
    }
    record.feed.items.push(item);
    size += bytes;
  }
  return record;
}

function readCacheRecord(record) {
  const validText = value => typeof value == "string" && value.length <= 4096;
  const feed = record?.feed;
  if (
    typeof record?.guid != "string" ||
    !/^[a-zA-Z0-9_-]{12}$/.test(record.guid) ||
    !validText(feed?.title) ||
    (feed.siteURL !== null && typeof feed.siteURL != "string") ||
    !Array.isArray(feed.items) ||
    feed.items.length > 200 ||
    feed.items.some(item => !validText(item?.id) || !validText(item?.title)) ||
    new TextEncoder().encode(JSON.stringify(record)).length >
      MAX_CACHED_FEED_BYTES
  ) {
    throw new Error("Invalid cached feed snapshot");
  }
  const result = {
    guid: record.guid,
    feedURL: validateSubscriptionURL(record.feedURL),
    feed: feedSnapshot(feed),
  };
  if (
    new TextEncoder().encode(JSON.stringify(result)).length >
    MAX_CACHED_FEED_BYTES
  ) {
    throw new Error("Normalized cached feed snapshot exceeds its size limit");
  }
  return result;
}

function newState(nextRefresh) {
  return {
    status: "idle",
    feed: null,
    nextRefresh,
    failures: 0,
    etag: "",
    lastModified: "",
    validatorURL: null,
    promise: null,
    controller: null,
    error: null,
  };
}

/**
 *
 */
export class LiveBookmarksService {
  constructor({
    path = null,
    download = downloadFeed,

    parser = (xml, url) => lazy.parseFeed(xml, url),
    clock = null,
    timeoutMS = 30000,
  } = {}) {
    this._path = path;
    this._download = download;

    this._parser = parser;
    this._clock = clock || {
      now: () => Date.now(),
      setTimeout: (...args) => lazy.setTimeout(...args),
      clearTimeout: id => lazy.clearTimeout(id),
    };
    this._timeoutMS = timeoutMS;
    this._subscriptions = new Map();
    this._states = new Map();
    this._cachedFeeds = new Map();
    this._creations = new Map();
    this._controllers = new Set();
    this._running = new Set();
    this._queue = [];
    this._active = 0;
    this._mutations = Promise.resolve();
    this._removedDuringInit = new Set();
    this._titlesDuringInit = new Map();
    this._initialized = false;
    this._stopped = false;
    this._timer = null;
    this._onPlacesEvents = events => {
      for (const event of events) {
        if (event.type == "bookmark-removed") {
          if (!this._initialized) {
            this._removedDuringInit.add(event.guid);
          }
          this._forget(event.guid);
        } else if (event.type == "bookmark-title-changed") {
          if (!this._initialized) {
            this._titlesDuringInit.set(event.guid, event.title);
          } else {
            this._updateTitle(event.guid, event.title);
          }
        }
      }
    };
    this._shutdownBlocker = () => this.shutdown();
  }

  init() {
    if (this._stopped) {
      return Promise.reject(new Error("Live Bookmarks has shut down"));
    }
    return (this._initPromise ||= this._initialize());
  }

  async _initialize() {
    try {
      this._path ||= PathUtils.join(
        PathUtils.profileDir,
        "waterfox-live-bookmarks.json"
      );
      lazy.PlacesUtils.observers.addListener(
        PLACES_EVENTS,
        this._onPlacesEvents
      );
      this._observing = true;
      lazy.AsyncShutdown.profileChangeTeardown.addBlocker(
        "Live Bookmarks: stop downloads and save subscriptions",
        this._shutdownBlocker
      );
      this._blockingShutdown = true;
      let data;
      try {
        // JSONFile.load() recovers malformed files as empty data; never do that here.
        data = await IOUtils.readJSON(this._path);
      } catch (error) {
        if (error.name != "NotFoundError") {
          throw error;
        }
        data = { version: VERSION, subscriptions: [] };
      }
      if (
        data?.version !== VERSION ||
        !Array.isArray(data.subscriptions) ||
        data.subscriptions.length > MAX_SUBSCRIPTIONS
      ) {
        throw new Error("Unsupported or malformed subscription storage");
      }
      const subscriptions = new Map();
      const urls = new Set();
      for (const entry of data.subscriptions) {
        if (
          !entry ||
          typeof entry.guid != "string" ||
          !/^[a-zA-Z0-9_-]{12}$/.test(entry.guid) ||
          lazy.PlacesUtils.isRootItem(entry.guid) ||
          subscriptions.has(entry.guid)
        ) {
          throw new Error("Invalid or duplicate subscription folder GUID");
        }
        if (entry.siteURL !== null && typeof entry.siteURL != "string") {
          throw new Error("Invalid subscription site URL");
        }
        const subscription = Object.freeze({
          guid: entry.guid,
          feedURL: validateSubscriptionURL(entry.feedURL),
          title: titleText(entry.title),
          siteURL: entry.siteURL ? httpURL(entry.siteURL) : null,
        });
        if (urls.has(subscription.feedURL)) {
          throw new Error("Duplicate subscription feed URL");
        }
        urls.add(subscription.feedURL);
        subscriptions.set(entry.guid, subscription);
      }
      this._cachePath = `${this._path}.cache`;
      const cachedFeeds = await this._readCache();
      let titlesChanged = false;
      for (const [guid, subscription] of subscriptions) {
        this._titlesDuringInit.delete(guid);
        const folder = await lazy.PlacesUtils.bookmarks.fetch(guid);
        if (!folder || folder.type != lazy.PlacesUtils.bookmarks.TYPE_FOLDER) {
          subscriptions.delete(guid);
        } else if (folder.title != subscription.title) {
          subscriptions.set(
            guid,
            Object.freeze({ ...subscription, title: folder.title })
          );
          titlesChanged = true;
        }
      }
      // Events arriving during or after a folder read supersede its snapshot.
      for (const [guid, title] of this._titlesDuringInit) {
        const subscription = subscriptions.get(guid);
        if (subscription && subscription.title != title) {
          subscriptions.set(guid, Object.freeze({ ...subscription, title }));
          titlesChanged = true;
        }
      }
      for (const guid of this._removedDuringInit) {
        subscriptions.delete(guid);
      }
      this._assertRunning();
      this._store = new lazy.JSONFile({ path: this._path });
      this._subscriptions = subscriptions;
      this._store.data = { version: VERSION, subscriptions: this._list() };
      this._restoreCache(cachedFeeds);
      this._initialized = true;
      this._schedule();
      if (this._cachedFeeds.size != cachedFeeds.size) {
        this._persistCache();
      }
      if (titlesChanged || subscriptions.size != data.subscriptions.length) {
        this._persist();
      }
      this._removedDuringInit.clear();
      this._titlesDuringInit.clear();
      this._notify(null);
    } catch (cause) {
      this._initialized = false;
      this._unregister();
      if (this._cacheStore) {
        await this._cacheStore.finalize().catch(console.error);
        this._cacheStore = null;
      }
      if (this._store) {
        await this._store.finalize();
        this._store = null;
      }
      throw new Error(
        `Could not initialize Live Bookmarks from ${this._path}. Check file permissions and the version-1 subscription JSON; the existing file has not been replaced.`,
        { cause }
      );
    }
  }

  _assertRunning() {
    if (this._stopped) {
      throw new Error("Live Bookmarks has shut down");
    }
  }

  _assertReady() {
    this._assertRunning();
    if (!this._initialized) {
      throw new Error(
        "Call and await LiveBookmarks.init() before reading subscriptions"
      );
    }
  }

  _list() {
    return Array.from(this._subscriptions.values());
  }

  list() {
    this._assertReady();
    return this._list();
  }

  get(guid) {
    this._assertReady();
    return this._subscriptions.get(guid) || null;
  }

  getByFeedURL(value) {
    this._assertReady();
    let url;
    try {
      url = validateSubscriptionURL(value);
    } catch {
      return null;
    }
    return this._findURL(url) || null;
  }

  peek(guid) {
    this._assertReady();
    const state = this._states.get(guid);
    return state
      ? {
          status: state.status,
          items: state.feed?.items || [],
          siteURL: state.feed?.siteURL || this.get(guid).siteURL,
        }
      : null;
  }

  _notify(guid) {
    Services.obs.notifyObservers(null, TOPIC, guid);
  }

  _persist() {
    this._store.data = { version: VERSION, subscriptions: this._list() };
    this._store.saveSoon();
  }

  async _readCache() {
    try {
      const bytes = await IOUtils.read(this._cachePath, {
        maxBytes: MAX_CACHE_BYTES + 1,
      });
      if (bytes.length > MAX_CACHE_BYTES) {
        throw new Error("Live Bookmarks headline cache exceeds 32 MiB");
      }
      const data = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      );
      if (
        data?.version !== CACHE_VERSION ||
        !Array.isArray(data.feeds) ||
        data.feeds.length > MAX_SUBSCRIPTIONS
      ) {
        throw new Error("Unsupported or malformed headline cache");
      }
      const feeds = new Map();
      for (const entry of data.feeds) {
        try {
          const record = readCacheRecord(entry);
          if (feeds.has(record.guid)) {
            throw new Error("Duplicate cached feed GUID");
          }
          feeds.set(record.guid, record);
        } catch (error) {
          console.warn("Ignoring invalid Live Bookmarks cache entry", error);
        }
      }
      return feeds;
    } catch (error) {
      if (error.name != "NotFoundError") {
        console.warn("Could not restore Live Bookmarks headline cache", error);
      }
      return new Map();
    }
  }

  _restoreCache(cachedFeeds) {
    this._cacheWriteFailed = false;
    this._cacheStore = new lazy.JSONFile({
      path: this._cachePath,
      saveFailureHandler: error => {
        this._cacheWriteFailed = true;
        console.warn("Could not save Live Bookmarks headline cache", error);
      },
    });
    let delay = SCHEDULE_INTERVAL;
    for (const [guid, subscription] of this._subscriptions) {
      const state = newState(this._clock.now() + delay);
      const cached = cachedFeeds.get(guid);
      if (cached?.feedURL === subscription.feedURL) {
        state.feed = cached.feed;
        state.status = "ready";
        this._cachedFeeds.set(guid, cached);
      }
      this._states.set(guid, state);
      delay += SCHEDULE_INTERVAL;
    }
    this._cacheStore.data = {
      version: CACHE_VERSION,
      feeds: [...this._cachedFeeds.values()],
    };
  }

  _rememberFeed(guid) {
    const feed = this._states.get(guid)?.feed;
    if (!feed) {
      return;
    }
    const record = cacheRecord(this._subscriptions.get(guid), feed);
    if (
      JSON.stringify(record) !== JSON.stringify(this._cachedFeeds.get(guid))
    ) {
      this._cachedFeeds.set(guid, record);
      this._persistCache();
    } else if (this._cacheWriteFailed) {
      this._persistCache();
    }
  }

  _persistCache() {
    this._cacheWriteFailed = false;
    this._cacheStore.data = {
      version: CACHE_VERSION,
      feeds: [...this._cachedFeeds.values()],
    };
    this._cacheStore.saveSoon();
  }

  _mutate(task) {
    const result = this._mutations.then(() => {
      this._assertReady();
      return task();
    });
    this._mutations = result.catch(() => {});
    return result;
  }

  _findURL(url) {
    return this._list().find(entry => entry.feedURL == url);
  }

  async _parent(parentGuid) {
    const folder = await lazy.PlacesUtils.bookmarks.fetch(parentGuid);
    if (
      !folder ||
      folder.type != lazy.PlacesUtils.bookmarks.TYPE_FOLDER ||
      [
        lazy.PlacesUtils.bookmarks.rootGuid,
        lazy.PlacesUtils.bookmarks.tagsGuid,
      ].includes(parentGuid)
    ) {
      throw new Error(
        "Choose an existing bookmark folder for the subscription"
      );
    }
  }

  async create({
    feedURL,
    title,
    parentGuid = lazy.PlacesUtils.bookmarks.menuGuid,
  }) {
    await this.init();
    feedURL = validateSubscriptionURL(feedURL);
    if (title !== undefined) {
      title = titleText(title);
    }
    const existing = this._findURL(feedURL);
    if (existing) {
      return existing;
    }
    if (this._creations.has(feedURL)) {
      return this._creations.get(feedURL);
    }
    if (this._subscriptions.size + this._creations.size >= MAX_SUBSCRIPTIONS) {
      throw new Error("At most 200 live bookmark subscriptions are supported");
    }
    const creation = (async () => {
      await this._parent(parentGuid);
      const state = newState(0);
      const feed = await this._fetch(feedURL, state);
      return this._mutate(() =>
        this._insert(
          { feedURL, title: title || feed.title || feedURL, parentGuid },
          state
        )
      );
    })();
    this._creations.set(feedURL, creation);
    try {
      return await creation;
    } finally {
      this._creations.delete(feedURL);
    }
  }

  async _insert(
    { feedURL, title, parentGuid },
    state = newState(this._clock.now() + HOUR)
  ) {
    const existing = this._findURL(feedURL);
    if (existing) {
      return existing;
    }
    if (this._subscriptions.size >= MAX_SUBSCRIPTIONS) {
      throw new Error("At most 200 live bookmark subscriptions are supported");
    }
    await this._parent(parentGuid);
    this._assertRunning();
    const folder = await lazy.PlacesUtils.bookmarks.insert({
      type: lazy.PlacesUtils.bookmarks.TYPE_FOLDER,
      parentGuid,
      title,
    });
    // Observe immediately, before another turn can remove the new folder.
    const subscription = Object.freeze({
      guid: folder.guid,
      feedURL,
      title: folder.title,
      siteURL: state.feed?.siteURL || null,
    });
    this._subscriptions.set(folder.guid, subscription);
    this._states.set(folder.guid, state);
    const currentFolder = await lazy.PlacesUtils.bookmarks.fetch(folder.guid);
    if (!currentFolder || !this._subscriptions.has(folder.guid)) {
      this._forget(folder.guid);
      throw new Error("The subscription folder was removed during creation");
    }
    if (this._subscriptions.get(folder.guid) == subscription) {
      this._subscriptions.set(
        folder.guid,
        Object.freeze({ ...subscription, title: currentFolder.title })
      );
    }
    this._persist();
    this._rememberFeed(folder.guid);
    const result = this._subscriptions.get(folder.guid);
    this._notify(folder.guid);
    return result;
  }

  async importOPML(xml, parentGuid = lazy.PlacesUtils.bookmarks.menuGuid) {
    const entries = parseOPML(xml);
    await this.init();
    return this._mutate(async () => {
      const additions = entries.filter(entry => !this._findURL(entry.feedURL));
      if (
        this._subscriptions.size + this._creations.size + additions.length >
        MAX_SUBSCRIPTIONS
      ) {
        throw new Error(
          "At most 200 live bookmark subscriptions are supported"
        );
      }
      await this._parent(parentGuid);
      let count = 0;
      for (const entry of additions) {
        this._assertRunning();
        await this._insert({ ...entry, parentGuid });
        count++;
      }
      return count;
    });
  }

  async refresh(guid, { force = false } = {}) {
    await this.init();
    const subscription = this.get(guid);
    const state = this._states.get(guid);
    if (!subscription) {
      throw new Error("Unknown live bookmark subscription");
    }
    if (state.promise) {
      return state.promise;
    }
    if (this._clock.now() < state.nextRefresh) {
      if (state.failures) {
        throw new Error("Feed refresh is in backoff; try again later", {
          cause: state.error,
        });
      }
      if (!force && state.feed) {
        return state.feed;
      }
    }
    state.status = "loading";
    // Install the promise before notifying listeners, which may reenter refresh().
    state.promise = Promise.resolve().then(async () => {
      if (this._states.get(guid) != state) {
        throw new Error("The live bookmark subscription was removed");
      }
      try {
        if (!(await lazy.PlacesUtils.bookmarks.fetch(guid))) {
          this._forget(guid);
          throw new Error("The live bookmark folder no longer exists");
        }
        if (this._states.get(guid) != state || this._stopped) {
          throw new Error(
            "The live bookmark subscription was removed or shut down"
          );
        }
        const feed = await this._fetch(subscription.feedURL, state);
        if (this._states.get(guid) != state || this._stopped) {
          throw new Error(
            "The live bookmark subscription was removed or shut down"
          );
        }
        this._subscriptions.set(
          guid,
          Object.freeze({
            ...this._subscriptions.get(guid),
            siteURL: feed.siteURL,
          })
        );
        this._persist();
        this._rememberFeed(guid);
        return feed;
      } catch (error) {
        if (state.status == "loading") {
          state.status = "error";
          state.error = error;
          state.failures = 1;
          state.nextRefresh = this._clock.now() + HOUR;
        }
        throw error;
      } finally {
        state.promise = null;
        if (this._states.get(guid) == state && !this._stopped) {
          this._notify(guid);
        }
      }
    });
    this._notify(guid);
    return state.promise;
  }

  async _fetch(url, state) {
    const controller = new AbortController();
    state.controller = controller;
    this._controllers.add(controller);
    try {
      const response = await this._withSlot(async () => {
        const timer = this._clock.setTimeout(
          () => controller.abort(new Error("Feed download timed out")),
          this._timeoutMS
        );
        try {
          return await this._download(url, {
            signal: controller.signal,
            etag: state.feed ? state.etag : "",
            lastModified: state.feed ? state.lastModified : "",
            validatorURL: state.feed ? state.validatorURL : null,
          });
        } finally {
          this._clock.clearTimeout(timer);
        }
      }, controller.signal);
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      const responseURL = validateSubscriptionURL(response.url || url);
      if (response.status == 304) {
        if (
          !state.feed ||
          responseURL != state.validatorURL ||
          !(state.etag || state.lastModified)
        ) {
          throw new Error(
            "Feed returned unsolicited 304 for an uncached resource"
          );
        }
      } else if (response.status == 200) {
        const xml = decodeXML(response.bytes, response.charset);
        state.feed = feedSnapshot(this._parser(xml, responseURL));
      } else {
        const error = new Error(
          `Feed request failed with HTTP ${response.status}`
        );
        const seconds = Number(response.retryAfter);
        const retryAt = Number.isFinite(seconds)
          ? this._clock.now() + seconds * 1000
          : Date.parse(response.retryAfter);
        error.retryDelay = Math.min(
          MAX_BACKOFF,
          Math.max(0, retryAt - this._clock.now()) || 0
        );
        throw error;
      }
      state.validatorURL = responseURL;
      state.etag = response.etag || (response.status == 304 ? state.etag : "");
      state.lastModified =
        response.lastModified ||
        (response.status == 304 ? state.lastModified : "");
      state.status = "ready";
      state.failures = 0;
      state.error = null;
      state.nextRefresh = this._clock.now() + HOUR;
      return state.feed;
    } catch (error) {
      state.status = "error";
      state.error = error;
      state.failures = Math.min(state.failures + 1, 6);
      state.nextRefresh =
        this._clock.now() +
        Math.max(
          Math.min(MAX_BACKOFF, HOUR * 2 ** (state.failures - 1)),
          error.retryDelay || 0
        );
      throw error;
    } finally {
      this._controllers.delete(controller);
      state.controller = null;
    }
  }

  _withSlot(task, signal) {
    return new Promise((resolve, reject) => {
      const job = {
        run: async () => {
          this._active++;
          try {
            resolve(await task());
          } catch (error) {
            reject(error);
          } finally {
            signal.removeEventListener("abort", abort);
            this._active--;
            this._pump();
          }
        },
        signal,
      };
      const abort = () => {
        this._queue = this._queue.filter(entry => entry != job);
        signal.removeEventListener("abort", abort);
        reject(signal.reason || new Error("Feed download cancelled"));
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted || this._stopped) {
        abort();
      } else {
        this._queue.push(job);
        this._pump();
      }
    });
  }

  _pump() {
    while (!this._stopped && this._active < 3 && this._queue.length) {
      const running = this._queue.shift().run();
      this._running.add(running);
      running.finally(() => this._running.delete(running));
    }
  }

  _updateTitle(guid, title) {
    const subscription = this._subscriptions.get(guid);
    if (subscription && subscription.title != title) {
      this._subscriptions.set(guid, Object.freeze({ ...subscription, title }));
      this._persist();
      this._notify(guid);
    }
  }

  _forget(guid) {
    if (!this._subscriptions.delete(guid)) {
      return;
    }
    this._states
      .get(guid)
      ?.controller?.abort(
        new Error("The live bookmark subscription was removed")
      );
    this._states.delete(guid);
    if (this._cachedFeeds.delete(guid) && this._initialized) {
      this._persistCache();
    }
    if (this._initialized) {
      this._persist();
      this._notify(guid);
    }
  }

  async remove(guid) {
    await this.init();
    return this._mutate(async () => {
      if (!this._subscriptions.has(guid)) {
        return;
      }
      if (await lazy.PlacesUtils.bookmarks.fetch(guid)) {
        await lazy.PlacesUtils.bookmarks.remove(guid, {
          preventRemovalOfNonEmptyFolders: true,
        });
      }
      this._forget(guid);
    });
  }

  _schedule() {
    if (this._stopped) {
      return;
    }
    this._timer = this._clock.setTimeout(() => {
      this._timer = null;
      const now = this._clock.now();
      const due = Array.from(this._states)
        .filter(([, state]) => !state.promise && state.nextRefresh <= now)
        .sort((a, b) => a[1].nextRefresh - b[1].nextRefresh)[0];
      if (due && this._active < 3 && !Services.io.offline) {
        this.refresh(due[0]).catch(() => {});
      }
      this._schedule();
    }, SCHEDULE_INTERVAL);
  }

  _unregister({ removeBlocker = true } = {}) {
    if (this._timer !== null) {
      this._clock.clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._observing) {
      lazy.PlacesUtils.observers.removeListener(
        PLACES_EVENTS,
        this._onPlacesEvents
      );
      this._observing = false;
    }
    if (removeBlocker && this._blockingShutdown) {
      lazy.AsyncShutdown.profileChangeTeardown.removeBlocker(
        this._shutdownBlocker
      );
      this._blockingShutdown = false;
    }
  }

  shutdown() {
    if (this._shutdownPromise) {
      return this._shutdownPromise;
    }
    this._stopped = true;
    this._unregister({ removeBlocker: false });
    for (const controller of this._controllers) {
      controller.abort(new Error("Live Bookmarks has shut down"));
    }
    this._shutdownPromise = (async () => {
      await this._initPromise?.catch(() => {});
      await Promise.allSettled([
        ...this._creations.values(),
        ...Array.from(this._states.values(), state => state.promise),
      ]);
      await this._mutations;
      await Promise.allSettled(this._running);
      if (this._cacheStore) {
        await this._cacheStore.finalize().catch(console.error);
        this._cacheStore = null;
      }
      if (this._store) {
        await this._store.finalize();
        this._store = null;
      }
      this._initialized = false;
      this._states.clear();
      this._cachedFeeds.clear();
      this._subscriptions.clear();
    })().finally(() => this._unregister());
    return this._shutdownPromise;
  }
}

export const LiveBookmarks = new LiveBookmarksService();
