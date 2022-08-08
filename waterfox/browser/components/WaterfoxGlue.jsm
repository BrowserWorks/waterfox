/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["WaterfoxGlue"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  AddonManager: "resource://gre/modules/AddonManager.jsm",
  ChromeManifest: "resource:///modules/ChromeManifest.jsm",
  Overlays: "resource:///modules/Overlays.jsm",
  PrivateTab: "resource:///modules/PrivateTab.jsm",
  StatusBar: "resource:///modules/StatusBar.jsm",
  TabFeatures: "resource:///modules/TabFeatures.jsm",
  UICustomizations: "resource:///modules/UICustomizations.jsm",
});

XPCOMUtils.defineLazyGlobalGetters(this, ["fetch"]);

const WaterfoxGlue = {
  async init() {
    // Parse chrome.manifest
    this.startupManifest = await this.getChromeManifest("startup");
    this.privateManifest = await this.getChromeManifest("private");

    // Observe chrome-document-loaded topic to detect window open
    Services.obs.addObserver(this, "chrome-document-loaded");
    // Observe main-pane-loaded topic to detect about:preferences open
    Services.obs.addObserver(this, "main-pane-loaded");
    // Observe final-ui-startup to launch browser window dependant tasks
    Services.obs.addObserver(this, "final-ui-startup");
  },

  async getChromeManifest(manifest) {
    let uri;
    let privateWindow = false;
    switch (manifest) {
      case "startup":
        uri = "resource://waterfox/overlays/chrome.overlay";
        break;
      case "private":
        uri = "resource://waterfox/overlays/chrome.overlay";
        privateWindow = true;
        break;
      case "preferences-general":
        uri = "resource://waterfox/overlays/preferences-general.overlay";
        break;
      case "preferences-privacy":
        uri = "resource://waterfox/overlays/preferences-privacy.overlay";
        break;
      case "preferences-home":
        uri = "resource://waterfox/overlays/preferences-home.overlay";
        break;
    }
    let chromeManifest = new ChromeManifest(async () => {
      let res = await fetch(uri);
      let text = await res.text();
      if (privateWindow) {
        let tArr = text.split("\n");
        let indexPrivate = tArr.findIndex(overlay =>
          overlay.includes("private")
        );
        tArr.splice(indexPrivate, 1);
        text = tArr.join("\n");
      }
      return text;
    }, this.options);
    await chromeManifest.parse();
    return chromeManifest;
  },

  options: {
    application: Services.appinfo.ID,
    appversion: Services.appinfo.version,
    platformversion: Services.appinfo.platformVersion,
    os: Services.appinfo.OS,
    osversion: Services.sysinfo.getProperty("version"),
    abi: Services.appinfo.XPCOMABI,
  },

  async observe(subject, topic, data) {
    switch (topic) {
      case "chrome-document-loaded":
        // Only load overlays in new browser windows
        // baseURI for about:blank is also browser.xhtml, so use URL
        if (subject.URL.includes("browser.xhtml")) {
          const window = subject.defaultView;
          // Do not load non-private overlays in private window
          if (window.PrivateBrowsingUtils.isWindowPrivate(window)) {
            Overlays.load(this.privateManifest, window);
          } else {
            Overlays.load(this.startupManifest, window);
            // Only load in non-private browser windows
            PrivateTab.init(window);
          }
          // Load in all browser windows (private and normal)
          TabFeatures.init(window);
          StatusBar.init(window);
          UICustomizations.init(window);
        }
        break;
      case "main-pane-loaded":
        // Subject is preferences page content window
        if (!subject.initialized) {
          // If we are not loading directly on privacy, we need to wait until permissionsGroup
          // exists before we attempt to load our overlay. If we are loading directly on privacy
          // this exists before overlaying occurs, so we have no issues. Loading overlays on
          // #general is fine regardless of which pane we refresh/initially load.
          await Overlays.load(
            await this.getChromeManifest("preferences-general"),
            subject
          );
          if (
            !subject.document.getElementById("permissionsGroup") &&
            !subject.document.getElementById("homeContentsGroup")
          ) {
            subject.setTimeout(async () => {
              await Overlays.load(
                await this.getChromeManifest("preferences-privacy"),
                subject
              );
              await Overlays.load(
                await this.getChromeManifest("preferences-home"),
                subject
              );
              subject.privacyInitialized = true;
            }, 500);
          } else {
            await Overlays.load(
              await this.getChromeManifest("preferences-privacy"),
              subject
            );
            await Overlays.load(
              await this.getChromeManifest("preferences-home"),
              subject
            );
            subject.privacyInitialized = true;
          }
          subject.initialized = true;
        }
        break;
      case "final-ui-startup":
        this._beforeUIStartup();
        break;
    }
  },

  async _beforeUIStartup() {
    this._migrateUI();

    AddonManager.maybeInstallBuiltinAddon(
      "addonstores@waterfox.net",
      "1.0.0",
      "resource://builtin-addons/addonstores/"
    );
  },

  async _migrateUI() {
    let currentUIVersion = Services.prefs.getIntPref(
      "browser.migration.version"
    );

    async function enableTheme(id) {
      AddonManager.getAddonByID(id).then(addon => addon.enable());
    }

    if (currentUIVersion < 128) {
      // Ensure the theme id is set correctly for G5
      const DEFAULT_THEME = "default-theme@mozilla.org";
      AddonManager.getAddonsByTypes(["theme"]).then(themes => {
        let activeTheme = themes.find(addon => addon.isActive);
        if (activeTheme) {
          let themeId = activeTheme.id;
          if (themeId == "lepton@waterfox.net") {
            enableTheme("default-theme@mozilla.org");
          } else if (themeId == "australis-light@waterfox.net") {
            enableTheme("firefox-compact-light@mozilla.org");
          } else if (themeId == "australis-dark@waterfox.net") {
            enableTheme("firefox-compact-dark@mozilla.org");
          }
        } else {
          // If no activeTheme detected, set default.
          enableTheme(DEFAULT_THEME);
        }
      });
    }
  },
};
