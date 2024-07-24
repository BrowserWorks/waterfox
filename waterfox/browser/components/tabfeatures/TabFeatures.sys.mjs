/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { AppConstants } = ChromeUtils.importESModule(
  'resource://gre/modules/AppConstants.sys.mjs'
)

const lazy = {}

ChromeUtils.defineESModuleGetters(lazy, {
  AboutNewTab: 'resource:///modules/AboutNewTab.sys.mjs',
})

export const TabFeatures = {
  NEW_TAB_CONFIG_PATH: 'browser.newtab.url',
  newTabURL: null,
  prefListener: null,
  PREF_ACTIVETAB: 'browser.tabs.copyurl.activetab',
  PREF_REQUIRECONFIRM: 'browser.restart_menu.requireconfirm',
  PREF_PURGECACHE: 'browser.restart_menu.purgecache',

  init(window) {
    window.TabFeatures = this
    this.initListeners(window)
    this.initNewTabConfig()
    this.initNewTabFocus(window)
  },

  destroy() {
    this.destroyNewTabConfig()
  },

  initListeners(aWindow) {
    aWindow.document
      .getElementById('tabContextMenu')
      ?.addEventListener('popupshowing', this.tabContext)
    if (AppConstants.platform === 'macosx') {
      aWindow.document
        .getElementById('file-menu')
        ?.addEventListener('popupshowing', this.tabContext)
    } else {
      aWindow.document
        .getElementById('appMenu-popup')
        ?.addEventListener('popupshowing', this.tabContext)
    }
  },

  initNewTabConfig() {
    // Fetch pref if it exists
    this.newTabURL = Services.prefs.getStringPref(this.NEW_TAB_CONFIG_PATH, '')

    // Only proceed if a value is actually set
    if (this.newTabURL) {
      try {
        lazy.AboutNewTab.newTabURL = this.newTabURL
        this.prefListener = Services.prefs.addObserver(
          this.NEW_TAB_CONFIG_PATH,
          (subject, topic, data) => {
            const newURL = Services.prefs.getStringPref(
              this.NEW_TAB_CONFIG_PATH,
              ''
            )
            if (newURL) {
              lazy.AboutNewTab.newTabURL = newURL
            } else {
              // If the pref is cleared, revert to default behavior
              lazy.AboutNewTab.resetNewTabURL()
            }
          }
        )
      } catch (e) {
        console.error('Error initializing new tab config:', e)
      }
    }
  },

  initNewTabFocus(window) {
    window.gBrowser.tabContainer.addEventListener('TabOpen', event => {
      const tab = event.target
      const browser = window.gBrowser.getBrowserForTab(tab)

      browser.addEventListener(
        'load',
        function onLoad() {
          browser.removeEventListener('load', onLoad)
          window.setTimeout(() => {
            browser.contentWindow.focus()
          }, 0)
        },
        { once: true }
      )
    })
  },

  destroyNewTabConfig() {
    if (this.prefListener) {
      Services.prefs.removeObserver(this.NEW_TAB_CONFIG_PATH, this.prefListener)
      this.prefListener = null
    }
  },

  tabContext(aEvent) {
    let win = aEvent.view
    if (!win) {
      win = Services.wm.getMostRecentWindow('navigator:browser')
    }
    const { document } = win
    const elements = document.getElementsByClassName('tabFeature')
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const pref = el.getAttribute('preference')
      if (pref) {
        const visible = Services.prefs.getBoolPref(pref)
        el.hidden = !visible
      }
    }
    // Can't unload selected tab, so don't show menu item in that case
    if (win.TabContextMenu.contextTab === win.gBrowser.selectedTab) {
      const el = document.getElementById('context_unloadTab')
      el.hidden = true
    }
  },

  // Copies current tab url to clipboard
  copyTabUrl(aUri, aWindow) {
    const gClipboardHelper = Cc[
      '@mozilla.org/widget/clipboardhelper;1'
    ].getService(Ci.nsIClipboardHelper)
    try {
      Services.prefs.getBoolPref(this.PREF_ACTIVETAB)
        ? gClipboardHelper.copyString(aWindow.gBrowser.currentURI.spec)
        : gClipboardHelper.copyString(aUri)
    } catch (e) {
      throw new Error(
        `We're sorry but something has gone wrong with 'CopyTabUrl' ${e}`
      )
    }
  },

  // Copies all tab urls to clipboard
  copyAllTabUrls(aWindow) {
    const gClipboardHelper = Cc[
      '@mozilla.org/widget/clipboardhelper;1'
    ].getService(Ci.nsIClipboardHelper)
    //Get all urls
    const urlArr = this._getAllUrls(aWindow)
    try {
      // Enumerate all urls in to a list.
      let urlList = urlArr.join('\n')
      // Send list to clipboard.
      gClipboardHelper.copyString(urlList.trim())
      // Clear url list after clipboard event
      urlList = ''
    } catch (e) {
      throw new Error(
        `We're sorry but something has gone wrong with 'copyAllTabUrls' ${e}`
      )
    }
  },

  // Get all the tab urls into an array.
  _getAllUrls(aWindow) {
    // We don't want to copy about uri's
    const blocklist = /^about:.*/i
    const urlArr = []
    const tabCount = aWindow.gBrowser.browsers.length
    Array(tabCount)
      .fill()
      .map((_, i) => {
        const spec = aWindow.gBrowser.getBrowserAtIndex(i).currentURI.spec
        if (!blocklist.test(spec)) {
          urlArr.push(spec)
        }
      })
    return urlArr
  },

  async restartBrowser() {
    try {
      if (Services.prefs.getBoolPref(this.PREF_REQUIRECONFIRM)) {
        // Need brand in here to be able to expand { -brand-short-name }
        const l10n = new Localization([
          'branding/brand.ftl',
          'browser/waterfox.ftl',
        ])
        const [title, question] = (
          await l10n.formatMessages([
            { id: 'restart-prompt-title' },
            { id: 'restart-prompt-question' },
          ])
        ).map(({ value }) => value)

        if (Services.prompt.confirm(null, title, question)) {
          // only restart if confirmation given
          this._attemptRestart()
        }
      } else {
        this._attemptRestart()
      }
    } catch (e) {
      console.error(
        "We're sorry but something has gone wrong with 'restartBrowser' ",
        e
      )
    }
  },

  _attemptRestart() {
    // Purge cache if required
    if (Services.prefs.getBoolPref(this.PREF_PURGECACHE)) {
      Services.appinfo.invalidateCachesOnRestart()
    }

    // Initiate the restart
    Services.startup.quit(
      Services.startup.eRestart | Services.startup.eAttemptQuit
    )
  },
}
