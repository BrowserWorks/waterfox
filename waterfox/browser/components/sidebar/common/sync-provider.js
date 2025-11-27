/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import * as Sync from '/common/sync.js';

Sync.registerExternalProvider({
  async getOtherDevices() {
    return browser.waterfoxBridge.listSyncDevices();
  },

  sendTabsToDevice(tabs, deviceId) {
    if (!Array.isArray(tabs))
      tabs = [tabs];
    return browser.waterfoxBridge.sendToDevice(tabs.map(tab => tab.id), deviceId);
  },

  sendTabsToAllDevices(tabs) {
    if (!Array.isArray(tabs))
      tabs = [tabs];
    return browser.waterfoxBridge.sendToDevice(tabs.map(tab => tab.id));
  },

  manageDevices(windowId) {
    return browser.waterfoxBridge.openSyncDeviceSettings(windowId)
  },
});
