/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  IndexedDB: "resource://gre/modules/IndexedDB.sys.mjs",
  DAPSender: "resource://gre/modules/DAPSender.sys.mjs",
  ObliviousHTTP: "resource://gre/modules/ObliviousHTTP.sys.mjs",
  HPKEConfigManager: "resource://gre/modules/HPKEConfigManager.sys.mjs",
  AboutNewTab: "resource:///modules/AboutNewTab.sys.mjs",
});

const MAX_CONVERSIONS = 2;
const MAX_LOOKBACK_DAYS = 30;
const DAY_IN_MILLI = 1000 * 60 * 60 * 24;
const CONVERSION_RESET_MILLI = 7 * DAY_IN_MILLI;

const DAP_HPKE_PREF = "dap.ohttp.hpke";
const DAP_RELAY_PREF = "dap.ohttp.relayURL";
const MARS_ENDPOINT_PREF =
  "browser.newtabpage.activity-stream.unifiedAds.endpoint";
const PREF_MARS_OHTTP_CONFIG =
  "browser.newtabpage.activity-stream.discoverystream.ohttp.configURL";
const PREF_MARS_OHTTP_RELAY =
  "browser.newtabpage.activity-stream.discoverystream.ohttp.relayURL";

/**
 *
 */
class NewTabAttributionService {
  /**
   * @typedef { 'view' | 'click' | 'default' } matchType - Available matching methodologies for conversion events.
   *
   * @typedef { 'view' | 'click' } eventType - A subset of matchType values that Newtab will register events.
   *
   * @typedef {object} task - DAP task settings.
   * @property {string} id - task id.
   * @property {string} vdaf - vdaf type.
   * @property {number} length - number of buckets.
   * @property {number} time_precision - time precision.
   *
   * @typedef {object} allocatedTask
   * @property {task} task - DAP task settings.
   * @property {number} defaultMeasurement - Measurement value used if budget is exceeded.
   * @property {number} index - Measurement value used if budget is not exceeded.
   *
   * @typedef {object} impression - stored event.
   * @property {allocatedTask} conversion - DAP task settings for conversion attribution.
   * @property {number} lastImpression - Timestamp in milliseconds for last touch matching.
   * @property {number} lastView - Timestamp in milliseconds for last view matching.
   * @property {number} lastClick - Timestamp in milliseconds for last click matching.
   *
   * @typedef {object} budget - stored budget.
   * @property {number} conversions - Number of conversions that have occurred in the budget period.
   * @property {number} nextReset - Timestamp in milliseconds for the end of the period this budget applies to.
   */
  #dapSenderInternal;
  #dateProvider;
  // eslint-disable-next-line no-unused-private-class-members
  #testDapOptions;

  constructor({ dapSender, dateProvider, testDapOptions } = {}) {
    this.#dapSenderInternal = dapSender;
    this.#dateProvider = dateProvider ?? Date;
    this.#testDapOptions = testDapOptions;

    this.dbName = "NewTabAttribution";
    this.impressionStoreName = "impressions";
    this.budgetStoreName = "budgets";
    this.storeNames = [this.impressionStoreName, this.budgetStoreName];
    this.dbVersion = 1;
    this.models = {
      default: "lastImpression",
      view: "lastView",
      click: "lastClick",
    };
  }

  get #dapSender() {
    return this.#dapSenderInternal || lazy.DAPSender;
  }

  #now() {
    return this.#dateProvider.now();
  }

  #getTrainhopConfig() {
    return (
      lazy.AboutNewTab.activityStream?.store.getState().Prefs.values
        .trainhopConfig ?? {}
    );
  }

  /**
   * onAttributionEvent stores an event locally for an attributable interaction on Newtab.
   *
   * @param {eventType} type - The type of event.
   * @param {*} params - Attribution task details & partner, to enable attribution matching
   *  with this event and submission to DAP.
   */
  async onAttributionEvent(type, params) {
    try {
      const now = this.#now();

      if (
        !params ||
        !params.partner_id ||
        params.index === undefined ||
        params.index === null
      ) {
        return;
      }

      const impression = await this.#getImpression(params.partner_id, {
        conversion: {
          index: params.index,
        },
      });

      const prop = this.#getModelProp(type);
      impression.lastImpression = now;
      impression[prop] = now;

      await this.#updateImpression(params.partner_id, impression);
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * Resets all partner budgets and clears stored impressions,
   * preparing for a new attribution conversion cycle.
   */
  async onAttributionReset() {
    try {
      const now = this.#now();

      // Clear impressions so future conversions won't match outdated impressions
      const impressionStore = await this.#getImpressionStore();
      await impressionStore.clear();

      // Reset budgets
      const budgetStore = await this.#getBudgetStore();
      const partnerIds = await budgetStore.getAllKeys();

      for (const partnerId of partnerIds) {
        const budget = await budgetStore.get(partnerId);
        // Currently clobbers the budget, but will work if any future data is added to DB
        const updatedBudget = {
          ...budget,
          conversions: 0,
          nextReset: now + CONVERSION_RESET_MILLI,
        };

        await budgetStore.put(updatedBudget, partnerId);
      }
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * onAttributionConversion checks for eligible Newtab events and submits
   * a DAP report.
   *
   * @param {string} partnerId - The partner that the conversion occurred for. Compared against
   *  local events to see if any of them are eligible.
   * @param {number} lookbackDays - The number of days prior to now that an event can be for it
   *  to be eligible.
   * @param {matchType} impressionType - How the matching of events is determined.
   *  'view': attributes the most recent eligible view event.
   *  'click': attributes the most recent eligible click event.
   *  'default': attributes the most recent eligible event of any type.
   */
  async onAttributionConversion(partnerId, lookbackDays, impressionType) {
    try {
      const trainhopConfig = this.#getTrainhopConfig();
      const attributionConfig = trainhopConfig.attribution || {};

      const maxLookbackDays =
        attributionConfig.maxLookbackDays ?? MAX_LOOKBACK_DAYS;
      const maxConversions =
        attributionConfig.maxConversions ?? MAX_CONVERSIONS;

      if (lookbackDays > maxLookbackDays) {
        return;
      }
      // we don't want to request the gateway key at time of conversion to avoid an IP address leak
      const dapHpke = Services.prefs.getCharPref(
        DAP_HPKE_PREF,
        "gAAgJSO22Y3HKzRSese15JtQVuuFfOIcTrZ56lQ5kDQwS0oABAABAAE"
      );
      const ohttpRelayURL = Services.prefs.getCharPref(
        DAP_RELAY_PREF,
        "https://mozilla-ohttp-dap.mozilla.fastly-edge.com/"
      );
      const now = this.#now();

      const budget = await this.#getBudget(partnerId, now);
      const impression = await this.#findImpression(
        partnerId,
        lookbackDays,
        impressionType,
        now
      );

      const receivedTaskConfig = await this.#getTaskConfig(partnerId);

      if (!receivedTaskConfig) {
        return;
      }

      // Need to rename task_id to id for DAP report submission.
      const taskConfig = {
        ...receivedTaskConfig,
        id: receivedTaskConfig.task_id,
      };

      let measurement = receivedTaskConfig.default_measurement;
      let budgetSpend = 0;
      if (budget.conversions < maxConversions && impression) {
        budgetSpend = 1;
        const conversionIndex = impression.conversion.index;
        if (
          receivedTaskConfig.length > conversionIndex &&
          conversionIndex !== undefined
        ) {
          measurement = conversionIndex;
        }
      }

      await this.#updateBudget(budget, budgetSpend, partnerId);

      const options = {};
      if (dapHpke) {
        options.ohttp_hpke = lazy.HPKEConfigManager.decodeKey(dapHpke);
      }

      if (ohttpRelayURL) {
        options.ohttp_relay = ohttpRelayURL;
      }

      await this.#dapSender.sendDAPMeasurement(
        taskConfig,
        measurement,
        options
      );
    } catch (e) {
      console.error(e);
    }
  }

  /**
   * findImpression queries the local events to find an attributable event.
   *
   * @param {string} partnerId - Partner the event must be associated with.
   * @param {number} lookbackDays - Maximum number of days ago that the event occurred for it to
   *  be eligible.
   * @param {matchType} impressionType - How the matching of events is determined. Determines what
   *  timestamp property to compare against.
   * @param {number} now - Timestamp in milliseconds when the conversion event was triggered
   * @returns {Promise<impression|undefined>} - The impression that most recently occurred matching the
   *  search criteria.
   */
  async #findImpression(partnerId, lookbackDays, impressionType, now) {
    // Get impressions for the partner
    const impressionStore = await this.#getImpressionStore();
    const impressions = await this.#getPartnerImpressions(
      impressionStore,
      partnerId
    );

    // Determine what timestamp to compare against for the matching methodology
    const prop = this.#getModelProp(impressionType);

    // Find the most relevant impression
    const lookbackWindow = now - lookbackDays * DAY_IN_MILLI;
    return (
      impressions
        // Filter by lookback days
        .filter(impression => impression[prop] >= lookbackWindow)
        // Get the impression with the most recent interaction
        .reduce(
          (cur, impression) =>
            !cur || impression[prop] > cur[prop] ? impression : cur,
          null
        )
    );
  }

  /**
   * getImpression searches existing events for the partner and retuns the event
   * if it is found, defaulting to the passed in impression if there are none. This
   * enables timestamp fields of the stored event to be updated or carried forward.
   *
   * @param {string} partnerId - partner this event is associated with.
   * @param {impression} defaultImpression - event to use if it has not been seen previously.
   * @returns {Promise<impression>}
   */
  async #getImpression(partnerId, defaultImpression) {
    const impressionStore = await this.#getImpressionStore();
    const impressions = await this.#getPartnerImpressions(
      impressionStore,
      partnerId
    );
    const impression = impressions.find(r =>
      this.#compareImpression(r, defaultImpression)
    );

    return impression ?? defaultImpression;
  }

  async #getTaskConfig(partnerId) {
    const baseUrl = Services.prefs.getCharPref(MARS_ENDPOINT_PREF, "");
    const endpoint = `${baseUrl}/v1/attribution?partner_id=${encodeURIComponent(
      partnerId
    )}`;
    const ohttpConfigURL = Services.prefs.getCharPref(
      PREF_MARS_OHTTP_CONFIG,
      ""
    );
    const ohttpRelayURL = Services.prefs.getCharPref(PREF_MARS_OHTTP_RELAY, "");

    if (!partnerId || !endpoint || !ohttpRelayURL || !ohttpConfigURL) {
      return null;
    }
    const controller = new AbortController();
    const { signal } = controller;
    let config = await lazy.ObliviousHTTP.getOHTTPConfig(ohttpConfigURL);
    if (!config) {
      console.error(
        new Error(
          `OHTTP was configured for ${endpoint} but we couldn't fetch a valid config`
        )
      );
      return null;
    }
    try {
      const response = await lazy.ObliviousHTTP.ohttpRequest(
        ohttpRelayURL,
        config,
        endpoint,
        {
          headers: {},
          signal,
        }
      );
      return response.json();
    } catch (error) {
      console.error(
        `Failed to make OHTTP request for unattributed task: ${error.message}`,
        error
      );
      return null;
    }
  }

  /**
   * updateImpression stores the passed event, either updating the record
   * if this event was already seen, or appending to the list of events if it is new.
   *
   * @param {string} partnerId - partner this event is associated with.
   * @param {impression} impression - event to update.
   */
  async #updateImpression(partnerId, impression) {
    const impressionStore = await this.#getImpressionStore();
    let impressions = await this.#getPartnerImpressions(
      impressionStore,
      partnerId
    );

    const i = impressions.findIndex(r =>
      this.#compareImpression(r, impression)
    );
    if (i < 0) {
      impressions.push(impression);
    } else {
      impressions[i] = impression;
    }

    await impressionStore.put(impressions, partnerId);
  }

  /**
   * @param {impression} cur
   * @param {impression} impression
   * @returns {boolean} true if cur and impression have the same index
   */
  #compareImpression(cur, impression) {
    return cur.conversion.index === impression.conversion.index;
  }

  /**
   * getBudget returns the current budget available for the partner.
   *
   * @param {string} partnerId - partner to look up budget for.
   * @param {number} now - Timestamp in milliseconds.
   * @returns {Promise<budget>} the current budget for the partner.
   */
  async #getBudget(partnerId, now) {
    const budgetStore = await this.#getBudgetStore();
    const budget = await budgetStore.get(partnerId);

    if (!budget || now > budget.nextReset) {
      return {
        conversions: 0,
        nextReset: now + CONVERSION_RESET_MILLI,
      };
    }

    return budget;
  }

  /**
   * updateBudget updates the stored budget to indicate some has been used.
   *
   * @param {budget} budget - current budget to be modified.
   * @param {number} value - amount of budget that has been used.
   * @param {string} partnerId - partner this budget is for.
   */
  async #updateBudget(budget, value, partnerId) {
    const budgetStore = await this.#getBudgetStore();
    budget.conversions += value;
    await budgetStore.put(budget, partnerId);
  }

  /**
   * @param {ObjectStore} impressionStore - Promise-based wrapped IDBObjectStore.
   * @param {string} partnerId - partner to look up impressions for.
   * @returns {Promise<Array<impression>>} impressions associated with the partner.
   */
  async #getPartnerImpressions(impressionStore, partnerId) {
    const impressions = (await impressionStore.get(partnerId)) ?? [];
    return impressions;
  }

  async #getImpressionStore() {
    return await this.#getStore(this.impressionStoreName);
  }

  async #getBudgetStore() {
    return await this.#getStore(this.budgetStoreName);
  }

  async #getStore(storeName) {
    return (await this.#db).objectStore(storeName, "readwrite");
  }

  get #db() {
    return this._db || (this._db = this.#createOrOpenDb());
  }

  async #createOrOpenDb() {
    try {
      return await this.#openDatabase();
    } catch {
      await lazy.IndexedDB.deleteDatabase(this.dbName);
      return this.#openDatabase();
    }
  }

  async #openDatabase() {
    return await lazy.IndexedDB.open(this.dbName, this.dbVersion, db => {
      this.storeNames.forEach(store => {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store);
        }
      });
    });
  }

  /**
   * getModelProp returns the property name associated with a given matching
   * methodology.
   *
   * @param {matchType} type
   * @returns {string} The name of the timestamp property to check against.
   */
  #getModelProp(type) {
    return this.models[type] ?? this.models.default;
  }
}

const newTabAttributionService = new NewTabAttributionService();

export {
  newTabAttributionService,
  NewTabAttributionService as NewTabAttributionServiceClass,
};
