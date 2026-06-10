"use strict";

// Verify that when the feature is disabled, the RS client is never
// initialized: get() is never called, no data fetched, no blocking.
add_task(async function test_rs_not_initialized_when_disabled() {
  let client = getRSClient();
  let db = client.db;

  await populateRS(db, "trackers", "disconnect-tracker-base", [
    "||example.org^",
  ]);

  // Spy on client.get() to verify it is never called. Restore on
  // cleanup regardless of pass/fail.
  let getCalled = false;
  let origGet = client.get;
  client.get = async (...args) => {
    getCalled = true;
    return origGet.call(client, ...args);
  };
  registerCleanupFunction(() => {
    client.get = origGet;
  });

  // Feature is disabled (both enabled prefs false), but engines pref is set.
  await pushEnginePrefs({
    protection: "trackers",
    protectionEnabled: false,
  });

  // Open a tab to trigger GetInstance() / channel classification.
  let tab = await openTestTab();
  let browser = tab.linkedBrowser;

  await assertImageLoaded(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org should load when feature is disabled"
  );

  // Proving a side effect *didn't* happen requires a bounded wait.
  // 2s is load-bearing: it needs to be long enough to cover a slow
  // async RS init on loaded CI hardware. If this test ever goes
  // intermittent, bump the wait rather than shorten it.
  // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
  await new Promise(resolve => setTimeout(resolve, 2000));

  ok(!getCalled, "RemoteSettings.get() should not be called when disabled");
});

// Basic blocking: a feature selected for blocking via the engines pref
// should cancel matching third-party requests and produce a content
// blocking log entry.
add_task(async function test_rs_blocking() {
  let client = getRSClient();
  let db = client.db;

  let record = await populateRS(db, "trackers", "disconnect-tracker-base", [
    "||example.org^",
  ]);

  await pushEnginePrefs({ protection: "trackers" });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, [record]);

  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "Third-party image from example.org should be blocked via RS"
  );

  await assertHasBlockingState(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    Ci.nsIWebProgressListener.STATE_BLOCKED_TRACKING_CONTENT,
    "Entry has the STATE_BLOCKED_TRACKING_CONTENT flag"
  );
});

// Basic annotation: a feature selected for annotation via the engines pref
// should allow matching requests to load but annotate them in the content
// blocking log.
add_task(async function test_rs_annotation() {
  let client = getRSClient();
  let db = client.db;

  let record = await populateRS(db, "trackers", "disconnect-tracker-base", [
    "||example.com^",
  ]);

  await pushEnginePrefs({ annotation: "trackers" });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, [record]);

  BrowserTestUtils.startLoadingURIString(browser, TEST_TOP_PAGE);
  await BrowserTestUtils.browserLoaded(browser);

  await assertImageLoaded(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "Third-party image from example.com should NOT be blocked"
  );

  await assertHasBlockingState(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    Ci.nsIWebProgressListener.STATE_LOADED_LEVEL_1_TRACKING_CONTENT,
    "Entry has the STATE_LOADED_LEVEL_1_TRACKING_CONTENT flag"
  );
});

// Feature selection: two features have stored data in RS, but only one is
// selected via the engines pref. The selected feature should block; the
// non-selected feature's rules should have no effect.
add_task(async function test_rs_nonselected_list_not_active() {
  let client = getRSClient();
  let db = client.db;

  let records = await populateMultipleRS(db, [
    {
      id: "trackers",
      name: "disconnect-tracker-base",
      rules: ["||example.org^"],
    },
    {
      id: "fingerprinters",
      name: "disconnect-fingerprinters-base",
      rules: ["||example.com^"],
    },
  ]);

  await pushEnginePrefs({ protection: "trackers" });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, records);

  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org should be blocked (active list)"
  );
  await assertImageLoaded(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "example.com should NOT be blocked (inactive list)"
  );
});

// Multiple active features: comma-separated feature names in the engines
// pref should all produce active engines that block their respective
// domains.
add_task(async function test_rs_multiple_active_lists() {
  let client = getRSClient();
  let db = client.db;

  let records = await populateMultipleRS(db, [
    {
      id: "trackers",
      name: "disconnect-tracker-base",
      rules: ["||example.org^"],
    },
    {
      id: "fingerprinters",
      name: "disconnect-fingerprinters-base",
      rules: ["||example.com^"],
    },
  ]);

  await pushEnginePrefs({ protection: "trackers,fingerprinters" });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, records);

  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org should be blocked (list-a active)"
  );
  await assertImageBlocked(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "example.com should be blocked (list-b active)"
  );
});

// Block vs annotate separation: one feature is assigned to blocking, another
// to annotation. The block feature should cancel requests, the annotate
// feature should allow them through but tag them in the content blocking
// log. Neither should cross over into the other mode.
add_task(async function test_rs_block_and_annotate_separation() {
  let client = getRSClient();
  let db = client.db;

  let records = await populateMultipleRS(db, [
    {
      id: "trackers",
      name: "disconnect-tracker-base",
      rules: ["||example.org^"],
    },
    {
      id: "fingerprinters",
      name: "disconnect-fingerprinters-base",
      rules: ["||example.com^"],
    },
  ]);

  await pushEnginePrefs({
    protection: "trackers",
    annotation: "fingerprinters",
  });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, records);

  BrowserTestUtils.startLoadingURIString(browser, TEST_TOP_PAGE);
  await BrowserTestUtils.browserLoaded(browser);

  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org should be blocked (on block list)"
  );
  await assertImageLoaded(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "example.com should NOT be blocked (on annotate list only)"
  );

  await assertHasBlockingState(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    Ci.nsIWebProgressListener.STATE_LOADED_FINGERPRINTING_CONTENT,
    "example.com is annotated as fingerprinting, not blocked"
  );
});

// Pref-driven feature switching: two features have stored data in RS.
// Changing the engines pref at runtime should rebuild engines from
// already-stored data without re-downloading, switching which domain is
// blocked.
add_task(async function test_rs_pref_switch_active_lists() {
  let client = getRSClient();
  let db = client.db;

  let records = await populateMultipleRS(db, [
    {
      id: "trackers",
      name: "disconnect-tracker-base",
      rules: ["||example.org^"],
    },
    {
      id: "fingerprinters",
      name: "disconnect-fingerprinters-base",
      rules: ["||example.com^"],
    },
  ]);

  await pushEnginePrefs({ protection: "trackers" });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, records);

  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org blocked with trackers active"
  );
  await assertImageLoaded(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "example.com not blocked with only trackers active"
  );

  // Switch to the fingerprinters feature via pref change. This triggers
  // RebuildEnginesFromStoredData which fires the notification.
  let listsLoaded = TestUtils.topicObserved(LISTS_LOADED_TOPIC);
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "privacy.trackingprotection.content.protection.engines",
        "fingerprinters",
      ],
    ],
  });
  await listsLoaded;

  BrowserTestUtils.startLoadingURIString(browser, TEST_TOP_PAGE);
  await BrowserTestUtils.browserLoaded(browser);

  await assertImageLoaded(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org no longer blocked after switching to fingerprinters"
  );
  await assertImageBlocked(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "example.com now blocked after switching to fingerprinters"
  );
});

// Sync deletion: removing a list via a RemoteSettings sync event should
// remove it from stored data so it no longer blocks matching requests.
add_task(async function test_rs_sync_deletion() {
  let client = getRSClient();
  let db = client.db;

  let record = await populateRS(db, "trackers", "disconnect-tracker-base", [
    "||example.org^",
  ]);

  await pushEnginePrefs({ protection: "trackers" });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, [record]);

  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org blocked before deletion"
  );

  let listsLoaded = TestUtils.topicObserved(LISTS_LOADED_TOPIC);
  await client.emit("sync", {
    data: { created: [], updated: [], deleted: [record] },
  });
  await listsLoaded;

  BrowserTestUtils.startLoadingURIString(browser, TEST_TOP_PAGE);
  await BrowserTestUtils.browserLoaded(browser);

  await assertImageLoaded(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org no longer blocked after sync deletion"
  );
});

// Sync update: updating a list's attachment via a RemoteSettings sync event
// should replace the old rules with the new ones, changing which domains
// are blocked.
add_task(async function test_rs_sync_update() {
  let client = getRSClient();
  let db = client.db;

  let origRecord = await populateRS(db, "trackers", "disconnect-tracker-base", [
    "||example.org^",
  ]);

  await pushEnginePrefs({ protection: "trackers" });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, [origRecord]);

  // Before update: example.org should be blocked, example.com should not.
  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org should be blocked before update"
  );
  await assertImageLoaded(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "example.com should not be blocked before update"
  );

  // Update the list to block example.com instead.
  let newRecord = await populateRS(db, "trackers", "disconnect-tracker-base", [
    "||example.com^",
  ]);

  let listsLoaded = TestUtils.topicObserved(LISTS_LOADED_TOPIC);
  await client.emit("sync", {
    data: {
      created: [],
      updated: [{ old: origRecord, new: newRecord }],
      deleted: [],
    },
  });
  await listsLoaded;

  BrowserTestUtils.startLoadingURIString(browser, TEST_TOP_PAGE);
  await BrowserTestUtils.browserLoaded(browser);

  await assertImageLoaded(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org no longer blocked after update"
  );
  await assertImageBlocked(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "example.com now blocked after update"
  );
});

add_task(async function test_rs_failed_update_preserves_blocking() {
  let client = getRSClient();
  let record = await populateRS(
    client.db,
    "trackers",
    "disconnect-tracker-base",
    ["||example.org^"]
  );
  await pushEnginePrefs({ protection: "trackers" });
  let { linkedBrowser: browser } = await openTestTab();
  await syncAndWaitForLists(client, [record]);
  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "Initial rules block example.org"
  );

  let updated = await populateRS(
    client.db,
    "trackers",
    "disconnect-tracker-base",
    ["||example.com^"]
  );
  let originalDownload = client.attachments.download;
  client.attachments.download = async () => {
    throw new Error("Attachment unavailable");
  };
  try {
    await syncAndWaitForLists(client, [updated]);
    await assertImageBlocked(
      browser,
      TEST_BLOCKED_3RD_PARTY_DOMAIN,
      "Failed update preserves the installed blocking engine"
    );
    await assertImageLoaded(
      browser,
      TEST_ANNOTATED_3RD_PARTY_DOMAIN,
      "Failed update does not install the new rules"
    );
  } finally {
    client.attachments.download = originalDownload;
  }

  await syncAndWaitForLists(client, [updated]);
  await assertImageLoaded(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "Successful retry replaces old rules"
  );
  await assertImageBlocked(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "Successful retry installs the new rules"
  );
});

add_task(async function test_rs_failed_update_preserves_exceptions() {
  let client = getRSClient();
  let records = await populateMultipleRS(client.db, [
    {
      id: "trackers",
      name: "disconnect-tracker-base",
      rules: ["||example.org^", "||example.com^"],
    },
    {
      id: "exceptions",
      name: "mozilla-major-exceptions",
      rules: ["@@||example.org^"],
    },
  ]);
  await pushEnginePrefs({ protection: "trackers,major-exceptions" });
  let { linkedBrowser: browser } = await openTestTab();
  await syncAndWaitForLists(client, records);
  await assertImageLoaded(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "Initial exception allows example.org"
  );
  await assertImageBlocked(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "Other tracking requests remain blocked"
  );

  let originalDownload = client.attachments.download;
  client.attachments.download = async (record, ...args) => {
    if (record.Name === "mozilla-major-exceptions") {
      throw new Error("Exception attachment unavailable");
    }
    return originalDownload.call(client.attachments, record, ...args);
  };
  try {
    await syncAndWaitForLists(client, records);
    await assertImageLoaded(
      browser,
      TEST_BLOCKED_3RD_PARTY_DOMAIN,
      "Failed refresh retains the exception engine"
    );
    await assertImageBlocked(
      browser,
      TEST_ANNOTATED_3RD_PARTY_DOMAIN,
      "Failed exception refresh leaves blocking active"
    );
  } finally {
    client.attachments.download = originalDownload;
  }
});

add_task(async function test_rs_empty_update_removes_blocking() {
  let client = getRSClient();
  let record = await populateRS(
    client.db,
    "trackers",
    "disconnect-tracker-base",
    ["||example.org^"]
  );
  await pushEnginePrefs({ protection: "trackers" });
  let { linkedBrowser: browser } = await openTestTab();
  await syncAndWaitForLists(client, [record]);
  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "Initial rules block example.org"
  );

  let [emptyRecord] = await populateMultipleRS(client.db, [
    { id: "trackers", name: "disconnect-tracker-base", content: "\n" },
  ]);
  await syncAndWaitForLists(client, [emptyRecord]);
  await assertImageLoaded(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "Successful empty update removes the blocking engine"
  );
});

// CRLF line endings: an attachment that uses Windows-style line endings
// should still produce a working filter list. The blank line in the middle
// must not fuse the surrounding rules together, so both example.org and
// example.com (each on their own \r\n-separated line) must independently
// block.
add_task(async function test_rs_crlf_line_endings() {
  let client = getRSClient();
  let db = client.db;

  let [record] = await populateMultipleRS(db, [
    {
      id: "trackers",
      name: "disconnect-tracker-base",
      content: "||example.org^\r\n\r\n||example.com^\r\n",
    },
  ]);

  await pushEnginePrefs({ protection: "trackers" });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, [record]);

  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org blocked from CRLF-formatted list (rule before blank line)"
  );
  await assertImageBlocked(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "example.com blocked from CRLF-formatted list (rule after blank line)"
  );
});

// Enable/disable/re-enable: the feature-enabled prefs should drive RS
// client lifecycle. After disable, matching requests must not be blocked.
// After re-enable with the engines pref set, classification must resume.
add_task(async function test_rs_enable_disable_reenable() {
  let client = getRSClient();
  let db = client.db;

  let record = await populateRS(db, "trackers", "disconnect-tracker-base", [
    "||example.org^",
  ]);

  await pushEnginePrefs({ protection: "trackers" });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, [record]);

  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org blocked while feature enabled"
  );

  // Disable the feature. This should tear down the RS client and
  // clear engines.
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.trackingprotection.content.protection.enabled", false]],
  });

  BrowserTestUtils.startLoadingURIString(browser, TEST_TOP_PAGE);
  await BrowserTestUtils.browserLoaded(browser);

  await assertImageLoaded(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org NOT blocked after disabling feature"
  );

  // Re-enable. RS client should be re-created and re-import data.
  let listsLoaded = TestUtils.topicObserved(LISTS_LOADED_TOPIC);
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.trackingprotection.content.protection.enabled", true]],
  });
  await listsLoaded;

  BrowserTestUtils.startLoadingURIString(browser, TEST_TOP_PAGE);
  await BrowserTestUtils.browserLoaded(browser);

  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org blocked again after re-enabling"
  );
});

// Empty collection: an RS collection with no records must still fire the
// lists-loaded notification so callers aren't left waiting forever, and
// the empty state must not block anything.
add_task(async function test_rs_empty_collection() {
  let client = getRSClient();
  let db = client.db;

  // Explicitly import an empty record set.
  await db.importChanges({}, Date.now(), [], { clear: true });

  // Use a feature whose RS data no other test populates, so the engine
  // truly cannot be built.
  await pushEnginePrefs({ protection: "cryptominers" });

  let tab = await openTestTab();
  let browser = tab.linkedBrowser;

  // Sync with an empty record set must still fire the lists-loaded topic.
  await syncAndWaitForLists(client, []);

  await assertImageLoaded(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org should load when collection is empty"
  );
});

// Two RS sync events fired back-to-back drive two real UpdateFeatures
// calls into the off-thread build pipeline. Unlike rapid pushPrefEnv
// calls on the same pref — which the pref system coalesces, so they
// don't reliably fire OnPrefChange twice — separate client.emit("sync")
// calls always run their own JS onSync handler and call
// service.onListsChanged independently. So this exercises the
// back-to-back rebuild path the off-thread pipeline was built for:
// two in-flight closures racing on mBuildThread, where the per-feature
// version counter must ensure the older closure can't clobber the
// newer install if their fetches resolve out of order.
add_task(async function test_rs_back_to_back_sync_updates() {
  let client = getRSClient();
  let db = client.db;

  // Start with rule A (blocks example.org) installed for trackers.
  let recordA = await populateRS(db, "trackers", "disconnect-tracker-base", [
    "||example.org^",
  ]);
  await pushEnginePrefs({ protection: "trackers" });
  let tab = await openTestTab();
  let browser = tab.linkedBrowser;
  await syncAndWaitForLists(client, [recordA]);
  await assertImageBlocked(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org blocked under initial rule A"
  );

  // Replace the record (same Name, new rules pointing at a different
  // third-party domain). After this populateRS the DB carries rule B
  // and any subsequent fetch returns rule B.
  let recordB = await populateRS(db, "trackers", "disconnect-tracker-base", [
    "||example.com^",
  ]);

  // Two sync emits in a row. Both kick off UpdateFeatures(trackers)
  // with fresh per-feature versions; both fetches read rule B from
  // the local DB; both produce engine-with-rule-B. The older closure
  // must not clobber the newer install — that's what per-feature
  // versioning guarantees. waitForListsSettled drains both rebuilds
  // before we sample state.
  let settled = waitForListsSettled();
  await client.emit("sync", {
    data: {
      created: [],
      updated: [{ old: recordA, new: recordB }],
      deleted: [],
    },
  });
  await client.emit("sync", {
    data: {
      created: [],
      updated: [{ old: recordA, new: recordB }],
      deleted: [],
    },
  });
  await settled;

  BrowserTestUtils.startLoadingURIString(browser, TEST_TOP_PAGE);
  await BrowserTestUtils.browserLoaded(browser);

  // After both rebuilds settle, the surviving engine is rule B:
  // example.org loads (no longer matched) and example.com is blocked.
  await assertImageLoaded(
    browser,
    TEST_BLOCKED_3RD_PARTY_DOMAIN,
    "example.org no longer blocked - rule A was superseded"
  );
  await assertImageBlocked(
    browser,
    TEST_ANNOTATED_3RD_PARTY_DOMAIN,
    "example.com blocked - rule B is the final installed engine"
  );
});
