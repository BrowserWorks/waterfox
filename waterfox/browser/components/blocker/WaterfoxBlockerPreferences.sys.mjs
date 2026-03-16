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
const PREF_SITE_EXCEPTIONS = "waterfox.blocker.siteExceptions";
const PREF_FILTER_LIST_URLS = "waterfox.blocker.filterListUrls";

/*
 * Module rationale:
 *
 * This module injects Waterfox blocker controls into `about:preferences#privacy`
 * and keeps them aligned with existing privacy pane structure.
 *
 * The radio layout with expandable details is intentionally modelled on
 * the DoH controls (`doh.inc.xhtml` and related `preferences.js` wiring) so the
 * interaction style remains consistent with existing preferences UX patterns.
 *
 * The observer that fixes placement exists because sections in the privacy pane
 * are loaded and re-ordered asynchronously. Initial insertion can be displaced
 * after other modules patch the pane, so this module watches for reordering and
 * inserts the blocker group again until layout stabilises, using the same
 * approach as `extensionControlled.js`.
 */
const BOUND_ATTR = "data-waterfox-blocker-bound";
const PREF_LISTENERS_ATTR = "data-waterfox-blocker-pref-listeners";
const PLACEMENT_FIXUPS_ATTR = "data-waterfox-blocker-placement-fixups";

const BLOCKER_MODE_ON = "on";
const BLOCKER_MODE_OFF = "off";
const SEARCH_PARTNER_MODE_ALLOW = "partner-exception";
const SEARCH_PARTNER_MODE_BLOCK = "block-everything";
const GROUP_FRAGMENT_URL =
  "chrome://browser/content/blocker/waterfoxBlockerPreferences.inc.xhtml";
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

function positionBlockerGroup(document, mainPrefPane, group) {
  if (!document || !mainPrefPane || !group) {
    return;
  }

  const trackingGroup = document.getElementById("trackingGroup");

  if (trackingGroup?.parentNode === mainPrefPane) {
    if (
      group.parentNode !== mainPrefPane ||
      group.nextElementSibling !== trackingGroup
    ) {
      mainPrefPane.insertBefore(group, trackingGroup);
    }
    return;
  }

  const webrtcGroup = document.getElementById("webrtc");
  if (webrtcGroup?.parentNode === mainPrefPane) {
    if (
      group.parentNode !== mainPrefPane ||
      group.nextElementSibling !== webrtcGroup
    ) {
      mainPrefPane.insertBefore(group, webrtcGroup);
    }
    return;
  }

  const refHeaderGroup = document.getElementById("refheader");
  if (refHeaderGroup?.parentNode === mainPrefPane) {
    if (
      group.parentNode !== mainPrefPane ||
      group.nextElementSibling !== refHeaderGroup
    ) {
      mainPrefPane.insertBefore(group, refHeaderGroup);
    }
    return;
  }

  if (group.parentNode !== mainPrefPane) {
    mainPrefPane.appendChild(group);
  }
}

/**
 * Coordinates blocker controls in the privacy pane within preferences.
 *
 * Injects and positions the blocker UI, keeps it in sync with preferences and
 * extension state, and opens the exceptions and filter lists dialogs.
 */
export const WaterfoxBlockerPreferences = {
  _groupFragmentMarkupPromise: null,
  _initialized: false,

  /**
   * Builds or refreshes blocker controls for one preferences window.
   *
   * @param {Window} win Preferences window instance.
   */
  async _buildForWindow(win) {
    if (!win?.document) {
      return;
    }

    const { document } = win;
    const uiEnabled = readBooleanPreference(PREF_UI_ENABLED, false);
    if (!uiEnabled) {
      const existingGroup = document.getElementById("waterfoxBlockerGroup");
      if (existingGroup) {
        try {
          existingGroup.remove();
        } catch (_) {}
      }
      return;
    }

    const { Preferences } = win;

    win.MozXULElement?.insertFTLIfNeeded?.("browser/waterfox.ftl");

    const mainPrefPane = document.getElementById("mainPrefPane");
    if (!mainPrefPane) {
      return;
    }

    this._registerPreferences(Preferences);
    this._ensureGroupStylesheet(document);

    let group = document.getElementById("waterfoxBlockerGroup");
    let controls = group ? this._collectControls(document, group) : null;

    // If this window still has a stale copy of the UI, rebuild it.
    if (group && !this._controlsAreComplete(controls)) {
      try {
        group.remove();
      } catch (_) {}
      group = null;
      controls = null;
    }

    if (!group) {
      controls = await this._createGroupUI(win, document, mainPrefPane);
      group = controls?.group || null;
      if (!group) {
        return;
      }
    } else {
      positionBlockerGroup(document, mainPrefPane, group);
    }

    this._schedulePlacementFixups(win, document, mainPrefPane, group);

    if (this._controlsAreComplete(controls)) {
      this._wireInteractions(win, Preferences, controls);
    }

    try {
      Preferences?.queueUpdateOfAllElements?.();
    } catch (_) {}

    this._showGroupIfPrivacyActive(win, document, group);
  },

  _collectControls(document, group) {
    return {
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

  async _getGroupFragmentMarkup(win) {
    if (!this._groupFragmentMarkupPromise) {
      this._groupFragmentMarkupPromise = win
        .fetch(GROUP_FRAGMENT_URL)
        .then(response => {
          if (!response.ok) {
            throw new Error(
              `Failed to load blocker preferences fragment: ${response.status}`
            );
          }
          return response.text();
        })
        .catch(error => {
          this._groupFragmentMarkupPromise = null;
          throw error;
        });
    }

    return this._groupFragmentMarkupPromise;
  },

  async _loadGroupFragment(win, document) {
    const fragmentMarkup = await this._getGroupFragmentMarkup(win);
    const normalizedMarkup = fragmentMarkup.trimStart();
    if (
      !normalizedMarkup.includes("waterfoxBlockerGroup") ||
      !normalizedMarkup.includes("<groupbox")
    ) {
      return null;
    }

    if (typeof win.MozXULElement?.parseXULToFragment !== "function") {
      return null;
    }

    let fragment;
    try {
      fragment = win.MozXULElement.parseXULToFragment(normalizedMarkup);
    } catch (_) {
      return null;
    }

    const group =
      fragment.querySelector?.("#waterfoxBlockerGroup") ||
      fragment.firstElementChild;
    if (!group || group.id !== "waterfoxBlockerGroup") {
      return null;
    }

    return document.importNode(group, true);
  },

  async _createGroupUI(win, document, mainPrefPane) {
    this._ensureGroupStylesheet(document);

    let group = document.getElementById("waterfoxBlockerGroup");
    if (!group) {
      let loadedGroup = null;
      try {
        loadedGroup = await this._loadGroupFragment(win, document);
      } catch (_) {
        return null;
      }

      group = document.getElementById("waterfoxBlockerGroup");
      if (!group && loadedGroup) {
        group = loadedGroup;
      }
    }

    if (!group) {
      return null;
    }

    positionBlockerGroup(document, mainPrefPane, group);
    return this._collectControls(document, group);
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
      { id: PREF_SITE_EXCEPTIONS, type: "string" },
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
      if (
        thirdPartyNotice?.isConnected &&
        thirdPartyNotice.ownerDocument === doc
      ) {
        thirdPartyNotice.collapsed = true;
      }
    }
  },

  _schedulePlacementFixups(win, document, mainPrefPane, group) {
    if (!win || !document || !mainPrefPane || !group) {
      return;
    }

    if (group.hasAttribute(PLACEMENT_FIXUPS_ATTR)) {
      return;
    }

    const trackingGroup = document.getElementById("trackingGroup");
    if (
      trackingGroup?.parentNode === mainPrefPane &&
      group.parentNode === mainPrefPane &&
      group.nextElementSibling === trackingGroup
    ) {
      return;
    }

    group.setAttribute(PLACEMENT_FIXUPS_ATTR, "true");

    const observer = new win.MutationObserver(() => {
      if (!win?.document || !group?.isConnected) {
        observer.disconnect();
        return;
      }

      const currentMainPrefPane = win.document.getElementById("mainPrefPane");
      if (!currentMainPrefPane) {
        return;
      }

      positionBlockerGroup(win.document, currentMainPrefPane, group);

      const nextTrackingGroup = win.document.getElementById("trackingGroup");
      if (
        nextTrackingGroup?.parentNode === currentMainPrefPane &&
        group.parentNode === currentMainPrefPane &&
        group.nextElementSibling === nextTrackingGroup
      ) {
        observer.disconnect();
      }
    });

    observer.observe(mainPrefPane, {
      childList: true,
    });
  },

  _showGroupIfPrivacyActive(win, document, group) {
    const activeCategory =
      document.getElementById("categories")?.selectedItem?.value || "";
    const hash = String(win.location?.hash || "");
    if (
      activeCategory === "panePrivacy" ||
      hash === "#privacy" ||
      hash.startsWith("#privacy-")
    ) {
      group.removeAttribute("hidden");
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
      showBadgeCheckbox,
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

    void this._buildForWindow(subject);
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
