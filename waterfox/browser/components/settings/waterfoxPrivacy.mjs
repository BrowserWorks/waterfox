/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

const WEBRTC_PREF = "media.peerconnection.enabled";
const REFERRER_PREF = "network.http.sendRefererHeader";
const LOAD_IMAGES_PREF = "permissions.default.image";
const JAVASCRIPT_PREF = "javascript.enabled";
const CONTROLLING_EXTENSION_L10N_ID = "waterfox-extension-controlling-setting";
const UNCOMMON_DOWNLOADS_PREF =
  "browser.safebrowsing.downloads.remote.block_uncommon";

Preferences.addAll([
  { id: WEBRTC_PREF, type: "bool" },
  { id: REFERRER_PREF, type: "int" },
  { id: LOAD_IMAGES_PREF, type: "int" },
  { id: JAVASCRIPT_PREF, type: "bool" },
]);

Preferences.addSetting({
  id: "waterfox-webrtc-peer-connection",
  pref: WEBRTC_PREF,
  controllingExtensionInfo: {
    storeId: "network.peerConnectionEnabled",
    l10nId: CONTROLLING_EXTENSION_L10N_ID,
  },
});

Preferences.addSetting({
  id: "waterfox-referrer-header-policy",
  pref: REFERRER_PREF,
  controllingExtensionInfo: {
    storeId: "websites.referrersEnabled",
    l10nId: CONTROLLING_EXTENSION_L10N_ID,
  },
});

Preferences.addSetting({
  id: "waterfox-load-images",
  pref: LOAD_IMAGES_PREF,
  get: value => value != Ci.nsIPermissionManager.DENY_ACTION,
  set: value =>
    value
      ? Ci.nsIPermissionManager.ALLOW_ACTION
      : Ci.nsIPermissionManager.DENY_ACTION,
});

Preferences.addSetting({
  id: "waterfox-enable-javascript",
  pref: JAVASCRIPT_PREF,
});

SettingGroupManager.registerGroups({
  waterfoxAdvancedWebPrivacy: {
    l10nId: "waterfox-advanced-web-privacy-group",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-webrtc-peer-connection",
        l10nId: "enable-webrtc-p2p",
        control: "moz-toggle",
      },
      {
        id: "waterfox-referrer-header-policy",
        l10nId: "waterfox-referrer-header-policy",
        control: "moz-select",
        options: [
          { value: 0, l10nId: "send-referrer-header-0" },
          { value: 1, l10nId: "send-referrer-header-1" },
          { value: 2, l10nId: "send-referrer-header-2" },
        ],
      },
    ],
  },
  waterfoxWebContent: {
    l10nId: "waterfox-web-content-group",
    headingLevel: 2,
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-load-images",
        l10nId: "load-images",
        control: "moz-checkbox",
      },
      {
        id: "waterfox-enable-javascript",
        l10nId: "enable-javascript",
        control: "moz-checkbox",
      },
    ],
  },
});

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
