import * as Constants from "/common/constants.js";
import * as BackgroundConnection from "./background-connection.js";

let mCount = 0;

export function increment() {
  mCount++;
}

export function decrement() {
  mCount--;
}

export function hasMultipleRestoringTabs() {
  return mCount > 1;
}

BackgroundConnection.onMessage.addListener(async (message) => {
  switch (message.type) {
    case Constants.kCOMMAND_NOTIFY_TAB_RESTORING:
      increment();
      break;

    case Constants.kCOMMAND_NOTIFY_TAB_RESTORED:
      decrement();
      break;
  }
});
