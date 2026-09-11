/* Any copyright is dedicated to the Public Domain.
https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { BasePromiseWorker } = ChromeUtils.importESModule(
  "resource://gre/modules/PromiseWorker.sys.mjs"
);
const { JsonSchema } = ChromeUtils.importESModule(
  "resource://gre/modules/JsonSchema.sys.mjs"
);
const { UIState } = ChromeUtils.importESModule(
  "resource://services-sync/UIState.sys.mjs"
);
const { ClientID } = ChromeUtils.importESModule(
  "resource://gre/modules/ClientID.sys.mjs"
);
const { ERRORS } = ChromeUtils.importESModule(
  "chrome://browser/content/backup/backup-constants.mjs"
);

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const LAST_BACKUP_TIMESTAMP_PREF_NAME =
  "browser.backup.scheduled.last-backup-timestamp";
const LAST_BACKUP_FILE_NAME_PREF_NAME =
  "browser.backup.scheduled.last-backup-file";
const BACKUP_ARCHIVE_ENABLED_PREF_NAME = "browser.backup.archive.enabled";

/** @type {nsIToolkitProfile} */
let currentProfile;

// Mock backup metadata
const DATE = "2024-06-25T21:59:11.777Z";
const IS_ENCRYPTED = true;
const DEVICE_NAME = "test-device";
const APP_NAME = "test-app-name";
const APP_VERSION = "test-app-version";
const BUILD_ID = "test-build-id";
const OS_NAME = "test-os-name";
const OS_VERSION = "test-os-version";
const OS_BUILD_NUMBER = "test-os-build-number";
const TELEMETRY_ENABLED = true;
const LEGACY_CLIENT_ID = "legacy-client-id";
const PROFILE_NAME = "test-profile-name";

add_setup(function () {
  currentProfile = setupProfile();
});

/**
 * A utility function for testing BackupService.createBackup. This helper
 * function:
 *
 * 1. Produces a backup of fake resources
 * 2. Recovers the backup into a new profile directory
 * 3. Ensures that the resources had their backup/recovery methods called
 *
 * @param {object} sandbox
 *   The Sinon sandbox to be used stubs and mocks. The test using this helper
 *   is responsible for creating and resetting this sandbox.
 * @param {function(BackupService, BackupManifest): void} taskFn
 *   A function that is run once all default checks are done.
 *   After this function returns, all resources will be cleaned up.
 * @returns {Promise<undefined>}
 */
async function testCreateBackupHelper(sandbox, taskFn) {
  Services.fog.testResetFOG();

  const EXPECTED_CLIENT_ID = await ClientID.getClientID();
  const EXPECTED_PROFILE_GROUP_ID = await ClientID.getProfileGroupID();

  // Enable the scheduled backups pref so that backups can be deleted. We're
  // not calling initBackupScheduler on the BackupService that we're
  // constructing, so there's no danger of accidentally having a backup be
  // created during this test if there's an idle period.
  Services.prefs.setBoolPref("browser.backup.scheduled.enabled", true);
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("browser.backup.scheduled.enabled");
  });

  let fake1ManifestEntry = { fake1: "hello from 1" };
  sandbox
    .stub(FakeBackupResource1.prototype, "backup")
    .resolves(fake1ManifestEntry);
  sandbox.stub(FakeBackupResource1.prototype, "recover").resolves();

  sandbox
    .stub(FakeBackupResource2.prototype, "backup")
    .rejects(new Error("Some failure to backup"));
  sandbox.stub(FakeBackupResource2.prototype, "recover");

  let fake3ManifestEntry = { fake3: "hello from 3" };
  let fake3PostRecoveryEntry = { someData: "hello again from 3" };
  sandbox
    .stub(FakeBackupResource3.prototype, "backup")
    .resolves(fake3ManifestEntry);
  sandbox
    .stub(FakeBackupResource3.prototype, "recover")
    .resolves(fake3PostRecoveryEntry);

  let bs = BackupService.init({
    FakeBackupResource1,
    FakeBackupResource2,
    FakeBackupResource3,
  });

  let fakeProfilePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "createBackupTest"
  );

  Assert.ok(!bs.state.lastBackupDate, "No backup date is stored in state.");
  let { manifest, archivePath: backupFilePath } = await bs.createBackup({
    profilePath: fakeProfilePath,
  });
  Assert.notStrictEqual(
    bs.state.lastBackupDate,
    null,
    "The backup date was recorded."
  );

  let events = Glean.browserBackup.created.testGetValue();
  Assert.equal(events.length, 1, "Found the created Glean event.");

  // Validate total backup time metrics were recorded
  assertSingleTimeMeasurement(
    Glean.browserBackup.totalBackupTime.testGetValue()
  );

  Assert.ok(await IOUtils.exists(backupFilePath), "The backup file exists");

  let archiveDateSuffix = bs.generateArchiveDateSuffix(
    new Date(manifest.meta.date)
  );

  // We also expect the HTML file to have been written to the folder pointed
  // at by browser.backups.location, within backupDirPath folder.
  const EXPECTED_ARCHIVE_PATH = PathUtils.join(
    bs.state.backupDirPath,
    `${BackupService.BACKUP_FILE_NAME}_${manifest.meta.profileName}_${archiveDateSuffix}.html`
  );
  Assert.ok(
    await IOUtils.exists(EXPECTED_ARCHIVE_PATH),
    "Single-file backup archive was written."
  );
  Assert.equal(
    backupFilePath,
    EXPECTED_ARCHIVE_PATH,
    "Backup was written to the configured destination folder"
  );

  let snapshotsDirectoryPath = PathUtils.join(
    fakeProfilePath,
    BackupService.PROFILE_FOLDER_NAME,
    BackupService.SNAPSHOTS_FOLDER_NAME
  );
  let snapshotsDirectoryContentsPaths = await IOUtils.getChildren(
    snapshotsDirectoryPath
  );
  let snapshotsDirectoryContents = await Promise.all(
    snapshotsDirectoryContentsPaths.map(IOUtils.stat)
  );
  let snapshotsDirectorySubdirectories = snapshotsDirectoryContents.filter(
    file => file.type === "directory"
  );
  Assert.equal(
    snapshotsDirectorySubdirectories.length,
    0,
    "Snapshots directory should have had all staging folders cleaned up"
  );

  // 1 mebibyte minimum recorded value if total data size is under 1 mebibyte
  // This assumes that these BackupService tests do not create sizable fake files
  const SMALLEST_BACKUP_SIZE_BYTES = 1048576;

  // Validate total (uncompressed profile data) size
  let totalBackupSize = Glean.browserBackup.totalBackupSize.testGetValue();
  Assert.equal(
    totalBackupSize.count,
    1,
    "Should have collected a single measurement for the total backup size"
  );
  Assert.equal(
    totalBackupSize.sum,
    SMALLEST_BACKUP_SIZE_BYTES,
    "Should have collected the right value for the total backup size"
  );

  // Validate final archive (compressed/encrypted profile data + HTML) size
  let compressedArchiveSize =
    Glean.browserBackup.compressedArchiveSize.testGetValue();
  Assert.equal(
    compressedArchiveSize.count,
    1,
    "Should have collected a single measurement for the backup compressed archive size"
  );
  Assert.equal(
    compressedArchiveSize.sum,
    SMALLEST_BACKUP_SIZE_BYTES,
    "Should have collected the right value for the backup compressed archive size"
  );

  // Check that resources were called from highest to lowest backup priority.
  sinon.assert.callOrder(
    FakeBackupResource3.prototype.backup,
    FakeBackupResource2.prototype.backup,
    FakeBackupResource1.prototype.backup
  );

  let schema = await BackupService.MANIFEST_SCHEMA;
  let validationResult = JsonSchema.validate(manifest, schema);
  Assert.ok(validationResult.valid, "Schema matches manifest");
  Assert.deepEqual(
    Object.keys(manifest.resources).sort(),
    ["fake1", "fake3"],
    "Manifest contains all expected BackupResource keys"
  );
  Assert.deepEqual(
    manifest.resources.fake1,
    fake1ManifestEntry,
    "Manifest contains the expected entry for FakeBackupResource1"
  );
  Assert.deepEqual(
    manifest.resources.fake3,
    fake3ManifestEntry,
    "Manifest contains the expected entry for FakeBackupResource3"
  );
  Assert.equal(
    manifest.meta.legacyClientID,
    EXPECTED_CLIENT_ID,
    "The client ID was stored properly."
  );
  Assert.equal(
    manifest.meta.profileGroupID,
    EXPECTED_PROFILE_GROUP_ID,
    "The profile group ID was stored properly."
  );
  Assert.equal(
    manifest.meta.profileName,
    currentProfile.name,
    "The profile name was stored properly"
  );

  let recoveredProfilePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "createBackupTestRecoveredProfile"
  );

  let originalProfileName = currentProfile.name;

  let profileSvc = Cc["@mozilla.org/toolkit/profile-service;1"].getService(
    Ci.nsIToolkitProfileService
  );
  // make our current profile default
  profileSvc.defaultProfile = currentProfile;

  await bs.loadBackupFileInfo(backupFilePath);
  const restoreID = bs.state.restoreID;

  // Intercept the telemetry that we want to check for before it gets submitted
  // and cleared out.
  let restoreStartedEvents;
  let restoreCompleteEvents;
  let restoreCompleteCallback = () => {
    Services.obs.removeObserver(
      restoreCompleteCallback,
      "browser-backup-restore-complete"
    );
    restoreStartedEvents = Glean.browserBackup.restoreStarted.testGetValue();
    restoreCompleteEvents = Glean.browserBackup.restoreComplete.testGetValue();
  };
  Services.obs.addObserver(
    restoreCompleteCallback,
    "browser-backup-restore-complete"
  );

  let recoveredProfile = await bs.recoverFromBackupArchive(
    backupFilePath,
    null,
    false,
    fakeProfilePath,
    recoveredProfilePath,
    true
  );

  Assert.ok(
    recoveredProfile.name.startsWith(originalProfileName),
    "Should maintain profile name across backup and restore"
  );

  Assert.ok(
    currentProfile.name.startsWith("old-"),
    "The old profile should be prefixed with old-"
  );

  Assert.strictEqual(
    profileSvc.defaultProfile,
    recoveredProfile,
    "The new profile should now be the default"
  );

  Assert.equal(
    restoreStartedEvents.length,
    1,
    "Should be a single restore start event after we start restoring a profile"
  );
  Assert.equal(
    restoreStartedEvents[0].extra.restore_id,
    restoreID,
    "Restore started event should have the right restore_id"
  );
  Assert.equal(
    restoreStartedEvents[0].extra.replace,
    "true",
    "Restore started event should have replace=true"
  );

  Assert.equal(
    restoreCompleteEvents.length,
    1,
    "Should be a single restore complete event after we start restoring a profile"
  );
  Assert.equal(
    restoreCompleteEvents[0].extra.restore_id,
    restoreID,
    "Restore complete event should have the right restore_id"
  );

  // Check that resources were recovered from highest to lowest backup priority.
  sinon.assert.callOrder(
    FakeBackupResource3.prototype.recover,
    FakeBackupResource1.prototype.recover
  );

  let postRecoveryFilePath = PathUtils.join(
    recoveredProfilePath,
    BackupService.POST_RECOVERY_FILE_NAME
  );
  Assert.ok(
    await IOUtils.exists(postRecoveryFilePath),
    "Should have created post-recovery data file"
  );
  let postRecoveryData = await IOUtils.readJSON(postRecoveryFilePath);
  Assert.deepEqual(
    postRecoveryData.fake3,
    fake3PostRecoveryEntry,
    "Should have post-recovery data from fake backup 3"
  );

  await Assert.rejects(
    IOUtils.readJSON(
      PathUtils.join(recoveredProfilePath, "datareporting", "state.json")
    ),
    /file does not exist/,
    "The telemetry state was cleared."
  );

  await taskFn(bs, manifest);

  await maybeRemovePath(backupFilePath);
  await maybeRemovePath(fakeProfilePath);
  await maybeRemovePath(recoveredProfilePath);
  await maybeRemovePath(EXPECTED_ARCHIVE_PATH);

  Services.prefs.clearUserPref(LAST_BACKUP_FILE_NAME_PREF_NAME);

  BackupService.uninit();
}

/**
 * A utility function for testing BackupService.deleteLastBackup. This helper
 * function:
 *
 * 1. Clears any pre-existing cached preference values for the last backup
 *    date and file name.
 * 2. Uses testCreateBackupHelper to create a backup file.
 * 3. Ensures that the state has been updated to reflect the created backup,
 *    and that the backup date and file name are cached to preferences.
 * 4. Runs an optional async taskFn
 * 5. Calls deleteLastBackup on the testCreateBackupHelper BackupService
 *    instance.
 * 6. Checks that the BackupService state for the last backup date and file name
 *    have been cleared, and that the preferences caches of those values have
 *    also been cleared.
 *
 * @param {function(string): Promise<void>|null} taskFn
 *   An optional function that is run after we've created a backup, but just
 *   before calling deleteLastBackup(). It is passed the path to the created
 *   backup file.
 * @returns {Promise<undefined>}
 */
async function testDeleteLastBackupHelper(taskFn) {
  let sandbox = sinon.createSandbox();

  // Clear any last backup filenames and timestamps that might be lingering
  // from prior tests.
  Services.prefs.clearUserPref(LAST_BACKUP_TIMESTAMP_PREF_NAME);
  Services.prefs.clearUserPref(LAST_BACKUP_FILE_NAME_PREF_NAME);

  await testCreateBackupHelper(sandbox, async (bs, _manifest) => {
    Assert.notStrictEqual(
      bs.state.lastBackupDate,
      null,
      "Should have a last backup date recorded."
    );
    Assert.ok(
      bs.state.lastBackupFileName,
      "Should have a last backup file name recorded."
    );
    Assert.ok(
      Services.prefs.prefHasUserValue(LAST_BACKUP_TIMESTAMP_PREF_NAME),
      "Last backup date was cached in preferences."
    );
    Assert.ok(
      Services.prefs.prefHasUserValue(LAST_BACKUP_FILE_NAME_PREF_NAME),
      "Last backup file name was cached in preferences."
    );
    const LAST_BACKUP_FILE_PATH = PathUtils.join(
      bs.state.backupDirPath,
      bs.state.lastBackupFileName
    );
    Assert.ok(
      await IOUtils.exists(LAST_BACKUP_FILE_PATH),
      "The backup file was created and is still on the disk."
    );

    if (taskFn) {
      await taskFn(LAST_BACKUP_FILE_PATH);
    }

    // NB: On Windows, deletes of backups in tests run into an issue where
    // the file is locked briefly by the system and deletes fail with
    // NS_ERROR_FILE_IS_LOCKED.  See doFileRemovalOperation for details.
    // We therefore retry this delete a few times before accepting failure.
    await doFileRemovalOperation(async () => await bs.deleteLastBackup());

    Assert.equal(
      bs.state.lastBackupDate,
      null,
      "Should have cleared the last backup date"
    );
    Assert.equal(
      bs.state.lastBackupFileName,
      "",
      "Should have cleared the last backup file name"
    );
    Assert.ok(
      !Services.prefs.prefHasUserValue(LAST_BACKUP_TIMESTAMP_PREF_NAME),
      "Last backup date was cleared in preferences."
    );
    Assert.ok(
      !Services.prefs.prefHasUserValue(LAST_BACKUP_FILE_NAME_PREF_NAME),
      "Last backup file name was cleared in preferences."
    );
    Assert.ok(
      !(await IOUtils.exists(LAST_BACKUP_FILE_PATH)),
      "The backup file was deleted."
    );
  });

  sandbox.restore();
}

/**
 * Tests that calling BackupService.createBackup will call backup on each
 * registered BackupResource, and that each BackupResource will have a folder
 * created for them to write into. Tests in the signed-out state.
 */
add_task(async function test_createBackup_signed_out() {
  let sandbox = sinon.createSandbox();

  sandbox
    .stub(UIState, "get")
    .returns({ status: UIState.STATUS_NOT_CONFIGURED });
  await testCreateBackupHelper(sandbox, (_bs, manifest) => {
    Assert.equal(
      manifest.meta.accountID,
      undefined,
      "Account ID should be undefined."
    );
    Assert.equal(
      manifest.meta.accountEmail,
      undefined,
      "Account email should be undefined."
    );
  });

  sandbox.restore();
});

/**
 * Tests that calling BackupService.createBackup will call backup on each
 * registered BackupResource, and that each BackupResource will have a folder
 * created for them to write into. Tests in the signed-in state.
 */
add_task(async function test_createBackup_signed_in() {
  let sandbox = sinon.createSandbox();

  const TEST_UID = "ThisIsMyTestUID";
  const TEST_EMAIL = "foxy@mozilla.org";

  sandbox.stub(UIState, "get").returns({
    status: UIState.STATUS_SIGNED_IN,
    uid: TEST_UID,
    email: TEST_EMAIL,
  });

  await testCreateBackupHelper(sandbox, (_bs, manifest) => {
    Assert.equal(
      manifest.meta.accountID,
      TEST_UID,
      "Account ID should be set properly."
    );
    Assert.equal(
      manifest.meta.accountEmail,
      TEST_EMAIL,
      "Account email should be set properly."
    );
  });

  sandbox.restore();
});

/**
 * Tests that createBackup calls maybeAddToEnabledListPref after a successful
 * backup so that legacy-to-selectable profile transitions are tracked.
 */
add_task(async function test_createBackup_calls_maybeAddToEnabledListPref() {
  let sandbox = sinon.createSandbox();

  sandbox
    .stub(UIState, "get")
    .returns({ status: UIState.STATUS_NOT_CONFIGURED });

  let spy = sandbox.spy(BackupService, "maybeAddToEnabledListPref");

  await testCreateBackupHelper(sandbox, () => {
    Assert.ok(
      spy.calledOnce,
      "maybeAddToEnabledListPref should be called once during createBackup"
    );
  });

  sandbox.restore();
});

/**
 * Makes a folder readonly.  Windows does not support read-only folders, so
 * this creates a file inside the folder and makes that read-only.
 *
 * @param {string}  folderpath Full path to folder to make read-only.
 * @param {boolean} isReadonly Whether to set or clear read-only status.
 */
async function makeFolderReadonly(folderpath, isReadonly) {
  if (AppConstants.platform !== "win") {
    await IOUtils.setPermissions(folderpath, isReadonly ? 0o444 : 0o666);
    let folder = await IOUtils.getFile(folderpath);
    Assert.equal(
      folder.isWritable(),
      !isReadonly,
      `folder is ${isReadonly ? "" : "not "}read-only`
    );
  } else if (isReadonly) {
    // Permissions flags like 0o444 are not usually respected on Windows but in
    // the case of creating a unique file, the read-only status is.  See
    // OpenFile in nsLocalFileWin.cpp.
    let tempFilename = await IOUtils.createUniqueFile(
      folderpath,
      "readonlyfile",
      0o444
    );
    let file = await IOUtils.getFile(tempFilename);
    Assert.equal(file.isWritable(), false, "file in folder is read-only");
  } else {
    // Recursively set any folder contents to be writeable.
    let attrs = await IOUtils.getWindowsAttributes(folderpath);
    attrs.readonly = false;
    await IOUtils.setWindowsAttributes(folderpath, attrs, true /* recursive */);
  }
}

/**
 * Tests that read-only files in BackupService.createBackup cause backup
 * failure (createBackup returns null) and does not bubble up any errors.
 */
add_task(
  {
    // We override read-only on Windows -- see
    // test_createBackup_override_readonly below.
    skip_if: () => AppConstants.platform == "win",
  },
  async function test_createBackup_robustToFileSystemErrors() {
    let sandbox = sinon.createSandbox();
    Services.fog.testResetFOG();

    const TEST_UID = "ThisIsMyTestUID";
    const TEST_EMAIL = "foxy@mozilla.org";

    sandbox.stub(UIState, "get").returns({
      status: UIState.STATUS_SIGNED_IN,
      uid: TEST_UID,
      email: TEST_EMAIL,
    });

    // Create a read-only fake profile folder to which the backup service
    // won't be able to make writes
    let inaccessibleProfilePath = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "createBackupErrorReadonly"
    );
    await makeFolderReadonly(inaccessibleProfilePath, true);

    const bs = new BackupService({});

    await bs
      .createBackup({ profilePath: inaccessibleProfilePath })
      .then(result => {
        Assert.equal(result, null, "Should return null on error");

        // Validate total backup time metrics were recorded
        const totalBackupTime =
          Glean.browserBackup.totalBackupTime.testGetValue();
        Assert.equal(
          totalBackupTime,
          null,
          "Should not have measured total backup time for failed backup"
        );
      })
      .catch(() => {
        // Failure bubbles up an error for handling by the caller
      })
      .finally(async () => {
        await makeFolderReadonly(inaccessibleProfilePath, false);
        await IOUtils.remove(inaccessibleProfilePath, { recursive: true });
        sandbox.restore();
      });
  }
);

/**
 * Tests that BackupService.createBackup can override simple read-only status
 * when handling staging files.  That currently only works on Windows.
 */
add_task(
  {
    skip_if: () => AppConstants.platform !== "win",
  },
  async function test_createBackup_override_readonly() {
    let sandbox = sinon.createSandbox();

    const TEST_UID = "ThisIsMyTestUID";
    const TEST_EMAIL = "foxy@mozilla.org";

    sandbox.stub(UIState, "get").returns({
      status: UIState.STATUS_SIGNED_IN,
      uid: TEST_UID,
      email: TEST_EMAIL,
    });

    // Create a fake profile folder that contains a read-only file.  We do this
    // because Windows does not respect read-only status on folders. The
    // file's read-only status will make the folder un(re)movable.
    let inaccessibleProfilePath = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "createBackupErrorReadonly"
    );
    await makeFolderReadonly(inaccessibleProfilePath, true);
    await Assert.rejects(
      IOUtils.remove(inaccessibleProfilePath),
      /Could not remove/,
      "folder is not removable"
    );

    const bs = new BackupService({});

    await bs
      .createBackup({ profilePath: inaccessibleProfilePath })
      .then(result => {
        Assert.notEqual(result, null, "Should not return null on success");
      })
      .catch(e => {
        console.error(e);
        Assert.ok(false, "Should not have bubbled up an error");
      })
      .finally(async () => {
        await makeFolderReadonly(inaccessibleProfilePath, false);
        await IOUtils.remove(inaccessibleProfilePath, { recursive: true });
        await bs.deleteLastBackup();
        sandbox.restore();
      });
  }
);

/**
 * Creates a unique file in the given folder and tells a worker to keep it
 * open until we post a close message.  Checks that the folder is not
 * removable as a result.
 *
 * @param {string} folderpath
 * @returns {object} {{ path: string, worker: OpenFileWorker }}
 */
async function openUniqueFileInFolder(folderpath) {
  let testFile = await IOUtils.createUniqueFile(folderpath, "openfile");
  await IOUtils.writeUTF8(testFile, "");
  Assert.ok(
    await IOUtils.exists(testFile),
    testFile + " should have been created"
  );
  // Use a worker to keep the testFile open.
  const worker = new BasePromiseWorker(
    "resource://test/data/test_keep_file_open.worker.js"
  );
  await worker.post("open", [testFile]);

  await Assert.rejects(
    IOUtils.remove(folderpath, {
      recursive: true,
      retryReadonly: true,
    }),
    /NS_ERROR_FILE_DIR_NOT_EMPTY/,
    "attempt to remove folder threw an exception"
  );
  Assert.ok(await IOUtils.exists(folderpath), "folder is not removable");
  return { path: testFile, worker };
}

/**
 * Stop the worker returned from openUniqueFileInFolder and close the file.
 *
 * @param {object} worker The worker returned by openUniqueFileInFolder
 */
async function closeTestFile(worker) {
  await worker.post("close", []);
}

/**
 * Run a backup and check that it either succeeded with a response or failed
 * and returned null.
 *
 * @param {object}  backupService Instance of BackupService
 * @param {string}  profilePath   Full path to profile folder
 * @param {boolean} shouldSucceed Whether to expect success or failure
 */
async function checkBackup(backupService, profilePath, shouldSucceed) {
  if (shouldSucceed) {
    await backupService.createBackup({ profilePath }).then(result => {
      Assert.ok(true, "createBackup did not throw an exception");
      Assert.notEqual(
        result,
        null,
        `createBackup should not have returned null`
      );
    });
    await backupService.deleteLastBackup();
    return;
  }

  await Assert.rejects(
    backupService.createBackup({ profilePath }),
    /Failed to remove \d+? items/,
    "createBackup threw correct exception"
  );
}

/**
 * Checks that browser.backup.max-num-unremovable-staging-items allows backups
 * to succeed if the snapshots folder contains no more than that many
 * unremovable items, and that it fails if there are more than that.
 *
 * @param {number} unremovableItemsLimit Max number of unremovable items that
 *                                       backups can succeed with.
 */
async function checkBackupWithUnremovableItems(unremovableItemsLimit) {
  Services.prefs.setIntPref(
    "browser.backup.max-num-unremovable-staging-items",
    unremovableItemsLimit
  );
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(
      "browser.backup.max-num-unremovable-staging-items"
    )
  );

  let sandbox = sinon.createSandbox();

  const TEST_UID = "ThisIsMyTestUID";
  const TEST_EMAIL = "foxy@mozilla.org";

  sandbox.stub(UIState, "get").returns({
    status: UIState.STATUS_SIGNED_IN,
    uid: TEST_UID,
    email: TEST_EMAIL,
  });
  const backupService = new BackupService({});

  let profilePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "profileDir"
  );
  let snapshotsFolder = PathUtils.join(
    profilePath,
    BackupService.PROFILE_FOLDER_NAME,
    BackupService.SNAPSHOTS_FOLDER_NAME
  );

  let openFileWorkers = [];
  try {
    for (let i = 0; i < unremovableItemsLimit + 1; i++) {
      info(`Performing backup #${i}`);
      await checkBackup(backupService, profilePath, true /* shouldSucceed */);

      // Create and open a file so that the snapshots folder cannot be
      // emptied.
      openFileWorkers.push(await openUniqueFileInFolder(snapshotsFolder));
    }

    // We are now over the unremovableItemsLimit.
    info(`Performing backup that should fail`);
    await checkBackup(backupService, profilePath, false /* shouldSucceed */);
  } finally {
    await Promise.all(
      openFileWorkers.map(async ofw => await closeTestFile(ofw.worker))
    );
    await Promise.all(
      openFileWorkers.map(async ofw => await IOUtils.remove(ofw.path))
    );
    await IOUtils.remove(profilePath, { recursive: true });
    sandbox.restore();
  }
}

/**
 * Tests that any non-read-only file deletion errors do not prevent backups
 * until the browser.backup.max-num-unremovable-staging-items limit has been
 * reached.
 */
add_task(
  {
    // Windows will prevent folder deletion if the folder has an open file.
    // Other platforms do not do this.
    skip_if: () => AppConstants.platform !== "win",
  },
  async function test_createBackup_robustToNonReadonlyFileSystemErrorsAllowOneNonReadonly() {
    await checkBackupWithUnremovableItems(1);
  }
);

/**
 * Tests that browser.backup.max-num-unremovable-staging-items works for value
 * 0.
 */
add_task(
  {
    // Windows will prevent folder deletion if the folder has an open file.
    // Other platforms do not do this.
    skip_if: () => AppConstants.platform !== "win",
  },
  async function test_createBackup_robustToNonReadonlyFileSystemErrors() {
    await checkBackupWithUnremovableItems(0);
  }
);

/**
 * Tests that removable items in the staging folder are removed when a backup
 * is attempted.
 */
add_task(async function test_createBackup_deletesStaleStagingItems() {
  // Block backup if there is one stale item.
  Services.prefs.setIntPref(
    "browser.backup.max-num-unremovable-staging-items",
    1
  );
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref(
      "browser.backup.max-num-unremovable-staging-items"
    )
  );

  let sandbox = sinon.createSandbox();

  const TEST_UID = "ThisIsMyTestUID";
  const TEST_EMAIL = "foxy@mozilla.org";

  sandbox.stub(UIState, "get").returns({
    status: UIState.STATUS_SIGNED_IN,
    uid: TEST_UID,
    email: TEST_EMAIL,
  });
  const backupService = new BackupService({});

  let profilePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "profileDir"
  );
  let snapshotsFolder = PathUtils.join(
    profilePath,
    BackupService.PROFILE_FOLDER_NAME,
    BackupService.SNAPSHOTS_FOLDER_NAME
  );

  // Add one stale item, which would prevent backup if it could not be removed.
  let tempFilename = await IOUtils.createUniqueFile(
    snapshotsFolder,
    "deleteme"
  );
  try {
    info(`Performing backup`);
    await checkBackup(backupService, profilePath, true /* shouldSucceed */);
  } finally {
    Assert.ok(
      !(await IOUtils.exists(tempFilename)),
      "stale staging item was deleted during backup"
    );
    await IOUtils.remove(profilePath, { recursive: true });
    sandbox.restore();
  }
});

/**
 * Tests that failure to delete the prior backup doesn't prevent the backup
 * location from being edited.
 */
add_task(
  async function test_editBackupLocation_robustToDeleteLastBackupException() {
    const backupLocationPref = "browser.backup.location";
    const resetLocation = Services.prefs.getStringPref(backupLocationPref);

    const exceptionBackupLocation = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "exceptionBackupLocation"
    );
    Services.prefs.setStringPref(backupLocationPref, exceptionBackupLocation);

    const newBackupLocation = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "newBackupLocation"
    );

    const backupService = new BackupService({});

    const sandbox = sinon.createSandbox();
    sandbox
      .stub(backupService, "deleteLastBackup")
      .rejects(new Error("Exception while deleting backup"));

    await backupService.editBackupLocation(newBackupLocation);

    let expectedPath = PathUtils.join(newBackupLocation, "Restore Waterfox");
    Assert.equal(
      Services.prefs.getStringPref(backupLocationPref),
      expectedPath,
      "Backup location pref should have updated to the new directory."
    );

    Services.prefs.setStringPref(backupLocationPref, resetLocation);
    sinon.restore();
    await Promise.all([
      IOUtils.remove(exceptionBackupLocation, { recursive: true }),
      IOUtils.remove(newBackupLocation, { recursive: true }),
    ]);
  }
);

/**
 * Tests that if there's a post-recovery.json file in the profile directory
 * when checkForPostRecovery() is called, that it is processed, and the
 * postRecovery methods on the associated BackupResources are called with the
 * entry values from the file.
 */
add_task(async function test_checkForPostRecovery() {
  let sandbox = sinon.createSandbox();

  let testProfilePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "checkForPostRecoveryTest"
  );
  let fakePostRecoveryObject = {
    [FakeBackupResource1.key]: "test 1",
    [FakeBackupResource3.key]: "test 3",
  };
  await IOUtils.writeJSON(
    PathUtils.join(testProfilePath, BackupService.POST_RECOVERY_FILE_NAME),
    fakePostRecoveryObject
  );

  sandbox.stub(FakeBackupResource1.prototype, "postRecovery").resolves();
  sandbox.stub(FakeBackupResource2.prototype, "postRecovery").resolves();
  sandbox.stub(FakeBackupResource3.prototype, "postRecovery").resolves();

  let bs = new BackupService({
    FakeBackupResource1,
    FakeBackupResource2,
    FakeBackupResource3,
  });

  await bs.checkForPostRecovery(testProfilePath);
  await bs.postRecoveryComplete;

  Assert.ok(
    FakeBackupResource1.prototype.postRecovery.calledOnce,
    "FakeBackupResource1.postRecovery was called once"
  );
  Assert.ok(
    FakeBackupResource2.prototype.postRecovery.notCalled,
    "FakeBackupResource2.postRecovery was not called"
  );
  Assert.ok(
    FakeBackupResource3.prototype.postRecovery.calledOnce,
    "FakeBackupResource3.postRecovery was called once"
  );
  Assert.ok(
    FakeBackupResource1.prototype.postRecovery.calledWith(
      fakePostRecoveryObject[FakeBackupResource1.key]
    ),
    "FakeBackupResource1.postRecovery was called with the expected argument"
  );
  Assert.ok(
    FakeBackupResource3.prototype.postRecovery.calledWith(
      fakePostRecoveryObject[FakeBackupResource3.key]
    ),
    "FakeBackupResource3.postRecovery was called with the expected argument"
  );

  await IOUtils.remove(testProfilePath, { recursive: true });
  sandbox.restore();
});

/**
 * Tests that if one resource's postRecovery rejects, the remaining resources
 * still get their postRecovery called and the post-recovery.json file is
 * cleaned up.
 */
add_task(
  async function test_checkForPostRecovery_resilient_to_resource_failure() {
    let sandbox = sinon.createSandbox();

    let testProfilePath = await IOUtils.createUniqueDirectory(
      PathUtils.tempDir,
      "checkForPostRecoveryResilienceTest"
    );
    let fakePostRecoveryObject = {
      [FakeBackupResource1.key]: "test 1",
      [FakeBackupResource3.key]: "test 3",
    };
    await IOUtils.writeJSON(
      PathUtils.join(testProfilePath, BackupService.POST_RECOVERY_FILE_NAME),
      fakePostRecoveryObject
    );

    sandbox
      .stub(FakeBackupResource1.prototype, "postRecovery")
      .rejects(new Error("Simulated postRecovery failure"));
    sandbox.stub(FakeBackupResource2.prototype, "postRecovery").resolves();
    sandbox.stub(FakeBackupResource3.prototype, "postRecovery").resolves();

    let bs = new BackupService({
      FakeBackupResource1,
      FakeBackupResource2,
      FakeBackupResource3,
    });

    await bs.checkForPostRecovery(testProfilePath);
    await bs.postRecoveryComplete;

    Assert.ok(
      FakeBackupResource1.prototype.postRecovery.calledOnce,
      "FakeBackupResource1.postRecovery was called once (and rejected)"
    );
    Assert.ok(
      FakeBackupResource2.prototype.postRecovery.notCalled,
      "FakeBackupResource2.postRecovery was not called (no entry in post-recovery)"
    );
    Assert.ok(
      FakeBackupResource3.prototype.postRecovery.calledOnce,
      "FakeBackupResource3.postRecovery was still called despite FakeBackupResource1 failure"
    );

    let postRecoveryFilePath = PathUtils.join(
      testProfilePath,
      BackupService.POST_RECOVERY_FILE_NAME
    );
    Assert.ok(
      !(await IOUtils.exists(postRecoveryFilePath)),
      "post-recovery.json should be cleaned up even after a resource failure"
    );

    await IOUtils.remove(testProfilePath, { recursive: true });
    sandbox.restore();
  }
);

/**
 * Tests that loadBackupFileInfo updates backupFileInfo in the state with a subset
 * of info from the fake SampleArchiveResult returned by sampleArchive().
 */
add_task(async function test_loadBackupFileInfo() {
  let sandbox = sinon.createSandbox();

  let fakeSampleArchiveResult = {
    isEncrypted: IS_ENCRYPTED,
    startByteOffset: 26985,
    contentType: "multipart/mixed",
    archiveJSON: {
      version: 1,
      meta: {
        date: DATE,
        deviceName: DEVICE_NAME,
        appName: APP_NAME,
        appVersion: APP_VERSION,
        buildID: BUILD_ID,
        osName: OS_NAME,
        osVersion: OS_VERSION,
        osBuildNumber: OS_BUILD_NUMBER,
        healthTelemetryEnabled: TELEMETRY_ENABLED,
        legacyClientID: LEGACY_CLIENT_ID,
        profileName: PROFILE_NAME,
      },
      encConfig: {},
    },
  };

  sandbox
    .stub(BackupService.prototype, "sampleArchive")
    .resolves(fakeSampleArchiveResult);

  let bs = new BackupService();

  await bs.loadBackupFileInfo("fake-archive.html");

  Assert.ok(
    BackupService.prototype.sampleArchive.calledOnce,
    "sampleArchive was called once"
  );

  Assert.deepEqual(
    bs.state.backupFileInfo,
    {
      isEncrypted: IS_ENCRYPTED,
      date: DATE,
      deviceName: DEVICE_NAME,
      appName: APP_NAME,
      appVersion: APP_VERSION,
      buildID: BUILD_ID,
      osName: OS_NAME,
      osVersion: OS_VERSION,
      osBuildNumber: OS_BUILD_NUMBER,
      healthTelemetryEnabled: TELEMETRY_ENABLED,
      legacyClientID: LEGACY_CLIENT_ID,
      profileName: PROFILE_NAME,
    },
    "State should match a subset from the archive sample."
  );

  sandbox.restore();
});

/**
 * Tests that deleting the last backup will delete the last known backup file if
 * it exists, and will clear the last backup timestamp and filename state
 * properties and preferences.
 */
add_task(async function test_deleteLastBackup_file_exists() {
  await testDeleteLastBackupHelper();
});

/**
 * Tests that deleting the last backup does not reject if the last backup file
 * does not exist, and will still clear the last backup timestamp and filename
 * state properties and preferences.
 */
add_task(async function test__deleteLastBackup_file_does_not_exist() {
  // Now delete the file ourselves before we call deleteLastBackup,
  // so that it's missing from the disk.
  await testDeleteLastBackupHelper(async lastBackupFilePath => {
    await maybeRemovePath(lastBackupFilePath);
  });
});

/**
 * Tests that loadBackupFileInfo properly handles errors, and clears file info
 * for errors that indicate that the file is invalid.
 */
add_task(async function test_loadBackupFileInfo_error_handling() {
  let sandbox = sinon.createSandbox();

  const errorTypes = [
    ERRORS.FILE_SYSTEM_ERROR,
    ERRORS.CORRUPTED_ARCHIVE,
    ERRORS.UNSUPPORTED_BACKUP_VERSION,
    ERRORS.INTERNAL_ERROR,
    ERRORS.UNINITIALIZED,
    ERRORS.INVALID_PASSWORD,
  ];

  for (const testError of errorTypes) {
    let bs = new BackupService();

    let fakeSampleArchiveResult = {
      isEncrypted: IS_ENCRYPTED,
      startByteOffset: 26985,
      contentType: "multipart/mixed",
      archiveJSON: {
        version: 1,
        meta: {
          date: DATE,
          deviceName: DEVICE_NAME,
          appName: APP_NAME,
          appVersion: APP_VERSION,
          buildID: BUILD_ID,
          osName: OS_NAME,
          osVersion: OS_VERSION,
          osBuildNumber: OS_BUILD_NUMBER,
          healthTelemetryEnabled: TELEMETRY_ENABLED,
          legacyClientID: LEGACY_CLIENT_ID,
          profileName: PROFILE_NAME,
        },
        encConfig: {},
      },
    };

    sandbox
      .stub(BackupService.prototype, "sampleArchive")
      .resolves(fakeSampleArchiveResult);
    bs.setBackupFileToRestore("test-backup.html");
    await bs.loadBackupFileInfo("test-backup.html");

    // Verify initial state was set
    Assert.deepEqual(
      bs.state.backupFileInfo,
      {
        isEncrypted: IS_ENCRYPTED,
        date: DATE,
        deviceName: DEVICE_NAME,
        appName: APP_NAME,
        appVersion: APP_VERSION,
        buildID: BUILD_ID,
        osName: OS_NAME,
        osVersion: OS_VERSION,
        osBuildNumber: OS_BUILD_NUMBER,
        healthTelemetryEnabled: TELEMETRY_ENABLED,
        legacyClientID: LEGACY_CLIENT_ID,
        profileName: PROFILE_NAME,
      },
      "Initial state should be set correctly"
    );
    Assert.strictEqual(
      bs.state.backupFileToRestore,
      "test-backup.html",
      "backupFileToRestore should be set by setBackupFileToRestore"
    );

    // Test when sampleArchive throws an error
    sandbox.restore();
    sandbox
      .stub(BackupService.prototype, "sampleArchive")
      .rejects(new Error("Test error", { cause: testError }));
    const setRecoveryErrorStub = sandbox.stub(bs, "setRecoveryError");

    try {
      await bs.loadBackupFileInfo("test-backup.html");
    } catch (error) {
      Assert.ok(
        false,
        `Expected loadBackupFileInfo to throw for error ${testError}`
      );
    }

    Assert.ok(
      setRecoveryErrorStub.calledOnceWith(testError),
      `setRecoveryError should be called with ${testError}`
    );

    Assert.strictEqual(
      bs.state.backupFileInfo,
      null,
      `backupFileInfo should be cleared for error ${testError}`
    );
    Assert.strictEqual(
      bs.state.backupFileToRestore,
      "test-backup.html",
      `backupFileToRestore should be kept the same`
    );

    sandbox.restore();
  }
});

/**
 * Tests changing the status prefs to ensure that backup is cleaned up if being disabled.
 */
add_task(async function test_changing_prefs_cleanup() {
  let sandbox = sinon.createSandbox();
  Services.prefs.setBoolPref(BACKUP_ARCHIVE_ENABLED_PREF_NAME, true);
  let bs = new BackupService();
  bs.initStatusObservers();
  let cleanupStub = sandbox.stub(bs, "cleanupBackupFiles");
  let statusUpdatePromise = TestUtils.topicObserved(
    "backup-service-status-updated"
  );
  Services.prefs.setBoolPref(BACKUP_ARCHIVE_ENABLED_PREF_NAME, false);
  await statusUpdatePromise;

  Assert.equal(
    cleanupStub.callCount,
    1,
    "Cleanup backup files was called on pref change"
  );

  Services.prefs.setBoolPref(BACKUP_ARCHIVE_ENABLED_PREF_NAME, true);

  Assert.equal(
    cleanupStub.callCount,
    1,
    "Cleanup backup files should not have been called when enabling backups"
  );

  Services.prefs.clearUserPref(BACKUP_ARCHIVE_ENABLED_PREF_NAME);
});
