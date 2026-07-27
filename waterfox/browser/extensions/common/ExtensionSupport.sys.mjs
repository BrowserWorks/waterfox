/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddonManager as AddonManagerAPI } from "resource://gre/modules/AddonManager.sys.mjs";
import { NetUtil } from "resource://gre/modules/NetUtil.sys.mjs";
import { fixIterator } from "resource:///modules/iteratorUtils.sys.mjs";

const PREF_DIRECTORY = "defaults/preferences/";
const SHUTDOWN_TOPIC = "profile-before-change";
const WINDOW_URL_PROPERTIES = ["chromeURLs", "windowURLs"];
const extensionHooks = new Map();
const trackedDefaultPreferences = new Map();
const trackedUserPreferences = new Map();
const legacyExtensions = new Map();
const loadedBootstrapExtensions = new Set();
const windowStates = new Map();
const appWindows = new WeakMap();
const logger = console.createInstance({ prefix: "ExtensionSupport" });

let openWindowList;
let listeningForWindows = false;
let addonListenerRegistered = false;
let shutdownObserverRegistered = false;
let shuttingDown = false;

function sortDescending(left, right) {
  if (left < right) {
    return 1;
  }
  if (left > right) {
    return -1;
  }
  return 0;
}

function setPreference(useDefaultBranch, name, value) {
  if (typeof name !== "string" || !name) {
    throw new TypeError("Preference names must be non-empty strings");
  }

  const branch = useDefaultBranch
    ? Services.prefs.getDefaultBranch("")
    : Services.prefs.getBranch("");

  if (typeof value === "boolean") {
    branch.setBoolPref(name, value);
    return;
  }

  if (typeof value === "string") {
    if (value.startsWith("chrome://") && value.endsWith(".properties")) {
      const localizedValue = Cc[
        "@mozilla.org/pref-localizedstring;1"
      ].createInstance(Ci.nsIPrefLocalizedString);
      localizedValue.data = value;
      branch.setComplexValue(name, Ci.nsIPrefLocalizedString, localizedValue);
    } else {
      branch.setStringPref(name, value);
    }
    return;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (Number.isInteger(value)) {
      branch.setIntPref(name, value);
    } else {
      branch.setCharPref(name, String(value));
    }
    return;
  }

  throw new TypeError(`Unsupported value for preference ${name}`);
}

function readPreference(branch, name, userOnly = false) {
  const hasValue = userOnly
    ? branch.prefHasUserValue(name)
    : branch.prefHasDefaultValue(name);
  if (!hasValue) {
    return { type: Ci.nsIPrefBranch.PREF_INVALID };
  }

  const type = branch.getPrefType(name);
  if (type === Ci.nsIPrefBranch.PREF_INVALID) {
    return { type };
  }
  if (type === Ci.nsIPrefBranch.PREF_BOOL) {
    return { type, value: branch.getBoolPref(name) };
  }
  if (type === Ci.nsIPrefBranch.PREF_INT) {
    return { type, value: branch.getIntPref(name) };
  }

  const value = branch.getStringPref(name);
  return {
    type,
    localized: value.startsWith("chrome://") && value.endsWith(".properties"),
    value,
  };
}

function samePreference(left, right) {
  return Boolean(
    left &&
    right &&
    left.type === right.type &&
    left.localized === right.localized &&
    left.value === right.value
  );
}

function restorePreference(branch, name, snapshot, userOnly = false) {
  if (snapshot.type === Ci.nsIPrefBranch.PREF_INVALID) {
    if (userOnly) {
      if (branch.prefHasUserValue(name)) {
        branch.clearUserPref(name);
      }
      return;
    }

    const descendants = branch.getChildList(`${name}.`);
    const preferenceNames = [name, ...descendants];
    if (preferenceNames.some(prefName => branch.prefIsLocked(prefName))) {
      throw new Error(
        `Cannot remove default preference ${name} while its branch contains locked preferences`
      );
    }

    const userBranch = Services.prefs.getBranch("");
    const defaultDescendants = descendants
      .map(child => [child, readPreference(branch, child)])
      .filter(
        ([, childSnapshot]) =>
          childSnapshot.type !== Ci.nsIPrefBranch.PREF_INVALID
      );
    const userPreferences = preferenceNames
      .map(prefName => [prefName, readPreference(userBranch, prefName, true)])
      .filter(
        ([, userSnapshot]) =>
          userSnapshot.type !== Ci.nsIPrefBranch.PREF_INVALID
      );

    // deleteBranch clears both branches and all descendants. Restore users
    // first so defaults with equal values do not collapse their user state.
    branch.deleteBranch(name);
    for (const [prefName, userSnapshot] of userPreferences) {
      restorePreference(userBranch, prefName, userSnapshot, true);
    }
    for (const [child, childSnapshot] of defaultDescendants) {
      restorePreference(branch, child, childSnapshot);
    }
  } else if (snapshot.type === Ci.nsIPrefBranch.PREF_BOOL) {
    branch.setBoolPref(name, snapshot.value);
  } else if (snapshot.type === Ci.nsIPrefBranch.PREF_INT) {
    branch.setIntPref(name, snapshot.value);
  } else if (snapshot.localized) {
    const value = Cc["@mozilla.org/pref-localizedstring;1"].createInstance(
      Ci.nsIPrefLocalizedString
    );
    value.data = snapshot.value;
    branch.setComplexValue(name, Ci.nsIPrefLocalizedString, value);
  } else {
    branch.setStringPref(name, snapshot.value);
  }
}

async function readUnpackedPreferenceFiles(root) {
  const prefDirectory = root.clone();
  prefDirectory.append("defaults");
  prefDirectory.append("preferences");
  if (!prefDirectory.exists() || !prefDirectory.isDirectory()) {
    return [];
  }

  const files = [];
  const entries = prefDirectory.directoryEntries;
  try {
    for (const file of fixIterator(entries, Ci.nsIFile)) {
      if (file.isFile() && file.leafName.toLowerCase().endsWith(".js")) {
        files.push(file);
      }
    }
  } finally {
    try {
      entries.close();
    } catch {}
  }

  files.sort((left, right) => sortDescending(left.leafName, right.leafName));
  const preferenceFiles = [];
  for (const file of files) {
    preferenceFiles.push({
      source: file.path,
      data: await IOUtils.readUTF8(file.path),
    });
  }
  return preferenceFiles;
}

function readPackedPreferenceFiles(root) {
  const zipReader = Cc["@mozilla.org/libjar/zip-reader;1"].createInstance(
    Ci.nsIZipReader
  );
  let isOpen = false;
  try {
    zipReader.open(root);
    isOpen = true;

    const entryNames = [];
    const entries = zipReader.findEntries(`${PREF_DIRECTORY}*`);
    while (entries.hasMore()) {
      const entryName = entries.getNext();
      const relativeName = entryName.slice(PREF_DIRECTORY.length);
      if (
        entryName.startsWith(PREF_DIRECTORY) &&
        relativeName &&
        !relativeName.includes("/") &&
        relativeName.toLowerCase().endsWith(".js")
      ) {
        entryNames.push(entryName);
      }
    }
    entryNames.sort(sortDescending);

    const preferenceFiles = [];
    for (const entryName of entryNames) {
      const entry = zipReader.getEntry(entryName);
      if (entry.isDirectory) {
        continue;
      }

      let data = "";
      if (entry.realSize) {
        const stream = zipReader.getInputStream(entryName);
        try {
          data = NetUtil.readInputStreamToString(stream, entry.realSize, {
            charset: "utf-8",
            replacement:
              Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER,
          });
        } finally {
          try {
            stream.close();
          } catch {}
        }
      }
      preferenceFiles.push({
        source: `${root.path}!/${entryName}`,
        data,
      });
    }
    return preferenceFiles;
  } finally {
    if (isOpen) {
      zipReader.close();
    }
  }
}

function normalizeWindowHook(hook) {
  if (!hook || (typeof hook !== "object" && typeof hook !== "function")) {
    throw new TypeError("Window listener hooks must be objects");
  }

  const onLoadWindow = hook.onLoadWindow;
  const onUnloadWindow = hook.onUnloadWindow;
  if (
    (onLoadWindow != null && typeof onLoadWindow !== "function") ||
    (onUnloadWindow != null && typeof onUnloadWindow !== "function")
  ) {
    throw new TypeError("Window listener callbacks must be functions");
  }
  if (!onLoadWindow && !onUnloadWindow) {
    throw new TypeError("Window listeners must provide at least one callback");
  }

  let hasURLFilter = false;
  const urls = new Set();
  for (const property of WINDOW_URL_PROPERTIES) {
    if (!(property in hook)) {
      continue;
    }

    hasURLFilter = true;
    const configuredURLs = hook[property];
    let values = null;
    if (typeof configuredURLs === "string") {
      values = [configuredURLs];
    } else if (
      configuredURLs &&
      typeof configuredURLs[Symbol.iterator] === "function"
    ) {
      values = configuredURLs;
    }
    if (!values) {
      throw new TypeError(`${property} must be a string or an iterable`);
    }
    for (const url of values) {
      if (typeof url !== "string") {
        throw new TypeError(`${property} entries must be strings`);
      }
      urls.add(url);
    }
  }

  return {
    source: hook,
    onLoadWindow,
    onUnloadWindow,
    urls: hasURLFilter ? urls : null,
  };
}

function getWindowURL(window) {
  try {
    return window.document?.documentURI || window.location?.href || "";
  } catch {
    return "";
  }
}

function isTopLevelChromeWindow(window) {
  try {
    return (
      !window.closed &&
      window.top === window &&
      window.docShell?.itemType === Ci.nsIDocShellTreeItem.typeChrome
    );
  } catch {
    return false;
  }
}

function isWindowLoaded(window) {
  return (
    isTopLevelChromeWindow(window) &&
    window.document.readyState === "complete" &&
    getWindowURL(window) !== "about:blank"
  );
}

function resolveDOMWindow(value) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) {
    return null;
  }
  if (windowStates.has(value)) {
    return value;
  }
  if (appWindows.has(value)) {
    return appWindows.get(value);
  }

  try {
    if (value.docShell?.domWindow) {
      return value.docShell.domWindow;
    }
    if (value.window === value) {
      return value;
    }
  } catch {}
  return null;
}

function removeWindowEventListeners(state) {
  if (state.loadListener) {
    try {
      state.window.removeEventListener("load", state.loadListener, true);
    } catch {}
    state.loadListener = null;
  }
  if (state.unloadListener) {
    try {
      state.window.removeEventListener("unload", state.unloadListener);
    } catch {}
    state.unloadListener = null;
  }
}

async function runWindowCallbacks(state, eventType, id, removedHook = null) {
  if (eventType === "load") {
    if (state.closing || state.detached) {
      return;
    }

    const hooks = id
      ? [[id, extensionHooks.get(id)]]
      : [...extensionHooks.entries()];
    for (const [hookID, hook] of hooks) {
      if (
        state.closing ||
        state.detached ||
        !hook ||
        extensionHooks.get(hookID) !== hook ||
        state.loadedHooks.has(hookID) ||
        (hook.urls && !hook.urls.has(state.url))
      ) {
        continue;
      }

      state.loadedHooks.set(hookID, hook);
      if (!hook.onLoadWindow) {
        continue;
      }
      try {
        await hook.onLoadWindow.call(hook.source, state.window);
      } catch (error) {
        logger.error(
          `onLoadWindow failed for ${hookID} in ${state.url}`,
          error
        );
      }
    }
    return;
  }

  if (eventType !== "unload") {
    return;
  }

  const hooks = id
    ? [[id, removedHook ?? state.loadedHooks.get(id)]]
    : [...state.loadedHooks.entries()];
  for (const [hookID, hook] of hooks) {
    state.loadedHooks.delete(hookID);
    if (
      !hook ||
      (hook !== removedHook && extensionHooks.get(hookID) !== hook) ||
      !hook.onUnloadWindow
    ) {
      continue;
    }
    try {
      await hook.onUnloadWindow.call(hook.source, state.window);
    } catch (error) {
      logger.error(
        `onUnloadWindow failed for ${hookID} in ${state.url}`,
        error
      );
    }
  }
}

function queueWindowCallbacks(state, eventType, id, removedHook = null) {
  const task = () => runWindowCallbacks(state, eventType, id, removedHook);
  const pending = state.pendingCallbacks;
  let releaseQueue;
  const queuePlaceholder = new Promise(resolve => {
    releaseQueue = resolve;
  });
  state.pendingCallbacks = queuePlaceholder;

  const callbackPromise = pending ? pending.then(task) : task();
  const handledPromise = callbackPromise.catch(error => {
    logger.error(
      `Window ${eventType} notification failed for ${state.url}`,
      error
    );
  });
  if (state.pendingCallbacks === queuePlaceholder) {
    state.pendingCallbacks = handledPromise;
  }
  void handledPromise.then(() => {
    releaseQueue();
    if (state.pendingCallbacks === handledPromise) {
      state.pendingCallbacks = null;
    }
  });
  return handledPromise;
}

function activateWindow(state) {
  if (
    !listeningForWindows ||
    !extensionHooks.size ||
    state.ready ||
    state.closing ||
    state.detached ||
    !isWindowLoaded(state.window)
  ) {
    return state.pendingCallbacks ?? Promise.resolve();
  }

  state.ready = true;
  state.url = getWindowURL(state.window);
  if (state.loadListener) {
    state.window.removeEventListener("load", state.loadListener, true);
    state.loadListener = null;
  }

  openWindowList?.add(state.window);
  state.unloadListener = () => {
    void ExtensionSupport.closeWindow(state.window);
  };
  state.window.addEventListener("unload", state.unloadListener, { once: true });
  return queueWindowCallbacks(state, "load");
}

function trackWindow(window, appWindow = null) {
  if (
    !listeningForWindows ||
    !extensionHooks.size ||
    !isTopLevelChromeWindow(window)
  ) {
    return null;
  }

  let state = windowStates.get(window);
  if (state) {
    if (appWindow && !state.appWindow) {
      state.appWindow = appWindow;
      appWindows.set(appWindow, window);
    }
    return state;
  }

  state = {
    window,
    appWindow,
    url: "",
    ready: false,
    closing: false,
    detached: false,
    loadedHooks: new Map(),
    loadListener: null,
    unloadListener: null,
    pendingCallbacks: null,
    closePromise: null,
  };
  windowStates.set(window, state);
  if (appWindow) {
    appWindows.set(appWindow, window);
  }

  if (isWindowLoaded(window)) {
    void activateWindow(state);
  } else {
    state.loadListener = event => {
      if (event.target !== window && event.target !== window.document) {
        return;
      }
      void activateWindow(state);
    };
    window.addEventListener("load", state.loadListener, true);
  }
  return state;
}

function startWindowListening() {
  if (listeningForWindows) {
    return;
  }

  openWindowList = new Set();
  Services.wm.addListener(ExtensionSupport._windowListener);
  listeningForWindows = true;
  for (const window of Services.wm.getEnumerator(null)) {
    if (!listeningForWindows || !extensionHooks.size) {
      break;
    }
    trackWindow(window);
  }
}

function stopWindowListening() {
  if (listeningForWindows) {
    try {
      Services.wm.removeListener(ExtensionSupport._windowListener);
    } catch {}
    listeningForWindows = false;
  }

  for (const state of windowStates.values()) {
    state.detached = true;
    removeWindowEventListeners(state);
    state.loadedHooks.clear();
    if (state.appWindow) {
      appWindows.delete(state.appWindow);
    }
  }
  windowStates.clear();
  openWindowList?.clear();
  openWindowList = undefined;
}

const loadedLegacyExtensions = {
  set(id, state) {
    legacyExtensions.set(id, state);
    return this;
  },

  get(id) {
    return legacyExtensions.get(id);
  },

  delete(id) {
    return legacyExtensions.delete(id);
  },

  has(id) {
    const state = legacyExtensions.get(id);
    return Boolean(
      state && !["install", "enable"].includes(state.pendingOperation)
    );
  },

  hasAnyState(id) {
    return legacyExtensions.has(id);
  },

  _maybeDelete(id, pendingOperation) {
    const state = legacyExtensions.get(id);
    if (
      !state ||
      !(
        (state.pendingOperation === "enable" &&
          pendingOperation === "disable") ||
        (state.pendingOperation === "install" &&
          pendingOperation === "uninstall")
      )
    ) {
      return;
    }

    legacyExtensions.delete(id);
    this.notifyObservers(state);
  },

  notifyObservers(state) {
    Services.obs.notifyObservers(
      { wrappedJSObject: state },
      "legacy-addon-status-changed"
    );
  },

  onDisabled(addon) {
    loadedLegacyExtensions._maybeDelete(addon.id, "disable");
  },

  onUninstalled(addon) {
    loadedLegacyExtensions._maybeDelete(addon.id, "uninstall");
  },
};

const shutdownObserver = {
  observe() {
    ExtensionSupport._shutdown();
  },
};

export const ExtensionSupport = {
  loadedBootstrapExtensions,
  loadedLegacyExtensions,

  async loadAddonPrefs(addonFile, { trackChanges = false } = {}) {
    if (!addonFile || typeof addonFile.clone !== "function") {
      throw new TypeError("loadAddonPrefs requires an nsIFile root");
    }

    const root = addonFile.clone();
    if (!root.exists()) {
      return null;
    }

    let preferenceFiles;
    if (root.isDirectory()) {
      preferenceFiles = await readUnpackedPreferenceFiles(root);
    } else if (root.isFile()) {
      preferenceFiles = readPackedPreferenceFiles(root);
    } else {
      return null;
    }
    if (!preferenceFiles.length) {
      return null;
    }

    const defaultBranch = Services.prefs.getDefaultBranch("");
    const userBranch = Services.prefs.getBranch("");
    const trackedPreferences = new Map();
    const preferenceOwner = {};
    const sandbox = new Cu.Sandbox(null, {
      sandboxName: `Default preferences for ${root.leafName}`,
    });
    const applyPreference = (useDefaultBranch, name, value) => {
      if (trackChanges && typeof name === "string" && name.endsWith(".")) {
        throw new TypeError("Tracked preference names must not end with a dot");
      }

      const branch = useDefaultBranch ? defaultBranch : userBranch;
      if (branch.prefIsLocked(name)) {
        return;
      }
      if (!trackChanges) {
        setPreference(useDefaultBranch, name, value);
        return;
      }

      const preferences = useDefaultBranch
        ? trackedDefaultPreferences
        : trackedUserPreferences;
      const trackingKey = `${useDefaultBranch ? "default" : "user"}\0${name}`;
      const userOnly = !useDefaultBranch;
      const current = readPreference(branch, name, userOnly);
      const previousPreference = preferences.get(name);
      const topOwner = previousPreference?.owners.at(-1);
      const replacePreference = Boolean(
        topOwner && !samePreference(current, topOwner.value)
      );
      const preference =
        !previousPreference || replacePreference
          ? { base: current, owners: [] }
          : previousPreference;

      let ownership = trackedPreferences.get(trackingKey);
      const ownerIndex = preference.owners.indexOf(ownership);
      if (!ownership || ownerIndex === -1) {
        ownership = {
          branch,
          name,
          owner: preferenceOwner,
          preferences,
          userOnly,
          value: null,
        };
      }

      setPreference(useDefaultBranch, name, value);
      let applied;
      try {
        applied = readPreference(branch, name, userOnly);
      } catch (error) {
        try {
          restorePreference(branch, name, current, userOnly);
        } catch (rollbackError) {
          logger.warn(
            `Unable to roll back legacy preference ${name}`,
            rollbackError
          );
        }
        throw error;
      }

      if (replacePreference) {
        previousPreference.owners.length = 0;
      }
      if (ownerIndex !== -1) {
        preference.owners.splice(ownerIndex, 1);
      }
      ownership.value = applied;
      preference.owners.push(ownership);
      preferences.set(name, preference);
      trackedPreferences.set(trackingKey, ownership);
    };
    const applyPreferenceSafely = (useDefaultBranch, name, value) => {
      try {
        applyPreference(useDefaultBranch, name, value);
      } catch (error) {
        logger.warn(`Unable to set legacy preference ${name}`, error);
      }
    };
    sandbox.pref = (name, value) => applyPreferenceSafely(true, name, value);
    sandbox.sticky_pref = sandbox.pref;
    sandbox.user_pref = (name, value) =>
      applyPreferenceSafely(false, name, value);
    try {
      for (const { source, data } of preferenceFiles) {
        try {
          Cu.evalInSandbox(data, sandbox);
        } catch (error) {
          logger.error(
            `Unable to load add-on preferences from ${source}`,
            error
          );
        }
      }
    } finally {
      Cu.nukeSandbox(sandbox);
    }

    if (!trackChanges) {
      return null;
    }

    let active = true;
    return {
      unregister() {
        if (!active) {
          return;
        }
        active = false;
        for (const ownership of [...trackedPreferences.values()].reverse()) {
          const { branch, name, preferences, userOnly } = ownership;
          try {
            const preference = preferences.get(name);
            if (!preference) {
              continue;
            }
            const ownerIndex = preference.owners.indexOf(ownership);
            if (ownerIndex === -1) {
              continue;
            }
            const wasTopOwner = ownerIndex === preference.owners.length - 1;
            preference.owners.splice(ownerIndex, 1);
            if (!preference.owners.length) {
              preferences.delete(name);
            }
            if (!wasTopOwner) {
              continue;
            }
            if (branch.prefIsLocked(name)) {
              preference.owners.length = 0;
              preferences.delete(name);
              logger.warn(
                `${userOnly ? "User" : "Default"} preference ${name} locked before legacy add-on shutdown`
              );
              continue;
            }
            if (
              !samePreference(
                readPreference(branch, name, userOnly),
                ownership.value
              )
            ) {
              preference.owners.length = 0;
              preferences.delete(name);
              logger.warn(
                `${userOnly ? "User" : "Default"} preference ${name} changed before legacy add-on shutdown`
              );
              continue;
            }
            const previous = preference.owners.length
              ? preference.owners.at(-1).value
              : preference.base;
            restorePreference(branch, name, previous, userOnly);
          } catch (error) {
            logger.warn(
              `Unable to restore ${userOnly ? "user" : "default"} preference ${name}`,
              error
            );
          }
        }
      },
    };
  },

  registerWindowListener(id, extensionHook) {
    if (typeof id !== "string" || !id) {
      logger.warn("No extension ID provided for the window listener");
      return false;
    }
    if (shuttingDown) {
      logger.warn(`Cannot register window listener ${id} during shutdown`);
      return false;
    }
    if (extensionHooks.has(id)) {
      logger.warn(`Window listener for extension ${id} is already registered`);
      return false;
    }

    let hook;
    try {
      hook = normalizeWindowHook(extensionHook);
    } catch (error) {
      logger.warn(`Invalid window listener for extension ${id}`, error);
      return false;
    }

    extensionHooks.set(id, hook);
    if (extensionHooks.size === 1) {
      try {
        startWindowListening();
      } catch (error) {
        extensionHooks.delete(id);
        stopWindowListening();
        logger.error(`Unable to start window listener for ${id}`, error);
        return false;
      }
    } else {
      for (const window of Services.wm.getEnumerator(null)) {
        const state = trackWindow(window);
        if (state?.ready) {
          void queueWindowCallbacks(state, "load", id);
        }
      }
    }
    return true;
  },

  unregisterWindowListener(id) {
    if (typeof id !== "string" || !id) {
      logger.warn("No extension ID provided for the window listener");
      return false;
    }
    const hook = extensionHooks.get(id);
    if (!hook) {
      logger.warn(`No window listener is registered for extension ${id}`);
      return false;
    }
    extensionHooks.delete(id);

    for (const state of windowStates.values()) {
      if (state.loadedHooks.get(id) !== hook) {
        continue;
      }
      state.loadedHooks.delete(id);
      if (hook.onUnloadWindow) {
        void queueWindowCallbacks(state, "unload", id, hook);
      }
    }
    if (!extensionHooks.size) {
      stopWindowListening();
    }
    return true;
  },

  get openWindows() {
    return openWindowList?.values() ?? [];
  },

  closeWindow(value) {
    const window = resolveDOMWindow(value);
    const state = window && windowStates.get(window);
    if (!state) {
      return Promise.resolve(false);
    }
    if (state.closePromise) {
      return state.closePromise;
    }

    state.closing = true;
    openWindowList?.delete(window);
    removeWindowEventListeners(state);

    let resolveClose;
    state.closePromise = new Promise(resolve => {
      resolveClose = resolve;
    });
    const callbacks = queueWindowCallbacks(state, "unload");
    void callbacks.then(() => {
      state.detached = true;
      state.loadedHooks.clear();
      if (windowStates.get(window) === state) {
        windowStates.delete(window);
      }
      if (state.appWindow) {
        appWindows.delete(state.appWindow);
      }
      resolveClose(true);
    });
    return state.closePromise;
  },

  _windowListener: {
    onOpenWindow(appWindow) {
      const window = resolveDOMWindow(appWindow);
      if (window) {
        trackWindow(window, appWindow);
      }
    },

    onCloseWindow(appWindow) {
      const window = resolveDOMWindow(appWindow);
      if (window) {
        void ExtensionSupport.closeWindow(window);
      }
    },
  },

  _waitForLoad(window) {
    return trackWindow(window);
  },

  _addToListAndNotify(window, id) {
    const state = trackWindow(window);
    if (!state) {
      return Promise.resolve();
    }
    if (state.ready && id) {
      return queueWindowCallbacks(state, "load", id);
    }
    return activateWindow(state);
  },

  _checkAndRunMatchingExtensions(window, eventType, id) {
    const state = windowStates.get(window);
    return state
      ? queueWindowCallbacks(state, eventType, id)
      : Promise.resolve();
  },

  get registeredWindowListenerCount() {
    return extensionHooks.size;
  },

  _shutdown() {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    extensionHooks.clear();
    stopWindowListening();
    loadedBootstrapExtensions.clear();
    legacyExtensions.clear();

    if (addonListenerRegistered) {
      AddonManagerAPI.removeAddonListener(loadedLegacyExtensions);
      addonListenerRegistered = false;
    }
    if (shutdownObserverRegistered) {
      Services.obs.removeObserver(shutdownObserver, SHUTDOWN_TOPIC);
      shutdownObserverRegistered = false;
    }
  },
};

AddonManagerAPI.addAddonListener(loadedLegacyExtensions);
addonListenerRegistered = true;
Services.obs.addObserver(shutdownObserver, SHUTDOWN_TOPIC);
shutdownObserverRegistered = true;
