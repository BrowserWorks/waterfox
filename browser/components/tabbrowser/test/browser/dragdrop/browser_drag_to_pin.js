/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

let currentReduceMotionOverride;

add_setup(() => {
  currentReduceMotionOverride = gReduceMotionOverride;
  // Disable tab animations
  gReduceMotionOverride = true;
  // Disable tab groups so as not to interfere with pinned drop indicator delayed visibility
  Services.prefs.setBoolPref("browser.tabs.groups.enabled", false);
});

registerCleanupFunction(() => {
  gReduceMotionOverride = currentReduceMotionOverride;
  Services.prefs.clearUserPref("sidebar.revamp");
  Services.prefs.clearUserPref("browser.tabs.groups.enabled");
  Services.prefs.clearUserPref(
    "browser.toolbarbuttons.introduced.sidebar-button"
  );
  // Reset UI because sidebar-button added
  CustomizableUI.reset();
});

async function pinIndicatorDragCond(pinnedDropIndicator) {
  info("Wait for interaction cue");
  await BrowserTestUtils.waitForMutationCondition(
    pinnedDropIndicator,
    { attributes: true },
    () => {
      return (
        pinnedDropIndicator.hasAttribute("visible") &&
        pinnedDropIndicator.hasAttribute("interactive") &&
        BrowserTestUtils.isVisible(pinnedDropIndicator)
      );
    }
  );
}

add_task(async function test_pin_to_pinned_drop_indicator_horizontal() {
  let tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  let pinnedDropIndicator = document.getElementById("pinned-drop-indicator");
  let unpinnedTabsContainer = document.getElementById(
    "tabbrowser-arrowscrollbox"
  );
  let dragEvent = getDragEvent();

  info("Drag to pin to the interaction cue");
  await customDragAndDrop(
    tab,
    pinnedDropIndicator,
    pinIndicatorDragCond(pinnedDropIndicator),
    BrowserTestUtils.waitForEvent(tab, "TabPinned"),
    dragEvent
  );
  ok(tab.pinned, "Tab is pinned");

  info("Drag pinned tab to the unpinned container");
  await customDragAndDrop(
    tab,
    unpinnedTabsContainer.firstChild,
    null,
    BrowserTestUtils.waitForEvent(tab, "TabUnpinned")
  );
  ok(!tab.pinned, "Tab is unpinned");

  info("Remove tab");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pin_to_pinned_tabs_container_horizontal() {
  // We need at least one pinned tab in order to then test dragging to pin to the pinned tabs container
  let tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { pinned: true });
  let tab2 = BrowserTestUtils.addTab(gBrowser, "about:blank");
  let pinnedTabsContainer = document.getElementById("pinned-tabs-container");

  info("Drag to pin to the pinned tabs container");
  await customDragAndDrop(
    tab2,
    pinnedTabsContainer,
    null,
    BrowserTestUtils.waitForEvent(tab2, "TabPinned")
  );
  ok(tab2.pinned, "Tab is pinned");

  // Unpinning testing covered in test_pin_to_pinned_drop_indicator_horizontal

  info("Remove tab");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(tab2);
});

add_task(async function test_resize_container_on_unpin_horizontal() {
  let pinnedTabsContainer = document.getElementById("pinned-tabs-container");
  let unpinnedTabsContainer = document.getElementById(
    "tabbrowser-arrowscrollbox"
  );
  let tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { pinned: true });
  let pinnedTabsContainerOriginalWidth =
    pinnedTabsContainer.getBoundingClientRect().width;

  BrowserTestUtils.addTab(gBrowser, "about:blank", { pinned: true });
  Assert.notEqual(
    pinnedTabsContainer.getBoundingClientRect().width,
    pinnedTabsContainerOriginalWidth,
    "Pinned tabs container grew to fit a second pinned tab"
  );

  info("Drop a tab out of the pinned tabs container");
  await customDragAndDrop(
    tab,
    unpinnedTabsContainer,
    null,
    BrowserTestUtils.waitForEvent(tab, "TabUnpinned")
  );
  ok(!tab.pinned, "Tab is unpinned");
  is(
    window.windowUtils.getBoundsWithoutFlushing(pinnedTabsContainer).width,
    pinnedTabsContainerOriginalWidth,
    "Pinned tabs container resized back to one tab"
  );

  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(gBrowser.tabs.at(0));
  }
});

add_task(async function test_pin_to_promo_card_vertical() {
  // Ensure the mouse is not hovering over the tab strip.
  EventUtils.synthesizeMouseAtCenter(document.documentElement, {
    type: "mouseover",
  });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["sidebar.verticalTabs", true],
      ["sidebar.verticalTabs.dragToPinPromo.dismissed", false],
      ["sidebar.visibility", "always-show"],
    ],
  });

  let initialTab = gBrowser.tabs[0];
  let tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  let promoCard = document.getElementById("drag-to-pin-promo-card");
  let dragEvent = getDragEvent(true);

  async function promoPinDragCond() {
    info("Wait for promo card");
    await BrowserTestUtils.waitForMutationCondition(
      promoCard.card,
      { attributes: true },
      () => {
        return promoCard.card.hasAttribute("dragactive");
      }
    );
  }

  info("Drag to pin to the promo card");
  await customDragAndDrop(
    tab,
    promoCard,
    promoPinDragCond(),
    BrowserTestUtils.waitForEvent(tab, "TabPinned"),
    dragEvent
  );
  ok(tab.pinned, "Tab is pinned");

  info("Drag pinned tab to the unpinned container");
  await customDragAndDrop(
    tab,
    initialTab,
    null,
    BrowserTestUtils.waitForEvent(tab, "TabUnpinned")
  );
  ok(!tab.pinned, "Tab is unpinned");

  info("Remove tab");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pin_to_pinned_drop_indicator_vertical() {
  let tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
  let pinnedDropIndicator = document.getElementById("pinned-drop-indicator");
  let dragEvent = getDragEvent(window, true);

  info("Drag to pin to the interaction cue");
  await customDragAndDrop(
    tab,
    pinnedDropIndicator,
    pinIndicatorDragCond(pinnedDropIndicator),
    BrowserTestUtils.waitForEvent(tab, "TabPinned"),
    dragEvent
  );
  ok(tab.pinned, "Tab is pinned");

  // Unpinning testing covered in test_pin_to_promo_card_vertical

  info("Remove tab");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_pin_to_pinned_tabs_container_vertical() {
  // We need at least one pinned tab in order to then test dragging to pin to the pinned tabs container
  let tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { pinned: true });
  let tab2 = BrowserTestUtils.addTab(gBrowser, "about:blank");
  let pinnedTabsContainer = document.getElementById("pinned-tabs-container");

  info("Drag to pin to the pinned tabs container");
  await customDragAndDrop(
    tab2,
    pinnedTabsContainer,
    null,
    BrowserTestUtils.waitForEvent(tab2, "TabPinned")
  );
  ok(tab2.pinned, "Tab is pinned");

  // Unpinning testing covered in test_pin_to_promo_card_vertical

  info("Remove tab");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(tab2);
});

add_task(async function test_resize_container_on_unpin_vertical() {
  let tab = BrowserTestUtils.addTab(gBrowser, "about:blank", { pinned: true });
  let pinnedTabsContainer = document.getElementById("pinned-tabs-container");
  let pinnedTabsContainerOriginalHeight =
    window.windowUtils.getBoundsWithoutFlushing(pinnedTabsContainer).height;
  let unpinnedTabsContainer = document.getElementById(
    "tabbrowser-arrowscrollbox"
  );

  // Add tabs until we have more than one row
  let tabScreen = tab.screenY;
  while (tabScreen == tab.screenY) {
    let newTab = BrowserTestUtils.addTab(gBrowser, "about:blank", {
      pinned: true,
    });
    tabScreen = newTab.screenY;
  }
  Assert.notEqual(
    window.windowUtils.getBoundsWithoutFlushing(pinnedTabsContainer).height,
    pinnedTabsContainerOriginalHeight,
    "Pinned tabs container grew to fit a second row"
  );

  info("Drop a tab out of the pinned tabs container");
  await customDragAndDrop(
    tab,
    unpinnedTabsContainer,
    null,
    BrowserTestUtils.waitForEvent(tab, "TabUnpinned")
  );
  ok(!tab.pinned, "Tab is unpinned");
  is(
    window.windowUtils.getBoundsWithoutFlushing(pinnedTabsContainer).height,
    pinnedTabsContainerOriginalHeight,
    "Pinned tabs container resized back to one row"
  );

  // Testing the dragging of the splitter vertically is in browser_resize_sidebar.js

  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(gBrowser.tabs.at(0));
  }
});
