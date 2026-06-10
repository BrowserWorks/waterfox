/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { WaterfoxBlockerService } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerService.sys.mjs"
);

const BROWSER_ID = 8675309;
const BLOCKED_URL = "https://blocked.example/path";
const BLOCKED_HOST = "blocked.example";
const UNRELATED_URL = "https://victim.example/";
const UNRELATED_HOST = "victim.example";

let originalSiteExceptionsState;

function makeSiteExceptionsState() {
  const allowed = new Set();
  return {
    allowSiteForSession(domain) {
      allowed.add(String(domain || "").replace(/\.$/, ""));
    },

    isSiteExcepted(domain) {
      return allowed.has(String(domain || "").replace(/\.$/, ""));
    },
  };
}

function allowIfRecorded(browserId, url) {
  const hostname = new URL(url).hostname;
  if (!WaterfoxBlockerService.wasHostBlockedFor(browserId, hostname, url)) {
    return false;
  }

  WaterfoxBlockerService.allowSiteForSession(hostname);
  return true;
}

add_setup(function setup() {
  originalSiteExceptionsState = WaterfoxBlockerService._siteExceptionsState;
  registerCleanupFunction(() => {
    WaterfoxBlockerService._clearTopLevelNavigationState();
    WaterfoxBlockerService._siteExceptionsState = originalSiteExceptionsState;
  });
});

add_task(function test_session_bypass_requires_recorded_blocked_host() {
  WaterfoxBlockerService._clearTopLevelNavigationState();
  WaterfoxBlockerService._siteExceptionsState = makeSiteExceptionsState();

  WaterfoxBlockerService._rememberBlockedTopLevelDocument(
    BROWSER_ID,
    BLOCKED_HOST,
    BLOCKED_URL
  );

  Assert.equal(
    allowIfRecorded(BROWSER_ID, UNRELATED_URL),
    false,
    "A forged blocked page for an unrelated host should not be allowed"
  );
  Assert.equal(
    WaterfoxBlockerService.shouldBypassBlocking(UNRELATED_HOST),
    false,
    "The unrelated host should not receive a session bypass"
  );
  Assert.equal(
    WaterfoxBlockerService.shouldBypassBlocking(BLOCKED_HOST),
    false,
    "A mismatched validation should consume the recorded block without granting"
  );

  WaterfoxBlockerService._rememberBlockedTopLevelDocument(
    BROWSER_ID,
    BLOCKED_HOST,
    BLOCKED_URL
  );

  Assert.equal(
    allowIfRecorded(BROWSER_ID, BLOCKED_URL),
    true,
    "The recorded blocked host should be allowed"
  );
  Assert.equal(
    WaterfoxBlockerService.shouldBypassBlocking(BLOCKED_HOST),
    true,
    "The recorded host should receive a session bypass"
  );
  Assert.equal(
    WaterfoxBlockerService.shouldBypassBlocking(UNRELATED_HOST),
    false,
    "The bypass should not apply to other hosts"
  );
  Assert.equal(
    allowIfRecorded(BROWSER_ID, BLOCKED_URL),
    false,
    "The recorded blocked document should be consumed after validation"
  );
});
