/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  CACHE_ROOT_DIR_NAME,
  CUSTOM_FILTERS_FILE_NAME,
  LISTS_DIR_NAME,
  LISTS_META_FILE_NAME,
} from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";
import { ListCatalog } from "resource:///modules/internal/ListCatalog.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";

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

function profilePath(...parts) {
  const file = Services.dirsvc.get("ProfD", Ci.nsIFile);
  file.append(CACHE_ROOT_DIR_NAME);
  for (const part of parts) {
    file.append(part);
  }
  return file.path;
}

function cacheRootPath() {
  return profilePath();
}

function customFiltersPath() {
  return profilePath(CUSTOM_FILTERS_FILE_NAME);
}

function listPath(filename) {
  return profilePath(LISTS_DIR_NAME, filename);
}

function listsDirPath() {
  return profilePath(LISTS_DIR_NAME);
}

function listsMetadataPath() {
  return profilePath(LISTS_DIR_NAME, LISTS_META_FILE_NAME);
}

function remoteResourceFilePath(name) {
  return profilePath(`remote-${name}.json`);
}

function remoteResourceMetaPath(name) {
  return profilePath(`remote-${name}.meta.json`);
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

function readLocalTextSync(uri, { maxBytes = Infinity, fatal = false } = {}) {
  const localUri = typeof uri === "string" ? Services.io.newURI(uri) : uri;
  if (!localUri.schemeIs("file") && !localUri.schemeIs("resource")) {
    throw new Error("Synchronous baseline reads must be local");
  }
  const stream = NetUtil.newChannel({
    uri: localUri,
    loadUsingSystemPrincipal: true,
  }).open();
  try {
    const length = stream.available();
    if (length > maxBytes) {
      throw new Error("Local baseline file is too large");
    }
    const binaryStream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
      Ci.nsIBinaryInputStream
    );
    binaryStream.setInputStream(stream);
    const bytes = new Uint8Array(length);
    if (binaryStream.readArrayBuffer(length, bytes.buffer) !== length) {
      throw new Error("Local baseline file could not be read completely");
    }
    return new TextDecoder("utf-8", { fatal }).decode(bytes);
  } finally {
    stream.close();
  }
}

function readTextSync(path, options) {
  const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
  file.initWithPath(path);
  return readLocalTextSync(Services.io.newFileURI(file), options);
}

function readJSONSync(path, fallbackValue) {
  try {
    return JSON.parse(readTextSync(path));
  } catch (err) {
    if (!isFileNotFoundError(err)) {
      console.warn(`[WaterfoxBlocker] Failed reading JSON ${path}:`, err);
    }
    return fallbackValue;
  }
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

function readCustomFiltersRecordSync(customDescriptor) {
  if (!customDescriptor?.customFilters) {
    return null;
  }
  try {
    const text = normalizeCustomFiltersText(
      readTextSync(customFiltersPath(), {
        maxBytes: MAX_CUSTOM_FILTERS_BYTES,
        fatal: true,
      })
    );
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
    if (!isFileNotFoundError(err)) {
      console.warn("[WaterfoxBlocker] Failed reading custom filters:", err);
    }
    return null;
  }
}

function readWaterfoxUnbreakRecordSync() {
  if (!gWaterfoxUnbreakRecord) {
    const text = readLocalTextSync(WATERFOX_UNBREAK_FILTERS_URL);
    if (!text.trim()) {
      throw new Error("Waterfox unbreak filters were empty");
    }
    gWaterfoxUnbreakRecord = {
      filename: WATERFOX_UNBREAK_FILTERS_FILE_NAME,
      text,
      url: WATERFOX_UNBREAK_FILTERS_URL,
    };
  }
  return gWaterfoxUnbreakRecord;
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

  profilePath,
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
  readTextSync,
  readLocalTextSync,
  writeText,
  readJSON,
  writeJSON,
  withListWriteLock,

  readCustomFiltersText,
  readCustomFiltersRecord,
  withWaterfoxUnbreakRecord,

  withWaterfoxUnbreakRecordSync(listRecords) {
    return [...listRecords, readWaterfoxUnbreakRecordSync()];
  },

  readStoredListsSync(descriptors) {
    const metadata = readJSONSync(this.listsMetadataPath(), { lists: [] });
    const metadataByUrl = new Map(
      (metadata?.lists || []).map(entry => [String(entry.url), entry])
    );
    const records = [];
    for (const descriptor of descriptors) {
      if (descriptor?.customFilters) {
        const record = readCustomFiltersRecordSync(descriptor);
        if (record) {
          records.push(record);
        }
        continue;
      }
      const filenames = [descriptor.filename];
      const previousFilename = String(
        metadataByUrl.get(String(descriptor.url))?.filename || ""
      );
      const hasLegacyCustomFilename =
        ListCatalog.isCustomListUrlDescriptor(descriptor) &&
        previousFilename !== descriptor.filename &&
        ListCatalog.isLegacyCustomListFilename(previousFilename);
      if (hasLegacyCustomFilename) {
        filenames.push(previousFilename);
      }
      for (const filename of filenames) {
        try {
          const text = this.readTextSync(this.listPath(filename));
          if (text.trim()) {
            const record = {
              filename: descriptor.filename,
              text,
              url: descriptor.url,
            };
            if (filename !== descriptor.filename) {
              record.previousFilename = filename;
            }
            if (hasLegacyCustomFilename) {
              record.unverified = true;
            }
            records.push(record);
            break;
          }
        } catch (err) {
          if (!isFileNotFoundError(err)) {
            console.warn(
              `[WaterfoxBlocker] Failed reading stored list ${filename}:`,
              err
            );
          }
        }
      }
    }
    return records;
  },

  readBundledListsSync(descriptors) {
    const records = [];
    for (const descriptor of descriptors) {
      if (!descriptor.bundledUrl) {
        continue;
      }
      try {
        const text = this.readLocalTextSync(descriptor.bundledUrl);
        if (text) {
          records.push({
            filename: descriptor.filename,
            text,
            url: descriptor.url,
          });
        }
      } catch (err) {
        console.warn(
          `[WaterfoxBlocker] Failed to read bundled list: ${descriptor.bundledUrl}`,
          err
        );
      }
    }
    return records;
  },

  resolveLocalListRecordsSync(descriptors) {
    const storedLists = this.readStoredListsSync(descriptors);
    const missing = ListCatalog.getMissingBundledListDescriptors(
      descriptors,
      storedLists
    );
    const bundledLists = missing.length
      ? this.readBundledListsSync(missing)
      : [];
    const listRecords = ListCatalog.mergeListRecords(
      descriptors,
      storedLists.filter(record => !record.unverified),
      bundledLists
    );
    return {
      complete: ListCatalog.hasAllBundledListRecords(descriptors, listRecords),
      listRecords,
    };
  },

  async readStoredLists(descriptors) {
    const metadata = await this.readJSON(this.listsMetadataPath(), {
      lists: [],
    });
    const metadataByUrl = new Map(
      (metadata?.lists || []).map(entry => [String(entry.url), entry])
    );
    const out = [];

    for (const descriptor of descriptors) {
      if (descriptor?.customFilters) {
        const customFiltersRecord = await readCustomFiltersRecord(descriptor);
        if (customFiltersRecord) {
          out.push(customFiltersRecord);
        }
        continue;
      }

      const filenames = [descriptor.filename];
      const previousFilename = String(
        metadataByUrl.get(String(descriptor.url))?.filename || ""
      );
      const hasLegacyCustomFilename =
        ListCatalog.isCustomListUrlDescriptor(descriptor) &&
        previousFilename !== descriptor.filename &&
        ListCatalog.isLegacyCustomListFilename(previousFilename);
      if (hasLegacyCustomFilename) {
        filenames.push(previousFilename);
      }

      for (const filename of filenames) {
        const path = this.listPath(filename);
        if (!(await IOUtils.exists(path))) {
          continue;
        }

        try {
          const text = await this.readText(path);
          if (text.trim()) {
            const record = {
              filename: descriptor.filename,
              text,
              url: descriptor.url,
            };
            if (filename !== descriptor.filename) {
              record.previousFilename = filename;
            }
            if (hasLegacyCustomFilename) {
              record.unverified = true;
            }
            out.push(record);
            break;
          }
        } catch (err) {
          console.warn(
            `[WaterfoxBlocker] Failed reading stored list ${filename}:`,
            err
          );
        }
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

  async resolveLocalListRecords(descriptors) {
    return withListWriteLock(async () => {
      const storedLists = await this.readStoredLists(descriptors);
      const missingBundledDescriptors =
        ListCatalog.getMissingBundledListDescriptors(descriptors, storedLists);
      const bundledLists = missingBundledDescriptors.length
        ? await this.readBundledLists(missingBundledDescriptors)
        : [];

      const recordsToWrite = bundledLists;
      if (recordsToWrite.length) {
        const replacementsByUrl = new Map(
          recordsToWrite.map(record => [String(record.url), record.filename])
        );
        const metadata = await this.readJSON(this.listsMetadataPath(), {
          lists: [],
        });
        let metadataChanged = false;
        const entries = (metadata?.lists || []).map(entry => {
          const filename = replacementsByUrl.get(String(entry.url));
          if (!filename) {
            return entry;
          }
          metadataChanged = true;
          return {
            ...entry,
            etag: "",
            filename,
            lastModified: "",
          };
        });
        if (metadataChanged) {
          await this.writeJSON(this.listsMetadataPath(), { lists: entries });
        }

        await this.ensureListsDir();
        for (const record of recordsToWrite) {
          await this.writeText(this.listPath(record.filename), record.text);
        }
      }

      const listRecords = ListCatalog.mergeListRecords(
        descriptors,
        storedLists.filter(record => !record.unverified),
        bundledLists
      );

      return {
        complete: ListCatalog.hasAllBundledListRecords(
          descriptors,
          listRecords
        ),
        listRecords,
      };
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
