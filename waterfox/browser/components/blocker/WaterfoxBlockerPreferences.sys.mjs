/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  addonDisplayName,
  isEnabledAdblockAddon,
} from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

export const WATERFOX_BLOCKER_PREF_TOPICS = [
  "privacy-pane-loaded",
  "waterfox-pane-loaded",
];

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
});

const PREF_ENABLED = "waterfox.blocker.enabled";
const PREF_UI_ENABLED = "waterfox.blocker.ui.enabled";
const PREF_ALLOW_SEARCH_PARTNER_ADS = "waterfox.blocker.allowSearchPartnerAds";
const PREF_SHOW_BADGE = "waterfox.blocker.showBadge";
const PREF_CNAME_UNCLOAKING = "waterfox.blocker.cnameUncloaking";
const PREF_FILTER_LIST_URLS = "waterfox.blocker.filterListUrls";
const PREF_CUSTOM_RULES = "waterfox.blocker.customRules";
const PREF_SITE_EXCEPTIONS = "waterfox.blocker.siteExceptions";

const BOUND_ATTR = "data-waterfox-blocker-bound";
const PREF_LISTENERS_ATTR = "data-waterfox-blocker-pref-listeners";

const BLOCKER_MODE_ON = "on";
const BLOCKER_MODE_OFF = "off";
const SEARCH_PARTNER_MODE_ALLOW = "partner-exception";
const SEARCH_PARTNER_MODE_BLOCK = "block-everything";
const GROUP_STYLESHEET_URL =
  "chrome://browser/content/blocker/waterfoxBlockerPreferences.css";
const GROUP_STYLESHEET_ID = "waterfoxBlockerPreferencesStyle";

function ensurePreferenceRegistered(Preferences, prefInfo) {
  if (!Preferences) {
    return false;
  }

  try {
    if (Preferences.get(prefInfo.id)) {
      return true;
    }
  } catch (_) {}

  try {
    Preferences.add(prefInfo);
    return true;
  } catch (_) {}

  return false;
}

function readBooleanPreference(id, fallback) {
  try {
    return Services.prefs.getBoolPref(id, fallback);
  } catch (_) {
    return !!fallback;
  }
}

function writeBooleanPreference(Preferences, id, value) {
  const boolValue = !!value;

  try {
    const preference = Preferences?.get?.(id);
    if (preference) {
      preference.value = boolValue;
      return;
    }
  } catch (_) {}

  try {
    Services.prefs.setBoolPref(id, boolValue);
  } catch (_) {}
}

/**
 * Coordinates blocker controls in the privacy pane within preferences.
 *
 * The blocker groupbox is statically included in privacy.inc.xhtml (like the
 * tracking protection and cookie banner sections). This module finds the
 * existing elements by ID and wires up event handlers and preference syncing,
 * following the same pattern as AboutPreferences for the new-tab home pane.
 */
export const WaterfoxBlockerPreferences = {
  _initialized: false,

  /**
   * Builds or refreshes blocker controls for one preferences window.
   *
   * @param {Window} win Preferences window instance.
   */
  _buildForWindow(win) {
    if (!win?.document) {
      return;
    }

    const { document } = win;
    const { Preferences } = win;

    const group = document.getElementById("waterfoxBlockerGroup");
    if (!group) {
      return;
    }

    const uiEnabled = readBooleanPreference(PREF_UI_ENABLED, false);
    if (!uiEnabled) {
      // Remove data-category so the framework won't unhide the group
      // when the privacy pane is shown.
      group.removeAttribute("data-category");
      group.hidden = true;
      return;
    }

    // Restore data-category in case it was previously stripped.
    if (!group.hasAttribute("data-category")) {
      group.setAttribute("data-category", "panePrivacy");
    }

    win.MozXULElement?.insertFTLIfNeeded?.("browser/waterfox.ftl");

    this._registerPreferences(Preferences);
    this._ensureGroupStylesheet(document);

    const controls = this._collectControls(document, group);

    if (this._controlsAreComplete(controls)) {
      this._wireInteractions(win, Preferences, controls);
    }

    try {
      Preferences?.queueUpdateOfAllElements?.();
    } catch (_) {}
  },

  _collectControls(document, group) {
    return {
      customFilterListsButton: document.getElementById(
        "waterfoxBlockerCustomFilterLists"
      ),
      filterListsButton: document.getElementById("waterfoxBlockerFilterLists"),
      customRulesButton: document.getElementById("waterfoxBlockerCustomRules"),
      exceptionsButton: document.getElementById("waterfoxBlockerExceptions"),
      group,
      modeRadioGroup: document.getElementById("waterfoxBlockerModeRadioGroup"),
      offOptionBox: document.getElementById("waterfoxBlockerOptionOff"),
      offRadio: document.getElementById("waterfoxBlockerOffRadio"),
      onExpandButton: document.getElementById("waterfoxBlockerOnExpand"),
      onDetails: document.getElementById("waterfoxBlockerOnDetails"),
      onOptionBox: document.getElementById("waterfoxBlockerOptionOn"),
      onRadio: document.getElementById("waterfoxBlockerOnRadio"),
      thirdPartyNotice: document.getElementById(
        "waterfoxBlockerThirdPartyNotice"
      ),
      thirdPartyNoticeDescription: document.getElementById(
        "waterfoxBlockerThirdPartyNoticeDescription"
      ),
      searchPartnerMode: document.getElementById(
        "waterfoxBlockerSearchPartnerMode"
      ),
      cnameUncloakingCheckbox: document.getElementById(
        "waterfoxBlockerCnameUncloaking"
      ),
      showBadgeCheckbox: document.getElementById("waterfoxBlockerShowBadge"),
    };
  },

  _controlsAreComplete(controls) {
    return !!(
      controls?.group &&
      controls.modeRadioGroup &&
      controls.onRadio &&
      controls.offRadio &&
      controls.onExpandButton &&
      controls.onDetails &&
      controls.onOptionBox &&
      controls.offOptionBox &&
      controls.searchPartnerMode &&
      controls.cnameUncloakingCheckbox &&
      controls.showBadgeCheckbox &&
      controls.customFilterListsButton &&
      controls.filterListsButton &&
      controls.customRulesButton &&
      controls.exceptionsButton &&
      controls.thirdPartyNotice &&
      controls.thirdPartyNoticeDescription
    );
  },

  _ensureGroupStylesheet(document) {
    if (!document || document.getElementById(GROUP_STYLESHEET_ID)) {
      return;
    }

    const head = document.head || document.querySelector("head");
    if (!head) {
      return;
    }

    const link = document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "link"
    );
    link.setAttribute("id", GROUP_STYLESHEET_ID);
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", GROUP_STYLESHEET_URL);
    head.appendChild(link);
  },

  _openExceptionsDialog(win) {
    const url =
      "chrome://browser/content/preferences/dialogs/waterfoxBlockerExceptions.xhtml";
    const dialogName = "WaterfoxBlockerExceptionsDialog";
    const dialogFeatures = "resizable,chrome,modal,titlebar,centerscreen";
    const params = {
      origin: "waterfox-blocker-exceptions",
      prefName: PREF_SITE_EXCEPTIONS,
    };

    try {
      if (typeof win?.gSubDialog?.open === "function") {
        win.gSubDialog.open(url, undefined, params);
        return;
      }
    } catch (_) {}

    const candidateHosts = [
      win,
      Services.wm.getMostRecentWindow("navigator:browser"),
      Services.appShell?.hiddenDOMWindow,
    ];

    for (const host of candidateHosts) {
      try {
        if (typeof host?.openDialog === "function") {
          host.openDialog(url, dialogName, dialogFeatures, params);
          return;
        }
      } catch (_) {}
    }
  },

  _openFilterListsDialog(win) {
    const url =
      "chrome://browser/content/preferences/dialogs/waterfoxBlockerFilterLists.xhtml";

    try {
      if (typeof win?.gSubDialog?.open === "function") {
        win.gSubDialog.open(url, "resizable=yes");
        return;
      }
    } catch (_) {}

    const browserWin =
      Services.wm.getMostRecentWindow("navigator:browser") || win;
    try {
      browserWin.openDialog(
        url,
        "WaterfoxBlockerFilterListsDialog",
        "chrome,centerscreen,titlebar,resizable"
      );
    } catch (_) {}
  },

  _openCustomFilterListsDialog(win) {
    const url =
      "chrome://browser/content/preferences/dialogs/waterfoxBlockerCustomFilterLists.xhtml";
    const dialogName = "WaterfoxBlockerCustomFilterListsDialog";
    const dialogFeatures = "resizable,chrome,modal,titlebar,centerscreen";
    const params = {
      origin: "waterfox-blocker-custom-filter-lists",
    };

    try {
      if (typeof win?.gSubDialog?.open === "function") {
        win.gSubDialog.open(url, undefined, params);
        return;
      }
    } catch (_) {}

    const candidateHosts = [
      win,
      Services.wm.getMostRecentWindow("navigator:browser"),
      Services.appShell?.hiddenDOMWindow,
    ];

    for (const host of candidateHosts) {
      try {
        if (typeof host?.openDialog === "function") {
          host.openDialog(url, dialogName, dialogFeatures, params);
          return;
        }
      } catch (_) {}
    }
  },

  _openCustomRulesDialog(win) {
    const url =
      "chrome://browser/content/preferences/dialogs/waterfoxBlockerCustomRules.xhtml";
    const dialogName = "WaterfoxBlockerCustomRulesDialog";
    const dialogFeatures = "resizable,chrome,modal,titlebar,centerscreen";
    const params = {
      origin: "waterfox-blocker-custom-rules",
    };

    try {
      if (typeof win?.gSubDialog?.open === "function") {
        win.gSubDialog.open(url, undefined, params);
        return;
      }
    } catch (_) {}

    const candidateHosts = [
      win,
      Services.wm.getMostRecentWindow("navigator:browser"),
      Services.appShell?.hiddenDOMWindow,
    ];

    for (const host of candidateHosts) {
      try {
        if (typeof host?.openDialog === "function") {
          host.openDialog(url, dialogName, dialogFeatures, params);
          return;
        }
      } catch (_) {}
    }
  },

  _registerPreferences(Preferences) {
    const prefs = [
      { id: PREF_ENABLED, type: "bool" },
      { id: PREF_UI_ENABLED, type: "bool" },
      { id: PREF_ALLOW_SEARCH_PARTNER_ADS, type: "bool" },
      { id: PREF_SHOW_BADGE, type: "bool" },
      { id: PREF_CNAME_UNCLOAKING, type: "bool" },
      { id: PREF_FILTER_LIST_URLS, type: "string" },
      { id: PREF_CUSTOM_RULES, type: "string" },
    ];

    for (const prefInfo of prefs) {
      ensurePreferenceRegistered(Preferences, prefInfo);
    }
  },

  async _syncThirdPartyNotice(win, controls) {
    if (!win?.document || !controls?.thirdPartyNotice) {
      return;
    }

    const { thirdPartyNotice, thirdPartyNoticeDescription } = controls;
    const doc = win.document;

    if (readBooleanPreference(PREF_ENABLED, false)) {
      thirdPartyNotice.collapsed = true;
      return;
    }

    try {
      const addons = await lazy.AddonManager.getAddonsByTypes(["extension"]);
      const detectedAddon = addons.find(addon => isEnabledAdblockAddon(addon));

      if (!detectedAddon) {
        thirdPartyNotice.collapsed = true;
        return;
      }

      if (
        !thirdPartyNotice?.isConnected ||
        thirdPartyNotice.ownerDocument !== doc
      ) {
        return;
      }

      doc.l10n.setAttributes(
        thirdPartyNoticeDescription,
        "waterfox-blocker-third-party-notice-description",
        { extensionName: addonDisplayName(detectedAddon) || "this extension" }
      );
      thirdPartyNotice.collapsed = false;
    } catch (_) {
      if (
        thirdPartyNotice?.isConnected &&
        thirdPartyNotice.ownerDocument === doc
      ) {
        thirdPartyNotice.collapsed = true;
      }
    }
  },

  /**
   * Wires command handlers and preference listeners for injected controls.
   *
   * @param {Window} win Preferences window instance.
   * @param {object} Preferences Preferences helper exposed by the window.
   * @param {object} controls Bound control references from `_collectControls`.
   */
  _wireInteractions(win, Preferences, controls) {
    if (!this._controlsAreComplete(controls)) {
      return;
    }

    const {
      group,
      modeRadioGroup,
      onRadio,
      offRadio,
      onExpandButton,
      onOptionBox,
      offOptionBox,
      searchPartnerMode,
      cnameUncloakingCheckbox,
      showBadgeCheckbox,
      customFilterListsButton,
      filterListsButton,
      customRulesButton,
      exceptionsButton,
      onDetails,
    } = controls;

    const syncFromPrefs = () => {
      const enabled = readBooleanPreference(PREF_ENABLED, true);
      const allowSearchPartnerAds = readBooleanPreference(
        PREF_ALLOW_SEARCH_PARTNER_ADS,
        true
      );
      const showBadge = readBooleanPreference(PREF_SHOW_BADGE, true);
      const cnameUncloaking = readBooleanPreference(
        PREF_CNAME_UNCLOAKING,
        true
      );

      modeRadioGroup.value = enabled ? BLOCKER_MODE_ON : BLOCKER_MODE_OFF;

      if (enabled) {
        onRadio.setAttribute("selected", "true");
        offRadio.removeAttribute("selected");
      } else {
        offRadio.setAttribute("selected", "true");
        onRadio.removeAttribute("selected");
      }

      searchPartnerMode.value = allowSearchPartnerAds
        ? SEARCH_PARTNER_MODE_ALLOW
        : SEARCH_PARTNER_MODE_BLOCK;
      searchPartnerMode.disabled = !enabled;

      showBadgeCheckbox.checked = showBadge;
      showBadgeCheckbox.disabled = !enabled;
      cnameUncloakingCheckbox.checked = cnameUncloaking;
      cnameUncloakingCheckbox.disabled = !enabled;

      onOptionBox.classList.toggle("selected", enabled);
      offOptionBox.classList.toggle("selected", !enabled);

      const onExpanded =
        enabled || onOptionBox.getAttribute("data-expanded") === "true";
      onDetails.collapsed = !onExpanded;
      onExpandButton.classList.toggle("up", onExpanded);
      onExpandButton.setAttribute("aria-expanded", String(onExpanded));

      this._syncThirdPartyNotice(win, controls);
    };

    if (!modeRadioGroup.hasAttribute(BOUND_ATTR)) {
      modeRadioGroup.addEventListener("command", event => {
        const source = event.target;
        if (
          source !== modeRadioGroup &&
          source !== onRadio &&
          source !== offRadio
        ) {
          return;
        }

        let selectedValue = modeRadioGroup.value;
        if (source === onRadio || source === offRadio) {
          selectedValue = source.value;
        }

        if (
          selectedValue !== BLOCKER_MODE_ON &&
          selectedValue !== BLOCKER_MODE_OFF
        ) {
          return;
        }

        writeBooleanPreference(
          Preferences,
          PREF_ENABLED,
          selectedValue === BLOCKER_MODE_ON
        );
        syncFromPrefs();
      });
      modeRadioGroup.setAttribute(BOUND_ATTR, "true");
    }

    if (!onExpandButton.hasAttribute(BOUND_ATTR)) {
      onExpandButton.addEventListener("command", () => {
        const nextExpanded = onDetails.collapsed;
        onOptionBox.setAttribute("data-expanded", String(nextExpanded));
        onDetails.collapsed = !nextExpanded;
        onExpandButton.classList.toggle("up", nextExpanded);
        onExpandButton.setAttribute("aria-expanded", String(nextExpanded));
      });
      onExpandButton.setAttribute(BOUND_ATTR, "true");
    }

    if (!searchPartnerMode.hasAttribute(BOUND_ATTR)) {
      searchPartnerMode.addEventListener("command", () => {
        const selectedMode = searchPartnerMode.value;
        if (
          selectedMode !== SEARCH_PARTNER_MODE_ALLOW &&
          selectedMode !== SEARCH_PARTNER_MODE_BLOCK
        ) {
          return;
        }

        writeBooleanPreference(
          Preferences,
          PREF_ALLOW_SEARCH_PARTNER_ADS,
          selectedMode === SEARCH_PARTNER_MODE_ALLOW
        );
        syncFromPrefs();
      });
      searchPartnerMode.setAttribute(BOUND_ATTR, "true");
    }

    if (!showBadgeCheckbox.hasAttribute(BOUND_ATTR)) {
      showBadgeCheckbox.addEventListener("command", () => {
        writeBooleanPreference(
          Preferences,
          PREF_SHOW_BADGE,
          !!showBadgeCheckbox.checked
        );
        syncFromPrefs();
      });
      showBadgeCheckbox.setAttribute(BOUND_ATTR, "true");
    }

    if (!cnameUncloakingCheckbox.hasAttribute(BOUND_ATTR)) {
      cnameUncloakingCheckbox.addEventListener("command", () => {
        writeBooleanPreference(
          Preferences,
          PREF_CNAME_UNCLOAKING,
          !!cnameUncloakingCheckbox.checked
        );
        syncFromPrefs();
      });
      cnameUncloakingCheckbox.setAttribute(BOUND_ATTR, "true");
    }

    if (!exceptionsButton.hasAttribute(BOUND_ATTR)) {
      exceptionsButton.addEventListener("command", event => {
        event.preventDefault();
        event.stopPropagation();
        this._openExceptionsDialog(win);
      });
      exceptionsButton.setAttribute(BOUND_ATTR, "true");
    }

    if (!filterListsButton.hasAttribute(BOUND_ATTR)) {
      filterListsButton.addEventListener("command", event => {
        event.preventDefault();
        event.stopPropagation();
        this._openFilterListsDialog(win);
      });
      filterListsButton.setAttribute(BOUND_ATTR, "true");
    }

    if (!customFilterListsButton.hasAttribute(BOUND_ATTR)) {
      customFilterListsButton.addEventListener("command", event => {
        event.preventDefault();
        event.stopPropagation();
        this._openCustomFilterListsDialog(win);
      });
      customFilterListsButton.setAttribute(BOUND_ATTR, "true");
    }

    if (!customRulesButton.hasAttribute(BOUND_ATTR)) {
      customRulesButton.addEventListener("command", event => {
        event.preventDefault();
        event.stopPropagation();
        this._openCustomRulesDialog(win);
      });
      customRulesButton.setAttribute(BOUND_ATTR, "true");
    }

    if (!group.hasAttribute(PREF_LISTENERS_ATTR)) {
      try {
        Preferences?.get?.(PREF_ENABLED)?.on("change", syncFromPrefs);
      } catch (_) {}

      try {
        Preferences?.get?.(PREF_ALLOW_SEARCH_PARTNER_ADS)?.on(
          "change",
          syncFromPrefs
        );
      } catch (_) {}

      try {
        Preferences?.get?.(PREF_SHOW_BADGE)?.on("change", syncFromPrefs);
      } catch (_) {}

      try {
        Preferences?.get?.(PREF_CNAME_UNCLOAKING)?.on("change", syncFromPrefs);
      } catch (_) {}

      group.setAttribute(PREF_LISTENERS_ATTR, "true");
    }

    syncFromPrefs();
  },

  init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;
    for (const topic of WATERFOX_BLOCKER_PREF_TOPICS) {
      Services.obs.addObserver(this, topic);
    }
  },

  observe(subject, topic) {
    if (!WATERFOX_BLOCKER_PREF_TOPICS.includes(topic)) {
      return;
    }

    this._buildForWindow(subject);
  },

  uninit() {
    if (!this._initialized) {
      return;
    }

    this._initialized = false;
    for (const topic of WATERFOX_BLOCKER_PREF_TOPICS) {
      try {
        Services.obs.removeObserver(this, topic);
      } catch (_) {}
    }
  },
};
