import "./index.js";

import * as RetrieveURL from "/common/retrieve-url.js";
import Tab from "/common/Tab.js";

import * as Sidebar from "./sidebar.js";
import "./tab-preview.js";
import "./workaround-for-bug-1875100.js";

import * as EventUtils from "./event-utils.js";

RetrieveURL.registerFileURLResolver(async (file) => {
  return (
    file &&
    browser.waterfoxBridge.getFileURL({
      lastModified: file.lastModified,
      name: file.name,
      size: file.size,
      type: file.type,
    })
  );
});

RetrieveURL.registerSelectionClipboardProvider({
  isAvailable: () => browser.waterfoxBridge.isSelectionClipboardAvailable(),
  getTextData: () => browser.waterfoxBridge.getSelectionClipboardContents(),
});

window.addEventListener(
  "contextmenu",
  (event) => {
    if (EventUtils.getEventTargetType(event) !== "blank") return true;

    event.stopImmediatePropagation();
    event.preventDefault();
    return false;
  },
  { capture: true }
);

// Deactivate tab tooltip for tab hover previews
Tab.onCreated.addListener((tab) => {
  tab.$TST.registerTooltipText(browser.runtime.id, "", true);
});
Sidebar.onReady.addListener(() => {
  for (const tab of Tab.getAllTabs()) {
    tab.$TST.registerTooltipText(browser.runtime.id, "", true);
  }
});
