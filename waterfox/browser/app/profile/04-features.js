
#filter dumbComments emptyLines substitution

// -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

#ifdef XP_UNIX
  #ifndef XP_MACOSX
    #define UNIX_BUT_NOT_MAC
  #endif
#endif

// Based on curated prefs from Betterfox
// available at https://github.com/yokoffing/Betterfox

/****************************************************************************
 * SECTION: MOZILLA UI                                                      *
****************************************************************************/

pref("browser.contentblocking.report.lockwise.enabled", false, locked);
pref("browser.contentblocking.report.monitor.enabled", false, locked);
pref("browser.contentblocking.report.show_mobile_app", false, locked);

// PREF: Mozilla VPN
// [1] https://github.com/yokoffing/Betterfox/issues/169
pref("browser.privatebrowsing.vpnpromourl", "");
pref("browser.promo.focus.enabled", false, locked);
pref("browser.vpn_promo.enabled", false);

// PREF: disable about:addons' Recommendations pane (uses Google Analytics)
pref("extensions.getAddons.showPane", false); // HIDDEN
pref("extensions.htmlaboutaddons.recommendations.enabled", false);

// PREF: disable Extension Recommendations (CFR: "Contextual Feature Recommender")
// [1] https://support.mozilla.org/en-US/kb/extension-recommendations
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false);

// PREF: hide "More from Mozilla" in Settings
pref("browser.preferences.moreFromMozilla", false);

// PREF: only show List All Tabs icon when needed
// true=always show tab overflow dropdown (FF106+ default)
// false=only display tab dropdown when there are too many tabs
// [1] https://www.ghacks.net/2022/10/19/how-to-hide-firefoxs-list-all-tabs-icon/
pref("browser.tabs.tabmanager.enabled", false);

// PREF: disable Warnings
pref("browser.aboutConfig.showWarning", false);

// PREF: disable "What's New" toolbar icon [FF69+]
pref("browser.messaging-system.whatsNewPanel.enabled", false);

// PREF: show all matches in Findbar
pref("findbar.highlightAll", true);

// PREF: disable middle mouse click opening links from clipboard
// [1] https://gitlab.torproject.org/tpo/applications/tor-browser/-/issues/10089
pref("middlemouse.contentLoadURL", false);

// PREF: prevent private windows being separate from normal windows in taskbar [WINDOWS] [FF106+]
#if defined(XP_WIN)
pref("browser.privateWindowSeparation.enabled", false);
#endif

// PREF: Firefox Translations [NIGHTLY]
// Automated translation of web content is done locally in Firefox, so that
// the text being translated does not leave your machine.
// Visit about:translations to translate your own text as well.
// [1] https://blog.mozilla.org/en/mozilla/local-translation-add-on-project-bergamot/
// [2] https://blog.nightly.mozilla.org/2023/06/01/firefox-translations-and-other-innovations-these-weeks-in-firefox-issue-139/
// [3] https://www.ghacks.net/2023/08/02/mozilla-firefox-117-beta-brings-an-automatic-language-translator-for-websites-and-it-works-offline/
pref("browser.translations.enable", true);

/****************************************************************************
 * SECTION: URL BAR                                                         *
****************************************************************************/

pref("browser.urlbar.suggest.weather", false);

// enable helpful features:
pref("browser.urlbar.suggest.calculator", true);
pref("browser.urlbar.unitConversion.enabled", true);

/****************************************************************************
 * SECTION: NEW TAB PAGE                                                    *
****************************************************************************/

// PREF: open windows/tabs from last session
// 0=blank, 1=home, 2=last visited page, 3=resume previous session
// [NOTE] Session Restore is cleared with history and not used in Private Browsing mode
// [SETTING] General>Startup>Restore previous session
pref("browser.startup.page", 3);

// PREF: Pinned Shortcuts on New Tab
// [SETTINGS] Home>Firefox Home Content
// [1] https://github.com/arkenfox/user.js/issues/1556
pref("browser.newtabpage.activity-stream.discoverystream.config", "{}", locked);
pref("browser.newtabpage.activity-stream.discoverystream.enabled", false, locked); // unnecessary?
pref("browser.newtabpage.activity-stream.feeds.topsites", true); // Shortcuts
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false); // Sponsored shortcuts [FF83+]
pref("browser.newtabpage.activity-stream.feeds.section.topstories", false); // Recommended by Pocket
pref("browser.newtabpage.activity-stream.showSponsored", false); // Sponsored Stories [FF58+]  
pref("browser.newtabpage.activity-stream.feeds.snippets", false); // [DEFAULT]

// PREF: keep search in the search box; prevent from jumping to address bar
// [1] https://www.reddit.com/r/firefox/comments/oxwvbo/firefox_start_page_search_options/
pref("browser.newtabpage.activity-stream.improvesearch.handoffToAwesomebar", false);

/******************************************************************************
 * SECTION: POCKET                                                            *
******************************************************************************/

// PREF: Disable built-in Pocket extension
pref("extensions.pocket.enabled", false);
pref("extensions.pocket.api","");
pref("extensions.pocket.oAuthConsumerKey", "");
pref("extensions.pocket.site", "");
pref("extensions.pocket.showHome", false);

/******************************************************************************
 * SECTION: DOWNLOADS                                 *
******************************************************************************/

// PREF: Enforce user interaction for security by always asking where to download
// [SETTING] General>Downloads>Always ask you where to save files
// false=the user is asked what to do
pref("browser.download.useDownloadDir", false);

// PREF: disable downloads panel opening on every download
pref("browser.download.alwaysOpenPanel", false);

// PREF: Disable adding downloads to the system's "recent documents" list
pref("browser.download.manager.addToRecentDocs", false);

// PREF: enable user interaction for security by always asking how to handle new mimetypes
// [SETTING] General>Files and Applications>What should Firefox do with other files
pref("browser.download.always_ask_before_handling_new_types", true);

// PREF: autohide the downloads button
pref("browser.download.autohideButton", false);

/****************************************************************************
 * SECTION: PDF                                                             *
****************************************************************************/

// PREF: open PDFs inline (FF103+)
pref("browser.download.open_pdf_attachments_inline", true);

// PREF: PDF sidebar on load [HIDDEN] 
// 2=table of contents (if not available, will default to 1)
// 1=view pages
// -1=disabled (default)
pref("pdfjs.sidebarViewOnLoad", 2);

/****************************************************************************
 * SECTION: TAB BEHAVIOR                                                    *
****************************************************************************/

// Since we enable the search bar, make suggestions go to the bottom.
pref("browser.urlbar.showSearchSuggestionsFirst", false);

// PREF: leave Bookmarks Menu open when selecting a site
pref("browser.bookmarks.openInTabClosesMenu", false);

// PREF: Cookie Banner handling [NIGHTLY]
// [NOTE] Feature still enforces Total Cookie Protection to limit 3rd-party cookie tracking [1]
// [1] https://github.com/mozilla/cookie-banner-rules-list/issues/33#issuecomment-1318460084
// [2] https://phabricator.services.mozilla.com/D153642
// [3] https://winaero.com/make-firefox-automatically-click-on-reject-all-in-cookie-banner-consent/
// [4] https://docs.google.com/spreadsheets/d/1Nb4gVlGadyxix4i4FBDnOeT_eJp2Zcv69o-KfHtK-aA/edit#gid=0
// 2: reject banners if it is a one-click option; otherwise, fall back to the accept button to remove banner
// 1: reject banners if it is a one-click option; otherwise, keep banners on screen
// 0: disable all cookie banner handling
pref("cookiebanners.service.mode", 2);
pref("cookiebanners.service.mode.privateBrowsing", 2);

// PREF: enable global CookieBannerRules
// This is used for click rules that can handle common Consent Management Providers (CMP)
// [WARNING] Enabling this (when the cookie handling feature is enabled) may
// negatively impact site performance since it requires us to run rule-defined
// query selectors for every page
pref("cookiebanners.service.enableGlobalRules", true);

/****************************************************************************
 * SECTION: UNCATEGORIZED                                                   *
****************************************************************************/

// PREF: restore "View image info"
pref("browser.menu.showViewImageInfo", true);

// PREF: allow for more granular control of zoom levels
// Especially useful if you want to set your default zoom to a custom level
pref("toolkit.zoomManager.zoomValues", ".3,.5,.67,.8,.9,.95,1,1.1,1.2,1.3,1.4,1.5,1.6,1.7,2,2.4,3");

// PREF: wrap long lines of text when using source / debugger
pref("view_source.wrap_long_lines", true);
pref("devtools.debugger.ui.editor-wrapping", true);