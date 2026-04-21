/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const registrar = Components.manager.QueryInterface(Ci.nsIComponentRegistrar);

function generateFreeCID() {
  let uuid = Components.ID(Services.uuid.generateUUID().toString());
  while (registrar.isCIDRegistered(uuid)) {
    uuid = Components.ID(Services.uuid.generateUUID().toString());
  }
  return uuid;
}

function AboutPage(pageInfo) {
  this.pageInfo = pageInfo;
}

AboutPage.prototype = {
  get uri() {
    if (!this._uri) {
      this._uri = Services.io.newURI(this.pageInfo.chrome);
    }
    return this._uri;
  },
  newChannel(_uri, loadInfo) {
    const ch = Services.io.newChannelFromURIWithLoadInfo(this.uri, loadInfo);
    ch.owner = Services.scriptSecurityManager.getSystemPrincipal();
    return ch;
  },
  getURIFlags(_uri) {
    return (
      Ci.nsIAboutModule.ALLOW_SCRIPT | Ci.nsIAboutModule.IS_SECURE_CHROME_UI
    );
  },
  getChromeURI(_uri) {
    return this.uri;
  },
  QueryInterface: ChromeUtils.generateQI(["nsIAboutModule"]),
};

// Define the pages to register
const ABOUT_PAGES = [
  {
    about: "cfg",
    chrome: "chrome://browser/content/aboutcfg/aboutcfg.xhtml",
    contract: "@mozilla.org/network/protocol/about;1?what=cfg",
  },
  {
    about: "passwords",
    chrome: "chrome://browser/content/passwordManager.xhtml",
    contract: "@mozilla.org/network/protocol/about;1?what=passwords",
  },
  {
    about: "adblocker",
    chrome: "chrome://browser/content/blocker/aboutAdblocker.xhtml",
    contract: "@mozilla.org/network/protocol/about;1?what=adblocker",
  },
];

export const AboutPages = {
  init() {
    for (const pageInfo of ABOUT_PAGES) {
      const AboutModuleFactory = {
        createInstance(aIID) {
          return new AboutPage(pageInfo).QueryInterface(aIID);
        },
        QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
      };

      registrar.registerFactory(
        generateFreeCID(),
        `about:${pageInfo.about}`,
        pageInfo.contract,
        AboutModuleFactory
      );
    }
  },
};
