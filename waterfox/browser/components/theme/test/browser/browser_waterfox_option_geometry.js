/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Overlap alone is valid because some options intentionally merge toolbars.

requestLongerTimeout(40);

const { WaterfoxBrowserStyle } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBrowserStyle.sys.mjs"
);

const SHEET = "chrome://browser/skin/userChrome.css";
const STYLE_PREF = "browser.theme.waterfox.browserStyle";
const NOVA_PREF = "browser.nova.enabled";
const AUTOHIDE_SETTLE_MS = 700;
const AUDIT_PAGE = "about:robots";
const TAB_ICON = "chrome://branding/content/icon32.png";
const SIDEBAR_PROMO_PREF = "sidebar.verticalTabs.dragToPinPromo.dismissed";

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

const MEASURED = [
  "#navigator-toolbox",
  "#toolbar-menubar",
  "#TabsToolbar",
  "#nav-bar",
  "#PersonalToolbar",
  "#tabbrowser-tabs",
  "#urlbar",
];

const HIDES = new Map([
  ["userChrome.hidden.tabbar", ["#TabsToolbar", "#tabbrowser-tabs"]],
  ["userChrome.hidden.navbar", ["#nav-bar", "#urlbar"]],
  ["userChrome.autohide.tabbar", ["#TabsToolbar", "#tabbrowser-tabs"]],
  ["userChrome.autohide.navbar", ["#nav-bar", "#urlbar"]],
  ["userChrome.autohide.bookmarkbar", ["#PersonalToolbar"]],
  ["userChrome.tabbar.as_titlebar", ["#tabbrowser-tabs"]],
  ["userChrome.hidden.titlebar_container", ["#toolbar-menubar"]],
  ["userChrome.navbar.as_sidebar", ["#nav-bar", "#urlbar"]],
]);

function optionPrefs() {
  return Services.prefs
    .getChildList("userChrome.")
    .filter(
      pref => Services.prefs.getPrefType(pref) == Ci.nsIPrefBranch.PREF_BOOL
    )
    .sort();
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

function rectsFor(win) {
  const rects = new Map();
  for (let selector of MEASURED) {
    const el = win.document.querySelector(selector);
    if (el) {
      rects.set(selector, el.getBoundingClientRect());
    }
  }
  // Keep elements because window controls may be inside a measured container.
  const controls = Array.from(
    win.document.querySelectorAll(".titlebar-buttonbox-container")
  ).filter(el => {
    const rect = el.getBoundingClientRect();
    return isRendered(win, el) && rect.width > 0 && rect.height > 0;
  });
  return { rects, controls };
}

function intersects(a, b) {
  const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return overlapX > 1 && overlapY > 1;
}

async function settle(win) {
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
  await settle(win);
}

async function settleOption(win, pref) {
  if (
    pref.startsWith("userChrome.autohide.") ||
    pref == "userChrome.navbar.as_sidebar"
  ) {
    await new Promise(resolve => win.setTimeout(resolve, AUTOHIDE_SETTLE_MS));
  }
  await settle(win);
}

async function prepareChromeState(win) {
  const { gBrowser } = win;
  const originalTab = gBrowser.selectedTab;
  const tabs = [];
  const wasToolbarVisible = !win.PersonalToolbar.collapsed;
  const sidebarPromo = snapshotPrefs([SIDEBAR_PROMO_PREF]);
  Services.prefs.setBoolPref(SIDEBAR_PROMO_PREF, true);
  const wasSidebarOpen = win.SidebarController.isOpen;
  const previousSidebar = win.SidebarController.currentID;

  const auditTab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    AUDIT_PAGE
  );
  tabs.push(auditTab);

  const faviconTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  faviconTab.setAttribute("label", "Favicon tab");
  faviconTab.setAttribute("image", TAB_ICON);
  tabs.push(faviconTab);

  const audioTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  audioTab.setAttribute("label", "Audio tab");
  audioTab.setAttribute("image", TAB_ICON);
  audioTab.setAttribute("soundplaying", "true");
  tabs.push(audioTab);

  const containerTab = BrowserTestUtils.addTab(gBrowser, "about:blank", {
    userContextId: 1,
  });
  containerTab.setAttribute("label", "Container tab");
  containerTab.setAttribute("image", TAB_ICON);
  tabs.push(containerTab);

  gBrowser.addToMultiSelectedTabs(faviconTab);
  win.setToolbarVisibility(win.PersonalToolbar, true);
  await win.SidebarController.show("viewBookmarksSidebar");
  await idleChrome(win);

  return async () => {
    if (wasSidebarOpen && previousSidebar) {
      await win.SidebarController.show(previousSidebar);
    } else {
      win.SidebarController.hide();
    }
    win.setToolbarVisibility(win.PersonalToolbar, wasToolbarVisible);
    restorePrefs(sidebarPromo);
    if (originalTab.isConnected) {
      gBrowser.selectedTab = originalTab;
    }
    for (let tab of tabs.toReversed()) {
      if (tab.isConnected) {
        BrowserTestUtils.removeTab(tab);
      }
    }
  };
}

// Toolbar rectangles miss overlaps between their in-flow children.
const ROWS = [
  "#nav-bar",
  "#TabsToolbar",
  "#tabbrowser-tabs",
  "#urlbar-input-container",
  ".tabbrowser-tab[selected] .tab-content",
];

function siblingOverlaps(win) {
  const problems = [];
  for (let selector of ROWS) {
    const container = win.document.querySelector(selector);
    if (!container || !isRendered(win, container)) {
      continue;
    }
    const kids = Array.from(container.children).filter(el => {
      const style = win.getComputedStyle(el);
      if (!isRendered(win, el)) {
        return false;
      }
      // Overlays may intentionally overlap siblings.
      if (style.position == "absolute" || style.position == "fixed") {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 2 && rect.height > 2;
    });
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        const a = kids[i].getBoundingClientRect();
        const b = kids[j].getBoundingClientRect();
        const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapX > 2 && overlapY > 2) {
          const name = el =>
            el.id || el.className.toString().split(" ")[0] || el.localName;
          problems.push(
            `${selector} stacks ${name(kids[i])} over ${name(kids[j])}`
          );
        }
      }
    }
  }
  return problems;
}

function inspect(win, pref, enabled = false) {
  const { rects, controls } = rectsFor(win);
  const problems = [];
  const width = win.innerWidth;
  const allowedEmpty = enabled ? (HIDES.get(pref) ?? []) : [];

  for (let [selector, rect] of rects) {
    const el = win.document.querySelector(selector);
    if (!isRendered(win, el)) {
      continue;
    }
    if (rect.width < 0 || rect.height < 0) {
      problems.push(`${selector} has a negative size`);
      continue;
    }
    if (
      rect.width == 0 &&
      !allowedEmpty.includes(selector) &&
      selector != "#toolbar-menubar" &&
      selector != "#PersonalToolbar"
    ) {
      problems.push(`${selector} collapsed to zero width`);
    }
    if (rect.left < -2 || rect.right > width + 2) {
      problems.push(
        `${selector} sits outside the window (${Math.round(
          rect.left
        )}..${Math.round(rect.right)} of ${width})`
      );
    }
    for (let control of controls) {
      if (el.contains(control)) {
        continue;
      }
      if (intersects(rect, control.getBoundingClientRect())) {
        problems.push(`${selector} collides with the window controls`);
        break;
      }
    }
  }
  problems.push(...siblingOverlaps(win));
  return problems;
}

async function exerciseOptions(win, label, prefs, prerequisites) {
  await idleChrome(win);

  const baseline = inspect(win, "");
  is(baseline.join("; "), "", `The chrome starts out intact on ${label}`);

  const failures = [];
  for (let pref of prefs) {
    const required = prerequisites.get(pref) ?? new Map();
    const previous = snapshotPrefs([pref, ...required.keys()]);
    try {
      for (let [parent, value] of required) {
        Services.prefs.setBoolPref(parent, value);
      }
      const enabled = !Services.prefs.getBoolPref(pref, false);
      Services.prefs.setBoolPref(pref, enabled);
      await settleOption(win, pref);

      const problems = inspect(win, pref, enabled);
      if (problems.length) {
        failures.push(`${pref}=${enabled}: ${problems.join("; ")}`);
      }
    } finally {
      restorePrefs(previous);
      await settleOption(win, pref);
    }
  }

  for (let failure of failures) {
    info(`BROKEN [${label}] ${failure}`);
  }
  is(
    failures.length,
    0,
    `Every option is intact on ${label} (${failures.length} broken)`
  );
}

async function exerciseStyle(win, style, label) {
  const prefs = optionPrefs();
  const css = await (await fetch(SHEET)).text();
  const prerequisites = addExplicitPrerequisites(collectPrerequisites(css));
  const touched = [
    STYLE_PREF,
    NOVA_PREF,
    ...Object.keys(WaterfoxBrowserStyle.PHOTON_PRESET),
    ...prefs,
  ];
  for (let required of prerequisites.values()) {
    touched.push(...required.keys());
  }
  const original = snapshotPrefs(touched);
  try {
    WaterfoxBrowserStyle.setStyle(style);
    await exerciseOptions(win, label, prefs, prerequisites);
  } finally {
    restorePrefs(original);
    await settle(win);
  }
}

add_setup(async function setup_chrome_state() {
  const cleanup = await prepareChromeState(window);
  registerCleanupFunction(cleanup);
});

add_task(async function test_options_on_nova() {
  await exerciseStyle(window, "nova", "Nova");
});

add_task(async function test_options_on_photon() {
  await exerciseStyle(window, "photon", "Photon");
});
