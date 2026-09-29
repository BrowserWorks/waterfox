/* This Source Code Form is subject to the terms of the Mozilla Public
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

const FEED = {
  feedURL: "https://example.com/feed-page-test.xml",
  title: "Test feed",
  siteURL: "",
};
const CACHE = {
  title: FEED.title,
  description: "Feed description",
  items: [
    {
      id: "one",
      title: "<script>untrusted title</script>",
      description: "Readable article",
      url: "https://example.com/item",
    },
    { id: "two", title: "Unsafe link", url: "javascript:alert(1)" },
  ],
};

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.feeds.filter", "all"],
      ["browser.feeds.articleOpening", "reader"],
    ],
  });
});

async function withFeedService(task) {
  await FeedReaderState.init();
  const folder = await PlacesUtils.bookmarks.insert({
    parentGuid: PlacesUtils.bookmarks.menuGuid,
    type: PlacesUtils.bookmarks.TYPE_FOLDER,
    title: FEED.title,
  });
  const subscriptions = [{ ...FEED, guid: folder.guid }];
  const sandbox = sinon.createSandbox();
  const stubs = {
    init: sandbox.stub(LiveBookmarks, "init").resolves(),
    list: sandbox.stub(LiveBookmarks, "list").callsFake(() => subscriptions),
    get: sandbox
      .stub(LiveBookmarks, "get")
      .callsFake(guid => subscriptions.find(sub => sub.guid === guid)),
    getByFeedURL: sandbox
      .stub(LiveBookmarks, "getByFeedURL")
      .callsFake(url => subscriptions.find(sub => sub.feedURL === url)),
    cachedFeed: sandbox.stub(LiveBookmarks, "cachedFeed").returns(CACHE),
    peek: sandbox.stub(LiveBookmarks, "peek").returns(CACHE),
    refresh: sandbox.stub(LiveBookmarks, "refresh").resolves(CACHE),
    create: sandbox.stub(LiveBookmarks, "createWithResult").rejects(),
    remove: sandbox.stub(LiveBookmarks, "remove").callsFake(async guid => {
      subscriptions.splice(
        subscriptions.findIndex(sub => sub.guid === guid),
        1
      );
    }),
  };
  try {
    await task(stubs, folder.guid);
  } finally {
    sandbox.restore();
    FeedReaderState.setSaved(FEED.feedURL, "one", false);
    FeedReaderState.setRead(FEED.feedURL, "one", false);
    await PlacesUtils.bookmarks.remove(folder.guid);
  }
}

async function withFeedPage(task, win = window) {
  await BrowserTestUtils.withNewTab(
    { gBrowser: win.gBrowser, url: "about:feeds" },
    async browser => {
      await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () =>
            content.document.getElementById("add-preview-button")?.disabled ===
            false,
          "Wait for the feed collection"
        );
        ok(content.document.getElementById("error").hidden, "The page loaded");
      });
      await task(browser);
    }
  );
}

add_task(async function collection_read_save_refresh_and_remove() {
  await withFeedService(async (stubs, guid) => {
    await withFeedPage(async browser => {
      ok(
        browser.contentPrincipal.isContentPrincipal,
        "Use a content principal"
      );
      await SpecialPowers.spawn(
        browser,
        [CACHE.items[0].title],
        async title => {
          const doc = content.document;
          const row = () => doc.querySelector(".article-card");
          is(
            doc.querySelectorAll(".article-card").length,
            1,
            "Omit unsafe links"
          );
          is(
            row().querySelector("h4").textContent,
            title,
            "Render titles as text"
          );
          ok(!row().querySelector("script"), "Do not insert feed markup");

          row().querySelector('[data-action="read"]').click();
          await ContentTaskUtils.waitForCondition(
            () =>
              !row().classList.contains("unread") &&
              !row().querySelector('[data-action="read"]').disabled,
            "Mark the article read"
          );
          row().querySelector('[data-action="save"]').click();
          await ContentTaskUtils.waitForCondition(
            () =>
              row()
                .querySelector('[data-action="save"]')
                .getAttribute("aria-pressed") === "true" &&
              !row().querySelector('[data-action="save"]').disabled,
            "Save the article"
          );
          doc.getElementById("saved-feeds").click();
          is(
            doc.querySelectorAll(".article-card").length,
            1,
            "Show the saved article"
          );

          doc.getElementById("all-feeds").click();
          doc.querySelector('#folders button[data-scope="source"]').click();
          doc.getElementById("refresh-source").click();
          await ContentTaskUtils.waitForCondition(
            () =>
              doc.getElementById("status").dataset.l10nId ===
                "feeds-status-reloaded" &&
              !doc.getElementById("remove-source").disabled,
            "Refresh the selected feed"
          );
          doc.getElementById("remove-source").click();
          await ContentTaskUtils.waitForCondition(
            () =>
              doc.getElementById("status").dataset.l10nId ===
                "feeds-status-removed" &&
              !doc.getElementById("add-preview-button").disabled,
            "Remove the subscription"
          );
          doc.getElementById("saved-feeds").click();
          is(
            doc.querySelectorAll(".article-card").length,
            1,
            "Saved content survives unsubscription"
          );
          row().querySelector('[data-action="save"]').click();
          await ContentTaskUtils.waitForCondition(
            () => !row() && !doc.getElementById("add-preview-button").disabled,
            "Remove the saved article"
          );
        }
      );
      ok(
        stubs.refresh.calledOnceWithExactly(guid, { force: true }),
        "Refresh only on request"
      );
      ok(
        stubs.remove.calledOnceWithExactly(guid),
        "Remove only the selected subscription"
      );
      ok(stubs.create.notCalled, "Opening the manager does not subscribe");
      Assert.deepEqual(FeedReaderState.get(FEED.feedURL, "one"), {
        read: true,
        saved: false,
      });
    });
  });
});

add_task(async function parent_rejects_invalid_and_stale_requests() {
  await withFeedService(async (stubs, guid) => {
    await withFeedPage(async browser => {
      await SpecialPowers.spawn(
        browser,
        [guid, FEED.feedURL],
        async (id, url) => {
          const actor = content.windowGlobalChild.getActor("FeedPage");
          for (const [command, args] of [
            ["Create", { feedURL: "javascript:alert(1)" }],
            ["Create", { feedURL: "https://user:password@example.com/feed" }],
            ["Create", { feedURL: url, parentGuid: "invalid" }],
            ["Remove", { guid: "invalid" }],
            ["Refresh", { guid: id, force: true }],
            [
              "Save",
              { feedURL: url, id: "one", saved: true, content: "injected" },
            ],
            ["SetPreference", { name: "arbitrary.pref", value: true }],
            ["Import", { path: "/tmp/untrusted.opml" }],
          ]) {
            ok(
              !(await actor.sendQuery(`Feeds:${command}`, args)).ok,
              `Reject invalid ${command}`
            );
          }
        }
      );
      const actor =
        browser.browsingContext.currentWindowGlobal.getActor("FeedPage");
      const deferred = Promise.withResolvers();
      stubs.init.returns(deferred.promise);
      try {
        const request = actor.receiveMessage({
          name: "Feeds:Refresh",
          data: { guid },
        });
        const loaded = BrowserTestUtils.browserLoaded(
          browser,
          false,
          "about:blank"
        );
        BrowserTestUtils.startLoadingURIString(browser, "about:blank");
        await loaded;
        deferred.resolve();
        is(
          (await request).error,
          "feeds-error-unavailable",
          "Reject the previous document's pending request"
        );
      } finally {
        deferred.resolve();
      }
      ok(
        stubs.create.notCalled &&
          stubs.remove.notCalled &&
          stubs.refresh.notCalled,
        "Invalid and stale requests never reach mutation methods"
      );
    });
  });
});

add_task(async function private_page_allows_cached_reads_not_mutations() {
  await withFeedService(async (stubs, guid) => {
    const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
    try {
      await withFeedPage(async browser => {
        await SpecialPowers.spawn(
          browser,
          [guid, FEED.feedURL],
          async (id, url) => {
            const doc = content.document;
            ok(
              !doc.getElementById("private-notice").hidden,
              "Explain private restrictions"
            );
            is(
              doc.querySelectorAll(".article-card").length,
              1,
              "Show cached articles"
            );
            for (const button of doc.querySelectorAll("[data-mutates]")) {
              ok(button.disabled, "Disable mutation controls");
            }
            const actor = content.windowGlobalChild.getActor("FeedPage");
            for (const [command, args] of [
              ["Create", { feedURL: url }],
              ["Remove", { guid: id }],
              ["Refresh", { guid: id }],
              ["MarkRead", { feedURL: url, id: "one", read: true }],
              ["Save", { feedURL: url, id: "one", saved: true }],
              ["SetPreference", { name: "loadImages", value: false }],
            ]) {
              is(
                (await actor.sendQuery(`Feeds:${command}`, args)).error,
                "feeds-error-private",
                `Enforce ${command} restriction in the parent`
              );
            }
            ok(
              (await actor.sendQuery("Feeds:Preview", { guid: id })).ok,
              "Allow a cached preview"
            );
          }
        );
        ok(
          stubs.create.notCalled &&
            stubs.remove.notCalled &&
            stubs.refresh.notCalled,
          "No private mutation or refresh reaches the service"
        );
        Assert.deepEqual(FeedReaderState.get(FEED.feedURL, "one"), {
          read: false,
          saved: false,
        });
      }, win);
    } finally {
      await BrowserTestUtils.closeWindow(win);
    }
  });
});

add_task(async function discovery_parent_revalidates_child_results() {
  await BrowserTestUtils.withNewTab("https://example.com/", async browser => {
    const actor =
      browser.browsingContext.currentWindowGlobal.getActor("FeedDiscovery");
    const sandbox = sinon.createSandbox();
    const deferred = Promise.withResolvers();
    try {
      const response = sandbox.stub(actor, "sendQuery");
      response.resolves([
        { title: "Unsafe", feedURL: "chrome://browser/content/browser.xhtml" },
        { title: "Valid", feedURL: "/relative.xml#fragment" },
        { title: "Duplicate", feedURL: "https://example.com/relative.xml" },
      ]);
      Assert.deepEqual(
        await actor.discover(),
        [{ title: "Valid", feedURL: "https://example.com/relative.xml" }],
        "Do not trust feed URLs supplied by the child"
      );
      response.returns(deferred.promise);
      const discovery = actor.discover();
      const loaded = BrowserTestUtils.browserLoaded(
        browser,
        false,
        "about:blank"
      );
      BrowserTestUtils.startLoadingURIString(browser, "about:blank");
      await loaded;
      deferred.resolve([{ title: "Stale", feedURL: FEED.feedURL }]);
      Assert.deepEqual(
        await discovery,
        [],
        "Discard previous-document discovery"
      );
    } finally {
      deferred.resolve([]);
      sandbox.restore();
    }
  });
});
