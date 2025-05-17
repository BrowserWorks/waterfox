const { TabStateFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
);

const { TabStateCache } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateCache.sys.mjs"
);

const { SearchTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/SearchTestUtils.sys.mjs"
);

SearchTestUtils.init(this);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);

UrlbarTestUtils.init(this);

const { PrivateTab } = ChromeUtils.importESModule(
  "resource:///modules/PrivateTab.sys.mjs"
);

const _URI1 = "https://test1.example.com/";
const _URI2 = "https://example.com/";

const _OS = AppConstants.platform;

function _promiseBrowserLoaded(
  aBrowser,
  ignoreSubFrames = true,
  wantLoad = null
) {
  return BrowserTestUtils.browserLoaded(aBrowser, !ignoreSubFrames, wantLoad);
}

// Removes the given tab immediately and returns a promise that resolves when
// all pending status updates (messages) of the closing tab have been received.
function _promiseRemoveTabAndSessionState(tab) {
  const sessionUpdatePromise = BrowserTestUtils.waitForSessionStoreUpdate(tab);
  BrowserTestUtils.removeTab(tab);
  return sessionUpdatePromise;
}

function _setPropertyOfFormField(browserContext, selector, propName, newValue) {
  return SpecialPowers.spawn(
    browserContext,
    [selector, propName, newValue],
    (selectorChild, propNameChild, newValueChild) => {
      const node = content.document.querySelector(selectorChild);
      node[propNameChild] = newValueChild;

      const event = node.ownerDocument.createEvent("UIEvents");
      event.initUIEvent("input", true, true, node.ownerGlobal, 0);
      node.dispatchEvent(event);
    }
  );
}

/**
 * Helper for opening the toolbar context menu.
 */
async function _openTabContextMenu(tab) {
  info("Opening tab context menu");
  const contextMenu = document.getElementById("tabContextMenu");
  const openTabContextMenuPromise = BrowserTestUtils.waitForPopupEvent(
    contextMenu,
    "shown"
  );

  EventUtils.synthesizeMouseAtCenter(tab, { type: "contextmenu" });
  await openTabContextMenuPromise;
  return contextMenu;
}
