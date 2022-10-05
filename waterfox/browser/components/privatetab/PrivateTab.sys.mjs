/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrowserUtils } from "resource:///modules/BrowserUtils.sys.mjs";
import { PlacesUIUtils } from "resource:///modules/PlacesUIUtils.sys.mjs";
import { setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import { ContextualIdentityService } from "resource://gre/modules/ContextualIdentityService.sys.mjs";

// TabStateCache might not be available in all contexts
let TabStateCache;
try {
  const module = ChromeUtils.import("resource:///modules/sessionstore/TabStateCache.sys.mjs");
  TabStateCache = module.TabStateCache;
} catch (ex) {
  // TabStateCache not available - silently continue
}

export const PrivateTab = {
  config: {
    neverClearData: false,
    restoreTabsOnRestart: false,
    doNotClearDataUntilFxIsClosed: false,
  },

  openTabs: new Set(),
  container: null,

  BTN_ID: "privateTab-button",
  BTN2_ID: "newPrivateTab-button",

  get style() {
    return `
      #private-browsing-indicator-with-label[enabled="true"] {
        display: inherit !important;
      }
      #main-window:not([privatebrowsingmode]) #private-browsing-indicator-with-label label {
        display: none;
      }
      .privatetab-icon {
        list-style-image: url(chrome://browser/skin/privatebrowsing/favicon.svg) !important;
      }
      #${this.BTN_ID}, #${this.BTN2_ID} {
        list-style-image: url(chrome://browser/skin/privateBrowsing.svg);
      }
      .tabbrowser-tab[usercontextid="${this.container?.userContextId}"] .tab-label {
        text-decoration: underline !important;
        text-decoration-color: -moz-nativehyperlinktext !important;
        text-decoration-style: dashed !important;
      }
      .tabbrowser-tab[usercontextid="${this.container?.userContextId}"][pinned] .tab-icon-image,
      .tabbrowser-tab[usercontextid="${this.container?.userContextId}"][pinned] .tab-throbber {
        border-bottom: 1px dashed -moz-nativehyperlinktext !important;
      }
    `;
  },

  init(aWindow) {
    // Only init in non-private windows
    if (aWindow.PrivateBrowsingUtils.isWindowPrivate(aWindow)) {
      return;
    }

    // Wait for XUL elements to be available
    if (!aWindow.document.getElementById("toggleTabPrivateState")) {
      setTimeout(() => this.init(aWindow), 50);
      return;
    }

    aWindow.PrivateTab = this;
    this.initContainer("Private");
    this.initObservers(aWindow);
    this.createToolbarButton(aWindow);
    this.initListeners(aWindow);
    this.initPrivateTabListeners(aWindow);
    this.initCustomFunctions(aWindow);
    this.overridePlacesUIUtils();
    this.overrideSessionStore(aWindow);

    // Update private browsing indicator
    const privateIndicator = aWindow.document.getElementById("private-browsing-indicator-with-label");
    if (privateIndicator && aWindow.gBrowser.selectedTab?.userContextId === this.container.userContextId) {
      privateIndicator.setAttribute("enabled", "true");
    }

    BrowserUtils.setStyle(this.style);
  },

  initContainer(aName) {
    try {
      ContextualIdentityService.ensureDataReady();
      this.container = ContextualIdentityService._identities.find(
        (container) => container.name === aName
      );
      if (!this.container) {
        try {
          ContextualIdentityService.create(aName, "fingerprint", "purple");
        } catch (createEx) {
          if (createEx.message?.includes("Component is not available")) {
            console.error("PrivateTab initContainer create error:", createEx.message);
            console.error("Stack:", new Error().stack);
          }
          throw createEx;
        }
        this.container = ContextualIdentityService._identities.find(
          (container) => container.name === aName
        );
      } else if (!this.config.neverClearData) {
        this.clearData();
      }
    } catch (ex) {
      if (ex.message?.includes("Component is not available")) {
        console.error("PrivateTab initContainer error:", ex.message);
        console.error("Stack:", new Error().stack);
      }
    }
    return this.container;
  },

  clearData() {
    if (!this.container?.userContextId) {
      return;
    }
    
    try {
      if (Services && Services.clearData && Services.clearData.deleteDataFromOriginAttributesPattern) {
        try {
          Services.clearData.deleteDataFromOriginAttributesPattern({
            userContextId: this.container.userContextId,
          });
        } catch (innerEx) {
          console.error("PrivateTab clearData error:", innerEx.message);
        }
      }
    } catch (ex) {
      console.error("PrivateTab clearData outer error:", ex.message);
      console.error("  Full error:", ex);
      console.error("  Stack:", new Error().stack);
    }
  },

  // Robust startup cleanup for crash scenarios and improper shutdowns
  cleanupStartupTabs(aWindow) {
    const { gBrowser } = aWindow;
    if (!gBrowser) return;
    
    // Check and clean up private tabs
    const doCleanup = () => {
      try {
        // Don't run if browser is still initializing
        if (!gBrowser.tabs || gBrowser.tabs.length === 0) return;
        
        const privateTabs = [];
        for (let tab of gBrowser.tabs) {
          if (this.isPrivate(tab)) {
            privateTabs.push(tab);
          }
        }
        
        if (privateTabs.length === 0) return;
        
        // If ALL tabs are private, create a regular tab first
        if (privateTabs.length === gBrowser.tabs.length) {
          try {
            const principal = Services.scriptSecurityManager.getSystemPrincipal();
            const newTab = gBrowser.addTab("about:home", { 
              userContextId: 0,
              triggeringPrincipal: principal
            });
            gBrowser.selectedTab = newTab;
          } catch (ex) {
            // Fallback without principal if Services aren't ready
            const newTab = gBrowser.addTab("about:home");
            gBrowser.selectedTab = newTab;
          }
        }
        
        // Remove all private tabs
        for (let tab of privateTabs) {
          if (gBrowser.tabs.length > 1) {
            try {
              gBrowser.removeTab(tab);
            } catch (ex) {
              // Tab might already be closing
            }
          }
        }
        
        if (privateTabs.length > 0) {
          this.clearData();
        }
      } catch (ex) {
        // Cleanup failed, will retry
      }
    };
    
    // Wait longer for session restore to be ready
    aWindow.setTimeout(() => {
      doCleanup();
      // Run again after session restore completes
      aWindow.setTimeout(doCleanup, 2000);
    }, 1000);
  },

  initObservers(aWindow) {
    this.setPrivateObserver(aWindow);
    // Clean up startup tabs after session restore
    this.cleanupStartupTabs(aWindow);
  },

  createToolbarButton(aWindow) {
    const doc = aWindow.document;

    // Create the new private tab button if it doesn't exist
    if (!doc.getElementById(this.BTN2_ID)) {
      const tabsNewTabButton = doc.getElementById("tabs-newtab-button");
      if (tabsNewTabButton) {
        const btn2 = doc.createXULElement("toolbarbutton");
        btn2.id = this.BTN2_ID;
        btn2.className = "toolbarbutton-1 chromeclass-toolbar-additional";
        btn2.setAttribute("label", "New Private Tab");
        btn2.setAttribute("tooltiptext", "Open a new private tab (Ctrl+Alt+P)");
        tabsNewTabButton.insertAdjacentElement("afterend", btn2);
      }
    }
  },

  initListeners(aWindow) {
    const doc = aWindow.document;

    // Keyboard shortcuts
    doc.getElementById("togglePrivateTab-key")?.addEventListener("command", () => {
      this.togglePrivate(aWindow);
    });

    doc.getElementById("newPrivateTab-key")?.addEventListener("command", () => {
      this.browserOpenTabPrivate(aWindow);
    });

    // Menu items
    doc.getElementById("menu_newPrivateTab")?.addEventListener("command", () => {
      this.browserOpenTabPrivate(aWindow);
    });

    // Toggle tab private state menu item
    doc.getElementById("toggleTabPrivateState")?.addEventListener("command", () => {
      if (aWindow.TabContextMenu?.contextTab) {
        this.togglePrivate(aWindow, aWindow.TabContextMenu.contextTab);
      } else {
        this.togglePrivate(aWindow);
      }
    });

    // Context menu - open link in private tab
    doc.getElementById("openLinkInPrivateTab")?.addEventListener("command", () => {
      this.openLink(aWindow);
    });

    // Places context menu items
    doc.getElementById("openPrivate")?.addEventListener("command", (event) => {
      this.openPrivateTab(event);
    });

    doc.getElementById("openAllPrivate")?.addEventListener("command", (event) => {
      this.openAllPrivate(event);
    });

    doc.getElementById("openAllLinksPrivate")?.addEventListener("command", (event) => {
      this.openAllPrivate(event);
    });

    // Context menu popup listeners
    doc.getElementById("contentAreaContextMenu")?.addEventListener(
      "popupshowing",
      this.contentContext.bind(this)
    );

    doc.getElementById("contentAreaContextMenu")?.addEventListener(
      "popuphidden",
      this.hideContext.bind(this)
    );

    doc.getElementById("tabContextMenu")?.addEventListener(
      "popupshowing",
      this.tabContext.bind(this)
    );

    doc.getElementById("placesContext")?.addEventListener(
      "popupshowing",
      this.placesContext.bind(this)
    );

    // Toolbar button (if exists)
    const btn2 = doc.getElementById(this.BTN2_ID);
    if (btn2) {
      btn2.addEventListener("click", (e) => {
        if (e.button === 0) {
          this.browserOpenTabPrivate(aWindow);
        } else if (e.button === 2) {
          doc.getElementById("toolbar-context-menu").openPopup(
            btn2, "after_start", 14, -10, false, false
          );
          e.preventDefault();
        }
      });
    }
  },



  setPrivateObserver(aWindow) {
    // Handle browser shutdown
    const shutdownObserver = () => {
      try {
        // Close all private tabs before shutdown
        this.closeAllPrivateTabs();
        // Clear data after closing tabs
        this.clearData();
      } catch (ex) {
        // Silently fail during shutdown
      }
    };
    
    // Use multiple shutdown events to ensure cleanup happens
    try {
      Services.obs.addObserver(shutdownObserver, "quit-application-requested");
      Services.obs.addObserver(shutdownObserver, "quit-application");
      Services.obs.addObserver(shutdownObserver, "sessionstore-windows-restored");
    } catch (ex) {
      // Silently fail if observer service is unavailable
    }
    
    // Also handle window close directly with beforeunload for earlier intervention
    const cleanupHandler = () => {
      try {
        // If this is the last window, clean up
        if (Services && Services.wm) {
          const windows = Services.wm.getEnumerator("navigator:browser");
          let windowCount = 0;
          while (windows.hasMoreElements()) {
            windows.getNext();
            windowCount++;
          }
          
          if (windowCount <= 1) {
            try {
              this.closeAllPrivateTabs();
              this.clearData();
            } catch (ex) {
              // Silently fail
            }
          }
        }
      } catch (ex) {
        // Silently fail
      }
    };
    
    aWindow.addEventListener("beforeunload", cleanupHandler);
    aWindow.addEventListener("unload", cleanupHandler);
  },

  closeTabs() {
    if (!this.container?.userContextId) return;
    try {
      ContextualIdentityService._forEachContainerTab((tab, tabbrowser) => {
        if (tab.userContextId == this.container.userContextId) {
          tabbrowser.removeTab(tab);
        }
      });
    } catch (ex) {
      // Service might not be available
    }
  },

  closeAllPrivateTabs() {
    // Close private tabs in all windows before shutdown
    try {
      if (!Services || !Services.wm) return;
      
      const windows = Services.wm.getEnumerator("navigator:browser");
      const windowList = [];
      while (windows.hasMoreElements()) {
        windowList.push(windows.getNext());
      }
      
      for (let win of windowList) {
        if (!win || !win.gBrowser) continue;
        
        const tabsToClose = [];
        for (let tab of win.gBrowser.tabs) {
          if (this.isPrivate(tab)) {
            tabsToClose.push(tab);
          }
        }
        
        if (tabsToClose.length === 0) continue;
        
        // If ALL tabs are private, create a regular tab first
        if (tabsToClose.length === win.gBrowser.tabs.length) {
          try {
            const principal = Services.scriptSecurityManager?.getSystemPrincipal();
            if (principal) {
              win.gBrowser.addTab("about:blank", { 
                userContextId: 0,
                triggeringPrincipal: principal
              });
            } else {
              win.gBrowser.addTab("about:blank");
            }
          } catch (ex) {
            // Window might be closing, try without options
            try {
              win.gBrowser.addTab("about:blank");
            } catch (ex2) {
              // Give up
            }
          }
        }
        
        // Now close the private tabs
        for (let tab of tabsToClose) {
          if (win.gBrowser && win.gBrowser.tabs.length > 1) {
            try {
              win.gBrowser.removeTab(tab);
            } catch (ex) {
              // Tab might already be closing
            }
          }
        }
      }
    } catch (ex) {
      // Window manager might not be available during shutdown
    }
  },

  placesContext(aEvent) {
    const win = aEvent.view || aEvent.target.ownerGlobal;
    const doc = win.document;
    const openPrivate = doc.getElementById("openPrivate");
    const openAllPrivate = doc.getElementById("openAllPrivate");
    const openAllLinksPrivate = doc.getElementById("openAllLinksPrivate");
    const openTab = doc.getElementById("placesContext_open:newtab");
    const openAll = doc.getElementById("placesContext_openBookmarkContainer:tabs");
    const openAllLinks = doc.getElementById("placesContext_openLinks:tabs");

    if (openPrivate && openTab) {
      openPrivate.disabled = openTab.disabled;
      openPrivate.hidden = openTab.hidden;
    }
    if (openAllPrivate && openAll) {
      openAllPrivate.disabled = openAll.disabled;
      openAllPrivate.hidden = openAll.hidden;
    }
    if (openAllLinksPrivate && openAllLinks) {
      openAllLinksPrivate.disabled = openAllLinks.disabled;
      openAllLinksPrivate.hidden = openAllLinks.hidden;
    }
  },

  isPrivate(aTab) {
    // Ensure we have a valid container before checking
    if (!this.container?.userContextId) return false;
    // Use == not === to handle string/number comparison
    return aTab.getAttribute("usercontextid") == this.container.userContextId;
  },

  contentContext(aEvent) {
    const win = aEvent.view;
    const gContextMenu = win.gContextMenu;
    
    // Don't show private tab options in the sidebar
    if (gContextMenu.browser == win.SidebarController.treeVerticalTabsBrowser) {
      return;
    }
    
    const tab = win.gBrowser.getTabForBrowser(gContextMenu.browser);
    const openLinkInPrivateTab = win.document.getElementById("openLinkInPrivateTab");

    if (openLinkInPrivateTab) {
      gContextMenu.showItem(
        "openLinkInPrivateTab",
        gContextMenu.onSaveableLink || gContextMenu.onPlainTextLink
      );
    }

    const isPrivate = this.isPrivate(tab);
    if (isPrivate) {
      gContextMenu.showItem("context-openlinkincontainertab", false);
    }
  },

  hideContext(aEvent) {
    if (aEvent.target === aEvent.currentTarget) {
      const openLink = aEvent.view.document.getElementById("openLinkInPrivateTab");
      if (openLink) {
        openLink.hidden = true;
      }
    }
  },

  tabContext(aEvent) {
    const win = aEvent.view;
    const toggleTab = win.document.getElementById("toggleTabPrivateState");
    if (toggleTab && win.TabContextMenu?.contextTab) {
      toggleTab.setAttribute(
        "checked",
        win.TabContextMenu.contextTab.userContextId == this.container?.userContextId
      );
    }
  },

  openLink(aWindow) {
    if (!this.container?.userContextId) return;
    const { gContextMenu } = aWindow;
    aWindow.openLinkIn(
      gContextMenu.linkURL,
      "tab",
      gContextMenu._openLinkInParameters({
        userContextId: this.container.userContextId,
        triggeringPrincipal: aWindow.document.nodePrincipal,
      })
    );
  },

  overridePlacesUIUtils() {
    const originalOpenTabset = PlacesUIUtils.openTabset;
    PlacesUIUtils.openTabset = function (
      aEvent,
      aWindow,
      aTabs,
      loadInBackground
    ) {
      return originalOpenTabset.call(
        this,
        aEvent,
        aWindow,
        aTabs,
        loadInBackground,
        aEvent.userContextId || 0
      );
    };
  },

  openAllPrivate(event) {
    if (!this.container?.userContextId) return;
    event.userContextId = this.container.userContextId;
    PlacesUIUtils.openSelectionInTabs(event);
  },

  openPrivateTab(event) {
    if (!this.container?.userContextId) return;
    const view = event.target.parentElement._view;
    if (view && view.selectedNode) {
      PlacesUIUtils._openNodeIn(view.selectedNode, "tab", view.ownerWindow, {
        aPrivate: false,
        userContextId: this.container.userContextId,
      });
    }
  },

  togglePrivate(aWindow, aTab = aWindow.gBrowser.selectedTab) {
    const { gBrowser, gURLBar } = aWindow;
    
    // Check if container is properly initialized
    if (!this.container?.userContextId) {
      console.error("PrivateTab: Container not initialized for toggle");
      return null;
    }
    
    aTab.isToggling = true;
    const shouldSelect = aTab === gBrowser.selectedTab;
    
    const newTab = gBrowser.duplicateTab(aTab);
    const newBrowser = newTab.linkedBrowser;
    
    // Update tab state cache after duplication with the new container ID
    aWindow.addEventListener("SSWindowStateReady", () => {
      try {
        const newContextId = parseInt(newTab.getAttribute("usercontextid")) || 0;
        TabStateCache.update(newBrowser.permanentKey, {
          userContextId: newContextId
        });
      } catch (ex) {
        if (ex.message?.includes("Component is not available")) {
          console.error("PrivateTab TabStateCache.update error:", ex.message);
          console.error("Stack:", new Error().stack);
        }
      }
    }, { once: true });
    
    if (shouldSelect) {
      const focusUrlbar = gURLBar.focused;
      gBrowser.selectedTab = newTab;
      if (focusUrlbar) {
        gURLBar.focus();
      }
    }
    
    gBrowser.removeTab(aTab);
    return newTab;
  },

  browserOpenTabPrivate(aWindow) {
    if (!this.container?.userContextId) {
      console.warn("PrivateTab: Container not initialized");
      return;
    }
    
    try {
      aWindow.openTrustedLinkIn(aWindow.BROWSER_NEW_TAB_URL, "tab", {
        userContextId: this.container.userContextId,
      });
    } catch (ex) {
      console.error("PrivateTab browserOpenTabPrivate error:", ex.message);
      console.error("Full error:", ex);
      console.error("Stack:", new Error().stack);
      throw ex;
    }
  },

  initPrivateTabListeners(aWindow) {
    const { gBrowser } = aWindow;

    gBrowser.tabContainer.addEventListener(
      "TabSelect",
      this.onTabSelect.bind(this)
    );

    // Add initial check for selected tab
    if (gBrowser.selectedTab && this.isPrivate(gBrowser.selectedTab)) {
      this.toggleMask(aWindow);
    }

    gBrowser.privateListener = (e) => {
      try {
        const browser = e.target;
        if (!browser) return;
        
        const tab = gBrowser.getTabForBrowser(browser);
        if (!tab) return;
        
        const isPrivate = this.isPrivate(tab);
        
        // Exit early for non-private tabs - no need to process or log
        if (!isPrivate) {
          // Only handle cleanup if we're observing private tabs
          if (this.observePrivateTabs && this.openTabs.has(tab)) {
            this.openTabs.delete(tab);
            if (!this.openTabs.size) {
              this.clearData();
            }
          }
          return;
        }
        
        if (this.observePrivateTabs) {
          this.openTabs.add(tab);
        }

        // Prevent history storage for private tabs
        // NOTE: This will generate NS_ERROR_NOT_AVAILABLE errors in the console.
        // These errors are harmless and expected - they occur because Firefox's
        // internal components try to access the history service after we disable it.
        // The errors don't affect functionality and private tabs still work correctly.
        try {
          if (browser.browsingContext && !browser.browsingContext.closed) {
            browser.browsingContext.useGlobalHistory = false;
          }
        } catch (ex) {
          // Silently ignore errors - the property might not be available yet
        }
      } catch (ex) {
        console.error("PrivateTab privateListener error:", ex.message);
        console.error("  Full error:", ex);
        console.error("  Event type:", e?.type);
        console.error("  Stack:", new Error().stack);
      }
    };

    aWindow.addEventListener("XULFrameLoaderCreated", gBrowser.privateListener);

    if (this.observePrivateTabs) {
      gBrowser.tabContainer.addEventListener(
        "TabClose",
        this.onTabClose.bind(this)
      );
    }
  },

  onTabSelect(aEvent) {
    const tab = aEvent.target;
    const win = tab.ownerGlobal;
    const prevTab = aEvent.detail.previousTab;

    if (tab.userContextId != prevTab.userContextId) {
      this.toggleMask(win);
    }
  },

  onTabClose(aEvent) {
    try {
      const tab = aEvent.target;
      if (this.isPrivate(tab)) {
        this.openTabs.delete(tab);
        if (!this.openTabs.size) {
          // Silently try to clear data
          try {
            this.clearData();
          } catch (ex) {
            // Silently fail
          }
        }
      }
    } catch (ex) {
      // Silently fail if any component is unavailable
    }
  },

  toggleMask(aWindow) {
    const { gBrowser } = aWindow;
    const privateIndicator = aWindow.document.getElementById(
      "private-browsing-indicator-with-label"
    );
    if (!privateIndicator) return;

    if (gBrowser.selectedTab.isToggling) {
      privateIndicator.setAttribute(
        "enabled",
        gBrowser.selectedTab.userContextId == this.container?.userContextId ? "false" : "true"
      );
    } else {
      privateIndicator.setAttribute(
        "enabled",
        gBrowser.selectedTab.userContextId == this.container?.userContextId ? "true" : "false"
      );
    }
  },

  get observePrivateTabs() {
    return !this.config.neverClearData && !this.config.doNotClearDataUntilFxIsClosed;
  },

  initCustomFunctions(aWindow) {
    const { MozElements } = aWindow;
    
    // Store original getAttribute
    if (!this.orig_getAttribute) {
      this.orig_getAttribute = MozElements.MozTab.prototype.getAttribute;
    }
    
    // Override getAttribute to handle toggling
    MozElements.MozTab.prototype.getAttribute = function (att) {
      if (att == "usercontextid" && this.isToggling) {
        delete this.isToggling;
        const currentId = PrivateTab.orig_getAttribute.call(this, att);
        // If current tab is private, return 0 (regular), otherwise return private container ID
        return currentId == PrivateTab.container?.userContextId ? "0" : String(PrivateTab.container?.userContextId || 0);
      } else {
        return PrivateTab.orig_getAttribute.call(this, att);
      }
    };
  },

  // Session store override to prevent private tab persistence
  overrideSessionStore(aWindow) {
    const { gBrowser } = aWindow;
    if (!gBrowser) return;
    
    // Mark private tabs as not restorable when they're created
    gBrowser.addEventListener("TabOpen", (e) => {
      const tab = e.target;
      if (this.isPrivate(tab)) {
        // Delete from cache to prevent session storage
        try {
          if (TabStateCache && tab.linkedBrowser?.permanentKey) {
            TabStateCache.delete(tab.linkedBrowser.permanentKey);
          }
        } catch (ex) {
          // TabStateCache might not be available - silently continue
        }
      }
    });
    
    // Clear private tab state periodically
    gBrowser.addEventListener("TabSelect", (e) => {
      const tab = e.target;
      if (this.isPrivate(tab)) {
        try {
          if (TabStateCache && tab.linkedBrowser?.permanentKey) {
            TabStateCache.delete(tab.linkedBrowser.permanentKey);
          }
        } catch (ex) {
          // TabStateCache might not be available - silently continue
        }
      }
    });
  },
};
