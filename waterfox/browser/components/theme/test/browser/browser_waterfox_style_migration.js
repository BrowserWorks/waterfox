/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WaterfoxGlue } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxGlue.sys.mjs"
);
const { WaterfoxBrowserStyle } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBrowserStyle.sys.mjs"
);

const MIGRATION_PREF = "browser.migration.waterfox_version";
const GECKO_MIGRATION_PREF = "browser.migration.version";
const GECKO_66_VERSION = 155;
const GECKO_67_VERSION = 175;
const ORIGINAL_GECKO_VERSION = Services.prefs.getIntPref(
  GECKO_MIGRATION_PREF,
  GECKO_67_VERSION
);
const LEGACY_STYLE_PREF = "browser.theme.enableWaterfoxCustomizations";
const CHROME_SHEET_PREF = "browser.theme.waterfox.chromeSheet";
const NOVA_PREF = "browser.nova.enabled";
const STYLE_PREF = "browser.theme.waterfox.browserStyle";
const LEGACY_STOCK_PRESET = Object.fromEntries(
  WaterfoxBrowserStyle.STYLE_PREFS.map(pref => [pref, false])
);

function reset() {
  for (const pref of [
    MIGRATION_PREF,
    LEGACY_STYLE_PREF,
    CHROME_SHEET_PREF,
    NOVA_PREF,
    STYLE_PREF,
    ...WaterfoxBrowserStyle.STYLE_PREFS,
  ]) {
    if (Services.prefs.prefHasUserValue(pref)) {
      Services.prefs.clearUserPref(pref);
    }
  }
  Services.prefs.setIntPref(GECKO_MIGRATION_PREF, ORIGINAL_GECKO_VERSION);
  WaterfoxBrowserStyle.applyStyle("nova");
}

function setPreset(preset) {
  for (const [pref, value] of Object.entries(preset)) {
    Services.prefs.setBoolPref(pref, value);
  }
}

function migrateFrom(version, setup = () => {}) {
  reset();
  if (version) {
    Services.prefs.setIntPref(MIGRATION_PREF, version);
  }
  setup();
  WaterfoxGlue.migrateUI();
  WaterfoxBrowserStyle.ensureCurrentStyle();
}

function defaultsMatch(style) {
  const defaults = Services.prefs.getDefaultBranch("");
  return Object.entries(WaterfoxBrowserStyle.PRESETS[style]).every(
    ([pref, value]) => defaults.getBoolPref(pref) == value
  );
}

registerCleanupFunction(reset);

add_task(async function test_new_profile_uses_nova_defaults() {
  migrateFrom(0);

  is(WaterfoxBrowserStyle.getStyle(), "nova", "New profiles use Nova");
  ok(defaultsMatch("nova"), "Nova uses the shipped preference defaults");
  ok(
    !Services.prefs.prefHasUserValue(STYLE_PREF),
    "The default style is not stored as a user choice"
  );
});

add_task(async function test_waterfox_66_upgrade() {
  migrateFrom(2);

  is(
    WaterfoxBrowserStyle.getStyle(),
    "photon",
    "Untouched 6.6 profiles keep Photon"
  );
  ok(defaultsMatch("photon"), "Photon receives its current defaults");
  ok(!Services.prefs.getBoolPref(NOVA_PREF), "Nova is disabled for Photon");

  migrateFrom(2, () => {
    Services.prefs.setIntPref(LEGACY_STYLE_PREF, 2);
  });

  is(
    WaterfoxBrowserStyle.getStyle(),
    "nova",
    "6.6 profiles with customizations off move to the stock style"
  );
});

add_task(async function test_waterfox_6617_upgrade() {
  migrateFrom(3, () => {
    Services.prefs.setIntPref(GECKO_MIGRATION_PREF, GECKO_66_VERSION);
  });

  is(
    WaterfoxBrowserStyle.getStyle(),
    "photon",
    "Untouched 6.6.17 profiles keep Photon"
  );
  ok(defaultsMatch("photon"), "Photon receives its current defaults");

  migrateFrom(3, () => {
    Services.prefs.setIntPref(GECKO_MIGRATION_PREF, GECKO_66_VERSION);
    Services.prefs.setIntPref(LEGACY_STYLE_PREF, 2);
  });

  is(
    WaterfoxBrowserStyle.getStyle(),
    "nova",
    "6.6.17 profiles with customizations off move to the stock style"
  );
});

add_task(async function test_waterfox_67_beta_upgrade() {
  migrateFrom(3, () => {
    Services.prefs.setIntPref(GECKO_MIGRATION_PREF, GECKO_67_VERSION);
  });

  is(
    WaterfoxBrowserStyle.getStyle(),
    "nova",
    "Untouched 6.7 beta profiles keep Nova"
  );

  migrateFrom(3, () => {
    Services.prefs.setIntPref(GECKO_MIGRATION_PREF, GECKO_67_VERSION);
    Services.prefs.setIntPref(LEGACY_STYLE_PREF, 1);
    Services.prefs.setBoolPref(NOVA_PREF, false);
  });

  is(
    WaterfoxBrowserStyle.getStyle(),
    "photon",
    "6.7 beta Photon choices are preserved"
  );
});

add_task(async function test_waterfox_670_upgrade() {
  for (const style of ["nova", "proton", "photon"]) {
    const override = "userChrome.tab.bar_separator";
    migrateFrom(4, () => {
      Services.prefs.setIntPref(LEGACY_STYLE_PREF, style == "photon" ? 1 : 2);
      Services.prefs.setBoolPref(NOVA_PREF, style == "nova");
      setPreset(
        style == "photon"
          ? WaterfoxBrowserStyle.PHOTON_PRESET
          : LEGACY_STOCK_PRESET
      );
      Services.prefs.setBoolPref(override, true);
    });

    is(WaterfoxBrowserStyle.getStyle(), style, `${style} is preserved`);
    ok(defaultsMatch(style), `${style} receives its current defaults`);
    ok(
      WaterfoxBrowserStyle.STYLE_PREFS.every(
        pref => pref == override || !Services.prefs.prefHasUserValue(pref)
      ),
      `${style} removes generated preference values`
    );
    ok(Services.prefs.getBoolPref(override), `${style} keeps custom values`);
    is(
      Services.prefs.getBoolPref(NOVA_PREF),
      style == "nova",
      `${style} keeps the Nova preference in sync`
    );
    is(
      Services.prefs.getIntPref(CHROME_SHEET_PREF),
      0,
      `${style} keeps customizations enabled`
    );
  }
});
