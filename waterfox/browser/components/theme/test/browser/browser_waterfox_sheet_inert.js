/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Rules gated by `@media not -moz-pref(...)` are active when their option is
// off, so compare snapshots with and without the sheet.

const { WaterfoxBrowserStyle } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBrowserStyle.sys.mjs"
);
const { WaterfoxTheme } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxTheme.sys.mjs"
);

const BROWSER_STYLE_PREF = "browser.theme.waterfox.browserStyle";
const CHROME_SHEET_PREF = "browser.theme.waterfox.chromeSheet";
const NOVA_PREF = "browser.nova.enabled";

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

const ORIGINAL_PREFS = snapshotPrefs([
  BROWSER_STYLE_PREF,
  CHROME_SHEET_PREF,
  NOVA_PREF,
  ...Object.keys(WaterfoxBrowserStyle.PHOTON_PRESET),
]);

const PROPERTIES = [
  "background-color",
  "background-image",
  "border-radius",
  "border-top-width",
  "border-bottom-color",
  "box-shadow",
  "color",
  "display",
  "font-family",
  "font-weight",
  "height",
  "list-style-image",
  "margin-block",
  "margin-inline",
  "min-height",
  "opacity",
  "padding-block",
  "padding-inline",
  "visibility",
  "width",
];

function snapshot(win) {
  const readings = [];
  const roots = ["#navigator-toolbox", "#browser"];
  for (let root of roots) {
    const el = win.document.querySelector(root);
    if (!el) {
      continue;
    }
    for (let node of [el, ...el.querySelectorAll("*")]) {
      const style = win.getComputedStyle(node);
      const id = node.id || node.className.toString() || node.localName;
      for (let prop of PROPERTIES) {
        readings.push(`${id}|${prop}|${style.getPropertyValue(prop)}`);
      }
    }
  }
  return readings;
}

async function flush(win) {
  await new Promise(resolve =>
    win.requestAnimationFrame(() => win.requestAnimationFrame(resolve))
  );
}

async function assertInert(win, style) {
  WaterfoxBrowserStyle.setStyle(style);
  await flush(win);

  const sheetPref = snapshotPrefs([CHROME_SHEET_PREF]);
  let loaded;
  let unloaded;
  try {
    Services.prefs.setIntPref(CHROME_SHEET_PREF, 0);
    await flush(win);
    ok(WaterfoxTheme.stylesEnabled, `The sheet is loaded for ${style}`);
    loaded = snapshot(win);

    Services.prefs.setIntPref(CHROME_SHEET_PREF, 2);
    await flush(win);
    ok(!WaterfoxTheme.stylesEnabled, `The sheet is unloaded for ${style}`);
    unloaded = snapshot(win);
  } finally {
    restorePrefs(sheetPref);
    await flush(win);
  }

  const differences = [];
  for (let i = 0; i < loaded.length; i++) {
    if (loaded[i] !== unloaded[i]) {
      differences.push(`${loaded[i]}  (unloaded: ${unloaded[i]})`);
    }
  }
  for (let difference of differences.slice(0, 40)) {
    info(`DIFF ${difference}`);
  }
  is(
    differences.length,
    0,
    `${style} looks the same whether or not the sheet is loaded`
  );
}

registerCleanupFunction(async () => {
  restorePrefs(ORIGINAL_PREFS);
  await flush(window);
});

add_task(async function test_sheet_is_inert_for_nova() {
  await assertInert(window, "nova");
});

add_task(async function test_sheet_is_inert_for_proton() {
  await assertInert(window, "proton");
});

add_task(async function test_photon_still_restyles_the_chrome() {
  // Verify Photon changes the snapshot so inertness checks cannot pass
  // vacuously.
  const win = window;
  WaterfoxBrowserStyle.setStyle("photon");
  await flush(win);

  const sheetPref = snapshotPrefs([CHROME_SHEET_PREF]);
  let loaded;
  let unloaded;
  try {
    Services.prefs.setIntPref(CHROME_SHEET_PREF, 0);
    await flush(win);
    loaded = snapshot(win);

    Services.prefs.setIntPref(CHROME_SHEET_PREF, 2);
    await flush(win);
    unloaded = snapshot(win);
  } finally {
    restorePrefs(sheetPref);
    await flush(win);
  }

  const changed = loaded.filter((value, i) => value !== unloaded[i]).length;
  info(`Photon changes ${changed} computed values`);
  Assert.greater(changed, 0, "Photon still restyles the chrome");
});
