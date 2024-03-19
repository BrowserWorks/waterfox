/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  configs,
  wait,
  countMatched,
  dumpTab
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from '/common/constants.js';
import * as SidebarConnection from '/common/sidebar-connection.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TabsUpdate from '/common/tabs-update.js';
import * as TreeBehavior from '/common/tree-behavior.js';

import Tab from '/common/Tab.js';

import * as TabsMove from './tabs-move.js';
import * as TabsOpen from './tabs-open.js';
import * as Tree from './tree.js';

function log(...args) {
  internalLogger('background/tabs-group', ...args);
}

export function makeGroupTabURI({ title, temporary, temporaryAggressive, openerTabId, aliasTabId } = {}) {
  const url = new URL(Constants.kGROUP_TAB_URI);

  if (title)
    url.searchParams.set('title', title);

  if (temporaryAggressive)
    url.searchParams.set('temporaryAggressive', 'true');
  else if (temporary)
    url.searchParams.set('temporary', 'true');

  if (openerTabId)
    url.searchParams.set('openerTabId', openerTabId);

  if (aliasTabId)
    url.searchParams.set('aliasTabId', aliasTabId);

  return url.href;
}

export function temporaryStateParams(state) {
  switch (state) {
    case Constants.kGROUP_TAB_TEMPORARY_STATE_PASSIVE:
      return { temporary: true };
    case Constants.kGROUP_TAB_TEMPORARY_STATE_AGGRESSIVE:
      return { temporaryAggressive: true };
    default:
      break;
  }
  return {};
}

export async function groupTabs(tabs, { broadcast, parent, withDescendants, ...groupTabOptions } = {}) {
  const rootTabs = Tab.collectRootTabs(tabs);
  if (rootTabs.length <= 0)
    return null;

  log('groupTabs: ', () => tabs.map(dumpTab));

  const uri = makeGroupTabURI({
    title:     browser.i18n.getMessage('groupTab_label', rootTabs[0].title),
    temporary: true,
    ...groupTabOptions
  });
  const groupTab = await TabsOpen.openURIInTab(uri, {
    windowId:     rootTabs[0].windowId,
    parent:       parent || rootTabs[0].$TST.parent,
    insertBefore: rootTabs[0],
    inBackground: true
  });

  if (!withDescendants)
    await Tree.detachTabsFromTree(tabs, {
      broadcast: !!broadcast
    });
  await TabsMove.moveTabsAfter(tabs.slice(1), tabs[0], {
    broadcast: !!broadcast
  });
  for (const tab of rootTabs) {
    await Tree.attachTabTo(tab, groupTab, {
      forceExpand: true, // this is required to avoid the group tab itself is active from active tab in collapsed tree
      dontMove:  true,
      broadcast: !!broadcast
    });
  }
  return groupTab;
}

function reserveToCleanupNeedlessGroupTab(tabOrTabs) {
  const tabs = Array.isArray(tabOrTabs) ? tabOrTabs : [tabOrTabs] ;
  for (const tab of tabs) {
    if (!TabsStore.ensureLivingTab(tab))
      continue;
    if (tab.$TST.temporaryMetadata.has('reservedCleanupNeedlessGroupTab'))
      clearTimeout(tab.$TST.temporaryMetadata.get('reservedCleanupNeedlessGroupTab'));
    tab.$TST.temporaryMetadata.set('reservedCleanupNeedlessGroupTab', setTimeout(() => {
      if (!tab.$TST)
        return;
      tab.$TST.temporaryMetadata.delete('reservedCleanupNeedlessGroupTab');
      cleanupNeedlssGroupTab(tab);
    }, 100));
  }
}

function cleanupNeedlssGroupTab(tabs) {
  if (!Array.isArray(tabs))
    tabs = [tabs];
  log('trying to clanup needless temporary group tabs from ', () => tabs.map(dumpTab));
  const tabsToBeRemoved = [];
  for (const tab of tabs) {
    if (tab.$TST.isTemporaryGroupTab) {
      if (tab.$TST.childIds.length > 1)
        break;
      const lastChild = tab.$TST.firstChild;
      if (lastChild &&
          !lastChild.$TST.isTemporaryGroupTab &&
          !lastChild.$TST.isTemporaryAggressiveGroupTab)
        break;
    }
    else if (tab.$TST.isTemporaryAggressiveGroupTab) {
      if (tab.$TST.childIds.length > 1)
        break;
    }
    else {
      break;
    }
    tabsToBeRemoved.push(tab);
  }
  log('=> to be removed: ', () => tabsToBeRemoved.map(dumpTab));
  TabsInternalOperation.removeTabs(tabsToBeRemoved, { keepDescendants: true });
}

export async function tryReplaceTabWithGroup(tab, { windowId, parent, children, insertBefore, newParent } = {}) {
  if (tab) {
    windowId     = tab.windowId;
    parent       = tab.$TST.parent;
    children     = tab.$TST.children;
    insertBefore = insertBefore || tab.$TST.unsafeNextTab;
  }

  if (children.length <= 1 ||
      countMatched(children,
                   tab => !tab.$TST.states.has(Constants.kTAB_STATE_TO_BE_REMOVED)) <= 1)
    return null;

  log('trying to replace the closing tab with a new group tab');

  const firstChild = children[0];
  const uri = makeGroupTabURI({
    title:     browser.i18n.getMessage('groupTab_label', firstChild.title),
    ...temporaryStateParams(configs.groupTabTemporaryStateForOrphanedTabs)
  });
  const win = TabsStore.windows.get(windowId);
  win.toBeOpenedTabsWithPositions++;
  const groupTab = await TabsOpen.openURIInTab(uri, {
    windowId,
    insertBefore,
    inBackground: true
  });
  log('group tab: ', dumpTab(groupTab));
  if (!groupTab) // the window is closed!
    return;
  if (newParent || parent)
    await Tree.attachTabTo(groupTab, newParent || parent, {
      dontMove:  true,
      broadcast: true
    });
  for (const child of children) {
    await Tree.attachTabTo(child, groupTab, {
      dontMove:  true,
      broadcast: true
    });
  }

  // This can be triggered on closing of multiple tabs,
  // so we should cleanup it on such cases for safety.
  // https://github.com/piroor/treestyletab/issues/2317
  wait(1000).then(() => reserveToCleanupNeedlessGroupTab(groupTab));

  return groupTab;
}


// ====================================================================
// init/update group tabs
// ====================================================================

/*
  To prevent the tab is closed by Firefox, we need to inject scripts dynamically.
  See also: https://github.com/piroor/treestyletab/issues/1670#issuecomment-350964087
*/
async function tryInitGroupTab(tab) {
  if (!tab.$TST.isGroupTab &&
      !tab.$TST.hasGroupTabURL)
    return;
  log('tryInitGroupTab ', tab);
  const v3Options = {
    target: { tabId: tab.id },
  };
  const v2Options = {
    runAt:           'document_start',
    matchAboutBlank: true
  };
  try {
    const getPageState = function getPageState() {
      return [window.prepared, document.documentElement.matches('.initialized')];
    };
    const [prepared, initialized, reloaded] = (browser.scripting ?
      browser.scripting.executeScript({ // Manifest V3
        ...v3Options,
        func: getPageState,
      }).then(results => results && results[0] && results[0].result || []) :
      browser.tabs.executeScript(tab.id, {
        ...v2Options,
        code: `(${getPageState.toString()})()`,
      }).then(results => results && results[0] || [])
    ).catch(error => {
      if (ApiTabs.isMissingHostPermissionError(error) &&
          tab.$TST.hasGroupTabURL) {
        log('  tryInitGroupTab: failed to run script for restored/discarded tab, reload the tab for safety ', tab.id);
        browser.tabs.reload(tab.id);
        return [[false, false, true]];
      }
      return ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError)(error);
    });
    log('  tryInitGroupTab: groupt tab state ', tab.id, { prepared, initialized, reloaded });
    if (reloaded) {
      log('  => reloaded ', tab.id);
      return;
    }
    if (prepared && initialized) {
      log('  => already initialized ', tab.id);
      return;
    }
  }
  catch(error) {
    log('  tryInitGroupTab: error while checking initialized: ', tab.id, error);
  }
  try {
    const getTitleExistence = function getState() {
      return !!document.querySelector('#title');
    };
    const titleElementExists = (browser.scripting ?
      browser.scripting.executeScript({ // Manifest V3
        ...v3Options,
        func: getTitleExistence,
      }).then(results => results && results[0] && results[0].result) :
      browser.tabs.executeScript(tab.id, {
        ...v2Options,
        code: `(${getTitleExistence.toString()})()`,
      }).then(results => results && results[0])
    ).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError, ApiTabs.handleMissingHostPermissionError));
    if (!titleElementExists && tab.status == 'complete') { // we need to load resources/group-tab.html at first.
      log('  => title element exists, load again ', tab.id);
      return browser.tabs.update(tab.id, { url: tab.url }).catch(ApiTabs.createErrorSuppressor());
    }
  }
  catch(error) {
    log('  tryInitGroupTab error while checking title element: ', tab.id, error);
  }

  (browser.scripting ?
    browser.scripting.executeScript({ // Manifest V3
      ...v3Options,
      files: [
        '/extlib/l10n-classic.js', // ES module does not supported as a content script...
        '/resources/group-tab.js',
      ],
    }) :
    Promise.all([
      browser.tabs.executeScript(tab.id, {
        ...v2Options,
        //file:  '/common/l10n.js'
        file: '/extlib/l10n-classic.js', // ES module does not supported as a content script...
      }).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError, ApiTabs.handleMissingHostPermissionError)),
      browser.tabs.executeScript(tab.id, {
        ...v2Options,
        file: '/resources/group-tab.js',
      }).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError, ApiTabs.handleMissingHostPermissionError)),
    ])
  ).then(() => {
    log('tryInitGroupTab completely initialized: ', tab.id);
  });

  if (tab.$TST.states.has(Constants.kTAB_STATE_UNREAD)) {
    tab.$TST.removeState(Constants.kTAB_STATE_UNREAD, { permanently: true });
    SidebarConnection.sendMessage({
      type:     Constants.kCOMMAND_NOTIFY_TAB_UPDATED,
      windowId: tab.windowId,
      tabId:    tab.id,
      removedStates: [Constants.kTAB_STATE_UNREAD]
    });
  }
}

function reserveToUpdateRelatedGroupTabs(tab, changedInfo) {
  const tabMetadata = tab.$TST.temporaryMetadata;
  const updatingTabs = tabMetadata.get('reserveToUpdateRelatedGroupTabsUpdatingTabs') || new Set();
  if (!tabMetadata.has('reserveToUpdateRelatedGroupTabsUpdatingTabs'))
    tabMetadata.set('reserveToUpdateRelatedGroupTabsUpdatingTabs', updatingTabs);

  const ancestorGroupTabs = [
    tab,
    tab.$TST.bundledTab,
    ...tab.$TST.ancestors,
    ...tab.$TST.ancestors.map(tab => tab.$TST.bundledTab),
  ].filter(tab => tab && tab.$TST.isGroupTab);
  for (const updatingTab of ancestorGroupTabs) {
    const updatingMetadata = updatingTab.$TST.temporaryMetadata;
    const reservedChangedInfo = updatingMetadata.get('reservedUpdateRelatedGroupTabChangedInfo') || new Set();
    for (const info of changedInfo) {
      reservedChangedInfo.add(info);
    }
    if (updatingTabs.has(updatingTab.id))
      continue;
    updatingTabs.add(updatingTab.id);
    const triggeredUpdates = updatingMetadata.get('reservedUpdateRelatedGroupTabTriggeredUpdates') || new Set();
    triggeredUpdates.add(updatingTabs);
    updatingMetadata.set('reservedUpdateRelatedGroupTabTriggeredUpdates', triggeredUpdates);
    if (updatingMetadata.has('reservedUpdateRelatedGroupTab'))
      clearTimeout(updatingMetadata.get('reservedUpdateRelatedGroupTab'));
    updatingMetadata.set('reservedUpdateRelatedGroupTabChangedInfo', reservedChangedInfo);
    updatingMetadata.set('reservedUpdateRelatedGroupTab', setTimeout(() => {
      updatingMetadata.delete('reservedUpdateRelatedGroupTab');
      if (updatingTab.$TST) {
        try {
          if (reservedChangedInfo.size > 0)
            updateRelatedGroupTab(updatingTab, [...reservedChangedInfo]);
        }
        catch(_error) {
        }
        updatingMetadata.delete('reservedUpdateRelatedGroupTabChangedInfo');
      }
      setTimeout(() => {
        const triggerUpdates = updatingMetadata.get('reservedUpdateRelatedGroupTabTriggeredUpdates')
        updatingMetadata.delete('reservedUpdateRelatedGroupTabTriggeredUpdates');
        if (!triggerUpdates)
          return;
        for (const updatingTabs of triggerUpdates) {
          updatingTabs.delete(updatingTab.id);
        }
      }, 100)
    }, 100));
  }
}

async function updateRelatedGroupTab(groupTab, changedInfo = []) {
  if (!TabsStore.ensureLivingTab(groupTab))
    return;

  await tryInitGroupTab(groupTab);
  if (changedInfo.includes('tree')) {
    try {
      await browser.tabs.sendMessage(groupTab.id, {
        type: 'ws:update-tree',
      }).catch(error => {
        if (ApiTabs.isMissingHostPermissionError(error))
          throw error;
        return ApiTabs.createErrorSuppressor(ApiTabs.handleMissingTabError, ApiTabs.handleUnloadedError)(error);
      });
    }
    catch(error) {
      if (ApiTabs.isMissingHostPermissionError(error)) {
        log('  updateRelatedGroupTab: failed to run script for restored/discarded tab, reload the tab for safety ', groupTab.id);
        browser.tabs.reload(groupTab.id);
        return;
      }
    }
  }

  const firstChild = groupTab.$TST.firstChild;
  if (!firstChild) // the tab can be closed while waiting...
    return;

  if (changedInfo.includes('title')) {
    let newTitle;
    if (Constants.kGROUP_TAB_DEFAULT_TITLE_MATCHER.test(groupTab.title)) {
      newTitle = browser.i18n.getMessage('groupTab_label', firstChild.title);
    }
    else if (Constants.kGROUP_TAB_FROM_PINNED_DEFAULT_TITLE_MATCHER.test(groupTab.title)) {
      const opener = groupTab.$TST.openerTab;
      if (opener) {
        if (opener &&
            opener.favIconUrl) {
          SidebarConnection.sendMessage({
            type:       Constants.kCOMMAND_NOTIFY_TAB_FAVICON_UPDATED,
            windowId:   groupTab.windowId,
            tabId:      groupTab.id,
            favIconUrl: opener.favIconUrl
          });
        }
        newTitle = browser.i18n.getMessage('groupTab_fromPinnedTab_label', opener.title);
      }
    }

    if (newTitle && groupTab.title != newTitle) {
      browser.tabs.sendMessage(groupTab.id, {
        type:  'ws:update-title',
        title: newTitle,
      }).catch(ApiTabs.createErrorHandler(
        ApiTabs.handleMissingTabError,
        ApiTabs.handleMissingHostPermissionError,
        _error => {
          // failed to update the title by group tab itself, so we try to update it from outside
          groupTab.title = newTitle;
          TabsUpdate.updateTab(groupTab, { title: newTitle });
        }
      ));
    }
  }
}

Tab.onRemoved.addListener((tab, _closeInfo = {}) => {
  const ancestors = tab.$TST.ancestors;
  wait(0).then(() => {
    reserveToCleanupNeedlessGroupTab(ancestors);
  });
});

Tab.onUpdated.addListener((tab, changeInfo) => {
  if ('url' in changeInfo ||
      'previousUrl' in changeInfo ||
      'state' in changeInfo) {
    const status = changeInfo.status || tab && tab.status;
    const url = changeInfo.url ? changeInfo.url :
      status == 'complete' && tab ? tab.url : '';
    if (tab &&
        status == 'complete') {
      if (url.indexOf(Constants.kGROUP_TAB_URI) == 0) {
        tab.$TST.addState(Constants.kTAB_STATE_GROUP_TAB, { permanently: true });
      }
      else if (!Constants.kSHORTHAND_ABOUT_URI.test(url)) {
        tab.$TST.getPermanentStates().then(async (states) => {
          if (url.indexOf(Constants.kGROUP_TAB_URI) == 0)
            return;
          // Detect group tab from different session - which can have different UUID for the URL.
          const PREFIX_REMOVER = /^moz-extension:\/\/[^\/]+/;
          const pathPart = url.replace(PREFIX_REMOVER, '');
          if (states.includes(Constants.kTAB_STATE_GROUP_TAB) &&
              pathPart.split('?')[0] == Constants.kGROUP_TAB_URI.replace(PREFIX_REMOVER, '')) {
            const parameters = pathPart.replace(/^[^\?]+\?/, '');
            const oldUrl = tab.url;
            await wait(100); // for safety
            if (tab.url != oldUrl)
              return;
            browser.tabs.update(tab.id, {
              url: `${Constants.kGROUP_TAB_URI}?${parameters}`
            }).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
            tab.$TST.addState(Constants.kTAB_STATE_GROUP_TAB);
          }
          else {
            tab.$TST.removeState(Constants.kTAB_STATE_GROUP_TAB, { permanently: true });
          }
        });
      }
    }
    // restored tab can be replaced with blank tab. we need to restore it manually.
    else if (changeInfo.url == 'about:blank' &&
             changeInfo.previousUrl &&
             changeInfo.previousUrl.indexOf(Constants.kGROUP_TAB_URI) == 0) {
      const oldUrl = tab.url;
      wait(100).then(() => { // redirect with delay to avoid infinite loop of recursive redirections.
        if (tab.url != oldUrl)
          return;
        browser.tabs.update(tab.id, {
          url: changeInfo.previousUrl
        }).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
        tab.$TST.addState(Constants.kTAB_STATE_GROUP_TAB, { permanently: true });
      });
    }

    if (changeInfo.status ||
        changeInfo.url ||
        url.indexOf(Constants.kGROUP_TAB_URI) == 0)
      tryInitGroupTab(tab);
  }

  if ('title' in changeInfo) {
    const group = Tab.getGroupTabForOpener(tab);
    if (group)
      reserveToUpdateRelatedGroupTabs(group, ['title', 'tree']);
  }
});

Tab.onGroupTabDetected.addListener(tab => {
  tryInitGroupTab(tab);
});

Tab.onLabelUpdated.addListener(tab => {
  reserveToUpdateRelatedGroupTabs(tab, ['title', 'tree']);
});

Tab.onActivating.addListener((tab, _info = {}) => {
  tryInitGroupTab(tab);
});

// returns a boolean: need to reload or not.
export async function clearTemporaryState(tab) {
  if (!tab.$TST.isTemporaryGroupTab &&
      !tab.$TST.isTemporaryAggressiveGroupTab)
    return;

  const url = new URL(tab.url);
  url.searchParams.delete('temporary');
  url.searchParams.delete('temporaryAggressive');
  await Promise.all([
    browser.tabs.sendMessage(tab.id, {
      type: 'ws:clear-temporary-state',
    }).catch(ApiTabs.createErrorHandler()),
    browser.tabs.executeScript(tab.id, { // failsafe
      runAt: 'document_start',
      code:  `history.replaceState({}, document.title, ${JSON.stringify(url.href)});`,
    }).catch(ApiTabs.createErrorHandler()),
  ]);
  tab.url = url.href;
}

Tab.onPinned.addListener(async tab => {
  log('handlePinnedParentTab ', tab);

  await Tree.collapseExpandSubtree(tab, {
    collapsed: false,
    broadcast: true
  });

  log('  childIdsBeforeMoved: ', tab.$TST.temporaryMetadata.get('childIdsBeforeMoved'));
  log('  parentIdBeforeMoved: ', tab.$TST.temporaryMetadata.get('parentIdBeforeMoved'));

  const children = (
    tab.$TST.temporaryMetadata.has('childIdsBeforeMoved') ?
      tab.$TST.temporaryMetadata.get('childIdsBeforeMoved').map(id => Tab.get(id)) :
      tab.$TST.children
  ).filter(tab => TabsStore.ensureLivingTab(tab));
  const parent = TabsStore.ensureLivingTab(
    tab.$TST.temporaryMetadata.has('parentIdBeforeMoved') ?
      Tab.get(tab.$TST.temporaryMetadata.get('parentIdBeforeMoved')) :
      tab.$TST.parent
  );

  let openedGroupTab;
  const shouldGroupChildren = configs.autoGroupNewTabsFromPinned || tab.$TST.isGroupTab;
  if (shouldGroupChildren) {
    log(' => trying to group left tabs with a group: ', children);
    openedGroupTab = await groupTabs(children, {
      // If the tab is a group tab, the opened tab should be treated as an alias of the pinned group tab.
      // Otherwise it should be treated just as a temporary group tab to group children.
      title:       tab.$TST.isGroupTab ? tab.title : browser.i18n.getMessage('groupTab_fromPinnedTab_label', tab.title),
      temporary:   !tab.$TST.isGroupTab,
      openerTabId: tab.$TST.uniqueId.id,
      parent,
      withDescendants: true,
    });
    log(' openedGroupTab: ', openedGroupTab);
    // Tree structure of left tabs can be modified by someone like tryFixupTreeForInsertedTab@handle-moved-tabs.js.
    // On such cases we need to restore the original tree structure.
    const modifiedChildren = children.filter(child => children.includes(child.$TST.parent));
    log(' modifiedChildren: ', modifiedChildren);
    if (modifiedChildren.length > 0) {
      for (const child of modifiedChildren) {
        await Tree.detachTab(child, {
          broadcast: true,
        });
        await Tree.attachTabTo(child, openedGroupTab, {
          dontMove:  true,
          broadcast: true,
        });
      }
    }
  }
  else {
    log(' => no need to group left tabs, just detaching');
    await Tree.detachAllChildren(tab, {
      behavior: TreeBehavior.getParentTabOperationBehavior(tab, {
        context: Constants.kPARENT_TAB_OPERATION_CONTEXT_CLOSE,
        preventEntireTreeBehavior: true,
      }),
      broadcast: true
    });
  }
  await Tree.detachTab(tab, {
    broadcast: true
  });

  // Such a group tab will be closed automatically when all children are detached.
  // To prevent the auto close behavior, the tab type need to be turned to permanent.
  await clearTemporaryState(tab);

  if (tab.$TST.isGroupTab && openedGroupTab) {
    const url = new URL(tab.url);
    url.searchParams.set('aliasTabId', openedGroupTab.$TST.uniqueId.id);
    await Promise.all([
      browser.tabs.sendMessage(tab.id, {
        type: 'ws:replace-state-url',
        url: url.href,
      }).catch(ApiTabs.createErrorHandler()),
      browser.tabs.executeScript(tab.id, { // failsafe
        runAt: 'document_start',
        code:  `history.replaceState({}, document.title, ${JSON.stringify(url.href)});`,
      }).catch(ApiTabs.createErrorHandler()),
    ]);
    await browser.tabs.sendMessage(tab.id, {
      type: 'ws:update-tree',
      url: url.href,
    }).catch(ApiTabs.createErrorHandler());
    tab.url = url.href;
  }
});

Tree.onAttached.addListener((tab, _info = {}) => {
  reserveToUpdateRelatedGroupTabs(tab, ['tree']);
});

Tree.onDetached.addListener((_tab, detachInfo) => {
  if (!detachInfo.oldParentTab)
    return;
  if (detachInfo.oldParentTab.$TST.isGroupTab)
    reserveToCleanupNeedlessGroupTab(detachInfo.oldParentTab);
  reserveToUpdateRelatedGroupTabs(detachInfo.oldParentTab, ['tree']);
});

/*
Tree.onSubtreeCollapsedStateChanging.addListener((tab, _info) => {
  reserveToUpdateRelatedGroupTabs(tab);
});
*/
