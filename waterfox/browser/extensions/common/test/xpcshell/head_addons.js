/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/
 */
"use strict";

const PREF_EM_CHECK_UPDATE_SECURITY = "extensions.checkUpdateSecurity";
const PREF_EM_STRICT_COMPATIBILITY = "extensions.strictCompatibility";
const PREF_GETADDONS_BYIDS = "extensions.getAddons.get.url";
const PREF_COMPAT_OVERRIDES = "extensions.getAddons.compatOverides.url";
const PREF_XPI_SIGNATURES_REQUIRED = "xpinstall.signatures.required";

const PREF_DISABLE_SECURITY =
  "security.turn_off_all_security_so_that_" +
  "viruses_can_take_over_this_computer";

// Maximum error in file modification times. Some file systems don't store
// modification times exactly. As long as we are closer than this then it
// still passes.
const MAX_TIME_DIFFERENCE = 3000;

// Time to reset file modified time relative to Date.now() so we can test that
// times are modified (10 hours old).
const MAKE_FILE_OLD_DIFFERENCE = 10 * 3600 * 1000;

var { AppConstants } = ChromeUtils.import(
  "resource://gre/modules/AppConstants.jsm"
);
var { FileUtils } = ChromeUtils.import("resource://gre/modules/FileUtils.jsm");
var { NetUtil } = ChromeUtils.import("resource://gre/modules/NetUtil.jsm");
var { Services } = ChromeUtils.import("resource://gre/modules/Services.jsm");
var { XPCOMUtils } = ChromeUtils.import(
  "resource://gre/modules/XPCOMUtils.jsm"
);
var { AddonRepository } = ChromeUtils.import(
  "resource://gre/modules/addons/AddonRepository.jsm"
);
var { OS } = ChromeUtils.import("resource://gre/modules/osfile.jsm");

var { AddonTestUtils, MockAsyncShutdown } = ChromeUtils.import(
  "resource://testing-common/AddonTestUtils.jsm"
);

ChromeUtils.defineModuleGetter(
  this,
  "Blocklist",
  "resource://gre/modules/Blocklist.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "Extension",
  "resource://gre/modules/Extension.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "ExtensionTestUtils",
  "resource://testing-common/ExtensionXPCShellUtils.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "ExtensionTestCommon",
  "resource://testing-common/ExtensionTestCommon.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "HttpServer",
  "resource://testing-common/httpd.js"
);
ChromeUtils.defineModuleGetter(
  this,
  "MockRegistrar",
  "resource://testing-common/MockRegistrar.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "MockRegistry",
  "resource://testing-common/MockRegistry.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "PromiseTestUtils",
  "resource://testing-common/PromiseTestUtils.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "TestUtils",
  "resource://testing-common/TestUtils.jsm"
);

XPCOMUtils.defineLazyServiceGetter(
  this,
  "aomStartup",
  "@mozilla.org/addons/addon-manager-startup;1",
  "amIAddonManagerStartup"
);

const {
  createAppInfo,
  createHttpServer,
  createTempWebExtensionFile,
  getFileForAddon,
  manuallyInstall,
  manuallyUninstall,
  overrideBuiltIns,
  promiseAddonEvent,
  promiseCompleteAllInstalls,
  promiseCompleteInstall,
  promiseConsoleOutput,
  promiseFindAddonUpdates,
  promiseInstallAllFiles,
  promiseInstallFile,
  promiseSetExtensionModifiedTime,
  promiseShutdownManager,
  promiseWebExtensionStartup,
  promiseWriteProxyFileToDir,
  registerDirectory,
  setExtensionModifiedTime,
  writeFilesToZip,
} = AddonTestUtils;

// WebExtension wrapper for ease of testing
ExtensionTestUtils.init(this);

AddonTestUtils.init(this);
AddonTestUtils.overrideCertDB();

XPCOMUtils.defineLazyGetter(
  this,
  "BOOTSTRAP_REASONS",
  () => AddonManagerPrivate.BOOTSTRAP_REASONS
);

function getReasonName(reason) {
  for (let key of Object.keys(BOOTSTRAP_REASONS)) {
    if (BOOTSTRAP_REASONS[key] == reason) {
      return key;
    }
  }
  throw new Error("This shouldn't happen.");
}

Object.defineProperty(this, "gAppInfo", {
  get() {
    return AddonTestUtils.appInfo;
  },
});

Object.defineProperty(this, "gAddonStartup", {
  get() {
    return AddonTestUtils.addonStartup.clone();
  },
});

Object.defineProperty(this, "gInternalManager", {
  get() {
    return AddonTestUtils.addonIntegrationService.QueryInterface(
      Ci.nsITimerCallback
    );
  },
});

Object.defineProperty(this, "gProfD", {
  get() {
    return AddonTestUtils.profileDir.clone();
  },
});

Object.defineProperty(this, "gTmpD", {
  get() {
    return AddonTestUtils.tempDir.clone();
  },
});

Object.defineProperty(this, "gUseRealCertChecks", {
  get() {
    return AddonTestUtils.useRealCertChecks;
  },
  set(val) {
    return (AddonTestUtils.useRealCertChecks = val);
  },
});

Object.defineProperty(this, "TEST_UNPACKED", {
  get() {
    return AddonTestUtils.testUnpacked;
  },
  set(val) {
    return (AddonTestUtils.testUnpacked = val);
  },
});

// We need some internal bits of AddonManager
var AMscope = ChromeUtils.import(
  "resource://gre/modules/AddonManager.jsm",
  null
);
var { AddonManager, AddonManagerInternal, AddonManagerPrivate } = AMscope;

// Wrap the startup functions to ensure the bootstrap loader is added.
function promiseStartupManager(newVersion) {
  const { BootstrapLoader } = ChromeUtils.import(
    "resource:///modules/BootstrapLoader.jsm"
  );
  AddonManager.addExternalExtensionLoader(BootstrapLoader);
  return AddonTestUtils.promiseStartupManager(newVersion);
}

async function promiseRestartManager(newVersion) {
  await promiseShutdownManager(false);
  await promiseStartupManager(newVersion);
}

const promiseAddonByID = AddonManager.getAddonByID;
const promiseAddonsByIDs = AddonManager.getAddonsByIDs;

var gPort = null;
var gUrlToFileMap = {};

// Map resource://xpcshell-data/ to the data directory
var resHandler = Services.io
  .getProtocolHandler("resource")
  .QueryInterface(Ci.nsISubstitutingProtocolHandler);
// Allow non-existent files because of bug 1207735
var dataURI = NetUtil.newURI(do_get_file("data", true));
resHandler.setSubstitution("xpcshell-data", dataURI);

function isManifestRegistered(file) {
  let manifests = Components.manager.getManifestLocations();
  for (let i = 0; i < manifests.length; i++) {
    let manifest = manifests.queryElementAt(i, Ci.nsIURI);

    // manifest is the url to the manifest file either in an XPI or a directory.
    // We want the location of the XPI or directory itself.
    if (manifest instanceof Ci.nsIJARURI) {
      manifest = manifest.JARFile.QueryInterface(Ci.nsIFileURL).file;
    } else if (manifest instanceof Ci.nsIFileURL) {
      manifest = manifest.file.parent;
    } else {
      continue;
    }

    if (manifest.equals(file)) {
      return true;
    }
  }
  return false;
}

const BOOTSTRAP_MONITOR_BOOTSTRAP_JS = `
  ChromeUtils.import("resource://xpcshell-data/BootstrapMonitor.jsm").monitor(this);
`;

// Listens to messages from bootstrap.js telling us what add-ons were started
// and stopped etc. and performs some sanity checks that only installed add-ons
// are started etc.
this.BootstrapMonitor = {
  inited: false,

  // Contain the current state of add-ons in the system
  installed: new Map(),
  started: new Map(),

  // Contain the last state of shutdown and uninstall calls for an add-on
  stopped: new Map(),
  uninstalled: new Map(),

  startupPromises: [],
  installPromises: [],

  restartfulIds: new Set(),

  init() {
    this.inited = true;
    Services.obs.addObserver(this, "bootstrapmonitor-event");
  },

  shutdownCheck() {
    if (!this.inited) {
      return;
    }

    Assert.equal(this.started.size, 0);
  },

  clear(id) {
    this.installed.delete(id);
    this.started.delete(id);
    this.stopped.delete(id);
    this.uninstalled.delete(id);
  },

  promiseAddonStartup(id) {
    return new Promise(resolve => {
      this.startupPromises.push(resolve);
    });
  },

  promiseAddonInstall(id) {
    return new Promise(resolve => {
      this.installPromises.push(resolve);
    });
  },

  checkMatches(cached, current) {
    Assert.notEqual(cached, undefined);
    Assert.equal(current.data.version, cached.data.version);
    Assert.equal(current.data.installPath, cached.data.installPath);
    Assert.ok(
      Services.io
        .newURI(current.data.resourceURI)
        .equals(Services.io.newURI(cached.data.resourceURI)),
      `Resource URIs match: "${current.data.resourceURI}" == "${cached.data.resourceURI}"`
    );
  },

  checkAddonStarted(id, version = undefined) {
    let started = this.started.get(id);
    Assert.notEqual(started, undefined);
    if (version != undefined) {
      Assert.equal(started.data.version, version);
    }

    // Chrome should be registered by now
    // Get the install path from the resource URI, since it is not passed any longer.
    let uri = Services.io.newURI(started.data.resourceURI);
    let jarFile = uri.QueryInterface(Ci.nsIJARURI).JARFile;
    let installPath = jarFile.QueryInterface(Ci.nsIFileURL).file;

    let isRegistered = isManifestRegistered(installPath);
    Assert.ok(isRegistered);
  },

  checkAddonNotStarted(id) {
    Assert.ok(!this.started.has(id));
  },

  checkAddonInstalled(id, version = undefined) {
    const installed = this.installed.get(id);
    notEqual(installed, undefined);
    if (version !== undefined) {
      equal(installed.data.version, version);
    }
    return installed;
  },

  checkAddonNotInstalled(id) {
    Assert.ok(!this.installed.has(id));
  },

  observe(subject, topic, data) {
    let info = JSON.parse(data);
    let id = info.data.id;

    // Get the install path from the resource URI, since it is not passed any longer.
    let uri = Services.io.newURI(info.data.resourceURI);
    let jarFile = uri.QueryInterface(Ci.nsIJARURI).JARFile;
    let installPath = jarFile.QueryInterface(Ci.nsIFileURL).file;

    if (subject && subject.wrappedJSObject) {
      // NOTE: in some of the new tests, we need to received the real objects instead of
      // their JSON representations, but most of the current tests expect intallPath
      // and resourceURI to have been converted to strings.
      info.data = Object.assign({}, subject.wrappedJSObject.data, {
        installPath: info.data.installPath,
        resourceURI: info.data.resourceURI,
      });
    }

    // If this is the install event the add-ons shouldn't already be installed
    if (info.event == "install") {
      this.checkAddonNotInstalled(id);

      this.installed.set(id, info);

      for (let resolve of this.installPromises) {
        resolve();
      }
      this.installPromises = [];
    } else {
      this.checkMatches(this.installed.get(id), info);
    }

    // If this is the shutdown event than the add-on should already be started
    if (info.event == "shutdown") {
      this.checkMatches(this.started.get(id), info);

      this.started.delete(id);
      this.stopped.set(id, info);

      // Chrome should still be registered at this point
      let isRegistered = isManifestRegistered(installPath);
      Assert.ok(isRegistered);

      // XPIProvider doesn't bother unregistering chrome on app shutdown but
      // since we simulate restarts we must do so manually to keep the registry
      // consistent.
      if (info.reason == 2 /* APP_SHUTDOWN */) {
        Components.manager.removeBootstrappedManifestLocation(installPath);
      }
    } else {
      this.checkAddonNotStarted(id);
    }

    if (info.event == "uninstall") {
      // We currently support registering, but not unregistering,
      // restartful add-on manifests during xpcshell AOM "restarts".
      if (!this.restartfulIds.has(id)) {
        // Chrome should be unregistered at this point
        let isRegistered = isManifestRegistered(installPath);
        Assert.ok(!isRegistered);
      }

      this.installed.delete(id);
      this.uninstalled.set(id, info);
    } else if (info.event == "startup") {
      this.started.set(id, info);

      // Chrome should be registered at this point
      let isRegistered = isManifestRegistered(installPath);
      Assert.ok(isRegistered);

      for (let resolve of this.startupPromises) {
        resolve();
      }
      this.startupPromises = [];
    }
  },
};

AddonTestUtils.on("addon-manager-shutdown", () => {
  BootstrapMonitor.shutdownCheck();
  Cu.unload("resource:///modules/BootstrapLoader.jsm");
});

var SlightlyLessDodgyBootstrapMonitor = {
  started: new Map(),
  stopped: new Map(),
  installed: new Map(),
  uninstalled: new Map(),

  init() {
    this.onEvent = this.onEvent.bind(this);

    AddonTestUtils.on("addon-manager-shutdown", this.onEvent);
    AddonTestUtils.on("bootstrap-method", this.onEvent);
  },

  shutdownCheck() {
    equal(
      this.started.size,
      0,
      "Should have no add-ons that were started but not shutdown"
    );
  },

  onEvent(msg, data) {
    switch (msg) {
      case "addon-manager-shutdown":
        this.shutdownCheck();
        break;
      case "bootstrap-method":
        this.onBootstrapMethod(data.method, data.params, data.reason);
        break;
    }
  },

  onBootstrapMethod(method, params, reason) {
    let { id } = params;

    info(
      `Bootstrap method ${method} for ${params.id} version ${params.version}`
    );

    if (method !== "install") {
      this.checkInstalled(id);
    }

    switch (method) {
      case "install":
        this.checkNotInstalled(id);
        this.installed.set(id, { reason, params });
        this.uninstalled.delete(id);
        break;
      case "startup":
        this.checkNotStarted(id);
        this.started.set(id, { reason, params });
        this.stopped.delete(id);
        break;
      case "shutdown":
        this.checkMatches("shutdown", "startup", params, this.started.get(id));
        this.checkStarted(id);
        this.stopped.set(id, { reason, params });
        this.started.delete(id);
        break;
      case "uninstall":
        this.checkMatches(
          "uninstall",
          "install",
          params,
          this.installed.get(id)
        );
        this.uninstalled.set(id, { reason, params });
        this.installed.delete(id);
        break;
      case "update":
        this.checkMatches("update", "install", params, this.installed.get(id));
        this.installed.set(id, { reason, params });
        break;
    }
  },

  clear(id) {
    this.installed.delete(id);
    this.started.delete(id);
    this.stopped.delete(id);
    this.uninstalled.delete(id);
  },

  checkMatches(method, lastMethod, params, { params: lastParams } = {}) {
    ok(
      lastParams,
      `Expecting matching ${lastMethod} call for add-on ${params.id} ${method} call`
    );

    if (method == "update") {
      equal(
        params.oldVersion,
        lastParams.version,
        "params.version should match last call"
      );
    } else {
      equal(
        params.version,
        lastParams.version,
        "params.version should match last call"
      );
    }

    if (method !== "update" && method !== "uninstall") {
      equal(
        params.installPath.path,
        lastParams.installPath.path,
        `params.installPath should match last call`
      );

      ok(
        params.resourceURI.equals(lastParams.resourceURI),
        `params.resourceURI should match: "${params.resourceURI.spec}" == "${lastParams.resourceURI.spec}"`
      );
    }
  },

  checkStarted(id, version = undefined) {
    let started = this.started.get(id);
    ok(started, `Should have seen startup method call for ${id}`);

    if (version !== undefined) {
      equal(started.params.version, version, "Expected version number");
    }
  },

  checkNotStarted(id) {
    ok(
      !this.started.has(id),
      `Should not have seen startup method call for ${id}`
    );
  },

  checkInstalled(id, version = undefined) {
    const installed = this.installed.get(id);
    ok(installed, `Should have seen install call for ${id}`);

    if (version !== undefined) {
      equal(installed.params.version, version, "Expected version number");
    }

    return installed;
  },

  checkNotInstalled(id) {
    ok(
      !this.installed.has(id),
      `Should not have seen install method call for ${id}`
    );
  },
};

function isNightlyChannel() {
  var channel = Services.prefs.getCharPref("app.update.channel", "default");

  return (
    channel != "aurora" &&
    channel != "beta" &&
    channel != "release" &&
    channel != "esr"
  );
}

async function restartWithLocales(locales) {
  Services.locale.requestedLocales = locales;
  await promiseRestartManager();
}

/**
 * Returns a map of Addon objects for installed add-ons with the given
 * IDs. The returned map contains a key for the ID of each add-on that
 * is found. IDs for add-ons which do not exist are not present in the
 * map.
 *
 * @param {sequence<string>} ids
 *        The list of add-on IDs to get.
 * @returns {Promise<string, Addon>}
 *        Map of add-ons that were found.
 */
async function getAddons(ids) {
  let addons = new Map();
  for (let addon of await AddonManager.getAddonsByIDs(ids)) {
    if (addon) {
      addons.set(addon.id, addon);
    }
  }
  return addons;
}

/**
 * Checks that the given add-on has the given expected properties.
 *
 * @param {string} id
 *        The id of the add-on.
 * @param {Addon?} addon
 *        The add-on object, or null if the add-on does not exist.
 * @param {object?} expected
 *        An object containing the expected values for properties of the
 *        add-on, or null if the add-on is expected not to exist.
 */
function checkAddon(id, addon, expected) {
  info(`Checking state of addon ${id}`);

  if (expected === null) {
    ok(!addon, `Addon ${id} should not exist`);
  } else {
    ok(addon, `Addon ${id} should exist`);
    for (let [key, value] of Object.entries(expected)) {
      if (value instanceof Ci.nsIURI) {
        equal(
          addon[key] && addon[key].spec,
          value.spec,
          `Expected value of addon.${key}`
        );
      } else {
        deepEqual(addon[key], value, `Expected value of addon.${key}`);
      }
    }
  }
}

/**
 * Tests that an add-on does appear in the crash report annotations, if
 * crash reporting is enabled. The test will fail if the add-on is not in the
 * annotation.
 * @param  aId
 *         The ID of the add-on
 * @param  aVersion
 *         The version of the add-on
 */
function do_check_in_crash_annotation(aId, aVersion) {
  if (!AppConstants.MOZ_CRASHREPORTER) {
    return;
  }

  if (!("Add-ons" in gAppInfo.annotations)) {
    Assert.ok(false, "Cannot find Add-ons entry in crash annotations");
    return;
  }

  let addons = gAppInfo.annotations["Add-ons"].split(",");
  Assert.ok(
    addons.includes(
      `${encodeURIComponent(aId)}:${encodeURIComponent(aVersion)}`
    )
  );
}

/**
 * Tests that an add-on does not appear in the crash report annotations, if
 * crash reporting is enabled. The test will fail if the add-on is in the
 * annotation.
 * @param  aId
 *         The ID of the add-on
 * @param  aVersion
 *         The version of the add-on
 */
function do_check_not_in_crash_annotation(aId, aVersion) {
  if (!AppConstants.MOZ_CRASHREPORTER) {
    return;
  }

  if (!("Add-ons" in gAppInfo.annotations)) {
    Assert.ok(true);
    return;
  }

  let addons = gAppInfo.annotations["Add-ons"].split(",");
  Assert.ok(
    !addons.includes(
      `${encodeURIComponent(aId)}:${encodeURIComponent(aVersion)}`
    )
  );
}

function do_get_file_hash(aFile, aAlgorithm) {
  if (!aAlgorithm) {
    aAlgorithm = "sha1";
  }

  let crypto = Cc["@mozilla.org/security/hash;1"].createInstance(
    Ci.nsICryptoHash
  );
  crypto.initWithString(aAlgorithm);
  let fis = Cc["@mozilla.org/network/file-input-stream;1"].createInstance(
    Ci.nsIFileInputStream
  );
  fis.init(aFile, -1, -1, false);
  crypto.updateFromStream(fis, aFile.fileSize);

  // return the two-digit hexadecimal code for a byte
  let toHexString = charCode => ("0" + charCode.toString(16)).slice(-2);

  let binary = crypto.finish(false);
  let hash = Array.from(binary, c => toHexString(c.charCodeAt(0)));
  return aAlgorithm + ":" + hash.join("");
}

/**
 * Returns an extension uri spec
 *
 * @param  aProfileDir
 *         The extension install directory
 * @returns a uri spec pointing to the root of the extension
 */
function do_get_addon_root_uri(aProfileDir, aId) {
  let path = aProfileDir.clone();
  path.append(aId);
  if (!path.exists()) {
    path.leafName += ".xpi";
    return "jar:" + Services.io.newFileURI(path).spec + "!/";
  }
  return Services.io.newFileURI(path).spec;
}

function do_get_expected_addon_name(aId) {
  if (TEST_UNPACKED) {
    return aId;
  }
  return aId + ".xpi";
}

/**
 * Check that an array of actual add-ons is the same as an array of
 * expected add-ons.
 *
 * @param  aActualAddons
 *         The array of actual add-ons to check.
 * @param  aExpectedAddons
 *         The array of expected add-ons to check against.
 * @param  aProperties
 *         An array of properties to check.
 */
function do_check_addons(aActualAddons, aExpectedAddons, aProperties) {
  Assert.notEqual(aActualAddons, null);
  Assert.equal(aActualAddons.length, aExpectedAddons.length);
  for (let i = 0; i < aActualAddons.length; i++) {
    do_check_addon(aActualAddons[i], aExpectedAddons[i], aProperties);
  }
}

/**
 * Check that the actual add-on is the same as the expected add-on.
 *
 * @param  aActualAddon
 *         The actual add-on to check.
 * @param  aExpectedAddon
 *         The expected add-on to check against.
 * @param  aProperties
 *         An array of properties to check.
 */
function do_check_addon(aActualAddon, aExpectedAddon, aProperties) {
  Assert.notEqual(aActualAddon, null);

  aProperties.forEach(function(aProperty) {
    let actualValue = aActualAddon[aProperty];
    let expectedValue = aExpectedAddon[aProperty];

    // Check that all undefined expected properties are null on actual add-on
    if (!(aProperty in aExpectedAddon)) {
      if (actualValue !== undefined && actualValue !== null) {
        do_throw(
          "Unexpected defined/non-null property for add-on " +
            aExpectedAddon.id +
            " (addon[" +
            aProperty +
            "] = " +
            actualValue.toSource() +
            ")"
        );
      }

      return;
    }
    if (expectedValue && !actualValue) {
      do_throw(
        "Missing property for add-on " +
          aExpectedAddon.id +
          ": expected addon[" +
          aProperty +
          "] = " +
          expectedValue
      );
      return;
    }

    switch (aProperty) {
      case "creator":
        do_check_author(actualValue, expectedValue);
        break;

      case "developers":
        Assert.equal(actualValue.length, expectedValue.length);
        for (let i = 0; i < actualValue.length; i++) {
          do_check_author(actualValue[i], expectedValue[i]);
        }
        break;

      case "screenshots":
        Assert.equal(actualValue.length, expectedValue.length);
        for (let i = 0; i < actualValue.length; i++) {
          do_check_screenshot(actualValue[i], expectedValue[i]);
        }
        break;

      case "sourceURI":
        Assert.equal(actualValue.spec, expectedValue);
        break;

      case "updateDate":
        Assert.equal(actualValue.getTime(), expectedValue.getTime());
        break;

      case "compatibilityOverrides":
        Assert.equal(actualValue.length, expectedValue.length);
        for (let i = 0; i < actualValue.length; i++) {
          do_check_compatibilityoverride(actualValue[i], expectedValue[i]);
        }
        break;

      case "icons":
        do_check_icons(actualValue, expectedValue);
        break;

      default:
        if (actualValue !== expectedValue) {
          do_throw(
            "Failed for " +
              aProperty +
              " for add-on " +
              aExpectedAddon.id +
              " (" +
              actualValue +
              " === " +
              expectedValue +
              ")"
          );
        }
    }
  });
}

/**
 * Check that the actual author is the same as the expected author.
 *
 * @param  actual
 *         The actual author to check.
 * @param  aExpected
 *         The expected author to check against.
 */
function do_check_author(actual, aExpected) {
  Assert.equal(actual.toString(), aExpected.name);
  Assert.equal(actual.name, aExpected.name);
  Assert.equal(actual.url, aExpected.url);
}

/**
 * Check that the actual screenshot is the same as the expected screenshot.
 *
 * @param  actual
 *         The actual screenshot to check.
 * @param  aExpected
 *         The expected screenshot to check against.
 */
function do_check_screenshot(actual, aExpected) {
  Assert.equal(actual.toString(), aExpected.url);
  Assert.equal(actual.url, aExpected.url);
  Assert.equal(actual.width, aExpected.width);
  Assert.equal(actual.height, aExpected.height);
  Assert.equal(actual.thumbnailURL, aExpected.thumbnailURL);
  Assert.equal(actual.thumbnailWidth, aExpected.thumbnailWidth);
  Assert.equal(actual.thumbnailHeight, aExpected.thumbnailHeight);
  Assert.equal(actual.caption, aExpected.caption);
}

/**
 * Check that the actual compatibility override is the same as the expected
 * compatibility override.
 *
 * @param  aAction
 *         The actual compatibility override to check.
 * @param  aExpected
 *         The expected compatibility override to check against.
 */
function do_check_compatibilityoverride(actual, aExpected) {
  Assert.equal(actual.type, aExpected.type);
  Assert.equal(actual.minVersion, aExpected.minVersion);
  Assert.equal(actual.maxVersion, aExpected.maxVersion);
  Assert.equal(actual.appID, aExpected.appID);
  Assert.equal(actual.appMinVersion, aExpected.appMinVersion);
  Assert.equal(actual.appMaxVersion, aExpected.appMaxVersion);
}

function do_check_icons(actual, aExpected) {
  for (var size in aExpected) {
    Assert.equal(actual[size], aExpected[size]);
  }
}

function isThemeInAddonsList(aDir, aId) {
  return AddonTestUtils.addonsList.hasTheme(aDir, aId);
}

function isExtensionInBootstrappedList(aDir, aId) {
  return AddonTestUtils.addonsList.hasExtension(aDir, aId);
}

/**
 * Writes an install.rdf manifest into a directory using the properties passed
 * in a JS object. The objects should contain a property for each property to
 * appear in the RDF. The object may contain an array of objects with id,
 * minVersion and maxVersion in the targetApplications property to give target
 * application compatibility.
 *
 * @param   aData
 *          The object holding data about the add-on
 * @param   aDir
 *          The directory to add the install.rdf to
 * @param   aId
 *          An optional string to override the default installation aId
 * @param   aExtraFile
 *          An optional dummy file to create in the directory
 * @returns  An nsIFile for the directory in which the add-on is installed.
 */
async function promiseWriteInstallRDFToDir(
  aData,
  aDir,
  aId = aData.id,
  aExtraFile = null
) {
  let files = {
    "install.rdf": createInstallRDF(aData),
  };
  if (typeof aExtraFile === "object") {
    Object.assign(files, aExtraFile);
  } else {
    files[aExtraFile] = "";
  }

  let dir = aDir.clone();
  dir.append(aId);

  await AddonTestUtils.promiseWriteFilesToDir(dir.path, files);
  return dir;
}

/**
 * Writes an install.rdf manifest into a packed extension using the properties passed
 * in a JS object. The objects should contain a property for each property to
 * appear in the RDF. The object may contain an array of objects with id,
 * minVersion and maxVersion in the targetApplications property to give target
 * application compatibility.
 *
 * @param   aData
 *          The object holding data about the add-on
 * @param   aDir
 *          The install directory to add the extension to
 * @param   aId
 *          An optional string to override the default installation aId
 * @param   aExtraFile
 *          An optional dummy file to create in the extension
 * @returns  A file pointing to where the extension was installed
 */
async function promiseWriteInstallRDFToXPI(
  aData,
  aDir,
  aId = aData.id,
  aExtraFile = null
) {
  let files = {
    "install.rdf": createInstallRDF(aData),
  };
  if (typeof aExtraFile === "object") {
    Object.assign(files, aExtraFile);
  } else if (aExtraFile) {
    files[aExtraFile] = "";
  }

  if (!aDir.exists()) {
    aDir.create(Ci.nsIFile.DIRECTORY_TYPE, FileUtils.PERMS_DIRECTORY);
  }

  var file = aDir.clone();
  file.append(`${aId}.xpi`);

  AddonTestUtils.writeFilesToZip(file.path, files);

  return file;
}

/**
 * Writes an install.rdf manifest into an extension using the properties passed
 * in a JS object. The objects should contain a property for each property to
 * appear in the RDF. The object may contain an array of objects with id,
 * minVersion and maxVersion in the targetApplications property to give target
 * application compatibility.
 *
 * @param   aData
 *          The object holding data about the add-on
 * @param   aDir
 *          The install directory to add the extension to
 * @param   aId
 *          An optional string to override the default installation aId
 * @param   aExtraFile
 *          An optional dummy file to create in the extension
 * @returns  A file pointing to where the extension was installed
 */
function promiseWriteInstallRDFForExtension(aData, aDir, aId, aExtraFile) {
  if (TEST_UNPACKED) {
    return promiseWriteInstallRDFToDir(aData, aDir, aId, aExtraFile);
  }
  return promiseWriteInstallRDFToXPI(aData, aDir, aId, aExtraFile);
}

/**
 * Writes a manifest.json manifest into an extension using the properties passed
 * in a JS object.
 *
 * @param   aManifest
 *          The data to write
 * @param   aDir
 *          The install directory to add the extension to
 * @param   aId
 *          An optional string to override the default installation aId
 * @returns  A file pointing to where the extension was installed
 */
function promiseWriteWebManifestForExtension(
  aData,
  aDir,
  aId = aData.applications.gecko.id
) {
  let files = {
    "manifest.json": JSON.stringify(aData),
  };
  return AddonTestUtils.promiseWriteFilesToExtension(aDir.path, aId, files);
}

/**
 * Creates an XPI file for some manifest data in the temporary directory and
 * returns the nsIFile for it. The file will be deleted when the test completes.
 *
 * @param   aData
 *          The object holding data about the add-on
 * @returns  A file pointing to the created XPI file
 */
function createTempXPIFile(aData, aExtraFile) {
  let files = {
    "install.rdf": aData,
  };
  if (typeof aExtraFile == "object") {
    Object.assign(files, aExtraFile);
  } else if (aExtraFile) {
    files[aExtraFile] = "";
  }

  return AddonTestUtils.createTempXPIFile(files);
}

function promiseInstallXPI(installRDF) {
  return AddonTestUtils.promiseInstallXPI({ "install.rdf": installRDF });
}

var gExpectedEvents = {};
var gExpectedInstalls = [];
var gNext = null;

function getExpectedEvent(aId) {
  if (!(aId in gExpectedEvents)) {
    do_throw("Wasn't expecting events for " + aId);
  }
  if (!gExpectedEvents[aId].length) {
    do_throw("Too many events for " + aId);
  }
  let event = gExpectedEvents[aId].shift();
  if (event instanceof Array) {
    return event;
  }
  return [event, true];
}

function getExpectedInstall(aAddon) {
  if (gExpectedInstalls instanceof Array) {
    return gExpectedInstalls.shift();
  }
  if (!aAddon || !aAddon.id) {
    return gExpectedInstalls.NO_ID.shift();
  }
  let id = aAddon.id;
  if (!(id in gExpectedInstalls) || !(gExpectedInstalls[id] instanceof Array)) {
    do_throw("Wasn't expecting events for " + id);
  }
  if (!gExpectedInstalls[id].length) {
    do_throw("Too many events for " + id);
  }
  return gExpectedInstalls[id].shift();
}

const AddonListener = {
  onPropertyChanged(aAddon, aProperties) {
    info(`Got onPropertyChanged event for ${aAddon.id}`);
    let [event, properties] = getExpectedEvent(aAddon.id);
    Assert.equal("onPropertyChanged", event);
    Assert.equal(aProperties.length, properties.length);
    properties.forEach(function(aProperty) {
      // Only test that the expected properties are listed, having additional
      // properties listed is not necessary a problem
      if (!aProperties.includes(aProperty)) {
        do_throw("Did not see property change for " + aProperty);
      }
    });
    return check_test_completed(arguments);
  },

  onEnabling(aAddon, aRequiresRestart) {
    info(`Got onEnabling event for ${aAddon.id}`);
    let [event, expectedRestart] = getExpectedEvent(aAddon.id);
    Assert.equal("onEnabling", event);
    Assert.equal(aRequiresRestart, expectedRestart);
    if (expectedRestart) {
      Assert.ok(hasFlag(aAddon.pendingOperations, AddonManager.PENDING_ENABLE));
    }
    Assert.ok(!hasFlag(aAddon.permissions, AddonManager.PERM_CAN_ENABLE));
    return check_test_completed(arguments);
  },

  onEnabled(aAddon) {
    info(`Got onEnabled event for ${aAddon.id}`);
    let [event] = getExpectedEvent(aAddon.id);
    Assert.equal("onEnabled", event);
    Assert.ok(!hasFlag(aAddon.permissions, AddonManager.PERM_CAN_ENABLE));
    return check_test_completed(arguments);
  },

  onDisabling(aAddon, aRequiresRestart) {
    info(`Got onDisabling event for ${aAddon.id}`);
    let [event, expectedRestart] = getExpectedEvent(aAddon.id);
    Assert.equal("onDisabling", event);
    Assert.equal(aRequiresRestart, expectedRestart);
    if (expectedRestart) {
      Assert.ok(
        hasFlag(aAddon.pendingOperations, AddonManager.PENDING_DISABLE)
      );
    }
    Assert.ok(!hasFlag(aAddon.permissions, AddonManager.PERM_CAN_DISABLE));
    return check_test_completed(arguments);
  },

  onDisabled(aAddon) {
    info(`Got onDisabled event for ${aAddon.id}`);
    let [event] = getExpectedEvent(aAddon.id);
    Assert.equal("onDisabled", event);
    Assert.ok(!hasFlag(aAddon.permissions, AddonManager.PERM_CAN_DISABLE));
    return check_test_completed(arguments);
  },

  onInstalling(aAddon, aRequiresRestart) {
    info(`Got onInstalling event for ${aAddon.id}`);
    let [event, expectedRestart] = getExpectedEvent(aAddon.id);
    Assert.equal("onInstalling", event);
    Assert.equal(aRequiresRestart, expectedRestart);
    if (expectedRestart) {
      Assert.ok(
        hasFlag(aAddon.pendingOperations, AddonManager.PENDING_INSTALL)
      );
    }
    return check_test_completed(arguments);
  },

  onInstalled(aAddon) {
    info(`Got onInstalled event for ${aAddon.id}`);
    let [event] = getExpectedEvent(aAddon.id);
    Assert.equal("onInstalled", event);
    return check_test_completed(arguments);
  },

  onUninstalling(aAddon, aRequiresRestart) {
    info(`Got onUninstalling event for ${aAddon.id}`);
    let [event, expectedRestart] = getExpectedEvent(aAddon.id);
    Assert.equal("onUninstalling", event);
    Assert.equal(aRequiresRestart, expectedRestart);
    if (expectedRestart) {
      Assert.ok(
        hasFlag(aAddon.pendingOperations, AddonManager.PENDING_UNINSTALL)
      );
    }
    return check_test_completed(arguments);
  },

  onUninstalled(aAddon) {
    info(`Got onUninstalled event for ${aAddon.id}`);
    let [event] = getExpectedEvent(aAddon.id);
    Assert.equal("onUninstalled", event);
    return check_test_completed(arguments);
  },

  onOperationCancelled(aAddon) {
    info(`Got onOperationCancelled event for ${aAddon.id}`);
    let [event] = getExpectedEvent(aAddon.id);
    Assert.equal("onOperationCancelled", event);
    return check_test_completed(arguments);
  },
};

const InstallListener = {
  onNewInstall(install) {
    if (
      install.state != AddonManager.STATE_DOWNLOADED &&
      install.state != AddonManager.STATE_DOWNLOAD_FAILED &&
      install.state != AddonManager.STATE_AVAILABLE
    ) {
      do_throw("Bad install state " + install.state);
    }
    if (install.state != AddonManager.STATE_DOWNLOAD_FAILED) {
      Assert.equal(install.error, 0);
    } else {
      Assert.notEqual(install.error, 0);
    }
    Assert.equal("onNewInstall", getExpectedInstall());
    return check_test_completed(arguments);
  },

  onDownloadStarted(install) {
    Assert.equal(install.state, AddonManager.STATE_DOWNLOADING);
    Assert.equal(install.error, 0);
    Assert.equal("onDownloadStarted", getExpectedInstall());
    return check_test_completed(arguments);
  },

  onDownloadEnded(install) {
    Assert.equal(install.state, AddonManager.STATE_DOWNLOADED);
    Assert.equal(install.error, 0);
    Assert.equal("onDownloadEnded", getExpectedInstall());
    return check_test_completed(arguments);
  },

  onDownloadFailed(install) {
    Assert.equal(install.state, AddonManager.STATE_DOWNLOAD_FAILED);
    Assert.equal("onDownloadFailed", getExpectedInstall());
    return check_test_completed(arguments);
  },

  onDownloadCancelled(install) {
    Assert.equal(install.state, AddonManager.STATE_CANCELLED);
    Assert.equal(install.error, 0);
    Assert.equal("onDownloadCancelled", getExpectedInstall());
    return check_test_completed(arguments);
  },

  onInstallStarted(install) {
    Assert.equal(install.state, AddonManager.STATE_INSTALLING);
    Assert.equal(install.error, 0);
    Assert.equal("onInstallStarted", getExpectedInstall(install.addon));
    return check_test_completed(arguments);
  },

  onInstallEnded(install, newAddon) {
    Assert.equal(install.state, AddonManager.STATE_INSTALLED);
    Assert.equal(install.error, 0);
    Assert.equal("onInstallEnded", getExpectedInstall(install.addon));
    return check_test_completed(arguments);
  },

  onInstallFailed(install) {
    Assert.equal(install.state, AddonManager.STATE_INSTALL_FAILED);
    Assert.equal("onInstallFailed", getExpectedInstall(install.addon));
    return check_test_completed(arguments);
  },

  onInstallCancelled(install) {
    // If the install was cancelled by a listener returning false from
    // onInstallStarted, then the state will revert to STATE_DOWNLOADED.
    let possibleStates = [
      AddonManager.STATE_CANCELLED,
      AddonManager.STATE_DOWNLOADED,
    ];
    Assert.ok(possibleStates.includes(install.state));
    Assert.equal(install.error, 0);
    Assert.equal("onInstallCancelled", getExpectedInstall(install.addon));
    return check_test_completed(arguments);
  },

  onExternalInstall(aAddon, existingAddon, aRequiresRestart) {
    Assert.equal("onExternalInstall", getExpectedInstall(aAddon));
    Assert.ok(!aRequiresRestart);
    return check_test_completed(arguments);
  },
};

function hasFlag(aBits, aFlag) {
  return (aBits & aFlag) != 0;
}

// Just a wrapper around setting the expected events.
function prepare_test(aExpectedEvents, aExpectedInstalls, aNext) {
  AddonManager.addAddonListener(AddonListener);
  AddonManager.addInstallListener(InstallListener);

  gExpectedInstalls = aExpectedInstalls;
  gExpectedEvents = aExpectedEvents;
  gNext = aNext;
}

function clearListeners() {
  AddonManager.removeAddonListener(AddonListener);
  AddonManager.removeInstallListener(InstallListener);
}

function end_test() {
  clearListeners();
}

// Checks if all expected events have been seen and if so calls the callback.
function check_test_completed(aArgs) {
  if (!gNext) {
    return undefined;
  }

  if (gExpectedInstalls instanceof Array && gExpectedInstalls.length) {
    return undefined;
  }

  for (let id in gExpectedInstalls) {
    let installList = gExpectedInstalls[id];
    if (installList.length) {
      return undefined;
    }
  }

  for (let id in gExpectedEvents) {
    if (gExpectedEvents[id].length) {
      return undefined;
    }
  }

  return gNext.apply(null, aArgs);
}

// Verifies that all the expected events for all add-ons were seen.
function ensure_test_completed() {
  for (let i in gExpectedEvents) {
    if (gExpectedEvents[i].length) {
      do_throw(
        `Didn't see all the expected events for ${i}: Still expecting ${gExpectedEvents[i]}`
      );
    }
  }
  gExpectedEvents = {};
  if (gExpectedInstalls) {
    Assert.equal(gExpectedInstalls.length, 0);
  }
}

/**
 * A helper method to install an array of AddonInstall to completion and then
 * call a provided callback.
 *
 * @param   aInstalls
 *          The array of AddonInstalls to install
 * @param   aCallback
 *          The callback to call when all installs have finished
 */
function completeAllInstalls(aInstalls, aCallback) {
  promiseCompleteAllInstalls(aInstalls).then(aCallback);
}

/**
 * A helper method to install an array of files and call a callback after the
 * installs are completed.
 *
 * @param   aFiles
 *          The array of files to install
 * @param   aCallback
 *          The callback to call when all installs have finished
 * @param   aIgnoreIncompatible
 *          Optional parameter to ignore add-ons that are incompatible in
 *          aome way with the application
 */
function installAllFiles(aFiles, aCallback, aIgnoreIncompatible) {
  promiseInstallAllFiles(aFiles, aIgnoreIncompatible).then(aCallback);
}

const EXTENSIONS_DB = "extensions.json";
var gExtensionsJSON = gProfD.clone();
gExtensionsJSON.append(EXTENSIONS_DB);

async function promiseInstallWebExtension(aData) {
  let addonFile = createTempWebExtensionFile(aData);

  let { addon } = await promiseInstallFile(addonFile);
  return addon;
}

// By default use strict compatibility.
Services.prefs.setBoolPref("extensions.strictCompatibility", true);

// Ensure signature checks are enabled by default.
Services.prefs.setBoolPref(PREF_XPI_SIGNATURES_REQUIRED, false);

Services.prefs.setBoolPref("extensions.legacy.enabled", true);

// Copies blocklistFile (an nsIFile) to gProfD/blocklist.xml.
function copyBlocklistToProfile(blocklistFile) {
  var dest = gProfD.clone();
  dest.append("blocklist.xml");
  if (dest.exists()) {
    dest.remove(false);
  }
  blocklistFile.copyTo(gProfD, "blocklist.xml");
  dest.lastModifiedTime = Date.now();
}

// Make sure that a given path does not exist.
function pathShouldntExist(file) {
  if (file.exists()) {
    do_throw(`Test cleanup: path ${file.path} exists when it should not`);
  }
}

// Wrap a function (typically a callback) to catch and report exceptions.
function do_exception_wrap(func) {
  return function() {
    try {
      func.apply(null, arguments);
    } catch (e) {
      do_report_unexpected_exception(e);
    }
  };
}

/**
 * Change the schema version of the JSON extensions database.
 */
async function changeXPIDBVersion(aNewVersion) {
  let json = await loadJSON(gExtensionsJSON.path);
  json.schemaVersion = aNewVersion;
  await saveJSON(json, gExtensionsJSON.path);
}

/**
 * Load a file into a string.
 */
async function loadFile(aFile) {
  let buffer = await OS.File.read(aFile);
  return new TextDecoder().decode(buffer);
}

/**
 * Raw load of a JSON file.
 */
async function loadJSON(aFile) {
  let data = await loadFile(aFile);
  info("Loaded JSON file " + aFile);
  return JSON.parse(data);
}

/**
 * Raw save of a JSON blob to file.
 */
async function saveJSON(aData, aFile) {
  info("Starting to save JSON file " + aFile);
  await OS.File.writeAtomic(
    aFile,
    new TextEncoder().encode(JSON.stringify(aData, null, 2))
  );
  info("Done saving JSON file " + aFile.path);
}

/**
 * Create a callback function that calls do_execute_soon on an actual callback and arguments.
 */
function callback_soon(aFunction) {
  return function(...args) {
    executeSoon(
      function() {
        aFunction.apply(null, args);
      },
      aFunction.name ? "delayed callback " + aFunction.name : "delayed callback"
    );
  };
}

XPCOMUtils.defineLazyServiceGetter(
  this,
  "pluginHost",
  "@mozilla.org/plugin/host;1",
  "nsIPluginHost"
);

class MockPluginTag {
  constructor(opts, enabledState = Ci.nsIPluginTag.STATE_ENABLED) {
    this.pluginTag = pluginHost.createFakePlugin({
      handlerURI: "resource://fake-plugin/${Math.random()}.xhtml",
      mimeEntries: [{ type: "application/x-fake-plugin" }],
      fileName: `${opts.name}.so`,
      ...opts,
    });
    this.pluginTag.enabledState = enabledState;

    this.name = opts.name;
    this.version = opts.version;
  }
  async isBlocklisted() {
    let state = await Blocklist.getPluginBlocklistState(this.pluginTag);
    return state == Services.blocklist.STATE_BLOCKED;
  }
  get disabled() {
    return this.pluginTag.enabledState == Ci.nsIPluginTag.STATE_DISABLED;
  }
  set disabled(val) {
    this.enabledState =
      Ci.nsIPluginTag[val ? "STATE_DISABLED" : "STATE_ENABLED"];
  }
  get enabledState() {
    return this.pluginTag.enabledState;
  }
  set enabledState(val) {
    this.pluginTag.enabledState = val;
  }
}

function mockPluginHost(plugins) {
  let PluginHost = {
    getPluginTags(count) {
      count.value = plugins.length;
      return plugins.map(p => p.pluginTag);
    },

    QueryInterface: ChromeUtils.generateQI(["nsIPluginHost"]),
  };

  MockRegistrar.register("@mozilla.org/plugin/host;1", PluginHost);
}

async function setInitialState(addon, initialState) {
  if (initialState.userDisabled) {
    await addon.disable();
  } else if (initialState.userDisabled === false) {
    await addon.enable();
  }
}

/**
 * Escapes any occurrences of &, ", < or > with XML entities.
 *
 * @param {string} str
 *        The string to escape.
 * @returns {string} The escaped string.
 */
function escapeXML(str) {
  let replacements = {
    "&": "&amp;",
    '"': "&quot;",
    "'": "&apos;",
    "<": "&lt;",
    ">": "&gt;",
  };
  return String(str).replace(/[&"''<>]/g, m => replacements[m]);
}

/**
 * A tagged template function which escapes any XML metacharacters in
 * interpolated values.
 *
 * @param {Array<string>} strings
 *        An array of literal strings extracted from the templates.
 * @param {Array} values
 *        An array of interpolated values extracted from the template.
 * @returns {string}
 *        The result of the escaped values interpolated with the literal
 *        strings.
 */
function escaped(strings, ...values) {
  let result = [];

  for (let [i, string] of strings.entries()) {
    result.push(string);
    if (i < values.length) {
      result.push(escapeXML(values[i]));
    }
  }

  return result.join("");
}

function _writeProps(obj, props, indent = "  ") {
  let items = [];
  for (let prop of props) {
    if (obj[prop] !== undefined) {
      items.push(escaped`${indent}<em:${prop}>${obj[prop]}</em:${prop}>\n`);
    }
  }
  return items.join("");
}

function _writeArrayProps(obj, props, indent = "  ") {
  let items = [];
  for (let prop of props) {
    for (let val of obj[prop] || []) {
      items.push(escaped`${indent}<em:${prop}>${val}</em:${prop}>\n`);
    }
  }
  return items.join("");
}

function _writeLocaleStrings(data) {
  let items = [];

  items.push(
    this._writeProps(data, ["name", "description", "creator", "homepageURL"])
  );
  items.push(
    this._writeArrayProps(data, ["developer", "translator", "contributor"])
  );

  return items.join("");
}

function createInstallRDF(data) {
  let defaults = {
    bootstrap: true,
    version: "1.0",
    name: `Test Extension ${data.id}`,
    targetApplications: [
      {
        id: "xpcshell@tests.mozilla.org",
        minVersion: "1",
        maxVersion: "64.*",
      },
    ],
  };

  var rdf = '<?xml version="1.0"?>\n';
  rdf +=
    '<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n' +
    '     xmlns:em="http://www.mozilla.org/2004/em-rdf#">\n';

  rdf += '<Description about="urn:mozilla:install-manifest">\n';

  data = Object.assign({}, defaults, data);

  let props = [
    "id",
    "version",
    "type",
    "internalName",
    "updateURL",
    "optionsURL",
    "optionsType",
    "aboutURL",
    "iconURL",
    "skinnable",
    "bootstrap",
    "strictCompatibility",
  ];
  rdf += _writeProps(data, props);

  rdf += _writeLocaleStrings(data);

  for (let platform of data.targetPlatforms || []) {
    rdf += escaped`<em:targetPlatform>${platform}</em:targetPlatform>\n`;
  }

  for (let app of data.targetApplications || []) {
    rdf += "<em:targetApplication><Description>\n";
    rdf += _writeProps(app, ["id", "minVersion", "maxVersion"]);
    rdf += "</Description></em:targetApplication>\n";
  }

  for (let localized of data.localized || []) {
    rdf += "<em:localized><Description>\n";
    rdf += _writeArrayProps(localized, ["locale"]);
    rdf += _writeLocaleStrings(localized);
    rdf += "</Description></em:localized>\n";
  }

  for (let dep of data.dependencies || []) {
    rdf += escaped`<em:dependency><Description em:id="${dep}"/></em:dependency>\n`;
  }

  rdf += "</Description>\n</RDF>\n";
  return rdf;
}
