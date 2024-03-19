/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import EventListenerManager from '/extlib/EventListenerManager.js';

import {
  log as internalLogger,
  mapAndFilterUniq,
  configs
} from './common.js';
import * as Constants from './constants.js';
import * as TabsStore from './tabs-store.js';

function log(...args) {
  internalLogger('common/sidebar-connection', ...args);
}

export const onMessage = new EventListenerManager();
export const onConnected = new EventListenerManager();
export const onDisconnected = new EventListenerManager();

const mConnections = new Map();
const mReceivers = new Map();
const mFocusState = new Map();
let mIsListening = false;

export function isInitialized() {
  return mIsListening;
}

export function isSidebarOpen(windowId) {
  if (!mIsListening ||
      Constants.IS_SIDEBAR)
    return false;

  // for automated tests
  if (configs.sidebarVirtuallyOpenedWindows.length > 0 &&
      configs.sidebarVirtuallyOpenedWindows.includes(windowId))
    return true;
  if (configs.sidebarVirtuallyClosedWindows.length > 0 &&
      configs.sidebarVirtuallyClosedWindows.includes(windowId))
    return false;

  if (windowId in configs.sidebarWidthInWindow &&
      configs.sidebarWidthInWindow[windowId] == 0)
    return false;

  const connections = mConnections.get(windowId);
  if (!connections)
    return false;
  for (const connection of connections) {
    if (connection.type == 'sidebar')
      return true;
  }
  return false;
}

export function isOpen(windowId) {
  if (!mIsListening ||
      Constants.IS_SIDEBAR)
    return false;

  // for automated tests
  if (configs.sidebarVirtuallyOpenedWindows.length > 0 &&
      configs.sidebarVirtuallyOpenedWindows.includes(windowId))
    return true;
  if (configs.sidebarVirtuallyClosedWindows.length > 0 &&
      configs.sidebarVirtuallyClosedWindows.includes(windowId))
    return false;

  if (windowId in configs.sidebarWidthInWindow &&
      configs.sidebarWidthInWindow[windowId] == 0)
    return false;

  const connections = mConnections.get(windowId);
  return connections && connections.size > 0;
}

export function hasFocus(windowId) {
  return mFocusState.has(windowId)
}

export const counts = {
  broadcast: {}
};

export function getOpenWindowIds() {
  return mIsListening ? Array.from(mConnections.keys()) : [];
}

export function sendMessage(message) {
  if (!mIsListening ||
      Constants.IS_SIDEBAR)
    return false;

  if (Array.isArray(message))
    log('Sending ', message.length, ' messages');

  if (message.windowId) {
    if (configs.loggingConnectionMessages) {
      counts[message.windowId] = counts[message.windowId] || {};
      const localCounts = counts[message.windowId];
      localCounts[message.type] = localCounts[message.type] || 0;
      localCounts[message.type]++;
    }
    const connections = mConnections.get(message.windowId);
    if (!connections || connections.size == 0)
      return false;
    for (const connection of connections) {
      sendMessageToPort(connection.port, message);
    }
    //port.postMessage(message);
    return true;
  }

  // broadcast
  counts.broadcast[message.type] = counts.broadcast[message.type] || 0;
  counts.broadcast[message.type]++;
  for (const connections of mConnections.values()) {
    if (!connections || connections.size == 0)
      continue;
    for (const connection of connections) {
      sendMessageToPort(connection.port, message);
    }
    //port.postMessage(message);
  }
  return true;
}

const mReservedTasks = new WeakMap();

// Se should not send messages immediately, instead we should throttle
// it and bulk-send multiple messages, for better user experience.
// Sending too much messages in one event loop may block everything
// and makes Firefox like frozen.
function sendMessageToPort(port, message) {
  const task = mReservedTasks.get(port) || { messages: [] };
  task.messages.push(message);
  mReservedTasks.set(port, task);
  if (!task.onFrame) {
    task.onFrame = () => {
      delete task.onFrame;
      const messages = task.messages;
      task.messages = [];
      port.postMessage(messages);
      if (configs.debug) {
        const types = mapAndFilterUniq(messages,
                                       message => message.type || undefined).join(', ');
        log(`${messages.length} messages sent (${types}):`, messages);
      }
    };
    // We should not use window.requestAnimationFrame for throttling,
    // because it is quite lagged on some environment. Firefox may
    // decelerate the method for an invisible document (the background
    // page).
    //window.requestAnimationFrame(task.onFrame);
    setTimeout(task.onFrame, 0);
  }
}

if (Constants.IS_BACKGROUND) {
  const matcher = new RegExp(`^${Constants.kCOMMAND_REQUEST_CONNECT_PREFIX}([0-9]+):(.+)$`);
  browser.runtime.onConnect.addListener(port => {
    if (!mIsListening ||
        !matcher.test(port.name))
      return;

    const windowId   = parseInt(RegExp.$1);
    const type       = RegExp.$2;
    const connection = { port, type };
    const connections = mConnections.get(windowId) || new Set();
    connections.add(connection);
    mConnections.set(windowId, connections);
    let connectionTimeoutTimer = null;
    const updateTimeoutTimer = () => {
      if (connectionTimeoutTimer) {
        clearTimeout(connectionTimeoutTimer);
        connectionTimeoutTimer = null;
      }
      // On slow situation (like having too many tabs - 5000 or more)
      // we should wait more for the pong. Otherwise the vital check
      // may produce needless reloadings even if the sidebar is still alive.
      // See also https://github.com/piroor/treestyletab/issues/3130
      const timeout = configs.heartbeatInterval + Math.max(configs.connectionTimeoutDelay, TabsStore.tabs.size);
      connectionTimeoutTimer = setTimeout(async () => {
        log(`Missing heartbeat from window ${windowId}. Maybe disconnected or resumed.`);
        try {
          const pong = await browser.runtime.sendMessage({
            type: Constants.kCOMMAND_PING_TO_SIDEBAR,
            windowId
          });
          if (pong) {
            log(`Sidebar for the window ${windowId} responded. Keep connected.`);
            return;
          }
        }
        catch(_error) {
        }
        log(`Sidebar for the window ${windowId} did not respond. Disconnect now.`);
        cleanup(); // eslint-disable-line no-use-before-define
        port.disconnect();
      }, timeout);
    };
    const cleanup = _diconnectedPort => {
      if (!port.onMessage.hasListener(receiver)) // eslint-disable-line no-use-before-define
        return;
      if (connectionTimeoutTimer) {
        clearTimeout(connectionTimeoutTimer);
        connectionTimeoutTimer = null;
      }
      connections.delete(connection);
      if (connections.size == 0) {
        mConnections.delete(windowId);
        const sidebarWidthInWindow = { ...configs.sidebarWidthInWindow };
        delete sidebarWidthInWindow[windowId];
        configs.sidebarWidthInWindow = sidebarWidthInWindow;
      }
      port.onMessage.removeListener(receiver); // eslint-disable-line no-use-before-define
      mReceivers.delete(windowId);
      mFocusState.delete(windowId);
      onDisconnected.dispatch(windowId, connections.size);
    };
    const receiver = message => {
      if (Array.isArray(message))
        return message.forEach(receiver);
      if (message.type == Constants.kCONNECTION_HEARTBEAT)
        updateTimeoutTimer();
      else
        onMessage.dispatch(windowId, message);
    };
    port.onMessage.addListener(receiver);
    mReceivers.set(windowId, receiver);
    onConnected.dispatch(windowId, connections.size);
    port.onDisconnect.addListener(cleanup);
  });

  onMessage.addListener(async (windowId, message) => {
    switch (message.type) {
      case Constants.kNOTIFY_SIDEBAR_FOCUS:
        mFocusState.set(windowId, true);
        break;

      case Constants.kNOTIFY_SIDEBAR_BLUR:
        mFocusState.delete(windowId);
        break;
    }
  });
}

export function init() {
  if (mIsListening)
    return;

  mIsListening = true;
}


//===================================================================
// Logging
//===================================================================

browser.runtime.onMessage.addListener((message, _sender) => {
  if (!mIsListening ||
      !message ||
      typeof message != 'object' ||
      message.type != Constants.kCOMMAND_REQUEST_CONNECTION_MESSAGE_LOGS ||
      !Constants.IS_BACKGROUND)
    return;

  browser.runtime.sendMessage({
    type: Constants.kCOMMAND_RESPONSE_CONNECTION_MESSAGE_LOGS,
    logs: JSON.parse(JSON.stringify(counts))
  });
});
