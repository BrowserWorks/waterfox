/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// internal operations means operations bypassing WebExtensions' tabs APIs.

import EventListenerManager from '/extlib/EventListenerManager.js';

import {
  log as internalLogger,
  dumpTab,
  mapAndFilter,
  configs,
  wait,
} from './common.js';
import * as ApiTabs from './api-tabs.js';
import * as Constants from './constants.js';
import * as SidebarConnection from './sidebar-connection.js';
import * as TabsStore from './tabs-store.js';
import * as TabsUpdate from './tabs-update.js';

import Tab from '/common/Tab.js';

function log(...args) {
  internalLogger('common/tabs-internal-operation', ...args);
}

export const onBeforeTabsRemove = new EventListenerManager();

export async function activateTab(tab, { byMouseOperation, keepMultiselection, silently } = {}) {
  if (!Constants.IS_BACKGROUND)
    throw new Error('Error: TabsInternalOperation.activateTab is available only on the background page, use a `kCOMMAND_ACTIVATE_TAB` message instead.');

  tab = TabsStore.ensureLivingTab(tab);
  if (!tab)
    return;
  log('activateTab: ', dumpTab(tab));
  const win = TabsStore.windows.get(tab.windowId);
  win.internallyFocusingTabs.add(tab.id);
  if (byMouseOperation)
    win.internallyFocusingByMouseTabs.add(tab.id);
  if (silently)
    win.internallyFocusingSilentlyTabs.add(tab.id);
  const onError = (e) => {
    win.internallyFocusingTabs.delete(tab.id);
    win.internallyFocusingByMouseTabs.delete(tab.id);
    win.internallyFocusingSilentlyTabs.delete(tab.id);
    ApiTabs.handleMissingTabError(e);
  };
  if (configs.supportTabsMultiselect &&
      typeof browser.tabs.highlight == 'function') {
    let tabs = [tab];
    if (tab.$TST.hasOtherHighlighted &&
        keepMultiselection) {
      const highlightedTabs = Tab.getHighlightedTabs(tab.windowId);
      if (highlightedTabs.some(highlightedTab => highlightedTab.id == tab.id)) {
        // switch active tab with highlighted state
        tabs = tabs.concat(mapAndFilter(highlightedTabs,
                                        highlightedTab => highlightedTab.id != tab.id && highlightedTab || undefined));
      }
    }
    if (tabs.length == 1)
      win.tabsToBeHighlightedAlone.add(tab.id);
    highlightTabs(tabs);
  }
  else {
    log('setting tab active ', tab);
    return browser.tabs.update(tab.id, { active: true }).catch(ApiTabs.createErrorHandler(onError));
  }
}

export async function blurTab(bluredTabs, { windowId, silently } = {}) {
  if (bluredTabs &&
      !Array.isArray(bluredTabs))
    bluredTabs = [bluredTabs];

  const bluredTabIds = new Set(Array.from(bluredTabs || [], tab => tab.id || tab));

  // First, try to find successor based on successorTabId from left tabs.
  let successorTab = Tab.get(bluredTabs.find(tab => tab.active)?.successorTabId);
  const scannedTabIds = new Set();
  while (successorTab && bluredTabIds.has(successorTab.id)) {
    if (scannedTabIds.has(successorTab.id))
      break; // prevent infinite loop!
    scannedTabIds.add(successorTab.id);
    const nextSuccessorTab = (successorTab.successorTabId > 0 && successorTab.successorTabId != successorTab.id) ?
      Tab.get(successorTab.successorTabId) :
      null;
    if (!nextSuccessorTab)
      break;
    successorTab = nextSuccessorTab;
  }
  log('blurTab/step 1: found successor = ', successorTab?.id);

  // Second, try to detect successor based on their order.
  if (!successorTab || bluredTabIds.has(successorTab.id)) {
    if (successorTab)
      log(' => it cannot become the successor, find again');
    let bluredTabsFound = false;
    for (const tab of Tab.getVisibleTabs(windowId || bluredTabs[0].windowId)) {
      const blured = bluredTabIds.has(tab.id);
      if (blured)
        bluredTabsFound = true;
      if (!bluredTabsFound)
        successorTab = tab;
      if (bluredTabsFound &&
          !blured) {
        successorTab = tab;
        break;
      }
    }
    log('blurTab/step 2: found successor = ', successorTab?.id);
  }

  if (successorTab)
    await activateTab(successorTab, { silently });
  return successorTab;
}

export function removeTab(tab) {
  return removeTabs([tab]);
}

export async function removeTabs(tabs, { keepDescendants, byMouseOperation, originalStructure, triggerTab } = {}) {
  if (!Constants.IS_BACKGROUND)
    throw new Error('TabsInternalOperation.removeTabs is available only on the background page, use a `kCOMMAND_REMOVE_TABS_INTERNALLY` message instead.');

  log('TabsInternalOperation.removeTabs: ', () => tabs.map(dumpTab));
  if (tabs.length == 0)
    return;

  await onBeforeTabsRemove.dispatch(tabs);

  const win = TabsStore.windows.get(tabs[0].windowId);
  const tabIds = [];
  let willChangeFocus = false;
  tabs = tabs.filter(tab => {
    if ((!win ||
         !win.internalClosingTabs.has(tab.id)) &&
        TabsStore.ensureLivingTab(tab)) {
      tabIds.push(tab.id);
      if (tab.active)
        willChangeFocus = true;
      return true;
    }
    return false;
  });
  log(' => ', () => tabs.map(dumpTab));
  if (!tabs.length)
    return;

  if (win) {
    // Flag tabs to be closed at a time. With this flag TST skips some
    // operations on tab close (for example, opening a group tab to replace
    // a closed parent tab to keep the tree structure).
    for (const tab of tabs) {
      win.internalClosingTabs.add(tab.id);
      tab.$TST.addState(Constants.kTAB_STATE_TO_BE_REMOVED);
      clearCache(tab);
      if (keepDescendants)
        win.keepDescendantsTabs.add(tab.id);
      if (willChangeFocus && byMouseOperation) {
        win.internallyFocusingByMouseTabs.add(tab.id);
        setTimeout(() => { // the operation can be canceled
          win.internallyFocusingByMouseTabs.delete(tab.id);
        }, 250);
      }
    }
  }

  const sortedTabs = Tab.sort(Array.from(tabs));
  Tab.onMultipleTabsRemoving.dispatch(sortedTabs, { triggerTab, originalStructure });

  const promisedRemoved = browser.tabs.remove(tabIds).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
  if (win) {
    promisedRemoved.then(() => {
      // "beforeunload" listeners in tabs blocks the operation and the
      // returned promise is resolved after all "beforeunload" listeners
      // are processed and "browser.tabs.onRemoved()" listeners are
      // processed for really closed tabs.
      // In other words, there may be some "canceled tab close"s and
      // we need to clear "to-be-closed" flags for such tabs.
      // See also: https://github.com/piroor/treestyletab/issues/2384
      const canceledTabs = new Set(tabs.filter(tab => tab.$TST && !tab.$TST.destroyed));
      log(`${canceledTabs.size} tabs may be canceled to close.`);
      if (canceledTabs.size == 0) {
        Tab.onMultipleTabsRemoved.dispatch(sortedTabs, { triggerTab, originalStructure });
        return;
      }
      log(`Clearing "to-be-removed" flag for requested ${tabs.length} tabs...`);
      for (const tab of canceledTabs) {
        tab.$TST.removeState(Constants.kTAB_STATE_TO_BE_REMOVED);
        win.internalClosingTabs.delete(tab.id);
        if (keepDescendants)
          win.keepDescendantsTabs.delete(tab.id);
      }
      Tab.onMultipleTabsRemoved.dispatch(sortedTabs.filter(tab => !canceledTabs.has(tab)), { triggerTab, originalStructure });
    });
  }
  return promisedRemoved;
}

export function setTabActive(tab) {
  const oldActiveTabs = clearOldActiveStateInWindow(tab.windowId, tab);
  tab.$TST.addState(Constants.kTAB_STATE_ACTIVE);
  tab.active = true;
  tab.$TST.removeState(Constants.kTAB_STATE_NOT_ACTIVATED_SINCE_LOAD);
  tab.$TST.removeState(Constants.kTAB_STATE_UNREAD, { permanently: true });
  TabsStore.activeTabsInWindow.get(tab.windowId).add(tab);
  return oldActiveTabs;
}

export function clearOldActiveStateInWindow(windowId, exception) {
  const oldTabs = TabsStore.activeTabsInWindow.get(windowId);
  for (const oldTab of oldTabs) {
    if (oldTab == exception)
      continue;
    oldTab.$TST.removeState(Constants.kTAB_STATE_ACTIVE);
    oldTab.active = false;
  }
  return Array.from(oldTabs);
}

export function clearCache(tab) {
  if (!tab)
    return;
  const errorHandler = ApiTabs.createErrorSuppressor(ApiTabs.handleMissingTabError);
  for (const key of Constants.kCACHE_KEYS) {
    browser.sessions.removeTabValue(tab.id, key).catch(errorHandler);
  }
}

// Note: this treats the first specified tab as active.
export async function highlightTabs(tabs, { inheritToCollapsedDescendants } = {}) {
  if (!Constants.IS_BACKGROUND)
    throw new Error('TabsInternalOperation.highlightTabs is available only on the background page, use a `kCOMMAND_HIGHLIGHT_TABS` message instead.');

  if (!tabs || tabs.length == 0)
    throw new Error('TabsInternalOperation.highlightTabs requires one or more tabs.');

  const highlightedTabs = Tab.getHighlightedTabs(tabs[0].windowId);
  if (tabs.map(tab => tab.id).join('\n') == highlightedTabs.map(tab => tab.id).join('\n')) {
    log('highlightTabs: already highlighted');
    return;
  }

  log('setting tabs highlighted ', tabs, { inheritToCollapsedDescendants });

  const startAtTimestamp = Date.now();
  const startAt = `${Date.now()}-${parseInt(Math.random() * 65000)}`;
  highlightTabs.lastStartedAt = startAt;

  const windowId = tabs[0].windowId;
  const win      = TabsStore.windows.get(windowId);

  win.highlightingTabs.clear();
  win.tabsMovedWhileHighlighting = false;
  const tabIds = tabs.map(tab => {
    win.highlightingTabs.add(tab.id);
    return tab.id;
  });
  const toBeHighlightedTabIds = new Set([...win.highlightingTabs]);

  TabsUpdate.updateTabsHighlighted({
    windowId,
    tabIds,
    inheritToCollapsedDescendants,
  });
  SidebarConnection.sendMessage({
    type:     Constants.kCOMMAND_NOTIFY_HIGHLIGHTED_TABS_CHANGED,
    windowId,
    tabIds,
  });

  // for better performance, we should not call browser.tabs.update() for each tab.
  const highlightedTabIds = new Set(tabIds);
  const activeTab = Tab.getActiveTab(windowId);
  const indices = mapAndFilter(highlightedTabIds,
                               id => id == activeTab.id ? undefined : Tab.get(id).index);
  if (highlightedTabIds.has(activeTab.id))
    indices.unshift(activeTab.index);

  // highlight tabs progressively, because massinve change at once may block updating of highlighted appearance of tabs.
  let count = 1; // 1 is for setActive()
  while (highlightTabs.lastStartedAt == startAt) {
    count += (configs.provressiveHighlightingStep <= 0 ? Number.MAX_SAFE_INTEGER : configs.provressiveHighlightingStep);
    await browser.tabs.highlight({
      windowId,
      populate: false,
      tabs:     indices.slice(0, count),
    }).catch(ApiTabs.createErrorSuppressor());
    const progress = Math.ceil(Math.min(indices.length, count) / indices.length * 100);
    log(`highlightTabs: ${progress} %`);
    await wait(configs.progressievHighlightingInterval);

    if (win.tabsMovedWhileHighlighting) {
      log('highlightTabs: tabs are moved while highlighting, retry');
      await wait(250);
      return highlightTabs(tabs, { inheritToCollapsedDescendants });
    }

    if (win.highlightingTabs.size < toBeHighlightedTabIds.size) {
      log('highlightTabs: someone cleared multiselection while in-progress ', toBeHighlightedTabIds.size, win.highlightingTabs.size);
      break;
    }

    const unifiedHighlightTabIds = new Set([...toBeHighlightedTabIds, ...win.highlightingTabs]);
    if (unifiedHighlightTabIds.size != toBeHighlightedTabIds.size) {
      log('highlightTabs: someone tried multiselection again while in-progress ', toBeHighlightedTabIds.size, win.highlightingTabs.size);
      break;
    }

    if (count >= indices.length)
      break;

    SidebarConnection.sendMessage({
      type: Constants.kCOMMAND_NOTIFY_TABS_HIGHLIGHTING_IN_PROGRESS,
      windowId,
      progress,
    });
  }
  SidebarConnection.sendMessage({
    type: Constants.kCOMMAND_NOTIFY_TABS_HIGHLIGHTING_COMPLETE,
    windowId,
  });
  log('highlightTabs done. ', Date.now() - startAtTimestamp, ' msec');
}


SidebarConnection.onMessage.addListener(async (windowId, message) => {
  switch (message.type) {
    case Constants.kCOMMAND_ACTIVATE_TAB: {
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      activateTab(tab, {
        byMouseOperation:   message.byMouseOperation,
        keepMultiselection: message.keepMultiselection,
        silently:           message.silently
      });
    }; break;

    case Constants.kCOMMAND_HIGHLIGHT_TABS: {
      await Tab.waitUntilTracked(message.tabIds);
      highlightTabs(message.tabIds.map(id => Tab.get(id)), {
        inheritToCollapsedDescendants: message.inheritToCollapsedDescendants,
      });
    }; break;

    case Constants.kCOMMAND_REMOVE_TABS_INTERNALLY:
      await Tab.waitUntilTracked(message.tabIds);
      removeTabs(message.tabIds.map(id => Tab.get(id)), {
        byMouseOperation: message.byMouseOperation,
        keepDescendants:  message.keepDescendants
      });
      break;

    case Constants.kCOMMAND_REMOVE_TABS_BY_MOUSE_OPERATION:
      await Tab.waitUntilTracked(message.tabIds);
      removeTabs(message.tabIds.map(id => Tab.get(id)), {
        byMouseOperation: true,
        keepDescendants:  message.keepDescendants
      });
      break;
  }
});

if (Constants.IS_BACKGROUND) {
  browser.runtime.onMessage.addListener((message, _sender) => {
    switch (message.type) {
      // for operations from group-tab.html
      case Constants.kCOMMAND_REMOVE_TABS_INTERNALLY:
        Tab.waitUntilTracked(message.tabIds).then(() => {
          removeTabs(message.tabIds.map(id => Tab.get(id)), {
            byMouseOperation: message.byMouseOperation,
            keepDescendants:  message.keepDescendants,
          });
        });
        break;

      // for automated tests
      case Constants.kCOMMAND_REMOVE_TABS_BY_MOUSE_OPERATION:
        Tab.waitUntilTracked(message.tabIds).then(() => {
          removeTabs(message.tabIds.map(id => Tab.get(id)), {
            byMouseOperation: true
          });
        });
        break;
    }
  });
}
