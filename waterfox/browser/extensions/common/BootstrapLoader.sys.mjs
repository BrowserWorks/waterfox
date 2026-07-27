/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddonManager as AddonManagerAPI } from "resource://gre/modules/AddonManager.sys.mjs";
import { XPIExports } from "resource://gre/modules/addons/XPIExports.sys.mjs";
import {
  cleanupAppShutdownLegacyRuntimes,
  LegacyAddonRuntime,
} from "resource:///modules/LegacyAddonRuntime.sys.mjs";
import {
  beginLegacyBootstrapProviderGeneration,
  createLegacyWebExtensionScope,
  endLegacyBootstrapProviderGeneration,
  LegacyBootstrapScriptScope,
} from "resource:///modules/LegacyBootstrapScope.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  InstallRDF: "resource:///modules/RDFManifestConverter.sys.mjs",
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
const MULTI_LOCALE_PROPERTIES = ["developers", "translators", "contributors"];
const SUPPORTED_OPTIONS_TYPES = new Set([
  AddonManagerAPI.OPTIONS_TYPE_DIALOG,
  AddonManagerAPI.OPTIONS_TYPE_TAB,
  AddonManagerAPI.OPTIONS_TYPE_INLINE_BROWSER,
]);
const INSTALL_RDF_TYPES = new Map([
  [2, "extension"],
  ["2", "extension"],
  ["extension", "extension"],
  [64, "dictionary"],
  ["64", "dictionary"],
  ["dictionary", "dictionary"],
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
  if (optionsType === 4) {
    return AddonManagerAPI.OPTIONS_TYPE_INLINE_BROWSER;
  }
  if (
    Number.isInteger(optionsType) &&
    SUPPORTED_OPTIONS_TYPES.has(optionsType)
  ) {
    return optionsType;
  }

  logger.warn(`Ignoring unsupported optionsType ${value} for ${addonId}`);
  return null;
}

function readTargetPlatform(value) {
  const platform = String(value);
  const separator = platform.indexOf("_");
  if (separator === -1) {
    return { os: platform, abi: null };
  }
  return {
    os: platform.slice(0, separator),
    abi: platform.slice(separator + 1) || null,
  };
}

async function readIcons(pkg) {
  const icons = {};
  if (await pkg.hasResource("icon.png")) {
    icons[32] = "icon.png";
    icons[48] = "icon.png";
  }
  if (await pkg.hasResource("icon64.png")) {
    icons[64] = "icon64.png";
  }
  return icons;
}

async function readDictionaries(pkg) {
  const dictionaries = {};
  await pkg.iterFiles(({ path, isDir }) => {
    if (isDir) {
      return;
    }
    const match = /^dictionaries\/([^/]+)\.dic$/.exec(path);
    if (match) {
      dictionaries[match[1].replaceAll("_", "-")] = path;
    }
  });
  return dictionaries;
}

export const BootstrapLoader = {
  name: "bootstrap",
  manifestFile: "install.rdf",

  onProviderStartup(generation) {
    beginLegacyBootstrapProviderGeneration(generation);
    return cleanupAppShutdownLegacyRuntimes();
  },

  onProviderShutdown(generation) {
    endLegacyBootstrapProviderGeneration(generation);
  },

  async loadManifest(pkg) {
    let manifest;
    try {
      const manifestData = await pkg.readString(this.manifestFile);
      manifest = lazy.InstallRDF.loadFromString(manifestData).decode();
    } catch (error) {
      logger.error("Failed to parse install.rdf", error);
      throw new Error(`Invalid install.rdf: ${error.message}`);
    }

    const addon = new XPIExports.AddonInternal();
    for (const property of METADATA_PROPERTIES) {
      if (hasOwn(manifest, property) && manifest[property] != null) {
        addon[property] = manifest[property];
      }
    }

    const manifestType = manifest.type ?? "2";
    addon.type = INSTALL_RDF_TYPES.get(manifestType);
    if (!addon.type) {
      throw new Error(`Unsupported install.rdf add-on type: ${manifestType}`);
    }
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

    addon.targetPlatforms = (manifest.targetPlatforms ?? [])
      .filter(Boolean)
      .map(readTargetPlatform);
    addon.dependencies = Object.freeze([
      ...new Set((manifest.dependencies ?? []).filter(Boolean)),
    ]);
    addon.applyBackgroundUpdates = AddonManagerAPI.AUTOUPDATE_DEFAULT;
    addon.userPermissions = null;
    addon.icons = await readIcons(pkg);

    if (addon.type === "extension") {
      addon.bootstrap = manifest.bootstrap === "true";
      addon.unpack = manifest.unpack === "true";
      if (addon.bootstrap && !(await pkg.hasResource("bootstrap.js"))) {
        throw new Error("Restartless extension is missing bootstrap.js");
      }
      addon.startupData = {
        legacyMode: addon.bootstrap ? "bootstrap" : "xul",
        legacyManifest: "rdf",
      };
    } else {
      addon.loader = null;
      addon.optionsURL = null;
      addon.optionsType = null;
      addon.aboutURL = null;
      addon.startupData = { dictionaries: await readDictionaries(pkg) };
    }

    return addon;
  },

  wrapWebExtensionScope(addon, genericScope) {
    return createLegacyWebExtensionScope(addon, genericScope);
  },

  loadScope(addon) {
    switch (addon.startupData?.legacyMode) {
      case "bootstrap":
        return new LegacyBootstrapScriptScope(addon);
      case "xul": {
        const runtime = new LegacyAddonRuntime(addon);
        return {
          install() {},
          uninstall() {},
          startup() {
            return runtime.start();
          },
          shutdown(_data, reason) {
            return runtime.stop(reason);
          },
        };
      }
      default:
        throw new Error(
          `Unsupported legacy mode ${addon.startupData?.legacyMode}`
        );
    }
  },
};
