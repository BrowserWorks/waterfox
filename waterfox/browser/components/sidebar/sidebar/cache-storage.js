/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import Tab from '/common/Tab.js';

const DB_NAME = 'SidebarStorage';
const DB_VERSION = 1;
const EXPIRATION_TIME_IN_MSEC = 7 * 24 * 60 * 60 * 1000; // 7 days

export const PREVIEW = 'previewCaches';

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
      if (event.oldVersion < DB_VERSION) {
        try {
          db.deleteObjectStore(PREVIEW);
        }
        catch(_error) {
        }

        const previewCacheStore = db.createObjectStore(PREVIEW, { keyPath: 'tabId', unique: true });
        previewCacheStore.createIndex('timestamp', 'timestamp');
      }
    };
  });
}

export async function setValue({ tabId, value, store } = {}) {
  const [db, uniqueId] = await Promise.all([
    openDB(),
    Tab.get(tabId)?.$TST.promisedUniqueId,
  ]);
  if (!db || !uniqueId || !uniqueId.id)
    return;

  reserveToExpireOldEntries();

  const timestamp = Date.now();
  try {
    const transaction = db.transaction([store], 'readwrite');
    const cacheStore = transaction.objectStore(store);

    cacheStore.put({
      tabId: uniqueId.id,
      value,
      timestamp,
    });

    transaction.oncomplete = () => {
      //db.close();
      tabId = undefined;
      value = undefined;
      store = undefined;
    };
  }
  catch(error) {
    console.error(`Failed to store cached value for ${uniqueId.id} in the store ${store}`, error);
  }
}

export async function deleteValue({ tabId, store } = {}) {
  const [db, uniqueId] = await Promise.all([
    openDB(),
    Tab.get(tabId)?.$TST.promisedUniqueId,
  ]);
  if (!db || !uniqueId || !uniqueId.id)
    return;

  reserveToExpireOldEntries();

  try {
    const transaction = db.transaction([store], 'readwrite');
    const cacheStore = transaction.objectStore(store);
    cacheStore.delete(uniqueId.id);
    transaction.oncomplete = () => {
      //db.close();
      tabId = undefined;
      store = undefined;
    };
  }
  catch(error) {
    console.error(`Failed to delete cached value for ${uniqueId.id} in the store ${store}`, error);
  }
}

export async function getValue({ tabId, store } = {}) {
  return new Promise(async (resolve, _reject) => {
    const [db, uniqueId] = await Promise.all([
      openDB(),
      Tab.get(tabId)?.$TST.promisedUniqueId,
    ]);
    if (!db || !uniqueId || !uniqueId.id) {
      resolve(null);
      return;
    }

    const timestamp = Date.now();
    try {
      const transaction = db.transaction([store], 'readwrite');
      const cacheStore = transaction.objectStore(store);
      const cacheRequest = cacheStore.get(uniqueId.id);

      cacheRequest.onsuccess = () => {
        const cache = cacheRequest.result;
        if (!cache) {
          resolve(null);
          return;
        }
        // IndexedDB does not support partial update, so
        // we need to put all properties not only timestamp.
        cacheStore.put({
          tabId: uniqueId.id,
          value: cache.value,
          timestamp,
        });
        resolve(cache.value);
        cache.tabId = undefined;
        cache.value = undefined;
      };

      transaction.oncomplete = () => {
        //db.close();
        tabId = undefined;
        store = undefined;
      };
    }
    catch(error) {
      console.error('Failed to get from cached value:', error);
      resolve(null);
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
      const transaction = db.transaction([PREVIEW], 'readwrite');
      const previewCacheStore = transaction.objectStore(PREVIEW);
      const previewCacheIndex = previewCacheStore.index('timestamp');
      const expirationTimestamp = Date.now() - EXPIRATION_TIME_IN_MSEC;
      const previewCacheRequest = previewCacheIndex.openCursor(IDBKeyRange.upperBound(expirationTimestamp));
      previewCacheRequest.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor)
          return;
        const key = cursor.primaryKey;
        cursor.continue();
        previewCacheStore.delete(key);
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
