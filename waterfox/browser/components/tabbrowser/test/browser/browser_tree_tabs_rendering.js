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

  const beforeStyle = window.getComputedStyle(parentTab, "::before");
  ok(
    beforeStyle.content && beforeStyle.content != "none",
    "Chevron pseudo-element is rendered for parent tabs"
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
