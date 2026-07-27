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

async function createPreferenceRoot(name, contents) {
  const root = do_get_tempdir();
  root.append(name);
  root.createUnique(Ci.nsIFile.DIRECTORY_TYPE, 0o755);

  const defaults = root.clone();
  defaults.append("defaults");
  defaults.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  const preferences = defaults.clone();
  preferences.append("preferences");
  preferences.create(Ci.nsIFile.DIRECTORY_TYPE, 0o755);
  const prefFile = preferences.clone();
  prefFile.append("prefs.js");
  await IOUtils.writeUTF8(prefFile.path, contents);
  return root;
}

function startConsoleCapture() {
  const messages = [];
  const listener = message => {
    messages.push(message.message ?? String(message));
  };
  Services.console.registerListener(listener);
  return {
    messages,
    stop() {
      Services.console.unregisterListener(listener);
    },
  };
}

function waitForConsoleMessages() {
  return new Promise(resolve => {
    Services.tm.dispatchToMainThread(resolve);
  });
}

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

add_task(async function test_default_preserves_existing_user_value() {
  const prefName = "test.extension-support.existing-user";
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const root = await createPreferenceRoot(
    "test_extension_support_existing_user",
    `pref("${prefName}", 0);\n`
  );
  const capture = startConsoleCapture();

  let registration;
  try {
    Services.prefs.deleteBranch(prefName);
    Services.prefs.setIntPref(prefName, 7);
    Assert.ok(!defaultBranch.prefHasDefaultValue(prefName));
    Assert.ok(Services.prefs.prefHasUserValue(prefName));

    registration = await ExtensionSupport.loadAddonPrefs(root, {
      trackChanges: true,
    });
    await waitForConsoleMessages();
    Assert.ok(registration);
    Assert.ok(
      !capture.messages.some(message =>
        message.includes(`Unable to set legacy preference ${prefName}`)
      )
    );
    Assert.ok(defaultBranch.prefHasDefaultValue(prefName));
    Assert.equal(defaultBranch.getIntPref(prefName), 0);
    Assert.equal(Services.prefs.getIntPref(prefName), 7);

    registration.unregister();
    registration = null;
    Assert.ok(!defaultBranch.prefHasDefaultValue(prefName));
    Assert.ok(Services.prefs.prefHasUserValue(prefName));
    Assert.equal(Services.prefs.getIntPref(prefName), 7);
  } finally {
    capture.stop();
    registration?.unregister();
    Services.prefs.deleteBranch(prefName);
    if (root.exists()) {
      root.remove(true);
    }
  }
});

add_task(async function test_default_removal_preserves_preference_tree() {
  const prefName = "test.extension-support.preserved-tree";
  const childWithDefault = `${prefName}.both`;
  const userOnlyChild = `${prefName}.user-only`;
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const root = await createPreferenceRoot(
    "test_extension_support_preserved_tree",
    `pref("${prefName}", 1);\n`
  );

  let registration;
  try {
    Services.prefs.deleteBranch(prefName);
    defaultBranch.setStringPref(childWithDefault, "child default");
    Services.prefs.setStringPref(childWithDefault, "child user");
    Services.prefs.setBoolPref(userOnlyChild, true);

    registration = await ExtensionSupport.loadAddonPrefs(root, {
      trackChanges: true,
    });
    Assert.ok(registration);
    Services.prefs.setIntPref(prefName, 9);

    registration.unregister();
    registration = null;
    Assert.ok(!defaultBranch.prefHasDefaultValue(prefName));
    Assert.ok(Services.prefs.prefHasUserValue(prefName));
    Assert.equal(Services.prefs.getIntPref(prefName), 9);
    Assert.equal(
      defaultBranch.getStringPref(childWithDefault),
      "child default"
    );
    Assert.equal(Services.prefs.getStringPref(childWithDefault), "child user");
    Assert.ok(!defaultBranch.prefHasDefaultValue(userOnlyChild));
    Assert.ok(Services.prefs.getBoolPref(userOnlyChild));
  } finally {
    registration?.unregister();
    Services.prefs.deleteBranch(prefName);
    if (root.exists()) {
      root.remove(true);
    }
  }
});

add_task(async function test_failed_preference_is_not_tracked() {
  const failedPref = "test.extension-support.failed-default";
  const followingPref = "test.extension-support.after-failed-default";
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const root = await createPreferenceRoot(
    "test_extension_support_failed_default",
    `pref("${failedPref}", null);\npref("${followingPref}", true);\n`
  );
  const capture = startConsoleCapture();

  let registration;
  try {
    Services.prefs.deleteBranch(failedPref);
    Services.prefs.deleteBranch(followingPref);

    registration = await ExtensionSupport.loadAddonPrefs(root, {
      trackChanges: true,
    });
    Assert.ok(registration);
    Assert.ok(!defaultBranch.prefHasDefaultValue(failedPref));
    Assert.ok(defaultBranch.getBoolPref(followingPref));

    registration.unregister();
    registration = null;
    await waitForConsoleMessages();

    Assert.ok(
      capture.messages.some(message =>
        message.includes(`Unable to set legacy preference ${failedPref}`)
      )
    );
    Assert.ok(
      !capture.messages.some(message =>
        message.includes(
          `Default preference ${failedPref} changed before legacy add-on shutdown`
        )
      )
    );
    Assert.ok(!defaultBranch.prefHasDefaultValue(followingPref));
  } finally {
    registration?.unregister();
    capture.stop();
    Services.prefs.deleteBranch(failedPref);
    Services.prefs.deleteBranch(followingPref);
    if (root.exists()) {
      root.remove(true);
    }
  }
});

add_task(
  async function test_equal_user_default_descendant_preserves_user_value() {
    const parentPref = "test.extension-support.equal-descendant";
    const childPref = `${parentPref}.child`;
    const value = "shared value";
    const defaultBranch = Services.prefs.getDefaultBranch("");
    const root = await createPreferenceRoot(
      "test_extension_support_equal_descendant",
      `pref("${parentPref}", true);\n`
    );

    let registration;
    try {
      Services.prefs.deleteBranch(parentPref);
      Services.prefs.setStringPref(childPref, value);
      defaultBranch.setStringPref(childPref, value);
      Assert.ok(Services.prefs.prefHasUserValue(childPref));

      registration = await ExtensionSupport.loadAddonPrefs(root, {
        trackChanges: true,
      });
      Assert.ok(registration);

      registration.unregister();
      registration = null;
      Assert.ok(!defaultBranch.prefHasDefaultValue(parentPref));
      Assert.equal(defaultBranch.getStringPref(childPref), value);
      Assert.ok(Services.prefs.prefHasUserValue(childPref));
      Assert.equal(Services.prefs.getStringPref(childPref), value);
    } finally {
      registration?.unregister();
      Services.prefs.deleteBranch(parentPref);
      if (root.exists()) {
        root.remove(true);
      }
    }
  }
);

add_task(async function test_raw_localized_default_url_is_restored() {
  const prefName = "PromptUsernameAndPassword3";
  const localizedURL = "chrome://global/locale/commonDialogs.properties";
  const replacement = "replacement";
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const root = await createPreferenceRoot(
    "test_extension_support_raw_localized_default",
    `pref("${prefName}", "${replacement}");\n`
  );

  let registration;
  try {
    Services.prefs.deleteBranch(prefName);
    defaultBranch.setStringPref(prefName, localizedURL);
    Assert.equal(defaultBranch.getStringPref(prefName), localizedURL);

    registration = await ExtensionSupport.loadAddonPrefs(root, {
      trackChanges: true,
    });
    Assert.ok(registration);
    Assert.equal(defaultBranch.getStringPref(prefName), replacement);

    registration.unregister();
    registration = null;
    Assert.equal(defaultBranch.getStringPref(prefName), localizedURL);
  } finally {
    registration?.unregister();
    Services.prefs.deleteBranch(prefName);
    if (root.exists()) {
      root.remove(true);
    }
  }
});

add_task(async function test_tracked_trailing_dot_preference_is_rejected() {
  const branchName = "test.extension-support.trailing-dot";
  const trailingPref = `${branchName}.`;
  const neighboringPref = `${branchName}.neighbor`;
  const followingPref = "test.extension-support.after-trailing-dot";
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const root = await createPreferenceRoot(
    "test_extension_support_trailing_dot",
    `pref("${trailingPref}", false);\npref("${followingPref}", true);\n`
  );
  const capture = startConsoleCapture();

  let registration;
  try {
    Services.prefs.deleteBranch(branchName);
    Services.prefs.deleteBranch(followingPref);
    defaultBranch.setStringPref(neighboringPref, "neighbor");

    registration = await ExtensionSupport.loadAddonPrefs(root, {
      trackChanges: true,
    });
    await waitForConsoleMessages();
    Assert.ok(registration);
    Assert.ok(!defaultBranch.prefHasDefaultValue(trailingPref));
    Assert.equal(defaultBranch.getStringPref(neighboringPref), "neighbor");
    Assert.ok(defaultBranch.getBoolPref(followingPref));
    Assert.ok(
      capture.messages.some(message =>
        message.includes(`Unable to set legacy preference ${trailingPref}`)
      )
    );

    registration.unregister();
    registration = null;
    Assert.equal(defaultBranch.getStringPref(neighboringPref), "neighbor");
    Assert.ok(!defaultBranch.prefHasDefaultValue(followingPref));
  } finally {
    registration?.unregister();
    capture.stop();
    Services.prefs.deleteBranch(branchName);
    Services.prefs.deleteBranch(followingPref);
    if (root.exists()) {
      root.remove(true);
    }
  }
});

add_task(async function test_locked_descendant_prevents_default_cleanup() {
  const parentPref = "test.extension-support.locked-descendant";
  const childPref = `${parentPref}.child`;
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const root = await createPreferenceRoot(
    "test_extension_support_locked_descendant",
    `pref("${parentPref}", "parent");\n`
  );
  const capture = startConsoleCapture();

  let registration;
  try {
    Services.prefs.deleteBranch(parentPref);
    registration = await ExtensionSupport.loadAddonPrefs(root, {
      trackChanges: true,
    });
    Assert.ok(registration);

    defaultBranch.setStringPref(childPref, "child");
    defaultBranch.lockPref(childPref);
    registration.unregister();
    registration = null;
    await waitForConsoleMessages();

    Assert.equal(defaultBranch.getStringPref(parentPref), "parent");
    Assert.equal(defaultBranch.getStringPref(childPref), "child");
    Assert.ok(defaultBranch.prefIsLocked(childPref));
    Assert.ok(
      capture.messages.some(message =>
        message.includes(`Unable to restore default preference ${parentPref}`)
      )
    );
  } finally {
    if (defaultBranch.prefIsLocked(childPref)) {
      defaultBranch.unlockPref(childPref);
    }
    registration?.unregister();
    capture.stop();
    Services.prefs.deleteBranch(parentPref);
    if (root.exists()) {
      root.remove(true);
    }
  }
});

add_task(async function test_locked_owned_preference_is_not_restored() {
  const prefName = "test.extension-support.locked-owned-default";
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const root = await createPreferenceRoot(
    "test_extension_support_locked_owned_default",
    `pref("${prefName}", "owned");\n`
  );
  const capture = startConsoleCapture();

  let registration;
  try {
    Services.prefs.deleteBranch(prefName);
    defaultBranch.setStringPref(prefName, "base");

    registration = await ExtensionSupport.loadAddonPrefs(root, {
      trackChanges: true,
    });
    Assert.ok(registration);
    Assert.equal(defaultBranch.getStringPref(prefName), "owned");

    defaultBranch.lockPref(prefName);
    registration.unregister();
    registration = null;
    await waitForConsoleMessages();

    Assert.ok(defaultBranch.prefIsLocked(prefName));
    Assert.equal(defaultBranch.getStringPref(prefName), "owned");
    Assert.ok(
      capture.messages.some(message =>
        message.includes(
          `Default preference ${prefName} locked before legacy add-on shutdown`
        )
      )
    );
  } finally {
    if (defaultBranch.prefIsLocked(prefName)) {
      defaultBranch.unlockPref(prefName);
    }
    registration?.unregister();
    capture.stop();
    Services.prefs.deleteBranch(prefName);
    if (root.exists()) {
      root.remove(true);
    }
  }
});

add_task(async function test_failed_second_owner_preserves_first_owner() {
  const prefName = "test.extension-support.failed-second-owner";
  const defaultBranch = Services.prefs.getDefaultBranch("");
  const firstRoot = await createPreferenceRoot(
    "test_extension_support_first_owner",
    `pref("${prefName}", "first owner");\n`
  );
  const secondRoot = await createPreferenceRoot(
    "test_extension_support_failed_second_owner",
    `pref("${prefName}", null);\n`
  );
  const capture = startConsoleCapture();

  let firstRegistration;
  let secondRegistration;
  try {
    Services.prefs.deleteBranch(prefName);
    defaultBranch.setStringPref(prefName, "base");

    firstRegistration = await ExtensionSupport.loadAddonPrefs(firstRoot, {
      trackChanges: true,
    });
    Assert.ok(firstRegistration);
    Assert.equal(defaultBranch.getStringPref(prefName), "first owner");

    secondRegistration = await ExtensionSupport.loadAddonPrefs(secondRoot, {
      trackChanges: true,
    });
    await waitForConsoleMessages();
    Assert.ok(secondRegistration);
    Assert.equal(defaultBranch.getStringPref(prefName), "first owner");
    Assert.ok(
      capture.messages.some(message =>
        message.includes(`Unable to set legacy preference ${prefName}`)
      )
    );

    secondRegistration.unregister();
    secondRegistration = null;
    Assert.equal(defaultBranch.getStringPref(prefName), "first owner");

    firstRegistration.unregister();
    firstRegistration = null;
    Assert.equal(defaultBranch.getStringPref(prefName), "base");
  } finally {
    secondRegistration?.unregister();
    firstRegistration?.unregister();
    capture.stop();
    Services.prefs.deleteBranch(prefName);
    if (firstRoot.exists()) {
      firstRoot.remove(true);
    }
    if (secondRoot.exists()) {
      secondRoot.remove(true);
    }
  }
});
