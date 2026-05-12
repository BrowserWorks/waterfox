/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WaterfoxBlockerService } from "resource:///modules/WaterfoxBlockerService.sys.mjs";

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

    WaterfoxBlockerService.allowSiteForSession(hostname);
    return true;
  }
}
