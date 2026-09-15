/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  LiveBookmarksService,
  MAX_FEED_URL_LENGTH,
  parseOPML,
  serializeOPML,
  validateSubscriptionURL,
} = ChromeUtils.importESModule("resource:///modules/LiveBookmarks.sys.mjs");
const { PlacesUtils: LBPlaces } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { TestUtils: LBTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const { HttpServer: LBHttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

const LB_HOUR = 60 * 60 * 1000;
const LB_LIMIT = 2 * 1024 * 1024;
const LB_CACHE_FEED_LIMIT = 128 * 1024;
const LB_CACHE_LIMIT = 32 * 1024 * 1024;
const LB_TOPIC = "waterfox-live-bookmarks-changed";
const LB_FEED = {
  title: "Feed title",
  siteURL: "https://example.org/",
  items: [{ id: "one", title: "An entry", url: "https://example.org/one" }],
};

function lbClock() {
  let time = 1700000000000;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    advance: amount => {
      time += amount;
    },
    fire(delay) {
      for (const [id, timer] of Array.from(timers)) {
        if (timer.delay == delay) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    timers,
  };
}

function lbResponse(overrides = {}) {
  return {
    status: 200,
    bytes: new TextEncoder().encode("<rss/>"),
    charset: "",
    etag: '"v1"',
    lastModified: "Mon, 01 Jan 2024 00:00:00 GMT",
    ...overrides,
  };
}

async function lbRejected(promise, pattern) {
  await Assert.rejects(promise, pattern);
}

function lbDeferredDownload() {
  const requests = [];
  return {
    requests,
    download(url, options) {
      const deferred = Promise.withResolvers();
      options.signal.addEventListener(
        "abort",
        () => deferred.reject(options.signal.reason),
        { once: true }
      );
      requests.push({ url, ...options, ...deferred });
      return deferred.promise;
    },
  };
}

async function lbHarness(options = {}) {
  do_get_profile();
  const parent = await LBPlaces.bookmarks.insert({
    parentGuid: LBPlaces.bookmarks.unfiledGuid,
    type: LBPlaces.bookmarks.TYPE_FOLDER,
    title: "Live Bookmarks service test",
  });
  const path = PathUtils.join(
    PathUtils.profileDir,
    `live-bookmarks-service-test-${parent.guid}.json`
  );
  const clock = options.clock || lbClock();
  const service = new LiveBookmarksService({
    path,
    clock,
    download: async () => lbResponse(),
    parser: () => LB_FEED,
    ...options,
  });
  registerCleanupFunction(async () => {
    await service.shutdown();
    if (await LBPlaces.bookmarks.fetch(parent.guid)) {
      await LBPlaces.bookmarks.remove(parent.guid);
    }
    for (const suffix of ["", ".tmp", ".cache", ".cache.tmp"]) {
      await IOUtils.remove(`${path}${suffix}`, { ignoreAbsent: true });
    }
  });
  return { service, parentGuid: parent.guid, path, clock };
}

async function lbRestart(path, options = {}) {
  const clock = options.clock || lbClock();
  const requests = [];
  let initialized = false;
  const download = options.download || (async () => lbResponse());
  const service = new LiveBookmarksService({
    path,
    clock,
    parser: () => LB_FEED,
    ...options,
    download: (url, requestOptions) => {
      requests.push({ url, ...requestOptions });
      Assert.ok(initialized, "Initialization must not download feeds");
      return download(url, requestOptions);
    },
  });
  registerCleanupFunction(() => service.shutdown());
  await service.init();
  initialized = true;
  return { service, clock, requests };
}

function lbCacheRecord({ guid, feedURL }, feed = LB_FEED) {
  return { guid, feedURL, feed: structuredClone(feed) };
}

function lbCacheSize(record) {
  return new TextEncoder().encode(JSON.stringify(record)).length;
}

function lbHTTPHarness(options = {}) {
  return lbHarness({
    ...options,
    download: undefined,
  });
}

function lbOPML(count, prefix = "https://example.org/") {
  return serializeOPML(
    Array.from({ length: count }, (_, i) => ({
      title: `Feed ${i}`,
      feedURL: `${prefix}${i}`,
    }))
  );
}

add_task(function opml_is_pure_safe_and_round_trips() {
  const entries = [
    {
      title: 'A & <B> "quoted"\n\tCafé',
      feedURL: "https://example.org/feed?a=1&b=2",
    },
  ];
  Assert.deepEqual(parseOPML(serializeOPML(entries)), entries);
  Assert.deepEqual(
    parseOPML(
      '<opml version="2.0"><body><outline text="Folder"><outline text="First" xmlUrl="https://example.org/feed#one"/><outline text="Duplicate" xmlUrl="https://example.org/feed#two"/></outline></body></opml>'
    ),
    [{ title: "First", feedURL: "https://example.org/feed" }]
  );
  for (const xml of [
    "<opml><body>",
    "<rss/>",
    "<opml><body/><body/></opml>",
    '<!DOCTYPE opml [<!ENTITY x SYSTEM "file:///etc/passwd">]><opml><body/></opml>',
    '<opml><body><outline xmlUrl="javascript:alert(1)"/></body></opml>',
    '<opml><body><outline xmlUrl="https://user:password@example.org/"/></body></opml>',
    '<opml><body><outline type="rss"/></body></opml>',
    " ".repeat(LB_LIMIT + 1),
  ]) {
    Assert.throws(
      () => parseOPML(xml),
      /./,
      "Invalid or unsafe OPML is rejected"
    );
  }
  Assert.throws(
    () => serializeOPML([{ title: "Unsafe", feedURL: "file:///tmp/feed" }]),
    /HTTP/
  );
});

add_task(async function create_validates_before_inserting_and_deduplicates() {
  const pending = lbDeferredDownload();
  const { service, parentGuid } = await lbHarness({
    download: pending.download,
  });
  Assert.throws(() => service.list(), /init/);
  const firstInit = service.init();
  Assert.equal(service.init(), firstInit, "Initialization is shared");
  await firstInit;
  Assert.equal(service.get("missing_____"), null);
  Assert.equal(service.peek("missing_____"), null);
  const first = service.create({
    feedURL: "https://example.org/feed#first",
    parentGuid,
  });
  const second = service.create({
    feedURL: "https://EXAMPLE.org:443/feeds/../feed#second",
    title: "A different subscription title",
    parentGuid,
  });
  await LBTestUtils.waitForCondition(
    () => pending.requests.length == 1,
    "Only one validation download"
  );
  Assert.equal(service.list().length, 0);
  Assert.equal(
    service.getByFeedURL("https://example.org/feed"),
    null,
    "Pending creations are not subscriptions"
  );
  Assert.equal(
    await LBPlaces.bookmarks.fetch({ parentGuid, index: 0 }),
    null,
    "No placeholder before successful parsing"
  );
  pending.requests[0].resolve(lbResponse());
  const subscription = await first;
  Assert.equal(await second, subscription, "Concurrent creates share a result");
  Assert.equal(
    service.getByFeedURL("https://EXAMPLE.org:443/feed#lookup"),
    subscription,
    "URL lookup returns the same subscription regardless of title"
  );
  Assert.deepEqual(Object.keys(subscription).sort(), [
    "feedURL",
    "guid",
    "siteURL",
    "title",
  ]);
  Assert.equal(subscription.title, LB_FEED.title);
  Assert.equal(
    (await LBPlaces.bookmarks.fetch(subscription.guid)).type,
    LBPlaces.bookmarks.TYPE_FOLDER
  );
  Assert.equal(
    await LBPlaces.bookmarks.fetch({ parentGuid: subscription.guid, index: 0 }),
    null,
    "Entries are not Places bookmarks"
  );
  Assert.equal(service.peek(subscription.guid).status, "ready");
  const feed = await service.refresh(subscription.guid);
  Assert.deepEqual(feed, LB_FEED);
  Assert.equal(pending.requests.length, 1, "Creation seeds the memory cache");
  Assert.ok(Object.isFrozen(feed.items[0]), "Callers cannot mutate the cache");
  service.list().pop();
  Assert.equal(
    service.list().length,
    1,
    "The returned list is not the internal collection"
  );
});

add_task(async function feed_url_lookup_is_synchronous_and_title_independent() {
  let downloads = 0;
  const { service, parentGuid } = await lbHarness({
    download: async () => {
      downloads++;
      return lbResponse();
    },
  });
  const feedURL = "https://example.org/feed";
  for (const value of [feedURL, null, "not a URL"]) {
    Assert.throws(() => service.getByFeedURL(value), /init/);
  }
  await service.init();
  Assert.equal(service.getByFeedURL(feedURL), null);
  const subscription = await service.create({ feedURL, parentGuid });
  Assert.equal(service.getByFeedURL(feedURL), subscription);
  Assert.ok(Object.isFrozen(service.getByFeedURL(feedURL)));
  const title = "My renamed feed";
  await LBPlaces.bookmarks.update({ guid: subscription.guid, title });
  const renamed = service.getByFeedURL(
    "https://EXAMPLE.org:443/feeds/../feed#ignored"
  );
  Assert.equal(renamed, service.get(subscription.guid));
  Assert.equal(renamed.title, title, "Return the stored native folder title");
  Assert.equal(
    await service.create({ feedURL: feedURL + "#duplicate", title: "Other" }),
    renamed,
    "A new title does not create a second subscription"
  );
  Assert.equal(
    (await LBPlaces.bookmarks.fetch(subscription.guid)).parentGuid,
    parentGuid,
    "The new default does not move an existing subscription"
  );
  for (const value of [
    undefined,
    null,
    42,
    {},
    new URL(feedURL),
    "",
    "not a URL",
    "file:///tmp/feed",
    "javascript:alert(1)",
    "https://user:secret@example.org/feed",
    "https://@example.org/feed",
    "https://example.org/" + "a".repeat(MAX_FEED_URL_LENGTH),
    "https://example.org/" + "é".repeat(1000),
    "https://example.org/missing",
    "https://example.org/feed?different=1",
    title,
  ]) {
    Assert.equal(service.getByFeedURL(value), null);
  }
  Assert.equal(downloads, 1, "Lookups and duplicate creates do not fetch");
  await service.remove(subscription.guid);
  Assert.equal(service.getByFeedURL(feedURL), null);
  await service.shutdown();
  Assert.throws(() => service.getByFeedURL(null), /shut down/);
});

add_task(async function new_subscriptions_default_to_the_bookmarks_menu() {
  const { service } = await lbHarness();
  await service.init();
  try {
    const existing = [];
    for (const parentGuid of [
      LBPlaces.bookmarks.toolbarGuid,
      LBPlaces.bookmarks.unfiledGuid,
    ]) {
      existing.push(
        await service.create({
          feedURL: `https://example.org/${parentGuid}`,
          title: "Existing subscription",
          parentGuid,
        })
      );
    }
    const created = await service.create({
      feedURL: "https://example.org/new-created",
    });
    Assert.equal(
      (await LBPlaces.bookmarks.fetch(created.guid)).parentGuid,
      LBPlaces.bookmarks.menuGuid,
      "New subscriptions go directly in the Bookmarks menu"
    );
    Assert.equal(
      await service.importOPML(
        serializeOPML([
          ...existing.map(sub => ({
            feedURL: sub.feedURL + "#duplicate",
            title: "Do not replace the existing title",
          })),
          { feedURL: "https://example.org/new-imported", title: "Imported" },
        ])
      ),
      1,
      "Only new imported URLs are added"
    );
    const imported = service.getByFeedURL("https://example.org/new-imported");
    Assert.equal(
      (await LBPlaces.bookmarks.fetch(imported.guid)).parentGuid,
      LBPlaces.bookmarks.menuGuid,
      "New imports go directly in the Bookmarks menu"
    );
    for (const [index, parentGuid] of [
      LBPlaces.bookmarks.toolbarGuid,
      LBPlaces.bookmarks.unfiledGuid,
    ].entries()) {
      const sub = existing[index];
      Assert.equal(
        await service.create({ feedURL: sub.feedURL, title: "Duplicate" }),
        sub
      );
      const folder = await LBPlaces.bookmarks.fetch(sub.guid);
      Assert.equal(folder.parentGuid, parentGuid, "Keep the existing location");
      Assert.equal(folder.title, sub.title, "Keep the existing title");
    }
  } finally {
    for (const sub of service.list()) {
      await service.remove(sub.guid);
    }
  }
});

add_task(async function import_wins_a_race_with_a_pending_duplicate_create() {
  const pending = lbDeferredDownload();
  const { service, parentGuid } = await lbHarness({
    download: pending.download,
  });
  const creation = service.create({
    feedURL: "https://EXAMPLE.org:443/feeds/../race#created",
    title: "Pending creation title",
    parentGuid,
  });
  await LBTestUtils.waitForCondition(() => pending.requests.length == 1);
  Assert.equal(
    await service.importOPML(
      serializeOPML([
        {
          feedURL: "https://example.org/race#imported",
          title: "Imported title",
        },
      ]),
      parentGuid
    ),
    1
  );
  const imported = service.getByFeedURL("https://example.org/race#lookup");
  Assert.equal(imported.title, "Imported title");
  pending.requests[0].resolve(lbResponse());
  Assert.equal(
    await creation,
    imported,
    "Creation returns the imported subscription"
  );
  Assert.equal(service.list().length, 1, "The race leaves one subscription");
  Assert.equal(
    await LBPlaces.bookmarks.fetch({ parentGuid, index: 1 }),
    null,
    "The race does not leave a second folder"
  );
  Assert.equal(pending.requests.length, 1);
});

add_task(
  async function subscription_url_limits_are_consistent_before_mutation() {
    const prefix = "https://example.org/";
    const boundaryURL =
      prefix + "a".repeat(MAX_FEED_URL_LENGTH - prefix.length);
    const tooLongURL = boundaryURL + "a";
    const expandedURL = prefix + "é".repeat(1000);
    Assert.equal(MAX_FEED_URL_LENGTH, 4096);
    Assert.equal(validateSubscriptionURL(boundaryURL), boundaryURL);
    Assert.equal(
      validateSubscriptionURL("https://EXAMPLE.org/feed#ignored"),
      "https://example.org/feed"
    );
    let downloads = 0;
    const { service, parentGuid } = await lbHarness({
      download: async () => {
        downloads++;
        return lbResponse();
      },
    });
    await service.init();
    for (const feedURL of [tooLongURL, expandedURL]) {
      Assert.throws(() => validateSubscriptionURL(feedURL), /4096/);
      Assert.throws(
        () => serializeOPML([{ title: "Too long", feedURL }]),
        /4096/
      );
      await Assert.rejects(service.create({ feedURL, parentGuid }), /4096/);
      const xml = `<opml><body><outline xmlUrl="https://example.org/valid"/><outline xmlUrl="${feedURL}"/></body></opml>`;
      await Assert.rejects(service.importOPML(xml, parentGuid), /4096/);
      Assert.equal(
        service.list().length,
        0,
        "The entire import is validated before any subscription is created"
      );
      Assert.equal(
        await LBPlaces.bookmarks.fetch({ parentGuid, index: 0 }),
        null
      );
    }
    Assert.equal(downloads, 0);
    Assert.equal(
      await service.importOPML(
        serializeOPML([{ title: "Boundary", feedURL: boundaryURL }]),
        parentGuid
      ),
      1
    );
    Assert.equal(service.list()[0].feedURL, boundaryURL);
  }
);

add_task(
  async function overlong_stored_subscription_is_rejected_without_data_loss() {
    const { service, path, parentGuid } = await lbHarness();
    const contents = JSON.stringify({
      version: 1,
      subscriptions: [
        {
          guid: parentGuid,
          title: "Existing folder",
          feedURL: "https://example.org/" + "a".repeat(4096),
          siteURL: null,
        },
      ],
    });
    await IOUtils.writeUTF8(path, contents);
    await Assert.rejects(service.init(), /Could not initialize/);
    await service.shutdown();
    Assert.equal(await IOUtils.readUTF8(path), contents);
    Assert.ok(await LBPlaces.bookmarks.fetch(parentGuid));
  }
);

add_task(async function invalid_creation_never_creates_a_folder() {
  let downloads = 0;
  const { service, parentGuid } = await lbHarness({
    download: async () => {
      downloads++;
      return lbResponse();
    },
    parser: () => {
      throw new Error("Not a feed");
    },
  });
  for (const feedURL of [
    "file:///tmp/feed",
    "data:text/xml,feed",
    "https://user:secret@example.org/",
    "https://@example.org/",
    "not a URL",
  ]) {
    await Assert.rejects(service.create({ feedURL, parentGuid }), /./);
  }
  Assert.equal(downloads, 0, "Unsafe URLs never reach the downloader");
  await Assert.rejects(
    service.create({ feedURL: "https://example.org/invalid", parentGuid }),
    /Not a feed/
  );
  Assert.equal(service.list().length, 0);
  Assert.equal(await LBPlaces.bookmarks.fetch({ parentGuid, index: 0 }), null);
});

add_task(
  async function conditional_refresh_deduplication_backoff_and_notifications() {
    const pending = lbDeferredDownload();
    const { service, parentGuid, clock } = await lbHarness({
      download: pending.download,
    });
    await service.importOPML(lbOPML(1), parentGuid);
    const { guid } = service.list()[0];
    const notifications = [];
    const observer = (subject, topic, data) => {
      if (data == guid) {
        notifications.push(service.peek(guid)?.status);
      }
    };
    Services.obs.addObserver(observer, LB_TOPIC);
    registerCleanupFunction(() =>
      Services.obs.removeObserver(observer, LB_TOPIC)
    );
    const first = service.refresh(guid);
    const second = service.refresh(guid, { force: true });
    await LBTestUtils.waitForCondition(() => pending.requests.length == 1);
    Assert.equal(service.peek(guid).status, "loading");
    Assert.equal(
      pending.requests[0].etag,
      "",
      "No validator without a memory cache"
    );
    pending.requests[0].resolve(lbResponse());
    Assert.deepEqual(await first, await second);
    Assert.deepEqual(notifications, ["loading", "ready"]);
    await service.refresh(guid);
    Assert.equal(pending.requests.length, 1, "One-hour cache interval");
    clock.advance(LB_HOUR);
    const conditional = service.refresh(guid);
    await LBTestUtils.waitForCondition(() => pending.requests.length == 2);
    Assert.equal(pending.requests[1].etag, '"v1"');
    Assert.equal(pending.requests[1].validatorURL, service.get(guid).feedURL);
    Assert.equal(
      pending.requests[1].lastModified,
      "Mon, 01 Jan 2024 00:00:00 GMT"
    );
    pending.requests[1].resolve({ status: 304 });
    Assert.deepEqual(await conditional, LB_FEED);
    const forced = service.refresh(guid, { force: true });
    const failed = lbRejected(forced, /HTTP 503/);
    await LBTestUtils.waitForCondition(() => pending.requests.length == 3);
    pending.requests[2].resolve({ status: 503, retryAfter: "7200" });
    await failed;
    Assert.equal(service.peek(guid).status, "error");
    Assert.deepEqual(
      service.peek(guid).items,
      LB_FEED.items,
      "Errors retain the previous entries"
    );
    await Assert.rejects(service.refresh(guid, { force: true }), /backoff/);
    clock.advance(LB_HOUR);
    await Assert.rejects(
      service.refresh(guid),
      /backoff/,
      "Retry-After is respected"
    );
    clock.advance(LB_HOUR);
    const retry = service.refresh(guid);
    const retryFailure = lbRejected(retry, /HTTP 500/);
    await LBTestUtils.waitForCondition(() => pending.requests.length == 4);
    pending.requests[3].resolve({ status: 500 });
    await retryFailure;
    clock.advance(LB_HOUR);
    await Assert.rejects(
      service.refresh(guid),
      /backoff/,
      "Repeated failures double the backoff"
    );
  }
);

add_task(
  async function native_folder_renames_survive_refresh_and_update_export() {
    const pending = lbDeferredDownload();
    const { service, parentGuid, path } = await lbHarness({
      download: pending.download,
    });
    await service.importOPML(lbOPML(1), parentGuid);
    const original = service.list()[0];
    const refresh = service.refresh(original.guid);
    await LBTestUtils.waitForCondition(() => pending.requests.length == 1);
    const notifications = [];
    const observer = (subject, topic, guid) => notifications.push(guid);
    Services.obs.addObserver(observer, LB_TOPIC);
    try {
      await LBPlaces.bookmarks.update({
        guid: parentGuid,
        title: "Unrelated folder",
      });
      Assert.deepEqual(
        notifications,
        [],
        "Unrelated folder renames are ignored"
      );
      const title = "Native & Café";
      await LBPlaces.bookmarks.update({ guid: original.guid, title });
      Assert.equal(service.get(original.guid).title, title);
      Assert.equal(service.list()[0].title, title);
      Assert.deepEqual(notifications, [original.guid]);
      Assert.deepEqual(parseOPML(serializeOPML(service.list())), [
        { title, feedURL: original.feedURL },
      ]);
      Assert.notEqual(
        original.title,
        title,
        "Previously returned snapshots remain immutable"
      );
      pending.requests[0].resolve(lbResponse());
      Assert.equal(
        (await refresh).title,
        LB_FEED.title,
        "Feed title is independent of the folder title"
      );
      Assert.equal(
        service.get(original.guid).title,
        title,
        "Refresh does not overwrite a concurrent native rename"
      );
      Assert.equal(
        pending.requests.length,
        1,
        "Renaming does not download feeds"
      );
      await LBPlaces.bookmarks.update({ guid: original.guid, title: null });
      Assert.equal(
        service.get(original.guid).title,
        "",
        "An untitled native folder stays untitled"
      );
      Assert.equal(
        parseOPML(serializeOPML(service.list()))[0].title,
        "",
        "An empty native title survives OPML round-tripping"
      );
      await service.shutdown();
      Assert.equal((await IOUtils.readJSON(path)).subscriptions[0].title, "");
    } finally {
      Services.obs.removeObserver(observer, LB_TOPIC);
    }
  }
);

add_task(async function startup_rereads_and_persists_native_folder_titles() {
  const { service, parentGuid, path } = await lbHarness();
  const { guid } = await service.create({
    feedURL: "https://example.org/feed",
    parentGuid,
  });
  await service.shutdown();
  const title = "Renamed while the service was stopped";
  await LBPlaces.bookmarks.update({ guid, title });
  Assert.notEqual((await IOUtils.readJSON(path)).subscriptions[0].title, title);
  const restored = new LiveBookmarksService({
    path,
    clock: lbClock(),
    download: async () => {
      throw new Error("Startup must not download feeds");
    },
  });
  registerCleanupFunction(() => restored.shutdown());
  await restored.init();
  Assert.equal(restored.get(guid).title, title);
  Assert.equal(
    restored.getByFeedURL("https://EXAMPLE.org:443/feed#restored").title,
    title
  );
  Assert.equal(
    (await LBPlaces.bookmarks.fetch(guid)).parentGuid,
    parentGuid,
    "Startup preserves the existing folder location"
  );
  Assert.equal(restored.list()[0].title, title);
  Assert.equal(parseOPML(serializeOPML(restored.list()))[0].title, title);
  Assert.equal(restored.peek(guid).status, "ready");
  Assert.deepEqual(restored.peek(guid).items, LB_FEED.items);
  await restored.shutdown();
  Assert.equal(
    (await IOUtils.readJSON(path)).subscriptions[0].title,
    title,
    "Title-only reconciliation is persisted"
  );
});

add_task(async function remove_preserves_user_children() {
  const { service, parentGuid } = await lbHarness();
  const subscription = await service.create({
    feedURL: "https://example.org/feed",
    parentGuid,
  });
  const child = await LBPlaces.bookmarks.insert({
    parentGuid: subscription.guid,
    url: "https://example.org/user-bookmark",
    title: "User bookmark",
  });
  await Assert.rejects(service.remove(subscription.guid), /non-empty/);
  Assert.ok(
    service.get(subscription.guid),
    "Failed removal retains the subscription"
  );
  Assert.ok(
    await LBPlaces.bookmarks.fetch(child.guid),
    "User bookmark survives"
  );
  await LBPlaces.bookmarks.remove(child.guid);
  await service.remove(subscription.guid);
  Assert.equal(service.get(subscription.guid), null);
  Assert.equal(service.peek(subscription.guid), null);
  Assert.equal(await LBPlaces.bookmarks.fetch(subscription.guid), null);
  await service.remove(subscription.guid);
});

add_task(async function deletion_during_refresh_does_not_resurrect_metadata() {
  const pending = lbDeferredDownload();
  const { service, parentGuid, path } = await lbHarness({
    download: pending.download,
  });
  await service.importOPML(lbOPML(1), parentGuid);
  const { guid } = service.list()[0];
  const refresh = service.refresh(guid);
  const rejected = lbRejected(refresh, /removed/);
  await LBTestUtils.waitForCondition(() => pending.requests.length == 1);
  await LBPlaces.bookmarks.remove(parentGuid);
  await rejected;
  Assert.ok(pending.requests[0].signal.aborted);
  Assert.equal(service.get(guid), null);
  await service.shutdown();
  Assert.deepEqual((await IOUtils.readJSON(path)).subscriptions, []);
});

add_task(async function bounded_concurrency_and_shutdown_cancel_queued_work() {
  const pending = lbDeferredDownload();
  const { service, parentGuid, clock } = await lbHarness({
    download: pending.download,
  });
  await service.importOPML(lbOPML(5), parentGuid);
  const refreshes = service.list().map(({ guid }) => service.refresh(guid));
  const settled = Promise.allSettled(refreshes);
  await LBTestUtils.waitForCondition(() => pending.requests.length == 3);
  Assert.equal(pending.requests.length, 3, "At most three active downloads");
  pending.requests[0].resolve(lbResponse());
  await LBTestUtils.waitForCondition(
    () => pending.requests.length == 4,
    "A freed slot starts one queued download"
  );
  await service.shutdown();
  const results = await settled;
  Assert.equal(
    results.filter(result => result.status == "fulfilled").length,
    1
  );
  Assert.equal(
    pending.requests.length,
    4,
    "Shutdown never starts the last queued download"
  );
  Assert.ok(pending.requests.slice(1).every(request => request.signal.aborted));
  Assert.equal(
    clock.timers.size,
    0,
    "Timeouts and periodic scheduling are stopped"
  );
  await service.shutdown();
  await Assert.rejects(service.init(), /shut down/);
});

add_task(async function download_timeout_sets_error_and_backoff() {
  const pending = lbDeferredDownload();
  const { service, parentGuid, clock } = await lbHarness({
    download: pending.download,
  });
  await service.importOPML(lbOPML(1), parentGuid);
  const { guid } = service.list()[0];
  const rejected = lbRejected(service.refresh(guid), /timed out/);
  await LBTestUtils.waitForCondition(() => pending.requests.length == 1);
  clock.fire(30000);
  await rejected;
  Assert.ok(pending.requests[0].signal.aborted);
  Assert.equal(service.peek(guid).status, "error");
  await Assert.rejects(service.refresh(guid, { force: true }), /backoff/);
});

add_task(
  async function metadata_round_trip_missing_folders_and_staggered_startup() {
    const { service, parentGuid, path } = await lbHarness();
    const first = await service.create({
      feedURL: "https://example.org/feed",
      parentGuid,
    });
    await service.importOPML(lbOPML(3), parentGuid);
    const [, removed, imported, last] = service.list();
    await service.shutdown();
    const saved = await IOUtils.readJSON(path);
    Assert.equal(saved.version, 1);
    Assert.equal(saved.subscriptions.length, 4);
    Assert.deepEqual(Object.keys(saved).sort(), ["subscriptions", "version"]);
    for (const entry of saved.subscriptions) {
      Assert.deepEqual(
        Object.keys(entry).sort(),
        ["feedURL", "guid", "siteURL", "title"],
        "The subscription file contains only metadata"
      );
    }
    Assert.deepEqual(await IOUtils.readJSON(`${path}.cache`), {
      version: 1,
      feeds: [lbCacheRecord(first)],
    });
    await LBPlaces.bookmarks.remove(removed.guid);
    const pending = lbDeferredDownload();
    const { service: restored, clock } = await lbRestart(path, {
      download: pending.download,
    });
    Assert.equal(restored.list().length, 3);
    Assert.equal(restored.get(removed.guid), null);
    Assert.deepEqual(restored.peek(first.guid), {
      status: "ready",
      items: LB_FEED.items,
      siteURL: LB_FEED.siteURL,
    });
    Assert.deepEqual(restored.peek(imported.guid), {
      status: "idle",
      items: [],
      siteURL: null,
    });
    Assert.equal(pending.requests.length, 0, "No startup download stampede");
    clock.advance(59999);
    clock.fire(60000);
    Assert.equal(
      pending.requests.length,
      0,
      "Nothing is due before 60 seconds"
    );
    clock.advance(1);
    clock.fire(60000);
    await LBTestUtils.waitForCondition(() => pending.requests.length == 1);
    Assert.equal(pending.requests[0].url, first.feedURL);
    Assert.equal(restored.peek(first.guid).status, "loading");
    Assert.deepEqual(restored.peek(first.guid).items, LB_FEED.items);
    pending.requests[0].resolve(lbResponse());
    await LBTestUtils.waitForCondition(
      () => restored.peek(first.guid).status == "ready"
    );
    Assert.equal(
      pending.requests.length,
      1,
      "Only one background feed starts per scheduling tick"
    );
    clock.advance(60000);
    clock.fire(60000);
    await LBTestUtils.waitForCondition(() => pending.requests.length == 2);
    Assert.equal(pending.requests[1].url, imported.feedURL);
    Assert.equal(restored.peek(last.guid).status, "idle");
    pending.requests[1].resolve(lbResponse());
    await LBTestUtils.waitForCondition(
      () => restored.peek(imported.guid).status == "ready"
    );
    await restored.shutdown();
    Assert.equal((await IOUtils.readJSON(path)).subscriptions.length, 3);
    Assert.equal(clock.timers.size, 0);
  }
);

add_task(
  async function unchanged_cache_skips_saves_but_retries_write_failures() {
    let feed = {
      ...LB_FEED,
      items: Array.from({ length: 40 }, (_, i) => ({
        id: String(i),
        title: "é".repeat(2048),
        url: `https://example.org/${i}`,
      })),
    };
    let status = 200;
    const downloads = [];
    const { service, parentGuid, path, clock } = await lbHarness({
      parser: () => feed,
      download: async () => {
        downloads.push(status);
        return lbResponse({ status });
      },
    });
    await service.init();
    const cacheStore = service._cacheStore;
    const cachePath = `${path}.cache`;
    let saves = 0;
    // Drive _save() explicitly so a deferred writer cannot race the disk failure.
    cacheStore.saveSoon = () => {
      saves++;
    };
    try {
      const subscription = await service.create({
        feedURL: "https://example.org/feed",
        parentGuid,
      });
      Assert.equal(saves, 1, "The initial fetch schedules a cache save");
      await cacheStore._save();
      const initial = await IOUtils.readJSON(cachePath);
      const count = initial.feeds[0].feed.items.length;
      Assert.greater(count, 0);
      Assert.less(
        count,
        feed.items.length,
        "The disk record is a bounded snapshot"
      );
      Assert.lessOrEqual(lbCacheSize(initial.feeds[0]), LB_CACHE_FEED_LIMIT);
      Assert.deepEqual(initial, {
        version: 1,
        feeds: [
          lbCacheRecord(subscription, {
            ...feed,
            items: feed.items.slice(0, count),
          }),
        ],
      });
      for (status of [200, 304]) {
        clock.advance(LB_HOUR);
        Assert.deepEqual(await service.refresh(subscription.guid), feed);
        Assert.equal(
          saves,
          1,
          `Unchanged HTTP ${status} does not save the cache`
        );
      }

      feed = {
        ...feed,
        items: [
          { ...feed.items[0], title: "à".repeat(2048) },
          ...feed.items.slice(1),
        ],
      };
      status = 200;
      clock.advance(LB_HOUR);
      Assert.deepEqual(await service.refresh(subscription.guid), feed);
      Assert.equal(saves, 2, "Changed cached content schedules a save");
      await IOUtils.remove(cachePath);
      await IOUtils.makeDirectory(cachePath);
      try {
        await cacheStore._save();
        Assert.equal(service.peek(subscription.guid).status, "ready");
        Assert.deepEqual(service.peek(subscription.guid).items, feed.items);
        Assert.deepEqual(service.get(subscription.guid), subscription);
      } finally {
        await IOUtils.remove(cachePath, { recursive: true });
      }

      status = 304;
      clock.advance(LB_HOUR);
      Assert.deepEqual(await service.refresh(subscription.guid), feed);
      Assert.equal(saves, 3, "Unchanged content retries a failed cache write");
      await cacheStore._save();
      Assert.deepEqual(await IOUtils.readJSON(cachePath), {
        version: 1,
        feeds: [
          lbCacheRecord(subscription, {
            ...feed,
            items: feed.items.slice(0, count),
          }),
        ],
      });
      status = 200;
      clock.advance(LB_HOUR);
      Assert.deepEqual(await service.refresh(subscription.guid), feed);
      Assert.equal(
        saves,
        3,
        "An unchanged successful cache needs no further saves"
      );
      Assert.deepEqual(downloads, [200, 200, 304, 200, 304, 200]);
    } finally {
      delete cacheStore.saveSoon;
      await service.shutdown();
    }
  }
);

add_task(async function restored_cache_survives_refresh_failure_and_restart() {
  const { service, parentGuid, path } = await lbHarness();
  const subscription = await service.create({
    feedURL: "https://example.org/feed",
    parentGuid,
  });
  await service.shutdown();
  const saved = await IOUtils.readJSON(`${path}.cache`);
  Assert.deepEqual(saved, {
    version: 1,
    feeds: [lbCacheRecord(subscription)],
  });

  const pending = lbDeferredDownload();
  const {
    service: restored,
    clock,
    requests,
  } = await lbRestart(path, {
    download: pending.download,
  });
  const before = restored.peek(subscription.guid);
  Assert.deepEqual(before, {
    status: "ready",
    items: LB_FEED.items,
    siteURL: LB_FEED.siteURL,
  });
  Assert.equal(
    requests.length,
    0,
    "Restoring entries does not download a feed"
  );
  clock.advance(60000);
  const rejected = lbRejected(restored.refresh(subscription.guid), /HTTP 503/);
  await LBTestUtils.waitForCondition(() => pending.requests.length == 1);
  Assert.equal(requests[0].etag, "", "Disk snapshots do not restore ETags");
  Assert.equal(requests[0].lastModified, "", "Last-Modified is not restored");
  Assert.equal(
    requests[0].validatorURL,
    null,
    "The first fetch is unconditional"
  );
  Assert.equal(restored.peek(subscription.guid).status, "loading");
  Assert.deepEqual(restored.peek(subscription.guid).items, LB_FEED.items);
  Assert.equal(
    before.status,
    "ready",
    "Previously returned snapshots are stable"
  );
  pending.requests[0].resolve(lbResponse({ status: 503 }));
  await rejected;
  Assert.equal(restored.peek(subscription.guid).status, "error");
  Assert.deepEqual(restored.peek(subscription.guid).items, LB_FEED.items);
  await restored.shutdown();
  Assert.deepEqual(
    await IOUtils.readJSON(`${path}.cache`),
    saved,
    "Loading and errors never replace the last successful disk snapshot"
  );

  const again = await lbRestart(path);
  Assert.equal(again.requests.length, 0);
  Assert.deepEqual(again.service.peek(subscription.guid), before);
  await again.service.shutdown();
});

add_task(async function cache_refresh_replaces_snapshot_including_empty_feed() {
  const { service, parentGuid, path } = await lbHarness();
  const subscription = await service.create({
    feedURL: "https://example.org/feed",
    title: "User folder title",
    parentGuid,
  });
  await service.shutdown();
  let previous = LB_FEED;
  for (const feed of [
    {
      title: "Nouveau café",
      siteURL: "https://example.org/new#home",
      items: [
        {
          id: "two",
          title: "Deuxième entrée",
          url: "https://example.org/two#entry",
        },
      ],
    },
    { title: "Empty feed", siteURL: null, items: [] },
  ]) {
    const {
      service: restored,
      clock,
      requests,
    } = await lbRestart(path, {
      parser: () => feed,
    });
    Assert.equal(requests.length, 0);
    Assert.equal(restored.peek(subscription.guid).status, "ready");
    Assert.deepEqual(restored.peek(subscription.guid).items, previous.items);
    clock.advance(60000);
    Assert.deepEqual(await restored.refresh(subscription.guid), feed);
    Assert.equal(requests.length, 1);
    Assert.deepEqual(restored.peek(subscription.guid), {
      status: "ready",
      items: feed.items,
      siteURL: feed.siteURL,
    });
    Assert.equal(restored.get(subscription.guid).title, subscription.title);
    await restored.shutdown();
    Assert.deepEqual(
      await IOUtils.readJSON(`${path}.cache`),
      { version: 1, feeds: [lbCacheRecord(subscription, feed)] },
      "A successful refresh replaces rather than merges the old snapshot"
    );
    previous = feed;
  }
  const { service: empty, requests } = await lbRestart(path);
  Assert.equal(requests.length, 0);
  Assert.deepEqual(empty.peek(subscription.guid), {
    status: "ready",
    items: [],
    siteURL: null,
  });
  await empty.shutdown();
});

add_task(async function version_one_metadata_without_cache_remains_usable() {
  const { service, parentGuid, path } = await lbHarness();
  await service.importOPML(lbOPML(2), parentGuid);
  const subscriptions = service.list();
  await service.shutdown();
  await IOUtils.remove(`${path}.cache`, { ignoreAbsent: true });
  Assert.deepEqual(await IOUtils.readJSON(path), {
    version: 1,
    subscriptions,
  });

  const { service: restored, requests } = await lbRestart(path);
  Assert.deepEqual(restored.list(), subscriptions);
  Assert.equal(requests.length, 0);
  for (const { guid } of subscriptions) {
    Assert.deepEqual(restored.peek(guid), {
      status: "idle",
      items: [],
      siteURL: null,
    });
  }
  await restored.refresh(subscriptions[0].guid);
  Assert.equal(requests.length, 1);
  await restored.shutdown();
  Assert.deepEqual(await IOUtils.readJSON(`${path}.cache`), {
    version: 1,
    feeds: [lbCacheRecord(subscriptions[0])],
  });

  const again = await lbRestart(path);
  Assert.equal(again.requests.length, 0);
  Assert.equal(again.service.peek(subscriptions[0].guid).status, "ready");
  Assert.deepEqual(
    again.service.peek(subscriptions[0].guid).items,
    LB_FEED.items
  );
  Assert.equal(again.service.peek(subscriptions[1].guid).status, "idle");
  Assert.deepEqual(again.service.peek(subscriptions[1].guid).items, []);
  await again.service.shutdown();
});

add_task(
  async function unusable_cache_is_disposable_not_a_subscription_error() {
    const { service, parentGuid, path } = await lbHarness();
    const subscription = await service.create({
      feedURL: "https://example.org/feed",
      parentGuid,
    });
    await service.shutdown();
    const metadata = await IOUtils.readUTF8(path);
    const record = lbCacheRecord(subscription);
    for (const [name, contents] of [
      ["malformed JSON", "{ broken JSON"],
      ["null cache", "null"],
      ["obsolete version", JSON.stringify({ version: 0, feeds: [record] })],
      ["future version", JSON.stringify({ version: 2, feeds: [record] })],
      ["version type", JSON.stringify({ version: "1", feeds: [record] })],
      ["missing feeds", JSON.stringify({ version: 1 })],
      ["feeds type", JSON.stringify({ version: 1, feeds: {} })],
      [
        "too many records",
        JSON.stringify({
          version: 1,
          feeds: [
            record,
            ...Array.from({ length: 200 }, (_, i) => ({
              ...record,
              guid: String(i).padStart(12, "0"),
            })),
          ],
        }),
      ],
    ]) {
      info(name);
      await IOUtils.writeUTF8(`${path}.cache`, contents);
      const { service: restored, requests } = await lbRestart(path);
      Assert.deepEqual(restored.list(), [subscription], name);
      Assert.deepEqual(restored.peek(subscription.guid), {
        status: "idle",
        items: [],
        siteURL: LB_FEED.siteURL,
      });
      Assert.equal(requests.length, 0, name);
      Assert.equal(await IOUtils.readUTF8(path), metadata, name);
      await restored.refresh(subscription.guid);
      await restored.shutdown();
      Assert.deepEqual(
        await IOUtils.readJSON(`${path}.cache`),
        { version: 1, feeds: [record] },
        `${name}: a successful fetch can replace the disposable cache`
      );
      Assert.equal(await IOUtils.readUTF8(path), metadata, name);
    }
  }
);

add_task(async function oversized_cache_is_ignored_even_when_json_is_valid() {
  const { service, parentGuid, path } = await lbHarness();
  const subscription = await service.create({
    feedURL: "https://example.org/feed",
    parentGuid,
  });
  await service.shutdown();
  const metadata = await IOUtils.readUTF8(path);
  const cachePath = `${path}.cache`;
  const { size } = await IOUtils.stat(cachePath);
  await IOUtils.write(
    cachePath,
    new Uint8Array(LB_CACHE_LIMIT + 1 - size).fill(0x20),
    { mode: "append" }
  );
  Assert.equal((await IOUtils.stat(cachePath)).size, LB_CACHE_LIMIT + 1);

  const { service: restored, requests } = await lbRestart(path);
  Assert.deepEqual(restored.list(), [subscription]);
  Assert.equal(restored.peek(subscription.guid).status, "idle");
  Assert.deepEqual(restored.peek(subscription.guid).items, []);
  Assert.equal(requests.length, 0);
  Assert.equal(await IOUtils.readUTF8(path), metadata);
  await restored.refresh(subscription.guid);
  await restored.shutdown();
  Assert.deepEqual(await IOUtils.readJSON(cachePath), {
    version: 1,
    feeds: [lbCacheRecord(subscription)],
  });
});

add_task(async function invalid_cache_records_do_not_hide_valid_records() {
  const invalidFeeds = [
    ["feed type", null],
    ["feed title type", { ...LB_FEED, title: 42 }],
    ["feed title length", { ...LB_FEED, title: "a".repeat(4097) }],
    ["site URL type", { ...LB_FEED, siteURL: 42 }],
    ["items type", { ...LB_FEED, items: {} }],
    ["item type", { ...LB_FEED, items: [null] }],
    [
      "too many items",
      {
        ...LB_FEED,
        items: Array.from({ length: 201 }, () => LB_FEED.items[0]),
      },
    ],
    [
      "record byte budget",
      {
        ...LB_FEED,
        items: Array.from({ length: 40 }, (_, i) => ({
          id: String(i),
          title: "é".repeat(2048),
          url: `https://example.org/${i}`,
        })),
      },
    ],
  ];
  for (const [name, field, value] of [
    ["item ID type", "id", 42],
    ["item ID length", "id", "a".repeat(4097)],
    ["item title type", "title", null],
    ["item title length", "title", "a".repeat(4097)],
    ["item URL type", "url", 42],
  ]) {
    invalidFeeds.push([
      name,
      { ...LB_FEED, items: [{ ...LB_FEED.items[0], [field]: value }] },
    ]);
  }
  const invalid = [
    ["record type", () => null],
    ["GUID type", record => ({ ...record, guid: 42 })],
    ["GUID syntax", record => ({ ...record, guid: "invalid" })],
    ["feed URL type", record => ({ ...record, feedURL: 42 })],
    ...invalidFeeds.map(([name, feed]) => [
      name,
      record => ({ ...record, feed }),
    ]),
  ];
  for (const [name, url] of [
    ["script", "javascript:alert(1)"],
    ["file", "file:///tmp/feed"],
    ["data", "data:text/html,unsafe"],
    ["credentials", "https://user:secret@example.org/feed"],
    ["empty credentials", "https://@example.org/feed"],
    ["overlong", `https://example.org/${"a".repeat(MAX_FEED_URL_LENGTH)}`],
    ["overlong after normalization", `https://example.org/${"é".repeat(700)}`],
  ]) {
    invalid.push(
      [`${name} feed URL`, record => ({ ...record, feedURL: url })],
      [
        `${name} site URL`,
        record => ({ ...record, feed: { ...record.feed, siteURL: url } }),
      ],
      [
        `${name} item URL`,
        record => ({
          ...record,
          feed: { ...record.feed, items: [{ ...LB_FEED.items[0], url }] },
        }),
      ]
    );
  }
  const { service, parentGuid, path } = await lbHarness();
  await service.importOPML(lbOPML(invalid.length + 1), parentGuid);
  const subscriptions = service.list();
  await service.shutdown();
  const prefix = "https://example.org/";
  const validFeed = {
    title: "漢".repeat(4096),
    siteURL: "https://example.org/#cached-home",
    items: [
      {
        id: "識".repeat(4096),
        title: "é".repeat(4096),
        url: `${prefix}${"a".repeat(MAX_FEED_URL_LENGTH - prefix.length - 6)}#entry`,
      },
    ],
  };
  const valid = subscriptions.at(-1);
  const records = invalid.map(([, change], i) =>
    change(lbCacheRecord(subscriptions[i]))
  );
  records.push(lbCacheRecord(valid, validFeed));
  await IOUtils.writeJSON(`${path}.cache`, { version: 1, feeds: records });

  const { service: restored, requests } = await lbRestart(path);
  Assert.deepEqual(
    restored.list(),
    subscriptions,
    "Cache errors leave metadata intact"
  );
  Assert.equal(requests.length, 0);
  for (const [i, [name]] of invalid.entries()) {
    Assert.deepEqual(
      restored.peek(subscriptions[i].guid),
      { status: "idle", items: [], siteURL: null },
      `${name}: skip the whole record rather than sanitizing it`
    );
  }
  Assert.deepEqual(
    restored.peek(valid.guid),
    { status: "ready", items: validFeed.items, siteURL: validFeed.siteURL },
    "Valid records with boundary-length strings survive invalid ones"
  );
  Assert.deepEqual(await restored.refresh(valid.guid), validFeed);
  Assert.equal(requests.length, 0, "Reading the restored feed needs no fetch");
  await restored.shutdown();
});

add_task(async function cache_requires_guid_url_and_a_surviving_folder() {
  const { service, parentGuid, path } = await lbHarness();
  await service.importOPML(lbOPML(4), parentGuid);
  const [matched, wrongGuid, wrongURL, deleted] = service.list();
  await service.shutdown();
  const bookmark = await LBPlaces.bookmarks.insert({
    parentGuid,
    url: "https://example.org/bookmark",
    title: "Not a folder",
  });
  const notFolder = {
    guid: bookmark.guid,
    title: bookmark.title,
    feedURL: "https://example.org/not-folder",
    siteURL: null,
  };
  const metadata = await IOUtils.readJSON(path);
  metadata.subscriptions[0].feedURL = "https://EXAMPLE.org:443/0#subscription";
  metadata.subscriptions.push(notFolder);
  await IOUtils.writeJSON(path, metadata);
  await IOUtils.writeJSON(`${path}.cache`, {
    version: 1,
    feeds: [
      lbCacheRecord(matched),
      { ...lbCacheRecord(wrongGuid), guid: parentGuid },
      { ...lbCacheRecord(wrongURL), feedURL: matched.feedURL },
      lbCacheRecord(deleted),
      lbCacheRecord(notFolder),
    ],
  });
  await LBPlaces.bookmarks.remove(deleted.guid);

  const { service: restored, requests } = await lbRestart(path);
  Assert.equal(requests.length, 0);
  Assert.deepEqual(restored.list(), [matched, wrongGuid, wrongURL]);
  Assert.equal(restored.peek(matched.guid).status, "ready");
  Assert.deepEqual(restored.peek(matched.guid).items, LB_FEED.items);
  for (const { guid } of [wrongGuid, wrongURL]) {
    Assert.deepEqual(restored.peek(guid), {
      status: "idle",
      items: [],
      siteURL: null,
    });
  }
  for (const guid of [parentGuid, deleted.guid, bookmark.guid]) {
    Assert.equal(restored.get(guid), null);
    Assert.equal(restored.peek(guid), null);
  }
  Assert.ok(await LBPlaces.bookmarks.fetch(bookmark.guid));
  await restored.shutdown();
});

add_task(async function removal_and_shutdown_do_not_resurrect_cached_feeds() {
  const { service, parentGuid, path } = await lbHarness();
  const subscriptions = [];
  for (const name of ["native", "explicit", "kept"]) {
    subscriptions.push(
      await service.create({
        feedURL: `https://example.org/${name}`,
        parentGuid,
      })
    );
  }
  const [native, explicit, kept] = subscriptions;
  await service.shutdown();
  Assert.deepEqual(await IOUtils.readJSON(`${path}.cache`), {
    version: 1,
    feeds: subscriptions.map(subscription => lbCacheRecord(subscription)),
  });

  const pending = lbDeferredDownload();
  const { service: restored } = await lbRestart(path, {
    download: pending.download,
  });
  Assert.equal(pending.requests.length, 0);
  const rejected = subscriptions.map((subscription, i) =>
    lbRejected(
      restored.refresh(subscription.guid, { force: true }),
      i < 2 ? /removed/ : /shut down/
    )
  );
  await LBTestUtils.waitForCondition(() => pending.requests.length == 3);
  await LBPlaces.bookmarks.remove(native.guid);
  await restored.remove(explicit.guid);
  for (const subscription of [native, explicit]) {
    Assert.equal(restored.get(subscription.guid), null);
    Assert.equal(restored.peek(subscription.guid), null);
    Assert.ok(
      pending.requests.find(request => request.url == subscription.feedURL)
        .signal.aborted
    );
  }
  Assert.equal(restored.peek(kept.guid).status, "loading");
  Assert.deepEqual(restored.peek(kept.guid).items, LB_FEED.items);
  await restored.shutdown();
  await Promise.all(rejected);
  for (const request of pending.requests) {
    Assert.ok(request.signal.aborted);
  }
  Assert.deepEqual((await IOUtils.readJSON(path)).subscriptions, [kept]);
  Assert.deepEqual(
    await IOUtils.readJSON(`${path}.cache`),
    { version: 1, feeds: [lbCacheRecord(kept)] },
    "Only the survivor's last good feed remains after shutdown"
  );
  Assert.ok(!(await IOUtils.exists(`${path}.cache.tmp`)));

  const again = await lbRestart(path);
  Assert.equal(again.requests.length, 0);
  Assert.deepEqual(again.service.list(), [kept]);
  Assert.deepEqual(again.service.peek(kept.guid), {
    status: "ready",
    items: LB_FEED.items,
    siteURL: LB_FEED.siteURL,
  });
  await again.service.shutdown();
});

add_task(async function utf8_cache_quota_does_not_truncate_live_snapshots() {
  const prefix = "https://example.org/";
  const feed = {
    title: "漢".repeat(4096),
    siteURL: `${prefix}${"a".repeat(MAX_FEED_URL_LENGTH - prefix.length)}`,
    items: Array.from({ length: 201 }, (_, i) => ({
      id: `${i}-${"識".repeat(512)}`,
      title: i < 40 ? 'é"'.repeat(1024) : "Small entry",
      url: `https://example.org/article#${i}`,
    })),
  };
  const { service, parentGuid, path } = await lbHarness({ parser: () => feed });
  const subscription = await service.create({
    feedURL: `https://example.org/feed?${"a".repeat(2048)}`,
    title: "Quota test",
    parentGuid,
  });
  const live = await service.refresh(subscription.guid);
  Assert.deepEqual(live.items, feed.items.slice(0, 200));
  Assert.deepEqual(service.peek(subscription.guid).items, live.items);
  await service.shutdown();
  Assert.equal(
    live.items.length,
    200,
    "Saving never truncates a live snapshot"
  );

  const saved = await IOUtils.readJSON(`${path}.cache`);
  Assert.equal(saved.version, 1);
  Assert.equal(saved.feeds.length, 1);
  const record = saved.feeds[0];
  const count = record.feed.items.length;
  Assert.greater(count, 0);
  Assert.less(count, 200);
  Assert.deepEqual(
    record,
    lbCacheRecord(subscription, { ...feed, items: live.items.slice(0, count) }),
    "The cache retains leading items, not later small items that happen to fit"
  );
  Assert.lessOrEqual(lbCacheSize(record), LB_CACHE_FEED_LIMIT);
  Assert.greater(lbCacheSize(record), JSON.stringify(record).length);
  Assert.greater(
    lbCacheSize(
      lbCacheRecord(subscription, {
        ...feed,
        items: live.items.slice(0, count + 1),
      })
    ),
    LB_CACHE_FEED_LIMIT,
    "The next item exceeds the UTF-8 budget for the entire serialized record"
  );

  const {
    service: restored,
    clock,
    requests,
  } = await lbRestart(path, {
    parser: () => feed,
  });
  Assert.equal(requests.length, 0);
  Assert.equal(restored.peek(subscription.guid).status, "ready");
  Assert.deepEqual(restored.peek(subscription.guid).items, record.feed.items);
  clock.advance(60000);
  const refreshed = await restored.refresh(subscription.guid);
  Assert.equal(requests.length, 1);
  Assert.deepEqual(refreshed.items, live.items);
  Assert.deepEqual(restored.peek(subscription.guid).items, live.items);
  await restored.shutdown();
  Assert.equal(refreshed.items.length, 200);
  Assert.deepEqual(await IOUtils.readJSON(`${path}.cache`), saved);
});

add_task(async function malformed_or_future_storage_is_never_replaced() {
  for (const contents of [
    "{ broken JSON",
    JSON.stringify({ version: 2, subscriptions: [] }),
    JSON.stringify({
      version: 1,
      subscriptions: [
        {
          guid: LBPlaces.bookmarks.unfiledGuid,
          title: "Root",
          feedURL: "https://example.org/feed",
          siteURL: null,
        },
      ],
    }),
    JSON.stringify({
      version: 1,
      subscriptions: [
        {
          guid: "missing_____",
          title: "Unsafe",
          feedURL: "file:///tmp/feed",
          siteURL: null,
        },
      ],
    }),
  ]) {
    const { service, path, clock } = await lbHarness();
    await IOUtils.writeUTF8(path, contents);
    await Assert.rejects(
      service.init(),
      /Could not initialize Live Bookmarks.*Check file permissions/
    );
    await Assert.rejects(service.init(), /Could not initialize/);
    Assert.throws(() => service.list(), /init/);
    await service.shutdown();
    Assert.equal(
      await IOUtils.readUTF8(path),
      contents,
      "Original profile data is unchanged"
    );
    Assert.equal(clock.timers.size, 0);
  }
});

add_task(
  async function import_validates_all_entries_without_network_and_enforces_capacity() {
    let downloads = 0;
    const { service, parentGuid } = await lbHarness({
      download: async () => {
        downloads++;
        return lbResponse();
      },
    });
    await Assert.rejects(
      service.importOPML(
        '<opml><body><outline xmlUrl="https://example.org/good"/><outline xmlUrl="file:///bad"/></body></opml>',
        parentGuid
      ),
      /HTTP/
    );
    await service.init();
    Assert.equal(
      service.list().length,
      0,
      "No partial import for invalid documents"
    );
    Assert.equal(await service.importOPML(lbOPML(200), parentGuid), 200);
    Assert.equal(
      await service.importOPML(lbOPML(200), parentGuid),
      0,
      "Existing subscriptions are deduplicated"
    );
    Assert.equal(downloads, 0, "Import needs no network");
    Assert.ok(
      service.list().every(({ guid }) => service.peek(guid).status == "idle")
    );
    await Assert.rejects(
      service.create({ feedURL: "https://example.org/extra", parentGuid }),
      /200/
    );
    await Assert.rejects(
      service.importOPML(lbOPML(1, "https://other.example/"), parentGuid),
      /200/
    );
    Assert.equal(
      downloads,
      0,
      "Capacity is checked before validation downloads"
    );
  }
);

add_task(async function entry_limits_and_link_fragments_are_preserved() {
  const { service, parentGuid, path } = await lbHarness({
    parser: () => ({
      title: "Feed",
      siteURL: "https://example.org/#home",
      items: Array.from({ length: 201 }, (_, i) => ({
        id: String(i),
        title: `Entry ${i}`,
        url: `https://example.org/article#${i}`,
      })),
    }),
  });
  const { guid } = await service.create({
    feedURL: "https://example.org/feed",
    parentGuid,
  });
  const feed = await service.refresh(guid);
  Assert.equal(feed.items.length, 200);
  Assert.equal(feed.items[0].url, "https://example.org/article#0");
  Assert.equal(service.get(guid).siteURL, "https://example.org/#home");
  await service.shutdown();
  const { feeds } = await IOUtils.readJSON(`${path}.cache`);
  Assert.equal(feeds.length, 1);
  Assert.deepEqual(
    feeds[0].feed,
    feed,
    "All 200 small entries fit in the cache"
  );
});

add_task(
  async function failed_initialization_after_loading_preserves_storage() {
    const clock = lbClock();
    clock.setTimeout = () => {
      throw new Error("Scheduler unavailable");
    };
    const { service, path, parentGuid } = await lbHarness({ clock });
    const contents = JSON.stringify({
      version: 1,
      subscriptions: [
        {
          guid: parentGuid,
          feedURL: "https://example.org/renamed",
          title: "Outdated native folder title",
          siteURL: null,
        },
        {
          guid: "missing_____",
          feedURL: "https://example.org/feed",
          title: "Missing folder",
          siteURL: null,
        },
      ],
    });
    await IOUtils.writeUTF8(path, contents);
    await Assert.rejects(service.init(), /Could not initialize/);
    await service.shutdown();
    Assert.equal(
      await IOUtils.readUTF8(path),
      contents,
      "Failed initialization does not persist reconciliation"
    );
  }
);

add_task(async function safe_encoding_and_decoded_size_limits() {
  const cases = [
    {
      xml: '<?xml version="1.0" encoding="iso-8859-1"?><rss>Café</rss>',
      charset: "",
      encoding: "latin1",
    },
    { xml: "<rss>Café</rss>", charset: "windows-1252", encoding: "latin1" },
    {
      xml: '<?xml version="1.0"?><rss>Café</rss>',
      charset: "",
      encoding: "utf16le",
    },
    {
      xml: '<?xml version="1.0"?><rss>Café</rss>',
      charset: "",
      encoding: "utf16be",
    },
  ];
  for (const test of cases) {
    let bytes;
    if (test.encoding == "latin1") {
      bytes = Uint8Array.from(test.xml, char => char.charCodeAt(0));
    } else {
      const little = test.encoding == "utf16le";
      bytes = new Uint8Array(2 + test.xml.length * 2);
      bytes.set(little ? [0xff, 0xfe] : [0xfe, 0xff]);
      const view = new DataView(bytes.buffer);
      for (let i = 0; i < test.xml.length; i++) {
        view.setUint16(2 + i * 2, test.xml.charCodeAt(i), little);
      }
    }
    const { service, parentGuid } = await lbHarness({
      download: async () => lbResponse({ bytes, charset: test.charset }),
      parser: xml => {
        Assert.equal(xml, test.xml);
        return LB_FEED;
      },
    });
    await service.create({
      feedURL: "https://example.org/encoding",
      parentGuid,
    });
  }
  for (const response of [
    lbResponse({ bytes: new Uint8Array(LB_LIMIT + 1) }),
    lbResponse({ bytes: new Uint8Array([0xc3, 0x28]), charset: "utf-8" }),
    lbResponse({ charset: "not-a-charset" }),
    lbResponse({
      bytes: new TextEncoder().encode(
        '<!DOCTYPE rss SYSTEM "https://example.org/entity"><rss/>'
      ),
    }),
    { status: 304 },
  ]) {
    const { service, parentGuid } = await lbHarness({
      download: async () => response,
      parser: () => {
        throw new Error("Parser must not be reached");
      },
    });
    await Assert.rejects(
      service.create({ feedURL: "https://example.org/invalid", parentGuid }),
      /^(?!.*Parser must not be reached).+/
    );
    Assert.equal(service.list().length, 0);
  }
});

add_task(
  async function http_downloads_are_anonymous_conditional_and_redirect_safe() {
    const server = new LBHttpServer();
    server.start(-1);
    registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));
    const base = `http://localhost:${server.identity.primaryPort}`;
    let requests = 0;
    let redirected = 0;
    server.registerPathHandler("/feed", (request, response) => {
      requests++;
      Assert.ok(!request.hasHeader("Cookie"));
      Assert.ok(!request.hasHeader("Authorization"));
      if (request.hasHeader("If-None-Match")) {
        Assert.equal(request.getHeader("If-None-Match"), '"feed-v1"');
        response.setStatusLine(request.httpVersion, 304, "Not Modified");
        return;
      }
      response.setHeader(
        "Content-Type",
        "application/rss+xml; charset=windows-1252",
        false
      );
      response.setHeader("Set-Cookie", "livebookmark=secret; Path=/", false);
      response.setHeader("ETag", '"feed-v1"', false);
      response.write("<rss>Caf\xe9</rss>");
    });
    server.registerPathHandler("/redirect", (request, response) => {
      redirected++;
      response.setStatusLine(request.httpVersion, 302, "Found");
      response.setHeader("Location", `${base}/feed`, false);
    });
    for (const [path, target] of [
      ["/file", "file:///tmp/live-bookmarks-feed"],
      ["/data", "data:text/xml,<rss/>"],
      [
        "/credentials",
        `http://user:secret@localhost:${server.identity.primaryPort}/feed`,
      ],
      ["/loop", `${base}/loop`],
    ]) {
      server.registerPathHandler(path, (request, response) => {
        response.setStatusLine(request.httpVersion, 302, "Found");
        response.setHeader("Location", target, false);
      });
    }
    const seenChannels = [];
    const observer = subject => {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (channel.URI.spec.startsWith(base + "/")) {
        seenChannels.push(channel.URI.spec);
        Assert.ok(channel.loadFlags & Ci.nsIRequest.LOAD_ANONYMOUS);
        Assert.ok(channel.loadFlags & Ci.nsIRequest.INHIBIT_CACHING);
        Assert.equal(
          channel.loadInfo.cookiePolicy,
          Ci.nsILoadInfo.SEC_COOKIES_OMIT
        );
      }
    };
    Services.obs.addObserver(observer, "http-on-modify-request");
    registerCleanupFunction(() =>
      Services.obs.removeObserver(observer, "http-on-modify-request")
    );
    const { service, parentGuid, clock } = await lbHTTPHarness({
      parser: (xml, url) => {
        Assert.equal(xml, "<rss>Café</rss>");
        Assert.equal(url, `${base}/feed`);
        return LB_FEED;
      },
    });
    const subscription = await service.create({
      feedURL: `${base}/feed`,
      parentGuid,
    });
    clock.advance(LB_HOUR);
    Assert.deepEqual(await service.refresh(subscription.guid), LB_FEED);
    Assert.equal(requests, 2);
    await service.create({ feedURL: `${base}/redirect`, parentGuid });
    Assert.equal(redirected, 1);
    for (const path of ["/file", "/data", "/credentials", "/loop"]) {
      await Assert.rejects(
        service.create({ feedURL: base + path, parentGuid }),
        /./
      );
    }
    Assert.equal(requests, 3, "Unsafe redirects never reach the feed target");
    Assert.greaterOrEqual(seenChannels.length, 3);
  }
);

add_task(
  async function http_default_download_and_parser_preserve_encoded_bytes() {
    const server = new LBHttpServer();
    server.start(-1);
    registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));
    const base = `http://localhost:${server.identity.primaryPort}`;
    const xml =
      '<rss version="2.0"><channel><title>Café 日本語</title><link>https://example.org/</link><description>Service test</description><item><guid isPermaLink="false">one</guid><title>Entrée</title><link>https://example.org/one#part</link></item></channel></rss>';
    const bytes = String.fromCharCode(...new TextEncoder().encode(xml));
    // gzip and zlib-wrapped deflate of the UTF-8 XML above.
    const payloads = {
      identity: bytes,
      gzip: atob(
        "H4sIAAAAAAAC/4WPsQ3CMBBFV4lMn0OU6OIG0VEgMYGVXBILx7HsI2ITGkRHEcQW2SViDAwRiI72nv6/99GHkHTkg25tJhbpXEjMa2UtGYms2ZBcqXLok/F0Hc/3x+2CMJ3RaLuXNbMLSwA6qsYZSltfAcIbYUEh99pxrJY78p3OKWEKjPBLUDM1EquDLhIdtuQbtYnxTJTKBBKytYTwoh+ftWU/9PTfIyZnTnn++MD0Cb77II6XT7Sg+9YCAQAA"
      ),
      deflate: atob(
        "eJyFj7ENwjAQRVeJTJ9DlOjiBtFRIDGBlVwSC8ex7CNiExpERxHEFtklYgwMEYiO9p7+v/fRh5B05INubSYW6VxIzGtlLRmJrNmQXKly6JPxdB3P98ftgjCd0Wi7lzWzC0sAOqrGGUpbXwHCG2FBIffacayWO/KdzilhCozwS1AzNRKrgy4SHbbkG7WJ8UyUygQSsrWE8KIfn7VlP/T03yMmZ055/vjA9Am++yCOl089XGFf"
      ),
    };
    for (const [encoding, payload] of Object.entries(payloads)) {
      server.registerPathHandler(`/${encoding}`, (request, response) => {
        response.setHeader(
          "Content-Type",
          "application/rss+xml; charset=UTF-8",
          false
        );
        response.setHeader("Content-Encoding", encoding, false);
        response.write(payload);
      });
    }
    server.registerPathHandler("/split-utf8", (request, response) => {
      response.processAsync();
      response.setHeader(
        "Content-Type",
        "application/rss+xml; charset=UTF-8",
        false
      );
      const split = bytes.indexOf("\xc3") + 1;
      response.write(bytes.slice(0, split));
      Services.tm.dispatchToMainThread(() => {
        response.write(bytes.slice(split));
        response.finish();
      });
    });
    server.registerPathHandler("/corrupt-gzip", (request, response) => {
      response.setHeader("Content-Type", "application/rss+xml", false);
      response.setHeader("Content-Encoding", "gzip", false);
      response.write("not a gzip stream");
    });
    const { service, parentGuid } = await lbHTTPHarness({ parser: undefined });
    for (const path of ["identity", "gzip", "deflate", "split-utf8"]) {
      const subscription = await service.create({
        feedURL: `${base}/${path}`,
        parentGuid,
      });
      Assert.equal(
        subscription.title,
        "Café 日本語",
        `${path} reaches the real parser as decoded XML`
      );
      const feed = await service.refresh(subscription.guid);
      Assert.equal(feed.items.length, 1);
      Assert.equal(feed.items[0].title, "Entrée");
      Assert.equal(feed.items[0].url, "https://example.org/one#part");
    }
    await Assert.rejects(
      service.create({ feedURL: `${base}/corrupt-gzip`, parentGuid }),
      /NS_ERROR|Feed download/
    );
    Assert.equal(
      service.list().length,
      4,
      "Corrupt compressed data does not create a placeholder"
    );
  }
);

add_task(
  async function http_redirected_requests_are_cancelled_on_removal_timeout_and_shutdown() {
    const server = new LBHttpServer();
    const responses = new Set();
    server.start(-1);
    registerCleanupFunction(() => {
      for (const response of responses) {
        response.finish();
      }
      return new Promise(resolve => server.stop(resolve));
    });
    const base = `http://localhost:${server.identity.primaryPort}`;
    for (const action of ["removal", "timeout", "shutdown"]) {
      let response;
      let channel;
      server.registerPathHandler(`/redirect-${action}`, (request, reply) => {
        reply.setStatusLine(request.httpVersion, 302, "Found");
        reply.setHeader("Location", `${base}/slow-${action}`, false);
      });
      server.registerPathHandler(`/slow-${action}`, (request, reply) => {
        response = reply;
        responses.add(reply);
        reply.processAsync();
        reply.setHeader("Content-Type", "application/rss+xml", false);
        reply.write("<rss>");
      });
      const observer = subject => {
        const request = subject.QueryInterface(Ci.nsIHttpChannel);
        if (request.URI.spec == `${base}/slow-${action}`) {
          channel = request;
        }
      };
      Services.obs.addObserver(observer, "http-on-modify-request");
      try {
        const { service, parentGuid, clock } = await lbHTTPHarness({
          parser: undefined,
        });
        await service.importOPML(
          serializeOPML([
            { title: "Slow feed", feedURL: `${base}/redirect-${action}` },
          ]),
          parentGuid
        );
        const { guid } = service.list()[0];
        const expectedError = {
          removal: /removed/,
          timeout: /timed out/,
          shutdown: /shut down/,
        }[action];
        const rejected = lbRejected(service.refresh(guid), expectedError);
        await LBTestUtils.waitForCondition(
          () => response && channel,
          "The redirected request is in progress"
        );
        if (action == "removal") {
          await service.remove(guid);
        } else if (action == "timeout") {
          clock.fire(30000);
        } else {
          await service.shutdown();
        }
        await rejected;
        await LBTestUtils.waitForCondition(
          () => !channel.isPending(),
          "The actual HTTP channel is cancelled"
        );
        Assert.equal(channel.status, Cr.NS_BINDING_ABORTED);
        response.finish();
        responses.delete(response);
        await service.shutdown();
        Assert.equal(clock.timers.size, 0);
      } finally {
        Services.obs.removeObserver(observer, "http-on-modify-request");
      }
    }
  }
);

add_task(
  async function http_cross_origin_redirect_drops_validators_and_uses_final_base() {
    const source = new LBHttpServer();
    const target = new LBHttpServer();
    source.start(-1);
    target.start(-1);
    registerCleanupFunction(() =>
      Promise.all([
        new Promise(resolve => source.stop(resolve)),
        new Promise(resolve => target.stop(resolve)),
      ])
    );
    const sourceURL = `http://localhost:${source.identity.primaryPort}/feed`;
    const targetBase = `http://localhost:${target.identity.primaryPort}`;
    const xml =
      '<rss version="2.0"><channel><title>Redirected feed</title><link>/</link><description>Service test</description><item><title>Entry</title><link>/entry</link></item></channel></rss>';
    let redirect = false;
    let targetRequests = 0;
    source.registerPathHandler("/feed", (request, response) => {
      if (redirect) {
        Assert.equal(request.getHeader("If-None-Match"), '"source-v1"');
        Assert.equal(
          request.getHeader("If-Modified-Since"),
          "Mon, 01 Jan 2024 00:00:00 GMT"
        );
        response.setStatusLine(request.httpVersion, 302, "Found");
        response.setHeader("Location", `${targetBase}/feed`, false);
      } else {
        response.setHeader("Content-Type", "application/rss+xml", false);
        response.setHeader("ETag", '"source-v1"', false);
        response.setHeader(
          "Last-Modified",
          "Mon, 01 Jan 2024 00:00:00 GMT",
          false
        );
        response.write(xml);
      }
    });
    target.registerPathHandler("/feed", (request, response) => {
      targetRequests++;
      for (const name of [
        "If-None-Match",
        "If-Modified-Since",
        "Cookie",
        "Authorization",
      ]) {
        Assert.ok(
          !request.hasHeader(name),
          `${name} is not forwarded to another origin`
        );
      }
      response.setHeader("Content-Type", "application/rss+xml", false);
      response.write(xml);
    });
    const { service, parentGuid } = await lbHTTPHarness({ parser: undefined });
    const subscription = await service.create({
      feedURL: sourceURL,
      parentGuid,
    });
    redirect = true;
    const feed = await service.refresh(subscription.guid, { force: true });
    Assert.equal(targetRequests, 1);
    Assert.equal(feed.siteURL, `${targetBase}/`);
    Assert.equal(feed.items[0].url, `${targetBase}/entry`);
  }
);

add_task(
  async function http_validators_are_scoped_to_the_final_resource_not_just_origin() {
    const server = new LBHttpServer();
    server.start(-1);
    registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));
    const base = `http://localhost:${server.identity.primaryPort}`;
    const modified = "Mon, 01 Jan 2024 00:00:00 GMT";
    const xml = title =>
      `<rss version="2.0"><channel><title>${title}</title><link>https://example.org/</link><description>Service test</description><item><title>${title} entry</title><link>https://example.org/${title}</link></item></channel></rss>`;
    let mode = "redirect";
    let aRequests = 0;
    let bRequests = 0;
    const writeFeed = (request, response, title) => {
      response.setHeader("ETag", '"shared"', false);
      response.setHeader("Last-Modified", modified, false);
      if (request.hasHeader("If-None-Match")) {
        Assert.equal(request.getHeader("If-None-Match"), '"shared"');
        Assert.equal(request.getHeader("If-Modified-Since"), modified);
        response.setStatusLine(request.httpVersion, 304, "Not Modified");
      } else {
        response.setHeader("Content-Type", "application/rss+xml", false);
        response.write(xml(title));
      }
    };
    server.registerPathHandler("/A", (request, response) => {
      aRequests++;
      if (aRequests <= 3) {
        Assert.ok(
          !request.hasHeader("If-None-Match"),
          "B's ETag must not be sent to A"
        );
        Assert.ok(
          !request.hasHeader("If-Modified-Since"),
          "B's Last-Modified must not be sent to A"
        );
      }
      if (mode != "direct") {
        response.setStatusLine(request.httpVersion, 302, "Found");
        response.setHeader("Location", `${base}/B`, false);
      } else {
        writeFeed(request, response, "A");
      }
    });
    server.registerPathHandler("/B", (request, response) => {
      bRequests++;
      if (bRequests == 2) {
        Assert.ok(
          request.hasHeader("If-None-Match"),
          "The matching redirected resource receives its validators"
        );
      }
      if (mode == "unsolicited") {
        Assert.ok(
          !request.hasHeader("If-None-Match"),
          "A's ETag is removed even on a same-origin redirect"
        );
        Assert.ok(!request.hasHeader("If-Modified-Since"));
        response.setStatusLine(request.httpVersion, 304, "Not Modified");
      } else {
        writeFeed(request, response, "B");
      }
    });
    const { service, parentGuid } = await lbHTTPHarness({ parser: undefined });
    const { guid } = await service.create({ feedURL: `${base}/A`, parentGuid });
    Assert.equal((await service.refresh(guid, { force: true })).title, "B");
    Assert.equal(bRequests, 2);
    mode = "direct";
    Assert.equal(
      (await service.refresh(guid, { force: true })).title,
      "A",
      "A's different representation is fetched despite the identical ETag"
    );
    Assert.equal(
      (await service.refresh(guid, { force: true })).title,
      "A",
      "A may now validate its own cached representation"
    );
    mode = "unsolicited";
    await Assert.rejects(
      service.refresh(guid, { force: true }),
      /unsolicited 304/
    );
    Assert.equal(
      service.peek(guid).items[0].title,
      "A entry",
      "An unsolicited 304 cannot reuse another resource's cache"
    );
  }
);

add_task(async function unsolicited_304_without_any_validator_is_rejected() {
  let requests = 0;
  const { service, parentGuid } = await lbHarness({
    download: async () =>
      ++requests == 1
        ? lbResponse({ etag: "", lastModified: "" })
        : { status: 304 },
  });
  const { guid } = await service.create({
    feedURL: "https://example.org/feed",
    parentGuid,
  });
  await Assert.rejects(
    service.refresh(guid, { force: true }),
    /unsolicited 304/
  );
});

add_task(async function http_received_and_decompressed_size_caps() {
  const server = new LBHttpServer();
  server.start(-1);
  registerCleanupFunction(() => new Promise(resolve => server.stop(resolve)));
  const base = `http://localhost:${server.identity.primaryPort}`;
  server.registerPathHandler("/large", (request, response) => {
    response.setHeader("Content-Type", "application/xml", false);
    response.write("x".repeat(LB_LIMIT + 1));
  });
  server.registerPathHandler("/chunked", (request, response) => {
    response.processAsync();
    response.setHeader("Content-Type", "application/xml", false);
    response.write("x".repeat(LB_LIMIT + 1));
    response.finish();
  });
  // gzip.compress(b"x" * (2 * 1024 * 1024 + 1), mtime=0), base64 encoded.
  const compressed = atob(
    "H4sIAAAAAAAC/+3BMQEAAADCoNqLbwwfo" + "A".repeat(2709) + "DOBkHRp6EBACAA"
  );
  server.registerPathHandler("/compressed", (request, response) => {
    response.setHeader("Content-Type", "application/xml", false);
    response.setHeader("Content-Encoding", "gzip", false);
    response.write(compressed);
  });
  const { service, parentGuid } = await lbHTTPHarness();
  await Assert.rejects(
    service.create({ feedURL: `${base}/large`, parentGuid }),
    /2 MiB received/
  );
  await Assert.rejects(
    service.create({ feedURL: `${base}/chunked`, parentGuid }),
    /2 MiB received/
  );
  await Assert.rejects(
    service.create({ feedURL: `${base}/compressed`, parentGuid }),
    /2 MiB decoded/
  );
  Assert.equal(service.list().length, 0);
});
