/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import './index.js';

import * as RetrieveURL from '/common/retrieve-url.js';
import { Tab } from '/common/TreeItem.js';

import * as Sidebar from './sidebar.js';
import './tab-context-menu.js';
import './tab-preview-tooltip.js';
import './tab-preview.js';

RetrieveURL.registerFileURLResolver(async file => {
  return  file && browser.waterfoxBridge.getFileURL({
    lastModified: file.lastModified,
    name:         file.name,
    size:         file.size,
    type:         file.type,
  });
});

RetrieveURL.registerSelectionClipboardProvider({
  isAvailable: () => browser.waterfoxBridge.isSelectionClipboardAvailable(),
  getTextData: () => browser.waterfoxBridge.getSelectionClipboardContents(),
});

// Deactivate tab tooltip for tab hover previews
Tab.onCreated.addListener(tab => {
  tab.$TST.registerTooltipText(browser.runtime.id, '', true);
});
Sidebar.onReady.addListener(() => {
  for (const tab of Tab.getAllTabs()) {
    tab.$TST.registerTooltipText(browser.runtime.id, '', true);
  }
});
