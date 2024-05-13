/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
'use strict';

const HTML = 'http://www.w3.org/1999/xhtml';
const XUL  = 'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul';

const TYPE_TREE = 'application/x-ws-tree';
const TST_ID = 'treestyletab@piro.sakura.ne.jp';

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: 'resource://gre/modules/AddonManager.sys.mjs',
  CustomizableUI: 'resource:///modules/CustomizableUI.sys.mjs',
  ExtensionPermissions: 'resource://gre/modules/ExtensionPermissions.sys.mjs',
  PageThumbs: 'resource://gre/modules/PageThumbs.sys.mjs',
  PlacesUtils: 'resource://gre/modules/PlacesUtils.sys.mjs',
});

// Range.createContextualFragment() unexpectedly drops XUL elements.
// Moreover, the security mechanism of the browser rejects adoptation of elements
// created by DOMParser(). Thus we need to create elements manually...
function element(document, NS, localName, attributes, children) {
  if (Array.isArray(attributes)) {
    children   = attributes;
    attributes = {};
  }
  const element = document.createElementNS(NS, localName);
  if (attributes) {
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
  }
  if (children) {
    for (const child of children) {
      if (typeof child == 'string')
        element.appendChild(document.createTextNode(child));
      else
        element.appendChild(child);
    }
  }
  return element;
}

const BrowserWindowWatcher = {
  WATCHING_URLS: [
    'chrome://browser/content/browser.xhtml',
  ],
  BASE_URL: null, // this need to be replaced with "moz-extension://..../"
  BASE_PREF: 'browser.sidebar.', // null,
  locale:   null, // this need to be replaced with a map
  loadingForbiddenURLs: [],
  autoplayBlockedListeners: new Set(),
  autoplayUnblockedListeners: new Set(),
  visibilityChangedListeners: new Set(),
  menuCommandListeners: new Set(),
  sidebarShownListeners: new Set(),
  sidebarHiddenListeners: new Set(),
  lastTransferredFiles: new Map(),

  handleWindow(win) {
    if (!win ||
        !win.location)
      return false;

    const document = win.document;
    if (!document)
      return false;

    if (win.location.href.startsWith('chrome://browser/content/browser.xhtml')) {
      const installed = this.installTabsSidebar(win);
      if (installed) {
        this.patchToTabPreviewModules(win);
        this.patchToPlacesModules(win);
        this.patchToFullScreenModules(win);
        win.addEventListener('DOMAudioPlaybackBlockStarted', this, { capture: true });
        win.addEventListener('DOMAudioPlaybackBlockStopped', this, { capture: true });
        win.addEventListener('visibilitychange', this);
      }
      return installed;
    }

    return true;
  },

  unhandleWindow(win) {
    if (!win ||
        !win.location)
      return;

    const document = win.document;
    if (!document)
      return;

    if (win.location.href.startsWith('chrome://browser/content/browser.xhtml')) {
      this.uninstallTabsSidebar(win);
      try {
        this.unpatchTabPreviewModules(win);
        this.unpatchPlacesModules(win);
        this.unpatchFullScreenModules(win);
        win.removeEventListener('DOMAudioPlaybackBlockStarted', this, { capture: true });
        win.removeEventListener('DOMAudioPlaybackBlockStopped', this, { capture: true });
        win.removeEventListener('visibilitychange', this);
      }
      catch(_error) {
      }
    }
  },

  installTabsSidebar(win) {
    const document = win.document;

    if (document.querySelector('#tabs-sidebar-style'))
      return true;

    this.updateTabsSidebarPositionIn(document);

    const range = document.createRange();

    range.selectNode(document.head);
    range.collapse(false);
    range.insertNode(element(document, HTML, 'style', {
      id: 'tabs-sidebar-style',
    }, [`
      :root.hide-horizontal-tabs-while-tabs-sidebar-is-active.tabs-sidebar-is-active #TabsToolbar {
        visibility: collapse;
      }

      /* toolbar button */
      #toggle-tabs-sidebar {
        list-style-image: url("${this.BASE_URL}resources/16x16.svg#toolbar-context");
      }
      #toggle-tabs-sidebar image {
        -moz-context-properties: fill, fill-opacity;
        color: inherit;
        fill: currentColor;
        min-height: 16px;
        min-width: 16px;
      }

      /* tabs sidebar box */
      #tabs-sidebar-box {
        background-color: var(--sidebar-background-color);
        color: var(--sidebar-text-color);
        text-shadow: none;
        min-width: 50px;
      }
      :root[BookmarksToolbarOverlapsBrowser] #tabs-sidebar-box {
        padding-top: var(--bookmarks-toolbar-overlapping-browser-height);
      }
      /* tabs sidebar header */
      #tabs-sidebar-header {
        background-color: var(--toolbar-bgcolor);
        font-size: 1.333em;
        padding: 4px;
        border-bottom: 1px solid var(--sidebar-border-color);
      }
      #tabs-sidebar-header toolbarbutton image {
        -moz-context-properties: fill, fill-opacity;
        color: inherit;
        fill: currentColor;
        height: 12px;
        width: 12px;
      }
      #tabs-sidebar-header separator {
        height: 18px;
      }
      #tabs-sidebar-spacer {
        flex: 1000 1000;
      }
      #tabs-sidebar-header toolbarbutton {
        appearance: none;
        border-radius: 0.2em;
      }
      #tabs-sidebar-header toolbarbutton:hover {
        background: var(--toolbarbutton-hover-background);
      }
      #tabs-sidebar-tabsViewBox {
        background: rgba(0, 0, 0, 0.25);
        border-radius: 0.2em;
        line-height: 1;
        padding: 1px;
      }
      #tabs-sidebar-tabsPreview,
      #tabs-sidebar-tabsList {
        border-radius: calc(0.2em - 1px);
        margin: 0;
      }
      #tabs-sidebar-tabsPreview[checked="true"],
      #tabs-sidebar-tabsList[checked="true"] {
        background: var(--toolbar-bgcolor);
      }
      #tabs-sidebar-tabsPreview {
        list-style-image: url("${this.BASE_URL}resources/icons/tabs-preview.svg");
      }
      #tabs-sidebar-tabsList {
        border-radius: 0 0.2em 0.2em 0;
        list-style-image: url("${this.BASE_URL}resources/icons/tabs-list.svg");
      }
      #tabs-sidebar-tabsPreview image,
      #tabs-sidebar-tabsList image {
        z-index: 100;
      }
      #tabs-sidebar-options {
        appearance: none;
        list-style-image: url("chrome://global/skin/icons/settings.svg");
      }
      #tabs-sidebar-options image.toolbarbutton-arrow {
        list-style-image: url(chrome://global/skin/icons/arrow-down-12.svg);
        width: 10px;
        height: 10px;
        pointer-events: none; /* this is required to accept click events on the arrow */
      }
      :root:not(.tabs-sidebar-right) #tabs-sidebar-moveLeft,
      :root.tabs-sidebar-right #tabs-sidebar-moveRight {
        display: none;
      }
      @supports not -moz-bool-pref("userChrome.icon.disabled") {
        @supports -moz-bool-pref("userChrome.icon.menu") {
          @supports -moz-bool-pref("userChrome.icon.context_menu") {
            #tabs-sidebar-newTab {
              list-style-image: var(--uc-new-tab-icon);
            }
            #tabs-sidebar-reloadTab,
            #tabs-sidebar-reloadTabs {
              list-style-image: url("chrome://browser/skin/lepton/reload.svg");
            }
            #tabs-sidebar-bookmarkTab,
            #tabs-sidebar-bookmarkTabs {
              list-style-image: url("chrome://browser/skin/bookmark.svg");
            }
            #tabs-sidebar-selectAll {
              list-style-image: var(--uc-tab-multiple-icon);
            }
            #tabs-sidebar-undoClose {
              list-style-image: url("chrome://browser/skin/lepton/undo.svg");
            }
            #tabs-sidebar-moreOptions {
              list-style-image: url("chrome://global/skin/icons/settings.svg");
            }
          }
        }
      }
      #tabs-sidebar-options-separator {
        border-left: 1px solid;
        margin: 0 0.5em;
        opacity: 0.5;
      }

      #tabs-sidebar {
        flex: 1;
      }

      /* order of UI elements */
      /* leftside, with leftside built-in sidebar */
      :root:not(.tabs-sidebar-right) #sidebar-box:not([positionend="true"]) {
        order: 1 !important;
      }
      :root:not(.tabs-sidebar-right) #sidebar-box:not([positionend="true"]) ~ #sidebar-splitter {
        order: 2 !important;
      }
      :root:not(.tabs-sidebar-right) #sidebar-box:not([positionend="true"]) ~ #tabs-sidebar-box {
        order: 3 !important;
      }
      :root:not(.tabs-sidebar-right) #sidebar-box:not([positionend="true"]) ~ #tabs-sidebar-splitter {
        order: 4 !important;
      }
      :root:not(.tabs-sidebar-right) #sidebar-box:not([positionend="true"]) ~ #appcontent {
        order: 5 !important;
      }
      /* rightside, with leftside built-in sidebar */
      :root.tabs-sidebar-right #sidebar-box:not([positionend="true"]) {
        order: 1 !important;
      }
      :root.tabs-sidebar-right #sidebar-box:not([positionend="true"]) ~ #sidebar-splitter {
        order: 2 !important;
      }
      :root.tabs-sidebar-right #sidebar-box:not([positionend="true"]) ~ #appcontent {
        order: 3 !important;
      }
      :root.tabs-sidebar-right #sidebar-box:not([positionend="true"]) ~ #tabs-sidebar-splitter {
        order: 4 !important;
      }
      :root.tabs-sidebar-right #sidebar-box:not([positionend="true"]) ~ #tabs-sidebar-box {
        order: 5 !important;
      }
      /* leftside, with rightside built-in sidebar */
      :root:not(.tabs-sidebar-right) #sidebar-box[positionend="true"] ~ #tabs-sidebar-box {
        order: 1 !important;
      }
      :root:not(.tabs-sidebar-right) #sidebar-box[positionend="true"] ~ #tabs-sidebar-splitter {
        order: 2 !important;
      }
      :root:not(.tabs-sidebar-right) #sidebar-box[positionend="true"] ~ #appcontent {
        order: 3 !important;
      }
      :root:not(.tabs-sidebar-right) #sidebar-box[positionend="true"] ~ #sidebar-splitter {
        order: 4 !important;
      }
      :root:not(.tabs-sidebar-right) #sidebar-box[positionend="true"] {
        order: 5 !important;
      }
      /* rightside, with rightside built-in sidebar */
      :root.tabs-sidebar-right #sidebar-box[positionend="true"] ~ #appcontent {
        order: 1 !important;
      }
      :root.tabs-sidebar-right #sidebar-box[positionend="true"] ~ #tabs-sidebar-splitter {
        order: 2 !important;
      }
      :root.tabs-sidebar-right #sidebar-box[positionend="true"] ~ #tabs-sidebar-box {
        order: 3 !important;
      }
      :root.tabs-sidebar-right #sidebar-box[positionend="true"] ~ #sidebar-splitter {
        order: 4 !important;
      }
      :root.tabs-sidebar-right #sidebar-box[positionend="true"] {
        order: 5 !important;
      }

      :root[inDOMFullscreen] #tabs-sidebar-box,
      :root[inDOMFullscreen] #tabs-sidebar-splitter {
        visibility: collapse;
      }

      #tabs-sidebar-box[fullscreenShouldAnimate] {
        transition: 0.8s margin-left ease-out,
                    0.8s margin-right ease-out;
      }
      @supports -moz-bool-pref("userChrome.fullscreen.overlap") {
        @supports -moz-bool-pref("browser.fullscreen.autohide") {
          :root[sizemode="fullscreen"] #tabs-sidebar-box,
          :root[sizemode="fullscreen"] #tabs-sidebar-splitter {
            position: fixed !important;
            z-index: 900 !important;
            height: 100% !important;
          }
          :root[sizemode="fullscreen"] #tabs-sidebar-splitter {
            width: 5px !important;
            z-index: 890 !important;
          }
          :root[sizemode="fullscreen"]:not(.tabs-sidebar-right) #tabs-sidebar-box,
          :root[sizemode="fullscreen"]:not(.tabs-sidebar-right) #tabs-sidebar-splitter {
            left: 0;
          }
          :root[sizemode="fullscreen"].tabs-sidebar-right #tabs-sidebar-box,
          :root[sizemode="fullscreen"].tabs-sidebar-right #tabs-sidebar-splitter {
            right: 0;
          }
        }
      }

      @media (prefers-reduced-motion: no-preference) {
        @supports -moz-bool-pref("userChrome.decoration.animate") {
          :root[sizemode="fullscreen"] #tabs-sidebar-box {
            transition: margin-left 1.3s var(--animation-easing-function) 50ms,
                        margin-right 1.3s var(--animation-easing-function) 50ms !important;
          }
        }
      }
    `.trim()]));

    // Note: keyboard shortcuts defined by XUL command/key become unavailable after
    // they are removed and re-insertedby reloading of this addon. For consistensy
    // it may need to be implemented without XUL elements...
    document.querySelector('#mainCommandSet').appendChild(element(document, XUL, 'command', {
      id: 'toggle-tabs-sidebar-command',
    }));
    document.querySelector('#mainKeyset').appendChild(element(document, XUL, 'key', {
      id:      'toggle-tabs-sidebar-key',
      keycode: 'VK_F1',
      command: 'toggle-tabs-sidebar-command',
    }));

    document.querySelector('#viewSidebarMenu').appendChild(element(document, XUL, 'menuseparator', {
      id: 'viewmenu-tabs-sidebar-separator',
    }));
    document.querySelector('#viewSidebarMenu').appendChild(element(document, XUL, 'menuitem', {
      id:    'viewmenu-toggle-tabs-sidebar',
      type:  'checkbox',
      label: this.locale.get('tabsSidebarButton_label'),
      key:   'toggle-tabs-sidebar-key',
    }));

    const elements = document.createDocumentFragment();

    const shouldShowSidebar = this.shouldShowSidebar(document);

    const width = Services.xulStore.getValue(document.URL, 'tabs-sidebar-box', 'width') || 200;
    elements.appendChild(element(document, XUL, 'box', {
      id:    'tabs-sidebar-box',
      class: 'chromeclass-extrachrome',
      orient: 'vertical',
      style: `width: ${width}px;`,
      width: width,
      ...(shouldShowSidebar ? {} : { hidden: 'true' }),
    }, [
      element(document, XUL, 'hbox', {
        id:    'tabs-sidebar-header',
        align: 'center',
      }, [
        element(document, XUL, 'hbox', { id: 'tabs-sidebar-tabsViewBox' }, [
          element(document, XUL, 'toolbarbutton', {
            id:    'tabs-sidebar-tabsPreview',
            class: 'toolbarbutton-1',
            tooltiptext: this.locale.get('tabsPreviewButton_tooltip'),
            type:  'checkbox',
          }, [
            element(document, XUL, 'image', {
              class: 'toolbarbutton-icon',
            }),
            element(document, XUL, 'label', {
              class: 'toolbarbutton-text',
              crop:  'end',
              flex:  '1',
            }),
          ]),
          element(document, XUL, 'toolbarbutton', {
            id:    'tabs-sidebar-tabsList',
            class: 'toolbarbutton-1',
            tooltiptext: this.locale.get('tabsListButton_tooltip'),
            type:  'checkbox',
          }, [
            element(document, XUL, 'image', {
              class: 'toolbarbutton-icon',
            }),
            element(document, XUL, 'label', {
              class: 'toolbarbutton-text',
              crop:  'end',
              flex:  '1',
            }),
          ]),
        ]),
        element(document, XUL, 'spacer', {
          id:    'tabs-sidebar-spacer',
        }),
        element(document, XUL, 'toolbarbutton', {
          id:    'tabs-sidebar-options',
          class: 'toolbarbutton-1',
          type:  'menu',
          tooltiptext: this.locale.get('optionsButton_tooltip'),
        }, [
          element(document, XUL, 'panel', {
            id:       'tabs-sidebar-options-menupopup',
            class:    'cui-widget-panel',
            role:     'group',
            type:     'arrow',
            flip:     'slide',
            orient:   'vertical',
            position: 'bottomleft topleft',
            slide:    'top',
            consumeoutsideclicks: 'false',
          }, [
            element(document, XUL, 'toolbarbutton', {
              id:        'tabs-sidebar-moveLeft',
              class:     'subviewbutton',
              label:     this.locale.get('optionsButton_moveLeft_label'),
              accesskey: this.locale.get('optionsButton_moveLeft_accesskey'),
            }),
            element(document, XUL, 'toolbarbutton', {
              id:        'tabs-sidebar-moveRight',
              class:     'subviewbutton',
              label:     this.locale.get('optionsButton_moveRight_label'),
              accesskey: this.locale.get('optionsButton_moveRight_accesskey'),
            }),
            element(document, XUL, 'toolbarseparator'),
            element(document, XUL, 'toolbarbutton', {
              id:        'tabs-sidebar-newTab',
              class:     'subviewbutton',
              label:     this.sanitizeMenuLabel(this.locale.get('tabContextMenu_newTab_label')),
              accesskey: this.extractAccessKey(this.locale.get('tabContextMenu_newTab_label')),
              //command:   'cmd_newNavigatorTab', // same to #toolbar-context-openANewTab
            }),
            element(document, XUL, 'toolbarseparator'),
            element(document, XUL, 'toolbarbutton', {
              id:        'tabs-sidebar-reloadTab',
              class:     'subviewbutton',
              label:     this.sanitizeMenuLabel(this.locale.get('tabContextMenu_reloadSelected_label')),
              accesskey: this.extractAccessKey(this.locale.get('tabContextMenu_reloadSelected_label')),
            }),
            element(document, XUL, 'toolbarbutton', {
              id:        'tabs-sidebar-reloadTabs',
              class:     'subviewbutton',
              label:     this.sanitizeMenuLabel(this.locale.get('tabContextMenu_reloadSelected_label_multiselected')),
              accesskey: this.extractAccessKey(this.locale.get('tabContextMenu_reloadSelected_label_multiselected')),
            }),
            element(document, XUL, 'toolbarbutton', {
              id:        'tabs-sidebar-bookmarkTab',
              class:     'subviewbutton',
              label:     this.sanitizeMenuLabel(this.locale.get('tabContextMenu_bookmarkSelected_label')),
              accesskey: this.extractAccessKey(this.locale.get('tabContextMenu_bookmarkSelected_label')),
            }),
            element(document, XUL, 'toolbarbutton', {
              id:        'tabs-sidebar-bookmarkTabs',
              class:     'subviewbutton',
              label:     this.sanitizeMenuLabel(this.locale.get('tabContextMenu_bookmarkSelected_label_multiselected')),
              accesskey: this.extractAccessKey(this.locale.get('tabContextMenu_bookmarkSelected_label_multiselected')),
            }),
            element(document, XUL, 'toolbarbutton', {
              id:        'tabs-sidebar-selectAll',
              class:     'subviewbutton',
              label:     this.sanitizeMenuLabel(this.locale.get('tabContextMenu_selectAllTabs_label')),
              accesskey: this.extractAccessKey(this.locale.get('tabContextMenu_selectAllTabs_label')),
            }),
            element(document, XUL, 'toolbarbutton', {
              id:        'tabs-sidebar-undoClose',
              class:     'subviewbutton',
              label:     this.sanitizeMenuLabel(this.locale.get('tabContextMenu_undoClose_label')),
              accesskey: this.extractAccessKey(this.locale.get('tabContextMenu_undoClose_label')),
            }),
            element(document, XUL, 'toolbarseparator'),
            element(document, XUL, 'toolbarbutton', {
              id:        'tabs-sidebar-moreOptions',
              class:     'subviewbutton',
              label:     this.locale.get('optionsButton_moreOptions_label'),
              accesskey: this.locale.get('optionsButton_moreOptions_accesskey'),
            }),
          ]),
          element(document, XUL, 'image', {
            class: 'toolbarbutton-icon',
          }),
          element(document, XUL, 'label', {
            class: 'toolbarbutton-text',
            crop:  'end',
            flex:  '1',
          }),
          element(document, XUL, 'image', {
            class: 'toolbarbutton-arrow',
          }),
        ]),
        element(document, XUL, 'separator', {
          id: 'tabs-sidebar-options-separator',
        }),
        element(document, XUL, 'toolbarbutton', {
          id:    'tabs-sidebar-close',
          class: 'close-icon tabbable',
          tooltiptext: this.locale.get('closeButton_tooltip'),
        }, [
          element(document, XUL, 'image', {
            class: 'toolbarbutton-icon',
          }),
          element(document, XUL, 'label', {
            class: 'toolbarbutton-text',
            crop:  'end',
            flex:  '1',
          }),
        ]),
      ]),
      element(document, XUL, 'browser', {
        id:                'tabs-sidebar',
        autoscroll:        'false',
        disablehistory:    'true',
        disablefullscreen: 'true',
        tooltip:           'aHTMLTooltip',
        src:               'chrome://browser/content/webext-panels.xhtml',
      }),
    ]));

    elements.appendChild(element(document, XUL, 'splitter', {
      id:           'tabs-sidebar-splitter',
      class:        'chromeclass-extrachrome sidebar-splitter',
      resizebefore: 'sibling',
      resizeafter:  'none',
      ...(shouldShowSidebar ? {} : { hidden: 'true' }),
    }));

    range.selectNode(document.querySelector('#appcontent'));
    range.collapse(true);
    range.insertNode(elements);
    range.detach();

    document.querySelector('#tabs-sidebar').addEventListener('load', () => {
      document.querySelector('#tabs-sidebar').contentWindow.loadPanel(
        this.EXTENSION_ID,
        `${this.BASE_URL}sidebar/sidebar.html`,
        false
      );
    }, { capture: true, once: true });
    document.querySelector('#tabs-sidebar').addEventListener('dragover', event => {
      this.lastTransferredFiles.clear();
      for (const file of event.dataTransfer.files) {
        const fileInternal = Cc['@mozilla.org/file/local;1']
          .createInstance(Components.interfaces.nsIFile);
        fileInternal.initWithPath(file.mozFullPath);
        const url = Services.io.getProtocolHandler('file')
          .QueryInterface(Components.interfaces.nsIFileProtocolHandler)
          .getURLSpecFromActualFile(fileInternal);
        this.lastTransferredFiles[this.getKeyFromFile(file)] = url;
      }
    }, { capture: true });

    document.addEventListener('SidebarShown', this, { capture: true });
    document.addEventListener('popupshowing', this);
    document.addEventListener('command', this);
    document.querySelector('#tabs-sidebar-splitter').addEventListener('mouseup', this);
    document.addEventListener('customizationchange', this, { capture: true });

    this.updateTabsViewButtons(document);
    this.updateToggleButton(document);
    this.updateHorizontalTabsState(document);

    return true;
  },

  getKeyFromFile(file) {
    if (!file)
      return '';
    return `${file.name}?lastModified=${file.lastModified}&size=${file.size}&type=${file.type}`;
  },
  getFileURL(file) {
    if (!file)
      return '';
    return this.lastTransferredFiles[this.getKeyFromFile(file)];
  },

  sanitizeMenuLabel(label) {
    return label.replace(/\(&[a-z0-9]\)$/i, '').replace(/&([a-z0-9])/i, '$1');
  },

  extractAccessKey(label) {
    if (/\(&([a-z0-9])\)$/i.test(label) ||
        /&([a-z0-9])/i.test(label))
      return RegExp.$1;

    return null;
  },

  updateOptionsPopup(menupopup) {
    const gBrowser = menupopup.ownerDocument.defaultView.gBrowser;
    const multiselected = gBrowser.multiSelectedTabsCount > 0;
    menupopup.querySelector('#tabs-sidebar-reloadTab').hidden = multiselected;
    menupopup.querySelector('#tabs-sidebar-reloadTabs').hidden = !multiselected;
    menupopup.querySelector('#tabs-sidebar-bookmarkTab').hidden = multiselected;
    menupopup.querySelector('#tabs-sidebar-bookmarkTabs').hidden = !multiselected;
  },

  shouldShowSidebar(document) {
    // it should be hidden by default, as a built-in feature of Waterfox
    return Services.xulStore.getValue(document.URL, 'tabs-sidebar-box', 'shown') == 'true';
  },

  uninstallTabsSidebar(win) {
    const document = win.document;

    document.documentElement.classList.remove('hide-horizontal-tabs-while-tabs-sidebar-is-active');
    document.documentElement.classList.remove('tabs-sidebar-is-active');
    win.TabsInTitlebar.allowedBy('TabsSidebar', true);

    document.removeEventListener('SidebarShown', this, { capture: true });
    document.removeEventListener('popupshowing', this);
    document.removeEventListener('command', this);
    document.querySelector('#tabs-sidebar-splitter').removeEventListener('mouseup', this);
    document.removeEventListener('customizationchange', this, { capture: true });

    for (const node of document.querySelectorAll(`
      #tabs-sidebar-splitter,
      #tabs-sidebar-box,
      #toggle-tabs-sidebar-key,
      #toggle-tabs-sidebar-command,
      #viewmenu-tabs-sidebar-separator,
      #viewmenu-toggle-tabs-sidebar,
      #tabs-sidebar-style
    `)) {
      node.parentNode.removeChild(node);
    }
  },

  patchToPlacesModules(win) {
    if (!win.PlacesControllerDragHelper.__ws_orig__getMostRelevantFlavor)
      win.PlacesControllerDragHelper.__ws_orig__getMostRelevantFlavor = win.PlacesControllerDragHelper.getMostRelevantFlavor;
    win.PlacesControllerDragHelper.getMostRelevantFlavor = function(flavours) {
      if (flavours.contains(TYPE_TREE))
        return TYPE_TREE;

      return this.__ws_orig__getMostRelevantFlavor(flavours);
    };

    if (!win.PlacesControllerDragHelper.__ws_orig__canDrop)
      win.PlacesControllerDragHelper.__ws_orig__canDrop = win.PlacesControllerDragHelper.canDrop;
    win.PlacesControllerDragHelper.canDrop = function(insertionPoint, dataTransfer) {
      if (dataTransfer.mozTypesAt(0).contains(TYPE_TREE))
        return true;

      return this.__ws_orig__canDrop(insertionPoint, dataTransfer);
    };
  },

  unpatchPlacesModules(win) {
    if (win.PlacesControllerDragHelper.__ws_orig__getMostRelevantFlavor) {
      win.PlacesControllerDragHelper.getMostRelevantFlavor = win.PlacesControllerDragHelper.__ws_orig__getMostRelevantFlavor;
      win.PlacesControllerDragHelper.__ws_orig__getMostRelevantFlavor = null;
    }

    if (win.PlacesControllerDragHelper.__ws_orig__canDrop) {
      win.PlacesControllerDragHelper.canDrop = win.PlacesControllerDragHelper.__ws_orig__canDrop;
      win.PlacesControllerDragHelper.__ws_orig__canDrop = null;
    }
  },

  patchToTabPreviewModules(win) {
    const tabPreview = win.document.querySelector('#tabbrowser-tab-preview');
    if (!tabPreview ||
        !tabPreview.showPreview)
      return;

    tabPreview.__ws__calculateCoordinates = () => {
      const tabsSidebar = win.document.querySelector('#tabs-sidebar');
      const tabsSidebarRect = tabsSidebar.getBoundingClientRect();
      const align = win.document.documentElement.classList.contains('tabs-sidebar-right') ? 'right' : 'left';
      const previewRect = tabPreview.panel.getBoundingClientRect();
      const x = align == 'left' ?
        tabsSidebar.screenX + tabsSidebarRect.width - 2 :
        tabsSidebar.screenX - previewRect.width + 2;
      const y = Math.min(tabsSidebar.screenY + tabPreview.__ws__top, tabsSidebar.screenY + tabsSidebarRect.height - previewRect.height);
      return [x, y];
    };

    if (!tabPreview.__ws_orig__showPreview)
      tabPreview.__ws_orig__showPreview = tabPreview.showPreview;
    tabPreview.showPreview = function() {
      if (typeof this.__ws__top == 'number') {
        const [x, y] = tabPreview.__ws__calculateCoordinates();
        this.panel.openPopupAtScreen(x, y, false);
      }
      else {
        this.panel.openPopup(this.tab, {
          position: 'bottomleft topleft',
          y: -2,
          isContextMenu: false,
        });
      }
      win.addEventListener('wheel', this, {
        capture: true,
        passive: true,
      });
      win.addEventListener('TabSelect', this);
      this.panel.addEventListener('popuphidden', this);
    };

    if (!tabPreview.panel.__ws_orig__moveToAnchor)
      tabPreview.panel.__ws_orig__moveToAnchor = tabPreview.panel.moveToAnchor;
    tabPreview.panel.moveToAnchor = function(...args) {
      if (typeof tabPreview.__ws__top == 'number') {
        const [x, y] = tabPreview.__ws__calculateCoordinates();
        this.moveTo(x, y);
        return;
      }
      return this.__ws_orig__moveToAnchor(...args);
    };
  },

  unpatchTabPreviewModules(win) {
    const tabPreview = win.document.querySelector('#tabbrowser-tab-preview');
    if (!tabPreview ||
        !tabPreview.showPreview)
      return;

    if (tabPreview.__ws_orig__showPreview) {
      tabPreview.showPreview = tabPreview.__ws_orig__showPreview;
      tabPreview.__ws_orig__showPreview = null;
    }
  },

  patchToFullScreenModules(win) {
    const FullScreen = win.FullScreen;
    const sidebarBox = win.document.querySelector('#tabs-sidebar-box');
    const sidebarSplitter = win.document.querySelector('#tabs-sidebar-splitter');

    if (!FullScreen.__ws_orig__toggle)
      FullScreen.__ws_orig__toggle = FullScreen.toggle;
    FullScreen.toggle = function(...args) {
      const retval = this.__ws_orig__toggle(...args);
      const enterFS = win.fullScreen;

      if (enterFS) {
       if (!win.document.fullscreenElement) {
          if (win.gNavToolbox.getAttribute('fullscreenShouldAnimate') == 'true')
            sidebarBox.setAttribute('fullscreenShouldAnimate', true);

          FullScreen.__ws_sidebar.hide();
       }
      }
      else {
        FullScreen.__ws_sidebar.show({ exitting: true });
        FullScreen.__ws_sidebar.cleanup();
      }

      return retval;
    };

    if (!FullScreen.__ws_orig__keyToggleCallback && FullScreen._keyToggleCallback) {
      FullScreen.__ws_orig__keyToggleCallback = FullScreen._keyToggleCallback;
      FullScreen._keyToggleCallback = function(event, ...args) {
        if (event.keyCode == event.DOM_VK_ESCAPE) {
          FullScreen.__ws_sidebar.hide();
        }
        else if (event.keyCode == event.DOM_VK_F6) {
          FullScreen.__ws_sidebar.show();
        }
        return FullScreen.__ws_orig__keyToggleCallback(event, ...args);
      };
    }

    if (!FullScreen.__ws_sidebar) {
      FullScreen.__ws_sidebar = {
        isRightSide() {
          return win.document.documentElement.classList.contains('tabs-sidebar-right');
        },

        updateMouseTargetRect() {
          const contentsAreaRect = win.gBrowser.tabpanels.getBoundingClientRect();
          const sidebarBoxRect = sidebarBox.getBoundingClientRect();
          const isRight = this.isRightSide();
          this._mouseTargetRect = {
            top:    contentsAreaRect.top,
            bottom: contentsAreaRect.bottom,
            left:   contentsAreaRect.left + (isRight ? 0 : sidebarBoxRect.width + 50),
            right:  contentsAreaRect.right - (isRight ? sidebarBoxRect.width + 50 : 0),
          };
          win.MousePosTracker.addListener(this);
        },

        hide() {
          if (this.isRightSide())
            sidebarBox.style.marginRight = `-${sidebarBox.getBoundingClientRect().width}px`;
          else
            sidebarBox.style.marginLeft = `-${sidebarBox.getBoundingClientRect().width}px`;

          win.MousePosTracker.removeListener(this);
          this.startListenToShow();
        },

        show({ exitting } = {}) {
          sidebarBox.removeAttribute('fullscreenShouldAnimate');
          sidebarBox.style.marginLeft = sidebarBox.style.marginRight = '';

          this.endListenToShow();
          if (!exitting) {
            this.updateMouseTargetRect();
          }
        },

        cleanup() {
          win.MousePosTracker.removeListener(this);
          this.endListenToShow();
        },

        startListenToShow() {
          if (this.listeningToShow)
            return;
          this.listeningToShow = true;
          sidebarSplitter.addEventListener('mouseover', FullScreen.__ws_sidebar);
          sidebarSplitter.addEventListener('dragenter', FullScreen.__ws_sidebar);
          sidebarSplitter.addEventListener('touchmove', FullScreen.__ws_sidebar, {
            passive: true,
          });
        },

        endListenToShow() {
          if (!this.listeningToShow)
            return;
          this.listeningToShow = false;
          sidebarSplitter.removeEventListener('mouseover', FullScreen.__ws_sidebar);
          sidebarSplitter.removeEventListener('dragenter', FullScreen.__ws_sidebar);
          sidebarSplitter.removeEventListener('touchmove', FullScreen.__ws_sidebar, {
            passive: true,
          });
        },

        handleEvent(_event) {
          this.show();
        },

        getMouseTargetRect() {
          return this._mouseTargetRect;
        },

        onMouseEnter() {
          this.hide();
        },
      };
    }
  },

  unpatchFullScreenModules(win) {
    const FullScreen = win.FullScreen;

    if (FullScreen.__ws_orig__toggle) {
      FullScreen.toggle = FullScreen.__ws_orig__toggle;
      FullScreen.__ws_orig__toggle = null;
    }

    if (FullScreen.__ws_orig__keyToggleCallback) {
      FullScreen._keyToggleCallback = FullScreen.__ws_orig__keyToggleCallback;
      FullScreen.__ws_orig__keyToggleCallback = null;
    }

    if (FullScreen.__ws_sidebar) {
      FullScreen.__ws_sidebar.cleanup();
      FullScreen.__ws_sidebar = null;
    }
  },

  updateTabsViewButtons(document) {
    const previewButton = document.querySelector('#tabs-sidebar-tabsPreview');
    const listButton    = document.querySelector('#tabs-sidebar-tabsList');
    if (Services.prefs.getBoolPref(`${this.BASE_PREF}showTabPreview`, true)) {
      previewButton.setAttribute('checked', true);
      listButton.removeAttribute('checked');
    }
    else {
      previewButton.removeAttribute('checked');
      listButton.setAttribute('checked', true);
    }
  },

  updateToggleButton(document, button) {
    button = button || document.querySelector('#toggle-tabs-sidebar');
    if (!button)
      return;

    const viewMenuItem = document.querySelector('#viewmenu-toggle-tabs-sidebar');
    if (this.shouldShowSidebar(document)) {
      button.setAttribute('checked', true);
      button.setAttribute('tooltiptext', this.locale.get('closeButton_tooltip'));
      viewMenuItem.setAttribute('checked', true);
    }
    else {
      button.removeAttribute('checked');
      button.setAttribute('tooltiptext', this.locale.get('openButton_tooltip'));
      viewMenuItem.removeAttribute('checked');
    }
  },

  updateTabsSidebarPositionIn(document) {
    const isRight = Services.prefs.getStringPref(`${this.BASE_PREF}sidebarPosition`, '') == '2';
    document.documentElement.classList.toggle('tabs-sidebar-right', isRight);
  },

  openOptions(win, full = false) {
    const url = full ? `${this.BASE_URL}options/options.html#!` : 'about:preferences#tabsSidebar';

    const windows = Services.wm.getEnumerator('navigator:browser');
    while (windows.hasMoreElements()) {
      const win = windows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/;
      if (!win.gBrowser)
        continue;
      for (const tab of win.gBrowser.tabs) {
        if (tab.linkedBrowser.currentURI.spec != url)
          continue;
        win.gBrowser.selectedTab = tab;
        return;
      }
    }

    (win || Services.wm.getMostRecentBrowserWindow())
      .openLinkIn(url, 'tab', {
        allowThirdPartyFixup: false,
        triggeringPrincipal:  Services.scriptSecurityManager.getSystemPrincipal(),
        inBackground:         false,
      });
  },

  toggleTabsToolbar(document) {
    const shouldOpen = document.querySelector('#tabs-sidebar-box').getAttribute('hidden') == 'true';
    if (shouldOpen)
      this.openTabsSidebar(document);
    else
      this.closeTabsSidebar(document);
    this.updateToggleButton(document);
    this.updateHorizontalTabsState(document);
  },

  updateHorizontalTabsState(document) {
    const active = document.querySelector('#tabs-sidebar-box').getAttribute('hidden') != 'true';
    const hideHorizontalTabsWhileActive = Services.prefs.getBoolPref(`${this.BASE_PREF}hideHorizontalTabsWhileActive`, true);

    document.documentElement.classList.toggle('tabs-sidebar-is-active', active);
    document.documentElement.classList.toggle('hide-horizontal-tabs-while-tabs-sidebar-is-active', hideHorizontalTabsWhileActive);
    document.defaultView.TabsInTitlebar.allowedBy('TabsSidebar', !hideHorizontalTabsWhileActive || !active);
  },

  openTabsSidebar(document) {
    const box = document.querySelector('#tabs-sidebar-box');
    const splitter = document.querySelector('#tabs-sidebar-splitter');
    splitter.removeAttribute('hidden');
    box.setAttribute('shown', true);
    box.removeAttribute('hidden');
    Services.xulStore.persist(box, 'shown');
    Services.xulStore.removeValue(document.URL, box.id, 'hidden');
    Services.xulStore.removeValue(document.URL, splitter.id, 'hidden');

    for (const listener of this.sidebarShownListeners) {
      listener(document.defaultView);
    }
  },

  closeTabsSidebar(document) {
    const box = document.querySelector('#tabs-sidebar-box');
    const splitter = document.querySelector('#tabs-sidebar-splitter');
    box.removeAttribute('shown');
    box.setAttribute('hidden', true);
    splitter.setAttribute('hidden', true);
    Services.xulStore.removeValue(document.URL, box.id, 'shown');
    Services.xulStore.persist(box, 'hidden');
    Services.xulStore.persist(splitter, 'hidden');

    for (const listener of this.sidebarHiddenListeners) {
      listener(document.defaultView);
    }
  },

  handleEvent(event) {
    const win = event.target.ownerDocument?.defaultView || event.target.defaultView;
    switch (event.type) {
      case 'SidebarShown':
        this.updateTabsSidebarPositionIn(event.currentTarget);
        break;

      case 'popupshowing':
        switch (event.target.id) {
          case 'tabs-sidebar-options-menupopup':
            this.updateOptionsPopup(event.target);
            break;
        }
        break;

      case 'command':
        switch (event.target.id) {
          case 'toggle-tabs-sidebar':
          case 'toggle-tabs-sidebar-command':
          case 'viewmenu-toggle-tabs-sidebar':
          case 'tabs-sidebar-close':
            this.toggleTabsToolbar(event.target.ownerDocument);
            break;

          case 'tabs-sidebar-tabsPreview':
            Services.prefs.setBoolPref(`${this.BASE_PREF}showTabPreview`, true);
            this.updateTabsViewButtons(event.target.ownerDocument);
            this.tryHidePopup(event);
            break;

          case 'tabs-sidebar-tabsList':
            Services.prefs.setBoolPref(`${this.BASE_PREF}showTabPreview`, false);
            this.updateTabsViewButtons(event.target.ownerDocument);
            this.tryHidePopup(event);
            break;

          case 'tabs-sidebar-moveLeft':
            Services.prefs.setStringPref(`${this.BASE_PREF}sidebarPosition`, '1');
            this.tryHidePopup(event);
            break;

          case 'tabs-sidebar-moveRight':
            Services.prefs.setStringPref(`${this.BASE_PREF}sidebarPosition`, '2');
            this.tryHidePopup(event);
            break;

          case 'tabs-sidebar-newTab':
            for (const listener of this.menuCommandListeners) {
              listener(event);
            }
            this.tryHidePopup(event);
            break;

          case 'tabs-sidebar-reloadTab':
          case 'tabs-sidebar-reloadTabs':
            win.gBrowser.reloadMultiSelectedTabs(); // same to #toolbar-context-reloadSelectedTab / #toolbar-context-reloadSelectedTabs
            this.tryHidePopup(event);
            break;

          case 'tabs-sidebar-bookmarkTab':
          case 'tabs-sidebar-bookmarkTabs':
            win.PlacesUIUtils.showBookmarkPagesDialog(win.PlacesCommandHook.uniqueSelectedPages); // same to #toolbar-context-bookmarkSelectedTab / #toolbar-context-bookmarkSelectedTabs
            this.tryHidePopup(event);
            break;

          case 'tabs-sidebar-selectAll':
            win.gBrowser.selectAllTabs(); // same to #toolbar-context-selectAllTabs
            this.tryHidePopup(event);
            break;

          case 'tabs-sidebar-undoClose':
            win.undoCloseTab(); // same to #toolbar-context-undoCloseTab
            this.tryHidePopup(event);
            break;

          case 'tabs-sidebar-moreOptions':
            this.openOptions(win, event.shiftKey);
            this.tryHidePopup(event);
            break;
        }
        break;

      case 'mouseup':
        Services.xulStore.persist(event.target.ownerDocument.querySelector('#tabs-sidebar-box'), 'width');
        break;

      case 'customizationchange':
        this.updateToggleButton(event.target.ownerDocument);
        break;

      case 'DOMAudioPlaybackBlockStarted': {
        const gBrowser = event.target.ownerDocument.defaultView.gBrowser;
        const tab      = gBrowser.getTabForBrowser(event.target);
        for (const listener of this.autoplayBlockedListeners) {
          listener(tab);
        }
      }; break;

      case 'DOMAudioPlaybackBlockStopped': {
        const gBrowser = event.target.ownerDocument.defaultView.gBrowser;
        const tab      = gBrowser.getTabForBrowser(event.target);
        for (const listener of this.autoplayUnblockedListeners) {
          listener(tab);
        }
      }; break;

      case 'visibilitychange':
        for (const listener of this.visibilityChangedListeners) {
          listener(event.currentTarget);
        }
        break;
    }
  },
  tryHidePopup(event) {
    if (event.target.closest)
      event.target.closest('panel')?.hidePopup();
  },

  moveToolbarButtonToDefaultPosition() {
    try {
      const state = JSON.parse(Services.prefs.getStringPref('browser.uiCustomization.state', '{}'));
      if (!state?.placements)
        return false;

      let foundInNavBar = false;
      for (const [name, items] of Object.entries(state.placements)) {
        if (!items.includes(this.id))
          continue;
        if (name == 'nav-bar')
          foundInNavBar = true;
        break;
      }

      const navBarItems = state.placements['nav-bar'];
      const searchIndex = navBarItems.indexOf('search-container');
      const urlbarIndex = navBarItems.indexOf('urlbar-container');
      const extensionsIndex = navBarItems.indexOf('unified-extensions-button');
      const index = searchIndex > -1 ? searchIndex + 1 :
        urlbarIndex > -1 ? urlbarIndex + 1 :
          extensionsIndex > -1 ? extensionsIndex :
            navBarItems.length;

      if (foundInNavBar)
        lazy.CustomizableUI.moveWidgetWithinArea(this.id, index);
      else
        lazy.CustomizableUI.addWidgetToArea(this.id, this.defaultArea, index);

      return true;
    }
    catch (error) {
      console.log('failed to insert tabs sidebar button: ', error);
    }
    return false;
  },

  // behave as a toolbar customization widget
  id: 'toggle-tabs-sidebar',
  type: 'custom',
  source: 'external',
  removable: true,
  get label() {
    return this.locale.get('tabsSidebarButton_label');
  },
  get tooltiptext() {
    return this.locale.get('tabsSidebarButton_tooltiptext');
  },
  defaultArea: lazy.CustomizableUI.AREA_NAVBAR,
  showInPrivateBrowsing: true,
  disallowSubView: false,
  localized: false,
  shortcutId: 'toggle-tabs-sidebar-key',
  onBuild(document) {
    const node = element(document, XUL, 'toolbarbutton', {
      id:          'toggle-tabs-sidebar',
      class:       'toolbarbutton-1',
      type:        'checkbox',
      label:       this.locale.get('tabsSidebarButton_label'),
    }, [
      element(document, XUL, 'image', {
        class: 'toolbarbutton-icon',
      }),
      element(document, XUL, 'label', {
        class: 'toolbarbutton-text',
        crop:  'end',
        flex:  '1',
      }, [this.locale.get('tabsSidebarButton_label')]),
    ]);
    this.updateToggleButton(document, node);
    return node;
  },
  onCreated(node) {
    this.updateToggleButton(node.ownerDocument, node);
  },

  onPrefChanged(name) {
    switch (name) {
      case 'sidebar.position_start':
      case `${this.BASE_PREF}sidebarPosition`: {
        const windows = Services.wm.getEnumerator('navigator:browser');
        while (windows.hasMoreElements()) {
          const win = windows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/;
          this.updateTabsSidebarPositionIn(win.document)
        }
      }; break;

      case `${this.BASE_PREF}hideHorizontalTabsWhileActive`: {
        const windows = Services.wm.getEnumerator('navigator:browser');
        while (windows.hasMoreElements()) {
          const win = windows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/;
          this.updateHorizontalTabsState(win.document);
        }
      }; break;

      case 'browser.uiCustomization.state':
        if (!Services.prefs.getStringPref(name)) { // resetting!
          Services.wm.getMostRecentBrowserWindow().setTimeout(() => {
            this.moveToolbarButtonToDefaultPosition();
          }, 100);
        }
        break;
    }
  },

  // as an XPCOM component...
  classDescription: 'Waterfox Chrome Window Watcher for Browser Windows',
  contractID:       '@waterfox.net/chrome-window-watche-browser-windows;1',
  classID:          Components.ID('{8d25e5cc-1d67-4556-819e-e25bd37c79c5}'),
  QueryInterface:   ChromeUtils.generateQI([
    'nsIContentPolicy',
    'nsIObserver',
    'nsISupportsWeakReference',
  ]),

  // nsIContentPolicy
  shouldLoad(contentLocation, loadInfo, mimeTypeGuess) {
     const FORBIDDEN_URL_MATCHER = /^about:blank\?forbidden-url=/;
     if (FORBIDDEN_URL_MATCHER.test(contentLocation.spec)) {
       const url = contentLocation.spec.replace(FORBIDDEN_URL_MATCHER, '');
       const index = this.loadingForbiddenURLs.indexOf(url);
       if (index > -1) {
         this.loadingForbiddenURLs.splice(index, 1);
         const browser = loadInfo.browsingContext.embedderElement;
         browser.loadURI(Services.io.newURI(url), {
           triggeringPrincipal:  Services.scriptSecurityManager.getSystemPrincipal(),
         });
         return Components.interfaces.nsIContentPolicy.REJECT_REQUEST;
       }
     }

    if (this.WATCHING_URLS.some(url => contentLocation.spec.startsWith(url))) {
      const startAt = Date.now();
      const topWin  = loadInfo.browsingContext.topChromeWindow;
      const timer   = topWin.setInterval(() => {
        if (Date.now() - startAt > 1000) {
          // timeout
          topWin.clearInterval(timer);
          return;
        }
        const win = loadInfo.browsingContext.window;
        if (!win)
          return;
        try {
          if (this.handleWindow(win))
            topWin.clearInterval(timer);
        }
        catch(_error) {
        }
      }, 250);
    }
    return Components.interfaces.nsIContentPolicy.ACCEPT;
  },

  shouldProcess(contentLocation, loadInfo, mimeTypeGuess) {
    return Components.interfaces.nsIContentPolicy.ACCEPT;
  },

  // nsIObserver
  observe(subject, topic, data) {
    switch (topic) {
      case 'domwindowopened':
        subject
          //.QueryInterface(Components.interfaces.nsIDOMWindow)
          .addEventListener('DOMContentLoaded', () => {
            this.handleWindow(subject);
          }, { once: true });
        break;

      case 'nsPref:changed':
        this.onPrefChanged(data);
        break;
    }
  },

  createInstance(iid) {
    return this.QueryInterface(iid);
  },


  // AddonManager listener callbacks

  async tryConfirmUsingTST() {
    const ignorePrefKey = `${this.BASE_PREF}.ignoreConflictionWithTST`;
    if (Services.prefs.getBoolPref(ignorePrefKey, false))
      return;

    const nsIPrompt = Components.interfaces.nsIPrompt;
    const shouldAsk = { value: true };
    const result = Services.prompt.confirmEx(
      Services.wm.getMostRecentBrowserWindow(),
      this.locale.get('tryConfirmUsingTST_title'),
      this.locale.get('tryConfirmUsingTST_message'),
      (nsIPrompt.BUTTON_TITLE_IS_STRING * nsIPrompt.BUTTON_POS_0 |
       nsIPrompt.BUTTON_TITLE_IS_STRING * nsIPrompt.BUTTON_POS_1 |
       nsIPrompt.BUTTON_TITLE_IS_STRING * nsIPrompt.BUTTON_POS_2),
      this.locale.get('tryConfirmUsingTST_WS'),
      this.locale.get('tryConfirmUsingTST_both'),
      this.locale.get('tryConfirmUsingTST_TST'),
      this.locale.get('tryConfirmUsingTST_ask'),
      shouldAsk
    );

    if (result > -1 &&
        !shouldAsk.value)
      Services.prefs.setBoolPref(ignorePrefKey, true);

    switch (result) {
      case 0: {
        const addon = await lazy.AddonManager.getAddonByID(TST_ID);
        addon.disable();
      }; return;

      case 2: {
        Services.prompt.alert(
          Services.wm.getMostRecentBrowserWindow(),
          this.locale.get('howToActivateAgain_title'),
          this.locale.get('howToActivateAgain_message')
        );
        const addon = await lazy.AddonManager.getAddonByID(this.EXTENSION_ID);
        addon.disable();
      }; return;

      default:
        return;
    }
  },

  // install listener callbacks
  onNewInstall(_install) {},
  onInstallCancelled(_install) {},
  onInstallPostponed(_install) {},
  onInstallFailed(_install) {},
  onInstallEnded(install) {
    if (install.addon.id == TST_ID)
      this.tryConfirmUsingTST();
  },
  onDownloadStarted(_install) {},
  onDownloadCancelled(_install) {},
  onDownloadEnded(_install) {},
  onDownloadFailed(_install) {},

  // addon listener callbacks
  onUninstalled(_addon) {},
  onEnabled(addon) {
    if (addon.id == TST_ID)
      this.tryConfirmUsingTST();
  },
  onDisabled(_addon) {},
};

this.waterfoxBridge = class extends ExtensionAPI {
  getAPI(context) {
    const EventManager = ExtensionCommon.EventManager;

    return {
      waterfoxBridge: {
        async initUI() {
          BrowserWindowWatcher.EXTENSION_ID = context.extension.id;
          BrowserWindowWatcher.BASE_URL = context.extension.baseURL;
          //BrowserWindowWatcher.BASE_PREF = `extensions.${context.extension.id.split('@')[0]}.`;
          BrowserWindowWatcher.locale   = {
            get(key) {
              key = key.toLowerCase();
              if (this.selected.has(key))
                return this.selected.get(key);
              return this.default.get(key) || key;
            },
            default:  context.extension.localeData.messages.get(context.extension.localeData.defaultLocale),
            selected: context.extension.localeData.messages.get(context.extension.localeData.selectedLocale),
          };
          Services.prefs.addObserver('', BrowserWindowWatcher);

          //const resourceURI = Services.io.newURI('resources', null, context.extension.rootURI);
          //const handler = Cc['@mozilla.org/network/protocol;1?name=resource'].getService(Components.interfaces.nsISubstitutingProtocolHandler);
          //handler.setSubstitution('waterfox-bridge', resourceURI);

          // watch loading of about:preferences in subframes
          const registrar = Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);
          registrar.registerFactory(
            BrowserWindowWatcher.classID,
            BrowserWindowWatcher.classDescription,
            BrowserWindowWatcher.contractID,
            BrowserWindowWatcher
          );
          Services.catMan.addCategoryEntry(
            'content-policy',
            BrowserWindowWatcher.contractID,
            BrowserWindowWatcher.contractID,
            false,
            true
          );

          // handle loading of browser windows
          Services.ww.registerNotification(BrowserWindowWatcher);

          // handle already opened browser windows
          const windows = Services.wm.getEnumerator('navigator:browser');
          while (windows.hasMoreElements()) {
            const win = windows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/;
            BrowserWindowWatcher.handleWindow(win);
          }

          // add toolbar button
          lazy.CustomizableUI.createWidget(BrowserWindowWatcher);
          if (!Services.prefs.getBoolPref(`${BrowserWindowWatcher.BASE_PREF}toolbarButtonInserted`, false) &&
              BrowserWindowWatcher.moveToolbarButtonToDefaultPosition())
            Services.prefs.setBoolPref(`${BrowserWindowWatcher.BASE_PREF}toolbarButtonInserted`, true);

          // support drag and drop of tabs from sidebar to bookmarks toolbar
          if (!lazy.PlacesUtils.__ws_orig__unwrapNodes)
            lazy.PlacesUtils.__ws_orig__unwrapNodes = lazy.PlacesUtils.unwrapNodes;
          lazy.PlacesUtils.unwrapNodes = function(blob, type) {
            if (type == TYPE_TREE) {
              const nodes = [];
              const data = JSON.parse(blob);
              for (const tab of data.tabs) {
                nodes.push({
                  uri:   tab.url,
                  title: tab.title,
                  type:  'text/x-moz-url',
                });
              }
              return nodes;
            }
            return this.__ws_orig__unwrapNodes(blob, type);
          };

          // grant special permissions by default
          if (!Services.prefs.getBoolPref(`${BrowserWindowWatcher.BASE_PREF}permissionsGranted`, false)) {
            lazy.ExtensionPermissions.add(context.extension.id, {
              origins: ['<all_urls>'],
              permissions: ['internal:privateBrowsingAllowed'],
            }, true);
            Services.prefs.setBoolPref(`${BrowserWindowWatcher.BASE_PREF}permissionsGranted`, true);
          }

          // auto detection and warning for TST
          lazy.AddonManager.addInstallListener(BrowserWindowWatcher);
          lazy.AddonManager.addAddonListener(BrowserWindowWatcher);
          const installedTST = await lazy.AddonManager.getAddonByID(TST_ID);
          if (installedTST?.isActive)
            BrowserWindowWatcher.tryConfirmUsingTST();
        },

        async reserveToLoadForbiddenURL(url) {
          BrowserWindowWatcher.loadingForbiddenURLs.push(url);
        },

        async getFileURL(file) {
          return BrowserWindowWatcher.getFileURL(file);
        },

        async getTabPreview(tabId) {
          const info = {
            url:   null,
            found: false,
          };
          const tab = context.extension.tabManager.get(tabId);
          if (!tab)
            return info;

          const nativeTab = tab.nativeTab;
          const window    = nativeTab.ownerDocument.defaultView;
          try {
            const canvas = await window.tabPreviews.get(nativeTab);
            /*
            // We can get a URL like "https%3A%2F%2Fwww.example.com.org%2F&revision=0000"
            // but Firefox does not allow loading of such a special internal URL from
            // addon's sidebar page.
            const image     = await window.tabPreviews.get(nativeTab);
            return image.src;
            */
            if (canvas) {
              info.url   = canvas.toDataURL('image/png');
              info.found = true;
              return info;
            }
          }
          catch (_error) { // tabPreviews.capture() raises error if the tab is discarded.
            // console.error('waterfoxBridge: failed to take a tab preview: ', tabId, error);
          }

          // simulate default preview
          // see also: https://searchfox.org/mozilla-esr115/rev/d0623081f317c92e0c7bc2a8b1b138687bdb23f5/browser/themes/shared/ctrlTab.css#85-94
          const canvas = lazy.PageThumbs.createCanvas(window);
          try {
            // TODO: we should change the fill color to "CanvasText"...
            const image = new window.Image();
            await new Promise((resolve, reject) => {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', reject, { once: true });
              image.src = 'chrome://global/skin/icons/defaultFavicon.svg';
            });
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'Canvas';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            const iconSize = canvas.width * 0.2;
            ctx.drawImage(
              image,
              0,
              0,
              image.width,
              image.height,
              (canvas.width - iconSize) / 2,
              (canvas.height - iconSize) / 2,
              iconSize,
              iconSize
            );
          }
          catch (_error) {
          }
          info.url = canvas.toDataURL('image/png');
          return info;
        },

        async showPreviewPanel(tabId, top) {
          const tab = tabId && context.extension.tabManager.get(tabId);
          if (!tab ||
              !Services.prefs.getBoolPref('browser.tabs.cardPreview.enabled', false))
            return;

          const document = tab.nativeTab.ownerDocument;
          const tabPreview = document.querySelector('#tabbrowser-tab-preview');
          if (!tabPreview)
            return;
          tabPreview.__ws__top = top;
          tabPreview.tab = tab.nativeTab;
          tabPreview.showPreview();
        },

        async hidePreviewPanel(windowId) {
          const win = windowId && context.extension.windowManager.get(windowId)
          if (!win)
            return;

          const tabPreview = win.window.document.querySelector('#tabbrowser-tab-preview');
          if (!tabPreview)
            return;
          tabPreview.__ws__top = null;
          tabPreview.tab = null;
        },

        onHoverPreviewChanged: new EventManager({
          context,
          name: 'waterfoxBridge.onHoverPreviewChanged',
          register: (fire) => {
            const observe = (_subject, _topic, data) => {
              fire.async(Services.prefs.getBoolPref('browser.tabs.cardPreview.enabled', false)).catch(() => {}); // ignore Message Manager disconnects
            };
            Services.prefs.addObserver('browser.tabs.cardPreview.enabled', observe);
            observe();
            return () => {
              Services.prefs.removeObserver('browser.tabs.cardPreview.enabled', observe);
            };
          },
        }).api(),

        async openPreferences() {
          BrowserWindowWatcher.openOptions();
        },

        onWindowVisibilityChanged: new EventManager({
          context,
          name: 'waterfoxBridge.onWindowVisibilityChanged',
          register: (fire) => {
            const onChanged = win => {
              const wrappedWindow = context.extension.windowManager.getWrapper(win);
              if (wrappedWindow)
                fire.async(wrappedWindow.id, win.document.visibilityState).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.visibilityChangedListeners.add(onChanged);
            return () => {
              BrowserWindowWatcher.visibilityChangedListeners.delete(onChanged);
            };
          },
        }).api(),

        onMenuCommand: new EventManager({
          context,
          name: 'waterfoxBridge.onMenuCommand',
          register: (fire) => {
            const onCommand = event => {
              fire.async({
                itemId:   event.target.id,
                detail:   event.detail,
                button:   event.button,
                altKey:   event.altKey,
                ctrlKey:  event.ctrlKey,
                metaKey:  event.metaKey,
                shiftKey: event.shiftKey,
              }).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.menuCommandListeners.add(onCommand);
            return () => {
              BrowserWindowWatcher.menuCommandListeners.delete(onCommand);
            };
          },
        }).api(),

        onSidebarShown: new EventManager({
          context,
          name: 'waterfoxBridge.onSidebarShown',
          register: (fire) => {
            const onShown = win => {
              const wrappedWindow = context.extension.windowManager.getWrapper(win);
              if (wrappedWindow)
                fire.async(wrappedWindow.id).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.sidebarShownListeners.add(onShown);
            return () => {
              BrowserWindowWatcher.sidebarShownListeners.delete(onShown);
            };
          },
        }).api(),

        onSidebarHidden: new EventManager({
          context,
          name: 'waterfoxBridge.onSidebarHidden',
          register: (fire) => {
            const onHidden = win => {
              const wrappedWindow = context.extension.windowManager.getWrapper(win);
              if (wrappedWindow)
                fire.async(wrappedWindow.id).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.sidebarHiddenListeners.add(onHidden);
            return () => {
              BrowserWindowWatcher.sidebarHiddenListeners.delete(onHidden);
            };
          },
        }).api(),


        async listSyncDevices() {
          const devices = [];
          const targets = Services.wm.getMostRecentBrowserWindow().gSync.getSendTabTargets();
          for (const target of targets) {
            devices.push({
              id:   target.id,
              name: target.name,
              type: target.type,
            });
          }
          return devices;
        },

        async sendToDevice(tabIds, deviceId) {
          if (!Array.isArray(tabIds))
            tabIds = [tabIds];
          const gSync = Services.wm.getMostRecentBrowserWindow().gSync;
          const tabs = tabIds.map(id => context.extension.tabManager.get(id));
          const targets = gSync.getSendTabTargets().filter(target => !deviceId || target.id == deviceId);
          for (const tab of tabs) {
            gSync.sendTabToDevice(
              tab.nativeTab.linkedBrowser.currentURI.spec,
              targets,
              tab.nativeTab.linkedBrowser.contentTitle
            );
          }
        },

        async openSyncDeviceSettings(windowId) {
          let DOMWin = null;
          try {
            const win = windowId && context.extension.windowManager.get(windowId)
            DOMWin = win?.window;
          }
          catch (_error) {
          }
          (DOMWin || Services.wm.getMostRecentBrowserWindow()).gSync.openDevicesManagementPage('sendtab');
        },


        async listSharingServices(tabId) {
          const tab = tabId && context.extension.tabManager.get(tabId);

          const services = [];
          const win = Services.wm.getMostRecentBrowserWindow();
          const sharingService = win.gBrowser.MacSharingService;
          if (!sharingService)
            return services;

          const uri = win.gURLBar.makeURIReadable(
            tab?.nativeTab.linkedBrowser.currentURI ||
            Services.io.newURI('https://waterfox.net/', null, null)
          ).displaySpec;
          for (const service of sharingService.getSharingProviders(uri)) {
            services.push({
              name:  service.name,
              title: service.menuItemTitle,
              image: service.image,
            });
          }
          return services;
        },

        async share(tabIds, shareName) {
          if (!Array.isArray(tabIds))
            tabIds = [tabIds];
          const tabs = tabIds.map(id => context.extension.tabManager.get(id));

          // currently we can share only one URL at a time...
          const tab = tabs[0];
          const win = Services.wm.getMostRecentBrowserWindow();
          const uri = win.gURLBar.makeURIReadable(tab.nativeTab.linkedBrowser.currentURI).displaySpec;

          if (AppConstants.platform == 'win') {
            win.WindowsUIUtils.shareUrl(uri, tab.nativeTab.linkedBrowser.contentTitle);
            return;
          }

          if (shareName) { // for macOS
            win.gBrowser.MacSharingService.shareUrl(shareName, uri, tab.nativeTab.linkedBrowser.contentTitle);
            return;
          }
        },

        async openSharingPreferences() {
          Services.wm.getMostRecentBrowserWindow().gBrowser.MacSharingService.openSharingPreferences();
        },


        async listAutoplayBlockedTabs(windowId) {
          const tabs = new Set();
          const windows = windowId ?
            [context.extension.windowManager.get(windowId)] :
            context.extension.windowManager.getAll();
          for (const win of windows) {
            if (!win.window.gBrowser)
              continue;
            for (const tab of win.window.document.querySelectorAll('tab[activemedia-blocked="true"]')) {
              const wrappedTab = context.extension.tabManager.getWrapper(tab);
              if (wrappedTab)
                tabs.add(wrappedTab.convert());
            }
          }
          return [...tabs].sort((a, b) => a.index - b.index);
        },

        async isAutoplayBlockedTab(tabId) {
          const tab = context.extension.tabManager.get(tabId);
          if (!tab)
            return false;
          return tab.nativeTab.getAttribute('activemedia-blocked') == 'true';
        },

        async unblockAutoplay(tabIds) {
          if (!Array.isArray(tabIds))
            tabIds = [tabIds];
          const tabs = tabIds.map(id => context.extension.tabManager.get(id));
          for (const tab of tabs) {
            tab.nativeTab.linkedBrowser.resumeMedia();
          }
        },

        onAutoplayBlocked: new EventManager({
          context,
          name: 'waterfoxBridge.onAutoplayBlocked',
          register: (fire) => {
            const onBlocked = tab => {
              const wrappedTab = context.extension.tabManager.getWrapper(tab);
              if (wrappedTab)
                fire.async(wrappedTab.convert()).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.autoplayBlockedListeners.add(onBlocked);
            return () => {
              BrowserWindowWatcher.autoplayBlockedListeners.delete(onBlocked);
            };
          },
        }).api(),

        onAutoplayUnblocked: new EventManager({
          context,
          name: 'waterfoxBridge.onAutoplayUnblocked',
          register: (fire) => {
            const onUnblocked = tab => {
              const wrappedTab = context.extension.tabManager.getWrapper(tab);
              if (wrappedTab)
                fire.async(wrappedTab.convert()).catch(() => {}); // ignore Message Manager disconnects
            };
            BrowserWindowWatcher.autoplayUnblockedListeners.add(onUnblocked);
            return () => {
              BrowserWindowWatcher.autoplayUnblockedListeners.delete(onUnblocked);
            };
          },
        }).api(),


        async isSelectionClipboardAvailable() {
          try {
            return Services.clipboard.isClipboardTypeSupported(Services.clipboard.kSelectionClipboard);
          }
          catch(_error) {
            return false;
          }
        },

        async getSelectionClipboardContents() {
          try {
            const transferable = Components.classes['@mozilla.org/widget/transferable;1']
              .createInstance(Components.interfaces.nsITransferable);
            const loadContext = Services.wm.getMostRecentBrowserWindow()
              .docShell.QueryInterface(Components.interfaces.nsILoadContext);
            transferable.init(loadContext);
            transferable.addDataFlavor('text/plain');

            Services.clipboard.getData(transferable, Services.clipboard.kSelectionClipboard);

            const data = {};
            transferable.getTransferData('text/plain', data);
            if (data) {
              data = data.value.QueryInterface(Components.interfaces.nsISupportsString);
              return data.data;
            }
          }
          catch(_error) {
            return '';
          }
        },
      },
    };
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown)
      return;

    lazy.AddonManager.removeInstallListener(BrowserWindowWatcher);
    lazy.AddonManager.removeAddonListener(BrowserWindowWatcher);

    if (lazy.PlacesUtils.__ws_orig__unwrapNodes) {
      lazy.PlacesUtils.unwrapNodes = lazy.PlacesUtils.__ws_orig__unwrapNodes;
      lazy.PlacesUtils.__ws_orig__unwrapNodes = null;
    }

    lazy.CustomizableUI.destroyWidget(BrowserWindowWatcher.id);

    const registrar = Components.manager.QueryInterface(Components.interfaces.nsIComponentRegistrar);
    registrar.unregisterFactory(
      BrowserWindowWatcher.classID,
      BrowserWindowWatcher
    );
    Services.catMan.deleteCategoryEntry(
      'content-policy',
      BrowserWindowWatcher.contractID,
      false
    );

    Services.ww.unregisterNotification(BrowserWindowWatcher);

    const windows = Services.wm.getEnumerator('navigator:browser');
    while (windows.hasMoreElements()) {
      const win = windows.getNext()/*.QueryInterface(Components.interfaces.nsIDOMWindow)*/;
      BrowserWindowWatcher.unhandleWindow(win);
    }

    //const handler = Cc['@mozilla.org/network/protocol;1?name=resource'].getService(Components.interfaces.nsISubstitutingProtocolHandler);
    //handler.setSubstitution('waterfox-bridge', null);

    Services.prefs.removeObserver('', BrowserWindowWatcher);
  }
};
