/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

async function withTreeDragFixture(task) {
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_AUTO_ATTACH, 0);
  Services.prefs.setBoolPref(PREF_TREE_AUTO_COLLAPSE_ON_SELECT, false);
  const initialTab = gBrowser.selectedTab;
  const reduceMotion = gReduceMotionOverride;
  gReduceMotionOverride = true;
  const tabs = [];
  const add = (name, parent = null) => {
    const tab = BrowserTestUtils.addTab(gBrowser, `about:blank?drag-${name}`, {
      skipAnimation: true,
    });
    tabs.push(tab);
    gBrowser.TreeTabsService.detachTab(tab);
    if (parent) {
      ok(
        gBrowser.TreeTabsService.attachTab(tab, parent),
        `${name} is attached`
      );
    }
    return tab;
  };

  try {
    await task(add);
  } finally {
    window.windowUtils.dragSession?.endDragSession(true, 0);
    window.TreeTabsDnD._endDrop();
    gBrowser.tabContainer.tabDragAndDrop.finishAnimateTabMove();
    gBrowser.tabContainer.tabDragAndDrop._resetTabsAfterDrop();
    for (const wrapper of new Set(
      tabs.map(tab => tab.splitview).filter(Boolean)
    )) {
      wrapper.unsplitTabs();
    }
    gBrowser.selectedTab = initialTab;
    for (const tab of tabs.reverse()) {
      if (tab.isConnected && !tab.closing) {
        gBrowser.TreeTabsService.expandSubtree(tab);
        await BrowserTestUtils.removeTab(tab);
      }
    }
    gReduceMotionOverride = reduceMotion;
  }
}

async function withNativeGroupDragFixture(task) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.groups.enabled", true],
      ["browser.tabs.dragDrop.moveOverThresholdPercent", 80],
      // Exercise insertion gaps without timed group entry or expansion.
      ["browser.tabs.dragDrop.createGroup.delayMS", 60_000],
      ["browser.tabs.dragDrop.expandGroup.delayMS", 60_000],
    ],
  });
  try {
    await withTreeDragFixture(task);
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

async function dragTreeTab(
  source,
  target,
  {
    edge = "center",
    initialEdge,
    steps = 0,
    altKey = false,
    checkDrag,
    checkDrop,
  } = {}
) {
  await waitForTreeUpdate();
  await window.promiseDocumentFlushed(() => {});
  const sourceRect = source.getBoundingClientRect();
  const targetRow =
    target.splitview || target.closest(".tab-group-label-container") || target;
  const targetRect = targetRow.getBoundingClientRect();
  const rtl = window.getComputedStyle(gBrowser.tabContainer).direction == "rtl";
  const indent = Services.prefs.getIntPref(PREF_TREE_INDENT_PX, 16);
  const positions = {
    before: targetRect.top + 1,
    after: targetRect.bottom - 1,
    center: targetRect.top + targetRect.height / 2,
  };
  const event = {
    clientX:
      sourceRect.x + sourceRect.width / 2 + steps * indent * (rtl ? -1 : 1),
    clientY: positions[edge],
    altKey,
  };
  let dragOverScreenX;
  const recordDragOver = dragEvent => {
    dragOverScreenX = dragEvent.screenX;
  };
  EventUtils.startDragSession(window, "move");
  gBrowser.tabContainer.addEventListener("dragover", recordDragOver, true);
  try {
    let [result, dataTransfer] = EventUtils.synthesizeDragOver(
      source,
      target,
      null,
      "move",
      window,
      window,
      initialEdge ? { ...event, clientY: positions[initialEdge] } : event
    );
    if (initialEdge) {
      await waitForTreeCondition(
        () =>
          new DOMMatrixReadOnly(window.getComputedStyle(targetRow).transform)
            .m42 != 0,
        "Waiting for the native insertion gap to displace the target row"
      );
      result = EventUtils.sendDragEvent(
        EventUtils.createDragEventObject(
          "dragover",
          target,
          window,
          dataTransfer,
          event
        ),
        target,
        window
      );
    }
    const draggedItem = source.splitview || source;
    ok(draggedItem._dragData, "Native dragstart initialized the moving item");
    // Gecko records dragstart at mousedown, not at the threshold-crossing move.
    is(
      Math.round(
        ((dragOverScreenX - draggedItem._dragData.screenX) * (rtl ? -1 : 1)) /
          indent
      ) + 0,
      steps,
      "The drag event carries exactly the requested horizontal nesting steps"
    );
    ok(
      gBrowser.tabContainer.hasAttribute("movingtab"),
      "Native dragover started the tab animation"
    );
    checkDrag?.(draggedItem._dragData);
    is(
      EventUtils.synthesizeDropAfterDragOver(
        result,
        dataTransfer,
        target,
        window,
        event
      ),
      "move",
      "The native drop handler accepted the move"
    );
    checkDrop?.(draggedItem);
  } finally {
    gBrowser.tabContainer.removeEventListener("dragover", recordDragOver, true);
    window.windowUtils.dragSession?.endDragSession(
      true,
      EventUtils._parseModifiers(event)
    );
  }
  await waitForTreeCondition(
    () =>
      !window.TreeTabsDnD._dropPending &&
      !gBrowser.tabContainer.hasAttribute("movingtab"),
    "Waiting for native movement and the tree handoff to finish"
  );
  ok(
    !window.TreeTabsDnD._suppressMoveFixup,
    "Move fixup is released after drop"
  );
}

function assertTreeDragOrder(tabs, message) {
  Assert.deepEqual(
    Array.from(gBrowser.tabs).filter(tab => tabs.includes(tab)),
    tabs,
    message
  );
}

add_task(async function test_reorder_branches_at_native_insertion_gap() {
  await withTreeDragFixture(async add => {
    const parent = add("reorder-parent");
    const first = add("reorder-first", parent);
    const firstChild = add("reorder-first-child", first);
    const moving = add("reorder-moving", parent);
    const movingChild = add("reorder-moving-child", moving);
    const last = add("reorder-last", parent);

    await dragTreeTab(moving, first, {
      edge: "before",
      checkDrag(data) {
        ok(data.dropElement, "Native animation resolved an insertion target");
        is(parent.dataset.treeDropTarget, "child", "The parent is previewed");
      },
    });
    Assert.deepEqual(
      gBrowser.TreeTabsService.getChildren(parent),
      [moving, first, last],
      "The branch is inserted first, not appended to the previewed parent"
    );
    is(getTreeParent(movingChild), moving, "The branch keeps its descendant");
    assertTreeDragOrder(
      [parent, moving, movingChild, first, firstChild, last],
      "The strip follows the reordered complete branches"
    );

    await dragTreeTab(moving, last, {
      edge: "before",
      checkDrag(data) {
        ok(
          (data.dropElement == last && data.dropBefore === true) ||
            (data.dropElement == firstChild && data.dropBefore === false),
          "Native placement targets the gap between the first subtree and last sibling"
        );
        is(
          parent.dataset.treeDropTarget,
          "child",
          "The outer parent remains previewed"
        );
      },
    });
    is(
      getTreeParent(moving),
      parent,
      "The downward move keeps the same tree parent"
    );
    is(
      getTreeParent(movingChild),
      moving,
      "The downward move keeps its descendant attached"
    );
    Assert.deepEqual(
      gBrowser.TreeTabsService.getChildren(parent),
      [first, moving, last],
      "The branch can also be inserted between siblings"
    );
    assertTreeDragOrder(
      [parent, first, firstChild, moving, movingChild, last],
      "The downward move leaves both subtrees contiguous"
    );
  });
});

add_task(
  async function test_drop_on_ancestor_reparents_without_displacing_target() {
    await withTreeDragFixture(async add => {
      const ancestor = add("ancestor");
      const parent = add("parent", ancestor);
      const moving = add("grandchild", parent);
      const descendant = add("descendant", moving);
      const trailing = add("ancestor-trailing");

      await dragTreeTab(moving, ancestor, {
        checkDrag(data) {
          is(
            data.dropElement,
            ancestor,
            "Native placement uses the hovered ancestor"
          );
          is(
            data.animDropElementIndex,
            moving.elementIndex,
            "Attaching does not animate a misleading sibling insertion gap"
          );
          is(
            ancestor.dataset.treeDropTarget,
            "child",
            "The ancestor is outlined"
          );
        },
      });
      is(
        getTreeParent(moving),
        ancestor,
        "The grandchild moves up one tree level"
      );
      is(getTreeParent(descendant), moving, "Its own child remains attached");
      is(
        gBrowser.TreeTabsService.getLevel(moving),
        1,
        "The moved row has the new depth"
      );
      assertTreeDragOrder(
        [ancestor, parent, moving, descendant, trailing],
        "The drop repairs strip order even when nesting changes without reordering"
      );
    });
  }
);

add_task(
  async function test_middle_drop_does_not_use_stale_translated_bounds() {
    await withTreeDragFixture(async add => {
      const target = add("translated-target");
      const moving = add("translated-moving");
      add("translated-trailing");
      await dragTreeTab(moving, target, { initialEdge: "before" });
      is(
        getTreeParent(moving),
        target,
        "A middle-row drop attaches directly to the row"
      );
      assertTreeDragOrder([target, moving], "The child follows its parent");
    });
  }
);

add_task(
  async function test_collapsed_subtree_drop_waits_only_for_animated_rows() {
    await withTreeDragFixture(async add => {
      const first = gBrowser.tabs[0];
      const parent = add("animated-parent");
      const child = add("animated-child", parent);
      const hidden = add("animated-hidden", parent);
      add("animated-trailing");
      gBrowser.selectedTab = parent;
      gBrowser.hideTab(hidden);
      gBrowser.TreeTabsService.collapseSubtree(parent);
      await waitForTreeCondition(
        () => isTreeHidden(child) && hidden.hidden,
        "Waiting for descendants to be hidden before the drag"
      );
      gReduceMotionOverride = false;

      await dragTreeTab(parent, first, {
        edge: "before",
        checkDrag(data) {
          Assert.deepEqual(
            data.movingTabs,
            [parent],
            "Only the visible root was animated"
          );
        },
        checkDrop(item) {
          ok(
            item.hasAttribute("tabdrop-samewindow"),
            "The native transition path is exercised"
          );
          ok(
            window.TreeTabsDnD._dropPending,
            "Tree placement waits for native movement"
          );
          ok(
            !child.hasAttribute("tabdrop-samewindow"),
            "Tree-hidden children are not awaited"
          );
          ok(
            !hidden.hasAttribute("tabdrop-samewindow"),
            "Explicitly hidden children are not awaited"
          );
          ok(
            !item._dragData,
            "Native cleanup has discarded the original drag data"
          );
        },
      });
      is(
        gBrowser.tabs[0],
        parent,
        "The animated drop really completed before the first tab"
      );
      assertTreeDragOrder(
        [parent, child, hidden, first],
        "Hidden descendants follow the root"
      );
      is(
        getTreeParent(child),
        parent,
        "The tree-hidden child retains its parent"
      );
      is(
        getTreeParent(hidden),
        parent,
        "The explicitly hidden child retains its parent"
      );
      ok(
        hidden.hidden,
        "Moving the subtree does not reveal explicitly hidden tabs"
      );
      ok(
        gBrowser.TreeTabsService.isCollapsed(parent),
        "The moved subtree stays collapsed"
      );
    });
  }
);

add_task(
  async function test_horizontal_placement_survives_native_drag_cleanup() {
    await withTreeDragFixture(async add => {
      const moving = add("indent-moving");
      const child = add("indent-child", moving);
      const target = add("indent-target");
      gReduceMotionOverride = false;
      await dragTreeTab(moving, target, {
        edge: "after",
        steps: 1,
        checkDrop(item) {
          ok(
            item.hasAttribute("tabdrop-samewindow"),
            "Placement is deferred until the transition ends"
          );
          ok(!item._dragData, "The gesture origin has already been discarded");
        },
      });
      is(
        getTreeParent(moving),
        target,
        "The inline gesture still nests at the end of the strip"
      );
      is(
        getTreeParent(child),
        moving,
        "The newly nested branch keeps its child"
      );
      assertTreeDragOrder(
        [target, moving, child],
        "The deferred drop preserves full subtree order"
      );
    });
  }
);

add_task(async function test_alt_drag_leaves_children_and_places_only_parent() {
  await withTreeDragFixture(async add => {
    const target = add("alt-target");
    const parent = add("alt-parent");
    const first = add("alt-first", parent);
    const second = add("alt-second", parent);

    await dragTreeTab(parent, target, { altKey: true });
    is(
      getTreeParent(parent),
      target,
      "The detached parent is placed at the hovered target"
    );
    is(
      getTreeParent(first),
      null,
      "The first child is promoted where it was left"
    );
    is(
      getTreeParent(second),
      first,
      "Remaining children stay under the promoted child"
    );
    assertTreeDragOrder(
      [target, parent, first, second],
      "The children do not travel with the parent"
    );
  });
});

add_task(async function test_split_row_drop_preserves_preorder_and_wrapper() {
  await withTreeDragFixture(async add => {
    const ancestor = add("split-ancestor");
    const primary = add("split-primary", ancestor);
    const child = add("split-child", primary);
    const secondary = add("split-secondary", ancestor);
    const secondaryChild = add("split-secondary-child", secondary);
    const wrapper = gBrowser.addTabSplitView([primary, secondary]);
    await waitForTreeCondition(
      () => getTreeParent(secondaryChild) == primary,
      "Waiting for both split panes to share one tree"
    );
    Assert.greater(
      primary._tPos,
      child._tPos,
      "The split API appends the wrapper by default"
    );

    await dragTreeTab(primary, ancestor, {
      checkDrag(data) {
        Assert.deepEqual(
          data.movingTabs,
          [wrapper],
          "The native drag moves the wrapper"
        );
      },
    });
    is(primary.splitview, wrapper, "The primary remains in the same wrapper");
    is(secondary.splitview, wrapper, "The companion moves atomically with it");
    Assert.deepEqual(
      gBrowser.TreeTabsService.getChildren(primary),
      [child, secondaryChild],
      "Both shared descendants retain their logical order"
    );
    assertTreeDragOrder(
      [ancestor, primary, secondary, child, secondaryChild],
      "The wrapper precedes its descendants after the native drop"
    );
  });
});

async function dragSoleNativeGroupRow(split = false) {
  await withNativeGroupDragFixture(async add => {
    const before = add("group-self-before");
    const moving = add("group-self-moving");
    const companion = split ? add("group-self-companion") : null;
    const after = add("group-self-after");
    const members = companion ? [moving, companion] : [moving];
    const wrapper = split
      ? gBrowser.addTabSplitView(members, { insertBefore: moving })
      : null;
    const row = wrapper || moving;
    const group = gBrowser.addTabGroup([row], {
      insertBefore: row,
      label: "Sole moving row",
    });

    await dragTreeTab(moving, group.labelElement, {
      edge: "after",
      checkDrag(data) {
        // Expanded group-label drops target the first pane, not its wrapper.
        is(
          data.dropElement,
          group.tabs[0],
          "Native placement targets the first tab inside its own group"
        );
        is(
          data.dropBefore,
          true,
          "The insertion gap is before that tab, below its own header"
        );
      },
    });
    ok(group.isConnected, "The native group survives the self-drop");
    Assert.deepEqual(group.tabs, members, "The group keeps all of its panes");
    for (const tab of members) {
      is(tab.group, group, "The dropped pane remains in its native group");
    }
    is(getTreeParent(moving), null, "The grouped row remains a tree root");
    if (wrapper) {
      is(moving.splitview, wrapper, "The primary retains its split wrapper");
      is(companion.splitview, wrapper, "The companion moves atomically");
    }
    assertTreeDragOrder(
      [before, ...members, after],
      "A self-drop does not append the row to the outer strip"
    );
  });
}

add_task(async function test_sole_tab_native_group_self_drop_stays_grouped() {
  await dragSoleNativeGroupRow();
});

add_task(
  async function test_sole_split_row_native_group_self_drop_stays_grouped() {
    await dragSoleNativeGroupRow(true);
  }
);

async function dragTreeBranchBetweenCollapsedGroups(edge) {
  await withNativeGroupDragFixture(async add => {
    const before = add("group-boundary-before");
    let moving;
    let movingChild;
    const addMovingBranch = () => {
      moving = add("group-boundary-moving");
      movingChild = add("group-boundary-moving-child", moving);
    };
    if (edge == "after") {
      addMovingBranch();
    }
    const left = add("group-boundary-left");
    const leftChild = add("group-boundary-left-child", left);
    const right = add("group-boundary-right");
    const rightChild = add("group-boundary-right-child", right);
    if (edge == "before") {
      addMovingBranch();
    }
    const after = add("group-boundary-after");
    const leftGroup = gBrowser.addTabGroup([left, leftChild], {
      insertBefore: left,
      label: "Left collapsed group",
    });
    const rightGroup = gBrowser.addTabGroup([right, rightChild], {
      insertBefore: right,
      label: "Right collapsed group",
    });
    const groups = [leftGroup, rightGroup];
    gBrowser.selectedTab = moving;
    for (const group of groups) {
      group.collapsed = true;
    }
    await waitForTreeCondition(
      () =>
        groups.every(
          group => group.collapsed && group.tabs.every(tab => !tab.visible)
        ),
      "Waiting for both native groups to hide their member rows"
    );

    const targetGroup = edge == "before" ? rightGroup : leftGroup;
    await dragTreeTab(moving, targetGroup.labelElement, {
      edge,
      checkDrag(data) {
        ok(
          ((data.dropElement == leftGroup ||
            data.dropElement == leftGroup.labelElement) &&
            data.dropBefore === false) ||
            ((data.dropElement == rightGroup ||
              data.dropElement == rightGroup.labelElement) &&
              data.dropBefore === true),
          "Native placement resolves the gap between the collapsed groups"
        );
        ok(
          !data.shouldDropIntoCollapsedTabGroup,
          "The gesture inserts beside the groups, not into one"
        );
      },
    });
    is(getTreeParent(moving), null, "The moved branch remains a root");
    is(getTreeParent(movingChild), moving, "The branch keeps its child");
    is(moving.group, null, "The branch stays outside both native groups");
    is(movingChild.group, null, "Its child also stays outside both groups");
    is(getTreeParent(leftChild), left, "The left group keeps its tree");
    is(getTreeParent(rightChild), right, "The right group keeps its tree");
    for (const [group, members] of [
      [leftGroup, [left, leftChild]],
      [rightGroup, [right, rightChild]],
    ]) {
      ok(group.collapsed, "The native group remains collapsed after drop");
      Assert.deepEqual(group.tabs, members, "Group membership is unchanged");
    }
    const roots = [before, left, moving, right, after];
    Assert.deepEqual(
      gBrowser.TreeTabsService.getRootTabs(window).filter(tab =>
        roots.includes(tab)
      ),
      roots,
      "Tree roots retain the same native group boundary as the strip"
    );
    assertTreeDragOrder(
      [before, left, leftChild, moving, movingChild, right, rightChild, after],
      `Dropping ${edge} a collapsed group keeps complete trees in preorder`
    );
  });
}

add_task(async function test_tree_drag_before_collapsed_native_group() {
  await dragTreeBranchBetweenCollapsedGroups("before");
});

add_task(async function test_tree_drag_after_collapsed_native_group() {
  await dragTreeBranchBetweenCollapsedGroups("after");
});

add_task(async function test_rtl_branch_drag_keeps_preorder() {
  await BrowserTestUtils.enableRtlLocale();
  try {
    await withTreeDragFixture(async add => {
      const parent = add("rtl-parent");
      const first = add("rtl-first", parent);
      const moving = add("rtl-moving", parent);
      const child = add("rtl-child", moving);
      const last = add("rtl-last", parent);
      await dragTreeTab(moving, first, { edge: "before" });
      Assert.deepEqual(
        gBrowser.TreeTabsService.getChildren(parent),
        [moving, first, last],
        "RTL vertical dragging preserves sibling placement"
      );
      assertTreeDragOrder(
        [parent, moving, child, first, last],
        "RTL does not reverse the subtree"
      );
    });
  } finally {
    await BrowserTestUtils.disableRtlLocale();
  }
});
