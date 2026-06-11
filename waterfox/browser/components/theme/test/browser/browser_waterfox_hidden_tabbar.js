/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

// Windows and Linux keep the tab strip for window buttons. On macOS, Firefox
// moves the native button placeholder to the navigation bar.

const HIDDEN_TABBAR_PREF = "userChrome.hidden.tabbar";

function rect(win, selector) {
  const el = win.document.querySelector(selector);
  return el ? el.getBoundingClientRect() : null;
}

async function settle(win) {
  await new Promise(resolve =>
    win.requestAnimationFrame(() => win.requestAnimationFrame(resolve))
  );
}

add_task(async function test_hiding_the_tab_bar_collapses_the_strip() {
  if (AppConstants.platform != "macosx") {
    ok(true, "The strip stays put where the window buttons need it");
    return;
  }

  const win = window;
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(HIDDEN_TABBAR_PREF)
  );

  Services.prefs.setBoolPref(HIDDEN_TABBAR_PREF, false);
  await settle(win);

  const shownStrip = rect(win, "#TabsToolbar");
  const shownNavBar = rect(win, "#nav-bar");
  Assert.greater(
    shownStrip.height,
    0,
    "The strip has height while the tab bar is shown"
  );
  Assert.greater(
    shownNavBar.y,
    shownStrip.y,
    "The nav bar sits below the strip while the tab bar is shown"
  );

  Services.prefs.setBoolPref(HIDDEN_TABBAR_PREF, true);
  await settle(win);

  const hiddenStrip = rect(win, "#TabsToolbar");
  const hiddenNavBar = rect(win, "#nav-bar");
  is(hiddenStrip.height, 0, "Hiding the tab bar collapses the strip");
  is(
    win.getComputedStyle(win.document.querySelector("#TabsToolbar")).display,
    "none",
    "The strip is taken out of the layout rather than blanked"
  );
  is(
    hiddenNavBar.y,
    shownStrip.y,
    "The nav bar takes over the row the strip used to occupy"
  );

  const buttonBox = rect(win, "#nav-bar > .titlebar-buttonbox-container");
  Assert.greater(
    buttonBox.width,
    0,
    "The nav bar keeps room for the window buttons it inherited"
  );
  is(
    buttonBox.y,
    hiddenNavBar.y,
    "That room is on the nav bar's own row, where the buttons are drawn"
  );
});
