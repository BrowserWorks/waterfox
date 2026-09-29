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
  // Discovery publishes these feeds only after preview prefetch settles.
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
      "Only an explicit Open command may add a tab"
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
  const button = field(win, "cancel").hidden
    ? field(win, "header-close")
    : field(win, "cancel");
  EventUtils.synthesizeMouseAtCenter(button, {}, win);
  await hidden;
  ok(!win.document.getElementById(PANEL_ID), "Discard the dismissed panel");
}

function assertSubscribedPanel(win, { created = true } = {}) {
  ok(
    BrowserTestUtils.isVisible(field(win, "subscribe-status")),
    "Show the subscription result"
  );
  is(
    field(win, "subscribe-status").getAttribute("data-l10n-id"),
    created ? "feeds-subscribe-success" : "feeds-subscribe-already",
    "Reuse the localized subscription status"
  );
  is(field(win, "undo").hidden, !created, "Only offer Undo for our creation");
}

async function subscribe(win, feedURL, { close = true } = {}) {
  EventUtils.synthesizeMouseAtCenter(field(win, "subscribe"), {}, win);
  await TestUtils.waitForCondition(
    () =>
      LiveBookmarks.getByFeedURL(feedURL) &&
      field(win, "subscribe-status")?.getAttribute("data-l10n-id") ===
        "feeds-subscribe-success" &&
      field(win, "destination").hasAttribute("data-l10n-id"),
    "Store the subscription and show its destination in the success panel"
  );
  assertSubscribedPanel(win);
  if (close) {
    await cancelPanel(win);
  }
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

function deferFirstCall(sandbox, object, method) {
  const original = object[method].bind(object);
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  let deferred = false;
  sandbox.stub(object, method).callsFake(async (...args) => {
    if (!deferred) {
      deferred = true;
      entered.resolve();
      await released.promise;
    }
    return original(...args);
  });
  return { entered: entered.promise, release: released.resolve };
}

add_task(async function subscribed_summary_restores_details_on_undo() {
  await withFeedTest(async context => {
    const { FeedPreview } = ChromeUtils.importESModule(
      "resource:///modules/FeedPreview.sys.mjs"
    );
    const sandbox = sinon.createSandbox();
    sandbox.stub(FeedPreview, "load").resolves({
      title: "Publisher title",
      siteURL: "https://example.com/",
      description: "Publisher description",
      items: [{ title: "Recent article", published: 0 }],
    });
    try {
      const win = await context.openWindow();
      await openDirectPanel(win);
      field(win, "rename").click();
      setField(win, "title", "My publisher");
      await chooseFolder(win, PlacesUtils.bookmarks.toolbarGuid);
      const sub = await subscribe(win, FEED, { close: false });

      const remove = sandbox
        .stub(LiveBookmarks, "remove")
        .rejects(new Error("Undo failed"));
      field(win, "undo").click();
      await TestUtils.waitForCondition(
        () => !field(win, "subscribe-error").hidden,
        "Report an Undo failure without losing the summary"
      );
      is(
        field(win, "subscribe-error").getAttribute("data-l10n-id"),
        "feeds-subscribe-undo-error",
        "Keep localized Undo error feedback"
      );
      assertSubscribedPanel(win);
      remove.restore();

      const deferred = deferFirstCall(sandbox, LiveBookmarks, "remove");
      try {
        field(win, "undo").click();
        await deferred.entered;
        ok(
          field(win, "subscribe-error").hidden,
          "Clear the previous Undo error while retrying"
        );
        for (const suffix of ["undo", "open", "header-close"]) {
          ok(field(win, suffix).disabled, `Disable ${suffix} while undoing`);
        }
        is(
          field(win, "subscribe-status").getAttribute("data-l10n-id"),
          "feeds-subscribe-removing",
          "Keep the Undo progress status"
        );
      } finally {
        deferred.release();
      }
      await TestUtils.waitForCondition(
        () =>
          field(win, "subscribe-status").getAttribute("data-l10n-id") ===
            "feeds-subscribe-undone" &&
          BrowserTestUtils.isVisible(field(win, "full-preview")),
        "Restore the form and loaded preview after Undo"
      );
      ok(!LiveBookmarks.get(sub.guid), "Remove only the new subscription");
      ok(
        field(win, "subscribe-error").hidden,
        "Keep the previous Undo error hidden after a successful retry"
      );
      ok(
        BrowserTestUtils.isVisible(field(win, "subscribe-details")),
        "Restore editable subscription details"
      );
      is(field(win, "title").value, "My publisher", "Keep the edited title");
      is(
        field(win, "folder").value,
        PlacesUtils.bookmarks.toolbarGuid,
        "Keep the selected destination"
      );
      is(
        field(win, "preview-description").textContent,
        "Publisher description",
        "Restore the publisher description"
      );
      ok(field(win, "undo").hidden, "Hide Undo after removal");
      await subscribe(win, FEED);
    } finally {
      sandbox.restore();
    }
  });
});

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
    const requestsBeforeSubscribe = context.requests.length;
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

    win.gURLBar.focus();
    const reopened = waitForSubscribePanel(win);
    await FeedSubscribePanel.open(
      win,
      { feedURL: FEED, title: "Integration feed" },
      new win.KeyboardEvent("keydown", { key: "Enter" })
    );
    const panel = await reopened;
    assertSubscribedPanel(win, { created: false });
    const button = field(win, "open");
    is(win.document.activeElement, button, "Keyboard reopening focuses Open");
    ok(button.matches(":focus-visible"), "Preserve keyboard opening modality");
    const opened = BrowserTestUtils.waitForNewTab(
      win.gBrowser,
      "about:feeds",
      true
    );
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    context.expectedTabs++;
    EventUtils.synthesizeKey("KEY_Enter", {}, win);
    const tab = await opened;
    await hidden;
    BrowserTestUtils.removeTab(tab);
    Assert.deepEqual(
      context.requests.slice(requestsBeforeSubscribe),
      [FEED],
      "Only explicit creation downloads again after the settled preview"
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
      context.requests.slice(requestsBeforeSubscribe),
      [FEED],
      "Removal and cancellation reuse the preview without another download"
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
      const requestsBeforeSubscribe = context.requests.length;
      let chooser = await openChooser(win, [FEED, second, third]);
      assertNoSubscription(context);
      await chooseFeed(win, chooser, 1);
      assertForm(win, second, "Second advertised title");
      assertNoSubscription(context);
      await subscribe(win, second);
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
        context.requests.slice(requestsBeforeSubscribe),
        [second, FEED],
        "Only the two submitted feeds download again after discovery previews"
      );
    });
  }
);

add_task(
  async function invalid_url_can_be_corrected_without_losing_the_title() {
    await withFeedTest(async context => {
      const win = await context.openWindow();
      await openDirectPanel(win);
      const requestsBeforeSubscribe = context.requests.length;
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
        is(
          context.requests.length,
          requestsBeforeSubscribe,
          "Invalid URLs cause no downloads beyond the settled preview"
        );
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
        context.requests.slice(requestsBeforeSubscribe),
        [FEED],
        "Only corrected-URL creation downloads again after the settled preview"
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
    const create = sandbox.spy(LiveBookmarks, "createWithResult");
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
    const requestsBeforeSubscribe = context.requests.length;
    await SimpleTest.promiseFocus(first);
    await openDirectPanel(first);
    setField(first, "title", "First submission wins");
    const sandbox = sinon.createSandbox();
    const create = sandbox.spy(LiveBookmarks, "createWithResult");
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
          !field(first, "open").hidden &&
          !field(second, "open").hidden &&
          !field(first, "open").disabled &&
          !field(second, "open").disabled,
        "Show both subscribed panels"
      );
      assertSubscribedPanel(first);
      assertSubscribedPanel(second, { created: false });
      await SimpleTest.promiseFocus(first);
      await cancelPanel(first);
      await SimpleTest.promiseFocus(second);
      await cancelPanel(second);
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
        context.requests.slice(requestsBeforeSubscribe),
        [FEED],
        "Both submissions share one creation download after both window previews"
      );
      await discoveryMenu(first, []);
      await discoveryMenu(second, []);
      await LiveBookmarks.remove(saved.guid);
      await waitForFeeds(first, [FEED]);
      await waitForFeeds(second, [FEED]);
      Assert.deepEqual(
        context.requests.slice(requestsBeforeSubscribe),
        [FEED],
        "Restoring both indicators reuses previews without another download"
      );
    } finally {
      deferred.release();
      await Promise.allSettled(create.returnValues);
      sandbox.restore();
    }
  });
});
