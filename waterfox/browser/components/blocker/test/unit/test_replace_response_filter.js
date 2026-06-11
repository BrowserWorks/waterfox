/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);
const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const {
  MAX_REPLACE_DIRECTIVES,
  REPLACE_MAX_INPUT_BYTES,
  WaterfoxBlockerService,
} = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);

const PREF_ENABLED = "waterfox.blocker.enabled";
const REPLACE_DIRECTIVE = '/"adSlots"/"no_ads"/';
const HTML_FILTER = htmlFilter([
  { type: "css-selector", arg: "script" },
  { type: "has-text", arg: "adSlots" },
]);
const HTML_CSS_FILTER = htmlFilter([
  { type: "css-selector", arg: "div" },
  { type: "matches-css", arg: "color: red" },
]);
const HTML_CSS_BEFORE_FILTER = htmlFilter([
  { type: "css-selector", arg: "div" },
  { type: "matches-css-before", arg: "content: /ADVERTISEMENT/" },
]);
const HTML_RELATIVE_SELECTOR_FILTER = htmlFilter([
  { type: "css-selector", arg: "html > head > script" },
  { type: "has-text", arg: "adSlots" },
  { type: "upward", arg: "1" },
  { type: "css-selector", arg: "> script" },
  { type: "has-text", arg: "keep" },
]);
const HTML_SCRIPT_FILTER = htmlFilter([
  { type: "css-selector", arg: "script" },
]);
const ORIGINAL_JSON = '{"adSlots":[1],"keep":true}';
const REWRITTEN_JSON = '{"no_ads":[1],"keep":true}';
const LARGE_BODY = `"adSlots"${"x".repeat(10 * 1024 * 1024)}`;
const REPLACE_CAP_BODY = `"adSlots"${"x".repeat(REPLACE_MAX_INPUT_BYTES)}`;
const DIRECTIVE_COUNT_TOKENS = Array.from(
  { length: MAX_REPLACE_DIRECTIVES + 1 },
  (_, i) => `__wf_token_${i}__`
);
const DIRECTIVE_COUNT_BODY = DIRECTIVE_COUNT_TOKENS.join("\n");
const EXPANDING_HTML_TEXT = "x".repeat(1024 * 1024 + 1);
const WINDOWS_1252_BODY = `caf${String.fromCharCode(0xe9)} "adSlots"`;
const ORIGINAL_HTML =
  "<!DOCTYPE html><html><head><script>const adSlots = true;</script><script>const keep = true;</script></head><body>ok</body></html>";
const ORIGINAL_STYLED_HTML =
  '<!DOCTYPE html><html><body><div style="color: red">adSlots</div><div>keep</div></body></html>';
const ORIGINAL_PSEUDO_HTML =
  '<!DOCTYPE html><html><head><style>.ad::before { content: "ADVERTISEMENT"; }</style></head><body><div class="ad">adSlots</div><div>keep</div></body></html>';
const EXPANDING_HTML = `<!DOCTYPE html><html><head><script>const adSlots = true;</script></head><body>${EXPANDING_HTML_TEXT}</body></html>`;
const ORIGINAL_XHTML =
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><script>const adSlots = true;</script><script>const keep = true;</script></head><body>ok</body></html>';

let server;
let baseUrl;
let documentBaseUrl;

function htmlFilter(selector) {
  return JSON.stringify({ selector });
}

function makeEngine({
  replaceDirectives = [REPLACE_DIRECTIVE],
  htmlFilters = [],
  responseHeaderFilters = [],
} = {}) {
  WaterfoxBlockerService._engine = {
    checkRequestDetailed() {
      return JSON.stringify({
        exception: false,
        important: false,
        matched: false,
        redirect: "",
        rewrittenUrl: "",
      });
    },
    getCspDirectives() {
      return "";
    },
    getReplaceDirectives() {
      return JSON.stringify(replaceDirectives);
    },
    getCosmeticResources() {
      return JSON.stringify({
        html_filters: htmlFilters,
        response_header_filters: responseHeaderFilters,
      });
    },
  };
}

async function fetchResponse(path) {
  return fetch(`${baseUrl}${path}`, { cache: "no-store" });
}

async function fetchText(path) {
  return (await fetchResponse(path)).text();
}

async function fetchDocument(path) {
  const channel = NetUtil.newChannel({
    uri: `${documentBaseUrl}${path}`,
    loadUsingSystemPrincipal: true,
    contentPolicyType: Ci.nsIContentPolicy.TYPE_DOCUMENT,
  }).QueryInterface(Ci.nsIHttpChannel);
  channel.loadFlags |= Ci.nsIRequest.LOAD_BYPASS_CACHE;

  return new Promise((resolve, reject) => {
    NetUtil.asyncFetch(channel, (inputStream, status, request) => {
      if (!Components.isSuccessCode(status)) {
        reject(new Error(`document fetch failed: ${status}`));
        return;
      }

      const responseChannel = request.QueryInterface(Ci.nsIHttpChannel);
      const text = NetUtil.readInputStreamToString(
        inputStream,
        inputStream.available()
      );
      resolve({ channel: responseChannel, text });
    });
  });
}

function registerTextPath(path, body, contentType = "application/json") {
  server.registerPathHandler(path, (metadata, response) => {
    response.setStatusLine(metadata.httpVersion, 200, "OK");
    response.setHeader("Content-Type", contentType, false);
    response.setHeader("Content-Length", String(body.length), false);
    response.bodyOutputStream.write(body, body.length);
  });
}

function registerHeaderPath(path, body) {
  server.registerPathHandler(path, (metadata, response) => {
    response.setStatusLine(metadata.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "text/html", false);
    response.setHeader("X-Adblock-Test", "present", false);
    response.setHeader("Content-Length", String(body.length), false);
    response.bodyOutputStream.write(body, body.length);
  });
}

function registerAttachmentPath(path, body) {
  server.registerPathHandler(path, (metadata, response) => {
    response.setStatusLine(metadata.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "text/plain", false);
    response.setHeader("Content-Disposition", "attachment", false);
    response.setHeader("Content-Length", String(body.length), false);
    response.bodyOutputStream.write(body, body.length);
  });
}

add_setup(async function setup() {
  Services.prefs.setBoolPref(PREF_ENABLED, true);

  server = new HttpServer();
  server.start(-1);
  baseUrl = `http://127.0.0.1:${server.identity.primaryPort}`;
  documentBaseUrl = `http://localhost:${server.identity.primaryPort}`;

  registerTextPath("/json", ORIGINAL_JSON);
  registerTextPath("/plain", ORIGINAL_JSON);
  registerTextPath("/large", LARGE_BODY, "text/plain");
  registerTextPath("/replace-cap", REPLACE_CAP_BODY, "text/plain");
  registerTextPath("/directive-count", DIRECTIVE_COUNT_BODY, "text/plain");
  registerTextPath("/binary", ORIGINAL_JSON, "application/octet-stream");
  registerTextPath("/html", ORIGINAL_HTML, "text/html");
  registerTextPath("/styled", ORIGINAL_STYLED_HTML, "text/html");
  registerTextPath("/pseudo", ORIGINAL_PSEUDO_HTML, "text/html");
  registerTextPath("/expanding-html", EXPANDING_HTML, "text/html");
  registerTextPath("/xhtml", ORIGINAL_XHTML, "application/xhtml+xml");
  registerTextPath(
    "/windows-1252",
    WINDOWS_1252_BODY,
    "text/plain; charset=windows-1252"
  );
  registerHeaderPath("/header", ORIGINAL_HTML);
  registerAttachmentPath("/attachment", ORIGINAL_JSON);

  WaterfoxBlockerService._registerNetworkObservers();

  registerCleanupFunction(async () => {
    WaterfoxBlockerService._unregisterNetworkObservers();
    WaterfoxBlockerService._engine = null;
    Services.prefs.clearUserPref(PREF_ENABLED);
    await new Promise(resolve => server.stop(resolve));
  });
});

add_task(async function test_replace_response_filter_rewrites_matching_body() {
  makeEngine();

  const response = await fetchResponse("/json");
  Assert.equal(
    await response.text(),
    REWRITTEN_JSON,
    "$replace should rewrite a matching text response"
  );
});

add_task(async function test_replace_response_filter_removes_length_on_noop() {
  makeEngine({ replaceDirectives: ["/not-present/no_ads/"] });

  const response = await fetchResponse("/json");
  Assert.equal(
    await response.text(),
    ORIGINAL_JSON,
    "No-op replacement should preserve the body"
  );
});

add_task(async function test_replace_response_filter_skips_bad_directive() {
  makeEngine({ replaceDirectives: ["bad-directive", REPLACE_DIRECTIVE] });

  Assert.equal(
    await fetchText("/json"),
    REWRITTEN_JSON,
    "Malformed replace directives should not suppress valid directives"
  );
});

add_task(
  async function test_replace_response_filter_round_trips_windows_1252() {
    makeEngine();

    const response = await fetchResponse("/windows-1252");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const tail = String.fromCharCode(...bytes.subarray(4));

    Assert.equal(bytes[3], 0xe9, "$replace should preserve Windows-1252 é");
    Assert.equal(
      tail,
      ' "no_ads"',
      "$replace should preserve ASCII replacement text"
    );
  }
);

add_task(
  async function test_replace_response_filter_passes_non_matching_rule() {
    makeEngine({ replaceDirectives: [] });

    Assert.equal(
      await fetchText("/plain"),
      ORIGINAL_JSON,
      "Responses without matching replace directives should pass through"
    );
  }
);

add_task(async function test_replace_response_filter_respects_disabled_pref() {
  makeEngine();
  Services.prefs.setBoolPref(PREF_ENABLED, false);

  try {
    Assert.equal(
      await fetchText("/json"),
      ORIGINAL_JSON,
      "Disabled blocker should not rewrite responses"
    );
  } finally {
    Services.prefs.setBoolPref(PREF_ENABLED, true);
  }
});

add_task(async function test_replace_response_filter_respects_site_bypass() {
  makeEngine();
  const originalBypass = WaterfoxBlockerService.shouldBypassBlocking;
  WaterfoxBlockerService.shouldBypassBlocking = (candidateDomain, options) =>
    candidateDomain === "127.0.0.1" ||
    originalBypass.call(WaterfoxBlockerService, candidateDomain, options);

  try {
    Assert.equal(
      await fetchText("/json"),
      ORIGINAL_JSON,
      "Site bypass should not rewrite responses"
    );
  } finally {
    WaterfoxBlockerService.shouldBypassBlocking = originalBypass;
  }
});

add_task(async function test_replace_response_filter_passes_large_body() {
  makeEngine();
  const body = await fetchText("/large");

  Assert.equal(
    body.length,
    LARGE_BODY.length,
    "Bodies over the response buffer cap should pass through unchanged"
  );
  Assert.ok(
    body.startsWith('"adSlots"'),
    "Oversized body should retain the original prefix"
  );
  Assert.ok(!body.includes("no_ads"), "Oversized body should not be rewritten");
});

add_task(async function test_replace_response_filter_passes_replace_cap_body() {
  makeEngine();

  Assert.equal(
    await fetchText("/replace-cap"),
    REPLACE_CAP_BODY,
    "Bodies over the $replace input cap should pass through byte-identical"
  );
});

add_task(async function test_replace_response_filter_limits_directive_count() {
  const replaceDirectives = DIRECTIVE_COUNT_TOKENS.map(
    (token, i) => `/${token}/__wf_replaced_${i}__/g`
  );
  makeEngine({ replaceDirectives });

  const body = await fetchText("/directive-count");

  for (let i = 0; i < MAX_REPLACE_DIRECTIVES; i++) {
    Assert.ok(
      body.includes(`__wf_replaced_${i}__`),
      `Directive ${i} should apply before the cap`
    );
    Assert.ok(
      !body.includes(DIRECTIVE_COUNT_TOKENS[i]),
      `Original token ${i} should be replaced before the cap`
    );
  }

  Assert.ok(
    body.includes(DIRECTIVE_COUNT_TOKENS[MAX_REPLACE_DIRECTIVES]),
    "Directive beyond the cap should not apply"
  );
  Assert.ok(
    !body.includes(`__wf_replaced_${MAX_REPLACE_DIRECTIVES}__`),
    "No replacement should be emitted for directives beyond the cap"
  );
});

add_task(async function test_replace_response_filter_skips_binary_body() {
  makeEngine();

  Assert.equal(
    await fetchText("/binary"),
    ORIGINAL_JSON,
    "Binary responses should not be intercepted"
  );
});

add_task(async function test_replace_response_filter_skips_attachments() {
  makeEngine();

  Assert.equal(
    await fetchText("/attachment"),
    ORIGINAL_JSON,
    "Attachment responses should not be intercepted"
  );
});

add_task(async function test_html_filter_removes_matching_element() {
  makeEngine({ replaceDirectives: [], htmlFilters: [HTML_FILTER] });

  const { text } = await fetchDocument("/html");

  Assert.ok(
    !text.includes("adSlots"),
    "HTML filtering should remove matching elements before the document is parsed"
  );
  Assert.ok(
    text.includes("const keep = true;"),
    "HTML filtering should preserve non-matching elements"
  );
});

add_task(async function test_html_filter_respects_exception() {
  makeEngine({ replaceDirectives: [], htmlFilters: [] });
  const { text } = await fetchDocument("/html");

  Assert.ok(
    text.includes("adSlots"),
    "HTML filtering exceptions should suppress matching removal rules"
  );
});

add_task(async function test_html_filter_matches_css_operator() {
  makeEngine({ replaceDirectives: [], htmlFilters: [HTML_CSS_FILTER] });
  const { text } = await fetchDocument("/styled");

  Assert.ok(
    !text.includes("adSlots"),
    "matches-css() HTML filters should remove matching elements"
  );
  Assert.ok(text.includes("keep"), "Non-matching styled HTML should remain");
});

add_task(async function test_html_filter_matches_css_before_operator() {
  makeEngine({ replaceDirectives: [], htmlFilters: [HTML_CSS_BEFORE_FILTER] });
  const { text } = await fetchDocument("/pseudo");

  Assert.ok(
    !text.includes("adSlots"),
    "matches-css-before() HTML filters should use inline stylesheet rules"
  );
  Assert.ok(text.includes("keep"), "Non-matching pseudo styled HTML remains");
});

add_task(async function test_html_filter_relative_selector_after_upward() {
  makeEngine({
    replaceDirectives: [],
    htmlFilters: [HTML_RELATIVE_SELECTOR_FILTER],
  });
  const { text } = await fetchDocument("/html");

  Assert.ok(
    text.includes("adSlots"),
    "The initial script should remain because the trailing relative selector chooses a sibling"
  );
  Assert.ok(
    !text.includes("const keep = true;"),
    "A CSS selector after :upward() may start with a combinator"
  );
});

add_task(async function test_html_filter_skips_when_replace_expands_over_cap() {
  makeEngine({
    replaceDirectives: ["/x/xx/g"],
    htmlFilters: [HTML_FILTER],
  });

  const { text } = await fetchDocument("/expanding-html");

  Assert.greater(
    text.length,
    EXPANDING_HTML.length,
    "$replace should still apply to the expandable response"
  );
  Assert.ok(
    text.includes("adSlots"),
    "HTML filtering should be skipped after $replace expands the body over the HTML cap"
  );
});

add_task(async function test_html_filter_supports_xhtml_serialization() {
  makeEngine({ replaceDirectives: [], htmlFilters: [HTML_FILTER] });
  const { text } = await fetchDocument("/xhtml");

  Assert.ok(
    text.includes('xmlns="http://www.w3.org/1999/xhtml"'),
    "XHTML filtering should preserve the XHTML namespace"
  );
  Assert.ok(
    !text.includes("adSlots"),
    "XHTML filtering should remove matching elements"
  );
  Assert.ok(
    text.includes("const keep = true;"),
    "XHTML filtering should preserve non-matching elements"
  );
});

add_task(async function test_generic_html_filter_removes_matching_elements() {
  makeEngine({ replaceDirectives: [], htmlFilters: [HTML_SCRIPT_FILTER] });

  const { text } = await fetchDocument("/html");

  Assert.ok(
    !text.includes("<script"),
    "Generic HTML filters should apply to document responses"
  );
  Assert.ok(
    text.includes("<body>ok</body>"),
    "Generic HTML filters should preserve the document body"
  );
});

add_task(async function test_responseheader_filter_removes_header() {
  makeEngine({
    replaceDirectives: [],
    responseHeaderFilters: ["x-adblock-test"],
  });
  const { channel } = await fetchDocument("/header");

  Assert.throws(
    () => channel.getResponseHeader("X-Adblock-Test"),
    /NS_ERROR_NOT_AVAILABLE/,
    "responseheader() filters should remove matching response headers"
  );
});
