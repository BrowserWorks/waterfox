/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* Original: https://github.com/mozilla-extensions/webcompat-addon/blob/main/src/experiment-apis/aboutConfigPrefsChild.js */
'use strict';

this.syncPrefs = class extends ExtensionAPI {
  getAPI(context) {
    const extensionIDBase = context.extension.id.split('@')[0];
    const extensionPrefNameBase = `extensions.${extensionIDBase}.`;

    return {
      syncPrefs: {
        getBoolValue(name, defaultValue = false) {
          try {
            return Services.prefs.getBoolPref(`${extensionPrefNameBase}${name}`, defaultValue);
          }
          catch(_error) {
            return defaultValue;
          }
        },
        getStringValue(name, defaultValue = '') {
          try {
            return Services.prefs.getStringPref(`${extensionPrefNameBase}${name}`, defaultValue);
          }
          catch(_error) {
            return defaultValue;
          }
        },
        getIntValue(name, defaultValue = 0) {
          try {
            return Services.prefs.getIntPref(`${extensionPrefNameBase}${name}`, defaultValue);
          }
          catch(_error) {
            return defaultValue;
          }
        },
      },
    };
  }
};
