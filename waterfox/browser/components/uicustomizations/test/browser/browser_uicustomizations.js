/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const TABBAR_PREF = "browser.tabs.toolbarposition";
const BOOKMARKS_PREF = "browser.bookmarks.toolbarposition";

function tabsToolbar() {
  return document.getElementById("TabsToolbar");
}

function bookmarksBar() {
  return document.getElementById("PersonalToolbar");
}

function isBefore(a, b) {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

add_task(async function test_tab_bar_positions() {
  is(
    tabsToolbar().previousElementSibling.id,
    "toolbar-menubar",
    "The tab bar starts right after the menu bar"
  );

  await SpecialPowers.pushPrefEnv({ set: [[TABBAR_PREF, "topbelow"]] });
  is(
    tabsToolbar().parentNode.id,
    "navigator-toolbox",
    "topbelow keeps the tab bar in the toolbox"
  );
  ok(!tabsToolbar().nextElementSibling, "topbelow puts the tab bar last");

  await SpecialPowers.pushPrefEnv({ set: [[TABBAR_PREF, "bottomabove"]] });
  is(
    tabsToolbar().parentNode.id,
    "browser-bottombox",
    "bottomabove moves the tab bar to the bottom box"
  );
  ok(
    isBefore(tabsToolbar(), document.getElementById("status-bar")),
    "bottomabove places the tab bar before the status bar"
  );

  await SpecialPowers.pushPrefEnv({ set: [[TABBAR_PREF, "bottombelow"]] });
  ok(
    isBefore(document.getElementById("status-bar"), tabsToolbar()),
    "bottombelow places the tab bar after the status bar"
  );

  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
  is(
    tabsToolbar().previousElementSibling.id,
    "toolbar-menubar",
    "Clearing the pref restores the default position"
  );
});

add_task(async function test_bookmarks_bar_positions() {
  is(
    bookmarksBar().parentNode.id,
    "navigator-toolbox",
    "The bookmarks bar starts in the toolbox"
  );

  await SpecialPowers.pushPrefEnv({ set: [[BOOKMARKS_PREF, "bottom"]] });
  is(
    bookmarksBar().parentNode.id,
    "browser-bottombox",
    "bottom moves the bookmarks bar to the bottom box"
  );

  await SpecialPowers.popPrefEnv();
  is(
    bookmarksBar().parentNode.id,
    "navigator-toolbox",
    "Clearing the pref restores the bookmarks bar"
  );
  is(
    bookmarksBar().previousElementSibling.id,
    "nav-bar",
    "The bookmarks bar returns right after the nav bar"
  );
});

add_task(async function test_bottom_ordering_with_both_bars() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [TABBAR_PREF, "bottomabove"],
      [BOOKMARKS_PREF, "bottom"],
    ],
  });

  is(
    tabsToolbar().parentNode.id,
    "browser-bottombox",
    "The tab bar sits in the bottom box"
  );
  is(
    bookmarksBar().parentNode.id,
    "browser-bottombox",
    "The bookmarks bar sits in the bottom box"
  );
  ok(
    isBefore(bookmarksBar(), tabsToolbar()),
    "The bookmarks bar stays above the tab bar"
  );

  await SpecialPowers.popPrefEnv();
});
