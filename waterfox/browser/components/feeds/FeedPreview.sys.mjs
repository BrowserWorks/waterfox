/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  LiveBookmarks,
  MAX_FEED_URL_LENGTH,
  validateSubscriptionURL,
} from "resource:///modules/LiveBookmarks.sys.mjs";

const previews = new WeakMap();
const loads = new WeakMap();
const MAX_LOADS = 20;
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;

function snapshotFeed(feed) {
  const snapshot = structuredClone(feed);
  for (const item of snapshot.items) {
    Object.freeze(item);
  }
  Object.freeze(snapshot.items);
  return Object.freeze(snapshot);
}

export const FeedPreview = {
  async load(global, feedURL) {
    const url = validateSubscriptionURL(feedURL);
    if (!global?.isCurrentGlobal) {
      throw new Error("The source feed document is no longer current");
    }
    const preview = this.get(global.browsingContext, global.documentURI?.spec);
    if (preview?.feedURL === url) {
      return preview.feed;
    }

    let cache = loads.get(global);
    if (!cache) {
      cache = new Map();
      loads.set(global, cache);
    }
    const now = Date.now();
    for (const [key, entry] of cache) {
      if (!entry.pending && entry.expiresAt <= now) {
        cache.delete(key);
      }
    }
    const cached = cache.get(url);
    if (cached) {
      cache.delete(url);
      cache.set(url, cached);
      return cached.promise;
    }
    if (cache.size >= MAX_LOADS) {
      const oldest = [...cache].find(([, entry]) => !entry.pending);
      if (!oldest) {
        throw new Error("Too many feed previews are loading for this document");
      }
      cache.delete(oldest[0]);
    }

    const entry = { pending: true, expiresAt: 0 };
    entry.promise = LiveBookmarks.previewURL(
      url,
      global.documentPrincipal.originAttributes
    )
      .then(snapshotFeed)
      .then(
        feed => {
          entry.pending = false;
          entry.expiresAt = Date.now() + SUCCESS_TTL_MS;
          return feed;
        },
        error => {
          entry.pending = false;
          entry.expiresAt = Date.now() + FAILURE_TTL_MS;
          throw error;
        }
      );
    cache.set(url, entry);
    return entry.promise;
  },

  /**
   * Store only the sanitized result of parseFeed, never source XML.
   *
   * @param {BrowsingContext} context - Context that owns the preview.
   * @param {object} preview - Feed preview data.
   * @param {string} preview.feedURL - Source feed URL.
   * @param {object} preview.feed - Sanitized result of parseFeed.
   * @returns {string} The about:feeds preview URL.
   */
  set(context, { feedURL, feed }) {
    const url = validateSubscriptionURL(feedURL);
    const snapshot = snapshotFeed(feed);
    previews.set(context, Object.freeze({ feedURL: url, feed: snapshot }));
    return `about:feeds?preview=${encodeURIComponent(url)}`;
  },

  get(context, documentURI) {
    const preview = previews.get(context);
    return preview?.feedURL === this.getFeedURL(documentURI) ? preview : null;
  },

  getFeedURL(documentURI) {
    if (
      typeof documentURI !== "string" ||
      documentURI.length > MAX_FEED_URL_LENGTH * 3 + 32
    ) {
      return null;
    }
    try {
      const url = new URL(documentURI);
      const values = url.searchParams.getAll("preview");
      if (
        url.protocol !== "about:" ||
        url.pathname !== "feeds" ||
        values.length !== 1
      ) {
        return null;
      }
      const value = values[0];
      if (!value || /[\p{Cc}\s]/u.test(value)) {
        return null;
      }
      return validateSubscriptionURL(value);
    } catch {
      return null;
    }
  },
};
