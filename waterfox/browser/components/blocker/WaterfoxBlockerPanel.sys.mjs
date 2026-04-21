/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WaterfoxBlockerService } from "resource:///modules/WaterfoxBlockerService.sys.mjs";
import { toSafeDomain } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI: "resource:///modules/CustomizableUI.sys.mjs",
});

const PREF_BRANCH = "waterfox.blocker.";
const PREF_SHIELDS_BRANCH = "waterfox.shields.";
const PREF_ENABLED = "waterfox.blocker.enabled";
const PREF_UI_ENABLED = "waterfox.blocker.ui.enabled";
const PREF_SHOW_BADGE = "waterfox.blocker.showBadge";
const PREF_PLACEMENT_VERSION = "waterfox.blocker.toolbarPlacementVersion";
const CURRENT_PLACEMENT_VERSION = 1;

const TOPIC_BLOCKED_COUNT_UPDATED = "WaterfoxBlocker:BlockedCountUpdated";
const TOPIC_BLOCKED_COUNTS_CLEARED = "WaterfoxBlocker:BlockedCountsCleared";
const TOPIC_CONTENT_BLOCKING_EVENT = "SiteProtection:ContentBlockingEvent";
const TOPIC_PICKER_RULE_ADDED = "WaterfoxBlocker:PickerRuleAdded";
const TOPIC_PICKER_STATE_CHANGED = "WaterfoxBlocker:PickerStateChanged";
const TOPIC_ZAPPER_STATE_CHANGED = "WaterfoxBlocker:ZapperStateChanged";

const OBSERVED_TOPICS = [
  "browser-delayed-startup-finished",
  TOPIC_CONTENT_BLOCKING_EVENT,
  TOPIC_BLOCKED_COUNT_UPDATED,
  TOPIC_BLOCKED_COUNTS_CLEARED,
  TOPIC_PICKER_RULE_ADDED,
  TOPIC_PICKER_STATE_CHANGED,
  TOPIC_ZAPPER_STATE_CHANGED,
];

const HTML_NS = "http://www.w3.org/1999/xhtml";

const WIDGET_ID = "waterfox-blocker-toolbar-button";
const PANEL_STYLESHEET_URI =
  "chrome://browser/content/blocker/waterfoxBlockerPanel.css";

const PANEL_IDS = {
  panel: "waterfox-blocker-panel",
  multiview: "waterfox-blocker-multiview",
  mainView: "waterfox-blocker-mainView",
  headerSection: "waterfox-blocker-header-section",
  adBlockStatus: "waterfox-blocker-panel-adblock-status",
  header: "waterfox-blocker-header-label",
  javascriptStatus: "waterfox-blocker-panel-javascript-status",
  cnameStatus: "waterfox-blocker-panel-cname-status",
  javascriptToggle: "waterfox-blocker-panel-javascript-toggle",
  settingsButton: "waterfox-blocker-settings-button",
  statusRow: "waterfox-blocker-panel-status-row",
  pickerButton: "waterfox-blocker-panel-picker-button",
  siteToggle: "waterfox-blocker-panel-site-toggle",
  zapperButton: "waterfox-blocker-panel-zapper-button",
};

const L10N_IDS = {
  notAvailable: "waterfox-blocker-panel-not-available",
  adBlockStatusOff: "waterfox-blocker-panel-adblock-status-off",
  adBlockStatusOn: "waterfox-blocker-panel-adblock-status-on",
  adBlockStatusSearchPartner:
    "waterfox-blocker-panel-adblock-status-search-partner",
  javascriptStatusAllowed: "waterfox-blocker-panel-javascript-status-allowed",
  javascriptStatusBlocked: "waterfox-blocker-panel-javascript-status-blocked",
  cnameStatusOn: "waterfox-blocker-panel-cname-status-on",
  cnameStatusOff: "waterfox-blocker-panel-cname-status-off",
  settingsButton: "waterfox-blocker-panel-settings-button",
  pickerStart: "waterfox-blocker-panel-picker-start",
  pickerStop: "waterfox-blocker-panel-picker-stop",
  zapperStart: "waterfox-blocker-panel-zapper-start",
  zapperStop: "waterfox-blocker-panel-zapper-stop",
  javascriptToggleOff: "waterfox-blocker-panel-javascript-toggle-off",
  javascriptToggleOn: "waterfox-blocker-panel-javascript-toggle-on",
  headerHost: "protections-header",
  toggleOff: "waterfox-blocker-panel-toggle-off",
  toggleOn: "waterfox-blocker-panel-toggle-on",
  toolbarButton: "waterfox-blocker-toolbar-button",
};

const POPUP_FALLBACK_TEXT = Object.freeze({
  [PANEL_IDS.javascriptToggle]: "Block JavaScript",
  [PANEL_IDS.zapperButton]: "Zap element",
  [PANEL_IDS.pickerButton]: "Pick element",
  [PANEL_IDS.settingsButton]: "Manage ad blocking settings",
});

function createXUL(doc, tag, attrs = {}) {
  const el = doc.createXULElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) {
      el.setAttribute(name, value);
    }
  }
  return el;
}

function createHTML(doc, tag, attrs = {}) {
  const el = doc.createElementNS(HTML_NS, tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value !== undefined && value !== null) {
      el.setAttribute(name, value);
    }
  }
  return el;
}

function setNodeL10nAttributes(doc, node, id, args = undefined) {
  if (!node) {
    return;
  }

  doc.l10n.setAttributes(node, id, args);
}

/**
 * Owns the Waterfox blocker toolbar button and popup panel.
 *
 * Registers a CustomizableUI `button` widget, injects a `<panel>` per
 * browser window, keeps badge and panel state in sync with the blocker,
 * and routes interactions to `WaterfoxBlockerService`.
 */
export const WaterfoxBlockerPanel = {
  _blockedCountByBrowserId: new Map(),
  _initialized: false,
  _widgetRegistered: false,
  _windowState: new WeakMap(),
  _styledWindows: new WeakSet(),
  _pickerActiveByBrowserId: new Map(),
  _zapperActiveByBrowserId: new Map(),

  _buildPanel(doc) {
    // ── Outer XUL shell — must stay XUL (Firefox panel system) ───────────────
    const panel = createXUL(doc, "panel", {
      class: "panel-no-padding",
      id: PANEL_IDS.panel,
      noautofocus: "true",
      orient: "vertical",
      role: "alertdialog",
      type: "arrow",
      "aria-labelledby": PANEL_IDS.header,
    });

    const multiview = createXUL(doc, "panelmultiview", {
      id: PANEL_IDS.multiview,
      mainViewId: PANEL_IDS.mainView,
    });

    const mainView = createXUL(doc, "panelview", {
      class: "PanelUI-subView",
      id: PANEL_IDS.mainView,
      role: "document",
      "mainview-with-header": "true",
      "has-custom-header": "true",
    });

    // ─────────────────────────────────────────────────────────────────────────
    // HEADER — dark-navy uBO-style band
    // Contains: domain bar (shield · hostname · settings gear)
    //           + full-width site on/off toggle
    // ─────────────────────────────────────────────────────────────────────────
    const headerSection = createHTML(doc, "div", {
      id: PANEL_IDS.headerSection,
      class: "wfb-header",
    });

    // Domain bar
    const domainBar = createHTML(doc, "div", { class: "wfb-domain-bar" });

    const shieldIcon = createHTML(doc, "span", {
      class: "wfb-shield-icon",
      "aria-hidden": "true",
    });
    domainBar.appendChild(shieldIcon);

    const headerLabel = createHTML(doc, "span", {
      id: PANEL_IDS.header,
      class: "wfb-host-name",
    });
    setNodeL10nAttributes(doc, headerLabel, L10N_IDS.notAvailable);
    domainBar.appendChild(headerLabel);

    const settingsButton = createHTML(doc, "button", {
      type: "button",
      class: "wfb-settings-btn",
      id: PANEL_IDS.settingsButton,
    });
    setNodeL10nAttributes(doc, settingsButton, L10N_IDS.settingsButton);
    domainBar.appendChild(settingsButton);

    headerSection.appendChild(domainBar);

    // Site toggle row
    const toggleRow = createHTML(doc, "div", { class: "wfb-toggle-row" });
    const siteToggle = createHTML(doc, "moz-toggle", {
      "data-l10n-attrs": "label, description, aria-label",
      id: PANEL_IDS.siteToggle,
    });
    setNodeL10nAttributes(doc, siteToggle, L10N_IDS.toggleOn);
    toggleRow.appendChild(siteToggle);
    headerSection.appendChild(toggleRow);

    const javascriptToggleRow = createHTML(doc, "div", {
      class: "wfb-toggle-row",
    });
    const javascriptToggle = createHTML(doc, "moz-toggle", {
      "data-l10n-attrs": "label, description, aria-label",
      id: PANEL_IDS.javascriptToggle,
    });
    setNodeL10nAttributes(doc, javascriptToggle, L10N_IDS.javascriptToggleOff);
    javascriptToggleRow.appendChild(javascriptToggle);
    headerSection.appendChild(javascriptToggleRow);

    mainView.appendChild(headerSection);

    // ─────────────────────────────────────────────────────────────────────────
    // BODY
    // ─────────────────────────────────────────────────────────────────────────
    const body = createHTML(doc, "div", {
      class: "panel-subview-body wfb-body",
    });

    const statusRow = createHTML(doc, "div", {
      class: "wfb-status-row",
      id: PANEL_IDS.statusRow,
    });

    const adBlockStatus = createHTML(doc, "span", {
      class: "wfb-status-pill",
      id: PANEL_IDS.adBlockStatus,
    });
    setNodeL10nAttributes(doc, adBlockStatus, L10N_IDS.adBlockStatusOn);
    statusRow.appendChild(adBlockStatus);

    const javascriptStatus = createHTML(doc, "span", {
      class: "wfb-status-pill",
      id: PANEL_IDS.javascriptStatus,
    });
    setNodeL10nAttributes(
      doc,
      javascriptStatus,
      L10N_IDS.javascriptStatusAllowed
    );
    statusRow.appendChild(javascriptStatus);

    const cnameStatus = createHTML(doc, "span", {
      class: "wfb-status-pill",
      id: PANEL_IDS.cnameStatus,
    });
    setNodeL10nAttributes(doc, cnameStatus, L10N_IDS.cnameStatusOn);
    statusRow.appendChild(cnameStatus);

    body.appendChild(statusRow);

    // ── Separator ────────────────────────────────────────────────────────────
    body.appendChild(createHTML(doc, "hr", { class: "wfb-sep" }));

    // ── Tools row (zapper + picker) ───────────────────────────────────────────
    const toolsRow = createHTML(doc, "div", { class: "wfb-tools-row" });

    const zapperButton = createHTML(doc, "button", {
      type: "button",
      class: "wfb-tool-btn",
      id: PANEL_IDS.zapperButton,
    });
    setNodeL10nAttributes(doc, zapperButton, L10N_IDS.zapperStart);
    toolsRow.appendChild(zapperButton);

    const pickerButton = createHTML(doc, "button", {
      type: "button",
      class: "wfb-tool-btn",
      id: PANEL_IDS.pickerButton,
    });
    setNodeL10nAttributes(doc, pickerButton, L10N_IDS.pickerStart);
    toolsRow.appendChild(pickerButton);

    body.appendChild(toolsRow);

    mainView.appendChild(body);
    multiview.appendChild(mainView);
    panel.appendChild(multiview);

    return panel;
  },

  _forEachBrowserWindow(callback) {
    const windows = Services.wm.getEnumerator("navigator:browser");
    while (windows.hasMoreElements()) {
      const win = windows.getNext();
      try {
        callback(win);
      } catch (_) {
        // Keep iterating windows even if one callback fails.
      }
    }
  },

  _forEachTab(win, callback) {
    const tabs = win?.gBrowser?.tabs;
    if (!tabs) {
      return;
    }

    for (const tab of tabs) {
      try {
        callback(tab);
      } catch (_) {
        // Keep iterating tabs even if one callback fails.
      }
    }
  },

  _getCurrentBrowser(win) {
    return win?.gBrowser?.selectedBrowser || null;
  },

  _getCurrentBrowserId(win) {
    return this._getCurrentBrowser(win)?.browsingContext?.top?.browserId || 0;
  },

  _getCurrentHost(win) {
    const uri = this._getCurrentBrowser(win)?.currentURI;
    try {
      if (!uri || (!uri.schemeIs("http") && !uri.schemeIs("https"))) {
        return "";
      }
      return toSafeDomain(uri.host || "");
    } catch (_) {
      return "";
    }
  },

  _getPanelNode(doc) {
    return doc?.getElementById(PANEL_IDS.panel) || null;
  },

  _handlePanelCommand(win, event) {
    switch (event.target?.id) {
      case PANEL_IDS.settingsButton:
        this._openBlockerPreferences(win, event.target);
        event.stopPropagation();
        break;

      case PANEL_IDS.zapperButton:
        this._toggleElementZapperForCurrentTab(win, event.target);
        event.stopPropagation();
        break;

      case PANEL_IDS.pickerButton:
        this._toggleElementPickerForCurrentTab(win, event.target);
        event.stopPropagation();
        break;

      default:
        break;
    }
  },

  _handlePanelToggle(win, event) {
    switch (event.target?.id) {
      case PANEL_IDS.siteToggle: {
        const pressed = !!event.target.pressed;
        this._setAdBlockForCurrentSite(win, pressed, event.target);
        event.stopPropagation();
        break;
      }

      case PANEL_IDS.javascriptToggle: {
        const blockJavascript = !!event.target.pressed;
        this._setJavascriptForCurrentSite(win, !blockJavascript, event.target);
        event.stopPropagation();
        break;
      }

      default:
        break;
    }
  },

  _hidePanelForNode(node) {
    if (!node) {
      return;
    }

    try {
      lazy.CustomizableUI.hidePanelForNode(node);
      return;
    } catch (_) {
      // Fallback below.
    }

    try {
      const panel = node.closest("panel");
      if (panel) {
        node.ownerGlobal.PanelMultiView.hidePopup(panel);
      }
    } catch (_) {
      // Panel may already be hidden.
    }
  },

  _ensurePanelStylesheet(win) {
    if (!win?.windowUtils || this._styledWindows.has(win)) {
      return;
    }

    try {
      win.windowUtils.loadSheetUsingURIString(
        PANEL_STYLESHEET_URI,
        Ci.nsIStyleSheetService.AUTHOR_SHEET
      );
    } catch (_) {
      // Stylesheet may already be loaded or unavailable in this context.
    }

    this._styledWindows.add(win);
  },

  _injectPanelIntoWindow(win) {
    const doc = win?.document;
    if (!doc || this._getPanelNode(doc)) {
      return;
    }

    this._ensurePanelStylesheet(win);

    const popupset =
      doc.getElementById("mainPopupSet") ||
      doc.querySelector("popupset") ||
      doc.documentElement;
    if (!popupset) {
      return;
    }

    popupset.appendChild(this._buildPanel(doc));
  },

  _removePanelFromWindow(win) {
    const panel = this._getPanelNode(win?.document);
    panel?.remove();
  },

  _hookBrowserWindow(win) {
    const gBrowser = win?.gBrowser;
    const tabContainer = gBrowser?.tabContainer;
    if (
      !win?.document ||
      !gBrowser ||
      !tabContainer ||
      this._windowState.has(win)
    ) {
      return;
    }

    this._injectPanelIntoWindow(win);

    const doc = win.document;

    const onCommand = event => {
      this._handlePanelCommand(win, event);
    };

    const onLocationChange = (
      browser,
      webProgress,
      _request,
      _location,
      flags = 0
    ) => {
      const isTopLevel = !!webProgress?.isTopLevel;
      const isSameDocument = !!(
        flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_SAME_DOCUMENT
      );

      if (isTopLevel && !isSameDocument) {
        const browserId = browser?.browsingContext?.top?.browserId || 0;
        if (browserId) {
          WaterfoxBlockerService.resetBlockedCount(browserId);
          this._pickerActiveByBrowserId.delete(browserId);
          this._zapperActiveByBrowserId.delete(browserId);
        }
      }

      if (win.gBrowser?.selectedBrowser === browser) {
        this._refreshWindow(win);
      }
    };

    const progressListener = {
      onLocationChange,
    };

    const onTabSelect = () => {
      this._refreshWindow(win);
    };

    const onTabClose = event => {
      const browserId =
        event.target?.linkedBrowser?.browsingContext?.top?.browserId || 0;
      if (browserId) {
        this._blockedCountByBrowserId.delete(browserId);
        this._pickerActiveByBrowserId.delete(browserId);
        this._zapperActiveByBrowserId.delete(browserId);
        WaterfoxBlockerService.clearPageRequestStats(browserId);
      }
      this._refreshWindow(win);
    };

    const onToggle = event => {
      this._handlePanelToggle(win, event);
    };

    const onUnload = () => {
      this._unhookBrowserWindow(win);
    };

    doc.addEventListener("click", onCommand, true);
    doc.addEventListener("toggle", onToggle, true);
    gBrowser.addTabsProgressListener?.(progressListener);
    tabContainer.addEventListener("TabSelect", onTabSelect);
    tabContainer.addEventListener("TabClose", onTabClose);
    win.addEventListener("unload", onUnload, { once: true });

    this._windowState.set(win, {
      onCommand,
      onTabClose,
      onTabSelect,
      onToggle,
      onUnload,
      progressListener,
    });
  },

  _isCurrentPageProtectable(win) {
    return !!this._getCurrentHost(win);
  },

  _onBlockedCountUpdated(subject) {
    const payload = subject?.wrappedJSObject;
    const browserId = Number(payload?.browserId || 0);
    const blockedCount = Number(payload?.blockedCount || 0);

    if (browserId) {
      this._blockedCountByBrowserId.set(browserId, Math.max(0, blockedCount));
    }

    this._refreshAllWindows();
  },

  _onBrowserDelayedStartupFinished(subject) {
    const win = subject;
    if (!win?.gBrowser) {
      return;
    }

    this._hookBrowserWindow(win);
    this._refreshWindow(win);
  },

  _onSiteProtectionEvent(subject) {
    const wrapped = subject?.wrappedJSObject;
    const browser = wrapped?.browser;
    const win = browser?.ownerGlobal;
    if (!win?.gBrowser) {
      return;
    }

    if (win.gBrowser.selectedBrowser === browser) {
      this._refreshWindow(win);
    }
  },

  _onZapperStateChanged(subject) {
    const payload = subject?.wrappedJSObject;
    const browserId = Number(payload?.browserId || 0);
    if (!browserId) {
      return;
    }

    if (payload?.active) {
      this._zapperActiveByBrowserId.set(browserId, true);
    } else {
      this._zapperActiveByBrowserId.delete(browserId);
    }

    this._refreshAllWindows();
  },

  _onPickerStateChanged(subject) {
    const payload = subject?.wrappedJSObject;
    const browserId = Number(payload?.browserId || 0);
    if (!browserId) {
      return;
    }

    if (payload?.active) {
      this._pickerActiveByBrowserId.set(browserId, true);
    } else {
      this._pickerActiveByBrowserId.delete(browserId);
    }

    this._refreshAllWindows();
  },

  _onPickerRuleAdded(subject) {
    const payload = subject?.wrappedJSObject;
    const browserId = Number(payload?.browserId || 0);
    if (!browserId || !payload?.added) {
      return;
    }

    this._refreshAllWindows();
  },

  _stopElementPickerForCurrentTab(win, sourceNode = null) {
    const browser = this._getCurrentBrowser(win);
    const browserId = browser?.browsingContext?.top?.browserId || 0;
    const actor =
      browser?.browsingContext?.currentWindowGlobal?.getActor(
        "WaterfoxBlocker"
      );

    if (!browserId || !actor) {
      this._refreshWindow(win);
      return;
    }

    this._pickerActiveByBrowserId.delete(browserId);
    try {
      actor.sendAsyncMessage("WaterfoxBlocker:StopElementPicker");
    } catch (err) {
      console.error("[WaterfoxBlockerPanel] failed to stop picker:", err);
    }

    this._hidePanelForNode(sourceNode);
    this._refreshWindow(win);
  },

  _openToolbarPanel(win, event = null) {
    const doc = win?.document;
    if (!doc) {
      return;
    }

    this._injectPanelIntoWindow(win);
    this._refreshWindow(win);

    if (!this._isCurrentPageProtectable(win)) {
      return;
    }

    const button =
      lazy.CustomizableUI.getWidget(WIDGET_ID)?.forWindow(win)?.node || null;
    const panel = this._getPanelNode(doc);

    if (!button || !panel || !win.PanelMultiView) {
      return;
    }

    win.PanelMultiView.openPopup(panel, button, {
      position: "bottomleft topleft",
      triggerEvent: event,
    }).catch(err => {
      console.error("[WaterfoxBlockerPanel] failed to open popup:", err);
    });
  },

  _openBlockerPreferences(win, sourceNode = null) {
    this._hidePanelForNode(sourceNode);

    try {
      if (typeof win.openTrustedLinkIn === "function") {
        win.openTrustedLinkIn("about:adblocker", "tab");
        return;
      }
    } catch (_) {
      // Fall back to direct preferences opening.
    }

    try {
      if (typeof win.openUILinkIn === "function") {
        win.openUILinkIn("about:adblocker", "tab");
      }
    } catch (_) {
      // Fallback opener may be unavailable in non-standard windows.
    }
  },

  _toggleElementZapperForCurrentTab(win, sourceNode = null) {
    const browser = this._getCurrentBrowser(win);
    const browserId = browser?.browsingContext?.top?.browserId || 0;
    const actor =
      browser?.browsingContext?.currentWindowGlobal?.getActor(
        "WaterfoxBlocker"
      );

    if (!browserId || !actor || !this._isCurrentPageProtectable(win)) {
      this._refreshWindow(win);
      return;
    }

    const nextActive = !this._zapperActiveByBrowserId.has(browserId);
    const pickerActive = this._pickerActiveByBrowserId.has(browserId);
    if (nextActive) {
      this._zapperActiveByBrowserId.set(browserId, true);
      if (pickerActive) {
        this._pickerActiveByBrowserId.delete(browserId);
        try {
          actor.sendAsyncMessage("WaterfoxBlocker:StopElementPicker");
        } catch (_) {}
      }
    } else {
      this._zapperActiveByBrowserId.delete(browserId);
    }

    try {
      actor.sendAsyncMessage(
        nextActive
          ? "WaterfoxBlocker:StartElementZapper"
          : "WaterfoxBlocker:StopElementZapper"
      );
    } catch (err) {
      this._zapperActiveByBrowserId.delete(browserId);
      console.error("[WaterfoxBlockerPanel] failed to toggle zapper:", err);
    }

    this._hidePanelForNode(sourceNode);
    this._refreshWindow(win);
  },

  _toggleElementPickerForCurrentTab(win, sourceNode = null) {
    const browser = this._getCurrentBrowser(win);
    const browserId = browser?.browsingContext?.top?.browserId || 0;
    const actor =
      browser?.browsingContext?.currentWindowGlobal?.getActor(
        "WaterfoxBlocker"
      );

    if (!browserId || !actor || !this._isCurrentPageProtectable(win)) {
      this._refreshWindow(win);
      return;
    }

    const pickerActive = this._pickerActiveByBrowserId.has(browserId);
    const zapperActive = this._zapperActiveByBrowserId.has(browserId);
    const nextActive = !pickerActive;

    try {
      actor.sendAsyncMessage(
        nextActive
          ? "WaterfoxBlocker:StartElementPicker"
          : "WaterfoxBlocker:StopElementPicker"
      );
      if (nextActive) {
        this._pickerActiveByBrowserId.set(browserId, true);
        if (zapperActive) {
          this._zapperActiveByBrowserId.delete(browserId);
          try {
            actor.sendAsyncMessage("WaterfoxBlocker:StopElementZapper");
          } catch (_) {}
        }
      } else {
        this._pickerActiveByBrowserId.delete(browserId);
      }
    } catch (err) {
      this._pickerActiveByBrowserId.delete(browserId);
      console.error("[WaterfoxBlockerPanel] failed to toggle picker:", err);
    }

    this._hidePanelForNode(sourceNode);
    this._refreshWindow(win);
  },

  _primeBlockedCountCache() {
    this._forEachBrowserWindow(win => {
      this._forEachTab(win, tab => {
        const browserId = tab?.linkedBrowser?.browsingContext?.top?.browserId;
        if (!browserId) {
          return;
        }

        let count = 0;
        try {
          count = Number(
            WaterfoxBlockerService.getBlockedCount(browserId) || 0
          );
        } catch (_) {
          count = 0;
        }

        if (count > 0) {
          this._blockedCountByBrowserId.set(browserId, count);
        }
      });
    });
  },

  _readBlockedCount(browserId) {
    if (!browserId) {
      return 0;
    }

    let count = 0;
    try {
      count = Number(WaterfoxBlockerService.getBlockedCount(browserId) || 0);
    } catch (_) {
      count = Number(this._blockedCountByBrowserId.get(browserId) || 0);
    }

    this._blockedCountByBrowserId.set(browserId, count);
    return count;
  },

  _refreshAllWindows() {
    this._forEachBrowserWindow(win => {
      this._refreshWindow(win);
    });
  },

  _getPanelSiteState(win, enabled) {
    const host = this._getCurrentHost(win);
    const protectable = this._isCurrentPageProtectable(win);
    const globalEnabled =
      enabled ?? Services.prefs.getBoolPref(PREF_ENABLED, true);
    const shieldState =
      protectable && host
        ? WaterfoxBlockerService.getSiteShieldState(host)
        : {
            adBlockEnabled: globalEnabled,
            javascriptEnabled: true,
            searchPartnerAllowed: false,
            siteBlockingEnabled: globalEnabled,
          };

    return {
      adBlockEnabled: shieldState.adBlockEnabled,
      cnameEnabled: Services.prefs.getBoolPref(
        "waterfox.blocker.cnameUncloaking",
        true
      ),
      globalEnabled,
      host,
      javascriptBlocked: protectable && !shieldState.javascriptEnabled,
      javascriptEnabled: shieldState.javascriptEnabled,
      protectable,
      searchPartnerAllowed: shieldState.searchPartnerAllowed,
      siteBlockingEnabled: shieldState.siteBlockingEnabled,
    };
  },

  _refreshPanelHeader(doc, siteState) {
    const header = doc.getElementById(PANEL_IDS.header);
    if (!header) {
      return;
    }

    setNodeL10nAttributes(
      doc,
      header,
      siteState.protectable && siteState.host
        ? L10N_IDS.headerHost
        : L10N_IDS.notAvailable,
      siteState.protectable && siteState.host
        ? { host: siteState.host }
        : undefined
    );
  },

  _refreshSiteToggle(doc, siteState) {
    const siteToggle = doc.getElementById(PANEL_IDS.siteToggle);
    if (!siteToggle) {
      return;
    }

    siteToggle.pressed = siteState.adBlockEnabled;
    siteToggle.disabled =
      !siteState.protectable || siteState.searchPartnerAllowed;
    setNodeL10nAttributes(
      doc,
      siteToggle,
      siteState.adBlockEnabled ? L10N_IDS.toggleOn : L10N_IDS.toggleOff,
      siteState.host ? { host: siteState.host } : undefined
    );
  },

  _refreshJavascriptToggle(doc, siteState) {
    const javascriptToggle = doc.getElementById(PANEL_IDS.javascriptToggle);
    if (!javascriptToggle) {
      return;
    }

    javascriptToggle.pressed = siteState.javascriptBlocked;
    javascriptToggle.disabled = !siteState.protectable;
    setNodeL10nAttributes(
      doc,
      javascriptToggle,
      siteState.javascriptBlocked
        ? L10N_IDS.javascriptToggleOn
        : L10N_IDS.javascriptToggleOff,
      siteState.host ? { host: siteState.host } : undefined
    );
  },

  _refreshStatusRow(doc, siteState) {
    const statusRow = doc.getElementById(PANEL_IDS.statusRow);
    if (!statusRow) {
      return;
    }

    statusRow.hidden = !siteState.protectable;
    if (!siteState.protectable) {
      return;
    }

    const adBlockStatus = doc.getElementById(PANEL_IDS.adBlockStatus);
    if (adBlockStatus) {
      let l10nId = siteState.adBlockEnabled
        ? L10N_IDS.adBlockStatusOn
        : L10N_IDS.adBlockStatusOff;
      if (siteState.searchPartnerAllowed) {
        l10nId = L10N_IDS.adBlockStatusSearchPartner;
      }
      setNodeL10nAttributes(doc, adBlockStatus, l10nId);
    }

    const javascriptStatus = doc.getElementById(PANEL_IDS.javascriptStatus);
    if (javascriptStatus) {
      setNodeL10nAttributes(
        doc,
        javascriptStatus,
        siteState.javascriptBlocked
          ? L10N_IDS.javascriptStatusBlocked
          : L10N_IDS.javascriptStatusAllowed
      );
    }

    const cnameStatus = doc.getElementById(PANEL_IDS.cnameStatus);
    if (cnameStatus) {
      setNodeL10nAttributes(
        doc,
        cnameStatus,
        siteState.cnameEnabled
          ? L10N_IDS.cnameStatusOn
          : L10N_IDS.cnameStatusOff
      );
      cnameStatus.classList.toggle(
        "wfb-status-pill--off",
        !siteState.cnameEnabled
      );
    }
  },

  _refreshToolButton(doc, buttonId, disabled, l10nId) {
    const button = doc.getElementById(buttonId);
    if (!button) {
      return;
    }

    button.disabled = !!disabled;
    setNodeL10nAttributes(doc, button, l10nId);
  },

  _refreshPanelForWindow(win, blockedCount, enabled) {
    const doc = win?.document;
    if (!doc) {
      return;
    }

    const siteState = this._getPanelSiteState(win, enabled);
    const count =
      blockedCount !== undefined
        ? blockedCount
        : this._readBlockedCount(this._getCurrentBrowserId(win));
    const browserId = this._getCurrentBrowserId(win);
    const zapperActive = this._zapperActiveByBrowserId.has(browserId);
    const pickerActive = this._pickerActiveByBrowserId.has(browserId);

    this._refreshPanelHeader(doc, siteState);
    this._refreshSiteToggle(doc, siteState);
    this._refreshJavascriptToggle(doc, siteState);
    this._refreshStatusRow(doc, siteState);
    this._refreshToolButton(
      doc,
      PANEL_IDS.zapperButton,
      !siteState.protectable,
      zapperActive ? L10N_IDS.zapperStop : L10N_IDS.zapperStart
    );
    this._refreshToolButton(
      doc,
      PANEL_IDS.pickerButton,
      !siteState.protectable,
      pickerActive ? L10N_IDS.pickerStop : L10N_IDS.pickerStart
    );

    this._applyPopupLabelFallbacks(doc);
    this._updateToolbarButtonForWindow(win, count, siteState.protectable);
  },

  _applyPopupLabelFallbacks(doc) {
    for (const [id, fallback] of Object.entries(POPUP_FALLBACK_TEXT)) {
      const node = doc.getElementById(id);
      if (!node) {
        continue;
      }

      // HTML elements use textContent; XUL elements use the label attribute.
      const text = String(node.textContent || "").trim();
      const label = String(node.getAttribute("label") || "").trim();
      if (!text && !label) {
        if (node.namespaceURI === HTML_NS) {
          node.textContent = fallback;
        } else {
          node.setAttribute("label", fallback);
        }
      }
    }
  },

  _refreshWindow(win) {
    const browserId = this._getCurrentBrowserId(win);

    if (!win?.document) {
      return;
    }

    this._injectPanelIntoWindow(win);
    const blockedCount = this._readBlockedCount(browserId);
    const enabled = Services.prefs.getBoolPref(PREF_ENABLED, true);

    this._refreshPanelForWindow(win, blockedCount, enabled);
  },

  _registerWidget() {
    if (this._widgetRegistered) {
      return;
    }

    let hadPlacementBeforeCreate = false;
    try {
      hadPlacementBeforeCreate =
        !!lazy.CustomizableUI.getPlacementOfWidget(WIDGET_ID);
    } catch (_) {
      hadPlacementBeforeCreate = false;
    }

    lazy.CustomizableUI.createWidget({
      id: WIDGET_ID,
      l10nId: L10N_IDS.toolbarButton,
      type: "button",
      defaultArea: lazy.CustomizableUI.AREA_NAVBAR,
      onCreated(node) {
        node.setAttribute("badged", "true");
      },
      onCommand(event) {
        const win = event?.target?.ownerGlobal;
        if (!win?.gBrowser) {
          return;
        }
        WaterfoxBlockerPanel._openToolbarPanel(win, event);
      },
    });

    this._widgetRegistered = true;

    const savedVersion = Services.prefs.getIntPref(PREF_PLACEMENT_VERSION, 0);
    if (!hadPlacementBeforeCreate || savedVersion < CURRENT_PLACEMENT_VERSION) {
      if (this._ensureDefaultPlacement()) {
        Services.prefs.setIntPref(
          PREF_PLACEMENT_VERSION,
          CURRENT_PLACEMENT_VERSION
        );
      }
    }
  },

  _ensureDefaultPlacement() {
    const area = lazy.CustomizableUI.AREA_NAVBAR;

    try {
      const ids = lazy.CustomizableUI.getWidgetIdsInArea(area);
      const urlbarIdx = ids.indexOf("urlbar-container");
      if (urlbarIdx < 0) {
        return false;
      }

      // addWidgetToArea handles both initial placement and repositioning.
      // If the widget is already in the area it gets moved to the new position.
      lazy.CustomizableUI.addWidgetToArea(WIDGET_ID, area, urlbarIdx + 1);
      return true;
    } catch (_) {
      return false;
    }
  },

  _setAdBlockForCurrentSite(win, enabled, sourceNode = null) {
    const host = this._getCurrentHost(win);
    if (!host) {
      this._refreshWindow(win);
      return;
    }

    WaterfoxBlockerService.setAdBlockEnabledForSite(host, enabled);
    this._refreshWindow(win);
    this._hidePanelForNode(sourceNode);
    this._reloadCurrentTab(win);
  },

  _setJavascriptForCurrentSite(win, allowJavascript, sourceNode = null) {
    const host = this._getCurrentHost(win);
    if (!host) {
      this._refreshWindow(win);
      return;
    }

    WaterfoxBlockerService.setJavascriptEnabledForSite(host, allowJavascript);
    this._refreshWindow(win);
    this._hidePanelForNode(sourceNode);
    this._reloadCurrentTab(win);
  },

  _reloadCurrentTab(win) {
    try {
      win.gBrowser?.reloadTab(win.gBrowser.selectedTab);
      return;
    } catch (_) {
      // Selected tab may be unavailable during teardown.
    }

    try {
      win.BrowserCommands?.reload();
    } catch (_) {
      // Fallback may be unavailable in non-standard windows.
    }
  },

  _unhookBrowserWindow(win) {
    const doc = win?.document;
    if (!doc) {
      return;
    }

    const state = this._windowState.get(win);
    if (state) {
      try {
        doc.removeEventListener("click", state.onCommand, true);
        doc.removeEventListener("toggle", state.onToggle, true);
        win.gBrowser?.removeTabsProgressListener?.(state.progressListener);
        win.gBrowser?.tabContainer?.removeEventListener(
          "TabSelect",
          state.onTabSelect
        );
        win.gBrowser?.tabContainer?.removeEventListener(
          "TabClose",
          state.onTabClose
        );
        win.removeEventListener("unload", state.onUnload);
      } catch (_) {
        // Listeners may already be removed as part of shutdown ordering.
      }

      this._windowState.delete(win);
    }

    this._removePanelFromWindow(win);
    this._styledWindows.delete(win);
  },

  _updateToolbarButtonForWindow(win, blockedCount, protectable) {
    const button =
      lazy.CustomizableUI.getWidget(WIDGET_ID)?.forWindow(win)?.node || null;

    if (!button) {
      return;
    }

    const uiEnabled = Services.prefs.getBoolPref(PREF_UI_ENABLED, false);
    button.hidden = !uiEnabled;

    if (!uiEnabled) {
      button.removeAttribute("badge");
      button.removeAttribute("page-not-protectable");
      return;
    }

    button.setAttribute("badged", "true");

    const showBadge = Services.prefs.getBoolPref(PREF_SHOW_BADGE, true);
    if (showBadge && blockedCount > 0) {
      const badgeValue = String(blockedCount);
      button.setAttribute("badge", badgeValue);
    } else {
      button.removeAttribute("badge");
    }

    button.toggleAttribute("page-not-protectable", !protectable);
  },

  _destroyWidget() {
    if (!this._widgetRegistered) {
      return;
    }

    try {
      lazy.CustomizableUI.destroyWidget(WIDGET_ID);
    } catch (_) {
      // Widget may already be gone.
    }

    this._widgetRegistered = false;
  },

  init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;

    this._registerWidget();

    for (const topic of OBSERVED_TOPICS) {
      Services.obs.addObserver(this, topic);
    }
    Services.prefs.addObserver(PREF_BRANCH, this);
    Services.prefs.addObserver(PREF_SHIELDS_BRANCH, this);

    this._primeBlockedCountCache();

    this._forEachBrowserWindow(win => {
      this._hookBrowserWindow(win);
      this._refreshWindow(win);
    });
  },

  observe(subject, topic, data) {
    if (topic === "nsPref:changed") {
      const pref = String(data || "");
      if (
        pref.startsWith(PREF_BRANCH) ||
        pref.startsWith(PREF_SHIELDS_BRANCH)
      ) {
        this._refreshAllWindows();
      }
      return;
    }

    switch (topic) {
      case "browser-delayed-startup-finished":
        this._onBrowserDelayedStartupFinished(subject);
        break;

      case TOPIC_CONTENT_BLOCKING_EVENT:
        this._onSiteProtectionEvent(subject);
        break;

      case TOPIC_BLOCKED_COUNT_UPDATED:
        this._onBlockedCountUpdated(subject);
        break;

      case TOPIC_BLOCKED_COUNTS_CLEARED:
        this._blockedCountByBrowserId.clear();
        this._refreshAllWindows();
        break;

      case TOPIC_ZAPPER_STATE_CHANGED:
        this._onZapperStateChanged(subject);
        break;

      case TOPIC_PICKER_STATE_CHANGED:
        this._onPickerStateChanged(subject);
        break;

      case TOPIC_PICKER_RULE_ADDED:
        this._onPickerRuleAdded(subject);
        break;
    }
  },

  uninit() {
    if (!this._initialized) {
      return;
    }

    this._initialized = false;

    for (const topic of OBSERVED_TOPICS) {
      try {
        Services.obs.removeObserver(this, topic);
      } catch (_) {
        // Observer may already be removed.
      }
    }

    try {
      Services.prefs.removeObserver(PREF_BRANCH, this);
      Services.prefs.removeObserver(PREF_SHIELDS_BRANCH, this);
    } catch (_) {
      // Pref observer may already be removed.
    }

    this._forEachBrowserWindow(win => {
      this._unhookBrowserWindow(win);
    });

    this._destroyWidget();
    this._blockedCountByBrowserId.clear();
    this._pickerActiveByBrowserId.clear();
    this._zapperActiveByBrowserId.clear();
  },
};
