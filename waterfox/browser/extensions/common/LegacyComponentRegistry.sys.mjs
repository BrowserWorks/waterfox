/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const componentManager = Components.manager;
const registrar = componentManager.QueryInterface(Ci.nsIComponentRegistrar);
const systemPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
const PROFILE_AFTER_CHANGE = "profile-after-change";
const SERVICE_PREFIX = "service,";

const contractOwnershipStacks = new Map();
const categoryOwnershipStacks = new Map();
const pendingFactoryCleanups = new Set();
const legacyFactoryQI = ChromeUtils.generateQI(["nsIFactory"]);
let factoryCleanupTimer = null;

const tombstoneFactory = {
  createInstance() {
    throw Components.Exception("", Cr.NS_ERROR_FACTORY_NOT_REGISTERED);
  },
  QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
};

function normalizeCID(value, description) {
  try {
    return Components.ID(String(value));
  } catch (error) {
    throw new Error(`Malformed CID for ${description}: ${value}`, {
      cause: error,
    });
  }
}

function cidKey(cid) {
  return cid.toString().toLowerCase();
}

function sameCID(left, right) {
  return left?.equals(right) ?? false;
}

function categoryKey(category, entry) {
  return `${category}\0${entry}`;
}

function moveToTop(stack, record) {
  const index = stack.indexOf(record);
  if (index !== -1) {
    stack.splice(index, 1);
  }
  stack.push(record);
}

function getContractCID(contractId) {
  try {
    return registrar.contractIDToCID(contractId);
  } catch (error) {
    if (error.result === Cr.NS_ERROR_FACTORY_NOT_REGISTERED) {
      return null;
    }
    throw error;
  }
}

function getCategoryEntry(category, entry) {
  try {
    return {
      exists: true,
      value: Services.catMan.getCategoryEntry(category, entry),
    };
  } catch (error) {
    if (error.result === Cr.NS_ERROR_NOT_AVAILABLE) {
      return { exists: false, value: null };
    }
    throw error;
  }
}

function getReferencedContractCIDs() {
  const referencedCIDs = new Set();

  for (const ownership of contractOwnershipStacks.values()) {
    if (ownership.baseCID) {
      referencedCIDs.add(cidKey(ownership.baseCID));
    }
    for (const owner of ownership.stack) {
      referencedCIDs.add(cidKey(owner.cid));
    }
  }

  for (const contractId of registrar.getContractIDs()) {
    const cid = getContractCID(contractId);
    if (cid) {
      referencedCIDs.add(cidKey(cid));
    }
  }

  return referencedCIDs;
}

function warnForCleanup(cleanup, message, error) {
  if (error === undefined) {
    cleanup.logger?.warn?.(message);
  } else {
    cleanup.logger?.warn?.(message, error);
  }
}

function scheduleFactoryCleanup() {
  if (
    factoryCleanupTimer ||
    !pendingFactoryCleanups.size ||
    Services.startup.shuttingDown
  ) {
    return;
  }

  factoryCleanupTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  factoryCleanupTimer.initWithCallback(
    () => {
      factoryCleanupTimer = null;
      unregisterUnusedFactories();
    },
    100,
    Ci.nsITimer.TYPE_ONE_SHOT
  );
}

function unregisterUnusedFactories() {
  if (!pendingFactoryCleanups.size) {
    factoryCleanupTimer?.cancel();
    factoryCleanupTimer = null;
    return;
  }

  let referencedCIDs;
  try {
    referencedCIDs = getReferencedContractCIDs();
  } catch (error) {
    const [cleanup] = pendingFactoryCleanups;
    warnForCleanup(
      cleanup,
      "Unable to inspect legacy component contract mappings",
      error
    );
    return;
  }

  for (const cleanup of pendingFactoryCleanups) {
    for (let index = cleanup.factories.length - 1; index >= 0; index--) {
      const { cid, factory } = cleanup.factories[index];
      if (referencedCIDs.has(cidKey(cid))) {
        continue;
      }

      try {
        registrar.unregisterFactory(cid, factory);
      } catch (error) {
        warnForCleanup(
          cleanup,
          `Unable to unregister legacy component factory ${cid}`,
          error
        );
        if (error.result !== Cr.NS_ERROR_FACTORY_NOT_REGISTERED) {
          continue;
        }
      }
      cleanup.factories.splice(index, 1);
    }

    if (cleanup.factories.length) {
      continue;
    }

    pendingFactoryCleanups.delete(cleanup);
  }

  scheduleFactoryCleanup();
}

function getComponentFile(uri) {
  while (uri instanceof Ci.nsIJARURI) {
    uri = uri.JARFile;
  }
  if (!(uri instanceof Ci.nsIFileURL)) {
    throw new Error(`Legacy component is not package-local: ${uri.spec}`);
  }
  return uri.file;
}

function requireString(value, description) {
  if (typeof value !== "string" || !value) {
    throw new Error(`Missing ${description}`);
  }
  return value;
}

function generateNSGetFactory(components) {
  const factories = new Map();

  for (const component of components) {
    const prototype = component.prototype;
    const classID = prototype?.classID;
    if (!(classID instanceof Components.ID)) {
      throw new Error(
        `classID missing or incorrect for legacy component ${component}`
      );
    }

    const factory = prototype._xpcom_factory ?? {
      createInstance(iid) {
        return new component().QueryInterface(iid);
      },
      QueryInterface: legacyFactoryQI,
    };
    factories.set(classID.toString(), factory);
  }

  return cid => {
    const factory = factories.get(cid.toString());
    if (!factory) {
      throw Components.Exception("", Cr.NS_ERROR_FACTORY_NOT_REGISTERED);
    }
    return factory;
  };
}

function loadComponentSubScript(uri, sandbox) {
  const factoryGenerator = XPCOMUtils.generateNSGetFactory;
  XPCOMUtils.generateNSGetFactory ??= generateNSGetFactory;
  try {
    Services.scriptloader.loadSubScript(uri.spec, sandbox, "UTF-8");
  } finally {
    if (factoryGenerator === undefined) {
      delete XPCOMUtils.generateNSGetFactory;
    } else {
      XPCOMUtils.generateNSGetFactory = factoryGenerator;
    }
  }
}

// Unload keeps component sandboxes alive for existing factories and instances.
// App shutdown retains all registrations.
export class LegacyComponentRegistry {
  constructor(manifest, logger) {
    this.manifest = manifest;
    this.logger = logger;
    this._registered = false;
    this._factories = [];
    this._contracts = [];
    this._contractsById = new Map();
    this._categories = [];
    this._categoriesByKey = new Map();
    this._sandboxes = [];
    this._modulesByURI = new Map();
    this._notifiedCategories = new Set();
  }

  async register() {
    if (this._registered) {
      return this;
    }

    const entries = this._prepareEntries();
    try {
      for (const { cid, uri } of entries.components) {
        const module = this._loadComponentModule(uri);
        const factory = this._wrapFactory(module.getFactory(cid), uri, cid);

        if (registrar.isCIDRegistered(cid)) {
          throw new Error(`Legacy component CID collision: ${cid}`);
        }

        registrar.registerFactory(cid, "", null, factory);
        this._factories.push({ cid, factory });
      }

      for (const { contractId, cid } of entries.contracts) {
        if (!registrar.isCIDRegistered(cid)) {
          throw new Error(
            `Legacy contract ${contractId} targets an unregistered CID: ${cid}`
          );
        }

        const currentCID = getContractCID(contractId);
        let ownership = contractOwnershipStacks.get(contractId);
        const topOwner = ownership?.stack.at(-1);
        if (topOwner && !sameCID(currentCID, topOwner.cid)) {
          ownership.stack.length = 0;
          contractOwnershipStacks.delete(contractId);
          ownership = null;
        }
        const isNewOwnership = !ownership;
        if (isNewOwnership) {
          ownership = { baseCID: currentCID, stack: [] };
        }

        registrar.registerFactory(cid, "", contractId, null);
        if (isNewOwnership) {
          contractOwnershipStacks.set(contractId, ownership);
        }

        let record = this._contractsById.get(contractId);
        if (record) {
          record.cid = cid;
        } else {
          record = { contractId, cid };
          this._contractsById.set(contractId, record);
          this._contracts.push(record);
        }
        moveToTop(ownership.stack, record);
      }

      for (const { category, entry, value } of entries.categories) {
        const key = categoryKey(category, entry);
        const current = getCategoryEntry(category, entry);
        let ownership = categoryOwnershipStacks.get(key);
        const topOwner = ownership?.stack.at(-1);
        if (topOwner && (!current.exists || current.value !== topOwner.value)) {
          ownership.stack.length = 0;
          categoryOwnershipStacks.delete(key);
          ownership = null;
        }
        const isNewOwnership = !ownership;
        if (isNewOwnership) {
          ownership = { base: current, stack: [] };
        }

        Services.catMan.addCategoryEntry(category, entry, value, false, true);
        if (isNewOwnership) {
          categoryOwnershipStacks.set(key, ownership);
        }

        let record = this._categoriesByKey.get(key);
        if (record) {
          record.value = value;
        } else {
          record = { category, entry, value };
          this._categoriesByKey.set(key, record);
          this._categories.push(record);
        }
        moveToTop(ownership.stack, record);
      }

      this._registered = true;
      unregisterUnusedFactories();
      return this;
    } catch (error) {
      let registrationError;
      try {
        registrationError = new Error(error?.message ?? String(error));
        registrationError.stack = error?.stack ?? registrationError.stack;
        if (error?.result !== undefined) {
          registrationError.result = error.result;
        }
      } catch {
        registrationError = new Error("Legacy component registration failed");
      }
      this.unregister();
      throw registrationError;
    }
  }

  unregister({ appShutdown = false } = {}) {
    if (appShutdown || Services.startup.shuttingDown) {
      return;
    }

    this._registered = false;
    this._restoreCategories();
    this._restoreContracts();
    this._releaseFactories();

    this._factories.length = 0;
    this._contracts.length = 0;
    this._contractsById.clear();
    this._categories.length = 0;
    this._categoriesByKey.clear();
    this._sandboxes.length = 0;
    this._modulesByURI.clear();
    this._notifiedCategories.clear();
  }

  notifyProfileAfterChange() {
    if (!this._registered) {
      return;
    }

    for (const record of this._categories) {
      if (
        record.category !== PROFILE_AFTER_CHANGE ||
        this._notifiedCategories.has(record)
      ) {
        continue;
      }

      try {
        const current = getCategoryEntry(record.category, record.entry);
        if (!current.exists || current.value !== record.value) {
          continue;
        }

        this._notifiedCategories.add(record);
        const isService = record.value.startsWith(SERVICE_PREFIX);
        const contractId = isService
          ? record.value.slice(SERVICE_PREFIX.length)
          : record.value;
        if (!contractId) {
          throw new Error("Missing profile-after-change contract ID");
        }

        const observer = isService
          ? Cc[contractId].getService(Ci.nsIObserver)
          : Cc[contractId].createInstance(Ci.nsIObserver);
        observer.observe(null, PROFILE_AFTER_CHANGE, null);
      } catch (error) {
        this._warn(
          `Unable to notify profile-after-change category entry ${record.entry}`,
          error
        );
      }
    }
  }

  _prepareEntries() {
    const components = [];
    const componentCIDs = new Set();

    for (const entry of this.manifest.componentEntries ?? []) {
      const cid = normalizeCID(entry.cid, "component entry");
      const key = cidKey(cid);
      if (componentCIDs.has(key)) {
        throw new Error(`Duplicate legacy component CID: ${cid}`);
      }
      componentCIDs.add(key);
      components.push({ cid, uri: this._normalizeComponentURI(entry.uri) });
    }

    for (const { cid } of components) {
      if (registrar.isCIDRegistered(cid)) {
        throw new Error(`Legacy component CID collision: ${cid}`);
      }
    }

    const contracts = [];
    for (const entry of this.manifest.contractEntries ?? []) {
      const contractId = requireString(
        entry.contractId ?? entry.contract,
        "contract ID"
      );
      const cid = normalizeCID(entry.cid, `contract ${contractId}`);
      if (!componentCIDs.has(cidKey(cid)) && !registrar.isCIDRegistered(cid)) {
        throw new Error(
          `Legacy contract ${contractId} targets an unregistered CID: ${cid}`
        );
      }
      contracts.push({ contractId, cid });
    }

    const categories = [];
    for (const entry of this.manifest.categoryEntries ?? []) {
      categories.push({
        category: requireString(entry.category, "category name"),
        entry: requireString(entry.entry, "category entry"),
        value: requireString(entry.value, "category value"),
      });
    }

    return { components, contracts, categories };
  }

  _normalizeComponentURI(value) {
    let uri;
    try {
      uri = value instanceof Ci.nsIURI ? value : Services.io.newURI(value);
    } catch (error) {
      throw new Error(`Malformed legacy component URI: ${value}`, {
        cause: error,
      });
    }

    const pkg = this.manifest.package;
    if (typeof pkg?.normalizeLocalURI === "function") {
      uri = pkg.normalizeLocalURI(uri);
    } else {
      if (typeof pkg?.isLocalURI === "function" && !pkg.isLocalURI(uri)) {
        throw new Error(`Legacy component is outside its package: ${uri.spec}`);
      }
      if (!uri.schemeIs("file") && !uri.schemeIs("jar")) {
        throw new Error(`Legacy component is not package-local: ${uri.spec}`);
      }
    }

    getComponentFile(uri);

    let extension;
    try {
      extension = uri.QueryInterface(Ci.nsIURL).fileExtension.toLowerCase();
    } catch (error) {
      throw new Error(`Invalid legacy component URI: ${uri.spec}`, {
        cause: error,
      });
    }
    if (extension !== "js") {
      throw new Error(`Unsupported binary legacy component: ${uri.spec}`);
    }

    return uri;
  }

  _loadComponentModule(uri) {
    const cached = this._modulesByURI.get(uri.spec);
    if (cached) {
      return cached;
    }

    const sandbox = Cu.Sandbox(systemPrincipal, {
      freshCompartment: true,
      sandboxName: `Legacy component ${uri.spec}`,
      wantComponents: true,
      wantGlobalProperties: ["ChromeUtils", "atob", "btoa"],
      wantXrays: false,
    });
    sandbox.__LOCATION__ = getComponentFile(uri);
    sandbox.__URI__ = uri.spec;
    sandbox.__SCRIPT_URI_SPEC__ = uri.spec;
    sandbox.console = console;
    sandbox.Services = Services;
    this._sandboxes.push(sandbox);

    loadComponentSubScript(uri, sandbox);

    const nsGetFactory = this._getSandboxFunction(sandbox, "NSGetFactory", uri);
    let module;
    if (nsGetFactory) {
      module = {
        getFactory(cid) {
          return nsGetFactory(cid);
        },
      };
    } else {
      const nsGetModule = this._getSandboxFunction(sandbox, "NSGetModule", uri);
      if (!nsGetModule) {
        throw new Error(
          `Legacy component does not define NSGetFactory or NSGetModule: ${uri.spec}`
        );
      }

      const legacyModule = Cu.waiveXrays(
        nsGetModule(componentManager, getComponentFile(uri))
      );
      if (!legacyModule || typeof legacyModule.getClassObject !== "function") {
        throw new Error(
          `NSGetModule did not return a module with getClassObject: ${uri.spec}`
        );
      }
      module = {
        getFactory(cid) {
          return legacyModule.getClassObject(
            componentManager,
            cid,
            Ci.nsIFactory
          );
        },
      };
    }

    this._modulesByURI.set(uri.spec, module);
    return module;
  }

  _getSandboxFunction(sandbox, name, uri) {
    const value = Cu.evalInSandbox(
      `typeof ${name} === "undefined" ? undefined : ${name}`,
      sandbox
    );
    if (value === undefined) {
      return null;
    }
    if (typeof value !== "function") {
      throw new Error(`${name} is not a function in ${uri.spec}`);
    }
    return Cu.waiveXrays(value);
  }

  _wrapFactory(value, uri, cid) {
    if (value == null) {
      throw new Error(`No factory for ${cid} in ${uri.spec}`);
    }

    const factory = Cu.waiveXrays(value);
    if (typeof factory.createInstance !== "function") {
      throw new Error(`Invalid factory for ${cid} in ${uri.spec}`);
    }

    const createInstance = factory.createInstance;
    const usesOuterArgument = createInstance.length > 1;
    return {
      createInstance(iid) {
        return usesOuterArgument
          ? createInstance.call(factory, null, iid)
          : createInstance.call(factory, iid);
      },
      QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
    };
  }

  _restoreCategories() {
    for (let index = this._categories.length - 1; index >= 0; index--) {
      const record = this._categories[index];
      const key = categoryKey(record.category, record.entry);
      const ownership = categoryOwnershipStacks.get(key);
      const ownerIndex = ownership?.stack.indexOf(record) ?? -1;
      if (ownerIndex === -1) {
        continue;
      }

      const wasTopOwner = ownerIndex === ownership.stack.length - 1;
      ownership.stack.splice(ownerIndex, 1);
      if (!ownership.stack.length) {
        categoryOwnershipStacks.delete(key);
      }
      if (!wasTopOwner) {
        continue;
      }

      try {
        const current = getCategoryEntry(record.category, record.entry);
        if (!current.exists || current.value !== record.value) {
          ownership.stack.length = 0;
          categoryOwnershipStacks.delete(key);
          this._warn(
            `Category entry ${record.category}/${record.entry} changed before legacy component shutdown`
          );
          continue;
        }

        const nextOwner = ownership.stack[ownership.stack.length - 1];
        if (nextOwner) {
          Services.catMan.addCategoryEntry(
            record.category,
            record.entry,
            nextOwner.value,
            false,
            true
          );
        } else if (ownership.base.exists) {
          Services.catMan.addCategoryEntry(
            record.category,
            record.entry,
            ownership.base.value,
            false,
            true
          );
        } else {
          Services.catMan.deleteCategoryEntry(
            record.category,
            record.entry,
            false
          );
        }
      } catch (error) {
        this._warn(
          `Unable to restore category entry ${record.category}/${record.entry}`,
          error
        );
      }
    }
  }

  _restoreContracts() {
    let tombstone = null;

    for (let index = this._contracts.length - 1; index >= 0; index--) {
      const record = this._contracts[index];
      const ownership = contractOwnershipStacks.get(record.contractId);
      const ownerIndex = ownership?.stack.indexOf(record) ?? -1;
      if (ownerIndex === -1) {
        continue;
      }

      const wasTopOwner = ownerIndex === ownership.stack.length - 1;
      ownership.stack.splice(ownerIndex, 1);
      if (!ownership.stack.length) {
        contractOwnershipStacks.delete(record.contractId);
      }
      if (!wasTopOwner) {
        continue;
      }

      try {
        const currentCID = getContractCID(record.contractId);
        if (!sameCID(currentCID, record.cid)) {
          ownership.stack.length = 0;
          contractOwnershipStacks.delete(record.contractId);
          this._warn(
            `Contract ${record.contractId} changed before legacy component shutdown`
          );
          continue;
        }

        const nextOwner = ownership.stack[ownership.stack.length - 1];
        if (nextOwner) {
          registrar.registerFactory(nextOwner.cid, "", record.contractId, null);
        } else if (ownership.baseCID) {
          registrar.registerFactory(
            ownership.baseCID,
            "",
            record.contractId,
            null
          );
        } else {
          if (!tombstone) {
            tombstone = this._registerTombstoneFactory();
          }
          registrar.registerFactory(tombstone.cid, "", record.contractId, null);
        }
      } catch (error) {
        this._warn(`Unable to restore contract ${record.contractId}`, error);
      }
    }

    if (tombstone) {
      try {
        registrar.unregisterFactory(tombstone.cid, tombstone.factory);
      } catch (error) {
        this._warn("Unable to remove the legacy contract tombstone", error);
      }
    }
  }

  _releaseFactories() {
    const factories = this._factories.splice(0);
    if (factories.length) {
      pendingFactoryCleanups.add({ factories, logger: this.logger });
    }
    unregisterUnusedFactories();
  }

  _registerTombstoneFactory() {
    let cid;
    do {
      cid = Services.uuid.generateUUID();
    } while (registrar.isCIDRegistered(cid));

    registrar.registerFactory(cid, "", null, tombstoneFactory);
    return { cid, factory: tombstoneFactory };
  }

  _warn(message, error) {
    if (error === undefined) {
      this.logger?.warn?.(message);
    } else {
      this.logger?.warn?.(message, error);
    }
  }
}
