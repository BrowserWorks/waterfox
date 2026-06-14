/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const ABOUT_PASSWORDS_URL =
  "chrome://browser/content/aboutpasswords/passwordManager.xhtml";

/** About module for the classic password manager. */
export class AboutPasswords {
  classID = Components.ID("{3ea8f6c7-b426-4ac2-8d87-c04b58f13d0c}");
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(ABOUT_PASSWORDS_URL),
      loadInfo
    );
    channel.originalURI = uri;
    channel.owner = Services.scriptSecurityManager.getSystemPrincipal();
    return channel;
  }

  getURIFlags() {
    return (
      Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI
    );
  }

  getChromeURI() {
    return Services.io.newURI(ABOUT_PASSWORDS_URL);
  }
}
