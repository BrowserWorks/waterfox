/* This Source Code Form is subject to the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { LiveBookmarks } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarks.sys.mjs"
);
const { FeedReaderState } = ChromeUtils.importESModule(
  "resource:///modules/FeedReaderState.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const SIDEBAR_URL = "chrome://browser/content/feeds/sidebar.html";
const BOOKMARKS_TOPIC = "waterfox-live-bookmarks-changed";
const FEEDS = [
  {
    feedURL: "https://example.com/sidebar-first.xml",
    title: "First <img src=x onerror=alert(1)> feed",
    siteURL: "https://example.com/",
  },
  {
    feedURL: "https://example.org/sidebar-second.xml",
    title: "Second feed",
    siteURL: "https://example.org/",
  },
];
const ITEMS = [
  [
    {
      id: "one",
      title: "Headline <img src=x onerror=alert(1)>",
      url: "https://example.com/",
    },
    {
      id: "two",
      title: "Another headline",
      url: "https://example.com/",
    },
    { id: "script", title: "Script", url: "javascript:alert(1)" },
    {
      id: "credentials",
      title: "Credentials",
      url: "https://user:password@example.com/",
    },
  ],
  [
    {
      id: "one",
      title: "Other source headline",
      url: "https://example.org/",
    },
  ],
];

async function withFeedSidebar(task, options = {}) {
  await FeedReaderState.init();
  const folder = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.menuGuid,
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: "Sidebar feeds",
  });
  const subscriptions = [];
  const caches = new Map();
  const sandbox = sinon.createSandbox();
  try {
    for (const [index, feed] of FEEDS.entries()) {
      const bookmark = await PlacesUtils.bookmarks.insert({
        parentGuid: folder.guid,
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
        title: feed.title,
      });
      subscriptions.push({ ...feed, guid: bookmark.guid });
      caches.set(bookmark.guid, {
        title: feed.title,
        items: ITEMS[index].map(item => ({ ...item })),
      });
    }
    sandbox.stub(LiveBookmarks, "init").resolves();
    sandbox.stub(LiveBookmarks, "recovery").get(() => null);
    sandbox.stub(LiveBookmarks, "list").callsFake(() => subscriptions);
    sandbox
      .stub(LiveBookmarks, "cachedFeed")
      .callsFake(guid => caches.get(guid));
    sandbox.stub(LiveBookmarks, "peek").callsFake(guid => caches.get(guid));
    const refresh = sandbox
      .stub(LiveBookmarks, "refresh")
      .callsFake(async guid => caches.get(guid));

    const win = await BrowserTestUtils.openNewBrowserWindow(options);
    try {
      await win.SidebarController.show("viewFeedsSidebar");
      const browser = win.document.getElementById("sidebar");
      await TestUtils.waitForCondition(
        () =>
          browser.contentDocument?.documentURI === SIDEBAR_URL &&
          browser.contentDocument.body?.dataset.ready === "true",
        "Wait for the feeds sidebar to render"
      );
      const doc = browser.contentDocument;
      ok(
        doc.getElementById("error").hidden,
        "The sidebar loaded without error"
      );
      await task({ doc, win, subscriptions, caches, refresh, sandbox });
    } finally {
      await BrowserTestUtils.closeWindow(win);
    }
  } finally {
    sandbox.restore();
    for (const feed of FEEDS) {
      for (const id of ["one", "two"]) {
        FeedReaderState.setRead(feed.feedURL, id, false);
      }
    }
    await PlacesUtils.bookmarks.remove(folder.guid);
  }
}

async function expandFeed(doc, guid, count) {
  const selector = `details[data-guid="${guid}"]`;
  const details = doc.querySelector(selector);
  if (!details.open) {
    details.querySelector("summary").click();
  }
  await TestUtils.waitForCondition(
    () => doc.querySelectorAll(`${selector} a[data-id]`).length === count,
    "Wait for the expanded feed's headlines"
  );
  return doc.querySelector(selector);
}

function headline(doc, guid, id) {
  return doc.querySelector(`a[data-guid="${guid}"][data-id="${id}"]`);
}

function searchFor(doc, value) {
  const search = doc.getElementById("search");
  search.value = value;
  search.dispatchEvent(new doc.defaultView.Event("input", { bubbles: true }));
}

async function openHeadline(doc, win, guid) {
  await expandFeed(doc, guid, 2);
  const opened = BrowserTestUtils.waitForNewTab(
    win.gBrowser,
    ITEMS[0][0].url,
    true
  );
  headline(doc, guid, "one").click();
  const tab = await opened;
  is(win.gBrowser.selectedTab, tab, "Open the original in a selected main tab");
  is(doc.documentURI, SIDEBAR_URL, "Keep the sidebar open");
  return tab;
}

add_task(async function cached_headlines_are_safe_and_grouped_by_folder() {
  await withFeedSidebar(async ({ doc, subscriptions, refresh }) => {
    is(doc.querySelectorAll("details[data-guid]").length, 2, "Show both feeds");
    is(doc.querySelector(".folder-heading").textContent, "Sidebar feeds");
    const first = await expandFeed(doc, subscriptions[0].guid, 2);
    ok(
      first.querySelector("summary").textContent.includes(FEEDS[0].title),
      "Render the subscription title as text"
    );
    const link = headline(doc, subscriptions[0].guid, "one");
    is(link.textContent, ITEMS[0][0].title, "Render the headline as text");
    is(link.href, ITEMS[0][0].url, "Keep the original article URL");
    ok(!first.querySelector("[onerror]"), "Never inject title markup");
    await expandFeed(doc, subscriptions[1].guid, 1);
    ok(refresh.notCalled, "Loading and expanding only read cached feeds");
  });
});

add_task(async function search_and_unread_filter_follow_reader_state() {
  await withFeedSidebar(async ({ doc, subscriptions }) => {
    const first = subscriptions[0];
    const second = subscriptions[1];
    await expandFeed(doc, first.guid, 2);
    for (const read of [true, false]) {
      doc
        .querySelector(
          `[data-action="read"][data-guid="${first.guid}"][data-id="one"]`
        )
        .click();
      await TestUtils.waitForCondition(
        () => headline(doc, first.guid, "one")?.dataset.read === String(read),
        "The read action updates the headline"
      );
      is(
        FeedReaderState.get(first.feedURL, "one").read,
        read,
        "Persist read state"
      );
    }

    FeedReaderState.setRead(first.feedURL, "one", true);
    doc.getElementById("unread").click();
    await TestUtils.waitForCondition(
      () =>
        doc.querySelectorAll("a[data-id]").length === 2 &&
        !headline(doc, first.guid, "one"),
      "Show unread headlines from both feeds"
    );
    ok(headline(doc, second.guid, "one"), "Read state is scoped to its feed");
    FeedReaderState.setRead(second.feedURL, "one", true);
    await TestUtils.waitForCondition(
      () => doc.querySelectorAll("a[data-id]").length === 1,
      "External reader-state changes update the unread filter"
    );
    doc.getElementById("unread").click();

    searchFor(doc, "Other source headline");
    is(
      doc.querySelectorAll("a[data-id]").length,
      1,
      "Search filters headlines"
    );
    ok(headline(doc, second.guid, "one"), "Search finds the matching feed");
    searchFor(doc, "no matching headline");
    const empty = doc.getElementById("empty");
    ok(!empty.hidden, "Show the no-matches message");
    is(empty.dataset.l10nId, "feeds-empty-results");
    searchFor(doc, "");
    is(
      doc.querySelectorAll("details[data-guid]").length,
      2,
      "Clearing search restores feeds"
    );

    subscriptions.splice(0);
    Services.obs.notifyObservers(null, BOOKMARKS_TOPIC);
    await TestUtils.waitForCondition(
      () => !empty.hidden && !doc.querySelector("details[data-guid]"),
      "Removing all subscriptions shows the empty state"
    );
    is(empty.dataset.l10nId, "feeds-empty");
  });
});

add_task(async function show_more_reveals_remaining_cached_headlines() {
  await withFeedSidebar(async ({ doc, subscriptions, caches, refresh }) => {
    const { guid } = subscriptions[0];
    caches.get(guid).items = Array.from({ length: 51 }, (_, index) => ({
      id: `page-${index}`,
      title: `Headline ${index}`,
      url: `https://example.com/?sidebar-item=${index}`,
    }));
    Services.obs.notifyObservers(null, BOOKMARKS_TOPIC, guid);
    await TestUtils.waitForCondition(
      () =>
        doc.querySelector(`details[data-guid="${guid}"] .unread-count`)
          .textContent === "51",
      "Wait for the updated cache"
    );
    const feed = await expandFeed(doc, guid, 50);
    feed.querySelector('[data-focus^="more-"]').click();
    is(
      doc.querySelectorAll(`details[data-guid="${guid}"] a[data-id]`).length,
      51
    );
    ok(
      !doc.querySelector('[data-focus^="more-"]'),
      "Remove Show more after the last page"
    );
    ok(refresh.notCalled, "Pagination only reads cached headlines");
  });
});

add_task(async function manual_refresh_updates_cached_headlines() {
  await withFeedSidebar(async ({ doc, subscriptions, caches, refresh }) => {
    const { guid } = subscriptions[0];
    await expandFeed(doc, guid, 2);
    caches.get(guid).items[0].title = "Updated cached headline";
    Services.obs.notifyObservers(null, BOOKMARKS_TOPIC, guid);
    await TestUtils.waitForCondition(
      () =>
        headline(doc, guid, "one")?.textContent === "Updated cached headline",
      "Subscription notifications update expanded feeds"
    );
    ok(refresh.notCalled, "Cache updates do not fetch feeds");

    caches.get(guid).items[0].title = "Refreshed headline";
    doc.getElementById("refresh").click();
    await TestUtils.waitForCondition(
      () =>
        headline(doc, guid, "one")?.textContent === "Refreshed headline" &&
        !doc.getElementById("refresh").disabled,
      "The manual refresh updates headlines"
    );
    is(
      refresh.callCount,
      subscriptions.length,
      "Refresh each subscription once"
    );
    for (const sub of subscriptions) {
      ok(
        refresh.calledWithExactly(sub.guid, { force: true }),
        "Force-refresh the feed"
      );
    }
  });
});

add_task(async function headlines_and_full_reader_open_in_main_tabs() {
  await withFeedSidebar(async ({ doc, win, subscriptions, sandbox }) => {
    const openLink = sandbox.spy(win, "openWebLinkIn");
    const tab = await openHeadline(doc, win, subscriptions[0].guid);
    ok(
      openLink.firstCall.args[2].triggeringPrincipal.isNullPrincipal,
      "Never open an article with the chrome principal"
    );
    await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
      is(content.document.referrer, "", "Do not send a sidebar referrer");
    });
    ok(
      FeedReaderState.get(FEEDS[0].feedURL, "one").read,
      "Opening an article marks it read"
    );
    ok(
      !FeedReaderState.get(FEEDS[1].feedURL, "one").read,
      "Leave other feeds unchanged"
    );

    const opened = BrowserTestUtils.waitForNewTab(
      win.gBrowser,
      "about:feeds",
      true
    );
    doc.getElementById("open-reader").click();
    is(
      win.gBrowser.selectedTab,
      await opened,
      "Open the full reader in a main tab"
    );
  });
});

add_task(async function private_sidebar_is_cached_and_read_only() {
  await withFeedSidebar(
    async ({ doc, win, subscriptions, refresh }) => {
      ok(
        !doc.getElementById("private-notice").hidden,
        "Explain private restrictions"
      );
      const button = doc.getElementById("refresh");
      ok(button.disabled, "Disable refresh in private windows");
      button.click();
      const feed = await expandFeed(doc, subscriptions[0].guid, 2);
      const read = feed.querySelector('[data-action="read"]');
      ok(read.disabled, "Disable read mutations in private windows");
      read.click();
      await openHeadline(doc, win, subscriptions[0].guid);
      ok(
        !FeedReaderState.get(FEEDS[0].feedURL, "one").read,
        "Private browsing does not persist read state"
      );
      ok(refresh.notCalled, "Private browsing never refreshes feeds");
    },
    { private: true }
  );
});
