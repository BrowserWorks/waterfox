import * as Sync from "/common/sync.js";

Sync.registerExternalProvider({
  async getOtherDevices() {
    return browser.waterfoxBridge.listSyncDevices();
  },

  sendTabsToDevice(tabs, deviceId) {
    if (!Array.isArray(tabs)) tabs = [tabs];
    return browser.waterfoxBridge.sendToDevice(
      tabs.map((tab) => tab.id),
      deviceId
    );
  },

  sendTabsToAllDevices(tabs) {
    if (!Array.isArray(tabs)) tabs = [tabs];
    return browser.waterfoxBridge.sendToDevice(tabs.map((tab) => tab.id));
  },

  manageDevices(windowId) {
    return browser.waterfoxBridge.openSyncDeviceSettings(windowId);
  },
});
