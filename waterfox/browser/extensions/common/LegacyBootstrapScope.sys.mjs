/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddonManagerPrivate } from "resource://gre/modules/AddonManager.sys.mjs";
import { ExtensionSupport } from "resource:///modules/ExtensionSupport.sys.mjs";
import { LegacyAddonRuntime } from "resource:///modules/LegacyAddonRuntime.sys.mjs";

const STARTUP_CACHE_INVALIDATE = "startupcache-invalidate";
const retainedBootstrapUpdates = new Map();
let providerGeneration = 0;

function getPackageGeneration(addon) {
  if (!addon?.id || !addon.location?.name || !addon.version) {
    return null;
  }
  return JSON.stringify([
    addon.location.name,
    addon.id,
    addon.version,
    addon.rootURI ?? null,
    addon.path ?? addon.file?.path ?? addon._sourceBundle?.path ?? null,
  ]);
}

function destroyRetainedUpdate(retained) {
  try {
    retained?.scope.destroy();
  } catch (error) {
    retained?.scope.logger?.warn?.(
      `Unable to destroy retained bootstrap scope for ${retained.scope.id}`,
      error
    );
  }
}

function clearRetainedBootstrapUpdates() {
  const retained = [...retainedBootstrapUpdates.values()];
  retainedBootstrapUpdates.clear();
  for (const update of retained) {
    destroyRetainedUpdate(update);
  }
}

function findRetainedBootstrapUpdate(addonId) {
  return [...retainedBootstrapUpdates.values()].find(
    retained => retained.id === addonId
  );
}

function takeRetainedBootstrapUpdate(owner, data, exactPackage = false) {
  const expectedPackageGeneration = exactPackage
    ? owner.packageGeneration
    : data?.oldPackageGeneration;
  const retained = expectedPackageGeneration
    ? retainedBootstrapUpdates.get(expectedPackageGeneration)
    : null;
  if (retained) {
    retainedBootstrapUpdates.delete(expectedPackageGeneration);
  }

  for (const [generation, stale] of retainedBootstrapUpdates) {
    if (stale.id === owner.id) {
      retainedBootstrapUpdates.delete(generation);
      destroyRetainedUpdate(stale);
    }
  }

  if (
    !retained ||
    retained.id !== owner.id ||
    retained.providerGeneration !== providerGeneration ||
    (data?.oldVersion && retained.version !== data.oldVersion)
  ) {
    destroyRetainedUpdate(retained);
    return null;
  }
  return retained;
}

export function beginLegacyBootstrapProviderGeneration(generation) {
  clearRetainedBootstrapUpdates();
  providerGeneration = generation;
}

export function endLegacyBootstrapProviderGeneration(generation) {
  if (generation === providerGeneration) {
    clearRetainedBootstrapUpdates();
  }
}

function createLogger(addonId) {
  return console.createInstance({ prefix: `Legacy add-on ${addonId}` });
}

function isUpdateReason(reason) {
  const reasons = AddonManagerPrivate.BOOTSTRAP_REASONS;
  return [reasons.ADDON_UPGRADE, reasons.ADDON_DOWNGRADE].includes(reason);
}

function getBootstrapMethod(sandbox, name) {
  let method;
  try {
    method = sandbox[name];
  } catch {}

  if (typeof method !== "function") {
    try {
      method = Cu.evalInSandbox(
        `typeof ${name} === "function" ? ${name} : undefined`,
        sandbox
      );
    } catch {}
  }
  return typeof method === "function" ? method : null;
}

// Legacy bootstrap scripts run in a system-principal sandbox.
export class LegacyBootstrapScriptScope {
  constructor(addon, logger = null) {
    if (!addon?.id) {
      throw new TypeError("Legacy bootstrap add-ons must include an id");
    }

    this.addon = addon;
    this.id = addon.id;
    this.fatalLifecycleErrors = true;
    this.logger = logger ?? createLogger(this.id);
    this.runtime = new LegacyAddonRuntime(addon, this.logger);
    this.scriptURI = Services.io.newURI(
      "bootstrap.js",
      null,
      this.runtime.rootURI
    ).spec;
    this.sandbox = null;
    this.methods = null;
    this.started = false;
    this.destroyed = false;
    this._startupCacheInvalidated = false;

    this._loadScript();
  }

  _loadScript() {
    const sandbox = new Cu.Sandbox(
      Services.scriptSecurityManager.getSystemPrincipal(),
      {
        sandboxName: this.scriptURI,
        addonId: this.id,
        freshCompartment: true,
        wantGlobalProperties: ["ChromeUtils"],
        metadata: { addonID: this.id, URI: this.scriptURI },
      }
    );
    this.sandbox = sandbox;

    Object.assign(sandbox, AddonManagerPrivate.BOOTSTRAP_REASONS, {
      Services,
      __SCRIPT_URI_SPEC__: this.scriptURI,
    });
    ChromeUtils.defineLazyGetter(sandbox, "console", () =>
      console.createInstance({ prefix: `addon/${this.id}` })
    );

    try {
      Services.scriptloader.loadSubScript(this.scriptURI, sandbox, "UTF-8");
      this.methods = Object.fromEntries(
        ["install", "startup", "shutdown", "uninstall"].map(name => [
          name,
          getBootstrapMethod(sandbox, name),
        ])
      );
    } catch (error) {
      this._destroySandbox();
      this.logger.error(`Unable to load bootstrap.js for ${this.id}`, error);
      throw new Error(
        `Failed to load bootstrap script for ${this.id}: ${error.message}`,
        { cause: error }
      );
    }
  }

  async install(data, reason) {
    this._ensureLive();
    try {
      return await this._call("install", data, reason);
    } catch (error) {
      this._destroySandbox();
      throw error;
    }
  }

  async startup(data, reason) {
    this._ensureLive();
    this._startupCacheInvalidated = false;
    await this.runtime.start();

    try {
      const result = await this._call("startup", data, reason);
      this.started = true;
      ExtensionSupport.loadedBootstrapExtensions.add(this.id);
      return result;
    } catch (error) {
      this.started = false;
      await this._stopRuntime(reason);
      throw error;
    }
  }

  async shutdown(data, reason) {
    if (this.destroyed) {
      return undefined;
    }

    try {
      return await this._call("shutdown", data, reason);
    } finally {
      this.started = false;
      ExtensionSupport.loadedBootstrapExtensions.delete(this.id);
      await this._stopRuntime(reason);
    }
  }

  async uninstall(data, reason) {
    if (this.destroyed) {
      return undefined;
    }

    try {
      return await this._call("uninstall", data, reason);
    } finally {
      this.started = false;
      ExtensionSupport.loadedBootstrapExtensions.delete(this.id);
      await this._stopRuntime(reason);
      this._destroySandboxAndInvalidate();
    }
  }

  destroy() {
    if (!this.started) {
      ExtensionSupport.loadedBootstrapExtensions.delete(this.id);
      this._destroySandbox();
    }
  }

  async _call(name, data, reason) {
    const method = this.methods[name];
    if (!method) {
      this.logger.warn(`Add-on ${this.id} is missing bootstrap method ${name}`);
      return undefined;
    }
    return Reflect.apply(method, this.sandbox, [data, reason]);
  }

  async _stopRuntime(reason) {
    await this.runtime.stop(reason);
    this._startupCacheInvalidated ||= this.runtime.startupCacheInvalidated;
  }

  _ensureLive() {
    if (this.destroyed) {
      throw new Error(`Bootstrap scope for ${this.id} has been destroyed`);
    }
  }

  _destroySandboxAndInvalidate() {
    this._destroySandbox();
    if (!this._startupCacheInvalidated) {
      try {
        Services.obs.notifyObservers(null, STARTUP_CACHE_INVALIDATE);
        this._startupCacheInvalidated = true;
      } catch (error) {
        this.logger.warn(
          `Unable to invalidate the startup cache for ${this.id}`,
          error
        );
      }
    }
  }

  _destroySandbox() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    if (this.sandbox && !Cu.isDeadWrapper(this.sandbox)) {
      try {
        Cu.nukeSandbox(this.sandbox);
      } catch (error) {
        this.logger.warn(
          `Unable to destroy bootstrap scope for ${this.id}`,
          error
        );
      }
    }
    this.sandbox = null;
    this.methods = null;
  }
}

class LegacyWebExtensionScope {
  constructor(addon, genericScope) {
    if (!addon?.id) {
      throw new TypeError("Legacy WebExtensions must include an id");
    }
    if (!genericScope || typeof genericScope !== "object") {
      throw new TypeError("A generic WebExtension scope is required");
    }

    const legacyMode = addon.startupData?.legacyMode;
    if (!new Set(["bootstrap", "xul"]).has(legacyMode)) {
      throw new Error(`Unknown legacy mode for ${addon.id}: ${legacyMode}`);
    }

    this.addon = addon;
    this.id = addon.id;
    this.packageGeneration = getPackageGeneration(addon);
    this.isBootstrap = legacyMode === "bootstrap";
    this.genericScope = genericScope;
    this.fatalLifecycleErrors = true;
    this.logger = createLogger(this.id);
    this.legacyScope = this.isBootstrap
      ? new LegacyBootstrapScriptScope(addon, this.logger)
      : new LegacyAddonRuntime(addon, this.logger);
  }

  fetchState() {
    return this._callGeneric("fetchState");
  }

  async install(data, reason) {
    if (this.isBootstrap) {
      await this.legacyScope.install(data, reason);
    }
    return this._callGeneric("install", data, reason);
  }

  async startup(data, reason) {
    const disableReason = AddonManagerPrivate.BOOTSTRAP_REASONS.ADDON_DISABLE;
    if (this.isBootstrap) {
      await this.legacyScope.startup(data, reason);
      try {
        return await this._callGeneric("startup", data, reason);
      } catch (error) {
        try {
          await this.legacyScope.shutdown(data, disableReason);
        } catch (cleanupError) {
          this.logger.warn(
            `Unable to roll back legacy startup for ${this.id}`,
            cleanupError
          );
        }
        throw error;
      }
    }

    const result = await this._callGeneric("startup", data, reason);
    try {
      await this.legacyScope.start();
      return result;
    } catch (error) {
      try {
        await this._callGeneric("shutdown", data, disableReason);
      } catch (cleanupError) {
        this.logger.warn(
          `Unable to roll back WebExtension startup for ${this.id}`,
          cleanupError
        );
      }
      throw error;
    }
  }

  async shutdown(data, reason) {
    let result;
    let genericError;
    let legacyError;

    try {
      result = await this._callGeneric("shutdown", data, reason);
    } catch (error) {
      genericError = error;
    } finally {
      try {
        if (this.isBootstrap) {
          await this.legacyScope.shutdown(data, reason);
        } else {
          await this.legacyScope.stop(reason);
        }
      } catch (error) {
        legacyError = error;
      }
    }

    if (
      this.isBootstrap &&
      isUpdateReason(reason) &&
      !genericError &&
      !legacyError
    ) {
      await this._retainBootstrapUpdate(data, reason);
    }

    if (genericError) {
      if (legacyError) {
        this.logger.warn(
          `Legacy shutdown also failed for ${this.id}`,
          legacyError
        );
      }
      throw genericError;
    }
    if (legacyError) {
      throw legacyError;
    }
    return result;
  }

  async uninstall(data, reason) {
    let legacyError;
    const retained = takeRetainedBootstrapUpdate(this, data, true);

    if (this.isBootstrap) {
      const scope = retained?.scope ?? this.legacyScope;
      const uninstallData = retained?.data ?? data;
      try {
        await scope.uninstall(uninstallData, reason);
      } catch (error) {
        legacyError = error;
      }
    }

    const result = await this._callGeneric("uninstall", data, reason);
    if (legacyError) {
      throw legacyError;
    }
    return result;
  }

  async prepareUpdate(data, reason) {
    const retained = takeRetainedBootstrapUpdate(this, data, true);
    if (this.isBootstrap) {
      await (retained?.scope ?? this.legacyScope).uninstall(data, reason);
    }
  }

  async update(data, reason) {
    const retained = takeRetainedBootstrapUpdate(this, data);
    let legacyError;
    let genericError;
    let result;

    if (retained) {
      const oldData = {
        ...retained.data,
        oldVersion: retained.data.oldVersion ?? retained.scope.addon.version,
        newVersion: data.newVersion ?? data.version,
      };
      try {
        await retained.scope.uninstall(oldData, reason);
      } catch (error) {
        legacyError = error;
      }
    }

    try {
      result = await this._callGeneric("update", data, reason);
    } catch (error) {
      genericError = error;
    }

    if (this.isBootstrap) {
      const newData = {
        ...data,
        oldVersion: data.oldVersion ?? retained?.scope.addon.version,
        newVersion: data.newVersion ?? data.version,
      };
      try {
        await this.legacyScope.install(newData, reason);
      } catch (error) {
        legacyError ??= error;
      }
    }

    if (genericError) {
      if (legacyError) {
        this.logger.warn(
          `Legacy update also failed for ${this.id}`,
          legacyError
        );
      }
      throw genericError;
    }
    if (legacyError) {
      throw legacyError;
    }
    return result;
  }

  destroy() {
    const retained = retainedBootstrapUpdates.get(this.packageGeneration);
    if (
      this.isBootstrap &&
      (retained?.scope !== this.legacyScope ||
        retained.providerGeneration !== providerGeneration ||
        retained.packageGeneration !== this.packageGeneration)
    ) {
      this.legacyScope.destroy();
    }
  }

  _callGeneric(name, ...args) {
    const method = this.genericScope[name];
    if (typeof method !== "function") {
      return undefined;
    }
    return Reflect.apply(method, this.genericScope, args);
  }

  async _retainBootstrapUpdate(data, reason) {
    const retained = findRetainedBootstrapUpdate(this.id);
    if (retained && retained.scope !== this.legacyScope) {
      retainedBootstrapUpdates.delete(retained.packageGeneration);
      this.logger.warn(
        `Replacing an unfinished legacy bootstrap update for ${this.id}`
      );
      try {
        await retained.scope.uninstall(retained.data, retained.reason);
      } catch (error) {
        this.logger.warn(
          `Unable to finalize the previous bootstrap scope for ${this.id}`,
          error
        );
      }
    }

    retainedBootstrapUpdates.set(this.packageGeneration, {
      id: this.id,
      providerGeneration,
      packageGeneration: this.packageGeneration,
      version: this.addon.version,
      scope: this.legacyScope,
      data: { ...data },
      reason,
    });
  }
}

export function createLegacyWebExtensionScope(addon, genericScope) {
  return new LegacyWebExtensionScope(addon, genericScope);
}
