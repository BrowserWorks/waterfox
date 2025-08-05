/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import * as TabContextMenu from './tab-context-menu.js';

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
