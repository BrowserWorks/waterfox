/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { FeedLocationBar } = ChromeUtils.importESModule(
  "resource:///modules/FeedLocationBar.sys.mjs"
);
const { LiveBookmarks } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarks.sys.mjs"
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

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["ui.prefersReducedMotion", 1],
      ["browser.toolbars.keyboard_navigation", true],
    ],
  });
  await LiveBookmarks.init();
  const subscriptions = LiveBookmarks.list();
  const requests = [];
  const observer = subject => {
    const url = subject.QueryInterface(Ci.nsIHttpChannel).URI.spec;
    if (url.includes("/feeds/tests/browser/") && url.includes("/feed.xml")) {
      requests.push(url);
    }
  };
  Services.obs.addObserver(observer, "http-on-modify-request");
  registerCleanupFunction(() => {
    Services.obs.removeObserver(observer, "http-on-modify-request");
    Assert.deepEqual(requests, [], "Never download before subscription");
    Assert.deepEqual(
      LiveBookmarks.list(),
      subscriptions,
      "Never subscribe implicitly"
    );
  });
});

async function withFeedWindow(task, options = {}) {
  const win = await BrowserTestUtils.openNewBrowserWindow(options);
  try {
    await SimpleTest.promiseFocus(win);
    await task(win);
  } finally {
    await BrowserTestUtils.closeWindow(win);
  }
}

async function loadPage(browser, url) {
  const loaded = BrowserTestUtils.browserLoaded(browser, false, url);
  BrowserTestUtils.startLoadingURIString(browser, url);
  await loaded;
}

async function waitForFeeds(win, urls, previousFeeds) {
  // Observe committed results without driving discovery or the UI update.
  await TestUtils.waitForCondition(
    () => {
      const state = FeedLocationBar._states.get(win);
      const button = win.document.getElementById(BUTTON_ID);
      return (
        state?.browser === win.gBrowser.selectedBrowser &&
        state.global === state.browser.browsingContext.currentWindowGlobal &&
        state.feeds !== previousFeeds &&
        JSON.stringify(state.feeds.map(feed => feed.feedURL)) ===
          JSON.stringify(urls) &&
        PageActions.actionForID(ACTION_ID).getDisabled(win) === !urls.length &&
        (!urls.length ||
          PageActions.actionForID(ACTION_ID).getWantsSubview(win) ===
            urls.length > 1) &&
        !!(button && BrowserTestUtils.isVisible(button)) === !!urls.length
      );
    },
    `Automatic page action update: ${JSON.stringify(urls)}`
  );
  return win.document.getElementById(BUTTON_ID);
}

async function changeHead(win, urls, task) {
  const previous = FeedLocationBar._states.get(win).feeds;
  await SpecialPowers.spawn(win.gBrowser.selectedBrowser, [], task);
  return waitForFeeds(win, urls, previous);
}

async function openFeedPanel(win, url, key = null) {
  const button = win.document.getElementById(BUTTON_ID);
  const shown = BrowserTestUtils.waitForEvent(
    win.document,
    "popupshown",
    true,
    event => event.target.id === PANEL_ID
  );
  if (key) {
    win.gURLBar.focus();
    EventUtils.synthesizeKey("KEY_Tab", {}, win);
    const maxSteps = button.parentElement.children.length;
    for (
      let i = 0;
      win.document.activeElement !== button && i < maxSteps;
      i++
    ) {
      EventUtils.synthesizeKey("KEY_ArrowRight", {}, win);
    }
    is(win.document.activeElement, button, "Reach the action by keyboard");
    EventUtils.synthesizeKey(key, {}, win);
  } else {
    EventUtils.synthesizeMouseAtCenter(button, {}, win);
  }
  const panel = (await shown).target;
  is(panel.localName, "panel", "Open the native subscription popup directly");
  ok(
    !win.BrowserPageActions.activatedActionPanelNode ||
      win.BrowserPageActions.activatedActionPanelNode.state === "closed",
    "A single feed does not open the PageActions chooser"
  );
  is(button.getAttribute("aria-expanded"), "true", "Expose the open panel");
  is(
    win.document.getElementById("waterfox-feed-url").value,
    url,
    "Prefill the current feed URL"
  );
  is(
    win.document.getElementById("waterfox-feed-title").value,
    FeedLocationBar._states.get(win).feeds[0].title,
    "Prefill the advertised title"
  );
  is(
    win.document.getElementById("waterfox-feed-folder").value,
    PlacesUtils.bookmarks.menuGuid,
    "Default to Bookmarks Menu"
  );
  return { panel, button };
}

add_task(async function automatic_discovery_and_navigation() {
  await withFeedWindow(async win => {
    const action = PageActions.actionForID(ACTION_ID);
    ok(action.getDisabled(), "The action is disabled by default");
    ok(action.pinnedToUrlbar, "Pin the native action to the location bar");
    await loadPage(win.gBrowser.selectedBrowser, EMPTY);
    await waitForFeeds(win, []);
    await loadPage(win.gBrowser.selectedBrowser, PAGE);
    const button = await waitForFeeds(win, [FEED]);
    const star = win.document.getElementById("star-button-box");
    is(button.parentElement, star.parentElement, "Share the actions container");
    ok(
      button.compareDocumentPosition(star) & Node.DOCUMENT_POSITION_FOLLOWING,
      "Place the feed action before the star"
    );
    is(button.getAttribute("aria-haspopup"), "dialog", "Describe the popup");
    const { panel } = await openFeedPanel(win, FEED);
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    await loadPage(win.gBrowser.selectedBrowser, EMPTY);
    await hidden;
    await waitForFeeds(win, []);
    await loadPage(
      win.gBrowser.selectedBrowser,
      PAGE.replace("https:", "http:")
    );
    await waitForFeeds(win, [
      new URL("feed.xml", win.gBrowser.selectedBrowser.currentURI.spec).href,
    ]);
    const html = `<link rel="alternate" type="application/rss+xml" href="${FEED}">`;
    await loadPage(
      win.gBrowser.selectedBrowser,
      "data:text/html," + encodeURIComponent(html)
    );
    await waitForFeeds(win, []);
  });
});

add_task(async function head_mutations_update_automatically() {
  await withFeedWindow(async win => {
    await loadPage(win.gBrowser.selectedBrowser, EMPTY);
    await waitForFeeds(win, []);
    await changeHead(win, [FEED], () => {
      const link = content.document.createElement("link");
      link.rel = "alternate";
      link.type = "application/rss+xml";
      link.href = "feed.xml";
      content.document.head.appendChild(link);
    });
    await changeHead(win, [FEED + "?changed"], () => {
      content.document.querySelector("link").href = "feed.xml?changed#fragment";
    });
    await changeHead(win, [ROOT + "nested/feed.xml?changed"], () => {
      const base = content.document.createElement("base");
      base.href = "nested/";
      content.document.head.prepend(base);
    });
    await changeHead(win, [ROOT + "other/feed.xml?changed"], () => {
      content.document.querySelector("base").href = "other/";
    });
    await changeHead(win, [FEED + "?changed"], () => {
      content.document.querySelector("base").remove();
    });
    const { panel } = await openFeedPanel(win, FEED + "?changed");
    await changeHead(win, [], () => {
      content.document.querySelector("link").remove();
    });
    await TestUtils.waitForCondition(
      () => panel.state === "closed",
      "Removing the last advertisement dismisses the subscription popup"
    );
    const button = await changeHead(win, [FEED], () => {
      const head = content.document.createElement("head");
      head.innerHTML =
        '<link rel="alternate" type="application/atom+xml" href="feed.xml">';
      content.document.head.replaceWith(head);
    });
    ok(
      !button.hasAttribute("data-feed-discovered"),
      "Do not reannounce the head"
    );
  });
});

add_task(async function tab_switching_and_background_isolation() {
  await withFeedWindow(async win => {
    const foreground = win.gBrowser.selectedTab;
    await loadPage(foreground.linkedBrowser, PAGE);
    await waitForFeeds(win, [FEED]);
    const global = foreground.linkedBrowser.browsingContext.currentWindowGlobal;
    const other = await BrowserTestUtils.openNewForegroundTab(
      win.gBrowser,
      EMPTY
    );
    await waitForFeeds(win, []);
    await SpecialPowers.spawn(foreground.linkedBrowser, [], () => {
      for (const link of content.document.querySelectorAll("link")) {
        link.href = "feed.xml?background";
      }
    });
    const actor = global.getActor("FeedDiscovery");
    const feeds = await actor.discover();
    is(
      feeds[0].feedURL,
      FEED + "?background",
      "The background really has a feed"
    );
    // Await the notification handler, including any incorrectly triggered update.
    await actor.receiveMessage({ name: "Feeds:Changed" });
    await waitForFeeds(win, []);
    await BrowserTestUtils.switchTab(win.gBrowser, foreground);
    const button = await waitForFeeds(win, [FEED + "?background"]);
    is(
      foreground.linkedBrowser.browsingContext.currentWindowGlobal,
      global,
      "Switch back to the same WindowGlobal"
    );
    ok(
      !button.hasAttribute("data-feed-discovered"),
      "Tab switching never pulses"
    );
    const { panel } = await openFeedPanel(win, FEED + "?background");
    const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
    await BrowserTestUtils.switchTab(win.gBrowser, other);
    await hidden;
    await waitForFeeds(win, []);
    await loadPage(foreground.linkedBrowser, EMPTY);
    await BrowserTestUtils.switchTab(win.gBrowser, foreground);
    await waitForFeeds(win, []);
  });
});

add_task(async function iframe_and_unsafe_links_are_not_advertisements() {
  await withFeedWindow(async win => {
    await loadPage(win.gBrowser.selectedBrowser, PAGE);
    await waitForFeeds(win, [FEED]);
    await changeHead(win, [], async () => {
      const doc = content.document;
      doc.querySelectorAll("link").forEach(link => link.remove());
      for (const href of [
        "javascript:alert(1)",
        "data:text/xml,feed",
        "file:///feed.xml",
        "https://user:pass@example.com/feed.xml",
        "",
      ]) {
        const link = doc.createElement("link");
        link.rel = "alternate";
        link.type = "application/rss+xml";
        link.setAttribute("href", href);
        doc.head.appendChild(link);
      }
      doc.head.insertAdjacentHTML(
        "beforeend",
        `<link rel="alternate" type="text/html" href="feed.xml">
         <link rel="canonical" type="application/rss+xml" href="feed.xml">`
      );
      const frame = doc.createElement("iframe");
      frame.src = "feed-discovery.html";
      const loaded = ContentTaskUtils.waitForEvent(frame, "load");
      doc.body.appendChild(frame);
      await loaded;
      ok(frame.contentDocument.querySelector("link"), "Iframe advertisement");
    });
  });
});

add_task(async function keyboard_offers_prefill_without_subscribing() {
  for (const isPrivate of [false, true]) {
    await withFeedWindow(
      async win => {
        await loadPage(win.gBrowser.selectedBrowser, PAGE);
        await waitForFeeds(win, [FEED]);
        const tabs = [...win.gBrowser.tabs];
        let openedTabs = 0;
        const onTabOpen = () => openedTabs++;
        win.gBrowser.tabContainer.addEventListener("TabOpen", onTabOpen);
        try {
          for (const dismiss of ["cancel", "escape"]) {
            const key = dismiss === "cancel" ? "KEY_Enter" : " ";
            const { panel, button } = await openFeedPanel(win, FEED, key);
            const doc = win.document;
            const title = doc.getElementById("waterfox-feed-title");
            const url = doc.getElementById("waterfox-feed-url");
            is(title.value, "Integration feed", "Use the advertisement title");
            is(title.readOnly, isPrivate, "Private titles are read-only");
            is(url.readOnly, isPrivate, "Private URLs are read-only");
            ok(!title.disabled && !url.disabled, "Allow reading both fields");
            is(doc.activeElement, title, "Focus the prefilled title");
            is(
              doc.getElementById("waterfox-feed-folder").disabled,
              isPrivate,
              "Private windows cannot change the destination"
            );
            is(
              doc.getElementById("waterfox-feed-subscribe").disabled,
              isPrivate,
              "Private windows cannot subscribe"
            );
            is(
              doc.getElementById("waterfox-feed-subscribe-private").hidden,
              !isPrivate,
              "Show the private read-only notice"
            );
            ok(
              !doc.getElementById("waterfox-feed-folder-tree"),
              "Do not create a folder tree before it is requested"
            );
            if (isPrivate) {
              EventUtils.synthesizeKey("KEY_Enter", {}, win);
              await TestUtils.waitForTick();
              is(panel.state, "open", "Enter cannot submit a private form");
            }

            const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
            if (dismiss === "cancel") {
              const cancel = doc.getElementById("waterfox-feed-cancel");
              ok(!cancel.disabled, "Cancel remains available");
              cancel.focus();
              is(
                doc.activeElement,
                cancel,
                "Focus Cancel before pressing Enter"
              );
              EventUtils.synthesizeKey("KEY_Enter", {}, win);
            } else {
              EventUtils.synthesizeKey("KEY_Escape", {}, win);
            }
            await hidden;

            await TestUtils.waitForCondition(
              () => doc.activeElement === button,
              `${dismiss} restores keyboard focus to the RSS action`
            );
            is(
              button.getAttribute("aria-expanded"),
              "false",
              "Panel dismissed"
            );
            ok(!doc.getElementById(PANEL_ID), "Remove the dismissed form");
            await waitForFeeds(win, [FEED]);
          }
          is(openedTabs, 0, "Opening and dismissing never opens about:feeds");
          Assert.deepEqual([...win.gBrowser.tabs], tabs, "Keep the same tabs");
        } finally {
          win.gBrowser.tabContainer.removeEventListener("TabOpen", onTabOpen);
        }
      },
      { private: isPrivate }
    );
  }
});

function watchPulse(win) {
  return BrowserTestUtils.waitForEvent(
    win.document,
    "animationstart",
    true,
    event => event.animationName === "waterfox-feed-discovered"
  ).then(({ target }) => {
    const animation = target.getAnimations()[0];
    animation.pause();
    return animation;
  });
}

add_task(async function finite_pulse_and_reduced_motion() {
  await SpecialPowers.pushPrefEnv({ set: [["ui.prefersReducedMotion", 0]] });
  try {
    await withFeedWindow(async win => {
      const started = watchPulse(win);
      await loadPage(win.gBrowser.selectedBrowser, PAGE);
      const animation = await started;
      const button = await waitForFeeds(win, [FEED]);
      ok(
        Number.isFinite(animation.effect.getComputedTiming().endTime),
        "The discovery pulse finishes without looping indefinitely"
      );
      const ended = BrowserTestUtils.waitForEvent(button, "animationend");
      animation.finish();
      await ended;
      ok(
        !button.hasAttribute("data-feed-discovered"),
        "Clear the pulse marker"
      );
      await changeHead(win, [], () => {
        content.document
          .querySelectorAll("link")
          .forEach(link => link.remove());
      });
      const restored = await changeHead(win, [FEED], () => {
        content.document.head.innerHTML =
          '<link rel="alternate" type="application/rss+xml" href="feed.xml">';
      });
      ok(
        !restored.hasAttribute("data-feed-discovered"),
        "Rediscovery never pulses"
      );
      const restarted = watchPulse(win);
      await loadPage(win.gBrowser.selectedBrowser, PAGE + "?new-document");
      await restarted;
      const newButton = await waitForFeeds(win, [FEED]);
      ok(newButton.hasAttribute("data-feed-discovered"), "New document pulses");
    });
  } finally {
    await SpecialPowers.popPrefEnv();
  }
  await withFeedWindow(async win => {
    await loadPage(win.gBrowser.selectedBrowser, PAGE);
    const button = await waitForFeeds(win, [FEED]);
    ok(win.matchMedia("(prefers-reduced-motion: reduce)").matches);
    const style = win.getComputedStyle(button.querySelector(".urlbar-icon"));
    is(style.animationName, "none", "Do not apply the discovery animation");
    is(
      button.getAnimations({ subtree: true }).length,
      0,
      "Keep discovery static"
    );
  });
});
