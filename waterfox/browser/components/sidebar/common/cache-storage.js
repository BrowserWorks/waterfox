/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import * as UniqueId from '/common/unique-id.js';
import {
  asyncRunWithTimeout,
} from '/common/common.js';

const DB_NAME = 'PermanentStorage';
const DB_VERSION = 3;
const EXPIRATION_TIME_IN_MSEC = 7 * 24 * 60 * 60 * 1000; // 7 days
const TIMEOUT_IN_MSEC = 1000 * 5; // 5 sec

export const BACKGROUND = 'backgroundCaches';
const SIDEBAR = 'sidebarCaches'; // obsolete, but left here to delete old storage

let mOpenedDB;

async function openDB() {
  if (mOpenedDB)
    return mOpenedDB;
  return new Promise((resolve, _reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      // This can fail if this is in a private window.
      // See: https://github.com/piroor/treestyletab/issues/3387
      //reject(new Error('Failed to open database'));
      resolve(null);
    };

    request.onsuccess = () => {
      const db = request.result;
      mOpenedDB = db;
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      const objectStores = db.objectStoreNames;

      const needToUpgrade = event.oldVersion < DB_VERSION;
      if (needToUpgrade) {
        if (objectStores.contains(BACKGROUND))
          db.deleteObjectStore(BACKGROUND);
        if (objectStores.contains(SIDEBAR))
          db.deleteObjectStore(SIDEBAR);
      }

      if (needToUpgrade ||
          !objectStores.contains(BACKGROUND)) {
        const backgroundCachesStore = db.createObjectStore(BACKGROUND, { keyPath: 'key', unique: true });
        backgroundCachesStore.createIndex('windowId', 'windowId', { unique: false });
        backgroundCachesStore.createIndex('timestamp', 'timestamp');
      }
    };
  });
}

export async function setValue({ windowId, key, value } = {}) {
  const [db, windowUniqueId] = await Promise.all([
    openDB(),
    UniqueId.ensureWindowId(windowId),
  ]);
  if (!db)
    return;

  reserveToExpireOldEntries();

  const store = BACKGROUND;

  const cacheKey = `${windowUniqueId}-${key}`;
  asyncRunWithTimeout({
    task: () => new Promise((resolve, reject) => {
      const timestamp = Date.now();
      try {
        const transaction = db.transaction([store], 'readwrite');
        const cacheStore = transaction.objectStore(store);
        const cacheRequest = cacheStore.put({
          key:      cacheKey,
          windowId: windowUniqueId,
          value,
          timestamp,
        });

        transaction.oncomplete = () => {
          //db.close();
          windowId = undefined;
          key      = undefined;
          value    = undefined;
          resolve();
        };

        cacheRequest.onerror = event => {
          console.error(`Failed to store cache ${cacheKey} in the store ${store}`, event);
          reject(event);
        };
      }
      catch(error) {
        console.error(`Failed to store cache ${cacheKey} in the store ${store}`, error);
        reject(error);
      }
    }),
    timeout: TIMEOUT_IN_MSEC,
    onTimedOut() {
      throw new Error(`CacheStorage.setValue for {windowId}/key timed out`);
    },
  });
}

export async function deleteValue({ windowId, key } = {}) {
  const [db, windowUniqueId] = await Promise.all([
    openDB(),
    UniqueId.ensureWindowId(windowId),
  ]);
  if (!db)
    return;

  reserveToExpireOldEntries();

  const store = BACKGROUND;

  const cacheKey = `${windowUniqueId}-${key}`;
  asyncRunWithTimeout({
    task: () => new Promise((resolve, reject) => {
      try {
        const transaction = db.transaction([store], 'readwrite');
        const cacheStore = transaction.objectStore(store);
        const cacheRequest = cacheStore.delete(cacheKey);

        transaction.oncomplete = () => {
          //db.close();
          windowId = undefined;
          key      = undefined;
          resolve();
        };

        cacheRequest.onerror = event => {
          console.error(`Failed to delete cache ${cacheKey} in the store ${store}`, event);
          reject(event);
        };
      }
      catch(error) {
        console.error(`Failed to delete cache ${cacheKey} in the store ${store}`, error);
        reject(error);
      }
    }),
    timeout: TIMEOUT_IN_MSEC,
    onTimedOut() {
      throw new Error(`CacheStorage.deleteValue for {windowId}/key timed out`);
    },
  });
}

export async function getValue({ windowId, key } = {}) {
  return asyncRunWithTimeout({
    task: () => getValueInternal({ windowId, key }),
    timeout: TIMEOUT_IN_MSEC,
    onTimedOut() {
      throw new Error(`CacheStorage.getValue for {windowId}/${key} timed out`);
    },
  });
}
async function getValueInternal({ windowId, key } = {}) {
  return new Promise(async (resolve, _reject) => {
    const [db, windowUniqueId] = await Promise.all([
      openDB(),
      UniqueId.ensureWindowId(windowId),
    ]);
    if (!db) {
      resolve(null);
      return;
    }

    const store = BACKGROUND;

    const cacheKey = `${windowUniqueId}-${key}`;
    const timestamp = Date.now();
    try {
      const transaction = db.transaction([store], 'readwrite');
      const cacheStore = transaction.objectStore(store);

      const cacheRequest = cacheStore.get(cacheKey);

      cacheRequest.onsuccess = () => {
        const cache = cacheRequest.result;
        if (!cache) {
          resolve(null);
          return;
        }
        // IndexedDB does not support partial update, so
        // we need to put all properties not only timestamp.
        cacheStore.put({
          key:      cacheKey,
          windowId: windowUniqueId,
          value:    cache.value,
          timestamp,
        });
        resolve(cache.value);
        cache.key      = undefined;
        cache.windowId = undefined;
        cache.value    = undefined;
      };

      cacheRequest.onerror = event => {
        console.error('Failed to get from cache:', event);
        resolve(null);
      };

      transaction.oncomplete = () => {
        //db.close();
        windowId = undefined;
        key      = undefined;
      };
    }
    catch(error) {
      console.error('Failed to get from cache:', error);
      resolve(null);
    }
  });
}

export async function clearForWindow(windowId) {
  return asyncRunWithTimeout({
    task: () => clearForWindowInternal(windowId),
    timeout: TIMEOUT_IN_MSEC,
    onTimedOut() {
      throw new Error(`CacheStorage.clearForWindow for {windowId} timed out`);
    },
  });
}
async function clearForWindowInternal(windowId) {
  reserveToExpireOldEntries();
  return new Promise(async (resolve, reject) => {
    const [db, windowUniqueId] = await Promise.all([
      openDB(),
      UniqueId.ensureWindowId(windowId),
    ]);
    if (!db) {
      resolve(null);
      return;
    }

    try {
      const transaction = db.transaction([BACKGROUND], 'readwrite');
      const backgroundCacheStore = transaction.objectStore(BACKGROUND);
      const backgroundCacheIndex = backgroundCacheStore.index('windowId');
      const backgroundCacheRequest = backgroundCacheIndex.openCursor(IDBKeyRange.only(windowUniqueId));
      backgroundCacheRequest.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor)
          return;
        const key = cursor.primaryKey;
        cursor.continue();
        backgroundCacheStore.delete(key);
      };

      transaction.oncomplete = () => {
        //db.close();
        resolve();
      };
    }
    catch(error) {
      console.error('Failed to clear caches:', error);
      reject(error);
    }
  });
}

async function reserveToExpireOldEntries() {
  if (reserveToExpireOldEntries.reservedExpiration)
    clearTimeout(reserveToExpireOldEntries.reservedExpiration);
  reserveToExpireOldEntries.reservedExpiration = setTimeout(() => {
    reserveToExpireOldEntries.reservedExpiration = null;
    expireOldEntries();
  }, 500);
}

async function expireOldEntries() {
  return new Promise(async (resolve, reject) => {
    const db = await openDB();
    if (!db) {
      resolve();
      return;
    }

    try {
      const transaction = db.transaction([BACKGROUND], 'readwrite');
      const backgroundCacheStore = transaction.objectStore(BACKGROUND);
      const backgroundCacheIndex = backgroundCacheStore.index('timestamp');

      const expirationTimestamp = Date.now() - EXPIRATION_TIME_IN_MSEC;

      const backgroundCacheRequest = backgroundCacheIndex.openCursor(IDBKeyRange.upperBound(expirationTimestamp));
      backgroundCacheRequest.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor)
          return;
        const key = cursor.primaryKey;
        cursor.continue();
        backgroundCacheStore.delete(key);
      };

      transaction.oncomplete = () => {
        //db.close();
        resolve();
      };
    }
    catch(error) {
      console.error('Failed to expire old entries:', error);
      reject(error);
    }
  });
}
