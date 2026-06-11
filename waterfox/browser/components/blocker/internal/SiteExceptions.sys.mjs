/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toSafeDomain } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

function contentBlockingAllowList() {
  return Cc["@mozilla.org/content-blocking-allow-list;1"].getService(
    Ci.nsIContentBlockingAllowList
  );
}

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
    return contentBlockingAllowList().computeContentBlockingAllowListPrincipal(
      principal
    );
  } catch (_) {
    // Hostnames that fail URI parsing or principal creation (e.g. IP literals
    // without brackets, invalid characters) cannot be stored as exceptions.
    return null;
  }
}

function isPrivateExceptionContext(options = {}) {
  if (typeof options === "boolean") {
    return options;
  }
  if (!options || typeof options !== "object") {
    return false;
  }
  return !!options.isPrivate;
}

/**
 * Stores blocker site exceptions as waterfox-blocker permissions. Permanent
 * user exceptions use the normal type; private "load anyway" choices use a
 * private-session type that is cleared when the private session ends.
 */
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

  allowSiteForSession(domain, options = {}) {
    const principal = principalForDomain(domain);
    if (!principal) {
      return;
    }

    maybeRegisterPbContextObserver();
    Services.perms.addFromPrincipal(
      principal,
      isPrivateExceptionContext(options) ? PERMISSION_TYPE_PB : PERMISSION_TYPE,
      Services.perms.ALLOW_ACTION,
      Services.perms.EXPIRE_SESSION
    );
  }

  removeSiteException(domain, options = {}) {
    const principal = principalForDomain(domain);
    if (!principal) {
      return;
    }

    Services.perms.removeFromPrincipal(
      principal,
      isPrivateExceptionContext(options) ? PERMISSION_TYPE_PB : PERMISSION_TYPE
    );
  }

  countPermanentSiteExceptions() {
    try {
      return Services.perms.getAllByTypes([PERMISSION_TYPE]).length;
    } catch (_) {
      return 0;
    }
  }

  isSiteExcepted(domain, options = {}) {
    const principal = principalForDomain(domain);
    if (!principal) {
      return false;
    }

    const permissionType = isPrivateExceptionContext(options)
      ? PERMISSION_TYPE_PB
      : PERMISSION_TYPE;
    return (
      Services.perms.testPermissionFromPrincipal(principal, permissionType) ===
      Services.perms.ALLOW_ACTION
    );
  }
}
