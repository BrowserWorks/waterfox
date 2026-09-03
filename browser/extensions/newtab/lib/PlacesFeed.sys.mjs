/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  actionCreators as ac,
  actionTypes as at,
} from "resource://newtab/common/Actions.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  NewTabUtils: "resource://gre/modules/NewTabUtils.sys.mjs",
  PartnerLinkAttribution: "resource:///modules/PartnerLinkAttribution.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

const LINK_BLOCKED_EVENT = "newtab-linkBlocked";
const PLACES_LINKS_CHANGED_DELAY_TIME = 1000; // time in ms to delay timer for places links changed events

// The pref to store the blocked sponsors of the sponsored Top Sites.
// The value of this pref is an array (JSON serialized) of hostnames of the
// blocked sponsors.
const TOP_SITES_BLOCKED_SPONSORS_PREF = "browser.topsites.blockedSponsors";

const PREF_UNIFIED_ADS_TILES_ENABLED =
  "browser.newtabpage.activity-stream.unifiedAds.tiles.enabled";

const PREF_UNIFIED_ADS_BLOCKED_LIST =
  "browser.newtabpage.activity-stream.unifiedAds.blockedAds";

/**
 * PlacesObserver - observes events from PlacesUtils.observers
 */
class PlacesObserver {
  constructor(dispatch) {
    this.dispatch = dispatch;
    this.QueryInterface = ChromeUtils.generateQI(["nsISupportsWeakReference"]);
    this.handlePlacesEvent = this.handlePlacesEvent.bind(this);
  }

  handlePlacesEvent(events) {
    const removedPages = [];
    const removedBookmarks = [];

    for (const {
      itemType,
      source,
      dateAdded,
      guid,
      title,
      url,
      isRemovedFromStore,
      isTagging,
      type,
    } of events) {
      switch (type) {
        case "history-cleared":
          this.dispatch({ type: at.PLACES_HISTORY_CLEARED });
          break;
        case "page-removed":
          if (isRemovedFromStore) {
            removedPages.push(url);
          }
          break;
        case "bookmark-added":
          // Skips items that are not bookmarks (like folders), about:* pages or
          // default bookmarks, added when the profile is created.
          if (
            isTagging ||
            itemType !== lazy.PlacesUtils.bookmarks.TYPE_BOOKMARK ||
            source === lazy.PlacesUtils.bookmarks.SOURCES.IMPORT ||
            source === lazy.PlacesUtils.bookmarks.SOURCES.RESTORE ||
            source === lazy.PlacesUtils.bookmarks.SOURCES.RESTORE_ON_STARTUP ||
            source === lazy.PlacesUtils.bookmarks.SOURCES.SYNC ||
            (!url.startsWith("http://") && !url.startsWith("https://"))
          ) {
            continue;
          }

          this.dispatch({ type: at.PLACES_LINKS_CHANGED });
          this.dispatch({
            type: at.PLACES_BOOKMARK_ADDED,
            data: {
              bookmarkGuid: guid,
              bookmarkTitle: title,
              dateAdded: dateAdded * 1000,
              url,
            },
          });
          break;
        case "bookmark-removed":
          if (
            isTagging ||
            (itemType === lazy.PlacesUtils.bookmarks.TYPE_BOOKMARK &&
              source !== lazy.PlacesUtils.bookmarks.SOURCES.IMPORT &&
              source !== lazy.PlacesUtils.bookmarks.SOURCES.RESTORE &&
              source !==
                lazy.PlacesUtils.bookmarks.SOURCES.RESTORE_ON_STARTUP &&
              source !== lazy.PlacesUtils.bookmarks.SOURCES.SYNC)
          ) {
            removedBookmarks.push(url);
          }
          break;
      }
    }

    if (removedPages.length || removedBookmarks.length) {
      this.dispatch({ type: at.PLACES_LINKS_CHANGED });
    }

    if (removedPages.length) {
      this.dispatch({
        type: at.PLACES_LINKS_DELETED,
        data: { urls: removedPages },
      });
    }

    if (removedBookmarks.length) {
      this.dispatch({
        type: at.PLACES_BOOKMARKS_REMOVED,
        data: { urls: removedBookmarks },
      });
    }
  }
}

export class PlacesFeed {
  constructor() {
    this.placesChangedTimer = null;
    this.customDispatch = this.customDispatch.bind(this);
    this.placesObserver = new PlacesObserver(this.customDispatch);
  }

  addObservers() {
    lazy.PlacesUtils.observers.addListener(
      ["bookmark-added", "bookmark-removed", "history-cleared", "page-removed"],
      this.placesObserver.handlePlacesEvent
    );

    Services.obs.addObserver(this, LINK_BLOCKED_EVENT);
  }

  /**
   * setTimeout - A custom function that creates an nsITimer that can be cancelled
   *
   * @param {func} callback       A function to be executed after the timer expires
   * @param {int}  delay          The time (in ms) the timer should wait before the function is executed
   */
  setTimeout(callback, delay) {
    let timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.initWithCallback(callback, delay, Ci.nsITimer.TYPE_ONE_SHOT);
    return timer;
  }

  customDispatch(action) {
    // If we are changing many links at once, delay this action and only dispatch
    // one action at the end
    if (action.type === at.PLACES_LINKS_CHANGED) {
      if (this.placesChangedTimer) {
        this.placesChangedTimer.delay = PLACES_LINKS_CHANGED_DELAY_TIME;
      } else {
        this.placesChangedTimer = this.setTimeout(() => {
          this.placesChangedTimer = null;
          this.store.dispatch(ac.OnlyToMain(action));
        }, PLACES_LINKS_CHANGED_DELAY_TIME);
      }
    } else {
      // To avoid blocking Places notifications on expensive work, run it at the
      // next tick of the events loop.
      Services.tm.dispatchToMainThread(() =>
        this.store.dispatch(ac.BroadcastToContent(action))
      );
    }
  }

  removeObservers() {
    if (this.placesChangedTimer) {
      this.placesChangedTimer.cancel();
      this.placesChangedTimer = null;
    }
    lazy.PlacesUtils.observers.removeListener(
      ["bookmark-added", "bookmark-removed", "history-cleared", "page-removed"],
      this.placesObserver.handlePlacesEvent
    );
    Services.obs.removeObserver(this, LINK_BLOCKED_EVENT);
  }

  /**
   * observe - An observer for the LINK_BLOCKED_EVENT.
   *           Called when a link is blocked.
   *           Links can be blocked outside of newtab,
   *           which is why we need to listen to this
   *           on such a generic level.
   *
   * @param  {null} subject
   * @param  {str} topic   The name of the event
   * @param  {str} value   The data associated with the event
   */
  observe(subject, topic, value) {
    if (topic === LINK_BLOCKED_EVENT) {
      this.store.dispatch(
        ac.BroadcastToContent({
          type: at.PLACES_LINK_BLOCKED,
          data: { url: value },
        })
      );
    }
  }

  /**
   * Open a link in a desired destination defaulting to action's event.
   */
  openLink(action, where = "", isPrivate = false) {
    const params = {
      private: isPrivate,
      targetBrowser: action._target.browser,
      forceForeground: false, // This ensure we maintain user preference for how to open new tabs.
      globalHistoryOptions: {
        triggeringSponsoredURL: action.data.is_sponsored
          ? action.data.url
          : undefined,
        triggeringSource: "newtab",
      },
    };

    // Always include the referrer (even for http links) if we have one
    const { event, referrer, typedBonus } = action.data;
    if (referrer) {
      const ReferrerInfo = Components.Constructor(
        "@mozilla.org/referrer-info;1",
        "nsIReferrerInfo",
        "init"
      );
      params.referrerInfo = new ReferrerInfo(
        Ci.nsIReferrerInfo.UNSAFE_URL,
        true,
        Services.io.newURI(referrer)
      );
    }

    // Pocket gives us a special reader URL to open their stories in
    const urlToOpen =
      action.data.type === "pocket" ? action.data.open_url : action.data.url;

    try {
      let uri = Services.io.newURI(urlToOpen);
      if (!["http", "https"].includes(uri.scheme)) {
        throw new Error(
          `Can't open link using ${uri.scheme} protocol from the new tab page.`
        );
      }
    } catch (e) {
      console.error(e);
      return;
    }

    // Mark the page as typed for frecency bonus before opening the link
    if (typedBonus) {
      lazy.PlacesUtils.history.markPageAsTyped(Services.io.newURI(urlToOpen));
    }

    const win = action._target.window;
    win.openTrustedLinkIn(
      urlToOpen,
      where || lazy.BrowserUtils.whereToOpenLink(event),
      params
    );

    // If there's an original URL e.g. using the unprocessed %YYYYMMDDHH% tag,
    // add a visit for that so it may become a frecent top site.
    if (action.data.original_url) {
      lazy.PlacesUtils.history.insert({
        url: action.data.original_url,
        visits: [{ transition: lazy.PlacesUtils.history.TRANSITION_TYPED }],
      });
    }
  }

  /**
   * Sends an attribution request for Top Sites interactions.
   *
   * @param {object} data
   *   Attribution parameters from a Top Site.
   */
  makeAttributionRequest(data) {
    let args = Object.assign(
      {
        campaignID: Services.prefs.getStringPref(
          "browser.partnerlink.campaign.topsites"
        ),
      },
      data
    );
    lazy.PartnerLinkAttribution.makeRequest(args);
  }

  async fillSearchTopSiteTerm({ _target, data }) {
    const searchEngine = await lazy.SearchService.getEngineByAlias(data.label);
    _target.window.gURLBar.search(data.label, {
      searchEngine,
      searchModeEntry: "topsites_newtab",
    });
  }

  _getDefaultSearchEngine(isPrivateWindow) {
    return lazy.SearchService[
      isPrivateWindow ? "defaultPrivateEngine" : "defaultEngine"
    ];
  }

  /**
   * Add the hostnames of the given urls to the Top Sites sponsor blocklist.
   *
   * @param {Array} urls
   *   An array of the objects structured as `{ url }`
   */
  addToBlockedTopSitesSponsors(urls) {
    let blockedPref;
    try {
      blockedPref = JSON.parse(
        Services.prefs.getStringPref(TOP_SITES_BLOCKED_SPONSORS_PREF, "[]")
      );
    } catch (e) {
      blockedPref = [];
    }
    const merged = new Set([
      ...blockedPref,
      ...urls.map(url => lazy.NewTabUtils.shortURL(url)),
    ]);

    Services.prefs.setStringPref(
      TOP_SITES_BLOCKED_SPONSORS_PREF,
      JSON.stringify([...merged])
    );
  }

  /**
   * Add the block key (uuid) of the given urls to the blocked ads pref
   * to send back to the ads service when requesting new topsite ads
   * from the unified ads service
   *
   * @param {Array} block_key
   *   An array of the (string) keys
   */
  addToUnifiedAdsBlockedAdsList(keysArray) {
    const blockedAdsPref = Services.prefs.getStringPref(
      PREF_UNIFIED_ADS_BLOCKED_LIST,
      ""
    );

    let blockedAdsArray;

    if (blockedAdsPref === "") {
      // Set new IDs as prev blocked array
      blockedAdsArray = keysArray;
    } else {
      // Convert prev blocked csv list to array
      blockedAdsArray = blockedAdsPref
        .split(",")
        .map(s => s.trim())
        .filter(item => item);
      // Add new IDs to prev blocked array
      blockedAdsArray = blockedAdsArray.concat(keysArray);
    }

    // Save generated array as a CSV string
    Services.prefs.setStringPref(
      PREF_UNIFIED_ADS_BLOCKED_LIST,
      blockedAdsArray.join(",")
    );
  }

  onAction(action) {
    const unifiedAdsTilesEnabled = Services.prefs.getBoolPref(
      PREF_UNIFIED_ADS_TILES_ENABLED,
      false
    );

    switch (action.type) {
      case at.INIT:
        // Briefly avoid loading services for observing for better startup timing
        Services.tm.dispatchToMainThread(() => this.addObservers());
        break;
      case at.UNINIT:
        this.removeObservers();
        break;
      case at.ABOUT_SPONSORED_TOP_SITES: {
        const url = `${Services.urlFormatter.formatURLPref(
          "app.support.baseURL"
        )}sponsor-privacy`;
        const win = action._target.window;
        win.openTrustedLinkIn(url, "tab");
        break;
      }
      case at.BLOCK_URL: {
        if (action.data) {
          let sponsoredTopSites = [];
          let sponsoredBlockKeys = [];
          action.data.forEach(site => {
            const { url, pocket_id, isSponsoredTopSite, block_key } = site;
            lazy.NewTabUtils.activityStreamLinks.blockURL({ url, pocket_id });

            if (isSponsoredTopSite) {
              sponsoredTopSites.push({ url });

              // Add block keys if available
              if (unifiedAdsTilesEnabled) {
                sponsoredBlockKeys.push(block_key);
              }
            }
          });
          if (sponsoredTopSites.length) {
            this.addToBlockedTopSitesSponsors(sponsoredTopSites);
          }
          if (sponsoredBlockKeys.length) {
            this.addToUnifiedAdsBlockedAdsList(sponsoredBlockKeys);
          }
        }
        break;
      }
      case at.BOOKMARK_URL:
        lazy.NewTabUtils.activityStreamLinks.addBookmark(
          action.data,
          action._target.window
        );
        break;
      case at.DELETE_BOOKMARK_BY_ID:
        lazy.NewTabUtils.activityStreamLinks.deleteBookmark(action.data);
        break;
      case at.DELETE_HISTORY_URL: {
        const { url, forceBlock, pocket_id, original_url } = action.data;
        lazy.NewTabUtils.activityStreamLinks.deleteHistoryEntry(
          original_url || url
        );
        if (forceBlock) {
          lazy.NewTabUtils.activityStreamLinks.blockURL({
            url: original_url || url,
            pocket_id,
          });
        }
        break;
      }
      case at.OPEN_NEW_WINDOW:
        this.openLink(action, "window");
        break;
      case at.OPEN_PRIVATE_WINDOW:
        this.openLink(action, "window", true);
        break;
      case at.FILL_SEARCH_TERM:
        this.fillSearchTopSiteTerm(action);
        break;
      case at.OPEN_LINK: {
        this.openLink(action, action.data.where);
        break;
      }
      case at.PARTNER_LINK_ATTRIBUTION:
        this.makeAttributionRequest(action.data);
        break;
    }
  }
}

// Exported for testing only
PlacesFeed.PlacesObserver = PlacesObserver;
