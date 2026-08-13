/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const MIGRATION_PREF = "browser.migration.waterfox_version";
const SIDEBAR_PREF = "sidebar.revamp";
const SIDEBAR_DEFAULT_LAUNCHER_VISIBLE_PREF =
  "sidebar.revamp.defaultLauncherVisible";
const SIDEBAR_TOOLS_PREF = "sidebar.main.tools";
const SIDEBAR_VISIBILITY_PREF = "sidebar.visibility";
const DEFAULT_SIDEBAR_TOOLS = [
  "aichat",
  "syncedtabs",
  "history",
  "bookmarks",
  "opentabs",
];

add_task(async function test_new_profile_sidebar_startup() {
  Assert.equal(
    Services.prefs.getIntPref(MIGRATION_PREF),
    6,
    "The new-profile migration ran"
  );
  Assert.ok(
    Services.prefs.getBoolPref(SIDEBAR_PREF),
    "New profiles enable the revamped sidebar by default"
  );
  Assert.ok(
    Services.prefs.getBoolPref(SIDEBAR_DEFAULT_LAUNCHER_VISIBLE_PREF),
    "New profiles default the sidebar launcher to visible"
  );
  Assert.ok(
    CustomizableUI.getWidgetIdsInArea(CustomizableUI.AREA_NAVBAR),
    "The navigation bar area was restored"
  );

  Assert.ok(
    SidebarController.initialized,
    "The sidebar controller initialized"
  );
  await SidebarController.promiseInitialized;
  Assert.ok(
    SidebarController._state.revampEnabled,
    "Sidebar state captured the revamped preference during initialization"
  );
  Assert.equal(
    Services.prefs.getStringPref(SIDEBAR_VISIBILITY_PREF),
    "hide-sidebar",
    "Horizontal tabs let the toolbar button hide the launcher"
  );
  Assert.ok(
    !SidebarController.sidebarContainer.hidden,
    "The sidebar launcher is visible"
  );
  Assert.equal(
    typeof SidebarController.sidebarMain.requestUpdate,
    "function",
    "The sidebar launcher is the upgraded component"
  );

  const tools = Services.prefs.getStringPref(SIDEBAR_TOOLS_PREF).split(",");
  for (const tool of DEFAULT_SIDEBAR_TOOLS) {
    Assert.ok(tools.includes(tool), `The launcher includes ${tool}`);
  }
});
