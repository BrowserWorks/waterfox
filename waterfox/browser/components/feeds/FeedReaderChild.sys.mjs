/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FeedReader } from "resource:///modules/FeedReader.sys.mjs";
import { isFeedReaderURL } from "resource:///modules/FeedConstants.sys.mjs";

/** Renders cached feed content without invoking ordinary Reader navigation. */
export class FeedReaderChild extends JSWindowActorChild {
  receiveMessage(message) {
    this._reader?.receiveMessage(message);
  }

  handleEvent(event) {
    if (!isFeedReaderURL(this.document.documentURI)) {
      return;
    }
    if (event.type === "DOMContentLoaded" || event.type === "pageshow") {
      if (
        event.originalTarget.defaultView !== this.contentWindow ||
        (event.type === "pageshow" && !event.persisted) ||
        this._reader
      ) {
        return;
      }
      this._reader = new FeedReader(
        this,
        this.sendQuery("FeedReader:GetArticle")
      );
    } else if (event.type === "click" || event.type === "auxclick") {
      const link = event.target.closest?.("a[href]");
      if (!link) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (
        event.isTrusted &&
        ((event.type === "click" && event.button === 0) ||
          (event.type === "auxclick" && event.button === 1))
      ) {
        this.sendAsyncMessage("FeedReader:OpenLink", { url: link.href });
      }
    }
  }

  readerModeHidden() {
    this._reader?.clearActor();
    this._reader = null;
  }

  didDestroy() {
    this.readerModeHidden();
  }
}
