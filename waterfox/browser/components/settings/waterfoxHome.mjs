/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  ExtensionSettingsStore:
    "resource://gre/modules/ExtensionSettingsStore.sys.mjs",
});

const NEWTAB_URL_PREF = "browser.newtab.url";
const URL_OVERRIDES_TYPE = "url_overrides";
const NEW_TAB_KEY = "newTabURL";

// Remembers an explicit "Custom URL" choice so the New tabs selection sticks
// before a URL is entered, since browser.newtab.url alone cannot represent a
// custom choice that has no URL yet. The module is imported per preferences
// window, so this is per-window state, matching homepageNewWindows'
// useCustomHomepage flag.
let useCustomNewTab = false;

function newTabUrlSet() {
  return !!Services.prefs.getStringPref(NEWTAB_URL_PREF, "").trim();
}

function getActiveNewTabExtension() {
  try {
    let setting = lazy.ExtensionSettingsStore.getSetting(
      URL_OVERRIDES_TYPE,
      NEW_TAB_KEY
    );
    return setting?.id && WebExtensionPolicy.getByID(setting.id);
  } catch (e) {
    // ExtensionSettingsStore can throw if not yet initialized.
    console.error(e);
    return null;
  }
}

function deselectNewTabExtension() {
  if (!getActiveNewTabExtension()) {
    return;
  }
  try {
    lazy.ExtensionSettingsStore.select(null, URL_OVERRIDES_TYPE, NEW_TAB_KEY);
  } catch (e) {
    console.error("Failed to deselect new tab extension", e);
  }
}

// Extend Mozilla's homepageNewTabs setting with a sticky "Custom URL" mode that
// reflects browser.newtab.url, without editing AboutPreferences.sys.mjs.
function wrapHomepageNewTabs(config) {
  if (config._waterfoxCustomNewTab) {
    return;
  }
  config._waterfoxCustomNewTab = true;

  const origGet = config.get;
  const origSet = config.set;
  const origGetControlConfig = config.getControlConfig;
  const origSetup = config.setup;

  config.get = (val, deps, setting) => {
    if (useCustomNewTab || newTabUrlSet()) {
      return "custom";
    }
    return origGet ? origGet(val, deps, setting) : val;
  };

  config.set = (val, deps, setting) => {
    const wasCustom = useCustomNewTab;
    useCustomNewTab = val === "custom";
    if (wasCustom !== useCustomNewTab) {
      setting.onChange?.();
    }
    if (val === "custom") {
      // Keep browser.newtabpage.enabled as-is; the URL is written by the input.
      return setting.pref.value;
    }
    if (Services.prefs.prefHasUserValue(NEWTAB_URL_PREF)) {
      Services.prefs.clearUserPref(NEWTAB_URL_PREF);
    }
    return origSet ? origSet(val, deps, setting) : val;
  };

  config.getControlConfig = (controlConfig, deps, setting) => {
    const result = origGetControlConfig
      ? origGetControlConfig(controlConfig, deps, setting)
      : controlConfig;
    const options = result.options || [];
    if (options.some(option => option.value === "custom")) {
      return result;
    }
    const builtins = options.filter(
      option => option.value === "home" || option.value === "blank"
    );
    const rest = options.filter(
      option => option.value !== "home" && option.value !== "blank"
    );
    return {
      ...result,
      options: [
        ...builtins,
        {
          value: "custom",
          l10nId: "waterfox-home-mode-choice-custom-new-tab-url",
        },
        ...rest,
      ],
    };
  };

  config.setup = (onChange, deps) => {
    const teardown = origSetup ? origSetup(onChange, deps) : undefined;
    const observer = () => onChange();
    Services.prefs.addObserver(NEWTAB_URL_PREF, observer);
    return () => {
      Services.prefs.removeObserver(NEWTAB_URL_PREF, observer);
      teardown?.();
    };
  };
}

const existingNewTabs = Preferences.getSetting("homepageNewTabs");
if (existingNewTabs) {
  wrapHomepageNewTabs(existingNewTabs.config);
}

const origAddSetting = Preferences.addSetting.bind(Preferences);
Preferences.addSetting = config => {
  if (
    config.id === "homepageNewTabs" &&
    !Preferences.getSetting("homepageNewTabs")
  ) {
    wrapHomepageNewTabs(config);
  }
  return origAddSetting(config);
};

Preferences.addAll([{ id: NEWTAB_URL_PREF, type: "string" }]);

Preferences.addSetting({
  id: "waterfoxCustomNewTabUrlGroup",
  deps: ["homepageNewTabs"],
  visible: ({ homepageNewTabs }) => homepageNewTabs.value === "custom",
});

Preferences.addSetting({
  id: "waterfoxCustomNewTabUrl",
  pref: NEWTAB_URL_PREF,
  set(inputVal) {
    let url = inputVal.trim();
    if (url) {
      deselectNewTabExtension();
    }
    return url;
  },
});

// The custom URL field renders inside Mozilla's "homepage" group, directly
// under the New tabs dropdown. That group is registered per window by
// AboutPreferences.observe(), so inject the fieldset as the group registers.
const CUSTOM_NEWTAB_ITEM = {
  id: "waterfoxCustomNewTabUrlGroup",
  control: "moz-fieldset",
  l10nId: "waterfox-home-new-tab-custom-url",
  supportPage: "waterfox-custom-new-tab-url",
  controlAttrs: {
    badge: "waterfox-exclusive",
    headinglevel: 3,
    searchkeywords: "custom new tab url homepage",
  },
  items: [
    {
      id: "waterfoxCustomNewTabUrl",
      control: "moz-input-url",
      l10nId: "waterfox-home-new-tab-custom-url-input",
    },
  ],
};

function injectCustomNewTabItem(config) {
  if (!config || !Array.isArray(config.items)) {
    return;
  }
  if (config.items.some(item => item.id === "waterfoxCustomNewTabUrlGroup")) {
    return;
  }
  const index = config.items.findIndex(item => item.id === "homepageNewTabs");
  config.items.splice(
    index === -1 ? config.items.length : index + 1,
    0,
    CUSTOM_NEWTAB_ITEM
  );
}

// Waterfox ships no sponsored content, so drop the "Support Firefox" sponsored
// group from the Home pane without editing AboutPreferences.sys.mjs.
function removeSupportFirefoxItem(items) {
  if (!Array.isArray(items)) {
    return false;
  }
  for (let i = 0; i < items.length; i++) {
    if (items[i]?.id === "supportFirefox") {
      items.splice(i, 1);
      return true;
    }
    if (removeSupportFirefoxItem(items[i]?.items)) {
      return true;
    }
  }
  return false;
}

try {
  injectCustomNewTabItem(SettingGroupManager.get("homepage"));
} catch (_ex) {
  // The homepage group is not registered yet; the wrapper below catches it.
}

const origRegisterGroups =
  SettingGroupManager.registerGroups.bind(SettingGroupManager);
SettingGroupManager.registerGroups = groups => {
  if (groups?.homepage) {
    injectCustomNewTabItem(groups.homepage);
  }
  if (groups?.home) {
    removeSupportFirefoxItem(groups.home.items);
  }
  return origRegisterGroups(groups);
};
