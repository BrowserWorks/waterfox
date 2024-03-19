/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import EventListenerManager from '/extlib/EventListenerManager.js';

import {
  log as internalLogger,
  configs,
  notify,
  wait,
  getChunkedConfig,
  setChunkedConfig,
  isLinux,
} from './common.js';
import * as Constants from '/common/constants.js';
import * as TreeBehavior from '/common/tree-behavior.js';

import Tab from '/common/Tab.js';

function log(...args) {
  internalLogger('common/sync', ...args);
}

export const onMessage = new EventListenerManager();
export const onNewDevice = new EventListenerManager();
export const onUpdatedDevice = new EventListenerManager();
export const onObsoleteDevice = new EventListenerManager();

const SEND_TABS_SIMULATOR_ID = 'send-tabs-to-device-simulator@piro.sakura.ne.jp';

// Workaround for https://github.com/piroor/treestyletab/blob/trunk/README.md#user-content-feature-requests-send-tab-tree-to-device-does-not-work
// and https://bugzilla.mozilla.org/show_bug.cgi?id=1417183 (resolved as WONTFIX)
// Firefox does not provide any API to access to Sync features directly.
// We need to provide it as experiments API or something way.
// This module is designed to work with a service provide which has features:
//   * async getOtherDevices()
//     - Returns an array of sync devices.
//     - Retruned array should have 0 or more items like:
//       { id:   "identifier of the device",
//         name: "name of the device",
//         type: "type of the device (desktop, mobile, and so on)" }
//   * sendTabsToDevice(tabs, deviceId)
//     - Returns nothing.
//     - Sends URLs of given tabs to the specified device.
//     - The device is one of values returned by getOtherDevices().
//   * sendTabsToAllDevices(tabs)
//     - Returns nothing.
//     - Sends URLs of given tabs to all other devices.
//   * manageDevices(windowId)
//     - Returns nothing.
//     - Opens settings page for Sync devices.
//       It will appear as a tab in the specified window.

let mExternalProvider = null;

export function registerExternalProvider(provider) {
  mExternalProvider = provider;
}

export function hasExternalProvider() {
  return !!mExternalProvider;
}

let mMyDeviceInfo = null;

async function getMyDeviceInfo() {
  if (!configs.syncDeviceInfo || !configs.syncDeviceInfo.id) {
    const newDeviceInfo = await generateDeviceInfo();
    if (!configs.syncDeviceInfo)
      configs.syncDeviceInfo = newDeviceInfo;
  }
  return mMyDeviceInfo = configs.syncDeviceInfo;
}

async function ensureDeviceInfoInitialized() {
  await getMyDeviceInfo();
}

export async function waitUntilDeviceInfoInitialized() {
  while (!configs.syncDeviceInfo) {
    await wait(100);
  }
  mMyDeviceInfo = configs.syncDeviceInfo;
}

let initialized = false;
let preChanges = [];

function onConfigChanged(key, value = undefined) {
  if (!initialized) {
    preChanges.push({ key, value: value === undefined ? configs[key] : value });
    return;
  }
  switch (key) {
    case 'syncOtherDevicesDetected':
      if (!configs.syncAvailableNotified) {
        configs.syncAvailableNotified = true;
        notify({
          title:   browser.i18n.getMessage('syncAvailable_notification_title'),
          message: browser.i18n.getMessage(`syncAvailable_notification_message${isLinux() ? '_linux' : ''}`),
          url:     `${Constants.kSHORTHAND_URIS.options}#syncTabsToDeviceOptions`,
          timeout: configs.syncAvailableNotificationTimeout
        });
      }
      return;

    case 'syncDevices':
      // This may happen when all configs are reset.
      // We need to try updating devices after syncDeviceInfo is completely cleared.
      wait(100).then(updateDevices);
      break;

    case 'syncDeviceInfo':
      if (configs.syncDeviceInfo &&
          mMyDeviceInfo &&
          configs.syncDeviceInfo.id == mMyDeviceInfo.id &&
          configs.syncDeviceInfo.timestamp == mMyDeviceInfo.timestamp)
        return; // ignore updating triggered by myself
      mMyDeviceInfo = null;
      updateSelf();
      break;

    default:
      if (key.startsWith('chunkedSyncData'))
        reserveToReceiveMessage();
      break;
  }
}

browser.runtime.onMessageExternal.addListener((message, sender) => {
  if (!initialized ||
      !message ||
      typeof message != 'object' ||
      typeof message.type != 'string' ||
      sender.id != SEND_TABS_SIMULATOR_ID)
    return;

  switch (message.type) {
    case 'ready':
      try {
        browser.runtime.sendMessage(SEND_TABS_SIMULATOR_ID, { type: 'register-self' }).catch(_error => {});
      }
      catch(_error) {
      }
    case 'device-added':
    case 'device-updated':
    case 'device-removed':
      updateSelf();
      break;
  }
});

export async function init() {
  configs.$addObserver(onConfigChanged); // we need to register the listener to collect pre-sent changes
  await configs.$loaded;
  await ensureDeviceInfoInitialized();
  await updateSelf();
  initialized = true;

  reserveToReceiveMessage();
  window.setInterval(updateSelf, 1000 * 60 * 60 * 24); // update info every day!

  for (const change of preChanges) {
    onConfigChanged(change.key, change.value);
  }
  preChanges = [];

  try {
    browser.runtime.sendMessage(SEND_TABS_SIMULATOR_ID, { type: 'register-self' }).catch(_error => {});
  }
  catch(_error) {
  }
}

export async function generateDeviceInfo({ name, icon } = {}) {
  const [platformInfo, browserInfo] = await Promise.all([
    browser.runtime.getPlatformInfo(),
    browser.runtime.getBrowserInfo()
  ]);
  return {
    id:   `device-${Date.now()}-${Math.round(Math.random() * 65000)}`,
    name: name === undefined ?
      browser.i18n.getMessage('syncDeviceDefaultName', [toHumanReadableOSName(platformInfo.os), browserInfo.name]) :
      (name || null),
    icon: icon || 'device-desktop'
  };
}

// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/runtime/PlatformOs
function toHumanReadableOSName(os) {
  switch (os) {
    case 'mac': return 'macOS';
    case 'win': return 'Windows';
    case 'android': return 'Android';
    case 'cros': return 'Chrome OS';
    case 'linux': return 'Linux';
    case 'openbsd': return 'Open/FreeBSD';
    default: return 'Unknown Platform';
  }
}

configs.$addObserver(key => {
  switch (key) {
    case 'syncUnsendableUrlPattern':
      isSendableTab.unsendableUrlMatcher = null;
      break;

    default:
      break;
  }
});

async function updateSelf() {
  if (updateSelf.updating)
    return;

  updateSelf.updating = true;

  const [devices] = await Promise.all([
    (async () => {
      try {
        return await browser.runtime.sendMessage(SEND_TABS_SIMULATOR_ID, { type: 'list-devices' });
      }
      catch(_error) {
      }
    })(),
    ensureDeviceInfoInitialized(),
  ]);
  if (devices) {
    const myDeviceFromSimulator = devices.find(device => device.myself);
    if (mMyDeviceInfo.simulatorId != myDeviceFromSimulator.id)
      mMyDeviceInfo.simulatorId = myDeviceFromSimulator.id;
  }

  configs.syncDeviceInfo = mMyDeviceInfo = {
    ...clone(configs.syncDeviceInfo),
    timestamp: Date.now(),
  };

  await updateDevices();

  setTimeout(() => {
    updateSelf.updating = false;
  }, 250);
}

async function updateDevices() {
  if (updateDevices.updating)
    return;
  updateDevices.updating = true;
  const [devicesFromSimulator] = await Promise.all([
    (async () => {
      try {
        return await browser.runtime.sendMessage(SEND_TABS_SIMULATOR_ID, { type: 'list-devices' });
      }
      catch(_error) {
      }
    })(),
    waitUntilDeviceInfoInitialized(),
  ]);

  const remote = clone(configs.syncDevices);
  const local  = clone(configs.syncDevicesLocalCache);
  log('devices updated: ', local, remote);
  for (const [id, info] of Object.entries(remote)) {
    if (id == mMyDeviceInfo.id)
      continue;
    local[id] = info;
    if (id in local) {
      log('updated device: ', info);
      onUpdatedDevice.dispatch(info);
    }
    else {
      log('new device: ', info);
      onNewDevice.dispatch(info);
    }
  }

  if (devicesFromSimulator) {
    const knownDeviceIdsFromSimulator = new Set(Object.values(local).map(device => device.simulatorId).filter(id => !!id));
    for (const deviceFromSimulator of devicesFromSimulator) {
      if (knownDeviceIdsFromSimulator.has(deviceFromSimulator.id))
        continue;
      const localId = `device-from-simulator:${deviceFromSimulator.id}`;
      local[localId] = {
        ...deviceFromSimulator,
        id: localId,
      };
    }
  }

  for (const [id, info] of Object.entries(local)) {
    if (id in remote ||
        id == mMyDeviceInfo.id)
      continue;
    log('obsolete device: ', info);
    delete local[id];
    onObsoleteDevice.dispatch(info);
  }

  if (configs.syncDeviceExpirationDays > 0) {
    const expireDateInSeconds = Date.now() - (1000 * 60 * 60 * configs.syncDeviceExpirationDays);
    for (const [id, info] of Object.entries(local)) {
      if (info &&
          info.timestamp < expireDateInSeconds) {
        delete local[id];
        log('expired device: ', info);
        onObsoleteDevice.dispatch(info);
      }
    }
  }

  local[mMyDeviceInfo.id] = clone(mMyDeviceInfo);
  log('store myself: ', mMyDeviceInfo, local[mMyDeviceInfo.id]);

  if (!configs.syncOtherDevicesDetected && Object.keys(local).length > 1)
    configs.syncOtherDevicesDetected = true;

  configs.syncDevices = local;
  configs.syncDevicesLocalCache = clone(local);
  setTimeout(() => {
    updateDevices.updating = false;
  }, 250);
}

function reserveToReceiveMessage() {
  if (reserveToReceiveMessage.reserved)
    clearTimeout(reserveToReceiveMessage.reserved);
  reserveToReceiveMessage.reserved = setTimeout(() => {
    delete reserveToReceiveMessage.reserved;
    receiveMessage();
  }, 250);
}

async function receiveMessage() {
  const myDeviceInfo = await getMyDeviceInfo();
  try {
    const messages = readMessages();
    log('receiveMessage: queued messages => ', messages);
    const restMessages = messages.filter(message => {
      if (message.timestamp <= configs.syncLastMessageTimestamp)
        return false;
      if (message.to == myDeviceInfo.id) {
        log('receiveMessage receive: ', message);
        configs.syncLastMessageTimestamp = message.timestamp;
        onMessage.dispatch(message);
        return false;
      }
      return true;
    });
    log('receiveMessage: restMessages => ', restMessages);
    if (restMessages.length != messages.length)
      writeMessages(restMessages);
  }
  catch(error) {
    log('receiveMessage fatal error: ', error);
    writeMessages([]);
  }
}

export async function sendMessage(to, data) {
  const myDeviceInfo = await getMyDeviceInfo();
  try {
    const messages = readMessages();
    messages.push({
      timestamp: Date.now(),
      from:      myDeviceInfo.id,
      to,
      data
    });
    log('sendMessage: queued messages => ', messages);
    writeMessages(messages);
  }
  catch(error) {
    console.log('Sync.sendMessage: failed to send message ', error);
    writeMessages([]);
  }
}

function readMessages() {
  try {
    return uniqMessages([
      ...JSON.parse(getChunkedConfig('chunkedSyncDataLocal') || '[]'),
      ...JSON.parse(getChunkedConfig('chunkedSyncData') || '[]')
    ]);
  }
  catch(error) {
    log('failed to read messages: ', error);
    return [];
  }
}

function writeMessages(messages) {
  const stringified = JSON.stringify(messages || []);
  setChunkedConfig('chunkedSyncDataLocal', stringified);
  setChunkedConfig('chunkedSyncData', stringified);
}

function uniqMessages(messages) {
  const knownMessages = new Set();
  return messages.filter(message => {
    const key = JSON.stringify(message);
    if (knownMessages.has(key))
      return false;
    knownMessages.add(key);
    return true;
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function getOtherDevices() {
  if (mExternalProvider)
    return mExternalProvider.getOtherDevices();

  await waitUntilDeviceInfoInitialized();

  const devices = configs.syncDevices || {};
  const result = [];
  for (const [id, info] of Object.entries(devices)) {
    if (id == mMyDeviceInfo.id ||
        !info.id /* ignore invalid device info accidentally saved (see also https://github.com/piroor/treestyletab/issues/2922 ) */)
      continue;
    result.push(info);
  }
  return result.sort((a, b) => a.name > b.name);
}

export function getDeviceName(id) {
  const devices = configs.syncDevices || {};
  if (!(id in devices) || !devices[id])
    return browser.i18n.getMessage('syncDeviceUnknownDevice');
  return String(devices[id].name || '').trim() || browser.i18n.getMessage('syncDeviceMissingDeviceName');
}

// https://searchfox.org/mozilla-central/rev/d866b96d74ec2a63f09ee418f048d23f4fd379a2/browser/base/content/browser-sync.js#1176
export function isSendableTab(tab) {
  if (!tab.url ||
      tab.url.length > 65535)
    return false;

  if (!isSendableTab.unsendableUrlMatcher)
    isSendableTab.unsendableUrlMatcher = new RegExp(configs.syncUnsendableUrlPattern);
  return !isSendableTab.unsendableUrlMatcher.test(tab.url);
}

export function sendTabsToDevice(tabs, { to, recursively } = {}) {
  if (recursively)
    tabs = Tab.collectRootTabs(tabs).map(tab => [tab, ...tab.$TST.descendants]).flat();
  tabs = tabs.filter(isSendableTab);

  if (mExternalProvider)
    return mExternalProvider.sendTabsToDevice(tabs, to);

  sendMessage(to, getTabsDataToSend(tabs));

  const multiple = tabs.length > 1 ? '_multiple' : '';
  notify({
    title: browser.i18n.getMessage(
      `sentTabs_notification_title${multiple}`,
      [getDeviceName(to)]
    ),
    message: browser.i18n.getMessage(
      `sentTabs_notification_message${multiple}`,
      [getDeviceName(to)]
    ),
    timeout: configs.syncSentTabsNotificationTimeout
  });
}

export async function sendTabsToAllDevices(tabs, { recursively } = {}) {
  if (recursively)
    tabs = Tab.collectRootTabs(tabs).map(tab => [tab, ...tab.$TST.descendants]).flat();
  tabs = tabs.filter(isSendableTab);

  if (mExternalProvider)
    return mExternalProvider.sendTabsToAllDevices(tabs);

  const data = getTabsDataToSend(tabs);
  const devices = await getOtherDevices();
  for (const device of devices) {
    sendMessage(device.id, data);
  }

  const multiple = tabs.length > 1 ? '_multiple' : '';
  notify({
    title:   browser.i18n.getMessage(`sentTabsToAllDevices_notification_title${multiple}`),
    message: browser.i18n.getMessage(`sentTabsToAllDevices_notification_message${multiple}`),
    timeout: configs.syncSentTabsNotificationTimeout
  });
}

function getTabsDataToSend(tabs) {
  return {
    type:       Constants.kSYNC_DATA_TYPE_TABS,
    tabs:       tabs.map(tab => ({ url: tab.url, cookieStoreId: tab.cookieStoreId })),
    structure : TreeBehavior.getTreeStructureFromTabs(tabs).map(item => item.parent)
  };
}

export function manageDevices(windowId) {
  if (mExternalProvider)
    return mExternalProvider.manageDevices(windowId);

  browser.tabs.create({
    windowId,
    url: `${Constants.kSHORTHAND_URIS.options}#syncTabsToDeviceOptions`
  });
}
