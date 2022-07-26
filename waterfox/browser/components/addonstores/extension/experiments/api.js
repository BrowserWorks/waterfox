/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* globals browser, AppConstants, Services, ExtensionAPI, ExtensionCommon */

"use strict";

const { StoreHandler } = ChromeUtils.import(
  "resource:///modules/StoreHandler.jsm"
);

this.total = class extends ExtensionAPI {
  getAPI(context) {
    let EventManager = ExtensionCommon.EventManager;

    return {
      wf: {
        onCrxInstall: new EventManager({
          context,
          name: "wf.onCrxInstall",
          register: fire => {
            let observer = (subject, topic, data) => {
              fire.sync(data);
            };
            Services.obs.addObserver(observer, "waterfox-test-stores");
            return () => {
              Services.obs.removeObserver(observer, "waterfox-test-stores");
            };
          },
        }).api(),

        attemptInstallChromeExtension(uri) {
          try {
            new StoreHandler().attemptInstall({ spec: uri });
          } catch (ex) {
            Cu.reportError(ex);
          }
        },
      },
    };
  }
};
