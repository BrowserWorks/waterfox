/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  BinarySearch: "resource://gre/modules/BinarySearch.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  DeferredTask: "resource://gre/modules/DeferredTask.sys.mjs",
  ObjectUtils: "resource://gre/modules/ObjectUtils.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
});

const BULK_PLACES_EVENTS_THRESHOLD = 50;
const OBSERVER_DEBOUNCE_RATE_MS = 500;
const OBSERVER_DEBOUNCE_TIMEOUT_MS = 5000;

/**
 * An object that contains details of a page visit.
 *
 * @typedef {object} HistoryVisit
 *
 * @property {Date} date
 *   When this page was visited.
 * @property {string} title
 *   The page's title.
 * @property {string} url
 *   The page's URL.
 * @property {string} guid
 *   The page's GUID.
 */

/**
 * Cache key type depends on how visits are currently being grouped.
 *
 * By date: number - The start of day timestamp of the visit.
 * By site: string - The domain name of the visit.
 *
 * @typedef {number | string} CacheKey
 */

/**
 * Sorting by date or site, cache is stored as: (Date/Site) => List of Visits.
 * Sorting by date and site, cache is stored as: (Date) => (Site) => List of Visits.
 * Sorting by last visited, cache is stored as: List of Visits.
 *
 * @typedef {Map<CacheKey, HistoryVisit[]> | Map<CacheKey, Map<CacheKey, HistoryVisit[]>> | HistoryVisit[]} CachedHistory
 */

/**
 * Types returnable from the observer.
 *
 * @typedef {PlacesVisitRemoved | PlacesVisit | PlacesHistoryCleared | PlacesVisitTitle} PlacesEventObserved
 */

/**
 * Queries the places database using an async read only connection. Maintains
 * an internal cache of query results which is live-updated by adding listeners
 * to `PlacesObservers`. When the results are no longer needed, call `close` to
 * remove the listeners.
 */
export class PlacesQuery {
  /** @type {HistoryCache} */
  #cache = null;
  /** @type {object} */
  cachedHistoryOptions = null;
  /** @type {function(PlacesEventObserved[]): any} */
  #historyListener = null;
  /** @type {function(CachedHistory): any} */
  #historyListenerCallback = null;
  /** @type {DeferredTask} */
  #historyObserverTask = null;

  /**
   * Indicates whether this query is closed. When closed, caches should not be
   * populated, and observers should not be instantiated. It can be reopened by
   * calling `initializeCache()`.
   *
   * @type {boolean}
   */
  #isClosed = false;

  #searchInProgress = false;

  get cachedHistory() {
    return this.#cache?.data ?? null;
  }

  /**
   * Get a snapshot of history visits at this moment.
   *
   * @param {object} [options]
   *   Options to apply to the database query.
   * @param {number} [options.daysOld]
   *   The maximum number of days to go back in history.
   * @param {number} [options.limit]
   *   The maximum number of visits to return.
   * @param {Values<typeof SORT_BY>} [options.sortBy]
   *   The sorting order of history visits. See SORT_BY.
   * @returns {Promise<CachedHistory>}
   *   History visits obtained from the database query.
   */
  async getHistory({ daysOld = 60, limit, sortBy = SORT_BY.DATE } = {}) {
    const options = { daysOld, limit, sortBy };
    const cacheInvalid =
      this.cachedHistory == null ||
      !lazy.ObjectUtils.deepEqual(options, this.cachedHistoryOptions);
    if (cacheInvalid) {
      this.initializeCache(options);
      await this.fetchHistory();
    }
    if (!this.#historyListener && !this.#isClosed) {
      this.#initHistoryListener();
    }
    return this.cachedHistory;
  }

  /**
   * Clear existing cache and store options for the new query.
   *
   * @param {object} options
   *   The database query options.
   */
  initializeCache(options = this.cachedHistoryOptions) {
    this.#cache = new HistoryCache(options.sortBy, this);
    this.cachedHistoryOptions = options;
    this.#isClosed = false;
  }

  /**
   * Run the database query and populate the history cache.
   */
  async fetchHistory() {
    const { daysOld, limit, sortBy } = this.cachedHistoryOptions;
    const db = await lazy.PlacesUtils.promiseDBConnection();
    let groupBy;
    switch (sortBy) {
      case SORT_BY.DATE:
      case SORT_BY.DATESITE:
        groupBy = "url, date(visit_date / 1000000, 'unixepoch', 'localtime')";
        break;
      case SORT_BY.SITE:
      case SORT_BY.LAST_VISITED:
        groupBy = "url";
        break;
    }
    const whereClause =
      daysOld == Infinity
        ? ""
        : `WHERE visit_date >= (strftime('%s','now','localtime','start of day','-${Number(
            daysOld
          )} days','utc') * 1000000)`;
    const sql = `SELECT MAX(visit_date) as visit_date, title, url, guid
      FROM moz_historyvisits v
      JOIN moz_places h
      ON v.place_id = h.id
      AND hidden = 0
      ${whereClause}
      GROUP BY ${groupBy}
      ORDER BY visit_date DESC
      LIMIT ${limit > 0 ? limit : -1}`;
    const rows = await db.executeCached(sql);
    if (this.#isClosed) {
      // Do not cache visits if this instance is closed already.
      return;
    }
    for (const row of rows) {
      const visit = this.formatRowAsVisit(row);
      this.#cache.append(visit);
    }
  }

  /**
   * Search the database for visits matching a search query. This does not
   * affect internal caches, and observers will not be notified of search
   * results obtained from this query.
   *
   * @param {string} query
   *   The search query.
   * @param {number} [limit]
   *   The maximum number of visits to return.
   * @returns {Promise<HistoryVisit[]>}
   *   The matching visits.
   */
  async searchHistory(query, limit) {
    const { sortBy } = this.cachedHistoryOptions;
    const db = await lazy.PlacesUtils.promiseLargeCacheDBConnection();
    let orderBy;
    switch (sortBy) {
      case SORT_BY.DATE:
        orderBy = "visit_date DESC";
        break;
      case SORT_BY.SITE:
        orderBy = "url";
        break;
      case SORT_BY.DATESITE:
        orderBy = "visit_date DESC, url";
        break;
      case SORT_BY.LAST_VISITED:
        orderBy = "visit_date DESC";
        break;
    }
    const sql = `SELECT MAX(visit_date) as visit_date, title, url, guid
      FROM moz_historyvisits v
      JOIN moz_places h
      ON v.place_id = h.id
      WHERE AUTOCOMPLETE_MATCH(:query, url, title, NULL, 1, 1, 1, 1, :matchBehavior, :searchBehavior, NULL)
      AND hidden = 0
      GROUP BY url
      ORDER BY ${orderBy}
      LIMIT ${limit > 0 ? limit : -1}`;
    if (this.#searchInProgress) {
      db.interrupt();
    }
    try {
      this.#searchInProgress = true;
      const rows = await db.executeCached(sql, {
        query,
        matchBehavior: Ci.mozIPlacesAutoComplete.MATCH_ANYWHERE_UNMODIFIED,
        searchBehavior: Ci.mozIPlacesAutoComplete.BEHAVIOR_HISTORY,
      });
      return rows.map(row => this.formatRowAsVisit(row));
    } finally {
      this.#searchInProgress = false;
    }
  }

  /**
   * Observe changes to the visits table. When changes are made, the callback
   * is given the new list of visits. Only one callback can be active at a time
   * (per instance). If one already exists, it will be replaced.
   *
   * @param {function(CachedHistory): any} callback
   *   The function to call when changes are made.
   */
  observeHistory(callback) {
    this.#historyListenerCallback = callback;
  }

  /**
   * Close this query. Caches are cleared and listeners are removed.
   */
  close() {
    this.#isClosed = true;
    this.#cache = null;
    this.cachedHistoryOptions = null;
    if (this.#historyListener) {
      PlacesObservers.removeListener(
        [
          "page-removed",
          "page-visited",
          "history-cleared",
          "page-title-changed",
        ],
        this.#historyListener
      );
    }
    this.#historyListener = null;
    this.#historyListenerCallback = null;
    if (this.#historyObserverTask && !this.#historyObserverTask.isFinalized) {
      this.#historyObserverTask.disarm();
      this.#historyObserverTask.finalize();
    }
  }

  /**
   * Listen for changes to the visits table and update caches accordingly.
   */
  #initHistoryListener() {
    this.#historyObserverTask = new lazy.DeferredTask(
      async () => {
        if (typeof this.#historyListenerCallback === "function") {
          const history = await this.getHistory(this.cachedHistoryOptions);
          this.#historyListenerCallback(history);
        }
      },
      OBSERVER_DEBOUNCE_RATE_MS,
      OBSERVER_DEBOUNCE_TIMEOUT_MS
    );
    this.#historyListener = async events => {
      if (
        events.length >= BULK_PLACES_EVENTS_THRESHOLD ||
        events.some(({ type }) => type === "page-removed")
      ) {
        // Accounting for cascading deletes, or handling places events in bulk,
        // can be expensive. In this case, we invalidate the cache once rather
        // than handling each event individually.
        this.#cache = null;
      } else if (this.cachedHistory != null) {
        for (const event of events) {
          switch (event.type) {
            case "page-visited":
              this.handlePageVisited(/** @type {PlacesVisit} */ (event));
              break;
            case "history-cleared":
              this.initializeCache();
              break;
            case "page-title-changed":
              this.handlePageTitleChanged(
                /** @type {PlacesVisitTitle} */ (event)
              );
              break;
          }
        }
      }
      this.#historyObserverTask.arm();
    };
    PlacesObservers.addListener(
      ["page-removed", "page-visited", "history-cleared", "page-title-changed"],
      this.#historyListener
    );
  }

  /**
   * Handle a page visited event.
   *
   * @param {PlacesVisit} event
   *   The event.
   * @returns {HistoryVisit}
   *   The visit that was inserted, or `null` if no visit was inserted.
   */
  handlePageVisited(event) {
    if (event.hidden) {
      return null;
    }
    const visit = this.formatEventAsVisit(event);
    this.#cache.insertSorted(visit);
    return visit;
  }

  /**
   * Handle a page title changed event.
   *
   * @param {PlacesVisitTitle} event
   *   The event.
   */
  handlePageTitleChanged(event) {
    this.#cache.updateTitle(event.url, event.title);
  }

  /**
   * Get timestamp from a date by only considering its year, month, and date
   * (so that it can be used as a date-based key).
   *
   * @param {Date} date
   *   The date to truncate.
   * @returns {number}
   *   The corresponding timestamp.
   */
  getStartOfDayTimestamp(date) {
    return new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate()
    ).getTime();
  }

  /**
   * Get timestamp from a date by only considering its year and month (so that
   * it can be used as a month-based key).
   *
   * @param {Date} date
   *   The date to truncate.
   * @returns {number}
   *   The corresponding timestamp.
   */
  getStartOfMonthTimestamp(date) {
    return new Date(date.getFullYear(), date.getMonth()).getTime();
  }

  /**
   * Format a database row as a history visit.
   *
   * @param {mozIStorageRow} row
   *   The row to format.
   * @returns {HistoryVisit}
   *   The resulting history visit.
   */
  formatRowAsVisit(row) {
    return {
      date: lazy.PlacesUtils.toDate(row.getResultByName("visit_date")),
      // @ts-expect-error - Bug 1966462
      title: row.getResultByName("title"),
      // @ts-expect-error - Bug 1966462
      url: row.getResultByName("url"),
      // @ts-expect-error - Bug 1966462
      guid: row.getResultByName("guid"),
    };
  }

  /**
   * Format a page visited event as a history visit.
   *
   * @param {PlacesVisit} event
   *   The event to format.
   * @returns {HistoryVisit}
   *   The resulting history visit.
   */
  formatEventAsVisit(event) {
    return {
      date: new Date(event.visitTime),
      title: event.lastKnownTitle,
      url: event.url,
      guid: event.pageGuid,
    };
  }
}

const SORT_BY = Object.freeze({
  /**
   * Group visits by calendar date.
   *
   * Cache structure: `Map<string, HistoryVisit[]>`
   * - Key: Timestamp for visit date.
   * - Value: Array of visits that occurred on that day, sorted newest first.
   */
  DATE: "date",

  /**
   * Group visits first by date, then by website.
   *
   * Cache structure: `Map<string, Map<string, HistoryVisit[]>>`
   * - Outer key: Timestamp for visit date.
   * - Inner key: Formatted domain name (e.g. "example.com")
   * - Value: Array of visits to that site on that day, sorted newest first.
   */
  DATESITE: "datesite",

  /**
   * Flat chronological list of all visits, ungrouped.
   *
   * Cache structure: `HistoryVisit[]`
   * - An array of all visits sorted by newest first.
   * - No grouping.
   */
  LAST_VISITED: "lastvisited",

  /**
   * Group visits by website/domain.
   *
   * Cache structure: `Map<domain, HistoryVisit[]>`
   * - Key: Formatted domain name (e.g. "example.com", excludes "www.")
   * - Value: Array of visits to that site, sorted newest first.
   */
  SITE: "site",
});

/**
 * Cache storage and operations for history visits.
 *
 * Maintains two data structures:
 * - A primary cache organized by the sorting strategy.
 * - A secondary URL-indexed cache for fast duplicate detection and title
 *   updates.
 */
class HistoryCache {
  /** @type {CachedHistory} */
  #cache;
  /** @type {Map<string, Set<HistoryVisit>>} */
  #urlCache = new Map();
  /** @type {string} */
  #sortBy;
  /** @type {PlacesQuery} */
  #placesQuery;

  /**
   *
   * @param {string} sortBy
   *   The sorting strategy. See SORT_BY.
   * @param {PlacesQuery} placesQuery
   *   The PlacesQuery instance, required for date key generation.
   */
  constructor(sortBy, placesQuery) {
    this.#sortBy = sortBy;
    this.#placesQuery = placesQuery;
    this.#cache = sortBy === SORT_BY.LAST_VISITED ? [] : new Map();
  }

  /**
   * Required for iteration by consumers.
   *
   * @returns {CachedHistory}
   */
  get data() {
    return this.#cache;
  }

  /**
   * Appends a visit to the end of its container.
   *
   * @param {HistoryVisit} visit
   *   The visit to append.
   */
  append(visit) {
    let container = this.#getContainerForVisit(visit);
    container.push(visit);
    this.#addUrlToCache(visit);
  }

  /**
   * Insert a visit into the correct position maintaining sorted order.
   * Handles duplicate detection and removal of older visits for the same URL.
   *
   * @param {HistoryVisit} visit
   *   The visit to insert.
   * @returns {boolean}
   *   true if the visit was inserted, false if it was rejected as a duplicate.
   */
  insertSorted(visit) {
    let container = this.#getContainerForVisit(visit);
    if (!this.#handleDuplicate(visit, container)) {
      return false;
    }
    this.#insertSortedIntoContainer(visit, container);
    this.#addUrlToCache(visit);
    return true;
  }

  /**
   * Update the title for all cached visits matching the given URL.
   *
   * @param {string} url
   *   The URL to update.
   * @param {string} title
   *   The new title.
   */
  updateTitle(url, title) {
    let visits = this.#urlCache.get(url);
    if (visits) {
      for (let visit of visits) {
        visit.title = title;
      }
    }
  }

  /**
   * Get the container array where a visit should be stored based on the sorting
   * strategy.
   *
   * @param {HistoryVisit} visit
   *   The visit to find a container for.
   * @returns {HistoryVisit[]}
   *   The container array where this visit should be stored.
   * @throws {Error}
   *   If an unknown sortBy option is provided.
   */
  #getContainerForVisit(visit) {
    switch (this.#sortBy) {
      case SORT_BY.LAST_VISITED: {
        return /**@type {HistoryVisit[]} */ (this.#cache);
      }

      case SORT_BY.DATE: {
        let dateKey = this.#placesQuery.getStartOfDayTimestamp(visit.date);
        return this.#getOrCreateContainer(
          /**@type {Map<CacheKey, HistoryVisit[]>} */ (this.#cache),
          dateKey
        );
      }

      case SORT_BY.SITE: {
        let siteKey = this.#getSiteKey(visit.url);
        return this.#getOrCreateContainer(
          /**@type {Map<CacheKey, HistoryVisit[]>} */ (this.#cache),
          siteKey
        );
      }

      case SORT_BY.DATESITE: {
        let dateKey = this.#placesQuery.getStartOfDayTimestamp(visit.date);
        let siteKey = this.#getSiteKey(visit.url);

        let typedCache =
          /**@type {Map<CacheKey, Map<CacheKey, HistoryVisit[]>>} */ (
            this.#cache
          );
        if (!typedCache.has(dateKey)) {
          typedCache.set(dateKey, new Map());
        }

        let dateContainer = typedCache.get(dateKey);
        return this.#getOrCreateContainer(dateContainer, siteKey);
      }

      default:
        throw new Error(`Unknown sortBy option: ${this.#sortBy}`);
    }
  }

  /**
   * Get an existing container from cache or create a new one if it doesn't
   * exist.
   *
   * @param {Map<CacheKey, HistoryVisit[]>} map
   *   The map to search.
   * @param {CacheKey} key
   *   The key to look up or create a container for.
   * @returns {HistoryVisit[]}
   *   The existing or newly created container array.
   */
  #getOrCreateContainer(map, key) {
    let container = map.get(key);
    if (!container) {
      container = [];
      map.set(key, container);
    }
    return container;
  }

  /**
   * Extract a site key from a URL for grouping purposes.
   *
   * @param {string} url
   *  The URL to extract a site key from.
   * @returns {string}
   *   The site key for grouping, or empty string if the URL is invalid or uses
   *   unsupported protocols.
   */
  #getSiteKey(url) {
    let protocol = URL.parse(url)?.protocol;
    // It could be worth caching the site key string to avoid recomputing it
    // multiple times for the same url.
    return protocol == "http:" || protocol == "https:"
      ? lazy.BrowserUtils.formatURIStringForDisplay(url)
      : "";
  }

  /**
   * Add a visit to the URL-indexed cache.
   *
   * @param {HistoryVisit} visit
   *   The visit to add.
   */
  #addUrlToCache(visit) {
    let existing = this.#urlCache.get(visit.url);
    if (existing) {
      existing.add(visit);
    } else {
      this.#urlCache.set(visit.url, new Set([visit]));
    }
  }

  /**
   * Handle duplicate detection and removal. If an older visit for the same
   * URL exists in the container, it is removed. If a newer visit exists,
   * the new visit is rejected.
   *
   * @param {HistoryVisit} visit
   *   The visit to check.
   * @param {HistoryVisit[]} container
   *   The container to check within.
   */
  #handleDuplicate(visit, container) {
    let existingVisitsForUrl = this.#urlCache.get(visit.url);
    if (!existingVisitsForUrl) {
      return true;
    }

    for (let existingVisit of existingVisitsForUrl) {
      if (container.includes(existingVisit)) {
        if (existingVisit.date.getTime() >= visit.date.getTime()) {
          return false;
        }
        container.splice(container.indexOf(existingVisit), 1);
        existingVisitsForUrl.delete(existingVisit);
        break;
      }
    }

    return true;
  }

  /**
   * Insert a visit into a container while maintaining descending chronological
   * order.
   *
   * @param {HistoryVisit} visit
   *   The visit to insert.
   * @param {HistoryVisit[]} container
   *   The container to insert into.
   */
  #insertSortedIntoContainer(visit, container) {
    let insertionPoint = 0;
    if (visit.date.getTime() < container[0]?.date.getTime()) {
      insertionPoint = lazy.BinarySearch.insertionIndexOf(
        (a, b) => b.date.getTime() - a.date.getTime(),
        container,
        visit
      );
    }
    container.splice(insertionPoint, 0, visit);
  }
}
