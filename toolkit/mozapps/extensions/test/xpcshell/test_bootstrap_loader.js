/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const APP_ID = "xpcshell@tests.mozilla.org";
const BOOTSTRAP_ID = "bootstrap-loader@tests.mozilla.org";
const CLASSIC_ID = "classic-rdf-loader@tests.waterfox.net";
const DICTIONARY_ID = "dictionary-loader@tests.mozilla.org";
const OTHER_LOADER_ID = "other-loader@tests.mozilla.org";
const HYBRID_BOOTSTRAP_ID = "hybrid-bootstrap@tests.mozilla.org";
const HYBRID_XUL_ID = "hybrid-xul@tests.mozilla.org";
const RAW_PACKED_ID = "raw-packed-xul@tests.mozilla.org";
const RAW_UNPACKED_ID = "raw-unpacked-xul@tests.mozilla.org";
const LOCKED_SIDELOAD_ID = "locked-sideload-xul@tests.mozilla.org";
const SIGNED_RDF_ID = "ordinary-signed-rdf@tests.mozilla.org";
const GRANDFATHERED_HYBRID_ID = "grandfathered-hybrid@tests.waterfox.net";
const TEMP_RAW_FAILURE_ID = "temporary-raw-failure@tests.waterfox.net";
const TEMP_REPLACEMENT_ID = "temporary-replacement@tests.waterfox.net";
const CROSS_LOCATION_ID = "cross-location-classic@tests.waterfox.net";
const CROSS_LOCATION_CRASH_ID = "cross-location-crash@tests.waterfox.net";
const PERSISTENCE_CRASH_ID = "persistence-crash@tests.waterfox.net";
const ACTUAL_CLASSIC_UPDATE_ID = "actual-classic-update@tests.waterfox.net";
const RETAINED_SCOPE_ID = "retained-scope@tests.waterfox.net";
const APP_SHUTDOWN_ID = "app-shutdown-classic@tests.waterfox.net";
const SIGNING_MATRIX_IDS = {
  unsigned: "legacy-unsigned@tests.waterfox.net",
  ordinary: "legacy-ordinary@tests.waterfox.net",
  privileged: "legacy-privileged@tests.waterfox.net",
  system: "legacy-system@tests.waterfox.net",
  temporary: "legacy-temporary@tests.waterfox.net",
  builtin: "legacy-builtin@tests.waterfox.net",
};
const EVENTS_PREF = "test.bootstrap-loader.events";
const P0_EVENTS_PREF = "test.bootstrap-loader.p0-events";
const NOTIFICATION_PREF = "test.bootstrap-loader.profile-after-change";
const RESOURCE_NAME = "bootstrap-loader-owned";
const COMPONENT_CID = "{4f2b7f45-65bd-4f44-8813-704d012f3e22}";
const COMPONENT_CONTRACT = "@tests.mozilla.org/bootstrap-loader-observer;1";
const CATEGORY_ENTRY = "bootstrap-loader-observer";
const PREVIOUS_CATEGORY_VALUE = "@tests.mozilla.org/previous-observer;1";
const DEFAULT_PREFS = {
  bool: "test.bootstrap-loader.default.bool",
  int: "test.bootstrap-loader.default.int",
  string: "test.bootstrap-loader.default.string",
  float: "test.bootstrap-loader.default.float",
};
const HOST_OS = Services.appinfo.OS;
const TAB_MIX_SKIN_PATHS = {
  WINNT: "win",
  Darwin: "mac",
  Linux: "linux",
};
AddonTestUtils.updateAppInfo({
  ID: APP_ID,
  name: "XPCShell",
  version: "153.0",
  platformVersion: "153.0",
  OS: HOST_OS,
});
gUseRealCertChecks = true;
Services.prefs.unlockPref(PREF_XPI_SIGNATURES_REQUIRED);
Services.prefs.setBoolPref(PREF_XPI_SIGNATURES_REQUIRED, false);
Services.prefs.setBoolPref("extensions.blocklist.enabled", false);
Services.prefs.setBoolPref("extensions.skipInstallDefaultThemeForTests", true);

const { BootstrapLoader } = ChromeUtils.importESModule(
  "resource:///modules/BootstrapLoader.sys.mjs"
);
const { ChromeManifest } = ChromeUtils.importESModule(
  "resource:///modules/ChromeManifest.sys.mjs"
);
const { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);
const { LegacyChromeManifest } = ChromeUtils.importESModule(
  "resource:///modules/LegacyChromeManifest.sys.mjs"
);
const { LegacyComponentRegistry } = ChromeUtils.importESModule(
  "resource:///modules/LegacyComponentRegistry.sys.mjs"
);
AddonManager.addExternalExtensionLoader(BootstrapLoader);
BootstrapMonitor.init();

async function writeFilesToDir(dir, files) {
  await IOUtils.makeDirectory(dir);
  for (const [relativePath, data] of Object.entries(files)) {
    const path = PathUtils.join(dir, ...relativePath.split("/"));
    await IOUtils.makeDirectory(PathUtils.parent(path));
    if (
      typeof data === "object" &&
      ChromeUtils.getClassName(data) === "Object"
    ) {
      await IOUtils.writeJSON(path, data);
    } else if (typeof data === "string") {
      await IOUtils.writeUTF8(path, data);
    } else if (ChromeUtils.getClassName(data) === "ArrayBuffer") {
      await IOUtils.write(path, new Uint8Array(data));
    }
  }
  return new FileUtils.File(dir);
}

function createInstallRDF(contents) {
  return `<?xml version="1.0"?>
<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
     xmlns:em="http://www.mozilla.org/2004/em-rdf#">
  <Description about="urn:mozilla:install-manifest">
    ${contents}
  </Description>
</RDF>`;
}

function createRawManifestPackage(manifest, files = []) {
  const resources = new Set(files);
  return {
    async readString(path) {
      Assert.equal(path, "install.rdf");
      return manifest;
    },
    async hasResource(path) {
      return resources.has(path);
    },
    async iterFiles(callback) {
      for (const path of resources) {
        callback({ path, isDir: false });
      }
    },
  };
}

function createManifestPackage(contents, files = []) {
  return createRawManifestPackage(createInstallRDF(contents), files);
}

async function loadBootstrapManifest(pkg) {
  return BootstrapLoader.loadManifest(pkg);
}

function createDictionaryXPI() {
  return AddonTestUtils.createTempXPIFile({
    "install.rdf": createInstallRDF(`
    <em:id>${DICTIONARY_ID}</em:id>
    <em:type>64</em:type>
    <em:name>RDF dictionary</em:name>
    <em:description>Dictionary description</em:description>
    <em:creator>Dictionary author</em:creator>
    <em:version>2.0</em:version>
    <em:optionsURL>chrome://dictionary-loader/content/options.xhtml</em:optionsURL>
    <em:optionsType>1</em:optionsType>
    <em:aboutURL>chrome://dictionary-loader/content/about.xhtml</em:aboutURL>
    <em:targetApplication>
      <Description>
        <em:id>${APP_ID}</em:id>
        <em:minVersion>1</em:minVersion>
        <em:maxVersion>*</em:maxVersion>
      </Description>
    </em:targetApplication>
    `),
    "dictionaries/zz_ZZ.dic": "",
    "dictionaries/zz_ZZ.aff": "",
    "dictionaries/zz_Latn_ZZ.dic": "",
    "dictionaries/zz_Latn_ZZ.aff": "",
  });
}

function createClassicXPI() {
  return AddonTestUtils.createTempXPIFile({
    "install.rdf": createInstallRDF(`
    <em:id>${CLASSIC_ID}</em:id>
    <em:type>2</em:type>
    <em:name>Classic RDF extension</em:name>
    <em:version>1.0</em:version>
    <em:bootstrap>false</em:bootstrap>
    <em:unpack>true</em:unpack>
    <em:optionsURL>chrome://classic-loader/content/options.xhtml</em:optionsURL>
    <em:optionsType>3</em:optionsType>
    <em:targetApplication>
      <Description>
        <em:id>${APP_ID}</em:id>
        <em:minVersion>1</em:minVersion>
        <em:maxVersion>*</em:maxVersion>
      </Description>
    </em:targetApplication>
    `),
    "chrome.manifest": "content classic-loader content/",
    "content/options.xhtml": "<window/>",
  });
}

function createRawClassicFiles(
  id,
  name,
  chromePackage,
  version = "1.0",
  marker = name
) {
  return {
    "install.rdf": createInstallRDF(`
    <em:id>${id}</em:id>
    <em:type>2</em:type>
    <em:name>${name}</em:name>
    <em:version>${version}</em:version>
    <em:bootstrap>false</em:bootstrap>
    <em:targetApplication>
      <Description>
        <em:id>${APP_ID}</em:id>
        <em:minVersion>1</em:minVersion>
        <em:maxVersion>*</em:maxVersion>
      </Description>
    </em:targetApplication>
    `),
    "chrome.manifest": `content ${chromePackage} content/`,
    "content/marker.txt": marker,
  };
}

function createBootstrapFiles(version = "1.0") {
  return {
    "install.rdf": createInstallRDF(`
    <em:id>${BOOTSTRAP_ID}</em:id>
    <em:type>2</em:type>
    <em:name>Bootstrap loader test</em:name>
    <em:version>${version}</em:version>
    <em:bootstrap>true</em:bootstrap>
    <em:optionsURL>chrome://bootstrap-loader/content/options.xhtml</em:optionsURL>
    <em:optionsType>1</em:optionsType>
    <em:targetApplication>
      <Description>
        <em:id>${APP_ID}</em:id>
        <em:minVersion>1</em:minVersion>
        <em:maxVersion>*</em:maxVersion>
      </Description>
    </em:targetApplication>
    `),
    "bootstrap.js": `
function record(method, reason) {
  const pref = "${EVENTS_PREF}";
  const events = Services.prefs.getStringPref(pref, "");
  Services.prefs.setStringPref(pref, events + method + ":" + reason + ",");
}
const install = (data, reason) => {
  record("install", reason);
};
const uninstall = (data, reason) => {
  record("uninstall", reason);
};
const startup = (data, reason) => {
  record("startup", reason);
};
const shutdown = (data, reason) => {
  record("shutdown", reason);
};
`,
  };
}

function createBootstrapXPI() {
  return AddonTestUtils.createTempXPIFile({
    ...createBootstrapFiles(),
    "chrome.manifest": `content bootstrap-loader content/ platformversion>=153 contentaccessible=yes application=${APP_ID} appversion=153.0 abi=${Services.appinfo.OS}_${Services.appinfo.XPCOMABI}
content platform-match platform-match/ platformversion>=153 platformversion<1
content platform-mismatch platform-mismatch/ platformversion<153 platformversion>999 os=${Services.appinfo.OS}
content os-match os-match/ os=BootstrapLoaderTest os=${Services.appinfo.OS}
content os-mismatch os-mismatch/ platformversion>=153 os=BootstrapLoaderTest
content process-match process-match/ process=main
content process-mismatch process-mismatch/ process=content
content background-match background-match/ backgroundtask=false
content background-mismatch background-mismatch/ backgroundtask=true
locale bootstrap-loader en-US locale/
override chrome://bootstrap-loader/content/platform-override.xhtml content/override.xhtml platformversion>=153
override chrome://bootstrap-loader/content/os-override.xhtml content/override.xhtml os=BootstrapLoaderTest
skin bootstrap-loader classic/1.0 skin/
skin tabmixplus classic/1.0 chrome/skin/
skin tabmix-version tabmixplus chrome/skin/app_version/119/ platformversion>=119
skin tabmix-os classic/1.0 chrome://tabmix-version/skin/win/ os=WINNT
skin tabmix-os classic/1.0 chrome://tabmix-version/skin/mac/ os=Darwin
skin tabmix-os classic/1.0 chrome://tabmix-version/skin/linux/ os=Linux
manifest nested/chrome.manifest
`,
    "nested/chrome.manifest": `resource ${RESOURCE_NAME} resource/ contentaccessible=yes
component ${COMPONENT_CID} observer.js
contract ${COMPONENT_CONTRACT} ${COMPONENT_CID}
category profile-after-change ${CATEGORY_ENTRY} ${COMPONENT_CONTRACT}
`,
    "nested/observer.js": `
const { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
function BootstrapLoaderObserver() {}
BootstrapLoaderObserver.prototype = {
  classID: Components.ID("${COMPONENT_CID}"),
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe(_subject, topic) {
    if (topic === "profile-after-change") {
      const pref = "${NOTIFICATION_PREF}";
      Services.prefs.setIntPref(
        pref,
        Services.prefs.getIntPref(pref, 0) + 1
      );
    }
  },
};
const NSGetFactory = XPCOMUtils.generateNSGetFactory([
  BootstrapLoaderObserver,
]);
`,
    "nested/resource/value.txt": "owned resource",
    "background-match/value.txt": "background match",
    "background-mismatch/value.txt": "background mismatch",
    "defaults/preferences/bootstrap-loader.js": `
pref("${DEFAULT_PREFS.bool}", true);
pref("${DEFAULT_PREFS.int}", 42);
pref("${DEFAULT_PREFS.string}", "owned string");
pref("${DEFAULT_PREFS.float}", 3.5);
`,
    "content/options.xhtml": "<window/>",
    "content/os-override.xhtml": "<window/>",
    "content/override.xhtml": "<window/>",
    "content/platform-override.xhtml": "<window/>",
    "locale/strings.dtd": "<!ENTITY value 'locale'>",
    "os-match/value.txt": "os match",
    "os-mismatch/value.txt": "os mismatch",
    "platform-match/value.txt": "platform match",
    "platform-mismatch/value.txt": "platform mismatch",
    "process-match/value.txt": "process match",
    "process-mismatch/value.txt": "process mismatch",
    "skin/icon.svg": "<svg/>",
    "chrome/skin/app_version/119/linux/browser.css": ":root {}",
    "chrome/skin/app_version/119/linux/linux.css": ":root {}",
    "chrome/skin/app_version/119/mac/browser.css": ":root {}",
    "chrome/skin/app_version/119/mac/mac.css": ":root {}",
    "chrome/skin/app_version/119/win/browser.css": ":root {}",
    "chrome/skin/app_version/119/win/win.css": ":root {}",
  });
}

function createLifecycleBootstrapXPI(version) {
  return AddonTestUtils.createTempXPIFile(createBootstrapFiles(version));
}

function createHybridXPI(
  id,
  legacyType,
  includeBootstrap = false,
  legacyOptions = null
) {
  const legacy = { type: legacyType };
  if (legacyOptions) {
    legacy.options = legacyOptions;
  }
  const files = {
    "manifest.json": JSON.stringify({
      manifest_version: 2,
      name: `JSON ${legacyType} hybrid`,
      version: "2.0",
      browser_specific_settings: { gecko: { id } },
      legacy,
    }),
    "install.rdf": createInstallRDF(`
    <em:id>rdf-${id}</em:id>
    <em:type>2</em:type>
    <em:name>RDF hybrid</em:name>
    <em:version>1.0</em:version>
    <em:bootstrap>${legacyType === "xul"}</em:bootstrap>
    `),
  };
  if (legacyOptions?.page) {
    files[legacyOptions.page] = "<window/>";
  }
  if (includeBootstrap) {
    files["bootstrap.js"] = `
function install() {}
function uninstall() {}
function startup() {}
function shutdown() {}
`;
  }
  return AddonTestUtils.createTempXPIFile(files);
}

function createP0BootstrapScript(
  id,
  version,
  { failStartup = false, postponeUpdates = false } = {}
) {
  return `
function record(method, reason) {
  const pref = "${P0_EVENTS_PREF}";
  const events = Services.prefs.getStringPref(pref, "");
  Services.prefs.setStringPref(
    pref,
    events + "${id}:${version}:" + method + ":" + reason + ","
  );
}
function install(data, reason) {
  record("install", reason);
}
function uninstall(data, reason) {
  record("uninstall", reason);
}
function startup(data, reason) {
  record("startup", reason);
  ${
    postponeUpdates
      ? `const { AddonManagerPrivate } = ChromeUtils.importESModule(
    "resource://gre/modules/AddonManager.sys.mjs"
  );
  AddonManagerPrivate.addUpgradeListener(data.instanceID, () => {});`
      : ""
  }
  ${failStartup ? `throw new Error("intentional startup failure");` : ""}
}
function shutdown(data, reason) {
  record("shutdown", reason);
}
`;
}

function createRawBootstrapXPI(id, version, options = {}) {
  return AddonTestUtils.createTempXPIFile({
    "install.rdf": createInstallRDF(`
    <em:id>${id}</em:id>
    <em:type>2</em:type>
    <em:name>Raw bootstrap ${version}</em:name>
    <em:version>${version}</em:version>
    <em:bootstrap>true</em:bootstrap>
    <em:targetApplication>
      <Description>
        <em:id>${APP_ID}</em:id>
        <em:minVersion>1</em:minVersion>
        <em:maxVersion>*</em:maxVersion>
      </Description>
    </em:targetApplication>
    `),
    "bootstrap.js": createP0BootstrapScript(id, version, options),
  });
}

function createHybridBootstrapXPI(id, version, options = {}) {
  return AddonTestUtils.createTempXPIFile({
    "manifest.json": JSON.stringify({
      manifest_version: 2,
      name: `Hybrid bootstrap ${version}`,
      version,
      browser_specific_settings: { gecko: { id } },
      legacy: { type: "bootstrap" },
    }),
    "bootstrap.js": createP0BootstrapScript(id, version, options),
  });
}

function createClassicVersionXPI(id, version, chromePackage) {
  return AddonTestUtils.createTempXPIFile(
    createRawClassicFiles(
      id,
      `Classic ${version}`,
      chromePackage,
      version,
      version
    )
  );
}

function getP0Events(id = null) {
  const events = Services.prefs
    .getStringPref(P0_EVENTS_PREF, "")
    .split(",")
    .filter(Boolean);
  return id ? events.filter(event => event.startsWith(`${id}:`)) : events;
}

function clearP0Events() {
  Services.prefs.clearUserPref(P0_EVENTS_PREF);
}

async function readAddonStateSnapshot() {
  return {
    startup: await IOUtils.readJSON(AddonTestUtils.addonStartup.path, {
      decompress: true,
    }),
    database: await IOUtils.readJSON(gExtensionsJSON.path),
  };
}

async function writeAddonStateSnapshot({ startup, database }) {
  await IOUtils.writeJSON(AddonTestUtils.addonStartup.path, startup, {
    tmpPath: `${AddonTestUtils.addonStartup.path}.tmp`,
    compress: true,
  });
  await IOUtils.writeJSON(gExtensionsJSON.path, database, {
    tmpPath: `${gExtensionsJSON.path}.tmp`,
  });
}

async function removeAddonFromStateSnapshot(id) {
  const snapshot = await readAddonStateSnapshot();
  snapshot.database.addons = snapshot.database.addons.filter(
    addon => addon.id !== id
  );
  for (const location of Object.values(snapshot.startup)) {
    if (location.addons) {
      delete location.addons[id];
    }
    if (location.staged) {
      delete location.staged[id];
    }
  }
  await writeAddonStateSnapshot(snapshot);
  Services.prefs.setBoolPref("extensions.pendingOperations", false);
}

async function copyNamedXPI(source, id) {
  const target = do_get_tempdir();
  target.append(`${id}.xpi`);
  await IOUtils.remove(target.path, { ignoreAbsent: true });
  await IOUtils.copy(source.path, target.path);
  return target;
}

function getAppExtensionsDir() {
  const appRoot = Services.dirsvc.get("XREAddonAppDir", Ci.nsIFile);
  const extensions = appRoot.clone();
  extensions.append("extensions");
  if (!extensions.exists()) {
    extensions.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  }
  return extensions;
}

async function cleanupClassicProviderTest(
  id,
  appTargetPath,
  managerRunning,
  enabledScopes,
  sideloadScopes
) {
  if (managerRunning) {
    await promiseShutdownManager();
  }
  for (const path of [
    PathUtils.join(AddonTestUtils.profileExtensions.path, `${id}.xpi`),
    PathUtils.join(AddonTestUtils.profileExtensions.path, id),
    PathUtils.join(
      AddonTestUtils.profileExtensions.path,
      "staged",
      `${id}.xpi`
    ),
    appTargetPath,
  ]) {
    if (path) {
      await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
    }
  }
  await removeAddonFromStateSnapshot(id);
  Services.prefs.setIntPref("extensions.enabledScopes", enabledScopes);
  Services.prefs.setIntPref("extensions.sideloadScopes", sideloadScopes);
  await promiseStartupManager();
}

async function readChromeMarker(chromePackage) {
  const registry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(
    Ci.nsIChromeRegistry
  );
  const uri = registry.convertChromeURL(
    Services.io.newURI(`chrome://${chromePackage}/content/marker.txt`)
  );
  return (await fetch(uri.spec)).text();
}

function getBootstrapEvents() {
  return Services.prefs
    .getStringPref(EVENTS_PREF, "")
    .split(",")
    .filter(Boolean);
}

function clearBootstrapEvents() {
  Services.prefs.clearUserPref(EVENTS_PREF);
}

function getResourceProtocol() {
  return Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
}

function getComponentRegistrar() {
  return Components.manager.QueryInterface(Ci.nsIComponentRegistrar);
}

function removeOwnedCategoryEntry() {
  try {
    Services.catMan.deleteCategoryEntry(
      "profile-after-change",
      CATEGORY_ENTRY,
      false
    );
  } catch (error) {
    if (error.result !== Cr.NS_ERROR_NOT_AVAILABLE) {
      throw error;
    }
  }
}

function setOwnershipBaselines() {
  const defaultBranch = Services.prefs.getDefaultBranch("");
  for (const pref of Object.values(DEFAULT_PREFS)) {
    defaultBranch.deleteBranch(pref);
  }
  defaultBranch.setBoolPref(DEFAULT_PREFS.bool, false);
  defaultBranch.setStringPref(DEFAULT_PREFS.string, "previous string");
  Services.prefs.clearUserPref(NOTIFICATION_PREF);
  Services.catMan.addCategoryEntry(
    "profile-after-change",
    CATEGORY_ENTRY,
    PREVIOUS_CATEGORY_VALUE,
    false,
    true
  );
}

function clearOwnershipBaselines() {
  const defaultBranch = Services.prefs.getDefaultBranch("");
  for (const pref of Object.values(DEFAULT_PREFS)) {
    defaultBranch.deleteBranch(pref);
  }
  Services.prefs.clearUserPref(NOTIFICATION_PREF);
  removeOwnedCategoryEntry();
}

function assertOwnedRuntimeRegistered(notificationCount) {
  const resourceProtocol = getResourceProtocol();
  Assert.ok(resourceProtocol.hasSubstitution(RESOURCE_NAME));
  Assert.ok(
    resourceProtocol
      .getSubstitution(RESOURCE_NAME)
      .spec.endsWith("/nested/resource/")
  );

  const registrar = getComponentRegistrar();
  const cid = Components.ID(COMPONENT_CID);
  Assert.ok(registrar.isCIDRegistered(cid));
  Assert.ok(registrar.isContractIDRegistered(COMPONENT_CONTRACT));
  Assert.ok(registrar.contractIDToCID(COMPONENT_CONTRACT).equals(cid));
  Assert.ok(Cc[COMPONENT_CONTRACT].createInstance(Ci.nsIObserver));
  Assert.equal(
    Services.catMan.getCategoryEntry("profile-after-change", CATEGORY_ENTRY),
    COMPONENT_CONTRACT
  );
  Assert.equal(
    Services.prefs.getIntPref(NOTIFICATION_PREF, 0),
    notificationCount
  );

  const defaultBranch = Services.prefs.getDefaultBranch("");
  Assert.equal(defaultBranch.getBoolPref(DEFAULT_PREFS.bool), true);
  Assert.equal(defaultBranch.getIntPref(DEFAULT_PREFS.int), 42);
  Assert.equal(
    defaultBranch.getStringPref(DEFAULT_PREFS.string),
    "owned string"
  );
  Assert.equal(defaultBranch.getStringPref(DEFAULT_PREFS.float), "3.5");
}

function assertOwnedRuntimeRestored(notificationCount) {
  Assert.ok(!getResourceProtocol().hasSubstitution(RESOURCE_NAME));

  const registrar = getComponentRegistrar();
  Assert.ok(!registrar.isCIDRegistered(Components.ID(COMPONENT_CID)));
  Assert.ok(!registrar.isContractIDRegistered(COMPONENT_CONTRACT));
  Assert.equal(
    Services.catMan.getCategoryEntry("profile-after-change", CATEGORY_ENTRY),
    PREVIOUS_CATEGORY_VALUE
  );
  Assert.equal(
    Services.prefs.getIntPref(NOTIFICATION_PREF, 0),
    notificationCount
  );

  const defaultBranch = Services.prefs.getDefaultBranch("");
  Assert.equal(defaultBranch.getBoolPref(DEFAULT_PREFS.bool), false);
  Assert.equal(
    defaultBranch.getPrefType(DEFAULT_PREFS.int),
    Ci.nsIPrefBranch.PREF_INVALID
  );
  Assert.equal(
    defaultBranch.getStringPref(DEFAULT_PREFS.string),
    "previous string"
  );
  Assert.equal(
    defaultBranch.getPrefType(DEFAULT_PREFS.float),
    Ci.nsIPrefBranch.PREF_INVALID
  );
}

add_task(async function test_load_manifest_metadata() {
  const bootstrapAddon = await loadBootstrapManifest(
    createManifestPackage(
      `
      <em:id>${BOOTSTRAP_ID}</em:id>
      <em:type>2</em:type>
      <em:name>Bootstrap metadata</em:name>
      <em:description>Default description</em:description>
      <em:creator>Default creator</em:creator>
      <em:homepageURL>https://example.com/</em:homepageURL>
      <em:developer>Default developer</em:developer>
      <em:translator>Default translator</em:translator>
      <em:contributor>Default contributor</em:contributor>
      <em:version>1.0</em:version>
      <em:internalName>BootstrapMetadata</em:internalName>
      <em:updateURL>https://example.com/update.rdf</em:updateURL>
      <em:optionsURL>chrome://bootstrap-loader/content/options.xhtml</em:optionsURL>
      <em:optionsType>1</em:optionsType>
      <em:aboutURL>chrome://bootstrap-loader/content/about.xhtml</em:aboutURL>
      <em:iconURL>chrome://bootstrap-loader/content/icon.svg</em:iconURL>
      <em:bootstrap>true</em:bootstrap>
      <em:strictCompatibility>true</em:strictCompatibility>
      <em:targetApplication>
        <Description>
          <em:id>${APP_ID}</em:id>
          <em:minVersion>1</em:minVersion>
          <em:maxVersion>*</em:maxVersion>
        </Description>
      </em:targetApplication>
      <em:targetPlatform>${HOST_OS}_${Services.appinfo.XPCOMABI}</em:targetPlatform>
      <em:targetPlatform>${HOST_OS}</em:targetPlatform>
      <em:dependency><Description><em:id>dependency@tests.mozilla.org</em:id></Description></em:dependency>
      <em:dependency><Description><em:id>dependency@tests.mozilla.org</em:id></Description></em:dependency>
      <em:localized>
        <Description>
          <em:locale>fr</em:locale>
          <em:name>Nom localisé</em:name>
          <em:description>Description localisée</em:description>
          <em:developer>Développeur localisé</em:developer>
        </Description>
      </em:localized>
      `,
      ["bootstrap.js", "icon.png", "icon64.png"]
    )
  );

  Assert.equal(bootstrapAddon.id, BOOTSTRAP_ID);
  Assert.equal(bootstrapAddon.type, "extension");
  Assert.equal(bootstrapAddon.version, "1.0");
  Assert.equal(bootstrapAddon.manifestVersion, 2);
  Assert.equal(bootstrapAddon.internalName, "BootstrapMetadata");
  Assert.equal(bootstrapAddon.updateURL, "https://example.com/update.rdf");
  Assert.equal(
    bootstrapAddon.optionsURL,
    "chrome://bootstrap-loader/content/options.xhtml"
  );
  Assert.equal(bootstrapAddon.optionsType, AddonManager.OPTIONS_TYPE_DIALOG);
  Assert.equal(
    bootstrapAddon.aboutURL,
    "chrome://bootstrap-loader/content/about.xhtml"
  );
  Assert.equal(
    bootstrapAddon.iconURL,
    "chrome://bootstrap-loader/content/icon.svg"
  );
  Assert.ok(bootstrapAddon.strictCompatibility);
  Assert.ok(bootstrapAddon.bootstrap);
  Assert.deepEqual(bootstrapAddon.defaultLocale, {
    name: "Bootstrap metadata",
    description: "Default description",
    creator: "Default creator",
    homepageURL: "https://example.com/",
    developers: ["Default developer"],
    translators: ["Default translator"],
    contributors: ["Default contributor"],
  });
  Assert.deepEqual(bootstrapAddon.locales, [
    {
      locales: ["fr"],
      name: "Nom localisé",
      description: "Description localisée",
      developers: ["Développeur localisé"],
    },
  ]);
  Assert.deepEqual(bootstrapAddon.targetApplications, [
    { id: APP_ID, minVersion: "1", maxVersion: "*" },
  ]);
  Assert.deepEqual(bootstrapAddon.targetPlatforms, [
    { os: HOST_OS, abi: Services.appinfo.XPCOMABI },
    { os: HOST_OS, abi: null },
  ]);
  Assert.deepEqual(bootstrapAddon.dependencies, [
    "dependency@tests.mozilla.org",
  ]);
  Assert.ok(Object.isFrozen(bootstrapAddon.dependencies));
  Assert.deepEqual(bootstrapAddon.icons, {
    32: "icon.png",
    48: "icon.png",
    64: "icon64.png",
  });
  Assert.deepEqual(bootstrapAddon.startupData, {
    legacyMode: "bootstrap",
    legacyManifest: "rdf",
  });

  const classicAddon = await loadBootstrapManifest(
    createManifestPackage(`
      <em:id>${CLASSIC_ID}</em:id>
      <em:type>2</em:type>
      <em:name>Classic metadata</em:name>
      <em:version>1.0</em:version>
      <em:bootstrap>false</em:bootstrap>
      <em:optionsURL>chrome://classic-loader/content/options.xhtml</em:optionsURL>
      <em:optionsType>3</em:optionsType>
    `)
  );
  Assert.equal(classicAddon.id, CLASSIC_ID);
  Assert.equal(classicAddon.type, "extension");
  Assert.equal(classicAddon.version, "1.0");
  Assert.equal(classicAddon.manifestVersion, 2);
  Assert.deepEqual(classicAddon.defaultLocale, { name: "Classic metadata" });
  Assert.ok(!classicAddon.bootstrap);
  Assert.equal(classicAddon.optionsType, AddonManager.OPTIONS_TYPE_TAB);
  Assert.deepEqual(classicAddon.startupData, {
    legacyMode: "xul",
    legacyManifest: "rdf",
  });

  const unsupportedOptionsAddon = await loadBootstrapManifest(
    createManifestPackage(`
      <em:id>unsupported-options-type@tests.mozilla.org</em:id>
      <em:type>2</em:type>
      <em:name>Unsupported options type</em:name>
      <em:version>1.0</em:version>
      <em:optionsURL>chrome://unsupported-options/content/options.xhtml</em:optionsURL>
      <em:optionsType>2</em:optionsType>
    `)
  );
  Assert.equal(unsupportedOptionsAddon.optionsType, null);

  const legacyInlineOptionsAddon = await loadBootstrapManifest(
    createManifestPackage(`
      <em:id>legacy-inline-options@tests.mozilla.org</em:id>
      <em:type>2</em:type>
      <em:name>Legacy inline browser options</em:name>
      <em:version>1.0</em:version>
      <em:optionsURL>chrome://legacy-inline-options/content/options.xhtml</em:optionsURL>
      <em:optionsType>4</em:optionsType>
    `)
  );
  Assert.equal(
    legacyInlineOptionsAddon.optionsType,
    AddonManager.OPTIONS_TYPE_INLINE_BROWSER
  );

  const missingBootstrapFlagAddon = await loadBootstrapManifest(
    createManifestPackage(`
      <em:id>missing-bootstrap-flag@tests.mozilla.org</em:id>
      <em:type>2</em:type>
      <em:name>Missing bootstrap flag</em:name>
      <em:version>1.0</em:version>
      <em:optionsURL>chrome://missing-bootstrap/content/options.xhtml</em:optionsURL>
      <em:optionsType>5</em:optionsType>
    `)
  );
  Assert.ok(!missingBootstrapFlagAddon.bootstrap);
  Assert.equal(
    missingBootstrapFlagAddon.optionsType,
    AddonManager.OPTIONS_TYPE_INLINE_BROWSER
  );
  Assert.deepEqual(missingBootstrapFlagAddon.startupData, {
    legacyMode: "xul",
    legacyManifest: "rdf",
  });

  const missingScriptPackage = createManifestPackage(`
    <em:id>missing-bootstrap-script@tests.mozilla.org</em:id>
    <em:type>2</em:type>
    <em:name>Missing bootstrap script</em:name>
    <em:version>1.0</em:version>
    <em:bootstrap>true</em:bootstrap>
  `);
  await Assert.rejects(
    loadBootstrapManifest(missingScriptPackage),
    /Restartless extension is missing bootstrap\.js/
  );

  const dictionaryAddon = await loadBootstrapManifest(
    createManifestPackage(
      `
      <em:id>${DICTIONARY_ID}</em:id>
      <em:type>64</em:type>
      <em:name>Dictionary metadata</em:name>
      <em:description>Dictionary description</em:description>
      <em:creator>Dictionary creator</em:creator>
      <em:version>2.0</em:version>
      <em:bootstrap>false</em:bootstrap>
      <em:optionsURL>chrome://dictionary-loader/content/options.xhtml</em:optionsURL>
      <em:optionsType>1</em:optionsType>
      <em:aboutURL>chrome://dictionary-loader/content/about.xhtml</em:aboutURL>
      <em:strictCompatibility>true</em:strictCompatibility>
      <em:targetApplication>
        <Description>
          <em:id>${APP_ID}</em:id>
          <em:minVersion>1</em:minVersion>
          <em:maxVersion>*</em:maxVersion>
        </Description>
      </em:targetApplication>
      <em:targetPlatform>${HOST_OS}_${Services.appinfo.XPCOMABI}</em:targetPlatform>
      <em:dependency><Description><em:id>dependency@tests.mozilla.org</em:id></Description></em:dependency>
      <em:localized>
        <Description>
          <em:locale>de</em:locale>
          <em:name>Wörterbuch</em:name>
        </Description>
      </em:localized>
      `,
      [
        "dictionaries/en_US.dic",
        "dictionaries/en_US.aff",
        "dictionaries/sr_Latn_RS.dic",
        "dictionaries/sr_Latn_RS.aff",
        "dictionaries/nested/ignored.dic",
        "icon.png",
        "icon64.png",
      ]
    )
  );
  Assert.equal(dictionaryAddon.id, DICTIONARY_ID);
  Assert.equal(dictionaryAddon.type, "dictionary");
  Assert.equal(dictionaryAddon.version, "2.0");
  Assert.equal(dictionaryAddon.manifestVersion, 2);
  Assert.equal(dictionaryAddon.loader, null);
  Assert.ok(dictionaryAddon.strictCompatibility);
  Assert.ok(dictionaryAddon.bootstrap);
  Assert.deepEqual(dictionaryAddon.defaultLocale, {
    name: "Dictionary metadata",
    description: "Dictionary description",
    creator: "Dictionary creator",
  });
  Assert.deepEqual(dictionaryAddon.locales, [
    { locales: ["de"], name: "Wörterbuch" },
  ]);
  Assert.deepEqual(dictionaryAddon.targetApplications, [
    { id: APP_ID, minVersion: "1", maxVersion: "*" },
  ]);
  Assert.deepEqual(dictionaryAddon.targetPlatforms, [
    { os: HOST_OS, abi: Services.appinfo.XPCOMABI },
  ]);
  Assert.deepEqual(dictionaryAddon.dependencies, [
    "dependency@tests.mozilla.org",
  ]);
  Assert.deepEqual(dictionaryAddon.icons, {
    32: "icon.png",
    48: "icon.png",
    64: "icon64.png",
  });
  Assert.equal(dictionaryAddon.optionsURL, null);
  Assert.equal(dictionaryAddon.optionsType, null);
  Assert.equal(dictionaryAddon.aboutURL, null);
  Assert.deepEqual(dictionaryAddon.startupData, {
    dictionaries: {
      "en-US": "dictionaries/en_US.dic",
      "sr-Latn-RS": "dictionaries/sr_Latn_RS.dic",
    },
  });
});

add_task(async function test_install_rdf_graph_references() {
  const graphID = "rdf-graph@tests.mozilla.org";
  const dependencyID = "rdf-graph-dependency@tests.mozilla.org";
  const manifest = `<?xml version="1.0"?>
    <RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns:em="http://www.mozilla.org/2004/em-rdf#">
      <Description about="urn:mozilla:install-manifest"
                   em:id="${graphID}"
                   em:type="2"
                   em:version="1.0">
        <em:name>RDF graph extension</em:name>
        <em:targetApplication resource="#target-application" />
        <em:targetPlatform>
          <Seq>
            <li>${HOST_OS}_${Services.appinfo.XPCOMABI}</li>
            <li>${HOST_OS}</li>
          </Seq>
        </em:targetPlatform>
        <em:dependency>
          <Bag>
            <li nodeID="dependency" />
          </Bag>
        </em:dependency>
        <em:localized parseType="Resource">
          <em:locale>es-ES</em:locale>
          <em:name>Extensión RDF</em:name>
        </em:localized>
      </Description>
      <Description ID="target-application">
        <em:id>${APP_ID}</em:id>
        <em:minVersion>1</em:minVersion>
        <em:maxVersion>*</em:maxVersion>
      </Description>
      <Description nodeID="dependency">
        <em:id>${dependencyID}</em:id>
      </Description>
    </RDF>`;

  const addon = await loadBootstrapManifest(createRawManifestPackage(manifest));
  Assert.equal(addon.id, graphID);
  Assert.deepEqual(addon.targetApplications, [
    { id: APP_ID, minVersion: "1", maxVersion: "*" },
  ]);
  Assert.deepEqual(addon.targetPlatforms, [
    { os: HOST_OS, abi: Services.appinfo.XPCOMABI },
    { os: HOST_OS, abi: null },
  ]);
  Assert.deepEqual(addon.dependencies, [dependencyID]);
  Assert.deepEqual(addon.locales, [
    { locales: ["es-ES"], name: "Extensión RDF" },
  ]);

  const { InstallRDF } = ChromeUtils.importESModule(
    "resource:///modules/RDFManifestConverter.sys.mjs"
  );
  Assert.equal(
    InstallRDF.loadFromBuffer(new TextEncoder().encode(manifest)).decode().id,
    graphID
  );

  const file = gTmpD.clone();
  file.append("rdf-graph-install.rdf");
  file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o644);
  await IOUtils.writeUTF8(file.path, manifest);
  try {
    Assert.equal((await InstallRDF.loadFromFile(file)).decode().id, graphID);
  } finally {
    file.remove(false);
  }
});

add_task(async function test_chrome_manifest_boolean_conditions() {
  const manifest = new ChromeManifest(null, {
    backgroundtask: false,
    tablet: false,
  });
  await manifest.parseString(`
content background-match background/ backgroundtask=false
content background-mismatch background/ backgroundtask=true
content tablet-match tablet/ tablet=false
content tablet-mismatch tablet/ tablet=true
`);

  Assert.equal(manifest.content.get("background-match"), "background/");
  Assert.ok(!manifest.content.has("background-mismatch"));
  Assert.equal(manifest.content.get("tablet-match"), "tablet/");
  Assert.ok(!manifest.content.has("tablet-mismatch"));
});

add_task(async function test_tracked_default_preference_ownership() {
  const prefName = "test.bootstrap-loader.tracked-default-owner";
  const baselineValue = "baseline default";
  const firstValue = "first registration";
  const secondValue = "second registration";
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const tempRoot = gTmpD.clone();
  tempRoot.append("bootstrap-loader-default-pref-owners");
  tempRoot.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);

  let registrations = [];
  try {
    const firstDirectory = await writeFilesToDir(
      PathUtils.join(tempRoot.path, "first-registration"),
      {
        "defaults/preferences/first.js": `pref("${prefName}", "${firstValue}");`,
      }
    );
    const secondDirectory = await writeFilesToDir(
      PathUtils.join(tempRoot.path, "second-registration"),
      {
        "defaults/preferences/second.js": `pref("${prefName}", "${secondValue}");`,
      }
    );

    const runScenario = async (unloadOrder, externalMutation) => {
      defaultBranch.deleteBranch(prefName);
      defaultBranch.setStringPref(prefName, baselineValue);
      registrations = [
        await ExtensionSupport.loadAddonPrefs(firstDirectory, {
          trackChanges: true,
        }),
        await ExtensionSupport.loadAddonPrefs(secondDirectory, {
          trackChanges: true,
        }),
      ];
      Assert.equal(defaultBranch.getStringPref(prefName), secondValue);

      const externalValue = externalMutation
        ? `external mutation ${unloadOrder.join("-")}`
        : null;
      if (externalValue) {
        defaultBranch.setStringPref(prefName, externalValue);
      }

      registrations[unloadOrder[0]].unregister();
      Assert.equal(
        defaultBranch.getStringPref(prefName),
        externalValue ?? (unloadOrder[0] === 0 ? secondValue : firstValue),
        `First unload in order ${unloadOrder.join("-")} restores safely`
      );

      registrations[unloadOrder[1]].unregister();
      Assert.equal(
        defaultBranch.getStringPref(prefName),
        externalValue ?? baselineValue,
        `Second unload in order ${unloadOrder.join("-")} restores safely`
      );
      registrations = [];
    };

    for (const externalMutation of [false, true]) {
      await runScenario([0, 1], externalMutation);
      await runScenario([1, 0], externalMutation);
    }
  } finally {
    for (const registration of registrations.reverse()) {
      registration?.unregister();
    }
    defaultBranch.deleteBranch(prefName);
    if (tempRoot.exists()) {
      tempRoot.remove(true);
    }
  }
});

add_task(async function test_tracked_user_preference_ownership() {
  const prefName = "test.bootstrap-loader.tracked-user-owner";
  const baselineValue = "baseline user";
  const firstValue = "first registration";
  const secondValue = "second registration";
  const tempRoot = gTmpD.clone();
  tempRoot.append("bootstrap-loader-user-pref-owners");
  tempRoot.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);

  let registrations = [];
  try {
    const firstDirectory = await writeFilesToDir(
      PathUtils.join(tempRoot.path, "first-registration"),
      {
        "defaults/preferences/first.js": `user_pref("${prefName}", "${firstValue}");`,
      }
    );
    const secondDirectory = await writeFilesToDir(
      PathUtils.join(tempRoot.path, "second-registration"),
      {
        "defaults/preferences/second.js": `user_pref("${prefName}", "${secondValue}");`,
      }
    );

    const runScenario = async (unloadOrder, hasBaseline) => {
      Services.prefs.clearUserPref(prefName);
      if (hasBaseline) {
        Services.prefs.setStringPref(prefName, baselineValue);
      }
      registrations = [
        await ExtensionSupport.loadAddonPrefs(firstDirectory, {
          trackChanges: true,
        }),
        await ExtensionSupport.loadAddonPrefs(secondDirectory, {
          trackChanges: true,
        }),
      ];
      Assert.equal(Services.prefs.getStringPref(prefName), secondValue);

      registrations[unloadOrder[0]].unregister();
      Assert.equal(
        Services.prefs.getStringPref(prefName),
        unloadOrder[0] === 0 ? secondValue : firstValue,
        `First user-pref unload in order ${unloadOrder.join("-")} restores the live owner`
      );

      registrations[unloadOrder[1]].unregister();
      Assert.equal(
        Services.prefs.prefHasUserValue(prefName),
        hasBaseline,
        `Final user-pref unload in order ${unloadOrder.join("-")} restores presence`
      );
      if (hasBaseline) {
        Assert.equal(Services.prefs.getStringPref(prefName), baselineValue);
      }
      registrations = [];
    };

    for (const hasBaseline of [false, true]) {
      await runScenario([0, 1], hasBaseline);
      await runScenario([1, 0], hasBaseline);
    }
  } finally {
    for (const registration of registrations.reverse()) {
      registration?.unregister();
    }
    Services.prefs.clearUserPref(prefName);
    if (tempRoot.exists()) {
      tempRoot.remove(true);
    }
  }
});

add_task(async function test_legacy_component_registry_ownership() {
  const contractId = "@tests.mozilla.org/bootstrap-loader-shared-component;1";
  const category = "bootstrap-loader-component-ownership";
  const categoryEntry = "shared-component";
  const firstCategoryValue = "first-component-owner";
  const secondCategoryValue = "second-component-owner";
  const externalCategoryValue = "external-component-owner";
  const firstCID = Components.ID("{80d6a327-6e23-4d86-9f79-51c0fe801a31}");
  const secondCID = Components.ID("{8f934f20-c19c-45d0-a0b1-34d8f8309e45}");
  const externalCID = Components.ID("{4e99971a-52e6-4d77-9c94-80b68af4c632}");
  const registrar = getComponentRegistrar();
  const tempRoot = gTmpD.clone();
  tempRoot.append("bootstrap-loader-component-owners");
  tempRoot.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);

  const removeCategoryEntry = () => {
    try {
      Services.catMan.deleteCategoryEntry(category, categoryEntry, false);
    } catch (error) {
      if (error.result !== Cr.NS_ERROR_NOT_AVAILABLE) {
        throw error;
      }
    }
  };
  const assertCategoryMissing = message =>
    Assert.throws(
      () => Services.catMan.getCategoryEntry(category, categoryEntry),
      error => error.result === Cr.NS_ERROR_NOT_AVAILABLE,
      message
    );
  const assertOwner = (cid, categoryValue, message) => {
    Assert.ok(registrar.isContractIDRegistered(contractId), message);
    Assert.ok(registrar.contractIDToCID(contractId).equals(cid), message);
    Assert.equal(
      Services.catMan.getCategoryEntry(category, categoryEntry),
      categoryValue,
      message
    );
  };
  const createComponentManifest = async (
    directoryName,
    extensionId,
    cid,
    className,
    categoryValue
  ) => {
    const directory = await writeFilesToDir(
      PathUtils.join(tempRoot.path, directoryName),
      {
        "chrome.manifest": `component ${cid} component.js\ncontract ${contractId} ${cid}\ncategory ${category} ${categoryEntry} ${categoryValue}\n`,
        "component.js": `
const { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
function ${className}() {}
${className}.prototype = {
  classID: Components.ID("${cid}"),
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe() {},
};
const NSGetFactory = XPCOMUtils.generateNSGetFactory([${className}]);
`,
      }
    );
    return new LegacyChromeManifest(
      {
        id: extensionId,
        rootURI: Services.io.newFileURI(directory),
      },
      console
    ).parse();
  };

  try {
    const firstManifest = await createComponentManifest(
      "first-component",
      "component-registry-first@tests.mozilla.org",
      firstCID,
      "FirstRegistryComponent",
      firstCategoryValue
    );
    const secondManifest = await createComponentManifest(
      "second-component",
      "component-registry-second@tests.mozilla.org",
      secondCID,
      "SecondRegistryComponent",
      secondCategoryValue
    );

    const runScenario = async (unloadOrder, externalMutation) => {
      removeCategoryEntry();
      const registries = [
        new LegacyComponentRegistry(firstManifest, console),
        new LegacyComponentRegistry(secondManifest, console),
      ];
      const externalFactory = {
        createInstance() {
          throw Components.Exception("", Cr.NS_ERROR_NOT_IMPLEMENTED);
        },
        QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
      };
      let externalRegistered = false;

      try {
        await registries[0].register();
        assertOwner(firstCID, firstCategoryValue, "First owner is registered");
        await registries[1].register();
        assertOwner(
          secondCID,
          secondCategoryValue,
          "Second owner is registered"
        );

        if (externalMutation) {
          registrar.registerFactory(
            externalCID,
            "External component owner",
            contractId,
            externalFactory
          );
          externalRegistered = true;
          Services.catMan.addCategoryEntry(
            category,
            categoryEntry,
            externalCategoryValue,
            false,
            true
          );
        }

        registries[unloadOrder[0]].unregister();
        if (externalMutation) {
          assertOwner(
            externalCID,
            externalCategoryValue,
            `External owner survives first unload in order ${unloadOrder.join("-")}`
          );
        } else {
          assertOwner(
            unloadOrder[0] === 0 ? secondCID : firstCID,
            unloadOrder[0] === 0 ? secondCategoryValue : firstCategoryValue,
            `First unload in order ${unloadOrder.join("-")} restores the live owner`
          );
        }

        registries[unloadOrder[1]].unregister();
        if (externalMutation) {
          assertOwner(
            externalCID,
            externalCategoryValue,
            `External owner survives second unload in order ${unloadOrder.join("-")}`
          );
        } else {
          Assert.ok(
            !registrar.isContractIDRegistered(contractId),
            `Contract is removed after unload order ${unloadOrder.join("-")}`
          );
          assertCategoryMissing(
            `Category is removed after unload order ${unloadOrder.join("-")}`
          );
        }

        Assert.ok(!registrar.isCIDRegistered(firstCID));
        Assert.ok(!registrar.isCIDRegistered(secondCID));
      } finally {
        registries[1].unregister();
        registries[0].unregister();
        if (externalRegistered && registrar.isCIDRegistered(externalCID)) {
          registrar.unregisterFactory(externalCID, externalFactory);
        }
        removeCategoryEntry();
      }

      Assert.ok(
        !registrar.isContractIDRegistered(contractId),
        "No stale contract owner remains"
      );
      assertCategoryMissing("No stale category owner remains");
    };

    for (const externalMutation of [false, true]) {
      await runScenario([0, 1], externalMutation);
      await runScenario([1, 0], externalMutation);
    }
  } finally {
    removeCategoryEntry();
    if (tempRoot.exists()) {
      tempRoot.remove(true);
    }
  }
});

add_task(async function test_component_live_instance_unload() {
  const cid = Components.ID("{e918374d-b157-43c9-803d-7f609d029bcc}");
  const contractId = "@tests.waterfox.net/live-legacy-component;1";
  const retainedContractId =
    "@tests.waterfox.net/retained-live-legacy-component;1";
  const replacementCID = Components.ID(
    "{5b6a6e91-3247-4a63-b12d-aa3033443ff5}"
  );
  const replacementFactory = {
    createInstance() {
      throw Components.Exception("", Cr.NS_ERROR_NOT_IMPLEMENTED);
    },
    QueryInterface: ChromeUtils.generateQI(["nsIFactory"]),
  };
  const prefName = "test.bootstrap-loader.live-component";
  const root = gTmpD.clone();
  root.append("bootstrap-loader-live-component");
  root.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  const directory = await writeFilesToDir(root.path, {
    "chrome.manifest": `component ${cid} component.js\ncontract ${contractId} ${cid}\n`,
    "component.js": `
const { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
function LiveLegacyComponent() {}
LiveLegacyComponent.prototype = {
  classID: Components.ID("${cid}"),
  QueryInterface: ChromeUtils.generateQI(["nsIObserver"]),
  observe(_subject, _topic, data) {
    Services.prefs.setStringPref("${prefName}", data);
  },
};
const NSGetFactory = XPCOMUtils.generateNSGetFactory([LiveLegacyComponent]);
`,
  });
  const manifest = await new LegacyChromeManifest(
    {
      id: "live-legacy-component@tests.waterfox.net",
      rootURI: Services.io.newFileURI(directory),
    },
    console
  ).parse();
  const registry = new LegacyComponentRegistry(manifest, console);
  const registrar = getComponentRegistrar();

  try {
    await registry.register();
    const factory = Components.manager.getClassObject(cid, Ci.nsIFactory);
    const instance = Cc[contractId].createInstance(Ci.nsIObserver);
    registrar.registerFactory(cid, "", retainedContractId, null);

    registry.unregister();
    Assert.ok(!registrar.isContractIDRegistered(contractId));
    Assert.ok(registrar.isCIDRegistered(cid));
    Assert.ok(
      registrar.contractIDToCID(retainedContractId).equals(cid),
      "The external contract retains the legacy factory"
    );

    registrar.registerFactory(
      replacementCID,
      "Replacement owner",
      retainedContractId,
      replacementFactory
    );
    await TestUtils.waitForCondition(
      () => !registrar.isCIDRegistered(cid),
      "The released legacy factory is cleaned up without another registration"
    );

    Cu.forceGC();
    Cu.forceCC();
    instance.observe(null, "live-instance", "retained-instance");
    Assert.equal(Services.prefs.getStringPref(prefName), "retained-instance");

    const retainedFactoryInstance = factory.createInstance(Ci.nsIObserver);
    retainedFactoryInstance.observe(null, "live-factory", "retained-factory");
    Assert.equal(Services.prefs.getStringPref(prefName), "retained-factory");
  } finally {
    registry.unregister();
    if (registrar.isCIDRegistered(replacementCID)) {
      registrar.unregisterFactory(replacementCID, replacementFactory);
    }
    Services.prefs.clearUserPref(prefName);
    root.remove(true);
  }
});

registerCleanupFunction(async () => {
  for (const id of [
    BOOTSTRAP_ID,
    CLASSIC_ID,
    DICTIONARY_ID,
    OTHER_LOADER_ID,
    HYBRID_BOOTSTRAP_ID,
    HYBRID_XUL_ID,
    RAW_PACKED_ID,
    RAW_UNPACKED_ID,
    LOCKED_SIDELOAD_ID,
    GRANDFATHERED_HYBRID_ID,
    TEMP_RAW_FAILURE_ID,
    TEMP_REPLACEMENT_ID,
    CROSS_LOCATION_ID,
    CROSS_LOCATION_CRASH_ID,
    ACTUAL_CLASSIC_UPDATE_ID,
    RETAINED_SCOPE_ID,
    ...Object.values(SIGNING_MATRIX_IDS),
  ]) {
    const addon = await AddonManager.getAddonByID(id);
    if (addon) {
      await addon.uninstall();
    }
  }
  for (const path of [
    PathUtils.join(
      AddonTestUtils.profileExtensions.path,
      `${RAW_PACKED_ID}.xpi`
    ),
    PathUtils.join(AddonTestUtils.profileExtensions.path, RAW_UNPACKED_ID),
  ]) {
    await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
  }
  clearOwnershipBaselines();
  clearBootstrapEvents();
  clearP0Events();
  Services.prefs.clearUserPref(PREF_XPI_SIGNATURES_REQUIRED);
  Services.prefs.clearUserPref("extensions.blocklist.enabled");
  Services.prefs.clearUserPref("extensions.skipInstallDefaultThemeForTests");
  gUseRealCertChecks = false;
});

add_task(async function test_bootstrap_loader() {
  await promiseStartupManager();
  clearBootstrapEvents();
  setOwnershipBaselines();

  const install = await promiseInstallFile(createBootstrapXPI());
  const addon = install.addon;

  Assert.equal(addon.id, BOOTSTRAP_ID);
  Assert.equal(addon.name, "Bootstrap loader test");
  const internalAddon = addon.__AddonInternal__;
  Assert.equal(internalAddon.loader, "bootstrap");
  Assert.deepEqual(internalAddon.startupData, {
    legacyMode: "bootstrap",
    legacyManifest: "rdf",
  });
  Assert.ok(!addon.isWebExtension);
  Assert.ok(!addon.appDisabled);
  Assert.ok(addon.isActive);
  Assert.equal(addon.optionsType, AddonManager.OPTIONS_TYPE_DIALOG);
  Assert.equal(
    addon.optionsURL,
    "chrome://bootstrap-loader/content/options.xhtml"
  );
  Assert.notEqual(addon.signedState, AddonManager.SIGNEDSTATE_PRIVILEGED);
  assertOwnedRuntimeRegistered(1);

  const chromeRegistry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(
    Ci.nsIChromeRegistry
  );
  const convertChromeURL = url =>
    chromeRegistry.convertChromeURL(Services.io.newURI(url));
  const assertChromeURLMissing = (url, message) =>
    Assert.throws(
      () => convertChromeURL(url),
      error => error.result === Cr.NS_ERROR_FILE_NOT_FOUND,
      message
    );
  const contentURI = convertChromeURL(
    "chrome://bootstrap-loader/content/options.xhtml"
  );
  const skinURI = convertChromeURL("chrome://bootstrap-loader/skin/icon.svg");
  const localeURI = convertChromeURL(
    "chrome://bootstrap-loader/locale/strings.dtd"
  );
  const platformMatchURI = convertChromeURL(
    "chrome://platform-match/content/value.txt"
  );
  const osMatchURI = convertChromeURL("chrome://os-match/content/value.txt");
  const processMatchURI = convertChromeURL(
    "chrome://process-match/content/value.txt"
  );
  const backgroundMatchURI = convertChromeURL(
    "chrome://background-match/content/value.txt"
  );
  const platformOverrideURI = convertChromeURL(
    "chrome://bootstrap-loader/content/platform-override.xhtml"
  );
  const osOverrideURI = convertChromeURL(
    "chrome://bootstrap-loader/content/os-override.xhtml"
  );
  Assert.ok(contentURI.spec.endsWith("/content/options.xhtml"));
  Assert.ok(skinURI.spec.endsWith("/skin/icon.svg"));
  Assert.ok(localeURI.spec.endsWith("/locale/strings.dtd"));
  Assert.ok(platformMatchURI.spec.endsWith("/platform-match/value.txt"));
  Assert.ok(osMatchURI.spec.endsWith("/os-match/value.txt"));
  Assert.ok(processMatchURI.spec.endsWith("/process-match/value.txt"));
  Assert.ok(backgroundMatchURI.spec.endsWith("/background-match/value.txt"));
  Assert.ok(platformOverrideURI.spec.endsWith("/content/override.xhtml"));
  Assert.ok(osOverrideURI.spec.endsWith("/content/os-override.xhtml"));

  assertChromeURLMissing(
    "chrome://platform-mismatch/content/value.txt",
    "Nonmatching platform conditions should not register content"
  );
  assertChromeURLMissing(
    "chrome://os-mismatch/content/value.txt",
    "Nonmatching OS conditions should not register content"
  );
  assertChromeURLMissing(
    "chrome://process-mismatch/content/value.txt",
    "Content-process conditions should not register in the parent"
  );
  assertChromeURLMissing(
    "chrome://background-mismatch/content/value.txt",
    "Background-task-only content should not register in normal mode"
  );

  const hostSkinPath = TAB_MIX_SKIN_PATHS[Services.appinfo.OS];
  Assert.ok(hostSkinPath, `Tab Mix Plus supports ${Services.appinfo.OS}`);
  const aliasedSkinURI = convertChromeURL(
    "chrome://tabmix-os/skin/browser.css"
  );
  const hostSpecificSkinURI = convertChromeURL(
    `chrome://tabmix-os/skin/${hostSkinPath}.css`
  );
  const parsedManifest = await new LegacyChromeManifest(
    {
      id: addon.id,
      rootURI: internalAddon.resolvedRootURI,
    },
    console
  ).parse();
  Assert.ok(
    parsedManifest.resource.get(RESOURCE_NAME).endsWith("/nested/resource/")
  );
  Assert.ok(
    parsedManifest.component
      .get(Components.ID(COMPONENT_CID).toString())
      .endsWith("/nested/observer.js")
  );
  Assert.equal(
    parsedManifest.contract.get(COMPONENT_CONTRACT),
    Components.ID(COMPONENT_CID).toString()
  );
  Assert.equal(
    parsedManifest.category.get("profile-after-change").get(CATEGORY_ENTRY),
    COMPONENT_CONTRACT
  );
  Assert.equal(
    parsedManifest.override.get("chrome://tabmix-os/skin/browser.css"),
    aliasedSkinURI.spec
  );
  Assert.equal(
    parsedManifest.override.get(`chrome://tabmix-os/skin/${hostSkinPath}.css`),
    hostSpecificSkinURI.spec
  );
  Assert.ok(
    aliasedSkinURI.spec.endsWith(
      `/chrome/skin/app_version/119/${hostSkinPath}/browser.css`
    )
  );
  Assert.ok(
    hostSpecificSkinURI.spec.endsWith(
      `/chrome/skin/app_version/119/${hostSkinPath}/${hostSkinPath}.css`
    )
  );

  const nonmatchingSkinPath = Object.values(TAB_MIX_SKIN_PATHS).find(
    path => path !== hostSkinPath
  );
  Assert.ok(
    !parsedManifest.override.has(
      `chrome://tabmix-os/skin/${nonmatchingSkinPath}.css`
    )
  );

  Assert.deepEqual(getBootstrapEvents(), [
    `install:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
  ]);

  await addon.disable();
  Assert.ok(!addon.isActive);
  Assert.equal(addon.optionsType, null);
  assertOwnedRuntimeRestored(1);
  assertChromeURLMissing(
    "chrome://bootstrap-loader/content/options.xhtml",
    "Content registration should be removed while disabled"
  );
  assertChromeURLMissing(
    "chrome://tabmix-os/skin/browser.css",
    "Skin aliases should be removed while disabled"
  );
  Assert.deepEqual(getBootstrapEvents(), [
    `install:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `shutdown:${BOOTSTRAP_REASONS.ADDON_DISABLE}`,
  ]);

  await addon.enable();
  Assert.ok(addon.isActive);
  Assert.equal(addon.optionsType, AddonManager.OPTIONS_TYPE_DIALOG);
  assertOwnedRuntimeRegistered(2);
  Assert.ok(
    convertChromeURL(
      "chrome://bootstrap-loader/content/options.xhtml"
    ).spec.endsWith("/content/options.xhtml")
  );
  Assert.ok(
    convertChromeURL("chrome://tabmix-os/skin/browser.css").spec.endsWith(
      `/chrome/skin/app_version/119/${hostSkinPath}/browser.css`
    )
  );
  Assert.deepEqual(getBootstrapEvents(), [
    `install:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `shutdown:${BOOTSTRAP_REASONS.ADDON_DISABLE}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_ENABLE}`,
  ]);

  await addon.uninstall();
  assertOwnedRuntimeRestored(2);
  assertChromeURLMissing(
    "chrome://bootstrap-loader/content/options.xhtml",
    "Content registration should be removed after uninstall"
  );
  assertChromeURLMissing(
    "chrome://tabmix-os/skin/browser.css",
    "Skin aliases should be removed after uninstall"
  );
  Assert.deepEqual(getBootstrapEvents(), [
    `install:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `shutdown:${BOOTSTRAP_REASONS.ADDON_DISABLE}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_ENABLE}`,
    `shutdown:${BOOTSTRAP_REASONS.ADDON_UNINSTALL}`,
    `uninstall:${BOOTSTRAP_REASONS.ADDON_UNINSTALL}`,
  ]);
  clearOwnershipBaselines();

  const otherInstall = await promiseInstallFile(
    createAddon({
      id: OTHER_LOADER_ID,
      defaultLocale: { name: "Other legacy loader" },
      strictCompatibility: false,
      targetApplications: [
        {
          id: APP_ID,
          minVersion: "1",
          maxVersion: "*",
        },
      ],
    })
  );
  const otherAddon = otherInstall.addon;

  Assert.equal(otherAddon.__AddonInternal__.loader, "compat-test");
  Assert.ok(!otherAddon.isWebExtension);
  Assert.ok(otherAddon.appDisabled);
  Assert.ok(!otherAddon.isActive);
  Assert.notEqual(otherAddon.signedState, AddonManager.SIGNEDSTATE_PRIVILEGED);
  BootstrapMonitor.checkNotStarted(OTHER_LOADER_ID);
  await otherAddon.uninstall();
});

add_task(async function test_ordinary_signed_rdf_is_rejected() {
  const webExtension = AddonTestUtils.createTempXPIFile({
    "manifest.json": JSON.stringify({
      manifest_version: 2,
      name: "Ordinary signed WebExtension",
      version: "1.0",
      applications: { gecko: { id: SIGNED_RDF_ID } },
    }),
  });
  const source = AddonTestUtils.createTempXPIFile(
    createRawClassicFiles(
      SIGNED_RDF_ID,
      "Ordinary signed RDF extension",
      "ordinary-signed-rdf"
    )
  );
  const signedXPI = do_get_tempdir();
  signedXPI.append(`${SIGNED_RDF_ID}.xpi`);
  await IOUtils.remove(signedXPI.path, { ignoreAbsent: true });
  await IOUtils.copy(source.path, signedXPI.path);

  const previousRealCertChecks = gUseRealCertChecks;
  const previousPrivilegedSignatures = AddonTestUtils.usePrivilegedSignatures;
  let installedAddon;
  try {
    gUseRealCertChecks = false;
    AddonTestUtils.usePrivilegedSignatures = false;
    installedAddon = (await promiseInstallFile(webExtension)).addon;
    Assert.equal(installedAddon.signedState, AddonManager.SIGNEDSTATE_SIGNED);

    const install = await AddonManager.getInstallForFile(signedXPI);
    Assert.equal(install.state, AddonManager.STATE_DOWNLOAD_FAILED);
    Assert.equal(install.error, AddonManager.ERROR_CORRUPT_FILE);
    Assert.equal(install.addon, null);
    Assert.equal(
      (await AddonManager.getAddonByID(SIGNED_RDF_ID)).version,
      "1.0",
      "The ordinary signed WebExtension remains installed"
    );
  } finally {
    if (installedAddon) {
      await installedAddon.uninstall();
    }
    gUseRealCertChecks = previousRealCertChecks;
    AddonTestUtils.usePrivilegedSignatures = previousPrivilegedSignatures;
    await IOUtils.remove(signedXPI.path, { ignoreAbsent: true });
  }
});

add_task(async function test_current_hybrid_grandfathering() {
  const previousRealCertChecks = gUseRealCertChecks;
  const previousPrivilegedSignatures = AddonTestUtils.usePrivilegedSignatures;
  let managerRunning = true;
  try {
    gUseRealCertChecks = true;
    let addon = (
      await promiseInstallFile(
        createHybridBootstrapXPI(GRANDFATHERED_HYBRID_ID, "1.0")
      )
    ).addon;
    Assert.ok(addon.isActive);

    await promiseShutdownManager();
    managerRunning = false;
    const snapshot = await readAddonStateSnapshot();
    const databaseAddon = snapshot.database.addons.find(
      candidate => candidate.id === GRANDFATHERED_HYBRID_ID
    );
    const startupAddon =
      snapshot.startup["app-profile"].addons[GRANDFATHERED_HYBRID_ID];
    Assert.ok(databaseAddon);
    Assert.ok(startupAddon);
    for (const field of ["bootstrap", "unpack", "startupData"]) {
      delete databaseAddon[field];
      delete startupAddon[field];
    }
    databaseAddon.signedState = AddonManager.SIGNEDSTATE_SIGNED;
    startupAddon.signedState = AddonManager.SIGNEDSTATE_SIGNED;
    snapshot.database.schemaVersion = 37;
    Services.prefs.setIntPref("extensions.databaseSchema", 37);
    await writeAddonStateSnapshot(snapshot);

    gUseRealCertChecks = false;
    AddonTestUtils.usePrivilegedSignatures = false;
    await promiseStartupManager();
    managerRunning = true;

    addon = await AddonManager.getAddonByID(GRANDFATHERED_HYBRID_ID);
    Assert.ok(addon?.isActive, "The installed hybrid remains active");
    Assert.equal(addon.signedState, AddonManager.SIGNEDSTATE_SIGNED);
    Assert.deepEqual(addon.__AddonInternal__.startupData, {
      legacyLoader: "bootstrap",
      legacyMode: "bootstrap",
    });
    await addon.uninstall();
  } finally {
    gUseRealCertChecks = previousRealCertChecks;
    AddonTestUtils.usePrivilegedSignatures = previousPrivilegedSignatures;
    if (!managerRunning) {
      await promiseStartupManager();
    }
  }
});

add_task(async function test_waterfox_legacy_signing_state_matrix() {
  const previousRealCertChecks = gUseRealCertChecks;
  const previousPrivilegedSignatures = AddonTestUtils.usePrivilegedSignatures;
  const previousSigningRequired = Services.prefs.getBoolPref(
    PREF_XPI_SIGNATURES_REQUIRED
  );
  const blocklistPref = "extensions.blocklist.enabled";
  const hadBlocklistUserValue = Services.prefs.prefHasUserValue(blocklistPref);
  const previousBlocklistEnabled = Services.prefs.getBoolPref(
    blocklistPref,
    true
  );
  const namedXPIs = [];
  try {
    Services.prefs.setBoolPref(blocklistPref, false);
    gUseRealCertChecks = true;
    let addon = (
      await promiseInstallFile(
        createHybridBootstrapXPI(SIGNING_MATRIX_IDS.unsigned, "1.0")
      )
    ).addon;
    Assert.equal(addon.signedState, AddonManager.SIGNEDSTATE_MISSING);
    await addon.uninstall();

    gUseRealCertChecks = false;
    AddonTestUtils.usePrivilegedSignatures = false;
    const ordinaryBaseline = AddonTestUtils.createTempWebExtensionFile({
      manifest: {
        manifest_version: 2,
        name: "Ordinary signed baseline",
        version: "1.0",
        browser_specific_settings: {
          gecko: { id: SIGNING_MATRIX_IDS.ordinary },
        },
      },
    });
    addon = (await promiseInstallFile(ordinaryBaseline)).addon;
    Assert.equal(addon.signedState, AddonManager.SIGNEDSTATE_SIGNED);

    let namedXPI = await copyNamedXPI(
      createHybridBootstrapXPI(SIGNING_MATRIX_IDS.ordinary, "2.0"),
      SIGNING_MATRIX_IDS.ordinary
    );
    namedXPIs.push(namedXPI);
    let install = await AddonManager.getInstallForFile(namedXPI);
    Assert.equal(install.state, AddonManager.STATE_DOWNLOAD_FAILED);
    Assert.equal(install.error, AddonManager.ERROR_CORRUPT_FILE);
    Assert.equal(
      (await AddonManager.getAddonByID(SIGNING_MATRIX_IDS.ordinary)).version,
      "1.0"
    );
    await addon.uninstall();

    AddonTestUtils.usePrivilegedSignatures = true;
    namedXPI = await copyNamedXPI(
      createHybridBootstrapXPI(SIGNING_MATRIX_IDS.privileged, "1.0"),
      SIGNING_MATRIX_IDS.privileged
    );
    namedXPIs.push(namedXPI);
    addon = (await promiseInstallFile(namedXPI)).addon;
    Assert.equal(addon.signedState, AddonManager.SIGNEDSTATE_PRIVILEGED);
    Assert.ok(addon.isActive);
    await addon.uninstall();

    AddonTestUtils.usePrivilegedSignatures = "system";
    namedXPI = await copyNamedXPI(
      createHybridBootstrapXPI(SIGNING_MATRIX_IDS.system, "1.0"),
      SIGNING_MATRIX_IDS.system
    );
    namedXPIs.push(namedXPI);
    addon = (await promiseInstallFile(namedXPI)).addon;
    Assert.equal(addon.signedState, AddonManager.SIGNEDSTATE_SYSTEM);
    Assert.ok(addon.isPrivileged);
    Assert.ok(addon.isActive);
    await addon.uninstall();

    AddonTestUtils.usePrivilegedSignatures = false;
    await setupBuiltinExtension(
      {
        manifest: {
          manifest_version: 2,
          name: "Built-in legacy extension",
          version: "1.0",
          browser_specific_settings: {
            gecko: { id: SIGNING_MATRIX_IDS.builtin },
          },
          legacy: { type: "bootstrap" },
        },
        files: {
          "bootstrap.js": createP0BootstrapScript(
            SIGNING_MATRIX_IDS.builtin,
            "1.0"
          ),
        },
      },
      "legacy-matrix-builtin"
    );
    addon = await AddonManager.installBuiltinAddon(
      "resource://legacy-matrix-builtin/"
    );
    Assert.equal(addon.signedState, AddonManager.SIGNEDSTATE_NOT_REQUIRED);
    Assert.ok(addon.isBuiltin);
    Assert.ok(addon.isActive);
    await addon.uninstall();

    Services.prefs.setBoolPref(PREF_XPI_SIGNATURES_REQUIRED, true);
    gUseRealCertChecks = true;
    addon = await AddonManager.installTemporaryAddon(
      createRawBootstrapXPI(SIGNING_MATRIX_IDS.temporary, "1.0")
    );
    Assert.equal(addon.signedState, AddonManager.SIGNEDSTATE_MISSING);
    Assert.ok(addon.isActive);
    await addon.uninstall();
  } finally {
    Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler)
      .setSubstitution("legacy-matrix-builtin", null);
    for (const xpi of namedXPIs) {
      await IOUtils.remove(xpi.path, { ignoreAbsent: true });
    }
    gUseRealCertChecks = previousRealCertChecks;
    AddonTestUtils.usePrivilegedSignatures = previousPrivilegedSignatures;
    Services.prefs.setBoolPref(
      PREF_XPI_SIGNATURES_REQUIRED,
      previousSigningRequired
    );
    if (hadBlocklistUserValue) {
      Services.prefs.setBoolPref(blocklistPref, previousBlocklistEnabled);
    } else {
      Services.prefs.clearUserPref(blocklistPref);
    }
  }
});

add_task(async function test_temporary_raw_rdf_startup_failure_rollback() {
  clearP0Events();
  let addon = await AddonManager.installTemporaryAddon(
    createRawBootstrapXPI(TEMP_RAW_FAILURE_ID, "1.0")
  );
  Assert.ok(addon.isActive);
  clearP0Events();

  await Assert.rejects(
    AddonManager.installTemporaryAddon(
      createRawBootstrapXPI(TEMP_RAW_FAILURE_ID, "2.0", {
        failStartup: true,
      })
    ),
    /intentional startup failure/
  );

  addon = await AddonManager.getAddonByID(TEMP_RAW_FAILURE_ID);
  Assert.equal(addon?.version, "1.0");
  Assert.ok(addon.isActive);
  Assert.ok(
    getP0Events(TEMP_RAW_FAILURE_ID).includes(
      `${TEMP_RAW_FAILURE_ID}:1.0:startup:${BOOTSTRAP_REASONS.ADDON_DOWNGRADE}`
    )
  );
  await addon.uninstall();
  clearP0Events();
});

add_task(async function test_temporary_replacement_startup_failure_rollback() {
  clearP0Events();
  let addon = (
    await promiseInstallFile(
      createHybridBootstrapXPI(TEMP_REPLACEMENT_ID, "1.0")
    )
  ).addon;
  Assert.ok(addon.isActive);
  clearP0Events();

  await Assert.rejects(
    AddonManager.installTemporaryAddon(
      createHybridBootstrapXPI(TEMP_REPLACEMENT_ID, "2.0", {
        failStartup: true,
      })
    ),
    /intentional startup failure/
  );

  addon = await AddonManager.getAddonByID(TEMP_REPLACEMENT_ID);
  Assert.equal(addon?.version, "1.0");
  Assert.ok(addon.isActive, "The replaced permanent add-on is restored");
  Assert.ok(!addon.temporarilyInstalled);
  Assert.ok(
    getP0Events(TEMP_REPLACEMENT_ID).includes(
      `${TEMP_REPLACEMENT_ID}:1.0:startup:${BOOTSTRAP_REASONS.ADDON_DOWNGRADE}`
    ),
    "Rollback restarts the previous package"
  );
  await addon.uninstall();
  clearP0Events();
});

add_task(async function test_bootstrap_lifecycle_order() {
  clearBootstrapEvents();
  let install = await promiseInstallFile(createLifecycleBootstrapXPI("1.0"));
  let addon = install.addon;
  Assert.ok(addon.isActive);
  Assert.deepEqual(getBootstrapEvents(), [
    `install:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
  ]);

  clearBootstrapEvents();
  await promiseRestartManager();
  addon = await AddonManager.getAddonByID(BOOTSTRAP_ID);
  Assert.ok(addon?.isActive);
  Assert.equal(addon.version, "1.0");
  Assert.deepEqual(getBootstrapEvents(), [
    `shutdown:${BOOTSTRAP_REASONS.APP_SHUTDOWN}`,
    `startup:${BOOTSTRAP_REASONS.APP_STARTUP}`,
  ]);

  clearBootstrapEvents();
  install = await promiseInstallFile(createLifecycleBootstrapXPI("2.0"));
  addon = install.addon;
  Assert.ok(addon.isActive);
  Assert.equal(addon.version, "2.0");
  Assert.deepEqual(getBootstrapEvents(), [
    `shutdown:${BOOTSTRAP_REASONS.ADDON_UPGRADE}`,
    `uninstall:${BOOTSTRAP_REASONS.ADDON_UPGRADE}`,
    `install:${BOOTSTRAP_REASONS.ADDON_UPGRADE}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_UPGRADE}`,
  ]);

  clearBootstrapEvents();
  install = await promiseInstallFile(createLifecycleBootstrapXPI("1.0"));
  addon = install.addon;
  Assert.ok(addon.isActive);
  Assert.equal(addon.version, "1.0");
  Assert.deepEqual(getBootstrapEvents(), [
    `shutdown:${BOOTSTRAP_REASONS.ADDON_DOWNGRADE}`,
    `uninstall:${BOOTSTRAP_REASONS.ADDON_DOWNGRADE}`,
    `install:${BOOTSTRAP_REASONS.ADDON_DOWNGRADE}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_DOWNGRADE}`,
  ]);

  clearBootstrapEvents();
  await addon.uninstall();
  Assert.equal(await AddonManager.getAddonByID(BOOTSTRAP_ID), null);
  Assert.deepEqual(getBootstrapEvents(), [
    `shutdown:${BOOTSTRAP_REASONS.ADDON_UNINSTALL}`,
    `uninstall:${BOOTSTRAP_REASONS.ADDON_UNINSTALL}`,
  ]);

  clearBootstrapEvents();
  install = await promiseInstallFile(createLifecycleBootstrapXPI("1.0"));
  addon = install.addon;
  Assert.deepEqual(getBootstrapEvents(), [
    `install:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
  ]);

  clearBootstrapEvents();
  await addon.disable();
  Assert.ok(!addon.isActive);
  Assert.deepEqual(getBootstrapEvents(), [
    `shutdown:${BOOTSTRAP_REASONS.ADDON_DISABLE}`,
  ]);

  clearBootstrapEvents();
  install = await promiseInstallFile(createLifecycleBootstrapXPI("2.0"));
  addon = install.addon;
  Assert.ok(addon.userDisabled);
  Assert.ok(!addon.isActive);
  Assert.equal(addon.version, "2.0");
  Assert.deepEqual(getBootstrapEvents(), [
    `uninstall:${BOOTSTRAP_REASONS.ADDON_UPGRADE}`,
    `install:${BOOTSTRAP_REASONS.ADDON_UPGRADE}`,
  ]);

  clearBootstrapEvents();
  await addon.uninstall();
  Assert.equal(await AddonManager.getAddonByID(BOOTSTRAP_ID), null);
  Assert.deepEqual(getBootstrapEvents(), [
    `uninstall:${BOOTSTRAP_REASONS.ADDON_UNINSTALL}`,
  ]);
  clearBootstrapEvents();
});

add_task(async function test_staged_lifecycle_journal_recovery() {
  const destination = AddonTestUtils.profileExtensions.clone();
  destination.append(`${BOOTSTRAP_ID}.xpi`);
  const stagingDir = AddonTestUtils.profileExtensions.clone();
  stagingDir.append("staged");
  const staged = stagingDir.clone();
  staged.append(`${BOOTSTRAP_ID}.xpi`);
  const v1XPI = createLifecycleBootstrapXPI("1.0");
  const v2XPI = createLifecycleBootstrapXPI("2.0");

  const readSnapshot = async () => ({
    startup: await IOUtils.readJSON(AddonTestUtils.addonStartup.path, {
      decompress: true,
    }),
    database: await IOUtils.readJSON(gExtensionsJSON.path),
  });
  const writeSnapshot = async ({ startup, database }) => {
    await IOUtils.writeJSON(AddonTestUtils.addonStartup.path, startup, {
      tmpPath: `${AddonTestUtils.addonStartup.path}.tmp`,
      compress: true,
    });
    await IOUtils.writeJSON(gExtensionsJSON.path, database, {
      tmpPath: `${gExtensionsJSON.path}.tmp`,
    });
  };
  const replaceFile = async (source, target, lastModifiedTime) => {
    await IOUtils.remove(target.path, { ignoreAbsent: true });
    await IOUtils.copy(source.path, target.path);
    target.lastModifiedTime = lastModifiedTime;
    return target.clone().lastModifiedTime;
  };
  const assertFinalized = async () => {
    const { startup } = await readSnapshot();
    Assert.ok(
      !startup["app-profile"]?.staged?.[BOOTSTRAP_ID],
      "The completed staged journal should be removed"
    );
    Assert.ok(
      !(await IOUtils.exists(staged.path)),
      "The staged source should be removed after journal finalization"
    );
  };

  clearBootstrapEvents();
  const install = await promiseInstallFile(v1XPI);
  Assert.equal(install.addon.version, "1.0");
  const stagedInstall = await AddonManager.getInstallForFile(v2XPI);
  const stagedMetadata = stagedInstall.addon.__AddonInternal__.toJSON();
  stagedInstall.cancel();
  await promiseShutdownManager();
  clearBootstrapEvents();

  const v1Snapshot = await readSnapshot();
  const v1ModifiedTime =
    v1Snapshot.startup["app-profile"].addons[BOOTSTRAP_ID].lastModifiedTime;
  const v2ModifiedTime = await replaceFile(
    v2XPI,
    destination,
    v1ModifiedTime + 1000
  );
  await IOUtils.makeDirectory(stagingDir.path, { ignoreExisting: true });
  await IOUtils.copy(v2XPI.path, staged.path);

  const startup = structuredClone(v1Snapshot.startup);
  const location = startup["app-profile"];
  const state = location.addons[BOOTSTRAP_ID];
  state.lastModifiedTime = v2ModifiedTime;
  state.version = "2.0";
  state.telemetryKey = `${BOOTSTRAP_ID}:2.0`;
  location.staged ??= {};
  location.staged[BOOTSTRAP_ID] = {
    type: "install",
    metadata: structuredClone(stagedMetadata),
    lifecycleStarted: true,
    filesComplete: true,
  };
  await writeSnapshot({
    startup,
    database: structuredClone(v1Snapshot.database),
  });
  BootstrapMonitor.clear(BOOTSTRAP_ID);

  await promiseStartupManager();
  let addon = await AddonManager.getAddonByID(BOOTSTRAP_ID);
  Assert.equal(addon?.version, "2.0");
  Assert.ok(addon.isActive);
  Assert.deepEqual(getBootstrapEvents(), [
    `install:${BOOTSTRAP_REASONS.ADDON_UPGRADE}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_UPGRADE}`,
  ]);
  await assertFinalized();

  await promiseShutdownManager();
  clearBootstrapEvents();
  const v2Snapshot = await readSnapshot();
  await IOUtils.remove(destination.path);

  const uninstallStartup = structuredClone(v2Snapshot.startup);
  const uninstallLocation = uninstallStartup["app-profile"];
  delete uninstallLocation.addons[BOOTSTRAP_ID];
  uninstallLocation.staged ??= {};
  uninstallLocation.staged[BOOTSTRAP_ID] = {
    type: "uninstall",
    lifecycleStarted: true,
    lifecycleComplete: true,
    filesComplete: true,
  };
  await writeSnapshot({
    startup: uninstallStartup,
    database: structuredClone(v2Snapshot.database),
  });
  BootstrapMonitor.clear(BOOTSTRAP_ID);

  await promiseStartupManager();
  addon = await AddonManager.getAddonByID(BOOTSTRAP_ID);
  Assert.equal(addon, null);
  Assert.deepEqual(getBootstrapEvents(), []);
  await assertFinalized();
  clearBootstrapEvents();
});

add_task(async function test_hybrid_manifest_json_precedence() {
  let invalidInstall;
  const { messages } = await promiseConsoleOutput(async () => {
    invalidInstall = await AddonManager.getInstallForFile(
      createHybridXPI(HYBRID_BOOTSTRAP_ID, "bootstrap")
    );
  });
  Assert.equal(invalidInstall.state, AddonManager.STATE_DOWNLOAD_FAILED);
  Assert.equal(invalidInstall.error, AddonManager.ERROR_CORRUPT_FILE);
  Assert.equal(invalidInstall.addon, null);
  Assert.ok(
    messages.some(({ message }) =>
      /Legacy bootstrap extension is missing bootstrap\.js/.test(message)
    )
  );

  let install = await promiseInstallFile(
    createHybridXPI(HYBRID_BOOTSTRAP_ID, "bootstrap", true, {
      page: "options.xhtml",
      open_in_tab: true,
    })
  );
  let addon = install.addon;
  let internalAddon = addon.__AddonInternal__;
  Assert.equal(addon.id, HYBRID_BOOTSTRAP_ID);
  Assert.equal(addon.name, "JSON bootstrap hybrid");
  Assert.equal(addon.version, "2.0");
  Assert.ok(addon.isWebExtension);
  Assert.ok(addon.isActive);
  Assert.equal(internalAddon.loader, null);
  Assert.ok(internalAddon.bootstrap);
  Assert.equal(internalAddon.optionsURL, "options.xhtml");
  Assert.equal(internalAddon.optionsType, AddonManager.OPTIONS_TYPE_TAB);
  Assert.equal(internalAddon.startupData.legacyLoader, "bootstrap");
  Assert.equal(internalAddon.startupData.legacyMode, "bootstrap");
  Assert.equal(
    await AddonManager.getAddonByID(`rdf-${HYBRID_BOOTSTRAP_ID}`),
    null
  );
  await addon.uninstall();

  install = await promiseInstallFile(
    createHybridXPI(HYBRID_XUL_ID, "xul", false, {
      page: "options.xhtml",
    })
  );
  addon = install.addon;
  internalAddon = addon.__AddonInternal__;
  Assert.equal(addon.id, HYBRID_XUL_ID);
  Assert.equal(addon.name, "JSON xul hybrid");
  Assert.equal(addon.version, "2.0");
  Assert.ok(addon.isWebExtension);
  Assert.ok(!addon.isActive);
  Assert.equal(internalAddon.loader, null);
  Assert.ok(!internalAddon.bootstrap);
  Assert.equal(internalAddon.optionsURL, "options.xhtml");
  Assert.equal(internalAddon.optionsType, AddonManager.OPTIONS_TYPE_DIALOG);
  Assert.equal(internalAddon.startupData.legacyLoader, "bootstrap");
  Assert.equal(internalAddon.startupData.legacyMode, "xul");
  Assert.ok(!internalAddon.unpack);
  Assert.ok(
    hasFlag(
      addon.operationsRequiringRestart,
      AddonManager.OP_NEEDS_RESTART_INSTALL
    )
  );
  Assert.equal(await AddonManager.getAddonByID(`rdf-${HYBRID_XUL_ID}`), null);

  await promiseRestartManager();
  addon = await AddonManager.getAddonByID(HYBRID_XUL_ID);
  Assert.ok(addon?.isActive);
  await addon.uninstall();
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_UNINSTALL);
  Assert.ok(addon.isActive);
  await promiseRestartManager();
  Assert.equal(await AddonManager.getAddonByID(HYBRID_XUL_ID), null);
});

add_task(async function test_dictionary_uses_generic_scope() {
  const install = await promiseInstallFile(createDictionaryXPI());
  const addon = install.addon;
  const internalAddon = addon.__AddonInternal__;

  Assert.equal(addon.id, DICTIONARY_ID);
  Assert.equal(addon.type, "dictionary");
  Assert.equal(addon.name, "RDF dictionary");
  Assert.equal(addon.manifestVersion, 2);
  Assert.equal(internalAddon.loader, null);
  Assert.ok(addon.isWebExtension);
  Assert.ok(addon.isActive);
  Assert.equal(addon.optionsURL, null);
  Assert.equal(addon.optionsType, null);
  Assert.deepEqual(internalAddon.startupData, {
    dictionaries: {
      "zz-Latn-ZZ": "dictionaries/zz_Latn_ZZ.dic",
      "zz-ZZ": "dictionaries/zz_ZZ.dic",
    },
  });

  await addon.uninstall();
});

add_task(async function test_classic_restart_operations() {
  const chromeRegistry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(
    Ci.nsIChromeRegistry
  );
  const classicURL = Services.io.newURI(
    "chrome://classic-loader/content/options.xhtml"
  );
  const assertChromeRegistered = message =>
    Assert.ok(
      chromeRegistry
        .convertChromeURL(classicURL)
        .spec.endsWith("/content/options.xhtml"),
      message
    );
  const assertChromeMissing = message =>
    Assert.throws(
      () => chromeRegistry.convertChromeURL(classicURL),
      error => error.result === Cr.NS_ERROR_FILE_NOT_FOUND,
      message
    );

  const install = await promiseInstallFile(createClassicXPI());
  let addon = install.addon;
  Assert.ok(!addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_INSTALL);
  Assert.ok(
    hasFlag(
      addon.operationsRequiringRestart,
      AddonManager.OP_NEEDS_RESTART_INSTALL
    )
  );
  assertChromeMissing("Classic chrome should wait for the install restart");

  await promiseRestartManager();
  addon = await AddonManager.getAddonByID(CLASSIC_ID);
  Assert.ok(addon?.isActive);
  Assert.equal(addon.id, CLASSIC_ID);
  Assert.equal(addon.name, "Classic RDF extension");
  Assert.equal(addon.version, "1.0");
  Assert.equal(addon.manifestVersion, 2);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_NONE);
  Assert.equal(addon.optionsType, AddonManager.OPTIONS_TYPE_TAB);
  Assert.deepEqual(addon.__AddonInternal__.startupData, {
    legacyMode: "xul",
    legacyManifest: "rdf",
  });
  Assert.ok(addon.__AddonInternal__.unpack);
  Assert.ok(
    addon.__AddonInternal__.sourceBundle.isDirectory(),
    "em:unpack installs the classic extension as a directory"
  );
  Assert.ok(
    hasFlag(
      addon.operationsRequiringRestart,
      AddonManager.OP_NEEDS_RESTART_DISABLE
    )
  );
  Assert.ok(
    hasFlag(
      addon.operationsRequiringRestart,
      AddonManager.OP_NEEDS_RESTART_UNINSTALL
    )
  );
  assertChromeRegistered("Classic chrome should load after restart");
  Assert.ok(
    ExtensionSupport.loadedLegacyExtensions.has(CLASSIC_ID),
    "The compatibility state tracks the active classic extension"
  );

  await addon.disable();
  Assert.ok(addon.userDisabled);
  Assert.ok(addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_DISABLE);
  Assert.ok(
    hasFlag(
      addon.operationsRequiringRestart,
      AddonManager.OP_NEEDS_RESTART_DISABLE
    )
  );
  assertChromeRegistered("Pending disable must not unload classic chrome");

  await addon.enable();
  Assert.ok(!addon.userDisabled);
  Assert.ok(addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_NONE);
  assertChromeRegistered("Cancelling disable must leave classic chrome loaded");

  await addon.disable();
  Assert.ok(addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_DISABLE);
  assertChromeRegistered("Classic chrome must remain until disable restart");

  await promiseRestartManager();
  addon = await AddonManager.getAddonByID(CLASSIC_ID);
  Assert.ok(addon);
  Assert.ok(addon.userDisabled);
  Assert.ok(!addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_NONE);
  Assert.ok(
    hasFlag(
      addon.operationsRequiringRestart,
      AddonManager.OP_NEEDS_RESTART_ENABLE
    )
  );
  Assert.ok(
    !hasFlag(
      addon.operationsRequiringRestart,
      AddonManager.OP_NEEDS_RESTART_UNINSTALL
    )
  );
  assertChromeMissing("Disabled classic chrome should be absent after restart");
  Assert.ok(
    !ExtensionSupport.loadedLegacyExtensions.has(CLASSIC_ID),
    "The compatibility state omits the disabled classic extension"
  );

  await addon.enable();
  Assert.ok(!addon.userDisabled);
  Assert.ok(!addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_ENABLE);
  Assert.ok(
    hasFlag(
      addon.operationsRequiringRestart,
      AddonManager.OP_NEEDS_RESTART_ENABLE
    )
  );
  assertChromeMissing("Pending enable must not load classic chrome early");

  await addon.disable();
  Assert.ok(addon.userDisabled);
  Assert.ok(!addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_NONE);
  assertChromeMissing("Cancelling enable must leave classic chrome unloaded");

  await addon.enable();
  Assert.ok(!addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_ENABLE);
  await promiseRestartManager();
  addon = await AddonManager.getAddonByID(CLASSIC_ID);
  Assert.ok(addon?.isActive);
  Assert.ok(!addon.userDisabled);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_NONE);
  assertChromeRegistered("Classic chrome should reload after enable restart");
  Assert.ok(
    ExtensionSupport.loadedLegacyExtensions.has(CLASSIC_ID),
    "The compatibility state returns after the enable restart"
  );

  await addon.uninstall();
  Assert.ok(addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_UNINSTALL);
  Assert.ok(
    hasFlag(
      addon.operationsRequiringRestart,
      AddonManager.OP_NEEDS_RESTART_UNINSTALL
    )
  );
  assertChromeRegistered("Pending uninstall must not unload classic chrome");

  await addon.cancelUninstall();
  Assert.ok(addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_NONE);
  assertChromeRegistered("Cancelling uninstall must preserve classic chrome");

  await addon.uninstall();
  Assert.ok(addon.isActive);
  Assert.equal(addon.pendingOperations, AddonManager.PENDING_UNINSTALL);
  assertChromeRegistered("Classic chrome must remain until uninstall restart");

  await promiseRestartManager();
  Assert.equal(await AddonManager.getAddonByID(CLASSIC_ID), null);
  assertChromeMissing(
    "Uninstalled classic chrome should be absent after restart"
  );
  Assert.ok(
    !ExtensionSupport.loadedLegacyExtensions.has(CLASSIC_ID),
    "The compatibility state is removed after uninstall"
  );
});

add_task(async function test_raw_classic_sideloads() {
  const packedName = "Raw packed RDF extension";
  const unpackedName = "Raw unpacked RDF extension";
  const packedChromePackage = "raw-packed-xul";
  const unpackedChromePackage = "raw-unpacked-xul";
  const profileExtensions = AddonTestUtils.profileExtensions.clone();
  const packedPath = PathUtils.join(
    profileExtensions.path,
    `${RAW_PACKED_ID}.xpi`
  );
  const unpackedPath = PathUtils.join(profileExtensions.path, RAW_UNPACKED_ID);
  const chromeRegistry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(
    Ci.nsIChromeRegistry
  );
  const chromeURL = chromePackage =>
    Services.io.newURI(`chrome://${chromePackage}/content/marker.txt`);
  const assertChromeRegistered = (chromePackage, message) =>
    Assert.ok(
      chromeRegistry
        .convertChromeURL(chromeURL(chromePackage))
        .spec.endsWith("/content/marker.txt"),
      message
    );
  const assertChromeMissing = (chromePackage, message) =>
    Assert.throws(
      () => chromeRegistry.convertChromeURL(chromeURL(chromePackage)),
      error => error.result === Cr.NS_ERROR_FILE_NOT_FOUND,
      message
    );
  const removeSideloads = async () => {
    await IOUtils.remove(packedPath, { ignoreAbsent: true });
    await IOUtils.remove(unpackedPath, {
      recursive: true,
      ignoreAbsent: true,
    });
  };

  let clean = false;
  let managerRunning = true;
  try {
    await promiseShutdownManager();
    managerRunning = false;
    await removeSideloads();

    const packedXPI = AddonTestUtils.createTempXPIFile(
      createRawClassicFiles(RAW_PACKED_ID, packedName, packedChromePackage)
    );
    const unpackedXPI = AddonTestUtils.createTempXPIFile(
      createRawClassicFiles(
        RAW_UNPACKED_ID,
        unpackedName,
        unpackedChromePackage
      )
    );
    const packedTarget = await AddonTestUtils.manuallyInstall(
      packedXPI,
      profileExtensions,
      RAW_PACKED_ID,
      false
    );
    const unpackedTarget = await AddonTestUtils.manuallyInstall(
      unpackedXPI,
      profileExtensions,
      RAW_UNPACKED_ID,
      true
    );
    Assert.ok(packedTarget.isFile(), "Packed sideload is an XPI");
    Assert.ok(unpackedTarget.isDirectory(), "Unpacked sideload is a directory");

    await promiseStartupManager();
    managerRunning = true;
    const addons = await AddonManager.getAddonsByIDs([
      RAW_PACKED_ID,
      RAW_UNPACKED_ID,
    ]);
    for (const [addon, id, name] of [
      [addons[0], RAW_PACKED_ID, packedName],
      [addons[1], RAW_UNPACKED_ID, unpackedName],
    ]) {
      Assert.ok(addon, `${name} is discovered`);
      Assert.equal(addon.id, id);
      Assert.equal(addon.name, name);
      Assert.ok(addon.isActive, `${name} is active after startup`);
      Assert.equal(addon.pendingOperations, AddonManager.PENDING_NONE);
      Assert.deepEqual(addon.__AddonInternal__.startupData, {
        legacyMode: "xul",
        legacyManifest: "rdf",
      });
      Assert.ok(
        hasFlag(
          addon.operationsRequiringRestart,
          AddonManager.OP_NEEDS_RESTART_UNINSTALL
        ),
        `${name} remains restart-required`
      );
    }
    assertChromeRegistered(
      packedChromePackage,
      "Packed sideload chrome is registered"
    );
    assertChromeRegistered(
      unpackedChromePackage,
      "Unpacked sideload chrome is registered"
    );

    await promiseShutdownManager();
    managerRunning = false;
    await removeSideloads();
    await promiseStartupManager();
    managerRunning = true;

    Assert.equal(await AddonManager.getAddonByID(RAW_PACKED_ID), null);
    Assert.equal(await AddonManager.getAddonByID(RAW_UNPACKED_ID), null);
    assertChromeMissing(
      packedChromePackage,
      "Packed sideload chrome is removed"
    );
    assertChromeMissing(
      unpackedChromePackage,
      "Unpacked sideload chrome is removed"
    );
    clean = true;
  } finally {
    if (!clean) {
      if (managerRunning) {
        await promiseShutdownManager();
        managerRunning = false;
      }
      await removeSideloads();
      if (!managerRunning) {
        await promiseStartupManager();
      }
    }
  }
});

add_task(async function test_locked_classic_sideload_uninstall() {
  const appRoot = Services.dirsvc.get("XREAddonAppDir", Ci.nsIFile);
  const appExtensions = appRoot.clone();
  appExtensions.append("extensions");
  if (!appExtensions.exists()) {
    appExtensions.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  }

  const xpi = AddonTestUtils.createTempXPIFile(
    createRawClassicFiles(
      LOCKED_SIDELOAD_ID,
      "Locked classic sideload",
      "locked-sideload-xul"
    )
  );
  const targetPath = PathUtils.join(
    appExtensions.path,
    `${LOCKED_SIDELOAD_ID}.xpi`
  );
  const chromeRegistry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(
    Ci.nsIChromeRegistry
  );
  const chromeURL = Services.io.newURI(
    "chrome://locked-sideload-xul/content/marker.txt"
  );
  const enabledScopes = Services.prefs.getIntPref("extensions.enabledScopes");
  const sideloadScopes = Services.prefs.getIntPref(
    "extensions.sideloadScopes",
    AddonManager.SCOPE_PROFILE
  );

  let managerRunning = true;
  try {
    await promiseShutdownManager();
    managerRunning = false;
    await IOUtils.remove(targetPath, { ignoreAbsent: true });
    Services.prefs.setIntPref(
      "extensions.enabledScopes",
      AddonManager.SCOPE_ALL
    );
    Services.prefs.setIntPref(
      "extensions.sideloadScopes",
      AddonManager.SCOPE_ALL
    );
    await AddonTestUtils.manuallyInstall(
      xpi,
      appExtensions,
      LOCKED_SIDELOAD_ID,
      false
    );

    await promiseStartupManager();
    managerRunning = true;
    let addon = await AddonManager.getAddonByID(LOCKED_SIDELOAD_ID);
    Assert.ok(addon?.isActive, "The locked classic sideload starts");
    Assert.ok(addon.foreignInstall, "The application add-on is a sideload");
    Assert.ok(
      chromeRegistry
        .convertChromeURL(chromeURL)
        .spec.endsWith("/content/marker.txt")
    );

    Services.prefs.setIntPref(
      "extensions.sideloadScopes",
      AddonManager.SCOPE_PROFILE
    );
    await promiseRestartManager();
    addon = await AddonManager.getAddonByID(LOCKED_SIDELOAD_ID);
    Assert.ok(addon?.isActive, "The legacy sideload remains active");

    await addon.uninstall();
    Assert.equal(addon.pendingOperations, AddonManager.PENDING_UNINSTALL);
    Assert.ok(await IOUtils.exists(targetPath), "The shared XPI is preserved");

    await promiseRestartManager();
    Assert.equal(await AddonManager.getAddonByID(LOCKED_SIDELOAD_ID), null);
    Assert.ok(await IOUtils.exists(targetPath), "The shared XPI still exists");
    Assert.throws(
      () => chromeRegistry.convertChromeURL(chromeURL),
      error => error.result === Cr.NS_ERROR_FILE_NOT_FOUND,
      "The uninstalled sideload chrome is no longer registered"
    );

    await promiseRestartManager();
    Assert.equal(
      await AddonManager.getAddonByID(LOCKED_SIDELOAD_ID),
      null,
      "The disabled sideload scope does not rediscover the shared XPI"
    );
  } finally {
    Services.prefs.setIntPref("extensions.enabledScopes", enabledScopes);
    Services.prefs.setIntPref("extensions.sideloadScopes", sideloadScopes);
    if (managerRunning) {
      await promiseShutdownManager();
      managerRunning = false;
    }
    await IOUtils.remove(targetPath, { ignoreAbsent: true });
    await promiseStartupManager();
  }
});

add_task(async function test_cross_location_staged_legacy_replacement() {
  const id = CROSS_LOCATION_ID;
  const chromePackage = "cross-location-classic";
  const appExtensions = getAppExtensionsDir();
  const appTargetPath = PathUtils.join(appExtensions.path, `${id}.xpi`);
  const enabledScopes = Services.prefs.getIntPref("extensions.enabledScopes");
  const sideloadScopes = Services.prefs.getIntPref(
    "extensions.sideloadScopes",
    AddonManager.SCOPE_PROFILE
  );
  let managerRunning = true;

  try {
    await promiseShutdownManager();
    managerRunning = false;
    Services.prefs.setIntPref(
      "extensions.enabledScopes",
      AddonManager.SCOPE_ALL
    );
    Services.prefs.setIntPref(
      "extensions.sideloadScopes",
      AddonManager.SCOPE_ALL
    );
    await IOUtils.remove(appTargetPath, { ignoreAbsent: true });
    await AddonTestUtils.manuallyInstall(
      createClassicVersionXPI(id, "1.0", chromePackage),
      appExtensions,
      id,
      false
    );

    await promiseStartupManager();
    managerRunning = true;
    let addon = await AddonManager.getAddonByID(id);
    Assert.equal(addon?.version, "1.0");
    Assert.equal(addon.__AddonInternal__.location.name, "app-global");
    Assert.equal(await readChromeMarker(chromePackage), "1.0");

    const update = await promiseInstallFile(
      createClassicVersionXPI(id, "2.0", chromePackage)
    );
    Assert.equal(update.state, AddonManager.STATE_INSTALLED);
    await promiseShutdownManager();
    managerRunning = false;

    let snapshot = await readAddonStateSnapshot();
    const record = snapshot.startup["app-profile"].staged[id];
    Assert.equal(record.oldAddon.location, "app-global");
    Assert.equal(record.newAddon.location, "app-profile");
    Assert.ok(record.lifecycle.oldShutdown.complete);
    Assert.ok(record.lifecycle.oldUninstall.complete);
    Assert.ok(!record.lifecycle.newInstall);
    Assert.ok(!record.lifecycle.newStartup);

    await promiseStartupManager();
    managerRunning = true;
    addon = await AddonManager.getAddonByID(id);
    Assert.equal(addon?.version, "2.0");
    Assert.equal(addon.__AddonInternal__.location.name, "app-profile");
    Assert.equal(await readChromeMarker(chromePackage), "2.0");
    snapshot = await readAddonStateSnapshot();
    Assert.ok(!snapshot.startup["app-profile"].staged?.[id]);
  } finally {
    await cleanupClassicProviderTest(
      id,
      appTargetPath,
      managerRunning,
      enabledScopes,
      sideloadScopes
    );
  }
});

add_task(async function test_cross_location_staged_crash_markers() {
  const id = CROSS_LOCATION_CRASH_ID;
  const chromePackage = "cross-location-crash";
  const appExtensions = getAppExtensionsDir();
  const appTargetPath = PathUtils.join(appExtensions.path, `${id}.xpi`);
  const enabledScopes = Services.prefs.getIntPref("extensions.enabledScopes");
  const sideloadScopes = Services.prefs.getIntPref(
    "extensions.sideloadScopes",
    AddonManager.SCOPE_PROFILE
  );
  let managerRunning = true;

  try {
    await promiseShutdownManager();
    managerRunning = false;
    Services.prefs.setIntPref(
      "extensions.enabledScopes",
      AddonManager.SCOPE_ALL
    );
    Services.prefs.setIntPref(
      "extensions.sideloadScopes",
      AddonManager.SCOPE_ALL
    );
    await IOUtils.remove(appTargetPath, { ignoreAbsent: true });
    await AddonTestUtils.manuallyInstall(
      createClassicVersionXPI(id, "1.0", chromePackage),
      appExtensions,
      id,
      false
    );
    await promiseStartupManager();
    managerRunning = true;

    const { XPIExports } = ChromeUtils.importESModule(
      "resource://gre/modules/addons/XPIExports.sys.mjs"
    );
    const injectFault = point => {
      let injected = false;
      XPIExports.XPIProvider._stagedLifecycleTestHook = details => {
        if (
          !injected &&
          details.phase === "newInstall" &&
          details.point === point
        ) {
          injected = true;
          throw new Error(`Injected staged lifecycle fault at ${point}`);
        }
      };
      return () => Assert.ok(injected, `Injected a real ${point} fault`);
    };

    await promiseInstallFile(createClassicVersionXPI(id, "2.0", chromePackage));
    await promiseShutdownManager();
    managerRunning = false;
    let assertInjected = injectFault("after-started-marker");
    await promiseStartupManager();
    managerRunning = true;
    assertInjected();
    let snapshot = await readAddonStateSnapshot();
    let record = snapshot.startup["app-profile"].staged[id];
    Assert.ok(record.lifecycle.newInstall.started);
    Assert.ok(!record.lifecycle.newInstall.complete);

    BootstrapMonitor.installed.set(id, {
      reason: BOOTSTRAP_REASONS.ADDON_UPGRADE,
      params: { id, version: "2.0" },
    });
    XPIExports.XPIProvider._stagedLifecycleTestHook = null;
    await promiseRestartManager();
    let addon = await AddonManager.getAddonByID(id);
    Assert.equal(addon?.version, "2.0");
    Assert.ok(addon.isActive);
    Assert.ok(
      XPIExports.XPIInternal.XPIStates.getAddon("app-profile", id)?.enabled,
      "The recovered package is enabled in XPI state"
    );
    Assert.ok(
      XPIExports.XPIProvider.activeAddons.get(id)?.started,
      "The recovered package has a started lifecycle scope"
    );
    Assert.equal(await readChromeMarker(chromePackage), "2.0");

    await promiseInstallFile(createClassicVersionXPI(id, "3.0", chromePackage));
    await promiseShutdownManager();
    managerRunning = false;
    assertInjected = injectFault("after-callback");
    await promiseStartupManager();
    managerRunning = true;
    assertInjected();
    snapshot = await readAddonStateSnapshot();
    record = snapshot.startup["app-profile"].staged[id];
    Assert.ok(record.lifecycle.newInstall.started);
    Assert.ok(!record.lifecycle.newInstall.complete);

    XPIExports.XPIProvider._stagedLifecycleTestHook = null;
    await promiseRestartManager();
    addon = await AddonManager.getAddonByID(id);
    Assert.equal(addon?.version, "3.0");
    Assert.ok(addon.isActive);
    Assert.equal(await readChromeMarker(chromePackage), "3.0");
    snapshot = await readAddonStateSnapshot();
    Assert.ok(!snapshot.startup["app-profile"].staged?.[id]);
  } finally {
    const { XPIExports } = ChromeUtils.importESModule(
      "resource://gre/modules/addons/XPIExports.sys.mjs"
    );
    XPIExports.XPIProvider._stagedLifecycleTestHook = null;
    await cleanupClassicProviderTest(
      id,
      appTargetPath,
      managerRunning,
      enabledScopes,
      sideloadScopes
    );
  }
});

add_task(async function test_staged_persistence_boundaries() {
  const id = PERSISTENCE_CRASH_ID;
  const chromePackage = "persistence-crash";
  const appExtensions = getAppExtensionsDir();
  const appTargetPath = PathUtils.join(appExtensions.path, `${id}.xpi`);
  const profileTargetPath = PathUtils.join(
    AddonTestUtils.profileExtensions.path,
    `${id}.xpi`
  );
  const stagedPath = PathUtils.join(
    AddonTestUtils.profileExtensions.path,
    "staged",
    `${id}.xpi`
  );
  const enabledScopes = Services.prefs.getIntPref("extensions.enabledScopes");
  const sideloadScopes = Services.prefs.getIntPref(
    "extensions.sideloadScopes",
    AddonManager.SCOPE_PROFILE
  );
  const boundaries = [
    {
      point: "before-file-operation",
      phase: "files",
      filesComplete: false,
      databaseComplete: false,
      databaseVersion: "1.0",
      profileTargetPresent: false,
      stagedSourcePresent: true,
      newInstallOnRecovery: 1,
    },
    {
      point: "after-file-operation",
      phase: "files",
      filesComplete: false,
      databaseComplete: false,
      databaseVersion: "1.0",
      profileTargetPresent: true,
      stagedSourcePresent: true,
      newInstallOnRecovery: 1,
    },
    {
      point: "before-xpi-state-save",
      phase: "files",
      filesComplete: false,
      databaseComplete: false,
      databaseVersion: "1.0",
      profileTargetPresent: true,
      stagedSourcePresent: true,
      newInstallOnRecovery: 1,
    },
    {
      point: "after-xpi-state-save",
      phase: "files",
      filesComplete: true,
      databaseComplete: false,
      databaseVersion: "1.0",
      profileTargetPresent: true,
      stagedSourcePresent: true,
      newInstallOnRecovery: 1,
    },
    {
      point: "before-database-save",
      phase: "database",
      filesComplete: true,
      databaseComplete: false,
      databaseVersion: "1.0",
      profileTargetPresent: true,
      stagedSourcePresent: true,
      newInstallOnRecovery: 0,
    },
    {
      point: "after-database-save",
      phase: "database",
      filesComplete: true,
      databaseComplete: false,
      databaseVersion: "2.0",
      profileTargetPresent: true,
      stagedSourcePresent: true,
      newInstallOnRecovery: 0,
    },
    {
      point: "before-xpi-state-save",
      phase: "database",
      filesComplete: true,
      databaseComplete: false,
      databaseVersion: "2.0",
      profileTargetPresent: true,
      stagedSourcePresent: true,
      newInstallOnRecovery: 0,
    },
    {
      point: "after-xpi-state-save",
      phase: "database",
      filesComplete: true,
      databaseComplete: true,
      databaseVersion: "2.0",
      profileTargetPresent: true,
      stagedSourcePresent: true,
      newInstallOnRecovery: 0,
    },
    {
      point: "before-finalization",
      phase: "finalization",
      filesComplete: true,
      databaseComplete: true,
      databaseVersion: "2.0",
      profileTargetPresent: true,
      stagedSourcePresent: true,
      newInstallOnRecovery: 0,
    },
    {
      point: "after-staging-cleanup",
      phase: "finalization",
      filesComplete: true,
      databaseComplete: true,
      databaseVersion: "2.0",
      profileTargetPresent: true,
      stagedSourcePresent: false,
      newInstallOnRecovery: 0,
    },
    {
      point: "after-finalization",
      phase: "finalization",
      journalPresent: false,
      databaseVersion: "2.0",
      profileTargetPresent: true,
      stagedSourcePresent: false,
      newInstallOnRecovery: 0,
    },
  ];
  let managerRunning = true;

  const removeScenarioState = async () => {
    if (managerRunning) {
      await promiseShutdownManager();
      managerRunning = false;
    }
    for (const path of [profileTargetPath, stagedPath, appTargetPath]) {
      await IOUtils.remove(path, { recursive: true, ignoreAbsent: true });
    }
    await removeAddonFromStateSnapshot(id);
    BootstrapMonitor.clear(id);
    await promiseStartupManager();
    managerRunning = true;
  };

  try {
    await promiseShutdownManager();
    managerRunning = false;
    Services.prefs.setIntPref(
      "extensions.enabledScopes",
      AddonManager.SCOPE_ALL
    );
    Services.prefs.setIntPref(
      "extensions.sideloadScopes",
      AddonManager.SCOPE_ALL
    );
    await promiseStartupManager();
    managerRunning = true;

    for (const boundary of boundaries) {
      await promiseShutdownManager();
      managerRunning = false;
      await AddonTestUtils.manuallyInstall(
        createClassicVersionXPI(id, "1.0", chromePackage),
        appExtensions,
        id,
        false
      );
      await promiseStartupManager();
      managerRunning = true;

      let addon = await AddonManager.getAddonByID(id);
      Assert.equal(
        addon?.version,
        "1.0",
        `${boundary.point}: baseline version`
      );
      await promiseInstallFile(
        createClassicVersionXPI(id, "2.0", chromePackage)
      );
      await promiseShutdownManager();
      managerRunning = false;

      const { XPIExports } = ChromeUtils.importESModule(
        "resource://gre/modules/addons/XPIExports.sys.mjs"
      );
      let injected = false;
      XPIExports.XPIProvider._stagedLifecycleTestHook = details => {
        if (
          !injected &&
          details.journal.id === id &&
          details.phase === boundary.phase &&
          details.point === boundary.point
        ) {
          injected = true;
          throw new Error(
            `Injected staged persistence fault at ${boundary.point}`
          );
        }
      };
      await promiseStartupManager();
      managerRunning = true;
      Assert.ok(injected, `${boundary.point}: injected a real boundary fault`);

      let snapshot = await readAddonStateSnapshot();
      const pendingOperations = Services.prefs.getBoolPref(
        "extensions.pendingOperations"
      );
      let record = snapshot.startup["app-profile"].staged?.[id];
      Assert.equal(
        Boolean(record),
        boundary.journalPresent !== false,
        `${boundary.point}: journal presence`
      );
      if (record) {
        Assert.equal(
          Boolean(record.filesComplete),
          boundary.filesComplete,
          `${boundary.point}: file checkpoint`
        );
        Assert.equal(
          Boolean(record.databaseComplete),
          boundary.databaseComplete,
          `${boundary.point}: database checkpoint`
        );
      }
      const databaseAddon =
        snapshot.database.addons.find(
          candidate =>
            candidate.id === id &&
            candidate.location === "app-profile" &&
            candidate.visible
        ) ?? snapshot.database.addons.find(candidate => candidate.id === id);
      Assert.equal(
        databaseAddon?.version,
        boundary.databaseVersion,
        `${boundary.point}: durable database version`
      );
      Assert.equal(
        await IOUtils.exists(profileTargetPath),
        boundary.profileTargetPresent,
        `${boundary.point}: installed package presence`
      );
      Assert.equal(
        await IOUtils.exists(stagedPath),
        boundary.stagedSourcePresent,
        `${boundary.point}: staged source presence`
      );

      XPIExports.XPIProvider._stagedLifecycleTestHook = null;
      await promiseShutdownManager();
      managerRunning = false;
      await writeAddonStateSnapshot(snapshot);
      Services.prefs.setBoolPref(
        "extensions.pendingOperations",
        pendingOperations
      );
      const { XPIExports: recoveryXPIExports } = ChromeUtils.importESModule(
        "resource://gre/modules/addons/XPIExports.sys.mjs"
      );
      let newInstallOnRecovery = 0;
      recoveryXPIExports.XPIProvider._stagedLifecycleTestHook = details => {
        if (
          details.journal.id === id &&
          details.phase === "newInstall" &&
          details.point === "before-started-marker"
        ) {
          newInstallOnRecovery++;
        }
      };
      await promiseStartupManager();
      managerRunning = true;
      Assert.equal(
        newInstallOnRecovery,
        boundary.newInstallOnRecovery,
        `${boundary.point}: new install callback replay policy`
      );
      recoveryXPIExports.XPIProvider._stagedLifecycleTestHook = null;

      addon = await AddonManager.getAddonByID(id);
      Assert.equal(
        addon?.version,
        "2.0",
        `${boundary.point}: recovered version`
      );
      Assert.ok(
        addon.isActive,
        `${boundary.point}: recovered add-on is active`
      );
      Assert.ok(
        recoveryXPIExports.XPIInternal.XPIStates.getAddon("app-profile", id)
          ?.enabled,
        `${boundary.point}: recovered XPI state is enabled`
      );
      Assert.ok(
        recoveryXPIExports.XPIProvider.activeAddons.get(id)?.started,
        `${boundary.point}: recovered scope is started`
      );
      Assert.equal(
        await readChromeMarker(chromePackage),
        "2.0",
        `${boundary.point}: recovered chrome is registered`
      );
      snapshot = await readAddonStateSnapshot();
      Assert.ok(
        !snapshot.startup["app-profile"].staged?.[id],
        `${boundary.point}: recovered journal is finalized`
      );
      Assert.ok(
        !(await IOUtils.exists(stagedPath)),
        `${boundary.point}: recovered staged source is cleaned`
      );

      await removeScenarioState();
    }
  } finally {
    const { XPIExports } = ChromeUtils.importESModule(
      "resource://gre/modules/addons/XPIExports.sys.mjs"
    );
    XPIExports.XPIProvider._stagedLifecycleTestHook = null;
    await cleanupClassicProviderTest(
      id,
      appTargetPath,
      managerRunning,
      enabledScopes,
      sideloadScopes
    );
  }
});

add_task(async function test_actual_classic_staged_update_and_cancel() {
  const id = ACTUAL_CLASSIC_UPDATE_ID;
  const chromePackage = "actual-classic-update";
  const enabledScopes = Services.prefs.getIntPref("extensions.enabledScopes");
  const sideloadScopes = Services.prefs.getIntPref(
    "extensions.sideloadScopes",
    AddonManager.SCOPE_PROFILE
  );
  let managerRunning = true;

  try {
    let install = await promiseInstallFile(
      createClassicVersionXPI(id, "1.0", chromePackage)
    );
    Assert.equal(install.state, AddonManager.STATE_INSTALLED);
    await promiseRestartManager();
    let addon = await AddonManager.getAddonByID(id);
    Assert.equal(addon?.version, "1.0");
    Assert.equal(await readChromeMarker(chromePackage), "1.0");

    install = await promiseInstallFile(
      createClassicVersionXPI(id, "2.0", chromePackage)
    );
    Assert.equal(install.state, AddonManager.STATE_INSTALLED);
    await install.cancel();
    let snapshot = await readAddonStateSnapshot();
    Assert.ok(!snapshot.startup["app-profile"].staged?.[id]);

    await promiseRestartManager();
    addon = await AddonManager.getAddonByID(id);
    Assert.equal(addon?.version, "1.0");
    Assert.equal(await readChromeMarker(chromePackage), "1.0");

    await promiseInstallFile(createClassicVersionXPI(id, "2.0", chromePackage));
    await promiseRestartManager();
    addon = await AddonManager.getAddonByID(id);
    Assert.equal(addon?.version, "2.0");
    Assert.ok(addon.isActive);
    Assert.equal(await readChromeMarker(chromePackage), "2.0");
  } finally {
    await cleanupClassicProviderTest(
      id,
      null,
      managerRunning,
      enabledScopes,
      sideloadScopes
    );
  }
});

add_task(async function test_retained_scope_cleared_on_manager_restart() {
  clearP0Events();
  let managerRunning = true;
  try {
    let addon = (
      await promiseInstallFile(
        createHybridBootstrapXPI(RETAINED_SCOPE_ID, "1.0")
      )
    ).addon;
    Assert.ok(addon.isActive);

    const { XPIExports } = ChromeUtils.importESModule(
      "resource://gre/modules/addons/XPIExports.sys.mjs"
    );
    const activeScope =
      XPIExports.XPIProvider.activeAddons.get(RETAINED_SCOPE_ID);
    await activeScope.shutdown(
      AddonManagerPrivate.BOOTSTRAP_REASONS.ADDON_UPGRADE,
      { oldVersion: "1.0", newVersion: "2.0" }
    );
    Assert.ok(!activeScope.started);

    await promiseShutdownManager();
    managerRunning = false;
    await promiseStartupManager();
    managerRunning = true;
    addon = await AddonManager.getAddonByID(RETAINED_SCOPE_ID);
    Assert.equal(addon?.version, "1.0");
    Assert.ok(addon.isActive);

    clearP0Events();
    addon = (
      await promiseInstallFile(
        createHybridBootstrapXPI(RETAINED_SCOPE_ID, "3.0")
      )
    ).addon;
    Assert.equal(addon.version, "3.0");
    Assert.equal(
      getP0Events(RETAINED_SCOPE_ID).filter(event =>
        event.includes(":1.0:uninstall:")
      ).length,
      1,
      "A stale retained package scope is not replayed"
    );
    await addon.uninstall();
  } finally {
    if (!managerRunning) {
      await promiseStartupManager();
    }
    const addon = await AddonManager.getAddonByID(RETAINED_SCOPE_ID);
    if (addon) {
      await addon.uninstall();
    }
    clearP0Events();
  }
});

add_task(async function test_app_shutdown_registration_retention() {
  const id = APP_SHUTDOWN_ID;
  const chromePackage = "app-shutdown-classic";
  await promiseInstallFile(createClassicVersionXPI(id, "1.0", chromePackage));
  await promiseRestartManager();

  const addon = await AddonManager.getAddonByID(id);
  Assert.ok(addon?.isActive);
  Assert.equal(await readChromeMarker(chromePackage), "1.0");

  Services.startup.advanceShutdownPhase(
    Ci.nsIAppStartup.SHUTDOWN_PHASE_APPSHUTDOWNCONFIRMED
  );
  const { MockAsyncShutdown } = ChromeUtils.importESModule(
    "resource://testing-common/AddonTestUtils.sys.mjs"
  );
  await MockAsyncShutdown.appShutdownConfirmed.trigger();

  Assert.equal(await readChromeMarker(chromePackage), "1.0");
  Assert.ok(
    ExtensionSupport.loadedLegacyExtensions.has(id),
    "Classic registrations remain owned until process exit"
  );
});
