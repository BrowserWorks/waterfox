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

# Default Preferences
# Waterfox
# All customised preferences should live here

pref("accessibility.support.url", "https://www.waterfox.net/support/accessibility-services");
pref("app.support.baseURL", "https://www.waterfox.net/support/%OS%/");
pref("app.update.badgeWaitTime", 0);
pref("app.update.enabled", true);
pref("app.update.notifyDuringDownload", true);
pref("app.update.promptWaitTime", 3600);
pref("app.update.url.override", "", sticky);
pref("browser.download.autohideButton", false);
pref("browser.download.panel.shown", true);
pref("browser.newtabpage.activity-stream.asrouter.providers.cfr", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.cfr-fxa", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.message-groups", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.snippets", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.whats-new-panel", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.useRemoteL10n", false, locked);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false, locked);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false, locked);
pref("browser.newtabpage.activity-stream.debug", false, locked);
pref("browser.newtabpage.activity-stream.default.sites", "", locked);
pref("browser.newtabpage.activity-stream.discoverystream.config", "{}");
pref("browser.newtabpage.activity-stream.discoverystream.enabled", false, locked);
pref("browser.newtabpage.activity-stream.discoverystream.hardcoded-basic-layout", false, locked);
pref("browser.newtabpage.activity-stream.discoverystream.personalization.modelKeys", "", locked);
pref("browser.newtabpage.activity-stream.discoverystream.recs.personalized", false, locked);
pref("browser.newtabpage.activity-stream.discoverystream.spocs-endpoint", "", locked);
pref("browser.newtabpage.activity-stream.discoverystream.spocs-endpoint-query", "", locked);
pref("browser.newtabpage.activity-stream.feeds.section.highlights", true);
pref("browser.newtabpage.activity-stream.feeds.snippets", false, locked);
pref("browser.newtabpage.activity-stream.feeds.section.topstories", false, locked);
pref("browser.newtabpage.activity-stream.feeds.section.topstories", false, locked);
pref("browser.newtabpage.activity-stream.feeds.section.topstories.options", "{}", locked);
pref("browser.newtabpage.activity-stream.feeds.system.topstories", false, locked);
pref("browser.newtabpage.activity-stream.feeds.telemetry", false, locked);
pref("browser.newtabpage.activity-stream.improvesearch.handoffToAwesomebar", false);
pref("browser.newtabpage.activity-stream.improvesearch.topSiteSearchShortcuts", false);
pref("browser.newtabpage.activity-stream.section.highlights.includePocket", false, locked);
pref("browser.newtabpage.activity-stream.section.highlights.rows", 2);
pref("browser.newtabpage.activity-stream.showSponsored", false, locked);
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false, locked);
pref("browser.newtabpage.activity-stream.telemetry", false, locked);
pref("browser.newtabpage.activity-stream.telemetry.structuredIngestion.endpoint", "", locked);
pref("browser.newtabpage.activity-stream.telemetry.ut.events", false, locked);
pref("browser.partnerlink.attributionURL", "", locked);
pref("browser.partnerlink.campaign.topsites", "", locked);
pref("browser.ping-centre.telemetry", false, locked);
pref("browser.search.separatePrivateDefault", true);
pref("browser.search.separatePrivateDefault.ui.enabled", true);
pref("browser.send_pings", false, locked);
pref("browser.tabs.pinnedIconOnly", true);
pref("browser.tabs.remote.separatedMozillaDomains", "", locked);
pref("browser.topsites.contile.enabled", false, locked);
pref("browser.topsites.contile.endpoint", "", locked);
pref("browser.topsites.useRemoteSetting", false, locked);
pref("browser.uiCustomization.state", "{\"placements\":{\"widget-overflow-fixed-list\":[],\"nav-bar\":[\"back-button\",\"forward-button\",\"stop-reload-button\",\"urlbar-container\",\"save-to-pocket-button\",\"downloads-button\",\"library-button\",\"fxa-toolbar-menu-button\"],\"TabsToolbar\":[\"tabbrowser-tabs\",\"new-tab-button\",\"alltabs-button\"],\"PersonalToolbar\":[\"import-button\",\"personal-bookmarks\"]},\"seen\":[\"profiler-button\",\"developer-button\"],\"dirtyAreaCache\":[\"nav-bar\",\"PersonalToolbar\"],\"currentVersion\":17,\"newElementCount\":3}");
pref("browser.urlbar.dnsResolveSingleWordsAfterSearch", 0, locked);
pref("browser.urlbar.eventTelemetry.enabled", false, locked);
pref("browser.urlbar.showSearchSuggestionsFirst", false);
pref("browser.urlbar.speculativeConnect.enabled", false);
pref("browser.urlbar.trimURLs", false);
pref("browser.xul.error_pages.expert_bad_cert", true);
pref("corroborator.enabled", false, locked);
pref("datareporting.healthreport.uploadEnabled", false, locked);
pref("datareporting.policy.dataSubmissionEnabled", false, locked);
pref("devtools.debugger.chrome-debugging-host", "127.0.0.1");
pref("devtools.webide.autoinstallADBExtension", false);
pref("dom.security.unexpected_system_load_telemetry_enabled", false, locked);
pref("extensions.allowPrivateBrowsingByDefault", true);
pref("extensions.experiments.enabled", true);
pref("extensions.getAddons.cache.enabled", false); // https://blog.mozilla.org/addons/how-to-opt-out-of-add-on-metadata-updates/
pref("extensions.getAddons.showPane", false, locked);
pref("extensions.htmlaboutaddons.recommendations.enabled", false, locked);
pref("extensions.install_origins.enabled", true);
pref("extensions.pocket.api", "");
pref("extensions.pocket.enabled", false);
pref("extensions.pocket.oAuthConsumerKey", "");
pref("extensions.pocket.showHome", false);
pref("geo.provider.network.url", "");
pref("image.avif.enabled", true);
pref("image.jxl.enabled", true);
pref("intl.multilingual.downloadEnabled", false, locked);
pref("layout.css.backdrop-filter.enabled", true);
pref("layout.css.color-mix.enabled", true);
pref("layout.css.prefers-color-scheme.content-override", 3);
pref("layout.forms.input-type-search.enabled", true);
pref("layout.forms.reveal-password-button.enabled", true);
pref("media.eme.enabled", false);
pref("media.gmp-manager.url", "data:application/json,", locked);
pref("messaging-system.rsexperimentloader.enabled", false, locked);
pref("network.captive-portal-service.enabled", false);
pref("network.connectivity-service.enabled", false);
pref("network.http.connection-retry-timeout", 0);
pref("network.http.max-persistent-connections-per-proxy", 256);
pref("network.manage-offline-status", false);
pref("network.trr.confirmation_telemetry_enabled", false, locked);
pref("network.trr.exclude-etc-hosts", false, locked);
pref("network.trr.resolvers", "", locked);
pref("plugin.state.flash", 0, locked); // Disable for defense-in-depth
pref("privacy.resistFingerprinting.block_mozAddonManager", true); // This is set so that UA overrides work on AMO.
pref("privacy.trackingprotection.origin_telemetry.enabled", false, locked);
pref("privacy.userContext.enabled", true);
pref("privacy.userContext.ui.enabled", true);
pref("security.app_menu.recordEventTelemetry", false, locked);
pref("security.certerrors.mitm.priming.enabled", false, locked);
pref("security.certerrors.recordEventTelemetry", false, locked);
pref("security.family_safety.mode", 0, locked);
pref("security.identitypopup.recordEventTelemetry", false, locked);
pref("security.insecure_connection_text.enabled", true);
pref("security.pki.crlite_mode", 0, locked);
pref("security.protectionspopup.recordEventTelemetry", false, locked);
pref("security.ssl.enable_false_start", true);
pref("security.ssl.errorReporting.enabled", false, locked);
pref("services.settings.server", "data:application/json,", locked); // 24H
pref("services.sync.prefs.sync.app.shield.optoutstudies.enabled", false, locked);
pref("services.sync.prefs.sync.browser.crashReports.unsubmittedCheck.autoSubmit2", false, locked);
pref("services.sync.prefs.sync.browser.discovery.enabled", false, locked);
pref("services.sync.prefs.sync.browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false, locked);
pref("services.sync.prefs.sync.browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false, locked);
pref("services.sync.prefs.sync.browser.newtabpage.activity-stream.feeds.section.topstories", false, locked);
pref("services.sync.prefs.sync.browser.newtabpage.activity-stream.section.topstories.rows", false, locked);
pref("services.sync.prefs.sync.browser.newtabpage.activity-stream.feeds.snippets", false, locked);
pref("services.sync.prefs.sync.browser.newtabpage.activity-stream.showSponsored", false, locked);
pref("services.sync.prefs.sync.browser.newtabpage.activity-stream.showSponsoredTopSites", false, locked);
pref("services.sync.telemetry.maxPayloadCount", "0", locked);
pref("services.sync.telemetry.submissionInterval", "0", locked);
pref("signon.management.page.mobileAndroidURL", "", locked);
pref("signon.management.page.mobileAppleURL", "", locked);
pref("signon.recipes.remoteRecipesEnabled", false, locked);
pref("svg.context-properties.content.enabled", true);
pref("telemetry.origin_telemetry_test_mode.enabled", false, locked);
pref("toolkit.legacyUserProfileCustomizations.stylesheets", true, locked);
pref("toolkit.telemetry.archive.enabled", false, locked);
pref("toolkit.telemetry.bhrPing.enabled", false, locked);
pref("toolkit.telemetry.enabled", false, locked);
pref("toolkit.telemetry.firstShutdownPing.enabled", false, locked);
pref("toolkit.telemetry.geckoview.streaming", false, locked);
pref("toolkit.telemetry.newProfilePing.enabled", false, locked);
pref("toolkit.telemetry.pioneer-new-studies-available", false, locked);
pref("toolkit.telemetry.reportingpolicy.firstRun", false, locked);
pref("toolkit.telemetry.server", "", locked);
pref("toolkit.telemetry.shutdownPingSender.enabled", false, locked);
pref("toolkit.telemetry.shutdownPingSender.enabledFirstSession", false, locked);
pref("toolkit.telemetry.testing.overrideProductsCheck", false, locked);
pref("toolkit.telemetry.unified", false, locked);
pref("toolkit.telemetry.updatePing.enabled", false, locked); // Make sure updater telemetry is disabled; see #25909.
pref("trailhead.firstrun.branches", "", locked);
pref("xpinstall.signatures.required", false);

// ** Theme Related Options ****************************************************
// == Theme Distribution Settings ==============================================
pref("userChrome.theme.enable",                   true); // Original, Photon
pref("userChrome.tab.connect_to_window",          true); // Original, Photon
pref("userChrome.tab.color_like_toolbar",         true); // Original, Photon

// pref("userChrome.tab.lepton_like_padding",     true); // Original
pref("userChrome.tab.photon_like_padding",        true); // Photon

pref("userChrome.tab.static_separator",           true); // Photon
// pref("userChrome.tab.static_separator.selected_accent", true); // Just option

pref("userChrome.tab.newtab_button_smaller",      true); // Photon

pref("userChrome.icon.panel_photon",              true); // Photon

// Photon Only
pref("userChrome.tab.photon_like_contextline",    true);
pref("userChrome.rounding.square_tab",            true);

// == Theme Default Settings ===================================================
// -- User Chrome --------------------------------------------------------------
pref("userChrome.compatibility.accent_color", true);
pref("userChrome.compatibility.theme",       true);
pref("userChrome.compatibility.os",          true);

pref("userChrome.theme.built_in_contrast",   true);
pref("userChrome.theme.system_default",      true);
pref("userChrome.theme.proton_color",        true);
pref("userChrome.theme.proton_chrome",       true); // Need proton_color
pref("userChrome.theme.fully_color",         true); // Need proton_color
pref("userChrome.theme.fully_dark",          true); // Need proton_color

pref("userChrome.decoration.cursor",         true);
pref("userChrome.decoration.field_border",   true);
pref("userChrome.decoration.download_panel", true);
pref("userChrome.decoration.animate",        true);

pref("userChrome.padding.tabbar_width",      true);
pref("userChrome.padding.tabbar_height",     true);
pref("userChrome.padding.toolbar_button",    true);
pref("userChrome.padding.navbar_width",      true);
pref("userChrome.padding.urlbar",            true);
pref("userChrome.padding.bookmarkbar",       true);
pref("userChrome.padding.infobar",           true);
pref("userChrome.padding.menu",              true);
pref("userChrome.padding.bookmark_menu",     true);
pref("userChrome.padding.global_menubar",    true);
pref("userChrome.padding.panel",             true);
pref("userChrome.padding.popup_panel",       true);

pref("userChrome.tab.multi_selected",        true);
pref("userChrome.tab.unloaded",              true);
pref("userChrome.tab.letters_cleary",        true);
pref("userChrome.tab.close_button_at_hover", true);
pref("userChrome.tab.sound_hide_label",      true);
pref("userChrome.tab.sound_with_favicons",   true);
pref("userChrome.tab.pip",                   true);
pref("userChrome.tab.container",             true);
pref("userChrome.tab.crashed",               true);

pref("userChrome.fullscreen.overlap",        true);
pref("userChrome.fullscreen.show_bookmarkbar", true);

pref("userChrome.icon.library",              true);
pref("userChrome.icon.panel",                true);
pref("userChrome.icon.menu",                 true);
pref("userChrome.icon.context_menu",         true);
pref("userChrome.icon.global_menu",          true);
pref("userChrome.icon.global_menubar",       true);

// -- User Content -------------------------------------------------------------
pref("userContent.player.ui",             true);
pref("userContent.player.icon",           true);
pref("userContent.player.noaudio",        true);
pref("userContent.player.size",           true);
pref("userContent.player.click_to_play",  true);
pref("userContent.player.animate",        true);

pref("userContent.newTab.field_border",   true);
pref("userContent.newTab.full_icon",      true);
pref("userContent.newTab.animate",        true);
pref("userContent.newTab.pocket_to_last", true);
pref("userContent.newTab.searchbar",      true);

pref("userContent.page.illustration",     true);
pref("userContent.page.proton_color",     true);
pref("userContent.page.dark_mode",        true); // Need proton_color
pref("userContent.page.proton",           true); // Need proton_color

// -- Hide promos -------------------------------------------------------------
pref("browser.preferences.moreFromMozilla", false, locked);
pref("browser.vpn_promo.enabled", false, locked);
pref("browser.promo.focus.enabled", false, locked);
pref("browser.contentblocking.report.lockwise.enabled", false, locked);
pref("browser.contentblocking.report.monitor.enabled", false, locked);
pref("browser.contentblocking.report.show_mobile_app", false, locked);

// ** Useful Options ***********************************************************
// Integrated calculator at urlbar
pref("browser.urlbar.suggest.calculator", true);

// Extensibles prefs
pref("browser.tabs.duplicateTab", true);
pref("browser.tabs.copyurl", true);
pref("browser.tabs.copyallurls", false);
pref("browser.tabs.copyurl.activetab", false);
pref("browser.tabs.unloadTab", false);
pref("browser.restart_menu.showpanelmenubtn", true);
pref("browser.restart_menu.purgecache", false);
pref("browser.restart_menu.requireconfirm", true);
pref("browser.statusbar.appendStatusText", true);
pref("browser.statusbar.enabled", false);
pref("browser.tabs.toolbarposition", "topabove");
pref("browser.bookmarks.toolbarposition", "top");
