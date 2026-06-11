/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WaterfoxBlockerService: blocker } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);
const NativeEngine = Ci.nsIWaterfoxBlockerEngine;
const FIXTURE_PATH =
  "/browser/waterfox/browser/components/blocker/test/browser/file_native_blocker.sjs";
const PUBLISHER_URL = `https://example.org${FIXTURE_PATH}?case=publisher`;
const AD_URL = `https://example.com${FIXTURE_PATH}`;
let originalInitialize;
let originalEngine;
let originalResources;
let originalAction;
const nativeActions = [];
let sequence = 0;

function publishNativeRules(rules, resources = "[]") {
  const engine =
    Cc["@waterfox.com/waterfox-blocker-engine;1"].createInstance(NativeEngine);
  engine.initFromLists([rules.join("\n")]);
  engine.useResources(resources);
  blocker._publishEngine(engine, resources);
  return engine;
}

function assertNativeOwnership() {
  Assert.equal(
    typeof blocker._onModifyRequest,
    "undefined",
    "No JS request backend remains"
  );
  Assert.greater(nativeActions.length, 0, "Native action notifications ran");
}

async function contentFetch(browser, url, method = "GET") {
  return SpecialPowers.spawn(
    browser,
    [url, method],
    async (requestUrl, requestMethod) => {
      try {
        const response = await content.fetch(requestUrl, {
          method: requestMethod,
          body: requestMethod === "POST" ? "native-body" : undefined,
        });
        return {
          success: true,
          url: response.url,
          text: await response.text(),
          header: response.headers.get("X-Native-Blocker"),
        };
      } catch (error) {
        return { success: false, name: error.name, message: error.message };
      }
    }
  );
}

add_setup(async function setupNativeNetwork() {
  originalInitialize = blocker._initializeEngineWithRetry;
  originalEngine = blocker._engine?.serialize() || null;
  originalResources = blocker._resourcePayload;
  originalAction = blocker.onAdBlockingAction;
  blocker._initializeEngineWithRetry = async () => {};
  await SpecialPowers.pushPrefEnv({
    set: [
      ["waterfox.blocker.enabled", true],
      ["waterfox.blocker.nativeNetwork", false],
      ["waterfox.blocker.allowSearchPartnerAds", false],
      ["waterfox.blocker.domainExceptions", "{}"],
      ["urlclassifier.enabled.mode", 0],
    ],
  });
  await blocker.init();
  blocker.onAdBlockingAction = function (...args) {
    nativeActions.push(args);
    return originalAction.apply(this, args);
  };
  publishNativeRules(["||unrelated.example^"]);
  registerCleanupFunction(async () => {
    blocker.onAdBlockingAction = originalAction;
    blocker._initializeEngineWithRetry = originalInitialize;
    Services.perms.removeByType("waterfox-blocker");
    Services.perms.removeByType("waterfox-blocker-pb");
    blocker._clearEngine();
    blocker._clearTopLevelNavigationState();
    if (originalEngine) {
      const engine =
        Cc["@waterfox.com/waterfox-blocker-engine;1"].createInstance(
          NativeEngine
        );
      engine.initFromCache(originalEngine);
      engine.useResources(originalResources);
      blocker._publishEngine(engine, originalResources);
    }
    await SpecialPowers.popPrefEnv();
  });
});

add_task(
  async function test_native_preconnect_methods_first_party_and_attribution() {
    await BrowserTestUtils.withNewTab(PUBLISHER_URL, async browser => {
      const browserId = browser.browsingContext.top.browserId;
      blocker.resetBlockedCount(browserId);
      publishNativeRules([
        "||example.com^$xmlhttprequest,method=POST,important",
        "||example.org^$xmlhttprequest,method=POST,important",
      ]);
      Assert.equal(
        (
          await contentFetch(
            browser,
            `${AD_URL}?case=method-${sequence++}`,
            "GET"
          )
        ).success,
        true
      );
      Assert.equal(
        (
          await contentFetch(
            browser,
            `${AD_URL}?case=method-${sequence++}`,
            "POST"
          )
        ).success,
        false,
        "Native pre-connect blocking runs with ETP classification disabled"
      );
      Assert.equal(
        (
          await contentFetch(
            browser,
            `${PUBLISHER_URL}&firstparty=${sequence++}`,
            "POST"
          )
        ).success,
        false,
        "Ad rules preserve first-party blocking"
      );
      Assert.equal(
        blocker.getBlockedCount(browserId),
        2,
        "Each applied ad cancellation is attributed once"
      );
      Assert.equal(
        nativeActions.length,
        2,
        "One native event per cancellation"
      );
      assertNativeOwnership();
      blocker.addDomainExceptionForSite("example.org", "example.com");
      Assert.equal(
        (
          await contentFetch(
            browser,
            `${AD_URL}?case=domain-${sequence++}`,
            "POST"
          )
        ).success,
        true,
        "Domain allowances override important native blocks"
      );
      Assert.equal(blocker.getBlockedCount(browserId), 2);
      blocker.removeDomainExceptionForSite("example.org", "example.com");
      blocker.allowSiteForSession("example.org");
      Assert.equal(
        (
          await contentFetch(
            browser,
            `${AD_URL}?case=site-${sequence++}`,
            "POST"
          )
        ).success,
        true,
        "Site permissions remain independent of matching"
      );
      Services.perms.removeByType("waterfox-blocker");
    });
  }
);

add_task(async function test_native_removeparam_redirect_legs_and_resources() {
  await BrowserTestUtils.withNewTab(PUBLISHER_URL, async browser => {
    const browserId = browser.browsingContext.top.browserId;
    blocker.resetBlockedCount(browserId);
    publishNativeRules([
      "||example.com^$xmlhttprequest,removeparam=tracking",
      `||example.com${FIXTURE_PATH}?case=redirect-target$xmlhttprequest,method=GET,important`,
    ]);

    const rewritten = await contentFetch(
      browser,
      `${AD_URL}?case=rewrite&tracking=1&keep=2`
    );
    Assert.equal(rewritten.success, true);
    Assert.ok(
      rewritten.text.includes("native-keep"),
      "The cleaned resource body is delivered"
    );
    Assert.equal(new URL(rewritten.url).searchParams.has("tracking"), false);
    Assert.equal(new URL(rewritten.url).searchParams.get("keep"), "2");
    const posted = await contentFetch(
      browser,
      `${AD_URL}?case=echo&tracking=1`,
      "POST"
    );
    Assert.equal(posted.success, true, "A rewrite preserves POST delivery");
    Assert.equal(
      posted.text,
      "POST|native-body",
      "Method and upload body survive the rewrite"
    );
    Assert.equal(new URL(posted.url).searchParams.has("tracking"), false);
    Assert.equal(
      (
        await contentFetch(
          browser,
          `${AD_URL}?case=rewrite&tracking=1&no-cors=1`
        )
      ).success,
      false,
      "The delivered target still needs its own CORS approval"
    );
    Assert.equal(
      blocker.getBlockedCount(browserId),
      0,
      "Removeparam is not counted as blocking"
    );
    Assert.equal(
      (await contentFetch(browser, `${AD_URL}?case=redirect`)).success,
      false,
      "A subsequent HTTP redirect leg receives its own native classification"
    );
    Assert.equal(blocker.getBlockedCount(browserId), 1);
    const resources = await (
      await fetch("resource://waterfox/blocker/assets/resources/resources.json")
    ).text();
    publishNativeRules(
      ["||example.com^$script,method=GET,redirect=noop.js"],
      resources
    );
    const result = await SpecialPowers.spawn(
      browser,
      [`${AD_URL}?case=script`],
      async url => {
        const script = content.document.createElement("script");
        const status = await new Promise(resolve => {
          script.onload = () => resolve("load");
          script.onerror = () => resolve("error");
          script.src = url;
          content.document.body.append(script);
        });
        return { status, ran: !!content.wrappedJSObject.nativeAdScriptRan };
      }
    );
    Assert.equal(
      result.status,
      "load",
      "Published native redirect resources are delivered"
    );
    Assert.equal(result.ran, false, "The replacement script is neutered");
    Assert.equal(blocker.getBlockedCount(browserId), 2);
  });
});

add_task(async function test_native_blocked_page_and_private_policy() {
  await SpecialPowers.pushPrefEnv({
    set: [["dom.disable_open_during_load", false]],
  });
  try {
    await BrowserTestUtils.withNewTab(PUBLISHER_URL, async browser => {
      publishNativeRules(["||example.com^$document,method=GET,important"]);
      const originalUrl = `${AD_URL}?case=blocked&value=a%20b&other=2`;
      const opened = BrowserTestUtils.waitForEvent(
        gBrowser.tabContainer,
        "TabOpen"
      );
      await SpecialPowers.spawn(browser, [originalUrl], url => {
        const script = content.document.createElement("script");
        script.textContent = `window.open(${JSON.stringify(url)}, "_blank")`;
        content.document.body.append(script);
      });
      const tab = (await opened).target;
      try {
        await BrowserTestUtils.waitForCondition(() =>
          tab.linkedBrowser.currentURI.spec.startsWith("about:contentblocked")
        );
        Assert.equal(
          new URL(tab.linkedBrowser.currentURI.spec).searchParams.get("url"),
          originalUrl,
          "The native blocked page preserves the full destination"
        );
        Assert.equal(
          nativeActions.filter(
            ([id, host, type]) =>
              id === tab.linkedBrowser.browsingContext.top.browserId &&
              host === "example.com" &&
              type === "document"
          ).length,
          1,
          "The native top-level block is attributed once"
        );
        await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
          await ContentTaskUtils.waitForCondition(() => {
            const button = content.document.getElementById("load-anyway");
            return button && !button.disabled;
          });
        });
        const loaded = BrowserTestUtils.browserLoaded(
          tab.linkedBrowser,
          false,
          originalUrl
        );
        await BrowserTestUtils.synthesizeMouseAtCenter(
          "#load-anyway",
          {},
          tab.linkedBrowser
        );
        await loaded;
        Assert.equal(
          tab.linkedBrowser.currentURI.spec,
          originalUrl,
          "Load anyway resumes the recorded blocked navigation"
        );
      } finally {
        BrowserTestUtils.removeTab(tab);
        blocker.removeSiteException("example.com");
      }
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
  publishNativeRules(["||example.com^$xmlhttprequest,method=POST,important"]);
  const privateWindow = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  try {
    const privateTab = await BrowserTestUtils.openNewForegroundTab(
      privateWindow.gBrowser,
      PUBLISHER_URL
    );
    const browser = privateTab.linkedBrowser;
    blocker.allowSiteForSession("example.org");
    Assert.equal(
      (
        await contentFetch(
          browser,
          `${AD_URL}?case=private-${sequence++}`,
          "POST"
        )
      ).success,
      false,
      "Normal permissions do not exempt private requests"
    );
    blocker.allowSiteForSession("example.org", { isPrivate: true });
    Assert.equal(
      (
        await contentFetch(
          browser,
          `${AD_URL}?case=private-${sequence++}`,
          "POST"
        )
      ).success,
      true,
      "Private permissions exempt private native requests"
    );
    assertNativeOwnership();
  } finally {
    await BrowserTestUtils.closeWindow(privateWindow);
    Services.perms.removeByType("waterfox-blocker");
    Services.perms.removeByType("waterfox-blocker-pb");
  }
});

add_task(async function test_native_concurrent_requests_during_publication() {
  await BrowserTestUtils.withNewTab(PUBLISHER_URL, async browser => {
    const browserId = browser.browsingContext.top.browserId;
    blocker.resetBlockedCount(browserId);
    const rules = ["||example.com^$xmlhttprequest,method=POST,important"];
    publishNativeRules(rules);
    const pending = Array.from({ length: 20 }, (_, index) =>
      contentFetch(
        browser,
        `${AD_URL}?case=concurrent-${sequence++}-${index}`,
        "POST"
      )
    );
    publishNativeRules(rules);
    const results = await Promise.all(pending);
    Assert.ok(
      results.every(result => !result.success),
      "Concurrent requests remain protected across publication"
    );
    Assert.equal(
      blocker.getBlockedCount(browserId),
      20,
      "Every concurrent native action is counted once"
    );
    assertNativeOwnership();
  });
});

add_task(async function test_native_memory_cache_policy() {
  publishNativeRules(["||unrelated.example^"]);
  await BrowserTestUtils.withNewTab(PUBLISHER_URL, async browser => {
    const browserId = browser.browsingContext.top.browserId;
    blocker.resetBlockedCount(browserId);
    const url = `${AD_URL}?case=script&cache=${sequence++}`;
    let httpLoads = 0;
    const observer = subject => {
      try {
        if (subject.QueryInterface(Ci.nsIHttpChannel).URI.spec === url) {
          httpLoads++;
        }
      } catch (_) {}
    };
    Services.obs.addObserver(observer, "http-on-modify-request");
    const loadScript = () =>
      SpecialPowers.spawn(browser, [url], async source => {
        content.wrappedJSObject.nativeAdScriptRan = false;
        const script = content.document.createElement("script");
        const status = new Promise(resolve => {
          script.onload = () => resolve("load");
          script.onerror = () => resolve("error");
        });
        script.src = source;
        content.document.body.append(script);
        return {
          status: await status,
          ran: !!content.wrappedJSObject.nativeAdScriptRan,
        };
      });
    try {
      Assert.deepEqual(await loadScript(), { status: "load", ran: true });
      Assert.equal(httpLoads, 1);
      publishNativeRules(["||example.com^$script,important"]);
      Assert.deepEqual(
        await loadScript(),
        { status: "error", ran: false },
        "Native synchronous policy rejects an already cached script"
      );
      Assert.equal(
        httpLoads,
        1,
        "The cached rejection does not depend on another HTTP channel"
      );
      Assert.equal(blocker.getBlockedCount(browserId), 1);
      assertNativeOwnership();
      const { NetUtil } = ChromeUtils.importESModule(
        "resource://gre/modules/NetUtil.sys.mjs"
      );
      const channel = NetUtil.newChannel({
        uri: url,
        loadingPrincipal: browser.contentPrincipal,
        securityFlags:
          Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
        contentPolicyType: Ci.nsIContentPolicy.TYPE_SCRIPT,
      });
      const context = browser.browsingContext;
      channel.loadInfo.associatedBrowsingContextID = context.id;
      const snapshot = blocker._engine.captureNativeLoad(
        channel.URI,
        channel.loadInfo,
        channel,
        NativeEngine.REQUEST
      );
      Assert.equal(snapshot.isCurrentForLoad(channel.loadInfo, channel), true);
      const loaded = BrowserTestUtils.browserLoaded(
        browser,
        false,
        PUBLISHER_URL
      );
      browser.reload();
      await loaded;
      Assert.equal(browser.browsingContext.id, context.id);
      Assert.notEqual(
        context.currentWindowGlobal.innerWindowId,
        snapshot.navigationId
      );
      Assert.equal(
        snapshot.isCurrentForLoad(channel.loadInfo, channel),
        false,
        "Same-context navigation retires the previous document snapshot"
      );
    } finally {
      Services.obs.removeObserver(observer, "http-on-modify-request");
    }
  });
});
