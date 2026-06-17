/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global pref */

// Packaged builds are updated by the system package manager, so the in-app
// updater is disabled here.
pref("dom.ipc.forkserver.enable", true);
pref("app.update.enabled", false);
pref("distribution.id", "waterfox");
pref("distribution.version", "1.0");
pref("distribution.about", "Waterfox Linux Package");
