/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Default preferences for automatic tab grouping feature

// Enable automatic tab grouping
pref("browser.tabs.autoGroupNewTabs", false);

// Placement mode for new tabs in groups
// Options: "after" (after source tab), "first" (beginning of group), "last" (end of group)
pref("browser.tabs.autoGroupNewTabs.placement", "after");

// Enable delay before grouping (allows user to cancel)
pref("browser.tabs.autoGroupNewTabs.delayEnabled", false);

// Delay in milliseconds before grouping occurs
pref("browser.tabs.autoGroupNewTabs.delayMs", 1000);

// Keyboard shortcut to cancel pending grouping
// Default: Ctrl+` on Windows/Linux, Option+` on macOS
#ifdef XP_MACOSX
pref("browser.tabs.autoGroupNewTabs.cancelShortcut", "Option+`");
#else
pref("browser.tabs.autoGroupNewTabs.cancelShortcut", "Ctrl+`");
#endif

// Keyboard shortcut to open a standard new tab (bypass grouping)
// Default: Alt+Shift+T (Windows/Linux), Option+Shift+T (macOS)
#ifdef XP_MACOSX
pref("browser.tabs.autoGroupNewTabs.bypassShortcut", "Option+Shift+T");
#else
pref("browser.tabs.autoGroupNewTabs.bypassShortcut", "Alt+Shift+T");
#endif

// Enable verbose debug logging for TabGrouping
pref("browser.tabs.autoGroupNewTabs.debugLog", false);

// Grace period after session restore before resuming auto-grouping (ms)
pref("browser.tabs.autoGroupNewTabs.resumeGraceMs", 1000);
