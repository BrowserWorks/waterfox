/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {}

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI: 'resource:///modules/CustomizableUI.sys.mjs',
  BrowserUtils: 'resource:///modules/BrowserUtils.sys.mjs',
  PrefUtils: 'resource:///modules/PrefUtils.sys.mjs',
  setTimeout: 'resource://gre/modules/Timer.sys.mjs',
})

export const StatusBar = {
  PREF_ENABLED: 'browser.statusbar.enabled',
  PREF_STATUSTEXT: 'browser.statusbar.appendStatusText',

  get enabled() {
    return lazy.PrefUtils.get(this.PREF_ENABLED)
  },

  get showLinks() {
    return lazy.PrefUtils.get(this.PREF_STATUSTEXT)
  },

  get textInBar() {
    return this.enabled && this.showLinks
  },

  get style() {
    return `
     @-moz-document url('chrome://browser/content/browser.xhtml') {
       #status-bar {
           color: initial !important;
           border-top: 1px solid var(--chrome-content-separator-color);
           background-color: var(--toolbar-bgcolor);
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
         #wrapper-status-text > #status-text > #statuspanel-label {
           display: none;
         }
         #status-bar #status-text {
           display: flex !important;
           justify-content: center !important;
           align-items: center !important;
           height: calc(2 * var(--toolbarbutton-inner-padding) + 16px);
         }
         toolbarpaletteitem #status-text:before {
           content: "Status text";
           color: red;
           border: 1px #aaa solid;
           border-radius: 3px;
           font-weight: bold;
           display: flex;
           justify-content: center;
           align-content: center;
           flex-direction: column;
           align-items: center;
           margin-inline: var(--toolbarbutton-outer-padding);
           width: 100%;
           height: 100%;
        }
         /* Ensure text color of status bar widgets set correctly */
         toolbar .toolbarbutton-1 {
           color: var(--toolbarbutton-icon-fill) !important;
         }
       }
           `
  },

  init(window) {
    if (!window.document.getElementById('status-dummybar')) {
      lazy.setTimeout(() => {
        this.init(window)
      }, 25)
    } else if (!window.statusbar.node) {
      this.configureDummyBar(window, 'status-dummybar')
      this.configureStatusBar(window)
      this.overrideStatusPanelLabel(window)
      this.configureBottomBox(window)
      this.initPrefListeners()
      this.registerArea(window, 'status-bar')
      lazy.BrowserUtils.setStyle(this.style)
    }
  },

  async initPrefListeners() {
    this.enabledListener = lazy.PrefUtils.addObserver(
      this.PREF_ENABLED,
      isEnabled => {
        this.setStatusBarVisibility(isEnabled)
        this.setStatusTextVisibility()
      }
    )
    this.textListener = lazy.PrefUtils.addObserver(
      this.PREF_STATUSTEXT,
      isEnabled => {
        this.setStatusTextVisibility()
      }
    )
  },

  async setStatusBarVisibility(isEnabled) {
    const instances = lazy.CustomizableUI.getWidget('status-dummybar').instances
    for (const dummyBar of instances) {
      dummyBar.node.setAttribute('collapsed', !isEnabled)
    }
  },
  async setStatusTextVisibility() {
    if (this.enabled && this.showLinks) {
      // Status bar enabled and want to display links in it
      this.executeInAllWindows(window => {
        const StatusPanel = window.StatusPanel
        window.statusbar.textNode.appendChild(StatusPanel._labelElement)
      })
    } else if (!this.enabled && this.showLinks) {
      // Status bar disabled so display links in StatusPanel
      this.executeInAllWindows(window => {
        const StatusPanel = window.StatusPanel
        StatusPanel.panel.appendChild(StatusPanel._labelElement)
        StatusPanel.panel.firstChild.hidden = false
      })
    } else {
      // Don't display links
      this.executeInAllWindows(window => {
        const StatusPanel = window.StatusPanel
        StatusPanel.panel.appendChild(StatusPanel._labelElement)
        StatusPanel.panel.firstChild.hidden = true
      })
    }
  },

  async registerArea(aWindow, aArea) {
    if (!lazy.CustomizableUI.areas.includes('status-bar')) {
      lazy.CustomizableUI.registerArea(aArea, {
        type: lazy.CustomizableUI.TYPE_TOOLBAR,
        defaultPlacements: ['screenshot-button', 'fullscreen-button'],
      })
      const tb = aWindow.document.getElementById('status-dummybar')
      lazy.CustomizableUI.registerToolbarNode(tb)
    }
  },

  async configureDummyBar(aWindow, aId) {
    const { document } = aWindow
    const el = document.getElementById(aId)
    el.collapsed = !this.enabled
    el.setAttribute = function (att, value, ...rest) {
      const result = Element.prototype.setAttribute.apply(this, [
        att,
        value,
        ...rest,
      ])

      if (att === 'collapsed') {
        const StatusPanel = aWindow.StatusPanel
        if (value === true) {
          lazy.PrefUtils.set(StatusBar.PREF_ENABLED, false)
          aWindow.statusbar.node.setAttribute('collapsed', true)
          StatusPanel.panel.appendChild(StatusPanel._labelElement)
        } else {
          lazy.PrefUtils.set(StatusBar.PREF_ENABLED, true)
          aWindow.statusbar.node.setAttribute('collapsed', false)
          if (StatusBar.textInBar) {
            aWindow.statusbar.textNode.appendChild(StatusPanel._labelElement)
          }
        }
      }

      return result
    }
  },

  configureStatusBar(aWindow) {
    const StatusPanel = aWindow.StatusPanel
    aWindow.statusbar.node = aWindow.document.getElementById('status-bar')
    aWindow.statusbar.textNode = aWindow.document.getElementById('status-text')
    if (this.textInBar) {
      aWindow.statusbar.textNode.appendChild(StatusPanel._labelElement)
    }
    aWindow.statusbar.node.appendChild(aWindow.statusbar.textNode)
    aWindow.statusbar.node.setAttribute('collapsed', !this.enabled)
  },

  async overrideStatusPanelLabel(aWindow) {
    const { StatusPanel } = aWindow.wrappedJSObject

    const originalSetter = Object.getOwnPropertyDescriptor(
      StatusPanel,
      '_label'
    ).set

    Object.defineProperty(StatusPanel, '_label', {
      set(val) {
        if (this._labelElement) {
          this._labelElement.value = val
        }
        originalSetter.call(this, val)
      },
      enumerable: true,
      configurable: true,
    })
  },

  async configureBottomBox(aWindow) {
    const { document } = aWindow
    const bottomBox = document.getElementById('browser-bottombox')
    lazy.CustomizableUI.registerToolbarNode(aWindow.statusbar.node)
    bottomBox.appendChild(aWindow.statusbar.node)
  },
}

// Inherited props
StatusBar.executeInAllWindows = lazy.BrowserUtils.executeInAllWindows
