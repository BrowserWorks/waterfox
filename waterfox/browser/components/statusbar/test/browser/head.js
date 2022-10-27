const { synthesizeDrop, synthesizeMouseAtCenter } = EventUtils;

const _STATUSBAR_ENABLED_PREF = "browser.statusbar.enabled";

/**
 * Helper for opening toolbar context menu.
 */
async function _openToolbarContextMenu(contextMenu, target) {
  const popupshown = BrowserTestUtils.waitForEvent(contextMenu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(target, { type: "contextmenu" });
  await popupshown;
}

/**
 * Helpers for Customizable UI
 */

function _startCustomizing(aWindow = window) {
  if (aWindow.document.documentElement.getAttribute("customizing") === "true") {
    return null;
  }
  const customizationReadyPromise = BrowserTestUtils.waitForEvent(
    aWindow.gNavToolbox,
    "customizationready"
  );
  aWindow.gCustomizeMode.enter();
  return customizationReadyPromise;
}

function _endCustomizing(aWindow = window) {
  if (aWindow.document.documentElement.getAttribute("customizing") !== "true") {
    return true;
  }
  const afterCustomizationPromise = BrowserTestUtils.waitForEvent(
    aWindow.gNavToolbox,
    "aftercustomization"
  );
  aWindow.gCustomizeMode.exit();
  return afterCustomizationPromise;
}

function _assertAreaPlacements(areaId, expectedPlacements) {
  const actualPlacements = getAreaWidgetIds(areaId);
  placementArraysEqual(areaId, actualPlacements, expectedPlacements);
}

function getAreaWidgetIds(areaId) {
  return CustomizableUI.getWidgetIdsInArea(areaId);
}

function placementArraysEqual(areaId, actualPlacements, expectedPlacements) {
  info(`Actual placements: ${actualPlacements.join(", ")}`);
  info(`Expected placements: ${expectedPlacements.join(", ")}`);
  is(
    actualPlacements.length,
    expectedPlacements.length,
    `Area ${areaId} should have ${expectedPlacements.length} items.`
  );
  const minItems = Math.min(expectedPlacements.length, actualPlacements.length);
  for (let i = 0; i < minItems; i++) {
    if (typeof expectedPlacements[i] === "string") {
      is(
        actualPlacements[i],
        expectedPlacements[i],
        `Item ${i} in ${areaId} should match expectations.`
      );
    } else if (expectedPlacements[i] instanceof RegExp) {
      ok(
        expectedPlacements[i].test(actualPlacements[i]),
        `Item ${i} (${actualPlacements[i]}) in ${areaId} should match ${expectedPlacements[i]}`
      );
    } else {
      ok(
        false,
        "Unknown type of expected placement passed to " +
          " assertAreaPlacements. Is your test broken?"
      );
    }
  }
}

function _simulateItemDrag(aToDrag, aTarget, aEvent = {}, aOffset = 2) {
  let ev = aEvent;
  if (ev === "end" || ev === "start") {
    const win = aTarget.ownerGlobal;
    const dwu = win.windowUtils;
    const bounds = dwu.getBoundsWithoutFlushing(aTarget);
    if (ev === "end") {
      ev = {
        clientX: bounds.right - aOffset,
        clientY: bounds.bottom - aOffset,
      };
    } else {
      ev = { clientX: bounds.left + aOffset, clientY: bounds.top + aOffset };
    }
  }
  ev._domDispatchOnly = true;
  synthesizeDrop(
    aToDrag.parentNode,
    aTarget,
    null,
    null,
    aToDrag.ownerGlobal,
    aTarget.ownerGlobal,
    ev
  );
  // Ensure dnd suppression is cleared.
  synthesizeMouseAtCenter(aTarget, { type: "mouseup" }, aTarget.ownerGlobal);
}
