/* Any copyright is dedicated to the Public Domain.
 * https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineLazyGetter(this, "nsLocalFile", () =>
  Components.Constructor("@mozilla.org/file/local;1", "nsIFile", "initWithPath")
);

const BACKUP_DIR_PREF_NAME = "browser.backup.location";

const TEST_PASSWORD = "correcthorsebatterystaple";

const kKnownMappings = Object.freeze({
  OneDrPD: "onedrive",
  Docs: "documents",
});

const gDirectoryServiceProvider = {
  getFile(prop, persistent) {
    persistent.value = false;

    // We only expect a narrow range of calls.
    let folder = gBase.clone();
    if (prop === "ProfD") {
      return folder;
    }

    if (prop in kKnownMappings) {
      folder.append("dirsvc");
      folder.append(prop + "-dir");
      return folder;
    }

    console.error(`Access to unexpected directory '${prop}'`);
    return Cr.NS_ERROR_FAILURE;
  },
  QueryInterface: ChromeUtils.generateQI([Ci.nsIDirectoryServiceProvider]),
};

let gBase;
add_setup(function setup() {
  setupProfile();
  gBase = do_get_profile();

  Services.dirsvc
    .QueryInterface(Ci.nsIDirectoryService)
    .registerProvider(gDirectoryServiceProvider);
});

/**
 * Gets a telemetry event and returns its extra data.
 *
 * @param {string} name
 *   The Glean programming name of the event, e.g. turnOn instead of turn_on.
 * @returns {object}
 *   The extra data associated with the event.
 */
function assertSingleTelemetryEvent(name) {
  let value = Glean.browserBackup[name].testGetValue();
  Assert.equal(value.length, 1, `${name} Glean event was recorded once.`);
  return value[0].extra;
}

/**
 * Checks that the recorded event's 'encrypted' and 'location' extra keys
 * match `destPath` and `encrypted`. Reset telemetry before if needed!
 *
 * @param {string} name
 *   The name of the Glean event that should have been recorded.
 * @param {string} destPath
 *   The path that the backup was stored to.
 * @param {boolean} encrypted
 *   Whether the backup was encrypted or not.
 */
function assertEventMatches(name, destPath, encrypted) {
  let extra = assertSingleTelemetryEvent(name);
  Assert.equal(
    extra.encrypted,
    String(encrypted),
    `Glean event indicates the backup is ${encrypted ? "" : "NOT "}encrypted.`
  );

  // This is returned from the mock of classifyLocationForTelemetry, and
  // checks that the correct path was passed in.
  Assert.equal(
    extra.location,
    `[classifying: ${relativeToProfile(destPath)}]`,
    "Glean event has right location"
  );

  return extra;
}

/**
 * Determines the path to 'source' from the profile directory.
 *
 * @param {string} path
 *   The file that should be pointed to.
 * @returns {string}
 *   The relative path from 'base' to 'source'.
 */
function relativeToProfile(path) {
  let file = nsLocalFile(path);
  return file.getRelativePath(gBase);
}

add_task(function test_relativeToProfile() {
  // This aims to check that the direction is right.
  const file = gBase.clone();
  file.append("abc");
  Assert.equal(
    relativeToProfile(file.path),
    "abc",
    "relativeToProfile computes the right path."
  );
});

add_task(async function test_created_encrypted_noreason() {
  await template("testCreatedEncryptedNoReason", true, undefined);
});

add_task(async function test_created_nonencrypted_noreason() {
  await template("testCreatedNonencryptedNoReason", false, undefined);
});

add_task(async function test_created_encrypted_with_reason() {
  await template("testCreatedEncryptedWithReason", true, "I said so");
});

async function template(name, encrypted, reason) {
  let bs = new BackupService();
  let profilePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    name
  );

  const backupDir = PathUtils.join(PathUtils.tempDir, name + "_dest");
  Services.prefs.setStringPref(BACKUP_DIR_PREF_NAME, backupDir);

  if (encrypted) {
    await bs.enableEncryption(TEST_PASSWORD, profilePath);
  }

  sinon.stub(bs, "classifyLocationForTelemetry").callsFake(file => {
    return `[classifying: ${relativeToProfile(file)}]`;
  });

  // To ensure that the backup_start event happens before the actual backup,
  // take the lock for ourselves. Then we can unblock the backup once we've
  // checked the telemetry is finished.
  let resolver = Promise.withResolvers();
  locks.request(BackupService.WRITE_BACKUP_LOCK_NAME, () => {
    Services.fog.testResetFOG();

    let promise = bs.createBackup({ profilePath, reason });

    let startedEvents = Glean.browserBackup.backupStart.testGetValue();
    Assert.equal(
      startedEvents.length,
      1,
      "Found the backup_start Glean event."
    );
    Assert.equal(
      startedEvents[0].extra.reason,
      reason ?? "unknown",
      "Found the reason for starting the backup in the Glean event."
    );

    // Don't await on it, since createBackup needs the lock!
    resolver.resolve(promise);
  });

  await resolver.promise;

  let value = assertEventMatches("created", backupDir, encrypted);
  // Not sure how big it is, and we're not testing the fuzzByteSize
  // function, so just check that it's plausible.
  Assert.greater(Number(value.size), 0, "Telemetry event has nonzero size");
}

add_task(async function test_toggleOn() {
  let bs = new BackupService();

  let backupDir = PathUtils.join(PathUtils.tempDir, "toggleOn_dest");
  Services.prefs.setStringPref(BACKUP_DIR_PREF_NAME, backupDir);

  let profilePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "toggleOn"
  );

  if (bs.state.scheduledBackupsEnabled) {
    // The test assumes that this is false. Do this before resetting telemetry
    // so it doesn't affect the results.
    bs.onUpdateScheduledBackups(false);
  }

  sinon.stub(bs, "classifyLocationForTelemetry").callsFake(file => {
    return `[classifying: ${relativeToProfile(file)}]`;
  });

  Services.fog.testResetFOG();
  bs.onUpdateScheduledBackups(true);
  assertEventMatches("toggleOn", backupDir, false);

  Services.fog.testResetFOG();
  bs.onUpdateScheduledBackups(false);
  assertSingleTelemetryEvent("toggleOff");

  await bs.enableEncryption(TEST_PASSWORD, profilePath);
  Services.fog.testResetFOG();
  bs.onUpdateScheduledBackups(true);
  assertEventMatches("toggleOn", backupDir, true);

  Services.fog.testResetFOG();
  bs.onUpdateScheduledBackups(false);
  assertSingleTelemetryEvent("toggleOff");
});

add_task(async function test_schedulerToggleSource() {
  // setScheduledBackups() flips the pref, which fires a pref observer that
  // calls BackupService.get().onUpdateScheduledBackups(...). We need to drive
  // the singleton (not a fresh `new BackupService()`) so the stashed source
  // and the observer-invoked metric write live on the same instance.
  let bs = BackupService.init();
  registerCleanupFunction(() => BackupService.uninit());

  let backupDir = PathUtils.join(PathUtils.tempDir, "schedulerSource_dest");
  Services.prefs.setStringPref(BACKUP_DIR_PREF_NAME, backupDir);

  // Make sure scheduled backups are off before each sub-case.
  if (bs.state.scheduledBackupsEnabled) {
    bs.onUpdateScheduledBackups(false);
  }
  Services.prefs.clearUserPref("browser.backup.scheduled.enabled");

  sinon.stub(bs, "classifyLocationForTelemetry").callsFake(() => "documents");

  // setScheduledBackups(true, source) should propagate the source string to
  // the scheduler_toggle_source metric via onUpdateScheduledBackups.
  Services.fog.testResetFOG();
  bs.setScheduledBackups(true, "ENABLE_MESSAGE_ID");
  Assert.equal(
    Glean.browserBackup.schedulerToggleSource.testGetValue(),
    "ENABLE_MESSAGE_ID",
    "Source argument propagated to scheduler_toggle_source on enable."
  );

  // setScheduledBackups(false, source) should propagate the source string on
  // disable as well.
  Services.fog.testResetFOG();
  bs.setScheduledBackups(false, "DISABLE_MESSAGE_ID");
  Assert.equal(
    Glean.browserBackup.schedulerToggleSource.testGetValue(),
    "DISABLE_MESSAGE_ID",
    "Source argument propagated to scheduler_toggle_source on disable."
  );

  // Default is "unknown" if no source is passed (enable).
  Services.fog.testResetFOG();
  bs.setScheduledBackups(true);
  Assert.equal(
    Glean.browserBackup.schedulerToggleSource.testGetValue(),
    "unknown",
    "scheduler_toggle_source defaults to 'unknown' when no source given on enable."
  );

  // Default is "unknown" if no source is passed (disable).
  Services.fog.testResetFOG();
  bs.setScheduledBackups(false);
  Assert.equal(
    Glean.browserBackup.schedulerToggleSource.testGetValue(),
    "unknown",
    "scheduler_toggle_source defaults to 'unknown' when no source given on disable."
  );

  // Empty string should fall back to "unknown".
  Services.fog.testResetFOG();
  bs.setScheduledBackups(true, "");
  Assert.equal(
    Glean.browserBackup.schedulerToggleSource.testGetValue(),
    "unknown",
    "Empty source falls back to 'unknown'."
  );

  // After a stashed source is consumed by onUpdateScheduledBackups, a
  // subsequent direct pref flip should not inherit the previous credit.
  Services.fog.testResetFOG();
  bs.setScheduledBackups(false);
  Services.fog.testResetFOG();
  bs.setScheduledBackups(true, "FIRST_MESSAGE");
  Assert.equal(
    Glean.browserBackup.schedulerToggleSource.testGetValue(),
    "FIRST_MESSAGE",
    "First enable was credited to FIRST_MESSAGE."
  );
  // Now flip the pref off and on directly without going through
  // setScheduledBackups, simulating a stale source on a second enable.
  Services.fog.testResetFOG();
  bs.onUpdateScheduledBackups(false);
  Services.fog.testResetFOG();
  bs.onUpdateScheduledBackups(true);
  Assert.equal(
    Glean.browserBackup.schedulerToggleSource.testGetValue(),
    "unknown",
    "Stashed source is consumed once; subsequent toggles default to 'unknown'."
  );

  // Clean up.
  bs.setScheduledBackups(false);
  Services.prefs.clearUserPref("browser.backup.scheduled.enabled");
});

add_task(async function test_classifyLocationForTelemetry() {
  // classifyLocationForTelemetry takes the grandparent of the given path
  // (file -> backup subfolder -> known location), so we need
  // paths that are two levels deep under the known directory to match.
  let bs = new BackupService();
  for (const prop of Object.keys(kKnownMappings)) {
    let file = Services.dirsvc.get(prop, Ci.nsIFile);

    // The known dir itself (0 levels deep) should not match.
    Assert.equal(
      bs.classifyLocationForTelemetry(file.path),
      "other",
      `'${file.path}' (known dir itself) was correctly classified as other.`
    );

    // One level deep (e.g. Documents/child) should not match either,
    // since grandparent would be above the known dir.
    file.append("child");
    Assert.equal(
      bs.classifyLocationForTelemetry(file.path),
      "other",
      `'${file.path}' (one level deep) was correctly classified as other.`
    );

    // Two levels deep (e.g. Documents/Restore Waterfox/backup.html) should
    // match, since the grandparent is the known dir.
    file.append("grandchild");
    Assert.equal(
      bs.classifyLocationForTelemetry(file.path),
      kKnownMappings[prop],
      `'${file.path}' (two levels deep) was correctly classified.`
    );
  }

  Assert.equal(
    bs.classifyLocationForTelemetry(gBase.path),
    "other",
    "Unrelated path is not classified anywhere."
  );

  Assert.equal(
    bs.classifyLocationForTelemetry("path"),
    "Error: NS_ERROR_FILE_UNRECOGNIZED_PATH",
    "Invalid path returns an error name."
  );
});

add_task(async function test_idleDispatchPassesOptionsThrough() {
  let bs = new BackupService();
  let stub = sinon.stub(bs, "createBackupOnIdleDispatch").resolves();

  let options = {};
  bs.createBackupOnIdleDispatch(options);
  Assert.equal(
    stub.firstCall.args[0],
    options,
    "Options were passed as-is into createBackup."
  );
});
