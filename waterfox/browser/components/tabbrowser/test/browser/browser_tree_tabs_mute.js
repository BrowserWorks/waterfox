/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_mute_collapsed_parent_mutes_descendants() {
  await enableTreeTabs();
  Services.prefs.setBoolPref(PREF_TREE_PROPAGATE_MUTED_STATE, true);

  const parentTab = gBrowser.selectedTab;
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-mute-child"
  );

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childTab),
    "Waiting for child to be hidden"
  );

  ok(!childTab.linkedBrowser.audioMuted, "Child starts unmuted");

  // Mute parent and wait for collapsed descendants to inherit.
  if (!parentTab.linkedBrowser.audioMuted) {
    parentTab.toggleMuteAudio();
  }
  await waitForTreeCondition(
    () => childTab.linkedBrowser.audioMuted,
    "Waiting for muted state to propagate to child"
  );
  ok(childTab.linkedBrowser.audioMuted, "Collapsed child inherits muted state");

  // Unmute parent and wait for inherited mute to be removed.
  if (parentTab.linkedBrowser.audioMuted) {
    parentTab.toggleMuteAudio();
  }
  await waitForTreeCondition(
    () => !childTab.linkedBrowser.audioMuted,
    "Waiting for unmuted state to propagate to child"
  );
  ok(
    !childTab.linkedBrowser.audioMuted,
    "Collapsed child inherits unmuted state"
  );

  BrowserTestUtils.removeTab(childTab);
});
