/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Lazy load modules for better performance
const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource:///modules/BrowserUtils.sys.mjs",
  PlacesUIUtils: "resource:///modules/PlacesUIUtils.sys.mjs",
  ContextualIdentityService: "resource://gre/modules/ContextualIdentityService.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
  TabStateCache: "resource:///modules/sessionstore/TabStateCache.sys.mjs",
  ContentSearch: "resource:///actors/ContentSearchParent.sys.mjs",
  UrlbarProviderSearchSuggestions: "resource:///modules/UrlbarProviderSearchSuggestions.sys.mjs",
  UrlbarProviderRecentSearches: "resource:///modules/UrlbarProviderRecentSearches.sys.mjs",
  UrlbarUtils: "resource:///modules/UrlbarUtils.sys.mjs",
  UrlbarSearchUtils: "resource:///modules/UrlbarSearchUtils.sys.mjs",
});

// Preferences controlling visibility
const PREF_SHOW_NEWTAB_BUTTON = "browser.privateTab.showNewTabButton";

// CSS constant for better maintainability and performance
const PRIVATE_TAB_STYLES = {
  getCSS(btnId, btn2Id, containerUserContextId) {
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
      #${btnId}, [id^="${btn2Id}"] {
        list-style-image: url(chrome://browser/skin/privateBrowsing.svg) !important;
      }
      /* Ensure private tab button icon shows properly in vertical mode */
      #vertical-tabs [id^="${btn2Id}"] > .toolbarbutton-icon {
        list-style-image: url(chrome://browser/skin/privateBrowsing.svg) !important;
        width: 16px !important;
        height: 16px !important;
      }
      /* Container for vertical stacking - match native sidebar alignment */
      #newtab-buttons-container-vertical {
        display: flex !important;
        flex-direction: column !important;
        align-items: start !important;
        width: 100% !important;
        max-width: 100% !important;
        overflow-x: hidden !important;
      }
      /* Match native vertical new tab button styling for both buttons */
      #newtab-buttons-container-vertical > toolbarbutton {
        appearance: none;
        min-height: var(--tab-min-height);
        line-height: var(--tab-label-line-height);
        border-radius: var(--border-radius-medium);
        padding: 0 calc(var(--tab-inline-padding) - var(--tab-inner-inline-margin));
        width: var(--tab-collapsed-background-width);
        margin-inline: var(--tab-inner-inline-margin);
        margin-block: var(--tab-block-margin);
      }
      /* When expanded, make buttons full width */
      #tabbrowser-tabs[expanded] #newtab-buttons-container-vertical > toolbarbutton {
        width: 100%;
      }
      /* Handle collapsed state - hide text and center buttons */
      #tabbrowser-tabs[orient="vertical"]:not([expanded]) #newtab-buttons-container-vertical {
        align-items: center !important;
      }
      #tabbrowser-tabs[orient="vertical"]:not([expanded]) #newtab-buttons-container-vertical > toolbarbutton > .toolbarbutton-text {
        display: none !important;
      }
      #tabbrowser-tabs[orient="vertical"]:not([expanded]) #newtab-buttons-container-vertical > toolbarbutton {
        justify-content: center !important;
      }
      /* Text alignment and spacing for expanded state */
      #newtab-buttons-container-vertical > toolbarbutton > .toolbarbutton-text {
        text-align: left !important;
        margin-inline-start: 5px !important;
      }
      /* Match native sidebar button padding using space variables */
      #newtab-buttons-container-vertical > toolbarbutton {
        padding-inline: var(--space-medium) !important;
        padding-block: var(--space-xxsmall) !important;
      }
      /* Hover styles for buttons - combined selector */
      #newtab-buttons-container-vertical > toolbarbutton:is(:hover, :hover:active) {
        background-color: var(--toolbarbutton-hover-background) !important;
      }
      #newtab-buttons-container-vertical > toolbarbutton:hover:active {
        background-color: var(--toolbarbutton-active-background) !important;
      }
      .tabbrowser-tab[usercontextid="${containerUserContextId}"] .tab-label {
        text-decoration: underline !important;
        text-decoration-color: -moz-nativehyperlinktext !important;
        text-decoration-style: dashed !important;
      }
      .tabbrowser-tab[usercontextid="${containerUserContextId}"][pinned] .tab-icon-image,
      .tabbrowser-tab[usercontextid="${containerUserContextId}"][pinned] .tab-throbber {
        border-bottom: 1px dashed -moz-nativehyperlinktext !important;
      }
    `;
  }
};

export const PrivateTab = {
  config: {
    longPressDuration: 1000,
    doubleclickTime: 450,
    doubleclickTimeEnter: 900,
  },

  openTabs: new Set(),
  container: null,

  BTN_ID: "privateTab-button",
  BTN2_ID: "newPrivateTab-button",
  _currentStyleURI: null,

  get style() {
    return PRIVATE_TAB_STYLES.getCSS(
      this.BTN_ID,
      this.BTN2_ID,
      this.container?.userContextId
    );
  },

  init(aWindow) {
    // Only init in non-private windows
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(aWindow)) {
      return;
    }

    // Wait for XUL elements to be available
    if (!aWindow.document.getElementById("toggleTabPrivateState")) {
      lazy.setTimeout(() => this.init(aWindow), 50);
      return;
    }

    aWindow.PrivateTab = this;
    this.initContainer("Private");
    this.initObservers(aWindow);
    this.createToolbarButton(aWindow);
    this.observeTabsOrientation(aWindow);
    this.initListeners(aWindow);
    this.initPrivateTabListeners(aWindow);
    this.initCustomFunctions(aWindow);
    this.overridePlacesUIUtils();
    this.overrideContentSearchParent();
    this.overrideUrlbarProviders();
    this.overrideUrlbarUtils();
    this.overrideUrlbarSearchUtils();
    this.overrideUrlbarHandoff(aWindow);
    this.overrideSessionStore(aWindow);

    // Clean up observers on window unload
    aWindow.addEventListener("unload", () => {
      this.cleanupObservers(aWindow);
    }, { once: true });

    // Update private browsing indicator
    const privateIndicator = aWindow.document.getElementById("private-browsing-indicator-with-label");
    if (privateIndicator && aWindow.gBrowser.selectedTab?.userContextId === this.container.userContextId) {
      privateIndicator.setAttribute("enabled", "true");
    }

    this.applyStyle();
    this.updateUIVisibility(aWindow);
  },

  initContainer(aName) {
    try {
      lazy.ContextualIdentityService.ensureDataReady();
      this.container = lazy.ContextualIdentityService._identities.find(
        (container) => container.name === aName
      );
      if (!this.container) {
        try {
          lazy.ContextualIdentityService.create(aName, "fingerprint", "purple");
        } catch (createEx) {
          if (createEx.message?.includes("Component is not available")) {
            console.error("PrivateTab initContainer create error:", createEx.message);
            console.error("Stack:", new Error().stack);
          }
          throw createEx;
        }
        this.container = lazy.ContextualIdentityService._identities.find(
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
    // Observe preference changes that control visibility
    this.initPrefObservers(aWindow);
  },

  cleanupPrivateTabButtons(aWindow) {
    const doc = aWindow.document;
    // Remove all existing private tab buttons
    doc.querySelectorAll(`[id^="${this.BTN2_ID}"]`).forEach(btn => btn.remove());

    // Clean up vertical container if it exists
    const verticalContainer = doc.getElementById("newtab-buttons-container-vertical");
    if (verticalContainer) {
      // Move the new tab button back to its original position
      const newTabButton = verticalContainer.querySelector("#tabs-newtab-button");
      if (newTabButton && verticalContainer.parentNode) {
        verticalContainer.parentNode.insertBefore(newTabButton, verticalContainer);
      }
      verticalContainer.remove();
    }
  },

  createToolbarButton(aWindow) {
    const doc = aWindow.document;

    // Clean up any existing buttons first
    this.cleanupPrivateTabButtons(aWindow);

    // Respect preference controlling visibility of the new private tab button
    const showNewTabButton = Services.prefs.getBoolPref(PREF_SHOW_NEWTAB_BUTTON, true);
    if (!showNewTabButton) {
      return;
    }

    // Find all instances of new tab buttons
    doc.querySelectorAll("#tabs-newtab-button").forEach((tabsNewTabButton, index) => {
      // Check if this button is in vertical tabs mode
      const closestTabs = tabsNewTabButton.closest("tabs");
      const isVerticalMode = tabsNewTabButton.closest("#vertical-tabs") !== null ||
                            (closestTabs?.getAttribute("orient") === "vertical");

      // Create unique ID for each location
      const buttonId = isVerticalMode ? `${this.BTN2_ID}-vertical-${index}` : this.BTN2_ID;

      // Only create if it doesn't already exist
      if (!doc.getElementById(buttonId)) {
        // Create the private tab button
        const btn2 = doc.createXULElement("toolbarbutton");
        btn2.id = buttonId;
        // Use same class as the new tab button for consistent styling in vertical mode
        if (isVerticalMode) {
          btn2.className = tabsNewTabButton.className || "toolbarbutton-1";
        } else {
          // For horizontal mode, use standard toolbar button styling
          btn2.className = "toolbarbutton-1 chromeclass-toolbar-additional";
        }
        btn2.setAttribute("label", "New Private Tab");
        btn2.setAttribute("tooltiptext", "Open a new private tab (Ctrl+Alt+P)");

        if (isVerticalMode) {
          // Create the button structure to match native sidebar buttons
          const icon = doc.createXULElement("image");
          icon.className = "toolbarbutton-icon";
          icon.setAttribute("label", "New Private Tab");

          const text = doc.createXULElement("label");
          text.className = "toolbarbutton-text";
          text.setAttribute("crop", "end");
          text.setAttribute("flex", "1");
          text.setAttribute("value", "New Private Tab");

          // Clear any existing content and add new elements
          while (btn2.firstChild) {
            btn2.removeChild(btn2.firstChild);
          }
          btn2.appendChild(icon);
          btn2.appendChild(text);

          // Find or create the vertical container
          let container = doc.getElementById("newtab-buttons-container-vertical");
          if (!container) {
            container = doc.createXULElement("vbox");
            container.id = "newtab-buttons-container-vertical";

            // Find the periphery container
            const periphery = tabsNewTabButton.parentNode;
            if (periphery && periphery.id === "tabbrowser-arrowscrollbox-periphery") {
              // Find the spacer element
              const spacer = periphery.querySelector(".closing-tabs-spacer");

              // Insert container before spacer or at end
              if (spacer) {
                periphery.insertBefore(container, spacer);
              } else {
                periphery.appendChild(container);
              }

              // Move the new tab button into the container
              container.appendChild(tabsNewTabButton);
            }
          }

          // Add the private tab button to the container
          if (container) {
            container.appendChild(btn2);
          } else {
            // Fallback
            tabsNewTabButton.insertAdjacentElement("afterend", btn2);
          }
        } else {
          // For horizontal tabs toolbar, keep side-by-side placement
          tabsNewTabButton.insertAdjacentElement("afterend", btn2);
        }
      }
    });
  },

  observeTabsOrientation(aWindow) {
    const doc = aWindow.document;

    // Unified handler for orientation/visibility changes
    const handleOrientationChange = () => {
      this.updateUIVisibility(aWindow);
    };

    // Watch for changes to tabs orientation
    const tabsElement = doc.querySelector("tabs#tabbrowser-tabs");
    if (tabsElement) {
      this.orientationObserver = new aWindow.MutationObserver(mutations => {
        if (mutations.some(m => m.attributeName === 'orient')) {
          handleOrientationChange();
        }
      });
      this.orientationObserver.observe(tabsElement, {
        attributes: true,
        attributeFilter: ['orient']
      });
    }

    // Watch for changes to vertical-tabs visibility
    const verticalTabsBox = doc.querySelector("#vertical-tabs");
    if (verticalTabsBox) {
      this.verticalTabsObserver = new aWindow.MutationObserver(mutations => {
        if (mutations.some(m => m.attributeName === 'collapsed' || m.attributeName === 'hidden')) {
          handleOrientationChange();
        }
      });
      this.verticalTabsObserver.observe(verticalTabsBox, {
        attributes: true,
        attributeFilter: ['collapsed', 'hidden']
      });
    }
  },

  cleanupObservers(aWindow) {
    // Disconnect all observers
    ['orientationObserver', 'verticalTabsObserver'].forEach(observerName => {
      if (this[observerName]) {
        this[observerName].disconnect();
        this[observerName] = null;
      }
    });

    // Remove pref observers
    if (this.prefObserver) {
      try {
        Services.prefs.removeObserver(PREF_SHOW_NEWTAB_BUTTON, this.prefObserver);
      } catch (ex) {
        // Silently ignore
      }
      this.prefObserver = null;
    }
  },

  applyStyle() {
    try {
      const css = this.style;
      const uri = `data:text/css;charset=UTF-8,${encodeURIComponent(css)}`;
      if (this._currentStyleURI && this._currentStyleURI !== uri) {
        lazy.BrowserUtils.unregisterStylesheet(this._currentStyleURI);
      }
      // Register the new stylesheet and remember it
      lazy.BrowserUtils.registerStylesheet(uri);
      this._currentStyleURI = uri;
    } catch (e) {
      // No-op
    }
  },

  updateUIVisibility(aWindow) {
    try {
      const doc = aWindow.document;

      const showNewTabButton = Services.prefs.getBoolPref(PREF_SHOW_NEWTAB_BUTTON, true);

      // Rebuild New Private Tab buttons according to pref
      if (showNewTabButton) {
        this.createToolbarButton(aWindow);
        this.initPrivateTabButtonListeners(aWindow);
      } else {
        this.cleanupPrivateTabButtons(aWindow);
      }
    } catch (e) {
      // No-op
    }
  },

  initPrefObservers(aWindow) {
    // Observe preferences for visibility changes of toolbar and new tab buttons
    if (!this.prefObserver) {
      this.prefObserver = {
        observe: (subject, topic, data) => {
          if (topic !== "nsPref:changed") {
            return;
          }
          if (data === PREF_SHOW_NEWTAB_BUTTON) {
            try {
              // Re-apply styles and update UI based on new pref values
              this.applyStyle();
              this.updateUIVisibility(aWindow);
            } catch (e) {
              // No-op
            }
          }
        },
      };
    }

    try {
      Services.prefs.addObserver(PREF_SHOW_NEWTAB_BUTTON, this.prefObserver);
    } catch (ex) {
      // Pref service may not be available in some early/late lifecycle stages
    }
  },

  initPrivateTabButtonListeners(aWindow) {
    const doc = aWindow.document;

    // Handler for private tab button clicks
    const handleClick = (e) => {
      if (e.button === 0) {
        this.browserOpenTabPrivate(aWindow);
      } else if (e.button === 2) {
        doc.getElementById("toolbar-context-menu")?.openPopup(
          e.currentTarget, "after_start", 14, -10, false, false
        );
        e.preventDefault();
      }
    };

    // Attach listeners to all private tab buttons
    doc.querySelectorAll(`[id^="${this.BTN2_ID}"]`).forEach(btn2 => {
      // Remove any existing listeners by cloning
      const newBtn2 = btn2.cloneNode(true);
      btn2.parentNode?.replaceChild(newBtn2, btn2);
      newBtn2.addEventListener("click", handleClick);
    });
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

    // Initialize private tab button listeners
    this.initPrivateTabButtonListeners(aWindow);
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
      lazy.ContextualIdentityService._forEachContainerTab((tab, tabbrowser) => {
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
    const win = aEvent.view || aEvent.target?.ownerGlobal;
    if (!win) {
      return;
    }
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
      const win = aEvent.view || aEvent.target?.ownerGlobal;
      const openLink = win?.document.getElementById("openLinkInPrivateTab");
      if (openLink) {
        openLink.hidden = true;
      }
    }
  },

  tabContext(aEvent) {
    const win = aEvent.view || aEvent.target?.ownerGlobal;
    if (!win) {
      return;
    }
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
    const originalOpenTabset = lazy.PlacesUIUtils.openTabset;
    lazy.PlacesUIUtils.openTabset = function (
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

  // Prevent saving search form history for Private container tabs (urlbar/searchbar)
  // and ensure in-page search uses the private default engine in PrivateTab container tabs.
  overrideContentSearchParent() {
    if (this._contentSearchPatched) {
      return;
    }
    this._contentSearchPatched = true;
    try {
      const originalAddFormHistoryEntry =
        lazy.ContentSearch.addFormHistoryEntry.bind(lazy.ContentSearch);
      // Block writing form history entries coming from PrivateTab container tabs.
      lazy.ContentSearch.addFormHistoryEntry = async (browser, entry = null) => {
        try {
          const win = browser?.ownerGlobal;
          const tab =
            win?.gBrowser?.getTabForBrowser &&
            win.gBrowser.getTabForBrowser(browser);
          if (tab && this.isPrivate(tab)) {
            // Do not store form history for searches from Private container tabs
            return false;
          }
        } catch (e) {
          // Ignore and fall through to original
        }
        return originalAddFormHistoryEntry(browser, entry);
      };

      // When ContentSearch is asked for the current engine from a PrivateTab
      // container tab, force it to use the default private engine instead of
      // the normal default engine, while keeping the normal behavior elsewhere.
      if (typeof lazy.ContentSearch._onMessageGetEngine == "function") {
        const originalOnMessageGetEngine =
          lazy.ContentSearch._onMessageGetEngine.bind(lazy.ContentSearch);

        lazy.ContentSearch._onMessageGetEngine = async eventItem => {
          const actor = eventItem?.actor;
          try {
            const bc = actor?.browsingContext;
            const browser =
              bc?.top?.embedderElement || bc?.embedderElement || null;
            const win = browser?.ownerGlobal || null;
            const privateContainerId =
              win?.PrivateTab?.container?.userContextId;

            if (
              privateContainerId &&
              browser?.getAttribute("usercontextid") ==
                privateContainerId
            ) {
              const state = await lazy.ContentSearch.currentStateObj();
              return lazy.ContentSearch._reply(actor, "Engine", {
                isPrivateEngine: true,
                engine: state.currentPrivateEngine,
              });
            }
          } catch (e) {
            // Fall through to original handler on any failure
          }

          return originalOnMessageGetEngine(eventItem);
        };
      }
    } catch (e) {
      // Silently ignore if actor is unavailable
    }
  },

  // Helper to detect Private container queries in urlbar contexts
  _isPrivateQueryContext(queryContext) {
    return !!this.container?.userContextId &&
      queryContext?.userContextId == this.container.userContextId;
  },

  // Suppress urlbar suggestions providers that leak search data in Private container tabs
  overrideUrlbarProviders() {
    if (this._urlbarProvidersPatched) {
      return;
    }
    this._urlbarProvidersPatched = true;

    // Disable remote and local search suggestions provider for Private container
    try {
      const prov = lazy.UrlbarProviderSearchSuggestions;
      if (prov && typeof prov.isActive == "function") {
        const origIsActive = prov.isActive.bind(prov);
        prov.isActive = async queryContext => {
          if (this._isPrivateQueryContext(queryContext)) {
            return false;
          }
          return origIsActive(queryContext);
        };
      }
    } catch (e) {
      // No-op
    }

    // Disable recent searches provider for Private container
    try {
      const recent = lazy.UrlbarProviderRecentSearches;
      if (recent && typeof recent.isActive == "function") {
        const origRecentActive = recent.isActive.bind(recent);
        recent.isActive = async queryContext => {
          if (this._isPrivateQueryContext(queryContext)) {
            return false;
          }
          return origRecentActive(queryContext);
        };
      }
    } catch (e) {
      // No-op
    }
  },

  // Prevent urlbar form/input history writes from Private container tabs
  overrideUrlbarUtils() {
    if (this._urlbarUtilsPatched) {
      return;
    }
    this._urlbarUtilsPatched = true;

    // Block saving form history (search terms) when Private container is active
    try {
      const origAddToFormHistory =
        lazy.UrlbarUtils.addToFormHistory.bind(lazy.UrlbarUtils);
      lazy.UrlbarUtils.addToFormHistory = (input, value, source) => {
        try {
          const win = input?.window || input?.ownerGlobal;
          const uci = parseInt(
            win?.gBrowser?.selectedBrowser?.getAttribute("usercontextid") || 0
          );
          if (uci == this.container?.userContextId) {
            return Promise.resolve();
          }
        } catch (e) {
          // No-op
        }
        return origAddToFormHistory(input, value, source);
      };
    } catch (e) {
      // No-op
    }

    // Block saving adaptive input history when Private container is active
    try {
      const origAddToInputHistory =
        lazy.UrlbarUtils.addToInputHistory.bind(lazy.UrlbarUtils);
      lazy.UrlbarUtils.addToInputHistory = async (url, input) => {
        try {
          const win = lazy.BrowserUtils.mostRecentWindow;
          const uci = parseInt(
            win?.gBrowser?.selectedBrowser?.getAttribute("usercontextid") || 0
          );
          if (uci == this.container?.userContextId) {
            return;
          }
        } catch (e) {
          // No-op
        }
        return origAddToInputHistory(url, input);
      };
    } catch (e) {
      // No-op
    }
  },

  // Make UrlbarSearchUtils treat PrivateTab container tabs as private for default engine selection
  overrideUrlbarSearchUtils() {
    if (this._urlbarSearchUtilsPatched) {
      return;
    }
    this._urlbarSearchUtilsPatched = true;

    try {
      const origGetDefaultEngine =
        lazy.UrlbarSearchUtils.getDefaultEngine.bind(lazy.UrlbarSearchUtils);
      lazy.UrlbarSearchUtils.getDefaultEngine = (isPrivate = false) => {
        try {
          // If not already marked as private, check if the active tab is a PrivateTab container tab.
          if (!isPrivate) {
            const win = lazy.BrowserUtils.mostRecentWindow;
            const tab = win?.gBrowser?.selectedTab;
            if (tab && win.PrivateTab?.isPrivate?.(tab)) {
              isPrivate = true;
            }
          }
        } catch (e) {
          // No-op
        }
        return origGetDefaultEngine(isPrivate);
      };
    } catch (e) {
      // No-op
    }
  },

  // Ensure urlbar handoff uses the private default engine in PrivateTab container tabs
  overrideUrlbarHandoff(aWindow) {
    try {
      const gURLBar = aWindow.gURLBar;
      if (!gURLBar || gURLBar._privateTabHandoffPatched) {
        return;
      }
      gURLBar._privateTabHandoffPatched = true;
      const originalHandoff = gURLBar.handoff.bind(gURLBar);
      gURLBar.handoff = (searchString, searchEngine, newtabSessionId) => {
        try {
          const win = gURLBar.window || aWindow;
          const tab = win.gBrowser?.selectedTab;
          if (tab && win.PrivateTab?.isPrivate?.(tab)) {
            const defaultEngine = Services.search.defaultEngine;
            const privateEngine = Services.search.defaultPrivateEngine;
            if (privateEngine) {
              if (!searchEngine || searchEngine == defaultEngine) {
                searchEngine = privateEngine;
              }
            }
          }
        } catch (e) {
          // No-op
        }
        return originalHandoff(searchString, searchEngine, newtabSessionId);
      };
    } catch (e) {
      // No-op
    }
  },

  openAllPrivate(event) {
    if (!this.container?.userContextId) return;
    event.userContextId = this.container.userContextId;
    lazy.PlacesUIUtils.openSelectionInTabs(event);
  },

  openPrivateTab(event) {
    if (!this.container?.userContextId) return;
    const view = event.target.parentElement._view;
    if (view && view.selectedNode) {
      lazy.PlacesUIUtils._openNodeIn(view.selectedNode, "tab", view.ownerWindow, {
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
        lazy.TabStateCache.update(newBrowser.permanentKey, {
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
    // Clear any existing urlbar view data when switching into a Private container tab
    if (this.isPrivate(tab)) {
      try {
        win.gURLBar?.view?.clear?.();
      } catch (e) {
        // No-op
      }
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
          if (lazy.TabStateCache && tab.linkedBrowser?.permanentKey) {
            lazy.TabStateCache.delete(tab.linkedBrowser.permanentKey);
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
          if (lazy.TabStateCache && tab.linkedBrowser?.permanentKey) {
            lazy.TabStateCache.delete(tab.linkedBrowser.permanentKey);
          }
        } catch (ex) {
          // TabStateCache might not be available - silently continue
        }
      }
    });
  },
};
