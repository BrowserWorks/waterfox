/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  DISCOVERY_PREF,
  MAX_FEED_BYTES,
  XML_MIME_TYPES,
} from "resource:///modules/FeedConstants.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FeedPreview: "resource:///modules/FeedPreview.sys.mjs",
  parseFeed: "resource:///modules/FeedParser.sys.mjs",
});
const MAX_FEEDS = 20;
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 1024;

/** Validates untrusted discovery results against the current page principal. */
export class FeedDiscoveryParent extends JSWindowActorParent {
  #directChecked = false;

  #isCurrentDocument() {
    const { documentURI, documentPrincipal } = this.manager;
    return (
      !this.browsingContext.parent &&
      this.browsingContext.currentWindowGlobal === this.manager &&
      this.manager.isCurrentGlobal &&
      documentPrincipal.isContentPrincipal &&
      (documentURI?.schemeIs("http") || documentURI?.schemeIs("https"))
    );
  }

  receiveMessage({ name }) {
    if (name === "Feeds:Direct") {
      return this.#previewDirect();
    }
    if (
      name !== "Feeds:Changed" ||
      !Services.prefs.getBoolPref(DISCOVERY_PREF, true) ||
      !this.#isCurrentDocument()
    ) {
      return undefined;
    }

    const browser = this.browsingContext.top.embedderElement;
    const win = browser?.documentGlobal;
    if (browser && win?.gBrowser?.selectedBrowser === browser) {
      win.WaterfoxLiveBookmarks?.updateFeedButton(win);
    }
    return undefined;
  }

  async #previewDirect() {
    try {
      if (this.#directChecked || !this.#isCurrentDocument()) {
        return;
      }
      this.#directChecked = true;
      const context = this.browsingContext;
      const browser = context.embedderElement;
      const sourceURI = this.manager.documentURI;
      if (
        !browser?.documentGlobal?.gBrowser?.getTabForBrowser(browser) ||
        sourceURI.spec.length > MAX_URL_LENGTH ||
        sourceURI.userPass
      ) {
        return;
      }
      let superseded = false;
      const progress = {
        QueryInterface: ChromeUtils.generateQI([
          "nsIWebProgressListener",
          "nsISupportsWeakReference",
        ]),
        onStateChange(webProgress, _request, flags) {
          if (
            webProgress.isTopLevel &&
            flags & Ci.nsIWebProgressListener.STATE_START
          ) {
            superseded = true;
          }
        },
      };
      browser.addProgressListener(
        progress,
        Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT
      );
      let xml;
      try {
        xml = await this.sendQuery("Feeds:ReadDirect");
      } finally {
        browser.removeProgressListener(progress);
      }
      if (
        superseded ||
        typeof xml !== "string" ||
        xml.length > MAX_FEED_BYTES ||
        (!XML_MIME_TYPES.includes(browser.documentContentType) &&
          browser.documentContentType !== "text/plain") ||
        !this.#isCurrentDocument() ||
        browser.browsingContext !== context ||
        !browser.currentURI.equals(sourceURI) ||
        !this.manager.documentURI.equals(sourceURI)
      ) {
        return;
      }
      const feedURI = sourceURI.mutate().setRef("").finalize();
      Services.scriptSecurityManager.checkLoadURIWithPrincipal(
        this.manager.documentPrincipal,
        feedURI,
        Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL
      );
      const feedURL = feedURI.spec;
      const feed = lazy.parseFeed(xml, feedURL);
      const previewURL = lazy.FeedPreview.set(context, { feedURL, feed });
      // Preserve the parsed snapshot across the process switch and replace the
      // raw XML history entry with its reloadable preview.
      // Target this browser, not the selected tab; background loads are valid.
      browser.loadURI(Services.io.newURI(previewURL), {
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
        loadFlags: Ci.nsIWebNavigation.LOAD_FLAGS_REPLACE_HISTORY,
      });
    } catch {
      // Invalid feeds and documents replaced during the query remain untouched.
    }
  }

  // Chrome callers must use discover(), not sendQuery(), to validate IPC results.
  async discover() {
    try {
      if (
        !Services.prefs.getBoolPref(DISCOVERY_PREF, true) ||
        !this.#isCurrentDocument()
      ) {
        return [];
      }
      const candidates = await this.sendQuery("Feeds:Discover");
      if (
        !Services.prefs.getBoolPref(DISCOVERY_PREF, true) ||
        !this.#isCurrentDocument() ||
        !Array.isArray(candidates) ||
        candidates.length > MAX_FEEDS
      ) {
        return [];
      }

      const feeds = [];
      const seen = new Set();
      for (const candidate of candidates) {
        if (
          !candidate ||
          typeof candidate.title !== "string" ||
          candidate.title.length > MAX_TITLE_LENGTH ||
          typeof candidate.feedURL !== "string" ||
          !candidate.feedURL ||
          candidate.feedURL.length > MAX_URL_LENGTH ||
          /[\p{Cc}\s]/u.test(candidate.feedURL)
        ) {
          continue;
        }
        try {
          const uri = Services.io.newURI(
            candidate.feedURL,
            null,
            this.manager.documentURI
          );
          if (
            (!uri.schemeIs("http") && !uri.schemeIs("https")) ||
            uri.userPass
          ) {
            continue;
          }
          const feedURI = uri.mutate().setRef("").finalize();
          Services.scriptSecurityManager.checkLoadURIWithPrincipal(
            this.manager.documentPrincipal,
            feedURI,
            Ci.nsIScriptSecurityManager.DISALLOW_INHERIT_PRINCIPAL
          );
          const feedURL = feedURI.spec;
          if (feedURL.length > MAX_URL_LENGTH || seen.has(feedURL)) {
            continue;
          }
          seen.add(feedURL);
          feeds.push({ title: candidate.title, feedURL });
        } catch {
          // A compromised child cannot advertise privileged or invalid URLs.
        }
      }
      return feeds;
    } catch {
      // Navigation can destroy the actor while discovery is outstanding.
      return [];
    }
  }
}
