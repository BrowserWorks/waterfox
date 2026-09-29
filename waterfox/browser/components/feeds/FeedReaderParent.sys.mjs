/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { FeedReaderBridge } from "resource:///modules/FeedReaderBridge.sys.mjs";

/** Mediates cached articles and link opening through the feed security boundary. */
export class FeedReaderParent extends JSWindowActorParent {
  receiveMessage({ name, data }) {
    switch (name) {
      case "FeedReader:GetArticle": {
        const article = FeedReaderBridge.getArticle(this);
        if (!article) {
          return article;
        }
        if (!this._themeWindow) {
          this._themeWindow =
            this.browsingContext.top.embedderElement.documentGlobal;
          this._themeWindow.addEventListener("windowlwthemeupdate", this);
        }
        this._updateColorScheme();
        return article;
      }
      case "FeedReader:OpenLink":
        FeedReaderBridge.openLink(this, data?.url);
        break;
    }
    return undefined;
  }

  handleEvent() {
    this._updateColorScheme();
  }

  _updateColorScheme() {
    const win = this._themeWindow;
    let colorScheme = win.browsingContext.prefersColorSchemeOverride;
    if (colorScheme === "none") {
      colorScheme = win.matchMedia("(-moz-system-dark-theme)").matches
        ? "dark"
        : "light";
    }
    this.sendAsyncMessage("FeedReader:ColorScheme", { colorScheme });
  }

  didDestroy() {
    this._themeWindow?.removeEventListener("windowlwthemeupdate", this);
    this._themeWindow = null;
    FeedReaderBridge.release(this);
  }
}
