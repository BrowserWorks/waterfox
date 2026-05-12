/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toSafeDomain } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "contentBlockingAllowList",
  "@mozilla.org/content-blocking-allow-list;1",
  "nsIContentBlockingAllowList"
);

export const PERMISSION_TYPE = "waterfox-blocker";
export const PERMISSION_TYPE_PB = "waterfox-blocker-pb";

let pbContextObserverRegistered = false;

function maybeRegisterPbContextObserver() {
  if (pbContextObserverRegistered) {
    return;
  }
  Services.obs.addObserver(
    {
      QueryInterface: ChromeUtils.generateQI([
        "nsIObserver",
        "nsISupportsWeakReference",
      ]),
      observe(subject, topic) {
        if (topic === "last-pb-context-exited") {
          Services.perms.removeByType(PERMISSION_TYPE_PB);
        }
      },
    },
    "last-pb-context-exited",
    true
  );
  pbContextObserverRegistered = true;
}

function principalForDomain(domain) {
  const host = toSafeDomain(domain).replace(/\.$/, "");
  if (!host) {
    return null;
  }

  try {
    const uri = Services.io.newURI(`https://${host}`);
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      uri,
      {}
    );
    return lazy.contentBlockingAllowList.computeContentBlockingAllowListPrincipal(
      principal
    );
  } catch (_) {
    // Hostnames that fail URI parsing or principal creation (e.g. IP literals
    // without brackets, invalid characters) cannot be stored as exceptions.
    return null;
  }
}

export class SiteExceptionsState {
  addPermanentSiteException(domain) {
    const principal = principalForDomain(domain);
    if (!principal) {
      return;
    }

    maybeRegisterPbContextObserver();
    Services.perms.addFromPrincipal(
      principal,
      PERMISSION_TYPE,
      Services.perms.ALLOW_ACTION,
      Services.perms.EXPIRE_NEVER
    );
  }

  allowSiteForSession(domain) {
    const principal = principalForDomain(domain);
    if (!principal) {
      return;
    }

    maybeRegisterPbContextObserver();
    Services.perms.addFromPrincipal(
      principal,
      PERMISSION_TYPE,
      Services.perms.ALLOW_ACTION,
      Services.perms.EXPIRE_SESSION
    );
  }

  removePermanentSiteException(domain) {
    const principal = principalForDomain(domain);
    if (!principal) {
      return;
    }
    Services.perms.removeFromPrincipal(principal, PERMISSION_TYPE);
  }

  isSiteExcepted(domain) {
    const principal = principalForDomain(domain);
    if (!principal) {
      return false;
    }

    const ALLOW = Services.perms.ALLOW_ACTION;
    return (
      Services.perms.testPermissionFromPrincipal(principal, PERMISSION_TYPE) ===
        ALLOW ||
      Services.perms.testPermissionFromPrincipal(
        principal,
        PERMISSION_TYPE_PB
      ) === ALLOW
    );
  }
}
