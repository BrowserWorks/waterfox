/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXPORTED_SYMBOLS = ["StatusBar"];

const { CustomizableUI } = ChromeUtils.import(
  "resource:///modules/CustomizableUI.jsm"
);

const { setTimeout } = ChromeUtils.import("resource://gre/modules/Timer.jsm");

const { PrefUtils } = ChromeUtils.import("resource:///modules/PrefUtils.jsm");

const { BrowserUtils } = ChromeUtils.import(
  "resource:///modules/BrowserUtils.jsm"
);

const StatusBar = {
  PREF_ENABLED: "browser.statusbar.enabled",
  PREF_STATUSTEXT: "browser.statusbar.appendStatusText",

  get enabled() {
    return PrefUtils.get(this.PREF_ENABLED);
  },

  get showLinks() {
    return PrefUtils.get(this.PREF_STATUSTEXT);
  },

  get textInBar() {
    return this.enabled && this.showLinks;
  },

  get style() {
    return `
     @-moz-document url('chrome://browser/content/browser.xhtml') {
       #status-bar {
           color: initial !important;
           background-color: var(--toolbar-non-lwt-bgcolor) !important;
         }
         :root[customizing] #status-bar {
           visibility: visible !important;
         }
         #status-text > #statuspanel-label {
           border-top: 0 !important;
           background-color: unset !important;
         }
         #wrapper-status-text label::after {
           content: "Status text" !important;
           color: red !important;
           border: 1px #aaa solid !important;
           border-radius: 3px !important;
           font-weight: bold !important;
         }
         #status-bar > #status-text {
           display: flex !important;
           justify-content: center !important;
           align-content: center !important;
           flex-direction: column !important;
         }
         /* Ensure text color of status bar widgets set correctly */
         toolbar .toolbarbutton-1 {
           color: var(--toolbarbutton-icon-fill) !important;
         }
       }
           `;
  },

  init(window) {
    if (!window.document.getElementById("status-dummybar")) {
      setTimeout(() => {
        this.init(window);
      }, 25);
    } else if (!window.statusbar.node) {
      this.configureDummyBar(window, "status-dummybar");
      this.configureStatusBar(window);
      this.overrideStatusPanelLabel(window);
      this.configureBottomBox(window);
      this.initPrefListeners();
      this.registerArea(window, "status-bar");
      BrowserUtils.setStyle(this.style);
    }
  },

  async initPrefListeners() {
    this.enabledListener = PrefUtils.addObserver(
      this.PREF_ENABLED,
      isEnabled => {
        this.setStatusBarVisibility(isEnabled);
        this.setStatusTextVisibility();
      }
    );
    this.textListener = PrefUtils.addObserver(
      this.PREF_STATUSTEXT,
      isEnabled => {
        this.setStatusTextVisibility();
      }
    );
  },

  async setStatusBarVisibility(isEnabled) {
    CustomizableUI.getWidget("status-dummybar").instances.forEach(dummyBar => {
      dummyBar.node.setAttribute("collapsed", !isEnabled);
    });
  },

  async setStatusTextVisibility() {
    if (this.enabled && this.showLinks) {
      // Status bar enabled and want to display links in it
      this.executeInAllWindows(window => {
        let StatusPanel = window.StatusPanel;
        window.statusbar.textNode.appendChild(StatusPanel._labelElement);
      });
    } else if (!this.enabled && this.showLinks) {
      // Status bar disabled so display links in StatusPanel
      this.executeInAllWindows(window => {
        let StatusPanel = window.StatusPanel;
        StatusPanel.panel.firstChild.appendChild(StatusPanel._labelElement);
        StatusPanel.panel.firstChild.hidden = false;
      });
    } else {
      // Don't display links
      this.executeInAllWindows(window => {
        let StatusPanel = window.StatusPanel;
        StatusPanel.panel.firstChild.appendChild(StatusPanel._labelElement);
        StatusPanel.panel.firstChild.hidden = true;
      });
    }
  },

  async registerArea(aWindow, aArea) {
    if (!CustomizableUI.areas.includes("status-bar")) {
      CustomizableUI.registerArea(aArea, {
        type: CustomizableUI.TYPE_TOOLBAR,
        defaultPlacements: ["screenshot-button", "fullscreen-button"],
      });
      let tb = aWindow.document.getElementById("status-dummybar");
      CustomizableUI.registerToolbarNode(tb);
    }
  },

  async configureDummyBar(aWindow, aId) {
    let { document } = aWindow;
    let el = document.getElementById(aId);
    el.collapsed = !this.enabled;
    el.setAttribute = function(att, value) {
      let result = Element.prototype.setAttribute.apply(this, arguments);

      if (att == "collapsed") {
        let StatusPanel = aWindow.StatusPanel;
        if (value === true) {
          PrefUtils.set(StatusBar.PREF_ENABLED, false);
          aWindow.statusbar.node.setAttribute("collapsed", true);
          StatusPanel.panel.firstChild.appendChild(StatusPanel._labelElement);
        } else {
          PrefUtils.set(StatusBar.PREF_ENABLED, true);
          aWindow.statusbar.node.setAttribute("collapsed", false);
          if (StatusBar.textInBar) {
            aWindow.statusbar.textNode.appendChild(StatusPanel._labelElement);
          }
        }
      }

      return result;
    };
  },

  configureStatusBar(aWindow) {
    let StatusPanel = aWindow.StatusPanel;
    aWindow.statusbar.node = aWindow.document.getElementById("status-bar");
    aWindow.statusbar.textNode = aWindow.document.getElementById("status-text");
    if (this.textInBar) {
      aWindow.statusbar.textNode.appendChild(StatusPanel._labelElement);
    }
    aWindow.statusbar.node.appendChild(aWindow.statusbar.textNode);
    aWindow.statusbar.node.setAttribute("collapsed", !this.enabled);
  },

  async overrideStatusPanelLabel(aWindow) {
    // eslint-disable-next-line no-unused-vars
    let { StatusPanel, MousePosTracker } = aWindow;
    // eslint-disable-next-line no-unused-vars
    let window = aWindow;
    // TODO: Should be able to do this with a WrappedJSObject instead
    // eslint-disable-next-line no-eval
    eval(
      'Object.defineProperty(StatusPanel, "_label", {' +
        Object.getOwnPropertyDescriptor(StatusPanel, "_label")
          .set.toString()
          .replace(/^set _label/, "set")
          .replace(
            /((\s+)this\.panel\.setAttribute\("inactive", "true"\);)/,
            "$2this._labelElement.value = val;$1"
          ) +
        ", enumerable: true, configurable: true});"
    );
  },

  async configureBottomBox(aWindow) {
    let { document } = aWindow;
    let bottomBox = document.getElementById("browser-bottombox");
    CustomizableUI.registerToolbarNode(aWindow.statusbar.node);
    bottomBox.appendChild(aWindow.statusbar.node);
  },
};

// Inherited props
StatusBar.executeInAllWindows = BrowserUtils.executeInAllWindows;
