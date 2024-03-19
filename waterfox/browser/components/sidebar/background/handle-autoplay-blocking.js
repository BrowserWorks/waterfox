/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  configs,
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from '/common/constants.js';
import * as SidebarConnection from '/common/sidebar-connection.js';

import Tab from '/common/Tab.js';

import * as Background from './background.js';

function log(...args) {
  if (configs.debug)
    console.log(...args);
}

function uniqTabsAndDescendantsSet(tabs) {
  if (!Array.isArray(tabs))
    tabs = [tabs];
  return Array.from(new Set(tabs.map(tab => [tab].concat(tab.$TST.descendants)).flat())).sort(Tab.compare);
}

function unblockAutoplayTree(tabs) {
  const tabsToUpdate = [];
  let shouldUnblockAutoplay = false;
  for (const tab of uniqTabsAndDescendantsSet(tabs)) {
    if (!shouldUnblockAutoplay && tab.$TST.autoplayBlocked)
      shouldUnblockAutoplay = true;
    tabsToUpdate.push(tab);
  }
  browser.waterfoxBridge.unblockAutoplay(tabsToUpdate.map(tab => tab.id));
}

function unblockAutoplayDescendants(rootTabs) {
  const rootTabsSet = new Set(rootTabs);
  const tabsToUpdate = [];
  let shouldUnblockAutoplay = false;
  for (const tab of uniqTabsAndDescendantsSet(rootTabs)) {
    if (rootTabsSet.has(tab))
      continue;
    if (!shouldUnblockAutoplay && tab.$TST.autoplayBlocked)
      shouldUnblockAutoplay = true;
    tabsToUpdate.push(tab);
  }
  browser.waterfoxBridge.unblockAutoplay(tabsToUpdate.map(tab => tab.id));
}

browser.menus.onClicked.addListener((info, contextTab) => {
  contextTab = contextTab && Tab.get(contextTab.id);
  const contextTabs = contextTab.$TST.multiselected ? Tab.getSelectedTabs(contextTab.windowId) : [contextTab];
  const inverted    = info.button == 1;

  switch (info.menuItemId.replace(/^grouped:/, '')) {
    case 'context_unblockAutoplay':
      browser.waterfoxBridge.unblockAutoplay(contextTabs.map(tab => tab.id));
      break;

    case 'context_topLevel_unblockAutoplayTree':
    case 'unblockAutoplayTree':
      if (inverted)
        unblockAutoplayDescendants(contextTabs);
      else
        unblockAutoplayTree(contextTabs);
      break;

    case 'context_topLevel_unblockAutoplayDescendants':
    case 'unblockAutoplayDescendants':
      if (inverted)
        unblockAutoplayTree(contextTabs);
      else
        unblockAutoplayDescendants(contextTabs);
      break;
  }
});

SidebarConnection.onMessage.addListener(async (windowId, message) => {
  switch (message.type) {
    case Constants.kCOMMAND_UNBLOCK_AUTOPLAY_FROM_SOUND_BUTTON: {
      await Tab.waitUntilTracked(message.tabId);
      const root = Tab.get(message.tabId);
      log('unblock autoplay from sound button: ', message, root);
      if (!root)
        break;

      const multiselected = root.$TST.multiselected;
      const tabs = multiselected ?
        Tab.getSelectedTabs(root.windowId, { iterator: true }) :
        [root] ;

      if (!multiselected &&
          root.$TST.subtreeCollapsed) {
        const tabsInTree = [root, ...root.$TST.descendants];
        const toBeUpdatedTabs = tabsInTree.filter(tab => tab.$TST.autoplayBlocked);
        log('  toBeUpdatedTabs: ', toBeUpdatedTabs);
        browser.waterfoxBridge.unblockAutoplay(toBeUpdatedTabs.map(tab => tab.id));
      }
      else {
        log('  tabs: ', tabs);
        browser.waterfoxBridge.unblockAutoplay(tabs.map(tab => tab.id));
      }
    }; break;
  }
});

browser.commands.onCommand.addListener(async command => {
  let activeTabs = await browser.tabs.query({
    active:        true,
    currentWindow: true,
  }).catch(ApiTabs.createErrorHandler());
  if (activeTabs.length == 0)
    activeTabs = await browser.tabs.query({
      currentWindow: true,
    }).catch(ApiTabs.createErrorHandler());
  const activeTab = Tab.get(activeTabs[0].id);
  const selectedTabs = activeTab.$TST.multiselected ? Tab.getSelectedTabs(activeTab.windowId) : [activeTab];

  switch (command) {
    case 'unblockAutoplayTree':
      unblockAutoplayTree(selectedTabs);
      return;

    case 'unblockAutoplayDescendants':
      unblockAutoplayDescendants(selectedTabs);
      return;
  }
});


Background.onReady.addListener(() => {
  browser.waterfoxBridge.listAutoplayBlockedTabs().then(tabs => {
    for (const tab of tabs) {
      Tab.get(tab.id)?.$TST.addState(Constants.kTAB_STATE_AUTOPLAY_BLOCKED);
    }
  });
});

browser.waterfoxBridge.onAutoplayBlocked.addListener(tab => {
  Tab.get(tab.id)?.$TST.addState(Constants.kTAB_STATE_AUTOPLAY_BLOCKED);
});

browser.waterfoxBridge.onAutoplayUnblocked.addListener(tab => {
  Tab.get(tab.id)?.$TST.removeState(Constants.kTAB_STATE_AUTOPLAY_BLOCKED);
});
