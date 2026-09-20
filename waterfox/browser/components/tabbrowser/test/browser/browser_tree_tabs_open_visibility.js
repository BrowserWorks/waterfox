/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* global browser */

function assertBackgroundRootVisible(tab, selectedTab) {
  is(
    gBrowser.selectedTab,
    selectedTab,
    "Opening the tab does not change focus"
  );
  ok(!isTreeHidden(tab), "The first background tab is not hidden by the tree");
  ok(tab.visible, "The first background tab is logically visible");
  ok(
    gBrowser.visibleTabs.includes(tab),
    "The visible-tabs cache includes the first background tab"
  );
  ok(BrowserTestUtils.isVisible(tab), "The first background tab is rendered");
  const rect = tab.getBoundingClientRect();
  ok(rect.width > 0 && rect.height > 0, "The tab has a nonempty rendered row");
  is(tab.getAttribute("data-tree-level"), "0", "The root level is initialized");
  is(getTreeParent(tab), null, "The background tab is a root");
}

add_task(async function test_first_background_tab_from_pinned_opener() {
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_AUTO_ATTACH, 1);

  const opener = gBrowser.selectedTab;
  gBrowser.pinTab(opener);
  try {
    for (const autoGroup of [true, false]) {
      info(
        `Opening the first link from a pinned tab with autoGroup=${autoGroup}`
      );
      Services.prefs.setBoolPref(
        "browser.tabs.verticalTabs.tree.autoGroup.pinnedOpener",
        autoGroup
      );
      const tab = gBrowser.addTab("about:blank", {
        openerBrowser: opener.linkedBrowser,
        skipAnimation: true,
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
      try {
        // Do not wait, select another tab, or open a second link before checking.
        assertBackgroundRootVisible(tab, opener);
      } finally {
        await BrowserTestUtils.removeTab(tab);
      }
    }
  } finally {
    gBrowser.unpinTab(opener);
  }
});

add_task(async function test_first_background_root_tab() {
  await enableTreeTabs();
  const selectedTab = gBrowser.selectedTab;

  for (const autoAttach of [0, 1, 2]) {
    Services.prefs.setIntPref(PREF_TREE_AUTO_ATTACH, autoAttach);
    for (const options of [{}, { fromExternal: true }, { pinned: true }]) {
      info(
        `Opening a background root with autoAttach=${autoAttach}, options=${JSON.stringify(options)}`
      );
      const tab = gBrowser.addTab("about:blank", {
        ...options,
        skipAnimation: true,
        triggeringPrincipal:
          Services.scriptSecurityManager.getSystemPrincipal(),
      });
      try {
        assertBackgroundRootVisible(tab, selectedTab);
      } finally {
        await BrowserTestUtils.removeTab(tab);
      }
    }
  }
});

add_task(async function test_first_extension_created_tab_is_visible() {
  await enableTreeTabs();
  const selectedTab = gBrowser.selectedTab;
  const extension = ExtensionTestUtils.loadExtension({
    background() {
      browser.test.onMessage.addListener(async message => {
        if (message == "open") {
          const tab = await browser.tabs.create({
            url: "about:blank",
            active: false,
          });
          browser.test.sendMessage("opened", tab.id);
        }
      });
    },
  });
  await extension.startup();
  let tab;
  try {
    const opened = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "TabOpen"
    );
    extension.sendMessage("open");
    tab = (await opened).target;
    assertBackgroundRootVisible(tab, selectedTab);
    await extension.awaitMessage("opened");
  } finally {
    await extension.unload();
    if (tab) {
      await BrowserTestUtils.removeTab(tab);
    }
  }
});

add_task(async function test_new_root_preserves_intentionally_hidden_tabs() {
  await enableTreeTabs();
  Services.prefs.setIntPref(PREF_TREE_AUTO_ATTACH, 1);

  const parent = gBrowser.selectedTab;
  const child = gBrowser.addTab("about:blank", {
    openerBrowser: parent.linkedBrowser,
    skipAnimation: true,
    triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
  });
  let root;
  try {
    is(
      getTreeParent(child),
      parent,
      "The child is attached through tab opening"
    );
    gBrowser.TreeTabsService.collapseSubtree(parent);
    ok(isTreeHidden(child), "Collapsing the parent hides its child");

    root = gBrowser.addTab("about:blank", {
      skipAnimation: true,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    assertBackgroundRootVisible(root, parent);
    ok(isTreeHidden(child), "Opening a root leaves the collapsed child hidden");
    ok(!child.visible, "The collapsed child remains logically hidden");
    ok(BrowserTestUtils.isHidden(child), "The collapsed child is not rendered");

    gBrowser.hideTab(root);
    gBrowser.TreeTabsService.expandSubtree(parent);
    ok(
      root.hidden,
      "A tree refresh preserves the native hidden state of a root"
    );
    ok(!root.visible, "The explicitly hidden root remains logically hidden");
    ok(
      BrowserTestUtils.isHidden(root),
      "The explicitly hidden root is not rendered"
    );
    ok(!isTreeHidden(child), "Expanding the parent reveals its child");
  } finally {
    if (root) {
      await BrowserTestUtils.removeTab(root);
    }
    await BrowserTestUtils.removeTab(child);
  }
});
