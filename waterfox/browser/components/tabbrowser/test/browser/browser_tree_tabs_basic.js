/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_basic_formation() {
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_CLOSE_PARENT_BEHAVIOR, 1);

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-basic-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  info("Opening child tab from current parent");
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-basic-child"
  );

  info("Waiting for child tree level to settle");
  await waitForTreeCondition(
    () => getTreeLevel(childTab) == 1,
    "Waiting for child tree level attribute"
  );

  is(getTreeLevel(childTab), 1, "Child tab is rendered at level 1");
  is(
    childTab.getAttribute("data-tree-parent"),
    parentTab.linkedPanel,
    "Child tab has data-tree-parent set"
  );
  ok(hasTreeChildren(parentTab), "Parent tab has data-tree-has-children");
  is(
    getTreeParent(childTab),
    parentTab,
    "Service resolves parent for child tab"
  );
  ok(
    gBrowser.TreeTabsService.getChildren(parentTab).includes(childTab),
    "Service resolves child for parent tab"
  );

  info("Opening a new tab via Ctrl+T");
  const initialTabCount = gBrowser.tabs.length;
  EventUtils.synthesizeKey("t", { accelKey: true });
  await waitForTreeCondition(
    () => gBrowser.tabs.length == initialTabCount + 1,
    "Waiting for Ctrl+T to open a new tab"
  );
  const newRootTab = gBrowser.tabs[gBrowser.tabs.length - 1];

  is(getTreeLevel(newRootTab), 0, "Ctrl+T tab is a root tab");
  is(getTreeParent(newRootTab), null, "Ctrl+T tab has no tree parent");

  info("Closing parent tab and waiting for promotion");
  BrowserTestUtils.removeTab(parentTab);
  await waitForTreeCondition(
    () => !gBrowser.tabs.includes(parentTab),
    "Waiting for parent tab to close"
  );

  await waitForTreeUpdate();
  await waitForTreeCondition(
    () => getTreeParent(childTab) == null,
    "Waiting for child to be promoted after parent close"
  );

  is(
    getTreeLevel(childTab),
    0,
    "Child is promoted to tree root after parent close"
  );

  BrowserTestUtils.removeTab(newRootTab);
  BrowserTestUtils.removeTab(childTab);
});

add_task(async function test_default_close_promotes_first_child() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?promote-first-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childA = await openTabWithTree(parentTab, "about:blank");
  const childB = await openTabWithTree(parentTab, "about:blank");

  BrowserTestUtils.removeTab(parentTab);
  await waitForTreeCondition(
    () => getTreeParent(childA) == null,
    "Waiting for the first child to be promoted"
  );

  is(getTreeParent(childA), null, "First child is promoted in parent's place");
  is(
    getTreeParent(childB),
    childA,
    "Second child is reparented under the promoted first child"
  );

  BrowserTestUtils.removeTab(childB);
  BrowserTestUtils.removeTab(childA);
});

add_task(async function test_duplicate_becomes_next_sibling() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?duplicate-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const sourceTab = await openTabWithTree(parentTab, "about:blank");
  const sourceChild = await openTabWithTree(sourceTab, "about:blank");

  const duplicateTab = gBrowser.duplicateTab(sourceTab, true);
  await waitForTreeCondition(
    () => getTreeParent(duplicateTab) == parentTab,
    "Waiting for the duplicate to join the tree"
  );

  is(
    getTreeParent(duplicateTab),
    parentTab,
    "Duplicate shares the source's parent instead of becoming its child"
  );
  const parentChildren = gBrowser.TreeTabsService.getChildren(parentTab);
  is(
    parentChildren[parentChildren.indexOf(sourceTab) + 1],
    duplicateTab,
    "Duplicate is the source's next sibling"
  );
  is(
    duplicateTab._tPos,
    sourceChild._tPos + 1,
    "Duplicate is placed right after the source's subtree"
  );

  BrowserTestUtils.removeTab(duplicateTab);
  BrowserTestUtils.removeTab(sourceChild);
  BrowserTestUtils.removeTab(sourceTab);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(async function test_successor_of_last_child_is_previous_sibling() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?successor-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childA = await openTabWithTree(parentTab, "about:blank");
  const childB = await openTabWithTree(parentTab, "about:blank");
  const otherRoot = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?successor-other"
  );

  await BrowserTestUtils.switchTab(gBrowser, childB);
  BrowserTestUtils.removeTab(childB);
  await waitForTreeCondition(
    () => !gBrowser.tabs.includes(childB),
    "Waiting for the last child to close"
  );

  is(
    gBrowser.selectedTab,
    childA,
    "Closing the active last child selects its previous sibling"
  );

  BrowserTestUtils.removeTab(otherRoot);
  BrowserTestUtils.removeTab(childA);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(async function test_successor_stays_in_tree_without_siblings() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?successor-only-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childTab = await openTabWithTree(parentTab, "about:blank");
  const otherRoot = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?successor-only-other"
  );

  await BrowserTestUtils.switchTab(gBrowser, childTab);
  BrowserTestUtils.removeTab(childTab);
  await waitForTreeCondition(
    () => !gBrowser.tabs.includes(childTab),
    "Waiting for the only child to close"
  );

  is(
    gBrowser.selectedTab,
    parentTab,
    "Closing the active only child selects its parent, not the next root"
  );

  BrowserTestUtils.removeTab(otherRoot);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(async function test_auto_attach_from_link_click() {
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_AUTO_ATTACH, 1);

  const parentTab = BrowserTestUtils.addTab(gBrowser, "https://example.com/");
  await BrowserTestUtils.browserLoaded(parentTab.linkedBrowser);
  await BrowserTestUtils.switchTab(gBrowser, parentTab);

  const childTab = await openLinkInNewTab(
    parentTab,
    "https://example.com/?child-from-link"
  );

  await waitForTreeCondition(
    () => getTreeParent(childTab) === parentTab,
    "Waiting for auto-attach to fire from link click"
  );

  is(
    getTreeParent(childTab),
    parentTab,
    "Link-opened tab is auto-attached as child of opener"
  );
  is(getTreeLevel(childTab), 1, "Link-opened tab is at level 1");

  BrowserTestUtils.removeTab(childTab);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(async function test_opener_tab_reverse_sync_attaches_and_reparents() {
  await enableTreeTabs();

  const firstParent = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-opener-sync-first-parent"
  );
  const secondParent = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-opener-sync-second-parent"
  );
  const targetTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-opener-sync-target"
  );
  const targetChild = await openTabWithTree(
    targetTab,
    "https://example.com/?waterfox-tree-opener-sync-target-child"
  );

  targetTab.openerTab = firstParent;
  gBrowser._tabAttrModified(targetTab, ["openerTab"]);
  await waitForTreeCondition(
    () =>
      getTreeParent(targetTab) == firstParent &&
      targetTab._tPos == firstParent._tPos + 1 &&
      targetChild._tPos == targetTab._tPos + 1,
    "Waiting for openerTab to attach and position the target subtree"
  );

  is(
    getTreeParent(targetTab),
    firstParent,
    "Setting openerTab attaches an existing tab to the opener"
  );
  is(
    targetTab._tPos,
    firstParent._tPos + 1,
    "Attached tab immediately follows its opener"
  );
  is(
    targetChild._tPos,
    targetTab._tPos + 1,
    "Attached tab keeps its child contiguous in the strip"
  );
  is(
    secondParent._tPos,
    targetChild._tPos + 1,
    "The following root stays after the attached subtree"
  );

  targetTab.openerTab = secondParent;
  gBrowser._tabAttrModified(targetTab, ["openerTab"]);
  await waitForTreeCondition(
    () =>
      getTreeParent(targetTab) == secondParent &&
      targetTab._tPos == secondParent._tPos + 1 &&
      targetChild._tPos == targetTab._tPos + 1,
    "Waiting for an openerTab change to reparent and move the target subtree"
  );

  is(
    getTreeParent(targetTab),
    secondParent,
    "Changing openerTab reparents the existing tab"
  );
  ok(
    !gBrowser.TreeTabsService.getChildren(firstParent).includes(targetTab),
    "The previous opener no longer owns the target tab"
  );
  is(
    targetTab._tPos,
    secondParent._tPos + 1,
    "Reparented tab immediately follows its new opener"
  );
  is(
    targetChild._tPos,
    targetTab._tPos + 1,
    "Reparented subtree remains contiguous in the strip"
  );

  BrowserTestUtils.removeTab(targetChild);
  BrowserTestUtils.removeTab(targetTab);
  BrowserTestUtils.removeTab(secondParent);
  BrowserTestUtils.removeTab(firstParent);
});

add_task(
  async function test_opener_tab_reverse_sync_uses_nearest_child_and_detaches() {
    await enableTreeTabs();

    const parentTab = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?waterfox-tree-opener-nearest-parent"
    );
    const firstChild = await openTabWithTree(
      parentTab,
      "about:blank?waterfox-tree-opener-nearest-first"
    );
    const secondChild = await openTabWithTree(
      parentTab,
      "about:blank?waterfox-tree-opener-nearest-second"
    );
    const targetTab = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?waterfox-tree-opener-nearest-target"
    );
    gBrowser.TreeTabsService.detachTab(targetTab);
    window.TreeTabsDnD._suppressMoveFixup = true;
    gBrowser.moveTabTo(targetTab, { tabIndex: secondChild._tPos });
    window.TreeTabsDnD._suppressMoveFixup = false;

    targetTab.openerTab = parentTab;
    gBrowser._tabAttrModified(targetTab, ["openerTab"]);
    await waitForTreeCondition(
      () =>
        getTreeParent(targetTab) == parentTab &&
        gBrowser.TreeTabsService.getChildren(parentTab)[1] == targetTab,
      "Waiting for opener sync to use the nearest child position"
    );

    Assert.deepEqual(
      gBrowser.TreeTabsService.getChildren(parentTab),
      [firstChild, targetTab, secondChild],
      "Reverse opener sync inserts at the nearest child position"
    );

    targetTab.openerTab = null;
    gBrowser._tabAttrModified(targetTab, ["openerTab"]);
    await waitForTreeCondition(
      () => getTreeParent(targetTab) == null,
      "Waiting for clearing openerTab to detach the tree edge"
    );
    is(getTreeParent(targetTab), null, "Clearing openerTab detaches the tab");

    BrowserTestUtils.removeTab(secondChild);
    BrowserTestUtils.removeTab(targetTab);
    BrowserTestUtils.removeTab(firstChild);
    BrowserTestUtils.removeTab(parentTab);
  }
);

add_task(async function test_new_tab_relationship_chooser() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-new-tab-chooser-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const button = document.getElementById("waterfox-tree-newtab-action-button");
  const childItem = document.getElementById("waterfox-tree-newtab-child");
  const independentItem = document.getElementById(
    "waterfox-tree-newtab-independent"
  );

  ok(!button.hidden, "Relationship chooser is visible in vertical tree mode");
  const childCount = gBrowser.tabs.length;
  childItem.doCommand();
  await waitForTreeCondition(
    () => gBrowser.tabs.length == childCount + 1,
    "Waiting for the chooser to open a child tab"
  );
  const childTab = gBrowser.selectedTab;
  is(getTreeParent(childTab), parentTab, "Child action creates a tree child");

  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  gBrowser.pinTab(parentTab);
  const independentCount = gBrowser.tabs.length;
  independentItem.doCommand();
  await waitForTreeCondition(
    () => gBrowser.tabs.length == independentCount + 1,
    "Waiting for the chooser to open an independent tab"
  );
  const independentTab = gBrowser.selectedTab;
  is(
    getTreeParent(independentTab),
    null,
    "Independent action works while a pinned tab is selected"
  );

  gBrowser.unpinTab(parentTab);
  BrowserTestUtils.removeTab(independentTab);
  BrowserTestUtils.removeTab(childTab);
  BrowserTestUtils.removeTab(parentTab);
});
