/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WaterfoxBlockerService } from "resource:///modules/WaterfoxBlockerService.sys.mjs";
import { toSafeDomain } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";
import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
});

const PREF_BRANCH = "waterfox.blocker.";
const PREF_ENABLED = "waterfox.blocker.enabled";
const PREF_UI_ENABLED = "waterfox.blocker.ui.enabled";
const PREF_SHOW_BADGE = "waterfox.blocker.showBadge";

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "uiEnabled",
  PREF_UI_ENABLED,
  false
);
XPCOMUtils.defineLazyPreferenceGetter(lazy, "showBadge", PREF_SHOW_BADGE, true);
XPCOMUtils.defineLazyPreferenceGetter(lazy, "enabled", PREF_ENABLED, true);

const TOPIC_BLOCKED_COUNT_UPDATED = "WaterfoxBlocker:BlockedCountUpdated";
const TOPIC_BLOCKED_COUNTS_CLEARED = "WaterfoxBlocker:BlockedCountsCleared";
const TOPIC_CONTENT_BLOCKING_EVENT = "SiteProtection:ContentBlockingEvent";

const OBSERVED_TOPICS = [
  "browser-delayed-startup-finished",
  TOPIC_CONTENT_BLOCKING_EVENT,
  TOPIC_BLOCKED_COUNT_UPDATED,
  TOPIC_BLOCKED_COUNTS_CLEARED,
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
  settingsButton: "waterfox-blocker-settings-button",
  siteToggle: "waterfox-blocker-panel-site-toggle",
};

const L10N_IDS = {
  notAvailable: "waterfox-blocker-panel-not-available",
  disabled: "waterfox-blocker-panel-disabled",
  partnerAllowed: "waterfox-blocker-panel-partner-allowed",
  siteExcepted: "waterfox-blocker-panel-site-excepted",
  settingsButton: "waterfox-blocker-panel-settings-button",
  headerHost: "protections-header",
  stats: "waterfox-blocker-stats",
  toggle: "waterfox-blocker-panel-toggle",
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
  _initialized: false,
  _windowState: new WeakMap(),
  _styledWindows: new WeakSet(),

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
      return toSafeDomain(uri.asciiHost || uri.host || "");
    } catch (_) {
      // nsIURI.host throws for URI types without an authority component.
      return "";
    }
  },

  _getPanelNode(doc) {
    return doc?.getElementById(PANEL_IDS.panel) || null;
  },

  _handlePanelCommand(win, event) {
    if (event.target?.id !== PANEL_IDS.settingsButton) {
      return;
    }

    this._openBlockerPreferences(win, event.target);
    event.stopPropagation();
  },

  _handlePanelToggle(win, event) {
    if (event.target?.id !== PANEL_IDS.siteToggle) {
      return;
    }

    const pressed = !!event.target.pressed;
    this._setSiteExceptionForCurrentSite(win, !pressed, event.target);
    event.stopPropagation();
  },

  _handleTabOpen(win, event) {
    const newTab = event?.target;
    const gBrowser = win?.gBrowser;
    const newBrowserId =
      gBrowser?.getBrowserForTab?.(newTab)?.browsingContext?.top?.browserId ||
      0;
    const openerURI = newTab?.openerTab
      ? gBrowser.getBrowserForTab?.(newTab.openerTab)?.currentURI
      : null;
    if (
      !newBrowserId ||
      (!openerURI?.schemeIs("http") && !openerURI?.schemeIs("https"))
    ) {
      return;
    }

    WaterfoxBlockerService.recordNewTabSourceHost(
      newBrowserId,
      openerURI.asciiHost || openerURI.host
    );
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

    const onTabClose = () => {
      this._refreshWindow(win);
    };

    const onTabOpen = event => {
      this._handleTabOpen(win, event);
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
    tabContainer.addEventListener("TabOpen", onTabOpen);
    tabContainer.addEventListener("TabSelect", onTabSelect);
    tabContainer.addEventListener("TabClose", onTabClose);
    win.addEventListener("unload", onUnload, { once: true });

    this._windowState.set(win, {
      onCommand,
      onTabClose,
      onTabOpen,
      onTabSelect,
      onToggle,
      onUnload,
      progressListener,
    });
  },

  _isCurrentPageProtectable(win) {
    return !!this._getCurrentHost(win);
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

  _openToolbarPanel(win, event = null) {
    const doc = win?.document;
    if (!doc) {
      return;
    }

    this._injectPanelIntoWindow(win);
    this._refreshWindow(win);

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

  _readBlockedCount(browserId) {
    if (!browserId || !lazy.enabled) {
      return 0;
    }

    return Number(WaterfoxBlockerService.getBlockedCount(browserId) || 0);
  },

  _refreshAllWindows() {
    this._forEachBrowserWindow(win => {
      this._refreshWindow(win);
    });
  },

  _refreshPanelForWindow(win, blockedCount, enabled) {
    const doc = win?.document;
    if (!doc) {
      return;
    }

    const host = this._getCurrentHost(win);
    const protectable = this._isCurrentPageProtectable(win);
    const activeEnabled = enabled ?? lazy.enabled;
    const browserId = this._getCurrentBrowserId(win);
    const excepted = host ? WaterfoxBlockerService.isSiteExcepted(host) : false;
    const partnerBypass =
      activeEnabled &&
      protectable &&
      !excepted &&
      WaterfoxBlockerService.shouldBypassBlocking(host, browserId);
    const siteBlockingEnabled =
      activeEnabled && protectable && !excepted && !partnerBypass;

    const count =
      blockedCount !== undefined
        ? blockedCount
        : this._readBlockedCount(browserId);
    const visibleBadgeCount = siteBlockingEnabled ? count : 0;

    const header = doc.getElementById(PANEL_IDS.header);
    if (header) {
      setNodeL10nAttributes(
        doc,
        header,
        protectable && host ? L10N_IDS.headerHost : L10N_IDS.notAvailable,
        protectable && host ? { host } : undefined
      );
    }

    const siteToggle = doc.getElementById(PANEL_IDS.siteToggle);
    if (siteToggle) {
      siteToggle.pressed = siteBlockingEnabled;
      siteToggle.disabled = !activeEnabled || !protectable || partnerBypass;
      setNodeL10nAttributes(doc, siteToggle, L10N_IDS.toggle);
    }

    const blockedCountLabel = doc.getElementById(PANEL_IDS.blockedCount);
    if (blockedCountLabel) {
      if (!activeEnabled) {
        setNodeL10nAttributes(doc, blockedCountLabel, L10N_IDS.disabled);
      } else if (excepted) {
        setNodeL10nAttributes(doc, blockedCountLabel, L10N_IDS.siteExcepted);
      } else if (partnerBypass) {
        setNodeL10nAttributes(doc, blockedCountLabel, L10N_IDS.partnerAllowed);
      } else {
        setNodeL10nAttributes(doc, blockedCountLabel, L10N_IDS.stats, {
          count,
        });
      }
    }

    this._updateToolbarButtonForWindow(win, visibleBadgeCount, protectable);
  },

  _refreshWindow(win) {
    const browserId = this._getCurrentBrowserId(win);

    if (!win?.document) {
      return;
    }

    this._injectPanelIntoWindow(win);

    const blockedCount = this._readBlockedCount(browserId);

    this._refreshPanelForWindow(win, blockedCount, lazy.enabled);
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

    const browserId = this._getCurrentBrowserId(win);
    if (browserId) {
      WaterfoxBlockerService.resetBlockedCount(browserId);
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
          "TabOpen",
          state.onTabOpen
        );
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

    button.hidden = !lazy.uiEnabled;

    if (!lazy.uiEnabled) {
      button.removeAttribute("badge");
      button.removeAttribute("page-not-protectable");
      return;
    }

    button.setAttribute("badged", "true");

    if (lazy.showBadge && blockedCount > 0) {
      const badgeValue = String(blockedCount);
      button.setAttribute("badge", badgeValue);
    } else {
      button.removeAttribute("badge");
    }

    button.toggleAttribute("page-not-protectable", !protectable);
  },

  init() {
    if (this._initialized) {
      return;
    }

    this._initialized = true;

    for (const topic of OBSERVED_TOPICS) {
      Services.obs.addObserver(this, topic);
    }
    Services.prefs.addObserver(PREF_BRANCH, this);

    this._forEachBrowserWindow(win => {
      this._hookBrowserWindow(win);
      this._refreshWindow(win);
    });
  },

  observe(subject, topic, data) {
    if (topic === "nsPref:changed") {
      if (String(data || "").startsWith(PREF_BRANCH)) {
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
      case TOPIC_BLOCKED_COUNTS_CLEARED:
        this._refreshAllWindows();
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
      } catch (err) {
        console.warn(
          `[WaterfoxBlockerPanel] Failed to remove observer for ${topic}:`,
          err
        );
      }
    }

    try {
      Services.prefs.removeObserver(PREF_BRANCH, this);
    } catch (err) {
      console.warn(
        "[WaterfoxBlockerPanel] Failed to remove pref observer:",
        err
      );
    }

    this._forEachBrowserWindow(win => {
      this._unhookBrowserWindow(win);
    });
  },
};
