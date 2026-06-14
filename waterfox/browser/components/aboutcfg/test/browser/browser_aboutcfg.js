/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_about_cfg_loads_and_filters() {
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:cfg"
  );
  try {
    const doc = tab.linkedBrowser.contentDocument;
    await TestUtils.waitForCondition(
      () => doc.getElementById("configTree")?.view,
      "Waiting for the classic config tree to initialize"
    );

    is(doc.location.href, "about:cfg", "The classic config page loads");
    ok(doc.getElementById("configTree"), "The pref tree renders");

    const textbox = doc.getElementById("textbox");
    textbox.value = "browser.aboutConfig.showWarning";
    textbox.dispatchEvent(
      new doc.defaultView.InputEvent("input", { bubbles: true })
    );

    const tree = doc.getElementById("configTree");
    await TestUtils.waitForCondition(
      () => tree.view.rowCount >= 1,
      "Waiting for the filtered pref row"
    );
    is(
      tree.view.getCellText(0, { id: "prefCol" }),
      "browser.aboutConfig.showWarning",
      "Filtering finds the about:config warning pref"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
});
