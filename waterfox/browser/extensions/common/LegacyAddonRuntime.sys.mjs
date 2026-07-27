/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { ExtensionSupport } from "resource:///modules/ExtensionSupport.sys.mjs";
import {
  LegacyChromeManifest,
  LegacyResourceSubstitutions,
} from "resource:///modules/LegacyChromeManifest.sys.mjs";
import { LegacyComponentRegistry } from "resource:///modules/LegacyComponentRegistry.sys.mjs";
import {
  LegacyStaticXULOverlayManager,
  LegacyXULOverlayManager,
} from "resource:///modules/LegacyXULOverlay.sys.mjs";

const STARTUP_CACHE_INVALIDATE = "startupcache-invalidate";
const addonManagerStartup = Cc[
  "@mozilla.org/addons/addon-manager-startup;1"
].getService(Ci.amIAddonManagerStartup);
const resourceProtocol = Services.io
  .getProtocolHandler("resource")
  .QueryInterface(Ci.nsIResProtocolHandler);
const appShutdownRuntimes = new Set();

export async function cleanupAppShutdownLegacyRuntimes() {
  const runtimes = [...appShutdownRuntimes];
  appShutdownRuntimes.clear();
  await Promise.all(runtimes.map(runtime => runtime.finalizeAppShutdown()));
}

function getAddonFile(addon, rootURI) {
  for (const property of ["file", "_sourceBundle", "sourceBundle"]) {
    let file;
    try {
      file = addon[property];
    } catch {}
    if (file) {
      if (typeof file.clone !== "function") {
        throw new TypeError(`${property} for ${addon.id} is not an nsIFile`);
      }
      return file.clone();
    }
  }

  let packageURI = rootURI;
  if (packageURI.schemeIs("resource")) {
    packageURI = Services.io.newURI(resourceProtocol.resolveURI(packageURI));
  }
  while (packageURI instanceof Ci.nsIJARURI) {
    packageURI = packageURI.JARFile;
  }
  if (packageURI instanceof Ci.nsIFileURL) {
    return packageURI.file.clone();
  }
  throw new Error(`Cannot locate legacy add-on ${addon.id}`);
}

function getAddonRootURI(addon) {
  let rootURI;
  try {
    rootURI = addon.resolvedRootURI;
  } catch {}
  rootURI ||= addon.rootURI;

  if (typeof rootURI === "string") {
    rootURI = Services.io.newURI(rootURI);
  } else if (!(rootURI instanceof Ci.nsIURI) && rootURI?.spec) {
    rootURI = Services.io.newURI(rootURI.spec);
  }
  if (!(rootURI instanceof Ci.nsIURI)) {
    throw new TypeError(
      `Cannot resolve root URI for legacy add-on ${addon.id}`
    );
  }
  if (!rootURI.spec.endsWith("/")) {
    rootURI = Services.io.newURI(`${rootURI.spec}/`);
  }
  return rootURI;
}

function hasChromeManifest(file, manifest) {
  if (file.isDirectory()) {
    const chromeManifest = file.clone();
    chromeManifest.append("chrome.manifest");
    return chromeManifest.exists() && chromeManifest.isFile();
  }

  try {
    manifest.package.resolveLocalFile("chrome.manifest");
    return true;
  } catch {
    return false;
  }
}

function getComponentManifest(manifest) {
  if (
    manifest.contractEntries.every(entry => entry.contractId || !entry.contract)
  ) {
    return manifest;
  }

  const componentManifest = Object.create(manifest);
  componentManifest.contractEntries = manifest.contractEntries.map(entry => ({
    ...entry,
    contractId: entry.contractId ?? entry.contract,
  }));
  return componentManifest;
}

export class LegacyAddonRuntime {
  constructor(addon, logger = null) {
    if (!addon?.id) {
      throw new TypeError("Legacy add-ons must include an id");
    }

    this.addon = addon;
    this.id = addon.id;
    this.rootURI = getAddonRootURI(addon);
    this.file = getAddonFile(addon, this.rootURI);
    this.logger =
      logger ?? console.createInstance({ prefix: `Legacy add-on ${this.id}` });

    this.manifest = null;
    this.chromeRegistration = null;
    this.resourceSubstitutions = null;
    this.componentRegistry = null;
    this.preferenceRegistration = null;
    this.overlayManager = null;
    this.startupCacheInvalidated = false;

    this._legacyStateRegistered = false;
    this._started = false;
    this._startPromise = null;
    this._stoppedForAppShutdown = false;
  }

  get started() {
    return this._started;
  }

  async start() {
    if (this._started) {
      return this;
    }
    if (this._stoppedForAppShutdown) {
      throw new Error(
        `Cannot restart legacy add-on ${this.id} after application shutdown`
      );
    }
    if (this._startPromise) {
      return this._startPromise;
    }

    this.startupCacheInvalidated = false;
    this._startPromise = this._start();
    try {
      await this._startPromise;
      return this;
    } finally {
      this._startPromise = null;
    }
  }

  async _start() {
    try {
      const manifest = new LegacyChromeManifest(
        { id: this.id, rootURI: this.rootURI },
        this.logger
      );

      if (hasChromeManifest(this.file, manifest)) {
        await manifest.parse();
        this.manifest = manifest;

        if (manifest.chromeEntries.length) {
          this.chromeRegistration = addonManagerStartup.registerChrome(
            manifest.manifestURI,
            manifest.chromeEntries
          );
        }

        this.resourceSubstitutions = new LegacyResourceSubstitutions(
          manifest.resourceEntries,
          this.logger
        );
        this.resourceSubstitutions.register();
      }

      this.preferenceRegistration = await ExtensionSupport.loadAddonPrefs(
        this.file,
        { trackChanges: true }
      );

      if (this.manifest) {
        this.componentRegistry = new LegacyComponentRegistry(
          getComponentManifest(this.manifest),
          this.logger
        );
        await this.componentRegistry.register();
        this.componentRegistry.notifyProfileAfterChange();

        const OverlayManager =
          this.addon.bootstrap === false
            ? LegacyStaticXULOverlayManager
            : LegacyXULOverlayManager;
        this.overlayManager = new OverlayManager(
          this.manifest,
          this.id,
          this.logger
        );
        await this.overlayManager.start();
      }

      this._started = true;
      if (this.addon.bootstrap === false) {
        ExtensionSupport.loadedLegacyExtensions.set(this.id, {
          id: this.id,
          pendingOperation: null,
          version: this.addon.version,
        });
        this._legacyStateRegistered = true;
      }
    } catch (error) {
      this.logger.error(`Failed to start legacy add-on ${this.id}`, error);
      await this._teardown({
        appShutdown: Services.startup.shuttingDown,
        invalidateStartupCache:
          Boolean(this.chromeRegistration) ||
          Boolean(this.resourceSubstitutions) ||
          Boolean(this.componentRegistry),
      });
      throw error;
    }
  }

  async stop(_reason) {
    if (this._startPromise) {
      try {
        await this._startPromise;
      } catch {
        return;
      }
    }
    if (!this._started) {
      return;
    }

    const appShutdown = Services.startup.shuttingDown;
    await this._teardown({
      appShutdown,
      invalidateStartupCache: !appShutdown,
    });
    this._stoppedForAppShutdown = appShutdown;
    if (appShutdown) {
      appShutdownRuntimes.add(this);
    }
  }

  async finalizeAppShutdown() {
    if (!this._stoppedForAppShutdown) {
      return;
    }
    this._stoppedForAppShutdown = false;
    await this._teardown({ appShutdown: false, invalidateStartupCache: true });
  }

  async _teardown({ appShutdown, invalidateStartupCache }) {
    if (appShutdown) {
      this._started = false;
      return;
    }

    appShutdownRuntimes.delete(this);

    if (this.overlayManager) {
      try {
        await this.overlayManager.stop();
      } catch (error) {
        this.logger.warn(
          `Unable to stop legacy overlays for ${this.id}`,
          error
        );
      }
      this.overlayManager = null;
    }

    if (this.componentRegistry) {
      try {
        this.componentRegistry.unregister();
      } catch (error) {
        this.logger.warn(
          `Unable to unregister legacy components for ${this.id}`,
          error
        );
      }
      this.componentRegistry = null;
    }

    if (this.preferenceRegistration) {
      try {
        this.preferenceRegistration.unregister();
      } catch (error) {
        this.logger.warn(
          `Unable to restore legacy preferences for ${this.id}`,
          error
        );
      }
      this.preferenceRegistration = null;
    }

    if (this.resourceSubstitutions) {
      try {
        this.resourceSubstitutions.unregister();
      } catch (error) {
        this.logger.warn(
          `Unable to unregister legacy resources for ${this.id}`,
          error
        );
      }
      this.resourceSubstitutions = null;
    }

    if (this.chromeRegistration) {
      try {
        this.chromeRegistration.destruct();
      } catch (error) {
        this.logger.warn(
          `Unable to unregister compatibility chrome for ${this.id}`,
          error
        );
      }
      this.chromeRegistration = null;
    }

    this.manifest = null;
    this._started = false;
    if (this._legacyStateRegistered) {
      ExtensionSupport.loadedLegacyExtensions.delete(this.id);
      this._legacyStateRegistered = false;
    }

    if (invalidateStartupCache) {
      this._invalidateStartupCache();
    }
  }

  _invalidateStartupCache() {
    try {
      Services.obs.notifyObservers(null, STARTUP_CACHE_INVALIDATE);
      this.startupCacheInvalidated = true;
    } catch (error) {
      this.logger.warn(
        `Unable to invalidate the startup cache for ${this.id}`,
        error
      );
    }
  }
}
