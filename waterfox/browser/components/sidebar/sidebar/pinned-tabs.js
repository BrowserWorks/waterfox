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
  configs
} from '/common/common.js';

import * as Constants from '/common/constants.js';
import * as TabsStore from '/common/tabs-store.js';

import Tab from '/common/Tab.js';

import * as BackgroundConnection from './background-connection.js';
import * as GapCanceller from './gap-canceller.js';
import * as SidebarTabs from './sidebar-tabs.js';
import * as Size from './size.js';

function log(...args) {
  internalLogger('sidebar/pinned-tabs', ...args);
}

let mTargetWindow;
let mAreaHeight     = 0;
let mMaxVisibleRows = 0;
let mMaxCol         = 0;
let mMaxColLastRow  = 0;
let mMaxRow         = 0;
const mTabsMatrix = new Map();

export function init() {
  mTargetWindow = TabsStore.getCurrentWindowId();
  browser.runtime.onMessage.addListener(onMessage);
}

function getTabHeight() {
  return configs.faviconizePinnedTabs ? Size.getRenderedFavIconizedTabHeight() : Size.getRenderedTabHeight();
}

export function reposition(options = {}) {
  //log('reposition');
  const pinnedTabs = Tab.getPinnedTabs(mTargetWindow);
  if (pinnedTabs.length == 0) {
    reset();
    document.documentElement.classList.remove('have-pinned-tabs');
    return;
  }

  document.documentElement.classList.add('have-pinned-tabs');

  const maxWidth    = Size.getPinnedTabsContainerWidth();
  const faviconized = configs.faviconizePinnedTabs;

  const width  = faviconized ? Size.getRenderedFavIconizedTabWidth() : maxWidth + Size.getFavIconizedTabXOffset();
  const height = getTabHeight();
  const maxCol = faviconized ? Math.max(
    1,
    configs.maxFaviconizedPinnedTabsInOneRow > 0 ?
      configs.maxFaviconizedPinnedTabsInOneRow :
      Math.floor(maxWidth / width)
  ) : 1;
  const maxRow = Math.ceil(pinnedTabs.length / maxCol);

  const pinnedTabsAreaRatio = Math.min(Math.max(0, configs.maxPinnedTabsRowsAreaPercentage), 100) / 100;
  const allTabsAreaHeight   = Size.getAllTabsAreaSize() + GapCanceller.getOffset();
  mMaxVisibleRows = Math.max(1, Math.floor((allTabsAreaHeight * pinnedTabsAreaRatio) / height));
  const contentsHeight = height * maxRow + (faviconized ? Size.getFavIconizedTabYOffset() : Size.getTabYOffset());
  mAreaHeight = Math.min(
    contentsHeight,
    mMaxVisibleRows * height
  );
  document.documentElement.style.setProperty('--pinned-tab-width', `${width}px`);
  document.documentElement.style.setProperty('--pinned-tabs-area-size', `${mAreaHeight}px`);
  if (configs.faviconizePinnedTabs && configs.maxFaviconizedPinnedTabsInOneRow > 0)
    document.documentElement.style.setProperty('--pinned-tabs-max-column', configs.maxFaviconizedPinnedTabsInOneRow);
  else
    document.documentElement.style.removeProperty('--pinned-tabs-max-column');

  Size.updateContainers();
  mTabsMatrix.clear();

  let count = 0;
  let row = 0;
  let col = 0;
  mMaxCol = 0;
  mMaxColLastRow = 0;
  mMaxRow = 0;
  for (const tab of pinnedTabs) {
    mMaxCol = Math.max(col, mMaxCol);
    mMaxRow = row;

    count++;
    if (options.justNow)
      tab.$TST.removeState(Constants.kTAB_STATE_ANIMATION_READY);

    tab.$TST.toggleState(Constants.kTAB_STATE_FAVICONIZED, faviconized);
    tab.$TST.toggleState(Constants.kTAB_STATE_LAST_ROW, row == maxRow - 1);

    if (row == maxRow - 1)
      mMaxColLastRow = col;

    if (options.justNow)
      tab.$TST.addState(Constants.kTAB_STATE_ANIMATION_READY);

    mTabsMatrix.set(`${col}:${row}`, tab.id);

    /*
    log('pinned tab: ', {
      tab:    dumpTab(tab),
      col:    col,
      width:  width,
      height: height
    });
    */

    col++;
    if (count > 0 &&
        count % maxCol == 0) {
      row++;
      col = 0;
      //log('=> new row');
    }
  }
  log('reposition: ', { maxWidth, faviconized, width, height, maxCol, maxRow, pinnedTabsAreaRatio, allTabsAreaHeight, mMaxVisibleRows, mAreaHeight });
  log('overflow: contentsHeight > mAreaHeight : ', contentsHeight > mAreaHeight);
  SidebarTabs.pinnedContainer.classList.toggle('overflow', contentsHeight > mAreaHeight);
}

export function reserveToReposition(options = {}) {
  if (reserveToReposition.waiting)
    clearTimeout(reserveToReposition.waiting);
  reserveToReposition.waiting = setTimeout(() => {
    delete reserveToReposition.waiting;
    reposition(options);
  }, 10);
}

function reset() {
  document.documentElement.style.setProperty('--pinned-tabs-area-size', '0px');
  for (const tab of Tab.getPinnedTabs(mTargetWindow, { iterator: true })) {
    clearStyle(tab);
  }
  mAreaHeight     = 0;
  mMaxVisibleRows = 0;
  mMaxCol         = 0;
  mMaxColLastRow  = 0;
  mMaxRow         = 0;
  mTabsMatrix.clear();
  Size.updateContainers();
}

function clearStyle(tab) {
  tab.$TST.removeState(Constants.kTAB_STATE_FAVICONIZED);
  tab.$TST.removeState(Constants.kTAB_STATE_LAST_ROW);
}

function getTabPosition(tab) {
  if (!tab)
    throw new Error('missing tab');

  log('getTabPosition from ', [...mTabsMatrix.keys()]);
  for (const [position, tabId] of mTabsMatrix.entries()) {
    if (tabId != tab.id)
      continue;
    const [col, row] = position.split(':');
    log(` => ${col}:${row}`);
    return {
      col: parseInt(col),
      row: parseInt(row),
    };
  }

  throw new Error(`no pinned tab with id ${tab.id}`);
}

// This must be synchronous and return Promise on demando, to avoid
// blocking to other listeners.
function onMessage(message, _sender, _respond) {
  if (!message ||
      typeof message.type != 'string' ||
      message.type.indexOf('ws:') != 0)
    return;

  if (message.windowId &&
      message.windowId != mTargetWindow)
    return;

  //log('onMessage: ', message, sender);
  switch (message.type) {
    case Constants.kCOMMAND_GET_ABOVE_TAB: {
      try {
        const { col, row } = getTabPosition(Tab.get(message.tabId));
        const nextRow = row - 1;
        log(`above tab: ${col}:${row} => ${col}:${nextRow}`);
        return Promise.resolve(
          mTabsMatrix.get(`${col}:${nextRow}`) ||
          null
        );
      }
      catch(_error) {
        return Promise.resolve(
          mTabsMatrix.get(`0:${mMaxRow}`) ||
          null
        );
      }
    }; break;

    case Constants.kCOMMAND_GET_BELOW_TAB: {
      const { col, row } = getTabPosition(Tab.get(message.tabId));
      const nextRow = row + 1;
      log(`below tab: ${col}:${row} => ${col}:${nextRow}`);
      return Promise.resolve(
        mTabsMatrix.get(`${col}:${nextRow}`) ||
        mTabsMatrix.get(`${mMaxColLastRow}:${nextRow}`) ||
        null
      );
    }; break;

    case Constants.kCOMMAND_GET_LEFT_TAB: {
      const { col, row } = getTabPosition(Tab.get(message.tabId));
      const maxCol = row == mMaxRow ? mMaxColLastRow : mMaxCol;
      const nextCol = col == 0 ? maxCol : col - 1;
      log(`left tab: ${col}:${row} => ${nextCol}:${row}`);
      return Promise.resolve(
        mTabsMatrix.get(`${nextCol}:${row}`) ||
        null
      );
    }; break;

    case Constants.kCOMMAND_GET_RIGHT_TAB: {
      const { col, row } = getTabPosition(Tab.get(message.tabId));
      const maxCol = row == mMaxRow ? mMaxColLastRow : mMaxCol;
      const nextCol = col == maxCol ? 0 : col + 1;
      log(`right tab: ${col}:${row} => ${nextCol}:${row}`);
      return Promise.resolve(
        mTabsMatrix.get(`${nextCol}:${row}`) ||
        null
      );
    }; break;
  }
}

const BUFFER_KEY_PREFIX = 'pinned-tabs-';

BackgroundConnection.onMessage.addListener(async message => {
  switch (message.type) {
    case Constants.kCOMMAND_NOTIFY_TAB_CREATED: {
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab)
        return;
      if (tab.pinned)
        reserveToReposition();
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_REMOVING:
    case Constants.kCOMMAND_NOTIFY_TAB_MOVED:
    case Constants.kCOMMAND_NOTIFY_TAB_INTERNALLY_MOVED: {
      // don't wait until tracked here, because removing or detaching tab will become untracked!
      const tab = Tab.get(message.tabId);
      if (tab && tab.pinned)
        reserveToReposition();
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_SHOWN:
    case Constants.kCOMMAND_NOTIFY_TAB_HIDDEN:
      reserveToReposition();
      break;

    case Constants.kCOMMAND_NOTIFY_TAB_DETACHED_FROM_WINDOW:
      if (message.wasPinned)
        reserveToReposition();
      break;

    case Constants.kCOMMAND_NOTIFY_TAB_PINNED:
    case Constants.kCOMMAND_NOTIFY_TAB_UNPINNED: {
      if (BackgroundConnection.handleBufferedMessage({ type: 'pinned/unpinned', message }, `${BUFFER_KEY_PREFIX}${message.tabId}`))
        return;
      await Tab.waitUntilTracked(message.tabId, { element: true });
      const tab = Tab.get(message.tabId);
      const lastMessage = BackgroundConnection.fetchBufferedMessage('pinned/unpinned', `${BUFFER_KEY_PREFIX}${message.tabId}`);
      if (!tab ||
          !lastMessage)
        return;
      if (lastMessage.message.type == Constants.kCOMMAND_NOTIFY_TAB_UNPINNED)
        clearStyle(tab);
      reserveToReposition();
    }; break;
  }
});
