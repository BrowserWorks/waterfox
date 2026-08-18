/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Preferences } from "chrome://global/content/preferences/Preferences.mjs";
import { SettingGroupManager } from "chrome://browser/content/preferences/config/SettingGroupManager.mjs";

ChromeUtils.importESModule(
  "chrome://browser/content/preferences/config/about-firefox.mjs",
  { global: "current" }
);

const { UpdateUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/UpdateUtils.sys.mjs"
);

// UpdateListener only ships when the updater is built in.
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  UpdateListener: "resource://gre/modules/UpdateListener.sys.mjs",
});

const APP_UPDATE_ENABLED_PREF = "app.update.enabled";

async function discardUpdateInProgress() {
  if (!("@mozilla.org/updates/update-service;1" in Cc)) {
    return false;
  }

  const aus = Cc["@mozilla.org/updates/update-service;1"].getService(
    Ci.nsIApplicationUpdateService
  );
  const um = Cc["@mozilla.org/updates/update-manager;1"].getService(
    Ci.nsIUpdateManager
  );

  await aus.init();
  if (aus.currentState == Ci.nsIApplicationUpdateService.STATE_IDLE) {
    return false;
  }

  const [title, message, discardButton, continueButton] =
    await document.l10n.formatValues([
      { id: "update-in-progress-title" },
      { id: "update-in-progress-message" },
      { id: "update-in-progress-ok-button" },
      { id: "update-in-progress-cancel-button" },
    ]);
  const buttonFlags =
    Ci.nsIPrompt.BUTTON_TITLE_IS_STRING * Ci.nsIPrompt.BUTTON_POS_0 +
    Ci.nsIPrompt.BUTTON_TITLE_IS_STRING * Ci.nsIPrompt.BUTTON_POS_1 +
    Ci.nsIPrompt.BUTTON_POS_1_DEFAULT;
  const result = Services.prompt.confirmEx(
    window,
    title,
    message,
    buttonFlags,
    discardButton,
    continueButton,
    null,
    null,
    {}
  );
  if (result != 0) {
    return false;
  }

  window.gAppUpdater?.stopCurrentCheck();
  try {
    await aus.stopDownload();
    await um.cleanupActiveUpdates();
    lazy.UpdateListener.clearPendingAndActiveNotifications();
    return true;
  } catch (error) {
    console.error("Failed to discard update in progress.", error);
    window.gAppUpdater?.resetToCheckForUpdates({
      monitorCurrentState:
        aus.currentState != Ci.nsIApplicationUpdateService.STATE_IDLE,
    });
    return false;
  }
}

async function reportUpdatePrefWriteError() {
  const [title, message] = await document.l10n.formatValues([
    { id: "update-setting-write-failure-title2" },
    {
      id: "update-setting-write-failure-message2",
      args: { path: UpdateUtils.configFilePath },
    },
  ]);
  const buttonFlags =
    Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_OK;
  Services.prompt.confirmEx(
    window,
    title,
    message,
    buttonFlags,
    null,
    null,
    null,
    null,
    {}
  );
}

const updatesGroup = SettingGroupManager.get("updates");
const installationFieldset = updatesGroup.items.find(
  item => item.id == "installationFieldset"
);
installationFieldset.supportPage = "waterfox-update-settings";
const crossUserWarning = installationFieldset.items.find(
  item => item.id == "updateSettingCrossUserWarning"
);
const updateRadioGroup = installationFieldset.items.find(
  item => item.id == "updateRadioGroup"
);
const automaticOption = updateRadioGroup.options.find(
  option => option.value === true
);
const notifyOption = updateRadioGroup.options.find(
  option => option.value === false
);
const disabledOption = {
  id: "disabledDesktop",
  value: 0,
  l10nId: "waterfox-update-application-disabled",
};

crossUserWarning.l10nId =
  "waterfox-update-application-warning-cross-user-setting";
automaticOption.l10nId = "waterfox-update-application-auto";
automaticOption.items = [];
notifyOption.l10nId = "waterfox-update-application-notify";
updateRadioGroup.options.splice(
  0,
  updateRadioGroup.options.length,
  automaticOption,
  notifyOption,
  disabledOption
);

const updateRadioSetting = Preferences.getSetting("updateRadioGroup");
const updateRadioAsyncSetting = updateRadioSetting.config.asyncSetting;

function appUpdateEnabledPrefValue() {
  return Services.prefs.getBoolPref(APP_UPDATE_ENABLED_PREF, true);
}

function updateModeAllowed(value) {
  return (
    !Services.prefs.prefIsLocked(APP_UPDATE_ENABLED_PREF) ||
    (appUpdateEnabledPrefValue() && value !== 0)
  );
}

function updateEnabledPrefLockState() {
  disabledOption.disabled =
    Services.prefs.prefIsLocked(APP_UPDATE_ENABLED_PREF) &&
    appUpdateEnabledPrefValue();
}

updateRadioAsyncSetting.get = async function () {
  if (this._pendingValue !== null) {
    return this._pendingValue;
  }
  const updateAuto = await UpdateUtils.getAppUpdateAutoEnabled();
  return Services.prefs.getBoolPref(APP_UPDATE_ENABLED_PREF, true)
    ? updateAuto
    : 0;
};

updateRadioAsyncSetting.set = async function (value) {
  if (!updateModeAllowed(value)) {
    this.emitChange();
    return;
  }

  this.pendingValue = value;
  this._disableTimeOverPromise = new Promise(resolve =>
    setTimeout(resolve, this._minUpdatePrefDisableTime)
  );

  try {
    if (value === 0) {
      try {
        if (Services.prefs.prefIsLocked(APP_UPDATE_ENABLED_PREF)) {
          throw new Error(`${APP_UPDATE_ENABLED_PREF} became locked`);
        }
        Services.prefs.setBoolPref(APP_UPDATE_ENABLED_PREF, false);
      } catch (error) {
        console.error("Failed to disable automatic update checks.", error);
        return;
      }
    } else {
      const previousAuto = await UpdateUtils.getAppUpdateAutoEnabled();
      try {
        await UpdateUtils.setAppUpdateAutoEnabled(value);
      } catch (error) {
        console.error(error);
        await reportUpdatePrefWriteError();
        return;
      }

      try {
        if (Services.prefs.prefIsLocked(APP_UPDATE_ENABLED_PREF)) {
          if (!appUpdateEnabledPrefValue()) {
            throw new Error(`${APP_UPDATE_ENABLED_PREF} became locked false`);
          }
        } else {
          Services.prefs.setBoolPref(APP_UPDATE_ENABLED_PREF, true);
        }
        if (!appUpdateEnabledPrefValue()) {
          throw new Error(`Failed to enable ${APP_UPDATE_ENABLED_PREF}`);
        }
      } catch (error) {
        console.error("Failed to enable automatic update checks.", error);
        try {
          await UpdateUtils.setAppUpdateAutoEnabled(previousAuto);
        } catch (rollbackError) {
          console.error("Failed to roll back app.update.auto.", rollbackError);
        }
        return;
      }
    }

    // The mode is already saved, so keeping an update that is already in
    // flight only decides the fate of that download.
    if (value !== true && (await discardUpdateInProgress())) {
      window.gAppUpdater?.resetToCheckForUpdates();
    }

    await this._disableTimeOverPromise;
  } finally {
    this.pendingValue = null;
  }
};

updateRadioAsyncSetting.disabled = async function () {
  return (
    this.pendingValue !== null ||
    (Services.prefs.prefIsLocked(APP_UPDATE_ENABLED_PREF) &&
      !appUpdateEnabledPrefValue())
  );
};

const onAppUpdateEnabledChange = () => {
  updateEnabledPrefLockState();
  updateRadioAsyncSetting.emitChange();
};
Services.prefs.addObserver(APP_UPDATE_ENABLED_PREF, onAppUpdateEnabledChange);
updateEnabledPrefLockState();
updateRadioAsyncSetting.emitChange();
window.addEventListener(
  "unload",
  () =>
    Services.prefs.removeObserver(
      APP_UPDATE_ENABLED_PREF,
      onAppUpdateEnabledChange
    ),
  { once: true }
);
