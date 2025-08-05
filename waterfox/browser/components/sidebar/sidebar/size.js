/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import EventListenerManager from '/extlib/EventListenerManager.js';

import {
  log as internalLogger,
  configs,
  isRTL,
} from '/common/common.js';

function log(...args) {
  internalLogger('sidebar/size', ...args);
}

export const onUpdated = new EventListenerManager();

const mPinnedScrollBox  = document.querySelector('#pinned-tabs-container');
const mNormalScrollBox  = document.querySelector('#normal-tabs-container');
const mTabBar           = document.querySelector('#tabbar');

let mTabHeight          = 0;
let mTabXOffset         = 0;
let mTabYOffset         = 0;
let mTabMarginBlockStart = 0;
let mTabMarginBlockEnd  = 0;
let mFavIconSize        = 0;
let mFavIconizedTabSize = 0;
let mFavIconizedTabWidth = 0;
let mFavIconizedTabHeight = 0;
let mFavIconizedTabXOffset = 0;
let mFavIconizedTabYOffset = 0;
let mPinnedTabsScrollBoxRect;
let mPinnedTabsContainerWidth
let mNormalTabsScrollBoxRect;
let mNormalTabsViewPortSize = 0;
let mAllTabsAreaSize    = 0;

export function getTabHeight() {
  return mTabHeight;
}

export function getRenderedTabHeight() {
  return mTabHeight + mTabYOffset;
}

export function getTabXOffset() {
  return mTabXOffset;
}

export function getTabYOffset() {
  return mTabYOffset;
}

export function getTabMarginBlockStart() {
  return mTabMarginBlockStart;
}

export function getTabMarginBlockEnd() {
  return mTabMarginBlockEnd;
}

export function getFavIconSize() {
  return mFavIconSize;
}

export function getFavIconizedTabSize() {
  return mFavIconizedTabSize;
}

export function getFavIconizedTabXOffset() {
  return mFavIconizedTabYOffset;
}

export function getFavIconizedTabYOffset() {
  return mFavIconizedTabYOffset;
}

export function getRenderedFavIconizedTabWidth() {
  return mFavIconizedTabWidth + mFavIconizedTabXOffset;
}

export function getRenderedFavIconizedTabHeight() {
  return mFavIconizedTabHeight + mFavIconizedTabYOffset;
}

export function getScrollBoxRect(scrollBox) {
  return scrollBox == mPinnedScrollBox ?
    (mPinnedTabsScrollBoxRect ||= mPinnedScrollBox.getBoundingClientRect()) :
    (mNormalTabsScrollBoxRect ||= mNormalScrollBox.getBoundingClientRect());
}

export function getNormalTabsViewPortSize() {
  return mNormalTabsViewPortSize;
}

export function getPinnedTabsContainerWidth() {
  return mPinnedTabsContainerWidth;
}

export function getAllTabsAreaSize() {
  return mAllTabsAreaSize;
}

export function init() {
  updateTabs();
  updateContainers();
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addListener(() => {
    updateTabs();
    updateContainers();
  });
}

export function clear() {
  document.querySelector('#size-definition').textContent = '';
}

export function updateTabs() {
  // first, calculate actual favicon size.
  mFavIconSize = document.querySelector('#dummy-favicon-size-box').offsetHeight;
  const scale = Math.max(configs.faviconizedTabScale, 1);
  mFavIconizedTabSize = parseInt(mFavIconSize * scale);
  log('mFavIconSize / mFavIconizedTabSize ', mFavIconSize, mFavIconizedTabSize);
  let sizeDefinition = `:root {
    --favicon-size:         ${mFavIconSize}px;
    --faviconized-tab-size: ${mFavIconizedTabSize}px;
  }`;
  const dummyFaviconizedTab = document.querySelector('#dummy-faviconized-tab');
  const faviconizedTabStyle = window.getComputedStyle(dummyFaviconizedTab);
  mFavIconizedTabWidth  = dummyFaviconizedTab.offsetWidth;
  mFavIconizedTabHeight = dummyFaviconizedTab.offsetHeight;
  // simulating margin collapsing
  const favIconizedMarginInlineStart = parseFloat(faviconizedTabStyle.marginInlineStart);
  const favIconizedMarginInlineEnd   = parseFloat(faviconizedTabStyle.marginInlineEnd);
  mFavIconizedTabXOffset = (favIconizedMarginInlineStart > 0 && favIconizedMarginInlineEnd > 0) ?
    Math.max(favIconizedMarginInlineStart, favIconizedMarginInlineEnd) :
    favIconizedMarginInlineStart + favIconizedMarginInlineEnd;
  const favIconizedMarginBlockStart = parseFloat(faviconizedTabStyle.marginBlockStart);
  const favIconizedMarginBlockEnd   = parseFloat(faviconizedTabStyle.marginBlockEnd);
  mFavIconizedTabYOffset = (favIconizedMarginBlockStart > 0 && favIconizedMarginBlockEnd > 0) ?
    Math.max(favIconizedMarginBlockStart, favIconizedMarginBlockEnd) :
    favIconizedMarginBlockStart + favIconizedMarginBlockEnd;

  const dummyTab = document.querySelector('#dummy-tab');
  const tabStyle  = window.getComputedStyle(dummyTab);
  mTabXOffset = parseFloat(tabStyle.marginInlineStart) + parseFloat(tabStyle.marginInlineEnd);
  // simulating margin collapsing
  mTabMarginBlockStart = parseFloat(tabStyle.marginBlockStart);
  mTabMarginBlockEnd   = parseFloat(tabStyle.marginBlockEnd);
  mTabYOffset = (mTabMarginBlockStart > 0 && mTabMarginBlockEnd > 0) ?
    Math.max(mTabMarginBlockStart, mTabMarginBlockEnd) :
    mTabMarginBlockStart + mTabMarginBlockEnd;

  const substanceRect = dummyTab.querySelector('tab-item-substance').getBoundingClientRect();
  const uiRect = dummyTab.querySelector('tab-item-substance > .ui').getBoundingClientRect();
  const captionRect = dummyTab.querySelector('tab-item-substance > .ui > .caption').getBoundingClientRect();
  const favIconRect = dummyTab.querySelector('tab-favicon').getBoundingClientRect();
  const labelRect = dummyTab.querySelector('tab-label').getBoundingClientRect();
  const closeBoxRect = dummyTab.querySelector('tab-closebox').getBoundingClientRect();

  let shiftTabsForScrollbarDistance = configs.shiftTabsForScrollbarDistance.trim() || '0';
  if (!/^[0-9\.]+(cm|mm|Q|in|pc|pt|px|em|ex|ch|rem|lh|vw|vh|vmin|vmax|%)$/.test(shiftTabsForScrollbarDistance))
    shiftTabsForScrollbarDistance = '0'; // ignore invalid length
  if (shiftTabsForScrollbarDistance == '0')
    shiftTabsForScrollbarDistance += 'px'; // it is used with CSS calc() and it requires any length unit for each value.

  // Phase 1: setting `--tab-size` based on the auto-calculated height of the
  // dummy tab, which may be expanded by inserted extra tab contents.
  const baseLeft  = substanceRect.left;
  const baseRight = substanceRect.right;
  sizeDefinition += `:root {
    --tab-size: ${dummyTab.offsetHeight}px;
    --tab-substance-size: ${substanceRect.height}px;
    --tab-ui-size: ${uiRect.height}px;
    --tab-caption-size: ${captionRect.height}px;
    --tab-x-offset: ${mTabXOffset}px;
    --tab-y-offset: ${mTabYOffset}px;
    --tab-height: var(--tab-size); /* for backward compatibility of custom user styles */
    --tab-favicon-start-offset: ${isRTL() ? baseRight - favIconRect.right : favIconRect.left - baseLeft}px;
    --tab-favicon-end-offset: ${isRTL() ? favIconRect.left - baseLeft : baseRight - favIconRect.right}px;
    --tab-label-start-offset: ${isRTL() ? baseRight - labelRect.right : labelRect.left - baseLeft}px;
    --tab-label-end-offset: ${isRTL() ? labelRect.left - baseLeft : baseRight - labelRect.right}px;
    --tab-closebox-start-offset: ${isRTL() ? baseRight - closeBoxRect.right : closeBoxRect.left - baseLeft}px;
    --tab-closebox-end-offset: ${isRTL() ? closeBoxRect.left - baseLeft : baseRight - closeBoxRect.right}px;

    --tab-burst-duration: ${configs.burstDuration}ms;
    --indent-duration:    ${configs.indentDuration}ms;
    --collapse-duration:  ${configs.collapseDuration}ms;
    --out-of-view-tab-notify-duration: ${configs.outOfViewTabNotifyDuration}ms;
    --visual-gap-hover-animation-delay: ${configs.cancelGapSuppresserHoverDelay}ms;

    --shift-tabs-for-scrollbar-distance: ${shiftTabsForScrollbarDistance};
  }`;

  const sizeDefinitionHolder = document.querySelector('#size-definition');
  const modifiedAtPhase1 = sizeDefinitionHolder.textContent != sizeDefinition;
  if (modifiedAtPhase1)
    sizeDefinitionHolder.textContent = sizeDefinition;

  // Phase 2: setting `--tab-size` again based on the "sizer" dummy tab.
  // In general cases it is sized by the `--tab-size` defined at the phase 1,
  // but tab size defined in the user style sheet is always preferred to it.
  // The customized tab height is applied only to the "sizer" dummy.
  // As the result, TST treats the priority of tab size as:
  //   user-defined tab size (never expanded by extra tab contents)
  //     > auto-calculated tab size (may be expanded by extra tab contents)
  //     > initial tab size
  mTabHeight = document.querySelector('#dummy-sizer-tab').offsetHeight;
  log('mTabHeight ', mTabHeight);
  const finalSizeDefinition = sizeDefinition.replace(/--tab-size:[^;]+;/, `--tab-size: ${mTabHeight}px;`);
  const modifiedAtPhase2 = sizeDefinitionHolder.textContent != finalSizeDefinition;
  if (modifiedAtPhase2)
    sizeDefinitionHolder.textContent = finalSizeDefinition;

  if (modifiedAtPhase1 || modifiedAtPhase2)
    onUpdated.dispatch();
}

export function updateContainers() {
  let modifiedCount = 0;

  mPinnedTabsScrollBoxRect = mPinnedScrollBox.getBoundingClientRect();
  mNormalTabsScrollBoxRect = mNormalScrollBox.getBoundingClientRect();

  const pinnedContainerBox     = mPinnedScrollBox.querySelector('.tabs');
  const pinnedContainerBoxRect = pinnedContainerBox.getBoundingClientRect();
  const pinnedContainerStyle   = window.getComputedStyle(pinnedContainerBox, null);
  const newPinnedTabsContainerWidth = pinnedContainerBoxRect.width - parseFloat(pinnedContainerStyle.paddingInlineStart) - parseFloat(pinnedContainerStyle.borderInlineStartWidth) - parseFloat(pinnedContainerStyle.paddingInlineEnd) - parseFloat(pinnedContainerStyle.borderInlineEndWidth);
  if (newPinnedTabsContainerWidth != mPinnedTabsContainerWidth)
    modifiedCount++;
  mPinnedTabsContainerWidth    = newPinnedTabsContainerWidth;

  const range = document.createRange();
  //range.selectNodeContents(mTabBar);
  //range.setEndBefore(mNormalScrollBox);
  const normalTabsViewPortPrecedingAreaSize = mPinnedScrollBox.offsetHeight; //range.getBoundingClientRect().height;
  range.selectNodeContents(mTabBar);
  range.setStartAfter(mNormalScrollBox);
  const normalTabsViewPortFollowingAreaSize = range.getBoundingClientRect().height;
  const newNormalTabsViewportSize = mTabBar.offsetHeight - normalTabsViewPortPrecedingAreaSize - normalTabsViewPortFollowingAreaSize;
  range.detach();
  if (newNormalTabsViewportSize != mNormalTabsViewPortSize)
    modifiedCount++;
  mNormalTabsViewPortSize = newNormalTabsViewportSize;

  const newAllTabsAreaSize = mTabBar.parentNode.offsetHeight;
  if (newAllTabsAreaSize != mAllTabsAreaSize)
    modifiedCount++;
  mAllTabsAreaSize = newAllTabsAreaSize;

  if (modifiedCount > 0)
    onUpdated.dispatch();
}

export function calc(expression) {
  expression = expression.replace(/^\s*calc\((.+)\)\s*$/, '$1');
  const box = document.createElement('span');
  const style = box.style;
  style.display       = 'inline-block';
  style.insetInlineStart = 0;
  style.height        = 0;
  style.overflow      = 'hidden';
  style.pointerEvents = 'none';
  style.position      = 'fixed';
  style.top           = 0;
  style.zIndex        = 0;

  const innerBox = box.appendChild(document.createElement('span'));
  const innerStyle = innerBox.style;
  innerStyle.display       = 'inline-block';
  innerStyle.insetInlineStart = 0;
  innerStyle.height        = 0;
  innerStyle.pointerEvents = 'none';
  innerStyle.position      = 'fixed';
  innerStyle.top           = `calc(${expression})`;
  innerStyle.zIndex        = 0;

  document.body.appendChild(box);
  const result = innerBox.offsetTop - box.offsetTop;
  box.parentNode.removeChild(box);
  return result;
}
