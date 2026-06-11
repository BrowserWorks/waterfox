/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";
import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";

const OHTTP_PREF = "network.trr.use_ohttp";
const USE_GET_PREF = "network.trr.useGET";
const TRR_MODE_PREF = "network.trr.mode";
const TRR_URI_PREF = "network.trr.uri";
const OHTTP_RELAY_PREF = "network.trr.ohttp.relay_uri";
const OHTTP_ENDPOINT_PREF = "network.trr.ohttp.uri";

const OHTTP_PROBE_HOST = "example.com";

const REACHABILITY_UNKNOWN = "unknown";
const REACHABILITY_OK = "ok";
const REACHABILITY_FAILED = "failed";

const DOH_GROUP_BLURBS = {
  dnsOverHttps: {
    standardL10nId: "dns-over-https-group2",
    ultraL10nId: "waterfox-doh-group-ultra",
  },
  dnsOverHttpsAdvanced: {
    standardL10nId: "preferences-doh-advanced-section",
    ultraL10nId: "waterfox-doh-advanced-section-ultra",
  },
};
const DOH_GROUP_BLURB_PREFS = [
  OHTTP_PREF,
  USE_GET_PREF,
  TRR_MODE_PREF,
  TRR_URI_PREF,
];

Preferences.addAll([
  { id: OHTTP_PREF, type: "bool" },
  { id: USE_GET_PREF, type: "bool" },
  { id: OHTTP_RELAY_PREF, type: "string" },
  { id: OHTTP_ENDPOINT_PREF, type: "string" },
]);

function ultraModeActive(mode) {
  return (
    mode == Ci.nsIDNSService.MODE_TRRFIRST ||
    mode == Ci.nsIDNSService.MODE_TRRONLY
  );
}

function clearUserPref(pref) {
  if (Services.prefs.prefHasUserValue(pref)) {
    Services.prefs.clearUserPref(pref);
  }
}

function ultraStateActive(ohttp, useGet, mode, url = "") {
  return !!ohttp && useGet === false && ultraModeActive(mode) && !url;
}

let updatingFromUltra = false;

function writeUltraPrefs(callback) {
  updatingFromUltra = true;
  try {
    callback();
  } finally {
    updatingFromUltra = false;
    updateDohGroupBlurbs();
  }
}

function applyUltra() {
  writeUltraPrefs(() => {
    clearUserPref(OHTTP_PREF);
    clearUserPref(USE_GET_PREF);
    clearUserPref(TRR_MODE_PREF);
    clearUserPref(TRR_URI_PREF);
  });
}

function leaveUltra() {
  writeUltraPrefs(() => {
    Services.prefs.setBoolPref(OHTTP_PREF, false);
    Services.prefs.setBoolPref(USE_GET_PREF, true);
  });
}

function disableUltra() {
  writeUltraPrefs(() => {
    Services.prefs.setBoolPref(OHTTP_PREF, false);
    Services.prefs.setBoolPref(USE_GET_PREF, true);
    Services.prefs.setIntPref(TRR_MODE_PREF, Ci.nsIDNSService.MODE_NATIVEONLY);
  });
}

function ultraIsActiveFromDeps(deps) {
  return ultraStateActive(
    deps.waterfoxUltraOhttp.value,
    deps.waterfoxUltraUseGet.value,
    deps.dohMode.value,
    deps.dohURL.value
  );
}

function ultraIsActiveFromPrefs() {
  return ultraStateActive(
    Services.prefs.getBoolPref(OHTTP_PREF, false),
    Services.prefs.getBoolPref(USE_GET_PREF, true),
    Services.prefs.getIntPref(TRR_MODE_PREF, Ci.nsIDNSService.MODE_NATIVEONLY),
    Services.prefs.getStringPref(TRR_URI_PREF, "")
  );
}

function updateRenderedDohGroup(groupId) {
  for (let group of globalThis.document?.querySelectorAll(
    `setting-group[groupid="${groupId}"]`
  ) || []) {
    group.requestUpdate();
  }
}

function updateDohGroupBlurbs() {
  let ultraActive = ultraIsActiveFromPrefs();
  for (let [groupId, l10nIds] of Object.entries(DOH_GROUP_BLURBS)) {
    let config;
    try {
      config = SettingGroupManager.get(groupId);
    } catch (_ex) {
      continue;
    }

    let l10nId = ultraActive ? l10nIds.ultraL10nId : l10nIds.standardL10nId;
    if (config.l10nId == l10nId) {
      continue;
    }

    config.l10nId = l10nId;
    updateRenderedDohGroup(groupId);
  }
}

function onDohGroupBlurbPrefChange() {
  if (!updatingFromUltra) {
    updateDohGroupBlurbs();
  }
}

function displayNameFromURI(uri, namesByHost = {}) {
  let hostname = URL.parse(uri)?.hostname;
  return namesByHost[hostname] || hostname || uri || "";
}

function getDefaultStringPref(pref) {
  return Services.prefs.getDefaultBranch("").getStringPref(pref, "");
}

function getStringSettingValue(deps, settingId, pref) {
  return (
    deps[settingId].value ||
    Services.prefs.getStringPref(pref, "") ||
    getDefaultStringPref(pref)
  );
}

let ohttpReachability = REACHABILITY_UNKNOWN;
let ohttpFailureReason = "";
let pendingProbe = null;
let probeTimer = null;
let probeGeneration = 0;

// Applying or leaving Ultra rewrites several prefs in a row, and each one fires
// a dep change. Coalesce those into a single lookup.
const PROBE_DEBOUNCE_MS = 250;

function cancelPendingProbe() {
  probeGeneration++;
  if (probeTimer) {
    clearTimeout(probeTimer);
    probeTimer = null;
  }
  pendingProbe?.cancel(Cr.NS_ERROR_ABORT);
  pendingProbe = null;
}

function scheduleProbe(emitChange) {
  if (probeTimer) {
    clearTimeout(probeTimer);
  }
  probeTimer = setTimeout(() => {
    probeTimer = null;
    probeOhttp(emitChange);
  }, PROBE_DEBOUNCE_MS);
}

/**
 * @param {nsIDNSRecord | null} record
 * @param {nsresult} statusCode
 * @returns {{state: string, reason: string}}
 */
function probeOutcome(record, statusCode) {
  if (!Components.isSuccessCode(statusCode) || !record) {
    return {
      state: REACHABILITY_FAILED,
      reason: ChromeUtils.getXPCOMErrorName(statusCode),
    };
  }

  let skipReason = Ci.nsITRRSkipReason.TRR_OK;
  try {
    skipReason = record.QueryInterface(Ci.nsIDNSAddrRecord).trrSkipReason;
  } catch (_ex) {
    // Not an address record, so there is no TRR provenance to check.
  }

  if (skipReason != Ci.nsITRRSkipReason.TRR_OK) {
    return {
      state: REACHABILITY_FAILED,
      reason: Services.dns.getTRRSkipReasonName(skipReason),
    };
  }

  return { state: REACHABILITY_OK, reason: "" };
}

function probeOhttp(emitChange) {
  cancelPendingProbe();
  let generation = probeGeneration;

  let setResult = (state, reason = "") => {
    if (generation != probeGeneration) {
      return;
    }
    if (state == ohttpReachability && reason == ohttpFailureReason) {
      return;
    }
    ohttpReachability = state;
    ohttpFailureReason = reason;
    emitChange();
  };

  if (!ultraIsActiveFromPrefs()) {
    setResult(REACHABILITY_UNKNOWN);
    return;
  }

  try {
    pendingProbe = Services.dns.asyncResolve(
      OHTTP_PROBE_HOST,
      Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT,
      Ci.nsIDNSService.RESOLVE_BYPASS_CACHE,
      null,
      {
        onLookupComplete(_request, result, statusCode) {
          if (generation != probeGeneration) {
            return;
          }
          pendingProbe = null;
          let { state, reason } = probeOutcome(result, statusCode);
          setResult(state, reason);
        },
      },
      Services.tm.mainThread
    );
  } catch (ex) {
    setResult(REACHABILITY_FAILED, ex.name || "NS_ERROR_FAILURE");
  }
}

function getUltraStatusArgs(deps) {
  return {
    relay: displayNameFromURI(
      getStringSettingValue(deps, "waterfoxUltraRelayUri", OHTTP_RELAY_PREF),
      {
        "dooh.waterfox.com": "Waterfox",
        "dooh.waterfox.net": "Waterfox",
      }
    ),
    provider: displayNameFromURI(
      getStringSettingValue(
        deps,
        "waterfoxUltraEndpointUri",
        OHTTP_ENDPOINT_PREF
      ),
      {
        "dooh.cloudflare-dns.com": "Cloudflare",
      }
    ),
  };
}

function getUltraStatusConfig(config, deps) {
  let failed = deps.waterfoxUltraReachable?.value == REACHABILITY_FAILED;
  let l10nArgs = getUltraStatusArgs(deps);
  if (failed) {
    l10nArgs.reason = ohttpFailureReason || "NS_ERROR_FAILURE";
  }

  return {
    ...config,
    l10nId: failed
      ? "waterfox-doh-status-ultra-error"
      : "waterfox-doh-status-ultra-active",
    l10nArgs,
    supportPage: "waterfox-ultra-protection-dns",
    controlAttrs: {
      role: "status",
      type: failed ? "error" : "success",
    },
  };
}

function addDeps(config, deps) {
  config.deps = [...new Set([...(config.deps || []), ...deps])];
}

function ultraRadioOption() {
  return {
    id: "dohRadioUltra",
    value: "ultra",
    l10nId: "waterfox-doh-radio-ultra",
    items: [
      {
        id: "waterfox-ultra-fallback",
        l10nId: "waterfox-ultra-fallback-select",
        control: "moz-select",
        options: [
          {
            value: "fallback",
            l10nId: "waterfox-ultra-fallback-option-allowed",
          },
          {
            value: "no-fallback",
            l10nId: "waterfox-ultra-fallback-option-disabled",
          },
        ],
      },
      {
        id: "waterfox-ultra-relay-uri",
        control: "moz-box-item",
        l10nId: "waterfox-doh-ultra-relay",
      },
      {
        id: "waterfox-ultra-endpoint-uri",
        control: "moz-box-item",
        l10nId: "waterfox-doh-ultra-endpoint",
      },
    ],
  };
}

function addUltraRadioOption(config) {
  if (
    !config.options ||
    config.options.some(option => option.value == "ultra")
  ) {
    return config;
  }

  return {
    ...config,
    options: [ultraRadioOption(), ...config.options],
  };
}

const DOH_SETTING_WRAPPERS = {
  dohModeBoxItem: {
    deps: ["waterfoxUltraOhttp", "waterfoxUltraUseGet", "dohURL"],
    wrap(config) {
      const origGetControlConfig = config.getControlConfig;
      config.getControlConfig = (controlConfig, deps, setting) => {
        const result = origGetControlConfig
          ? origGetControlConfig(controlConfig, deps, setting)
          : controlConfig;
        return ultraIsActiveFromDeps(deps)
          ? { ...result, l10nId: "waterfox-doh-overview-ultra" }
          : result;
      };
    },
  },
  dohStatusBox: {
    deps: [
      "waterfoxUltraOhttp",
      "waterfoxUltraUseGet",
      "waterfoxUltraRelayUri",
      "waterfoxUltraEndpointUri",
      "waterfoxUltraReachable",
    ],
    wrap(config) {
      const origGetControlConfig = config.getControlConfig;
      config.getControlConfig = (controlConfig, deps, setting) => {
        const result = origGetControlConfig
          ? origGetControlConfig(controlConfig, deps, setting)
          : controlConfig;
        return ultraIsActiveFromDeps(deps)
          ? getUltraStatusConfig(result, deps)
          : result;
      };
    },
  },
  dohRadioGroup: {
    deps: ["waterfoxUltraOhttp", "waterfoxUltraUseGet"],
    wrap(config) {
      const origGet = config.get;
      const origSet = config.set;
      const origOnUserChange = config.onUserChange;
      const origGetControlConfig = config.getControlConfig;

      config.get = (val, deps, setting) => {
        if (ultraIsActiveFromDeps(deps)) {
          return "ultra";
        }
        return origGet ? origGet(val, deps, setting) : val;
      };
      config.set = (val, deps, setting) => {
        if (val == "ultra") {
          applyUltra();
          return val;
        }
        leaveUltra();
        return origSet ? origSet(val, deps, setting) : val;
      };
      config.onUserChange = (val, deps, setting) => {
        if (val != "ultra") {
          origOnUserChange?.(val, deps, setting);
        }
      };
      config.getControlConfig = (controlConfig, deps, setting) => {
        const result = origGetControlConfig
          ? origGetControlConfig(controlConfig, deps, setting)
          : controlConfig;
        return addUltraRadioOption(result);
      };
    },
  },
};

function wrapDohConfig(id, config) {
  if (config._waterfoxUltraWrapped) {
    return;
  }
  let wrapper = DOH_SETTING_WRAPPERS[id];
  addDeps(config, wrapper.deps);
  wrapper.wrap(config);
  config._waterfoxUltraWrapped = true;
}

for (const id of Object.keys(DOH_SETTING_WRAPPERS)) {
  const setting = Preferences.getSetting(id);
  if (setting) {
    wrapDohConfig(id, setting.config);
  }
}

const origAddSetting = Preferences.addSetting.bind(Preferences);
Preferences.addSetting = config => {
  if (DOH_SETTING_WRAPPERS[config.id] && !Preferences.getSetting(config.id)) {
    wrapDohConfig(config.id, config);
  }
  return origAddSetting(config);
};

Preferences.addSetting({
  id: "waterfoxUltraOhttp",
  pref: OHTTP_PREF,
});

Preferences.addSetting({
  id: "waterfoxUltraUseGet",
  pref: USE_GET_PREF,
});

Preferences.addSetting({
  id: "waterfoxUltraRelayUri",
  pref: OHTTP_RELAY_PREF,
});

Preferences.addSetting({
  id: "waterfoxUltraEndpointUri",
  pref: OHTTP_ENDPOINT_PREF,
});

Preferences.addSetting({
  id: "waterfoxUltraReachable",
  deps: [
    "waterfoxUltraOhttp",
    "waterfoxUltraUseGet",
    "waterfoxUltraRelayUri",
    "waterfoxUltraEndpointUri",
    "dohMode",
    "dohURL",
  ],
  get: () => ohttpReachability,
  setup(emitChange, deps) {
    const runProbe = () => scheduleProbe(emitChange);
    const settings = Object.values(deps);

    runProbe();
    for (const setting of settings) {
      setting.on("change", runProbe);
    }

    return () => {
      for (const setting of settings) {
        setting.off("change", runProbe);
      }
      cancelPendingProbe();
      ohttpReachability = REACHABILITY_UNKNOWN;
      ohttpFailureReason = "";
    };
  },
});

Preferences.addSetting({
  id: "waterfox-ultra-enabled",
  deps: ["waterfoxUltraOhttp", "waterfoxUltraUseGet", "dohMode", "dohURL"],
  get: (_val, deps) =>
    ultraStateActive(
      deps.waterfoxUltraOhttp.value,
      deps.waterfoxUltraUseGet.value,
      deps.dohMode.value,
      deps.dohURL.value
    ),
  set(val) {
    if (val) {
      applyUltra();
    } else {
      disableUltra();
    }
  },
  setup(_emitChange, deps) {
    const onModeChange = () => {
      if (
        !updatingFromUltra &&
        deps.waterfoxUltraOhttp.value &&
        !ultraModeActive(deps.dohMode.value)
      ) {
        leaveUltra();
      }
    };
    const onUrlChange = () => {
      if (
        !updatingFromUltra &&
        deps.waterfoxUltraOhttp.value &&
        ultraModeActive(deps.dohMode.value) &&
        deps.dohURL.value
      ) {
        leaveUltra();
      }
    };
    deps.dohMode.on("change", onModeChange);
    deps.dohURL.on("change", onUrlChange);
    return () => {
      deps.dohMode.off("change", onModeChange);
      deps.dohURL.off("change", onUrlChange);
    };
  },
});

Preferences.addSetting({
  id: "waterfox-ultra-fallback",
  deps: ["waterfox-ultra-enabled", "dohMode"],
  get: (_val, deps) =>
    deps.dohMode.value == Ci.nsIDNSService.MODE_TRRONLY
      ? "no-fallback"
      : "fallback",
  set(val) {
    writeUltraPrefs(() => {
      if (val == "no-fallback") {
        Services.prefs.setIntPref(TRR_MODE_PREF, Ci.nsIDNSService.MODE_TRRONLY);
      } else {
        clearUserPref(TRR_MODE_PREF);
      }
    });
  },
  disabled: deps => !deps["waterfox-ultra-enabled"].value,
});

for (let [id, pref] of [
  ["waterfox-ultra-relay-uri", OHTTP_RELAY_PREF],
  ["waterfox-ultra-endpoint-uri", OHTTP_ENDPOINT_PREF],
]) {
  Preferences.addSetting({
    id,
    pref,
    getControlConfig(config, _deps, setting) {
      return {
        ...config,
        l10nArgs: {
          uri: setting.value || "",
        },
      };
    },
  });
}

for (let pref of DOH_GROUP_BLURB_PREFS) {
  Services.prefs.addObserver(pref, onDohGroupBlurbPrefChange);
}
updateDohGroupBlurbs();
