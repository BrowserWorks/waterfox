/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { ListStore } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListStore.sys.mjs"
);

const ENGINE_CONTRACT_ID = "@waterfox.com/waterfox-blocker-engine;1";

function checkRequest(
  engine,
  url,
  sourceHostname,
  hostname,
  requestType = "xmlhttprequest",
  requestMethod = "GET",
  isThirdParty = false
) {
  return JSON.parse(
    engine.checkRequestDetailed(
      url,
      sourceHostname,
      hostname,
      requestType,
      requestMethod,
      isThirdParty
    )
  );
}

add_task(async function test_chase_dip_exception_is_narrow() {
  const listRecords = await ListStore.withWaterfoxUnbreakRecord([
    {
      filename: "test-blocking.txt",
      text: "/__imp_apg__/*\n||analytics.chase.com^",
      url: "waterfox://test-blocking",
    },
  ]);
  const engine = Cc[ENGINE_CONTRACT_ID].createInstance(
    Ci.nsIWaterfoxBlockerEngine
  );
  engine.initFromLists(listRecords.map(record => record.text));

  const chaseDip = checkRequest(
    engine,
    "https://securej.chase.com/__imp_apg__/api/dip/v1/dip",
    "secure.chase.com",
    "securej.chase.com"
  );
  Assert.equal(chaseDip.exception, true, "Chase DIP request should be allowed");

  const offsiteDip = checkRequest(
    engine,
    "https://securej.chase.com/__imp_apg__/api/dip/v1/dip",
    "example.com",
    "securej.chase.com",
    "xmlhttprequest",
    "GET",
    true
  );
  Assert.equal(
    offsiteDip.matched,
    true,
    "Off-site DIP request should be blocked"
  );
  Assert.equal(
    offsiteDip.exception,
    false,
    "Chase exception should not apply off-site"
  );

  for (const [url, hostname, message] of [
    [
      "http://securej.chase.com/__imp_apg__/api/dip/v1/dip",
      "securej.chase.com",
      "The exception should require HTTPS",
    ],
    [
      "https://subdomain.securej.chase.com/__imp_apg__/api/dip/v1/dip",
      "subdomain.securej.chase.com",
      "The exception should require the exact hostname",
    ],
  ]) {
    const result = checkRequest(engine, url, "secure.chase.com", hostname);
    Assert.equal(result.matched, true, `${message}: request should be blocked`);
    Assert.equal(result.exception, false, message);
  }

  const chaseAnalytics = checkRequest(
    engine,
    "https://analytics.chase.com/events/authentication",
    "secure.chase.com",
    "analytics.chase.com"
  );
  Assert.equal(
    chaseAnalytics.matched,
    true,
    "Unrelated Chase analytics should remain blocked"
  );
  Assert.equal(
    chaseAnalytics.exception,
    false,
    "Unrelated Chase analytics should not be excepted"
  );
});
