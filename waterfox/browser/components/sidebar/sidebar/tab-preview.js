/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  configs,
  wait,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';

import * as CacheStorage from './cache-storage.js';
import * as SidebarTabs from './sidebar-tabs.js';
import * as Size from './size.js';
import * as TSTAPIFrontend from './tst-api-frontend.js';

const SAFE_ID = browser.runtime.id.replace(/[^-a-zA-Z0-9]/g, '_');

const style = document.head.appendChild(document.createElement('style'));
style.setAttribute('type', 'text/css');
style.textContent = `
  :root {
    --tab-preview-reference-width: 400px;
    --tab-preview-reference-height: 300px;
    --tab-preview-aspect-ratio: 0.75; /* 300 / 400 */
  }

  ::part(extra-contents-by-tabs-sidebar_waterfox_net container) {
    text-align: center;
  }

  ::part(extra-contents-by-%ID% frame) {
    border: var(--tab-border) 1px solid;
    display: inline-block;
    margin-right: auto;
  }

  :root.left ::part(extra-contents-by-%ID% frame) {
    --tab-preview-size: calc(100% + var(--favicon-size) - var(--tab-closebox-end-offset) - 0.25em /* proton closebox padding */);
  }
  :root.right ::part(extra-contents-by-%ID% frame) {
    --tab-preview-size: calc(100% + var(--favicon-size) - var(--tab-closebox-start-offset) - 0.25em /* proton closebox padding */);
  }

  ::part(extra-contents-by-%ID% preview) {
    /* CSS calc() with percentage does not result expected width, so we need to use measured pixel value here. */
    /* --tab-preview-image-width: calc(100% + var(--tab-indent)); */
    --tab-preview-image-width: calc(var(--tab-preview-container-width) - 2px);
    /* CSS calc() cannot use pixel values to calculate the aspect ratio so we need to calculate it by JS. */
    /* --tab-preview-aspect-ratio: calc(var(--tab-preview-reference-height) / var(--tab-preview-reference-width)); */
    --tab-preview-image-height: calc(var(--tab-preview-aspect-ratio) * var(--tab-preview-image-width));
    height: var(--tab-preview-image-height);
    max-height: var(--tab-preview-image-height);
    max-width: var(--tab-preview-image-width);
    min-width: var(--tab-preview-image-width);
  }

  ::part(extra-contents-by-%ID% preview placeholder) {
    display: inline-block;
  }
`.replace(/%ID%/g, SAFE_ID);

async function updatePreview(tab) {
  if (!tab ||
      !tab?.$TST?.element ||
      (configs.faviconizePinnedTabs &&
       tab.$TST.states.has(Constants.kTAB_STATE_FAVICONIZED)))
    return;

  if (!configs.showTabPreview) {
    TSTAPIFrontend.setExtraContentsTo(tab, {
      place: 'tab-above',
      contents: null,
    });
    window.requestAnimationFrame(Size.updateTabs);
    return;
  }

  if (!tab.$TST?.element?.extraItemsContainerAboveRoot.querySelector(`[part~="${SAFE_ID}"][part~="frame"]`))
    setPlaceholder(tab.$TST.element);

  const preview = await browser.waterfoxBridge.getTabPreview(tab.id);

  let url = preview.url;
  if (preview.found) {
    CacheStorage.setValue({ tabId: tab.id, store: CacheStorage.PREVIEW, value: preview.url });
  }
  else {
    const cachedUrl = await CacheStorage.getValue({ tabId: tab.id, store: CacheStorage.PREVIEW });
    if (cachedUrl)
      url = cachedUrl;
  }
  if (!tab.$TST.element)
    return;
  TSTAPIFrontend.setExtraContentsTo(tab, {
    place: 'tab-above',
    contents: `<span part="frame"><img src="${url}" part="preview"></span>`,
  });
  const image = new Image();
  image.addEventListener('load', () => {
    document.documentElement.style.setProperty('--tab-preview-reference-width', `${image.width}px`);
    document.documentElement.style.setProperty('--tab-preview-reference-height', `${image.height}px`);
    // We should use same aspect ratio for all tabs, because previews from
    // Firefox may have different aspect ratio for cached images. Dynamically
    // generated preview has an aspect ratio based on the screen size.
    document.documentElement.style.setProperty('--tab-preview-aspect-ratio', screen.availHeight / screen.availWidth);
    window.requestAnimationFrame(Size.updateTabs);
  }, { once: true });
  image.src = url;
}

function setPlaceholder(tabElement) {
  if (!tabElement)
    return;
  TSTAPIFrontend.setExtraContentsTo(tabElement.$TST.tab, {
    place: 'tab-above',
    contents: `<span part="frame"><span part="preview placeholder"></span></span>`,
  });
}

function updateContainerWidth(tabElement) {
  if (!tabElement)
    return;
  const containerWidth = tabElement.querySelector('.extra-items-container.above').offsetWidth;
  tabElement.style.setProperty('--tab-preview-container-width', `${containerWidth}px`);
  Size.updateTabs();
}

browser.tabs.onCreated.addListener(tab => {
  updatePreview(Tab.get(tab.id));
});

browser.tabs.onUpdated.addListener((tabId, changeInfo, _tab) => {
  if (!changeInfo.url &&
      !changeInfo.status)
    return;
  updatePreview(Tab.get(tabId));
}, { properties: ['url', 'status'] });

SidebarTabs.onTabsRendered.addListener(tabs => {
  for (const tab of tabs) {
    updateContainerWidth(tab.$TST.element);
    updatePreview(tab);
  }
});

function updateContainerWidthAll() {
  const startAt = `${Date.now()}-${parseInt(Math.random() * 65000)}`;
  updateContainerWidthAll.lastStartedAt = startAt;
  window.requestAnimationFrame(() => {
    if (updateContainerWidthAll.lastStartedAt != startAt)
      return;

    for (const tabElement of document.querySelectorAll('tab-item')) {
      updateContainerWidth(tabElement);
    }
  });
}

window.addEventListener('resize', event => {
  if (event.target != window)
    return;
  updateContainerWidthAll();
});

// Tabs may be shrunken by the scrollbar so we need to recalculate max width of previews.
window.addEventListener('overflow', event => {
  if (/^(normal|pinned)-tabs-container$/.test(event.target.id))
    return;
  updateContainerWidthAll();
});

window.addEventListener('load', () => {
  updateContainerWidth(document.querySelector('#dummy-tab'));
});

configs.$addObserver(key => {
  switch (key) {
    case 'showTabPreview':
      browser.runtime.sendMessage({
        type:     `${TSTAPI.INTERNAL_CALL_PREFIX}${TSTAPI.kGET_LIGHT_TREE}`,
        windowId: TabsStore.getCurrentWindowId(),
        tabs:     '*',
        rendered: true,
      }).then(tabs => {
        for (const tab of tabs) {
          updatePreview(Tab.get(tab.id));
        }
      });
      break;

    case 'sidebarPosition':
      setTimeout(() => { // first try: update preview size
        Size.updateTabs();
        setTimeout(() => { // second try: update layout
          Size.updateTabs();
        }, 250);
      }, 250);
      break;

    case 'faviconizePinnedTabs':
      if (!configs.faviconizePinnedTabs) {
        for (const tab of Tab.getPinnedTabs(TabsStore.getCurrentWindowId())) {
          updatePreview(tab);
        }
      }
      break;
  }
});


let mLastHoverTabId = null;

document.querySelector('#tabbar').addEventListener('mouseenter', async event => {
  if (event.target.localName != 'tab-item-substance')
    return;

  const tab = event.target.closest('tab-item').apiTab;

  mLastHoverTabId = tab.id;

  await wait(Math.max(0, configs.hoverTabPreviewDelayMs));

  if (mLastHoverTabId != tab.id ||
      tab.active)
    return;

  browser.waterfoxBridge.showPreviewPanel(
    tab.id,
    Math.round(event.target.getBoundingClientRect().top)
  );
}, { capture: true });

document.querySelector('#tabbar').addEventListener('mouseleave', async event => {
  const windowId = TabsStore.getCurrentWindowId();
  if (event.target == event.currentTarget &&
      windowId) {
    browser.waterfoxBridge.hidePreviewPanel(windowId); // clear for safety
    return;
  }

  if (event.target.localName != 'tab-item-substance')
    return;

  const tab = event.target.closest('tab-item').apiTab;

  await wait(0);

  if (mLastHoverTabId != tab.id)
    return;

  mLastHoverTabId = null;
  browser.waterfoxBridge.hidePreviewPanel(tab.windowId);
}, { capture: true });
