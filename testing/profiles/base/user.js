/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// This is useful for testing a pref on try.
/* globals user_pref */
// ensure webrender is set (and we don't need MOZ_WEBRENDER env variable)
user_pref("gfx.webrender.all", true);

// ensure WebGL is allowed in the parent process for no e10s/GPU process tests
user_pref("webgl.allow-in-parent", true);

user_pref("dom.input_events.security.minNumTicks", 0);
user_pref("dom.input_events.security.minTimeElapsedInMS", 0);

// Set address autofill to true for tests
user_pref("extensions.formautofill.addresses.experiments.enabled", true);

// Turn off update
user_pref("app.update.disabledForTesting", true);

// Browser restarts can cause the session restore suggestion to be shown when reusing a
// profile across a set of tests. Avoid showing this infobar by default.
user_pref("browser.startup.couldRestoreSession.count", -1);

// This is used to disable address autofill telemetry since we cannot download
// the model within tests.
user_pref("extensions.formautofill.useml", false);

// Waterfox turns on features that reach the network at startup, which trip the
// non-local connection guard and fatal tests. Turn Ultra DNS off and clear its
// Oblivious HTTP endpoints so nothing is fetched at startup, and leave the
// blocker off so it does not pull filter lists. Suites that exercise these
// features turn them back on themselves with local endpoints.
user_pref("network.trr.mode", 5);
user_pref("network.trr.use_ohttp", false);
user_pref("network.trr.ohttp.config_uri", "");
user_pref("network.trr.ohttp.uri", "");
user_pref("network.trr.ohttp.relay_uri", "");
user_pref("waterfox.blocker.enabled", false);
