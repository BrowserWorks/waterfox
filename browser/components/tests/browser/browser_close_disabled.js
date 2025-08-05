/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

add_task(async function test_appMenu_close_disabled() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.closeShortcut.disabled", true]],
  });

  let win = await BrowserTestUtils.openNewBrowserWindow();
  let doc = win.document;

  let menuButton = doc.getElementById("PanelUI-menu-button");
  menuButton.click();
  await BrowserTestUtils.waitForEvent(win.PanelUI.mainView, "ViewShown");

  let closeButton = doc.querySelector(`[key="key_closeWindow"]`);
  is(closeButton, null, "No close button with shortcut key");

  await BrowserTestUtils.closeWindow(win);

  await SpecialPowers.popPrefEnv();
});

add_task(async function test_close_shortcut_disabled() {
  async function testCloseShortcut(shouldClose) {
    let win = await BrowserTestUtils.openNewBrowserWindow();

    let closeRequested = false;
    let observer = {
      observe(subject, topic, data) {
        is(topic, "close-application-requested", "Right observer topic");
        ok(shouldClose, "Close shortcut should NOT have worked");

        // Don't actually close the browser when testing.
        let cancelClose = subject.QueryInterface(Ci.nsISupportsPRBool);
        cancelClose.data = true;

        closeRequested = true;
      },
    };
    Services.obs.addObserver(observer, "close-application-requested");

    let modifiers = { accelKey: true };
    if (AppConstants.platform == "win") {
      modifiers.shiftKey = true;
    }
    EventUtils.synthesizeKey("w", modifiers, win);

    await BrowserTestUtils.closeWindow(win);
    Services.obs.removeObserver(observer, "close-application-requested");

    is(closeRequested, shouldClose, "Expected close state");
  }

  // Close shortcut should work when pref is not set.
  await testCloseShortcut(true);

  await SpecialPowers.pushPrefEnv({
    set: [["browser.closeShortcut.disabled", true]],
  });
  await testCloseShortcut(false);
});
