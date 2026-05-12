/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { CUSTOM_FILTERS_FILE_NAME } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

export const CUSTOM_FILTERS_DESCRIPTOR_URL = "waterfox://custom-filters";

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

export const ListCatalog = {
  customFiltersDescriptor,
  getCustomFilterListUrls,
  getEnabledListOverrides,
  isCatalogEntryEnabled,

  isCustomFiltersDescriptor(descriptor) {
    return !!descriptor?.customFilters;
  },

  hasNonCustomDescriptors(descriptors) {
    return descriptors.some(
      descriptor => !this.isCustomFiltersDescriptor(descriptor)
    );
  },

  hasNonCustomListRecords(listRecords) {
    return listRecords.some(record => !record.customFilters);
  },

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
          url: source.url,
        });
      }
    }

    const customUrls = getCustomFilterListUrls();
    for (let i = 0; i < customUrls.length; i++) {
      descriptors.push({
        bundledUrl: null,
        filename: `custom-${i + 1}.txt`,
        url: customUrls[i],
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
