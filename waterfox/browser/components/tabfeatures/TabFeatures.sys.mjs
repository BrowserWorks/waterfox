/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  StyleSheetUtils: "resource:///modules/StyleSheetUtils.sys.mjs",
});

const CSS_URI = "chrome://browser/content/waterfox/tabfeatures/tabfeatures.css";

export const TabFeatures = {
  _initialized: false,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    lazy.StyleSheetUtils.registerStylesheet(
      CSS_URI,
      Ci.nsIStyleSheetService.AUTHOR_SHEET
    );
  },
};
