/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

const { BitsError } = ChromeUtils.importESModule(
  "resource://gre/modules/Bits.sys.mjs"
);

// There are multiple reasons that we might cleanup a downloading update on
// startup and a way to run this test corresponding to each of them, which this
// enumerates.
const cleanupReasons = {
  wrongChannel: "wrongChannel",
  versionTooOld: "versionTooOld",
  buildIdTooOld: "buildIdTooOld",
  incorrectStatus: "incorrectStatus",
};

async function testCleanup({
  cleanupReason,
  updateHasBitsId,
  bitsTaskStillExists,
}) {
  let bitsId;
  if (updateHasBitsId || bitsTaskStillExists) {
    const request = await startBitsMarDownload(gURLData + gHTTPHandlerPath);
    bitsId = request.bitsId;

    if (!bitsTaskStillExists) {
      await request.cancelAsync();
    }
    // Disconnect from the BITS job.
    request.shutdown();
  }

  let patchProps = { state: STATE_DOWNLOADING };
  if (updateHasBitsId) {
    patchProps.bitsId = bitsId;
  }

  let patches = getLocalPatchString(patchProps);

  let updateProps = {};
  if (cleanupReason == cleanupReasons.wrongChannel) {
    setUpdateChannel("original_channel");
    updateProps.channel = "wrong_channel";
  } else if (cleanupReason == cleanupReasons.versionTooOld) {
    updateProps.appVersion = "0.9";
  } else if (cleanupReason == cleanupReasons.buildIdTooOld) {
    updateProps.appVersion = Services.appinfo.version;
    updateProps.buildID = Services.appinfo.appBuildID;
  }

  let updates = getLocalUpdateString(updateProps, patches);
  writeUpdatesToXMLFile(getLocalUpdatesXMLString(updates), true);
  writeUpdatesToXMLFile(getLocalUpdatesXMLString(""), false);

  if (cleanupReason == cleanupReasons.incorrectStatus) {
    writeStatusFile(STATE_NONE);
  } else {
    writeStatusFile(STATE_DOWNLOADING);
  }

  // Load the XML into the update manager
  await reloadUpdateManagerData();

  Assert.ok(
    await gUpdateManager.getDownloadingUpdate(),
    "Should have loaded the downloading update"
  );
  Assert.ok(
    !(await gUpdateManager.getReadyUpdate()),
    "Should not have loaded a ready update"
  );
  let history = await gUpdateManager.getHistory();
  Assert.equal(history.length, 0, "The update history should start empty");

  // This should trigger the cleanup we want to observe.
  await reInitUpdateService();

  Assert.equal(
    gAUS.currentState,
    Ci.nsIApplicationUpdateService.STATE_IDLE,
    "Cleaning up active updates leaves the update service idle"
  );
  Assert.ok(
    !(await gUpdateManager.getDownloadingUpdate()),
    "Should have removed the downloading update"
  );
  Assert.ok(
    !(await gUpdateManager.getReadyUpdate()),
    "there should not be a ready update"
  );
  history = await gUpdateManager.getHistory();
  Assert.equal(
    history.length,
    1,
    "the update manager update count" + MSG_SHOULD_EQUAL
  );
  let update = history[0];
  Assert.equal(
    update.state,
    STATE_FAILED,
    "the first update state" + MSG_SHOULD_EQUAL
  );
  const expectedErrorCode = {
    [cleanupReasons.wrongChannel]: ERR_CHANNEL_CHANGE,
    [cleanupReasons.versionTooOld]: ERR_OLDER_VERSION_OR_SAME_BUILD,
    [cleanupReasons.buildIdTooOld]: ERR_OLDER_VERSION_OR_SAME_BUILD,
    [cleanupReasons.incorrectStatus]: ERR_UPDATE_STATE_NONE,
  }[cleanupReason];
  Assert.equal(
    update.errorCode,
    expectedErrorCode,
    "the first update errorCode" + MSG_SHOULD_EQUAL
  );
  Assert.equal(
    update.statusText,
    getString("statusFailed"),
    "the first update statusText " + MSG_SHOULD_EQUAL
  );
  await waitForUpdateXMLFiles();

  let dir = getUpdateDirFile(DIR_PATCH);
  Assert.ok(dir.exists(), MSG_SHOULD_EXIST);

  let statusFile = getUpdateDirFile(FILE_UPDATE_STATUS);
  Assert.ok(!statusFile.exists(), MSG_SHOULD_NOT_EXIST);

  // Verify that the BITS job was cleaned up
  if (bitsId) {
    await Assert.rejects(
      connectToBitsMarDownload(bitsId),
      error =>
        error instanceof BitsError &&
        error.type == Ci.nsIBits.ERROR_TYPE_BITS_JOB_NOT_FOUND,
      "BITS job should have been cleaned up"
    );
  }
}

add_setup(async () => {
  Services.prefs.setBoolPref(PREF_APP_UPDATE_BITS_ENABLED, true);
  start_httpserver();

  setupTestCommon();
  await initUpdateService();
});

add_task(async function cleanupDownloading() {
  const bitsTaskStillExistsValues = [false];
  const updateHasBitsIdValues = [false];
  if (AppConstants.platform == "win") {
    // BITS is only available on Windows
    bitsTaskStillExistsValues.push(true);
    updateHasBitsIdValues.push(true);
  }

  await parameterizedTest(
    testCleanup,
    {
      cleanupReason: Object.values(cleanupReasons),
      updateHasBitsId: updateHasBitsIdValues,
      bitsTaskStillExists: bitsTaskStillExistsValues,
    },
    {
      skipFn: ({ updateHasBitsId, bitsTaskStillExists }) => {
        // It doesn't really make sense to test this case. How are we supposed
        // to cancel the bits task if we don't know the ID?
        return !updateHasBitsId && bitsTaskStillExists;
      },
    }
  );
});

add_task(async function teardown() {
  stop_httpserver(doTestFinish);
});
