/* Any copyright is dedicated to the Public Domain.
https://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

let gTestSourcePath;
let gTestDestPath;
let gMatchingRegex;

add_setup(async () => {
  gMatchingRegex = new RegExp(
    `^${BackupService.BACKUP_FILE_NAME}_[a-z0-9-]+(_[a-zA-Z0-9-]+)?_[0-9.-]+.html$`
  );
  gTestSourcePath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "testFinalizeSingleFileArchiveSource"
  );
  gTestDestPath = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    "testFinalizeSingleFileArchiveDest"
  );

  registerCleanupFunction(async () => {
    await IOUtils.remove(gTestSourcePath, { recursive: true });
    await IOUtils.remove(gTestDestPath, { recursive: true });
  });
});

/**
 * Utility function that writes a pretend archive file into gTestSourcePath,
 * and then calls finalizeSingleFileArchive for it, passing
 * gTestDestPath as the destination, and some metadata for encoding in the
 * filename.
 *
 * Once the async testFn function resolves, the gTestSourcePath and
 * gTestDestPath are cleared.
 *
 * @param {object} metadata
 *   The metadata to encode in the filename. See the BackupService schema for
 *   details.
 * @param {Function} testFn
 *   An async testing function to run after calling finalizeSingleFileArchive.
 */
async function testFinalizeSingleFileArchive(metadata, testFn) {
  let bs = new BackupService();
  const TEST_FILE_PATH = PathUtils.join(gTestSourcePath, "test.txt");
  await IOUtils.writeUTF8(TEST_FILE_PATH, "test");
  let movedFilePath = await bs.finalizeSingleFileArchive(
    TEST_FILE_PATH,
    gTestDestPath,
    metadata
  );
  let movedFile = PathUtils.filename(movedFilePath);
  try {
    await testFn(movedFile);
  } finally {
    // Clear out any files in the source and destination paths between tests.
    let filePathsToClear = [
      ...(await IOUtils.getChildren(gTestSourcePath)),
      ...(await IOUtils.getChildren(gTestDestPath)),
    ];
    for (let filePath of filePathsToClear) {
      await IOUtils.remove(filePath);
    }
  }
}

/**
 * Tests that a single file archive will get the expected filename when moved
 * to the destination directory.
 */
add_task(async function test_filename() {
  await testFinalizeSingleFileArchive(FAKE_METADATA, async movedFile => {
    Assert.ok(movedFile.match(gMatchingRegex));
  });
});

/**
 * Tests that a single file archive will remove older backup files in the
 * same directory.
 */
add_task(async function test_remove_old_files() {
  const OLDER_BACKUP = PathUtils.join(
    gTestDestPath,
    `${BackupService.BACKUP_FILE_NAME}_${FAKE_METADATA.profileName}_20200101-000000.000.html`
  );
  await IOUtils.writeUTF8(OLDER_BACKUP, "test");

  await testFinalizeSingleFileArchive(FAKE_METADATA, async movedFile => {
    Assert.ok(movedFile.match(gMatchingRegex));
    Assert.ok(
      !(await IOUtils.exists(OLDER_BACKUP)),
      "Older backup was deleted."
    );
  });
});

/**
 * Tests that a single file archive will not remove older backup files for
 * other profiles.
 */
add_task(async function test_remove_old_files_other_profile() {
  const OLDER_BACKUP = PathUtils.join(
    gTestDestPath,
    `${BackupService.BACKUP_FILE_NAME}_SomeOtherProfile_20200101-000000.000.html`
  );
  await IOUtils.writeUTF8(OLDER_BACKUP, "test");

  await testFinalizeSingleFileArchive(FAKE_METADATA, async movedFile => {
    Assert.ok(movedFile.match(gMatchingRegex));
    Assert.ok(
      await IOUtils.exists(OLDER_BACKUP),
      "Older backup from another profile was not deleted."
    );
  });
});

/**
 * Tests that the storeID is included in the filename when present.
 */
add_task(async function test_filename_with_storeID() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(SelectableProfileService, "storeID").get(() => "abc123-store");
  try {
    await testFinalizeSingleFileArchive(FAKE_METADATA, async movedFile => {
      Assert.ok(movedFile.match(gMatchingRegex));
      Assert.ok(
        movedFile.includes("abc123-store"),
        "Filename should contain the storeID."
      );
    });
  } finally {
    sandbox.restore();
  }
});

/**
 * Tests that profiles with the same name but different storeIDs don't remove
 * each other's backups.
 */
add_task(async function test_same_profile_name_different_storeID() {
  let sandbox = sinon.createSandbox();
  sandbox.stub(SelectableProfileService, "storeID").get(() => "store-AAA");

  const OTHER_STORE_BACKUP = PathUtils.join(
    gTestDestPath,
    `${BackupService.BACKUP_FILE_NAME}_${FAKE_METADATA.profileName}_store-BBB_20200101-000000.000.html`
  );
  await IOUtils.writeUTF8(OTHER_STORE_BACKUP, "test");

  try {
    await testFinalizeSingleFileArchive(FAKE_METADATA, async movedFile => {
      Assert.ok(movedFile.match(gMatchingRegex));
      Assert.ok(
        movedFile.includes("store-AAA"),
        "Filename should contain the storeID store-AAA."
      );
      Assert.ok(
        await IOUtils.exists(OTHER_STORE_BACKUP),
        "Backup from the same profile name but different storeID was not deleted."
      );
    });
  } finally {
    sandbox.restore();
  }
});
