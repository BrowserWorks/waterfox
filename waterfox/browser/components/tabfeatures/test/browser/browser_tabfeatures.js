/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TabFeatures } = ChromeUtils.importESModule(
  "resource:///modules/TabFeatures.sys.mjs"
);

add_setup(async function () {
  TabFeatures.onWindowOpened(window);
});

async function openTabContextMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

add_task(async function test_context_menu_visibility() {
  let menu = await openTabContextMenu(gBrowser.selectedTab);
  ok(
    !document.getElementById("context_copyTabUrl").hidden,
    "Copy URL shows by default"
  );
  ok(
    document.getElementById("context_copyAllTabUrls").hidden,
    "Copy all URLs hides by default"
  );
  await closeMenu(menu);

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.copyurl", false],
      ["browser.tabs.copyallurls", true],
    ],
  });
  menu = await openTabContextMenu(gBrowser.selectedTab);
  ok(
    document.getElementById("context_copyTabUrl").hidden,
    "Copy URL follows its pref"
  );
  ok(
    !document.getElementById("context_copyAllTabUrls").hidden,
    "Copy all URLs follows its pref"
  );
  await closeMenu(menu);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_duplicate_tab_pref() {
  let menu = await openTabContextMenu(gBrowser.selectedTab);
  ok(
    !document.getElementById("context_duplicateTab").hidden,
    "Duplicate Tab shows for a single tab"
  );
  ok(
    document.getElementById("context_duplicateTabs").hidden,
    "Duplicate Tabs hides for a single tab"
  );
  await closeMenu(menu);

  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.duplicateTab", false]],
  });
  menu = await openTabContextMenu(gBrowser.selectedTab);
  ok(
    document.getElementById("context_duplicateTab").hidden,
    "Duplicate Tab hides when the pref is off"
  );
  ok(
    document.getElementById("context_duplicateTabs").hidden,
    "Duplicate Tabs hides when the pref is off"
  );
  await closeMenu(menu);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_copy_tab_url() {
  const url = "https://example.com/copy-tab-url-test";
  await SimpleTest.promiseClipboardChange(url, () =>
    TabFeatures.copyTabUrl(window, url)
  );
  ok(true, "The tab URL reached the clipboard");
});

add_task(async function test_unread_attribute() {
  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/");
  await BrowserTestUtils.browserLoaded(tab.linkedBrowser);

  await TestUtils.waitForCondition(
    () => tab.hasAttribute("unread"),
    "A finished background load marks the tab unread"
  );

  await BrowserTestUtils.switchTab(gBrowser, tab);
  ok(!tab.hasAttribute("unread"), "Selecting the tab clears unread");

  BrowserTestUtils.removeTab(tab);
});
