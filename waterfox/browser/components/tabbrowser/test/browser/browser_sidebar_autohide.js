/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head-sidebar.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head-sidebar.js",
  this
);

const AUTO_HIDE_PREF = "sidebar.autoHide";
const { DOMFullscreenTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/DOMFullscreenTestUtils.sys.mjs"
);

add_setup(async () => {
  await setupSidebarTests("expand-on-hover");
  DOMFullscreenTestUtils.init(this, window);
});

function assertEdgeOnly() {
  const { sidebarContainer, sidebarMain } = SidebarController;

  is(
    sidebarContainer.getBoundingClientRect().width,
    4,
    "Only a 4px edge remains"
  );
  is(
    getComputedStyle(sidebarMain).opacity,
    "0",
    "The icon rail is not painted"
  );
  is(
    getComputedStyle(sidebarMain).pointerEvents,
    "none",
    "Hidden controls cannot intercept edge clicks"
  );
  is(
    getComputedStyle(SidebarController.launcherSplitter).display,
    "none",
    "The hidden launcher has no resize splitter"
  );
}

async function hoverEdge() {
  moveToContent();
  await waitForRepaint();
  EventUtils.synthesizeMouse(SidebarController.sidebarContainer, 2, 100, {
    type: "mousemove",
  });
  await TestUtils.waitForCondition(
    () => SidebarController.mouseEnterTask?.isArmed,
    "The thin edge arms hover expansion"
  );
  return SidebarController.mouseEnterTask;
}

add_task(async function test_opt_in_and_live_pref_changes() {
  ok(
    !Services.prefs.getDefaultBranch("").getBoolPref(AUTO_HIDE_PREF),
    "Auto-hide is off by default"
  );
  await withSidebarPrefs([[AUTO_HIDE_PREF, false]], async () => {
    await SidebarController.toggleExpandOnHover(true);
    const railWidth =
      SidebarController.sidebarContainer.getBoundingClientRect().width;
    Assert.greater(railWidth, 4, "Normal hover mode retains its icon rail");
    await withSidebarPrefs([[AUTO_HIDE_PREF, true]], async () => {
      await TestUtils.waitForCondition(
        () =>
          SidebarController.sidebarContainer.getBoundingClientRect().width ===
          4,
        "The preference applies without restarting"
      );
      await waitForRepaint();
      assertEdgeOnly();
    });
    await TestUtils.waitForCondition(
      () =>
        SidebarController.sidebarContainer.getBoundingClientRect().width ===
        railWidth,
      "Disabling auto-hide restores the normal rail"
    );
    await waitForRepaint();
    is(
      getComputedStyle(SidebarController.sidebarMain).opacity,
      "1",
      "Rail controls return"
    );
  });
});

add_task(async function test_hover_geometry_and_cancellation() {
  for (const nova of [false, true]) {
    for (const rtl of [false, true]) {
      await withSidebarPrefs(
        [
          [AUTO_HIDE_PREF, true],
          ["browser.nova.enabled", nova],
          ["intl.l10n.pseudo", rtl ? "bidi" : ""],
        ],
        async () => {
          for (const positionStart of [true, false]) {
            await withSidebarPosition(positionStart, async () => {
              await SidebarController.toggleExpandOnHover(true);
              await waitForRepaint();
              assertEdgeOnly();
              const contentRect =
                SidebarController.contentArea.getBoundingClientRect();
              let task = await hoverEdge();
              const complete = SidebarController.expandOnHoverComplete;
              moveToContent();
              ok(!task.isArmed, "Leaving the edge cancels pending expansion");
              await task.finalize();
              await complete;
              assertEdgeOnly();

              task = await hoverEdge();
              await task.finalize();
              await waitForRepaint();
              ok(
                SidebarController._state.launcherExpanded,
                "Hover reveals the sidebar"
              );
              is(
                getComputedStyle(SidebarController.sidebarMain).opacity,
                "1",
                "Controls are painted"
              );
              const expandedContentRect =
                SidebarController.contentArea.getBoundingClientRect();
              is(
                expandedContentRect.x,
                contentRect.x,
                "Hover does not shift content"
              );
              is(
                expandedContentRect.width,
                contentRect.width,
                "Hover does not resize content"
              );
              moveToContent();
              await waitForRepaint();
              assertEdgeOnly();
            });
          }
        }
      );
    }
  }
});

add_task(async function test_keyboard_focus_and_escape() {
  await withSidebarPrefs([[AUTO_HIDE_PREF, true]], async () => {
    await SidebarController.toggleExpandOnHover(true);
    moveToContent();
    try {
      gBrowser.selectedTab.focus();
      await waitForRepaint();
      ok(
        SidebarController.sidebarMain.matches(":focus-within"),
        "Focus enters the hidden rail"
      );
      ok(
        SidebarController._state.launcherExpanded,
        "Keyboard focus reveals the sidebar"
      );
      ok(
        !SidebarController.mouseEnterTask?.isArmed,
        "Keyboard access needs no hover delay"
      );
      moveToContent();
      await waitForRepaint();
      ok(
        SidebarController._state.launcherExpanded,
        "Pointer exit cannot hide focused controls"
      );
      EventUtils.synthesizeKey("KEY_Escape");
      await waitForRepaint();
      ok(
        !SidebarController.sidebarMain.matches(":focus-within"),
        "Escape moves focus out before hiding"
      );
      assertEdgeOnly();

      gBrowser.selectedTab.focus();
      await waitForRepaint();
      ok(
        SidebarController._state.launcherExpanded,
        "Focus can reveal the sidebar again after Escape"
      );
      gBrowser.selectedBrowser.focus();
      await waitForRepaint();
      assertEdgeOnly();
    } finally {
      gBrowser.selectedBrowser.focus();
    }
  });
});

add_task(async function test_keyboard_focus_during_collapse() {
  for (const nova of [false, true]) {
    await withSidebarPrefs(
      [
        [AUTO_HIDE_PREF, true],
        ["browser.nova.enabled", nova],
        ["sidebar.animation.enabled", true],
        ["sidebar.animation.expand-on-hover.duration-ms", 60000],
        ["ui.prefersReducedMotion", 0],
      ],
      async () => {
        await TestUtils.waitForCondition(
          () => !window.gReduceMotion,
          "Animations are enabled even when the OS prefers reduced motion"
        );
        for (const positionStart of [true, false]) {
          await withSidebarPosition(positionStart, async () => {
            for (const pending of [false, true]) {
              await SidebarController.toggleExpandOnHover(true);
              moveToContent();
              gBrowser.selectedTab.focus();
              await waitForRepaint();
              const expandedWidth =
                SidebarController.sidebarContainer.getBoundingClientRect()
                  .width;
              let animations = [];
              try {
                gBrowser.selectedBrowser.focus();
                SidebarController.onMouseLeave();
                ok(
                  !SidebarController._state.launcherExpanded,
                  "Collapse has started"
                );
                if (pending) {
                  is(
                    SidebarController._ongoingAnimations.length,
                    0,
                    "Collapse is still waiting for Lit"
                  );
                } else {
                  await TestUtils.waitForCondition(
                    () => !!SidebarController._ongoingAnimations.length,
                    "Collapse animations have been created"
                  );
                  animations = [...SidebarController._ongoingAnimations];
                  for (const animation of animations) {
                    animation.pause();
                    animation.currentTime = 59000;
                  }
                }
                const finished = Promise.allSettled(
                  animations.map(animation => animation.finished)
                );
                gBrowser.selectedTab.focus();
                ok(
                  SidebarController._state.launcherExpanded,
                  "Focus immediately reverses collapse"
                );
                is(
                  SidebarController._ongoingAnimations.length,
                  0,
                  "Focus cancels animation ownership immediately"
                );
                for (const animation of animations) {
                  is(
                    animation.playState,
                    "idle",
                    "The old animation is cancelled, not left clipping focus"
                  );
                }
                for (const element of [
                  SidebarController.sidebarContainer,
                  SidebarController.sidebarMain,
                  SidebarController._box,
                  SidebarController.contentArea,
                ]) {
                  ok(
                    !element.hasAttribute("sidebar-ongoing-animations"),
                    "Animation markers are cleared synchronously"
                  );
                }
                for (const property of [
                  "minWidth",
                  "maxWidth",
                  "marginLeft",
                  "marginRight",
                  "display",
                ]) {
                  is(
                    SidebarController.sidebarContainer.style[property],
                    "",
                    `Temporary ${property} is cleared synchronously`
                  );
                }
                is(
                  getComputedStyle(SidebarController.sidebarContainer).clipPath,
                  "none",
                  "Focused controls are not clipped"
                );
                await finished;
                await TestUtils.waitForCondition(
                  () => SidebarController._hoverBlockerCount === 0,
                  "The cancelled invocation releases its hover blocker"
                );
                await waitForRepaint();
                is(
                  SidebarController._ongoingAnimations.length,
                  0,
                  "No stale collapse starts after the Lit update"
                );
                is(
                  SidebarController.sidebarContainer.getBoundingClientRect()
                    .width,
                  expandedWidth,
                  "The focused sidebar retains its full width"
                );
                ok(
                  SidebarController.sidebarMain.matches(":focus-within"),
                  "Keyboard focus stays in the visible sidebar"
                );
                ok(
                  MousePosTracker._listeners.has(SidebarController),
                  "Hover tracking resumes after cancellation"
                );
              } finally {
                await withSidebarPrefs(
                  [["sidebar.animation.enabled", false]],
                  async () => {
                    for (const animation of SidebarController._ongoingAnimations) {
                      animation.finish();
                    }
                    gBrowser.selectedBrowser.focus();
                    await waitForRepaint();
                  }
                );
              }
              assertEdgeOnly();
            }
          });
        }
      }
    );
  }
});

add_task(async function test_popup_and_toolbar_override() {
  await withSidebarPrefs([[AUTO_HIDE_PREF, true]], async () => {
    await SidebarController.toggleExpandOnHover(true);
    const task = await hoverEdge();
    await task.finalize();
    await waitForRepaint();
    try {
      await openTabContextMenu(gBrowser.selectedTab);
      moveToContent();
      await waitForRepaint();
      ok(
        SidebarController._state.launcherExpanded,
        "A popup keeps its launcher visible"
      );
    } finally {
      await closeTabContextMenu();
      gBrowser.selectedBrowser.focus();
    }
    await waitForRepaint();
    assertEdgeOnly();

    await SidebarController.handleToolbarButtonClick();
    await waitForRepaint();
    ok(
      !SidebarController.autoHideActive,
      "The toolbar toggle pins the sidebar open"
    );
    moveToContent();
    await waitForRepaint();
    ok(
      SidebarController._state.launcherExpanded,
      "The pinned sidebar stays open"
    );
    await SidebarController.handleToolbarButtonClick();
    await waitForRepaint();
    assertEdgeOnly();
  });
});

add_task(async function test_animation_and_horizontal_tabs() {
  await withSidebarPrefs(
    [
      [AUTO_HIDE_PREF, true],
      ["sidebar.animation.enabled", true],
    ],
    async () => {
      await SidebarController.toggleExpandOnHover(true);
      const task = await hoverEdge();
      await task.finalize();
      await waitForRepaint();
      moveToContent();
      await SidebarController.waitUntilStable();
      is(
        SidebarController._ongoingAnimations.length,
        0,
        "Stability includes animations queued before the Lit update"
      );
      is(
        SidebarController._hoverBlockerCount,
        0,
        "Stability includes animation cleanup and blocker release"
      );
      ok(
        !SidebarController.sidebarContainer.hasAttribute(
          "sidebar-ongoing-animations"
        ),
        "No animation styles remain after waiting for stability"
      );
      assertEdgeOnly();
      await withSidebarPrefs([[PREF_VERTICAL_TABS, false]], async () => {
        await SidebarTestUtils.waitForTabstripOrientation(window, "horizontal");
        await waitForRepaint();
        ok(
          !SidebarController.autoHideActive,
          "Horizontal tabs do not auto-hide"
        );
        is(
          getComputedStyle(SidebarController.sidebarMain).opacity,
          "1",
          "Horizontal sidebar controls are not concealed"
        );
      });
      await SidebarTestUtils.waitForTabstripOrientation(window, "vertical");
      await SidebarController.toggleExpandOnHover(true);
      await waitForRepaint();
      assertEdgeOnly();
    }
  );
});

add_task(async function test_open_panel_and_window_exit() {
  await withSidebarPrefs([[AUTO_HIDE_PREF, true]], async () => {
    await SidebarController.toggleExpandOnHover(true);
    for (const positionStart of [true, false]) {
      await withSidebarPosition(positionStart, async () => {
        await SidebarController.show("viewBookmarksSidebar");
        try {
          gBrowser.selectedBrowser.focus();
          moveToContent();
          await waitForRepaint();
          assertEdgeOnly();
          const panelRect = SidebarController._box.getBoundingClientRect();
          const task = await hoverEdge();
          await task.finalize();
          await waitForRepaint();
          const expandedPanelRect =
            SidebarController._box.getBoundingClientRect();
          is(
            expandedPanelRect.x,
            panelRect.x,
            "Hover does not shift the open panel"
          );
          is(
            expandedPanelRect.width,
            panelRect.width,
            "Hover does not resize the open panel"
          );
          window.dispatchEvent(new Event("deactivate"));
          await waitForRepaint();
          assertEdgeOnly();
          ok(
            SidebarController.isOpen,
            "An explicitly opened panel remains open"
          );
        } finally {
          SidebarController.hide();
        }
      });
    }
  });
});

add_task(async function test_browser_fullscreen() {
  await withSidebarPrefs([[AUTO_HIDE_PREF, true]], async () => {
    await SidebarController.toggleExpandOnHover(true);
    let fullscreen = BrowserTestUtils.waitForEvent(window, "fullscreen");
    document.getElementById("View:FullScreen").doCommand();
    await fullscreen;
    try {
      await SimpleTest.promiseFocus(window);
      moveToContent();
      await waitForRepaint();
      assertEdgeOnly();
      const task = await hoverEdge();
      await task.finalize();
      await waitForRepaint();
      ok(
        SidebarController._state.launcherExpanded,
        "Browser fullscreen retains edge access"
      );
      moveToContent();
      await waitForRepaint();
      assertEdgeOnly();
    } finally {
      fullscreen = BrowserTestUtils.waitForEvent(window, "fullscreen");
      document.getElementById("View:FullScreen").doCommand();
      await fullscreen;
    }
    await waitForRepaint();
    assertEdgeOnly();
  });
});

add_task(async function test_dom_fullscreen() {
  await withSidebarPrefs([[AUTO_HIDE_PREF, true]], async () => {
    await BrowserTestUtils.withNewTab(
      { gBrowser, url: "https://example.com/" },
      async browser => {
        for (const expanded of [false, true]) {
          await SidebarController.toggleExpandOnHover(true);
          const task = await hoverEdge();
          if (expanded) {
            await task.finalize();
            await waitForRepaint();
          }
          await DOMFullscreenTestUtils.changeFullscreen(browser, true);
          try {
            is(
              getComputedStyle(SidebarController.sidebarContainer).display,
              "none",
              "DOM fullscreen removes even the edge trigger"
            );
            ok(!task.isArmed, "Fullscreen cancels pending hover");
            SidebarController.onMouseEnter();
            ok(
              !SidebarController.mouseEnterTask.isArmed,
              "Fullscreen cannot arm expansion"
            );
            const style = getComputedStyle(SidebarController.contentArea);
            is(style.marginInlineStart, "0px", "No start-side fullscreen gap");
            is(style.marginInlineEnd, "0px", "No end-side fullscreen gap");
          } finally {
            await DOMFullscreenTestUtils.changeFullscreen(browser, false);
          }
          await waitForRepaint();
          assertEdgeOnly();
        }
      }
    );
  });
});

add_task(async function test_setting_binding() {
  await withSidebarPrefs(
    [
      [AUTO_HIDE_PREF, false],
      [SIDEBAR_VISIBILITY_PREF, "always-show"],
      ["browser.settings-redesign.enabled", true],
    ],
    async () => {
      await BrowserTestUtils.withNewTab(
        { gBrowser, url: "about:preferences#tabsBrowsing" },
        async browser => {
          const doc = browser.contentDocument;
          let toggle;
          await TestUtils.waitForCondition(() => {
            toggle = doc
              .getElementById("setting-control-waterfox-sidebar-auto-hide")
              ?.querySelector("moz-toggle");
            return toggle;
          }, "The auto-hide setting renders");
          await toggle.updateComplete;
          const [message] = await doc.l10n.formatMessages([
            { id: "waterfox-appearance-autohide-sidebar-toggle" },
          ]);
          const label = message?.attributes?.find(
            attribute => attribute.name === "label"
          )?.value;
          ok(label, "The Tabs pane can resolve the appearance.ftl label");
          await TestUtils.waitForCondition(
            () => toggle.label === label,
            "The auto-hide toggle displays its localized label"
          );
          ok(!toggle.pressed, "Auto-hide starts unchecked");
          toggle.scrollIntoView({ block: "center" });
          EventUtils.synthesizeMouseAtCenter(toggle, {}, doc.defaultView);
          await TestUtils.waitForCondition(
            () => Services.prefs.getBoolPref(AUTO_HIDE_PREF),
            "The setting enables auto-hide"
          );
          is(
            Services.prefs.getStringPref(SIDEBAR_VISIBILITY_PREF),
            "expand-on-hover",
            "Enabling auto-hide selects hover mode"
          );
          await TestUtils.waitForCondition(
            () => toggle.pressed,
            "The toggle reflects auto-hide"
          );
          toggle.scrollIntoView({ block: "center" });
          EventUtils.synthesizeMouseAtCenter(toggle, {}, doc.defaultView);
          await TestUtils.waitForCondition(
            () => !Services.prefs.getBoolPref(AUTO_HIDE_PREF),
            "The setting disables auto-hide"
          );
          is(
            Services.prefs.getStringPref(SIDEBAR_VISIBILITY_PREF),
            "expand-on-hover",
            "Disabling auto-hide preserves normal hover mode"
          );
        }
      );
    }
  );
});
