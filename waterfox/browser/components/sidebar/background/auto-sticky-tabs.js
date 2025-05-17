import { configs } from "/common/common.js";
import * as Constants from "/common/constants.js";

import Tab from "/common/Tab.js";

configs.$addObserver((key) => {
  switch (key) {
    case "stickyActiveTab":
      updateAutoStickyActive();
      break;

    case "stickySoundPlayingTab":
      updateAutoStickySoundPlaying();
      break;

    case "stickySharingTab":
      updateAutoStickySharing();
      break;

    default:
      break;
  }
});
configs.$loaded.then(() => {
  updateAutoStickyActive();
  updateAutoStickySoundPlaying();
  updateAutoStickySharing();
});

function updateAutoStickyActive() {
  if (configs.stickyActiveTab)
    Tab.registerAutoStickyState(Constants.kTAB_STATE_ACTIVE);
  else Tab.unregisterAutoStickyState(Constants.kTAB_STATE_ACTIVE);
}

function updateAutoStickySoundPlaying() {
  if (configs.stickySoundPlayingTab)
    Tab.registerAutoStickyState(Constants.kTAB_STATE_SOUND_PLAYING);
  else Tab.unregisterAutoStickyState(Constants.kTAB_STATE_SOUND_PLAYING);
}

function updateAutoStickySharing() {
  if (configs.stickySharingTab)
    Tab.registerAutoStickyState([
      Constants.kTAB_STATE_SHARING_CAMERA,
      Constants.kTAB_STATE_SHARING_MICROPHONE,
      Constants.kTAB_STATE_SHARING_SCREEN,
    ]);
  else
    Tab.unregisterAutoStickyState([
      Constants.kTAB_STATE_SHARING_CAMERA,
      Constants.kTAB_STATE_SHARING_MICROPHONE,
      Constants.kTAB_STATE_SHARING_SCREEN,
    ]);
}
