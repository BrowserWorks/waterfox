/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  configs,
} from '/common/common.js';

const mNotificationsContainer = document.querySelector('#notifications');

export function add(id, { message, contents, onCreated } = {}) {
  const elementId = `notification_${id}`;
  let notification = document.getElementById(elementId);
  if (!notification) {
    notification = document.createElement('span');
    notification.id = elementId;
  }

  if (contents) {
    const range = document.createRange();
    range.selectNodeContents(notification);
    range.deleteContents();
    range.detach();
    notification.appendChild(contents);
  }
  else if (message) {
    notification.textContent = message;
  }

  if (notification.parentNode)
    return notification;

  mNotificationsContainer.appendChild(notification);

  if (typeof onCreated == 'function')
    onCreated(notification);

  if (mNotificationsContainer.childNodes.length > 0) {
    mNotificationsContainer.classList.remove('hiding');
    mNotificationsContainer.classList.add('shown');
  }

  return notification;
}

export function remove(id) {
  const elementId = `notification_${id}`;
  const existingNotification = document.getElementById(elementId);
  if (!existingNotification)
    return;

  existingNotification.parentNode.removeChild(existingNotification);
  if (mNotificationsContainer.childNodes.length > 0)
    return;

  mNotificationsContainer.classList.add('hiding');
  mNotificationsContainer.classList.remove('shown');
  setTimeout(() => {
    mNotificationsContainer.classList.remove('hiding');
  }, configs.collapseDuration);
}
