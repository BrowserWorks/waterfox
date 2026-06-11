/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  StyleSheetUtils: "resource:///modules/StyleSheetUtils.sys.mjs",
});

const BROWSER_WINDOW_TYPE = "navigator:browser";
const CHROME_URI = "chrome://browser/skin/waterfox/chrome.css";
const CONTENT_URI = "chrome://browser/skin/waterfox/content.css";
const loadedDocuments = new WeakSet();

export const WaterfoxStyles = {
  _initialized: false,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    Services.obs.addObserver(this, "browser-delayed-startup-finished");
    Services.obs.addObserver(this, "chrome-document-loaded");
    lazy.StyleSheetUtils.registerStylesheet(CONTENT_URI);

    for (const win of Services.wm.getEnumerator(BROWSER_WINDOW_TYPE)) {
      this._loadChromeSheet(win.document);
    }
  },

  observe(subject, topic) {
    if (topic == "browser-delayed-startup-finished") {
      this._loadChromeSheet(subject.document);
    } else if (topic == "chrome-document-loaded") {
      this._loadChromeSheet(subject);
    }
  },

  _loadChromeSheet(document) {
    const win = document?.defaultView;
    if (
      !win?.windowUtils ||
      win.document != document ||
      document.documentElement?.getAttribute("windowtype") !=
        BROWSER_WINDOW_TYPE ||
      loadedDocuments.has(document)
    ) {
      return;
    }

    try {
      win.windowUtils.loadSheetUsingURIString(
        CHROME_URI,
        Ci.nsIStyleSheetService.USER_SHEET
      );
      loadedDocuments.add(document);
    } catch (error) {
      console.error("Failed to load the Waterfox chrome stylesheet", error);
    }
  },
};
