import { configs, obsoleteConfigs } from "/common/common.js";
import * as Constants from "/common/constants.js";
import EventListenerManager from "/extlib/EventListenerManager.js";

export const onChanged = new EventListenerManager();

if (Constants.IS_BACKGROUND) {
  for (const [name, value] of Object.entries(configs.$default)) {
    if (obsoleteConfigs.has(name)) continue;
    switch (typeof value) {
      case "boolean":
        browser.prefs.setDefaultBoolValue(name, value);
        break;

      case "string":
        browser.prefs.setDefaultStringValue(name, value);
        break;

      default:
        browser.prefs.setDefaultStringValue(name, JSON.stringify(value));
        break;
    }

    getPref(name).then((value) => {
      if (JSON.stringify(configs[name]) === JSON.stringify(value)) return;
      configs[name] = value;
    });
  }
}

async function getPref(name) {
  const defaultValue = configs.$default[name];
  switch (typeof defaultValue) {
    case "boolean":
      return browser.prefs.getBoolValue(name, defaultValue);

    case "string":
      return browser.prefs.getStringValue(name, defaultValue);

    default:
      return browser.prefs
        .getStringValue(name, JSON.stringify(defaultValue))
        .then((value) => JSON.parse(value));
  }
}

const mNamesSyncToChrome = new Set();
const mNamesSyncFromChrome = new Set();

browser.prefs.onChanged.addListener((name) => {
  if (mNamesSyncToChrome.has(name) || mNamesSyncFromChrome.has(name)) return;

  mNamesSyncFromChrome.add(name);
  getPref(name).then((value) => {
    configs[name] = value;
    window.requestAnimationFrame(() => {
      mNamesSyncFromChrome.delete(name);
    });
  });
});

configs.$addObserver(async (name) => {
  if (mNamesSyncToChrome.has(name) || mNamesSyncFromChrome.has(name)) return;

  mNamesSyncToChrome.add(name);

  const value = configs[name];
  const defaultValue = configs.$default[name];
  switch (typeof defaultValue) {
    case "boolean":
      await browser.prefs.setBoolValue(name, value);
      break;

    case "string":
      await browser.prefs.setStringValue(name, value);
      break;

    default:
      await browser.prefs.setStringValue(name, JSON.stringify(value));
      break;
  }

  window.requestAnimationFrame(() => {
    mNamesSyncToChrome.delete(name);
  });
});
