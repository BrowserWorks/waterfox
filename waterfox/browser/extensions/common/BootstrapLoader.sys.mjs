/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AddonManager as AddonManagerAPI,
  AddonManagerPrivate,
} from "resource://gre/modules/AddonManager.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonInternal: "resource://gre/modules/addons/XPIDatabase.sys.mjs",
  InstallRDF: "resource:///modules/RDFManifestConverter.sys.mjs",
  XPIExports: "resource://gre/modules/addons/XPIExports.sys.mjs",
});

const logger = console.createInstance({ prefix: "addons.bootstrap" });

const ID_PATTERN =
  /^(\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|[a-z0-9-._]*@[a-z0-9-._]+)$/i;
const METADATA_PROPERTIES = [
  "id",
  "version",
  "internalName",
  "updateURL",
  "optionsURL",
  "aboutURL",
  "iconURL",
];
const SINGLE_LOCALE_PROPERTIES = [
  "name",
  "description",
  "creator",
  "homepageURL",
];
const MULTI_LOCALE_PROPERTIES = [
  "developers",
  "translators",
  "contributors",
];
const SUPPORTED_OPTIONS_TYPES = new Set([
  AddonManagerAPI.OPTIONS_TYPE_TAB,
  AddonManagerAPI.OPTIONS_TYPE_INLINE_BROWSER,
]);
const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

function readLocale(source, isDefault, seenLocales) {
  const locale = {};
  if (!isDefault) {
    locale.locales = [];
    for (const value of source.locales ?? []) {
      const localeName = value.trim();
      if (!localeName || seenLocales.has(localeName)) {
        continue;
      }
      seenLocales.add(localeName);
      locale.locales.push(localeName);
    }

    if (!locale.locales.length) {
      return null;
    }
  }

  for (const property of [
    ...SINGLE_LOCALE_PROPERTIES,
    ...MULTI_LOCALE_PROPERTIES,
  ]) {
    if (hasOwn(source, property)) {
      locale[property] = source[property];
    }
  }

  return locale;
}

function normalizeOptionsType(value, addonId) {
  if (value == null) {
    return null;
  }

  const optionsType = Number(value);
  if (Number.isInteger(optionsType) && SUPPORTED_OPTIONS_TYPES.has(optionsType)) {
    return optionsType;
  }

  logger.warn(`Ignoring unsupported optionsType ${value} for ${addonId}`);
  return null;
}

async function loadChromeEntries(pkg) {
  if (!(await pkg.hasResource("chrome.manifest"))) {
    return [];
  }

  const entries = [];
  const skinEntries = [];
  const manifest = await pkg.readString("chrome.manifest");
  for (const manifestLine of manifest.split(/\r?\n/)) {
    const line = manifestLine.replace(/#.*/, "").trim();
    if (!line) {
      continue;
    }

    const entry = line.split(/\s+/);
    if (
      (entry[0] === "content" &&
        (entry.length === 3 ||
          (entry.length === 4 && entry[3] === "contentaccessible=yes"))) ||
      (entry[0] === "locale" && entry.length === 4) ||
      (entry[0] === "override" && entry.length === 3)
    ) {
      entries.push(entry);
    } else if (entry[0] === "skin" && entry.length === 4) {
      skinEntries.push(entry);
    } else {
      throw new Error(`Unsupported chrome.manifest entry: ${line}`);
    }
  }

  if (skinEntries.length) {
    const paths = [];
    await pkg.iterFiles(({ path, isDir }) => {
      if (!isDir) {
        paths.push(path);
      }
    });
    for (const [, packageName, , entryPath] of skinEntries) {
      const basePath = entryPath.endsWith("/") ? entryPath : `${entryPath}/`;
      for (const path of paths) {
        if (path.startsWith(basePath)) {
          entries.push([
            "override",
            `chrome://${packageName}/skin/${path.slice(basePath.length)}`,
            path,
          ]);
        }
      }
    }
  }

  return entries;
}

function getBootstrapMethod(sandbox, name, addonId) {
  let method = sandbox[name];
  if (typeof method !== "function") {
    try {
      method = Cu.evalInSandbox(name, sandbox);
    } catch {
      method = null;
    }
  }

  if (typeof method === "function") {
    return method;
  }

  return () => {
    logger.warn(`Add-on ${addonId} is missing bootstrap method ${name}`);
  };
}

export const BootstrapLoader = {
  name: "bootstrap",
  manifestFile: "install.rdf",

  async loadManifest(pkg) {
    let manifest;
    try {
      const manifestData = await pkg.readString(this.manifestFile);
      manifest = lazy.InstallRDF.loadFromString(manifestData).decode();
    } catch (error) {
      logger.error("Failed to parse install.rdf", error);
      throw new Error(`Invalid install.rdf: ${error.message}`);
    }

    const addon = new lazy.AddonInternal();
    for (const property of METADATA_PROPERTIES) {
      if (hasOwn(manifest, property) && manifest[property] != null) {
        addon[property] = manifest[property];
      }
    }

    const manifestType = manifest.type ?? "2";
    if (manifestType !== "2" && manifestType !== "extension") {
      throw new Error(`Unsupported install.rdf add-on type: ${manifestType}`);
    }
    addon.type = "extension";
    addon.manifestVersion = 2;

    if (!addon.id) {
      throw new Error("No ID in install manifest");
    }
    if (!ID_PATTERN.test(addon.id)) {
      throw new Error(`Illegal add-on ID ${addon.id}`);
    }
    if (!addon.version) {
      throw new Error("No version in install manifest");
    }
    if (manifest.bootstrap !== "true") {
      throw new Error("Non-restartless extensions are not supported");
    }
    if (!(await pkg.hasResource("bootstrap.js"))) {
      throw new Error("Restartless extension is missing bootstrap.js");
    }

    addon.strictCompatibility = manifest.strictCompatibility === "true";
    addon.optionsType = normalizeOptionsType(manifest.optionsType, addon.id);
    addon.defaultLocale = readLocale(manifest, true, new Set());

    const seenLocales = new Set();
    addon.locales = (manifest.localized ?? [])
      .map(locale => readLocale(locale, false, seenLocales))
      .filter(Boolean);

    const seenApplications = new Set();
    addon.targetApplications = (manifest.targetApplications ?? []).filter(
      targetApplication => {
        if (
          !targetApplication.id ||
          !targetApplication.minVersion ||
          !targetApplication.maxVersion ||
          seenApplications.has(targetApplication.id)
        ) {
          return false;
        }
        seenApplications.add(targetApplication.id);
        return true;
      }
    );

    addon.targetPlatforms = (manifest.targetPlatforms ?? []).map(value => {
      const [os, abi = null] = value.split("_", 2);
      return { os, abi };
    });
    addon.dependencies = Object.freeze([
      ...new Set((manifest.dependencies ?? []).filter(Boolean)),
    ]);
    addon.applyBackgroundUpdates = AddonManagerAPI.AUTOUPDATE_DEFAULT;
    addon.userPermissions = null;
    addon.startupData = { chromeEntries: await loadChromeEntries(pkg) };

    addon.icons = {};
    if (await pkg.hasResource("icon.png")) {
      addon.icons[32] = "icon.png";
      addon.icons[48] = "icon.png";
    }
    if (await pkg.hasResource("icon64.png")) {
      addon.icons[64] = "icon64.png";
    }

    return addon;
  },

  loadScope(addon) {
    const file = addon.file || addon.sourceBundle;
    if (!file) {
      throw new Error(`Cannot locate bootstrap extension ${addon.id}`);
    }

    const uri = lazy.XPIExports.XPIInternal.getURIForResourceInFile(
      file,
      "bootstrap.js"
    ).spec;
    const sandbox = new Cu.Sandbox(
      Services.scriptSecurityManager.getSystemPrincipal(),
      {
        sandboxName: uri,
        addonId: addon.id,
        wantGlobalProperties: ["ChromeUtils"],
        metadata: { addonID: addon.id, URI: uri },
      }
    );

    Object.assign(sandbox, AddonManagerPrivate.BOOTSTRAP_REASONS);
    ChromeUtils.defineLazyGetter(sandbox, "console", () =>
      console.createInstance({ prefix: `addon/${addon.id}` })
    );

    try {
      Services.scriptloader.loadSubScript(uri, sandbox);
    } catch (error) {
      Cu.nukeSandbox(sandbox);
      logger.error(`Error loading bootstrap.js for ${addon.id}`, error);
      throw new Error(
        `Failed to load bootstrap script for ${addon.id}: ${error.message}`
      );
    }

    const installMethod = getBootstrapMethod(sandbox, "install", addon.id);
    const uninstallMethod = getBootstrapMethod(sandbox, "uninstall", addon.id);
    const startupMethod = getBootstrapMethod(sandbox, "startup", addon.id);
    const shutdownMethod = getBootstrapMethod(sandbox, "shutdown", addon.id);
    const chromeEntries = addon.startupData?.chromeEntries ?? [];
    let chromeHandle = null;
    let sandboxDestroyed = false;

    function registerManifest() {
      if (!chromeHandle && chromeEntries.length) {
        const addonManagerStartup = Cc[
          "@mozilla.org/addons/addon-manager-startup;1"
        ].getService(Ci.amIAddonManagerStartup);
        const manifestURI =
          lazy.XPIExports.XPIInternal.getURIForResourceInFile(
            file,
            "chrome.manifest"
          );
        chromeHandle = addonManagerStartup.registerChrome(
          manifestURI,
          chromeEntries
        );
      }
    }

    function unregisterManifest() {
      if (chromeHandle) {
        chromeHandle.destruct();
        chromeHandle = null;
      }
    }

    function destroySandbox() {
      if (!sandboxDestroyed) {
        Cu.nukeSandbox(sandbox);
        sandboxDestroyed = true;
      }
    }

    return {
      install(...args) {
        try {
          return installMethod(...args);
        } catch (error) {
          destroySandbox();
          throw error;
        }
      },

      async uninstall(...args) {
        try {
          return await uninstallMethod(...args);
        } finally {
          unregisterManifest();
          destroySandbox();
          Services.obs.notifyObservers(null, "startupcache-invalidate");
        }
      },

      async startup(...args) {
        registerManifest();
        try {
          return await startupMethod(...args);
        } catch (error) {
          unregisterManifest();
          destroySandbox();
          throw error;
        }
      },

      async shutdown(data, reason) {
        const reasons = AddonManagerPrivate.BOOTSTRAP_REASONS;
        const uninstallFollows = [
          reasons.ADDON_UNINSTALL,
          reasons.ADDON_UPGRADE,
          reasons.ADDON_DOWNGRADE,
        ].includes(reason);
        try {
          return await shutdownMethod(data, reason);
        } finally {
          if (reason !== reasons.APP_SHUTDOWN) {
            unregisterManifest();
            if (!uninstallFollows) {
              destroySandbox();
            }
          }
        }
      },
    };
  },
};
