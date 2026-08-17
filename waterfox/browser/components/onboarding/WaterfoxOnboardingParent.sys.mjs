/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WaterfoxOnboardingActions } from "resource:///modules/WaterfoxOnboardingActions.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  WaterfoxBrowserStyle: "resource:///modules/WaterfoxBrowserStyle.sys.mjs",
  WaterfoxThemeColors: "resource:///modules/WaterfoxThemeColors.sys.mjs",
});

const TREE_TABS_PREF = "browser.tabs.verticalTabs.tree.enabled";
const VERTICAL_TABS_PREF = "sidebar.verticalTabs";
const TABBAR_POSITION_PREF = "browser.tabs.toolbarposition";
const UIDENSITY_PREF = "browser.uidensity";
const BLOCKER_PREF = "waterfox.blocker.enabled";

const DENSITIES = ["normal", "compact", "touch"];
const TAB_LOCATIONS = new Set([
  "topabove",
  "topbelow",
  "bottomabove",
  "bottombelow",
]);

// The only external pages the onboarding may open, keyed by a page-supplied id
// so arbitrary URLs never come from content.
const SETTINGS_PAGES = new Map([
  ["privacy", "about:preferences#adBlocking"],
  ["appearance", "about:preferences#appearance"],
  ["tabs", "about:preferences#tabsBrowsing"],
]);

function getCurrentStyle() {
  return lazy.WaterfoxBrowserStyle.getStyle();
}

function getCurrentDensity() {
  return DENSITIES[Services.prefs.getIntPref(UIDENSITY_PREF, 0)] ?? "normal";
}

function getCurrentLayout() {
  if (!Services.prefs.getBoolPref(VERTICAL_TABS_PREF, false)) {
    return "horizontal";
  }
  return Services.prefs.getBoolPref(TREE_TABS_PREF, false)
    ? "tree"
    : "vertical";
}

function getCurrentTabLocation() {
  const location = Services.prefs.getStringPref(
    TABBAR_POSITION_PREF,
    "topabove"
  );
  return TAB_LOCATIONS.has(location) ? location : "topabove";
}

function getLocaleDisplayName(locale) {
  try {
    return (
      Services.intl.getLocaleDisplayNames(undefined, [locale], {
        preferNative: true,
      })[0] || locale
    );
  } catch (_) {
    return locale;
  }
}

function getLocales() {
  const selected = Services.locale.appLocaleAsBCP47;
  const locales = [...new Set([selected, ...Services.locale.packagedLocales])];
  const options = locales
    .map(locale => ({
      value: locale,
      label: getLocaleDisplayName(locale),
    }))
    .sort((a, b) => a.label.localeCompare(b.label, selected));
  return { options, selected };
}

function getInitialState() {
  return {
    locales: getLocales(),
    colors: lazy.WaterfoxThemeColors.colors,
    current: {
      style: getCurrentStyle(),
      density: getCurrentDensity(),
      mode: lazy.WaterfoxThemeColors.getMode(),
      color: lazy.WaterfoxThemeColors.getColor(),
      layout: getCurrentLayout(),
      tabLocation: getCurrentTabLocation(),
    },
    blockerEnabled: Services.prefs.getBoolPref(BLOCKER_PREF, false),
  };
}

/**
 * Serves the onboarding page: initial state, locale switching, applying setup
 * choices through WaterfoxOnboardingActions, and leaving the flow.
 */
export class WaterfoxOnboardingParent extends JSWindowActorParent {
  async receiveMessage(message) {
    switch (message.name) {
      case "WFXOnboarding:Init":
        return getInitialState();

      case "WFXOnboarding:SetLocale": {
        const locale = message.data;
        const packaged = new Set([
          Services.locale.appLocaleAsBCP47,
          ...Services.locale.packagedLocales,
        ]);
        if (!packaged.has(locale)) {
          throw new Error(`Locale ${locale} is not packaged`);
        }
        Services.locale.requestedLocales = [locale];
        return Services.locale.appLocaleAsBCP47;
      }

      case "WFXOnboarding:Apply":
        await WaterfoxOnboardingActions.handle(message.data);
        return true;

      case "WFXOnboarding:OpenSettings": {
        const url = SETTINGS_PAGES.get(message.data);
        if (url) {
          this.browsingContext.topChromeWindow?.openTrustedLinkIn(url, "tab");
        }
        return true;
      }

      case "WFXOnboarding:Finish":
        this.browsingContext.topChromeWindow?.openTrustedLinkIn(
          "about:home",
          "current"
        );
        return true;
    }
    return null;
  }
}
