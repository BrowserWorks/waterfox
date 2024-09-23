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
  isMacOS,
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from '/common/constants.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TreeBehavior from '/common/tree-behavior.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';

import * as Commands from './commands.js';
import * as TabsGroup from './tabs-group.js';
import * as Tree from './tree.js';
import * as TreeStructure from './tree-structure.js';

function log(...args) {
  internalLogger('background/handle-moved-tabs', ...args);
}
function logApiTabs(...args) {
  internalLogger('common/api-tabs', ...args);
}


let mMaybeTabMovingByShortcut = false;


Tab.onCreated.addListener((tab, info = {}) => {
  if (!info.mayBeReplacedWithContainer &&
      (info.duplicated ||
       info.restored ||
       info.skipFixupTree ||
       // do nothing for already attached tabs
       (tab.openerTabId &&
        tab.$TST.parent == Tab.get(tab.openerTabId)))) {
    log('skip to fixup tree for replaced/duplicated/restored tab ', tab, info);
    return;
  }
  // if the tab is opened inside existing tree by someone, we must fixup the tree.
  if (!(info.positionedBySelf ||
        info.movedBySelfWhileCreation) &&
      (tab.$TST.nearestCompletelyOpenedNormalFollowingTab ||
       tab.$TST.nearestCompletelyOpenedNormalPrecedingTab ||
       (info.treeForActionDetection?.target &&
        (info.treeForActionDetection.target.next ||
         info.treeForActionDetection.target.previous)))) {
    tryFixupTreeForInsertedTab(tab, {
      toIndex:   tab.index,
      fromIndex: Tab.getLastTab(tab.windowId).index,
      treeForActionDetection: info.treeForActionDetection,
      isTabCreating: true
    });
  }
  else {
    log('no need to fixup tree for newly created tab ', tab, info);
  }
});

Tab.onMoving.addListener((tab, moveInfo) => {
  // avoid TabMove produced by browser.tabs.insertRelatedAfterCurrent=true or something.
  const win              = TabsStore.windows.get(tab.windowId);
  const isNewlyOpenedTab = win.openingTabs.has(tab.id);
  const positionControlled = configs.insertNewChildAt != Constants.kINSERT_NO_CONTROL;
  if (!isNewlyOpenedTab ||
      !positionControlled ||
      moveInfo.byInternalOperation ||
      moveInfo.alreadyMoved ||
      !moveInfo.movedInBulk)
    return true;

  // if there is no valid opener, it can be a restored initial tab in a restored window
  // and can be just moved as a part of window restoration process.
  if (!tab.$TST.openerTab)
    return true;

  log('onTabMove for new child tab: move back '+moveInfo.toIndex+' => '+moveInfo.fromIndex);
  moveBack(tab, moveInfo);
  return false;
});

async function tryFixupTreeForInsertedTab(tab, moveInfo = {}) {
  const parentTabOperationBehavior = TreeBehavior.getParentTabOperationBehavior(tab, {
    context: Constants.kPARENT_TAB_OPERATION_CONTEXT_MOVE,
    ...moveInfo,
  });
  log('tryFixupTreeForInsertedTab ', {
    tab: tab.id,
    parentTabOperationBehavior,
    moveInfo,
    childIds: tab.$TST.childIds,
    parentId: tab.$TST.parentId,
  });
  if (!moveInfo.isTabCreating &&
      parentTabOperationBehavior != Constants.kPARENT_TAB_OPERATION_BEHAVIOR_ENTIRE_TREE) {
    if (tab.$TST.hasChild)
      tab.$TST.temporaryMetadata.set('childIdsBeforeMoved', tab.$TST.childIds.slice(0));
    tab.$TST.temporaryMetadata.set('parentIdBeforeMoved', tab.$TST.parentId);
    const replacedGroupTab = (parentTabOperationBehavior == Constants.kPARENT_TAB_OPERATION_BEHAVIOR_REPLACE_WITH_GROUP_TAB) ?
      await TabsGroup.tryReplaceTabWithGroup(tab, { insertBefore: tab.$TST.firstChild }) :
      null;
    if (!replacedGroupTab && tab.$TST.hasChild) {
      if (tab.$TST.isGroupTab)
        await TabsGroup.clearTemporaryState(tab);
      await Tree.detachAllChildren(tab, {
        behavior:  parentTabOperationBehavior,
        nearestFollowingRootTab: tab.$TST.firstChild.$TST.nearestFollowingRootTab,
        broadcast: true
      });
    }
    if (tab.$TST.parentId)
      await Tree.detachTab(tab, {
        broadcast: true
      });
    // Pinned tab is moved at first, so Tab.onPinned handler cannot know tree information
    // before the pinned tab was moved. Thus we cache tree information for the handler.
    wait(100).then(() => {
      tab.$TST.temporaryMetadata.delete('childIdsBeforeMoved');
      tab.$TST.temporaryMetadata.delete('parentIdBeforeMoved');
    });
  }

  log('The tab can be placed inside existing tab unexpectedly, so now we are trying to fixup tree.');
  const action = Tree.detectTabActionFromNewPosition(tab, {
    isMovingByShortcut: mMaybeTabMovingByShortcut,
    ...moveInfo,
  });
  log(' => action: ', action);
  if (!action.action) {
    log('no action');
    return;
  }

  // When multiple tabs are moved at once by outside of TST (e.g. moving of multiselected tabs)
  // Tree.detectTabActionFromNewPosition() may be called for other tabs asynchronously
  // before this operation finishes. Thus we need to memorize the calculated "parent"
  // and Tree.detectTabActionFromNewPosition() will use it.
  if (action.parent)
    tab.$TST.temporaryMetadata.set('goingToBeAttachedTo', action.parent);

  // notify event to helper addons with action and allow or deny
  const cache = {};
  const allowed = await TSTAPI.tryOperationAllowed(
    TSTAPI.kNOTIFY_TRY_FIXUP_TREE_ON_TAB_MOVED,
    {
      tab,
      fromIndex:    moveInfo.fromIndex,
      toIndex:      moveInfo.toIndex,
      action:       action.action,
      parent:       action.parent,
      insertBefore: action.insertBefore,
      insertAfter:  action.insertAfter,
    },
    { tabProperties: ['tab', 'parent', 'insertBefore', 'insertAfter'], cache }
  );
  TSTAPI.clearCache(cache);

  if (!allowed) {
    log('no action - canceled by a helper addon');
  }
  else {
    log('action: ', action);
    switch (action.action) {
      case 'invalid':
        moveBack(tab, moveInfo);
        break;

      default:
        log('tryFixupTreeForInsertedTab: apply action for unattached tab: ', tab, action);
        await action.apply();
        break;
    }
  }

  if (tab.$TST.temporaryMetadata.get('goingToBeAttachedTo') == action.parent)
    tab.$TST.temporaryMetadata.delete('goingToBeAttachedTo');
}

function reserveToEnsureRootTabVisible(tab) {
  reserveToEnsureRootTabVisible.tabIds.add(tab.id);
  if (reserveToEnsureRootTabVisible.reserved)
    clearTimeout(reserveToEnsureRootTabVisible.reserved);
  reserveToEnsureRootTabVisible.reserved = setTimeout(() => {
    delete reserveToEnsureRootTabVisible.reserved;
    const tabs = Array.from(reserveToEnsureRootTabVisible.tabIds, Tab.get);
    reserveToEnsureRootTabVisible.tabIds.clear();
    for (const tab of tabs) {
      if (!tab.$TST ||
          tab.$TST.parent ||
          !tab.$TST.collapsed)
        continue;
      Tree.collapseExpandTabAndSubtree(tab, {
        collapsed: false,
        broadcast: true
      });
    }
  }, 150);
}
reserveToEnsureRootTabVisible.tabIds = new Set();

Tab.onMoved.addListener((tab, moveInfo = {}) => {
  if (moveInfo.byInternalOperation ||
      !moveInfo.movedInBulk ||
      tab.$TST.duplicating) {
    log('internal move');
  }
  else {
    log('process moved tab');
    tryFixupTreeForInsertedTab(tab, moveInfo);
  }
  reserveToEnsureRootTabVisible(tab);
});

function onMessage(message, _sender) {
  if (!message ||
      typeof message.type != 'string')
    return;

  //log('onMessage: ', message, sender);
  switch (message.type) {
    case Constants.kNOTIFY_TAB_MOUSEDOWN:
      mMaybeTabMovingByShortcut = false;
      break;

    case Constants.kCOMMAND_NOTIFY_MAY_START_TAB_SWITCH:
      if (message.modifier != (configs.accelKey || (isMacOS() ? 'meta' : 'control')))
        return;
      mMaybeTabMovingByShortcut = true;
      break;

    case Constants.kCOMMAND_NOTIFY_MAY_END_TAB_SWITCH:
      if (message.modifier != (configs.accelKey || (isMacOS() ? 'meta' : 'control')))
        return;
      mMaybeTabMovingByShortcut = false;
      break;
  }
}
browser.runtime.onMessage.addListener(onMessage);


Commands.onMoveUp.addListener(async tab => {
  await tryFixupTreeForInsertedTab(tab, {
    toIndex:   tab.index,
    fromIndex: tab.index + 1,
  });
});

Commands.onMoveDown.addListener(async tab => {
  await tryFixupTreeForInsertedTab(tab, {
    toIndex:   tab.index,
    fromIndex: tab.index - 1,
  });
});

TreeStructure.onTabAttachedFromRestoredInfo.addListener((tab, moveInfo) => { tryFixupTreeForInsertedTab(tab, moveInfo); });

function moveBack(tab, moveInfo) {
  log('Move back tab from unexpected move: ', dumpTab(tab), moveInfo);
  const id  = tab.id;
  const win = TabsStore.windows.get(tab.windowId);
  const index = moveInfo.fromIndex;
  win.internalMovingTabs.set(id, index);
  logApiTabs(`handle-moved-tabs:moveBack: browser.tabs.move() `, tab.id, {
    windowId: moveInfo.windowId,
    index:    moveInfo.fromIndex
  });
  // Because we need to use the raw "fromIndex" directly,
  // we cannot use TabsMove.moveTabInternallyBefore/After here.
  return browser.tabs.move(tab.id, {
    windowId: moveInfo.windowId,
    index:    moveInfo.fromIndex
  }).catch(ApiTabs.createErrorHandler(e => {
    if (win.internalMovingTabs.get(id) == index)
      win.internalMovingTabs.delete(id);
    ApiTabs.handleMissingTabError(e);
  }));
}
