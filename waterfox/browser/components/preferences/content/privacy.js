const _gPrivacyPaneOverlay = {
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
    const webRtc = document.getElementById("enableWebRTCP2P");
    webRtc.checked = Preferences.get(webRtc.getAttribute("preference")).value;

    const refHeader = document.getElementById("doNotsendSecureXSiteReferrer");
    refHeader.value = Preferences.get(
      refHeader.getAttribute("preference")
    ).value;

    const imagePermissions = document.getElementById("loadImages");
    imagePermissions.checked = !!Preferences.get("permissions.default.image")
      .value;

    const javascriptPermissions = document.getElementById("enableJavaScript");
    javascriptPermissions.checked = Preferences.get(
      javascriptPermissions.getAttribute("preference")
    ).value;
  },

  /**
   * Selects the right item of the Load Images Automatically checkbox.
   */
  initLoadImages() {
    const liaCheckbox = document.getElementById("loadImages");
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
    const enabledPref = Preferences.get("permissions.default.image");
    const liaCheckbox = document.getElementById("loadImages");
    if (enabledPref.value === 1) {
      liaCheckbox.checked = true;
    } else {
      liaCheckbox.checked = false;
    }
  },

  syncToLoadImagesPref() {
    const value = document.getElementById("loadImages").checked ? 1 : 2;
    Services.prefs.setIntPref("permissions.default.image", value);
  },
};
