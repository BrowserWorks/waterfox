createAppInfo("xpcshell@tests.mozilla.org", "XPCShell", "1", "1");

const ADDONS = {
  test_bootstrap_const: {
    "install.rdf": createInstallRDF({
      id: "bootstrap@tests.mozilla.org",
    }),
    "bootstrap.js":
      'var {Services} = ChromeUtils.import("resource://gre/modules/Services.jsm");\n\nconst install = function() {\n  Services.obs.notifyObservers(null, "addon-install");\n};\n',
  },
};

add_task(async () => {
  await promiseStartupManager();

  let sawInstall = false;
  Services.obs.addObserver(() => {
    sawInstall = true;
  }, "addon-install");

  await AddonTestUtils.promiseInstallXPI(ADDONS.test_bootstrap_const);

  ok(sawInstall);
});
