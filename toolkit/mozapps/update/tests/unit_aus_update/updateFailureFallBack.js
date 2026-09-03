/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

"use strict";

let serviceEnabledValue = Services.prefs.getBoolPref(
  PREF_APP_UPDATE_SERVICE_ENABLED,
  false
);
add_setup(() => {
  registerCleanupFunction(() => {
    Services.prefs.setBoolPref(
      PREF_APP_UPDATE_SERVICE_ENABLED,
      serviceEnabledValue
    );
  });
});

// This test ensures an update will be attempted to be installed a maximum of two times
// If the update install is still not successful, handleFallbackToCompleteUpdate will be ran.
add_task(async function updateFailureTest() {
  setupTestCommon();
  let expectedState;

  // Test install using maintenance service, which is only on Windows
  if (AppConstants.platform == "win") {
    Services.prefs.setBoolPref(PREF_APP_UPDATE_SERVICE_ENABLED, true);
    // Simulate update with service.
    expectedState = STATE_PENDING_SVC;
  } else {
    expectedState = STATE_PENDING;
  }

  // If service is avaliable, we should try again with service
  simulateUpdateState(expectedState, "failed: 7");
  reloadUpdateManagerData(false);
  let update = await gUpdateManager.getReadyUpdate();
  verifyUpdateStates(update, expectedState);

  // Simulate another failure, now no more retry attempts are left
  writeStatusFile("failed: 7");
  await testPostUpdateProcessing();
  update = await gUpdateManager.getReadyUpdate();

  Assert.ok(
    !update,
    "handleFallbackToCompleteUpdate should have cleared readyUpdate"
  );
  Assert.equal(
    gAUS.currentState,
    Ci.nsIApplicationUpdateService.STATE_IDLE,
    "AUS.currentState should be idle as we expect handleFallbackToCompleteUpdate() to be called"
  );

  executeSoon(doTestFinish);
});

function verifyUpdateStates(update, expectedStateAndStatus) {
  Assert.ok(update, "there should be a ready update");
  Assert.equal(
    update.state,
    expectedStateAndStatus,
    "update state should fall back to the expected state"
  );
  Assert.equal(
    readStatusFile(),
    expectedStateAndStatus,
    "status file should have the expected value"
  );
  Assert.equal(
    gAUS.currentState,
    Ci.nsIApplicationUpdateService.STATE_PENDING,
    "AUS.currentState should be pending as set in handleUpdateFailure"
  );
}

function simulateUpdateState(updateState, statusFileState) {
  const XML_UPDATE = `<?xml version="1.0"?>
    <updates xmlns="http://www.mozilla.org/2005/app-update">
      <update appVersion="1.0" buildID="20080811053724" channel="${UpdateUtils.UpdateChannel}"
              displayVersion="Version 1.0" installDate="1238441400314"
              platformVersion="1.0" isCompleteUpdate="true" name="Update Test 1.0" type="minor"
              detailsURL="http://example.com/" previousAppVersion="1.0"
              serviceURL="https://example.com/" statusText="The Update was successfully installed"
              foregroundDownload="true"
              actions="showURL"
              openURL="1.0">
        <patch type="complete" URL="http://example.com/" size="775" selected="true" state="${updateState}"/>
      </update>
    </updates>`;
  writeUpdatesToXMLFile(XML_UPDATE, true);
  writeStatusFile(statusFileState);
}
