/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// https://github.com/earthlng/aboutconfig/blob/main/aboutcfg.jsm
const registrar = Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);

// generate a unique ID on every app launch. protection against the very unlikely possibility that a
// future update adds a component with the same class ID, which would break the script.
function generateFreeCID() {
  let uuid = Components.ID(Services.uuid.generateUUID().toString());
  // I can't tell whether generateUUID is guaranteed to produce a unique ID, or just a random ID.
  // so I add this loop to regenerate it in the extremely unlikely (or potentially impossible)
  // event that the UUID is already registered as a CID.
  while (registrar.isCIDRegistered(uuid)) {
    uuid = Components.ID(Services.uuid.generateUUID().toString());
  }
  return uuid;
}

function VintageAboutConfig() {}
VintageAboutConfig.prototype = {
  get uri() {
    const urlString = 'chrome://browser/content/aboutcfg/aboutcfg.xhtml';
    return this._uri || (this._uri = Services.io.newURI(urlString));
  },
  newChannel: function (_uri, loadInfo) {
    const ch = Services.io.newChannelFromURIWithLoadInfo(this.uri, loadInfo);
    ch.owner = Services.scriptSecurityManager.getSystemPrincipal();
    return ch;
  },
  getURIFlags: function (_uri) {
    return Components.interfaces.nsIAboutModule.ALLOW_SCRIPT | Components.interfaces.nsIAboutModule.IS_SECURE_CHROME_UI;
  },
  getChromeURI: function (_uri) {
    return this.uri;
  },
  QueryInterface: ChromeUtils.generateQI(['nsIAboutModule']),
};

export const AboutCfg = {
  init() {
    const AboutModuleFactory = {
      createInstance(aIID) {
        return new VintageAboutConfig().QueryInterface(aIID);
      },
      QueryInterface: ChromeUtils.generateQI(['nsIFactory']),
    };

    registrar.registerFactory(
      generateFreeCID(),
      'about:cfg',
      '@mozilla.org/network/protocol/about;1?what=cfg',
      AboutModuleFactory
    );
  }
}
