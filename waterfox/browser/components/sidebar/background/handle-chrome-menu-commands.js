/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  configs,
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as TabsStore from '/common/tabs-store.js';

import * as Commands from './commands.js';

browser.waterfoxBridge.onMenuCommand.addListener(async info => {
  switch (info.itemId) {
    case 'tabs-sidebar-newTab': {
      const behavior = info.button == 1 ?
        configs.autoAttachOnNewTabButtonMiddleClick :
        (info.ctrlKey || info.metaKey) ?
          configs.autoAttachOnNewTabButtonAccelClick :
          configs.autoAttachOnNewTabCommand;
      const win       = await browser.windows.getLastFocused({ populate: true }).catch(ApiTabs.createErrorHandler());
      const activeTab = TabsStore.activeTabInWindow.get(win.id);
      Commands.openNewTabAs({
        baseTab: activeTab,
        as:      behavior,
      });
    }; break;
  }
});
