/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WaterfoxBrowserStyle } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBrowserStyle.sys.mjs"
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);

UrlbarTestUtils.init(this);

requestLongerTimeout(120);

const OUT = Services.env.get("WFX_SHOT_DIR");
const PREF_LIST = Services.env.get("WFX_SHOT_PREFS") || "";
const CAPTURE_ALL = PREF_LIST.trim().toLowerCase() == "all";
const PREFS = Array.from(
  new Set(
    PREF_LIST.split(",")
      .map(pref => pref.trim())
      .filter(pref => pref && pref.toLowerCase() != "all")
  )
);
const BASE = (Services.env.get("WFX_SHOT_BASE") || "nova").toLowerCase();
const PER_SHEET = Math.max(
  2,
  parseInt(Services.env.get("WFX_SHOT_ROWS") || "12", 10) || 12
);
const MIN_CAPTURE_HEIGHT = Math.max(
  0,
  parseInt(Services.env.get("WFX_SHOT_H") || "0", 10) || 0
);
const OS_CAPTURE_PAUSE_MS = Math.max(
  0,
  parseInt(Services.env.get("WFX_SHOT_OS_PAUSE_MS") || "0", 10) || 0
);
const CAPTURE_NATIVE_MENUS = Services.env.get("WFX_SHOT_NATIVE_MENUS") == "1";
const CAPTURE_TAB_CONTEXT_MENU =
  Services.env.get("WFX_SHOT_TAB_CONTEXT_MENU") == "1";
const LABEL_HEIGHT = 22;
const SHEET = "chrome://browser/skin/userChrome.css";
const STYLE_PREF = "browser.theme.waterfox.browserStyle";
const NOVA_PREF = "browser.nova.enabled";
const AUTOHIDE_SETTLE_MS = 1100;
const VISUAL_SETTLE_MS = 350;
const AUDIT_PAGE = "about:robots";
const TRANSPARENCY_AUDIT_PAGE =
  "data:text/html,<style>html{min-height:100%;background:repeating-linear-gradient(135deg,%236c5ce7 0 40px,%2300cec9 40px 80px)}</style>";
const AUDIT_URLBAR_QUERY = "waterfox audit";
const TAB_ICON = "chrome://branding/content/icon32.png";
const SIDEBAR_PROMO_PREF = "sidebar.verticalTabs.dragToPinPromo.dismissed";

const PRIVATE_PREFS = new Set([
  "userChrome.hidden.private_indicator",
  "userChrome.theme.private",
]);

const REOPEN_SURFACE_PREFS = new Set([
  "userChrome.icon.context_menu",
  "userChrome.rounding.square_menupopup",
  "userChrome.rounding.square_panel",
  "userChrome.theme.non_native_menu",
  "userChrome.theme.transparent.menu",
  "userChrome.theme.transparent.panel",
]);

const EXPLICIT_PREREQUISITES = new Map([
  ["userChrome.autohide.fill_urlbar", [["userChrome.tabbar.one_liner", true]]],
  [
    "userChrome.combined.urlbar_with_reload",
    [["userChrome.combined.urlbar.reload_button", true]],
  ],
  [
    "userChrome.autohide.toolbar_overlap",
    [["userChrome.autohide.navbar", true]],
  ],
  ["userChrome.autohide.tab.blur", [["userChrome.autohide.tab", true]]],
  ["userChrome.autohide.tab.opacity", [["userChrome.autohide.tab", true]]],
  ["userChrome.centered.tab.label", [["userChrome.centered.tab", true]]],
  [
    "userChrome.combined.nav_button.home_button",
    [["userChrome.combined.nav_button", true]],
  ],
  [
    "userChrome.combined.sub_button.as_normal",
    [["userChrome.combined.nav_button", true]],
  ],
  [
    "userChrome.combined.sub_button.none_background",
    [
      ["userChrome.combined.nav_button", true],
      ["userChrome.combined.sub_button.as_normal", false],
    ],
  ],
  [
    "userChrome.compatibility.covered_header_image",
    [["userChrome.compatibility.theme", true]],
  ],
  [
    "userChrome.compatibility.os.win11",
    [
      ["userChrome.compatibility.os", true],
      ["userChrome.theme.system_default", true],
    ],
  ],
  [
    "userChrome.compatibility.os.windows_maximized",
    [["userChrome.compatibility.os", true]],
  ],
  [
    "userChrome.decoration.disable_sidebar_animate",
    [["userChrome.decoration.animate", true]],
  ],
  ["userChrome.hidden.tab_icon.always", [["userChrome.hidden.tab_icon", true]]],
  [
    "userChrome.hidden.urlbar_iconbox.label_only",
    [["userChrome.hidden.urlbar_iconbox", true]],
  ],
  [
    "userChrome.icon.account_image_to_right",
    [
      ["userChrome.icon.disabled", false],
      ["userChrome.icon.panel", true],
    ],
  ],
  [
    "userChrome.icon.account_label_to_right",
    [
      ["userChrome.icon.disabled", false],
      ["userChrome.icon.panel", true],
    ],
  ],
  [
    "userChrome.icon.context_menu",
    [
      ["userChrome.icon.disabled", false],
      ["userChrome.icon.menu", true],
    ],
  ],
  ["userChrome.icon.menu", [["userChrome.icon.disabled", false]]],
  [
    "userChrome.icon.menu.full",
    [
      ["userChrome.icon.disabled", false],
      ["userChrome.icon.menu", true],
    ],
  ],
  ["userChrome.icon.panel", [["userChrome.icon.disabled", false]]],
  [
    "userChrome.icon.panel_full",
    [
      ["userChrome.icon.disabled", false],
      ["userChrome.icon.panel", true],
      ["userChrome.icon.panel_photon", false],
    ],
  ],
  [
    "userChrome.icon.panel_photon",
    [
      ["userChrome.icon.disabled", false],
      ["userChrome.icon.panel", true],
      ["userChrome.icon.panel_full", false],
    ],
  ],
  [
    "userChrome.icon.global_menu.mac",
    [
      ["userChrome.icon.disabled", false],
      ["userChrome.icon.global_menu", true],
    ],
  ],
  [
    "userChrome.padding.bookmark_menu.compact",
    [["userChrome.padding.bookmark_menu", true]],
  ],
  [
    "userChrome.padding.drag_space.maximized",
    [["userChrome.padding.drag_space", true]],
  ],
  [
    "userChrome.padding.first_tab.always",
    [["userChrome.padding.first_tab", true]],
  ],
  ["userChrome.padding.menu_compact", [["userChrome.padding.menu", true]]],
  [
    "userChrome.padding.toolbar_button.compact",
    [["userChrome.padding.toolbar_button", true]],
  ],
  [
    "userChrome.tab.close_button_at_hover.always",
    [["userChrome.tab.close_button_at_hover", true]],
  ],
  [
    "userChrome.tab.close_button_at_hover.with_selected",
    [["userChrome.tab.close_button_at_hover", true]],
  ],
  [
    "userChrome.tab.close_button_at_pinned.always",
    [
      ["userChrome.tab.close_button_at_pinned", true],
      ["userChrome.tabbar.as_titlebar", false],
    ],
  ],
  [
    "userChrome.tab.close_button_at_pinned.background",
    [
      ["userChrome.tab.close_button_at_pinned", true],
      ["userChrome.tabbar.as_titlebar", false],
    ],
  ],
  [
    "userChrome.tab.container.always_long",
    [
      ["userChrome.tab.container", true],
      ["userChrome.tabbar.as_titlebar", false],
    ],
  ],
  [
    "userChrome.tab.container.on_top",
    [
      ["userChrome.tab.container", true],
      ["userChrome.tabbar.as_titlebar", false],
    ],
  ],
  [
    "userChrome.tab.sound_with_favicons.on_center",
    [["userChrome.tab.sound_with_favicons", true]],
  ],
  [
    "userChrome.tab.dynamic_separator",
    [
      ["userChrome.tab.static_separator", false],
      ["userChrome.tab.bar_separator", false],
    ],
  ],
  [
    "userChrome.tab.static_separator",
    [
      ["userChrome.tab.dynamic_separator", false],
      ["userChrome.tab.bar_separator", false],
    ],
  ],
  [
    "userChrome.tab.static_separator.selected_accent",
    [
      ["userChrome.tab.dynamic_separator", false],
      ["userChrome.tab.static_separator", true],
      ["userChrome.tab.bar_separator", false],
    ],
  ],
  [
    "userChrome.tab.bar_separator",
    [
      ["userChrome.tab.dynamic_separator", false],
      ["userChrome.tab.static_separator", false],
    ],
  ],
  [
    "userChrome.tabbar.on_bottom.above_bookmark",
    [["userChrome.tabbar.on_bottom", true]],
  ],
  [
    "userChrome.tabbar.on_bottom.hidden_single_tab",
    [["userChrome.tabbar.on_bottom", true]],
  ],
  [
    "userChrome.tabbar.on_bottom.menubar_on_top",
    [["userChrome.tabbar.on_bottom", true]],
  ],
  [
    "userChrome.tabbar.one_liner.combine_navbar",
    [["userChrome.tabbar.one_liner", true]],
  ],
  [
    "userChrome.tabbar.one_liner.responsive",
    [["userChrome.tabbar.one_liner", true]],
  ],
  [
    "userChrome.tabbar.one_liner.tabbar_first",
    [["userChrome.tabbar.one_liner", true]],
  ],
  [
    "userChrome.theme.proton_color.dark_blue_accent",
    [["userChrome.theme.proton_color", true]],
  ],
  [
    "userChrome.urlbar.iconbox_with_separator",
    [
      ["userChrome.hidden.urlbar_iconbox", true],
      ["userChrome.hidden.urlbar_iconbox.label_only", true],
    ],
  ],
]);

if (Services.appinfo.OS == "Darwin") {
  for (let pref of [
    "userChrome.padding.menu",
    "userChrome.padding.menu_compact",
    "userChrome.rounding.square_menuitem",
    "userChrome.rounding.square_menupopup",
    "userChrome.theme.transparent.menu",
  ]) {
    EXPLICIT_PREREQUISITES.set(pref, [
      ["userChrome.theme.non_native_menu", true],
    ]);
  }
}

for (let variant of [
  "all",
  "australis",
  "chrome",
  "chrome_legacy",
  "edge",
  "wave",
]) {
  EXPLICIT_PREREQUISITES.set(
    `userChrome.tab.bottom_rounded_corner.${variant}`,
    [["userChrome.tab.bottom_rounded_corner", true]]
  );
}

function settle(win) {
  return new Promise(resolve =>
    win.requestAnimationFrame(() => win.requestAnimationFrame(resolve))
  );
}

async function idleChrome(win) {
  const browser = win.gBrowser.selectedBrowser;
  await SimpleTest.promiseFocus(browser);
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "body",
    { type: "mousemove" },
    browser
  );
  await new Promise(resolve => win.setTimeout(resolve, AUTOHIDE_SETTLE_MS));
  await settle(win);
}

async function settleVisual(win, pref) {
  const delay =
    pref.startsWith("userChrome.autohide.") ||
    pref == "userChrome.navbar.as_sidebar"
      ? AUTOHIDE_SETTLE_MS
      : VISUAL_SETTLE_MS;
  await new Promise(resolve => win.setTimeout(resolve, delay));
  await settle(win);
}

function snapshotPrefs(prefNames) {
  const defaults = Services.prefs.getDefaultBranch("");
  return Array.from(new Set(prefNames), pref => {
    const hadValue = Services.prefs.prefHasUserValue(pref);
    const type = Services.prefs.getPrefType(pref);
    const defaultType = defaults.getPrefType(pref);
    let value;
    let defaultValue;
    let hasDefault = false;
    if (hadValue) {
      if (type == Ci.nsIPrefBranch.PREF_BOOL) {
        value = Services.prefs.getBoolPref(pref);
      } else if (type == Ci.nsIPrefBranch.PREF_INT) {
        value = Services.prefs.getIntPref(pref);
      } else if (type == Ci.nsIPrefBranch.PREF_STRING) {
        value = Services.prefs.getStringPref(pref);
      }
    }
    try {
      if (defaultType == Ci.nsIPrefBranch.PREF_BOOL) {
        defaultValue = defaults.getBoolPref(pref);
      } else if (defaultType == Ci.nsIPrefBranch.PREF_INT) {
        defaultValue = defaults.getIntPref(pref);
      } else if (defaultType == Ci.nsIPrefBranch.PREF_STRING) {
        defaultValue = defaults.getStringPref(pref);
      }
      hasDefault = defaultType != Ci.nsIPrefBranch.PREF_INVALID;
    } catch (_error) {}
    return {
      pref,
      hadValue,
      type,
      value,
      hasDefault,
      defaultType,
      defaultValue,
    };
  });
}

function restorePrefs(states) {
  const defaults = Services.prefs.getDefaultBranch("");
  for (let state of states.toReversed()) {
    const {
      pref,
      hadValue,
      type,
      value,
      hasDefault,
      defaultType,
      defaultValue,
    } = state;
    if (hasDefault && defaultType == Ci.nsIPrefBranch.PREF_BOOL) {
      defaults.setBoolPref(pref, defaultValue);
    } else if (hasDefault && defaultType == Ci.nsIPrefBranch.PREF_INT) {
      defaults.setIntPref(pref, defaultValue);
    } else if (hasDefault && defaultType == Ci.nsIPrefBranch.PREF_STRING) {
      defaults.setStringPref(pref, defaultValue);
    }
    if (!hadValue && Services.prefs.prefHasUserValue(pref)) {
      Services.prefs.clearUserPref(pref);
    } else if (hadValue && type == Ci.nsIPrefBranch.PREF_BOOL) {
      Services.prefs.setBoolPref(pref, value);
    } else if (hadValue && type == Ci.nsIPrefBranch.PREF_INT) {
      Services.prefs.setIntPref(pref, value);
    } else if (hadValue && type == Ci.nsIPrefBranch.PREF_STRING) {
      Services.prefs.setStringPref(pref, value);
    }
  }
}

function collectPrerequisites(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const prerequisites = new Map();
  const stack = [];
  let depth = 0;
  const gate = /@media([^{]*?)\{|\{|\}/g;
  let match;
  while ((match = gate.exec(text))) {
    if (match[0] == "}") {
      depth--;
      while (stack.length && stack[stack.length - 1].depth > depth) {
        stack.pop();
      }
      continue;
    }
    if (match[0] == "{") {
      depth++;
      continue;
    }

    const alternatives = /\s+or\s+/.test(match[1]);
    const gates = Array.from(
      match[1].matchAll(/(not\s+)?-moz-pref\("([^"]+)"\)/g),
      prefMatch => [prefMatch[2], !prefMatch[1]]
    ).filter(([pref]) => pref.startsWith("userChrome."));
    for (let [pref] of gates) {
      const candidate = new Map();
      for (let open of stack) {
        if (open.alternatives) {
          continue;
        }
        for (let requirement of open.gates) {
          candidate.set(...requirement);
        }
      }
      if (!alternatives) {
        for (let [peer, value] of gates) {
          if (peer != pref) {
            candidate.set(peer, value);
          }
        }
      }
      candidate.delete(pref);
      const current = prerequisites.get(pref);
      if (!current || candidate.size < current.size) {
        prerequisites.set(pref, candidate);
      }
    }
    depth++;
    stack.push({ depth, gates, alternatives });
  }
  return prerequisites;
}

function addExplicitPrerequisites(prerequisites) {
  for (let [pref, explicit] of EXPLICIT_PREREQUISITES) {
    prerequisites.set(pref, new Map(explicit));
  }
  return prerequisites;
}

function waitForPopup(popup, eventName) {
  return BrowserTestUtils.waitForEvent(
    popup,
    eventName,
    false,
    event => event.target == popup
  );
}

async function hidePopup(popup, hide) {
  if (popup.state == "closed") {
    return;
  }
  const hidden = waitForPopup(popup, "popuphidden");
  hide();
  await hidden;
}

function surfaceForPref(pref) {
  if (pref == "userChrome.decoration.download_panel") {
    return "downloads";
  }
  if (
    pref == "userChrome.counter.bookmark_menu" ||
    pref.startsWith("userChrome.padding.bookmark_menu")
  ) {
    return "bookmarks-menu";
  }
  if (
    pref.startsWith("userChrome.urlView.") ||
    pref.startsWith("userChrome.padding.urlView") ||
    pref == "userChrome.rounding.square_urlView_item"
  ) {
    return "urlbar";
  }
  if (
    pref == "userChrome.hidden.disabled_menu" ||
    pref == "userChrome.icon.context_menu" ||
    pref == "userChrome.icon.menu" ||
    pref == "userChrome.icon.menu.full" ||
    pref == "userChrome.padding.menu" ||
    pref == "userChrome.padding.menu_compact" ||
    pref == "userChrome.rounding.square_menuitem" ||
    pref == "userChrome.rounding.square_menupopup" ||
    pref == "userChrome.theme.non_native_menu" ||
    pref == "userChrome.theme.transparent.menu"
  ) {
    return "context-menu";
  }
  if (pref == "userChrome.panel.full_width_padding") {
    return "app-subview";
  }

  if (
    pref == "userChrome.icon.account_image_to_right" ||
    pref == "userChrome.icon.account_label_to_right"
  ) {
    return "account-subview";
  }
  if (
    pref.includes("panel") ||
    pref == "userChrome.icon.disabled" ||
    pref == "userChrome.icon.1-25px_stroke"
  ) {
    return "app-menu";
  }
  return null;
}

async function openSurface(win, surface) {
  if (!surface) {
    return async () => {};
  }

  if (surface == "urlbar") {
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window: win,
      value: AUDIT_URLBAR_QUERY,
      fireInputEvent: false,
    });
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
    await settle(win);
    return () =>
      UrlbarTestUtils.promisePopupClose(win, () => {
        win.gURLBar.handleRevert();
        win.gURLBar.blur();
      });
  }

  if (surface == "account-subview") {
    await win.PanelUI.showSubView("PanelUI-fxa", win.PanelUI.menuButton);
    const popup = win.document.getElementById("customizationui-widget-panel");
    if (!popup) {
      throw new Error("FxA account subview did not open");
    }
    await settle(win);
    return () => hidePopup(popup, () => popup.hidePopup());
  }

  let popup;
  let show;
  let hide;
  if (surface == "downloads") {
    popup = win.DownloadsPanel.panel;
    show = () => win.DownloadsPanel.showPanel();
    hide = () => win.DownloadsPanel.hidePanel();
  } else if (surface == "context-menu") {
    if (CAPTURE_TAB_CONTEXT_MENU) {
      popup = win.document.getElementById("tabContextMenu");
      show = () =>
        EventUtils.synthesizeMouseAtCenter(
          win.gBrowser.selectedTab,
          { type: "contextmenu" },
          win
        );
    } else {
      popup = win.document.getElementById("contentAreaContextMenu");
      show = () =>
        BrowserTestUtils.synthesizeMouseAtCenter(
          "body",
          { type: "contextmenu", button: 2 },
          win.gBrowser.selectedBrowser
        );
    }
    hide = () => popup.hidePopup();
  } else if (surface == "bookmarks-menu") {
    popup = win.document.getElementById("BMB_bookmarksPopup");
    const button = win.document.getElementById("bookmarks-menu-button");
    show = () => popup.openPopup(button, "after_start");
    hide = () => popup.hidePopup();
  } else {
    popup = win.document.getElementById("appMenu-popup");
    show = () => win.PanelUI.show();
    hide = () => win.PanelUI.hide();
  }

  const shown = waitForPopup(popup, "popupshown");
  await show();
  await shown;
  if (surface == "app-subview") {
    win.document.getElementById("appMenu-bookmarks-button").click();
    const view = win.document.getElementById("PanelUI-bookmarks");
    await BrowserTestUtils.waitForEvent(view, "ViewShown");
  }
  await settle(win);
  return () => hidePopup(popup, hide);
}

function needsTabState(pref) {
  return (
    pref.includes(".tab") &&
    pref != "userChrome.tabbar.on_bottom.hidden_single_tab"
  );
}

async function addAuditTab(gBrowser, label, options = {}) {
  const url = `data:text/html,<title>${encodeURIComponent(label)}</title>`;
  const tab = BrowserTestUtils.addTab(gBrowser, url, options);
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
  tab.setAttribute("label", label);
  tab.setAttribute("data-waterfox-audit-state", label);
  return tab;
}

async function addTabState(win) {
  const { gBrowser } = win;
  const tabs = [];

  const faviconTab = await addAuditTab(gBrowser, "Favicon tab");
  tabs.push(faviconTab);

  const audioTab = await addAuditTab(gBrowser, "Audio tab");
  tabs.push(audioTab);

  const containerTab = await addAuditTab(gBrowser, "Container tab", {
    userContextId: 1,
  });
  tabs.push(containerTab);

  const pendingTab = await addAuditTab(gBrowser, "Unloaded tab");
  tabs.push(pendingTab);

  const crashedTab = await addAuditTab(gBrowser, "Crashed tab");
  tabs.push(crashedTab);

  const pipTab = await addAuditTab(gBrowser, "Picture-in-picture tab");
  tabs.push(pipTab);

  await settle(win);
  for (const tab of [faviconTab, audioTab, containerTab, crashedTab]) {
    gBrowser.setIcon(tab, TAB_ICON);
  }
  gBrowser.pinTab(faviconTab);
  audioTab.setAttribute("soundplaying", "true");
  pendingTab.setAttribute("pending", "true");
  crashedTab.setAttribute("crashed", "true");
  pipTab.setAttribute("pictureinpicture", "true");
  gBrowser.addToMultiSelectedTabs(audioTab);
  await settle(win);
  return async () => {
    for (let tab of tabs.toReversed()) {
      if (tab.isConnected) {
        BrowserTestUtils.removeTab(tab);
      }
    }
  };
}

function ensureNavbarWidget(widgetId) {
  const placement = CustomizableUI.getPlacementOfWidget(widgetId);
  if (placement?.area == CustomizableUI.AREA_NAVBAR) {
    return () => {};
  }

  CustomizableUI.addWidgetToArea(widgetId, CustomizableUI.AREA_NAVBAR);
  return () => {
    if (placement) {
      CustomizableUI.addWidgetToArea(
        widgetId,
        placement.area,
        placement.position
      );
    } else {
      CustomizableUI.removeWidgetFromArea(widgetId);
    }
  };
}

async function addNotificationState(win) {
  const box = win.gBrowser.getNotificationBox(win.gBrowser.selectedBrowser);
  const notification = await box.appendNotification(
    "waterfox-appearance-audit",
    {
      label: "Waterfox appearance audit",
      priority: box.PRIORITY_INFO_HIGH,
    }
  );
  await settle(win);
  return () => notification.close();
}

async function addBookmarkState(win, needsMenu, needsMultiRow) {
  const undo = [];
  const wasToolbarVisible = !win.PersonalToolbar.collapsed;
  win.setToolbarVisibility(win.PersonalToolbar, true);
  undo.push(() =>
    win.setToolbarVisibility(win.PersonalToolbar, wasToolbarVisible)
  );

  const toolbarBookmarks = [
    await PlacesUtils.bookmarks.insert({
      parentGuid: PlacesUtils.bookmarks.toolbarGuid,
      title: "Waterfox toolbar audit",
      url: "https://example.com/waterfox-toolbar-audit",
    }),
  ];
  if (needsMultiRow) {
    for (let index = 1; index <= 12; index++) {
      toolbarBookmarks.push(
        await PlacesUtils.bookmarks.insert({
          parentGuid: PlacesUtils.bookmarks.toolbarGuid,
          title: `Waterfox audit bookmark ${index}`,
          url: `https://example.com/waterfox-toolbar-audit-${index}`,
        })
      );
    }
  }

  const menuFolder = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.menuGuid,
    title: "Waterfox menu audit",
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
  });
  if (needsMenu) {
    for (let index = 1; index <= 3; index++) {
      await PlacesUtils.bookmarks.insert({
        parentGuid: menuFolder.guid,
        title: `Waterfox menu item ${index}`,
        url: `https://example.com/waterfox-menu-audit-${index}`,
      });
    }
  }
  undo.push(async () => {
    await PlacesUtils.bookmarks.remove(menuFolder.guid);
    for (const bookmark of toolbarBookmarks.toReversed()) {
      await PlacesUtils.bookmarks.remove(bookmark.guid);
    }
  });
  await TestUtils.waitForCondition(
    () => win.document.querySelector("#PlacesToolbarItems .bookmark-item"),
    "The audit bookmark should appear on the toolbar"
  );

  if (needsMenu) {
    const placement = CustomizableUI.getPlacementOfWidget(
      "bookmarks-menu-button"
    );
    if (placement?.area != CustomizableUI.AREA_NAVBAR) {
      CustomizableUI.addWidgetToArea(
        "bookmarks-menu-button",
        CustomizableUI.AREA_NAVBAR,
        0
      );
      undo.push(() => {
        if (placement) {
          CustomizableUI.addWidgetToArea(
            "bookmarks-menu-button",
            placement.area,
            placement.position
          );
        } else {
          CustomizableUI.removeWidgetFromArea("bookmarks-menu-button");
        }
      });
    }
    await settle(win);
  }

  return async () => {
    for (let cleanup of undo.toReversed()) {
      await cleanup();
    }
  };
}

async function prepareCaptureState(win, pref) {
  const undo = [];
  const surface = surfaceForPref(pref);

  if (
    Services.appinfo.OS == "Darwin" &&
    !CAPTURE_NATIVE_MENUS &&
    (surface == "context-menu" || surface == "bookmarks-menu")
  ) {
    const nativeMenus = snapshotPrefs(["widget.macos.native-context-menus"]);
    Services.prefs.setBoolPref("widget.macos.native-context-menus", false);
    undo.push(() => restorePrefs(nativeMenus));
  }

  if (
    pref == "userChrome.hidden.urlbar_iconbox" ||
    pref == "userChrome.hidden.urlbar_iconbox.label_only" ||
    pref == "userChrome.urlbar.iconbox_with_separator"
  ) {
    const originalTab = win.gBrowser.selectedTab;
    const auditTab = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      AUDIT_PAGE
    );
    undo.push(async () => {
      if (originalTab.isConnected) {
        win.gBrowser.selectedTab = originalTab;
      }
      if (auditTab.isConnected) {
        BrowserTestUtils.removeTab(auditTab);
      }
    });
  }

  if (
    pref == "userChrome.theme.transparent.menu" ||
    pref == "userChrome.theme.transparent.panel"
  ) {
    const originalTab = win.gBrowser.selectedTab;
    const auditTab = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      TRANSPARENCY_AUDIT_PAGE
    );
    undo.push(() => {
      if (originalTab.isConnected) {
        win.gBrowser.selectedTab = originalTab;
      }
      if (auditTab.isConnected) {
        BrowserTestUtils.removeTab(auditTab);
      }
    });
  }

  if (pref.includes("home_button")) {
    undo.push(ensureNavbarWidget("home-button"));
  }

  if (needsTabState(pref)) {
    undo.push(await addTabState(win));
    if (pref.startsWith("userChrome.tab.close_button_at_pinned")) {
      const selectedTab = win.gBrowser.selectedTab;
      win.gBrowser.selectedTab = win.document.querySelector(
        ".tabbrowser-tab[pinned]"
      );
      undo.push(() => {
        if (selectedTab.isConnected) {
          win.gBrowser.selectedTab = selectedTab;
        }
      });
    }
  }

  if (pref == "userChrome.urlView.move_icon_to_left") {
    const bookmark = await PlacesUtils.bookmarks.insert({
      parentGuid: PlacesUtils.bookmarks.unfiledGuid,
      title: AUDIT_URLBAR_QUERY,
      url: "https://example.com/waterfox-audit",
    });
    undo.push(() => PlacesUtils.bookmarks.remove(bookmark.guid));
  }

  const bookmarksMenu =
    pref == "userChrome.counter.bookmark_menu" ||
    pref.startsWith("userChrome.padding.bookmark_menu");
  if (bookmarksMenu || pref.includes("bookmarkbar")) {
    undo.push(
      await addBookmarkState(
        win,
        bookmarksMenu,
        pref == "userChrome.bookmarkbar.multi_row"
      )
    );
  }

  if (pref.includes("sidebar") || pref == "userChrome.navbar.as_sidebar") {
    const sidebarPromo = snapshotPrefs([SIDEBAR_PROMO_PREF]);
    Services.prefs.setBoolPref(SIDEBAR_PROMO_PREF, true);
    undo.push(() => restorePrefs(sidebarPromo));

    const wasOpen = win.SidebarController.isOpen;
    const previousSidebar = win.SidebarController.currentID;
    await win.SidebarController.show("viewBookmarksSidebar");
    undo.push(async () => {
      if (wasOpen && previousSidebar) {
        await win.SidebarController.show(previousSidebar);
      } else {
        win.SidebarController.hide();
      }
    });
  }

  if (
    pref == "userChrome.autohide.infobar" ||
    pref == "userChrome.padding.infobar"
  ) {
    undo.push(await addNotificationState(win));
  }

  if (pref == "userChrome.findbar.floating_on_top") {
    await win.gFindBarPromise;
    const wasOpen = !win.gFindBar.hidden;
    win.gFindBar.open();
    undo.push(() => {
      if (!wasOpen) {
        win.gFindBar.close();
      }
    });
  }

  if (
    pref == "userChrome.icon.global_menu" ||
    pref == "userChrome.icon.global_menu.mac" ||
    pref == "userChrome.icon.global_menubar" ||
    pref == "userChrome.padding.global_menubar" ||
    pref == "userChrome.tabbar.on_bottom.menubar_on_top"
  ) {
    const menubar = win.document.getElementById("toolbar-menubar");
    const wasAutohide = menubar.getAttribute("autohide");
    menubar.removeAttribute("autohide");
    undo.push(() => {
      if (wasAutohide === null) {
        menubar.removeAttribute("autohide");
      } else {
        menubar.setAttribute("autohide", wasAutohide);
      }
    });
  }

  try {
    await idleChrome(win);
    undo.push(await openSurface(win, surface));
    let hoveredItem;
    if (pref == "userChrome.rounding.square_panelitem") {
      hoveredItem = win.document.querySelector(
        "#appMenu-popup panelview[visible] .subviewbutton:not([disabled], [hidden])"
      );
    } else if (pref == "userChrome.rounding.square_menuitem") {
      hoveredItem = win.document.querySelector(
        "#contentAreaContextMenu > menuitem:not([disabled], [hidden])"
      );
    }
    if (hoveredItem) {
      EventUtils.synthesizeMouseAtCenter(
        hoveredItem,
        { type: "mousemove" },
        win
      );
      await settle(win);
    }
  } catch (error) {
    for (let cleanup of undo.toReversed()) {
      await cleanup();
    }
    throw error;
  }
  return async () => {
    for (let cleanup of undo.toReversed()) {
      await cleanup();
    }
  };
}

function isRendered(win, element) {
  for (let current = element; current; current = current.parentElement) {
    const style = win.getComputedStyle(current);
    if (
      style.display == "none" ||
      style.visibility == "hidden" ||
      style.visibility == "collapse" ||
      style.contentVisibility == "hidden" ||
      parseFloat(style.opacity) <= 0.01
    ) {
      return false;
    }
  }
  return true;
}

function strip(win) {
  const width = Math.ceil(win.innerWidth);
  const toolbox = win.document.getElementById("navigator-toolbox");
  let captureBottom = Math.ceil(toolbox.getBoundingClientRect().bottom) + 24;
  for (let selector of [
    "#appMenu-popup",
    "#downloadsPanel",
    "#contentAreaContextMenu",
    "#BMB_bookmarksPopup",
    ".urlbarView",
    "#sidebar-box:not([hidden='true'])",
    "findbar:not([hidden])",
  ]) {
    for (let element of win.document.querySelectorAll(selector)) {
      const rect = element.getBoundingClientRect();
      if (isRendered(win, element) && rect.width > 0 && rect.height > 0) {
        captureBottom = Math.max(captureBottom, Math.ceil(rect.bottom) + 12);
      }
    }
  }
  const height = Math.max(
    1,
    Math.min(
      Math.ceil(win.innerHeight),
      Math.max(captureBottom, MIN_CAPTURE_HEIGHT)
    )
  );
  const canvas = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawWindow(win, 0, 0, width, height, "white");
  return canvas;
}

function elementName(element) {
  const classes = element.getAttribute?.("class")?.trim();
  return element.id || classes || element.localName;
}

function rectText(rect) {
  return (
    `x=${Math.round(rect.left)} y=${Math.round(rect.top)} ` +
    `w=${Math.round(rect.width)} h=${Math.round(rect.height)}`
  );
}

function logRects(win, label) {
  const root = win.document.documentElement;
  const rootStyle = win.getComputedStyle(root);
  info(
    `ROOT [${label}] attrs=${Array.from(root.attributes, attr => `${attr.name}=${attr.value}`).join(" ")} ` +
      `lwt-accent=${rootStyle.getPropertyValue("--lwt-accent-color").trim()} ` +
      `toolbar-bg=${rootStyle.getPropertyValue("--toolbar-bgcolor").trim()} ` +
      `toolbar-background=${rootStyle.getPropertyValue("--toolbar-background-color").trim()} ` +
      `toolbox-background=${rootStyle.getPropertyValue("--toolbox-background-color").trim()}`
  );
  const browser = win.document.getElementById("browser");
  const browserStyle = win.getComputedStyle(browser);
  info(
    `RECT [${label}] browser ${rectText(browser.getBoundingClientRect())} ` +
      `launcher-width=${browserStyle.getPropertyValue("--sidebar-launcher-collapsed-width").trim()}`
  );
  for (let id of [
    "sidebar-container",
    "sidebar-box",
    "sidebar-header",
    "sidebar",
    "tabbrowser-tabbox",
    "urlbar-container",
    "urlbar",
    "stop-reload-button",
    "reload-button",
    "stop-button",
  ]) {
    const element = win.document.getElementById(id);
    const style = win.getComputedStyle(element);
    info(
      `RECT [${label}] ${id} ${rectText(element.getBoundingClientRect())} ` +
        `margin=${style.marginInlineStart}/${style.marginInlineEnd} ` +
        `padding=${style.paddingInlineStart}/${style.paddingInlineEnd} ` +
        `display=${style.display} visibility=${style.visibility} ` +
        `opacity=${style.opacity} z=${style.zIndex} ` +
        `color=${style.color} fill=${style.fill}`
    );
  }

  for (const selector of [
    "#reload-button > .toolbarbutton-icon",
    "#reload-button > .toolbarbutton-animatable-box",
  ]) {
    const element = win.document.querySelector(selector);
    const style = win.getComputedStyle(element);
    info(
      `RECT [${label}] ${selector} ${rectText(element.getBoundingClientRect())} ` +
        `display=${style.display} opacity=${style.opacity} z=${style.zIndex} ` +
        `fill=${style.fill} image=${style.listStyleImage}`
    );
  }

  const nav = win.document.getElementById("nav-bar");
  info(`RECT [${label}] nav-bar ${rectText(nav.getBoundingClientRect())}`);
  for (let child of nav.children) {
    const rect = child.getBoundingClientRect();
    if (rect.width >= 1) {
      info(`RECT [${label}] nav child ${elementName(child)} ${rectText(rect)}`);
    }
  }

  const tab = win.document.querySelector(".tabbrowser-tab");
  if (!tab) {
    return;
  }
  const selectedTab = win.document.querySelector(
    ".tabbrowser-tab[visuallyselected]"
  );
  for (const selector of [
    ".tab-background",
    ".tab-content",
    ".tab-label-container",
    ".tab-close-button",
  ]) {
    const element = selectedTab?.querySelector(selector);
    if (element) {
      info(
        `RECT [${label}] selected ${selector} ${rectText(element.getBoundingClientRect())}`
      );
    }
  }
  const tabRect = tab.getBoundingClientRect();
  info(`RECT [${label}] first tab ${rectText(tabRect)}`);

  for (const stateTab of win.document.querySelectorAll(
    ".tabbrowser-tab[data-waterfox-audit-state]"
  )) {
    info(
      `STATE [${label}] tab label=${stateTab.label} ` +
        `attrs=${Array.from(stateTab.attributes, attr => `${attr.name}=${attr.value}`).join(" ")}`
    );
    for (const selector of [
      ".tab-icon-image",
      ".tab-icon-overlay",
      ".tab-audio-button",
    ]) {
      const element = stateTab.querySelector(selector);
      const style = win.getComputedStyle(element);
      info(
        `STATE [${label}] ${selector} ${rectText(element.getBoundingClientRect())} ` +
          `attrs=${Array.from(element.attributes, attr => `${attr.name}=${attr.value}`).join(" ")} ` +
          `display=${style.display} opacity=${style.opacity} transform=${style.transform} ` +
          `image=${style.listStyleImage}`
      );
    }
  }

  const stack = tab.querySelector(".tab-stack");
  const beforeStyle = win.getComputedStyle(stack, "::before");
  info(
    `PSEUDO [${label}] .tab-stack::before content=${beforeStyle.content} ` +
      `display=${beforeStyle.display} position=${beforeStyle.position} ` +
      `left=${beforeStyle.left} width=${beforeStyle.width} height=${beforeStyle.height} ` +
      `opacity=${beforeStyle.opacity} background=${beforeStyle.backgroundColor} ` +
      `transform=${beforeStyle.transform} z=${beforeStyle.zIndex}`
  );

  const toolbox = win.document.getElementById("navigator-toolbox");
  for (let element of toolbox.querySelectorAll("*")) {
    if (tab.contains(element)) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    if (
      rect.width < 4 ||
      rect.height < 4 ||
      rect.right < tabRect.left + 2 ||
      rect.left > tabRect.right - 2 ||
      element.querySelector(".tabbrowser-tab")
    ) {
      continue;
    }
    const chain = [];
    for (
      let parent = element.parentElement;
      parent && parent.id != "navigator-toolbox";
      parent = parent.parentElement
    ) {
      chain.push(elementName(parent));
    }
    info(
      `RECT [${label}] INTRUDER ${elementName(element)} ${rectText(rect)} ` +
        `in ${chain.join(" < ")}`
    );
  }
}

function difference(before, after) {
  const width = Math.min(before.width, after.width);
  const height = Math.min(before.height, after.height);
  const beforeData = before
    .getContext("2d")
    .getImageData(0, 0, width, height).data;
  const afterData = after
    .getContext("2d")
    .getImageData(0, 0, width, height).data;
  let changed = 0;
  for (let i = 0; i < beforeData.length; i += 4) {
    if (
      Math.abs(beforeData[i] - afterData[i]) > 2 ||
      Math.abs(beforeData[i + 1] - afterData[i + 1]) > 2 ||
      Math.abs(beforeData[i + 2] - afterData[i + 2]) > 2 ||
      Math.abs(beforeData[i + 3] - afterData[i + 3]) > 2
    ) {
      changed++;
    }
  }
  return { changed, ratio: changed / (width * height) };
}

function captureRow(win, label) {
  if (Services.env.get("WFX_SHOT_RECTS")) {
    logRects(win, label);
  }
  return { label, canvas: strip(win) };
}

async function writeSheet(win, rows, index) {
  const width = Math.max(...rows.map(row => row.canvas.width));
  const height = rows.reduce(
    (total, row) => total + LABEL_HEIGHT + row.canvas.height,
    0
  );
  const sheet = win.document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  sheet.width = width;
  sheet.height = height;
  const ctx = sheet.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);
  let y = 0;
  for (let { label, canvas } of rows) {
    ctx.fillStyle = "#111";
    ctx.font = "13px sans-serif";
    ctx.fillText(label, 6, y + 15, width - 12);
    ctx.strokeStyle = "#bbb";
    ctx.beginPath();
    ctx.moveTo(0, y + LABEL_HEIGHT - 0.5);
    ctx.lineTo(width, y + LABEL_HEIGHT - 0.5);
    ctx.stroke();
    ctx.drawImage(canvas, 0, y + LABEL_HEIGHT);
    y += LABEL_HEIGHT + canvas.height;
  }
  const url = sheet.toDataURL("image/png");
  const bytes = Uint8Array.from(atob(url.split(",")[1]), c => c.charCodeAt(0));
  const name = `${BASE}-sheet-${String(index).padStart(2, "0")}.png`;
  await IOUtils.write(PathUtils.join(OUT, name), bytes);
  info(`wrote ${name} (${width}x${height})`);
}

add_task(async function contactSheets() {
  if (!OUT || (!CAPTURE_ALL && !PREFS.length)) {
    ok(true, "no capture requested");
    return;
  }
  if (!new Set(["nova", "proton", "photon"]).has(BASE)) {
    throw new Error(`Unsupported WFX_SHOT_BASE: ${BASE}`);
  }
  const win = window;
  const css = await (await fetch(SHEET)).text();
  const prefs = CAPTURE_ALL
    ? Array.from(
        new Set(
          Array.from(
            css.matchAll(/-moz-pref\("(userChrome\.[^"]+)"\)/g),
            match => match[1]
          )
        )
      ).sort()
    : PREFS;
  for (let pref of prefs) {
    if (Services.prefs.getPrefType(pref) != Ci.nsIPrefBranch.PREF_BOOL) {
      throw new Error(`${pref} is not a boolean pref`);
    }
  }
  const prerequisites = addExplicitPrerequisites(collectPrerequisites(css));
  const touched = [
    STYLE_PREF,
    NOVA_PREF,
    ...Object.keys(WaterfoxBrowserStyle.PHOTON_PRESET),
    ...prefs,
  ];
  for (let pref of prefs) {
    touched.push(...(prerequisites.get(pref)?.keys() ?? []));
  }
  const original = snapshotPrefs(touched);
  const privateWin = prefs.some(pref => PRIVATE_PREFS.has(pref))
    ? await BrowserTestUtils.openNewBrowserWindow({ private: true })
    : null;

  await IOUtils.makeDirectory(OUT, { ignoreExisting: true });
  let rows = [];
  let sheet = 0;
  try {
    WaterfoxBrowserStyle.setStyle(BASE);
    await idleChrome(win);
    if (privateWin) {
      await settle(privateWin);
    }
    rows.push(captureRow(win, `${BASE} style baseline`));

    for (let pref of prefs) {
      const auditWin = PRIVATE_PREFS.has(pref) ? privateWin : win;
      const required = prerequisites.get(pref) ?? new Map();
      const local = snapshotPrefs([pref, ...required.keys()]);
      let closeState = async () => {};
      try {
        for (let [parent, value] of required) {
          Services.prefs.setBoolPref(parent, value);
        }
        closeState = await prepareCaptureState(auditWin, pref);

        const baseValue = Services.prefs.getBoolPref(pref, false);
        const requirementLabel = Array.from(
          required,
          ([parent, value]) => `${parent}=${value}`
        ).join(", ");
        const suffix = requirementLabel ? `; requires ${requirementLabel}` : "";
        const baselineLabel = `${BASE} ${pref}=${baseValue} baseline${suffix}`;
        const toggledLabel = `${BASE} ${pref}=${!baseValue} toggled${suffix}`;

        if (rows.length && rows.length + 2 > PER_SHEET) {
          await writeSheet(win, rows, sheet++);
          rows = [];
        }
        const before = captureRow(auditWin, baselineLabel);
        rows.push(before);
        Services.prefs.setBoolPref(pref, !baseValue);
        if (REOPEN_SURFACE_PREFS.has(pref)) {
          await closeState();
          closeState = async () => {};
          closeState = await prepareCaptureState(auditWin, pref);
        }
        await settleVisual(auditWin, pref);
        const after = captureRow(auditWin, toggledLabel);
        rows.push(after);
        if (OS_CAPTURE_PAUSE_MS) {
          info(`OS_CAPTURE_READY ${pref}`);
          await new Promise(resolve =>
            auditWin.setTimeout(resolve, OS_CAPTURE_PAUSE_MS)
          );
        }
        const diff = difference(before.canvas, after.canvas);
        info(
          `DIFF ${pref} changed=${diff.changed} ` +
            `ratio=${diff.ratio.toFixed(6)}`
        );
      } finally {
        await closeState();
        restorePrefs(local);
        await settleVisual(auditWin, pref);
      }
    }
    if (rows.length) {
      await writeSheet(win, rows, sheet);
    }
  } finally {
    restorePrefs(original);
    await settle(win);
    if (privateWin) {
      await BrowserTestUtils.closeWindow(privateWin);
    }
  }
  ok(true, "sheets written");
});
