/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TreeTabsUI } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsUI.sys.mjs"
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.groups.enabled", true],
      ["browser.tabs.verticalTabs.tree.expandNativeGroupOnTreeExpand", true],
    ],
  });
});

function getTreeTabsController() {
  const controller = TreeTabsUI._controllers.get(window);
  ok(controller, "Tree tabs controller is available for the browser window");
  return controller;
}

function createNativeGroupTarget(name) {
  const targetTab = BrowserTestUtils.addTab(
    gBrowser,
    `about:blank?tree-native-group-${name}`
  );
  gBrowser.TreeTabsService.detachTab(targetTab);
  const group = gBrowser.addTabGroup([targetTab], {
    label: `Tree tabs ${name}`,
  });
  ok(group, "Native tab group was created");
  return { group, targetTab };
}

async function cleanupNativeGroupTabs(group, tabs) {
  if (group?.isConnected && group.collapsed) {
    group.collapsed = false;
  }

  for (const tab of [...new Set(tabs)].reverse()) {
    if (tab && gBrowser.tabs.includes(tab) && !tab.closing) {
      await BrowserTestUtils.removeTab(tab);
    }
  }

  if (group?.isConnected) {
    await waitForTreeCondition(
      () => !group.isConnected,
      "Waiting for native tab group cleanup"
    );
  }
}

add_task(async function test_dropped_links_open_as_grouped_tree_children() {
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_AUTO_ATTACH, 0);

  const controller = getTreeTabsController();
  const { group, targetTab } = createNativeGroupTarget("children");
  const openedTabs = [];

  try {
    const existingTabs = new Set(gBrowser.tabs);
    const urls = [
      "about:blank?tree-native-group-child-1",
      "about:blank?tree-native-group-child-2",
    ];

    await controller._openDroppedLinksOnTab({
      behavior: 2,
      inBackground: true,
      policyContainer: null,
      targetGroup: group,
      targetTab,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      urls,
    });

    await waitForTreeCondition(
      () =>
        gBrowser.tabs.filter(tab => !existingTabs.has(tab)).length ==
        urls.length,
      "Waiting for dropped links to open"
    );
    openedTabs.push(...gBrowser.tabs.filter(tab => !existingTabs.has(tab)));
    await waitForTreeCondition(
      () =>
        openedTabs.every(
          tab => getTreeParent(tab) == targetTab && tab.group == group
        ),
      "Waiting for dropped links to join the tree and native group"
    );

    is(openedTabs.length, urls.length, "Both dropped links opened in new tabs");
    is(
      gBrowser.TreeTabsService.getChildren(targetTab).length,
      urls.length,
      "Target tab owns both dropped links as tree children"
    );
    for (const tab of openedTabs) {
      is(getTreeParent(tab), targetTab, "Dropped link is a tree child");
      is(tab.group, group, "Dropped link remains in the native group");
      ok(group.tabs.includes(tab), "Native group lists the dropped link tab");
    }
  } finally {
    await cleanupNativeGroupTabs(group, [targetTab, ...openedTabs]);
  }
});

add_task(async function test_replacement_drop_extras_remain_grouped() {
  await enableTreeTabs();

  const controller = getTreeTabsController();
  const { group, targetTab } = createNativeGroupTarget("replace");
  const extraTabs = [];

  try {
    const existingTabs = new Set(gBrowser.tabs);
    const urls = [
      "data:text/plain,tree-native-group-replacement",
      "data:text/plain,tree-native-group-replacement-extra",
    ];
    const targetLoaded = BrowserTestUtils.browserLoaded(
      targetTab.linkedBrowser,
      false,
      urls[0]
    );

    await controller._openDroppedLinksOnTab({
      behavior: 0,
      inBackground: true,
      policyContainer: null,
      targetGroup: group,
      targetTab,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      urls,
    });
    await targetLoaded;

    await waitForTreeCondition(
      () =>
        gBrowser.tabs.filter(tab => !existingTabs.has(tab)).length ==
        urls.length - 1,
      "Waiting for replacement drop extras to open"
    );
    extraTabs.push(...gBrowser.tabs.filter(tab => !existingTabs.has(tab)));

    is(
      targetTab.linkedBrowser.currentURI.spec,
      urls[0],
      "First dropped URL replaces the target tab"
    );
    is(extraTabs.length, 1, "Second dropped URL opens one extra tab");
    is(
      targetTab.group,
      group,
      "Replacement target remains in its native group"
    );
    for (const tab of extraTabs) {
      is(tab.group, group, "Replacement extra remains in the native group");
      ok(group.tabs.includes(tab), "Native group lists the replacement extra");
    }
  } finally {
    await cleanupNativeGroupTabs(group, [targetTab, ...extraTabs]);
  }
});

add_task(async function test_tree_expand_expands_native_group() {
  await enableTreeTabs();

  const outsideTab = gBrowser.selectedTab;
  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?tree-native-group-expand-parent"
  );
  gBrowser.TreeTabsService.detachTab(parentTab);
  const childTab = await openTabWithTree(
    parentTab,
    "about:blank?tree-native-group-expand-child"
  );
  const group = gBrowser.addTabGroup([parentTab, childTab], {
    label: "Tree expand",
  });

  try {
    await waitForTreeCondition(
      () => getTreeParent(childTab) == parentTab,
      "Waiting for grouped tabs to retain their tree relationship"
    );
    await BrowserTestUtils.switchTab(gBrowser, outsideTab);

    gBrowser.TreeTabsService.collapseSubtree(parentTab);
    await waitForTreeCondition(
      () => gBrowser.TreeTabsService.isCollapsed(parentTab),
      "Waiting for member tree to collapse"
    );

    const groupCollapsed = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupCollapse"
    );
    group.collapsed = true;
    await groupCollapsed;

    const groupExpanded = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupExpand"
    );
    gBrowser.TreeTabsService.expandSubtree(parentTab);
    await groupExpanded;

    ok(
      !gBrowser.TreeTabsService.isCollapsed(parentTab),
      "Member tree is expanded"
    );
    ok(!group.collapsed, "Expanding a member tree expands its native group");
  } finally {
    await cleanupNativeGroupTabs(group, [parentTab, childTab]);
  }
});

add_task(async function test_collapsed_group_uses_only_native_counter() {
  await enableTreeTabs();

  const outsideTab = gBrowser.selectedTab;
  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?tree-native-group-counter-parent"
  );
  gBrowser.TreeTabsService.detachTab(parentTab);
  const childTab = await openTabWithTree(
    parentTab,
    "about:blank?tree-native-group-counter-child"
  );
  const group = gBrowser.addTabGroup([parentTab, childTab], {
    label: "Tree counter",
  });

  try {
    gBrowser.TreeTabsService.collapseSubtree(parentTab);
    if (gBrowser.selectedTab != parentTab) {
      await BrowserTestUtils.switchTab(gBrowser, parentTab);
    }

    const groupCollapsed = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupCollapse"
    );
    group.collapsed = true;
    await groupCollapsed;
    await waitForTreeCondition(
      () =>
        window.getComputedStyle(
          parentTab.querySelector(".tab-content"),
          "::before"
        ).content == "none",
      "Waiting for the tree counter to yield to the native group counter"
    );

    is(
      parentTab
        .querySelector(".tab-content")
        ?.getAttribute("data-tree-counter"),
      "1",
      "The logical descendant count remains available"
    );
    is(
      window.getComputedStyle(
        parentTab.querySelector(".tab-content"),
        "::before"
      ).content,
      "none",
      "The tree count is not rendered beside the native group count"
    );
    is(
      window.getComputedStyle(group.overflowContainer).display,
      "flex",
      "The native group count remains visible"
    );
  } finally {
    if (gBrowser.selectedTab != outsideTab) {
      await BrowserTestUtils.switchTab(gBrowser, outsideTab);
    }
    await cleanupNativeGroupTabs(group, [parentTab, childTab]);
  }
});

add_task(async function test_native_groups_reject_cross_group_tree_edges() {
  await enableTreeTabs();

  const first = createNativeGroupTarget("cross-edge-parent");
  const second = createNativeGroupTarget("cross-edge-child");

  try {
    ok(
      !gBrowser.TreeTabsService.attachTab(second.targetTab, first.targetTab),
      "Attaching tabs across native group boundaries is rejected"
    );
    is(
      getTreeParent(second.targetTab),
      null,
      "Rejected cross-group attachment leaves the tab detached"
    );

    second.targetTab.openerTab = first.targetTab;
    gBrowser._tabAttrModified(second.targetTab, ["openerTab"]);
    await waitForTreeUpdate();
    is(
      getTreeParent(second.targetTab),
      null,
      "Cross-group opener synchronization does not create a tree edge"
    );
  } finally {
    await cleanupNativeGroupTabs(first.group, [first.targetTab]);
    await cleanupNativeGroupTabs(second.group, [second.targetTab]);
  }
});

add_task(async function test_drag_auto_expanded_native_group_is_restored() {
  await enableTreeTabs();

  const controller = getTreeTabsController();
  const { group, targetTab } = createNativeGroupTarget("drag-restore");

  try {
    const groupCollapsed = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupCollapse"
    );
    group.collapsed = true;
    await groupCollapsed;

    controller._dragAutoExpandedGroups.add(group);
    const groupExpanded = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupExpand"
    );
    group.collapsed = false;
    await groupExpanded;

    const groupRecollapsed = BrowserTestUtils.waitForEvent(
      group,
      "TabGroupCollapse"
    );
    controller._restoreDragAutoExpandedTabs();
    await groupRecollapsed;

    ok(group.collapsed, "Drag-auto-expanded native group is re-collapsed");
    ok(
      !controller._dragAutoExpandedGroups.has(group),
      "Restored native group is removed from the drag expansion set"
    );
  } finally {
    controller._dragAutoExpandedGroups.delete(group);
    await cleanupNativeGroupTabs(group, [targetTab]);
  }
});
