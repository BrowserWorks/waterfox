/* ***** BEGIN LICENSE BLOCK ***** 
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is the Tree Style Tab.
 *
 * The Initial Developer of the Original Code is YUKI "Piro" Hiroshi.
 * Portions created by the Initial Developer are Copyright (C) 2011-2024
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s): YUKI "Piro" Hiroshi <piro.outsider.reflex@gmail.com>
 *                 wanabe <https://github.com/wanabe>
 *                 Tetsuharu OHZEKI <https://github.com/saneyuki>
 *                 Xidorn Quan <https://github.com/upsuper> (Firefox 40+ support)
 *                 lv7777 (https://github.com/lv7777)
 *
 * ***** END LICENSE BLOCK ******/
'use strict';

import {
  log as internalLogger,
  dumpTab,
  wait,
  mapAndFilter
} from './common.js';

import * as Constants from './constants.js';
import * as ContextualIdentities from './contextual-identities.js';
import * as SidebarConnection from './sidebar-connection.js';
import * as TabsStore from './tabs-store.js';

import Tab from './Tab.js';

function log(...args) {
  internalLogger('common/tabs-update', ...args);
}


const mBufferedUpdates = new Map();

function getBufferedUpdate(tab) {
  const update = mBufferedUpdates.get(tab.id) || {
    windowId: tab.windowId,
    tabId:    tab.id,
    attributes: {
      updated: {},
      added:   {},
      removed: new Set(),
    },
    isGroupTab:   false,
    updatedTitle: undefined,
    updatedLabel: undefined,
    favIconUrl:   undefined,
    loadingState: undefined,
    loadingStateReallyChanged: undefined,
    pinned:       undefined,
    hidden:       undefined,
    soundStateChanged: false,
  };
  mBufferedUpdates.set(tab.id, update);
  return update;
}

function flushBufferedUpdates() {
  if (!Constants.IS_BACKGROUND) {
    mBufferedUpdates.clear();
    return;
  }

  const triedAt = `${Date.now()}-${parseInt(Math.random() * 65000)}`;
  flushBufferedUpdates.triedAt = triedAt;
  (Constants.IS_BACKGROUND ?
    setTimeout : // because window.requestAnimationFrame is decelerate for an invisible document.
    window.requestAnimationFrame)(() => {
    if (flushBufferedUpdates.triedAt != triedAt)
      return;
    for (const update of mBufferedUpdates.values()) {
      // no need to notify attributes broadcasted via Tab.broadcastState()
      delete update.attributes.updated.highlighted;
      delete update.attributes.updated.hidden;
      delete update.attributes.updated.pinned;
      delete update.attributes.updated.audible;
      delete update.attributes.updated.mutedInfo;
      delete update.attributes.updated.sharingState;
      delete update.attributes.updated.incognito;
      delete update.attributes.updated.attention;
      delete update.attributes.updated.discarded;
      if (Object.keys(update.attributes.updated).length > 0 ||
          Object.keys(update.attributes.added).length > 0 ||
          update.attributes.removed.size > 0 ||
          update.soundStateChanged ||
          update.sharingStateChanged)
        SidebarConnection.sendMessage({
          type:              Constants.kCOMMAND_NOTIFY_TAB_UPDATED,
          windowId:          update.windowId,
          tabId:             update.tabId,
          updatedProperties: update.attributes.updated,
          addedAttributes:   update.attributes.added,
          removedAttributes: [...update.attributes.removed],
          soundStateChanged: update.soundStateChanged,
          sharingStateChanged: update.sharingStateChanged,
        });

      // SidebarConnection.sendMessage() has its own bulk-send mechanism,
      // so we don't need to bundle them like an array.
      if (update.isGroupTab)
        SidebarConnection.sendMessage({
          type:     Constants.kCOMMAND_NOTIFY_GROUP_TAB_DETECTED,
          windowId: update.windowId,
          tabId:    update.tabId,
        });
      if (update.updatedTitle !== undefined)
        SidebarConnection.sendMessage({
          type:     Constants.kCOMMAND_NOTIFY_TAB_LABEL_UPDATED,
          windowId: update.windowId,
          tabId:    update.tabId,
          title:    update.updatedTitle,
          label:    update.updatedLabel,
        });
      if (update.favIconUrl !== undefined)
        SidebarConnection.sendMessage({
          type:       Constants.kCOMMAND_NOTIFY_TAB_FAVICON_UPDATED,
          windowId:   update.windowId,
          tabId:      update.tabId,
          favIconUrl: update.favIconUrl,
        });
      if (update.loadingState !== undefined)
        SidebarConnection.sendMessage({
          type:     Constants.kCOMMAND_UPDATE_LOADING_STATE,
          windowId: update.windowId,
          tabId:    update.tabId,
          status:   update.loadingState,
          reallyChanged: update.loadingStateReallyChanged,
        });
      if (update.pinned !== undefined)
        SidebarConnection.sendMessage({
          type:     update.pinned ? Constants.kCOMMAND_NOTIFY_TAB_PINNED : Constants.kCOMMAND_NOTIFY_TAB_UNPINNED,
          windowId: update.windowId,
          tabId:    update.tabId,
        });
      if (update.hidden !== undefined)
        SidebarConnection.sendMessage({
          type:     update.hidden ? Constants.kCOMMAND_NOTIFY_TAB_HIDDEN : Constants.kCOMMAND_NOTIFY_TAB_SHOWN,
          windowId: update.windowId,
          tabId:    update.tabId,
        });
    }
    mBufferedUpdates.clear();
  }, 0);
}

export function updateTab(tab, newState = {}, options = {}) {
  const update = getBufferedUpdate(tab);
  const oldState = options.old || {};

  if ('url' in newState) {
    tab.$TST.setAttribute(Constants.kCURRENT_URI, update.attributes.added[Constants.kCURRENT_URI] = newState.url);
    update.attributes.removed.delete(Constants.kCURRENT_URI);
  }

  if ('url' in newState &&
      newState.url.indexOf(Constants.kGROUP_TAB_URI) == 0) {
    tab.$TST.addState(Constants.kTAB_STATE_GROUP_TAB, { permanently: true });
    update.isGroupTab = true;
    Tab.onGroupTabDetected.dispatch(tab);
  }
  else if (tab.$TST.states.has(Constants.kTAB_STATE_GROUP_TAB) &&
           !tab.$TST.hasGroupTabURL) {
    tab.$TST.removeState(Constants.kTAB_STATE_GROUP_TAB, { permanently: true });
    update.isGroupTab = false;
  }

  if (options.forceApply ||
      ('title' in newState &&
       newState.title != oldState.title)) {
    if (options.forceApply) {
      tab.$TST.getPermanentStates().then(states => {
        tab.$TST.toggleState(
          Constants.kTAB_STATE_UNREAD,
          (states.includes(Constants.kTAB_STATE_UNREAD) &&
           !tab.$TST.isGroupTab),
          { permanently: true }
        );
      });
    }
    else if (tab.$TST.isGroupTab) {
      tab.$TST.removeState(Constants.kTAB_STATE_UNREAD, { permanently: true });
    }
    else if (!tab.active) {
      tab.$TST.addState(Constants.kTAB_STATE_UNREAD, { permanently: true });
    }
    tab.$TST.label = newState.title;
    Tab.onLabelUpdated.dispatch(tab);
    update.updatedTitle = tab.title;
    update.updatedLabel = tab.$TST.label;
  }

  const openerOfGroupTab = tab.$TST.isGroupTab && Tab.getOpenerFromGroupTab(tab);
  if (openerOfGroupTab &&
      openerOfGroupTab.favIconUrl) {
    update.favIconUrl = openerOfGroupTab.favIconUrl;
  }
  else if (options.forceApply ||
           'favIconUrl' in newState) {
    tab.$TST.setAttribute(Constants.kCURRENT_FAVICON_URI, update.attributes.added[Constants.kCURRENT_FAVICON_URI] = tab.favIconUrl);
    update.attributes.removed.delete(Constants.kCURRENT_FAVICON_URI);
    // "favIconUrl" will be "undefined" if the website has no favicon.
    // Keys with "undefined" value will be removed from JSON-stringified result,
    // so we need to use "null" instead of it.
    // See also: https://github.com/piroor/treestyletab/issues/3515
    update.favIconUrl = tab.favIconUrl || null;
  }
  else if (tab.$TST.isGroupTab) {
    // "about:ws-group" can set error icon for the favicon and
    // reloading doesn't cloear that, so we need to clear favIconUrl manually.
    tab.favIconUrl = null;
    delete update.attributes.added[Constants.kCURRENT_FAVICON_URI];
    update.attributes.removed.add(Constants.kCURRENT_URI);
    tab.$TST.removeAttribute(Constants.kCURRENT_FAVICON_URI);
    update.favIconUrl = null;
  }

  if ('status' in newState) {
    const reallyChanged = !tab.$TST.states.has(newState.status);
    const removed = newState.status == 'loading' ? 'complete' : 'loading';
    tab.$TST.removeState(removed);
    tab.$TST.addState(newState.status);
    if (!options.forceApply) {
      update.loadingState = tab.status;
      update.loadingStateReallyChanged = reallyChanged;
    }
  }

  if ((options.forceApply ||
       'pinned' in newState) &&
      newState.pinned != tab.$TST.states.has(Constants.kTAB_STATE_PINNED)) {
    if (newState.pinned) {
      tab.$TST.addState(Constants.kTAB_STATE_PINNED);
      tab.$TST.removeAttribute(Constants.kLEVEL); // don't indent pinned tabs!
      delete update.attributes.added[Constants.kLEVEL];
      update.attributes.removed.add(Constants.kLEVEL);
      Tab.onPinned.dispatch(tab);
      update.pinned = true;
    }
    else {
      tab.$TST.removeState(Constants.kTAB_STATE_PINNED);
      Tab.onUnpinned.dispatch(tab);
      update.pinned = false;
    }
  }

  if (options.forceApply ||
      'audible' in newState)
    tab.$TST.toggleState(Constants.kTAB_STATE_AUDIBLE, newState.audible);

  let soundStateChanged = false;

  if (options.forceApply ||
      'mutedInfo' in newState) {
    soundStateChanged = true;
    const muted = newState.mutedInfo && newState.mutedInfo.muted;
    tab.$TST.toggleState(Constants.kTAB_STATE_MUTED, muted, newState.audible);
    Tab.onMutedStateChanged.dispatch(tab, muted);
  }

  if (options.forceApply ||
      soundStateChanged ||
      'audible' in newState) {
    soundStateChanged = true;
    tab.$TST.toggleState(
      Constants.kTAB_STATE_SOUND_PLAYING,
      (tab.audible &&
       !tab.mutedInfo.muted)
    );
  }

  if (soundStateChanged) {
    const parent = tab.$TST.parent;
    if (parent)
      parent.$TST.inheritSoundStateFromChildren();
  }

  let sharingStateChanged = false;
  if (options.forceApply ||
      'sharingState' in newState) {
    sharingStateChanged = true;
    const sharingCamera     = newState.sharingState && newState.sharingState.camera;
    const sharingMicrophone = newState.sharingState && newState.sharingState.microphone;
    const sharingScreen     = newState.sharingState && !!newState.sharingState.screen;
    tab.$TST.toggleState(Constants.kTAB_STATE_SHARING_CAMERA,     sharingCamera);
    tab.$TST.toggleState(Constants.kTAB_STATE_SHARING_MICROPHONE, sharingMicrophone);
    tab.$TST.toggleState(Constants.kTAB_STATE_SHARING_SCREEN,     sharingScreen);
    Tab.onSharingStateChanged.dispatch(tab, {
      camera:     sharingCamera,
      microphone: sharingMicrophone,
      screen:     sharingScreen,
    });
    const parent = tab.$TST.parent;
    if (parent)
      parent.$TST.inheritSharingStateFromChildren();
  }

  if (options.forceApply ||
      'cookieStoreId' in newState) {
    for (const state of tab.$TST.states) {
      if (String(state).startsWith('contextual-identity-'))
        tab.$TST.removeState(state);
    }
    if (newState.cookieStoreId) {
      const state = `contextual-identity-${newState.cookieStoreId}`;
      tab.$TST.addState(state);
      const identity = ContextualIdentities.get(newState.cookieStoreId);
      if (identity)
        tab.$TST.setAttribute(Constants.kCONTEXTUAL_IDENTITY_NAME, identity.name);
      else
        tab.$TST.removeAttribute(Constants.kCONTEXTUAL_IDENTITY_NAME);
    }
    else {
      tab.$TST.removeAttribute(Constants.kCONTEXTUAL_IDENTITY_NAME);
    }
  }

  if (options.forceApply ||
      'incognito' in newState)
    tab.$TST.toggleState(Constants.kTAB_STATE_PRIVATE_BROWSING, newState.incognito);

  if (options.forceApply ||
      'hidden' in newState) {
    if (newState.hidden) {
      if (!tab.$TST.states.has(Constants.kTAB_STATE_HIDDEN)) {
        tab.$TST.addState(Constants.kTAB_STATE_HIDDEN);
        Tab.onHidden.dispatch(tab);
        update.hidden = true;
      }
    }
    else if (tab.$TST.states.has(Constants.kTAB_STATE_HIDDEN)) {
      tab.$TST.removeState(Constants.kTAB_STATE_HIDDEN);
      Tab.onShown.dispatch(tab);
      update.hidden = false;
    }
  }

  if (options.forceApply ||
      'highlighted' in newState)
    tab.$TST.toggleState(Constants.kTAB_STATE_HIGHLIGHTED, newState.highlighted);

  if (options.forceApply ||
      'attention' in newState)
    tab.$TST.toggleState(Constants.kTAB_STATE_ATTENTION, newState.attention);

  if (options.forceApply ||
      'discarded' in newState) {
    wait(0).then(() => {
      // Don't set this class immediately, because we need to know
      // the newly active tab *was* discarded on onTabClosed handler.
      tab.$TST.toggleState(Constants.kTAB_STATE_DISCARDED, newState.discarded);
    });
  }

  update.soundStateChanged = update.soundStateChanged || soundStateChanged;
  update.sharingStateChanged = update.sharingStateChanged || sharingStateChanged;
  update.attributes.updated = {
    ...update.attributes.updated,
    ...(newState && newState.$TST && newState.$TST.sanitized || newState),
  };
  flushBufferedUpdates();

  tab.$TST.invalidateCache();
}

export async function updateTabsHighlighted(highlightInfo) {
  if (Tab.needToWaitTracked(highlightInfo.windowId))
    await Tab.waitUntilTrackedAll(highlightInfo.windowId);
  const win = TabsStore.windows.get(highlightInfo.windowId);
  if (!win)
    return;

  //const startAt = Date.now();

  const tabIds = highlightInfo.tabIds; // new Set(highlightInfo.tabIds);
  const toBeUnhighlightedTabs = Tab.getHighlightedTabs(highlightInfo.windowId, {
    ordered: false,
    '!id':   tabIds
  });
  const alreadyHighlightedTabs = TabsStore.highlightedTabsInWindow.get(highlightInfo.windowId);
  const toBeHighlightedTabs = mapAndFilter(tabIds, id => {
    const tab = win.tabs.get(id);
    return tab && !alreadyHighlightedTabs.has(tab.id) && tab || undefined;
  });

  //console.log(`updateTabsHighlighted: ${Date.now() - startAt}ms`, { toBeHighlightedTabs, toBeUnhighlightedTabs});

  const inheritToCollapsedDescendants = !!highlightInfo.inheritToCollapsedDescendants;
  //log('updateTabsHighlighted ', { toBeHighlightedTabs, toBeUnhighlightedTabs});
  for (const tab of toBeUnhighlightedTabs) {
    TabsStore.removeHighlightedTab(tab);
    updateTabHighlighted(tab, false, { inheritToCollapsedDescendants });
  }
  for (const tab of toBeHighlightedTabs) {
    TabsStore.addHighlightedTab(tab);
    updateTabHighlighted(tab, true, { inheritToCollapsedDescendants });
  }
}
async function updateTabHighlighted(tab, highlighted, { inheritToCollapsedDescendants } = {}) {
  log(`highlighted status of ${dumpTab(tab)}: `, { old: tab.highlighted, new: highlighted });
  //if (tab.highlighted == highlighted)
  //  return false;
  tab.$TST.toggleState(Constants.kTAB_STATE_HIGHLIGHTED, highlighted);
  tab.highlighted = highlighted;
  const win = TabsStore.windows.get(tab.windowId);
  const inheritHighlighted = !win.tabsToBeHighlightedAlone.has(tab.id);
  if (!inheritHighlighted)
    win.tabsToBeHighlightedAlone.delete(tab.id);
  updateTab(tab, { highlighted });
  Tab.onUpdated.dispatch(tab, { highlighted }, {
    inheritHighlighted: inheritToCollapsedDescendants && inheritHighlighted,
  });
  return true;
}


export async function completeLoadingTabs(windowId) {
  const completedTabs = new Set((await browser.tabs.query({ windowId, status: 'complete' })).map(tab => tab.id));
  for (const tab of Tab.getLoadingTabs(windowId, { ordered: false, iterator: true })) {
    if (completedTabs.has(tab.id))
      updateTab(tab, { status: 'complete' });
  }
}
