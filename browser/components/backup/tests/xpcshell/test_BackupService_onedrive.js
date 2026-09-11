/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at https://mozilla.org/MPL/2.0/. */
"use strict";

// This is mostly taken from test_windows_onedrive_registry.js.
// Each "test suite" is a set of tests run on a specific registry
// configuration.
// NB: Backup only needs the location of the personal OneDrive folder.  It
// does an existence check, so that folder must exist.  We use PathUtils.tempDir
// for that.
const tempDirPath = PathUtils.tempDir;

const customerId = "12345";

const testSuites = [
  {
    registryMap: {
      "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal\\UserFolder":
        tempDirPath,
      "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal\\cid":
        customerId,
    },
    personalFolder: tempDirPath,
    businessFolders: [],
  },
  {
    registryMap: {
      "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business1\\UserFolder":
        "Q:\\Me\\OneDrive - MyOrg",
    },
    personalFolder: null,
    businessFolders: ["Q:\\Me\\OneDrive - MyOrg"],
  },
  {
    registryMap: {
      "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal\\UserFolder":
        tempDirPath,
      "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal\\cid":
        customerId,
      "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business5\\UserFolder":
        "Q:\\Me\\OneDrive - Org1",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business6\\UserFolder":
        "Q:\\Me\\OneDrive - Org2",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Business10\\UserFolder":
        "Q:\\Me\\OneDrive - Org2(2)",
    },
    personalFolder: tempDirPath,
    businessFolders: [
      "Q:\\Me\\OneDrive - Org1",
      "Q:\\Me\\OneDrive - Org2",
      "Q:\\Me\\OneDrive - Org2(2)",
    ],
  },
];

// value of registryMap from currently-running test suite
let currentRegistryContents;
// The registry won't be opened for more than one key at a time.
let currentRegistryPath;
// Un-mock the registry.  We need to do this before test end (i.e.
// registerCleanupFunction) because cleanup involves the registry.
let do_cleanup;

let mockRegistry = {
  open: (root, path, mode) => {
    Assert.equal(
      root,
      Ci.nsIWindowsRegKey.ROOT_KEY_CURRENT_USER,
      "reg key is in HKEY_CURRENT_USER"
    );
    let isPersonal = path.match(
      /Software\\Microsoft\\OneDrive\\Accounts\\Personal/
    );
    let isBusiness = path.match(
      /Software\\Microsoft\\OneDrive\\Accounts\\Business(\d+)/
    );
    Assert.ok(isPersonal || isBusiness, "opening correct root path");
    Assert.equal(mode, Ci.nsIWindowsRegKey.ACCESS_READ, "mode was ACCESS_READ");
    currentRegistryPath = "HKEY_CURRENT_USER\\" + path;
  },
  hasValue: value => {
    const allowedKeys = new Set(["UserFolder", "cid"]);
    Assert.ok(allowedKeys.has(value), `value is ${value}`);
    return currentRegistryPath + "\\" + value in currentRegistryContents;
  },
  readStringValue: value => {
    if (!(currentRegistryPath + "\\" + value in currentRegistryContents)) {
      // This should never happen.
      Assert.ok(
        false,
        `${currentRegistryPath + "\\" + value} not found in registry`
      );
      throw new Error("read nonexistent value");
    }
    return currentRegistryContents[currentRegistryPath + "\\" + value];
  },

  setRegistryContents: newRegistryMap => {
    info(`setting new registry map: ${JSON.stringify(newRegistryMap)}`);
    currentRegistryContents = newRegistryMap;
  },

  QueryInterface: ChromeUtils.generateQI(["nsIWindowsRegKey"]),
};

function setupMockRegistryComponent() {
  const { MockRegistrar } = ChromeUtils.importESModule(
    "resource://testing-common/MockRegistrar.sys.mjs"
  );
  let cid = MockRegistrar.registerEx(
    "@mozilla.org/windows-registry-key;1",
    { shouldCreateInstance: false },
    mockRegistry
  );
  do_cleanup = () => {
    MockRegistrar.unregister(cid);
  };
}

add_task(async function runTests() {
  setupMockRegistryComponent();

  const docsFolder = Services.dirsvc.get("Docs", Ci.nsIFile).path;
  for (let test of testSuites) {
    mockRegistry.setRegistryContents(test.registryMap);
    let personalFolder = BackupService.oneDriveFolderPath;
    Assert.equal(
      personalFolder?.path || null,
      test.personalFolder,
      "got correct personal OneDrive root"
    );

    Assert.equal(
      BackupService.DEFAULT_PARENT_DIR_PATH,
      test.personalFolder ? test.personalFolder : docsFolder,
      "BackupService.DEFAULT_PARENT_DIR_PATH reflects correct folder"
    );
  }

  do_cleanup();
});

add_task(async function test_oneDriveDirNotReturnedIfUserNotLoggedIn() {
  setupMockRegistryComponent();

  mockRegistry.setRegistryContents({
    "HKEY_CURRENT_USER\\Software\\Microsoft\\OneDrive\\Accounts\\Personal\\UserFolder":
      tempDirPath,
  });

  Assert.equal(
    BackupService.oneDriveFolderPath,
    null,
    "OneDrive directory not returned"
  );

  const docsFolder = Services.dirsvc.get("Docs", Ci.nsIFile).path;
  Assert.equal(
    BackupService.DEFAULT_PARENT_DIR_PATH,
    docsFolder,
    "DEFAULT_PARENT_DIR_PATH falls back to Documents directory"
  );

  do_cleanup();
});

const docsDirName = "Documents";
const oneDriveDirName = "OneDrive";
const backupDirName = "Restore Waterfox";
const backupFilename = "WaterfoxBackup_.html";

add_task(async function test_findBackupInDocsAfterSignInToOneDrive() {
  const testRoot = await IOUtils.createUniqueDirectory(
    PathUtils.tempDir,
    test_findBackupInDocsAfterSignInToOneDrive.name
  );

  const docsDir = PathUtils.join(testRoot, docsDirName);
  const backupDir = PathUtils.join(docsDir, backupDirName);
  await IOUtils.makeDirectory(backupDir, { createAncestors: true });
  await createStubBackupFile(backupDir, backupFilename);

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
  await createStubBackupFile(backupDir, backupFilename);

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
