/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  PrivateTab: "resource:///modules/PrivateTab.sys.mjs",
  StatusBar: "resource:///modules/StatusBar.sys.mjs",
  TabFeatures: "resource:///modules/TabFeatures.sys.mjs",
  TabGrouping: "resource:///modules/TabGrouping.sys.mjs",
  TreeTabsStore: "resource:///modules/TreeTabsStore.sys.mjs",
  TreeTabsUI: "resource:///modules/TreeTabsUI.sys.mjs",
  UICustomizations: "resource:///modules/UICustomizations.sys.mjs",
  WaterfoxBlockerExtensionDetector:
    "resource:///modules/WaterfoxBlockerExtensionDetector.sys.mjs",
  WaterfoxBlockerPanel: "resource:///modules/WaterfoxBlockerPanel.sys.mjs",
  WaterfoxBlockerService: "resource:///modules/WaterfoxBlockerService.sys.mjs",
  WaterfoxSearchExtensionPolicy:
    "resource:///modules/WaterfoxSearchExtensionPolicy.sys.mjs",
  WaterfoxBrowserStyle: "resource:///modules/WaterfoxBrowserStyle.sys.mjs",
  WaterfoxStyles: "resource:///modules/WaterfoxStyles.sys.mjs",
  WaterfoxTheme: "resource:///modules/WaterfoxTheme.sys.mjs",
  WaterfoxThemeColors: "resource:///modules/WaterfoxThemeColors.sys.mjs",
});

const MIGRATION_PREF = "browser.migration.waterfox_version";
const LEGACY_STYLE_PREF = "browser.theme.enableWaterfoxCustomizations";
const LEGACY_STOCK_STYLE = 2;
const GECKO_MIGRATION_PREF = "browser.migration.version";
// Last Gecko profile data version written by the ESR140-based 6.6 line.
const LAST_66_GECKO_VERSION = 155;
const NOVA_PREF = "browser.nova.enabled";
const MIGRATION_VERSION = 6;
const SIDEBAR_MIGRATION_VERSION = 4;
const SIDEBAR_REVAMP_PREF = "sidebar.revamp";
const SIDEBAR_DEFAULT_LAUNCHER_VISIBLE_PREF =
  "sidebar.revamp.defaultLauncherVisible";

function setBoolPrefIfUnset(pref, value) {
  if (
    !Services.prefs.prefHasUserValue(pref) &&
    !Services.prefs.prefIsLocked(pref)
  ) {
    Services.prefs.setBoolPref(pref, value);
  }
}

export const WaterfoxGlue = {
  init() {
    // Bring the tree tabs store up before any window restores, so its session
    // restore handling and the one time pref migration run first.
    lazy.TreeTabsStore.init();

    this.migrateUI();
    lazy.WaterfoxBrowserStyle.ensureCurrentStyle();

    lazy.WaterfoxStyles.init();
    lazy.WaterfoxTheme.init();
    lazy.WaterfoxThemeColors.init();

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

    // The onboarding page is served as about:welcome and talks to the parent
    // through this actor for locale switching and applying setup choices.
    ChromeUtils.registerWindowActor("WaterfoxOnboarding", {
      parent: {
        esModuleURI: "resource:///modules/WaterfoxOnboardingParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource:///modules/WaterfoxOnboardingChild.sys.mjs",
        events: {
          DOMDocElementInserted: {},
        },
      },
      matches: ["about:welcome", "about:welcome?*"],
      remoteTypes: ["parent", "privilegedabout"],
    });

    lazy.WaterfoxBlockerPanel.init();
    lazy.WaterfoxBlockerExtensionDetector.init();
    lazy.WaterfoxBlockerService.init().catch(error =>
      console.error("WaterfoxBlockerService startup init failed", error)
    );

    lazy.PrivateTab.init();
    lazy.StatusBar.init();
    lazy.TabFeatures.init();
    lazy.TabGrouping.init();
    lazy.UICustomizations.init();
    Services.obs.addObserver(this, "browser-delayed-startup-finished");
  },

  observe(subject, topic) {
    switch (topic) {
      case "browser-delayed-startup-finished":
        lazy.PrivateTab.onWindowOpened(subject);
        lazy.StatusBar.onWindowOpened(subject);
        lazy.TabFeatures.onWindowOpened(subject);
        lazy.TabGrouping.onWindowOpened(subject);
        lazy.UICustomizations.onWindowOpened(subject);
        lazy.TreeTabsUI.onWindowOpened(subject);
        break;
    }
  },

  prepareProfileUpgrade() {
    const version = Services.prefs.getIntPref(MIGRATION_PREF, 0);
    if (version <= 0 || version >= SIDEBAR_MIGRATION_VERSION) {
      return;
    }

    setBoolPrefIfUnset(SIDEBAR_REVAMP_PREF, false);
    setBoolPrefIfUnset(SIDEBAR_DEFAULT_LAUNCHER_VISIBLE_PREF, false);
  },

  // Runs once per profile upgrade. Migrations for profiles coming from
  // earlier Waterfox versions go here, keyed on the version they left
  // off at. Versions 1 through 3 are pre-6.7 releases (6.6.17 wrote 3),
  // version 4 is Waterfox 6.7.0.
  migrateUI() {
    this.prepareProfileUpgrade();

    const version = Services.prefs.getIntPref(MIGRATION_PREF, 0);
    if (version >= MIGRATION_VERSION) {
      return;
    }

    if (version > 0 && version < 5) {
      // The legacy pref defaulted to 1 (customizations on) through 6.6.17 and
      // to 2 (off) from the 6.7 betas onwards, so an unset pref means Photon
      // on the former and Nova or Proton on the latter. Version 3 was written
      // by both 6.6.17 and the ESR153-based betas; the Gecko profile data
      // version tells them apart.
      const from66 =
        version < 3 ||
        (version == 3 &&
          Services.prefs.getIntPref(GECKO_MIGRATION_PREF, 0) <=
            LAST_66_GECKO_VERSION);
      const legacy = Services.prefs.getIntPref(
        LEGACY_STYLE_PREF,
        from66 ? 1 : LEGACY_STOCK_STYLE
      );
      let style = "photon";
      if (legacy == LEGACY_STOCK_STYLE) {
        style = Services.prefs.getBoolPref(NOVA_PREF, true) ? "nova" : "proton";
      }

      if (version == 4) {
        lazy.WaterfoxBrowserStyle.clearGeneratedPrefs(style);
      }
      lazy.WaterfoxBrowserStyle.setStyle(style);
    }

    Services.prefs.setIntPref(MIGRATION_PREF, MIGRATION_VERSION);
  },
};
