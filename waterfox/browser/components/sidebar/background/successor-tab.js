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
  wait,
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from '/common/constants.js';
import * as SidebarConnection from '/common/sidebar-connection.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TreeBehavior from '/common/tree-behavior.js';

import Tab from '/common/Tab.js';

import * as Tree from './tree.js';

function log(...args) {
  internalLogger('background/successor-tab', ...args);
}

const mTabsToBeUpdated = new Set();
const mInProgressUpdates = new Set();

const mPromisedUpdatedSuccessorTabId = new Map();

browser.tabs.onUpdated.addListener((tabId, updateInfo, _tab) => {
  if (!('successorTabId' in updateInfo) ||
      !mPromisedUpdatedSuccessorTabId.has(tabId))
    return;
  const promisedUpdate = mPromisedUpdatedSuccessorTabId.get(tabId);
  mPromisedUpdatedSuccessorTabId.delete(tabId);
  promisedUpdate.resolver(updateInfo.successorTabId);
}, {
  // we cannot watch only the property...
  // properties: ['successorTabId'],
});

TabsInternalOperation.onBeforeTabsRemove.addListener(async tabs => {
  let activeTab = null;
  const tabIds = tabs.map(tab => {
    if (tab.active)
      activeTab = tab;
    return tab.id;
  });
  if (activeTab)
    await updateInternal(activeTab.id, tabIds);
});

function setSuccessor(tabId, successorTabId = -1) {
  const tab          = Tab.get(tabId);
  const successorTab = Tab.get(successorTabId);
  if (configs.successorTabControlLevel == Constants.kSUCCESSOR_TAB_CONTROL_NEVER ||
      !tab ||
      !successorTab ||
      tab.windowId != successorTab.windowId)
    return;

  const promisedUpdate = {};
  promisedUpdate.promisedSuccessorTabId = new Promise((resolve, _reject) => {
    promisedUpdate.resolver = resolve;
    setTimeout(() => {
      if (!mPromisedUpdatedSuccessorTabId.has(tabId))
        return;
      mPromisedUpdatedSuccessorTabId.delete(tabId);
      resolve(null);
    }, 2000);
  });
  mPromisedUpdatedSuccessorTabId.set(tabId, promisedUpdate);

  const initialSuccessorTabId = tab.successorTabId;
  browser.tabs.update(tabId, {
    successorTabId
  }).then(async () => {
    // tabs.onUpdated listener won't be called sometimes, so this is a failsafe.
    while (true) {
      const promisedUpdate = mPromisedUpdatedSuccessorTabId.get(tabId);
      if (!promisedUpdate)
        break;

      const tab = await browser.tabs.get(tabId);
      if (tab.successorTabId == initialSuccessorTabId &&
          tab.successorTabId != successorTabId) {
        await wait(200);
        continue;
      }

      mPromisedUpdatedSuccessorTabId.delete(tabId);
      promisedUpdate.resolver(tab.successorTabId);
    }
  }).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError, error => {
    // ignore error for already closed tab
    if (!error ||
        !error.message ||
        (error.message.indexOf('Invalid successorTabId') != 0 &&
         // This error may happen at the time just after a tab is detached from its original window.
         error.message.indexOf('Successor tab must be in the same window as the tab being updated') != 0))
      throw error;
  }));
}

function clearSuccessor(tabId) {
  setSuccessor(tabId, -1);
}


function update(tabId) {
  mTabsToBeUpdated.add(tabId);
  if (mInProgressUpdates.size == 0) {
    const waitingUpdate = new Promise((resolve, _reject) => {
      const timer = setInterval(() => {
        if (mInProgressUpdates.size > 1)
          return;
        clearInterval(timer);
        resolve();
      }, 100);
    });
    waitingUpdate.catch(_error => {}).then(() => mInProgressUpdates.delete(waitingUpdate));
    mInProgressUpdates.add(waitingUpdate);
  }
  setTimeout(() => {
    const ids = Array.from(mTabsToBeUpdated);
    mTabsToBeUpdated.clear();
    for (const id of ids) {
      if (!id)
        continue;
      try {
        const promisedUpdate = updateInternal(id);
        const promisedUpdateWithTimeout = new Promise((resolve, reject) => {
          promisedUpdate.then(resolve).catch(reject);
          setTimeout(resolve, 1000);
        });
        mInProgressUpdates.add(promisedUpdateWithTimeout);
        promisedUpdateWithTimeout.catch(_error => {}).then(() => mInProgressUpdates.delete(promisedUpdateWithTimeout));
      }
      catch(_error) {
      }
    }
  }, 0);
}
async function updateInternal(tabId, excludeTabIds = []) {
  // tabs.onActivated can be notified before the tab is completely tracked...
  await Tab.waitUntilTracked(tabId);
  const tab = Tab.get(tabId);
  if (!tab)
    return;

  const promisedUpdate = mPromisedUpdatedSuccessorTabId.get(tabId);
  await Promise.all([
    tab.$TST.opened,
    promisedUpdate && promisedUpdate.promisedSuccessorTabId,
  ]);

  const renewedTab = await browser.tabs.get(tabId).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
  if (!renewedTab ||
      !TabsStore.ensureLivingTab(tab))
    return;
  log('updateInternal: ', dumpTab(tab), {
    tabSuccessorTabId: tab.successorTabId,
    renewedSuccessorTabId: renewedTab.successorTabId,
    lastSuccessorTabIdByOwner: tab.$TST.temporaryMetadata.get('lastSuccessorTabIdByOwner'),
    lastSuccessorTabId: tab.$TST.temporaryMetadata.get('lastSuccessorTabId'),
  });
  if (tab.$TST.temporaryMetadata.has('lastSuccessorTabIdByOwner')) {
    log('respect last successor by owner');
    const successor = Tab.get(renewedTab.successorTabId);
    if (successor) {
      log(`  ${dumpTab(tab)} is already prepared for "selectOwnerOnClose" behavior (successor=${renewedTab.successorTabId})`);
      return;
    }
    log(`  clear successor of ${dumpTab(tab)}`);
    tab.$TST.temporaryMetadata.delete('lastSuccessorTabIdByOwner');
    tab.$TST.temporaryMetadata.delete('lastSuccessorTabId');
    clearSuccessor(tab.id);
  }
  const lastSuccessorTab = tab.$TST.temporaryMetadata.has('lastSuccessorTabId') && Tab.get(tab.$TST.temporaryMetadata.get('lastSuccessorTabId'));
  if (!lastSuccessorTab) {
    log(`  ${dumpTab(tab)}'s successor is missing: it was already closed.`);
  }
  else {
    log(`  ${dumpTab(tab)} is under control: `, {
      successorTabId: renewedTab.successorTabId,
      lastSuccessorTabId: tab.$TST.temporaryMetadata.get('lastSuccessorTabId'),
    });
    if (renewedTab.successorTabId != -1 &&
        renewedTab.successorTabId != tab.$TST.temporaryMetadata.get('lastSuccessorTabId')) {
      log(`  ${dumpTab(tab)}'s successor is modified by someone! Now it is out of control.`);
      tab.$TST.temporaryMetadata.delete('lastSuccessorTabId');
      return;
    }
  }
  tab.$TST.temporaryMetadata.delete('lastSuccessorTabId');
  if (configs.successorTabControlLevel == Constants.kSUCCESSOR_TAB_CONTROL_NEVER)
    return;
  let successor = null;
  if (renewedTab.active) {
    log('it is active, so reset successor');
    const excludeTabIdsSet = new Set(excludeTabIds);
    const findSuccessor = (...candidates) => {
      for (const candidate of candidates) {
        if (!excludeTabIdsSet.has(candidate?.id) &&
            candidate)
          return candidate;
      }
      return null;
    };
    if (configs.successorTabControlLevel == Constants.kSUCCESSOR_TAB_CONTROL_IN_TREE) {
      const closeParentBehavior = TreeBehavior.getParentTabOperationBehavior(tab, {
        context: Constants.kPARENT_TAB_OPERATION_CONTEXT_CLOSE,
        parent: tab.$TST.parent,
        windowId: tab.windowId,
      });
      const collapsedChildSuccessorAllowed = (
        closeParentBehavior != Constants.kPARENT_TAB_OPERATION_BEHAVIOR_ENTIRE_TREE &&
        closeParentBehavior != Constants.kPARENT_TAB_OPERATION_BEHAVIOR_REPLACE_WITH_GROUP_TAB
      );
      const firstChild = collapsedChildSuccessorAllowed ? tab.$TST.firstChild : tab.$TST.firstVisibleChild;
      const nextVisibleSibling = tab.$TST.nextVisibleSiblingTab;
      const nearestVisiblePreceding = tab.$TST.nearestVisiblePrecedingTab;
      successor = findSuccessor(
        firstChild,
        nextVisibleSibling,
        nearestVisiblePreceding
      );
      log(`  possible successor: ${dumpTab(tab)}: `, successor, {
        closeParentBehavior,
        collapsedChildSuccessorAllowed,
        parent: tab.$TST.parentId,
        firstChild: firstChild?.id,
        nextVisibleSibling: nextVisibleSibling?.id,
        nearestVisiblePreceding: nearestVisiblePreceding?.id,
      });
      if (successor &&
          successor.discarded &&
          configs.avoidDiscardedTabToBeActivatedIfPossible) {
        log(`  ${dumpTab(successor)} is discarded.`);
        successor = findSuccessor(
          tab.$TST.nearestLoadedSiblingTab,
          tab.$TST.nearestLoadedTabInTree,
          tab.$TST.nearestLoadedTab,
          successor
        );
        log(`  => redirected successor is: ${dumpTab(successor)}`);
      }
    }
    else {
      successor = findSuccessor(
        tab.$TST.nearestVisibleFollowingTab,
        tab.$TST.nearestVisiblePrecedingTab
      );
      log(`  possible successor: ${dumpTab(tab)}`);
      if (successor &&
          successor.discarded &&
          configs.avoidDiscardedTabToBeActivatedIfPossible) {
        log(`  ${dumpTab(successor)} is discarded.`);
        successor = findSuccessor(
          tab.$TST.nearestLoadedTab,
          successor
        );
        log(`  => redirected successor is: ${dumpTab(successor)}`);
      }
    }
  }
  if (successor) {
    log(`  ${dumpTab(tab)} is under control: successor = ${successor.id}`);
    setSuccessor(renewedTab.id, successor.id);
    tab.$TST.temporaryMetadata.set('lastSuccessorTabId', successor.id);
  }
  else {
    log(`  ${dumpTab(tab)} is out of control.`, {
      active: renewedTab.active,
    });
    clearSuccessor(renewedTab.id);
  }
}

async function tryClearOwnerSuccessor(tab) {
  if (!tab ||
      !tab.$TST.temporaryMetadata.get('lastSuccessorTabIdByOwner'))
    return;
  tab.$TST.temporaryMetadata.delete('lastSuccessorTabIdByOwner');
  const renewedTab = await browser.tabs.get(tab.id).catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
  if (!renewedTab ||
      renewedTab.successorTabId != tab.$TST.temporaryMetadata.get('lastSuccessorTabId'))
    return;
  log(`${dumpTab(tab)} is unprepared for "selectOwnerOnClose" behavior`);
  tab.$TST.temporaryMetadata.delete('lastSuccessorTabId');
  clearSuccessor(tab.id);
}

Tab.onActivated.addListener(async (newActiveTab, info = {}) => {
  update(newActiveTab.id);
  if (info.previousTabId) {
    const oldActiveTab = Tab.get(info.previousTabId);
    if (oldActiveTab) {
      await tryClearOwnerSuccessor(oldActiveTab);
      const lastRelatedTab = oldActiveTab.$TST.lastRelatedTab;
      const newRelatedTabsCount = oldActiveTab.$TST.newRelatedTabsCount;
      if (lastRelatedTab) {
        log(`clear lastRelatedTabs for the window ${info.windowId} by tabs.onActivated on ${newActiveTab.id}`);
        TabsStore.windows.get(info.windowId).clearLastRelatedTabs();
        if (lastRelatedTab.id != newActiveTab.id) {
          log(`non last-related-tab is activated: cancel "back to owner" behavior for ${lastRelatedTab.id}`);
          await tryClearOwnerSuccessor(lastRelatedTab);
        }
      }
      if (newRelatedTabsCount > 1) {
        log(`multiple related tabs were opened: cancel "back to owner" behavior for ${newActiveTab.id}`);
        await tryClearOwnerSuccessor(newActiveTab);
      }
    }
    update(info.previousTabId);
  }
});

Tab.onCreating.addListener((tab, info = {}) => {
  if (!info.activeTab)
    return;

  const shouldControlSuccesor = (
    configs.successorTabControlLevel != Constants.kSUCCESSOR_TAB_CONTROL_NEVER &&
    configs.simulateSelectOwnerOnClose
  );

  log(`Tab.onCreating: should control succesor of ${tab.id}: `, shouldControlSuccesor);
  if (shouldControlSuccesor) {
    // don't use await here, to prevent that other onCreating handlers are treated async.
    tryClearOwnerSuccessor(info.activeTab).then(() => {
      const ownerTabId = tab.openerTabId || tab.active ? info.activeTab.id : null
      if (!ownerTabId)
        return;

      log(`${dumpTab(tab)} is prepared for "selectOwnerOnClose" behavior (successor=${ownerTabId})`);
      setSuccessor(tab.id, ownerTabId);
      tab.$TST.temporaryMetadata.set('lastSuccessorTabId', ownerTabId);
      tab.$TST.temporaryMetadata.set('lastSuccessorTabIdByOwner', true);

      if (!tab.openerTabId)
        return;

      const opener = Tab.get(tab.openerTabId);
      const lastRelatedTab = opener && opener.$TST.lastRelatedTab;
      log(`opener ${dumpTab(opener)}'s lastRelatedTab: ${dumpTab(lastRelatedTab)})`);
      if (lastRelatedTab) {
        log(' => clear successor');
        tryClearOwnerSuccessor(lastRelatedTab);
      }
      opener.$TST.lastRelatedTab = tab;
    });
  }
  else {
    const opener = Tab.get(tab.openerTabId);
    if (opener)
      opener.$TST.lastRelatedTab = tab;
  }
});

function updateActiveTab(windowId) {
  const activeTab = Tab.getActiveTab(windowId);
  if (activeTab)
    update(activeTab.id);
}

Tab.onCreated.addListener((tab, _info = {}) => {
  updateActiveTab(tab.windowId);
});

Tab.onRemoving.addListener((tab, removeInfo = {}) => {
  if (removeInfo.isWindowClosing)
    return;

  const lastRelatedTab = tab.$TST.lastRelatedTab;
  if (lastRelatedTab &&
      !lastRelatedTab.active)
    tryClearOwnerSuccessor(lastRelatedTab);
});

Tab.onRemoved.addListener((tab, info = {}) => {
  updateActiveTab(info.windowId);

  const win = TabsStore.windows.get(info.windowId);
  if (!win)
    return;
  log(`clear lastRelatedTabs for ${info.windowId} by tabs.onRemoved`);
  win.clearLastRelatedTabs();
});

Tab.onMoved.addListener((tab, info = {}) => {
  updateActiveTab(tab.windowId);

  if (!info.byInternalOperation) {
    log(`clear lastRelatedTabs for ${tab.windowId} by tabs.onMoved`);
    TabsStore.windows.get(info.windowId).clearLastRelatedTabs();
  }
});

Tab.onAttached.addListener((_tab, info = {}) => {
  updateActiveTab(info.newWindowId);
});

Tab.onDetached.addListener((_tab, info = {}) => {
  updateActiveTab(info.oldWindowId);

  const win = TabsStore.windows.get(info.oldWindowId);
  if (win) {
    log(`clear lastRelatedTabs for ${info.windowId} by tabs.onDetached`);
    win.clearLastRelatedTabs();
  }
});

Tab.onUpdated.addListener((tab, changeInfo = {}) => {
  if (!('discarded' in changeInfo))
    return;
  updateActiveTab(tab.windowId);
});

Tab.onShown.addListener(tab => {
  updateActiveTab(tab.windowId);
});

Tab.onHidden.addListener(tab => {
  updateActiveTab(tab.windowId);
});

Tree.onAttached.addListener((child, { parent } = {}) => {
  updateActiveTab(child.windowId);

  const lastRelatedTabId = parent.$TST.lastRelatedTabId;
  if (lastRelatedTabId &&
      child.$TST.previousSiblingTab &&
      lastRelatedTabId == child.$TST.previousSiblingTab.id)
    parent.$TST.lastRelatedTab = child;
});

Tree.onDetached.addListener((child, _info = {}) => {
  updateActiveTab(child.windowId);
});

Tree.onSubtreeCollapsedStateChanging.addListener((tab, _info = {}) => {
  updateActiveTab(tab.windowId);
});

SidebarConnection.onConnected.addListener((windowId, _openCount) => {
  updateActiveTab(windowId);
});

SidebarConnection.onDisconnected.addListener((windowId, _openCount) => {
  updateActiveTab(windowId);
});

// for automated test
browser.runtime.onMessage.addListener((message, _sender) => {
  if (!message || !message.type)
    return;

  switch (message.type) {
    case Constants.kCOMMAND_WAIT_UNTIL_SUCCESSORS_UPDATED:
      return Promise.all([...mInProgressUpdates]);
  }
});
