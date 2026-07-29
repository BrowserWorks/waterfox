/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "styleSheetService", () =>
  Cc["@mozilla.org/content/style-sheet-service;1"].getService(
    Ci.nsIStyleSheetService
  )
);

export const StyleSheetUtils = {
  registerStylesheet(uri, type = Ci.nsIStyleSheetService.USER_SHEET) {
    if (this.sheetRegistered(uri, type)) {
      return;
    }
    lazy.styleSheetService.loadAndRegisterSheet(Services.io.newURI(uri), type);
  },

  unregisterStylesheet(uri, type = Ci.nsIStyleSheetService.USER_SHEET) {
    if (!this.sheetRegistered(uri, type)) {
      return;
    }
    lazy.styleSheetService.unregisterSheet(Services.io.newURI(uri), type);
  },

  sheetRegistered(uri, type = Ci.nsIStyleSheetService.USER_SHEET) {
    return lazy.styleSheetService.sheetRegistered(
      Services.io.newURI(uri),
      type
    );
  },
};
