/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const BLOCKED_PAGE_CHROME_URL =
  "chrome://browser/content/blocker/blockedPage.xhtml";

export function WaterfoxBlockedPage() {}

WaterfoxBlockedPage.prototype = {
  classID: Components.ID("{bdaa96fc-7ba3-4957-b6c3-dc5ab112bcc1}"),

  QueryInterface: ChromeUtils.generateQI(["nsIAboutModule"]),

  getURIFlags() {
    return (
      Ci.nsIAboutModule.URI_SAFE_FOR_UNTRUSTED_CONTENT |
      Ci.nsIAboutModule.URI_CAN_LOAD_IN_CHILD |
      Ci.nsIAboutModule.ALLOW_SCRIPT |
      Ci.nsIAboutModule.HIDE_FROM_ABOUTABOUT |
      // Required for top-level navigation redirects (web content → block page);
      // without this, nsScriptSecurityManager refuses with "may not load or link".
      Ci.nsIAboutModule.MAKE_LINKABLE
    );
  },

  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      Services.io.newURI(BLOCKED_PAGE_CHROME_URL),
      loadInfo
    );
    channel.originalURI = uri;
    return channel;
  },
};
