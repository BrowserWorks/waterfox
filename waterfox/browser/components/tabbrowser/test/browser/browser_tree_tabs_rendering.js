/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function isApprox(actual, expected, tolerance, message) {
  Assert.lessOrEqual(
    Math.abs(actual - expected),
    tolerance,
    `${message} (got ${actual})`
  );
}

add_task(async function test_leaf_content_follows_tree_depth() {
  await enableTreeTabs();
  SidebarController._state.launcherExpanded = true;
  await waitForTreeCondition(
    () => gBrowser.tabContainer.hasAttribute("expanded"),
    "Waiting for expanded tab rows"
  );

  await disableTreeTabs();
  const root = gBrowser.selectedTab;
  const rtl = getComputedStyle(root).direction == "rtl";
  const start = (tab, selector) => {
    const rect = tab.querySelector(selector).getBoundingClientRect();
    return rtl ? -rect.right : rect.left;
  };
  const iconGap = tab =>
    start(tab, ".tab-icon-stack") - start(tab, ".tab-background");
  const nativeGap = iconGap(root);
  await enableTreeTabs();

  const openChild = parent =>
    gBrowser.addTrustedTab("about:blank", {
      openerBrowser: parent.linkedBrowser,
      skipAnimation: true,
    });
  const branch = openChild(root);
  const sibling = openChild(root);
  const leaf = openChild(branch);
  const standalone = gBrowser.addTrustedTab("about:blank", {
    relatedToCurrent: false,
    skipAnimation: true,
  });
  try {
    const indent = Services.prefs.getIntPref(PREF_TREE_INDENT_PX, 16);
    is(getTreeParent(standalone), null, "The standalone tab is a root");
    for (const tab of [standalone, sibling, leaf]) {
      isApprox(
        iconGap(tab),
        nativeGap,
        1.5,
        `Level ${getTreeLevel(tab)} leaf has normal outline-to-icon spacing`
      );
    }
    for (const selector of [".tab-icon-stack", ".tab-label-container"]) {
      isApprox(
        start(branch, selector) - start(root, selector),
        indent,
        1.5,
        `${selector}: a child parent is indented from its root`
      );
      isApprox(
        start(sibling, selector),
        start(branch, selector),
        1.5,
        `${selector}: leaf and parent siblings align`
      );
      isApprox(
        start(leaf, selector) - start(branch, selector),
        indent,
        1.5,
        `${selector}: the final leaf is indented from its parent`
      );
    }
  } finally {
    await BrowserTestUtils.removeTab(standalone);
    await BrowserTestUtils.removeTab(leaf);
    await BrowserTestUtils.removeTab(sibling);
    await BrowserTestUtils.removeTab(branch);
  }
});

add_task(async function test_tree_tabs_visual_attributes_and_indent_capping() {
  await enableTreeTabs();

  const parentTab = gBrowser.selectedTab;
  const childTab = await openTabWithTree(
    parentTab,
    "https://example.com/?waterfox-tree-rendering-child"
  );
  const grandchildTab = await openTabWithTree(
    childTab,
    "https://example.com/?waterfox-tree-rendering-grandchild"
  );

  const indentPx = Services.prefs.getIntPref(PREF_TREE_INDENT_PX, 16);

  is(
    parentTab.style.getPropertyValue("--tree-level"),
    "0",
    "Root tab sets --tree-level custom property"
  );
  is(
    childTab.style.getPropertyValue("--tree-level"),
    "1",
    "Child tab sets --tree-level custom property"
  );
  is(
    grandchildTab.style.getPropertyValue("--tree-level"),
    "2",
    "Grandchild tab sets --tree-level custom property"
  );

  isApprox(
    parseFloat(window.getComputedStyle(parentTab).marginInlineStart),
    0,
    1,
    "Root tab has zero indent"
  );
  isApprox(
    parseFloat(window.getComputedStyle(childTab).marginInlineStart),
    indentPx,
    1,
    "Child tab margin-inline-start matches indent"
  );
  isApprox(
    parseFloat(window.getComputedStyle(grandchildTab).marginInlineStart),
    indentPx * 2,
    1,
    "Grandchild tab margin-inline-start matches indent"
  );

  const newIndentPx = indentPx == 1 ? 8 : 1;
  try {
    Services.prefs.setIntPref(PREF_TREE_INDENT_PX, newIndentPx);
    for (const [level, tab] of [parentTab, childTab, grandchildTab].entries()) {
      isApprox(
        parseFloat(window.getComputedStyle(tab).marginInlineStart),
        newIndentPx * level,
        1,
        `Level ${level} indentation updates immediately after changing the pref`
      );
    }
  } finally {
    Services.prefs.setIntPref(PREF_TREE_INDENT_PX, indentPx);
  }

  const disclosure = parentTab.querySelector(".tab-tree-disclosure");
  ok(BrowserTestUtils.isVisible(disclosure), "Parent disclosure is visible");
  const beforeStyle = window.getComputedStyle(disclosure, "::before");
  ok(
    beforeStyle.content && beforeStyle.content != "none",
    "The disclosure paints its chevron"
  );

  const verticalTabsBox = getVerticalTabsBox();
  const width = verticalTabsBox.getBoundingClientRect().width || 250;
  const maxIndent = Math.max(0, width - 120);
  const maxVisualLevel = Math.floor(maxIndent / indentPx);

  const extraDepth = Math.max(3, maxVisualLevel + 3);
  let deepestTab = grandchildTab;
  for (let i = 0; i < extraDepth; i += 1) {
    deepestTab = await openTabWithTree(
      deepestTab,
      `https://example.com/?waterfox-tree-rendering-depth-${i}`
    );
  }

  await waitForTreeCondition(
    () => getTreeLevel(deepestTab) > maxVisualLevel,
    "Waiting for deeply nested logical level to exceed visual max"
  );

  const logicalLevel = getTreeLevel(deepestTab);
  const visualLevel = Number.parseInt(
    deepestTab.style.getPropertyValue("--tree-level"),
    10
  );
  is(
    visualLevel,
    Math.min(logicalLevel, maxVisualLevel),
    "Visual level is clamped to dynamic maximum"
  );
  Assert.lessOrEqual(
    visualLevel,
    maxVisualLevel,
    "Deeply nested tab does not exceed dynamic max indent"
  );
});

add_task(async function test_collapsed_tree_uses_native_tab_tooltip() {
  await enableTreeTabs();

  const parentTab = BrowserTestUtils.addTab(
    gBrowser,
    "about:blank?waterfox-tree-tooltip-parent"
  );
  parentTab.label = "Tree tooltip parent";
  const childTab = await openTabWithTree(
    parentTab,
    "about:blank?waterfox-tree-tooltip-child"
  );
  childTab.label = "Tree tooltip child";
  gBrowser.TreeTabsService.collapseSubtree(parentTab);

  await waitForTreeCondition(
    () => parentTab.hasAttribute("data-tree-descendants-tooltip"),
    "Waiting for collapsed descendant tooltip data"
  );
  const tabContent = parentTab.querySelector(".tab-content");
  is(
    tabContent?.getAttribute("data-tree-counter"),
    "1",
    "Descendant count is attached to the content before the favicon"
  );
  ok(
    !parentTab
      .querySelector(".tab-label-container")
      ?.hasAttribute("data-tree-counter"),
    "Descendant count is not attached to the title container"
  );
  const tooltip = gBrowser.getTabTooltip(parentTab, true);
  ok(
    tooltip.includes(parentTab._fullLabel),
    "Native tooltip includes the parent"
  );
  ok(tooltip.includes(childTab.label), "Native tooltip includes descendants");
  ok(
    !parentTab.hasAttribute("tooltiptext"),
    "Tree tooltip does not replace Firefox's native tooltip provider"
  );

  BrowserTestUtils.removeTab(childTab);
  BrowserTestUtils.removeTab(parentTab);
});

add_task(async function test_tree_projection_reuses_metrics_and_descendants() {
  await enableTreeTabs();
  const { TreeTabsUI } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsUI.sys.mjs"
  );
  const controller = TreeTabsUI._controllers.get(window);
  const service = gBrowser.TreeTabsService;
  const parent = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const child = await openTabWithTree(parent);
  service.collapseSubtree(parent);
  const box = getVerticalTabsBox();
  const originalRect = box.getBoundingClientRect;
  const originalDescendants = service.getDescendants;
  const originalUpdateTab = controller._updateTab;
  const originalSoundIndicator = controller._updateTabSoundIndicator;
  let measurements = 0;
  let rowUpdates = 0;
  let soundUpdates = 0;
  const descendantReads = new Map();
  try {
    box.getBoundingClientRect = function () {
      measurements++;
      return originalRect.call(this);
    };
    service.getDescendants = function (tab) {
      descendantReads.set(tab, (descendantReads.get(tab) || 0) + 1);
      return originalDescendants.call(this, tab);
    };
    controller._updateTab = function (...args) {
      rowUpdates++;
      return originalUpdateTab.apply(this, args);
    };
    controller._updateTabSoundIndicator = function (...args) {
      soundUpdates++;
      return originalSoundIndicator.apply(this, args);
    };

    controller._updateAllTabs();
    is(measurements, 1, "A full projection measures the sidebar once");
    for (const tab of gBrowser.tabs) {
      is(
        descendantReads.get(tab),
        1,
        "Audio, counter and tooltip share one descendant traversal per row"
      );
    }
    controller._updateTab(child, 16, 0);
    is(
      measurements,
      1,
      "A supplied zero depth limit needs no fallback metrics"
    );
    controller._updateTab(child);
    is(measurements, 2, "An isolated row computes fallback metrics once");

    child.label = "Updated descendant title";
    measurements = rowUpdates = soundUpdates = 0;
    descendantReads.clear();
    controller._handleTabAttrModified({
      target: child,
      detail: { changed: ["label"] },
    });
    is(measurements, 0, "Label projection does not measure layout");
    is(rowUpdates, 0, "Label projection does not refresh rows");
    is(soundUpdates, 0, "Label projection does not recompute audio state");
    is(descendantReads.get(parent), 1, "Only the collapsed ancestor is walked");
    is(descendantReads.size, 1, "The renamed tab is not walked");
    ok(
      gBrowser.getTabTooltip(parent, true).includes(child.label),
      "The native tooltip immediately receives the new descendant title"
    );
    is(
      parent.querySelector(".tab-content").dataset.treeCounter,
      "1",
      "A label update leaves the descendant counter intact"
    );

    const disclosure = parent.querySelector(".tab-tree-disclosure");
    const previousName = disclosure.getAttribute("aria-label");
    ok(
      previousName.includes(parent.label),
      "The action identifies its tree's tab"
    );
    parent.label = "Renamed disclosure parent";
    measurements = rowUpdates = soundUpdates = 0;
    descendantReads.clear();
    controller._handleTabAttrModified({
      target: parent,
      detail: { changed: ["label"] },
    });
    ok(
      disclosure.getAttribute("aria-label").includes(parent.label),
      "Renaming the tab updates its contextual disclosure name"
    );
    isnot(
      disclosure.getAttribute("aria-label"),
      previousName,
      "The old name is replaced"
    );
    is(measurements, 0, "Renaming the disclosure does not measure layout");
    is(rowUpdates, 0, "Renaming the disclosure does not refresh its row");
    is(soundUpdates, 0, "Renaming the disclosure does not update audio state");
    is(
      descendantReads.size,
      0,
      "Renaming the disclosure does not walk its tree"
    );

    await disableTreeTabs();
    measurements = rowUpdates = 0;
    Services.prefs.setBoolPref(PREF_TREE_ENABLED, true);
    is(measurements, 1, "Enabling owns one final measured projection");
    is(rowUpdates, gBrowser.tabs.length, "Enabling projects each row once");
    is(service.getParent(child), parent, "Enabling preserves the live model");
    ok(isTreeHidden(child), "Enabling restores visibility synchronously");
  } finally {
    box.getBoundingClientRect = originalRect;
    service.getDescendants = originalDescendants;
    controller._updateTab = originalUpdateTab;
    controller._updateTabSoundIndicator = originalSoundIndicator;
    service.expandSubtree(parent);
    await BrowserTestUtils.removeTab(child);
    await BrowserTestUtils.removeTab(parent);
  }
});

add_task(async function test_disclosure_hit_area_uses_logical_css_geometry() {
  await enableTreeTabs();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["sidebar.visibility", "always-show"],
      ["sidebar.animation.enabled", false],
    ],
  });
  SidebarController._state.launcherExpanded = true;
  await waitForTreeCondition(
    () => gBrowser.tabContainer.hasAttribute("expanded"),
    "Waiting for expanded rows"
  );
  const { TreeTabsUI } = ChromeUtils.importESModule(
    "resource:///modules/TreeTabsUI.sys.mjs"
  );
  const controller = TreeTabsUI._controllers.get(window);
  const root = BrowserTestUtils.addTab(gBrowser, "about:blank");
  const branch = await openTabWithTree(root);
  const leaf = await openTabWithTree(branch);
  const oldDirection = document.documentElement.getAttribute("dir");
  window.windowUtils.disableNonTestMouseEvents(true);
  try {
    for (const direction of ["ltr", "rtl"]) {
      document.documentElement.setAttribute("dir", direction);
      await SidebarController.waitUntilStable();
      for (const tab of [root, branch]) {
        tab.scrollIntoView({
          block: "nearest",
          inline: "start",
          behavior: "instant",
        });
        await window.promiseDocumentFlushed(() => {});
        const disclosure = tab.querySelector(".tab-tree-disclosure");
        const row = tab.getBoundingClientRect();
        const hit = disclosure.getBoundingClientRect();

        const contentStyle = getComputedStyle(
          tab.querySelector(".tab-content")
        );
        const padding = parseFloat(contentStyle.paddingInlineEnd);
        const contentPadding = parseFloat(contentStyle.paddingInlineStart);
        isApprox(hit.top, row.top, 0.1, "The hit area starts at the row top");
        isApprox(
          hit.height,
          row.height,
          0.1,
          "The hit area spans the full row"
        );
        isApprox(
          direction == "rtl" ? row.right - hit.right : hit.left - row.left,
          padding,
          0.1,
          `${direction}: the hit area starts at the old inline padding boundary`
        );
        isApprox(
          hit.width,
          contentPadding - padding,
          0.1,
          "The hit area includes the chevron and gap, but not the favicon"
        );
        for (const [x, expected] of [
          [hit.left - 1, null],
          [hit.left + 1, tab],
          [hit.right - 1, tab],
          [hit.right + 1, null],
        ]) {
          is(
            controller._getTwistyTabFromEvent({
              button: 0,
              target: document.elementFromPoint(x, hit.top + hit.height / 2),
            }),
            expected,
            `${direction}, level ${getTreeLevel(tab)}, x=${x}: delegated targeting matches the hit area`
          );
        }
        EventUtils.synthesizeMouseAtCenter(disclosure, { type: "mousemove" });
        ok(
          disclosure.matches(":hover"),
          `${direction}: hover belongs to the DOM control`
        );
        is(
          getComputedStyle(disclosure, "::before")
            .getPropertyValue("--tree-twisty-scale")
            .trim(),
          "1.08",
          "CSS hover highlights the chevron without JS hover state"
        );
      }
    }
    ok(
      BrowserTestUtils.isHidden(leaf.querySelector(".tab-tree-disclosure")),
      "Leaf tabs have no disclosure hit target"
    );
    SidebarController._state.launcherExpanded = false;
    await waitForTreeCondition(
      () => !gBrowser.tabContainer.hasAttribute("expanded"),
      "Waiting for collapsed rows"
    );
    ok(
      BrowserTestUtils.isHidden(root.querySelector(".tab-tree-disclosure")),
      "Collapsed sidebar rows have no disclosure hit target"
    );
  } finally {
    window.windowUtils.disableNonTestMouseEvents(false);
    if (oldDirection === null) {
      document.documentElement.removeAttribute("dir");
    } else {
      document.documentElement.setAttribute("dir", oldDirection);
    }
    SidebarController._state.launcherExpanded = true;
    await BrowserTestUtils.removeTab(leaf);
    await BrowserTestUtils.removeTab(branch);
    await BrowserTestUtils.removeTab(root);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_disclosure_contrast_boundary_and_split_focus() {
  await enableTreeTabs();
  SidebarController._state.launcherExpanded = true;
  await waitForTreeCondition(
    () => gBrowser.tabContainer.hasAttribute("expanded"),
    "Waiting for expanded rows"
  );
  const tabs = Array.from({ length: 3 }, () =>
    BrowserTestUtils.addTab(gBrowser, "about:blank")
  );
  const [main, secondary, child] = tabs;
  let split;
  try {
    const created = BrowserTestUtils.waitForEvent(
      gBrowser.tabContainer,
      "SplitViewCreated"
    );
    split = gBrowser.addTabSplitView([main, secondary]);
    await created;
    gBrowser.TreeTabsService.attachTab(child, main);
    await BrowserTestUtils.switchTab(gBrowser, secondary);
    const disclosure = main.querySelector(".tab-tree-disclosure");
    let normalWidth;
    for (const contrast of [0, 1]) {
      await SpecialPowers.pushPrefEnv({
        set: [["ui.useAccessibilityTheme", contrast]],
      });
      try {
        await waitForTreeCondition(
          () => matchMedia("(prefers-contrast)").matches == !!contrast,
          "Waiting for the contrast media query"
        );
        Services.focus.setFocus(disclosure, Services.focus.FLAG_BYKEY);
        ok(
          disclosure.matches(":focus-visible"),
          "The disclosure has keyboard focus"
        );
        ok(split.hasAttribute("hasactivetab"), "The split wrapper is active");
        ok(
          !main.selected,
          "The first pane containing the disclosure is inactive"
        );
        const style = getComputedStyle(disclosure);
        const arrow = getComputedStyle(disclosure, "::before");
        const hit = disclosure.getBoundingClientRect();
        const row = main.getBoundingClientRect();
        if (!contrast) {
          normalWidth = hit.width;
        }
        is(
          style.boxSizing,
          "border-box",
          "The boundary stays inside the hit area"
        );
        is(
          style.borderInlineStartWidth,
          `${contrast}px`,
          "Only contrast mode adds a boundary"
        );
        is(
          style.borderBlockStartWidth,
          `${contrast}px`,
          "The boundary surrounds the control"
        );
        isApprox(
          hit.width,
          normalWidth,
          0.1,
          "Contrast does not widen the hit area"
        );
        isApprox(
          hit.top,
          row.top,
          0.1,
          "The hit area still starts at the row top"
        );
        isApprox(
          hit.height,
          row.height,
          0.1,
          "The hit area still spans the full row"
        );
        isApprox(
          parseFloat(style.borderInlineStartWidth) +
            parseFloat(arrow.insetInlineStart),
          0,
          0.1,
          "The added border does not shift the chevron"
        );
        if (matchMedia("(forced-colors)").matches) {
          const selectedItem = getComputedStyle(split).borderInlineStartColor;
          is(
            style.borderInlineStartColor,
            selectedItem,
            "The boundary pairs with the native SelectedItemText surface"
          );
          is(
            style.outlineColor,
            selectedItem,
            "The focus ring uses the same SelectedItem pairing"
          );
        }
      } finally {
        await SpecialPowers.popPrefEnv();
      }
    }
  } finally {
    if (split?.isConnected) {
      const removed = BrowserTestUtils.waitForEvent(
        gBrowser.tabContainer,
        "SplitViewRemoved"
      );
      split.unsplitTabs();
      await removed;
    }
    for (const tab of tabs.toReversed()) {
      if (tab.isConnected && !tab.closing) {
        await BrowserTestUtils.removeTab(tab);
      }
    }
  }
});
