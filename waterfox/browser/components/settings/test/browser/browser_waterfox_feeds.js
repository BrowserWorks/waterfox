/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const DISCOVERY_PREF = "browser.feeds.discovery.enabled";
const LOAD_IMAGES_PREF = "browser.feeds.loadImages";

async function getFeedsControl(doc, id, tag) {
  await settingGroupRenders(doc, "waterfoxFeeds");
  const selector = `#setting-control-${id} ${tag}`;
  await TestUtils.waitForCondition(
    () => doc.querySelector(selector),
    `The ${id} control renders`
  );
  const control = doc.querySelector(selector);
  await control.updateComplete;
  return control;
}

add_task(async function test_feeds_navigation_and_open() {
  for (const redesignEnabled of [true, false]) {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.settings-redesign.enabled", redesignEnabled],
        [DISCOVERY_PREF, false],
      ],
    });
    let tab;
    let feedsTab;
    try {
      tab = await openPrefsTab("feeds");
      const doc = tab.linkedBrowser.contentDocument;
      const win = doc.defaultView;
      const navButton = doc.getElementById("category-feeds");
      ok(
        BrowserTestUtils.isVisible(navButton),
        `The Feeds category is visible with redesign ${redesignEnabled}`
      );
      await getFeedsControl(doc, "waterfox-feeds-discovery", "moz-toggle");
      const pane = doc.querySelector('setting-pane[data-category="paneFeeds"]');
      ok(
        BrowserTestUtils.isVisible(pane),
        "The #feeds deep link opens the pane"
      );

      await win.gotoPref("home");
      ok(!BrowserTestUtils.isVisible(pane), "Navigating away hides the pane");
      EventUtils.synthesizeMouseAtCenter(navButton, {}, win);
      await TestUtils.waitForCondition(
        () => BrowserTestUtils.isVisible(pane),
        "Clicking the Feeds category opens the pane"
      );
      is(win.location.hash, "#feeds", "Navigation uses the Feeds deep link");

      const link = await getFeedsControl(
        doc,
        "waterfox-feeds-open",
        "moz-box-link"
      );
      ok(BrowserTestUtils.isVisible(link), "Open Feeds remains available");
      const opened = BrowserTestUtils.waitForNewTab(
        gBrowser,
        "about:feeds",
        true
      );
      link.focus();
      EventUtils.synthesizeKey("KEY_Enter", {}, win);
      feedsTab = await opened;
      is(
        tab.linkedBrowser.currentURI.spec,
        "about:preferences#feeds",
        "Opening Feeds leaves the Settings tab open"
      );
      ok(
        !Services.prefs.getBoolPref(DISCOVERY_PREF),
        "Opening Feeds does not enable discovery"
      );
    } finally {
      if (feedsTab) {
        BrowserTestUtils.removeTab(feedsTab);
      }
      if (tab) {
        BrowserTestUtils.removeTab(tab);
      }
      await SpecialPowers.popPrefEnv();
    }
  }
});

add_task(async function test_feeds_toggle_bindings() {
  const cases = [
    [DISCOVERY_PREF, "waterfox-feeds-discovery", true],
    [LOAD_IMAGES_PREF, "waterfox-feeds-load-images", false],
  ];
  await SpecialPowers.pushPrefEnv({
    set: cases.map(([pref, , initial]) => [pref, initial]),
  });
  let tab;
  try {
    tab = await openPrefsTab("feeds");
    const doc = tab.linkedBrowser.contentDocument;
    await settingGroupRenders(doc, "waterfoxFeedsSubscribe");
    for (const [pref, id, initial] of cases) {
      const toggle = await getFeedsControl(doc, id, "moz-toggle");
      ok(BrowserTestUtils.isVisible(toggle), `${id} is visible`);
      is(toggle.pressed, initial, `${id} reflects the initial preference`);

      const prefChanged = TestUtils.waitForPrefChange(pref);
      synthesizeClick(toggle);
      await prefChanged;
      is(
        Services.prefs.getBoolPref(pref),
        !initial,
        `${id} writes the preference`
      );
      await TestUtils.waitForCondition(
        () => toggle.pressed === !initial,
        `${id} reflects the click`
      );

      Services.prefs.setBoolPref(pref, initial);
      await TestUtils.waitForCondition(
        () => toggle.pressed === initial,
        `${id} follows external preference changes`
      );
    }
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});
