/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const ABOUT_CFG_URL = "chrome://browser/content/aboutcfg/aboutcfg.xhtml";
const ABOUT_CONFIG_ENABLED_PREF = "general.aboutConfig.enable";

/** About module for the classic config page. */
export class AboutCfg {
  classID = Components.ID("{e6b520c6-5159-47ad-b2fc-87436ab66f53}");
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    if (!Services.prefs.getBoolPref(ABOUT_CONFIG_ENABLED_PREF, true)) {
      throw Components.Exception("", Cr.NS_ERROR_NOT_AVAILABLE);
    }

    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(ABOUT_CFG_URL),
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
    return Services.io.newURI(ABOUT_CFG_URL);
  }
}
