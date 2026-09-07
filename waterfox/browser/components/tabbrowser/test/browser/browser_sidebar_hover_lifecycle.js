/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head-sidebar.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head-sidebar.js",
  this
);

add_setup(() => setupSidebarTests("expand-on-hover"));

function leaveWindow() {
  const rect = SidebarController.sidebarMain.getBoundingClientRect();
  // Window exits can report the last position inside the window.
  document.documentElement.dispatchEvent(
    new MouseEvent("mouseout", {
      bubbles: true,
      relatedTarget: null,
      screenX: window.mozInnerScreenX + rect.left + 10,
      screenY: window.mozInnerScreenY + rect.top + 100,
    })
  );
}

add_task(async function test_cancel_pending_hover_on_leave() {
  for (const positionStart of [true, false]) {
    await withSidebarPosition(positionStart, async () => {
      for (const leave of [
        moveToContent,
        leaveWindow,
        () => window.dispatchEvent(new Event("deactivate")),
      ]) {
        const task = await startHover();
        const complete = SidebarController.expandOnHoverComplete;
        leave();
        ok(!task.isArmed, "Leaving cancels the pending hover delay");
        await task.finalize();
        await complete;
        ok(
          !SidebarController._state.launcherExpanded,
          "No expansion after the pointer leaves"
        );
      }
    });
  }
});

add_task(async function test_collapse_at_outer_window_edge() {
  for (const positionStart of [true, false]) {
    await withSidebarPosition(positionStart, async () => {
      const task = await startHover();
      await task.finalize();
      await SidebarController.waitUntilStable();
      ok(
        SidebarController._state.launcherExpanded,
        "Hover expanded the sidebar"
      );

      leaveWindow();
      await SidebarController.waitUntilStable();
      ok(
        !SidebarController._state.launcherExpanded,
        "Window exit collapses without moving into content"
      );
      ok(
        !SidebarController._state.launcherHoverActive,
        "Hover overlay cleared"
      );
    });
  }
});

add_task(async function test_context_menu_outside_launcher() {
  for (const positionStart of [true, false]) {
    await withSidebarPosition(positionStart, async () => {
      const task = await startHover();
      await task.finalize();
      await waitForRepaint();
      const menu = document.getElementById("tabContextMenu");
      const tab = gBrowser.selectedTab;
      const rect = tab.getBoundingClientRect();
      const sidebarRect = SidebarController.sidebarMain.getBoundingClientRect();
      let showingCount = 0;
      const duringShowing = event => {
        if (event.target === menu) {
          showingCount++;
          leaveWindow();
          ok(
            SidebarController._state.launcherExpanded,
            "Opening a native menu must not collapse its launcher"
          );
        }
      };
      window.addEventListener("popupshowing", duringShowing);
      try {
        const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
        EventUtils.synthesizeMouse(
          tab,
          positionStart ? rect.width - 5 : 5,
          rect.height / 2,
          { type: "contextmenu", button: 2 }
        );
        await shown;
        is(showingCount, 1, "Exercised window exit during popupshowing");
        const menuRect = menu.getBoundingClientRect();
        if (menuRect.width) {
          ok(
            menuRect.left < sidebarRect.left ||
              menuRect.right > sidebarRect.right,
            "The context menu extends outside the sidebar"
          );
        } else {
          info("Native menu bounds unavailable; testing window-exit handling");
        }
        SidebarController._addHoverStateBlocker();
        SidebarController._removeHoverStateBlocker();
        ok(
          SidebarController._state.launcherExpanded,
          "Animation completion cannot override the open menu blocker"
        );
        await closeTabContextMenu();
        await SidebarController.waitUntilStable();
        ok(
          SidebarController._state.launcherExpanded,
          "Closing a menu with the pointer inside keeps the sidebar expanded"
        );
        await openTabContextMenu(tab);
        is(showingCount, 2, "Exercised popupshowing again after reopening");
        moveToContent();
        await waitForRepaint();
        ok(
          SidebarController._state.launcherExpanded,
          "An open menu keeps the sidebar expanded with the pointer outside"
        );
      } finally {
        window.removeEventListener("popupshowing", duringShowing);
        await closeTabContextMenu();
      }
      await SidebarController.waitUntilStable();
      ok(
        !SidebarController._state.launcherExpanded,
        "Closing the menu with the pointer outside collapses the sidebar"
      );
    });
  }
});

add_task(async function test_cancel_pending_hover_when_disabled() {
  const task = await startHover();
  const complete = SidebarController.expandOnHoverComplete;
  await SidebarController.toggleExpandOnHover(false);
  ok(!task.isArmed, "Disabling hover cancels the pending delay");
  await task.finalize();
  await complete;
  ok(!SidebarController._state.launcherExpanded, "No delayed expansion occurs");

  const enabling = SidebarController.toggleExpandOnHover(true);
  await SidebarController.toggleExpandOnHover(false);
  await enabling;
  ok(
    !document.documentElement.hasAttribute("sidebar-expand-on-hover"),
    "An earlier pending enable cannot re-enable hover"
  );
  ok(
    !MousePosTracker._listeners.has(SidebarController),
    "The disabled controller no longer tracks the pointer"
  );
});
