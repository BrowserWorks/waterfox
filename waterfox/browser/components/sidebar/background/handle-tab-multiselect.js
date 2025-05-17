import * as ApiTabs from "/common/api-tabs.js";
import { log as internalLogger } from "/common/common.js";

import Tab from "/common/Tab.js";

function log(...args) {
  internalLogger("background/handle-tab-multiselect", ...args);
}

Tab.onUpdated.addListener((tab, info, options = {}) => {
  if (
    !("highlighted" in info) ||
    !tab.$TST.subtreeCollapsed ||
    tab.$TST.collapsed ||
    !tab.$TST.multiselected ||
    !options.inheritHighlighted
  )
    return;

  const collapsedDescendants = tab.$TST.descendants;
  log("inherit highlighted state from root visible tab: ", {
    highlighted: info.highlighted,
    collapsedDescendants,
  });
  for (const descendant of collapsedDescendants) {
    browser.tabs
      .update(descendant.id, {
        highlighted: info.highlighted,
        active: descendant.active,
      })
      .catch(ApiTabs.createErrorHandler(ApiTabs.handleMissingTabError));
  }
});
