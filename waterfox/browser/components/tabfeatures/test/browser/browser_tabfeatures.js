/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_unread_attribute_and_styling() {
  const pref = "browser.tabs.italicizeUnread";
  is(
    Services.prefs.getDefaultBranch("").getBoolPref(pref),
    false,
    "Unread tab italics are off by default"
  );
  await SpecialPowers.pushPrefEnv({ clear: [[pref]] });
  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/");
  try {
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    await TestUtils.waitForCondition(
      () => tab.hasAttribute("unread"),
      "A finished background load marks the tab unread"
    );

    const fontStyle = () =>
      window.getComputedStyle(tab.querySelector(".tab-label")).fontStyle;
    is(fontStyle(), "normal", "Unread tabs use normal text by default");

    await SpecialPowers.pushPrefEnv({ set: [[pref, true]] });
    try {
      await TestUtils.waitForCondition(
        () => fontStyle() === "italic",
        "The preference change has reached the unread-tab styling"
      );
      is(fontStyle(), "italic", "Enabling the pref italicizes unread tabs");
      tab.setAttribute("pending", "true");
      is(fontStyle(), "normal", "Unloaded unread tabs are not italicized");
      tab.removeAttribute("pending");
      is(fontStyle(), "italic", "Loaded unread tabs are italicized again");
    } finally {
      tab.removeAttribute("pending");
      await SpecialPowers.popPrefEnv();
    }
    await TestUtils.waitForCondition(
      () => fontStyle() === "normal",
      "Restoring the preference updates the unread-tab styling"
    );
    is(fontStyle(), "normal", "Disabling the pref removes italics");

    await SpecialPowers.pushPrefEnv({ set: [[pref, true]] });
    try {
      await TestUtils.waitForCondition(
        () => fontStyle() === "italic",
        "Unread-tab styling is active before testing selection"
      );
      await BrowserTestUtils.switchTab(gBrowser, tab);
      ok(!tab.hasAttribute("unread"), "Selecting the tab clears unread");
      is(fontStyle(), "normal", "Read tabs are not italicized");
      tab.setAttribute("unread", "true");
      is(fontStyle(), "normal", "Selected tabs are never italicized");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});
