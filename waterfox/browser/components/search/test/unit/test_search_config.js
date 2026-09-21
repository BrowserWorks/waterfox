/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { applyWaterfoxSearchTweaks, getWaterfoxDefaultSearchEngineId } =
  ChromeUtils.importESModule(
    "moz-src:///toolkit/components/search/SearchService.sys.mjs"
  );

const ENGINE_IDS = [
  "bing",
  "ddg",
  "ecosia",
  "google",
  "mojeek",
  "qwant",
  "wps",
];
const ENGINES_URL = "chrome://browser/content/search/BrowserSearchEngines.json";
const ICONS_URL =
  "chrome://browser/content/search/BrowserSearchEngineIcons.json";

add_task(async function test_static_search_data() {
  const engines = await (await fetch(ENGINES_URL)).json();
  const icons = new Map(await (await fetch(ICONS_URL)).json());

  Assert.deepEqual(
    engines.map(engine => engine.identifier),
    ENGINE_IDS,
    "The static engine list should contain the Waterfox engines"
  );
  Assert.deepEqual(
    [...icons.keys()],
    ENGINE_IDS,
    "Every Waterfox engine should have a static icon"
  );
  Assert.ok(
    !Object.hasOwn(
      engines.find(engine => engine.identifier == "qwant"),
      "variants"
    ),
    "Qwant should remain available in every region"
  );
});

add_task(async function test_ai_opt_out_params() {
  const engines = await (await fetch(ENGINES_URL)).json();
  const byId = new Map(engines.map(engine => [engine.identifier, engine]));

  const googleParams = byId.get("google").urls.search.params;
  Assert.ok(
    googleParams.some(
      param =>
        param.name == "udm" && param.experimentConfig == "waterfox_ai_google"
    ),
    "Google should disable AI via udm from the AI pref"
  );

  const qwantParams = byId.get("qwant").urls.search.params;
  Assert.ok(
    qwantParams.some(
      param =>
        param.name == "llm" && param.experimentConfig == "waterfox_ai_qwant"
    ),
    "Qwant should disable AI via llm from the AI pref"
  );

  const bingParams = byId.get("bing").urls.search.params;
  Assert.ok(
    bingParams.some(
      param =>
        param.name == "showconv" && param.experimentConfig == "waterfox_ai_bing"
    ),
    "Bing should disable AI via showconv from the AI pref"
  );
});

add_task(async function test_search_tweaks() {
  const engines = await (await fetch(ENGINES_URL)).json();
  const byId = list => new Map(list.map(engine => [engine.identifier, engine]));

  const defaults = byId(applyWaterfoxSearchTweaks(engines));
  Assert.equal(
    defaults.get("ddg").urls.search.base,
    "https://noai.duckduckgo.com/",
    "DuckDuckGo uses the no-AI endpoint by default"
  );
  Assert.equal(
    defaults.get("ddg").urls.search.searchTermParamName,
    "q",
    "The no-AI swap keeps the search term param"
  );
  Assert.ok(
    defaults.get("ddg").urls.search.params.some(param => param.name == "t"),
    "The no-AI swap keeps the attribution param"
  );
  Assert.equal(
    defaults.get("google").urls.suggestions.base,
    "https://search.waterfox.com/autocomplete",
    "Suggestions stay proxied by default"
  );

  const direct = byId(applyWaterfoxSearchTweaks(engines, { useProxy: false }));
  Assert.equal(
    direct.get("google").urls.suggestions.base,
    "https://www.google.com/complete/search",
    "Bypassing the proxy uses direct suggestion endpoints"
  );
  Assert.equal(
    direct.get("wps").urls.suggestions.base,
    "https://search.waterfox.com/autocomplete",
    "Engines without a direct endpoint keep the proxy"
  );

  const withAI = byId(applyWaterfoxSearchTweaks(engines, { disableAI: false }));
  Assert.equal(
    withAI.get("ddg").urls.search.base,
    "https://duckduckgo.com/",
    "Allowing AI restores the regular DuckDuckGo endpoint"
  );
});

add_task(function test_qwant_default_regions() {
  for (const region of ["US", "fr", "KR"]) {
    Assert.equal(
      getWaterfoxDefaultSearchEngineId(region),
      "qwant",
      `Qwant should be the default in supported region ${region}`
    );
  }

  for (const region of ["BR", "IN", "JP"]) {
    Assert.equal(
      getWaterfoxDefaultSearchEngineId(region),
      "ddg",
      `DuckDuckGo should be the fallback in unsupported region ${region}`
    );
  }

  for (const region of [null, undefined, "", "unknown"]) {
    Assert.equal(
      getWaterfoxDefaultSearchEngineId(region),
      "qwant",
      "Qwant should remain the default until an unsupported region is detected"
    );
  }
});
