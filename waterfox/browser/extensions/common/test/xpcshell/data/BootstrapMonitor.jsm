/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

var EXPORTED_SYMBOLS = ["monitor"];

function notify(event, originalMethod, data, reason) {
  let info = {
    event,
    data: Object.assign({}, data, {
      resourceURI: data.resourceURI.spec,
    }),
    reason,
  };

  let subject = { wrappedJSObject: { data } };

  Services.obs.notifyObservers(
    subject,
    "bootstrapmonitor-event",
    JSON.stringify(info)
  );

  // If the bootstrap scope already declares a method call it
  if (originalMethod) {
    originalMethod(data, reason);
  }
}

// Allows a simple one-line bootstrap script:
// Components.utils.import("resource://xpcshelldata/bootstrapmonitor.jsm").monitor(this);
var monitor = function(
  scope,
  methods = ["install", "startup", "shutdown", "uninstall"]
) {
  for (let event of methods) {
    scope[event] = notify.bind(null, event, scope[event]);
  }
};
