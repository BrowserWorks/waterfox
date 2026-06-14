/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";
import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = XPCOMUtils.declareLazy({
  Schemas: "resource://gre/modules/Schemas.sys.mjs",
  WindowsRegistry: "resource://gre/modules/WindowsRegistry.sys.mjs",
});

const DASHED = AppConstants.platform === "linux";

// Supported native manifest types, with platform-specific slugs.
const TYPES = {
  stdio: DASHED ? "native-messaging-hosts" : "NativeMessagingHosts",
  storage: DASHED ? "managed-storage" : "ManagedStorage",
  pkcs11: DASHED ? "pkcs11-modules" : "PKCS11Modules",
};

const NATIVE_MANIFEST_SCHEMA =
  "chrome://extensions/content/schemas/native_manifest.json";

const REGPATH = "Software\\Mozilla";

const MOZILLA_DIR_NAME = "mozilla";
const DOT_MOZILLA_DIR_NAME = `.${MOZILLA_DIR_NAME}`;

/** @type {Record<string, Record<string, string>>} */
const COMPAT_DIR_NAMES = {
  linux: {
    ".waterfox": DOT_MOZILLA_DIR_NAME,
    waterfox: MOZILLA_DIR_NAME,
  },
  macosx: {
    Waterfox: "Mozilla",
  },
};

/**
 * @param {string[]} paths
 * @param {string | null} path
 */
function addUniquePath(paths, path) {
  if (path && !paths.includes(path)) {
    paths.push(path);
  }
}

/**
 * @param {string} path
 * @returns {string | null}
 */
function getCompatibilityPath(path) {
  let dirName =
    COMPAT_DIR_NAMES[AppConstants.platform]?.[PathUtils.filename(path)];
  let parent = PathUtils.parent(path);
  return dirName && parent ? PathUtils.join(parent, dirName) : null;
}

/**
 * @returns {string[]}
 */
function getNativeManifestDirs() {
  /** @type {string[]} */
  let dirs = [];
  for (let property of ["XREUserNativeManifests", "XRESysNativeManifests"]) {
    let path = Services.dirsvc.get(property, Ci.nsIFile).path;
    addUniquePath(dirs, path);
    addUniquePath(dirs, getCompatibilityPath(path));
  }
  return dirs;
}

export var NativeManifests = {
  _initializePromise: null,
  _lookup: null,

  init() {
    if (!this._initializePromise) {
      let platform = AppConstants.platform;
      if (platform == "win") {
        this._lookup = this._winLookup;
      } else if (platform == "macosx" || platform == "linux") {
        let dirs = getNativeManifestDirs();
        this._lookup = (type, name, context) =>
          this._tryPaths(type, name, dirs, context);
      } else {
        throw new Error(
          `Native manifests are not supported on ${AppConstants.platform}`
        );
      }
      this._initializePromise = lazy.Schemas.load(NATIVE_MANIFEST_SCHEMA);
    }
    return this._initializePromise;
  },

  async _winLookup(type, name, context) {
    const REGISTRY = Ci.nsIWindowsRegKey;
    let regPath = `${REGPATH}\\${TYPES[type]}\\${name}`;
    let path = lazy.WindowsRegistry.readRegKey(
      REGISTRY.ROOT_KEY_CURRENT_USER,
      regPath,
      "",
      REGISTRY.WOW64_64
    );
    if (!path) {
      path = lazy.WindowsRegistry.readRegKey(
        REGISTRY.ROOT_KEY_LOCAL_MACHINE,
        regPath,
        "",
        REGISTRY.WOW64_32
      );
    }
    if (!path) {
      path = lazy.WindowsRegistry.readRegKey(
        REGISTRY.ROOT_KEY_LOCAL_MACHINE,
        regPath,
        "",
        REGISTRY.WOW64_64
      );
    }
    if (!path) {
      return null;
    }
    if (typeof path !== "string") {
      Cu.reportError(
        `Native manifest registry entry ${regPath} must be a string path`
      );
      return null;
    }

    // Normalize in case the extension used / instead of \.
    path = path.replaceAll("/", "\\");

    let manifest = await this._tryPath(type, path, name, context, true);
    return manifest ? { path, manifest } : null;
  },

  /**
   * Parse a native manifest of the given type and name.
   *
   * @param {string} type The type, one of: "pkcs11", "stdio" or "storage".
   * @param {string} path The path to the manifest file.
   * @param {string} name The name of the application.
   * @param {object} context A context object as expected by Schemas.normalize.
   * @param {object} data The JSON object of the manifest.
   * @returns {Promise<object>} The contents of the validated manifest, or null if
   *                   the manifest is not valid.
   */
  async parseManifest(type, path, name, context, data) {
    await this.init();
    let manifest = data;
    let normalized = lazy.Schemas.normalize(
      manifest,
      "manifest.NativeManifest",
      context
    );
    if (normalized.error) {
      Cu.reportError(normalized.error);
      return null;
    }
    manifest = normalized.value;

    if (manifest.type !== type) {
      Cu.reportError(
        `Native manifest ${path} has type property ${manifest.type} (expected ${type})`
      );
      return null;
    }
    if (manifest.name !== name) {
      Cu.reportError(
        `Native manifest ${path} has name property ${manifest.name} (expected ${name})`
      );
      return null;
    }
    if (
      type === "stdio" &&
      AppConstants.platform != "win" &&
      !PathUtils.isAbsolute(manifest.path)
    ) {
      // manifest.path is defined for type "stdio" and "pkcs11".
      // stdio requires an absolute path on Linux and macOS,
      // pkcs11 also accepts relative paths.
      Cu.reportError(
        `Native manifest ${path} has relative path value ${manifest.path} (expected absolute path)`
      );
      return null;
    }
    if (
      manifest.allowed_extensions &&
      !manifest.allowed_extensions.includes(context.extension.id)
    ) {
      Cu.reportError(
        `This extension does not have permission to use native manifest ${path}`
      );
      return null;
    }

    return manifest;
  },

  async _tryPath(type, path, name, context, logIfNotFound) {
    let manifest;
    try {
      manifest = await IOUtils.readJSON(path);
    } catch (ex) {
      if (ex instanceof SyntaxError && ex.message.startsWith("JSON.parse:")) {
        Cu.reportError(`Error parsing native manifest ${path}: ${ex.message}`);
        return null;
      }
      if (DOMException.isInstance(ex) && ex.name == "NotFoundError") {
        if (logIfNotFound) {
          Cu.reportError(
            `Error reading native manifest file ${path}: file is referenced in the registry but does not exist`
          );
        }
        return null;
      }
      Cu.reportError(ex);
      return null;
    }
    manifest = await this.parseManifest(type, path, name, context, manifest);
    return manifest;
  },

  async _tryPaths(type, name, dirs, context) {
    for (let dir of dirs) {
      let path = PathUtils.join(dir, TYPES[type], `${name}.json`);
      let manifest = await this._tryPath(type, path, name, context, false);
      if (manifest) {
        return { path, manifest };
      }
    }
    return null;
  },

  /**
   * Search for a valid native manifest of the given type and name.
   * The directories searched and rules for manifest validation are all
   * detailed in the Native Manifests documentation.
   *
   * @param {string} type The type, one of: "pkcs11", "stdio" or "storage".
   * @param {string} name The name of the manifest to search for.
   * @param {object} context A context object as expected by Schemas.normalize.
   * @returns {object} The contents of the validated manifest, or null if
   *                   no valid manifest can be found for this type and name.
   */
  lookupManifest(type, name, context) {
    return this.init().then(() => this._lookup(type, name, context));
  },
};
