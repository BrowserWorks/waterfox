/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WaterfoxBlockedPageChild } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockedPageChild.sys.mjs"
);
const { WaterfoxBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);

const PERMISSION_TYPE = "waterfox-blocker";
const BLOCKED_URL = "https://example.com/path?x=1&y=a%20b";
const BLOCKED_HOST = "example.com";
const FORGED_URL = "https://victim.example/";
const FORGED_HOST = "victim.example";

function blockedPageUrl(url = BLOCKED_URL) {
  const params = new URLSearchParams({ url, rule: "test" });
  return `about:contentblocked?${params}`;
}

function cleanupBlockerState() {
  Services.perms.removeByType(PERMISSION_TYPE);
  WaterfoxBlockerService._clearTopLevelNavigationState();
}

async function openBlockedPageInNewTab(url = BLOCKED_URL) {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    blockedPageUrl(url)
  );
  await waitForLoadAnywayButton(tab.linkedBrowser);
  return tab;
}

async function waitForLoadAnywayButton(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(() => {
      const button = content.document.getElementById("load-anyway");
      return button && !button.disabled;
    }, "Waiting for the Load anyway button");
  });
}

async function clickLoadAnyway(browser) {
  await BrowserTestUtils.synthesizeMouseAtCenter("#load-anyway", {}, browser);
}

async function waitForActorRoundTrip() {
  await TestUtils.waitForTick();
  await TestUtils.waitForTick();
}

add_setup(function setup() {
  registerCleanupFunction(cleanupBlockerState);
});

add_task(async function test_principal_uses_outer_about_uri() {
  cleanupBlockerState();
  const tab = await openBlockedPageInNewTab();

  try {
    const windowGlobal = tab.linkedBrowser.browsingContext.currentWindowGlobal;
    const principalSpec = windowGlobal.documentPrincipal.URI?.spec || "";
    const documentURISpec = windowGlobal.documentURI?.spec || "";

    info(`about:contentblocked documentPrincipal.URI.spec: ${principalSpec}`);
    info(`about:contentblocked documentURI.spec: ${documentURISpec}`);

    Assert.ok(
      principalSpec.startsWith("about:contentblocked"),
      "The blocked page principal should expose the outer about: URI"
    );
    Assert.ok(
      documentURISpec.startsWith("about:contentblocked"),
      "The blocked page document URI should expose the outer about: URI"
    );
  } finally {
    await BrowserTestUtils.removeTab(tab);
    cleanupBlockerState();
  }
});

add_task(async function test_genuine_load_anyway_grants_session_exception() {
  cleanupBlockerState();
  const tab = await openBlockedPageInNewTab();

  try {
    WaterfoxBlockerService._rememberBlockedTopLevelDocument(
      gBrowser.selectedBrowser.browserId,
      BLOCKED_HOST,
      BLOCKED_URL
    );

    await clickLoadAnyway(tab.linkedBrowser);
    await TestUtils.waitForCondition(
      () => WaterfoxBlockerService.isSiteExcepted(BLOCKED_HOST),
      "Waiting for Load anyway to grant a session exception"
    );

    Assert.ok(
      WaterfoxBlockerService.isSiteExcepted(BLOCKED_HOST),
      "The genuine blocked page should grant a session exception"
    );
  } finally {
    await BrowserTestUtils.removeTab(tab);
    cleanupBlockerState();
  }
});

add_task(async function test_forged_blocked_page_does_not_grant() {
  cleanupBlockerState();
  const tab = await openBlockedPageInNewTab(FORGED_URL);

  try {
    await clickLoadAnyway(tab.linkedBrowser);
    await waitForActorRoundTrip();

    Assert.ok(
      !WaterfoxBlockerService.isSiteExcepted(FORGED_HOST),
      "A forged blocked page should not grant a session exception"
    );
  } finally {
    await BrowserTestUtils.removeTab(tab);
    cleanupBlockerState();
  }
});

add_task(function test_untrusted_click_handler_does_not_send_query() {
  let sentQuery = false;
  const actor = {
    _parseBlockedUrl() {
      return BLOCKED_URL;
    },
    sendQuery() {
      sentQuery = true;
      return Promise.resolve(true);
    },
  };

  WaterfoxBlockedPageChild.prototype.handleEvent.call(actor, {
    button: 0,
    isTrusted: false,
    originalTarget: { id: "load-anyway" },
    type: "click",
  });

  Assert.equal(sentQuery, false, "An untrusted click should not send a query");
});
