/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const {
  getWaterfoxDefaultSearchEngineId,
} = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/search/SearchService.sys.mjs"
);

const ENGINE_IDS = [
  "1org",
  "bing",
  "ddg",
  "ecosia",
  "google",
  "mojeek",
  "qwant",
  "wps",
];
const ENGINES_URL =
  "chrome://browser/content/search/BrowserSearchEngines.json";

add_task(async function test_static_search_data() {
  const engines = await (await fetch(ENGINES_URL)).json();

  Assert.deepEqual(
    engines.map(engine => engine.identifier),
    ENGINE_IDS,
    "The static engine list should contain the Waterfox engines"
  );
  Assert.ok(
    !Object.hasOwn(
      engines.find(engine => engine.identifier == "qwant"),
      "variants"
    ),
    "Qwant should remain available in every region"
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
