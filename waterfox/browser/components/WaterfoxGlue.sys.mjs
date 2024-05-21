/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  AttributionCode: "resource:///modules/AttributionCode.sys.mjs",
  BrowserUtils: "resource:///modules/BrowserUtils.sys.mjs",
  ChromeManifest: "resource:///modules/ChromeManifest.sys.mjs",
  Overlays: "resource:///modules/Overlays.sys.mjs",
  PrefUtils: "resource:///modules/PrefUtils.sys.mjs",
  PrivateTab: "resource:///modules/PrivateTab.sys.mjs",
  StatusBar: "resource:///modules/StatusBar.sys.mjs",
  TabFeatures: "resource:///modules/TabFeatures.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  UICustomizations: "resource:///modules/UICustomizations.sys.mjs",
});

const WATERFOX_CUSTOMIZATIONS_PREF =
  "browser.theme.enableWaterfoxCustomizations";

const WATERFOX_DEFAULT_THEMES = [
  "default-theme@mozilla.org",
  "firefox-compact-light@mozilla.org",
  "firefox-compact-dark@mozilla.org",
  "firefox-alpenglow@mozilla.org",
];

const WATERFOX_USERCHROME = "chrome://browser/skin/userChrome.css";
const WATERFOX_USERCONTENT = "chrome://browser/skin/userContent.css";

export const WaterfoxGlue = {
  _addonManagersListeners: [],

  async init() {
    // Set pref observers
    this._setPrefObservers();

    // Load always-on Waterfox custom CSS.
    lazy.BrowserUtils.registerStylesheet(
      "chrome://browser/skin/waterfox/general.css"
    );

    // Maybe load Waterfox stylesheets
    (async () => {
      let amInitialized = false;
      while (!amInitialized) {
        try {
          const activeThemeId = await this.getActiveThemeId();
          this.updateCustomStylesheets({ id: activeThemeId, type: "theme" });
          amInitialized = true;
        } catch (ex) {
          await new Promise(res => lazy.setTimeout(res, 500, {}));
        }
      }
    })();

    // Parse chrome.manifest
    this.startupManifest = await this.getChromeManifest("startup");
    this.privateManifest = await this.getChromeManifest("private");

    // Observe chrome-document-loaded topic to detect window open
    Services.obs.addObserver(this, "chrome-document-loaded");
    // Observe main-pane-loaded topic to detect about:preferences open
    Services.obs.addObserver(this, "main-pane-loaded");
    // Observe browser-delayed-startup-finished to launch delayed tasks
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
    // Observe browser shutdown
    Services.obs.addObserver(this, "quit-application-granted");
    // Listen for addon events
    this.addAddonListener();
  },

  async _setPrefObservers() {
    this.leptonListener = lazy.PrefUtils.addObserver(
      WATERFOX_CUSTOMIZATIONS_PREF,
      async _ => {
        const activeThemeId = await this.getActiveThemeId();
        this.updateCustomStylesheets({ id: activeThemeId, type: "theme" });
      }
    );
    this.pinnedTabListener = lazy.PrefUtils.addObserver(
      "browser.tabs.pinnedIconOnly",
      isEnabled => {
        // Pref being true actually means we need to unload the sheet, so invert.
        const uri = "chrome://browser/content/tabfeatures/pinnedtab.css";
        lazy.BrowserUtils.registerOrUnregisterSheet(uri, !isEnabled);
      }
    );
    this.styleSheetChanges = lazy.PrefUtils.addObserver(
      "browser.tabs.closeButtons",
      () => {
        // Pref being true actually means we need to unload the sheet, so invert.
        const uri = "chrome://browser/skin/waterfox/general.css";
        lazy.BrowserUtils.unregisterStylesheet(uri);
        lazy.BrowserUtils.registerStylesheet(uri);
      }
    )
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
      case "preferences-other":
        uri = "resource://waterfox/overlays/preferences-other.overlay";
        break;
    }
    let chromeManifest = new lazy.ChromeManifest(async () => {
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
            lazy.Overlays.load(this.privateManifest, window);
          } else {
            lazy.Overlays.load(this.startupManifest, window);
            // Only load in non-private browser windows
            lazy.PrivateTab.init(window);
          }
          // Load in all browser windows (private and normal)
          lazy.TabFeatures.init(window);
          lazy.StatusBar.init(window);
          lazy.UICustomizations.init(window);
        }
        break;
      case "main-pane-loaded":
        // Subject is preferences page content window
        if (!subject.initialized) {
          // If we are not loading directly on privacy, we need to wait until permissionsGroup
          // exists before we attempt to load our overlay. If we are loading directly on privacy
          // this exists before overlaying occurs, so we have no issues. Loading overlays on
          // #general is fine regardless of which pane we refresh/initially load.
          await lazy.Overlays.load(
            await this.getChromeManifest("preferences-general"),
            subject
          );
          if (
            !subject.document.getElementById("permissionsGroup") &&
            !subject.document.getElementById("homeContentsGroup")
          ) {
            subject.setTimeout(async () => {
              await lazy.Overlays.load(
                await this.getChromeManifest("preferences-other"),
                subject
              );
              subject.privacyInitialized = true;
            }, 500);
          } else {
            await lazy.Overlays.load(
              await this.getChromeManifest("preferences-other"),
              subject
            );
            subject.privacyInitialized = true;
          }
          subject.initialized = true;
        }
        break;
      case "final-ui-startup":
        this._beforeUIStartup();
        this._delayedTasks();
        this._monitorSidebarPref();
        break;
    }
  },

  async _beforeUIStartup() {
    this._migrateUI();

    lazy.AddonManager.maybeInstallBuiltinAddon(
      "addonstores@waterfox.net",
      "1.0.0",
      "resource://builtin-addons/addonstores/"
    )
  },

  async _monitorSidebarPref() {
    const COMPONENT_PREF = "browser.sidebar.disabled";
    const ID = "sidebar@waterfox.net";

    let addon = await lazy.AddonManager.getAddonByID(ID);

    // first time install of addon and install on update
    addon =
      (await lazy.AddonManager.maybeInstallBuiltinAddon(
        ID,
        "1.0.1",
        "resource://builtin-addons/sidebar/"
      )) || addon;

    const _checkSidebarPref = async () => {
      let componentEnabled = Services.prefs.getBoolPref(COMPONENT_PREF, false);
      if (componentEnabled) {
        if (addon.isActive) {
          await addon.disable({ allowSystemAddons: true });
        }
      } else {
        if (!addon.isActive) {
          await addon.enable({ allowSystemAddons: true });
        }
      }
    };

    Services.prefs.addObserver(COMPONENT_PREF, _checkSidebarPref);
    await _checkSidebarPref();
  },

  async _migrateUI() {
    let currentUIVersion = Services.prefs.getIntPref(
      "browser.migration.version",
      128
    );
    const waterfoxUIVersion = 1;

    if (!Services.prefs.prefHasUserValue("browser.migration.waterfox_version")) {
      // This is a new profile, nothing to migrate.
      Services.prefs.setIntPref("browser.migration.waterfox_version", waterfoxUIVersion);
      return;
    }
    
    async function enableTheme(id) {
      const addon = await lazy.AddonManager.getAddonByID(id);
      // If we found it, enable it.
      addon?.enable();
    }

    if (currentUIVersion < 128) {
      // Ensure the theme id is set correctly for G5
      const DEFAULT_THEME = "default-theme@mozilla.org";
      const themes = await AddonManager.getAddonsByTypes(["theme"]);
      let activeTheme = themes.find(addon => addon.isActive);
      if (activeTheme) {
        let themeId = activeTheme.id;
        switch (themeId) {
          case "lepton@waterfox.net":
            enableTheme("default-theme@mozilla.org");
            break;
          case "australis-light@waterfox.net":
            enableTheme("firefox-compact-light@mozilla.org");
            break;
          case "australis-dark@waterfox.net":
            enableTheme("firefox-compact-dark@mozilla.org");
            break;
        }
      } else {
        // If no activeTheme detected, set default.
        enableTheme(DEFAULT_THEME);
      }
    }

    if (waterfoxUIVersion < 1) {
      const themeEnablePref = "userChrome.theme.enable";
      const enabled = lazy.PrefUtils.get(themeEnablePref);
      lazy.PrefUtils.set(WATERFOX_CUSTOMIZATIONS_PREF, enabled ? 1 : 2);
    }

    lazy.PrefUtils.set("browser.migration.waterfox_version", 1);
  },

  async _delayedTasks() {
    let tasks = [
      {
        task: () => {
          // Reset prefs
          Services.prefs.clearUserPref(
            "startup.homepage_welcome_url.additional"
          );
          Services.prefs.clearUserPref("startup.homepage_override_url");
        },
      },
    ];

    for (const task of tasks) {
      task.task();
    }
  },

  async getActiveThemeId() {
    // Try to get active theme from the pref
    const activeThemeID = lazy.PrefUtils.get("extensions.activeThemeID", "");
    if (activeThemeID) {
      return activeThemeID;
    }
    // Otherwise just grab it from AddonManager
    const themes = await lazy.AddonManager.getAddonsByTypes(["theme"]);
    return themes.find(addon => addon.isActive).id;
  },

  addAddonListener() {
    let listener = {
      onInstalled: addon => this.updateCustomStylesheets(addon),
      onEnabled: addon => this.updateCustomStylesheets(addon),
    };
    this._addonManagersListeners.push(listener);
    lazy.AddonManager.addAddonListener(listener);
  },

  removeAddonListeners() {
    for (let listener of this._addonManagersListeners) {
      lazy.AddonManager.removeAddonListener(listener);
    }
  },

  updateCustomStylesheets(addon) {
    if (addon.type === "theme") {
      // If any theme and WF on any theme, reload stylesheets for every theme enable.
      // If WF theme and WF customisations, then reload stylesheets.
      // If no customizations, unregister sheets for every theme enable.
      if (
        lazy.PrefUtils.get(WATERFOX_CUSTOMIZATIONS_PREF, 0) === 0 ||
        (lazy.PrefUtils.get(WATERFOX_CUSTOMIZATIONS_PREF, 0) === 1 &&
          WATERFOX_DEFAULT_THEMES.includes(addon.id))
      ) {
        this.loadWaterfoxStylesheets();
      } else {
        this.unloadWaterfoxStylesheets();
      }
    }
  },

  loadWaterfoxStylesheets() {
    lazy.BrowserUtils.registerStylesheet(WATERFOX_USERCHROME);
    lazy.BrowserUtils.registerStylesheet(WATERFOX_USERCONTENT);
  },

  unloadWaterfoxStylesheets() {
    lazy.BrowserUtils.unregisterStylesheet(WATERFOX_USERCHROME);
    lazy.BrowserUtils.unregisterStylesheet(WATERFOX_USERCONTENT);
  },
};
