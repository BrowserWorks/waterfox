"use strict";

const { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
const { NewTabUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/NewTabUtils.sys.mjs"
);
const { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

const SEARCH_SHORTCUTS_EXPERIMENT_PREF =
  "browser.newtabpage.activity-stream.improvesearch.topSiteSearchShortcuts";

// A small 1x1 test png
const IMAGE_1x1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVQI12NgAAAAAgAB4iG8MwAAAABJRU5ErkJggg==";

add_task(async function test_topSites() {
  Services.prefs.setBoolPref(SEARCH_SHORTCUTS_EXPERIMENT_PREF, false);
  let visits = [];
  // `getTopFrecentSites` uses a threshold to filter low frecency results.
  // The minimum visit threshold is meant to mimic meaningful user engagement.
  // The date cutoff is to ensure visits in the recent past are still visible.
  // Both values are meant to accommodate variations in the frecency scoring
  // algorithm.
  const numVisits = 5;
  let visitDate = new Date();
  visitDate.setMonth(visitDate.getMonth() - 1);
  visitDate = visitDate.getTime();

  // Add a visit that is outside the default threshold. It'll be visible
  // when the threshold is the bare minimum but not when using the default
  // higher threshold used by the extension is applied.
  const OLD_URL = "https://www.oldexample.com";
  let olderVisitDate = new Date();
  olderVisitDate.setMonth(olderVisitDate.getMonth() - 6);
  olderVisitDate = olderVisitDate.getTime();
  // We do two older visits because a likely default threshold could filter out
  // one visit.
  PlacesTestUtils.addVisits([
    {
      url: OLD_URL,
      visitDate: olderVisitDate * 1000,
    },
    {
      url: OLD_URL,
      visitDate: olderVisitDate * 1000,
    },
  ]);

  async function setVisit(visit) {
    for (let j = 0; j < numVisits; ++j) {
      visitDate -= 1000;
      visit.visits.push({ date: new Date(visitDate) });
    }
    visits.push(visit);
    await PlacesUtils.history.insert(visit);
  }
  // Stick a couple sites into history.
  for (let i = 0; i < 2; ++i) {
    await setVisit({
      url: `http://example${i}.com/`,
      title: `visit${i}`,
      visits: [],
    });
    await setVisit({
      url: `http://www.example${i}.com/foobar`,
      title: `visit${i}-www`,
      visits: [],
    });
  }
  NewTabUtils.init();

  // Insert a favicon to show that favicons are not returned by default.
  let faviconData = new Map();
  faviconData.set("http://example0.com", IMAGE_1x1);
  await PlacesTestUtils.addFavicons(faviconData);

  // Ensure our links show up in activityStream.
  let links = await NewTabUtils.activityStreamLinks.getTopSites({
    onePerDomain: false,
    topsiteFrecency: 1,
  });

  // Sanity checks.
  Assert.ok(
    !visits.some(visit => visit.url && visit.url.includes(OLD_URL)),
    "Recent visits don't include the oldest visit."
  );
  Assert.ok(
    links.some(link => link.url && link.url.includes(OLD_URL)),
    "The returned links do include the oldest visit."
  );

  equal(
    links.length,
    // The recent visits plus the one older visit.
    visits.length + 1,
    "Top sites has been successfully initialized"
  );

  // Drop the visits.visits for later testing.
  visits = visits.map(v => {
    return { url: v.url, title: v.title, favicon: undefined, type: "url" };
  });

  // Test that results from all providers are returned by default.
  let extension = ExtensionTestUtils.loadExtension({
    manifest: {
      permissions: ["topSites"],
    },
    background() {
      browser.test.onMessage.addListener(async options => {
        let sites = await browser.topSites.get(options);
        browser.test.sendMessage("sites", sites);
      });
    },
  });

  await extension.startup();

  function getSites(options) {
    extension.sendMessage(options);
    return extension.awaitMessage("sites");
  }

  Assert.deepEqual(
    [visits[0], visits[2]],
    await getSites(),
    "got topSites default"
  );
  Assert.deepEqual(
    visits,
    await getSites({ onePerDomain: false }),
    "got topSites all links"
  );

  NewTabUtils.activityStreamLinks.blockURL(visits[0]);
  ok(
    NewTabUtils.blockedLinks.isBlocked(visits[0]),
    `link ${visits[0].url} is blocked`
  );

  Assert.deepEqual(
    [visits[2], visits[1]],
    await getSites(),
    "got topSites with blocked links filtered out"
  );
  Assert.deepEqual(
    [visits[0], visits[2]],
    await getSites({ includeBlocked: true }),
    "got topSites with blocked links included"
  );

  // Test favicon result
  let topSites = await getSites({ includeBlocked: true, includeFavicon: true });
  equal(topSites[0].favicon, IMAGE_1x1, "received favicon");

  equal(
    1,
    (await getSites({ limit: 1, includeBlocked: true })).length,
    "limit 1 topSite"
  );

  NewTabUtils.uninit();
  await extension.unload();
  await PlacesUtils.history.clear();
  Services.prefs.clearUserPref(SEARCH_SHORTCUTS_EXPERIMENT_PREF);
});

// Test pinned likns and search shortcuts.
add_task(async function test_topSites_complete() {
  Services.prefs.setBoolPref(SEARCH_SHORTCUTS_EXPERIMENT_PREF, true);
  NewTabUtils.init();
  let time = new Date();
  let pinnedIndex = 0;
  let entries = [
    {
      url: `http://pinned1.com/`,
      title: "pinned1",
      type: "url",
      pinned: pinnedIndex++,
      visitDate: time,
    },
    {
      url: `http://search1.com/`,
      title: "@search1",
      type: "search",
      pinned: pinnedIndex++,
      visitDate: new Date(--time),
    },
    {
      url: `https://amazon.com`,
      title: "@amazon",
      type: "search",
      visitDate: new Date(--time),
    },
    {
      url: `http://history1.com/`,
      title: "history1",
      type: "url",
      visitDate: new Date(--time),
    },
    {
      url: `http://history2.com/`,
      title: "history2",
      type: "url",
      visitDate: new Date(--time),
    },
    {
      url: `https://blocked1.com/`,
      title: "blocked1",
      type: "blocked",
      visitDate: new Date(--time),
    },
  ];

  for (let entry of entries) {
    // Build up frecency.
    await PlacesUtils.history.insert({
      url: entry.url,
      title: entry.title,
      visits: new Array(15).fill({
        date: entry.visitDate,
        transition: PlacesUtils.history.TRANSITIONS.LINK,
      }),
    });
    // Insert a favicon to show that favicons are not returned by default.
    await PlacesTestUtils.addFavicons(new Map([[entry.url, IMAGE_1x1]]));
    if (entry.pinned !== undefined) {
      let info =
        entry.type == "search"
          ? { url: entry.url, label: entry.title, searchTopSite: true }
          : { url: entry.url, title: entry.title };
      NewTabUtils.pinnedLinks.pin(info, entry.pinned);
    }
    if (entry.type == "blocked") {
      NewTabUtils.activityStreamLinks.blockURL({ url: entry.url });
    }
  }

  // Some transformation is necessary to match output data.
  let expectedResults = entries
    .filter(e => e.type != "blocked")
    .map(e => {
      e.favicon = undefined;
      delete e.visitDate;
      delete e.pinned;
      return e;
    });

  let extension = ExtensionTestUtils.loadExtension({
    manifest: {
      permissions: ["topSites"],
    },
    background() {
      browser.test.onMessage.addListener(async options => {
        let sites = await browser.topSites.get(options);
        browser.test.sendMessage("sites", sites);
      });
    },
  });

  await extension.startup();

  // Test that results are returned by the API.
  function getSites(options) {
    extension.sendMessage(options);
    return extension.awaitMessage("sites");
  }

  Assert.deepEqual(
    expectedResults,
    await getSites({ includePinned: true, includeSearchShortcuts: true }),
    "got topSites all links"
  );

  // Test no shortcuts.
  dump(JSON.stringify(await getSites({ includePinned: true })) + "\n");
  Assert.ok(
    !(await getSites({ includePinned: true })).some(
      link => link.type == "search"
    ),
    "should get no shortcuts"
  );

  // Test favicons.
  let topSites = await getSites({
    includePinned: true,
    includeSearchShortcuts: true,
    includeFavicon: true,
  });
  Assert.ok(
    topSites.every(f => f.favicon == IMAGE_1x1),
    "favicon is correct"
  );

  // Test options.limit.
  Assert.equal(
    1,
    (
      await getSites({
        includePinned: true,
        includeSearchShortcuts: true,
        limit: 1,
      })
    ).length,
    "limit to 1 topSite"
  );

  // Clear history for a pinned entry, then check results.
  await PlacesUtils.history.remove("http://pinned1.com/");
  let links = await getSites({ includePinned: true });
  Assert.ok(
    links.find(link => link.url == "http://pinned1.com/"),
    "Check unvisited pinned links are returned."
  );
  links = await getSites();
  Assert.ok(
    !links.find(link => link.url == "http://pinned1.com/"),
    "Check unvisited pinned links are not returned."
  );

  await extension.unload();
  NewTabUtils.uninit();
  await PlacesUtils.history.clear();
  await PlacesUtils.bookmarks.eraseEverything();
  Services.prefs.clearUserPref(SEARCH_SHORTCUTS_EXPERIMENT_PREF);
});
