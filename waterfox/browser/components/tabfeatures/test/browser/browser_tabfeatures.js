/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { TabFeatures } = ChromeUtils.importESModule(
  "resource:///modules/TabFeatures.sys.mjs"
);

add_setup(async function () {
  TabFeatures.onWindowOpened(window);
});

async function openTabContextMenu(tab) {
  const menu = document.getElementById("tabContextMenu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu", button: 2 });
  await shown;
  return menu;
}

async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await hidden;
}

add_task(async function test_custom_newtab_url_application() {
  const pref = "browser.newtab.url";
  const originalURL = AboutNewTab.newTabURL;
  const originalOverridden = AboutNewTab.newTabURLOverridden;
  const fileURL = Services.io.newFileURI(
    Services.dirsvc.get("TmpD", Ci.nsIFile)
  ).spec;
  const cases = [
    ["https://example.com", "https://example.com/"],
    ["https://example.com/", "https://example.com/"],
    // eslint-disable-next-line sdl/no-insecure-url -- HTTP preferences must retain their scheme.
    ["http://example.com", "http://example.com/"],
    ["https://example.com/custom", "https://example.com/custom"],
    [
      "https://example.com?newtab=1#section",
      "https://example.com/?newtab=1#section",
    ],
    [" https://example.com ", "https://example.com/"],
    ["about:blank", "about:blank"],
    ["about:home", "about:home"],
    [" about:home ", "about:home"],
    [
      "chrome://browser/content/blanktab.html",
      "chrome://browser/content/blanktab.html",
    ],
    [fileURL, fileURL],
    ["data:text/html,newtab", "data:text/html,newtab"],
    ["https://[", "https://["],
    [" \n\t", "about:blank"],
    ["about:newtab", "about:newtab"],
    ["", "about:newtab"],
    [null, "about:newtab"],
  ];

  await SpecialPowers.pushPrefEnv({ set: [[pref, ""]] });
  try {
    for (const [input, expected] of cases) {
      info(`Applying custom new-tab preference ${JSON.stringify(input)}`);
      Services.prefs.setStringPref(pref, "https://example.org/");
      if (input === null) {
        Services.prefs.clearUserPref(pref);
      } else {
        Services.prefs.setStringPref(pref, input);
      }
      const hadUserValue = Services.prefs.prefHasUserValue(pref);

      const checkAppliedURL = source => {
        is(AboutNewTab.newTabURL, expected, `${source}: runtime URL`);
        is(
          AboutNewTab.newTabURLOverridden,
          expected !== "about:newtab",
          `${source}: override state`
        );
        is(
          Services.prefs.getStringPref(pref, ""),
          input ?? "",
          `${source}: stored preference is unchanged`
        );
        is(
          Services.prefs.prefHasUserValue(pref),
          hadUserValue,
          `${source}: preference user-value state is unchanged`
        );
      };

      checkAppliedURL("Preference observer");
      AboutNewTab.newTabURL = "about:blank";
      TabFeatures._applyNewTabURL();
      checkAppliedURL("Stored preference application");
    }
  } finally {
    try {
      await SpecialPowers.popPrefEnv();
    } finally {
      if (originalOverridden) {
        AboutNewTab.newTabURL = originalURL;
      } else {
        AboutNewTab.resetNewTabURL();
      }
    }
  }
});

add_task(async function test_custom_newtab_urlbar_focus() {
  const pref = "browser.newtab.url";
  const expectedURL = "https://example.com/";
  const originalURL = AboutNewTab.newTabURL;
  const originalOverridden = AboutNewTab.newTabURLOverridden;
  let tab;
  const onTabOpen = event => {
    tab = event.target;
  };
  registerCleanupFunction(() => {
    gBrowser.tabContainer.removeEventListener("TabOpen", onTabOpen);
    if (tab?.isConnected) {
      BrowserTestUtils.removeTab(tab);
    }
  });

  await SpecialPowers.pushPrefEnv({
    set: [
      [pref, ""],
      ["browser.search.suggest.enabled", false],
      ["browser.urlbar.autoFill", false],
    ],
  });
  try {
    // Mochitest proxies example.com to its local server.
    for (const input of ["https://example.com", expectedURL]) {
      Services.prefs.setStringPref(pref, input);
      gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen, {
        once: true,
      });
      try {
        const loaded = BrowserTestUtils.waitForNewTab(
          gBrowser,
          expectedURL,
          true
        );
        BrowserCommands.openTab();
        await loaded;
        await TestUtils.waitForTick();

        const uri = tab.linkedBrowser.currentURI;
        is(uri.spec, expectedURL, `${input}: loaded the canonical URL`);
        is(BROWSER_NEW_TAB_URL, expectedURL, `${input}: canonical override`);
        ok(isBlankPageURL(uri.spec), `${input}: recognized as a blank page`);
        ok(isInitialPage(uri), `${input}: recognized as an initial page`);
        await TestUtils.waitForCondition(
          () => gURLBar.focused,
          `${input}: new-tab command focuses the URL bar`
        );
        is(
          document.activeElement,
          gURLBar.inputField,
          `${input}: typing targets the URL bar`
        );
        is(gURLBar.value, "", `${input}: URL bar is empty after loading`);
        is(gURLBar.selectionStart, 0, `${input}: selection starts at zero`);
        is(gURLBar.selectionEnd, 0, `${input}: no trailing slash is selected`);

        EventUtils.sendString("newtab regression");
        is(
          gURLBar.value,
          "newtab regression",
          `${input}: typing starts fresh without retaining the URL`
        );
        is(
          Services.prefs.getStringPref(pref),
          input,
          `${input}: opening a new tab leaves the stored preference unchanged`
        );
      } finally {
        gBrowser.tabContainer.removeEventListener("TabOpen", onTabOpen);
        gURLBar.view.close();
        if (tab?.isConnected) {
          BrowserTestUtils.removeTab(tab);
        }
        tab = null;
      }
    }
  } finally {
    try {
      await SpecialPowers.popPrefEnv();
    } finally {
      if (originalOverridden) {
        AboutNewTab.newTabURL = originalURL;
      } else {
        AboutNewTab.resetNewTabURL();
      }
    }
  }
});

add_task(async function test_context_menu_visibility() {
  let menu = await openTabContextMenu(gBrowser.selectedTab);
  ok(
    !document.getElementById("context_copyTabUrl").hidden,
    "Copy URL shows by default"
  );
  ok(
    document.getElementById("context_copyAllTabUrls").hidden,
    "Copy all URLs hides by default"
  );
  await closeMenu(menu);

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.copyurl", false],
      ["browser.tabs.copyallurls", true],
    ],
  });
  menu = await openTabContextMenu(gBrowser.selectedTab);
  ok(
    document.getElementById("context_copyTabUrl").hidden,
    "Copy URL follows its pref"
  );
  ok(
    !document.getElementById("context_copyAllTabUrls").hidden,
    "Copy all URLs follows its pref"
  );
  await closeMenu(menu);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_duplicate_tab_pref() {
  let menu = await openTabContextMenu(gBrowser.selectedTab);
  ok(
    !document.getElementById("context_duplicateTab").hidden,
    "Duplicate Tab shows for a single tab"
  );
  ok(
    document.getElementById("context_duplicateTabs").hidden,
    "Duplicate Tabs hides for a single tab"
  );
  await closeMenu(menu);

  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.duplicateTab", false]],
  });
  menu = await openTabContextMenu(gBrowser.selectedTab);
  ok(
    document.getElementById("context_duplicateTab").hidden,
    "Duplicate Tab hides when the pref is off"
  );
  ok(
    document.getElementById("context_duplicateTabs").hidden,
    "Duplicate Tabs hides when the pref is off"
  );
  await closeMenu(menu);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_copy_tab_url() {
  const url = "https://example.com/copy-tab-url-test";
  await SimpleTest.promiseClipboardChange(url, () =>
    TabFeatures.copyTabUrl(window, url)
  );
  ok(true, "The tab URL reached the clipboard");
});

add_task(async function test_unread_attribute_and_styling() {
  const pref = "browser.tabs.italicizeUnread";
  is(
    Services.prefs.getDefaultBranch("").getBoolPref(pref),
    false,
    "Unread tab italics are off by default"
  );
  await SpecialPowers.pushPrefEnv({ clear: [[pref]] });
  const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/");
  try {
    await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
    await TestUtils.waitForCondition(
      () => tab.hasAttribute("unread"),
      "A finished background load marks the tab unread"
    );

    const fontStyle = () =>
      window.getComputedStyle(tab.querySelector(".tab-label")).fontStyle;
    is(fontStyle(), "normal", "Unread tabs use normal text by default");

    await SpecialPowers.pushPrefEnv({ set: [[pref, true]] });
    try {
      await TestUtils.waitForCondition(
        () => fontStyle() === "italic",
        "The preference change has reached the unread-tab styling"
      );
      is(fontStyle(), "italic", "Enabling the pref italicizes unread tabs");
      tab.setAttribute("pending", "true");
      is(fontStyle(), "normal", "Unloaded unread tabs are not italicized");
      tab.removeAttribute("pending");
      is(fontStyle(), "italic", "Loaded unread tabs are italicized again");
    } finally {
      tab.removeAttribute("pending");
      await SpecialPowers.popPrefEnv();
    }
    await TestUtils.waitForCondition(
      () => fontStyle() === "normal",
      "Restoring the preference updates the unread-tab styling"
    );
    is(fontStyle(), "normal", "Disabling the pref removes italics");

    await SpecialPowers.pushPrefEnv({ set: [[pref, true]] });
    try {
      await TestUtils.waitForCondition(
        () => fontStyle() === "italic",
        "Unread-tab styling is active before testing selection"
      );
      await BrowserTestUtils.switchTab(gBrowser, tab);
      ok(!tab.hasAttribute("unread"), "Selecting the tab clears unread");
      is(fontStyle(), "normal", "Read tabs are not italicized");
      tab.setAttribute("unread", "true");
      is(fontStyle(), "normal", "Selected tabs are never italicized");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
  }
});
