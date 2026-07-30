/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/* import-globals-from ../../../../browser/base/content/aboutDialog-appUpdater.js */
/* import-globals-from ../../../../browser/base/content/utilityOverlay.js */

var { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);
var { LightweightThemeConsumer } = ChromeUtils.importESModule(
  "resource://gre/modules/LightweightThemeConsumer.sys.mjs"
);
if (AppConstants.MOZ_UPDATER) {
  Services.scriptloader.loadSubScript(
    "chrome://browser/content/aboutDialog-appUpdater.js",
    this
  );
}

function init() {
  LightweightThemeConsumer.init(window);

  let defaults = Services.prefs.getDefaultBranch(null);
  let distroId = defaults.getCharPref("distribution.id", "");
  if (distroId) {
    let distroAbout = defaults.getStringPref("distribution.about", "");
    if (distroAbout) {
      let distroField = document.getElementById("distribution");
      distroField.value = distroAbout;
      distroField.style.display = "block";
    }

    if (!distroId.startsWith("mozilla-") || distroAbout) {
      let distroVersion = defaults.getCharPref("distribution.version", "");
      if (distroVersion) {
        distroId += " - " + distroVersion;
      }

      let distroIdField = document.getElementById("distributionId");
      distroIdField.value = distroId;
      distroIdField.style.display = "block";
    }
  }

  let versionIdMap = new Map([
    ["base", "aboutDialog-version"],
    ["base-nightly", "aboutDialog-version-nightly"],
    ["base-arch", "aboutdialog-version-arch"],
    ["base-arch-nightly", "aboutdialog-version-arch-nightly"],
  ]);
  let versionIdKey = "base";
  let versionAttributes = {
    version: AppConstants.MOZ_APP_VERSION_DISPLAY,
  };

  let arch = Services.sysinfo.get("arch");
  if (["x86", "x86-64"].includes(arch)) {
    versionAttributes.bits = Services.appinfo.is64Bit ? 64 : 32;
  } else {
    versionIdKey += "-arch";
    versionAttributes.arch = arch;
  }

  let version = Services.appinfo.version;
  if (/a\d+$/.test(version)) {
    versionIdKey += "-nightly";
    let buildID = Services.appinfo.appBuildID;
    let year = buildID.slice(0, 4);
    let month = buildID.slice(4, 6);
    let day = buildID.slice(6, 8);
    versionAttributes.isodate = `${year}-${month}-${day}`;

    document.getElementById("experimental").hidden = false;
    document.getElementById("communityDesc").hidden = true;
  }

  let versionField = document.getElementById("version");

  document.l10n.setAttributes(
    versionField,
    versionIdMap.get(versionIdKey),
    versionAttributes
  );

  let relNotesLink = document.getElementById("releasenotes");
  let relNotesPrefType = Services.prefs.getPrefType(
    "app.releaseNotesURL.aboutDialog"
  );
  if (relNotesPrefType != Services.prefs.PREF_INVALID) {
    let relNotesURL = Services.urlFormatter.formatURLPref(
      "app.releaseNotesURL.aboutDialog"
    );
    if (relNotesURL != "about:blank") {
      relNotesLink.href = relNotesURL;
      relNotesLink.hidden = false;
    }
  }

  if (AppConstants.MOZ_UPDATER) {
    gAppUpdater = new appUpdater({ buttonAutoFocus: true });

    document.getElementById("currentChannel").value = UpdateUtils.UpdateChannel;
  }

  if (AppConstants.IS_ESR) {
    document.getElementById("release").hidden = false;
  }

  document
    .getElementById("aboutDialogEscapeKey")
    .addEventListener("command", () => {
      window.close();
    });
  document
    .getElementById("aboutDialogCloseButton")
    .addEventListener("click", () => {
      window.close();
    });
  document
    .getElementById("aboutDialogHelpLink")
    .addEventListener("click", () => {
      openHelpLink("firefox-help");
    });

  if (AppConstants.MOZ_UPDATER) {
    document
      .getElementById("checkForUpdatesButton")
      .addEventListener("command", () => {
        gAppUpdater.checkForUpdates();
      });
    document
      .getElementById("downloadAndInstallButton")
      .addEventListener("command", () => {
        gAppUpdater.startDownload();
      });
    document.getElementById("updateButton").addEventListener("command", () => {
      gAppUpdater.buttonRestartAfterDownload();
    });
    window.addEventListener("unload", e => {
      onUnload(e);
    });
  }
}

init();
