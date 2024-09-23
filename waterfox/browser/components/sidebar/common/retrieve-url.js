/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
} from './common.js';
import * as Permissions from './permissions.js';

function log(...args) {
  internalLogger('common/retrieve-url', ...args);
}

export const kTYPE_PLAIN_TEXT  = 'text/plain';
export const kTYPE_X_MOZ_URL   = 'text/x-moz-url';
export const kTYPE_URI_LIST    = 'text/uri-list';
export const kTYPE_MOZ_TEXT_INTERNAL = 'text/x-moz-text-internal';
const kBOOKMARK_FOLDER  = 'x-moz-place:';

const ACCEPTABLE_DATA_TYPES = [
  kTYPE_URI_LIST,
  kTYPE_X_MOZ_URL,
  kTYPE_MOZ_TEXT_INTERNAL,
  kTYPE_PLAIN_TEXT,
];

let mFileURLResolver = null;

export async function registerFileURLResolver(resolver) {
  mFileURLResolver = resolver;
}

export async function fromDragEvent(event) {
  log('fromDragEvent ', event);
  const dt = event.dataTransfer;
  const urls = [];
  if (dt.files.length > 0) {
    for (const file of dt.files) {
      if (typeof mFileURLResolver == 'function') {
        urls.push(await mFileURLResolver(file));
      }
      else {
        // Created object URLs need to be revoked by tryRevokeObjectURL()
        // in common/common.js, after they are loaded.
        urls.push(URL.createObjectURL(file));
      }
    }
  }
  else {
    for (const type of ACCEPTABLE_DATA_TYPES) {
      const urlData = dt.getData(type);
      if (urlData)
        urls.push(...fromData(urlData, type));
      if (urls.length)
        break;
    }
    for (const type of dt.types) {
      if (!/^application\/x-ws-drag-data;(.+)$/.test(type))
        continue;
      const params     = RegExp.$1;
      const providerId = /provider=([^;&]+)/.test(params) && RegExp.$1;
      const dataId     = /id=([^;&]+)/.test(params) && RegExp.$1;
      try {
        const dragData = await browser.runtime.sendMessage(providerId, {
          type: 'get-drag-data',
          id:   dataId
        });
        if (!dragData || typeof dragData != 'object')
          break;
        for (const type of ACCEPTABLE_DATA_TYPES) {
          const urlData = dragData[type];
          if (urlData)
            urls.push(...fromData(urlData, type));
          if (urls.length)
            break;
        }
      }
      catch(_error) {
      }
    }
  }
  log(' => retrieved: ', urls);
  return sanitizeURLs(urls);
}

let mSelectionClipboardProvider = null;

/* provider should have two methods:
    isAvailable(): returns boolean which indicates the selection clipboard is available or not.
    getTextData(): returns a string from the selection clipboard.
*/
export function registerSelectionClipboardProvider(provider) {
  mSelectionClipboardProvider = provider;
}

export async function fromClipboard({ selection } = {}) {
  const urls = [];

  if (selection && mSelectionClipboardProvider) {
    if (await mSelectionClipboardProvider.isAvailable()) {
      const maybeUrlString = await mSelectionClipboardProvider.getTextData();
      if (maybeUrlString)
        urls.push(...fromData(maybeUrlString, kTYPE_PLAIN_TEXT));
      return sanitizeURLs(urls);
    }
  }

  if (!(await Permissions.isGranted(Permissions.CLIPBOARD_READ)) ||
      typeof navigator.clipboard.read != 'function')
    return urls;

  const clipboardContents = await navigator.clipboard.read();
  log('fromClipboard ', clipboardContents);

  for (const item of clipboardContents) {
    for (const type of item.types) {
      const maybeUrlBlob   = await item.getType(type);
      const maybeUrlString = await maybeUrlBlob.text();
      if (maybeUrlString)
        urls.push(...fromData(maybeUrlString, type));
      if (urls.length)
        break;
    }
  }
  log(' => retrieved: ', urls);
  return sanitizeURLs(urls);
}

function sanitizeURLs(urls) {
  const filteredUrls = urls.filter(url =>
    url &&
      url.length &&
      url.indexOf(kBOOKMARK_FOLDER) == 0 ||
      !/^\s*(javascript|data):/.test(url)
  );
  log('sanitizeURLs filtered: ', filteredUrls);

  const fixedUrls = filteredUrls.map(fixupURIFromText);
  log('sanitizeURLs fixed: ', fixedUrls);

  return fixedUrls;
}

function fromData(data, type) {
  log('fromData: ', type, data);
  switch (type) {
    case kTYPE_URI_LIST:
      return data
        .replace(/\r/g, '\n')
        .replace(/\n\n+/g, '\n')
        .split('\n')
        .filter(line => {
          return line.charAt(0) != '#';
        });

    case kTYPE_X_MOZ_URL:
      return data
        .trim()
        .replace(/\r/g, '\n')
        .replace(/\n\n+/g, '\n')
        .split('\n')
        .filter((_line, index) => {
          return index % 2 == 0;
        });

    case kTYPE_MOZ_TEXT_INTERNAL:
      return data
        .replace(/\r/g, '\n')
        .replace(/\n\n+/g, '\n')
        .trim()
        .split('\n');

    case kTYPE_PLAIN_TEXT:
      return data
        .replace(/\r/g, '\n')
        .replace(/\n\n+/g, '\n')
        .trim()
        .split('\n')
        .map(line => {
          return /^\w+:\/\/.+/.test(line) ? line : `ext+ws:search:${line}`;
        });
  }
  return [];
}

function fixupURIFromText(maybeURI) {
  if (/^(ext\+)?\w+:/.test(maybeURI))
    return maybeURI;

  if (/^([^\.\s]+\.)+[^\.\s]{2}/.test(maybeURI))
    return `http://${maybeURI}`;

  return maybeURI;
}
