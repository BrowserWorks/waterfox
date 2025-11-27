/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddonManager } from "resource://gre/modules/AddonManager.sys.mjs";
import { Log } from "resource://gre/modules/Log.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AddonInternal: "resource://gre/modules/addons/XPIDatabase.sys.mjs",
  Blocklist: "resource://gre/modules/Blocklist.sys.mjs",
  ConsoleAPI: "resource://gre/modules/Console.sys.mjs",
  InstallRDF: "resource:///modules/RDFManifestConverter.sys.mjs",
  XPIExports: "resource://gre/modules/addons/XPIExports.sys.mjs",
});

Services.obs.addObserver((doc) => {
  if (
    doc.location.protocol + doc.location.pathname === "about:addons" ||
    doc.location.protocol + doc.location.pathname ===
      "chrome://mozapps/content/extensions/aboutaddons.html"
  ) {
    const win = doc.defaultView;
    const handleEvent_orig =
      win.customElements.get("addon-card").prototype.handleEvent;
    win.customElements.get("addon-card").prototype.handleEvent = function (e) {
      if (
        e.type === "click" &&
        e.target.getAttribute("action") === "preferences" &&
        this.addon.optionsType === AddonManager.OPTIONS_TYPE_DIALOG
      ) {
        const windows = Services.wm.getEnumerator(null);
        while (windows.hasMoreElements()) {
          const win2 = windows.getNext();
          if (win2.closed) {
            continue;
          }
          if (win2.document.documentURI === this.addon.optionsURL) {
            win2.focus();
            return;
          }
        }
        let features = "chrome,titlebar,toolbar,centerscreen";
        const instantApply = Services.prefs.getBoolPref(
          "browser.preferences.instantApply"
        );
        features += instantApply ? ",dialog=no" : "";
        win.docShell.rootTreeItem.domWindow.openDialog(
          this.addon.optionsURL,
          this.addon.id,
          features
        );
      } else {
        handleEvent_orig.apply(this, [e]);
      }
    };
    const update_orig = win.customElements.get("addon-options").prototype.update;
    win.customElements.get("addon-options").prototype.update = function (
      _card,
      addon
    ) {
      update_orig.apply(this, [_card, addon]);
      if (addon.optionsType === AddonManager.OPTIONS_TYPE_DIALOG) {
        this.querySelector('panel-item[action="preferences"]').hidden = false;
      }
    };
  }
}, "chrome-document-loaded");

ChromeUtils.defineLazyGetter(lazy, "BOOTSTRAP_REASONS", () => {
  return lazy.XPIExports.XPIProvider.BOOTSTRAP_REASONS;
});

const logger = Log.repository.getLogger("addons.bootstrap");

/**
 * Valid IDs fit this pattern.
 */
const gIDTest =
  /^(\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}|[a-z0-9-._]*@[a-z0-9-._]+)$/i;

// Properties that exist in the install manifest
const PROP_METADATA = [
  "id",
  "version",
  "type",
  "internalName",
  "updateURL",
  "optionsURL",
  "optionsType",
  "aboutURL",
  "iconURL",
];
const PROP_LOCALE_SINGLE = ["name", "description", "creator", "homepageURL"];
const PROP_LOCALE_MULTI = ["developers", "translators", "contributors"];

// Map new string type identifiers to old style nsIUpdateItem types.
// Retired values:
// 32 = multipackage xpi file
// 8 = locale
// 256 = apiextension
// 128 = experiment
// theme = 4
const TYPES = {
  extension: 2,
  dictionary: 64,
};

const VALID_OPTION_TYPES = [
  AddonManager.OPTIONS_TYPE_DIALOG,
  AddonManager.OPTIONS_TYPE_INLINE_BROWSER,
  AddonManager.OPTIONS_TYPE_TAB,
];

const COMPATIBLE_BY_DEFAULT_TYPES = {
  extension: true,
  dictionary: true,
};

const objectHasOwnProperty = Function.call.bind(Object.prototype.hasOwnProperty);

function isXPI(filename) {
  const ext = filename.slice(-4).toLowerCase();
  return ext === ".xpi" || ext === ".zip";
}

/**
 * Creates a jar: URI for a file inside a ZIP file.
 *
 * @param {nsIFile} aJarfile
 *        The ZIP file as an nsIFile
 * @param {string} aPath
 *        The path inside the ZIP file
 * @returns {nsIURI}
 *        An nsIURI for the file
 */
function buildJarURI(aJarfile, aPath) {
  let uri = Services.io.newFileURI(aJarfile);
  uri = `jar:${uri.spec}!/${aPath}`;
  return Services.io.newURI(uri);
}

/**
 * Gets an nsIURI for a file within another file, either a directory or an XPI
 * file. If aFile is a directory then this will return a file: URI, if it is an
 * XPI file then it will return a jar: URI.
 *
 * @param {nsIFile} aFile
 *        The file containing the resources, must be either a directory or an
 *        XPI file
 * @param {string} aPath
 *        The path to find the resource at, "/" separated. If aPath is empty
 *        then the uri to the root of the contained files will be returned
 * @returns {nsIURI}
 *        An nsIURI pointing at the resource
 */
 function getURIForResourceInFile(aFile, aPath) {
   if (!isXPI(aFile.leafName)) {
     const resource = aFile.clone();
     if (aPath) {
       for (const part of aPath.split("/")) {
         resource.append(part);
       }
     }

     return Services.io.newFileURI(resource);
   }

   return buildJarURI(aFile, aPath);
 }

export const BootstrapLoader = {
  name: "bootstrap",
  manifestFile: "install.rdf",
  async loadManifest(pkg) {
    /**
     * Reads locale properties from either the main install manifest root or
     * an em:localized section in the install manifest.
     *
     * @param {object} aSource
     *        The resource to read the properties from.
     * @param {boolean} isDefault
     *        True if the locale is to be read from the main install manifest
     *        root
     * @param {string[]} aSeenLocales
     *        An array of locale names already seen for this install manifest.
     *        Any locale names seen as a part of this function will be added to
     *        this array
     * @returns {object}
     *        an object containing the locale properties
     */
    function readLocale(aSource, isDefault, aSeenLocales) {
      const locale = {};
      if (!isDefault) {
        locale.locales = [];
        for (const localeName of aSource.locales || []) {
          if (!localeName?.trim()) {
            logger.warn("Ignoring empty locale in localized properties");
            continue;
          }
          if (aSeenLocales.includes(localeName)) {
            logger.warn("Ignoring duplicate locale in localized properties");
            continue;
          }
          aSeenLocales.push(localeName);
          locale.locales.push(localeName);
        }

        if (locale.locales.length === 0) {
          logger.warn("Ignoring localized properties with no listed locales");
          return null;
        }
      }

      for (const prop of [...PROP_LOCALE_SINGLE, ...PROP_LOCALE_MULTI]) {
        if (objectHasOwnProperty(aSource, prop)) {
          locale[prop] = aSource[prop];
        }
      }

      return locale;
    }

    let manifest;
    try {
      const manifestData = await pkg.readString("install.rdf");
      manifest = lazy.InstallRDF.loadFromString(manifestData).decode();
    } catch (e) {
      logger.error(`Failed to parse install.rdf for addon:`, e);
      throw new Error(`Invalid install.rdf format: ${e.message}`);
    }

    const addon = new lazy.AddonInternal();
    for (const prop of PROP_METADATA) {
      if (objectHasOwnProperty(manifest, prop) && manifest[prop] != null) {
        addon[prop] = manifest[prop];
      }
    }

    if (!addon.type || addon.type === null || addon.type === undefined) {
      addon.type = "extension";
    } else if (typeof addon.type === "number") {
      // Handle legacy numeric types
      const numericType = addon.type;
      addon.type = null;
      for (const name in TYPES) {
        if (TYPES[name] === numericType) {
          addon.type = name;
          break;
        }
      }
      if (!addon.type) {
        logger.info(`Unknown numeric type ${numericType}, defaulting to extension`);
        addon.type = "extension";
      }
    } else if (typeof addon.type === "string") {
      // Handle modern string types - verify it's a known type
      if (!(addon.type in TYPES)) {
        logger.info(`Unknown string type "${addon.type}", defaulting to extension`);
        addon.type = "extension";
      }
    } else {
      // Unknown type format
      logger.info(`Unknown type format for ${addon.type}, defaulting to extension`);
      addon.type = "extension";
    }

    if (!(addon.type in TYPES)) {
      throw new Error(`Install manifest specifies unknown type: ${addon.type}`);
    }

    if (!addon.id) {
      throw new Error("No ID in install manifest");
    }
    if (!gIDTest.test(addon.id)) {
      throw new Error(`Illegal add-on ID ${addon.id}`);
    }
    if (!addon.version) {
      throw new Error("No version in install manifest");
    }

    addon.strictCompatibility =
      !(addon.type in COMPATIBLE_BY_DEFAULT_TYPES) ||
      manifest.strictCompatibility === "true";

    // Only read these properties for extensions.
    if (addon.type === "extension") {
      if (manifest.bootstrap !== "true") {
        throw new Error("Non-restartless extensions no longer supported");
      }

      // Convert legacy numeric optionsType to string constants
      if (addon.optionsType) {
        try {
          let numericType = addon.optionsType;
          let originalType = addon.optionsType;
          
          // Convert string numbers to actual numbers
          if (typeof addon.optionsType === "string") {
            numericType = parseInt(addon.optionsType, 10);
          }
          
          if (typeof numericType === "number" && !isNaN(numericType)) {
            switch (numericType) {
              case 1:
                addon.optionsType = AddonManager.OPTIONS_TYPE_DIALOG;
                break;
              case 2:
                // Legacy inline type - no longer supported, remove it
                logger.warn(`Extension ${addon.id} uses unsupported optionsType 2 (inline), removing`);
                addon.optionsType = null;
                break;
              case 3:
                addon.optionsType = AddonManager.OPTIONS_TYPE_TAB;
                break;
              case 4:
                addon.optionsType = AddonManager.OPTIONS_TYPE_INLINE_BROWSER;
                break;
              default:
                logger.warn(`Extension ${addon.id} has unknown numeric optionsType ${numericType}, removing`);
                addon.optionsType = null;
                break;
            }
          }
          
          if (addon.optionsType && !VALID_OPTION_TYPES.includes(addon.optionsType)) {
            throw new Error(
              `Install manifest specifies unknown optionsType: ${addon.optionsType} (original: ${originalType})`
            );
          }
        } catch (e) {
          logger.error(`Failed to process optionsType for extension ${addon.id}:`, e);
          addon.optionsType = null;
        }
      }
    } else {
      // Convert legacy dictionaries into a format the WebExtension
      // dictionary loader can process.
      if (addon.type === "dictionary") {
        addon.loader = null;
        const dictionaries = {};
        await pkg.iterFiles(({ path }) => {
          const match = /^dictionaries\/([^/]+)\.dic$/.exec(path);
          if (match) {
            const lang = match[1].replace(/_/g, "-");
            dictionaries[lang] = match[0];
          }
        });
        addon.startupData = { dictionaries };
      }

      // Only extensions are allowed to provide an optionsURL, optionsType,
      // optionsBrowserStyle, or aboutURL. For all other types they are silently ignored
      addon.aboutURL = null;
      addon.optionsBrowserStyle = null;
      addon.optionsType = null;
      addon.optionsURL = null;
    }

    addon.defaultLocale = readLocale(manifest, true);

    const seenLocales = [];
    addon.locales = (manifest.localized || [])
      .map(localeData => readLocale(localeData, false, seenLocales))
      .filter(Boolean);

    const dependencies = new Set(manifest.dependencies);
    addon.dependencies = Object.freeze(Array.from(dependencies));

    const seenApplications = [];
    addon.targetApplications = (manifest.targetApplications || [])
      .filter(targetApp => {
        if (!targetApp?.id || !targetApp?.minVersion || !targetApp?.maxVersion) {
          logger.warn("Ignoring invalid targetApplication entry in install manifest");
          return false;
        }
        if (seenApplications.includes(targetApp.id)) {
          logger.warn(`Ignoring duplicate targetApplication entry for ${targetApp.id} in install manifest`);
          return false;
        }
        seenApplications.push(targetApp.id);
        return true;
      });

    // Note that we don't need to check for duplicate targetPlatform entries since
    // the RDF service coalesces them for us.
    addon.targetPlatforms = [];
    for (const targetPlatform of manifest.targetPlatforms || []) {
      const platform = {
        os: null,
        abi: null,
      };

      const pos = targetPlatform.indexOf("_");
      if (pos !== -1) {
        platform.os = targetPlatform.substring(0, pos);
        platform.abi = targetPlatform.substring(pos + 1);
      } else {
        platform.os = targetPlatform;
      }

      addon.targetPlatforms.push(platform);
    }

    addon.userDisabled = false;
    addon.softDisabled =
      addon.blocklistState === lazy.Blocklist.STATE_SOFTBLOCKED;
    addon.applyBackgroundUpdates = AddonManager.AUTOUPDATE_DEFAULT;

    addon.userPermissions = null;

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
    const file = addon.file || addon._sourceBundle;
    const uri = getURIForResourceInFile(file, "bootstrap.js").spec;
    const principal = Services.scriptSecurityManager.getSystemPrincipal();

    const sandbox = new Cu.Sandbox(principal, {
      sandboxName: uri,
      addonId: addon.id,
      wantGlobalProperties: ["ChromeUtils"],
      metadata: { addonID: addon.id, URI: uri },
    });

    try {
      Object.assign(sandbox, lazy.BOOTSTRAP_REASONS);

      ChromeUtils.defineLazyGetter(
        sandbox,
        "console",
        () => new lazy.ConsoleAPI({ consoleID: `addon/${addon.id}` })
      );

      Services.scriptloader.loadSubScript(uri, sandbox);
    } catch (e) {
      logger.error(`Error loading bootstrap.js for ${addon.id}:`, e);
      throw new Error(`Failed to load bootstrap script for ${addon.id}: ${e.message}`);
    }

    function findMethod(name) {
      if (sandbox.name) {
        return sandbox.name;
      }

      try {
        const method = Cu.evalInSandbox(name, sandbox);
        return method;
      } catch (_err) {}

      return () => {
        logger.warn(`Add-on ${addon.id} is missing bootstrap method ${name}`);
      };
    }

    const install = findMethod("install");
    const uninstall = findMethod("uninstall");
    const startup = findMethod("startup");
    const shutdown = findMethod("shutdown");

    return {
      install: (...args) => install(...args),

      uninstall(...args) {
        uninstall(...args);
        // Forget any cached files we might've had from this extension.
        Services.obs.notifyObservers(null, "startupcache-invalidate");
      },

      startup(...args) {
        if (addon.type === "extension") {
          logger.debug(`Registering manifest for ${file.path}\n`);
          Components.manager.addBootstrappedManifestLocation(file);
        }
        return startup(...args);
      },

      shutdown(data, reason) {
        try {
          return shutdown(data, reason);
        } finally {
          if (reason !== lazy.BOOTSTRAP_REASONS.APP_SHUTDOWN) {
            logger.debug(`Removing manifest for ${file.path}\n`);
            Components.manager.removeBootstrappedManifestLocation(file);
          }
        }
      },
    };
  },
};
