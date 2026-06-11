/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
});

const ENABLED_PREF = "browser.statusbar.enabled";
const TEXT_PREF = "browser.statusbar.appendStatusText";
const AREA = "status-bar";

export const StatusBar = {
  _initialized: false,
  _windows: new WeakSet(),

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    Services.prefs.addObserver(ENABLED_PREF, this);
    Services.prefs.addObserver(TEXT_PREF, this);
    lazy.CustomizableUI.registerArea(AREA, {
      type: lazy.CustomizableUI.TYPE_TOOLBAR,
      defaultPlacements: [
        "screenshot-button",
        "zoom-controls",
        "fullscreen-button",
      ],
    });
  },

  get enabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, false);
  },

  get showLinks() {
    return Services.prefs.getBoolPref(TEXT_PREF, true);
  },

  get textInBar() {
    return this.enabled && this.showLinks;
  },

  onWindowOpened(win) {
    const bar = win.document.getElementById("status-bar");
    const dummyBar = win.document.getElementById("status-dummybar");
    if (!bar || !dummyBar || this._windows.has(win)) {
      return;
    }
    this._windows.add(win);

    dummyBar.collapsed = !this.enabled;
    bar.collapsed = !this.enabled;

    // The toolbar context menu toggles the dummy bar, the only piece of
    // the status bar that lives inside the toolbox where the menu looks.
    dummyBar.addEventListener("toolbarvisibilitychange", event => {
      Services.prefs.setBoolPref(ENABLED_PREF, event.detail.visible);
    });

    this._mirrorStatusPanelLabel(win);
    this._placeLabel(win);
    lazy.CustomizableUI.registerToolbarNode(bar);
  },

  observe(_subject, topic) {
    if (topic != "nsPref:changed") {
      return;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!this._windows.has(win)) {
        continue;
      }
      const bar = win.document.getElementById("status-bar");
      const dummyBar = win.document.getElementById("status-dummybar");
      bar.collapsed = !this.enabled;
      if (dummyBar.collapsed == this.enabled) {
        dummyBar.collapsed = !this.enabled;
      }
      this._placeLabel(win);
    }
  },

  // The status text element is StatusPanel's label, moved into the bar
  // and back depending on the prefs, so the link target machinery keeps
  // a single owner.
  _placeLabel(win) {
    const { StatusPanel } = win;
    const textNode = win.document.getElementById("status-text");
    if (this.textInBar) {
      textNode.appendChild(StatusPanel._labelElement);
    } else {
      StatusPanel.panel.appendChild(StatusPanel._labelElement);
      StatusPanel.panel.firstChild.hidden = !this.showLinks;
    }
  },

  _mirrorStatusPanelLabel(win) {
    const { StatusPanel } = win;
    const originalSetter = Object.getOwnPropertyDescriptor(
      StatusPanel,
      "_label"
    ).set;

    Object.defineProperty(StatusPanel, "_label", {
      set(val) {
        // The original setter only writes the label for non empty values,
        // which leaves stale text behind in the always visible bar.
        if (this._labelElement) {
          this._labelElement.value = val;
        }
        originalSetter.call(this, val);
      },
      enumerable: true,
      configurable: true,
    });
  },
};
