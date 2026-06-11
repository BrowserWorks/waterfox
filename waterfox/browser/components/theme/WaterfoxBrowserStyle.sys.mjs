/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const BROWSER_STYLE_PREF = "browser.theme.waterfox.browserStyle";
const NOVA_PREF = "browser.nova.enabled";

const STYLE_PREFS = Object.freeze([
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
]);

const defaults = Services.prefs.getDefaultBranch("");
const STOCK_PRESET = Object.freeze(
  Object.fromEntries(STYLE_PREFS.map(pref => [pref, false]))
);
const NOVA_PRESET = Object.freeze(
  Object.fromEntries(
    STYLE_PREFS.map(pref => [pref, defaults.getBoolPref(pref, false)])
  )
);
const PROTON_PRESET = Object.freeze({
  ...STOCK_PRESET,
  "userChrome.tab.dynamic_separator": true,
  "userChrome.tab.newtab_button_proton": true,
  "userChrome.icon.panel_full": true,
});
const LEGACY_PHOTON_PRESET = Object.freeze({
  ...STOCK_PRESET,
  "userChrome.tab.connect_to_window": true,
  "userChrome.tab.color_like_toolbar": true,
  "userChrome.tab.lepton_like_padding": true,
  "userChrome.tab.dynamic_separator": true,
  "userChrome.tab.newtab_button_like_tab": true,
  "userChrome.icon.panel_full": true,
  "userChrome.tab.box_shadow": true,
  "userChrome.tab.bottom_rounded_corner": true,
  "userChrome.tab.photon_like_contextline": true,
});
const PHOTON_PRESET = LEGACY_PHOTON_PRESET;

const PRESETS = Object.freeze({
  nova: NOVA_PRESET,
  proton: PROTON_PRESET,
  photon: PHOTON_PRESET,
});

export const WaterfoxBrowserStyle = Object.freeze({
  PRESETS,
  PHOTON_PRESET,
  STYLE_PREFS,

  getStyle() {
    const style = Services.prefs.getStringPref(BROWSER_STYLE_PREF, "");
    if (PRESETS[style]) {
      return style;
    }
    return Services.prefs.getBoolPref(NOVA_PREF, true) ? "nova" : "proton";
  },

  setStyle(style) {
    if (!this.applyStyle(style)) {
      return;
    }
    Services.prefs.setStringPref(BROWSER_STYLE_PREF, style);
    Services.prefs.setBoolPref(NOVA_PREF, style == "nova");
  },

  applyStyle(style) {
    const preset = PRESETS[style];
    if (!preset) {
      return false;
    }
    for (const [pref, value] of Object.entries(preset)) {
      defaults.setBoolPref(pref, value);
    }
    return true;
  },

  applyPhotonStyle() {
    this.applyStyle("photon");
  },

  applyStockStyle() {
    this.applyStyle("nova");
  },

  clearGeneratedPrefs(style) {
    if (
      !PRESETS[style] ||
      !STYLE_PREFS.every(pref => Services.prefs.prefHasUserValue(pref))
    ) {
      return;
    }

    const preset = style == "photon" ? LEGACY_PHOTON_PRESET : STOCK_PRESET;
    for (const [pref, value] of Object.entries(preset)) {
      if (Services.prefs.getBoolPref(pref) == value) {
        Services.prefs.clearUserPref(pref);
      }
    }
  },

  ensureCurrentStyle() {
    this.applyStyle(this.getStyle());
  },
});
