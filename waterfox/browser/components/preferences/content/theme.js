/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { PrefUtils } = ChromeUtils.importESModule(
  'resource:///modules/PrefUtils.sys.mjs'
)

XPCOMUtils.defineLazyServiceGetter(
  this,
  'styleSheetService',
  '@mozilla.org/content/style-sheet-service;1',
  'nsIStyleSheetService'
)

const gThemePane = {
  WATERFOX_THEME_PREF: 'browser.theme.enableWaterfoxCustomizations',
  WATERFOX_CUSTOMIZATIONS_PREF: 'browser.theme.enableWaterfoxCustomizations',
  WATERFOX_DEFAULT_THEMES: [
    'default-theme@mozilla.org',
    'firefox-compact-light@mozilla.org',
    'firefox-compact-dark@mozilla.org',
    'firefox-alpenglow@mozilla.org',
  ],

  _prefObservers: [],

  get preferences() {
    return [
      // == Theme ==============================================================
      { id: 'browser.theme.enableWaterfoxCustomizations', type: 'int' },

      // Appearance
      { id: 'userChrome.theme.proton_color.dark_blue_accent', type: 'bool' },
      { id: 'userContent.page.proton_color.dark_blue_accent', type: 'bool' },

      { id: 'userContent.page.proton_color.system_accent', type: 'bool' },
      { id: 'widget.non-native-theme.use-theme-accent', type: 'bool' },

      { id: 'userChrome.theme.transparent.panel', type: 'bool' },
      { id: 'userChrome.theme.transparent.menu', type: 'bool' },

      // Icons
      { id: 'userChrome.icon.disabled', type: 'bool' },
      { id: 'userChrome.hidden.tab_icon', type: 'bool' },
      { id: 'userChrome.icon.menu.full', type: 'bool' },
      { id: 'userChrome.icon.global_menu.mac', type: 'bool' },

      // Fonts
      { id: 'userContent.page.monospace', type: 'bool' },
      { id: 'userChrome.theme.monospace', type: 'bool' },

      // Animations
      { id: 'userChrome.decoration.disable_panel_animate', type: 'bool' },
      { id: 'userChrome.decoration.disable_sidebar_animate', type: 'bool' },
      
      // == Interface Components ===============================================
      // Tab Bar
      { id: 'userChrome.tab.photon_like_contextline', type: 'bool' },
      { id: 'userChrome.padding.drag_space', type: 'bool' },
      { id: 'userChrome.tab.close_button_at_hover', type: 'bool' },

      // Nav Bar
      { id: 'userChrome.padding.urlView_expanding', type: 'bool' },

      // Panels
      { id: 'userChrome.padding.menu_compact', type: 'bool' },
      { id: 'userChrome.padding.bookmark_menu.compact', type: 'bool' },
      { id: 'userChrome.padding.panel_header', type: 'bool' },
      { id: 'userChrome.panel.remove_strip', type: 'bool' },
      { id: 'userChrome.panel.full_width_separator', type: 'bool' },

      // == Rounding ===========================================================
      // Tab Bar
      { id: 'userChrome.rounding.square_tab', type: 'bool' },
      { id: 'userChrome.tab.bottom_rounded_corner', type: 'bool' },
      { id: 'userChrome.tab.squareTabCorners', type: 'bool' },
      
      // Nav Bar
      { id: 'userChrome.rounding.square_button', type: 'bool' },
      
      // Panels
      { id: 'userChrome.rounding.square_panel', type: 'bool' },
      { id: 'userChrome.rounding.square_panelitem', type: 'bool' },
      { id: 'userChrome.rounding.square_menupopup', type: 'bool' },
      { id: 'userChrome.rounding.square_menuitem', type: 'bool' },
      { id: 'userChrome.rounding.square_field', type: 'bool' },
      { id: 'userChrome.rounding.square_checklabel', type: 'bool' },
      
      // == Autohide & Hidden ==================================================
      // Tab Bar
      { id: 'userChrome.autohide.tab', type: 'bool' },
      { id: 'userChrome.autohide.tab.blur', type: 'bool' },
      { id: 'userChrome.autohide.tabbar', type: 'bool' },

      // Nav Bar
      { id: 'userChrome.autohide.back_button', type: 'bool' },
      { id: 'userChrome.autohide.forward_button', type: 'bool' },
      { id: 'userChrome.autohide.page_action', type: 'bool' },
      { id: 'userChrome.hidden.urlbar_iconbox', type: 'bool' },

      // Bookmarks Bar
      { id: 'userChrome.autohide.bookmarkbar', type: 'bool' },
      { id: 'userChrome.hidden.bookmarkbar_icon', type: 'bool' },
      { id: 'userChrome.hidden.bookmarkbar_label', type: 'bool' },
      
      // Panels
      { id: 'userChrome.hidden.disabled_menu', type: 'bool' },

      // Sidebar
      { id: 'userChrome.autohide.sidebar', type: 'bool' },
      { id: 'userChrome.hidden.sidebar_header', type: 'bool' },
      
      // == Center =============================================================
      // Tab Bar
      { id: 'userChrome.centered.tab', type: 'bool' },
      { id: 'userChrome.centered.tab.label', type: 'bool' },
      
      // Nav Bar
      { id: 'userChrome.centered.urlbar', type: 'bool' },
    ]
  },

  get nestedPrefs() {
    return [
      {
        id: 'autoBlurTabs',
        pref: 'userChrome.autohide.tab',
      },
      {
        id: 'centerTabLabel',
        pref: 'userChrome.centered.tab',
      },
    ]
  },  

  get presets() {
    return [
      {
        id: 'waterfoxDefaults',
        on: [
          { id: 'userChrome.tab.connect_to_window', value: true },
          { id: 'userChrome.tab.color_like_toolbar', value: true },
          
          { id: 'userChrome.tab.lepton_like_padding', value: false },
          { id: 'userChrome.tab.photon_like_padding', value: true },

          { id: 'userChrome.tab.dynamic_separator', value: false },
          { id: 'userChrome.tab.static_separator', value: true },
          { id: 'userChrome.tab.static_separator.selected_accent', value: false },
          { id: 'userChrome.tab.bar_separator', value: false },

          { id: 'userChrome.tab.newtab_button_like_tab', value: false },
          { id: 'userChrome.tab.newtab_button_smaller', value: true },
          { id: 'userChrome.tab.newtab_button_proton', value: false },

          { id: 'userChrome.icon.panel_full', value: false },
          { id: 'userChrome.icon.panel_photon', value: true },

          { id: 'userChrome.tab.box_shadow', value: false },
          { id: 'userChrome.tab.bottom_rounded_corner', value: false },

          { id: 'userChrome.tab.photon_like_contextline', value: true },
          { id: 'userChrome.rounding.square_tab', value: true },
        ]
      },
      {
        id: 'leptonStyle',
        on: [
          { id: 'userChrome.tab.connect_to_window', value: true },
          { id: 'userChrome.tab.color_like_toolbar', value: true },
          
          { id: 'userChrome.tab.lepton_like_padding', value: true },
          { id: 'userChrome.tab.photon_like_padding', value: false },

          { id: 'userChrome.tab.dynamic_separator', value: true },
          { id: 'userChrome.tab.static_separator', value: false },
          { id: 'userChrome.tab.static_separator.selected_accent', value: false },
          { id: 'userChrome.tab.bar_separator', value: false },

          { id: 'userChrome.tab.newtab_button_like_tab', value: true },
          { id: 'userChrome.tab.newtab_button_smaller', value: false },
          { id: 'userChrome.tab.newtab_button_proton', value: false },

          { id: 'userChrome.icon.panel_full', value: true },
          { id: 'userChrome.icon.panel_photon', value: false },

          { id: 'userChrome.tab.box_shadow', value: true },
          { id: 'userChrome.tab.bottom_rounded_corner', value: true },

          { id: 'userChrome.tab.photon_like_contextline', value: false },
          { id: 'userChrome.rounding.square_tab', value: false },
        ]
      },
      {
        id: 'protonStyle',
        on: [
          { id: 'userChrome.tab.connect_to_window', value: false },
          { id: 'userChrome.tab.color_like_toolbar', value: false },
          
          { id: 'userChrome.tab.lepton_like_padding', value: false },
          { id: 'userChrome.tab.photon_like_padding', value: false },

          { id: 'userChrome.tab.dynamic_separator', value: true },
          { id: 'userChrome.tab.static_separator', value: false },
          { id: 'userChrome.tab.static_separator.selected_accent', value: false },
          { id: 'userChrome.tab.bar_separator', value: false },

          { id: 'userChrome.tab.newtab_button_like_tab', value: false },
          { id: 'userChrome.tab.newtab_button_smaller', value: false },
          { id: 'userChrome.tab.newtab_button_proton', value: true },

          { id: 'userChrome.icon.panel_full', value: true },
          { id: 'userChrome.icon.panel_photon', value: false },

          { id: 'userChrome.tab.box_shadow', value: false },
          { id: 'userChrome.tab.bottom_rounded_corner', value: false },

          { id: 'userChrome.tab.photon_like_contextline', value: false },
          { id: 'userChrome.rounding.square_tab', value: false },
        ]
      }
    ]
  },

  get accentPrefs() {
    return {
      '0': [
        { id: 'userChrome.theme.proton_color.dark_blue_accent', value: true },
        { id: 'userContent.page.proton_color.dark_blue_accent', value: true },

        { id: 'userContent.page.proton_color.system_accent', value: false },
        { id: 'widget.non-native-theme.use-theme-accent', value: false },
      ],
      
      '1': [
        { id: 'userChrome.theme.proton_color.dark_blue_accent', value: false },
        { id: 'userContent.page.proton_color.dark_blue_accent', value: false },

        { id: 'userContent.page.proton_color.system_accent', value: false },
        { id: 'widget.non-native-theme.use-theme-accent', value: false },
      ],

      '2': [
        { id: 'userChrome.theme.proton_color.dark_blue_accent', value: false },
        { id: 'userContent.page.proton_color.dark_blue_accent', value: false },

        { id: 'userContent.page.proton_color.system_accent', value: true },
        { id: 'widget.non-native-theme.use-theme-accent', value: true },
      ]
    }
  },  

  init() {
    // Initialize prefs
    window.Preferences.addAll(this.preferences)
    const userChromeEnabled = PrefUtils.get(this.WATERFOX_THEME_PREF)
    for (const pref of this.preferences) {
      this._prefObservers.push(
        PrefUtils.addObserver(pref.id, _ => {
          this.refreshTheme()
        })
      )
    }

    // Init presets
    for (const preset of this.presets) {
      const button = document.getElementById(preset.id)
      if (button) {
        button.addEventListener('click', event => {
          for (const pref of preset['on']) {
            PrefUtils.set(pref.id, pref.value)
          }
        })
      }
    }

    // Init default button
    const defaultButton = document.getElementById('waterfoxDefaults')
    if (defaultButton) {
      defaultButton.addEventListener('click', this)
    }

    // Init popups
    const popups = document.getElementsByClassName('popup-container')
    for (const popup of popups) {
      popup.addEventListener('mouseover', this)
      popup.addEventListener('mouseout', this)
    }

    // Init theme customizations
    const waterfoxCustomizations = document.getElementById(
      'waterfoxUserChromeCustomizations'
    )
    if (waterfoxCustomizations) {
      const presetBox = document.getElementById('waterfoxUserChromePresets')
      presetBox.hidden = userChromeEnabled === 2
      const themeGroup = document.getElementById(
        'waterfoxUserChromeCustomizations'
      )
      themeGroup.hidden = userChromeEnabled === 2

      this._prefObservers.push(
        PrefUtils.addObserver(this.WATERFOX_THEME_PREF, isEnabled => {
          presetBox.hidden = isEnabled === 2
          themeGroup.hidden = isEnabled === 2
        })
      )
    }
    
    // Init AccentColor
    this.initAccentColor()

    // Init Tab Rounding
    this.initTabRounding()

    // Init Nested Prefs
    for (const el of this.nestedPrefs) {
      this.initNestedPrefs(el.id, el.pref)
    }

    // Register unload listener
    window.addEventListener('unload', this)
  },

  destroy() {
    window.removeEventListener('unload', this)
    for (const obs of this._prefObservers) {
      PrefUtils.removeObserver(obs)
    }
  },

  // nsIDOMEventListener
  handleEvent(event) {
    switch (event.type) {
      case 'mouseover':
      case 'mouseout':
        event.target.nextElementSibling?.classList.toggle('show')
        break
      case 'click':
        switch (event.target.id) {
          case 'waterfoxDefaults':
            this.preferences.map(pref => {
              Services.prefs.clearUserPref(pref.id)
            })
            this.refreshTheme()
            break
        }
        break
      case 'unload':
        this.destroy()
        break
    }
  },

  async refreshTheme() {
    // Only refresh theme if Waterfox customizations should be applied
    if (
      PrefUtils.get(this.WATERFOX_CUSTOMIZATIONS_PREF, 0) === 0 ||
      (PrefUtils.get(this.WATERFOX_CUSTOMIZATIONS_PREF, 0) === 1 &&
        this.WATERFOX_DEFAULT_THEMES.includes(
          PrefUtils.get('extensions.activeThemeID', '')
        ))
    ) {
      const userChromeSheet = 'chrome://browser/skin/userChrome.css'
      const userContentSheet = 'chrome://browser/skin/userContent.css'

      this.unregisterStylesheet(userChromeSheet)
      this.unregisterStylesheet(userContentSheet)
      this.registerStylesheet(userChromeSheet)
      this.registerStylesheet(userContentSheet)
    }
  },

  registerStylesheet(uri) {
    const url = Services.io.newURI(uri)
    const type = styleSheetService.USER_SHEET
    styleSheetService.loadAndRegisterSheet(url, type)
  },

  unregisterStylesheet(uri) {
    const url = Services.io.newURI(uri)
    const type = styleSheetService.USER_SHEET
    styleSheetService.unregisterSheet(url, type)
  },

  async initAccentColor() {
    let menulist = document.getElementById('accentColor')
    // If it doesn't exist yet, try again.
    while (!menulist) {
      const wait = ms => new Promise(res => setTimeout(res, ms, {}))
      await wait(500)
      menulist = document.getElementById('accentColor')
    }

    menulist?.addEventListener("command", () => {
      if (['0', '1', '2'].includes(menulist.value)) {
        for (const pref of this.accentPrefs[menulist.value]) {
          PrefUtils.set(pref.id, pref.value)
        }
      } 
    })
  },

  async initTabRounding() {
    let checkbox = document.getElementById('squareTabCorners')
    // If it doesn't exist yet, try again.
    while (!checkbox) {
      const wait = ms => new Promise(res => setTimeout(res, ms, {}))
      await wait(500)
      checkbox = document.getElementById('squareTabCorners')
    }

    // Update the checkbox initially, and observe pref changes.
    this.updateTabRoundingCheckbox()
    this._prefObservers.push(
      PrefUtils.addObserver('userChrome.tab.squareTabCorners', square => {
        PrefUtils.set('userChrome.rounding.square_tab', square)
        PrefUtils.set('userChrome.tab.bottom_rounded_corner', !square)
      })
    )
  },

  updateTabRoundingCheckbox() {
    const checkbox = document.getElementById('squareTabCorners')
    const enabled = PrefUtils.get(
      'userChrome.tab.squareTabCorners',
      PrefUtils.get('userChrome.rounding.square_tab', false) &&
        PrefUtils.set('userChrome.tab.bottom_rounded_corner', true)
    )

    checkbox.checked = enabled
  },

  async initNestedPrefs(id, controllingPref) {
    let checkbox = document.getElementById(id)
    // If it doesn't exist yet, try again.
    while (!checkbox) {
      const wait = ms => new Promise(res => setTimeout(res, ms, {}))
      await wait(500)
      checkbox = document.getElementById(id)
    }
    const enabled = PrefUtils.get(controllingPref, false)

    checkbox.setAttribute('disabled', !enabled)

    this._prefObservers.push(
      PrefUtils.addObserver(controllingPref, (enabled, pref) => {
        // We need this as observer fires for pref and pref.<some sub path>
        if (pref !== controllingPref) {
          return
        }
        const checkbox = document.getElementById(id)
        checkbox.setAttribute('disabled', !enabled)
      })
    )
  },
}
