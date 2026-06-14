/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "MigrationUtils", () => {
  // MigrationUtils is currently only available in browser builds.
  if (AppConstants.MOZ_BUILD_APP != "browser") {
    return undefined;
  }

  try {
    let { MigrationUtils } = ChromeUtils.importESModule(
      // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
      "resource:///modules/MigrationUtils.sys.mjs"
    );
    return MigrationUtils;
  } catch (e) {
    console.error(`Unable to load MigrationUtils.sys.mjs: ${e}`);
  }
  return undefined;
});

// Bug 1958916. Migrate profiles code to toolkit
ChromeUtils.defineLazyGetter(lazy, "SelectableProfileService", () => {
  // SelectableProfileService is currently only available in browser builds.
  // Bug 1958916: Migratre browser/profiles code to toolkit
  if (AppConstants.MOZ_BUILD_APP != "browser") {
    return undefined;
  }

  try {
    let { SelectableProfileService } = ChromeUtils.importESModule(
      // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
      "resource:///modules/profiles/SelectableProfileService.sys.mjs"
    );
    return SelectableProfileService;
  } catch (e) {
    console.error(`Unable to load SelectableProfileService.sys.mjs: ${e}`);
  }
  return undefined;
});

const MOZ_APP_NAME = "firefox";

export var ResetProfile = {
  /**
   * Check if reset is supported for the currently running profile.
   *
   * @returns {boolean} whether reset is supported.
   */
  resetSupported() {
    if (Services.policies && !Services.policies.isAllowed("profileRefresh")) {
      return false;
    }

    // Reset is only supported if the self-migrator used for reset exists.
    if (
      !lazy.MigrationUtils ||
      !lazy.MigrationUtils.migratorExists(MOZ_APP_NAME)
    ) {
      return false;
    }

    // We also need to be using a profile the profile manager knows about.
    if (lazy.SelectableProfileService?.currentProfile) {
      return true;
    }

    let profileService = Cc[
      "@mozilla.org/toolkit/profile-service;1"
    ].getService(Ci.nsIToolkitProfileService);
    if (profileService.currentProfile) {
      return true;
    }

    return false;
  },

  /**
   * Ask the user if they wish to restart the application to reset the profile.
   *
   * @param {Window} window
   */
  async openConfirmationDialog(window) {
    let win = window;
    // If we are, for instance, on an about page, get the chrome window to
    // access its gDialogBox.
    if (win.docShell.chromeEventHandler) {
      win = win.browsingContext?.topChromeWindow;
    }

    let params = {
      learnMore: false,
      reset: false,
    };

    if (win.gDialogBox) {
      await win.gDialogBox.open(
        "chrome://global/content/resetProfile.xhtml",
        params
      );
    } else {
      win.openDialog(
        "chrome://global/content/resetProfile.xhtml",
        null,
        "modal,centerscreen,titlebar",
        params
      );
    }

    if (params.learnMore) {
      win.openTrustedLinkIn(
        "https://support.mozilla.org/kb/refresh-firefox-reset-add-ons-and-settings",
        "tab"
      );
      return;
    }

    if (!params.reset) {
      return;
    }

    this.doReset();
  },

  doReset() {
    function doRestart() {
      // Set the reset profile environment variable.
      Services.env.set("MOZ_RESET_PROFILE_RESTART", "1");

      Services.startup.quit(
        Ci.nsIAppStartup.eForceQuit | Ci.nsIAppStartup.eRestart
      );
    }

    if (lazy.SelectableProfileService?.currentProfile) {
      Services.env.set(
        "SELECTABLE_PROFILE_RESET_PATH",
        lazy.SelectableProfileService?.currentProfile.path
      );
      Services.env.set(
        "SELECTABLE_PROFILE_RESET_STORE_ID",
        lazy.SelectableProfileService?.storeID
      );
      lazy.SelectableProfileService.setDefaultProfileForGroup().then(() =>
        doRestart()
      );
    } else {
      doRestart();
    }
  },
};
