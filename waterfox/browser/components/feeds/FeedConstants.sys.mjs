/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Identify the reader route, including malformed variants which must not expose
 * the subscription manager.
 *
 * @param {string} value - Document URL.
 * @returns {boolean} Whether the URL requests the embedded reader.
 */
export function isFeedReaderURL(value) {
  const url = URL.parse(value);
  return (
    url?.protocol === "about:" &&
    url.pathname === "feeds" &&
    url.searchParams.getAll("view").includes("reader")
  );
}

export const DISCOVERY_PREF = "browser.feeds.discovery.enabled";
export const MAX_FEED_BYTES = 2 * 1024 * 1024;
export const MAX_ITEM_DESCRIPTION_LENGTH = 20000;
export const MAX_ITEM_CONTENT_LENGTH = 100000;
export const FEED_MIME_TYPES = Object.freeze([
  "application/rss+xml",
  "application/atom+xml",
]);
export const XML_MIME_TYPES = Object.freeze([
  ...FEED_MIME_TYPES,
  "application/xml",
  "text/xml",
  "application/rdf+xml",
  "text/rdf",
]);
