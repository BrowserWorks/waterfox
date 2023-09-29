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
pref("app.support.baseURL", "https://www.waterfox.net/support/");
pref("app.update.badgeWaitTime", 0);
pref("app.update.enabled", true);
pref("app.update.notifyDuringDownload", true);
pref("app.update.promptWaitTime", 3600);
pref("app.update.url.override", "", sticky);
pref("browser.newtabpage.activity-stream.asrouter.providers.cfr", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.cfr-fxa", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.message-groups", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.snippets", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.whats-new-panel", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.useRemoteL10n", false, locked);
pref("browser.newtabpage.activity-stream.default.sites", "", locked);
pref("browser.newtabpage.activity-stream.feeds.section.highlights", true);
pref("browser.newtabpage.activity-stream.feeds.system.topstories", false, locked);
pref("browser.newtabpage.activity-stream.feeds.telemetry", false, locked);
pref("browser.newtabpage.activity-stream.improvesearch.topSiteSearchShortcuts", false);
pref("browser.newtabpage.activity-stream.section.highlights.includePocket", false, locked);
pref("browser.newtabpage.activity-stream.section.highlights.rows", 2);
pref("browser.partnerlink.attributionURL", "", locked);
pref("browser.partnerlink.campaign.topsites", "", locked);
pref("browser.search.widget.inNavBar", true);
pref("browser.tabs.pinnedIconOnly", true);
pref("browser.tabs.remote.separatedMozillaDomains", "", locked);
pref("browser.tabs.warnOnClose", true);
pref("browser.topsites.contile.enabled", false, locked);
pref("browser.topsites.contile.endpoint", "", locked);
pref("browser.topsites.useRemoteSetting", false, locked);
pref("browser.uiCustomization.state", "{\"placements\":{\"widget-overflow-fixed-list\":[],\"unified-extensions-area\":[],\"nav-bar\":[\"back-button\",\"forward-button\",\"stop-reload-button\",\"urlbar-container\",\"save-to-pocket-button\",\"search-container\",\"downloads-button\",\"fxa-toolbar-menu-button\",\"unified-extensions-button\"],\"TabsToolbar\":[\"firefox-view-button\",\"tabbrowser-tabs\",\"new-tab-button\",\"alltabs-button\"],\"PersonalToolbar\":[\"import-button\",\"personal-bookmarks\"],\"status-bar\":[\"screenshot-button\",\"fullscreen-button\",\"status-text\"]},\"seen\":[\"developer-button\"],\"dirtyAreaCache\":[\"nav-bar\",\"status-bar\",\"PersonalToolbar\",\"TabsToolbar\"],\"currentVersion\":19,\"newElementCount\":3}");
#ifdef UNIX_BUT_NOT_MAC
pref("browser.urlbar.clickSelectsAll", false);
#else
pref("browser.urlbar.clickSelectsAll", true);
#endif
#ifdef UNIX_BUT_NOT_MAC
pref("browser.urlbar.doubleClickSelectsAll", true);
#else
pref("browser.urlbar.doubleClickSelectsAll", false);
#endif
pref("doh-rollout.enabled", false, locked);
pref("doh-rollout.disable-heuristics", true, locked);
pref("dom.security.unexpected_system_load_telemetry_enabled", false, locked);
pref("extensions.experiments.enabled", true);
pref("extensions.install_origins.enabled", true);
pref("extensions.systemAddon.update.url", "https://aus1.waterfox.net/update/SystemAddons/%DISPLAY_VERSION%/%OS%_%ARCH%/%CHANNEL%/%OS_VERSION%/%SYSTEM_CAPABILITIES%/%DISTRIBUTION%/%DISTRIBUTION_VERSION%/update.xml");
pref("extensions.webcompat.enable_shims", true);
pref("extensions.webextensions.restrictedDomains", "accounts-static.cdn.mozilla.net,accounts.firefox.com,addons.cdn.mozilla.net,api.accounts.firefox.com,content.cdn.mozilla.net,discovery.addons.mozilla.org,install.mozilla.org,oauth.accounts.firefox.com,profile.accounts.firefox.com,support.mozilla.org,sync.services.mozilla.com");
pref("image.jxl.enabled", true);
pref("intl.multilingual.downloadEnabled", false, locked);
pref("layout.css.backdrop-filter.enabled", true);
pref("layout.css.color-mix.enabled", true);
pref("messaging-system.rsexperimentloader.enabled", false, locked);
pref("network.trr.confirmation_telemetry_enabled", false, locked);
pref("network.trr.max-fails", 5);
pref("network.trr.mode", 2);
pref("network.trr.ohttp.config_uri", "https://dooh.cloudflare-dns.com/.well-known/doohconfig");
pref("network.trr.ohttp.uri", "https://dooh.cloudflare-dns.com/dns-query");
pref("network.trr.ohttp.relay_uri", "https://dooh.waterfox.net/");
pref("network.trr.request_timeout_mode_trronly_ms", 1500);
pref("network.trr.use_ohttp", true);
pref("security.app_menu.recordEventTelemetry", false, locked);
pref("security.certerrors.mitm.priming.enabled", false, locked);
pref("security.certerrors.recordEventTelemetry", false, locked);
pref("security.family_safety.mode", 0);
pref("security.identitypopup.recordEventTelemetry", false, locked);
pref("security.protectionspopup.recordEventTelemetry", false, locked);
pref("signon.firefoxRelay.feature", "unavailable");
pref("signon.management.page.mobileAndroidURL", "", locked);
pref("signon.management.page.mobileAppleURL", "", locked);
pref("signon.recipes.remoteRecipes.enabled", false, locked);
pref("svg.context-properties.content.enabled", true);
pref("toolkit.legacyUserProfileCustomizations.stylesheets", true, locked);

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
