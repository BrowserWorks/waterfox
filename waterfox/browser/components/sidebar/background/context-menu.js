/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  configs,
} from '/common/common.js';

import * as ApiTabs from '/common/api-tabs.js';
import * as Bookmark from '/common/bookmark.js';
import * as Sync from '/common/sync.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';

import * as Commands from './commands.js';
import * as TabContextMenu from './tab-context-menu.js';

function log(...args) {
  internalLogger('background/context-menu', ...args);
}

export async function init() {
  return Promise.all([
    addTabItems(),
    addBookmarkItems(),
  ]);
}

const SAFE_CREATE_PROPERTIES = [
  'checked',
  'contexts',
  'documentUrlPatterns',
  'enabled',
  'icons',
  'id',
  'parentId',
  'title',
  'type',
  'viewTypes',
  'visible'
];

function getSafeCreateParams(params) {
  const safeParams = {};
  for (const property of SAFE_CREATE_PROPERTIES) {
    if (property in params)
      safeParams[property] = params[property];
  }
  return safeParams;
}

const manifest = browser.runtime.getManifest();

const kROOT_TAB_ITEM = 'ws';
const kROOT_BOOKMARK_ITEM = 'ws-bookmark';

const mTabItemsById = {
  'reloadTree': {
    title:              browser.i18n.getMessage('context_reloadTree_label'),
    titleMultiselected: browser.i18n.getMessage('context_reloadTree_label_multiselected')
  },
  'reloadDescendants': {
    title:              browser.i18n.getMessage('context_reloadDescendants_label'),
    titleMultiselected: browser.i18n.getMessage('context_reloadDescendants_label_multiselected')
  },
  // This item won't be handled by the onClicked handler, so you may need to handle it with something experiments API.
  'unblockAutoplayTree': {
    title:                browser.i18n.getMessage('context_unblockAutoplayTree_label'),
    titleMultiselected:   browser.i18n.getMessage('context_unblockAutoplayTree_label_multiselected'),
    requireAutoplayBlockedTab: true,
  },
  // This item won't be handled by the onClicked handler, so you may need to handle it with something experiments API.
  'unblockAutoplayDescendants': {
    title:                browser.i18n.getMessage('context_unblockAutoplayDescendants_label'),
    titleMultiselected:   browser.i18n.getMessage('context_unblockAutoplayDescendants_label_multiselected'),
    requireAutoplayBlockedDescendant: true,
  },
  'toggleMuteTree': {
    titleMuteTree:                browser.i18n.getMessage('context_toggleMuteTree_label_mute'),
    titleMultiselectedMuteTree:   browser.i18n.getMessage('context_toggleMuteTree_label_multiselected_mute'),
    titleUnmuteTree:              browser.i18n.getMessage('context_toggleMuteTree_label_unmute'),
    titleMultiselectedUnmuteTree: browser.i18n.getMessage('context_toggleMuteTree_label_multiselected_unmute')
  },
  'toggleMuteDescendants': {
    titleMuteDescendant:                browser.i18n.getMessage('context_toggleMuteDescendants_label_mute'),
    titleMultiselectedMuteDescendant:   browser.i18n.getMessage('context_toggleMuteDescendants_label_multiselected_mute'),
    titleUnmuteDescendant:              browser.i18n.getMessage('context_toggleMuteDescendants_label_unmute'),
    titleMultiselectedUnmuteDescendant: browser.i18n.getMessage('context_toggleMuteDescendants_label_multiselected_unmute')
  },
  'separatorAfterReload': {
    type: 'separator'
  },
  'closeTree': {
    title:              browser.i18n.getMessage('context_closeTree_label'),
    titleMultiselected: browser.i18n.getMessage('context_closeTree_label_multiselected')
  },
  'closeDescendants': {
    title:              browser.i18n.getMessage('context_closeDescendants_label'),
    titleMultiselected: browser.i18n.getMessage('context_closeDescendants_label_multiselected'),
    requireTree:        true,
  },
  'closeOthers': {
    title:              browser.i18n.getMessage('context_closeOthers_label'),
    titleMultiselected: browser.i18n.getMessage('context_closeOthers_label_multiselected')
  },
  'separatorAfterClose': {
    type: 'separator'
  },
  'toggleSticky': {
    titleStick:                browser.i18n.getMessage('context_toggleSticky_label_stick'),
    titleMultiselectedStick:   browser.i18n.getMessage('context_toggleSticky_label_multiselected_stick'),
    titleUnstick:              browser.i18n.getMessage('context_toggleSticky_label_unstick'),
    titleMultiselectedUnstick: browser.i18n.getMessage('context_toggleSticky_label_multiselected_unstick'),
    requireNormal: true,
  },
  'separatorAfterToggleSticky': {
    type: 'separator'
  },
  'collapseTree': {
    title:              browser.i18n.getMessage('context_collapseTree_label'),
    titleMultiselected: browser.i18n.getMessage('context_collapseTree_label_multiselected'),
    requireTree: true,
  },
  'collapseTreeRecursively': {
    title:              browser.i18n.getMessage('context_collapseTreeRecursively_label'),
    titleMultiselected: browser.i18n.getMessage('context_collapseTreeRecursively_label_multiselected'),
    requireTree:        true,
  },
  'collapseAll': {
    title:               browser.i18n.getMessage('context_collapseAll_label'),
    hideOnMultiselected: true
  },
  'expandTree': {
    title:              browser.i18n.getMessage('context_expandTree_label'),
    titleMultiselected: browser.i18n.getMessage('context_expandTree_label_multiselected'),
    requireTree:       true,
  },
  'expandTreeRecursively': {
    title:              browser.i18n.getMessage('context_expandTreeRecursively_label'),
    titleMultiselected: browser.i18n.getMessage('context_expandTreeRecursively_label_multiselected'),
    requireTree:        true,
  },
  'expandAll': {
    title:               browser.i18n.getMessage('context_expandAll_label'),
    hideOnMultiselected: true
  },
  'separatorAfterCollapseExpand': {
    type: 'separator'
  },
  'bookmarkTree': {
    title:              browser.i18n.getMessage('context_bookmarkTree_label'),
    titleMultiselected: browser.i18n.getMessage('context_bookmarkTree_label_multiselected')
  },
  'sendTreeToDevice': {
    title:              browser.i18n.getMessage('context_sendTreeToDevice_label'),
    titleMultiselected: browser.i18n.getMessage('context_sendTreeToDevice_label_multiselected')
  },
  'separatorAfterBookmark': {
    type: 'separator'
  },
  'collapsed': {
    title:       browser.i18n.getMessage('context_collapsed_label'),
    requireTree: true,
    type:        'checkbox'
  },
  'pinnedTab': {
    title: browser.i18n.getMessage('context_pinnedTab_label'),
    type: 'radio'
  },
  'unpinnedTab': {
    title: browser.i18n.getMessage('context_unpinnedTab_label'),
    type: 'radio'
  }
};
const mTabItems = [];
const mGroupedTabItems = [];
const mGroupedTabItemsById = {};
for (const id of Object.keys(mTabItemsById)) {
  const item = mTabItemsById[id];
  item.id = id;
  item.configKey = `context_${id}`;
  item.checked = false; // initialize as unchecked
  item.enabled = true;
  // Access key is not supported by WE API.
  // See also: https://bugzilla.mozilla.org/show_bug.cgi?id=1320462
  item.titleWithoutAccesskey = item.title && item.title.replace(/\(&[a-z]\)|&([a-z])/i, '$1');
  item.titleMultiselectedWithoutAccesskey = item.titleMultiselected && item.titleMultiselected.replace(/\(&[a-z]\)|&([a-z])/i, '$1');
  item.type = item.type || 'normal';
  item.contexts = ['tab'];
  item.lastVisible = item.visible = false;
  item.lastTitle = item.title;
  mTabItems.push(item);

  const groupedItem = {
    ...item,
    id:       `grouped:${id}`,
    parentId: kROOT_TAB_ITEM
  };
  mGroupedTabItems.push(groupedItem);
  mGroupedTabItemsById[groupedItem.id] = groupedItem;
}

const mTabSeparator = {
  id:        `separatprBefore${kROOT_TAB_ITEM}`,
  type:      'separator',
  contexts:  ['tab'],
  viewTypes: ['sidebar'],
  documentUrlPatterns: [`moz-extension://${location.host}/*`],
  visible:   false,
  lastVisible: false
};
const mTabRootItem = {
  id:       kROOT_TAB_ITEM,
  type:     'normal',
  contexts: ['tab'],
  title:    browser.i18n.getMessage('context_menu_label'),
  icons:    manifest.icons,
  visible:  false,
  lastVisible: false
};

const mAllTabItems = [
  mTabSeparator,
  mTabRootItem,
  ...mTabItems,
  ...mGroupedTabItems
];

function addTabItems() {
  const promises = [];
  if (addTabItems.done) {
    for (const item of mAllTabItems) {
      promises.push(browser.menus.remove(item.id));
    }
  }

  for (const item of mAllTabItems) {
    const params = getSafeCreateParams(item);
    promises.push(browser.menus.create(params));
    if (item.id == mTabSeparator.id ||
        addTabItems.done)
      continue;
    promises.push(TabContextMenu.onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_CREATE,
      params
    }, browser.runtime));
  }

  addTabItems.done = true;
  return Promise.all(promises);
}
addTabItems.done = false;


const mBookmarkItemsById = {
  openAllBookmarksWithStructure: {
    title: browser.i18n.getMessage('context_openAllBookmarksWithStructure_label')
  },
  openAllBookmarksWithStructureRecursively: {
    title: browser.i18n.getMessage('context_openAllBookmarksWithStructureRecursively_label')
  }
};
const mBookmarkItems = [];
const mGroupedBookmarkItems = []
for (const id of Object.keys(mBookmarkItemsById)) {
  const item = mBookmarkItemsById[id];
  item.id        = id;
  item.contexts  = ['bookmark'];
  item.configKey = `context_${id}`;
  const groupedItem = {
    ...item,
    id:            `grouped:${id}`,
    parentId:      kROOT_BOOKMARK_ITEM,
    ungroupedItem: item
  };
  item.icons = manifest.icons;

  mBookmarkItems.push(item);

  mBookmarkItemsById[groupedItem.id] = groupedItem;
  mGroupedBookmarkItems.push(groupedItem);
}

const mBookmarkSeparator = {
  id:        `separatprBefore${kROOT_BOOKMARK_ITEM}`,
  type:      'separator',
  contexts:  ['bookmark'],
  viewTypes: ['sidebar'],
  documentUrlPatterns: [`moz-extension://${location.host}/*`],
  visible:   false,
  lastVisible: false
};
const mBookmarkRootItem = {
  id:       kROOT_BOOKMARK_ITEM,
  type:     'normal',
  contexts: ['bookmark'],
  title:    manifest.name,
  icons:    manifest.icons,
  visible:  false,
  lastVisible: false
};

const mAllBookmarkItems = [
  mBookmarkSeparator,
  mBookmarkRootItem,
  ...mBookmarkItems,
  ...mGroupedBookmarkItems
];

function addBookmarkItems() {
  const promises = [];
  if (addBookmarkItems.done) {
    for (const item of mAllBookmarkItems) {
      promises.push(browser.menus.remove(item.id));
    }
  }
  for (const item of mAllBookmarkItems) {
    promises.push(browser.menus.create(getSafeCreateParams(item)));
  }
  addBookmarkItems.done = true;
  return Promise.all(promises);
}
addBookmarkItems.done = false;


// Re-register items to put them after
// top level items added by other addons.
TabContextMenu.onTopLevelItemAdded.addListener(reserveToRefreshItems);

function reserveToRefreshItems() {
  if (reserveToRefreshItems.invoked)
    return;
  reserveToRefreshItems.invoked = true;
  setTimeout(() => { // because window.requestAnimationFrame is decelerate for an invisible document.
    reserveToRefreshItems.invoked = false;
    addTabItems();
    addBookmarkItems();
  }, 0);
}

function updateItem(id, params) {
  log('updateItem ', id, params);
  browser.menus.update(id, params).catch(ApiTabs.createErrorSuppressor());
  TabContextMenu.onMessageExternal({
    type:   TSTAPI.kCONTEXT_MENU_UPDATE,
    params: [id, params]
  }, browser.runtime);
}

function updateItemsVisibility(items, { forceVisible = null, multiselected = false, hasUnmutedTab = false, hasUnmutedDescendant = false, hasAutoplayBlockedTab = false, hasAutoplayBlockedDescendant = false, sticky = false, hidden = false } = {}) {
  log('updateItemsVisibility ', items, { forceVisible, multiselected, hasUnmutedTab, hasUnmutedDescendant, hasAutoplayBlockedTab, hasAutoplayBlockedDescendant, sticky });
  let updated = false;
  let visibleItemsCount = 0;
  let visibleNormalItemsCount = 0;
  let lastSeparator;
  for (const item of items) {
    if (item.type == 'separator') {
      if (lastSeparator) {
        if (lastSeparator.lastVisible) {
          updateItem(lastSeparator.id, { visible: false });
          lastSeparator.lastVisible = false;
          updated = true;
        }
      }
      lastSeparator = item;
    }
    else {
      const title = Commands.getMenuItemTitle(item, { multiselected, hasUnmutedTab, hasUnmutedDescendant, sticky });
      let visible = !hidden && (!(item.configKey in configs) || configs[item.configKey] || false);
      log('checking ', item.id, {
        config: visible,
        multiselected: item.hideOnMultiselected && multiselected,
        lastVisible: item.lastVisible,
        forceVisible,
      });
      if (forceVisible !== null && forceVisible !== undefined)
        visible = forceVisible;
      if ((item.hideOnMultiselected && multiselected) ||
          (item.requireAutoplayBlockedTab && !hasAutoplayBlockedTab) ||
          (item.requireAutoplayBlockedDescendant && !hasAutoplayBlockedDescendant))
        visible = false;
      if (visible) {
        if (lastSeparator) {
          updateItem(lastSeparator.id, { visible: visibleNormalItemsCount > 0 });
          lastSeparator.lastVisible = true;
          lastSeparator = null;
          updated = true;
          visibleNormalItemsCount = 0;
        }
        visibleNormalItemsCount++;
        visibleItemsCount++;
      }
      const updatedParams = {};
      if (visible !== item.lastVisible) {
        updatedParams.visible = visible;
        item.lastVisible = visible;
      }
      if (title !== item.lastTitle) {
        updatedParams.title = title;
        item.lastTitle = title;
      }
      if (Object.keys(updatedParams).length == 0)
        continue;
      updateItem(item.id, updatedParams);
      updated = true;
    }
  }
  if (lastSeparator && lastSeparator.lastVisible) {
    updateItem(lastSeparator.id, { visible: false });
    lastSeparator.lastVisible = false;
    updated = true;
  }
  return { updated, visibleItemsCount };
}

async function updateItems({ multiselected, hasUnmutedTab, hasUnmutedDescendant, hasAutoplayBlockedTab, hasAutoplayBlockedDescendant, sticky, hidden } = {}) {
  let updated = false;

  const groupedItems = updateItemsVisibility(mGroupedTabItems, { multiselected, hasUnmutedTab, hasUnmutedDescendant, hasAutoplayBlockedTab, hasAutoplayBlockedDescendant, sticky, hidden });
  if (groupedItems.updated)
    updated = true;

  const separatorVisible = !hidden && configs.emulateDefaultContextMenu && groupedItems.visibleItemsCount > 0;
  if (separatorVisible != mTabSeparator.lastVisible) {
    updateItem(mTabSeparator.id, { visible: separatorVisible });
    mTabSeparator.lastVisible = separatorVisible;
    updated = true;
  }

  const grouped = !hidden && configs.emulateDefaultContextMenu && groupedItems.visibleItemsCount > 1;
  if (grouped != mTabRootItem.lastVisible) {
    updateItem(mTabRootItem.id, { visible: grouped });
    mTabRootItem.lastVisible = grouped;
    updated = true;
  }

  const topLevelItems = updateItemsVisibility(mTabItems, { forceVisible: grouped ? false : null, multiselected, hasUnmutedTab, hasUnmutedDescendant, hasAutoplayBlockedTab, hasAutoplayBlockedDescendant, sticky, hidden });
  if (topLevelItems.updated)
    updated = true;

  if (mGroupedTabItemsById['grouped:sendTreeToDevice'].lastVisible &&
      await TabContextMenu.updateSendToDeviceItems('grouped:sendTreeToDevice', {
        manage: navigator.userAgent.includes('Fennec'), // see also https://github.com/piroor/treestyletab/issues/3174
      }))
    updated = true;

  return updated;
}

export function onClick(info, tab) {
  if (info.bookmarkId)
    return onBookmarkItemClick(info);
  else
    return onTabItemClick(info, tab);
}
browser.menus.onClicked.addListener(onClick);

function onTabItemClick(info, tab) {
  // Extra context menu commands won't be available on the blank area of the tab bar.
  if (!tab)
    return;

  log('context menu item clicked: ', info, tab);

  const contextTab = Tab.get(tab.id);
  const contextTabs = contextTab.$TST.multiselected ? Tab.getSelectedTabs(contextTab.windowId) : [contextTab];

  const itemId = info.menuItemId.replace(/^(?:grouped:|context_topLevel_)/, '');
  if (mTabItemsById[itemId] &&
      mTabItemsById[itemId].type == 'checkbox')
    mTabItemsById[itemId].checked = !mTabItemsById[itemId].checked;

  const inverted = info.button == 1;
  switch (itemId) {
    case 'reloadTree':
      if (inverted)
        Commands.reloadDescendants(contextTabs);
      else
        Commands.reloadTree(contextTabs);
      break;
    case 'reloadDescendants':
      if (inverted)
        Commands.reloadTree(contextTabs);
      else
        Commands.reloadDescendants(contextTabs);
      break;

    case 'toggleMuteTree':
      if (inverted)
        Commands.toggleMuteDescendants(contextTabs);
      else
        Commands.toggleMuteTree(contextTabs);
      break;
    case 'toggleMuteDescendants':
      if (inverted)
        Commands.toggleMuteTree(contextTabs);
      else
        Commands.toggleMuteDescendants(contextTabs);
      break;

    case 'closeTree':
      if (inverted)
        Commands.closeDescendants(contextTabs);
      else
        Commands.closeTree(contextTabs);
      break;
    case 'closeDescendants':
      if (inverted)
        Commands.closeTree(contextTabs);
      else
        Commands.closeDescendants(contextTabs);
      break;
    case 'closeOthers':
      Commands.closeOthers(contextTabs);
      break;

    case 'toggleSticky':
      Commands.toggleSticky(contextTabs, !contextTab.$TST.sticky);
      break;

    case 'collapseTree':
      Commands.collapseTree(contextTabs, { recursively: inverted });
      break;
    case 'collapseTreeRecursively':
      Commands.collapseTree(contextTabs, { recursively: !inverted });
      break;
    case 'collapseAll':
      Commands.collapseAll(contextTab.windowId);
      break;
    case 'expandTree':
      Commands.expandTree(contextTabs, { recursively: inverted });
      break;
    case 'expandTreeRecursively':
      Commands.expandTree(contextTabs, { recursively: !inverted });
      break;
    case 'expandAll':
      Commands.expandAll(contextTab.windowId);
      break;

    case 'bookmarkTree':
      Commands.bookmarkTree(contextTabs);
      break;

    case 'sendTreeToDevice:all':
      Sync.sendTabsToAllDevices(contextTabs, { recursively: true });
      break;

    case 'collapsed':
      if (info.wasChecked)
        Commands.expandTree(contextTab);
      else
        Commands.collapseTree(contextTab);
      break;
    case 'pinnedTab': {
      const tabs = Tab.getPinnedTabs(contextTab.windowId);
      if (tabs.length > 0)
        browser.tabs.update(tabs[0].id, { active: true })
          .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
    }; break;
    case 'unpinnedTab': {
      const tabs = Tab.getUnpinnedTabs(tab.windowId);
      if (tabs.length > 0)
        browser.tabs.update(tabs[0].id, { active: true })
          .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
    }; break;

    default: {
      const sendToDeviceMatch = info.menuItemId.match(/^sendTreeToDevice:device:(.+)$/);
      if (contextTab &&
          sendToDeviceMatch)
        Sync.sendTabsToDevice(
          contextTabs,
          { to: sendToDeviceMatch[1],
            recursively: true }
        );
    }; break;
  }
}
TabContextMenu.onTSTItemClick.addListener(onTabItemClick);

async function onBookmarkItemClick(info) {
  switch (info.menuItemId.replace(/^grouped:/, '')) {
    case 'openAllBookmarksWithStructure':
      Commands.openAllBookmarksWithStructure(info.bookmarkId, { recursively: false });
      break;

    case 'openAllBookmarksWithStructureRecursively':
      Commands.openAllBookmarksWithStructure(info.bookmarkId, { recursively: true });
      break;
  }
}

async function onShown(info, tab) {
  if (info.contexts.includes('tab'))
    await onTabContextMenuShown(info, tab);
  else if (info.contexts.includes('bookmark'))
    onBookmarkContextMenuShown(info);
}
browser.menus.onShown.addListener(onShown);

let mLastContextTabId = null;
async function onTabContextMenuShown(info, tab) {
  const contextTabId = tab && tab.id;
  mLastContextTabId = contextTabId;

  tab = tab && Tab.get(contextTabId);
  const multiselected = tab && tab.$TST.multiselected;
  const contextTabs      = multiselected ? Tab.getSelectedTabs(tab.windowId) : tab ? [tab] : [];
  const hasChild         = contextTabs.length > 0 && contextTabs.some(tab => tab.$TST.hasChild);
  const subtreeCollapsed = contextTabs.length > 0 && contextTabs.some(tab => tab.$TST.subtreeCollapsed);
  const grouped          = contextTabs.length > 0 && contextTabs.some(tab => tab.$TST.isGroupTab);
  const { hasUnmutedTab, hasUnmutedDescendant } = Commands.getUnmutedState(contextTabs);
  const { hasAutoplayBlockedTab, hasAutoplayBlockedDescendant } = Commands.getAutoplayBlockedState(contextTabs);

  let updated = await updateItems({
    multiselected,
    hasUnmutedTab,
    hasUnmutedDescendant,
    hasAutoplayBlockedTab,
    hasAutoplayBlockedDescendant,
    sticky: tab?.$TST.sticky,
    hidden: !configs.showTreeCommandsInTabsContextMenuGlobally && info.viewType != 'sidebar',
  });
  if (mLastContextTabId != contextTabId)
    return; // Skip further operations if the menu was already reopened on a different context tab.

  for (const item of mTabItems) {
    let newVisible;
    let newEnabled;
    if (item.id == 'sendTreeToDevice' &&
        item.visible) {
      newVisible = contextTabs.filter(Sync.isSendableTab).length > 0;
      newEnabled = (
        hasChild &&
        Sync.getOtherDevices().length > 0
      );
    }
    else if (item.requireTree) {
      newEnabled = hasChild;
      switch (item.id) {
        case 'collapseTree':
          if (subtreeCollapsed)
            newEnabled = false;
          break;
        case 'expandTree':
          if (!subtreeCollapsed)
            newEnabled = false;
          break;
      }
    }
    else if (item.requireMultiselected) {
      newEnabled = multiselected;
    }
    else if (item.requireGrouped) {
      newEnabled = grouped;
    }
    else if (item.requireNormal) {
      newEnabled = tab?.pinned;
    }
    else {
      continue;
    }

    if ((newVisible === undefined ||
         newVisible == !!item.visible) &&
        (newEnabled === undefined ||
         newEnabled == !!item.enabled))
      continue;

    const params = {};
    if (newVisible !== undefined &&
        newVisible != !!item.visible)
      params.visible = item.visible = !!newVisible;
    if (newEnabled !== undefined &&
        newEnabled != !!item.enabled)
      params.enabled = item.enabled = !!newEnabled;

    updateItem(item.id, params);
    updateItem(`grouped:${item.id}`, params);
    updated = true;
  }

  {
    const canExpand = hasChild && subtreeCollapsed;
    mTabItemsById.collapsed.checked = canExpand;
    const params = {
      checked: canExpand
    };
    updateItem('collapsed', params);
    updateItem(`grouped:collapsed`, params);
    updated = true;
  }

  if (updated)
    browser.menus.refresh().catch(ApiTabs.createErrorSuppressor());
}
TabContextMenu.onTSTTabContextMenuShown.addListener(onTabContextMenuShown);

let mLastContextItemId = null;
async function onBookmarkContextMenuShown(info) {
  const contextItemId = info.bookmarkId;
  mLastContextItemId = contextItemId;

  let isFolder = true;
  if (info.bookmarkId) {
    const item = await Bookmark.getItemById(info.bookmarkId);
    if (mLastContextItemId != contextItemId)
      return; // Skip further operations if the menu was already reopened on a different context item.
    isFolder = (
      item.type == 'folder' ||
      (item.type == 'bookmark' &&
       /^place:parent=([^&]+)$/.test(item.url))
    );
  }

  let visibleItemCount = 0;

  mBookmarkItemsById.openAllBookmarksWithStructure.visible = !!(
    isFolder &&
    configs[mBookmarkItemsById.openAllBookmarksWithStructure.configKey] &&
    ++visibleItemCount
  );
  mBookmarkItemsById.openAllBookmarksWithStructureRecursively.visible = !!(
    isFolder &&
    configs[mBookmarkItemsById.openAllBookmarksWithStructureRecursively.configKey] &&
    ++visibleItemCount
  );

  for (const item of mGroupedBookmarkItems) {
    item.visible = !!(
      visibleItemCount > 1 &&
      item.ungroupedItem.visible
    );
    if (item.visible)
      item.ungroupedItem.visible = false;
  }
  for (const item of [...mBookmarkItems, ...mGroupedBookmarkItems]) {
    browser.menus.update(item.id, {
      visible: !!item.visible,
    });
  }

  browser.menus.update(mBookmarkSeparator.id, {
    visible: visibleItemCount > 0
  });
  browser.menus.update(mBookmarkRootItem.id, {
    visible: visibleItemCount > 1
  });
  browser.menus.refresh().catch(ApiTabs.createErrorSuppressor());
}


export function getItemIdsWithIcon() {
  return [
    kROOT_TAB_ITEM,
    kROOT_BOOKMARK_ITEM,
    ...Object.keys(mBookmarkItemsById),
  ];
}
