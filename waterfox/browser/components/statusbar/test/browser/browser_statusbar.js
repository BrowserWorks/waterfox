/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ENABLED_PREF = "browser.statusbar.enabled";
const TEXT_PREF = "browser.statusbar.appendStatusText";

registerCleanupFunction(() => {
  Services.prefs.clearUserPref(ENABLED_PREF);
  Services.prefs.clearUserPref(TEXT_PREF);
});

add_task(async function test_bar_in_bottombox() {
  const bar = document.getElementById("status-bar");
  ok(bar, "The status bar exists");
  is(
    bar.parentNode.id,
    "browser-bottombox",
    "The status bar lives in the bottom box"
  );
  ok(bar.collapsed, "The status bar starts collapsed");

  await SpecialPowers.pushPrefEnv({ set: [[ENABLED_PREF, true]] });
  ok(!bar.collapsed, "Enabling the pref shows the status bar");
  await SpecialPowers.popPrefEnv();
  ok(bar.collapsed, "Clearing the pref collapses the status bar");
});

add_task(async function test_default_placements() {
  const placements = CustomizableUI.getWidgetIdsInArea("status-bar");
  for (const id of [
    "screenshot-button",
    "zoom-controls",
    "fullscreen-button",
  ]) {
    ok(placements.includes(id), `${id} is placed in the status bar`);
  }
});

add_task(async function test_toolbar_context_menu_toggle() {
  const menu = document.getElementById("toolbar-context-menu");
  const menuButton = document.getElementById("PanelUI-menu-button");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(
    menuButton,
    {
      type: "contextmenu",
      button: 2,
    },
    window
  );
  await shown;

  const item = document.getElementById("toggle_status-dummybar");
  ok(item, "The toolbar context menu offers the status bar");
  is(item.getAttribute("type"), "checkbox", "The entry is a checkbox");

  const prefChanged = TestUtils.waitForPrefChange(ENABLED_PREF);
  item.setAttribute("checked", "true");
  item.doCommand();
  await prefChanged;

  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;

  is(
    Services.prefs.getBoolPref(ENABLED_PREF),
    true,
    "Toggling the menu entry enables the status bar"
  );
  ok(
    !document.getElementById("status-bar").collapsed,
    "The status bar shows after the menu toggle"
  );
  Services.prefs.clearUserPref(ENABLED_PREF);
});

add_task(async function test_status_text_placement() {
  const label = document.getElementById("statuspanel-label");

  await SpecialPowers.pushPrefEnv({
    set: [
      [ENABLED_PREF, true],
      [TEXT_PREF, true],
    ],
  });
  is(
    label.parentNode.id,
    "status-text",
    "The status label moves into the bar while mirroring is on"
  );

  await SpecialPowers.popPrefEnv();
  is(
    label.parentNode.id,
    "statuspanel",
    "The status label returns to the panel when the bar is off"
  );
});
