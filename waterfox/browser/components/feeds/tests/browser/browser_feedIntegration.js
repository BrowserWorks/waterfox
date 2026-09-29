/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { LiveBookmarks } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarks.sys.mjs"
);
const { LiveBookmarksUI } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarksUI.sys.mjs"
);

add_task(async function discover_subscribe_and_render_without_stubs() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.toolbars.bookmarks.visibility", "always"]],
  });
  await LiveBookmarks.init();
  const root = getRootDirectory(gTestPath).replace(
    "chrome://mochitests/content",
    "https://example.com"
  );
  const feedURL = root + "feed.xml";
  const win = await BrowserTestUtils.openNewBrowserWindow();
  try {
    await SimpleTest.promiseFocus(win);
    const page = win.gBrowser.selectedBrowser;
    const loaded = BrowserTestUtils.browserLoaded(
      page,
      false,
      root + "feed-discovery.html"
    );
    BrowserTestUtils.startLoadingURIString(page, root + "feed-discovery.html");
    await loaded;

    const discovery = win.document.querySelector(
      "#waterfox-feeds-menu menupopup"
    );
    await LiveBookmarksUI.populateDiscovery(discovery);
    const offers = discovery.querySelectorAll(
      '[data-l10n-id="feeds-menu-subscribe"]'
    );
    Assert.equal(
      offers.length,
      1,
      "Deduplicate real feed advertisements and reject unsafe links"
    );
    const opened = BrowserTestUtils.waitForEvent(
      win.document,
      "popupshown",
      true,
      event => event.target.id === "waterfox-feed-subscribe-panel"
    );
    offers[0].doCommand();
    const subscribePanel = (await opened).target;
    Assert.equal(win.gBrowser.tabs.length, 1, "Stay on the website");
    Assert.equal(
      LiveBookmarks.list().length,
      0,
      "Discovery alone does not subscribe"
    );
    Assert.equal(
      win.document.getElementById("waterfox-feed-url").value,
      feedURL,
      "Prefill the discovered URL"
    );
    Assert.equal(
      win.document.getElementById("waterfox-feed-title").value,
      "Integration feed",
      "Prefill the advertised title"
    );
    win.document.getElementById("waterfox-feed-title").value =
      "My integration feed";
    EventUtils.synthesizeMouseAtCenter(
      win.document.getElementById("waterfox-feed-subscribe"),
      {},
      win
    );
    await TestUtils.waitForCondition(
      () =>
        win.document
          .getElementById("waterfox-feed-subscribe-status")
          .getAttribute("data-l10n-id") === "feeds-subscribe-success",
      "Wait for the subscription success status"
    );
    const dismissed = BrowserTestUtils.waitForPopupEvent(
      subscribePanel,
      "hidden"
    );
    subscribePanel.hidePopup();
    await dismissed;

    const subscription = LiveBookmarks.list().find(
      sub => sub.feedURL == feedURL
    );
    Assert.ok(subscription, "The real service stores the subscription");
    const folder = await PlacesUtils.bookmarks.fetch(subscription.guid);
    Assert.equal(
      folder.title,
      "My integration feed",
      "Keep the user-selected title"
    );
    Assert.equal(
      folder.parentGuid,
      PlacesUtils.bookmarks.menuGuid,
      "Create a top-level Bookmarks menu folder"
    );
    Assert.equal(
      folder.type,
      PlacesUtils.bookmarks.TYPE_FOLDER,
      "Use an ordinary Places folder"
    );
    const cache = LiveBookmarks.peek(folder.guid);
    Assert.equal(cache.status, "ready", "Cache the downloaded and parsed feed");
    Assert.equal(cache.items.length, 2, "Read both real RSS entries");
    Assert.equal(
      cache.items[0].title,
      "First & foremost",
      "Decode the XML title"
    );
    Assert.equal(
      cache.items[0].url,
      root + "article-one.html",
      "Resolve relative item links"
    );

    await PlacesUtils.bookmarks.update({
      guid: folder.guid,
      parentGuid: PlacesUtils.bookmarks.toolbarGuid,
      index: PlacesUtils.bookmarks.DEFAULT_INDEX,
    });
    await win.PlacesToolbarHelper.getIsEmpty();
    let button;
    await TestUtils.waitForCondition(() => {
      button = [
        ...win.document.getElementById("PlacesToolbarItems").children,
      ].find(child => child._placesNode?.bookmarkGuid == folder.guid);
      return button && BrowserTestUtils.isVisible(button);
    }, "Find the real subscription on the toolbar");
    Assert.ok(
      button.classList.contains("waterfox-live-bookmark"),
      "Decorate the subscription folder"
    );
    const style = win.getComputedStyle(button);
    Assert.ok(
      style.listStyleImage.includes("feed.svg"),
      `Use the feed-folder icon: ${style.listStyleImage}, token ${style.getPropertyValue("--bookmark-item-icon")}`
    );
    const popup = button.menupopup;
    const shown = BrowserTestUtils.waitForPopupEvent(popup, "shown");
    popup.openPopup(button, "after_start", 0, 0, false, false);
    await shown;
    Assert.ok(
      win.getComputedStyle(button).listStyleImage.includes("feed.svg"),
      "Keep the feed-folder icon when its menu is open"
    );
    const entries = [...popup.querySelectorAll(".waterfox-feed-entry")].filter(
      item => !item.matches('[data-l10n-id="feeds-menu-open-site"]')
    );
    Assert.equal(
      entries.length,
      2,
      "Render the actual downloaded entries in the native popup"
    );
    Assert.equal(
      popup._placesNode.childCount,
      0,
      "Feed entries do not become saved bookmarks"
    );
    for (const item of cache.items) {
      Assert.equal(await PlacesUtils.bookmarks.fetch({ url: item.url }), null);
    }
    const hidden = BrowserTestUtils.waitForPopupEvent(popup, "hidden");
    EventUtils.synthesizeKey("KEY_Escape", {}, win);
    await hidden;
  } finally {
    for (const sub of LiveBookmarks.list().filter(
      item => item.feedURL == feedURL
    )) {
      await LiveBookmarks.remove(sub.guid);
    }
    await BrowserTestUtils.closeWindow(win);
  }
});
