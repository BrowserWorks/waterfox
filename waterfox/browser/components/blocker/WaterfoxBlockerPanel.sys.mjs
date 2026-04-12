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
const PREF_ENABLED = "waterfox.blocker.enabled";
const PREF_UI_ENABLED = "waterfox.blocker.ui.enabled";
const PREF_SHOW_BADGE = "waterfox.blocker.showBadge";
const PREF_PLACEMENT_VERSION = "waterfox.blocker.toolbarPlacementVersion";
const CURRENT_PLACEMENT_VERSION = 1;

const TOPIC_BLOCKED_COUNT_UPDATED = "WaterfoxBlocker:BlockedCountUpdated";
const TOPIC_BLOCKED_COUNTS_CLEARED = "WaterfoxBlocker:BlockedCountsCleared";
const TOPIC_CONTENT_BLOCKING_EVENT = "SiteProtection:ContentBlockingEvent";
const TOPIC_LOGGER_UPDATED = "WaterfoxBlocker:LoggerUpdated";
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
  header: "waterfox-blocker-header-label",
  blockedCount: "waterfox-blocker-panel-blocked-count",
  cosmeticFilteringButton: "waterfox-blocker-panel-cosmetic-filtering-button",
  loggerButton: "waterfox-blocker-panel-logger-button",
  remoteFontsButton: "waterfox-blocker-panel-remote-fonts-button",
  settingsButton: "waterfox-blocker-settings-button",
  pickerButton: "waterfox-blocker-panel-picker-button",
  scriptingButton: "waterfox-blocker-panel-scripting-button",
  siteToggle: "waterfox-blocker-panel-site-toggle",
  zapperButton: "waterfox-blocker-panel-zapper-button",
};

const L10N_IDS = {
  notAvailable: "waterfox-blocker-panel-not-available",
  disabled: "waterfox-blocker-panel-disabled",
  partnerAllowed: "waterfox-blocker-panel-partner-allowed",
  siteExcepted: "waterfox-blocker-panel-site-excepted",
  cosmeticFilteringDisable: "waterfox-blocker-panel-cosmetic-filtering-disable",
  cosmeticFilteringEnable: "waterfox-blocker-panel-cosmetic-filtering-enable",
  loggerButton: "waterfox-blocker-panel-logger-button",
  remoteFontsDisable: "waterfox-blocker-panel-remote-fonts-disable",
  remoteFontsEnable: "waterfox-blocker-panel-remote-fonts-enable",
  settingsButton: "waterfox-blocker-panel-settings-button",
  pickerStart: "waterfox-blocker-panel-picker-start",
  pickerStop: "waterfox-blocker-panel-picker-stop",
  scriptingDisable: "waterfox-blocker-panel-scripting-disable",
  scriptingEnable: "waterfox-blocker-panel-scripting-enable",
  zapperStart: "waterfox-blocker-panel-zapper-start",
  zapperStop: "waterfox-blocker-panel-zapper-stop",
  headerHost: "protections-header",
  stats: "waterfox-blocker-stats",
  toggle: "waterfox-blocker-panel-toggle",
  toolbarButton: "waterfox-blocker-toolbar-button",
};

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
  _loggerWindows: new Map(),
  _pickerActiveByBrowserId: new Map(),
  _zapperActiveByBrowserId: new Map(),

  _buildPanel(doc) {
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

    const headerSection = createXUL(doc, "vbox", {
      id: PANEL_IDS.headerSection,
    });

    const header = createXUL(doc, "box", {
      class: "panel-header",
    });

    const headerTitle = createHTML(doc, "h1");
    const headerLabel = createHTML(doc, "span", {
      id: PANEL_IDS.header,
    });
    setNodeL10nAttributes(doc, headerLabel, L10N_IDS.notAvailable);

    headerTitle.appendChild(headerLabel);
    header.appendChild(headerTitle);
    headerSection.appendChild(header);
    headerSection.appendChild(createXUL(doc, "toolbarseparator"));
    mainView.appendChild(headerSection);

    const body = createXUL(doc, "vbox", {
      class: "panel-subview-body",
    });

    const toggleSection = createXUL(doc, "vbox", {
      class: "protections-popup-section protections-popup-switch-section",
    });

    const toggleSectionHeader = createXUL(doc, "hbox", {
      class: "protections-popup-switch-section-header",
    });

    const toggleBox = createXUL(doc, "vbox", {
      flex: "1",
      align: "stretch",
    });

    const siteToggle = createHTML(doc, "moz-toggle", {
      id: PANEL_IDS.siteToggle,
    });
    setNodeL10nAttributes(doc, siteToggle, L10N_IDS.toggle);
    toggleBox.appendChild(siteToggle);
    toggleSectionHeader.appendChild(toggleBox);
    toggleSection.appendChild(toggleSectionHeader);
    body.appendChild(toggleSection);

    body.appendChild(createXUL(doc, "toolbarseparator"));

    const statsSection = createXUL(doc, "vbox", {
      class: "protections-popup-section",
    });

    const statsRow = createXUL(doc, "hbox", {
      align: "center",
      style:
        "margin: var(--arrowpanel-menuitem-margin); padding: var(--arrowpanel-menuitem-padding);",
    });

    const statsIcon = createXUL(doc, "image", {
      class: "protections-popup-footer-icon protections-popup-show-report-icon",
    });
    statsRow.appendChild(statsIcon);

    const blockedCount = createXUL(doc, "label", {
      class: "text-deemphasized",
      flex: "1",
      id: PANEL_IDS.blockedCount,
    });
    setNodeL10nAttributes(doc, blockedCount, L10N_IDS.stats, {
      count: 0,
    });
    statsRow.appendChild(blockedCount);
    statsSection.appendChild(statsRow);
    body.appendChild(statsSection);

    body.appendChild(createXUL(doc, "toolbarseparator"));

    const toolsSection = createXUL(doc, "vbox", {
      class: "protections-popup-section",
    });

    const cosmeticFilteringButton = createXUL(doc, "toolbarbutton", {
      class: "subviewbutton",
      id: PANEL_IDS.cosmeticFilteringButton,
    });
    setNodeL10nAttributes(
      doc,
      cosmeticFilteringButton,
      L10N_IDS.cosmeticFilteringDisable
    );
    toolsSection.appendChild(cosmeticFilteringButton);

    const scriptingButton = createXUL(doc, "toolbarbutton", {
      class: "subviewbutton",
      id: PANEL_IDS.scriptingButton,
    });
    setNodeL10nAttributes(doc, scriptingButton, L10N_IDS.scriptingDisable);
    toolsSection.appendChild(scriptingButton);

    const remoteFontsButton = createXUL(doc, "toolbarbutton", {
      class: "subviewbutton",
      id: PANEL_IDS.remoteFontsButton,
    });
    setNodeL10nAttributes(doc, remoteFontsButton, L10N_IDS.remoteFontsDisable);
    toolsSection.appendChild(remoteFontsButton);

    const zapperButton = createXUL(doc, "toolbarbutton", {
      class: "subviewbutton",
      id: PANEL_IDS.zapperButton,
    });
    setNodeL10nAttributes(doc, zapperButton, L10N_IDS.zapperStart);
    toolsSection.appendChild(zapperButton);

    const pickerButton = createXUL(doc, "toolbarbutton", {
      class: "subviewbutton",
      id: PANEL_IDS.pickerButton,
    });
    setNodeL10nAttributes(doc, pickerButton, L10N_IDS.pickerStart);
    toolsSection.appendChild(pickerButton);

    const loggerButton = createXUL(doc, "toolbarbutton", {
      class: "subviewbutton",
      id: PANEL_IDS.loggerButton,
    });
    setNodeL10nAttributes(doc, loggerButton, L10N_IDS.loggerButton);
    toolsSection.appendChild(loggerButton);
    body.appendChild(toolsSection);

    mainView.appendChild(body);

    mainView.appendChild(createXUL(doc, "toolbarseparator"));

    const settingsButton = createXUL(doc, "toolbarbutton", {
      class: "subviewbutton panel-subview-footer-button",
      id: PANEL_IDS.settingsButton,
    });
    setNodeL10nAttributes(doc, settingsButton, L10N_IDS.settingsButton);
    mainView.appendChild(settingsButton);

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

      case PANEL_IDS.cosmeticFilteringButton:
        this._toggleCosmeticFilteringForCurrentSite(win, event.target);
        event.stopPropagation();
        break;

      case PANEL_IDS.scriptingButton:
        this._toggleScriptingForCurrentSite(win, event.target);
        event.stopPropagation();
        break;

      case PANEL_IDS.remoteFontsButton:
        this._toggleRemoteFontsForCurrentSite(win, event.target);
        event.stopPropagation();
        break;

      case PANEL_IDS.pickerButton:
        this._toggleElementPickerForCurrentTab(win, event.target);
        event.stopPropagation();
        break;

      case PANEL_IDS.loggerButton:
        this._openLoggerWindow(win, event.target);
        event.stopPropagation();
        break;

      default:
        break;
    }
  },

  _handlePanelToggle(win, event) {
    if (event.target?.id !== PANEL_IDS.siteToggle) {
      return;
    }

    const pressed = !!event.target.pressed;
    this._setSiteExceptionForCurrentSite(win, !pressed, event.target);
    event.stopPropagation();
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
      }
      this._refreshWindow(win);
    };

    const onToggle = event => {
      this._handlePanelToggle(win, event);
    };

    const onUnload = () => {
      this._unhookBrowserWindow(win);
    };

    doc.addEventListener("command", onCommand, true);
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

    const win = this._findBrowserWindowByBrowserId(browserId);
    if (win) {
      this._reloadCurrentTab(win);
    }
  },

  _findBrowserWindowByBrowserId(browserId) {
    let found = null;
    this._forEachBrowserWindow(win => {
      if (found) {
        return;
      }

      if (this._getCurrentBrowserId(win) === browserId) {
        found = win;
      }
    });
    return found;
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
    }).catch(console.error);
  },

  _openBlockerPreferences(win, sourceNode = null) {
    this._hidePanelForNode(sourceNode);

    try {
      if (typeof win.openTrustedLinkIn === "function") {
        win.openTrustedLinkIn("about:preferences#privacy", "tab");
        return;
      }
    } catch (_) {
      // Fall back to direct preferences opening.
    }

    try {
      if (typeof win.openPreferences === "function") {
        win.openPreferences("panePrivacy", {
          origin: "waterfox-blocker",
        });
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

  _toggleCosmeticFilteringForCurrentSite(win, sourceNode = null) {
    const host = this._getCurrentHost(win);
    if (!host || !this._isCurrentPageProtectable(win)) {
      this._refreshWindow(win);
      return;
    }

    const currentlyDisabled =
      WaterfoxBlockerService.isCosmeticFilteringDisabled(host);

    if (currentlyDisabled) {
      WaterfoxBlockerService.removeNoCosmeticFilteringSite(host);
    } else {
      WaterfoxBlockerService.addNoCosmeticFilteringSite(host);
    }

    this._refreshWindow(win);
    this._hidePanelForNode(sourceNode);
    this._reloadCurrentTab(win);
  },

  _toggleScriptingForCurrentSite(win, sourceNode = null) {
    const host = this._getCurrentHost(win);
    if (!host || !this._isCurrentPageProtectable(win)) {
      this._refreshWindow(win);
      return;
    }

    const currentlyDisabled = WaterfoxBlockerService.isScriptingDisabled(host);

    if (currentlyDisabled) {
      WaterfoxBlockerService.removeNoScriptingSite(host);
    } else {
      WaterfoxBlockerService.addNoScriptingSite(host);
    }

    this._refreshWindow(win);
    this._hidePanelForNode(sourceNode);
    this._reloadCurrentTab(win);
  },

  _toggleRemoteFontsForCurrentSite(win, sourceNode = null) {
    const host = this._getCurrentHost(win);
    if (!host || !this._isCurrentPageProtectable(win)) {
      this._refreshWindow(win);
      return;
    }

    const currentlyDisabled =
      WaterfoxBlockerService.isRemoteFontsDisabled(host);

    if (currentlyDisabled) {
      WaterfoxBlockerService.removeNoRemoteFontsSite(host);
    } else {
      WaterfoxBlockerService.addNoRemoteFontsSite(host);
    }

    this._refreshWindow(win);
    this._hidePanelForNode(sourceNode);
    this._reloadCurrentTab(win);
  },

  _getLoggerWindow() {
    const loggerWin = Services.wm.getMostRecentWindow(
      "waterfox:blocker-logger"
    );
    if (!loggerWin || loggerWin.closed) {
      return null;
    }
    return loggerWin;
  },

  _getLoggerWindowApi(loggerWin) {
    if (!loggerWin || loggerWin.closed) {
      return null;
    }

    return (
      loggerWin.WaterfoxBlockerLogger ||
      loggerWin.gWaterfoxBlockerLogger ||
      null
    );
  },

  _syncLoggerWindow(loggerWin) {
    const state = this._loggerWindows.get(loggerWin);
    const api = this._getLoggerWindowApi(loggerWin);
    if (!state || !api) {
      return;
    }

    const sourceWin = state.sourceWindow;
    const browserId =
      sourceWin && !sourceWin.closed ? this._getCurrentBrowserId(sourceWin) : 0;

    api.setCurrentBrowserId(browserId);
    api.setPaused(WaterfoxBlockerService.isLoggerPaused());
    api.setEntries(WaterfoxBlockerService.getLoggerEntries(0));
  },

  _teardownLoggerWindow(loggerWin) {
    const state = this._loggerWindows.get(loggerWin);
    if (!state) {
      return;
    }

    try {
      Services.obs.removeObserver(state.observer, TOPIC_LOGGER_UPDATED);
    } catch (_) {}

    try {
      loggerWin.removeEventListener("load", state.onLoad);
      loggerWin.removeEventListener("unload", state.onUnload);
      loggerWin.document?.removeEventListener("command", state.onCommand);
    } catch (_) {}

    this._loggerWindows.delete(loggerWin);
  },

  _registerLoggerWindow(loggerWin, sourceWin) {
    if (!loggerWin || loggerWin.closed) {
      return;
    }

    const existingState = this._loggerWindows.get(loggerWin);
    if (existingState) {
      existingState.sourceWindow = sourceWin;
      this._syncLoggerWindow(loggerWin);
      return;
    }

    const observer = {
      observe: (_subject, topic) => {
        if (topic === TOPIC_LOGGER_UPDATED) {
          this._syncLoggerWindow(loggerWin);
        }
      },
    };

    const onCommand = event => {
      const api = this._getLoggerWindowApi(loggerWin);
      if (!api) {
        return;
      }

      switch (event.target?.id) {
        case "waterfoxBlockerLoggerPause":
          WaterfoxBlockerService.setLoggerPaused(!!api.getSnapshot?.().paused);
          break;

        case "waterfoxBlockerLoggerClear":
          WaterfoxBlockerService.clearLoggerEntries();
          break;
      }
    };

    const onLoad = () => {
      try {
        loggerWin.document?.addEventListener("command", onCommand);
      } catch (_) {}
      this._syncLoggerWindow(loggerWin);
    };

    const onUnload = () => {
      this._teardownLoggerWindow(loggerWin);
    };

    this._loggerWindows.set(loggerWin, {
      observer,
      onCommand,
      onLoad,
      onUnload,
      sourceWindow: sourceWin,
    });

    Services.obs.addObserver(observer, TOPIC_LOGGER_UPDATED);
    loggerWin.addEventListener("load", onLoad, { once: true });
    loggerWin.addEventListener("unload", onUnload, { once: true });

    if (loggerWin.document?.readyState === "complete") {
      onLoad();
    }
  },

  _syncLoggerWindowsForSourceWindow(sourceWin) {
    for (const [loggerWin, state] of this._loggerWindows.entries()) {
      if (!loggerWin || loggerWin.closed) {
        this._teardownLoggerWindow(loggerWin);
        continue;
      }

      if (state.sourceWindow === sourceWin) {
        this._syncLoggerWindow(loggerWin);
      }
    }
  },

  _openLoggerWindow(win, sourceNode = null) {
    this._hidePanelForNode(sourceNode);

    const existingWindow = this._getLoggerWindow();
    if (existingWindow) {
      this._registerLoggerWindow(existingWindow, win);
      this._syncLoggerWindow(existingWindow);
      existingWindow.focus();
      return;
    }

    const url = "chrome://browser/content/blocker/waterfoxBlockerLogger.xhtml";
    const dialogFeatures =
      "chrome,resizable,dialog=no,centerscreen,width=1100,height=760";
    const params = {
      browserId: this._getCurrentBrowserId(win),
      currentTabOnly: true,
      entries: WaterfoxBlockerService.getLoggerEntries(0),
      paused: WaterfoxBlockerService.isLoggerPaused(),
    };

    const loggerWin = win?.openDialog?.(
      url,
      "WaterfoxBlockerLogger",
      dialogFeatures,
      params
    );

    this._registerLoggerWindow(loggerWin, win);
  },

  _primeBlockedCountCache() {
    if (!Services.prefs.getBoolPref(PREF_ENABLED, true)) {
      return;
    }

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
    if (!browserId || !Services.prefs.getBoolPref(PREF_ENABLED, true)) {
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
    const activeEnabled =
      enabled ?? Services.prefs.getBoolPref(PREF_ENABLED, true);
    const excepted = host ? WaterfoxBlockerService.isSiteExcepted(host) : false;
    const cosmeticFilteringDisabled = host
      ? WaterfoxBlockerService.isCosmeticFilteringDisabled(host)
      : false;
    const remoteFontsDisabled = host
      ? WaterfoxBlockerService.isRemoteFontsDisabled(host)
      : false;
    const scriptingDisabled = host
      ? WaterfoxBlockerService.isScriptingDisabled(host)
      : false;
    const partnerBypass =
      activeEnabled &&
      protectable &&
      !excepted &&
      WaterfoxBlockerService.shouldBypassBlocking(host);

    return {
      activeEnabled,
      cosmeticFilteringDisabled,
      excepted,
      host,
      partnerBypass,
      protectable,
      remoteFontsDisabled,
      scriptingDisabled,
      siteBlockingEnabled:
        activeEnabled && protectable && !excepted && !partnerBypass,
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

    siteToggle.pressed = siteState.siteBlockingEnabled;
    siteToggle.disabled =
      !siteState.activeEnabled ||
      !siteState.protectable ||
      siteState.partnerBypass;
    setNodeL10nAttributes(doc, siteToggle, L10N_IDS.toggle);
  },

  _refreshBlockedCountLabel(doc, siteState, count) {
    const blockedCountLabel = doc.getElementById(PANEL_IDS.blockedCount);
    if (!blockedCountLabel) {
      return;
    }

    if (!siteState.activeEnabled) {
      setNodeL10nAttributes(doc, blockedCountLabel, L10N_IDS.disabled);
      return;
    }

    if (siteState.excepted) {
      setNodeL10nAttributes(doc, blockedCountLabel, L10N_IDS.siteExcepted);
      return;
    }

    if (siteState.partnerBypass) {
      setNodeL10nAttributes(doc, blockedCountLabel, L10N_IDS.partnerAllowed);
      return;
    }

    setNodeL10nAttributes(doc, blockedCountLabel, L10N_IDS.stats, {
      count,
    });
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
    this._refreshBlockedCountLabel(doc, siteState, count);

    const siteSwitchesDisabled =
      !siteState.activeEnabled ||
      !siteState.protectable ||
      siteState.excepted ||
      siteState.partnerBypass;

    this._refreshToolButton(
      doc,
      PANEL_IDS.cosmeticFilteringButton,
      siteSwitchesDisabled,
      siteState.cosmeticFilteringDisabled
        ? L10N_IDS.cosmeticFilteringEnable
        : L10N_IDS.cosmeticFilteringDisable
    );
    this._refreshToolButton(
      doc,
      PANEL_IDS.scriptingButton,
      siteSwitchesDisabled,
      siteState.scriptingDisabled
        ? L10N_IDS.scriptingEnable
        : L10N_IDS.scriptingDisable
    );
    this._refreshToolButton(
      doc,
      PANEL_IDS.remoteFontsButton,
      siteSwitchesDisabled,
      siteState.remoteFontsDisabled
        ? L10N_IDS.remoteFontsEnable
        : L10N_IDS.remoteFontsDisable
    );
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
    this._refreshToolButton(
      doc,
      PANEL_IDS.loggerButton,
      false,
      L10N_IDS.loggerButton
    );

    this._updateToolbarButtonForWindow(win, count, siteState.protectable);
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
    this._syncLoggerWindowsForSourceWindow(win);
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

  _setSiteExceptionForCurrentSite(win, disableForSite, sourceNode = null) {
    const host = this._getCurrentHost(win);
    if (!host) {
      this._refreshWindow(win);
      return;
    }

    if (disableForSite) {
      WaterfoxBlockerService.addSiteException(host);
    } else {
      WaterfoxBlockerService.removeSiteException(host);
    }

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
        doc.removeEventListener("command", state.onCommand, true);
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

    this._primeBlockedCountCache();

    this._forEachBrowserWindow(win => {
      this._hookBrowserWindow(win);
      this._refreshWindow(win);
    });
  },

  observe(subject, topic, data) {
    if (topic === "nsPref:changed") {
      if (String(data || "").startsWith(PREF_BRANCH)) {
        if (
          data === PREF_ENABLED &&
          !Services.prefs.getBoolPref(PREF_ENABLED, true)
        ) {
          this._blockedCountByBrowserId.clear();
        }
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
    } catch (_) {
      // Pref observer may already be removed.
    }

    this._forEachBrowserWindow(win => {
      this._unhookBrowserWindow(win);
    });

    for (const loggerWin of this._loggerWindows.keys()) {
      this._teardownLoggerWindow(loggerWin);
    }

    this._destroyWidget();
    this._blockedCountByBrowserId.clear();
    this._pickerActiveByBrowserId.clear();
    this._zapperActiveByBrowserId.clear();
  },
};
