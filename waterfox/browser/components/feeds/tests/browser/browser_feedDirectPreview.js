/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { FeedPreview } = ChromeUtils.importESModule(
  "resource:///modules/FeedPreview.sys.mjs"
);
const { LiveBookmarks } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarks.sys.mjs"
);
const { parseFeed } = ChromeUtils.importESModule(
  "resource:///modules/FeedParser.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const DIRECT = ROOT + "feed-direct.sjs?";
const PREF = "browser.feeds.discovery.enabled";
const ACTION_ID = "waterfox-feeds";
const BUTTON_ID = "pageAction-urlbar-waterfox-feeds";
const XML =
  '<rss version="2.0"><channel><title>Direct feed</title></channel></rss>';
const MIME_TYPES = ["application/rss+xml", "application/atom+xml"];
const mimeService = Cc["@mozilla.org/mime;1"].getService(Ci.nsIMIMEService);
const handlers = Cc["@mozilla.org/uriloader/handler-service;1"].getService(
  Ci.nsIHandlerService
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, true]] });
  await LiveBookmarks.init();
  for (const type of MIME_TYPES) {
    const original = mimeService.getFromTypeAndExtension(type, "");
    const existed = handlers.exists(original);
    handlers.remove(original);
    registerCleanupFunction(() => {
      if (existed) {
        handlers.store(original);
      } else {
        handlers.remove(mimeService.getFromTypeAndExtension(type, ""));
      }
    });
  }
});

async function loadDirect(browser, variant) {
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url =>
    url.startsWith("about:feeds?preview=")
  );
  BrowserTestUtils.startLoadingURIString(browser, DIRECT + variant);
  await loaded;
  return FeedPreview.get(browser.browsingContext, browser.currentURI.spec);
}

async function loadUnrecognized(browser, variant) {
  const url = DIRECT + variant;
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await loaded;
}

add_task(
  async function direct_formats_work_with_discovery_disabled_without_refetch() {
    await SpecialPowers.pushPrefEnv({ set: [[PREF, false]] });
    const requests = [];
    const baseline = LiveBookmarks.list();
    const observer = subject => {
      const url = subject.QueryInterface(Ci.nsIHttpChannel).URI.spec;
      if (url.startsWith(DIRECT)) {
        requests.push(url);
      }
    };
    Services.obs.addObserver(observer, "http-on-modify-request");
    try {
      const selected = gBrowser.selectedTab;
      const tab = BrowserTestUtils.addTab(gBrowser, "about:blank");
      try {
        const browser = tab.linkedBrowser;
        let previousURI;
        for (const variant of [
          "rss2-xml",
          "rss2-plain",
          "rss2-rss-coop",
          "atom1-atom",
        ]) {
          const record = await loadDirect(browser, variant);
          ok(record, `Recognized ${variant} in a background tab`);
          is(
            gBrowser.selectedTab,
            selected,
            "Keep the foreground tab selected"
          );
          ok(
            browser.contentPrincipal.isContentPrincipal,
            "The preview does not get a system principal"
          );
          is(record.feedURL, DIRECT + variant, "Use the actual document URL");
          is(record.feed.title, "Direct feed", "Parse the feed title");
          is(record.feed.items.length, 1, "Only safe entries survive parsing");
          is(record.feed.items[0].description, "Safe description");
          ok(
            PageActions.actionForID(ACTION_ID).getDisabled(window),
            "Preview does not enable the disabled page action"
          );
          is(
            requests.filter(url => url === DIRECT + variant).length,
            1,
            "Preview reuses the loaded document instead of fetching it"
          );
          if (previousURI) {
            is(
              FeedPreview.get(browser.browsingContext, previousURI),
              null,
              "Loading a different feed replaces the cached record for the previous feed URL"
            );
          }
          previousURI = browser.currentURI.spec;
        }
        is(
          FeedPreview.get(selected.linkedBrowser.browsingContext, previousURI),
          null,
          "Another browsing context cannot read the cached preview"
        );
        const duplicateURI = new URL(previousURI);
        duplicateURI.searchParams.append(
          "preview",
          duplicateURI.searchParams.get("preview")
        );
        is(
          FeedPreview.get(browser.browsingContext, duplicateURI.href),
          null,
          "Duplicate preview parameters are invalid even for the cached feed URL"
        );
        Assert.deepEqual(
          LiveBookmarks.list(),
          baseline,
          "No implicit subscriptions"
        );
      } finally {
        BrowserTestUtils.removeTab(tab);
      }
    } finally {
      Services.obs.removeObserver(observer, "http-on-modify-request");
      await SpecialPowers.popPrefEnv();
    }
  }
);

add_task(async function download_policy_and_attachments_bypass_preview() {
  await BrowserTestUtils.withNewTab("about:blank", async browser => {
    const type = MIME_TYPES[0];
    const variant = "notfeed-rss";
    const response = TestUtils.topicObserved(
      "http-on-examine-response",
      subject =>
        subject.QueryInterface(Ci.nsIChannel).URI.spec === DIRECT + variant
    );
    await loadUnrecognized(browser, variant);
    const [subject] = await response;
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    const converter = Cc[
      `@mozilla.org/streamconv;1?from=${type}&to=*/*`
    ].createInstance(Ci.nsIStreamConverter);
    is(converter.getConvertedType(type, channel), "application/xml");

    const rejects = message =>
      Assert.throws(
        () => converter.getConvertedType(type, channel),
        error => error.result === Cr.NS_ERROR_NOT_AVAILABLE,
        message
      );
    channel.loadInfo.isUserTriggeredSave = true;
    try {
      rejects("Explicit Save requests cannot be converted");
    } finally {
      channel.loadInfo.isUserTriggeredSave = false;
    }

    const info = mimeService.getFromTypeAndExtension(type, "");
    try {
      for (const action of [
        Ci.nsIHandlerInfo.saveToDisk,
        Ci.nsIHandlerInfo.useHelperApp,
        Ci.nsIHandlerInfo.useSystemDefault,
      ]) {
        info.alwaysAskBeforeHandling = false;
        info.preferredAction = action;
        handlers.store(info);
        rejects("Respect an existing download or external-handler preference");
      }
      info.preferredAction = Ci.nsIHandlerInfo.handleInternally;
      info.alwaysAskBeforeHandling = true;
      handlers.store(info);
      rejects("Respect an existing always-ask preference");
      info.alwaysAskBeforeHandling = false;
      handlers.store(info);
      is(converter.getConvertedType(type, channel), "application/xml");
    } finally {
      handlers.remove(info);
    }
  });
  const { Downloads } = ChromeUtils.importESModule(
    "resource://gre/modules/Downloads.sys.mjs"
  );
  const directory = Services.dirsvc.get("TmpD", Ci.nsIFile);
  directory.append("feed-mime-downloads");
  directory.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o700);
  const list = await Downloads.getList(Downloads.PUBLIC);
  const downloads = [];
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.download.folderList", 2],
      ["browser.download.dir", directory.path],
      ["browser.download.useDownloadDir", true],
      ["browser.download.alwaysOpenPanel", false],
      ["browser.download.always_ask_before_handling_new_types", false],
      ["browser.helperApps.neverAsk.saveToDisk", MIME_TYPES.join(",")],
    ],
  });
  try {
    await BrowserTestUtils.withNewTab("about:blank", async browser => {
      await loadUnrecognized(browser, "rss2-html");
      for (const variant of ["rss2-rss-attachment", "atom1-atom-attachment"]) {
        const url = DIRECT + variant;
        const finished = Promise.withResolvers();
        const view = {
          onDownloadAdded(download) {
            if (download.source.url === url) {
              downloads.push(download);
              this.onDownloadChanged(download);
            }
          },
          onDownloadChanged(download) {
            if (
              download.source.url === url &&
              (download.succeeded || download.error || download.canceled)
            ) {
              finished.resolve(download);
            }
          },
        };
        await list.addView(view);
        try {
          BrowserTestUtils.startLoadingURIString(browser, url);
          const download = await finished.promise;
          ok(download.succeeded, "A top-level MIME attachment is downloaded");
          const xml = await IOUtils.readUTF8(download.target.path);
          ok(xml.includes("Direct feed"), "The saved file contains the feed");
          ok(
            xml.includes("&lt;b&gt;"),
            "The download retains the original markup"
          );
        } finally {
          await list.removeView(view);
        }
      }
      is(
        browser.currentURI.spec,
        DIRECT + "rss2-html",
        "Keep the original page"
      );
    });
  } finally {
    for (const download of downloads) {
      await download.finalize(true);
      await list.remove(download);
    }
    directory.remove(true);
    for (const type of MIME_TYPES) {
      handlers.remove(mimeService.getFromTypeAndExtension(type, ""));
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function fetch_and_iframe_feeds_pass_through() {
  await BrowserTestUtils.withNewTab("about:blank", async browser => {
    await loadUnrecognized(browser, "rss2-html");
    for (const [index, type] of MIME_TYPES.entries()) {
      const url = DIRECT + (index ? "atom1-atom-attachment" : "rss2-rss");
      await SpecialPowers.spawn(browser, [url, type], async (uri, mimeType) => {
        const result = await content.fetch(uri);
        is(result.headers.get("Content-Type"), `${mimeType}; charset=utf-8`);
        const xml = await result.text();
        ok(
          xml.includes("&lt;b&gt;Safe description&lt;/b&gt;"),
          "Fetch sees raw XML"
        );
        ok(
          !xml.includes("about:feeds"),
          "No preview is substituted into fetch"
        );
        if (uri.endsWith("attachment")) {
          ok(
            result.headers.get("Content-Disposition").startsWith("attachment")
          );
        }
      });
    }
    await SpecialPowers.spawn(browser, [DIRECT + "atom1-xml"], async url => {
      const frame = content.document.createElement("iframe");
      const loaded = ContentTaskUtils.waitForEvent(frame, "load");
      frame.src = url;
      content.document.body.appendChild(frame);
      await loaded;
      is(frame.contentDocument.documentElement.localName, "feed");
    });
    is(
      browser.currentURI.spec,
      DIRECT + "rss2-html",
      "Fetch and iframe feeds do not navigate the top-level page"
    );
  });
});

add_task(
  async function direct_preview_icon_reenables_and_uses_existing_subscribe_panel() {
    await BrowserTestUtils.withNewTab("about:blank", async browser => {
      const record = await loadDirect(browser, "rss2-xml");
      await TestUtils.waitForCondition(
        () => !PageActions.actionForID(ACTION_ID).getDisabled(window),
        "Offer the direct feed from the preview record"
      );

      const previewURI = browser.currentURI.spec;
      await SpecialPowers.pushPrefEnv({ set: [[PREF, false]] });
      ok(
        PageActions.actionForID(ACTION_ID).getDisabled(window),
        "Toggle hides preview icon"
      );
      await SpecialPowers.popPrefEnv();
      await TestUtils.waitForCondition(
        () => !PageActions.actionForID(ACTION_ID).getDisabled(window),
        "Toggle re-enables the preview icon without a FeedDiscovery actor"
      );
      is(browser.currentURI.spec, previewURI, "No reload or new preview");
      const shown = BrowserTestUtils.waitForEvent(
        window,
        "popupshown",
        true,
        event => event.target.id === "waterfox-feed-subscribe-panel"
      );
      EventUtils.synthesizeMouseAtCenter(
        document.getElementById(BUTTON_ID),
        {}
      );
      const panel = (await shown).target;
      is(document.getElementById("waterfox-feed-url").value, record.feedURL);
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      panel.hidePopup();
      await hidden;
    });
  }
);

add_task(async function rejects_html_malformed_dtd_and_oversized_documents() {
  await BrowserTestUtils.withNewTab("about:blank", async browser => {
    for (const variant of [
      "rss2-html",
      "malformed-xml",
      "dtd-rss",
      "multibyte-plain",
    ]) {
      await loadUnrecognized(browser, variant);
      const actor =
        browser.browsingContext.currentWindowGlobal.getActor("FeedDiscovery");
      const xml = await actor.sendQuery("Feeds:ReadDirect");
      if (xml !== null) {
        Assert.throws(
          () => parseFeed(xml, DIRECT + variant),
          /./,
          "The parent parser rejects this document"
        );
      }
      is(
        browser.currentURI.spec,
        DIRECT + variant,
        "Rejected documents stay in place"
      );
      is(
        FeedPreview.get(browser.browsingContext, browser.currentURI.spec),
        null
      );
    }
  });
});

add_task(
  async function parent_rechecks_mime_and_navigation_after_direct_query() {
    await BrowserTestUtils.withNewTab("about:blank", async browser => {
      await loadUnrecognized(browser, "rss2-html");
      let actor =
        browser.browsingContext.currentWindowGlobal.getActor("FeedDiscovery");
      let query = sinon.stub(actor, "sendQuery").resolves(XML);
      try {
        await actor.receiveMessage({ name: "Feeds:Direct" });
        is(
          browser.currentURI.spec,
          DIRECT + "rss2-html",
          "HTML cannot request a handoff even with valid XML"
        );
      } finally {
        query.restore();
      }
      await loadUnrecognized(browser, "notfeed-xml");
      actor =
        browser.browsingContext.currentWindowGlobal.getActor("FeedDiscovery");
      const navigating = Promise.withResolvers();
      query = sinon.stub(actor, "sendQuery").returns(navigating.promise);
      const progress = sinon.spy(browser, "addProgressListener");
      try {
        const pending = actor.receiveMessage({ name: "Feeds:Direct" });
        progress.lastCall.args[0].onStateChange(
          { isTopLevel: true },
          null,
          Ci.nsIWebProgressListener.STATE_START |
            Ci.nsIWebProgressListener.STATE_IS_DOCUMENT
        );
        navigating.resolve(XML);
        await pending;
        is(
          browser.currentURI.spec,
          DIRECT + "notfeed-xml",
          "A newer load cancels handoff even before its document commits"
        );
      } finally {
        navigating.resolve(null);
        query.restore();
        progress.restore();
      }
      await loadUnrecognized(browser, "notfeed-xml");
      actor =
        browser.browsingContext.currentWindowGlobal.getActor("FeedDiscovery");
      const deferred = Promise.withResolvers();
      query = sinon.stub(actor, "sendQuery").returns(deferred.promise);
      try {
        const pending = actor.receiveMessage({ name: "Feeds:Direct" });
        await loadUnrecognized(browser, "rss2-html");
        deferred.resolve(XML);
        await pending;
        is(
          browser.currentURI.spec,
          DIRECT + "rss2-html",
          "A stale response cannot replace a newer navigation"
        );
      } finally {
        deferred.resolve(null);
        query.restore();
      }
    });
  }
);
