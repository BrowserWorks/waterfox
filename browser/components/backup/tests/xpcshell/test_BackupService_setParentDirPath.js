/* Any copyright is dedicated to the Public Domain.
https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  BackupError: "resource:///modules/backup/BackupError.mjs",
});

add_task(async function test_empty() {
  let bs = new BackupService();
  await Assert.rejects(
    bs.setParentDirPath(""),
    BackupError,
    "empty string is rejected"
  );
});

add_task(async function test_typical() {
  let bs = new BackupService();
  let name = "setParentDirPath_typical";
  let path = PathUtils.join(do_get_profile().path, name);
  await bs.setParentDirPath(path);
  Assert.equal(
    Services.prefs.getStringPref("browser.backup.location"),
    PathUtils.join(path, "Restore Waterfox"),
    "Path with 'Restore Waterfox' appended is used"
  );
});

add_task(async function test_already_decorated() {
  let bs = new BackupService();
  let name = "setParentDirPath_already_decorated";
  let path = PathUtils.join(do_get_profile().path, name, "Restore Waterfox");
  await bs.setParentDirPath(path);
  Assert.equal(
    Services.prefs.getStringPref("browser.backup.location"),
    path,
    "No duplicate 'Restore Waterfox' is appended"
  );
});

add_task(async function test_legacy_folder() {
  const locationPref = BackupService.BACKUP_DIR_PREF_NAME;
  const hadUserLocation = Services.prefs.prefHasUserValue(locationPref);
  const originalLocation = hadUserLocation
    ? Services.prefs.getStringPref(locationPref)
    : null;
  let bs = new BackupService();
  let path = PathUtils.join(
    do_get_profile().path,
    "setParentDirPath_legacy",
    "Restore Firefox"
  );
  try {
    await bs.setParentDirPath(path);
    Assert.equal(
      Services.prefs.getStringPref(locationPref),
      path,
      "The legacy backup folder is used without appending a new subfolder"
    );
  } finally {
    if (hadUserLocation) {
      Services.prefs.setStringPref(locationPref, originalLocation);
    } else {
      Services.prefs.clearUserPref(locationPref);
    }
  }
});
