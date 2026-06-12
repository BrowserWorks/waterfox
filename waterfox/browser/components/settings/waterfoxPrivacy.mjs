/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";

const UNCOMMON_DOWNLOADS_PREF =
  "browser.safebrowsing.downloads.remote.block_uncommon";

// Waterfox ships Safe Browsing off by policy, so the security status card must
// not warn about it. Only warn when the user has explicitly turned a Safe
// Browsing pref off, and map the uncommon download warning to its own pref
// rather than reusing the unwanted download pref as Mozilla does.
function isUserDisabled(pref) {
  return pref && !pref.value && pref.hasUserValue && !pref.locked;
}

function wrapSafeBrowsingWarning(config) {
  if (config._waterfoxSafeBrowsing || !config.prefMapping) {
    return;
  }
  config._waterfoxSafeBrowsing = true;
  config.prefMapping.uncommonDownloads = UNCOMMON_DOWNLOADS_PREF;
  config.problematic = ({
    malware,
    phishing,
    downloads,
    unwantedDownloads,
    uncommonDownloads,
  }) =>
    [malware, phishing, downloads, unwantedDownloads, uncommonDownloads].some(
      isUserDisabled
    );
}

const existingWarning = Preferences.getSetting("warningSafeBrowsing");
if (existingWarning) {
  wrapSafeBrowsingWarning(existingWarning.config);
}

const origAddSetting = Preferences.addSetting.bind(Preferences);
Preferences.addSetting = config => {
  if (
    config.id === "warningSafeBrowsing" &&
    !Preferences.getSetting("warningSafeBrowsing")
  ) {
    wrapSafeBrowsingWarning(config);
  }
  return origAddSetting(config);
};
