/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("browser.tabs.toolbarposition");
  Services.prefs.clearUserPref("browser.tabs.duplicateTab");
  Services.prefs.clearUserPref("browser.tabs.autoGroupNewTabs");
});

add_task(async function test_tabs_group_renders() {
  let tab = await openPrefsTab("tabsBrowsing");
  let doc = tab.linkedBrowser.contentDocument;

  let group = await settingGroupRenders(doc, "waterfoxTabs");
  ok(group, "The Waterfox tabs group renders on the tabs pane");

  let select = doc
    .getElementById("setting-control-waterfox-tab-bar-position")
    ?.querySelector("moz-select");
  ok(select, "The tab bar position select renders");
  is(select.value, "topabove", "The tab bar sits at the top by default");

  let prefChanged = TestUtils.waitForPrefChange("browser.tabs.toolbarposition");
  select.value = "bottombelow";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await prefChanged;
  is(
    Services.prefs.getStringPref("browser.tabs.toolbarposition"),
    "bottombelow",
    "Choosing a bottom position writes the pref"
  );

  await SpecialPowers.pushPrefEnv({ set: [["sidebar.verticalTabs", true]] });
  await TestUtils.waitForCondition(
    () => select.disabled,
    "The position select disables while vertical tabs are on"
  );
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(
    () => !select.disabled,
    "The position select enables again with horizontal tabs"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_menu_toggle_writes_pref() {
  let tab = await openPrefsTab("tabsBrowsing");
  let doc = tab.linkedBrowser.contentDocument;

  await settingGroupRenders(doc, "waterfoxTabs");
  let toggle = doc
    .getElementById("setting-control-waterfox-tabs-duplicate-menu")
    ?.querySelector("moz-toggle");
  ok(toggle, "The duplicate tab toggle renders");
  ok(toggle.pressed, "The duplicate tab entry shows by default");

  let prefChanged = TestUtils.waitForPrefChange("browser.tabs.duplicateTab");
  synthesizeClick(toggle);
  await prefChanged;
  is(
    Services.prefs.getBoolPref("browser.tabs.duplicateTab"),
    false,
    "Turning the toggle off writes the pref"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_grouping_placement_follows_master() {
  let tab = await openPrefsTab("tabsBrowsing");
  let doc = tab.linkedBrowser.contentDocument;

  await settingGroupRenders(doc, "waterfoxTabs");
  let placement = doc
    .getElementById("setting-control-waterfox-auto-group-placement")
    ?.querySelector("moz-select");
  ok(placement, "The placement select renders");
  ok(placement.disabled, "The placement select disables while grouping is off");

  let prefChanged = TestUtils.waitForPrefChange(
    "browser.tabs.autoGroupNewTabs"
  );
  let toggle = doc
    .getElementById("setting-control-waterfox-auto-group-tabs")
    ?.querySelector("moz-toggle");
  synthesizeClick(toggle);
  await prefChanged;

  await TestUtils.waitForCondition(
    () => !placement.disabled,
    "The placement select enables once grouping is on"
  );

  BrowserTestUtils.removeTab(tab);
});
