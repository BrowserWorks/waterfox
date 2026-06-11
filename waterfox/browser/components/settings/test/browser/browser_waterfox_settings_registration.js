/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ENABLED_PREF = "waterfox.blocker.enabled";
const DISABLED_LIST_OVERRIDES = JSON.stringify({
  "core-easylist": false,
  "core-easyprivacy": false,
  "core-ublock-filters": false,
  "core-ublock-unbreak": false,
  "core-ublock-quick-fixes": false,
  "privacy-ublock-privacy": false,
  "privacy-ublock-badware": false,
  "privacy-ublock-resource-abuse": false,
  "privacy-adguard-tracking": false,
  "peter-lowe-adservers": false,
  "annoyances-easylist-cookie": false,
  "annoyances-ublock-cookies": false,
  "regional-arabic": false,
  "regional-bulgarian": false,
  "regional-chinese": false,
  "regional-czech-slovak": false,
  "regional-dutch": false,
  "regional-estonian": false,
  "regional-finnish": false,
  "regional-french": false,
  "regional-german": false,
  "regional-greek": false,
  "regional-hebrew": false,
  "regional-hindi": false,
  "regional-hungarian": false,
  "regional-icelandic": false,
  "regional-indonesian": false,
  "regional-italian": false,
  "regional-japanese": false,
  "regional-korean": false,
  "regional-latvian": false,
  "regional-lithuanian": false,
  "regional-macedonian": false,
  "regional-nordic": false,
  "regional-persian": false,
  "regional-polish": false,
  "regional-romanian": false,
  "regional-russian-adguard": false,
  "regional-russian-ruadlist": false,
  "regional-slovenian": false,
  "regional-spanish": false,
  "regional-spanish-portuguese": false,
  "regional-swedish": false,
  "regional-thai": false,
  "regional-turkish": false,
  "regional-vietnamese": false,
  "optional-fanboy-annoyances": false,
  "optional-fanboy-social": false,
  "optional-fanboy-newsletter": false,
  "optional-fanboy-chat-apps": false,
  "optional-fanboy-mobile-notifications": false,
});

add_task(async function test_ad_blocking_pane_registers() {
  let tab = await openPrefsTab("adBlocking");
  let doc = tab.linkedBrowser.contentDocument;

  let navButton = doc.getElementById("category-ad-blocking");
  ok(navButton, "The Ad Blocking nav button exists");
  ok(!navButton.hidden, "The Ad Blocking nav button is visible");

  await settingGroupRenders(doc, "waterfoxBlocker");
  for (let groupId of [
    "waterfoxBlocker",
    "waterfoxBlockerLists",
    "waterfoxBlockerExceptions",
  ]) {
    ok(
      doc.querySelector(`setting-group[groupid="${groupId}"]`),
      `The ${groupId} setting group renders`
    );
  }

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_master_toggle_writes_pref() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["waterfox.blocker.enabledLists", DISABLED_LIST_OVERRIDES],
      ["waterfox.blocker.filterListUrls", "[]"],
      ["waterfox.blocker.remoteResourcesEnabled", false],
      [ENABLED_PREF, true],
    ],
  });

  let tab = await openPrefsTab("adBlocking");
  let doc = tab.linkedBrowser.contentDocument;
  await settingGroupRenders(doc, "waterfoxBlocker");

  let control = doc.getElementById("setting-control-waterfox-blocker-enabled");
  ok(control, "The master toggle control renders");
  let toggle = control.querySelector("moz-toggle");
  await TestUtils.waitForCondition(
    () => toggle.pressed,
    "The toggle reflects the enabled pref"
  );

  let prefChanged = TestUtils.waitForPrefChange(ENABLED_PREF);
  synthesizeClick(toggle);
  await prefChanged;
  is(
    Services.prefs.getBoolPref(ENABLED_PREF),
    false,
    "Turning the toggle off writes the pref"
  );

  Services.prefs.setBoolPref(ENABLED_PREF, true);
  await TestUtils.waitForCondition(
    () => toggle.pressed,
    "The toggle follows the pref back on"
  );

  Services.prefs.setBoolPref(ENABLED_PREF, false);
  await TestUtils.waitForCondition(
    () => !toggle.pressed,
    "The toggle follows the cleanup pref change"
  );

  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pane_hidden_without_blocker_ui() {
  await SpecialPowers.pushPrefEnv({
    set: [["waterfox.blocker.ui.enabled", false]],
  });

  let tab = await openPrefsTab("");
  let doc = tab.linkedBrowser.contentDocument;
  ok(
    !doc.getElementById("category-ad-blocking"),
    "The Ad Blocking nav button is removed when the blocker UI is disabled"
  );

  await SpecialPowers.popPrefEnv();
  BrowserTestUtils.removeTab(tab);
});
