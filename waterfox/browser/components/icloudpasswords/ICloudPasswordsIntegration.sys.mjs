/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export const ICloudPasswordsIntegration = {
  _initialized: false,

  init() {
    if (this._initialized) {
      return;
    }
    ChromeUtils.importESModule(
      "resource://gre/modules/ActorManagerParent.sys.mjs"
    );
    ChromeUtils.unregisterWindowActor("LoginManager");
    ChromeUtils.registerWindowActor("LoginManager", {
      parent: {
        esModuleURI: "resource:///modules/ICloudLoginManagerParent.sys.mjs",
      },
      child: {
        esModuleURI: "resource:///modules/ICloudLoginManagerChild.sys.mjs",
        events: {
          "form-submission-detected": { createActor: false },
          "before-form-submission": { createActor: false },
          DOMFormHasPassword: {},
          DOMPossibleUsernameInputAdded: {},
          DOMInputPasswordAdded: {},
          focusin: { capture: true, mozSystemGroup: true },
        },
      },
      allFrames: true,
      messageManagerGroups: [
        "browsers",
        "webext-browsers",
        "chatbot-browser",
        "",
      ],
    });
    this._initialized = true;
  },
};
