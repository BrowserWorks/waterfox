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

function getUltraStatusArgs(deps) {
  return {
    relay: displayNameFromURI(
      getStringSettingValue(deps, "waterfoxUltraRelayUri", OHTTP_RELAY_PREF),
      {
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
  return {
    ...config,
    l10nId: "waterfox-doh-status-ultra-active",
    l10nArgs: getUltraStatusArgs(deps),
    supportPage: "",
    controlAttrs: {
      role: "status",
      type: "success",
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
