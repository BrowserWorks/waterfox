/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserUtils: "resource:///modules/BrowserUtils.sys.mjs",
  PrefUtils: "resource:///modules/PrefUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
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
  stylesEnabled: false,

  async init() {
    // Set pref observers
    this._setPrefObservers();

    // Maybe load Waterfox stylesheets
    (async () => {
      let amInitialized = false;
      while (!amInitialized) {
        try {
          const activeThemeId = await this.getActiveThemeId();
          this.updateCustomStylesheets({ id: activeThemeId, type: "theme" });
          amInitialized = true;
        } catch (ex) {
          await new Promise((res) => lazy.setTimeout(res, 500, {}));
        }
      }
    })();
    // Observe chrome-document-loaded topic to detect window open
    Services.obs.addObserver(this, "chrome-document-loaded");
    // Observe main-pane-loaded topic to detect about:preferences open
    Services.obs.addObserver(this, "main-pane-loaded");
    // Observe final-ui-startup to launch browser window dependant tasks
    Services.obs.addObserver(this, "final-ui-startup");
    // Observe browser shutdown
    Services.obs.addObserver(this, "quit-application-granted");
    // Listen for addon events
    this.addAddonListener();
  },

  async _setPrefObservers() {
    this.leptonListener = lazy.PrefUtils.addObserver(
      WATERFOX_CUSTOMIZATIONS_PREF,
      async (_) => {
        const activeThemeId = await this.getActiveThemeId();
        this.updateCustomStylesheets({ id: activeThemeId, type: "theme" });
      }
    );
    this.pinnedTabListener = lazy.PrefUtils.addObserver(
      "browser.tabs.pinnedIconOnly",
      (isEnabled) => {
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
    );
  },

  async observe(subject, topic, data) {
    switch (topic) {
      case "chrome-document-loaded":
          // Attach userChrome.css to this chrome window if styles are enabled
          if (this.stylesEnabled) {
            try {
              window.windowUtils.loadSheetUsingURIString(
                WATERFOX_USERCHROME,
                Ci.nsIStyleSheetService.USER_SHEET
              );
            } catch (_e) {}
          }
        break;
      case "main-pane-loaded":
      case "final-ui-startup":
        this._beforeUIStartup();
        this._delayedTasks();
        break;
      case "quit-application-granted":
        this.shutdown();
        break;
    }
  },

  async _beforeUIStartup() {
    this._migrateUI();

  },

  async _migrateUI() {
    const currentUIVersion = Services.prefs.getIntPref(
      "browser.migration.version",
      128
    );
    const waterfoxUIVersion = 2;

    if (
      !Services.prefs.prefHasUserValue("browser.migration.waterfox_version")
    ) {
      // This is a new profile, nothing to migrate.
      Services.prefs.setIntPref(
        "browser.migration.waterfox_version",
        waterfoxUIVersion
      );
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
      const activeTheme = themes.find((addon) => addon.isActive);
      if (activeTheme) {
        const themeId = activeTheme.id;
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

    if (waterfoxUIVersion < 2) {
      // Migrate Windows Registry values
      if ("@mozilla.org/windows-registry-key;1" in Components.classes) {
        const regKey = Components.classes[
          "@mozilla.org/windows-registry-key;1"
        ].createInstance(Components.interfaces.nsIWindowsRegKey);

        // Function to copy registry keys recursively
        const copyRegistryKeys = (fromRoot, toRoot, path) => {
          try {
            regKey.open(fromRoot, path, regKey.ACCESS_READ);
            const newKey = regKey.createChild(toRoot, path, regKey.ACCESS_ALL);

            // Copy values
            for (let i = 0; i < regKey.valueCount; i++) {
              const name = regKey.getValueName(i);
              const type = regKey.getValueType(name);

              switch (type) {
                case regKey.TYPE_STRING:
                  newKey.writeStringValue(name, regKey.readStringValue(name));
                  break;
                case regKey.TYPE_BINARY:
                  newKey.writeBinaryValue(name, regKey.readBinaryValue(name));
                  break;
                case regKey.TYPE_INT:
                  newKey.writeIntValue(name, regKey.readIntValue(name));
                  break;
                case regKey.TYPE_INT64:
                  newKey.writeInt64Value(name, regKey.readInt64Value(name));
                  break;
              }
            }

            // Recursively copy subkeys
            for (let i = 0; i < regKey.childCount; i++) {
              const childName = regKey.getChildName(i);
              copyRegistryKeys(fromRoot, toRoot, `${path}\\${childName}`);
            }

            newKey.close();
          } catch (e) {
            Console.warn("Error copying registry key:", e);
          } finally {
            regKey.close();
          }
        };

        // Copy from HKLM
        copyRegistryKeys(
          regKey.ROOT_KEY_LOCAL_MACHINE,
          regKey.ROOT_KEY_LOCAL_MACHINE,
          "SOFTWARE\\WaterfoxLimited",
          "SOFTWARE\\BrowserWorks"
        );
        copyRegistryKeys(
          regKey.ROOT_KEY_LOCAL_MACHINE,
          regKey.ROOT_KEY_LOCAL_MACHINE,
          "Software\\WaterfoxLimited",
          "Software\\BrowserWorks"
        );

        // Copy from HKCU
        copyRegistryKeys(
          regKey.ROOT_KEY_CURRENT_USER,
          regKey.ROOT_KEY_CURRENT_USER,
          "SOFTWARE\\WaterfoxLimited",
          "SOFTWARE\\BrowserWorks"
        );
        copyRegistryKeys(
          regKey.ROOT_KEY_CURRENT_USER,
          regKey.ROOT_KEY_CURRENT_USER,
          "Software\\WaterfoxLimited",
          "Software\\BrowserWorks"
        );
      }
    }

    lazy.PrefUtils.set("browser.migration.waterfox_version", 2);
  },

  async _delayedTasks() {
    const tasks = [
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
    return themes.find((addon) => addon.isActive).id;
  },

  addAddonListener() {
    const listener = {
      onInstalled: (addon) => this.updateCustomStylesheets(addon),
      onEnabled: (addon) => this.updateCustomStylesheets(addon),
    };
    this._addonManagersListeners.push(listener);
    lazy.AddonManager.addAddonListener(listener);
  },

  removeAddonListeners() {
    for (const listener of this._addonManagersListeners) {
      lazy.AddonManager.removeAddonListener(listener);
    }
  },

  shutdown() {
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

  // Attach userChrome.css to all open browser windows (per-window).
  attachUserChromeToAllWindows() {
    lazy.BrowserUtils.executeInAllWindows((win, uri) => {
      try {
        win.windowUtils.loadSheetUsingURIString(
          uri,
          Ci.nsIStyleSheetService.USER_SHEET
        );
      } catch (_e) {}
    }, WATERFOX_USERCHROME);
  },

  // Detach userChrome.css from all open browser windows.
  detachUserChromeFromAllWindows() {
    lazy.BrowserUtils.executeInAllWindows((win, uri) => {
      try {
        win.windowUtils.removeSheetUsingURIString(
          uri,
          Ci.nsIStyleSheetService.USER_SHEET
        );
      } catch (_e) {}
    }, WATERFOX_USERCHROME);
  },

  loadWaterfoxStylesheets() {
    // Register content sheet globally
    lazy.BrowserUtils.registerStylesheet(WATERFOX_USERCONTENT);
    // Attach chrome sheet to all current browser windows
    this.attachUserChromeToAllWindows();
    // Track enabled state so new windows can attach on open
    this.stylesEnabled = true;
  },

  unloadWaterfoxStylesheets() {
    // Detach chrome sheet from all windows
    this.detachUserChromeFromAllWindows();
    // Unregister content sheet globally
    lazy.BrowserUtils.unregisterStylesheet(WATERFOX_USERCONTENT);
    // Track disabled state so new windows don't attach on open
    this.stylesEnabled = false;
  },
};
