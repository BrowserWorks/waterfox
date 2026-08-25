/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_mute_collapsed_parent_mutes_playing_descendants() {
  await enableTreeTabs();
  Services.prefs.setBoolPref(PREF_TREE_PROPAGATE_MUTED_STATE, true);

  const parentTab = gBrowser.selectedTab;
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-mute-child"
  );
  const silentChildTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-mute-silent-child"
  );
  childTab.setAttribute("soundplaying", "true");

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childTab) && isTreeHidden(silentChildTab),
    "Waiting for children to be hidden"
  );

  ok(!childTab.linkedBrowser.audioMuted, "Playing child starts unmuted");
  ok(!silentChildTab.linkedBrowser.audioMuted, "Silent child starts unmuted");

  // Mute parent and wait for the playing collapsed descendant to inherit.
  if (!parentTab.linkedBrowser.audioMuted) {
    parentTab.toggleMuteAudio();
  }
  await waitForTreeCondition(
    () => childTab.linkedBrowser.audioMuted,
    "Waiting for muted state to propagate to child"
  );
  ok(
    childTab.linkedBrowser.audioMuted,
    "Collapsed playing child inherits muted state"
  );
  ok(
    !silentChildTab.linkedBrowser.audioMuted,
    "Collapsed silent child stays unmuted"
  );

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
    "Collapsed playing child inherits unmuted state"
  );

  childTab.removeAttribute("soundplaying");
  BrowserTestUtils.removeTab(silentChildTab);
  BrowserTestUtils.removeTab(childTab);
});

add_task(async function test_collapsed_muted_indicator_unmutes_descendant() {
  await enableTreeTabs();

  const parentTab = gBrowser.selectedTab;
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-muted-indicator-child"
  );
  childTab.toggleMuteAudio();
  gBrowser.TreeTabsService.collapseSubtree(parentTab);

  await waitForTreeCondition(
    () =>
      childTab.linkedBrowser.audioMuted &&
      parentTab.hasAttribute("data-tree-has-muted-member"),
    "Waiting for the collapsed muted descendant indicator"
  );

  parentTab.audioButton.click();
  await waitForTreeCondition(
    () => !childTab.linkedBrowser.audioMuted,
    "Waiting for the indicator to unmute the descendant"
  );

  ok(
    !childTab.linkedBrowser.audioMuted,
    "Clicking the collapsed muted indicator unmutes the descendant"
  );

  BrowserTestUtils.removeTab(childTab);
});

add_task(async function test_descendant_sound_state_updates_ancestors() {
  await enableTreeTabs();

  const rootTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-sound-indicator-root"
  );
  const parentTab = await openTabWithTree(
    rootTab,
    "https://example.com/?waterfox-tree-sound-indicator-parent"
  );
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-sound-indicator-child"
  );

  ok(!childTab.hasAttribute("muted"), "Child starts without a muted state");
  childTab.toggleMuteAudio();
  await waitForTreeCondition(
    () =>
      parentTab.hasAttribute("data-tree-has-muted-member") &&
      rootTab.hasAttribute("data-tree-has-muted-member"),
    "Waiting for muted descendant indicators on the ancestor chain"
  );

  ok(
    parentTab.hasAttribute("data-tree-has-muted-member"),
    "Muted child marks its parent as having a muted member"
  );
  ok(
    rootTab.hasAttribute("data-tree-has-muted-member"),
    "Muted child marks every ancestor as having a muted member"
  );

  childTab.toggleMuteAudio();
  await waitForTreeCondition(
    () =>
      !parentTab.hasAttribute("data-tree-has-muted-member") &&
      !rootTab.hasAttribute("data-tree-has-muted-member"),
    "Waiting for muted descendant indicators to clear"
  );

  ok(
    !parentTab.hasAttribute("data-tree-has-muted-member"),
    "Unmuting the child clears its parent's muted member state"
  );
  ok(
    !rootTab.hasAttribute("data-tree-has-muted-member"),
    "Unmuting the child clears the muted state from every ancestor"
  );

  childTab.setAttribute("soundplaying", "true");
  gBrowser._tabAttrModified(childTab, ["soundplaying"]);
  await waitForTreeCondition(
    () =>
      parentTab.hasAttribute("data-tree-has-sound-member") &&
      rootTab.hasAttribute("data-tree-has-sound-member"),
    "Waiting for playing descendant indicators on the ancestor chain"
  );

  ok(
    parentTab.hasAttribute("data-tree-has-sound-member"),
    "Playing child marks its parent as having a sound member"
  );
  ok(
    rootTab.hasAttribute("data-tree-has-sound-member"),
    "Playing child marks every ancestor as having a sound member"
  );

  childTab.removeAttribute("soundplaying");
  gBrowser._tabAttrModified(childTab, ["soundplaying"]);
  await waitForTreeCondition(
    () =>
      !parentTab.hasAttribute("data-tree-has-sound-member") &&
      !rootTab.hasAttribute("data-tree-has-sound-member"),
    "Waiting for playing descendant indicators to clear"
  );

  ok(
    !parentTab.hasAttribute("data-tree-has-sound-member"),
    "Clearing soundplaying clears the parent's sound member state"
  );
  ok(
    !rootTab.hasAttribute("data-tree-has-sound-member"),
    "Clearing soundplaying clears the state from every ancestor"
  );

  BrowserTestUtils.removeTab(childTab);
  BrowserTestUtils.removeTab(parentTab);
  BrowserTestUtils.removeTab(rootTab);
});
