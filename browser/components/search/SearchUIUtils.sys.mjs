/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Various utilities for search related UI.
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "SearchUIUtilsL10n", () => {
  return new Localization(["browser/search.ftl", "branding/brand.ftl"]);
});

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserSearchTelemetry:
    "moz-src:///browser/components/search/BrowserSearchTelemetry.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  CustomizableUI: "resource:///modules/CustomizableUI.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

export var SearchUIUtils = {
  initialized: false,

  init() {
    if (!this.initialized) {
      Services.obs.addObserver(this, "browser-search-engine-modified");

      this.initialized = true;
    }
  },

  observe(engine, topic, data) {
    switch (data) {
      case "engine-default":
        this.updatePlaceholderNamePreference(engine, false);
        break;
      case "engine-default-private":
        this.updatePlaceholderNamePreference(engine, true);
        break;
    }
  },

  /**
   * This function is called by the category manager for the
   * `search-service-notification` category.
   *
   * It allows the SearchService (in toolkit) to display
   * notifications in the browser for certain events.
   *
   * @param {string} notificationType
   *   Determines the function displaying the notification.
   * @param  {...any} args
   *   The arguments for that function.
   */
  showSearchServiceNotification(notificationType, ...args) {
    switch (notificationType) {
      case "search-engine-removal":
        this.removalOfSearchEngineNotificationBox(...args);
        break;
      case "search-settings-reset":
        this.searchSettingsResetNotificationBox(...args);
        break;
    }
  },

  /**
   * Infobar to notify the user's search engine has been removed
   * and replaced with an application default search engine.
   *
   * @param {string} oldEngine
   *   name of the engine to be moved and replaced.
   * @param {string} newEngine
   *   name of the application default engine to replaced the removed engine.
   */
  async removalOfSearchEngineNotificationBox(oldEngine, newEngine) {
    let win = lazy.BrowserWindowTracker.getTopWindow();

    let buttons = [
      {
        "l10n-id": "remove-search-engine-button",
        primary: true,
        callback() {
          const notificationBox = win.gNotificationBox.getNotificationWithValue(
            "search-engine-removal"
          );
          win.gNotificationBox.removeNotification(notificationBox);
        },
      },
      {
        supportPage: "search-engine-removal",
      },
    ];

    await win.gNotificationBox.appendNotification(
      "search-engine-removal",
      {
        label: {
          "l10n-id": "removed-search-engine-message2",
          "l10n-args": { oldEngine, newEngine },
        },
        priority: win.gNotificationBox.PRIORITY_SYSTEM,
      },
      buttons
    );

    // _updatePlaceholderFromDefaultEngine only updates the pref if the search service
    // hasn't finished initializing, so we explicitly update it here to be sure.
    SearchUIUtils.updatePlaceholderNamePreference(
      await Services.search.getDefault(),
      false
    );
    SearchUIUtils.updatePlaceholderNamePreference(
      await Services.search.getDefaultPrivate(),
      true
    );

    for (let openWin of lazy.BrowserWindowTracker.orderedWindows) {
      openWin.gURLBar
        ?._updatePlaceholderFromDefaultEngine()
        .catch(console.error);
    }
  },

  /**
   * Infobar informing the user that the search settings had to be reset
   * and what their new default engine is.
   *
   * @param {string} newEngine
   *   Name of the new default engine.
   */
  async searchSettingsResetNotificationBox(newEngine) {
    let win = lazy.BrowserWindowTracker.getTopWindow();

    let buttons = [
      {
        "l10n-id": "reset-search-settings-button",
        primary: true,
        callback() {
          const notificationBox = win.gNotificationBox.getNotificationWithValue(
            "search-settings-reset"
          );
          win.gNotificationBox.removeNotification(notificationBox);
        },
      },
      {
        supportPage: "prefs-search",
      },
    ];

    await win.gNotificationBox.appendNotification(
      "search-settings-reset",
      {
        label: {
          "l10n-id": "reset-search-settings-message",
          "l10n-args": { newEngine },
        },
        priority: win.gNotificationBox.PRIORITY_SYSTEM,
      },
      buttons
    );
  },

  /**
   * Adds an open search engine and handles error UI.
   *
   * @param {string} locationURL
   *   The URL where the OpenSearch definition is located.
   * @param {string} image
   *   A URL string to an icon file to be used as the search engine's
   *   icon. This value may be overridden by an icon specified in the
   *   engine description file.
   * @param {object} browsingContext
   *   The browsing context any error prompt should be opened for.
   * @returns {Promise<boolean>}
   *   Returns true if the engine was added.
   */
  async addOpenSearchEngine(locationURL, image, browsingContext) {
    try {
      await Services.search.addOpenSearchEngine(locationURL, image);
    } catch (ex) {
      let titleMsgName;
      let descMsgName;
      switch (ex.result) {
        case Ci.nsISearchService.ERROR_DUPLICATE_ENGINE:
          titleMsgName = "opensearch-error-duplicate-title";
          descMsgName = "opensearch-error-duplicate-desc";
          break;
        case Ci.nsISearchService.ERROR_ENGINE_CORRUPTED:
          titleMsgName = "opensearch-error-format-title";
          descMsgName = "opensearch-error-format-desc";
          break;
        default:
          // i.e. ERROR_DOWNLOAD_FAILURE
          titleMsgName = "opensearch-error-download-title";
          descMsgName = "opensearch-error-download-desc";
          break;
      }

      let [title, text] = await lazy.SearchUIUtilsL10n.formatValues([
        {
          id: titleMsgName,
        },
        {
          id: descMsgName,
          args: {
            "location-url": locationURL,
          },
        },
      ]);

      Services.prompt.alertBC(
        browsingContext,
        Ci.nsIPrompt.MODAL_TYPE_CONTENT,
        title,
        text
      );
      return false;
    }
    return true;
  },

  /**
   * Returns the URL to use for where to get more search engines.
   *
   * @returns {string}
   */
  get searchEnginesURL() {
    return Services.urlFormatter.formatURLPref(
      "browser.search.searchEnginesURL"
    );
  },

  /**
   * Update the placeholderName preference for the default search engine.
   *
   * @param {nsISearchEngine} engine The new default search engine.
   * @param {boolean} isPrivate Whether this change applies to private windows.
   */
  updatePlaceholderNamePreference(engine, isPrivate) {
    const prefName =
      "browser.urlbar.placeholderName" + (isPrivate ? ".private" : "");
    if (engine.isAppProvided) {
      Services.prefs.setStringPref(prefName, engine.name);
    } else {
      Services.prefs.clearUserPref(prefName);
    }
  },

  /**
   * Focuses the search bar if present on the toolbar, or the address bar,
   * putting it in search mode. Will do so in an existing non-popup browser
   * window or open a new one if necessary.
   *
   * @param {WindowProxy} window
   *   The window where the seach was triggered.
   */
  webSearch(window) {
    if (
      window.location.href != AppConstants.BROWSER_CHROME_URL ||
      window.gURLBar.readOnly
    ) {
      let topWindow = lazy.BrowserWindowTracker.getTopWindow();
      if (topWindow && !topWindow.gURLBar.readOnly) {
        // If there's an open browser window, it should handle this command.
        topWindow.focus();
        SearchUIUtils.webSearch(topWindow);
      } else {
        // If there are no open browser windows, open a new one.
        let newWindow = window.openDialog(
          AppConstants.BROWSER_CHROME_URL,
          "_blank",
          "chrome,all,dialog=no",
          "about:blank"
        );

        let observer = subject => {
          if (subject == newWindow) {
            SearchUIUtils.webSearch(newWindow);
            Services.obs.removeObserver(
              observer,
              "browser-delayed-startup-finished"
            );
          }
        };
        Services.obs.addObserver(observer, "browser-delayed-startup-finished");
      }
      return;
    }

    let focusUrlBarIfSearchFieldIsNotActive = function (aSearchBar) {
      if (!aSearchBar || window.document.activeElement != aSearchBar.textbox) {
        // Limit the results to search suggestions, like the search bar.
        window.gURLBar.searchModeShortcut();
      }
    };

    let searchBar = window.document.getElementById("searchbar");
    let placement =
      lazy.CustomizableUI.getPlacementOfWidget("search-container");
    let focusSearchBar = () => {
      searchBar = window.document.getElementById("searchbar");
      searchBar.select();
      focusUrlBarIfSearchFieldIsNotActive(searchBar);
    };
    if (
      placement &&
      searchBar &&
      ((searchBar.parentNode.getAttribute("overflowedItem") == "true" &&
        placement.area == lazy.CustomizableUI.AREA_NAVBAR) ||
        placement.area == lazy.CustomizableUI.AREA_FIXED_OVERFLOW_PANEL)
    ) {
      let navBar = window.document.getElementById(
        lazy.CustomizableUI.AREA_NAVBAR
      );
      navBar.overflowable.show().then(focusSearchBar);
      return;
    }
    if (searchBar) {
      if (window.fullScreen) {
        window.FullScreen.showNavToolbox();
      }
      searchBar.select();
    }
    focusUrlBarIfSearchFieldIsNotActive(searchBar);
  },

  /**
   * Perform a search initiated by the UI.
   *
   * @param {WindowProxy} window
   *   The window where the search was triggered.
   * @param {string} searchText
   *   The search terms to use for the search.
   * @param {string} where
   *   Where the search results should be displayed:
   *     "tab"      in a new foreground tab;
   *     "tabshifted" in a new background tab;
   *     "window"   in a new window;
   *     "current"  in the current tab.
   * @param {boolean} usePrivate
   *   Whether to use the Private Browsing mode default search engine.
   *   Defaults to `false`.
   * @param {nsIPrincipal} triggeringPrincipal
   *   The principal to use for a new window or tab.
   * @param {nsIContentSecurityPolicy} csp
   *   The content security policy to use for a new window or tab.
   * @param {boolean} inBackground
   *   Whether to open the new tab in the background.
   * @param {nsISearchEngine} [engine]
   *   Optional. The search engine to use.
   * @param {object} [tab]
   *   Optional. The tab to use for the search.
   * @param {number|null} [userContextId]
   *   Optional. The container userContextId to use for the search tab.
   * @returns {object | null}
   *   An object containing information about the performed
   *   search and the url, or null if no search was performed.
   */
  async _loadSearch(
    window,
    searchText,
    where,
    usePrivate,
    triggeringPrincipal,
    csp,
    inBackground = false,
    engine = null,
    tab = null,
    userContextId = null
  ) {
    if (!triggeringPrincipal) {
      throw new Error(
        "Required argument triggeringPrincipal missing within _loadSearch"
      );
    }

    if (!engine) {
      engine = usePrivate
        ? await Services.search.getDefaultPrivate()
        : await Services.search.getDefault();
    }

    let submission = engine.getSubmission(searchText);

    // getSubmission can return null if the engine doesn't have a URL
    // with a text/html response type. This is unlikely (since
    // SearchService._addEngineToStore() should fail for such an engine),
    // but let's be on the safe side.
    if (!submission) {
      return null;
    }

    window.openLinkIn(submission.uri.spec, where || "current", {
      private: usePrivate && !lazy.PrivateBrowsingUtils.isWindowPrivate(window),
      postData: submission.postData,
      inBackground,
      relatedToCurrent: true,
      triggeringPrincipal,
      csp,
      targetBrowser: tab?.linkedBrowser,
      userContextId,
      globalHistoryOptions: {
        triggeringSearchEngine: engine.name,
      },
    });

    return { engine, url: submission.uri };
  },

  /**
   * Perform a search initiated from the context menu.
   * This should only be called from the context menu.
   *
   * @param {WindowProxy} window
   *   The window where the search was triggered.
   * @param {string} searchText
   *   The search terms to use for the search.
   * @param {boolean} usePrivate
   *   Whether to use the Private Browsing mode default search engine.
   *   Defaults to `false`.
   * @param {nsIPrincipal} triggeringPrincipal
   *   The principal of the document whose context menu was clicked.
   * @param {nsIContentSecurityPolicy} csp
   *   The content security policy to use for a new window or tab.
   * @param {Event} event
   *   The event triggering the search.
   */
  async loadSearchFromContext(
    window,
    searchText,
    usePrivate,
    triggeringPrincipal,
    csp,
    event
  ) {
    event = lazy.BrowserUtils.getRootEvent(event);
    let where = lazy.BrowserUtils.whereToOpenLink(event);
    if (where == "current") {
      // override: historically search opens in new tab
      where = "tab";
    }

    const isPrivateWindow = lazy.PrivateBrowsingUtils.isWindowPrivate(window);
    let isPrivateContainerTab = false;
    let userContextId = null;

    if (!isPrivateWindow && window.PrivateTab?.container?.userContextId) {
      try {
        const tab = window.gBrowser?.selectedTab;
        if (tab && window.PrivateTab?.isPrivate?.(tab)) {
          isPrivateContainerTab = true;
          userContextId = window.PrivateTab.container.userContextId;
        }
      } catch (e) {
        // Ignore and fall back to window-level privacy only
      }
    }

    // For real private windows, keep behavior. For non-private windows:
    // - If this is a PrivateTab container tab, keep using a tab.
    // - Otherwise, open a new private window as before.
    if (usePrivate && !isPrivateWindow && !isPrivateContainerTab) {
      where = "window";
    }

    let inBackground = Services.prefs.getBoolPref(
      "browser.search.context.loadInBackground"
    );
    if (event.button == 1 || event.ctrlKey) {
      inBackground = !inBackground;
    }

    let engineOverride = null;
    let usePrivateForWindow = usePrivate;
    if (usePrivate && isPrivateContainerTab) {
      // Use the private default engine in a PrivateTab container tab, but do not
      // open a real private window.
      usePrivateForWindow = false;
      engineOverride = await Services.search.getDefaultPrivate();
    }

    let searchInfo = await SearchUIUtils._loadSearch(
      window,
      searchText,
      where,
      usePrivateForWindow,
      Services.scriptSecurityManager.createNullPrincipal(
        triggeringPrincipal.originAttributes
      ),
      csp,
      inBackground,
      engineOverride,
      null,
      userContextId
    );

    if (searchInfo) {
      lazy.BrowserSearchTelemetry.recordSearch(
        window.gBrowser.selectedBrowser,
        searchInfo.engine,
        "contextmenu"
      );
    }
  },

  /**
   * Perform a search initiated from the command line.
   *
   * @param {WindowProxy} window
   *   The window where the search was triggered.
   * @param {string} searchText
   *   The search terms to use for the search.
   * @param {boolean} usePrivate
   *   Whether to use the Private Browsing mode default search engine.
   *   Defaults to `false`.
   * @param {nsIPrincipal} triggeringPrincipal
   *   The principal to use for a new window or tab.
   * @param {nsIContentSecurityPolicy} csp
   *   The content security policy to use for a new window or tab.
   */
  async loadSearchFromCommandLine(
    window,
    searchText,
    usePrivate,
    triggeringPrincipal,
    csp
  ) {
    let searchInfo = await SearchUIUtils._loadSearch(
      window,
      searchText,
      "current",
      usePrivate,
      triggeringPrincipal,
      csp
    );
    if (searchInfo) {
      lazy.BrowserSearchTelemetry.recordSearch(
        window.gBrowser.selectedBrowser,
        searchInfo.engine,
        "system"
      );
    }
  },

  /**
   * Perform a search initiated from an extension.
   *
   * @param {object} params
   *   The params.
   * @param {WindowProxy} params.window
   *   The window where the search was triggered.
   * @param {string} params.query
   *   The search terms to use for the search.
   * @param {nsISearchEngine} params.engine
   *   The search engine to use for the search.
   * @param {string} params.where
   *   String indicating where the search should load.
   * @param {NativeTab} params.tab
   *   The tab to show the search result.
   * @param {nsIPrincipal} params.triggeringPrincipal
   *   The principal to use for a new window or tab.
   */
  async loadSearchFromExtension({
    window,
    query,
    engine,
    where,
    tab,
    triggeringPrincipal,
  }) {
    let searchInfo = await SearchUIUtils._loadSearch(
      window,
      query,
      where,
      lazy.PrivateBrowsingUtils.isWindowPrivate(window),
      triggeringPrincipal,
      null,
      false,
      engine,
      tab
    );

    if (searchInfo) {
      lazy.BrowserSearchTelemetry.recordSearch(
        window.gBrowser.selectedBrowser,
        searchInfo.engine,
        "webextension"
      );
    }
  },
};
