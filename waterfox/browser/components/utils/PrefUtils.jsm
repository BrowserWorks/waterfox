/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXPORTED_SYMBOLS = ["PrefUtils"];

const { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");

var PrefUtils = {
  get(prefPath, valueIfUndefined, def = false, setDefault = true) {
    let sPrefs = def ? Services.prefs.getDefaultBranch(null) : Services.prefs;

    try {
      switch (sPrefs.getPrefType(prefPath)) {
        case 0:
          if (valueIfUndefined != undefined) {
            return this.set(prefPath, valueIfUndefined, setDefault);
          }
          return undefined;
        case 32:
          return sPrefs.getStringPref(prefPath);
        case 64:
          return sPrefs.getIntPref(prefPath);
        case 128:
          return sPrefs.getBoolPref(prefPath);
      }
    } catch (ex) {}
    return undefined;
  },

  set(prefPath, value, def = false) {
    let sPrefs = def ? Services.prefs.getDefaultBranch(null) : Services.prefs;

    switch (typeof value) {
      case "string":
        return sPrefs.setCharPref(prefPath, value) || value;
      case "number":
        return sPrefs.setIntPref(prefPath, value) || value;
      case "boolean":
        return sPrefs.setBoolPref(prefPath, value) || value;
    }
    return undefined;
  },

  lock(prefPath, value) {
    let sPrefs = Services.prefs;
    this.lockedBackupDef[prefPath] = this.get(prefPath, true);
    if (sPrefs.prefIsLocked(prefPath)) {
      sPrefs.unlockPref(prefPath);
    }

    this.set(prefPath, value, true);
    sPrefs.lockPref(prefPath);
  },

  lockedBackupDef: {},

  unlock(prefPath) {
    Services.prefs.unlockPref(prefPath);
    let bkp = this.lockedBackupDef[prefPath];
    if (bkp == undefined) {
      Services.prefs.deleteBranch(prefPath);
    } else {
      this.set(prefPath, bkp, true);
    }
  },

  clear: Services.prefs.clearUserPref,

  addObserver(aPrefPath, aCallback) {
    this.observer = function(aSubject, aTopic, prefPath) {
      return aCallback(PrefUtils.get(prefPath), prefPath);
    };

    Services.prefs.addObserver(aPrefPath, this.observer);
    return {
      prefPath: aPrefPath,
      observer: this.observer,
    };
  },

  removeObserver(obs) {
    Services.prefs.removeObserver(obs.prefPath, obs.observer);
  },
};
