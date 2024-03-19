/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  dumpTab,
  wait,
  configs,
  isMacOS,
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from '/common/constants.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';
import Window from '/common/Window.js';

import * as Background from './background.js';
import * as Tree from './tree.js';

function log(...args) {
  internalLogger('background/handle-tab-focus', ...args);
}


const PHASE_LOADING                = 0;
const PHASE_BACKGROUND_INITIALIZED = 1;
const PHASE_BACKGROUND_BUILT       = 2;
const PHASE_BACKGROUND_READY       = 3;
let mInitializationPhase = PHASE_LOADING;

Background.onInit.addListener(() => {
  mInitializationPhase = PHASE_BACKGROUND_INITIALIZED;
});
Background.onBuilt.addListener(() => {
  mInitializationPhase = PHASE_BACKGROUND_BUILT;
});
Background.onReady.addListener(() => {
  mInitializationPhase = PHASE_BACKGROUND_READY;
});


let mTabSwitchedByShortcut       = false;
let mMaybeTabSwitchingByShortcut = false;

const mLastTabsCountInWindow = new Map();

Window.onInitialized.addListener(win => {
  browser.tabs.query({
    windowId: win.id,
    active:   true
  })
    .then(activeTabs => {
      // There may be no active tab on a startup...
      if (activeTabs.length > 0 &&
          !win.lastActiveTab)
        win.lastActiveTab = activeTabs[0].id;
    });
});

browser.windows.onRemoved.addListener(windowId => {
  mLastTabsCountInWindow.delete(windowId);
});


Tab.onActivating.addListener(async (tab, info = {}) => { // return false if the activation should be canceled
  log('Tabs.onActivating ', { tab: dumpTab(tab), info, mMaybeTabSwitchingByShortcut });

  if (mMaybeTabSwitchingByShortcut) {
    const lastCount = mLastTabsCountInWindow.get(tab.windowId);
    const count = Tab.getAllTabs(tab.windowId).length;
    if (lastCount != count) {
      log('tabs are created or removed: cancel tab switching');
      mMaybeTabSwitchingByShortcut = false;
    }
    mLastTabsCountInWindow.set(tab.windowId, count);
  }

  if (tab.$TST.temporaryMetadata.has('shouldReloadOnSelect')) {
    browser.tabs.reload(tab.id)
      .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
    tab.$TST.temporaryMetadata.delete('shouldReloadOnSelect');
  }
  const win = TabsStore.windows.get(tab.windowId);
  log('  lastActiveTab: ', win.lastActiveTab); // it may be blank on a startup
  const lastActiveTab = Tab.get(win.lastActiveTab || info.previousTabId);
  cancelDelayedExpand(lastActiveTab);
  let shouldSkipCollapsed = (
    !info.byInternalOperation &&
    mMaybeTabSwitchingByShortcut &&
    configs.skipCollapsedTabsForTabSwitchingShortcuts
  );
  mTabSwitchedByShortcut = mMaybeTabSwitchingByShortcut;
  const focusDirection = !lastActiveTab ?
    0 :
    (!lastActiveTab.$TST.nearestVisiblePrecedingTab &&
     !tab.$TST.nearestVisibleFollowingTab) ?
      -1 :
      (!lastActiveTab.$TST.nearestVisibleFollowingTab &&
       !tab.$TST.nearestVisiblePrecedingTab) ?
        1 :
        (lastActiveTab.index > tab.index) ?
          -1 :
          1;
  const cache = {};
  if (tab.$TST.collapsed) {
    if (!tab.$TST.parent) {
      // This is invalid case, generally never should happen,
      // but actually happen on some environment:
      // https://github.com/piroor/treestyletab/issues/1717
      // So, always expand orphan collapsed tab as a failsafe.
      Tree.collapseExpandTab(tab, {
        collapsed: false,
        broadcast: true
      });
      await handleNewActiveTab(tab, info);
    }
    else if (!shouldSkipCollapsed) {
      log('=> reaction for focus given from outside of TST');
      let allowed = false;
      if (configs.unfocusableCollapsedTab) {
        log('  => apply unfocusableCollapsedTab');
        allowed = await TSTAPI.tryOperationAllowed(
          TSTAPI.kNOTIFY_TRY_EXPAND_TREE_FROM_FOCUSED_COLLAPSED_TAB,
          { tab,
            focusDirection },
          { tabProperties: ['tab'], cache }
        );
        TSTAPI.clearCache(cache);
        if (allowed) {
          const toBeExpandedAncestors = [tab].concat(tab.$TST.ancestors) ;
          for (const ancestor of toBeExpandedAncestors) {
            Tree.collapseExpandSubtree(ancestor, {
              collapsed: false,
              broadcast: true
            });
          }
        }
        else {
          shouldSkipCollapsed = true;
          log('  => canceled by someone.');
        }
      }
      info.allowed = allowed;
      if (!shouldSkipCollapsed)
        await handleNewActiveTab(tab, info);
    }
    if (shouldSkipCollapsed) {
      log('=> reaction for focusing collapsed descendant while Ctrl-Tab/Ctrl-Shift-Tab');
      let successor = tab.$TST.nearestVisibleAncestorOrSelf;
      if (!successor) // this seems invalid case...
        return false;
      log('successor = ', successor.id);
      if (shouldSkipCollapsed &&
          (win.lastActiveTab == successor.id ||
           successor.$TST.descendants.some(tab => tab.id == win.lastActiveTab)) &&
          focusDirection > 0) {
        log('=> redirect successor (focus moved from the successor itself or its descendants)');
        successor = successor.$TST.nearestVisibleFollowingTab;
        if (successor &&
            successor.discarded &&
            configs.avoidDiscardedTabToBeActivatedIfPossible)
          successor = successor.$TST.nearestLoadedTabInTree ||
                        successor.$TST.nearestLoadedTab ||
                        successor;
        if (!successor)
          successor = Tab.getFirstVisibleTab(tab.windowId);
        log('=> ', successor.id);
      }
      else if (!mTabSwitchedByShortcut && // intentional focus to a discarded tabs by Ctrl-Tab/Ctrl-Shift-Tab is always allowed!
               successor.discarded &&
               configs.avoidDiscardedTabToBeActivatedIfPossible) {
        log('=> redirect successor (successor is discarded)');
        successor = successor.$TST.nearestLoadedTabInTree ||
                      successor.$TST.nearestLoadedTab ||
                      successor;
        log('=> ', successor.id);
      }
      const allowed = await TSTAPI.tryOperationAllowed(
        TSTAPI.kNOTIFY_TRY_REDIRECT_FOCUS_FROM_COLLAPSED_TAB,
        { tab,
          focusDirection },
        { tabProperties: ['tab'], cache }
      );
      TSTAPI.clearCache(cache);
      if (allowed) {
        win.lastActiveTab = successor.id;
        if (mMaybeTabSwitchingByShortcut)
          setupDelayedExpand(successor);
        TabsInternalOperation.activateTab(successor, { silently: true });
        log('Tabs.onActivating: discarded? ', dumpTab(tab), tab && tab.discarded);
        if (tab.discarded)
          tab.$TST.temporaryMetadata.set('discardURLAfterCompletelyLoaded', tab.url);
        return false;
      }
      else {
        log('  => canceled by someone.');
      }
    }
  }
  else if (info.byActiveTabRemove &&
           (!configs.autoCollapseExpandSubtreeOnSelect ||
            configs.autoCollapseExpandSubtreeOnSelectExceptActiveTabRemove)) {
    log('=> reaction for removing current tab');
    win.lastActiveTab = tab.id;
    tryHighlightBundledTab(tab, {
      ...info,
      shouldSkipCollapsed
    });
    return true;
  }
  else if (tab.$TST.hasChild &&
           tab.$TST.subtreeCollapsed &&
           !shouldSkipCollapsed) {
    log('=> reaction for newly active parent tab');
    await handleNewActiveTab(tab, info);
  }
  tab.$TST.temporaryMetadata.delete('discardOnCompletelyLoaded');
  win.lastActiveTab = tab.id;

  if (mMaybeTabSwitchingByShortcut)
    setupDelayedExpand(tab);
  else
    tryHighlightBundledTab(tab, {
      ...info,
      shouldSkipCollapsed
    });

  return true;
});

async function handleNewActiveTab(tab, { allowed, silently } = {}) {
  log('handleNewActiveTab: ', dumpTab(tab), { allowed, silently });
  const shouldCollapseExpandNow = configs.autoCollapseExpandSubtreeOnSelect;
  const canCollapseTree         = shouldCollapseExpandNow;
  const canExpandTree           = shouldCollapseExpandNow && !silently;
  if (canExpandTree &&
      allowed !== false) {
    const cache = {};
    const allowed = await TSTAPI.tryOperationAllowed(
      tab.active ?
        TSTAPI.kNOTIFY_TRY_EXPAND_TREE_FROM_FOCUSED_PARENT :
        TSTAPI.kNOTIFY_TRY_EXPAND_TREE_FROM_FOCUSED_BUNDLED_PARENT,
      { tab },
      { tabProperties: ['tab'], cache }
    );
    if (!allowed)
      return;
    if (canCollapseTree &&
        configs.autoExpandIntelligently)
      await Tree.collapseExpandTreesIntelligentlyFor(tab, {
        broadcast: true
      });
    else
      Tree.collapseExpandSubtree(tab, {
        collapsed: false,
        broadcast: true
      });
  }
}

async function tryHighlightBundledTab(tab, { shouldSkipCollapsed, allowed, silently } = {}) {
  const bundledTab = tab.$TST.bundledTab;
  const oldBundledTabs = TabsStore.bundledActiveTabsInWindow.get(tab.windowId);
  log('tryHighlightBundledTab ', {
    tab: tab.id,
    bundledTab: bundledTab && bundledTab.id,
    oldBundledTabs,
    shouldSkipCollapsed,
    allowed,
    silently,
  });
  for (const tab of oldBundledTabs.values()) {
    if (tab == bundledTab)
      continue;
    tab.$TST.removeState(Constants.kTAB_STATE_BUNDLED_ACTIVE);
  }

  if (!bundledTab)
    return;

  bundledTab.$TST.addState(Constants.kTAB_STATE_BUNDLED_ACTIVE);

  await wait(100);
  if (!tab.active || // ignore tab already inactivated while waiting
      tab.$TST.hasOtherHighlighted || // ignore manual highlighting
      bundledTab.pinned ||
      !configs.syncActiveStateToBundledTabs)
    return;

  if (bundledTab.$TST.hasChild &&
      bundledTab.$TST.subtreeCollapsed &&
      !shouldSkipCollapsed)
    await handleNewActiveTab(bundledTab, { allowed, silently });
}

Tab.onUpdated.addListener((tab, changeInfo = {}) => {
  if ('url' in changeInfo) {
    if (tab.$TST.temporaryMetadata.has('discardURLAfterCompletelyLoaded') &&
        tab.$TST.temporaryMetadata.get('discardURLAfterCompletelyLoaded') != changeInfo.url)
      tab.$TST.temporaryMetadata.delete('discardURLAfterCompletelyLoaded');
  }
});

Tab.onStateChanged.addListener(tab => {
  if (!tab ||
      tab.status != 'complete')
    return;

  if (typeof browser.tabs.discard == 'function') {
    if (tab.url == tab.$TST.temporaryMetadata.get('discardURLAfterCompletelyLoaded') &&
        configs.autoDiscardTabForUnexpectedFocus) {
      log('Try to discard accidentally restored tab (on restored) ', dumpTab(tab));
      wait(configs.autoDiscardTabForUnexpectedFocusDelay).then(() => {
        if (!TabsStore.ensureLivingTab(tab) ||
            tab.active)
          return;
        if (tab.status == 'complete')
          browser.tabs.discard(tab.id)
            .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
        else
          tab.$TST.temporaryMetadata.set('discardOnCompletelyLoaded', true);
      });
    }
    else if (tab.$TST.temporaryMetadata.has('discardOnCompletelyLoaded') && !tab.active) {
      log('Discard accidentally restored tab (on complete) ', dumpTab(tab));
      browser.tabs.discard(tab.id)
        .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
    }
  }
  tab.$TST.temporaryMetadata.delete('discardURLAfterCompletelyLoaded');
  tab.$TST.temporaryMetadata.delete('discardOnCompletelyLoaded');
});

async function setupDelayedExpand(tab) {
  if (!tab)
    return;
  cancelDelayedExpand(tab);
  TabsStore.removeToBeExpandedTab(tab);
  const cache = {};
  const [ctrlTabHandlingEnabled, allowedToExpandViaAPI] = await Promise.all([
    Permissions.isGranted(Permissions.ALL_URLS),
    TSTAPI.tryOperationAllowed(
      TSTAPI.kNOTIFY_TRY_EXPAND_TREE_FROM_LONG_PRESS_CTRL_KEY,
      { tab },
      { tabProperties: ['tab'], cache }
    ),
  ]);
  if (!configs.autoExpandOnTabSwitchingShortcuts ||
      !tab.$TST.hasChild ||
      !tab.$TST.subtreeCollapsed ||
      !ctrlTabHandlingEnabled ||
      !allowedToExpandViaAPI)
    return;
  TabsStore.addToBeExpandedTab(tab);
  tab.$TST.temporaryMetadata.set('delayedExpand', setTimeout(async () => {
    if (!tab.$TST.temporaryMetadata.has('delayedExpand')) { // already canceled
      log('delayed expand is already canceled ', tab.id);
      return;
    }
    log('delayed expand by long-press of ctrl key on ', tab.id);
    TabsStore.removeToBeExpandedTab(tab);
    await Tree.collapseExpandTreesIntelligentlyFor(tab, {
      broadcast: true
    });
  }, configs.autoExpandOnTabSwitchingShortcutsDelay));
}

function cancelDelayedExpand(tab) {
  if (!tab ||
      !tab.$TST.temporaryMetadata.has('delayedExpand'))
    return;
  clearTimeout(tab.$TST.temporaryMetadata.get('delayedExpand'));
  tab.$TST.temporaryMetadata.delete('delayedExpand');
  TabsStore.removeToBeExpandedTab(tab);
}

function cancelAllDelayedExpand(windowId) {
  for (const tab of TabsStore.toBeExpandedTabsInWindow.get(windowId)) {
    cancelDelayedExpand(tab);
  }
}

Tab.onCollapsedStateChanged.addListener((tab, info = {}) => {
  tab.$TST.toggleState(Constants.kTAB_STATE_COLLAPSED_DONE, info.collapsed, { broadcast: false });
});


Background.onReady.addListener(() => {
  for (const tab of Tab.getAllTabs(null, { iterator: true })) {
    tab.$TST.removeState(Constants.kTAB_STATE_BUNDLED_ACTIVE);
  }
  for (const tab of Tab.getActiveTabs({ iterator: true })) {
    tryHighlightBundledTab(tab);
  }
});

browser.windows.onFocusChanged.addListener(() => {
  mMaybeTabSwitchingByShortcut = false;
});

browser.runtime.onMessage.addListener(onMessage);

function onMessage(message, sender) {
  if (mInitializationPhase < PHASE_BACKGROUND_BUILT ||
      !message ||
      typeof message.type != 'string')
    return;

  //log('onMessage: ', message, sender);
  switch (message.type) {
    case Constants.kNOTIFY_TAB_MOUSEDOWN:
      mMaybeTabSwitchingByShortcut =
        mTabSwitchedByShortcut = false;
      break;

    case Constants.kCOMMAND_NOTIFY_MAY_START_TAB_SWITCH: {
      if (message.modifier != (configs.accelKey || (isMacOS() ? 'meta' : 'control')))
        return;
      log('kCOMMAND_NOTIFY_MAY_START_TAB_SWITCH ', message.modifier);
      mMaybeTabSwitchingByShortcut = true;
      if (sender.tab && sender.tab.active) {
        const win = TabsStore.windows.get(sender.tab.windowId);
        win.lastActiveTab = sender.tab.id;
      }
      if (sender.tab)
        mLastTabsCountInWindow.set(sender.tab.windowId, Tab.getAllTabs(sender.tab.windowId).length);
    }; break;
    case Constants.kCOMMAND_NOTIFY_MAY_END_TAB_SWITCH:
      if (message.modifier != (configs.accelKey || (isMacOS() ? 'meta' : 'control')))
        return;
      log('kCOMMAND_NOTIFY_MAY_END_TAB_SWITCH ', message.modifier);
      return (async () => {
        if (mTabSwitchedByShortcut &&
            configs.skipCollapsedTabsForTabSwitchingShortcuts &&
            sender.tab) {
          await Tab.waitUntilTracked(sender.tab.id);
          let tab = Tab.get(sender.tab.id);
          if (!tab) {
            let tabs = await browser.tabs.query({ currentWindow: true, active: true }).catch(ApiTabs.createErrorHandler());
            if (tabs.length == 0)
              tabs = await browser.tabs.query({ currentWindow: true }).catch(ApiTabs.createErrorHandler());
            await Tab.waitUntilTracked(tabs[0].id);
            tab = Tab.get(tabs[0].id);
          }
          cancelAllDelayedExpand(tab.windowId);
          const cache = {};
          if (configs.autoCollapseExpandSubtreeOnSelect &&
              tab &&
              TabsStore.windows.get(tab.windowId).lastActiveTab == tab.id &&
              (await TSTAPI.tryOperationAllowed(
                TSTAPI.kNOTIFY_TRY_EXPAND_TREE_FROM_END_TAB_SWITCH,
                { tab },
                { tabProperties: ['tab'], cache }
              ))) {
            Tree.collapseExpandSubtree(tab, {
              collapsed: false,
              broadcast: true
            });
          }
        }
        mMaybeTabSwitchingByShortcut =
          mTabSwitchedByShortcut = false;
      })();
  }
}
