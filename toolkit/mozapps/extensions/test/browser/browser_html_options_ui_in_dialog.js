/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ADDON_ID = "dialog-options@mochi.test";
const OPTIONS_URL = getRootDirectory(gTestPath) + "addon_prefs.xhtml";

function getOptionsWindowCount() {
  let count = 0;
  let windows = Services.wm.getEnumerator(null);
  while (windows.hasMoreElements()) {
    let win = windows.getNext();
    if (!win.closed && win.document.documentURI == OPTIONS_URL) {
      count++;
    }
  }
  return count;
}

add_setup(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.preferences.instantApply", true]],
  });

  let provider = new MockProvider();
  provider.createAddons([
    {
      id: ADDON_ID,
      name: "Dialog options add-on",
      type: "extension",
      isWebExtension: true,
      incognito: "not_allowed",
      optionsURL: OPTIONS_URL,
      optionsType: AddonManager.OPTIONS_TYPE_DIALOG,
    },
  ]);
});

add_task(async function testLegacyDialogOptions() {
  let browserWindow = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });
  let managerWindow = await open_manager(
    "addons://list/extension",
    null,
    null,
    null,
    browserWindow
  );
  let optionsWindow;

  try {
    let card = getAddonCard(managerWindow, ADDON_ID);
    ok(card, "Found the legacy add-on card");

    let preferences = card.querySelector('[action="preferences"]');
    await TestUtils.waitForTick();
    ok(
      !preferences.hidden,
      "Legacy WebExtension dialog preferences are visible in a private window"
    );

    let optionsWindowPromise = BrowserTestUtils.domWindowOpenedAndLoaded(
      null,
      win => win.document.documentURI == OPTIONS_URL
    );
    preferences.click();
    optionsWindow = await optionsWindowPromise;

    is(
      optionsWindow.name,
      ADDON_ID,
      "The dialog uses the add-on ID as its name"
    );
    is(getOptionsWindowCount(), 1, "One options window is open");

    let loaded = waitForViewLoad(managerWindow);
    card.querySelector('[action="expand"]').click();
    await loaded;

    card = getAddonCard(managerWindow, ADDON_ID);
    preferences = card.querySelector('[action="preferences"]');
    await TestUtils.waitForTick();
    ok(!preferences.hidden, "Preferences is visible in the expanded card");

    await SimpleTest.promiseFocus(browserWindow);
    is(
      Services.focus.activeWindow,
      browserWindow,
      "The browser window is focused before reopening options"
    );

    let focused = BrowserTestUtils.waitForEvent(optionsWindow, "focus", true);
    preferences.click();
    await focused;

    is(
      Services.focus.activeWindow,
      optionsWindow,
      "The existing options window was focused"
    );
    is(getOptionsWindowCount(), 1, "The options window was reused");

    await BrowserTestUtils.closeWindow(optionsWindow);
    optionsWindow = null;
    await SpecialPowers.pushPrefEnv({
      set: [["browser.preferences.instantApply", false]],
    });
    try {
      let modalWindowPromise = BrowserTestUtils.domWindowOpenedAndLoaded(
        null,
        win => win.document.documentURI == OPTIONS_URL
      );
      executeSoon(() => preferences.click());
      optionsWindow = await modalWindowPromise;
      const appWindow = optionsWindow.docShell.treeOwner
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIAppWindow);
      ok(
        appWindow.chromeFlags & Ci.nsIWebBrowserChrome.CHROME_MODAL,
        "Non-instant-apply options open modally"
      );
      await BrowserTestUtils.closeWindow(optionsWindow);
      optionsWindow = null;
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    if (optionsWindow && !optionsWindow.closed) {
      await BrowserTestUtils.closeWindow(optionsWindow);
    }
    await close_manager(managerWindow);
    await BrowserTestUtils.closeWindow(browserWindow);
  }
});
