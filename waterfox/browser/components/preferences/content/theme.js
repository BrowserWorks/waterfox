/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */
"use strict";

const { PrefUtils } = ChromeUtils.import("resource:///modules/PrefUtils.jsm");

XPCOMUtils.defineLazyServiceGetter(
  this,
  "styleSheetService",
  "@mozilla.org/content/style-sheet-service;1",
  "nsIStyleSheetService"
);

var gThemePane = {
  WATERFOX_THEME_PREF: "userChrome.theme.enable",

  _prefObservers: [],

  get preferences() {
    return [
      // Waterfox Customizations
      { id: "userChrome.theme.enable", type: "bool" },

      // Tab Bar
      { id: "userChrome.autohide.tab", type: "bool" },
      { id: "userChrome.autohide.tab.blur", type: "bool" },
      { id: "userChrome.autohide.tabbar", type: "bool" },
      { id: "userChrome.centered.tab", type: "bool" },
      { id: "userChrome.centered.tab.label", type: "bool" },
      { id: "userChrome.rounding.square_tab", type: "bool" },
      { id: "userChrome.padding.drag_space", type: "bool" },
      { id: "userChrome.tab.close_button_at_hover", type: "bool" },

      // Nav Bar
      { id: "userChrome.autohide.back_button", type: "bool" },
      { id: "userChrome.autohide.forward_button", type: "bool" },
      { id: "userChrome.autohide.page_action", type: "bool" },
      { id: "userChrome.hidden.urlbar_iconbox", type: "bool" },
      { id: "userChrome.centered.urlbar", type: "bool" },
      { id: "userChrome.rounding.square_button", type: "bool" },
      { id: "userChrome.padding.urlView_expanding", type: "bool" },

      // Bookmarks Bar
      { id: "userChrome.autohide.bookmarkbar", type: "bool" },
      { id: "userChrome.centered.bookmarkbar", type: "bool" },
      { id: "userChrome.hidden.bookmarkbar_icon", type: "bool" },
      { id: "userChrome.hidden.bookmarkbar_label", type: "bool" },

      // Panels
      { id: "userChrome.decoration.disable_panel_animate", type: "bool" },
      { id: "userChrome.hidden.disabled_menu", type: "bool" },
      { id: "userChrome.rounding.square_panel", type: "bool" },
      { id: "userChrome.rounding.square_panelitem", type: "bool" },
      { id: "userChrome.rounding.square_menupopup", type: "bool" },
      { id: "userChrome.rounding.square_menuitem", type: "bool" },
      { id: "userChrome.rounding.square_field", type: "bool" },
      { id: "userChrome.rounding.square_checklabel", type: "bool" },
      { id: "userChrome.padding.menu_compact", type: "bool" },
      { id: "userChrome.padding.bookmark_menu.compact", type: "bool" },
      { id: "userChrome.padding.panel_header", type: "bool" },
      { id: "userChrome.panel.remove_strip", type: "bool" },
      { id: "userChrome.panel.full_width_separator", type: "bool" },

      // Sidebar
      { id: "userChrome.decoration.disable_sidebar_animate", type: "bool" },
      { id: "userChrome.autohide.sidebar", type: "bool" },
      { id: "userChrome.hidden.sidebar_header", type: "bool" },

      // Icons
      { id: "userChrome.hidden.tab_icon", type: "bool" },
      { id: "userChrome.icon.menu.full", type: "bool" },
      { id: "userChrome.icon.global_menu.mac", type: "bool" },

      // Media Player
      { id: "userContent.player.ui.twoline", type: "bool" },

      // Font
      { id: "userContent.page.monospace", type: "bool" },
      { id: "userContent.theme.monospace", type: "bool" },
    ];
  },

  get presets() {
    return [
      {
        id: "smoothCorners",
        prefs: [
          { id: "userChrome.rounding.square_tab", value: false },
          { id: "userChrome.rounding.square_button", value: false },
          { id: "userChrome.rounding.square_panel", value: false },
          { id: "userChrome.rounding.square_panelitem", value: false },
          { id: "userChrome.rounding.square_menupopup", value: false },
          { id: "userChrome.rounding.square_menuitem", value: false },
          { id: "userChrome.rounding.square_field", value: false },
          { id: "userChrome.rounding.square_checklabel", value: false },
        ],
      },
      {
        id: "squareCorners",
        prefs: [
          { id: "userChrome.rounding.square_tab", value: true },
          { id: "userChrome.rounding.square_button", value: true },
          { id: "userChrome.rounding.square_panel", value: true },
          { id: "userChrome.rounding.square_panelitem", value: true },
          { id: "userChrome.rounding.square_menupopup", value: true },
          { id: "userChrome.rounding.square_menuitem", value: true },
          { id: "userChrome.rounding.square_field", value: true },
          { id: "userChrome.rounding.square_checklabel", value: true },
        ],
      },
      {
        id: "autohideAll",
        prefs: [
          { id: "userChrome.autohide.tab", value: true },
          { id: "userChrome.autohide.tab.blur", value: true },
          { id: "userChrome.autohide.tabbar", value: true },
          { id: "userChrome.autohide.back_button", value: true },
          { id: "userChrome.autohide.forward_button", value: true },
          { id: "userChrome.autohide.page_action", value: true },
          { id: "userChrome.autohide.bookmarkbar", value: true },
          { id: "userChrome.autohide.sidebar", value: true },
        ],
      },
      {
        id: "autohideNone",
        prefs: [
          { id: "userChrome.autohide.tab", value: false },
          { id: "userChrome.autohide.tab.blur", value: false },
          { id: "userChrome.autohide.tabbar", value: false },
          { id: "userChrome.autohide.back_button", value: false },
          { id: "userChrome.autohide.forward_button", value: false },
          { id: "userChrome.autohide.page_action", value: false },
          { id: "userChrome.autohide.bookmarkbar", value: false },
          { id: "userChrome.autohide.sidebar", value: false },
        ],
      },
      {
        id: "centerAll",
        prefs: [
          { id: "userChrome.centered.tab", value: true },
          { id: "userChrome.centered.tab.label", value: true },
          { id: "userChrome.centered.urlbar", value: true },
          { id: "userChrome.centered.bookmarkbar", value: true },
        ],
      },
      {
        id: "centerNone",
        prefs: [
          { id: "userChrome.centered.tab", value: false },
          { id: "userChrome.centered.tab.label", value: false },
          { id: "userChrome.centered.urlbar", value: false },
          { id: "userChrome.centered.bookmarkbar", value: false },
        ],
      },
      {
        id: "reducePadding",
        prefs: [
          { id: "userChrome.padding.drag_space", value: false },
          { id: "userChrome.padding.urlView_expanding", value: false },
          { id: "userChrome.padding.menu_compact", value: false },
          { id: "userChrome.padding.bookmark_menu.compact", value: false },
          { id: "userChrome.padding.panel_header", value: false },
        ],
      },
      {
        id: "increasePadding",
        prefs: [
          { id: "userChrome.padding.drag_space", value: true },
          { id: "userChrome.padding.urlView_expanding", value: true },
          { id: "userChrome.padding.menu_compact", value: true },
          { id: "userChrome.padding.bookmark_menu.compact", value: true },
          { id: "userChrome.padding.panel_header", value: true },
        ],
      },
    ];
  },

  init() {
    // Initialize prefs
    window.Preferences.addAll(this.preferences);
    const userChromeEnabled = PrefUtils.get(this.WATERFOX_THEME_PREF);

    // Init presets
    for (let preset of this.presets) {
      let button = document.getElementById(preset.id);
      if (button) {
        button.addEventListener("click", () => {
          for (let pref of preset.prefs) {
            PrefUtils.set(pref.id, pref.value);
          }
          this.refreshTheme();
        });
      }
    }

    // Init default button
    let defaultButton = document.getElementById("waterfoxDefaults");
    if (defaultButton) {
      defaultButton.addEventListener("click", this);
    }

    // Init refresh button
    let refreshButton = document.getElementById("refreshWaterfoxCustomTheme");
    if (refreshButton) {
      refreshButton.addEventListener("click", this);
    }

    // Init popups
    let popups = document.getElementsByClassName("popup-container");
    for (let popup of popups) {
      popup.addEventListener("mouseover", this);
      popup.addEventListener("mouseout", this);
    }

    // Init theme customizations
    let waterfoxCustomizations = document.getElementById(
      "waterfoxUserChromeCustomizations"
    );
    if (waterfoxCustomizations) {
      let presetBox = document.getElementById("waterfoxUserChromePresets");
      presetBox.hidden = !userChromeEnabled;
      let themeGroup = document.getElementById(
        "waterfoxUserChromeCustomizations"
      );
      themeGroup.hidden = !userChromeEnabled;

      this._prefObservers.push(
        PrefUtils.addObserver(this.WATERFOX_THEME_PREF, isEnabled => {
          presetBox.hidden = !isEnabled;
          themeGroup.hidden = !isEnabled;
        })
      );
    }

    // Register unload listener
    window.addEventListener("unload", this);
  },

  destroy() {
    window.removeEventListener("unload", this);
    for (let obs of this._prefObservers) {
      PrefUtils.removeObserver(obs);
    }
  },

  // nsIDOMEventListener
  handleEvent(event) {
    switch (event.type) {
      case "mouseover":
      case "mouseout":
        event.target.nextElementSibling?.classList.toggle("show");
        break;
      case "click":
        switch (event.target.id) {
          case "refreshWaterfoxCustomTheme":
            this.refreshTheme();
            break;
          case "waterfoxDefaults":
            this.preferences.map(pref => {
              Services.prefs.clearUserPref(pref.id);
            });
            this.refreshTheme();
            break;
        }
        break;
      case "unload":
        this.destroy();
        break;
    }
  },

  refreshTheme() {
    const userChromeSheet = "chrome://browser/skin/userChrome.css";
    const userContentSheet = "chrome://browser/skin/userContent.css";

    this.unregisterStylesheet(userChromeSheet);
    this.unregisterStylesheet(userContentSheet);
    this.registerStylesheet(userChromeSheet);
    this.registerStylesheet(userContentSheet);
  },

  registerStylesheet(uri) {
    let url = Services.io.newURI(uri);
    let type = styleSheetService.USER_SHEET;
    styleSheetService.loadAndRegisterSheet(url, type);
  },

  unregisterStylesheet(uri) {
    let url = Services.io.newURI(uri);
    let type = styleSheetService.USER_SHEET;
    styleSheetService.unregisterSheet(url, type);
  },
};
