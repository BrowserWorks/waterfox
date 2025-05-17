import * as TabsStore from "/common/tabs-store.js";

browser.waterfoxBridge.onWindowVisibilityChanged.addListener(
  (windowId, visibilityState) => {
    if (windowId !== TabsStore.getCurrentWindowId()) return;

    document.documentElement.classList.toggle(
      "minimized",
      visibilityState === "hidden"
    );
  }
);
