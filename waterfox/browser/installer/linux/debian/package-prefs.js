/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Package defaults for Waterfox (Debian repackaging).
 * This file is installed into defaults/pref/package-prefs.js by the repackager.
 *
 * These preferences are intended for distribution-level defaults, not user
 * settings. They can be overridden by user prefs in profiles.
 */

/* Improve startup performance on multi-process by enabling the forkserver. */
pref("dom.ipc.forkserver.enable", true);

/* Disable in-app updates when installed via system packages. */
pref("app.update.enabled", false);
pref("app.update.auto", false);
pref("app.update.autoInstallEnabled", false);
pref("app.update.staging.enabled", false);
pref("app.update.background.enabled", false);

/* Optional distribution identifiers to help diagnostics. */
pref("distribution.id", "waterfox-debian");
pref("distribution.version", "1");
pref("distribution.about", "Waterfox packaged for Debian");
