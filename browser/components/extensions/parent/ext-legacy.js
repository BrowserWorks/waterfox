/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

ChromeUtils.defineModuleGetter(
  this,
  "ChromeManifest",
  "resource:///modules/ChromeManifest.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "ExtensionSupport",
  "resource:///modules/ExtensionSupport.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "Overlays",
  "resource:///modules/Overlays.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "XPIInternal",
  "resource://gre/modules/addons/XPIProvider.jsm"
);

Cu.importGlobalProperties(["fetch"]);

var { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
var { ConsoleAPI } = ChromeUtils.import("resource://gre/modules/Console.jsm");

XPCOMUtils.defineLazyGetter(this, "BOOTSTRAP_REASONS", () => {
  const { XPIProvider } = ChromeUtils.import(
    "resource://gre/modules/addons/XPIProvider.jsm"
  );
  return XPIProvider.BOOTSTRAP_REASONS;
});

const { Log } = ChromeUtils.import("resource://gre/modules/Log.jsm");
var logger = Log.repository.getLogger("addons.bootstrap");

let bootstrapScopes = new Map();
let cachedParams = new Map();

Services.obs.addObserver(() => {
  for (let [id, scope] of bootstrapScopes.entries()) {
    if (ExtensionSupport.loadedBootstrapExtensions.has(id)) {
      scope.shutdown(
        { ...cachedParams.get(id) },
        BOOTSTRAP_REASONS.APP_SHUTDOWN
      );
    }
  }
}, "quit-application-granted");

var { ExtensionError } = ExtensionUtils;

this.legacy = class extends ExtensionAPI {
  async onManifestEntry(entryName) {
    if (this.extension.manifest.legacy) {
      if (this.extension.manifest.legacy.type == "bootstrap") {
        await this.registerBootstrapped();
      } else {
        await this.registerNonBootstrapped();
      }
    }
  }

  // This function is for non-bootstrapped add-ons.

  async registerNonBootstrapped() {
    this.extension.legacyLoaded = true;

    let state = {
      id: this.extension.id,
      pendingOperation: null,
      version: this.extension.version,
    };
    if (ExtensionSupport.loadedLegacyExtensions.has(this.extension.id)) {
      state = ExtensionSupport.loadedLegacyExtensions.get(this.extension.id);
      let versionComparison = Services.vc.compare(
        this.extension.version,
        state.version
      );
      if (versionComparison != 0) {
        if (versionComparison > 0) {
          state.pendingOperation = "upgrade";
          ExtensionSupport.loadedLegacyExtensions.notifyObservers(state);
        } else if (versionComparison < 0) {
          state.pendingOperation = "downgrade";
          ExtensionSupport.loadedLegacyExtensions.notifyObservers(state);
        }

        // Forget any cached files we might've had from another version of this extension.
        Services.obs.notifyObservers(null, "startupcache-invalidate");
      }
      console.log(
        `Legacy WebExtension ${
          this.extension.id
        } has already been loaded in this run, refusing to do so again. Please restart.`
      );
      return;
    }

    ExtensionSupport.loadedLegacyExtensions.set(this.extension.id, state);
    if (this.extension.startupReason == "ADDON_INSTALL") {
      // Usually, sideloaded extensions are disabled when they first appear,
      // but to run calendar tests, we disable this.
      let scope = XPIInternal.XPIStates.findAddon(this.extension.id).location
        .scope;
      let autoDisableScopes = Services.prefs.getIntPref(
        "extensions.autoDisableScopes"
      );

      // If the extension was just installed from the distribution folder,
      // it's in the profile extensions folder. We don't want to disable it.
      let isDistroAddon = Services.prefs.getBoolPref(
        "extensions.installedDistroAddon." + this.extension.id,
        false
      );

      if (!isDistroAddon && scope & autoDisableScopes) {
        state.pendingOperation = "install";
        console.log(
          `Legacy WebExtension ${
            this.extension.id
          } loading for other reason than startup (${
            this.extension.startupReason
          }), refusing to load immediately.`
        );
        ExtensionSupport.loadedLegacyExtensions.notifyObservers(state);

        // Forget any cached files we might've had if this extension was previously installed.
        Services.obs.notifyObservers(null, "startupcache-invalidate");
        return;
      }
    }
    if (this.extension.startupReason == "ADDON_ENABLE") {
      state.pendingOperation = "enable";
      console.log(
        `Legacy WebExtension ${
          this.extension.id
        } loading for other reason than startup (${
          this.extension.startupReason
        }), refusing to load immediately.`
      );
      ExtensionSupport.loadedLegacyExtensions.notifyObservers(state);
      return;
    }

    let extensionRoot;
    if (this.extension.rootURI instanceof Ci.nsIJARURI) {
      extensionRoot = this.extension.rootURI.JARFile.QueryInterface(
        Ci.nsIFileURL
      ).file;
      console.log("Loading packed extension from", extensionRoot.path);
    } else {
      extensionRoot = this.extension.rootURI.QueryInterface(Ci.nsIFileURL).file;
      console.log("Loading unpacked extension from", extensionRoot.path);
    }

    // Have Gecko do as much loading as is still possible
    try {
      Cc["@mozilla.org/component-manager-extra;1"]
        .getService(Ci.nsIComponentManagerExtra)
        .addLegacyExtensionManifestLocation(extensionRoot);
    } catch (e) {
      throw new ExtensionError(e.message, e.fileName, e.lineNumber);
    }

    // Load chrome.manifest
    let appinfo = Services.appinfo;
    let options = {
      application: appinfo.ID,
      appversion: appinfo.version,
      platformversion: appinfo.platformVersion,
      os: appinfo.OS,
      osversion: Services.sysinfo.getProperty("version"),
      abi: appinfo.XPCOMABI,
    };
    let loader = async filename => {
      let url = this.extension.getURL(filename);
      return fetch(url).then(response => response.text());
    };
    let chromeManifest = new ChromeManifest(loader, options);
    await chromeManifest.parse("chrome.manifest");

    // Load preference files
    console.log("Loading add-on preferences from ", extensionRoot.path);
    ExtensionSupport.loadAddonPrefs(extensionRoot);

    // Fire profile-after-change notifications, because we are past that event by now
    console.log("Firing profile-after-change listeners for", this.extension.id);
    let profileAfterChange = chromeManifest.category.get(
      "profile-after-change"
    );
    for (let contractid of profileAfterChange.values()) {
      let service = contractid.startsWith("service,");
      let instance;
      try {
        if (service) {
          instance = Cc[contractid.substr(8)].getService(Ci.nsIObserver);
        } else {
          instance = Cc[contractid].createInstance(Ci.nsIObserver);
        }

        instance.observe(null, "profile-after-change", null);
      } catch (e) {
        console.error(
          "Error firing profile-after-change listener for",
          contractid
        );
      }
    }

    // Overlays.load must only be called once per window per extension.
    // We use this WeakSet to remember all windows we've already seen.
    let seenDocuments = new WeakSet();

    // Listen for new windows to overlay.
    let documentObserver = {
      observe(doc) {
        if (
          ExtensionCommon.instanceOf(doc, "HTMLDocument") &&
          !seenDocuments.has(doc)
        ) {
          seenDocuments.add(doc);
          Overlays.load(chromeManifest, doc.defaultView);
        }
      },
    };
    Services.obs.addObserver(documentObserver, "chrome-document-interactive");

    // Add overlays to all existing windows.
    getAllWindows().forEach(win => {
      if (
        ["interactive", "complete"].includes(win.document.readyState) &&
        !seenDocuments.has(win.document)
      ) {
        seenDocuments.add(win.document);
        Overlays.load(chromeManifest, win);
      }
    });

    this.extension.callOnClose({
      close: () => {
        Services.obs.removeObserver(
          documentObserver,
          "chrome-document-interactive"
        );
      },
    });
  }

  // The following functions are for bootstrapped add-ons.

  async registerBootstrapped() {
    let oldParams = cachedParams.get(this.extension.id);
    let params = {
      id: this.extension.id,
      version: this.extension.version,
      resourceURI: Services.io.newURI(this.extension.resourceURL),
      installPath: this.extensionFile.path,
    };
    cachedParams.set(this.extension.id, { ...params });

    if (
      oldParams &&
      ["ADDON_UPGRADE", "ADDON_DOWNGRADE"].includes(
        this.extension.startupReason
      )
    ) {
      params.oldVersion = oldParams.version;
    }

    let scope = await this.loadScope();
    bootstrapScopes.set(this.extension.id, scope);

    if (
      ["ADDON_INSTALL", "ADDON_UPGRADE", "ADDON_DOWNGRADE"].includes(
        this.extension.startupReason
      )
    ) {
      scope.install(params, BOOTSTRAP_REASONS[this.extension.startupReason]);
    }
    scope.startup(params, BOOTSTRAP_REASONS[this.extension.startupReason]);
    ExtensionSupport.loadedBootstrapExtensions.add(this.extension.id);
  }

  static onDisable(id) {
    if (bootstrapScopes.has(id)) {
      bootstrapScopes
        .get(id)
        .shutdown({ ...cachedParams.get(id) }, BOOTSTRAP_REASONS.ADDON_DISABLE);
      ExtensionSupport.loadedBootstrapExtensions.delete(id);
    }
  }

  static onUpdate(id, manifest) {
    if (bootstrapScopes.has(id)) {
      let params = {
        ...cachedParams.get(id),
        newVersion: manifest.version,
      };
      let reason = BOOTSTRAP_REASONS.ADDON_UPGRADE;
      if (Services.vc.compare(params.newVersion, params.version) < 0) {
        reason = BOOTSTRAP_REASONS.ADDON_DOWNGRADE;
      }

      let scope = bootstrapScopes.get(id);
      scope.shutdown(params, reason);
      scope.uninstall(params, reason);
      ExtensionSupport.loadedBootstrapExtensions.delete(id);
      bootstrapScopes.delete(id);
    }
  }

  static onUninstall(id) {
    if (bootstrapScopes.has(id)) {
      bootstrapScopes
        .get(id)
        .uninstall(
          { ...cachedParams.get(id) },
          BOOTSTRAP_REASONS.ADDON_UNINSTALL
        );
      bootstrapScopes.delete(id);
    }
  }

  get extensionFile() {
    let uri = Services.io.newURI(this.extension.resourceURL);
    if (uri instanceof Ci.nsIJARURI) {
      uri = uri.QueryInterface(Ci.nsIJARURI).JARFile;
    }
    return uri.QueryInterface(Ci.nsIFileURL).file;
  }

  loadScope() {
    let { extension } = this;
    let file = this.extensionFile;
    let uri = this.extension.getURL("bootstrap.js");
    let principal = Services.scriptSecurityManager.getSystemPrincipal();

    let sandbox = new Cu.Sandbox(principal, {
      sandboxName: uri,
      addonId: this.extension.id,
      wantGlobalProperties: ["ChromeUtils"],
      metadata: { addonID: this.extension.id, URI: uri },
    });

    try {
      Object.assign(sandbox, BOOTSTRAP_REASONS);

      XPCOMUtils.defineLazyGetter(
        sandbox,
        "console",
        () => new ConsoleAPI({ consoleID: `addon/${this.extension.id}` })
      );

      Services.scriptloader.loadSubScript(uri, sandbox);
    } catch (e) {
      logger.warn(`Error loading bootstrap.js for ${this.extension.id}`, e);
    }

    function findMethod(name) {
      if (sandbox.name) {
        return sandbox.name;
      }

      try {
        let method = Cu.evalInSandbox(name, sandbox);
        return method;
      } catch (err) {}

      return () => {
        logger.warn(
          `Add-on ${extension.id} is missing bootstrap method ${name}`
        );
      };
    }

    let install = findMethod("install");
    let uninstall = findMethod("uninstall");
    let startup = findMethod("startup");
    let shutdown = findMethod("shutdown");

    return {
      install(...args) {
        try {
          install(...args);
        } catch (ex) {
          logger.warn(
            `Exception running bootstrap method install on ${extension.id}`,
            ex
          );
        }
      },

      uninstall(...args) {
        try {
          uninstall(...args);
        } catch (ex) {
          logger.warn(
            `Exception running bootstrap method uninstall on ${extension.id}`,
            ex
          );
        } finally {
          // Forget any cached files we might've had from this extension.
          Services.obs.notifyObservers(null, "startupcache-invalidate");
        }
      },

      startup(...args) {
        logger.debug(`Registering manifest for ${file.path}\n`);
        Components.manager.addBootstrappedManifestLocation(file);
        try {
          startup(...args);
        } catch (ex) {
          logger.warn(
            `Exception running bootstrap method startup on ${extension.id}`,
            ex
          );
        }
      },

      shutdown(data, reason) {
        try {
          shutdown(data, reason);
        } catch (ex) {
          logger.warn(
            `Exception running bootstrap method shutdown on ${extension.id}`,
            ex
          );
        } finally {
          if (reason != BOOTSTRAP_REASONS.APP_SHUTDOWN) {
            logger.debug(`Removing manifest for ${file.path}\n`);
            Components.manager.removeBootstrappedManifestLocation(file);
          }
        }
      },
    };
  }
};

function getAllWindows() {
  function getChildDocShells(parentDocShell) {
    let docShells = parentDocShell.getAllDocShellsInSubtree(
      Ci.nsIDocShellTreeItem.typeAll,
      Ci.nsIDocShell.ENUMERATE_FORWARDS
    );

    for (let docShell of docShells) {
      docShell
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIWebProgress);
      domWindows.push(docShell.domWindow);
    }
  }

  let domWindows = [];
  for (let win of Services.ww.getWindowEnumerator()) {
    let parentDocShell = win
      .getInterface(Ci.nsIWebNavigation)
      .QueryInterface(Ci.nsIDocShell);
    getChildDocShells(parentDocShell);
  }
  return domWindows;
}
