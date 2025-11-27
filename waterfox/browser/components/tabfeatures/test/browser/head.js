const { synthesizeDrop, synthesizeMouseAtCenter } = EventUtils;

const _COPY_URL_PREF = "browser.tabs.copyurl";
const _COPY_ALL_URLS_PREF = "browser.tabs.copyallurls";
const _COPY_ACTIVE_URL_PREF = "browser.tabs.copyurl.activetab";
const _DUPLICATE_TAB_PREF = "browser.tabs.duplicateTab";
const _RESTART_PREF = "browser.restart_menu.showpanelmenubtn";

const _URI1 = "https://test1.example.com/";
const _URI2 = "https://example.com/";

const _OS = AppConstants.platform;
/**
 * Helper for opening the toolbar context menu.
 */
async function openTabContextMenu(tab) {
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

async function _openAndCloseTabContextMenu(tab) {
  await openTabContextMenu(tab);
  info("Opened tab context menu");
  await EventUtils.synthesizeKey("VK_ESCAPE", {});
  info("Closed tab context menu");
}

/**
 * Helper for opening the file menu.
 */
async function openFileMenu() {
  info("Opening file menu");
  const fileMenu = document.getElementById("file-menu");
  const openFileMenuPromise = BrowserTestUtils.waitForPopupEvent(
    fileMenu,
    "shown"
  );
  EventUtils.synthesizeMouseAtCenter(fileMenu, {});
  await openFileMenuPromise;
  return fileMenu;
}

async function _openAndCloseFileMenu() {
  await openFileMenu();
  await EventUtils.synthesizeKey("VK_ESCAPE", {});
  info("Closed file menu");
}

/**
 * Helper for opening toolbar context menu.
 */
async function _openToolbarContextMenu(contextMenu, target) {
  const popupshown = BrowserTestUtils.waitForEvent(contextMenu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(target, { type: "contextmenu" });
  await popupshown;
}

/**
 * Helper to paste from clipboard
 */

async function _pasteFromClipboard(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const { document } = content;
    document.body.contentEditable = true;
    document.body.focus();
    const pastePromise = new Promise((resolve) => {
      document.addEventListener(
        "paste",
        (e) => {
          resolve(e.clipboardData.getData("text/plain"));
        },
        { once: true }
      );
    });
    document.execCommand("paste");
    return pastePromise;
  });
}
