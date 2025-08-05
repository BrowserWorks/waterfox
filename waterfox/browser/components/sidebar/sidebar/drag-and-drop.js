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
 * Portions created by the Initial Developer are Copyright (C) 2010-2025
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s): YUKI "Piro" Hiroshi <piro.outsider.reflex@gmail.com>
 *                 Infocatcher <https://github.com/Infocatcher>
 *                 Tetsuharu OHZEKI <https://github.com/saneyuki>
 *
 * ***** END LICENSE BLOCK ******/
'use strict';


import RichConfirm from '/extlib/RichConfirm.js';

import {
  log as internalLogger,
  wait,
  mapAndFilter,
  configs,
  shouldApplyAnimation,
  sha1sum,
  isMacOS,
  isLinux,
  isRTL,
  dumpTab,
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as BackgroundConnection from './background-connection.js';
import * as Constants from '/common/constants.js';
import * as EventUtils from './event-utils.js';
import * as RetrieveURL from '/common/retrieve-url.js';
import * as Scroll from './scroll.js';
import * as SidebarItems from './sidebar-items.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TreeBehavior from '/common/tree-behavior.js';
import * as TSTAPI from '/common/tst-api.js';

import { Tab, TabGroup, TreeItem } from '/common/TreeItem.js';

import * as Notifications from './notifications.js';
import * as Size from './size.js';

function log(...args) {
  internalLogger('sidebar/drag-and-drop', ...args);
}


const kTREE_DROP_TYPE   = 'application/x-ws-tree';
const kTYPE_ADDON_DRAG_DATA = `application/x-ws-drag-data;provider=${browser.runtime.id}&id=`;

const kDROP_BEFORE  = 'before';
const kDROP_ON_SELF = 'self';
const kDROP_AFTER   = 'after';
const kDROP_HEAD    = 'head';
const kDROP_TAIL    = 'tail';
const kDROP_IMPOSSIBLE = 'impossible';

const kDROP_POSITION = 'data-drop-position';
const kINLINE_DROP_POSITION = 'data-inline-drop-position';
const kNEXT_GROUP_COLOR = 'data-next-group-color';

let mLongHoverExpandedTabs = [];
let mLongHoverTimer;
let mLongHoverTimerNext;

let mDraggingOnSelfWindow = false;
let mDraggingOnDraggedItems = false;

let mCapturingForDragging = false;
let mReadyToCaptureMouseEvents = false;
let mLastDragEnteredTarget = null;
let mLastDropPosition      = null;
let mLastInlineDropPosition = null;
let mLastDragEventCoordinates = null;
let mDragTargetIsClosebox  = false;
let mCurrentDragData       = null;

let mInstanceId;

export function init() {
  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('dragend', onDragEnd);
  document.addEventListener('drop', onDrop);

  browser.runtime.onMessage.addListener(onMessage);

  browser.runtime.sendMessage({ type: Constants.kCOMMAND_GET_INSTANCE_ID }).then(id => mInstanceId = id);
}


export function isCapturingForDragging() {
  return mCapturingForDragging;
}

export function endMultiDrag(tab, coordinates) {
  if (mCapturingForDragging) {
    window.removeEventListener('mouseover', onTSTAPIDragEnter, { capture: true });
    window.removeEventListener('mouseout',  onTSTAPIDragExit, { capture: true });
    document.releaseCapture();

    TSTAPI.broadcastMessage({
      type:    TSTAPI.kNOTIFY_TAB_DRAGEND,
      tab,
      window:  tab?.windowId,
      windowId: tab?.windowId,
      clientX: coordinates.clientX,
      clientY: coordinates.clientY
    }, { tabProperties: ['tab'] }).catch(_error => {});

    mLastDragEnteredTarget = null;
  }
  else if (mReadyToCaptureMouseEvents) {
    TSTAPI.broadcastMessage({
      type:    TSTAPI.kNOTIFY_TAB_DRAGCANCEL,
      tab,
      window:  tab?.windowId,
      windowId: tab?.windowId,
      clientX: coordinates.clientX,
      clientY: coordinates.clientY
    }, { tabProperties: ['tab'] }).catch(_error => {});
  }
  mCapturingForDragging = false;
  mReadyToCaptureMouseEvents = false;
}

function setDragData(dragData) {
  return mCurrentDragData = dragData;
}


/* helpers */

function getDragDataFromOneItem(item, options = {}) {
  const sessionId = `${Date.now()}-${Math.floor(Math.random() * 65000)}`;
  if (!item)
    return {
      tab:      null,
      tabs:     [],
      item:     null,
      items:    [],
      structure:      [],
      nextGroupColor: TabGroup.getNextUnusedColor(),
      windowId:       null,
      instanceId:     mInstanceId,
      sessionId,
    };
  const items = getDraggedItemsFromOneItem(item, options);
  const tab  = item.$TST.tab;
  const tabs = items.filter(item => item.type == TreeItem.TYPE_TAB);
  return {
    item,
    items,
    tab,
    tabs,
    structure:      TreeBehavior.getTreeStructureFromTabs(tabs),
    nextGroupColor: TabGroup.getNextUnusedColor(),
    windowId:       item.windowId,
    instanceId:     mInstanceId,
    sessionId,
  };
}

function getDraggedItemsFromOneItem(item, { asTree } = {}) {
  if (item.$TST.group) {
    return [item];
  }
  if (item.$TST.multiselected) {
    return Tab.getSelectedTabs(item.windowId);
  }
  if (asTree) {
    return [item].concat(item.$TST.descendants);
  }
  return [item];
}

function sanitizeDragData(dragData) {
  return {
    item:       dragData.item?.$TST.sanitized,
    items:      dragData.items.map(item => item?.$TST.sanitized),
    tab:        dragData.tab?.$TST.sanitized,
    tabs:       dragData.tabs.map(tab => tab?.$TST.sanitized),
    structure:  dragData.structure,
    nextGroupColor: dragData.nextGroupColor,
    windowId:   dragData.windowId,
    instanceId: dragData.instanceId,
    sessionId:  dragData.sessionId,
    behavior:   dragData.behavior,
    individualOnOutside: dragData.individualOnOutside,
  };
}

function getDropAction(event) {
  const dragOverItem = EventUtils.getTreeItemFromEvent(event);
  const targetItem   = dragOverItem || EventUtils.getTreeItemFromTabbarEvent(event);
  const info = {
    dragOverItem,
    targetItem,
    substanceTargetItem: targetItem?.pinned && targetItem.$TST.bundledTab,
    dropPosition:  null,
    inlineDropPosition: '',
    action:        null,
    parent:        null,
    insertBefore:  null,
    insertAfter:   null,
    defineGetter(name, getter) {
      delete this[name];
      Object.defineProperty(this, name, {
        get() {
          delete this[name];
          return this[name] = getter.call(this);
        },
        configurable: true,
        enumerable:   true
      });
    }
  };
  info.defineGetter('dragData', () => {
    const dragData = event.dataTransfer.getData(kTREE_DROP_TYPE);
    return (dragData && JSON.parse(dragData)) || mCurrentDragData;
  });
  info.defineGetter('draggedItem', () => {
    const dragData = info.dragData;
    if (dragData?.instanceId != mInstanceId)
      return null;
    const item = dragData?.item;
    return TreeItem.get(item) || item;
  });
  info.defineGetter('draggedItems', () => {
    const dragData = info.dragData;
    if (dragData?.instanceId != mInstanceId)
      return [];
    const itemIds = dragData?.items;
    return !itemIds ? [] : mapAndFilter(itemIds, id =>
      Tab.get(id) ||
      TabGroup.get(id) ||
      undefined
    );
  });
  info.defineGetter('draggedItemIds', () => {
    return info.draggedItems.map(item => item.id);
  });
  info.defineGetter('firstTargetableItem', () => {
    const items = Scroll.getRenderableTreeItems();
    return items.length > 0 ? items[0] : Tab.getFirstTab(TabsStore.getCurrentWindowId());
  });
  info.defineGetter('lastTargetableItem', () => {
    const items = Scroll.getRenderableTreeItems();
    return items.length > 0 ? items[items.length - 1] : Tab.getLastTab(TabsStore.getCurrentWindowId());
  });
  info.defineGetter('sanitizedDropOnTargetItem', () => { // the drop target we are trying to drop on itself
    return info.dropPosition == kDROP_ON_SELF ?
      (targetItem?.$TST.sanitized || targetItem) :
      null;
  });
  info.defineGetter('sanitizedDropBeforeTargetItem', () => { // the drop target we are trying to drop before it
    return info.dropPosition == kDROP_BEFORE ?
      (targetItem?.$TST.sanitized || targetItem) :
      null;
  });
  info.defineGetter('sanitizedDropAfterTargetItem', () => { // the drop target we are trying to drop after it
    return info.dropPosition == kDROP_AFTER ?
      (targetItem?.$TST.sanitized || targetItem) :
      null;
  });
  info.defineGetter('groupId', () => { // the group ID the dropped items should be grouped under
    if (!targetItem) {
      return null;
    }
    const draggedGroup = info.draggedItem?.type == TreeItem.TYPE_GROUP ? info.draggedItem : null;
    switch (info.dropPosition) {
      case kDROP_ON_SELF:
      default:
        return targetItem.groupId || targetItem.id;

      case kDROP_AFTER:
        if (targetItem.type == TreeItem.TYPE_GROUP) {
          return targetItem.collapsed ?
            draggedGroup?.id : // dropping after a collapsed group => keep the original group
            targetItem.id; // otherwise we try to insert items at the top of a group
        }
        return targetItem.groupId == -1 ?
          draggedGroup?.id : // dropping after ungrouped tab => keep the original group
          targetItem.groupId; // otherwise we try to add items to the group of the tab

      case kDROP_BEFORE:
        if (targetItem.type == TreeItem.TYPE_GROUP) {
          const previousTab = targetItem.$TST?.firstMember?.$TST?.unsafePreviousTab;
          if (!draggedGroup &&
              (previousTab?.$TST?.nativeTabGroup?.collapsed ||
               (previousTab &&
                previousTab.groupId != -1 &&
                info.draggedItems.some(tab => tab == previousTab)))) {
            // Keep dropped tabs ungrouped (or remove from groups) when tabs are explicitly dropped between groups
            return -1;
          }
          return previousTab?.groupId || -1;
        }
        return targetItem.groupId == -1 ?
          draggedGroup?.id : // dropping before ungrouped tab => keep the original group
          targetItem.groupId; // otherwise we are trying to add items to the group of the tab
    }
  });
  info.defineGetter('canDrop', () => {
    if (info.dropPosition == kDROP_IMPOSSIBLE) {
      log('canDrop:undroppable: dropPosition == kDROP_IMPOSSIBLE');
      return false;
    }

    const draggedItem = info.dragData?.item;
    const isPrivateBrowsingTabDragged = draggedItem?.incognito;
    const isPrivateBrowsingDropTarget = (info.dragOverItem || Tab.getFirstTab(TabsStore.getCurrentWindowId())).incognito;
    if (draggedItem &&
        isPrivateBrowsingTabDragged != isPrivateBrowsingDropTarget) {
      log('canDrop:undroppable: mismatched incognito status');
      return false;
    }
    else if (info.draggedItem) {
      if (info.action & Constants.kACTION_ATTACH) {
        if (info.draggedItem.windowId != TabsStore.getCurrentWindowId()) {
          return true;
        }
        if (!configs.moveSoloTabOnDropParentToDescendant &&
            info.parent?.id == info.draggedItem.id) {
          log('canDrop:undroppable: drop on child');
          return false;
        }
        if (info.dragOverItem) {
          if (info.draggedItem.id == info.dragOverItem.id) {
            log('canDrop:undroppable: on self');
            return false;
          }
          if (info.draggedItem.highlighted &&
              info.dragOverItem.highlighted &&
              info.draggedItemIds.includes(info.dragOverItem.id)) {
            log('canDrop:undroppable: on dragging multiselected tabs');
            return false;
          }
          if (configs.moveSoloTabOnDropParentToDescendant)
            return true;
          const ancestors = info.dragOverItem.$TST.ancestors;
          /* too many function call in this way, so I use alternative way for better performance.
          return !info.draggedItemIds.includes(info.dragOverItem.id) &&
                   Tab.collectRootTabs(info.draggedItems).every(rootTab =>
                     !ancestors.includes(rootTab)
                   );
          */
          for (const item of info.draggedItems.slice(0).reverse()) {
            const parent = item.$TST.parent;
            if (!parent && ancestors.includes(parent)) {
              log('canDrop:undroppable: on descendant');
              return false;
            }
          }
          return true;
        }
      }
    }

    if (info.dragOverItem &&
        (info.dragOverItem.hidden ||
         (info.dragOverItem.$TST.collapsed &&
          info.dropPosition != kDROP_AFTER))) {
      log('canDrop:undroppable: on hidden tab');
      return false;
    }

    return true;
  });
  info.defineGetter('canCreateGroup', () => {
    if (!configs.tabGroupsEnabled ||
        !targetItem ||
        targetItem.groupId != -1 ||
        [targetItem, ...info.draggedItems].some(item => item?.type != TreeItem.TYPE_TAB || item?.pinned || item.groupId != -1)) {
      return false;
    }
    return info.dropPosition == kDROP_ON_SELF && info.inlineDropPosition == kDROP_HEAD;
  });
  info.defineGetter('EventUtils.isCopyAction', () => EventUtils.isCopyAction(event));
  info.defineGetter('dropEffect', () => getDropEffectFromDropAction(info));

  if (!targetItem) {
    //log('dragging on non-tab element');
    const action = Constants.kACTION_MOVE | Constants.kACTION_DETACH;
    if (event.clientY < Scroll.getItemRect(info.firstTargetableItem).top) {
      //log('dragging above the first tab');
      info.targetItem   = info.insertBefore = info.firstTargetableItem;
      info.dropPosition = kDROP_BEFORE;
      info.action       = action;
      if (info.draggedItem &&
          !info.draggedItem.pinned &&
          info.targetItem.pinned) {
        log('undroppable: above the first tab');
        info.dropPosition = kDROP_IMPOSSIBLE;
      }
    }
    else if (event.clientY > Scroll.getItemRect(info.lastTargetableItem).bottom) {
      //log('dragging below the last tab');
      info.targetItem   = info.insertAfter = info.lastTargetableItem;
      info.dropPosition = kDROP_AFTER;
      info.action       = action;
      if (info.draggedItem?.pinned &&
          !info.targetItem.pinned) {
        log('undroppable: below the last tab');
        info.dropPosition = kDROP_IMPOSSIBLE;
      }
    }
    return info;
  }

  /**
   * Basically, tabs should have three areas for dropping of items:
   * [start][center][end], but, pinned tabs couldn't have its tree.
   * So, if a tab is dragged and the target tab is pinned, then, we
   * have to ignore the [center] area.
   */
  const onFaviconizedTab    = targetItem.pinned && configs.faviconizePinnedTabs;
  const dropAreasCount      = (
    info.draggedItem &&
    ((targetItem.pinned && !info.substanceTargetItem) ||
     (info.draggedItem.type == TreeItem.TYPE_GROUP &&
      targetItem.type != TreeItem.TYPE_GROUP))
  ) ? 2 : 3 ;
  const targetItemRect       = Scroll.getItemRect(targetItem);
  const targetItemCoordinate = onFaviconizedTab ? targetItemRect.left : targetItemRect.top ;
  const targetItemSize       = onFaviconizedTab ? targetItemRect.width : targetItemRect.height ;
  let beforeOrAfterDropAreaSize;
  if (dropAreasCount == 2) {
    beforeOrAfterDropAreaSize = Math.round(targetItemSize / dropAreasCount);
  }
  else { // enlarge the area to dop something on the tab itself
    beforeOrAfterDropAreaSize = Math.round(targetItemSize / 4);
  }
  const eventCoordinate = onFaviconizedTab ? event.clientX : event.clientY;
  /*
  log('coordinates: ', {
    event: eventCoordinate,
    targetItem: targetItemCoordinate,
    targetItemActual: configs.debug && (targetItem?.$TST.element?.offsetTop + Size.getScrollBoxRect().top),
    targetItemSize,
    area: beforeOrAfterDropAreaSize,
    before: `< ${targetItemCoordinate + beforeOrAfterDropAreaSize}`,
    after: `> ${targetItemCoordinate + targetItemSize - beforeOrAfterDropAreaSize}`,
  });
  */
  const shouldInvertArea = onFaviconizedTab && isRTL();
  if (eventCoordinate < targetItemCoordinate + beforeOrAfterDropAreaSize) {
    info.dropPosition = shouldInvertArea ? kDROP_AFTER : kDROP_BEFORE;
    info.insertBefore = info.firstTargetableItem;
  }
  else if (dropAreasCount == 2 ||
           eventCoordinate > targetItemCoordinate + targetItemSize - beforeOrAfterDropAreaSize) {
    info.dropPosition = shouldInvertArea ? kDROP_BEFORE : kDROP_AFTER;
    info.insertAfter  = info.lastTargetableItem;
  }
  else {
    info.dropPosition = kDROP_ON_SELF;
  }

  switch (info.dropPosition) {
    case kDROP_ON_SELF: {
      log('drop position = on ', info.targetItem.id);
      const insertAt = configs.insertDroppedTabsAt == Constants.kINSERT_INHERIT ? configs.insertNewChildAt : configs.insertDroppedTabsAt;
      info.action       = Constants.kACTION_ATTACH;
      info.parent       = info.substanceTargetItem || targetItem;
      info.insertBefore = insertAt == Constants.kINSERT_TOP ?
        (info.parent?.$TST.firstChild || info.parent?.$TST.unsafeNextTab /* instead of nearestVisibleFollowingTab, to avoid placing the tab after hidden tabs (too far from the target) */) :
        (info.parent?.$TST.nextSiblingTab || info.parent?.$TST.unsafeNearestFollowingForeignerTab /* instead of nearestFollowingForeignerTab, to avoid placing the tab after hidden tabs (too far from the target) */);
      info.insertAfter  = insertAt == Constants.kINSERT_TOP ?
        info.parent :
        (info.parent.$TST.lastDescendant || info.parent);
      if ((info.draggedItem && // we cannot drop pinned tab on unpinned tab, or unpinned tab on pinned tab
           !!info.draggedItem.pinned != !!targetItem.pinned &&
           !info.substanceTargetItem) ||
          (info.draggedItem?.type == TreeItem.TYPE_GROUP && // we cannot drop group on tab
           targetItem.type == TreeItem.TYPE_TAB))
        info.dropPosition = kDROP_IMPOSSIBLE;
      if (info.draggedItem &&
          info.insertBefore == info.draggedItem) // failsafe
        info.insertBefore = insertAt == Constants.kINSERT_TOP ?
          info.draggedItem.$TST.unsafeNextTab :
          (info.draggedItem.$TST.nextSiblingTab ||
           info.draggedItem.$TST.unsafeNearestFollowingForeignerTab);
      const isRightside = document.documentElement.classList.contains('right');
      const substanceElement = targetItem?.$TST?.element?.substanceElement;
      if (isRTL() == isRightside) {
        const neck = substanceElement.offsetLeft + Size.getFavIconSize();
        info.inlineDropPosition = event.clientX < neck ? kDROP_HEAD : kDROP_TAIL;
      }
      else {
        const neck = substanceElement.offsetLeft + substanceElement.offsetWidth - Size.getFavIconSize();
        info.inlineDropPosition = event.clientX > neck ? kDROP_HEAD : kDROP_TAIL;
      }
      if (configs.debug)
        log(' calculated info: ', info);
    }; break;

    case kDROP_BEFORE: {
      log('drop position = before ', info.targetItem.id);
      const referenceItems = TreeBehavior.calculateReferenceItemsFromInsertionPosition(info.draggedItem, {
        context:      Constants.kINSERTION_CONTEXT_MOVED,
        insertBefore: targetItem.$TST.firstMember || targetItem,
      });
      if (referenceItems.parent)
        info.parent = referenceItems.parent;
      if (referenceItems.insertBefore)
        info.insertBefore = referenceItems.insertBefore;
      if (referenceItems.insertAfter)
        info.insertAfter = referenceItems.insertAfter;
      info.action = Constants.kACTION_MOVE | (info.parent ? Constants.kACTION_ATTACH : Constants.kACTION_DETACH );
      //if (info.insertBefore)
      //  log('insertBefore = ', dumpTab(info.insertBefore));
      if ((info.draggedItem && // we cannot drop pinned tab beteen unpinned tabs, or unpinned tab between pinned tabs
           ((info.draggedItem.pinned &&
             targetItem.$TST.followsUnpinnedTab) ||
            (!info.draggedItem.pinned &&
             targetItem.pinned))) ||
          (info.draggedItem?.type == TreeItem.TYPE_GROUP && // we cannot drop group on its member
           targetItem.type == TreeItem.TYPE_TAB &&
           targetItem.groupId == info.draggedItem.id))
        info.dropPosition = kDROP_IMPOSSIBLE;
      if (configs.debug)
        log(' calculated info: ', info);
    }; break;

    case kDROP_AFTER: {
      log('drop position = after ', info.targetItem.id);
      const referenceItems = TreeBehavior.calculateReferenceItemsFromInsertionPosition(info.draggedItem, {
        insertAfter: targetItem.$TST.lastMember || (targetItem.$TST.subtreeCollapsed && targetItem.$TST.lastDescendant || targetItem),
      });
      if (referenceItems.parent)
        info.parent = referenceItems.parent;
      if (referenceItems.insertBefore)
        info.insertBefore = referenceItems.insertBefore;
      if (referenceItems.insertAfter)
        info.insertAfter = referenceItems.insertAfter;
      info.action = Constants.kACTION_MOVE | (info.parent ? Constants.kACTION_ATTACH : Constants.kACTION_DETACH );
      if (info.insertBefore) {
        /* strategy
             +-----------------------------------------------------
             |[TARGET   ]
             |     <= attach dragged tab to the parent of the target as its next sibling
             |  [DRAGGED]
             +-----------------------------------------------------
        */
        if (info.draggedItem &&
            info.draggedItem.$TST &&
            info.draggedItem.$TST.nearestVisibleFollowingTab &&
            info.draggedItem.$TST.nearestVisibleFollowingTab.id == info.insertBefore.id) {
          log('special case: promote tab');
          info.action      = Constants.kACTION_MOVE | Constants.kACTION_ATTACH;
          info.parent      = targetItem.$TST.parent;
          let insertBefore = targetItem.$TST.nextSiblingTab;
          let ancestor     = info.parent;
          while (ancestor && !insertBefore) {
            insertBefore = ancestor.$TST.nextSiblingTab;
            ancestor     = ancestor.$TST.parent;
          }
          info.insertBefore = insertBefore;
          info.insertAfter  = targetItem.$TST.lastDescendant;
        }
      }
      if ((info.draggedItem && // we cannot drop pinned tab beteen unpinned tabs, or unpinned tab between pinned tabs
           ((info.draggedItem.pinned &&
             !targetItem.pinned) ||
            (!info.draggedItem.pinned &&
             targetItem.$TST.precedesPinnedTab))) ||
          (info.draggedItem?.type == TreeItem.TYPE_GROUP && // we cannot drop group on its member
           targetItem.type == TreeItem.TYPE_TAB &&
           targetItem.groupId == info.draggedItem.id))
        info.dropPosition = kDROP_IMPOSSIBLE;
      if (configs.debug)
        log(' calculated info: ', info);
    }; break;
  }

  return info;
}
function getDropEffectFromDropAction(actionInfo) {
  if (!actionInfo.canDrop)
    return 'none';
  if (actionInfo.dragData &&
      actionInfo.dragData.instanceId != mInstanceId)
    return 'copy';
  if (!actionInfo.draggedItem)
    return 'link';
  if (actionInfo.isCopyAction)
    return 'copy';
  return 'move';
}

const mDropPositionHolderItems = new Set();

export function clearDropPosition() {
  for (const tab of mDropPositionHolderItems) {
    tab.$TST.removeAttribute(kDROP_POSITION);
    tab.$TST.removeAttribute(kINLINE_DROP_POSITION);
    tab.$TST.removeAttribute(kNEXT_GROUP_COLOR);
  }
  mDropPositionHolderItems.clear();
  configs.lastDragOverSidebarOwnerWindowId = null;
}

export function clearDraggingItemsState() {
  for (const tab of Tab.getDraggingTabs(TabsStore.getCurrentWindowId(), { iterator: true })) {
    tab.$TST.removeState(Constants.kTAB_STATE_DRAGGING);
    TabsStore.removeDraggingTab(tab);
  }
  for (const group of TabsStore.windows.get(TabsStore.getCurrentWindowId()).tabGroups.values()) {
    if (group.$TST.states.has(Constants.kTAB_STATE_DRAGGING)) {
      group.$TST.removeState(Constants.kTAB_STATE_DRAGGING);
    }
  }
}

export function clearDraggingState() {
  const win = TabsStore.windows.get(TabsStore.getCurrentWindowId());
  win.containerClassList.remove(Constants.kTABBAR_STATE_TAB_DRAGGING);
  win.pinnedContainerClassList.remove(Constants.kTABBAR_STATE_TAB_DRAGGING);
  document.documentElement.classList.remove(Constants.kTABBAR_STATE_TAB_DRAGGING);
  document.documentElement.classList.remove(Constants.kTABBAR_STATE_LINK_DRAGGING);
}

function isDraggingAllActiveTabs(tab) {
  const draggingTabsCount = TabsStore.draggingTabsInWindow.get(tab.windowId).size;
  const allTabsCount      = TabsStore.windows.get(tab.windowId).tabs.size;
  return draggingTabsCount == allTabsCount;
}

function collapseAutoExpandedItemsWhileDragging() {
  if (mLongHoverExpandedTabs.length > 0 &&
      configs.autoExpandOnLongHoverRestoreIniitalState) {
    for (const tab of mLongHoverExpandedTabs) {
      BackgroundConnection.sendMessage({
        type:      Constants.kCOMMAND_SET_SUBTREE_COLLAPSED_STATE,
        tabId:     tab.id,
        collapsed: false,
        justNow:   true,
        stack:     configs.debug && new Error().stack
      });
    }
  }
  mLongHoverExpandedTabs = [];
}

async function handleDroppedNonTreeItems(event, dropActionInfo) {
  event.stopPropagation();

  const uris = await RetrieveURL.fromDragEvent(event);
  // uris.forEach(uRI => {
  //   if (uRI.indexOf(Constants.kURI_BOOKMARK_FOLDER) != 0)
  //     securityCheck(uRI, event);
  // });
  log('handleDroppedNonTreeItems: ', uris);

  const dragOverItem = dropActionInfo.dragOverItem;
  if (dragOverItem &&
      dropActionInfo.dropPosition == kDROP_ON_SELF &&
      !dragOverItem.pinned) {
    const behavior = await getDroppedLinksOnTabBehavior();
    if (behavior <= Constants.kDROPLINK_ASK)
      return;
    if (behavior & Constants.kDROPLINK_LOAD) {
      BackgroundConnection.sendMessage({
        type:  Constants.kCOMMAND_ACTIVATE_TAB,
        tabId: dropActionInfo.dragOverItem.id,
        byMouseOperation: true
      });
      BackgroundConnection.sendMessage({
        type:  Constants.kCOMMAND_LOAD_URI,
        uri:   uris.shift(),
        tabId: dropActionInfo.dragOverItem.id
      });
    }
  }
  const active = !!configs.simulateTabsLoadInBackgroundInverted;
  BackgroundConnection.sendMessage({
    type:           Constants.kCOMMAND_NEW_TABS,
    uris,
    windowId:       TabsStore.getCurrentWindowId(),
    parentId:       dropActionInfo.parent?.id,
    insertBeforeId: dropActionInfo.insertBefore?.id,
    insertAfterId:  dropActionInfo.insertAfter?.id,
    active,
    discarded:      !active && configs.tabsLoadInBackgroundDiscarded,
  });
}

async function getDroppedLinksOnTabBehavior() {
  let behavior = configs.dropLinksOnTabBehavior;
  if (behavior != Constants.kDROPLINK_ASK)
    return behavior;

  const confirm = new RichConfirm({
    message: browser.i18n.getMessage('dropLinksOnTabBehavior_message'),
    buttons: [
      browser.i18n.getMessage('dropLinksOnTabBehavior_load'),
      browser.i18n.getMessage('dropLinksOnTabBehavior_newtab')
    ],
    checkMessage: browser.i18n.getMessage('dropLinksOnTabBehavior_save')
  });
  const result = await confirm.show();
  switch (result.buttonIndex) {
    case 0:
      behavior = Constants.kDROPLINK_LOAD;
      break;
    case 1:
      behavior = Constants.kDROPLINK_NEWTAB;
      break;
    default:
      return result.buttonIndex;
  }
  if (result.checked)
    configs.dropLinksOnTabBehavior = behavior;
  return behavior;
}


/* DOM event listeners */

let mFinishCanceledDragOperation;
let mCurrentDragDataForExternalsId = null;
let mCurrentDragDataForExternals = null;

function onDragStart(event, options = {}) {
  log('onDragStart: start ', event, options);
  clearDraggingItemsState(); // clear previous state anyway
  if (configs.enableWorkaroundForBug1548949)
    configs.workaroundForBug1548949DroppedItems = '';

  let draggedItem = options.item || EventUtils.getTreeItemFromEvent(event);
  let behavior = 'behavior' in options ? options.behavior :
    event.shiftKey ? configs.tabDragBehaviorShift :
      configs.tabDragBehavior;

  if (draggedItem?.$TST.subtreeCollapsed ||
      draggedItem?.$TST.group)
    behavior |= Constants.kDRAG_BEHAVIOR_ENTIRE_TREE;

  mCurrentDragDataForExternalsId = `${parseInt(Math.random() * 65000)}-${Date.now()}`;
  mCurrentDragDataForExternals = {};

  const originalTarget = EventUtils.getElementOriginalTarget(event);
  const extraTabContentsDragData = JSON.parse(originalTarget?.dataset?.dragData || 'null');
  log('onDragStart: extraTabContentsDragData = ', extraTabContentsDragData);
  let dataOverridden = false;
  if (extraTabContentsDragData) {
    const dataSet = detectOverrideDragDataSet(extraTabContentsDragData, event);
    log('onDragStart: detected override data set = ', dataSet);
    /*
      expected drag data format:
        Tab:
          { type: 'tab',
            data: { asTree:      (boolean),
                    allowDetach: (boolean, will detach the tab to new window),
                    allowLink:   (boolean, will create link/bookmark from the tab) }}
        other arbitrary types:
          { type:          'text/plain',
            data:          'something text',
            effectAllowed: 'copy' }
          { type:          'text/x-moz-url',
            data:          'http://example.com/\nExample Link',
            effectAllowed: 'copyMove' }
          ...
    */
    let tabIsGiven = false;
    for (const data of dataSet) {
      if (!data)
        continue;
      switch (data.type) {
        case 'tab':
          if (data.data.id) {
            const tab = Tab.get(data.data.id);
            if (tab) {
              tabIsGiven = true;
              draggedItem = tab;
              behavior   = data.data.allowMove === false ? Constants.kDRAG_BEHAVIOR_NONE : Constants.kDRAG_BEHAVIOR_MOVE;
              if (data.data.allowDetach)
                behavior |= Constants.kDRAG_BEHAVIOR_TEAR_OFF;
              if (data.data.allowLink)
                behavior |= Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK;
              if (data.data.asTree)
                behavior |= Constants.kDRAG_BEHAVIOR_ENTIRE_TREE;
            }
          }
          break;
        default: {
          const dt = event.dataTransfer;
          dt.effectAllowed = data.effectAllowed || 'copy';
          const type       = String(data.type);
          const stringData = String(data.data);
          dt.setData(type, stringData);
          //*** We need to sanitize drag data from helper addons, because
          //they can have sensitive data...
          //mCurrentDragDataForExternals[type] = stringData;
          dataOverridden = true;
        }; break;
      }
    }
    if (!tabIsGiven && dataOverridden)
      return;
  }

  const allowBookmark = !!(behavior & Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK);
  const asTree = !!(behavior & Constants.kDRAG_BEHAVIOR_ENTIRE_TREE);
  const dragData = getDragDataFromOneItem(draggedItem, { asTree });
  dragData.individualOnOutside = dragData.item && !dragData.item.$TST.multiselected && !asTree
  dragData.behavior = behavior;
  if (!dragData.item) {
    log('onDragStart: canceled / no dragged item from drag data');
    return;
  }
  log('dragData: ', dragData);

  if (!(behavior & Constants.kDRAG_BEHAVIOR_MOVE) &&
      !(behavior & Constants.kDRAG_BEHAVIOR_TEAR_OFF) &&
      !allowBookmark) {
    log('ignore drag action because it can do nothing');
    event.stopPropagation();
    event.preventDefault();
    return;
  }

  const item      = dragData.item;
  const mousedown = EventUtils.getLastMousedown(event.button);

  if (mousedown &&
      mousedown.detail.lastInnerScreenY != window.mozInnerScreenY) {
    log('ignore accidental drag from updated visual gap');
    event.stopPropagation();
    event.preventDefault();
    return;
  }

  if (mousedown?.expired) {
    log('onDragStart: canceled / expired');
    event.stopPropagation();
    event.preventDefault();
    mLastDragEnteredTarget = item.$TST.element || null;
    const startOnClosebox = mDragTargetIsClosebox = mousedown.detail.closebox;
    if (startOnClosebox)
      mLastDragEnteredTarget = item.$TST.element?.closeBox || null;
    const windowId = TabsStore.getCurrentWindowId();
    TSTAPI.broadcastMessage({
      type:   TSTAPI.kNOTIFY_TAB_DRAGSTART,
      item,
      tab:    item.$TST.tab, // for backward compatibility
      window: windowId,
      windowId,
      startOnClosebox
    }, { tabProperties: ['item', 'tab'] }).catch(_error => {});
    window.addEventListener('mouseover', onTSTAPIDragEnter, { capture: true });
    window.addEventListener('mouseout',  onTSTAPIDragExit, { capture: true });
    document.body.setCapture(false);
    mCapturingForDragging = true;
    return;
  }

  // dragging on clickable element will be expected to cancel the operation
  if (EventUtils.isEventFiredOnClosebox(options.item?.$TST.element || event) ||
      EventUtils.isEventFiredOnClickable(options.item?.$TST.element || event)) {
    log('onDragStart: canceled / on undraggable element');
    event.stopPropagation();
    event.preventDefault();
    return;
  }

  EventUtils.cancelHandleMousedown();

  mDraggingOnSelfWindow = true;
  mDraggingOnDraggedItems = true;
  mLastDropPosition = mLastInlineDropPosition = null;

  const dt = event.dataTransfer;
  dt.effectAllowed = 'copyMove';

  const sanitizedDragData = sanitizeDragData(dragData);
  dt.setData(kTREE_DROP_TYPE, JSON.stringify(sanitizedDragData));

  log(`onDragStart: starting drag session ${sanitizedDragData.sessionId}`);

  // Because addon cannot read drag data across private browsing mode,
  // we need to share detailed information of dragged items in different way!
  mCurrentDragData = sanitizedDragData;
  browser.runtime.sendMessage({
    type:     Constants.kCOMMAND_BROADCAST_CURRENT_DRAG_DATA,
    windowId: TabsStore.getCurrentWindowId(),
    dragData: sanitizedDragData
  }).catch(ApiTabs.createErrorSuppressor());

  if (!dataOverridden &&
      dragData.tab) {
    const urls    = [];
    const mozUrl  = [];
    const urlList = [];
    for (const draggedTab of dragData.tabs) {
      draggedTab.$TST.addState(Constants.kTAB_STATE_DRAGGING);
      TabsStore.addDraggingTab(draggedTab);
      if (!dragData.individualOnOutside ||
          mozUrl.length == 0) {
        urls.push(draggedTab.url);
        mozUrl.push(`${draggedTab.url}\n${draggedTab.title}`);
        urlList.push(`#${draggedTab.title}\n${draggedTab.url}`);
      }
    }
    mCurrentDragDataForExternals[RetrieveURL.kTYPE_PLAIN_TEXT] = urls.join('\n');
    mCurrentDragDataForExternals[RetrieveURL.kTYPE_X_MOZ_URL] = mozUrl.join('\n');
    mCurrentDragDataForExternals[RetrieveURL.kTYPE_URI_LIST] = urlList.join('\n');
    if (allowBookmark) {
      log('set kTYPE_PLAIN_TEXT ', mCurrentDragDataForExternals[RetrieveURL.kTYPE_PLAIN_TEXT]);
      dt.setData(RetrieveURL.kTYPE_PLAIN_TEXT, mCurrentDragDataForExternals[RetrieveURL.kTYPE_PLAIN_TEXT]);
      log('set kTYPE_X_MOZ_URL ', mCurrentDragDataForExternals[RetrieveURL.kTYPE_X_MOZ_URL]);
      dt.setData(RetrieveURL.kTYPE_X_MOZ_URL, mCurrentDragDataForExternals[RetrieveURL.kTYPE_X_MOZ_URL]);
      log('set kTYPE_URI_LIST ', mCurrentDragDataForExternals[RetrieveURL.kTYPE_URI_LIST]);
      dt.setData(RetrieveURL.kTYPE_URI_LIST, mCurrentDragDataForExternals[RetrieveURL.kTYPE_URI_LIST]);
    }
  }
  {
    const dragDataType    = `${kTYPE_ADDON_DRAG_DATA}${mCurrentDragDataForExternalsId}`;
    const dragDataContent = JSON.stringify(mCurrentDragDataForExternals);
    try {
      dt.setData(dragDataType, dragDataContent);
    }
    catch(error) {
      console.error(error);
      console.log(`Failed to set drag data with the type ${dragDataType}:`, dragDataContent);
    }
  }

  if (item.$TST.element) {
    // We set negative offsets to get more visibility about drop targets.
    // See also: https://github.com/piroor/treestyletab/issues/2826
    const offset = -16;
    dt.setDragImage(item.$TST.element, offset, offset);
  }

  const win = TabsStore.windows.get(TabsStore.getCurrentWindowId());
  win.containerClassList.add(Constants.kTABBAR_STATE_TAB_DRAGGING);
  win.pinnedContainerClassList.add(Constants.kTABBAR_STATE_TAB_DRAGGING);
  document.documentElement.classList.add(Constants.kTABBAR_STATE_TAB_DRAGGING);

  if (!('behavior' in options) &&
      configs.showTabDragBehaviorNotification) {
    const invertedBehavior = event.shiftKey ? configs.tabDragBehavior : configs.tabDragBehaviorShift;
    const count            = dragData.tabs.length;
    const currentResult    = getTabDragBehaviorNotificationMessageType(behavior, count);
    const invertedResult   = getTabDragBehaviorNotificationMessageType(invertedBehavior, count);
    if (currentResult || invertedResult) {
      const invertSuffix = event.shiftKey ? 'without_shift' : 'with_shift';
      Notifications.add('tab-drag-behavior-description', {
        message: [
          currentResult && browser.i18n.getMessage(`tabDragBehaviorNotification_message_base`, [
            browser.i18n.getMessage(`tabDragBehaviorNotification_message_${currentResult}`)]),
          invertedResult && browser.i18n.getMessage(`tabDragBehaviorNotification_message_inverted_base_${invertSuffix}`, [
            browser.i18n.getMessage(`tabDragBehaviorNotification_message_${invertedResult}`)]),
        ].join('\n'),
        onCreated(notification) {
          notification.style.animationDuration = !shouldApplyAnimation() ?
            0 :
            browser.i18n.getMessage(`tabDragBehaviorNotification_message_duration_${currentResult && invertedResult ? 'both' : 'single'}`)
        },
      });
    }
  }

  TSTAPI.broadcastMessage({
    type:     TSTAPI.kNOTIFY_NATIVE_TAB_DRAGSTART,
    item,
    tab:      item.$TST.tab, // for backward compatibility
    windowId: TabsStore.getCurrentWindowId()
  }, { tabProperties: ['item', 'tab'] }).catch(_error => {});

  updateLastDragEventCoordinates(event);
  // Don't store raw URLs to save privacy!
  sha1sum(dragData.tabs.map(tab => tab.url).join('\n')).then(digest => {
    configs.lastDraggedTabs = {
      tabIds:     dragData.tabs.map(tab => tab.id),
      urlsDigest: digest
    };
  });

  log('onDragStart: started');
}
onDragStart = EventUtils.wrapWithErrorHandler(onDragStart);

/* acceptable input:
  {
    "default":    { type: ..., data: ... },
    "Ctrl":       { type: ..., data: ... },
    "MacCtrl":    { type: ..., data: ... },
    "Ctrl+Shift": { type: ..., data: ... },
    "Alt-Shift":  { type: ..., data: ... },
    ...
  }
*/
function detectOverrideDragDataSet(dataSet, event) {
  if (Array.isArray(dataSet))
    return dataSet.map(oneDataSet => detectOverrideDragDataSet(oneDataSet, event)).flat();

  if ('type' in dataSet)
    return [dataSet];

  const keys = [];
  if (event.altKey)
    keys.push('alt');
  if (event.ctrlKey) {
    if (isMacOS())
      keys.push('macctrl');
    else
      keys.push('ctrl');
  }
  if (event.metaKey) {
    if (isMacOS())
      keys.push('command');
    else
      keys.push('meta');
  }
  if (event.shiftKey)
    keys.push('shift');
  const findKey = keys.sort().join('+') || 'default';

  for (const key of Object.keys(dataSet)) {
    const normalizedKey = key.split(/[-\+]/).filter(part => !!part).sort().join('+').toLowerCase();
    if (normalizedKey != findKey)
      continue;
    if (Array.isArray(dataSet[key]))
      return dataSet[key];
    else
      return [dataSet[key]];
  }
  return [];
}

function getTabDragBehaviorNotificationMessageType(behavior, count) {
  if (behavior & Constants.kDRAG_BEHAVIOR_ENTIRE_TREE && count > 1) {
    if (behavior & Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK)
      return 'tree_bookmark';
    else if (behavior & Constants.kDRAG_BEHAVIOR_TEAR_OFF)
      return 'tree_tearoff';
    else
      return '';
  }
  else {
    if (behavior & Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK)
      return 'tab_bookmark';
    else if (behavior & Constants.kDRAG_BEHAVIOR_TEAR_OFF)
      return 'tab_tearoff';
    else
      return '';
  }
}

let mLastDragOverTimestamp = null;
let mDelayedClearDropPosition = null;

function onDragOver(event) {
  const dt = event.dataTransfer;
  if (dt.types.length == 0) {
    // On Linux, unexpected invalid dragover events can be fired on various triggers unrelated to drag and drop.
    // TST ignores such events as a workaround.
    // See also: https://github.com/piroor/treestyletab/issues/3374
    log('onDragOver: ignore invalid dragover event');
    return;
  }

  if (mFinishCanceledDragOperation) {
    clearTimeout(mFinishCanceledDragOperation);
    mFinishCanceledDragOperation = null;
  }

  if (!isLinux()) {
    if (mDelayedClearDropPosition)
      clearTimeout(mDelayedClearDropPosition);
    mDelayedClearDropPosition = setTimeout(() => {
      mDelayedClearDropPosition = null;
      clearDropPosition();
    }, 250);
  }

  event.preventDefault(); // this is required to override default dragover actions!
  Scroll.autoScrollOnMouseEvent(event);

  updateLastDragEventCoordinates(event);

  // reduce too much handling of too frequent dragover events...
  const now = Date.now();
  if (now - (mLastDragOverTimestamp || 0) < configs.minimumIntervalToProcessDragoverEvent)
    return;
  mLastDragOverTimestamp = now;

  const info = getDropAction(event);

  let dragData = dt.getData(kTREE_DROP_TYPE);
  dragData = (dragData && JSON.parse(dragData)) || mCurrentDragData;
  const sessionId = dragData?.sessionId || '';
  log(`onDragOver: sessionId=${sessionId}, types=${dt.types}, dropEffect=${dt.dropEffect}, effectAllowed=${dt.effectAllowed}, item=`, dragData?.item);

  if (isEventFiredOnItemDropBlocker(event) ||
      !info.canDrop) {
    log(`onDragOver: not droppable sessionId=${sessionId}`);
    dt.dropEffect = 'none';
    if (mLastDropPosition)
      clearDropPosition();
    mLastDropPosition = mLastInlineDropPosition = null;
    return;
  }

  if (EventUtils.isEventFiredOnNewTabButton(event)) {
    log(`onDragOver: dragging something on the new tab button sessionId=${sessionId}`);
    dt.dropEffect = 'move';
    if (mLastDropPosition)
      clearDropPosition();
    mLastDropPosition = mLastInlineDropPosition = null;
    return;
  }

  let dropPositionTargetItem = info.targetItem;
  if (dropPositionTargetItem?.$TST?.collapsed)
    dropPositionTargetItem = info.targetItem.$TST.nearestVisiblePrecedingTab || info.targetItem;
  if (!dropPositionTargetItem) {
    log(`onDragOver: no drop target item sessionId=${sessionId}`);
    dt.dropEffect = 'none';
    mLastDropPosition = mLastInlineDropPosition = null;
    return;
  }

  const dropPosition = `${dropPositionTargetItem.id}:${info.dropPosition}`;
  const inlineDropPosition = `${dropPositionTargetItem.id}:${info.inlineDropPosition}`;
  if (!info.draggedItem ||
      dropPositionTargetItem.id != info.draggedItem.id ||
      dropPosition != mLastDropPosition ||
      inlineDropPosition != mLastInlineDropPosition) {
    if (dropPosition == mLastDropPosition &&
        inlineDropPosition == mLastInlineDropPosition) {
      log(`onDragOver: no move, sessionId=${sessionId}`);
      return;
    }
    clearDropPosition();
    dropPositionTargetItem.$TST.setAttribute(kDROP_POSITION, info.dropPosition);
    dropPositionTargetItem.$TST.setAttribute(kINLINE_DROP_POSITION, info.inlineDropPosition);
    mDropPositionHolderItems.add(dropPositionTargetItem);
    if (info.canCreateGroup) {
      dropPositionTargetItem.$TST.setAttribute(kNEXT_GROUP_COLOR, dragData.nextGroupColor);
    }
    const substanceTargetItem = info.substanceTargetItem;
    if (substanceTargetItem &&
        info.dropPosition == kDROP_ON_SELF) {
      substanceTargetItem.$TST.setAttribute(kDROP_POSITION, info.dropPosition);
      substanceTargetItem.$TST.setAttribute(kINLINE_DROP_POSITION, info.inlineDropPosition);
      mDropPositionHolderItems.add(substanceTargetItem);
    }
    mLastDropPosition = dropPosition;
    mLastInlineDropPosition = inlineDropPosition;
    log(`onDragOver: set drop position to ${dropPosition}, sessionId=${sessionId}`);
  }
  else {
    mLastDropPosition = mLastInlineDropPosition = null;
  }
}
onDragOver = EventUtils.wrapWithErrorHandler(onDragOver);

function isEventFiredOnItemDropBlocker(event) {
  let node = event.target;
  if (node.nodeType != Node.ELEMENT_NODE)
    node = node.parentNode;
  return node && !!node.closest('.item-drop-blocker');
}

function onDragEnter(event) {
  configs.lastDragOverSidebarOwnerWindowId = TabsStore.getCurrentWindowId();

  mDraggingOnSelfWindow = true;

  const info = getDropAction(event);
  try {
    const enteredItem = EventUtils.getTreeItemFromEvent(event);
    const leftItem    = SidebarItems.getItemFromDOMNode(event.relatedTarget);
    if (leftItem != enteredItem) {
      mDraggingOnDraggedItems = (
        info.dragData &&
        info.dragData.tabs.some(tab => tab.id == enteredItem.id)
      );
    }
    const win = TabsStore.windows.get(TabsStore.getCurrentWindowId());
    win.containerClassList.add(Constants.kTABBAR_STATE_TAB_DRAGGING);
    win.pinnedContainerClassList.add(Constants.kTABBAR_STATE_TAB_DRAGGING);
    document.documentElement.classList.add(Constants.kTABBAR_STATE_TAB_DRAGGING);
  }
  catch(_e) {
  }

  const dt   = event.dataTransfer;
  dt.dropEffect = info.dropEffect;
  if (info.dropEffect == 'link')
    document.documentElement.classList.add(Constants.kTABBAR_STATE_LINK_DRAGGING);

  updateLastDragEventCoordinates(event);

  if (!info.canDrop ||
      !info.dragOverItem)
    return;

  reserveToProcessLongHover.cancel();

  if (info.draggedItem &&
      info.dragOverItem.id == info.draggedItem.id)
    return;

  reserveToProcessLongHover({
    dragOverItemId: info.targetItem?.id,
    draggedItemId:  info.draggedItem?.id,
    dropEffect:     info.dropEffect,
  });
}
onDragEnter = EventUtils.wrapWithErrorHandler(onDragEnter);

function reserveToProcessLongHover({ dragOverItemId, draggedItemId, dropEffect }) {
  mLongHoverTimerNext = setTimeout(() => {
    if (!mLongHoverTimerNext)
      return; // already canceled
    mLongHoverTimerNext = null;
    mLongHoverTimer = setTimeout(async () => {
      if (!mLongHoverTimer)
        return; // already canceled

      mLongHoverTimer = null;
      log('reservedProcessLongHover: ', { dragOverItemId, draggedItemId, dropEffect });

      const dragOverItem = Tab.get(dragOverItemId);
      if (!dragOverItem ||
          dragOverItem.$TST.getAttribute(kDROP_POSITION) != 'self')
        return;

      // auto-switch for staying on tabs
      if (!dragOverItem.active &&
          dropEffect == 'link') {
        BackgroundConnection.sendMessage({
          type:  Constants.kCOMMAND_ACTIVATE_TAB,
          tabId: dragOverItem.id,
          byMouseOperation: true
        });
      }

      if (!configs.autoExpandOnLongHover ||
          !dragOverItem ||
          !dragOverItem.$TST.isAutoExpandable)
        return;

      // auto-expand for staying on a parent
      if (configs.autoExpandIntelligently) {
        BackgroundConnection.sendMessage({
          type:  Constants.kCOMMAND_SET_SUBTREE_COLLAPSED_STATE_INTELLIGENTLY_FOR,
          tabId: dragOverItem.id
        });
      }
      else {
        if (!mLongHoverExpandedTabs.includes(dragOverItemId))
          mLongHoverExpandedTabs.push(dragOverItemId);
        BackgroundConnection.sendMessage({
          type:      Constants.kCOMMAND_SET_SUBTREE_COLLAPSED_STATE,
          tabId:     dragOverItem.id,
          collapsed: false,
          stack:     configs.debug && new Error().stack
        });
      }
    }, configs.autoExpandOnLongHoverDelay);
  }, 0);
}
reserveToProcessLongHover.cancel = function() {
  if (mLongHoverTimer) {
    clearTimeout(mLongHoverTimer);
    mLongHoverTimer = null;
  }
  if (mLongHoverTimerNext) {
    clearTimeout(mLongHoverTimerNext);
    mLongHoverTimerNext = null;
  }
};

function onDragLeave(event) {
  if (configs.lastDragOverSidebarOwnerWindowId == TabsStore.getCurrentWindowId())
    configs.lastDragOverSidebarOwnerWindowId = null;

  let leftFromTabBar = false;
  try {
    const info        = getDropAction(event);
    const leftItem    = EventUtils.getTreeItemFromEvent(event);
    const enteredItem = SidebarItems.getItemFromDOMNode(event.relatedTarget);
    if (leftItem != enteredItem) {
      if (info.dragData &&
          info.dragData.items.some(item => item.id == leftItem.id) &&
          (!enteredItem ||
           !info.dragData.items.every(item => item.id == enteredItem.id))) {
        onDragLeave.delayedLeftFromDraggedItems = setTimeout(() => {
          delete onDragLeave.delayedLeftFromDraggedItems;
          mDraggingOnDraggedItems = false;
        }, 10);
      }
      else {
        leftFromTabBar = !enteredItem || enteredItem.windowId != TabsStore.getCurrentWindowId();
        if (onDragLeave.delayedLeftFromDraggedItems) {
          clearTimeout(onDragLeave.delayedLeftFromDraggedItems);
          delete onDragLeave.delayedLeftFromDraggedItems;
        }
      }
    }
  }
  catch(_e) {
    leftFromTabBar = true;
  }

  if (leftFromTabBar) {
    onDragLeave.delayedLeftFromTabBar = setTimeout(() => {
      delete onDragLeave.delayedLeftFromTabBar;
      mDraggingOnSelfWindow = false;
      mDraggingOnDraggedItems = false;
      clearDropPosition();
      clearDraggingState();
      mLastDropPosition = null;
      mLastInlineDropPosition = null;
      reserveToProcessLongHover.cancel();
    }, 10);
  }
  else if (onDragLeave.delayedLeftFromTabBar) {
    clearTimeout(onDragLeave.delayedLeftFromTabBar);
    delete onDragLeave.delayedLeftFromTabBar;
  }

  updateLastDragEventCoordinates(event);
  clearTimeout(mLongHoverTimer);
  mLongHoverTimer = null;
}
onDragLeave = EventUtils.wrapWithErrorHandler(onDragLeave);

function onDrop(event) {
  setTimeout(() => {
    collapseAutoExpandedItemsWhileDragging();
    // Don't clear flags immediately, because they are referred by following operations in this function.
    finishDrag('onDrop');
  }, 0);

  const dropActionInfo = getDropAction(event);

  let dragData = event.dataTransfer.getData(kTREE_DROP_TYPE);
  dragData = (dragData && JSON.parse(dragData)) || mCurrentDragData;
  const sessionId = dragData?.sessionId || '';
  log(`onDrop ${sessionId}`, dropActionInfo, event.dataTransfer);

  if (!dropActionInfo.canDrop) {
    log('undroppable');
    return;
  }

  const dt = event.dataTransfer;
  if (dt.dropEffect != 'link' &&
      dt.dropEffect != 'move' &&
      dropActionInfo.dragData &&
      !dropActionInfo.dragData.item) {
    log('invalid drop');
    return;
  }

  // We need to cancel the drop event explicitly to prevent Firefox tries to load the dropped URL to the tab itself.
  // This is required to use "ext+ws:tabbar" in a regular tab.
  // See also: https://github.com/piroor/treestyletab/issues/3056
  event.preventDefault();

  if (dropActionInfo.dragData &&
      dropActionInfo.dragData.item) {
    log('there are dragged items: ', () => dropActionInfo.dragData.items.map(dumpTab));
    if (configs.enableWorkaroundForBug1548949) {
      configs.workaroundForBug1548949DroppedItems = dropActionInfo.dragData.items.map(item => `${mInstanceId}/${item.id}`).join('\n');
      log('workaround for bug 1548949: setting last dropped items: ', configs.workaroundForBug1548949DroppedItems);
    }
    const { draggedItems, structure, insertBefore, insertAfter } = sanitizeDraggedItems({
      draggedItems: dropActionInfo.dragData.items,
      structure:    dropActionInfo.dragData.structure,
      insertBefore: dropActionInfo.insertBefore,
      insertAfter:  dropActionInfo.insertAfter,
      parent:       dropActionInfo.parent,
      isCopy:       dt.dropEffect == 'copy',
    });
    const fromOtherProfile = dropActionInfo.dragData.instanceId != mInstanceId;
    BackgroundConnection.sendMessage({
      type:                Constants.kCOMMAND_PERFORM_TABS_DRAG_DROP,
      windowId:            dropActionInfo.dragData.windowId,
      items:               draggedItems.map(item => item?.$TST?.sanitized || item),
      droppedOn:           dropActionInfo.sanitizedDropOnTargetItem,
      droppedBefore:       dropActionInfo.sanitizedDropBeforeTargetItem,
      droppedAfter:        dropActionInfo.sanitizedDropAfterTargetItem,
      groupId:             dropActionInfo.groupId,
      structure,
      action:              dropActionInfo.action,
      allowedActions:      dropActionInfo.dragData.behavior,
      attachToId:          dropActionInfo.parent?.id,
      insertBefore:        insertBefore?.$TST?.sanitized || insertBefore,
      insertAfter:         insertAfter?.$TST?.sanitized || insertAfter,
      destinationWindowId: TabsStore.getCurrentWindowId(),
      duplicate:           !fromOtherProfile && dt.dropEffect == 'copy',
      nextGroupColor:      dropActionInfo.dragData.nextGroupColor,
      canCreateGroup:      dropActionInfo.canCreateGroup,
      import:              fromOtherProfile
    });
    return;
  }

  if (dt.types.includes(RetrieveURL.kTYPE_MOZ_TEXT_INTERNAL) &&
      configs.guessDraggedNativeTabs) {
    const url = dt.getData(RetrieveURL.kTYPE_MOZ_TEXT_INTERNAL);
    log(`finding native tabs with the dropped URL: ${url}`);
    browser.tabs.query({ url, active: true }).then(async tabs => {
      if (!tabs.length && url.includes('#')) {
        log(`=> find again without the fragment part`);
        tabs = await browser.tabs.query({ url: url.replace(/#.*$/, ''), active: true });
        if (!tabs.length) {
          log('=> no such tabs, maybe dropped from other profile');
          handleDroppedNonTreeItems(event, dropActionInfo);
          return;
        }
      }
      log('=> possible dragged tabs: ', tabs);
      tabs = tabs.sort((a, b) => b.lastAccessed - a.lastAccessed);
      if (configs.enableWorkaroundForBug1548949) {
        configs.workaroundForBug1548949DroppedItems = tabs.map(tab => `${mInstanceId}/${tab.id}`).join('\n');
        log('workaround for bug 1548949: setting last dropped tabs: ', configs.workaroundForBug1548949DroppedItems);
      }
      const recentTab = tabs[0];

      const multiselectedTabs = await browser.tabs.query({
        windowId:    recentTab.windowId,
        highlighted: true,
      });
      const structureFromMultiselectedTabs = (recentTab.windowId == TabsStore.getCurrentWindowId()) ?
        TreeBehavior.getTreeStructureFromTabs(multiselectedTabs.map(tab => Tab.get(tab.id))) :
        (await browser.runtime.sendMessage({
          type: Constants.kCOMMAND_PULL_TREE_STRUCTURE,
          tabIds: multiselectedTabs.map(tab => tab.id),
        })).structure;
      log('maybe dragged tabs: ', multiselectedTabs, structureFromMultiselectedTabs);

      const { draggedItems, structure, insertBefore, insertAfter } = sanitizeDraggedItems({
        draggedItems: multiselectedTabs,
        structure:    structureFromMultiselectedTabs,
        insertBefore: dropActionInfo.insertBefore,
        insertAfter:  dropActionInfo.insertAfter,
        parent:       dropActionInfo.parent,
        isCopy:       dt.dropEffect == 'copy',
      });

      const allowedActions = event.shiftKey ?
        configs.tabDragBehaviorShift :
        configs.tabDragBehavior;
      BackgroundConnection.sendMessage({
        type:                Constants.kCOMMAND_PERFORM_TABS_DRAG_DROP,
        windowId:            recentTab.windowId,
        items:               draggedItems.map(item => item?.$TST?.sanitized || item),
        droppedOn:           dropActionInfo.sanitizedDropOnTargetItem,
        droppedBefore:       dropActionInfo.sanitizedDropBeforeTargetItem,
        droppedAfter:        dropActionInfo.sanitizedDropAfterTargetItem,
        groupId:             dropActionInfo.groupId,
        structure,
        action:              dropActionInfo.action,
        allowedActions,
        attachToId:          dropActionInfo.parent?.id,
        insertBefore:        insertBefore?.$TST?.sanitized || insertBefore,
        insertAfter:         insertAfter?.$TST?.sanitized || insertAfter,
        destinationWindowId: TabsStore.getCurrentWindowId(),
        duplicate:           dt.dropEffect == 'copy',
        nextGroupColor:      dropActionInfo.dragData?.nextGroupColor,
        canCreateGroup:      dropActionInfo.canCreateGroup,
        import:              false
      });
    });
    return;
  }

  log('link or bookmark item is dropped');
  handleDroppedNonTreeItems(event, dropActionInfo);
}
onDrop = EventUtils.wrapWithErrorHandler(onDrop);

function sanitizeDraggedItems({ draggedItems, structure, insertBefore, insertAfter, parent, isCopy }) {
  const parentId = parent?.id;
  log('sanitizeDraggedItems: ', () => ({ draggedItems: draggedItems.map(dumpTab), structure, insertBefore: dumpTab(insertBefore), insertAfter: dumpTab(insertAfter), parentId, isCopy }));
  if (isCopy ||
      !configs.moveSoloTabOnDropParentToDescendant ||
      draggedItems.every(item => item.id != parentId))
    return { draggedItems, structure, insertBefore, insertAfter };

  log('=> dropping parent to a descendant: partial attach mode');
  for (let i = draggedItems.length - 1; i > -1; i--) {
    if (structure[i].parent < 0)
      continue;
    draggedItems.splice(i, 1);
    structure.splice(i, 1);
  }
  insertBefore = parent?.$TST.nextSiblingTab;
  insertAfter  = parent;
  return { draggedItems, structure, insertBefore, insertAfter };
}

async function onDragEnd(event) {
  log('onDragEnd, ', { event, mDraggingOnSelfWindow, mDraggingOnDraggedItems, dropEffect: event.dataTransfer?.dropEffect });
  if (!mLastDragEventCoordinates) {
    log('dragend is handled after finishDrag - already handled by ondrop handler.');
    return;
  }
  const lastDragEventCoordinatesX = mLastDragEventCoordinates.x;
  const lastDragEventCoordinatesY = mLastDragEventCoordinates.y;
  const lastDragEventCoordinatesTimestamp = mLastDragEventCoordinates.timestamp;
  const droppedOnSidebarArea = !!configs.lastDragOverSidebarOwnerWindowId;

  let dragData = event.dataTransfer?.getData(kTREE_DROP_TYPE);
  dragData = (dragData && JSON.parse(dragData)) || mCurrentDragData;
  if (dragData) {
    dragData.item  = TreeItem.get(dragData.item) || dragData.item;
    dragData.items = dragData.items && dragData.items.map(item => TreeItem.get(item) || item);
    log(`onDragEnd: finishing drag session ${dragData.sessionId}`);
  }

  TSTAPI.broadcastMessage({
    type:     TSTAPI.kNOTIFY_NATIVE_TAB_DRAGEND,
    windowId: TabsStore.getCurrentWindowId()
  }).catch(_error => {});

  // Don't clear flags immediately, because they are referred by following operations in this function.
  setTimeout(finishDrag, 0, 'onDragEnd');

  if (!dragData ||
      !(dragData.behavior & Constants.kDRAG_BEHAVIOR_TEAR_OFF))
    return;

  let handledBySomeone = event.dataTransfer?.dropEffect != 'none';

  if (event.dataTransfer?.getData(RetrieveURL.kTYPE_URI_LIST)) {
    log('do nothing by TST for dropping just for bookmarking or linking');
    return;
  }
  else if (configs.enableWorkaroundForBug1548949) {
    // Due to the bug 1548949, "dropEffect" can become "move" even if no one
    // actually handles the drop. Basically kTREE_DROP_TYPE is not processible
    // by anyone except TST, so, we can treat the dropend as "dropped outside
    // the sidebar" when all dragged tabs are exact same to last tabs dropped
    // to a sidebar on this Firefox instance.
    // The only one exception is the case: tabs have been dropped to a TST
    // sidebar on any other Firefox instance. In this case tabs dropped to the
    // foreign Firefox will become duplicated: imported to the foreign Firefox
    // and teared off from the source window. This is clearly undesider
    // behavior from misdetection, but I decide to ignore it because it looks
    // quite rare case.
    await wait(250); // wait until "workaroundForBug1548949DroppedItems" is synchronized
    const draggedItems = dragData.items.map(item => `${mInstanceId}/${item.id}`).join('\n');
    const lastDroppedItems = configs.workaroundForBug1548949DroppedItems;
    handledBySomeone = draggedItems == lastDroppedItems;
    log('workaround for bug 1548949: detect dragged tabs are handled by me or not.',
        { handledBySomeone, draggedItems, lastDroppedItems });
    configs.workaroundForBug1548949DroppedItems = null;
  }

  if (event.dataTransfer?.mozUserCancelled ||
      handledBySomeone) {
    log('dragged items are processed by someone: ', event.dataTransfer?.dropEffect);
    return;
  }

  if (droppedOnSidebarArea) {
    log('dropped on the tab bar (from event): detaching is canceled');
    return;
  }

  if (configs.ignoreTabDropNearSidebarArea) {
    const windowX = window.mozInnerScreenX;
    const windowY = window.mozInnerScreenY;
    const windowW = window.innerWidth;
    const windowH = window.innerHeight;
    const offset  = Scroll.getItemRect(dragData.item).height / 2;
    const now = Date.now();
    log('dragend at: ', {
      windowX,
      windowY,
      windowW,
      windowH,
      eventScreenX: event.screenX,
      eventScreenY: event.screenY,
      eventClientX: event.clientX,
      eventClientY: event.clientY,
      lastDragEventCoordinatesX,
      lastDragEventCoordinatesY,
      offset,
    });
    if (event.screenX >= windowX - offset &&
        event.screenY >= windowY - offset &&
        event.screenX <= windowX + windowW + offset &&
        event.screenY <= windowY + windowH + offset) {
      log('dropped near the tab bar (from coordinates): detaching is canceled');
      return;
    }
    // Workaround for https://bugzilla.mozilla.org/show_bug.cgi?id=1561879
    // On macOS sometimes drag gesture is canceled immediately with (0,0) coordinates.
    // (This happens on Windows also.)
    const delayFromLast = now - lastDragEventCoordinatesTimestamp;
    const rawOffsetX    = Math.abs(event.screenX - lastDragEventCoordinatesX);
    const rawOffsetY    = Math.abs(event.screenY - lastDragEventCoordinatesY);
    log('check: ', {
      now,
      lastDragEventCoordinatesTimestamp,
      delayFromLast,
      maxDelay: configs.maximumDelayForBug1561879,
      offset,
      rawOffsetX,
      rawOffsetY,
    });
    if (event.screenX == 0 &&
        event.screenY == 0 &&
        // We need to accept intentional drag and drop at left edge of the screen.
        // For safety, cancel only when the coordinates become (0,0) accidently from the bug.
        delayFromLast < configs.maximumDelayForBug1561879 &&
        rawOffsetX > offset &&
        rawOffsetY > offset) {
      log('dropped at unknown position: detaching is canceled');
      return;
    }
  }

  log('trying to detach item from window');
  event.stopPropagation();
  event.preventDefault();

  if (dragData.tab) {
    if (isDraggingAllActiveTabs(dragData.tab)) {
      log('all tabs are dragged, so it is nonsence to tear off them from the window');
      return;
    }

    const detachTabs = dragData.individualOnOutside ? [dragData.tab] : dragData.tabs;
    BackgroundConnection.sendMessage({
      type:      Constants.kCOMMAND_NEW_WINDOW_FROM_TABS,
      tabIds:    detachTabs.map(tab => tab.id),
      duplicate: EventUtils.isAccelKeyPressed(event),
      left:      event.screenX,
      top:       event.screenY,
    });
  }

  if (dragData.item?.$TST.group) {
    if (dragData.item?.$TST.members.length == TabsStore.windows.get(dragData.item.windowId).tabs.size) {
      log('the last one group containing all tabs is dragged, so it is nonsence to tear off it from the window');
      return;
    }

    BackgroundConnection.sendMessage({
      type:      Constants.kCOMMAND_NEW_WINDOW_FROM_NATIVE_TAB_GROUP,
      windowId:  dragData.item.windowId,
      groupId:   dragData.item.id,
      duplicate: EventUtils.isAccelKeyPressed(event),
      left:      event.screenX,
      top:       event.screenY,
    });
  }

}
onDragEnd = EventUtils.wrapWithErrorHandler(onDragEnd);

function finishDrag(trigger) {
  log(`finishDrag from ${trigger || 'unknown'}`);

  Notifications.remove('tab-drag-behavior-description');

  mDraggingOnSelfWindow = false;

  wait(100).then(() => {
    mCurrentDragData = null;
    mCurrentDragDataForExternalsId = null;
    mCurrentDragDataForExternals = null;
    browser.runtime.sendMessage({
      type:     Constants.kCOMMAND_BROADCAST_CURRENT_DRAG_DATA,
      windowId: TabsStore.getCurrentWindowId(),
      dragData: null
    }).catch(ApiTabs.createErrorSuppressor());
  });

  onFinishDrag();
}

function onFinishDrag() {
  clearDraggingItemsState();
  clearDropPosition();
  mLastDropPosition = null;
  mLastInlineDropPosition = null;
  updateLastDragEventCoordinates();
  mLastDragOverTimestamp = null;
  clearDraggingState();
  collapseAutoExpandedItemsWhileDragging();
  mDraggingOnSelfWindow = false;
  mDraggingOnDraggedItems = false;
  reserveToProcessLongHover.cancel();
}

function updateLastDragEventCoordinates(event = null) {
  mLastDragEventCoordinates = !event ? null : {
    x: event.screenX,
    y: event.screenY,
    timestamp: Date.now(),
  };
}


/* drag on tabs API */

const mDragExitTimeoutForTarget = new WeakMap();

function onTSTAPIDragEnter(event) {
  Scroll.autoScrollOnMouseEvent(event);
  const item = EventUtils.getTreeItemFromEvent(event);
  if (!item)
    return;
  let target = item.$TST.element;
  if (mDragTargetIsClosebox && EventUtils.isEventFiredOnClosebox(event))
    target = target && item.$TST.element.closeBox;
  cancelDelayedTSTAPIDragExitOn(target);
  if (item &&
      (!mDragTargetIsClosebox ||
       EventUtils.isEventFiredOnClosebox(event))) {
    if (target != mLastDragEnteredTarget) {
      TSTAPI.broadcastMessage({
        type:     TSTAPI.kNOTIFY_TAB_DRAGENTER,
        item,
        tab:      item.$TST.tab, // for backward compatibility
        window:   item.windowId,
        windowId: item.windowId
      }, { tabProperties: ['item', 'tab'] }).catch(_error => {});
    }
  }
  mLastDragEnteredTarget = target;
}

function onTSTAPIDragExit(event) {
  if (mDragTargetIsClosebox &&
      !EventUtils.isEventFiredOnClosebox(event))
    return;
  const item = EventUtils.getTreeItemFromEvent(event);
  if (!item)
    return;
  let target = item.$TST.element;
  if (mDragTargetIsClosebox && EventUtils.isEventFiredOnClosebox(event))
    target = target && item.$TST.element.closeBox;
  cancelDelayedTSTAPIDragExitOn(target);
  const timeout = setTimeout(() => {
    if (target)
      mDragExitTimeoutForTarget.delete(target);
    if (!target || !target.parentNode) // already removed
      return;
    TSTAPI.broadcastMessage({
      type:     TSTAPI.kNOTIFY_TAB_DRAGEXIT,
      item,
      tab:      item.$TST.tab, // for backward compatibility
      window:   item.windowId,
      windowId: item.windowId
    }, { tabProperties: ['item', 'tab'] }).catch(_error => {});
    target = null;
  }, 10);
  mDragExitTimeoutForTarget.set(target, timeout);
}

function cancelDelayedTSTAPIDragExitOn(target) {
  const timeout = target && mDragExitTimeoutForTarget.get(target);
  if (timeout) {
    clearTimeout(timeout);
    mDragExitTimeoutForTarget.delete(target);
  }
}


function onMessage(message, _sender, _respond) {
  if (!message ||
      typeof message.type != 'string')
    return;

  switch (message.type) {
    case Constants.kCOMMAND_BROADCAST_CURRENT_DRAG_DATA:
      setDragData(message.dragData || null);
      if (!message.dragData)
        onFinishDrag();
      break;
  }
}


TSTAPI.onMessageExternal.addListener((message, _sender) => {
  switch (message.type) {
    case TSTAPI.kGET_DRAG_DATA:
      if (mCurrentDragDataForExternals &&
          message.id == mCurrentDragDataForExternalsId)
        return Promise.resolve(mCurrentDragDataForExternals);
      break;
  }
});
