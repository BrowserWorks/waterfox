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

const TREE_ENABLED_PREF = "browser.tabs.verticalTabs.tree.enabled";
const TREE_AUTO_ATTACH_PREF = "browser.tabs.verticalTabs.tree.autoAttach";
const TREE_AUTO_COLLAPSE_SELECT_PREF =
  "browser.tabs.verticalTabs.tree.autoCollapse.onSelect";
const TREE_AUTO_EXPAND_ATTACH_PREF =
  "browser.tabs.verticalTabs.tree.autoExpand.onAttach";
const TREE_CLOSE_PARENT_PREF =
  "browser.tabs.verticalTabs.tree.closeParentBehavior";
const TREE_DOUBLE_CLICK_PREF =
  "browser.tabs.verticalTabs.tree.doubleClickBehavior";
const TREE_STICKY_ACTIVE_PREF =
  "browser.tabs.verticalTabs.tree.sticky.activeTab";
const TREE_PROPAGATE_MUTED_PREF =
  "browser.tabs.verticalTabs.tree.propagateMutedState";
const TREE_MAX_DEPTH_PREF = "browser.tabs.verticalTabs.tree.maxDepth";

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
  { id: TREE_AUTO_ATTACH_PREF, type: "int" },
  { id: TREE_AUTO_COLLAPSE_SELECT_PREF, type: "bool" },
  { id: TREE_AUTO_EXPAND_ATTACH_PREF, type: "bool" },
  { id: TREE_CLOSE_PARENT_PREF, type: "int" },
  { id: TREE_DOUBLE_CLICK_PREF, type: "int" },
  { id: TREE_STICKY_ACTIVE_PREF, type: "bool" },
  { id: TREE_PROPAGATE_MUTED_PREF, type: "bool" },
  { id: TREE_MAX_DEPTH_PREF, type: "int" },
  ...TOGGLES.map(toggle => ({ id: toggle.pref, type: "bool" })),
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

// The tree master switch turns vertical tabs on alongside the tree, since the
// tree only renders in vertical mode. Turning it off leaves vertical tabs as is.
Preferences.addSetting({
  id: "waterfox-tree-tabs-enabled",
  get: () => Services.prefs.getBoolPref(TREE_ENABLED_PREF, false),
  set: value => {
    if (value) {
      Services.prefs.setBoolPref(VERTICAL_TABS_PREF, true);
    }
    Services.prefs.setBoolPref(TREE_ENABLED_PREF, !!value);
  },
  setup(emitChange) {
    Services.prefs.addObserver(TREE_ENABLED_PREF, emitChange);
    return () => Services.prefs.removeObserver(TREE_ENABLED_PREF, emitChange);
  },
});

// Every tree behavior control follows the master switch and greys out while
// the tree is off.
for (let [id, pref] of [
  ["waterfox-tree-auto-attach", TREE_AUTO_ATTACH_PREF],
  ["waterfox-tree-auto-collapse-on-select", TREE_AUTO_COLLAPSE_SELECT_PREF],
  ["waterfox-tree-auto-collapse-on-attach", TREE_AUTO_EXPAND_ATTACH_PREF],
  ["waterfox-tree-close-parent", TREE_CLOSE_PARENT_PREF],
  ["waterfox-tree-double-click", TREE_DOUBLE_CLICK_PREF],
  ["waterfox-tree-sticky-active", TREE_STICKY_ACTIVE_PREF],
  ["waterfox-tree-propagate-muted", TREE_PROPAGATE_MUTED_PREF],
  ["waterfox-tree-max-depth", TREE_MAX_DEPTH_PREF],
]) {
  Preferences.addSetting({
    id,
    pref,
    deps: ["waterfox-tree-tabs-enabled"],
    disabled: deps => !deps["waterfox-tree-tabs-enabled"].value,
  });
}

for (let fieldset of [
  "waterfox-tabs-position",
  "waterfox-tabs-menu",
  "waterfox-tabs-restart",
  "waterfox-tabs-display",
  "waterfox-tabs-grouping",
  "waterfox-tabs-tree",
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
      {
        id: "waterfox-tabs-tree",
        control: "moz-fieldset",
        l10nId: "waterfox-tabs-tree-heading",
        headingLevel: 3,
        items: [
          {
            id: "waterfox-tree-tabs-enabled",
            l10nId: "waterfox-tabs-tree-enable-toggle",
            control: "moz-toggle",
            controlAttrs: {
              searchkeywords: "tree style tabs nesting vertical",
            },
          },
          {
            id: "waterfox-tree-auto-attach",
            l10nId: "waterfox-tabs-tree-auto-attach-select",
            control: "moz-select",
            options: [
              {
                value: 0,
                l10nId: "waterfox-tabs-tree-auto-attach-option-root",
              },
              {
                value: 1,
                l10nId: "waterfox-tabs-tree-auto-attach-option-child",
              },
              {
                value: 2,
                l10nId: "waterfox-tabs-tree-auto-attach-option-sibling",
              },
            ],
          },
          {
            id: "waterfox-tree-auto-collapse-on-select",
            l10nId: "waterfox-tabs-tree-auto-collapse-on-select-toggle",
            control: "moz-toggle",
          },
          {
            id: "waterfox-tree-auto-collapse-on-attach",
            l10nId: "waterfox-tabs-tree-auto-collapse-on-attach-toggle",
            control: "moz-toggle",
          },
          {
            id: "waterfox-tree-close-parent",
            l10nId: "waterfox-tabs-tree-close-parent-select",
            control: "moz-select",
            options: [
              {
                value: 0,
                l10nId: "waterfox-tabs-tree-close-parent-option-promote-first",
              },
              {
                value: 1,
                l10nId: "waterfox-tabs-tree-close-parent-option-promote-all",
              },
              {
                value: 2,
                l10nId: "waterfox-tabs-tree-close-parent-option-close-all",
              },
              {
                value: 3,
                l10nId: "waterfox-tabs-tree-close-parent-option-detach",
              },
            ],
          },
          {
            id: "waterfox-tree-double-click",
            l10nId: "waterfox-tabs-tree-double-click-select",
            control: "moz-select",
            options: [
              {
                value: 0,
                l10nId: "waterfox-tabs-tree-double-click-option-toggle",
              },
              {
                value: 1,
                l10nId: "waterfox-tabs-tree-double-click-option-close",
              },
              {
                value: 2,
                l10nId: "waterfox-tabs-tree-double-click-option-none",
              },
            ],
          },
          {
            id: "waterfox-tree-sticky-active",
            l10nId: "waterfox-tabs-tree-sticky-active-toggle",
            control: "moz-toggle",
          },
          {
            id: "waterfox-tree-propagate-muted",
            l10nId: "waterfox-tabs-tree-propagate-muted-toggle",
            control: "moz-toggle",
          },
          {
            id: "waterfox-tree-max-depth",
            l10nId: "waterfox-tabs-tree-max-depth-select",
            control: "moz-select",
            options: [
              {
                value: -1,
                l10nId: "waterfox-tabs-tree-max-depth-option-unlimited",
              },
              { value: 2, controlAttrs: { label: "2" } },
              { value: 3, controlAttrs: { label: "3" } },
              { value: 4, controlAttrs: { label: "4" } },
              { value: 5, controlAttrs: { label: "5" } },
              { value: 6, controlAttrs: { label: "6" } },
            ],
          },
        ],
      },
    ],
  },
});

// Tree style tabs is a vertical tabs layout feature, so its controls render in
// the Firefox Browser layout group beneath the Show sidebar toggle instead of
// the Waterfox tabs section. Move the fieldset there and tag it as exclusive.
try {
  const tabsGroup = SettingGroupManager.get("waterfoxTabs");
  const layoutGroup = SettingGroupManager.get("browserLayout");
  const treeIndex = tabsGroup.items.findIndex(
    item => item.id == "waterfox-tabs-tree"
  );
  const alreadyMoved = layoutGroup.items.some(
    item => item.id == "waterfox-tabs-tree"
  );
  if (treeIndex != -1 && !alreadyMoved) {
    const [treeFieldset] = tabsGroup.items.splice(treeIndex, 1);
    treeFieldset.controlAttrs = {
      ...treeFieldset.controlAttrs,
      badge: "waterfox-exclusive",
    };
    const sidebarIndex = layoutGroup.items.findIndex(
      item => item.id == "browserLayoutShowSidebar"
    );
    layoutGroup.items.splice(
      sidebarIndex == -1 ? layoutGroup.items.length : sidebarIndex + 1,
      0,
      treeFieldset
    );
  }
} catch (_ex) {
  // Browser layout group unavailable; leave the tree controls in place.
}
