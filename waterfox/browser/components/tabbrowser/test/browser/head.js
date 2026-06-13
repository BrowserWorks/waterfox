/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const PREF_SIDEBAR_REVAMP = "sidebar.revamp";
const PREF_VERTICAL_TABS = "sidebar.verticalTabs";
const PREF_TREE_ENABLED = "browser.tabs.verticalTabs.tree.enabled";
const PREF_TREE_AUTO_ATTACH = "browser.tabs.verticalTabs.tree.autoAttach";
const PREF_TREE_AUTO_COLLAPSE_ON_SELECT =
  "browser.tabs.verticalTabs.tree.autoCollapse.onSelect";
const PREF_TREE_CLOSE_PARENT_BEHAVIOR =
  "browser.tabs.verticalTabs.tree.closeParentBehavior";
const PREF_TREE_DOUBLE_CLICK_BEHAVIOR =
  "browser.tabs.verticalTabs.tree.doubleClickBehavior";
const PREF_TREE_INDENT_PX = "browser.tabs.verticalTabs.tree.indentPx";
const PREF_TREE_PROPAGATE_MUTED_STATE =
  "browser.tabs.verticalTabs.tree.propagateMutedState";

const TREE_TEST_PREFS = [
  PREF_TREE_ENABLED,
  PREF_TREE_AUTO_ATTACH,
  PREF_TREE_AUTO_COLLAPSE_ON_SELECT,
  PREF_TREE_CLOSE_PARENT_BEHAVIOR,
  PREF_TREE_DOUBLE_CLICK_BEHAVIOR,
  PREF_TREE_INDENT_PX,
  PREF_TREE_PROPAGATE_MUTED_STATE,
];
const WAIT_FOR_CONDITION_INTERVAL_MS = 200;
const WAIT_FOR_CONDITION_MAX_TRIES = 50;

function waitForTreeCondition(condition, message, interval, maxTries) {
  return BrowserTestUtils.waitForCondition(
    condition,
    message,
    interval ?? WAIT_FOR_CONDITION_INTERVAL_MS,
    maxTries ?? WAIT_FOR_CONDITION_MAX_TRIES
  );
}

function getVerticalTabsBox() {
  return document.getElementById("vertical-tabs");
}

function clearTreeTestPrefs() {
  for (const pref of TREE_TEST_PREFS) {
    if (Services.prefs.prefHasUserValue(pref)) {
      Services.prefs.clearUserPref(pref);
    }
  }
}

async function ensureVerticalTabs() {
  Services.prefs.setBoolPref(PREF_SIDEBAR_REVAMP, true);
  Services.prefs.setBoolPref(PREF_VERTICAL_TABS, true);

  await waitForTreeCondition(
    () => gBrowser.tabContainer?.verticalMode,
    "Waiting for vertical tab mode"
  );
  await waitForTreeCondition(
    () => !!getVerticalTabsBox(),
    "Waiting for vertical tab strip container"
  );
}

async function waitForTreeUpdate() {
  return new Promise(resolve => {
    let done = false;
    let fallbackTimer = null;
    const observer = {
      observe(subject) {
        const payload = subject?.wrappedJSObject ?? subject;
        if (payload?.window && payload.window != window) {
          return;
        }
        finish();
      },
    };

    const finish = () => {
      if (done) {
        return;
      }
      done = true;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      try {
        Services.obs.removeObserver(observer, "tree-tabs-structure-changed");
      } catch (error) {}
      resolve();
    };

    Services.obs.addObserver(observer, "tree-tabs-structure-changed");
    // Use a timeout fallback in case no structure event is emitted.
    fallbackTimer = setTimeout(finish, 250);
  });
}

async function enableTreeTabs() {
  clearTreeTestPrefs();
  await ensureVerticalTabs();

  if (!window.TreeTabsDnD) {
    info("Tree UI not yet attached to this window, attaching manually");
    const { TreeTabsUI } = ChromeUtils.importESModule(
      "resource:///modules/TreeTabsUI.sys.mjs"
    );
    TreeTabsUI.onWindowOpened(window);
  }

  Services.prefs.setBoolPref(PREF_TREE_ENABLED, true);

  await waitForTreeCondition(
    () => getVerticalTabsBox()?.hasAttribute("tree-tabs-enabled"),
    "Waiting for tree tabs UI to become enabled"
  );
  await waitForTreeUpdate();

  // External-move fixups stay suppressed while the startup restore guard is
  // active; with no stored structure it only clears by timeout, so clear it
  // directly.
  const { TreeTabsStore } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsStore.sys.mjs"
  );
  TreeTabsStore.clearRestoreGuard(window);
}

async function disableTreeTabs({ strict = true } = {}) {
  Services.prefs.setBoolPref(PREF_TREE_ENABLED, false);
  if (!strict) {
    await new Promise(resolve => setTimeout(resolve));
    if (getVerticalTabsBox()?.hasAttribute("tree-tabs-enabled")) {
      info(
        "Tree tabs UI was still marked enabled during cleanup; clearing attribute manually"
      );
      getVerticalTabsBox()?.removeAttribute("tree-tabs-enabled");
    }
    return;
  }

  await waitForTreeCondition(
    () => !getVerticalTabsBox()?.hasAttribute("tree-tabs-enabled"),
    "Waiting for tree tabs UI to become disabled"
  );
}

async function openTabWithTree(parentTab, url = "about:blank") {
  if (gBrowser.selectedTab != parentTab) {
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
  }

  const tab = BrowserTestUtils.addTab(gBrowser, url);
  if (url != "about:blank") {
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url);
  }

  gBrowser.TreeTabsService.attachTab(tab, parentTab);
  await waitForTreeUpdate();
  await waitForTreeCondition(
    () => getTreeParent(tab) == parentTab,
    "Waiting for tab to be attached in tree"
  );

  return tab;
}

async function openLinkInNewTab(parentTab, url) {
  if (gBrowser.selectedTab != parentTab) {
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
  }
  const tabOpened = BrowserTestUtils.waitForNewTab(gBrowser, url, true);
  await SpecialPowers.spawn(parentTab.linkedBrowser, [url], async href => {
    let link = content.document.createElement("a");
    link.href = href;
    link.target = "_blank";
    link.textContent = "click me";
    content.document.body.appendChild(link);
    link.click();
  });
  return tabOpened;
}

function getTreeLevel(tab) {
  return Number.parseInt(tab.getAttribute("data-tree-level") || "0", 10);
}

function getTreeParent(tab) {
  return gBrowser.TreeTabsService.getParent(tab);
}

function isTreeHidden(tab) {
  return tab.getAttribute("data-tree-hidden") == "true";
}

function hasTreeChildren(tab) {
  return tab.getAttribute("data-tree-has-children") == "true";
}

async function openTabContextMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function closeTabContextMenu() {
  const menu = document.getElementById("tabContextMenu");
  if (!menu || menu.state == "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

async function selectTabByClick(tab) {
  if (gBrowser.selectedTab == tab) {
    return;
  }
  await BrowserTestUtils.switchTab(gBrowser, tab);
}

async function userSelectTab(tab) {
  if (gBrowser.selectedTab == tab) {
    return;
  }
  const userInput = window.windowUtils.setHandlingUserInput(true);
  try {
    await BrowserTestUtils.switchTab(gBrowser, tab);
  } finally {
    userInput.destruct();
  }
}

async function doubleClickTab(tab) {
  const dblclick = BrowserTestUtils.waitForEvent(tab, "dblclick");
  EventUtils.synthesizeMouseAtCenter(tab, { clickCount: 1, button: 0 });
  EventUtils.synthesizeMouseAtCenter(tab, { clickCount: 2, button: 0 });
  await dblclick;
}

async function closeExtraTabs() {
  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(gBrowser.tabs[gBrowser.tabs.length - 1]);
  }
}

async function resetTreeTabsTestState() {
  await closeTabContextMenu();
  // Disable tree tabs before closing tabs to avoid tree operations during teardown
  if (Services.prefs.getBoolPref(PREF_TREE_ENABLED, false)) {
    Services.prefs.setBoolPref(PREF_TREE_ENABLED, false);
    // Give the UI a tick to process the disable
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await closeExtraTabs();
  clearTreeTestPrefs();
}

registerCleanupFunction(async () => {
  await resetTreeTabsTestState();
});
