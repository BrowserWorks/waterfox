/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head-sidebar.js */
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "head-sidebar.js",
  this
);

add_setup(() => setupSidebarTests());

function barStyle(tab) {
  return getComputedStyle(tab.querySelector(".tab-stack"), "::before");
}

add_task(async function test_vertical_bar_marks_only_active_tab() {
  await withSidebarPrefs(
    [
      ["browser.theme.waterfox.browserStyle", "photon"],
      ["browser.theme.waterfox.chromeSheet", 0],
      ["browser.nova.enabled", false],
      ["userChrome.tab.bar_separator", true],
      ["userChrome.tab.dynamic_separator", false],
      ["userChrome.tab.static_separator", false],
    ],
    async () => {
      const tabs = [];
      try {
        for (let i = 0; i < 2; i++) {
          tabs.push(
            await BrowserTestUtils.openNewForegroundTab(gBrowser, "about:blank")
          );
        }
        for (const treeEnabled of [false, true]) {
          await withSidebarPrefs(
            [[PREF_TREE_ENABLED, treeEnabled]],
            async () => {
              for (const expanded of [false, true]) {
                SidebarController._state.launcherExpanded = expanded;
                for (const selected of tabs) {
                  await BrowserTestUtils.switchTab(gBrowser, selected);
                  await waitForRepaint();
                  for (const tab of tabs) {
                    is(
                      barStyle(tab).content,
                      tab === selected ? '""' : "none",
                      `Only the active tab has a bar: tree=${treeEnabled}, expanded=${expanded}`
                    );
                  }
                  is(
                    barStyle(selected).width,
                    "3px",
                    "The active bar has width"
                  );
                  is(
                    barStyle(selected).height,
                    "20px",
                    "The active bar has height"
                  );
                }
              }
            }
          );
        }
        await withSidebarPrefs([[PREF_VERTICAL_TABS, false]], async () => {
          await SidebarTestUtils.waitForTabstripOrientation(
            window,
            "horizontal"
          );
          await waitForRepaint();
          for (const tab of tabs) {
            is(
              barStyle(tab).content,
              '""',
              "Horizontal tabs retain their bar separators"
            );
          }
        });
      } finally {
        for (const tab of tabs) {
          await BrowserTestUtils.removeTab(tab);
        }
      }
    }
  );
});
