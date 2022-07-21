"use strict";

const { AppConstants } = ChromeUtils.import(
  "resource://gre/modules/AppConstants.jsm"
);

const { TabStateFlusher } = ChromeUtils.import(
  "resource:///modules/sessionstore/TabStateFlusher.jsm"
);

const { TabStateCache } = ChromeUtils.import(
  "resource:///modules/sessionstore/TabStateCache.jsm"
);

const { SearchTestUtils } = ChromeUtils.import(
  "resource://testing-common/SearchTestUtils.jsm"
);

SearchTestUtils.init(this);

const { UrlbarTestUtils } = ChromeUtils.import(
  "resource://testing-common/UrlbarTestUtils.jsm"
);

UrlbarTestUtils.init(this);

const { PrivateTab } = ChromeUtils.import("resource:///modules/PrivateTab.jsm");

const URI1 = "https://test1.example.com/";
const URI2 = "https://example.com/";

let OS = AppConstants.platform;

function promiseBrowserLoaded(
  aBrowser,
  ignoreSubFrames = true,
  wantLoad = null
) {
  return BrowserTestUtils.browserLoaded(aBrowser, !ignoreSubFrames, wantLoad);
}

// Removes the given tab immediately and returns a promise that resolves when
// all pending status updates (messages) of the closing tab have been received.
function promiseRemoveTabAndSessionState(tab) {
  let sessionUpdatePromise = BrowserTestUtils.waitForSessionStoreUpdate(tab);
  BrowserTestUtils.removeTab(tab);
  return sessionUpdatePromise;
}

function setPropertyOfFormField(browserContext, selector, propName, newValue) {
  return SpecialPowers.spawn(
    browserContext,
    [selector, propName, newValue],
    (selectorChild, propNameChild, newValueChild) => {
      let node = content.document.querySelector(selectorChild);
      node[propNameChild] = newValueChild;

      let event = node.ownerDocument.createEvent("UIEvents");
      event.initUIEvent("input", true, true, node.ownerGlobal, 0);
      node.dispatchEvent(event);
    }
  );
}

/**
 * Helper for opening the toolbar context menu.
 */
async function openTabContextMenu(tab) {
  info("Opening tab context menu");
  let contextMenu = document.getElementById("tabContextMenu");
  let openTabContextMenuPromise = BrowserTestUtils.waitForPopupEvent(
    contextMenu,
    "shown"
  );

  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu" });
  await openTabContextMenuPromise;
  return contextMenu;
}
