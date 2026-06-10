/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const PREF_SEPARATE_PRIVATE_DEFAULT = "browser.search.separatePrivateDefault";

const FALLBACK_ENGINE_ID = "google";
const POLICY_HIDDEN_ATTR = "waterfoxHiddenForAdClickExtensions";
const POLICY_SWITCHED_FROM_ATTR = "waterfoxAdClickExtensionSwitchedFrom";
const POLICY_REFRESH_DELAY_MS = 500;

const AD_CLICK_EXTENSION_IDS = Object.freeze([
  "adnauseam@rednoise.org",
  "ilkggpgmkemaniponkfgnkonpajankkm",
]);
const AD_CLICK_EXTENSION_NAMES = Object.freeze(["adnauseam"]);

// Engines that must not be offered while an ad clicking extension is active.
const UNAVAILABLE_ENGINE_IDS = Object.freeze(["1org"]);

// Default branch prefs holding the partner attribution codes that the search
// configuration reads, keyed by engine id.
const ATTRIBUTION_PREFS = Object.freeze({
  "1org": "browser.search.param.waterfox_attribution_1org",
  ddg: "browser.search.param.waterfox_attribution_ddg",
  ecosia: "browser.search.param.waterfox_attribution_ecosia",
  qwant: "browser.search.param.waterfox_attribution_qwant",
});

function switchedFromAttr(privateMode) {
  return privateMode
    ? `${POLICY_SWITCHED_FROM_ATTR}Private`
    : POLICY_SWITCHED_FROM_ATTR;
}

/**
 * While an ad-clicking extension such as AdNauseam is installed, hide search
 * engines that fund charity through partners so the partner does not see
 * fabricated clicks, and drop partner attribution codes from search URLs by
 * blanking the default-branch prefs they are read from.
 */
export const WaterfoxSearchExtensionPolicy = {
  _addonListener: {
    onEnabled(addon) {
      WaterfoxSearchExtensionPolicy._onAddonStateChanged(addon);
    },
    onDisabled(addon) {
      WaterfoxSearchExtensionPolicy._onAddonStateChanged(addon);
    },
    onInstalled(addon) {
      WaterfoxSearchExtensionPolicy._onAddonStateChanged(addon, "installed");
    },
    onUninstalled(addon) {
      WaterfoxSearchExtensionPolicy._onAddonStateChanged(addon);
    },
  },

  _active: false,
  _initialized: false,
  _refreshTimer: null,
  _savedAttributionValues: new Map(),

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    lazy.AddonManager.addAddonListener(this._addonListener);
    this._refreshPolicy(true).catch(error =>
      console.error(
        "WaterfoxSearchExtensionPolicy startup refresh failed",
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
    lazy.AddonManager.removeAddonListener(this._addonListener);
  },

  _cancelRefresh() {
    if (this._refreshTimer) {
      lazy.clearTimeout(this._refreshTimer);
      this._refreshTimer = null;
    }
  },

  _onAddonStateChanged(addon, eventName) {
    if (addon?.type && addon.type != "extension") {
      return;
    }

    if (eventName == "installed" && this._isAdClickExtension(addon)) {
      // Apply immediately so the first searches after the install do not
      // carry attribution.
      this._cancelRefresh();
      this._active = true;
      this._applyActivePolicy(false).catch(error =>
        console.error(
          "WaterfoxSearchExtensionPolicy failed to apply policy",
          error
        )
      );
      return;
    }

    this._cancelRefresh();
    this._refreshTimer = lazy.setTimeout(() => {
      this._refreshTimer = null;
      this._refreshPolicy(false).catch(error =>
        console.error(
          "WaterfoxSearchExtensionPolicy failed to refresh policy",
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
    this._active = addons.some(addon => {
      const pending = addon?.pendingOperations || 0;
      return (
        !!addon?.isActive &&
        !addon?.userDisabled &&
        !(pending & lazy.AddonManager.PENDING_DISABLE) &&
        !(pending & lazy.AddonManager.PENDING_UNINSTALL) &&
        this._isAdClickExtension(addon)
      );
    });
    return this._active;
  },

  async _refreshPolicy(isStartup) {
    if (await this.updateActiveState()) {
      await this._applyActivePolicy(isStartup);
    } else {
      await this._clearActivePolicy();
    }
  },

  async _applyActivePolicy(isStartup) {
    this._setPartnerAttributionDisabled(true);
    await this._maybeSwitchDefaultToFallback(false, isStartup);
    if (Services.prefs.getBoolPref(PREF_SEPARATE_PRIVATE_DEFAULT, false)) {
      await this._maybeSwitchDefaultToFallback(true, isStartup);
    }
    await this._setUnavailableEnginesHidden(true);
  },

  async _clearActivePolicy() {
    this._setPartnerAttributionDisabled(false);
    await this._setUnavailableEnginesHidden(false);
    await this._maybeRestoreDefaultFromFallback(false);
    if (Services.prefs.getBoolPref(PREF_SEPARATE_PRIVATE_DEFAULT, false)) {
      await this._maybeRestoreDefaultFromFallback(true);
    }
  },

  _setPartnerAttributionDisabled(disabled) {
    const defaults = Services.prefs.getDefaultBranch("");
    for (const pref of Object.values(ATTRIBUTION_PREFS)) {
      if (disabled) {
        if (!this._savedAttributionValues.has(pref)) {
          this._savedAttributionValues.set(
            pref,
            defaults.getCharPref(pref, "")
          );
        }
        defaults.setCharPref(pref, "");
      } else if (this._savedAttributionValues.has(pref)) {
        defaults.setCharPref(pref, this._savedAttributionValues.get(pref));
        this._savedAttributionValues.delete(pref);
      }
    }
  },

  async _maybeSwitchDefaultToFallback(privateMode, isStartup) {
    const currentEngine = await this._getDefaultEngine(privateMode);
    if (!currentEngine || !UNAVAILABLE_ENGINE_IDS.includes(currentEngine.id)) {
      return;
    }

    const fallbackEngine = await this._getFallbackEngine(currentEngine);
    if (!fallbackEngine) {
      console.warn(
        "WaterfoxSearchExtensionPolicy found no neutral fallback engine"
      );
      return;
    }

    fallbackEngine.setAttr(switchedFromAttr(privateMode), currentEngine.id);
    await this._setDefaultEngine(privateMode, fallbackEngine);

    if (!privateMode && !isStartup) {
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
    const switchedFromEngineId = currentEngine?.getAttr(attr);
    if (!switchedFromEngineId) {
      return;
    }
    currentEngine.clearAttr(attr);

    const previousEngine =
      lazy.SearchService.getEngineById(switchedFromEngineId);
    if (!previousEngine || previousEngine.hidden) {
      return;
    }
    await this._setDefaultEngine(privateMode, previousEngine);
  },

  _getDefaultEngine(privateMode) {
    return privateMode
      ? lazy.SearchService.getDefaultPrivate()
      : lazy.SearchService.getDefault();
  },

  _setDefaultEngine(privateMode, engine) {
    const reason = lazy.SearchService.CHANGE_REASON.CONFIG;
    return privateMode
      ? lazy.SearchService.setDefaultPrivate(engine, reason)
      : lazy.SearchService.setDefault(engine, reason);
  },

  async _getFallbackEngine(currentEngine) {
    const engines = await lazy.SearchService.getVisibleEngines();
    const isAcceptable = engine =>
      engine.id != currentEngine.id &&
      !Object.hasOwn(ATTRIBUTION_PREFS, engine.id) &&
      !UNAVAILABLE_ENGINE_IDS.includes(engine.id);

    return (
      engines.find(e => e.id == FALLBACK_ENGINE_ID && isAcceptable(e)) ||
      engines.find(isAcceptable) ||
      null
    );
  },

  async _setUnavailableEnginesHidden(hidden) {
    const engines = await lazy.SearchService.getAppProvidedEngines();
    for (const engine of engines) {
      if (hidden) {
        if (UNAVAILABLE_ENGINE_IDS.includes(engine.id) && !engine.hidden) {
          engine.setAttr(POLICY_HIDDEN_ATTR, true);
          engine.hidden = true;
        }
      } else if (engine.getAttr(POLICY_HIDDEN_ATTR)) {
        engine.hidden = false;
        engine.clearAttr(POLICY_HIDDEN_ATTR);
      }
    }
  },
};
