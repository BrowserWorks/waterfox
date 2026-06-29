/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SettingPaneManager } from "chrome://browser/content/preferences/config/SettingPaneManager.mjs";

/**
 * Waterfox setting panes. Top level panes also need a moz-page-nav-button
 * element in preferences.xhtml.
 */
const WATERFOX_CONFIG_PANES = Object.freeze({
  adBlocking: {
    l10nId: "waterfox-blocker-pane-header",
    iconSrc: "chrome://browser/content/blocker/waterfoxShield.svg",
    groupIds: [
      "waterfoxBlocker",
      "waterfoxBlockerLists",
      "waterfoxBlockerExceptions",
    ],
    module: "chrome://browser/content/waterfox/settings/waterfoxAdBlocking.mjs",
    visible: () =>
      Services.prefs.getBoolPref("waterfox.blocker.ui.enabled", false),
  },
});

SettingPaneManager.registerPanes(WATERFOX_CONFIG_PANES);

if (Services.prefs.getBoolPref("browser.settings-redesign.enabled", false)) {
  const aboutPane = SettingPaneManager.get("about");
  aboutPane.module =
    "chrome://browser/content/waterfox/settings/waterfoxUpdates.mjs";

  // Amend Mozilla's DoH controls without changing the frozen CONFIG_PANES table.
  // dnsOverHttps carries no module of its own; its other settings load through
  // the privacy parent chain.
  const dohPane = SettingPaneManager.get("dnsOverHttps");
  dohPane.module = "chrome://browser/content/waterfox/settings/waterfoxDns.mjs";
  ChromeUtils.importESModule(
    "chrome://browser/content/waterfox/settings/waterfoxDns.mjs",
    { global: "current" }
  );

  // The appearance and tabs panes already have Mozilla modules in their
  // slots, so the Waterfox group modules load here instead.
  const appearancePane = SettingPaneManager.get("appearance");
  // Keep browser and palette choices before Mozilla's website appearance group.
  const WATERFOX_APPEARANCE_LEAD = [
    "waterfoxBrowserStyle",
    "waterfoxThemeColors",
  ];
  const WATERFOX_APPEARANCE_REST = [
    "waterfoxStatusBar",
    "waterfoxInterfaceCustomizations",
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
  appearancePane.groupIds = appearancePane.groupIds.flatMap(groupId =>
    groupId == "appearance"
      ? [...WATERFOX_APPEARANCE_LEAD, groupId, ...WATERFOX_APPEARANCE_REST]
      : [groupId]
  );
  ChromeUtils.importESModule(
    "chrome://browser/content/waterfox/settings/waterfoxAppearance.mjs",
    { global: "current" }
  );
  ChromeUtils.importESModule(
    "chrome://browser/content/waterfox/settings/waterfoxAppearanceOptions.mjs",
    { global: "current" }
  );

  const tabsPane = SettingPaneManager.get("tabsBrowsing");
  tabsPane.groupIds = [...tabsPane.groupIds, "waterfoxTabs"];
  ChromeUtils.importESModule(
    "chrome://browser/content/waterfox/settings/waterfoxTabs.mjs",
    { global: "current" }
  );

  // The Home pane's groups are registered by AboutPreferences.observe(); the
  // custom new tab URL control attaches to them at runtime, so this module only
  // needs to load before the home pane registers.
  ChromeUtils.importESModule(
    "chrome://browser/content/waterfox/settings/waterfoxHome.mjs",
    { global: "current" }
  );
}
