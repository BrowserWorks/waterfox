/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { AboutWelcomeDefaults } = ChromeUtils.importESModule(
  "resource:///modules/aboutwelcome/AboutWelcomeDefaults.sys.mjs"
);
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
const STYLE_PREF = "browser.theme.enableWaterfoxCustomizations";
const TREE_TABS_PREF = "browser.tabs.verticalTabs.tree.enabled";
const VERTICAL_TABS_PREF = "sidebar.verticalTabs";
const TABBAR_POSITION_PREF = "browser.tabs.toolbarposition";
const UIDENSITY_PREF = "browser.uidensity";
const PRIVACY_PREF = "waterfox.blocker.enabled";
const SUPERNOVA_PREF = "userChrome.tab.supernova_like_contextline";

const STYLE_PRESET_PREFS = [
  "userChrome.tab.connect_to_window",
  "userChrome.tab.color_like_toolbar",
  "userChrome.tab.lepton_like_padding",
  "userChrome.tab.photon_like_padding",
  "userChrome.tab.dynamic_separator",
  "userChrome.tab.static_separator",
  "userChrome.tab.static_separator.selected_accent",
  "userChrome.tab.bar_separator",
  "userChrome.tab.newtab_button_like_tab",
  "userChrome.tab.newtab_button_smaller",
  "userChrome.tab.newtab_button_proton",
  "userChrome.icon.panel_full",
  "userChrome.icon.panel_photon",
  "userChrome.tab.box_shadow",
  "userChrome.tab.bottom_rounded_corner",
  "userChrome.tab.photon_like_contextline",
  "userChrome.rounding.square_tab",
];

const ACTION_PREFS = [
  NOVA_PREF,
  STYLE_PREF,
  TREE_TABS_PREF,
  VERTICAL_TABS_PREF,
  TABBAR_POSITION_PREF,
  UIDENSITY_PREF,
  PRIVACY_PREF,
  SUPERNOVA_PREF,
  WATERFOX_THEME_MODE_PREF,
  WATERFOX_THEME_COLOR_PREF,
  ...STYLE_PRESET_PREFS,
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

function getWaterfoxDefaults() {
  const defaults = AboutWelcomeDefaults.getDefaults();
  Assert.equal(defaults.id, "WATERFOX_ONBOARDING", "Uses Waterfox defaults");
  return defaults;
}

function getScreen(defaults, id) {
  const screen = defaults.screens.find(candidate => candidate.id === id);
  Assert.ok(screen, `Found ${id}`);
  return screen;
}

function assertSettingsAction(action, args) {
  Assert.equal(action.type, "MULTI_ACTION", "Uses a multi action");
  Assert.equal(action.navigate, true, "Continues the onboarding flow");
  Assert.equal(action.data.orderedExecution, true, "Runs actions in order");
  Assert.equal(action.data.actions.length, 1, "Opens one Settings tab");

  const [openSettings] = action.data.actions;
  Assert.equal(openSettings.type, "OPEN_ABOUT_PAGE", "Opens an about page");
  Assert.equal(
    openSettings.data.args,
    args,
    "Opens the expected Settings pane"
  );
  Assert.equal(
    openSettings.data.where,
    "tabshifted",
    "Opens Settings in a background tab"
  );
}

function assertWaterfoxAction(action, expectedAction, expectedValue) {
  Assert.equal(action.type, "WATERFOX_ONBOARDING", "Uses the Waterfox action");
  Assert.equal(action.data.action, expectedAction, "Uses the expected action");
  if (arguments.length === 3) {
    Assert.equal(action.data.value, expectedValue, "Passes the expected value");
  }
}

function clearUserPrefs(prefNames) {
  for (const prefName of prefNames) {
    if (Services.prefs.prefHasUserValue(prefName)) {
      Services.prefs.clearUserPref(prefName);
    }
  }
}

async function openMRAboutWelcome() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.aboutwelcome.enabled", true]],
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:welcome",
    true
  );
  await SpecialPowers.spawn(gBrowser.selectedBrowser, [], async function () {
    content.document.notifyUserGestureActivation();
  });

  return {
    browser: tab.linkedBrowser,
    cleanup: async () => {
      BrowserTestUtils.removeTab(tab);
      await SpecialPowers.popPrefEnv();
    },
  };
}

async function test_screen_content(
  browser,
  experiment,
  expectedSelectors = [],
  unexpectedSelectors = []
) {
  await SpecialPowers.spawn(
    browser,
    [{ expectedSelectors, experiment, unexpectedSelectors }],
    async ({
      expectedSelectors: expected,
      experiment: experimentName,
      unexpectedSelectors: unexpected,
    }) => {
      for (const selector of expected) {
        await ContentTaskUtils.waitForCondition(
          () => content.document.querySelector(selector),
          `Should render ${selector} in ${experimentName}`
        );
      }
      for (const selector of unexpected) {
        ok(
          !content.document.querySelector(selector),
          `Should not render ${selector} in ${experimentName}`
        );
      }

      Assert.equal(
        content.document.location.href,
        "about:welcome",
        "Navigated to a welcome screen"
      );
    }
  );
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
  WaterfoxThemeColors.clear();
});

add_task(async function test_waterfox_defaults_shape() {
  const defaults = getWaterfoxDefaults();

  Assert.equal(defaults.template, "multistage", "Uses multistage onboarding");
  Assert.deepEqual(
    defaults.screens.map(screen => screen.id),
    WATERFOX_SCREEN_IDS,
    "Uses the Waterfox screen order"
  );

  for (const screen of defaults.screens) {
    Assert.equal(
      screen.content.position,
      "split",
      `${screen.id} uses the split layout`
    );
    Assert.equal(screen.content.fullscreen, true, `${screen.id} is fullscreen`);
    Assert.equal(
      screen.content.progress_bar,
      true,
      `${screen.id} shows progress`
    );
    Assert.ok(screen.content.background, `${screen.id} has a split background`);
  }

  const importScreen = getScreen(defaults, "AW_WATERFOX_IMPORT");
  Assert.equal(
    importScreen.content.tiles.type,
    "migration-wizard",
    "Import screen embeds the migration wizard"
  );
  Assert.equal(
    importScreen.content.tiles.migration_wizard_options.migrator_key,
    "firefox-import",
    "Import screen defaults to the Firefox import migrator"
  );
  Assert.equal(
    importScreen.content.tiles.migration_wizard_options.force_show_import_all,
    true,
    "Import screen keeps the import all option available"
  );
  Assert.equal(
    importScreen.content.tiles.migration_wizard_options.selection_header_string,
    "",
    "Import screen uses the about:welcome title instead of a second wizard title"
  );
  Assert.ok(
    !importScreen.content.primary_button,
    "Import screen uses the embedded wizard controls"
  );

  const styleScreen = getScreen(defaults, "AW_WATERFOX_STYLE");
  const [styleTiles, densityTiles] = styleScreen.content.tiles;
  Assert.equal(styleTiles.type, "single-select", "Style screen has a picker");
  Assert.equal(
    styleTiles.selected,
    "waterfox-style-nova",
    "Preselects the Nova style"
  );
  Assert.deepEqual(
    styleTiles.data.map(tile => tile.id),
    ["waterfox-style-photon", "waterfox-style-proton", "waterfox-style-nova"],
    "Offers Photon, Proton, and Nova styles"
  );
  for (const tile of styleTiles.data) {
    assertWaterfoxAction(
      tile.action,
      "style",
      tile.id.replace("waterfox-style-", "")
    );
  }
  Assert.equal(
    densityTiles.class_name,
    "waterfox-density",
    "Density picker has its styling hook"
  );
  Assert.equal(
    densityTiles.selected,
    "waterfox-density-compact",
    "Preselects the compact density"
  );
  Assert.deepEqual(
    densityTiles.data.map(tile => tile.id),
    [
      "waterfox-density-normal",
      "waterfox-density-compact",
      "waterfox-density-touch",
    ],
    "Offers normal, compact, and touch density"
  );
  for (const tile of densityTiles.data) {
    assertWaterfoxAction(
      tile.action,
      "density",
      tile.id.replace("waterfox-density-", "")
    );
  }
  Assert.equal(
    styleScreen.content.primary_button.action.navigate,
    true,
    "Style primary button continues"
  );
  assertSettingsAction(
    styleScreen.content.secondary_button.action,
    "preferences#appearance"
  );

  const colorScreen = getScreen(defaults, "AW_WATERFOX_THEME_COLOR");
  const [themeModeTiles, colorTiles] = colorScreen.content.tiles;
  Assert.ok(!colorScreen.content.logo, "Theme color screen has no inline logo");
  Assert.equal(
    colorScreen.content.title.string_id,
    "waterfox-onboarding-theme-color-title",
    "Theme color screen uses the Waterfox color title"
  );
  Assert.equal(
    themeModeTiles.class_name,
    "waterfox-theme-mode",
    "Theme mode picker has compact styling hook"
  );
  Assert.deepEqual(
    themeModeTiles.data.map(tile => tile.id),
    [
      "waterfox-theme-mode-system",
      "waterfox-theme-mode-light",
      "waterfox-theme-mode-dark",
    ],
    "Offers system, light, and dark mode"
  );
  Assert.deepEqual(
    themeModeTiles.data.map(tile => tile.label.string_id),
    [
      "waterfox-onboarding-theme-mode-system-label",
      "waterfox-onboarding-theme-mode-light-label",
      "waterfox-onboarding-theme-mode-dark-label",
    ],
    "Uses compact Waterfox theme mode labels"
  );
  for (const tile of themeModeTiles.data) {
    assertWaterfoxAction(
      tile.action,
      "theme-mode",
      tile.id.replace("waterfox-theme-mode-", "")
    );
  }
  Assert.equal(
    colorTiles.class_name,
    "waterfox-color-grid",
    "Theme color picker has swatch grid styling hook"
  );
  Assert.equal(
    colorTiles.selected,
    "waterfox-color-default",
    "Default is selected by default"
  );
  Assert.deepEqual(
    colorTiles.data.map(tile => tile.id.replace("waterfox-color-", "")),
    WATERFOX_COLOR_IDS,
    "Offers the expected Waterfox colors"
  );
  for (const tile of colorTiles.data) {
    const color = tile.id.replace("waterfox-color-", "");
    assertWaterfoxAction(tile.action, "theme-color", color);
  }
  Assert.equal(
    colorScreen.content.primary_button.action.navigate,
    true,
    "Theme color primary button continues"
  );
  Assert.equal(
    colorScreen.content.secondary_button.label.string_id,
    "waterfox-onboarding-skip-step-button",
    "Theme color skip button uses the requested label"
  );
  Assert.equal(
    colorScreen.content.secondary_button.has_arrow_icon,
    true,
    "Theme color skip button shows the arrow affordance"
  );
  Assert.equal(
    colorScreen.content.secondary_button.action.navigate,
    true,
    "Theme color skip button continues"
  );

  const tabsScreen = getScreen(defaults, "AW_WATERFOX_TABS");
  const [layoutTiles, locationTiles] = tabsScreen.content.tiles;
  Assert.equal(
    layoutTiles.type,
    "single-select",
    "Layout picker is a single select"
  );
  Assert.equal(
    layoutTiles.selected,
    "waterfox-layout-horizontal",
    "Keeps horizontal tabs selected by default"
  );
  Assert.equal(
    layoutTiles.action.picker,
    "<event>",
    "Layout tiles run their own action"
  );
  Assert.deepEqual(
    layoutTiles.data.map(tile => tile.id),
    [
      "waterfox-layout-horizontal",
      "waterfox-layout-vertical",
      "waterfox-layout-tree",
    ],
    "Offers horizontal, vertical, and tree layouts"
  );
  for (const tile of layoutTiles.data) {
    assertWaterfoxAction(
      tile.action,
      "layout",
      tile.id.replace("waterfox-layout-", "")
    );
  }
  Assert.equal(
    locationTiles.class_name,
    "waterfox-tab-location",
    "Tab location picker has its styling hook"
  );
  Assert.equal(
    locationTiles.selected,
    "waterfox-location-topabove",
    "Defaults to the top above position"
  );
  Assert.deepEqual(
    locationTiles.data.map(tile => tile.id),
    [
      "waterfox-location-topabove",
      "waterfox-location-topbelow",
      "waterfox-location-bottomabove",
      "waterfox-location-bottombelow",
    ],
    "Offers the four supported tab strip positions"
  );
  for (const tile of locationTiles.data) {
    assertWaterfoxAction(
      tile.action,
      "tab-location",
      tile.id.replace("waterfox-location-", "")
    );
  }
  assertSettingsAction(
    tabsScreen.content.secondary_button.action,
    "preferences#tabsBrowsing"
  );

  const privacyScreen = getScreen(defaults, "AW_WATERFOX_PRIVACY");
  assertWaterfoxAction(
    privacyScreen.content.primary_button.action,
    "privacy-defaults",
    true
  );
  Assert.equal(
    privacyScreen.content.primary_button.action.navigate,
    true,
    "Privacy primary button continues"
  );
  assertSettingsAction(
    privacyScreen.content.secondary_button.action,
    "preferences#adBlocking"
  );

  const defaultScreen = getScreen(defaults, "AW_WATERFOX_DEFAULT_BROWSER");
  Assert.equal(
    defaultScreen.targeting,
    "needDefault",
    "Default screen is targeted"
  );
  Assert.equal(
    defaultScreen.content.primary_button.action.type,
    "SET_DEFAULT_BROWSER",
    "Default screen can set the default browser"
  );

  const finishAction = getScreen(defaults, "AW_WATERFOX_FINISH").content
    .primary_button.action;
  Assert.equal(finishAction.type, "OPEN_ABOUT_PAGE", "Finish opens a page");
  Assert.equal(finishAction.data.args, "home", "Finish opens about:home");
  Assert.equal(finishAction.data.where, "current", "Finish reuses the tab");
  Assert.equal(finishAction.navigate, true, "Finish completes onboarding");
});

add_task(
  async function test_waterfox_onboarding_actions_write_expected_prefs() {
    clearUserPrefs(ACTION_PREFS);
    WaterfoxThemeColors.clear();

    try {
      Services.prefs.setBoolPref(NOVA_PREF, false);
      Services.prefs.setIntPref(STYLE_PREF, 1);

      await runWaterfoxAction("style", "nova");
      Assert.equal(
        Services.prefs.getBoolPref(NOVA_PREF),
        true,
        "Nova turns on"
      );
      Assert.equal(
        Services.prefs.getIntPref(STYLE_PREF),
        1,
        "Nova keeps Lepton chrome styling enabled"
      );
      Assert.equal(
        Services.prefs.getBoolPref("userChrome.tab.lepton_like_padding"),
        false,
        "Nova keeps the stock tab style"
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
        Services.prefs.getIntPref(STYLE_PREF),
        1,
        "Photon enables Waterfox styling for stock themes"
      );
      Assert.equal(
        Services.prefs.getBoolPref("userChrome.tab.photon_like_contextline"),
        true,
        "Photon writes the Photon style block"
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
        Services.prefs.getIntPref(STYLE_PREF),
        1,
        "Proton keeps Lepton chrome styling enabled"
      );
      Assert.equal(
        Services.prefs.getBoolPref("userChrome.tab.lepton_like_padding"),
        false,
        "Proton keeps the stock tab style"
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
      WaterfoxThemeColors.clear();
    }
  }
);

add_task(async function test_waterfox_defaults_render_first_screen() {
  const { browser, cleanup } = await openMRAboutWelcome();

  try {
    await test_screen_content(
      browser,
      "Waterfox onboarding first screen",
      [
        "main.AW_WATERFOX_WELCOME[pos='split']",
        "div.onboardingContainer",
        "div.section-secondary",
        "div.steps",
        "button.primary",
      ],
      ["main.AW_WATERFOX_IMPORT"]
    );
  } finally {
    await cleanup();
  }
});
