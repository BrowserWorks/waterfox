/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TreeTabsBookmarks } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsBookmarks.sys.mjs"
);
const { TreeTabsGroups } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsGroups.sys.mjs"
);
const { TreeTabsService } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsService.sys.mjs"
);

function setupBookmarksTest() {
  TreeTabsService._windowStates.clear();
  resetTreeTestPrefs();
  Services.prefs.setBoolPref(TREE_PREF_ENABLED, true);
}

function createBookmarkTab(window, label, url) {
  const tab = createMockTab(window);
  tab.label = label;
  tab.linkedBrowser = {
    currentURI: { spec: url },
  };
  return tab;
}

function bookmarkItems(...titles) {
  return titles.map(title => ({ title }));
}

registerCleanupFunction(() => {
  TreeTabsService._windowStates.clear();
  resetTreeTestPrefs();
});

add_task(function test_parse_structure_nested() {
  Assert.deepEqual(
    TreeTabsBookmarks.parseStructure(
      bookmarkItems("Root", "> Child", ">> Grandchild", "> Sibling")
    ),
    [
      { parent: null, title: "Root" },
      { parent: 0, title: "Child" },
      { parent: 1, title: "Grandchild" },
      { parent: 0, title: "Sibling" },
    ],
    "Nested bookmark markers produce absolute parent indices"
  );
});

add_task(function test_parse_structure_multiple_roots() {
  Assert.deepEqual(
    TreeTabsBookmarks.parseStructure(
      bookmarkItems(
        "Root A",
        "> Child A",
        ">> Grandchild A",
        "Root B",
        ">>> Child B",
        ">> Grandchild B"
      )
    ),
    [
      { parent: null, title: "Root A" },
      { parent: 0, title: "Child A" },
      { parent: 1, title: "Grandchild A" },
      { parent: null, title: "Root B" },
      { parent: 3, title: "Child B" },
      { parent: 4, title: "Grandchild B" },
    ],
    "A new root resets depth and retains absolute indices"
  );
});

add_task(function test_parse_structure_clamps_malformed_jumps() {
  Assert.deepEqual(
    TreeTabsBookmarks.parseStructure(
      bookmarkItems("Root", ">>>> Jump", ">>>> Second jump", "> Sibling")
    ),
    [
      { parent: null, title: "Root" },
      { parent: 0, title: "Jump" },
      { parent: 1, title: "Second jump" },
      { parent: 0, title: "Sibling" },
    ],
    "Depth can increase by at most one level"
  );
});

add_task(function test_parse_structure_discards_previous_branch() {
  Assert.deepEqual(
    TreeTabsBookmarks.parseStructure(
      bookmarkItems(
        "Root",
        "> Child",
        ">> Grandchild",
        ">>> Great-grandchild",
        "> Sibling",
        ">>>> Jump",
        ">>>> Second jump",
        ">> Cousin"
      )
    ),
    [
      { parent: null, title: "Root" },
      { parent: 0, title: "Child" },
      { parent: 1, title: "Grandchild" },
      { parent: 2, title: "Great-grandchild" },
      { parent: 0, title: "Sibling" },
      { parent: 4, title: "Jump" },
      { parent: 5, title: "Second jump" },
      { parent: 4, title: "Cousin" },
    ],
    "Clamped jumps after returning to a sibling use only the current branch"
  );
});

add_task(function test_parse_structure_empty() {
  Assert.deepEqual(
    TreeTabsBookmarks.parseStructure([]),
    [],
    "An empty bookmark list has no structure"
  );
});

add_task(function test_parse_structure_marker_like_titles() {
  Assert.deepEqual(
    TreeTabsBookmarks.parseStructure(
      bookmarkItems(
        "> Marker-like root",
        "> > Marker-like child",
        ">> >> Marker-like grandchild"
      )
    ),
    [
      { parent: null, title: "> Marker-like root" },
      { parent: 0, title: "> Marker-like child" },
      { parent: 1, title: ">> Marker-like grandchild" },
    ],
    "Only structural prefixes are removed"
  );
});

add_task(function test_encode_tabs_normalizes_levels_and_escapes_titles() {
  setupBookmarksTest();

  const win = createMockWindow();
  const outerRoot = createBookmarkTab(win, "Outer", "https://outer.example/");
  const container = createBookmarkTab(
    win,
    "Container",
    "https://container.example/"
  );
  const root = createBookmarkTab(win, "> Root marker", "https://root.example/");
  const child = createBookmarkTab(
    win,
    "> Literal child marker",
    "https://child.example/"
  );
  const grandchild = createBookmarkTab(
    win,
    ">> Literal grandchild marker",
    "https://grandchild.example/"
  );
  const otherRoot = createBookmarkTab(
    win,
    ">>> Other root marker",
    "https://other.example/"
  );

  TreeTabsService.init(win);
  TreeTabsService.attachTab(container, outerRoot);
  TreeTabsService.attachTab(root, container);
  TreeTabsService.attachTab(child, root);
  TreeTabsService.attachTab(grandchild, child);
  TreeTabsService.attachTab(otherRoot, container);

  const tabs = [root, child, grandchild, otherRoot];
  const encoded = TreeTabsBookmarks.encodeTabs(tabs);

  Assert.deepEqual(
    encoded.map(({ title, url }) => ({ title, url })),
    [
      { title: "Root marker", url: "https://root.example/" },
      {
        title: "> > Literal child marker",
        url: "https://child.example/",
      },
      {
        title: ">> >> Literal grandchild marker",
        url: "https://grandchild.example/",
      },
      { title: "Other root marker", url: "https://other.example/" },
    ],
    "Titles use normalized levels and preserve child marker text"
  );
  assertTabOrder(
    encoded.map(item => item.tab),
    tabs,
    "Encoded entries retain supplied preorder"
  );
});

add_task(function test_apply_structure_validates_lengths() {
  Assert.throws(
    () =>
      TreeTabsBookmarks.applyStructure(
        createMockWindow(),
        [],
        [{ parent: null, title: "Root" }]
      ),
    /equal lengths/,
    "Tabs and structure items must correspond one-to-one"
  );
});

add_task(function test_apply_structure_exact_shape() {
  setupBookmarksTest();

  const win = createMockWindow();
  const tabs = Array.from({ length: 7 }, (_, index) =>
    createBookmarkTab(win, `Tab ${index}`, `https://example.com/${index}`)
  );
  const [rootA, childA, grandchildA, siblingA, rootB, childB, siblingB] = tabs;

  TreeTabsService.init(win);
  TreeTabsService.attachTab(rootA, rootB);
  TreeTabsService.attachTab(siblingA, rootA);
  TreeTabsService.attachTab(grandchildA, rootA);
  TreeTabsService.attachTab(childA, rootB);
  TreeTabsService.attachTab(childB, rootA);
  TreeTabsService.attachTab(siblingB, rootA);

  const items = TreeTabsBookmarks.parseStructure(
    bookmarkItems(
      "Root A",
      "> Child A",
      ">> Grandchild A",
      "> Sibling A",
      "Root B",
      "> Child B",
      "> Sibling B"
    )
  );
  const groupTab = { id: "group" };
  const attachCalls = [];
  const detachedTabs = [];
  let groupCall;
  const originalAttachTab = TreeTabsService.attachTab;
  const originalDetachTab = TreeTabsService.detachTab;
  const originalGroupTabs = TreeTabsGroups.groupTabs;

  TreeTabsService.attachTab = function (childTab, parentTab, options) {
    attachCalls.push({ childTab, parentTab, options: { ...options } });
    return originalAttachTab.call(this, childTab, parentTab, options);
  };
  TreeTabsService.detachTab = function (tab) {
    detachedTabs.push(tab);
    return originalDetachTab.call(this, tab);
  };
  TreeTabsGroups.groupTabs = (window, rootTabs, options) => {
    groupCall = { window, rootTabs: rootTabs.slice(), options };
    return groupTab;
  };

  let result;
  try {
    result = TreeTabsBookmarks.applyStructure(win, tabs, items, {
      groupTitle: "Imported tabs",
    });
  } finally {
    TreeTabsService.attachTab = originalAttachTab;
    TreeTabsService.detachTab = originalDetachTab;
    TreeTabsGroups.groupTabs = originalGroupTabs;
  }

  Assert.equal(result, groupTab, "The new group tab is returned");
  assertTabOrder(detachedTabs, [rootA, rootB], "Only roots are detached");
  Assert.deepEqual(
    attachCalls.map(({ childTab, parentTab, options }) => ({
      child: childTab.id,
      parent: parentTab.id,
      suppressAutoExpand: options.suppressAutoExpand,
      index: "index" in options ? options.index : null,
      insertAfter: options.insertAfter?.id ?? null,
    })),
    [
      {
        child: childA.id,
        parent: rootA.id,
        suppressAutoExpand: true,
        index: 0,
        insertAfter: null,
      },
      {
        child: grandchildA.id,
        parent: childA.id,
        suppressAutoExpand: true,
        index: 0,
        insertAfter: null,
      },
      {
        child: siblingA.id,
        parent: rootA.id,
        suppressAutoExpand: true,
        index: null,
        insertAfter: childA.id,
      },
      {
        child: childB.id,
        parent: rootB.id,
        suppressAutoExpand: true,
        index: 0,
        insertAfter: null,
      },
      {
        child: siblingB.id,
        parent: rootB.id,
        suppressAutoExpand: true,
        index: null,
        insertAfter: childB.id,
      },
    ],
    "Children are attached parent-first in sibling order"
  );

  Assert.equal(TreeTabsService.getParent(rootA), null, "Root A is detached");
  Assert.equal(TreeTabsService.getParent(childA), rootA, "Child A is attached");
  Assert.equal(
    TreeTabsService.getParent(grandchildA),
    childA,
    "Grandchild A is attached"
  );
  Assert.equal(
    TreeTabsService.getParent(siblingA),
    rootA,
    "Sibling A is attached"
  );
  Assert.equal(TreeTabsService.getParent(rootB), null, "Root B is detached");
  Assert.equal(TreeTabsService.getParent(childB), rootB, "Child B is attached");
  Assert.equal(
    TreeTabsService.getParent(siblingB),
    rootB,
    "Sibling B is attached"
  );
  assertTabOrder(
    TreeTabsService.getChildren(rootA),
    [childA, siblingA],
    "Root A children have exact order"
  );
  assertTabOrder(
    TreeTabsService.getChildren(childA),
    [grandchildA],
    "Child A has the exact descendants"
  );
  assertTabOrder(
    TreeTabsService.getChildren(rootB),
    [childB, siblingB],
    "Root B children have exact order"
  );

  Assert.equal(groupCall.window, win, "Grouping uses the supplied window");
  assertTabOrder(
    groupCall.rootTabs,
    [rootA, rootB],
    "Grouping receives roots in bookmark order"
  );
  Assert.deepEqual(
    groupCall.options,
    {
      temporary: true,
      automaticTitle: false,
      title: "Imported tabs",
    },
    "Grouping receives temporary explicit-title options"
  );
});
