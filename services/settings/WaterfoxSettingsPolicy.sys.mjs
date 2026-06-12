/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Waterfox keeps Remote Settings offline by default: collections read
// their records from the dumps bundled with the build. Only the
// collections named here may talk to the network, because their data
// goes stale.

// Buckets that sync records and download attachments normally.
const NETWORK_BUCKETS = new Set(["security-state", "blocklists"]);

// Collections in the main bucket that sync records and download
// attachments normally.
const NETWORK_COLLECTIONS = new Set([
  "bounce-tracking-protection-exceptions",
  "fingerprinting-protection-overrides",
  "partitioning-exempt-urls",
  "query-stripping",
  "third-party-cookie-blocking-exempt-urls",
  "tracking-protection-lists",
  "url-classifier-exceptions",
]);

// Collections in the main bucket whose records are dump only but whose
// attachments are too large to bundle and may be downloaded.
const ATTACHMENT_COLLECTIONS = new Set([
  "translations-models-v2",
  "translations-wasm-v2",
]);

// Packaged dump-only collections that active desktop features read at runtime.
const REQUIRED_OFFLINE_DUMPS = Object.freeze([
  ["main", "ai-window-prompts"],
  ["main", "anti-tracking-url-decoration"],
  ["main", "cookie-banner-rules-list"],
  ["main", "devtools-compatibility-browsers"],
  ["main", "devtools-devices"],
  ["main", "doh-config"],
  ["main", "doh-providers"],
  ["main", "hijack-blocklists"],
  ["main", "language-dictionaries"],
  ["main", "moz-essential-domain-fallbacks"],
  ["main", "newtab-wallpapers-v2"],
  ["main", "password-recipes"],
  ["main", "password-rules"],
  ["main", "remote-permissions"],
  ["main", "search-default-override-allowlist"],
  ["main", "search-telemetry-v2"],
  ["main", "sites-classification"],
  ["main", "top-sites"],
  ["main", "translations-models-v2"],
  ["main", "translations-wasm-v2"],
  ["main", "url-parser-default-unknown-schemes-interventions"],
  ["main", "urlbar-persisted-search-terms"],
  ["main", "websites-with-shared-credential-backends"],
]);

function baseBucket(bucketName) {
  // Preview mode appends a suffix to bucket names.
  return bucketName.replace(/-preview$/, "");
}

export const WaterfoxSettingsPolicy = {
  requiredOfflineDumps: REQUIRED_OFFLINE_DUMPS,

  canSync(bucketName, collectionName) {
    const bucket = baseBucket(bucketName);
    return (
      NETWORK_BUCKETS.has(bucket) ||
      (bucket === "main" && NETWORK_COLLECTIONS.has(collectionName))
    );
  },

  canDownloadAttachments(bucketName, collectionName) {
    const bucket = baseBucket(bucketName);
    return (
      this.canSync(bucketName, collectionName) ||
      (bucket === "main" && ATTACHMENT_COLLECTIONS.has(collectionName))
    );
  },
};
