/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

async function createSplitTreeFixture(name) {
  const service = gBrowser.TreeTabsService;
  const ancestor = BrowserTestUtils.addTab(
    gBrowser,
    `about:blank?tree-split-${name}-ancestor`
  );
  service.detachTab(ancestor);

  const mainPane = await openTabWithTree(
    ancestor,
    `about:blank?tree-split-${name}-main`
  );
  const mainChild = await openTabWithTree(
    mainPane,
    `about:blank?tree-split-${name}-main-child`
  );

  const secondaryPane = await openTabWithTree(
    ancestor,
    `about:blank?tree-split-${name}-secondary`
  );
  const secondaryChild = await openTabWithTree(
    secondaryPane,
    `about:blank?tree-split-${name}-secondary-child`
  );

  return {
    ancestor,
    mainPane,
    mainChild,
    secondaryPane,
    secondaryChild,
    splitView: null,
  };
}

async function waitForSplitTreeNormalization(fixture) {
  const service = gBrowser.TreeTabsService;
  await waitForTreeCondition(() => {
    const mainChildren = service.getChildren(fixture.mainPane);
    return (
      fixture.splitView?.tabs[0] == fixture.mainPane &&
      getTreeParent(fixture.mainPane) == fixture.ancestor &&
      mainChildren.length == 2 &&
      mainChildren[0] == fixture.mainChild &&
      mainChildren[1] == fixture.secondaryChild &&
      getTreeParent(fixture.mainChild) == fixture.mainPane &&
      getTreeParent(fixture.secondaryPane) == null &&
      !service.getChildren(fixture.secondaryPane).length &&
      getTreeParent(fixture.secondaryChild) == fixture.mainPane &&
      getTreeLevel(fixture.mainPane) == 1 &&
      fixture.splitView.dataset.treeLevel == fixture.mainPane.dataset.treeLevel
    );
  }, "Waiting for split view tree links to normalize");
}

function assertSplitTreeNormalization(fixture) {
  const service = gBrowser.TreeTabsService;
  const mainChildren = service.getChildren(fixture.mainPane);

  is(fixture.splitView.tabs[0], fixture.mainPane, "First pane owns the row");
  is(
    getTreeParent(fixture.mainPane),
    fixture.ancestor,
    "First pane keeps its tree parent"
  );
  is(mainChildren.length, 2, "First pane owns both panes' tree children");
  is(mainChildren[0], fixture.mainChild, "First pane keeps its tree child");
  is(
    mainChildren[1],
    fixture.secondaryChild,
    "Secondary pane's child follows the shared row"
  );
  is(
    getTreeParent(fixture.mainChild),
    fixture.mainPane,
    "First pane's child stays attached"
  );
  is(
    getTreeParent(fixture.secondaryPane),
    null,
    "Secondary pane has no tree parent"
  );
  is(
    service.getChildren(fixture.secondaryPane).length,
    0,
    "Secondary pane has no tree children"
  );
  is(
    getTreeParent(fixture.secondaryChild),
    fixture.mainPane,
    "Secondary pane's child is folded into the shared row"
  );
  is(getTreeLevel(fixture.mainPane), 1, "First pane keeps its tree level");
  is(
    fixture.splitView.dataset.treeLevel,
    fixture.mainPane.dataset.treeLevel,
    "Split view wrapper mirrors the first pane's tree level"
  );
}

async function assertSplitPanesFollowTreeVisibility(fixture) {
  await BrowserTestUtils.switchTab(gBrowser, fixture.ancestor);
  gBrowser.TreeTabsService.collapseSubtree(fixture.mainPane);
  await waitForTreeCondition(
    () =>
      !isTreeHidden(fixture.mainPane) &&
      !isTreeHidden(fixture.secondaryPane) &&
      isTreeHidden(fixture.mainChild) &&
      isTreeHidden(fixture.secondaryChild),
    "Waiting for a collapsed split row to hide both panes' descendants"
  );

  ok(!isTreeHidden(fixture.mainPane), "First pane remains visible");
  ok(!isTreeHidden(fixture.secondaryPane), "Secondary pane remains visible");
  ok(isTreeHidden(fixture.mainChild), "First pane's child is tree-hidden");
  ok(
    isTreeHidden(fixture.secondaryChild),
    "Secondary pane's child is tree-hidden"
  );
  is(
    fixture.mainPane
      .querySelector(".tab-content")
      ?.getAttribute("data-tree-counter"),
    "2",
    "Collapsed split row counts descendants from both panes"
  );

  gBrowser.TreeTabsService.expandSubtree(fixture.mainPane);
  await waitForTreeCondition(
    () =>
      !isTreeHidden(fixture.mainChild) && !isTreeHidden(fixture.secondaryChild),
    "Waiting for both panes' descendants to follow the expanded split row"
  );

  ok(!isTreeHidden(fixture.mainChild), "First pane's child is visible again");
  ok(
    !isTreeHidden(fixture.secondaryChild),
    "Secondary pane's child is visible again"
  );
}

async function cleanupSplitTreeFixture(fixture) {
  if (!fixture) {
    return;
  }

  if (gBrowser.TreeTabsService.enabled) {
    gBrowser.TreeTabsService.expandSubtree(fixture.ancestor);
    gBrowser.TreeTabsService.expandSubtree(fixture.mainPane);
    gBrowser.TreeTabsService.expandSubtree(fixture.secondaryPane);
  }

  if (fixture.splitView?.isConnected) {
    fixture.splitView.unsplitTabs();
    await waitForTreeCondition(
      () => !fixture.splitView.isConnected,
      "Waiting for split view cleanup"
    );
  }

  for (const tab of [
    fixture.secondaryChild,
    fixture.mainChild,
    fixture.secondaryPane,
    fixture.mainPane,
    fixture.ancestor,
  ]) {
    if (tab && gBrowser.tabs.includes(tab) && !tab.closing) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
}

add_task(async function test_split_view_uses_first_pane_tree() {
  await enableTreeTabs();
  const fixture = await createSplitTreeFixture("enabled");

  try {
    const splitCreated = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "SplitViewCreated"
    );
    const treeUpdated = waitForTreeUpdate();
    fixture.splitView = gBrowser.addTabSplitView([
      fixture.mainPane,
      fixture.secondaryPane,
    ]);
    await Promise.all([splitCreated, treeUpdated]);

    await waitForSplitTreeNormalization(fixture);
    assertSplitTreeNormalization(fixture);
    await assertSplitPanesFollowTreeVisibility(fixture);
  } finally {
    await cleanupSplitTreeFixture(fixture);
  }
});

add_task(async function test_dragging_split_row_collects_shared_descendants() {
  await enableTreeTabs();
  const fixture = await createSplitTreeFixture("drag-row");

  try {
    const splitCreated = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "SplitViewCreated"
    );
    fixture.splitView = gBrowser.addTabSplitView([
      fixture.mainPane,
      fixture.secondaryPane,
    ]);
    await splitCreated;
    await waitForSplitTreeNormalization(fixture);

    const state = window.TreeTabsDnD.prepareDrop(
      gBrowser.tabContainer,
      {
        altKey: false,
        ctrlKey: false,
        target: gBrowser.tabContainer,
      },
      {
        draggedTab: fixture.splitView,
        movingTabs: [fixture.splitView],
        dropEffect: "move",
      }
    );

    is(
      state.logicalDraggedTab,
      fixture.mainPane,
      "Wrapper resolves to its owner"
    );
    Assert.deepEqual(
      state.movingTabs,
      [fixture.splitView, fixture.mainChild, fixture.secondaryChild],
      "The split row moves atomically before its shared descendants"
    );
    is(
      fixture.mainPane.splitview,
      fixture.splitView,
      "The native moving element is the existing split wrapper"
    );
    ok(
      state.movingTabs.includes(fixture.mainChild),
      "The first pane's child moves with the split row"
    );
    ok(
      state.movingTabs.includes(fixture.secondaryChild),
      "The folded secondary child moves with the split row"
    );
  } finally {
    window.TreeTabsDnD._endDrop();
    await cleanupSplitTreeFixture(fixture);
  }
});

add_task(async function test_unsplitting_places_companion_after_shared_tree() {
  await enableTreeTabs();
  const fixture = await createSplitTreeFixture("unsplit");

  try {
    const splitCreated = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "SplitViewCreated"
    );
    fixture.splitView = gBrowser.addTabSplitView([
      fixture.mainPane,
      fixture.secondaryPane,
    ]);
    await splitCreated;
    await waitForSplitTreeNormalization(fixture);

    const splitRemoved = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "SplitViewRemoved"
    );
    fixture.splitView.unsplitTabs("menu_separate");
    await splitRemoved;
    await waitForTreeCondition(
      () =>
        getTreeParent(fixture.secondaryPane) == fixture.ancestor &&
        fixture.secondaryPane._tPos > fixture.secondaryChild._tPos,
      "Waiting for the separated companion to follow the shared tree"
    );

    is(
      getTreeParent(fixture.secondaryPane),
      fixture.ancestor,
      "Separated companion becomes the owner's next sibling"
    );
    is(
      getTreeParent(fixture.secondaryChild),
      fixture.mainPane,
      "The first pane retains the shared descendants"
    );
    Assert.greater(
      fixture.secondaryPane._tPos,
      fixture.secondaryChild._tPos,
      "The companion follows the complete shared subtree in strip order"
    );
  } finally {
    await cleanupSplitTreeFixture(fixture);
  }
});

add_task(async function test_closing_primary_transfers_split_tree_links() {
  await enableTreeTabs();
  const fixture = await createSplitTreeFixture("primary-close");

  try {
    const splitCreated = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "SplitViewCreated"
    );
    fixture.splitView = gBrowser.addTabSplitView([
      fixture.mainPane,
      fixture.secondaryPane,
    ]);
    await splitCreated;
    await waitForSplitTreeNormalization(fixture);

    gBrowser.TreeTabsService.collapseSubtree(fixture.mainPane);
    await waitForTreeCondition(
      () => gBrowser.TreeTabsService.isCollapsed(fixture.mainPane),
      "Waiting for the primary split pane tree to collapse"
    );

    await BrowserTestUtils.removeTab(fixture.mainPane);
    await waitForTreeCondition(
      () =>
        getTreeParent(fixture.secondaryPane) == fixture.ancestor &&
        getTreeParent(fixture.mainChild) == fixture.secondaryPane &&
        getTreeParent(fixture.secondaryChild) == fixture.secondaryPane &&
        gBrowser.TreeTabsService.isCollapsed(fixture.secondaryPane),
      "Waiting for the surviving split pane to inherit the tree"
    );

    is(
      getTreeParent(fixture.secondaryPane),
      fixture.ancestor,
      "Surviving pane inherits the primary pane's parent"
    );
    is(
      getTreeParent(fixture.mainChild),
      fixture.secondaryPane,
      "Surviving pane inherits the primary pane's child"
    );
    is(
      getTreeParent(fixture.secondaryChild),
      fixture.secondaryPane,
      "Surviving pane keeps the folded secondary child"
    );
    ok(
      gBrowser.TreeTabsService.isCollapsed(fixture.secondaryPane),
      "Surviving pane inherits the collapsed state"
    );
    ok(
      !gBrowser.TreeTabsStore.hasActiveClosedTreeSet(window),
      "Closing one split pane does not leave a closed-tree transaction"
    );
  } finally {
    await cleanupSplitTreeFixture(fixture);
  }
});

add_task(async function test_closing_secondary_preserves_split_tree_links() {
  await enableTreeTabs();
  const fixture = await createSplitTreeFixture("secondary-close");

  try {
    const splitCreated = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "SplitViewCreated"
    );
    fixture.splitView = gBrowser.addTabSplitView([
      fixture.mainPane,
      fixture.secondaryPane,
    ]);
    await splitCreated;
    await waitForSplitTreeNormalization(fixture);

    gBrowser.TreeTabsService.collapseSubtree(fixture.mainPane);
    await BrowserTestUtils.removeTab(fixture.secondaryPane);
    await waitForTreeCondition(
      () =>
        getTreeParent(fixture.mainPane) == fixture.ancestor &&
        getTreeParent(fixture.mainChild) == fixture.mainPane &&
        getTreeParent(fixture.secondaryChild) == fixture.mainPane &&
        gBrowser.TreeTabsService.isCollapsed(fixture.mainPane),
      "Waiting for companion close to preserve the shared tree"
    );

    is(
      getTreeParent(fixture.mainPane),
      fixture.ancestor,
      "Closing a companion pane preserves the logical row's parent"
    );
    const children = gBrowser.TreeTabsService.getChildren(fixture.mainPane);
    is(children.length, 2, "Both descendant branches remain");
    is(children[0], fixture.mainChild, "The first branch remains in place");
    is(
      children[1],
      fixture.secondaryChild,
      "The folded secondary branch remains in place"
    );
    ok(
      gBrowser.TreeTabsService.isCollapsed(fixture.mainPane),
      "Closing a companion pane preserves collapse state"
    );
  } finally {
    await cleanupSplitTreeFixture(fixture);
  }
});

add_task(
  async function test_parent_drop_on_split_descendant_moves_parent_only() {
    await enableTreeTabs();
    const fixture = await createSplitTreeFixture("descendant-drop");

    try {
      const splitCreated = BrowserTestUtils.waitForEvent(
        gBrowser.tabContainer,
        "SplitViewCreated"
      );
      fixture.splitView = gBrowser.addTabSplitView([
        fixture.mainPane,
        fixture.secondaryPane,
      ]);
      await splitCreated;
      await waitForSplitTreeNormalization(fixture);

      fixture.ancestor._dragData = { dropElement: fixture.splitView };
      const state = window.TreeTabsDnD.prepareDrop(
        gBrowser.tabContainer,
        {
          altKey: false,
          ctrlKey: false,
          target: gBrowser.tabContainer,
        },
        {
          draggedTab: fixture.ancestor,
          movingTabs: [fixture.ancestor],
          dropEffect: "move",
        }
      );

      Assert.deepEqual(
        state.movingTabs,
        [fixture.ancestor],
        "Dropping a parent on a split descendant moves only the parent"
      );
      is(
        gBrowser.TreeTabsService.getChildren(fixture.ancestor).length,
        0,
        "Parent is detached from its children before the solo move"
      );
      window.TreeTabsDnD._endDrop();
      delete fixture.ancestor._dragData;
    } finally {
      window.TreeTabsDnD._endDrop();
      delete fixture.ancestor._dragData;
      await cleanupSplitTreeFixture(fixture);
    }
  }
);

add_task(async function test_split_view_normalizes_when_tree_tabs_reenabled() {
  await enableTreeTabs();
  const fixture = await createSplitTreeFixture("reenabled");

  try {
    await disableTreeTabs();

    const splitCreated = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "SplitViewCreated"
    );
    fixture.splitView = gBrowser.addTabSplitView([
      fixture.mainPane,
      fixture.secondaryPane,
    ]);
    await splitCreated;

    const treeUpdated = waitForTreeUpdate();
    Services.prefs.setBoolPref(PREF_TREE_ENABLED, true);
    await waitForTreeCondition(
      () => getVerticalTabsBox()?.hasAttribute("tree-tabs-enabled"),
      "Waiting for tree tabs to be re-enabled"
    );
    await treeUpdated;

    await waitForSplitTreeNormalization(fixture);
    assertSplitTreeNormalization(fixture);
  } finally {
    await cleanupSplitTreeFixture(fixture);
  }
});
