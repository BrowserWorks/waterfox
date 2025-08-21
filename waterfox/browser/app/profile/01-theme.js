#filter dumbComments emptyLines substitution

// -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// --- General Browser Appearance & UI Density ---
// These preferences control the overall look and feel of the browser UI.
pref("browser.uidensity", 1); // 0=normal, 1=compact, 2=touch
pref("browser.theme.enableWaterfoxCustomizations", 1); // Enable Waterfox specific theme customizations
pref("browser.theme.native-theme", true); // Attempt to use native OS theme elements where possible

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

// =========================================================================================
// --- userChrome.css Customizations (Browser Interface Styling) ---
// These preferences are typically used in conjunction with userChrome.css to customize
// the browser's interface. They often toggle specific styles or layouts.
// =========================================================================================

// --- Tab Appearance & Style (userChrome.tab.*) ---
// General tab styling
pref("userChrome.tab.connect_to_window",          true); // Tab visually connects to the window.
pref("userChrome.tab.color_like_toolbar",         true); // Tab background color matches toolbar.
pref("userChrome.tab.lepton_like_padding",        false); // Use padding similar to Lepton theme style.
pref("userChrome.tab.photon_like_padding",       true);  // Use padding similar to Photon theme style.

// Tab separators
pref("userChrome.tab.dynamic_separator",          false); // Use dynamic tab separators.
pref("userChrome.tab.static_separator",          true);  // Use static tab separators.
pref("userChrome.tab.static_separator.selected_accent", false); // Add accent color to selected tab's static separator.
pref("userChrome.tab.bar_separator",             false); // Use a full bar separator under tabs.

// New Tab button styling
pref("userChrome.tab.newtab_button_like_tab",     false); // New Tab button styled like a tab.
pref("userChrome.tab.newtab_button_smaller",     true);  // Smaller New Tab button.
pref("userChrome.tab.newtab_button_proton",      false); // Proton-style New Tab button.

// Tab context lines (visual indicator line under the active tab)
pref("userChrome.tab.photon_like_contextline",   true);  // Photon theme style context line.
pref("userChrome.tab.supernova_like_contextline",   true); // Supernova theme style context line.

// Tab shape and specific theme decorations
pref("userChrome.tab.box_shadow",                 false); // Apply box shadow to tabs (Original theme style).
pref("userChrome.tab.bottom_rounded_corner",      false); // Rounded bottom corners for tabs (Original theme style).
pref("userChrome.tab.bottom_rounded_corner.all",       false); // All tabs have bottom rounded corners.
pref("userChrome.tab.bottom_rounded_corner.australis", false); // Australis theme style bottom rounded corners.
pref("userChrome.tab.bottom_rounded_corner.edge",      false); // Edge browser style bottom rounded corners.
pref("userChrome.tab.bottom_rounded_corner.chrome",    false); // Chrome browser style bottom rounded corners.
pref("userChrome.tab.bottom_rounded_corner.chrome_legacy", false); // Legacy Chrome style bottom rounded corners.
pref("userChrome.tab.bottom_rounded_corner.wave",      false); // Wave-style bottom rounded corners.
pref("userChrome.rounding.square_tab",           true);  // Use square tabs (Photon theme style).

// Tab states & indicators styling
pref("userChrome.tab.always_show_tab_icon",            false); // Always display favicons on tabs, even if space is limited.
pref("userChrome.tab.multi_selected",        true);  // Enable custom visual style for multi-selected tabs.
pref("userChrome.tab.unloaded",              true);  // Enable custom visual style for unloaded/pending tabs.
pref("userChrome.tab.letters_cleary",        false); // Attempt to improve letter clarity on tab titles.
pref("userChrome.tab.sound_hide_label",      false); // Hide the text label on the sound-playing indicator, showing only the icon.
pref("userChrome.tab.sound_show_label",                false); // Show label on sound-playing indicator (alternative to sound_hide_label).
pref("userChrome.tab.sound_with_favicons",   true);  // Integrate the sound indicator more closely with favicons.
pref("userChrome.tab.pip",                   true);  // Enable custom styling for the Picture-in-Picture indicator on tabs.
pref("userChrome.tab.container",             true);  // Enable custom styling for container tab indicators.
pref("userChrome.tab.crashed",               true);  // Enable custom styling for crashed tab indicators.

// Tab close button behavior styling
pref("userChrome.tab.close_button_at_hover", true);   // Show tab close button only on hover.
pref("userChrome.tab.close_button_at_hover.always",    false); // Always show close button (if close_button_at_hover is true).
pref("userChrome.tab.close_button_at_hover.with_selected", false);  // Show close button on hover also for selected tab.
pref("userChrome.tab.close_button_at_pinned",          false); // Show close button on pinned tabs.
pref("userChrome.tab.close_button_at_pinned.always",   false); // Always show close button on pinned tabs.
pref("userChrome.tab.close_button_at_pinned.background", false); // Style background of close button on pinned tabs.


// --- Icon Styling (userChrome.icon.*) ---
// Controls the appearance of various icons throughout the browser UI.
pref("userChrome.icon.panel_full",                false); // Use full-size panel icons (Original, Proton style).
pref("userChrome.icon.panel_photon",             true);  // Use Photon theme style panel icons.
pref("userChrome.icon.disabled",                       false); // Apply custom styling to disabled icons.
pref("userChrome.icon.account_image_to_right",         false); // Position Firefox Account image to the right.
pref("userChrome.icon.account_label_to_right",         false); // Position Firefox Account label to the right.
pref("userChrome.icon.menu.full",                      false); // Use full-size icons in menus.
pref("userChrome.icon.global_menu.mac",                false); // macOS specific styling for the global menu icon.
pref("userChrome.icon.library",              true); // Enable custom icons in the Library view.
pref("userChrome.icon.panel",                true); // Enable custom icons in various panels.
pref("userChrome.icon.menu",                 true); // Enable custom icons in main menus.
pref("userChrome.icon.context_menu",         true); // Enable custom icons in context menus.
pref("userChrome.icon.global_menu",          true); // Enable custom icons in the global menu (e.g., Hamburger menu).
pref("userChrome.icon.global_menubar",       true); // Enable custom icons in the menubar (File, Edit, etc.).


// --- Theme & UI Element Colors/Styles (userChrome.theme.*) ---
// Controls overall color schemes and specific theme applications.
pref("userChrome.theme.private",                       true); // Enable a distinct theme for private browsing mode.
pref("userChrome.theme.proton_color.dark_blue_accent", true); // Use a dark blue accent color for Proton theme elements.
pref("userChrome.theme.monospace",                     false); // Use monospace font for certain UI elements for a technical look.
pref("userChrome.theme.transparent.frame",             false); // Apply transparency to the main window frame.
pref("userChrome.theme.transparent.menu",              false); // Apply transparency to menus.
pref("userChrome.theme.transparent.panel",             false); // Apply transparency to panels.
pref("userChrome.theme.non_native_menu",               false); // Use custom, non-native menu styling (primarily for Linux).

// Color schemes and overrides
pref("userChrome.theme.built_in_contrast",   false); // Use a built-in high contrast theme.
pref("userChrome.theme.system_default",      false); // Attempt to follow the system's default light/dark theme.
pref("userChrome.theme.proton_color",        false); // Enable general Proton color scheme overrides.
pref("userChrome.theme.proton_chrome",       false); // Apply Proton colors specifically to browser chrome (requires userChrome.theme.proton_color).
pref("userChrome.theme.fully_color",         false); // Apply a more extensive color scheme (requires userChrome.theme.proton_color).
pref("userChrome.theme.fully_dark",          false); // Apply a more extensive dark theme (requires userChrome.theme.proton_color).


// --- UI Decorations & Animations (userChrome.decoration.*) ---
// Controls visual decorations, borders, and animations.
pref("userChrome.decoration.disable_panel_animate",    false); // Disable animations for panels.
pref("userChrome.decoration.disable_sidebar_animate",  false); // Disable animations for the sidebar.
pref("userChrome.decoration.animate",        true);  // General toggle for UI animations.
pref("userChrome.decoration.panel_button_separator",   true); // Show separators between buttons in panels.
pref("userChrome.decoration.panel_arrow",              true); // Show the arrow indicator on panels.
pref("userChrome.decoration.cursor",         true);  // Enable custom cursor styles defined in userChrome.css.
pref("userChrome.decoration.field_border",   true);  // Enable custom border styles for input fields.
pref("userChrome.decoration.download_panel", true);  // Enable custom styling for the download panel.


// --- Toolbar & Element Rounding (userChrome.rounding.*) ---
// Controls whether various UI elements use square or rounded corners.
pref("userChrome.rounding.square_button",              false); // Square buttons.
pref("userChrome.rounding.square_dialog",              false); // Square dialogs.
pref("userChrome.rounding.square_panel",               false); // Square panels.
pref("userChrome.rounding.square_panelitem",           false); // Square panel items.
pref("userChrome.rounding.square_menupopup",           false); // Square menu popups.
pref("userChrome.rounding.square_menuitem",            false); // Square menu items.
pref("userChrome.rounding.square_infobox",             false); // Square info boxes.
pref("userChrome.rounding.square_toolbar",             false); // Square toolbars.
pref("userChrome.rounding.square_field",               false); // Square input fields.
pref("userChrome.rounding.square_urlView_item",        false); // Square items in URL view (address bar dropdown).
pref("userChrome.rounding.square_checklabel",          false); // Square checkboxes and radio buttons.


// --- Toolbar & Element Padding (userChrome.padding.*) ---
// Controls padding for various UI elements, often for compact or expanded views.
pref("userChrome.padding.first_tab",                   false); // Custom padding for the first tab.
pref("userChrome.padding.first_tab.always",            false); // Always apply first_tab padding.
pref("userChrome.padding.drag_space",                  false); // Custom padding for the draggable space at the top of the window.
pref("userChrome.padding.drag_space.maximized",        false); // Custom drag space padding when maximized.
pref("userChrome.padding.toolbar_button.compact",      false); // Compact padding for toolbar buttons.
pref("userChrome.padding.menu_compact",                false); // Compact menu item padding.
pref("userChrome.padding.bookmark_menu.compact",       false); // Compact bookmark menu item padding.
pref("userChrome.padding.urlView_expanding",           false); // Padding for the expanding URL view (results list).
pref("userChrome.padding.urlView_result",              false); // Padding for individual URL view results.
pref("userChrome.padding.panel_header",                false); // Padding for panel headers.
pref("userChrome.padding.tabbar_width",      false); // Custom padding affecting tab bar width.
pref("userChrome.padding.tabbar_height",     false); // Custom padding affecting tab bar height.
pref("userChrome.padding.toolbar_button",    false); // General toolbar button padding.
pref("userChrome.padding.navbar_width",      false); // Custom padding affecting navigation bar width.
pref("userChrome.padding.urlbar",            false); // Custom padding for the URL bar.
pref("userChrome.padding.bookmarkbar",       false); // Custom padding for the bookmark bar.
pref("userChrome.padding.infobar",           false); // Custom padding for info bars.
pref("userChrome.padding.menu",              false); // General menu padding.
pref("userChrome.padding.bookmark_menu",     false); // General bookmark menu padding.
pref("userChrome.padding.global_menubar",    false); // Padding for the global menubar.
pref("userChrome.padding.panel",             false); // General panel padding.
pref("userChrome.padding.popup_panel",       false); // Padding for popup panels.


// --- Auto-hiding Toolbars & Elements (userChrome.autohide.*) ---
// Enables auto-hiding behavior for various toolbars and UI elements.
pref("userChrome.autohide.tab",                        false); // Autohide individual tabs.
pref("userChrome.autohide.tab.opacity",                false); // Control opacity during tab autohide.
pref("userChrome.autohide.tab.blur",                   false); // Apply blur effect during tab autohide.
pref("userChrome.autohide.tabbar",                     false); // Autohide the entire tab bar.
pref("userChrome.autohide.navbar",                     false); // Autohide the navigation bar.
pref("userChrome.autohide.bookmarkbar",                false); // Autohide the bookmark bar.
pref("userChrome.autohide.sidebar",                    false); // Autohide the sidebar.
pref("userChrome.autohide.fill_urlbar",                false); // Expand URL bar to fill space when navbar is hidden.
pref("userChrome.autohide.back_button",                false); // Autohide the back button.
pref("userChrome.autohide.forward_button",             false); // Autohide the forward button.
pref("userChrome.autohide.page_action",                false); // Autohide page actions in the URL bar.
pref("userChrome.autohide.toolbar_overlap",            false); // Allow toolbars to overlap when auto-hiding.
pref("userChrome.autohide.toolbar_overlap.allow_layout_shift", false); // Allow layout shift with toolbar overlap.


// --- Hiding Specific UI Elements (userChrome.hidden.*) ---
// Allows completely hiding certain UI elements.
pref("userChrome.hidden.tab_icon",                     false); // Hide tab favicons.
pref("userChrome.hidden.tab_icon.always",              false); // Always hide tab favicons.
pref("userChrome.hidden.tabbar",                       false); // Hide the entire tab bar.
pref("userChrome.hidden.navbar",                       false); // Hide the navigation bar.
pref("userChrome.hidden.titlebar_container",           false); // Hide the title bar container (useful with custom title bars).
pref("userChrome.hidden.sidebar_header",               false); // Hide the sidebar header.
pref("userChrome.hidden.sidebar_header.vertical_tab_only", false); // Hide sidebar header only for vertical tabs.
pref("userChrome.hidden.urlbar_iconbox",               false); // Hide the icon box within the URL bar (e.g., for shields, page actions).
pref("userChrome.hidden.urlbar_iconbox.label_only",    false); // Hide only labels in URL bar icon box.
pref("userChrome.hidden.bookmarkbar_icon",             false); // Hide icons on the bookmark bar.
pref("userChrome.hidden.bookmarkbar_label",            false); // Hide labels on the bookmark bar.
pref("userChrome.hidden.disabled_menu",                false); // Hide disabled menu items.


// --- Centering UI Elements (userChrome.centered.*) ---
// Styles for centering certain UI elements.
pref("userChrome.centered.tab",                        false); // Center tab content.
pref("userChrome.centered.tab.label",                  false); // Center tab labels.
pref("userChrome.centered.urlbar",                     false); // Center URL bar text.
pref("userChrome.centered.bookmarkbar",                false); // Center bookmark bar items.


// --- UI Element Counters (userChrome.counter.*) ---
// Enables displaying counters on certain UI elements (e.g., number of open tabs).
pref("userChrome.counter.tab",                         false); // Show a counter on tabs.
pref("userChrome.counter.bookmark_menu",               false); // Show a counter in bookmark menus.


// --- Combined UI Elements (userChrome.combined.*) ---
// Preferences for merging normally separate UI elements.
pref("userChrome.combined.nav_button",                 false); // Combine back and forward buttons into one.
pref("userChrome.combined.nav_button.home_button",     false); // Combine back/forward buttons with the home button.
pref("userChrome.combined.urlbar.nav_button",          false); // Move navigation buttons into the URL bar.
pref("userChrome.combined.urlbar.home_button",         false); // Move the home button into the URL bar.
pref("userChrome.combined.urlbar.reload_button",       false); // Move the reload button into the URL bar.
pref("userChrome.combined.sub_button.none_background", false); // Style for combined sub-buttons without a background.
pref("userChrome.combined.sub_button.as_normal",       false); // Style combined sub-buttons like normal buttons.


// --- URL Bar & Address View Appearance (userChrome.urlbar.*, userChrome.urlView.*) ---
// Customization for the URL bar (address bar) and its dropdown results list.
pref("userChrome.urlbar.iconbox_with_separator",       true); // Show a separator for the URL bar icon box.
pref("userChrome.urlView.as_commandbar",               false); // Style the URL view dropdown (results list) like a command bar.
pref("userChrome.urlView.full_width_padding",          false); // Apply full-width padding to the URL view.
pref("userChrome.urlView.always_show_page_actions",    false); // Always show page actions within the URL view results.
pref("userChrome.urlView.move_icon_to_left",           false); // Move icons in URL view items to the left side.
pref("userChrome.urlView.go_button_when_typing",       false); // Show a "Go" button in the URL bar while typing.
pref("userChrome.urlView.focus_item_border",           false); // Add a border to focused items in the URL view.


// --- Tab Bar Appearance & Behavior (userChrome.tabbar.*) ---
// Customization for the tab bar itself.
pref("userChrome.tabbar.as_titlebar",                  false); // Use the tab bar area as the window title bar (e.g., for custom title bar buttons).
pref("userChrome.tabbar.fill_width",                   false); // Make the tab bar fill the entire width of the window.
pref("userChrome.tabbar.multi_row",                    false); // Allow tabs to wrap into multiple rows if they don't fit.
pref("userChrome.tabbar.unscroll",                     false); // Disable scrolling in the tab bar, showing all tabs (may shrink tabs).
pref("userChrome.tabbar.on_bottom",                    false); // Move the tab bar to the bottom of the window.
pref("userChrome.tabbar.on_bottom.above_bookmark",     false); // If tab bar is on bottom, position it above the bookmark bar.
pref("userChrome.tabbar.on_bottom.menubar_on_top",     false); // If tab bar is on bottom, keep the menubar at the top.
pref("userChrome.tabbar.on_bottom.hidden_single_tab",  false); // If tab bar is on bottom, hide it when only a single tab is open.
pref("userChrome.tabbar.one_liner",                    false); // Attempt to put the tab bar and navigation bar on a single line.
pref("userChrome.tabbar.one_liner.combine_navbar",     false); // If one_liner is true, combine with the navigation bar.
pref("userChrome.tabbar.one_liner.tabbar_first",       false); // If one_liner is true, position tab bar before the navigation bar.
pref("userChrome.tabbar.one_liner.responsive",         false); // If one_liner is true, enable responsive layout adjustments.


// --- Other Specific UI Element Tweaks (userChrome.*) ---
// Miscellaneous tweaks for specific UI parts.
pref("userChrome.navbar.as_sidebar",                   false); // Style the navigation bar to look like a sidebar.
pref("userChrome.bookmarkbar.multi_row",               false); // Allow bookmark bar items to wrap into multiple rows.
pref("userChrome.findbar.floating_on_top",             false); // Make the findbar float on top of web content.
pref("userChrome.panel.remove_strip",                  false); // Remove the strip/border from panels.
pref("userChrome.panel.full_width_separator",          false); // Use full-width separators in panels.
pref("userChrome.panel.full_width_padding",            false); // Use full-width padding in panels.
pref("userChrome.sidebar.overlap",                     false); // Allow the sidebar to overlap web content (theme integration).
pref("userChrome.fullscreen.overlap",        true);  // Allow toolbars to overlap web content in fullscreen mode.
pref("userChrome.fullscreen.show_bookmarkbar", false); // Show the bookmark bar when in fullscreen mode.


// --- Theme/OS Compatibility Settings (userChrome.compatibility.*) ---
// These settings help manage compatibility with different browser themes or OS rendering quirks.
pref("userChrome.compatibility.covered_header_image", false); // Adjust for themes where header images might be covered.
pref("userChrome.compatibility.panel_cutoff",         false); // Adjust for themes where panels might be visually cut off.
pref("userChrome.compatibility.navbar_top_border",    false); // Adjust for themes with navbar top border issues.
pref("userChrome.compatibility.dynamic_separator",    false); // Compatibility setting for dynamic separators (requires userChrome.tab.dynamic_separator).
pref("userChrome.compatibility.os.linux_non_native_titlebar_button", false); // For Linux systems using non-native titlebar buttons.
pref("userChrome.compatibility.os.windows_maximized", false); // For Windows specific issues when the window is maximized.
pref("userChrome.compatibility.os.win11",             false); // For Windows 11 specific theme rendering issues.
pref("userChrome.compatibility.theme",       false); // Master switch for various theme compatibility tweaks.
pref("userChrome.compatibility.os",          false); // Master switch for various OS-level compatibility tweaks.


// =========================================================================================
// --- userContent.css Customizations (Web Content & Internal Page Styling) ---
// These preferences are typically used in conjunction with userContent.css to customize
// the appearance of web content and some internal browser pages (like about: pages).
// =========================================================================================

// --- Media Player Appearance (userContent.player.*) ---
// Styling for the built-in HTML5 media player.
pref("userContent.player.ui.twoline",                  false); // Use a two-line layout for the media player UI.
pref("userContent.player.ui",             true);  // Enable custom styling for the media player UI.
pref("userContent.player.icon",           true);  // Enable custom icons for the media player.
pref("userContent.player.noaudio",        true);  // Apply specific styling when no audio track is present.
pref("userContent.player.size",           true);  // Allow userContent.css to control media player size.
pref("userContent.player.click_to_play",  true);  // Enable custom styling for the click-to-play overlay.
pref("userContent.player.animate",        true);  // Enable animations within the media player UI.


// --- New Tab Page Content Styling (userContent.newTab.*) ---
// Styling for elements on the New Tab Page (about:newtab).
pref("userContent.newTab.hidden_logo",                 false); // Hide the logo on the New Tab Page.
pref("userContent.newTab.background_image",            false); // Allow a custom background image for the New Tab Page via userContent.css.
pref("userContent.newTab.full_icon",      true);  // Use full-size icons for top sites/shortcuts on the New Tab Page.
pref("userContent.newTab.animate",        true);  // Enable animations on the New Tab Page.
pref("userContent.newTab.pocket_to_last", false); // Move the Pocket section to the end of the New Tab Page content.
pref("userContent.newTab.searchbar",      true);  // Enable custom styling for the search bar on the New Tab Page.


// --- General Web Page Content Styling (userContent.page.*) ---
// Broad styling controls for web content and internal browser pages.
pref("userContent.page.proton_color.dark_blue_accent", false); // Apply a dark blue accent to web content (Proton theme style).
pref("userContent.page.proton_color.system_accent",    true);  // Attempt to apply the system's accent color to web content.
pref("userContent.page.monospace",                     false); // Use monospace font for certain web page elements (e.g., <pre>, <code>).
pref("userContent.page.field_border",     true);  // Enable custom border styles for input fields on web pages.
pref("userContent.page.illustration",     true);  // Enable custom styling for illustrations on internal browser pages (e.g., about: pages).
pref("userContent.page.proton_color",     true);  // Enable general Proton color scheme overrides for web content.
pref("userContent.page.dark_mode",        false); // Apply a dark mode styling to web content (requires userContent.page.proton_color).
pref("userContent.page.proton",           true);  // Apply general Proton styling principles to web content (requires userContent.page.proton_color).
