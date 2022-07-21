"use strict";

requestLongerTimeout(2);

async function togglePrivate(tab, skip = false) {
  if (skip) {
    return PrivateTab.togglePrivate(window, tab);
  }
  await openTabContextMenu(tab);
  let openPrivate = document.getElementById("toggleTabPrivateState");
  openPrivate.click();
  return gBrowser.selectedTab;
}

// Test elements exist in correct locations
add_task(async function testButtonsExist() {
  let b1 = document.getElementById("openAllPrivate");
  ok(b1, "Multiple bookmark context menu item added.");
  let b2 = document.getElementById("openAllLinksPrivate");
  ok(b2, "Multiple link context menu item added.");
  let b3 = document.getElementById("openPrivate");
  ok(b3, "New private tab item added.");
  let b4 = document.getElementById("menu_newPrivateTab");
  ok(b4, "Menu item added.");
  let b5 = document.getElementById("openLinkInPrivateTab");
  ok(b5, "Link context menu item added.");
  let b6 = document.getElementById("toggleTabPrivateState");
  ok(b6, "Tab context menu item added.");
});

// Test container exists
add_task(async function testContainer() {
  ContextualIdentityService.ensureDataReady();
  let container = ContextualIdentityService._identities.find(
    c => c.name == "Private"
  );
  ok(container, "Found Private container.");
});

// Test clicking context menu item changes userContextId to match private container
add_task(async function testTogglePrivateTab() {
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser);
  is(tab.userContextId, 0, "Tab is not private");
  // Toggling private opens a duplicate tab in new container
  tab = await togglePrivate(tab);
  is(
    tab.userContextId,
    window.PrivateTab.container.userContextId,
    "Tab is private"
  );
  // Cleanup
  BrowserTestUtils.removeTab(tab);
});

// Test autofill not stored from private tab
add_task(async function testAutofillNotStored() {
  const URL =
    "http://mochi.test:8888/browser/browser/components/" +
    "sessionstore/test/browser_formdata_sample.html";

  const OUTER_VALUE = "browser_formdata_" + Math.random();
  const INNER_VALUE = "browser_formdata_" + Math.random();

  // Creates a tab, loads a page with some form fields,
  // modifies their values and closes the tab.
  async function createAndRemoveTab() {
    // Create a new tab.
    let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, URL);
    // Toggle to a private tab
    tab = await togglePrivate(tab, true);
    let browser = tab.linkedBrowser;
    await promiseBrowserLoaded(browser);

    // Modify form data.
    await setPropertyOfFormField(browser, "#txt", "value", OUTER_VALUE);
    await setPropertyOfFormField(
      browser.browsingContext.children[0],
      "#txt",
      "value",
      INNER_VALUE
    );

    // Remove the tab.
    await promiseRemoveTabAndSessionState(tab);
  }

  await createAndRemoveTab();
  let [
    {
      state: { formdata },
    },
  ] = JSON.parse(SessionStore.getClosedTabData(window));
  ok(!formdata, "Form data not stored in private tab");
});

// Test tab history not stored from private tab
add_task(async function testTabHistoryNotStored() {
  // Open a new tab
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, URI1);
  // Make it private
  tab = await togglePrivate(tab, true);
  let browser = tab.linkedBrowser;
  await promiseBrowserLoaded(browser);
  // Open a new URL
  BrowserTestUtils.loadURI(browser, URI2);
  await promiseBrowserLoaded(browser, false, URI2);
  // Remove tab to save state
  BrowserTestUtils.removeTab(tab);
  // Verify only non-private data stored
  let closedTabData = JSON.parse(SessionStore.getClosedTabData(window)).filter(
    data => {
      return (
        data.state.entries[0].url === URI1 || data.state.entries[0].url === URI2
      );
    }
  );
  let privateData = closedTabData.filter(data => {
    return data.state.isPrivate === true;
  });
  const oneClosedTabWithNoPrivateData =
    closedTabData.length === 1 && privateData.length === 0;
  is(
    oneClosedTabWithNoPrivateData,
    true,
    "Tab data not stored in private mode"
  );
});

// Test private->non-private tab is restored on restart
add_task(async function testRestoreConvertedPrivateTab() {});

/**
 * START OF SEARCH SUGGESTION BLOCK
 */

// Test search suggestions not stored from private tab
const SUGGEST_URLBAR_PREF = "browser.urlbar.suggest.searches";
const TEST_ENGINE_BASENAME = "searchSuggestionEngine.xml";

async function getSuggestionResults() {
  await UrlbarTestUtils.promiseSearchComplete(window);

  let results = [];
  let matchCount = UrlbarTestUtils.getResultCount(window);
  for (let i = 0; i < matchCount; i++) {
    let result = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    if (
      result.type == UrlbarUtils.RESULT_TYPE.SEARCH &&
      result.searchParams.suggestion
    ) {
      result.index = i;
      results.push(result);
    }
  }
  return results;
}

// Must run first.
add_task(async function prepare() {
  let suggestionsEnabled = Services.prefs.getBoolPref(SUGGEST_URLBAR_PREF);
  Services.prefs.setBoolPref(SUGGEST_URLBAR_PREF, true);
  let engine = await SearchTestUtils.promiseNewSearchEngine(
    getRootDirectory(gTestPath) + TEST_ENGINE_BASENAME
  );
  let oldDefaultEngine = await Services.search.getDefault();
  await Services.search.setDefault(engine);
  await UrlbarTestUtils.formHistory.clear();
  registerCleanupFunction(async function() {
    Services.prefs.setBoolPref(SUGGEST_URLBAR_PREF, suggestionsEnabled);
    await Services.search.setDefault(oldDefaultEngine);

    // Clicking suggestions causes visits to search results pages, so clear that
    // history now.
    await PlacesUtils.history.clear();
    await UrlbarTestUtils.formHistory.clear();
  });
});

add_task(async function testSearchSuggestionsNotStored() {
  let tab = await BrowserTestUtils.openNewForegroundTab(gBrowser);
  tab = await togglePrivate(tab, true);
  gURLBar.focus();
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "foo",
  });
  let results = await getSuggestionResults();
  ok(!results.length, "Suggestion not be stored in private tab");
  // Cleanup
  BrowserTestUtils.removeTab(tab);
});

/**
 * END OF SEARCH SUGGESTION BLOCK
 */
