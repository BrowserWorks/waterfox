/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const SUGGESTIONS_PROXY_PREF = "waterfox.search.suggestions.useProxy";
const DISABLE_AI_PREF = "waterfox.search.disableAIFeatures";

const DEFAULT_ENGINE_GROUP_ID = "defaultEngine";
const SHOW_SEARCH_TERMS_ITEM_ID = "searchShowSearchTermCheckbox";
const SEARCH_SUGGESTIONS_GROUP_ID = "searchSuggestions";
const SHOW_SUGGESTIONS_ITEM_ID = "suggestionsInSearchFieldsCheckbox";

// No explicit control on these items, so they use the default moz-checkbox
// like the surrounding Mozilla options.
const WATERFOX_SUGGESTIONS_PROXY_ITEM = {
  id: "waterfoxSearchSuggestionsProxy",
  l10nId: "waterfox-search-suggestions-proxy-option",
  controlAttrs: {
    badge: "waterfox-exclusive",
    searchkeywords: "search terms privacy proxy autocomplete suggestions",
  },
};

// Rendered directly underneath "Show search terms in the address bar on
// results pages" in the default engine group.
const WATERFOX_DISABLE_AI_ITEM = {
  id: "waterfoxSearchDisableAI",
  l10nId: "waterfox-search-disable-ai-option",
  controlAttrs: {
    badge: "waterfox-exclusive",
    searchkeywords: "ai artificial intelligence search disable",
  },
};

Preferences.addAll([
  { id: SUGGESTIONS_PROXY_PREF, type: "bool" },
  { id: DISABLE_AI_PREF, type: "bool" },
]);

Preferences.addSetting({
  id: "waterfoxSearchSuggestionsProxy",
  pref: SUGGESTIONS_PROXY_PREF,
});
Preferences.addSetting({
  id: "waterfoxSearchDisableAI",
  pref: DISABLE_AI_PREF,
});

function amendDefaultEngineGroup(group) {
  if (!group || !Array.isArray(group.items)) {
    return;
  }
  group.items = group.items.filter(
    item => item.id !== WATERFOX_DISABLE_AI_ITEM.id
  );
  const anchor = group.items.findIndex(
    item => item.id === SHOW_SEARCH_TERMS_ITEM_ID
  );
  if (anchor === -1) {
    return;
  }
  group.items.splice(anchor + 1, 0, WATERFOX_DISABLE_AI_ITEM);
}

function amendSearchSuggestionsGroup(group) {
  if (!group || !Array.isArray(group.items)) {
    return;
  }
  const parent = group.items.find(
    item => item.id === SHOW_SUGGESTIONS_ITEM_ID
  );
  if (!parent || !Array.isArray(parent.items)) {
    return;
  }
  parent.items = parent.items.filter(
    item => item.id !== WATERFOX_SUGGESTIONS_PROXY_ITEM.id
  );
  parent.items.push(WATERFOX_SUGGESTIONS_PROXY_ITEM);
}

// config/search.mjs registers its groups when the search pane loads, which is
// after this module. Amend them whether they are already registered or
// register later.
try {
  amendDefaultEngineGroup(SettingGroupManager.get(DEFAULT_ENGINE_GROUP_ID));
} catch (_ex) {
  // Not registered yet; the wrapper below catches it.
}
try {
  amendSearchSuggestionsGroup(
    SettingGroupManager.get(SEARCH_SUGGESTIONS_GROUP_ID)
  );
} catch (_ex) {
  // Not registered yet; the wrapper below catches it.
}

const origRegisterGroups =
  SettingGroupManager.registerGroups.bind(SettingGroupManager);
SettingGroupManager.registerGroups = groups => {
  if (groups?.[DEFAULT_ENGINE_GROUP_ID]) {
    amendDefaultEngineGroup(groups[DEFAULT_ENGINE_GROUP_ID]);
  }
  if (groups?.[SEARCH_SUGGESTIONS_GROUP_ID]) {
    amendSearchSuggestionsGroup(groups[SEARCH_SUGGESTIONS_GROUP_ID]);
  }
  return origRegisterGroups(groups);
};
