/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  StyleSheetUtils: "resource:///modules/StyleSheetUtils.sys.mjs",
});

const ACTIVETAB_PREF = "browser.tabs.copyurl.activetab";
const SHORTCUT_PREF = "browser.tabs.copyurl.shortcut";

const CSS_URI = "chrome://browser/content/waterfox/tabfeatures/tabfeatures.css";

export const TabFeatures = {
  _initialized: false,
  _windows: new WeakSet(),

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    lazy.StyleSheetUtils.registerStylesheet(
      CSS_URI,
      Ci.nsIStyleSheetService.AUTHOR_SHEET
    );
  },

  onWindowOpened(win) {
    if (this._windows.has(win)) {
      return;
    }
    this._windows.add(win);

    const doc = win.document;

    const tabContextMenu = doc.getElementById("tabContextMenu");
    tabContextMenu.addEventListener("popupshowing", event =>
      this.onMenuShowing(event)
    );
    tabContextMenu.addEventListener("popupshown", event =>
      this.onMenuShowing(event)
    );

    doc.getElementById("context_copyTabUrl").addEventListener("command", () => {
      const tab = win.TabContextMenu?.contextTab;
      if (tab?.linkedBrowser) {
        this.copyTabUrl(win, tab.linkedBrowser.currentURI.spec);
      }
    });

    doc
      .getElementById("context_copyAllTabUrls")
      .addEventListener("command", () => this.copyAllTabUrls(win));

    this._initCopyShortcut(win);
  },

  onMenuShowing(event) {
    const doc = event.target.ownerDocument;

    for (const el of doc.getElementsByClassName("tabFeature")) {
      const pref = el.getAttribute("preference");
      if (pref) {
        el.hidden = !Services.prefs.getBoolPref(pref, false);
      }
    }
  },

  copyTabUrl(win, url) {
    const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
      Ci.nsIClipboardHelper
    );
    if (Services.prefs.getBoolPref(ACTIVETAB_PREF, false)) {
      url = win.gBrowser.currentURI.spec;
    }
    clipboard.copyString(url);
  },

  copyAllTabUrls(win) {
    const clipboard = Cc["@mozilla.org/widget/clipboardhelper;1"].getService(
      Ci.nsIClipboardHelper
    );
    const urls = win.gBrowser.browsers
      .map(browser => browser.currentURI.spec)
      .filter(spec => !/^about:/i.test(spec));
    clipboard.copyString(urls.join("\n").trim());
  },

  _initCopyShortcut(win) {
    win.document.addEventListener(
      "keydown",
      event => {
        if (!Services.prefs.getBoolPref(SHORTCUT_PREF, true)) {
          return;
        }
        const accel =
          AppConstants.platform == "macosx" ? event.metaKey : event.ctrlKey;
        if (!accel || !event.shiftKey || event.key?.toLowerCase() != "u") {
          return;
        }
        const url = win.gBrowser.currentURI?.spec;
        if (!url) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        this.copyTabUrl(win, url);
        this._showCopyNotification(win, url);
      },
      true
    );
  },

  async _showCopyNotification(win, url) {
    try {
      const l10n = new Localization(["browser/waterfox/tabs.ftl"], true);
      const title = l10n.formatValueSync("waterfox-copy-url-notification");
      const text = url.length > 50 ? url.substring(0, 47) + "..." : url;
      Cc["@mozilla.org/alerts-service;1"]
        .getService(Ci.nsIAlertsService)
        .showAlertNotification(
          null,
          title,
          text,
          false,
          "",
          null,
          "tabfeatures-copyurl"
        );
    } catch (_e) {}
  },
};
