/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WaterfoxStyles } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxStyles.sys.mjs"
);

const CHROME_URI = "chrome://browser/skin/waterfox/chrome.css";

add_task(function test_chrome_sheet_is_loaded_for_browser_document() {
  const sheet = InspectorUtils.getAllStyleSheets(document).find(
    candidate => candidate.href == CHROME_URI
  );

  ok(sheet, "The Waterfox chrome sheet is loaded in the browser document");
  is(sheet?.parsingMode, "user", "The chrome sheet is a user sheet");
});

add_task(function test_chrome_sheet_is_tracked_per_document() {
  const calls = [];
  const win = {
    document: null,
    windowUtils: {
      loadSheetUsingURIString(uri, type) {
        calls.push({ uri, type });
      },
    },
  };
  const createDocument = (windowType = "navigator:browser") => ({
    defaultView: win,
    documentElement: {
      getAttribute(name) {
        return name == "windowtype" ? windowType : "";
      },
    },
  });
  const firstDocument = createDocument();
  const secondDocument = createDocument();
  const delayedDocument = createDocument();
  const staleDocument = createDocument();
  const nonBrowserDocument = createDocument("navigator:preferences");

  win.document = firstDocument;
  WaterfoxStyles._loadChromeSheet(firstDocument);
  WaterfoxStyles.observe(firstDocument, "chrome-document-loaded");

  win.document = secondDocument;
  WaterfoxStyles.observe(secondDocument, "chrome-document-loaded");
  WaterfoxStyles.observe(staleDocument, "chrome-document-loaded");

  win.document = delayedDocument;
  WaterfoxStyles.observe(win, "browser-delayed-startup-finished");

  win.document = nonBrowserDocument;
  WaterfoxStyles.observe(nonBrowserDocument, "chrome-document-loaded");

  is(calls.length, 3, "The sheet is loaded once for each active browser document");
  for (const call of calls) {
    is(call.uri, CHROME_URI, "The Waterfox chrome sheet is loaded");
    is(
      call.type,
      Ci.nsIStyleSheetService.USER_SHEET,
      "The Waterfox chrome sheet is loaded as a user sheet"
    );
  }
});
