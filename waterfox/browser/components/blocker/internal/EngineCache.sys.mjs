/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CACHE_ROOT_DIR_NAME } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

const ENGINE_CACHE_NAME_RE = /^adblock-engine\..+\.cache$/;
const CACHE_META_NAME_RE = /^cache-meta\..+\.json$/;

function engineCacheFileName() {
  return `adblock-engine.${Services.appinfo.appBuildID}.cache`;
}

function cacheMetaFileName() {
  return `cache-meta.${Services.appinfo.appBuildID}.json`;
}

function bytesToHex(binaryString) {
  let out = "";
  for (let i = 0; i < binaryString.length; i++) {
    out += `0${binaryString.charCodeAt(i).toString(16)}`.slice(-2);
  }
  return out;
}

function nowISO() {
  return new Date().toISOString();
}

function cacheRootPath() {
  const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
  f.append(CACHE_ROOT_DIR_NAME);
  return f.path;
}

function engineCachePath() {
  const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
  f.append(CACHE_ROOT_DIR_NAME);
  f.append(engineCacheFileName());
  return f.path;
}

function cacheMetaPath() {
  const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
  f.append(CACHE_ROOT_DIR_NAME);
  f.append(cacheMetaFileName());
  return f.path;
}

function computeListsHash(descriptors, listRecords) {
  const makeRecordKey = (url, filename) => JSON.stringify([url, filename]);
  const byKey = new Map(
    listRecords.map(record => [
      makeRecordKey(record.url, record.filename),
      record.text ?? "",
    ])
  );

  const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hasher.init(hasher.SHA256);

  const encoder = new TextEncoder();
  for (const descriptor of descriptors) {
    const descriptorTag = `${descriptor.url}\n${descriptor.filename}\n`;
    const descriptorBytes = encoder.encode(descriptorTag);
    hasher.update(descriptorBytes, descriptorBytes.length);

    const content =
      byKey.get(makeRecordKey(descriptor.url, descriptor.filename)) ?? "";
    const contentBytes = encoder.encode(content);
    hasher.update(contentBytes, contentBytes.length);

    const sep = encoder.encode("\n---\n");
    hasher.update(sep, sep.length);
  }

  return bytesToHex(hasher.finish(false));
}

async function readJSON(path, fallbackValue) {
  try {
    const bytes = await IOUtils.read(path);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    if (err?.result !== Cr.NS_ERROR_FILE_NOT_FOUND) {
      console.warn(`[WaterfoxBlocker] Failed reading JSON ${path}:`, err);
    }
    return fallbackValue;
  }
}

async function writeJSON(path, value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  await IOUtils.write(path, bytes);
}

export const EngineCache = {
  async clear() {
    try {
      await IOUtils.remove(engineCachePath(), { ignoreAbsent: true });
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed removing engine cache file:", err);
    }

    try {
      await IOUtils.remove(cacheMetaPath(), { ignoreAbsent: true });
    } catch (err) {
      console.warn(
        "[WaterfoxBlocker] Failed removing cache metadata file:",
        err
      );
    }
  },

  async cleanupStale() {
    const root = cacheRootPath();
    if (!(await IOUtils.exists(root))) {
      return;
    }

    const keep = new Set([engineCacheFileName(), cacheMetaFileName()]);
    for (const path of await IOUtils.getChildren(root)) {
      const name = path.split(/[\\/]/).pop();
      if (keep.has(name)) {
        continue;
      }

      if (ENGINE_CACHE_NAME_RE.test(name) || CACHE_META_NAME_RE.test(name)) {
        await IOUtils.remove(path, { ignoreAbsent: true });
      }
    }
  },

  async ensureRootDir() {
    await IOUtils.makeDirectory(cacheRootPath(), {
      createAncestors: true,
      ignoreExisting: true,
    });
  },

  async matchesCurrentLists(descriptors, listRecords) {
    if (
      !(await IOUtils.exists(engineCachePath())) ||
      !(await IOUtils.exists(cacheMetaPath()))
    ) {
      return false;
    }

    if (!listRecords.length) {
      return false;
    }

    const cacheMeta = await readJSON(cacheMetaPath(), null);
    if (!cacheMeta?.listsHash) {
      return false;
    }

    return computeListsHash(descriptors, listRecords) === cacheMeta.listsHash;
  },

  async read() {
    return IOUtils.read(engineCachePath());
  },

  readSync() {
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(engineCachePath());
    if (!file.exists() || file.fileSize === 0) {
      return null;
    }

    const stream = Cc[
      "@mozilla.org/network/file-input-stream;1"
    ].createInstance(Ci.nsIFileInputStream);
    stream.init(file, 0x01 /* PR_RDONLY */, 0, 0);
    try {
      const binaryStream = Cc[
        "@mozilla.org/binaryinputstream;1"
      ].createInstance(Ci.nsIBinaryInputStream);
      binaryStream.setInputStream(stream);
      return binaryStream.readByteArray(file.fileSize);
    } finally {
      stream.close();
    }
  },

  async write(engine, descriptors, listRecords) {
    if (!engine) {
      return;
    }

    await this.ensureRootDir();

    const serialized = engine.serialize();
    const bytes =
      serialized instanceof Uint8Array
        ? serialized
        : new Uint8Array(serialized);
    await IOUtils.write(engineCachePath(), bytes);

    const listsHash = computeListsHash(descriptors, listRecords);
    await writeJSON(cacheMetaPath(), {
      createdAt: nowISO(),
      listsHash,
    });
  },
};
