/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_close_shortcut_disabled() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.closeShortcut.disabled", true]],
  });

  let win = await BrowserTestUtils.openNewBrowserWindow();
  let doc = win.document;

  ok(!doc.getElementById("key_close"), "Close tab shortcut is removed");
  ok(
    !doc.getElementById("key_closeWindow"),
    "Close window shortcut is removed"
  );
  ok(
    !doc.getElementById("menu_close").hasAttribute("key"),
    "Close tab menu has no shortcut"
  );
  ok(
    !doc.getElementById("menu_closeWindow").hasAttribute("key"),
    "Close window menu has no shortcut"
  );

  await BrowserTestUtils.closeWindow(win);
  await SpecialPowers.popPrefEnv();
});
