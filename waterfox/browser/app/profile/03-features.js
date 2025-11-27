// -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// --- Mozilla & Waterfox Services Integration ---
// Controls for features and promotions related to Mozilla or Waterfox services.

// Mozilla VPN Promotion
pref("browser.privatebrowsing.vpnpromourl", ""); // Clear URL for VPN promo in private browsing context.
pref("browser.vpn_promo.enabled", false, locked); // Disable the VPN promotion.
pref("browser.promo.focus.enabled", false, locked); // Disable Focus mode promotion.
pref("browser.promo.pin.enabled", false, locked); // Disable Pin mode promotion (assuming "pomo" was a typo).
pref("browser.contentblocking.report.vpn-promo.url", "", locked); // Clear URL for VPN promo in content blocking report.

// Firefox Accounts Toolbar Integration (Controls visibility of Monitor, Relay, VPN in FxA menu)
pref("identity.fxaccounts.toolbar.pxiToolbarEnabled.monitorEnabled", false);
pref("identity.fxaccounts.toolbar.pxiToolbarEnabled.relayEnabled", false);
pref("identity.fxaccounts.toolbar.pxiToolbarEnabled.vpnEnabled", false);

// --- Add-ons & Extension Recommendations ---
// Settings related to the display and suggestion of extensions.

// Disable "Recommendations" pane in about:addons (this pane sometimes uses Google Analytics).
pref("extensions.getAddons.showPane", false, locked);
// Disable recommendations in the "Extensions" and "Themes" panes of about:addons.
pref("extensions.htmlaboutaddons.recommendations.enabled", false, locked);
// Disable personalized extension recommendations in about:addons and on the AMO website.
pref("browser.discovery.enabled", false, locked); // This is a broader switch impacting "discovery" features.

// Disable Contextual Feature Recommender (CFR) for add-ons and features.
// CFR suggests extensions or browser features based on user activity patterns.
// [1] https://support.mozilla.org/en-US/kb/extension-recommendations
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false);

// --- New Tab Page (Activity Stream) Configuration ---
// These settings control the various sections and content sources for the New Tab Page (about:newtab).

// Activity Stream Router (ASRouter) Provider Settings
// These typically disable specific content providers that feed into the New Tab Page.
pref("browser.newtabpage.activity-stream.asrouter.providers.cfr", "{}", locked); // Contextual Feature Recommender provider.
pref("browser.newtabpage.activity-stream.asrouter.providers.cfr-fxa", "{}", locked); // CFR FxA integration provider.
pref("browser.newtabpage.activity-stream.asrouter.providers.message-groups", "{}", locked); // Message groups provider.
pref("browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments", "{}", locked); // Messaging experiments provider.
pref("browser.newtabpage.activity-stream.asrouter.providers.snippets", "{}", locked); // Snippets provider (Mozilla news/tips) via ASRouter.
pref("browser.newtabpage.activity-stream.asrouter.providers.whats-new-panel", "{}", locked); // Provider for the "What's New" panel content.
pref("browser.newtabpage.activity-stream.asrouter.useRemoteL10n", false, locked); // Disable use of remote localization for ASRouter content.

// General New Tab Page Content & Features
pref("browser.newtabpage.activity-stream.discoverystream.enabled", false, locked); // Disable Pocket/Discovery Stream integration on NTP.
pref("browser.newtabpage.activity-stream.discoverystream.config", "{}", locked); // Configuration for Discovery Stream (relevant if enabled elsewhere).
pref("browser.newtabpage.activity-stream.showSearch", false); // Hide the search bar on the New Tab Page.
pref("browser.newtabpage.activity-stream.improvesearch.topSiteSearchShortcuts", false); // Show search shortcuts (e.g., @bookmarks) on Top Sites.
pref("browser.newtabpage.activity-stream.feeds.topsites", true); // Show the Top Sites section.
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false, locked); // Hide sponsored Top Sites.
pref("browser.newtabpage.activity-stream.system.showSponsored", false, locked); // Hide sponsored checkbox
pref("browser.newtabpage.activity-stream.system.showSponsoredCheckboxes", false, locked); // Hide sponsored checkbox
pref("browser.newtabpage.activity-stream.feeds.system.topstories", false, locked); // Disable system-provided top stories feed (Pocket integration).
pref("browser.newtabpage.activity-stream.feeds.section.topstories", false, locked); // Disable the "Recommended by Pocket" section.
pref("browser.newtabpage.activity-stream.showSponsored", false, locked); // Disable general sponsored content on the New Tab Page.

// Weather Widget on New Tab Page
pref("browser.newtabpage.activity-stream.showWeather", false); // Hide the weather widget.
pref("browser.newtabpage.activity-stream.system.showWeather", true); // Show "Weather" as a configurable UI option in NTP settings.

// Highlights Section (Recent Activity: Bookmarks, History, Downloads)
pref("browser.newtabpage.activity-stream.feeds.section.highlights", true); // Show the Highlights section.
pref("browser.newtabpage.activity-stream.section.highlights.includeBookmarks", true); // Include bookmarks in Highlights.
pref("browser.newtabpage.activity-stream.section.highlights.includeDownloads", false); // Do not include downloads in Highlights.
pref("browser.newtabpage.activity-stream.section.highlights.includeVisited", true); // Include recently visited sites in Highlights.
pref("browser.newtabpage.activity-stream.section.highlights.includePocket", false, locked); // Do not include Pocket saves in Highlights.
pref("browser.newtabpage.activity-stream.section.highlights.rows", 2); // Number of rows displayed for Highlights.

// Other New Tab Page Settings
pref("browser.newtabpage.activity-stream.feeds.snippets", false); // Disable Mozilla/Firefox related news/tips snippets feed directly on NTP.
pref("browser.newtabpage.activity-stream.default.sites", "", locked); // Clear the list of default Top Sites (locked to prevent override).
pref("browser.newtabpage.activity-stream.logowordmark.alwaysVisible", false); // Control visibility of Waterfox logo/wordmark on NTP.

// --- Browser UI & Interaction ---
// Miscellaneous settings affecting the browser's user interface and behavior.

// "More from Mozilla" section in Preferences/Settings
pref("browser.preferences.moreFromMozilla", false); // Hide this promotional section.

// Warnings & Notices
pref("browser.aboutConfig.showWarning", false); // Disable the warning dialog when accessing about:config..

// Profile Management
pref("browser.profiles.enabled", true); // Enable the new profile switcher UI.

// --- Sidebar Revamp Features ---
// Controls for an alternative sidebar implementation or major update.
pref("sidebar.revamp", true);
// Should the sidebar launcher default to visible or not with horizontal tabs
pref("sidebar.revamp.defaultLauncherVisible", false);

// Linux Specific UI
#ifdef XP_UNIX
  #ifndef XP_MACOSX
    // Use native-style title bar buttons on GTK environments for better desktop integration.
    pref("widget.gtk.non-native-titlebar-buttons.enabled", true);
  #endif
#endif

// Cookie Banner Handling
// Controls the browser's automated interaction with cookie consent banners.
// 0 = disable all handling.
// 1 = reject banners if a one-click "reject all" option is available; otherwise, keep banners on screen.
// 2 = reject banners if a one-click "reject all" is available; otherwise, fall back to an "accept all" option.
pref("cookiebanners.service.mode", 1);
pref("cookiebanners.service.mode.privateBrowsing", 1); // Same setting for Private Browsing mode.
pref("cookiebanners.ui.desktop.enabled", true); // Show a toggle in about:preferences

// --- URL Bar (AwesomeBar) & Search Functionality ---\n// Settings for the address bar, search suggestions, and related features.

// URL Bar Suggestions (what types of suggestions appear in the dropdown)
pref("browser.urlbar.suggest.history", true); // Suggest from browsing history.
pref("browser.urlbar.suggest.bookmark", true); // Suggest from bookmarks.
pref("browser.urlbar.suggest.clipboard", true); // Suggest content from the clipboard (if enabled by user).
pref("browser.urlbar.suggest.openpage", true); // Suggest currently open tabs.
pref("browser.urlbar.suggest.engines", true); // Suggest installed search engines.
pref("browser.urlbar.suggest.searches", true); // Suggest past search terms.
pref("browser.urlbar.suggest.topsites", true); // Disable suggesting top sites when the URL bar is empty and focused.

// URL Bar Quick Actions & Utilities
pref("browser.urlbar.quickactions.enabled", false); // Disable quick actions (e.g., "view downloads", "manage extensions").
pref("browser.urlbar.shortcuts.quickactions", false); // Disable shortcuts for quick actions (e.g., typing "downloads").
pref("browser.urlbar.suggest.weather", false); // Disable weather forecast suggestions in the URL bar.
pref("browser.urlbar.weather.ignoreVPN", false); // If weather suggestions are enabled, setting to true ignores VPN status for location.
pref("browser.urlbar.suggest.calculator", true); // Enable the built-in calculator in the URL bar (e.g., "5*5").
pref("browser.urlbar.unitConversion.enabled", true); // Enable unit conversion in the URL bar (e.g., "10ft to m").

// URL Bar Feature Gates (Disabling specific third-party or experimental integrations)
pref("browser.urlbar.trending.featureGate", false); // Disable trending search suggestions from search providers.
pref("browser.urlbar.addons.featureGate", false); // Disable suggestions for add-ons.
pref("browser.urlbar.fakespot.featureGate", false); // Disable Fakespot integration (product review analysis).
pref("browser.urlbar.mdn.featureGate", false); // Disable MDN (Mozilla Developer Network) suggestions for web development terms.
pref("browser.urlbar.weather.featureGate", false); // Master feature gate for weather suggestions.
pref("browser.urlbar.clipboard.featureGate", false); // Master feature gate for clipboard suggestions.
pref("browser.urlbar.yelp.featureGate", false); // Disable Yelp integration for local business suggestions.

// Search Settings
pref("browser.search.separatePrivateDefault.ui.enabled", true); // Enable UI to set a different default search engine for Private Windows.

// --- Web Content Handling & Features ---
// Settings related to how specific web content or browser features behave.

// Text Fragments (Scroll-to-text links)
pref("dom.text_fragments.create_text_fragment.enabled", true); // Allow creating and navigating to links that scroll to specific text on a page.

// PDF Handling
pref("browser.download.open_pdf_attachments_inline", true); // Open PDF attachments inline using the built-in PDF viewer by default.

// Download Behaviors
pref("browser.download.manager.addToRecentDocs", false); // Do not add downloaded files to the system's "Recent Documents" list (Windows).
pref("browser.download.always_ask_before_handling_new_types", true); // Always ask the user how to handle new MIME types, rather than automatically saving.

// JavaScript Pop-up Window Behavior
// Controls how new windows opened by JavaScript are handled.
// 0 = force all new windows into tabs.
// 1 = let all JavaScript windows open as new windows.
// 2 = default Firefox behavior (catches some popups, lets others open as new windows based on features).
// [1] https://kb.mozillazine.org/About:config_entries (browser.link.open_newwindow.restriction)
pref("browser.link.open_newwindow.restriction", 0);

// --- Menus, Find Bar, and Text Selection ---
// UI elements related to navigation and content interaction.

// Bookmarks Menu
pref("browser.bookmarks.openInTabClosesMenu", false); // Keep the Bookmarks Menu open when selecting an item to open in a new tab.

// Context Menus
pref("browser.menu.showViewImageInfo", true); // Restore "View Image Info" to the image context menu.

// Find Bar
pref("findbar.highlightAll", true); // Highlight all occurrences of the searched text in the Find Bar.

// Text Selection Behavior
pref("layout.word_select.eat_space_to_next_word", false); // When double-clicking a word, do not automatically select the space that follows it.

// --- Tab Features & Behavior ---
// Settings controlling tab previews, actions, and states.

// Tab Previews (on hover)
pref("browser.history.collectWireframes", true); // Show "wireframes" (simplistic visual approximation) for tabs that where unloaded after being visited.
pref("browser.tabs.hoverPreview.enabled", true); // Enable previews of tab content when hovering over a tab.
pref("browser.tabs.hoverPreview.showThumbnails", true); // Show thumbnails (screenshots) in tab hover previews.

// Tab Actions (from context menu or elsewhere)
pref("browser.tabs.duplicateTab", true); // Enable the "Duplicate Tab" option in the tab context menu.
pref("browser.tabs.copyurl", true); // Enable "Copy URL" in the tab context menu.
pref("browser.tabs.copyallurls", false); // Enable "Copy All URLs" in the tab context menu (copies URLs of all open tabs).
pref("browser.tabs.copyurl.activetab", false); // If true, "Copy URL" might specifically target only the active tab (less common).
pref("browser.tabs.unloadTab", true); // Allow unloading of tabs

// --- Source Viewer & Developer Tools ---
// Settings for web development and inspection tools.

// Enable `@-moz-document` rules, which can be used by user styles (e.g., via Stylus) to target specific sites.
// [1] https://reddit.com/r/FirefoxCSS/comments/8x2q97/reenabling_mozdocument_rules_in_firefox_61/
pref("layout.css.moz-document.content.enabled", true);
// Wrap long lines in the View Source window.
pref("view_source.wrap_long_lines", true);
// Wrap long lines in the code editor within the DevTools debugger.
pref("devtools.debugger.ui.editor-wrapping", true);
pref("layout.dynamic-reflow-roots.enabled", true); // Enable dynamic reflow roots for improved rendering performance.

// --- AI & Machine Learning Features ---
// Controls for features utilizing AI or Machine Learning.
pref("browser.ml.chat.enabled", false); // Disable built-in ML chat features.
pref("browser.ml.enable", false); // Disable MLEngine completely
pref("browser.ml.linkPreview.enabled", false); // Just in case
pref("browser.ml.linkPreview.labs", 0, locked);
pref("browser.ml.linkPreview.optin", false, locked);

// --- Miscellaneous Feature Toggles ---
// Various standalone feature settings.

// Image Format Support
pref("image.jxl.enabled", true); // Enable support for the JPEG XL image format.

// Keyboard Shortcuts
pref("browser.closeShortcut.disabled", false); // false = Ctrl+W (or Cmd+W) closes tab/window (default behavior). true = disables this shortcut.

pref("browser.restart_menu.showpanelmenubtn", true); // If a restart menu is present, show its button in a panel menu.
pref("browser.restart_menu.purgecache", false); // If true, purges caches upon restart initiated via this menu.
pref("browser.restart_menu.requireconfirm", true); // Require confirmation before restarting via this menu.

// --- Experimental Web Platform Features ---
// These features are typically under development and might be unstable or change in future releases.
// Use with caution.

// Enable CSS Masonry Layout (if available in the current browser version).
pref("layout.css.grid-template-masonry-value.enabled", true);
// Enable the Prioritized Task Scheduling API for web pages.
pref("dom.enable_web_task_scheduling", true); // Whether the scheduler interface will be exposed

// --- DOM Experimental Features ---
// https://whatpr.org/html/10168/interaction.html#closewatcher
pref("dom.closewatcher.enabled", true);
// WebCodecs API - H265
pref("dom.media.webcodecs.h265.enabled", true);
// Enable Screen Orientation lock
pref("dom.screenorientation.allow-lock", true);
// Whether allowing selection across the boundary
// between shadow DOM and light DOM.
// This is based on https://github.com/mfreed7/shadow-dom-selection
pref("dom.shadowdom.selection_across_boundary.enabled", true);
// When this pref is enabled:
//  - Shadow DOM is not pierced by default anymore
//  - The method accepts optional CaretPositionFromPointOptions to allow piercing
//    certain ShadowRoots
//
// https://drafts.csswg.org/cssom-view/#dom-document-caretpositionfrompoint
pref("dom.shadowdom.new_caretPositionFromPoint_behavior.enabled", true);
pref("dom.webnotifications.actions.enabled", true);
pref("dom.webgpu.enabled", true); // Enable WebGPU API.
pref("dom.webgpu.workers.enabled", true); // Enable WebGPU in Web Workers.
pref("dom.webshare.enabled", true); // Enable Web Share API.

// --- CSS Experimental Features ---
// Is support for shape() enabled?
pref("layout.css.basic-shape-shape.enabled", true);
// Whether to use tight bounds for floating ::first-letter (legacy Gecko behavior)
// or loose bounds based on overall font metrics (WebKit/Blink-like behavior)?
// Values mean:
//     1   legacy Gecko behavior (tight bounds)
//     0   loose typographic bounds (similar to webkit/blink)
//    -1   auto behavior: use loose bounds if reduced line-height (<1em) or negative
//         block-start margin is present; otherwise use tight bounds.
pref("layout.css.floating-first-letter.tight-glyph-bounds", -1);
// Is support for font-variant-emoji enabled?
pref("layout.css.font-variant-emoji.enabled", true);
// Whether @scope rule is enabled
pref("layout.css.at-scope.enabled", true);
// Whether the scroll-driven animations generated by CSS is enabled. This
// also include animation-timeline property.
pref("layout.css.scroll-driven-animations.enabled", true);

// --- SVG Experimental Features ---
// Is support for the new getBBox method from SVG 2 enabled?
// See https://svgwg.org/svg2-draft/single-page.html#types-SVGBoundingBoxOptions
pref("svg.new-getBBox.enabled", true);
// Whether we use Moz2D Path::GetStrokedBounds to get the stroke bounds.
pref("svg.Moz2D.strokeBounds.enabled", true);
