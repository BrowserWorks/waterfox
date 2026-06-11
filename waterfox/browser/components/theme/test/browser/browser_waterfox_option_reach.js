/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Native macOS menus and panels are absent from drawWindow captures, so this
// test checks selector reach instead.

requestLongerTimeout(40);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);

UrlbarTestUtils.init(this);

const AUTOHIDE_SETTLE_MS = 700;
const AUDIT_PAGE = "about:robots";
const TAB_ICON = "chrome://branding/content/icon32.png";
const SIDEBAR_PROMO_PREF = "sidebar.verticalTabs.dragToPinPromo.dismissed";

// userContent.css requires a separate pass against content documents.
const SHEETS = ["chrome://browser/skin/userChrome.css"];

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
 * @returns {Map<string, Set<string>>} Selectors keyed by pref.
 */
function collectSelectors(css) {
  const byPref = new Map();
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const gate = /@media([^{]*?)\{/g;
  let match;
  while ((match = gate.exec(text))) {
    const prefs = Array.from(
      match[1].matchAll(/-moz-pref\("([^"]+)"\)/g),
      m => m[1]
    ).filter(p => p.startsWith("userChrome.") || p.startsWith("userContent."));
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
    for (let rule of body.matchAll(/([^{}();@]+)\{/g)) {
      for (let selector of splitTop(rule[1])) {
        const cleaned = selector.trim().replace(/\s+/g, " ");
        if (!cleaned || cleaned.startsWith("@")) {
          continue;
        }
        for (let pref of prefs) {
          if (!byPref.has(pref)) {
            byPref.set(pref, new Set());
          }
          byPref.get(pref).add(cleaned);
        }
      }
    }
  }
  return byPref;
}

function isOutOfScope(selector) {
  return (
    selector.includes("@-moz-document") ||
    selector.startsWith("html|") ||
    selector.includes("#outerContainer") ||
    selector.includes("#viewerContainer") ||
    selector.includes(".top-site") ||
    selector.includes("videocontrols") ||
    selector.includes(".controlsContainer")
  );
}

function matchesAnything(win, selector) {
  // querySelector cannot evaluate these stylesheet-only selector forms.
  const probe = selector
    .replace(/\b(xul|html)\|/g, "")
    .replace(/::[a-z-]+(\([^)]*\))?/g, "")
    .replace(/:-moz-[a-z-]+(\([^)]*\))?/g, "")
    .trim();
  if (!probe) {
    return true;
  }
  try {
    return !!win.document.querySelector(probe);
  } catch (e) {
    // Unsupported selectors are inconclusive.
    return true;
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

async function openSurface(win, surface) {
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

function recordReach(windows, byPref, reached) {
  for (let [pref, selectors] of byPref) {
    const inScope = Array.from(selectors).filter(s => !isOutOfScope(s));
    if (
      inScope.some(selector =>
        windows.some(win => matchesAnything(win, selector))
      )
    ) {
      reached.add(pref);
    }
  }
}

/**
 * Observe surfaces separately because opening a popup closes the previous one.
 *
 * @param {Window} win Chrome window.
 * @param {Function} observe Called while each surface is open.
 * @returns {Function} Teardown that restores the previous state.
 */
async function openSurfaces(win, observe) {
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

  const menubar = win.document.getElementById("toolbar-menubar");
  const wasAutohide = menubar.getAttribute("autohide");
  menubar.setAttribute("autohide", "false");
  undo.push(() => {
    if (wasAutohide === null) {
      menubar.removeAttribute("autohide");
    } else {
      menubar.setAttribute("autohide", wasAutohide);
    }
  });

  const hadSidebarPromoPref =
    Services.prefs.prefHasUserValue(SIDEBAR_PROMO_PREF);
  const sidebarPromoDismissed = Services.prefs.getBoolPref(
    SIDEBAR_PROMO_PREF,
    false
  );
  Services.prefs.setBoolPref(SIDEBAR_PROMO_PREF, true);
  undo.push(() => {
    if (hadSidebarPromoPref) {
      Services.prefs.setBoolPref(SIDEBAR_PROMO_PREF, sidebarPromoDismissed);
    } else {
      Services.prefs.clearUserPref(SIDEBAR_PROMO_PREF);
    }
  });

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

  const privateWin = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  undo.push(() => BrowserTestUtils.closeWindow(privateWin));
  const windows = [win, privateWin];

  await idleChrome(win);
  observe(windows);
  for (let surface of [
    "app-menu",
    "app-subview",
    "downloads",
    "context-menu",
    "urlbar",
    "bookmarks-menu",
  ]) {
    const close = await openSurface(win, surface);
    observe(windows);
    await close();
    await idleChrome(win);
  }

  return async () => {
    for (let cleanup of undo.toReversed()) {
      await cleanup();
    }
  };
}

const REQUIRES_STATE = new Map([
  ["userChrome.tab.crashed", "a browser-crashed tab"],
  ["userChrome.fullscreen.show_bookmarkbar", "browser fullscreen"],
  ["userChrome.compatibility.os.windows_maximized", "Windows, maximized"],
  ["userChrome.padding.drag_space.maximized", "a maximized window"],
  [
    "userChrome.compatibility.covered_header_image",
    "a theme with a header image",
  ],
  ["userChrome.padding.infobar", "a notification bar"],
  ["userChrome.rounding.square_infobox", "a notification bar"],
  [
    "userChrome.urlView.go_button_when_typing",
    "a URL result state exposing the go button",
  ],
  [
    "userChrome.padding.bookmark_menu.compact",
    "legacy Places items in the bookmarks menu",
  ],
  ["userChrome.icon.account_image_to_right", "an open account panel"],
  ["userChrome.icon.account_label_to_right", "an open account panel"],
  ["userChrome.theme.transparent.menu", "queryable popup shadow content"],
  ["userChrome.panel.full_width_padding", "a matching subview body"],
]);

add_task(async function test_every_option_reaches_the_chrome() {
  const win = window;
  const byPref = new Map();
  for (let url of SHEETS) {
    const css = await (await fetch(url)).text();
    for (let [pref, selectors] of collectSelectors(css)) {
      if (!byPref.has(pref)) {
        byPref.set(pref, new Set());
      }
      selectors.forEach(s => byPref.get(pref).add(s));
    }
  }
  info(`Checking ${byPref.size} options`);

  const reached = new Set();
  const closeSurfaces = await openSurfaces(win, windows =>
    recordReach(windows, byPref, reached)
  );
  registerCleanupFunction(closeSurfaces);

  const dead = [];
  for (let [pref, selectors] of byPref) {
    const inScope = Array.from(selectors).filter(s => !isOutOfScope(s));
    if (!inScope.length) {
      continue;
    }
    if (!reached.has(pref) && !REQUIRES_STATE.has(pref)) {
      dead.push(`${pref} (${inScope.length} selectors, none match)`);
    }
  }

  for (let entry of dead.sort()) {
    info(`DEAD ${entry}`);
  }
  is(
    dead.length,
    0,
    `Every option reaches the chrome (${dead.length} orphaned)`
  );

  const stale = Array.from(REQUIRES_STATE.keys()).filter(pref =>
    reached.has(pref)
  );
  is(stale.join(", "), "", "No allowlist entry has become unnecessary");
});
