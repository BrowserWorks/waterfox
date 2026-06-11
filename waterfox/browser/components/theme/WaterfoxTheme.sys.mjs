/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const CUSTOMIZATIONS_PREF = "browser.theme.enableWaterfoxCustomizations";
const ACTIVE_THEME_PREF = "extensions.activeThemeID";

const STOCK_THEMES = [
  "default-theme@mozilla.org",
  "firefox-compact-light@mozilla.org",
  "firefox-compact-dark@mozilla.org",
  "firefox-alpenglow@mozilla.org",
];

const USERCHROME_URI = "chrome://browser/skin/userChrome.css";

export const WaterfoxTheme = {
  stylesEnabled: false,
  _initialized: false,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    Services.prefs.addObserver(CUSTOMIZATIONS_PREF, this);
    Services.prefs.addObserver(ACTIVE_THEME_PREF, this);
    Services.obs.addObserver(this, "chrome-document-loaded");
    this.update();
  },

  observe(subject, topic) {
    switch (topic) {
      case "nsPref:changed":
        this.update();
        break;
      case "chrome-document-loaded": {
        const win = subject.defaultView;
        if (this.stylesEnabled && win?.windowUtils) {
          try {
            win.windowUtils.loadSheetUsingURIString(
              USERCHROME_URI,
              Ci.nsIStyleSheetService.USER_SHEET
            );
          } catch (_e) {}
        }
        break;
      }
    }
  },

  shouldLoad() {
    const mode = Services.prefs.getIntPref(CUSTOMIZATIONS_PREF, 1);
    if (mode === 0) {
      return true;
    }
    if (mode !== 1) {
      return false;
    }
    const active =
      Services.prefs.getStringPref(ACTIVE_THEME_PREF, "") || STOCK_THEMES[0];
    return STOCK_THEMES.includes(active);
  },

  update() {
    if (this.shouldLoad()) {
      this.load();
    } else {
      this.unload();
    }
  },

  load() {
    if (this.stylesEnabled) {
      return;
    }
    this._forEachChromeWindow(win => {
      win.windowUtils.loadSheetUsingURIString(
        USERCHROME_URI,
        Ci.nsIStyleSheetService.USER_SHEET
      );
    });
    this.stylesEnabled = true;
  },

  unload() {
    if (!this.stylesEnabled) {
      return;
    }
    this._forEachChromeWindow(win => {
      win.windowUtils.removeSheetUsingURIString(
        USERCHROME_URI,
        Ci.nsIStyleSheetService.USER_SHEET
      );
    });
    this.stylesEnabled = false;
  },

  _forEachChromeWindow(callback) {
    for (const win of Services.wm.getEnumerator(null)) {
      try {
        callback(win);
      } catch (_e) {}
    }
  },
};
