import * as TabContextMenu from "./tab-context-menu.js";

TabContextMenu.registerSharingService({
  async listServices(tab) {
    return browser.waterfoxBridge.listSharingServices(tab.id);
  },

  share(tab, shareName = null) {
    return browser.waterfoxBridge.share(tab.id, shareName);
  },

  openPreferences() {
    return browser.waterfoxBridge.openSharingPreferences();
  },
});
