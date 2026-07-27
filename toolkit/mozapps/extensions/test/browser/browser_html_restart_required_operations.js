"use strict";

const ENABLED_ID = "restart-enabled@mochi.test";
const DISABLED_ID = "restart-disabled@mochi.test";
const UPDATE_ID = "restart-update@mochi.test";
const UNINSTALL_ID = "restart-uninstall@mochi.test";
const NEW_INSTALL_ID = "restart-new-install@mochi.test";
const NEW_INSTALL_NAME = "Restart New Install";
const REAL_UPDATE_ID = "restart-real-update@mochi.test";
const REAL_UPDATE_NAME = "Restart Real Update";

let gProvider;

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["xpinstall.signatures.required", false]],
  });
  gProvider = new MockProvider(["extension"], {
    supportsOperationsRequiringRestart: true,
  });
});

async function assertCardMessage(win, addon, messageId) {
  const card = getAddonCard(win, addon.id);
  const messageBar = card.querySelector(".addon-card-message");
  await TestUtils.waitForCondition(() => {
    const { id, args } = win.document.l10n.getAttributes(messageBar);
    return !messageBar.hidden && id === messageId && args?.addon === addon.name;
  }, `${addon.id} has the expected pending-operation message`);
  return card;
}

async function assertNoCardMessage(win, addon) {
  const card = getAddonCard(win, addon.id);
  await TestUtils.waitForCondition(
    () => card.querySelector(".addon-card-message").hidden,
    `${addon.id} has no pending-operation message`
  );
}

function getStagedInstallFile(id) {
  const file = Services.dirsvc.get("ProfD", Ci.nsIFile);
  file.append("extensions");
  file.append("staged");
  file.append(`${id}.xpi`);
  return file;
}

async function readAddonStartupState() {
  const file = Services.dirsvc.get("ProfD", Ci.nsIFile);
  file.append("addonStartup.json.lz4");
  return IOUtils.readJSON(file.path, { decompress: true });
}

function createRestartRequiredXPI(id, name, version) {
  return AddonTestUtils.createTempWebExtensionFile({
    manifest: {
      manifest_version: 2,
      name,
      version,
      browser_specific_settings: { gecko: { id } },
      legacy: { type: "xul" },
    },
  });
}

add_task(async function test_pending_new_restart_install_ui() {
  const xpi = createRestartRequiredXPI(NEW_INSTALL_ID, NEW_INSTALL_NAME, "1.0");
  const stagedFile = getStagedInstallFile(NEW_INSTALL_ID);
  let install;
  let win = await loadInitialView("extension");

  try {
    let list = win.document.querySelector("addon-list");
    const added = BrowserTestUtils.waitForEvent(list, "add");
    install = await AddonManager.getInstallForFile(xpi);
    await install.install();
    await added;

    is(install.state, AddonManager.STATE_INSTALLED, "The install is staged");
    is(
      install.addon.signedState,
      AddonManager.SIGNEDSTATE_MISSING,
      "The pending-install action takes precedence over the unsigned warning"
    );
    ok(
      install.addon.pendingOperations & AddonManager.PENDING_INSTALL,
      "The new add-on is pending installation"
    );
    ok(stagedFile.exists(), "The staged XPI exists");
    is(
      await AddonManager.getAddonByID(NEW_INSTALL_ID),
      null,
      "The staged add-on is not installed before restart"
    );
    let startupState = await readAddonStartupState();
    ok(
      startupState["app-profile"].staged[NEW_INSTALL_ID],
      "The staged install metadata exists"
    );

    let card = await assertCardMessage(
      win,
      install.addon,
      "pending-restart-install-description"
    );
    is(card.addon, install.addon, "The card represents the staged add-on");
    is(
      card.addonNameEl.textContent,
      NEW_INSTALL_NAME,
      "The staged add-on is not labeled as disabled"
    );
    ok(
      !card.querySelector(".addon-name-link"),
      "The staged add-on does not link to an unavailable detail view"
    );
    ok(
      card.querySelector(".more-options-button").hidden,
      "Unavailable add-on actions are hidden"
    );
    ok(
      card.querySelector('[action="toggle-disabled"]').hidden,
      "The enable toggle is hidden"
    );
    ok(
      card.querySelector('[action="cancel-install"]'),
      "The staged install can be cancelled"
    );

    await closeView(win);
    win = null;
    win = await loadInitialView("extension");
    list = win.document.querySelector("addon-list");
    card = await assertCardMessage(
      win,
      install.addon,
      "pending-restart-install-description"
    );
    ok(card, "The staged install is represented after reopening the view");

    const removed = BrowserTestUtils.waitForEvent(list, "remove");
    card.querySelector('[action="cancel-install"]').click();
    await removed;
    is(card.parentNode, null, "Cancelling removes the staged add-on card");

    await TestUtils.waitForCondition(async () => {
      startupState = await readAddonStartupState();
      return (
        install.state === AddonManager.STATE_CANCELLED &&
        !(await AddonManager.getAllInstalls()).includes(install) &&
        !stagedFile.exists() &&
        !startupState["app-profile"].staged?.[NEW_INSTALL_ID]
      );
    }, "Cancellation removes the staged install state and XPI");
    is(
      await AddonManager.getAddonByID(NEW_INSTALL_ID),
      null,
      "The cancelled add-on is not installed"
    );

    const addedAgain = BrowserTestUtils.waitForEvent(list, "add");
    install = await AddonManager.getInstallForFile(xpi);
    await install.install();
    await addedAgain;
    await assertCardMessage(
      win,
      install.addon,
      "pending-restart-install-description"
    );

    await closeView(win);
    win = null;
    await AddonTestUtils.promiseRestartManager();
    const installedAddon = await AddonManager.getAddonByID(NEW_INSTALL_ID);
    install = null;
    ok(installedAddon, "The staged add-on is installed after restart");
    is(installedAddon.version, "1.0", "The installed version is correct");
    ok(!stagedFile.exists(), "Restart consumes the staged XPI");

    win = await loadInitialView("extension");
    const installedCard = getAddonCard(win, NEW_INSTALL_ID);
    ok(installedCard, "The installed add-on replaces the pending card");
    await assertNoCardMessage(win, installedAddon);
    ok(
      installedCard.querySelector(".addon-name-link"),
      "The installed add-on links to its detail view"
    );
  } finally {
    if (win) {
      await closeView(win);
    }
    if (install?.state === AddonManager.STATE_INSTALLED) {
      await install.cancel();
    }
    const addon = await AddonManager.getAddonByID(NEW_INSTALL_ID);
    if (addon) {
      await addon.uninstall();
      if (addon.pendingOperations & AddonManager.PENDING_UNINSTALL) {
        await AddonTestUtils.promiseRestartManager();
      }
    }
  }
});

add_task(async function test_actual_classic_staged_update_ui() {
  const v1 = createRestartRequiredXPI(REAL_UPDATE_ID, REAL_UPDATE_NAME, "1.0");
  const v2 = createRestartRequiredXPI(REAL_UPDATE_ID, REAL_UPDATE_NAME, "2.0");
  const stagedFile = getStagedInstallFile(REAL_UPDATE_ID);
  let install;
  let win;

  try {
    install = await AddonManager.getInstallForFile(v1);
    await install.install();
    await AddonTestUtils.promiseRestartManager();
    install = null;

    let addon = await AddonManager.getAddonByID(REAL_UPDATE_ID);
    ok(addon, "The real classic add-on is installed");
    is(addon.version, "1.0", "The initial version is active");
    win = await loadInitialView("extension");
    const originalCard = getAddonCard(win, REAL_UPDATE_ID);

    install = await AddonManager.getInstallForFile(v2);
    await install.install();
    is(install.state, AddonManager.STATE_INSTALLED, "The update is staged");
    ok(stagedFile.exists(), "The staged update XPI exists");
    const pendingCard = await assertCardMessage(
      win,
      addon,
      "pending-restart-update-description"
    );
    is(pendingCard, originalCard, "The update keeps the existing add-on card");

    pendingCard.querySelector('[action="cancel-update"]').click();
    await TestUtils.waitForCondition(
      () =>
        install.state === AddonManager.STATE_CANCELLED &&
        !stagedFile.exists() &&
        !addon.pendingUpgrade,
      "Cancelling the real update removes its package and pending state"
    );
    await assertNoCardMessage(win, addon);

    install = await AddonManager.getInstallForFile(v2);
    await install.install();
    await assertCardMessage(win, addon, "pending-restart-update-description");
    await closeView(win);
    win = null;
    await AddonTestUtils.promiseRestartManager();
    install = null;

    addon = await AddonManager.getAddonByID(REAL_UPDATE_ID);
    is(addon.version, "2.0", "Restart activates the staged update");
    win = await loadInitialView("extension");
    const updatedCard = getAddonCard(win, REAL_UPDATE_ID);
    ok(updatedCard, "The updated add-on remains represented");
    await assertNoCardMessage(win, addon);
  } finally {
    if (win) {
      await closeView(win);
    }
    if (install?.state === AddonManager.STATE_INSTALLED) {
      await install.cancel();
    }
    const addon = await AddonManager.getAddonByID(REAL_UPDATE_ID);
    if (addon) {
      await addon.uninstall();
      if (addon.pendingOperations & AddonManager.PENDING_UNINSTALL) {
        await AddonTestUtils.promiseRestartManager();
      }
    }
  }
});

add_task(async function test_restart_required_operation_messages() {
  const [enabledAddon, disabledAddon, updateAddon, uninstallAddon] =
    gProvider.createAddons([
      {
        id: ENABLED_ID,
        name: "Restart Enabled",
        type: "extension",
        signedState: AddonManager.SIGNEDSTATE_NOT_REQUIRED,
      },
      {
        id: DISABLED_ID,
        name: "Restart Disabled",
        type: "extension",
        userDisabled: true,
        signedState: AddonManager.SIGNEDSTATE_NOT_REQUIRED,
      },
      {
        id: UPDATE_ID,
        name: "Restart Update",
        type: "extension",
        signedState: AddonManager.SIGNEDSTATE_NOT_REQUIRED,
      },
      {
        id: UNINSTALL_ID,
        name: "Restart Uninstall",
        type: "extension",
        signedState: AddonManager.SIGNEDSTATE_NOT_REQUIRED,
      },
    ]);

  let win = await loadInitialView("extension");
  const list = win.document.querySelector("addon-list");

  const [updateInstall] = gProvider.createInstalls([
    {
      existingAddon: updateAddon,
      name: updateAddon.name,
      operationsRequiringRestart: AddonManager.OP_NEEDS_RESTART_INSTALL,
      type: "extension",
      version: "2.0",
    },
  ]);
  const updateCard = getAddonCard(win, UPDATE_ID);
  await TestUtils.waitForCondition(
    () => !updateCard.querySelector('[action="install-update"]').hidden,
    "The available update action is visible"
  );
  updateCard.querySelector('[action="install-update"]').click();
  await assertCardMessage(
    win,
    updateAddon,
    "pending-restart-update-description"
  );
  is(updateCard.addon, updateAddon, "The card keeps the installed add-on");
  ok(
    updateCard.querySelector('[action="install-update"]').hidden,
    "The staged update is not offered for installation again"
  );
  const updateUndo = updateCard.querySelector('[action="cancel-update"]');
  ok(updateUndo, "The staged update can be cancelled");
  updateUndo.click();
  await TestUtils.waitForCondition(
    () => updateInstall.state === AddonManager.STATE_CANCELLED,
    "The staged update is cancelled"
  );
  await assertNoCardMessage(win, updateAddon);

  await enabledAddon.disable();
  await assertCardMessage(
    win,
    enabledAddon,
    "pending-restart-disable-description"
  );
  await enabledAddon.enable();
  await assertNoCardMessage(win, enabledAddon);

  await disabledAddon.enable();
  await assertCardMessage(
    win,
    disabledAddon,
    "pending-restart-enable-description"
  );
  await disabledAddon.disable();
  await assertNoCardMessage(win, disabledAddon);

  const removed = BrowserTestUtils.waitForEvent(list, "remove");
  uninstallAddon.uninstall();
  await removed;

  const uninstallBar = list.querySelector(
    `moz-message-bar[addon-id="${UNINSTALL_ID}"]`
  );
  ok(uninstallBar, "The pending uninstall message bar is visible");
  Assert.deepEqual(
    win.document.l10n.getAttributes(uninstallBar),
    {
      id: "pending-uninstall-restart-description",
      args: { addon: uninstallAddon.name },
    },
    "The pending uninstall message explains that a restart is required"
  );

  const restored = BrowserTestUtils.waitForEvent(list, "add");
  uninstallBar.querySelector('[action="undo"]').click();
  await restored;

  const removedBeforeClose = BrowserTestUtils.waitForEvent(list, "remove");
  uninstallAddon.uninstall();
  await removedBeforeClose;
  await closeView(win);

  win = await loadInitialView("extension");
  const reopenedList = win.document.querySelector("addon-list");
  const reopenedBar = reopenedList.querySelector(
    `moz-message-bar[addon-id="${UNINSTALL_ID}"]`
  );
  ok(reopenedBar, "The restart-required uninstall remains pending");
  const restoredAfterClose = BrowserTestUtils.waitForEvent(reopenedList, "add");
  reopenedBar.querySelector('[action="undo"]').click();
  await restoredAfterClose;
  await closeView(win);
});
