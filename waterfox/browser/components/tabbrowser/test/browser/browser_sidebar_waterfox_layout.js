/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head-sidebar.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head-sidebar.js",
  this
);

add_setup(() => setupSidebarTests());

function assertInsideSidebar(element, message) {
  const rect = element.getBoundingClientRect();
  const sidebar = SidebarController.sidebarMain.getBoundingClientRect();
  Assert.greater(rect.width, 0, `${message}: width`);
  Assert.greater(rect.height, 0, `${message}: height`);
  Assert.greaterOrEqual(rect.left, sidebar.left - 1, `${message}: left edge`);
  Assert.lessOrEqual(rect.right, sidebar.right + 1, `${message}: right edge`);
  return rect;
}

add_task(async function test_pinned_tab_list() {
  const tabs = [];
  try {
    for (let i = 0; i < 2; i++) {
      const tab = await BrowserTestUtils.openNewForegroundTab(
        gBrowser,
        `data:text/html,<title>Pinned tab ${i}</title>`
      );
      tabs.push(tab);
      gBrowser.pinTab(tab);
    }
    for (const treeEnabled of [false, true]) {
      for (const visibility of ["always-show", "expand-on-hover"]) {
        await withSidebarPrefs(
          [
            [PREF_TREE_ENABLED, treeEnabled],
            ["browser.tabs.pinnedIconOnly", false],
            [SIDEBAR_VISIBILITY_PREF, visibility],
          ],
          async () => {
            await SidebarController.toggleExpandOnHover(
              visibility === "expand-on-hover"
            );
            SidebarController._state.launcherExpanded = true;
            await waitForRepaint();
            const [first, second] = tabs.map(tab =>
              tab.getBoundingClientRect()
            );
            Assert.greater(first.width, 80, "Pinned rows fit titles");
            is(first.left, second.left, "Pinned list rows share a column");
            Assert.greaterOrEqual(
              second.top,
              first.bottom,
              "Pins use separate rows"
            );
            for (const tab of tabs) {
              const rect = assertInsideSidebar(tab, "Expanded pinned tab");
              const label = tab.querySelector(".tab-label-container");
              ok(BrowserTestUtils.isVisible(label), "Pinned title visible");
              Assert.greater(
                label.getBoundingClientRect().width,
                0,
                "Title has width"
              );
              ok(
                tab.contains(
                  document.elementFromPoint(
                    rect.x + rect.width / 2,
                    rect.y + rect.height / 2
                  )
                ),
                "The pinned tab receives pointer input"
              );
              ok(
                !gBrowser.tabContainer.isContainerVerticalPinnedGrid(tab),
                "Drag handling and hover previews treat labeled pins as a list"
              );
            }
            if (treeEnabled && visibility === "always-show") {
              EventUtils.synthesizeMouseAtCenter(tabs[0], {});
              is(
                gBrowser.selectedTab,
                tabs[0],
                "A labeled pin can be selected"
              );
              await openTabContextMenu(tabs[0]);
              try {
                ok(
                  !document.getElementById("context_unpinTab").hidden,
                  "The pinned tab exposes its unpin command"
                );
              } finally {
                await closeTabContextMenu();
              }
            }
            SidebarController._state.launcherExpanded = false;
            await waitForRepaint();
            for (const tab of tabs) {
              assertInsideSidebar(tab, "Collapsed pinned tab");
              const label = tab.querySelector(".tab-label-container");
              ok(
                BrowserTestUtils.isHidden(label),
                "Collapsed pins are icon-only"
              );
            }
          }
        );
      }
    }
    await SidebarController.toggleExpandOnHover(false);
    SidebarController._state.launcherExpanded = true;
    await withSidebarPrefs(
      [["browser.tabs.pinnedIconOnly", true]],
      async () => {
        await waitForRepaint();
        ok(
          gBrowser.tabContainer.isContainerVerticalPinnedGrid(tabs[0]),
          "Icon-only pins still use the grid"
        );
        for (const tab of tabs) {
          ok(
            BrowserTestUtils.isHidden(
              tab.querySelector(".tab-label-container")
            ),
            "The icon-only grid hides titles"
          );
        }
      }
    );
  } finally {
    for (const tab of tabs) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function test_collapsed_width_without_controls() {
  const controls = SidebarController.sidebarMain.buttonsWrapper;
  const wasHidden = controls.hidden;
  try {
    for (const positionStart of [true, false]) {
      await withSidebarPosition(positionStart, async () => {
        SidebarController._state.launcherExpanded = false;
        controls.hidden = true;
        await waitForRepaint();
        for (const selector of [".tab-background", ".tab-icon-image"]) {
          assertInsideSidebar(
            gBrowser.selectedTab.querySelector(selector),
            `${selector} fits without sidebar controls`
          );
        }
        await SidebarController.toggleExpandOnHover(true);
        const width =
          SidebarController.sidebarMain.getBoundingClientRect().width;
        const measured = parseFloat(
          document
            .getElementById("browser")
            .style.getPropertyValue("--sidebar-launcher-collapsed-width")
        );
        Assert.greaterOrEqual(
          measured,
          width,
          "Hover reserves collapsed width"
        );
        await SidebarController.toggleExpandOnHover(false);
      });
    }
  } finally {
    controls.hidden = wasHidden;
  }
});

add_task(async function test_private_new_tab_button_layout() {
  for (const treeEnabled of [false, true]) {
    await withSidebarPrefs(
      [
        ["browser.privateTab.showNewTabButton", true],
        [PREF_TREE_ENABLED, treeEnabled],
      ],
      async () => {
        SidebarController._state.launcherExpanded = false;
        await waitForRepaint();
        const normalButton = document.getElementById("tabs-newtab-button");
        const privateButton = document.getElementById("newPrivateTab-button");
        const normalIcon = normalButton.querySelector(".toolbarbutton-icon");
        const privateIcon = privateButton.querySelector(".toolbarbutton-icon");
        const privateLabel = privateButton.querySelector(".toolbarbutton-text");
        ok(
          BrowserTestUtils.isVisible(privateButton),
          "Private new-tab visible"
        );
        ok(BrowserTestUtils.isHidden(privateLabel), "Collapsed label hidden");
        const privateRect = assertInsideSidebar(privateIcon, "Private icon");
        const normalRect = normalIcon.getBoundingClientRect();
        is(privateRect.height, normalRect.height, "New-tab icon heights match");
        is(privateRect.x, normalRect.x, "New-tab icons align");
        is(
          normalButton.getBoundingClientRect().width,
          privateButton.getBoundingClientRect().width,
          "Collapsed new-tab button widths match"
        );
        ok(
          BrowserTestUtils.isHidden(
            document.getElementById("newPrivateTab-button-vertical")
          ),
          "The overflow-only private button is not duplicated"
        );
        SidebarController._state.launcherExpanded = true;
        await waitForRepaint();
        ok(BrowserTestUtils.isVisible(privateLabel), "Expanded label visible");
      }
    );
  }
});

add_task(async function test_narrow_private_new_tab_footer() {
  const { WaterfoxBrowserStyle } = ChromeUtils.importESModule(
    "resource:///modules/WaterfoxBrowserStyle.sys.mjs"
  );
  await withSidebarPrefs(
    [
      [PREF_TREE_ENABLED, true],
      ["browser.privateTab.showNewTabButton", true],
    ],
    async () => {
      const state = SidebarController._state;
      const originalWidth = state.expandedLauncherWidth;
      const originalExpanded = state.launcherExpanded;
      const privateButton = document.getElementById("newPrivateTab-button");
      await document.l10n.translateElements([privateButton]);
      const l10nId = privateButton.getAttribute("data-l10n-id");
      const label = privateButton.getAttribute("label");
      const tabs = [];
      const overflowTabs = [];
      const arrowScrollbox = gBrowser.tabContainer.arrowScrollbox;
      async function checkLayout(width, showButton = true) {
        await waitForRepaint();
        Assert.lessOrEqual(
          SidebarController.sidebarMain.getBoundingClientRect().width,
          width + 1,
          "The sidebar stays within the requested narrow width"
        );
        is(privateButton.hidden, !showButton, "The preference sets hidden");
        is(
          getComputedStyle(privateButton).display,
          showButton ? "flex" : "none",
          "The private footer respects the preference even during overflow"
        );
        is(
          getComputedStyle(
            document.getElementById("newPrivateTab-button-vertical")
          ).display,
          "none",
          "Tree tabs never show the duplicate private button"
        );
        const elements = [
          gBrowser.tabContainer,
          arrowScrollbox,
          document.getElementById("tabbrowser-arrowscrollbox-periphery"),
        ];
        if (showButton) {
          elements.push(
            privateButton,
            privateButton.querySelector(".toolbarbutton-icon"),
            privateButton.querySelector(".toolbarbutton-text")
          );
        }
        for (const element of elements) {
          assertInsideSidebar(element, "Private footer fits");
        }
        for (const tab of [...tabs, ...overflowTabs.slice(-1)]) {
          tab.scrollIntoView({ block: "nearest", behavior: "instant" });
          await waitForRepaint();
          EventUtils.synthesizeMouseAtCenter(tab, { type: "mousemove" });
          await waitForRepaint();
          assertInsideSidebar(tab, "Tree tab fits");
          const closeButton = tab.querySelector(".tab-close-button");
          ok(
            BrowserTestUtils.isVisible(closeButton),
            "The hovered tab has a visible close button"
          );
          const rect = assertInsideSidebar(closeButton, "Close button fits");
          ok(
            closeButton.contains(
              document.elementFromPoint(
                rect.x + rect.width / 2,
                rect.y + rect.height / 2
              )
            ),
            "The close button receives pointer input"
          );
        }
      }
      try {
        privateButton.removeAttribute("data-l10n-id");
        state.launcherExpanded = true;
        const parent = await BrowserTestUtils.openNewForegroundTab(
          gBrowser,
          "about:blank"
        );
        tabs.push(parent);
        tabs.push(await openTabWithTree(parent));
        for (const style of ["nova", "proton", "photon"]) {
          await withSidebarPrefs(
            [
              ["browser.theme.waterfox.browserStyle", style],
              ["browser.nova.enabled", style === "nova"],
              ...Object.entries(WaterfoxBrowserStyle.PRESETS[style]),
            ],
            async () => {
              for (const positionStart of [true, false]) {
                await withSidebarPosition(positionStart, async () => {
                  for (const width of [240, 200, 160]) {
                    state.expandedLauncherWidth = width;
                    for (const text of [label, `${label} `.repeat(8)]) {
                      info(
                        `${style}, positionStart=${positionStart}, width=${width}, label=${text}`
                      );
                      privateButton.setAttribute("label", text);
                      await checkLayout(width);
                    }
                  }
                });
              }
              state.expandedLauncherWidth = 200;
              for (const showAtTransition of [false, true]) {
                await withSidebarPrefs(
                  [["browser.privateTab.showNewTabButton", showAtTransition]],
                  async () => {
                    for (const overflowing of [false, true, false]) {
                      if (overflowing) {
                        const rowHeight = parent.getBoundingClientRect().height;
                        Assert.greater(rowHeight, 0, "Tab rows have height");
                        const count =
                          Math.ceil(
                            arrowScrollbox.getBoundingClientRect().height /
                              rowHeight
                          ) + 4;
                        for (let i = 0; i < count; i++) {
                          overflowTabs.push(
                            gBrowser.addTrustedTab("about:blank", {
                              relatedToCurrent: false,
                              skipAnimation: true,
                            })
                          );
                        }
                      } else {
                        while (overflowTabs.length) {
                          await BrowserTestUtils.removeTab(overflowTabs.pop());
                        }
                      }
                      await TestUtils.waitForCondition(
                        () =>
                          arrowScrollbox.hasAttribute("overflowing") ===
                            overflowing &&
                          gBrowser.tabContainer.hasAttribute("overflow") ===
                            overflowing,
                        `Real tab overflow becomes ${overflowing}`
                      );
                      is(
                        arrowScrollbox.scrollSize >
                          arrowScrollbox.scrollClientSize,
                        overflowing,
                        "The tab content really exceeds the scrollport only during overflow"
                      );
                      info(
                        `${style}, overflowing=${overflowing}, transition pref=${showAtTransition}`
                      );
                      for (const showButton of [false, true]) {
                        await withSidebarPrefs(
                          [["browser.privateTab.showNewTabButton", showButton]],
                          async () => {
                            await checkLayout(200, showButton);
                            is(
                              arrowScrollbox.hasAttribute("overflowing"),
                              overflowing,
                              "Toggling the private footer preserves the overflow state"
                            );
                          }
                        );
                      }
                    }
                  }
                );
              }
            }
          );
        }
      } finally {
        while (overflowTabs.length) {
          await BrowserTestUtils.removeTab(overflowTabs.pop());
        }
        privateButton.setAttribute("label", label);
        privateButton.setAttribute("data-l10n-id", l10nId);
        state.launcherExpanded = false;
        state.expandedLauncherWidth = originalWidth;
        state.launcherExpanded = originalExpanded;
        for (const tab of tabs.reverse()) {
          await BrowserTestUtils.removeTab(tab);
        }
      }
    }
  );
});
