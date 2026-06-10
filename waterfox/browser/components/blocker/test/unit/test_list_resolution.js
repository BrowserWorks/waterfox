/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { EngineCache } = ChromeUtils.importESModule(
  "resource:///modules/internal/EngineCache.sys.mjs"
);
const {
  LIST_DESCRIPTOR_ORIGIN_CATALOG,
  LIST_DESCRIPTOR_ORIGIN_CUSTOM,
  ListCatalog,
} = ChromeUtils.importESModule(
  "resource:///modules/internal/ListCatalog.sys.mjs"
);
const { ListStore } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListStore.sys.mjs"
);
const { ListUpdatesState } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListUpdates.sys.mjs"
);
const { RemoteResources } = ChromeUtils.importESModule(
  "resource:///modules/internal/RemoteResources.sys.mjs"
);
const { WaterfoxBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);

do_get_profile();

const STORED_DESCRIPTOR = {
  bundledUrl: "resource://waterfox/blocker/assets/filters/stored.txt",
  filename: "stored.txt",
  listOrigin: LIST_DESCRIPTOR_ORIGIN_CATALOG,
  url: "https://example.com/stored.txt",
};
const FALLBACK_DESCRIPTOR = {
  bundledUrl: "resource://waterfox/blocker/assets/filters/fallback.txt",
  filename: "fallback.txt",
  listOrigin: LIST_DESCRIPTOR_ORIGIN_CATALOG,
  url: "https://example.com/fallback.txt",
};
const REMOTE_DESCRIPTOR = {
  bundledUrl: null,
  filename: "remote.txt",
  listOrigin: LIST_DESCRIPTOR_ORIGIN_CUSTOM,
  url: "https://example.com/remote.txt",
};
const DESCRIPTORS = [STORED_DESCRIPTOR, FALLBACK_DESCRIPTOR, REMOTE_DESCRIPTOR];

function record(descriptor, text) {
  return {
    filename: descriptor.filename,
    text,
    url: descriptor.url,
  };
}

function engineWithBytes(bytes) {
  return {
    serialize() {
      return new Uint8Array(bytes);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(promiseResolve => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function withMockedFetch(fetchImpl, task) {
  await task(fetchImpl);
}

async function withListPaths(name, task) {
  const listsDir = PathUtils.join(PathUtils.profileDir, name);
  const metadataPath = PathUtils.join(listsDir, "metadata.json");
  const listPath = filename => PathUtils.join(listsDir, filename);
  const originalListPath = ListStore.listPath;
  const originalListsMetadataPath = ListStore.listsMetadataPath;
  const originalEnsureListsDir = ListStore.ensureListsDir;

  await IOUtils.remove(listsDir, { ignoreAbsent: true, recursive: true });
  await IOUtils.makeDirectory(listsDir, {
    createAncestors: true,
    ignoreExisting: true,
  });
  ListStore.listPath = listPath;
  ListStore.listsMetadataPath = () => metadataPath;
  ListStore.ensureListsDir = async () => {};

  try {
    await task({ listPath, metadataPath });
  } finally {
    ListStore.listPath = originalListPath;
    ListStore.listsMetadataPath = originalListsMetadataPath;
    ListStore.ensureListsDir = originalEnsureListsDir;
    await IOUtils.remove(listsDir, { ignoreAbsent: true, recursive: true });
  }
}

add_task(
  function test_merge_list_records_fills_bundled_descriptors_by_identity() {
    const storedRecord = record(STORED_DESCRIPTOR, "||stored.example^\n");
    const customRecord = record(REMOTE_DESCRIPTOR, "||custom.example^\n");
    const fallbackStoredRecord = record(
      STORED_DESCRIPTOR,
      "||outdated.example^\n"
    );
    const fallbackRecord = record(FALLBACK_DESCRIPTOR, "||fallback.example^\n");

    Assert.deepEqual(
      ListCatalog.getMissingBundledListDescriptors(DESCRIPTORS, [
        storedRecord,
        customRecord,
      ]),
      [FALLBACK_DESCRIPTOR],
      "Only the missing bundled descriptor should need fallback data"
    );

    const merged = ListCatalog.mergeListRecords(
      DESCRIPTORS,
      [storedRecord, customRecord],
      [fallbackStoredRecord, fallbackRecord]
    );
    Assert.deepEqual(
      merged,
      [storedRecord, fallbackRecord, customRecord],
      "Stored records should win while missing records use bundled fallback"
    );
    Assert.ok(
      ListCatalog.hasAllBundledListRecords(DESCRIPTORS, merged),
      "Remote-only descriptors should not make the bundled baseline incomplete"
    );

    const wrongUrlRecord = {
      ...fallbackRecord,
      url: "https://example.com/wrong-fallback.txt",
    };
    Assert.deepEqual(
      ListCatalog.getMissingBundledListDescriptors(DESCRIPTORS, [
        storedRecord,
        wrongUrlRecord,
      ]),
      [FALLBACK_DESCRIPTOR],
      "Filename matches must not hide a URL identity mismatch"
    );
    Assert.deepEqual(
      ListCatalog.getMissingBundledListDescriptors(DESCRIPTORS, [
        storedRecord,
        record(FALLBACK_DESCRIPTOR, "   \n"),
      ]),
      [FALLBACK_DESCRIPTOR],
      "Whitespace-only list records should be treated as missing"
    );
  }
);

add_task(function test_custom_list_filenames_are_stable_by_url() {
  const firstUrl = "https://example.com/custom-a.txt";
  const secondUrl = "https://example.com/custom-b.txt";
  Assert.equal(
    ListCatalog.customListFilename(firstUrl),
    ListCatalog.customListFilename(firstUrl),
    "The same custom URL should always receive the same filename"
  );
  Assert.notEqual(
    ListCatalog.customListFilename(firstUrl),
    ListCatalog.customListFilename(secondUrl),
    "Different custom URLs should not share a cache filename"
  );
  Assert.ok(
    ListCatalog.isLegacyCustomListFilename("custom-2.txt"),
    "Positional custom-list filenames should be recognized for migration"
  );
  Assert.ok(
    !ListCatalog.isLegacyCustomListFilename("stored.txt"),
    "Catalog filenames should never be treated as legacy custom-list files"
  );
  Assert.ok(
    !ListCatalog.isLegacyCustomListFilename(
      ListCatalog.customListFilename(firstUrl)
    ),
    "Stable custom-list filenames should not be treated as positional files"
  );
});

add_task(
  async function test_legacy_custom_list_is_quarantined_by_url_metadata() {
    await withListPaths(
      "custom-list-filename-migration",
      async ({ listPath, metadataPath }) => {
        const url = "https://example.com/custom-b.txt";
        const descriptor = {
          bundledUrl: null,
          filename: ListCatalog.customListFilename(url),
          listOrigin: LIST_DESCRIPTOR_ORIGIN_CUSTOM,
          url,
        };
        const previousFilename = "custom-2.txt";
        const text = "||custom-b.example^\n";
        const metadata = {
          lists: [
            {
              etag: '"custom-b"',
              filename: previousFilename,
              lastAttempt: 1,
              lastError: "",
              lastFetched: 1,
              lastModified: "",
              url,
            },
          ],
        };
        await IOUtils.writeUTF8(listPath(previousFilename), text);
        await IOUtils.writeUTF8(metadataPath, JSON.stringify(metadata));

        const result = await ListStore.resolveLocalListRecords([descriptor]);
        Assert.deepEqual(
          result,
          {
            complete: true,
            listRecords: [],
          },
          "Unverified positional bytes should not enter the local engine"
        );
        Assert.ok(
          !(await IOUtils.exists(listPath(descriptor.filename))),
          "Local resolution should not publish bytes under the stable filename"
        );
        Assert.equal(
          await IOUtils.readUTF8(listPath(previousFilename)),
          text,
          "The positional file should remain available for a full refresh"
        );
        Assert.deepEqual(
          JSON.parse(await IOUtils.readUTF8(metadataPath)),
          metadata,
          "Metadata should keep the positional identity until refresh succeeds"
        );
      }
    );
  }
);

add_task(async function test_custom_list_migration_forces_full_fetch() {
  await withListPaths(
    "custom-list-304-migration",
    async ({ listPath, metadataPath }) => {
      const url = "https://example.com/custom-b.txt";
      const descriptor = {
        bundledUrl: null,
        filename: ListCatalog.customListFilename(url),
        listOrigin: LIST_DESCRIPTOR_ORIGIN_CUSTOM,
        url,
      };
      const previousFilename = "custom-2.txt";
      const oldText = "||wrong-custom-a.example^\n";
      const remoteText = "||custom-b.example^\n";
      await IOUtils.writeUTF8(listPath(previousFilename), oldText);
      await IOUtils.writeUTF8(
        metadataPath,
        JSON.stringify({
          lists: [
            {
              etag: '"custom-b"',
              filename: previousFilename,
              lastAttempt: 1,
              lastError: "",
              lastFetched: 1,
              lastModified: "",
              url,
            },
          ],
        })
      );

      const originalGetListDescriptors = ListCatalog.getListDescriptors;
      let fetchOptions = null;
      ListCatalog.getListDescriptors = async () => [descriptor];
      try {
        await withMockedFetch(
          async (_url, options) => {
            fetchOptions = options;
            return {
              body: null,
              headers: {
                get(name) {
                  return name.toLowerCase() === "etag"
                    ? '"custom-b-new"'
                    : null;
                },
              },
              ok: true,
              status: 200,
              text: async () => remoteText,
            };
          },
          async mockFetch => {
            const result = await new ListUpdatesState({
              fetchImpl: mockFetch,
            }).updateIfNeeded();
            Assert.equal(
              result?.anyUpdated,
              true,
              "Legacy custom-list bytes should be replaced by a full response"
            );
          }
        );
      } finally {
        ListCatalog.getListDescriptors = originalGetListDescriptors;
      }

      Assert.equal(
        fetchOptions?.headers.get("If-None-Match"),
        null,
        "Unverified migrated bytes should force an unconditional request"
      );
      Assert.equal(
        await IOUtils.readUTF8(listPath(descriptor.filename)),
        remoteText,
        "The full response should replace potentially misbound custom bytes"
      );
      Assert.ok(
        !(await IOUtils.exists(listPath(previousFilename))),
        "The old positional file should remain removed"
      );
      const metadata = JSON.parse(await IOUtils.readUTF8(metadataPath));
      Assert.equal(
        metadata.lists[0].filename,
        descriptor.filename,
        "Metadata should adopt the stable custom-list filename"
      );
      Assert.equal(
        metadata.lists[0].etag,
        '"custom-b-new"',
        "The full response should install its new validator"
      );
    }
  );
});

add_task(async function test_custom_list_migration_rejects_unconditional_304() {
  await withListPaths(
    "custom-list-unconditional-304",
    async ({ listPath, metadataPath }) => {
      const url = "https://example.com/custom-b.txt";
      const descriptor = {
        bundledUrl: null,
        filename: ListCatalog.customListFilename(url),
        listOrigin: LIST_DESCRIPTOR_ORIGIN_CUSTOM,
        url,
      };
      const previousFilename = "custom-2.txt";
      const oldText = "||wrong-custom-a.example^\n";
      await IOUtils.writeUTF8(listPath(previousFilename), oldText);
      await IOUtils.writeUTF8(
        metadataPath,
        JSON.stringify({
          lists: [
            {
              etag: '"custom-b"',
              filename: previousFilename,
              lastAttempt: 1,
              lastError: "",
              lastFetched: 1,
              lastModified: "yesterday",
              url,
            },
          ],
        })
      );

      const originalGetListDescriptors = ListCatalog.getListDescriptors;
      let fetchOptions = null;
      ListCatalog.getListDescriptors = async () => [descriptor];
      try {
        await withMockedFetch(
          async (_url, options) => {
            fetchOptions = options;
            return {
              body: null,
              headers: { get: () => null },
              ok: false,
              status: 304,
            };
          },
          async mockFetch => {
            const result = await new ListUpdatesState({
              fetchImpl: mockFetch,
            }).updateIfNeeded();
            Assert.equal(
              result?.anyUpdated,
              false,
              "An unconditional 304 should not update migrated bytes"
            );
          }
        );
      } finally {
        ListCatalog.getListDescriptors = originalGetListDescriptors;
      }

      Assert.equal(
        fetchOptions?.headers.get("If-None-Match"),
        null,
        "Legacy migration should not send the stale validator"
      );
      Assert.ok(
        !(await IOUtils.exists(listPath(descriptor.filename))),
        "A 304 should not publish potentially misbound bytes"
      );
      Assert.equal(
        await IOUtils.readUTF8(listPath(previousFilename)),
        oldText,
        "The legacy file should remain recoverable after a failed refresh"
      );
      const metadata = JSON.parse(await IOUtils.readUTF8(metadataPath));
      Assert.equal(
        metadata.lists[0].filename,
        previousFilename,
        "Failed migration should retain the legacy filename marker"
      );
      Assert.equal(
        metadata.lists[0].etag,
        "",
        "Failed migration should clear the stale ETag"
      );
      Assert.equal(
        metadata.lists[0].lastModified,
        "",
        "Failed migration should clear the stale modification time"
      );
      Assert.ok(
        metadata.lists[0].lastError.includes("Unexpected 304"),
        "Migration metadata should explain why the response was rejected"
      );
    }
  );
});

add_task(
  async function test_resolve_local_lists_backfills_only_missing_records() {
    const storedRecord = record(STORED_DESCRIPTOR, "||stored.example^\n");
    const customRecord = record(REMOTE_DESCRIPTOR, "||custom.example^\n");
    const fallbackRecord = record(FALLBACK_DESCRIPTOR, "||fallback.example^\n");
    const originalReadStoredLists = ListStore.readStoredLists;
    const originalReadBundledLists = ListStore.readBundledLists;
    const originalEnsureListsDir = ListStore.ensureListsDir;
    const originalListPath = ListStore.listPath;
    const originalWriteText = ListStore.writeText;
    let requestedBundledDescriptors = null;
    const writes = [];

    ListStore.readStoredLists = async () => [storedRecord, customRecord];
    ListStore.readBundledLists = async descriptors => {
      requestedBundledDescriptors = descriptors;
      return [fallbackRecord];
    };
    ListStore.ensureListsDir = async () => {};
    ListStore.listPath = filename => filename;
    ListStore.writeText = async (path, text) => {
      writes.push({ path, text });
    };

    try {
      const result =
        await WaterfoxBlockerService._resolveLocalListRecords(DESCRIPTORS);
      Assert.deepEqual(
        requestedBundledDescriptors,
        [FALLBACK_DESCRIPTOR],
        "Only missing bundled descriptors should be read"
      );
      Assert.deepEqual(
        result,
        {
          complete: true,
          listRecords: [storedRecord, fallbackRecord, customRecord],
        },
        "Local resolution should merge stored, bundled, and optional records"
      );
      Assert.deepEqual(
        writes,
        [{ path: FALLBACK_DESCRIPTOR.filename, text: fallbackRecord.text }],
        "Only the newly resolved fallback should be persisted"
      );
    } finally {
      ListStore.readStoredLists = originalReadStoredLists;
      ListStore.readBundledLists = originalReadBundledLists;
      ListStore.ensureListsDir = originalEnsureListsDir;
      ListStore.listPath = originalListPath;
      ListStore.writeText = originalWriteText;
    }
  }
);

add_task(async function test_bundled_fallback_clears_stale_validator() {
  await withListPaths(
    "bundled-fallback-validator",
    async ({ listPath, metadataPath }) => {
      const fallbackRecord = record(
        FALLBACK_DESCRIPTOR,
        "||fallback.example^\n"
      );
      const unrelatedEntry = {
        etag: '"stored"',
        filename: STORED_DESCRIPTOR.filename,
        lastAttempt: 1,
        lastError: "",
        lastFetched: 1,
        lastModified: "yesterday",
        url: STORED_DESCRIPTOR.url,
      };
      await IOUtils.writeUTF8(
        metadataPath,
        JSON.stringify({
          lists: [
            unrelatedEntry,
            {
              etag: '"missing-remote"',
              filename: FALLBACK_DESCRIPTOR.filename,
              lastAttempt: 2,
              lastError: "",
              lastFetched: 2,
              lastModified: "today",
              url: FALLBACK_DESCRIPTOR.url,
            },
          ],
        })
      );

      const originalReadBundledLists = ListStore.readBundledLists;
      ListStore.readBundledLists = async () => [fallbackRecord];
      try {
        await ListStore.resolveLocalListRecords([FALLBACK_DESCRIPTOR]);
      } finally {
        ListStore.readBundledLists = originalReadBundledLists;
      }

      Assert.equal(
        await IOUtils.readUTF8(listPath(FALLBACK_DESCRIPTOR.filename)),
        fallbackRecord.text,
        "The bundled fallback should be persisted"
      );
      const metadata = JSON.parse(await IOUtils.readUTF8(metadataPath));
      Assert.deepEqual(
        metadata.lists[0],
        unrelatedEntry,
        "Fallback persistence should preserve unrelated metadata"
      );
      Assert.deepEqual(
        metadata.lists[1],
        {
          etag: "",
          filename: FALLBACK_DESCRIPTOR.filename,
          lastAttempt: 2,
          lastError: "",
          lastFetched: 2,
          lastModified: "",
          url: FALLBACK_DESCRIPTOR.url,
        },
        "Fallback bytes should invalidate only their remote validators"
      );
    }
  );
});

add_task(
  async function test_local_fallback_and_remote_update_share_write_lock() {
    await withListPaths(
      "local-fallback-update-serialization",
      async ({ listPath }) => {
        const fallbackRecord = record(
          FALLBACK_DESCRIPTOR,
          "||fallback.example^\n"
        );
        const remoteText = "||remote.example^\n";
        const originalReadStoredLists = ListStore.readStoredLists;
        const originalReadBundledLists = ListStore.readBundledLists;
        const originalGetListDescriptors = ListCatalog.getListDescriptors;
        const bundledReadStarted = deferred();
        const resumeBundledRead = deferred();
        let fetchCount = 0;

        ListStore.readStoredLists = async () => [];
        ListStore.readBundledLists = async () => {
          bundledReadStarted.resolve();
          await resumeBundledRead.promise;
          return [fallbackRecord];
        };
        ListCatalog.getListDescriptors = async () => [FALLBACK_DESCRIPTOR];

        try {
          await withMockedFetch(
            async () => {
              fetchCount++;
              return {
                body: null,
                headers: { get: () => null },
                ok: true,
                status: 200,
                text: async () => remoteText,
              };
            },
            async mockFetch => {
              const resolvePromise = ListStore.resolveLocalListRecords([
                FALLBACK_DESCRIPTOR,
              ]);
              await bundledReadStarted.promise;
              const updatePromise = new ListUpdatesState({
                fetchImpl: mockFetch,
              }).updateIfNeeded();
              await Promise.resolve();
              Assert.equal(
                fetchCount,
                0,
                "Remote updates should wait for local fallback persistence"
              );
              resumeBundledRead.resolve();
              await Promise.all([resolvePromise, updatePromise]);
            }
          );

          Assert.equal(
            await IOUtils.readUTF8(listPath(FALLBACK_DESCRIPTOR.filename)),
            remoteText,
            "The newer remote update should win after serialized fallback writes"
          );
        } finally {
          resumeBundledRead.resolve();
          ListStore.readStoredLists = originalReadStoredLists;
          ListStore.readBundledLists = originalReadBundledLists;
          ListCatalog.getListDescriptors = originalGetListDescriptors;
        }
      }
    );
  }
);

add_task(
  async function test_refresh_builds_local_engine_before_remote_update() {
    const originalRebuildEngineFromCurrentSources =
      WaterfoxBlockerService._rebuildEngineFromCurrentSources;
    const originalUpdateListsIfNeeded =
      WaterfoxBlockerService._updateListsIfNeeded;
    const calls = [];

    WaterfoxBlockerService._rebuildEngineFromCurrentSources = async options => {
      calls.push({ options, step: "local" });
    };
    WaterfoxBlockerService._updateListsIfNeeded = async () => {
      calls.push({ step: "remote" });
    };

    try {
      await WaterfoxBlockerService.refreshListsAndEngine();
      Assert.deepEqual(
        calls,
        [
          {
            options: { preservePreviousEngine: true },
            step: "local",
          },
          { step: "remote" },
        ],
        "List refreshes should install the local engine before network updates"
      );
    } finally {
      WaterfoxBlockerService._rebuildEngineFromCurrentSources =
        originalRebuildEngineFromCurrentSources;
      WaterfoxBlockerService._updateListsIfNeeded = originalUpdateListsIfNeeded;
    }
  }
);

add_task(async function test_list_update_requests_queue_one_latest_rerun() {
  const originalRunListUpdatePass = WaterfoxBlockerService._runListUpdatePass;
  const originalInitialized = WaterfoxBlockerService._initialized;
  const originalIsEnabled = WaterfoxBlockerService.isEnabled;
  const originalUpdatePromise = WaterfoxBlockerService._listUpdatePromise;
  const originalRerunRequested =
    WaterfoxBlockerService._listUpdateRerunRequested;
  const firstPassStarted = deferred();
  const resumeFirstPass = deferred();
  let passCount = 0;

  WaterfoxBlockerService._initialized = true;
  WaterfoxBlockerService.isEnabled = () => true;
  WaterfoxBlockerService._listUpdatePromise = null;
  WaterfoxBlockerService._listUpdateRerunRequested = false;
  WaterfoxBlockerService._runListUpdatePass = async () => {
    passCount++;
    if (passCount === 1) {
      firstPassStarted.resolve();
      await resumeFirstPass.promise;
    }
  };

  try {
    const firstUpdate = WaterfoxBlockerService._updateListsIfNeeded();
    await firstPassStarted.promise;
    const secondUpdate = WaterfoxBlockerService._updateListsIfNeeded();
    resumeFirstPass.resolve();
    await Promise.all([firstUpdate, secondUpdate]);
    Assert.equal(
      passCount,
      2,
      "An update request arriving in flight should queue exactly one rerun"
    );
  } finally {
    resumeFirstPass.resolve();
    WaterfoxBlockerService._runListUpdatePass = originalRunListUpdatePass;
    WaterfoxBlockerService._initialized = originalInitialized;
    WaterfoxBlockerService.isEnabled = originalIsEnabled;
    WaterfoxBlockerService._listUpdatePromise = originalUpdatePromise;
    WaterfoxBlockerService._listUpdateRerunRequested = originalRerunRequested;
  }
});

add_task(async function test_local_rebuild_waiter_suppresses_update_rerun() {
  const originalInitialized = WaterfoxBlockerService._initialized;
  const originalGeneration = WaterfoxBlockerService._initGeneration;
  const originalIsEnabled = WaterfoxBlockerService.isEnabled;
  const originalEngineInitPromise = WaterfoxBlockerService._engineInitPromise;
  const originalListUpdates = WaterfoxBlockerService._listUpdates;
  const originalRefreshEngineAfterListUpdate =
    WaterfoxBlockerService._refreshEngineAfterListUpdate;
  const originalRemoteRefresh = RemoteResources.refresh;
  const originalLocalRebuildWaiters =
    WaterfoxBlockerService._localRebuildWaiters;
  const originalRerunRequested =
    WaterfoxBlockerService._listUpdateRerunRequested;

  WaterfoxBlockerService._initialized = true;
  WaterfoxBlockerService._initGeneration = 1;
  WaterfoxBlockerService.isEnabled = () => true;
  WaterfoxBlockerService._engineInitPromise = null;
  WaterfoxBlockerService._localRebuildWaiters = 1;
  WaterfoxBlockerService._listUpdateRerunRequested = false;
  WaterfoxBlockerService._listUpdates = () => ({
    async updateIfNeeded() {
      return { anyUpdated: true, descriptors: [] };
    },
  });
  WaterfoxBlockerService._refreshEngineAfterListUpdate = async () => false;
  RemoteResources.refresh = async () => {};

  try {
    await WaterfoxBlockerService._runListUpdatePass();
    Assert.equal(
      WaterfoxBlockerService._listUpdateRerunRequested,
      false,
      "A waiting local rebuild should run before another network update"
    );
  } finally {
    WaterfoxBlockerService._initialized = originalInitialized;
    WaterfoxBlockerService._initGeneration = originalGeneration;
    WaterfoxBlockerService.isEnabled = originalIsEnabled;
    WaterfoxBlockerService._engineInitPromise = originalEngineInitPromise;
    WaterfoxBlockerService._listUpdates = originalListUpdates;
    WaterfoxBlockerService._refreshEngineAfterListUpdate =
      originalRefreshEngineAfterListUpdate;
    RemoteResources.refresh = originalRemoteRefresh;
    WaterfoxBlockerService._localRebuildWaiters = originalLocalRebuildWaiters;
    WaterfoxBlockerService._listUpdateRerunRequested = originalRerunRequested;
  }
});

add_task(async function test_stale_cache_candidate_is_not_published() {
  const originalGeneration = WaterfoxBlockerService._initGeneration;
  const originalEngine = WaterfoxBlockerService._engine;
  const originalReadStoredLists = WaterfoxBlockerService._readStoredLists;
  const originalPreprocessListRecords =
    WaterfoxBlockerService._preprocessListRecords;
  const originalCreateEngine = WaterfoxBlockerService._createEngine;
  const originalMatchesCurrentLists = EngineCache.matchesCurrentLists;
  const originalCacheRead = EngineCache.read;
  const cacheReadStarted = deferred();
  const resumeCacheRead = deferred();
  const newerEngine = { name: "newer" };
  const candidate = {
    initFromCache() {},
  };

  WaterfoxBlockerService._initGeneration = 1;
  WaterfoxBlockerService._engine = null;
  WaterfoxBlockerService._readStoredLists = async () => [
    record(STORED_DESCRIPTOR, "||stored.example^\n"),
  ];
  WaterfoxBlockerService._preprocessListRecords = async records => records;
  WaterfoxBlockerService._createEngine = () => candidate;
  EngineCache.matchesCurrentLists = async () => true;
  EngineCache.read = async () => {
    cacheReadStarted.resolve();
    return resumeCacheRead.promise;
  };

  try {
    const cacheInit = WaterfoxBlockerService._tryInitFromCache(
      [STORED_DESCRIPTOR],
      1
    );
    await cacheReadStarted.promise;
    WaterfoxBlockerService._initGeneration = 2;
    WaterfoxBlockerService._engine = newerEngine;
    resumeCacheRead.resolve(new Uint8Array([1, 2, 3]));
    Assert.equal(
      await cacheInit,
      false,
      "A cache read from a stale generation should be discarded"
    );
    Assert.equal(
      WaterfoxBlockerService._engine,
      newerEngine,
      "A stale cache candidate should not replace the newer engine"
    );
  } finally {
    resumeCacheRead.resolve(new Uint8Array());
    WaterfoxBlockerService._initGeneration = originalGeneration;
    WaterfoxBlockerService._engine = originalEngine;
    WaterfoxBlockerService._readStoredLists = originalReadStoredLists;
    WaterfoxBlockerService._preprocessListRecords =
      originalPreprocessListRecords;
    WaterfoxBlockerService._createEngine = originalCreateEngine;
    EngineCache.matchesCurrentLists = originalMatchesCurrentLists;
    EngineCache.read = originalCacheRead;
  }
});

add_task(async function test_stale_list_update_cannot_replace_current_engine() {
  const originalGeneration = WaterfoxBlockerService._initGeneration;
  const originalIsEnabled = WaterfoxBlockerService.isEnabled;
  const originalResolveLocalListRecords =
    WaterfoxBlockerService._resolveLocalListRecords;
  let resolvedLists = false;

  WaterfoxBlockerService._initGeneration = 2;
  WaterfoxBlockerService.isEnabled = () => true;
  WaterfoxBlockerService._resolveLocalListRecords = async () => {
    resolvedLists = true;
    return { complete: true, listRecords: [] };
  };

  try {
    Assert.equal(
      await WaterfoxBlockerService._refreshEngineAfterListUpdate(true, [], 1),
      false,
      "A stale update generation should not apply"
    );
    Assert.equal(
      resolvedLists,
      false,
      "Stale updates should be rejected before reading or replacing lists"
    );
  } finally {
    WaterfoxBlockerService._initGeneration = originalGeneration;
    WaterfoxBlockerService.isEnabled = originalIsEnabled;
    WaterfoxBlockerService._resolveLocalListRecords =
      originalResolveLocalListRecords;
  }
});

add_task(async function test_incomplete_local_baseline_is_not_published() {
  const originalGeneration = WaterfoxBlockerService._initGeneration;
  const originalEngine = WaterfoxBlockerService._engine;
  const originalResolveLocalListRecords =
    WaterfoxBlockerService._resolveLocalListRecords;
  const originalPreprocessListRecords =
    WaterfoxBlockerService._preprocessListRecords;
  const originalCacheClear = EngineCache.clear;
  const originalCacheWrite = EngineCache.write;
  const previousEngine = { name: "previous" };
  let cacheCleared = false;
  let cacheWritten = false;
  let preprocessed = false;

  WaterfoxBlockerService._initGeneration = 1;
  WaterfoxBlockerService._engine = previousEngine;
  WaterfoxBlockerService._resolveLocalListRecords = async () => ({
    complete: false,
    listRecords: [record(STORED_DESCRIPTOR, "||stored.example^\n")],
  });
  WaterfoxBlockerService._preprocessListRecords = async records => {
    preprocessed = true;
    return records;
  };
  EngineCache.clear = async () => {
    cacheCleared = true;
  };
  EngineCache.write = async () => {
    cacheWritten = true;
    return true;
  };

  try {
    await Assert.rejects(
      WaterfoxBlockerService._initFromLocalSourcesAndCache(
        [STORED_DESCRIPTOR, FALLBACK_DESCRIPTOR],
        1
      ),
      /bundled filter list.*unavailable/,
      "An incomplete bundled baseline should fail local initialization"
    );
    Assert.equal(
      WaterfoxBlockerService._engine,
      previousEngine,
      "An incomplete local candidate should not replace the active engine"
    );
    Assert.equal(
      preprocessed,
      false,
      "Incomplete records should be rejected before engine preprocessing"
    );
    Assert.equal(
      cacheCleared,
      false,
      "A recoverable complete cache should remain available"
    );
    Assert.equal(
      cacheWritten,
      false,
      "Incomplete records should not be written to the engine cache"
    );
  } finally {
    WaterfoxBlockerService._initGeneration = originalGeneration;
    WaterfoxBlockerService._engine = originalEngine;
    WaterfoxBlockerService._resolveLocalListRecords =
      originalResolveLocalListRecords;
    WaterfoxBlockerService._preprocessListRecords =
      originalPreprocessListRecords;
    EngineCache.clear = originalCacheClear;
    EngineCache.write = originalCacheWrite;
  }
});

add_task(async function test_incomplete_update_keeps_current_engine() {
  const originalGeneration = WaterfoxBlockerService._initGeneration;
  const originalEngine = WaterfoxBlockerService._engine;
  const originalIsEnabled = WaterfoxBlockerService.isEnabled;
  const originalResolveLocalListRecords =
    WaterfoxBlockerService._resolveLocalListRecords;
  const originalPreprocessListRecords =
    WaterfoxBlockerService._preprocessListRecords;
  const originalScheduleInitRetry = WaterfoxBlockerService._scheduleInitRetry;
  const previousEngine = { name: "previous" };
  let preprocessed = false;
  let retryCount = 0;

  WaterfoxBlockerService._initGeneration = 1;
  WaterfoxBlockerService._engine = previousEngine;
  WaterfoxBlockerService.isEnabled = () => true;
  WaterfoxBlockerService._resolveLocalListRecords = async () => ({
    complete: false,
    listRecords: [record(STORED_DESCRIPTOR, "||stored.example^\n")],
  });
  WaterfoxBlockerService._preprocessListRecords = async records => {
    preprocessed = true;
    return records;
  };
  WaterfoxBlockerService._scheduleInitRetry = () => {
    retryCount++;
  };

  try {
    Assert.equal(
      await WaterfoxBlockerService._refreshEngineAfterListUpdate(
        true,
        [STORED_DESCRIPTOR, FALLBACK_DESCRIPTOR],
        1
      ),
      true,
      "An incomplete update should be handled without a network rerun loop"
    );
    Assert.equal(
      WaterfoxBlockerService._engine,
      previousEngine,
      "An incomplete update should preserve the active engine"
    );
    Assert.equal(
      preprocessed,
      false,
      "An incomplete update should not construct a degraded candidate"
    );
    Assert.equal(
      retryCount,
      1,
      "An incomplete update should schedule a local rebuild retry"
    );
  } finally {
    WaterfoxBlockerService._initGeneration = originalGeneration;
    WaterfoxBlockerService._engine = originalEngine;
    WaterfoxBlockerService.isEnabled = originalIsEnabled;
    WaterfoxBlockerService._resolveLocalListRecords =
      originalResolveLocalListRecords;
    WaterfoxBlockerService._preprocessListRecords =
      originalPreprocessListRecords;
    WaterfoxBlockerService._scheduleInitRetry = originalScheduleInitRetry;
  }
});

add_task(async function test_stale_local_candidate_is_not_published() {
  const originalGeneration = WaterfoxBlockerService._initGeneration;
  const originalEngine = WaterfoxBlockerService._engine;
  const originalResolveLocalListRecords =
    WaterfoxBlockerService._resolveLocalListRecords;
  const originalPreprocessListRecords =
    WaterfoxBlockerService._preprocessListRecords;
  const originalCreateEngineFromListRecords =
    WaterfoxBlockerService._createEngineFromListRecords;
  const originalCacheWrite = EngineCache.write;
  const previousEngine = { name: "previous" };
  const candidateEngine = { name: "candidate" };
  let cacheWritten = false;

  WaterfoxBlockerService._initGeneration = 1;
  WaterfoxBlockerService._engine = previousEngine;
  WaterfoxBlockerService._resolveLocalListRecords = async () => ({
    complete: true,
    listRecords: [record(STORED_DESCRIPTOR, "||stored.example^\n")],
  });
  WaterfoxBlockerService._preprocessListRecords = async records => records;
  WaterfoxBlockerService._createEngineFromListRecords = () => {
    WaterfoxBlockerService._initGeneration = 2;
    return candidateEngine;
  };
  EngineCache.write = async () => {
    cacheWritten = true;
    return true;
  };

  try {
    await WaterfoxBlockerService._initFromLocalSourcesAndCache(
      [STORED_DESCRIPTOR],
      1
    );
    Assert.equal(
      WaterfoxBlockerService._engine,
      previousEngine,
      "A candidate from a stale generation should not replace the engine"
    );
    Assert.equal(
      cacheWritten,
      false,
      "A candidate from a stale generation should not update the cache"
    );
  } finally {
    WaterfoxBlockerService._initGeneration = originalGeneration;
    WaterfoxBlockerService._engine = originalEngine;
    WaterfoxBlockerService._resolveLocalListRecords =
      originalResolveLocalListRecords;
    WaterfoxBlockerService._preprocessListRecords =
      originalPreprocessListRecords;
    WaterfoxBlockerService._createEngineFromListRecords =
      originalCreateEngineFromListRecords;
    EngineCache.write = originalCacheWrite;
  }
});

add_task(
  async function test_engine_cache_rejects_incomplete_bundled_baseline() {
    const storedRecord = record(STORED_DESCRIPTOR, "||stored.example^\n");
    const fallbackRecord = record(FALLBACK_DESCRIPTOR, "||fallback.example^\n");

    await EngineCache.clear();
    try {
      Assert.equal(
        await EngineCache.write(engineWithBytes([1, 2, 3]), DESCRIPTORS, [
          storedRecord,
        ]),
        false,
        "An incomplete bundled baseline should not be cached"
      );
      Assert.equal(
        await EngineCache.matchesCurrentLists(DESCRIPTORS, [storedRecord]),
        false,
        "An incomplete list set should never match a cache"
      );

      const completeRecords = [storedRecord, fallbackRecord];
      Assert.equal(
        await EngineCache.write(
          engineWithBytes([4, 5, 6]),
          DESCRIPTORS,
          completeRecords
        ),
        true,
        "A complete bundled baseline should be cached"
      );
      Assert.equal(
        await EngineCache.matchesCurrentLists(DESCRIPTORS, completeRecords),
        true,
        "The complete list set should match its cache metadata"
      );
      Assert.equal(
        await EngineCache.write(engineWithBytes([7, 8, 9]), DESCRIPTORS, [
          storedRecord,
        ]),
        false,
        "An incomplete rewrite should be rejected"
      );
      Assert.equal(
        await EngineCache.matchesCurrentLists(DESCRIPTORS, completeRecords),
        false,
        "Rejecting an incomplete rewrite should clear the stale complete cache"
      );
    } finally {
      await EngineCache.clear();
    }
  }
);
