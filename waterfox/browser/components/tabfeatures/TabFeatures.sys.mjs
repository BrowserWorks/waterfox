/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export const TabFeatures = {
  NEW_TAB_CONFIG_PATH: "browser.newtab.url",
  newTabURL: null,
  prefListener: null,
  PREF_ACTIVETAB: "browser.tabs.copyurl.activetab",
  PREF_REQUIRECONFIRM: "browser.restart_menu.requireconfirm",
  PREF_PURGECACHE: "browser.restart_menu.purgecache",
  PREF_COPYURL_SHORTCUT: "browser.tabs.copyurl.shortcut",

  init(aWindow) {
    // Wait for XUL elements to be available before initializing listeners.
    // 'context_copyTabUrl' is an element from our associated XUL, which we will now wait for.
    if (!aWindow.document.getElementById("context_copyTabUrl")) {
      lazy.setTimeout(() => {
        this.init(aWindow);
      }, 50); // Retry after 50ms
      return;
    }

    aWindow.TabFeatures = this;
    this.initListeners(aWindow);
    this.initNewTabConfig(); // Does not require aWindow
    this.initNewTabFocus(aWindow);
    this.initShortcutCopyUrl(aWindow);
  },

  destroy() {
    this.destroyNewTabConfig();
  },

  initListeners(aWindow) {
    const doc = aWindow.document;

    doc
      .getElementById("tabContextMenu")
      ?.addEventListener("popupshowing", this.tabContext.bind(this));
    if (AppConstants.platform === "macosx") {
      doc
        .getElementById("file-menu")
        ?.addEventListener("popupshowing", this.tabContext.bind(this));
    } else {
      doc
        .getElementById("appMenu-popup")
        ?.addEventListener("popupshowing", this.tabContext.bind(this));
    }

    const copyTabUrlElement = doc.getElementById("context_copyTabUrl");
    if (copyTabUrlElement) {
      copyTabUrlElement.addEventListener("command", (_event) => {
        if (aWindow.TabContextMenu?.contextTab?.linkedBrowser) {
          try {
            this.copyTabUrl(
              aWindow.TabContextMenu.contextTab.linkedBrowser.currentURI.spec,
              aWindow
            );
          } catch (e) {
            console.error(
              "TabFeatures: Error inside copyTabUrl listener execution:",
              e
            );
          }
        } else {
          // console.warn("TabFeatures: copyTabUrl not called, context or linkedBrowser not available.");
        }
      });
    } else {
      console.error(
        "TabFeatures: FAILED to find element 'context_copyTabUrl'. Listener NOT attached."
      );
    }

    doc
      .getElementById("context_copyAllTabUrls")
      ?.addEventListener("command", (_event) => {
        this.copyAllTabUrls(aWindow);
      });

    doc
      .getElementById("context_unloadTab")
      ?.addEventListener("command", (_event) => {
        if (
          aWindow.gBrowser &&
          aWindow.TabContextMenu &&
          aWindow.TabContextMenu.contextTab
        ) {
          // Prevent unloading if it's the last tab or the only non-pinned tab in the window
          if (
            aWindow.gBrowser.tabs.length > 1 &&
            (Array.from(aWindow.gBrowser.tabs).filter((t) => !t.pinned).length >
              1 ||
              !aWindow.TabContextMenu.contextTab.pinned)
          ) {
            aWindow.gBrowser.discardBrowser(aWindow.TabContextMenu.contextTab);
          } else {
            // console.log("TabFeatures: discardBrowser not called, conditions not met (e.g., last tab).");
          }
        } else {
          // console.warn("TabFeatures: discardBrowser not called, context not available.");
        }
      });

    const restartMac = doc.getElementById("app_restartBrowser");
    if (restartMac) {
      restartMac.addEventListener("command", (_event) => {
        this.restartBrowser();
      });
    }

    const restartOther = doc.getElementById("appMenu-restart-button");
    if (restartOther && restartOther.getAttribute("data-tabfeatures-handler-attached") !== "true") {
      restartOther.addEventListener("command", (_event) => {
        this.restartBrowser();
      });
      restartOther.setAttribute("data-tabfeatures-handler-attached", "true");
    }
  },

  initNewTabConfig() {
    // Fetch pref if it exists
    this.newTabURL = Services.prefs.getStringPref(this.NEW_TAB_CONFIG_PATH, "");

    // Only proceed if a value is actually set
    if (this.newTabURL) {
      try {
        lazy.AboutNewTab.newTabURL = this.newTabURL;
        this.prefListener = Services.prefs.addObserver(
          this.NEW_TAB_CONFIG_PATH,
          (_subject, _topic, _data) => {
            const newURL = Services.prefs.getStringPref(
              this.NEW_TAB_CONFIG_PATH,
              ""
            );
            if (newURL) {
              lazy.AboutNewTab.newTabURL = newURL;
            } else {
              // If the pref is cleared, revert to default behavior
              lazy.AboutNewTab.resetNewTabURL();
            }
          }
        );
      } catch (e) {
        console.error("Error initializing new tab config:", e);
      }
    }
  },

  initNewTabFocus(window) {
    window.gBrowser.tabContainer.addEventListener("TabOpen", (event) => {
      const tab = event.target;
      const browser = window.gBrowser.getBrowserForTab(tab);

      browser.addEventListener(
        "load",
        function onLoad() {
          browser.removeEventListener("load", onLoad);
          window.setTimeout(() => {
            browser.contentWindow.focus();
          }, 0);
        },
        { once: true }
      );
    });
  },

  initShortcutCopyUrl(aWindow) {
    const doc = aWindow.document;

    const handler = (e) => {
      try {
        // Allow disabling via pref; default to enabled if unset
        if (!Services.prefs.getBoolPref(this.PREF_COPYURL_SHORTCUT, true)) {
          return;
        }

        const isMac = AppConstants.platform === "macosx";
        const accelPressed = isMac ? e.metaKey : e.ctrlKey;

        if (!accelPressed || !e.shiftKey || e.key?.toLowerCase() !== "u") {
          return;
        }

        const url = aWindow.gBrowser?.currentURI?.spec;
        if (!url) {
          return;
        }

        // Prevent default so we don't trigger other shortcuts
        e.preventDefault();
        e.stopPropagation();

        this.copyTabUrl(url, aWindow);
        this._showCopyNotification(url, aWindow);
      } catch (err) {
        console.error("TabFeatures: shortcut copy failed", err);
      }
    };

    // Capture phase to beat page-level handlers
    doc.addEventListener("keydown", handler, true);

    aWindow.addEventListener(
      "unload",
      () => {
        try {
          doc.removeEventListener("keydown", handler, true);
        } catch (_) {}
      },
      { once: true }
    );
  },

  _showCopyNotification(url, aWindow) {
    try {
      const alerts = Cc["@mozilla.org/alerts-service;1"].getService(
        Ci.nsIAlertsService
      );
      const title = "🔗 URL Copied";
      const text = url.length > 50 ? url.substring(0, 47) + "..." : url;

      alerts.showAlertNotification(
        null,
        title,
        text,
        false,
        "",
        null,
        "tabfeatures-copyurl"
      );
    } catch (e) {
      console.log("URL copied to clipboard:", url);
    }
  },

  destroyNewTabConfig() {
    if (this.prefListener) {
      Services.prefs.removeObserver(
        this.NEW_TAB_CONFIG_PATH,
        this.prefListener
      );
      this.prefListener = null;
    }
  },

  tabContext(aEvent) {
    let win = aEvent.view;
    if (!win) {
      win = Services.wm.getMostRecentWindow("navigator:browser");
    }
    const { document } = win;
    const elements = document.getElementsByClassName("tabFeature");
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const pref = el.getAttribute("preference");
      if (pref) {
        const visible = Services.prefs.getBoolPref(pref);
        el.hidden = !visible;
      }
    }
    // Can't unload selected tab, so don't show menu item in that case
    if (win.TabContextMenu.contextTab === win.gBrowser.selectedTab) {
      const el = document.getElementById("context_unloadTab");
      el.hidden = true;
    }

    // Ensure restart button in App Menu (Windows/Linux) has its handler after template instantiation
    const restartBtn = document.getElementById("appMenu-restart-button");
    if (restartBtn) {
      // Toggle iconic styling to match icon prefs so alignment matches Exit when icons are disabled
      const iconsDisabled = Services.prefs.getBoolPref("userChrome.icon.disabled", false);
      const iconsInPanel = Services.prefs.getBoolPref("userChrome.icon.panel", false);
      const shouldIconic = iconsInPanel && !iconsDisabled;
      restartBtn.classList.toggle("subviewbutton-iconic", shouldIconic);

      if (restartBtn.getAttribute("data-tabfeatures-handler-attached") !== "true") {
        restartBtn.addEventListener("command", (_event) => {
          this.restartBrowser();
        });
        restartBtn.setAttribute("data-tabfeatures-handler-attached", "true");
      }
    }
  },

  // Copies current tab url to clipboard
  copyTabUrl(aUri, aWindow) {
    const gClipboardHelper = Cc[
      "@mozilla.org/widget/clipboardhelper;1"
    ].getService(Ci.nsIClipboardHelper);
    try {
      Services.prefs.getBoolPref(this.PREF_ACTIVETAB)
        ? gClipboardHelper.copyString(aWindow.gBrowser.currentURI.spec)
        : gClipboardHelper.copyString(aUri);
    } catch (e) {
      throw new Error(
        `We're sorry but something has gone wrong with 'CopyTabUrl' ${e}`
      );
    }
  },

  // Copies all tab urls to clipboard
  copyAllTabUrls(aWindow) {
    const gClipboardHelper = Cc[
      "@mozilla.org/widget/clipboardhelper;1"
    ].getService(Ci.nsIClipboardHelper);
    //Get all urls
    const urlArr = this._getAllUrls(aWindow);
    try {
      // Enumerate all urls in to a list.
      let urlList = urlArr.join("\n");
      // Send list to clipboard.
      gClipboardHelper.copyString(urlList.trim());
      // Clear url list after clipboard event
      urlList = "";
    } catch (e) {
      throw new Error(
        `We're sorry but something has gone wrong with 'copyAllTabUrls' ${e}`
      );
    }
  },

  // Get all the tab urls into an array.
  _getAllUrls(aWindow) {
    // We don't want to copy about uri's
    const blocklist = /^about:.*/i;
    const urlArr = [];
    const tabCount = aWindow.gBrowser.browsers.length;
    Array(tabCount)
      .fill()
      .map((_, i) => {
        const spec = aWindow.gBrowser.getBrowserAtIndex(i).currentURI.spec;
        if (!blocklist.test(spec)) {
          urlArr.push(spec);
        }
      });
    return urlArr;
  },

  async restartBrowser() {
    try {
      if (Services.prefs.getBoolPref(this.PREF_REQUIRECONFIRM)) {
        // Need brand in here to be able to expand { -brand-short-name }
        const l10n = new Localization([
          "branding/brand.ftl",
          "browser/waterfox.ftl",
        ]);
        const [title, question] = (
          await l10n.formatMessages([
            { id: "restart-prompt-title" },
            { id: "restart-prompt-question" },
          ])
        ).map(({ value }) => value);

        if (Services.prompt.confirm(null, title, question)) {
          // only restart if confirmation given
          this._attemptRestart();
        }
      } else {
        this._attemptRestart();
      }
    } catch (e) {
      console.error(
        "We're sorry but something has gone wrong with 'restartBrowser' ",
        e
      );
    }
  },

  _attemptRestart() {
    // Purge cache if required
    if (Services.prefs.getBoolPref(this.PREF_PURGECACHE)) {
      Services.appinfo.invalidateCachesOnRestart();
    }

    // Initiate the restart
    Services.startup.quit(
      Services.startup.eRestart | Services.startup.eAttemptQuit
    );
  },
};
