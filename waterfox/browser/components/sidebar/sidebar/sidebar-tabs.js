/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import EventListenerManager from '/extlib/EventListenerManager.js';

import {
  log as internalLogger,
  wait,
  configs,
  shouldApplyAnimation,
  mapAndFilter,
  nextFrame,
} from '/common/common.js';

import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from '/common/constants.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TabsUpdate from '/common/tabs-update.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';
import Window from '/common/Window.js';

import * as BackgroundConnection from './background-connection.js';
import * as CollapseExpand from './collapse-expand.js';

import {
  kTAB_ELEMENT_NAME,
  kTAB_SUBSTANCE_ELEMENT_NAME,
  TabInvalidationTarget,
  TabUpdateTarget,
} from './components/TabElement.js';

function log(...args) {
  internalLogger('sidebar/sidebar-tabs', ...args);
}

let mPromisedInitializedResolver;
let mPromisedInitialized = new Promise((resolve, _reject) => {
  mPromisedInitializedResolver = resolve;
});

export const pinnedContainer = document.querySelector('#pinned-tabs-container');
export const normalContainer = document.querySelector('#normal-tabs-container');

export const onPinnedTabsChanged = new EventListenerManager();
export const onNormalTabsChanged = new EventListenerManager();
export const onTabsRendered   = new EventListenerManager();
export const onTabsUnrendered = new EventListenerManager();
export const onSyncFailed = new EventListenerManager();
export const onReuseTabElement = new EventListenerManager();

export function init() {
  document.querySelector('#sync-throbber').addEventListener('animationiteration', synchronizeThrobberAnimation);

  document.documentElement.setAttribute(Constants.kLABEL_OVERFLOW, configs.labelOverflowStyle);

  mPromisedInitializedResolver();
  mPromisedInitialized = mPromisedInitializedResolver = null;
}

function getTabContainerElement(tab) {
  return document.querySelector(`.tabs.${tab.pinned ? 'pinned' : 'normal'}`);
}

export function getTabFromDOMNode(node, options = {}) {
  if (typeof options != 'object')
    options = {};
  if (!node)
    return null;
  if (!(node instanceof Element))
    node = node.parentNode;
  const tabSubstance = node && node.closest(kTAB_SUBSTANCE_ELEMENT_NAME);
  const tab = tabSubstance && tabSubstance.closest(kTAB_ELEMENT_NAME);
  if (options.force)
    return tab && tab.apiTab;
  return TabsStore.ensureLivingTab(tab && tab.apiTab);
}


export async function reserveToUpdateLoadingState() {
  if (mPromisedInitialized)
    await mPromisedInitialized;
  if (reserveToUpdateLoadingState.waiting)
    clearTimeout(reserveToUpdateLoadingState.waiting);
  reserveToUpdateLoadingState.waiting = setTimeout(() => {
    delete reserveToUpdateLoadingState.waiting;
    updateLoadingState();
  }, 0);
}

function updateLoadingState() {
  const classList = document.documentElement.classList;
  const windowId  = TabsStore.getCurrentWindowId();
  classList.toggle(Constants.kTABBAR_STATE_HAVE_LOADING_TAB, Tab.hasLoadingTab(windowId));
  classList.toggle(Constants.kTABBAR_STATE_HAVE_UNSYNCHRONIZED_THROBBER, Tab.hasNeedToBeSynchronizedTab(windowId));
}

async function synchronizeThrobberAnimation() {
  let processedCount = 0;
  for (const tab of Tab.getNeedToBeSynchronizedTabs(TabsStore.getCurrentWindowId(), { iterator: true })) {
    tab.$TST.removeState(Constants.kTAB_STATE_THROBBER_UNSYNCHRONIZED);
    TabsStore.removeUnsynchronizedTab(tab);
    processedCount++;
  }
  if (processedCount == 0)
    return;

  const classList = document.documentElement.classList;
  classList.remove(Constants.kTABBAR_STATE_HAVE_UNSYNCHRONIZED_THROBBER);

  classList.add(Constants.kTABBAR_STATE_THROBBER_SYNCHRONIZING);
  void document.documentElement.offsetWidth; // ensure to apply updated appearance
  classList.remove(Constants.kTABBAR_STATE_THROBBER_SYNCHRONIZING);
}



export function updateAll() {
  updateLoadingState();
  synchronizeThrobberAnimation();
  // We need to update from bottom to top, because
  // TabUpdateTarget.DescendantsHighlighted refers results of descendants.
  for (const tab of Tab.getAllTabs(TabsStore.getCurrentWindowId(), { iterator: true, reverse: true })) {
    tab.$TST.invalidateElement(TabInvalidationTarget.Twisty | TabInvalidationTarget.CloseBox | TabInvalidationTarget.Tooltip);
    tab.$TST.updateElement(TabUpdateTarget.Counter | TabUpdateTarget.DescendantsHighlighted);
    if (!tab.$TST.collapsed)
      tab.$TST.element?.updateOverflow();
  }
}



export function reserveToSyncTabsOrder() {
  if (configs.delayToRetrySyncTabsOrder <= 0) {
    syncTabsOrder();
    return;
  }
  if (reserveToSyncTabsOrder.timer)
    clearTimeout(reserveToSyncTabsOrder.timer);
  reserveToSyncTabsOrder.timer = setTimeout(() => {
    delete reserveToSyncTabsOrder.timer;
    syncTabsOrder();
  }, configs.delayToRetrySyncTabsOrder);
}
reserveToSyncTabsOrder.retryCount = 0;

async function syncTabsOrder() {
  log('syncTabsOrder');
  const windowId      = TabsStore.getCurrentWindowId();
  const [internalOrder, nativeOrder] = await Promise.all([
    browser.runtime.sendMessage({
      type: Constants.kCOMMAND_PULL_TABS_ORDER,
      windowId
    }).catch(ApiTabs.createErrorHandler()),
    browser.tabs.query({ windowId }).then(tabs => tabs.map(tab => tab.id))
  ]);

  const trackedWindow = TabsStore.windows.get(windowId);
  const actualOrder   = trackedWindow.order;

  log('syncTabsOrder: ', { internalOrder, nativeOrder, actualOrder });

  if (internalOrder.join('\n') == actualOrder.join('\n') &&
      internalOrder.join('\n') == nativeOrder.join('\n')) {
    reserveToSyncTabsOrder.retryCount = 0;
    return; // no need to sync
  }

  const expectedTabs = internalOrder.slice(0).sort().join('\n');
  const nativeTabs   = nativeOrder.slice(0).sort().join('\n');
  if (expectedTabs != nativeTabs) {
    if (reserveToSyncTabsOrder.retryCount > 10) {
      console.error(new Error(`Fatal error: native tabs are not same to the tabs tracked by the background process, for the window ${windowId}. Reloading all...`));
      reserveToSyncTabsOrder.retryCount = 0;
      browser.runtime.sendMessage({
        type: Constants.kCOMMAND_RELOAD,
        all:  true
      }).catch(ApiTabs.createErrorSuppressor());
      return;
    }
    log(`syncTabsOrder: retry / Native tabs are not same to the tabs tracked by the background process, but this can happen when synchronization and tab removing are done in parallel. Retry count = ${reserveToSyncTabsOrder.retryCount}`);
    reserveToSyncTabsOrder.retryCount++;
    return reserveToSyncTabsOrder();
  }

  const actualTabs = actualOrder.slice(0).sort().join('\n');
  if (expectedTabs != actualTabs) {
    log(`syncTabsOrder: retry / Native tabs are not same to the tabs tracked by the background process, but this can happen on synchronization and tab removing are. Retry count = ${reserveToSyncTabsOrder.retryCount}`);
    if (reserveToSyncTabsOrder.retryCount > 10) {
      console.error(new Error(`Error: tracked tabs are not same to pulled tabs, for the window ${windowId}. Rebuilding...`));
      reserveToSyncTabsOrder.retryCount = 0;
      return onSyncFailed.dispatch();
    }
    log(`syncTabsOrder: retry / Native tabs are not same to tab elements, but this can happen on synchronization and tab removing are. Retry count = ${reserveToSyncTabsOrder.retryCount}`);
    reserveToSyncTabsOrder.retryCount++;
    return reserveToSyncTabsOrder();
  }

  reserveToSyncTabsOrder.retryCount = 0;
  trackedWindow.order = internalOrder;
  let count = 0;
  for (const tab of trackedWindow.getOrderedTabs()) {
    tab.index = count++;
    tab.reindexedBy = `syncTabsOrder (${tab.index})`;
    tab.$TST.invalidateCache();
  }
}

function getTabElementId(tab) {
  return `tab-${tab.id}`;
}

const mRenderedTabIds = new Set();
const mUnrenderedTabIds = new Set();
let mTabElementsPool = [];

export function renderTab(tab, { containerElement, insertBefore } = {}) {
  if (!tab) {
    console.log('WARNING: Null tab has requested to be rendered! ', new Error().stack);
    return false;
  }
  if (!tab.$TST) {
    console.log('WARNING: Alerady destroyed tab has requested to be rendered! ', tab.id, new Error().stack);
    return false;
  }

  let created = false;
  if (!tab.$TST.element ||
      !tab.$TST.element.parentNode) {
    const reuseFromPool = (mTabElementsPool.length > 0);
    const tabElement = reuseFromPool ?
      mTabElementsPool.pop() :
      document.createElement(kTAB_ELEMENT_NAME);
    tab.$TST.bindElement(tabElement);
    tab.$TST.setAttribute('id', getTabElementId(tab));
    tab.$TST.setAttribute(Constants.kAPI_TAB_ID, tab.id || -1);
    tab.$TST.setAttribute(Constants.kAPI_WINDOW_ID, tab.windowId || -1);
    tab.$TST.addState(Constants.kTAB_STATE_THROBBER_UNSYNCHRONIZED);
    TabsStore.addUnsynchronizedTab(tab);
    if (reuseFromPool) {
      tabElement.favIconUrl = null;
      onReuseTabElement.dispatch(tabElement);
    }
    created = true;
  }

  const win = TabsStore.windows.get(tab.windowId);
  const tabElement = tab.$TST.element;
  containerElement = containerElement || (
    tab.pinned ?
      win.pinnedContainerElement :
      win.containerElement
  );

  let nextElement = insertBefore?.nodeType == Node.ELEMENT_NODE ?
    insertBefore :
    (insertBefore && insertBefore.$TST.element);
  if (nextElement === undefined &&
      (containerElement == win.containerElement ||
       containerElement == win.pinnedContainerElement)) {
    const nextTab = tab.$TST.nearestSameTypeRenderedTab;
    log(`render tab element for ${tab.id} (pinned=${tab.pinned}) before ${nextTab && nextTab.id}, tab, nextTab = `, tab, nextTab);
    nextElement = nextTab && nextTab.$TST.element.parentNode == containerElement ?
      nextTab.$TST.element :
      null;
  }

  if (tabElement.parentNode == containerElement &&
      tabElement.nextSibling == nextElement)
    return false;

  containerElement.insertBefore(tabElement, nextElement);

  if (created) {
    if (!tab.active && tab.$TST.states.has(Constants.kTAB_STATE_ACTIVE)) {
      console.log('WARNING: Inactive tab has invalid "active" state! ', tab.id)
      tab.$TST.removeState(Constants.kTAB_STATE_ACTIVE);
    }

    tab.$TST.invalidateElement(TabInvalidationTarget.Twisty | TabInvalidationTarget.CloseBox | TabInvalidationTarget.Tooltip | TabInvalidationTarget.Overflow);
    tab.$TST.updateElement(TabUpdateTarget.Counter | TabUpdateTarget.Overflow | TabUpdateTarget.TabProperties);
    tab.$TST.applyStatesToElement();

    // To apply animation effect, we need to set and remove
    // the "collapsed" state again.
    if (shouldApplyAnimation() &&
        tab.$TST.states.has(Constants.kTAB_STATE_EXPANDING) &&
        !tab.$TST.states.has(Constants.kTAB_STATE_COLLAPSED)) {
      tabElement.classList.remove(Constants.kTAB_STATE_ANIMATION_READY);
      tabElement.classList.add(Constants.kTAB_STATE_COLLAPSED);
      window.requestAnimationFrame(() => {
        tabElement.classList.add(Constants.kTAB_STATE_ANIMATION_READY);
        tabElement.classList.remove(Constants.kTAB_STATE_COLLAPSED);
      });
    }
    else {
      tabElement.classList.add(Constants.kTAB_STATE_ANIMATION_READY);
    }

    mRenderedTabIds.add(tab.id);
    mUnrenderedTabIds.delete(tab.id);
    reserveToNotifyTabsRendered();
  }

  return true;
}

function reserveToNotifyTabsRendered() {
  const hasInternalListener = onTabsRendered.hasListener();
  const hasExternalListener = TSTAPI.hasListenerForMessageType(TSTAPI.kNOTIFY_TABS_RENDERED);
  if (!hasInternalListener && !hasExternalListener) {
    mRenderedTabIds.clear();
    return;
  }

  if (reserveToNotifyTabsRendered.invoked)
    return;
  reserveToNotifyTabsRendered.invoked = true;
  window.requestAnimationFrame(() => {
    reserveToNotifyTabsRendered.invoked = false;

    const ids = [...mRenderedTabIds];
    mRenderedTabIds.clear();
    const tabs =  mapAndFilter(ids, id => Tab.get(id));

    if (hasInternalListener)
      onTabsRendered.dispatch(tabs);

    if (hasExternalListener) {
      let cache = {};
      TSTAPI.broadcastMessage({
        type: TSTAPI.kNOTIFY_TABS_RENDERED,
        tabs,
      }, { tabProperties: ['tabs'], cache }).catch(_error => {});
      cache = null;
    }
  });
}

let mClearPoolTimer = null;

export function unrenderTab(tab) {
  if (!tab ||
      !tab.$TST ||
      !tab.$TST.element)
    return false;

  mRenderedTabIds.delete(tab.id);
  mUnrenderedTabIds.add(tab.id);

  const tabElement = tab.$TST.element;

  tab.$TST.removeState(Constants.kTAB_STATE_THROBBER_UNSYNCHRONIZED);
  TabsStore.removeUnsynchronizedTab(tab);

  const hasInternalListener = onTabsUnrendered.hasListener();
  const hasExternalListener = TSTAPI.hasListenerForMessageType(TSTAPI.kNOTIFY_TABS_UNRENDERED);
  if (hasInternalListener || hasExternalListener) {
    if (!unrenderTab.invoked) {
      unrenderTab.invoked = true;
      window.requestAnimationFrame(() => {
        unrenderTab.invoked = false;

        const ids = [...mUnrenderedTabIds];
        mUnrenderedTabIds.clear();
        const tabs = mapAndFilter(ids, id => Tab.get(id));

        if (hasInternalListener)
          onTabsUnrendered.dispatch(tabs);

        if (hasExternalListener) {
          let cache = {};
          TSTAPI.broadcastMessage({
            type: TSTAPI.kNOTIFY_TABS_UNRENDERED,
            tabs,
          }, { tabProperties: ['tabs'], cache }).catch(_error => {});
          cache = null;
        }
      });
    }
  }
  else {
    mUnrenderedTabIds.clear();
  }

  if (!tabElement ||
      !tabElement.parentNode)
    return false;

  tabElement.parentNode.removeChild(tabElement);
  tab.$TST.unbindElement();

  // We reuse already generated elements for better performance.
  // See also: https://github.com/piroor/treestyletab/issues/3477
  mTabElementsPool.push(tabElement);
  if (mClearPoolTimer)
    clearTimeout(mClearPoolTimer);
  mClearPoolTimer = setTimeout(() => {
    mTabElementsPool = [];
  }, configs.generatedTabElementsPoolLifetimeMsec);

  return true;
}

Window.onInitialized.addListener(win => {
  const windowId = win.id;
  win = TabsStore.windows.get(windowId);

  let innerPinnedContainer = document.getElementById(`window-${windowId}-pinned`);
  if (!innerPinnedContainer) {
    innerPinnedContainer = document.createElement('ul');
    pinnedContainer.appendChild(innerPinnedContainer);
  }
  innerPinnedContainer.dataset.windowId = windowId;
  innerPinnedContainer.setAttribute('id', `window-${windowId}-pinned`);
  innerPinnedContainer.classList.add('tabs');
  innerPinnedContainer.classList.add('pinned');
  innerPinnedContainer.setAttribute('role', 'listbox');
  innerPinnedContainer.setAttribute('aria-multiselectable', 'true');
  innerPinnedContainer.$TST = win;
  win.bindPinnedContainerElement(innerPinnedContainer);

  let innerNormalContainer = document.getElementById(`window-${windowId}`);
  if (!innerNormalContainer) {
    innerNormalContainer = document.querySelector('#normal-tabs-container .virtual-scroll-container').appendChild(document.createElement('ul'));
  }
  innerNormalContainer.dataset.windowId = windowId;
  innerNormalContainer.setAttribute('id', `window-${windowId}`);
  innerNormalContainer.classList.add('tabs');
  innerNormalContainer.classList.add('normal');
  innerNormalContainer.setAttribute('role', 'listbox');
  innerNormalContainer.setAttribute('aria-multiselectable', 'true');
  innerNormalContainer.$TST = win;
  win.bindContainerElement(innerNormalContainer);
});


let mReservedUpdateActiveTab;

configs.$addObserver(async changedKey => {
  switch (changedKey) {
    case 'labelOverflowStyle':
      document.documentElement.setAttribute(Constants.kLABEL_OVERFLOW, configs.labelOverflowStyle);
      break;

    case 'renderHiddenTabs': {
      let hasNormalTab = false;
      for (const tab of Tab.getHiddenTabs(TabsStore.getCurrentWindowId(), { iterator: true })) {
        TabsStore.updateVirtualScrollRenderabilityIndexForTab(tab);
        if (!tab.pinned)
          hasNormalTab = true;
      }
      if (hasNormalTab)
        onNormalTabsChanged.dispatch();
    }; break;
  }
});


// Mechanism to override "index" of newly opened tabs by TST's detection logic

const mMovedNewTabResolvers = new Map();
const mPromsiedMovedNewTabs = new Map();
const mAlreadyMovedNewTabs = new Set();

export async function waitUntilNewTabIsMoved(tabId) {
  if (mAlreadyMovedNewTabs.has(tabId))
    return true;
  if (mPromsiedMovedNewTabs.has(tabId))
    return mPromsiedMovedNewTabs.get(tabId);
  const timer = setTimeout(() => {
    if (mMovedNewTabResolvers.has(tabId))
      mMovedNewTabResolvers.get(tabId)();
  }, Math.max(0, configs.tabBunchesDetectionTimeout));
  const promise = new Promise((resolve, _reject) => {
    mMovedNewTabResolvers.set(tabId, resolve);
  }).then(newIndex => {
    mMovedNewTabResolvers.delete(tabId);
    mPromsiedMovedNewTabs.delete(tabId);
    clearTimeout(timer);
    return newIndex;
  });
  mPromsiedMovedNewTabs.set(tabId, promise);
  return promise;
}

function maybeNewTabIsMoved(tabId) {
  if (mMovedNewTabResolvers.has(tabId)) {
    mMovedNewTabResolvers.get(tabId)();
  }
  else {
    mAlreadyMovedNewTabs.add(tabId);
    setTimeout(() => {
      mAlreadyMovedNewTabs.delete(tabId);
    }, Math.min(10 * 1000, configs.tabBunchesDetectionTimeout));
  }
}


const mPendingUpdates = new Map();

function setupPendingUpdate(update) {
  const pendingUpdate = mPendingUpdates.get(update.tabId) || { tabId: update.tabId };

  update.addedStates       = new Set(update.addedStates || []);
  update.removedStates     = new Set(update.removedStates || []);
  update.removedAttributes = new Set(update.removedAttributes || []);
  update.addedAttributes   = update.addedAttributes || {};
  update.updatedProperties = update.updatedProperties || {};

  pendingUpdate.updatedProperties = {
    ...(pendingUpdate.updatedProperties || {}),
    ...update.updatedProperties
  };

  if (update.removedAttributes.size > 0) {
    pendingUpdate.removedAttributes = new Set([...(pendingUpdate.removedAttributes || []), ...update.removedAttributes]);
    if (pendingUpdate.addedAttributes)
      for (const attribute of update.removedAttributes) {
        delete pendingUpdate.addedAttributes[attribute];
      }
  }

  if (Object.keys(update.addedAttributes).length > 0) {
    pendingUpdate.addedAttributes = {
      ...(pendingUpdate.addedAttributes || {}),
      ...update.addedAttributes
    };
    if (pendingUpdate.removedAttributes)
      for (const attribute of Object.keys(update.removedAttributes)) {
        pendingUpdate.removedAttributes.delete(attribute);
      }
  }

  if (update.removedStates.size > 0) {
    pendingUpdate.removedStates = new Set([...(pendingUpdate.removedStates || []), ...update.removedStates]);
    if (pendingUpdate.addedStates)
      for (const state of update.removedStates) {
        pendingUpdate.addedStates.delete(state);
      }
  }

  if (update.addedStates.size > 0) {
    pendingUpdate.addedStates = new Set([...(pendingUpdate.addedStates || []), ...update.addedStates]);
    if (pendingUpdate.removedStates)
      for (const state of update.addedStates) {
        pendingUpdate.removedStates.delete(state);
      }
  }

  pendingUpdate.soundStateChanged = pendingUpdate.soundStateChanged || update.soundStateChanged;

  mPendingUpdates.set(update.tabId, pendingUpdate);
}

function tryApplyUpdate(update) {
  const tab = Tab.get(update.tabId);
  if (!tab)
    return;

  const highlightedChanged = update.updatedProperties && 'highlighted' in update.updatedProperties;

  if (update.updatedProperties) {
    for (const [key, value] of Object.entries(update.updatedProperties)) {
      if (Tab.UNSYNCHRONIZABLE_PROPERTIES.has(key))
        continue;
      tab[key] = value;
    }
  }

  if (update.addedAttributes) {
    for (const key of Object.keys(update.addedAttributes)) {
      tab.$TST.setAttribute(key, update.addedAttributes[key]);
    }
  }

  if (update.removedAttributes) {
    for (const key of update.removedAttributes) {
      tab.$TST.removeAttribute(key, );
    }
  }

  if (update.soundStateChanged) {
    const parent = tab.$TST.parent;
    if (parent)
      parent.$TST.inheritSoundStateFromChildren();
  }

  if (update.sharingStateChanged) {
    const parent = tab.$TST.parent;
    if (parent)
      parent.$TST.inheritSharingStateFromChildren();
  }

  tab.$TST.invalidateElement(TabInvalidationTarget.SoundButton | TabInvalidationTarget.Tooltip);

  if (highlightedChanged) {
    tab.$TST.invalidateElement(TabInvalidationTarget.CloseBox);
    for (const ancestor of tab.$TST.ancestors) {
      ancestor.$TST.updateElement(TabUpdateTarget.DescendantsHighlighted);
    }
    if (mReservedUpdateActiveTab)
      clearTimeout(mReservedUpdateActiveTab);
    mReservedUpdateActiveTab = setTimeout(() => {
      mReservedUpdateActiveTab = null;
      const activeTab = Tab.getActiveTab(tab.windowId);
      activeTab.$TST.invalidateElement(TabInvalidationTarget.SoundButton | TabInvalidationTarget.CloseBox);
    }, 50);
  }
}

async function activateRealActiveTab(windowId) {
  const tabs = await browser.tabs.query({ active: true, windowId });
  if (tabs.length <= 0)
    throw new Error(`FATAL ERROR: No active tab in the window ${windowId}`);
  const id = tabs[0].id;
  await Tab.waitUntilTracked(id);
  const tab = Tab.get(id);
  if (!tab)
    throw new Error(`FATAL ERROR: Active tab ${id} in the window ${windowId} is not tracked`);
  TabsStore.activeTabInWindow.set(windowId, tab);
  TabsInternalOperation.setTabActive(tab);
}

const mReindexedTabIds = new Set();

function reserveToUpdateTabsIndex() {
  if (reserveToUpdateTabsIndex.invoked)
    return;
  reserveToUpdateTabsIndex.invoked = true;
  window.requestAnimationFrame(() => {
    reserveToUpdateTabsIndex.invoked = false;

    const ids = [...mReindexedTabIds];
    mReindexedTabIds.clear();
    for (const id of ids) {
      const tab = Tab.get(id);
      if (!tab)
        continue;
      tab.$TST.applyAttributesToElement();
    }
  });
}


const BUFFER_KEY_PREFIX = 'sidebar-tab-';

const mRemovedTabIdsNotifiedBeforeTracked = new Set();
const mWaitingTasksOnSameTick = new Map();

BackgroundConnection.onMessage.addListener(async message => {
  switch (message.type) {
    case Constants.kCOMMAND_SYNC_TABS_ORDER:
      reserveToSyncTabsOrder();
      break;

    case Constants.kCOMMAND_BROADCAST_TAB_STATE: {
      if (!message.tabIds.length)
        break;
      await Tab.waitUntilTracked(message.tabIds);
      const add    = message.add || [];
      const remove = message.remove || [];
      log('apply broadcasted tab state ', message.tabIds, {
        add:    add.join(','),
        remove: remove.join(',')
      });
      const modified = new Set([...add, ...remove]);
      let stickyStateChanged = false;
      for (const id of message.tabIds) {
        const tab = Tab.get(id);
        if (!tab)
          continue;
        for (const state of add) {
          tab.$TST.addState(state, { toTab: true });
        }
        for (const state of remove) {
          tab.$TST.removeState(state, { toTab: true });
        }
        if (modified.has(Constants.kTAB_STATE_AUDIBLE) ||
            modified.has(Constants.kTAB_STATE_SOUND_PLAYING) ||
            modified.has(Constants.kTAB_STATE_MUTED) ||
            modified.has(Constants.kTAB_STATE_AUTOPLAY_BLOCKED)) {
          tab.$TST.invalidateElement(TabInvalidationTarget.SoundButton);
        }
        if (modified.has(Constants.kTAB_STATE_STICKY))
          stickyStateChanged = true;
      }
      if (stickyStateChanged ||
          [...Tab.autoStickyStates.values()].some(states => (new Set([...states, ...modified])).size < states.size + modified.size))
        onNormalTabsChanged.dispatch();
    }; break;

    case Constants.kCOMMAND_BROADCAST_TAB_TOOLTIP_TEXT: {
      if (!message.tabIds.length)
        break;
      await Tab.waitUntilTracked(message.tabIds);
      log('apply broadcasted tab tooltip text ', message.changes);
      for (const change of message.changes) {
        const tab = Tab.get(change.tabId);
        if (!tab)
          continue;
        tab.$TST.registerTooltipText(browser.runtime.id, change.high, true);
        tab.$TST.registerTooltipText(browser.runtime.id, change.low, false);
        tab.$TST.invalidateElement(TabInvalidationTarget.Tooltip);
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_CREATING: {
      const nativeTab = message.tab;
      nativeTab.reindexedBy = `creating (${nativeTab.index})`;

      if (mRemovedTabIdsNotifiedBeforeTracked.has(nativeTab.id)) {
        log(`ignore kCOMMAND_NOTIFY_TAB_CREATING for already closed tab: ${nativeTab.id}`);
        return;
      }

      // The "index" property of the tab was already updated by the background process
      // with other newly opened tabs. However, such other tabs are not tracked on
      // this sidebar namespace yet. Thus we need to correct the index of the tab
      // to be inserted to already tracked tabs.
      // For example:
      //  - tabs in the background page: [a,b,X,Y,Z,c,d]
      //  - tabs in the sidebar page:    [a,b,c,d]
      //  - notified tab:                Z (as index=4) (X and Y will be notified later)
      // then the new tab Z must be treated as index=2 and the result must become
      // [a,b,Z,c,d] instead of [a,b,c,d,Z]. How should we calculate the index with
      // less amount?
      const win = TabsStore.windows.get(message.windowId);
      let index = 0;
      for (const id of message.order) {
        if (win.tabs.has(id)) {
          nativeTab.index = ++index;
          nativeTab.reindexedBy = `creating/fixed (${nativeTab.index})`;
        }
        if (id == message.tabId)
          break;
      }

      const tab = Tab.init(nativeTab, { inBackground: true });
      TabsUpdate.updateTab(tab, tab, { forceApply: true });

      for (const tab of Tab.getAllTabs(message.windowId, { fromId: nativeTab.id })) {
        mReindexedTabIds.add(tab.id);
      }
      reserveToUpdateTabsIndex();

      TabsStore.addLoadingTab(tab);
      TabsStore.updateVirtualScrollRenderabilityIndexForTab(tab);
      if (shouldApplyAnimation()) {
        CollapseExpand.setCollapsed(tab, {
          collapsed: true,
          justNow:   true
        });
        tab.$TST.collapsedOnCreated = true;
      }
      else {
        reserveToUpdateLoadingState();
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_CREATED: {
      if (message.active) {
        BackgroundConnection.handleBufferedMessage({
          type:  Constants.kCOMMAND_NOTIFY_TAB_ACTIVATED,
          tabId: message.tabId,
          windowId: message.windowId
        }, `${BUFFER_KEY_PREFIX}window-${message.windowId}`);
      }
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab) {
        log(`ignore kCOMMAND_NOTIFY_TAB_CREATED for already closed tab: ${message.tabId}`);
        return;
      }
      tab.$TST.removeState(Constants.kTAB_STATE_ANIMATION_READY);
      tab.$TST.resolveOpened();
      if (message.maybeMoved)
        await waitUntilNewTabIsMoved(message.tabId);
      if (tab.pinned) {
        renderTab(tab);
        onPinnedTabsChanged.dispatch(tab);
      }
      else {
        onNormalTabsChanged.dispatch(tab);
      }
      reserveToUpdateLoadingState();
      const needToWaitForTreeExpansion = (
        tab.$TST.shouldExpandLater &&
        !tab.active &&
        !Tab.getActiveTab(tab.windowId).pinned
      );
      if (shouldApplyAnimation(true) ||
          needToWaitForTreeExpansion) {
        wait(10).then(() => { // wait until the tab is moved by TST itself
          // On this case we don't need to expand the tab here, because
          // it will be expanded by scroll.js's kCOMMAND_NOTIFY_TAB_CREATED handler
          // for scrolling to a newly opened tab via CollapseExpand.setCollapsed().
          reserveToUpdateLoadingState();
        });
      }
      if (tab.active) {
        if (shouldApplyAnimation()) {
          await wait(0); // nextFrame() is too fast!
          if (!message.collapsed /* the new tab may be really collapsed not just for animation, and we should not expand */ &&
              tab.$TST.collapsedOnCreated) {
            CollapseExpand.setCollapsed(tab, {
              collapsed: false,
            });
            reserveToUpdateLoadingState();
          }
        }
        const lastMessage = BackgroundConnection.fetchBufferedMessage(Constants.kCOMMAND_NOTIFY_TAB_ACTIVATED, `${BUFFER_KEY_PREFIX}window-${message.windowId}`);
        if (!lastMessage)
          break;
        await Tab.waitUntilTracked(lastMessage.tabId);
        const activeTab = Tab.get(lastMessage.tabId);
        TabsStore.activeTabInWindow.set(activeTab.windowId, activeTab);
        TabsInternalOperation.setTabActive(activeTab);
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_RESTORED: {
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.$TST.addState(Constants.kTAB_STATE_RESTORED);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_ACTIVATED: {
      if (BackgroundConnection.handleBufferedMessage(message, `${BUFFER_KEY_PREFIX}window-${message.windowId}`))
        return;
      await Tab.waitUntilTracked(message.tabId);
      const lastMessage = BackgroundConnection.fetchBufferedMessage(message.type, `${BUFFER_KEY_PREFIX}window-${message.windowId}`);
      if (!lastMessage)
        return;
      const tab = Tab.get(lastMessage.tabId);
      if (!tab)
        return;
      const lastActive = TabsStore.activeTabInWindow.get(lastMessage.windowId);
      if (lastActive)
        getTabContainerElement(lastActive).removeAttribute('aria-activedescendant');
      TabsStore.activeTabInWindow.set(lastMessage.windowId, tab);
      TabsInternalOperation.setTabActive(tab);
      getTabContainerElement(tab).setAttribute('aria-activedescendant', getTabElementId(tab));
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_UPDATED: {
      // We don't use BackgroundConnection.handleBufferedMessage/BackgroundConnection.fetchBufferedMessage for this type message because update type messages need to be merged more intelligently.
      const hasPendingUpdate = mPendingUpdates.has(message.tabId);

      // Updates may be notified before the tab element is actually created,
      // so we should apply updates ASAP. We can update already tracked tab
      // while "creating" is notified and waiting for "created".
      // See also: https://github.com/piroor/treestyletab/issues/2275
      tryApplyUpdate(message);
      setupPendingUpdate(message);

      // Already pending update will be processed later, so we don't need
      // process this update.
      if (hasPendingUpdate)
        return;

      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;

      const update = mPendingUpdates.get(message.tabId) || message;
      mPendingUpdates.delete(update.tabId);

      tryApplyUpdate(update);

      TabsStore.updateIndexesForTab(tab);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_MOVED: {
      // Tab move messages are notified as an array at a time,
      // but Tab.waitUntilTracked() may break their order.
      // So we do a hack to wait messages as a group received at a time.
      maybeNewTabIsMoved(message.tabId);
      const promises = mWaitingTasksOnSameTick.get(message.type) || [];
      promises.push(Tab.waitUntilTracked([message.tabId, message.nextTabId]));
      mWaitingTasksOnSameTick.set(message.type, promises);
      await nextFrame();
      mWaitingTasksOnSameTick.delete(message.type);
      await Promise.all(promises);

      const tab     = Tab.get(message.tabId);
      if (!tab ||
          tab.index == message.toIndex)
        return;
      if (mPromisedInitialized)
        await mPromisedInitialized;
      if (tab.$TST.parent)
        tab.$TST.parent.$TST.invalidateElement(TabInvalidationTarget.Tooltip);

      tab.$TST.addState(Constants.kTAB_STATE_MOVING);

      let shouldAnimate = false;
      if (shouldApplyAnimation() &&
          !tab.pinned &&
          !tab.$TST.opening &&
          !tab.$TST.collapsed) {
        shouldAnimate = true;
        CollapseExpand.setCollapsed(tab, {
          collapsed: true,
          justNow:   true
        });
        tab.$TST.shouldExpandLater = true;
      }

      tab.index = message.toIndex;
      tab.reindexedBy = `moved (${tab.index})`;
      const win = TabsStore.windows.get(message.windowId);
      win.trackTab(tab);

      for (const tab of Tab.getAllTabs(message.windowId, {
        fromIndex: Math.min(message.fromIndex, message.toIndex),
        toIndex:   Math.max(message.fromIndex, message.toIndex),
        iterator:  true,
      })) {
        mReindexedTabIds.add(tab.id);
      }
      reserveToUpdateTabsIndex();

      if (tab.pinned) {
        renderTab(tab);
        onPinnedTabsChanged.dispatch(tab);
      }
      else {
        onNormalTabsChanged.dispatch(tab);
      }
      tab.$TST.applyAttributesToElement();

      if (shouldAnimate && tab.$TST.shouldExpandLater) {
        CollapseExpand.setCollapsed(tab, {
          collapsed: false
        });
        await wait(configs.collapseDuration);
      }
      tab.$TST.removeState(Constants.kTAB_STATE_MOVING);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_INTERNALLY_MOVED: {
      // Tab move also should be stabilized with BackgroundConnection.handleBufferedMessage/BackgroundConnection.fetchBufferedMessage but the buffering mechanism is not designed for messages which need to be applied sequentially...
      maybeNewTabIsMoved(message.tabId);
      await Tab.waitUntilTracked([message.tabId, message.nextTabId]);
      const tab         = Tab.get(message.tabId);
      if (!tab ||
          tab.index == message.toIndex)
        return;
      tab.index = message.toIndex;
      tab.reindexedBy = `internally moved (${tab.index})`;
      Tab.track(tab);

      for (const tab of Tab.getAllTabs(message.windowId, {
        fromIndex: Math.min(message.fromIndex, message.toIndex),
        toIndex:   Math.max(message.fromIndex, message.toIndex),
        iterator:  true,
      })) {
        mReindexedTabIds.add(tab.id);
      }
      reserveToUpdateTabsIndex();

      if (tab.pinned) {
        renderTab(tab);
        onPinnedTabsChanged.dispatch(tab);
      }
      else {
        onNormalTabsChanged.dispatch(tab);
      }
      tab.$TST.applyAttributesToElement();
      if (!message.broadcasted) {
        // Tab element movement triggered by sidebar itself can break order of
        // tabs synchronized from the background, so for safetyl we trigger
        // synchronization.
        reserveToSyncTabsOrder();
      }
    }; break;

    case Constants.kCOMMAND_UPDATE_LOADING_STATE: {
      if (BackgroundConnection.handleBufferedMessage(message, `${BUFFER_KEY_PREFIX}${message.tabId}`))
        return;
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      const lastMessage = BackgroundConnection.fetchBufferedMessage(message.type, `${BUFFER_KEY_PREFIX}${message.tabId}`);
      if (tab &&
          lastMessage) {
        if (lastMessage.status == 'loading') {
          tab.$TST.removeState(Constants.kTAB_STATE_BURSTING);
          TabsStore.addLoadingTab(tab);
          tab.$TST.addState(Constants.kTAB_STATE_THROBBER_UNSYNCHRONIZED);
          TabsStore.addUnsynchronizedTab(tab);
        }
        else {
          if (lastMessage.reallyChanged) {
            tab.$TST.addState(Constants.kTAB_STATE_BURSTING);
            if (tab.$TST.delayedBurstEnd)
              clearTimeout(tab.$TST.delayedBurstEnd);
            tab.$TST.delayedBurstEnd = setTimeout(() => {
              delete tab.$TST.delayedBurstEnd;
              tab.$TST.removeState(Constants.kTAB_STATE_BURSTING);
              if (!tab.active)
                tab.$TST.addState(Constants.kTAB_STATE_NOT_ACTIVATED_SINCE_LOAD);
            }, configs.burstDuration);
          }
          tab.$TST.removeState(Constants.kTAB_STATE_THROBBER_UNSYNCHRONIZED);
          TabsStore.removeUnsynchronizedTab(tab);
          TabsStore.removeLoadingTab(tab);
        }
      }
      reserveToUpdateLoadingState();
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_REMOVING: {
      const tab = Tab.get(message.tabId);
      if (!tab) {
        log(`ignore kCOMMAND_NOTIFY_TAB_REMOVING for already closed tab: ${message.tabId}`);
        mRemovedTabIdsNotifiedBeforeTracked.add(message.tabId);
        wait(10000).then(() => {
          mRemovedTabIdsNotifiedBeforeTracked.delete(message.tabId);
        });
        return;
      }
      tab.$TST.parent = null;
      // remove from "highlighted tabs" cache immediately, to prevent misdetection for "multiple highlighted".
      TabsStore.removeHighlightedTab(tab);
      TabsStore.removeGroupTab(tab);
      TabsStore.addRemovingTab(tab);
      TabsStore.addRemovedTab(tab); // reserved
      TabsStore.updateVirtualScrollRenderabilityIndexForTab(tab);
      reserveToUpdateLoadingState();
      if (tab.active) {
        // This should not, but sometimes happens on some edge cases for example:
        // https://github.com/piroor/treestyletab/issues/2385
        activateRealActiveTab(message.windowId);
      }
      if (!tab.$TST.collapsed &&
          shouldApplyAnimation()) {
        tab.$TST.addState(Constants.kTAB_STATE_REMOVING); // addState()'s result from the background page may not be notified yet, so we set this state manually here
        CollapseExpand.setCollapsed(tab, {
          collapsed: true
        });
        if (tab.pinned)
          onPinnedTabsChanged.dispatch(tab);
        else
          onNormalTabsChanged.dispatch(tab);
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_REMOVED: {
      const tab = Tab.get(message.tabId);
      // Don't untrack tab here because we need to keep it rendered for removing animation.
      //TabsStore.windows.get(message.windowId).detachTab(message.tabId);
      if (!tab) {
        log(`ignore kCOMMAND_NOTIFY_TAB_REMOVED for already closed tab: ${message.tabId}`);
        return;
      }
      if (tab.active) {
        // This should not, but sometimes happens on some edge cases for example:
        // https://github.com/piroor/treestyletab/issues/2385
        activateRealActiveTab(message.windowId);
      }
      if (shouldApplyAnimation())
        await wait(configs.collapseDuration);
      TabsStore.windows.get(message.windowId).detachTab(message.tabId);
      tab.$TST.destroy();
      unrenderTab(tab);
      if (tab.pinned)
        onPinnedTabsChanged.dispatch(tab);
      else
        onNormalTabsChanged.dispatch(tab);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_LABEL_UPDATED: {
      if (BackgroundConnection.handleBufferedMessage(message, `${BUFFER_KEY_PREFIX}${message.tabId}`))
        return;
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      const lastMessage = BackgroundConnection.fetchBufferedMessage(message.type, `${BUFFER_KEY_PREFIX}${message.tabId}`);
      if (!tab ||
          !lastMessage)
        return;
      tab.title = lastMessage.title;
      tab.$TST.label = lastMessage.label;
      if (tab.$TST.element)
        tab.$TST.element.label = lastMessage.label;
      tab.$TST.invalidateCache();
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_FAVICON_UPDATED: {
      if (BackgroundConnection.handleBufferedMessage(message, `${BUFFER_KEY_PREFIX}${message.tabId}`))
        return;
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      const lastMessage = BackgroundConnection.fetchBufferedMessage(message.type, `${BUFFER_KEY_PREFIX}${message.tabId}`);
      if (!tab ||
          !lastMessage)
        return;
      tab.favIconUrl = lastMessage.favIconUrl;
      tab.$TST.favIconUrl = lastMessage.favIconUrl;
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_SOUND_STATE_UPDATED: {
      if (BackgroundConnection.handleBufferedMessage(message, `${BUFFER_KEY_PREFIX}${message.tabId}`))
        return;
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      const lastMessage = BackgroundConnection.fetchBufferedMessage(message.type, `${BUFFER_KEY_PREFIX}${message.tabId}`);
      if (!tab ||
          !lastMessage)
        return;
      tab.$TST.toggleState(Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER, lastMessage.hasSoundPlayingMember);
      tab.$TST.toggleState(Constants.kTAB_STATE_HAS_MUTED_MEMBER, lastMessage.hasMutedMember);
      tab.$TST.toggleState(Constants.kTAB_STATE_HAS_AUTOPLAY_BLOCKED_MEMBER, lastMessage.hasAutoplayBlockedMember);
      tab.$TST.invalidateElement(TabInvalidationTarget.SoundButton);
    }; break;

    case Constants.kCOMMAND_NOTIFY_HIGHLIGHTED_TABS_CHANGED: {
      BackgroundConnection.handleBufferedMessage(message, `${BUFFER_KEY_PREFIX}window-${message.windowId}`);
      await Tab.waitUntilTracked(message.tabIds);
      const lastMessage = BackgroundConnection.fetchBufferedMessage(message.type, `${BUFFER_KEY_PREFIX}window-${message.windowId}`);
      if (!lastMessage ||
          lastMessage.tabIds.join(',') != message.tabIds.join(','))
        return;
      TabsUpdate.updateTabsHighlighted(message);
      const win = TabsStore.windows.get(message.windowId);
      if (!win || !win.containerElement)
        return;
      document.documentElement.classList.toggle(Constants.kTABBAR_STATE_MULTIPLE_HIGHLIGHTED, message.tabIds.length > 1);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_PINNED:
    case Constants.kCOMMAND_NOTIFY_TAB_UNPINNED: {
      if (BackgroundConnection.handleBufferedMessage({ type: 'pinned/unpinned', message }, `${BUFFER_KEY_PREFIX}${message.tabId}`))
        return;
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      const lastMessage = BackgroundConnection.fetchBufferedMessage('pinned/unpinned', `${BUFFER_KEY_PREFIX}${message.tabId}`);
      if (!tab ||
          !lastMessage)
        return;
      tab.$TST.invalidateCache();
      if (lastMessage.message.type == Constants.kCOMMAND_NOTIFY_TAB_PINNED) {
        tab.pinned = true;
        TabsStore.removeUnpinnedTab(tab);
        TabsStore.addPinnedTab(tab);
        renderTab(tab);
      }
      else {
        tab.pinned = false;
        TabsStore.removePinnedTab(tab);
        TabsStore.addUnpinnedTab(tab);
        unrenderTab(tab);
      }
      TabsStore.updateVirtualScrollRenderabilityIndexForTab(tab);
      onPinnedTabsChanged.dispatch(tab.pinned && tab);
      onNormalTabsChanged.dispatch(!tab.pinned && tab);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_HIDDEN:
    case Constants.kCOMMAND_NOTIFY_TAB_SHOWN: {
      if (BackgroundConnection.handleBufferedMessage({ type: 'shown/hidden', message }, `${BUFFER_KEY_PREFIX}${message.tabId}`))
        return;
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      const lastMessage = BackgroundConnection.fetchBufferedMessage('shown/hidden', `${BUFFER_KEY_PREFIX}${message.tabId}`);
      if (!tab ||
          !lastMessage)
        return;
      tab.$TST.invalidateCache();
      if (lastMessage.message.type == Constants.kCOMMAND_NOTIFY_TAB_HIDDEN) {
        tab.hidden = true;
        TabsStore.removeVisibleTab(tab);
        TabsStore.removeControllableTab(tab);
      }
      else {
        tab.hidden = false;
        if (!tab.$TST.collapsed)
          TabsStore.addVisibleTab(tab);
        TabsStore.addControllableTab(tab);
      }
      TabsStore.updateVirtualScrollRenderabilityIndexForTab(tab);
      if (tab.pinned)
        onPinnedTabsChanged.dispatch(tab);
      else
        onNormalTabsChanged.dispatch(tab);
    }; break;

    case Constants.kCOMMAND_NOTIFY_SUBTREE_COLLAPSED_STATE_CHANGED: {
      if (BackgroundConnection.handleBufferedMessage(message, `${BUFFER_KEY_PREFIX}${message.tabId}`))
        return;
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      const lastMessage = BackgroundConnection.fetchBufferedMessage(message.type, `${BUFFER_KEY_PREFIX}${message.tabId}`);
      if (!tab ||
          !lastMessage)
        return;
      tab.$TST.invalidateCache();
      tab.$TST.invalidateElement(TabInvalidationTarget.CloseBox);
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_COLLAPSED_STATE_CHANGED: {
      if (BackgroundConnection.handleBufferedMessage(message, `${BUFFER_KEY_PREFIX}${message.tabId}`) ||
          message.collapsed)
        return;
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      const lastMessage = BackgroundConnection.fetchBufferedMessage(message.type, `${BUFFER_KEY_PREFIX}${message.tabId}`);
      if (!tab ||
          !lastMessage ||
          lastMessage.collapsed)
        return;
      TabsStore.addVisibleTab(tab);
      TabsStore.addExpandedTab(tab);
      reserveToUpdateLoadingState();
      tab.$TST.invalidateCache();
      tab.$TST.invalidateElement(TabInvalidationTarget.Twisty | TabInvalidationTarget.CloseBox | TabInvalidationTarget.Tooltip);
      tab.$TST.element?.updateOverflow();
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_ATTACHED_TO_WINDOW: {
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.$TST.invalidateCache();
      if (tab.active)
        TabsInternalOperation.setTabActive(tab); // to clear "active" state of other tabs
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_DETACHED_FROM_WINDOW: {
      // don't wait until tracked here, because detaching tab will become untracked!
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      tab.$TST.invalidateElement(TabInvalidationTarget.Tooltip);
      tab.$TST.parent = null;
      TabsStore.addRemovedTab(tab);
      const win = TabsStore.windows.get(message.windowId);
      win.untrackTab(message.tabId);
      unrenderTab(tab);
      if (tab.pinned)
        onPinnedTabsChanged.dispatch(tab);
      else
        onNormalTabsChanged.dispatch(tab);
      // Allow to move tabs to this window again, after a timeout.
      // https://github.com/piroor/treestyletab/issues/2316
      wait(500).then(() => TabsStore.removeRemovedTab(tab));
    }; break;

    case Constants.kCOMMAND_NOTIFY_GROUP_TAB_DETECTED: {
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      // When a group tab is restored but pending, TST cannot update title of the tab itself.
      // For failsafe now we update the title based on its URL.
      const url = new URL(tab.url);
      let title = url.searchParams.get('title');
      if (!title) {
        const parameters = tab.url.replace(/^[^\?]+/, '');
        title = parameters.match(/^\?([^&;]*)/);
        title = title && decodeURIComponent(title[1]);
      }
      title = title || browser.i18n.getMessage('groupTab_label_default');
      tab.title = title;
      wait(0).then(() => {
        TabsUpdate.updateTab(tab, { title });
      });
    }; break;

    case Constants.kCOMMAND_NOTIFY_CHILDREN_CHANGED: {
      if (mPromisedInitialized)
        return;
      // We need to wait not only for added children but removed children also,
      // to construct same number of promises for "attached but detached immediately"
      // cases.
      const relatedTabIds = [message.tabId].concat(message.addedChildIds, message.removedChildIds);
      await Tab.waitUntilTracked(relatedTabIds);
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;

      if (message.addedChildIds.length > 0) {
        // set initial level for newly opened child, to avoid annoying jumping of new tab
        const childLevel = parseInt(tab.$TST.getAttribute(Constants.kLEVEL) || 0) + 1;
        for (const childId of message.addedChildIds) {
          const child = Tab.get(childId);
          if (!child || child.$TST.hasChild)
            continue;
          const currentLevel = child.$TST.getAttribute(Constants.kLEVEL) || 0;
          if (currentLevel == 0)
            child.$TST.setAttribute(Constants.kLEVEL, childLevel);
        }
      }

      tab.$TST.children = message.childIds;

      tab.$TST.invalidateElement(TabInvalidationTarget.Twisty | TabInvalidationTarget.CloseBox | TabInvalidationTarget.Tooltip);
      if (message.newlyAttached || message.detached) {
        const ancestors = [tab].concat(tab.$TST.ancestors);
        for (const ancestor of ancestors) {
          ancestor.$TST.updateElement(TabUpdateTarget.Counter | TabUpdateTarget.DescendantsHighlighted);
        }
      }
    }; break;

    case Constants.kCOMMAND_BROADCAST_TAB_AUTO_STICKY_STATE:
      if (message.add)
        Tab.registerAutoStickyState(message.providerId, message.add);
      if (message.remove)
        Tab.unregisterAutoStickyState(message.providerId, message.remove);
      onNormalTabsChanged.dispatch();
      break;
  }
});
