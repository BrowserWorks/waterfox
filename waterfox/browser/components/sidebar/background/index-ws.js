/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import './index.js';

import {
  configs,
} from '/common/common.js';
import '/common/sync-provider.js';

import './auto-sticky-tabs.js';
import './handle-autoplay-blocking.js';
import './handle-chrome-menu-commands.js';
import './prefs.js';
import './sharing-service.js';
import * as TabsOpen from './tabs-open.js';

browser.waterfoxBridge.initUI();

TabsOpen.onForbiddenURLRequested.addListener(url => {
  browser.waterfoxBridge.reserveToLoadForbiddenURL(url);
});

browser.waterfoxBridge.onSidebarShown.addListener(windowId => {
  configs.sidebarVirtuallyClosedWindows = configs.sidebarVirtuallyClosedWindows.filter(id => id != windowId);
});

browser.waterfoxBridge.onSidebarHidden.addListener(windowId => {
  if (!configs.sidebarVirtuallyClosedWindows.includes(windowId))
    configs.sidebarVirtuallyClosedWindows = [...configs.sidebarVirtuallyClosedWindows, windowId];
});

