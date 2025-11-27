#filter dumbComments emptyLines substitution

// -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// --- General Browser Appearance & UI Density ---
// These preferences control the overall look and feel of the browser UI.
pref("browser.uidensity", 1); // 0=normal, 1=compact, 2=touch
pref("browser.theme.enableWaterfoxCustomizations", 1); // Enable Waterfox specific theme customizations

// Toolbar and UI Element Positions
pref("browser.bookmarks.toolbarposition", "top"); // Position of the bookmarks toolbar: "top" or "bottom"
pref("browser.tabs.toolbarposition", "topabove"); // Position of the tab toolbar (e.g., "topabove", "top", "bottom")
pref("browser.statusbar.enabled", false); // Show or hide the main status bar
pref("browser.statusbar.appendStatusText", true); // Append status text instead of replacing it (if statusbar is enabled)

// Tab Appearance (General Browser Settings)
pref("browser.tabs.closeButtons", false); // Controls display of close buttons on tabs. Behavior can be complex with userChrome.css.

// --- Custom Stylesheet Support ---
// Enables loading of userChrome.css (for browser UI) and userContent.css (for web content) for custom styling.
pref("toolkit.legacyUserProfileCustomizations.stylesheets", true, locked);

// --- OS-Specific Visual Integration ---
// These settings enhance visual integration with the underlying operating system.
#ifdef XP_MACOSX
// macOS specific visual settings for a more native look and feel.
pref("widget.macos.sidebar-blend-mode.behind-window", true); // Blends sidebar with window background.
pref("widget.macos.titlebar-blend-mode.behind-window", true); // Blends titlebar with window background.
#endif

#ifdef XP_WIN
// Windows specific visual settings, e.g., for Mica effect (Windows 11).
pref("widget.windows.mica", true); // Enable Mica effect for the main window.
pref("widget.windows.mica.popups", 1); // Mica for popups: 0=none, 1=auto, 2=acrylic, 3=tabbed.
pref("widget.windows.mica.toplevel-backdrop", 3); // Mica for other top-level windows (e.g., Picture-in-Picture).
// Only load keyboard layout when first needed, which is more efficient for Windows.
pref("ui.key.layout.load_when_first_needed", true);
#endif
