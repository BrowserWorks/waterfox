/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const MODE_PREF = "browser.theme.enableWaterfoxCustomizations";

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(MODE_PREF);
  Services.prefs.clearUserPref("userChrome.autohide.tabbar");
});

add_task(async function test_appearance_group_renders() {
  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;

  let group = await settingGroupRenders(doc, "waterfoxAppearance");
  ok(group, "The Waterfox styling group renders on the appearance pane");

  let select = doc
    .getElementById("setting-control-waterfox-lepton-mode")
    ?.querySelector("moz-select");
  ok(select, "The Lepton mode select renders");
  is(
    select.value,
    "default-themes",
    "Lepton applies to stock themes by default"
  );

  let prefChanged = TestUtils.waitForPrefChange(MODE_PREF);
  select.value = "off";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await prefChanged;
  is(Services.prefs.getIntPref(MODE_PREF), 2, "Turning Lepton off writes 2");

  let toggleControl = doc.getElementById(
    "setting-control-waterfox-appearance-autohide-tabbar"
  );
  let toggle = toggleControl?.querySelector("moz-toggle");
  ok(toggle, "The autohide tab bar toggle renders");
  await TestUtils.waitForCondition(
    () => toggle.disabled,
    "The Lepton toggles disable while Lepton is off"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_preset_select_writes_block() {
  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;

  await settingGroupRenders(doc, "waterfoxAppearance");
  let select = doc
    .getElementById("setting-control-waterfox-lepton-preset")
    ?.querySelector("moz-select");
  ok(select, "The preset select renders");
  is(select.value, "lepton", "The shipped defaults read as the Lepton preset");

  let prefChanged = TestUtils.waitForPrefChange(
    "userChrome.tab.photon_like_padding"
  );
  select.value = "photon";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await prefChanged;

  is(
    Services.prefs.getBoolPref("userChrome.tab.photon_like_padding"),
    true,
    "The Photon preset writes its block"
  );
  is(
    Services.prefs.getBoolPref("userChrome.tab.lepton_like_padding"),
    false,
    "The colliding Lepton padding pref turns off"
  );

  for (let pref of [
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
  ]) {
    Services.prefs.clearUserPref(pref);
  }

  BrowserTestUtils.removeTab(tab);
});
