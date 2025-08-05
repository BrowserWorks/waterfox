/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
/* Original: https://github.com/mozilla-extensions/webcompat-addon/blob/main/src/experiment-apis/aboutConfigPrefs.js */
'use strict';

const AboutPreferencesWatcher = {
  BASE_URL: null, // this need to be replaced with "moz-extension://..../"
  BASE_PREF: 'browser.sidebar.', // null,

  onPrefChanged(name) {
    switch (name) {
      case 'browser.tabs.selectOwnerOnClose':
        Services.prefs.setBoolPref(`${this.BASE_PREF}simulateSelectOwnerOnClose`, Services.prefs.getBoolPref(name));
        break;

      case 'browser.tabs.loadInBackground':
        Services.prefs.setBoolPref(`${this.BASE_PREF}simulateTabsLoadInBackgroundInverted`, Services.prefs.getBoolPref(name));
        break;

      case 'browser.tabs.warnOnClose':
        Services.prefs.setBoolPref(`${this.BASE_PREF}warnOnCloseTabs`, Services.prefs.getBoolPref(name));
        break;

      case 'browser.tabs.searchclipboardfor.middleclick':
        Services.prefs.setBoolPref(`${this.BASE_PREF}middleClickPasteURLOnNewTabButton`, Services.prefs.getBoolPref(name));
        break;

      case 'browser.tabs.insertAfterCurrent':
      case 'browser.tabs.insertRelatedAfterCurrent': {
        const insertAfterCurrent        = Services.prefs.getBoolPref('browser.tabs.insertAfterCurrent');
        const insertRelatedAfterCurrent = Services.prefs.getBoolPref('browser.tabs.insertRelatedAfterCurrent');
        const useTree = (
          Services.prefs.getBoolPref(`${this.BASE_PREF}autoAttach`, false) &&
          Services.prefs.getBoolPref(`${this.BASE_PREF}syncParentTabAndOpenerTab`, false)
        );
        Services.prefs.setStringPref(`${this.BASE_PREF}autoAttachOnOpenedWithOwner`,
          !useTree ? -1 :
            insertRelatedAfterCurrent ? 5 :
              insertAfterCurrent ? 6 :
                0);
        Services.prefs.setStringPref(`${this.BASE_PREF}insertNewTabFromPinnedTabAt`,
          !useTree ? -1 :
            insertRelatedAfterCurrent ? 3 :
              insertAfterCurrent ? 0 :
                1);
        Services.prefs.setStringPref(`${this.BASE_PREF}insertNewTabFromFirefoxViewAt`,
          !useTree ? -1 :
            insertRelatedAfterCurrent ? 3 :
              insertAfterCurrent ? 0 :
                1);
      }; break;
    }
  },

  // as an XPCOM component...
  classDescription: 'Waterfox Chrome Window Watcher for about:preferences',
  contractID:       '@waterfox.net/chrome-window-watche-about-preferences;1',
  classID:          Components.ID('{c8a990cf-b9a3-4b4c-829c-a1dfc5753527}'),
  QueryInterface:   ChromeUtils.generateQI([
    'nsIObserver',
    'nsISupportsWeakReference',
  ]),

  // nsIObserver
  observe(subject, topic, data) {
    switch (topic) {
      case 'nsPref:changed':
        this.onPrefChanged(data);
        break;
    }
  },

  createInstance(iid) {
    return this.QueryInterface(iid);
  },
};

this.prefs = class extends ExtensionAPI {
  getAPI(context) {
    const EventManager = ExtensionCommon.EventManager;
    const extensionIDBase = context.extension.id.split('@')[0];

    AboutPreferencesWatcher.BASE_URL = context.extension.baseURL;

    // Synchronize simulation configs with the browser's preferences
    for (const [source, dest] of Object.entries({
      'browser.tabs.selectOwnerOnClose': `${AboutPreferencesWatcher.BASE_PREF}simulateSelectOwnerOnClose`,
      'browser.tabs.loadInBackground':   `${AboutPreferencesWatcher.BASE_PREF}simulateTabsLoadInBackgroundInverted`,
      'browser.tabs.warnOnClose':        `${AboutPreferencesWatcher.BASE_PREF}warnOnCloseTabs`,
      'browser.tabs.searchclipboardfor.middleclick': `${AboutPreferencesWatcher.BASE_PREF}middleClickPasteURLOnNewTabButton`,
    })) {
      Services.prefs.setBoolPref(dest, Services.prefs.getBoolPref(source));
    }
    Services.prefs.addObserver('browser.tabs.', AboutPreferencesWatcher);
    AboutPreferencesWatcher.onPrefChanged('browser.tabs.insertAfterCurrent');

    return {
      prefs: {
        onChanged: new EventManager({
          context,
          name: 'prefs.onChanged',
          register: (fire) => {
            const observe = (_subject, _topic, data) => {
              fire.async(data.replace(AboutPreferencesWatcher.BASE_PREF, '')).catch(() => {}); // ignore Message Manager disconnects
            };
            Services.prefs.addObserver(AboutPreferencesWatcher.BASE_PREF, observe);
            return () => {
              Services.prefs.removeObserver(AboutPreferencesWatcher.BASE_PREF, observe);
            };
          },
        }).api(),
        async getBoolValue(name, defaultValue = false) {
          try {
            return Services.prefs.getBoolPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, defaultValue);
          }
          catch(_error) {
            return defaultValue;
          }
        },
        async setBoolValue(name, value) {
          Services.prefs.setBoolPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
        async setDefaultBoolValue(name, value) {
          Services.prefs.getDefaultBranch(null).setBoolPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
        async getStringValue(name, defaultValue = '') {
          try {
            return Services.prefs.getStringPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, defaultValue);
          }
          catch(_error) {
            return defaultValue;
          }
        },
        async setStringValue(name, value) {
          Services.prefs.setStringPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
        async setDefaultStringValue(name, value) {
          Services.prefs.getDefaultBranch(null).setStringPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
        async getIntValue(name, defaultValue = 0) {
          try {
            return Services.prefs.getIntPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, defaultValue);
          }
          catch(_error) {
            return defaultValue;
          }
        },
        async setIntValue(name, value) {
          Services.prefs.setIntPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
        async setDefaultIntValue(name, value) {
          Services.prefs.getDefaultBranch(null).setIntPref(`${AboutPreferencesWatcher.BASE_PREF}${name}`, value);
        },
      },
    };
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown)
      return;

    Services.prefs.removeObserver('browser.tabs.', AboutPreferencesWatcher);
  }
};
