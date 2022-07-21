/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */
"use strict";

const gMainPaneOverlay = {
  init() {
    // Initialize prefs
    window.Preferences.addAll(this.preferences);

    // Delayed initialization for Overlay dependent code
    this.delayedInit();
  },

  get preferences() {
    return [
      // Tab Toolbar Position
      { id: "browser.tabs.toolbarposition", type: "wstring" },

      // Tab Context Menu
      { id: "browser.tabs.duplicateTab", type: "bool" },
      { id: "browser.tabs.copyurl", type: "bool" },
      { id: "browser.tabs.activetab", type: "bool" },
      { id: "browser.tabs.copyallurls", type: "bool" },
      { id: "browser.tabs.unloadTab", type: "bool" },

      // Additional Tab Prefs
      { id: "browser.tabs.pinnedIconOnly", type: "bool" },
      { id: "browser.tabs.insertAfterCurrent", type: "bool" },
      { id: "browser.tabs.insertRelatedAfterCurrent", type: "bool" },

      // Dark Theme
      { id: "ui.systemUsesDarkTheme", type: "int" },

      // Restart Menu Item
      { id: "browser.restart_menu.purgecache", type: "bool" },
      { id: "browser.restart_menu.requireconfirm", type: "bool" },
      { id: "browser.restart_menu.showpanelmenubtn", type: "bool" },

      // Status Bar
      { id: "browser.statusbar.enabled", type: "bool" },
      { id: "browser.statusbar.appendStatusText", type: "bool" },

      // Bookmarks Toolbar Position
      { id: "browser.bookmarks.toolbarposition", type: "wstring" },

      // Geolocation API
      { id: "geo.provider.network.url", type: "wstring" },

      // Referer
      { id: "network.http.sendRefererHeader", type: "int" },

      // WebRTC P2P
      { id: "media.peerconnection.enabled", type: "bool" },

      // Images
      { id: "permissions.default.image", type: "int" },

      // Scripts
      { id: "javascript.enabled", type: "bool" },
    ];
  },

  delayedInit() {
    if (!window.initialized) {
      setTimeout(() => {
        this.delayedInit();
      }, 500);
    } else if (!document.initialized) {
      // Select the correct radio button based on current pref value
      this.showRelevantElements();
      this.setDynamicThemeGroupValue();
      this.setEventListener("dynamicThemeGroup", "command", event => {
        this.updateDynamicThemePref(event.target.value);
      });
      document.initialized = true;
    }
  },

  showRelevantElements() {
    let idsGeneral = [
      "dynamicThemeGroup",
      "restartGroup",
      "statusBarGroup",
      "bookmarksBarPositionGroup",
      "geolocationGroup",
    ];

    let idsPrivacy = ["webrtc", "refheader"];
    let win = Services.wm.getMostRecentWindow("navigator:browser");
    let uri = win.gBrowser.currentURI.spec;
    if (
      (uri == "about:preferences" || uri == "about:preferences#general") &&
      document.visibilityState == "visible"
    ) {
      for (let id of idsGeneral) {
        let el = document.getElementById(id);
        if (el) {
          el.removeAttribute("hidden");
        }
      }
    } else if (
      uri == "about:preferences#privacy" &&
      document.visibilityState == "visible"
    ) {
      for (let id of idsPrivacy) {
        let el = document.getElementById(id);
        if (el) {
          el.removeAttribute("hidden");
        }
      }
    }
  },

  setEventListener(aId, aEventType, aCallback) {
    document
      .getElementById(aId)
      ?.addEventListener(aEventType, aCallback.bind(gMainPaneOverlay));
  },

  async setDynamicThemeGroupValue() {
    let radiogroup = document.getElementById("dynamicThemeRadioGroup");
    radiogroup.disabled = true;

    radiogroup.value = Services.prefs.getIntPref("ui.systemUsesDarkTheme", -1);

    radiogroup.disabled = false;
  },

  async updateDynamicThemePref(value) {
    switch (value) {
      case "1":
        Services.prefs.setIntPref("ui.systemUsesDarkTheme", 1);
        break;
      case "0":
        Services.prefs.setIntPref("ui.systemUsesDarkTheme", 0);
        break;
      case "-1":
        Services.prefs.clearUserPref("ui.systemUsesDarkTheme");
        break;
    }
  },
};
