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

/* ***** IMPORTANT NOTE FOR BETTER PERFORMANCE *****
   Functions in this module will be called very frequently while
   scrolling. We should not do operations causing style computation
   like calling getBoundingClientRect() or accessing to
   offsetWidth/Height/Top/Left. Instead use Size.getXXXXX() methods
   which return statically calculated sizes. If you need to get
   something more new size, add a logic to calculate it to
   Size.updateTabs() or Size.updateContainers().
   ************************************************* */

import EventListenerManager from '/extlib/EventListenerManager.js';
import { SequenceMatcher } from '/extlib/diff.js';

import {
  log as internalLogger,
  wait,
  nextFrame,
  configs,
  shouldApplyAnimation,
  watchOverflowStateChange,
} from '/common/common.js';

import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from '/common/constants.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';

import * as BackgroundConnection from './background-connection.js';
import * as CollapseExpand from './collapse-expand.js';
import * as EventUtils from './event-utils.js';
import * as RestoringTabCount from './restoring-tab-count.js';
import * as SidebarTabs from './sidebar-tabs.js';
import * as Size from './size.js';

export const onPositionUnlocked = new EventListenerManager();
export const onVirtualScrollViewportUpdated = new EventListenerManager();
export const onNormalTabsOverflow = new EventListenerManager();
export const onNormalTabsUnderflow = new EventListenerManager();

function log(...args) {
  internalLogger('sidebar/scroll', ...args);
}


export const LOCK_REASON_REMOVE   = 'remove';
export const LOCK_REASON_COLLAPSE = 'collapse';

const mPinnedScrollBox  = document.querySelector('#pinned-tabs-container');
const mNormalScrollBox  = document.querySelector('#normal-tabs-container');
const mTabBar           = document.querySelector('#tabbar');
const mOutOfViewTabNotifier = document.querySelector('#out-of-view-tab-notifier');

let mTabbarSpacerSize = 0;

let mScrollingInternallyCount = 0;

export function init(scrollPosition) {
  // We should cached scroll positions, because accessing to those properties is slow.
  mPinnedScrollBox.$scrollTop    = 0;
  mPinnedScrollBox.$scrollTopMax = mPinnedScrollBox.scrollTopMax;
  mPinnedScrollBox.$offsetHeight = mPinnedScrollBox.offsetHeight;
  mNormalScrollBox.$scrollTop    = 0;
  mNormalScrollBox.$scrollTopMax = mNormalScrollBox.scrollTopMax;
  mNormalScrollBox.$offsetHeight = mNormalScrollBox.offsetHeight;

  // We need to register the lister as non-passive to cancel the event.
  // https://developer.mozilla.org/en-US/docs/Web/API/EventTarget/addEventListener#Improving_scrolling_performance_with_passive_listeners
  document.addEventListener('wheel', onWheel, { capture: true, passive: false });
  mPinnedScrollBox.addEventListener('scroll', onScroll);
  mNormalScrollBox.addEventListener('scroll', onScroll);
  startObserveOverflowStateChange();
  browser.runtime.onMessage.addListener(onMessage);
  BackgroundConnection.onMessage.addListener(onBackgroundMessage);
  TSTAPI.onMessageExternal.addListener(onMessageExternal);
  SidebarTabs.onNormalTabsChanged.addListener(_tab => {
    reserveToRenderVirtualScrollViewport({ trigger: 'tabsChanged' });
  });
  Size.onUpdated.addListener(() => {
    mPinnedScrollBox.$scrollTopMax = mPinnedScrollBox.scrollTopMax;
    mPinnedScrollBox.$offsetHeight = mPinnedScrollBox.offsetHeight;
    mNormalScrollBox.$scrollTopMax = mNormalScrollBox.scrollTopMax;
    mNormalScrollBox.$offsetHeight = mNormalScrollBox.offsetHeight;
    reserveToRenderVirtualScrollViewport({ trigger: 'resized', force: true });
  });

  reserveToRenderVirtualScrollViewport({ trigger: 'initialize' });
  if (typeof scrollPosition != 'number')
    return;

  if (scrollPosition <= mNormalScrollBox.$scrollTopMax) {
    mNormalScrollBox.scrollTop =
      mNormalScrollBox.$scrollTop = Math.max(0, scrollPosition);
    return;
  }

  mScrollingInternallyCount++;
  restoreScrollPosition.scrollPosition = scrollPosition;
  onNormalTabsOverflow.addListener(onInitialOverflow);
  onVirtualScrollViewportUpdated.addListener(onInitialUpdate);
  wait(1000).then(() => {
    onNormalTabsOverflow.removeListener(onInitialOverflow);
    onVirtualScrollViewportUpdated.removeListener(onInitialUpdate);
    if (restoreScrollPosition.scrollPosition != -1 &&
        mScrollingInternallyCount > 0)
      mScrollingInternallyCount--;
    restoreScrollPosition.scrollPosition = -1;
    log('timeout: give up to restore scroll position');
  });
}

function startObserveOverflowStateChange() {
  watchOverflowStateChange({
    target: mNormalScrollBox,
    vertical: true,
    moreResizeTargets: [
      // We need to watch resizing of the virtual scroll container to detect the changed state correctly.
      mNormalScrollBox.querySelector('.virtual-scroll-container'),
    ],
    onOverflow() { onNormalTabsOverflow.dispatch(); },
    onUnderflow() { onNormalTabsUnderflow.dispatch(); },
  });

  onNormalTabsOverflow.addListener(() => {
    reserveToUpdateScrolledState(mNormalScrollBox);
  });
  onNormalTabsUnderflow.addListener(() => {
    reserveToUpdateScrolledState(mNormalScrollBox);
  });
}

function onInitialOverflow() {
  onNormalTabsOverflow.removeListener(onInitialOverflow);
  onInitialOverflow.done = true;
  if (onInitialUpdate.done)
    restoreScrollPosition();
}
function onInitialUpdate() {
  onVirtualScrollViewportUpdated.removeListener(onInitialUpdate);
  onInitialUpdate.done = true;
  if (onInitialOverflow.done)
    restoreScrollPosition();
}
function restoreScrollPosition() {
  if (restoreScrollPosition.retryCount < 10 &&
      restoreScrollPosition.scrollPosition > mNormalScrollBox.$scrollTopMax) {
    restoreScrollPosition.retryCount++;
    return window.requestAnimationFrame(restoreScrollPosition);
  }

  if (restoreScrollPosition.scrollPosition <= mNormalScrollBox.$scrollTopMax)
    mNormalScrollBox.scrollTop =
      mNormalScrollBox.$scrollTop = Math.max(
        0,
        restoreScrollPosition.scrollPosition
      );
  restoreScrollPosition.scrollPosition = -1;
  if (mScrollingInternallyCount > 0) {
    window.requestAnimationFrame(() => {
      if (mScrollingInternallyCount > 0)
        mScrollingInternallyCount--;
    });
  }
}
restoreScrollPosition.retryCount = 0;
restoreScrollPosition.scrollPosition = -1;


/* virtual scrolling */

export function reserveToRenderVirtualScrollViewport({ trigger, force } = {}) {
  if (!force &&
      mScrollingInternallyCount > 0)
    return;

  if (trigger)
    renderVirtualScrollViewport.triggers.add(trigger);

  if (renderVirtualScrollViewport.invoked)
    return;
  renderVirtualScrollViewport.invoked = true;
  window.requestAnimationFrame(() => renderVirtualScrollViewport());
}

let mLastRenderableTabs;
let mLastDisappearingTabs;
let mLastRenderedVirtualScrollTabIds = [];
const STICKY_SPACER_MATCHER = /^(\d+):sticky$/;
let mScrollPosition = 0;

renderVirtualScrollViewport.triggers = new Set();

function renderVirtualScrollViewport(scrollPosition = undefined) {
  renderVirtualScrollViewport.invoked = false;
  const triggers = new Set([...renderVirtualScrollViewport.triggers]);
  renderVirtualScrollViewport.triggers.clear();

  const startAt = Date.now();

  const windowId = TabsStore.getCurrentWindowId();
  const win      = TabsStore.windows.get(windowId);
  if (!win ||
      !win.containerElement)
    return; // not initialized yet


  const outOfScreenPages = configs.outOfScreenTabsRenderingPages;
  const staticRendering  = outOfScreenPages < 0;
  const skipRefreshTabs  = staticRendering && triggers.size == 1 && triggers.has('scroll');

  const tabSize               = Size.getRenderedTabHeight();
  const renderableTabs        = skipRefreshTabs && mLastRenderableTabs || Tab.getVirtualScrollRenderableTabs(windowId);
  const disappearingTabs      = skipRefreshTabs && mLastDisappearingTabs || renderableTabs.filter(tab => tab.$TST.removing || tab.$TST.states.has(Constants.kTAB_STATE_COLLAPSING));
  const allRenderableTabsSize = Size.getTabMarginTop() + (tabSize * (renderableTabs.length - disappearingTabs.length)) + Size.getTabMarginBottom();
  const viewPortSize = Size.getNormalTabsViewPortSize();

  if (staticRendering) {
    mLastRenderableTabs = renderableTabs;
    mLastDisappearingTabs = disappearingTabs;
  }

  // For underflow case, we need to unset min-height to put the "new tab"
  // button next to the last tab immediately.
  // We need to set the style value directly instead of using custom properties, to reduce needless style computation.
  mNormalScrollBox.querySelector('.virtual-scroll-container').style.minHeight = `${viewPortSize < allRenderableTabsSize ? allRenderableTabsSize : 0}px`;

  const allTabsSizeHolder = win.containerElement.parentNode;
  const resized           = allTabsSizeHolder.$lastHeight != allRenderableTabsSize;
  allTabsSizeHolder.$lastHeight = allRenderableTabsSize;
  if (resized) {
    mNormalScrollBox.$offsetHeight = mNormalScrollBox.offsetHeight;
    mNormalScrollBox.$scrollTopMax = /*mNormalScrollBox.scrollTopMax*/Math.max(0, allRenderableTabsSize - viewPortSize);
  }

  const renderablePaddingSize = staticRendering ?
    allRenderableTabsSize :
    viewPortSize * outOfScreenPages;
  scrollPosition = Math.max(
    0,
    Math.min(
      allRenderableTabsSize + mTabbarSpacerSize - viewPortSize,
      typeof scrollPosition == 'number' ?
        scrollPosition :
        restoreScrollPosition.scrollPosition > -1 ?
          restoreScrollPosition.scrollPosition :
          mNormalScrollBox.$scrollTop
    )
  );
  mScrollPosition = scrollPosition;

  const firstRenderableIndex = Math.max(
    0,
    Math.floor((scrollPosition - renderablePaddingSize) / tabSize)
  );
  const lastRenderableIndex = Math.max(
    0,
    Math.min(
      renderableTabs.length - 1,
      Math.ceil((scrollPosition + viewPortSize + renderablePaddingSize) / tabSize)
    )
  );
  const renderedOffset = tabSize * firstRenderableIndex;
  // We need to set the style value directly instead of using custom properties, to reduce needless style computation.
  mNormalScrollBox.querySelector('.tabs').style.transform = staticRendering ?
    '' :
    `translateY(${renderedOffset}px)`;
  // We need to shift contents one more, to cover the reduced height due to the sticky tab.

  if (resized) {
    reserveToUpdateScrolledState(mNormalScrollBox)
    onVirtualScrollViewportUpdated.dispatch(resized);
  }

  const stickyTabs = updateStickyTabs(renderableTabs, { staticRendering, skipRefreshTabs });

  if (skipRefreshTabs) {
    log('renderVirtualScrollViewport: skip re-rendering of tabs, rendered = ', renderableTabs);
    if (mLastRenderedVirtualScrollTabIds.length != renderableTabs.length)
      mLastRenderedVirtualScrollTabIds = renderableTabs.map(tab => tab.id);
  }
  else {
    const toBeRenderedTabs = renderableTabs.slice(firstRenderableIndex, lastRenderableIndex + 1);
    const toBeRenderedTabIds = toBeRenderedTabs.map(tab => tab.id);
    const toBeRenderedTabIdsSet = new Set(toBeRenderedTabIds);
    for (const stickyTab of stickyTabs) {
      if (toBeRenderedTabIdsSet.has(stickyTab.id))
        toBeRenderedTabIds.splice(toBeRenderedTabIds.indexOf(stickyTab.id), 1, `${stickyTab.id}:sticky`);
    }

    const renderOperations = (new SequenceMatcher(mLastRenderedVirtualScrollTabIds, toBeRenderedTabIds)).operations();
    log('renderVirtualScrollViewport ', {
      firstRenderableIndex,
      firstRenderableTabIndex: renderableTabs[firstRenderableIndex]?.index,
      lastRenderableIndex,
      lastRenderableTabIndex: renderableTabs[lastRenderableIndex]?.index,
      old: mLastRenderedVirtualScrollTabIds.slice(0),
      new: toBeRenderedTabIds.slice(0),
      renderOperations,
      scrollPosition,
      viewPortSize,
      allRenderableTabsSize,
    });

    const toBeRenderedTabIdSet = new Set(toBeRenderedTabIds);
    for (const operation of renderOperations) {
      const [tag, fromStart, fromEnd, toStart, toEnd] = operation;
      switch (tag) {
        case 'equal':
          break;

        case 'delete': {
          const ids = mLastRenderedVirtualScrollTabIds.slice(fromStart, fromEnd);
          //log('delete: ', { fromStart, fromEnd, toStart, toEnd }, ids);
          for (const id of ids) {
            if (STICKY_SPACER_MATCHER.test(id)) {
              const spacer = win.containerElement.querySelector(`.sticky-tab-spacer[data-tab-id="${RegExp.$1}"]`);
              if (spacer)
                spacer.parentNode.removeChild(spacer);
              continue;
            }
            const tab = Tab.get(id);
            if (tab?.$TST.element?.parentNode != win.containerElement) // already sticky
              continue;
            // We don't need to remove already rendered tab,
            // because it is automatically moved by insertBefore().
            if (toBeRenderedTabIdSet.has(id) ||
                !tab ||
                !mNormalScrollBox.contains(tab.$TST.element))
              continue;
            SidebarTabs.unrenderTab(tab);
          }
        }; break;

        case 'insert':
        case 'replace': {
          const deleteIds = mLastRenderedVirtualScrollTabIds.slice(fromStart, fromEnd);
          const insertIds = toBeRenderedTabIds.slice(toStart, toEnd);
          //log('insert or replace: ', { fromStart, fromEnd, toStart, toEnd }, deleteIds, ' => ', insertIds);
          for (const id of deleteIds) {
            if (STICKY_SPACER_MATCHER.test(id)) {
              const spacer = win.containerElement.querySelector(`.sticky-tab-spacer[data-tab-id="${RegExp.$1}"]`);
              if (spacer)
                spacer.parentNode.removeChild(spacer);
              continue;
            }
            const tab = Tab.get(id);
            if (tab?.$TST.element?.parentNode != win.containerElement) // already sticky
              continue;
            // We don't need to remove already rendered tab,
            // because it is automatically moved by insertBefore().
            if (toBeRenderedTabIdSet.has(id) ||
                !tab ||
                !mNormalScrollBox.contains(tab.$TST.element))
              continue;
            SidebarTabs.unrenderTab(tab);
          }
          const referenceTab = fromEnd < mLastRenderedVirtualScrollTabIds.length ?
            Tab.get(extractIdPart(mLastRenderedVirtualScrollTabIds[fromEnd])) :
            null;
          const referenceTabHasValidReferenceElement = referenceTab?.$TST.element?.parentNode == win.containerElement;
          for (const id of insertIds) {
            if (STICKY_SPACER_MATCHER.test(id)) {
              const spacer = document.createElement('li');
              spacer.classList.add('sticky-tab-spacer');
              spacer.setAttribute('data-tab-id', RegExp.$1);
              win.containerElement.insertBefore(
                spacer,
                (referenceTab && win.containerElement.querySelector(`.sticky-tab-spacer[data-tab-id="${referenceTab.id}"]`)) ||
                (referenceTabHasValidReferenceElement &&
                 referenceTab.$TST.element) ||
                null
              );
              continue;
            }
            SidebarTabs.renderTab(Tab.get(id), {
              insertBefore: referenceTabHasValidReferenceElement ? referenceTab :
                (referenceTab && win.containerElement.querySelector(`.sticky-tab-spacer[data-tab-id="${referenceTab.id}"]`)) ||
                null,
            });
          }
        }; break;
      }
    }
    mLastRenderedVirtualScrollTabIds = toBeRenderedTabIds;
  }

  log(`${Date.now() - startAt} msec, offset = ${renderedOffset}`);
}
function extractIdPart(id) {
  if (STICKY_SPACER_MATCHER.test(id))
    return parseInt(RegExp.$1);
  return id;
}

let mLastStickyTabIdsAbove = new Set();
let mLastStickyTabIdsBelow = new Set();
let mLastCanBeStickyTabs;

function updateStickyTabs(renderableTabs, { staticRendering, skipRefreshTabs } = {}) {
  const tabSize        = Size.getRenderedTabHeight();
  const windowId       = TabsStore.getCurrentWindowId();
  const scrollPosition = mScrollPosition;
  const viewPortSize   = Size.getNormalTabsViewPortSize();

  const firstInViewportIndex = Math.ceil(scrollPosition / tabSize);
  const lastInViewportIndex  = Math.floor((scrollPosition + viewPortSize - tabSize) / tabSize);

  const stickyTabIdsAbove = new Set();
  const stickyTabIdsBelow = new Set();
  const stickyTabs = [];

  const canBeStickyTabs = skipRefreshTabs && mLastCanBeStickyTabs || renderableTabs.filter(tab => tab.$TST.canBecomeSticky);
  log('canBeStickyTabs ', canBeStickyTabs);
  if (staticRendering)
    mLastCanBeStickyTabs = canBeStickyTabs;

  const removedOrCollapsedTabsCount = parseInt(mNormalScrollBox.querySelector(`.${Constants.kTABBAR_SPACER}`).dataset.removedOrCollapsedTabsCount || 0);
  for (const tab of canBeStickyTabs.slice(0).reverse()) { // first try: find bottom sticky tabs from bottom
    const index = renderableTabs.indexOf(tab);
    if (index > -1 &&
        index > (lastInViewportIndex - stickyTabIdsBelow.size) &&
        mNormalScrollBox.$scrollTop < mNormalScrollBox.$scrollTopMax &&
        (index - (lastInViewportIndex - stickyTabIdsBelow.size) > 1 ||
         removedOrCollapsedTabsCount == 0)) {
      stickyTabIdsBelow.add(tab.id);
      continue;
    }
    if (stickyTabIdsBelow.size > 0)
      break;
  }

  for (const tab of canBeStickyTabs) { // second try: find top sticky tabs and set bottom sticky tabs
    const index = renderableTabs.indexOf(tab);
    if (index > -1 &&
        index < (firstInViewportIndex + stickyTabIdsAbove.size) &&
        mNormalScrollBox.$scrollTop > 0) {
      stickyTabs.push(tab);
      stickyTabIdsAbove.add(tab.id);
      continue;
    }
    if (stickyTabIdsBelow.has(tab.id)) {
      stickyTabs.push(tab);
      continue;
    }
    if (tab.$TST.element &&
        tab.$TST.element.parentNode != TabsStore.windows.get(windowId).containerElement) {
      SidebarTabs.unrenderTab(tab);
      continue;
    }
  }

  for (const [lastIds, currentIds, place] of [
    [[...mLastStickyTabIdsAbove], [...stickyTabIdsAbove], 'above'],
    [[...mLastStickyTabIdsBelow].reverse(), [...stickyTabIdsBelow].reverse(), 'below'],
  ]) {
    const renderOperations = (new SequenceMatcher(lastIds, currentIds)).operations();
    for (const operation of renderOperations) {
      const [tag, fromStart, fromEnd, toStart, toEnd] = operation;
      switch (tag) {
        case 'equal':
          break;

        case 'delete': {
          const ids = lastIds.slice(fromStart, fromEnd);
          for (const id of ids) {
            if (!stickyTabIdsAbove.has(id) &&
                !stickyTabIdsBelow.has(id))
              SidebarTabs.unrenderTab(Tab.get(id));
          }
        }; break;

        case 'insert':
        case 'replace': {
          const deleteIds = lastIds.slice(fromStart, fromEnd);
          for (const id of deleteIds) {
            if (!stickyTabIdsAbove.has(id) &&
                !stickyTabIdsBelow.has(id))
              SidebarTabs.unrenderTab(Tab.get(id));
          }
          const insertIds = currentIds.slice(toStart, toEnd);
          const referenceTab = (fromEnd < lastIds.length && currentIds.includes(lastIds[fromEnd])) ?
            Tab.get(lastIds[fromEnd]) :
            null;
          for (const id of insertIds) {
            SidebarTabs.renderTab(Tab.get(id), {
              containerElement: document.querySelector(`.sticky-tabs-container.${place}`),
              insertBefore:     referenceTab,
            });
          }
        }; break;
      }
    }
  }

  log('updateStickyTab ', stickyTabs, { above: [...stickyTabIdsAbove], below: [...stickyTabIdsBelow] });
  mLastStickyTabIdsAbove = stickyTabIdsAbove;
  mLastStickyTabIdsBelow = stickyTabIdsBelow;

  return stickyTabs;
}

function getScrollBoxFor(tab, { allowFallback } = {}) {
  if (!tab || !tab.pinned)
    return mNormalScrollBox; // the default
  if (allowFallback &&
      mPinnedScrollBox.$scrollTopMax == 0) {
    log('pinned tabs are not scrollable, fallback to normal tabs');
    return mNormalScrollBox;
  }
  return mPinnedScrollBox;
}

export function getTabRect(tab) {
  if (tab.pinned)
    return tab.$TST.element.getBoundingClientRect();

  const renderableTabs = Tab.getVirtualScrollRenderableTabs(tab.windowId).map(tab => tab.id);
  const tabSize        = Size.getTabHeight();
  const scrollBox      = getScrollBoxFor(tab);
  const scrollBoxRect  = Size.getScrollBoxRect(scrollBox);

  let index = renderableTabs.indexOf(tab.id);
  if (index < 0) { // the tab is not renderable yet, so we calculate the index based on other tabs.
    const following = tab.$TST.nearestVisibleFollowingTab;
    if (following) {
      index = renderableTabs.indexOf(following.id);
    }
    else {
      const preceding = tab.$TST.nearestVisiblePrecedingTab;
      if (preceding) {
        index = renderableTabs.indexOf(preceding.id);
        if (index > -1)
          index++;
      }
    }
    if (index < -1) // no nearest visible tab: treat as a last tab
      index = renderableTabs.length;
  }
  const tabTop = Size.getRenderedTabHeight() * index + scrollBoxRect.top - scrollBox.$scrollTop;
  /*
  console.log('coordinates of tab rect ', {
    index,
    renderableTabHeight: Size.getRenderedTabHeight(),
    scrollBox_rectTop: scrollBoxRect.top,
    scrollBox_$scrollTop: scrollBox.$scrollTop,
  });
  */
  return {
    top:    tabTop,
    bottom: tabTop + tabSize,
    height: tabSize,
  };
}

configs.$addObserver(key => {
  switch (key) {
    case 'outOfScreenTabsRenderingPages':
      mLastRenderableTabs   = null;
      mLastDisappearingTabs = null;
      mLastCanBeStickyTabs  = null;
      break;
  }
});


/* basic operations */

function scrollTo(params = {}) {
  log('scrollTo ', params);
  if (!params.justNow &&
      shouldApplyAnimation(true) &&
      configs.smoothScrollEnabled)
    return smoothScrollTo(params);

  //cancelPerformingAutoScroll();
  const scrollBox = getScrollBoxFor(params.tab, { allowFallback: true });
  const scrollTop = params.tab ?
    scrollBox.$scrollTop + calculateScrollDeltaForTab(params.tab) :
    typeof params.position == 'number' ?
      params.position :
      typeof params.delta == 'number' ?
        mNormalScrollBox.$scrollTop + params.delta :
        undefined;
  if (scrollTop === undefined)
    throw new Error('No parameter to indicate scroll position');

  // render before scroll, to prevent showing blank area
  mScrollingInternallyCount++;
  renderVirtualScrollViewport(scrollTop);
  scrollBox.scrollTop =
    scrollBox.$scrollTop = Math.min(
      scrollBox.$scrollTopMax,
      Math.max(0, scrollTop)
    );
  window.requestAnimationFrame(() => {
    if (mScrollingInternallyCount > 0)
      mScrollingInternallyCount--;
  });
}

function cancelRunningScroll() {
  scrollToTab.stopped = true;
  stopSmoothScroll();
}

function calculateScrollDeltaForTab(tab, { over } = {}) {
  tab = Tab.get(tab && tab.id);
  if (!tab)
    return 0;

  tab = tab.$TST.collapsed && tab.$TST.nearestVisibleAncestorOrSelf || tab;

  const tabRect       = getTabRect(tab);
  const scrollBoxRect = Size.getScrollBoxRect(getScrollBoxFor(tab, { allowFallback: true }));
  const overScrollOffset = over === false ?
    0 :
    Math.ceil(tabRect.height / 2);
  let delta = 0;
  if (scrollBoxRect.bottom < tabRect.bottom) { // should scroll down
    delta = tabRect.bottom - scrollBoxRect.bottom + overScrollOffset;
    if (mLastStickyTabIdsBelow.has(tab.id) &&
        mLastStickyTabIdsBelow.size > 0)
      delta += tabRect.height * (mLastStickyTabIdsBelow.size - 1);
    else
      delta += tabRect.height * mLastStickyTabIdsBelow.size;
  }
  else if (scrollBoxRect.top > tabRect.top) { // should scroll up
    delta = tabRect.top - scrollBoxRect.top - overScrollOffset;
    if (mLastStickyTabIdsAbove.has(tab.id) &&
        mLastStickyTabIdsAbove.size > 0)
      delta -= tabRect.height * (mLastStickyTabIdsAbove.size - 1);
    else
      delta -= tabRect.height * mLastStickyTabIdsAbove.size;
  }
  log('calculateScrollDeltaForTab ', tab.id, {
    delta,
    tabTop:          tabRect.top,
    tabBottom:       tabRect.bottom,
    scrollBoxBottom: scrollBoxRect.bottom
  });
  return delta;
}

export function isTabInViewport(tab, { allowPartial } = {}) {
  tab = Tab.get(tab && tab.id);
  if (!TabsStore.ensureLivingTab(tab))
    return false;

  if (tab.pinned)
    return true;

  const tabRect       = getTabRect(tab);
  const allowedOffset = allowPartial ? (tabRect.height / 2) : 0;
  const scrollBoxRect = Size.getScrollBoxRect(getScrollBoxFor(tab));
  log('isTabInViewport ', tab.id, {
    allowedOffset,
    tabTop:         tabRect.top + allowedOffset,
    tabBottom:      tabRect.bottom - allowedOffset,
    viewPortTop:    scrollBoxRect.top,
    viewPortBottom: scrollBoxRect.bottom,
  });
  return (
    tabRect.top + allowedOffset >= scrollBoxRect.top &&
    tabRect.bottom - allowedOffset <= scrollBoxRect.bottom
  );
}

async function smoothScrollTo(params = {}) {
  log('smoothScrollTo ', params, new Error().stack);
  //cancelPerformingAutoScroll(true);

  smoothScrollTo.stopped = false;

  const scrollBox = params.scrollBox || getScrollBoxFor(params.tab, { allowFallback: true });

  let delta, startPosition, endPosition;
  if (params.tab) {
    startPosition = scrollBox.$scrollTop;
    delta       = calculateScrollDeltaForTab(params.tab);
    endPosition = startPosition + delta;
  }
  else if (typeof params.position == 'number') {
    startPosition = scrollBox.$scrollTop;
    endPosition = params.position;
    delta       = endPosition - startPosition;
  }
  else if (typeof params.delta == 'number') {
    startPosition = scrollBox.$scrollTop;
    endPosition = startPosition + params.delta;
    delta       = params.delta;
  }
  else {
    throw new Error('No parameter to indicate scroll position');
  }
  smoothScrollTo.currentOffset = delta;

  const duration  = Math.max(0, typeof params.duration == 'number' ? params.duration : configs.smoothScrollDuration);
  const startTime = Date.now();

  return new Promise((resolve, _reject) => {
    const radian = 90 * Math.PI / 180;
    const scrollStep = () => {
      if (smoothScrollTo.stopped) {
        smoothScrollTo.currentOffset = 0;
        //reject('smooth scroll is canceled');
        resolve();
        return;
      }
      const nowTime = Date.now();
      const spentTime = nowTime - startTime;
      if (spentTime >= duration) {
        scrollTo({
          position: endPosition,
          justNow: true
        });
        smoothScrollTo.stopped       = true;
        smoothScrollTo.currentOffset = 0;
        resolve();
        return;
      }
      const power        = Math.sin(spentTime / duration * radian);
      const currentDelta = parseInt(delta * power);
      const newPosition  = startPosition + currentDelta;
      scrollTo({
        position: newPosition,
        justNow:  true
      });
      smoothScrollTo.currentOffset = currentDelta;
      window.requestAnimationFrame(scrollStep);
    };
    window.requestAnimationFrame(scrollStep);
  });
}
smoothScrollTo.currentOffset= 0;

async function smoothScrollBy(delta) {
  const scrollBox = getScrollBoxFor(
    Tab.getActiveTab(TabsStore.getCurrentWindowId()),
    { allowFallback: true }
  );
  return smoothScrollTo({
    position: scrollBox.$scrollTop + delta,
    scrollBox,
  });
}

function stopSmoothScroll() {
  smoothScrollTo.stopped = true;
}

/* advanced operations */

export function scrollToNewTab(tab, options = {}) {
  if (!canScrollToTab(tab))
    return;

  if (configs.scrollToNewTabMode == Constants.kSCROLL_TO_NEW_TAB_IF_POSSIBLE) {
    const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
    scrollToTab(tab, {
      ...options,
      anchor:            !activeTab.pinned && isTabInViewport(activeTab) && activeTab,
      notifyOnOutOfView: true
    });
  }
}

function canScrollToTab(tab) {
  tab = Tab.get(tab && tab.id);
  return (TabsStore.ensureLivingTab(tab) &&
          !tab.hidden);
}

export async function scrollToTab(tab, options = {}) {
  scrollToTab.lastTargetId = null;

  log('scrollToTab to ', tab && tab.id, options.anchor && options.anchor.id, options,
      { stack: configs.debug && new Error().stack });
  cancelRunningScroll();
  if (!canScrollToTab(tab)) {
    log('=> unscrollable');
    return;
  }

  scrollToTab.stopped = false;
  cancelNotifyOutOfViewTab();
  //cancelPerformingAutoScroll(true);

  await nextFrame();
  if (scrollToTab.stopped)
    return;
  cancelNotifyOutOfViewTab();

  const anchorTab = options.anchor;
  const hasAnchor = TabsStore.ensureLivingTab(anchorTab) && anchorTab != tab;
  const openedFromPinnedTab = hasAnchor && anchorTab.pinned;

  if (isTabInViewport(tab) &&
      (!hasAnchor ||
       !openedFromPinnedTab)) {
    log('=> already visible');
    return;
  }

  // wait for one more frame, to start collapse/expand animation
  await nextFrame();
  if (scrollToTab.stopped)
    return;
  cancelNotifyOutOfViewTab();
  scrollToTab.lastTargetId = tab.id;

  const scrollBox = getScrollBoxFor(tab);
  if (hasAnchor &&
      !anchorTab.pinned) {
    const targetTabRect = getTabRect(tab);
    const anchorTabRect = getTabRect(anchorTab);
    const scrollBoxRect = Size.getScrollBoxRect(scrollBox);
    let delta = calculateScrollDeltaForTab(tab, { over: false });

    let topStickyTabsAreaSize, bottomStickyTabsAreaSize;
    if (mLastStickyTabIdsAbove.has(anchorTab.id) &&
        mLastStickyTabIdsAbove.size > 0)
      topStickyTabsAreaSize = Size.getRenderedTabHeight() * (mLastStickyTabIdsAbove.size - 1);
    else
      topStickyTabsAreaSize = Size.getRenderedTabHeight() * mLastStickyTabIdsAbove.size;

    if (mLastStickyTabIdsBelow.has(tab.id) &&
        mLastStickyTabIdsBelow.size > 0)
      bottomStickyTabsAreaSize = Size.getRenderedTabHeight() * (mLastStickyTabIdsBelow.size - 1);
    else
      bottomStickyTabsAreaSize = Size.getRenderedTabHeight() * mLastStickyTabIdsBelow.size;

    if (targetTabRect.top > anchorTabRect.top) {
      log('=> will scroll down');
      const boundingHeight = (targetTabRect.bottom + bottomStickyTabsAreaSize) - (anchorTabRect.top - topStickyTabsAreaSize);
      const overHeight     = boundingHeight - scrollBoxRect.height;
      if (overHeight > 0) {
        delta -= overHeight;
        if (options.notifyOnOutOfView)
          notifyOutOfViewTab(tab);
      }
      log('calculated result: ', {
        boundingHeight, overHeight, delta,
        container:      scrollBoxRect.height
      });
    }
    else if (targetTabRect.bottom < anchorTabRect.bottom) {
      log('=> will scroll up');
      const boundingHeight = anchorTabRect.bottom - targetTabRect.top;
      const overHeight     = boundingHeight - scrollBoxRect.height;
      if (overHeight > 0)
        delta += overHeight;
      log('calculated result: ', {
        boundingHeight, overHeight, delta,
        container:      scrollBoxRect.height
      });
    }
    await scrollTo({
      ...options,
      position: scrollBox.$scrollTop + delta,
    });
  }
  else {
    await scrollTo({
      ...options,
      tab
    });
  }
  // A tab can be moved after the tabbar is scrolled to the tab.
  // To retry "scroll to tab" behavior for such cases, we need to
  // keep "last scrolled-to tab" information until the tab is
  // actually moved.
  await wait(configs.tabBunchesDetectionTimeout);
  if (scrollToTab.stopped)
    return;
  const retryOptions = {
    retryCount: options.retryCount || 0,
    anchor:     options.anchor
  };
  if (scrollToTab.lastTargetId == tab.id &&
      !isTabInViewport(tab) &&
      (!options.anchor ||
       !isTabInViewport(options.anchor)) &&
      retryOptions.retryCount < 3) {
    retryOptions.retryCount++;
    return scrollToTab(tab, retryOptions);
  }
  if (scrollToTab.lastTargetId == tab.id)
    scrollToTab.lastTargetId = null;
}
scrollToTab.lastTargetId = null;

/*
function scrollToTabSubtree(tab) {
  return scrollToTab(tab.$TST.lastDescendant, {
    anchor:            tab,
    notifyOnOutOfView: true
  });
}

function scrollToTabs(tabs) {
  return scrollToTab(tabs[tabs.length - 1], {
    anchor:            tabs[0],
    notifyOnOutOfView: true
  });
}
*/

export function autoScrollOnMouseEvent(event) {
  if (!event.target.closest ||
      autoScrollOnMouseEvent.invoked)
    return;

  const scrollBox = event.target.closest(`#${mPinnedScrollBox.id}, #${mNormalScrollBox.id}`);
  if (!scrollBox ||
      !scrollBox.classList.contains(Constants.kTABBAR_STATE_OVERFLOW))
    return;

  autoScrollOnMouseEvent.invoked = true;
  window.requestAnimationFrame(() => {
    autoScrollOnMouseEvent.invoked = false;

    const tabbarRect = Size.getScrollBoxRect(scrollBox);
    const scrollPixels = Math.round(Size.getRenderedTabHeight() * 0.5);
    if (event.clientY < tabbarRect.top + autoScrollOnMouseEvent.areaSize) {
      if (scrollBox.$scrollTop > 0)
        scrollBox.scrollTop =
          scrollBox.$scrollTop = Math.min(
            scrollBox.$scrollTopMax,
            Math.max(
              0,
              scrollBox.$scrollTop - scrollPixels
            )
          );
    }
    else if (event.clientY > tabbarRect.bottom - autoScrollOnMouseEvent.areaSize) {
      if (scrollBox.$scrollTop < scrollBox.$scrollTopMax)
        scrollBox.scrollTop =
          scrollBox.$scrollTop = Math.min(
            scrollBox.$scrollTopMax,
            Math.max(
              0,
              scrollBox.$scrollTop + scrollPixels
            )
          );
    }
  });
}
autoScrollOnMouseEvent.areaSize = 20;


async function notifyOutOfViewTab(tab) {
  tab = Tab.get(tab && tab.id);
  if (RestoringTabCount.hasMultipleRestoringTabs()) {
    log('notifyOutOfViewTab: skip until completely restored');
    wait(100).then(() => notifyOutOfViewTab(tab));
    return;
  }
  await nextFrame();
  cancelNotifyOutOfViewTab();
  if (tab && isTabInViewport(tab))
    return;
  mOutOfViewTabNotifier.classList.add('notifying');
  await wait(configs.outOfViewTabNotifyDuration);
  cancelNotifyOutOfViewTab();
}

function cancelNotifyOutOfViewTab() {
  mOutOfViewTabNotifier.classList.remove('notifying');
}


/* event handling */

async function onWheel(event) {
  // Ctrl-WheelScroll produces zoom-in/out on all platforms
  // including macOS (not Meta-WheelScroll!).
  // Pinch-in/out on macOS also produces zoom-in/out and
  // it is cancelable via synthesized `wheel` event.
  // (See also: https://bugzilla.mozilla.org/show_bug.cgi?id=1777199#c5 )
  if (!configs.zoomable &&
      event.ctrlKey) {
    event.preventDefault();
    return;
  }

  const tab = EventUtils.getTabFromEvent(event);
  const scrollBox = getScrollBoxFor(tab, { allowFallback: true });

  if (!TSTAPI.isScrollLocked()) {
    cancelRunningScroll();
    if (EventUtils.getElementTarget(event).closest('.sticky-tabs-container') ||
        (tab?.pinned &&
         scrollBox != mPinnedScrollBox)) {
      event.stopImmediatePropagation();
      event.preventDefault();
      scrollTo({ delta: event.deltaY, scrollBox });
    }
    return;
  }

  event.stopImmediatePropagation();
  event.preventDefault();

  TSTAPI.notifyScrolled({
    tab,
    scrollContainer: scrollBox,
    overflow: scrollBox.classList.contains(Constants.kTABBAR_STATE_OVERFLOW),
    event
  });
}

function onScroll(event) {
  const scrollBox = event.currentTarget;
  scrollBox.$scrollTopMax = scrollBox.scrollTopMax;
  scrollBox.$scrollTop = Math.min(scrollBox.$scrollTopMax, scrollBox.scrollTop);
  reserveToUpdateScrolledState(scrollBox);
  if (scrollBox == mNormalScrollBox) {
    reserveToRenderVirtualScrollViewport({ trigger: 'scroll' });
  }
  reserveToSaveScrollPosition();
}


function reserveToUpdateScrolledState(scrollBox) {
  if (scrollBox.__reserveToUpdateScrolledState_invoked) // eslint-disable-line no-underscore-dangle
    return;
  scrollBox.__reserveToUpdateScrolledState_invoked = true; // eslint-disable-line no-underscore-dangle
  window.requestAnimationFrame(() => {
    scrollBox.__reserveToUpdateScrolledState_invoked = false; // eslint-disable-line no-underscore-dangle

    const scrolled = scrollBox.$scrollTop > 0;
    const fullyScrolled = scrollBox.$scrollTop == scrollBox.$scrollTopMax;
    scrollBox.classList.toggle(Constants.kTABBAR_STATE_SCROLLED, scrolled);
    scrollBox.classList.toggle(Constants.kTABBAR_STATE_FULLY_SCROLLED, fullyScrolled);

    if (scrollBox == mNormalScrollBox) {
      mTabBar.classList.toggle(Constants.kTABBAR_STATE_SCROLLED, scrolled);
      mTabBar.classList.toggle(Constants.kTABBAR_STATE_FULLY_SCROLLED, fullyScrolled);
    }

    Size.updateContainers();
  });
}

function reserveToSaveScrollPosition() {
  if (reserveToSaveScrollPosition.reserved)
    clearTimeout(reserveToSaveScrollPosition.reserved);
  reserveToSaveScrollPosition.reserved = setTimeout(() => {
    delete reserveToSaveScrollPosition.reserved;
    browser.sessions.setWindowValue(
      TabsStore.getCurrentWindowId(),
      Constants.kWINDOW_STATE_SCROLL_POSITION,
      mNormalScrollBox.$scrollTop
    ).catch(ApiTabs.createErrorSuppressor());
  }, 150);
}

const mReservedScrolls = new WeakMap();

function reserveToScrollToTab(tab, options = {}) {
  if (!tab)
    return;

  const scrollBox = getScrollBoxFor(tab);
  const reservedScroll = {
    tabId: tab.id,
    options,
  };
  mReservedScrolls.set(scrollBox, reservedScroll);
  window.requestAnimationFrame(() => {
    if (mReservedScrolls.get(scrollBox) != reservedScroll)
      return;
    mReservedScrolls.delete(scrollBox);
    const options = reservedScroll.options;
    delete reservedScroll.tabId;
    delete reservedScroll.options;
    scrollToTab(tab, options);
  });
}

function reserveToScrollToNewTab(tab) {
  if (!tab)
    return;
  const scrollBox = getScrollBoxFor(tab);
  const reservedScroll = {
    tabId: tab.id,
  };
  mReservedScrolls.set(scrollBox, reservedScroll);
  window.requestAnimationFrame(() => {
    if (mReservedScrolls.get(scrollBox) != reservedScroll)
      return;
    mReservedScrolls.delete(scrollBox);
    delete reservedScroll.tabId;
    scrollToNewTab(tab);
  });
}


function reReserveScrollingForTab(tab) {
  if (!tab)
    return false;
  if (reserveToScrollToTab.reservedTabId == tab.id) {
    reserveToScrollToTab(tab);
    return true;
  }
  if (reserveToScrollToNewTab.reservedTabId == tab.id) {
    reserveToScrollToNewTab(tab);
    return true;
  }
  return false;
}


function onMessage(message, _sender, _respond) {
  if (!message ||
      typeof message.type != 'string' ||
      message.type.indexOf('ws:') != 0)
    return;

  if (message.windowId &&
      message.windowId != TabsStore.getCurrentWindowId())
    return;

  //log('onMessage: ', message, sender);
  switch (message.type) {
    case Constants.kCOMMAND_GET_RENDERED_TAB_IDS:
      return Promise.resolve([...new Set([
        ...Tab.getPinnedTabs(message.windowId).map(tab => tab.id),
        ...mLastRenderedVirtualScrollTabIds,
      ])]);

    case Constants.kCOMMAND_ASK_TAB_IS_IN_VIEWPORT:
      return Promise.resolve(isTabInViewport(Tab.get(message.tabId), {
        allowPartial: message.allowPartial,
      }));
  }
}

async function onBackgroundMessage(message) {
  switch (message.type) {
    case Constants.kCOMMAND_NOTIFY_TAB_ATTACHED_COMPLETELY: {
      await Tab.waitUntilTracked([
        message.tabId,
        message.parentId
      ]);
      const tab = Tab.get(message.tabId);
      const parent = Tab.get(message.parentId);
      if (tab && parent && parent.active)
        reserveToScrollToNewTab(tab);
    }; break;

    case Constants.kCOMMAND_SCROLL_TABBAR: {
      const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
      const scrollBox = getScrollBoxFor(activeTab, { allowFallback: true });
      switch (String(message.by).toLowerCase()) {
        case 'lineup':
          smoothScrollBy(-Size.getRenderedTabHeight() * configs.scrollLines);
          break;

        case 'pageup':
          smoothScrollBy(-scrollBox.$offsetHeight + Size.getRenderedTabHeight());
          break;

        case 'linedown':
          smoothScrollBy(Size.getRenderedTabHeight() * configs.scrollLines);
          break;

        case 'pagedown':
          smoothScrollBy(scrollBox.$offsetHeight - Size.getRenderedTabHeight());
          break;

        default:
          switch (String(message.to).toLowerCase()) {
            case 'top':
              smoothScrollTo({ position: 0 });
              break;

            case 'bottom':
              smoothScrollTo({ position: scrollBox.$scrollTopMax });
              break;
          }
          break;
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_CREATED: {
      await Tab.waitUntilTracked(message.tabId);
      if (message.maybeMoved)
        await SidebarTabs.waitUntilNewTabIsMoved(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab) // it can be closed while waiting
        break;
      const needToWaitForTreeExpansion = (
        tab.$TST.collapsedOnCreated &&
        !tab.active &&
        !Tab.getActiveTab(tab.windowId).pinned
      );
      if (shouldApplyAnimation(true) ||
          needToWaitForTreeExpansion) {
        wait(10).then(() => { // wait until the tab is moved by TST itself
          const parent = tab.$TST.parent;
          if (parent && parent.$TST.subtreeCollapsed) // possibly collapsed by other trigger intentionally
            return;
          const active = tab.active;
          tab.$TST.collapsedOnCreated = false;
          const activeTab = Tab.getActiveTab(tab.windowId);
          CollapseExpand.setCollapsed(tab, { // this is required to scroll to the tab with the "last" parameter
            collapsed: false,
            anchor:    (active || activeTab?.$TST.canBecomeSticky) ? null : activeTab,
            last:      !active
          });
          if (!active)
            notifyOutOfViewTab(tab);
        });
      }
      else {
        reserveToScrollToNewTab(tab);
      }
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_ACTIVATED:
    case Constants.kCOMMAND_NOTIFY_TAB_UNPINNED:
      await Tab.waitUntilTracked(message.tabId);
      reserveToScrollToTab(Tab.get(message.tabId));
      break;

    case Constants.kCOMMAND_BROADCAST_TAB_STATE: {
      if (!message.tabIds.length ||
          message.tabIds.length > 1 ||
          !message.add ||
          !message.add.includes(Constants.kTAB_STATE_BUNDLED_ACTIVE))
        break;
      await Tab.waitUntilTracked(message.tabIds);
      const tab = Tab.get(message.tabIds[0]);
      if (!tab ||
          tab.active)
        break;
      const bundled = message.add.includes(Constants.kTAB_STATE_BUNDLED_ACTIVE);
      if (bundled &&
          (!configs.scrollToExpandedTree ||
           !configs.syncActiveStateToBundledTabs))
        break;
      const activeTab = bundled ?
        tab.$TST.bundledTab : // bundled-active state may be applied before the bundled tab become active
        Tab.getActiveTab(tab.windowId);
      if (!activeTab)
        break;
      reserveToScrollToTab(tab, {
        anchor:            !activeTab.pinned && isTabInViewport(activeTab) && activeTab,
        notifyOnOutOfView: true
      });
    }; break;

    case Constants.kCOMMAND_NOTIFY_TAB_MOVED:
    case Constants.kCOMMAND_NOTIFY_TAB_INTERNALLY_MOVED: {
      await Tab.waitUntilTracked(message.tabId);
      const tab = Tab.get(message.tabId);
      if (!tab) // it can be closed while waiting
        break;
      if (!reReserveScrollingForTab(tab) &&
          tab.active)
        reserveToScrollToTab(tab);
    }; break;
  }
}

function onMessageExternal(message, _aSender) {
  switch (message.type) {
    case TSTAPI.kSCROLL:
      return (async () => {
        const params = {};
        const currentWindow = TabsStore.getCurrentWindowId();
        if ('tab' in message) {
          await Tab.waitUntilTracked(message.tab);
          params.tab = Tab.get(message.tab);
          if (!params.tab || params.tab.windowId != currentWindow)
            return;
        }
        else {
          const windowId = message.window || message.windowId;
          if (windowId == 'active') {
            const currentWindow = await browser.windows.get(TabsStore.getCurrentWindowId());
            if (!currentWindow.focused)
              return;
          }
          else if (windowId != currentWindow) {
            return;
          }
          if ('delta' in message) {
            params.delta = message.delta;
            if (typeof params.delta == 'string')
              params.delta = Size.calc(params.delta);
          }
          if ('position' in message) {
            params.position = message.position;
            if (typeof params.position == 'string')
              params.position = Size.calc(params.position);
          }
          if ('duration' in message && typeof message.duration == 'number')
            params.duration = message.duration;
        }
        return scrollTo(params).then(() => {
          return true;
        });
      })();

    case TSTAPI.kSTOP_SCROLL:
      return (async () => {
        const currentWindow = TabsStore.getCurrentWindowId();
        const windowId = message.window || message.windowId;
        if (windowId == 'active') {
          const currentWindow = await browser.windows.get(TabsStore.getCurrentWindowId());
          if (!currentWindow.focused)
            return;
        }
        else if (windowId != currentWindow) {
          return;
        }
        cancelRunningScroll();
        return true;
      })();
  }
}

CollapseExpand.onUpdating.addListener((tab, options) => {
  if (!configs.scrollToExpandedTree)
    return;
  if (!tab.pinned)
    reserveToRenderVirtualScrollViewport({ trigger: 'collapseExpand' });
  if (options.last)
    scrollToTab(tab, {
      anchor:            options.anchor,
      notifyOnOutOfView: true
    });
});

CollapseExpand.onUpdated.addListener((tab, options) => {
  if (!configs.scrollToExpandedTree)
    return;
  if (!tab.pinned)
    reserveToRenderVirtualScrollViewport({ trigger: 'collapseExpand' });
  if (options.last)
    scrollToTab(tab, {
      anchor:            options.anchor,
      notifyOnOutOfView: true
    });
  else if (tab.active && !options.collapsed)
    scrollToTab(tab);
});


// Simulate "lock tab sizing while closing tabs via mouse click" behavior of Firefox itself
// https://github.com/piroor/treestyletab/issues/2691
// https://searchfox.org/mozilla-central/rev/27932d4e6ebd2f4b8519865dad864c72176e4e3b/browser/base/content/tabbrowser-tabs.js#1207
export function tryLockPosition(tabIds, reason) {
  if (!configs.simulateLockTabSizing ||
      tabIds.every(id => {
        const tab = Tab.get(id);
        return !tab || tab.pinned || tab.hidden;
      })) {
    log('tryLockPosition: ignore pinned or hidden tabs ', tabIds);
    return;
  }

  // Don't lock scroll position when the last tab is closed.
  const lastTab = Tab.getLastVisibleTab();
  if (reason == LOCK_REASON_REMOVE &&
      tabIds.includes(lastTab.id)) {
    if (tryLockPosition.tabIds.size > 0) {
      // but we need to add tabs to the list of "close with locked scroll position"
      // tabs to prevent unexpected unlocking.
      for (const id of tabIds) {
        tryLockPosition.tabIds.add(id);
      }
    }
    log('tryLockPosition: ignore last tab remove ', tabIds);
    return;
  }

  // Lock scroll position only when the closing affects to the max scroll position.
  if (mNormalScrollBox.$scrollTop < mNormalScrollBox.$scrollTopMax - Size.getRenderedTabHeight() - mTabbarSpacerSize) {
    log('tryLockPosition: scroll position is not affected ', tabIds, {
      scrollTop: mNormalScrollBox.$scrollTop,
      scrollTopMax: mNormalScrollBox.$scrollTopMax,
      height: Size.getRenderedTabHeight(),
    });
    return;
  }

  for (const id of tabIds) {
    tryLockPosition.tabIds.add(id);
  }

  log('tryLockPosition ', tabIds);
  const spacer = mNormalScrollBox.querySelector(`.${Constants.kTABBAR_SPACER}`);
  const count = tryLockPosition.tabIds.size;
  const height = Size.getRenderedTabHeight() * count;
  spacer.style.minHeight = `${height}px`;
  spacer.dataset.removedOrCollapsedTabsCount = count;
  mTabbarSpacerSize = height;

  if (!tryFinishPositionLocking.listening) {
    tryFinishPositionLocking.listening = true;
    window.addEventListener('mousemove', tryFinishPositionLocking);
    window.addEventListener('mouseout', tryFinishPositionLocking);
  }
}
tryLockPosition.tabIds = new Set();

export function tryUnlockPosition(tabIds) {
  if (!configs.simulateLockTabSizing ||
      tabIds.every(id => {
        const tab = Tab.get(id);
        return !tab || tab.pinned || tab.hidden;
      }))
    return;

  for (const id of tabIds) {
    tryLockPosition.tabIds.delete(id);
  }

  log('tryUnlockPosition');
  const spacer = mNormalScrollBox.querySelector(`.${Constants.kTABBAR_SPACER}`);
  const count = tryLockPosition.tabIds.size;
  const timeout = shouldApplyAnimation() ?
    Math.max(0, configs.collapseDuration) + 250 /* safety margin to wait finishing of the min-height animation of virtual-scroll-container */ :
    0;
  setTimeout(() => {
    const height = Size.getRenderedTabHeight() * count;
    spacer.style.minHeight = `${height}px`;
    spacer.dataset.removedOrCollapsedTabsCount = count;
    mTabbarSpacerSize = height;
  }, timeout);
}

function tryFinishPositionLocking(event) {
  log('tryFinishPositionLocking ', tryLockPosition.tabIds, event);
  switch (event && event.type) {
    case 'mouseout':
      const relatedTarget = event.relatedTarget;
      if (relatedTarget && relatedTarget.ownerDocument == document) {
        log(' => ignore mouseout in the tabbar window itself');
        return;
      }

    case 'mousemove':
      if (tryFinishPositionLocking.contextMenuOpen ||
          (event.type == 'mousemove' &&
           EventUtils.getElementTarget(event)?.closest('#tabContextMenu'))) {
        log(' => ignore events while the context menu is opened');
        return;
      }
      if (event.type == 'mousemove') {
        if (EventUtils.getTabFromEvent(event, { force: true }) ||
            EventUtils.getTabFromTabbarEvent(event, { force: true })) {
          log(' => ignore mousemove on any tab');
          return;
        }
        // When you move mouse while the last tab is being removed, it can fire
        // a mousemove event on the background area of the tab bar, and it
        // produces sudden scrolling. So we need to keep scroll locked
        // while the cursor is still on tabs area.
        const spacer = mNormalScrollBox.querySelector(`.${Constants.kTABBAR_SPACER}`);
        const pinnedTabsAreaSize = parseFloat(document.documentElement.style.getPropertyValue('--pinned-tabs-area-size'));
        const spacerTop = Size.getRenderedTabHeight() * (Tab.getVirtualScrollRenderableTabs(TabsStore.getCurrentWindowId()).length + 1)
        if ((!spacer || event.clientY < spacerTop) &&
            (!pinnedTabsAreaSize || isNaN(pinnedTabsAreaSize) || event.clientY > pinnedTabsAreaSize)) {
          log(' => ignore mousemove on any tab (removing)');
          return;
        }
      }
      break;

    default:
      break;
  }

  window.removeEventListener('mousemove', tryFinishPositionLocking);
  window.removeEventListener('mouseout', tryFinishPositionLocking);
  tryFinishPositionLocking.listening = false;

  tryLockPosition.tabIds.clear();
  const spacer = mNormalScrollBox.querySelector(`.${Constants.kTABBAR_SPACER}`);
  spacer.dataset.removedOrCollapsedTabsCount = 0;
  spacer.style.minHeight = '';
  mTabbarSpacerSize = 0;
  onPositionUnlocked.dispatch();
}
tryFinishPositionLocking.contextMenuOpen = false;

browser.menus.onShown.addListener((info, tab) => {
  tryFinishPositionLocking.contextMenuOpen = info.contexts.includes('tab') && (tab.windowId == TabsStore.getCurrentWindowId());
});

browser.menus.onHidden.addListener((_info, _tab) => {
  tryFinishPositionLocking.contextMenuOpen = false;
});

browser.tabs.onCreated.addListener(_tab => {
  tryFinishPositionLocking('on tab created');
});

browser.tabs.onRemoved.addListener(tabId => {
  if (tryLockPosition.tabIds.has(tabId) ||
      Tab.get(tabId)?.$TST.collapsed)
    return;
  tryFinishPositionLocking(`on tab removed ${tabId}`);
});
