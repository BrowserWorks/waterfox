/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);
const { SidebarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SidebarTestUtils.sys.mjs"
);
const { SidebarManager } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sidebar/SidebarManager.sys.mjs"
);
const FEEDS_MIGRATION_PREF = "sidebar.newTool.migration.feeds";
const FEEDS_COMMAND = "viewFeedsSidebar";
const MODIFIED_PREFS = [
  "browser.uiCustomization.state",
  "browser.uiCustomization.horizontalTabstrip",
  "browser.uiCustomization.navBarWhenVerticalTabs",
  "sidebar.new-sidebar.has-used",
  "browser.engagement.home-button.has-removed",
  "browser.engagement.sidebar-button.has-used",
  "browser.toolbarbuttons.introduced.sidebar-button",
  "sidebar.verticalTabs.dragToPinPromo.dismissed",
];

function clearModifiedPrefs() {
  for (const pref of MODIFIED_PREFS) {
    Services.prefs.clearUserPref(pref);
  }
}

async function withSidebarTransitions(task, windows = [window]) {
  await Promise.all(
    windows.map(win => SidebarTestUtils.waitForInitialized(win))
  );
  const controllers = windows.map(win => win.SidebarController);
  await Promise.all(
    controllers.map(controller => controller.waitUntilStable())
  );
  const sandbox = sinon.createSandbox();
  try {
    const transitions = controllers.map(controller =>
      sandbox.spy(controller, "toggleRevampSidebar")
    );
    await task();
    await Promise.all(
      transitions.flatMap(transition => transition.returnValues)
    );
    await Promise.all(
      controllers.map(controller => controller.waitUntilStable())
    );
  } finally {
    sandbox.restore();
  }
}

clearModifiedPrefs();
SidebarTestUtils.init(this);
SidebarTestUtils.restoreStateAtCleanup(window);
registerCleanupFunction(async () => {
  Services.fog.testResetFOG();
  await withSidebarTransitions(clearModifiedPrefs);
});

add_task(async function test_feeds_sidebar_menu_entries() {
  await withSidebarTransitions(() =>
    SpecialPowers.pushPrefEnv({
      set: [
        ["sidebar.revamp", true],
        ["sidebar.main.tools", "history,bookmarks,feeds"],
      ],
    })
  );
  const win = await BrowserTestUtils.openNewBrowserWindow();
  const sandbox = sinon.createSandbox();
  try {
    const controller = win.SidebarController;
    for (const revamp of [true, false, true]) {
      await withSidebarTransitions(
        () => Services.prefs.setBoolPref("sidebar.revamp", revamp),
        [window, win]
      );
      const menu = win.document.getElementById("menu_feedsSidebar");
      const switcher = win.document.getElementById("sidebar-switcher-feeds");
      await win.document.l10n.translateElements([menu, switcher]);
      for (const item of [menu, switcher]) {
        is(
          win.document.querySelectorAll(`#${item.id}`).length,
          1,
          `Register ${item.id} exactly once with sidebar.revamp=${revamp}`
        );
        ok(!item.hidden, `Feeds is available with sidebar.revamp=${revamp}`);
        is(
          item.dataset.l10nId,
          "sidebar-menu-feeds-label",
          "Use the Feeds label"
        );
        is(
          item.getAttribute("label"),
          "Feeds",
          "Localize the Feeds menu label"
        );
      }
      if (revamp) {
        await SidebarTestUtils.ensureLauncherVisible(win);
        await controller.waitUntilStable();
        const feedsButton = controller.sidebarMain.shadowRoot.querySelector(
          `moz-button[view="${FEEDS_COMMAND}"]`
        );
        await feedsButton?.updateComplete;
        is(
          feedsButton?.title,
          "Feeds",
          "The launcher resolves the localized Feeds label"
        );

        await SidebarTestUtils.showPanel(win, "viewCustomizeSidebar");
        await TestUtils.waitForCondition(
          () =>
            controller.browser.contentDocument
              .querySelector("sidebar-customize")
              ?.shadowRoot?.getElementById(FEEDS_COMMAND),
          "Wait for the Feeds customize checkbox"
        );
        const customizeDocument = controller.browser.contentDocument;
        const feedsInput = customizeDocument
          .querySelector("sidebar-customize")
          .shadowRoot.getElementById(FEEDS_COMMAND);
        await customizeDocument.l10n.translateElements([feedsInput]);
        is(
          feedsInput.getAttribute("label"),
          "Feeds",
          "Customize resolves the localized Feeds label"
        );
      }
      const toggle = sandbox.stub(controller, "toggle");
      menu.doCommand();
      ok(
        toggle.calledOnceWithExactly(FEEDS_COMMAND),
        "The View menu toggles Feeds"
      );
      const show = sandbox.stub(controller, "show");
      switcher.doCommand();
      ok(show.calledOnceWithExactly(FEEDS_COMMAND), "The switcher shows Feeds");
      sandbox.restore();
      SidebarTestUtils.closePanel(win);
      await controller.waitUntilStable();
    }
  } finally {
    sandbox.restore();
    SidebarTestUtils.closePanel(win);
    await win.SidebarController.waitUntilStable();
    await BrowserTestUtils.closeWindow(win);
    await withSidebarTransitions(() => SpecialPowers.popPrefEnv());
  }
});

add_task(async function test_feeds_one_time_launcher_migration() {
  await withSidebarTransitions(() =>
    SpecialPowers.pushPrefEnv({
      set: [
        ["sidebar.revamp", false],
        ["sidebar.main.tools", "history,bookmarks"],
        ["sidebar.new-sidebar.has-used", true],
        [FEEDS_MIGRATION_PREF, "{}"],
      ],
    })
  );
  try {
    await withSidebarTransitions(() =>
      Services.prefs.setBoolPref("sidebar.revamp", true)
    );
    is(
      Services.prefs.getStringPref("sidebar.main.tools"),
      "history,bookmarks,feeds",
      "Migration adds Feeds without changing existing tools or their order"
    );
    SidebarManager.updateToolsPref("feeds", true);
    SidebarManager.updateDefaultTools();
    is(
      Services.prefs.getStringPref("sidebar.main.tools"),
      "history,bookmarks",
      "The one-time migration respects a later opt-out"
    );

    Services.prefs.setStringPref(
      FEEDS_MIGRATION_PREF,
      JSON.stringify({ alreadyShown: true })
    );
    Services.prefs.setBoolPref("sidebar.new-sidebar.has-used", false);
    Services.prefs.setStringPref("sidebar.main.tools", "");
    SidebarManager.updateDefaultTools();
    ok(
      Services.prefs
        .getStringPref("sidebar.main.tools")
        .split(",")
        .includes("feeds"),
      "New sidebar users get Feeds independently of its one-time migration"
    );
  } finally {
    await withSidebarTransitions(() => SpecialPowers.popPrefEnv());
  }
});
