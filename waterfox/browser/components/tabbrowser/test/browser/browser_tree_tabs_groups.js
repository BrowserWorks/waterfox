/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { GROUP_TAB_URL, TreeTabsGroups } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsGroups.sys.mjs"
);
const { TreeTabsStore } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsStore.sys.mjs"
);

const PREF_TREE_AUTO_GROUP_PINNED_OPENER =
  "browser.tabs.verticalTabs.tree.autoGroup.pinnedOpener";
const SYSTEM_PRINCIPAL = Services.scriptSecurityManager.getSystemPrincipal();

function getTreeGroupTabs() {
  return Array.from(gBrowser.tabs).filter(tab =>
    TreeTabsGroups.isGroupTab(tab)
  );
}

async function cleanupGroupTestTabs(originalTabs) {
  if (Services.prefs.getBoolPref(PREF_TREE_ENABLED, false)) {
    await disableTreeTabs({ strict: false });
  }

  const tabsToRemove = Array.from(gBrowser.tabs).filter(
    tab => !originalTabs.has(tab)
  );
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
    "Waiting for group test tabs to close"
  );
  clearTreeTestPrefs();
}

add_task(async function test_close_parent_replaced_by_aggressive_group() {
  const originalTabs = new Set(gBrowser.tabs);
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_CLOSE_PARENT_BEHAVIOR, 4);

  try {
    const parentTitle = "Parent replaced by group";
    const parentTab = BrowserTestUtils.addTab(gBrowser, "about:blank", {
      skipAnimation: true,
      triggeringPrincipal: SYSTEM_PRINCIPAL,
    });
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
    const childA = await openTabWithTree(parentTab);
    const childB = await openTabWithTree(parentTab);

    parentTab.label = parentTitle;
    gBrowser.TreeTabsService.expandSubtree(parentTab);
    ok(
      !gBrowser.TreeTabsService.isCollapsed(parentTab),
      "Parent is expanded before it closes"
    );

    const tabCountBeforeClose = gBrowser.tabs.length;
    BrowserTestUtils.removeTab(parentTab, { isUserTriggered: true });

    await waitForTreeCondition(() => {
      const groupTabs = getTreeGroupTabs();
      return (
        !gBrowser.tabs.includes(parentTab) &&
        groupTabs.length == 1 &&
        getTreeParent(childA) == groupTabs[0] &&
        getTreeParent(childB) == groupTabs[0]
      );
    }, "Waiting for the replacement group");

    const [groupTab] = getTreeGroupTabs();
    const children = gBrowser.TreeTabsService.getChildren(groupTab);
    const groupURL = new URL(TreeTabsGroups.getTabURL(groupTab));

    is(
      gBrowser.tabs.length,
      tabCountBeforeClose,
      "Replacing the parent keeps the tab count unchanged"
    );
    is(
      TreeTabsGroups.getTemporaryState(groupTab),
      2,
      "Replacement group is aggressively temporary"
    );
    is(
      groupURL.searchParams.get("title"),
      parentTitle,
      "Replacement group preserves the parent title"
    );
    is(
      TreeTabsGroups.getReplacedParentCount(groupTab),
      1,
      "Replacement group records one replaced parent"
    );
    is(children.length, 2, "Replacement group keeps both children");
    is(children[0], childA, "First child keeps its position");
    is(children[1], childB, "Second child keeps its position");
    is(getTreeParent(groupTab), null, "Replacement group remains a root");
    is(childA._tPos, groupTab._tPos + 1, "First child follows the group");
    is(childB._tPos, childA._tPos + 1, "Second child follows first child");

    const tabCountBeforeChildClose = gBrowser.tabs.length;
    BrowserTestUtils.removeTab(childA, { isUserTriggered: true });

    await waitForTreeCondition(
      () =>
        !gBrowser.tabs.includes(childA) &&
        !gBrowser.tabs.includes(groupTab) &&
        gBrowser.tabs.includes(childB) &&
        getTreeParent(childB) == null,
      "Waiting for aggressive replacement group cleanup"
    );

    is(getTreeGroupTabs().length, 0, "Only the replacement group is removed");
    ok(gBrowser.tabs.includes(childB), "The remaining child stays open");
    is(getTreeParent(childB), null, "The remaining child is promoted to root");
    is(
      gBrowser.tabs.length,
      tabCountBeforeChildClose - 2,
      "Closing one child removes that child and the needless group"
    );
  } finally {
    await cleanupGroupTestTabs(originalTabs);
  }
});

add_task(async function test_group_page_title_uses_chrome_url() {
  const originalTabs = new Set(gBrowser.tabs);
  await enableTreeTabs();

  try {
    const first = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?group-page-first"
    );
    const second = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?group-page-second"
    );
    const groupTitle = "Edited native tree group";
    const groupTab = TreeTabsGroups.groupTabs(window, [first, second], {
      temporary: false,
      title: groupTitle,
    });
    ok(groupTab, "A permanent group tab was created");
    if (gBrowser.selectedTab != groupTab) {
      await BrowserTestUtils.switchTab(gBrowser, groupTab);
    }
    await waitForTreeCondition(
      () =>
        groupTab.linkedBrowser.currentURI.spec.startsWith(GROUP_TAB_URL) &&
        !groupTab.hasAttribute("busy"),
      "Waiting for the group page to load"
    );

    is(
      new URL(TreeTabsGroups.getTabURL(groupTab)).searchParams.get("title"),
      groupTitle,
      "The group title is encoded in the packaged group page URL"
    );
  } finally {
    await cleanupGroupTestTabs(originalTabs);
  }
});

add_task(async function test_pinned_opener_reuses_passive_group() {
  const originalTabs = new Set(gBrowser.tabs);
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [
      [PREF_TREE_AUTO_ATTACH, 1],
      [PREF_TREE_AUTO_GROUP_PINNED_OPENER, true],
    ],
  });

  try {
    const openerTab = BrowserTestUtils.addTab(gBrowser, "about:blank", {
      skipAnimation: true,
      triggeringPrincipal: SYSTEM_PRINCIPAL,
    });
    gBrowser.pinTab(openerTab);
    ok(openerTab.pinned, "Related tabs share a pinned opener");

    const relatedA = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?tree-related-a",
      {
        openerBrowser: openerTab.linkedBrowser,
        skipAnimation: true,
        triggeringPrincipal: SYSTEM_PRINCIPAL,
      }
    );

    is(getTreeGroupTabs().length, 0, "One related tab is not wrapped");
    is(getTreeParent(relatedA), null, "First related tab starts as a root");

    const relatedB = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?tree-related-b",
      {
        openerBrowser: openerTab.linkedBrowser,
        skipAnimation: true,
        triggeringPrincipal: SYSTEM_PRINCIPAL,
      }
    );

    await waitForTreeCondition(() => {
      const groupTabs = getTreeGroupTabs();
      return (
        groupTabs.length == 1 &&
        getTreeParent(relatedA) == groupTabs[0] &&
        getTreeParent(relatedB) == groupTabs[0]
      );
    }, "Waiting for related tabs to share a group");

    const [groupTab] = getTreeGroupTabs();
    const openerGuid = TreeTabsStore.getTabGuid(openerTab);
    let children = gBrowser.TreeTabsService.getChildren(groupTab);

    ok(openerGuid, "Pinned opener has a persistent tree tab ID");
    is(
      TreeTabsGroups.getTemporaryState(groupTab),
      1,
      "Pinned-opener group is passively temporary"
    );
    is(
      TreeTabsGroups.getOpenerGuid(groupTab),
      openerGuid,
      "Group records the pinned opener"
    );
    is(
      TreeTabsGroups.findGroupTabForOpener(window, openerGuid),
      groupTab,
      "Pinned opener resolves to the created group"
    );
    is(children.length, 2, "Exactly two related tabs are grouped");
    is(children[0], relatedA, "First related tab keeps its order");
    is(children[1], relatedB, "Second related tab keeps its order");

    const relatedC = BrowserTestUtils.addTab(
      gBrowser,
      "about:blank?tree-related-c",
      {
        openerBrowser: openerTab.linkedBrowser,
        skipAnimation: true,
        triggeringPrincipal: SYSTEM_PRINCIPAL,
      }
    );

    await waitForTreeCondition(() => {
      const groupTabs = getTreeGroupTabs();
      return (
        groupTabs.length == 1 &&
        groupTabs[0] == groupTab &&
        getTreeParent(relatedC) == groupTab &&
        gBrowser.TreeTabsService.getChildren(groupTab).length == 3
      );
    }, "Waiting for the third related tab to reuse the group");

    children = gBrowser.TreeTabsService.getChildren(groupTab);
    is(getTreeGroupTabs().length, 1, "Only one related-tab group exists");
    is(children[0], relatedA, "First related tab remains first");
    is(children[1], relatedB, "Second related tab remains second");
    is(children[2], relatedC, "Third related tab joins the existing group");
  } finally {
    try {
      await cleanupGroupTestTabs(originalTabs);
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});
