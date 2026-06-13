/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

requestLongerTimeout(2);

let initialSidebarVisibility = Services.prefs.getStringPref(
  SIDEBAR_VISIBILITY_PREF
);

registerCleanupFunction(() => {
  // sidebar.visibility gets set during startup and should be restored
  // to that value, not the default value
  Services.prefs.setStringPref(
    SIDEBAR_VISIBILITY_PREF,
    initialSidebarVisibility
  );
  Services.prefs.clearUserPref(POSITION_SETTING_PREF);
  Services.prefs.clearUserPref(VERTICAL_TABS_PREF);
});

async function showCustomizePanel(win) {
  await win.SidebarController.show("viewCustomizeSidebar");
  // `.show()` can return before the pane has fired its `load` event if
  // we were already trying to load that same pane in the same browser.
  // This should be fixed in SidebarController, bug 1954987
  if (win.SidebarController.browser.contentDocument.readyState != "complete") {
    await BrowserTestUtils.waitForEvent(
      win.SidebarController.browser,
      "load",
      true
    );
  }
  const document = win.SidebarController.browser.contentDocument;
  let customizeComponent = document.querySelector("sidebar-customize");
  info("Waiting for customize panel children to be present");
  await BrowserTestUtils.waitForMutationCondition(
    customizeComponent.shadowRoot,
    { subTree: true, childList: true },
    () => {
      if (win.SidebarController.sidebarVerticalTabsEnabled) {
        return (
          customizeComponent?.positionInput &&
          customizeComponent?.visibilityInput
        );
      }
      return customizeComponent?.positionInput;
    }
  );

  ok(true, "Customize panel is shown.");
  return customizeComponent;
}

add_task(async function test_customize_sidebar_actions() {
  const customizeComponent = await showCustomizePanel(window);
  const sidebar = document.querySelector("sidebar-main");
  let toolEntrypointsCount = sidebar.toolButtons.length;
  let checkedInputs = Array.from(customizeComponent.toolInputs).filter(
    input => input.checked
  );
  is(
    checkedInputs.length,
    toolEntrypointsCount,
    `${toolEntrypointsCount} inputs to toggle Firefox Tools are shown in the Customize Menu.`
  );
  is(
    customizeComponent.toolInputs.length,
    5,
    "Five default tools are shown in the customize menu"
  );

  for (const toolInput of customizeComponent.toolInputs) {
    let toolDisabledInitialState = !toolInput.checked;
    toolInput.click();
    await BrowserTestUtils.waitForCondition(
      () => {
        let toggledTool = SidebarController.toolsAndExtensions.get(
          toolInput.id
        );
        return toggledTool.disabled === !toolDisabledInitialState;
      },
      `The entrypoint for ${toolInput.name} has been ${toolDisabledInitialState ? "enabled" : "disabled"} in the sidebar.`
    );
    toolEntrypointsCount = sidebar.toolButtons.length;
    checkedInputs = Array.from(customizeComponent.toolInputs).filter(
      input => input.checked
    );
    is(
      toolEntrypointsCount,
      checkedInputs.length,
      `The button for the ${toolInput.name} entrypoint has been ${
        toolDisabledInitialState ? "added" : "removed"
      }.`
    );
    toolInput.click();
    await BrowserTestUtils.waitForCondition(
      () => {
        let toggledTool = SidebarController.toolsAndExtensions.get(
          toolInput.id
        );
        return toggledTool.disabled === toolDisabledInitialState;
      },
      `The entrypoint for ${toolInput.name} has been ${toolDisabledInitialState ? "disabled" : "enabled"} in the sidebar.`
    );
    toolEntrypointsCount = sidebar.toolButtons.length;
    checkedInputs = Array.from(customizeComponent.toolInputs).filter(
      input => input.checked
    );
    is(
      toolEntrypointsCount,
      checkedInputs.length,
      `The button for the ${toolInput.name} entrypoint has been ${
        toolDisabledInitialState ? "removed" : "added"
      }.`
    );
    // Check ordering
    if (!toolDisabledInitialState) {
      is(
        sidebar.toolButtons[sidebar.toolButtons.length - 1].getAttribute(
          "view"
        ),
        toolInput.id,
        `The button for the ${toolInput.id} entrypoint has been added back to the end of the list of tools/extensions entrypoints`
      );
    }
  }
});

add_task(async function test_customize_not_added_in_menubar() {
  if (document.hasPendingL10nMutations) {
    await BrowserTestUtils.waitForEvent(document, "L10nMutationsFinished");
  }
  let sidebarsMenu = document.getElementById("viewSidebarMenu");
  let menuItems = sidebarsMenu.querySelectorAll("menuitem");
  ok(
    !Array.from(menuItems).find(menuitem =>
      menuitem.getAttribute("label").includes("Customize")
    ),
    "The View > Sidebars menu doesn't include any option for 'customize'."
  );
});

add_task(async function test_manage_preferences_navigation() {
  const sidebar = document.querySelector("sidebar-main");
  ok(sidebar, "Sidebar is shown.");
  await sidebar.updateComplete;
  const customizeComponent = await showCustomizePanel(window);
  let manageSettings =
    customizeComponent.shadowRoot.getElementById("manage-settings");
  manageSettings.querySelector("a").scrollIntoView();
  manageSettings.querySelector("a").click();

  await BrowserTestUtils.browserLoaded(
    window.gBrowser,
    false,
    "about:preferences"
  );
  is(
    window.gBrowser.selectedTab.linkedBrowser.currentURI.spec,
    "about:preferences",
    "Manage Settings link navigates to about:preferences."
  );
});

add_task(async function test_customize_position_setting() {
  const panel = await showCustomizePanel(window);
  const sidebarBox = document.getElementById("sidebar-box");
  ok(BrowserTestUtils.isVisible(sidebarBox), "Sidebar panel is visible");

  ok(
    !panel.positionInput.checked,
    "The sidebar positioned on the left by default."
  );
  is(
    sidebarBox.style.order,
    "3",
    "Sidebar box should have an order of 3 when on the left"
  );
  EventUtils.synthesizeMouseAtCenter(
    panel.positionInput,
    {},
    SidebarController.browser.contentWindow
  );
  await panel.updateComplete;
  ok(panel.positionInput.checked, "Sidebar is positioned on the right");

  const newWin = await BrowserTestUtils.openNewBrowserWindow();
  const newPanel = await showCustomizePanel(newWin);
  const newSidebarBox = newWin.document.getElementById("sidebar-box");
  await BrowserTestUtils.waitForCondition(
    () => BrowserTestUtils.isVisible(newSidebarBox),
    "Sidebar panel is visible"
  );
  info("Waiting for position input checked");
  await BrowserTestUtils.waitForMutationCondition(
    newPanel.positionInput,
    { attributes: true, attributeFilter: ["checked"] },
    () => newPanel.positionInput.checked
  );
  ok(newPanel.positionInput.checked, "Position setting persists.");
  is(
    newSidebarBox.style.order,
    "5",
    "Sidebar box should have an order of 5 when on the right"
  );

  await BrowserTestUtils.closeWindow(newWin);
  Services.prefs.clearUserPref(POSITION_SETTING_PREF);
});

add_task(async function test_customize_visibility_setting() {
  await SpecialPowers.pushPrefEnv({
    set: [[VERTICAL_TABS_PREF, true]],
  });
  await SidebarTestUtils.waitForTabstripOrientation(window, "vertical");

  const deferredPrefChange = Promise.withResolvers();
  const prefObserver = () => deferredPrefChange.resolve();
  Services.prefs.addObserver(SIDEBAR_VISIBILITY_PREF, prefObserver);
  registerCleanupFunction(() =>
    Services.prefs.removeObserver(SIDEBAR_VISIBILITY_PREF, prefObserver)
  );

  const panel = await showCustomizePanel(window);
  ok(!panel.visibilityInput.checked, "Always show is enabled by default.");
  ok(
    !SidebarController.sidebarContainer.hidden,
    "Launcher is shown by default."
  );
  panel.visibilityInput.click();
  await panel.updateComplete;
  ok(panel.visibilityInput.checked, "Hide sidebar is enabled.");
  ok(
    SidebarController.sidebarContainer.hidden,
    "Launcher is hidden by default."
  );
  SidebarController.hide();
  await deferredPrefChange.promise;
  const newPrefValue = Services.prefs.getStringPref(SIDEBAR_VISIBILITY_PREF);
  is(newPrefValue, "hide-sidebar", "Visibility preference updated.");

  const newWin = await BrowserTestUtils.openNewBrowserWindow();
  ok(
    newWin.SidebarController.sidebarContainer.hidden,
    "Launcher is hidden by default in new window."
  );
  const newPanel = await showCustomizePanel(newWin);
  info("Waiting for visibility input checked");
  await BrowserTestUtils.waitForMutationCondition(
    newPanel.visibilityInput,
    { attributes: true, attributeFilter: ["checked"] },
    () => newPanel.visibilityInput.checked
  );
  ok(newPanel.visibilityInput.checked, "Visibility setting persists.");

  await BrowserTestUtils.closeWindow(newWin);

  Services.prefs.clearUserPref(SIDEBAR_VISIBILITY_PREF);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_vertical_tabs_setting() {
  const panel = await showCustomizePanel(window);
  ok(
    !panel.verticalTabsInput.checked,
    "Horizontal tabs is enabled by default."
  );
  panel.verticalTabsInput.click();
  await panel.updateComplete;
  ok(panel.verticalTabsInput.checked, "Vertical tabs is enabled.");
  await SidebarTestUtils.waitForTabstripOrientation(window, "vertical");

  const newPrefValue = Services.prefs.getBoolPref(VERTICAL_TABS_PREF);
  is(newPrefValue, true, "Vertical tabs pref updated.");

  const newWin = await BrowserTestUtils.openNewBrowserWindow();
  await SidebarTestUtils.waitForTabstripOrientation(newWin, "vertical");
  const newPanel = await showCustomizePanel(newWin);
  info("Waiting for vertical tabs input checked");
  await BrowserTestUtils.waitForMutationCondition(
    newPanel.verticalTabsInput,
    { attributes: true, attributeFilter: ["checked"] },
    () => newPanel.verticalTabsInput.checked
  );
  ok(newPanel.verticalTabsInput.checked, "Vertical tabs setting persists.");

  await BrowserTestUtils.closeWindow(newWin);

  Services.prefs.clearUserPref(VERTICAL_TABS_PREF);
});

add_task(
  async function test_nested_tree_tabs_setting_preserves_vertical_tabs() {
    const treeTabsPref = "browser.tabs.verticalTabs.tree.enabled";
    await SpecialPowers.pushPrefEnv({
      set: [
        [VERTICAL_TABS_PREF, true],
        [treeTabsPref, true],
      ],
    });

    try {
      await SidebarTestUtils.waitForTabstripOrientation(window, "vertical");
      const panel = await showCustomizePanel(window);
      await panel.updateComplete;
      const treeInput = panel.shadowRoot.querySelector("#tree-vertical-tabs");
      await treeInput.updateComplete;
      is(
        treeInput.parentElement,
        panel.verticalTabsInput,
        "The real tree checkbox is nested inside the vertical-tabs checkbox"
      );
      ok(treeInput.checked, "Tree tabs are initially enabled");

      for (const checked of [false, true]) {
        const changed = BrowserTestUtils.waitForEvent(treeInput, "change");
        treeInput.click();
        await changed;
        await panel.updateComplete;
        await SidebarController.waitUntilStable();

        is(
          Services.prefs.getBoolPref(treeTabsPref),
          checked,
          "Tree pref toggled"
        );
        is(treeInput.checked, checked, "The tree checkbox reflects the pref");
        ok(
          Services.prefs.getBoolPref(VERTICAL_TABS_PREF),
          "The nested change does not disable vertical tabs"
        );
        ok(panel.verticalTabsInput.checked, "Vertical tabs remain checked");
        ok(gBrowser.tabContainer.verticalMode, "The tab strip stays vertical");
        ok(treeInput.isConnected, "The nested checkbox remains in the panel");
      }

      Services.prefs.setBoolPref(treeTabsPref, false);
      await panel.updateComplete;
      await treeInput.updateComplete;
      ok(!treeInput.checked, "External pref changes also update the checkbox");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
);

add_task(async function test_keyboard_navigation_away_from_settings_link() {
  const panel = await showCustomizePanel(window);
  const manageSettingsLink = panel.shadowRoot.querySelector(
    "#manage-settings a[href='about:preferences']"
  );
  manageSettingsLink.focus();

  Assert.equal(
    panel.shadowRoot.activeElement,
    manageSettingsLink,
    "Settings link is focused"
  );
  EventUtils.synthesizeKey("KEY_Tab", { shiftKey: true }, window);
  await panel.updateComplete;

  Assert.notEqual(
    panel.shadowRoot.activeElement,
    manageSettingsLink,
    "Settings link is not focused"
  );
});

add_task(async function test_settings_synchronized_across_windows() {
  const panel = await showCustomizePanel(window);
  const { contentWindow } = SidebarController.browser;
  const newWindow = await BrowserTestUtils.openNewBrowserWindow();
  const newPanel = await showCustomizePanel(newWindow);

  info("Update vertical tabs settings.");
  EventUtils.synthesizeMouseAtCenter(
    panel.verticalTabsInput,
    {},
    contentWindow
  );
  await newPanel.updateComplete;
  ok(
    newPanel.verticalTabsInput.checked,
    "New window shows the vertical tabs setting."
  );

  info("Update visibility settings.");
  EventUtils.synthesizeMouseAtCenter(panel.visibilityInput, {}, contentWindow);
  await newPanel.updateComplete;
  ok(
    newPanel.visibilityInput.checked,
    "New window shows the updated visibility setting."
  );

  info("Update position settings.");
  EventUtils.synthesizeMouseAtCenter(panel.positionInput, {}, contentWindow);
  await newPanel.updateComplete;
  ok(
    newPanel.positionInput.checked,
    "New window shows the updated position setting."
  );

  SidebarController.hide();
  await BrowserTestUtils.closeWindow(newWindow);
});
