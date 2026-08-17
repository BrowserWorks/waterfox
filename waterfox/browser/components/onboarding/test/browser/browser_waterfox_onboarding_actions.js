/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { SpecialMessageActions } = ChromeUtils.importESModule(
  "resource://messaging-system/lib/SpecialMessageActions.sys.mjs"
);
const { LightweightThemeManager } = ChromeUtils.importESModule(
  "resource://gre/modules/LightweightThemeManager.sys.mjs"
);
const {
  WaterfoxThemeColors,
  WATERFOX_THEME_COLOR_PREF,
  WATERFOX_THEME_ID,
  WATERFOX_THEME_MODE_PREF,
} = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxThemeColors.sys.mjs"
);

const NOVA_PREF = "browser.nova.enabled";
const BROWSER_STYLE_PREF = "browser.theme.waterfox.browserStyle";
const TREE_TABS_PREF = "browser.tabs.verticalTabs.tree.enabled";
const VERTICAL_TABS_PREF = "sidebar.verticalTabs";
const TABBAR_POSITION_PREF = "browser.tabs.toolbarposition";
const UIDENSITY_PREF = "browser.uidensity";
const PRIVACY_PREF = "waterfox.blocker.enabled";
const SUPERNOVA_PREF = "userChrome.tab.supernova_like_contextline";

const { WaterfoxBrowserStyle } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBrowserStyle.sys.mjs"
);

const ACTION_PREFS = [
  NOVA_PREF,
  BROWSER_STYLE_PREF,
  TREE_TABS_PREF,
  VERTICAL_TABS_PREF,
  TABBAR_POSITION_PREF,
  UIDENSITY_PREF,
  PRIVACY_PREF,
  SUPERNOVA_PREF,
  WATERFOX_THEME_MODE_PREF,
  WATERFOX_THEME_COLOR_PREF,
  ...Object.keys(WaterfoxBrowserStyle.PHOTON_PRESET),
];

const WATERFOX_SCREEN_IDS = [
  "AW_WATERFOX_WELCOME",
  "AW_WATERFOX_IMPORT",
  "AW_WATERFOX_STYLE",
  "AW_WATERFOX_THEME_COLOR",
  "AW_WATERFOX_TABS",
  "AW_WATERFOX_PRIVACY",
  "AW_WATERFOX_DEFAULT_BROWSER",
  "AW_WATERFOX_FINISH",
];

const WATERFOX_COLOR_IDS = [
  "default",
  "smoke",
  "ash",
  "sun",
  "spark",
  "flame",
  "flare",
  "lavender",
  "dusk",
  "lagoon",
  "tide",
  "pine",
];

function clearUserPrefs(prefNames) {
  for (const prefName of prefNames) {
    if (Services.prefs.prefHasUserValue(prefName)) {
      Services.prefs.clearUserPref(prefName);
    }
  }
}

async function runWaterfoxAction(action, value) {
  await SpecialMessageActions.handleAction(
    {
      type: "WATERFOX_ONBOARDING",
      data: { action, value },
    },
    gBrowser.selectedBrowser
  );
}

registerCleanupFunction(() => {
  clearUserPrefs(ACTION_PREFS);
  WaterfoxBrowserStyle.applyStockStyle();
  WaterfoxThemeColors.clear();
});

add_task(
  async function test_waterfox_onboarding_actions_write_expected_prefs() {
    clearUserPrefs(ACTION_PREFS);
    WaterfoxBrowserStyle.applyStockStyle();
    WaterfoxThemeColors.clear();

    try {
      Services.prefs.setBoolPref(NOVA_PREF, false);
      WaterfoxBrowserStyle.applyPhotonStyle();

      await runWaterfoxAction("style", "nova");
      Assert.equal(
        Services.prefs.getBoolPref(NOVA_PREF),
        true,
        "Nova turns on"
      );
      Assert.equal(
        Services.prefs.getStringPref(BROWSER_STYLE_PREF),
        "nova",
        "Nova records the browser style"
      );
      Assert.equal(
        Services.prefs.getBoolPref("userChrome.tab.lepton_like_padding"),
        false,
        "Nova restores the stock tab style defaults"
      );
      Assert.ok(
        !Services.prefs.prefHasUserValue("userChrome.tab.lepton_like_padding"),
        "Nova does not write customization values"
      );
      Assert.ok(
        !Services.prefs.prefHasUserValue(SUPERNOVA_PREF),
        "Nova does not write the Supernova Lepton pref"
      );

      await runWaterfoxAction("style", "photon");
      Assert.equal(
        Services.prefs.getBoolPref(NOVA_PREF),
        false,
        "Photon turns Nova off"
      );
      Assert.equal(
        Services.prefs.getStringPref(BROWSER_STYLE_PREF),
        "photon",
        "Photon records the browser style"
      );
      Assert.equal(
        Services.prefs.getBoolPref("userChrome.tab.photon_like_contextline"),
        true,
        "Photon applies the Photon style defaults"
      );
      Assert.ok(
        !Services.prefs.prefHasUserValue(
          "userChrome.tab.photon_like_contextline"
        ),
        "Photon does not write customization values"
      );
      Assert.ok(
        !Services.prefs.prefHasUserValue(SUPERNOVA_PREF),
        "Photon does not write the Supernova Lepton pref"
      );

      await runWaterfoxAction("style", "proton");
      Assert.equal(
        Services.prefs.getBoolPref(NOVA_PREF),
        false,
        "Proton keeps Nova off"
      );
      Assert.equal(
        Services.prefs.getStringPref(BROWSER_STYLE_PREF),
        "proton",
        "Proton records the browser style"
      );
      Assert.equal(
        Services.prefs.getBoolPref("userChrome.tab.lepton_like_padding"),
        false,
        "Proton restores the stock tab style defaults"
      );
      Assert.ok(
        !Services.prefs.prefHasUserValue("userChrome.tab.lepton_like_padding"),
        "Proton does not write customization values"
      );

      await runWaterfoxAction("theme-mode", "dark");
      Assert.equal(
        Services.prefs.getStringPref(WATERFOX_THEME_MODE_PREF),
        "dark",
        "Theme mode writes the Waterfox mode pref"
      );
      Assert.equal(
        LightweightThemeManager.themeData.theme.id,
        WATERFOX_THEME_ID,
        "Theme mode applies Waterfox dynamic theme data"
      );
      Assert.equal(
        LightweightThemeManager.themeData.theme.color_scheme,
        "dark",
        "Dark mode applies dark theme data"
      );
      Assert.ok(
        !LightweightThemeManager.themeData.darkTheme,
        "Forced dark mode does not wait for the system variant"
      );

      await runWaterfoxAction("theme-color", "pine");
      Assert.equal(
        Services.prefs.getStringPref(WATERFOX_THEME_COLOR_PREF),
        "pine",
        "Theme color writes the Waterfox color pref"
      );
      Assert.equal(
        LightweightThemeManager.themeData.theme.toolbarColor,
        "#0a2015",
        "Color choice combines with the current dark mode"
      );

      await runWaterfoxAction("theme-color", "default");
      Assert.ok(
        !Services.prefs.prefHasUserValue(WATERFOX_THEME_COLOR_PREF),
        "Default theme color clears the Waterfox color pref"
      );
      Assert.equal(
        LightweightThemeManager.themeData.theme.toolbarColor,
        "#081a2d",
        "Default color keeps the current dark mode with default colors"
      );

      await runWaterfoxAction("theme-mode", "system");
      Assert.equal(
        Services.prefs.getStringPref(WATERFOX_THEME_MODE_PREF),
        "system",
        "System mode writes the Waterfox mode pref"
      );
      Assert.ok(
        LightweightThemeManager.themeData.darkTheme,
        "System mode keeps light and dark variants available"
      );
      Assert.notEqual(
        LightweightThemeManager.themeData.theme.toolbarColor,
        LightweightThemeManager.themeData.darkTheme.toolbarColor,
        "Light and dark variants visibly differ"
      );

      await runWaterfoxAction("density", "touch");
      Assert.equal(
        Services.prefs.getIntPref(UIDENSITY_PREF),
        2,
        "Density action writes the UI density pref"
      );

      await runWaterfoxAction("layout", "tree");
      Assert.equal(
        Services.prefs.getBoolPref(VERTICAL_TABS_PREF),
        true,
        "Tree layout enables vertical tabs"
      );
      Assert.equal(
        Services.prefs.getBoolPref(TREE_TABS_PREF),
        true,
        "Tree layout enables the tree"
      );

      await runWaterfoxAction("layout", "vertical");
      Assert.equal(
        Services.prefs.getBoolPref(VERTICAL_TABS_PREF),
        true,
        "Vertical layout keeps vertical tabs on"
      );
      Assert.equal(
        Services.prefs.getBoolPref(TREE_TABS_PREF),
        false,
        "Vertical layout turns the tree off"
      );

      await runWaterfoxAction("layout", "horizontal");
      Assert.equal(
        Services.prefs.getBoolPref(TREE_TABS_PREF),
        false,
        "Horizontal layout keeps the tree off"
      );
      Assert.equal(
        Services.prefs.getBoolPref(VERTICAL_TABS_PREF),
        false,
        "Horizontal layout disables vertical tabs"
      );

      await runWaterfoxAction("tab-location", "bottomabove");
      Assert.equal(
        Services.prefs.getStringPref(TABBAR_POSITION_PREF),
        "bottomabove",
        "Tab location action writes the tab strip position"
      );

      Services.prefs.setBoolPref(PRIVACY_PREF, false);
      await runWaterfoxAction("privacy-defaults", true);
      Assert.equal(
        Services.prefs.getBoolPref(PRIVACY_PREF),
        true,
        "Privacy action keeps the blocker enabled"
      );
    } finally {
      clearUserPrefs(ACTION_PREFS);
      WaterfoxBrowserStyle.applyStockStyle();
      WaterfoxThemeColors.clear();
    }
  }
);
