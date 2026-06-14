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
  await SpecialPowers.pushPrefEnv({
    set: [["browser.startup.homepage_override.mstone", "88.0"]],
  });

  void BrowserHandler.getFirstWindowArgs();

  return async () => {
    await SpecialPowers.popPrefEnv();
    BrowserHandler.majorUpgrade = false;
    Services.prefs.clearUserPref("browser.startup.upgradeDialog.version");
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

add_task(async function show_major_upgrade() {
  const cleanupPref = setDefaultBoolPref(
    "browser.startup.upgradeDialog.enabled",
    true
  );
  const cleanupUpgrade = await forceMajorUpgrade();

  try {
    const dialogLoaded = TestUtils.topicObserved("subdialog-loaded");
    await BROWSER_GLUE._maybeShowDefaultBrowserPrompt();
    const [win] = await dialogLoaded;
    const data = await WaterfoxUpgradeMessage.getUpgradeMessage();
    Assert.equal(
      data.id,
      "WATERFOX_153_UPGRADE",
      "Waterfox 153 upgrade dialog shown"
    );
    Assert.equal(
      Services.prefs.getIntPref("browser.startup.upgradeDialog.version"),
      WaterfoxUpgradeMessage.dialogVersion,
      "Waterfox upgrade dialog version was recorded"
    );
    win.close();

    assertUpgradeDialogReason(
      "Upgrade dialog opened from major upgrade",
      "satisfied"
    );

    await BrowserTestUtils.removeTab(gBrowser.selectedTab);

    await BROWSER_GLUE._maybeShowDefaultBrowserPrompt();

    assertUpgradeDialogReason(
      "Shouldn't reshow for upgrade dialog requirements",
      "already-shown"
    );
  } finally {
    cleanupPref();
    await cleanupUpgrade();
  }
});
