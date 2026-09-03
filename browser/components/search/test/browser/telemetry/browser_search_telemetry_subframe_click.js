/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Check sponsored links in subframes are reported accurately when clicked.
 *
 * Each test loads a page that has an iframe from an origin differing from the
 * SERP. Sponsored links also have a different origin so that we can set up a
 * server that redirects the user to their target page.
 *
 * The difference between each test is sponsored link load occurring in the
 * existing tab or a new tab/window.
 *
 */

"use strict";

let { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

const LINK_SELECTORS = {
  NEW_TAB: "#open_in_new_tab",
  SAME_TAB: "#open_in_same_tab",
};

const TEST_PROVIDER_INFO = [
  {
    telemetryId: "example",
    searchPageRegexp:
      /^https:\/\/example.org\/browser\/browser\/components\/search\/test\/browser\/telemetry\/searchTelemetry/,
    queryParamNames: ["s"],
    codeParamName: "abc",
    taggedCodes: ["ff"],
    adServerAttributes: ["mozAttr"],
    nonAdsLinkRegexps: [],
    extraAdServersRegexps: [/^http:\/\/localhost\:40000\/ad/],
    subframes: [
      {
        regexp:
          /^https:\/\/test1\.example\.com\/browser\/browser\/components\/search\/test\/browser\/telemetry\/searchTelemetrySubframe/,
        inspectRegexpInSERP: true,
        inspectRegexpInParent: true,
      },
    ],
    components: [
      {
        type: SearchSERPTelemetryUtils.COMPONENTS.AD_LINK,
        default: true,
      },
    ],
  },
];

// Choose a port that's also used in searchTelemetrySubframe.html
const PORT = 40000;

add_setup(async function () {
  let httpServer = new HttpServer();

  httpServer.start(PORT);

  httpServer.registerPathHandler("/ad", (request, response) => {
    response.setStatusLine(request.httpVersion, 302, "Found");
    response.setHeader("Location", "https://example.com/", false);
  });

  httpServer.registerPathHandler("/", (request, response) => {
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.write("Redirected Successfully!");
  });

  SearchSERPTelemetry.overrideSearchTelemetryForTests(TEST_PROVIDER_INFO);
  await waitForIdle();

  registerCleanupFunction(async () => {
    httpServer.stop();
    SearchSERPTelemetry.overrideSearchTelemetryForTests();
    resetTelemetry();
  });
});

async function clickLinkInSubframe(openInNewTab) {
  let query = openInNewTab ? LINK_SELECTORS.NEW_TAB : LINK_SELECTORS.SAME_TAB;

  let subframe = gBrowser.selectedBrowser.browsingContext.children[0];
  Assert.ok(subframe, "Subframe exists on page.");

  await SpecialPowers.spawn(subframe, [query], async _query => {
    let el = content.document.querySelector(_query);
    Assert.ok(el, "Clickable element is visible on page.");

    EventUtils.synthesizeMouseAtCenter(el, {}, content.window);
  });
}

add_task(async function test_click_subframe_link_and_load_page() {
  info("Load SERP in a new tab.");
  let url = getSERPUrl(
    "searchTelemetryAd_with_sponsored_subframe_visible.html"
  );
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);

  await assertSearchSourcesTelemetry(
    {},
    {
      "browser.search.content.unknown": { "example:tagged:ff": 1 },
      "browser.search.withads.unknown": { "example:tagged": 1 },
    }
  );

  info("Click link in subframe to load page in same tab.");
  let pageLoadPromise = BrowserTestUtils.waitForLocationChange(
    gBrowser,
    "https://example.com/"
  );
  await clickLinkInSubframe(false);
  await pageLoadPromise;

  await assertSearchSourcesTelemetry(
    {},
    {
      "browser.search.content.unknown": { "example:tagged:ff": 1 },
      "browser.search.withads.unknown": { "example:tagged": 1 },
      "browser.search.adclicks.unknown": { "example:tagged": 1 },
    }
  );

  BrowserTestUtils.removeTab(tab);
  resetTelemetry();
});

add_task(async function test_click_subframe_link_in_new_tab() {
  info("Load SERP in a new tab.");
  let url = getSERPUrl(
    "searchTelemetryAd_with_sponsored_subframe_visible.html"
  );
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);

  await assertSearchSourcesTelemetry(
    {},
    {
      "browser.search.content.unknown": { "example:tagged:ff": 1 },
      "browser.search.withads.unknown": { "example:tagged": 1 },
    }
  );

  info("Click link in subframe to open in a new tab.");
  let newTabPromise = BrowserTestUtils.waitForNewTab(gBrowser);
  let pageLoadPromise = BrowserTestUtils.waitForLocationChange(
    gBrowser,
    "https://example.com/"
  );
  await clickLinkInSubframe(true);
  let newTab = await newTabPromise;
  await pageLoadPromise;

  BrowserTestUtils.removeTab(newTab);

  await assertSearchSourcesTelemetry(
    {},
    {
      "browser.search.content.unknown": { "example:tagged:ff": 1 },
      "browser.search.withads.unknown": { "example:tagged": 1 },
      "browser.search.adclicks.unknown": { "example:tagged": 1 },
    }
  );

  BrowserTestUtils.removeTab(tab);
  resetTelemetry();
});

add_task(async function test_click_subframe_link_in_new_window() {
  info("Change pref so that links open in a new window.");
  await SpecialPowers.pushPrefEnv({
    set: [["browser.link.open_newwindow", 2]],
  });

  info("Load SERP in a new tab.");
  let url = getSERPUrl(
    "searchTelemetryAd_with_sponsored_subframe_visible.html"
  );
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, url);

  await assertSearchSourcesTelemetry(
    {},
    {
      "browser.search.content.unknown": { "example:tagged:ff": 1 },
      "browser.search.withads.unknown": { "example:tagged": 1 },
    }
  );

  info("Click link in subframe to open in a new window.");
  let newWindowPromise = BrowserTestUtils.waitForNewWindow({
    url: "https://example.com/",
    maybeErrorPage: true,
  });
  await clickLinkInSubframe(true);
  let newWindow = await newWindowPromise;

  await assertSearchSourcesTelemetry(
    {},
    {
      "browser.search.content.unknown": { "example:tagged:ff": 1 },
      "browser.search.withads.unknown": { "example:tagged": 1 },
      "browser.search.adclicks.unknown": { "example:tagged": 1 },
    }
  );

  await SpecialPowers.popPrefEnv();
  newWindow.close();
  BrowserTestUtils.removeTab(tab);
  resetTelemetry();
});
