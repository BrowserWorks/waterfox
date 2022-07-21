add_task(async function testMoveTabBar() {
  // Test default (topabove)
  let el = document.querySelector("#TabsToolbar");
  let bottomBox = document.querySelector("#browser-bottombox");
  is(el.parentElement.id, "titlebar", "Tab toolbar is below menu bar");
  // Test topbelow
  Services.prefs.setCharPref(TABBAR_POSITION_PREF, "topbelow");
  is(el.parentElement.id, "navigator-toolbox", "Tabs toolbar is below nav bar");
  // Test bottom above
  Services.prefs.setCharPref(TABBAR_POSITION_PREF, "bottomabove");
  is(el.parentElement.id, "browser-bottombox", "Tabs toolbar is in bottom box");
  is(
    bottomBox.firstChild.id,
    "TabsToolbar",
    "Tabs toolbar is first element in bottom box"
  );
  // Test bottom below (reliance upon StatusBar.jsm)
  Services.prefs.setCharPref(TABBAR_POSITION_PREF, "bottombelow");
  is(el.parentElement.id, "browser-bottombox", "Tabs toolbar is in bottom box");
  is(
    bottomBox.firstChild.id,
    "status-bar",
    "Tabs toolbar is not first element in bottom box"
  );
  // Clear pref
  Services.prefs.clearUserPref(TABBAR_POSITION_PREF);
});

add_task(async function testMoveBookmarksBar() {
  // Test default (top)
  let el = document.querySelector("#PersonalToolbar");
  is(
    el.parentElement.id,
    "navigator-toolbox",
    "Bookmarks bar is below nav bar"
  );
  // Test bottom
  Services.prefs.setCharPref(BOOKMARKBAR_POSITION_PREF, "bottom");
  is(
    el.parentElement.id,
    "browser-bottombox",
    "Bookmarks bar is in bottom box"
  );
  // Test bottom buttons not disabled
  // Test bottom context menu item still visible
  // Clear pref
  Services.prefs.clearUserPref(BOOKMARKBAR_POSITION_PREF);
});

add_task(async function testWindowButtons() {
  // Test menu bar visible and tabs in default position
  // Test menu bar visible and tabs not in default position
  // Test menu bar hidden and tabs in default position
  // Test menu bar hidden and tabs not in default position
});

add_task(async function testSecondWindow() {
  // Change all prefs to non default values
  // Open new browser window
  // Test all cases reflected in new window
});
