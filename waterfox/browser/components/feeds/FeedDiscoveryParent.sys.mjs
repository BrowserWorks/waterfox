/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const MAX_FEEDS = 20;
const MAX_URL_LENGTH = 4096;
const MAX_TITLE_LENGTH = 1024;

/** Validates untrusted discovery results against the current page principal. */
export class FeedDiscoveryParent extends JSWindowActorParent {
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
    if (name !== "Feeds:Changed" || !this.#isCurrentDocument()) {
      return;
    }

    const browser = this.browsingContext.top.embedderElement;
    const win = browser?.documentGlobal;
    if (browser && win?.gBrowser?.selectedBrowser === browser) {
      win.WaterfoxLiveBookmarks?.updateFeedButton(win);
    }
  }

  // Chrome callers must use discover(), not sendQuery(), to validate IPC results.
  async discover() {
    try {
      if (!this.#isCurrentDocument()) {
        return [];
      }
      const candidates = await this.sendQuery("Feeds:Discover");
      if (
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
