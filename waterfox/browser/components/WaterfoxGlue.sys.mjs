/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  WaterfoxBlockerService: "resource:///modules/WaterfoxBlockerService.sys.mjs",
  WaterfoxSearchExtensionPolicy:
    "resource:///modules/WaterfoxSearchExtensionPolicy.sys.mjs",
});

const MIGRATION_PREF = "browser.migration.waterfox_version";
const MIGRATION_VERSION = 2;

export const WaterfoxGlue = {
  init() {
    this.migrateUI();

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

    Services.prefs.setIntPref(MIGRATION_PREF, MIGRATION_VERSION);
  },
};
