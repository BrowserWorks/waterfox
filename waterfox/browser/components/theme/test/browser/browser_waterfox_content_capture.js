/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WaterfoxTheme } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxTheme.sys.mjs"
);

requestLongerTimeout(120);

const OUT = Services.env.get("WFX_CONTENT_SHOT_DIR");
const REQUESTED_PREFS = Array.from(
  new Set(
    (Services.env.get("WFX_CONTENT_SHOT_PREFS") || "")
      .split(",")
      .map(pref => pref.trim())
      .filter(Boolean)
  )
);
const TEST_ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content/",
  "http://mochi.test:8888/"
);
const CHROME_SHEET_PREF = "browser.theme.waterfox.chromeSheet";
const CONTENT_SHEET = "chrome://browser/skin/userContent.css";
const DARK_THEME_PREF = "ui.systemUsesDarkTheme";
const REDUCED_MOTION_PREF = "ui.prefersReducedMotion";
const LABEL_HEIGHT = 28;

const CAPTURES = [
  {
    pref: "userContent.player.size",
    state: "media",
    label: "local video and audio controls",
  },
  {
    pref: "userContent.player.ui",
    state: "media",
    label: "local video and audio controls",
  },
  {
    pref: "userContent.player.ui.twoline",
    state: "media",
    label: "local video and audio controls",
    requires: [["userContent.player.ui", true]],
  },
  {
    pref: "userContent.player.icon",
    state: "media",
    label: "local video controls",
  },
  {
    pref: "userContent.player.noaudio",
    state: "media",
    label: "local video without an audio track",
  },
  {
    pref: "userContent.player.click_to_play",
    state: "media",
    label: "unplayed local video",
  },
  {
    pref: "userContent.player.animate",
    state: "media",
    label: "local media controls (static frame)",
    requires: [[REDUCED_MOTION_PREF, 0]],
    computedStyles: [
      {
        shadowHost: "#audit-video",
        selector: ".controlBar",
        label: "control-bar",
        properties: ["transition-duration"],
      },
    ],
  },
  {
    pref: "userContent.page.field_border",
    state: "newtab",
    label: "dark about:newtab search sample",
    requires: [[DARK_THEME_PREF, 1]],
    computedStyles: [
      {
        selector: ":root",
        label: "root",
        properties: ["--newtab-primary-action-background"],
      },
      {
        selector: ".search-handoff-button",
        label: "search",
        properties: ["border-top-color"],
      },
    ],
  },
  {
    pref: "userContent.newTab.full_icon",
    state: "newtab",
    label: "about:newtab top-site sample",
  },
  {
    pref: "userContent.newTab.animate",
    state: "newtab",
    label: "about:newtab top-site transition (static frame)",
    requires: [[REDUCED_MOTION_PREF, 0]],
    computedStyles: [
      {
        selector: ".top-site-outer",
        label: "top-site",
        properties: ["transition-duration"],
      },
    ],
  },
  {
    pref: "userContent.newTab.pocket_to_last",
    state: "newtab",
    label: "about:newtab Pocket-order sample",
  },
  {
    pref: "userContent.newTab.hidden_logo",
    state: "newtab",
    label: "about:newtab logo sample",
  },
  {
    pref: "userContent.newTab.background_image",
    state: "newtab",
    label: "about:newtab built-in wallpaper",
  },
  {
    pref: "userContent.page.illustration",
    state: "error",
    label: "about:neterror DNS failure",
  },
  {
    pref: "userContent.page.dark_mode.pdf",
    state: "pdf",
    label: "local PDF in dark color scheme",
    requires: [[DARK_THEME_PREF, 1]],
  },
  {
    pref: "userContent.page.proton",
    state: "about",
    label: "about:cache tables and controls",
  },
  {
    pref: "userContent.page.monospace",
    state: "about",
    label: "about:cache text and tables",
  },
];

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

function setRequirement(pref, value) {
  if (typeof value == "boolean") {
    Services.prefs.setBoolPref(pref, value);
  } else {
    Services.prefs.setIntPref(pref, value);
  }
}

function urlForState(state) {
  if (state == "media") {
    return TEST_ROOT + "file_usercontent_media.html";
  }
  if (state == "newtab") {
    return "about:newtab";
  }
  if (state == "pdf") {
    return TEST_ROOT + "file_pdfjs_test.pdf";
  }
  if (state == "about") {
    return "about:cache";
  }
  return (
    "about:neterror?e=dnsNotFound&u=" +
    encodeURIComponent("https://waterfox-visual-audit.invalid/")
  );
}

async function openCaptureTab(entry) {
  const url = urlForState(entry.state);
  if (entry.state == "newtab") {
    return BrowserTestUtils.openNewForegroundTab(gBrowser, url, false);
  }
  if (entry.state != "error") {
    return BrowserTestUtils.openNewForegroundTab(gBrowser, url);
  }

  let errorLoaded;
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    () => {
      gBrowser.selectedTab = BrowserTestUtils.addTab(gBrowser, url);
      errorLoaded = BrowserTestUtils.waitForErrorPage(gBrowser.selectedBrowser);
    },
    false
  );
  await errorLoaded;
  return tab;
}

async function preparePage(browser, entry) {
  await SpecialPowers.spawn(
    browser,
    [entry.state, entry.pref],
    async (state, pref) => {
      const { ContentTaskUtils } = ChromeUtils.importESModule(
        "resource://testing-common/ContentTaskUtils.sys.mjs"
      );
      const doc = content.document;

      if (state == "media") {
        await ContentTaskUtils.waitForCondition(
          () =>
            doc.querySelector("#audit-video")?.readyState >= 1 &&
            doc.querySelector("#audit-audio")?.readyState >= 1,
          "The local media metadata should load"
        );
      } else if (state == "newtab") {
        await ContentTaskUtils.waitForCondition(
          () => doc.readyState == "complete" && doc.body,
          "The new-tab document should load"
        );

        const add = (parent, tag, { id, className, text, styleText } = {}) => {
          const element = doc.createElement(tag);
          if (id) {
            element.id = id;
          }
          if (className) {
            element.className = className;
          }
          if (text !== undefined) {
            element.textContent = text;
          }
          if (styleText) {
            element.style.cssText = styleText;
          }
          parent.append(element);
          return element;
        };
        const root = doc.createElement("div");
        root.id = "root";
        root.style.cssText =
          "box-sizing: border-box; min-height: 0; padding: 32px";
        const sample = add(root, "main", {
          id: "wfx-usercontent-audit",
          styleText:
            "box-sizing: border-box; width: min(380px, calc(100vw - 64px)); margin: 0 auto; padding: 20px; border: 2px solid #4b6cb7; border-radius: 8px; background: rgba(247, 247, 249, 0.96); color: #15141a; box-shadow: 0 4px 18px rgba(0, 0, 0, 0.25)",
        });
        add(sample, "h1", {
          text: pref,
          styleText: "margin: 0 0 16px; font: 600 16px sans-serif",
        });

        const addSearch = () => {
          const outer = add(sample, "div", {
            className: "outer-wrapper",
            styleText: "width: 100%",
          });
          const search = add(outer, "div", {
            className: "search-wrapper",
            styleText: "width: 100%",
          });
          const inner = add(search, "div", {
            className: "search-inner-wrapper",
          });
          return add(inner, "button", {
            className: "search-handoff-button",
            text: "Search the web",
            styleText: "width: 100%; min-height: 48px",
          });
        };
        const addTopSite = () => {
          const topSite = add(sample, "div", {
            className: "top-site-outer",
            styleText:
              "display: inline-grid; justify-items: center; width: 96px; padding: 8px",
          });
          const tile = add(topSite, "div", {
            className: "tile",
            styleText:
              "display: grid; place-items: center; width: 48px; height: 48px; background: #4b6cb7",
          });
          add(tile, "div", {
            className: "icon-wrapper",
            text: "W",
            styleText:
              "display: grid; place-items: center; width: 32px; height: 32px; color: white",
          });
          add(topSite, "span", { text: "Top site" });
        };

        let focusTarget;
        if (pref == "userContent.page.field_border") {
          doc.documentElement.setAttribute("lwt-newtab-brighttext", "");
          focusTarget = addSearch();
          focusTarget.style.border =
            "2px solid var(--newtab-primary-action-background, #0060df)";
          focusTarget.style.boxShadow =
            "0 0 0 3px var(--newtab-primary-action-background, #0060df)";
        } else if (
          pref == "userContent.newTab.full_icon" ||
          pref == "userContent.newTab.animate"
        ) {
          addTopSite();
        } else if (pref == "userContent.newTab.pocket_to_last") {
          const sections = add(sample, "div", {
            className: "body-wrapper on",
            styleText: "border: 1px solid #8f8f9d",
          });
          const pocket = add(sections, "div", {
            className: "collapsible-section",
            text: "Pocket sample (first in source)",
            styleText: "padding: 16px; background: #d7ebff",
          });
          pocket.dataset.sectionId = "topstories";
          add(sections, "div", {
            className: "discovery-stream ds-layout",
            text: "Other new-tab content",
            styleText: "padding: 16px; background: #e8e8ed",
          });
        } else if (pref == "userContent.newTab.hidden_logo") {
          add(sample, "div", {
            className: "logo-and-wordmark",
            text: "Waterfox new-tab logo sample",
            styleText: "margin-bottom: 16px; font-size: 20px; font-weight: 700",
          });
          addSearch();
        } else if (pref == "userContent.newTab.background_image") {
          add(sample, "p", {
            text: "Built-in Waterfox wallpaper sample",
            styleText: "margin: 0",
          });
        } else {
          throw new Error(`No new-tab fixture for ${pref}`);
        }

        Object.assign(doc.body.style, {
          margin: "0",
          minHeight: "100vh",
          background: "var(--newtab-background-color, #f0f0f4)",
          color: "var(--newtab-text-primary-color, #15141a)",
        });
        doc.body.replaceChildren(root);
        focusTarget?.focus();
      } else if (state == "pdf") {
        await ContentTaskUtils.waitForCondition(
          () => doc.querySelector(".page .canvasWrapper canvas"),
          "The local PDF page should render"
        );
      } else if (state == "about") {
        await ContentTaskUtils.waitForCondition(
          () => doc.querySelector("table"),
          "about:cache should render its tables"
        );
      } else {
        await ContentTaskUtils.waitForCondition(
          () => doc.readyState == "complete" && doc.body,
          "The network error document should load"
        );
      }

      await new Promise(resolve =>
        content.requestAnimationFrame(() =>
          content.requestAnimationFrame(resolve)
        )
      );
    }
  );

  if (entry.state == "media") {
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#audit-video",
      { type: "mousemove" },
      browser.browsingContext
    );
  }
}

async function settleContent(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    await new Promise(resolve => content.setTimeout(resolve, 350));
    await new Promise(resolve =>
      content.requestAnimationFrame(() =>
        content.requestAnimationFrame(resolve)
      )
    );
  });
}

async function captureComputedStyles(browser, entry) {
  const probes = entry.computedStyles ?? [];
  if (!probes.length) {
    return [];
  }
  return SpecialPowers.spawn(browser, [probes], styleProbes => {
    const readings = [];
    for (let probe of styleProbes) {
      let root = content.document;
      if (probe.shadowHost) {
        const host = content.document.querySelector(probe.shadowHost);
        if (!host) {
          throw new Error(`Missing computed-style host ${probe.shadowHost}`);
        }
        root = SpecialPowers.wrap(host).openOrClosedShadowRoot;
      }
      const element = root?.querySelector(probe.selector);
      if (!element) {
        throw new Error(`Missing computed-style target ${probe.selector}`);
      }
      const style = content.getComputedStyle(element);
      for (let property of probe.properties) {
        readings.push({
          name: `${probe.label ?? probe.selector} ${property}`,
          value: style.getPropertyValue(property).trim(),
        });
      }
    }
    return readings;
  });
}

async function captureBrowser(browser) {
  const browserRect = browser.getBoundingClientRect();
  const width = Math.max(1, Math.floor(browserRect.width));
  const height = Math.max(1, Math.floor(browserRect.height));
  const rect = new DOMRect(0, 0, width, height);
  const snapshot =
    await browser.browsingContext.currentWindowGlobal.drawSnapshot(
      rect,
      1,
      "rgb(255, 255, 255)"
    );
  const canvas = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").drawImage(snapshot, 0, 0);
  snapshot.close();
  return canvas;
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
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let i = 0; i < beforeData.length; i += 4) {
    if (
      Math.abs(beforeData[i] - afterData[i]) <= 2 &&
      Math.abs(beforeData[i + 1] - afterData[i + 1]) <= 2 &&
      Math.abs(beforeData[i + 2] - afterData[i + 2]) <= 2 &&
      Math.abs(beforeData[i + 3] - afterData[i + 3]) <= 2
    ) {
      continue;
    }
    changed++;
    const pixel = i / 4;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return {
    changed,
    ratio: changed / (width * height),
    bounds: changed ? `${left},${top}..${right},${bottom}` : "none",
  };
}

function drawLabel(ctx, text, y, width) {
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, y, width, LABEL_HEIGHT);
  ctx.fillStyle = "#111";
  ctx.font = "13px sans-serif";
  ctx.fillText(text, 7, y + 18, width - 14);
  ctx.strokeStyle = "#aaa";
  ctx.beginPath();
  ctx.moveTo(0, y + LABEL_HEIGHT - 0.5);
  ctx.lineTo(width, y + LABEL_HEIGHT - 0.5);
  ctx.stroke();
}

function computedStyleSummary(readings) {
  return readings
    .map(reading => `${reading.name}=${reading.value || "<empty>"}`)
    .join(", ");
}

async function writeComparison(
  index,
  entry,
  baseValue,
  before,
  after,
  beforeStyles,
  afterStyles
) {
  const diff = difference(before, after);
  info(
    `DIFF ${entry.pref} changed=${diff.changed} ` +
      `ratio=${diff.ratio.toFixed(6)} bounds=${diff.bounds}`
  );
  if (beforeStyles.length) {
    info(
      `STYLES ${entry.pref} ${beforeStyles
        .map(
          (reading, styleIndex) =>
            `${reading.name}: ${reading.value || "<empty>"} -> ` +
            `${afterStyles[styleIndex].value || "<empty>"}`
        )
        .join("; ")}`
    );
  }
  const width = Math.max(before.width, after.width);
  const height = LABEL_HEIGHT * 2 + before.height + after.height;
  const sheet = document.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas"
  );
  sheet.width = width;
  sheet.height = height;
  const ctx = sheet.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, width, height);

  const requirements = (entry.requires ?? [])
    .map(([pref, value]) => `${pref}=${value}`)
    .join(", ");
  const suffix = requirements ? `; requires ${requirements}` : "";
  const beforeStyleText = beforeStyles.length
    ? `; ${computedStyleSummary(beforeStyles)}`
    : "";
  const afterStyleText = afterStyles.length
    ? `; ${computedStyleSummary(afterStyles)}`
    : "";
  drawLabel(
    ctx,
    `${entry.pref}=${baseValue} baseline; ${entry.label}${suffix}${beforeStyleText}`,
    0,
    width
  );
  ctx.drawImage(before, 0, LABEL_HEIGHT);
  const secondLabelY = LABEL_HEIGHT + before.height;
  drawLabel(
    ctx,
    `${entry.pref}=${!baseValue} toggled; ${entry.label}${suffix}${afterStyleText}`,
    secondLabelY,
    width
  );
  ctx.drawImage(after, 0, secondLabelY + LABEL_HEIGHT);

  const png = sheet.toDataURL("image/png");
  const bytes = Uint8Array.from(atob(png.split(",")[1]), char =>
    char.charCodeAt(0)
  );
  const safePref = entry.pref.replaceAll(".", "-");
  const name = `usercontent-${String(index + 1).padStart(2, "0")}-${safePref}.png`;
  await IOUtils.write(PathUtils.join(OUT, name), bytes);
  info(`wrote ${name} (${width}x${height})`);
}

add_task(async function captureUserContentOptions() {
  if (!OUT) {
    ok(true, "no userContent capture requested");
    return;
  }

  const allPrefs = new Set(CAPTURES.map(entry => entry.pref));
  const css = await (await fetch(CONTENT_SHEET)).text();
  const sheetPrefs = new Set(
    Array.from(
      css.matchAll(/-moz-pref\("(userContent\.[^"]+)"\)/g),
      match => match[1]
    )
  );
  const missing = Array.from(sheetPrefs).filter(pref => !allPrefs.has(pref));
  const stale = Array.from(allPrefs).filter(pref => !sheetPrefs.has(pref));
  if (
    CAPTURES.length != 18 ||
    allPrefs.size != 18 ||
    missing.length ||
    stale.length
  ) {
    throw new Error(
      `userContent capture mismatch; missing: ${missing.join(", ") || "none"}; ` +
        `stale: ${stale.join(", ") || "none"}`
    );
  }
  const unknown = REQUESTED_PREFS.filter(pref => !allPrefs.has(pref));
  if (unknown.length) {
    throw new Error(`Unknown WFX_CONTENT_SHOT_PREFS: ${unknown.join(", ")}`);
  }
  const captures = REQUESTED_PREFS.length
    ? CAPTURES.filter(entry => REQUESTED_PREFS.includes(entry.pref))
    : CAPTURES;
  const touched = [
    CHROME_SHEET_PREF,
    ...CAPTURES.map(entry => entry.pref),
    ...CAPTURES.flatMap(entry => (entry.requires ?? []).map(([pref]) => pref)),
  ];
  const original = snapshotPrefs(touched);

  await IOUtils.makeDirectory(OUT, { ignoreExisting: true });
  try {
    Services.prefs.setIntPref(CHROME_SHEET_PREF, 0);
    await TestUtils.waitForTick();
    ok(WaterfoxTheme.stylesEnabled, "The userContent sheet is loaded");

    for (let [index, entry] of captures.entries()) {
      const requirements = entry.requires ?? [];
      const local = snapshotPrefs([
        entry.pref,
        ...requirements.map(([pref]) => pref),
      ]);
      let tab;
      try {
        for (let [pref, value] of requirements) {
          setRequirement(pref, value);
        }
        const baseValue = Services.prefs.getBoolPref(entry.pref, false);
        tab = await openCaptureTab(entry);
        const browser = tab.linkedBrowser;
        await preparePage(browser, entry);
        await settleContent(browser);
        const beforeStyles = await captureComputedStyles(browser, entry);
        const before = await captureBrowser(browser);

        Services.prefs.setBoolPref(entry.pref, !baseValue);
        await settleContent(browser);
        const afterStyles = await captureComputedStyles(browser, entry);
        const after = await captureBrowser(browser);
        if (beforeStyles.length) {
          ok(
            beforeStyles.some(
              (reading, styleIndex) =>
                reading.value != afterStyles[styleIndex].value
            ),
            `${entry.pref} changes the captured computed styles`
          );
        }
        await writeComparison(
          index,
          entry,
          baseValue,
          before,
          after,
          beforeStyles,
          afterStyles
        );
      } finally {
        if (tab && !tab.closing) {
          BrowserTestUtils.removeTab(tab);
        }
        restorePrefs(local);
        await TestUtils.waitForTick();
      }
    }
  } finally {
    restorePrefs(original);
    await TestUtils.waitForTick();
  }
  ok(true, `${captures.length} userContent comparisons written`);
});
