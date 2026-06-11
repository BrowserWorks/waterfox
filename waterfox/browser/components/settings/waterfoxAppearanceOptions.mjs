/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

// These preference sets are mutually exclusive; combinations break the tab
// strip.
const TAB_PADDING = [
  { value: "default", prefs: {} },
  { value: "lepton", prefs: { "userChrome.tab.lepton_like_padding": true } },
  { value: "photon", prefs: { "userChrome.tab.photon_like_padding": true } },
];

const TAB_SEPARATOR = [
  { value: "none", prefs: {} },
  { value: "dynamic", prefs: { "userChrome.tab.dynamic_separator": true } },
  { value: "static", prefs: { "userChrome.tab.static_separator": true } },
  { value: "bar", prefs: { "userChrome.tab.bar_separator": true } },
];

const TAB_NEWTAB_BUTTON = [
  { value: "default", prefs: {} },
  {
    value: "like_tab",
    prefs: { "userChrome.tab.newtab_button_like_tab": true },
  },
  { value: "smaller", prefs: { "userChrome.tab.newtab_button_smaller": true } },
  { value: "proton", prefs: { "userChrome.tab.newtab_button_proton": true } },
];

const TAB_CONTEXTLINE = [
  { value: "none", prefs: {} },
  {
    value: "photon",
    prefs: { "userChrome.tab.photon_like_contextline": true },
  },
  {
    value: "supernova",
    prefs: { "userChrome.tab.supernova_like_contextline": true },
  },
];

const TAB_CORNER_STYLE = [
  { value: "default", prefs: {} },
  {
    value: "australis",
    prefs: { "userChrome.tab.bottom_rounded_corner.australis": true },
  },
  {
    value: "chrome",
    prefs: { "userChrome.tab.bottom_rounded_corner.chrome": true },
  },
  {
    value: "chrome_legacy",
    prefs: { "userChrome.tab.bottom_rounded_corner.chrome_legacy": true },
  },
  {
    value: "edge",
    prefs: { "userChrome.tab.bottom_rounded_corner.edge": true },
  },
  {
    value: "wave",
    prefs: { "userChrome.tab.bottom_rounded_corner.wave": true },
  },
];

const PANEL_ICONS = [
  { value: "photon", prefs: { "userChrome.icon.panel_photon": true } },
  { value: "full", prefs: { "userChrome.icon.panel_full": true } },
];

const CHROME_SHEET_SETTING = "waterfox-chrome-sheet";
const BROWSER_STYLE_SETTING = "waterfox-browser-style";

// leptonChrome.css applies these rules only when Photon is selected.
const PHOTON_ONLY_SETTINGS = new Set([
  "waterfox-opt-tab-connect-to-window",
  "waterfox-opt-tab-color-like-toolbar",
  "waterfox-opt-tab-box-shadow",
  "waterfox-opt-tab-selected-bold",
  "waterfox-opt-tab-bottom-rounded-corner",
  "waterfox-opt-tab-bottom-rounded-corner-all",
  "waterfox-opt-tab-corner-style",
  "waterfox-opt-tab-multi-selected",
  "waterfox-opt-tab-letters-cleary",
  "waterfox-opt-tab-always-show-tab-icon",
  "waterfox-opt-hidden-tab-icon",
  "waterfox-opt-hidden-tab-icon-always",
  "waterfox-opt-tab-close-button-at-hover",
  "waterfox-opt-tab-close-button-at-hover-always",
  "waterfox-opt-tab-close-button-at-hover-with-selected",
  "waterfox-opt-tab-close-button-at-pinned",
  "waterfox-opt-tab-close-button-at-pinned-always",
  "waterfox-opt-tab-close-button-at-pinned-background",
  "waterfox-opt-tab-container",
  "waterfox-opt-tab-container-on-top",
  "waterfox-opt-tab-container-always-long",
  "waterfox-opt-tab-sound-with-favicons",
  "waterfox-opt-tab-sound-with-favicons-on-center",
  "waterfox-opt-tab-unloaded",
  "waterfox-opt-tab-crashed",
  "waterfox-opt-tab-pip",
  "waterfox-opt-tab-padding",
  "waterfox-opt-tab-separator",
  "waterfox-opt-tab-static-separator-selected-accent",
  "waterfox-opt-tab-newtab-button",
  "waterfox-opt-tab-contextline",
  "waterfox-opt-tab-contextline-blue-accent",
  "waterfox-opt-tab-blue-accent",
]);

const PREVIEW_PATH = "chrome://browser/content/waterfox/settings/previews/";

function choicePrefs(options) {
  return options.flatMap(option => Object.keys(option.prefs));
}

function readChoice(options) {
  for (let option of options) {
    const entries = Object.entries(option.prefs);
    if (
      entries.length &&
      entries.every(
        ([pref, value]) => Services.prefs.getBoolPref(pref, false) == value
      )
    ) {
      return option.value;
    }
  }
  return options[0].value;
}

function writeChoice(options, value) {
  const chosen = options.find(option => option.value == value) ?? options[0];
  for (let pref of choicePrefs(options)) {
    Services.prefs.setBoolPref(pref, Boolean(chosen.prefs[pref]));
  }
}

function previewOptions(settingId, options) {
  return options.map(option => ({
    value: option.value,
    l10nId: option.l10nId,
    controlAttrs: {
      class: "waterfox-preview-option",
      imagesrc: `${PREVIEW_PATH}${settingId}-${option.value.replace(/_/g, "-")}.svg`,
    },
  }));
}

function sheetEnabled(deps) {
  return Boolean(deps[CHROME_SHEET_SETTING].value);
}

function photonSelected(deps) {
  return deps[BROWSER_STYLE_SETTING].value == "photon";
}

function addOption(config) {
  const photonOnly = PHOTON_ONLY_SETTINGS.has(config.id);
  const deps = new Set(config.deps ?? []);
  deps.add(CHROME_SHEET_SETTING);
  if (photonOnly) {
    deps.add(BROWSER_STYLE_SETTING);
  }

  const visible = config.visible;
  Preferences.addSetting({
    ...config,
    deps: [...deps],
    visible: (settingDeps, setting) =>
      sheetEnabled(settingDeps) &&
      (!photonOnly || photonSelected(settingDeps)) &&
      (!visible || visible(settingDeps, setting)),
  });
}

function observePrefs(prefs, emitChange) {
  for (let pref of prefs) {
    Services.prefs.addObserver(pref, emitChange);
  }
  return () => {
    for (let pref of prefs) {
      Services.prefs.removeObserver(pref, emitChange);
    }
  };
}

Preferences.addAll([
  { id: "userChrome.autohide.back_button", type: "bool" },
  { id: "userChrome.autohide.bookmarkbar", type: "bool" },
  { id: "userChrome.autohide.fill_urlbar", type: "bool" },
  { id: "userChrome.autohide.forward_button", type: "bool" },
  { id: "userChrome.autohide.infobar", type: "bool" },
  { id: "userChrome.autohide.navbar", type: "bool" },
  { id: "userChrome.autohide.page_action", type: "bool" },
  { id: "userChrome.autohide.tab", type: "bool" },
  { id: "userChrome.autohide.tab.blur", type: "bool" },
  { id: "userChrome.autohide.tab.opacity", type: "bool" },
  { id: "userChrome.autohide.tabbar", type: "bool" },
  { id: "userChrome.autohide.toolbar_overlap", type: "bool" },
  { id: "userChrome.bookmarkbar.multi_row", type: "bool" },
  { id: "userChrome.centered.bookmarkbar", type: "bool" },
  { id: "userChrome.centered.tab", type: "bool" },
  { id: "userChrome.centered.tab.label", type: "bool" },
  { id: "userChrome.centered.urlbar", type: "bool" },
  { id: "userChrome.combined.nav_button", type: "bool" },
  { id: "userChrome.combined.nav_button.home_button", type: "bool" },
  { id: "userChrome.counter.bookmark_menu", type: "bool" },
  { id: "userChrome.counter.tab", type: "bool" },
  { id: "userChrome.decoration.animate", type: "bool" },
  { id: "userChrome.decoration.disable_panel_animate", type: "bool" },
  { id: "userChrome.decoration.disable_sidebar_animate", type: "bool" },
  { id: "userChrome.findbar.floating_on_top", type: "bool" },
  { id: "userChrome.hidden.bookmarkbar_icon", type: "bool" },
  { id: "userChrome.hidden.bookmarkbar_label", type: "bool" },
  { id: "userChrome.hidden.navbar", type: "bool" },
  { id: "userChrome.hidden.private_indicator", type: "bool" },
  { id: "userChrome.hidden.tab_icon", type: "bool" },
  { id: "userChrome.hidden.tab_icon.always", type: "bool" },
  { id: "userChrome.hidden.tabbar", type: "bool" },
  { id: "userChrome.hidden.titlebar_container", type: "bool" },
  { id: "userChrome.hidden.urlbar_iconbox", type: "bool" },
  { id: "userChrome.hidden.urlbar_iconbox.label_only", type: "bool" },
  { id: "userChrome.icon.1-25px_stroke", type: "bool" },
  { id: "userChrome.icon.account_image_to_right", type: "bool" },
  { id: "userChrome.icon.account_label_to_right", type: "bool" },
  { id: "userChrome.icon.context_menu", type: "bool" },
  { id: "userChrome.icon.disabled", type: "bool" },
  { id: "userChrome.icon.global_menu", type: "bool" },
  { id: "userChrome.icon.global_menu.mac", type: "bool" },
  { id: "userChrome.icon.global_menubar", type: "bool" },
  { id: "userChrome.icon.library", type: "bool" },
  { id: "userChrome.icon.menu", type: "bool" },
  { id: "userChrome.icon.menu.full", type: "bool" },
  { id: "userChrome.icon.panel", type: "bool" },
  { id: "userChrome.padding.bookmark_menu", type: "bool" },
  { id: "userChrome.padding.bookmark_menu.compact", type: "bool" },
  { id: "userChrome.padding.bookmarkbar", type: "bool" },
  { id: "userChrome.padding.drag_space", type: "bool" },
  { id: "userChrome.padding.drag_space.maximized", type: "bool" },
  { id: "userChrome.padding.first_tab", type: "bool" },
  { id: "userChrome.padding.first_tab.always", type: "bool" },
  { id: "userChrome.padding.global_menubar", type: "bool" },
  { id: "userChrome.padding.infobar", type: "bool" },
  { id: "userChrome.padding.tabbar_height", type: "bool" },
  { id: "userChrome.padding.tabbar_width", type: "bool" },
  { id: "userChrome.padding.toolbar_button", type: "bool" },
  { id: "userChrome.padding.toolbar_button.compact", type: "bool" },
  { id: "userChrome.padding.urlView_result", type: "bool" },
  { id: "userChrome.rounding.square_button", type: "bool" },
  { id: "userChrome.rounding.square_checklabel", type: "bool" },
  { id: "userChrome.rounding.square_dialog", type: "bool" },
  { id: "userChrome.rounding.square_field", type: "bool" },
  { id: "userChrome.rounding.square_infobox", type: "bool" },
  { id: "userChrome.rounding.square_menuitem", type: "bool" },
  { id: "userChrome.rounding.square_menupopup", type: "bool" },
  { id: "userChrome.rounding.square_panel", type: "bool" },
  { id: "userChrome.rounding.square_panelitem", type: "bool" },
  { id: "userChrome.rounding.square_tab", type: "bool" },
  { id: "userChrome.rounding.square_toolbar", type: "bool" },
  { id: "userChrome.rounding.square_urlView_item", type: "bool" },
  { id: "userChrome.tab.blue_accent", type: "bool" },
  { id: "userChrome.tab.bottom_rounded_corner", type: "bool" },
  { id: "userChrome.tab.bottom_rounded_corner.all", type: "bool" },
  { id: "userChrome.tab.box_shadow", type: "bool" },
  { id: "userChrome.tab.close_button_at_hover", type: "bool" },
  { id: "userChrome.tab.close_button_at_hover.always", type: "bool" },
  { id: "userChrome.tab.close_button_at_hover.with_selected", type: "bool" },
  { id: "userChrome.tab.close_button_at_pinned", type: "bool" },
  { id: "userChrome.tab.close_button_at_pinned.always", type: "bool" },
  { id: "userChrome.tab.close_button_at_pinned.background", type: "bool" },
  { id: "userChrome.tab.color_like_toolbar", type: "bool" },
  { id: "userChrome.tab.connect_to_window", type: "bool" },
  { id: "userChrome.tab.container", type: "bool" },
  { id: "userChrome.tab.container.always_long", type: "bool" },
  { id: "userChrome.tab.container.on_top", type: "bool" },
  { id: "userChrome.tab.contextline_blue_accent", type: "bool" },
  { id: "userChrome.tab.crashed", type: "bool" },
  { id: "userChrome.tab.letters_cleary", type: "bool" },
  { id: "userChrome.tab.multi_selected", type: "bool" },
  { id: "userChrome.tab.pip", type: "bool" },
  { id: "userChrome.tab.selected_bold", type: "bool" },
  { id: "userChrome.tab.sound_with_favicons", type: "bool" },
  { id: "userChrome.tab.sound_with_favicons.on_center", type: "bool" },
  { id: "userChrome.tab.static_separator.selected_accent", type: "bool" },
  { id: "userChrome.tab.unloaded", type: "bool" },
  { id: "userChrome.tabbar.as_titlebar", type: "bool" },
  { id: "userChrome.tabbar.fill_width", type: "bool" },

  { id: "userChrome.theme.built_in_contrast", type: "bool" },
  { id: "userChrome.theme.fully_color", type: "bool" },
  { id: "userChrome.theme.fully_dark", type: "bool" },
  { id: "userChrome.theme.monospace", type: "bool" },
  { id: "userChrome.theme.private", type: "bool" },
  { id: "userChrome.theme.proton_chrome", type: "bool" },
  { id: "userChrome.theme.proton_color", type: "bool" },
  { id: "userChrome.theme.system_default", type: "bool" },
  { id: "userChrome.theme.transparent.frame", type: "bool" },
  { id: "userChrome.theme.transparent.panel", type: "bool" },
  { id: "userChrome.urlView.focus_item_border", type: "bool" },
  { id: "userChrome.urlbar.always_show_page_actions", type: "bool" },
  { id: "userChrome.urlbar.iconbox_with_separator", type: "bool" },
  { id: "userContent.newTab.animate", type: "bool" },
  { id: "userContent.newTab.background_image", type: "bool" },
  { id: "userContent.newTab.full_icon", type: "bool" },
  { id: "userContent.newTab.hidden_logo", type: "bool" },

  { id: "userContent.page.dark_mode.pdf", type: "bool" },
  { id: "userContent.page.monospace", type: "bool" },
  { id: "userContent.player.animate", type: "bool" },
  { id: "userContent.player.click_to_play", type: "bool" },
  { id: "userContent.player.icon", type: "bool" },
  { id: "userContent.player.noaudio", type: "bool" },
  { id: "userContent.player.size", type: "bool" },
  { id: "userContent.player.ui", type: "bool" },
  { id: "userContent.player.ui.twoline", type: "bool" },
]);

addOption({
  id: "waterfox-opt-tabbar-fill-width",
  pref: "userChrome.tabbar.fill_width",
});

addOption({
  id: "waterfox-opt-tabbar-as-titlebar",
  pref: "userChrome.tabbar.as_titlebar",
});

addOption({
  id: "waterfox-opt-hidden-tabbar",
  pref: "userChrome.hidden.tabbar",
});

addOption({
  id: "waterfox-opt-hidden-titlebar-container",
  pref: "userChrome.hidden.titlebar_container",
});

addOption({
  id: "waterfox-opt-autohide-tabbar",
  pref: "userChrome.autohide.tabbar",
});

addOption({
  id: "waterfox-opt-autohide-tab",
  pref: "userChrome.autohide.tab",
});

addOption({
  id: "waterfox-opt-autohide-tab-opacity",
  pref: "userChrome.autohide.tab.opacity",
  deps: ["waterfox-opt-autohide-tab"],
  disabled: deps => !deps["waterfox-opt-autohide-tab"].value,
});

addOption({
  id: "waterfox-opt-autohide-tab-blur",
  pref: "userChrome.autohide.tab.blur",
  deps: ["waterfox-opt-autohide-tab"],
  disabled: deps => !deps["waterfox-opt-autohide-tab"].value,
});

addOption({
  id: "waterfox-opt-padding-tabbar-width",
  pref: "userChrome.padding.tabbar_width",
});

addOption({
  id: "waterfox-opt-padding-tabbar-height",
  pref: "userChrome.padding.tabbar_height",
});

addOption({
  id: "waterfox-opt-padding-first-tab",
  pref: "userChrome.padding.first_tab",
});

addOption({
  id: "waterfox-opt-padding-first-tab-always",
  pref: "userChrome.padding.first_tab.always",
  deps: ["waterfox-opt-padding-first-tab"],
  disabled: deps => !deps["waterfox-opt-padding-first-tab"].value,
});

addOption({
  id: "waterfox-opt-padding-drag-space",
  pref: "userChrome.padding.drag_space",
});

addOption({
  id: "waterfox-opt-padding-drag-space-maximized",
  pref: "userChrome.padding.drag_space.maximized",
  visible: () => AppConstants.platform != "macosx",
  deps: ["waterfox-opt-padding-drag-space"],
  disabled: deps => !deps["waterfox-opt-padding-drag-space"].value,
});

addOption({
  id: "waterfox-opt-centered-tab",
  pref: "userChrome.centered.tab",
});

addOption({
  id: "waterfox-opt-centered-tab-label",
  pref: "userChrome.centered.tab.label",
  deps: ["waterfox-opt-centered-tab"],
  disabled: deps => !deps["waterfox-opt-centered-tab"].value,
});

addOption({
  id: "waterfox-opt-counter-tab",
  pref: "userChrome.counter.tab",
});

addOption({
  id: "waterfox-opt-tab-connect-to-window",
  pref: "userChrome.tab.connect_to_window",
});

addOption({
  id: "waterfox-opt-tab-color-like-toolbar",
  pref: "userChrome.tab.color_like_toolbar",
});

addOption({
  id: "waterfox-opt-tab-box-shadow",
  pref: "userChrome.tab.box_shadow",
});

addOption({
  id: "waterfox-opt-tab-selected-bold",
  pref: "userChrome.tab.selected_bold",
});

addOption({
  id: "waterfox-opt-tab-blue-accent",
  pref: "userChrome.tab.blue_accent",
  deps: ["waterfox-opt-tab-contextline", "waterfox-opt-tab-separator"],
  disabled: deps =>
    deps["waterfox-opt-tab-contextline"].value != "photon" &&
    !["static", "bar"].includes(deps["waterfox-opt-tab-separator"].value),
});

addOption({
  id: "waterfox-opt-tab-contextline-blue-accent",
  pref: "userChrome.tab.contextline_blue_accent",
  deps: ["waterfox-opt-tab-contextline"],
  disabled: deps => deps["waterfox-opt-tab-contextline"].value != "supernova",
});

addOption({
  id: "waterfox-opt-tab-bottom-rounded-corner",
  pref: "userChrome.tab.bottom_rounded_corner",
});

addOption({
  id: "waterfox-opt-tab-bottom-rounded-corner-all",
  pref: "userChrome.tab.bottom_rounded_corner.all",
  deps: ["waterfox-opt-tab-bottom-rounded-corner"],
  disabled: deps => !deps["waterfox-opt-tab-bottom-rounded-corner"].value,
});

addOption({
  id: "waterfox-opt-tab-multi-selected",
  pref: "userChrome.tab.multi_selected",
});

addOption({
  id: "waterfox-opt-tab-letters-cleary",
  pref: "userChrome.tab.letters_cleary",
});

addOption({
  id: "waterfox-opt-hidden-tab-icon",
  pref: "userChrome.hidden.tab_icon",
});

addOption({
  id: "waterfox-opt-hidden-tab-icon-always",
  pref: "userChrome.hidden.tab_icon.always",
  deps: ["waterfox-opt-hidden-tab-icon"],
  disabled: deps => !deps["waterfox-opt-hidden-tab-icon"].value,
});

addOption({
  id: "waterfox-opt-tab-close-button-at-hover",
  pref: "userChrome.tab.close_button_at_hover",
});

addOption({
  id: "waterfox-opt-tab-close-button-at-hover-always",
  pref: "userChrome.tab.close_button_at_hover.always",
  deps: ["waterfox-opt-tab-close-button-at-hover"],
  disabled: deps => !deps["waterfox-opt-tab-close-button-at-hover"].value,
});

addOption({
  id: "waterfox-opt-tab-close-button-at-hover-with-selected",
  pref: "userChrome.tab.close_button_at_hover.with_selected",
  deps: ["waterfox-opt-tab-close-button-at-hover"],
  disabled: deps => !deps["waterfox-opt-tab-close-button-at-hover"].value,
});

addOption({
  id: "waterfox-opt-tab-close-button-at-pinned",
  pref: "userChrome.tab.close_button_at_pinned",
});

addOption({
  id: "waterfox-opt-tab-close-button-at-pinned-always",
  pref: "userChrome.tab.close_button_at_pinned.always",
  deps: ["waterfox-opt-tab-close-button-at-pinned"],
  disabled: deps => !deps["waterfox-opt-tab-close-button-at-pinned"].value,
});

addOption({
  id: "waterfox-opt-tab-close-button-at-pinned-background",
  pref: "userChrome.tab.close_button_at_pinned.background",
  deps: ["waterfox-opt-tab-close-button-at-pinned"],
  disabled: deps => !deps["waterfox-opt-tab-close-button-at-pinned"].value,
});

addOption({
  id: "waterfox-opt-tab-container",
  pref: "userChrome.tab.container",
});

addOption({
  id: "waterfox-opt-tab-container-on-top",
  pref: "userChrome.tab.container.on_top",
  deps: ["waterfox-opt-tab-container"],
  disabled: deps => !deps["waterfox-opt-tab-container"].value,
});

addOption({
  id: "waterfox-opt-tab-container-always-long",
  pref: "userChrome.tab.container.always_long",
  deps: ["waterfox-opt-tab-container"],
  disabled: deps => !deps["waterfox-opt-tab-container"].value,
});

addOption({
  id: "waterfox-opt-tab-sound-with-favicons",
  pref: "userChrome.tab.sound_with_favicons",
});

addOption({
  id: "waterfox-opt-tab-sound-with-favicons-on-center",
  pref: "userChrome.tab.sound_with_favicons.on_center",
  deps: ["waterfox-opt-tab-sound-with-favicons"],
  disabled: deps => !deps["waterfox-opt-tab-sound-with-favicons"].value,
});

addOption({
  id: "waterfox-opt-tab-unloaded",
  pref: "userChrome.tab.unloaded",
});

addOption({
  id: "waterfox-opt-tab-crashed",
  pref: "userChrome.tab.crashed",
});

addOption({
  id: "waterfox-opt-tab-pip",
  pref: "userChrome.tab.pip",
});

addOption({
  id: "waterfox-opt-tab-padding",
  get: () => readChoice(TAB_PADDING),
  set: value => writeChoice(TAB_PADDING, value),
  setup: emitChange => observePrefs(choicePrefs(TAB_PADDING), emitChange),
});

addOption({
  id: "waterfox-opt-tab-separator",
  get: () => readChoice(TAB_SEPARATOR),
  set: value => writeChoice(TAB_SEPARATOR, value),
  setup: emitChange => observePrefs(choicePrefs(TAB_SEPARATOR), emitChange),
});

addOption({
  id: "waterfox-opt-tab-newtab-button",
  get: () => readChoice(TAB_NEWTAB_BUTTON),
  set: value => writeChoice(TAB_NEWTAB_BUTTON, value),
  setup: emitChange => observePrefs(choicePrefs(TAB_NEWTAB_BUTTON), emitChange),
});

addOption({
  id: "waterfox-opt-tab-contextline",
  get: () => readChoice(TAB_CONTEXTLINE),
  set: value => writeChoice(TAB_CONTEXTLINE, value),
  setup: emitChange => observePrefs(choicePrefs(TAB_CONTEXTLINE), emitChange),
});

addOption({
  id: "waterfox-opt-tab-corner-style",
  get: () => readChoice(TAB_CORNER_STYLE),
  set: value => writeChoice(TAB_CORNER_STYLE, value),
  setup: emitChange => observePrefs(choicePrefs(TAB_CORNER_STYLE), emitChange),
  deps: ["waterfox-opt-tab-bottom-rounded-corner"],
  disabled: deps => !deps["waterfox-opt-tab-bottom-rounded-corner"].value,
});

addOption({
  id: "waterfox-opt-tab-static-separator-selected-accent",
  pref: "userChrome.tab.static_separator.selected_accent",
  deps: ["waterfox-opt-tab-separator"],
  disabled: deps => deps["waterfox-opt-tab-separator"].value != "static",
});

addOption({
  id: "waterfox-opt-hidden-navbar",
  pref: "userChrome.hidden.navbar",
});

addOption({
  id: "waterfox-opt-autohide-navbar",
  pref: "userChrome.autohide.navbar",
});

addOption({
  id: "waterfox-opt-autohide-back-button",
  pref: "userChrome.autohide.back_button",
});

addOption({
  id: "waterfox-opt-autohide-forward-button",
  pref: "userChrome.autohide.forward_button",
});

addOption({
  id: "waterfox-opt-combined-nav-button",
  pref: "userChrome.combined.nav_button",
});

addOption({
  id: "waterfox-opt-combined-nav-button-home-button",
  pref: "userChrome.combined.nav_button.home_button",
  deps: ["waterfox-opt-combined-nav-button"],
  disabled: deps => !deps["waterfox-opt-combined-nav-button"].value,
});

addOption({
  id: "waterfox-opt-padding-toolbar-button",
  pref: "userChrome.padding.toolbar_button",
});

addOption({
  id: "waterfox-opt-padding-toolbar-button-compact",
  pref: "userChrome.padding.toolbar_button.compact",
  deps: ["waterfox-opt-padding-toolbar-button"],
  disabled: deps => !deps["waterfox-opt-padding-toolbar-button"].value,
});

addOption({
  id: "waterfox-opt-autohide-toolbar-overlap",
  pref: "userChrome.autohide.toolbar_overlap",
});

addOption({
  id: "waterfox-opt-autohide-infobar",
  pref: "userChrome.autohide.infobar",
});

addOption({
  id: "waterfox-opt-padding-infobar",
  pref: "userChrome.padding.infobar",
});

addOption({
  id: "waterfox-opt-findbar-floating-on-top",
  pref: "userChrome.findbar.floating_on_top",
});

addOption({
  id: "waterfox-opt-padding-global-menubar",
  pref: "userChrome.padding.global_menubar",
  visible: () => AppConstants.platform != "macosx",
});

addOption({
  id: "waterfox-opt-centered-urlbar",
  pref: "userChrome.centered.urlbar",
});

addOption({
  id: "waterfox-opt-autohide-fill-urlbar",
  pref: "userChrome.autohide.fill_urlbar",
});

addOption({
  id: "waterfox-opt-autohide-page-action",
  pref: "userChrome.autohide.page_action",
});

addOption({
  id: "waterfox-opt-urlbar-always-show-page-actions",
  pref: "userChrome.urlbar.always_show_page_actions",
});

addOption({
  id: "waterfox-opt-hidden-urlbar-iconbox",
  pref: "userChrome.hidden.urlbar_iconbox",
});

addOption({
  id: "waterfox-opt-hidden-urlbar-iconbox-label-only",
  pref: "userChrome.hidden.urlbar_iconbox.label_only",
  deps: ["waterfox-opt-hidden-urlbar-iconbox"],
  disabled: deps => !deps["waterfox-opt-hidden-urlbar-iconbox"].value,
});

addOption({
  id: "waterfox-opt-urlbar-iconbox-with-separator",
  pref: "userChrome.urlbar.iconbox_with_separator",
});

addOption({
  id: "waterfox-opt-urlview-focus-item-border",
  pref: "userChrome.urlView.focus_item_border",
});

addOption({
  id: "waterfox-opt-padding-urlview-result",
  pref: "userChrome.padding.urlView_result",
});

addOption({
  id: "waterfox-opt-rounding-square-urlview-item",
  pref: "userChrome.rounding.square_urlView_item",
});

addOption({
  id: "waterfox-opt-bookmarkbar-multi-row",
  pref: "userChrome.bookmarkbar.multi_row",
});

addOption({
  id: "waterfox-opt-autohide-bookmarkbar",
  pref: "userChrome.autohide.bookmarkbar",
});

addOption({
  id: "waterfox-opt-centered-bookmarkbar",
  pref: "userChrome.centered.bookmarkbar",
});

addOption({
  id: "waterfox-opt-padding-bookmarkbar",
  pref: "userChrome.padding.bookmarkbar",
});

addOption({
  id: "waterfox-opt-hidden-bookmarkbar-icon",
  pref: "userChrome.hidden.bookmarkbar_icon",
});

addOption({
  id: "waterfox-opt-hidden-bookmarkbar-label",
  pref: "userChrome.hidden.bookmarkbar_label",
});

addOption({
  id: "waterfox-opt-padding-bookmark-menu",
  pref: "userChrome.padding.bookmark_menu",
});

addOption({
  id: "waterfox-opt-padding-bookmark-menu-compact",
  pref: "userChrome.padding.bookmark_menu.compact",
  deps: ["waterfox-opt-padding-bookmark-menu"],
  disabled: deps => !deps["waterfox-opt-padding-bookmark-menu"].value,
});

addOption({
  id: "waterfox-opt-counter-bookmark-menu",
  pref: "userChrome.counter.bookmark_menu",
});

addOption({
  id: "waterfox-opt-decoration-disable-sidebar-animate",
  pref: "userChrome.decoration.disable_sidebar_animate",
  deps: ["waterfox-opt-decoration-animate"],
  disabled: deps => !deps["waterfox-opt-decoration-animate"].value,
});

addOption({
  id: "waterfox-opt-icon-disabled",
  pref: "userChrome.icon.disabled",
});

addOption({
  id: "waterfox-opt-icon-menu",
  pref: "userChrome.icon.menu",
});

addOption({
  id: "waterfox-opt-icon-menu-full",
  pref: "userChrome.icon.menu.full",
  deps: ["waterfox-opt-icon-menu"],
  disabled: deps => !deps["waterfox-opt-icon-menu"].value,
});

addOption({
  id: "waterfox-opt-icon-context-menu",
  pref: "userChrome.icon.context_menu",
  deps: ["waterfox-opt-icon-menu"],
  disabled: deps => !deps["waterfox-opt-icon-menu"].value,
});

addOption({
  id: "waterfox-opt-icon-global-menu",
  pref: "userChrome.icon.global_menu",
  deps: ["waterfox-opt-icon-menu"],
  disabled: deps => !deps["waterfox-opt-icon-menu"].value,
});

addOption({
  id: "waterfox-opt-icon-global-menu-mac",
  pref: "userChrome.icon.global_menu.mac",
  visible: () => AppConstants.platform == "macosx",
  deps: ["waterfox-opt-icon-menu", "waterfox-opt-icon-global-menu"],
  disabled: deps =>
    !deps["waterfox-opt-icon-menu"].value ||
    !deps["waterfox-opt-icon-global-menu"].value,
});

addOption({
  id: "waterfox-opt-icon-global-menubar",
  pref: "userChrome.icon.global_menubar",
  visible: () => AppConstants.platform != "macosx",
  deps: ["waterfox-opt-icon-menu"],
  disabled: deps => !deps["waterfox-opt-icon-menu"].value,
});

addOption({
  id: "waterfox-opt-icon-panel",
  pref: "userChrome.icon.panel",
});

addOption({
  id: "waterfox-opt-icon-library",
  pref: "userChrome.icon.library",
});

addOption({
  id: "waterfox-opt-icon-1-25px-stroke",
  pref: "userChrome.icon.1-25px_stroke",
});

addOption({
  id: "waterfox-opt-icon-account-image-to-right",
  pref: "userChrome.icon.account_image_to_right",
  deps: ["waterfox-opt-icon-panel"],
  disabled: deps => !deps["waterfox-opt-icon-panel"].value,
});

addOption({
  id: "waterfox-opt-icon-account-label-to-right",
  pref: "userChrome.icon.account_label_to_right",
  deps: ["waterfox-opt-icon-panel"],
  disabled: deps => !deps["waterfox-opt-icon-panel"].value,
});

addOption({
  id: "waterfox-opt-panel-icons",
  get: () => readChoice(PANEL_ICONS),
  set: value => writeChoice(PANEL_ICONS, value),
  setup: emitChange => observePrefs(choicePrefs(PANEL_ICONS), emitChange),
  deps: ["waterfox-opt-icon-panel"],
  disabled: deps => !deps["waterfox-opt-icon-panel"].value,
});

addOption({
  id: "waterfox-opt-rounding-square-tab",
  pref: "userChrome.rounding.square_tab",
});

addOption({
  id: "waterfox-opt-rounding-square-toolbar",
  pref: "userChrome.rounding.square_toolbar",
});

addOption({
  id: "waterfox-opt-rounding-square-button",
  pref: "userChrome.rounding.square_button",
});

addOption({
  id: "waterfox-opt-rounding-square-field",
  pref: "userChrome.rounding.square_field",
});

addOption({
  id: "waterfox-opt-rounding-square-checklabel",
  pref: "userChrome.rounding.square_checklabel",
});

addOption({
  id: "waterfox-opt-rounding-square-dialog",
  pref: "userChrome.rounding.square_dialog",
});

addOption({
  id: "waterfox-opt-rounding-square-infobox",
  pref: "userChrome.rounding.square_infobox",
});

addOption({
  id: "waterfox-opt-rounding-square-panel",
  pref: "userChrome.rounding.square_panel",
});

addOption({
  id: "waterfox-opt-rounding-square-panelitem",
  pref: "userChrome.rounding.square_panelitem",
});

addOption({
  id: "waterfox-opt-rounding-square-menupopup",
  pref: "userChrome.rounding.square_menupopup",
  visible: () => AppConstants.platform != "macosx",
});

addOption({
  id: "waterfox-opt-rounding-square-menuitem",
  pref: "userChrome.rounding.square_menuitem",
});

addOption({
  id: "waterfox-opt-theme-proton-color",
  pref: "userChrome.theme.proton_color",
});

addOption({
  id: "waterfox-opt-theme-proton-chrome",
  pref: "userChrome.theme.proton_chrome",
  deps: ["waterfox-opt-theme-proton-color"],
  disabled: deps => !deps["waterfox-opt-theme-proton-color"].value,
});

addOption({
  id: "waterfox-opt-theme-fully-color",
  pref: "userChrome.theme.fully_color",
  deps: ["waterfox-opt-theme-proton-color"],
  disabled: deps => !deps["waterfox-opt-theme-proton-color"].value,
});

addOption({
  id: "waterfox-opt-theme-fully-dark",
  pref: "userChrome.theme.fully_dark",
  deps: ["waterfox-opt-theme-proton-color"],
  disabled: deps => !deps["waterfox-opt-theme-proton-color"].value,
});

addOption({
  id: "waterfox-opt-theme-built-in-contrast",
  pref: "userChrome.theme.built_in_contrast",
});

addOption({
  id: "waterfox-opt-theme-system-default",
  pref: "userChrome.theme.system_default",
});

addOption({
  id: "waterfox-opt-theme-private",
  pref: "userChrome.theme.private",
});

addOption({
  id: "waterfox-opt-hidden-private-indicator",
  pref: "userChrome.hidden.private_indicator",
});

addOption({
  id: "waterfox-opt-theme-transparent-panel",
  pref: "userChrome.theme.transparent.panel",
});

addOption({
  id: "waterfox-opt-theme-transparent-frame",
  pref: "userChrome.theme.transparent.frame",
});

addOption({
  id: "waterfox-opt-theme-monospace",
  pref: "userChrome.theme.monospace",
});

addOption({
  id: "waterfox-opt-decoration-animate",
  pref: "userChrome.decoration.animate",
});

addOption({
  id: "waterfox-opt-decoration-disable-panel-animate",
  pref: "userChrome.decoration.disable_panel_animate",
});

addOption({
  id: "waterfox-opt-page-monospace",
  pref: "userContent.page.monospace",
});

addOption({
  id: "waterfox-opt-page-dark-mode-pdf",
  pref: "userContent.page.dark_mode.pdf",
});

addOption({
  id: "waterfox-opt-newtab-hidden-logo",
  pref: "userContent.newTab.hidden_logo",
});

addOption({
  id: "waterfox-opt-newtab-full-icon",
  pref: "userContent.newTab.full_icon",
});

addOption({
  id: "waterfox-opt-newtab-background-image",
  pref: "userContent.newTab.background_image",
});

addOption({
  id: "waterfox-opt-newtab-animate",
  pref: "userContent.newTab.animate",
});

addOption({
  id: "waterfox-opt-player-ui",
  pref: "userContent.player.ui",
});

addOption({
  id: "waterfox-opt-player-ui-twoline",
  pref: "userContent.player.ui.twoline",
  deps: ["waterfox-opt-player-ui"],
  disabled: deps => !deps["waterfox-opt-player-ui"].value,
});

addOption({
  id: "waterfox-opt-player-icon",
  pref: "userContent.player.icon",
});

addOption({
  id: "waterfox-opt-player-size",
  pref: "userContent.player.size",
});

addOption({
  id: "waterfox-opt-player-noaudio",
  pref: "userContent.player.noaudio",
});

addOption({
  id: "waterfox-opt-player-click-to-play",
  pref: "userContent.player.click_to_play",
});

addOption({
  id: "waterfox-opt-player-animate",
  pref: "userContent.player.animate",
});

SettingGroupManager.registerGroups({
  waterfoxOptTabbar: {
    l10nId: "waterfox-opt-tabbar-heading",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-opt-tabbar-fill-width",
        l10nId: "waterfox-opt-tabbar-fill-width",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tabbar-as-titlebar",
        l10nId: "waterfox-opt-tabbar-as-titlebar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-hidden-tabbar",
        l10nId: "waterfox-opt-hidden-tabbar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-hidden-titlebar-container",
        l10nId: "waterfox-opt-hidden-titlebar-container",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-autohide-tabbar",
        l10nId: "waterfox-appearance-autohide-tabbar-toggle",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-autohide-tab",
        l10nId: "waterfox-opt-autohide-tab",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-autohide-tab-opacity",
        l10nId: "waterfox-opt-autohide-tab-opacity",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-autohide-tab-blur",
        l10nId: "waterfox-opt-autohide-tab-blur",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-tabbar-width",
        l10nId: "waterfox-opt-padding-tabbar-width",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-tabbar-height",
        l10nId: "waterfox-opt-padding-tabbar-height",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-first-tab",
        l10nId: "waterfox-opt-padding-first-tab",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-first-tab-always",
        l10nId: "waterfox-opt-padding-first-tab-always",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-drag-space",
        l10nId: "waterfox-opt-padding-drag-space",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-drag-space-maximized",
        l10nId: "waterfox-opt-padding-drag-space-maximized",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-centered-tab",
        l10nId: "waterfox-opt-centered-tab",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-centered-tab-label",
        l10nId: "waterfox-opt-centered-tab-label",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-counter-tab",
        l10nId: "waterfox-opt-counter-tab",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxOptTabs: {
    l10nId: "waterfox-opt-tabs-heading",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-opt-tab-connect-to-window",
        l10nId: "waterfox-opt-tab-connect-to-window",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-color-like-toolbar",
        l10nId: "waterfox-opt-tab-color-like-toolbar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-box-shadow",
        l10nId: "waterfox-opt-tab-box-shadow",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-selected-bold",
        l10nId: "waterfox-opt-tab-selected-bold",
        control: "moz-toggle",
      },

      {
        id: "waterfox-opt-tab-bottom-rounded-corner",
        l10nId: "waterfox-opt-tab-bottom-rounded-corner",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-bottom-rounded-corner-all",
        l10nId: "waterfox-opt-tab-bottom-rounded-corner-all",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-corner-style",
        l10nId: "waterfox-opt-tab-corner-style",
        control: "moz-visual-picker",
        controlAttrs: { class: "waterfox-preview-picker" },
        options: previewOptions("waterfox-opt-tab-corner-style", [
          { value: "default", l10nId: "waterfox-opt-tab-corner-style-default" },
          {
            value: "australis",
            l10nId: "waterfox-opt-tab-corner-style-australis",
          },
          { value: "chrome", l10nId: "waterfox-opt-tab-corner-style-chrome" },
          {
            value: "chrome_legacy",
            l10nId: "waterfox-opt-tab-corner-style-chrome-legacy",
          },
          { value: "edge", l10nId: "waterfox-opt-tab-corner-style-edge" },
          { value: "wave", l10nId: "waterfox-opt-tab-corner-style-wave" },
        ]),
      },
      {
        id: "waterfox-opt-tab-multi-selected",
        l10nId: "waterfox-opt-tab-multi-selected",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-letters-cleary",
        l10nId: "waterfox-opt-tab-letters-cleary",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-hidden-tab-icon",
        l10nId: "waterfox-opt-hidden-tab-icon",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-hidden-tab-icon-always",
        l10nId: "waterfox-opt-hidden-tab-icon-always",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-close-button-at-hover",
        l10nId: "waterfox-opt-tab-close-button-at-hover",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-close-button-at-hover-always",
        l10nId: "waterfox-opt-tab-close-button-at-hover-always",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-close-button-at-hover-with-selected",
        l10nId: "waterfox-opt-tab-close-button-at-hover-with-selected",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-close-button-at-pinned",
        l10nId: "waterfox-opt-tab-close-button-at-pinned",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-close-button-at-pinned-always",
        l10nId: "waterfox-opt-tab-close-button-at-pinned-always",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-close-button-at-pinned-background",
        l10nId: "waterfox-opt-tab-close-button-at-pinned-background",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-container",
        l10nId: "waterfox-opt-tab-container",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-container-on-top",
        l10nId: "waterfox-opt-tab-container-on-top",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-container-always-long",
        l10nId: "waterfox-opt-tab-container-always-long",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-sound-with-favicons",
        l10nId: "waterfox-opt-tab-sound-with-favicons",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-sound-with-favicons-on-center",
        l10nId: "waterfox-opt-tab-sound-with-favicons-on-center",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-unloaded",
        l10nId: "waterfox-opt-tab-unloaded",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-crashed",
        l10nId: "waterfox-opt-tab-crashed",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-pip",
        l10nId: "waterfox-opt-tab-pip",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-padding",
        l10nId: "waterfox-opt-tab-padding",
        control: "moz-visual-picker",
        controlAttrs: { class: "waterfox-preview-picker" },
        options: previewOptions("waterfox-opt-tab-padding", [
          { value: "default", l10nId: "waterfox-opt-tab-padding-default" },
          { value: "lepton", l10nId: "waterfox-opt-tab-padding-lepton" },
          { value: "photon", l10nId: "waterfox-opt-tab-padding-photon" },
        ]),
      },
      {
        id: "waterfox-opt-tab-separator",
        l10nId: "waterfox-opt-tab-separator",
        control: "moz-visual-picker",
        controlAttrs: { class: "waterfox-preview-picker" },
        options: previewOptions("waterfox-opt-tab-separator", [
          { value: "none", l10nId: "waterfox-opt-tab-separator-none" },
          { value: "dynamic", l10nId: "waterfox-opt-tab-separator-dynamic" },
          { value: "static", l10nId: "waterfox-opt-tab-separator-static" },
          { value: "bar", l10nId: "waterfox-opt-tab-separator-bar" },
        ]),
      },
      {
        id: "waterfox-opt-tab-static-separator-selected-accent",
        l10nId: "waterfox-opt-tab-static-separator-selected-accent",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-newtab-button",
        l10nId: "waterfox-opt-tab-newtab-button",
        control: "moz-visual-picker",
        controlAttrs: { class: "waterfox-preview-picker" },
        options: previewOptions("waterfox-opt-tab-newtab-button", [
          {
            value: "default",
            l10nId: "waterfox-opt-tab-newtab-button-default",
          },
          {
            value: "like_tab",
            l10nId: "waterfox-opt-tab-newtab-button-like-tab",
          },
          {
            value: "smaller",
            l10nId: "waterfox-opt-tab-newtab-button-smaller",
          },
          { value: "proton", l10nId: "waterfox-opt-tab-newtab-button-proton" },
        ]),
      },
      {
        id: "waterfox-opt-tab-contextline",
        l10nId: "waterfox-opt-tab-contextline",
        control: "moz-visual-picker",
        controlAttrs: { class: "waterfox-preview-picker" },
        options: previewOptions("waterfox-opt-tab-contextline", [
          { value: "none", l10nId: "waterfox-opt-tab-contextline-none" },
          { value: "photon", l10nId: "waterfox-opt-tab-contextline-photon" },
          {
            value: "supernova",
            l10nId: "waterfox-opt-tab-contextline-supernova",
          },
        ]),
      },
      {
        id: "waterfox-opt-tab-contextline-blue-accent",
        l10nId: "waterfox-opt-tab-contextline-blue-accent",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-tab-blue-accent",
        l10nId: "waterfox-opt-tab-blue-accent",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxOptToolbars: {
    l10nId: "waterfox-opt-toolbars-heading",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-opt-hidden-navbar",
        l10nId: "waterfox-opt-hidden-navbar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-autohide-navbar",
        l10nId: "waterfox-opt-autohide-navbar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-autohide-back-button",
        l10nId: "waterfox-opt-autohide-back-button",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-autohide-forward-button",
        l10nId: "waterfox-opt-autohide-forward-button",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-combined-nav-button",
        l10nId: "waterfox-opt-combined-nav-button",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-combined-nav-button-home-button",
        l10nId: "waterfox-opt-combined-nav-button-home-button",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-toolbar-button",
        l10nId: "waterfox-opt-padding-toolbar-button",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-toolbar-button-compact",
        l10nId: "waterfox-opt-padding-toolbar-button-compact",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-autohide-toolbar-overlap",
        l10nId: "waterfox-opt-autohide-toolbar-overlap",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-autohide-infobar",
        l10nId: "waterfox-opt-autohide-infobar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-infobar",
        l10nId: "waterfox-opt-padding-infobar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-findbar-floating-on-top",
        l10nId: "waterfox-opt-findbar-floating-on-top",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-global-menubar",
        l10nId: "waterfox-opt-padding-global-menubar",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxOptBookmarks: {
    l10nId: "waterfox-opt-bookmarks-heading",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-opt-bookmarkbar-multi-row",
        l10nId: "waterfox-opt-bookmarkbar-multi-row",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-autohide-bookmarkbar",
        l10nId: "waterfox-opt-autohide-bookmarkbar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-centered-bookmarkbar",
        l10nId: "waterfox-opt-centered-bookmarkbar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-bookmarkbar",
        l10nId: "waterfox-opt-padding-bookmarkbar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-hidden-bookmarkbar-icon",
        l10nId: "waterfox-opt-hidden-bookmarkbar-icon",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-hidden-bookmarkbar-label",
        l10nId: "waterfox-opt-hidden-bookmarkbar-label",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-bookmark-menu",
        l10nId: "waterfox-opt-padding-bookmark-menu",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-padding-bookmark-menu-compact",
        l10nId: "waterfox-opt-padding-bookmark-menu-compact",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-counter-bookmark-menu",
        l10nId: "waterfox-opt-counter-bookmark-menu",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxOptIcons: {
    l10nId: "waterfox-opt-icons-heading",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-opt-icon-disabled",
        l10nId: "waterfox-opt-icon-disabled",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-icon-menu",
        l10nId: "waterfox-opt-icon-menu",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-icon-menu-full",
        l10nId: "waterfox-opt-icon-menu-full",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-icon-context-menu",
        l10nId: "waterfox-opt-icon-context-menu",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-icon-global-menu",
        l10nId: "waterfox-opt-icon-global-menu",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-icon-global-menu-mac",
        l10nId: "waterfox-opt-icon-global-menu-mac",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-icon-global-menubar",
        l10nId: "waterfox-opt-icon-global-menubar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-icon-panel",
        l10nId: "waterfox-opt-icon-panel",
        control: "moz-toggle",
      },

      {
        id: "waterfox-opt-icon-account-image-to-right",
        l10nId: "waterfox-opt-icon-account-image-to-right",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-icon-account-label-to-right",
        l10nId: "waterfox-opt-icon-account-label-to-right",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-panel-icons",
        l10nId: "waterfox-opt-panel-icons",
        control: "moz-visual-picker",
        controlAttrs: { class: "waterfox-preview-picker" },
        options: previewOptions("waterfox-opt-panel-icons", [
          { value: "photon", l10nId: "waterfox-opt-panel-icons-photon" },
          { value: "full", l10nId: "waterfox-opt-panel-icons-full" },
        ]),
      },
      {
        id: "waterfox-opt-icon-library",
        l10nId: "waterfox-opt-icon-library",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-icon-1-25px-stroke",
        l10nId: "waterfox-opt-icon-1-25px-stroke",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxOptRounding: {
    l10nId: "waterfox-opt-rounding-heading",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-opt-rounding-square-tab",
        l10nId: "waterfox-opt-rounding-square-tab",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-rounding-square-toolbar",
        l10nId: "waterfox-opt-rounding-square-toolbar",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-rounding-square-button",
        l10nId: "waterfox-opt-rounding-square-button",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-rounding-square-field",
        l10nId: "waterfox-opt-rounding-square-field",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-rounding-square-checklabel",
        l10nId: "waterfox-opt-rounding-square-checklabel",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-rounding-square-dialog",
        l10nId: "waterfox-opt-rounding-square-dialog",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-rounding-square-infobox",
        l10nId: "waterfox-opt-rounding-square-infobox",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-rounding-square-panel",
        l10nId: "waterfox-opt-rounding-square-panel",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-rounding-square-panelitem",
        l10nId: "waterfox-opt-rounding-square-panelitem",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-rounding-square-menupopup",
        l10nId: "waterfox-opt-rounding-square-menupopup",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-rounding-square-menuitem",
        l10nId: "waterfox-opt-rounding-square-menuitem",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxOptTheme: {
    l10nId: "waterfox-opt-theme-heading",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-opt-theme-proton-color",
        l10nId: "waterfox-opt-theme-proton-color",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-theme-proton-chrome",
        l10nId: "waterfox-opt-theme-proton-chrome",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-theme-fully-color",
        l10nId: "waterfox-opt-theme-fully-color",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-theme-fully-dark",
        l10nId: "waterfox-opt-theme-fully-dark",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-theme-built-in-contrast",
        l10nId: "waterfox-opt-theme-built-in-contrast",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-theme-system-default",
        l10nId: "waterfox-opt-theme-system-default",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-theme-private",
        l10nId: "waterfox-opt-theme-private",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-hidden-private-indicator",
        l10nId: "waterfox-opt-hidden-private-indicator",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-theme-transparent-panel",
        l10nId: "waterfox-opt-theme-transparent-panel",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-theme-transparent-frame",
        l10nId: "waterfox-opt-theme-transparent-frame",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-theme-monospace",
        l10nId: "waterfox-opt-theme-monospace",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-decoration-animate",
        l10nId: "waterfox-opt-decoration-animate",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-decoration-disable-sidebar-animate",
        l10nId: "waterfox-opt-decoration-disable-sidebar-animate",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-decoration-disable-panel-animate",
        l10nId: "waterfox-opt-decoration-disable-panel-animate",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxOptContent: {
    l10nId: "waterfox-opt-content-heading",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-opt-page-monospace",
        l10nId: "waterfox-opt-page-monospace",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-page-dark-mode-pdf",
        l10nId: "waterfox-opt-page-dark-mode-pdf",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxOptNewtab: {
    l10nId: "waterfox-opt-newtab-heading",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-opt-newtab-hidden-logo",
        l10nId: "waterfox-opt-newtab-hidden-logo",
        control: "moz-toggle",
      },

      {
        id: "waterfox-opt-newtab-full-icon",
        l10nId: "waterfox-opt-newtab-full-icon",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-newtab-background-image",
        l10nId: "waterfox-opt-newtab-background-image",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-newtab-animate",
        l10nId: "waterfox-opt-newtab-animate",
        control: "moz-toggle",
      },
    ],
  },
  waterfoxOptPlayer: {
    l10nId: "waterfox-opt-player-heading",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-opt-player-ui",
        l10nId: "waterfox-opt-player-ui",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-player-ui-twoline",
        l10nId: "waterfox-opt-player-ui-twoline",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-player-icon",
        l10nId: "waterfox-opt-player-icon",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-player-size",
        l10nId: "waterfox-opt-player-size",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-player-noaudio",
        l10nId: "waterfox-opt-player-noaudio",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-player-click-to-play",
        l10nId: "waterfox-opt-player-click-to-play",
        control: "moz-toggle",
      },
      {
        id: "waterfox-opt-player-animate",
        l10nId: "waterfox-opt-player-animate",
        control: "moz-toggle",
      },
    ],
  },
});

export const ADDRESS_BAR_APPEARANCE_ITEMS = [
  {
    id: "waterfox-opt-centered-urlbar",
    l10nId: "waterfox-opt-centered-urlbar",
    control: "moz-toggle",
  },
  {
    id: "waterfox-opt-autohide-fill-urlbar",
    l10nId: "waterfox-opt-autohide-fill-urlbar",
    control: "moz-toggle",
  },
  {
    id: "waterfox-opt-autohide-page-action",
    l10nId: "waterfox-opt-autohide-page-action",
    control: "moz-toggle",
  },
  {
    id: "waterfox-opt-urlbar-always-show-page-actions",
    l10nId: "waterfox-opt-urlbar-always-show-page-actions",
    control: "moz-toggle",
  },
  {
    id: "waterfox-opt-hidden-urlbar-iconbox",
    l10nId: "waterfox-opt-hidden-urlbar-iconbox",
    control: "moz-toggle",
  },
  {
    id: "waterfox-opt-hidden-urlbar-iconbox-label-only",
    l10nId: "waterfox-opt-hidden-urlbar-iconbox-label-only",
    control: "moz-toggle",
  },
  {
    id: "waterfox-opt-urlbar-iconbox-with-separator",
    l10nId: "waterfox-opt-urlbar-iconbox-with-separator",
    control: "moz-toggle",
  },
  {
    id: "waterfox-opt-urlview-focus-item-border",
    l10nId: "waterfox-opt-urlview-focus-item-border",
    control: "moz-toggle",
  },
  {
    id: "waterfox-opt-padding-urlview-result",
    l10nId: "waterfox-opt-padding-urlview-result",
    control: "moz-toggle",
  },
  {
    id: "waterfox-opt-rounding-square-urlview-item",
    l10nId: "waterfox-opt-rounding-square-urlview-item",
    control: "moz-toggle",
  },
];
