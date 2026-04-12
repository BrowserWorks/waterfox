/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toSafeDomain } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
});

const CONTRACT_ID = "@waterfox.com/waterfox-blocker-engine;1";

// Prefs
const PREF_ENABLED = "waterfox.blocker.enabled";
const PREF_ALLOW_SEARCH_PARTNER_ADS = "waterfox.blocker.allowSearchPartnerAds";
const PREF_SITE_EXCEPTIONS = "waterfox.blocker.siteExceptions";
const PREF_NO_COSMETIC_FILTERING_SITES =
  "waterfox.blocker.noCosmeticFilteringSites";
const PREF_NO_REMOTE_FONTS_SITES = "waterfox.blocker.noRemoteFontsSites";
const PREF_NO_SCRIPTING_SITES = "waterfox.blocker.noScriptingSites";
const PREF_FILTER_LIST_URLS = "waterfox.blocker.filterListUrls";
const PREF_CUSTOM_RULES = "waterfox.blocker.customRules";
const PREF_ENABLED_LISTS = "waterfox.blocker.enabledLists";
const PREF_BRANCH = "waterfox.blocker.";

const SEARCH_PARTNER_DOMAINS = Object.freeze([
  "www.startpage.com",
  "search.waterfox.com",
]);

// Profile storage layout
const CACHE_ROOT_DIR_NAME = "waterfox-blocker";
const LISTS_DIR_NAME = "lists";
const ENGINE_CACHE_FILE_NAME = "adblock-engine.cache";
const CACHE_META_FILE_NAME = "cache-meta.json";
const LISTS_META_FILE_NAME = "metadata.json";

// Cache metadata version marker. Deserialisation failures still trigger automatic
// rebuild from text, but we retain this for diagnostics and future migrations.
const ADBLOCK_ENGINE_VERSION = "adblock-rust-ffi-v1";

// List update cadence.
const UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
const DEFAULT_LIST_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/*
 * Service design rationale:
 *
 * - Network interception is split by phase: request blocking runs in
 *   `http-on-modify-request`; an `nsIContentPolicy` check covers loads
 *   served from internal caches (image cache, prefetch cache) that never
 *   hit the network layer; and CSP directives are injected in
 *   `http-on-examine-response` and its cached/merged variants.
 *
 * - This mirrors Gecko, where `nsChannelClassifier` classifies requests
 *   and `nsHttpChannel` applies CSP from response headers.
 *
 * - Tracking of blocked counts follows the same model used by
 *   `TrackingDBService.sys.mjs`: counters keyed by browserId are stored in a
 *   bounded map, with observer notifications so the protections UI can update live.
 *
 * - Search partner bypass matching uses hostname exact/suffix matching against
 *   configured partner domains (for example, `search.waterfox.com` matches
 *   itself and its subdomains, but not sibling hosts like `www.waterfox.com`).
 */
const BLOCKED_COUNT_MAP_MAX_ENTRIES = 500;
const BLOCKED_COUNT_MAP_TRIM_TO_ENTRIES = 250;
const TOPIC_BLOCKED_COUNT_UPDATED = "WaterfoxBlocker:BlockedCountUpdated";
const TOPIC_BLOCKED_COUNTS_CLEARED = "WaterfoxBlocker:BlockedCountsCleared";
const TOPIC_HTTP_ON_MODIFY_REQUEST = "http-on-modify-request";
const TOPIC_HTTP_ON_EXAMINE_RESPONSE = "http-on-examine-response";
const TOPIC_HTTP_ON_EXAMINE_CACHED_RESPONSE = "http-on-examine-cached-response";
const TOPIC_HTTP_ON_EXAMINE_MERGED_RESPONSE = "http-on-examine-merged-response";
const TOPIC_PREF_CHANGED = "nsPref:changed";

// Packaged supplementary resources.
const SUPPLEMENTARY_RESOURCES_URL =
  "resource://waterfox/blocker/assets/resources/resources.json";
const BUNDLED_SCRIPTLET_RESOURCES_URL =
  "resource://waterfox/blocker/assets/resources/ubo-scriptlets.json";

// Packaged filter list catalog.
const LIST_CATALOG_URL = "resource://waterfox/blocker/assets/list_catalog.json";

// Base URL for bundled filter list fallbacks.
const BUNDLED_FILTERS_BASE = "resource://waterfox/blocker/assets/filters/";
const BLOCKED_PAGE_URL = "chrome://browser/content/blocker/blockedPage.xhtml";
const BLOCKED_PAGE_BYPASS_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BLOCKED_PAGE_BYPASS_TOKEN_MAX_ENTRIES = 250;

function bytesToHex(binaryString) {
  let out = "";
  for (let i = 0; i < binaryString.length; i++) {
    out += `0${binaryString.charCodeAt(i).toString(16)}`.slice(-2);
  }
  return out;
}

function hashStringHex(text) {
  const hasher = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  hasher.init(hasher.SHA256);

  const bytes = new TextEncoder().encode(String(text));
  hasher.update(bytes, bytes.length);

  return bytesToHex(hasher.finish(false));
}

function nowISO() {
  return new Date().toISOString();
}

function normalizeFilterListUrl(input) {
  const value = String(input || "").trim();
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.href;
    }
  } catch (_) {}

  try {
    const uri = Services.io.newURI(value);
    if (uri.schemeIs("http") || uri.schemeIs("https")) {
      return uri.spec;
    }
  } catch (_) {}

  return "";
}

/**
 * Sanitises an array of strings for safe passage through ACString XPConnect
 * params: drops non-strings, replaces lone surrogates, deduplicates, and
 * enforces length limits.
 */
function sanitizeStringList(input, maxItems, maxTokenLength = 1024) {
  if (!Array.isArray(input) || !input.length) {
    return [];
  }

  const out = [];
  const seen = new Set();

  for (const token of input) {
    if (typeof token !== "string") {
      continue;
    }

    const normalized = token.toWellFormed().trim();
    if (!normalized || normalized.length > maxTokenLength) {
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(normalized);

    if (out.length >= maxItems) {
      break;
    }
  }

  return out;
}

/**
 * Produces a JSON string containing only ASCII code points, so it can be
 * passed to an ACString XPCOM parameter without NS_ERROR_ILLEGAL_VALUE.
 */
function toAsciiSafeJson(value) {
  return JSON.stringify(value).replace(
    /[\u0080-\uFFFF]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

/**
 * Core blocker service. Owns the native engine, loads and refreshes filter
 * lists, intercepts network channels to block requests and apply CSP, and
 * tracks per-tab blocked counts for the protections UI.
 */
export const WaterfoxBlockerService = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIWaterfoxBlockerContentPolicyBridge",
  ]),

  _blockedCountByBrowserId: new Map(),
  _noCosmeticFilteringSitesCache: null,
  _noRemoteFontsSitesCache: null,
  _noScriptingSitesCache: null,
  _siteExceptionsCache: null,
  _pendingDocumentBypassTokens: new Map(),
  _sessionSiteExceptions: new Set(),
  _catalog: null,
  _engine: null,
  _engineInitialising: false,
  _initGeneration: 0,
  _initialized: false,
  _updateInProgress: false,
  _updateTimerId: null,
  __thirdPartyUtil: undefined,

  _cacheMetaPath() {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    f.append(CACHE_ROOT_DIR_NAME);
    f.append(CACHE_META_FILE_NAME);
    return f.path;
  },

  _cacheRootPath() {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    f.append(CACHE_ROOT_DIR_NAME);
    return f.path;
  },

  _clearBlockedCounts() {
    if (!this._blockedCountByBrowserId.size) {
      return;
    }

    this._blockedCountByBrowserId.clear();
    this._notifyBlockedCountsCleared();
  },

  _computeListsHash(descriptors, listRecords) {
    const byFilename = new Map(
      listRecords.map(record => [record.filename, record.text ?? ""])
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

      const content = byFilename.get(descriptor.filename) ?? "";
      const contentBytes = encoder.encode(content);
      hasher.update(contentBytes, contentBytes.length);

      const sep = encoder.encode("\n---\n");
      hasher.update(sep, sep.length);
    }

    const customRulesBytes = encoder.encode(
      `\ncustom-rules\n${this._getCustomRules().join("\n")}`
    );
    hasher.update(customRulesBytes, customRulesBytes.length);

    return bytesToHex(hasher.finish(false));
  },

  _createEngine() {
    return Cc[CONTRACT_ID].createInstance(Ci.nsIWaterfoxBlockerEngine);
  },

  _engineCachePath() {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    f.append(CACHE_ROOT_DIR_NAME);
    f.append(ENGINE_CACHE_FILE_NAME);
    return f.path;
  },

  /**
   * Synchronous fast path: reads the serialised engine cache from disk so
   * the engine is ready before the event loop processes any load requests.
   *
   * Uses blocking file I/O intentionally - the cache is small and the read
   * is effectively instant. Hash verification is skipped here; the async
   * `_initializeEngineIfNeeded` path and periodic updates handle staleness.
   */
  _tryInitFromCacheSync() {
    try {
      const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      file.initWithPath(this._engineCachePath());
      if (!file.exists() || file.fileSize === 0) {
        return;
      }

      const stream = Cc[
        "@mozilla.org/network/file-input-stream;1"
      ].createInstance(Ci.nsIFileInputStream);
      stream.init(file, 0x01 /* PR_RDONLY */, 0, 0);

      const binaryStream = Cc[
        "@mozilla.org/binaryinputstream;1"
      ].createInstance(Ci.nsIBinaryInputStream);
      binaryStream.setInputStream(stream);

      const cacheData = binaryStream.readByteArray(file.fileSize);
      stream.close();

      const engine = this._createEngine();
      engine.initFromCache(cacheData);
      this._engine = engine;
    } catch (_) {
      // Cache missing, corrupt, or incompatible - async path will handle it.
    }
  },

  async _fetchAndPersistLists(descriptors) {
    await IOUtils.makeDirectory(this._listsDirPath(), {
      createAncestors: true,
      ignoreExisting: true,
    });

    const records = [];
    const metadataEntries = [];
    const now = Date.now();

    for (const descriptor of descriptors) {
      try {
        const result = await this._fetchList(descriptor, null, false);
        if (!result.text) {
          continue;
        }

        await this._writeText(this._listPath(descriptor.filename), result.text);

        records.push({
          filename: descriptor.filename,
          text: result.text,
          url: descriptor.url,
        });

        metadataEntries.push({
          etag: result.etag || "",
          expiresAt: now + DEFAULT_LIST_TTL_MS,
          filename: descriptor.filename,
          lastFetched: now,
          lastModified: result.lastModified || "",
          url: descriptor.url,
        });
      } catch (err) {
        console.warn(
          `[WaterfoxBlocker] Failed to fetch list: ${descriptor.url}`,
          err
        );
      }
    }

    if (metadataEntries.length) {
      await this._writeJSON(this._listsMetadataPath(), {
        lists: metadataEntries,
      });
    }

    return records;
  },

  async _fetchList(descriptor, metadataEntry, conditional) {
    const headers = new Headers();

    if (conditional && metadataEntry?.etag) {
      headers.set("If-None-Match", metadataEntry.etag);
    }
    if (conditional && metadataEntry?.lastModified) {
      headers.set("If-Modified-Since", metadataEntry.lastModified);
    }

    const response = await fetch(descriptor.url, {
      cache: "no-store",
      headers,
    });

    if (response.status === 304) {
      return { notModified: true };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text || !text.trim()) {
      throw new Error("Fetched list was empty");
    }

    return {
      etag: response.headers.get("ETag") || "",
      lastModified: response.headers.get("Last-Modified") || "",
      notModified: false,
      text,
    };
  },

  _getCustomFilterListUrls() {
    const raw = Services.prefs.getStringPref(PREF_FILTER_LIST_URLS, "");
    if (!raw) {
      return [];
    }

    let values = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        values = parsed;
      }
    } catch (_) {}

    if (!values.length) {
      values = raw.split(/[,\n\r]+/);
    }

    const out = [];
    const seen = new Set();
    for (const value of values) {
      const url = normalizeFilterListUrl(value);
      if (!url || seen.has(url)) {
        continue;
      }

      seen.add(url);
      out.push(url);

      if (out.length >= 100) {
        break;
      }
    }

    return out;
  },

  _getCustomRules() {
    const raw = Services.prefs.getStringPref(PREF_CUSTOM_RULES, "");
    if (!raw) {
      return [];
    }

    const out = [];
    const seen = new Set();
    for (const line of raw.split(/\r?\n/)) {
      const rule = line.trim();
      if (
        !rule ||
        rule.startsWith("!") ||
        rule.startsWith("[") ||
        rule.length > 4096 ||
        seen.has(rule)
      ) {
        continue;
      }

      seen.add(rule);
      out.push(rule);

      if (out.length >= 10000) {
        break;
      }
    }

    return out;
  },

  _getEnabledListOverrides() {
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
      return {};
    }
  },

  _isCatalogEntryEnabled(entry, userLocale, overrides = null) {
    let enabled = !!entry.default_enabled;

    if (!enabled && entry.category === "regional" && entry.langs?.length) {
      enabled = entry.langs.some(
        lang => String(lang).toLowerCase() === userLocale
      );
    }

    const activeOverrides = overrides || this._getEnabledListOverrides();
    if (Object.hasOwn(activeOverrides, String(entry.id))) {
      enabled = !!activeOverrides[entry.id];
    }

    return enabled;
  },

  async _getListDescriptors() {
    const catalog = await this._loadCatalog();
    const descriptors = [];
    const userLocale = (
      Services.locale.appLocaleAsBCP47?.split("-")[0] || ""
    ).toLowerCase();
    const overrides = this._getEnabledListOverrides();

    for (const entry of catalog) {
      if (!this._isCatalogEntryEnabled(entry, userLocale, overrides)) {
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

    // Add custom user URLs from pref.
    const customUrls = this._getCustomFilterListUrls();
    for (const url of customUrls) {
      descriptors.push({
        bundledUrl: null,
        filename: `custom-${hashStringHex(url).slice(0, 24)}.txt`,
        url,
      });
    }

    return descriptors;
  },

  _getSiteExceptions() {
    if (this._siteExceptionsCache) {
      return this._siteExceptionsCache;
    }

    const raw = Services.prefs.getStringPref(PREF_SITE_EXCEPTIONS, "[]");
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this._siteExceptionsCache = [];
        return this._siteExceptionsCache;
      }
      this._siteExceptionsCache = parsed.map(toSafeDomain).filter(Boolean);
      return this._siteExceptionsCache;
    } catch (_) {
      this._siteExceptionsCache = [];
      return this._siteExceptionsCache;
    }
  },

  _getNoCosmeticFilteringSites() {
    if (this._noCosmeticFilteringSitesCache) {
      return this._noCosmeticFilteringSitesCache;
    }

    const raw = Services.prefs.getStringPref(
      PREF_NO_COSMETIC_FILTERING_SITES,
      "[]"
    );
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this._noCosmeticFilteringSitesCache = [];
        return this._noCosmeticFilteringSitesCache;
      }
      this._noCosmeticFilteringSitesCache = parsed
        .map(toSafeDomain)
        .filter(Boolean);
      return this._noCosmeticFilteringSitesCache;
    } catch (_) {
      this._noCosmeticFilteringSitesCache = [];
      return this._noCosmeticFilteringSitesCache;
    }
  },

  _getNoRemoteFontsSites() {
    if (this._noRemoteFontsSitesCache) {
      return this._noRemoteFontsSitesCache;
    }

    const raw = Services.prefs.getStringPref(PREF_NO_REMOTE_FONTS_SITES, "[]");
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this._noRemoteFontsSitesCache = [];
        return this._noRemoteFontsSitesCache;
      }
      this._noRemoteFontsSitesCache = parsed.map(toSafeDomain).filter(Boolean);
      return this._noRemoteFontsSitesCache;
    } catch (_) {
      this._noRemoteFontsSitesCache = [];
      return this._noRemoteFontsSitesCache;
    }
  },

  _getNoScriptingSites() {
    if (this._noScriptingSitesCache) {
      return this._noScriptingSitesCache;
    }

    const raw = Services.prefs.getStringPref(PREF_NO_SCRIPTING_SITES, "[]");
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this._noScriptingSitesCache = [];
        return this._noScriptingSitesCache;
      }
      this._noScriptingSitesCache = parsed.map(toSafeDomain).filter(Boolean);
      return this._noScriptingSitesCache;
    } catch (_) {
      this._noScriptingSitesCache = [];
      return this._noScriptingSitesCache;
    }
  },

  async _initEngineFromListRecords(listRecords) {
    const rules = [];
    for (const record of listRecords) {
      for (const line of String(record.text).split(/\r?\n/)) {
        const rule = line.trim();
        if (rule && !rule.startsWith("!") && !rule.startsWith("[")) {
          rules.push(rule);
        }
      }
    }

    rules.push(...this._getCustomRules());

    if (!rules.length) {
      throw new Error("Filter lists contained no valid rules");
    }

    const nextEngine = this._createEngine();
    nextEngine.initFromLists(rules);
    this._engine = nextEngine;
  },

  /**
   * Builds the engine from text list sources when initialisation from cache is
   * not available.
   *
   * Source order is:
   * 1) Stored profile lists
   * 2) Network fetch from configured descriptors
   * 3) Bundled fallback lists
   *
   * Each successful path rewrites the serialised engine cache.
   *
   * @param {Array<object>} descriptors
   * @param {string} descriptors[].url
   * @param {string} descriptors[].filename
   * @param {string|null} descriptors[].bundledUrl
   */
  async _initFromTextSourcesAndCache(descriptors, generation) {
    // 1) Stored profile lists
    const storedLists = await this._readStoredLists(descriptors);
    if (this._initGeneration !== generation) {
      return;
    }
    if (storedLists.length) {
      try {
        await this._initEngineFromListRecords(storedLists);
        await this._writeEngineCache(storedLists, descriptors);
        return;
      } catch (err) {
        console.warn(
          "[WaterfoxBlocker] Stored lists failed to load, trying network fetch:",
          err
        );
      }
    }

    // 2) Network fetch (upstream + custom URLs)
    const fetchedLists = await this._fetchAndPersistLists(descriptors);
    if (this._initGeneration !== generation) {
      return;
    }
    if (fetchedLists.length) {
      try {
        await this._initEngineFromListRecords(fetchedLists);
        await this._writeEngineCache(fetchedLists, descriptors);
        return;
      } catch (err) {
        // Fetched data may be invalid (HTML error pages, truncated
        // responses, etc.). Fall through to bundled lists.
        console.warn(
          "[WaterfoxBlocker] Fetched lists failed to load, falling back to bundled:",
          err
        );
      }
    }

    if (this._initGeneration !== generation) {
      return;
    }

    // 3) Bundled fallback
    const bundledLists = await this._readBundledLists(descriptors);
    if (this._initGeneration !== generation) {
      return;
    }
    if (!bundledLists.length && !this._getCustomRules().length) {
      throw new Error("No bundled filter lists available for fallback");
    }

    // Persist bundled fallback to profile so startup has a stable local source.
    if (bundledLists.length) {
      await this._persistListRecordsAndMetadata(
        bundledLists,
        descriptors,
        true /* forceImmediateRefresh */
      );
    }

    if (this._initGeneration !== generation) {
      return;
    }

    await this._initEngineFromListRecords(bundledLists);
    await this._writeEngineCache(bundledLists, descriptors);
  },

  /**
   * Lazily initialises the engine if enabled and not already loaded.
   *
   * Attempts startup from cache first, then falls back to initialisation from
   * text sources. Supplementary resources are awaited so scriptlets and
   * redirects are available on first page load.
   */
  async _initializeEngineIfNeeded() {
    if (this._engine) {
      // Engine already loaded from the synchronous cache path - just
      // pick up scriptlets and redirect resources.
      await this._loadResources();
      return;
    }

    // Capture generation so we can detect if the blocker was disabled (or
    // re-initialised) while we were awaiting async work.
    const generation = this._initGeneration;

    this._engineInitialising = true;
    try {
      const descriptors = await this._getListDescriptors();
      if (this._initGeneration !== generation) {
        return;
      }
      if (!descriptors.length && !this._getCustomRules().length) {
        this._engine = null;
        return;
      }

      let loadedFromCache = false;
      try {
        loadedFromCache = await this._tryInitFromCache(descriptors);
      } catch (e) {
        // File-not-found is expected on first run.
        if (e.result !== Cr.NS_ERROR_FILE_NOT_FOUND) {
          console.error("[WaterfoxBlocker] Unexpected cache error:", e);
        }
      }

      if (this._initGeneration !== generation) {
        return;
      }

      if (!loadedFromCache) {
        await this._initFromTextSourcesAndCache(descriptors, generation);
      }

      if (this._initGeneration !== generation) {
        return;
      }

      await this._loadResources();
    } finally {
      this._engineInitialising = false;
    }
  },

  _listPath(filename) {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    f.append(CACHE_ROOT_DIR_NAME);
    f.append(LISTS_DIR_NAME);
    f.append(filename);
    return f.path;
  },

  _listsDirPath() {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    f.append(CACHE_ROOT_DIR_NAME);
    f.append(LISTS_DIR_NAME);
    return f.path;
  },

  _listsMetadataPath() {
    const f = Services.dirsvc.get("ProfD", Ci.nsIFile);
    f.append(CACHE_ROOT_DIR_NAME);
    f.append(LISTS_DIR_NAME);
    f.append(LISTS_META_FILE_NAME);
    return f.path;
  },

  async _loadBundledScriptletResources() {
    try {
      let response = await fetch(BUNDLED_SCRIPTLET_RESOURCES_URL, {
        cache: "no-store",
      });
      if (!response.ok) {
        return [];
      }

      let resources = JSON.parse(await response.text());
      return Array.isArray(resources) ? resources : [];
    } catch (err) {
      console.warn(
        "[WaterfoxBlocker] Failed to load bundled scriptlet resources:",
        err
      );
      return [];
    }
  },

  async _loadCatalog() {
    if (this._catalog) {
      return this._catalog;
    }

    const response = await fetch(LIST_CATALOG_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    this._catalog = await response.json();
    return this._catalog;
  },

  /**
   * Loads supplementary resources and bundled scriptlet resources, then pushes
   * the combined set into the native engine.
   *
   * `useResources` replaces resources wholesale, so this method always merges
   * all currently available resource sources into one payload.
   */
  async _loadResources() {
    if (!this._engine) {
      return;
    }

    const allResources = [];
    const supplementaryResources = await this._loadSupplementaryResources();
    if (supplementaryResources.length) {
      allResources.push(...supplementaryResources);
    }

    let scriptlets = await this._loadBundledScriptletResources();
    if (scriptlets.length) {
      allResources.push(...scriptlets);
    }

    if (allResources.length) {
      this.useResources(allResources);
    }
  },

  async _loadSupplementaryResources() {
    try {
      const response = await fetch(SUPPLEMENTARY_RESOURCES_URL, {
        cache: "no-store",
      });
      if (!response.ok) {
        return [];
      }

      const supplementary = JSON.parse(await response.text());
      if (Array.isArray(supplementary)) {
        return supplementary;
      }
    } catch (err) {
      console.warn(
        "[WaterfoxBlocker] Failed to load supplementary resources:",
        err
      );
    }

    return [];
  },

  _mapContentPolicyType(contentPolicyType) {
    switch (contentPolicyType) {
      case Ci.nsIContentPolicy.TYPE_DOCUMENT:
        return "document";
      case Ci.nsIContentPolicy.TYPE_SUBDOCUMENT:
        return "subdocument";
      case Ci.nsIContentPolicy.TYPE_STYLESHEET:
        return "stylesheet";
      case Ci.nsIContentPolicy.TYPE_SCRIPT:
        return "script";
      case Ci.nsIContentPolicy.TYPE_IMAGE:
      case Ci.nsIContentPolicy.TYPE_IMAGESET:
        return "image";
      case Ci.nsIContentPolicy.TYPE_MEDIA:
        return "media";
      case Ci.nsIContentPolicy.TYPE_FONT:
        return "font";
      case Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST:
        return "xmlhttprequest";
      case Ci.nsIContentPolicy.TYPE_WEBSOCKET:
        return "websocket";
      case Ci.nsIContentPolicy.TYPE_PING:
      case Ci.nsIContentPolicy.TYPE_BEACON:
        return "ping";
      case Ci.nsIContentPolicy.TYPE_CSP_REPORT:
        return "csp_report";
      case Ci.nsIContentPolicy.TYPE_OBJECT:
        return "object";
      default:
        return "other";
    }
  },

  _notifyBlockedCountsCleared() {
    try {
      Services.obs.notifyObservers(null, TOPIC_BLOCKED_COUNTS_CLEARED);
    } catch (_) {}
  },

  _notifyBlockedCountUpdated(browserId, blockedCount) {
    try {
      Services.obs.notifyObservers(
        {
          wrappedJSObject: {
            blockedCount,
            browserId,
          },
        },
        TOPIC_BLOCKED_COUNT_UPDATED
      );
    } catch (_) {}
  },

  _buildBlockedPageUrl(url, result, browserId, hostname) {
    const params = new URLSearchParams();
    params.set("url", String(url || ""));

    const matchedRule = this._extractMatchedRule(result);
    if (matchedRule) {
      params.set("rule", matchedRule);
    }

    const token = this._issueDocumentBypassToken(url, hostname, browserId);
    if (token) {
      params.set("token", token);
    }

    return `${BLOCKED_PAGE_URL}?${params.toString()}`;
  },

  _consumeDocumentBypassToken(loadInfo, url, hostname) {
    const loadingPrincipalUri = loadInfo.loadingPrincipal?.URI;
    if (!loadingPrincipalUri) {
      return false;
    }

    let principalSpec = "";
    try {
      if (!loadingPrincipalUri.schemeIs("chrome")) {
        return false;
      }
      principalSpec = loadingPrincipalUri.spec || "";
    } catch (_) {
      return false;
    }

    if (!principalSpec.startsWith(`${BLOCKED_PAGE_URL}?`)) {
      return false;
    }

    let token = "";
    try {
      token = new URL(principalSpec).searchParams.get("token") || "";
    } catch (_) {
      try {
        token = new URLSearchParams(loadingPrincipalUri.query || "").get(
          "token"
        );
      } catch (_e) {}
    }

    if (!token) {
      return false;
    }

    this._pruneDocumentBypassTokens();

    const entry = this._pendingDocumentBypassTokens.get(token);
    this._pendingDocumentBypassTokens.delete(token);
    if (!entry) {
      return false;
    }

    const normalizedHostname = toSafeDomain(hostname);
    if (!normalizedHostname || normalizedHostname !== entry.hostname) {
      return false;
    }

    const browserId = loadInfo.browsingContext?.top?.browserId || 0;
    if (entry.browserId && browserId && entry.browserId !== browserId) {
      return false;
    }

    if (entry.url && entry.url !== url) {
      return false;
    }

    this.addTemporarySiteException(normalizedHostname);
    return true;
  },

  _extractMatchedRule(result) {
    if (!result || typeof result !== "object") {
      return "";
    }

    for (const key of ["rule", "matchedRule", "filter", "rawFilter"]) {
      const value = result[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }

    return "";
  },

  _getPolicyHostForLoadInfo(loadInfo, fallbackHost = "") {
    const candidates = [
      this._getPrincipalHost(loadInfo?.loadingPrincipal),
      this._getPrincipalHost(loadInfo?.triggeringPrincipal),
      toSafeDomain(fallbackHost),
    ];

    for (const candidate of candidates) {
      const normalized = toSafeDomain(candidate);
      if (normalized) {
        return normalized;
      }
    }

    return "";
  },

  _getSiteSwitchBlockReason(policyHost, requestType) {
    if (!policyHost) {
      return "";
    }

    if (requestType === "font" && this.isRemoteFontsDisabled(policyHost)) {
      return "no-remote-fonts";
    }

    if (requestType === "script" && this.isScriptingDisabled(policyHost)) {
      return "no-scripting";
    }

    return "";
  },

  _getSiteSwitchCspDirectives(hostname) {
    const policyHost = toSafeDomain(hostname);
    if (!policyHost || !this.isScriptingDisabled(policyHost)) {
      return "";
    }

    return "script-src 'none'";
  },

  _hasTemporarySiteException(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized || !this._sessionSiteExceptions.size) {
      return false;
    }

    for (const exceptionDomain of this._sessionSiteExceptions) {
      if (
        normalized === exceptionDomain ||
        normalized.endsWith(`.${exceptionDomain}`)
      ) {
        return true;
      }
    }

    return false;
  },

  _issueDocumentBypassToken(url, hostname, browserId) {
    const normalizedHostname = toSafeDomain(hostname);
    if (!normalizedHostname || !url) {
      return "";
    }

    this._pruneDocumentBypassTokens();

    const token = Services.uuid.generateUUID().toString().replace(/[{}]/g, "");

    this._pendingDocumentBypassTokens.set(token, {
      browserId: browserId || 0,
      createdAt: Date.now(),
      hostname: normalizedHostname,
      url: String(url),
    });

    return token;
  },

  _pruneDocumentBypassTokens(now = Date.now()) {
    for (const [token, entry] of this._pendingDocumentBypassTokens) {
      if (
        !entry?.createdAt ||
        now - entry.createdAt > BLOCKED_PAGE_BYPASS_TOKEN_TTL_MS
      ) {
        this._pendingDocumentBypassTokens.delete(token);
      }
    }

    if (
      this._pendingDocumentBypassTokens.size <=
      BLOCKED_PAGE_BYPASS_TOKEN_MAX_ENTRIES
    ) {
      return;
    }

    let removeCount =
      this._pendingDocumentBypassTokens.size -
      BLOCKED_PAGE_BYPASS_TOKEN_MAX_ENTRIES;
    for (const token of this._pendingDocumentBypassTokens.keys()) {
      this._pendingDocumentBypassTokens.delete(token);
      removeCount--;
      if (removeCount <= 0) {
        break;
      }
    }
  },

  _getPrincipalHost(principal) {
    const uri = principal?.URI;
    if (!uri) {
      return "";
    }

    try {
      return uri.host || "";
    } catch (_) {
      return "";
    }
  },

  _isThirdPartyChannel(channel) {
    const thirdPartyUtil = this._thirdPartyUtil;
    if (!thirdPartyUtil) {
      return true;
    }

    try {
      return thirdPartyUtil.isThirdPartyChannel(channel);
    } catch (_) {
      return true;
    }
  },

  _isThirdPartyLoadInfo(loadInfo) {
    if (!loadInfo) {
      return true;
    }

    try {
      return !!(
        loadInfo.isThirdPartyContextToTopWindow ||
        loadInfo.isInThirdPartyContext
      );
    } catch (_) {
      return true;
    }
  },

  _handleTopLevelDocumentRequest(
    channel,
    loadInfo,
    url,
    sourceHostname,
    hostname
  ) {
    const browserId = loadInfo.browsingContext?.top?.browserId || 0;

    if (this._consumeDocumentBypassToken(loadInfo, url, hostname)) {
      return;
    }

    const triggeringDomain = this._getPrincipalHost(
      loadInfo.triggeringPrincipal
    );
    if (triggeringDomain && this.shouldBypassBlocking(triggeringDomain)) {
      return;
    }

    if (this.shouldBypassBlocking(hostname)) {
      return;
    }

    const result = this.checkRequest(
      url,
      sourceHostname,
      hostname,
      "document",
      this._isThirdPartyChannel(channel)
    );
    if (!result.matched || result.exception) {
      return;
    }

    try {
      const blockedPageUrl = this._buildBlockedPageUrl(
        url,
        result,
        browserId,
        hostname
      );
      channel.redirectTo(Services.io.newURI(blockedPageUrl));
    } catch (err) {
      console.error(
        "[WaterfoxBlocker] Failed to redirect to blocked page:",
        err
      );
      channel.cancel(Cr.NS_ERROR_ABORT);
    }

    try {
      if (browserId) {
        this.incrementBlockedCount(browserId);
      }
    } catch (_) {}
  },

  /**
   * Observer callback for `http-on-modify-request`.
   *
   * Redirects blocked top level documents to the blocked page, runs bypass
   * checks, and cancels matched subresource requests. Loads from internal
   * caches are handled separately by the content-policy `shouldLoad` bridge.
   *
   * @param {nsISupports} subject Observer subject expected to QI to `nsIHttpChannel`.
   */
  _onModifyRequest(subject) {
    if (!this._engine) {
      return;
    }

    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch (_) {
      return;
    }

    const uri = channel.URI;
    if (!uri || (!uri.schemeIs("http") && !uri.schemeIs("https"))) {
      return;
    }

    const loadInfo = channel.loadInfo;
    if (!loadInfo) {
      return;
    }

    const requestType = this._mapContentPolicyType(
      loadInfo.externalContentPolicyType
    );
    const url = uri.spec;

    let hostname = "";
    try {
      hostname = uri.host || "";
    } catch (_) {}

    if (requestType === "document" && loadInfo.isTopLevelLoad) {
      this._handleTopLevelDocumentRequest(
        channel,
        loadInfo,
        url,
        this._getPrincipalHost(loadInfo.loadingPrincipal),
        hostname
      );
      return;
    }

    const triggeringDomain = this._getPrincipalHost(
      loadInfo.triggeringPrincipal
    );
    if (triggeringDomain && this.shouldBypassBlocking(triggeringDomain)) {
      return;
    }

    const sourceHostname = this._getPrincipalHost(loadInfo.loadingPrincipal);
    const thirdParty = this._isThirdPartyChannel(channel);
    const browserId = loadInfo.browsingContext?.top?.browserId || 0;
    const policyHost = this._getPolicyHostForLoadInfo(loadInfo, sourceHostname);
    const siteSwitchReason = this._getSiteSwitchBlockReason(
      policyHost,
      requestType
    );

    if (siteSwitchReason) {
      channel.cancel(Cr.NS_ERROR_ABORT);
      try {
        if (browserId) {
          this.incrementBlockedCount(browserId);
        }
      } catch (_) {}
      return;
    }

    const result = this.checkRequest(
      url,
      sourceHostname,
      hostname,
      requestType,
      thirdParty
    );

    if (result.matched && !result.exception) {
      if (result.redirect) {
        // TODO: Apply `result.redirect` (a data: URL stub) via a synthetic
        // response instead of canceling, so redirect rules return a payload.
      }
      channel.cancel(Cr.NS_ERROR_ABORT);

      try {
        if (browserId) {
          this.incrementBlockedCount(browserId);
        }
      } catch (_) {}
    }
  },

  /**
   * Observer callback for examine-response topics.
   *
   * Computes `$csp` directives for document and subdocument channels and
   * appends them to the response's `Content-Security-Policy` header.
   *
   * @param {nsISupports} subject Channel from the observer notification.
   */
  _onExamineResponse(subject) {
    if (!this._engine) {
      return;
    }

    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch (_) {
      return;
    }

    const uri = channel.URI;
    if (!uri || (!uri.schemeIs("http") && !uri.schemeIs("https"))) {
      return;
    }

    const loadInfo = channel.loadInfo;
    if (!loadInfo) {
      return;
    }

    const requestType = this._mapContentPolicyType(
      loadInfo.externalContentPolicyType
    );
    if (requestType !== "document" && requestType !== "subdocument") {
      return;
    }

    const url = uri.spec;

    let hostname = "";
    try {
      hostname = uri.host || "";
    } catch (_) {
      // `uri.host` throws for URIs without an authority component (e.g.
      // about: pages), which is expected. Keep the empty-string default.
    }

    const triggeringDomain = this._getPrincipalHost(
      loadInfo.triggeringPrincipal
    );
    if (triggeringDomain && this.shouldBypassBlocking(triggeringDomain)) {
      return;
    }

    if (this.shouldBypassBlocking(hostname)) {
      return;
    }

    const engineDirectives = this.getCspDirectives(
      url,
      this._getPrincipalHost(loadInfo.loadingPrincipal),
      hostname,
      requestType,
      this._isThirdPartyChannel(channel)
    );
    const switchDirectives = this._getSiteSwitchCspDirectives(hostname);
    const directives = [engineDirectives, switchDirectives]
      .filter(Boolean)
      .join("; ");

    if (!directives) {
      return;
    }

    try {
      channel.setResponseHeader("Content-Security-Policy", directives, true);
    } catch (err) {
      console.error("[WaterfoxBlocker] Failed to apply CSP directives:", err);
    }
  },

  async _persistListRecordsAndMetadata(
    listRecords,
    descriptors,
    forceImmediateRefresh = false
  ) {
    await IOUtils.makeDirectory(this._listsDirPath(), {
      createAncestors: true,
      ignoreExisting: true,
    });

    const recordByFilename = new Map();
    for (const record of listRecords) {
      recordByFilename.set(record.filename, record);
      await this._writeText(this._listPath(record.filename), record.text);
    }

    const now = Date.now();
    const entries = [];

    for (const descriptor of descriptors) {
      const record = recordByFilename.get(descriptor.filename);
      if (!record) {
        continue;
      }

      entries.push({
        etag: "",
        expiresAt: forceImmediateRefresh ? 0 : now + DEFAULT_LIST_TTL_MS,
        filename: descriptor.filename,
        lastFetched: now,
        lastModified: "",
        url: descriptor.url,
      });
    }

    await this._writeJSON(this._listsMetadataPath(), { lists: entries });
  },

  async _readBundledLists(descriptors) {
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

  async _readJSON(path, fallbackValue) {
    try {
      const text = await this._readText(path);
      return JSON.parse(text);
    } catch (err) {
      if (err?.result !== Cr.NS_ERROR_FILE_NOT_FOUND) {
        console.warn(`[WaterfoxBlocker] Failed reading JSON ${path}:`, err);
      }
      return fallbackValue;
    }
  },

  async _readStoredLists(descriptors) {
    const out = [];
    for (const descriptor of descriptors) {
      const path = this._listPath(descriptor.filename);
      if (!(await IOUtils.exists(path))) {
        continue;
      }

      try {
        const text = await this._readText(path);
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

  async _readText(path) {
    const bytes = await IOUtils.read(path);
    return new TextDecoder().decode(bytes);
  },

  async _refreshListsAndEngine() {
    await this._updateListsIfNeeded(true /* forceAll */);

    // If update pass didn’t rebuild, ensure engine exists.
    if (!this._engine) {
      await this._initializeEngineIfNeeded();
    }
  },

  _setSiteExceptions(exceptions) {
    this._siteExceptionsCache = null;
    const deduped = [...new Set(exceptions.map(toSafeDomain).filter(Boolean))];
    Services.prefs.setStringPref(PREF_SITE_EXCEPTIONS, JSON.stringify(deduped));
  },

  _setNoCosmeticFilteringSites(domains) {
    this._noCosmeticFilteringSitesCache = null;
    const deduped = [...new Set(domains.map(toSafeDomain).filter(Boolean))];
    Services.prefs.setStringPref(
      PREF_NO_COSMETIC_FILTERING_SITES,
      JSON.stringify(deduped)
    );
  },

  _setNoRemoteFontsSites(domains) {
    this._noRemoteFontsSitesCache = null;
    const deduped = [...new Set(domains.map(toSafeDomain).filter(Boolean))];
    Services.prefs.setStringPref(
      PREF_NO_REMOTE_FONTS_SITES,
      JSON.stringify(deduped)
    );
  },

  _setNoScriptingSites(domains) {
    this._noScriptingSitesCache = null;
    const deduped = [...new Set(domains.map(toSafeDomain).filter(Boolean))];
    Services.prefs.setStringPref(
      PREF_NO_SCRIPTING_SITES,
      JSON.stringify(deduped)
    );
  },

  _startPeriodicListUpdates() {
    if (this._updateTimerId) {
      return;
    }

    this._updateTimerId = lazy.setInterval(() => {
      this._updateListsIfNeeded().catch(err => {
        console.warn("[WaterfoxBlocker] Periodic list update failed:", err);
      });
    }, UPDATE_INTERVAL_MS);
  },

  _stopPeriodicListUpdates() {
    if (!this._updateTimerId) {
      return;
    }
    lazy.clearInterval(this._updateTimerId);
    this._updateTimerId = null;
  },

  get _thirdPartyUtil() {
    if (this.__thirdPartyUtil === undefined) {
      try {
        this.__thirdPartyUtil = Cc["@mozilla.org/thirdpartyutil;1"].getService(
          Ci.mozIThirdPartyUtil
        );
      } catch (_) {
        this.__thirdPartyUtil = null;
      }
    }
    return this.__thirdPartyUtil;
  },

  _trimBlockedCountMapIfNeeded() {
    if (this._blockedCountByBrowserId.size <= BLOCKED_COUNT_MAP_MAX_ENTRIES) {
      return;
    }

    let removeCount =
      this._blockedCountByBrowserId.size - BLOCKED_COUNT_MAP_TRIM_TO_ENTRIES;
    for (const browserId of this._blockedCountByBrowserId.keys()) {
      this._blockedCountByBrowserId.delete(browserId);
      removeCount--;
      if (removeCount <= 0) {
        break;
      }
    }
  },

  async _tryInitFromCache(descriptors) {
    if (!(await IOUtils.exists(this._engineCachePath()))) {
      return false;
    }
    if (!(await IOUtils.exists(this._cacheMetaPath()))) {
      return false;
    }

    const storedLists = await this._readStoredLists(descriptors);
    if (!storedLists.length) {
      return false;
    }

    const cacheMeta = await this._readJSON(this._cacheMetaPath(), null);
    if (!cacheMeta?.listsHash) {
      return false;
    }

    const currentHash = this._computeListsHash(descriptors, storedLists);
    if (currentHash !== cacheMeta.listsHash) {
      return false;
    }

    const cacheData = await IOUtils.read(this._engineCachePath());
    const candidate = this._createEngine();
    candidate.initFromCache(cacheData);
    this._engine = candidate;
    return true;
  },

  /**
   * Performs conditional list refresh and engine rebuild.
   *
   * Reads list metadata, revalidates expired entries, persists updated list
   * files, and rebuilds/reloads the engine only when list content changed.
   *
   * @param {boolean} [forceAll=false] Force refresh checks for all descriptors.
   */
  async _updateListsIfNeeded(forceAll = false) {
    if (this._updateInProgress) {
      return;
    }

    this._updateInProgress = true;
    try {
      const descriptors = await this._getListDescriptors();

      await IOUtils.makeDirectory(this._listsDirPath(), {
        createAncestors: true,
        ignoreExisting: true,
      });

      const meta = await this._readJSON(this._listsMetadataPath(), {
        lists: [],
      });
      const oldByUrl = new Map(
        (meta?.lists || []).map(entry => [String(entry.url), entry])
      );

      const now = Date.now();
      let metadataChanged = false;
      let anyUpdated = false;
      const nextEntries = [];

      for (const descriptor of descriptors) {
        const oldEntry = oldByUrl.get(descriptor.url) || null;
        const listPath = this._listPath(descriptor.filename);
        const hasLocalFile = await IOUtils.exists(listPath);

        const expiresAt = Number(oldEntry?.expiresAt || 0);
        const isExpired =
          forceAll || !hasLocalFile || !expiresAt || now >= expiresAt;

        const nextEntry = oldEntry
          ? { ...oldEntry, filename: descriptor.filename, url: descriptor.url }
          : {
              etag: "",
              expiresAt: 0,
              filename: descriptor.filename,
              lastFetched: 0,
              lastModified: "",
              url: descriptor.url,
            };

        if (isExpired) {
          try {
            const result = await this._fetchList(descriptor, oldEntry, true);

            if (result.notModified) {
              nextEntry.lastFetched = now;
              nextEntry.expiresAt = now + DEFAULT_LIST_TTL_MS;
              metadataChanged = true;
            } else if (result.text) {
              await this._writeText(listPath, result.text);
              nextEntry.lastFetched = now;
              nextEntry.expiresAt = now + DEFAULT_LIST_TTL_MS;
              nextEntry.etag = result.etag || "";
              nextEntry.lastModified = result.lastModified || "";
              metadataChanged = true;
              anyUpdated = true;
            }
          } catch (err) {
            console.warn(
              `[WaterfoxBlocker] Failed to update list: ${descriptor.url}`,
              err
            );
          }
        }

        // Preserve working state if fetch failed.
        if (await IOUtils.exists(listPath)) {
          nextEntries.push(nextEntry);
        }
      }

      if (metadataChanged) {
        await this._writeJSON(this._listsMetadataPath(), {
          lists: nextEntries,
        });
      }

      if (anyUpdated) {
        const storedLists = await this._readStoredLists(descriptors);
        if (storedLists.length) {
          await this._initEngineFromListRecords(storedLists);
          await this._loadResources();
          await this._writeEngineCache(storedLists, descriptors);
        }
      } else if (this._engine) {
        await this._loadResources();
      }
    } finally {
      this._updateInProgress = false;
    }
  },

  async _writeEngineCache(listRecords, descriptors) {
    if (!this._engine) {
      return;
    }

    await IOUtils.makeDirectory(this._cacheRootPath(), {
      createAncestors: true,
      ignoreExisting: true,
    });

    const serialized = this._engine.serialize();
    const bytes =
      serialized instanceof Uint8Array
        ? serialized
        : new Uint8Array(serialized);
    await IOUtils.write(this._engineCachePath(), bytes);

    const listsHash = this._computeListsHash(descriptors, listRecords);
    await this._writeJSON(this._cacheMetaPath(), {
      adblockVersion: ADBLOCK_ENGINE_VERSION,
      createdAt: nowISO(),
      listsHash,
    });
  },

  async _writeJSON(path, value) {
    await this._writeText(path, JSON.stringify(value));
  },

  async _writeText(path, text) {
    const bytes = new TextEncoder().encode(String(text));
    await IOUtils.write(path, bytes);
  },

  /**
   * Adds a site exception for the current session that is used when the blocked
   * page lets a load continue.
   *
   * This exception is kept in memory only and is not saved to prefs.
   *
   * @param {string} domain
   */
  addTemporarySiteException(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return;
    }

    this._sessionSiteExceptions.add(normalized);
  },

  /**
   * Adds a saved site exception for the given domain.
   *
   * @param {string} domain
   */
  addSiteException(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return;
    }

    const exceptions = this._getSiteExceptions();
    if (!exceptions.includes(normalized)) {
      exceptions.push(normalized);
      this._setSiteExceptions(exceptions);
    }
  },

  _normalizeCheckResult(rawResult) {
    const normalized = {
      exception: false,
      important: false,
      matched: false,
      redirect: "",
      rewrittenUrl: "",
    };

    if (!rawResult || typeof rawResult !== "object") {
      return normalized;
    }

    normalized.matched = !!rawResult.matched;
    normalized.important = !!rawResult.important;
    normalized.exception = !!rawResult.exception;

    if (typeof rawResult.redirect === "string") {
      normalized.redirect = rawResult.redirect;
    }

    if (typeof rawResult.rewrittenUrl === "string") {
      normalized.rewrittenUrl = rawResult.rewrittenUrl;
    }

    return normalized;
  },

  /**
   * Checks one network request against the active blocker engine.
   *
   * @param {string} url Request URL.
   * @param {string} sourceHostname Full source hostname.
   * @param {string} hostname Full request hostname.
   * @param {string} requestType adblock-rs request type string.
   * @param {boolean} isThirdParty Whether the request is third party.
   * @returns {{matched: boolean, important: boolean, exception: boolean, redirect: string, rewrittenUrl: string}}
   *          Normalised match result.
   */
  checkRequest(url, sourceHostname, hostname, requestType, isThirdParty) {
    if (!this._engine) {
      return this._normalizeCheckResult(null);
    }

    try {
      // IDL method order:
      // url, sourceHostname, hostname, requestType, isThirdParty
      const json = this._engine.checkRequestDetailed(
        url,
        sourceHostname,
        hostname,
        requestType,
        !!isThirdParty
      );
      return this._normalizeCheckResult(JSON.parse(json));
    } catch (err) {
      console.error("[WaterfoxBlocker] checkRequest failed:", err);
      return this._normalizeCheckResult(null);
    }
  },

  getBlockedCount(browserId) {
    return this._blockedCountByBrowserId.get(browserId) || 0;
  },

  /**
   * Resets and publishes blocked count for a browser id.
   *
   * @param {number} browserId
   * @returns {number} Updated blocked count.
   */
  resetBlockedCount(browserId) {
    const id = Number(browserId || 0);
    if (!id) {
      return 0;
    }

    this._blockedCountByBrowserId.set(id, 0);
    this._notifyBlockedCountUpdated(id, 0);
    return 0;
  },

  /**
   * Returns cosmetic resources for a page URL.
   *
   * @param {string} url
   * @returns {object} Parsed cosmetic resource payload from the native engine.
   */
  getCosmeticResources(url) {
    if (!this._engine) {
      return {};
    }

    try {
      return JSON.parse(this._engine.getCosmeticResources(url));
    } catch (err) {
      console.error("[WaterfoxBlocker] getCosmeticResources failed:", err);
      return {};
    }
  },

  /**
   * Returns CSP directives for a document/subdocument request context.
   *
   * @param {string} url
   * @param {string} sourceHostname
   * @param {string} hostname
   * @param {string} requestType
   * @param {boolean} isThirdParty
   * @returns {string} Directive string, or an empty string when none apply.
   */
  getCspDirectives(url, sourceHostname, hostname, requestType, isThirdParty) {
    if (!this._engine) {
      return "";
    }

    if (requestType !== "document" && requestType !== "subdocument") {
      return "";
    }

    try {
      if (typeof this._engine.getCspDirectives !== "function") {
        return "";
      }

      return (
        this._engine.getCspDirectives(
          url,
          sourceHostname,
          hostname,
          requestType,
          !!isThirdParty
        ) || ""
      );
    } catch (err) {
      console.error("[WaterfoxBlocker] getCspDirectives failed:", err);
      return "";
    }
  },

  /**
   * Loads the filter list catalog and annotates entries with effective enabled state.
   *
   * @returns {Promise<object[]>}
   */
  async getFilterListCatalog() {
    const catalog = await this._loadCatalog();
    const userLocale = (
      Services.locale.appLocaleAsBCP47?.split("-")[0] || ""
    ).toLowerCase();
    const overrides = this._getEnabledListOverrides();

    return catalog.map(entry => ({
      ...entry,
      enabled: this._isCatalogEntryEnabled(entry, userLocale, overrides),
    }));
  },

  /**
   * Resolves generic hide selectors from observed classes/ids and exception domains.
   *
   * @param {string[]} [classes=[]]
   * @param {string[]} [ids=[]]
   * @param {string[]} [exceptions=[]]
   * @returns {string[]}
   */
  getHiddenClassIdSelectors(classes = [], ids = [], exceptions = []) {
    if (!this._engine) {
      return [];
    }

    try {
      const safeClasses = sanitizeStringList(classes, 5000);
      const safeIds = sanitizeStringList(ids, 5000);
      const safeExceptions = sanitizeStringList(exceptions, 500);

      if (!safeClasses.length && !safeIds.length) {
        return [];
      }

      const classesJson = toAsciiSafeJson(safeClasses);
      const idsJson = toAsciiSafeJson(safeIds);
      const exceptionsJson = toAsciiSafeJson(safeExceptions);

      const selectors = JSON.parse(
        this._engine.getHiddenClassIdSelectors(
          classesJson,
          idsJson,
          exceptionsJson
        )
      );

      return selectors.filter(s => s);
    } catch (err) {
      console.error("[WaterfoxBlocker] getHiddenClassIdSelectors failed:", err);
      return [];
    }
  },

  /**
   * Increments and publishes blocked count for a browser id.
   *
   * @param {number} browserId
   * @returns {number} Updated blocked count.
   */
  incrementBlockedCount(browserId) {
    const current = this.getBlockedCount(browserId);
    const next = current + 1;
    this._blockedCountByBrowserId.set(browserId, next);
    this._trimBlockedCountMapIfNeeded();
    this._notifyBlockedCountUpdated(browserId, next);
    return next;
  },

  /**
   * Initialises observers, loads engine state, and starts periodic list updates.
   *
   * Safe to call more than once.
   */
  _networkObserversRegistered: false,

  _registerNetworkObservers() {
    if (this._networkObserversRegistered) {
      return;
    }
    for (const topic of [
      TOPIC_HTTP_ON_MODIFY_REQUEST,
      TOPIC_HTTP_ON_EXAMINE_RESPONSE,
      TOPIC_HTTP_ON_EXAMINE_CACHED_RESPONSE,
      TOPIC_HTTP_ON_EXAMINE_MERGED_RESPONSE,
    ]) {
      Services.obs.addObserver(this, topic);
    }
    this._networkObserversRegistered = true;
  },

  _unregisterNetworkObservers() {
    if (!this._networkObserversRegistered) {
      return;
    }
    for (const topic of [
      TOPIC_HTTP_ON_MODIFY_REQUEST,
      TOPIC_HTTP_ON_EXAMINE_RESPONSE,
      TOPIC_HTTP_ON_EXAMINE_CACHED_RESPONSE,
      TOPIC_HTTP_ON_EXAMINE_MERGED_RESPONSE,
    ]) {
      try {
        Services.obs.removeObserver(this, topic);
      } catch (_) {}
    }
    this._networkObserversRegistered = false;
  },

  async init() {
    if (this._initialized) {
      return;
    }

    Services.prefs.addObserver(PREF_BRANCH, this);
    this._initialized = true;

    if (!this.isEnabled()) {
      return;
    }

    this._registerNetworkObservers();

    // Load the engine from the serialised cache synchronously so it is
    // ready before the first request arrives.
    this._tryInitFromCacheSync();

    await this._initializeEngineIfNeeded();
    this._startPeriodicListUpdates();
  },

  isEnabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  },

  /**
   * Returns whether a domain is covered by persisted site exceptions.
   *
   * Matching includes exact host and subdomain suffix matches for the stored
   * exception value (for example, `example.com` matches `www.example.com`,
   * while `www.example.com` does not match `example.com`).
   *
   * @param {string} domain
   * @returns {boolean}
   */
  isSiteExcepted(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return false;
    }

    return this._getSiteExceptions().some(
      ex => normalized === ex || normalized.endsWith(`.${ex}`)
    );
  },

  isCosmeticFilteringDisabled(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return false;
    }

    return this._getNoCosmeticFilteringSites().some(
      ex => normalized === ex || normalized.endsWith(`.${ex}`)
    );
  },

  isRemoteFontsDisabled(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return false;
    }

    return this._getNoRemoteFontsSites().some(
      ex => normalized === ex || normalized.endsWith(`.${ex}`)
    );
  },

  isScriptingDisabled(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return false;
    }

    return this._getNoScriptingSites().some(
      ex => normalized === ex || normalized.endsWith(`.${ex}`)
    );
  },

  /**
   * Observer entry point for network and preference events.
   *
   * Routes channel notifications for request and response handling to blocker
   * handlers, and reacts to preference changes that require engine or list
   * refresh work.
   *
   * @param {nsISupports|null} subject Observer payload from Services.obs.
   * @param {string} topic Observer topic name.
   * @param {string} data Preference name for notifications about preference changes.
   */
  observe(subject, topic, data) {
    if (topic === TOPIC_HTTP_ON_MODIFY_REQUEST) {
      this._onModifyRequest(subject);
      return;
    }

    if (
      topic === TOPIC_HTTP_ON_EXAMINE_RESPONSE ||
      topic === TOPIC_HTTP_ON_EXAMINE_CACHED_RESPONSE ||
      topic === TOPIC_HTTP_ON_EXAMINE_MERGED_RESPONSE
    ) {
      this._onExamineResponse(subject);
      return;
    }

    if (topic !== TOPIC_PREF_CHANGED) {
      return;
    }

    switch (data) {
      case PREF_ENABLED:
        if (this.isEnabled()) {
          this._registerNetworkObservers();
          this._initializeEngineIfNeeded()
            .then(() => this._startPeriodicListUpdates())
            .catch(err => {
              console.error(
                "[WaterfoxBlocker] Failed to initialise engine:",
                err
              );
            });
        } else {
          this._unregisterNetworkObservers();
          this._stopPeriodicListUpdates();
          this._clearBlockedCounts();
          this._pendingDocumentBypassTokens.clear();
          this._sessionSiteExceptions.clear();
          this._siteExceptionsCache = null;
          this._engine = null;
          this._engineInitialising = false;
          this._initGeneration++;
        }
        break;

      case PREF_FILTER_LIST_URLS:
        if (this.isEnabled()) {
          this._engine = null;
          this._initGeneration++;
          this._refreshListsAndEngine().catch(err => {
            console.error(
              "[WaterfoxBlocker] Failed to refresh lists after pref change:",
              err
            );
          });
        }
        break;

      case PREF_CUSTOM_RULES:
      case PREF_ENABLED_LISTS:
        if (this.isEnabled()) {
          this._engine = null;
          this._initGeneration++;
          this._refreshListsAndEngine().catch(err => {
            console.error(
              "[WaterfoxBlocker] Failed to refresh lists after list toggle:",
              err
            );
          });
        }
        break;

      case PREF_SITE_EXCEPTIONS:
        this._siteExceptionsCache = null;
        break;

      case PREF_NO_COSMETIC_FILTERING_SITES:
        this._noCosmeticFilteringSitesCache = null;
        break;

      case PREF_NO_REMOTE_FONTS_SITES:
        this._noRemoteFontsSitesCache = null;
        break;

      case PREF_NO_SCRIPTING_SITES:
        this._noScriptingSitesCache = null;
        break;

      default:
        break;
    }
  },

  /**
   * Removes a saved site exception for the given domain.
   *
   * @param {string} domain
   */
  removeSiteException(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return;
    }

    const exceptions = this._getSiteExceptions().filter(d => d !== normalized);
    this._setSiteExceptions(exceptions);
  },

  addNoCosmeticFilteringSite(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return;
    }

    const domains = this._getNoCosmeticFilteringSites();
    if (!domains.includes(normalized)) {
      domains.push(normalized);
      this._setNoCosmeticFilteringSites(domains);
    }
  },

  addNoRemoteFontsSite(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return;
    }

    const domains = this._getNoRemoteFontsSites();
    if (!domains.includes(normalized)) {
      domains.push(normalized);
      this._setNoRemoteFontsSites(domains);
    }
  },

  addNoScriptingSite(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return;
    }

    const domains = this._getNoScriptingSites();
    if (!domains.includes(normalized)) {
      domains.push(normalized);
      this._setNoScriptingSites(domains);
    }
  },

  removeNoCosmeticFilteringSite(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return;
    }

    const domains = this._getNoCosmeticFilteringSites().filter(
      entry => entry !== normalized
    );
    this._setNoCosmeticFilteringSites(domains);
  },

  removeNoRemoteFontsSite(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return;
    }

    const domains = this._getNoRemoteFontsSites().filter(
      entry => entry !== normalized
    );
    this._setNoRemoteFontsSites(domains);
  },

  removeNoScriptingSite(domain) {
    const normalized = toSafeDomain(domain);
    if (!normalized) {
      return;
    }

    const domains = this._getNoScriptingSites().filter(
      entry => entry !== normalized
    );
    this._setNoScriptingSites(domains);
  },

  /**
   * Returns whether blocking should be bypassed for an initiator domain.
   *
   * Bypass sources:
   * - Temporary exceptions that last for the session.
   * - Persisted site exceptions.
   * - Search partner exemptions when enabled.
   *
   * Search partner matching uses hostname exact/suffix checks against
   * configured partner domains.
   * Site exceptions use hostname exact/suffix matching.
   *
   * @param {string} loadingPrincipalDomain
   * @returns {boolean}
   */
  shouldBypassBlocking(loadingPrincipalDomain) {
    const domain = toSafeDomain(loadingPrincipalDomain);
    if (!domain) {
      return false;
    }

    if (this._hasTemporarySiteException(domain)) {
      return true;
    }

    // User site exceptions apply first (hostname semantics).
    if (this.isSiteExcepted(domain)) {
      return true;
    }

    if (!Services.prefs.getBoolPref(PREF_ALLOW_SEARCH_PARTNER_ADS, true)) {
      return false;
    }

    return SEARCH_PARTNER_DOMAINS.some(
      p => domain === p || domain.endsWith(`.${p}`)
    );
  },

  /**
   * Content-policy bridge called by the native `nsIContentPolicy` wrapper.
   *
   * Runs before every load - including loads served from internal caches -
   * and applies the same blocking logic as the observer path for
   * non-top-level requests.
   *
   * @param {nsIURI} contentLocation
   * @param {nsILoadInfo} loadInfo
   * @returns {number} `nsIContentPolicy` decision code.
   */
  shouldLoad(contentLocation, loadInfo) {
    const ACCEPT = Ci.nsIContentPolicy.ACCEPT;
    const REJECT_TYPE = Ci.nsIContentPolicy.REJECT_TYPE;

    if (!this.isEnabled() || !contentLocation || !loadInfo) {
      return ACCEPT;
    }

    if (!this._engine) {
      return ACCEPT;
    }

    let isHttp = false;
    try {
      isHttp =
        contentLocation.schemeIs("http") || contentLocation.schemeIs("https");
    } catch (_) {}
    if (!isHttp) {
      return ACCEPT;
    }

    const requestType = this._mapContentPolicyType(
      loadInfo.externalContentPolicyType
    );

    // Top-level documents are handled by `_handleTopLevelDocumentRequest`
    // in the observer path so the blocked-page redirect works.
    if (requestType === "document" && loadInfo.isTopLevelLoad) {
      return ACCEPT;
    }

    const triggeringDomain = this._getPrincipalHost(
      loadInfo.triggeringPrincipal
    );
    if (triggeringDomain && this.shouldBypassBlocking(triggeringDomain)) {
      return ACCEPT;
    }

    let url = "";
    try {
      url = contentLocation.spec || "";
    } catch (_) {}
    if (!url) {
      return ACCEPT;
    }

    let hostname = "";
    try {
      hostname = contentLocation.host || "";
    } catch (_) {}

    const sourceHostname = this._getPrincipalHost(loadInfo.loadingPrincipal);
    const thirdParty = this._isThirdPartyLoadInfo(loadInfo);
    const browserId = loadInfo.browsingContext?.top?.browserId || 0;
    const policyHost = this._getPolicyHostForLoadInfo(loadInfo, sourceHostname);
    const siteSwitchReason = this._getSiteSwitchBlockReason(
      policyHost,
      requestType
    );

    if (siteSwitchReason) {
      try {
        if (browserId) {
          this.incrementBlockedCount(browserId);
        }
      } catch (_) {}
      return REJECT_TYPE;
    }

    const result = this.checkRequest(
      url,
      sourceHostname,
      hostname,
      requestType,
      thirdParty
    );
    if (!result.matched || result.exception) {
      return ACCEPT;
    }

    try {
      if (browserId) {
        this.incrementBlockedCount(browserId);
      }
    } catch (_) {}

    return REJECT_TYPE;
  },

  /**
   * Removes observers, stops timers, clears state held in memory, and drops
   * engine references.
   *
   * Safe to call more than once.
   */
  uninit() {
    if (!this._initialized) {
      return;
    }

    try {
      Services.prefs.removeObserver(PREF_BRANCH, this);
    } catch (_) {}

    this._unregisterNetworkObservers();
    this._stopPeriodicListUpdates();
    this._clearBlockedCounts();
    this._pendingDocumentBypassTokens.clear();
    this._sessionSiteExceptions.clear();
    this._noCosmeticFilteringSitesCache = null;
    this._noRemoteFontsSitesCache = null;
    this._noScriptingSitesCache = null;
    this._siteExceptionsCache = null;
    this._engine = null;
    this._engineInitialising = false;
    this._initGeneration++;
    this.__thirdPartyUtil = undefined;
    this._initialized = false;
  },

  /**
   * Replaces the engine resource set with the provided payload.
   *
   * Accepts either a JSON string that is already serialised or a JS
   * object/array that will be serialised before passing to native code.
   *
   * @param {string|object|Array<unknown>} resourcesJsonOrObject
   */
  useResources(resourcesJsonOrObject) {
    if (!this._engine) {
      return;
    }

    try {
      const payload =
        typeof resourcesJsonOrObject === "string"
          ? resourcesJsonOrObject
          : JSON.stringify(resourcesJsonOrObject ?? []);
      this._engine.useResources(payload);
    } catch (err) {
      console.error("[WaterfoxBlocker] useResources failed:", err);
    }
  },
};
