/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AddonManagerPrivate } from "resource://gre/modules/AddonManager.sys.mjs";
import { ExtensionSupport } from "resource:///modules/ExtensionSupport.sys.mjs";
import { LegacyAddonRuntime } from "resource:///modules/LegacyAddonRuntime.sys.mjs";

const STARTUP_CACHE_INVALIDATE = "startupcache-invalidate";

function createLogger(addonId) {
  return console.createInstance({ prefix: `Legacy add-on ${addonId}` });
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
