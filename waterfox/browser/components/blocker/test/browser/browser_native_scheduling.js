/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WaterfoxBlockerService: blocker } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);
const FIXTURE_PATH =
  "/browser/waterfox/browser/components/blocker/test/browser/file_native_scheduling.sjs";
const PUBLISHER_URL = `https://example.org${FIXTURE_PATH}?case=publisher`;
const FIRST_PARTY_URL = `https://example.com${FIXTURE_PATH}?case=publisher`;
const LISTS_LOADED_TOPIC = "test-content-classifier-filter-lists-loaded";
const ETP_REASON = Ci.nsILoadInfo.BLOCKING_REASON_CLASSIFY_TRACKING_URI;
const RUN_ID = Services.uuid.generateUUID().toString();
let sequence = 0;
let resources;

function fixtureUrl(kind, host = "example.com") {
  const url = new URL(`https://${host}${FIXTURE_PATH}`);
  url.searchParams.set("case", kind);
  url.searchParams.set("token", `${RUN_ID}-${sequence++}`);
  return url.href;
}

function publishRules(rules) {
  const engine = Cc["@waterfox.com/waterfox-blocker-engine;1"].createInstance(
    Ci.nsIWaterfoxBlockerEngine
  );
  engine.initFromLists([rules.join("\n")]);
  engine.useResources(resources);
  blocker._publishEngine(engine, resources);
  return engine;
}

function scriptRule(url, redirect = false) {
  return `|${url}|$script,method=GET${redirect ? ",redirect=noop.js" : ",important"}`;
}

async function serverHits(url) {
  const query = new URL(url);
  query.searchParams.set("case", "hits");
  return (await fetch(query.href)).json();
}

async function loadScript(browser, url) {
  return SpecialPowers.spawn(browser, [url], async source => {
    content.wrappedJSObject.nativeSchedulingExecutions = 0;
    const script = content.document.createElement("script");
    const events = [];
    const outcome = await new Promise(resolve => {
      script.onload = () => {
        events.push("load");
        resolve("load");
      };
      script.onerror = () => {
        events.push("error");
        resolve("error");
      };
      script.src = source;
      content.document.body.append(script);
    });
    return {
      outcome,
      events,
      executions: content.wrappedJSObject.nativeSchedulingExecutions,
    };
  });
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

function traceRequest(url, suspend = false) {
  const entries = [];
  const observer = subject => {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    if (channel.URI.spec !== url) {
      return;
    }
    const entry = {
      channel,
      modifyReason: channel.loadInfo.requestBlockingReason,
      callbacks: [],
      bytes: 0,
      stops: 0,
    };
    entries.push(entry);
    entry.stopped = new Promise(resolve => {
      const original = channel
        .QueryInterface(Ci.nsITraceableChannel)
        .setNewListener({
          QueryInterface: ChromeUtils.generateQI([
            "nsIRequestObserver",
            "nsIStreamListener",
          ]),
          onStartRequest(request) {
            entry.callbacks.push("start");
            original.onStartRequest(request);
          },
          onDataAvailable(request, stream, offset, count) {
            entry.bytes += count;
            original.onDataAvailable(request, stream, offset, count);
          },
          onStopRequest(request, status) {
            entry.callbacks.push("stop");
            is(++entry.stops, 1, "The original channel completes exactly once");
            entry.status = status;
            entry.reason = channel.loadInfo.requestBlockingReason;
            try {
              original.onStopRequest(request, status);
            } finally {
              resolve();
            }
          },
        });
    });
    if (suspend) {
      channel.suspend();
      Services.tm.dispatchToMainThread(() => {
        const engine = Cc[
          "@waterfox.com/waterfox-blocker-engine;1"
        ].createInstance(Ci.nsIWaterfoxBlockerEngine);
        Assert.equal(
          engine.shouldSkipNetworkChannel(channel),
          true,
          "Pending ETP cancellation skips ad work while suspended"
        );
        let calls = 0;
        engine.checkChannel(channel, status => {
          Assert.equal(status, Cr.NS_OK);
          calls++;
        });
        Assert.equal(
          calls,
          1,
          "A pending ETP cancellation completes the classifier callback without dispatch"
        );
        channel.resume();
      });
    }
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  return {
    entries,
    stop() {
      Services.obs.removeObserver(observer, "http-on-modify-request");
    },
  };
}

async function assertEtpWins(browser, url, label, suspend = false) {
  const browserId = browser.browsingContext.top.browserId;
  blocker.resetBlockedCount(browserId);
  const trace = traceRequest(url, suspend);
  try {
    const result = await loadScript(browser, url);
    Assert.equal(
      trace.entries.length,
      1,
      `${label}: one original HTTP channel`
    );
    const [entry] = trace.entries;
    await entry.stopped;
    is(
      entry.modifyReason,
      ETP_REASON,
      `${label}: ETP decided before modify-request`
    );
    is(
      entry.status,
      Cr.NS_ERROR_TRACKING_URI,
      `${label}: ETP owns the completion error`
    );
    is(
      entry.channel.status,
      Cr.NS_ERROR_TRACKING_URI,
      `${label}: channel retains the ETP error`
    );
    is(entry.reason, ETP_REASON, `${label}: ETP owns the blocking reason`);
    is(
      entry.callbacks.join(","),
      "start,stop",
      `${label}: one start/stop callback pair`
    );
    is(entry.bytes, 0, `${label}: no original or replacement bytes`);
    is(result.outcome, "error", `${label}: no script or ad replacement loads`);
    is(result.events.join(","), "error", `${label}: one script error event`);
    is(result.executions, 0, `${label}: the original script never executes`);
    is(blocker.getBlockedCount(browserId), 0, `${label}: no ad attribution`);
    ok(
      !hasNativeChannelMark(
        entry.channel,
        "waterfox.adblocking.appliedChannelId"
      ),
      `${label}: no native ad action was applied`
    );
    const log = JSON.parse(await browser.getContentBlockingLog());
    const events = log[new URL(url).origin] || [];
    ok(
      events.some(
        ([state, blocked]) =>
          state === Ci.nsIWebProgressListener.STATE_BLOCKED_TRACKING_CONTENT &&
          blocked
      ),
      `${label}: ETP block is logged`
    );
    ok(
      !events.some(
        ([state]) =>
          state === Ci.nsIWebProgressListener.STATE_REPLACED_TRACKING_CONTENT
      ),
      `${label}: ETP did not replace the resource`
    );
    is(
      await serverHits(url),
      0,
      `${label}: the blocked origin was never reached`
    );
  } finally {
    trace.stop();
  }
}

add_setup(async function setupNativeScheduling() {
  const originalInitialize = blocker._initializeEngineWithRetry;
  const originalEngine = blocker._engine?.serialize() || null;
  const originalResources = blocker._resourcePayload;
  let prefEnvironments = 0;
  blocker._initializeEngineWithRetry = async () => {};
  registerCleanupFunction(async () => {
    blocker._initializeEngineWithRetry = originalInitialize;
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
    while (prefEnvironments > 0) {
      await SpecialPowers.popPrefEnv();
      prefEnvironments--;
    }
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["waterfox.blocker.enabled", true],

      ["waterfox.blocker.allowSearchPartnerAds", false],
      ["waterfox.blocker.domainExceptions", "{}"],
      ["urlclassifier.enabled.mode", 1],
      ["privacy.trackingprotection.enabled", true],
      ["privacy.trackingprotection.defer_annotation.enabled", false],
      ["privacy.trackingprotection.content.testing", true],
      ["privacy.trackingprotection.content.protection.enabled", false],
      ["privacy.trackingprotection.content.annotation.enabled", false],
      ["privacy.trackingprotection.content.protection.engines", ""],
      ["privacy.trackingprotection.content.protection.engines.pbmode", ""],
      ["privacy.trackingprotection.content.annotation.engines", ""],
      ["privacy.trackingprotection.content.annotation.engines.pbmode", ""],
      ["privacy.trackingprotection.content.protection.test_list_urls", ""],
      ["privacy.trackingprotection.content.annotation.test_list_urls", ""],
    ],
  });
  prefEnvironments++;
  await blocker.init();
  resources = await (
    await fetch("resource://waterfox/blocker/assets/resources/resources.json")
  ).text();
  const engine = publishRules(["||unrelated.example^"]);
  await SpecialPowers.pushPrefEnv({
    set: [
      ["privacy.trackingprotection.content.protection.enabled", true],
      ["privacy.trackingprotection.content.protection.engines", "test_block"],
      [
        "privacy.trackingprotection.content.protection.test_list_urls",
        fixtureUrl("etp-list", "example.org"),
      ],
    ],
  });
  prefEnvironments++;
  const loaded = TestUtils.topicObserved(LISTS_LOADED_TOPIC);
  engine.classifierService.onListsChanged(["test_block"], []);
  await loaded;
});

add_task(async function test_etp_only_control() {
  publishRules(["||unrelated.example^"]);
  await BrowserTestUtils.withNewTab(PUBLISHER_URL, async browser => {
    await assertEtpWins(browser, fixtureUrl("script"), "ETP-only control");
  });
});

async function overlapCase(enabled, redirect) {
  await SpecialPowers.pushPrefEnv({
    set: [["waterfox.blocker.enabled", enabled]],
  });
  try {
    await BrowserTestUtils.withNewTab(PUBLISHER_URL, async browser => {
      const url = fixtureUrl("script");
      const engine = publishRules([scriptRule(url, redirect)]);
      // Channel-less content policy has no method; these cases reach HTTP scheduling.
      Assert.equal(
        JSON.parse(
          engine.checkRequestDetailed(
            url,
            "example.org",
            "example.com",
            "script",
            "",
            true
          )
        ).matched,
        false
      );
      const match = JSON.parse(
        engine.checkRequestDetailed(
          url,
          "example.org",
          "example.com",
          "script",
          "GET",
          true
        )
      );
      Assert.equal(
        match.matched,
        true,
        "The ad rule matches the same HTTP request"
      );
      Assert.equal(match.exception, "");
      if (redirect) {
        Assert.ok(
          match.redirect.startsWith("data:application/javascript;base64,"),
          "The ad redirect has a published resource"
        );
      }
      await assertEtpWins(
        browser,
        url,
        `${enabled ? "enabled native ads" : "disabled ads"} ETP + ad ${redirect ? "redirect" : "block"}`
      );
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_disabled_reenabled_ads_etp_plain_block() {
  await overlapCase(false, false);
  await overlapCase(true, false);
});

add_task(async function test_disabled_reenabled_ads_etp_resource_redirect() {
  await overlapCase(false, true);
  await overlapCase(true, true);
});

add_task(async function test_suspended_etp_ad_cancellation() {
  await BrowserTestUtils.withNewTab(PUBLISHER_URL, async browser => {
    const url = fixtureUrl("script");
    publishRules([scriptRule(url, true)]);
    await assertEtpWins(browser, url, "suspended ETP + ad redirect", true);
  });
});

add_task(async function test_first_party_ad_controls() {
  publishRules(["||unrelated.example^"]);
  await BrowserTestUtils.withNewTab(FIRST_PARTY_URL, async browser => {
    const browserId = browser.browsingContext.top.browserId;
    const control = fixtureUrl("script");
    Assert.deepEqual(
      await loadScript(browser, control),
      { outcome: "load", events: ["load"], executions: 1 },
      "ETP permits the first-party script control"
    );
    Assert.equal(await serverHits(control), 1);
    for (const redirect of [false, true]) {
      const label = `native: first-party ${redirect ? "resource replacement" : "blocking"} control`;
      const url = fixtureUrl("script");
      blocker.resetBlockedCount(browserId);
      publishRules([scriptRule(url, redirect)]);
      const channels = [];
      const observer = subject => {
        const channel = subject.QueryInterface(Ci.nsIHttpChannel);
        if (channel.URI.spec === url) {
          channels.push(channel);
        }
      };
      Services.obs.addObserver(observer, "http-on-opening-request");
      try {
        Assert.deepEqual(
          await loadScript(browser, url),
          {
            outcome: redirect ? "load" : "error",
            events: [redirect ? "load" : "error"],
            executions: 0,
          },
          label
        );
        Assert.equal(
          channels.length,
          1,
          `${label}: one original HTTP channel per load`
        );
        const [channel] = channels;
        Assert.equal(
          hasNativeChannelMark(channel, "waterfox.adblocking.appliedChannelId"),
          true,
          `${label}: native ad actions mark the original channel`
        );
        Assert.equal(
          hasNativeChannelMark(
            channel,
            "waterfox.adblocking.classifiedChannelId"
          ),
          true,
          `${label}: native classification marks the original channel`
        );
        Assert.equal(
          blocker.getBlockedCount(browserId),
          1,
          `${label}: each ad action is attributed once`
        );
        Assert.equal(
          await serverHits(url),
          0,
          `${label}: the original ad is never fetched`
        );
      } finally {
        Services.obs.removeObserver(observer, "http-on-opening-request");
      }
    }
  });
});

add_task(async function test_preflighted_query_rewrite_preserves_cors() {
  publishRules(["||unrelated.example^"]);
  await BrowserTestUtils.withNewTab(PUBLISHER_URL, async browser => {
    const rewrite = fixtureUrl("rewrite");
    const url = `${rewrite}&remove=tracking&keep=retained`;
    const denied = `${fixtureUrl("rewrite-denied")}&remove=tracking`;
    publishRules([
      `|${url}|$xmlhttprequest,removeparam=remove`,
      `|${denied}|$xmlhttprequest,removeparam=remove`,
    ]);
    const request = target =>
      SpecialPowers.spawn(browser, [target], async source => {
        try {
          const response = await content.fetch(source, {
            method: "POST",
            headers: { "X-Stage3-Header": "unsafe-header-control" },
            body: "preflight-body",
          });
          return { success: true, data: await response.json() };
        } catch (error) {
          return { success: false, name: error.name };
        }
      });
    const result = await request(url);
    Assert.equal(
      result.success,
      true,
      "A preflighted rewritten POST is delivered"
    );
    if (result.success) {
      Assert.equal(
        result.data.method,
        "POST",
        "Rewrite preserves the preflighted method"
      );
      Assert.equal(
        result.data.body,
        "preflight-body",
        "Rewrite preserves upload bytes"
      );
      Assert.equal(
        result.data.header,
        "unsafe-header-control",
        "The unsafe request header survives"
      );
      const params = new URLSearchParams(result.data.query);
      Assert.equal(
        params.has("remove"),
        false,
        "Only the targeted parameter is stripped"
      );
      Assert.equal(
        params.get("keep"),
        "retained",
        "Other query parameters are preserved"
      );
    }
    const hits = await serverHits(url);
    Assert.greater(
      hits.preflights,
      0,
      "The fixture observed an actual OPTIONS preflight"
    );
    Assert.equal(hits.posts, 1, "One cleaned POST reaches the origin");
    Assert.equal(
      (await request(denied)).success,
      false,
      "Rewrite does not bypass denied unsafe-header preflight"
    );
    const deniedHits = await serverHits(denied);
    Assert.greater(
      deniedHits.preflights,
      0,
      "The denied preflight reaches the origin"
    );
    Assert.equal(
      deniedHits.posts,
      0,
      "No actual request follows denied CORS preflight"
    );
  });
});

add_task(async function test_top_document_ad_control() {
  const url = fixtureUrl("document");
  publishRules([`|${url}|$document,method=GET,important`]);
  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const browser = tab.linkedBrowser;
  const browserId = browser.browsingContext.top.browserId;
  blocker.resetBlockedCount(browserId);
  try {
    const loaded = BrowserTestUtils.browserLoaded(browser, false, target =>
      target.startsWith("about:contentblocked")
    );
    BrowserTestUtils.startLoadingURIString(browser, url);
    await loaded;
    Assert.equal(
      new URL(browser.currentURI.spec).searchParams.get("url"),
      url,
      "Ad-only top documents retain the blocked-page redirect"
    );
    Assert.equal(
      blocker.wasHostBlockedFor(browserId, "example.com", url),
      true,
      "The native record retains blocked-document attribution across navigation"
    );
    Assert.equal(
      await serverHits(url),
      0,
      "The blocked document is not fetched"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
