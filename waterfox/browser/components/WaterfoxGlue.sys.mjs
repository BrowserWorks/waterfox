/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  WaterfoxSearchExtensionPolicy:
    "resource:///modules/WaterfoxSearchExtensionPolicy.sys.mjs",
});

const MIGRATION_PREF = "browser.migration.waterfox_version";
const MIGRATION_VERSION = 2;

export const WaterfoxGlue = {
  init() {
    this.migrateUI();

    lazy.WaterfoxSearchExtensionPolicy.init();
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
