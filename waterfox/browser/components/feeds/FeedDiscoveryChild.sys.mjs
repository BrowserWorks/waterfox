/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";

import {
  DISCOVERY_PREF,
  FEED_MIME_TYPES,
  MAX_FEED_BYTES,
  XML_MIME_TYPES,
} from "resource:///modules/FeedConstants.sys.mjs";

const MAX_XML_NODES = 100000;
const MAX_FEEDS = 20;
const MAX_LINKS = 1000;
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 1024;
const MAX_MUTATION_RECORDS = 100;
const CHANGE_DELAY_MS = 100;

/** Signals advertisement changes; reads feeds only on chrome's request. */
export class FeedDiscoveryChild extends JSWindowActorChild {
  #observer = null;
  #observedRoot = null;
  #observedHead = null;
  #changeTimer = null;
  #active = true;
  #directChecked = false;

  actorCreated() {
    Services.prefs.addObserver(DISCOVERY_PREF, this.#onDiscoveryPrefChanged);
  }

  #onDiscoveryPrefChanged = () => {
    this.#stopObserving();
    this.#startObserving();
  };

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
        this.#active = false;
        this.#stopObserving();
        break;
      case "DOMContentLoaded":
      case "pageshow":
        this.#active = true;
        this.#startObserving();
        if (!this.#directChecked && this.#isDirectCandidate()) {
          this.#directChecked = true;
          this.sendAsyncMessage("Feeds:Direct");
        }
        break;
    }
  }

  #canDiscover() {
    return (
      this.#active &&
      !this.browsingContext.parent &&
      Services.prefs.getBoolPref(DISCOVERY_PREF, true) &&
      /^https?:/.test(this.document.documentURI) &&
      ["text/html", "application/xhtml+xml"].includes(this.document.contentType)
    );
  }

  #startObserving() {
    if (this.#observer || !this.#canDiscover()) {
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
  }

  #isDirectCandidate() {
    const document = this.document;
    if (
      !this.#active ||
      this.browsingContext.parent ||
      !/^https?:/.test(document.documentURI) ||
      document.readyState === "loading" ||
      document.doctype
    ) {
      return false;
    }
    if (document.contentType === "text/plain") {
      return true;
    }
    const root = document.documentElement;
    return (
      XML_MIME_TYPES.includes(document.contentType) &&
      root &&
      ((root.localName === "rss" && !root.namespaceURI) ||
        (root.localName === "RDF" &&
          root.namespaceURI ===
            "http://www.w3.org/1999/02/22-rdf-syntax-ns#") ||
        (root.localName === "feed" &&
          ["http://www.w3.org/2005/Atom", "http://purl.org/atom/ns#"].includes(
            root.namespaceURI
          )))
    );
  }

  #readDirect() {
    if (!this.#isDirectCandidate()) {
      return null;
    }
    const document = this.document;
    const plain = document.contentType === "text/plain";
    const root = plain ? document.body : document;
    if (!root) {
      return null;
    }
    // Bound traversal and allocation before serializing an untrusted DOM.
    const walker = document.createTreeWalker(root, 0xffffffff);
    let size = 0;
    let count = 0;
    for (let node = root; node; node = walker.nextNode()) {
      size += (node.nodeValue?.length || 0) + node.nodeName.length * 2 + 5;
      if (node.attributes) {
        for (const attribute of node.attributes) {
          size += attribute.name.length + attribute.value.length + 4;
        }
      }
      if (++count > MAX_XML_NODES || size > MAX_FEED_BYTES) {
        return null;
      }
    }
    const xml = plain
      ? root.textContent
      : new XMLSerializer().serializeToString(root);
    if (xml.length > MAX_FEED_BYTES || !xml.trimStart().startsWith("<")) {
      return null;
    }
    return xml;
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
      if (this.#observer && this.#canDiscover() && this.document === document) {
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
    Services.prefs.removeObserver(DISCOVERY_PREF, this.#onDiscoveryPrefChanged);
    this.#stopObserving();
  }

  receiveMessage({ name }) {
    if (name === "Feeds:ReadDirect") {
      return this.#readDirect();
    }
    if (name !== "Feeds:Discover" || !this.#canDiscover()) {
      return [];
    }
    this.#startObserving();
    const document = this.document;

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
      if (
        !rel.split(/\s+/).includes("alternate") ||
        !FEED_MIME_TYPES.includes(type)
      ) {
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
