/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CUSTOM_FILTERS_FILE_NAME } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

export const CUSTOM_FILTERS_DESCRIPTOR_URL = "waterfox://custom-filters";
export const LIST_DESCRIPTOR_ORIGIN_CATALOG = "catalog";
export const LIST_DESCRIPTOR_ORIGIN_CUSTOM = "custom";
export const LIST_DESCRIPTOR_ORIGIN_CUSTOM_FILTERS = "custom-filters";

const LIST_CATALOG_URL = "resource://waterfox/blocker/assets/list_catalog.json";
const BUNDLED_FILTERS_BASE = "resource://waterfox/blocker/assets/filters/";
const PREF_FILTER_LIST_URLS = "waterfox.blocker.filterListUrls";
const PREF_ENABLED_LISTS = "waterfox.blocker.enabledLists";

// Catalog data is immutable for the process, so a module cache is enough
// and we don't need a state object on the service.
let gCatalog = null;

function customFiltersDescriptor() {
  return {
    bundledUrl: null,
    customFilters: true,
    filename: CUSTOM_FILTERS_FILE_NAME,
    listOrigin: LIST_DESCRIPTOR_ORIGIN_CUSTOM_FILTERS,
    url: CUSTOM_FILTERS_DESCRIPTOR_URL,
  };
}

function getCustomFilterListUrls() {
  const raw = Services.prefs.getStringPref(PREF_FILTER_LIST_URLS, "");
  if (!raw) {
    return [];
  }

  let entries;
  try {
    const parsed = JSON.parse(raw);
    entries = Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    // Migration path for profiles that stored comma-separated URLs.
    entries = raw.split(",");
  }

  const urls = [];
  const seen = new Set();

  for (const entry of entries) {
    const value = String(entry || "").trim();
    if (!value) {
      continue;
    }

    let url;
    try {
      url = new URL(value);
    } catch (_) {
      // Ignore invalid stored URLs.
      continue;
    }

    if (url.protocol !== "https:") {
      continue;
    }

    const href = url.href;
    if (seen.has(href)) {
      continue;
    }

    seen.add(href);
    urls.push(href);
  }

  if (entries.length && !raw.trim().startsWith("[")) {
    try {
      Services.prefs.setStringPref(PREF_FILTER_LIST_URLS, JSON.stringify(urls));
    } catch (err) {
      console.warn(
        "[WaterfoxBlocker] Failed migrating custom list URL pref:",
        err
      );
    }
  }

  return urls;
}

function getEnabledListOverrides() {
  const raw = Services.prefs.getStringPref(PREF_ENABLED_LISTS, "{}");
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const overrides = {};
    for (const [id, enabled] of Object.entries(parsed)) {
      if (typeof enabled === "boolean") {
        overrides[id] = enabled;
      }
    }
    return overrides;
  } catch (_) {
    // Malformed pref values are treated as no overrides.
    return {};
  }
}

function isCatalogEntryEnabled(entry, userLocale, overrides = null) {
  let enabled = !!entry.default_enabled;

  if (!enabled && entry.category === "regional" && entry.langs?.length) {
    enabled = entry.langs.some(
      lang => String(lang).toLowerCase() === userLocale
    );
  }

  const activeOverrides = overrides || getEnabledListOverrides();
  if (Object.hasOwn(activeOverrides, String(entry.id))) {
    enabled = !!activeOverrides[entry.id];
  }

  return enabled;
}

function bytesToHex(binaryString) {
  let out = "";
  for (let i = 0; i < binaryString.length; i++) {
    out += `0${binaryString.charCodeAt(i).toString(16)}`.slice(-2);
  }
  return out;
}

function customListFilename(url) {
  const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hasher.init(hasher.SHA256);
  const bytes = new TextEncoder().encode(String(url));
  hasher.update(bytes, bytes.length);
  return `custom-${bytesToHex(hasher.finish(false))}.txt`;
}

function isLegacyCustomListFilename(filename) {
  return /^custom-[1-9]\d*\.txt$/.test(String(filename));
}

function listRecordKey(value) {
  const filename = String(value?.filename || "");
  const url = String(value?.url || "");
  return filename && url ? JSON.stringify([url, filename]) : "";
}

function isUsableListRecord(record) {
  return !!listRecordKey(record) && !!String(record?.text || "").trim();
}

function getMissingBundledListDescriptors(descriptors, listRecords) {
  const recordKeys = new Set(
    (listRecords || [])
      .filter(isUsableListRecord)
      .map(listRecordKey)
      .filter(Boolean)
  );
  return descriptors.filter(
    descriptor =>
      descriptor?.bundledUrl && !recordKeys.has(listRecordKey(descriptor))
  );
}

function hasAllBundledListRecords(descriptors, listRecords) {
  return !getMissingBundledListDescriptors(descriptors, listRecords).length;
}

function mergeListRecords(descriptors, ...recordSets) {
  const recordsByKey = new Map();
  for (const records of recordSets) {
    for (const record of records || []) {
      const key = listRecordKey(record);
      if (isUsableListRecord(record) && !recordsByKey.has(key)) {
        recordsByKey.set(key, record);
      }
    }
  }

  return descriptors
    .map(descriptor => recordsByKey.get(listRecordKey(descriptor)))
    .filter(Boolean);
}

export const ListCatalog = {
  customFiltersDescriptor,
  customListFilename,
  getCustomFilterListUrls,
  isLegacyCustomListFilename,
  getEnabledListOverrides,
  isCatalogEntryEnabled,

  isCatalogListDescriptor(descriptor) {
    return descriptor?.listOrigin === LIST_DESCRIPTOR_ORIGIN_CATALOG;
  },

  isCustomFiltersDescriptor(descriptor) {
    return !!descriptor?.customFilters;
  },

  isCustomListUrlDescriptor(descriptor) {
    return descriptor?.listOrigin === LIST_DESCRIPTOR_ORIGIN_CUSTOM;
  },

  getMissingBundledListDescriptors,
  hasAllBundledListRecords,
  mergeListRecords,

  async loadCatalog() {
    if (gCatalog) {
      return gCatalog;
    }

    const response = await fetch(LIST_CATALOG_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    gCatalog = await response.json();
    return gCatalog;
  },

  async getListDescriptors() {
    const catalog = await this.loadCatalog();
    const descriptors = [];
    const userLocale = (
      Services.locale.appLocaleAsBCP47?.split("-")[0] || ""
    ).toLowerCase();
    const overrides = getEnabledListOverrides();

    for (const entry of catalog) {
      if (!isCatalogEntryEnabled(entry, userLocale, overrides)) {
        continue;
      }

      for (const source of entry.sources || []) {
        if (!source?.url || !source?.filename) {
          continue;
        }

        descriptors.push({
          bundledUrl:
            entry.bundled === true
              ? BUNDLED_FILTERS_BASE + source.filename
              : null,
          filename: source.filename,
          listOrigin: LIST_DESCRIPTOR_ORIGIN_CATALOG,
          url: source.url,
        });
      }
    }

    const customUrls = getCustomFilterListUrls();
    for (const url of customUrls) {
      descriptors.push({
        bundledUrl: null,
        filename: customListFilename(url),
        listOrigin: LIST_DESCRIPTOR_ORIGIN_CUSTOM,
        url,
      });
    }

    descriptors.push(customFiltersDescriptor());

    return descriptors;
  },

  async getFilterListCatalog() {
    const catalog = await this.loadCatalog();
    const userLocale = (
      Services.locale.appLocaleAsBCP47?.split("-")[0] || ""
    ).toLowerCase();
    const overrides = getEnabledListOverrides();

    return catalog.map(entry => {
      const defaultEnabled = isCatalogEntryEnabled(entry, userLocale, {});
      return {
        ...entry,
        defaultEnabled,
        enabled: isCatalogEntryEnabled(entry, userLocale, overrides),
      };
    });
  },
};
