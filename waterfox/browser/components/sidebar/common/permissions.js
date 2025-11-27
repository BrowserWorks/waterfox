/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  notify,
  configs
} from './common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from './constants.js';

function log(...args) {
  internalLogger('common/permissions', ...args);
}

export const ALL_URLS = { origins: ['<all_urls>'] };
export const BOOKMARKS = { permissions: ['bookmarks'] };
export const CLIPBOARD_READ = { permissions: ['clipboardRead'] };
export const TAB_HIDE = { permissions: ['tabHide'] };

const checkboxesForPermission = new Map();

export function clearRequest() {
  configs.requestingPermissions = null;
}


const cachedGranted = new Map();

export async function isGranted(permissions) {
  try {
    const granted = await browser.permissions.contains(permissions).catch(ApiTabs.createErrorHandler());
    cachedGranted.set(JSON.stringify(permissions), granted);
    return granted;
  }
  catch(error) {
    console.error(error);
    return Promise.reject(new Error('unsupported permission'));
  }
}

export function isGrantedSync(permissions) {
  return cachedGranted.get(JSON.stringify(permissions));
}

// cache last state
for (const permissions of [ALL_URLS, BOOKMARKS, CLIPBOARD_READ, TAB_HIDE]) {
  isGranted(permissions);
}


const CUSTOM_PANEL_AVAILABLE_URLS_MATCHER = new RegExp(`^((https?|data):|moz-extension://${location.host}/)`);

export async function canInjectScriptToTab(tab) {
  if (!tab ||
      !CUSTOM_PANEL_AVAILABLE_URLS_MATCHER.test(tab.url))
    return false;

  return isGranted(ALL_URLS);
}

export function canInjectScriptToTabSync(tab) {
  if (!tab ||
      !CUSTOM_PANEL_AVAILABLE_URLS_MATCHER.test(tab.url))
    return false;

  return isGrantedSync(ALL_URLS);
}


const mRequests = new Map();

function destroyRequest(request) {
  const permissions = JSON.stringify(request.permissions);
  const requests = mRequests.get(permissions);
  if (requests)
    requests.delete(request);

  const onChanged = request.resolve;
  const checkbox  = request.url;

  request.permissions = undefined;
  request.onChanged   = undefined;
  request.checkbox    = undefined;

  return { onChanged, checkbox };
}

browser.runtime.onMessage.addListener((message, _sender) => {
  if (!message ||
      !message.type ||
      message.type != Constants.kCOMMAND_NOTIFY_PERMISSIONS_GRANTED)
    return;

  const permissions = JSON.stringify(message.permissions);

  isGranted(message.permissions); // to cache latest state

  const requests = mRequests.get(permissions);
  if (!requests)
    return;

  mRequests.delete(permissions);

  for (const request of requests) {
    const { onChanged, checkbox } = destroyRequest(request);
    const checked =onChanged ?
      onChanged(true) :
      undefined;
    checkbox.checked = checked !== undefined ? !!checked : true;
  }
});

/*
// These events are not available yet on Firefox...
browser.permissions.onAdded.addListener(addedPermissions => {
  const permissions = JSON.stringify(addedPermissions.permissions);
  const requests = mRequests.get(permissions);
  if (!requests)
    return;

  mRequests.delete(permissions);

  for (const request of requests) {
    const { checkbox } = destroyRequest(request);
    checkbox.checked = true;
  }
});
browser.permissions.onRemoved.addListener(removedPermissions => {
  const permissions = JSON.stringify(addedPermissions.permissions);
  const requests = mRequests.get(permissions);
  if (!requests)
    return;

  mRequests.delete(permissions);

  for (const request of requests) {
    const { checkbox } = destroyRequest(request);
    checkbox.checked = false;
  }
});
*/

export function bindToCheckbox(permissions, checkbox, options = {}) {
  const checkboxes = checkboxesForPermission.get(permissions) || [];
  checkboxes.push(checkbox);
  checkboxesForPermission.set(permissions, checkboxes);

  isGranted(permissions)
    .then(granted => {
      const checked = options.onInitialized ?
        options.onInitialized(granted) :
        checkbox.dataset.relatedConfigKey ?
          configs[checkbox.dataset.relatedConfigKey] :
          undefined;
      checkbox.checked = checked !== undefined ? !!checked : granted;
    })
    .catch(_error => {
      checkbox.setAttribute('readonly', true);
      checkbox.setAttribute('disabled', true);
      const label = checkbox.closest('label') || document.querySelector(`label[for=${checkbox.id}]`);
      if (label)
        label.setAttribute('disabled', true);
    });

  checkbox.addEventListener('change', _event => {
    checkbox.requestPermissions()
  });

  const key = JSON.stringify(permissions);
  const requests = mRequests.get(key) || new Set();
  const request = {
    permissions,
    onChanged: options.onChanged,
    checkbox,
  };
  requests.add(request);
  mRequests.set(key, requests);

  checkbox.requestPermissions = async () => {
    log('permission requested: ', permissions);
    const checkboxes = checkboxesForPermission.get(permissions);
    try {
      log('checkboxes: ', checkboxes);
      log('checkbox.checked: ', checkbox.checked);
      if (!checkbox.checked) {
        if (checkbox.dataset.relatedConfigKey)
          configs[checkbox.dataset.relatedConfigKey] = false;
        if (options.onChanged)
          options.onChanged(false);
        const canRevoke = Array.from(checkboxes, checkbox => checkbox.dataset.relatedConfigKey ? configs[checkbox.dataset.relatedConfigKey] : null).filter(state => state !== null).every(state => !state);
        log('canRevoke: ', canRevoke);
        if (!canRevoke)
          return;
        log('revoking the permission');
        await browser.permissions.remove(permissions).catch(ApiTabs.createErrorSuppressor());
        for (const otherCheckbox of checkboxes) {
          if (otherCheckbox != checkbox &&
              otherCheckbox.dataset.relatedConfigKey)
            continue;
          otherCheckbox.checked = false;
        }
        return;
      }

      for (const otherCheckbox of checkboxes) {
        if (otherCheckbox != checkbox &&
            otherCheckbox.dataset.relatedConfigKey)
          continue;
        otherCheckbox.checked = false;
      }

      if (configs.requestingPermissionsNatively)
        return;

      log('requesting the permission');
      configs.requestingPermissionsNatively = permissions;
      let granted = await browser.permissions.request(permissions).catch(ApiTabs.createErrorHandler());
      configs.requestingPermissionsNatively = null;

      log('granted: ', granted);
      if (granted === undefined) {
        granted = await isGranted(permissions);
        log('granted (retry): ', granted);
      }
      else if (!granted) {
        log('not granted: cacneled');
        return;
      }

      if (granted) {
        if (checkbox.dataset.relatedConfigKey)
          configs[checkbox.dataset.relatedConfigKey] = true;
        const configValue = checkbox.dataset.relatedConfigKey ? true : null;
        const onChangedResult = options.onChanged && options.onChanged(true);
        const checked = configValue !== null ? configValue :
          options.onChanged ?
            onChangedResult :
            undefined;
        log('update checkboxes with checked state ', checked);
        for (const otherCheckbox of checkboxes) {
          if (otherCheckbox != checkbox &&
              otherCheckbox.dataset.relatedConfigKey)
            continue;
          otherCheckbox.checked = checked !== undefined ? !!checked : true;
        }
        browser.runtime.sendMessage({
          type: Constants.kCOMMAND_NOTIFY_PERMISSIONS_GRANTED,
          permissions
        }).catch(_error => {});
        log('finish');
        return;
      }

      log('fallback to the failsafe method');
      configs.requestingPermissions = permissions;
      browser.browserAction.setBadgeText({ text: '!' });
      browser.browserAction.setPopup({ popup: '' });

      notify({
        title:   browser.i18n.getMessage('config_requestPermissions_fallbackToToolbarButton_title'),
        message: browser.i18n.getMessage('config_requestPermissions_fallbackToToolbarButton_message'),
        icon:    'resources/24x24.svg#default'
      });
      return;
    }
    catch(error) {
      console.log(error);
    }
    for (const checkbox of checkboxes) {
      checkbox.checked = false;
    }
  };
}

export function bindToClickable(permissions, node, { onChanged } = {}) {
  node.addEventListener('click', _event => {
    node.requestPermissions()
  });

  if (node.requestPermissions)
    return;

  node.requestPermissions = async () => {
    try {
      const checkboxes = checkboxesForPermission.get(permissions);
      if (configs.requestingPermissionsNatively ||
          checkboxes.every(checkbox => checkbox.checked))
        return;

      configs.requestingPermissionsNatively = permissions;
      // We need to call this without delay to avoid "permissions.request may only be called from a user input handler" error.
      let granted = await browser.permissions.request(permissions).catch(ApiTabs.createErrorHandler());
      configs.requestingPermissionsNatively = null;

      if (granted === undefined)
        granted = await isGranted(permissions);
      else if (!granted)
        return;

      if (granted) {
        for (const checkbox of checkboxes) {
          checkbox.checked = true;
        }
        if (onChanged)
          onChanged(true);
        browser.runtime.sendMessage({
          type: Constants.kCOMMAND_NOTIFY_PERMISSIONS_GRANTED,
          permissions
        }).catch(_error => {});
        return;
      }

      configs.requestingPermissions = permissions;
      browser.browserAction.setBadgeText({ text: '!' });
      browser.browserAction.setPopup({ popup: '' });

      notify({
        title:   browser.i18n.getMessage('config_requestPermissions_fallbackToToolbarButton_title'),
        message: browser.i18n.getMessage('config_requestPermissions_fallbackToToolbarButton_message'),
        icon:    'resources/24x24.svg#default'
      });
      return;
    }
    catch(error) {
      console.log(error);
    }
  };
}

export function requestPostProcess() {
  if (!configs.requestingPermissions)
    return false;

  const permissions = configs.requestingPermissions;
  configs.requestingPermissions = null;
  configs.requestingPermissionsNatively = permissions;

  browser.browserAction.setBadgeText({ text: '' });
  browser.permissions.request(permissions)
    .then(granted => {
      log('permission requested: ', permissions, granted);
      if (granted)
        browser.runtime.sendMessage({
          type: Constants.kCOMMAND_NOTIFY_PERMISSIONS_GRANTED,
          permissions
        }).catch(_error => {});
    })
    .catch(ApiTabs.createErrorSuppressor())
    .finally(() => {
      configs.requestingPermissionsNatively = null;
    });
  return true;
}

configs.$loaded.then(() => {
  configs.requestingPermissionsNatively = null;
});
