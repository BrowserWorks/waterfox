/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import EventListenerManager from '/extlib/EventListenerManager.js';

import {
  log as internalLogger,
  mapAndFilter,
  configs,
  sanitizeForHTMLText
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from '/common/constants.js';
import * as ContextualIdentities from '/common/contextual-identities.js';
import * as Sync from '/common/sync.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TreeBehavior from '/common/tree-behavior.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';

import * as Commands from './commands.js';
import * as TabsOpen from './tabs-open.js';

function log(...args) {
  internalLogger('background/tab-context-menu', ...args);
}

export const onTSTItemClick = new EventListenerManager();
export const onTSTTabContextMenuShown = new EventListenerManager();
export const onTSTTabContextMenuHidden = new EventListenerManager();
export const onTopLevelItemAdded = new EventListenerManager();

const EXTERNAL_TOP_LEVEL_ITEM_MATCHER = /^external-top-level-item:([^:]+):(.+)$/;
function getExternalTopLevelItemId(ownerId, itemId) {
  return `external-top-level-item:${ownerId}:${itemId}`;
}

const SAFE_MENU_PROPERTIES = [
  'checked',
  'enabled',
  'icons',
  'parentId',
  'title',
  'type',
  'visible'
];

const mItemsById = {
  'context_newTab': {
    title: browser.i18n.getMessage('tabContextMenu_newTab_label'),
  },
  'context_separator:afterNewTab': {
    type: 'separator'
  },
  'context_reloadTab': {
    title:              browser.i18n.getMessage('tabContextMenu_reload_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_reload_label_multiselected')
  },
  'context_topLevel_reloadTree': {
    title:              browser.i18n.getMessage('context_reloadTree_label'),
    titleMultiselected: browser.i18n.getMessage('context_reloadTree_label_multiselected')
  },
  'context_topLevel_reloadDescendants': {
    title:              browser.i18n.getMessage('context_reloadDescendants_label'),
    titleMultiselected: browser.i18n.getMessage('context_reloadDescendants_label_multiselected')
  },
  // This item won't be handled by the onClicked handler, so you may need to handle it with something experiments API.
  'context_unblockAutoplay': {
    title:              browser.i18n.getMessage('tabContextMenu_unblockAutoplay_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_unblockAutoplay_label_multiselected')
  },
  // This item won't be handled by the onClicked handler, so you may need to handle it with something experiments API.
  'context_topLevel_unblockAutoplayTree': {
    title:                browser.i18n.getMessage('context_unblockAutoplayTree_label'),
    titleMultiselected:   browser.i18n.getMessage('context_unblockAutoplayTree_label_multiselected'),
  },
  // This item won't be handled by the onClicked handler, so you may need to handle it with something experiments API.
  'context_topLevel_unblockAutoplayDescendants': {
    title:                browser.i18n.getMessage('context_unblockAutoplayDescendants_label'),
    titleMultiselected:   browser.i18n.getMessage('context_unblockAutoplayDescendants_label_multiselected'),
  },
  'context_toggleMuteTab': {
    titleMute:                browser.i18n.getMessage('tabContextMenu_mute_label'),
    titleUnmute:              browser.i18n.getMessage('tabContextMenu_unmute_label'),
    titleMultiselectedMute:   browser.i18n.getMessage('tabContextMenu_mute_label_multiselected'),
    titleMultiselectedUnmute: browser.i18n.getMessage('tabContextMenu_unmute_label_multiselected')
  },
  'context_topLevel_toggleMuteTree': {
    titleMuteTree:                browser.i18n.getMessage('context_toggleMuteTree_label_mute'),
    titleMultiselectedMuteTree:   browser.i18n.getMessage('context_toggleMuteTree_label_multiselected_mute'),
    titleUnmuteTree:              browser.i18n.getMessage('context_toggleMuteTree_label_unmute'),
    titleMultiselectedUnmuteTree: browser.i18n.getMessage('context_toggleMuteTree_label_multiselected_unmute')
  },
  'context_topLevel_toggleMuteDescendants': {
    titleMuteDescendant:                browser.i18n.getMessage('context_toggleMuteDescendants_label_mute'),
    titleMultiselectedMuteDescendant:   browser.i18n.getMessage('context_toggleMuteDescendants_label_multiselected_mute'),
    titleUnmuteDescendant:              browser.i18n.getMessage('context_toggleMuteDescendants_label_unmute'),
    titleMultiselectedUnmuteDescendant: browser.i18n.getMessage('context_toggleMuteDescendants_label_multiselected_unmute')
  },
  'context_pinTab': {
    title:              browser.i18n.getMessage('tabContextMenu_pin_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_pin_label_multiselected')
  },
  'context_unpinTab': {
    title:              browser.i18n.getMessage('tabContextMenu_unpin_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_unpin_label_multiselected')
  },
  'context_topLevel_toggleSticky': {
    titleStick:                browser.i18n.getMessage('context_toggleSticky_label_stick'),
    titleMultiselectedStick:   browser.i18n.getMessage('context_toggleSticky_label_multiselected_stick'),
    titleUnstick:              browser.i18n.getMessage('context_toggleSticky_label_unstick'),
    titleMultiselectedUnstick: browser.i18n.getMessage('context_toggleSticky_label_multiselected_unstick')
  },
  'context_duplicateTab': {
    title:              browser.i18n.getMessage('tabContextMenu_duplicate_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_duplicate_label_multiselected')
  },
  'context_separator:afterDuplicate': {
    type: 'separator'
  },
  'context_bookmarkTab': {
    title:              browser.i18n.getMessage('tabContextMenu_bookmark_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_bookmark_label_multiselected')
  },
  'context_topLevel_bookmarkTree': {
    title:              browser.i18n.getMessage('context_bookmarkTree_label'),
    titleMultiselected: browser.i18n.getMessage('context_bookmarkTree_label_multiselected')
  },
  'context_moveTab': {
    title:              browser.i18n.getMessage('tabContextMenu_moveTab_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_moveTab_label_multiselected')
  },
  'context_moveTabToStart': {
    parentId: 'context_moveTab',
    title:    browser.i18n.getMessage('tabContextMenu_moveTabToStart_label')
  },
  'context_moveTabToEnd': {
    parentId: 'context_moveTab',
    title:    browser.i18n.getMessage('tabContextMenu_moveTabToEnd_label')
  },
  'context_openTabInWindow': {
    parentId: 'context_moveTab',
    title:    browser.i18n.getMessage('tabContextMenu_tearOff_label')
  },
  'context_shareTabURL': {
    title: browser.i18n.getMessage('tabContextMenu_shareTabURL_label'),
  },
  'context_sendTabsToDevice': {
    title:              browser.i18n.getMessage('tabContextMenu_sendTabsToDevice_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_sendTabsToDevice_label_multiselected')
  },
  'context_topLevel_sendTreeToDevice': {
    title:              browser.i18n.getMessage('context_sendTreeToDevice_label'),
    titleMultiselected: browser.i18n.getMessage('context_sendTreeToDevice_label_multiselected')
  },
  'context_reopenInContainer': {
    title: browser.i18n.getMessage('tabContextMenu_reopenInContainer_label')
  },
  'context_selectAllTabs': {
    title: browser.i18n.getMessage('tabContextMenu_selectAllTabs_label')
  },
  'context_separator:afterSelectAllTabs': {
    type: 'separator'
  },
  'context_topLevel_collapseTree': {
    title:              browser.i18n.getMessage('context_collapseTree_label'),
    titleMultiselected: browser.i18n.getMessage('context_collapseTree_label_multiselected')
  },
  'context_topLevel_collapseTreeRecursively': {
    title:              browser.i18n.getMessage('context_collapseTreeRecursively_label'),
    titleMultiselected: browser.i18n.getMessage('context_collapseTreeRecursively_label_multiselected')
  },
  'context_topLevel_collapseAll': {
    title: browser.i18n.getMessage('context_collapseAll_label')
  },
  'context_topLevel_expandTree': {
    title:              browser.i18n.getMessage('context_expandTree_label'),
    titleMultiselected: browser.i18n.getMessage('context_expandTree_label_multiselected')
  },
  'context_topLevel_expandTreeRecursively': {
    title:              browser.i18n.getMessage('context_expandTreeRecursively_label'),
    titleMultiselected: browser.i18n.getMessage('context_expandTreeRecursively_label_multiselected')
  },
  'context_topLevel_expandAll': {
    title: browser.i18n.getMessage('context_expandAll_label')
  },
  'context_separator:afterCollapseExpand': {
    type: 'separator'
  },
  'context_closeTab': {
    title:              browser.i18n.getMessage('tabContextMenu_close_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_close_label_multiselected')
  },
  'context_closeMultipleTabs': {
    title: browser.i18n.getMessage('tabContextMenu_closeMultipleTabs_label')
  },
  'context_closeTabsToTheStart': {
    parentId: 'context_closeMultipleTabs',
    title: browser.i18n.getMessage('tabContextMenu_closeTabsToTop_label')
  },
  'context_closeTabsToTheEnd': {
    parentId: 'context_closeMultipleTabs',
    title: browser.i18n.getMessage('tabContextMenu_closeTabsToBottom_label')
  },
  'context_closeOtherTabs': {
    parentId: 'context_closeMultipleTabs',
    title: browser.i18n.getMessage('tabContextMenu_closeOther_label')
  },
  'context_topLevel_closeTree': {
    title:              browser.i18n.getMessage('context_closeTree_label'),
    titleMultiselected: browser.i18n.getMessage('context_closeTree_label_multiselected')
  },
  'context_topLevel_closeDescendants': {
    title:              browser.i18n.getMessage('context_closeDescendants_label'),
    titleMultiselected: browser.i18n.getMessage('context_closeDescendants_label_multiselected')
  },
  'context_topLevel_closeOthers': {
    title:              browser.i18n.getMessage('context_closeOthers_label'),
    titleMultiselected: browser.i18n.getMessage('context_closeOthers_label_multiselected')
  },
  'context_undoCloseTab': {
    title: browser.i18n.getMessage('tabContextMenu_undoClose_label'),
    titleRegular: browser.i18n.getMessage('tabContextMenu_undoClose_label'),
    titleMultipleTabsRestorable: browser.i18n.getMessage('tabContextMenu_undoClose_label_multiple')
  },
  'context_separator:afterClose': {
    type: 'separator'
  },

  'noContextTab:context_reloadTab': {
    title:              browser.i18n.getMessage('tabContextMenu_reloadSelected_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_reloadSelected_label_multiselected'),
  },
  'noContextTab:context_bookmarkSelected': {
    title:              browser.i18n.getMessage('tabContextMenu_bookmarkSelected_label'),
    titleMultiselected: browser.i18n.getMessage('tabContextMenu_bookmarkSelected_label_multiselected'),
  },
  'noContextTab:context_selectAllTabs': {
    title: browser.i18n.getMessage('tabContextMenu_selectAllTabs_label')
  },
  'noContextTab:context_undoCloseTab': {
    title: browser.i18n.getMessage('tabContextMenu_undoClose_label')
  },

  'lastSeparatorBeforeExtraItems': {
    type:     'separator',
    fakeMenu: true
  }
};

const mExtraItems = new Map();

const SIDEBAR_URL_PATTERN = [`${Constants.kSHORTHAND_URIS.tabbar}*`];

let mInitialized = false;

browser.runtime.onMessage.addListener(onMessage);
browser.menus.onShown.addListener(onShown);
browser.menus.onHidden.addListener(onHidden);
browser.menus.onClicked.addListener(onClick);
TSTAPI.onMessageExternal.addListener(onMessageExternal);

function getItemPlacementSignature(item) {
  if (item.placementSignature)
    return item.placementSignature;
  return item.placementSignature = JSON.stringify({
    parentId: item.parentId
  });
}
export async function init() {
  mInitialized = true;

  window.addEventListener('unload', () => {
    browser.runtime.onMessage.removeListener(onMessage);
    TSTAPI.onMessageExternal.removeListener(onMessageExternal);
  }, { once: true });

  const itemIds = Object.keys(mItemsById);
  for (const id of itemIds) {
    const item = mItemsById[id];
    item.id          = id;
    item.lastTitle   = item.title;
    item.lastVisible = false;
    item.lastEnabled = true;
    if (item.type == 'separator') {
      let beforeSeparator = true;
      item.precedingItems = [];
      item.followingItems = [];
      for (const id of itemIds) {
        const possibleSibling = mItemsById[id];
        if (getItemPlacementSignature(item) != getItemPlacementSignature(possibleSibling)) {
          if (beforeSeparator)
            continue;
          else
            break;
        }
        if (id == item.id) {
          beforeSeparator = false;
          continue;
        }
        if (beforeSeparator) {
          if (possibleSibling.type == 'separator') {
            item.previousSeparator = possibleSibling;
            item.precedingItems = [];
          }
          else {
            item.precedingItems.push(id);
          }
        }
        else {
          if (possibleSibling.type == 'separator')
            break;
          else
            item.followingItems.push(id);
        }
      }
    }
    const info = {
      id,
      title:    item.title,
      type:     item.type || 'normal',
      contexts: ['tab'],
      viewTypes: ['sidebar', 'tab', 'popup'],
      visible:  false, // hide all by default
      documentUrlPatterns: SIDEBAR_URL_PATTERN
    };
    if (item.parentId)
      info.parentId = item.parentId;
    if (!item.fakeMenu)
      browser.menus.create(info);
    onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_CREATE,
      params: info
    }, browser.runtime);
  }
  onTSTItemClick.addListener(onClick);

  await ContextualIdentities.init();
  updateContextualIdentities();
  ContextualIdentities.onUpdated.addListener(() => {
    updateContextualIdentities();
  });
}


// Workaround for https://github.com/piroor/treestyletab/issues/3423
// Firefox does not provide any API to access to the sharing service of the platform.
// We need to provide it as experiments API or something way.
// This module is designed to work with a service which has features:
//   * async listServices(tab)
//     - Returns an array of sharing services on macOS.
//     - Retruned array should have 0 or more items like:
//       { name:  "service name",
//         title: "title for a menu item",
//         image: "icon image (maybe data: URI)" }
//   * share(tab, shareName = null)
//     - Returns nothing.
//     - Shares the specified tab with the specified service.
//       The second argument is optional because it is required only on macOS.
//   * openPreferences()
//     - Returns nothing.
//     - Opens preferences of sharing services on macOS.

let mSharingService = null;

export function registerSharingService(service) {
  mSharingService = service;
}


let mMultipleTabsRestorable = false;
Tab.onChangeMultipleTabsRestorability.addListener(multipleTabsRestorable => {
  mMultipleTabsRestorable = multipleTabsRestorable;
});

const mContextualIdentityItems = new Set();
function updateContextualIdentities() {
  for (const item of mContextualIdentityItems) {
    const id = item.id;
    if (id in mItemsById)
      delete mItemsById[id];
    browser.menus.remove(id).catch(ApiTabs.createErrorSuppressor());
    onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_REMOVE,
      params: id
    }, browser.runtime);
  }
  mContextualIdentityItems.clear();

  const defaultItem = {
    parentId:  'context_reopenInContainer',
    id:        'context_reopenInContainer:firefox-default',
    title:     browser.i18n.getMessage('tabContextMenu_reopenInContainer_noContainer_label'),
    contexts:  ['tab'],
    viewTypes: ['sidebar', 'tab', 'popup'],
    documentUrlPatterns: SIDEBAR_URL_PATTERN
  };
  browser.menus.create(defaultItem);
  onMessageExternal({
    type: TSTAPI.kCONTEXT_MENU_CREATE,
    params: defaultItem
  }, browser.runtime);
  mContextualIdentityItems.add(defaultItem);

  const defaultSeparator = {
    parentId:  'context_reopenInContainer',
    id:        'context_reopenInContainer_separator',
    type:      'separator',
    contexts:  ['tab'],
    viewTypes: ['sidebar', 'tab', 'popup'],
    documentUrlPatterns: SIDEBAR_URL_PATTERN
  };
  browser.menus.create(defaultSeparator);
  onMessageExternal({
    type: TSTAPI.kCONTEXT_MENU_CREATE,
    params: defaultSeparator
  }, browser.runtime);
  mContextualIdentityItems.add(defaultSeparator);

  ContextualIdentities.forEach(identity => {
    const id = `context_reopenInContainer:${identity.cookieStoreId}`;
    const item = {
      parentId: 'context_reopenInContainer',
      id:       id,
      title:    identity.name.replace(/^([a-z0-9])/i, '&$1'),
      contexts: ['tab'],
      viewTypes: ['sidebar', 'tab', 'popup'],
      documentUrlPatterns: SIDEBAR_URL_PATTERN
    };
    if (identity.iconUrl)
      item.icons = { 16: identity.iconUrl };
    browser.menus.create(item);
    onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_CREATE,
      params: item
    }, browser.runtime);
    mContextualIdentityItems.add(item);
  });
  for (const item of mContextualIdentityItems) {
    mItemsById[item.id] = item;
    item.lastVisible = true;
    item.lastEnabled = true;
  }
}

const mLastDevicesSignature = new Map();
const mSendToDeviceItems    = new Map();
export async function updateSendToDeviceItems(parentId, { manage } = {}) {
  const devices = await Sync.getOtherDevices();
  const signature = JSON.stringify(devices.map(device => ({ id: device.id, name: device.name })));
  if (signature == mLastDevicesSignature.get(parentId))
    return false;

  mLastDevicesSignature.set(parentId, signature);

  const items = mSendToDeviceItems.get(parentId) || new Set();
  for (const item of items) {
    const id = item.id;
    browser.menus.remove(id).catch(ApiTabs.createErrorSuppressor());
    onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_REMOVE,
      params: id
    }, browser.runtime);
  }
  items.clear();

  const baseParams = {
    parentId,
    contexts:            ['tab'],
    viewTypes:           ['sidebar', 'tab', 'popup'],
    documentUrlPatterns: SIDEBAR_URL_PATTERN
  };

  if (devices.length > 0) {
    for (const device of devices) {
      const item = {
        ...baseParams,
        type:  'normal',
        id:    `${parentId}:device:${device.id}`,
        title: device.name
      };
      if (device.icon)
        item.icons = {
          '16': `/resources/icons/${sanitizeForHTMLText(device.icon)}.svg`
        };
      browser.menus.create(item);
      onMessageExternal({
        type: TSTAPI.kCONTEXT_MENU_CREATE,
        params: item
      }, browser.runtime);
      items.add(item);
    }

    const separator = {
      ...baseParams,
      type: 'separator',
      id:   `${parentId}:separator`
    };
    browser.menus.create(separator);
    onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_CREATE,
      params: separator
    }, browser.runtime);
    items.add(separator);

    const sendToAllItem = {
      ...baseParams,
      type:  'normal',
      id:    `${parentId}:all`,
      title: browser.i18n.getMessage('tabContextMenu_sendTabsToAllDevices_label')
    };
    browser.menus.create(sendToAllItem);
    onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_CREATE,
      params: sendToAllItem
    }, browser.runtime);
    items.add(sendToAllItem);
  }

  if (manage) {
    const manageItem = {
      ...baseParams,
      type:  'normal',
      id:    `${parentId}:manage`,
      title: browser.i18n.getMessage('tabContextMenu_manageSyncDevices_label')
    };
    browser.menus.create(manageItem);
    onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_CREATE,
      params: manageItem
    }, browser.runtime);
    items.add(manageItem);
  }

  mSendToDeviceItems.set(parentId, items);
  return true;
}

const mLastSharingServicesSignature = new Map();
const mShareItems                   = new Map();
async function updateSharingServiceItems(parentId, contextTab) {
  if (!mSharingService ||
      !contextTab)
    return false;

  const services = await mSharingService.listServices(contextTab);
  const signature = JSON.stringify(services);
  if (signature == mLastSharingServicesSignature.get(parentId))
    return false;

  mLastSharingServicesSignature.set(parentId, signature);

  const items = mShareItems.get(parentId) || new Set();
  for (const item of items) {
    const id = item.id;
    browser.menus.remove(id).catch(ApiTabs.createErrorSuppressor());
    onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_REMOVE,
      params: id
    }, browser.runtime);
  }
  items.clear();

  const baseParams = {
    parentId,
    contexts:            ['tab'],
    viewTypes:           ['sidebar', 'tab', 'popup'],
    documentUrlPatterns: SIDEBAR_URL_PATTERN
  };

  if (services.length > 0) {
    for (const service of services) {
      const item = {
        ...baseParams,
        type:  'normal',
        id:    `${parentId}:service:${service.name}`,
        title: service.title,
      };
      if (service.image)
        item.icons = {
          '16': service.image,
        };
      browser.menus.create(item);
      onMessageExternal({
        type: TSTAPI.kCONTEXT_MENU_CREATE,
        params: item,
      }, browser.runtime);
      items.add(item);
    }

    const separator = {
      ...baseParams,
      type: 'separator',
      id:   `${parentId}:separator`,
    };
    browser.menus.create(separator);
    onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_CREATE,
      params: separator,
    }, browser.runtime);
    items.add(separator);

    const moreItem = {
      ...baseParams,
      type:  'normal',
      id:    `${parentId}:more`,
      title: browser.i18n.getMessage('tabContextMenu_shareTabURL_more_label'),
      icons: {
        '16': '/resources/icons/more-horiz-16.svg',
      },
    };
    browser.menus.create(moreItem);
    onMessageExternal({
      type: TSTAPI.kCONTEXT_MENU_CREATE,
      params: moreItem,
    }, browser.runtime);
    items.add(moreItem);
  }

  mShareItems.set(parentId, items);
  return true;
}


function updateItem(id, state = {}) {
  let modified = false;
  const item = mItemsById[id];
  const updateInfo = {
    visible: 'visible' in state ? !!state.visible : true,
    enabled: 'enabled' in state ? !!state.enabled : true
  };
  if ('checked' in state)
    updateInfo.checked = state.checked;
  const title = String(state.title || (state.multiselected && item.titleMultiselected) || item.title).replace(/%S/g, state.count || 0);
  if (title) {
    updateInfo.title = title;
    modified = title != item.lastTitle;
    item.lastTitle = updateInfo.title;
  }
  if (!modified)
    modified = updateInfo.visible != item.lastVisible ||
                 updateInfo.enabled != item.lastEnabled;
  item.lastVisible = updateInfo.visible;
  item.lastEnabled = updateInfo.enabled;
  browser.menus.update(id, updateInfo).catch(ApiTabs.createErrorSuppressor());
  onMessageExternal({
    type: TSTAPI.kCONTEXT_MENU_UPDATE,
    params: [id, updateInfo]
  }, browser.runtime);
  return modified;
}

function updateSeparator(id, options = {}) {
  const item = mItemsById[id];
  const visible = (
    (options.hasVisiblePreceding ||
     hasVisiblePrecedingItem(item)) &&
    (options.hasVisibleFollowing ||
     item.followingItems.some(id => mItemsById[id].type != 'separator' && mItemsById[id].lastVisible))
  );
  return updateItem(id, { visible });
}
function hasVisiblePrecedingItem(separator) {
  return (
    separator.precedingItems.some(id => mItemsById[id].type != 'separator' && mItemsById[id].lastVisible) ||
    (separator.previousSeparator &&
     !separator.previousSeparator.lastVisible &&
     hasVisiblePrecedingItem(separator.previousSeparator))
  );
}

let mOverriddenContext = null;
let mLastContextTabId = null;

async function onShown(info, contextTab) {
  if (!mInitialized)
    return;

  const contextTabId = contextTab && contextTab.id;
  mLastContextTabId = contextTabId;
  try {
    contextTab = contextTab && Tab.get(contextTabId);

    const windowId              = contextTab ? contextTab.windowId : (await browser.windows.getLastFocused({}).catch(ApiTabs.createErrorHandler())).id;
    if (mLastContextTabId != contextTabId)
      return; // Skip further operations if the menu was already reopened on a different context tab.
    const previousTab           = contextTab && contextTab.$TST.previousTab;
    const previousSiblingTab    = contextTab && contextTab.$TST.previousSiblingTab;
    const nextTab               = contextTab && contextTab.$TST.nextTab;
    const nextSiblingTab        = contextTab && contextTab.$TST.nextSiblingTab;
    const hasMultipleTabs       = Tab.hasMultipleTabs(windowId);
    const hasMultipleNormalTabs = Tab.hasMultipleTabs(windowId, { normal: true });
    const multiselected         = contextTab && contextTab.$TST.multiselected;
    const contextTabs           = multiselected ?
      Tab.getSelectedTabs(windowId) :
      contextTab ?
        [contextTab] :
        [];
    const hasChild              = contextTab && contextTabs.some(tab => tab.$TST.hasChild);
    const { hasUnmutedTab, hasUnmutedDescendant } = Commands.getUnmutedState(contextTabs);
    const { hasAutoplayBlockedTab, hasAutoplayBlockedDescendant } = Commands.getAutoplayBlockedState(contextTabs);

    if (mOverriddenContext)
      return onOverriddenMenuShown(info, contextTab, windowId);

    let modifiedItemsCount = cleanupOverriddenMenu();

    // ESLint reports "short circuit" error for following codes.
    //   https://eslint.org/docs/rules/no-unused-expressions#allowshortcircuit
    // To allow those usages, I disable the rule temporarily.
    /* eslint-disable no-unused-expressions */

    const emulate = configs.emulateDefaultContextMenu;

    updateItem('context_newTab', {
      visible: emulate,
    }) && modifiedItemsCount++;
    updateItem('context_separator:afterNewTab', {
      visible: emulate,
    }) && modifiedItemsCount++;

    updateItem('context_reloadTab', {
      visible: emulate && !!contextTab,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_reloadTree', {
      visible: emulate && !!contextTab && configs.context_topLevel_reloadTree,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_reloadDescendants', {
      visible: emulate && !!contextTab && configs.context_topLevel_reloadDescendants,
      enabled: hasChild,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_unblockAutoplay', {
      visible: emulate && contextTab?.$TST.autoplayBlocked,
      multiselected,
      title: contextTab && Commands.getMenuItemTitle(mItemsById.context_unblockAutoplay, {
        multiselected,
      }),
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_unblockAutoplayTree', {
      visible: emulate && hasChild && hasAutoplayBlockedTab && configs.context_topLevel_unblockAutoplayTree,
      multiselected,
      title: contextTab && Commands.getMenuItemTitle(mItemsById.context_topLevel_unblockAutoplayTree, {
        multiselected,
      }),
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_unblockAutoplayDescendants', {
      visible: emulate && hasChild && hasAutoplayBlockedDescendant && configs.context_topLevel_unblockAutoplayDescendants,
      multiselected,
      title: contextTab && Commands.getMenuItemTitle(mItemsById.context_topLevel_unblockAutoplayDescendants, {
        multiselected,
      }),
    }) && modifiedItemsCount++;
    updateItem('context_toggleMuteTab', {
      visible: emulate && !!contextTab,
      multiselected,
      title: contextTab && Commands.getMenuItemTitle(mItemsById.context_toggleMuteTab, {
        multiselected,
        unmuted: (!contextTab.mutedInfo || !contextTab.mutedInfo.muted),
      }),
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_toggleMuteTree', {
      visible: emulate && !!contextTab && configs.context_topLevel_toggleMuteTree,
      enabled: hasChild,
      multiselected,
      title: Commands.getMenuItemTitle(mItemsById.context_topLevel_toggleMuteTree, { multiselected, hasUnmutedTab, hasUnmutedDescendant }),
      hasUnmutedTab,
      hasUnmutedDescendant,
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_toggleMuteDescendants', {
      visible: emulate && !!contextTab && configs.context_topLevel_toggleMuteDescendants,
      enabled: hasChild,
      multiselected,
      title: Commands.getMenuItemTitle(mItemsById.context_topLevel_toggleMuteDescendants, { multiselected, hasUnmutedTab, hasUnmutedDescendant }),
      hasUnmutedTab,
      hasUnmutedDescendant,
    }) && modifiedItemsCount++;
    updateItem('context_pinTab', {
      visible: emulate && !!contextTab && !contextTab.pinned,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_unpinTab', {
      visible: emulate && !!contextTab && contextTab.pinned,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_toggleSticky', {
      visible: emulate && !!contextTab,
      enabled: contextTab && !contextTab.pinned,
      multiselected,
      title: contextTab && Commands.getMenuItemTitle(mItemsById.context_topLevel_toggleSticky, {
        multiselected,
        sticky: contextTab?.$TST.sticky,
      }),
    }) && modifiedItemsCount++;
    updateItem('context_duplicateTab', {
      visible: emulate && !!contextTab,
      multiselected
    }) && modifiedItemsCount++;

    updateItem('context_bookmarkTab', {
      visible: emulate && !!contextTab,
      multiselected: multiselected || !contextTab
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_bookmarkTree', {
      visible: emulate && !!contextTab && configs.context_topLevel_bookmarkTree,
      multiselected
    }) && modifiedItemsCount++;

    updateItem('context_moveTab', {
      visible: emulate && !!contextTab,
      enabled: contextTab && hasMultipleTabs,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_moveTabToStart', {
      enabled: emulate && !!contextTab && hasMultipleTabs && (previousSiblingTab || previousTab) && ((previousSiblingTab || previousTab).pinned == contextTab.pinned),
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_moveTabToEnd', {
      enabled: emulate && !!contextTab && hasMultipleTabs && (nextSiblingTab || nextTab) && ((nextSiblingTab || nextTab).pinned == contextTab.pinned),
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_openTabInWindow', {
      enabled: emulate && !!contextTab && hasMultipleTabs,
      multiselected
    }) && modifiedItemsCount++;

    // Not implemented yet as a built-in. See also: https://github.com/piroor/treestyletab/issues/3423
    updateItem('context_shareTabURL', {
      visible: emulate && !!contextTab && mSharingService && Sync.isSendableTab(contextTab),
    }) && modifiedItemsCount++;

    updateItem('context_sendTabsToDevice', {
      visible: emulate && !!contextTab && contextTabs.filter(Sync.isSendableTab).length > 0,
      multiselected,
      count: contextTabs.length
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_sendTreeToDevice', {
      visible: emulate && !!contextTab && contextTabs.filter(Sync.isSendableTab).length > 0 && configs.context_topLevel_sendTreeToDevice && hasChild,
      enabled: hasChild,
      multiselected
    }) && modifiedItemsCount++;

    let showContextualIdentities = false;
    if (contextTab && !contextTab.incognito) {
      for (const item of mContextualIdentityItems.values()) {
        const id = item.id;
        let visible;
        if (!emulate)
          visible = false;
        else if (id == 'context_reopenInContainer_separator')
          visible = !!contextTab && contextTab.cookieStoreId != 'firefox-default';
        else
          visible = !!contextTab && id != `context_reopenInContainer:${contextTab.cookieStoreId}`;
        updateItem(id, { visible }) && modifiedItemsCount++;
        if (visible)
          showContextualIdentities = true;
      }
    }
    updateItem('context_reopenInContainer', {
      visible: emulate && !!contextTab && showContextualIdentities && !contextTab.incognito,
      enabled: contextTabs.every(tab => TabsOpen.isOpenable(tab.url)),
      multiselected
    }) && modifiedItemsCount++;

    updateItem('context_selectAllTabs', {
      visible: emulate && !!contextTab,
      enabled: contextTab && Tab.getSelectedTabs(windowId).length != Tab.getVisibleTabs(windowId).length,
      multiselected
    }) && modifiedItemsCount++;

    updateItem('context_topLevel_collapseTree', {
      visible: emulate && !!contextTab && configs.context_topLevel_collapseTree,
      enabled: hasChild,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_collapseTreeRecursively', {
      visible: emulate && !!contextTab && configs.context_topLevel_collapseTreeRecursively,
      enabled: hasChild,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_collapseAll', {
      visible: emulate && !multiselected && !!contextTab && configs.context_topLevel_collapseAll
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_expandTree', {
      visible: emulate && !!contextTab && configs.context_topLevel_expandTree,
      enabled: hasChild,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_expandTreeRecursively', {
      visible: emulate && !!contextTab && configs.context_topLevel_expandTreeRecursively,
      enabled: hasChild,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_expandAll', {
      visible: emulate && !multiselected && !!contextTab && configs.context_topLevel_expandAll
    }) && modifiedItemsCount++;

    updateItem('context_closeTab', {
      visible: emulate && !!contextTab,
      multiselected
    }) && modifiedItemsCount++;

    updateItem('context_closeMultipleTabs', {
      visible: emulate && !!contextTab,
      enabled: hasMultipleNormalTabs,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_closeTabsToTheStart', {
      visible: emulate && !!contextTab,
      enabled: nextTab,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_closeTabsToTheEnd', {
      visible: emulate && !!contextTab,
      enabled: nextTab,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_closeOtherTabs', {
      visible: emulate && !!contextTab,
      enabled: hasMultipleNormalTabs,
      multiselected
    }) && modifiedItemsCount++;

    updateItem('context_topLevel_closeTree', {
      visible: emulate && !!contextTab && configs.context_topLevel_closeTree,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_closeDescendants', {
      visible: emulate && !!contextTab && configs.context_topLevel_closeDescendants,
      enabled: hasChild,
      multiselected
    }) && modifiedItemsCount++;
    updateItem('context_topLevel_closeOthers', {
      visible: emulate && !!contextTab && configs.context_topLevel_closeOthers,
      multiselected
    }) && modifiedItemsCount++;

    const undoCloseTabLabel = mItemsById.context_undoCloseTab[configs.undoMultipleTabsClose && mMultipleTabsRestorable ? 'titleMultipleTabsRestorable' : 'titleRegular'];
    updateItem('context_undoCloseTab', {
      title:   undoCloseTabLabel,
      visible: emulate && !!contextTab,
      multiselected
    }) && modifiedItemsCount++;

    updateItem('noContextTab:context_reloadTab', {
      visible: emulate && !contextTab
    }) && modifiedItemsCount++;
    updateItem('noContextTab:context_bookmarkSelected', {
      visible: emulate && !contextTab
    }) && modifiedItemsCount++;
    updateItem('noContextTab:context_selectAllTabs', {
      visible: emulate && !contextTab,
      enabled: !contextTab && Tab.getSelectedTabs(windowId).length != Tab.getVisibleTabs(windowId).length
    }) && modifiedItemsCount++;
    updateItem('noContextTab:context_undoCloseTab', {
      title:   undoCloseTabLabel,
      visible: emulate && !contextTab
    }) && modifiedItemsCount++;

    updateSeparator('context_separator:afterDuplicate') && modifiedItemsCount++;
    updateSeparator('context_separator:afterSelectAllTabs') && modifiedItemsCount++;
    updateSeparator('context_separator:afterCollapseExpand') && modifiedItemsCount++;
    updateSeparator('context_separator:afterClose') && modifiedItemsCount++;

    const flattenExtraItems = Array.from(mExtraItems.values()).flat();

    updateSeparator('lastSeparatorBeforeExtraItems', {
      hasVisibleFollowing: contextTab && flattenExtraItems.some(item => !item.parentId && item.visible !== false)
    }) && modifiedItemsCount++;

    // these items should be updated at the last to reduce flicking of showing context menu
    await Promise.all([
      updateSendToDeviceItems('context_sendTabsToDevice', { manage: true }),
      mItemsById.context_topLevel_sendTreeToDevice.lastVisible && updateSendToDeviceItems('context_topLevel_sendTreeToDevice'),
      modifiedItemsCount > 0 && browser.menus.refresh().catch(ApiTabs.createErrorSuppressor()).then(_ => false),
      updateSharingServiceItems('context_shareTabURL', contextTab),
    ]).then(results => {
      modifiedItemsCount = 0;
      for (const modified of results) {
        if (modified)
          modifiedItemsCount++;
      }
    });
    if (mLastContextTabId != contextTabId)
      return; // Skip further operations if the menu was already reopened on a different context tab.

    /* eslint-enable no-unused-expressions */

    if (modifiedItemsCount > 0)
      browser.menus.refresh().catch(ApiTabs.createErrorSuppressor());
  }
  catch(error) {
    console.error(error);
  }
}

let mLastOverriddenContextOwner = null;

function onOverriddenMenuShown(info, contextTab, windowId) {
  if (!mLastOverriddenContextOwner) {
    for (const itemId of Object.keys(mItemsById)) {
      if (!mItemsById[itemId].lastVisible)
        continue;
      mItemsById[itemId].lastVisible = false;
      browser.menus.update(itemId, { visible: false });
    }
    mLastOverriddenContextOwner = mOverriddenContext.owner;
  }

  for (const item of (mExtraItems.get(mLastOverriddenContextOwner) || [])) {
    if (item.$topLevel &&
        item.lastVisible) {
      browser.menus.update(
        getExternalTopLevelItemId(mOverriddenContext.owner, item.id),
        { visible: true }
      );
    }
  }

  const cache = {};
  const message = {
    type: TSTAPI.kCONTEXT_MENU_SHOWN,
    info: {
      bookmarkId:    info.bookmarkId || null,
      button:        info.button,
      checked:       info.checked,
      contexts:      contextTab ? ['tab'] : info.bookmarkId ? ['bookmark'] : [],
      editable:      false,
      frameId:       null,
      frameUrl:      null,
      linkText:      null,
      linkUrl:       null,
      mediaType:     null,
      menuIds:       [],
      menuItemId:    null,
      modifiers:     [],
      pageUrl:       null,
      parentMenuItemId: null,
      selectionText: null,
      srcUrl:        null,
      targetElementId: null,
      viewType:      'sidebar',
      wasChecked:    false
    },
    tab: contextTab,
    windowId
  }
  TSTAPI.broadcastMessage(message, {
    targets: [mOverriddenContext.owner],
    tabProperties: ['tab'],
    isContextTab: true,
    cache,
  });
  TSTAPI.broadcastMessage({
    ...message,
    type: TSTAPI.kFAKE_CONTEXT_MENU_SHOWN
  }, {
    targets: [mOverriddenContext.owner],
    tabProperties: ['tab']
  });

  reserveRefresh();
}

function cleanupOverriddenMenu() {
  if (!mLastOverriddenContextOwner)
    return 0;

  let modifiedItemsCount = 0;

  const owner = mLastOverriddenContextOwner;
  mLastOverriddenContextOwner = null;

  for (const itemId of Object.keys(mItemsById)) {
    if (!mItemsById[itemId].lastVisible)
      continue;
    mItemsById[itemId].lastVisible = true;
    browser.menus.update(itemId, { visible: true });
    modifiedItemsCount++;
  }

  for (const item of (mExtraItems.get(owner) || [])) {
    if (item.$topLevel &&
        item.lastVisible) {
      browser.menus.update(
        getExternalTopLevelItemId(owner, item.id),
        { visible: false }
      );
      modifiedItemsCount++;
    }
  }

  return modifiedItemsCount;
}

function onHidden() {
  if (!mInitialized)
    return;

  const owner = mOverriddenContext && mOverriddenContext.owner;
  const windowId = mOverriddenContext && mOverriddenContext.windowId;
  if (mLastOverriddenContextOwner &&
      owner == mLastOverriddenContextOwner) {
    mOverriddenContext = null;
    TSTAPI.broadcastMessage({
      type: TSTAPI.kCONTEXT_MENU_HIDDEN,
      windowId
    }, {
      targets: [owner]
    });
    TSTAPI.broadcastMessage({
      type: TSTAPI.kFAKE_CONTEXT_MENU_HIDDEN,
      windowId
    }, {
      targets: [owner]
    });
  }
}

async function onClick(info, contextTab) {
  if (!mInitialized)
    return;

  contextTab = contextTab && Tab.get(contextTab.id);
  const win       = await browser.windows.getLastFocused({ populate: true }).catch(ApiTabs.createErrorHandler());
  const windowId  = contextTab && contextTab.windowId || win.id;
  const activeTab = TabsStore.activeTabInWindow.get(windowId);

  let multiselectedTabs = Tab.getSelectedTabs(windowId);
  const isMultiselected = contextTab ? contextTab.$TST.multiselected : multiselectedTabs.length > 1;
  if (!isMultiselected)
    multiselectedTabs = null;

  switch (info.menuItemId.replace(/^noContextTab:/, '')) {
    case 'context_newTab': {
      const behavior = info.button == 1 ?
        configs.autoAttachOnNewTabButtonMiddleClick :
        (info.modifiers && (info.modifiers.includes('Ctrl') || info.modifiers.includes('Command'))) ?
          configs.autoAttachOnNewTabButtonAccelClick :
          contextTab ?
            configs.autoAttachOnContextNewTabCommand :
            configs.autoAttachOnNewTabCommand;
      Commands.openNewTabAs({
        baseTab: contextTab || activeTab,
        as:      behavior,
      });
    }; break;

    case 'context_reloadTab':
      if (multiselectedTabs) {
        for (const tab of multiselectedTabs) {
          browser.tabs.reload(tab.id)
            .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
        }
      }
      else {
        const tab = contextTab || activeTab;
        browser.tabs.reload(tab.id)
          .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
      }
      break;
    case 'context_toggleMuteTab': {
      const tab = contextTab || activeTab;
      const unmuted = !tab.mutedInfo || !tab.mutedInfo.muted;
      if (multiselectedTabs) {
        for (const tab of multiselectedTabs) {
          browser.tabs.update(tab.id, { muted: unmuted })
            .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
        }
      }
      else {
        browser.tabs.update(contextTab.id, { muted: unmuted })
          .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
      }
    }; break;
    case 'context_pinTab':
      if (multiselectedTabs) {
        for (const tab of multiselectedTabs) {
          browser.tabs.update(tab.id, { pinned: true })
            .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
        }
      }
      else {
        browser.tabs.update(contextTab.id, { pinned: true })
          .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
      }
      break;
    case 'context_unpinTab':
      if (multiselectedTabs) {
        for (const tab of multiselectedTabs) {
          browser.tabs.update(tab.id, { pinned: false })
            .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
        }
      }
      else {
        browser.tabs.update(contextTab.id, { pinned: false })
          .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
      }
      break;
    case 'context_toggleSticky':
      Commands.toggleSticky(multiselectedTabs, !(contextTab || activeTab).$TST.sticky);
      break;
    case 'context_duplicateTab':
      Commands.duplicateTab(contextTab, {
        destinationWindowId: windowId
      });
      break;
    case 'context_moveTabToStart':
      Commands.moveTabToStart(contextTab);
      break;
    case 'context_moveTabToEnd':
      Commands.moveTabToEnd(contextTab);
      break;
    case 'context_openTabInWindow':
      Commands.openTabInWindow(contextTab, { withTree: true });
      break;
    case 'context_shareTabURL':
      if (mSharingService)
        mSharingService.share(contextTab);
      break;
    case 'context_shareTabURL:more':
      if (mSharingService)
        mSharingService.openPreferences();
      break;
    case 'context_sendTabsToDevice:all':
      Sync.sendTabsToAllDevices(multiselectedTabs || [contextTab]);
      break;
    case 'context_sendTabsToDevice:manage':
      Sync.manageDevices(windowId);
      break;
    case 'context_topLevel_sendTreeToDevice:all':
      Sync.sendTabsToAllDevices(multiselectedTabs || [contextTab], { recursively: true });
      break;
    case 'context_selectAllTabs': {
      const tabs = await browser.tabs.query({ windowId }).catch(ApiTabs.createErrorHandler());
      TabsInternalOperation.highlightTabs(
        [activeTab].concat(mapAndFilter(tabs, tab => !tab.active ? tab : undefined))
      ).catch(ApiTabs.createErrorSuppressor());
    }; break;
    case 'context_bookmarkTab':
      Commands.bookmarkTab(contextTab);
      break;
    case 'context_bookmarkSelected':
      Commands.bookmarkTab(contextTab || activeTab);
      break;
    case 'context_closeTabsToTheStart': {
      const tabs = await browser.tabs.query({ windowId }).catch(ApiTabs.createErrorHandler());
      const closeTabs = [];
      const keptTabIds = new Set(
        multiselectedTabs ?
          multiselectedTabs.map(tab => tab.id) :
          [contextTab.id]
      );
      for (const tab of tabs) {
        if (keptTabIds.has(tab.id))
          break;
        if (!tab.pinned && !tab.hidden)
          closeTabs.push(Tab.get(tab.id));
      }
      const canceled = (await browser.runtime.sendMessage({
        type: Constants.kCOMMAND_NOTIFY_TABS_CLOSING,
        tabs: closeTabs.map(tab => tab.$TST.sanitized),
        windowId
      }).catch(ApiTabs.createErrorHandler())) === false;
      if (canceled)
        break;
      TabsInternalOperation.removeTabs(closeTabs);
    }; break;
    case 'context_closeTabsToTheEnd': {
      const tabs = await browser.tabs.query({ windowId }).catch(ApiTabs.createErrorHandler());
      tabs.reverse();
      const closeTabs = [];
      const keptTabIds = new Set(
        (multiselectedTabs ?
          multiselectedTabs :
          [contextTab]
        ).reduce((tabIds, tab, _index) => {
          if (tab.$TST.subtreeCollapsed)
            tabIds.push(tab.id, ...tab.$TST.descendants.map(tab => tab.id))
          else
            tabIds.push(tab.id);
          return tabIds;
        }, [])
      );
      for (const tab of tabs) {
        if (keptTabIds.has(tab.id))
          break;
        if (!tab.pinned && !tab.hidden)
          closeTabs.push(Tab.get(tab.id));
      }
      closeTabs.reverse();
      const canceled = (await browser.runtime.sendMessage({
        type: Constants.kCOMMAND_NOTIFY_TABS_CLOSING,
        tabs: closeTabs.map(tab => tab.$TST.sanitized),
        windowId
      }).catch(ApiTabs.createErrorHandler())) === false;
      if (canceled)
        break;
      TabsInternalOperation.removeTabs(closeTabs);
    }; break;
    case 'context_closeOtherTabs': {
      const tabs  = await browser.tabs.query({ windowId }).catch(ApiTabs.createErrorHandler());
      const keptTabIds = new Set(
        (multiselectedTabs ?
          multiselectedTabs :
          [contextTab]
        ).reduce((tabIds, tab, _index) => {
          if (tab.$TST.subtreeCollapsed)
            tabIds.push(tab.id, ...tab.$TST.descendants.map(tab => tab.id))
          else
            tabIds.push(tab.id);
          return tabIds;
        }, [])
      );
      const closeTabs = mapAndFilter(tabs,
                                     tab => !tab.pinned && !tab.hidden && !keptTabIds.has(tab.id) && Tab.get(tab.id) || undefined);
      const canceled = (await browser.runtime.sendMessage({
        type: Constants.kCOMMAND_NOTIFY_TABS_CLOSING,
        tabs: closeTabs.map(tab => tab.$TST.sanitized),
        windowId
      }).catch(ApiTabs.createErrorHandler())) === false;
      if (canceled)
        break;
      TabsInternalOperation.removeTabs(closeTabs);
    }; break;
    case 'context_undoCloseTab': {
      const sessions = await browser.sessions.getRecentlyClosed({ maxResults: 1 }).catch(ApiTabs.createErrorHandler());
      if (sessions.length && sessions[0].tab)
        browser.sessions.restore(sessions[0].tab.sessionId).catch(ApiTabs.createErrorSuppressor());
    }; break;
    case 'context_closeTab': {
      const closeTabs = (multiselectedTabs || TreeBehavior.getClosingTabsFromParent(contextTab, {
        byInternalOperation: true
      })).reverse(); // close down to top, to keep tree structure of Tree Style Tab
      const canceled = (await browser.runtime.sendMessage({
        type: Constants.kCOMMAND_NOTIFY_TABS_CLOSING,
        tabs: closeTabs.map(tab => tab.$TST.sanitized),
        windowId
      }).catch(ApiTabs.createErrorHandler())) === false;
      if (canceled)
        return;
      TabsInternalOperation.removeTabs(closeTabs);
    }; break;

    default: {
      const contextualIdentityMatch = info.menuItemId.match(/^context_reopenInContainer:(.+)$/);
      if (contextTab &&
          contextualIdentityMatch)
        Commands.reopenInContainer(contextTab, contextualIdentityMatch[1]);

      const shareTabsMatch = info.menuItemId.match(/^context_shareTabURL:service:(.+)$/);
      if (mSharingService &&
          contextTab &&
          shareTabsMatch)
        mSharingService.share(contextTab, shareTabsMatch[1]);

      const sendTabsToDeviceMatch = info.menuItemId.match(/^context_sendTabsToDevice:device:(.+)$/);
      if (contextTab &&
          sendTabsToDeviceMatch)
        Sync.sendTabsToDevice(
          multiselectedTabs || [contextTab],
          { to: sendTabsToDeviceMatch[1] }
        );
      const sendTreeToDeviceMatch = info.menuItemId.match(/^context_topLevel_sendTreeToDevice:device:(.+)$/);
      if (contextTab &&
          sendTreeToDeviceMatch)
        Sync.sendTabsToDevice(
          multiselectedTabs || [contextTab],
          { to: sendTreeToDeviceMatch[1],
            recursively: true }
        );

      if (EXTERNAL_TOP_LEVEL_ITEM_MATCHER.test(info.menuItemId)) {
        const owner      = RegExp.$1;
        const menuItemId = RegExp.$2;
        const message = {
          type: TSTAPI.kCONTEXT_MENU_CLICK,
          info: {
            bookmarkId:    info.bookmarkId || null,
            button:        info.button,
            checked:       info.checked,
            editable:      false,
            frameId:       null,
            frameUrl:      null,
            linkText:      null,
            linkUrl:       null,
            mediaType:     null,
            menuItemId,
            modifiers:     [],
            pageUrl:       null,
            parentMenuItemId: null,
            selectionText: null,
            srcUrl:        null,
            targetElementId: null,
            viewType:      'sidebar',
            wasChecked:    info.wasChecked
          },
          tab: contextTab,
        };
        if (owner == browser.runtime.id) {
          browser.runtime.sendMessage(message).catch(ApiTabs.createErrorSuppressor());
        }
        else {
          const cache = {};
          TSTAPI.sendMessage(
            owner,
            message,
            { tabProperties: ['tab'], cache, isContextTab: true }
          ).catch(ApiTabs.createErrorSuppressor());
          TSTAPI.sendMessage(
            owner,
            {
              ...message,
              type: TSTAPI.kFAKE_CONTEXT_MENU_CLICK
            },
            { tabProperties: ['tab'], cache, isContextTab: true }
          ).catch(ApiTabs.createErrorSuppressor());
        }
      }
    }; break;
  }
}


function getItemsFor(addonId) {
  if (mExtraItems.has(addonId)) {
    return mExtraItems.get(addonId);
  }
  const items = [];
  mExtraItems.set(addonId, items);
  return items;
}

function exportExtraItems() {
  const exported = {};
  for (const [id, items] of mExtraItems.entries()) {
    exported[id] = items;
  }
  return exported;
}

async function notifyUpdated() {
  await browser.runtime.sendMessage({
    type:  Constants.kCOMMAND_NOTIFY_CONTEXT_MENU_UPDATED,
    items: exportExtraItems()
  }).catch(ApiTabs.createErrorSuppressor());
}

let mReservedNotifyUpdate;
let mNotifyUpdatedHandlers = [];

function reserveNotifyUpdated() {
  return new Promise((resolve, _aReject) => {
    mNotifyUpdatedHandlers.push(resolve);
    if (mReservedNotifyUpdate)
      clearTimeout(mReservedNotifyUpdate);
    mReservedNotifyUpdate = setTimeout(async () => {
      mReservedNotifyUpdate = undefined;
      await notifyUpdated();
      const handlers = mNotifyUpdatedHandlers;
      mNotifyUpdatedHandlers = [];
      for (const handler of handlers) {
        handler();
      }
    }, 10);
  });
}

function reserveRefresh() {
  if (reserveRefresh.reserved)
    clearTimeout(reserveRefresh.reserved);
  reserveRefresh.reserved = setTimeout(() => {
    reserveRefresh.reserved = null;;
    browser.menus.refresh();
  }, 0);
}

function onMessage(message, _sender) {
  if (!mInitialized)
    return;

  log('tab-context-menu: internally called:', message);
  switch (message.type) {
    case Constants.kCOMMAND_GET_CONTEXT_MENU_ITEMS:
      return Promise.resolve(exportExtraItems());

    case TSTAPI.kCONTEXT_MENU_CLICK:
      onTSTItemClick.dispatch(message.info, message.tab);
      return;

    case TSTAPI.kCONTEXT_MENU_SHOWN:
      onShown(message.info, message.tab);
      onTSTTabContextMenuShown.dispatch(message.info, message.tab);
      return;

    case TSTAPI.kCONTEXT_MENU_HIDDEN:
      onTSTTabContextMenuHidden.dispatch();
      return;

    case Constants.kCOMMAND_NOTIFY_CONTEXT_ITEM_CHECKED_STATUS_CHANGED:
      for (const itemData of mExtraItems.get(message.ownerId)) {
        if (!itemData.id != message.id)
          continue;
        itemData.checked = message.checked;
        break;
      }
      return;

    case Constants.kCOMMAND_NOTIFY_CONTEXT_OVERRIDDEN:
      mOverriddenContext = message.context || null;
      if (mOverriddenContext) {
        mOverriddenContext.owner = message.owner;
        mOverriddenContext.windowId = message.windowId;
      }
      break;

    // For optimization we update the context menu before the menu is actually opened if possible, to reduce visual flickings.
    // But this optimization does not work as expected on environments which shows the context menu with mousedown, like macOS.
    case TSTAPI.kNOTIFY_TAB_MOUSEDOWN:
      if (message.button == 2) {
        onShown(
          message,
          message.tab,
        );
        onTSTTabContextMenuShown.dispatch(message, message.tab);
      }
      break;
  }
}

export function onMessageExternal(message, sender) {
  if (!mInitialized)
    return;

  switch (message.type) {
    case TSTAPI.kCONTEXT_MENU_CREATE:
    case TSTAPI.kFAKE_CONTEXT_MENU_CREATE: {
      log('TSTAPI.kCONTEXT_MENU_CREATE:', message, { id: sender.id, url: sender.url });
      const items  = getItemsFor(sender.id);
      let params = message.params;
      if (Array.isArray(params))
        params = params[0];
      const parent = params.parentId && items.filter(item => item.id == params.parentId)[0];
      if (params.parentId && !parent)
        break;
      let shouldAdd = true;
      if (params.id) {
        for (let i = 0, maxi = items.length; i < maxi; i++) {
          const item = items[i];
          if (item.id != params.id)
            continue;
          items.splice(i, 1, params);
          shouldAdd = false;
          break;
        }
      }
      if (shouldAdd) {
        items.push(params);
        if (parent && params.id) {
          parent.children = parent.children || [];
          parent.children.push(params.id);
        }
      }
      mExtraItems.set(sender.id, items);
      params.$topLevel = (
        Array.isArray(params.viewTypes) &&
        params.viewTypes.includes('sidebar')
      );
      if (sender.id != browser.runtime.id &&
          params.$topLevel) {
        params.lastVisible = params.visible !== false;
        const visible = !!(
          params.lastVisible &&
          mOverriddenContext &&
          mLastOverriddenContextOwner == sender.id
        );
        const createParams = {
          id:        getExternalTopLevelItemId(sender.id, params.id),
          type:      params.type || 'normal',
          visible,
          viewTypes: ['sidebar', 'tab', 'popup'],
          contexts:  (params.contexts || []).filter(context => context == 'tab' || context == 'bookmark'),
          documentUrlPatterns: SIDEBAR_URL_PATTERN
        };
        if (params.parentId)
          createParams.parentId = getExternalTopLevelItemId(sender.id, params.parentId);
        for (const property of SAFE_MENU_PROPERTIES) {
          if (property in params)
            createParams[property] = params[property];
        }
        browser.menus.create(createParams);
        reserveRefresh();
        onTopLevelItemAdded.dispatch();
      }
      return reserveNotifyUpdated();
    }; break;

    case TSTAPI.kCONTEXT_MENU_UPDATE:
    case TSTAPI.kFAKE_CONTEXT_MENU_UPDATE: {
      log('TSTAPI.kCONTEXT_MENU_UPDATE:', message, { id: sender.id, url: sender.url });
      const items = getItemsFor(sender.id);
      for (let i = 0, maxi = items.length; i < maxi; i++) {
        const item = items[i];
        if (item.id != message.params[0])
          continue;
        const params = message.params[1];
        const updateProperties = {};
        for (const property of SAFE_MENU_PROPERTIES) {
          if (property in params)
            updateProperties[property] = params[property];
        }
        if (sender.id != browser.runtime.id &&
            item.$topLevel) {
          if ('visible' in updateProperties)
            item.lastVisible = updateProperties.visible;
          if (!mOverriddenContext ||
              mLastOverriddenContextOwner != sender.id)
            delete updateProperties.visible;
        }
        items.splice(i, 1, {
          ...item,
          ...updateProperties
        });
        if (sender.id != browser.runtime.id &&
            item.$topLevel &&
            Object.keys(updateProperties).length > 0) {
          browser.menus.update(
            getExternalTopLevelItemId(sender.id, item.id),
            updateProperties
          );
          reserveRefresh()
        }
        break;
      }
      mExtraItems.set(sender.id, items);
      return reserveNotifyUpdated();
    }; break;

    case TSTAPI.kCONTEXT_MENU_REMOVE:
    case TSTAPI.kFAKE_CONTEXT_MENU_REMOVE: {
      log('TSTAPI.kCONTEXT_MENU_REMOVE:', message, { id: sender.id, url: sender.url });
      let items = getItemsFor(sender.id);
      let id    = message.params;
      if (Array.isArray(id))
        id = id[0];
      const item   = items.filter(item => item.id == id)[0];
      if (!item)
        break;
      const parent = item.parentId && items.filter(item => item.id == item.parentId)[0];
      items = items.filter(item => item.id != id);
      mExtraItems.set(sender.id, items);
      if (parent && parent.children)
        parent.children = parent.children.filter(childId => childId != id);
      if (item.children) {
        for (const childId of item.children) {
          onMessageExternal({ type: message.type, params: childId }, sender);
        }
      }
      if (sender.id != browser.runtime.id &&
          item.$topLevel) {
        browser.menus.remove(getExternalTopLevelItemId(sender.id, item.id));
        reserveRefresh();
      }
      return reserveNotifyUpdated();
    }; break;

    case TSTAPI.kCONTEXT_MENU_REMOVE_ALL:
    case TSTAPI.kFAKE_CONTEXT_MENU_REMOVE_ALL:
    case TSTAPI.kUNREGISTER_SELF: {
      delete mExtraItems.delete(sender.id);
      return reserveNotifyUpdated();
    }; break;
  }
}
