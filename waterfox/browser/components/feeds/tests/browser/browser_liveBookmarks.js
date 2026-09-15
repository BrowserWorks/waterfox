/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { LiveBookmarks } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarks.sys.mjs"
);
const { LiveBookmarksUI } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarksUI.sys.mjs"
);

const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const FEED_URL = "https://example.com/live-bookmarks/feed.xml";
const SITE_URL = "https://example.com/live-bookmarks/";
const ITEMS = [
  {
    id: "first",
    title: "<script>Feed titles are plain text</script>",
    url: "https://example.com/live-bookmarks/first",
  },
  {
    id: "second",
    title: "Second article",
    url: "https://example.com/live-bookmarks/second",
  },
];

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.toolbars.bookmarks.visibility", "always"],
      ["browser.tabs.opentabfor.middleclick", true],
    ],
  });
  await TestUtils.waitForCondition(
    () => LiveBookmarksUI._ready,
    "Wait for Live Bookmarks startup"
  );
});

async function withLiveBookmarksUI(task, { private: isPrivate = false } = {}) {
  const sandbox = sinon.createSandbox();
  const guid = PlacesUtils.history.makeGuid();
  const subscription = {
    guid,
    title: "Live Bookmarks UI test",
    feedURL: FEED_URL,
    siteURL: SITE_URL,
  };
  const subscriptions = new Map([[guid, subscription]]);
  const cache = new Map([[guid, { status: "ready", items: ITEMS }]]);
  const refresh = Promise.withResolvers();
  const addedBookmarks = [];
  const onBookmarksAdded = events => addedBookmarks.push(...events);
  let observing = false;
  let win;
  let cleanedUp = false;

  async function cleanup() {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    try {
      if (win && !win.closed) {
        await BrowserTestUtils.closeWindow(win);
      }
    } finally {
      refresh.resolve();
      await new Promise(resolve => executeSoon(resolve));
      try {
        if (await PlacesUtils.bookmarks.fetch(guid)) {
          await PlacesUtils.bookmarks.remove(guid);
        }
      } finally {
        if (observing) {
          PlacesUtils.observers.removeListener(
            ["bookmark-added"],
            onBookmarksAdded
          );
        }
        sandbox.restore();
      }
    }
  }
  registerCleanupFunction(cleanup);

  try {
    const stubs = {
      init: sandbox.stub(LiveBookmarks, "init").resolves(),
      get: sandbox
        .stub(LiveBookmarks, "get")
        .callsFake(folderGuid => subscriptions.get(folderGuid) || null),
      peek: sandbox
        .stub(LiveBookmarks, "peek")
        .callsFake(folderGuid => cache.get(folderGuid) || null),
      refresh: sandbox.stub(LiveBookmarks, "refresh").returns(refresh.promise),
    };
    win = await BrowserTestUtils.openNewBrowserWindow({ private: isPrivate });
    await SimpleTest.promiseFocus(win);
    await win.PlacesToolbarHelper.getIsEmpty();
    const folder = await PlacesUtils.bookmarks.insert({
      guid,
      parentGuid: PlacesUtils.bookmarks.toolbarGuid,
      index: 0,
      type: PlacesUtils.bookmarks.TYPE_FOLDER,
      title: subscription.title,
    });
    const toolbar = win.document.getElementById("PlacesToolbarItems");
    let button;
    await TestUtils.waitForCondition(() => {
      button = Array.from(toolbar.children).find(
        child => child._placesNode?.bookmarkGuid == guid
      );
      return button && BrowserTestUtils.isVisible(button);
    }, "Wait for the real Places toolbar folder");
    PlacesUtils.observers.addListener(["bookmark-added"], onBookmarksAdded);
    observing = true;
    await task({
      win,
      folder,
      button,
      popup: button.menupopup,
      subscription,
      subscriptions,
      cache,
      refresh,
      sandbox,
      stubs,
      addedBookmarks,
    });
  } finally {
    await cleanup();
  }
}

async function openFolderPopup(button) {
  const popup = button.menupopup;
  const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
  popup.openPopup(button, "after_start", 0, 0, false, false);
  await shown;
  return popup;
}

async function closeFolderPopup(popup) {
  if (popup.state == "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
  popup.hidePopup();
  await hidden;
}

function feedItems(popup) {
  return Array.from(popup.querySelectorAll(":scope > [data-feed-item]"));
}

function feedCommand(popup, id) {
  return popup.querySelector(`:scope > [data-l10n-id="${id}"]`);
}

function feedEntry(popup, url) {
  return feedItems(popup).find(item => {
    const { args } = popup.ownerDocument.l10n.getAttributes(item);
    return (args?.url || item.getAttribute("tooltiptext")) == url;
  });
}

async function assertNoArticleBookmarks(addedBookmarks) {
  Assert.equal(
    addedBookmarks.length,
    0,
    "Rendering never inserts Places items"
  );
  for (const url of [SITE_URL, ...ITEMS.map(item => item.url)]) {
    Assert.equal(
      await PlacesUtils.bookmarks.fetch({ url }),
      null,
      `${url} is not saved as a bookmark`
    );
  }
}

add_task(async function test_cached_virtual_children_and_native_places_nodes() {
  await withLiveBookmarksUI(async context => {
    const {
      win,
      folder,
      button,
      popup,
      subscriptions,
      cache,
      stubs,
      addedBookmarks,
    } = context;
    Assert.ok(
      button.classList.contains("waterfox-live-bookmark"),
      "The toolbar insertion hook decorates a subscribed folder"
    );
    const saved = await PlacesUtils.bookmarks.insert({
      parentGuid: folder.guid,
      title: "A normal saved bookmark",
      url: "https://example.com/live-bookmarks/saved",
    });
    const nested = await PlacesUtils.bookmarks.insert({
      parentGuid: folder.guid,
      type: PlacesUtils.bookmarks.TYPE_FOLDER,
      title: "Nested live bookmark",
    });
    subscriptions.set(nested.guid, {
      ...context.subscription,
      guid: nested.guid,
      title: nested.title,
    });
    const cachedSite = "https://example.org/live-bookmarks/";
    cache.get(folder.guid).siteURL = cachedSite;
    const before = await PlacesUtils.promiseBookmarksTree(folder.guid);
    addedBookmarks.length = 0;

    await openFolderPopup(button);
    const savedItem = Array.from(popup.children).find(
      item => item._placesNode?.bookmarkGuid == saved.guid
    );
    const nestedMenu = Array.from(popup.children).find(
      item => item._placesNode?.bookmarkGuid == nested.guid
    );
    Assert.ok(savedItem, "The native build includes the saved bookmark");
    Assert.ok(
      nestedMenu.classList.contains("waterfox-live-bookmark"),
      "The menu insertion hook decorates a subscribed subfolder"
    );
    Assert.ok(
      stubs.refresh.calledOnceWithExactly(folder.guid),
      "Request a refresh"
    );
    Assert.ok(feedEntry(popup, cachedSite), "Prefer the cached website URL");
    Assert.ok(!feedEntry(popup, SITE_URL), "Do not duplicate the website link");
    for (const entry of ITEMS) {
      const item = feedEntry(popup, entry.url);
      Assert.ok(item, "Render cached articles without waiting for refresh");
      await TestUtils.waitForCondition(
        () => win.document.l10n.getAttributes(item).args?.title == entry.title,
        "Wait for the visited-state label"
      );
      await win.document.l10n.translateElements([item]);
      const [message] = await win.document.l10n.formatMessages([
        win.document.l10n.getAttributes(item),
      ]);
      Assert.equal(
        item.getAttribute("label"),
        message.attributes.find(attribute => attribute.name == "label").value,
        "Render the literal title with the localized visited-state marker"
      );
      Assert.ok(!item.querySelector("script"), "Do not interpret feed markup");
    }
    const children = Array.from(popup.children);
    const markerIndex = children.indexOf(popup._endMarker);
    Assert.greaterOrEqual(
      markerIndex,
      0,
      "The native build installs its end marker"
    );
    for (const item of feedItems(popup)) {
      Assert.ok(!item._placesNode, "Virtual items have no Places result node");
      Assert.ok(
        !item.classList.contains("bookmark-item"),
        "Virtual items are not ordinary bookmark menu items"
      );
      Assert.greater(
        children.indexOf(item),
        markerIndex,
        "Virtual items are outside the native Places markers"
      );
    }
    const virtualCount = feedItems(popup).length;
    LiveBookmarksUI.populatePopup(popup);
    Assert.equal(
      feedItems(popup).length,
      virtualCount,
      "Rendering replaces virtual items"
    );
    Assert.equal(
      savedItem.parentNode,
      popup,
      "Rendering preserves the saved DOM item"
    );
    Assert.equal(
      nestedMenu.parentNode,
      popup,
      "Rendering preserves saved subfolders"
    );
    Assert.equal(
      popup._placesNode.childCount,
      2,
      "Only saved children are in Places"
    );
    await closeFolderPopup(popup);
    await openFolderPopup(button);
    Assert.equal(
      feedItems(popup).length,
      virtualCount,
      "Reopening does not duplicate items"
    );
    Assert.equal(
      savedItem.parentNode,
      popup,
      "Reopening preserves the saved item"
    );
    Assert.deepEqual(
      await PlacesUtils.promiseBookmarksTree(folder.guid),
      before,
      "Rendering and reopening leave the saved folder tree unchanged"
    );
    await assertNoArticleBookmarks(addedBookmarks);
    Assert.equal(await PlacesUtils.bookmarks.fetch({ url: cachedSite }), null);

    await closeFolderPopup(popup);
    subscriptions.delete(folder.guid);
    await openFolderPopup(button);
    Assert.equal(
      feedItems(popup).length,
      0,
      "A removed subscription leaves no virtual items"
    );
    Assert.equal(
      savedItem.parentNode,
      popup,
      "Clearing feed items keeps saved children"
    );
    LiveBookmarksUI.decorateFolder(button, button._placesNode);
    Assert.ok(
      !button.classList.contains("waterfox-live-bookmark"),
      "Clear the feed decoration"
    );
    Assert.equal(
      win.document.getElementById("PlacesToolbarItems"),
      button.parentNode
    );
  });
});

add_task(async function test_empty_loading_and_error_status() {
  await withLiveBookmarksUI(
    async ({ folder, button, popup, cache, addedBookmarks }) => {
      const cases = [
        [null, "feeds-menu-loading"],
        [{ status: "idle", items: [] }, "feeds-menu-loading"],
        [{ status: "loading", items: [] }, "feeds-menu-loading"],
        [{ status: "ready", items: [] }, "feeds-menu-empty"],
        [{ status: "error", items: [] }, "feeds-menu-error"],
        [{ status: "error", items: ITEMS }, "feeds-menu-error"],
      ];
      for (const [state, id] of cases) {
        cache.set(folder.guid, state);
        await openFolderPopup(button);
        const status = feedCommand(popup, id);
        Assert.ok(status, `Render ${id} for ${state?.status || "no cache"}`);
        Assert.ok(status.disabled, "Status rows cannot be activated");
        Assert.ok(
          !popup.hasAttribute("emptyplacesresult"),
          "Suppress the native empty-folder state"
        );
        Assert.notEqual(
          popup._emptyMenuitem?.parentNode,
          popup,
          "Remove the native empty-folder item"
        );
        Assert.equal(
          popup.querySelectorAll(":scope > .waterfox-feed-entry").length,
          1 + (state?.items.length || 0),
          "Keep the website and any cached articles, including on error"
        );
        Assert.ok(
          !feedCommand(popup, "feeds-menu-reload").disabled,
          "Reload is available"
        );
        Assert.ok(
          feedCommand(popup, "feeds-menu-manage"),
          "The fragment includes the manager command"
        );
        await closeFolderPopup(popup);
      }
      await assertNoArticleBookmarks(addedBookmarks);
    }
  );
});

add_task(async function test_command_and_middle_click_use_null_principal() {
  await withLiveBookmarksUI(
    async ({ win, button, popup, sandbox, addedBookmarks }) => {
      const openWebLink = sandbox.spy(win, "openWebLinkIn");
      const openTrustedLink = sandbox.stub(win, "openTrustedLinkIn");
      // Keep the real web-link wrapper so it must supply the null principal.
      const openLink = sandbox.stub(win.URILoadingHelper, "openLinkIn");

      function assertOpened(where) {
        Assert.ok(openWebLink.calledOnce, "Use openWebLinkIn exactly once");
        Assert.ok(openLink.calledOnce, "Dispatch exactly one navigation");
        const [sourceWindow, url, destination, options] =
          openLink.firstCall.args;
        Assert.equal(sourceWindow, win, "Open from the owning browser window");
        Assert.equal(url, ITEMS[0].url, "Open the article URL");
        Assert.equal(
          destination,
          where,
          "Honor the command or mouse destination"
        );
        Assert.ok(
          options.triggeringPrincipal.isNullPrincipal,
          "Use a null triggering principal"
        );
        Assert.ok(
          !options.triggeringPrincipal.isSystemPrincipal,
          "Never use system authority"
        );
        Assert.strictEqual(
          options.allowInheritPrincipal,
          false,
          "Forbid principal inheritance"
        );
        Assert.ok(
          openTrustedLink.notCalled,
          "Articles never use the trusted-link path"
        );
        openWebLink.resetHistory();
        openLink.resetHistory();
      }

      await openFolderPopup(button);
      feedEntry(popup, ITEMS[0].url).doCommand();
      assertOpened("current");
      await closeFolderPopup(popup);

      await openFolderPopup(button);
      const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
      EventUtils.synthesizeMouseAtCenter(
        feedEntry(popup, ITEMS[0].url),
        { button: 1 },
        win
      );
      await hidden;
      assertOpened("tab");

      await openFolderPopup(button);
      feedEntry(popup, ITEMS[0].url).dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, button: 0 })
      );
      Assert.ok(
        openWebLink.notCalled,
        "The left-click event does not duplicate command activation"
      );
      await assertNoArticleBookmarks(addedBookmarks);
    }
  );
});

add_task(async function test_refresh_updates_open_popup_and_manual_reload() {
  await withLiveBookmarksUI(
    async ({
      folder,
      button,
      popup,
      cache,
      refresh,
      stubs,
      addedBookmarks,
    }) => {
      await openFolderPopup(button);
      Assert.ok(
        popup.hasAttribute("nonnative"),
        "Toolbar menus can update while open"
      );
      Assert.ok(
        feedEntry(popup, ITEMS[0].url),
        "The pending refresh leaves cached articles visible"
      );
      const updated = {
        id: "updated",
        title: "An updated article",
        url: "https://example.com/live-bookmarks/updated",
      };
      cache.set(folder.guid, { status: "ready", items: [updated] });
      refresh.resolve();
      await TestUtils.waitForCondition(
        () => feedEntry(popup, updated.url),
        "Refresh completion renders the new cache"
      );
      Assert.ok(
        !feedEntry(popup, ITEMS[0].url),
        "Replace old virtual articles"
      );
      Assert.ok(
        stubs.refresh.calledOnceWithExactly(folder.guid),
        "Opening requests a normal refresh"
      );
      stubs.refresh.resetHistory();
      feedCommand(popup, "feeds-menu-reload").doCommand();
      Assert.ok(
        stubs.refresh.calledOnceWithExactly(folder.guid, { force: true }),
        "Manual reload forces a refresh of this folder"
      );
      await assertNoArticleBookmarks(addedBookmarks);
      Assert.equal(
        await PlacesUtils.bookmarks.fetch({ url: updated.url }),
        null
      );
    }
  );
});

add_task(async function test_failed_refresh_keeps_cached_articles() {
  await withLiveBookmarksUI(
    async ({ folder, button, popup, cache, refresh, addedBookmarks }) => {
      await openFolderPopup(button);
      cache.set(folder.guid, { status: "error", items: ITEMS });
      refresh.reject(new Error("Expected feed refresh failure"));
      await TestUtils.waitForCondition(
        () => feedCommand(popup, "feeds-menu-error"),
        "A rejected refresh displays the service error state"
      );
      Assert.ok(
        feedCommand(popup, "feeds-menu-error").disabled,
        "The error is informational"
      );
      for (const entry of ITEMS) {
        Assert.ok(
          feedEntry(popup, entry.url),
          "Keep cached articles after a refresh failure"
        );
      }
      await assertNoArticleBookmarks(addedBookmarks);
    }
  );
});

add_task(async function test_private_window_reads_cache_without_refresh() {
  await withLiveBookmarksUI(
    async ({ folder, button, popup, cache, stubs, addedBookmarks }) => {
      await openFolderPopup(button);
      Assert.ok(
        feedEntry(popup, ITEMS[0].url),
        "Private windows can display cached articles"
      );
      Assert.ok(
        feedCommand(popup, "feeds-menu-reload").disabled,
        "Disable reload in private windows"
      );
      Assert.ok(
        stubs.refresh.notCalled,
        "Opening a private popup never refreshes"
      );
      await closeFolderPopup(popup);
      cache.delete(folder.guid);
      await openFolderPopup(button);
      Assert.ok(
        feedCommand(popup, "feeds-menu-no-cache").disabled,
        "Explain unavailable private cache"
      );
      Assert.ok(
        !feedCommand(popup, "feeds-menu-loading"),
        "Do not imply a private network request"
      );
      Assert.ok(
        stubs.refresh.notCalled,
        "An uncached private popup never refreshes"
      );
      Assert.ok(
        feedCommand(popup, "feeds-menu-reload").disabled,
        "Reload remains disabled without cache"
      );
      await assertNoArticleBookmarks(addedBookmarks);
    },
    { private: true }
  );
});

add_task(async function test_discovery_entry_point_and_manual_manager() {
  await withLiveBookmarksUI(async ({ win, button, popup, sandbox, stubs }) => {
    const doc = win.document;
    const entryPoint =
      doc.getElementById("waterfox-feeds-menu") ||
      doc.getElementById("waterfox-feeds-button");
    Assert.ok(
      entryPoint?.isConnected,
      "A feed menu or discovery button is installed"
    );
    if (entryPoint.id == "waterfox-feeds-menu") {
      Assert.equal(
        entryPoint.parentNode,
        doc.getElementById("bookmarksMenuPopup"),
        "Feeds is a top-level Bookmarks menu entry"
      );
    }
    const openManager = sandbox.stub(win, "openTrustedLinkIn");
    await BrowserTestUtils.withNewTab(
      { gBrowser: win.gBrowser, url: "about:blank" },
      async () => {
        const discovery = entryPoint.querySelector("menupopup");
        discovery.dispatchEvent(
          new win.MouseEvent("popupshowing", { bubbles: true })
        );
        await TestUtils.waitForCondition(
          () => feedCommand(discovery, "feeds-menu-no-feeds"),
          "The installed discovery listener handles a page without feeds"
        );
        Assert.ok(
          feedCommand(discovery, "feeds-menu-no-feeds").disabled,
          "No feeds is a status row"
        );
        feedCommand(discovery, "feeds-menu-manage").doCommand();
        Assert.ok(
          openManager.calledOnceWithExactly("about:feeds", "tab"),
          "Manual subscription management is available without discovered feeds"
        );
        Assert.ok(
          stubs.refresh.notCalled,
          "Discovery does not refresh subscriptions"
        );
      }
    );
    openManager.resetHistory();
    await openFolderPopup(button);
    feedCommand(popup, "feeds-menu-manage").doCommand();
    Assert.ok(
      openManager.calledOnceWithExactly("about:feeds", "tab"),
      "The live folder manager command uses its owning window"
    );
  });
});

add_task(async function test_no_stale_refresh_after_popup_destroyed() {
  await withLiveBookmarksUI(
    async ({ folder, button, popup, cache, refresh, sandbox, stubs }) => {
      await openFolderPopup(button);
      Assert.ok(
        stubs.refresh.calledOnceWithExactly(folder.guid),
        "A refresh is pending"
      );
      await PlacesUtils.bookmarks.remove(folder.guid);
      await TestUtils.waitForCondition(
        () => !button.isConnected && !popup.isConnected,
        "Removing the real Places folder destroys its popup"
      );
      const render = sandbox.spy(LiveBookmarksUI, "_renderPopup");
      const children = Array.from(popup.children);
      stubs.peek.resetHistory();
      cache.set(folder.guid, { status: "ready", items: [] });
      refresh.resolve();
      await new Promise(resolve => executeSoon(resolve));
      Assert.ok(
        render.notCalled,
        "A completed refresh never renders into a destroyed popup"
      );
      Assert.ok(
        stubs.peek.notCalled,
        "Do not read the cache for a destroyed popup"
      );
      Assert.equal(
        popup.children.length,
        children.length,
        "Do not change the detached popup"
      );
      for (const [index, child] of children.entries()) {
        Assert.equal(
          popup.children[index],
          child,
          "Keep detached child nodes untouched"
        );
      }
    }
  );
});
