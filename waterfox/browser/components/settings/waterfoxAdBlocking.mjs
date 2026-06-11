/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global gSubDialog */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  addonDisplayName: "resource:///modules/WaterfoxBlockerUtils.sys.mjs",
  isEnabledAdblockAddon: "resource:///modules/WaterfoxBlockerUtils.sys.mjs",
});

Preferences.addAll([
  { id: "waterfox.blocker.enabled", type: "bool" },
  { id: "waterfox.blocker.allowSearchPartnerAds", type: "bool" },
  { id: "waterfox.blocker.showBadge", type: "bool" },
]);

Preferences.addSetting({
  id: "waterfox-blocker-enabled",
  pref: "waterfox.blocker.enabled",
});

Preferences.addSetting({
  id: "waterfox-blocker-extension-notice",
  deps: ["waterfox-blocker-enabled"],
  _extensionName: "",
  setup(emitChange, deps) {
    const refresh = () => {
      lazy.AddonManager.getAddonsByTypes(["extension"]).then(
        addons => {
          const detected = addons.find(addon =>
            lazy.isEnabledAdblockAddon(addon)
          );
          const detectedName = detected
            ? lazy.addonDisplayName(detected) || ""
            : "";
          if (detectedName !== this._extensionName) {
            this._extensionName = detectedName;
            emitChange();
          }
        },
        () => {}
      );
    };
    refresh();
    deps["waterfox-blocker-enabled"].on("change", refresh);
    return () => deps["waterfox-blocker-enabled"].off("change", refresh);
  },
  visible(deps) {
    return !deps["waterfox-blocker-enabled"].value && !!this._extensionName;
  },
  getControlConfig(config) {
    return {
      ...config,
      l10nArgs: { extensionName: this._extensionName },
    };
  },
});

Preferences.addSetting({
  id: "waterfox-blocker-partner-ads",
  pref: "waterfox.blocker.allowSearchPartnerAds",
  deps: ["waterfox-blocker-enabled"],
  get: val => (val ? "allow" : "block"),
  set: val => val == "allow",
  disabled: deps => !deps["waterfox-blocker-enabled"].value,
});

Preferences.addSetting({
  id: "waterfox-blocker-show-badge",
  pref: "waterfox.blocker.showBadge",
  deps: ["waterfox-blocker-enabled"],
  disabled: deps => !deps["waterfox-blocker-enabled"].value,
});

Preferences.addSetting({ id: "waterfoxBlockerListsBoxGroup" });

Preferences.addSetting({
  id: "waterfox-blocker-manage-lists",
  onUserClick(e) {
    e.preventDefault();
    gSubDialog.open(
      "chrome://browser/content/preferences/dialogs/waterfoxBlockerFilterLists.xhtml"
    );
  },
});

Preferences.addSetting({
  id: "waterfox-blocker-custom-lists",
  onUserClick(e) {
    e.preventDefault();
    gSubDialog.open(
      "chrome://browser/content/preferences/dialogs/waterfoxBlockerCustomFilterLists.xhtml"
    );
  },
});

Preferences.addSetting({
  id: "waterfox-blocker-my-filters",
  onUserClick(e) {
    e.preventDefault();
    gSubDialog.open(
      "chrome://browser/content/preferences/dialogs/waterfoxBlockerCustomFilters.xhtml"
    );
  },
});

Preferences.addSetting({
  id: "waterfox-blocker-exceptions",
  onUserClick(e) {
    e.preventDefault();
    gSubDialog.open(
      "chrome://browser/content/preferences/dialogs/permissions.xhtml",
      undefined,
      {
        permissionType: "waterfox-blocker",
        disableETPVisible: true,
        prefilledHost: "",
        hideStatusColumn: true,
      }
    );
  },
});

SettingGroupManager.registerGroups({
  waterfoxBlocker: {
    l10nId: "waterfox-blocker-group",
    supportPage: "waterfox-ad-blocking",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-blocker-enabled",
        l10nId: "waterfox-blocker-enabled-toggle",
        control: "moz-toggle",
        controlAttrs: {
          searchkeywords: "adblock adblocker ublock filter",
        },
      },
      {
        id: "waterfox-blocker-extension-notice",
        l10nId: "waterfox-blocker-extension-notice",
        control: "moz-message-bar",
        controlAttrs: {
          role: "status",
        },
      },
      {
        id: "waterfox-blocker-partner-ads",
        l10nId: "waterfox-blocker-partner-select",
        control: "moz-select",
        options: [
          {
            value: "allow",
            l10nId: "waterfox-blocker-dropdown-option-partner-exception",
          },
          {
            value: "block",
            l10nId: "waterfox-blocker-dropdown-option-block-everything",
          },
        ],
      },
      {
        id: "waterfox-blocker-show-badge",
        l10nId: "waterfox-blocker-show-badge-pref",
        control: "moz-checkbox",
      },
    ],
  },
  waterfoxBlockerLists: {
    l10nId: "waterfox-blocker-lists-group",
    headingLevel: 2,
    items: [
      {
        id: "waterfoxBlockerListsBoxGroup",
        control: "moz-box-group",
        items: [
          {
            id: "waterfox-blocker-manage-lists",
            l10nId: "waterfox-blocker-manage-lists-button",
            control: "moz-box-button",
            controlAttrs: {
              "search-l10n-ids":
                "waterfox-blocker-filter-lists-window.title,waterfox-blocker-filter-lists-description.value",
            },
          },
          {
            id: "waterfox-blocker-custom-lists",
            l10nId: "waterfox-blocker-custom-lists-button",
            control: "moz-box-button",
            controlAttrs: {
              "search-l10n-ids":
                "waterfox-blocker-custom-filter-lists-window.title,waterfox-blocker-custom-filter-lists-description",
            },
          },
          {
            id: "waterfox-blocker-my-filters",
            l10nId: "waterfox-blocker-my-filters-button",
            control: "moz-box-button",
            controlAttrs: {
              "search-l10n-ids":
                "waterfox-blocker-custom-filters-window.title,waterfox-blocker-custom-filters-description",
            },
          },
        ],
      },
    ],
  },
  waterfoxBlockerExceptions: {
    l10nId: "waterfox-blocker-exceptions-group",
    headingLevel: 2,
    items: [
      {
        id: "waterfox-blocker-exceptions",
        l10nId: "waterfox-blocker-exceptions-button",
        control: "moz-box-button",
        controlAttrs: {
          "search-l10n-ids":
            "permissions-exceptions-waterfox-blocker-window2.title,permissions-exceptions-manage-waterfox-blocker-desc",
        },
      },
    ],
  },
});
