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
    recovery: sandbox.stub(LiveBookmarks, "recovery").get(() => null),
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
    await task(stubs, folder.guid, subscriptions);
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

add_task(
  async function unreadable_storage_has_a_specific_error_and_settings_work() {
    const sandbox = sinon.createSandbox();
    const storageError = new Error("Unreadable subscription storage");
    storageError.name = "LiveBookmarksStorageError";
    const init = sandbox.stub(LiveBookmarks, "init").rejects(storageError);
    const openPreferences = sandbox.stub(window, "openPreferences");
    try {
      await BrowserTestUtils.withNewTab("about:feeds", async browser => {
        await SpecialPowers.spawn(browser, [], async () => {
          const doc = content.document;
          const error = doc.getElementById("error");
          await ContentTaskUtils.waitForCondition(
            () => !error.hidden,
            "Wait for the storage failure"
          );
          is(
            doc.l10n.getAttributes(error).id,
            "feeds-error-storage",
            "Present a storage error instead of connection or folder advice"
          );
        });
        init.resetHistory();
        await SpecialPowers.spawn(browser, [], async () => {
          content.document.getElementById("reading-settings").click();
        });
        await TestUtils.waitForCondition(
          () => openPreferences.calledOnce,
          "Settings remain accessible when subscription storage is unreadable"
        );
        ok(openPreferences.calledOnceWithExactly("paneFeeds"));
        ok(init.notCalled, "Opening settings does not initialize storage");
      });
    } finally {
      sandbox.restore();
    }
  }
);

add_task(async function recovered_storage_notice_does_not_block_the_page() {
  await withFeedService(async stubs => {
    stubs.recovery.get(() => "cache");
    await withFeedPage(async browser => {
      await SpecialPowers.spawn(browser, [], async () => {
        const doc = content.document;
        const notice = doc.getElementById("recovery-notice");
        ok(!notice.hidden, "Show the recovery notice on the loaded page");
        is(notice.dataset.l10nId, "feeds-recovery-notice");
        await doc.l10n.translateElements([notice]);
        is(
          notice.textContent,
          await doc.l10n.formatValue("feeds-recovery-notice"),
          "Display the localized recovery notice"
        );
        ok(doc.getElementById("error").hidden, "Recovery is not an error");
        is(doc.querySelectorAll(".article-card").length, 1);
        const search = doc.getElementById("article-search");
        search.value = "no matching recovered article";
        search.dispatchEvent(new content.Event("input", { bubbles: true }));
        is(doc.querySelectorAll(".article-card").length, 0, "Search works");
        ok(
          !doc.getElementById("reading-settings").disabled,
          "Settings enabled"
        );
        doc.getElementById("add-feed").click();
        ok(doc.getElementById("add-dialog").open, "Add feed remains usable");
        ok(!doc.getElementById("add-preview-button").disabled);
        doc.getElementById("add-close").click();
      });
    });
  });
});

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

add_task(
  async function manual_refresh_updates_all_subscriptions_and_reports_failures() {
    await withFeedService(async (stubs, guid, subscriptions) => {
      const second = await PlacesUtils.bookmarks.insert({
        parentGuid: PlacesUtils.bookmarks.menuGuid,
        type: PlacesUtils.bookmarks.TYPE_FOLDER,
        title: "Second feed",
      });
      const refreshed = Promise.withResolvers();
      let fail = true;
      try {
        subscriptions.push({
          ...FEED,
          guid: second.guid,
          feedURL: "https://example.com/second-feed.xml",
        });
        stubs.refresh.callsFake(id => {
          if (id === guid) {
            return refreshed.promise;
          }
          return fail
            ? Promise.reject(new Error("Feed unavailable"))
            : Promise.resolve(CACHE);
        });
        await withFeedPage(async browser => {
          ok(
            stubs.refresh.notCalled,
            "Opening the manager does not refresh feeds"
          );
          await SpecialPowers.spawn(browser, [], () => {
            const button = content.document.getElementById("refresh-all");
            ok(!button.disabled, "Manual refresh is available");
            button.click();
            ok(
              button.disabled,
              "Disable another refresh until this one finishes"
            );
            is(
              button.dataset.l10nId,
              "feeds-refreshing-all",
              "Show progress on the button"
            );
            ok(
              !content.document.querySelector('button[data-action="open"]')
                .disabled,
              "Cached articles remain usable while feeds update"
            );
          });
          await TestUtils.waitForCondition(
            () => stubs.refresh.callCount === 2,
            "Refresh both subscriptions even if one fails"
          );
          for (const sub of subscriptions) {
            ok(
              stubs.refresh.calledWithExactly(sub.guid, { force: true }),
              "Force-refresh every subscription"
            );
          }
          const actor =
            browser.browsingContext.currentWindowGlobal.getActor("FeedPage");
          is(
            (await actor.receiveMessage({ name: "Feeds:RefreshAll", data: {} }))
              .error,
            "feeds-error-busy",
            "Reject a duplicate bulk refresh in the parent"
          );
          ok(
            (
              await actor.receiveMessage({
                name: "Feeds:MarkRead",
                data: { feedURL: FEED.feedURL, id: "one", read: true },
              })
            ).ok,
            "Read-state changes remain available during refresh"
          );
          refreshed.resolve(CACHE);
          await SpecialPowers.spawn(browser, [], async () => {
            const doc = content.document;
            const error = doc.getElementById("error");
            await ContentTaskUtils.waitForCondition(
              () =>
                !doc.getElementById("refresh-all").disabled && !error.hidden,
              "Report a partial failure and allow retry"
            );
            is(error.dataset.l10nId, "feeds-error-refresh-all");
            is(
              doc.l10n.getAttributes(error).args.count,
              1,
              "Identify the failed feed count"
            );
            is(
              doc.querySelectorAll(".article-card").length,
              2,
              "Keep cached articles available"
            );
          });
          fail = false;
          await SpecialPowers.spawn(browser, [], async () => {
            const doc = content.document;
            doc.getElementById("refresh-all").click();
            await ContentTaskUtils.waitForCondition(
              () =>
                !doc.getElementById("refresh-all").disabled &&
                doc.getElementById("status").dataset.l10nId ===
                  "feeds-status-reloaded-all",
              "The successful retry finishes"
            );
            ok(doc.getElementById("error").hidden, "Clear the previous error");
          });
          is(stubs.refresh.callCount, 4, "The retry updates both feeds");
        });
      } finally {
        refreshed.resolve(CACHE);
        await PlacesUtils.bookmarks.remove(second.guid);
      }
    });
  }
);

add_task(async function middle_click_opens_a_background_tab_and_marks_read() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.feeds.articleOpening", "original-tab"],
      ["browser.tabs.loadInBackground", true],
    ],
  });
  try {
    await withFeedService(async () => {
      await withFeedPage(async browser => {
        const opened = BrowserTestUtils.waitForNewTab(
          gBrowser,
          CACHE.items[0].url,
          true
        );
        await BrowserTestUtils.synthesizeMouseAtCenter(
          "h4 a[data-original]",
          { button: 1 },
          browser
        );
        const tab = await opened;
        try {
          is(
            gBrowser.selectedBrowser,
            browser,
            "Keep the feed manager selected"
          );
          await TestUtils.waitForCondition(
            () => FeedReaderState.get(FEED.feedURL, "one").read,
            "Opening the original in a background tab marks it read"
          );
          await SpecialPowers.spawn(browser, [], async () => {
            await ContentTaskUtils.waitForCondition(
              () =>
                !content.document
                  .querySelector(".article-card")
                  .classList.contains("unread"),
              "Update the article's visible read state"
            );
          });
        } finally {
          BrowserTestUtils.removeTab(tab);
        }
      });
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
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
            ["RefreshAll", { guid: id }],
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
      const openLink = sinon.stub(window, "openLinkIn");
      try {
        for (const [opening, where] of [
          ["original-tab", "tab"],
          ["original-window", "window"],
        ]) {
          await actor.receiveMessage({
            name: "Feeds:SetPreference",
            data: { name: "opening", value: opening },
          });
          const result = await actor.receiveMessage({
            name: "Feeds:OpenOriginal",
            data: { feedURL: FEED.feedURL, id: "one" },
          });
          ok(result.ok, `${opening} opens the article`);
          ok(
            openLink.lastCall.calledWith(
              CACHE.items[0].url,
              where,
              sinon.match({
                triggeringPrincipal: browser.contentPrincipal,
                allowInheritPrincipal: false,
                private: false,
                userContextId:
                  browser.contentPrincipal.originAttributes.userContextId,
              })
            ),
            "Open the cached article URL with the source browsing context"
          );
          ok(
            FeedReaderState.get(FEED.feedURL, "one").read,
            "Mark the article read"
          );
        }
      } finally {
        openLink.restore();
        Services.prefs.setStringPref("browser.feeds.articleOpening", "reader");
      }
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
              ["RefreshAll", {}],
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
