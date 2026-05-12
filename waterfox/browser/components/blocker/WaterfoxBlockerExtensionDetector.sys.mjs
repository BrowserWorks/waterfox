/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  addonDisplayName,
  isAdblockAddon,
  isEnabledAdblockAddon,
} from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  OnboardingMessageProvider:
    "resource:///modules/asrouter/OnboardingMessageProvider.sys.mjs",
  Spotlight: "resource:///modules/asrouter/Spotlight.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "blockerLocalization", () => {
  return new Localization(["browser/waterfox.ftl"]);
});

const PREF_BLOCKER_ENABLED = "waterfox.blocker.enabled";
const PREF_BLOCKER_UI_ENABLED = "waterfox.blocker.ui.enabled";
const PREF_DETECTION_DISMISSED = "waterfox.blocker.extensionDetectionDismissed";
const PREF_DISMISSED_INSTALL_WARNINGS =
  "waterfox.blocker.dismissedExtensionInstallWarnings";
const PREF_COEXIST = "waterfox.blocker.coexist";

const DETECTION_DELAY_MS = 500;
const CHROME_DOCUMENT_LOADED_TOPIC = "chrome-document-loaded";
const PREF_CHANGED_TOPIC = "nsPref:changed";
const EXTENSION_NAME_PLACEHOLDER = "__WATERFOX_BLOCKER_EXTENSION_NAME__";
const L10N_ID_EXTENSION_FALLBACK_NAME_THIS =
  "waterfox-blocker-extension-fallback-name-this";
const L10N_ID_EXTENSION_FALLBACK_NAME_YOUR =
  "waterfox-blocker-extension-fallback-name-your";
const L10N_ID_INSTALL_WARNING = "waterfox-blocker-extension-install-warning";
const L10N_ID_INSTALL_WARNING_MANAGE_SETTINGS =
  "waterfox-blocker-extension-install-manage-settings";
const L10N_ID_PROMPT_TITLE = "waterfox-blocker-prompt-title";
const L10N_ID_INSTALL_ANYWAY = "waterfox-blocker-extension-install-anyway";
const L10N_ID_KEEP_BUILT_IN =
  "waterfox-blocker-extension-install-keep-built-in";

function parseDismissedInstallWarnings(value) {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(id => typeof id === "string" && id.length);
  } catch (_) {
    // Pref value may be malformed JSON. Treat as an empty dismissal list.
    return [];
  }
}

/**
 * Detects conflicts between the built-in blocker and installed ad blocker
 * extensions. Runs conflict checks at startup and when add-on state changes,
 * shows Spotlight messaging after updates, and intercepts installs of
 * conflicting add-ons. Owns the localisation cache that synchronous install
 * warnings read from.
 */
export const WaterfoxBlockerExtensionDetector = {
  _addonListener: {
    onEnabled(addon) {
      WaterfoxBlockerExtensionDetector._onAddonStateChanged(addon);
    },
    onDisabled(addon) {
      WaterfoxBlockerExtensionDetector._onAddonStateChanged(addon);
    },
    onInstalled(addon) {
      WaterfoxBlockerExtensionDetector._onAddonStateChanged(addon);
    },
    onUninstalled(addon) {
      WaterfoxBlockerExtensionDetector._onAddonStateChanged(addon);
    },
  },
  _installListener: {
    onInstallStarted(install) {
      return WaterfoxBlockerExtensionDetector._onInstallStarted(install);
    },
    onInstallEnded(install) {
      WaterfoxBlockerExtensionDetector._onInstallEnded(install);
    },
  },

  _detectionActive: false,
  _detectedExtensionName: "",
  _detectionPromptInProgress: false,
  _cachedUpgradeBaseMessage: null,
  _initialized: false,
  _upgradeMessagePromise: null,
  _prefObserverSuppressed: false,
  _startupObserverRegistered: false,
  _windowState: new WeakMap(),
  _localizedStringCache: new Map(),
  _localizedStringLoadPromise: null,

  _getCachedString(id, fallback = id) {
    const value = this._localizedStringCache.get(id);
    if (!value || value === id) {
      return fallback;
    }
    return value;
  },

  async _preloadLocalizedStrings() {
    if (this._localizedStringLoadPromise) {
      return this._localizedStringLoadPromise;
    }

    this._localizedStringLoadPromise = (async () => {
      const ids = [
        L10N_ID_EXTENSION_FALLBACK_NAME_THIS,
        L10N_ID_PROMPT_TITLE,
        L10N_ID_INSTALL_WARNING_MANAGE_SETTINGS,
        L10N_ID_INSTALL_ANYWAY,
        L10N_ID_KEEP_BUILT_IN,
      ];

      let values = ids;
      try {
        values = await lazy.blockerLocalization.formatValues(ids);
      } catch (error) {
        console.error(
          "[WaterfoxBlockerExtensionDetector] Failed to resolve cached Fluent strings",
          error
        );
      }

      this._localizedStringCache.clear();
      ids.forEach((id, index) => {
        this._localizedStringCache.set(id, values[index] || id);
      });

      let warningTemplate = "";
      try {
        warningTemplate = await lazy.blockerLocalization.formatValue(
          L10N_ID_INSTALL_WARNING,
          { extensionName: EXTENSION_NAME_PLACEHOLDER }
        );
      } catch (error) {
        console.error(
          "[WaterfoxBlockerExtensionDetector] Failed to resolve install warning template",
          error
        );
      }

      this._localizedStringCache.set(
        "waterfox-blocker-extension-install-warning-template",
        warningTemplate || L10N_ID_INSTALL_WARNING
      );
    })();

    try {
      return await this._localizedStringLoadPromise;
    } finally {
      this._localizedStringLoadPromise = null;
    }
  },

  /**
   * Safe to call more than once.
   */
  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    lazy.AddonManager.addAddonListener(this._addonListener);
    lazy.AddonManager.addInstallListener(this._installListener);

    Services.prefs.addObserver(PREF_BLOCKER_ENABLED, this);
    Services.prefs.addObserver(PREF_DETECTION_DISMISSED, this);
    Services.prefs.addObserver(PREF_COEXIST, this);

    this._preloadLocalizedStrings().catch(error => {
      console.error(
        "[WaterfoxBlockerExtensionDetector] Failed to preload localized strings",
        error
      );
    });

    this._refreshDetectionNotifications().catch(error => {
      console.error(
        "[WaterfoxBlockerExtensionDetector] Startup detection failed",
        error
      );
    });
  },

  /**
   * Safe to call more than once.
   */
  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;

    this._prefObserverSuppressed = false;
    this._disableDetectionNotifications();

    try {
      lazy.AddonManager.removeAddonListener(this._addonListener);
    } catch (_) {
      // Listener may already be removed during shutdown ordering.
    }

    try {
      lazy.AddonManager.removeInstallListener(this._installListener);
    } catch (_) {
      // Listener may already be removed during shutdown ordering.
    }

    try {
      Services.prefs.removeObserver(PREF_BLOCKER_ENABLED, this);
    } catch (err) {
      console.warn(
        "[WaterfoxBlockerExtensionDetector] Failed to remove enabled observer:",
        err
      );
    }

    try {
      Services.prefs.removeObserver(PREF_DETECTION_DISMISSED, this);
    } catch (err) {
      console.warn(
        "[WaterfoxBlockerExtensionDetector] Failed to remove dismissed observer:",
        err
      );
    }

    try {
      Services.prefs.removeObserver(PREF_COEXIST, this);
    } catch (err) {
      console.warn(
        "[WaterfoxBlockerExtensionDetector] Failed to remove coexist observer:",
        err
      );
    }
  },

  observe(subject, topic, data) {
    switch (topic) {
      case CHROME_DOCUMENT_LOADED_TOPIC: {
        if (!this._detectionActive || !this._detectedExtensionName) {
          return;
        }

        const win = this._windowFromChromeDocument(subject);
        if (!win) {
          return;
        }

        this._hookDetectionWindow(win);
        this._scheduleSeedForWindow(win);
        break;
      }

      case PREF_CHANGED_TOPIC:
        if (data === PREF_BLOCKER_ENABLED) {
          this._onBuiltInBlockerPrefChanged();
        } else if (data === PREF_DETECTION_DISMISSED) {
          this._onDetectionDismissedPrefChanged();
        } else if (data === PREF_COEXIST) {
          this._onCoexistPrefChanged();
        }
        break;
    }
  },

  _onAddonStateChanged(addon) {
    if (!isAdblockAddon(addon)) {
      return;
    }

    this._refreshDetectionNotifications().catch(error => {
      console.error(
        "[WaterfoxBlockerExtensionDetector] Failed to refresh detection notifications",
        error
      );
    });
  },

  _onBuiltInBlockerPrefChanged() {
    if (this._prefObserverSuppressed) {
      return;
    }

    const builtInEnabled = Services.prefs.getBoolPref(
      PREF_BLOCKER_ENABLED,
      false
    );
    if (!builtInEnabled) {
      this._disableDetectionNotifications();
      return;
    }

    this._handleBuiltInBlockerReenabled()
      .then(() => this._refreshDetectionNotifications())
      .catch(error => {
        console.error(
          "[WaterfoxBlockerExtensionDetector] Re-enable handling failed",
          error
        );
      });
  },

  _onDetectionDismissedPrefChanged() {
    if (Services.prefs.getBoolPref(PREF_DETECTION_DISMISSED, false)) {
      this._disableDetectionNotifications();
      return;
    }

    this._refreshDetectionNotifications().catch(error => {
      console.error(
        "[WaterfoxBlockerExtensionDetector] Failed to re-enable detection notifications",
        error
      );
    });
  },

  _onCoexistPrefChanged() {
    if (this._isCoexistEnabled()) {
      this._disableDetectionNotifications();
      return;
    }

    this._refreshDetectionNotifications().catch(error => {
      console.error(
        "[WaterfoxBlockerExtensionDetector] Failed to refresh after coexist toggle",
        error
      );
    });
  },

  _isCoexistEnabled() {
    return Services.prefs.getBoolPref(PREF_COEXIST, false);
  },

  async _getEnabledAdblockAddons() {
    const addons = await lazy.AddonManager.getAddonsByTypes(["extension"]);
    return addons.filter(addon => isEnabledAdblockAddon(addon));
  },

  async _refreshDetectionNotifications() {
    if (
      Services.prefs.getBoolPref(PREF_DETECTION_DISMISSED, false) ||
      this._isCoexistEnabled()
    ) {
      this._disableDetectionNotifications();
      return;
    }

    const detectedAddon = (await this._getEnabledAdblockAddons())[0];
    if (!detectedAddon) {
      this._disableDetectionNotifications();
      return;
    }

    // Only act when the built-in blocker is actually enabled. During the
    // initial rollout the defaults are off, so there is no conflict to
    // resolve and we must not set the dismissed pref prematurely.
    if (!Services.prefs.getBoolPref(PREF_BLOCKER_ENABLED, false)) {
      this._disableDetectionNotifications();
      return;
    }

    // Built-in blocker must not run alongside an extension ad blocker.
    // Disable it immediately so both aren't filtering at the same time,
    // then show the upgrade modal so the user knows they can opt in later.
    this._setBuiltInBlockerEnabled(false);

    this._activateDetectionNotifications(addonDisplayName(detectedAddon));
  },

  _activateDetectionNotifications(extensionName) {
    this._detectionActive = true;
    this._detectedExtensionName =
      extensionName ||
      this._getCachedString(L10N_ID_EXTENSION_FALLBACK_NAME_THIS);

    this._prewarmUpgradeMessage();
    this._addStartupObserver();

    this._forEachBrowserWindow(win => {
      this._hookDetectionWindow(win);
      this._scheduleSeedForWindow(win);
    });
  },

  _disableDetectionNotifications() {
    this._detectionActive = false;
    this._detectedExtensionName = "";
    this._detectionPromptInProgress = false;

    this._removeStartupObserver();

    this._forEachBrowserWindow(win => {
      this._unhookDetectionWindow(win);
    });
  },

  _forEachBrowserWindow(callback) {
    const windows = Services.wm.getEnumerator("navigator:browser");
    while (windows.hasMoreElements()) {
      const win = windows.getNext();
      try {
        callback(win);
      } catch (_) {
        // Keep iterating other browser windows if one callback throws.
      }
    }
  },

  _addStartupObserver() {
    if (this._startupObserverRegistered) {
      return;
    }

    Services.obs.addObserver(this, CHROME_DOCUMENT_LOADED_TOPIC);
    this._startupObserverRegistered = true;
  },

  _removeStartupObserver() {
    if (!this._startupObserverRegistered) {
      return;
    }

    try {
      Services.obs.removeObserver(this, CHROME_DOCUMENT_LOADED_TOPIC);
    } catch (err) {
      console.warn(
        "[WaterfoxBlockerExtensionDetector] Failed to remove startup observer:",
        err
      );
    }

    this._startupObserverRegistered = false;
  },

  _windowFromChromeDocument(subject) {
    if (!subject?.URL?.includes("browser.xhtml")) {
      return null;
    }

    const win = subject.defaultView;
    if (!win?.gBrowser) {
      return null;
    }

    return win;
  },

  _isPostUpdatePage(uri) {
    try {
      if (!uri) {
        return false;
      }

      // Use the same pref BrowserContentHandler reads when deciding which page to open after update.
      let overrideUrl = "";
      try {
        overrideUrl = Services.urlFormatter.formatURLPref(
          "startup.homepage_override_url"
        );
      } catch (_) {
        // If URL formatting fails, fall back to the raw pref string and
        // continue with matching logic for the URL used by the update page.
        overrideUrl = Services.prefs.getStringPref(
          "startup.homepage_override_url",
          ""
        );
      }

      if (!overrideUrl || overrideUrl === "about:blank") {
        return false;
      }

      const overrideURI = Services.io.newURI(overrideUrl);

      if (uri.scheme !== overrideURI.scheme) {
        return false;
      }

      if (uri.schemeIs("http") || uri.schemeIs("https")) {
        if (
          String(uri.host || "").toLowerCase() !==
          String(overrideURI.host || "").toLowerCase()
        ) {
          return false;
        }
        if (uri.port !== overrideURI.port) {
          return false;
        }

        const uriPath = String(uri.filePath || "");
        const overridePath = String(overrideURI.filePath || "");
        return uriPath.startsWith(overridePath);
      }

      const uriPath = String(uri.pathQueryRef || uri.path || "");
      const overridePath = String(
        overrideURI.pathQueryRef || overrideURI.path || ""
      );
      return (
        uri.prePath === overrideURI.prePath && uriPath.startsWith(overridePath)
      );
    } catch (_) {
      // URI parsing/comparison can fail for non-standard schemes; treat those
      // cases as non-matching so detection does not trigger unexpectedly.
      return false;
    }
  },

  _hookDetectionWindow(win) {
    if (!win?.gBrowser || this._windowState.has(win)) {
      return;
    }

    const progressListener = {
      onLocationChange: (browser, webProgress, _request, location) => {
        if (!webProgress?.isTopLevel) {
          return;
        }
        this._maybeShowDetectionUpgradeForBrowser(win, browser, location).catch(
          error => {
            console.error(
              "[WaterfoxBlockerExtensionDetector] Failed to show upgrade modal",
              error
            );
          }
        );
      },
    };

    const onUnload = () => {
      this._unhookDetectionWindow(win);
    };

    try {
      win.gBrowser.addTabsProgressListener(progressListener);
      win.addEventListener("unload", onUnload, { once: true });
    } catch (_) {
      // Window may be closing before listener registration finishes.
      return;
    }

    this._windowState.set(win, {
      onUnload,
      progressListener,
      seedTimerId: null,
    });
  },

  _unhookDetectionWindow(win) {
    const state = this._windowState.get(win);
    if (!state || !win?.gBrowser) {
      return;
    }

    if (state.seedTimerId !== null) {
      try {
        lazy.clearTimeout(state.seedTimerId);
      } catch (_) {
        // Timer may already be cleared while window teardown is in progress.
      }
      state.seedTimerId = null;
    }

    try {
      win.gBrowser.removeTabsProgressListener(state.progressListener);
      win.removeEventListener("unload", state.onUnload);
    } catch (_) {
      // Listener teardown is best effort during shutdown and window close.
    }

    this._windowState.delete(win);
  },

  _scheduleSeedForWindow(win) {
    const state = this._windowState.get(win);
    if (!state) {
      return;
    }

    this._seedDetectionForWindow(win, "immediate");

    if (state.seedTimerId !== null) {
      try {
        lazy.clearTimeout(state.seedTimerId);
      } catch (_) {
        // Timer may already be cleared by a prior seed scheduling pass.
      }
      state.seedTimerId = null;
    }

    state.seedTimerId = lazy.setTimeout(() => {
      state.seedTimerId = null;

      if (
        !this._detectionActive ||
        Services.prefs.getBoolPref(PREF_DETECTION_DISMISSED, false) ||
        win?.closed ||
        !win?.gBrowser
      ) {
        return;
      }

      this._seedDetectionForWindow(win, "fallback");
    }, DETECTION_DELAY_MS);
  },

  _seedDetectionForWindow(win, source = "seed") {
    if (
      !this._detectionActive ||
      Services.prefs.getBoolPref(PREF_DETECTION_DISMISSED, false) ||
      win?.closed ||
      !win?.gBrowser
    ) {
      return;
    }

    const selectedBrowser = win.gBrowser.selectedBrowser || null;
    const browsers = win.gBrowser.browsers || [];

    const tryBrowser = browser => {
      this._maybeShowDetectionUpgradeForBrowser(
        win,
        browser,
        browser?.currentURI
      ).catch(error => {
        console.error(
          `[WaterfoxBlockerExtensionDetector] Failed to show ${source} upgrade modal`,
          error
        );
      });
    };

    if (selectedBrowser) {
      tryBrowser(selectedBrowser);
    }

    for (const browser of browsers) {
      if (browser === selectedBrowser) {
        continue;
      }
      tryBrowser(browser);
    }
  },

  async _prewarmUpgradeMessage() {
    if (this._cachedUpgradeBaseMessage) {
      return this._cachedUpgradeBaseMessage;
    }

    if (this._upgradeMessagePromise) {
      return this._upgradeMessagePromise;
    }

    this._upgradeMessagePromise =
      lazy.OnboardingMessageProvider.getUpgradeMessage()
        .then(message => {
          this._cachedUpgradeBaseMessage = message || null;
          return this._cachedUpgradeBaseMessage;
        })
        .catch(error => {
          console.error(
            "[WaterfoxBlockerExtensionDetector] Failed to prewarm upgrade message",
            error
          );
          return null;
        })
        .finally(() => {
          this._upgradeMessagePromise = null;
        });

    return this._upgradeMessagePromise;
  },

  async _showDetectionUpgradeModal(win, browser, extensionName) {
    if (
      !this._detectionActive ||
      Services.prefs.getBoolPref(PREF_DETECTION_DISMISSED, false)
    ) {
      return false;
    }

    if (!win?.gBrowser || !browser) {
      return false;
    }

    const baseMessage = await this._prewarmUpgradeMessage();
    if (!baseMessage?.content?.screens?.length) {
      return false;
    }

    const message = structuredClone(baseMessage);
    const idSuffix = Date.now();
    message.id = `WF_BLOCKER_UPGRADE_${idSuffix}`;
    message.content.id = message.id;
    message.content.modal = "tab";

    const matchingScreen =
      message.content.screens.find(
        screen => screen.id === "UPGRADE_SET_DEFAULT"
      ) || message.content.screens[0];
    if (!matchingScreen) {
      return false;
    }

    const screen = structuredClone(matchingScreen);
    message.content.screens = [screen];
    screen.id = `WF_BLOCKER_UPGRADE_SCREEN_${idSuffix}`;

    const [spotlightTitle, spotlightPrimaryLabel, spotlightSecondaryLabel] =
      await lazy.blockerLocalization.formatValues([
        "waterfox-blocker-spotlight-title",
        "waterfox-blocker-spotlight-primary-button",
        "waterfox-blocker-spotlight-secondary-button",
      ]);
    const detectedName =
      extensionName ||
      (await lazy.blockerLocalization.formatValue(
        L10N_ID_EXTENSION_FALLBACK_NAME_YOUR
      ));
    const spotlightSubtitle = await lazy.blockerLocalization.formatValue(
      "waterfox-blocker-spotlight-subtitle",
      { extensionName: detectedName }
    );

    screen.content.title = {
      raw: spotlightTitle,
    };
    screen.content.subtitle = {
      raw: spotlightSubtitle,
    };
    screen.content.primary_button = {
      label: {
        raw: spotlightPrimaryLabel,
      },
      action: {
        navigate: true,
      },
    };
    screen.content.secondary_button = {
      label: {
        raw: spotlightSecondaryLabel,
      },
      action: {
        type: "OPEN_PREFERENCES_PAGE",
        data: {
          category: "panePrivacy",
        },
        navigate: true,
      },
      has_arrow_icon: true,
    };

    try {
      return await lazy.Spotlight.showSpotlightDialog(browser, message);
    } catch (_) {
      // Expected in some lifecycle races (for example, tab/window teardown or
      // prompt host unavailability). Treat as "dialog not shown" and continue.
      return false;
    }
  },

  async _maybeShowDetectionUpgradeForBrowser(win, browser, uri = null) {
    if (
      !this._detectionActive ||
      this._detectionPromptInProgress ||
      Services.prefs.getBoolPref(PREF_DETECTION_DISMISSED, false)
    ) {
      return;
    }

    const candidateURI = uri || browser?.currentURI;
    if (!browser || !this._isPostUpdatePage(candidateURI)) {
      return;
    }

    this._detectionPromptInProgress = true;
    try {
      const shown = await this._showDetectionUpgradeModal(
        win,
        browser,
        this._detectedExtensionName
      );
      if (shown) {
        this._setDetectionDismissed();
      }
    } finally {
      this._detectionPromptInProgress = false;
    }
  },

  _setDetectionDismissed() {
    Services.prefs.setBoolPref(PREF_DETECTION_DISMISSED, true);
    this._disableDetectionNotifications();
  },

  /**
   * AddonManager requires an immediate decision to allow or cancel here, so
   * this path uses preloaded strings and a synchronous prompt routine.
   *
   * @param {object} install
   * @returns {boolean} `false` to cancel the install, `true` to allow it.
   */
  _onInstallStarted(install) {
    if (
      !Services.prefs.getBoolPref(PREF_BLOCKER_ENABLED, false) ||
      this._isCoexistEnabled()
    ) {
      return true;
    }

    const addon = install?.addon;
    if (!isAdblockAddon(addon)) {
      return true;
    }

    // Don't prompt for a background update of an already installed addon.
    if (install?.existingAddon) {
      return true;
    }

    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (!win?.gBrowser?.selectedBrowser?.browsingContext) {
      return true;
    }

    this._preloadLocalizedStrings().catch(error => {
      console.error(
        "[WaterfoxBlockerExtensionDetector] Failed to refresh install warning strings",
        error
      );
    });

    return this._showInstallWarning(win, addon) !== false;
  },

  _onInstallEnded(install) {
    // Check enabled state so a background update of an already disabled
    // ad blocker extension does not force the built-in blocker off.
    const addon = install?.addon;
    if (!isEnabledAdblockAddon(addon)) {
      return;
    }

    if (this._isCoexistEnabled()) {
      return;
    }

    if (Services.prefs.getBoolPref(PREF_BLOCKER_ENABLED, false)) {
      this._setBuiltInBlockerEnabled(false);
    }
  },

  async _disableAdblockExtensions(addons) {
    let failed = false;

    for (const addon of addons) {
      try {
        await addon.disable();
      } catch (error) {
        failed = true;
        console.error(
          `[WaterfoxBlockerExtensionDetector] Failed to disable ${addon?.id || "<unknown>"}`,
          error
        );
      }
    }

    return !failed;
  },

  async _handleBuiltInBlockerReenabled() {
    if (this._isCoexistEnabled()) {
      return;
    }

    const conflictingAddons = await this._getEnabledAdblockAddons();
    if (!conflictingAddons.length) {
      return;
    }

    const win = Services.wm.getMostRecentWindow("navigator:browser");
    if (!win?.gBrowser?.selectedBrowser?.browsingContext) {
      this._setBuiltInBlockerEnabled(false);
      return;
    }

    const conflictingName = addonDisplayName(conflictingAddons[0]);
    const [promptTitle, messageText, useBuiltInLabel, keepExtensionLabel] =
      await lazy.blockerLocalization.formatValues([
        "waterfox-blocker-prompt-title",
        {
          id: "waterfox-blocker-reenable-conflict-message",
          args: { extensionName: conflictingName },
        },
        "waterfox-blocker-reenable-use-built-in",
        "waterfox-blocker-reenable-keep-extension",
      ]);

    const promptService = Services.prompt;
    const flags =
      promptService.BUTTON_TITLE_IS_STRING * promptService.BUTTON_POS_0 +
      promptService.BUTTON_TITLE_IS_STRING * promptService.BUTTON_POS_1;

    const result = promptService.confirmExBC(
      win.gBrowser.selectedBrowser.browsingContext,
      promptService.MODAL_TYPE_TAB,
      promptTitle,
      messageText,
      flags,
      useBuiltInLabel,
      keepExtensionLabel,
      null,
      null,
      {}
    );

    // Button 1 = keep extension blocker, so disable built-in blocker again.
    if (result === 1) {
      this._setBuiltInBlockerEnabled(false);
      return;
    }

    // Button 0 = keep built-in blocker, disable conflicting extension blockers.
    const allDisabled = await this._disableAdblockExtensions(conflictingAddons);
    if (!allDisabled) {
      // If disabling conflicting add-ons failed, keep built-in blocker disabled.
      this._setBuiltInBlockerEnabled(false);
    } else {
      // User chose built-in blocking, so make the management UI visible.
      Services.prefs.setBoolPref(PREF_BLOCKER_UI_ENABLED, true);
    }
  },

  _setBuiltInBlockerEnabled(enabled) {
    this._prefObserverSuppressed = true;
    try {
      Services.prefs.setBoolPref(PREF_BLOCKER_ENABLED, !!enabled);
    } finally {
      this._prefObserverSuppressed = false;
    }
  },

  _getDismissedInstallWarningIds() {
    return parseDismissedInstallWarnings(
      Services.prefs.getStringPref(PREF_DISMISSED_INSTALL_WARNINGS, "[]")
    );
  },

  _setDismissedInstallWarningIds(ids) {
    const uniqueIds = [...new Set(ids.filter(Boolean))];
    Services.prefs.setStringPref(
      PREF_DISMISSED_INSTALL_WARNINGS,
      JSON.stringify(uniqueIds)
    );
  },

  /**
   * Runs in a synchronous install path, so it reads preloaded strings from
   * the localisation cache.
   *
   * @param {Window} win
   * @param {object} addon
   * @param {string} [addon.id]
   * @param {string} [addon.name]
   * @returns {boolean} `false` when install should be cancelled, otherwise `true`.
   */
  _showInstallWarning(win, addon) {
    try {
      if (!addon?.id) {
        return true;
      }

      const dismissed = this._getDismissedInstallWarningIds();
      if (dismissed.includes(addon.id)) {
        return true;
      }

      const extensionName =
        addonDisplayName(addon) ||
        this._getCachedString(L10N_ID_EXTENSION_FALLBACK_NAME_THIS);
      const warningTemplate = this._getCachedString(
        "waterfox-blocker-extension-install-warning-template",
        L10N_ID_INSTALL_WARNING
      );
      const warningText = String(warningTemplate).replaceAll(
        EXTENSION_NAME_PLACEHOLDER,
        extensionName
      );
      const messageText =
        `${warningText}\n\n` +
        this._getCachedString(L10N_ID_INSTALL_WARNING_MANAGE_SETTINGS);

      const promptTitle = this._getCachedString(L10N_ID_PROMPT_TITLE);
      const installAnywayLabel = this._getCachedString(L10N_ID_INSTALL_ANYWAY);
      const keepBuiltInLabel = this._getCachedString(L10N_ID_KEEP_BUILT_IN);

      const promptService = Services.prompt;
      const flags =
        promptService.BUTTON_TITLE_IS_STRING * promptService.BUTTON_POS_0 +
        promptService.BUTTON_TITLE_IS_STRING * promptService.BUTTON_POS_1;

      const result = promptService.confirmExBC(
        win.gBrowser.selectedBrowser.browsingContext,
        promptService.MODAL_TYPE_TAB,
        promptTitle,
        messageText,
        flags,
        installAnywayLabel,
        keepBuiltInLabel,
        null,
        null,
        {}
      );

      // Button 1 = "Keep using built-in blocker" = cancel install.
      if (result === 1) {
        return false;
      }

      // Button 0 = "Install anyway": store dismissal for this extension ID.
      const updatedDismissed = this._getDismissedInstallWarningIds();
      if (!updatedDismissed.includes(addon.id)) {
        updatedDismissed.push(addon.id);
        this._setDismissedInstallWarningIds(updatedDismissed);
      }

      return true;
    } catch (error) {
      console.error(
        "[WaterfoxBlockerExtensionDetector] Failed to show install warning prompt",
        error
      );
      return true;
    }
  },
};
