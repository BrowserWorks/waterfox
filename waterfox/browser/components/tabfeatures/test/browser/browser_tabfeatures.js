"use strict";

add_task(async function testCopyTabUrls() {
  // Make sure elements are present
  let copyTabUrl = document.getElementById("context_copyTabUrl");
  let copyAllTabUrls = document.getElementById("context_copyAllTabUrls");
  ok(copyTabUrl, "Copy tab URL is included");
  ok(copyAllTabUrls, "Copy all tab URLs is included");
  // Make sure that defaults are set correctly
  await openAndCloseTabContextMenu(gBrowser.selectedTab);
  is(copyTabUrl.hidden, false, "Copy tab URL visible by default");
  is(copyAllTabUrls.hidden, true, "Copy all tab URLs hidden by default");
  // Make sure changing prefs causes elements to be shown/hidden
  Services.prefs.setBoolPref(COPY_URL_PREF, false);
  Services.prefs.setBoolPref(COPY_ALL_URLS_PREF, false);
  await openAndCloseTabContextMenu(gBrowser.selectedTab);
  is(copyTabUrl.hidden, true, "Copy tab URL hidden");
  is(copyAllTabUrls.hidden, true, "Copy all tab URLs hidden");
  Services.prefs.setBoolPref(COPY_URL_PREF, true);
  Services.prefs.setBoolPref(COPY_ALL_URLS_PREF, true);
  await openAndCloseTabContextMenu(gBrowser.selectedTab);
  is(copyTabUrl.hidden, false, "Copy tab URL visible");
  is(copyAllTabUrls.hidden, false, "Copy all tab URLs visible");
  Services.prefs.clearUserPref(COPY_URL_PREF);
  Services.prefs.clearUserPref(COPY_ALL_URLS_PREF);
});

add_task(async function testHideDuplicateTab() {
  // Setting duplicateTab pref to false should hide element in all windows
  let duplicateTab = document.getElementById("context_duplicateTab");
  Services.prefs.setBoolPref(DUPLICATE_TAB_PREF, false);
  await openAndCloseTabContextMenu(gBrowser.selectedTab);
  is(duplicateTab.hidden, true, "Duplicate tab hidden");
  // Should fall back to default value of true, i.e. element showing
  Services.prefs.clearUserPref(DUPLICATE_TAB_PREF);
  // Ensure showing
  await openAndCloseTabContextMenu(gBrowser.selectedTab);
  is(duplicateTab.hidden, false, "Duplicate tab showing");
});

add_task(async function testRestartItem() {
  // Make sure element is present
  let restartBrowserMenu = document.getElementById("app_restartBrowser");
  // Need to use PanelMultiView to get PanelUI elements
  let restartBrowserApp = PanelMultiView.getViewNode(
    document,
    "appMenu-restart-button"
  );
  if (OS == "macosx") {
    ok(restartBrowserMenu, "Restart browser menu bar item is included");
    is(restartBrowserApp, null, "Restart browser appMenu item not included");
    await openAndCloseFileMenu();
    is(
      restartBrowserMenu.hidden,
      false,
      "Restart browser menu bar item is visible"
    );
  } else {
    is(
      restartBrowserMenu,
      null,
      "Restart browser menu bar item is not included"
    );
    ok(restartBrowserApp, "Restart browser appMenu item included");
  }
  // Make sure element is hidden
  Services.prefs.setBoolPref(RESTART_PREF, false);
  if (OS == "macosx") {
    await openAndCloseFileMenu();
    is(
      restartBrowserMenu.hidden,
      true,
      "Restart browser menu bar item is hidden"
    );
  }
  Services.prefs.clearUserPref(RESTART_PREF);
});

add_task(async function testCopyUrlFunctionality() {
  let copyTabUrl = document.getElementById("context_copyTabUrl");
  let copyAllTabUrls = document.getElementById("context_copyAllTabUrls");
  const tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, URI1);
  let browser = tab.linkedBrowser;
  // Test copy tab url copies URL
  await openTabContextMenu(tab);
  EventUtils.synthesizeMouseAtCenter(copyTabUrl, {});
  let tabURI = await pasteFromClipboard(browser);
  is(tabURI, URI1);
  // Test copy all tab urls
  Services.prefs.setBoolPref(COPY_ALL_URLS_PREF, true);
  const tab2 = await BrowserTestUtils.openNewForegroundTab(gBrowser, URI2);
  await openTabContextMenu(tab);
  EventUtils.synthesizeMouseAtCenter(copyAllTabUrls, {});
  let tabURIs = await pasteFromClipboard(browser);
  is(tabURIs, URI1 + "\n" + URI2);
  // Test copy active tab pref
  Services.prefs.setBoolPref(COPY_ACTIVE_URL_PREF, true);
  await openTabContextMenu(tab);
  EventUtils.synthesizeMouseAtCenter(copyTabUrl, {});
  let activeURI = await pasteFromClipboard(browser);
  // URI2 should be active, so we copy from tab1 to verify
  is(activeURI, URI2);
  // Then we verify that URI1 is copied when active pref is false
  Services.prefs.setBoolPref(COPY_ACTIVE_URL_PREF, false);
  await openTabContextMenu(tab);
  EventUtils.synthesizeMouseAtCenter(copyTabUrl, {});
  activeURI = await pasteFromClipboard(browser);
  is(activeURI, URI1);
  // Cleanup
  Services.prefs.clearUserPref(COPY_ALL_URLS_PREF);
  Services.prefs.clearUserPref(COPY_ACTIVE_URL_PREF);
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(tab2);
});
