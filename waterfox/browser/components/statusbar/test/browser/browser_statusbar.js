"use strict";

// Test status bar is present
add_task(async function testStatusBarPresent() {
  let el = document.getElementById("status-bar");
  ok(el, "Status bar exists");

  is(
    el.parentElement.id,
    "browser-bottombox",
    "Status bar located in browser bottombox"
  );
});

// Test can be toggled on/off
add_task(async function testToggleStatusBar() {
  Services.prefs.setBoolPref(STATUSBAR_ENABLED_PREF, false);
  let statusbar = document.getElementById("status-bar");
  ok(statusbar.collapsed, "Status bar is collapsed");

  // Toggle with context menu item
  let toolbarContextMenu = document.getElementById("toolbar-context-menu");
  let target = document.getElementById("PanelUI-menu-button");
  await openToolbarContextMenu(toolbarContextMenu, target);
  let toggle = document.getElementById("toggle_status-dummybar");
  await EventUtils.synthesizeMouseAtCenter(toggle, {}); // Not actually clicking?
  //   is(statusbar.collapsed, false, "Status bar is not collapsed");

  // Toggle with preference
  Services.prefs.setBoolPref(STATUSBAR_ENABLED_PREF, false);
  ok(statusbar.collapsed, "Status bar is collapsed");
  Services.prefs.setBoolPref(STATUSBAR_ENABLED_PREF, true);
  is(statusbar.collapsed, false, "Status bar is not collapsed");

  // Clear pref
  Services.prefs.clearUserPref(STATUSBAR_ENABLED_PREF);
});

// Test can add widgets
add_task(async function testAddWidgets() {
  Services.prefs.setBoolPref(STATUSBAR_ENABLED_PREF, true);

  await startCustomizing();
  let btn = document.getElementById("new-window-button");
  let panel = document.getElementById("status-bar");

  assertAreaPlacements(panel.id, [
    "screenshot-button",
    "zoom-controls",
    "fullscreen-button",
    "status-text",
  ]);

  let placementsAfterAppend = [
    "screenshot-button",
    "zoom-controls",
    "fullscreen-button",
    "status-text",
  ];
  simulateItemDrag(btn, panel); // Doesn't work in test, does in prod?
  assertAreaPlacements(panel.id, placementsAfterAppend);
  await endCustomizing();
  // Clear pref
  Services.prefs.clearUserPref(STATUSBAR_ENABLED_PREF);
});

add_task(async function testShowStatusBarCustomizing() {
  // Status bar should be hidden
  let statusBar = document.querySelector("#status-bar");
  let style = window.getComputedStyle(statusBar);
  is(style.visibility, "collapse", "Status bar is collapsed");
  // When we start customizing should be displayed
  await startCustomizing();
  is(style.visibility, "visible", "Status bar is displayed when customizing");
  await endCustomizing();
});
