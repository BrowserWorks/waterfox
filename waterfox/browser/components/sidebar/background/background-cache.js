/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import { SequenceMatcher } from '/extlib/diff.js';

import {
  log as internalLogger,
  dumpTab,
  wait,
  mapAndFilter,
  configs
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as CacheStorage from '/common/cache-storage.js';
import * as Constants from '/common/constants.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TabsUpdate from '/common/tabs-update.js';
import * as UniqueId from '/common/unique-id.js';

import MetricsData from '/common/MetricsData.js';
import Tab from '/common/Tab.js';

import * as Tree from './tree.js';

function log(...args) {
  internalLogger('background/background-cache', ...args);
}

const kCONTENTS_VERSION = 5;

let mActivated = false;
const mCaches = {};

export function activate() {
  mActivated = true;
  configs.$addObserver(onConfigChange);

  if (!configs.persistCachedTree) {
    // clear obsolete cache
    browser.windows.getAll().then(windows => {
      for (const win of windows) {
        browser.sessions.removeWindowValue(win.id, Constants.kWINDOW_STATE_CACHED_TABS).catch(ApiTabs.createErrorSuppressor());
        browser.sessions.removeWindowValue(win.id, Constants.kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY).catch(ApiTabs.createErrorSuppressor());
      }
    });
  }
}


// ===================================================================
// restoring tabs from cache
// ===================================================================

export async function restoreWindowFromEffectiveWindowCache(windowId, options = {}) {
  MetricsData.add('restoreWindowFromEffectiveWindowCache: start');
  log(`restoreWindowFromEffectiveWindowCache for ${windowId} start`);
  const owner = options.owner || getWindowCacheOwner(windowId);
  if (!owner) {
    log(`restoreWindowFromEffectiveWindowCache for ${windowId} fail: no owner`);
    return false;
  }
  cancelReservedCacheTree(windowId); // prevent to break cache before loading
  const tabs = options.tabs || await browser.tabs.query({ windowId }).catch(ApiTabs.createErrorHandler());
  if (configs.debug)
    log(`restoreWindowFromEffectiveWindowCache for ${windowId} tabs: `, () => tabs.map(dumpTab));
  const actualSignature = getWindowSignature(tabs);
  let cache = options.caches && options.caches.get(`window-${owner.windowId}`) || await MetricsData.addAsync('restoreWindowFromEffectiveWindowCache: window cache', getWindowCache(owner, Constants.kWINDOW_STATE_CACHED_TABS));
  if (!cache) {
    log(`restoreWindowFromEffectiveWindowCache for ${windowId} fail: no cache`);
    return false;
  }
  const promisedPermanentStates = Promise.all(tabs.map(tab => Tab.get(tab.id).$TST.getPermanentStates())); // don't await at here for better performance
  MetricsData.add('restoreWindowFromEffectiveWindowCache: validity check: start');
  let cachedSignature = cache && cache.signature;
  log(`restoreWindowFromEffectiveWindowCache for ${windowId}: got from the owner `, {
    owner, cachedSignature, cache
  });
  const signatureGeneratedFromCache = getWindowSignature(cache.tabs).join('\n');
  if (cache &&
      cache.tabs &&
      cachedSignature &&
      cachedSignature.join('\n') != signatureGeneratedFromCache) {
    log(`restoreWindowFromEffectiveWindowCache for ${windowId}: cache is broken.`, {
      cachedSignature: cachedSignature.join('\n'),
      signatureGeneratedFromCache
    });
    cache = cachedSignature = null;
    TabsInternalOperation.clearCache(owner);
    MetricsData.add('restoreWindowFromEffectiveWindowCache: validity check: signature failed.');
  }
  else {
    MetricsData.add('restoreWindowFromEffectiveWindowCache: validity check: signature passed.');
  }
  if (options.ignorePinnedTabs &&
      cache &&
      cache.tabs &&
      cachedSignature) {
    cache.tabs      = trimTabsCache(cache.tabs, cache.pinnedTabsCount);
    cachedSignature = trimSignature(cachedSignature, cache.pinnedTabsCount);
  }
  MetricsData.add('restoreWindowFromEffectiveWindowCache: validity check: matching actual signature of got cache');
  const signatureMatchResult = matcheSignatures({
    actual: actualSignature,
    cached: cachedSignature
  });
  log(`restoreWindowFromEffectiveWindowCache for ${windowId}: verify cache`, {
    cache, actualSignature, cachedSignature,
    ...signatureMatchResult,
  });
  if (!cache ||
      cache.version != kCONTENTS_VERSION ||
      !signatureMatchResult.matched) {
    log(`restoreWindowFromEffectiveWindowCache for ${windowId}: no effective cache`);
    TabsInternalOperation.clearCache(owner);
    MetricsData.add('restoreWindowFromEffectiveWindowCache: validity check: actual signature failed.');
    return false;
  }
  MetricsData.add('restoreWindowFromEffectiveWindowCache: validity check: actual signature passed.');
  cache.offset = signatureMatchResult.offset;

  log(`restoreWindowFromEffectiveWindowCache for ${windowId}: restore from cache`);

  const permanentStates = await MetricsData.addAsync('restoreWindowFromEffectiveWindowCache: permanentStatus', promisedPermanentStates); // await at here for better performance
  const restored = await MetricsData.addAsync('restoreWindowFromEffectiveWindowCache: restoreTabsFromCache', restoreTabsFromCache(windowId, { cache, tabs, permanentStates }));
  if (restored) {
    MetricsData.add(`restoreWindowFromEffectiveWindowCache: window ${windowId} succeeded`);
    // Now we reload the sidebar if it is opened, because it is the easiest way
    // to synchronize state of tabs completely.
    log('reload sidebar for a tree restored from cache');
    browser.runtime.sendMessage({
      type: Constants.kCOMMAND_RELOAD,
      windowId,
    }).catch(ApiTabs.createErrorSuppressor());
  }
  else {
    MetricsData.add(`restoreWindowFromEffectiveWindowCache: window ${windowId} failed`);
  }

  log(`restoreWindowFromEffectiveWindowCache for ${windowId}: restored = ${restored}`);
  return restored;
}

function getWindowSignature(tabs) {
  return tabs.map(tab => `${tab.cookieStoreId},${tab.incognito},${tab.pinned},${tab.url}`);
}

function trimSignature(signature, ignoreCount) {
  if (!ignoreCount || ignoreCount < 0)
    return signature;
  return signature.slice(ignoreCount);
}

function trimTabsCache(cache, ignoreCount) {
  if (!ignoreCount || ignoreCount < 0)
    return cache;
  return cache.slice(ignoreCount);
}

function matcheSignatures(signatures) {
  const operations = (new SequenceMatcher(signatures.cached, signatures.actual)).operations();
  log('matcheSignatures: operations ', operations);
  let matched = false;
  let offset  = 0;
  for (const operation of operations) {
    const [tag, fromStart, fromEnd, toStart, toEnd] = operation;
    if (tag == 'equal' &&
        fromEnd - fromStart == signatures.cached.length) {
      matched = true;
      break;
    }
    offset += toEnd - toStart;
  }
  log('matcheSignatures: ', { matched, offset });
  return { matched, offset };
}


async function restoreTabsFromCache(windowId, params = {}) {
  if (!params.cache ||
      params.cache.version != kCONTENTS_VERSION)
    return false;

  return (await restoreTabsFromCacheInternal({
    windowId,
    tabs:         params.tabs,
    permanentStates: params.permanentStates,
    offset:       params.cache.offset || 0,
    cache:        params.cache.tabs
  })).length > 0;
}

async function restoreTabsFromCacheInternal(params) {
  MetricsData.add('restoreTabsFromCacheInternal: start');
  log(`restoreTabsFromCacheInternal: restore tabs for ${params.windowId} from cache`);
  const offset = params.offset || 0;
  const win    = TabsStore.windows.get(params.windowId);
  const tabs   = params.tabs.slice(offset).map(tab => Tab.get(tab.id));
  if (offset > 0 &&
      tabs.length <= offset) {
    log('restoreTabsFromCacheInternal: missing window');
    return [];
  }
  log(`restoreTabsFromCacheInternal: there is ${win.tabs.size} tabs`);
  if (params.cache.length != tabs.length) {
    log('restoreTabsFromCacheInternal: Mismatched number of restored tabs?');
    return [];
  }
  try {
    await MetricsData.addAsync('rebuildAll: fixupTabsRestoredFromCache', fixupTabsRestoredFromCache(tabs, params.permanentStates, params.cache));
  }
  catch(e) {
    log(String(e), e.stack);
    throw e;
  }
  log('restoreTabsFromCacheInternal: done');
  if (configs.debug)
    Tab.dumpAll();
  return tabs;
}

async function fixupTabsRestoredFromCache(tabs, permanentStates, cachedTabs) {
  MetricsData.add('fixupTabsRestoredFromCache: start');
  if (tabs.length != cachedTabs.length)
    throw new Error(`fixupTabsRestoredFromCache: Mismatched number of tabs restored from cache, tabs=${tabs.length}, cachedTabs=${cachedTabs.length}`);
  log('fixupTabsRestoredFromCache start ', () => ({ tabs: tabs.map(dumpTab), cachedTabs }));
  const idMap = new Map();
  let remappedCount = 0;
  // step 1: build a map from old id to new id
  tabs = tabs.map((tab, index) => {
    const cachedTab = cachedTabs[index];
    const oldId     = cachedTab.id;
    tab = Tab.get(tab.id);
    log(`fixupTabsRestoredFromCache: remap ${oldId} => ${tab.id}`);
    idMap.set(oldId, tab);
    if (oldId != tab.id)
      remappedCount++;
    return tab;
  });
  if (remappedCount && remappedCount < tabs.length)
    throw new Error(`fixupTabsRestoredFromCache: not a window restoration, only ${remappedCount} tab(s) are restored (maybe restoration of closed tabs)`);
  MetricsData.add('fixupTabsRestoredFromCache: step 1 done.');
  // step 2: restore information of tabs
  // Do this from bottom to top, to reduce post operations for modified trees.
  // (Attaching a tab to an existing tree will trigger "update" task for
  // existing ancestors, but attaching existing subtree to a solo tab won't
  // trigger such tasks.)
  // See also: https://github.com/piroor/treestyletab/issues/2278#issuecomment-519387792
  for (let i = tabs.length - 1; i > -1; i--) {
    fixupTabRestoredFromCache(tabs[i], permanentStates[i], cachedTabs[i], idMap);
  }
  // step 3: restore collapsed/expanded state of tabs and finalize the
  // restoration process
  // Do this from top to bottom, because a tab can be placed under an
  // expanded parent but the parent can be placed under a collapsed parent.
  for (const tab of tabs) {
    fixupTabRestoredFromCachePostProcess(tab);
  }
  MetricsData.add('fixupTabsRestoredFromCache: step 2 done.');
}

function fixupTabRestoredFromCache(tab, permanentStates, cachedTab, idMap) {
  tab.$TST.clear();
  const tabStates = new Set([...cachedTab.$TST.states, ...permanentStates]);
  for (const state of Constants.kTAB_TEMPORARY_STATES) {
    tabStates.delete(state);
  }
  tab.$TST.states = tabStates;
  tab.$TST.attributes = cachedTab.$TST.attributes;

  log('fixupTabRestoredFromCache children: ', cachedTab.$TST.childIds);
  const childIds = mapAndFilter(cachedTab.$TST.childIds, oldId => {
    const tab = idMap.get(oldId);
    return tab && tab.id || undefined;
  });
  tab.$TST.children = childIds;
  if (childIds.length > 0)
    tab.$TST.setAttribute(Constants.kCHILDREN, `|${childIds.join('|')}|`);
  else
    tab.$TST.removeAttribute(Constants.kCHILDREN);
  log('fixupTabRestoredFromCache children: => ', tab.$TST.childIds);

  log('fixupTabRestoredFromCache parent: ', cachedTab.$TST.parentId);
  const parentTab = idMap.get(cachedTab.$TST.parentId) || null;
  tab.$TST.parent = parentTab;
  if (parentTab)
    tab.$TST.setAttribute(Constants.kPARENT, parentTab.id);
  else
    tab.$TST.removeAttribute(Constants.kPARENT);
  log('fixupTabRestoredFromCache parent: => ', tab.$TST.parentId);

  tab.$TST.temporaryMetadata.set('treeStructureAlreadyRestoredFromSessionData', true);
}

function fixupTabRestoredFromCachePostProcess(tab) {
  const parentTab = tab.$TST.parent;
  if (parentTab &&
      (parentTab.$TST.collapsed ||
       parentTab.$TST.subtreeCollapsed)) {
    tab.$TST.addState(Constants.kTAB_STATE_COLLAPSED);
    tab.$TST.addState(Constants.kTAB_STATE_COLLAPSED_DONE);
  }
  else {
    tab.$TST.removeState(Constants.kTAB_STATE_COLLAPSED);
    tab.$TST.removeState(Constants.kTAB_STATE_COLLAPSED_DONE);
  }

  TabsStore.updateIndexesForTab(tab);
  TabsUpdate.updateTab(tab, tab, { forceApply: true, onlyApply: true });
}


// ===================================================================
// updating cache
// ===================================================================

async function updateWindowCache(owner, key, value) {
  if (!owner)
    return;

  if (configs.persistCachedTree) {
    try {
      if (value)
        await CacheStorage.setValue({
          windowId: owner.windowId,
          key,
          value,
          store: CacheStorage.BACKGROUND,
        });
      else
        await CacheStorage.deleteValue({
          windowId: owner.windowId,
          key,
          store: CacheStorage.BACKGROUND,
        });
      return;
    }
    catch(error) {
      console.log(`BackgroundCache.updateWindowCache for ${owner.windowId}/${key} failed: `, error.message, error.stack, error);
    }
  }

  const storageKey = `backgroundCache-${await UniqueId.ensureWindowId(owner.windowId)}-${key}`;
  if (value)
    mCaches[storageKey] = value;
  else
    delete mCaches[storageKey];
}

export function markWindowCacheDirtyFromTab(tab, akey) {
  const win = TabsStore.windows.get(tab.windowId);
  if (!win) // the window may be closed
    return;
  if (win.markWindowCacheDirtyFromTabTimeout)
    clearTimeout(win.markWindowCacheDirtyFromTabTimeout);
  win.markWindowCacheDirtyFromTabTimeout = setTimeout(() => {
    win.markWindowCacheDirtyFromTabTimeout = null;
    updateWindowCache(win.lastWindowCacheOwner, akey, true);
  }, 100);
}

async function getWindowCache(owner, key) {
  if (configs.persistCachedTree) {
    try {
      const value = await CacheStorage.getValue({
        windowId: owner.windowId,
        key,
        store: CacheStorage.BACKGROUND,
      });
      return value;
    }
    catch(error) {
      console.log(`BackgroundCache.getWindowCache for ${owner.windowId}/${key} failed: `, error.message, error.stack, error);
    }
  }

  const storageKey = `backgroundCache-${await UniqueId.ensureWindowId(owner.windowId)}-${key}`;
  return mCaches[storageKey];
}

function getWindowCacheOwner(windowId) {
  const tab = Tab.getFirstTab(windowId);
  if (!tab)
    return null;
  return {
    id:       tab.id,
    windowId: tab.windowId
  };
}

export async function reserveToCacheTree(windowId, trigger) {
  if (!mActivated ||
      !configs.useCachedTree)
    return;

  const win = TabsStore.windows.get(windowId);
  if (!win)
    return;

  // If there is any opening (but not resolved its unique id yet) tab,
  // we are possibly restoring tabs. To avoid cache breakage before
  // restoration, we must wait until we know whether there is any other
  // restoring tab or not.
  if (Tab.needToWaitTracked(windowId))
    await Tab.waitUntilTrackedAll(windowId);

  if (win.promisedAllTabsRestored) // not restored yet
    return;

  if (!trigger && configs.debug)
    trigger = new Error().stack;

  log('reserveToCacheTree for window ', windowId, trigger);
  TabsInternalOperation.clearCache(win.lastWindowCacheOwner);

  if (trigger)
    reserveToCacheTree.triggers.add(trigger);

  if (win.waitingToCacheTree)
    clearTimeout(win.waitingToCacheTree);
  win.waitingToCacheTree = setTimeout(() => {
    const triggers = [...reserveToCacheTree.triggers];
    reserveToCacheTree.triggers.clear();
    cacheTree(windowId, triggers);
  }, 500);
}
reserveToCacheTree.triggers = new Set();

function cancelReservedCacheTree(windowId) {
  const win = TabsStore.windows.get(windowId);
  if (win && win.waitingToCacheTree) {
    clearTimeout(win.waitingToCacheTree);
    delete win.waitingToCacheTree;
  }
}

async function cacheTree(windowId, triggers) {
  if (Tab.needToWaitTracked(windowId))
    await Tab.waitUntilTrackedAll(windowId);
  const win = TabsStore.windows.get(windowId);
  if (!win ||
      !configs.useCachedTree)
    return;
  const signature = getWindowSignature(Tab.getAllTabs(windowId));
  if (win.promisedAllTabsRestored) // not restored yet
    return;
  //log('save cache for ', windowId);
  win.lastWindowCacheOwner = getWindowCacheOwner(windowId);
  if (!win.lastWindowCacheOwner)
    return;
  log('cacheTree for window ', windowId, triggers/*{ stack: configs.debug && new Error().stack }*/);
  updateWindowCache(win.lastWindowCacheOwner, Constants.kWINDOW_STATE_CACHED_TABS, {
    version:         kCONTENTS_VERSION,
    tabs:            TabsStore.windows.get(windowId).export(true),
    pinnedTabsCount: Tab.getPinnedTabs(windowId).length,
    signature
  });
}


// update cache on events

Tab.onCreated.addListener((tab, _info = {}) => {
  if (!tab.$TST.previousTab) { // it is a new cache owner
    const win = TabsStore.windows.get(tab.windowId);
    if (win.lastWindowCacheOwner)
      TabsInternalOperation.clearCache(win.lastWindowCacheOwner);
  }
  reserveToCacheTree(tab.windowId, 'tab created');
});

// Tree restoration for "Restore Previous Session"
Tab.onWindowRestoring.addListener(async ({ windowId, restoredCount }) => {
  if (!configs.useCachedTree)
    return;

  log('Tabs.onWindowRestoring ', { windowId, restoredCount });
  if (restoredCount == 1) {
    log('Tabs.onWindowRestoring: single tab restored');
    return;
  }

  log('Tabs.onWindowRestoring: continue ', windowId);
  MetricsData.add('Tabs.onWindowRestoring restore start');

  const tabs = await browser.tabs.query({ windowId }).catch(ApiTabs.createErrorHandler());
  try {
    await restoreWindowFromEffectiveWindowCache(windowId, {
      ignorePinnedTabs: true,
      owner: tabs[tabs.length - 1],
      tabs
    });
    MetricsData.add('Tabs.onWindowRestoring restore end');
  }
  catch(e) {
    log('Tabs.onWindowRestoring: FATAL ERROR while restoring tree from cache', String(e), e.stack);
  }
});

Tab.onRemoved.addListener((tab, info) => {
  if (!tab.$TST.previousTab) // the tab was the cache owner
    TabsInternalOperation.clearCache(tab);
  wait(0).then(() => {
  // "Restore Previous Session" closes some tabs at first, so we should not clear the old cache yet.
  // See also: https://dxr.mozilla.org/mozilla-central/rev/5be384bcf00191f97d32b4ac3ecd1b85ec7b18e1/browser/components/sessionstore/SessionStore.jsm#3053
    reserveToCacheTree(info.windowId, 'tab removed');
  });
});

Tab.onMoved.addListener((tab, info) => {
  if (info.fromIndex == 0) // the tab is not the cache owner anymore
    TabsInternalOperation.clearCache(tab);
  reserveToCacheTree(info.windowId, 'tab moved');
});

Tab.onUpdated.addListener((tab, info) => {
  markWindowCacheDirtyFromTab(tab, Constants.kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY);
  if ('url' in info)
    reserveToCacheTree(tab.windowId, 'tab updated');
});

Tab.onStateChanged.addListener((tab, state, _has) => {
  if (state == Constants.kTAB_STATE_STICKY)
    markWindowCacheDirtyFromTab(tab, Constants.kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY);
});

Tree.onSubtreeCollapsedStateChanging.addListener(tab => {
  reserveToCacheTree(tab.windowId, 'subtree collapsed/expanded');
});

Tree.onAttached.addListener((tab, _info) => {
  wait(0).then(() => {
    // "Restore Previous Session" closes some tabs at first and it causes tree changes, so we should not clear the old cache yet.
    // See also: https://dxr.mozilla.org/mozilla-central/rev/5be384bcf00191f97d32b4ac3ecd1b85ec7b18e1/browser/components/sessionstore/SessionStore.jsm#3053
    reserveToCacheTree(tab.windowId, 'tab attached to tree');
  });
});

Tree.onDetached.addListener((tab, _info) => {
  TabsInternalOperation.clearCache(tab);
  wait(0).then(() => {
    // "Restore Previous Session" closes some tabs at first and it causes tree changes, so we should not clear the old cache yet.
    // See also: https://dxr.mozilla.org/mozilla-central/rev/5be384bcf00191f97d32b4ac3ecd1b85ec7b18e1/browser/components/sessionstore/SessionStore.jsm#3053
    reserveToCacheTree(tab.windowId, 'tab detached from tree');
  });
});

Tab.onPinned.addListener(tab => {
  reserveToCacheTree(tab.windowId, 'tab pinned');
});

Tab.onUnpinned.addListener(tab => {
  if (tab.$TST.previousTab) // the tab was the cache owner
    TabsInternalOperation.clearCache(tab);
  reserveToCacheTree(tab.windowId, 'tab unpinned');
});

Tab.onShown.addListener(tab => {
  reserveToCacheTree(tab.windowId, 'tab shown');
});

Tab.onHidden.addListener(tab => {
  reserveToCacheTree(tab.windowId, 'tab hidden');
});

browser.windows.onRemoved.addListener(async windowId => {
  try {
    CacheStorage.clearForWindow(windowId);
  }
  catch(_error) {
  }

  const storageKeyPart = `Cache-${await UniqueId.ensureWindowId(windowId)}-`;
  for (const key in mCaches) {
    if (key.includes(storageKeyPart))
      delete mCaches[key];
  }
});

function onConfigChange(key) {
  switch (key) {
    case 'useCachedTree':
    case 'persistCachedTree':
      browser.windows.getAll({
        populate:    true,
        windowTypes: ['normal']
      }).then(windows => {
        for (const win of windows) {
          const owner = win.tabs[win.tabs.length - 1];
          if (configs[key]) {
            reserveToCacheTree(win.id, 'config change');
          }
          else {
            TabsInternalOperation.clearCache(owner);
            location.reload();
          }
        }
      }).catch(ApiTabs.createErrorSuppressor());
      break;
  }
}
