/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TreeTabsUI } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsUI.sys.mjs"
);
const { TreeTabsService } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsService.sys.mjs"
);
const { GROUP_TAB_URL, TreeTabsGroups } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsGroups.sys.mjs"
);

function withRestoreWorkFixture(tabCount, options, task) {
  const counts = {
    groupURLReads: 0,
    rowUpdates: 0,
    manualRestoreChecks: 0,
    nativeGroupReconcileRequests: 0,
    cleanupCalls: 0,
  };
  const timers = new Map();
  const cleanupBatches = [];
  let timerId = 0;
  const win = {
    document: {},
    gBrowser: { tabs: [] },
    setTimeout(callback, delay) {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    addEventListener() {},
  };
  const tabs = Array.from({ length: tabCount }, (_, index) => {
    const tab = {
      documentGlobal: win,
      _tPos: index,
      closing: false,
      pinned: false,
      group: null,
      splitview: null,
      fixtureGroup: false,
    };
    tab.linkedBrowser = {
      currentURI: {
        get spec() {
          counts.groupURLReads++;
          return tab.fixtureGroup ? GROUP_TAB_URL : "about:blank";
        },
      },
    };
    return tab;
  });
  win.gBrowser.tabs = tabs;
  const originalCleanup = TreeTabsGroups.cleanupNeedlessGroupTabs;
  try {
    // Missing tabContainer leaves the controller uninitialized, without real
    // observers. Discard that init retry, then supply the synthetic container.
    TreeTabsUI.onWindowOpened(win);
    const controller = TreeTabsUI._controllers.get(win);
    if (!controller || controller._initialized) {
      throw new Error("The synthetic controller must not install observers");
    }
    timers.clear();
    win.gBrowser.tabContainer = {
      verticalMode: options.verticalMode ?? true,
      allSplitViews: [],
    };
    controller._tabContainer = win.gBrowser.tabContainer;
    controller._updateTab = () => counts.rowUpdates++;
    controller._updateHiddenTabs = () => {};
    controller._maybeTryManualRestore = () => {
      counts.manualRestoreChecks++;
      return false;
    };
    controller._scheduleNativeGroupReconcile = () => {
      if (controller._isEnabled()) {
        counts.nativeGroupReconcileRequests++;
      }
    };

    TreeTabsGroups.cleanupNeedlessGroupTabs = function (targetWindow, pending) {
      if (targetWindow != win) {
        originalCleanup.call(this, targetWindow, pending);
        return;
      }
      counts.cleanupCalls++;
      cleanupBatches.push(pending.slice());
    };

    return task({
      win,
      tabs,
      controller,
      counts,
      timers,
      cleanupBatches,
      notify(tab = tabs.at(-1)) {
        controller.handleEvent({ type: "SSTabRestored", target: tab });
      },
      resetCounts() {
        for (const key of Object.keys(counts)) {
          counts[key] = 0;
        }
        cleanupBatches.length = 0;
      },
      flushTimers() {
        let callbacks = 0;
        while (timers.size) {
          if (++callbacks > 32) {
            throw new Error("Unexpected repeating timer in restore fixture");
          }
          const [id, { callback }] = timers.entries().next().value;
          timers.delete(id);
          callback();
        }
      },
    });
  } finally {
    TreeTabsGroups.cleanupNeedlessGroupTabs = originalCleanup;
    TreeTabsUI.onWindowClosed(win);
    TreeTabsService.uninit(win);
    timers.clear();
  }
}

function measureRestoreNotificationWork(tabCount, options) {
  return withRestoreWorkFixture(tabCount, options, fixture => {
    for (const tab of fixture.tabs) {
      fixture.notify(tab);
    }
    const synchronous = { ...fixture.counts };
    fixture.flushTimers();
    return { synchronous, total: { ...fixture.counts } };
  });
}

add_task(async function test_restore_notification_work_is_bounded() {
  for (const [enabled, verticalMode] of [
    [false, true],
    [true, false],
    [true, true],
  ]) {
    await SpecialPowers.pushPrefEnv({
      set: [[PREF_TREE_ENABLED, enabled]],
    });
    try {
      for (const tabs of [32, 64, 128]) {
        info(`Restore ${tabs} tabs: tree=${enabled}, vertical=${verticalMode}`);
        const { synchronous, total } = measureRestoreNotificationWork(tabs, {
          verticalMode,
        });
        is(synchronous.groupURLReads, 0, "The entire scan is deferred");
        is(
          total.groupURLReads,
          enabled && verticalMode ? tabs : 0,
          "One scan per active burst, no scan in inactive tree mode"
        );
        is(total.rowUpdates, 0, "Flat restores do not refresh every row");
        is(
          total.nativeGroupReconcileRequests,
          enabled ? tabs : 0,
          "Preserve the existing debounced native-group restore scheduling"
        );
        is(
          total.manualRestoreChecks,
          tabs,
          "Every notification still checks for pending manual restoration"
        );
      }
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});

add_task(async function test_group_cleanup_batches_scan_and_targeted_work() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF_TREE_ENABLED, true]] });
  try {
    withRestoreWorkFixture(8, {}, fixture => {
      const { controller, tabs, counts, timers, cleanupBatches } = fixture;
      const [target, group, lateGroup, closing] = tabs;
      group.fixtureGroup = true;
      closing.closing = true;
      controller._scheduleGroupCleanup([
        target,
        group,
        target,
        closing,
        { documentGlobal: {} },
      ]);
      for (let i = 0; i < 8; i++) {
        controller._scheduleAllGroupCleanup(1000);
      }
      lateGroup.fixtureGroup = true;
      controller._scheduleGroupCleanup([target], 100);
      is(counts.groupURLReads, 0, "No eager scan while accumulating work");
      is(timers.size, 1, "Targeted and full cleanup share one timer");
      fixture.flushTimers();
      is(counts.groupURLReads, 7, "Scan the current live tabs once");
      is(counts.cleanupCalls, 1, "Clean the combined candidate set once");
      is(cleanupBatches[0].length, 3, "Candidates are deduplicated");
      for (const tab of [target, group, lateGroup]) {
        ok(cleanupBatches[0].includes(tab), "Preserve each cleanup candidate");
      }

      fixture.resetCounts();
      controller._scheduleAllGroupCleanup();
      controller._scheduleGroupCleanup([target]);
      fixture.win.gBrowser.tabContainer.verticalMode = false;
      fixture.flushTimers();
      is(
        counts.groupURLReads,
        0,
        "Recheck active mode before the deferred scan"
      );
      is(counts.cleanupCalls, 0, "Do not clean groups after leaving tree mode");
      is(controller._groupCleanupTabs.size, 0, "Discard inactive pending work");
      ok(!controller._groupCleanupScanAll, "Clear the deferred full-scan flag");

      fixture.win.gBrowser.tabContainer.verticalMode = true;
      controller._scheduleGroupCleanup([target]);
      fixture.flushTimers();
      is(
        counts.groupURLReads,
        0,
        "Targeted cleanup does not inherit an old scan"
      );
      is(counts.cleanupCalls, 1, "Targeted cleanup resumes in active mode");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_split_restore_refreshes_only_relevant_work() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF_TREE_ENABLED, true]] });
  try {
    withRestoreWorkFixture(32, {}, fixture => {
      const { controller, tabs, counts } = fixture;
      const merges = [];
      const transfers = [];
      const removals = [];
      controller._mergeSplitTreeLinks = (...args) => merges.push(args);
      controller._transferTreeLinks = (...args) => transfers.push(args);
      controller._handleSplitViewRemoved = (...args) => removals.push(args);
      const wrapper = { tabs: [tabs[0], tabs[1]] };
      controller._tabContainer.allSplitViews = [wrapper];
      fixture.notify();
      is(counts.rowUpdates, tabs.length, "Discovering a split refreshes rows");
      is(merges.length, 1, "A newly discovered secondary pane is normalized");
      fixture.flushTimers();
      fixture.resetCounts();
      merges.length = 0;

      for (let i = 0; i < tabs.length; i++) {
        fixture.notify();
      }
      fixture.flushTimers();

      is(
        counts.rowUpdates,
        0,
        "Unrelated restores leave an unchanged split alone"
      );
      is(merges.length, 0, "Do not repeatedly normalize unchanged panes");

      wrapper.tabs.reverse();
      fixture.notify();
      Assert.deepEqual(
        transfers,
        [[tabs[0], tabs[1]]],
        "Transfer a reordered owner"
      );
      is(counts.rowUpdates, tabs.length, "An owner change refreshes rows");
      fixture.flushTimers();
      fixture.resetCounts();

      wrapper.tabs = [tabs[1], tabs[2]];
      fixture.notify();
      is(counts.rowUpdates, tabs.length, "A changed companion refreshes rows");
      Assert.deepEqual(
        merges.at(-1),
        [tabs[1], tabs[2]],
        "Normalize the new companion"
      );
      fixture.flushTimers();
      fixture.resetCounts();

      fixture.notify(tabs[2]);
      is(
        counts.rowUpdates,
        0,
        "A pane restore with no new tree links needs no tree projection"
      );
      fixture.flushTimers();
      fixture.resetCounts();

      controller._tabContainer.allSplitViews = [];
      fixture.notify();
      is(removals.length, 1, "Process removal of the last split wrapper");
      is(
        counts.rowUpdates,
        tabs.length,
        "Removing the last split refreshes rows"
      );
      is(controller._splitViewMains.size, 0, "Forget the removed split owner");
      is(controller._splitViewPanes.size, 0, "Forget the removed split panes");
      fixture.flushTimers();
      fixture.resetCounts();

      fixture.notify();
      is(counts.rowUpdates, 0, "Later flat restores do not refresh rows");
      ok(
        !controller._syncSplitViewTrees(),
        "Flat split normalization reports no changes"
      );
      is(counts.rowUpdates, 0, "Normalization does not own the final render");
      fixture.flushTimers();
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_late_split_tree_links_still_normalize() {
  await enableTreeTabs();
  const tabs = [];
  let splitView;
  try {
    Services.prefs.setBoolPref(PREF_TREE_AUTO_COLLAPSE_ON_SELECT, false);
    for (let i = 0; i < 3; i++) {
      const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
      tabs.push(tab);
      TreeTabsService.detachTab(tab);
    }
    const [main, secondary, child] = tabs;
    const created = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "SplitViewCreated"
    );
    splitView = gBrowser.addTabSplitView([main, secondary]);
    await created;
    const controller = TreeTabsUI._controllers.get(window);
    await waitForTreeCondition(
      () => controller._splitViewMains.get(splitView) == main,
      "Waiting for the split owner to be recorded"
    );

    ok(
      TreeTabsService.attachTab(child, secondary),
      "Restore a late secondary child"
    );
    controller.handleEvent({ type: "SSTabRestored", target: child });
    is(
      TreeTabsService.getParent(child),
      main,
      "Normalize late tree links even when pane membership has not changed"
    );
    is(
      TreeTabsService.getChildren(secondary).length,
      0,
      "Clear the companion tree"
    );
    is(
      child.dataset.treeLevel,
      "1",
      "The late restored child receives its rendered tree level"
    );
    is(
      splitView.dataset.treeLevel,
      main.dataset.treeLevel,
      "The wrapper still mirrors the main pane's rendered tree level"
    );
    TreeTabsService.collapseSubtree(main);
    child.label = "Late split descendant title";
    controller._handleTabAttrModified({
      target: child,
      detail: { changed: ["label"] },
    });
    ok(
      main._treeDescendantsTooltip.includes(child.label),
      "A label-only update refreshes the shared row's tooltip"
    );
    is(
      secondary._treeDescendantsTooltip,
      main._treeDescendantsTooltip,
      "The secondary pane receives the same updated tooltip"
    );
  } finally {
    if (splitView?.isConnected) {
      const removed = BrowserTestUtils.waitForEvent(
        gBrowser.tabContainer,
        "SplitViewRemoved"
      );
      splitView.unsplitTabs();
      await removed;
    }
    for (const tab of tabs.reverse()) {
      if (!tab.closing && gBrowser.tabs.includes(tab)) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
    await disableTreeTabs({ strict: false });
    clearTreeTestPrefs();
  }
});

add_task(async function test_real_window_restore_has_one_final_projection() {
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
  const win = await BrowserTestUtils.openNewBrowserWindow();
  const browser = win.gBrowser;
  const controller = TreeTabsUI._controllers.get(win);
  const box = win.document.getElementById("vertical-tabs");
  const originalRestoring = TreeTabsStore.onWindowRestoring;
  const originalRect = box.getBoundingClientRect;
  const originals = new Map();
  let counts;
  let completed;
  let projecting = false;
  const onRestored = () => {
    completed = counts;
    counts = null;
  };
  try {
    TreeTabsStore.onWindowRestoring = function (target) {
      if (target == win) {
        counts = { full: 0, rows: 0, hidden: 0, measurements: 0 };
      }
      return originalRestoring.call(this, target);
    };
    box.getBoundingClientRect = function () {
      if (counts && projecting) {
        counts.measurements++;
      }
      return originalRect.call(this);
    };
    for (const [method, counter] of [
      ["_updateAllTabs", "full"],
      ["_updateTab", "rows"],
      ["_updateHiddenTabs", "hidden"],
    ]) {
      const original = controller[method];
      originals.set(method, original);
      controller[method] = function (...args) {
        const wasProjecting = projecting;
        if (counts && !this._deferringTreeRender && !this._isWindowRestoring) {
          counts[counter]++;
          projecting = true;
        }
        try {
          return original.apply(this, args);
        } finally {
          projecting = wasProjecting;
        }
      };
    }
    win.addEventListener("SSWindowRestored", onRestored, true);
    for (const tabCount of [8, 32]) {
      const structure = Array.from({ length: tabCount }, (_, index) => ({
        id: `bounded-restore-${tabCount}-${index}`,
        parent: index % 2 ? index - 1 : null,
        collapsed: index % 2 == 0,
      }));
      const restored = BrowserTestUtils.waitForEvent(win, "SSWindowRestored");
      SessionStore.setWindowState(
        win,
        JSON.stringify({
          windows: [
            {
              tabs: structure.map((entry, index) => ({
                entries: [{ url: `about:blank#${entry.id}` }],
                index: 1,
                ...(index >= tabCount / 2 ? { groupId: "bounded-group" } : {}),
                extData: {
                  "treeTabs:data-persistent-id": JSON.stringify(entry.id),
                },
              })),
              selected: 1,
              groups: [
                {
                  id: "bounded-group",
                  name: "Lazy restored trees",
                  color: "blue",
                  collapsed: false,
                },
              ],
              extData: { "treeTabs:tree-structure": JSON.stringify(structure) },
            },
          ],
        }),
        true
      );
      await restored;
      is(completed.full, 1, "The real restore pipeline has one final render");
      is(completed.rows, tabCount, "Each restored row is projected once");
      is(
        completed.hidden,
        1,
        "Visibility is projected once at restore completion"
      );
      is(completed.measurements, 1, "The final render shares one measurement");
      for (let index = 1; index < tabCount; index += 2) {
        const parent = browser.tabs[index - 1];
        const child = browser.tabs[index];
        is(
          TreeTabsService.getParent(child),
          parent,
          "The real stored link restores"
        );
        is(
          child.dataset.treeHidden,
          "true",
          "Restored visibility is synchronous"
        );
        is(
          parent.getAttribute("aria-expanded"),
          "false",
          "Disclosure state restores"
        );
      }
      ok(browser.tabs.at(-1).group, "Lazy children keep their native group");
      ok(
        browser.tabs.at(-1).hasAttribute("pending"),
        "The last child stays lazy"
      );
    }
  } finally {
    counts = null;
    TreeTabsStore.onWindowRestoring = originalRestoring;
    box.getBoundingClientRect = originalRect;
    for (const [method, original] of originals) {
      controller[method] = original;
    }
    win.removeEventListener("SSWindowRestored", onRestored, true);
    await BrowserTestUtils.closeWindow(win);
    await SpecialPowers.popPrefEnv();
  }
});
