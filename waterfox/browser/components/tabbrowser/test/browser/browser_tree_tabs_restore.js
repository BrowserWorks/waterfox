/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_session_store_save_and_manual_restore() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?restore-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-restore-child"
  );

  // Force a save; do not rely on debounce timing.
  const { TreeTabsStore } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsStore.sys.mjs"
  );
  TreeTabsStore.clearRestoreGuard(window);
  TreeTabsStore.saveWindowStructure(window);
  const rawStructure = SessionStore.getCustomWindowValue(
    window,
    "treeTabs:tree-structure"
  );
  ok(rawStructure, "treeTabs:tree-structure is persisted after explicit save");

  const structure = JSON.parse(rawStructure);
  const tabOrder = Array.from(gBrowser.tabs);
  const parentIndex = tabOrder.indexOf(parentTab);
  const childIndex = tabOrder.indexOf(childTab);
  is(
    structure[childIndex].parent,
    parentIndex,
    "Persisted structure has correct parent index"
  );

  // Now test restore: detach the child, then restore from saved data
  gBrowser.TreeTabsService.detachTab(childTab);
  await waitForTreeUpdate();
  await waitForTreeCondition(
    () => getTreeParent(childTab) == null,
    "Waiting for child detach"
  );

  // Re-write the saved structure because detach may have overwritten it.
  SessionStore.setCustomWindowValue(
    window,
    "treeTabs:tree-structure",
    rawStructure
  );
  TreeTabsStore._manualRestoreCompleted.delete(window);
  TreeTabsStore.clearRestoreGuard(window);

  const restored = TreeTabsStore.tryManualRestore(window);
  ok(restored, "tryManualRestore succeeds");
  is(getTreeParent(childTab), parentTab, "Restore re-attaches child to parent");

  BrowserTestUtils.removeTab(childTab);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(
  async function test_window_restore_keeps_lazy_trees_in_native_groups() {
    await enableTreeTabs();
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.tabs.groups.enabled", true],
        ["browser.sessionstore.restore_on_demand", true],
        ["browser.sessionstore.restore_tabs_lazily", true],
        [PREF_TREE_AUTO_COLLAPSE_ON_SELECT, false],
      ],
    });
    const { TreeTabsStore } = ChromeUtils.importESModule(
      "resource:///modules/TreeTabsStore.sys.mjs"
    );
    const restoredWindow = await BrowserTestUtils.openNewBrowserWindow();
    try {
      const browser = restoredWindow.gBrowser;
      for (const generation of [1, 2]) {
        const structure = Array.from({ length: 4 }, (_, index) => ({
          id: `restore-${generation}-${index}`,
          parent: index % 2 ? index - 1 : null,
          collapsed: index == 2,
        }));
        const state = {
          windows: [
            {
              tabs: structure.map((entry, index) => ({
                entries: [
                  { url: `about:blank#tree-restore-${generation}-${index}` },
                ],
                index: 1,
                ...(index >= 2 ? { groupId: "restored-native-group" } : {}),
                extData: {
                  "treeTabs:data-persistent-id": JSON.stringify(entry.id),
                },
              })),
              selected: 1,
              groups: [
                {
                  id: "restored-native-group",
                  name: "Restored trees",
                  color: "blue",
                  collapsed: false,
                },
              ],
              extData: { "treeTabs:tree-structure": JSON.stringify(structure) },
            },
          ],
        };
        const restored = BrowserTestUtils.waitForEvent(
          restoredWindow,
          "SSWindowRestored"
        );
        SessionStore.setWindowState(
          restoredWindow,
          JSON.stringify(state),
          true
        );
        await restored;
        await BrowserTestUtils.waitForCondition(
          () =>
            browser.tabs.length == 4 &&
            browser.TreeTabsService.getParent(browser.tabs[1]) ==
              browser.tabs[0] &&
            browser.TreeTabsService.getParent(browser.tabs[3]) ==
              browser.tabs[2],
          "Both the ungrouped and native-group trees restore without activating lazy tabs"
        );
        const [outside, outsideChild, grouped, groupedChild] = browser.tabs;
        is(
          grouped.group,
          groupedChild.group,
          "The grouped tree stays in its native group"
        );
        ok(grouped.group, "The native group exists");
        ok(
          grouped.hasAttribute("pending"),
          "The grouped parent is still pending"
        );
        ok(
          groupedChild.hasAttribute("pending"),
          "The grouped child is still pending"
        );
        ok(
          browser.TreeTabsService.isCollapsed(grouped),
          "Saved collapse is restored"
        );
        await BrowserTestUtils.waitForCondition(
          () =>
            outsideChild.dataset.treeLevel == "1" &&
            grouped.dataset.treeHasChildren == "true" &&
            groupedChild.dataset.treeHidden == "true",
          "Lazy tabs have complete tree rendering state and an expandable parent"
        );
        ok(
          !outside.hidden && !outsideChild.hidden,
          "Expanded outside tabs remain visible"
        );
        is(
          TreeTabsStore.getTabGuid(outside),
          structure[0].id,
          "Each new restore replaces cached identities from the previous session"
        );
        ok(
          !TreeTabsStore.isRestorePending(restoredWindow),
          "The complete restore releases the guard"
        );
        await BrowserTestUtils.switchTab(browser, groupedChild);
        is(
          browser.TreeTabsService.getParent(groupedChild),
          grouped,
          "Activating the lazy child does not flatten its tree"
        );
      }
    } finally {
      await BrowserTestUtils.closeWindow(restoredWindow);
      await SpecialPowers.popPrefEnv();
    }
  }
);

add_task(
  async function test_lazy_parent_keeps_disclosure_choice_after_loading() {
    await enableTreeTabs();
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.sessionstore.restore_on_demand", true],
        ["browser.sessionstore.restore_tabs_lazily", true],
        ["sidebar.visibility", "always-show"],
        [PREF_TREE_AUTO_COLLAPSE_ON_SELECT, false],
      ],
    });
    const restoredWindow = await BrowserTestUtils.openNewBrowserWindow();
    try {
      const browser = restoredWindow.gBrowser;
      const service = browser.TreeTabsService;
      for (const [initiallyCollapsed, selectedIndex] of [
        [false, 1],
        [true, 1],
        [false, 3],
      ]) {
        const structure = [null, null, 1].map((parent, index) => ({
          id: `disclosure-${initiallyCollapsed}-${index}`,
          parent,
          collapsed: index == 1 && initiallyCollapsed,
        }));
        const windowRestored = BrowserTestUtils.waitForEvent(
          restoredWindow,
          "SSWindowRestored"
        );
        SessionStore.setWindowState(
          restoredWindow,
          JSON.stringify({
            windows: [
              {
                tabs: structure.map(entry => ({
                  entries: [{ url: `about:blank#${entry.id}` }],
                  index: 1,
                  extData: {
                    "treeTabs:data-persistent-id": JSON.stringify(entry.id),
                    "treeTabs:special-tab-states": JSON.stringify(
                      entry.collapsed ? ["subtree-collapsed"] : []
                    ),
                  },
                })),
                selected: selectedIndex,
                extData: {
                  "treeTabs:tree-structure": JSON.stringify(structure),
                },
              },
            ],
          }),
          true
        );
        await windowRestored;
        const [outside, parent, child] = browser.tabs;
        await BrowserTestUtils.waitForCondition(
          () =>
            service.getParent(child) == parent &&
            parent.dataset.treeHasChildren == "true" &&
            service.isCollapsed(parent) == initiallyCollapsed,
          "The lazy branch restores its saved disclosure state"
        );
        await restoredWindow.SidebarController.waitUntilStable();
        ok(parent.hasAttribute("pending"), "The parent starts unloaded");
        const tabRestored = BrowserTestUtils.waitForEvent(
          parent,
          "SSTabRestored"
        );
        const rect = parent.getBoundingClientRect();
        const padding =
          parseFloat(
            restoredWindow
              .getComputedStyle(parent)
              .getPropertyValue("--tab-inline-padding")
          ) || 8;
        EventUtils.synthesizeMouse(
          parent,
          padding + 4,
          rect.height / 2,
          {},
          restoredWindow
        );
        is(
          service.isCollapsed(parent),
          !initiallyCollapsed,
          "The arrow changes the branch disclosure state"
        );
        is(
          browser.selectedTab,
          selectedIndex == 3 ? parent : outside,
          "Only hiding the active child moves selection to the parent"
        );
        is(
          parent.hasAttribute("pending"),
          selectedIndex != 3,
          "The arrow only loads the parent when its active child is hidden"
        );

        if (browser.selectedTab != parent) {
          await BrowserTestUtils.switchTab(browser, parent);
        }
        await tabRestored;
        await waitForTreeUpdate();
        is(
          service.isCollapsed(parent),
          !initiallyCollapsed,
          "Loading the parent preserves the disclosure choice"
        );
        is(
          child.dataset.treeHidden == "true",
          !initiallyCollapsed,
          "Child visibility matches the disclosure choice after loading"
        );
        is(service.getParent(child), parent, "Loading preserves the tree link");
      }
    } finally {
      await BrowserTestUtils.closeWindow(restoredWindow);
      await SpecialPowers.popPrefEnv();
    }
  }
);

add_task(async function test_undo_close_restores_tree_position() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "https://example.com/?undo-parent"
  );
  await BrowserTestUtils.browserLoaded(parentTab.linkedBrowser);
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?undo-child"
  );

  const { TreeTabsStore } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsStore.sys.mjs"
  );
  TreeTabsStore.clearRestoreGuard(window);
  TreeTabsStore.saveTabState(childTab);
  ok(
    SessionStore.getCustomTabValue(childTab, "treeTabs:ancestors"),
    "Child tab ancestors are saved before close"
  );

  const closedTabCount = SessionStore.getClosedTabCountForWindow(window);
  BrowserTestUtils.removeTab(childTab);
  await waitForTreeCondition(
    () => SessionStore.getClosedTabCountForWindow(window) > closedTabCount,
    "Waiting for closed tab to be recorded"
  );

  const restoredTab = SessionStore.undoCloseTab(window, 0);
  await BrowserTestUtils.browserLoaded(restoredTab.linkedBrowser);
  await waitForTreeUpdate();
  await waitForTreeCondition(
    () => getTreeParent(restoredTab) === parentTab,
    "Waiting for restored tab to reattach to parent"
  );

  is(
    getTreeParent(restoredTab),
    parentTab,
    "Undo-closed tab restores tree parent"
  );
  is(getTreeLevel(restoredTab), 1, "Undo-closed tab restores at correct level");

  BrowserTestUtils.removeTab(restoredTab);
  BrowserTestUtils.removeTab(parentTab);
});

function getClosedTreeRestoreRecordURL(closedTabData) {
  const { state } = closedTabData;
  return state.entries[state.index - 1].url;
}

function getTreeRestoreTabsForURL(url) {
  return Array.from(gBrowser.tabs).filter(
    tab => tab.linkedBrowser.currentURI.spec == url
  );
}

function treeRestoreTabsMatch(actualTabs, expectedTabs) {
  return (
    actualTabs.length == expectedTabs.length &&
    actualTabs.every((tab, index) => tab == expectedTabs[index])
  );
}

add_task(async function test_undo_closed_tree_member_restores_exact_tree_set() {
  await enableTreeTabs();

  const urls = {
    externalParent:
      "https://example.com/?waterfox-tree-close-set-external-parent",
    beforeSibling:
      "https://example.com/?waterfox-tree-close-set-before-sibling",
    subtreeRoot: "https://example.com/?waterfox-tree-close-set-subtree-root",
    branchOne: "https://example.com/?waterfox-tree-close-set-branch-one",
    grandchild: "https://example.com/?waterfox-tree-close-set-grandchild",
    branchTwo: "https://example.com/?waterfox-tree-close-set-branch-two",
    afterSibling: "https://example.com/?waterfox-tree-close-set-after-sibling",
  };

  const externalParent = BrowserTestUtils.addTab(gBrowser, urls.externalParent);
  await BrowserTestUtils.browserLoaded(
    externalParent.linkedBrowser,
    false,
    urls.externalParent
  );
  gBrowser.TreeTabsService.detachTab(externalParent);
  await BrowserTestUtils.switchTab(gBrowser, externalParent);

  const beforeSibling = await openTabWithTree(
    externalParent,
    urls.beforeSibling
  );
  const subtreeRoot = await openTabWithTree(externalParent, urls.subtreeRoot);
  const branchOne = await openTabWithTree(subtreeRoot, urls.branchOne);
  const grandchild = await openTabWithTree(branchOne, urls.grandchild);
  const branchTwo = await openTabWithTree(subtreeRoot, urls.branchTwo);
  const afterSibling = await openTabWithTree(externalParent, urls.afterSibling);
  const subtreeMembers = [subtreeRoot, branchOne, grandchild, branchTwo];
  const memberURLs = subtreeMembers.map(
    tab => tab.linkedBrowser.currentURI.spec
  );
  const tabCountBeforeClose = gBrowser.tabs.length;

  await waitForTreeCondition(
    () =>
      treeRestoreTabsMatch(
        gBrowser.TreeTabsService.getChildren(externalParent),
        [beforeSibling, subtreeRoot, afterSibling]
      ) &&
      treeRestoreTabsMatch(gBrowser.TreeTabsService.getChildren(subtreeRoot), [
        branchOne,
        branchTwo,
      ]) &&
      treeRestoreTabsMatch(gBrowser.TreeTabsService.getChildren(branchOne), [
        grandchild,
      ]),
    "Waiting for the Close Tree test topology"
  );

  gBrowser.TreeTabsService.collapseSubtree(branchOne);
  await waitForTreeCondition(
    () => gBrowser.TreeTabsService.isCollapsed(branchOne),
    "Waiting for the child branch to collapse"
  );

  const menu = await openTabContextMenu(subtreeRoot);
  const closeTreeItem = document.getElementById("context_closeTree");
  ok(!closeTreeItem.hidden, "Close Tree is available for the nested subtree");
  const menuHidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(closeTreeItem);
  await menuHidden;

  await waitForTreeCondition(
    () => subtreeMembers.every(tab => !gBrowser.tabs.includes(tab)),
    "Waiting for every nested subtree member to close"
  );
  is(
    gBrowser.tabs.length,
    tabCountBeforeClose - subtreeMembers.length,
    "Close Tree removes exactly the nested subtree"
  );
  ok(
    gBrowser.tabs.includes(externalParent),
    "The external parent survives Close Tree"
  );

  await waitForTreeCondition(() => {
    const closedURLs = new Set(
      SessionStore.getClosedTabDataForWindow(window).map(
        getClosedTreeRestoreRecordURL
      )
    );
    return memberURLs.every(url => closedURLs.has(url));
  }, "Waiting for every subtree member to have a closed record");

  const closedGrandchild = SessionStore.getClosedTabDataForWindow(window).find(
    closedTabData =>
      getClosedTreeRestoreRecordURL(closedTabData) == urls.grandchild
  );
  ok(closedGrandchild, "Found the non-root grandchild closed record");
  ok(
    Number.isInteger(closedGrandchild.closedId),
    "The non-root grandchild closed record has a closedId"
  );

  const directlyRestoredTab = SessionStore.undoCloseById(
    closedGrandchild.closedId,
    true,
    window
  );
  ok(directlyRestoredTab, "Undo by the non-root closedId returns a tab");

  await waitForTreeCondition(
    () => memberURLs.every(url => !!getTreeRestoreTabsForURL(url).length),
    "Waiting for every closed tree member to return"
  );

  const restoredSubtreeRoot = getTreeRestoreTabsForURL(urls.subtreeRoot)[0];
  const restoredBranchOne = getTreeRestoreTabsForURL(urls.branchOne)[0];
  const restoredGrandchild = getTreeRestoreTabsForURL(urls.grandchild)[0];
  const restoredBranchTwo = getTreeRestoreTabsForURL(urls.branchTwo)[0];
  const expectedStripTabs = [
    externalParent,
    beforeSibling,
    restoredSubtreeRoot,
    restoredBranchOne,
    restoredGrandchild,
    restoredBranchTwo,
    afterSibling,
  ];
  const expectedStripURLs = [
    urls.externalParent,
    urls.beforeSibling,
    urls.subtreeRoot,
    urls.branchOne,
    urls.grandchild,
    urls.branchTwo,
    urls.afterSibling,
  ];

  await waitForTreeCondition(
    () =>
      treeRestoreTabsMatch(
        Array.from(gBrowser.tabs).slice(
          externalParent._tPos,
          externalParent._tPos + expectedStripTabs.length
        ),
        expectedStripTabs
      ) &&
      treeRestoreTabsMatch(
        gBrowser.TreeTabsService.getChildren(externalParent),
        [beforeSibling, restoredSubtreeRoot, afterSibling]
      ) &&
      treeRestoreTabsMatch(
        gBrowser.TreeTabsService.getChildren(restoredSubtreeRoot),
        [restoredBranchOne, restoredBranchTwo]
      ) &&
      treeRestoreTabsMatch(
        gBrowser.TreeTabsService.getChildren(restoredBranchOne),
        [restoredGrandchild]
      ) &&
      gBrowser.TreeTabsService.isCollapsed(restoredBranchOne) &&
      isTreeHidden(restoredGrandchild),
    "Waiting for the exact closed tree set to be restored"
  );

  is(
    gBrowser.tabs.length,
    tabCountBeforeClose,
    "Restoring one member restores the original tab count without duplicates"
  );
  for (const url of expectedStripURLs) {
    is(
      getTreeRestoreTabsForURL(url).length,
      1,
      `Exactly one restored test tab has URL ${url}`
    );
  }
  is(
    directlyRestoredTab,
    restoredGrandchild,
    "The requested non-root member is reused during whole-set restore"
  );
  is(
    SessionStore.getClosedTabDataForWindow(window).filter(closedTabData =>
      memberURLs.includes(getClosedTreeRestoreRecordURL(closedTabData))
    ).length,
    0,
    "No restored tree member remains as a duplicate closed record"
  );
  Assert.deepEqual(
    Array.from(gBrowser.tabs)
      .slice(
        externalParent._tPos,
        externalParent._tPos + expectedStripURLs.length
      )
      .map(tab => tab.linkedBrowser.currentURI.spec),
    expectedStripURLs,
    "The exact contiguous tab strip order is restored"
  );
  is(
    getTreeParent(restoredSubtreeRoot),
    externalParent,
    "The restored subtree root returns to its surviving external parent"
  );
  Assert.deepEqual(
    gBrowser.TreeTabsService.getChildren(externalParent).map(
      tab => tab.linkedBrowser.currentURI.spec
    ),
    [urls.beforeSibling, urls.subtreeRoot, urls.afterSibling],
    "The external parent's child order is restored exactly"
  );
  Assert.deepEqual(
    gBrowser.TreeTabsService.getChildren(restoredSubtreeRoot).map(
      tab => tab.linkedBrowser.currentURI.spec
    ),
    [urls.branchOne, urls.branchTwo],
    "The restored subtree's two child branches retain sibling order"
  );
  is(
    getTreeParent(restoredBranchOne),
    restoredSubtreeRoot,
    "The first branch returns under the restored subtree root"
  );
  is(
    getTreeParent(restoredGrandchild),
    restoredBranchOne,
    "The grandchild returns under the first branch"
  );
  is(
    getTreeParent(restoredBranchTwo),
    restoredSubtreeRoot,
    "The second branch returns under the restored subtree root"
  );
  Assert.deepEqual(
    gBrowser.TreeTabsService.getDescendants(externalParent).map(
      tab => tab.linkedBrowser.currentURI.spec
    ),
    expectedStripURLs.slice(1),
    "The full restored tree topology is exact"
  );
  ok(
    gBrowser.TreeTabsService.isCollapsed(restoredBranchOne),
    "The restored child branch remains collapsed"
  );
  ok(
    !gBrowser.TreeTabsService.isCollapsed(restoredSubtreeRoot),
    "The restored subtree root remains expanded"
  );
  ok(isTreeHidden(restoredGrandchild), "The collapsed branch hides its child");

  for (const tab of [...expectedStripTabs].reverse()) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(async function test_undo_closed_descendant_restores_exact_set() {
  await enableTreeTabs();

  const urls = {
    root: "https://example.com/?waterfox-tree-descendant-set-root",
    childOne: "https://example.com/?waterfox-tree-descendant-set-child-one",
    grandchild: "https://example.com/?waterfox-tree-descendant-set-grandchild",
    childTwo: "https://example.com/?waterfox-tree-descendant-set-child-two",
  };

  const root = BrowserTestUtils.addTab(gBrowser, urls.root);
  await BrowserTestUtils.browserLoaded(root.linkedBrowser, false, urls.root);
  gBrowser.TreeTabsService.detachTab(root);
  await BrowserTestUtils.switchTab(gBrowser, root);

  const childOne = await openTabWithTree(root, urls.childOne);
  const grandchild = await openTabWithTree(childOne, urls.grandchild);
  const childTwo = await openTabWithTree(root, urls.childTwo);
  const descendants = [childOne, grandchild, childTwo];
  const descendantURLs = descendants.map(
    tab => tab.linkedBrowser.currentURI.spec
  );
  const tabCountBeforeClose = gBrowser.tabs.length;

  await waitForTreeCondition(
    () =>
      treeRestoreTabsMatch(gBrowser.TreeTabsService.getChildren(root), [
        childOne,
        childTwo,
      ]) &&
      treeRestoreTabsMatch(gBrowser.TreeTabsService.getChildren(childOne), [
        grandchild,
      ]),
    "Waiting for the Close Descendants test topology"
  );

  const menu = await openTabContextMenu(root);
  const closeDescendantsItem = document.getElementById(
    "context_closeDescendants"
  );
  ok(
    !closeDescendantsItem.hidden,
    "Close Descendants is available for the surviving root"
  );
  const menuHidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.activateItem(closeDescendantsItem);
  await menuHidden;

  await waitForTreeCondition(
    () => descendants.every(tab => !gBrowser.tabs.includes(tab)),
    "Waiting for every descendant to close"
  );
  ok(gBrowser.tabs.includes(root), "Close Descendants preserves the root");
  is(
    gBrowser.TreeTabsService.getChildren(root).length,
    0,
    "The surviving root has no children while its descendants are closed"
  );

  await waitForTreeCondition(() => {
    const closedURLs = new Set(
      SessionStore.getClosedTabDataForWindow(window).map(
        getClosedTreeRestoreRecordURL
      )
    );
    return descendantURLs.every(url => closedURLs.has(url));
  }, "Waiting for every descendant to have a closed record");

  const closedChildTwo = SessionStore.getClosedTabDataForWindow(window).find(
    closedTabData =>
      getClosedTreeRestoreRecordURL(closedTabData) == urls.childTwo
  );
  ok(closedChildTwo, "Found one descendant's closed record");
  ok(
    Number.isInteger(closedChildTwo.closedId),
    "The descendant closed record has a closedId"
  );

  const directlyRestoredTab = SessionStore.undoCloseById(
    closedChildTwo.closedId,
    true,
    window
  );
  ok(directlyRestoredTab, "Undo by one descendant closedId returns a tab");

  await waitForTreeCondition(
    () => descendantURLs.every(url => !!getTreeRestoreTabsForURL(url).length),
    "Waiting for every descendant to return"
  );

  const restoredChildOne = getTreeRestoreTabsForURL(urls.childOne)[0];
  const restoredGrandchild = getTreeRestoreTabsForURL(urls.grandchild)[0];
  const restoredChildTwo = getTreeRestoreTabsForURL(urls.childTwo)[0];
  const expectedStripTabs = [
    root,
    restoredChildOne,
    restoredGrandchild,
    restoredChildTwo,
  ];
  const expectedStripURLs = [
    urls.root,
    urls.childOne,
    urls.grandchild,
    urls.childTwo,
  ];

  await waitForTreeCondition(
    () =>
      treeRestoreTabsMatch(
        Array.from(gBrowser.tabs).slice(
          root._tPos,
          root._tPos + expectedStripTabs.length
        ),
        expectedStripTabs
      ) &&
      treeRestoreTabsMatch(gBrowser.TreeTabsService.getChildren(root), [
        restoredChildOne,
        restoredChildTwo,
      ]) &&
      treeRestoreTabsMatch(
        gBrowser.TreeTabsService.getChildren(restoredChildOne),
        [restoredGrandchild]
      ),
    "Waiting for the exact descendant set to be restored"
  );

  is(
    gBrowser.tabs.length,
    tabCountBeforeClose,
    "Restoring one descendant restores the original tab count"
  );
  for (const url of expectedStripURLs) {
    is(
      getTreeRestoreTabsForURL(url).length,
      1,
      `Exactly one descendant test tab has URL ${url}`
    );
  }
  is(
    directlyRestoredTab,
    restoredChildTwo,
    "The requested descendant is reused during whole-set restore"
  );
  is(
    SessionStore.getClosedTabDataForWindow(window).filter(closedTabData =>
      descendantURLs.includes(getClosedTreeRestoreRecordURL(closedTabData))
    ).length,
    0,
    "No restored descendant remains as a duplicate closed record"
  );
  Assert.deepEqual(
    Array.from(gBrowser.tabs)
      .slice(root._tPos, root._tPos + expectedStripURLs.length)
      .map(tab => tab.linkedBrowser.currentURI.spec),
    expectedStripURLs,
    "The descendant set returns in exact tab strip order"
  );
  is(getTreeParent(root), null, "The surviving root remains a tree root");
  Assert.deepEqual(
    gBrowser.TreeTabsService.getChildren(root).map(
      tab => tab.linkedBrowser.currentURI.spec
    ),
    [urls.childOne, urls.childTwo],
    "The surviving root regains both children in exact order"
  );
  is(
    getTreeParent(restoredChildOne),
    root,
    "The first child returns under the surviving root"
  );
  is(
    getTreeParent(restoredGrandchild),
    restoredChildOne,
    "The grandchild returns under the first child"
  );
  is(
    getTreeParent(restoredChildTwo),
    root,
    "The second child returns under the surviving root"
  );
  Assert.deepEqual(
    gBrowser.TreeTabsService.getDescendants(root).map(
      tab => tab.linkedBrowser.currentURI.spec
    ),
    descendantURLs,
    "Every descendant returns in the exact original topology"
  );

  for (const tab of [...expectedStripTabs].reverse()) {
    BrowserTestUtils.removeTab(tab);
  }
});

add_task(
  async function test_sequential_multi_tab_closes_restore_each_tree_set() {
    await enableTreeTabs();

    const urls = {
      firstRoot: "about:blank?waterfox-tree-sequential-first-root",
      firstChild: "about:blank?waterfox-tree-sequential-first-child",
      secondRoot: "about:blank?waterfox-tree-sequential-second-root",
      secondChild: "about:blank?waterfox-tree-sequential-second-child",
    };
    const firstRoot = BrowserTestUtils.addTab(gBrowser, urls.firstRoot);
    const firstChild = await openTabWithTree(firstRoot, urls.firstChild);
    const secondRoot = BrowserTestUtils.addTab(gBrowser, urls.secondRoot);
    const secondChild = await openTabWithTree(secondRoot, urls.secondChild);

    gBrowser.removeTabs([firstRoot, firstChild], { isUserTriggered: true });
    await waitForTreeCondition(
      () =>
        !gBrowser.tabs.includes(firstRoot) &&
        !gBrowser.tabs.includes(firstChild),
      "Waiting for the first tree set to close"
    );
    gBrowser.removeTabs([secondRoot, secondChild], { isUserTriggered: true });
    await waitForTreeCondition(
      () =>
        !gBrowser.tabs.includes(secondRoot) &&
        !gBrowser.tabs.includes(secondChild),
      "Waiting for the second tree set to close"
    );

    const findClosedByURL = url =>
      SessionStore.getClosedTabDataForWindow(window).find(
        closedTabData => getClosedTreeRestoreRecordURL(closedTabData) == url
      );
    await waitForTreeCondition(
      () =>
        Object.values(urls).every(
          url => findClosedByURL(url)?.closedId != null
        ),
      "Waiting for both closed tree sets to reach SessionStore"
    );
    const firstClosedChild = findClosedByURL(urls.firstChild);
    const secondClosedChild = findClosedByURL(urls.secondChild);
    ok(firstClosedChild, "The first closed tree set remains available");
    ok(secondClosedChild, "The second closed tree set remains available");

    SessionStore.undoCloseById(firstClosedChild.closedId, true, window);
    await waitForTreeCondition(
      () =>
        getTreeRestoreTabsForURL(urls.firstRoot).length == 1 &&
        getTreeRestoreTabsForURL(urls.firstChild).length == 1,
      "Waiting for the older closed tree set to restore"
    );
    const restoredFirstRoot = getTreeRestoreTabsForURL(urls.firstRoot)[0];
    const restoredFirstChild = getTreeRestoreTabsForURL(urls.firstChild)[0];
    is(
      getTreeParent(restoredFirstChild),
      restoredFirstRoot,
      "The older closed set restores its topology"
    );

    SessionStore.undoCloseById(secondClosedChild.closedId, true, window);
    await waitForTreeCondition(
      () =>
        getTreeRestoreTabsForURL(urls.secondRoot).length == 1 &&
        getTreeRestoreTabsForURL(urls.secondChild).length == 1,
      "Waiting for the newer closed tree set to restore"
    );
    const restoredSecondRoot = getTreeRestoreTabsForURL(urls.secondRoot)[0];
    const restoredSecondChild = getTreeRestoreTabsForURL(urls.secondChild)[0];
    is(
      getTreeParent(restoredSecondChild),
      restoredSecondRoot,
      "The newer closed set restores its topology"
    );

    for (const tab of [
      restoredSecondChild,
      restoredSecondRoot,
      restoredFirstChild,
      restoredFirstRoot,
    ]) {
      BrowserTestUtils.removeTab(tab);
    }
  }
);
