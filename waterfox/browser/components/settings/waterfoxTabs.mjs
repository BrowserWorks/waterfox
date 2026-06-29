/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const TABBAR_POSITION_PREF = "browser.tabs.toolbarposition";
const BOOKMARKS_POSITION_PREF = "browser.bookmarks.toolbarposition";
const VERTICAL_TABS_PREF = "sidebar.verticalTabs";
const AUTO_GROUP_PREF = "browser.tabs.autoGroupNewTabs";
const PLACEMENT_PREF = "browser.tabs.autoGroupNewTabs.placement";

const TOGGLES = [
  {
    id: "waterfox-tabs-duplicate-menu",
    l10nId: "waterfox-tabs-duplicate-menu-toggle",
    pref: "browser.tabs.duplicateTab",
    fieldset: "menu",
  },
  {
    id: "waterfox-tabs-copy-url-menu",
    l10nId: "waterfox-tabs-copy-url-menu-toggle",
    pref: "browser.tabs.copyurl",
    fieldset: "menu",
  },
  {
    id: "waterfox-tabs-copy-active-url",
    l10nId: "waterfox-tabs-copy-active-url-toggle",
    pref: "browser.tabs.copyurl.activetab",
    fieldset: "menu",
  },
  {
    id: "waterfox-tabs-copy-all-urls-menu",
    l10nId: "waterfox-tabs-copy-all-urls-menu-toggle",
    pref: "browser.tabs.copyallurls",
    fieldset: "menu",
  },
  {
    id: "waterfox-tabs-restart-menu",
    l10nId: "waterfox-tabs-restart-menu-toggle",
    pref: "browser.restart_menu.showpanelmenubtn",
    fieldset: "restart",
  },
  {
    id: "waterfox-tabs-restart-confirm",
    l10nId: "waterfox-tabs-restart-confirm-toggle",
    pref: "browser.restart_menu.requireconfirm",
    fieldset: "restart",
  },
  {
    id: "waterfox-tabs-restart-clear-cache",
    l10nId: "waterfox-tabs-restart-clear-cache-toggle",
    pref: "browser.restart_menu.purgecache",
    fieldset: "restart",
  },
  {
    id: "waterfox-tabs-pinned-icon-only",
    l10nId: "waterfox-tabs-pinned-icon-only-toggle",
    pref: "browser.tabs.pinnedIconOnly",
    fieldset: "display",
  },
  {
    id: "waterfox-tabs-hide-close-buttons",
    l10nId: "waterfox-tabs-hide-close-buttons-toggle",
    pref: "browser.tabs.closeButtons",
    fieldset: "display",
  },
  {
    id: "waterfox-tabs-keep-window-open-with-last-tab",
    l10nId: "waterfox-tabs-keep-window-open-with-last-tab",
    pref: "browser.tabs.closeWindowWithLastTab",
    fieldset: "display",
    inverted: true,
  },
  {
    id: "waterfox-tabs-private-new-tab-button",
    l10nId: "waterfox-tabs-private-new-tab-button-toggle",
    pref: "browser.privateTab.showNewTabButton",
    fieldset: "display",
  },
];

// sidebar.verticalTabs is already registered by the Mozilla pane module,
// so the dependency watches the pref directly instead of re adding it.
Preferences.addAll([
  { id: TABBAR_POSITION_PREF, type: "string" },
  { id: BOOKMARKS_POSITION_PREF, type: "string" },
  { id: AUTO_GROUP_PREF, type: "bool" },
  { id: PLACEMENT_PREF, type: "string" },
  ...TOGGLES.map(toggle => ({
    id: toggle.pref,
    type: "bool",
    inverted: toggle.inverted,
  })),
]);

Preferences.addSetting({
  id: "waterfox-vertical-tabs-active",
  get: () => Services.prefs.getBoolPref(VERTICAL_TABS_PREF, false),
  setup(emitChange) {
    Services.prefs.addObserver(VERTICAL_TABS_PREF, emitChange);
    return () => Services.prefs.removeObserver(VERTICAL_TABS_PREF, emitChange);
  },
});

Preferences.addSetting({
  id: "waterfox-tab-bar-position",
  pref: TABBAR_POSITION_PREF,
  deps: ["waterfox-vertical-tabs-active"],
  // The position pref only applies to the horizontal strip.
  disabled: deps => deps["waterfox-vertical-tabs-active"].value,
});

Preferences.addSetting({
  id: "waterfox-bookmarks-bar-position",
  pref: BOOKMARKS_POSITION_PREF,
});

Preferences.addSetting({
  id: "waterfox-auto-group-tabs",
  pref: AUTO_GROUP_PREF,
});

Preferences.addSetting({
  id: "waterfox-auto-group-placement",
  pref: PLACEMENT_PREF,
  deps: ["waterfox-auto-group-tabs"],
  disabled: deps => !deps["waterfox-auto-group-tabs"].value,
});

for (let toggle of TOGGLES) {
  Preferences.addSetting({ id: toggle.id, pref: toggle.pref });
}

for (let fieldset of [
  "waterfox-tabs-position",
  "waterfox-tabs-menu",
  "waterfox-tabs-restart",
  "waterfox-tabs-display",
  "waterfox-tabs-grouping",
]) {
  Preferences.addSetting({ id: fieldset });
}

function toggleItems(fieldset) {
  return TOGGLES.filter(toggle => toggle.fieldset == fieldset).map(toggle => ({
    id: toggle.id,
    l10nId: toggle.l10nId,
    control: "moz-toggle",
  }));
}

SettingGroupManager.registerGroups({
  waterfoxTabs: {
    l10nId: "waterfox-tabs-group",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-tabs-position",
        control: "moz-fieldset",
        l10nId: "waterfox-tabs-position-heading",
        headingLevel: 3,
        items: [
          {
            id: "waterfox-tab-bar-position",
            l10nId: "waterfox-tabs-tab-bar-position-select",
            control: "moz-select",
            controlAttrs: {
              searchkeywords: "tab bar position bottom toolbar",
            },
            options: [
              {
                value: "topabove",
                l10nId: "waterfox-tabs-tab-bar-option-top-above",
              },
              {
                value: "topbelow",
                l10nId: "waterfox-tabs-tab-bar-option-top-below",
              },
              {
                value: "bottomabove",
                l10nId: "waterfox-tabs-tab-bar-option-bottom-above",
              },
              {
                value: "bottombelow",
                l10nId: "waterfox-tabs-tab-bar-option-bottom-below",
              },
            ],
          },
          {
            id: "waterfox-bookmarks-bar-position",
            l10nId: "waterfox-tabs-bookmarks-bar-position-select",
            control: "moz-select",
            controlAttrs: {
              searchkeywords: "bookmarks toolbar position bottom",
            },
            options: [
              {
                value: "top",
                l10nId: "waterfox-tabs-bookmarks-bar-option-top",
              },
              {
                value: "bottom",
                l10nId: "waterfox-tabs-bookmarks-bar-option-bottom",
              },
            ],
          },
        ],
      },
      {
        id: "waterfox-tabs-menu",
        control: "moz-fieldset",
        l10nId: "waterfox-tabs-menu-heading",
        headingLevel: 3,
        items: toggleItems("menu"),
      },
      {
        id: "waterfox-tabs-restart",
        control: "moz-fieldset",
        l10nId: "waterfox-tabs-restart-heading",
        headingLevel: 3,
        items: toggleItems("restart"),
      },
      {
        id: "waterfox-tabs-display",
        control: "moz-fieldset",
        l10nId: "waterfox-tabs-display-heading",
        headingLevel: 3,
        items: toggleItems("display"),
      },
      {
        id: "waterfox-tabs-grouping",
        control: "moz-fieldset",
        l10nId: "waterfox-tabs-grouping-heading",
        headingLevel: 3,
        items: [
          {
            id: "waterfox-auto-group-tabs",
            l10nId: "waterfox-tabs-auto-group-toggle",
            control: "moz-toggle",
            controlAttrs: {
              searchkeywords: "automatic tab grouping group new tabs",
            },
          },
          {
            id: "waterfox-auto-group-placement",
            l10nId: "waterfox-tabs-auto-group-placement-select",
            control: "moz-select",
            options: [
              {
                value: "after",
                l10nId: "waterfox-tabs-auto-group-placement-option-after",
              },
              {
                value: "first",
                l10nId: "waterfox-tabs-auto-group-placement-option-first",
              },
              {
                value: "last",
                l10nId: "waterfox-tabs-auto-group-placement-option-last",
              },
            ],
          },
        ],
      },
    ],
  },
});
