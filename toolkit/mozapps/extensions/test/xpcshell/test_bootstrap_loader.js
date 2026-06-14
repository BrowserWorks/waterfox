/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const APP_ID = "xpcshell@tests.mozilla.org";
const BOOTSTRAP_ID = "bootstrap-loader@tests.mozilla.org";
const OTHER_LOADER_ID = "other-loader@tests.mozilla.org";
const EVENTS_PREF = "test.bootstrap-loader.events";

createAppInfo(APP_ID, "XPCShell", "153.0", "153.0");
gUseRealCertChecks = true;
Services.prefs.unlockPref(PREF_XPI_SIGNATURES_REQUIRED);
Services.prefs.setBoolPref(PREF_XPI_SIGNATURES_REQUIRED, false);

const { BootstrapLoader } = ChromeUtils.importESModule(
  "resource:///modules/BootstrapLoader.sys.mjs"
);
AddonManager.addExternalExtensionLoader(BootstrapLoader);
BootstrapMonitor.init();

function createBootstrapXPI() {
  return AddonTestUtils.createTempXPIFile({
    "install.rdf": `<?xml version="1.0"?>
<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
     xmlns:em="http://www.mozilla.org/2004/em-rdf#">
  <Description about="urn:mozilla:install-manifest">
    <em:id>${BOOTSTRAP_ID}</em:id>
    <em:type>2</em:type>
    <em:name>Bootstrap loader test</em:name>
    <em:version>1.0</em:version>
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
  </Description>
</RDF>`,
    "bootstrap.js": `
function record(method, reason) {
  const pref = "${EVENTS_PREF}";
  const events = Services.prefs.getStringPref(pref, "");
  Services.prefs.setStringPref(pref, events + method + ":" + reason + ",");
}
function install(data, reason) {
  record("install", reason);
}
function uninstall(data, reason) {
  record("uninstall", reason);
}
function startup(data, reason) {
  record("startup", reason);
}
function shutdown(data, reason) {
  record("shutdown", reason);
}
`,
    "chrome.manifest": `content bootstrap-loader content/
skin bootstrap-loader classic/1.0 skin/
`,
    "content/options.xhtml": "<window/>",
    "skin/icon.svg": "<svg/>",
  });
}

function getBootstrapEvents() {
  return Services.prefs
    .getStringPref(EVENTS_PREF, "")
    .split(",")
    .filter(Boolean);
}

registerCleanupFunction(async () => {
  for (const id of [BOOTSTRAP_ID, OTHER_LOADER_ID]) {
    const addon = await AddonManager.getAddonByID(id);
    if (addon) {
      await addon.uninstall();
    }
  }
  Services.prefs.clearUserPref(EVENTS_PREF);
  Services.prefs.clearUserPref(PREF_XPI_SIGNATURES_REQUIRED);
  gUseRealCertChecks = false;
});

add_task(async function test_bootstrap_loader() {
  await promiseStartupManager();

  const install = await promiseInstallFile(createBootstrapXPI());
  const addon = install.addon;

  Assert.equal(addon.id, BOOTSTRAP_ID);
  Assert.equal(addon.name, "Bootstrap loader test");
  Assert.equal(addon.__AddonInternal__.loader, "bootstrap");
  Assert.ok(!addon.isWebExtension);
  Assert.ok(!addon.appDisabled);
  Assert.ok(addon.isActive);
  Assert.equal(addon.optionsType, null);
  Assert.notEqual(addon.signedState, AddonManager.SIGNEDSTATE_PRIVILEGED);

  const chromeRegistry = Cc["@mozilla.org/chrome/chrome-registry;1"].getService(
    Ci.nsIChromeRegistry
  );
  const contentURI = chromeRegistry.convertChromeURL(
    Services.io.newURI("chrome://bootstrap-loader/content/options.xhtml")
  );
  const skinURI = chromeRegistry.convertChromeURL(
    Services.io.newURI("chrome://bootstrap-loader/skin/icon.svg")
  );
  Assert.ok(contentURI.spec.endsWith("/content/options.xhtml"));
  Assert.ok(skinURI.spec.endsWith("/skin/icon.svg"));

  Assert.deepEqual(getBootstrapEvents(), [
    `install:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
  ]);

  await addon.disable();
  Assert.ok(!addon.isActive);
  Assert.deepEqual(getBootstrapEvents(), [
    `install:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `shutdown:${BOOTSTRAP_REASONS.ADDON_DISABLE}`,
  ]);

  await addon.enable();
  Assert.ok(addon.isActive);
  Assert.deepEqual(getBootstrapEvents(), [
    `install:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_INSTALL}`,
    `shutdown:${BOOTSTRAP_REASONS.ADDON_DISABLE}`,
    `startup:${BOOTSTRAP_REASONS.ADDON_ENABLE}`,
  ]);

  await addon.uninstall();

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
  Assert.notEqual(
    otherAddon.signedState,
    AddonManager.SIGNEDSTATE_PRIVILEGED
  );
  BootstrapMonitor.checkNotStarted(OTHER_LOADER_ID);
  await otherAddon.uninstall();
});
