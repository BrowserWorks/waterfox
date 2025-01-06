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

/****************************************************************************
 * SECTION: TRACKING PROTECTION                                             *
****************************************************************************/

// PREF: allow embedded social content
// Used for social media embeds like tweets, instagram posts, etc.
pref("urlclassifier.trackingSkipURLs", "*.reddit.com, *.twitter.com, *.twimg.com, *.tiktok.com");
pref("urlclassifier.features.socialtracking.skipURLs", "*.instagram.com, *.twitter.com, *.twimg.com");

// PREF: enhanced tracking protection
pref("browser.contentblocking.category", "strict");

// PREF: lower the priority of network loads for resources on the tracking protection list
pref("privacy.trackingprotection.lower_network_priority", true);

// PREF: SameSite Cookies
pref("network.cookie.sameSite.noneRequiresSecure", true);

// PREF: battery status tracking
pref("dom.battery.enabled", false);

// PREF: disable UITour backend
pref("browser.uitour.enabled", false);
pref("browser.uitour.url", "");

// PREF: enable Global Privacy Control (GPC)
pref("privacy.globalprivacycontrol.enabled", true);
pref("privacy.globalprivacycontrol.functionality.enabled", true);

/****************************************************************************
 * SECTION: OSCP & CERTS                                                    *
****************************************************************************/

// PREF: disable OCSP fetching
pref("security.OCSP.enabled", 0);

// PREF: enable CRLite
pref("security.remote_settings.crlite_filters.enabled", true);
pref("security.pki.crlite_mode", 2);

// PREF: enable strict pinning
pref("security.cert_pinning.enforcement_level", 1);

/****************************************************************************
 * SECTION: SSL / TLS                                                       *
****************************************************************************/

// PREF: display warning on padlock for broken security
pref("security.ssl.treat_unsafe_negotiation_as_broken", true);

// PREF: display advanced information on Insecure Connection warning pages
pref("browser.xul.error_pages.expert_bad_cert", true);

// PREF: disable TLS 1.3 0-RTT
pref("security.tls.enable_0rtt_data", false);

/****************************************************************************
 * SECTION: DISK AVOIDANCE                                                  *
****************************************************************************/

// PREF: prevent media cache from writing to disk in Private Browsing
pref("browser.privatebrowsing.forceMediaMemoryCache", true);

/****************************************************************************
 * SECTION: SHUTDOWN & SANITIZING                                           *
****************************************************************************/

// PREF: set History section to show all options
pref("privacy.history.custom", true);

/****************************************************************************
 * SECTION: HEADERS / REFERERS                                             *
****************************************************************************/

// PREF: control cross-origin referer
pref("network.http.referer.XOriginTrimmingPolicy", 2);

// PREF: default Referrer Policy for trackers
pref("network.http.referer.defaultPolicy.trackers", 1);
pref("network.http.referer.defaultPolicy.trackers.pbmode", 1);

/****************************************************************************
 * SECTION: SEARCH / URL BAR                                               *
****************************************************************************/

// PREF: disable trimming certain parts of the URL
pref("browser.urlbar.trimURLs", false);

// PREF: disable search terms
pref("browser.urlbar.showSearchTerms.enabled", false);

// PREF: enable separate search engine for Private Windows
pref("browser.search.separatePrivateDefault.ui.enabled", true);
pref("browser.search.separatePrivateDefault", true);

// PREF: enable option to add custom search
pref("browser.urlbar.update2.engineAliasRefresh", true);

// PREF: disable Firefox Suggest
pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);

// PREF: display "Not Secure" text on HTTP sites
pref("security.insecure_connection_text.enabled", true);
pref("security.insecure_connection_text.pbmode.enabled", true);

/****************************************************************************
 * SECTION: HTTPS-FIRST POLICY                                             *
****************************************************************************/

pref("dom.security.https_first", true);

/****************************************************************************
 * SECTION: HTTPS-ONLY MODE                                                *
****************************************************************************/

pref("dom.security.https_only_mode_error_page_user_suggestions", true);
pref("dom.security.https_only_mode.upgrade_local", false);

/****************************************************************************
 * SECTION: PASSWORDS                                                      *
****************************************************************************/

pref("editor.truncate_user_pastes", false);
pref("layout.forms.reveal-password-button.enabled", true);

/****************************************************************************
 * SECTION: MIXED CONTENT + CROSS-SITE                                     *
****************************************************************************/

pref("network.auth.subresource-http-auth-allow", 1);
pref("security.mixed_content.block_display_content", true);
pref("security.mixed_content.upgrade_display_content", true);
pref("pdfjs.enableScripting", false);
pref("extensions.postDownloadThirdPartyPrompt", false);

/****************************************************************************
 * SECTION: CONTAINERS                                                      *
****************************************************************************/

// PREF: enable Container Tabs and UI
pref("privacy.userContext.ui.enabled", true);
pref("privacy.userContext.enabled", true);

// PREF: set behavior on "+ Tab" button to display container menu on left click
pref("privacy.userContext.newTabContainerOnLeftClick.enabled", false);

/****************************************************************************
 * SECTION: WEBRTC                                                         *
****************************************************************************/

// PREF: enable WebRTC Global Mute Toggles
pref("privacy.webrtc.globalMuteToggles", true);

// PREF: force WebRTC inside the proxy
pref("media.peerconnection.ice.proxy_only_if_behind_proxy", true);

// PREF: force a single network interface for ICE candidates
pref("media.peerconnection.ice.default_address_only", true);

/****************************************************************************
 * SECTION: MOZILLA                                                        *
****************************************************************************/

// PREF: disable Firefox View
pref("browser.tabs.firefox-view", false);
pref("browser.firefox-view.feature-tour", "{\"screen\":\"\",\"complete\":true}");

// PREF: use Mozilla geolocation service instead of Google when geolocation is enabled
pref("geo.provider.network.url", "");

// PREF: disable mozAddonManager Web API
pref("privacy.resistFingerprinting.block_mozAddonManager", true);

// PREF: Check bundled omni JARs for corruption
pref("corroborator.enabled", false);

/****************************************************************************
 * SECTION: SAFE BROWSING                                                  *
****************************************************************************/

// PREF: disable remote Safe Browsing checks
pref("browser.safebrowsing.downloads.remote.enabled", false);
pref("browser.safebrowsing.downloads.remote.url", "");
pref("browser.safebrowsing.provider.google4.gethashURL", "");
pref("browser.safebrowsing.provider.google4.updateURL", "");
pref("browser.safebrowsing.provider.google.gethashURL", "");
pref("browser.safebrowsing.provider.google.updateURL", "");

// PREF: disable Safe Browsing downloads
pref("browser.safebrowsing.downloads.enabled", false);

/****************************************************************************
 * SECTION: MISCELLANEOUS                                                  *
****************************************************************************/

// PREF: enforce Punycode for Internationalized Domain Names
pref("network.IDN_show_punycode", true);

// PREF: remove webchannel whitelist
pref("webchannel.allowObject.urlWhitelist", "");

// PREF: disable signing requirement for extensions
pref("xpinstall.signatures.required", false, locked);

// PREF: disable Quarantined Domains
pref("extensions.quarantinedDomains.enabled", false, locked);

// PREF: disable personalized extension recommendations
pref("browser.discovery.enabled", false, locked);

// PREF: disable extension abuse reporting
pref("extensions.abuseReport.enabled", false);

/****************************************************************************
 * SECTION: TELEMETRY                                                      *
****************************************************************************/

// PREF: disable all telemetry
pref("toolkit.telemetry.unified", false, locked);
pref("toolkit.telemetry.enabled", false, locked);
pref("toolkit.telemetry.server", "data:,", locked);
pref("toolkit.telemetry.archive.enabled", false, locked);
pref("toolkit.telemetry.newProfilePing.enabled", false, locked);
pref("toolkit.telemetry.shutdownPingSender.enabled", false, locked);
pref("toolkit.telemetry.updatePing.enabled", false, locked);
pref("toolkit.telemetry.bhrPing.enabled", false, locked);
pref("toolkit.telemetry.firstShutdownPing.enabled", false, locked);
pref("toolkit.telemetry.dap_enabled", false, locked);

// PREF: disable Telemetry Coverage
pref("toolkit.telemetry.coverage.opt-out", true, locked);
pref("toolkit.coverage.opt-out", true, locked);
pref("toolkit.coverage.endpoint.base", "", locked);

// PREF: disable Health Reports
pref("datareporting.healthreport.uploadEnabled", false, locked);

// PREF: disable new data submission
pref("datareporting.policy.dataSubmissionEnabled", false, locked);

// PREF: disable Studies
pref("app.shield.optoutstudies.enabled", false, locked);

// PREF: disable Normandy/Shield
pref("app.normandy.enabled", false, locked);
pref("app.normandy.api_url", "", locked);

// PREF: disable crash reports
pref("breakpad.reportURL", "", locked);
pref("browser.tabs.crashReporting.sendReport", false, locked);
pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false, locked);

// PREF: disable Firefox Home telemetry
pref("browser.newtabpage.activity-stream.feeds.telemetry", false, locked);
pref("browser.newtabpage.activity-stream.telemetry", false, locked);
