/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WaterfoxBlockerService: blocker } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);
const FIXTURE_DIRECTORY =
  "/browser/waterfox/browser/components/blocker/test/browser/";
const RESPONSE_PATH = `${FIXTURE_DIRECTORY}file_native_response_worker.sjs`;
const WORKER_URL = `https://example.org${FIXTURE_DIRECTORY}file_native_response_worker.js`;
const RUN_ID = `stage3-${Date.now()}`;
const RESPONSE_TOPICS = [
  "http-on-examine-response",
  "http-on-examine-cached-response",
  "http-on-examine-merged-response",
];
let sequence = 0;

function fixtureUrl(kind, { host = "example.org", cache = "" } = {}) {
  const url = new URL(`https://${host}${RESPONSE_PATH}`);
  url.searchParams.set("case", kind);
  url.searchParams.set("token", `${RUN_ID}-${sequence++}`);
  if (cache) {
    url.searchParams.set("cache", cache);
  }
  return url.href;
}

function publishNativeRules(rules = ["||unrelated.example^"]) {
  const engine = Cc["@waterfox.com/waterfox-blocker-engine;1"].createInstance(
    Ci.nsIWaterfoxBlockerEngine
  );
  engine.initFromLists([rules.join("\n")]);
  engine.useResources("[]");
  blocker._publishEngine(engine, "[]");
  return engine;
}

function responseHeader(channel, name) {
  try {
    return channel.getResponseHeader(name);
  } catch (error) {
    if (error.result !== Cr.NS_ERROR_NOT_AVAILABLE) {
      throw error;
    }
    return null;
  }
}

function hasNativeChannelMark(channel, property) {
  const properties = channel.QueryInterface(Ci.nsIPropertyBag2);
  return (
    properties.hasKey(`${property}.hi`) &&
    properties.hasKey(`${property}.lo`) &&
    properties.getPropertyAsUint32(`${property}.hi`) * 2 ** 32 +
      properties.getPropertyAsUint32(`${property}.lo`) ===
      channel.QueryInterface(Ci.nsIIdentChannel).channelId &&
    properties.getPropertyAsACString(`${property}.url`) === channel.URI.spec &&
    properties.getPropertyAsACString(`${property}.method`) ===
      channel.requestMethod
  );
}

function tracePipeline(urls, inject = null) {
  const selected = new Set(urls);
  const trace = { phases: [], bridge: [], installations: [] };
  const originals = new Map();
  const topics = new Map();
  const observer = (subject, topic) => {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    if (selected.has(channel.URI.spec)) {
      const id = channel.QueryInterface(Ci.nsIIdentChannel).channelId;
      topics.set(id, topic);
      trace.phases.push({
        url: channel.URI.spec,
        id,
        topic,
        status: channel.responseStatus,
      });
    }
  };
  for (const topic of RESPONSE_TOPICS) {
    Services.obs.addObserver(observer, topic);
  }
  const originalBridge = blocker.filterAdBlockingResponse;
  originals.set("filterAdBlockingResponse", originalBridge);
  blocker.filterAdBlockingResponse = function (
    subject,
    url,
    type,
    resourcesJson,
    replaceJson
  ) {
    if (!selected.has(url)) {
      return originalBridge.apply(this, arguments);
    }
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    const id = channel.QueryInterface(Ci.nsIIdentChannel).channelId;
    const entry = {
      url,
      id,
      topic: topics.get(id),
      type,
      resourcesJson,
      replaceJson,
      status: channel.responseStatus,
      nativeResponse: hasNativeChannelMark(
        channel,
        "waterfox.adblocking.responseChannelId"
      ),
    };
    trace.bridge.push(entry);
    const directives = inject?.(entry) || { resourcesJson, replaceJson };
    const result = originalBridge.call(
      this,
      subject,
      url,
      type,
      directives.resourcesJson,
      directives.replaceJson
    );
    entry.header = responseHeader(channel, "X-Stage3-Adapter");
    Services.tm.dispatchToMainThread(() => {
      entry.csp = responseHeader(channel, "Content-Security-Policy");
    });
    return result;
  };
  const originalInstall = blocker._installResponseFilters;
  originals.set("_installResponseFilters", originalInstall);
  blocker._installResponseFilters = function (channel, url, html, replace) {
    if (selected.has(url) && (html.length || replace.length)) {
      trace.installations.push({ url, html: [...html], replace: [...replace] });
    }
    return originalInstall.apply(this, arguments);
  };
  let restored = false;
  trace.restore = () => {
    if (restored) {
      return;
    }
    restored = true;
    for (const [name, original] of originals) {
      blocker[name] = original;
    }
    for (const topic of RESPONSE_TOPICS) {
      Services.obs.removeObserver(observer, topic);
    }
  };
  registerCleanupFunction(trace.restore);
  return trace;
}

function assertNativeOwnership(trace, expectResponse = true) {
  Assert.equal(
    typeof blocker._onExamineResponse,
    "undefined",
    "No JS response backend remains"
  );
  if (expectResponse) {
    Assert.greater(trace.bridge.length, 0, "The native response bridge ran");
  }
  for (const entry of trace.bridge) {
    Assert.equal(
      entry.nativeResponse,
      true,
      "The native response marker matches the channel, URL and method"
    );
  }
}

async function frameState(browser, url) {
  return SpecialPowers.spawn(browser, [url], async source => {
    const frame = content.document.createElement("iframe");
    let timer;
    try {
      await new Promise((resolve, reject) => {
        timer = content.setTimeout(
          () => reject(new Error("Stage 3 iframe load timed out")),
          10000
        );
        frame.onload = resolve;
        frame.onerror = () => reject(new Error("Stage 3 iframe load failed"));
        frame.src = source;
        content.document.body.append(frame);
      });
      const win = frame.contentWindow.wrappedJSObject;
      return {
        url: frame.contentDocument.documentURI,
        adRan: !!win.nativeAdRan,
        keepRan: !!win.nativeKeepRan,
        adPresent: !!frame.contentDocument.getElementById("native-ad"),
        keep: frame.contentDocument.getElementById("native-keep")?.textContent,
      };
    } finally {
      content.clearTimeout(timer);
      frame.remove();
    }
  });
}

async function workerRequest(browser, url, kind = "fetch", method = "GET") {
  const result = await SpecialPowers.spawn(
    browser,
    [WORKER_URL, url, kind, method],
    async (script, target, operation, requestMethod) => {
      const worker = new content.Worker(script);
      let timer;
      try {
        return await new Promise(resolve => {
          timer = content.setTimeout(
            () => resolve({ success: false, timedOut: true }),
            10000
          );
          worker.onmessage = event =>
            resolve({ ...event.data, timedOut: false });
          worker.onerror = event => {
            event.preventDefault();
            resolve({ success: false, name: "WorkerError", timedOut: false });
          };
          worker.postMessage({
            kind: operation,
            url: target,
            method: requestMethod,
          });
        });
      } finally {
        content.clearTimeout(timer);
        worker.terminate();
      }
    }
  );
  Assert.equal(
    result.timedOut,
    false,
    "A worker timeout is not a blocked load"
  );
  return result;
}

async function pageFetch(browser, url) {
  const result = await SpecialPowers.spawn(browser, [url], async target => {
    const controller = new content.AbortController();
    let timedOut = false;
    const timer = content.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10000);
    try {
      const response = await content.fetch(target, {
        cache: "no-store",
        signal: controller.signal,
      });
      return { success: true, text: await response.text(), timedOut };
    } catch (error) {
      return { success: false, name: error.name, timedOut };
    } finally {
      content.clearTimeout(timer);
    }
  });
  Assert.equal(result.timedOut, false, "A fetch timeout is not a blocked load");
  return result;
}

add_setup(async function setupNativeResponseWorker() {
  const originalInitialize = blocker._initializeEngineWithRetry;
  const originalEngine = blocker._engine?.serialize() || null;
  const originalResources = blocker._resourcePayload;
  const permissionTypes = ["waterfox-blocker", "waterfox-blocker-pb"];
  const permissions = Services.perms.all.filter(permission =>
    permissionTypes.includes(permission.type)
  );
  registerCleanupFunction(async () => {
    blocker._initializeEngineWithRetry = originalInitialize;
    for (const type of permissionTypes) {
      Services.perms.removeByType(type);
    }
    for (const permission of permissions) {
      Services.perms.addFromPrincipal(
        permission.principal,
        permission.type,
        permission.capability,
        permission.expireType,
        permission.expireTime
      );
    }
    blocker._clearEngine();
    blocker._clearTopLevelNavigationState();
    if (originalEngine) {
      const engine = Cc[
        "@waterfox.com/waterfox-blocker-engine;1"
      ].createInstance(Ci.nsIWaterfoxBlockerEngine);
      engine.initFromCache(originalEngine);
      engine.useResources(originalResources);
      blocker._publishEngine(engine, originalResources);
    }
    await SpecialPowers.popPrefEnv();
  });
  blocker._initializeEngineWithRetry = async () => {};
  await SpecialPowers.pushPrefEnv({
    set: [
      ["waterfox.blocker.enabled", true],
      ["waterfox.blocker.allowSearchPartnerAds", false],
      ["waterfox.blocker.domainExceptions", "{}"],
      ["urlclassifier.enabled.mode", 0],
      ["dom.serviceWorkers.enabled", true],
      ["dom.serviceWorkers.testing.enabled", true],
    ],
  });
  for (const type of permissionTypes) {
    Services.perms.removeByType(type);
  }
  await blocker.init();
  publishNativeRules();
});

add_task(async function test_native_csp_cold_cached_and_merged_ownership() {
  publishNativeRules();
  await BrowserTestUtils.withNewTab(fixtureUrl("publisher"), async browser => {
    const control = await frameState(browser, fixtureUrl("control"));
    Assert.equal(control.adRan, true, "The fixture really executes inline JS");
    Assert.equal(control.keepRan, true, "The independent control script runs");
    const fresh = fixtureUrl("csp", { cache: "fresh" });
    const revalidate = fixtureUrl("csp", { cache: "revalidate" });
    const trace = tracePipeline([fresh, revalidate]);
    try {
      // Type-qualified CSP is unsupported by the vendored parser, not normalized away.
      const qualified = publishNativeRules([
        `|${fresh}|$subdocument,csp=script-src 'none'`,
      ]);
      Assert.equal(
        qualified.getCspDirectives(
          fresh,
          "example.org",
          "example.org",
          "subdocument",
          "GET",
          false
        ),
        "",
        "The baseline engine rejects type-qualified CSP"
      );
      publishNativeRules([
        `|${fresh}|$csp=script-src 'none'`,
        `|${revalidate}|$csp=script-src 'none'`,
      ]);
      for (const url of [fresh, fresh, revalidate, revalidate]) {
        const state = await frameState(browser, url);
        Assert.equal(state.url, url, "The intended response document loaded");
        Assert.equal(state.keep, "original-body-token", "The body is present");
        Assert.equal(state.adRan, false, "Native CSP suppresses inline JS");
        Assert.equal(
          state.keepRan,
          false,
          "CSP also suppresses the control JS"
        );
      }
      Assert.ok(
        trace.phases.some(
          phase =>
            phase.url === fresh &&
            phase.topic === "http-on-examine-cached-response"
        ),
        "The second fresh load exercised the HTTP cached-response observer"
      );
      Assert.ok(
        trace.phases.some(
          phase =>
            phase.url === revalidate &&
            phase.topic === "http-on-examine-response" &&
            phase.status === 304
        ),
        "Revalidation produced a real 304"
      );
      Assert.ok(
        trace.phases.some(
          phase =>
            phase.url === revalidate &&
            phase.topic === "http-on-examine-merged-response"
        ),
        "The merged-response observer ran"
      );
      for (const entry of trace.bridge) {
        Assert.equal(entry.type, "subdocument");
        Assert.ok(
          entry.csp.includes("img-src 'self'"),
          "Origin CSP is retained"
        );
        Assert.equal(
          entry.csp.split("script-src 'none'").length - 1,
          1,
          `Blocker CSP is not appended twice: ${entry.url} (${entry.topic})`
        );
      }
      publishNativeRules();
      for (const url of [fresh, revalidate]) {
        const state = await frameState(browser, url);
        Assert.equal(
          state.adRan,
          true,
          `Retired blocker CSP is not cached: ${url}`
        );
        Assert.equal(state.keepRan, true, "Origin CSP still allows scripts");
      }
      assertNativeOwnership(trace);
    } finally {
      trace.restore();
      publishNativeRules();
    }
  });
});

add_task(async function test_native_authentication_response_csp_lifetime() {
  const auth = Cc["@mozilla.org/network/http-auth-manager;1"].getService(
    Ci.nsIHttpAuthManager
  );
  let prompts = 0;
  const answerPrompt = subject => {
    prompts++;
    const dialog = subject.Dialog;
    dialog.ui.loginTextbox.value = "stage3";
    dialog.ui.password1Textbox.value = "password";
    dialog.ui.button0.click();
  };
  Services.obs.addObserver(answerPrompt, "common-dialog-loaded");
  try {
    publishNativeRules();
    await BrowserTestUtils.withNewTab(
      fixtureUrl("publisher"),
      async browser => {
        for (const redirectRetry of [false, true]) {
          await SpecialPowers.pushPrefEnv({
            set: [["network.auth.use_redirect_for_retries", redirectRetry]],
          });
          try {
            for (const challenge of ["empty", "different"]) {
              auth.clearAll();
              const target = new URL(fixtureUrl("auth"));
              target.searchParams.set("challenge", challenge);
              const url = target.href;
              const trace = tracePipeline([url]);
              const initialPrompts = prompts;
              try {
                publishNativeRules([`|${url}|$csp=script-src 'none'`]);
                for (const phase of ["cold", "cached"]) {
                  const state = await frameState(browser, url);
                  Assert.equal(
                    state.keep,
                    "authenticated-body",
                    `${phase}: final body`
                  );
                  Assert.equal(
                    state.adRan,
                    false,
                    `${phase}: origin CSP blocks unnonced JS`
                  );
                  Assert.equal(
                    state.keepRan,
                    false,
                    `${phase}: blocker CSP blocks nonced JS`
                  );
                }
                const challengePhase = trace.phases.find(
                  phase => phase.status === 401
                );
                const finalPhase = trace.phases.find(
                  phase =>
                    phase.status === 200 &&
                    phase.topic === "http-on-examine-response"
                );
                Assert.ok(
                  challengePhase,
                  "A real authentication challenge was observed"
                );
                Assert.ok(
                  finalPhase,
                  "The authenticated network response was observed"
                );
                Assert.equal(
                  challengePhase.id === finalPhase.id,
                  !redirectRetry,
                  "The configured retry mode actually determines channel reuse"
                );
                Assert.equal(
                  prompts - initialPrompts,
                  1,
                  "One prompt; cache reuse needs no authentication"
                );
                Assert.ok(
                  trace.phases.some(
                    phase => phase.topic === "http-on-examine-cached-response"
                  ),
                  "Authenticated response was reused from HTTP cache"
                );
                for (const phase of [
                  "http-on-examine-response",
                  "http-on-examine-cached-response",
                ]) {
                  const entry = trace.bridge.find(
                    item => item.status === 200 && item.topic === phase
                  );
                  Assert.ok(
                    entry,
                    `Final response is processed natively at ${phase}`
                  );
                  if (entry) {
                    Assert.ok(
                      entry.csp.includes("script-src 'nonce-stage3'"),
                      "Final origin CSP is retained"
                    );
                    Assert.ok(
                      !entry.csp.includes("img-src 'none'"),
                      "Challenge CSP never replaces final CSP"
                    );
                    Assert.equal(
                      entry.csp.split("script-src 'none'").length - 1,
                      1,
                      "Blocker CSP is applied once"
                    );
                  }
                }
                publishNativeRules();
                let state = await frameState(browser, url);
                Assert.equal(
                  state.adRan,
                  false,
                  "Retirement preserves cached origin CSP"
                );
                Assert.equal(
                  state.keepRan,
                  true,
                  "Retirement removes only blocker CSP; positive nonced control executes"
                );
                publishNativeRules([`|${url}|$csp=script-src 'none'`]);
                await SpecialPowers.pushPrefEnv({
                  set: [["waterfox.blocker.enabled", false]],
                });
                try {
                  state = await frameState(browser, url);
                  Assert.equal(
                    state.adRan,
                    false,
                    "Disable preserves cached origin CSP"
                  );
                  Assert.equal(
                    state.keepRan,
                    true,
                    "Disable leaves nonced script executable"
                  );
                } finally {
                  await SpecialPowers.popPrefEnv();
                }
                publishNativeRules([`|${url}|$csp=script-src 'none'`]);
                state = await frameState(browser, url);
                Assert.equal(
                  state.adRan,
                  false,
                  "Re-enable retains origin CSP"
                );
                Assert.equal(
                  state.keepRan,
                  false,
                  "Re-enable restores blocker CSP on the cached body"
                );
                assertNativeOwnership(trace);
              } finally {
                trace.restore();
                publishNativeRules();
              }
            }
          } finally {
            await SpecialPowers.popPrefEnv();
          }
        }
      }
    );
  } finally {
    Services.obs.removeObserver(answerPrompt, "common-dialog-loaded");
    auth.clearAll();
    publishNativeRules();
  }
});

add_task(async function test_native_standalone_partial_response_csp() {
  publishNativeRules();
  await BrowserTestUtils.withNewTab(fixtureUrl("publisher"), async browser => {
    const url = fixtureUrl("partial");
    Assert.equal(
      (await frameState(browser, url)).adRan,
      true,
      "Standalone 206 control executes scripts"
    );
    publishNativeRules([`|${url}|$csp=script-src 'none'`]);
    const trace = tracePipeline([url]);
    try {
      Assert.equal(
        (await frameState(browser, url)).adRan,
        false,
        "Native CSP covers standalone 206 documents"
      );
      Assert.ok(trace.phases.some(phase => phase.status === 206));
      Assert.ok(
        !trace.phases.some(
          phase => phase.topic === "http-on-examine-merged-response"
        )
      );
      assertNativeOwnership(trace);
    } finally {
      trace.restore();
    }
  });
});

add_task(async function test_native_bridge_adapter_capabilities_end_to_end() {
  publishNativeRules();
  await BrowserTestUtils.withNewTab(fixtureUrl("publisher"), async browser => {
    const control = await frameState(browser, fixtureUrl("adapter-control"));
    Assert.equal(control.adPresent, true);
    Assert.equal(control.adRan, true);
    Assert.equal(control.keepRan, true);
    Assert.equal(control.keep, "original-body-token");
    const urls = [
      fixtureUrl("adapter", { cache: "fresh" }),
      fixtureUrl("adapter", { cache: "revalidate" }),
    ];
    const html = JSON.stringify({
      selector: [
        { type: "css-selector", arg: "#native-ad, #native-ad-script" },
      ],
    });
    const replaceJson = JSON.stringify([
      "/original-body-token/rewritten-body-token/",
    ]);
    // Inject adapter capabilities only; the real engine has no directive producer.
    const trace = tracePipeline(urls, entry => ({
      resourcesJson: JSON.stringify({
        ...JSON.parse(entry.resourcesJson),
        html_filters: [html],
        response_header_filters: ["x-stage3-adapter"],
      }),
      replaceJson,
    }));
    try {
      for (const url of [urls[0], urls[0], urls[1], urls[1]]) {
        const state = await frameState(browser, url);
        Assert.equal(state.url, url);
        Assert.equal(state.adPresent, false, "HTML removal ran before parsing");
        Assert.equal(state.adRan, false, "The removed script never executed");
        Assert.equal(
          state.keepRan,
          true,
          "Unfiltered inline JS still executes"
        );
        Assert.equal(
          state.keep,
          "rewritten-body-token",
          "Body replacement ran"
        );
      }
      Assert.equal(trace.installations.length, 4, "One listener per body load");
      for (const installation of trace.installations) {
        Assert.deepEqual(installation.html, [html]);
        Assert.deepEqual(installation.replace, JSON.parse(replaceJson));
      }
      for (const entry of trace.bridge) {
        const resources = JSON.parse(entry.resourcesJson);
        Assert.ok(
          !resources.html_filters,
          "No real-engine HTML support assumed"
        );
        Assert.ok(
          !resources.response_header_filters,
          "No real-engine header-filter support assumed"
        );
        Assert.deepEqual(JSON.parse(entry.replaceJson), []);
        Assert.equal(entry.header, null, "The adapter removed the real header");
      }
      Assert.ok(
        trace.bridge.some(
          entry => entry.topic === "http-on-examine-cached-response"
        ),
        "Adapter dispatch includes cached responses"
      );
      Assert.ok(
        trace.bridge.some(
          entry => entry.topic === "http-on-examine-merged-response"
        ),
        "Adapter dispatch includes merged responses"
      );
      assertNativeOwnership(trace);
    } finally {
      trace.restore();
    }
  });
});

add_task(async function test_dedicated_worker_fetch_policy_and_attribution() {
  publishNativeRules();
  await BrowserTestUtils.withNewTab(fixtureUrl("publisher"), async browser => {
    const browserId = browser.browsingContext.top.browserId;
    const url = fixtureUrl("data", { host: "example.com" });
    const trace = tracePipeline([url]);
    blocker.resetBlockedCount(browserId);
    try {
      Assert.equal((await workerRequest(browser, url)).text, "network-body");
      publishNativeRules([
        "||example.com^$xmlhttprequest,method=POST,important",
      ]);
      Assert.equal((await workerRequest(browser, url)).success, true);
      Assert.equal(
        (await workerRequest(browser, url, "fetch", "POST")).success,
        false,
        "A worker POST is blocked by the native HTTP pipeline"
      );
      Assert.equal(blocker.getBlockedCount(browserId), 1);
      blocker.addDomainExceptionForSite("example.org", "example.com");
      Assert.equal(
        (await workerRequest(browser, url, "fetch", "POST")).text,
        "network-body",
        "The owning tab's domain allowance overrides an important worker block"
      );
      Assert.equal(blocker.getBlockedCount(browserId), 1);
      blocker.removeDomainExceptionForSite("example.org", "example.com");
      blocker.allowSiteForSession("example.org");
      Assert.equal(
        (await workerRequest(browser, url, "fetch", "POST")).text,
        "network-body",
        "The owning site's permission exempts worker fetches"
      );
      Assert.equal(blocker.getBlockedCount(browserId), 1);
      assertNativeOwnership(trace);
    } finally {
      trace.restore();
      blocker.removeDomainExceptionForSite("example.org", "example.com");
      blocker.removeSiteException("example.org");
      publishNativeRules();
    }
  });
});

add_task(async function test_private_dedicated_worker_permission_isolation() {
  publishNativeRules(["||example.com^$xmlhttprequest,method=POST,important"]);
  blocker.allowSiteForSession("example.org");
  const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
  const url = fixtureUrl("data", { host: "example.com" });
  const trace = tracePipeline([url]);
  try {
    const tab = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      fixtureUrl("publisher")
    );
    const browser = tab.linkedBrowser;
    const browserId = browser.browsingContext.top.browserId;
    blocker.resetBlockedCount(browserId);
    Assert.equal((await workerRequest(browser, url)).text, "network-body");
    Assert.equal(
      (await workerRequest(browser, url, "fetch", "POST")).success,
      false,
      "A normal site permission does not exempt a private worker"
    );
    Assert.equal(blocker.getBlockedCount(browserId), 1);
    blocker.allowSiteForSession("example.org", { isPrivate: true });
    Assert.equal(
      (await workerRequest(browser, url, "fetch", "POST")).text,
      "network-body",
      "A private site permission exempts a private worker"
    );
    Assert.equal(blocker.getBlockedCount(browserId), 1);
    assertNativeOwnership(trace);
  } finally {
    trace.restore();
    blocker.removeSiteException("example.org", { isPrivate: true });
    blocker.removeSiteException("example.org");
    await BrowserTestUtils.closeWindow(win);
    publishNativeRules();
  }
});

add_task(async function test_classic_worker_import_blocking_and_context() {
  const engine = publishNativeRules();
  await BrowserTestUtils.withNewTab(fixtureUrl("publisher"), async browser => {
    const browserId = browser.browsingContext.top.browserId;
    const url = fixtureUrl("import", { host: "example.com" });
    let captured;
    const observer = subject => {
      const channel = subject.QueryInterface(Ci.nsIHttpChannel);
      if (channel.URI.spec === url) {
        const request = engine.captureNativeLoad(
          channel.URI,
          channel.loadInfo,
          channel,
          engine.RESPONSE
        );
        captured = { browserId: request.browserId, type: request.requestType };
      }
    };
    const trace = tracePipeline([url]);
    Services.obs.addObserver(observer, "http-on-examine-response");
    blocker.resetBlockedCount(browserId);
    try {
      const control = await workerRequest(browser, url, "import");
      Assert.equal(control.success, true);
      Assert.equal(control.imported, 1, "The classic import really executed");
      Assert.ok(captured, "The native import request context was inspected");
      Assert.equal(captured.type, "script");
      publishNativeRules(["||example.com^$script,important"]);
      const blocked = await workerRequest(browser, url, "import");
      Assert.equal(
        blocked.success,
        false,
        "Native rules block classic imports"
      );
      Assert.equal(blocked.imported, 0, "The blocked import did not execute");
      if (captured.browserId === browserId) {
        Assert.equal(blocker.getBlockedCount(browserId), 1);
        blocker.addDomainExceptionForSite("example.org", "example.com");
        Assert.equal((await workerRequest(browser, url, "import")).imported, 1);
        Assert.equal(blocker.getBlockedCount(browserId), 1);
      } else {
        Assert.equal(
          captured.browserId,
          0,
          "Tabless imports are not misattributed"
        );
        Assert.equal(blocker.getBlockedCount(browserId), 0);
        info(
          "This baseline does not propagate a tab context for classic imports"
        );
      }
      assertNativeOwnership(trace);
    } finally {
      Services.obs.removeObserver(observer, "http-on-examine-response");
      trace.restore();
      blocker.removeDomainExceptionForSite("example.org", "example.com");
      publishNativeRules();
    }
  });
});

add_task(
  async function test_service_worker_synthetic_cache_and_network_policy() {
    publishNativeRules();
    const host = "example.net";
    const scope = `https://${host}${RESPONSE_PATH}`;
    const cacheName = `${RUN_ID}-service-worker`;
    const script =
      `https://${host}${FIXTURE_DIRECTORY}file_native_response_service_worker.js` +
      `?cacheName=${cacheName}`;
    const urls = ["sw-synthetic", "sw-cache", "sw-fallback"].map(kind =>
      fixtureUrl(kind, { host })
    );
    await BrowserTestUtils.withNewTab(
      fixtureUrl("publisher", { host }),
      async browser => {
        let trace;
        try {
          await SpecialPowers.spawn(
            browser,
            [script, scope, cacheName, urls[1]],
            async (scriptUrl, workerScope, name, cachedUrl) => {
              const sw = content.navigator.serviceWorker;
              let timer;
              let controllerChanged;
              try {
                await Promise.race([
                  (async () => {
                    const cache = await content.caches.open(name);
                    await cache.put(
                      cachedUrl,
                      new content.Response("cache-api-body", {
                        headers: { "Content-Type": "text/plain" },
                      })
                    );
                    const controlled = new Promise(resolve => {
                      controllerChanged = () => {
                        if (sw.controller?.scriptURL === scriptUrl) {
                          resolve();
                        }
                      };
                      sw.addEventListener(
                        "controllerchange",
                        controllerChanged
                      );
                      controllerChanged();
                    });
                    await sw.register(scriptUrl, { scope: workerScope });
                    await sw.ready;
                    await controlled;
                  })(),
                  new Promise((resolve, reject) => {
                    timer = content.setTimeout(
                      () =>
                        reject(new Error("Stage 3 service worker timed out")),
                      15000
                    );
                  }),
                ]);
              } finally {
                content.clearTimeout(timer);
                if (controllerChanged) {
                  sw.removeEventListener("controllerchange", controllerChanged);
                }
              }
            }
          );
          const expectedBodies = [
            "synthetic-body",
            "cache-api-body",
            "network-body",
          ];
          trace = tracePipeline(urls);
          for (const [index, url] of urls.entries()) {
            Assert.equal(
              (await pageFetch(browser, url)).text,
              expectedBodies[index]
            );
          }
          Assert.equal(
            trace.phases.filter(phase => phase.url === urls[0]).length,
            0,
            "A synthetic response is not an ordinary HTTP response"
          );
          Assert.equal(
            trace.phases.filter(phase => phase.url === urls[1]).length,
            0,
            "A Cache API hit does not use HTTP cached-response observers"
          );
          Assert.ok(
            trace.phases.some(phase => phase.url === urls[2]),
            "Network fallback reaches the real HTTP response pipeline"
          );
          assertNativeOwnership(trace);
          trace.restore();
          trace = null;

          publishNativeRules(
            urls.map(url => `|${url}|$xmlhttprequest,important`)
          );
          const browserId = browser.browsingContext.top.browserId;
          blocker.resetBlockedCount(browserId);
          trace = tracePipeline(urls);
          for (const [index, url] of urls.entries()) {
            Assert.equal(
              (await pageFetch(browser, url)).success,
              false,
              `Native policy blocks ${expectedBodies[index]} before delivery`
            );
          }
          Assert.equal(blocker.getBlockedCount(browserId), 3);
          Assert.deepEqual(
            trace.phases,
            [],
            "Blocked loads never reach HTTP responses"
          );
          Assert.deepEqual(
            trace.bridge,
            [],
            "Blocked loads need no response adapter"
          );
          assertNativeOwnership(trace, false);
          trace.restore();

          await SpecialPowers.pushPrefEnv({
            set: [["waterfox.blocker.enabled", false]],
          });
          trace = tracePipeline(urls);
          try {
            for (const [index, url] of urls.entries()) {
              const result = await pageFetch(browser, url);
              Assert.equal(
                result.success,
                true,
                `Disable permits ${expectedBodies[index]}`
              );
              Assert.equal(result.text, expectedBodies[index]);
            }
            Assert.equal(
              blocker.getBlockedCount(browserId),
              0,
              "Disable clears attribution and adds no ad actions"
            );
            Assert.ok(trace.phases.some(phase => phase.url === urls[2]));
            for (const url of urls.slice(0, 2)) {
              Assert.ok(!trace.phases.some(phase => phase.url === url));
            }
            Assert.deepEqual(
              trace.bridge,
              [],
              "Disable bypasses the native response adapter"
            );
            assertNativeOwnership(trace, false);
          } finally {
            trace.restore();
            await SpecialPowers.popPrefEnv();
          }

          publishNativeRules(
            urls.map(url => `|${url}|$xmlhttprequest,important`)
          );
          trace = tracePipeline(urls);
          for (const [index, url] of urls.entries()) {
            Assert.equal(
              (await pageFetch(browser, url)).success,
              false,
              `Re-enable restores protection for ${expectedBodies[index]}`
            );
          }
          Assert.equal(
            blocker.getBlockedCount(browserId),
            3,
            "Re-enabled native policy attributes each blocked load once"
          );
          Assert.deepEqual(
            trace.phases,
            [],
            "Re-enabled blocking precedes response delivery"
          );
          Assert.deepEqual(trace.bridge, []);
          // Synthetic and Cache API bodies are blocked, not rewritten by HTTP adapters.
          assertNativeOwnership(trace, false);
        } finally {
          trace?.restore();
          publishNativeRules();
          await SpecialPowers.spawn(
            browser,
            [scope, cacheName],
            async (url, name) => {
              const registration =
                await content.navigator.serviceWorker.getRegistration(url);
              if (registration) {
                await registration.unregister();
              }
              await content.caches.delete(name);
            }
          );
        }
      }
    );
  }
);
