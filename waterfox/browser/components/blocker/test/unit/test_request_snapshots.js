/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WaterfoxBlockerService: service } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const FLAGS = Ci.nsIWaterfoxBlockerRequest;
const ENABLED_PREF = "waterfox.blocker.enabled";
const PARTNERS_PREF = "waterfox.blocker.allowSearchPartnerAds";
const DOMAINS_PREF = "waterfox.blocker.domainExceptions";
const BROWSER_ID = 42;
let browser;

function createBrowser(browserId) {
  const window = Services.appShell.createWindowlessBrowser(false);
  const principal = Services.scriptSecurityManager.getSystemPrincipal();
  window.docShell.createAboutBlankDocumentViewer(principal, principal);
  window.docShell.browsingContext.browserId = browserId;
  return window;
}

function makeEngine(rules, resources = "[]") {
  const engine = Cc["@waterfox.com/waterfox-blocker-engine;1"].createInstance(
    Ci.nsIWaterfoxBlockerEngine
  );
  engine.initFromLists(rules);
  engine.useResources(resources);
  return engine;
}

function capture(engine, flags = FLAGS.ENABLED, method = "POST", until = 0) {
  return engine.captureRequest(
    "https://ads.example/ad.js",
    "publisher.example",
    "ads.example",
    "script",
    method,
    true,
    flags,
    BROWSER_ID,
    7,
    until
  );
}

function captureLoad(engine, channel, contentPolicy = false) {
  return engine.captureNativeLoad(
    channel.URI,
    channel.loadInfo,
    contentPolicy ? null : channel,
    contentPolicy ? engine.CACHED_LOAD : engine.REQUEST
  );
}

function captureCachedLoad(engine, uri, loadInfo) {
  return engine.captureNativeLoad(uri, loadInfo, null, engine.CACHED_LOAD);
}

function contentPolicyDecision(channel) {
  return Cc["@waterfox.com/waterfox-blocker-content-policy;1"]
    .getService(Ci.nsIContentPolicy)
    .shouldLoad(channel.URI, channel.loadInfo);
}

function modifyRequest(channel) {
  Services.obs.notifyObservers(channel, "http-on-modify-request");
}

function hasNativeMark(channel, name = "classifiedChannelId") {
  return channel
    .QueryInterface(Ci.nsIPropertyBag2)
    .hasKey(`waterfox.adblocking.${name}.hi`);
}

function nativeNumber(channel, name) {
  const properties = channel.QueryInterface(Ci.nsIPropertyBag2);
  return (
    properties.getPropertyAsUint32(`${name}.hi`) * 2 ** 32 +
    properties.getPropertyAsUint32(`${name}.lo`)
  );
}

function inheritNativeProperties(source, target) {
  const properties = source.QueryInterface(Ci.nsIPropertyBag).enumerator;
  const writable = target.QueryInterface(Ci.nsIWritablePropertyBag2);
  while (properties.hasMoreElements()) {
    const { name, value } = properties.getNext().QueryInterface(Ci.nsIProperty);
    if (!name.startsWith("waterfox.adblocking.")) {
      continue;
    }
    if (/\.(hi|lo)$/.test(name)) {
      writable.setPropertyAsUint32(name, value);
    } else if (typeof value === "boolean") {
      writable.setPropertyAsBool(name, value);
    } else {
      writable.setPropertyAsACString(name, value);
    }
  }
}

function makeChannel({
  url = "https://ads.example/ad.js",
  host = "publisher.example",
  isPrivate = false,
  type = Ci.nsIContentPolicy.TYPE_SCRIPT,
  method = "GET",
  browsingContext = browser.docShell.browsingContext,
} = {}) {
  const principal = Services.scriptSecurityManager.createContentPrincipal(
    Services.io.newURI(`https://${host}/`),
    { privateBrowsingId: isPrivate ? 1 : 0 }
  );
  const channel = NetUtil.newChannel({
    uri: url,
    loadingPrincipal: principal,
    triggeringPrincipal: principal,
    securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
    contentPolicyType: type,
  }).QueryInterface(Ci.nsIHttpChannel);
  channel.requestMethod = method;
  channel.loadInfo.associatedBrowsingContextID = browsingContext?.id || 0;
  return channel;
}

function context(options = {}) {
  return makeChannel(options).loadInfo;
}

async function withEngine(rules, task, resources = "[]") {
  const engine = makeEngine(rules, resources);
  Services.prefs.setBoolPref(ENABLED_PREF, true);
  service._publishEngine(engine, resources);
  service._rememberTopLevelHost(BROWSER_ID, "publisher.example");
  try {
    await task(engine);
  } finally {
    service._clearEngine();
    service._clearTopLevelNavigationState();
    Services.perms.removeByType("waterfox-blocker");
    Services.perms.removeByType("waterfox-blocker-pb");
    Services.perms.removeByType("trackingprotection");
    Services.prefs.setStringPref(DOMAINS_PREF, "{}");
    Services.prefs.setBoolPref(PARTNERS_PREF, true);
    Services.prefs.setBoolPref(ENABLED_PREF, false);
  }
}

add_setup(async function setup() {
  do_get_profile();
  Services.prefs.setBoolPref(ENABLED_PREF, false);
  const originalInitialize = service._initializeEngineWithRetry;
  const originalStartup = service._ensureStartupEngineSync;
  service._initializeEngineWithRetry = async () => {};
  service._ensureStartupEngineSync = () => {};
  browser = createBrowser(BROWSER_ID);
  await service.init();
  registerCleanupFunction(() => {
    service.uninit();
    service._initializeEngineWithRetry = originalInitialize;
    service._ensureStartupEngineSync = originalStartup;
    browser.close();
  });
});

add_task(async function test_owned_request_metadata_and_allowance_flags() {
  await withEngine(
    ["||ads.example^$script,method=POST,important"],
    async engine => {
      const request = capture(
        engine,
        FLAGS.ENABLED | FLAGS.PRIVATE | FLAGS.DOMAIN_ALLOWED
      );
      Assert.equal(request.browserId, BROWSER_ID);
      Assert.equal(request.navigationId, 7);
      Assert.equal(request.isPrivate, true);
      Assert.equal(request.engineGeneration, engine.publishedGeneration);
      Assert.equal(request.isCurrent, true);
      Assert.equal(request.canMatch, true);
      Assert.equal(
        request.canBlock,
        false,
        "Domain allowance overrides an important block"
      );
      Assert.equal(JSON.parse(request.checkRequestDetailed()).important, true);
      Assert.equal(
        JSON.parse(capture(engine, FLAGS.ENABLED, "GET").checkRequestDetailed())
          .matched,
        false
      );
      const bypassed = capture(engine, FLAGS.ENABLED | FLAGS.BYPASS);
      Assert.equal(bypassed.canMatch, false);
      Assert.equal(JSON.parse(bypassed.checkRequestDetailed()).matched, false);
      const disabled = capture(engine, 0);
      Assert.equal(disabled.canBlock, false);
      Assert.equal(JSON.parse(disabled.checkRequestDetailed()).matched, false);
    }
  );
});

add_task(
  async function test_native_normalization_preserves_full_hosts_and_copy() {
    await withEngine(
      [
        "||cdn.publisher.example^$script,domain=sub.publisher.example,method=POST,~third-party",
      ],
      async engine => {
        const channel = makeChannel({
          url: "https://cdn.publisher.example/ad.js?tracking=1",
          host: "sub.publisher.example",
          method: "POST",
        });
        channel.loadInfo.isInThirdPartyContext = false;
        const request = captureLoad(engine, channel);
        Assert.equal(request.url, channel.URI.spec);
        Assert.equal(request.hostname, "cdn.publisher.example");
        Assert.equal(request.sourceHostname, "sub.publisher.example");
        Assert.equal(request.requestType, "script");
        Assert.equal(request.requestMethod, "POST");
        Assert.equal(request.isThirdParty, false);
        Assert.equal(JSON.parse(request.checkRequestDetailed()).matched, true);
        Assert.deepEqual(
          JSON.parse(request.checkRequestDetailed()),
          JSON.parse(
            engine.checkRequestDetailed(
              channel.URI.spec,
              "sub.publisher.example",
              "cdn.publisher.example",
              "script",
              "POST",
              false
            )
          ),
          "Native normalization preserves the original ad matching inputs"
        );
        for (const method of ["GET", ""]) {
          Assert.equal(
            JSON.parse(
              engine.checkRequestDetailed(
                channel.URI.spec,
                "sub.publisher.example",
                "cdn.publisher.example",
                "script",
                method,
                false
              )
            ).matched,
            false,
            "The raw facade rejects other or absent methods for a POST rule"
          );
        }
        channel.requestMethod = "GET";
        channel.loadInfo.isInThirdPartyContext = true;
        Assert.equal(request.requestMethod, "POST");
        Assert.equal(request.isThirdParty, false);
        Assert.equal(JSON.parse(request.checkRequestDetailed()).matched, true);
        const changed = captureLoad(engine, channel);
        Assert.equal(changed.requestMethod, "GET");
        Assert.equal(changed.isThirdParty, true);
        Assert.equal(JSON.parse(changed.checkRequestDetailed()).matched, false);
        const cached = captureLoad(engine, channel, true);
        Assert.equal(cached.requestMethod, "");
        Assert.equal(JSON.parse(cached.checkRequestDetailed()).matched, false);
      }
    );
  }
);

add_task(async function test_native_content_policy_types_and_party_bits() {
  await withEngine(["||ads.example^"], async engine => {
    const types = [
      [Ci.nsIContentPolicy.TYPE_DOCUMENT, "document"],
      [Ci.nsIContentPolicy.TYPE_SUBDOCUMENT, "subdocument"],
      [Ci.nsIContentPolicy.TYPE_STYLESHEET, "stylesheet"],
      [Ci.nsIContentPolicy.TYPE_SCRIPT, "script"],
      [Ci.nsIContentPolicy.TYPE_IMAGE, "image"],
      [Ci.nsIContentPolicy.TYPE_IMAGESET, "image"],
      [Ci.nsIContentPolicy.TYPE_MEDIA, "media"],
      [Ci.nsIContentPolicy.TYPE_FONT, "font"],
      [Ci.nsIContentPolicy.TYPE_FETCH, "xmlhttprequest"],
      [Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST, "xmlhttprequest"],
      [Ci.nsIContentPolicy.TYPE_WEBSOCKET, "websocket"],
      [Ci.nsIContentPolicy.TYPE_PING, "ping"],
      [Ci.nsIContentPolicy.TYPE_BEACON, "ping"],
      [Ci.nsIContentPolicy.TYPE_CSP_REPORT, "csp_report"],
      [Ci.nsIContentPolicy.TYPE_OBJECT, "object"],
      [Ci.nsIContentPolicy.TYPE_OTHER, "other"],
      [Ci.nsIContentPolicy.TYPE_DTD, "other"],
    ];
    for (const [type, expected] of types) {
      const channel = makeChannel({ type });
      Assert.equal(captureLoad(engine, channel).requestType, expected);
      Assert.equal(captureLoad(engine, channel, true).requestType, expected);
    }
    const channel = makeChannel();
    channel.loadInfo.isInThirdPartyContext = false;
    Assert.equal(captureLoad(engine, channel).isThirdParty, true);
    for (const toTop of [false, true]) {
      for (const inContext of [false, true]) {
        channel.loadInfo.isThirdPartyContextToTopWindow = toTop;
        channel.loadInfo.isInThirdPartyContext = inContext;
        Assert.equal(
          captureLoad(engine, channel, true).isThirdParty,
          toTop || inContext,
          "Content policy retains its load-info party classification"
        );
      }
    }
  });
});

add_task(async function test_native_idn_ip_and_hostless_source_principals() {
  await withEngine(["||ads.example^"], async engine => {
    for (const host of [
      "ads.sub.example",
      "bücher.example",
      "127.0.0.1",
      "[::1]",
      "localhost",
    ]) {
      const channel = makeChannel({ url: `https://${host}/`, host });
      const request = captureLoad(engine, channel);
      Assert.equal(request.hostname, channel.URI.host);
      Assert.equal(
        request.sourceHostname,
        channel.loadInfo.loadingPrincipal.URI.host
      );
    }
    for (const principal of [
      Services.scriptSecurityManager.getSystemPrincipal(),
      Services.scriptSecurityManager.createNullPrincipal({}),
    ]) {
      const channel = NetUtil.newChannel({
        uri: "https://ads.example/ad.js",
        loadingPrincipal: principal,
        securityFlags:
          Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
        contentPolicyType: Ci.nsIContentPolicy.TYPE_SCRIPT,
      });
      const request = captureLoad(engine, channel);
      Assert.equal(request.sourceHostname, "");
      Assert.equal(request.hostname, "ads.example");
      Assert.equal(
        request.isThirdParty,
        Cc["@mozilla.org/thirdpartyutil;1"]
          .getService(Ci.mozIThirdPartyUtil)
          .isThirdPartyChannel(channel)
      );
    }
    const hostless = NetUtil.newChannel({
      uri: "data:text/plain,test",
      loadUsingSystemPrincipal: true,
    });
    const request = engine.captureLoad(
      hostless.URI,
      hostless.loadInfo,
      hostless,
      FLAGS.ENABLED,
      0,
      0,
      0
    );
    Assert.equal(request.hostname, "");
    Assert.equal(request.sourceHostname, "");
    Assert.equal(request.requestMethod, "");
    Assert.equal(
      request.isThirdParty,
      true,
      "Failed party lookup stays conservative"
    );
    Assert.equal(
      contentPolicyDecision(hostless),
      Ci.nsIContentPolicy.ACCEPT,
      "Native normalization does not expand interception beyond HTTP/HTTPS"
    );
    Assert.throws(
      () => engine.captureLoad(null, context(), null, FLAGS.ENABLED, 0, 0, 0),
      /NS_ERROR_ILLEGAL_VALUE/
    );
    Assert.throws(
      () =>
        engine.captureLoad(
          Services.io.newURI("https://ads.example/"),
          null,
          null,
          FLAGS.ENABLED,
          0,
          0,
          0
        ),
      /NS_ERROR_ILLEGAL_VALUE/
    );
    Assert.throws(
      () =>
        engine.captureLoad(
          Services.io.newURI("https://ads.example/"),
          context(),
          null,
          32,
          0,
          0,
          0
        ),
      /NS_ERROR_ILLEGAL_VALUE/
    );
  });
});

add_task(async function test_stale_policy_engine_and_expired_leases() {
  await withEngine(["||ads.example^"], async engine => {
    const request = capture(engine);
    engine.invalidatePolicy();
    Assert.equal(
      request.isCurrent,
      false,
      "Policy changes retire captured decisions"
    );
    Assert.equal(
      JSON.parse(request.checkRequestDetailed()).matched,
      true,
      "A detached snapshot remains queryable"
    );
    const current = capture(engine);
    const next = makeEngine(["@@||ads.example^"]);
    service._publishEngine(next, "[]");
    Assert.equal(
      current.isCurrent,
      false,
      "Engine updates retire captured decisions"
    );
    Assert.throws(() => capture(engine), /NS_ERROR_NOT_AVAILABLE/);
    Assert.equal(
      capture(next, FLAGS.ENABLED, "GET", 1).isCurrent,
      false,
      "Expired leases are rejected without a timer"
    );
  });
});

add_task(async function test_site_private_partner_and_etp_isolation() {
  await withEngine(["||ads.example^$important"], async engine => {
    const uri = Services.io.newURI("https://ads.example/ad.js");
    const normal = context();
    const before = captureCachedLoad(engine, uri, normal);
    const principal = normal.loadingPrincipal;
    Services.perms.addFromPrincipal(
      principal,
      "trackingprotection",
      Services.perms.ALLOW_ACTION
    );
    Assert.equal(
      before.isCurrent,
      true,
      "ETP allowances do not change ad policy"
    );
    Assert.equal(
      captureCachedLoad(engine, uri, normal).canBlock,
      true,
      "ETP allowances do not exempt ads"
    );
    service.allowSiteForSession("publisher.example");
    Assert.equal(before.isCurrent, false);
    Assert.equal(captureCachedLoad(engine, uri, normal).canMatch, false);
    Assert.equal(
      captureCachedLoad(engine, uri, context({ isPrivate: true })).canMatch,
      true
    );
    service.allowSiteForSession("publisher.example", { isPrivate: true });
    Assert.equal(
      captureCachedLoad(engine, uri, context({ isPrivate: true })).canMatch,
      false
    );
    const partner = context({ host: "news.qwant.com" });
    Assert.equal(captureCachedLoad(engine, uri, partner).canMatch, false);
    Services.prefs.setBoolPref(PARTNERS_PREF, false);
    Assert.equal(captureCachedLoad(engine, uri, partner).canMatch, true);
    const coexist = capture(engine);
    service.observe(null, "nsPref:changed", "waterfox.blocker.coexist");
    Assert.equal(
      coexist.isCurrent,
      false,
      "Extension coexistence changes invalidate pending work"
    );
  });
});

add_task(
  async function test_domain_allowance_preserves_removeparam_without_blocking() {
    await withEngine(
      [
        "||ads.example/block$important",
        "||ads.example^$script,removeparam=tracking",
      ],
      async engine => {
        service.addDomainExceptionForSite("publisher.example", "ads.example");
        const uri = Services.io.newURI(
          "https://ads.example/path?tracking=1&keep=2"
        );
        const channel = makeChannel({ url: uri.spec });
        const request = captureLoad(engine, channel);
        Assert.equal(request.canMatch, true);
        Assert.equal(request.canBlock, false);
        const result = JSON.parse(request.checkRequestDetailed());
        const baseline = JSON.parse(
          engine.checkRequestDetailed(
            uri.spec,
            "publisher.example",
            "ads.example",
            "script",
            "GET",
            true
          )
        );
        Assert.deepEqual(
          result,
          baseline,
          "Snapshots preserve legacy engine rewrite results"
        );
        Assert.equal(result.matched, false);
        Assert.equal(
          result.rewrittenUrl,
          "https://ads.example/path?keep=2",
          "Domain allowances retain non-blocking rewrites"
        );
      }
    );
  }
);

add_task(async function test_navigation_identity_and_single_bypass_discovery() {
  await withEngine(["||ads.example^"], async engine => {
    service.allowSiteForSession("publisher.example");
    const channel = makeChannel({
      url: "https://ads.example/",
      type: Ci.nsIContentPolicy.TYPE_DOCUMENT,
    });
    await nativeChannelCheck(engine, channel);
    const until = nativeNumber(
      channel,
      "waterfox.adblocking.classifiedChannelId.until"
    );
    Assert.greater(until, Date.now());
    engine.invalidatePolicy();
    modifyRequest(channel);
    Assert.equal(
      nativeNumber(channel, "waterfox.adblocking.classifiedChannelId.until"),
      until,
      "Stale native recapture does not renew the navigation bypass lease"
    );
    const request = captureLoad(engine, channel);
    const associatedContext = channel.loadInfo.associatedBrowsingContext;
    Assert.equal(
      request.navigationId,
      associatedContext.top.currentWindowGlobal.innerWindowId
    );
    Assert.greater(request.navigationId, 0);
    Assert.equal(request.isCurrentForLoad(channel.loadInfo, channel), true);
    Assert.equal(
      captureLoad(engine, channel, true).canMatch,
      false,
      "Content policy keeps top-level blocked-page handling in the observer"
    );
    Assert.equal(request.isCurrent, true);
    const principal = Services.scriptSecurityManager.getSystemPrincipal();
    browser.docShell.createAboutBlankDocumentViewer(principal, principal);
    Assert.equal(
      channel.loadInfo.associatedBrowsingContext.id,
      associatedContext.id
    );
    Assert.notEqual(
      associatedContext.top.currentWindowGlobal.innerWindowId,
      request.navigationId,
      "Document replacement changes the inner window within the same context"
    );
    Assert.equal(
      request.isCurrent,
      true,
      "Document replacement leaves policy current"
    );
    Assert.equal(
      request.isCurrentForLoad(channel.loadInfo, channel),
      false,
      "The captured document lifetime ends independently of policy invalidation"
    );
  });
});

add_task(async function test_stale_network_decisions_never_cancel_or_count() {
  await withEngine(["||ads.example^"], async engine => {
    const originalCount = service.incrementBlockedCount;
    const applied = [];
    service.incrementBlockedCount = (...args) => applied.push(args);
    try {
      const channel = makeChannel();
      const request = captureLoad(engine, channel);
      const stale = asyncResult(request);
      const pending = nativeChannelCheck(engine, channel);
      service.allowSiteForSession("publisher.example");
      Assert.equal((await stale).status, Cr.NS_ERROR_ABORT);
      await pending;
      Assert.equal(channel.status, Cr.NS_OK);
      Assert.deepEqual(
        applied,
        [],
        "Recaptured allowed loads do not count stale blocks"
      );
    } finally {
      service.incrementBlockedCount = originalCount;
    }
  });
});

add_task(async function test_native_channel_and_cached_load_actions() {
  await withEngine(
    [
      "||ads.example/method.js$script,method=POST,important",
      "||ads.example/general.js$script,important",
    ],
    async engine => {
      const originalCount = service.incrementBlockedCount;
      const applied = [];
      service.incrementBlockedCount = (browserId, details) => {
        applied.push({ browserId, ...details });
      };
      try {
        const channel = makeChannel({
          url: "https://ads.example/method.js",
          method: "POST",
          isPrivate: true,
        });
        Assert.equal(
          contentPolicyDecision(channel),
          Ci.nsIContentPolicy.ACCEPT,
          "A method-specific rule cannot reject a methodless cached load"
        );
        Assert.equal(applied.length, 0);
        await nativeChannelCheck(engine, channel);
        Assert.equal(channel.status, Cr.NS_ERROR_ABORT);
        Assert.deepEqual(applied, [
          {
            browserId: BROWSER_ID,
            hostname: "ads.example",
            requestType: "script",
            isPrivate: true,
            topLevel: false,
          },
        ]);
        const cached = makeChannel({ url: "https://ads.example/general.js" });
        Assert.equal(
          contentPolicyDecision(cached),
          Ci.nsIContentPolicy.REJECT_TYPE
        );
        Assert.equal(applied.length, 2);
        service.addDomainExceptionForSite("publisher.example", "ads.example");
        Assert.equal(
          contentPolicyDecision(cached),
          Ci.nsIContentPolicy.ACCEPT,
          "Domain allowances override important cache-path matches"
        );
        Assert.equal(
          applied.length,
          2,
          "Allowed requests do not add statistics"
        );
      } finally {
        service.incrementBlockedCount = originalCount;
      }
    }
  );
});

add_task(async function test_native_host_policy_matches_permission_api() {
  await withEngine(["||ads.example^$important"], async engine => {
    Services.prefs.setBoolPref(PARTNERS_PREF, false);
    service.addSiteException("publisher.example");
    service.allowSiteForSession("private.example", { isPrivate: true });
    for (const host of [
      "publisher.example",
      "sub.publisher.example",
      "PUBLISHER.EXAMPLE",
      " publisher.example ",
      " publisher.example. ",
      "\u00a0publisher.example\u3000",
      "\ufeffpublisher.example.\u202f",
      "\bpublisher.example",
      "publisher.example.",
      "private.example",
      "sub.private.example",
      "other.example",
      "localhost",
      "127.0.0.1",
      "[::1]",
      "",
    ]) {
      for (const isPrivate of [false, true]) {
        Assert.equal(
          engine.shouldBypassHost(host, isPrivate),
          service.isSiteExcepted(host, { isPrivate }),
          `Native permission parity for ${host}, private=${isPrivate}`
        );
      }
    }
    service.addSiteException("sub.only.example");
    Assert.equal(engine.shouldBypassHost("only.example", false), false);
    Assert.equal(
      engine.shouldBypassHost("child.sub.only.example", false),
      true
    );
    Services.prefs.setBoolPref(PARTNERS_PREF, true);
    for (const host of [
      "qwant.com",
      "news.qwant.com",
      "search.waterfox.com",
      "ads.search.waterfox.com",
      "qwant.com.",
    ]) {
      Assert.equal(engine.shouldBypassHost(host, false), true);
      Assert.equal(engine.shouldBypassHost(host, true), true);
    }
    for (const host of [
      "fakeqwant.com",
      "qwant.com.evil.example",
      "waterfox.com",
      "QWANT.COM",
    ]) {
      Assert.equal(engine.shouldBypassHost(host, false), false);
    }
    const channel = makeChannel({ host: "other.example" });
    Assert.throws(
      () =>
        engine.capturePolicyLoad(
          channel.URI,
          channel.loadInfo,
          channel,
          FLAGS.ENABLED,
          [],
          [],
          0,
          0,
          0
        ),
      /NS_ERROR_(INVALID_ARG|ILLEGAL_VALUE)/,
      "Callers cannot supply resolved native enablement"
    );
    const enabled = captureLoad(engine, channel);
    Assert.equal(enabled.canMatch, true);
    Services.prefs.setBoolPref(ENABLED_PREF, false);
    Assert.equal(enabled.isCurrent, false);
    Assert.equal(contentPolicyDecision(channel), Ci.nsIContentPolicy.ACCEPT);
    const disabledEngine = makeEngine(["||ads.example^"]);
    disabledEngine.publish();
    try {
      Assert.equal(
        disabledEngine.capturePolicyLoad(
          channel.URI,
          channel.loadInfo,
          channel,
          0,
          [],
          [],
          0,
          0,
          0
        ).canMatch,
        false
      );
    } finally {
      disabledEngine.unpublish();
    }
  });
});

add_task(async function test_native_domain_policy_base_domain_and_site_scope() {
  await withEngine(["||ads.example^$important"], async engine => {
    const channel = makeChannel({ url: "https://cdn.ads.example/ad.js" });
    service.addDomainExceptionForSite("publisher.example", "ads.example");
    const request = captureLoad(engine, channel);
    Assert.equal(request.canMatch, true);
    Assert.equal(request.canBlock, false);
    Assert.equal(JSON.parse(request.checkRequestDetailed()).important, true);
    service._rememberTopLevelHost(BROWSER_ID, "different.example");
    Assert.equal(request.isCurrent, false);
    Assert.equal(captureLoad(engine, channel).canBlock, true);
    for (const host of [
      "127.0.0.1",
      "localhost",
      "[::1]",
      "cdn.ads.example.",
    ]) {
      const load = makeChannel({ url: `https://${host}/ad.js` });
      const allowed = service._baseDomain(load.URI.host);
      const captured = engine.capturePolicyLoad(
        load.URI,
        load.loadInfo,
        load,
        0,
        [],
        [allowed],
        0,
        0,
        0
      );
      Assert.equal(
        captured.canBlock,
        false,
        `Native domain fallback parity for ${host}`
      );
    }
  });
});

function asyncResult(request) {
  let returned = false;
  let calls = 0;
  const promise = new Promise(resolve => {
    request.checkRequestDetailedAsync((status, json) => {
      Assert.equal(returned, true, "Callback is asynchronous");
      Assert.equal(++calls, 1, "Callback delivered once");
      resolve({ status, json });
    });
    returned = true;
  });
  return promise;
}

add_task(async function test_shared_async_classification_and_stale_delivery() {
  await withEngine(
    ["||ads.example^$script,method=POST,important"],
    async engine => {
      const request = capture(engine);
      const result = await asyncResult(request);
      Assert.equal(result.status, Cr.NS_OK);
      Assert.deepEqual(
        JSON.parse(result.json),
        JSON.parse(request.checkRequestDetailed())
      );
      Assert.equal(JSON.parse(result.json).important, true);
      for (const invalidate of [
        () => engine.invalidatePolicy(),
        () => Services.prefs.setBoolPref(PARTNERS_PREF, false),
        () => service.allowSiteForSession("publisher.example"),
        () =>
          service.addDomainExceptionForSite("publisher.example", "ads.example"),
        () => service._publishEngine(makeEngine(["||ads.example^"]), "[]"),
        () => Services.prefs.setBoolPref(ENABLED_PREF, false),
      ]) {
        const pending = capture(service._engine);
        const completion = asyncResult(pending);
        invalidate();
        const stale = await completion;
        Assert.equal(stale.status, Cr.NS_ERROR_ABORT);
        Assert.equal(
          stale.json,
          "",
          "Stale callbacks expose no actionable result"
        );
        Assert.equal(
          JSON.parse(pending.checkRequestDetailed()).matched,
          true,
          "Detached snapshot remains queryable after invalidation"
        );
      }
      Services.prefs.setBoolPref(ENABLED_PREF, true);
      service._publishEngine(makeEngine(["||ads.example^"]), "[]");
      const expired = capture(service._engine, FLAGS.ENABLED, "POST", 1);
      const resultExpired = await asyncResult(expired);
      Assert.equal(resultExpired.status, Cr.NS_ERROR_ABORT);
      Assert.equal(resultExpired.json, "");
      const bypassed = capture(service._engine, FLAGS.ENABLED | FLAGS.BYPASS);
      Assert.equal(
        JSON.parse((await asyncResult(bypassed)).json).matched,
        false
      );
    }
  );
});

add_task(async function test_async_action_revalidation_and_statistics() {
  const rules = ["||ads.example^$script,method=GET,important"];
  await withEngine(rules, async engine => {
    const originalCount = service.incrementBlockedCount;
    let count = 0;
    service.incrementBlockedCount = () => count++;
    try {
      const channel = makeChannel();
      const request = captureLoad(engine, channel);
      const result = await asyncResult(request);
      Assert.equal(JSON.parse(result.json).matched, true);
      await nativeChannelCheck(engine, channel);
      Assert.equal(channel.status, Cr.NS_ERROR_ABORT);
      Assert.equal(count, 1);
      await nativeChannelCheck(engine, channel);
      modifyRequest(channel);
      Assert.equal(count, 1, "Cancelled channels cannot apply or count twice");
      for (const change of [
        load => {
          load.requestMethod = "POST";
        },
        load => {
          load.cancel(Cr.NS_ERROR_ABORT);
        },
      ]) {
        const load = makeChannel();
        const captured = captureLoad(engine, load);
        Assert.equal(JSON.parse(captured.checkRequestDetailed()).matched, true);
        const pending = nativeChannelCheck(engine, load);
        change(load);
        const status = load.status;
        await pending;
        Assert.equal(
          load.status,
          status,
          "Stale methods or cancellation suppress native actions"
        );
        Assert.equal(count, 1, "Suppressed actions cannot inflate statistics");
      }
      for (const change of [
        () => engine.invalidatePolicy(),
        () => service._publishEngine(makeEngine(rules), "[]"),
      ]) {
        const load = makeChannel();
        const captured = captureLoad(service._engine, load);
        const stale = asyncResult(captured);
        const pending = nativeChannelCheck(service._engine, load);
        change();
        Assert.equal((await stale).status, Cr.NS_ERROR_ABORT);
        await pending;
        Assert.equal(
          load.status,
          Cr.NS_ERROR_ABORT,
          "Native actions recover stale generations using current matching"
        );
      }
      Assert.equal(count, 3, "Each recovered block counts exactly once");
    } finally {
      service.incrementBlockedCount = originalCount;
    }
  });
});

add_task(async function test_async_redirect_and_rewrite_actions() {
  const resources = await IOUtils.readUTF8(
    PathUtils.join(
      Services.env.get("MOZ_DEVELOPER_REPO_DIR"),
      "waterfox",
      "browser",
      "components",
      "blocker",
      "assets",
      "resources",
      "resources.json"
    )
  );
  await withEngine(
    [
      "||ads.example/redirect$script,redirect=noop.js",
      "||ads.example/rewrite$script,removeparam=tracking",
    ],
    async engine => {
      const originalCount = service.incrementBlockedCount;
      let count = 0;
      service.incrementBlockedCount = () => count++;
      try {
        const channel = makeChannel({ url: "https://ads.example/redirect" });
        const request = captureLoad(engine, channel);
        const result = await asyncResult(request);
        Assert.equal(result.status, Cr.NS_OK);
        const match = JSON.parse(result.json);
        Assert.equal(match.matched, true);
        Assert.ok(
          match.redirect.startsWith("data:application/javascript;base64,")
        );
        await nativeChannelCheck(engine, channel);
        Assert.equal(
          count,
          0,
          "Deferred redirects are not counted before application"
        );
        const properties = channel.QueryInterface(Ci.nsIPropertyBag2);
        Assert.equal(
          properties.getPropertyAsACString(
            "waterfox.adblocking.pendingRedirect"
          ),
          match.redirect
        );
        modifyRequest(channel);
        Assert.equal(channel.status, Cr.NS_OK);
        Assert.equal(channel.loadInfo.allowInsecureRedirectToDataURI, true);
        Assert.equal(hasNativeMark(channel, "appliedChannelId"), true);
        Assert.equal(count, 1, "Applied resource redirects count as blocks");
        engine.invalidatePolicy();
        modifyRequest(channel);
        Assert.equal(
          count,
          1,
          "Applied redirects cannot count twice after invalidation"
        );
        service.addDomainExceptionForSite("publisher.example", "ads.example");
        const rewriteChannel = makeChannel({
          url: "https://ads.example/rewrite?tracking=1&keep=2",
        });
        const rewriteRequest = captureLoad(engine, rewriteChannel);
        Assert.equal(rewriteRequest.canBlock, false);
        const rewrite = await asyncResult(rewriteRequest);
        Assert.equal(rewrite.status, Cr.NS_OK);
        Assert.equal(
          JSON.parse(rewrite.json).rewrittenUrl,
          "https://ads.example/rewrite?keep=2"
        );
        await nativeChannelCheck(engine, rewriteChannel);
        const rewrittenProperties = rewriteChannel.QueryInterface(
          Ci.nsIPropertyBag2
        );
        Assert.equal(
          rewrittenProperties.getPropertyAsACString(
            "waterfox.adblocking.pendingRewrite"
          ),
          "https://ads.example/rewrite?keep=2"
        );
        engine.invalidatePolicy();
        modifyRequest(rewriteChannel);
        Assert.equal(hasNativeMark(rewriteChannel, "appliedChannelId"), true);
        Assert.equal(
          count,
          1,
          "Native non-blocking rewrites do not count as blocks"
        );
        modifyRequest(rewriteChannel);
        Assert.equal(count, 1);
        const original = makeChannel({
          url: "https://ads.example/rewrite?tracking=1&keep=2",
        });
        await nativeChannelCheck(engine, original);
        const changed = makeChannel({ url: "https://ads.example/changed" });
        inheritNativeProperties(original, changed);
        modifyRequest(changed);
        Assert.equal(hasNativeMark(changed, "appliedChannelId"), false);
        Assert.equal(
          changed
            .QueryInterface(Ci.nsIPropertyBag2)
            .hasKey("waterfox.adblocking.pendingRewrite"),
          false
        );
        Assert.equal(count, 1, "Changed URLs do not apply earlier rewrites");
      } finally {
        service.incrementBlockedCount = originalCount;
      }
    },
    resources
  );
});

function nativeChannelCheck(engine, channel) {
  let calls = 0;
  return new Promise(resolve =>
    engine.checkChannel(channel, status => {
      Assert.equal(++calls, 1, "Native channel callbacks complete once");
      Assert.equal(status, Cr.NS_OK);
      resolve();
    })
  );
}

add_task(async function test_native_context_capture_and_action_recovery() {
  await withEngine(
    ["||ads.example^$script,method=POST,important"],
    async engine => {
      const channel = makeChannel({
        method: "POST",
        isPrivate: true,
        browsingContext: null,
      });
      const request = engine.captureNativeLoad(
        channel.URI,
        channel.loadInfo,
        channel,
        engine.REQUEST
      );
      Assert.equal(request.isPrivate, true);
      Assert.equal(
        request.browserId,
        0,
        "Channel-less tab contexts preserve zero browser attribution"
      );
      Assert.equal(request.navigationId, 0);
      Assert.equal(request.canMatch, true);
      Assert.equal(request.isCurrentForLoad(channel.loadInfo, channel), true);
      Assert.equal(JSON.parse(request.checkRequestDetailed()).important, true);
      channel.requestMethod = "GET";
      Assert.equal(request.isCurrentForLoad(channel.loadInfo, channel), false);
      const pending = nativeChannelCheck(engine, channel);
      channel.requestMethod = "POST";
      engine.invalidatePolicy();
      await pending;
      Assert.equal(
        channel.status,
        Cr.NS_ERROR_ABORT,
        "Stale methods/policies are recaptured before native cancellation"
      );
      const properties = channel.QueryInterface(Ci.nsIPropertyBag2).enumerator;
      let nativeProperties = 0;
      while (properties.hasMoreElements()) {
        const property = properties.getNext().QueryInterface(Ci.nsIProperty);
        if (property.name.startsWith("waterfox.adblocking.")) {
          Assert.ok(
            typeof property.value === "string" ||
              (/\.(hi|lo)$/.test(property.name) &&
                Number.isInteger(property.value) &&
                property.value >= 0 &&
                property.value <= 0xffffffff),
            "Numeric channel markers are exact uint32 pairs"
          );
          nativeProperties++;
        }
      }
      Assert.greater(nativeProperties, 0);
      const cancelled = makeChannel({ method: "POST" });
      cancelled.cancel(Cr.NS_ERROR_ABORT);
      let cancelledCallbacks = 0;
      engine.checkChannel(cancelled, status => {
        Assert.equal(status, Cr.NS_OK);
        cancelledCallbacks++;
      });
      Assert.equal(
        cancelledCallbacks,
        1,
        "Cancelled checks complete without dispatch"
      );
      Assert.equal(cancelled.status, Cr.NS_ERROR_ABORT);
      const content = engine.captureNativeLoad(
        Services.io.newURI("https://ads.example/"),
        context({ type: Ci.nsIContentPolicy.TYPE_DOCUMENT }),
        null,
        engine.CACHED_LOAD
      );
      Assert.equal(
        content.canMatch,
        false,
        "Native cache policy accepts top documents for blocked-page redirects"
      );
      service.allowSiteForSession("publisher.example", { isPrivate: true });
      const allowed = makeChannel({ isPrivate: true, method: "POST" });
      Assert.equal(
        engine.captureNativeLoad(
          allowed.URI,
          allowed.loadInfo,
          allowed,
          engine.REQUEST
        ).canMatch,
        false
      );
      await nativeChannelCheck(engine, allowed);
      Assert.equal(allowed.status, Cr.NS_OK);
    }
  );
});

add_task(async function test_native_pending_publication_and_unpublish() {
  await withEngine(["||unrelated.example^"], async engine => {
    const channel = makeChannel();
    const pending = nativeChannelCheck(engine, channel);
    const replacement = makeEngine(["||ads.example^$important"]);
    service._publishEngine(replacement, "[]");
    await pending;
    Assert.equal(
      channel.status,
      Cr.NS_ERROR_ABORT,
      "A newly published engine is consulted after stale matching"
    );
    const windows = [createBrowser(BROWSER_ID), createBrowser(BROWSER_ID)];
    const originalCount = service.incrementBlockedCount;
    let actions = 0;
    service.incrementBlockedCount = () => actions++;
    try {
      for (const window of windows) {
        Assert.ok(window.docShell.docViewer.DOMDocument.defaultView);
        window.docShell.browsingContext.browserId = BROWSER_ID;
      }
      const contexts = windows.map(window => window.docShell.browsingContext);
      for (const targetBrowserId of [BROWSER_ID, BROWSER_ID + 1]) {
        contexts[1].browserId = targetBrowserId;
        const moved = makeChannel();
        moved.loadInfo.associatedBrowsingContextID = contexts[0].id;
        const captured = replacement.captureNativeLoad(
          moved.URI,
          moved.loadInfo,
          moved,
          replacement.REQUEST
        );
        Assert.greater(captured.navigationId, 0);
        Assert.equal(captured.isCurrentForLoad(moved.loadInfo, moved), true);
        const completion = nativeChannelCheck(replacement, moved);
        moved.loadInfo.associatedBrowsingContextID = contexts[1].id;
        Assert.equal(captured.isCurrentForLoad(moved.loadInfo, moved), false);
        await completion;
        Assert.equal(
          moved.status,
          Cr.NS_BINDING_ABORTED,
          "Pending work cannot be recaptured under another document/browser"
        );
        modifyRequest(moved);
        Assert.equal(actions, 0, "Ownership cancellation is not an ad action");
        Assert.equal(
          moved
            .QueryInterface(Ci.nsIPropertyBag2)
            .hasKey("waterfox.adblocking.classifiedChannelId.hi"),
          false
        );
      }
    } finally {
      service.incrementBlockedCount = originalCount;
      windows.forEach(window => window.close());
    }
    const retired = makeChannel();
    const retiring = nativeChannelCheck(replacement, retired);
    service._clearEngine();
    await retiring;
    Assert.equal(
      retired.status,
      Cr.NS_OK,
      "Retirement completes pending channel work without applying an obsolete action"
    );
  });
});

add_task(async function test_native_disable_reenable_pending_channel() {
  const rules = ["||ads.example^$script,method=POST,important"];
  await withEngine(rules, async engine => {
    const channel = makeChannel({ method: "POST" });
    const pending = nativeChannelCheck(engine, channel);
    Services.prefs.setBoolPref(ENABLED_PREF, false);
    await pending;
    Assert.equal(
      channel.status,
      Cr.NS_OK,
      "Disabling the blocker suppresses an in-flight native action"
    );
    Assert.equal(engine.ownsNetworkChannel(channel), false);
    Services.prefs.setBoolPref(ENABLED_PREF, true);
    const replacement = makeEngine(rules);
    service._publishEngine(replacement, "[]");
    await nativeChannelCheck(replacement, channel);
    Assert.equal(
      channel.status,
      Cr.NS_ERROR_ABORT,
      "Re-enabling the blocker enforces current native policy"
    );
  });
});

add_task(async function test_native_disable_reenable_deferred_resource() {
  const resources = await IOUtils.readUTF8(
    PathUtils.join(
      Services.env.get("MOZ_DEVELOPER_REPO_DIR"),
      "waterfox",
      "browser",
      "components",
      "blocker",
      "assets",
      "resources",
      "resources.json"
    )
  );
  await withEngine(
    ["||ads.example^$script,redirect=noop.js"],
    async engine => {
      const channel = makeChannel();
      await nativeChannelCheck(engine, channel);
      Assert.equal(channel.status, Cr.NS_OK);
      Assert.equal(
        channel
          .QueryInterface(Ci.nsIPropertyBag2)
          .getPropertyAsBool("waterfox.adblocking.pendingBlock"),
        true
      );
      const originalCount = service.incrementBlockedCount;
      let counted = 0;
      service.incrementBlockedCount = () => counted++;
      try {
        Services.prefs.setBoolPref(ENABLED_PREF, false);
        modifyRequest(channel);
        Assert.equal(channel.loadInfo.allowInsecureRedirectToDataURI, false);
        Assert.equal(hasNativeMark(channel, "appliedChannelId"), false);
        Assert.equal(counted, 0, "Disable cannot count a deferred resource");
        Services.prefs.setBoolPref(ENABLED_PREF, true);
        const replacement = makeEngine(["@@||ads.example^"], resources);
        service._publishEngine(replacement, resources);
        modifyRequest(channel);
        Assert.equal(hasNativeMark(channel, "appliedChannelId"), false);
        Assert.equal(
          channel
            .QueryInterface(Ci.nsIPropertyBag2)
            .hasKey("waterfox.adblocking.pendingBlock"),
          false,
          "Re-enable discards obsolete deferred redirects"
        );
        Assert.equal(counted, 0);
        service._publishEngine(
          makeEngine(["||ads.example^$script,redirect=noop.js"], resources),
          resources
        );
        const current = makeChannel();
        await nativeChannelCheck(service._engine, current);
        modifyRequest(current);
        Assert.equal(current.loadInfo.allowInsecureRedirectToDataURI, true);
        Assert.equal(counted, 1, "Only the current resource action is counted");
      } finally {
        service.incrementBlockedCount = originalCount;
      }
    },
    resources
  );
});
