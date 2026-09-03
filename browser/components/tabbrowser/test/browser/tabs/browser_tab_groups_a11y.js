"use strict";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.groups.enabled", true]],
  });
});

add_task(async function test_TabGroupA11y() {
  const tab1 = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const tab2 = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const tab3 = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const tab4 = BrowserTestUtils.addTab(gBrowser, "about:blank");

  const tabGroup = gBrowser.addTabGroup([tab2, tab3]);

  await BrowserTestUtils.switchTab(gBrowser, tab1);

  Assert.equal(
    tabGroup.labelElement.getAttribute("role"),
    "button",
    "tab group label should have the button role"
  );

  Assert.equal(
    tabGroup.labelElement.getAttribute("aria-label"),
    "Unnamed Group",
    "tab group label aria-label should default to 'unnamed' if not set"
  );

  Assert.equal(
    tabGroup.labelElement.getAttribute("aria-description"),
    "Unnamed Group — Tab Group",
    "tab group label aria-description should provide the name of the tab group plus more context"
  );

  Assert.equal(
    tabGroup.labelElement.getAttribute("aria-expanded"),
    "true",
    "tab group label aria-expanded should default to true, since tab groups default to not collapsed"
  );

  Assert.ok(
    tabGroup.tabs.every(tab => !tab.hasAttribute("aria-hidden")),
    "tabs in expanded tab groups should not be hidden from accessibility tools"
  );

  tabGroup.label = "test";
  await BrowserTestUtils.waitForCondition(
    () => tabGroup.labelElement.getAttribute("aria-label") == "test",
    "Tab group label was updated"
  );
  await flushL10n();

  Assert.equal(
    tabGroup.labelElement.getAttribute("aria-label"),
    "test",
    "tab group label aria-label should equal the name of the tab group"
  );
  Assert.equal(
    tabGroup.labelElement.getAttribute("aria-description"),
    "test — Tab Group",
    "tab group label aria-description should provide the name of the tab group plus more context"
  );

  await TabGroupTestUtils.toggleCollapsed(tabGroup, true);

  Assert.equal(
    tabGroup.labelElement.getAttribute("aria-expanded"),
    "false",
    "tab group label aria-expanded should be false when the tab group is collapsed"
  );

  Assert.ok(
    tabGroup.tabs.every(tab => tab.hasAttribute("aria-hidden")),
    "when the group is collapsed and has no active tab inside, all tabs in the group should be hidden from accessbility tools"
  );

  info(
    "activating a tab in a collapsed tab group should make only that tab visible to accessibility tools"
  );
  await BrowserTestUtils.switchTab(gBrowser, tab2);

  Assert.ok(
    !tab2.hasAttribute("aria-hidden"),
    "the active tab in a collapsed tab group should be visible to accessibility tools"
  );
  Assert.ok(
    tab3.hasAttribute("aria-hidden"),
    "inactive tabs in collapsed tab groups should still be hidden from accessibility tools"
  );

  Assert.ok(
    !tab4.hasAttribute("aria-hidden"),
    "a normal ungrouped tab should be visible to accessibility tools"
  );

  info("move an inactive tab into a collapsed tab group");
  const tabAddedToGroup = BrowserTestUtils.waitForEvent(
    tabGroup,
    "TabGrouped",
    false,
    e => e.detail == tab4
  );

  tabGroup.addTabs([tab4]);

  await tabAddedToGroup;

  Assert.ok(
    tab4.hasAttribute("aria-hidden"),
    "when an inactive tab moves into a collapsed tab group, it should no longer be visible to accessibility tools"
  );

  info(
    "switching the active tab within a collapsed tab group should hide the old tab, reveal the new active tab"
  );
  await BrowserTestUtils.switchTab(gBrowser, tab4);

  Assert.ok(
    tab2.hasAttribute("aria-hidden"),
    "previously active tab should be hidden"
  );
  Assert.ok(
    !tab4.hasAttribute("aria-hidden"),
    "newly active tab should be visible"
  );

  info(
    "activate the ungrouped tab so that the tab group fully collapses again"
  );
  await BrowserTestUtils.switchTab(gBrowser, tab1);

  Assert.ok(
    tabGroup.tabs.every(tab => tab.hasAttribute("aria-hidden")),
    "when the group is collapsed and has no active tab inside, all tabs in the group should be hidden from accessbility tools"
  );

  await removeTabGroup(tabGroup);
  BrowserTestUtils.removeTab(tab1);
  BrowserTestUtils.removeTab(tab4);
});

async function flushL10n() {
  while (document.hasPendingL10nMutations) {
    await BrowserTestUtils.waitForEvent(document, "L10nMutationsFinished");
  }
}

add_task(async function test_collapsedTabGroupTooltips() {
  const tab1 = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const tab2 = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const tab3 = BrowserTestUtils.addTab(gBrowser, "about:blank");

  const group = gBrowser.addTabGroup([tab1, tab2]);
  await BrowserTestUtils.switchTab(gBrowser, tab2);
  Assert.equal(
    group.labelElement.getAttribute("tooltiptext"),
    "Unnamed Group — Expanded",
    "Group label tooltip indicates its expanded state"
  );

  info("Enable tab group hover preview");
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.groups.hoverPreview.enabled", true]],
  });
  info(
    "Collapse the group to confirm tooltip state when tab group hover preview is enabled"
  );
  await TabGroupTestUtils.toggleCollapsed(group, true);
  await flushL10n();

  Assert.equal(
    group._showTabGroupHoverPreview,
    true,
    "Sanity check: tab group hover preview is enabled"
  );
  Assert.equal(
    group.labelElement.getAttribute("tooltiptext"),
    null,
    "Group label has no tooltip when tab group hover preview is enabled"
  );
  await SpecialPowers.popPrefEnv();

  info("Disable tab group hover preview");
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.groups.hoverPreview.enabled", false]],
  });
  info(
    "Un-collapse and re-collapse group to ensure group picks up new pref setting"
  );
  await TabGroupTestUtils.toggleCollapsed(group, false);
  await TabGroupTestUtils.toggleCollapsed(group, true);
  await flushL10n();

  Assert.equal(
    group._showTabGroupHoverPreview,
    false,
    "Sanity check: tab group hover preview is false"
  );
  Assert.equal(
    group.labelElement.getAttribute("tooltiptext"),
    "Unnamed Group — Collapsed",
    "Group label tooltip indicates its collapsed state when tab group hover preview is disabled"
  );
  await SpecialPowers.popPrefEnv();

  Assert.equal(
    group.overflowCountLabel.getAttribute("tooltiptext"),
    "1 more tab",
    "Overflow count tooltip shows singular 'tab'"
  );

  info("Add a third tab to the group to confirm overflow tooltip pluralizes");
  group.addTabs([tab3]);
  await flushL10n();
  Assert.equal(
    group.overflowCountLabel.getAttribute("tooltiptext"),
    "2 more tabs",
    "Overflow count tooltip indicates remaining tabs"
  );

  await removeTabGroup(group);
});

add_task(async function test_tabGroupPreviewA11y() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.groups.hoverPreview.enabled", true]],
  });

  const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const group = gBrowser.addTabGroup([tab]);

  Assert.ok(
    !group.labelElement.getAttribute("aria-haspopup"),
    "Group label does not have aria-haspopup attribute"
  );

  await TabGroupTestUtils.toggleCollapsed(group, true);

  Assert.equal(
    group.labelElement.getAttribute("aria-haspopup"),
    "menu",
    'Group label has aria-haspopup="menu"'
  );

  info("opening collapsed group preview");
  let groupPreview = document.getElementById("tabgroup-preview-panel");
  let groupPreviewShown = BrowserTestUtils.waitForPopupEvent(
    groupPreview,
    "shown"
  );
  EventUtils.synthesizeMouseAtCenter(
    group.labelElement,
    {
      type: "mouseover",
    },
    window
  );
  await groupPreviewShown;
  await flushL10n();

  Assert.equal(
    groupPreview.getAttribute("aria-label"),
    "Tabs in a collapsed group",
    "Group preview panel has correct label"
  );
  Assert.equal(
    group.labelElement.getAttribute("aria-description"),
    "Tabs list open",
    "Group label has a description indicating the preview is open"
  );
  Assert.equal(
    groupPreview.querySelector("toolbarbutton").getAttribute("role"),
    "button",
    "Group menu items have correct role"
  );

  info("dismissing group preview");
  let groupPreviewHidden = BrowserTestUtils.waitForPopupEvent(
    groupPreview,
    "hidden"
  );
  EventUtils.synthesizeMouseAtCenter(
    document.body,
    { type: "mouseover" },
    window
  );
  await groupPreviewHidden;

  Assert.equal(
    group.labelElement.getAttribute("aria-description"),
    "Tabs list closed",
    "Group label has a description indicating the preview is closed"
  );

  await TabGroupTestUtils.removeTabGroup(group);
  await SpecialPowers.popPrefEnv();
});
