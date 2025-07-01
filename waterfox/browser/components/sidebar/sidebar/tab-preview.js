/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  wait,
} from '/common/common.js';
import * as TabsStore from '/common/tabs-store.js';

let mLastHoverTabId = null;

document.querySelector('#tabbar').addEventListener('mouseenter', async event => {
  if (event.target.localName != 'tab-item-substance')
    return;

  const tab = event.target.closest('tab-item').apiRaw;

  mLastHoverTabId = tab.id;

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

  const tab = event.target.closest('tab-item').apiRaw;

  await wait(0);

  if (mLastHoverTabId != tab.id)
    return;

  mLastHoverTabId = null;
  browser.waterfoxBridge.hidePreviewPanel(tab.windowId);
}, { capture: true });
