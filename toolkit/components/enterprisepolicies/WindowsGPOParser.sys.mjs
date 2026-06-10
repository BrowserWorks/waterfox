/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

const PREF_LOGLEVEL = "browser.policies.loglevel";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  let { ConsoleAPI } = ChromeUtils.importESModule(
    "resource://gre/modules/Console.sys.mjs"
  );
  return new ConsoleAPI({
    prefix: "WindowsGPOParser",
    // tip: set maxLogLevel to "debug" and use log.debug() to create detailed
    // messages during development. See LOG_LEVELS in Console.sys.mjs for details.
    maxLogLevel: "error",
    maxLogLevelPref: PREF_LOGLEVEL,
  });
});

export var WindowsGPOParser = {
  readPolicies(wrk, policies) {
    let childWrk = wrk.openChild(
      "BrowserWorks\\" + Services.appinfo.name,
      wrk.ACCESS_READ
    );
    if (!policies) {
      policies = {};
    }
    try {
      // Each hive is parsed independently and combined per policy: a later
      // hive (machine) overrides an earlier one (user) for a given policy.
      Object.assign(policies, registryToObject(childWrk));
    } catch (e) {
      lazy.log.error(e);
    } finally {
      childWrk.close();
    }
    // Need an extra check here so we don't
    // JSON.stringify if we aren't in debug mode
    if (lazy.log._maxLogLevel == "debug") {
      lazy.log.debug(JSON.stringify(policies, null, 2));
    }
    return policies;
  },
};

// Policies that may be supplied as either a single value holding JSON (a
// REG_SZ/REG_MULTI_SZ) or a subkey tree keyed by id. When a registry path has
// both forms, registryToObject merges them rather than letting one silently
// drop the other.
const MERGEABLE_POLICIES = ["ExtensionSettings"];

function registryToObject(wrk) {
  let policies = {};
  if (wrk.valueCount > 0) {
    if (wrk.getValueName(0) == "1") {
      // If the first item is 1, just assume it is an array
      let array = [];
      for (let i = 0; i < wrk.valueCount; i++) {
        array.push(readRegistryValue(wrk, wrk.getValueName(i)));
      }
      // If it's an array, it shouldn't have any children
      return array;
    }
    for (let i = 0; i < wrk.valueCount; i++) {
      let name = wrk.getValueName(i);
      let value = readRegistryValue(wrk, name);
      if (value != undefined) {
        policies[name] = value;
      }
    }
  }
  if (wrk.childCount > 0) {
    if (wrk.getChildName(0) == "1") {
      // If the first item is 1, it's an array of objects
      let array = [];
      for (let i = 0; i < wrk.childCount; i++) {
        let name = wrk.getChildName(i);
        let childWrk = wrk.openChild(name, wrk.ACCESS_READ);
        array.push(registryToObject(childWrk));
        childWrk.close();
      }
      // If it's an array, it shouldn't have any children
      return array;
    }
    for (let i = 0; i < wrk.childCount; i++) {
      let name = wrk.getChildName(i);
      let childWrk = wrk.openChild(name, wrk.ACCESS_READ);
      let value = registryToObject(childWrk);
      // For a mergeable policy present both as a value holding JSON and as a
      // same-named subkey, merge them with the value winning collisions, so a
      // subkey can't drop the value or override entries like "*". The REG_SZ
      // JSON is still a string here; if it doesn't parse, keep the subkey.
      if (MERGEABLE_POLICIES.includes(name) && isObject(value)) {
        let existing = policies[name];
        if (typeof existing == "string") {
          try {
            existing = JSON.parse(existing);
          } catch (e) {
            existing = undefined;
          }
        }
        if (isObject(existing)) {
          value = { ...value, ...existing };
        }
      }
      policies[name] = value;
      childWrk.close();
    }
  }
  return policies;
}

function isObject(value) {
  return typeof value == "object" && value !== null && !Array.isArray(value);
}

function readRegistryValue(wrk, value) {
  switch (wrk.getValueType(value)) {
    case 7: // REG_MULTI_SZ
      // While we support JSON in REG_SZ and REG_MULTI_SZ, if it's REG_MULTI_SZ,
      // we know it must be JSON. So we go ahead and JSON.parse it here so it goes
      // through the schema validator.
      try {
        return JSON.parse(wrk.readStringValue(value).replace(/\0/g, "\n"));
      } catch (e) {
        lazy.log.error(`Unable to parse JSON for ${value}`);
        return undefined;
      }
    case 2: // REG_EXPAND_SZ
    case wrk.TYPE_STRING:
      return wrk.readStringValue(value);
    case wrk.TYPE_BINARY:
      return wrk.readBinaryValue(value);
    case wrk.TYPE_INT:
      return wrk.readIntValue(value);
    case wrk.TYPE_INT64:
      return wrk.readInt64Value(value);
  }
  // unknown type
  return null;
}
