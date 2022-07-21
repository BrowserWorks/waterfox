/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */
/* globals Preferences setEventListener */
"use strict";

const gPrivacyPaneOverlay = {
  init() {
    // Ensure load images automatically checkbox value is correct.
    this.initLoadImages();
    Preferences.get("permissions.default.image").on(
      "change",
      this.loadImagesReadPref.bind(this)
    );
    if (!window.privacyInitialized) {
      setTimeout(() => {
        this.delayedInit();
      }, 500);
    }
  },

  delayedInit() {
    this.updatePrivacyDefaults();
  },

  // Update privacy item default values
  async updatePrivacyDefaults() {
    let webRtc = document.getElementById("enableWebRTCP2P");
    webRtc.checked = Preferences.get(webRtc.getAttribute("preference")).value;

    let refHeader = document.getElementById("doNotsendSecureXSiteReferrer");
    refHeader.value = Preferences.get(
      refHeader.getAttribute("preference")
    ).value;

    let imagePermissions = document.getElementById("loadImages");
    imagePermissions.checked = !!Preferences.get("permissions.default.image")
      .value;

    let javascriptPermissions = document.getElementById("enableJavaScript");
    javascriptPermissions.checked = Preferences.get(
      javascriptPermissions.getAttribute("preference")
    ).value;
  },

  /**
   * Selects the right item of the Load Images Automatically checkbox.
   */
  initLoadImages() {
    let liaCheckbox = document.getElementById("loadImages");
    // If it doesn't exist yet, try again.
    if (!liaCheckbox) {
      setTimeout(() => {
        this.initLoadImages();
      }, 500);
      return;
    }

    // Create event listener for when the user clicks
    // on one of the radio buttons
    setEventListener("loadImages", "command", this.syncToLoadImagesPref);

    this.loadImagesReadPref();
  },

  loadImagesReadPref() {
    let enabledPref = Preferences.get("permissions.default.image");
    let liaCheckbox = document.getElementById("loadImages");
    if (enabledPref.value) {
      liaCheckbox.checked = true;
    } else {
      liaCheckbox.checked = false;
    }
  },

  syncToLoadImagesPref() {
    let value = document.getElementById("loadImages").checked ? 1 : 0;
    Services.prefs.setIntPref("permissions.default.image", value);
  },
};
