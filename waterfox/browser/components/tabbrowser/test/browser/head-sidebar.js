/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head.js */
/* exported SIDEBAR_VISIBILITY_PREF, setupSidebarTests, withSidebarPrefs,
            withSidebarPosition, moveToContent, startHover, waitForRepaint */

const { SidebarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SidebarTestUtils.sys.mjs"
);
SidebarTestUtils.init(this);

const SIDEBAR_VISIBILITY_PREF = "sidebar.visibility";
const POSITION_SETTING_PREF = "sidebar.position_start";

async function setupSidebarTests(visibility = "always-show") {
  await SidebarController.promiseInitialized;
  // Cleanup is FIFO: the tree head runs first, then hover/prefs, then UI state.
  registerCleanupFunction(async () => {
    await SidebarController.toggleExpandOnHover(false);
    await SpecialPowers.popPrefEnv();
  });
  SidebarTestUtils.restoreStateAtCleanup(window);
  registerCleanupFunction(() => {
    window.windowUtils.disableNonTestMouseEvents(false);
  });

  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_SIDEBAR_REVAMP, true],
      [PREF_VERTICAL_TABS, true],
      [PREF_TREE_ENABLED, true],
      [SIDEBAR_VISIBILITY_PREF, visibility],
      ["sidebar.animation.enabled", false],
      ["sidebar.animation.expand-on-hover.delay-duration-ms", 60000],
    ],
  });
  await SidebarTestUtils.waitForTabstripOrientation(window, "vertical");
  window.windowUtils.disableNonTestMouseEvents(true);
  moveToContent();
  await SidebarController.toggleExpandOnHover(visibility === "expand-on-hover");
}

async function withSidebarPrefs(prefs, task) {
  await SpecialPowers.pushPrefEnv({ set: prefs });
  try {
    await task();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

async function withSidebarPosition(positionStart, task) {
  await withSidebarPrefs([[POSITION_SETTING_PREF, positionStart]], task);
}

function moveToContent() {
  EventUtils.synthesizeMouseAtCenter(SidebarController.contentArea, {
    type: "mousemove",
  });
}

async function startHover() {
  moveToContent();
  await SidebarController.waitUntilStable();
  EventUtils.synthesizeMouse(SidebarController.sidebarMain, 10, 100, {
    type: "mousemove",
  });
  await TestUtils.waitForCondition(
    () => SidebarController.mouseEnterTask?.isArmed,
    "Hover expansion is pending"
  );
  return SidebarController.mouseEnterTask;
}

async function waitForRepaint() {
  await SidebarController.waitUntilStable();
  await new Promise(resolve => {
    requestAnimationFrame(() => Services.tm.dispatchToMainThread(resolve));
  });
}
