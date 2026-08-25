/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_tree_tabs_keyboard_navigation() {
  await enableTreeTabs();
  Services.prefs.setBoolPref("browser.ctrlTab.sortByRecentlyUsed", false);

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-keyboard-parent"
  );
  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-keyboard-child"
  );
  const grandchildTab = await openTabWithTree(
    childTab,
    "https://example.com/?waterfox-tree-keyboard-grandchild"
  );
  const otherRootTab = BrowserTestUtils.addTab(gBrowser, "about:blank");

  function focusTreeTabs() {
    Services.focus.setFocus(gBrowser.tabContainer, Services.focus.FLAG_BYKEY);
    gBrowser.selectedTab.focus();
  }

  function dispatchTreeArrowKey(key) {
    gBrowser.tabContainer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
      })
    );
  }

  await BrowserTestUtils.switchTab(gBrowser, parentTab);
  focusTreeTabs();
  dispatchTreeArrowKey("ArrowLeft");
  await waitForTreeCondition(
    () => gBrowser.TreeTabsService.isCollapsed(parentTab),
    "Waiting for ArrowLeft to collapse parent"
  );
  ok(
    gBrowser.TreeTabsService.isCollapsed(parentTab),
    "ArrowLeft collapses expanded tree parent"
  );
  is(
    parentTab.getAttribute("aria-expanded"),
    "false",
    "The focused row exposes collapsed state"
  );
  is(
    parentTab
      .querySelector(".tab-tree-disclosure")
      .getAttribute("aria-expanded"),
    "false",
    "The disclosure exposes the same collapsed state"
  );

  focusTreeTabs();
  dispatchTreeArrowKey("ArrowRight");
  await waitForTreeCondition(
    () => !gBrowser.TreeTabsService.isCollapsed(parentTab),
    "Waiting for ArrowRight to expand parent"
  );
  ok(
    !gBrowser.TreeTabsService.isCollapsed(parentTab),
    "ArrowRight expands collapsed tree parent"
  );
  is(
    parentTab.getAttribute("aria-expanded"),
    "true",
    "The focused row exposes expanded state"
  );

  gBrowser.TreeTabsService.collapseSubtree(childTab);
  await waitForTreeCondition(
    () => gBrowser.TreeTabsService.isCollapsed(childTab),
    "Waiting for child subtree collapse"
  );

  await BrowserTestUtils.switchTab(gBrowser, childTab);
  focusTreeTabs();
  dispatchTreeArrowKey("ArrowLeft");
  await waitForTreeCondition(
    () => gBrowser.selectedTab == parentTab,
    "Waiting for ArrowLeft to move focus to parent"
  );
  is(
    gBrowser.selectedTab,
    parentTab,
    "ArrowLeft on collapsed child selects parent"
  );

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () =>
      gBrowser.TreeTabsService.isCollapsed(parentTab) && isTreeHidden(childTab),
    "Waiting for parent subtree collapse before ArrowRight setup"
  );
  gBrowser.TreeTabsService.expandSubtree(parentTab);
  await waitForTreeCondition(
    () =>
      !gBrowser.TreeTabsService.isCollapsed(parentTab) &&
      !isTreeHidden(childTab),
    "Waiting for parent subtree expansion before ArrowRight"
  );

  if (gBrowser.selectedTab != parentTab) {
    await BrowserTestUtils.switchTab(gBrowser, parentTab);
  }
  focusTreeTabs();
  dispatchTreeArrowKey("ArrowRight");
  await waitForTreeCondition(
    () => gBrowser.selectedTab == childTab,
    "Waiting for ArrowRight to move focus to first child"
  );
  is(
    gBrowser.selectedTab,
    childTab,
    "ArrowRight on expanded parent selects first child"
  );

  gBrowser.TreeTabsService.collapseSubtree(parentTab);
  await waitForTreeCondition(
    () => isTreeHidden(childTab) && isTreeHidden(grandchildTab),
    "Waiting for descendants to be hidden for Ctrl+Tab test"
  );
  ok(
    !gBrowser.tabContainer._canAdvanceToTab(childTab),
    "Hidden child is skipped by tab advance filter"
  );
  ok(
    !gBrowser.tabContainer._canAdvanceToTab(grandchildTab),
    "Hidden grandchild is skipped by tab advance filter"
  );

  BrowserTestUtils.removeTab(otherRootTab);
});

add_task(async function test_global_tree_navigation_shortcuts() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-global-key-parent"
  );
  const childTab = await openTabWithTree(
    parentTab,
    "about:blank?waterfox-tree-global-key-child"
  );

  const modifiers =
    Services.appinfo.OS == "Darwin"
      ? { ctrlKey: true, shiftKey: true }
      : { altKey: true, shiftKey: true };
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      ...modifiers,
      key: "ArrowRight",
      bubbles: true,
      cancelable: true,
    })
  );
  await waitForTreeCondition(
    () => gBrowser.selectedTab == childTab,
    "Waiting for the global shortcut to select the first child"
  );
  is(
    gBrowser.selectedTab,
    childTab,
    "Global ArrowRight selects the first tree child"
  );

  gURLBar.focus();
  gURLBar.inputField.dispatchEvent(
    new KeyboardEvent("keydown", {
      ...modifiers,
      key: "ArrowLeft",
      bubbles: true,
      cancelable: true,
      composed: true,
    })
  );
  is(
    gBrowser.selectedTab,
    childTab,
    "Global tree shortcuts do not capture editable chrome controls"
  );

  BrowserTestUtils.removeTab(childTab);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(async function test_disclosure_native_keyboard_activation() {
  await enableTreeTabs();
  SidebarController._state.launcherExpanded = true;
  await waitForTreeCondition(
    () => gBrowser.tabContainer.hasAttribute("expanded"),
    "Waiting for expanded rows"
  );
  const parent = gBrowser.selectedTab;
  const child = await openTabWithTree(parent);
  const disclosure = parent.querySelector(".tab-tree-disclosure");
  const groupTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const group = gBrowser.addTabGroup([groupTab], { label: "Stale aria focus" });
  let groupClicks = 0;
  let disclosureClicks = 0;
  let leakedKeys = 0;
  const countClicks = event => {
    if (event.target == group.labelElement) {
      groupClicks++;
    } else if (event.target == disclosure) {
      ok(event.isTrusted, "Native keyboard activation creates a trusted click");
      disclosureClicks++;
    }
  };
  const countLeakedKeys = () => leakedKeys++;
  window.addEventListener("click", countClicks, true);
  for (const type of ["keydown", "keyup"]) {
    gBrowser.tabContainer.addEventListener(type, countLeakedKeys, {
      mozSystemGroup: true,
    });
  }
  try {
    is(disclosure.localName, "button", "The disclosure is a native button");
    is(
      disclosure.tabIndex,
      -1,
      "Row arrow keys remain the sequential keyboard contract"
    );
    for (const [key, collapsed] of [
      ["KEY_Enter", true],
      [" ", false],
    ]) {
      gBrowser.tabContainer.ariaFocusedItem = group.labelElement;
      disclosure.focus();
      is(
        document.activeElement,
        disclosure,
        "Assistive technology can focus the button directly"
      );
      is(
        gBrowser.tabContainer.ariaFocusedItem,
        group.labelElement,
        "The native group label remains the stale aria focus target"
      );
      EventUtils.synthesizeKey(key);
      is(
        gBrowser.TreeTabsService.isCollapsed(parent),
        collapsed,
        `${key} activates only the directly focused disclosure`
      );
      ok(
        !group.collapsed,
        "Disclosure activation leaves the native group open"
      );
    }
    is(groupClicks, 0, "Neither key activates the stale native group label");
    is(
      disclosureClicks,
      2,
      "Each native button default activates exactly once"
    );
    is(
      leakedKeys,
      0,
      "Disclosure keydown and keyup do not reach native tab handlers"
    );
    is(
      gBrowser.selectedTab,
      parent,
      "Disclosure activation does not change selection"
    );
  } finally {
    window.removeEventListener("click", countClicks, true);
    for (const type of ["keydown", "keyup"]) {
      gBrowser.tabContainer.removeEventListener(type, countLeakedKeys, {
        mozSystemGroup: true,
      });
    }
    gBrowser.tabContainer.ariaFocusedItem = parent;
    parent.focus();
    await BrowserTestUtils.removeTab(groupTab);
    await BrowserTestUtils.removeTab(child);
  }
});
