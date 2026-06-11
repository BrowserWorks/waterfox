/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  ExperimentAPI: "resource://nimbus/ExperimentAPI.sys.mjs",
  StyleSheetUtils: "resource:///modules/StyleSheetUtils.sys.mjs",
  WaterfoxBlockerExtensionDetector:
    "resource:///modules/WaterfoxBlockerExtensionDetector.sys.mjs",
  WaterfoxBlockerPanel: "resource:///modules/WaterfoxBlockerPanel.sys.mjs",
  WaterfoxBlockerService: "resource:///modules/WaterfoxBlockerService.sys.mjs",
  WaterfoxSearchExtensionPolicy:
    "resource:///modules/WaterfoxSearchExtensionPolicy.sys.mjs",
  WaterfoxBrowserStyle: "resource:///modules/WaterfoxBrowserStyle.sys.mjs",
  WaterfoxTheme: "resource:///modules/WaterfoxTheme.sys.mjs",
});

const MIGRATION_PREF = "browser.migration.waterfox_version";
const MIGRATION_VERSION = 3;

const REMOVED_LEPTON_CONTENT_PREFS = [
  "userContent.player.ui",
  "userContent.player.icon",
  "userContent.player.noaudio",
  "userContent.player.size",
  "userContent.player.click_to_play",
  "userContent.player.animate",
  "userContent.newTab.hidden_logo",
  "userContent.newTab.full_icon",
  "userContent.newTab.animate",
  "userContent.newTab.searchbar",
  "userContent.page.field_border",
  "userContent.page.illustration",
  "userContent.page.proton_color",
  "userContent.page.dark_mode",
  "userContent.page.proton",
];

function setBoolPrefIfUnset(pref, value) {
  if (!Services.prefs.prefHasUserValue(pref)) {
    Services.prefs.setBoolPref(pref, value);
  }
}

function clearUserPrefs(prefs) {
  for (let pref of prefs) {
    if (Services.prefs.prefHasUserValue(pref)) {
      Services.prefs.clearUserPref(pref);
    }
  }
}

export const WaterfoxGlue = {
  init() {
    this.migrateUI();
    lazy.WaterfoxBrowserStyle.ensureCurrentStyle();

    // With Normandy compiled out nothing else starts Nimbus, leaving every
    // NimbusFeatures.ready() caller waiting forever. Initialise it here so
    // the local store settles; without recipe data each feature only ever
    // uses its fallback prefs.
    if (!AppConstants.MOZ_NORMANDY) {
      lazy.ExperimentAPI.init().catch(error =>
        console.error("ExperimentAPI startup init failed", error)
      );
    }

    lazy.StyleSheetUtils.registerStylesheet(
      "chrome://browser/skin/waterfox/general.css"
    );
    lazy.WaterfoxTheme.init();

    lazy.WaterfoxSearchExtensionPolicy.init();

    // Register the blocker window actors early so cosmetic filtering and
    // scriptlet hooks run for the first pages.
    ChromeUtils.registerWindowActor("WaterfoxBlocker", {
      parent: {
        esModuleURI: "resource:///modules/WaterfoxBlockerParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource:///modules/WaterfoxBlockerChild.sys.mjs",
        events: {
          DOMWindowCreated: {},
          DOMDocElementInserted: {},
        },
      },
      allFrames: true,
      messageManagerGroups: ["browsers"],
      // DOMWindowCreated can happen before URL match patterns settle.
      // Keep protocol matching broad and gate to http and https inside
      // the child.
      remoteTypes: ["web"],
    });

    // The blocked page actor handles the "Load anyway" click so the parent
    // can record a session permission before the navigation happens.
    ChromeUtils.registerWindowActor("WaterfoxBlockedPage", {
      parent: {
        esModuleURI: "resource:///modules/WaterfoxBlockedPageParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource:///modules/WaterfoxBlockedPageChild.sys.mjs",
        events: {
          click: {},
        },
      },
      matches: ["about:contentblocked?*"],
      allFrames: true,
    });

    lazy.WaterfoxBlockerPanel.init();
    lazy.WaterfoxBlockerExtensionDetector.init();
    lazy.WaterfoxBlockerService.init().catch(error =>
      console.error("WaterfoxBlockerService startup init failed", error)
    );
  },

  // Runs once per profile upgrade. Migrations for profiles coming from
  // earlier Waterfox versions go here, keyed on the version they left
  // off at. Version 2 is where Waterfox 140 profiles ended up.
  migrateUI() {
    const version = Services.prefs.getIntPref(MIGRATION_PREF, 0);
    if (version >= MIGRATION_VERSION) {
      return;
    }

    // Version 3 makes Nova the default appearance for new profiles. Waterfox
    // 140 (version 2) shipped Photon with Lepton on, so pin those values for an
    // upgrading profile that never chose an appearance, otherwise the upgrade
    // silently switches it to Nova (D1). Nova keeps Lepton chrome styling but
    // defaults tab styling to stock, so version-2 upgrades also pin the legacy
    // Photon tab style when the user did not customise those prefs.
    if (version == 2) {
      if (
        !Services.prefs.prefHasUserValue(
          "browser.theme.enableWaterfoxCustomizations"
        )
      ) {
        Services.prefs.setIntPref(
          "browser.theme.enableWaterfoxCustomizations",
          1
        );
      }
      if (!Services.prefs.prefHasUserValue("browser.nova.enabled")) {
        Services.prefs.setBoolPref("browser.nova.enabled", false);
      }
      for (let [pref, value] of Object.entries(
        lazy.WaterfoxBrowserStyle.PHOTON_TAB_STYLE
      )) {
        setBoolPrefIfUnset(pref, value);
      }
    }

    clearUserPrefs(REMOVED_LEPTON_CONTENT_PREFS);

    Services.prefs.setIntPref(MIGRATION_PREF, MIGRATION_VERSION);
  },
};
