/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const ENGINE_CONTRACT_ID = "@waterfox.com/waterfox-blocker-engine;1";

function createEngine() {
  return Cc[ENGINE_CONTRACT_ID].createInstance(Ci.nsIWaterfoxBlockerEngine);
}

function makeEngine(rules) {
  const engine = createEngine();
  engine.initFromLists([rules.join("\n")]);
  return engine;
}

function assertRequest(
  engine,
  sourceHostname,
  { matched, important = false, exception = false },
  context,
  path = "ad.js"
) {
  const result = JSON.parse(
    engine.checkRequestDetailed(
      `https://ads.example/${path}`,
      sourceHostname,
      "ads.example",
      "script",
      "GET",
      true
    )
  );
  const message = `${context}: ${sourceHostname}, ${path}`;
  Assert.equal(result.matched, matched, `${message}: blocked`);
  Assert.equal(result.important, important, `${message}: important`);
  Assert.equal(result.exception, exception, `${message}: exception`);
}

function assertBeforeAndAfterReload(rules, check) {
  const engine = makeEngine(rules);
  check(engine, "list engine");

  const reloaded = createEngine();
  reloaded.initFromCache(engine.serialize());
  check(reloaded, "reloaded engine");
}

add_task(function test_source_domains_and_alias() {
  const cases = [
    {
      rule: "$script,from=publisher.example",
      allowed: "news.publisher.example",
      excluded: "notpublisher.example",
    },
    {
      rule: "||ads.example/ad.js$script,from=publisher.example|second.example",
      allowed: "news.second.example",
      excluded: "unrelated.example",
    },
    {
      rule: "$script,from=publisher.example|second.example|~private.publisher.example",
      allowed: "publisher.example",
      excluded: "news.private.publisher.example",
    },
    {
      rule: "||ads.example/ad.js$script,from=~publisher.example",
      allowed: "notpublisher.example",
      excluded: "news.publisher.example",
    },
  ];
  for (const { rule, allowed, excluded } of cases) {
    assertBeforeAndAfterReload([rule], (engine, phase) => {
      assertRequest(engine, allowed, { matched: true }, phase);
      assertRequest(engine, excluded, { matched: false }, phase);
      if (rule.startsWith("||")) {
        assertRequest(engine, allowed, { matched: false }, phase, "other.js");
      }
    });
  }
  const alias = makeEngine(["$script,domain=publisher.example"]);
  assertRequest(
    alias,
    "news.publisher.example",
    { matched: true },
    "$domain alias"
  );
  assertRequest(
    alias,
    "notpublisher.example",
    { matched: false },
    "$domain alias"
  );
});

add_task(function test_source_domain_exceptions_and_important_rules() {
  assertBeforeAndAfterReload(
    ["||ads.example^", "@@$script,from=publisher.example"],
    (engine, phase) => {
      assertRequest(
        engine,
        "news.publisher.example",
        { matched: false, exception: true },
        phase
      );
      assertRequest(engine, "unrelated.example", { matched: true }, phase);
    }
  );
  assertBeforeAndAfterReload(
    [
      "||ads.example/ad.js$script,from=publisher.example,important",
      "@@||ads.example^",
    ],
    (engine, phase) => {
      assertRequest(
        engine,
        "news.publisher.example",
        { matched: true, important: true },
        phase
      );
      assertRequest(
        engine,
        "unrelated.example",
        { matched: false, exception: true },
        phase
      );
      assertRequest(
        engine,
        "news.publisher.example",
        { matched: false, exception: true },
        phase,
        "other.js"
      );
    }
  );
});

add_task(function test_badfilter_prunes_source_domain_and_pattern_rules() {
  for (const disabled of [
    "$script,from=publisher.example|second.example",
    "||ads.example/ad.js$script,important",
    "@@$script,from=publisher.example|second.example",
  ]) {
    const exception = disabled.startsWith("@@");
    const background = exception
      ? "||ads.example^"
      : "||ads.example/control.js";
    const baseline = makeEngine([disabled, background]);
    assertRequest(
      baseline,
      "publisher.example",
      {
        matched: !exception,
        important: disabled.endsWith(",important"),
        exception,
      },
      `${disabled} is active before badfilter`
    );
    assertBeforeAndAfterReload(
      [disabled, background, `${disabled},badfilter`],
      (engine, phase) => {
        assertRequest(
          engine,
          "publisher.example",
          { matched: exception },
          phase
        );
        assertRequest(
          engine,
          "publisher.example",
          { matched: true },
          phase,
          "control.js"
        );
      }
    );
  }
});

add_task(function test_csp_aggregates_source_domain_and_pattern_rules() {
  assertBeforeAndAfterReload(
    [
      "$csp=script-src 'none',from=publisher.example",
      "||ads.example^$csp=img-src 'none'",
      "||ads.example^$csp=connect-src 'none'",
      "@@$csp=connect-src 'none',from=publisher.example",
    ],
    (engine, phase) => {
      for (const source of ["news.publisher.example", "unrelated.example"]) {
        const directives = engine.getCspDirectives(
          "https://ads.example/page.html",
          source,
          "ads.example",
          "document",
          "GET",
          true
        );
        Assert.deepEqual(
          directives.split(",").sort(),
          [
            "img-src 'none'",
            source === "news.publisher.example"
              ? "script-src 'none'"
              : "connect-src 'none'",
          ].sort(),
          `${phase}: ${source} should aggregate CSP rules and apply scoped exceptions`
        );
      }
    }
  );
});

add_task(function test_to_rules_are_excluded_from_matching() {
  // 0.13.3 parses $to but deliberately excludes these rules from matching.
  assertBeforeAndAfterReload(
    [
      "$script,to=ads.example",
      "||ads.example^$to=ads.example",
      "$script,from=publisher.example,to=ads.example,important",
      "@@||ads.example^$to=ads.example",
      "||ads.example/control.js",
    ],
    (engine, phase) => {
      assertRequest(engine, "publisher.example", { matched: false }, phase);
      assertRequest(
        engine,
        "publisher.example",
        { matched: true },
        phase,
        "control.js"
      );
    }
  );
});

add_task(function test_dat_v6_and_reject_v5_header() {
  const engine = makeEngine(["$script,from=publisher.example|second.example"]);
  const serialized = Uint8Array.from(engine.serialize());
  Assert.greater(
    serialized.length,
    13,
    "DAT should contain a header and payload"
  );
  Assert.deepEqual(
    Array.from(serialized.slice(0, 4)),
    [0xd1, 0xd9, 0x3a, 0xaf],
    "DAT should start with the adblock-rust magic bytes"
  );
  Assert.equal(serialized[4], 6, "0.13.3 should serialize DAT v6");

  // data_format/mod.rs puts the version after the four magic bytes and checks
  // it before the payload/checksum. This is an old-format header fixture, not
  // a v5 payload: changing only the version suffices to test its rejection.
  const oldFormatHeader = serialized.slice();
  oldFormatHeader[4] = 5;
  Assert.throws(
    () => createEngine().initFromCache(oldFormatHeader),
    /NS_ERROR_FAILURE/,
    "The new engine should reject the previous DAT v5 header"
  );

  const reloaded = createEngine();
  reloaded.initFromCache(serialized);
  assertRequest(
    reloaded,
    "news.publisher.example",
    { matched: true },
    "The unmodified v6 cache should still load and match"
  );
});

add_task(function test_failed_initialization_preserves_published_rules() {
  const engine = makeEngine(["||ads.example/ad.js"]);
  assertRequest(
    engine,
    "publisher.example",
    { matched: true },
    "Initial blocking rules"
  );

  const invalidCache = Uint8Array.from(engine.serialize());
  invalidCache[4] = 5;
  Assert.throws(
    () => engine.initFromCache(invalidCache),
    /NS_ERROR_FAILURE/,
    "An incompatible replacement cache should fail"
  );
  Assert.throws(
    () => engine.initFromLists(["! No rules"]),
    /NS_ERROR_(INVALID_ARG|ILLEGAL_VALUE)/,
    "A replacement without rules should fail"
  );
  assertRequest(
    engine,
    "publisher.example",
    { matched: true },
    "Failed replacements preserve the old engine"
  );

  engine.initFromLists(["@@||ads.example/ad.js"]);
  assertRequest(
    engine,
    "publisher.example",
    { matched: false, exception: true },
    "Successful replacement publishes the new engine"
  );
});

add_task(function test_first_party_ad_rules_remain_independent_of_etp() {
  const engine = makeEngine(["||ads.example^$script,first-party"]);
  for (const thirdParty of [false, true]) {
    const result = JSON.parse(
      engine.checkRequestDetailed(
        "https://ads.example/ad.js",
        thirdParty ? "publisher.example" : "ads.example",
        "ads.example",
        "script",
        "GET",
        thirdParty
      )
    );
    Assert.equal(
      result.matched,
      !thirdParty,
      "The shared engine preserves first-party ad filtering"
    );
  }
});
