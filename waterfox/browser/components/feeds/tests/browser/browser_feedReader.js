/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { FeedReaderBridge } = ChromeUtils.importESModule(
  "resource:///modules/FeedReaderBridge.sys.mjs"
);
const { FeedPageParent } = ChromeUtils.importESModule(
  "resource:///actors/FeedPageParent.sys.mjs"
);
const { FeedReaderParent } = ChromeUtils.importESModule(
  "resource:///actors/FeedReaderParent.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const ARTICLE_URL = ROOT + "feed-empty.html?feed-reader-original";
const IMAGE_URL =
  "https://example.com/browser/browser/base/content/test/general/moz.png";

const SNAPSHOT = {
  url: ARTICLE_URL,
  title: "Cached feed title",
  byline: "Feed author",
  description: "Cached feed description",
  content: "<p>Only the cached feed contains this article.</p>",
};

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.feeds.loadImages", false],
      ["reader.font_type", "serif"],
    ],
  });
});

function prepareReader(browser, snapshot = SNAPSHOT) {
  const manager = browser.browsingContext.currentWindowGlobal;
  return FeedReaderBridge.prepare(manager.getActor("FeedPage"), snapshot);
}

async function appendFrame(parent, url) {
  await SpecialPowers.spawn(parent, [url], async frameURL => {
    const frame = content.document.createElement("iframe");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.src = frameURL;
    const loaded = new Promise(resolve => {
      frame.addEventListener("load", resolve, { once: true });
    });
    content.document.body.appendChild(frame);
    await loaded;
  });
  return parent.children[parent.children.length - 1];
}

async function checkReaderState(context, success) {
  await SpecialPowers.spawn(context, [success], async expectedSuccess => {
    const doc = content.document;
    await ContentTaskUtils.waitForCondition(
      () =>
        doc.body.classList.contains("loaded") ||
        doc.documentElement.dataset.isError === "true",
      "Wait for cached Reader content or its explicit error state"
    );
    is(
      doc.body.classList.contains("loaded"),
      expectedSuccess,
      "Only an authorized cached article is rendered"
    );
    is(
      doc.documentElement.dataset.isError === "true",
      !expectedSuccess,
      "Unauthorized requests fail closed"
    );
    if (!expectedSuccess) {
      is(
        doc.querySelector(".moz-reader-content").textContent,
        "",
        "Failure does not expose cached content"
      );
      const message = doc.querySelector(".reader-message");
      is(
        message.dataset.l10nId,
        "about-reader-load-error",
        "Show the Reader error rather than trying the original page"
      );
      ok(ContentTaskUtils.isVisible(message), "The failure message is visible");
    }
  });
}

async function withoutOriginalRequests(task) {
  const requests = [];
  const observer = subject => {
    const url = subject.QueryInterface(Ci.nsIHttpChannel).URI.spec;
    if (url.startsWith(ARTICLE_URL) || url.startsWith(IMAGE_URL)) {
      requests.push(url);
    }
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  try {
    await task(requests);
    Assert.deepEqual(
      requests.filter(url => url.startsWith(ARTICLE_URL)),
      [],
      "Cached Reader never requests the original page, including on failure"
    );
  } finally {
    Services.obs.removeObserver(observer, "http-on-modify-request");
  }
}

async function withReaderManager(task) {
  await withoutOriginalRequests(async () => {
    await BrowserTestUtils.withNewTab("about:blank", async browser => {
      const sandbox = sinon.createSandbox();
      const article = {
        ...SNAPSHOT,
        id: "reader-status",
        feedURL: ROOT + "feed.xml",
        guid: "readerfeed01",
        source: "Reader status feed",
        published: null,
        read: false,
        saved: false,
      };
      const model = {
        isPrivate: false,
        subscriptions: [
          {
            guid: article.guid,
            feedURL: article.feedURL,
            title: article.source,
            parentGuid: "menu________",
            siteURL: null,
          },
        ],
        articles: [article],
        savedArticles: [],
        folders: [{ guid: "menu________", title: "Bookmarks Menu" }],
        preferences: {
          opening: "reader",
          filter: "all",
          order: "newest",
          display: "list",
          loadImages: false,
        },
      };
      const deferredArticles = [];
      let pendingArticle;
      const deferArticle = () => {
        pendingArticle = { ...Promise.withResolvers(), requested: false };
        deferredArticles.push(pendingArticle);
        return pendingArticle;
      };
      const receivePageMessage = FeedPageParent.prototype.receiveMessage;
      const receiveReaderMessage = FeedReaderParent.prototype.receiveMessage;
      sandbox
        .stub(FeedPageParent.prototype, "receiveMessage")
        .callsFake(function (message) {
          if (this.browsingContext === browser.browsingContext) {
            if (message.name === "Feeds:List") {
              return { ok: true, value: model };
            }
            if (message.name === "Feeds:OpenReader") {
              Assert.deepEqual(
                message.data,
                { feedURL: article.feedURL, id: article.id },
                "The manager requests the selected cached article"
              );
              article.read = true;
              return {
                ok: true,
                value: {
                  readerURL: FeedReaderBridge.prepare(this, SNAPSHOT),
                  state: { read: true, saved: false },
                },
              };
            }
          }
          return receivePageMessage.call(this, message);
        });
      sandbox
        .stub(FeedReaderParent.prototype, "receiveMessage")
        .callsFake(function (message) {
          if (
            this.browsingContext.parent === browser.browsingContext &&
            message.name === "FeedReader:GetArticle" &&
            pendingArticle
          ) {
            const deferred = pendingArticle;
            pendingArticle = null;
            const cachedArticle = receiveReaderMessage.call(this, message);
            ok(cachedArticle, "The real bridge authorizes the manager's frame");
            deferred.requested = true;
            return deferred.promise.then(success =>
              success ? cachedArticle : null
            );
          }
          return receiveReaderMessage.call(this, message);
        });
      try {
        const loaded = BrowserTestUtils.browserLoaded(
          browser,
          false,
          "about:feeds"
        );
        BrowserTestUtils.startLoadingURIString(browser, "about:feeds");
        await loaded;
        await SpecialPowers.spawn(browser, [], async () => {
          await ContentTaskUtils.waitForCondition(
            () =>
              content.document.querySelector(
                '#article-list button[data-action="open"]'
              )?.disabled === false,
            "Wait for the manager's initial collection to finish loading"
          );
          is(
            content.document.getElementById("status").dataset.l10nId,
            "feeds-status-ready",
            "The collection without a restored Reader is ready"
          );
        });
        await task(browser, deferArticle);
      } finally {
        for (const deferred of deferredArticles) {
          deferred.resolve(false);
        }
        sandbox.restore();
      }
    });
  });
}

async function clickManagerArticle(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    content.document
      .querySelector('#article-list button[data-action="open"]')
      .click();
  });
}

async function checkManagerReaderLoading(browser, deferred) {
  await TestUtils.waitForCondition(
    () => deferred.requested,
    "Wait for the manager's Reader to request its article"
  );
  await SpecialPowers.spawn(browser, [], async () => {
    const doc = content.document;
    // Enabled controls ensure run() has finished, including restored-page init.
    await ContentTaskUtils.waitForCondition(
      () =>
        doc.getElementById("reader-frame")?.contentDocument?.readyState ===
          "complete" && !doc.getElementById("reader-read").disabled,
      "Wait for frame load and manager initialization, not article rendering"
    );
    const frameDoc = doc.getElementById("reader-frame").contentDocument;
    ok(!doc.getElementById("reader").hidden, "The manager shows its Reader");
    ok(!frameDoc.body.classList.contains("loaded"), "No article rendered yet");
    isnot(
      frameDoc.documentElement.dataset.isError,
      "true",
      "The pending article has not failed"
    );
    is(
      doc.getElementById("status").dataset.l10nId,
      "feeds-status-loading",
      "Frame load and manager initialization must not report Reader readiness"
    );
    ok(doc.getElementById("error").hidden, "No manager error while loading");
  });
}

async function checkManagerReaderResult(browser, success) {
  await checkReaderState(browser.browsingContext.children[0], success);
  await SpecialPowers.spawn(browser, [success], async ready => {
    const doc = content.document;
    const status = doc.getElementById("status");
    const error = doc.getElementById("error");
    await ContentTaskUtils.waitForCondition(
      () =>
        ready ? status.dataset.l10nId === "feeds-status-ready" : !error.hidden,
      "The manager observes the Reader's rendered content or error"
    );
    if (ready) {
      ok(error.hidden, "Successful rendering does not show a manager error");
    } else {
      is(
        error.dataset.l10nId,
        "feeds-reader-load-error",
        "The manager reports the Reader load error"
      );
      ok(ContentTaskUtils.isVisible(error), "The manager error is visible");
      isnot(
        status.dataset.l10nId,
        "feeds-status-ready",
        "A failed Reader is not reported as ready"
      );
    }
  });
}

add_task(async function manager_reader_lifecycle() {
  await withReaderManager(async (browser, deferArticle) => {
    const initialArticle = deferArticle();
    await clickManagerArticle(browser);
    await checkManagerReaderLoading(browser, initialArticle);
    initialArticle.resolve(true);
    await checkManagerReaderResult(browser, true);
    const previousURL = await SpecialPowers.spawn(
      browser,
      [ROOT + "feed.xml"],
      feedURL => {
        Assert.deepEqual(
          content.history.state.feedReader,
          { feedURL, id: "reader-status" },
          "Opening Reader stores its history state"
        );
        return content.document.getElementById("reader-frame").src;
      }
    );

    const restoredArticle = deferArticle();
    const loaded = BrowserTestUtils.browserLoaded(
      browser,
      false,
      "about:feeds"
    );
    browser.reload();
    await loaded;
    await checkManagerReaderLoading(browser, restoredArticle);
    await SpecialPowers.spawn(
      browser,
      [previousURL, ROOT + "feed.xml"],
      (oldURL, feedURL) => {
        Assert.deepEqual(
          content.history.state.feedReader,
          { feedURL, id: "reader-status" },
          "Reload preserves the selected article"
        );
        isnot(
          content.document.getElementById("reader-frame").src,
          oldURL,
          "Restoring Reader prepares a fresh token for the new manager document"
        );
      }
    );
    restoredArticle.resolve(true);
    await checkManagerReaderResult(browser, true);
  });

  await withReaderManager(async (browser, deferArticle) => {
    const deferred = deferArticle();
    await clickManagerArticle(browser);
    await checkManagerReaderLoading(browser, deferred);
    deferred.resolve(false);
    await checkManagerReaderResult(browser, false);
  });
});

add_task(async function cached_content_uses_safe_reader_document() {
  await withoutOriginalRequests(async () => {
    await BrowserTestUtils.withNewTab("about:feeds", async browser => {
      const parent = browser.browsingContext;
      const unsafeSnapshot = {
        ...SNAPSHOT,
        content:
          SNAPSHOT.content +
          '<script>document.documentElement.dataset.feedScriptRan = "true";</script>' +
          `<iframe src="${ARTICLE_URL}-frame"></iframe>`,
      };
      const frame = await appendFrame(
        parent,
        prepareReader(browser, unsafeSnapshot)
      );
      await checkReaderState(frame, true);
      const manager = frame.currentWindowGlobal;
      ok(
        manager.documentPrincipal.isContentPrincipal,
        "Use a content principal"
      );
      is(
        manager.documentPrincipal.URI.spec.split(/[?#]/, 1)[0],
        "about:feeds",
        "The Reader uses an about:feeds content principal, not the article principal"
      );
      ok(
        manager.documentPrincipal.equals(
          parent.currentWindowGlobal.documentPrincipal
        ),
        "Reader isolation is not a separate origin from the feed manager"
      );
      is(
        manager.remoteType,
        "privilegedabout",
        "Use the privileged about process"
      );
      is(frame.parent, parent, "The Reader is a direct child of about:feeds");
      ok(
        manager.getActor("FeedReader"),
        "The dedicated actor is available in frames"
      );

      await SpecialPowers.spawn(frame, [SNAPSHOT], snapshot => {
        const doc = content.document;
        ok(
          doc.body.classList.contains("feed-reader"),
          "Load the Reader document"
        );
        ok(
          !Array.from(doc.scripts).some(
            script => script.src === "chrome://browser/content/feeds/feeds.mjs"
          ),
          "The Reader document does not load the subscription manager script"
        );
        ok(
          !doc.querySelector(".moz-reader-content :is(script, iframe)"),
          "Sanitize active content before inserting the article"
        );
        is(
          doc.documentElement.dataset.feedScriptRan,
          undefined,
          "Cached article scripts do not execute in the shared origin"
        );
        is(
          doc.querySelector(".reader-title").textContent,
          snapshot.title,
          "Cached title"
        );
        is(
          doc.querySelector(".reader-credits").textContent,
          snapshot.byline,
          "Cached byline"
        );
        is(
          doc.querySelector(".moz-reader-content").textContent,
          "Only the cached feed contains this article.",
          "Render the cached body, not the original page"
        );

        is(
          content
            .getComputedStyle(doc.querySelector(".container"))
            .getPropertyValue("--font-family")
            .trim(),
          "serif",
          "Apply Reader typography to the cached article"
        );
      });
    });
  });
});

add_task(async function invalid_tokens_and_duplicate_views_fail_closed() {
  await withoutOriginalRequests(async () => {
    await BrowserTestUtils.withNewTab("about:feeds", async browser => {
      const validURL = prepareReader(browser);
      const mutations = [
        ["missing token", url => url.searchParams.delete("feedArticle")],
        ["empty token", url => url.searchParams.set("feedArticle", "")],
        [
          "unknown token",
          url => url.searchParams.set("feedArticle", "not-a-token"),
        ],
        [
          "mismatched article",
          url => url.searchParams.set("url", ARTICLE_URL + "-other"),
        ],
        [
          "duplicate token",
          url =>
            url.searchParams.append(
              "feedArticle",
              url.searchParams.get("feedArticle")
            ),
        ],
        ["duplicate URL", url => url.searchParams.append("url", ARTICLE_URL)],
        ["missing URL", url => url.searchParams.delete("url")],
        [
          "duplicate Reader view",
          url => url.searchParams.append("view", "reader"),
        ],
        [
          "Reader view first",
          url => url.searchParams.append("view", "collection"),
        ],
        [
          "Reader view last",
          url => {
            url.search = "view=collection&" + url.searchParams.toString();
          },
        ],
      ];
      for (const [label, mutate] of mutations) {
        info(label);
        const url = new URL(validURL);
        mutate(url);
        const frame = await appendFrame(browser.browsingContext, url.href);
        await checkReaderState(frame, false);
        is(
          FeedReaderBridge.getArticle(
            frame.currentWindowGlobal.getActor("FeedReader")
          ),
          null,
          "The bridge also rejects the invalid request"
        );
      }
      const reorderedURL = new URL(validURL);
      reorderedURL.searchParams.delete("view");
      reorderedURL.searchParams.append("view", "reader");
      const frame = await appendFrame(
        browser.browsingContext,
        reorderedURL.href
      );
      await checkReaderState(frame, true);
    });
  });
});

add_task(async function tokens_require_the_exact_parent_and_are_single_use() {
  await withoutOriginalRequests(async () => {
    await BrowserTestUtils.withNewTab("about:feeds", async browser => {
      const url = prepareReader(browser);
      await BrowserTestUtils.withNewTab("about:feeds", async otherBrowser => {
        const frame = await appendFrame(otherBrowser.browsingContext, url);
        await checkReaderState(frame, false);
      });

      const nestedParent = await appendFrame(
        browser.browsingContext,
        "about:blank"
      );
      const nested = await appendFrame(nestedParent, url);
      await checkReaderState(nested, false);

      await BrowserTestUtils.withNewTab(url, async topLevel => {
        await checkReaderState(topLevel.browsingContext, false);
      });

      const frame = await appendFrame(browser.browsingContext, url);
      await checkReaderState(frame, true);
      const replay = await appendFrame(browser.browsingContext, url);
      await checkReaderState(replay, false);

      const staleURL = prepareReader(browser);
      const loaded = BrowserTestUtils.browserLoaded(
        browser,
        false,
        "about:feeds?new-document"
      );
      BrowserTestUtils.startLoadingURIString(
        browser,
        "about:feeds?new-document"
      );
      await loaded;
      const stale = await appendFrame(browser.browsingContext, staleURL);
      await checkReaderState(stale, false);
      const fresh = await appendFrame(
        browser.browsingContext,
        prepareReader(browser)
      );
      await checkReaderState(fresh, true);
    });
  });
});

add_task(async function top_level_reader_routes_cannot_use_the_feed_manager() {
  await withoutOriginalRequests(async () => {
    await BrowserTestUtils.withNewTab("about:feeds", async browser => {
      const url = prepareReader(browser);
      const viewLast = new URL(url);
      viewLast.search = "view=collection&" + viewLast.searchParams.toString();
      for (const readerURL of [
        url,
        url + "&view=reader",
        url + "&view=collection",
        viewLast.href,
      ]) {
        info(readerURL);
        await BrowserTestUtils.withNewTab(readerURL, async readerBrowser => {
          await checkReaderState(readerBrowser.browsingContext, false);
          const parentActor =
            readerBrowser.browsingContext.currentWindowGlobal.getActor(
              "FeedPage"
            );
          Assert.throws(
            () => FeedReaderBridge.prepare(parentActor, SNAPSHOT),
            /Unavailable feed Reader source/,
            "A top-level Reader route cannot prepare cached articles"
          );
          await SpecialPowers.spawn(readerBrowser, [], async () => {
            const actor = content.windowGlobalChild.getActor("FeedPage");
            for (const [name, data] of [
              ["Feeds:List", {}],
              ["Feeds:SetPreference", { name: "loadImages", value: false }],
            ]) {
              const result = await actor.sendQuery(name, data);
              Assert.deepEqual(
                result,
                { ok: false, error: "feeds-error-unavailable" },
                "Reader routes cannot invoke feed manager queries: " + name
              );
            }
          });
        });
      }
      const frame = await appendFrame(browser.browsingContext, url);
      await checkReaderState(frame, true);
    });
  });
});

add_task(async function disabled_images_do_not_request_resources() {
  await withoutOriginalRequests(async requests => {
    await BrowserTestUtils.withNewTab("about:feeds", async browser => {
      const imageURL =
        IMAGE_URL +
        "?feed-reader=" +
        encodeURIComponent(Services.uuid.generateUUID().toString());
      const snapshot = {
        ...SNAPSHOT,
        content: `<p>Cached image:</p><img src="${imageURL}" alt="Feed image">`,
      };
      const frame = await appendFrame(
        browser.browsingContext,
        prepareReader(browser, snapshot)
      );
      await checkReaderState(frame, true);
      await SpecialPowers.spawn(frame, [], () => {
        const body = content.document.querySelector(".moz-reader-content");
        is(
          body.querySelectorAll("img").length,
          0,
          "Do not insert images while disabled"
        );
        ok(
          body.textContent.includes("Feed image"),
          "Keep image alternative text"
        );
      });
      Assert.deepEqual(
        requests,
        [],
        "Rendering with images disabled makes no requests"
      );

      await SpecialPowers.pushPrefEnv({
        set: [["browser.feeds.loadImages", true]],
      });
      try {
        await SpecialPowers.spawn(frame, [], async () => {
          await ContentTaskUtils.waitForCondition(() => {
            const image = content.document.querySelector(
              ".moz-reader-content img"
            );
            return image?.complete && image.naturalWidth > 0;
          }, "Enabling images loads the existing image fixture");
        });
        await TestUtils.waitForCondition(
          () => requests.includes(imageURL),
          "The observer detects the enabled-image positive control"
        );
      } finally {
        await SpecialPowers.popPrefEnv();
      }
      await SpecialPowers.spawn(frame, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => !content.document.querySelector(".moz-reader-content img"),
          "Disabling images again removes the loaded image"
        );
      });
    });
  });
});
