/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const FAKE_DATE = "2024-12-01T12:00:00+00:00";
const docsDirName = "Documents";
const oneDriveDirName = "OneDrive";
const backupDirName = "Restore Waterfox";
const backupFilename = "WaterfoxBackup_.html";

async function setupBackupDir(name) {
  const root = await IOUtils.createUniqueDirectory(PathUtils.tempDir, name);
  const dir = PathUtils.join(root, "Backups");
  await IOUtils.makeDirectory(dir, { createAncestors: true });
  return { root, dir };
}

async function touchBackupFile(dir, fileName) {
  const p = PathUtils.join(dir, fileName);
  await IOUtils.writeUTF8(p, "<!-- stub backup -->", { tmpPath: p + ".tmp" });
  return p;
}

add_task(
  async function test_findBackupsInWellKnownLocations_and_multipleFiles() {
    const { root: TEST_ROOT, dir: BACKUP_DIR } = await setupBackupDir(
      "test-findBackupsInWellKnownLocations"
    );

    Services.prefs.setStringPref("browser.backup.location", BACKUP_DIR);

    let bs = new BackupService();
    let sandbox = sinon.createSandbox();

    // loadBackupFileInfo should return without throwing to simulate
    // what happens when a valid backup file's validity is checked
    sandbox.stub(bs, "loadBackupFileInfo").callsFake(async _filePath => {});
    sandbox.stub(BackupService, "docsDirFolderPath").get(() => null);
    sandbox.stub(BackupService, "oneDriveFolderPath").get(() => null);

    Assert.ok(await IOUtils.exists(BACKUP_DIR), "Backup directory exists");
    Assert.equal(
      (await IOUtils.getChildren(BACKUP_DIR)).length,
      0,
      "Folder is empty"
    );

    // 1) Single valid file -> findBackupsInWellKnownLocations should find it
    const ONE = "WaterfoxBackup_one_20241201-120000.000.html";
    await touchBackupFile(BACKUP_DIR, ONE);

    let result = await bs.findBackupsInWellKnownLocations();
    Assert.ok(result.found, "Found should be true with one candidate");
    Assert.equal(
      result.multipleBackupsFound,
      false,
      "multipleBackupsFound should be false"
    );
    Assert.ok(
      result.backupFileToRestore && result.backupFileToRestore.endsWith(ONE),
      "backupFileToRestore should point at the single html file"
    );

    // 2) Add a second matching file -> well-known search should refuse to pick (validateFile=false)
    const TWO = "FirefoxBackup_two_20241202-130000.000.html";
    await touchBackupFile(BACKUP_DIR, TWO);

    let result2 = await bs.findBackupsInWellKnownLocations();
    Assert.ok(
      !result2.found,
      "Found should be false when multiple candidates exist and validateFile=false"
    );
    Assert.equal(
      result2.multipleBackupsFound,
      true,
      "Should signal multipleBackupsFound"
    );
    Assert.equal(
      result2.backupFileToRestore,
      null,
      "No file chosen if multiple & not allowed"
    );

    // 3) Call the lower-level API with multipleFiles=true (still no validation)
    let { multipleBackupsFound } = await bs.findIfABackupFileExists({
      validateFile: false,
      multipleFiles: true,
    });
    Assert.ok(!multipleBackupsFound, "Should not report multiple when allowed");

    // 4) With validateFile=true and multipleFiles=true, should select newest file,
    // but still report multipleBackupsFound=true
    let result3 = await bs.findBackupsInWellKnownLocations({
      validateFile: true,
      multipleFiles: true,
    });
    Assert.ok(
      result3.found,
      "Found should be true when validateFile=true and multiple files exist"
    );
    Assert.equal(
      result3.multipleBackupsFound,
      true,
      "Should signal multipleBackupsFound when validateFile=true and multipleFiles=true and multiple files exist"
    );
    Assert.ok(
      result3.backupFileToRestore && result3.backupFileToRestore.endsWith(TWO),
      "Should select the newest file when validateFile=true"
    );

    sandbox.restore();
    await IOUtils.remove(TEST_ROOT, { recursive: true });
  }
);

add_task(async function test_current_and_legacy_backup_branding() {
  const { root, dir } = await setupBackupDir("test-backup-branding");
  const locationPref = BackupService.BACKUP_DIR_PREF_NAME;
  const hadUserLocation = Services.prefs.prefHasUserValue(locationPref);
  const originalLocation = hadUserLocation
    ? Services.prefs.getStringPref(locationPref)
    : null;
  const sandbox = sinon.createSandbox();

  try {
    for (const parent of ["docsDirFolderPath", "oneDriveFolderPath"]) {
      sandbox
        .stub(BackupService, "docsDirFolderPath")
        .get(() => (parent == "docsDirFolderPath" ? { path: dir } : null));
      sandbox
        .stub(BackupService, "oneDriveFolderPath")
        .get(() => (parent == "oneDriveFolderPath" ? { path: dir } : null));

      for (const folder of ["Restore Waterfox", "Restore Firefox"]) {
        const backupDir = PathUtils.join(dir, folder);
        await IOUtils.makeDirectory(backupDir);
        await touchBackupFile(backupDir, "unrelated.html");

        for (const brand of ["Waterfox", "Firefox"]) {
          const file = await touchBackupFile(
            backupDir,
            `${brand}Backup_default_20241201-120000.000.html`
          );

          for (const configured of [false, true]) {
            if (configured) {
              Services.prefs.setStringPref(locationPref, backupDir);
            } else {
              Services.prefs.clearUserPref(locationPref);
            }

            const bs = new BackupService();
            const result = await bs.findIfABackupFileExists({
              validateFile: false,
            });
            Assert.equal(
              bs.state.backupFileToRestore,
              file,
              `Found ${brand} backup in ${parent}/${folder}`
            );
            Assert.equal(result.count, 1, "The backup is counted only once");
            Assert.ok(!result.multipleBackupsFound);
          }

          await IOUtils.remove(file);
        }

        await IOUtils.remove(backupDir, { recursive: true });
      }

      sandbox.restore();
    }
  } finally {
    sandbox.restore();
    if (hadUserLocation) {
      Services.prefs.setStringPref(locationPref, originalLocation);
    } else {
      Services.prefs.clearUserPref(locationPref);
    }
    await IOUtils.remove(root, { recursive: true });
  }
});

add_task(async function test_findBackupInDocsAfterSignInToOneDrive() {
  const testRoot = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    test_findBackupInDocsAfterSignInToOneDrive.name
  );

  const docsDir = PathUtils.join(testRoot, docsDirName);
  const backupDir = PathUtils.join(docsDir, backupDirName);
  await IOUtils.makeDirectory(backupDir, { createAncestors: true });
  await touchBackupFile(backupDir, backupFilename);

  const oneDriveDir = PathUtils.join(testRoot, oneDriveDirName);
  await IOUtils.makeDirectory(oneDriveDir, { createAncestors: true });

  let backupService = new BackupService();
  let sandbox = sinon.createSandbox();
  sandbox.stub(BackupService, "docsDirFolderPath").get(() => ({
    path: docsDir,
  }));
  sandbox.stub(BackupService, "oneDriveFolderPath").get(() => ({
    path: oneDriveDir,
  }));

  const result = await backupService.findBackupsInWellKnownLocations();
  Assert.ok(result.found, "Backup found in Documents");

  sandbox.restore();
  await IOUtils.remove(testRoot, { recursive: true });
});

add_task(async function test_findBackupInOneDriveDocsAfterSignInToOneDrive() {
  Services.prefs.clearUserPref("browser.backup.location");

  const testRoot = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    test_findBackupInOneDriveDocsAfterSignInToOneDrive.name
  );

  const docsDir = PathUtils.join(testRoot, docsDirName);
  await IOUtils.makeDirectory(docsDir, { createAncestors: true });

  const oneDriveDir = PathUtils.join(testRoot, oneDriveDirName);
  const oneDriveDocsDir = PathUtils.join(oneDriveDir, docsDirName);
  const backupDir = PathUtils.join(oneDriveDocsDir, backupDirName);
  await IOUtils.makeDirectory(backupDir, { createAncestors: true });
  await touchBackupFile(backupDir, backupFilename);

  let backupService = new BackupService();
  let sandbox = sinon.createSandbox();

  // If Documents backup is enabled in OneDrive, the default Documents
  // directory is OneDrive/Documents
  sandbox.stub(BackupService, "docsDirFolderPath").get(() => ({
    path: oneDriveDocsDir,
  }));
  sandbox.stub(BackupService, "oneDriveFolderPath").get(() => ({
    path: oneDriveDir,
  }));

  const result = await backupService.findBackupsInWellKnownLocations();
  Assert.ok(result.found, "Backup found in OneDrive/Documents");

  sandbox.restore();
  await IOUtils.remove(testRoot, { recursive: true });
});

add_task(async function test_backupDetectionComplete_telemetry() {
  // Use a single testResetFOG() call for all telemetry sub-tests, because
  // the backup_detection_complete event is sent in the custom
  // "profile-restore" ping and repeated testResetFOG() calls can lose
  // custom-ping event stores.
  Services.fog.testResetFOG();

  // --- Sub-test 1: no source => no event recorded ---
  {
    const { root, dir } = await setupBackupDir("test-detectionNoSource");
    Services.prefs.setStringPref("browser.backup.location", dir);

    let bs = new BackupService();
    let sandbox = sinon.createSandbox();
    sandbox.stub(bs, "loadBackupFileInfo").callsFake(async _filePath => {});
    sandbox.stub(BackupService, "docsDirFolderPath").get(() => null);
    sandbox.stub(BackupService, "oneDriveFolderPath").get(() => null);

    await touchBackupFile(dir, "FirefoxBackup_test_20241201-1200.html");
    await bs.findBackupsInWellKnownLocations();

    let events = Glean.browserBackup.backupDetectionComplete.testGetValue();
    Assert.equal(events, undefined, "No event recorded without source.");

    sandbox.restore();
    await IOUtils.remove(root, { recursive: true });
  }

  // --- Sub-test 2: source provided, backup found => event with full data ---
  {
    const { root, dir } = await setupBackupDir("test-detectionTelemetry");
    Services.prefs.setStringPref("browser.backup.location", dir);

    let bs = new BackupService();
    let sandbox = sinon.createSandbox();

    sandbox.stub(bs, "sampleArchive").resolves({
      archiveJSON: { meta: { date: FAKE_DATE } },
      isEncrypted: false,
    });
    sandbox.stub(bs, "classifyLocationForTelemetry").returns("documents");
    sandbox.stub(BackupService, "docsDirFolderPath").get(() => null);
    sandbox.stub(BackupService, "oneDriveFolderPath").get(() => null);

    const FILE = "FirefoxBackup_test_20241201-1200.html";
    await touchBackupFile(dir, FILE);

    await bs.findBackupsInWellKnownLocations({
      validateFile: true,
      source: "onboarding",
    });

    let events = Glean.browserBackup.backupDetectionComplete.testGetValue();
    Assert.equal(events.length, 1, "One detection event was recorded.");

    let extra = events[0].extra;
    Assert.equal(extra.count, "1", "Count is 1.");
    Assert.equal(extra.source, "onboarding", "Source is onboarding.");
    Assert.equal(extra.location, "documents", "Location matches.");
    Assert.ok(extra.restore_id, "Restore ID is present.");
    Assert.equal(
      extra.backup_timestamp,
      String(new Date(FAKE_DATE).getTime()),
      "Backup timestamp matches the date from backupFileInfo."
    );

    sandbox.restore();
    await IOUtils.remove(root, { recursive: true });
  }

  // --- Sub-test 3: source provided, no backups => event with zeroed data ---
  {
    const { root, dir } = await setupBackupDir("test-detectionEmpty");
    Services.prefs.setStringPref("browser.backup.location", dir);

    let bs = new BackupService();
    let sandbox = sinon.createSandbox();
    sandbox.stub(BackupService, "docsDirFolderPath").get(() => null);
    sandbox.stub(BackupService, "oneDriveFolderPath").get(() => null);

    await bs.findBackupsInWellKnownLocations({
      validateFile: true,
      source: "preferences",
    });

    // Event from sub-test 2 is still present (index 0); this is index 1.
    let events = Glean.browserBackup.backupDetectionComplete.testGetValue();
    Assert.equal(events.length, 2, "Two detection events total.");

    let extra = events[1].extra;
    Assert.equal(extra.count, "0", "Count is 0 when no backups exist.");
    Assert.equal(extra.source, "preferences", "Source is preferences.");
    Assert.equal(
      extra.backup_timestamp,
      "0",
      "Backup timestamp is 0 when nothing found."
    );
    Assert.equal(
      extra.location,
      "none",
      "Location is none when nothing found."
    );
    Assert.equal(
      extra.restore_id,
      "",
      "Restore ID is empty when nothing found."
    );

    sandbox.restore();
    await IOUtils.remove(root, { recursive: true });
  }
});
