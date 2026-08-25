/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TreeTabsService } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsService.sys.mjs"
);

function setupTreeService(options = {}) {
  TreeTabsService._windowStates.clear();
  resetTreeTestPrefs();

  const enabled = "enabled" in options ? options.enabled : true;
  Services.prefs.setBoolPref(TREE_PREF_ENABLED, enabled);

  if ("autoAttach" in options) {
    Services.prefs.setIntPref(TREE_PREF_AUTO_ATTACH, options.autoAttach);
  }
  if ("closeParentBehavior" in options) {
    Services.prefs.setIntPref(
      TREE_PREF_CLOSE_PARENT_BEHAVIOR,
      options.closeParentBehavior
    );
  }
  if ("maxDepth" in options) {
    Services.prefs.setIntPref(TREE_PREF_MAX_DEPTH, options.maxDepth);
  }
}

function assertSameTabSet(actualTabs, expectedTabs, message) {
  Assert.equal(actualTabs.length, expectedTabs.length, `${message}: length`);
  for (const tab of expectedTabs) {
    Assert.ok(actualTabs.includes(tab), `${message}: contains tab ${tab.id}`);
  }
}

registerCleanupFunction(() => {
  TreeTabsService._windowStates.clear();
  resetTreeTestPrefs();
});

add_task(function test_invariant_rejects_cycles() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const child = createMockTab(win);
  const grandChild = createMockTab(win);

  Assert.ok(TreeTabsService.attachTab(child, root), "Attached child to root");
  Assert.ok(
    TreeTabsService.attachTab(grandChild, child),
    "Attached grandchild to child"
  );

  Assert.ok(
    !TreeTabsService.attachTab(root, grandChild),
    "Attaching a tab to its own descendant is rejected"
  );

  Assert.equal(
    TreeTabsService.getParent(root),
    null,
    "Root parent is unchanged"
  );
  Assert.equal(
    TreeTabsService.getParent(child),
    root,
    "Child remains attached to root"
  );
  Assert.equal(
    TreeTabsService.getParent(grandChild),
    child,
    "Grandchild remains attached to child"
  );
});

add_task(function test_invariant_rejects_pinned_parent() {
  setupTreeService();

  const win = createMockWindow();
  const parent = createMockTab(win);
  const child = createMockTab(win);
  const pinnedParent = createMockTab(win, { pinned: true });

  Assert.ok(
    TreeTabsService.attachTab(child, parent),
    "Child attached to parent"
  );
  Assert.equal(
    TreeTabsService.getParent(child),
    parent,
    "Child starts as a non-root"
  );

  Assert.ok(
    !TreeTabsService.attachTab(child, pinnedParent),
    "Pinned parent is rejected"
  );
  Assert.equal(
    TreeTabsService.getParent(child),
    parent,
    "A rejected attach leaves the child under its original parent"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [parent],
    "Root order is unchanged"
  );
});

add_task(function test_child_order_is_maintained_after_mutations() {
  setupTreeService();

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);
  const c = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(b, parent);
  TreeTabsService.attachTab(c, parent);
  assertTabOrder(
    TreeTabsService.getChildren(parent),
    [a, b, c],
    "Initial child order follows attach order"
  );

  TreeTabsService.detachTab(b);
  assertTabOrder(
    TreeTabsService.getChildren(parent),
    [a, c],
    "Detaching a child keeps sibling order stable"
  );

  TreeTabsService.attachTab(b, parent, { insertBefore: c });
  assertTabOrder(
    TreeTabsService.getChildren(parent),
    [a, b, c],
    "insertBefore restores the intended position"
  );

  TreeTabsService.moveTabSubtree(c, 0);
  assertTabOrder(
    TreeTabsService.getChildren(parent),
    [c, a, b],
    "moveTabSubtree updates sibling order"
  );
});

add_task(function test_levels_follow_ancestor_chain_length() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const child = createMockTab(win);
  const grandChild = createMockTab(win);
  const greatGrandChild = createMockTab(win);

  TreeTabsService.attachTab(child, root);
  TreeTabsService.attachTab(grandChild, child);
  TreeTabsService.attachTab(greatGrandChild, grandChild);

  Assert.equal(TreeTabsService.getLevel(root), 0, "Root is level 0");
  Assert.equal(TreeTabsService.getLevel(child), 1, "Child is level 1");
  Assert.equal(
    TreeTabsService.getLevel(grandChild),
    2,
    "Grandchild is level 2"
  );
  Assert.equal(
    TreeTabsService.getLevel(greatGrandChild),
    3,
    "Great-grandchild is level 3"
  );

  Assert.equal(
    TreeTabsService.getAncestors(greatGrandChild).length,
    TreeTabsService.getLevel(greatGrandChild),
    "Level equals ancestor chain length"
  );
});

add_task(function test_collapsed_nodes_hide_descendants_from_visible_tabs() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const child = createMockTab(win);
  const grandChild = createMockTab(win);
  const otherRoot = createMockTab(win);

  // Ensure both roots exist in model with stable order.
  TreeTabsService.init(win);

  TreeTabsService.attachTab(child, root);
  TreeTabsService.attachTab(grandChild, child);

  assertTabOrder(
    TreeTabsService.getVisibleTabs(win),
    [root, child, grandChild, otherRoot],
    "All tabs are visible when expanded"
  );

  TreeTabsService.collapseSubtree(child);
  assertTabOrder(
    TreeTabsService.getVisibleTabs(win),
    [root, child, otherRoot],
    "Collapsed child hides all descendants"
  );

  TreeTabsService.collapseSubtree(root);
  assertTabOrder(
    TreeTabsService.getVisibleTabs(win),
    [root, otherRoot],
    "Collapsed root hides the entire subtree"
  );
});

add_task(function test_attach_operations_insert_nested_and_reattach() {
  setupTreeService();

  const win = createMockWindow();
  const rootA = createMockTab(win);
  const rootB = createMockTab(win);
  const x = createMockTab(win);
  const y = createMockTab(win);
  const z = createMockTab(win);
  const deepParent = createMockTab(win);
  const deepChild = createMockTab(win);

  // Ensure both roots are in the model.
  TreeTabsService.init(win);

  Assert.ok(TreeTabsService.attachTab(x, rootA), "Basic attach succeeds");
  Assert.ok(
    TreeTabsService.attachTab(y, rootA),
    "Second child attach succeeds"
  );
  Assert.ok(
    TreeTabsService.attachTab(z, rootA, { insertAfter: x }),
    "insertAfter positions child relative to sibling"
  );
  assertTabOrder(
    TreeTabsService.getChildren(rootA),
    [x, z, y],
    "Children respect insertAfter ordering"
  );

  Assert.ok(
    TreeTabsService.attachTab(deepParent, z),
    "Can attach to a nested parent"
  );
  Assert.ok(
    TreeTabsService.attachTab(deepChild, deepParent),
    "Deeply nested attaches succeed"
  );
  Assert.equal(
    TreeTabsService.getLevel(deepChild),
    3,
    "Deep nesting level is computed correctly"
  );

  Assert.ok(
    TreeTabsService.attachTab(z, rootB),
    "Re-attaching between parents works"
  );
  Assert.equal(TreeTabsService.getParent(z), rootB, "Tab moved to new parent");
  assertTabOrder(
    TreeTabsService.getChildren(rootA),
    [x, y],
    "Old parent child order updates after re-attach"
  );
  assertTabOrder(
    TreeTabsService.getChildren(rootB),
    [z],
    "New parent now contains moved tab"
  );
  Assert.equal(
    TreeTabsService.getParent(deepParent),
    z,
    "Moved subtree keeps descendant relationships"
  );
});

add_task(function test_detach_tab_promotes_child_to_root_and_root_noop() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);
  const c = createMockTab(win);

  TreeTabsService.attachTab(a, root);
  TreeTabsService.attachTab(b, root);
  TreeTabsService.attachTab(c, root);

  TreeTabsService.detachTab(b);
  Assert.equal(
    TreeTabsService.getParent(b),
    null,
    "Detached child becomes a root"
  );
  assertTabOrder(
    TreeTabsService.getChildren(root),
    [a, c],
    "Detaching a child preserves remaining sibling order"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [root, b],
    "Detached tab is placed among roots"
  );

  TreeTabsService.detachTab(root);
  Assert.equal(
    TreeTabsService.getParent(root),
    null,
    "Detaching root is a no-op"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [root, b],
    "Root list is unchanged after detaching root"
  );
});

add_task(function test_detach_all_children_without_reparent() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);

  TreeTabsService.attachTab(a, root);
  TreeTabsService.attachTab(b, root);

  TreeTabsService.detachAllChildren(root);
  assertTabOrder(
    TreeTabsService.getChildren(root),
    [],
    "Parent has no children"
  );
  Assert.equal(TreeTabsService.getParent(a), null, "First child is now a root");
  Assert.equal(
    TreeTabsService.getParent(b),
    null,
    "Second child is now a root"
  );

  const roots = TreeTabsService.getRootTabs(win);
  assertSameTabSet(roots, [root, a, b], "All tabs become roots");
});

add_task(function test_detach_all_children_with_reparent() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const reparentTo = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);

  // Ensure reparent target exists as a root.
  TreeTabsService.getLevel(reparentTo);

  TreeTabsService.attachTab(a, root);
  TreeTabsService.attachTab(b, root);

  TreeTabsService.detachAllChildren(root, { reparentTo });
  assertTabOrder(
    TreeTabsService.getChildren(root),
    [],
    "Old parent has no children"
  );
  assertTabOrder(
    TreeTabsService.getChildren(reparentTo),
    [a, b],
    "Children are reparented in order"
  );
  Assert.equal(
    TreeTabsService.getParent(a),
    reparentTo,
    "First child reparented"
  );
  Assert.equal(
    TreeTabsService.getParent(b),
    reparentTo,
    "Second child reparented"
  );
});

add_task(function test_detach_and_reattach_preserves_tree() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const child = createMockTab(win);
  const grandchild = createMockTab(win);

  TreeTabsService.attachTab(child, root);
  TreeTabsService.attachTab(grandchild, child);

  // Simulate extension hide by detaching the child tab.
  TreeTabsService.detachTab(child);
  Assert.equal(
    TreeTabsService.getParent(grandchild),
    child,
    "Grandchild stays attached to detached child"
  );

  // Simulate extension show by restoring the previous parent.
  TreeTabsService.attachTab(child, root);
  Assert.equal(TreeTabsService.getParent(child), root, "Child reattached");
  Assert.equal(
    TreeTabsService.getParent(grandchild),
    child,
    "Grandchild still under child after reattach"
  );
});

add_task(function test_move_tab_subtree_within_siblings_and_roots() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const root2 = createMockTab(win);
  const root3 = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);
  const c = createMockTab(win);

  TreeTabsService.init(win);

  TreeTabsService.attachTab(a, root);
  TreeTabsService.attachTab(b, root);
  TreeTabsService.attachTab(c, root);

  TreeTabsService.moveTabSubtree(c, 1);
  assertTabOrder(
    TreeTabsService.getChildren(root),
    [a, c, b],
    "moveTabSubtree reorders siblings"
  );

  TreeTabsService.moveTabSubtree(root3, 0);
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [root3, root, root2],
    "moveTabSubtree reorders roots across positions"
  );
});

add_task(function test_collapse_expand_and_toggle() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const child = createMockTab(win);

  TreeTabsService.attachTab(child, root);

  Assert.equal(TreeTabsService.isCollapsed(root), false, "Starts expanded");
  TreeTabsService.collapseSubtree(root);
  Assert.equal(
    TreeTabsService.isCollapsed(root),
    true,
    "collapseSubtree collapses"
  );

  TreeTabsService.toggleCollapsed(root);
  Assert.equal(
    TreeTabsService.isCollapsed(root),
    false,
    "toggleCollapsed expands"
  );

  TreeTabsService.toggleCollapsed(root);
  Assert.equal(
    TreeTabsService.isCollapsed(root),
    true,
    "toggleCollapsed collapses"
  );

  TreeTabsService.expandSubtree(root);
  Assert.equal(
    TreeTabsService.isCollapsed(root),
    false,
    "expandSubtree expands"
  );
});

add_task(function test_visible_tabs_nested_collapse_and_subtree_state() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const child = createMockTab(win);
  const grandChild = createMockTab(win);
  const leaf = createMockTab(win);
  const otherRoot = createMockTab(win);

  TreeTabsService.init(win);

  TreeTabsService.attachTab(child, root);
  TreeTabsService.attachTab(grandChild, child);
  TreeTabsService.attachTab(leaf, grandChild);

  TreeTabsService.collapseSubtree(grandChild);
  TreeTabsService.collapseSubtree(child);

  assertTabOrder(
    TreeTabsService.getVisibleTabs(win),
    [root, child, otherRoot],
    "Collapsed ancestor hides nested collapsed subtree"
  );

  TreeTabsService.expandSubtree(child);
  assertTabOrder(
    TreeTabsService.getVisibleTabs(win),
    [root, child, grandChild, otherRoot],
    "Expanding ancestor keeps nested collapse state"
  );

  Assert.equal(
    TreeTabsService.isSubtreeCollapsed(leaf),
    true,
    "Leaf sees collapsed ancestor"
  );
  Assert.equal(
    TreeTabsService.isSubtreeCollapsed(grandChild),
    false,
    "Collapsed node without collapsed ancestor returns false"
  );

  TreeTabsService.collapseSubtree(root);
  Assert.equal(
    TreeTabsService.isSubtreeCollapsed(child),
    true,
    "Tab under collapsed root reports subtree collapsed"
  );
});

add_task(function test_horizontal_mode_preserves_tree_without_auto_attach() {
  setupTreeService({ autoAttach: 1 });
  const win = createMockWindow();
  win.gBrowser.tabContainer = { verticalMode: true };
  const parent = createMockTab(win);
  const child = createMockTab(win);
  const pinned = createMockTab(win, { pinned: true });
  TreeTabsService.attachTab(child, parent);
  TreeTabsService.collapseSubtree(parent);
  win.gBrowser.tabContainer.verticalMode = false;

  Assert.ok(TreeTabsService.enabled, "The saved model remains enabled");
  Assert.ok(!TreeTabsService.isActive(win), "Automatic behavior is inactive");
  for (const info of [
    { opener: parent },
    { opener: child, duplicate: true },
    { nextSiblingOf: child },
    { opener: pinned },
    { opener: pinned },
    { currentTab: child },
  ]) {
    const opened = createMockTab(win, { openerTab: info.opener });
    TreeTabsService.onTabOpened(opened, info);
    Assert.equal(
      TreeTabsService.getParent(opened),
      null,
      "Horizontal opens remain independent"
    );
  }
  Assert.equal(TreeTabsService.getSubtreeEndAnchor(parent), null);
  Assert.equal(TreeTabsService.getNewTabAnchor(parent, child), null);
  Assert.equal(TreeTabsService.getPinnedOpenerAnchor(pinned, child, win), null);
  Assert.equal(TreeTabsService.getSuccessor(parent), null);
  Assert.equal(TreeTabsService.getParent(child), parent);
  Assert.ok(
    TreeTabsService.isCollapsed(parent),
    "Saved collapse is not discarded"
  );
  win.gBrowser.tabContainer.verticalMode = true;
  Assert.ok(TreeTabsService.isActive(win));
  Assert.equal(TreeTabsService.getParent(child), parent);
});

add_task(
  function test_horizontal_close_never_creates_groups_or_closes_children() {
    for (const closeParentBehavior of [0, 1, 2, 3, 4]) {
      setupTreeService({ closeParentBehavior });
      const win = createMockWindow();
      win.gBrowser.tabContainer = { verticalMode: false };
      const parent = createMockTab(win);
      const first = createMockTab(win);
      const second = createMockTab(win);
      const grandchild = createMockTab(win);
      TreeTabsService.attachTab(first, parent);
      TreeTabsService.attachTab(second, parent);
      TreeTabsService.attachTab(grandchild, first);
      TreeTabsService.collapseSubtree(parent);
      const unexpectedNotification = () =>
        Assert.ok(
          false,
          "Closing a horizontal parent must not request a replacement group"
        );
      Services.obs.addObserver(
        unexpectedNotification,
        "tree-tabs-group-replace-requested"
      );
      try {
        assertTabOrder(
          TreeTabsService.getTabsClosingWith(parent),
          [parent],
          "Only the clicked tab closes"
        );
        Assert.deepEqual(TreeTabsService.onTabClosed(parent), []);
        Assert.equal(TreeTabsService.getParent(first), null);
        Assert.equal(TreeTabsService.getParent(second), null);
        Assert.equal(
          TreeTabsService.getParent(grandchild),
          first,
          "The remaining subtree is retained"
        );
      } finally {
        Services.obs.removeObserver(
          unexpectedNotification,
          "tree-tabs-group-replace-requested"
        );
      }
    }
  }
);

add_task(function test_on_tab_opened_auto_attach_off_makes_root() {
  setupTreeService({ autoAttach: 0 });

  const win = createMockWindow();
  const tab = createMockTab(win);

  TreeTabsService.onTabOpened(tab);
  Assert.equal(TreeTabsService.getParent(tab), null, "Tab stays as root");
  assertTabOrder(TreeTabsService.getRootTabs(win), [tab], "Tab is a root tab");
});

add_task(function test_on_tab_opened_auto_attach_child_of_opener() {
  setupTreeService({ autoAttach: 1 });

  const win = createMockWindow();
  const opener = createMockTab(win);
  const tab = createMockTab(win, { openerTab: opener });

  TreeTabsService.onTabOpened(tab, { opener });
  Assert.equal(
    TreeTabsService.getParent(tab),
    opener,
    "Tab is attached to opener"
  );
  assertTabOrder(
    TreeTabsService.getChildren(opener),
    [tab],
    "Opener contains opened tab as child"
  );
});

add_task(function test_on_tab_opened_auto_attach_sibling_of_current() {
  setupTreeService({ autoAttach: 2 });

  const win = createMockWindow();
  const parent = createMockTab(win);
  const before = createMockTab(win);
  const current = createMockTab(win);
  const opened = createMockTab(win);

  TreeTabsService.attachTab(before, parent);
  TreeTabsService.attachTab(current, parent);

  win.gBrowser.selectedTab = current;
  TreeTabsService.onTabOpened(opened, { currentTab: current });

  Assert.equal(
    TreeTabsService.getParent(opened),
    parent,
    "Opened tab shares current tab parent"
  );
  assertTabOrder(
    TreeTabsService.getChildren(parent),
    [before, current, opened],
    "Opened tab is inserted as sibling after current"
  );
});

add_task(function test_on_tab_opened_with_pinned_opener_becomes_root() {
  setupTreeService({ autoAttach: 1 });

  const win = createMockWindow();
  const opener = createMockTab(win, { pinned: true });
  const opened = createMockTab(win, { openerTab: opener });

  TreeTabsService.onTabOpened(opened, { opener });
  Assert.equal(
    TreeTabsService.getParent(opened),
    null,
    "Pinned opener is ignored"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [opened],
    "Opened tab is root"
  );
});

add_task(function test_concurrent_root_tabs_stay_independent() {
  setupTreeService({ autoAttach: 1 });

  const win = createMockWindow();
  const existing = createMockTab(win);
  TreeTabsService.getLevel(existing); // register in model

  const newA = createMockTab(win);
  const newB = createMockTab(win);
  TreeTabsService.onTabOpened(newA, { opener: null, currentTab: existing });
  TreeTabsService.onTabOpened(newB, { opener: null, currentTab: existing });

  Assert.equal(
    TreeTabsService.getParent(newA),
    null,
    "First concurrent tab is root"
  );
  Assert.equal(
    TreeTabsService.getParent(newB),
    null,
    "Second concurrent tab is root"
  );
});

add_task(function test_on_tab_closed_behavior_promote_first() {
  setupTreeService({ closeParentBehavior: 0 });

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(b, parent);

  const result = TreeTabsService.onTabClosed(parent);
  Assert.equal(result.length, 0, "No close request for descendants");
  Assert.equal(
    TreeTabsService.getParent(a),
    null,
    "First child promoted to root"
  );
  Assert.equal(
    TreeTabsService.getParent(b),
    a,
    "Other child reparented under first"
  );
  assertTabOrder(
    TreeTabsService.getChildren(a),
    [b],
    "First child adopts siblings"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [a],
    "Only promoted tab is root"
  );
});

add_task(function test_on_tab_closed_promote_first_with_grandparent() {
  setupTreeService({ closeParentBehavior: 0 });

  const win = createMockWindow();
  const grandparent = createMockTab(win);
  const parent = createMockTab(win);
  const childA = createMockTab(win);
  const childB = createMockTab(win);
  const sibling = createMockTab(win);

  TreeTabsService.attachTab(parent, grandparent);
  TreeTabsService.attachTab(childA, parent);
  TreeTabsService.attachTab(childB, parent);
  TreeTabsService.attachTab(sibling, grandparent);

  TreeTabsService.onTabClosed(parent);

  Assert.equal(
    TreeTabsService.getParent(childA),
    grandparent,
    "First child promoted under grandparent, not to root"
  );
  Assert.equal(
    TreeTabsService.getParent(childB),
    childA,
    "Second child reparented under promoted first child"
  );
  Assert.equal(
    TreeTabsService.getParent(sibling),
    grandparent,
    "Sibling of closed parent unchanged"
  );
  assertTabOrder(
    TreeTabsService.getChildren(grandparent),
    [childA, sibling],
    "Promoted child takes closed parent's position among siblings"
  );
});

add_task(function test_on_tab_closed_behavior_promote_all() {
  setupTreeService({ closeParentBehavior: 1 });

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(b, parent);

  const result = TreeTabsService.onTabClosed(parent);
  Assert.equal(result.length, 0, "No close request for descendants");
  Assert.equal(
    TreeTabsService.getParent(a),
    null,
    "First child promoted to root"
  );
  Assert.equal(
    TreeTabsService.getParent(b),
    null,
    "Second child promoted to root"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [a, b],
    "All children promoted"
  );
});

add_task(function test_on_tab_closed_promote_all_with_grandparent() {
  setupTreeService({ closeParentBehavior: 1 });

  const win = createMockWindow();
  const grandparent = createMockTab(win);
  const parent = createMockTab(win);
  const childA = createMockTab(win);
  const childB = createMockTab(win);

  TreeTabsService.attachTab(parent, grandparent);
  TreeTabsService.attachTab(childA, parent);
  TreeTabsService.attachTab(childB, parent);

  TreeTabsService.onTabClosed(parent);

  Assert.equal(
    TreeTabsService.getParent(childA),
    grandparent,
    "First child promoted under grandparent"
  );
  Assert.equal(
    TreeTabsService.getParent(childB),
    grandparent,
    "Second child promoted under grandparent"
  );
});

add_task(function test_on_tab_closed_behavior_close_subtree() {
  setupTreeService({ closeParentBehavior: 2 });

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);
  const grandChild = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(b, parent);
  TreeTabsService.attachTab(grandChild, a);

  const closedTabs = TreeTabsService.onTabClosed(parent);
  assertSameTabSet(
    closedTabs,
    [a, b, grandChild],
    "Close subtree returns all descendants"
  );

  Assert.equal(
    TreeTabsService.getParent(a),
    null,
    "Child becomes root after detach"
  );
  Assert.equal(
    TreeTabsService.getParent(b),
    null,
    "Sibling becomes root after detach"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [a, b],
    "Children promoted to roots"
  );
  Assert.equal(
    TreeTabsService.getDescendants(parent).length,
    0,
    "Closed parent is removed from model"
  );
});

add_task(function test_close_subtree_deep_nesting() {
  setupTreeService({ closeParentBehavior: 2 });

  const win = createMockWindow();
  const root = createMockTab(win);
  const parent = createMockTab(win);
  const child = createMockTab(win);
  const grandchild = createMockTab(win);
  const greatGrandchild = createMockTab(win);

  TreeTabsService.attachTab(parent, root);
  TreeTabsService.attachTab(child, parent);
  TreeTabsService.attachTab(grandchild, child);
  TreeTabsService.attachTab(greatGrandchild, grandchild);

  const closedTabs = TreeTabsService.onTabClosed(parent);
  assertSameTabSet(
    closedTabs,
    [child, grandchild, greatGrandchild],
    "All deeply nested descendants returned for closure"
  );
  Assert.equal(
    TreeTabsService.getChildren(root).length,
    0,
    "Root has no children after subtree closed"
  );
});

add_task(function test_on_tab_closed_behavior_detach_children_to_roots() {
  setupTreeService({ closeParentBehavior: 3 });

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(b, parent);

  const result = TreeTabsService.onTabClosed(parent);
  Assert.equal(result.length, 0, "No descendant close list is returned");
  Assert.equal(
    TreeTabsService.getParent(a),
    null,
    "First child detached to root"
  );
  Assert.equal(
    TreeTabsService.getParent(b),
    null,
    "Second child detached to root"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [a, b],
    "Children become roots"
  );
});

add_task(function test_close_multiple_unrelated_parents() {
  setupTreeService({ closeParentBehavior: 0 });

  const win = createMockWindow();
  const parentA = createMockTab(win);
  const childA1 = createMockTab(win);
  const childA2 = createMockTab(win);
  const parentB = createMockTab(win);
  const childB1 = createMockTab(win);
  const childB2 = createMockTab(win);

  TreeTabsService.attachTab(childA1, parentA);
  TreeTabsService.attachTab(childA2, parentA);
  TreeTabsService.attachTab(childB1, parentB);
  TreeTabsService.attachTab(childB2, parentB);

  TreeTabsService.onTabClosed(parentA);
  TreeTabsService.onTabClosed(parentB);

  Assert.equal(
    TreeTabsService.getParent(childA1),
    null,
    "Tree A first child promoted to root"
  );
  Assert.equal(
    TreeTabsService.getParent(childA2),
    childA1,
    "Tree A second child reparented"
  );
  Assert.equal(
    TreeTabsService.getParent(childB1),
    null,
    "Tree B first child promoted to root"
  );
  Assert.equal(
    TreeTabsService.getParent(childB2),
    childB1,
    "Tree B second child reparented"
  );
});

add_task(
  function test_on_tab_closed_promote_first_as_last_child_promotes_all() {
    setupTreeService({ closeParentBehavior: 0 });

    const win = createMockWindow();
    const grandparent = createMockTab(win);
    const parent = createMockTab(win);
    const childA = createMockTab(win);
    const childB = createMockTab(win);

    TreeTabsService.attachTab(parent, grandparent);
    TreeTabsService.attachTab(childA, parent);
    TreeTabsService.attachTab(childB, parent);

    TreeTabsService.onTabClosed(parent);

    Assert.equal(
      TreeTabsService.getParent(childA),
      grandparent,
      "First child promoted under grandparent"
    );
    Assert.equal(
      TreeTabsService.getParent(childB),
      grandparent,
      "Second child also promoted because the closed parent was a last child"
    );
    assertTabOrder(
      TreeTabsService.getChildren(grandparent),
      [childA, childB],
      "All children take the closed parent's position in order"
    );
  }
);

add_task(function test_on_tab_closed_collapsed_parent_closes_subtree() {
  setupTreeService({ closeParentBehavior: 0 });

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);
  const grandChild = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(b, parent);
  TreeTabsService.attachTab(grandChild, a);
  TreeTabsService.collapseSubtree(parent);

  const closedTabs = TreeTabsService.onTabClosed(parent);
  assertSameTabSet(
    closedTabs,
    [a, b, grandChild],
    "Closing a collapsed parent requests closing the whole subtree"
  );
});

add_task(function test_on_tab_opened_duplicate_becomes_next_sibling() {
  setupTreeService();

  const win = createMockWindow();
  const parent = createMockTab(win);
  const source = createMockTab(win);
  const other = createMockTab(win);
  const duplicate = createMockTab(win);

  TreeTabsService.attachTab(source, parent);
  TreeTabsService.attachTab(other, parent);

  TreeTabsService.onTabOpened(duplicate, {
    opener: source,
    duplicate: true,
  });
  Assert.equal(
    TreeTabsService.getParent(duplicate),
    parent,
    "Duplicate shares the source's parent"
  );
  assertTabOrder(
    TreeTabsService.getChildren(parent),
    [source, duplicate, other],
    "Duplicate is the source's next sibling"
  );
});

add_task(function test_on_tab_opened_duplicate_of_root_becomes_next_root() {
  setupTreeService();

  const win = createMockWindow();
  const source = createMockTab(win);
  const otherRoot = createMockTab(win);
  const duplicate = createMockTab(win);

  TreeTabsService.init(win);

  TreeTabsService.onTabOpened(duplicate, {
    opener: source,
    duplicate: true,
  });
  Assert.equal(
    TreeTabsService.getParent(duplicate),
    null,
    "Duplicate of a root stays a root"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [source, duplicate, otherRoot],
    "Duplicate is placed right after the source among roots"
  );
});

add_task(function test_same_site_orphan_becomes_child_of_current_tab() {
  setupTreeService();

  const win = createMockWindow();
  const current = createMockTab(win);
  current.linkedBrowser = {
    currentURI: { spec: "https://example.com/start" },
  };
  win.gBrowser.selectedTab = current;
  TreeTabsService.init(win);

  const sameSite = createMockTab(win);
  TreeTabsService.onTabOpened(sameSite, {
    url: "https://example.com/other",
    currentTab: current,
  });
  Assert.equal(
    TreeTabsService.getParent(sameSite),
    current,
    "Openerless same-site tab is attached under the current tab"
  );

  const otherSite = createMockTab(win);
  TreeTabsService.onTabOpened(otherSite, {
    url: "https://example.org/",
    currentTab: current,
  });
  Assert.equal(
    TreeTabsService.getParent(otherSite),
    null,
    "A different site stays a root"
  );

  const sameUrl = createMockTab(win);
  TreeTabsService.onTabOpened(sameUrl, {
    url: "https://example.com/start",
    currentTab: current,
  });
  Assert.equal(
    TreeTabsService.getParent(sameUrl),
    null,
    "The identical URL stays a root, e.g. reopened or duplicated tabs"
  );

  const external = createMockTab(win);
  TreeTabsService.onTabOpened(external, {
    url: "https://example.com/external",
    currentTab: current,
    fromExternal: true,
  });
  Assert.equal(
    TreeTabsService.getParent(external),
    null,
    "Tabs from external applications stay roots"
  );

  const bulk = createMockTab(win);
  TreeTabsService.onTabOpened(bulk, {
    url: "https://example.com/bulk",
    currentTab: current,
    bulk: true,
  });
  Assert.equal(
    TreeTabsService.getParent(bulk),
    null,
    "Bulk-opened tabs stay roots"
  );
});

add_task(function test_next_sibling_of_places_after_base() {
  setupTreeService();

  const win = createMockWindow();
  const parent = createMockTab(win);
  const base = createMockTab(win);
  const other = createMockTab(win);
  const opened = createMockTab(win);

  TreeTabsService.attachTab(base, parent);
  TreeTabsService.attachTab(other, parent);

  TreeTabsService.onTabOpened(opened, { nextSiblingOf: base });
  Assert.equal(
    TreeTabsService.getParent(opened),
    parent,
    "New tab shares the base tab's parent"
  );
  assertTabOrder(
    TreeTabsService.getChildren(parent),
    [base, opened, other],
    "New tab is the base tab's next sibling"
  );
});

add_task(function test_pinned_opener_anchor() {
  setupTreeService();

  const win = createMockWindow();
  const pinnedA = createMockTab(win, { pinned: true });
  const pinnedB = createMockTab(win, { pinned: true });
  const related = createMockTab(win);
  const relatedChild = createMockTab(win);
  createMockTab(win);

  TreeTabsService.init(win);
  TreeTabsService.attachTab(relatedChild, related);
  related._tPos = 2;
  relatedChild._tPos = 3;

  Assert.equal(
    TreeTabsService.getPinnedOpenerAnchor(pinnedA, related, win),
    relatedChild,
    "With a last related tab, the anchor is the end of its subtree"
  );
  Assert.equal(
    TreeTabsService.getPinnedOpenerAnchor(pinnedA, null, win),
    pinnedB,
    "Without one, the anchor is the last pinned tab"
  );
  Assert.equal(
    TreeTabsService.getPinnedOpenerAnchor(related, null, win),
    null,
    "An unpinned opener has no pinned-opener anchor"
  );
});

add_task(function test_programmatic_collapsed_close_uses_configured_behavior() {
  setupTreeService({ closeParentBehavior: 0 });

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(b, parent);
  TreeTabsService.collapseSubtree(parent);

  const closedTabs = TreeTabsService.onTabClosed(parent, {
    isUserTriggered: false,
  });
  Assert.equal(
    closedTabs.length,
    0,
    "A programmatic close of a collapsed parent closes only that tab"
  );
  Assert.equal(TreeTabsService.getParent(a), null, "First child is promoted");
  Assert.equal(
    TreeTabsService.getParent(b),
    a,
    "Second child moves under the promoted first child"
  );
});

add_task(function test_get_successor_prefers_first_child() {
  setupTreeService();

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(b, parent);

  Assert.equal(
    TreeTabsService.getSuccessor(parent),
    a,
    "Closing a parent hands off to its first child"
  );
  Assert.equal(
    TreeTabsService.getSuccessor(parent, new Set([a])),
    b,
    "An excluded first child falls through to the next one"
  );
});

add_task(function test_get_successor_middle_child_next_sibling() {
  setupTreeService();

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);
  const c = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(b, parent);
  TreeTabsService.attachTab(c, parent);

  Assert.equal(
    TreeTabsService.getSuccessor(b),
    c,
    "A middle child hands off to its next sibling, not its parent"
  );
});

add_task(function test_get_successor_last_child_previous_visible_tab() {
  setupTreeService();

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const deep = createMockTab(win);
  const b = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(deep, a);
  TreeTabsService.attachTab(b, parent);

  Assert.equal(
    TreeTabsService.getSuccessor(b),
    deep,
    "A last child hands off to the visually previous tab in the tree"
  );

  TreeTabsService.collapseSubtree(a);
  Assert.equal(
    TreeTabsService.getSuccessor(b),
    a,
    "Collapsed descendants of the previous sibling are skipped"
  );
});

add_task(function test_get_successor_collapsed_parent_skips_children() {
  setupTreeService();

  const win = createMockWindow();
  const parent = createMockTab(win);
  const child = createMockTab(win);
  const otherRoot = createMockTab(win);

  TreeTabsService.init(win);
  TreeTabsService.attachTab(child, parent);
  TreeTabsService.collapseSubtree(parent);

  Assert.equal(
    TreeTabsService.getSuccessor(parent),
    otherRoot,
    "A collapsed parent closes its subtree, so children are not successors"
  );
});

add_task(function test_get_successor_of_pinned_tab_is_pinned() {
  setupTreeService();

  const win = createMockWindow();
  const pinnedA = createMockTab(win, { pinned: true });
  const pinnedB = createMockTab(win, { pinned: true });
  const normal = createMockTab(win);

  TreeTabsService.init(win);

  Assert.equal(
    TreeTabsService.getSuccessor(pinnedA),
    pinnedB,
    "A pinned tab hands off to the next pinned tab"
  );
  Assert.equal(
    TreeTabsService.getSuccessor(pinnedB),
    pinnedA,
    "The last pinned tab hands off to the previous pinned tab"
  );
  Assert.notEqual(
    TreeTabsService.getSuccessor(pinnedB),
    normal,
    "A pinned tab never hands off to an unpinned tab"
  );
});

add_task(function test_get_subtree_end_anchor_skips_hidden_tabs() {
  setupTreeService();

  const win = createMockWindow();
  const parent = createMockTab(win);
  const a = createMockTab(win);
  const b = createMockTab(win);

  TreeTabsService.attachTab(a, parent);
  TreeTabsService.attachTab(b, parent);
  parent._tPos = 0;
  a._tPos = 1;
  b._tPos = 2;

  Assert.equal(
    TreeTabsService.getSubtreeEndAnchor(parent),
    b,
    "Anchor is the last descendant in strip order"
  );

  b.hidden = true;
  Assert.equal(
    TreeTabsService.getSubtreeEndAnchor(parent),
    a,
    "A trailing hidden descendant is skipped so insertions land before it"
  );
});

add_task(function test_on_tab_moved_with_and_without_detach_children() {
  setupTreeService();

  let win = createMockWindow();
  let a = createMockTab(win);
  let b = createMockTab(win);
  let c = createMockTab(win);
  let child = createMockTab(win);

  TreeTabsService.init(win);
  TreeTabsService.attachTab(child, a);

  TreeTabsService.onTabMoved(a, { newIndex: 2 });
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [b, c, a],
    "Moving tab without detach keeps subtree attached"
  );
  Assert.equal(TreeTabsService.getParent(child), a, "Child remains attached");

  setupTreeService();

  win = createMockWindow();
  a = createMockTab(win);
  b = createMockTab(win);
  c = createMockTab(win);
  const childA = createMockTab(win);
  const childB = createMockTab(win);

  TreeTabsService.init(win);
  TreeTabsService.attachTab(childA, a);
  TreeTabsService.attachTab(childB, a);

  TreeTabsService.onTabMoved(a, { detachChildren: true, newIndex: 2 });
  assertTabOrder(
    TreeTabsService.getChildren(a),
    [],
    "Moved tab has no children after detaching"
  );
  Assert.equal(
    TreeTabsService.getParent(childA),
    null,
    "First child is promoted in the moved tab's place"
  );
  Assert.equal(
    TreeTabsService.getParent(childB),
    childA,
    "Second child is reparented under the promoted first child"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [childA, b, a, c],
    "Promoted first child takes the moved tab's root slot"
  );
});

add_task(function test_bulk_close_tree_removes_root_and_descendants() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const child = createMockTab(win);
  const grandChild = createMockTab(win);
  const otherRoot = createMockTab(win);

  TreeTabsService.init(win);
  TreeTabsService.attachTab(child, root);
  TreeTabsService.attachTab(grandChild, child);

  const closed = TreeTabsService.closeTree(root);
  assertSameTabSet(
    closed,
    [root, child, grandChild],
    "closeTree returns root and descendants"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [otherRoot],
    "Tree is removed from root list"
  );
});

add_task(function test_bulk_close_descendants_keeps_root() {
  setupTreeService();

  const win = createMockWindow();
  const root = createMockTab(win);
  const child = createMockTab(win);
  const grandChild = createMockTab(win);
  const otherRoot = createMockTab(win);

  TreeTabsService.init(win);
  TreeTabsService.attachTab(child, root);
  TreeTabsService.attachTab(grandChild, child);

  const closed = TreeTabsService.closeDescendants(root);
  assertSameTabSet(
    closed,
    [child, grandChild],
    "closeDescendants returns descendants"
  );
  assertTabOrder(
    TreeTabsService.getChildren(root),
    [],
    "Root remains but has no children"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(win),
    [root, otherRoot],
    "Root stays in model"
  );
});

add_task(function test_bulk_collapse_all_and_expand_all() {
  setupTreeService();

  const win = createMockWindow();
  const rootA = createMockTab(win);
  const rootB = createMockTab(win);
  const childA = createMockTab(win);
  const childB = createMockTab(win);

  TreeTabsService.init(win);
  TreeTabsService.attachTab(childA, rootA);
  TreeTabsService.attachTab(childB, rootB);

  TreeTabsService.collapseAll(win);
  Assert.equal(
    TreeTabsService.isCollapsed(rootA),
    true,
    "First tree collapsed"
  );
  Assert.equal(
    TreeTabsService.isCollapsed(rootB),
    true,
    "Second tree collapsed"
  );

  TreeTabsService.expandAll(win);
  Assert.equal(
    TreeTabsService.isCollapsed(rootA),
    false,
    "First tree expanded"
  );
  Assert.equal(
    TreeTabsService.isCollapsed(rootB),
    false,
    "Second tree expanded"
  );
});

add_task(function test_edge_cases_when_tree_is_disabled() {
  setupTreeService({ enabled: false });

  const win = createMockWindow();
  const tab = createMockTab(win);
  const otherTab = createMockTab(win);

  Assert.equal(TreeTabsService.enabled, false, "Service is disabled by pref");

  Assert.equal(
    TreeTabsService.getParent(tab),
    null,
    "No parent while disabled"
  );
  Assert.equal(
    TreeTabsService.getChildren(tab).length,
    0,
    "No children while disabled"
  );
  Assert.equal(
    TreeTabsService.getDescendants(tab).length,
    0,
    "No descendants while disabled"
  );
  Assert.equal(
    TreeTabsService.getAncestors(tab).length,
    0,
    "No ancestors while disabled"
  );
  Assert.equal(
    TreeTabsService.getLevel(tab),
    0,
    "Level defaults to 0 while disabled"
  );
  Assert.equal(
    TreeTabsService.isCollapsed(tab),
    false,
    "No collapsed state while disabled"
  );
  Assert.equal(
    TreeTabsService.isSubtreeCollapsed(tab),
    false,
    "No subtree collapse while disabled"
  );
  Assert.equal(
    TreeTabsService.getRootTabs(win).length,
    0,
    "No roots returned while disabled"
  );
  Assert.equal(
    TreeTabsService.getVisibleTabs(win).length,
    0,
    "No visible tabs returned while disabled"
  );

  Assert.equal(
    TreeTabsService.attachTab(tab, otherTab),
    false,
    "attachTab is rejected while disabled"
  );
  TreeTabsService.detachTab(tab);
  TreeTabsService.detachAllChildren(tab);
  TreeTabsService.moveTabSubtree(tab, 0);
  TreeTabsService.collapseSubtree(tab);
  TreeTabsService.expandSubtree(tab);
  TreeTabsService.toggleCollapsed(tab);
  TreeTabsService.onTabOpened(tab);
  Assert.equal(
    TreeTabsService.onTabClosed(tab).length,
    0,
    "onTabClosed returns []"
  );
  TreeTabsService.onTabMoved(tab);
  Assert.equal(
    TreeTabsService.onTabDetached(tab),
    null,
    "onTabDetached returns null"
  );
  TreeTabsService.onTabRestored(tab);
  Assert.equal(
    TreeTabsService.closeTree(tab).length,
    0,
    "closeTree returns []"
  );
  Assert.equal(
    TreeTabsService.closeDescendants(tab).length,
    0,
    "closeDescendants returns []"
  );
  TreeTabsService.collapseAll(win);
  TreeTabsService.expandAll(win);

  Assert.equal(
    TreeTabsService._windowStates.size,
    0,
    "Disabled operations do not create model state"
  );
});

add_task(function test_edge_cases_null_undefined_self_and_empty_window() {
  setupTreeService();

  const win = createMockWindow();
  const tab = createMockTab(win);

  Assert.equal(
    TreeTabsService.getParent(null),
    null,
    "Null parent query returns null"
  );
  Assert.equal(
    TreeTabsService.getChildren(undefined).length,
    0,
    "Undefined children query returns []"
  );
  Assert.equal(
    TreeTabsService.getDescendants(null).length,
    0,
    "Null descendants query returns []"
  );
  Assert.equal(
    TreeTabsService.getAncestors(undefined).length,
    0,
    "Undefined ancestors query returns []"
  );
  Assert.equal(TreeTabsService.getLevel(null), 0, "Null level query returns 0");
  Assert.equal(
    TreeTabsService.isCollapsed(undefined),
    false,
    "Undefined collapsed is false"
  );
  Assert.equal(
    TreeTabsService.isSubtreeCollapsed(null),
    false,
    "Null subtree collapsed is false"
  );

  Assert.equal(
    TreeTabsService.attachTab(tab, tab),
    false,
    "Attaching tab to itself is rejected"
  );
  Assert.equal(
    TreeTabsService.attachTab(null, tab),
    false,
    "Null child is rejected"
  );
  Assert.equal(
    TreeTabsService.attachTab(tab, null),
    false,
    "Null parent is rejected"
  );

  TreeTabsService.detachTab(null);
  TreeTabsService.detachAllChildren(undefined);
  TreeTabsService.moveTabSubtree(null, 0);
  TreeTabsService.collapseSubtree(undefined);
  TreeTabsService.expandSubtree(null);
  TreeTabsService.toggleCollapsed(undefined);
  TreeTabsService.onTabOpened(null);
  Assert.equal(
    TreeTabsService.onTabClosed(undefined).length,
    0,
    "onTabClosed []"
  );
  TreeTabsService.onTabMoved(null);
  Assert.equal(
    TreeTabsService.onTabDetached(undefined),
    null,
    "onTabDetached null"
  );
  TreeTabsService.onTabRestored(null);
  Assert.equal(TreeTabsService.closeTree(undefined).length, 0, "closeTree []");
  Assert.equal(
    TreeTabsService.closeDescendants(null).length,
    0,
    "closeDescendants []"
  );

  const emptyWindow = createMockWindow();
  Assert.equal(
    TreeTabsService.getRootTabs(emptyWindow).length,
    0,
    "Empty window root list is empty"
  );
  Assert.equal(
    TreeTabsService.getVisibleTabs(emptyWindow).length,
    0,
    "Empty window visible list is empty"
  );
});

add_task(function test_edge_case_max_depth_enforcement() {
  setupTreeService({ maxDepth: 1 });

  const win = createMockWindow();
  const root = createMockTab(win);
  const child = createMockTab(win);
  const grandChild = createMockTab(win);
  TreeTabsService.init(win);

  Assert.ok(
    TreeTabsService.attachTab(child, root),
    "Attach to depth 1 is allowed"
  );
  Assert.ok(
    !TreeTabsService.attachTab(grandChild, child),
    "Attach beyond max depth is rejected"
  );

  Assert.equal(
    TreeTabsService.getParent(grandChild),
    null,
    "Rejected tab becomes root"
  );
  Assert.equal(
    TreeTabsService.getLevel(child),
    1,
    "Depth-1 child remains attached"
  );

  const roots = TreeTabsService.getRootTabs(win);
  assertSameTabSet(roots, [root, grandChild], "Grandchild remains a root tab");
});

add_task(function test_restore_snapshot_ignores_external_hints_without_nodes() {
  setupTreeService();

  const sourceWindow = createMockWindow();
  const sourceHint = createMockTab(sourceWindow);
  const sourceRoot = createMockTab(sourceWindow);
  TreeTabsService.init(sourceWindow);
  const snapshot = TreeTabsService.snapshotSubtree(sourceRoot);

  const targetWindow = createMockWindow();
  const targetHint = createMockTab(targetWindow);
  TreeTabsService.init(targetWindow);

  Assert.equal(
    snapshot.insertAfter,
    sourceHint,
    "The snapshot has an external hint"
  );
  Assert.equal(
    TreeTabsService.restoreSubtreeSnapshot(
      snapshot,
      new Map([[sourceHint, targetHint]])
    ),
    null,
    "A map containing only external hints has no subtree to restore"
  );
  assertTabOrder(
    TreeTabsService.getRootTabs(targetWindow),
    [targetHint],
    "The target tree is unchanged"
  );
});
