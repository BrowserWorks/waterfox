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

async function forceMajorUpgrade() {
  const versionPref = "browser.startup.upgradeDialog.version";
  const originalMajorUpgrade = BrowserHandler.majorUpgrade;
  const hadVersion = Services.prefs.prefHasUserValue(versionPref);
  const originalVersion = Services.prefs.getIntPref(versionPref, 0);

  await SpecialPowers.pushPrefEnv({
    set: [["browser.startup.homepage_override.mstone", "88.0"]],
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
      ["browser.theme.enableWaterfoxCustomizations", 1],
      ["browser.nova.enabled", true],
    ],
  });

  try {
    const message = await WaterfoxUpgradeMessage.getUpgradeMessage();
    const { content } = message;

    Assert.equal(message.template, "spotlight", "Uses the Spotlight template");
    Assert.equal(content.template, "multistage", "Uses multistage content");
    Assert.equal(content.modal, "tab", "Uses a tab modal");
    Assert.deepEqual(
      content.screens.map(screen => screen.id),
      ["WATERFOX_153_UPGRADE_WELCOME", "WATERFOX_153_UPGRADE_APPEARANCE"],
      "Keeps the compact two-screen upgrade flow"
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
    Assert.deepEqual(
      data.screens.map(screen => screen.id),
      ["WATERFOX_153_UPGRADE_WELCOME", "WATERFOX_153_UPGRADE_APPEARANCE"],
      "The rendered upgrade dialog stays compact"
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
