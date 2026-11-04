/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";
import { ICloudPasswordsUI } from "chrome://browser/content/waterfox/settings/ICloudPasswordsUI.mjs";
import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";

window.MozXULElement.insertFTLIfNeeded("browser/waterfox/icloud-passwords.ftl");

const ui = new ICloudPasswordsUI(window, () => {
  Preferences.getSetting("waterfox-icloud-state")?.onChange();
});
const deps = ["waterfox-icloud-state"];

function getIdleTimeoutOption(seconds) {
  let unit = "seconds";
  let amount = seconds;
  if (seconds % 3600 === 0) {
    unit = "hours";
    amount = seconds / 3600;
  } else if (seconds % 60 === 0) {
    unit = "minutes";
    amount = seconds / 60;
  }
  return {
    value: seconds,
    l10nId: `waterfox-icloud-idle-${unit}`,
    l10nArgs: { [unit]: amount },
  };
}

Preferences.addSetting({ id: "waterfox-icloud-state" });
Preferences.addSetting({
  id: "waterfox-icloud-enabled",
  deps,
  get: () => ui.enabled,
  set: value => ui.run("enabled", !!value),
  disabled: () => !ui.canConfigure("enabled"),
  visible: () => ui.available,
});

for (const [settingName, get] of [
  ["destination", () => (ui.provider.saveByDefault ? "icloud" : "local")],
  ["otp", () => ui.provider.otpEnabled],
  ["idleTimeout", () => ui.idleTimeout],
]) {
  const setting = {
    id: `waterfox-icloud-${settingName}`,
    deps,
    get,
    set: value =>
      ui.setPreference(
        settingName,
        settingName === "destination" ? value === "icloud" : value
      ),
    disabled: () => !ui.canConfigure(settingName),
    visible: () => ui.available && ui.enabled,
  };
  if (settingName === "idleTimeout") {
    setting.getControlConfig = function getControlConfig(config) {
      const seconds = get();
      const values = [...new Set([60, 300, 900, 3600, seconds])].sort(
        (a, b) => a - b
      );
      return {
        ...config,
        options: values.map(getIdleTimeoutOption),
      };
    };
  }
  Preferences.addSetting(setting);
}

for (const action of ["unlock", "lock", "manager"]) {
  Preferences.addSetting({
    id: `waterfox-icloud-${action}`,
    deps,
    disabled: () => !ui.canRun(action),
    visible: () => {
      if (!ui.available || !ui.enabled) {
        return false;
      }
      if (action === "manager") {
        return true;
      }
      return action === "lock" ? ui.ready : !ui.ready;
    },
    onUserClick: () => ui.run(action),
  });
}

Preferences.addSetting({
  id: "waterfox-icloud-experimental",
  deps,
  visible: () => ui.available,
});
Preferences.addSetting({
  id: "waterfox-icloud-connection",
  deps,
  visible: () => ui.available && ui.enabled,
});
Preferences.addSetting({
  id: "waterfox-icloud-status",
  deps,
  getControlConfig: config => ({
    ...config,
    l10nId: `${ui.statusL10nId}-label`,
    controlAttrs: { role: "status", "aria-atomic": "true" },
  }),
});
Preferences.addSetting({
  id: "waterfox-icloud-error",
  deps,
  visible: () => ui.available && !!ui.errorL10nId,
  getControlConfig: config => ({
    ...config,
    l10nId: `${ui.errorL10nId || "waterfox-icloud-error-status"}-message`,
    controlAttrs: { type: "error", role: "alert", "aria-atomic": "true" },
  }),
});

SettingGroupManager.registerGroups({
  waterfoxICloudPasswords: {
    l10nId: "waterfox-icloud-group",
    headingLevel: 2,
    subcategory: "icloud-passwords",
    controlAttrs: { badge: "waterfox-exclusive" },
    items: [
      {
        id: "waterfox-icloud-experimental",
        control: "moz-message-bar",
        l10nId: "waterfox-icloud-experimental",
        controlAttrs: { type: "warning", role: "note" },
      },
      {
        id: "waterfox-icloud-enabled",
        l10nId: "waterfox-icloud-enable-toggle",
        control: "moz-toggle",
        controlAttrs: { ".inputLayout": "inline-end" },
      },
      {
        id: "waterfox-icloud-connection",
        control: "moz-box-group",
        items: [
          {
            id: "waterfox-icloud-status",
            control: "moz-box-item",
            items: [
              {
                id: "waterfox-icloud-manager",
                l10nId: "waterfox-icloud-manager-button",
                control: "moz-button",
                slot: "actions",
              },
              {
                id: "waterfox-icloud-unlock",
                l10nId: "waterfox-icloud-unlock-button",
                control: "moz-button",
                slot: "actions",
              },
              {
                id: "waterfox-icloud-lock",
                l10nId: "waterfox-icloud-lock-button",
                control: "moz-button",
                slot: "actions",
              },
            ],
          },
        ],
      },
      { id: "waterfox-icloud-error", control: "moz-message-bar" },
      {
        id: "waterfox-icloud-idleTimeout",
        l10nId: "waterfox-icloud-idle-timeout",
        control: "moz-select",
        controlAttrs: { ".inputLayout": "inline-end" },
      },
      {
        id: "waterfox-icloud-destination",
        l10nId: "waterfox-icloud-destination",
        control: "moz-select",
        controlAttrs: { ".inputLayout": "inline-end" },
        options: [
          { value: "local", l10nId: "waterfox-icloud-destination-local" },
          { value: "icloud", l10nId: "waterfox-icloud-destination-icloud" },
        ],
      },
      {
        id: "waterfox-icloud-otp",
        l10nId: "waterfox-icloud-otp-toggle",
        control: "moz-toggle",
        controlAttrs: { ".inputLayout": "inline-end" },
      },
    ],
  },
});

ui.start();
