/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_collapse_and_expand() {
  await enableTreeTabs();

  const parentTab = gBrowser.selectedTab;
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-collapse-child"
  );
  const grandchildTab = await openTabWithTree(
    childTab,
    "https://example.com/?waterfox-tree-collapse-grandchild"
  );

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childTab) && isTreeHidden(grandchildTab),
    "Waiting for descendant tabs to become hidden"
  );

  ok(
    isTreeHidden(childTab),
    "Child is marked hidden while parent is collapsed"
  );
  ok(
    isTreeHidden(grandchildTab),
    "Grandchild is marked hidden while parent is collapsed"
  );
  is(
    window.getComputedStyle(childTab).display,
    "none",
    "Child is not visible in tab strip while collapsed"
  );
  is(
    window.getComputedStyle(grandchildTab).display,
    "none",
    "Grandchild is not visible in tab strip while collapsed"
  );

  gBrowser.TreeTabsService.expandSubtree(parentTab);
  await waitForTreeCondition(
    () => !isTreeHidden(childTab) && !isTreeHidden(grandchildTab),
    "Waiting for descendant tabs to become visible"
  );

  ok(!isTreeHidden(childTab), "Child is visible again after expand");
  ok(!isTreeHidden(grandchildTab), "Grandchild is visible again after expand");

  gBrowser.TreeTabsService.collapseSubtree(childTab);
  await waitForTreeCondition(
    () => isTreeHidden(grandchildTab),
    "Waiting for nested grandchild to become hidden"
  );
  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childTab) && isTreeHidden(grandchildTab),
    "Waiting for full subtree to become hidden"
  );

  gBrowser.TreeTabsService.expandSubtree(parentTab);
  await waitForTreeCondition(
    () => !isTreeHidden(childTab),
    "Waiting for collapsed child to become visible after expanding parent"
  );

  ok(!isTreeHidden(childTab), "Child is visible when parent is re-expanded");
  ok(
    isTreeHidden(grandchildTab),
    "Grandchild remains hidden because child stays collapsed"
  );

  BrowserTestUtils.removeTab(grandchildTab);
  BrowserTestUtils.removeTab(childTab);
});

add_task(async function test_closing_collapsed_parent_closes_subtree() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?collapsed-close-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childTab = await openTabWithTree(parentTab, "about:blank");
  const grandchildTab = await openTabWithTree(childTab, "about:blank");
  const otherTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?collapsed-close-other"
  );

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childTab),
    "Waiting for the subtree to collapse"
  );

  BrowserTestUtils.removeTab(parentTab, { isUserTriggered: true });
  await waitForTreeCondition(
    () =>
      !gBrowser.tabs.includes(childTab) &&
      !gBrowser.tabs.includes(grandchildTab),
    "Waiting for the collapsed subtree to close with its parent"
  );

  ok(
    !gBrowser.tabs.includes(childTab),
    "Child closed together with its collapsed parent"
  );
  ok(
    !gBrowser.tabs.includes(grandchildTab),
    "Grandchild closed together with its collapsed parent"
  );
  ok(gBrowser.tabs.includes(otherTab), "Unrelated tab stays open");

  BrowserTestUtils.removeTab(otherTab);
});

add_task(async function test_programmatic_close_of_collapsed_parent_promotes() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?programmatic-close-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childA = await openTabWithTree(parentTab, "about:blank");
  const childB = await openTabWithTree(parentTab, "about:blank");

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childA),
    "Waiting for the subtree to collapse"
  );

  // No isUserTriggered: this is how an extension's tabs.remove arrives.
  BrowserTestUtils.removeTab(parentTab);
  await waitForTreeCondition(
    () => !gBrowser.tabs.includes(parentTab),
    "Waiting for the parent to close"
  );

  ok(gBrowser.tabs.includes(childA), "First child survives programmatic close");
  ok(
    gBrowser.tabs.includes(childB),
    "Second child survives programmatic close"
  );
  is(getTreeParent(childA), null, "First child is promoted");
  is(getTreeParent(childB), childA, "Second child moves under the first");

  BrowserTestUtils.removeTab(childB);
  BrowserTestUtils.removeTab(childA);
});

add_task(
  async function test_disclosure_does_not_select_or_load_a_lazy_parent() {
    await enableTreeTabs();
    SidebarController._state.launcherExpanded = true;
    await waitForTreeCondition(
      () => gBrowser.tabContainer.hasAttribute("expanded"),
      "Waiting for expanded rows"
    );
    const selected = gBrowser.selectedTab;
    const parent = BrowserTestUtils.addTab(gBrowser, "", {
      createLazyBrowser: true,
      skipAnimation: true,
    });
    const child = BrowserTestUtils.addTab(gBrowser, "about:blank", {
      skipAnimation: true,
    });
    const service = gBrowser.TreeTabsService;
    try {
      service.detachTab(parent);
      service.attachTab(child, parent);
      const disclosure = parent.querySelector(".tab-tree-disclosure");
      ok(!parent.linkedPanel, "The background parent has no inserted browser");
      is(disclosure.tabIndex, -1, "The disclosure adds no sequential tab stop");
      const collapseName = disclosure.getAttribute("aria-label");
      ok(collapseName, "The expanded disclosure has a localized action name");
      for (const modifiers of [{}, { accelKey: true }, { shiftKey: true }]) {
        const collapsed = service.isCollapsed(parent);
        EventUtils.synthesizeMouseAtCenter(disclosure, {
          ...modifiers,
          type: "mousedown",
          button: 0,
        });
        is(
          gBrowser.selectedTab,
          selected,
          "Capture mousedown prevents selection"
        );
        ok(
          !parent.linkedPanel,
          "Capture mousedown does not insert the lazy browser"
        );
        EventUtils.synthesizeMouseAtCenter(disclosure, {
          ...modifiers,
          type: "mouseup",
          button: 0,
        });
        is(
          service.isCollapsed(parent),
          !collapsed,
          "The disclosure toggles its tree"
        );
        is(
          isTreeHidden(child),
          !collapsed,
          "Visibility changes before click returns"
        );
        is(
          disclosure.getAttribute("aria-expanded"),
          String(collapsed),
          "Button state follows the tree"
        );
        is(
          parent.getAttribute("aria-expanded"),
          String(collapsed),
          "The keyboard row exposes the same state"
        );
        is(gBrowser.selectedTab, selected, "Click does not select the parent");
        ok(!parent.linkedPanel, "Click does not insert the lazy browser");
        ok(
          !parent.multiselected,
          "Modified disclosure clicks do not multiselect"
        );
      }
      isnot(
        disclosure.getAttribute("aria-label"),
        collapseName,
        "Collapsed state names the expand action"
      );
      service.detachTab(child);
      ok(disclosure.hidden, "Removing the last child removes the hit target");
      ok(
        !parent.hasAttribute("aria-expanded"),
        "Leaf rows have no disclosure state"
      );
      service.attachTab(child, parent);
      await disableTreeTabs();
      ok(disclosure.hidden, "Disabling trees hides the disclosure");
      ok(
        !disclosure.hasAttribute("aria-expanded"),
        "Disabling clears button state"
      );
      ok(!parent.hasAttribute("aria-expanded"), "Disabling clears row state");
    } finally {
      await BrowserTestUtils.removeTab(child);
      await BrowserTestUtils.removeTab(parent);
    }
  }
);

add_task(async function test_close_commands_own_or_borrow_one_snapshot() {
  await enableTreeTabs();
  const { TreeTabsUI } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsUI.sys.mjs"
  );
  const { TreeTabsStore: store } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsStore.sys.mjs"
  );
  const controller = TreeTabsUI._controllers.get(window);
  const service = gBrowser.TreeTabsService;
  for (const command of ["tree", "descendants", "request"]) {
    for (const borrowed of [false, true]) {
      const tabs = Array.from({ length: 5 }, () =>
        BrowserTestUtils.addTab(gBrowser, "about:blank", {
          skipAnimation: true,
        })
      );
      const [root, rootPane, child, childPane, grandchild] = tabs;
      const originalBegin = store.beginClosedTreeSet;
      const originalFinish = store.finishClosedTreeSet;
      const originalRemove = gBrowser.removeTabs;
      let snapshot;
      let begins = 0;
      let finishes = 0;
      let removals = 0;
      try {
        for (const tab of tabs) {
          service.detachTab(tab);
        }
        for (const panes of [
          [root, rootPane],
          [child, childPane],
        ]) {
          const created = BrowserTestUtils.waitForEvent(
            gBrowser.tabContainer,
            "SplitViewCreated"
          );
          gBrowser.addTabSplitView(panes);
          await created;
        }
        service.attachTab(child, root);
        service.attachTab(grandchild, child);
        service.collapseSubtree(child);
        const members = command == "descendants" ? tabs.slice(2) : tabs;
        if (borrowed) {
          snapshot = originalBegin.call(store, window, members);
        }
        store.beginClosedTreeSet = function (target, requested) {
          if (target == window) {
            begins++;
            is(
              service.getParent(child),
              root,
              "Capture precedes model removal"
            );
            is(
              service.getParent(grandchild),
              child,
              "Capture keeps nested links"
            );
          }
          const result = originalBegin.call(this, target, requested);
          if (target == window) {
            snapshot = result;
          }
          return result;
        };
        store.finishClosedTreeSet = function (target) {
          if (target == window) {
            finishes++;
          }
          return originalFinish.call(this, target);
        };
        gBrowser.removeTabs = function (requested, ...args) {
          removals++;
          ok(
            store.hasActiveClosedTreeSet(window),
            "Browser removal runs inside the snapshot scope"
          );
          Assert.deepEqual(
            new Set(snapshot.entries.map(entry => entry.tab)),
            new Set(members),
            "The snapshot preserves baseTab and physical split-pane membership"
          );
          ok(
            snapshot.entries.find(entry => entry.tab == child).collapsed,
            "Collapse state was captured before mutation"
          );
          if (command != "request") {
            is(
              service.getParent(grandchild),
              null,
              "Commands remove the model before browser tabs"
            );
          }
          Assert.deepEqual(
            new Set(requested),
            new Set(command == "tree" ? tabs : tabs.slice(2)),
            "Browser removal includes physical split panes exactly once"
          );
          return originalRemove.call(this, requested, ...args);
        };
        if (command == "request") {
          controller.observe(
            {
              wrappedJSObject: {
                window,
                tabs: [child, grandchild],
                baseTab: root,
              },
            },
            "tree-tabs-close-requested"
          );
        } else {
          controller._closeTrees([root], {
            descendantsOnly: command == "descendants",
          });
        }
        is(
          begins,
          borrowed ? 0 : 1,
          `${command}: only an owner begins a snapshot`
        );
        is(
          finishes,
          borrowed ? 0 : 1,
          `${command}: a borrower never finishes its parent's snapshot`
        );
        is(removals, 1, "Each command removes browser tabs once");
        is(
          store.hasActiveClosedTreeSet(window),
          borrowed,
          "Only the enclosing transaction remains active"
        );
        is(
          gBrowser.tabs.includes(root),
          command != "tree",
          "Descendants-only removal keeps its root"
        );
      } finally {
        store.beginClosedTreeSet = originalBegin;
        store.finishClosedTreeSet = originalFinish;
        gBrowser.removeTabs = originalRemove;
        if (store.hasActiveClosedTreeSet(window)) {
          store.finishClosedTreeSet(window);
        }
        for (const tab of tabs.toReversed()) {
          if (tab.isConnected && !tab.closing) {
            await BrowserTestUtils.removeTab(tab);
          }
        }
      }
    }
  }
  const failure = new Error("snapshot scope failure");
  Assert.throws(
    () =>
      controller._withClosedTreeSet([gBrowser.selectedTab], () => {
        throw failure;
      }),
    /snapshot scope failure/,
    "Exceptions propagate out of the snapshot scope"
  );
  ok(
    !store.hasActiveClosedTreeSet(window),
    "An exceptional owner still finishes its transaction"
  );
});
