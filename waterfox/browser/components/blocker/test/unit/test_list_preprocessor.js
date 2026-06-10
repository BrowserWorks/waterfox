/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { DEFAULT_PREPROCESSOR_TOKENS, preprocessFilterListText } =
  ChromeUtils.importESModule(
    "resource:///modules/internal/ListPreprocessor.sys.mjs"
  );
const { ListPreprocessor } = ChromeUtils.importESModule(
  "resource:///modules/internal/ListPreprocessor.sys.mjs"
);

function preprocess(text, tokenOverrides = {}) {
  return preprocessFilterListText(text, {
    ...DEFAULT_PREPROCESSOR_TOKENS,
    ...tokenOverrides,
  }).split("\n");
}

add_task(function test_firefox_environment_branch() {
  Assert.deepEqual(
    preprocess(
      [
        "always",
        "!#if env_firefox",
        "firefox",
        "!#else",
        "not-firefox",
        "!#endif",
        "!#if env_chromium",
        "chromium",
        "!#endif",
      ].join("\n")
    ),
    ["always", "firefox"],
    "Waterfox should evaluate list preprocessing as Firefox, not Chromium"
  );
});

add_task(function test_named_service_export() {
  Assert.equal(
    ListPreprocessor.preprocessFilterListText("keep"),
    "keep",
    "Service lazy import should expose ListPreprocessor.preprocessFilterListText"
  );
});

add_task(function test_boolean_expressions_and_unknown_tokens() {
  Assert.deepEqual(
    preprocess(
      [
        "!#if env_firefox && (!cap_html_filtering || env_chromium)",
        "keep",
        "!#endif",
        "!#if unknown_capability",
        "drop-unknown",
        "!#endif",
        "!#if !unknown_capability",
        "keep-negated-unknown",
        "!#endif",
      ].join("\n"),
      { cap_html_filtering: false }
    ),
    ["keep", "keep-negated-unknown"],
    "Preprocessor should support boolean expressions and treat unknown tokens as false"
  );
});

add_task(function test_nested_parent_inactive() {
  Assert.deepEqual(
    preprocess(
      [
        "!#if env_chromium",
        "!#if env_firefox",
        "drop-nested-if",
        "!#else",
        "drop-nested-else",
        "!#endif",
        "!#else",
        "keep-outer-else",
        "!#endif",
      ].join("\n")
    ),
    ["keep-outer-else"],
    "Nested branches should stay inactive when their parent branch is inactive"
  );
});

add_task(function test_youtube_firefox_scriptlet_branch() {
  const lines = preprocess(
    [
      "!#if !env_mv3",
      "!#if !cap_html_filtering",
      "!#if env_firefox",
      "youtube.com##+js(json-prune, playerResponse.adPlacements)",
      "!#endif",
      "!#endif",
      "!#endif",
      "!#if !cap_html_filtering",
      "www.youtube.com##+js(trusted-replace-fetch-response, adPlacements)",
      "!#else",
      '||www.youtube.com/playlist?list=$xhr,1p,replace=/"adPlacements"/"no_ads"/',
      'www.youtube.com##^script[id]:has-text(window,"fetch")',
      "!#endif",
    ].join("\n")
  );

  Assert.deepEqual(
    lines,
    [
      "youtube.com##+js(json-prune, playerResponse.adPlacements)",
      "www.youtube.com##+js(trusted-replace-fetch-response, adPlacements)",
    ],
    "Current Waterfox capabilities should select the Firefox scriptlet fallback branch"
  );
});

add_task(
  function test_youtube_firefox_scriptlet_branch_without_html_filtering() {
    const lines = preprocess(
      [
        "!#if !env_mv3",
        "!#if !cap_html_filtering",
        "!#if env_firefox",
        "youtube.com##+js(json-prune, playerResponse.adPlacements)",
        "!#endif",
        "!#endif",
        "!#endif",
        "!#if !cap_html_filtering",
        "www.youtube.com##+js(trusted-replace-fetch-response, adPlacements)",
        "!#else",
        '||www.youtube.com/playlist?list=$xhr,1p,replace=/"adPlacements"/"no_ads"/',
        'www.youtube.com##^script[id]:has-text(window,"fetch")',
        "!#endif",
      ].join("\n"),
      { cap_html_filtering: false }
    );

    Assert.deepEqual(
      lines,
      [
        "youtube.com##+js(json-prune, playerResponse.adPlacements)",
        "www.youtube.com##+js(trusted-replace-fetch-response, adPlacements)",
      ],
      "The Firefox scriptlet branch should remain selectable when HTML filtering is disabled"
    );
  }
);

add_task(function test_youtube_html_filtering_branch_when_capable() {
  const lines = preprocess(
    [
      "!#if !cap_html_filtering",
      "www.youtube.com##+js(trusted-replace-fetch-response, adPlacements)",
      "!#else",
      '||www.youtube.com/playlist?list=$xhr,1p,replace=/"adPlacements"/"no_ads"/',
      'www.youtube.com##^script[id]:has-text(window,"fetch")',
      "!#endif",
    ].join("\n"),
    { cap_html_filtering: true }
  );

  Assert.deepEqual(
    lines,
    [
      '||www.youtube.com/playlist?list=$xhr,1p,replace=/"adPlacements"/"no_ads"/',
      'www.youtube.com##^script[id]:has-text(window,"fetch")',
    ],
    "cap_html_filtering should only select the HTML filtering branch when explicitly enabled"
  );
});
