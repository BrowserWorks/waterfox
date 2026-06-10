/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const ENGINE_CONTRACT_ID = "@waterfox.com/waterfox-blocker-engine;1";

function checkRequest(engine, requestMethod) {
  return JSON.parse(
    engine.checkRequestDetailed(
      "https://ads.example/script.js",
      "publisher.example",
      "ads.example",
      "script",
      requestMethod,
      true
    )
  );
}

add_task(function test_request_method_filtering() {
  const engine = Cc[ENGINE_CONTRACT_ID].createInstance(
    Ci.nsIWaterfoxBlockerEngine
  );
  engine.initFromLists(["||ads.example^$method=POST"]);

  Assert.equal(
    checkRequest(engine, "GET").matched,
    false,
    "GET requests should not match a POST-only rule"
  );
  Assert.equal(
    checkRequest(engine, "POST").matched,
    true,
    "POST requests should match a POST-only rule"
  );
  Assert.equal(
    checkRequest(engine, "").matched,
    false,
    "Requests without a method should not match a method-qualified rule"
  );
});
