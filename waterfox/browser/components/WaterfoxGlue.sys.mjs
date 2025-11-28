/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const WaterfoxGlue = {

  async init() {
    // Set pref observers
    this._setPrefObservers();

    // Observe chrome-document-loaded topic to detect window open
    Services.obs.addObserver(this, "chrome-document-loaded");
    // Observe main-pane-loaded topic to detect about:preferences open
    Services.obs.addObserver(this, "main-pane-loaded");
    // Observe final-ui-startup to launch browser window dependant tasks
    Services.obs.addObserver(this, "final-ui-startup");
    // Observe browser shutdown
    Services.obs.addObserver(this, "quit-application-granted");
  },

  async _setPrefObservers() {
  },

  async observe(subject, topic, data) {
    switch (topic) {
      case "chrome-document-loaded":
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

  shutdown() {
  },
};
