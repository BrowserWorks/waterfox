/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export {
  MAX_CUSTOM_FILTERS_BYTES,
  MAX_CUSTOM_FILTER_LINE_LENGTH,
  normalizeCustomFiltersText,
} from "resource:///modules/internal/ListStore.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  EngineCache: "resource:///modules/internal/EngineCache.sys.mjs",
  ListCatalog: "resource:///modules/internal/ListCatalog.sys.mjs",
  ListStore: "resource:///modules/internal/ListStore.sys.mjs",
  ListUpdatesState: "resource:///modules/internal/ListUpdates.sys.mjs",
  RemoteResources: "resource:///modules/internal/RemoteResources.sys.mjs",
  Resources: "resource:///modules/internal/Resources.sys.mjs",
  SiteExceptionsState: "resource:///modules/internal/SiteExceptions.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const CONTRACT_ID = "@waterfox.com/waterfox-blocker-engine;1";

// Prefs
const PREF_ENABLED = "waterfox.blocker.enabled";
const PREF_ALLOW_SEARCH_PARTNER_ADS = "waterfox.blocker.allowSearchPartnerAds";
const PREF_FILTER_LIST_URLS = "waterfox.blocker.filterListUrls";
const PREF_ENABLED_LISTS = "waterfox.blocker.enabledLists";
const PREF_LEGACY_SITE_EXCEPTIONS = "waterfox.blocker.siteExceptions";
const PREF_SITE_EXCEPTIONS_MIGRATED =
  "waterfox.blocker.siteExceptions.migrated";
const PREF_REMOTE_RESOURCES_ENABLED = "waterfox.blocker.remoteResourcesEnabled";
const PREF_BRANCH = "waterfox.blocker.";

const SEARCH_PARTNER_DOMAINS = Object.freeze(["1.org", "search.waterfox.com"]);

const BLOCKED_COUNT_MAP_MAX_ENTRIES = 500;
const BLOCKED_COUNT_MAP_TRIM_TO_ENTRIES = 250;
const TOPIC_BLOCKED_COUNT_UPDATED = "WaterfoxBlocker:BlockedCountUpdated";
const TOPIC_BLOCKED_COUNTS_CLEARED = "WaterfoxBlocker:BlockedCountsCleared";
const TOPIC_HTTP_ON_MODIFY_REQUEST = "http-on-modify-request";
const TOPIC_HTTP_ON_EXAMINE_RESPONSE = "http-on-examine-response";
const TOPIC_HTTP_ON_EXAMINE_CACHED_RESPONSE = "http-on-examine-cached-response";
const TOPIC_HTTP_ON_EXAMINE_MERGED_RESPONSE = "http-on-examine-merged-response";
const TOPIC_PREF_CHANGED = "nsPref:changed";

const BLOCKED_PAGE_URL = "about:contentblocked";
const INIT_RETRY_DELAY_MS = 30 * 1000;
const STARTUP_LIST_CATCHUP_DELAY_MS = 60 * 1000;
const LIST_UPDATE_FALLBACK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TOP_LEVEL_NAVIGATION_BYPASS_TTL_MS = 60 * 1000;
const REMOTE_SETTINGS_POLL_END_TOPIC = "remote-settings:changes-poll-end";

// Sanitises strings for safe passage through ACString XPConnect params
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
 * Owns the native engine, loads and refreshes filter lists, intercepts
 * network channels to block requests and apply CSP, and tracks blocked
 * counts for each tab so the protections UI can read them.
 */
export const WaterfoxBlockerService = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIObserver",
    "nsIWaterfoxBlockerContentPolicyBridge",
  ]),

  _blockedCountByBrowserId: new Map(),
  _topLevelHostByBrowserId: new Map(),
  _topLevelNavigationBypassByBrowserId: new Map(),
  _listUpdatesState: null,
  _siteExceptionsState: null,
  _engine: null,
  _engineInitPromise: null,
  _initGeneration: 0,
  _initRetryTimerId: null,
  _initialized: false,
  _listUpdateObserverRegistered: false,
  _startupCatchupTimerId: null,
  __thirdPartyUtil: undefined,

  _customFiltersPath() {
    return lazy.ListStore.customFiltersPath();
  },

  _siteExceptions() {
    if (!this._siteExceptionsState) {
      this._siteExceptionsState = new lazy.SiteExceptionsState();
    }
    return this._siteExceptionsState;
  },

  _listUpdates() {
    if (!this._listUpdatesState) {
      this._listUpdatesState = new lazy.ListUpdatesState();
    }
    return this._listUpdatesState;
  },

  _clearBlockedCounts() {
    if (!this._blockedCountByBrowserId.size) {
      return;
    }

    this._blockedCountByBrowserId.clear();
    this._notifyBlockedCountsCleared();
  },

  _clearTopLevelNavigationState() {
    this._topLevelHostByBrowserId.clear();
    this._topLevelNavigationBypassByBrowserId.clear();
  },

  _createEngine() {
    return Cc[CONTRACT_ID].createInstance(Ci.nsIWaterfoxBlockerEngine);
  },

  /**
   * Synchronous fast path: reads the serialised engine cache from disk so
   * the engine is ready before the event loop processes any load requests.
   * Uses blocking file I/O intentionally; the cache is small and the read
   * is effectively instant. Hash verification is skipped here - the async
   * `_initializeEngineIfNeeded` path and periodic updates handle staleness.
   */
  _tryInitFromCacheSync() {
    try {
      const cacheData = lazy.EngineCache.readSync();
      if (!cacheData?.length) {
        return;
      }

      const engine = this._createEngine();
      engine.initFromCache(cacheData);
      this._engine = engine;
    } catch (_) {
      // Cache missing, corrupt, or incompatible. Async path will rebuild.
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
      if (this._isCustomFiltersDescriptor(descriptor)) {
        continue;
      }

      try {
        const result = await this._fetchListForBootstrap(descriptor);
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
          filename: descriptor.filename,
          lastAttempt: now,
          lastError: "",
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

  async _fetchListForBootstrap(descriptor) {
    const response = await fetch(descriptor.url, {
      cache: "no-store",
    });

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
      text,
    };
  },

  _getCustomFilterListUrls() {
    return lazy.ListCatalog.getCustomFilterListUrls();
  },

  _customFiltersDescriptor() {
    return lazy.ListCatalog.customFiltersDescriptor();
  },

  _hasNonCustomDescriptors(descriptors) {
    return lazy.ListCatalog.hasNonCustomDescriptors(descriptors);
  },

  _hasNonCustomListRecords(listRecords) {
    return lazy.ListCatalog.hasNonCustomListRecords(listRecords);
  },

  _isCustomFiltersDescriptor(descriptor) {
    return lazy.ListCatalog.isCustomFiltersDescriptor(descriptor);
  },

  _normalizeCustomFiltersText(text) {
    return lazy.ListStore.normalizeCustomFiltersText(text);
  },

  async _readCustomFiltersText() {
    return lazy.ListStore.readCustomFiltersText();
  },

  async _readCustomFiltersRecord() {
    return lazy.ListStore.readCustomFiltersRecord(
      this._customFiltersDescriptor()
    );
  },

  async _withCustomFiltersRecord(listRecords, descriptors) {
    return lazy.ListStore.withCustomFiltersRecord(listRecords, descriptors);
  },

  _getEnabledListOverrides() {
    return lazy.ListCatalog.getEnabledListOverrides();
  },

  _isCatalogEntryEnabled(entry, userLocale, overrides = null) {
    return lazy.ListCatalog.isCatalogEntryEnabled(entry, userLocale, overrides);
  },

  async _getListDescriptors() {
    return lazy.ListCatalog.getListDescriptors();
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

    if (!rules.length) {
      return false;
    }

    const nextEngine = this._createEngine();
    nextEngine.initFromLists(rules);
    this._engine = nextEngine;
    return true;
  },

  /**
   * Source order:
   *   1) Stored profile lists
   *   2) Network fetch from configured descriptors
   *   3) Bundled fallback lists
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

    const storedListsUsable =
      storedLists.length &&
      (!this._hasNonCustomDescriptors(descriptors) ||
        this._hasNonCustomListRecords(storedLists));
    if (storedListsUsable) {
      try {
        const initializedFromStored =
          await this._initEngineFromListRecords(storedLists);
        if (initializedFromStored) {
          await lazy.EngineCache.write(this._engine, descriptors, storedLists);
          return;
        }
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

    const fetchedListsForEngine = await this._withCustomFiltersRecord(
      fetchedLists,
      descriptors
    );
    const fetchedListsUsable =
      fetchedLists.length ||
      (!this._hasNonCustomDescriptors(descriptors) &&
        fetchedListsForEngine.length);
    if (fetchedListsUsable) {
      try {
        const initializedFromFetched = await this._initEngineFromListRecords(
          fetchedListsForEngine
        );
        if (initializedFromFetched) {
          await lazy.EngineCache.write(
            this._engine,
            descriptors,
            fetchedListsForEngine
          );
          return;
        }
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

    const bundledListsForEngine = await this._withCustomFiltersRecord(
      bundledLists,
      descriptors
    );
    if (!bundledListsForEngine.length) {
      if (!this._hasNonCustomDescriptors(descriptors)) {
        this._engine = null;
        await lazy.EngineCache.clear();
        return;
      }

      throw new Error("No bundled filter lists available for fallback");
    }

    // Persist bundled fallback to profile so startup has a stable local source.
    if (bundledLists.length) {
      await this._persistListRecordsAndMetadata(bundledLists, descriptors);
    }

    if (this._initGeneration !== generation) {
      return;
    }

    const initializedFromBundled = await this._initEngineFromListRecords(
      bundledListsForEngine
    );
    if (initializedFromBundled) {
      await lazy.EngineCache.write(
        this._engine,
        descriptors,
        bundledListsForEngine
      );
      return;
    }

    if (!this._hasNonCustomDescriptors(descriptors)) {
      this._engine = null;
      await lazy.EngineCache.clear();
      return;
    }

    throw new Error("Filter lists contained no valid rules");
  },

  /**
   * Tries the cache first, then falls back to initialisation from text
   * sources. Supplementary resources are awaited so scriptlets and redirects
   * are available on first page load.
   */
  async _initializeEngineIfNeeded() {
    if (this._engineInitPromise) {
      return this._engineInitPromise;
    }

    const promise = this._doInitializeEngineIfNeeded().finally(() => {
      if (this._engineInitPromise === promise) {
        this._engineInitPromise = null;
      }
    });
    this._engineInitPromise = promise;
    return promise;
  },

  async _doInitializeEngineIfNeeded() {
    // Capture generation so we can detect if the blocker was disabled (or
    // re-initialised) while we were awaiting async work.
    const generation = this._initGeneration;

    if (this._engine) {
      // Engine may already be loaded from the synchronous cache path. Verify
      // it still matches the current list set before trusting it.
      const descriptors = await this._getListDescriptors();
      if (this._initGeneration !== generation) {
        return;
      }

      if (!descriptors.length) {
        this._engine = null;
        return;
      }

      const storedLists = await this._readStoredLists(descriptors);
      const cacheMatchesCurrentLists =
        storedLists.length &&
        (!this._hasNonCustomDescriptors(descriptors) ||
          this._hasNonCustomListRecords(storedLists)) &&
        (await lazy.EngineCache.matchesCurrentLists(descriptors, storedLists));
      if (!cacheMatchesCurrentLists) {
        const previousEngine = this._engine;
        this._engine = null;
        try {
          await this._initFromTextSourcesAndCache(descriptors, generation);
        } catch (err) {
          // Restore the previous engine before surfacing the rebuild failure.
          this._engine = previousEngine;
          throw err;
        }

        if (this._initGeneration !== generation) {
          return;
        }
      }

      await lazy.Resources.load(this._engine);
      return;
    }

    const descriptors = await this._getListDescriptors();
    if (this._initGeneration !== generation) {
      return;
    }
    if (!descriptors.length) {
      this._engine = null;
      return;
    }

    let loadedFromCache = false;
    try {
      loadedFromCache = await this._tryInitFromCache(descriptors);
    } catch (e) {
      // File not found is expected on first run.
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

    await lazy.Resources.load(this._engine);
  },

  _listPath(filename) {
    return lazy.ListStore.listPath(filename);
  },

  _listsDirPath() {
    return lazy.ListStore.listsDirPath();
  },

  _listsMetadataPath() {
    return lazy.ListStore.listsMetadataPath();
  },

  async _loadCatalog() {
    return lazy.ListCatalog.loadCatalog();
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
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to notify cleared counts:", err);
    }
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
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to notify blocked count:", err);
    }
  },

  _buildBlockedPageUrl(url, result) {
    const params = new URLSearchParams();
    params.set("url", String(url || ""));

    const matchedRule = this._extractMatchedRule(result);
    if (matchedRule) {
      params.set("rule", matchedRule);
    }

    return `${BLOCKED_PAGE_URL}?${params.toString()}`;
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

  _getURIHost(uri) {
    if (!uri) {
      return "";
    }

    try {
      return uri.host || "";
    } catch (_) {
      // nsIURI.host throws for URI types without an authority component.
      return "";
    }
  },

  _getPrincipalHost(principal) {
    return this._getURIHost(principal?.URI);
  },

  _getChannelReferrerHost(channel) {
    try {
      const referrerSpec = channel?.referrerInfo?.computedReferrerSpec;
      return referrerSpec ? new URL(referrerSpec).hostname : "";
    } catch (_) {
      return "";
    }
  },

  _getBrowsingContextDocumentHost(browsingContext) {
    try {
      const principalHost = this._getPrincipalHost(
        browsingContext?.currentWindowGlobal?.documentPrincipal
      );
      if (principalHost) {
        return principalHost;
      }

      const documentHost = this._getURIHost(
        browsingContext?.currentWindowGlobal?.documentURI
      );
      if (documentHost) {
        return documentHost;
      }

      return this._getURIHost(browsingContext?.embedderElement?.currentURI);
    } catch (_) {
      // BrowsingContext/WindowGlobal can disappear during navigation teardown.
      return "";
    }
  },

  _canUseTopLevelDocumentContext(loadInfo, isTopLevelDocument) {
    if (!isTopLevelDocument) {
      return true;
    }

    const triggeringPrincipal = loadInfo?.triggeringPrincipal;
    return (
      !!triggeringPrincipal &&
      !triggeringPrincipal.isSystemPrincipal &&
      !loadInfo?.loadTriggeredFromExternal &&
      (triggeringPrincipal.isContentPrincipal ||
        triggeringPrincipal.isNullPrincipal ||
        !!loadInfo?.hasValidUserGestureActivation)
    );
  },

  _shouldBypassLoadInfo(
    loadInfo,
    { isTopLevelDocument = false, targetHostname = "" } = {}
  ) {
    const candidateHosts = [
      targetHostname,
      this._getPrincipalHost(loadInfo?.triggeringPrincipal),
      this._getPrincipalHost(loadInfo?.loadingPrincipal),
      this._getPrincipalHost(loadInfo?.principalToInherit),
    ];

    if (this._canUseTopLevelDocumentContext(loadInfo, isTopLevelDocument)) {
      candidateHosts.push(
        this._getBrowsingContextDocumentHost(loadInfo?.browsingContext?.top),
        this._getBrowsingContextDocumentHost(
          loadInfo?.targetBrowsingContext?.top
        ),
        this._getBrowsingContextDocumentHost(
          loadInfo?.workerAssociatedBrowsingContext?.top
        )
      );
    }

    return candidateHosts.some(host => this.shouldBypassBlocking(host));
  },

  _rememberTopLevelHost(browserId, hostname) {
    const id = Number(browserId || 0);
    const host = String(hostname || "").replace(/\.$/, "");
    if (!id || !host) {
      return;
    }

    this._topLevelHostByBrowserId.set(id, host);
    if (this._topLevelHostByBrowserId.size > BLOCKED_COUNT_MAP_MAX_ENTRIES) {
      const firstId = this._topLevelHostByBrowserId.keys().next().value;
      this._topLevelHostByBrowserId.delete(firstId);
      this._topLevelNavigationBypassByBrowserId.delete(firstId);
    }
  },

  _getTopLevelNavigationBypassSourceHost(browserId, channel, loadInfo) {
    const id = Number(browserId || 0);
    const candidateHosts = [
      this._getChannelReferrerHost(channel),
      this._getPrincipalHost(loadInfo?.triggeringPrincipal),
      this._getPrincipalHost(loadInfo?.loadingPrincipal),
      this._getPrincipalHost(loadInfo?.principalToInherit),
      this._getBrowsingContextDocumentHost(loadInfo?.browsingContext?.top),
      this._getBrowsingContextDocumentHost(
        loadInfo?.targetBrowsingContext?.top
      ),
      this._topLevelHostByBrowserId.get(id) || "",
    ];

    if (!id || !this._topLevelHostByBrowserId.has(id)) {
      candidateHosts.push(
        this._getBrowsingContextDocumentHost(
          loadInfo?.browsingContext?.opener?.top
        ),
        this._getBrowsingContextDocumentHost(
          loadInfo?.targetBrowsingContext?.opener?.top
        )
      );
    }

    return candidateHosts.find(host => this.shouldBypassBlocking(host)) || "";
  },

  _hasActiveTopLevelNavigationBypass(browserId) {
    const id = Number(browserId || 0);
    const activeBypass = this._topLevelNavigationBypassByBrowserId.get(id);
    if (activeBypass?.until > Date.now()) {
      if (this.shouldBypassBlocking(activeBypass.sourceHost)) {
        return true;
      }
      this._topLevelNavigationBypassByBrowserId.delete(id);
      return false;
    }

    this._topLevelNavigationBypassByBrowserId.delete(id);
    return false;
  },

  _rememberTopLevelResponse(channel, loadInfo, requestType, hostname) {
    if (requestType !== "document" || !loadInfo?.isTopLevelLoad) {
      return;
    }

    let responseStatus = 0;
    try {
      responseStatus = Number(channel.responseStatus || 0);
    } catch (_) {
      // Some channels do not expose response status yet.
    }

    if (responseStatus >= 300 && responseStatus < 400) {
      return;
    }

    const browserId = this._getTopBrowserId(loadInfo);
    this._rememberTopLevelHost(browserId, hostname);
    this._topLevelNavigationBypassByBrowserId.delete(browserId);
  },

  _shouldBypassTopLevelDocumentRequest(browserId, channel, loadInfo, hostname) {
    const id = Number(browserId || 0);
    const canUseSourceContext = this._canUseTopLevelDocumentContext(
      loadInfo,
      true
    );
    const sourceHost = canUseSourceContext
      ? this._getTopLevelNavigationBypassSourceHost(id, channel, loadInfo)
      : "";

    if (
      this._shouldBypassLoadInfo(loadInfo, {
        isTopLevelDocument: true,
        targetHostname: hostname,
      })
    ) {
      if (id && sourceHost && !this.shouldBypassBlocking(hostname)) {
        this._topLevelNavigationBypassByBrowserId.set(id, {
          sourceHost,
          until: Date.now() + TOP_LEVEL_NAVIGATION_BYPASS_TTL_MS,
        });
      }
      return true;
    }

    if (!canUseSourceContext) {
      return false;
    }

    if (id && this._hasActiveTopLevelNavigationBypass(id)) {
      return true;
    }

    if (!sourceHost) {
      return false;
    }

    if (id) {
      this._topLevelNavigationBypassByBrowserId.set(id, {
        sourceHost,
        until: Date.now() + TOP_LEVEL_NAVIGATION_BYPASS_TTL_MS,
      });
    }
    return true;
  },

  _getTopBrowserId(loadInfo) {
    try {
      return Number(loadInfo?.browsingContext?.top?.browserId || 0);
    } catch (_) {
      // BrowsingContext can disappear during navigation teardown.
      return 0;
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
      // Be conservative if third-party classification fails.
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
      // Be conservative if third-party classification fails.
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
    const browserId = this._getTopBrowserId(loadInfo);
    if (
      this._shouldBypassTopLevelDocumentRequest(
        browserId,
        channel,
        loadInfo,
        hostname
      )
    ) {
      if (this.shouldBypassBlocking(hostname)) {
        this._rememberTopLevelHost(browserId, hostname);
      }
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
      this._rememberTopLevelHost(browserId, hostname);
      return;
    }

    try {
      const blockedPageUrl = this._buildBlockedPageUrl(url, result);
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
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to increment blocked count:", err);
    }
  },

  /**
   * Redirects blocked top level documents to the blocked page, runs bypass
   * checks, and cancels matched subresource requests. Loads served from
   * internal caches are handled by the `shouldLoad` bridge instead.
   *
   * @param {nsISupports} subject
   */
  _onModifyRequest(subject) {
    if (!this._engine) {
      return;
    }

    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch (_) {
      // Some observer subjects are not HTTP channels.
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
    const browserId = this._getTopBrowserId(loadInfo);

    let hostname = "";
    try {
      hostname = uri.host || "";
    } catch (_) {
      // nsIURI.host throws for URI types without an authority component.
    }

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

    if (this._shouldBypassLoadInfo(loadInfo)) {
      return;
    }

    const result = this.checkRequest(
      url,
      this._getPrincipalHost(loadInfo.loadingPrincipal),
      hostname,
      requestType,
      this._isThirdPartyChannel(channel)
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
      } catch (err) {
        console.warn(
          "[WaterfoxBlocker] Failed to increment blocked count:",
          err
        );
      }
    }
  },

  /**
   * Computes `$csp` directives for document and subdocument channels and
   * appends them to the response's `Content-Security-Policy` header.
   *
   * @param {nsISupports} subject
   */
  _onExamineResponse(subject) {
    if (!this._engine) {
      return;
    }

    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch (_) {
      // Some observer subjects are not HTTP channels.
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
      // uri.host throws for URIs without an authority component (e.g.
      // about: pages).
    }

    const isTopLevelDocument =
      requestType === "document" && loadInfo.isTopLevelLoad;
    const shouldBypassResponse =
      this._shouldBypassLoadInfo(loadInfo, {
        isTopLevelDocument,
        targetHostname: hostname,
      }) ||
      (isTopLevelDocument &&
        this._hasActiveTopLevelNavigationBypass(
          this._getTopBrowserId(loadInfo)
        ));

    this._rememberTopLevelResponse(channel, loadInfo, requestType, hostname);

    if (shouldBypassResponse) {
      return;
    }

    const directives = this.getCspDirectives(
      url,
      this._getPrincipalHost(loadInfo.loadingPrincipal),
      hostname,
      requestType,
      this._isThirdPartyChannel(channel)
    );
    if (!directives) {
      return;
    }

    try {
      channel.setResponseHeader("Content-Security-Policy", directives, true);
    } catch (err) {
      console.error("[WaterfoxBlocker] Failed to apply CSP directives:", err);
    }
  },

  async _persistListRecordsAndMetadata(listRecords, descriptors) {
    await lazy.ListStore.persistListRecordsAndMetadata(
      listRecords,
      descriptors
    );
  },

  async _readBundledLists(descriptors) {
    return lazy.ListStore.readBundledLists(descriptors);
  },

  async _rebuildEngineFromCurrentSources({
    preservePreviousEngine = false,
  } = {}) {
    const previousEngine = preservePreviousEngine ? this._engine : null;
    const generation = ++this._initGeneration;
    const descriptors = await this._getListDescriptors();

    try {
      await this._initFromTextSourcesAndCache(descriptors, generation);
      if (this._initGeneration !== generation) {
        return;
      }

      await lazy.Resources.load(this._engine);
    } catch (err) {
      // Preserve the previous engine when a live rebuild fails.
      if (preservePreviousEngine && this._initGeneration === generation) {
        this._engine = previousEngine;
      }
      throw err;
    }
  },

  async _readJSON(path, fallbackValue) {
    return lazy.ListStore.readJSON(path, fallbackValue);
  },

  async _readStoredLists(descriptors) {
    return lazy.ListStore.readStoredLists(descriptors);
  },

  async _readText(path) {
    return lazy.ListStore.readText(path);
  },

  async refreshListsAndEngine() {
    await this._updateListsIfNeeded();

    if (!this._engine) {
      await this._initializeEngineIfNeeded();
    }
  },

  /**
   * Wires up triggers that refresh lists. The RemoteSettings poll observer
   * (`remote-settings:changes-poll-end`) is an opportunistic trigger, but on
   * builds where RS network sync is disabled it only fires in certain
   * conditions. We also schedule a startup catch-up and a 24 h fallback
   * timer so list refreshes happen reliably regardless of RS state.
   */
  _startListUpdateTriggers() {
    this._stopListUpdateTriggers();
    Services.obs.addObserver(this, REMOTE_SETTINGS_POLL_END_TOPIC);
    this._listUpdateObserverRegistered = true;

    this._startupCatchupTimerId = lazy.setTimeout(() => {
      this._startupCatchupTimerId = null;
      this._updateListsIfNeeded().catch(err => {
        console.warn("[WaterfoxBlocker] Startup list update failed:", err);
      });
    }, STARTUP_LIST_CATCHUP_DELAY_MS);

    this._fallbackUpdateIntervalId = lazy.setInterval(() => {
      this._updateListsIfNeeded().catch(err => {
        console.warn("[WaterfoxBlocker] Fallback list update failed:", err);
      });
    }, LIST_UPDATE_FALLBACK_INTERVAL_MS);
  },

  _stopListUpdateTriggers() {
    if (this._listUpdateObserverRegistered) {
      try {
        Services.obs.removeObserver(this, REMOTE_SETTINGS_POLL_END_TOPIC);
      } catch (err) {
        console.warn(
          "[WaterfoxBlocker] Failed to remove RS poll observer:",
          err
        );
      }
      this._listUpdateObserverRegistered = false;
    }
    if (this._startupCatchupTimerId) {
      lazy.clearTimeout(this._startupCatchupTimerId);
      this._startupCatchupTimerId = null;
    }
    if (this._fallbackUpdateIntervalId) {
      lazy.clearInterval(this._fallbackUpdateIntervalId);
      this._fallbackUpdateIntervalId = null;
    }
  },

  get _thirdPartyUtil() {
    if (this.__thirdPartyUtil === undefined) {
      try {
        this.__thirdPartyUtil = Cc["@mozilla.org/thirdpartyutil;1"].getService(
          Ci.mozIThirdPartyUtil
        );
      } catch (_) {
        // Some builds may not expose the third-party utility service.
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
    const storedLists = await this._readStoredLists(descriptors);
    const cacheMatchesCurrentLists =
      storedLists.length &&
      (!this._hasNonCustomDescriptors(descriptors) ||
        this._hasNonCustomListRecords(storedLists)) &&
      (await lazy.EngineCache.matchesCurrentLists(descriptors, storedLists));
    if (!cacheMatchesCurrentLists) {
      return false;
    }

    const cacheData = await lazy.EngineCache.read();
    const candidate = this._createEngine();
    try {
      candidate.initFromCache(cacheData);
    } catch (_) {
      // Cache data can be stale or incompatible after engine updates.
      return false;
    }
    this._engine = candidate;
    return true;
  },

  async _refreshEngineAfterListUpdate(anyUpdated, descriptors) {
    if (anyUpdated) {
      const storedLists = await this._readStoredLists(descriptors);
      if (storedLists.length) {
        const initializedFromStored =
          await this._initEngineFromListRecords(storedLists);
        if (initializedFromStored) {
          await lazy.Resources.load(this._engine);
          await lazy.EngineCache.write(this._engine, descriptors, storedLists);
          return;
        }
      }

      if (!this._hasNonCustomDescriptors(descriptors)) {
        this._engine = null;
        await lazy.EngineCache.clear();
      }
      return;
    }

    if (this._engine) {
      await lazy.Resources.load(this._engine);
    }
  },

  /**
   * Refreshes every list and rebuilds the engine when content changed.
   *
   * The cadence is driven by the trigger (RemoteSettings poll, startup
   * catch-up, pref change, manual button). Each call does a conditional
   * HTTP fetch for each list. Unchanged lists return 304 and cost almost
   * nothing, so we don't need an internal staleness gate.
   *
   * The remote scriptlet/resource bundles refresh on the same cadence and
   * the engine then reloads them so an updated scriptlet ships without a
   * separate timer.
   */
  async _updateListsIfNeeded() {
    const result = await this._listUpdates().updateIfNeeded();
    if (!result) {
      // Another update pass is happening; it will refresh remote resources
      // and reload the engine when it finishes.
      return;
    }

    try {
      await lazy.RemoteResources.refresh();
    } catch (err) {
      console.warn("[WaterfoxBlocker] Remote resource refresh failed:", err);
    }

    await this._refreshEngineAfterListUpdate(
      result.anyUpdated,
      result.descriptors
    );
  },

  async _writeJSON(path, value) {
    await lazy.ListStore.writeJSON(path, value);
  },

  async _writeText(path, text) {
    await lazy.ListStore.writeText(path, text);
  },

  /**
   * @param {string} domain
   */
  addSiteException(domain) {
    this._siteExceptions().addPermanentSiteException(domain);
  },

  /**
   * Allows the domain for the rest of the browser session. The entry is
   * dropped on browser shutdown.
   *
   * @param {string} domain
   */
  allowSiteForSession(domain) {
    this._siteExceptions().allowSiteForSession(domain);
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
   * @param {string} url
   * @param {string} sourceHostname
   * @param {string} hostname
   * @param {string} requestType adblock-rs request type string.
   * @param {boolean} isThirdParty
   * @returns {{matched: boolean, important: boolean, exception: boolean, redirect: string, rewrittenUrl: string}}
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
   * @param {number} newBrowserId
   * @param {string} sourceHost
   */
  recordNewTabSourceHost(newBrowserId, sourceHost) {
    if (this.shouldBypassBlocking(sourceHost)) {
      this._rememberTopLevelHost(newBrowserId, sourceHost);
    }
  },

  /**
   * @param {number} browserId
   * @returns {number}
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
   * @param {string} url
   * @param {BrowsingContext|null} [browsingContext=null]
   * @returns {object|null} Parsed cosmetic resource payload from the native engine.
   */
  getCosmeticResources(url, browsingContext = null) {
    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch (err) {
      console.error("[WaterfoxBlocker] getCosmeticResources failed:", err);
      return null;
    }

    if (
      !hostname ||
      [
        hostname,
        this._getBrowsingContextDocumentHost(browsingContext),
        this._getBrowsingContextDocumentHost(browsingContext?.top),
      ].some(host => this.shouldBypassBlocking(host))
    ) {
      return null;
    }

    if (!this._engine) {
      return {};
    }

    try {
      const resources = JSON.parse(this._engine.getCosmeticResources(url));
      return resources && typeof resources === "object" ? resources : {};
    } catch (err) {
      console.error("[WaterfoxBlocker] getCosmeticResources failed:", err);
      return {};
    }
  },

  /**
   * @param {string} url
   * @param {string} sourceHostname
   * @param {string} hostname
   * @param {string} requestType
   * @param {boolean} isThirdParty
   * @returns {string} Directive string, or empty when none apply.
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
   * Loads the filter list catalog and annotates entries with their effective
   * enabled state.
   *
   * @returns {Promise<object[]>}
   */
  async getFilterListCatalog() {
    return lazy.ListCatalog.getFilterListCatalog();
  },

  /**
   * @returns {Promise<Array<{url: string, filename: string, lastAttempt: number, lastError: string, lastFetched: number, etag: string, lastModified: string}>>}
   */
  async getFilterListMetadata() {
    const meta = await this._readJSON(this._listsMetadataPath(), { lists: [] });
    return meta?.lists || [];
  },

  /**
   * Reads custom filters from the profile directory ("My filters").
   *
   * @returns {Promise<string>}
   */
  async getCustomFiltersText() {
    return lazy.ListStore.getCustomFiltersText();
  },

  /**
   * Replaces custom filters in the profile and rebuilds the engine when
   * active.
   *
   * @param {string} text
   */
  async setCustomFiltersText(text) {
    const normalized = this._normalizeCustomFiltersText(text);
    const path = this._customFiltersPath();
    const hadPreviousFile = await IOUtils.exists(path);
    let previousText = "";

    if (hadPreviousFile) {
      try {
        previousText = await IOUtils.readUTF8(path);
      } catch (err) {
        console.warn(
          "[WaterfoxBlocker] Failed reading previous custom filters for rollback:",
          err
        );
      }
    }

    await lazy.ListStore.setCustomFiltersText(normalized, {
      alreadyNormalized: true,
    });

    if (!this.isEnabled()) {
      return;
    }

    try {
      await this._rebuildEngineFromCurrentSources({
        preservePreviousEngine: true,
      });
    } catch (err) {
      // Roll back the file change before rethrowing the rebuild failure.
      try {
        if (hadPreviousFile) {
          await IOUtils.writeUTF8(path, previousText, {
            tmpPath: `${path}.tmp`,
          });
        } else {
          await IOUtils.remove(path, { ignoreAbsent: true });
        }

        await this._rebuildEngineFromCurrentSources({
          preservePreviousEngine: true,
        });
      } catch (rollbackErr) {
        console.error(
          "[WaterfoxBlocker] Failed rolling back custom filters after rebuild failure:",
          rollbackErr
        );
      }

      throw err;
    }
  },

  /**
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
   * @param {number} browserId
   * @returns {number}
   */
  incrementBlockedCount(browserId) {
    const current = this.getBlockedCount(browserId);
    const next = current + 1;
    this._blockedCountByBrowserId.set(browserId, next);
    this._trimBlockedCountMapIfNeeded();
    this._notifyBlockedCountUpdated(browserId, next);
    return next;
  },

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
      } catch (err) {
        console.warn(
          `[WaterfoxBlocker] Failed to remove observer for ${topic}:`,
          err
        );
      }
    }
    this._networkObserversRegistered = false;
  },

  _clearInitRetryTimer() {
    if (!this._initRetryTimerId) {
      return;
    }

    lazy.clearTimeout(this._initRetryTimerId);
    this._initRetryTimerId = null;
  },

  _scheduleInitRetry() {
    if (this._initRetryTimerId || !this._initialized || !this.isEnabled()) {
      return;
    }

    this._initRetryTimerId = lazy.setTimeout(() => {
      this._initRetryTimerId = null;
      if (!this._initialized || !this.isEnabled()) {
        return;
      }
      this._registerNetworkObservers();
      this._initializeEngineWithRetry();
    }, INIT_RETRY_DELAY_MS);
  },

  async _initializeEngineWithRetry() {
    try {
      this._clearInitRetryTimer();
      await this._initializeEngineIfNeeded();
      if (this.isEnabled()) {
        this._startListUpdateTriggers();
      }
    } catch (err) {
      console.error("[WaterfoxBlocker] Failed to initialise engine:", err);
      this._scheduleInitRetry();
    }
  },

  /**
   * Migrates site exceptions from the legacy JSON pref into PermissionManager
   * once. Entries collapse to their base domain so storage mirrors ETP's
   * allow list semantics; lossy entries are warned and skipped so a single
   * bad value does not block the rest.
   */
  _migrateSiteExceptions() {
    if (Services.prefs.getBoolPref(PREF_SITE_EXCEPTIONS_MIGRATED, false)) {
      return;
    }

    const raw = Services.prefs.getStringPref(PREF_LEGACY_SITE_EXCEPTIONS, "");
    let entries = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          entries = parsed;
        }
      } catch (err) {
        console.warn(
          "[WaterfoxBlocker] Failed to parse legacy site exceptions pref:",
          err
        );
      }
    }

    const state = this._siteExceptions();
    for (const entry of entries) {
      const host = String(entry || "")
        .trim()
        .toLowerCase();
      if (!host) {
        continue;
      }

      let domain = host;
      try {
        domain = Services.eTLD.getBaseDomainFromHost(host);
      } catch (_) {
        // IP literals, localhost-style hosts, and private suffixes have no
        // public-suffix base domain. Store as entered.
      }

      try {
        state.addPermanentSiteException(domain);
      } catch (err) {
        console.warn(
          `[WaterfoxBlocker] Failed to migrate site exception "${entry}":`,
          err
        );
      }
    }

    Services.prefs.clearUserPref(PREF_LEGACY_SITE_EXCEPTIONS);
    Services.prefs.setBoolPref(PREF_SITE_EXCEPTIONS_MIGRATED, true);
  },

  async init() {
    if (this._initialized) {
      return;
    }

    Services.prefs.addObserver(PREF_BRANCH, this);
    this._initialized = true;

    this._migrateSiteExceptions();

    if (!this.isEnabled()) {
      return;
    }

    this._registerNetworkObservers();

    // Load the engine from the serialised cache synchronously so it is
    // ready before the first request arrives.
    this._tryInitFromCacheSync();
    lazy.EngineCache.cleanupStale().catch(err => {
      console.warn("[WaterfoxBlocker] Cache cleanup failed:", err);
    });

    await this._initializeEngineWithRetry();
  },

  isEnabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  },

  /**
   * Matching includes exact host and subdomain suffix matches for the stored
   * exception value: `example.com` matches `www.example.com`, while
   * `www.example.com` does not match `example.com`.
   *
   * @param {string} domain
   * @returns {boolean}
   */
  isSiteExcepted(domain) {
    return this._siteExceptions().isSiteExcepted(domain);
  },

  /**
   * @param {nsISupports|null} subject
   * @param {string} topic
   * @param {string} data
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

    if (topic === REMOTE_SETTINGS_POLL_END_TOPIC) {
      this._updateListsIfNeeded().catch(err => {
        console.warn(
          "[WaterfoxBlocker] List update on RS poll-end failed:",
          err
        );
      });
      return;
    }

    if (topic !== TOPIC_PREF_CHANGED) {
      return;
    }

    switch (data) {
      case PREF_ENABLED:
        if (this.isEnabled()) {
          this._registerNetworkObservers();
          this._initializeEngineWithRetry();
        } else {
          this._clearInitRetryTimer();
          this._unregisterNetworkObservers();
          this._stopListUpdateTriggers();
          this._clearBlockedCounts();
          this._clearTopLevelNavigationState();
          this._listUpdatesState = null;
          this._engine = null;
          this._engineInitPromise = null;
          this._initGeneration++;
        }
        break;

      case PREF_FILTER_LIST_URLS:
        if (this.isEnabled()) {
          this.refreshListsAndEngine().catch(err => {
            console.error(
              "[WaterfoxBlocker] Failed to refresh lists after pref change:",
              err
            );
          });
        }
        break;

      case PREF_ENABLED_LISTS:
        if (this.isEnabled()) {
          this._engine = null;
          this._initGeneration++;
          this.refreshListsAndEngine().catch(err => {
            console.error(
              "[WaterfoxBlocker] Failed to refresh lists after list toggle:",
              err
            );
          });
        }
        break;

      case PREF_REMOTE_RESOURCES_ENABLED:
        if (this.isEnabled() && this._engine) {
          lazy.Resources.load(this._engine).catch(err => {
            console.error(
              "[WaterfoxBlocker] Failed to reload resources after remoteResourcesEnabled change:",
              err
            );
          });
        }
        break;

      default:
        break;
    }
  },

  /**
   * @param {string} domain
   */
  removeSiteException(domain) {
    this._siteExceptions().removePermanentSiteException(domain);
  },

  /**
   * Bypass sources:
   * - Site exceptions stored in PermissionManager (persistent or session).
   * - Search partner exemptions when enabled.
   *
   * @param {string} candidateDomain Domain to test as a site exception or partner bypass.
   * @returns {boolean}
   */
  shouldBypassBlocking(candidateDomain) {
    const domain = String(candidateDomain || "").replace(/\.$/, "");
    if (!domain) {
      return false;
    }

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
   * Runs before every load (including loads served from internal caches) and
   * applies the same blocking logic as the observer path for requests that
   * are not top level.
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

    if (
      !contentLocation.schemeIs("http") &&
      !contentLocation.schemeIs("https")
    ) {
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

    const browserId = this._getTopBrowserId(loadInfo);
    if (this._shouldBypassLoadInfo(loadInfo)) {
      return ACCEPT;
    }

    const url = contentLocation.spec || "";
    if (!url) {
      return ACCEPT;
    }

    let hostname = "";
    try {
      hostname = contentLocation.host || "";
    } catch (_) {
      // nsIURI.host throws for URI types without an authority component.
    }

    const result = this.checkRequest(
      url,
      this._getPrincipalHost(loadInfo.loadingPrincipal),
      hostname,
      requestType,
      this._isThirdPartyLoadInfo(loadInfo)
    );
    if (!result.matched || result.exception) {
      return ACCEPT;
    }

    try {
      if (browserId) {
        this.incrementBlockedCount(browserId);
      }
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to increment blocked count:", err);
    }

    return REJECT_TYPE;
  },

  /**
   * Safe to call more than once.
   */
  uninit() {
    if (!this._initialized) {
      return;
    }

    try {
      Services.prefs.removeObserver(PREF_BRANCH, this);
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to remove pref observer:", err);
    }

    this._unregisterNetworkObservers();
    this._clearInitRetryTimer();
    this._stopListUpdateTriggers();
    this._clearBlockedCounts();
    this._clearTopLevelNavigationState();
    this._listUpdatesState = null;
    this._engine = null;
    this._engineInitPromise = null;
    this._initGeneration++;
    this.__thirdPartyUtil = undefined;
    this._siteExceptionsState = null;
    this._initialized = false;
  },
};
