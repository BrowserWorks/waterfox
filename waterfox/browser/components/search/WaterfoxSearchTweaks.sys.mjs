/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PREF_DISABLE_AI = "waterfox.search.disableAIFeatures";

// Per-engine AI opt-out params, applied when PREF_DISABLE_AI is true and
// omitted (empty pref) otherwise. Only engines with a known stable opt-out
// param are listed: DuckDuckGo opts out via its no-AI endpoint instead (see
// applyWaterfoxSearchTweaks), Ecosia and Mojeek have no AI answers to opt
// out of, and WPS is our own endpoint.

const AI_PARAM_PREFS = Object.freeze({
  "browser.search.param.waterfox_ai_google": "14",
  "browser.search.param.waterfox_ai_bing": "0",
  "browser.search.param.waterfox_ai_qwant": "0",
});

function applyDisableAI(disabled) {
  const defaults = Services.prefs.getDefaultBranch("");
  for (const [pref, disableValue] of Object.entries(AI_PARAM_PREFS)) {
    defaults.setCharPref(pref, disabled ? disableValue : "");
  }
}

function currentDisableAI() {
  return Services.prefs.getBoolPref(PREF_DISABLE_AI, true);
}

export const WaterfoxSearchTweaks = {
  _initialized: false,
  _observer: null,

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;
    applyDisableAI(currentDisableAI());
    this._observer = () => applyDisableAI(currentDisableAI());
    Services.prefs.addObserver(PREF_DISABLE_AI, this._observer);
  },

  uninit() {
    if (!this._initialized) {
      return;
    }
    this._initialized = false;
    if (this._observer) {
      Services.prefs.removeObserver(PREF_DISABLE_AI, this._observer);
      this._observer = null;
    }
  },
};
