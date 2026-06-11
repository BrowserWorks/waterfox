/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WaterfoxBrowserStyle } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBrowserStyle.sys.mjs"
);

const BROWSER_STYLE_PREF = "browser.theme.waterfox.browserStyle";
const CHROME_SHEET_PREF = "browser.theme.waterfox.chromeSheet";
const NOVA_PREF = "browser.nova.enabled";

const CUSTOMIZATION_GROUPS = [
  "waterfoxOptTabbar",
  "waterfoxOptTabs",
  "waterfoxOptToolbars",
  "waterfoxOptBookmarks",
  "waterfoxOptIcons",
  "waterfoxOptRounding",
  "waterfoxOptTheme",
  "waterfoxOptContent",
  "waterfoxOptNewtab",
  "waterfoxOptPlayer",
];

const TEST_PREFS = new Set([
  BROWSER_STYLE_PREF,
  CHROME_SHEET_PREF,
  NOVA_PREF,
  "userChrome.autohide.navbar",
  "userChrome.decoration.animate",
  "userChrome.hidden.navbar",
  "userChrome.icon.panel",
  "userChrome.padding.menu",
  "userChrome.tab.bar_separator",
  "userChrome.tab.bottom_rounded_corner",
  "userChrome.tab.bottom_rounded_corner.all",
  "userChrome.tab.bottom_rounded_corner.australis",
  "userChrome.tab.bottom_rounded_corner.chrome",
  "userChrome.tab.bottom_rounded_corner.chrome_legacy",
  "userChrome.tab.bottom_rounded_corner.edge",
  "userChrome.tab.bottom_rounded_corner.wave",
  "userChrome.tab.dynamic_separator",
  "userChrome.tab.photon_like_contextline",
  "userChrome.tab.static_separator",
  "userChrome.tab.supernova_like_contextline",
  ...Object.keys(WaterfoxBrowserStyle.PHOTON_PRESET),
]);

function resetTestPrefs() {
  WaterfoxBrowserStyle.applyStockStyle();
  for (let pref of TEST_PREFS) {
    if (Services.prefs.prefHasUserValue(pref)) {
      Services.prefs.clearUserPref(pref);
    }
  }
}

function getControl(doc, id, selector) {
  return doc.getElementById(`setting-control-${id}`)?.querySelector(selector);
}

async function optionGroupsRender(doc) {
  let groups = [];
  for (let groupId of CUSTOMIZATION_GROUPS) {
    groups.push(await settingGroupRenders(doc, groupId));
  }
  return groups;
}

function groupHidden(group) {
  return group.hasAttribute("data-hidden-by-setting-group");
}

async function waitForDisabled(control, disabled, message) {
  await TestUtils.waitForCondition(
    () => control?.disabled == disabled,
    message
  );
}

async function setBoolPref(pref, value) {
  let changed = TestUtils.waitForPrefChange(pref);
  Services.prefs.setBoolPref(pref, value);
  await changed;
}

async function setControlValue(control, value, changedPref) {
  let changed = TestUtils.waitForPrefChange(changedPref);
  control.value = value;
  control.dispatchEvent(new Event("change", { bubbles: true }));
  await changed;
}

registerCleanupFunction(resetTestPrefs);

add_task(async function test_browser_style_preserves_customization_state() {
  resetTestPrefs();
  Services.prefs.setIntPref(CHROME_SHEET_PREF, 0);
  Services.prefs.setBoolPref("userChrome.autohide.navbar", true);

  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;

  let group = await settingGroupRenders(doc, "waterfoxBrowserStyle");
  ok(group, "The browser style group renders on the appearance pane");

  let picker = getControl(doc, "waterfox-browser-style", "moz-visual-picker");
  ok(picker, "The browser style picker renders");

  let prefChanged = TestUtils.waitForPrefChange(BROWSER_STYLE_PREF);
  picker.value = "photon";
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await prefChanged;

  is(
    Services.prefs.getStringPref(BROWSER_STYLE_PREF),
    "photon",
    "Choosing Photon records the browser style"
  );
  for (let [pref, value] of Object.entries(
    WaterfoxBrowserStyle.PHOTON_PRESET
  )) {
    is(
      Services.prefs.getBoolPref(pref),
      value,
      `Photon writes ${pref} as part of its preset`
    );
  }
  is(
    Services.prefs.getIntPref(CHROME_SHEET_PREF),
    0,
    "Changing style preserves the sheet-loading mode"
  );
  ok(
    Services.prefs.getBoolPref("userChrome.autohide.navbar"),
    "Changing style preserves options outside the style preset"
  );

  prefChanged = TestUtils.waitForPrefChange(BROWSER_STYLE_PREF);
  picker.value = "nova";
  picker.dispatchEvent(new Event("change", { bubbles: true }));
  await prefChanged;

  ok(
    Object.keys(WaterfoxBrowserStyle.PHOTON_PRESET).every(
      pref => !Services.prefs.prefHasUserValue(pref)
    ),
    "Switching to Nova clears the preset back to the shipped defaults"
  );
  is(
    Services.prefs.getIntPref(CHROME_SHEET_PREF),
    0,
    "Returning to Nova still preserves the sheet-loading mode"
  );
  ok(
    Services.prefs.getBoolPref("userChrome.autohide.navbar"),
    "Returning to Nova keeps unrelated customizations"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_sheet_loading_toggle_hides_categories() {
  resetTestPrefs();
  // Use Photon so sheet loading is the only visibility condition.
  WaterfoxBrowserStyle.setStyle("photon");

  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;

  await settingGroupRenders(doc, "waterfoxInterfaceCustomizations");
  let groups = await optionGroupsRender(doc);

  let toggle = getControl(doc, "waterfox-chrome-sheet", "moz-toggle");
  ok(toggle, "The interface customisations toggle renders");
  ok(toggle.pressed, "Interface customisations load by default");

  ok(
    groups.every(group => !groupHidden(group)),
    "Every customization category renders as its own card"
  );

  let changed = TestUtils.waitForPrefChange(CHROME_SHEET_PREF);
  synthesizeClick(toggle);
  await changed;
  is(Services.prefs.getIntPref(CHROME_SHEET_PREF), 2, "Off maps to mode 2");
  await TestUtils.waitForCondition(
    () => groups.every(groupHidden),
    "Off takes every customization card off the pane"
  );

  changed = TestUtils.waitForPrefChange(CHROME_SHEET_PREF);
  synthesizeClick(toggle);
  await changed;
  is(Services.prefs.getIntPref(CHROME_SHEET_PREF), 0, "On maps to mode 0");
  await TestUtils.waitForCondition(
    () => groups.every(group => !groupHidden(group)),
    "Loading the sheet brings every customization card back"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_tab_styling_is_photon_only() {
  resetTestPrefs();

  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;
  await optionGroupsRender(doc);

  let tabs = doc.querySelector('setting-group[groupid="waterfoxOptTabs"]');
  let tabbar = doc.querySelector('setting-group[groupid="waterfoxOptTabbar"]');
  ok(tabs && tabbar, "The tab styling and tab bar cards both render");

  let picker = getControl(doc, "waterfox-browser-style", "moz-visual-picker");
  is(picker.value, "nova", "The shipped style is Nova");

  await TestUtils.waitForCondition(
    () => groupHidden(tabs),
    "Tab styling is off the pane on Nova"
  );
  ok(!groupHidden(tabbar), "The tab bar card is unaffected on Nova");

  await setControlValue(picker, "photon", BROWSER_STYLE_PREF);
  await TestUtils.waitForCondition(
    () => !groupHidden(tabs),
    "Choosing Photon brings the tab styling card back"
  );

  let controls = Array.from(tabs.querySelectorAll('[id^="setting-control-"]'));
  is(controls.length, 32, "Every tab styling option renders on Photon");
  ok(
    controls.every(control => !control.hidden),
    "No tab styling option stays hidden on Photon"
  );

  await setControlValue(picker, "proton", BROWSER_STYLE_PREF);
  await TestUtils.waitForCondition(
    () => groupHidden(tabs),
    "Proton takes the tab styling card away again"
  );
  ok(
    controls.every(control => control.hidden),
    "Every tab styling option hides on Proton"
  );
  ok(!groupHidden(tabbar), "The tab bar card is unaffected on Proton");

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_former_photon_options_are_universal() {
  resetTestPrefs();
  Services.prefs.setStringPref(BROWSER_STYLE_PREF, "nova");

  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;

  await optionGroupsRender(doc);

  let options = [
    ["waterfox-opt-autohide-navbar", "waterfoxOptToolbars"],
    ["waterfox-opt-icon-menu", "waterfoxOptIcons"],
    ["waterfox-opt-theme-built-in-contrast", "waterfoxOptTheme"],
    ["waterfox-opt-autohide-tab", "waterfoxOptTabbar"],
    ["waterfox-opt-icon-library", "waterfoxOptIcons"],
  ];

  for (let style of ["nova", "proton", "photon"]) {
    if (Services.prefs.getStringPref(BROWSER_STYLE_PREF) != style) {
      let changed = TestUtils.waitForPrefChange(BROWSER_STYLE_PREF);
      Services.prefs.setStringPref(BROWSER_STYLE_PREF, style);
      await changed;
    }

    for (let [id, groupId] of options) {
      let option = doc.getElementById(`setting-control-${id}`);
      let group = doc.querySelector(`setting-group[groupid="${groupId}"]`);
      ok(option && !option.hidden, `${id} is available with ${style}`);
      ok(group?.contains(option), `${id} is on the ${groupId} card`);
    }
  }

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_boolean_css_dependencies() {
  resetTestPrefs();
  for (let pref of [
    "userChrome.decoration.animate",
    "userChrome.hidden.navbar",
    "userChrome.icon.panel",
  ]) {
    Services.prefs.setBoolPref(pref, false);
  }

  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;
  await optionGroupsRender(doc);

  let autohideNavbar = getControl(
    doc,
    "waterfox-opt-autohide-navbar",
    "moz-toggle"
  );
  ok(autohideNavbar, "The auto-hide navigation toggle renders");
  await waitForDisabled(
    autohideNavbar,
    false,
    "Auto-hide navigation does not depend on hiding the navigation toolbar"
  );

  let cases = [
    [
      "userChrome.decoration.animate",
      ["waterfox-opt-decoration-disable-sidebar-animate", "moz-toggle"],
    ],
  ];

  for (let [parentPref, [childId, selector]] of cases) {
    let child = getControl(doc, childId, selector);
    ok(child, `${childId} renders`);
    await waitForDisabled(child, true, `${childId} starts disabled`);
    await setBoolPref(parentPref, true);
    await waitForDisabled(
      child,
      false,
      `${childId} enables when ${parentPref} is on`
    );
  }

  let panelChildren = [
    ["waterfox-opt-panel-icons", "moz-visual-picker"],
    ["waterfox-opt-icon-account-image-to-right", "moz-toggle"],
    ["waterfox-opt-icon-account-label-to-right", "moz-toggle"],
  ].map(([id, selector]) => [id, getControl(doc, id, selector)]);

  for (let [id, child] of panelChildren) {
    ok(child, `${id} renders`);
    await waitForDisabled(child, true, `${id} needs panel icons`);
  }

  await setBoolPref("userChrome.icon.panel", true);
  for (let [id, child] of panelChildren) {
    await waitForDisabled(child, false, `${id} enables with panel icons`);
  }

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_select_css_dependencies() {
  resetTestPrefs();
  for (let pref of [
    "userChrome.tab.bar_separator",
    "userChrome.tab.dynamic_separator",
    "userChrome.tab.photon_like_contextline",
    "userChrome.tab.static_separator",
    "userChrome.tab.supernova_like_contextline",
  ]) {
    Services.prefs.setBoolPref(pref, false);
  }

  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;
  await optionGroupsRender(doc);

  let contextline = getControl(
    doc,
    "waterfox-opt-tab-contextline",
    "moz-visual-picker"
  );
  let separator = getControl(
    doc,
    "waterfox-opt-tab-separator",
    "moz-visual-picker"
  );
  let contextlineBlue = getControl(
    doc,
    "waterfox-opt-tab-contextline-blue-accent",
    "moz-toggle"
  );
  let tabBlue = getControl(doc, "waterfox-opt-tab-blue-accent", "moz-toggle");
  ok(contextline && separator, "The dependency selects render");
  ok(contextlineBlue && tabBlue, "The dependent toggles render");

  await waitForDisabled(
    contextlineBlue,
    true,
    "Context-line blue accent starts unavailable"
  );
  await waitForDisabled(tabBlue, true, "Tab blue accent starts unavailable");

  await setControlValue(
    contextline,
    "supernova",
    "userChrome.tab.supernova_like_contextline"
  );
  await waitForDisabled(
    contextlineBlue,
    false,
    "Supernova enables its context-line blue accent"
  );
  await waitForDisabled(
    tabBlue,
    true,
    "Supernova does not enable the Photon tab accent"
  );

  await setControlValue(
    separator,
    "dynamic",
    "userChrome.tab.dynamic_separator"
  );

  await setControlValue(
    contextline,
    "photon",
    "userChrome.tab.photon_like_contextline"
  );
  await waitForDisabled(
    contextlineBlue,
    true,
    "Photon disables the Supernova-only accent"
  );
  await waitForDisabled(
    tabBlue,
    false,
    "Photon context lines enable the tab blue accent"
  );

  await setControlValue(
    contextline,
    "none",
    "userChrome.tab.photon_like_contextline"
  );
  await waitForDisabled(
    tabBlue,
    true,
    "The tab blue accent disables without a compatible indicator"
  );

  await setControlValue(separator, "static", "userChrome.tab.static_separator");
  await waitForDisabled(
    tabBlue,
    false,
    "Static separators enable the tab blue accent"
  );

  await setControlValue(separator, "bar", "userChrome.tab.bar_separator");
  await waitForDisabled(
    tabBlue,
    false,
    "Bar separators also enable the tab blue accent"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_bottom_corner_shape_and_scope_are_composable() {
  resetTestPrefs();
  for (let pref of [
    "userChrome.tab.bottom_rounded_corner",
    "userChrome.tab.bottom_rounded_corner.all",
    "userChrome.tab.bottom_rounded_corner.australis",
    "userChrome.tab.bottom_rounded_corner.chrome",
    "userChrome.tab.bottom_rounded_corner.chrome_legacy",
    "userChrome.tab.bottom_rounded_corner.edge",
    "userChrome.tab.bottom_rounded_corner.wave",
  ]) {
    Services.prefs.setBoolPref(pref, false);
  }

  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;
  await optionGroupsRender(doc);

  let allTabs = getControl(
    doc,
    "waterfox-opt-tab-bottom-rounded-corner-all",
    "moz-toggle"
  );
  let shape = getControl(
    doc,
    "waterfox-opt-tab-corner-style",
    "moz-visual-picker"
  );
  ok(allTabs && shape, "The corner scope and shape controls render separately");
  await waitForDisabled(allTabs, true, "Corner scope needs rounded corners");
  await waitForDisabled(shape, true, "Corner shape needs rounded corners");

  await setBoolPref("userChrome.tab.bottom_rounded_corner", true);
  await waitForDisabled(allTabs, false, "Rounded corners enable scope");
  await waitForDisabled(shape, false, "Rounded corners enable shape");

  await setBoolPref("userChrome.tab.bottom_rounded_corner.all", true);
  await setControlValue(
    shape,
    "chrome",
    "userChrome.tab.bottom_rounded_corner.chrome"
  );

  ok(
    Services.prefs.getBoolPref("userChrome.tab.bottom_rounded_corner.all"),
    "Choosing a shape preserves the all-tabs scope"
  );
  is(shape.value, "chrome", "The selected shape is retained");
  for (let pref of [
    "userChrome.tab.bottom_rounded_corner.australis",
    "userChrome.tab.bottom_rounded_corner.chrome_legacy",
    "userChrome.tab.bottom_rounded_corner.edge",
    "userChrome.tab.bottom_rounded_corner.wave",
  ]) {
    is(
      Services.prefs.getBoolPref(pref),
      false,
      `${pref} remains off when Chrome is selected`
    );
  }

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_colliding_prefs_render_as_one_choice() {
  resetTestPrefs();

  let tab = await openPrefsTab("appearance");
  let doc = tab.linkedBrowser.contentDocument;
  await optionGroupsRender(doc);

  let select = getControl(
    doc,
    "waterfox-opt-tab-separator",
    "moz-visual-picker"
  );
  ok(select, "The tab separator choice renders");

  await setControlValue(select, "static", "userChrome.tab.static_separator");
  is(
    Services.prefs.getBoolPref("userChrome.tab.static_separator"),
    true,
    "Choosing a separator style turns its pref on"
  );
  for (let pref of [
    "userChrome.tab.dynamic_separator",
    "userChrome.tab.bar_separator",
  ]) {
    is(
      Services.prefs.getBoolPref(pref),
      false,
      `The colliding pref ${pref} is turned off`
    );
  }

  BrowserTestUtils.removeTab(tab);
});
