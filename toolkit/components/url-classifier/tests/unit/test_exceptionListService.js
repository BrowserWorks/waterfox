/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* Unit tests for the nsIUrlClassifierExceptionListService implementation. */

const { RemoteSettings } = ChromeUtils.importESModule(
  "resource://services-settings/remote-settings.sys.mjs"
);

const COLLECTION_NAME = "url-classifier-exceptions";
const FEATURE_TRACKING_NAME = "tracking-annotation-test";
const FEATURE_TRACKING_PREF_NAME = "urlclassifier.tracking-annotation-test";
const FEATURE_SOCIAL_NAME = "socialtracking-annotation-test";
const FEATURE_SOCIAL_PREF_NAME = "urlclassifier.socialtracking-annotation-test";
const FEATURE_FINGERPRINTING_NAME = "fingerprinting-annotation-test";
const FEATURE_FINGERPRINTING_PREF_NAME =
  "urlclassifier.fingerprinting-annotation-test";

do_get_profile();

class UpdateEvent extends EventTarget {}
function waitForEvent(element, eventName) {
  return new Promise(function (resolve) {
    element.addEventListener(eventName, e => resolve(e.detail), { once: true });
  });
}

add_task(async function test_list_changes() {
  let exceptionListService = Cc[
    "@mozilla.org/url-classifier/exception-list-service;1"
  ].getService(Ci.nsIUrlClassifierExceptionListService);

  // Make sure we have a pref initially, since the exception list service
  // requires it.
  Services.prefs.setStringPref(FEATURE_TRACKING_PREF_NAME, "");

  let updateEvent = new UpdateEvent();
  let obs = data => {
    let event = new CustomEvent("update", { detail: data });
    updateEvent.dispatchEvent(event);
  };

  let records = [
    {
      id: "1",
      last_modified: 1000000000000001,
      category: "internal-pref",
      classifierFeatures: [FEATURE_TRACKING_NAME],
      urlPattern: "*://example.com/*",
    },
  ];

  // Add some initial data.
  let db = RemoteSettings(COLLECTION_NAME).db;
  await db.importChanges({}, Date.now(), records);
  let promise = waitForEvent(updateEvent, "update");

  exceptionListService.registerAndRunExceptionListObserver(
    FEATURE_TRACKING_NAME,
    FEATURE_TRACKING_PREF_NAME,
    obs
  );

  let list = await promise;
  Assert.equal(list.testGetEntries().length, 0, "No items in the list");

  // Second event is from the RemoteSettings record.
  list = await waitForEvent(updateEvent, "update");

  Assert.equal(list.testGetEntries().length, 1, "Has one item in the list");
  Assert.equal(
    list.testGetEntries()[0].urlPattern,
    "*://example.com/*",
    "First item is example.com"
  );
  records.push(
    // An entry which populates all fields of
    // nsIUrlClassifierExceptionListEntry.
    {
      id: "2",
      last_modified: 1000000000000002,
      category: "baseline",
      classifierFeatures: [FEATURE_TRACKING_NAME],
      urlPattern: "*://MOZILLA.ORG/*",
      topLevelUrlPattern: "*://example.com/*",
      isPrivateBrowsingOnly: true,
      filterContentBlockingCategories: ["standard"],
    },
    {
      id: "3",
      last_modified: 1000000000000003,
      category: "convenience",
      classifierFeatures: ["some-other-feature"],
      urlPattern: "*://noinclude.com/*",
    },
    {
      last_modified: 1000000000000004,
      category: "baseline",
      classifierFeatures: [FEATURE_TRACKING_NAME],
      urlPattern: "*://*.example.org/*",
    }
  );

  promise = waitForEvent(updateEvent, "update");

  await RemoteSettings(COLLECTION_NAME).emit("sync", {
    data: { current: records },
  });

  list = await promise;

  let entries = list.testGetEntries();
  Assert.equal(entries.length, 3, "Has three items in the list");
  entries = entries.sort((a, b) => a.urlPattern.localeCompare(b.urlPattern));

  Assert.equal(
    entries[1].urlPattern,
    "*://example.com/*",
    "First item is example.com"
  );
  Assert.equal(
    entries[2].urlPattern,
    "*://MOZILLA.ORG/*",
    "Second item is mozilla.org"
  );
  Assert.equal(
    entries[2].topLevelUrlPattern,
    "*://example.com/*",
    "Top level url pattern of second item is correctly set."
  );
  Assert.equal(
    entries[2].isPrivateBrowsingOnly,
    true,
    "isPrivateBrowsingOnly flag of second item is correctly set."
  );
  Assert.deepEqual(
    entries[2].filterContentBlockingCategories,
    ["standard"],
    "filterContentBlockingCategories of second item is correctly set."
  );
  Assert.equal(
    entries[0].urlPattern,
    "*://*.example.org/*",
    "Third item is *.example.org"
  );

  promise = waitForEvent(updateEvent, "update");

  Services.prefs.setStringPref(FEATURE_TRACKING_PREF_NAME, "*://test.com/*");

  list = await promise;

  entries = list.testGetEntries();

  Assert.equal(entries.length, 4, "Has four items in the list");

  entries = entries.sort((a, b) => a.urlPattern.localeCompare(b.urlPattern));

  Assert.equal(
    entries[1].urlPattern,
    "*://example.com/*",
    "First item is example.com"
  );
  Assert.equal(
    entries[2].urlPattern,
    "*://MOZILLA.ORG/*",
    "Second item is mozilla.org"
  );
  Assert.equal(
    entries[0].urlPattern,
    "*://*.example.org/*",
    "Third item is *.example.org"
  );
  Assert.equal(
    entries[3].urlPattern,
    "*://test.com/*",
    "Fourth item is test.com"
  );

  promise = waitForEvent(updateEvent, "update");

  Services.prefs.setStringPref(
    FEATURE_TRACKING_PREF_NAME,
    "*://test.com/*,*://whatever.com/*,*://*.abc.com/*"
  );

  list = await promise;

  entries = list.testGetEntries();
  Assert.equal(entries.length, 6, "Has six items in the list");

  entries = entries.sort((a, b) => a.urlPattern.localeCompare(b.urlPattern));

  Assert.equal(
    entries[4].urlPattern,
    "*://test.com/*",
    "First item is test.com"
  );
  Assert.equal(
    entries[5].urlPattern,
    "*://whatever.com/*",
    "Second item is whatever.com"
  );
  Assert.equal(
    entries[0].urlPattern,
    "*://*.abc.com/*",
    "Third item is *.abc.com"
  );
  Assert.equal(
    entries[2].urlPattern,
    "*://example.com/*",
    "Fourth item is example.com"
  );
  Assert.equal(
    entries[3].urlPattern,
    "*://MOZILLA.ORG/*",
    "Fifth item is mozilla.org"
  );
  Assert.equal(
    entries[1].urlPattern,
    "*://*.example.org/*",
    "Sixth item is *.example.org"
  );

  exceptionListService.unregisterExceptionListObserver(
    FEATURE_TRACKING_NAME,
    obs
  );
  exceptionListService.clear();

  await db.clear();
});

/**
 * This test make sure when a feature registers itself to exceptionlist service,
 * it can get the correct initial data.
 */
add_task(async function test_list_init_data() {
  let exceptionListService = Cc[
    "@mozilla.org/url-classifier/exception-list-service;1"
  ].getService(Ci.nsIUrlClassifierExceptionListService);

  // Make sure we have a pref initially, since the exception list service
  // requires it.
  Services.prefs.setStringPref(FEATURE_TRACKING_PREF_NAME, "");

  let updateEvent = new UpdateEvent();

  let records = [
    {
      id: "1",
      last_modified: 1000000000000001,
      category: "baseline",
      classifierFeatures: [FEATURE_TRACKING_NAME],
      urlPattern: "*://tracking.example.com/*",
    },
    {
      id: "2",
      last_modified: 1000000000000002,
      category: "convenience",
      classifierFeatures: [FEATURE_SOCIAL_NAME],
      urlPattern: "*://social.example.com/*",
    },
    {
      id: "3",
      last_modified: 1000000000000003,
      category: "baseline",
      classifierFeatures: [FEATURE_TRACKING_NAME],
      urlPattern: "*://*.tracking.org/*",
    },
    {
      id: "4",
      last_modified: 1000000000000004,
      category: "convenience",
      classifierFeatures: [FEATURE_SOCIAL_NAME],
      urlPattern: "*://MOZILLA.ORG/*",
    },
  ];

  // Add some initial data.
  let db = RemoteSettings(COLLECTION_NAME).db;
  await db.importChanges({}, Date.now(), records);

  // The first registered feature make ExceptionListService get the initial data
  // from remote setting.
  let promise = waitForEvent(updateEvent, "update");

  let obs = data => {
    let event = new CustomEvent("update", { detail: data });
    updateEvent.dispatchEvent(event);
  };
  exceptionListService.registerAndRunExceptionListObserver(
    FEATURE_TRACKING_NAME,
    FEATURE_TRACKING_PREF_NAME,
    obs
  );

  let list = await promise;
  Assert.equal(list.testGetEntries().length, 0, "Empty list initially");

  list = await waitForEvent(updateEvent, "update");
  let entries = list.testGetEntries();
  entries = entries.sort((a, b) => a.urlPattern.localeCompare(b.urlPattern));

  Assert.equal(entries.length, 2, "Has two items in the list");

  Assert.equal(
    entries[0].urlPattern,
    "*://*.tracking.org/*",
    "First item is *.tracking.org"
  );
  Assert.equal(
    entries[1].urlPattern,
    "*://tracking.example.com/*",
    "Second item is tracking.example.com"
  );

  // Register another feature after ExceptionListService got the initial data.
  promise = waitForEvent(updateEvent, "update");

  exceptionListService.registerAndRunExceptionListObserver(
    FEATURE_SOCIAL_NAME,
    FEATURE_SOCIAL_PREF_NAME,
    obs
  );

  list = await promise;
  entries = list.testGetEntries();
  entries = entries.sort((a, b) => a.urlPattern.localeCompare(b.urlPattern));

  Assert.equal(entries.length, 2, "Has two items in the list");
  Assert.equal(
    entries[0].urlPattern,
    "*://MOZILLA.ORG/*",
    "First item is mozilla.org"
  );
  Assert.equal(
    entries[1].urlPattern,
    "*://social.example.com/*",
    "Second item is social.example.com"
  );

  // Test registering a feature after ExceptionListService received the synced data.
  records.push(
    {
      id: "5",
      last_modified: 1000000000000002,
      category: "baseline",
      classifierFeatures: [FEATURE_FINGERPRINTING_NAME],
      urlPattern: "*://fingerprinting.example.com/*",
    },
    {
      id: "6",
      last_modified: 1000000000000002,
      category: "convenience",
      classifierFeatures: ["other-feature"],
      urlPattern: "*://not-a-fingerprinting.example.com/*",
    },
    {
      id: "7",
      last_modified: 1000000000000002,
      category: "baseline",
      classifierFeatures: [FEATURE_FINGERPRINTING_NAME],
      urlPattern: "*://*.fingerprinting.org/*",
    }
  );

  await RemoteSettings(COLLECTION_NAME).emit("sync", {
    data: { current: records },
  });

  promise = waitForEvent(updateEvent, "update");

  exceptionListService.registerAndRunExceptionListObserver(
    FEATURE_FINGERPRINTING_NAME,
    FEATURE_FINGERPRINTING_PREF_NAME,
    obs
  );

  list = await promise;

  entries = list.testGetEntries();
  entries = entries.sort((a, b) => a.urlPattern.localeCompare(b.urlPattern));
  Assert.equal(entries.length, 2, "Has two items in the list");
  Assert.equal(
    entries[0].urlPattern,
    "*://*.fingerprinting.org/*",
    "First item is *.fingerprinting.org"
  );
  Assert.equal(
    entries[1].urlPattern,
    "*://fingerprinting.example.com/*",
    "Second item is fingerprinting.example.com"
  );

  exceptionListService.unregisterExceptionListObserver(
    FEATURE_TRACKING_NAME,
    obs
  );
  exceptionListService.unregisterExceptionListObserver(
    FEATURE_SOCIAL_NAME,
    obs
  );
  exceptionListService.unregisterExceptionListObserver(
    FEATURE_FINGERPRINTING_NAME,
    obs
  );
  exceptionListService.clear();

  await db.clear();
});
