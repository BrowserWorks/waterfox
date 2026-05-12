/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * JSWindowActor child for about:contentblocked. Forwards "Load anyway"
 * clicks to the parent, which grants a permission for the session before
 * the page navigates to the URL that was originally blocked.
 */
export class WaterfoxBlockedPageChild extends JSWindowActorChild {
  handleEvent(event) {
    if (event.type !== "click") {
      return;
    }

    const target = event.originalTarget;
    if (!target || target.id !== "load-anyway") {
      return;
    }

    const blockedUrl = this._parseBlockedUrl();
    if (!blockedUrl) {
      return;
    }

    this.sendQuery("WaterfoxBlockedPage:AllowAndNavigate", {
      url: blockedUrl,
    })
      .then(ok => {
        if (!ok) {
          return;
        }

        const win = this.contentWindow;
        if (win) {
          win.location.assign(blockedUrl);
        }
      })
      .catch(err => {
        console.error(
          "[WaterfoxBlockedPageChild] AllowAndNavigate failed:",
          err
        );
      });
  }

  _parseBlockedUrl() {
    const documentUri = this.document?.documentURI || "";
    const queryIndex = documentUri.indexOf("?");
    if (queryIndex < 0) {
      return "";
    }

    const params = new URLSearchParams(documentUri.slice(queryIndex + 1));
    const url = params.get("url") || "";
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return "";
    }

    return url;
  }
}
