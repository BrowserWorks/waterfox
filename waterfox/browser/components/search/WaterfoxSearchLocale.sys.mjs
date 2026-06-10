/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  Region: "resource://gre/modules/Region.sys.mjs",
});

const LOCALE_PARAM_PREF = "browser.search.param.waterfox_locale";

export const WaterfoxSearchLocale = {
  _initialized: false,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    Services.obs.addObserver(this, lazy.Region.REGION_TOPIC);
    Services.obs.addObserver(this, "intl:app-locales-changed");
    this._update();
  },

  observe() {
    this._update();
  },

  _update() {
    const language = Services.locale.appLocaleAsBCP47.split("-")[0];
    const region = lazy.Region.home;
    if (!language || !region) {
      return;
    }
    Services.prefs
      .getDefaultBranch("")
      .setCharPref(LOCALE_PARAM_PREF, `${language}_${region.toUpperCase()}`);
  },
};
