/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TabGrouping } = ChromeUtils.importESModule(
  "resource:///modules/TabGrouping.sys.mjs"
);

add_setup(async function () {
  TabGrouping.onWindowOpened(window);
  TabGrouping._suspended = false;
});

async function withTabGroup(callback) {
  const tabA = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const tabB = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const group = gBrowser.addTabGroup([tabA, tabB]);
  try {
    await callback(group, tabA, tabB);
  } finally {
    for (const tab of [...group.tabs]) {
      BrowserTestUtils.removeTab(tab);
    }
  }
}

add_task(async function test_new_tab_joins_source_group() {
  await withTabGroup(async (group, tabA) => {
    await BrowserTestUtils.switchTab(gBrowser, tabA);

    const newTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
    await TestUtils.waitForCondition(
      () => newTab.group === group,
      "The new tab joins the source tab's group"
    );
    is(newTab.group, group, "The new tab is in the group");
    is(
      newTab.previousElementSibling,
      tabA,
      "The new tab sits right after the source tab"
    );
  });
});

add_task(async function test_disabled_pref_leaves_tabs_alone() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.autoGroupNewTabs", false]],
  });
  await withTabGroup(async (group, tabA) => {
    await BrowserTestUtils.switchTab(gBrowser, tabA);

    const newTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
    await TestUtils.waitForTick();
    ok(!newTab.group, "The new tab stays ungrouped while the feature is off");
    BrowserTestUtils.removeTab(newTab);
  });
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_ungrouped_source_leaves_tabs_alone() {
  const plain = BrowserTestUtils.addTab(gBrowser, "about:blank");
  await BrowserTestUtils.switchTab(gBrowser, plain);

  const newTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  await TestUtils.waitForTick();
  ok(!newTab.group, "No grouping happens when the source has no group");

  BrowserTestUtils.removeTab(newTab);
  BrowserTestUtils.removeTab(plain);
});
