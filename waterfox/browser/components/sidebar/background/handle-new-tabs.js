/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  dumpTab,
  configs,
  isFirefoxViewTab,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TreeBehavior from '/common/tree-behavior.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';

import * as TabsMove from './tabs-move.js';
import * as TabsOpen from './tabs-open.js';
import * as Tree from './tree.js';

function log(...args) {
  internalLogger('background/handle-new-tabs', ...args);
}


Tab.onBeforeCreate.addListener(async (tab, info) => {
  const activeTab = info.activeTab || Tab.getActiveTab(tab.windowId);

  // Special case, when all these conditions are true:
  // 1) A new blank tab is configured to be opened as a child of the active tab.
  // 2) The active tab is pinned.
  // 3) Tabs opened from a pinned parent are configured to be placed near the
  //    opener pinned tab.
  // then we fakely attach the new blank tab to the active pinned tab.
  // See also https://github.com/piroor/treestyletab/issues/3296
  const shouldAttachToPinnedOpener = (
    !tab.openerTabId &&
    !tab.pinned &&
    tab.$TST.isNewTabCommandTab &&
    Constants.kCONTROLLED_NEWTAB_POSITION.has(configs.autoAttachOnNewTabCommand) &&
    (
      (activeTab?.pinned &&
       Constants.kCONTROLLED_INSERTION_POSITION.has(configs.insertNewTabFromPinnedTabAt)) ||
      (isFirefoxViewTab(activeTab) &&
       Constants.kCONTROLLED_INSERTION_POSITION.has(configs.insertNewTabFromFirefoxViewAt))
    )
  );
  if (shouldAttachToPinnedOpener)
    tab.openerTabId = activeTab.id;
});

// this should return false if the tab is / may be moved while processing
Tab.onCreating.addListener((tab, info = {}) => {
  if (info.duplicatedInternally)
    return true;

  log('Tabs.onCreating ', dumpTab(tab), tab.openerTabId, info);

  const activeTab = info.activeTab || Tab.getActiveTab(tab.windowId);
  const opener = tab.$TST.openerTab;
  if (opener) {
    tab.$TST.setAttribute(Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID, opener.$TST.uniqueId.id);
    if (!info.bypassTabControl)
      TabsStore.addToBeGroupedTab(tab);
  }
  else {
    let dontMove = false;
    if (!info.maybeOrphan &&
        !info.bypassTabControl &&
        activeTab &&
        !info.restored) {
      let autoAttachBehavior = configs.autoAttachOnNewTabCommand;
      if (tab.$TST.nextTab &&
          activeTab == tab.$TST.previousTab) {
        // New tab opened with browser.tabs.insertAfterCurrent=true may have
        // next tab. In this case the tab is expected to be placed next to the
        // active tab always, so we should change the behavior specially.
        // See also:
        //   https://github.com/piroor/treestyletab/issues/2054
        //   https://github.com/piroor/treestyletab/issues/2194#issuecomment-505272940
        dontMove = true;
        switch (autoAttachBehavior) {
          case Constants.kNEWTAB_OPEN_AS_ORPHAN:
          case Constants.kNEWTAB_OPEN_AS_SIBLING:
          case Constants.kNEWTAB_OPEN_AS_NEXT_SIBLING:
            if (activeTab.$TST.hasChild)
              autoAttachBehavior = Constants.kNEWTAB_OPEN_AS_CHILD;
            else
              autoAttachBehavior = Constants.kNEWTAB_OPEN_AS_NEXT_SIBLING;
            break;

          case Constants.kNEWTAB_OPEN_AS_CHILD:
          default:
            break;
        }
      }
      if (tab.$TST.isNewTabCommandTab) {
        if (!info.positionedBySelf) {
          log('behave as a tab opened by new tab command');
          return handleNewTabFromActiveTab(tab, {
            activeTab,
            autoAttachBehavior,
            dontMove,
            openedWithCookieStoreId: info.openedWithCookieStoreId,
            inheritContextualIdentityMode: configs.inheritContextualIdentityToChildTabMode,
            context: TSTAPI.kNEWTAB_CONTEXT_NEWTAB_COMMAND,
          }).then(moved => !moved);
        }
        return false;
      }
      else if (activeTab != tab) {
        tab.$TST.temporaryMetadata.set('possibleOpenerTab', activeTab.id);
      }
      if (!info.fromExternal)
        tab.$TST.temporaryMetadata.set('isNewTab', true);
    }
    if (info.fromExternal &&
        !info.bypassTabControl) {
      log('behave as a tab opened from external application');
      // we may need to reopen the tab with loaded URL
      if (configs.inheritContextualIdentityToTabsFromExternalMode != Constants.kCONTEXTUAL_IDENTITY_DEFAULT)
        tab.$TST.temporaryMetadata.set('fromExternal', true);
      return notifyToTryHandleNewTab(tab, {
        context: TSTAPI.kNEWTAB_CONTEXT_FROM_EXTERNAL,
        activeTab,
      }).then(allowed => {
        if (!allowed) {
          log(' => handling is canceled by someone');
          return true;
        }
        return Tree.behaveAutoAttachedTab(tab, {
          baseTab:   activeTab,
          behavior:  configs.autoAttachOnOpenedFromExternal,
          dontMove,
          broadcast: true
        }).then(moved => !moved);
      });
    }
    log('behave as a tab opened with any URL ', tab.title, tab.url);
    if (!info.restored &&
        !info.positionedBySelf &&
        !info.bypassTabControl &&
        configs.autoAttachOnAnyOtherTrigger != Constants.kNEWTAB_DO_NOTHING) {
      if (configs.inheritContextualIdentityToTabsFromAnyOtherTriggerMode != Constants.kCONTEXTUAL_IDENTITY_DEFAULT)
        tab.$TST.temporaryMetadata.set('anyOtherTrigger', true);
      log('controlled as a new tab from other unknown trigger');
      return notifyToTryHandleNewTab(tab, {
        context: TSTAPI.kNEWTAB_CONTEXT_UNKNOWN,
        activeTab,
      }).then(allowed => {
        if (!allowed) {
          log(' => handling is canceled by someone');
          return true;
        }
        return Tree.behaveAutoAttachedTab(tab, {
          baseTab:   activeTab,
          behavior:  configs.autoAttachOnAnyOtherTrigger,
          dontMove,
          broadcast: true
        }).then(moved => !moved);
      });
    }
    if (info.positionedBySelf)
      tab.$TST.temporaryMetadata.set('positionedBySelf', true);
    return true;
  }

  log(`opener: ${dumpTab(opener)}, positionedBySelf = ${info.positionedBySelf}`);
  if (!info.bypassTabControl &&
      opener &&
      (opener.pinned || isFirefoxViewTab(opener)) &&
      opener.windowId == tab.windowId) {
    return handleTabsFromPinnedOpener(tab, opener, { activeTab }).then(moved => !moved);
  }
  else if (!info.maybeOrphan || info.bypassTabControl) {
    if (info.fromExternal &&
        !info.bypassTabControl &&
        configs.inheritContextualIdentityToTabsFromExternalMode != Constants.kCONTEXTUAL_IDENTITY_DEFAULT)
      tab.$TST.temporaryMetadata.set('fromExternal', true);
    return notifyToTryHandleNewTab(tab, {
      context: info.fromExternal && !info.bypassTabControl ?
        TSTAPI.kNEWTAB_CONTEXT_FROM_EXTERNAL :
        info.duplicated ?
          TSTAPI.kNEWTAB_CONTEXT_DUPLICATED :
          TSTAPI.kNEWTAB_CONTEXT_WITH_OPENER,
      activeTab,
      openerTab: opener,
    }).then(allowed => {
      if (!allowed) {
        log(' => handling is canceled by someone');
        return true;
      }
      const behavior = info.fromExternal && !info.bypassTabControl ?
        configs.autoAttachOnOpenedFromExternal :
        info.duplicated ?
          configs.autoAttachOnDuplicated :
          configs.autoAttachOnOpenedWithOwner;
      return Tree.behaveAutoAttachedTab(tab, {
        baseTab:   opener,
        behavior,
        dontMove:  info.positionedBySelf || info.mayBeReplacedWithContainer,
        broadcast: true
      }).then(moved => !moved);
    });
  }
  return true;
});

async function notifyToTryHandleNewTab(tab, { context, activeTab, openerTab } = {}) {
  const cache = {};
  const result = TSTAPI.tryOperationAllowed(
    TSTAPI.kNOTIFY_TRY_HANDLE_NEWTAB,
    { tab,
      activeTab,
      openerTab,
      context },
    { tabProperties: ['tab', 'activeTab', 'openerTab'], cache }
  );
  TSTAPI.clearCache(cache);
  return result;
}

async function handleNewTabFromActiveTab(tab, { url, activeTab, autoAttachBehavior, dontMove, openedWithCookieStoreId, inheritContextualIdentityMode, context } = {}) {
  log('handleNewTabFromActiveTab: activeTab = ', dumpTab(activeTab), { url, activeTab, autoAttachBehavior, dontMove, inheritContextualIdentityMode, context });
  if (activeTab &&
      activeTab.$TST.ancestors.includes(tab)) {
    log(' => ignore restored ancestor tab');
    return false;
  }

  const allowed = await notifyToTryHandleNewTab(tab, {
    context,
    activeTab,
  });
  if (!allowed) {
    log(' => handling is canceled by someone');
    return false;
  }

  const moved = await Tree.behaveAutoAttachedTab(tab, {
    baseTab:   activeTab,
    behavior:  autoAttachBehavior,
    broadcast: true,
    dontMove:  dontMove || false
  });
  if (openedWithCookieStoreId) {
    log('handleNewTabFromActiveTab: do not reopen tab opened with contextual identity explicitly');
    return moved;
  }
  if (tab.cookieStoreId && tab.cookieStoreId != 'firefox-default') {
    log('handleNewTabFromActiveTab: do not reopen tab opened with non-default contextual identity ', tab.cookieStoreId);
    return moved;
  }

  const parent = tab.$TST.parent;
  let cookieStoreId = null;
  switch (inheritContextualIdentityMode) {
    case Constants.kCONTEXTUAL_IDENTITY_FROM_PARENT:
      if (parent)
        cookieStoreId = parent.cookieStoreId;
      break;

    case Constants.kCONTEXTUAL_IDENTITY_FROM_LAST_ACTIVE:
      cookieStoreId = activeTab.cookieStoreId
      break;

    default:
      return moved;
  }
  if ((tab.cookieStoreId || 'firefox-default') == (cookieStoreId || 'firefox-default')) {
    log('handleNewTabFromActiveTab: no need to reopen with inherited contextual identity ', cookieStoreId);
    return moved;
  }

  if (!configs.inheritContextualIdentityToUnopenableURLTabs &&
      !TabsOpen.isOpenable(url)) {
    log('handleNewTabFromActiveTab: not openable URL, skip reopening ', cookieStoreId, url);
    return moved;
  }

  log('handleNewTabFromActiveTab: reopen with inherited contextual identity ', cookieStoreId);
  // We need to prevent grouping of this original tab and the reopened tab
  // by the "multiple tab opened in XXX msec" feature.
  const win = TabsStore.windows.get(tab.windowId);
  win.openedNewTabs.delete(tab.id);
  await TabsOpen.openURIInTab(url || null, {
    windowId: activeTab.windowId,
    parent,
    insertBefore: tab,
    active: tab.active,
    cookieStoreId
  });
  TabsInternalOperation.removeTab(tab);
  return moved;
}

async function handleTabsFromPinnedOpener(tab, opener, { activeTab } = {}) {
  const allowed = await notifyToTryHandleNewTab(tab, {
    context: TSTAPI.kNEWTAB_CONTEXT_FROM_PINNED,
    activeTab,
    openerTab: opener,
  });
  if (!allowed) {
    log('handleTabsFromPinnedOpener: handling is canceled by someone');
    return false;
  }

  const parent = Tab.getGroupTabForOpener(opener);
  if (parent) {
    log('handleTabsFromPinnedOpener: attach to corresponding group tab');
    tab.$TST.setAttribute(Constants.kPERSISTENT_ALREADY_GROUPED_FOR_PINNED_OPENER, true);
    tab.$TST.temporaryMetadata.set('alreadyMovedAsOpenedFromPinnedOpener', true);
    // it could be updated already...
    const lastRelatedTab = opener.$TST.lastRelatedTabId == tab.id ?
      opener.$TST.previousLastRelatedTab :
      opener.$TST.lastRelatedTab;
    // If there is already opened group tab, it is more natural that
    // opened tabs are treated as a tab opened from unpinned tabs.
    const insertAt = configs.autoAttachOnOpenedWithOwner == Constants.kNEWTAB_OPEN_AS_CHILD_NEXT_TO_LAST_RELATED_TAB ?
      Constants.kINSERT_NEXT_TO_LAST_RELATED_TAB :
      configs.autoAttachOnOpenedWithOwner == Constants.kNEWTAB_OPEN_AS_CHILD_TOP ?
        Constants.kINSERT_TOP :
        configs.autoAttachOnOpenedWithOwner == Constants.kNEWTAB_OPEN_AS_CHILD_END ?
          Constants.kINSERT_END :
          undefined;
    return Tree.attachTabTo(tab, parent, {
      lastRelatedTab,
      insertAt,
      forceExpand:    true, // this is required to avoid the group tab itself is active from active tab in collapsed tree
      broadcast:      true
    });
  }

  if ((configs.autoGroupNewTabsFromPinned ||
       configs.autoGroupNewTabsFromFirefoxView) &&
      tab.$TST.needToBeGroupedSiblings.length > 0) {
    log('handleTabsFromPinnedOpener: controlled by auto-grouping');
    return false;
  }

  switch (isFirefoxViewTab(opener) ? configs.insertNewTabFromFirefoxViewAt : configs.insertNewTabFromPinnedTabAt) {
    case Constants.kINSERT_NEXT_TO_LAST_RELATED_TAB: {
      // it could be updated already...
      const lastRelatedTab = opener.$TST.lastRelatedTab != tab ?
        opener.$TST.lastRelatedTab :
        opener.$TST.previousLastRelatedTab;
      if (lastRelatedTab) {
        log(`handleTabsFromPinnedOpener: place after last related tab ${dumpTab(lastRelatedTab)}`);
        tab.$TST.temporaryMetadata.set('alreadyMovedAsOpenedFromPinnedOpener', true);
        return TabsMove.moveTabAfter(tab, lastRelatedTab.$TST.lastDescendant || lastRelatedTab, {
          delayedMove: true,
          broadcast:   true
        });
      }
      const lastPinnedTab = Tab.getLastPinnedTab(tab.windowId);
      if (lastPinnedTab) {
        log(`handleTabsFromPinnedOpener: place after last pinned tab ${dumpTab(lastPinnedTab)}`);
        tab.$TST.temporaryMetadata.set('alreadyMovedAsOpenedFromPinnedOpener', true);
        return TabsMove.moveTabAfter(tab, lastPinnedTab, {
          delayedMove: true,
          broadcast:   true
        });
      }
      const firstNormalTab = Tab.getFirstNormalTab(tab.windowId);
      if (firstNormalTab) {
        log(`handleTabsFromPinnedOpener: place before first unpinned tab ${dumpTab(firstNormalTab)}`);
        tab.$TST.temporaryMetadata.set('alreadyMovedAsOpenedFromPinnedOpener', true);
        return TabsMove.moveTabBefore(tab, firstNormalTab, {
          delayedMove: true,
          broadcast:   true
        });
      }
    };
    case Constants.kINSERT_TOP: {
      const lastPinnedTab = Tab.getLastPinnedTab(tab.windowId);
      if (lastPinnedTab) {
        log(`handleTabsFromPinnedOpener: opened from pinned opener: place after last pinned tab ${dumpTab(lastPinnedTab)}`);
        tab.$TST.temporaryMetadata.set('alreadyMovedAsOpenedFromPinnedOpener', true);
        return TabsMove.moveTabAfter(tab, lastPinnedTab, {
          delayedMove: true,
          broadcast:   true
        });
      }
      const firstNormalTab = Tab.getFirstNormalTab(tab.windowId);
      if (firstNormalTab) {
        log(`handleTabsFromPinnedOpener: opened from pinned opener: place before first pinned tab ${dumpTab(firstNormalTab)}`);
        tab.$TST.temporaryMetadata.set('alreadyMovedAsOpenedFromPinnedOpener', true);
        return TabsMove.moveTabBefore(tab, firstNormalTab, {
          delayedMove: true,
          broadcast:   true
        });
      }
    }; break;

    case Constants.kINSERT_END: {
      const lastTab = Tab.getLastTab(tab.windowId);
      log('handleTabsFromPinnedOpener: opened from pinned opener: place after the last tab ', lastTab);
      tab.$TST.temporaryMetadata.set('alreadyMovedAsOpenedFromPinnedOpener', true);
      return TabsMove.moveTabAfter(tab, lastTab, {
        delayedMove: true,
        broadcast:   true
      });
    };
  }

  return Promise.resolve(false);
}

Tab.onCreated.addListener((tab, info = {}) => {
  if (!info.duplicated ||
      info.bypassTabControl)
    return;
  const original = info.originalTab;
  log('duplicated ', dumpTab(tab), dumpTab(original));
  if (info.duplicatedInternally) {
    log('duplicated by internal operation');
    tab.$TST.addState(Constants.kTAB_STATE_DUPLICATING, { broadcast: true });
    TabsStore.addDuplicatingTab(tab);
  }
  else {
    // On old versions of Firefox, duplicated tabs had no openerTabId so they were
    // not handled by Tab.onCreating listener. Today they are already handled before
    // here, so this is just a failsafe (or for old versions of Firefox).
    // See also: https://github.com/piroor/treestyletab/issues/2830#issuecomment-831414189
    Tree.behaveAutoAttachedTab(tab, {
      baseTab:   original,
      behavior:  configs.autoAttachOnDuplicated,
      dontMove:  info.positionedBySelf || info.movedBySelfWhileCreation || info.mayBeReplacedWithContainer,
      broadcast: true
    });
  }
});

Tab.onUpdated.addListener((tab, changeInfo) => {
  if ('openerTabId' in changeInfo &&
      configs.syncParentTabAndOpenerTab &&
      !tab.$TST.updatingOpenerTabIds.includes(changeInfo.openerTabId) /* accept only changes from outside of TST */) {
    Tab.waitUntilTrackedAll(tab.windowId).then(() => {
      const parent = tab.$TST.openerTab;
      if (!parent ||
          parent.windowId != tab.windowId ||
          parent == tab.$TST.parent)
        return;
      Tree.attachTabTo(tab, parent, {
        insertAt:    Constants.kINSERT_NEAREST,
        forceExpand: tab.active,
        broadcast:   true
      });
    });
  }

  if (tab.$TST.temporaryMetadata.has('openedCompletely') &&
      tab.windowId == tab.$windowIdOnCreated && // Don't treat tab as "opened from active tab" if it is moved across windows while loading
      (changeInfo.url || changeInfo.status == 'complete') &&
      (tab.$TST.temporaryMetadata.has('isNewTab') ||
       tab.$TST.temporaryMetadata.has('fromExternal') ||
       tab.$TST.temporaryMetadata.has('anyOtherTrigger'))) {
    log('loaded tab ', dumpTab(tab), {
      isNewTab: tab.$TST.temporaryMetadata.has('isNewTab'),
      fromExternal: tab.$TST.temporaryMetadata.has('fromExternal'),
      anyOtherTrigger: tab.$TST.temporaryMetadata.has('anyOtherTrigger'),
    });
    tab.$TST.temporaryMetadata.delete('isNewTab');
    const possibleOpenerTab = Tab.get(tab.$TST.temporaryMetadata.get('possibleOpenerTab'));
    tab.$TST.temporaryMetadata.delete('possibleOpenerTab');
    log('possibleOpenerTab ', dumpTab(possibleOpenerTab));

    if (tab.$TST.temporaryMetadata.has('fromExternal')) {
      tab.$TST.temporaryMetadata.delete('fromExternal');
      log('behave as a tab opened from external application (delayed)');
      handleNewTabFromActiveTab(tab, {
        url:                           tab.url,
        activeTab:                     possibleOpenerTab,
        autoAttachBehavior:            configs.autoAttachOnOpenedFromExternal,
        inheritContextualIdentityMode: configs.inheritContextualIdentityToTabsFromExternalMode,
        context:                       TSTAPI.kNEWTAB_CONTEXT_FROM_EXTERNAL,
      });
      return;
    }

    if (tab.$TST.temporaryMetadata.has('anyOtherTrigger')) {
      tab.$TST.temporaryMetadata.delete('anyOtherTrigger');
      log('behave as a tab opened from any other trigger (delayed)');
      handleNewTabFromActiveTab(tab, {
        url:                           tab.url,
        activeTab:                     possibleOpenerTab,
        autoAttachBehavior:            configs.autoAttachOnAnyOtherTrigger,
        inheritContextualIdentityMode: configs.inheritContextualIdentityToTabsFromAnyOtherTriggerMode,
        context:                       TSTAPI.kNEWTAB_CONTEXT_UNKNOWN,
      });
      return;
    }

    const win = TabsStore.windows.get(tab.windowId);
    log('win.openedNewTabs ', win.openedNewTabs);
    if (tab.$TST.parent ||
        !possibleOpenerTab ||
        win.openedNewTabs.has(tab.id) ||
        tab.$TST.temporaryMetadata.has('openedWithOthers') ||
        tab.$TST.temporaryMetadata.has('positionedBySelf')) {
      log(' => no need to control ', {
        parent: tab.$TST.parent,
        possibleOpenerTab,
        openedNewTab: win.openedNewTabs.has(tab.id),
        openedWithOthers: tab.$TST.temporaryMetadata.has('openedWithOthers'),
        positionedBySelf: tab.$TST.temporaryMetadata.has('positionedBySelf')
      });
      return;
    }

    if (tab.$TST.isNewTabCommandTab) {
      log('behave as a tab opened by new tab command (delayed)');
      tab.$TST.addState(Constants.kTAB_STATE_NEW_TAB_COMMAND_TAB);
      handleNewTabFromActiveTab(tab, {
        activeTab:                     possibleOpenerTab,
        autoAttachBehavior:            configs.autoAttachOnNewTabCommand,
        inheritContextualIdentityMode: configs.inheritContextualIdentityToChildTabMode,
        context:                       TSTAPI.kNEWTAB_CONTEXT_NEWTAB_COMMAND,
      });
      return;
    }

    const siteMatcher  = /^\w+:\/\/([^\/]+)(?:$|\/.*$)/;
    const openerTabSite = possibleOpenerTab.url.match(siteMatcher);
    const newTabSite    = tab.url.match(siteMatcher);
    if (openerTabSite &&
        newTabSite &&
        tab.url != possibleOpenerTab.url && // It may be opened by "Duplciate Tab" or "Open in New Container Tab" if the URL is completely same.
        openerTabSite[1] == newTabSite[1]) {
      log('behave as a tab opened from same site (delayed)');
      tab.$TST.addState(Constants.kTAB_STATE_OPENED_FOR_SAME_WEBSITE);
      handleNewTabFromActiveTab(tab, {
        url:                           tab.url,
        activeTab:                     possibleOpenerTab,
        autoAttachBehavior:            configs.autoAttachSameSiteOrphan,
        inheritContextualIdentityMode: configs.inheritContextualIdentityToSameSiteOrphanMode,
        context:                       TSTAPI.kNEWTAB_CONTEXT_WEBSITE_SAME_TO_ACTIVE_TAB,
      });
      return;
    }

    log('checking special openers (delayed)', { opener: possibleOpenerTab.url, child: tab.url });
    for (const rule of Constants.kAGGRESSIVE_OPENER_TAB_DETECTION_RULES_WITH_URL) {
      if (rule.opener.test(possibleOpenerTab.url) &&
          rule.child.test(tab.url)) {
        log('behave as a tab opened from special opener (delayed)', { rule });
        handleNewTabFromActiveTab(tab, {
          url:                tab.url,
          activeTab:          possibleOpenerTab,
          autoAttachBehavior: configs.autoAttachOnOpenedWithOwner,
          context:            TSTAPI.kNEWTAB_CONTEXT_FROM_ABOUT_ADDONS,
        });
        return;
      }
    }
  }
});


Tab.onAttached.addListener(async (tab, attachInfo = {}) => {
  if (!attachInfo.windowId)
    return;

  const parentTabOperationBehavior = TreeBehavior.getParentTabOperationBehavior(tab, {
    context:  Constants.kPARENT_TAB_OPERATION_CONTEXT_MOVE,
    ...attachInfo,
  });
  if (parentTabOperationBehavior != Constants.kPARENT_TAB_OPERATION_BEHAVIOR_ENTIRE_TREE)
    return;

  log('Tabs.onAttached ', dumpTab(tab), attachInfo);

  log('descendants of attached tab: ', () => attachInfo.descendants.map(dumpTab));
  const movedTabs = await Tree.moveTabs(attachInfo.descendants, {
    destinationWindowId: tab.windowId,
    insertAfter:         tab
  });
  log('moved descendants: ', () => movedTabs.map(dumpTab));
  if (attachInfo.descendants.length == movedTabs.length) {
    await Tree.applyTreeStructureToTabs(
      [tab, ...movedTabs],
      attachInfo.structure
    );
  }
  else {
    for (const movedTab of movedTabs) {
      Tree.attachTabTo(movedTab, tab, {
        broadcast: true,
        dontMove:  true
      });
    }
  }
});
