"use strict";

add_task(async function test_blocking() {
  let listsLoaded = TestUtils.topicObserved(
    "content-classifier-filter-lists-loaded"
  );
  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.trackingprotection.content.testing", true],
      ["privacy.trackingprotection.content.protection.enabled", true],
      [
        "privacy.trackingprotection.content.protection.test_list_urls",
        BLOCK_LIST_URL,
      ],
      ["privacy.trackingprotection.content.annotation.enabled", false],
      ["privacy.trackingprotection.content.annotation.test_list_urls", ""],
    ],
  });

  let tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    TEST_TOP_PAGE
  );
  let browser = tab.linkedBrowser;
  await listsLoaded;

  let imageURL =
    TEST_BLOCKED_3RD_PARTY_DOMAIN +
    "browser/toolkit/components/antitracking/test/browser/raptor.jpg?" +
    Math.random();

  let loaded = await SpecialPowers.spawn(browser, [imageURL], async url => {
    let img = new content.Image();
    img.src = url;
    return new content.Promise(resolve => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
    });
  });
  ok(!loaded, "Third-party image from example.org should be blocked");

  let log = JSON.parse(await browser.getContentBlockingLog());
  let origin = TEST_BLOCKED_3RD_PARTY_DOMAIN.replace(/\/$/, "");
  ok(log[origin], "Content blocking log has entry for " + origin);
  if (log[origin]) {
    is(
      log[origin][0][0],
      Ci.nsIWebProgressListener.STATE_BLOCKED_TRACKING_CONTENT,
      "Entry has the STATE_BLOCKED_TRACKING_CONTENT flag"
    );
    is(log[origin][0][1], true, "Entry is marked as blocked");
  }

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_annotation() {
  let listsLoaded = TestUtils.topicObserved(
    "content-classifier-filter-lists-loaded"
  );

  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.trackingprotection.content.testing", true],
      ["privacy.trackingprotection.content.protection.enabled", false],
      ["privacy.trackingprotection.content.protection.test_list_urls", ""],
      ["privacy.trackingprotection.content.annotation.enabled", true],
      [
        "privacy.trackingprotection.content.annotation.test_list_urls",
        ANNOTATE_LIST_URL,
      ],
    ],
  });

  let tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    TEST_TOP_PAGE
  );
  let browser = tab.linkedBrowser;

  await listsLoaded;
  BrowserTestUtils.startLoadingURIString(browser, TEST_TOP_PAGE);
  await BrowserTestUtils.browserLoaded(browser);

  let imageURL =
    TEST_ANNOTATED_3RD_PARTY_DOMAIN +
    "browser/toolkit/components/antitracking/test/browser/raptor.jpg?" +
    Math.random();

  let loaded = await SpecialPowers.spawn(browser, [imageURL], async url => {
    let img = new content.Image();
    img.src = url;
    return new content.Promise(resolve => {
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
    });
  });
  ok(loaded, "Third-party image from example.org should NOT be blocked");

  let log = JSON.parse(await browser.getContentBlockingLog());
  let origin = TEST_ANNOTATED_3RD_PARTY_DOMAIN.replace(/\/$/, "");
  ok(log[origin], "Content blocking log has annotation entry for " + origin);
  if (log[origin]) {
    is(
      log[origin][0][0],
      Ci.nsIWebProgressListener.STATE_LOADED_LEVEL_2_TRACKING_CONTENT,
      "Entry has the STATE_LOADED_LEVEL_2_TRACKING_CONTENT flag"
    );
    is(log[origin][0][1], true, "Entry is marked as loaded");
  }

  BrowserTestUtils.removeTab(tab);
});
