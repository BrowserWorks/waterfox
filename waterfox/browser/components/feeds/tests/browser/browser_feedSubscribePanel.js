/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { FeedLocationBar } = ChromeUtils.importESModule(
  "resource:///modules/FeedLocationBar.sys.mjs"
);
const { FeedSubscribePanel } = ChromeUtils.importESModule(
  "resource:///modules/FeedSubscribePanel.sys.mjs"
);
const { LiveBookmarks } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarks.sys.mjs"
);
const { LiveBookmarksUI } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarksUI.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const FEED = ROOT + "feed.xml";
const PAGE = ROOT + "feed-discovery.html";
const EMPTY = ROOT + "feed-empty.html";
const ACTION_ID = "waterfox-feeds";
const BUTTON_ID = "pageAction-urlbar-waterfox-feeds";
const PANEL_ID = "waterfox-feed-subscribe-panel";
const OFFER_SELECTOR = '[data-l10n-id="feeds-menu-subscribe"]';

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["ui.prefersReducedMotion", 1]],
  });
  await LiveBookmarks.init();
  await TestUtils.waitForCondition(
    () => LiveBookmarksUI._ready,
    "Wait for subscription notifications to update browser windows"
  );
});

async function loadPage(win, url) {
  const browser = win.gBrowser.selectedBrowser;
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await loaded;
}

async function waitForFeeds(win, urls, discovered = urls) {
  await TestUtils.waitForCondition(
    () => {
      const state = FeedLocationBar._states.get(win);
      const button = win.document.getElementById(BUTTON_ID);
      const action = PageActions.actionForID(ACTION_ID);
      return (
        state?.browser === win.gBrowser.selectedBrowser &&
        state.global === state.browser.browsingContext.currentWindowGlobal &&
        JSON.stringify(state.feeds.map(feed => feed.feedURL)) ===
          JSON.stringify(urls) &&
        JSON.stringify(state.discoveredFeeds?.map(feed => feed.feedURL)) ===
          JSON.stringify(discovered) &&
        action.getDisabled(win) === !urls.length &&
        action.getWantsSubview(win) === urls.length > 1 &&
        !!(button && BrowserTestUtils.isVisible(button)) === !!urls.length
      );
    },
    `Offer only available feeds: ${JSON.stringify(urls)}`
  );
}

async function withFeedTest(task) {
  const windows = [];
  const folders = [];
  const baseline = LiveBookmarks.list();
  const baselineGuids = new Set(baseline.map(sub => sub.guid));
  const requests = [];
  const addedBookmarks = [];
  const onBookmarksAdded = events => addedBookmarks.push(...events);
  PlacesUtils.observers.addListener(["bookmark-added"], onBookmarksAdded);
  const observer = subject => {
    const url = subject.QueryInterface(Ci.nsIHttpChannel).URI.spec;
    if (url.startsWith(FEED)) {
      requests.push(url);
    }
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  let cleanedUp = false;
  async function cleanup() {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    Services.obs.removeObserver(observer, "http-on-modify-request");
    PlacesUtils.observers.removeListener(["bookmark-added"], onBookmarksAdded);
    for (const win of windows.reverse()) {
      if (!win.closed) {
        await BrowserTestUtils.closeWindow(win);
      }
    }
    for (const sub of LiveBookmarks.list()) {
      if (!baselineGuids.has(sub.guid) && sub.feedURL.startsWith(FEED)) {
        await LiveBookmarks.remove(sub.guid);
      }
    }
    const createdGuids = new Set([
      ...folders,
      ...addedBookmarks.map(event => event.guid),
    ]);
    for (const guid of [...createdGuids].reverse()) {
      if (await PlacesUtils.bookmarks.fetch(guid)) {
        await PlacesUtils.bookmarks.remove(guid);
      }
    }
  }
  registerCleanupFunction(cleanup);
  const context = {
    baseline,
    requests,
    addedBookmarks,
    folders,
    openedTabs: 0,
    expectedTabs: 0,
    async openWindow() {
      const win = await BrowserTestUtils.openNewBrowserWindow();
      windows.push(win);
      win.gBrowser.tabContainer.addEventListener("TabOpen", () => {
        context.openedTabs++;
      });
      await SimpleTest.promiseFocus(win);
      await loadPage(win, PAGE);
      await waitForFeeds(win, [FEED]);
      return win;
    },
    async createFolder(parentGuid, title) {
      const folder = await PlacesUtils.bookmarks.insert({
        parentGuid,
        title,
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
      });
      folders.push(folder.guid);
      return folder;
    },
  };
  try {
    await task(context);
    is(
      context.openedTabs,
      context.expectedTabs,
      "Only an explicit Manage command may add a tab"
    );
  } finally {
    await cleanup();
  }
}

function field(win, suffix) {
  return win.document.getElementById(`waterfox-feed-${suffix}`);
}

function setField(win, suffix, value) {
  const input = field(win, suffix);
  input.value = value;
  input.dispatchEvent(new win.Event("input", { bubbles: true }));
}

function assertNoSubscription(context) {
  Assert.deepEqual(
    LiveBookmarks.list(),
    context.baseline,
    "Do not create early"
  );
  Assert.deepEqual(context.requests, [], "Do not fetch before Subscribe");
  Assert.deepEqual(
    context.addedBookmarks.map(event => event.guid),
    context.folders,
    "Do not add bookmarks or folders beyond the explicit test fixtures"
  );
}

function assertForm(win, feedURL, title) {
  const panel = win.document.getElementById(PANEL_ID);
  is(panel.localName, "panel", "Use the native subscription popup");
  is(panel.getAttribute("role"), "dialog", "Expose a subscription dialog");
  is(field(win, "title").value, title, "Prefill the advertised title");
  is(field(win, "url").value, feedURL, "Prefill the canonical feed URL");
  is(
    field(win, "folder").localName,
    "menulist",
    "Use a native folder menulist"
  );
  is(
    field(win, "folder").value,
    PlacesUtils.bookmarks.menuGuid,
    "Always start in Bookmarks Menu"
  );
  ok(!field(win, "folder-tree"), "Create the Places tree lazily");
  ok(!field(win, "subscribe").disabled, "Allow an explicit subscription");
  ok(field(win, "subscribe-error").hidden, "Start without an error");
  ok(field(win, "subscribe-status").hidden, "Do not start busy");
}

function waitForSubscribePanel(win) {
  return BrowserTestUtils.waitForEvent(
    win.document,
    "popupshown",
    true,
    event => event.target.id === PANEL_ID
  ).then(event => event.target);
}

async function openDirectPanel(win) {
  ok(
    !PageActions.actionForID(ACTION_ID).getWantsSubview(win),
    "One available feed skips the chooser"
  );
  const shown = waitForSubscribePanel(win);
  EventUtils.synthesizeMouseAtCenter(
    win.document.getElementById(BUTTON_ID),
    {},
    win
  );
  const panel = await shown;
  ok(
    !win.BrowserPageActions.activatedActionPanelNode ||
      win.BrowserPageActions.activatedActionPanelNode.state === "closed",
    "Do not open the PageActions chooser for one feed"
  );
  return panel;
}

async function cancelPanel(win) {
  const panel = win.document.getElementById(PANEL_ID);
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  EventUtils.synthesizeMouseAtCenter(field(win, "cancel"), {}, win);
  await hidden;
  ok(!win.document.getElementById(PANEL_ID), "Discard the form on Cancel");
}

async function subscribe(win, feedURL, { useEnter = false } = {}) {
  const panel = win.document.getElementById(PANEL_ID);
  const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
  const button = field(win, "subscribe");
  if (useEnter) {
    button.focus();
    is(win.document.activeElement, button, "Focus the Subscribe button");
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
  } else {
    EventUtils.synthesizeMouseAtCenter(button, {}, win);
  }
  await hidden;
  await TestUtils.waitForCondition(
    () => LiveBookmarks.getByFeedURL(feedURL),
    "Store the explicitly submitted subscription"
  );
  return LiveBookmarks.getByFeedURL(feedURL);
}

function offerURLs(popup) {
  return [...popup.querySelectorAll(OFFER_SELECTOR)].map(
    item => item.ownerDocument.l10n.getAttributes(item).args.url
  );
}

async function discoveryMenu(win, urls) {
  const popup = win.document.querySelector("#waterfox-feeds-menu menupopup");
  await LiveBookmarksUI.populateDiscovery(popup);
  Assert.deepEqual(
    offerURLs(popup),
    urls,
    "The native menu filters subscribed URLs"
  );
  return popup;
}

async function setAdvertisements(win, feeds) {
  await SpecialPowers.spawn(win.gBrowser.selectedBrowser, [feeds], entries => {
    const doc = content.document;
    doc.querySelectorAll("link").forEach(link => link.remove());
    for (const { feedURL, title } of entries) {
      const link = doc.createElement("link");
      link.rel = "alternate";
      link.type = "application/rss+xml";
      link.href = feedURL;
      link.title = title;
      doc.head.appendChild(link);
    }
  });
  await waitForFeeds(
    win,
    feeds.map(feed => feed.feedURL)
  );
}

async function openChooser(win, urls) {
  ok(
    PageActions.actionForID(ACTION_ID).getWantsSubview(win),
    "Use the chooser"
  );
  const shown = BrowserTestUtils.waitForEvent(
    win.document,
    "popupshown",
    true,
    event => event.target.getAttribute("actionID") === ACTION_ID
  );
  EventUtils.synthesizeMouseAtCenter(
    win.document.getElementById(BUTTON_ID),
    {},
    win
  );
  const panel = (await shown).target;
  is(
    panel,
    win.BrowserPageActions.activatedActionPanelNode,
    "Reuse PageActions"
  );
  Assert.deepEqual(offerURLs(panel), urls, "Only offer unsubscribed feeds");
  return panel;
}

async function chooseFeed(win, chooser, index) {
  const hidden = BrowserTestUtils.waitForPopupEvent(chooser, "hidden");
  const shown = waitForSubscribePanel(win);
  EventUtils.synthesizeMouseAtCenter(
    chooser.querySelectorAll(OFFER_SELECTOR)[index],
    {},
    win
  );
  await hidden;
  await shown;
  is(chooser.state, "closed", "Close the chooser before displaying the form");
}

async function chooseFolder(win, guid = null) {
  const menulist = field(win, "folder");
  const popup = menulist.menupopup;
  const item = guid
    ? popup.querySelector(`[value="${guid}"]`)
    : popup.lastElementChild;
  ok(item, "Find the native folder choice");
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  EventUtils.synthesizeMouseAtCenter(menulist, {}, win);
  await shown;
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  if (popup.isNativeMenu) {
    popup.activateItem(item);
  } else {
    EventUtils.synthesizeMouseAtCenter(item, {}, win);
  }
  await hidden;
  if (guid) {
    is(menulist.value, guid, "Select the requested root");
    return null;
  }
  await TestUtils.waitForCondition(
    () => field(win, "folder-tree")?.view,
    "Choose another folder creates a live Places tree"
  );
  const tree = field(win, "folder-tree");
  is(tree.getAttribute("is"), "places-tree", "Use the native Places tree");
  ok(BrowserTestUtils.isVisible(tree), "Show the folder tree");
  return tree;
}

async function selectNestedFolder(win, tree, parent, nested) {
  tree.selectItems([parent.guid]);
  await TestUtils.waitForCondition(
    () => tree.selectedNode?.bookmarkGuid === parent.guid,
    "Select the parent in the real Places view"
  );
  tree.focus();
  if (!tree.view.isContainerOpen(tree.currentIndex)) {
    EventUtils.synthesizeKey("KEY_ArrowRight", {}, win);
  }
  EventUtils.synthesizeKey("KEY_ArrowDown", {}, win);
  await TestUtils.waitForCondition(
    () => field(win, "folder").value === nested.guid,
    "Keyboard selection of a nested folder updates the destination"
  );
  is(
    tree.selectedNode.bookmarkGuid,
    nested.guid,
    "Select the actual nested node"
  );
  is(field(win, "folder").label, nested.title, "Show the nested folder title");
}

function observeTreeCleanup(tree, sandbox) {
  const controllers = tree.controllers;
  const view = tree.view;
  const terminate = sandbox.spy(tree.controller, "terminate");
  const originalUninit = view.uninit;
  const uninit = sandbox.stub(view, "uninit").callsFake(function () {
    ok(tree.isConnected, "Uninitialize the view before detaching the tree");
    is(
      controllers.getControllerCount(),
      0,
      "Unregister the controller before uninitializing the view"
    );
    return originalUninit.call(this);
  });
  is(controllers.getControllerCount(), 1, "Register the Places controller");

  return () => {
    is(terminate.callCount, 1, "Terminate the controller exactly once");
    is(uninit.callCount, 1, "Uninitialize the view exactly once");
    ok(terminate.calledBefore(uninit), "Terminate before uninitializing");
    is(controllers.getControllerCount(), 0, "Empty the original controllers");
    is(tree.controller, null, "Clear the Places controller reference");
    is(tree.view, null, "Clear the Places view reference");
    ok(!tree.isConnected, "Detach the Places tree");
  };
}

function deferFirstCall(sandbox, object, method, matches = () => true) {
  const original = object[method].bind(object);
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  let deferred = false;
  sandbox.stub(object, method).callsFake(async (...args) => {
    if (!deferred && matches(...args)) {
      deferred = true;
      entered.resolve();
      await released.promise;
    }
    return original(...args);
  });
  return { entered: entered.promise, release: released.resolve };
}

add_task(async function explicit_subscription_filters_by_url_not_title() {
  await withFeedTest(async context => {
    const win = await context.openWindow();
    await discoveryMenu(win, [FEED]);
    await openDirectPanel(win);
    assertForm(win, FEED, "Integration feed");
    setField(win, "title", "My renamed subscription");
    setField(
      win,
      "url",
      FEED.replace("https://example.com", "https://EXAMPLE.com:443") + "#saved"
    );
    assertNoSubscription(context);
    const sub = await subscribe(win, FEED);
    const folder = await PlacesUtils.bookmarks.fetch(sub.guid);
    is(folder.title, "My renamed subscription", "Preserve the submitted title");
    is(folder.parentGuid, PlacesUtils.bookmarks.menuGuid, "Use Bookmarks Menu");
    is(
      LiveBookmarks.peek(sub.guid).status,
      "ready",
      "Download and parse the real RSS"
    );
    is(
      LiveBookmarks.getByFeedURL(FEED + "#other").guid,
      sub.guid,
      "Ignore fragments"
    );
    await waitForFeeds(win, [], [FEED]);
    let menu = await discoveryMenu(win, []);
    ok(
      menu.querySelector('[data-l10n-id="feeds-menu-all-subscribed"]')
        ?.disabled,
      "Explain that every advertised feed is already subscribed"
    );
    await PlacesUtils.bookmarks.update({
      guid: sub.guid,
      title: "Renamed again",
    });
    await TestUtils.waitForCondition(
      () => LiveBookmarks.get(sub.guid)?.title === "Renamed again",
      "Observe the real Places rename"
    );
    await waitForFeeds(win, [], [FEED]);
    await discoveryMenu(win, []);
    Assert.deepEqual(
      context.requests,
      [FEED],
      "Renaming and filtering never fetch again"
    );

    await LiveBookmarks.remove(sub.guid);
    await waitForFeeds(win, [FEED]);
    menu = await discoveryMenu(win, [FEED]);
    const shown = waitForSubscribePanel(win);
    menu.querySelector(OFFER_SELECTOR).doCommand();
    await shown;
    assertForm(win, FEED, "Integration feed");
    await cancelPanel(win);
    Assert.deepEqual(
      LiveBookmarks.list(),
      context.baseline,
      "Cancel does not resubscribe"
    );
    Assert.deepEqual(
      context.requests,
      [FEED],
      "Removal restores discovery without a fetch"
    );
  });
});

add_task(
  async function remaining_feeds_switch_between_chooser_and_direct_popup() {
    await withFeedTest(async context => {
      const win = await context.openWindow();
      const second = FEED + "?second";
      const third = FEED + "?third";
      await setAdvertisements(win, [
        { feedURL: FEED, title: "Shared advertised title" },
        { feedURL: second, title: "Second advertised title" },
        { feedURL: third, title: "Shared advertised title" },
      ]);
      let chooser = await openChooser(win, [FEED, second, third]);
      assertNoSubscription(context);
      await chooseFeed(win, chooser, 1);
      assertForm(win, second, "Second advertised title");
      assertNoSubscription(context);
      const secondSub = await subscribe(win, second);
      await waitForFeeds(win, [FEED, third], [FEED, second, third]);
      await discoveryMenu(win, [FEED, third]);
      chooser = await openChooser(win, [FEED, third]);
      await chooseFeed(win, chooser, 0);
      assertForm(win, FEED, "Shared advertised title");
      await subscribe(win, FEED);
      await waitForFeeds(win, [third], [FEED, second, third]);
      await discoveryMenu(win, [third]);
      await openDirectPanel(win);
      assertForm(win, third, "Shared advertised title");
      await cancelPanel(win);
      Assert.deepEqual(
        context.requests,
        [second, FEED],
        "Only submitted feeds are fetched"
      );

      await LiveBookmarks.remove(secondSub.guid);
      await waitForFeeds(win, [second, third], [FEED, second, third]);
      chooser = await openChooser(win, [second, third]);
      const opened = BrowserTestUtils.waitForNewTab(
        win.gBrowser,
        "about:feeds",
        true
      );
      const hidden = BrowserTestUtils.waitForPopupEvent(chooser, "hidden");
      context.expectedTabs++;
      EventUtils.synthesizeMouseAtCenter(
        chooser.querySelector('[data-l10n-id="feeds-menu-manage"]'),
        {},
        win
      );
      const tab = await opened;
      await hidden;
      is(
        tab.linkedBrowser.currentURI.spec,
        "about:feeds",
        "Only Manage opens the manager"
      );
      Assert.deepEqual(
        context.requests,
        [second, FEED],
        "Manage does not fetch a preview"
      );
    });
  }
);

add_task(async function root_and_nested_destinations_are_explicit() {
  await withFeedTest(async context => {
    const win = await context.openWindow();
    const bookmarks = PlacesUtils.bookmarks;
    const parent = await context.createFolder(
      bookmarks.unfiledGuid,
      "Feed destinations"
    );
    const nested = await context.createFolder(
      parent.guid,
      "Nested destination"
    );
    await openDirectPanel(win);
    assertForm(win, FEED, "Integration feed");
    const menulist = field(win, "folder");
    const roots = [
      bookmarks.menuGuid,
      bookmarks.toolbarGuid,
      bookmarks.unfiledGuid,
      bookmarks.mobileGuid,
    ];
    Assert.deepEqual(
      [...menulist.menupopup.querySelectorAll("menuitem[value]")].map(
        item => item.value
      ),
      roots,
      "Initially list only bookmark roots, not every folder"
    );
    const rootLabels = [
      "BookmarksMenuFolderTitle",
      "BookmarksToolbarFolderTitle",
      "OtherBookmarksFolderTitle",
      "MobileBookmarksFolderTitle",
    ].map(name => PlacesUtils.getString(name));
    Assert.deepEqual(
      [...menulist.menupopup.querySelectorAll("menuitem[value]")].map(
        item => item.label
      ),
      rootLabels,
      "Use the bookmark UI's localized root names, not database titles"
    );
    is(
      menulist.label,
      rootLabels[0],
      "Display the localized default destination"
    );
    is(
      menulist.menupopup.lastElementChild.getAttribute("data-l10n-id"),
      "feeds-subscribe-choose-folder",
      "Keep Choose another folder last"
    );
    for (const [index, guid] of roots.entries()) {
      await chooseFolder(win, guid);
      is(
        menulist.label,
        rootLabels[index],
        "Keep the selected root's user-facing name"
      );
      ok(!field(win, "folder-tree"), "Root choices do not build the tree");
    }
    const sandbox = sinon.createSandbox();
    try {
      const cancelledTree = await chooseFolder(win);
      await selectNestedFolder(win, cancelledTree, parent, nested);
      const assertCancelledCleanup = observeTreeCleanup(cancelledTree, sandbox);
      assertNoSubscription(context);
      await cancelPanel(win);
      assertCancelledCleanup();
      assertNoSubscription(context);

      await openDirectPanel(win);
      assertForm(win, FEED, "Integration feed");
      const tree = await chooseFolder(win);
      isnot(tree, cancelledTree, "Create a fresh tree after cancellation");
      await selectNestedFolder(win, tree, parent, nested);
      const assertSubscribedCleanup = observeTreeCleanup(tree, sandbox);
      setField(win, "title", "Nested live bookmark");
      const sub = await subscribe(win, FEED, { useEnter: true });
      is(
        (await bookmarks.fetch(sub.guid)).parentGuid,
        nested.guid,
        "Create only in the selected nested folder"
      );
      assertSubscribedCleanup();
      assertCancelledCleanup();
      await LiveBookmarks.remove(sub.guid);
      await waitForFeeds(win, [FEED]);
    } finally {
      sandbox.restore();
    }
    await openDirectPanel(win);
    assertForm(win, FEED, "Integration feed");
    await chooseFolder(win, bookmarks.unfiledGuid);
    const rootSub = await subscribe(win, FEED);
    is(
      (await bookmarks.fetch(rootSub.guid)).parentGuid,
      bookmarks.unfiledGuid,
      "Honor an explicitly selected root instead of the default Menu"
    );
  });
});

add_task(async function navigation_and_window_close_dispose_expanded_trees() {
  await withFeedTest(async context => {
    const win = await context.openWindow();
    const parent = await context.createFolder(
      PlacesUtils.bookmarks.menuGuid,
      "Lifecycle destinations"
    );
    const nested = await context.createFolder(
      parent.guid,
      "Nested destination"
    );
    const sandbox = sinon.createSandbox();
    try {
      const panel = await openDirectPanel(win);
      const tree = await chooseFolder(win);
      await selectNestedFolder(win, tree, parent, nested);
      const assertNavigationCleanup = observeTreeCleanup(tree, sandbox);
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      await loadPage(win, EMPTY);
      await hidden;
      await waitForFeeds(win, []);
      ok(!win.document.getElementById(PANEL_ID), "Discard the navigated popup");
      assertNavigationCleanup();
      assertNoSubscription(context);

      await loadPage(win, PAGE);
      await waitForFeeds(win, [FEED]);
      await openDirectPanel(win);
      const closingTree = await chooseFolder(win);
      isnot(closingTree, tree, "Create a fresh tree after navigation");
      await selectNestedFolder(win, closingTree, parent, nested);
      const assertWindowCleanup = observeTreeCleanup(closingTree, sandbox);
      await BrowserTestUtils.closeWindow(win);
      ok(win.closed, "Close the window with an expanded folder tree");
      assertWindowCleanup();
      assertNavigationCleanup();
      assertNoSubscription(context);
    } finally {
      sandbox.restore();
    }
  });
});

add_task(async function folder_tree_initialization_failure_can_be_retried() {
  await withFeedTest(async context => {
    const win = await context.openWindow();
    await openDirectPanel(win);
    const initialTree = await chooseFolder(win);
    await cancelPanel(win);
    await openDirectPanel(win);

    const sandbox = sinon.createSandbox();
    let failedTree;
    let assertFailedCleanup;
    const selectItems = sandbox
      .stub(win.customElements.get("places-tree").prototype, "selectItems")
      .callsFake(function () {
        failedTree = this;
        assertFailedCleanup = observeTreeCleanup(this, sandbox);
        throw new Error("Injected folder selection initialization failure");
      });
    try {
      const menulist = field(win, "folder");
      menulist.selectedItem = menulist.menupopup.lastElementChild;
      menulist.dispatchEvent(new win.Event("command", { bubbles: true }));
      ok(failedTree, "Fail initialization after creating a live Places view");
      assertFailedCleanup();
      ok(!field(win, "folder-tree"), "Remove the partially initialized tree");
      ok(!field(win, "subscribe-error").hidden, "Show the folder error");
      is(
        field(win, "subscribe-error").getAttribute("data-l10n-id"),
        "feeds-subscribe-folder-error",
        "Identify the folder initialization failure"
      );
      assertNoSubscription(context);

      selectItems.restore();
      const tree = await chooseFolder(win);
      isnot(tree, failedTree, "Create a fresh tree on retry");
      isnot(tree, initialTree, "Do not reuse the first panel's tree");
      is(
        PlacesUtils.getConcreteItemGuid(tree.selectedNode),
        PlacesUtils.bookmarks.menuGuid,
        "Select the default destination in the retried view"
      );
      const assertRetriedCleanup = observeTreeCleanup(tree, sandbox);
      await cancelPanel(win);
      assertRetriedCleanup();
      assertFailedCleanup();
      assertNoSubscription(context);
    } finally {
      sandbox.restore();
    }
  });
});

add_task(
  async function invalid_url_can_be_corrected_without_losing_the_title() {
    await withFeedTest(async context => {
      const win = await context.openWindow();
      await openDirectPanel(win);
      setField(win, "title", "Keep my title on retry");
      for (const url of [
        "not a URL",
        "javascript:alert(1)",
        "https://user:pass@example.com/feed.xml",
      ]) {
        setField(win, "url", url);
        EventUtils.synthesizeMouseAtCenter(field(win, "subscribe"), {}, win);
        await TestUtils.waitForCondition(
          () => !field(win, "subscribe-error").hidden,
          "Reject an invalid subscription URL in the panel"
        );
        is(
          field(win, "subscribe-error").getAttribute("data-l10n-id"),
          "feeds-subscribe-invalid-url",
          "Explain the URL validation error"
        );
        is(
          field(win, "url").getAttribute("aria-invalid"),
          "true",
          "Mark the invalid field"
        );
        is(
          win.document.activeElement,
          field(win, "url"),
          "Focus the URL for correction"
        );
        ok(!field(win, "subscribe").disabled, "Allow a retry");
        assertNoSubscription(context);
      }
      setField(win, "url", FEED);
      ok(field(win, "subscribe-error").hidden, "Editing clears the error");
      ok(
        !field(win, "url").hasAttribute("aria-invalid"),
        "Clear the invalid state"
      );
      const sub = await subscribe(win, FEED);
      is(
        sub.title,
        "Keep my title on retry",
        "Preserve the title across validation errors"
      );
      Assert.deepEqual(
        context.requests,
        [FEED],
        "Only the corrected URL is downloaded"
      );
    });
  }
);

add_task(async function destination_removed_during_submission_can_be_retried() {
  await withFeedTest(async context => {
    const win = await context.openWindow();
    const parent = await context.createFolder(
      PlacesUtils.bookmarks.menuGuid,
      "Temporary parent"
    );
    const nested = await context.createFolder(
      parent.guid,
      "Removed destination"
    );
    await openDirectPanel(win);
    const tree = await chooseFolder(win);
    await selectNestedFolder(win, tree, parent, nested);
    setField(win, "title", "Retry in another folder");
    const sandbox = sinon.createSandbox();
    const create = sandbox.spy(LiveBookmarks, "create");
    const deferred = deferFirstCall(sandbox, LiveBookmarks, "_fetch");
    try {
      EventUtils.synthesizeMouseAtCenter(field(win, "subscribe"), {}, win);
      await deferred.entered;
      ok(
        field(win, "subscribe").disabled,
        "Prevent double submission while busy"
      );
      await PlacesUtils.bookmarks.remove(nested.guid);
      deferred.release();
      await TestUtils.waitForCondition(
        () => !field(win, "subscribe-error").hidden,
        "Report a destination removed while downloading"
      );
      is(
        field(win, "subscribe-error").getAttribute("data-l10n-id"),
        "feeds-subscribe-folder-error",
        "Identify the removed destination"
      );
      is(
        field(win, "folder").getAttribute("aria-invalid"),
        "true",
        "Mark the folder invalid"
      );
      Assert.deepEqual(
        LiveBookmarks.list(),
        context.baseline,
        "Do not create a partial subscription"
      );
      Assert.deepEqual(
        context.addedBookmarks.map(event => event.guid),
        context.folders,
        "Do not leave a partially created bookmark folder"
      );
      ok(!field(win, "cancel").disabled, "Re-enable Cancel after the error");
      ok(!field(win, "subscribe").disabled, "Allow retrying the subscription");
    } finally {
      deferred.release();
      await Promise.allSettled(create.returnValues);
      sandbox.restore();
    }
    await chooseFolder(win, PlacesUtils.bookmarks.toolbarGuid);
    ok(
      field(win, "subscribe-error").hidden,
      "Choosing a valid folder clears the error"
    );
    const sub = await subscribe(win, FEED);
    const saved = await PlacesUtils.bookmarks.fetch(sub.guid);
    is(
      saved.parentGuid,
      PlacesUtils.bookmarks.toolbarGuid,
      "Retry in the new destination"
    );
    is(
      saved.title,
      "Retry in another folder",
      "Keep the edited title on retry"
    );
  });
});

async function preparePanelInitialization(win) {
  // Cache the stylesheet and settle discovery before deferring the popup's init.
  const shown = waitForSubscribePanel(win);
  await FeedSubscribePanel.open(win, FeedLocationBar._states.get(win).feeds[0]);
  await shown;
  await cancelPanel(win);
  await FeedLocationBar.update(win);
}

add_task(
  async function stale_panel_initialization_does_not_replace_the_current_form() {
    await withFeedTest(async context => {
      const win = await context.openWindow();
      const second = FEED + "?newer";
      await setAdvertisements(win, [
        { feedURL: FEED, title: "Old request" },
        { feedURL: second, title: "New request" },
      ]);
      await preparePanelInitialization(win);
      const sandbox = sinon.createSandbox();
      const deferred = deferFirstCall(sandbox, LiveBookmarks, "init");
      const oldRequest = FeedSubscribePanel.open(win, {
        feedURL: FEED,
        title: "Old request",
      });
      try {
        await deferred.entered;
        const shown = waitForSubscribePanel(win);
        await FeedSubscribePanel.open(win, {
          feedURL: second,
          title: "New request",
        });
        await shown;
        deferred.release();
        await oldRequest;
        assertForm(win, second, "New request");
        is(
          win.document.querySelectorAll(`#${PANEL_ID}`).length,
          1,
          "Keep only the latest form"
        );
        assertNoSubscription(context);
        await cancelPanel(win);
      } finally {
        deferred.release();
        await Promise.allSettled([oldRequest]);
        sandbox.restore();
      }
    });
  }
);

add_task(async function navigation_discards_pending_panel_initialization() {
  await withFeedTest(async context => {
    const win = await context.openWindow();
    await preparePanelInitialization(win);
    const sandbox = sinon.createSandbox();
    const deferred = deferFirstCall(sandbox, LiveBookmarks, "init");
    let shownPanels = 0;
    const onShown = event => {
      if (event.target.id === PANEL_ID) {
        shownPanels++;
      }
    };
    win.document.addEventListener("popupshown", onShown);
    const opening = FeedSubscribePanel.open(win, {
      feedURL: FEED,
      title: "Stale request",
    });
    try {
      await deferred.entered;
      await loadPage(win, EMPTY);
      await waitForFeeds(win, []);
      deferred.release();
      await opening;
      is(shownPanels, 0, "Never show a form for the previous document");
      ok(!win.document.getElementById(PANEL_ID), "Discard the stale popup");
      assertNoSubscription(context);
    } finally {
      deferred.release();
      await Promise.allSettled([opening]);
      win.document.removeEventListener("popupshown", onShown);
      sandbox.restore();
    }
  });
});

add_task(async function simultaneous_windows_create_only_one_subscription() {
  await withFeedTest(async context => {
    const first = await context.openWindow();
    const second = await context.openWindow();
    await SimpleTest.promiseFocus(first);
    await openDirectPanel(first);
    setField(first, "title", "First submission wins");
    const sandbox = sinon.createSandbox();
    const create = sandbox.spy(LiveBookmarks, "create");
    const deferred = deferFirstCall(sandbox, LiveBookmarks, "_fetch");
    try {
      EventUtils.synthesizeMouseAtCenter(field(first, "subscribe"), {}, first);
      await deferred.entered;
      for (const suffix of ["title", "url", "folder", "subscribe", "cancel"]) {
        ok(
          field(first, suffix).disabled,
          `${suffix} is disabled during submission`
        );
      }
      ok(
        !field(first, "subscribe-status").hidden,
        "Expose the pending operation"
      );
      assertNoSubscription(context);
      await SimpleTest.promiseFocus(second);
      await openDirectPanel(second);
      assertForm(second, FEED, "Integration feed");
      setField(second, "title", "Do not rename the first subscription");
      setField(second, "url", FEED + "#same-feed");
      await chooseFolder(second, PlacesUtils.bookmarks.unfiledGuid);
      EventUtils.synthesizeMouseAtCenter(
        field(second, "subscribe"),
        {},
        second
      );
      await TestUtils.waitForCondition(
        () => create.calledTwice,
        "Submit from both windows"
      );
      deferred.release();
      await Promise.all(create.returnValues);
      await waitForFeeds(first, [], [FEED]);
      await waitForFeeds(second, [], [FEED]);
      await TestUtils.waitForCondition(
        () =>
          !first.document.getElementById(PANEL_ID) &&
          !second.document.getElementById(PANEL_ID),
        "Dismiss both completed forms"
      );
      const subscriptions = LiveBookmarks.list().filter(
        sub => sub.feedURL === FEED
      );
      is(subscriptions.length, 1, "Deduplicate simultaneous normalized URLs");
      const saved = await PlacesUtils.bookmarks.fetch(subscriptions[0].guid);
      Assert.deepEqual(
        context.addedBookmarks.map(event => event.guid),
        [saved.guid],
        "Create exactly one bookmark folder, with no duplicate left behind"
      );
      is(
        saved.title,
        "First submission wins",
        "Do not rename an existing subscription"
      );
      is(
        saved.parentGuid,
        PlacesUtils.bookmarks.menuGuid,
        "Do not move it on duplicate submission"
      );
      Assert.deepEqual(
        context.requests,
        [FEED],
        "Share a single real feed download"
      );
      await discoveryMenu(first, []);
      await discoveryMenu(second, []);
      await LiveBookmarks.remove(saved.guid);
      await waitForFeeds(first, [FEED]);
      await waitForFeeds(second, [FEED]);
      Assert.deepEqual(
        context.requests,
        [FEED],
        "Restore both indicators without a new download"
      );
    } finally {
      deferred.release();
      await Promise.allSettled(create.returnValues);
      sandbox.restore();
    }
  });
});
