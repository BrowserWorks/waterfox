/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { GROUP_TAB_URL, TreeTabsGroups } = ChromeUtils.importESModule(
  "resource:///modules/TreeTabsGroups.sys.mjs"
);

function createLoadedTab(spec) {
  let loadedSpec = null;
  let loadOptions = null;
  const linkedBrowser = {
    currentURI: { spec },
    loadURI(uri, options) {
      loadedSpec = uri.spec;
      loadOptions = options;
      this.currentURI = uri;
    },
  };
  return {
    tab: {
      closing: false,
      pinned: false,
      linkedBrowser,
    },
    get loadedSpec() {
      return loadedSpec;
    },
    get loadOptions() {
      return loadOptions;
    },
  };
}

add_task(function test_inactive_groups_do_not_create_or_remove_tabs() {
  const { TreeTabsService } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsService.sys.mjs"
  );
  const { TreeTabsStore } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsStore.sys.mjs"
  );
  Services.prefs.setBoolPref(TREE_PREF_ENABLED, true);
  const window = createMockWindow();
  window.gBrowser.tabContainer = { verticalMode: false };
  window.gBrowser.addTrustedTab = () => {
    Assert.ok(false, "Inactive grouping must not create a group page");
  };
  const group = createMockTab(window);
  group.linkedBrowser = createLoadedTab(
    TreeTabsGroups.makeGroupTabURI({ temporary: true })
  ).tab.linkedBrowser;
  TreeTabsService.init(window);
  const removed = [];
  window.gBrowser.removeTab = tab => removed.push(tab);
  try {
    Assert.equal(TreeTabsGroups.groupTabs(window, [group]), null);
    TreeTabsGroups.cleanupNeedlessGroupTabs(window, [group]);
    Assert.equal(removed.length, 0, "Horizontal mode retains existing groups");

    window.gBrowser.tabContainer.verticalMode = true;
    TreeTabsStore.ensureRestoreGuard(window);
    TreeTabsGroups.cleanupNeedlessGroupTabs(window, [group]);
    Assert.equal(removed.length, 0, "Restoring groups are not assumed empty");
    TreeTabsStore.clearRestoreGuard(window);
    TreeTabsGroups.cleanupNeedlessGroupTabs(window, [group]);
    Assert.equal(removed.length, 1, "Cleanup resumes after restoration");
  } finally {
    TreeTabsStore.clearRestoreGuard(window);
    TreeTabsService.uninit(window);
    resetTreeTestPrefs();
  }
});

add_task(function test_group_tab_uses_packaged_page() {
  Assert.equal(
    GROUP_TAB_URL,
    "chrome://browser/content/treegroup/group-tab.xhtml",
    "Group tabs use the packaged page directly"
  );
});

add_task(function test_make_group_tab_uri_serializes_parameters() {
  const spec = TreeTabsGroups.makeGroupTabURI({
    title: "Pinned & related",
    temporary: true,
    temporaryAggressive: true,
    openerGuid: "opener-guid",
    aliasGuid: "alias-guid",
    replacedParentCount: 2,
  });
  const params = new URL(spec).searchParams;

  Assert.ok(spec.startsWith(`${GROUP_TAB_URL}?`), "Uses the group tab URL");
  Assert.equal(params.get("title"), "Pinned & related", "Serializes title");
  Assert.ok(
    !params.has("temporary"),
    "Aggressive temporary state takes precedence"
  );
  Assert.equal(
    params.get("temporaryAggressive"),
    "true",
    "Serializes aggressive temporary state"
  );
  Assert.equal(params.get("openerGuid"), "opener-guid", "Serializes opener");
  Assert.equal(params.get("aliasGuid"), "alias-guid", "Serializes alias");
  Assert.equal(
    params.get("replacedParentCount"),
    "2",
    "Serializes replacement count"
  );

  Assert.equal(
    TreeTabsGroups.makeGroupTabURI(),
    GROUP_TAB_URL,
    "Omits the query string when no state is supplied"
  );
  Assert.ok(
    !new URL(
      TreeTabsGroups.makeGroupTabURI({ temporary: true })
    ).searchParams.has("title"),
    "Allows an automatic group to omit a persisted title"
  );
});

add_task(function test_group_tab_uri_state_is_parsed_from_tab_stub() {
  const passive = createLoadedTab(
    TreeTabsGroups.makeGroupTabURI({
      title: "Group",
      temporary: true,
      openerGuid: "opener-guid",
      aliasGuid: "alias-guid",
      replacedParentCount: 3,
    })
  ).tab;
  const aggressive = createLoadedTab(
    TreeTabsGroups.makeGroupTabURI({ temporaryAggressive: true })
  ).tab;
  const ordinary = createLoadedTab("https://example.com/").tab;

  Assert.ok(TreeTabsGroups.isGroupTab(passive), "Recognizes a group tab");
  Assert.equal(
    TreeTabsGroups.getTemporaryState(passive),
    1,
    "Parses passive temporary state"
  );
  Assert.equal(
    TreeTabsGroups.getTemporaryState(aggressive),
    2,
    "Parses aggressive temporary state"
  );
  Assert.equal(
    TreeTabsGroups.getReplacedParentCount(passive),
    3,
    "Parses replacement count"
  );
  Assert.equal(
    TreeTabsGroups.getOpenerGuid(passive),
    "opener-guid",
    "Parses opener GUID"
  );
  Assert.equal(
    TreeTabsGroups.getAliasGuid(passive),
    "alias-guid",
    "Parses alias GUID"
  );
  Assert.equal(
    TreeTabsGroups.getTemporaryState(ordinary),
    0,
    "Ordinary tabs have permanent state"
  );
  Assert.equal(
    TreeTabsGroups.getAliasGuid(ordinary),
    null,
    "Ordinary tabs have no alias"
  );
});

add_task(function test_find_group_tab_for_opener_only_returns_group_tabs() {
  const ordinary = createLoadedTab("https://example.com/").tab;
  const pinned = createLoadedTab(
    TreeTabsGroups.makeGroupTabURI({ openerGuid: "opener-guid" })
  ).tab;
  pinned.pinned = true;
  const group = createLoadedTab(
    TreeTabsGroups.makeGroupTabURI({ openerGuid: "opener-guid" })
  ).tab;
  const window = { gBrowser: { tabs: [ordinary, pinned, group] } };

  Assert.equal(
    TreeTabsGroups.findGroupTabForOpener(window, "opener-guid"),
    group,
    "Returns the living unpinned group tab"
  );
  Assert.equal(
    TreeTabsGroups.findGroupTabForOpener(window, null),
    null,
    "Requires an opener GUID"
  );
});

add_task(function test_update_group_tab_uri_preserves_unrelated_state() {
  const stub = createLoadedTab(
    TreeTabsGroups.makeGroupTabURI({
      title: "Original",
      temporary: true,
      openerGuid: "opener-guid",
      replacedParentCount: 4,
    })
  );

  const updatedSpec = TreeTabsGroups.updateGroupTabURI(stub.tab, {
    title: "Updated",
    temporary: null,
    temporaryAggressive: true,
    aliasGuid: "alias-guid",
  });
  const params = new URL(updatedSpec).searchParams;

  Assert.equal(stub.loadedSpec, updatedSpec, "Loads the updated URI");
  Assert.ok(
    stub.loadOptions.triggeringPrincipal,
    "Uses a triggering principal"
  );
  Assert.equal(params.get("title"), "Updated", "Updates title");
  Assert.ok(!params.has("temporary"), "Removes requested state");
  Assert.equal(
    params.get("temporaryAggressive"),
    "true",
    "Adds requested state"
  );
  Assert.equal(params.get("aliasGuid"), "alias-guid", "Adds alias state");
  Assert.equal(
    params.get("openerGuid"),
    "opener-guid",
    "Preserves opener state"
  );
  Assert.equal(
    params.get("replacedParentCount"),
    "4",
    "Preserves replacement state"
  );

  const withoutAlias = TreeTabsGroups.setAliasGuid(stub.tab, null);
  Assert.ok(
    !new URL(withoutAlias).searchParams.has("aliasGuid"),
    "The alias setter can clear alias state"
  );
});

add_task(function test_clear_temporary_state_uses_uri_update() {
  const stub = createLoadedTab(
    TreeTabsGroups.makeGroupTabURI({
      title: "Persistent title",
      temporaryAggressive: true,
      openerGuid: "opener-guid",
      aliasGuid: "alias-guid",
    })
  );

  const updatedSpec = TreeTabsGroups.clearTemporaryState(stub.tab);
  const params = new URL(updatedSpec).searchParams;

  Assert.ok(!params.has("temporary"), "Removes passive temporary state");
  Assert.ok(
    !params.has("temporaryAggressive"),
    "Removes aggressive temporary state"
  );
  Assert.equal(
    params.get("title"),
    "Persistent title",
    "Preserves an explicit title"
  );
  Assert.equal(params.get("openerGuid"), "opener-guid", "Preserves opener");
  Assert.equal(params.get("aliasGuid"), "alias-guid", "Preserves alias");
});
