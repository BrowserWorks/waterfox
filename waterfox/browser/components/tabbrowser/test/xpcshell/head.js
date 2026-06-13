/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const TREE_PREF_ENABLED = "browser.tabs.verticalTabs.tree.enabled";
const TREE_PREF_AUTO_ATTACH = "browser.tabs.verticalTabs.tree.autoAttach";
const TREE_PREF_AUTO_COLLAPSE_ON_ATTACH =
  "browser.tabs.verticalTabs.tree.autoCollapse.onAttach";
const TREE_PREF_CLOSE_PARENT_BEHAVIOR =
  "browser.tabs.verticalTabs.tree.closeParentBehavior";
const TREE_PREF_MAX_DEPTH = "browser.tabs.verticalTabs.tree.maxDepth";

const TREE_MIGRATION_PREF = "browser.tabs.verticalTabs.tree.migrated";
const OLD_TREE_PREF_AUTO_COLLAPSE_ON_SELECT =
  "browser.sidebar.autoCollapseExpandSubtreeOnSelect";
const OLD_TREE_PREF_AUTO_COLLAPSE_ON_ATTACH =
  "browser.sidebar.autoCollapseExpandSubtreeOnAttach";
const OLD_TREE_PREF_SUCCESSOR_CONTROL =
  "browser.sidebar.successorTabControlLevel";
const OLD_TREE_PREF_DOUBLE_CLICK_BEHAVIOR =
  "browser.sidebar.treeDoubleClickBehavior";
const OLD_TREE_PREF_STICKY_ACTIVE_TAB = "browser.sidebar.stickyActiveTab";
const OLD_TREE_PREF_AUTO_ATTACH = "browser.sidebar.autoAttachOnOpenedWithOwner";
const OLD_TREE_PREF_CLOSE_PARENT_BEHAVIOR =
  "browser.sidebar.closeParentBehavior_outsideSidebar_expanded";
const OLD_TREE_PREF_MAX_DEPTH = "browser.sidebar.maxTreeLevel";

const TREE_TEST_PREFS = [
  TREE_PREF_ENABLED,
  TREE_PREF_AUTO_ATTACH,
  TREE_PREF_AUTO_COLLAPSE_ON_ATTACH,
  TREE_PREF_CLOSE_PARENT_BEHAVIOR,
  TREE_PREF_MAX_DEPTH,
];

const TREE_MIGRATION_TEST_PREFS = [
  TREE_MIGRATION_PREF,
  OLD_TREE_PREF_AUTO_COLLAPSE_ON_SELECT,
  OLD_TREE_PREF_AUTO_COLLAPSE_ON_ATTACH,
  OLD_TREE_PREF_SUCCESSOR_CONTROL,
  OLD_TREE_PREF_DOUBLE_CLICK_BEHAVIOR,
  OLD_TREE_PREF_STICKY_ACTIVE_TAB,
  OLD_TREE_PREF_AUTO_ATTACH,
  OLD_TREE_PREF_CLOSE_PARENT_BEHAVIOR,
  OLD_TREE_PREF_MAX_DEPTH,
  "browser.tabs.verticalTabs.tree.autoCollapse.onSelect",
  "browser.tabs.verticalTabs.tree.autoCollapse.onAttach",
  "browser.tabs.verticalTabs.tree.autoExpand.onAttach",
  "browser.tabs.verticalTabs.tree.successorControl",
  "browser.tabs.verticalTabs.tree.doubleClickBehavior",
  "browser.tabs.verticalTabs.tree.sticky.activeTab",
  "browser.tabs.verticalTabs.tree.closeParentBehavior",
  "browser.tabs.verticalTabs.tree.maxDepth",
  "browser.tabs.verticalTabs.tree.autoAttach",
];

let gMockTabCounter = 0;

function clearUserPrefs(prefNames) {
  for (const prefName of prefNames) {
    if (Services.prefs.prefHasUserValue(prefName)) {
      Services.prefs.clearUserPref(prefName);
    }
  }
}

function resetTreeTestPrefs() {
  clearUserPrefs(TREE_TEST_PREFS);
}

function resetTreeMigrationTestPrefs() {
  clearUserPrefs(TREE_MIGRATION_TEST_PREFS);
}

function createMockWindow() {
  return {
    gBrowser: {
      tabs: [],
      selectedTab: null,
    },
  };
}

function createMockTab(window, options = {}) {
  gMockTabCounter += 1;
  const tab = {
    id: gMockTabCounter,
    linkedPanel: `panel-${gMockTabCounter}`,
    pinned: Boolean(options.pinned),
    closing: Boolean(options.closing),
    openerTab: options.openerTab || null,
    owner: null,
    documentGlobal: window,
    ownerDocument: {
      defaultView: window,
    },
  };

  if (window?.gBrowser?.tabs) {
    window.gBrowser.tabs.push(tab);
    if (!window.gBrowser.selectedTab) {
      window.gBrowser.selectedTab = tab;
    }
  }

  return tab;
}

function assertTabOrder(actualTabs, expectedTabs, message) {
  Assert.equal(actualTabs.length, expectedTabs.length, `${message}: length`);
  for (let i = 0; i < expectedTabs.length; i += 1) {
    Assert.equal(actualTabs[i], expectedTabs[i], `${message}: index ${i}`);
  }
}

registerCleanupFunction(() => {
  resetTreeTestPrefs();
  resetTreeMigrationTestPrefs();
});
