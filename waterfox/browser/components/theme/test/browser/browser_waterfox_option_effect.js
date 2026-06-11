/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// This detects property changes, not whether the visual result is correct.

requestLongerTimeout(60);

const { WaterfoxBrowserStyle } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBrowserStyle.sys.mjs"
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);

UrlbarTestUtils.init(this);

const SHEET = "chrome://browser/skin/userChrome.css";
const STYLE_PREF = "browser.theme.waterfox.browserStyle";
const NOVA_PREF = "browser.nova.enabled";
const AUTOHIDE_SETTLE_MS = 700;
const AUDIT_PAGE = "about:robots";
const TAB_ICON = "chrome://branding/content/icon32.png";
const SIDEBAR_PROMO_PREF = "sidebar.verticalTabs.dragToPinPromo.dismissed";

// leptonChrome.css gates tab styling on Photon, so these prefs must not affect
// Nova.
const TAB_STYLING_PREFS = new Set([
  "userChrome.hidden.tab_icon",
  "userChrome.hidden.tab_icon.always",
  "userChrome.tab.always_show_tab_icon",
  "userChrome.tab.bar_separator",
  "userChrome.tab.blue_accent",
  "userChrome.tab.bottom_rounded_corner",
  "userChrome.tab.bottom_rounded_corner.all",
  "userChrome.tab.bottom_rounded_corner.australis",
  "userChrome.tab.bottom_rounded_corner.chrome",
  "userChrome.tab.bottom_rounded_corner.chrome_legacy",
  "userChrome.tab.bottom_rounded_corner.edge",
  "userChrome.tab.bottom_rounded_corner.wave",
  "userChrome.tab.box_shadow",
  "userChrome.tab.close_button_at_hover",
  "userChrome.tab.close_button_at_hover.always",
  "userChrome.tab.close_button_at_hover.with_selected",
  "userChrome.tab.close_button_at_pinned",
  "userChrome.tab.close_button_at_pinned.always",
  "userChrome.tab.close_button_at_pinned.background",
  "userChrome.tab.color_like_toolbar",
  "userChrome.tab.connect_to_window",
  "userChrome.tab.container",
  "userChrome.tab.container.always_long",
  "userChrome.tab.container.on_top",
  "userChrome.tab.contextline_blue_accent",
  "userChrome.tab.crashed",
  "userChrome.tab.dynamic_separator",
  "userChrome.tab.lepton_like_padding",
  "userChrome.tab.letters_cleary",
  "userChrome.tab.multi_selected",
  "userChrome.tab.newtab_button_like_tab",
  "userChrome.tab.newtab_button_proton",
  "userChrome.tab.newtab_button_smaller",
  "userChrome.tab.photon_like_contextline",
  "userChrome.tab.photon_like_padding",
  "userChrome.tab.pip",
  "userChrome.tab.selected_bold",
  "userChrome.tab.sound_with_favicons",
  "userChrome.tab.sound_with_favicons.on_center",
  "userChrome.tab.static_separator",
  "userChrome.tab.static_separator.selected_accent",
  "userChrome.tab.supernova_like_contextline",
  "userChrome.tab.unloaded",
]);

const PRIVATE_PREFS = new Set([
  "userChrome.hidden.private_indicator",
  "userChrome.theme.private",
]);

const EXPLICIT_PREREQUISITES = new Map([
  ["userChrome.autohide.fill_urlbar", [["userChrome.tabbar.one_liner", true]]],
  ["userChrome.autohide.tab.blur", [["userChrome.autohide.tab", true]]],
  ["userChrome.autohide.tab.opacity", [["userChrome.autohide.tab", true]]],
  ["userChrome.centered.tab.label", [["userChrome.centered.tab", true]]],
  [
    "userChrome.combined.nav_button.home_button",
    [["userChrome.combined.nav_button", true]],
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
    ],
  ],
  [
    "userChrome.icon.panel_photon",
    [
      ["userChrome.icon.disabled", false],
      ["userChrome.icon.panel", true],
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
    "userChrome.tab.static_separator.selected_accent",
    [["userChrome.tab.static_separator", true]],
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

function splitTop(text, sep = ",") {
  const out = [];
  let depth = 0;
  let buf = "";
  let quote = null;
  for (let ch of text) {
    if (quote) {
      buf += ch;
      if (ch == quote) {
        quote = null;
      }
      continue;
    }
    if (ch == '"' || ch == "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    if (ch == "(" || ch == "[") {
      depth++;
    } else if (ch == ")" || ch == "]") {
      depth--;
    }
    if (ch == sep && depth == 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  out.push(buf);
  return out;
}

/**
 * @param {string} css Stylesheet text.
 * @returns {Map} Selectors and property names keyed by pref.
 */
function collect(css) {
  const byPref = new Map();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (let match of text.matchAll(/@media([^{]*?)\{/g)) {
    const prefs = Array.from(
      match[1].matchAll(/-moz-pref\("([^"]+)"\)/g),
      m => m[1]
    ).filter(p => p.startsWith("userChrome."));
    if (!prefs.length) {
      continue;
    }
    let depth = 0;
    let i = match.index + match[0].length - 1;
    const open = i;
    for (; i < text.length; i++) {
      if (text[i] == "{") {
        depth++;
      } else if (text[i] == "}") {
        depth--;
        if (!depth) {
          break;
        }
      }
    }
    const body = text.slice(open + 1, i);
    const selectors = new Set();
    for (let rule of body.matchAll(/([^{}();@]+)\{/g)) {
      for (let selector of splitTop(rule[1])) {
        const cleaned = selector.trim().replace(/\s+/g, " ");
        if (cleaned && !cleaned.startsWith("@")) {
          selectors.add(cleaned);
        }
      }
    }
    const props = new Set(
      Array.from(body.matchAll(/([-a-z]+)\s*:[^;{}]+;/g), m => m[1]).filter(
        prop => prop.length > 2
      )
    );
    for (let pref of prefs) {
      if (!byPref.has(pref)) {
        byPref.set(pref, { selectors: new Set(), props: new Set() });
      }
      const entry = byPref.get(pref);
      selectors.forEach(selector => entry.selectors.add(selector));
      props.forEach(prop => entry.props.add(prop));
    }
  }
  return byPref;
}

/**
 * Querying the original selector first avoids reducing
 * `:not(:-moz-lwtheme)` to invalid `:not()`.
 *
 * @param {Window} win Chrome window.
 * @param {string} selector Stylesheet selector.
 * @returns {NodeList|null} Matches, or null for an unsupported selector.
 */
function queryOrNull(win, selector) {
  const attempts = [
    selector,
    selector.replace(/\b(xul|html)\|/g, ""),
    selector
      .replace(/\b(xul|html)\|/g, "")
      .replace(/::[a-z-]+(\([^)]*\))?/g, ""),
  ];
  for (let attempt of attempts) {
    const probe = attempt.trim();
    if (!probe) {
      continue;
    }
    try {
      return win.document.querySelectorAll(probe);
    } catch (e) {
      // Try the next selector form.
    }
  }
  return null;
}

// Some options affect only pseudo-elements, such as tab separators.
const PSEUDOS = [null, "::before", "::after"];

function sample(win, entry) {
  const readings = [];
  const labels = [];
  let evaluated = 0;
  for (let selector of entry.selectors) {
    const elements = queryOrNull(win, selector);
    if (!elements) {
      continue;
    }
    evaluated++;
    let index = 0;
    for (let el of Array.from(elements).slice(0, 12)) {
      for (let pseudo of PSEUDOS) {
        const style = win.getComputedStyle(el, pseudo);
        for (let prop of entry.props) {
          readings.push(style.getPropertyValue(prop));
          labels.push(`${selector}[${index}]${pseudo ?? ""} ${prop}`);
        }
      }
      index++;
    }
  }
  return { text: readings.join(""), evaluated, readings, labels };
}

/**
 * @param {object} before Sample before the pref change.
 * @param {object} after Sample after the pref change.
 * @returns {string[]} Changed readings.
 */
function explainDiff(before, after) {
  const changed = [];
  for (
    let i = 0;
    i < Math.max(before.readings.length, after.readings.length);
    i++
  ) {
    if (before.readings[i] !== after.readings[i]) {
      changed.push(
        `${before.labels[i] ?? after.labels[i]}: ` +
          `"${before.readings[i] ?? "-"}" -> "${after.readings[i] ?? "-"}"`
      );
    }
  }
  return changed;
}

const EXPLAIN = new Set(
  (Services.env.get("WFX_EXPLAIN") || "").split(",").filter(Boolean)
);

async function settleAnimations(win) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const running = win.document
      .getAnimations()
      .filter(animation => animation.playState == "running");
    if (!running.length) {
      return;
    }
    await Promise.race([
      Promise.all(running.map(animation => animation.finished.catch(() => {}))),
      new Promise(resolve => win.setTimeout(resolve, 200)),
    ]);
  }
}

async function flush(win) {
  await new Promise(resolve =>
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
  await flush(win);
}

async function settleOption(win, pref) {
  if (
    pref.startsWith("userChrome.autohide.") ||
    pref == "userChrome.navbar.as_sidebar"
  ) {
    await new Promise(resolve => win.setTimeout(resolve, AUTOHIDE_SETTLE_MS));
  }
  await flush(win);
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

async function prepareChromeState(win) {
  const undo = [];
  const { gBrowser } = win;
  const originalTab = gBrowser.selectedTab;
  const tabs = [];

  const auditTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    AUDIT_PAGE
  );
  tabs.push(auditTab);

  const faviconTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  faviconTab.setAttribute("label", "Favicon tab");
  faviconTab.setAttribute("image", TAB_ICON);
  gBrowser.pinTab(faviconTab);
  tabs.push(faviconTab);

  const audioTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  audioTab.setAttribute("label", "Audio tab");
  audioTab.setAttribute("image", TAB_ICON);
  audioTab.setAttribute("soundplaying", "true");
  audioTab
    .querySelector(".tab-icon-overlay")
    ?.setAttribute("soundplaying", "true");
  tabs.push(audioTab);

  const containerTab = BrowserTestUtils.addTab(gBrowser, "about:blank", {
    userContextId: 1,
  });
  containerTab.setAttribute("label", "Container tab");
  containerTab.setAttribute("image", TAB_ICON);
  tabs.push(containerTab);

  const pendingTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  pendingTab.setAttribute("label", "Unloaded tab");
  pendingTab.setAttribute("pending", "true");
  tabs.push(pendingTab);

  const crashedTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  crashedTab.setAttribute("label", "Crashed tab");
  crashedTab.setAttribute("crashed", "true");
  crashedTab.querySelector(".tab-icon-image")?.setAttribute("crashed", "true");
  tabs.push(crashedTab);

  const pipTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  pipTab.setAttribute("label", "Picture-in-picture tab");
  pipTab.setAttribute("pictureinpicture", "true");
  tabs.push(pipTab);

  gBrowser.addToMultiSelectedTabs(audioTab);
  undo.push(async () => {
    if (originalTab.isConnected) {
      gBrowser.selectedTab = originalTab;
    }
    for (let tab of tabs.toReversed()) {
      if (tab.isConnected) {
        BrowserTestUtils.removeTab(tab);
      }
    }
  });

  const wasToolbarVisible = !win.PersonalToolbar.collapsed;
  win.setToolbarVisibility(win.PersonalToolbar, true);
  undo.push(() =>
    win.setToolbarVisibility(win.PersonalToolbar, wasToolbarVisible)
  );

  const toolbarBookmark = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.toolbarGuid,
    title: "Waterfox toolbar audit",
    url: "https://example.com/waterfox-toolbar-audit",
  });
  const menuFolder = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.menuGuid,
    title: "Waterfox menu audit",
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
  });
  undo.push(async () => {
    await PlacesUtils.bookmarks.remove(menuFolder.guid);
    await PlacesUtils.bookmarks.remove(toolbarBookmark.guid);
  });
  await TestUtils.waitForCondition(
    () => win.document.querySelector("#PlacesToolbarItems .bookmark-item"),
    "The audit bookmark should appear on the toolbar"
  );

  await win.gFindBarPromise;
  const findbarWasOpen = !win.gFindBar.hidden;
  win.gFindBar.open();
  undo.push(() => {
    if (!findbarWasOpen) {
      win.gFindBar.close();
    }
  });

  const sidebarPromo = snapshotPrefs([SIDEBAR_PROMO_PREF]);
  Services.prefs.setBoolPref(SIDEBAR_PROMO_PREF, true);
  undo.push(() => restorePrefs(sidebarPromo));

  const wasSidebarOpen = win.SidebarController.isOpen;
  const previousSidebar = win.SidebarController.currentID;
  await win.SidebarController.show("viewBookmarksSidebar");
  undo.push(async () => {
    if (wasSidebarOpen && previousSidebar) {
      await win.SidebarController.show(previousSidebar);
    } else {
      win.SidebarController.hide();
    }
  });

  const placement = CustomizableUI.getPlacementOfWidget(
    "bookmarks-menu-button"
  );
  if (placement?.area != CustomizableUI.AREA_NAVBAR) {
    CustomizableUI.addWidgetToArea(
      "bookmarks-menu-button",
      CustomizableUI.AREA_NAVBAR
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

  await idleChrome(win);
  return async () => {
    for (let cleanup of undo.toReversed()) {
      await cleanup();
    }
  };
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
    pref.includes("panel") ||
    pref == "userChrome.icon.account_image_to_right" ||
    pref == "userChrome.icon.account_label_to_right"
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
      value: "waterfox audit",
      fireInputEvent: false,
    });
    EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
    await flush(win);
    return () =>
      UrlbarTestUtils.promisePopupClose(win, () => {
        win.gURLBar.handleRevert();
        win.gURLBar.blur();
      });
  }

  let popup;
  let show;
  let hide;
  if (surface == "downloads") {
    popup = win.DownloadsPanel.panel;
    show = () => win.DownloadsPanel.showPanel();
    hide = () => win.DownloadsPanel.hidePanel();
  } else if (surface == "context-menu") {
    popup = win.document.getElementById("contentAreaContextMenu");
    show = () =>
      BrowserTestUtils.synthesizeMouseAtCenter(
        "body",
        { type: "contextmenu", button: 2 },
        win.gBrowser.selectedBrowser
      );
    hide = () => popup.hidePopup();
  } else if (surface == "bookmarks-menu") {
    popup = win.document.getElementById("BMB_bookmarksPopup");
    const button = win.document.getElementById("bookmarks-menu-button");
    show = () => EventUtils.synthesizeMouseAtCenter(button, {}, win);
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

  await flush(win);
  return () => hidePopup(popup, hide);
}

/**
 * Uses the least constrained occurrence when an option appears more than once.
 *
 * @param {string} css Stylesheet text.
 * @returns {Map<string, Map<string, boolean>>} Required values by option.
 */
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

async function sweep(win, privateWin, byPref, prerequisites, label = "") {
  const noEffect = [];
  const unreachable = [];
  let activeWin = null;

  for (let [pref, entry] of byPref) {
    if (!entry.props.size) {
      continue;
    }

    const auditWin = PRIVATE_PREFS.has(pref) ? privateWin : win;
    const surface = surfaceForPref(pref);
    const required = prerequisites.get(pref) ?? new Map();
    const previous = snapshotPrefs([pref, ...required.keys()]);
    let closeSurface = async () => {};
    try {
      for (let [parent, value] of required) {
        Services.prefs.setBoolPref(parent, value);
      }
      if (
        auditWin != activeWin ||
        surface ||
        pref.startsWith("userChrome.autohide.") ||
        pref == "userChrome.navbar.as_sidebar"
      ) {
        await idleChrome(auditWin);
        activeWin = auditWin;
      } else {
        await flush(auditWin);
      }
      closeSurface = await openSurface(auditWin, surface);

      await settleAnimations(auditWin);
      const before = sample(auditWin, entry);
      if (!before.evaluated || !before.text) {
        unreachable.push(pref);
        continue;
      }

      const baseValue = Services.prefs.getBoolPref(pref, false);
      Services.prefs.setBoolPref(pref, !baseValue);
      await settleOption(auditWin, pref);
      await settleAnimations(auditWin);
      const after = sample(auditWin, entry);
      if (before.text === after.text) {
        noEffect.push(pref);
      }
      if (EXPLAIN.has(pref)) {
        const changed = explainDiff(before, after);
        info(
          `EXPLAIN [${label}] ${pref}: ${changed.length} reading(s) moved ` +
            `(${entry.selectors.size} selectors, ${entry.props.size} props, ` +
            `${before.evaluated} matched)`
        );
        for (let line of changed.slice(0, 40)) {
          info(`  EXPLAIN [${label}] ${line}`);
        }
      }
    } finally {
      await closeSurface();
      restorePrefs(previous);
      await settleOption(auditWin, pref);
      if (surface) {
        await idleChrome(auditWin);
      }
    }
  }

  return { noEffect: new Set(noEffect), unreachable: new Set(unreachable) };
}

add_task(async function test_classify_every_option() {
  const win = window;
  const css = await (await fetch(SHEET)).text();
  const byPref = collect(css);
  const prerequisites = addExplicitPrerequisites(collectPrerequisites(css));
  info("Checking " + byPref.size + " options");

  const closeChromeState = await prepareChromeState(win);
  registerCleanupFunction(closeChromeState);
  const privateWin = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  registerCleanupFunction(() => BrowserTestUtils.closeWindow(privateWin));

  const touched = [
    STYLE_PREF,
    NOVA_PREF,
    ...Object.keys(WaterfoxBrowserStyle.PHOTON_PRESET),
    ...byPref.keys(),
  ];
  for (let required of prerequisites.values()) {
    touched.push(...required.keys());
  }
  const original = snapshotPrefs(touched);
  let nova;
  let photon;
  try {
    WaterfoxBrowserStyle.setStyle("nova");
    await Promise.all([flush(win), flush(privateWin)]);
    nova = await sweep(win, privateWin, byPref, prerequisites, "Nova");

    WaterfoxBrowserStyle.setStyle("photon");
    await Promise.all([flush(win), flush(privateWin)]);
    photon = await sweep(win, privateWin, byPref, prerequisites, "Photon");
  } finally {
    restorePrefs(original);
    await Promise.all([flush(win), flush(privateWin)]);
  }

  const universal = [];
  const novaOnly = [];
  const photonOnly = [];
  const neither = [];
  for (let pref of byPref.keys()) {
    const worksOnNova = !nova.noEffect.has(pref) && !nova.unreachable.has(pref);
    const worksOnPhoton =
      !photon.noEffect.has(pref) && !photon.unreachable.has(pref);
    if (worksOnNova && worksOnPhoton) {
      universal.push(pref);
    } else if (worksOnNova) {
      novaOnly.push(pref);
    } else if (worksOnPhoton) {
      photonOnly.push(pref);
    } else {
      neither.push(pref);
    }
  }

  for (let pref of novaOnly.sort()) {
    info("NOVA-ONLY " + pref);
  }
  for (let pref of photonOnly.sort()) {
    info("PHOTON-ONLY " + pref);
  }
  // Unmatched selectors need untested state; matched inert selectors are
  // suspect.
  for (let pref of neither.sort()) {
    const unproven = nova.unreachable.has(pref) || photon.unreachable.has(pref);
    info((unproven ? "NEEDS-STATE " : "INERT ") + pref);
  }
  info(
    `universal ${universal.length}, nova-only ${novaOnly.length}, ` +
      `photon-only ${photonOnly.length}, neither ${neither.length}`
  );

  const leaked = [...universal, ...novaOnly]
    .filter(pref => TAB_STYLING_PREFS.has(pref))
    .sort();
  is(leaked.join(", "), "", "No tab styling option takes effect on Nova");

  ok(true, "classified");
});
