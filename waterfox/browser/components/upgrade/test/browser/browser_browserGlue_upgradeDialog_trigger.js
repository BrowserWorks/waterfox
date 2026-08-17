/* Any copyright is dedicated to the Public Domain.
http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WaterfoxUpgradeMessage } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxUpgradeMessage.sys.mjs"
);

const BROWSER_GLUE =
  Cc["@mozilla.org/browser/browserglue;1"].getService().wrappedJSObject;

XPCOMUtils.defineLazyServiceGetters(this, {
  BrowserHandler: ["@mozilla.org/browser/clh;1", Ci.nsIBrowserHandler],
});

add_setup(() => {
  Services.fog.testResetFOG();
});

function assertUpgradeDialogReason(message, expectedReason) {
  info(`Checking Glean event: ${message}`);
  const events = Glean.upgradeDialog.triggerReason.testGetValue() ?? [];
  Assert.greater(events.length, 0, "Recorded an upgrade dialog trigger event");

  const event = events[events.length - 1];
  Assert.equal(
    event.name,
    "trigger_reason",
    "Recorded the upgrade dialog trigger reason event"
  );
  Assert.equal(event.extra.value, expectedReason, message);
  Services.fog.testResetFOG();
}

function setDefaultBoolPref(pref, value) {
  const defaultPrefs = Services.prefs.getDefaultBranch("");
  const originalValue = defaultPrefs.getBoolPref(pref, true);
  defaultPrefs.setBoolPref(pref, value);

  return () => defaultPrefs.setBoolPref(pref, originalValue);
}

async function forceMajorUpgrade(mstone = "88.0") {
  const versionPref = "browser.startup.upgradeDialog.version";
  const originalMajorUpgrade = BrowserHandler.majorUpgrade;
  const hadVersion = Services.prefs.prefHasUserValue(versionPref);
  const originalVersion = Services.prefs.getIntPref(versionPref, 0);

  await SpecialPowers.pushPrefEnv({
    set: [["browser.startup.homepage_override.mstone", mstone]],
  });

  void BrowserHandler.getFirstWindowArgs();

  return async () => {
    await SpecialPowers.popPrefEnv();
    BrowserHandler.majorUpgrade = originalMajorUpgrade;
    if (hadVersion) {
      Services.prefs.setIntPref(versionPref, originalVersion);
    } else {
      Services.prefs.clearUserPref(versionPref);
    }
  };
}

add_task(async function not_major_upgrade() {
  await BROWSER_GLUE._maybeShowDefaultBrowserPrompt();

  assertUpgradeDialogReason(
    "Not major upgrade for upgrade dialog requirements",
    "not-major"
  );
});

add_task(async function local_disabled() {
  const cleanupPref = setDefaultBoolPref(
    "browser.startup.upgradeDialog.enabled",
    false
  );
  const cleanupUpgrade = await forceMajorUpgrade();

  try {
    await BROWSER_GLUE._maybeShowDefaultBrowserPrompt();

    assertUpgradeDialogReason(
      "Feature disabled for upgrade dialog requirements",
      "disabled"
    );
  } finally {
    cleanupPref();
    await cleanupUpgrade();
  }
});

add_task(async function enterprise_disabled() {
  const cleanupPref = setDefaultBoolPref("browser.aboutwelcome.enabled", false);
  const cleanupUpgrade = await forceMajorUpgrade();

  try {
    await BROWSER_GLUE._maybeShowDefaultBrowserPrompt();

    assertUpgradeDialogReason(
      "Welcome disabled like enterprise policy",
      "no-welcome"
    );
  } finally {
    await cleanupUpgrade();
    cleanupPref();
  }
});

add_task(async function upgrade_message_is_compact_and_uses_current_style() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.theme.waterfox.browserStyle", "photon"],
      ["browser.nova.enabled", false],
    ],
  });

  try {
    const message = await WaterfoxUpgradeMessage.getUpgradeMessage();
    const { content } = message;

    Assert.equal(message.template, "spotlight", "Uses the Spotlight template");
    Assert.equal(content.template, "multistage", "Uses multistage content");
    Assert.equal(content.modal, "tab", "Uses a tab modal");
    const screenIds = content.screens.map(screen => screen.id);
    Assert.deepEqual(
      screenIds.slice(0, 3),
      [
        "WATERFOX_153_UPGRADE_WELCOME",
        "WATERFOX_153_UPGRADE_APPEARANCE",
        "WATERFOX_153_UPGRADE_TABS",
      ],
      "Starts with the welcome, appearance, and tabs screens"
    );
    Assert.equal(
      screenIds.at(-1),
      "WATERFOX_153_UPGRADE_PRIVACY",
      "Ends with the privacy summary"
    );
    Assert.ok(
      !screenIds.includes("WATERFOX_153_UPGRADE_BLOCKER"),
      "No blocker screen without an ad blocking extension installed"
    );
    Assert.equal(
      new Set(screenIds).size,
      screenIds.length,
      "Screen ids are unique"
    );

    const tabsScreen = content.screens[2].content;
    Assert.equal(
      tabsScreen.tiles.type,
      "single-select",
      "Tabs screen renders a single select picker"
    );
    Assert.equal(
      tabsScreen.tiles.class_name,
      "waterfox-tab-layout",
      "Tabs screen uses the tab layout picker"
    );
    Assert.equal(
      tabsScreen.tiles.selected,
      "waterfox-layout-horizontal",
      "Tab layout picker preselects the current arrangement"
    );
    Assert.deepEqual(
      tabsScreen.tiles.data.map(tile => tile.id),
      [
        "waterfox-layout-horizontal",
        "waterfox-layout-vertical",
        "waterfox-layout-tree",
      ],
      "Offers horizontal, vertical, and tree tabs in order"
    );
    Assert.equal(
      content.screens[0].content.title.args.version,
      AppConstants.MOZ_APP_VERSION_DISPLAY.match(/^\d+\.\d+/)?.[0] ??
        AppConstants.MOZ_APP_VERSION_DISPLAY,
      "Uses the configured Waterfox release series in the title"
    );

    for (const screen of content.screens) {
      Assert.equal(screen.content.position, "center", "Centers the modal");
      Assert.equal(
        screen.content.transition_content,
        true,
        "Transitions all modal content together"
      );
      Assert.equal(
        screen.content.screen_style.width,
        "560px",
        "Keeps the compact modal width"
      );
      Assert.ok(
        !screen.content.fullscreen,
        "Does not use fullscreen onboarding"
      );
    }

    const appearance = content.screens[1].content;
    Assert.equal(
      appearance.tiles.type,
      "single-select",
      "Renders the appearance picker as a single select"
    );
    Assert.equal(
      appearance.tiles.class_name,
      "waterfox-style",
      "Uses the Waterfox style picker layout"
    );
    Assert.equal(
      appearance.tiles.selected,
      "waterfox-style-photon",
      "Preserves the current effective style"
    );
    Assert.deepEqual(
      appearance.tiles.data.map(tile => tile.id),
      ["waterfox-style-nova", "waterfox-style-proton", "waterfox-style-photon"],
      "Offers Nova, Proton, and Photon in the expected order"
    );
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function major_upgrade_from_140_mstone() {
  const cleanupPref = setDefaultBoolPref(
    "browser.startup.upgradeDialog.enabled",
    false
  );
  const cleanupUpgrade = await forceMajorUpgrade("140.0.2");

  try {
    Assert.ok(
      BrowserHandler.majorUpgrade,
      "Coming from a 140.x mstone counts as a major upgrade"
    );
    await BROWSER_GLUE._maybeShowDefaultBrowserPrompt();
    assertUpgradeDialogReason(
      "The 140 to 153 upgrade passes the major upgrade gate",
      "disabled"
    );
  } finally {
    cleanupPref();
    await cleanupUpgrade();
  }
});

add_task(async function show_major_upgrade() {
  const cleanupPref = setDefaultBoolPref(
    "browser.startup.upgradeDialog.enabled",
    true
  );
  const cleanupUpgrade = await forceMajorUpgrade();
  let win;
  let upgradeTab;

  try {
    const dialogLoaded = TestUtils.topicObserved("subdialog-loaded");
    await BROWSER_GLUE._maybeShowDefaultBrowserPrompt();
    [win] = await dialogLoaded;
    upgradeTab = gBrowser.selectedTab;

    const data = win.AWGetFeatureConfig();
    Assert.equal(
      data.id,
      "WATERFOX_153_UPGRADE",
      "Waterfox 153 upgrade dialog shown"
    );
    const renderedIds = data.screens.map(screen => screen.id);
    Assert.deepEqual(
      renderedIds.slice(0, 3),
      [
        "WATERFOX_153_UPGRADE_WELCOME",
        "WATERFOX_153_UPGRADE_APPEARANCE",
        "WATERFOX_153_UPGRADE_TABS",
      ],
      "The rendered dialog starts with welcome, appearance, and tabs"
    );
    Assert.equal(
      renderedIds.at(-1),
      "WATERFOX_153_UPGRADE_PRIVACY",
      "The rendered dialog ends with the privacy summary"
    );
    Assert.equal(data.modal, "tab", "Upgrade dialog uses a tab modal");
    Assert.ok(
      data.screens.every(
        screen =>
          screen.content.position === "center" &&
          screen.content.screen_style.width === "560px" &&
          !screen.content.fullscreen
      ),
      "The rendered screens use the compact centered layout"
    );

    Assert.equal(
      Services.prefs.getIntPref("browser.startup.upgradeDialog.version"),
      WaterfoxUpgradeMessage.dialogVersion,
      "Waterfox upgrade dialog version was recorded"
    );
    win.close();
    win = null;

    assertUpgradeDialogReason(
      "Upgrade dialog opened from major upgrade",
      "satisfied"
    );

    await BrowserTestUtils.removeTab(upgradeTab);
    upgradeTab = null;

    await BROWSER_GLUE._maybeShowDefaultBrowserPrompt();

    assertUpgradeDialogReason(
      "Shouldn't reshow for upgrade dialog requirements",
      "already-shown"
    );
  } finally {
    if (win) {
      win.close();
    }
    if (upgradeTab?.isConnected) {
      await BrowserTestUtils.removeTab(upgradeTab);
    }
    cleanupPref();
    await cleanupUpgrade();
  }
});
