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
const PREF_FILTER_LIST_URLS = "waterfox.blocker.filterListUrls";

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
  } catch (_) {
    // Some preference panes lazily create the Preferences helper.
  }

  try {
    Preferences.add(prefInfo);
    return true;
  } catch (_) {
    // Missing helper support means the control will fall back to Services.prefs.
  }

  return false;
}

function readBooleanPreference(id, fallback) {
  try {
    return Services.prefs.getBoolPref(id, fallback);
  } catch (_) {
    // Use the supplied fallback if pref access fails.
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
  } catch (_) {
    // Fall back to Services.prefs below.
  }

  try {
    Services.prefs.setBoolPref(id, boolValue);
  } catch (err) {
    console.warn(`[WaterfoxBlockerPreferences] Failed to set ${id}:`, err);
  }
}

/**
 * Coordinates blocker controls in the privacy pane.
 *
 * The blocker groupbox is statically included in privacy.inc.xhtml (like the
 * tracking protection and cookie banner sections), so this finds the existing
 * elements by ID and wires up handlers, following AboutPreferences' pattern
 * for the new-tab home pane.
 */
export const WaterfoxBlockerPreferences = {
  _initialized: false,

  /**
   * @param {Window} win
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
      // The preferences framework unhides groups with data-category on pane show.
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
    } catch (_) {
      // Some preferences windows do not expose the queued update helper.
    }
  },

  _collectControls(document, group) {
    return {
      customFilterListsButton: document.getElementById(
        "waterfoxBlockerCustomFilterLists"
      ),
      customFiltersButton: document.getElementById(
        "waterfoxBlockerCustomFilters"
      ),
      exceptionsButton: document.getElementById("waterfoxBlockerExceptions"),
      filterListsButton: document.getElementById("waterfoxBlockerFilterLists"),
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
      controls.showBadgeCheckbox &&
      controls.exceptionsButton &&
      controls.filterListsButton &&
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
      "chrome://browser/content/preferences/dialogs/permissions.xhtml";
    const params = {
      permissionType: "waterfox-blocker",
      disableETPVisible: true,
      prefilledHost: "",
      hideStatusColumn: true,
    };

    try {
      if (typeof win?.gSubDialog?.open === "function") {
        win.gSubDialog.open(url, undefined, params);
        return;
      }
    } catch (_) {
      // Fall back to openDialog hosts below.
    }

    const dialogFeatures = "resizable,chrome,modal,titlebar,centerscreen";
    const candidateHosts = [
      win,
      Services.wm.getMostRecentWindow("navigator:browser"),
      Services.appShell?.hiddenDOMWindow,
    ];

    for (const host of candidateHosts) {
      try {
        if (typeof host?.openDialog === "function") {
          host.openDialog(url, "PermissionsDialog", dialogFeatures, params);
          return;
        }
      } catch (_) {
        // Try the next dialog host.
      }
    }
  },

  _openCustomFiltersDialog(win) {
    const url =
      "chrome://browser/content/preferences/dialogs/waterfoxBlockerCustomFilters.xhtml";
    const dialogName = "WaterfoxBlockerCustomFiltersDialog";
    const dialogFeatures = "resizable,chrome,modal,titlebar,centerscreen";
    const params = {
      origin: "waterfox-blocker-custom-filters",
    };

    try {
      if (typeof win?.gSubDialog?.open === "function") {
        win.gSubDialog.open(url, undefined, params);
        return;
      }
    } catch (_) {
      // Fall back to openDialog hosts below.
    }

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
      } catch (_) {
        // Try the next dialog host.
      }
    }
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
    } catch (_) {
      // Fall back to openDialog hosts below.
    }

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
      } catch (_) {
        // Try the next dialog host.
      }
    }
  },

  _openFilterListsDialog(win) {
    const url =
      "chrome://browser/content/preferences/dialogs/waterfoxBlockerFilterLists.xhtml";
    const dialogName = "WaterfoxBlockerFilterListsDialog";
    const dialogFeatures = "resizable,chrome,modal,titlebar,centerscreen";
    const params = {
      origin: "waterfox-blocker-filter-lists",
    };

    try {
      if (typeof win?.gSubDialog?.open === "function") {
        win.gSubDialog.open(url, undefined, params);
        return;
      }
    } catch (_) {
      // Fall back to openDialog hosts below.
    }

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
      } catch (_) {
        // Try the next dialog host.
      }
    }
  },

  _registerPreferences(Preferences) {
    const prefs = [
      { id: PREF_ENABLED, type: "bool" },
      { id: PREF_UI_ENABLED, type: "bool" },
      { id: PREF_ALLOW_SEARCH_PARTNER_ADS, type: "bool" },
      { id: PREF_SHOW_BADGE, type: "bool" },
      { id: PREF_FILTER_LIST_URLS, type: "string" },
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
      // Hide the notice if add-on lookup or localisation fails.
      if (
        thirdPartyNotice?.isConnected &&
        thirdPartyNotice.ownerDocument === doc
      ) {
        thirdPartyNotice.collapsed = true;
      }
    }
  },

  /**
   * @param {Window} win
   * @param {object} Preferences
   * @param {object} controls
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
      showBadgeCheckbox,
      customFilterListsButton,
      customFiltersButton,
      exceptionsButton,
      filterListsButton,
      onDetails,
    } = controls;

    const syncFromPrefs = () => {
      const enabled = readBooleanPreference(PREF_ENABLED, true);
      const allowSearchPartnerAds = readBooleanPreference(
        PREF_ALLOW_SEARCH_PARTNER_ADS,
        true
      );
      const showBadge = readBooleanPreference(PREF_SHOW_BADGE, true);

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

    if (customFiltersButton && !customFiltersButton.hasAttribute(BOUND_ATTR)) {
      customFiltersButton.addEventListener("command", event => {
        event.preventDefault();
        event.stopPropagation();
        this._openCustomFiltersDialog(win);
      });
      customFiltersButton.setAttribute(BOUND_ATTR, "true");
    }

    if (
      customFilterListsButton &&
      !customFilterListsButton.hasAttribute(BOUND_ATTR)
    ) {
      customFilterListsButton.addEventListener("command", event => {
        event.preventDefault();
        event.stopPropagation();
        this._openCustomFilterListsDialog(win);
      });
      customFilterListsButton.setAttribute(BOUND_ATTR, "true");
    }

    if (!group.hasAttribute(PREF_LISTENERS_ATTR)) {
      try {
        Preferences?.get?.(PREF_ENABLED)?.on("change", syncFromPrefs);
      } catch (_) {
        // Preference helper may be unavailable in this pane instance.
      }

      try {
        Preferences?.get?.(PREF_ALLOW_SEARCH_PARTNER_ADS)?.on(
          "change",
          syncFromPrefs
        );
      } catch (_) {
        // Preference helper may be unavailable in this pane instance.
      }

      try {
        Preferences?.get?.(PREF_SHOW_BADGE)?.on("change", syncFromPrefs);
      } catch (_) {
        // Preference helper may be unavailable in this pane instance.
      }

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
      } catch (err) {
        console.warn(
          `[WaterfoxBlockerPreferences] Failed to remove observer for ${topic}:`,
          err
        );
      }
    }
  },
};
