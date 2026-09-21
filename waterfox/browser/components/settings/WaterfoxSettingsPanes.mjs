/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SettingPaneManager } from "chrome://browser/content/preferences/config/SettingPaneManager.mjs";

if (Services.prefs.getBoolPref("browser.settings-redesign.enabled", false)) {
  const aboutPane = SettingPaneManager.get("about");
  aboutPane.module =
    "chrome://browser/content/waterfox/settings/waterfoxUpdates.mjs";

  // The search pane keeps its Mozilla module; waterfoxSearch amends its
  // defaultEngine and searchSuggestions groups at runtime, so it only needs
  // to load before that pane.
  ChromeUtils.importESModule(
    "chrome://browser/content/waterfox/settings/waterfoxSearch.mjs",
    { global: "current" }
  );
}
