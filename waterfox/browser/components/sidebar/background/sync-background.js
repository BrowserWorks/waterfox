/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  configs,
  notify,
  wait,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as ContextualIdentities from '/common/contextual-identities.js';
import * as Sync from '/common/sync.js';
import * as TabsStore from '/common/tabs-store.js';

import Tab from '/common/Tab.js';

import * as Tree from './tree.js';

Sync.onMessage.addListener(async message => {
  const data = message.data;
  if (data.type != Constants.kSYNC_DATA_TYPE_TABS ||
      !Array.isArray(data.tabs))
    return;

  const multiple = data.tabs.length > 1 ? '_multiple' : '';
  notify({
    title: browser.i18n.getMessage(
      `receiveTabs_notification_title${multiple}`,
      [Sync.getDeviceName(message.from)]
    ),
    message: browser.i18n.getMessage(
      `receiveTabs_notification_message${multiple}`,
      data.tabs.length > 1 ?
        [data.tabs[0].url, data.tabs.length, data.tabs.length - 1] :
        [data.tabs[0].url]
    ),
    timeout: configs.syncReceivedTabsNotificationTimeout
  });

  const windowId = TabsStore.getCurrentWindowId() || (await browser.windows.getCurrent()).id;
  const win = TabsStore.windows.get(windowId);
  const initialIndex = win.tabs.size;
  win.toBeOpenedOrphanTabs += data.tabs.length;
  let index = 0;
  const tabs = [];
  for (const tab of data.tabs) {
    const createParams = {
      windowId,
      url:    tab.url,
      index:  initialIndex + index,
      active: index == 0
    };
    if (tab.cookieStoreId &&
        tab.cookieStoreId != 'firefox-default' &&
        ContextualIdentities.get(tab.cookieStoreId))
      createParams.cookieStoreId = tab.cookieStoreId;
    let openedTab;
    try {
      openedTab = await browser.tabs.create(createParams);
    }
    catch(error) {
      console.log(error);
    }
    if (!openedTab)
      openedTab = await browser.tabs.create({
        ...createParams,
        url: `about:blank?${tab.url}`
      });
    tabs.push(openedTab);
    index++;
  }

  if (!Array.isArray(data.structure))
    return;

  await wait(100); // wait for all tabs are tracked
  await Tree.applyTreeStructureToTabs(tabs.map(tab => Tab.get(tab.id)), data.structure, {
    broadcast: true
  });
});
