/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global */

const EXPORTED_SYMBOLS = ["TabFeatures"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

const { AppConstants } = ChromeUtils.import(
  "resource://gre/modules/AppConstants.jsm"
);

const TabFeatures = {
  PREF_ACTIVETAB: "browser.tabs.copyurl.activetab",
  PREF_REQUIRECONFIRM: "browser.restart_menu.requireconfirm",
  PREF_PURGECACHE: "browser.restart_menu.purgecache",

  get browserBundle() {
    return Services.strings.createBundle(
      "chrome://extensibles/locale/extensibles.properties"
    );
  },
  get brandBundle() {
    return Services.strings.createBundle(
      "chrome://branding/locale/brand.properties"
    );
  },

  init(window) {
    window.TabFeatures = this;
    this.initListeners(window);
  },

  initListeners(aWindow) {
    aWindow.document
      .getElementById("tabContextMenu")
      ?.addEventListener("popupshowing", this.tabContext);
    if (AppConstants.platform == "macosx") {
      aWindow.document
        .getElementById("file-menu")
        ?.addEventListener("popupshowing", this.tabContext);
    } else {
      aWindow.document
        .getElementById("appMenu-popup")
        ?.addEventListener("popupshowing", this.tabContext);
    }
  },

  tabContext(aEvent) {
    let win = aEvent.view;
    if (!win) {
      win = Services.wm.getMostRecentWindow("navigator:browser");
    }
    let { document } = win;
    let elements = document.getElementsByClassName("tabFeature");
    for (let i = 0; i < elements.length; i++) {
      let el = elements[i];
      let pref = el.getAttribute("preference");
      if (pref) {
        let visible = Services.prefs.getBoolPref(pref);
        el.hidden = !visible;
      }
    }
    // Can't unload selected tab, so don't show menu item in that case
    if (win.TabContextMenu.contextTab === win.gBrowser.selectedTab) {
      const el = document.getElementById("context_unloadTab");
      el.hidden = true;
    }
  },

  // Copies current tab url to clipboard
  copyTabUrl(aUri, aWindow) {
    const gClipboardHelper = Cc[
      "@mozilla.org/widget/clipboardhelper;1"
    ].getService(Ci.nsIClipboardHelper);
    try {
      Services.prefs.getBoolPref(this.PREF_ACTIVETAB)
        ? gClipboardHelper.copyString(aWindow.gBrowser.currentURI.spec)
        : gClipboardHelper.copyString(aUri);
    } catch (e) {
      throw new Error(
        "We're sorry but something has gone wrong with 'CopyTabUrl' " + e
      );
    }
  },

  // Copies all tab urls to clipboard
  copyAllTabUrls(aWindow) {
    const gClipboardHelper = Cc[
      "@mozilla.org/widget/clipboardhelper;1"
    ].getService(Ci.nsIClipboardHelper);
    //Get all urls
    let urlArr = this._getAllUrls(aWindow);
    try {
      // Enumerate all urls in to a list.
      let urlList = urlArr.join("\n");
      // Send list to clipboard.
      gClipboardHelper.copyString(urlList.trim());
      // Clear url list after clipboard event
      urlList = "";
    } catch (e) {
      throw new Error(
        "We're sorry but something has gone wrong with 'copyAllTabUrls' " + e
      );
    }
  },

  // Get all the tab urls into an array.
  _getAllUrls(aWindow) {
    // We don't want to copy about uri's
    let blocklist = /^about:.*/i;
    let urlArr = [];
    let tabCount = aWindow.gBrowser.browsers.length;
    Array(tabCount)
      .fill()
      .map((_, i) => {
        let spec = aWindow.gBrowser.getBrowserAtIndex(i).currentURI.spec;
        if (!blocklist.test(spec)) {
          urlArr.push(spec);
        }
      });
    return urlArr;
  },

  async restartBrowser() {
    try {
      if (Services.prefs.getBoolPref(this.PREF_REQUIRECONFIRM)) {
        // Need brand in here to be able to expand { -brand-short-name }
        let l10n = new Localization([
          "branding/brand.ftl",
          "browser/extensibles.ftl",
        ]);
        let [title, question] = (
          await l10n.formatMessages([
            { id: "restart-prompt-title" },
            { id: "restart-prompt-question" },
          ])
        ).map(({ value }) => value);

        if (Services.prompt.confirm(null, title, question)) {
          // only restart if confirmation given
          this._attemptRestart();
        }
      } else {
        this._attemptRestart();
      }
    } catch (e) {
      Cu.reportError(
        "We're sorry but something has gone wrong with 'restartBrowser' " + e
      );
    }
  },

  _attemptRestart() {
    // Purge cache if required
    if (Services.prefs.getBoolPref(this.PREF_PURGECACHE)) {
      Services.appinfo.invalidateCachesOnRestart();
    }

    // Initiate the restart
    Services.startup.quit(
      Services.startup.eRestart | Services.startup.eAttemptQuit
    );
  },
};
