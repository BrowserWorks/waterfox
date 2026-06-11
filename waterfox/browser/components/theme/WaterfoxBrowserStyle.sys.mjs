/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const CUSTOMIZATIONS_PREF = "browser.theme.enableWaterfoxCustomizations";
const LEPTON_OFF = 2;

const PHOTON_TAB_STYLE = Object.freeze({
  "userChrome.tab.connect_to_window": true,
  "userChrome.tab.color_like_toolbar": true,
  "userChrome.tab.lepton_like_padding": true,
  "userChrome.tab.photon_like_padding": false,
  "userChrome.tab.dynamic_separator": true,
  "userChrome.tab.static_separator": false,
  "userChrome.tab.static_separator.selected_accent": false,
  "userChrome.tab.bar_separator": false,
  "userChrome.tab.newtab_button_like_tab": true,
  "userChrome.tab.newtab_button_smaller": false,
  "userChrome.tab.newtab_button_proton": false,
  "userChrome.icon.panel_full": true,
  "userChrome.icon.panel_photon": false,
  "userChrome.tab.box_shadow": true,
  "userChrome.tab.bottom_rounded_corner": true,
  "userChrome.tab.photon_like_contextline": true,
  "userChrome.rounding.square_tab": false,
});

const STOCK_TAB_STYLE = Object.freeze(
  Object.fromEntries(Object.keys(PHOTON_TAB_STYLE).map(pref => [pref, false]))
);

function applyBoolPrefs(prefs) {
  for (let [pref, value] of Object.entries(prefs)) {
    Services.prefs.setBoolPref(pref, value);
  }
}

function setBoolPrefIfUnset(pref, value) {
  if (!Services.prefs.prefHasUserValue(pref)) {
    Services.prefs.setBoolPref(pref, value);
  }
}

export const WaterfoxBrowserStyle = Object.freeze({
  PHOTON_TAB_STYLE,

  applyPhotonTabStyle() {
    applyBoolPrefs(PHOTON_TAB_STYLE);
  },

  applyStockTabStyle() {
    applyBoolPrefs(STOCK_TAB_STYLE);
  },

  ensureCurrentStyle() {
    if (
      Services.prefs.getIntPref(CUSTOMIZATIONS_PREF, LEPTON_OFF) == LEPTON_OFF
    ) {
      return;
    }

    for (let [pref, value] of Object.entries(PHOTON_TAB_STYLE)) {
      setBoolPrefIfUnset(pref, value);
    }
  },
});
