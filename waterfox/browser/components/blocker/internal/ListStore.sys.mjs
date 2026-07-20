/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  CACHE_ROOT_DIR_NAME,
  CUSTOM_FILTERS_FILE_NAME,
  LISTS_DIR_NAME,
  LISTS_META_FILE_NAME,
} from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

export const MAX_CUSTOM_FILTERS_BYTES = 2 * 1024 * 1024;
export const MAX_CUSTOM_FILTER_LINE_LENGTH = 16 * 1024;

const WATERFOX_UNBREAK_FILTERS_FILE_NAME = "waterfox-unbreak.txt";
const WATERFOX_UNBREAK_FILTERS_URL =
  "resource://waterfox/blocker/assets/filters/waterfox-unbreak.txt";

let gWaterfoxUnbreakRecord = null;

export function normalizeCustomFiltersText(text) {
  const normalized = String(text || "")
    .toWellFormed()
    .replace(/\r\n?/g, "\n");

  const bytes = new TextEncoder().encode(normalized);
  if (bytes.length > MAX_CUSTOM_FILTERS_BYTES) {
    throw new Error("Custom filters are too large");
  }

  for (const line of normalized.split("\n")) {
    if (line.length > MAX_CUSTOM_FILTER_LINE_LENGTH) {
      throw new Error("Custom filter line is too long");
    }
  }

  if (!normalized || normalized.endsWith("\n")) {
    return normalized;
  }

  return `${normalized}\n`;
}

function cacheRootPath() {
  const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
  f.append(CACHE_ROOT_DIR_NAME);
  return f.path;
}

function customFiltersPath() {
  const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
  f.append(CACHE_ROOT_DIR_NAME);
  f.append(CUSTOM_FILTERS_FILE_NAME);
  return f.path;
}

function listPath(filename) {
  const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
  f.append(CACHE_ROOT_DIR_NAME);
  f.append(LISTS_DIR_NAME);
  f.append(filename);
  return f.path;
}

function listsDirPath() {
  const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
  f.append(CACHE_ROOT_DIR_NAME);
  f.append(LISTS_DIR_NAME);
  return f.path;
}

function listsMetadataPath() {
  const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
  f.append(CACHE_ROOT_DIR_NAME);
  f.append(LISTS_DIR_NAME);
  f.append(LISTS_META_FILE_NAME);
  return f.path;
}

function remoteResourceFilePath(name) {
  const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
  f.append(CACHE_ROOT_DIR_NAME);
  f.append(`remote-${name}.json`);
  return f.path;
}

function remoteResourceMetaPath(name) {
  const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
  f.append(CACHE_ROOT_DIR_NAME);
  f.append(`remote-${name}.meta.json`);
  return f.path;
}

function atomicWriteOptions(path) {
  return { tmpPath: `${path}.tmp` };
}

let gListWriteChain = Promise.resolve();

function withListWriteLock(task) {
  const run = gListWriteChain.catch(() => {}).then(task);
  gListWriteChain = run.catch(() => {});
  return run;
}

async function readText(path) {
  const bytes = await IOUtils.read(path);
  return new TextDecoder().decode(bytes);
}

async function writeText(path, text) {
  const bytes = new TextEncoder().encode(String(text));
  await IOUtils.write(path, bytes, atomicWriteOptions(path));
}

function isFileNotFoundError(err) {
  return (
    err?.result === Cr.NS_ERROR_FILE_NOT_FOUND ||
    err?.name === "NotFoundError" ||
    err?.code === "ENOENT"
  );
}

async function readJSON(path, fallbackValue) {
  try {
    const text = await readText(path);
    return JSON.parse(text);
  } catch (err) {
    if (!isFileNotFoundError(err)) {
      console.warn(`[WaterfoxBlocker] Failed reading JSON ${path}:`, err);
    }
    return fallbackValue;
  }
}

async function writeJSON(path, value) {
  await writeText(path, JSON.stringify(value));
}

async function readCustomFiltersText() {
  const path = customFiltersPath();
  if (!(await IOUtils.exists(path))) {
    return "";
  }

  const stat = await IOUtils.stat(path);
  if (stat.size > MAX_CUSTOM_FILTERS_BYTES) {
    throw new Error("Custom filters file is too large");
  }

  return normalizeCustomFiltersText(await IOUtils.readUTF8(path));
}

async function readCustomFiltersRecord(customDescriptor) {
  if (!customDescriptor?.customFilters) {
    return null;
  }

  try {
    const text = await readCustomFiltersText();
    if (!text.trim()) {
      return null;
    }

    return {
      customFilters: true,
      filename: customDescriptor.filename,
      text,
      url: customDescriptor.url,
    };
  } catch (err) {
    console.warn("[WaterfoxBlocker] Failed reading custom filters:", err);
    return null;
  }
}

async function withCustomFiltersRecord(listRecords, descriptors) {
  const customDescriptor = descriptors.find(
    descriptor => descriptor?.customFilters
  );
  if (!customDescriptor) {
    return listRecords;
  }

  const customFiltersRecord = await readCustomFiltersRecord(customDescriptor);
  if (!customFiltersRecord) {
    return listRecords;
  }

  return [...listRecords, customFiltersRecord];
}

async function readWaterfoxUnbreakRecord() {
  if (gWaterfoxUnbreakRecord) {
    return gWaterfoxUnbreakRecord;
  }

  const response = await fetch(WATERFOX_UNBREAK_FILTERS_URL, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    throw new Error("Waterfox unbreak filters were empty");
  }

  gWaterfoxUnbreakRecord = {
    filename: WATERFOX_UNBREAK_FILTERS_FILE_NAME,
    text,
    url: WATERFOX_UNBREAK_FILTERS_URL,
  };
  return gWaterfoxUnbreakRecord;
}

async function withWaterfoxUnbreakRecord(listRecords) {
  return [...listRecords, await readWaterfoxUnbreakRecord()];
}

export const ListStore = {
  MAX_CUSTOM_FILTERS_BYTES,
  MAX_CUSTOM_FILTER_LINE_LENGTH,
  normalizeCustomFiltersText,

  cacheRootPath,
  customFiltersPath,
  listPath,
  listsDirPath,
  listsMetadataPath,
  remoteResourceFilePath,
  remoteResourceMetaPath,

  async ensureRootDir() {
    await IOUtils.makeDirectory(cacheRootPath(), {
      createAncestors: true,
      ignoreExisting: true,
    });
  },

  async ensureListsDir() {
    await IOUtils.makeDirectory(listsDirPath(), {
      createAncestors: true,
      ignoreExisting: true,
    });
  },

  readText,
  writeText,
  readJSON,
  writeJSON,
  withListWriteLock,

  readCustomFiltersText,
  readCustomFiltersRecord,
  withCustomFiltersRecord,
  withWaterfoxUnbreakRecord,

  async readStoredLists(descriptors) {
    const out = [];
    for (const descriptor of descriptors) {
      if (descriptor?.customFilters) {
        const customFiltersRecord = await readCustomFiltersRecord(descriptor);
        if (customFiltersRecord) {
          out.push(customFiltersRecord);
        }
        continue;
      }

      const path = listPath(descriptor.filename);
      if (!(await IOUtils.exists(path))) {
        continue;
      }

      try {
        const text = await readText(path);
        if (text) {
          out.push({
            filename: descriptor.filename,
            text,
            url: descriptor.url,
          });
        }
      } catch (err) {
        console.warn(
          `[WaterfoxBlocker] Failed reading stored list ${descriptor.filename}:`,
          err
        );
      }
    }

    return out;
  },

  async readBundledLists(descriptors) {
    const records = [];
    for (const descriptor of descriptors) {
      if (!descriptor.bundledUrl) {
        continue;
      }

      try {
        const response = await fetch(descriptor.bundledUrl, {
          cache: "no-store",
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const text = await response.text();
        if (!text) {
          continue;
        }

        records.push({
          filename: descriptor.filename,
          text,
          url: descriptor.url,
        });
      } catch (err) {
        console.warn(
          `[WaterfoxBlocker] Failed to read bundled list: ${descriptor.bundledUrl}`,
          err
        );
      }
    }
    return records;
  },

  async persistListRecordsAndMetadata(listRecords, descriptors) {
    return withListWriteLock(async () => {
      await this.ensureListsDir();

      const recordByFilename = new Map();
      for (const record of listRecords) {
        if (record?.customFilters) {
          continue;
        }
        recordByFilename.set(record.filename, record);
        await writeText(listPath(record.filename), record.text);
      }

      const now = Date.now();
      const entries = [];

      for (const descriptor of descriptors) {
        if (descriptor?.customFilters) {
          continue;
        }
        const record = recordByFilename.get(descriptor.filename);
        if (!record) {
          continue;
        }

        entries.push({
          etag: "",
          filename: descriptor.filename,
          lastAttempt: now,
          lastError: "",
          lastFetched: now,
          lastModified: "",
          url: descriptor.url,
        });
      }

      await writeJSON(listsMetadataPath(), { lists: entries });
    });
  },

  async getCustomFiltersText() {
    return readCustomFiltersText();
  },

  async setCustomFiltersText(text, { alreadyNormalized = false } = {}) {
    const normalized = alreadyNormalized
      ? String(text ?? "")
      : normalizeCustomFiltersText(text);
    const path = customFiltersPath();

    await this.ensureRootDir();
    await IOUtils.writeUTF8(path, normalized, atomicWriteOptions(path));

    return {
      normalized,
      path,
    };
  },
};
