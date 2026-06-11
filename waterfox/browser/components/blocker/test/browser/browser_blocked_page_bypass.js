/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WaterfoxBlockedPageChild } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockedPageChild.sys.mjs"
);
const { WaterfoxBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);
const { WaterfoxBlockerPanel } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerPanel.sys.mjs"
);

const PERMISSION_TYPE = "waterfox-blocker";
const PERMISSION_TYPE_PB = "waterfox-blocker-pb";
const BLOCKED_URL = "https://example.com/path?x=1&y=a%20b";
const BLOCKED_HOST = "example.com";
const FORGED_URL = "https://victim.example/";
const FORGED_HOST = "victim.example";
const PERMANENT_HOST = "permanent.example";
const PANEL_TEST_HOST = "example.com";
const PANEL_TEST_URL =
  "https://example.com/browser/browser/base/content/test/general/dummy_page.html";
const VALIDATION_BROWSER_ID = 8675309;

function blockedPageUrl(url = BLOCKED_URL) {
  const params = new URLSearchParams({ url, rule: "test" });
  return `about:contentblocked?${params}`;
}

function cleanupBlockerState() {
  Services.perms.removeByType(PERMISSION_TYPE);
  Services.perms.removeByType(PERMISSION_TYPE_PB);
  WaterfoxBlockerService._clearTopLevelNavigationState();
}

async function openBlockedPageInNewTab(url = BLOCKED_URL, win = window) {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    win.gBrowser,
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

async function closePrivateWindowAndWait(privateWin) {
  const pbExited = TestUtils.topicObserved("last-pb-context-exited");
  await BrowserTestUtils.closeWindow(privateWin);
  await pbExited;
}

function contentBlockingAllowList() {
  return Cc["@mozilla.org/content-blocking-allow-list;1"].getService(
    Ci.nsIContentBlockingAllowList
  );
}

function principalForHost(host) {
  const uri = Services.io.newURI(`https://${host}`);
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    uri,
    {}
  );
  return contentBlockingAllowList().computeContentBlockingAllowListPrincipal(
    principal
  );
}

function hasPermission(host, permissionType) {
  return (
    Services.perms.testPermissionFromPrincipal(
      principalForHost(host),
      permissionType
    ) === Services.perms.ALLOW_ACTION
  );
}

function assertPermission(host, permissionType, expected, message) {
  Assert.equal(hasPermission(host, permissionType), expected, message);
}

function makeSiteExceptionsState() {
  const allowed = new Set();
  return {
    allowSiteForSession(domain) {
      allowed.add(String(domain || "").replace(/\.$/, ""));
    },

    isSiteExcepted(domain) {
      return allowed.has(String(domain || "").replace(/\.$/, ""));
    },
  };
}

function allowIfRecorded(browserId, url) {
  const hostname = new URL(url).hostname;
  if (!WaterfoxBlockerService.wasHostBlockedFor(browserId, hostname, url)) {
    return false;
  }

  WaterfoxBlockerService.allowSiteForSession(hostname);
  return true;
}

add_setup(function setup() {
  registerCleanupFunction(cleanupBlockerState);
});

add_task(function test_session_bypass_requires_recorded_blocked_host() {
  cleanupBlockerState();
  const originalSiteExceptionsState =
    WaterfoxBlockerService._siteExceptionsState;
  WaterfoxBlockerService._siteExceptionsState = makeSiteExceptionsState();

  try {
    WaterfoxBlockerService._rememberBlockedTopLevelDocument(
      VALIDATION_BROWSER_ID,
      BLOCKED_HOST,
      BLOCKED_URL
    );

    Assert.equal(
      allowIfRecorded(VALIDATION_BROWSER_ID, FORGED_URL),
      false,
      "A forged blocked page for an unrelated host should not be allowed"
    );
    Assert.equal(
      WaterfoxBlockerService.shouldBypassBlocking(FORGED_HOST),
      false,
      "The unrelated host should not receive a session bypass"
    );
    Assert.equal(
      WaterfoxBlockerService.shouldBypassBlocking(BLOCKED_HOST),
      false,
      "A mismatched validation should consume the recorded block without granting"
    );

    WaterfoxBlockerService._rememberBlockedTopLevelDocument(
      VALIDATION_BROWSER_ID,
      BLOCKED_HOST,
      BLOCKED_URL
    );

    Assert.equal(
      allowIfRecorded(VALIDATION_BROWSER_ID, BLOCKED_URL),
      true,
      "The recorded blocked host should be allowed"
    );
    Assert.equal(
      WaterfoxBlockerService.shouldBypassBlocking(BLOCKED_HOST),
      true,
      "The recorded host should receive a session bypass"
    );
    Assert.equal(
      WaterfoxBlockerService.shouldBypassBlocking(FORGED_HOST),
      false,
      "The bypass should not apply to other hosts"
    );
    Assert.equal(
      allowIfRecorded(VALIDATION_BROWSER_ID, BLOCKED_URL),
      false,
      "The recorded blocked document should be consumed after validation"
    );
  } finally {
    WaterfoxBlockerService._clearTopLevelNavigationState();
    WaterfoxBlockerService._siteExceptionsState = originalSiteExceptionsState;
    cleanupBlockerState();
  }
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
      () =>
        WaterfoxBlockerService.isSiteExcepted(BLOCKED_HOST, {
          isPrivate: false,
        }),
      "Waiting for Load anyway to grant a session exception"
    );

    Assert.ok(
      WaterfoxBlockerService.isSiteExcepted(BLOCKED_HOST, { isPrivate: false }),
      "The genuine blocked page should grant a normal session exception"
    );
    Assert.ok(
      !WaterfoxBlockerService.isSiteExcepted(BLOCKED_HOST, { isPrivate: true }),
      "A normal session exception should not apply to private windows"
    );
  } finally {
    await BrowserTestUtils.removeTab(tab);
    cleanupBlockerState();
  }
});

add_task(
  async function test_private_load_anyway_grants_private_session_exception() {
    cleanupBlockerState();
    let privateWin = await BrowserTestUtils.openNewBrowserWindow({
      private: true,
    });

    try {
      const tab = await openBlockedPageInNewTab(BLOCKED_URL, privateWin);
      WaterfoxBlockerService._rememberBlockedTopLevelDocument(
        tab.linkedBrowser.browsingContext.top.browserId,
        BLOCKED_HOST,
        BLOCKED_URL
      );

      await clickLoadAnyway(tab.linkedBrowser);
      await TestUtils.waitForCondition(
        () =>
          WaterfoxBlockerService.isSiteExcepted(BLOCKED_HOST, {
            isPrivate: true,
          }),
        "Waiting for Load anyway to grant a private session exception"
      );

      Assert.ok(
        WaterfoxBlockerService.isSiteExcepted(BLOCKED_HOST, {
          isPrivate: true,
        }),
        "The private blocked page should grant a private session exception"
      );
      Assert.ok(
        !WaterfoxBlockerService.isSiteExcepted(BLOCKED_HOST, {
          isPrivate: false,
        }),
        "A private session exception should not apply to normal windows"
      );
      Assert.ok(
        WaterfoxBlockerService.shouldBypassBlocking(BLOCKED_HOST, {
          isPrivate: true,
        }),
        "Private bypass checks should see the private exception"
      );
      Assert.ok(
        !WaterfoxBlockerService.shouldBypassBlocking(BLOCKED_HOST, {
          isPrivate: false,
        }),
        "Normal bypass checks should not see the private exception"
      );

      await closePrivateWindowAndWait(privateWin);
      privateWin = null;

      Assert.ok(
        !WaterfoxBlockerService.isSiteExcepted(BLOCKED_HOST, {
          isPrivate: true,
        }),
        "The private session exception should be cleared after the private session ends"
      );
      Assert.ok(
        !WaterfoxBlockerService.isSiteExcepted(BLOCKED_HOST, {
          isPrivate: false,
        }),
        "The private session exception should leave no normal exception behind"
      );
    } finally {
      if (privateWin) {
        await closePrivateWindowAndWait(privateWin);
      }
      cleanupBlockerState();
    }
  }
);

add_task(async function test_private_panel_exception_uses_private_scope() {
  cleanupBlockerState();
  let privateWin = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  let tab = null;
  const originalReloadCurrentTab = WaterfoxBlockerPanel._reloadCurrentTab;
  WaterfoxBlockerPanel._reloadCurrentTab = () => {};

  try {
    tab = await BrowserTestUtils.openNewForegroundTab(
      privateWin.gBrowser,
      PANEL_TEST_URL
    );

    WaterfoxBlockerPanel._setSiteExceptionForCurrentSite(privateWin, true);

    Assert.ok(
      WaterfoxBlockerService.isSiteExcepted(PANEL_TEST_HOST, {
        isPrivate: true,
      }),
      "The private panel allow action should create a private exception"
    );
    assertPermission(
      PANEL_TEST_HOST,
      PERMISSION_TYPE_PB,
      true,
      "The private panel allow action should write a private permission"
    );
    assertPermission(
      PANEL_TEST_HOST,
      PERMISSION_TYPE,
      false,
      "The private panel allow action should not write a normal permission"
    );
    Assert.ok(
      WaterfoxBlockerService.shouldBypassBlocking(PANEL_TEST_HOST, {
        isPrivate: true,
      }),
      "The private panel allow action should bypass blocking in private windows"
    );

    WaterfoxBlockerPanel._setSiteExceptionForCurrentSite(privateWin, false);

    Assert.ok(
      !WaterfoxBlockerService.isSiteExcepted(PANEL_TEST_HOST, {
        isPrivate: true,
      }),
      "The private panel re-enable action should remove the private exception"
    );
    assertPermission(
      PANEL_TEST_HOST,
      PERMISSION_TYPE_PB,
      false,
      "The private panel re-enable action should remove the private permission"
    );
    assertPermission(
      PANEL_TEST_HOST,
      PERMISSION_TYPE,
      false,
      "The private panel re-enable action should not create a normal permission"
    );

    WaterfoxBlockerService.addSiteException(PANEL_TEST_HOST);
    assertPermission(
      PANEL_TEST_HOST,
      PERMISSION_TYPE,
      true,
      "The setup normal permission should exist before private re-enable"
    );

    WaterfoxBlockerPanel._setSiteExceptionForCurrentSite(privateWin, false);

    assertPermission(
      PANEL_TEST_HOST,
      PERMISSION_TYPE,
      true,
      "Private re-enable should not remove a normal permission"
    );
    assertPermission(
      PANEL_TEST_HOST,
      PERMISSION_TYPE_PB,
      false,
      "Private re-enable should not recreate a private permission"
    );

    WaterfoxBlockerService.removeSiteException(PANEL_TEST_HOST);
    assertPermission(
      PANEL_TEST_HOST,
      PERMISSION_TYPE,
      false,
      "The setup normal permission should be removable normally"
    );

    await BrowserTestUtils.removeTab(tab);
    tab = null;
    await closePrivateWindowAndWait(privateWin);
    privateWin = null;

    assertPermission(
      PANEL_TEST_HOST,
      PERMISSION_TYPE_PB,
      false,
      "No private permission should remain after closing the private window"
    );
    assertPermission(
      PANEL_TEST_HOST,
      PERMISSION_TYPE,
      false,
      "No normal permission should remain after closing the private window"
    );
  } finally {
    WaterfoxBlockerPanel._reloadCurrentTab = originalReloadCurrentTab;
    if (tab) {
      await BrowserTestUtils.removeTab(tab);
    }
    if (privateWin) {
      await closePrivateWindowAndWait(privateWin);
    }
    cleanupBlockerState();
  }
});

add_task(
  async function test_permanent_exception_persists_after_private_session() {
    cleanupBlockerState();
    let privateWin = null;

    try {
      WaterfoxBlockerService.addSiteException(PERMANENT_HOST);
      Assert.ok(
        WaterfoxBlockerService.isSiteExcepted(PERMANENT_HOST, {
          isPrivate: false,
        }),
        "A permanent exception should apply in normal windows"
      );
      Assert.ok(
        !WaterfoxBlockerService.isSiteExcepted(PERMANENT_HOST, {
          isPrivate: true,
        }),
        "A permanent normal exception should not apply in private windows"
      );

      privateWin = await BrowserTestUtils.openNewBrowserWindow({
        private: true,
      });
      await closePrivateWindowAndWait(privateWin);
      privateWin = null;

      Assert.ok(
        WaterfoxBlockerService.isSiteExcepted(PERMANENT_HOST, {
          isPrivate: false,
        }),
        "A permanent normal exception should persist after private browsing ends"
      );
      Assert.ok(
        !WaterfoxBlockerService.isSiteExcepted(PERMANENT_HOST, {
          isPrivate: true,
        }),
        "Ending private browsing should not create a private permanent exception"
      );
    } finally {
      if (privateWin) {
        await closePrivateWindowAndWait(privateWin);
      }
      cleanupBlockerState();
    }
  }
);

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
