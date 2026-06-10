/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WaterfoxBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);
const { WaterfoxBlockerParent } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerParent.sys.mjs"
);
const { WaterfoxBlockerChild } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerChild.sys.mjs"
);

const BLOCKER_ENABLED_PREF = "waterfox.blocker.enabled";
const EARLY_SCRIPTLET_DIAGNOSTICS_PREF =
  "waterfox.blocker.earlyScriptletInjection.diagnostics";
const EARLY_SCRIPTLET_PARSER_BLOCK_TIMEOUT_PREF =
  "waterfox.blocker.earlyScriptletInjection.parserBlockTimeoutMs";
const EARLY_SCRIPTLET_TEST_PARSER_BLOCK_TIMEOUT_MS = 10000;
const TEST_URL =
  "https://example.com/browser/waterfox/browser/components/blocker/test/browser/file_early_scriptlet_injection.html";
const SCRIPTLET = 'globalThis.__wfProbe = "scriptlet-ran-first";';

let originalGetCosmeticResources;
let originalInitializeEngineWithRetry;
let originalWhenEngineReady;
let engineReadyDelayMs = 0;
let nativeScriptletResources;

function urlFor(testCase) {
  return `${TEST_URL}?case=${testCase}&nonce=${Date.now()}-${Math.random()}`;
}

function resourcesForCase(testCase) {
  switch (testCase) {
    case "ordering":
      return {
        ...nativeScriptletResources,
        injected_script: nativeScriptletResources.injected_script + SCRIPTLET,
      };
    case "regression":
      return {
        generichide: true,
        hide_selectors: ["#hide-target"],
        injected_script: SCRIPTLET,
        procedural_actions: [
          {
            selector: [
              { type: "css-selector", arg: "#procedural-target > span" },
              { type: "has-text", arg: "procedural target" },
              { type: "upward", arg: "1" },
            ],
          },
        ],
      };
    case "noscriptlet":
      return {
        generichide: true,
      };
    case "timeout":
      return {
        generichide: true,
        injected_script: SCRIPTLET,
      };
    default:
      return null;
  }
}

async function openProbePage(testCase) {
  return BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: urlFor(testCase),
    waitForLoad: true,
  });
}

async function readProbeState(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    const win = content.wrappedJSObject;
    const hideTarget = content.document.getElementById("hide-target");
    const proceduralTarget =
      content.document.getElementById("procedural-target");
    return {
      diagnostics: win.__waterfoxBlockerEarlyScriptletDiagnostics || null,
      hiddenDisplay: content.getComputedStyle(hideTarget).display,
      probe: win.__wfProbe,
      proceduralDisplay: content.getComputedStyle(proceduralTarget).display,
      readyState: content.document.readyState,
      seen: win.__wfProbeSeenByFirstScript,
      request: JSON.parse(win.__wfSerializedRequest),
      response: await win.__wfPlayerResponse,
    };
  });
}

async function withDiagnostics(task, extraPrefs = []) {
  await SpecialPowers.pushPrefEnv({
    set: [
      [BLOCKER_ENABLED_PREF, true],
      [EARLY_SCRIPTLET_DIAGNOSTICS_PREF, true],
      ...extraPrefs,
    ],
  });
  try {
    await task();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

function earlyScriptletTimeoutPref() {
  return [
    EARLY_SCRIPTLET_PARSER_BLOCK_TIMEOUT_PREF,
    EARLY_SCRIPTLET_TEST_PARSER_BLOCK_TIMEOUT_MS,
  ];
}

add_setup(async function setup() {
  originalGetCosmeticResources = WaterfoxBlockerService.getCosmeticResources;
  originalInitializeEngineWithRetry =
    WaterfoxBlockerService._initializeEngineWithRetry;
  originalWhenEngineReady = WaterfoxBlockerService.whenEngineReady;
  const engine = Cc["@waterfox.com/waterfox-blocker-engine;1"].createInstance(
    Ci.nsIWaterfoxBlockerEngine
  );
  engine.initFromLists([
    "example.com##+js(json-prune-fetch-response, adPlacements adSlots, , propsToMatch, case=player)\n" +
      'example.com##+js(trusted-edit-inbound-object, JSON.stringify, 0, [?.attestationRequest][?.context.client.userAgent*="channel"].context.client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"})',
  ]);
  engine.useResources(
    await (
      await fetch(
        "resource://waterfox/blocker/assets/resources/ubo-scriptlets.json"
      )
    ).text()
  );
  nativeScriptletResources = JSON.parse(engine.getCosmeticResources(TEST_URL));

  WaterfoxBlockerService._initializeEngineWithRetry = async function () {};
  WaterfoxBlockerService.getCosmeticResources = function (url) {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("file_early_scriptlet_injection.html")) {
      return null;
    }
    return resourcesForCase(parsed.searchParams.get("case"));
  };

  WaterfoxBlockerService.whenEngineReady = async function () {
    if (!engineReadyDelayMs) {
      return;
    }
    // eslint-disable-next-line mozilla/no-arbitrary-setTimeout
    await new Promise(resolve => setTimeout(resolve, engineReadyDelayMs));
  };

  registerCleanupFunction(() => {
    WaterfoxBlockerService.getCosmeticResources = originalGetCosmeticResources;
    WaterfoxBlockerService._initializeEngineWithRetry =
      originalInitializeEngineWithRetry;
    WaterfoxBlockerService.whenEngineReady = originalWhenEngineReady;
    engineReadyDelayMs = 0;
  });
});

add_task(async function test_scriptlet_wins_ordering() {
  await withDiagnostics(async () => {
    const tab = await openProbePage("ordering");
    try {
      const state = await readProbeState(tab.linkedBrowser);
      Assert.equal(
        state.seen,
        "scriptlet-ran-first",
        "The scriptlet should run before the first inline head script"
      );
      Assert.equal(
        state.diagnostics?.path,
        "early-inject",
        "Diagnostics should record the early injection path"
      );
      Assert.equal(
        state.request.context.client.clientScreen,
        "CHANNEL",
        "The real YouTube request scriptlet modifies the first inline request"
      );
      Assert.deepEqual(
        state.response,
        { video: "content" },
        "The real response scriptlet removes ad fields and retains content"
      );
    } finally {
      await BrowserTestUtils.removeTab(tab);
    }
  });
});

add_task(async function test_cosmetic_and_procedural_paths_still_apply() {
  await withDiagnostics(async () => {
    const tab = await openProbePage("regression");
    try {
      await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
        await ContentTaskUtils.waitForCondition(() => {
          const hidden = content.document.getElementById("hide-target");
          const procedural =
            content.document.getElementById("procedural-target");
          return (
            content.getComputedStyle(hidden).display === "none" &&
            content.getComputedStyle(procedural).display === "none"
          );
        }, "Waiting for cosmetic and procedural hiding");
      });

      const state = await readProbeState(tab.linkedBrowser);
      Assert.equal(
        state.hiddenDisplay,
        "none",
        "Cosmetic hide selectors should still apply"
      );
      Assert.equal(
        state.proceduralDisplay,
        "none",
        "Procedural actions should still apply"
      );
    } finally {
      await BrowserTestUtils.removeTab(tab);
    }
  }, [earlyScriptletTimeoutPref()]);
});

add_task(async function test_timeout_unblocks_parser_and_falls_back_late() {
  const page = Services.appShell.createWindowlessBrowser(false);
  const principal = Services.scriptSecurityManager.getSystemPrincipal();
  page.docShell.createAboutBlankDocumentViewer(principal, principal);
  const pageWindow = page.docShell.domWindow;
  const actor = {
    document: pageWindow.document,
    contentWindow: pageWindow,
    _getDocumentURI: doc => doc.documentURI,
  };
  try {
    const inject = WaterfoxBlockerChild.prototype._injectScriptlet;
    Assert.equal(
      await inject.call(actor, ")"),
      false,
      "Invalid script compilation fails"
    );
    await inject.call(actor, "globalThis.recovered = true;");
    Assert.ok(
      pageWindow.recovered,
      "A failed compilation allows a successful retry"
    );
  } finally {
    page.close();
  }
  await withDiagnostics(async () => {
    engineReadyDelayMs = 250;
    const tab = await openProbePage("timeout");
    try {
      const state = await readProbeState(tab.linkedBrowser);
      Assert.equal(
        state.readyState,
        "complete",
        "The page should finish loading"
      );
      Assert.equal(
        state.seen,
        "page-ran-first",
        "The timeout fallback should unblock before the delayed scriptlet runs"
      );
      Assert.equal(
        state.diagnostics?.path,
        "timeout-fallback",
        "Diagnostics should record the timeout fallback path"
      );
      await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => content.wrappedJSObject.__wfProbe === "scriptlet-ran-first",
          "Waiting for the late timeout-fallback scriptlet"
        );
      });
    } finally {
      engineReadyDelayMs = 0;
      await BrowserTestUtils.removeTab(tab);
    }
  });
});

add_task(async function test_no_scriptlet_unblocks_parser() {
  await withDiagnostics(async () => {
    const tab = await openProbePage("noscriptlet");
    try {
      const state = await readProbeState(tab.linkedBrowser);
      Assert.equal(
        state.diagnostics?.path,
        "no-scriptlet-fast-unblock",
        "No-scriptlet pages unblock without scriptlet compilation"
      );
      Assert.equal(
        state.request.context.client.clientScreen,
        undefined,
        "Without injection the request is unchanged"
      );
      Assert.ok(
        state.response.adPlacements && state.response.adSlots,
        "Without injection the same response contains ads"
      );
    } finally {
      await BrowserTestUtils.removeTab(tab);
    }
  }, [earlyScriptletTimeoutPref()]);
});

add_task(async function test_generic_queries_pin_the_document_engine() {
  await withDiagnostics(async () => {
    const originalEngine = WaterfoxBlockerService._engine;
    const originalPayload = WaterfoxBlockerService._resourcePayload;
    const mockedGetResources = WaterfoxBlockerService.getCosmeticResources;
    const actor = { browsingContext: null };
    const prototype = WaterfoxBlockerParent.prototype;
    const hostname = "generation-probe.example";
    const makeEngine = rule => {
      const engine = Cc[
        "@waterfox.com/waterfox-blocker-engine;1"
      ].createInstance(Ci.nsIWaterfoxBlockerEngine);
      engine.initFromLists([rule]);
      engine.useResources("[]");
      return engine;
    };
    try {
      WaterfoxBlockerService.getCosmeticResources =
        originalGetCosmeticResources;
      const first = makeEngine("##.old-ad");
      WaterfoxBlockerService._publishEngine(first, "[]");
      const resources = await prototype._getCosmeticResources.call(actor, {
        url: `https://${hostname}/`,
      });
      Assert.equal(resources.generation, first.publishedGeneration);
      const second = makeEngine("##.new-ad");
      WaterfoxBlockerService._publishEngine(second, "[]");
      const query = {
        classes: ["old-ad", "new-ad"],
        ids: [],
        exceptions: [],
        generation: resources.generation,
      };
      Assert.deepEqual(
        prototype._getHiddenClassIdSelectors.call(actor, query),
        [".old-ad"],
        "Old document exceptions and generic selectors use the same engine snapshot"
      );
      Assert.deepEqual(
        prototype._getHiddenClassIdSelectors.call(actor, {
          ...query,
          generation: second.publishedGeneration,
        }),
        [],
        "Mismatched generation queries are rejected"
      );
      WaterfoxBlockerService.allowSiteForSession(hostname);
      Assert.deepEqual(
        prototype._getHiddenClassIdSelectors.call(actor, query),
        [],
        "Pinned snapshots still honor current site allowances"
      );
    } finally {
      prototype.didDestroy.call(actor);
      WaterfoxBlockerService.removeSiteException(hostname);
      WaterfoxBlockerService._clearEngine();
      WaterfoxBlockerService._engine = originalEngine;
      WaterfoxBlockerService._resourcePayload = originalPayload;
      WaterfoxBlockerService.getCosmeticResources = mockedGetResources;
    }
  });
});

add_task(
  async function test_generic_response_rejects_a_superseded_generation() {
    let resume;
    const paused = new Promise(resolve => {
      resume = resolve;
    });
    let requestedGeneration;
    let applied = false;
    const receiver = {
      document: {},
      _cosmeticEngineGeneration: 1,
      _cosmeticExceptions: [],
      _getDocumentURI: () => TEST_URL,
      _isCurrentDocumentURI: () => true,
      async sendQuery(_name, data) {
        requestedGeneration = data.generation;
        await paused;
        return [".stale-ad"];
      },
      _normalizeSelectors() {
        applied = true;
        return [];
      },
    };
    const query =
      WaterfoxBlockerChild.prototype._queryAndApplyNewSelectors.call(
        receiver,
        ["stale-ad"],
        []
      );
    receiver._cosmeticEngineGeneration = 2;
    resume();
    await query;
    Assert.equal(requestedGeneration, 1);
    Assert.equal(
      applied,
      false,
      "Generic responses from an older generation cannot change the current document"
    );
  }
);
