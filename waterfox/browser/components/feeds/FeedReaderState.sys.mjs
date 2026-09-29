/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MAX_ITEM_DESCRIPTION_LENGTH } from "resource:///modules/FeedConstants.sys.mjs";
import { sanitizeFeedArticleContent } from "resource:///modules/FeedArticleContent.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  JSONFile: "resource://gre/modules/JSONFile.sys.mjs",
});

const VERSION = 1;
const MAX_URL_LENGTH = 4096;
const MAX_ID_LENGTH = 1000;
const MAX_TITLE_LENGTH = 1000;
const MAX_SOURCE_LENGTH = 1000;
const MAX_READ_ENTRIES = 10000;
const MAX_SAVED_ENTRIES = 2000;
const TOPIC = "waterfox-feed-reader-state-changed";

function httpURL(value, feed = false) {
  if (
    typeof value != "string" ||
    !value ||
    value.length > MAX_URL_LENGTH ||
    /[\p{Cc}\s]/u.test(value)
  ) {
    throw new TypeError("Expected an HTTP(S) URL within the length limit");
  }
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    /^https?:\/\/[^/?#]*@/i.test(value.replace(/\\/g, "/"))
  ) {
    throw new TypeError("Expected an HTTP(S) URL without credentials");
  }
  if (feed) {
    url.hash = "";
  }
  if (url.href.length > MAX_URL_LENGTH) {
    throw new RangeError("URL exceeds the length limit after normalization");
  }
  return url.href;
}

function itemID(value) {
  if (
    typeof value != "string" ||
    !value ||
    value.length > MAX_ID_LENGTH ||
    /\p{Cc}/u.test(value)
  ) {
    throw new TypeError(
      "Expected a nonempty feed item ID within the length limit"
    );
  }
  return value;
}

function plainText(value, maxLength) {
  if (
    typeof value != "string" ||
    value.length > maxLength ||
    /[<>\p{Cc}]/u.test(value.replace(/[\t\r\n]/g, "")) ||
    !value.isWellFormed()
  ) {
    throw new TypeError("Expected bounded plain text without markup");
  }
  return value;
}

function savedSnapshot(snapshot) {
  if (!snapshot || typeof snapshot != "object" || Array.isArray(snapshot)) {
    throw new TypeError("Expected a saved entry snapshot");
  }
  const title = plainText(snapshot.title, MAX_TITLE_LENGTH);
  if (!title.trim()) {
    throw new TypeError("Saved entries need a title");
  }
  if (
    snapshot.published !== undefined &&
    snapshot.published !== null &&
    (typeof snapshot.published != "number" ||
      !Number.isFinite(snapshot.published) ||
      snapshot.published < -2208988800000 ||
      snapshot.published > 4102444800000)
  ) {
    throw new TypeError("Invalid saved entry published date");
  }
  const url = httpURL(snapshot.url);
  const content = sanitizeFeedArticleContent(snapshot.content, url);
  return {
    title,
    url,
    ...(content ? { content } : {}),
    description: plainText(snapshot.description, MAX_ITEM_DESCRIPTION_LENGTH),
    source: plainText(snapshot.source, MAX_SOURCE_LENGTH),
    published: snapshot.published ?? null,
  };
}

function keyFor(feedURL, id) {
  return JSON.stringify([feedURL, id]);
}

/** Persists read markers and sanitized saved articles in the profile. */
class FeedReaderStateService {
  _initPromise = null;
  _store = null;
  _reads = new Map();
  _saved = new Map();

  async init() {
    return (this._initPromise ||= this._initialize());
  }

  async _initialize() {
    const path = PathUtils.join(
      PathUtils.profileDir,
      "waterfox-feed-reader-state.json"
    );
    let data;
    try {
      // JSONFile.load() treats malformed or unreadable files as empty data.
      data = await IOUtils.readJSON(path);
    } catch (error) {
      if (error.name != "NotFoundError") {
        throw new Error(`Could not read feed reader state from ${path}`, {
          cause: error,
        });
      }
      data = { version: VERSION, reads: [], saved: [] };
    }
    if (
      data?.version !== VERSION ||
      !Array.isArray(data.reads) ||
      !Array.isArray(data.saved) ||
      data.reads.length > MAX_READ_ENTRIES ||
      data.saved.length > MAX_SAVED_ENTRIES
    ) {
      throw new Error(`Unsupported or malformed feed reader state at ${path}`);
    }

    const reads = new Map();
    const saved = new Map();
    for (const entry of data.reads) {
      const feedURL = httpURL(entry?.feedURL, true);
      const id = itemID(entry.id);
      const key = keyFor(feedURL, id);
      if (reads.has(key)) {
        throw new Error("Duplicate feed reader read identity");
      }
      reads.set(key, { feedURL, id });
    }
    for (const entry of data.saved) {
      const feedURL = httpURL(entry?.feedURL, true);
      const id = itemID(entry.id);
      const key = keyFor(feedURL, id);
      if (
        reads.has(key) ||
        saved.has(key) ||
        typeof entry.read != "boolean" ||
        entry.saved !== true
      ) {
        throw new Error("Invalid or duplicate saved feed entry");
      }
      saved.set(key, {
        feedURL,
        id,
        ...savedSnapshot(entry),
        read: entry.read,
        saved: true,
      });
    }

    this._reads = reads;
    this._saved = saved;
    this._store = new lazy.JSONFile({
      path,
      saveFailureHandler: error =>
        console.error("Could not save feed reader state", error),
    });
    this._store.data = {
      version: VERSION,
      reads: [...reads.values()],
      saved: [...saved.values()],
    };
    lazy.AsyncShutdown.profileChangeTeardown.addBlocker(
      "Feed reader: save read and saved articles",
      async () => {
        await this._store.finalize();
        this._store = null;
      }
    );
  }

  _assertInitialized() {
    if (!this._store) {
      throw new Error("Feed reader state must be initialized first");
    }
  }

  _persist() {
    this._store.data = {
      version: VERSION,
      reads: [...this._reads.values()],
      saved: [...this._saved.values()],
    };
    this._store.saveSoon();
    Services.obs.notifyObservers(null, TOPIC);
  }

  _rememberRead(key, feedURL, id) {
    this._reads.delete(key);
    this._reads.set(key, { feedURL, id });
    if (this._reads.size > MAX_READ_ENTRIES) {
      this._reads.delete(this._reads.keys().next().value);
    }
  }

  get(feedURL, itemId) {
    this._assertInitialized();
    const key = keyFor(httpURL(feedURL, true), itemID(itemId));
    const saved = this._saved.get(key);
    return { read: saved?.read ?? this._reads.has(key), saved: !!saved };
  }

  setRead(feedURL, itemId, read) {
    this._assertInitialized();
    if (typeof read != "boolean") {
      throw new TypeError("Read must be a boolean");
    }
    feedURL = httpURL(feedURL, true);
    const id = itemID(itemId);
    const key = keyFor(feedURL, id);
    const saved = this._saved.get(key);
    if (saved) {
      if (saved.read == read) {
        return;
      }
      saved.read = read;
    } else if (this._reads.has(key) == read) {
      return;
    } else if (read) {
      this._rememberRead(key, feedURL, id);
    } else {
      this._reads.delete(key);
    }
    this._persist();
  }

  setSaved(feedURL, itemId, saved, snapshot) {
    this._assertInitialized();
    if (typeof saved != "boolean") {
      throw new TypeError("Saved must be a boolean");
    }
    feedURL = httpURL(feedURL, true);
    const id = itemID(itemId);
    const key = keyFor(feedURL, id);
    const previous = this._saved.get(key);
    if (!saved) {
      if (!previous) {
        return;
      }
      this._saved.delete(key);
      if (previous.read) {
        this._rememberRead(key, feedURL, id);
      }
    } else {
      const details = savedSnapshot(snapshot);
      if (!previous && this._saved.size >= MAX_SAVED_ENTRIES) {
        throw new RangeError("Saved feed entry limit reached");
      }
      if (
        previous &&
        previous.content === details.content &&
        Object.entries(details).every(
          ([name, value]) => previous[name] == value
        )
      ) {
        return;
      }
      this._saved.set(key, {
        feedURL,
        id,
        ...details,
        read: previous?.read ?? this._reads.has(key),
        saved: true,
      });
      this._reads.delete(key);
    }
    this._persist();
  }

  listSaved() {
    this._assertInitialized();
    return [...this._saved.values()].map(entry => ({ ...entry }));
  }
}

export const FeedReaderState = new FeedReaderStateService();
