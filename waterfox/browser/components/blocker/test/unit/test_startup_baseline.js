/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WaterfoxBlockerService: service } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);
const { ListCatalog } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListCatalog.sys.mjs"
);
const { ListStore } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListStore.sys.mjs"
);
const { EngineCache } = ChromeUtils.importESModule(
  "resource:///modules/internal/EngineCache.sys.mjs"
);
const { Resources } = ChromeUtils.importESModule(
  "resource:///modules/internal/Resources.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const PREF_ENABLED = "waterfox.blocker.enabled";
const PREF_LISTS = "waterfox.blocker.enabledLists";
const PREF_URLS = "waterfox.blocker.filterListUrls";
const CUSTOM_RULES =
  "||startup-resource.example^$script,redirect=noop.js\n" +
  "!#if env_firefox\n||startup-firefox.example^\n!#endif\n" +
  "!#if env_chromium\n||startup-chromium.example^\n!#endif\n" +
  "/__imp_apg__/*\n";

function check(url, type = "script", source = "publisher.example") {
  return JSON.parse(
    service._engine.checkRequestDetailed(
      url,
      source,
      new URL(url).hostname,
      type,
      "GET",
      new URL(url).hostname !== source
    )
  );
}

function makeChannel(url) {
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI("https://publisher.example/"),
    {}
  );
  return NetUtil.newChannel({
    uri: url,
    loadingPrincipal: principal,
    triggeringPrincipal: principal,
    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_SCRIPT,
  }).QueryInterface(Ci.nsIHttpChannel);
}

async function clearLocalSources() {
  await EngineCache.clear();
  await IOUtils.remove(ListStore.cacheRootPath(), {
    recursive: true,
    ignoreAbsent: true,
  });
}

async function withHeldInitialization(task, { enabled = true } = {}) {
  service.uninit();
  Services.prefs.setBoolPref(PREF_ENABLED, enabled);
  const moduleGlobal = Cu.getGlobalForObject(ListStore);
  const original = {
    initialize: service._initializeEngineIfNeeded,
    retry: service._initializeEngineWithRetry,
    triggers: service._startListUpdateTriggers,
    updates: service._updateListsIfNeeded,
    refresh: service.refreshListsAndEngine,
    fetch: moduleGlobal.fetch,
  };
  let release;
  const held = new Promise(resolve => (release = resolve));
  const pending = [];
  let asyncStarts = 0;
  let fetchCalls = 0;
  service._initializeEngineIfNeeded = function () {
    asyncStarts++;
    this._engineInitPromise = held;
    return held;
  };
  service._initializeEngineWithRetry = function () {
    const promise = original.retry.call(this);
    pending.push(promise);
    return promise;
  };
  service._startListUpdateTriggers = () => {};
  service._updateListsIfNeeded = async () => {};
  service.refreshListsAndEngine = async () => {};
  moduleGlobal.fetch = () => {
    fetchCalls++;
    throw new Error("Startup must not fetch any resource asynchronously");
  };
  Assert.equal(Cu.getGlobalForObject(ListCatalog), moduleGlobal);
  Assert.equal(Cu.getGlobalForObject(Resources), moduleGlobal);
  Assert.throws(
    () => moduleGlobal.fetch("https://startup-network.example/"),
    /must not fetch/
  );
  fetchCalls = 0;
  const starts = [];
  const state = {
    start() {
      const before = Date.now();
      starts.push(service.init());
      return Date.now() - before;
    },
    get asyncStarts() {
      return asyncStarts;
    },
    assertReady() {
      Assert.greater(service._engine?.publishedGeneration || 0, 0);
      Assert.greater(JSON.parse(service._resourcePayload).length, 0);
      Assert.equal(
        service._engineInitPromise,
        held,
        "Async initialization is held"
      );
      Assert.equal(
        fetchCalls,
        0,
        "The synchronous baseline does not use fetch"
      );
      const channel = makeChannel("https://ad.doubleclick.net/ad.js");
      Assert.equal(service._engine.ownsNetworkChannel(channel), true);
      Assert.equal(
        check(channel.URI.spec).matched,
        true,
        "Bundled rules are live"
      );
      Assert.ok(
        check("https://startup-resource.example/ad.js").redirect.startsWith(
          "data:"
        ),
        "Redirect resources were attached before native publication"
      );
      Assert.equal(
        check("https://startup-firefox.example/ad.js").matched,
        true
      );
      Assert.equal(
        check("https://startup-chromium.example/ad.js").matched,
        false
      );
      Assert.equal(
        check(
          "https://securej.chase.com/__imp_apg__/api/dip/v1/dip",
          "xmlhttprequest",
          "secure.chase.com"
        ).exception,
        true,
        "The preprocessed Waterfox unbreak record is included"
      );
    },
  };
  try {
    await task(state);
  } finally {
    release();
    await Promise.all([...starts, ...pending]);
    service.uninit();
    service._initializeEngineIfNeeded = original.initialize;
    service._initializeEngineWithRetry = original.retry;
    service._startListUpdateTriggers = original.triggers;
    service._updateListsIfNeeded = original.updates;
    service.refreshListsAndEngine = original.refresh;
    moduleGlobal.fetch = original.fetch;
  }
}

async function prepareFreshSources(corrupt = false) {
  await clearLocalSources();
  Services.prefs.setStringPref(PREF_LISTS, "{}");
  Services.prefs.setStringPref(PREF_URLS, "[]");
  await ListStore.setCustomFiltersText(CUSTOM_RULES);
  if (corrupt) {
    await IOUtils.write(
      PathUtils.join(
        ListStore.cacheRootPath(),
        `adblock-engine.${Services.appinfo.appBuildID}.cache`
      ),
      new Uint8Array([0, 1, 2, 3])
    );
  }
}

function logStartupTiming(mode, milliseconds) {
  const descriptors = ListCatalog.getListDescriptorsSync();
  const { complete, listRecords } =
    ListStore.resolveLocalListRecordsSync(descriptors);
  Assert.equal(complete, true);
  const bundled = listRecords.filter(record =>
    descriptors.some(
      descriptor =>
        descriptor.bundledUrl && descriptor.filename === record.filename
    )
  );
  const bytes = bundled.reduce(
    (total, record) => total + new TextEncoder().encode(record.text).length,
    0
  );
  Assert.greater(
    bytes,
    100000,
    "Timing uses the real packaged lists, not a tiny fixture"
  );
  info(
    `SYNC_STARTUP_TIMING ${JSON.stringify({
      mode,
      milliseconds,
      bundledLists: bundled.length,
      bundledBytes: bytes,
    })}`
  );
}

add_setup(function setupStartupBaseline() {
  do_get_profile();
  Services.prefs.setBoolPref("waterfox.blocker.allowSearchPartnerAds", false);
  Services.prefs.setBoolPref("waterfox.blocker.remoteResourcesEnabled", false);
  Services.prefs.setBoolPref("waterfox.blocker.siteExceptions.migrated", true);
  Services.prefs.setStringPref("waterfox.blocker.domainExceptions", "{}");
  registerCleanupFunction(() => service.uninit());
});

for (const corrupt of [false, true]) {
  add_task(async function test_baseline_is_published_before_init_yields() {
    await prepareFreshSources(corrupt);
    await withHeldInitialization(async state => {
      const elapsed = state.start();
      state.assertReady();
      logStartupTiming(corrupt ? "corrupt-cache" : "missing-cache", elapsed);
      const engine = service._engine;
      const channel = makeChannel("https://ad.doubleclick.net/ad.js");
      let calls = 0;
      await new Promise(resolve =>
        engine.checkChannel(channel, status => {
          Assert.equal(status, Cr.NS_OK);
          Assert.equal(++calls, 1);
          resolve();
        })
      );
      Assert.equal(
        channel.status,
        Cr.NS_ERROR_ABORT,
        "A first native channel is blocked while async initialization is still held"
      );
      Assert.equal(service._engine, engine);
    });
  });
}

add_task(
  async function test_reenable_publishes_before_pref_notification_returns() {
    await prepareFreshSources();
    await withHeldInitialization(
      async state => {
        state.start();
        Assert.equal(
          service._engine,
          null,
          "Disabled startup does not publish"
        );
        Assert.equal(state.asyncStarts, 0);
        const before = Date.now();
        Services.prefs.setBoolPref(PREF_ENABLED, true);
        const elapsed = Date.now() - before;
        state.assertReady();
        Assert.equal(state.asyncStarts, 1);
        logStartupTiming("reenable", elapsed);
      },
      { enabled: false }
    );
  }
);

add_task(async function test_catalog_sync_and_async_share_selection() {
  const originalSync = ListCatalog.loadCatalogSync;
  const originalAsync = ListCatalog.loadCatalog;
  const locale = (
    Services.locale.appLocaleAsBCP47?.split("-")[0] || ""
  ).toLowerCase();
  const source = id => ({
    url: `https://lists.example/${id}`,
    filename: `${id}.txt`,
  });
  const catalog = [
    { id: "disabled", default_enabled: true, sources: [source("disabled")] },
    { id: "forced", default_enabled: false, sources: [source("forced")] },
    {
      id: "regional",
      category: "regional",
      langs: [locale],
      sources: [source("regional")],
    },
    {
      id: "other-language",
      category: "regional",
      langs: ["not-a-locale"],
      sources: [source("other-language")],
    },
  ];
  ListCatalog.loadCatalogSync = () => catalog;
  ListCatalog.loadCatalog = async () => catalog;
  Services.prefs.setStringPref(PREF_LISTS, '{"disabled":false,"forced":true}');
  Services.prefs.setStringPref(PREF_URLS, '["https://custom.example/list"]');
  try {
    const synchronous = ListCatalog.getListDescriptorsSync();
    Assert.deepEqual(synchronous, await ListCatalog.getListDescriptors());
    Assert.deepEqual(
      synchronous.map(descriptor => descriptor.filename),
      [
        "forced.txt",
        "regional.txt",
        ListCatalog.customListFilename("https://custom.example/list"),
        ListCatalog.customFiltersDescriptor().filename,
      ]
    );
  } finally {
    ListCatalog.loadCatalogSync = originalSync;
    ListCatalog.loadCatalog = originalAsync;
    Services.prefs.setStringPref(PREF_LISTS, "{}");
    Services.prefs.setStringPref(PREF_URLS, "[]");
  }
});

add_task(
  async function test_sync_local_resolution_preserves_profile_and_quarantine() {
    await clearLocalSources();
    await IOUtils.makeDirectory(ListStore.listsDirPath(), {
      createAncestors: true,
    });
    const modernUrl = "https://startup-profile.example/modern";
    const legacyUrl = "https://startup-profile.example/legacy";
    Services.prefs.setStringPref(
      PREF_URLS,
      JSON.stringify([modernUrl, legacyUrl])
    );
    Services.prefs.setStringPref(PREF_LISTS, "{}");
    const descriptors = ListCatalog.getListDescriptorsSync();
    const stored = descriptors.find(descriptor => descriptor.bundledUrl);
    await IOUtils.writeUTF8(
      ListStore.listPath(stored.filename),
      "||startup-stored.example^\n"
    );
    await IOUtils.writeUTF8(
      ListStore.listPath(ListCatalog.customListFilename(modernUrl)),
      "||startup-modern.example^\n"
    );
    await IOUtils.writeUTF8(
      ListStore.listPath(ListCatalog.customListFilename(legacyUrl)),
      "||startup-legacy.example^\n"
    );
    await IOUtils.writeUTF8(
      ListStore.listPath("custom-1.txt"),
      "||startup-legacy.example^\n"
    );
    await IOUtils.writeJSON(ListStore.listsMetadataPath(), {
      lists: [{ url: legacyUrl, filename: "custom-1.txt" }],
    });
    await ListStore.setCustomFiltersText(CUSTOM_RULES);
    const synchronous = ListStore.resolveLocalListRecordsSync(descriptors);
    Assert.equal(synchronous.complete, true);
    Assert.equal(
      synchronous.listRecords.find(
        record => record.filename === stored.filename
      ).text,
      "||startup-stored.example^\n"
    );
    Assert.ok(synchronous.listRecords.some(record => record.url === modernUrl));
    Assert.ok(
      !synchronous.listRecords.some(record => record.url === legacyUrl)
    );
    Assert.deepEqual(
      synchronous,
      await ListStore.resolveLocalListRecords(descriptors)
    );
    await withHeldInitialization(async state => {
      state.start();
      Assert.greater(service._engine.publishedGeneration, 0);
      Assert.equal(check("https://startup-stored.example/ad.js").matched, true);
      Assert.equal(check("https://startup-modern.example/ad.js").matched, true);
      Assert.equal(
        check("https://startup-legacy.example/ad.js").matched,
        false
      );
      Assert.equal(
        check("https://startup-firefox.example/ad.js").matched,
        true
      );
      Assert.ok(
        check("https://startup-resource.example/ad.js").redirect.startsWith(
          "data:"
        )
      );
    });
    Services.prefs.setStringPref(PREF_URLS, "[]");
  }
);

add_task(
  async function test_warm_cache_still_attaches_resources_synchronously() {
    await prepareFreshSources();
    await withHeldInitialization(async state => {
      state.start();
      state.assertReady();
      const serialized = service._engine.serialize();
      const descriptors = ListCatalog.getListDescriptorsSync();
      const { listRecords } =
        ListStore.resolveLocalListRecordsSync(descriptors);
      const processed = await service._preprocessListRecords(listRecords);
      await EngineCache.write(service._engine, descriptors, processed);
      service.uninit();
      const original = ListStore.resolveLocalListRecordsSync;
      ListStore.resolveLocalListRecordsSync = () => {
        throw new Error("Warm startup should not rebuild text sources");
      };
      try {
        const elapsed = state.start();
        state.assertReady();
        Assert.deepEqual(service._engine.serialize(), serialized);
        info(
          `SYNC_STARTUP_TIMING ${JSON.stringify({ mode: "warm-cache", milliseconds: elapsed })}`
        );
      } finally {
        ListStore.resolveLocalListRecordsSync = original;
      }
    });
  }
);

add_task(async function test_no_selected_rules_reject_stale_warm_cache() {
  await prepareFreshSources();
  await withHeldInitialization(async state => {
    state.start();
    state.assertReady();
    const descriptors = ListCatalog.getListDescriptorsSync();
    const { listRecords } = ListStore.resolveLocalListRecordsSync(descriptors);
    await EngineCache.write(
      service._engine,
      descriptors,
      await service._preprocessListRecords(listRecords)
    );
  });
  Services.prefs.setStringPref(
    PREF_LISTS,
    JSON.stringify(
      Object.fromEntries(
        ListCatalog.loadCatalogSync().map(entry => [entry.id, false])
      )
    )
  );
  await ListStore.setCustomFiltersText(
    "!#if env_chromium\n||startup-disabled.example^\n!#endif\n"
  );
  await withHeldInitialization(async state => {
    state.start();
    Assert.equal(
      service._engine,
      null,
      "An old cache cannot override an intentionally empty selection"
    );
    Assert.equal(service._resourcePayload, null);
  });
});

add_task(async function test_disabled_and_no_selected_rules_do_not_publish() {
  await clearLocalSources();
  const overrides = Object.fromEntries(
    ListCatalog.loadCatalogSync().map(entry => [entry.id, false])
  );
  Services.prefs.setStringPref(PREF_LISTS, JSON.stringify(overrides));
  Services.prefs.setStringPref(PREF_URLS, "[]");
  await ListStore.setCustomFiltersText("! no selected rules\n");
  await withHeldInitialization(async state => {
    state.start();
    Assert.equal(
      service._engine,
      null,
      "Unbreak exceptions alone are not a fake baseline"
    );
    Assert.equal(service._resourcePayload, null);
    await service._doInitializeEngineIfNeeded();
    Assert.equal(
      service._engine,
      null,
      "Async verification also rejects an unbreak-only selection"
    );
    Assert.equal(
      Cc["@waterfox.com/waterfox-blocker-engine;1"]
        .createInstance(Ci.nsIWaterfoxBlockerEngine)
        .ownsNetworkChannel(makeChannel("https://ad.doubleclick.net/ad.js")),
      false
    );
  });
  const original = ListStore.resolveLocalListRecordsSync;
  ListStore.resolveLocalListRecordsSync = () => {
    throw new Error("Disabled startup must not read local filters");
  };
  try {
    await withHeldInitialization(
      async state => {
        state.start();
        Assert.equal(service._engine, null);
        Assert.equal(state.asyncStarts, 0);
      },
      { enabled: false }
    );
  } finally {
    ListStore.resolveLocalListRecordsSync = original;
    Services.prefs.setStringPref(PREF_LISTS, "{}");
  }
});

add_task(
  async function test_failed_local_candidate_retains_published_generation() {
    await prepareFreshSources();
    await withHeldInitialization(async state => {
      state.start();
      state.assertReady();
      const previous = service._engine;
      const generation = previous.publishedGeneration;
      const payload = service._resourcePayload;
      const originalResources = Resources.loadSync;
      const originalResolve = ListStore.resolveLocalListRecordsSync;
      try {
        Resources.loadSync = () => {
          throw new Error("Deliberately unavailable resources");
        };
        service._initFromLocalSourcesSync();
        Assert.equal(service._engine, previous);
        Assert.equal(service._engine.publishedGeneration, generation);
        Assert.equal(service._resourcePayload, payload);
        Resources.loadSync = candidate => {
          const resources = originalResources(candidate);
          service._initGeneration++;
          return resources;
        };
        service._initFromLocalSourcesSync();
        Assert.equal(
          service._engine,
          previous,
          "A superseded local candidate cannot publish"
        );
        Assert.equal(service._resourcePayload, payload);
        Resources.loadSync = originalResources;
        ListStore.resolveLocalListRecordsSync = () => ({
          complete: false,
          listRecords: [],
        });
        service._initFromLocalSourcesSync();
        Assert.equal(service._engine, previous);
        Assert.equal(previous.publishedGeneration, generation);
        Assert.equal(check("https://ad.doubleclick.net/ad.js").matched, true);
      } finally {
        Resources.loadSync = originalResources;
        ListStore.resolveLocalListRecordsSync = originalResolve;
      }
    });
  }
);

add_task(
  async function test_sync_reads_reject_network_and_invalid_custom_filters() {
    Assert.throws(
      () => ListStore.readLocalTextSync("https://example.com/not-a-local-list"),
      /must be local/
    );
    await clearLocalSources();
    await IOUtils.makeDirectory(ListStore.cacheRootPath(), {
      createAncestors: true,
    });
    const descriptor = ListCatalog.customFiltersDescriptor();
    for (const bytes of [
      new Uint8Array([0xff]),
      new Uint8Array(ListStore.MAX_CUSTOM_FILTERS_BYTES + 1),
    ]) {
      await IOUtils.write(ListStore.customFiltersPath(), bytes);
      Assert.deepEqual(ListStore.readStoredListsSync([descriptor]), []);
      Assert.deepEqual(await ListStore.readStoredLists([descriptor]), []);
    }
  }
);
