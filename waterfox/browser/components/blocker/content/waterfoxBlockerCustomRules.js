/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PREF_CUSTOM_RULES = "waterfox.blocker.customRules";

function normalizeCustomRulesText(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .slice(0, 10000)
    .join("\n")
    .trim();
}

var gWaterfoxBlockerCustomRulesManager = {
  _customRulesPrefLocked: false,

  onLoad() {
    this._customRulesField = document.getElementById(
      "waterfoxBlockerCustomRules"
    );
    this._customRulesPrefLocked =
      Services.prefs.prefIsLocked(PREF_CUSTOM_RULES);

    const acceptButton = document
      .getElementById("waterfoxBlockerCustomRulesDialog")
      .getButton("accept");
    acceptButton.disabled = this._customRulesPrefLocked;

    this._syncCustomRulesFieldFromPref();
    this._customRulesField.disabled = this._customRulesPrefLocked;

    Services.prefs.addObserver(PREF_CUSTOM_RULES, this);
  },

  observe(subject, topic, data) {
    if (topic !== "nsPref:changed" || data !== PREF_CUSTOM_RULES) {
      return;
    }

    this._syncCustomRulesFieldFromPref();
  },

  _syncCustomRulesFieldFromPref() {
    if (!this._customRulesField) {
      return;
    }

    const nextValue = normalizeCustomRulesText(
      Services.prefs.getStringPref(PREF_CUSTOM_RULES, "")
    );
    if (this._customRulesField.value !== nextValue) {
      this._customRulesField.value = nextValue;
    }
  },

  onDialogAccept() {
    if (!this._customRulesPrefLocked) {
      Services.prefs.setStringPref(
        PREF_CUSTOM_RULES,
        normalizeCustomRulesText(this._customRulesField.value)
      );
    }

    return true;
  },

  onDialogCancel() {
    return true;
  },

  onUnload() {
    try {
      Services.prefs.removeObserver(PREF_CUSTOM_RULES, this);
    } catch (_) {}
  },
};

document.addEventListener("DOMContentLoaded", () => {
  gWaterfoxBlockerCustomRulesManager.onLoad();
});

document.addEventListener("dialogaccept", event => {
  if (!gWaterfoxBlockerCustomRulesManager.onDialogAccept()) {
    event.preventDefault();
  }
});

document.addEventListener("dialogcancel", event => {
  if (!gWaterfoxBlockerCustomRulesManager.onDialogCancel()) {
    event.preventDefault();
  }
});

window.addEventListener("unload", () => {
  gWaterfoxBlockerCustomRulesManager.onUnload();
});
