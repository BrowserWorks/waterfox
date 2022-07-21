/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["WaterfoxGlue"];

const { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

XPCOMUtils.defineLazyModuleGetters(this, {
  ChromeManifest: "resource:///modules/ChromeManifest.jsm",
  Overlays: "resource:///modules/Overlays.jsm",
  PrivateTab: "resource:///modules/PrivateTab.jsm",
  TabFeatures: "resource:///modules/TabFeatures.jsm",
});

XPCOMUtils.defineLazyGlobalGetters(this, ["fetch"]);

const WaterfoxGlue = {
  async init() {
    // Parse chrome.manifest
    this.startupManifest = await this.getChromeManifest("startup");
    this.privateManifest = await this.getChromeManifest("private");

    // Observe chrome-document-loaded topic to detect window open
    Services.obs.addObserver(this, "chrome-document-loaded");
  },

  async getChromeManifest(manifest) {
    let uri;
    let privateWindow = false;
    switch (manifest) {
      case "startup":
        uri = "resource://waterfox/overlays/chrome.manifest";
        break;
      case "private":
        uri = "resource://waterfox/overlays/chrome.manifest";
        privateWindow = true;
        break;
    }
    let chromeManifest = new ChromeManifest(async () => {
      let res = await fetch(uri);
      let text = await res.text();
      if (privateWindow) {
        let tArr = text.split("\n");
        let indexPrivate = tArr.findIndex(overlay =>
          overlay.includes("private")
        );
        tArr.splice(indexPrivate, 1);
        text = tArr.join("\n");
      }
      return text;
      // return res.text();
    }, this.options);
    await chromeManifest.parse();
    return chromeManifest;
  },

  options: {
    application: Services.appinfo.ID,
    appversion: Services.appinfo.version,
    platformversion: Services.appinfo.platformVersion,
    os: Services.appinfo.OS,
    osversion: Services.sysinfo.getProperty("version"),
    abi: Services.appinfo.XPCOMABI,
  },

  async observe(subject, topic, data) {
    switch (topic) {
      case "chrome-document-loaded":
        // Only load overlays in new browser windows
        // baseURI for about:blank is also browser.xhtml, so use URL
        if (subject.URL.includes("browser.xhtml")) {
          const window = subject.defaultView;
          // Do not load non-private overlays in private window
          if (window.PrivateBrowsingUtils.isWindowPrivate(window)) {
            Overlays.load(this.privateManifest, window);
          } else {
            Overlays.load(this.startupManifest, window);
            // Only load in non-private browser windows
            PrivateTab.init(window);
          }
          // Load in all browser windows (private and normal)
          TabFeatures.init(window);
        }
        break;
    }
  },
};
