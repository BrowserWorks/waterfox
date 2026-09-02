/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  DeferredTask: "resource://gre/modules/DeferredTask.sys.mjs",
  PersistentCache: "resource://newtab/lib/PersistentCache.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "MAX_SUBMISSION_DELAY_PREF_VALUE",
  "browser.newtabpage.activity-stream.telemetry.privatePing.maxSubmissionDelayMs",
  5000
);

const EVENT_STATS_KEY = "event_stats";
const CACHE_KEY = "newtab_content_event_stats";

const CLICK_EVENT_ID = "click";

const EVENT_STATS_DAILY_PERIOD_MS = 60 * 60 * 24 * 1000;
const EVENT_STATS_WEEKLY_PERIOD_MS = 7 * 60 * 60 * 24 * 1000;

const MAX_UINT32 = 0xffffffff;

export class NewTabContentPing {
  #eventBuffer = [];
  #deferredTask = null;
  #lastDelaySelection = 0;
  #maxDailyEvents = 0;
  #maxDailyClickEvents = 0;
  #maxWeeklyClickEvents = 0;
  #curInstanceEventsSent = 0; // Used for tests

  constructor() {
    this.#maxDailyEvents = 0;
    this.#maxDailyClickEvents = 0;
    this.#maxWeeklyClickEvents = 0;
    this.cache = this.PersistentCache(CACHE_KEY, true);
  }

  /**
   * Set the maximum number of events to send in a 24 hour period
   *
   * @param {int} maxEvents
   */
  setMaxEventsPerDay(maxEvents) {
    this.#maxDailyEvents = maxEvents || 0;
  }

  /**
   * Set the maximum number of events to send in a 24 hour period
   *
   * @param {int} maxEvents
   */
  setMaxClickEventsPerDay(maxEvents) {
    this.#maxDailyClickEvents = maxEvents || 0;
  }

  /**
   * Set the maximum number of events to send in a 24 hour period
   *
   * @param {int} maxEvents
   */
  setMaxClickEventsPerWeek(maxEvents) {
    this.#maxWeeklyClickEvents = maxEvents || 0;
  }

  /**
   * Adds a event recording for Glean.newtabContent to the internal buffer.
   * The event will be recorded when the ping is sent.
   *
   * @param {string} name
   *   The name of the event to record.
   * @param {object} data
   *   The extra data being recorded with the event.
   */
  recordEvent(name, data) {
    this.#eventBuffer.push([name, this.sanitizeEventData(data)]);
  }

  /**
   * Schedules the sending of the newtab-content ping at some randomly selected
   * point in the future.
   *
   * @param {object} privateMetrics
   *   The metrics to send along with the ping when it is sent, keyed on the
   *   name of the metric.
   */
  scheduleSubmission(privateMetrics) {
    for (let metric of Object.keys(privateMetrics)) {
      try {
        Glean.newtabContent[metric].set(privateMetrics[metric]);
      } catch (e) {
        console.error(e);
      }
    }

    if (!this.#deferredTask) {
      this.#lastDelaySelection = this.#generateRandomSubmissionDelayMs();
      this.#deferredTask = new lazy.DeferredTask(async () => {
        await this.#flushEventsAndSubmit();
      }, this.#lastDelaySelection);
      this.#deferredTask.arm();
    }
  }

  /**
   * Disarms any pre-existing scheduled newtab-content pings and clears the
   * event buffer.
   */
  uninit() {
    this.#deferredTask?.disarm();
    this.#eventBuffer = [];
  }

  /**
   * Resets the impression stats object of the Newtab_content ping and returns it.
   */
  async resetDailyStats(eventStats = {}) {
    const stats = {
      ...eventStats,
      dailyCount: 0,
      lastUpdatedDaily: this.Date().now(),
      dailyClickCount: 0,
    };
    await this.cache.set(EVENT_STATS_KEY, stats);
    return stats;
  }

  async resetWeeklyStats(eventStats = {}) {
    const stats = {
      ...eventStats,
      lastUpdatedWeekly: this.Date().now(),
      weeklyClickCount: 0,
    };
    await this.cache.set(EVENT_STATS_KEY, stats);
    return stats;
  }

  /**
   * Resets all stats for testing purposes.
   */
  async test_only_resetAllStats() {
    let eventStats = await this.resetDailyStats();
    await this.resetWeeklyStats(eventStats);
  }

  /**
   * Randomly shuffles the elements of an array in place using the Fisher–Yates algorithm.
   *
   * @param {Array} array - The array to shuffle. This array will be modified.
   * @returns {Array} The same array instance, shuffled randomly.
   */
  static shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = array[i];
      array[i] = array[j];
      array[j] = temp;
    }
    return array;
  }
  /**
   * Called by the DeferredTask when the randomly selected delay has elapsed
   * after calling scheduleSubmission.
   */
  async #flushEventsAndSubmit() {
    const isOrganicClickEvent = (event, data) => {
      return event === CLICK_EVENT_ID && !data.is_sponsored;
    };

    this.#deferredTask = null;

    // See if we have no event stats or the stats period has cycled
    let eventStats = await this.cache.get(EVENT_STATS_KEY, {});

    if (
      !eventStats?.lastUpdatedDaily ||
      !(
        this.Date().now() - eventStats.lastUpdatedDaily <
        EVENT_STATS_DAILY_PERIOD_MS
      )
    ) {
      eventStats = await this.resetDailyStats(eventStats);
    }

    if (
      !eventStats?.lastUpdatedWeekly ||
      !(
        this.Date().now() - eventStats.lastUpdatedWeekly <
        EVENT_STATS_WEEKLY_PERIOD_MS
      )
    ) {
      eventStats = await this.resetWeeklyStats(eventStats);
    }

    let events = this.#eventBuffer;
    this.#eventBuffer = [];
    if (this.#maxDailyEvents > 0) {
      if (eventStats?.dailyCount >= this.#maxDailyEvents) {
        // Drop all events. Don't send
        return;
      }
    }
    let clickEvents = events.filter(([eventName, data]) =>
      isOrganicClickEvent(eventName, data)
    );
    let numOriginalClickEvents = clickEvents.length;
    // Check if we need to cap organic click events
    if (
      numOriginalClickEvents > 0 &&
      (this.#maxDailyClickEvents > 0 || this.#maxWeeklyClickEvents > 0)
    ) {
      if (this.#maxDailyClickEvents > 0) {
        clickEvents = clickEvents.slice(
          0,
          Math.max(0, this.#maxDailyClickEvents - eventStats?.dailyClickCount)
        );
      }
      if (this.#maxWeeklyClickEvents > 0) {
        clickEvents = clickEvents.slice(
          0,
          Math.max(0, this.#maxWeeklyClickEvents - eventStats?.weeklyClickCount)
        );
      }
      events = events
        .filter(([eventName, data]) => !isOrganicClickEvent(eventName, data))
        .concat(clickEvents);
    }

    eventStats.dailyCount += events.length;
    eventStats.weeklyClickCount += clickEvents.length;
    eventStats.dailyClickCount += clickEvents.length;

    await this.cache.set(EVENT_STATS_KEY, eventStats);

    for (let [eventName, data] of NewTabContentPing.shuffleArray(events)) {
      try {
        Glean.newtabContent[eventName].record(data);
      } catch (e) {
        console.error(e);
      }
    }
    GleanPings.newtabContent.submit();
    this.#curInstanceEventsSent += events.length;
  }

  /**
   * Returns number of events sent through Glean in this instance of the class.
   */
  get testOnlyCurInstanceEventCount() {
    return this.#curInstanceEventsSent;
  }

  /**
   * Removes fields from an event that can be linked to a user in any way, in
   * order to preserve anonymity of the newtab_content ping. This is just to
   * ensure we don't accidentally send these if copying information between
   * the newtab ping and the newtab-content ping.
   *
   * @param {object} eventDataDict
   *   The Glean event data that would be passed to a `record` method.
   * @returns {object}
   *   The sanitized event data.
   */
  sanitizeEventData(eventDataDict) {
    const {
      // eslint-disable-next-line no-unused-vars
      tile_id,
      // eslint-disable-next-line no-unused-vars
      newtab_visit_id,
      // eslint-disable-next-line no-unused-vars
      matches_selected_topic,
      // eslint-disable-next-line no-unused-vars
      recommended_at,
      // eslint-disable-next-line no-unused-vars
      received_rank,
      // eslint-disable-next-line no-unused-vars
      event_source,
      // eslint-disable-next-line no-unused-vars
      recommendation_id,
      // eslint-disable-next-line no-unused-vars
      layout_name,
      ...result
    } = eventDataDict;
    return result;
  }

  /**
   * Generate a random delay to submit the ping from the point of
   * scheduling. This uses a cryptographically secure mechanism for
   * generating the random delay and returns it in milliseconds.
   *
   * @returns {number}
   *   A random number between 1000 and the max new content ping submission
   *   delay pref.
   */
  #generateRandomSubmissionDelayMs() {
    const MIN_SUBMISSION_DELAY = 1000;

    if (lazy.MAX_SUBMISSION_DELAY_PREF_VALUE <= MIN_SUBMISSION_DELAY) {
      // Somehow we got configured with a maximum delay less than the minimum...
      // Let's fallback to 5000 then.
      console.error(
        "Can not have a newtab-content maximum submission delay less" +
          ` than 1000: ${lazy.MAX_SUBMISSION_DELAY_PREF_VALUE}`
      );
    }
    const MAX_SUBMISSION_DELAY =
      lazy.MAX_SUBMISSION_DELAY_PREF_VALUE > MIN_SUBMISSION_DELAY
        ? lazy.MAX_SUBMISSION_DELAY_PREF_VALUE
        : 5000;

    const RANGE = MAX_SUBMISSION_DELAY - MIN_SUBMISSION_DELAY + 1;
    const selection = NewTabContentPing.secureRandIntInRange(RANGE);
    return MIN_SUBMISSION_DELAY + (selection % RANGE);
  }

  /**
   * Returns a secure random number between 0 and range
   *
   * @param {int} range Integer value range
   * @returns {int} Random value between 0 and range non-inclusive
   */
  static secureRandIntInRange(range) {
    // To ensure a uniform distribution, we discard values that could introduce
    // modulo bias. We divide the 2^32 range into equal-sized "buckets" and only
    // accept random values that fall entirely within one of these buckets.
    // This ensures each possible output in the target range is equally likely.

    const BUCKET_SIZE = Math.floor(MAX_UINT32 / range);
    const MAX_ACCEPTABLE = BUCKET_SIZE * range;

    let selection;
    let randomValues = new Uint32Array(1);
    do {
      crypto.getRandomValues(randomValues);
      [selection] = randomValues;
    } while (selection >= MAX_ACCEPTABLE);
    return selection % range;
  }

  /**
   * Returns true or false with a certain proability specified
   *
   * @param {number} prob Probability
   * @returns {boolean} Random boolean result of probability prob. A higher prob
   *   increases the chance of true being returned.
   */
  static decideWithProbability(prob) {
    if (prob <= 0) {
      return false;
    }
    if (prob >= 1) {
      return true;
    }
    const randomValues = new Uint32Array(1);
    crypto.getRandomValues(randomValues);
    const random = randomValues[0] / MAX_UINT32;
    return random < prob;
  }

  /**
   * This is a test-only function that will disarm the DeferredTask from sending
   * the newtab-content ping, and instead send it manually. The originally
   * selected submission delay is returned.
   *
   * This function is a no-op when not running in test automation.
   *
   * @returns {number}
   *   The originally selected random delay for submitting the newtab-content
   *   ping.
   * @throws {Error}
   *   Function throws an exception if this is called when no submission has been scheduled yet.
   */
  async testOnlyForceFlush() {
    if (!Cu.isInAutomation) {
      return 0;
    }

    if (this.#deferredTask) {
      this.#deferredTask.disarm();
      this.#deferredTask = null;
      await this.#flushEventsAndSubmit();
      return this.#lastDelaySelection;
    }
    throw new Error("No submission was scheduled.");
  }
}

/**
 * Creating a thin wrapper around PersistentCache, and Date.
 * This makes it easier for us to write automated tests
 */
NewTabContentPing.prototype.PersistentCache = (...args) => {
  return new lazy.PersistentCache(...args);
};

NewTabContentPing.prototype.Date = () => {
  return Date;
};
