/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(30);

const { WaterfoxBrowserStyle } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBrowserStyle.sys.mjs"
);

const OUT = Services.env.get("WFX_PREFS_SHOT_DIR");
const GROUPS = [
  "waterfoxBrowserStyle",
  "waterfoxThemeColors",
  "waterfoxStatusBar",
  "waterfoxInterfaceCustomizations",
  "waterfoxOptTabbar",
  "waterfoxOptTabs",
  "waterfoxOptToolbars",
  "waterfoxOptBookmarks",
  "waterfoxOptIcons",
  "waterfoxOptRounding",
  "waterfoxOptTheme",
  "waterfoxOptContent",
  "waterfoxOptNewtab",
  "waterfoxOptPlayer",
];

function settle(win) {
  return new Promise(resolve =>
    win.requestAnimationFrame(() => win.requestAnimationFrame(resolve))
  );
}

async function writeCapture(win, element, name) {
  const width = Math.ceil(win.innerWidth);
  const height = Math.ceil(win.innerHeight);
  const controls = Array.from(
    element.querySelectorAll('[id^="setting-control-"]')
  );
  const targets = [element];
  for (let index = 12; index < controls.length; index += 12) {
    targets.push(controls[index]);
  }
  if (controls.length > 12) {
    targets.push(controls.at(-1));
  }

  let index = 0;
  for (const target of new Set(targets)) {
    target.scrollIntoView({ block: target == element ? "start" : "center" });
    await settle(win);

    const canvas = win.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "canvas"
    );
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d").drawWindow(win, 0, 0, width, height, "white");
    const url = canvas.toDataURL("image/png");
    const bytes = Uint8Array.from(atob(url.split(",")[1]), char =>
      char.charCodeAt(0)
    );
    const filename = `${name}-${String(index++).padStart(2, "0")}.png`;
    await IOUtils.write(PathUtils.join(OUT, filename), bytes);
    info(`wrote ${filename} (${width}x${height})`);
  }
}

add_task(async function captureAppearancePane() {
  if (!OUT) {
    ok(true, "no preferences capture requested");
    return;
  }

  await IOUtils.makeDirectory(OUT, { ignoreExisting: true });
  // Use Photon because other styles hide some cards.
  WaterfoxBrowserStyle.setStyle("photon");
  registerCleanupFunction(() => WaterfoxBrowserStyle.setStyle("nova"));
  const tab = BrowserTestUtils.addTab(gBrowser, "about:preferences#appearance");
  const browser = tab.linkedBrowser;
  const initialized = BrowserTestUtils.waitForEvent(
    browser,
    "Initialized",
    true
  );
  gBrowser.selectedTab = tab;
  await initialized;
  const doc = browser.contentDocument;
  const contentWin = browser.contentWindow;

  try {
    for (const group of GROUPS) {
      await TestUtils.waitForCondition(
        () => doc.querySelector(`setting-group[groupid="${group}"]`),
        `${group} should render`
      );
    }
    await doc.l10n.ready;
    await settle(contentWin);

    for (const group of GROUPS) {
      const element = doc.querySelector(`setting-group[groupid="${group}"]`);
      ok(element, `${group} renders`);
      await writeCapture(contentWin, element, group);
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
