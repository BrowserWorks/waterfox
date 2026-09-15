/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

const MAX_FEEDS = 20;
const MAX_LINKS = 1000;
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 1024;
const FEED_TYPES = new Set(["application/rss+xml", "application/atom+xml"]);
const MAX_MUTATION_RECORDS = 100;
const CHANGE_DELAY_MS = 100;

/** Signals advertisement changes; reads feeds only on chrome's request. */
export class FeedDiscoveryChild extends JSWindowActorChild {
  #observer = null;
  #observedRoot = null;
  #observedHead = null;
  #changeTimer = null;

  handleEvent(event) {
    if (
      !event.isTrusted ||
      event.target !== this.document ||
      this.browsingContext.parent
    ) {
      return;
    }

    switch (event.type) {
      case "pagehide":
        this.#stopObserving();
        break;
      case "DOMContentLoaded":
      case "pageshow":
        if (this.#observer || !/^https?:/.test(this.document.documentURI)) {
          return;
        }
        this.#observer = new this.contentWindow.MutationObserver(records => {
          const headChanged =
            this.#observedRoot !== this.document.documentElement ||
            this.#observedHead !== this.document.head;
          if (headChanged) {
            this.#observeHead();
          }
          if (
            headChanged ||
            records.length > MAX_MUTATION_RECORDS ||
            records.some(
              record =>
                record.type === "childList" ||
                record.target.localName === "link" ||
                (record.target.localName === "base" &&
                  record.attributeName === "href")
            )
          ) {
            this.#scheduleChanged();
          }
        });
        this.#observeHead();
        this.#scheduleChanged();
        break;
    }
  }

  #observeHead() {
    this.#observer.disconnect();
    this.#observedRoot = this.document.documentElement;
    this.#observedHead = this.document.head;
    // Watch head/root replacement without observing the body subtree.
    this.#observer.observe(this.document, { childList: true });
    if (this.#observedRoot) {
      this.#observer.observe(this.#observedRoot, { childList: true });
    }
    if (this.#observedHead) {
      this.#observer.observe(this.#observedHead, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["href", "rel", "type", "title"],
      });
    }
  }

  #scheduleChanged() {
    // Keep one pending notification, even on continuously mutating pages.
    if (this.#changeTimer !== null) {
      return;
    }
    const document = this.document;
    this.#changeTimer = setTimeout(() => {
      this.#changeTimer = null;
      if (this.#observer && this.document === document) {
        this.sendAsyncMessage("Feeds:Changed");
      }
    }, CHANGE_DELAY_MS);
  }

  #stopObserving() {
    this.#observer?.disconnect();
    this.#observer = null;
    this.#observedRoot = null;
    this.#observedHead = null;
    if (this.#changeTimer !== null) {
      clearTimeout(this.#changeTimer);
      this.#changeTimer = null;
    }
  }

  didDestroy() {
    this.#stopObserving();
  }

  receiveMessage({ name }) {
    if (name !== "Feeds:Discover" || this.browsingContext.parent) {
      return [];
    }

    const document = this.document;
    if (!/^https?:/.test(document.documentURI)) {
      return [];
    }

    const feeds = [];
    const seen = new Set();
    const links = document.getElementsByTagName("link");
    for (let i = 0; i < Math.min(links.length, MAX_LINKS); i++) {
      const link = links[i];
      const rel = (link.getAttribute("rel") || "").toLowerCase();
      const type = (link.getAttribute("type") || "")
        .split(";", 1)[0]
        .trim()
        .toLowerCase();
      if (!rel.split(/\s+/).includes("alternate") || !FEED_TYPES.has(type)) {
        continue;
      }

      const href = link.getAttribute("href");
      if (!href || href.length > MAX_URL_LENGTH) {
        continue;
      }
      try {
        const url = new URL(href, document.baseURI);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          continue;
        }
        url.hash = "";
        const feedURL = url.href;
        if (feedURL.length > MAX_URL_LENGTH || seen.has(feedURL)) {
          continue;
        }
        seen.add(feedURL);
        feeds.push({
          title: (link.getAttribute("title") || document.title || "").slice(
            0,
            MAX_TITLE_LENGTH
          ),
          feedURL,
        });
        if (feeds.length === MAX_FEEDS) {
          break;
        }
      } catch {
        // Invalid advertised URLs are not feeds.
      }
    }
    return feeds;
  }
}
