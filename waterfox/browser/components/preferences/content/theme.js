/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */
"use strict";

const { PrefUtils } = ChromeUtils.importESModule(
  "resource:///modules/PrefUtils.sys.mjs"
);

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
      { id: "userChrome.tab.bottom_rounded_corner", type: "bool" },
      { id: "userChrome.tab.photon_like_contextline", type: "bool" },
      { id: "userChrome.tab.squareTabCorners", type: "bool" },
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
      { id: "userChrome.hidden.bookmarkbar_icon", type: "bool" },
      { id: "userChrome.hidden.bookmarkbar_label", type: "bool" },

      // Panels
      { id: "userChrome.theme.transparent.panel", type: "bool" },
      { id: "userChrome.theme.transparent.menu", type: "bool" },
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
      { id: "userChrome.icon.disabled", type: "bool" },
      { id: "userChrome.hidden.tab_icon", type: "bool" },
      { id: "userChrome.icon.menu.full", type: "bool" },
      { id: "userChrome.icon.global_menu.mac", type: "bool" },

      // Font
      { id: "userContent.page.monospace", type: "bool" },
      { id: "userChrome.theme.monospace", type: "bool" },
    ];
  },

  get nestedPrefs() {
    return [
      {
        id: "autoBlurTabs",
        pref: "userChrome.autohide.tab",
      },
      {
        id: "centerTabLabel",
        pref: "userChrome.centered.tab",
      },
    ];
  },

  get presets() {
    return [
      {
        id: "roundedCorners",
        on: [
          { id: "userChrome.tab.squareTabCorners", value: false },
          { id: "userChrome.rounding.square_button", value: false },
          { id: "userChrome.rounding.square_panel", value: false },
          { id: "userChrome.rounding.square_panelitem", value: false },
          { id: "userChrome.rounding.square_menupopup", value: false },
          { id: "userChrome.rounding.square_menuitem", value: false },
          { id: "userChrome.rounding.square_field", value: false },
          { id: "userChrome.rounding.square_checklabel", value: false },
        ],
        off: [
          { id: "userChrome.tab.squareTabCorners", value: true },
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
        id: "autohideElements",
        on: [
          { id: "userChrome.autohide.tab", value: true },
          { id: "userChrome.autohide.tab.blur", value: true },
          { id: "userChrome.autohide.tabbar", value: true },
          { id: "userChrome.autohide.back_button", value: true },
          { id: "userChrome.autohide.forward_button", value: true },
          { id: "userChrome.autohide.page_action", value: true },
          { id: "userChrome.autohide.bookmarkbar", value: true },
          { id: "userChrome.autohide.sidebar", value: true },
          { id: "userChrome.hidden.urlbar_iconbox", value: true },
        ],
        off: [
          { id: "userChrome.autohide.tab", value: false },
          { id: "userChrome.autohide.tab.blur", value: false },
          { id: "userChrome.autohide.tabbar", value: false },
          { id: "userChrome.autohide.back_button", value: false },
          { id: "userChrome.autohide.forward_button", value: false },
          { id: "userChrome.autohide.page_action", value: false },
          { id: "userChrome.autohide.bookmarkbar", value: false },
          { id: "userChrome.autohide.sidebar", value: false },
          { id: "userChrome.hidden.urlbar_iconbox", value: false },
        ],
      },
      {
        id: "centerElements",
        on: [
          { id: "userChrome.centered.tab", value: true },
          { id: "userChrome.centered.tab.label", value: true },
          { id: "userChrome.centered.urlbar", value: true },
        ],
        off: [
          { id: "userChrome.centered.tab", value: false },
          { id: "userChrome.centered.tab.label", value: false },
          { id: "userChrome.centered.urlbar", value: false },
        ],
      },
      {
        id: "padElements",
        on: [
          { id: "userChrome.padding.drag_space", value: false },
          { id: "userChrome.padding.urlView_expanding", value: true },
          { id: "userChrome.padding.menu_compact", value: true },
          { id: "userChrome.padding.bookmark_menu.compact", value: true },
          { id: "userChrome.padding.panel_header", value: true },
        ],
        off: [
          { id: "userChrome.padding.drag_space", value: true },
          { id: "userChrome.padding.urlView_expanding", value: false },
          { id: "userChrome.padding.menu_compact", value: false },
          { id: "userChrome.padding.bookmark_menu.compact", value: false },
          { id: "userChrome.padding.panel_header", value: false },
        ],
      },
    ];
  },

  init() {
    // Initialize prefs
    window.Preferences.addAll(this.preferences);
    const userChromeEnabled = PrefUtils.get(this.WATERFOX_THEME_PREF);
    for (let pref of this.preferences) {
      this._prefObservers.push(
        PrefUtils.addObserver(pref.id, _ => {
          this.refreshTheme();
        })
      );
    }

    // Init presets
    for (let preset of this.presets) {
      let button = document.getElementById(preset.id);
      if (button) {
        button.addEventListener("click", event => {
          const target = event.target.getAttribute("data-l10n-args");
          if (!target) {
            // Something has gone wrong as all our event targets should
            // have a data-l10n-args attr.
            return;
          }

          const [presetKey, presetValue] = Object.entries(
            JSON.parse(target)
          )[0];
          event.target.setAttribute(
            "data-l10n-args",
            JSON.stringify({ [presetKey]: !presetValue })
          );

          // If the button is initially true, we want to set the
          // false preset values.
          for (let pref of preset[presetValue ? "off" : "on"]) {
            PrefUtils.set(pref.id, pref.value);
          }
        });
      }
    }

    // Init default button
    let defaultButton = document.getElementById("waterfoxDefaults");
    if (defaultButton) {
      defaultButton.addEventListener("click", this);
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

    // Init Tab Rounding
    this.initTabRounding();

    // Init Nested Prefs
    for (let el of this.nestedPrefs) {
      this.initNestedPrefs(el.id, el.pref);
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

  async initTabRounding() {
    let checkbox = document.getElementById("squareTabCorners");
    // If it doesn't exist yet, try again.
    while (!checkbox) {
      const wait = ms => new Promise(res => setTimeout(res, ms, {}));
      await wait(500);
      checkbox = document.getElementById("squareTabCorners");
    }

    // Update the checkbox initially, and observe pref changes.
    this.updateTabRoundingCheckbox();
    this._prefObservers.push(
      PrefUtils.addObserver("userChrome.tab.squareTabCorners", square => {
        PrefUtils.set("userChrome.rounding.square_tab", square);
        PrefUtils.set("userChrome.tab.bottom_rounded_corner", !square);
      })
    );
  },

  updateTabRoundingCheckbox() {
    let checkbox = document.getElementById("squareTabCorners");
    const enabled = PrefUtils.get(
      "userChrome.tab.squareTabCorners",
      PrefUtils.get("userChrome.rounding.square_tab", false) &&
        PrefUtils.set("userChrome.tab.bottom_rounded_corner", true)
    );

    checkbox.checked = enabled;
  },

  async initNestedPrefs(id, controllingPref) {
    let checkbox = document.getElementById(id);
    // If it doesn't exist yet, try again.
    while (!checkbox) {
      const wait = ms => new Promise(res => setTimeout(res, ms, {}));
      await wait(500);
      checkbox = document.getElementById(id);
    }
    const enabled = PrefUtils.get(controllingPref, false);

    checkbox.setAttribute("disabled", !enabled);

    this._prefObservers.push(
      PrefUtils.addObserver(controllingPref, (enabled, pref) => {
        // We need this as observer fires for pref and pref.<some sub path>
        if (pref !== controllingPref) {
          return;
        }
        const checkbox = document.getElementById(id);
        checkbox.setAttribute("disabled", !enabled);
      })
    );
  },
};
