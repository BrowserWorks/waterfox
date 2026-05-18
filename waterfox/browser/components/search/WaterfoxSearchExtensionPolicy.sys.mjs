/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const PREF_SEPARATE_PRIVATE_DEFAULT = "browser.search.separatePrivateDefault";

const FALLBACK_ENGINE_ID = "google";
const CHANGE_REASON = Ci.nsISearchService.CHANGE_REASON_CONFIG;
const POLICY_HIDDEN_ATTR = "waterfoxHiddenForAdClickExtensions";
const POLICY_SWITCHED_FROM_ATTR = "waterfoxAdClickExtensionSwitchedFrom";
const POLICY_REFRESH_DELAY_MS = 500;

const AD_CLICK_EXTENSION_IDS = Object.freeze([
  "adnauseam@rednoise.org",
  "ilkggpgmkemaniponkfgnkonpajankkm",
]);
const AD_CLICK_EXTENSION_NAMES = Object.freeze(["adnauseam"]);

function switchedFromAttr(privateMode) {
  return privateMode
    ? `${POLICY_SWITCHED_FROM_ATTR}Private`
    : POLICY_SWITCHED_FROM_ATTR;
}

export const WaterfoxSearchExtensionPolicy = {
  _addonListener: {
    onEnabled(addon) {
      WaterfoxSearchExtensionPolicy._onAddonStateChanged(addon, "enabled");
    },
    onDisabled(addon) {
      WaterfoxSearchExtensionPolicy._onAddonStateChanged(addon, "disabled");
    },
    onInstalled(addon) {
      WaterfoxSearchExtensionPolicy._onAddonStateChanged(addon, "installed");
    },
    onUninstalled(addon) {
      WaterfoxSearchExtensionPolicy._onAddonStateChanged(addon, "uninstalled");
    },
  },

  _disablePartnerAttribution: false,
  _initialized: false,
  _refreshTimer: null,
  _startupFallbacks: { normal: "", private: "" },

  get disablePartnerAttribution() {
    return this._disablePartnerAttribution;
  },

  noteDefaultFallback(engineId, privateMode = false) {
    this._startupFallbacks[privateMode ? "private" : "normal"] = engineId;
  },

  /** Safe to call more than once. */
  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    lazy.AddonManager.addAddonListener(this._addonListener);
    this._refreshPolicy().catch(error =>
      console.error(
        "[WaterfoxSearchExtensionPolicy] Startup policy refresh failed",
        error
      )
    );
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;

    this._cancelRefresh();

    try {
      lazy.AddonManager.removeAddonListener(this._addonListener);
    } catch (_) {
    }
  },

  _cancelRefresh() {
    if (this._refreshTimer) {
      lazy.clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  },

  _onAddonStateChanged(addon, eventName) {
    if (addon?.type && addon.type !== "extension") {
      return;
    }

    if (
      (eventName === "installed" || eventName === "enabled") &&
      this._isAdClickExtension(addon)
    ) {
      this._cancelRefresh();
      this._disablePartnerAttribution = true;
      this._applyActivePolicy().catch(error =>
        console.error(
          "[WaterfoxSearchExtensionPolicy] Failed to apply active search extension policy",
          error
        )
      );
      return;
    }

    this._cancelRefresh();
    this._refreshTimer = lazy.setTimeout(() => {
      this._refreshTimer = null;
      this._refreshPolicy().catch(error =>
        console.error(
          "[WaterfoxSearchExtensionPolicy] Failed to refresh search extension policy",
          error
        )
      );
    }, POLICY_REFRESH_DELAY_MS);
  },

  _isAdClickExtension(addon) {
    if (!addon) {
      return false;
    }
    const id = String(addon.id || "")
      .trim()
      .toLowerCase();
    if (AD_CLICK_EXTENSION_IDS.includes(id)) {
      return true;
    }
    const name = String(addon.name || "")
      .trim()
      .toLowerCase();
    return AD_CLICK_EXTENSION_NAMES.includes(name);
  },

  async updateActiveState() {
    const addons = await lazy.AddonManager.getAddonsByTypes(["extension"]);
    this._disablePartnerAttribution = addons.some(addon => {
      const pending = addon?.pendingOperations || 0;
      return (
        !!addon?.isActive &&
        !addon?.userDisabled &&
        !(pending & lazy.AddonManager.PENDING_DISABLE) &&
        !(pending & lazy.AddonManager.PENDING_UNINSTALL) &&
        this._isAdClickExtension(addon)
      );
    });
    return this._disablePartnerAttribution;
  },

  async _refreshPolicy() {
    if (await this.updateActiveState()) {
      await this._applyActivePolicy();
    } else {
      await this._clearActivePolicy();
    }
  },

  async _applyActivePolicy() {
    await this._maybeSwitchDefaultToFallback(false);
    if (Services.prefs.getBoolPref(PREF_SEPARATE_PRIVATE_DEFAULT, false)) {
      await this._maybeSwitchDefaultToFallback(true);
    }
    await this._setUnavailableEnginesHidden(true);
  },

  async _clearActivePolicy() {
    await this._setUnavailableEnginesHidden(false);
    await this._maybeRestoreDefaultFromFallback(false);
    if (Services.prefs.getBoolPref(PREF_SEPARATE_PRIVATE_DEFAULT, false)) {
      await this._maybeRestoreDefaultFromFallback(true);
    }
  },

  async _maybeSwitchDefaultToFallback(privateMode) {
    const currentEngine = await this._getDefaultEngine(privateMode);
    if (!currentEngine?.waterfoxUnavailableForAdClickExtensions) {
      return;
    }

    const fallbackEngine = await this._getFallbackEngine(currentEngine);
    if (!fallbackEngine) {
      console.warn(
        "[WaterfoxSearchExtensionPolicy] No neutral fallback search engine found"
      );
      return;
    }

    fallbackEngine.setAttr(switchedFromAttr(privateMode), currentEngine.id);
    await this._setDefaultEngine(privateMode, fallbackEngine);

    if (!privateMode) {
      lazy.BrowserUtils.callModulesFromCategory(
        { categoryName: "search-service-notification" },
        "search-engine-removal",
        currentEngine.name,
        fallbackEngine.name
      );
    }
  },

  async _maybeRestoreDefaultFromFallback(privateMode) {
    const currentEngine = await this._getDefaultEngine(privateMode);
    const attr = switchedFromAttr(privateMode);
    const switchedFromEngineId = currentEngine?.getAttr?.(attr);
    currentEngine?.clearAttr?.(attr);

    let previousEngine = switchedFromEngineId
      ? Services.search.getEngineById(switchedFromEngineId)
      : null;

    const key = privateMode ? "private" : "normal";
    if (
      !previousEngine &&
      currentEngine?.id === FALLBACK_ENGINE_ID &&
      this._startupFallbacks[key]
    ) {
      previousEngine = Services.search.getEngineById(
        this._startupFallbacks[key]
      );
    }
    this._startupFallbacks[key] = "";

    if (!previousEngine || previousEngine.hidden) {
      return;
    }
    await this._setDefaultEngine(privateMode, previousEngine);
  },

  _getDefaultEngine(privateMode) {
    return privateMode
      ? Services.search.getDefaultPrivate()
      : Services.search.getDefault();
  },

  _setDefaultEngine(privateMode, engine) {
    return privateMode
      ? Services.search.setDefaultPrivate(engine, CHANGE_REASON)
      : Services.search.setDefault(engine, CHANGE_REASON);
  },

  async _getFallbackEngine(currentEngine) {
    const engines = await Services.search.getVisibleEngines();
    const isAcceptable = engine =>
      engine.id !== currentEngine?.id &&
      !engine.waterfoxHasPartnerAttribution &&
      !engine.waterfoxUnavailableForAdClickExtensions;

    return (
      engines.find(e => e.id === FALLBACK_ENGINE_ID && isAcceptable(e)) ||
      engines.find(isAcceptable) ||
      null
    );
  },

  async _setUnavailableEnginesHidden(hidden) {
    const engines = await Services.search.getAppProvidedEngines();
    for (const engine of engines) {
      if (hidden) {
        if (engine.waterfoxUnavailableForAdClickExtensions && !engine.hidden) {
          engine.setAttr(POLICY_HIDDEN_ATTR, true);
          engine.hidden = true;
        }
      } else if (engine.getAttr?.(POLICY_HIDDEN_ATTR)) {
        engine.hidden = false;
        engine.clearAttr(POLICY_HIDDEN_ATTR);
      }
    }
  },
};
