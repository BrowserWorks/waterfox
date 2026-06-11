/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { PrivateTab } = ChromeUtils.importESModule(
  "resource:///modules/PrivateTab.sys.mjs"
);

const TEST_URL = "https://example.com/";

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("browser.tabs.selectedTabPrivate");
});

add_task(async function test_container_exists() {
  ok(PrivateTab.container, "The private container exists");
  is(PrivateTab.container.name, "Private", "The container keeps its 140 name");
  Assert.greater(
    PrivateTab.userContextId,
    0,
    "The container has a user context id"
  );
});

add_task(async function test_toggle_private_and_back() {
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, TEST_URL);

  let privateTab = await PrivateTab.togglePrivate(window, tab);
  is(
    privateTab.userContextId,
    PrivateTab.userContextId,
    "The toggled tab joins the private container"
  );
  await BrowserTestUtils.browserLoaded(
    privateTab.linkedBrowser,
    false,
    null,
    true
  );
  is(
    privateTab.linkedBrowser.currentURI.spec,
    TEST_URL,
    "The page survives the toggle"
  );
  ok(
    privateTab.hasAttribute("waterfox-private"),
    "The tab carries the styling attribute"
  );
  is(gBrowser.selectedTab, privateTab, "The toggled tab stays selected");
  ok(gURLBar.isPrivate, "The urlbar treats the private tab as private");
  is(
    Services.prefs.getBoolPref("browser.tabs.selectedTabPrivate"),
    true,
    "The selected tab private pref follows the selection"
  );
  ok(
    document.documentElement.hasAttribute("waterfox-private-tab"),
    "The window indicator attribute is set"
  );

  let normalTab = await PrivateTab.togglePrivate(window, privateTab);
  is(normalTab.userContextId, 0, "Toggling back leaves the container");
  await BrowserTestUtils.browserLoaded(
    normalTab.linkedBrowser,
    false,
    null,
    true
  );
  ok(!gURLBar.isPrivate, "The urlbar returns to normal");

  BrowserTestUtils.removeTab(normalTab);
});

add_task(async function test_new_private_tab() {
  let tab = PrivateTab.openNewPrivateTab(window);
  is(
    tab.userContextId,
    PrivateTab.userContextId,
    "The new tab opens in the private container"
  );
  BrowserTestUtils.removeTab(tab);
  is(
    Services.prefs.getBoolPref("browser.tabs.selectedTabPrivate"),
    false,
    "The pref clears once a normal tab is selected again"
  );
});

add_task(async function test_content_window_private_pref() {
  Services.prefs.setBoolPref("browser.tabs.selectedTabPrivate", true);
  ok(
    PrivateBrowsingUtils.isContentWindowPrivate(window),
    "isContentWindowPrivate honors the selected tab pref"
  );
  Services.prefs.setBoolPref("browser.tabs.selectedTabPrivate", false);
  ok(
    !PrivateBrowsingUtils.isContentWindowPrivate(window),
    "isContentWindowPrivate returns to the load context"
  );
});

add_task(async function test_open_link_in_private_tab() {
  const sourceURL =
    "https://example.org/document-builder.sjs?html=" +
    encodeURIComponent(`<a id="link" href="${TEST_URL}">link</a>`);

  await BrowserTestUtils.withNewTab(sourceURL, async browser => {
    const popupShown = BrowserTestUtils.waitForEvent(
      document,
      "popupshown",
      false,
      event => event.target.id == "contentAreaContextMenu"
    );
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#link",
      { type: "contextmenu" },
      browser
    );
    await popupShown;

    const contextMenu = document.getElementById("contentAreaContextMenu");
    const menuItem = document.getElementById("openLinkInPrivateTab");
    ok(!menuItem.hidden, "The private tab menu item is visible for links");
    is(
      menuItem.previousElementSibling.id,
      "context-openlinkintab",
      "The private tab menu item follows the regular tab item"
    );

    const tabOpened = BrowserTestUtils.waitForNewTab(gBrowser, TEST_URL, true);
    contextMenu.activateItem(menuItem);
    const tab = await tabOpened;

    is(
      tab.userContextId,
      PrivateTab.userContextId,
      "The link opens in the private container"
    );
    BrowserTestUtils.removeTab(tab);
  });
});

add_task(async function test_menu_items_exist() {
  for (let id of [
    "toggleTabPrivateState",
    "menu_newPrivateTab",
    "openLinkInPrivateTab",
    "openPrivate",
    "openAllPrivate",
    "openAllLinksPrivate",
  ]) {
    ok(document.getElementById(id), `The ${id} menu item exists`);
  }
});
