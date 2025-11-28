/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * @typedef {import("../uniffi-bindgen-gecko-js/components/generated/RustSearch.sys.mjs").SearchEngineSelector} RustSearchEngineSelector
 * We use "Rust" above to avoid conflict with the class name for the JavaScript wrapper.
 * @typedef {import("../uniffi-bindgen-gecko-js/components/generated/RustSearch.sys.mjs").SearchApplicationName} SearchApplicationName
 * @typedef {import("../uniffi-bindgen-gecko-js/components/generated/RustSearch.sys.mjs").SearchUpdateChannel} SearchUpdateChannel
 */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  RemoteSettings: "resource://services-settings/remote-settings.sys.mjs",
  SearchDeviceType:
    "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustSearch.sys.mjs",
  SearchEngineSelector:
    "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustSearch.sys.mjs",
  SearchUserEnvironment:
    "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustSearch.sys.mjs",
  SearchApplicationName:
    "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustSearch.sys.mjs",
  SearchUpdateChannel:
    "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustSearch.sys.mjs",
  SearchUtils: "moz-src:///toolkit/components/search/SearchUtils.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "logConsole", () => {
  return console.createInstance({
    prefix: "SearchEngineSelector",
    maxLogLevel: lazy.SearchUtils.loggingEnabled ? "Debug" : "Warn",
  });
});

/**
 * @typedef {object} RefinedConfig
 * @property {object[]} engines
 *   An array of objects defining the engines that should be presented to the user.
 * @property {string} appDefaultEngineId
 *   The identifier of the engine that should be used for the application
 *   default engine.
 * @property {string} [appPrivateDefaultEngineId]
 *   If specified, the identifier of the engine that should be used for the
 *   application default engine in private browsing mode.
 */

/**
 * SearchEngineSelector parses the JSON configuration for
 * search engines and returns the applicable engines depending
 * on their region + locale.
 */
export class SearchEngineSelector {
  /**
   * @param {Function} listener
   *   A listener for configuration update changes.
   */
  constructor(listener) {
    this._remoteConfig = lazy.RemoteSettings(lazy.SearchUtils.SETTINGS_KEY);
    this._remoteConfigOverrides = lazy.RemoteSettings(
      lazy.SearchUtils.SETTINGS_OVERRIDES_KEY
    );
    this._listenerAdded = false;
    this._onConfigurationUpdated = this._onConfigurationUpdated.bind(this);
    this._onConfigurationOverridesUpdated =
      this._onConfigurationOverridesUpdated.bind(this);
    this._changeListener = listener;
  }

  /**
   * Resets the remote settings listeners.
   */
  reset() {
    if (this._listenerAdded) {
      this._remoteConfig.off("sync", this._onConfigurationUpdated);
      this._remoteConfigOverrides.off(
        "sync",
        this._onConfigurationOverridesUpdated
      );
      this._listenerAdded = false;
    }
  }

  /**
   * Handles getting the configuration from remote settings.
   *
   * @returns {Promise<object>}
   *   The configuration data.
   */
  async getEngineConfiguration() {
    if (this._getConfigurationPromise) {
      return this._getConfigurationPromise;
    }

    this._getConfigurationPromise = Promise.all([
      this._getConfiguration(),
      this._getConfigurationOverrides(),
    ]);
    let remoteSettingsData = await this._getConfigurationPromise;
    this._configuration = remoteSettingsData[0];
    this._configurationOverrides = remoteSettingsData[1];
    delete this._getConfigurationPromise;

    if (!this._configuration?.length) {
      throw Components.Exception(
        "Failed to get engine data from Remote Settings",
        Cr.NS_ERROR_UNEXPECTED
      );
    }

    if (!this._listenerAdded) {
      this._remoteConfig.on("sync", this._onConfigurationUpdated);
      this._remoteConfigOverrides.on(
        "sync",
        this._onConfigurationOverridesUpdated
      );
      this._listenerAdded = true;
    }

    if (lazy.SearchUtils.rustSelectorFeatureGate) {
      this.#selector.setSearchConfig(
        JSON.stringify({ data: this._configuration })
      );
      this.#selector.setConfigOverrides(
        JSON.stringify({ data: this._configurationOverrides })
      );
    }

    return this._configuration;
  }

  /**
   * Obtains the list of built-in search engines from the static JSON file.
   *
   * @returns {Promise<object[]>}
   *   An array of engine configuration objects.
   */
  async _getStaticEngines() {
    if (!this._staticEngines) {
      this._staticEngines = await (
        await fetch(
          "chrome://browser/content/search/BrowserSearchEngines.json"
        )
      ).json();
    }
    return this._staticEngines;
  }

  /**
   * Finds an engine configuration that has a matching host.
   *
   * @param {string} host
   *   The host to match.
   *
   * @returns {Promise<object>}
   *   The configuration data for an engine.
   */
  async findContextualSearchEngineByHost(host) {
    let engines = await this._getStaticEngines();

    for (let config of engines) {
      if (config.recordType !== "engine") {
        continue;
      }

      let searchBase = config.urls?.search?.base;
      if (!searchBase) {
        continue;
      }

      let searchHost = new URL(searchBase).hostname;

      if (searchHost.startsWith("www.")) {
        searchHost = searchHost.slice(4);
      }
      if (searchHost.startsWith(host)) {
        let engine = structuredClone(config);
        if (!engine.identifier && config.identifier) {
          engine.identifier = config.identifier;
        }
        return engine;
      }
    }
    return null;
  }

  /**
   * Finds an engine configuration that has a matching identifier.
   *
   * @param {string} id
   *   The identifier to match.
   *
   * @returns {Promise<object>}
   *   The configuration data for an engine.
   */
  async findContextualSearchEngineById(id) {
    let engines = await this._getStaticEngines();

    for (let config of engines) {
      if (config.recordType !== "engine") {
        continue;
      }
      if (config.identifier == id) {
        let engine = structuredClone(config);
        if (!engine.identifier && config.identifier) {
          engine.identifier = config.identifier;
        }
        return engine;
      }
    }
    return null;
  }

  /**
   * Used by tests to get the configuration overrides.
   *
   * @returns {Promise<object>}
   *   The engine overrides data.
   */
  async getEngineConfigurationOverrides() {
    await this.getEngineConfiguration();
    return this._configurationOverrides;
  }

  /**
   * Obtains the configuration from remote settings. This includes
   * verifying the signature of the record within the database.
   *
   * If the signature in the database is invalid, the database will be wiped
   * and the stored dump will be used, until the settings next update.
   *
   * Note that this may cause a network check of the certificate, but that
   * should generally be quick.
   *
   * @param {boolean} [firstTime]
   *   Internal boolean to indicate if this is the first time check or not.
   * @returns {Promise<object[]>}
   *   An array of objects in the database, or an empty array if none
   *   could be obtained.
   */
  async _getConfiguration(firstTime = true) {
    let result = [];
    let failed = false;
    try {
      result = await this._remoteConfig.get({
        order: "id",
      });
    } catch (ex) {
      lazy.logConsole.error(ex);
      failed = true;
    }
    if (!result.length) {
      lazy.logConsole.error("Received empty search configuration!");
      failed = true;
    }
    // If we failed, or the result is empty, try loading from the local dump.
    if (firstTime && failed) {
      await this._remoteConfig.db.clear();
      // Now call this again.
      return this._getConfiguration(false);
    }
    return result;
  }

  /**
   * Handles updating of the configuration. Note that the search service is
   * only updated after a period where the user is observed to be idle.
   *
   * @param {object} options
   *   The options object
   * @param {object} options.data
   *   The data to update
   * @param {Array} options.data.current
   *   The new configuration object
   */
  _onConfigurationUpdated({ data: { current } }) {
    this._configuration = current;

    if (lazy.SearchUtils.rustSelectorFeatureGate) {
      this.#selector.setSearchConfig(
        JSON.stringify({ data: this._configuration })
      );
    }

    lazy.logConsole.debug("Search configuration updated remotely");
    if (this._changeListener) {
      this._changeListener();
    }
  }

  /**
   * Handles updating of the configuration. Note that the search service is
   * only updated after a period where the user is observed to be idle.
   *
   * @param {object} options
   *   The options object
   * @param {object} options.data
   *   The data to update
   * @param {Array} options.data.current
   *   The new configuration object
   */
  _onConfigurationOverridesUpdated({ data: { current } }) {
    this._configurationOverrides = current;

    if (lazy.SearchUtils.rustSelectorFeatureGate) {
      this.#selector.setConfigOverrides(
        JSON.stringify({ data: this._configurationOverrides })
      );
    }

    lazy.logConsole.debug("Search configuration overrides updated remotely");
    if (this._changeListener) {
      this._changeListener();
    }
  }

  /**
   * Obtains the configuration overrides from remote settings.
   *
   * @returns {Promise<object[]>}
   *   An array of objects in the database, or an empty array if none
   *   could be obtained.
   */
  async _getConfigurationOverrides() {
    let result = [];
    try {
      result = await this._remoteConfigOverrides.get();
    } catch (ex) {
      // This data is remote only, so we just return an empty array if it fails.
    }
    return result;
  }

  /**
   * @param {object} options
   *   The options object
   * @param {string} options.locale
   *   Users locale.
   * @param {string} options.region
   *   Users region.
   * @param {string} [options.channel]
   *   The update channel the application is running on.
   * @param {string} [options.distroID]
   *   The distribution ID of the application.
   * @param {string} [options.experiment]
   *   Any associated experiment id.
   * @param {string} [options.appName]
   *   The name of the application.
   * @param {string} [options.version]
   *   The version of the application.
   * @returns {Promise<RefinedConfig>}
   *   An object which contains the refined configuration with a filtered list
   *   of search engines, and the identifiers for the application default engines.
   */
  async fetchEngineConfiguration({
    locale,
    region,
    channel = "default",
    distroID,
    experiment,
    appName = Services.appinfo.name ?? "",
    version = Services.appinfo.version ?? "",
  }) {
    if (!this._configuration) {
      await this.getEngineConfiguration();
    }

    lazy.logConsole.debug(
      `fetchEngineConfiguration ${locale}:${region}:${channel}:${distroID}:${experiment}:${appName}:${version}`
    );

    if (!lazy.SearchUtils.rustSelectorFeatureGate) {
      lazy.logConsole.debug("Using JavaScript based engine selector");

      appName = appName.toLowerCase();
      version = version.toLowerCase();
      locale = locale.toLowerCase();
      region = region.toLowerCase();

      let engines = [];
      let defaultsConfig;
      let engineOrders;
      let userEnv = {
        appName,
        version,
        locale,
        region,
        channel,
        distroID,
        experiment,
      };

      for (let config of this._configuration) {
        if (config.recordType == "defaultEngines") {
          defaultsConfig = config;
        }

        if (config.recordType == "engineOrders") {
          engineOrders = config;
        }

        if (config.recordType !== "engine") {
          continue;
        }

        let variant = config.variants?.findLast(v =>
          this.#matchesUserEnvironment(v, userEnv)
        );

        if (!variant) {
          continue;
        }

        let subVariant = variant.subVariants?.findLast(sv =>
          this.#matchesUserEnvironment(sv, userEnv)
        );

        let engine = structuredClone(config.base);
        engine.identifier = config.identifier;
        engine = this.#deepCopyObject(engine, variant);

        if (subVariant) {
          engine = this.#deepCopyObject(engine, subVariant);
        }

        for (let override of this._configurationOverrides) {
          if (override.identifier == engine.identifier) {
            engine = this.#deepCopyObject(engine, override);
          }
        }

        engines.push(engine);
      }

      let { defaultEngine, privateDefault } = this.#defaultEngines(
        engines,
        defaultsConfig,
        userEnv
      );

      for (const orderData of engineOrders.orders) {
        let environment = orderData.environment;

        if (this.#matchesUserEnvironment({ environment }, userEnv)) {
          this.#setEngineOrders(engines, orderData.order);
        }
      }

      if (!defaultEngine) {
        if (engines.length) {
          lazy.logConsole.error(
            "Could not find a matching default engine, using the first one in the list"
          );
          defaultEngine = engines[0];
        } else {
          throw new Error(
            "Could not find any engines in the filtered configuration"
          );
        }
      }

      engines.sort(this._sort.bind(this, defaultEngine, privateDefault));

      let result = { engines, appDefaultEngineId: defaultEngine.identifier };

      if (privateDefault) {
        result.appPrivateDefaultEngineId = privateDefault.identifier;
      }

      if (lazy.SearchUtils.loggingEnabled) {
        lazy.logConsole.debug(
          "fetchEngineConfiguration: " + result.engines.map(e => e.identifier)
        );
      }
      return result;
    }

    lazy.logConsole.debug("Using Rust based engine selector");

    let refinedSearchConfig = this.#selector.filterEngineConfiguration(
      new lazy.SearchUserEnvironment({
        locale,
        region,
        updateChannel: this.#convertUpdateChannel(channel),
        distributionId: distroID ?? "",
        experiment: experiment ?? "",
        appName: this.#convertApplicationName(appName),
        version,
        deviceType: lazy.SearchDeviceType.NONE,
      })
    );

    refinedSearchConfig.engines = refinedSearchConfig.engines.filter(
      e => !e.optional
    );

    if (
      !refinedSearchConfig.appDefaultEngineId ||
      !refinedSearchConfig.engines.find(
        e => e.identifier == refinedSearchConfig.appDefaultEngineId
      )
    ) {
      if (refinedSearchConfig.engines.length) {
        lazy.logConsole.error(
          "Could not find a matching default engine, using the first one in the list"
        );
        refinedSearchConfig.appDefaultEngineId =
          refinedSearchConfig.engines[0].identifier;
      } else {
        throw new Error(
          "Could not find any engines in the filtered configuration"
        );
      }
    }
    if (lazy.SearchUtils.loggingEnabled) {
      lazy.logConsole.debug(
        "fetchEngineConfiguration: " +
          refinedSearchConfig.engines.map(e => e.identifier)
      );
    }

    return refinedSearchConfig;
  }

  /**
   * @type {RustSearchEngineSelector?}
   */
  #cachedSelector = null;

  /**
   * Returns the Rust based selector.
   *
   * @returns {RustSearchEngineSelector}
   */
  get #selector() {
    if (!this.#cachedSelector) {
      this.#cachedSelector = lazy.SearchEngineSelector.init();
    }
    return this.#cachedSelector;
  }

  /**
   * Converts the update channel from a string into a type the search engine
   * selector can understand.
   *
   * @param {string} channel
   *   The channel name to convert.
   * @returns {SearchUpdateChannel}
   */
  #convertUpdateChannel(channel) {
    let uppercaseChannel = channel.toUpperCase();

    if (uppercaseChannel in lazy.SearchUpdateChannel) {
      return lazy.SearchUpdateChannel[uppercaseChannel];
    }

    return lazy.SearchUpdateChannel.DEFAULT;
  }

  /**
   * Converts the application name from a string into a type the search engine
   * selector can understand.
   *
   * @param {string} appName
   *   The application name to convert.
   * @returns {SearchApplicationName}
   */
  #convertApplicationName(appName) {
    let uppercaseAppName = appName.toUpperCase().replace("-", "_");

    if (uppercaseAppName in lazy.SearchApplicationName) {
      return lazy.SearchApplicationName[uppercaseAppName];
    }

    return lazy.SearchApplicationName.FIREFOX;
  }

  _sort(defaultEngine, defaultPrivateEngine, a, b) {
    let order =
      this._sortIndex(b, defaultEngine, defaultPrivateEngine) -
      this._sortIndex(a, defaultEngine, defaultPrivateEngine);

    return order || a.name.localeCompare(b.name);
  }

  /**
   * Create an index order to ensure default (and backup default)
   * engines are ordered correctly.
   *
   * @param {object} obj
   *   Object representing the engine configuration.
   * @param {object} defaultEngine
   *   The default engine, for comparison to obj.
   * @param {object} defaultPrivateEngine
   *   The default private engine, for comparison to obj.
   * @returns {number}
   *  Number indicating how this engine should be sorted.
   */
  _sortIndex(obj, defaultEngine, defaultPrivateEngine) {
    if (obj == defaultEngine) {
      return Number.MAX_SAFE_INTEGER;
    }
    if (obj == defaultPrivateEngine) {
      return Number.MAX_SAFE_INTEGER - 1;
    }
    return obj.orderHint || 0;
  }

  /**
   * Deep copies an object to the target object and ignores some keys.
   *
   * @param {object} target - Object to copy to.
   * @param {object} source - Object to copy from.
   * @returns {object} - The source object.
   */
  #deepCopyObject(target, source) {
    for (let key in source) {
      if (["environment"].includes(key)) {
        continue;
      }

      if (["subVariants"].includes(key)) {
        continue;
      }

      if (typeof source[key] == "object" && !Array.isArray(source[key])) {
        if (key in target) {
          this.#deepCopyObject(target[key], source[key]);
        } else {
          target[key] = structuredClone(source[key]);
        }
      } else {
        target[key] = structuredClone(source[key]);
      }
    }

    return target;
  }

  /**
   * Matches the user's environment against the engine config's environment.
   *
   * @param {object} config
   *   The config for the given base or variant engine.
   * @param {object} user
   *   The user's environment we use to match with the engine's environment.
   * @param {string} user.appName
   *   The name of the application.
   * @param {string} user.version
   *   The version of the application.
   * @param {string} user.locale
   *   The locale of the user.
   * @param {string} user.region
   *   The region of the user.
   * @param {string} user.channel
   *   The channel the application is running on.
   * @param {string} user.distroID
   *   The distribution ID of the application.
   * @param {string} user.experiment
   *   Any associated experiment id.
   * @returns {boolean}
   *   True if the engine config's environment matches the user's environment.
   */
  #matchesUserEnvironment(config, user) {
    if ("experiment" in config.environment) {
      if (user.experiment != config.environment.experiment) {
        return false;
      }
    }

    if ("excludedDistributions" in config.environment) {
      if (config.environment.excludedDistributions.includes(user.distroID)) {
        return false;
      }
    }

    // Skip the optional flag for Desktop, it's a feature only on Android.
    if (config.optional) {
      return false;
    }

    return (
      this.#matchesRegionAndLocale(
        user.region,
        user.locale,
        config.environment
      ) &&
      this.#matchesDistribution(
        user.distroID,
        config.environment.distributions
      ) &&
      this.#matchesVersions(
        config.environment.minVersion,
        config.environment.maxVersion,
        user.version
      ) &&
      this.#matchesChannel(config.environment.channels, user.channel) &&
      this.#matchesApplication(config.environment.applications, user.appName) &&
      !this.#hasDeviceType(config.environment)
    );
  }

  /**
   * @param {string} userDistro
   *  The distribution from the user's environment.
   * @param {string[]} configDistro
   *  An array of distributions for the particular environment in the config.
   * @returns {boolean}
   *  True if the user's distribution is included in the config distribution
   *  list.
   */
  #matchesDistribution(userDistro, configDistro) {
    // If there's no distribution for this engineConfig, ignore the check.
    if (!configDistro) {
      return true;
    }

    return configDistro?.includes(userDistro);
  }

  /**
   * @param {string} min
   *  The minimum version supported.
   * @param {string} max
   *  The maximum version supported.
   * @param {string} userVersion
   *  The user's version.
   * @returns {boolean}
   *  True if the user's version is within the range of the min and max versions
   *  supported.
   */
  #matchesVersions(min, max, userVersion) {
    // If there's no versions for this engineConfig, ignore the check.
    if (!min && !max) {
      return true;
    }

    if (!userVersion) {
      return false;
    }

    if (min && !max) {
      return this.#isAboveOrEqualMin(userVersion, min);
    }

    if (!min && max) {
      return this.#isBelowOrEqualMax(userVersion, max);
    }

    return (
      this.#isAboveOrEqualMin(userVersion, min) &&
      this.#isBelowOrEqualMax(userVersion, max)
    );
  }

  #isAboveOrEqualMin(userVersion, min) {
    return Services.vc.compare(userVersion, min) >= 0;
  }

  #isBelowOrEqualMax(userVersion, max) {
    return Services.vc.compare(userVersion, max) <= 0;
  }

  /**
   * @param {string[]} configChannels
   *  Release channels such as nightly, beta, release, esr.
   * @param {string} userChannel
   *  The user's channel.
   * @returns {boolean}
   *  True if the user's channel is included in the config channels.
   */
  #matchesChannel(configChannels, userChannel) {
    // If there's no channels for this engineConfig, ignore the check.
    if (!configChannels) {
      return true;
    }

    return configChannels.includes(userChannel);
  }

  /**
   * @param {string[]} configApps
   *  The applications such as firefox, firefox-android, firefox-ios,
   *  focus-android, and focus-ios.
   * @param {string} userApp
   *  The user's application.
   * @returns {boolean}
   *  True if the user's application is included in the config applications.
   */
  #matchesApplication(configApps, userApp) {
    // If there's no config Applications for this engineConfig, ignore the check.
    if (!configApps) {
      return true;
    }

    return configApps.includes(userApp);
  }

  /**
   * Generally the device type option should only be used when the application
   * is selected to be on an android or iOS based product. However, we support
   * rejecting if this is non-empty in case of future requirements that we haven't
   * predicted.
   *
   * @param {object} environment
   *   An environment section from the engine configuration.
   * @returns {boolean}
   *   Returns true if there is a device type section and it is not empty.
   */
  #hasDeviceType(environment) {
    return !!environment.deviceType?.length;
  }

  /**
   * Determines whether the region and locale constraints in the config
   * environment  applies to a user given what region and locale they are using.
   *
   * @param {string} region
   *   The region the user is in.
   * @param {string} locale
   *   The language the user has configured.
   * @param {object} configEnv
   *   The environment of the engine configuration.
   * @returns {boolean}
   *   True if the user's region and locale matches the config's region and
   *   locale contraints. Otherwise false.
   */
  #matchesRegionAndLocale(region, locale, configEnv) {
    if (
      this.#doesConfigInclude(configEnv.excludedLocales, locale) ||
      this.#doesConfigInclude(configEnv.excludedRegions, region)
    ) {
      return false;
    }

    if (configEnv.allRegionsAndLocales) {
      return true;
    }

    // When none of the regions and locales are set. This implies its available
    // everywhere.
    if (
      !Object.hasOwn(configEnv, "allRegionsAndLocales") &&
      !Object.hasOwn(configEnv, "regions") &&
      !Object.hasOwn(configEnv, "locales")
    ) {
      return true;
    }

    if (
      this.#doesConfigInclude(configEnv?.locales, locale) &&
      this.#doesConfigInclude(configEnv?.regions, region)
    ) {
      return true;
    }

    if (
      this.#doesConfigInclude(configEnv?.locales, locale) &&
      !Object.hasOwn(configEnv, "regions")
    ) {
      return true;
    }

    if (
      this.#doesConfigInclude(configEnv?.regions, region) &&
      !Object.hasOwn(configEnv, "locales")
    ) {
      return true;
    }

    return false;
  }

  /**
   * This function converts the characters in the config to lowercase and
   * checks if the user's locale or region is included in config the
   * environment.
   *
   * @param {Array} configArray
   *   An Array of locales or regions from the config environment.
   * @param {string} compareItem
   *   The user's locale or region.
   * @returns {boolean}
   *   True if user's region or locale is found in the config environment.
   *   Otherwise false.
   */
  #doesConfigInclude(configArray, compareItem) {
    if (!configArray) {
      return false;
    }

    return configArray.find(
      configItem => configItem.toLowerCase() === compareItem
    );
  }

  /**
   * Gets the default engine and default private engine based on the user's
   * environment.
   *
   * @param {Array} engines
   *   An array that contains the engines for the user environment.
   * @param {object} defaultsConfig
   *   The defaultEngines record type from the search config.
   * @param {object} userEnv
   *   The user's environment.
   * @returns {object}
   *   An object with default engine and default private engine.
   */
  #defaultEngines(engines, defaultsConfig, userEnv) {
    let defaultEngine, privateDefault;

    for (let data of defaultsConfig.specificDefaults) {
      let environment = data.environment;

      if (this.#matchesUserEnvironment({ environment }, userEnv)) {
        defaultEngine = this.#findDefault(engines, data) ?? defaultEngine;
        privateDefault =
          this.#findDefault(engines, data, "private") ?? privateDefault;
      }
    }

    defaultEngine ??= this.#findGlobalDefault(engines, defaultsConfig);
    privateDefault ??= this.#findGlobalDefault(
      engines,
      defaultsConfig,
      "private"
    );

    return { defaultEngine, privateDefault };
  }

  /**
   * Finds the global default engine or global default private engine.
   *
   * @param {Array} engines
   *   The engines for the user environment.
   * @param {object} config
   *   The defaultEngines record from the config.
   * @param {string} [engineType]
   *   A string to identify default or default private.
   * @returns {object}
   *   The global default engine or global default private engine.
   */
  #findGlobalDefault(engines, config, engineType = "default") {
    let engine;
    if (config.globalDefault && engineType == "default") {
      engine = engines.find(e => e.identifier == config.globalDefault);
    }

    if (config.globalDefaultPrivate && engineType == "private") {
      engine = engines.find(e => e.identifier == config.globalDefaultPrivate);
    }

    return engine;
  }

  /**
   * Finds the default engine or default private engine from the list of
   * engines that match the user's environment.
   *
   * @param {Array} engines
   *   The engines for the user environment.
   * @param {object} config
   *   The specific defaults record that contains the default engine or default
   *   private engine identifer for the environment.
   * @param {string} [engineType]
   *   A string to identify default engine or default private engine.
   * @returns {object|undefined}
   *   The default engine or default private engine. Undefined if none can be
   *   found.
   */
  #findDefault(engines, config, engineType = "default") {
    let defaultMatch =
      engineType == "default" ? config.default : config.defaultPrivate;

    if (!defaultMatch) {
      return undefined;
    }

    return this.#findEngineWithMatch(engines, defaultMatch);
  }

  /**
   * Sets the orderHint number for the engines.
   *
   * @param {Array} engines
   *  The engines for the user environment.
   * @param {Array} orderedEngines
   *  The ordering of engines. Engines in the beginning of the list get a higher
   *  orderHint number.
   */
  #setEngineOrders(engines, orderedEngines) {
    let orderNumber = orderedEngines.length;

    for (const engine of orderedEngines) {
      let foundEngine = this.#findEngineWithMatch(engines, engine);
      if (foundEngine) {
        foundEngine.orderHint = orderNumber;
        orderNumber -= 1;
      }
    }
  }

  /**
   * Finds an engine with the given match.
   *
   * @param {object[]} engines
   *   An array of search engine configurations.
   * @param {string} match
   *   A string to match against the engine identifier. This will be an exact
   *   match, unless the string ends with `*`, in which case it will use a
   *   startsWith match.
   * @returns {object|undefined}
   */
  #findEngineWithMatch(engines, match) {
    if (match.endsWith("*")) {
      let matchNoStar = match.slice(0, -1);
      return engines.find(e => e.identifier.startsWith(matchNoStar));
    }
    return engines.find(e => e.identifier == match);
  }
}
