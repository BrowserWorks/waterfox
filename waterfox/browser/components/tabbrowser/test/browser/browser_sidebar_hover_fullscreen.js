/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head-sidebar.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head-sidebar.js",
  this
);

const { DOMFullscreenTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/DOMFullscreenTestUtils.sys.mjs"
);

add_setup(async () => {
  await setupSidebarTests("expand-on-hover");
  DOMFullscreenTestUtils.init(this, window);
});

add_task(async function test_dom_fullscreen_with_hover_sidebar() {
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "https://example.com/" },
    async browser => {
      const tabbox = document.getElementById("tabbrowser-tabbox");
      for (const positionStart of [true, false]) {
        await withSidebarPosition(positionStart, async () => {
          for (const expanded of [false, true]) {
            moveToContent();
            await SidebarController.toggleExpandOnHover(true);
            const task = await startHover();
            const complete = SidebarController.expandOnHoverComplete;
            if (expanded) {
              await task.finalize();
              await SidebarController.waitUntilStable();
              ok(SidebarController._state.launcherExpanded, "Hover expanded");
            }
            await DOMFullscreenTestUtils.changeFullscreen(browser, true);
            try {
              is(document.fullscreenElement, browser, "Entered DOM fullscreen");
              for (const id of [
                "sidebar-container",
                "sidebar-box",
                "sidebar-splitter",
                "sidebar-launcher-splitter",
              ]) {
                is(
                  getComputedStyle(document.getElementById(id)).display,
                  "none",
                  `${id} has no fullscreen layout box`
                );
              }
              const style = getComputedStyle(tabbox);
              for (const side of ["marginInlineStart", "marginInlineEnd"]) {
                is(style[side], "0px", `Fullscreen has no ${side} sidebar gap`);
              }
              ok(!task.isArmed, "Fullscreen cancels pending expansion");
              await complete;
              ok(
                !SidebarController._state.launcherHoverActive,
                "Fullscreen clears the hover overlay"
              );
              SidebarController.onMouseEnter();
              ok(
                !SidebarController.mouseEnterTask.isArmed,
                "Pointer movement cannot expand the fullscreen sidebar"
              );
            } finally {
              await DOMFullscreenTestUtils.changeFullscreen(browser, false);
            }
            ok(
              BrowserTestUtils.isVisible(SidebarController.sidebarMain),
              "The sidebar returns after DOM fullscreen"
            );
          }
        });
      }
    }
  );
});
