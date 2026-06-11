/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WaterfoxBlockerService } from "resource:///modules/WaterfoxBlockerService.sys.mjs";
import { isPrivateBrowsingContext } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

const BLOCKED_PAGE_URL = "about:contentblocked";

function isContentBlockedURI(uri) {
  try {
    const spec = String(uri?.spec || "");
    return spec === BLOCKED_PAGE_URL || spec.startsWith(`${BLOCKED_PAGE_URL}?`);
  } catch (_) {
    return false;
  }
}

function isAboutContentPrincipal(principal) {
  try {
    return !!principal?.isContentPrincipal && !!principal.schemeIs?.("about");
  } catch (_) {
    return false;
  }
}

/**
 * JSWindowActor parent for about:contentblocked. On behalf of the child,
 * grants a permission for the session on the host that was originally
 * blocked so the subsequent navigation passes the blocker's bypass check.
 */
export class WaterfoxBlockedPageParent extends JSWindowActorParent {
  receiveMessage(message) {
    if (message.name !== "WaterfoxBlockedPage:AllowAndNavigate") {
      return undefined;
    }

    if (!this._isContentBlockedSender()) {
      return false;
    }

    const url = String(message.data?.url || "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return false;
    }

    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch (_) {
      return false;
    }

    if (!hostname) {
      return false;
    }

    const browserId = this._getTopBrowserId();
    if (!WaterfoxBlockerService.wasHostBlockedFor(browserId, hostname, url)) {
      return false;
    }

    WaterfoxBlockerService.allowSiteForSession(hostname, {
      isPrivate: this._isPrivateContext(),
    });
    return true;
  }

  _isPrivateContext() {
    return isPrivateBrowsingContext(this.browsingContext);
  }

  _getTopBrowserId() {
    try {
      return Number(this.browsingContext?.top?.browserId || 0);
    } catch (_) {
      return 0;
    }
  }

  _isContentBlockedSender() {
    try {
      const browsingContext = this.browsingContext;
      const windowGlobal = browsingContext?.currentWindowGlobal;
      return (
        browsingContext === browsingContext?.top &&
        isContentBlockedURI(windowGlobal?.documentURI) &&
        isAboutContentPrincipal(windowGlobal?.documentPrincipal)
      );
    } catch (_) {
      return false;
    }
  }
}
