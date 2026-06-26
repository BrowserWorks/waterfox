/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { ADDRESS_BAR_APPEARANCE_ITEMS } from "chrome://browser/content/waterfox/settings/waterfoxAppearanceOptions.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const CLICK_SELECTS_ALL_PREF = "browser.urlbar.clickSelectsAll";
const DOUBLE_CLICK_SELECTS_ALL_PREF = "browser.urlbar.doubleClickSelectsAll";

const SUGGEST_GROUP_ID = "firefoxSuggest";
const SUGGEST_HEADER_ID = "locationBarGroupHeader";

// The Firefox Suggest sponsored and dismissed suggestion controls are nested
// under the address bar header. Waterfox locks Suggest off, so these never apply
// and are removed from the search pane.
const HIDDEN_SUGGEST_ITEM_IDS = [
  "firefoxSuggestAll",
  "dismissedSuggestionsDescription",
];

// Mozilla shows the Suggest brand name as the address bar header when Suggest is
// enabled; Waterfox uses a neutral "Suggestions" label instead.
const MOZ_SUGGEST_HEADER_L10N_ID = "addressbar-header-firefox-suggest-2";
const WATERFOX_SUGGEST_HEADER_L10N_ID =
  "waterfox-addressbar-header-suggestions";

const ADDRESS_BAR_BEHAVIOR_ITEM = {
  id: "waterfoxAddressBarBehavior",
  l10nId: "waterfox-search-address-bar-behavior-heading",
  control: "moz-fieldset",
  controlAttrs: {
    badge: "waterfox-exclusive",
    headinglevel: 2,
  },
  items: [
    {
      id: "waterfoxClickSelectsAll",
      l10nId: "waterfox-search-click-selects-all-toggle",
      control: "moz-toggle",
      controlAttrs: {
        searchkeywords: "address bar search bar click select all",
      },
    },
    {
      id: "waterfoxDoubleClickSelectsAll",
      l10nId: "waterfox-search-double-click-selects-all-toggle",
      control: "moz-toggle",
      controlAttrs: {
        searchkeywords: "address bar search bar double click select all",
      },
    },
    ...ADDRESS_BAR_APPEARANCE_ITEMS,
  ],
};

Preferences.addAll([
  { id: CLICK_SELECTS_ALL_PREF, type: "bool" },
  { id: DOUBLE_CLICK_SELECTS_ALL_PREF, type: "bool" },
]);

Preferences.addSetting({ id: "waterfoxAddressBarBehavior" });
Preferences.addSetting({
  id: "waterfoxClickSelectsAll",
  pref: CLICK_SELECTS_ALL_PREF,
});
Preferences.addSetting({
  id: "waterfoxDoubleClickSelectsAll",
  pref: DOUBLE_CLICK_SELECTS_ALL_PREF,
});

function appendAddressBarBehavior(group) {
  if (group.items.some(item => item.id === "waterfoxAddressBarBehavior")) {
    return;
  }
  group.items.push(ADDRESS_BAR_BEHAVIOR_ITEM);
}

function removeSponsoredSuggestItems(group) {
  const header = group.items.find(item => item.id === SUGGEST_HEADER_ID);
  if (!header || !Array.isArray(header.items)) {
    return;
  }
  header.items = header.items.filter(
    item => !HIDDEN_SUGGEST_ITEM_IDS.includes(item.id)
  );
}

function amendSuggestGroup(group) {
  if (!group || !Array.isArray(group.items)) {
    return;
  }
  removeSponsoredSuggestItems(group);
  appendAddressBarBehavior(group);
}

// config/search.mjs registers the firefoxSuggest group when the search pane
// loads, which is after this module. Amend it whether it is already registered
// or registers later.
try {
  amendSuggestGroup(SettingGroupManager.get(SUGGEST_GROUP_ID));
} catch (_ex) {
  // Not registered yet; the wrapper below catches it.
}

const origRegisterGroups =
  SettingGroupManager.registerGroups.bind(SettingGroupManager);
SettingGroupManager.registerGroups = groups => {
  if (groups?.[SUGGEST_GROUP_ID]) {
    amendSuggestGroup(groups[SUGGEST_GROUP_ID]);
  }
  return origRegisterGroups(groups);
};

// Rewrite the address bar header label without editing the Mozilla setting.
function wrapSuggestHeaderLabel(config) {
  if (config._waterfoxGenericLabel) {
    return;
  }
  config._waterfoxGenericLabel = true;
  const origGetControlConfig = config.getControlConfig;
  config.getControlConfig = (...args) => {
    const result = origGetControlConfig
      ? origGetControlConfig(...args)
      : args[0];
    if (result?.l10nId === MOZ_SUGGEST_HEADER_L10N_ID) {
      return { ...result, l10nId: WATERFOX_SUGGEST_HEADER_L10N_ID };
    }
    return result;
  };
}

const existingHeader = Preferences.getSetting(SUGGEST_HEADER_ID);
if (existingHeader) {
  wrapSuggestHeaderLabel(existingHeader.config);
}

const origAddSetting = Preferences.addSetting.bind(Preferences);
Preferences.addSetting = config => {
  if (
    config.id === SUGGEST_HEADER_ID &&
    !Preferences.getSetting(SUGGEST_HEADER_ID)
  ) {
    wrapSuggestHeaderLabel(config);
  }
  return origAddSetting(config);
};
