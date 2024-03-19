/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import './index.js';

import * as RetrieveURL from '/common/retrieve-url.js';

import './tab-preview.js';
import './workaround-for-bug-1875100.js';

import * as EventUtils from './event-utils.js';

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

window.addEventListener('contextmenu', event => {
  if (EventUtils.getEventTargetType(event) != 'blank')
    return true;

  event.stopImmediatePropagation();
  event.preventDefault();
  return false;
}, { capture: true });
