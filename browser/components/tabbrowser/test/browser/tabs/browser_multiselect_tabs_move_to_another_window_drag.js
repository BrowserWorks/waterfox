add_task(async function test() {
  // Disable tab animations
  gReduceMotionOverride = true;

  let tab1 = await addTab();
  let tab2 = await addTab();
  let tab3 = await addTab("http://mochi.test:8888/3");
  let tab4 = await addTab();
  let tab5 = await addTab("http://mochi.test:8888/5");

  is(gBrowser.multiSelectedTabsCount, 0, "Zero multiselected tabs");

  await BrowserTestUtils.switchTab(gBrowser, tab2);
  await triggerClickOn(tab1, { ctrlKey: true });

  ok(tab1.multiselected, "Tab1 is multiselected");
  ok(tab2.multiselected, "Tab2 is multiselected");
  ok(!tab3.multiselected, "Tab3 is not multiselected");
  ok(!tab4.multiselected, "Tab4 is not multiselected");
  ok(!tab5.multiselected, "Tab5 is not multiselected");
  is(gBrowser.multiSelectedTabsCount, 2, "Two multiselected tabs");

  let newWindow = gBrowser.replaceTabsWithWindow(tab1);

  // waiting for tab2 to close ensure that the newWindow is created,
  // thus newWindow.gBrowser used in the second waitForCondition
  // will not be undefined.
  await TestUtils.waitForCondition(
    () => tab2.closing,
    "Wait for tab2 to close"
  );
  await TestUtils.waitForCondition(
    () => newWindow.gBrowser.visibleTabs.length == 2,
    "Wait for all two tabs to get moved to the new window"
  );

  let gBrowser2 = newWindow.gBrowser;
  tab1 = gBrowser2.visibleTabs[0];
  tab2 = gBrowser2.visibleTabs[1];

  if (gBrowser.selectedTab != tab3) {
    await BrowserTestUtils.switchTab(gBrowser, tab3);
  }

  await triggerClickOn(tab5, { ctrlKey: true });

  ok(tab1.multiselected, "Tab1 is multiselected");
  ok(tab2.multiselected, "Tab2 is multiselected");
  ok(tab3.multiselected, "Tab3 is multiselected");
  ok(!tab4.multiselected, "Tab4 is not multiselected");
  ok(tab5.multiselected, "Tab5 is multiselected");

  await dragAndDrop(tab3, tab1, false, newWindow);

  await TestUtils.waitForCondition(
    () => gBrowser2.visibleTabs.length == 4,
    "Moved tab3 and tab5 to second window"
  );

  tab3 = gBrowser2.visibleTabs[1];
  tab5 = gBrowser2.visibleTabs[2];

  await BrowserTestUtils.waitForCondition(
    () => getUrl(tab3) == "http://mochi.test:8888/3"
  );
  await BrowserTestUtils.waitForCondition(
    () => getUrl(tab5) == "http://mochi.test:8888/5"
  );

  ok(true, "Tab3 and tab5 are duplicated successfully");

  BrowserTestUtils.closeWindow(newWindow);
  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  }
});

add_task(async function test_laziness() {
  const params = { createLazyBrowser: true };
  const url = "http://mochi.test:8888/?";
  const tab1 = BrowserTestUtils.addTab(gBrowser, url + "1", params);
  const tab2 = BrowserTestUtils.addTab(gBrowser, url + "2");
  const tab3 = BrowserTestUtils.addTab(gBrowser, url + "3", params);

  await BrowserTestUtils.switchTab(gBrowser, tab2);
  await triggerClickOn(tab1, { ctrlKey: true });
  await triggerClickOn(tab3, { ctrlKey: true });

  is(gBrowser.selectedTab, tab2, "Tab2 is selected");
  is(gBrowser.multiSelectedTabsCount, 3, "Three multiselected tabs");
  ok(tab1.multiselected, "Tab1 is multiselected");
  ok(tab2.multiselected, "Tab2 is multiselected");
  ok(tab3.multiselected, "Tab3 is multiselected");
  ok(!tab1.linkedPanel, "Tab1 is lazy");
  ok(tab2.linkedPanel, "Tab2 is not lazy");
  ok(!tab3.linkedPanel, "Tab3 is lazy");

  const win2 = await BrowserTestUtils.openNewBrowserWindow();
  const gBrowser2 = win2.gBrowser;
  is(gBrowser2.tabs.length, 1, "Second window has 1 tab");

  await dragAndDrop(tab2, gBrowser2.tabs[0], false, win2);
  await TestUtils.waitForCondition(
    () => gBrowser2.tabs.length == 4,
    "Moved tabs into second window"
  );
  is(gBrowser2.tabs[1].linkedBrowser.currentURI.spec, url + "1");
  is(gBrowser2.tabs[2].linkedBrowser.currentURI.spec, url + "2");
  is(gBrowser2.tabs[3].linkedBrowser.currentURI.spec, url + "3");
  is(gBrowser2.selectedTab, gBrowser2.tabs[2], "Tab2 is selected");
  is(gBrowser2.multiSelectedTabsCount, 3, "Three multiselected tabs");
  ok(gBrowser2.tabs[1].multiselected, "Tab1 is multiselected");
  ok(gBrowser2.tabs[2].multiselected, "Tab2 is multiselected");
  ok(gBrowser2.tabs[3].multiselected, "Tab3 is multiselected");
  ok(!gBrowser2.tabs[1].linkedPanel, "Tab1 is lazy");
  ok(gBrowser2.tabs[2].linkedPanel, "Tab2 is not lazy");
  ok(!gBrowser2.tabs[3].linkedPanel, "Tab3 is lazy");

  await BrowserTestUtils.closeWindow(win2);
  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  }
});

add_task(async function test_pinned_tabs_new_window() {
  let menuItemPinSelectedTabs = document.getElementById(
    "context_pinSelectedTabs"
  );
  let initialTabsLength = gBrowser.tabs.length;

  let newTab1 = await BrowserTestUtils.addTab(gBrowser, "about:robots", {
    skipAnimation: true,
  });
  let newTab2 = await BrowserTestUtils.addTab(gBrowser, "about:about", {
    skipAnimation: true,
  });
  let newTab3 = await BrowserTestUtils.addTab(gBrowser, "about:config", {
    skipAnimation: true,
  });
  is(gBrowser.tabs.length, initialTabsLength + 3, "Three new tabs are opened");

  await BrowserTestUtils.switchTab(gBrowser, newTab1);
  await triggerClickOn(newTab2, { ctrlKey: true });

  ok(newTab1.multiselected, "Tab1 is multiselected");
  ok(newTab2.multiselected, "Tab2 is multiselected");
  ok(!newTab3.multiselected, "Tab3 is not multiselected");

  let tab1Pinned = BrowserTestUtils.waitForEvent(newTab1, "TabPinned");
  let tab2Pinned = BrowserTestUtils.waitForEvent(newTab2, "TabPinned");
  menuItemPinSelectedTabs.click();

  await tab1Pinned;
  await tab2Pinned;

  ok(newTab1.pinned, "Tab1 is pinned");
  ok(newTab2.pinned, "Tab2 is pinned");
  ok(!newTab3.pinned, "Tab3 is not pinned");

  // Work around for bug 1975186
  await BrowserTestUtils.switchTab(gBrowser, newTab2);
  await triggerClickOn(newTab1, { ctrlKey: true });

  ok(newTab1.multiselected, "Tab1 is multiselected");
  ok(newTab2.multiselected, "Tab2 is multiselected");
  ok(!newTab3.multiselected, "Tab3 is not multiselected");

  let newWindow = gBrowser.replaceTabsWithWindow(newTab2);
  await BrowserTestUtils.waitForEvent(newWindow, "DOMContentLoaded");

  await TestUtils.waitForCondition(
    () => newWindow.gBrowser.tabs.length == 2,
    "Wait for all two tabs to get moved to the new window"
  );
  ok(newWindow.gBrowser.tabs[0].pinned, "Tab1 is pinned");
  ok(!newWindow.gBrowser.tabs[1].pinned, "Tab2 is unpinned");

  let newWindowTab1 = getUrl(newWindow.gBrowser.tabs[0]);
  let newWindowTab2 = getUrl(newWindow.gBrowser.tabs[1]);
  let pinnedTabContainer = newWindow.document.getElementById(
    "pinned-tabs-container"
  );

  is(
    pinnedTabContainer.children.length,
    1,
    "New window has one tab in the pinned tabs container"
  );
  is(newWindowTab1, "about:robots", "Tab 1 is pinned in new window");
  is(
    newWindowTab2,
    "about:about",
    "Tab 2 was selected tab and is unpinned in new window"
  );

  while (gBrowser.tabs.length > 1) {
    BrowserTestUtils.removeTab(gBrowser.tabs.at(-1));
  }
  await BrowserTestUtils.closeWindow(newWindow);
});
