/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const { LiveBookmarks, serializeOPML } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarks.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const FEED = {
  guid: "feedtest0001",
  feedURL: "https://example.com/feed.xml",
  title: '<img src="https://example.com/unwanted" onerror="alert(1)">',
  siteURL: "https://example.com/",
};
const CACHE = {
  items: [
    {
      id: "one",
      title: "<script>untrusted title</script>",
      url: "https://example.com/item",
    },
    { id: "two", title: "Unsafe link", url: "javascript:alert(1)" },
  ],
};

async function withFeedService(task) {
  const sandbox = sinon.createSandbox();
  const subscriptions = [{ ...FEED }];
  const stubs = {
    init: sandbox.stub(LiveBookmarks, "init").resolves(),
    list: sandbox.stub(LiveBookmarks, "list").callsFake(() => subscriptions),
    get: sandbox
      .stub(LiveBookmarks, "get")
      .callsFake(guid => subscriptions.find(sub => sub.guid === guid)),
    peek: sandbox.stub(LiveBookmarks, "peek").returns(CACHE),
    refresh: sandbox.stub(LiveBookmarks, "refresh").resolves(CACHE),
    create: sandbox.stub(LiveBookmarks, "create").callsFake(async data => {
      const existing = subscriptions.find(sub => sub.feedURL === data.feedURL);
      if (existing) {
        return existing;
      }
      const sub = {
        ...FEED,
        feedURL: data.feedURL,
        title: data.title || "Feed",
      };
      subscriptions.push(sub);
      return sub;
    }),
    remove: sandbox.stub(LiveBookmarks, "remove").callsFake(async guid => {
      subscriptions.splice(
        subscriptions.findIndex(sub => sub.guid === guid),
        1
      );
    }),
    importOPML: sandbox.stub(LiveBookmarks, "importOPML").resolves(2),
  };
  try {
    await task({ sandbox, stubs, subscriptions });
  } finally {
    sandbox.restore();
  }
}

async function withFeedPage(task, url = "about:feeds", win = window) {
  await BrowserTestUtils.withNewTab(
    { gBrowser: win.gBrowser, url },
    async browser => {
      await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => content.document.getElementById("export")?.disabled === false,
          "Wait for the initial subscription list"
        );
      });
      await task(browser);
    }
  );
}

async function waitForStatus(browser, id) {
  await SpecialPowers.spawn(browser, [id], async expected => {
    await ContentTaskUtils.waitForCondition(
      () =>
        content.document.getElementById("status").dataset.l10nId === expected &&
        !content.document.getElementById("export").disabled,
      "Wait for the feed operation to finish"
    );
  });
}

async function showCachedPreview(browser) {
  await SimpleTest.promiseFocus(browser.documentGlobal);
  browser.focus();
  await SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(() => content.document.hasFocus());
    content.document.querySelector('[data-action="Preview"]').click();
  });
  await waitForStatus(browser, "feeds-status-preview");
}

async function watchCachedPreviewUpdate(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    content.wrappedJSObject.feedPreviewUpdateDone = new content.Promise(
      resolve => {
        let id;
        const onRequest = event => {
          const request = JSON.parse(event.detail);
          if (request.command === "Preview") {
            id = request.id;
            doc.removeEventListener("FeedPage:Request", onRequest);
          }
        };
        const onResponse = event => {
          if (JSON.parse(event.detail).id === id) {
            doc.removeEventListener("FeedPage:Response", onResponse);
            // The page renders in promise continuations after this event.
            content.setTimeout(resolve, 0);
          }
        };
        doc.addEventListener("FeedPage:Request", onRequest);
        doc.addEventListener("FeedPage:Response", onResponse);
      }
    );
  });
}

async function finishCachedPreviewUpdate(browser) {
  await SpecialPowers.spawn(browser, [], async () => {
    await content.wrappedJSObject.feedPreviewUpdateDone;
    delete content.wrappedJSObject.feedPreviewUpdateDone;
  });
}

add_task(async function test_background_preview_preserves_current_focus() {
  await withFeedService(async ({ stubs }) => {
    await withFeedPage(async browser => {
      await showCachedPreview(browser);
      await SpecialPowers.spawn(browser, [], () => {
        const link = content.document.querySelector("#preview-items a");
        link.dataset.focusProbe = "original";
        link.focus();
      });
      await watchCachedPreviewUpdate(browser);
      Services.obs.notifyObservers(null, "waterfox-live-bookmarks-changed");
      await finishCachedPreviewUpdate(browser);
      await SpecialPowers.spawn(browser, [], () => {
        const doc = content.document;
        const link = doc.querySelector("#preview-items a");
        is(
          link.dataset.focusProbe,
          "original",
          "Keep the same article node for an unchanged preview"
        );
        is(doc.activeElement, link, "Keep focus on the unchanged article");
      });

      stubs.peek.returns({
        items: [
          { ...CACHE.items[0], title: "Updated article title" },
          CACHE.items[1],
        ],
      });
      await watchCachedPreviewUpdate(browser);
      Services.obs.notifyObservers(null, "waterfox-live-bookmarks-changed");
      await finishCachedPreviewUpdate(browser);
      await SpecialPowers.spawn(browser, [CACHE.items[0].url], url => {
        const doc = content.document;
        const link = doc.querySelector("#preview-items a");
        is(
          link.textContent,
          "Updated article title",
          "Render a changed preview"
        );
        is(
          doc.activeElement,
          link,
          "Restore a removed focused link to its corresponding URL"
        );
        is(link.href, url, "Keep the same article as the focus target");
      });

      const deferred = Promise.withResolvers();
      const calls = stubs.init.callCount;
      stubs.init.onCall(calls + 1).returns(deferred.promise);
      stubs.peek.returns(CACHE);
      try {
        await watchCachedPreviewUpdate(browser);
        Services.obs.notifyObservers(null, "waterfox-live-bookmarks-changed");
        await TestUtils.waitForCondition(
          () => stubs.init.callCount >= calls + 2
        );
        await SpecialPowers.spawn(browser, [], () => {
          const doc = content.document;
          ok(
            !doc.getElementById("feed-title").matches(":disabled"),
            "Background work does not disable subscription input"
          );
          ok(
            !doc.getElementById("export").disabled,
            "Background work does not disable unrelated actions"
          );
          doc.getElementById("feed-title").focus();
        });
        deferred.resolve();
        await finishCachedPreviewUpdate(browser);
        await SpecialPowers.spawn(browser, [], () => {
          const doc = content.document;
          is(
            doc.activeElement,
            doc.getElementById("feed-title"),
            "Do not override focus moved while a background response was pending"
          );
        });
      } finally {
        deferred.resolve();
      }
    });
  });
});

add_task(async function test_foreground_focus_and_immediate_busy_policy() {
  await withFeedService(async ({ stubs }) => {
    await withFeedPage(async browser => {
      await showCachedPreview(browser);
      const deferred = Promise.withResolvers();
      stubs.refresh.returns(deferred.promise);
      try {
        await SpecialPowers.spawn(browser, [], () => {
          const doc = content.document;
          const observer = new content.MutationObserver(() => {
            observer.disconnect();
            const buttons = [...doc.querySelectorAll("#subscriptions button")];
            doc.documentElement.dataset.rowsBlocked = String(
              buttons.length === 3 && buttons.every(button => button.disabled)
            );
          });
          observer.observe(doc.getElementById("subscriptions"), {
            childList: true,
          });
        });
        await BrowserTestUtils.synthesizeMouseAtCenter(
          '[data-action="Refresh"]',
          {},
          browser
        );
        await TestUtils.waitForCondition(() => stubs.refresh.calledOnce);
        await SpecialPowers.spawn(browser, [], () => {
          const link = content.document.querySelector("#preview-items a");
          link.focus();
          is(
            content.document.activeElement,
            link,
            "Move focus while reload is pending"
          );
        });
        deferred.resolve(CACHE);
        await waitForStatus(browser, "feeds-status-reloaded");
        await SpecialPowers.spawn(browser, [], () => {
          const doc = content.document;
          is(
            doc.documentElement.dataset.rowsBlocked,
            "true",
            "New action buttons obey busy state before asynchronous completion"
          );
          is(
            doc.activeElement,
            doc.querySelector("#preview-items a"),
            "Reload completion must not override the user's subsequent focus movement"
          );
          ok(
            !doc.querySelector('[data-action="Refresh"]').disabled,
            "Re-enable actions after the foreground operation finishes"
          );
        });
      } finally {
        deferred.resolve(CACHE);
      }
    });
  });
});

add_task(
  async function test_private_rows_stay_disabled_during_preview_update() {
    await withFeedService(async ({ stubs }) => {
      const win = await BrowserTestUtils.openNewBrowserWindow({
        private: true,
      });
      try {
        await withFeedPage(
          async browser => {
            await showCachedPreview(browser);
            const deferred = Promise.withResolvers();
            const calls = stubs.init.callCount;
            stubs.init.onCall(calls + 1).returns(deferred.promise);
            try {
              await watchCachedPreviewUpdate(browser);
              Services.obs.notifyObservers(
                null,
                "waterfox-live-bookmarks-changed"
              );
              await TestUtils.waitForCondition(
                () => stubs.init.callCount >= calls + 2
              );
              await SpecialPowers.spawn(browser, [], () => {
                const doc = content.document;
                for (const button of doc.querySelectorAll(
                  "#subscriptions button[data-mutates]"
                )) {
                  ok(
                    button.disabled,
                    "New private mutation buttons are disabled before preview resolves"
                  );
                }
                ok(
                  doc.getElementById("import").disabled,
                  "Keep private import disabled"
                );
                ok(
                  !doc.getElementById("export").disabled,
                  "Keep allowed export usable during background work"
                );
              });
              deferred.resolve();
              await finishCachedPreviewUpdate(browser);
            } finally {
              deferred.resolve();
            }
          },
          "about:feeds",
          win
        );
      } finally {
        await BrowserTestUtils.closeWindow(win);
      }
    });
  }
);

add_task(async function test_isolation_prefill_and_cached_text_preview() {
  await withFeedService(async ({ stubs }) => {
    const initialURL = "https://example.com/not-fetched.xml";
    await withFeedPage(
      async browser => {
        ok(
          browser.contentPrincipal.isContentPrincipal,
          "Use a content principal"
        );
        ok(
          !browser.contentPrincipal.isSystemPrincipal,
          "Never use system principal"
        );
        is(
          browser.remoteType,
          "privilegedabout",
          "Use the isolated about process"
        );
        ok(
          stubs.create.notCalled,
          "Opening a discovered URL does not subscribe"
        );
        ok(stubs.refresh.notCalled, "Opening the page does not refresh feeds");

        await SpecialPowers.spawn(
          browser,
          [initialURL, FEED.title],
          async (url, title) => {
            const doc = content.document;
            const pageTitle = await doc.l10n.formatValue("feeds-page-title");
            ok(
              pageTitle && pageTitle !== "feeds-page-title",
              "Resolve the page title at runtime"
            );
            is(
              doc.getElementById("feed-url").value,
              url,
              "Prefill the discovered URL"
            );
            is(
              doc.getElementById("feed-title").value,
              "",
              "An unsubscribed URL without a supplied title stays untitled"
            );
            is(
              doc.querySelector(".feed-title").textContent,
              title,
              "Title stays literal text"
            );
            ok(
              !doc.querySelector(".subscription img"),
              "Do not render feed HTML"
            );
            doc.querySelector('[data-action="Preview"]').click();
            await ContentTaskUtils.waitForCondition(
              () => !doc.getElementById("preview").hidden,
              "Wait for the cached preview"
            );
            const items = doc.querySelectorAll("#preview-items li");
            is(items.length, 2, "Show cached items");
            is(
              items[0].textContent,
              "<script>untrusted title</script>",
              "Item titles stay text"
            );
            is(
              items[0].querySelector("a").rel,
              "noopener noreferrer",
              "Isolate opened articles"
            );
            ok(!items[1].querySelector("a"), "Unsafe item URLs are not links");
            ok(
              !doc.querySelector(
                "#preview script, #preview img, #preview iframe"
              ),
              "No rich content"
            );
            let blocked = false;
            try {
              await content.fetch(
                "https://example.com/forbidden-feed-page-fetch"
              );
            } catch {
              blocked = true;
            }
            ok(blocked, "CSP forbids remote fetches from the page");
          }
        );
        ok(stubs.peek.calledOnce, "Read the service cache");
        ok(stubs.refresh.notCalled, "Preview does not fetch");
      },
      `about:feeds?url=${encodeURIComponent(initialURL)}`
    );
  });
});

add_task(async function test_existing_title_prefill_uses_initial_metadata() {
  await withFeedService(async ({ stubs, subscriptions }) => {
    const title = "Renamed in Bookmarks";
    subscriptions[0].title = title;
    stubs.peek.returns({ ...CACHE, title: "Publisher title" });
    const initialURL = "https://EXAMPLE.com:443/feeds/../feed.xml#discovered";
    await withFeedPage(
      async browser => {
        await SpecialPowers.spawn(
          browser,
          [initialURL, title],
          (url, storedTitle) => {
            const doc = content.document;
            is(
              doc.getElementById("feed-url").value,
              url,
              "Keep the supplied URL"
            );
            is(
              doc.getElementById("feed-title").value,
              storedTitle,
              "Use the renamed subscription title, not the query or publisher title"
            );
          }
        );
        ok(stubs.create.notCalled, "Prefilling does not subscribe");
        ok(stubs.peek.notCalled, "Prefilling only needs subscription metadata");
        ok(stubs.refresh.notCalled, "Prefilling does not refresh feeds");

        for (const input of ["User-entered title", ""]) {
          await SpecialPowers.spawn(browser, [input], value => {
            content.document.getElementById("feed-title").value = value;
          });
          const updatedTitle = `Renamed again with input: ${input}`;
          subscriptions[0] = { ...subscriptions[0], title: updatedTitle };
          Services.obs.notifyObservers(null, "waterfox-live-bookmarks-changed");
          await SpecialPowers.spawn(
            browser,
            [input, updatedTitle],
            async (value, updated) => {
              const doc = content.document;
              await ContentTaskUtils.waitForCondition(
                () => doc.querySelector(".feed-title").textContent === updated,
                "Wait for the background subscription update"
              );
              is(
                doc.getElementById("feed-title").value,
                value,
                "Background updates leave even an emptied title input alone"
              );
            }
          );
        }
      },
      `about:feeds?url=${encodeURIComponent(initialURL)}&title=Discovery%20title`
    );
  });
});

add_task(async function test_initial_prefill_preserves_pending_input() {
  await withFeedService(async ({ stubs }) => {
    const deferred = Promise.withResolvers();
    stubs.init.returns(deferred.promise);
    try {
      await BrowserTestUtils.withNewTab(
        {
          gBrowser,
          url: `about:feeds?url=${encodeURIComponent(FEED.feedURL)}`,
        },
        async browser => {
          await TestUtils.waitForCondition(() => stubs.init.called);
          await SpecialPowers.spawn(browser, [], () => {
            content.document.getElementById("feed-title").value =
              "Keep my input";
          });
          deferred.resolve();
          await waitForStatus(browser, "feeds-status-ready");
          await SpecialPowers.spawn(browser, [], () => {
            is(
              content.document.getElementById("feed-title").value,
              "Keep my input",
              "The initial list response does not overwrite an entered title"
            );
          });
        }
      );
    } finally {
      deferred.resolve();
    }
  });
});

add_task(async function test_bounded_query_title_is_only_a_new_feed_fallback() {
  await withFeedService(async ({ stubs, subscriptions }) => {
    subscriptions[0].title = "";
    for (const [url, title, expected] of [
      [
        "https://example.com/new.xml",
        "Chrome-supplied title",
        "Chrome-supplied title",
      ],
      ["https://example.com/new.xml", "x".repeat(1024), "x".repeat(1024)],
      ["https://example.com/new.xml", "x".repeat(1025), ""],
      [FEED.feedURL, "Do not replace an empty stored title", ""],
      ["", "A title without a URL", ""],
    ]) {
      await withFeedPage(
        async browser => {
          await SpecialPowers.spawn(browser, [expected], value => {
            is(
              content.document.getElementById("feed-title").value,
              value,
              "Only use a bounded query title for a new feed URL"
            );
          });
        },
        `about:feeds?url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}`
      );
    }
    ok(stubs.create.notCalled && stubs.refresh.notCalled, "No prefill fetches");
  });
});

add_task(async function test_duplicate_subscription_shows_cached_preview() {
  await withFeedService(async ({ stubs, subscriptions }) => {
    subscriptions[0].title = "Existing renamed subscription";
    await withFeedPage(async browser => {
      await SpecialPowers.spawn(browser, [], () => {
        const doc = content.document;
        doc.getElementById("feed-url").value =
          "https://EXAMPLE.com:443/feed.xml#duplicate";
        doc.getElementById("feed-title").value = "A different title";
        doc.getElementById("subscribe-form").requestSubmit();
      });
      await waitForStatus(browser, "feeds-status-preview");
      is(subscriptions.length, 1, "Do not duplicate a renamed subscription");
      is(
        subscriptions[0].title,
        "Existing renamed subscription",
        "Keep its title"
      );
      await SpecialPowers.spawn(browser, [], () => {
        const doc = content.document;
        ok(
          !doc.getElementById("preview").hidden,
          "Show the existing cached preview"
        );
        is(
          doc.getElementById("preview-title").textContent,
          "Existing renamed subscription",
          "Preview the stored subscription"
        );
        is(
          doc.querySelectorAll("#preview-items li").length,
          2,
          "Show cached items"
        );
        is(
          doc.getElementById("status").dataset.l10nId,
          "feeds-status-preview",
          "Do not report the duplicate as newly subscribed"
        );
      });
      ok(stubs.peek.calledOnce, "Read the cached preview");
      ok(stubs.refresh.notCalled, "Do not refresh a duplicate");
    });
  });
});

add_task(async function test_subscribe_reload_remove_and_observe() {
  await withFeedService(async ({ stubs, subscriptions }) => {
    subscriptions.length = 0;
    await withFeedPage(async browser => {
      await SpecialPowers.spawn(browser, [], () => {
        const doc = content.document;
        doc.getElementById("feed-url").value = "https://example.com/manual.xml";
        doc.getElementById("feed-title").value = "  My feed  ";
        doc.getElementById("subscribe-form").requestSubmit();
      });
      await waitForStatus(browser, "feeds-status-preview");
      Assert.deepEqual(
        stubs.create.firstCall.args[0],
        {
          feedURL: "https://example.com/manual.xml",
          title: "My feed",
          parentGuid: PlacesUtils.bookmarks.menuGuid,
        },
        "Use the Bookmarks menu, not a content-supplied bookmark parent"
      );

      await SpecialPowers.spawn(browser, [], () => {
        content.document.querySelector('[data-action="Refresh"]').click();
      });
      await waitForStatus(browser, "feeds-status-reloaded");
      Assert.deepEqual(stubs.refresh.firstCall.args, [
        FEED.guid,
        { force: true },
      ]);

      subscriptions[0] = {
        ...subscriptions[0],
        title: "Changed in another window",
      };
      Services.obs.notifyObservers(null, "waterfox-live-bookmarks-changed");
      await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () =>
            content.document.querySelector(".feed-title").textContent ===
              "Changed in another window" &&
            !content.document.getElementById("export").disabled,
          "Update subscription metadata after a service notification"
        );
        content.document.querySelector('[data-action="Remove"]').click();
      });
      await waitForStatus(browser, "feeds-status-removed");
      ok(
        stubs.remove.calledOnceWithExactly(FEED.guid),
        "Remove only the selected subscription"
      );
      await SpecialPowers.spawn(browser, [], () => {
        ok(
          !content.document.getElementById("empty").hidden,
          "Show the empty state"
        );
        ok(
          content.document.getElementById("preview").hidden,
          "Discard the removed preview"
        );
      });
    });
  });
});

add_task(async function test_navigation_discards_pending_page_requests() {
  await withFeedService(async ({ stubs }) => {
    await withFeedPage(async browser => {
      const actor =
        browser.browsingContext.currentWindowGlobal.getActor("FeedPage");
      const deferred = Promise.withResolvers();
      stubs.refresh.returns(deferred.promise);
      try {
        await SpecialPowers.spawn(browser, [], () => {
          content.document.querySelector('[data-action="Refresh"]').click();
        });
        await TestUtils.waitForCondition(() => stubs.refresh.calledOnce);
        const list = await actor.receiveMessage({
          name: "Feeds:List",
          data: {},
        });
        const preview = await actor.receiveMessage({
          name: "Feeds:Preview",
          data: { guid: FEED.guid },
        });
        ok(
          list.ok && preview.ok,
          "Allow cache-only reads while a mutation is pending"
        );

        const nextURL = "about:feeds?url=https%3A%2F%2Fexample.com%2Fother.xml";
        let loaded = BrowserTestUtils.browserLoaded(browser, false, nextURL);
        BrowserTestUtils.startLoadingURIString(browser, nextURL);
        await loaded;
        const stale = await actor.receiveMessage({
          name: "Feeds:Create",
          data: { feedURL: FEED.feedURL },
        });
        is(
          stale.error,
          "feeds-error-unavailable",
          "Reject requests from the previous document"
        );
        ok(
          stubs.create.notCalled,
          "Do not forward a stale mutation to the service"
        );

        deferred.resolve(CACHE);
        loaded = BrowserTestUtils.waitForContentEvent(
          browser,
          "pageshow",
          true,
          event => event.target.documentURI === "about:feeds"
        );
        browser.goBack();
        await loaded;
        await SpecialPowers.spawn(browser, [], async () => {
          await ContentTaskUtils.waitForCondition(
            () => content.document.getElementById("export")?.disabled === false,
            "Returning to the page must not leave an abandoned request busy"
          );
          ok(
            content.document.getElementById("preview").hidden,
            "An abandoned reload must not replace the restored UI with its response"
          );
        });
      } finally {
        deferred.resolve(CACHE);
      }
    });
  });
});

add_task(async function test_parent_rejects_untrusted_payloads() {
  await withFeedService(async ({ stubs }) => {
    await withFeedPage(async browser => {
      await SpecialPowers.spawn(browser, [FEED.guid], async guid => {
        const actor = content.windowGlobalChild.getActor("FeedPage");
        for (const [command, args] of [
          ["Create", { feedURL: "javascript:alert(1)" }],
          ["Create", { feedURL: "file:///tmp/feed.xml" }],
          ["Create", { feedURL: "https://user:password@example.com/feed" }],
          ["Create", { feedURL: "https://example.com/" + "x".repeat(4096) }],
          [
            "Create",
            { feedURL: "https://example.com/feed", title: "x".repeat(1025) },
          ],
          [
            "Create",
            { feedURL: "https://example.com/feed", parentGuid: "toolbar_____" },
          ],
          ["Remove", { guid: "invalid" }],
          ["Refresh", { guid, force: true }],
          ["Preview", { feedURL: "https://example.com/unsubscribed" }],
          ["Import", { path: "/tmp/untrusted.opml" }],
          ["Export", { path: "/tmp/untrusted.opml" }],
          ["Unknown", {}],
        ]) {
          const result = await actor.sendQuery(`Feeds:${command}`, args);
          ok(!result.ok, `Reject invalid ${command} payload`);
        }
      });
      ok(stubs.create.notCalled, "No invalid subscription reached the service");
      ok(stubs.remove.notCalled, "No invalid removal reached the service");
      ok(stubs.refresh.notCalled, "No invalid refresh reached the service");
      ok(stubs.importOPML.notCalled, "Content cannot supply a file path");
    });
  });
});

add_task(async function test_private_page_is_read_only() {
  await withFeedService(async ({ stubs }) => {
    const win = await BrowserTestUtils.openNewBrowserWindow({ private: true });
    try {
      await withFeedPage(
        async browser => {
          await SpecialPowers.spawn(browser, [FEED.guid], async guid => {
            const doc = content.document;
            ok(
              !doc.getElementById("private-notice").hidden,
              "Explain the private restriction"
            );
            ok(
              doc.getElementById("subscribe-fields").disabled,
              "Disable subscription input"
            );
            for (const button of doc.querySelectorAll("button[data-mutates]")) {
              ok(button.disabled, "Disable each mutation control");
            }
            ok(
              !doc.querySelector('[data-action="Preview"]').disabled,
              "Allow cached previews"
            );
            const actor = content.windowGlobalChild.getActor("FeedPage");
            for (const [command, args] of [
              ["Create", { feedURL: "https://example.com/private.xml" }],
              ["Remove", { guid }],
              ["Refresh", { guid }],
              ["Import", {}],
            ]) {
              const result = await actor.sendQuery(`Feeds:${command}`, args);
              is(
                result.error,
                "feeds-error-private",
                "Enforce private restrictions in the parent"
              );
            }
            ok(
              (await actor.sendQuery("Feeds:Preview", { guid })).ok,
              "Allow a cache-only query"
            );
          });
          ok(
            stubs.create.notCalled &&
              stubs.remove.notCalled &&
              stubs.refresh.notCalled &&
              stubs.importOPML.notCalled,
            "No private mutation reached the service"
          );
        },
        "about:feeds",
        win
      );
    } finally {
      await BrowserTestUtils.closeWindow(win);
    }
  });
});

add_task(async function test_opml_uses_native_picker_and_bounded_reads() {
  await withFeedService(async ({ stubs }) => {
    const { MockFilePicker } = SpecialPowers;
    const path = PathUtils.join(
      PathUtils.tempDir,
      `waterfox-feed-page-${Services.uuid.generateUUID()}.opml`
    );
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(path);
    MockFilePicker.init();
    MockFilePicker.setFiles([file]);
    MockFilePicker.returnValue = MockFilePicker.returnOK;
    let shown = 0;
    MockFilePicker.showCallback = () => {
      shown++;
    };
    try {
      await withFeedPage(async browser => {
        await SimpleTest.promiseFocus(window);
        browser.focus();
        await BrowserTestUtils.synthesizeMouseAtCenter("#export", {}, browser);
        await waitForStatus(browser, "feeds-status-exported");
        is(shown, 1, "Export requires a native picker");
        is(
          await IOUtils.readUTF8(path),
          serializeOPML([FEED]),
          "Export escaped OPML metadata"
        );

        await BrowserTestUtils.synthesizeMouseAtCenter("#import", {}, browser);
        await waitForStatus(browser, "feeds-status-imported");
        is(shown, 2, "Import requires a native picker");
        Assert.deepEqual(stubs.importOPML.firstCall.args, [
          serializeOPML([FEED]),
          PlacesUtils.bookmarks.menuGuid,
        ]);

        MockFilePicker.returnValue = MockFilePicker.returnCancel;
        await BrowserTestUtils.synthesizeMouseAtCenter("#import", {}, browser);
        await waitForStatus(browser, "feeds-status-canceled");
        ok(stubs.importOPML.calledOnce, "Cancel does not import");

        MockFilePicker.returnValue = MockFilePicker.returnOK;
        await IOUtils.write(path, new Uint8Array(2 * 1024 * 1024 + 1));
        await BrowserTestUtils.synthesizeMouseAtCenter("#import", {}, browser);
        await SpecialPowers.spawn(browser, [], async () => {
          await ContentTaskUtils.waitForCondition(
            () =>
              content.document.getElementById("error").dataset.l10nId ===
              "feeds-error-file-too-large",
            "Reject oversized OPML before passing it to the service"
          );
        });
        ok(
          stubs.importOPML.calledOnce,
          "Oversized files do not reach the service"
        );
      });
    } finally {
      MockFilePicker.cleanup();
      await IOUtils.remove(path, { ignoreAbsent: true });
    }
  });
});

add_task(async function test_top_level_on_demand_discovery() {
  const url =
    "https://example.com/document-builder.sjs?html=" +
    encodeURIComponent("<!doctype html><title>Discovery</title>");
  await BrowserTestUtils.withNewTab({ gBrowser, url }, async browser => {
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      const add = (href, type = "application/rss+xml", rel = "alternate") => {
        const link = doc.createElement("link");
        link.href = href;
        link.type = type;
        link.rel = rel;
        doc.head.append(link);
      };
      add("/rss.xml#first", "APPLICATION/RSS+XML; charset=utf-8", "ALTERNATE");
      add("/rss.xml#duplicate");
      add("/atom.xml", "application/atom+xml");
      add("javascript:alert(1)");
      add("file:///tmp/feed.xml");
      add("chrome://browser/content/browser.xhtml");
      add("https://user:password@example.com/feed");
      add("/plain.xml", "text/xml");
      add("/not-alternate.xml", "application/rss+xml", "related");
      const frame = doc.createElement("iframe");
      frame.srcdoc =
        '<link rel="alternate" type="application/rss+xml" href="https://example.com/frame.xml">';
      doc.body.append(frame);
    });
    const actor =
      browser.browsingContext.currentWindowGlobal.getActor("FeedDiscovery");
    Assert.deepEqual(
      await actor.discover(),
      [
        { title: "Discovery", feedURL: "https://example.com/rss.xml" },
        { title: "Discovery", feedURL: "https://example.com/atom.xml" },
      ],
      "Discover only deduplicated top-level RSS/Atom advertisements"
    );
    Assert.throws(
      () => browser.browsingContext.currentWindowGlobal.getActor("FeedPage"),
      /./,
      "The page actor is not registered for ordinary web content"
    );

    await SpecialPowers.spawn(browser, [], () => {
      for (let i = 0; i < 25; i++) {
        const link = content.document.createElement("link");
        link.rel = "alternate";
        link.type = "application/atom+xml";
        link.href = `https://example.com/feed-${i}.xml`;
        content.document.head.append(link);
      }
    });
    is((await actor.discover()).length, 20, "Cap actual discovery at 20 feeds");

    const sandbox = sinon.createSandbox();
    try {
      const response = sandbox.stub(actor, "sendQuery");
      response.resolves([
        { title: "Unsafe", feedURL: "chrome://browser/content/browser.xhtml" },
        { title: "x".repeat(1025), feedURL: "https://example.com/long-title" },
        {
          title: "Oversize",
          feedURL: "https://example.com/" + "x".repeat(4096),
        },
        { title: "Valid", feedURL: "/relative.xml#fragment" },
        { title: "Duplicate", feedURL: "https://example.com/relative.xml" },
      ]);
      Assert.deepEqual(
        await actor.discover(),
        [{ title: "Valid", feedURL: "https://example.com/relative.xml" }],
        "Revalidate a compromised child's results in the parent"
      );
      response.resolves(
        Array(21).fill({ title: "Feed", feedURL: FEED.feedURL })
      );
      Assert.deepEqual(
        await actor.discover(),
        [],
        "Reject oversized result arrays"
      );

      const delayed = Promise.withResolvers();
      response.returns(delayed.promise);
      const discovery = actor.discover();
      const loaded = BrowserTestUtils.browserLoaded(
        browser,
        false,
        "about:blank"
      );
      BrowserTestUtils.startLoadingURIString(browser, "about:blank");
      await loaded;
      delayed.resolve([{ title: "Stale", feedURL: FEED.feedURL }]);
      Assert.deepEqual(
        await discovery,
        [],
        "Discard results from a previous document"
      );
    } finally {
      sandbox.restore();
    }
  });
});
