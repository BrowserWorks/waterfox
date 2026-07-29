/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

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
