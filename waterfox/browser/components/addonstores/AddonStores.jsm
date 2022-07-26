/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const CRX_CONTENT_TYPE = "application/x-chrome-extension";

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

ChromeUtils.defineModuleGetter(
  this,
  "StoreHandler",
  "resource:///modules/StoreHandler.jsm"
);

function ExtensionCompatibilityHandler() {}

ExtensionCompatibilityHandler.prototype = {
  /**
   * Handles a new request for an application/x-xpinstall file.
   *
   * @param  aMimetype
   *         The mimetype of the file
   * @param  aContext
   *         The context passed to nsIChannel.asyncOpen
   * @param  aRequest
   *         The nsIRequest dealing with the content
   */
  async handleContent(aMimetype, aContext, aRequest) {
    let uri = aRequest.URI;
    if (aMimetype == CRX_CONTENT_TYPE) {
      // attempt install
      try {
        return new StoreHandler().attemptInstall(uri);
      } catch (ex) {
        this.log(ex);
      }
    }
    return undefined;
  },

  classID: Components.ID("{478ebd10-5998-11eb-be34-0800200c9a66}"),
  QueryInterface: ChromeUtils.generateQI([Ci.nsIContentHandler]),

  log(aMsg) {
    let msg = "addon_stores.js: " + (aMsg.join ? aMsg.join("") : aMsg);
    Services.console.logStringMessage(msg);
    dump(msg + "\n");
  },
};

var EXPORTED_SYMBOLS = ["ExtensionCompatibilityHandler"];
