/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TreeTabsGroups } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsGroups.sys.mjs"
);

const PREF_TREE_BOOKMARKS_RESTORE =
  "browser.tabs.verticalTabs.tree.bookmarks.restoreTree";
const PREF_TREE_BOOKMARKS_AUTO_GROUP =
  "browser.tabs.verticalTabs.tree.bookmarks.autoGroup";

function getTabsOpenedSince(originalTabs) {
  return Array.from(gBrowser.tabs).filter(tab => !originalTabs.has(tab));
}

function getBookmarkGroupTabs(originalTabs) {
  return getTabsOpenedSince(originalTabs).filter(tab =>
    TreeTabsGroups.isGroupTab(tab)
  );
}

async function openTreeBookmarkFolder(originalTabs, titles, folderTitle) {
  const id = Services.uuid.generateUUID().toString().slice(1, -1);
  const items = titles.map((title, index) => ({
    uri: `https://example.com/?waterfox-tree-bookmark=${encodeURIComponent(
      `${id}-${index}-${title}`
    )}`,
    isBookmark: true,
  }));

  PlacesUIUtils.openTabset(
    items,
    new MouseEvent("click", { button: 0, view: window }),
    window,
    {
      treeBookmarkFolder: {
        title: folderTitle,
        items: titles.map(title => ({ title })),
      },
    }
  );

  await waitForTreeCondition(() => {
    const tabsByURL = new Map(
      getTabsOpenedSince(originalTabs).map(tab => [
        TreeTabsGroups.getTabURL(tab),
        tab,
      ])
    );
    return items.every(item => tabsByURL.has(item.uri));
  }, "Waiting for the bookmark folder tabs to open");

  const tabsByURL = new Map(
    getTabsOpenedSince(originalTabs).map(tab => [
      TreeTabsGroups.getTabURL(tab),
      tab,
    ])
  );
  return {
    itemTabs: items.map(item => tabsByURL.get(item.uri)),
    items,
  };
}

async function cleanupBookmarkTestTabs(originalTabs) {
  if (Services.prefs.getBoolPref(PREF_TREE_ENABLED, false)) {
    await disableTreeTabs({ strict: false });
  }

  const tabsToRemove = getTabsOpenedSince(originalTabs);
  for (const tab of tabsToRemove.reverse()) {
    if (tab.closing || !gBrowser.tabs.includes(tab)) {
      continue;
    }
    if (tab.pinned) {
      gBrowser.unpinTab(tab);
    }
    await BrowserTestUtils.removeTab(tab);
  }

  await waitForTreeCondition(
    () => Array.from(gBrowser.tabs).every(tab => originalTabs.has(tab)),
    "Waiting for bookmark test tabs to close"
  );
  clearTreeTestPrefs();
}

async function checkNewWindowTreeBookmarkFolder(
  duplicateURLs,
  sourceWindow = window
) {
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_TREE_BOOKMARKS_RESTORE, true],
      [PREF_TREE_BOOKMARKS_AUTO_GROUP, true],
    ],
  });

  const id = Services.uuid.generateUUID().toString().slice(1, -1);
  const titles = ["Root", "> First child", ">> Grandchild", "> Second child"];
  const items = titles.map((title, index) => ({
    uri: `https://example.com/?tree-bookmark-window=${id}-${duplicateURLs ? 0 : index}`,
    isBookmark: true,
  }));
  let newWindow;
  let initialTab;
  let startupTabs;
  const beforeShow = subject => {
    if (!newWindow) {
      newWindow = subject;
      initialTab = newWindow.gBrowser.tabs[0];
      is(
        newWindow.gBrowser.tabs.length,
        1,
        "Startup begins with one initial tab"
      );
    }
  };
  const onStartup = subject => {
    if (subject == newWindow) {
      startupTabs = Array.from(newWindow.gBrowser.tabs);
    }
  };
  Services.obs.addObserver(beforeShow, "browser-window-before-show");
  Services.obs.addObserver(onStartup, "browser-delayed-startup-finished");

  try {
    const windowOpened = BrowserTestUtils.waitForNewWindow();
    is(
      PlacesUIUtils.openTabset(
        items,
        new sourceWindow.MouseEvent("click", {
          button: 0,
          shiftKey: true,
          view: sourceWindow,
        }),
        sourceWindow,
        {
          treeBookmarkFolder: {
            title: "New window tree",
            items: titles.map(title => ({ title })),
          },
        }
      ),
      undefined,
      "openTabset retains its void API when opening a window"
    );
    is(await windowOpened, newWindow, "The bookmark window finishes startup");

    const tabbrowser = newWindow.gBrowser;
    const service = tabbrowser.TreeTabsService;
    const tabs = Array.from(tabbrowser.tabs);
    const [root, child, grandchild, sibling] = tabs;
    is(
      startupTabs.length,
      items.length,
      "Bookmark tabs are created before delayed startup finishes"
    );
    Assert.deepEqual(
      tabs,
      startupTabs,
      "Restoration uses the startup tab identities"
    );
    is(
      tabs.length,
      titles.length,
      "No extra initial tab or wrapper is created"
    );
    is(root, initialTab, "The first bookmark reuses the existing initial tab");
    is(tabbrowser.selectedTab, root, "The first bookmark stays selected");
    is(
      PrivateBrowsingUtils.isWindowPrivate(newWindow),
      PrivateBrowsingUtils.isWindowPrivate(sourceWindow),
      "The new window preserves the source window's private browsing mode"
    );
    ok(
      !Object.hasOwn(newWindow, "_onInitialTabsLoaded"),
      "The one-shot startup handoff has been consumed"
    );

    await waitForTreeCondition(
      () =>
        service.getParent(root) == null &&
        service.getParent(child) == root &&
        service.getParent(grandchild) == child &&
        service.getParent(sibling) == root,
      "Waiting for the new-window bookmark tree to restore by tab identity"
    );
    Assert.deepEqual(
      service.getChildren(root),
      [child, sibling],
      "Root keeps ordered children"
    );
    Assert.deepEqual(
      service.getChildren(child),
      [grandchild],
      "Grandchild belongs to the first child"
    );
    Assert.deepEqual(
      Array.from(tabbrowser.tabs),
      tabs,
      "Restoring the tree preserves the bookmark folder's physical tab order"
    );
    await waitForTreeCondition(
      () =>
        tabs.every(
          (tab, index) => TreeTabsGroups.getTabURL(tab) == items[index].uri
        ),
      "Waiting for distinct and repeated URLs in their ordered bookmark tabs"
    );
    await waitForTreeCondition(
      () => tabs.slice(1).every(tab => tab.hasAttribute("discarded")),
      "Waiting for background bookmark tabs to be discarded"
    );
    ok(
      !root.hasAttribute("discarded"),
      "The reused selected tab remains loaded"
    );
  } finally {
    Services.obs.removeObserver(beforeShow, "browser-window-before-show");
    Services.obs.removeObserver(onStartup, "browser-delayed-startup-finished");
    if (newWindow && !newWindow.closed) {
      await BrowserTestUtils.closeWindow(newWindow);
    }
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_new_window_bookmark_tree_with_distinct_urls() {
  await checkNewWindowTreeBookmarkFolder(false);
});

add_task(async function test_new_window_bookmark_tree_with_duplicate_urls() {
  await checkNewWindowTreeBookmarkFolder(true);
});

add_task(async function test_private_new_window_bookmark_tree() {
  const privateWindow = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  try {
    await checkNewWindowTreeBookmarkFolder(true, privateWindow);
  } finally {
    await BrowserTestUtils.closeWindow(privateWindow);
  }
});

add_task(async function test_open_tabset_restores_encoded_tree_without_group() {
  const originalTabs = new Set(gBrowser.tabs);
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_TREE_BOOKMARKS_RESTORE, true],
      [PREF_TREE_BOOKMARKS_AUTO_GROUP, true],
    ],
  });

  try {
    const { itemTabs, items } = await openTreeBookmarkFolder(
      originalTabs,
      ["Root", "> Child", ">> Grandchild"],
      "Nested tree"
    );
    const [rootTab, childTab, grandchildTab] = itemTabs;

    await waitForTreeCondition(
      () =>
        getTreeParent(rootTab) == null &&
        getTreeParent(childTab) == rootTab &&
        getTreeParent(grandchildTab) == childTab &&
        getTreeLevel(rootTab) == 0 &&
        getTreeLevel(childTab) == 1 &&
        getTreeLevel(grandchildTab) == 2,
      "Waiting for the encoded bookmark tree to restore"
    );

    is(
      getTabsOpenedSince(originalTabs).length,
      3,
      "Opening one encoded root creates only its three tabs"
    );
    is(
      getBookmarkGroupTabs(originalTabs).length,
      0,
      "A single encoded root is restored without a wrapper"
    );
    is(getTreeParent(rootTab), null, "Root is restored as a root");
    is(getTreeParent(childTab), rootTab, "Child is restored under Root");
    is(
      getTreeParent(grandchildTab),
      childTab,
      "Grandchild is restored under Child"
    );
    is(
      gBrowser.TreeTabsService.getChildren(rootTab)[0],
      childTab,
      "Root has Child as its only child"
    );
    is(
      gBrowser.TreeTabsService.getChildren(childTab)[0],
      grandchildTab,
      "Child has Grandchild as its only child"
    );
    is(
      gBrowser.TreeTabsService.getChildren(grandchildTab).length,
      0,
      "Grandchild has no children"
    );
    is(childTab._tPos, rootTab._tPos + 1, "Child follows Root");
    is(grandchildTab._tPos, childTab._tPos + 1, "Grandchild follows Child");
    for (const [index, tab] of itemTabs.entries()) {
      is(
        TreeTabsGroups.getTabURL(tab),
        items[index].uri,
        `Bookmark tab ${index + 1} keeps its unique URL`
      );
    }
    await waitForTreeCondition(
      () =>
        childTab.hasAttribute("discarded") &&
        grandchildTab.hasAttribute("discarded"),
      "Waiting for background bookmark tree members to be discarded"
    );
    ok(
      !rootTab.hasAttribute("discarded"),
      "The active bookmark root remains loaded"
    );
    ok(
      childTab.hasAttribute("discarded"),
      "Background bookmark children open discarded"
    );
    ok(
      grandchildTab.hasAttribute("discarded"),
      "Background bookmark descendants open discarded"
    );
  } finally {
    try {
      await cleanupBookmarkTestTabs(originalTabs);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

add_task(async function test_open_tabset_groups_flat_folder_in_order() {
  const originalTabs = new Set(gBrowser.tabs);
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_TREE_BOOKMARKS_RESTORE, true],
      [PREF_TREE_BOOKMARKS_AUTO_GROUP, true],
    ],
  });

  try {
    const folderTitle = "Flat bookmark roots";
    const { itemTabs } = await openTreeBookmarkFolder(
      originalTabs,
      ["First root", "Second root"],
      folderTitle
    );
    const [firstRoot, secondRoot] = itemTabs;

    await waitForTreeCondition(() => {
      const groupTabs = getBookmarkGroupTabs(originalTabs);
      return (
        groupTabs.length == 1 &&
        getTreeParent(firstRoot) == groupTabs[0] &&
        getTreeParent(secondRoot) == groupTabs[0]
      );
    }, "Waiting for flat bookmark roots to be grouped");

    const [groupTab] = getBookmarkGroupTabs(originalTabs);
    const children = gBrowser.TreeTabsService.getChildren(groupTab);
    const groupURL = new URL(TreeTabsGroups.getTabURL(groupTab));

    is(
      getTabsOpenedSince(originalTabs).length,
      3,
      "Flat folder creates two tabs and one group"
    );
    is(
      TreeTabsGroups.getTemporaryState(groupTab),
      1,
      "Flat-folder group is passively temporary"
    );
    is(
      groupURL.searchParams.get("title"),
      folderTitle,
      "Flat-folder group uses the folder title"
    );
    is(getTreeParent(groupTab), null, "Flat-folder group is a root");
    is(children.length, 2, "Flat-folder group has both roots");
    is(children[0], firstRoot, "First bookmark remains first");
    is(children[1], secondRoot, "Second bookmark remains second");
    is(firstRoot._tPos, groupTab._tPos + 1, "First root follows the group");
    is(
      secondRoot._tPos,
      firstRoot._tPos + 1,
      "Second root follows the first root"
    );
  } finally {
    try {
      await cleanupBookmarkTestTabs(originalTabs);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

add_task(
  async function test_bookmark_tree_adopts_surrounding_insertion_parent() {
    const originalTabs = new Set(gBrowser.tabs);
    await enableTreeTabs();
    await SpecialPowers.pushPrefEnv({
      set: [
        [PREF_TREE_BOOKMARKS_RESTORE, true],
        [PREF_TREE_BOOKMARKS_AUTO_GROUP, false],
        ["browser.tabs.insertAfterCurrent", true],
      ],
    });

    const existingParent = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?waterfox-tree-bookmark-insertion-parent"
    );
    const existingChild = await openTabWithTree(
      existingParent,
      "about:blank?waterfox-tree-bookmark-insertion-existing-child"
    );
    originalTabs.add(existingParent);
    originalTabs.add(existingChild);

    try {
      const { itemTabs } = await openTreeBookmarkFolder(
        originalTabs,
        ["Imported root", "> Imported child"],
        "Inserted bookmark tree"
      );
      const [importedRoot, importedChild] = itemTabs;

      await waitForTreeCondition(
        () =>
          getTreeParent(importedRoot) == existingParent &&
          getTreeParent(importedChild) == importedRoot,
        "Waiting for the imported tree to adopt the surrounding parent"
      );
      Assert.deepEqual(
        gBrowser.TreeTabsService.getChildren(existingParent),
        [importedRoot, existingChild],
        "Imported tree is inserted before the parent's existing first child"
      );
      is(
        getTreeParent(importedChild),
        importedRoot,
        "Imported descendants retain their encoded structure"
      );
    } finally {
      try {
        await cleanupBookmarkTestTabs(originalTabs);
        await BrowserTestUtils.removeTab(existingChild);
        await BrowserTestUtils.removeTab(existingParent);
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }
  }
);

add_task(async function test_open_tabset_restores_without_auto_group() {
  const originalTabs = new Set(gBrowser.tabs);
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_TREE_BOOKMARKS_RESTORE, true],
      [PREF_TREE_BOOKMARKS_AUTO_GROUP, false],
    ],
  });

  try {
    const { itemTabs } = await openTreeBookmarkFolder(
      originalTabs,
      ["First root", "> Child", "Second root"],
      "Ungrouped bookmark roots"
    );
    const [firstRoot, childTab, secondRoot] = itemTabs;

    await waitForTreeCondition(
      () =>
        getTreeParent(firstRoot) == null &&
        getTreeParent(childTab) == firstRoot &&
        getTreeParent(secondRoot) == null &&
        getTreeLevel(childTab) == 1,
      "Waiting for bookmark structure without automatic grouping"
    );

    is(
      getTabsOpenedSince(originalTabs).length,
      3,
      "Disabling automatic grouping creates no extra tab"
    );
    is(
      getBookmarkGroupTabs(originalTabs).length,
      0,
      "Multiple roots remain unwrapped when automatic grouping is disabled"
    );
    is(getTreeParent(firstRoot), null, "First bookmark remains a root");
    is(
      getTreeParent(childTab),
      firstRoot,
      "Tree restoration still attaches the encoded child"
    );
    is(getTreeParent(secondRoot), null, "Second bookmark remains a root");
    is(
      gBrowser.TreeTabsService.getChildren(firstRoot)[0],
      childTab,
      "First root keeps its restored child"
    );
  } finally {
    try {
      await cleanupBookmarkTestTabs(originalTabs);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});
