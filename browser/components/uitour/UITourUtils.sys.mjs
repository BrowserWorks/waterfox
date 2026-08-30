/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PREF_TEST_ORIGINS = "browser.uitour.testingOrigins";
const UITOUR_PERMISSION = "uitour";

export let UITourUtils = {
  /**
   * Check if we've got a testing origin.
   *
   * @param {nsIURI} uri
   *    The URI to check
   * @returns {boolean}
   *    Whether or not it's a testing origin.
   */
  isTestingOrigin(uri) {
    let testingOrigins = Services.prefs.getStringPref(PREF_TEST_ORIGINS, "");
    if (!testingOrigins) {
      return false;
    }

    // Allow any testing origins (comma-separated).
    for (let origin of testingOrigins.split(/\s*,\s*/)) {
      try {
        let testingURI = Services.io.newURI(origin);
        if (uri.prePath == testingURI.prePath) {
          return true;
        }
      } catch (ex) {
        console.error(ex);
      }
    }
    return false;
  },

  /**
   *
   * @param {WindowGlobalChild|WindowGlobalParent} windowGlobal
   *   The parent/child representation of a window global to check if we can
   *   use UITour.
   * @returns {boolean}
   *   Whether or not we can use UITour here.
   */
  ensureTrustedOrigin(windowGlobal) {
    // If we're not top-most or no longer current, bail out immediately.
    if (windowGlobal.browsingContext.parent || !windowGlobal.isCurrentGlobal) {
      return false;
    }

    let principal, uri;
    // We can get either a WindowGlobalParent or WindowGlobalChild, depending on
    // what process we're called in, and determining the secure context-ness and
    // principal + URI needs different approaches based on this.
    if (WindowGlobalParent.isInstance(windowGlobal)) {
      if (!windowGlobal.browsingContext.secureBrowserUI?.isSecureContext) {
        return false;
      }
      principal = windowGlobal.documentPrincipal;
      uri = windowGlobal.documentURI;
    } else {
      if (!windowGlobal.contentWindow?.isSecureContext) {
        return false;
      }
      let document = windowGlobal.contentWindow.document;
      principal = document?.nodePrincipal;
      uri = document?.documentURIObject;
    }

    if (!principal) {
      return false;
    }

    let permission = Services.perms.testPermissionFromPrincipal(
      principal,
      UITOUR_PERMISSION
    );
    if (permission == Services.perms.ALLOW_ACTION) {
      return true;
    }

    return uri && this.isTestingOrigin(uri);
  },
};
