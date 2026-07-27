/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const LOCKED_PREF = "test.extension-support.locked-default";
const FOLLOWING_PREF = "test.extension-support.following-default";

const { updateAppInfo } = ChromeUtils.importESModule(
  "resource://testing-common/AppInfo.sys.mjs"
);
updateAppInfo({
  name: "XPCShell",
  ID: "xpcshell@tests.mozilla.org",
  version: "1",
  platformVersion: "1",
});

const { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);

add_task(async function test_locked_default_does_not_abort_reload() {
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const root = do_get_tempdir();
  root.append("test_extension_support_locked_defaults");
  root.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);

  const defaults = root.clone();
  defaults.append("defaults");
  defaults.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  const preferences = defaults.clone();
  preferences.append("preferences");
  preferences.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  const prefFile = preferences.clone();
  prefFile.append("locked.js");
  await IOUtils.writeUTF8(
    prefFile.path,
    `pref("${LOCKED_PREF}", false);\npref("${FOLLOWING_PREF}", true);\n`
  );

  let firstRegistration;
  let secondRegistration;
  try {
    if (defaultBranch.prefIsLocked(LOCKED_PREF)) {
      defaultBranch.unlockPref(LOCKED_PREF);
    }
    defaultBranch.deleteBranch(LOCKED_PREF);
    defaultBranch.deleteBranch(FOLLOWING_PREF);

    firstRegistration = await ExtensionSupport.loadAddonPrefs(root, {
      trackChanges: true,
    });
    Assert.ok(firstRegistration);
    Assert.ok(!defaultBranch.getBoolPref(LOCKED_PREF));
    Assert.ok(defaultBranch.getBoolPref(FOLLOWING_PREF));

    defaultBranch.setBoolPref(LOCKED_PREF, true);
    defaultBranch.lockPref(LOCKED_PREF);
    firstRegistration.unregister();
    firstRegistration = null;

    Assert.ok(defaultBranch.prefIsLocked(LOCKED_PREF));
    Assert.ok(defaultBranch.getBoolPref(LOCKED_PREF));
    Assert.equal(
      defaultBranch.getPrefType(FOLLOWING_PREF),
      Ci.nsIPrefBranch.PREF_INVALID
    );

    secondRegistration = await ExtensionSupport.loadAddonPrefs(root, {
      trackChanges: true,
    });
    Assert.ok(secondRegistration);
    Assert.ok(defaultBranch.prefIsLocked(LOCKED_PREF));
    Assert.ok(defaultBranch.getBoolPref(LOCKED_PREF));
    Assert.ok(defaultBranch.getBoolPref(FOLLOWING_PREF));

    secondRegistration.unregister();
    secondRegistration = null;
    Assert.equal(
      defaultBranch.getPrefType(FOLLOWING_PREF),
      Ci.nsIPrefBranch.PREF_INVALID
    );
  } finally {
    firstRegistration?.unregister();
    secondRegistration?.unregister();
    if (defaultBranch.prefIsLocked(LOCKED_PREF)) {
      defaultBranch.unlockPref(LOCKED_PREF);
    }
    defaultBranch.deleteBranch(LOCKED_PREF);
    defaultBranch.deleteBranch(FOLLOWING_PREF);
    if (root.exists()) {
      root.remove(true);
    }
  }
});
