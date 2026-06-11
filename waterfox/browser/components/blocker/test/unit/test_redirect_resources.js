/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const RESOURCE_BUNDLE_PATH = [
  "waterfox",
  "browser",
  "components",
  "blocker",
  "assets",
  "resources",
  "resources.json",
];
const ENGINE_CONTRACT_ID = "@waterfox.com/waterfox-blocker-engine;1";

let gResourcesJson;

function makeEngine(rule) {
  const engine = Cc[ENGINE_CONTRACT_ID].createInstance(
    Ci.nsIWaterfoxBlockerEngine
  );
  engine.initFromLists([rule]);
  engine.useResources(gResourcesJson);
  return engine;
}

function checkRequest(engine, url, requestType) {
  return JSON.parse(
    engine.checkRequestDetailed(
      url,
      "publisher.example",
      "example.com",
      requestType,
      "GET",
      true
    )
  );
}

function assertRedirectResource({ rule, url, requestType, expectedMime }) {
  const engine = makeEngine(rule);
  const result = checkRequest(engine, url, requestType);
  const expectedPrefix = `data:${expectedMime};base64,`;

  Assert.equal(result.matched, true, `${rule} should match the request`);
  Assert.equal(result.exception, false, `${rule} should not be excepted`);
  Assert.ok(
    result.redirect.startsWith(expectedPrefix),
    `${rule} should redirect to a ${expectedMime} data URL`
  );
  Assert.greater(
    result.redirect.length,
    expectedPrefix.length,
    `${rule} should include redirect resource content`
  );
}

add_setup(async function setup() {
  const repoDir = Services.env.get("MOZ_DEVELOPER_REPO_DIR");
  Assert.ok(repoDir, "xpcshell should expose the checkout path");

  gResourcesJson = await IOUtils.readUTF8(
    PathUtils.join(repoDir, ...RESOURCE_BUNDLE_PATH)
  );
  const resources = JSON.parse(gResourcesJson);
  Assert.ok(Array.isArray(resources), "resource bundle should be an array");
  Assert.ok(
    resources.some(resource => resource.name === "noop.js"),
    "resource bundle should include standard uBO JS redirect resources"
  );
  Assert.ok(
    resources.some(resource => resource.name === "1x1.gif"),
    "resource bundle should include standard uBO binary redirect resources"
  );
});

add_task(function test_redirect_rule_serves_noop_js() {
  assertRedirectResource({
    rule: "||example.com/ads.js$redirect=noop.js",
    url: "https://example.com/ads.js",
    requestType: "script",
    expectedMime: "application/javascript",
  });
});

add_task(function test_redirect_rule_serves_binary_resource() {
  assertRedirectResource({
    rule: "||example.com/pixel.gif$redirect=1x1.gif",
    url: "https://example.com/pixel.gif",
    requestType: "image",
    expectedMime: "image/gif",
  });
});
