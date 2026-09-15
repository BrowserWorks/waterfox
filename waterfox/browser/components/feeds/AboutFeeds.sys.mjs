/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PAGE_URL = "chrome://browser/content/feeds/feeds.html";

/** An about module that never grants system privileges to the feed UI. */
export class AboutFeeds {
  classID = Components.ID("{5e16de74-e86c-4cb7-a6b1-58333af71cb7}");
  QueryInterface = ChromeUtils.generateQI(["nsIAboutModule"]);

  newChannel(uri, loadInfo) {
    const channel = Services.io.newChannelFromURIWithLoadInfo(
      this.getChromeURI(),
      loadInfo
    );
    channel.originalURI = uri;
    // The safe-about protocol derives a content principal from originalURI.
    channel.owner = null;
    return channel;
  }

  getURIFlags() {
    return (
      Ci.nsIAboutModule.URI_SAFE_FOR_UNTRUSTED_CONTENT |
      Ci.nsIAboutModule.URI_MUST_LOAD_IN_CHILD |
      Ci.nsIAboutModule.URI_CAN_LOAD_IN_PRIVILEGEDABOUT_PROCESS |
      Ci.nsIAboutModule.ALLOW_SCRIPT
    );
  }

  getChromeURI() {
    return Services.io.newURI(PAGE_URL);
  }
}
