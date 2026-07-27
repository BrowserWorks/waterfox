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

const ACTUAL_CLASSIC_UPDATE_ID = "actual-classic-update@tests.waterfox.net";
const RETAINED_SCOPE_ID = "retained-scope@tests.waterfox.net";

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

function clearP0Events() {
  Services.prefs.clearUserPref(P0_EVENTS_PREF);
}

async function copyNamedXPI(source, id) {
  const target = do_get_tempdir();
  target.append(`${id}.xpi`);
  await IOUtils.remove(target.path, { ignoreAbsent: true });
  await IOUtils.copy(source.path, target.path);
  return target;
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
