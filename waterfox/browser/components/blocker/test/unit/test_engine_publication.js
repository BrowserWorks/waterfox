/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WaterfoxBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);
const { Resources } = ChromeUtils.importESModule(
  "resource:///modules/internal/Resources.sys.mjs"
);
const { RemoteResources } = ChromeUtils.importESModule(
  "resource:///modules/internal/RemoteResources.sys.mjs"
);
const { ListStore } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListStore.sys.mjs"
);

function makeEngine(rule = "||ads.example^") {
  const engine = Cc["@waterfox.com/waterfox-blocker-engine;1"].createInstance(
    Ci.nsIWaterfoxBlockerEngine
  );
  engine.initFromLists([rule]);
  return engine;
}

function deferred() {
  let resolve;
  const promise = new Promise(r => {
    resolve = r;
  });
  return { promise, resolve };
}

add_setup(function setup() {
  do_get_profile();
});

add_task(function test_published_engine_is_resource_complete_and_immutable() {
  const engine = makeEngine();
  Assert.throws(() => engine.publish(), /NS_ERROR_NOT_INITIALIZED/);
  Assert.equal(engine.publishedGeneration, 0);
  engine.useResources("[]");
  try {
    const generation = engine.publish();
    Assert.greater(generation, 0);
    Assert.equal(engine.publish(), generation, "Publication is idempotent");
    Assert.equal(engine.publishedGeneration, generation);
    const cache = engine.serialize();
    Assert.greater(cache.length, 0, "Published engines remain serializable");
    for (const mutate of [
      () => engine.initFromLists(["||replacement.example^"]),
      () => engine.initFromCache(cache),
      () => engine.useResources("[]"),
    ]) {
      Assert.throws(mutate, /NS_ERROR_NOT_AVAILABLE/);
    }
    engine.unpublish();
    Assert.throws(
      () => engine.publish(),
      /NS_ERROR_NOT_AVAILABLE/,
      "Retired publication tokens cannot reactivate an old engine"
    );
    Assert.equal(
      engine.publishedGeneration,
      generation,
      "Retired snapshots keep their identity"
    );
    Assert.throws(() => engine.useResources("[]"), /NS_ERROR_NOT_AVAILABLE/);
  } finally {
    engine.unpublish();
  }
});

add_task(async function test_resource_pending_failed_and_stale_candidates() {
  const original = {
    engine: WaterfoxBlockerService._engine,
    payload: WaterfoxBlockerService._resourcePayload,
    generation: WaterfoxBlockerService._initGeneration,
    isEnabled: WaterfoxBlockerService.isEnabled,
    load: Resources.load,
  };
  const previous = makeEngine();
  previous.useResources("[]");
  WaterfoxBlockerService.isEnabled = () => true;
  WaterfoxBlockerService._initGeneration = 5;
  WaterfoxBlockerService._publishEngine(previous, "[]");
  const publicationGeneration = previous.publishedGeneration;
  const pending = deferred();
  const candidate = makeEngine("||next.example^");
  Resources.load = async engine => {
    await pending.promise;
    engine.useResources("[]");
    return "[]";
  };
  try {
    const preparing = WaterfoxBlockerService._prepareAndPublishEngine(
      candidate,
      5
    );
    Assert.equal(
      WaterfoxBlockerService._engine,
      previous,
      "Pending resources retain the previous engine"
    );
    Assert.equal(candidate.publishedGeneration, 0);
    WaterfoxBlockerService._initGeneration = 6;
    pending.resolve();
    Assert.equal(await preparing, false, "Stale resources cannot publish");
    Assert.equal(WaterfoxBlockerService._engine, previous);
    Assert.equal(
      WaterfoxBlockerService._engine.publishedGeneration,
      publicationGeneration
    );

    Resources.load = async () => {
      throw new Error("Resources unavailable");
    };
    await Assert.rejects(
      WaterfoxBlockerService._prepareAndPublishEngine(makeEngine(), 6),
      /Resources unavailable/
    );
    Assert.equal(
      WaterfoxBlockerService._engine,
      previous,
      "Failed resources retain the previous engine"
    );
    Assert.equal(
      WaterfoxBlockerService._engine.publishedGeneration,
      publicationGeneration
    );

    Resources.load = original.load;
    const replacement = makeEngine("||next.example^");
    await WaterfoxBlockerService._prepareAndPublishEngine(replacement, 6);
    Assert.equal(WaterfoxBlockerService._engine, replacement);
    Assert.greater(replacement.publishedGeneration, publicationGeneration);
  } finally {
    pending.resolve();
    WaterfoxBlockerService._engine?.unpublish();
    WaterfoxBlockerService._engine = original.engine;
    WaterfoxBlockerService._resourcePayload = original.payload;
    WaterfoxBlockerService._initGeneration = original.generation;
    WaterfoxBlockerService.isEnabled = original.isEnabled;
    Resources.load = original.load;
  }
});

add_task(async function test_ready_waits_for_the_latest_build() {
  const original = WaterfoxBlockerService._engineInitPromise;
  const first = deferred();
  const second = deferred();
  let ready = false;
  try {
    WaterfoxBlockerService._engineInitPromise = first.promise;
    const waiting = WaterfoxBlockerService.whenEngineReady().then(() => {
      ready = true;
    });
    WaterfoxBlockerService._engineInitPromise = second.promise;
    first.resolve();
    await Promise.resolve();
    Assert.equal(
      ready,
      false,
      "A superseded build does not make the engine ready"
    );
    second.resolve();
    await waiting;
    Assert.equal(ready, true);
  } finally {
    first.resolve();
    second.resolve();
    WaterfoxBlockerService._engineInitPromise = original;
  }
});

add_task(async function test_update_rerun_does_not_wait_on_its_local_rebuild() {
  const originalWaiters = WaterfoxBlockerService._localRebuildWaiters;
  const originalPromise = WaterfoxBlockerService._engineInitPromise;
  const originalRerun = WaterfoxBlockerService._listUpdateRerunRequested;
  let waited = false;
  WaterfoxBlockerService._localRebuildWaiters = 1;
  WaterfoxBlockerService._engineInitPromise = {
    then() {
      waited = true;
    },
  };
  WaterfoxBlockerService._listUpdateRerunRequested = true;
  try {
    await WaterfoxBlockerService._runListUpdatePass();
    Assert.equal(
      waited,
      false,
      "A rerun cannot depend on a rebuild waiting for that rerun"
    );
    Assert.equal(WaterfoxBlockerService._listUpdateRerunRequested, false);
  } finally {
    WaterfoxBlockerService._localRebuildWaiters = originalWaiters;
    WaterfoxBlockerService._engineInitPromise = originalPromise;
    WaterfoxBlockerService._listUpdateRerunRequested = originalRerun;
  }
});

add_task(
  async function test_resource_reload_keeps_snapshots_and_skips_unchanged_payloads() {
    const original = {
      engine: WaterfoxBlockerService._engine,
      payload: WaterfoxBlockerService._resourcePayload,
      isEnabled: WaterfoxBlockerService.isEnabled,
      read: Resources.read,
    };
    const engine = makeEngine();
    engine.useResources("[]");
    WaterfoxBlockerService.isEnabled = () => true;
    WaterfoxBlockerService._publishEngine(engine, "[]");
    try {
      Resources.read = async () => "[]";
      await WaterfoxBlockerService._loadResourcesAndBumpGeneration();
      Assert.equal(
        WaterfoxBlockerService._engine,
        engine,
        "Unchanged resources keep the same engine"
      );
      const payload = JSON.stringify([
        {
          name: "probe.js",
          aliases: [],
          kind: { mime: "application/javascript" },
          content: "dm9pZCAwOw==",
        },
      ]);
      Resources.read = async () => payload;
      await WaterfoxBlockerService._loadResourcesAndBumpGeneration();
      Assert.notEqual(
        WaterfoxBlockerService._engine,
        engine,
        "Changed resources create a new snapshot"
      );
      Assert.greater(
        WaterfoxBlockerService._engine.publishedGeneration,
        engine.publishedGeneration
      );
      Assert.greater(
        engine.serialize().length,
        0,
        "Retired snapshots remain usable"
      );
    } finally {
      WaterfoxBlockerService._engine?.unpublish();
      WaterfoxBlockerService._engine = original.engine;
      WaterfoxBlockerService._resourcePayload = original.payload;
      WaterfoxBlockerService.isEnabled = original.isEnabled;
      Resources.read = original.read;
    }
  }
);

add_task(
  async function test_sync_resources_honor_remote_preference_and_fallback() {
    const bundle = RemoteResources.REMOTE_BUNDLES.find(
      entry => entry.name === "resources"
    );
    const path = ListStore.remoteResourceFilePath(bundle.name);
    const payload = [
      {
        name: "publication-probe.js",
        aliases: [],
        kind: { mime: "application/javascript" },
        content: "dm9pZCAwOw==",
      },
    ];
    const originalPreference = Services.prefs.getBoolPref(
      "waterfox.blocker.remoteResourcesEnabled",
      true
    );
    try {
      await ListStore.ensureRootDir();
      await IOUtils.writeJSON(path, payload);
      Services.prefs.setBoolPref(
        "waterfox.blocker.remoteResourcesEnabled",
        true
      );
      Assert.ok(
        RemoteResources.readMergedResourcesSync().some(
          entry => entry.name === payload[0].name
        )
      );
      Services.prefs.setBoolPref(
        "waterfox.blocker.remoteResourcesEnabled",
        false
      );
      Assert.ok(
        !RemoteResources.readMergedResourcesSync().some(
          entry => entry.name === payload[0].name
        )
      );
      Services.prefs.setBoolPref(
        "waterfox.blocker.remoteResourcesEnabled",
        true
      );
      await IOUtils.writeUTF8(path, "not JSON");
      Assert.ok(
        RemoteResources.readMergedResourcesSync().some(
          entry => entry.name === "noop.js"
        ),
        "Invalid profile resources fall back to bundled resources"
      );
    } finally {
      Services.prefs.setBoolPref(
        "waterfox.blocker.remoteResourcesEnabled",
        originalPreference
      );
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  }
);
