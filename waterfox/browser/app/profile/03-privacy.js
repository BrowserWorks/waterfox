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
 * SECTION: TRACKING PROTECTION                                             *
****************************************************************************/

// PREF: allow embedded tweets, Instagram and Reddit posts, and TikTok embeds
// [TEST - reddit embed] https://www.pcgamer.com/amazing-halo-infinite-bugs-are-already-rolling-in/
// [TEST - instagram embed] https://www.ndtv.com/entertainment/bharti-singh-and-husband-haarsh-limbachiyaa-announce-pregnancy-see-trending-post-2646359
// [TEST - tweet embed] https://www.newsweek.com/cryptic-tweet-britney-spears-shows-elton-john-collab-may-date-back-2015-1728036
// [TEST - tiktok embed] https://www.vulture.com/article/snl-adds-four-new-cast-members-for-season-48.html
// [1] https://www.reddit.com/r/firefox/comments/l79nxy/firefox_dev_is_ignoring_social_tracking_preference/gl84ukk
// [2] https://www.reddit.com/r/firefox/comments/pvds9m/reddit_embeds_not_loading/
pref("urlclassifier.trackingSkipURLs", "*.reddit.com, *.twitter.com, *.twimg.com, *.tiktok.com"); // MANUAL
pref("urlclassifier.features.socialtracking.skipURLs", "*.instagram.com, *.twitter.com, *.twimg.com"); // MANUAL

// PREF: lower the priority of network loads for resources on the tracking protection list [NIGHTLY]
// [1] https://github.com/arkenfox/user.js/issues/102#issuecomment-298413904
pref("privacy.trackingprotection.lower_network_priority", true);

// PREF: SameSite Cookies
// [1] https://hacks.mozilla.org/2020/08/changes-to-samesite-cookie-behavior/
// [2] https://web.dev/samesite-cookies-explained/
pref("network.cookie.sameSite.noneRequiresSecure", true);

// PREF: battery status tracking
// [NOTE] Pref remains, but API is depreciated.
// [1] https://developer.mozilla.org/en-US/docs/Web/API/Battery_Status_API#browser_compatibility
pref("dom.battery.enabled", false);

// PREF: disable UITour backend so there is no chance that a remote page can use it
pref("browser.uitour.enabled", false);
pref("browser.uitour.url", "");

// PREF: reset remote debugging to disabled
// https://gitlab.torproject.org/tpo/applications/tor-browser/-/issues/16222
pref("devtools.debugger.remote-enabled", false); // DEFAULT

// PREF: enable Global Privacy Control (GPC) [NIGHTLY]
// Honored by many highly ranked sites [2].
// [TEST] https://global-privacy-control.glitch.me/
// [1] https://globalprivacycontrol.org/press-release/20201007.html
// [2] https://github.com/arkenfox/user.js/issues/1542#issuecomment-1279823954
// [3] https://blog.mozilla.org/netpolicy/2021/10/28/implementing-global-privacy-control/
// [4] https://help.duckduckgo.com/duckduckgo-help-pages/privacy/gpc/
// [5] https://brave.com/web-standards-at-brave/4-global-privacy-control/
// [6] https://www.eff.org/gpc-privacy-badger
// [7] https://www.eff.org/issues/do-not-track
pref("privacy.globalprivacycontrol.enabled", true);
pref("privacy.globalprivacycontrol.functionality.enabled", true);

/****************************************************************************
 * SECTION: OSCP & CERTS / HPKP (HTTP Public Key Pinning)                   *
****************************************************************************/

// Online Certificate Status Protocol (OCSP)
// OCSP leaks your IP and domains you visit to the CA when OCSP Stapling is not available on visited host.
// OCSP is vulnerable to replay attacks when nonce is not configured on the OCSP responder.
// Short-lived certificates are not checked for revocation (security.pki.cert_short_lifetime_in_days, default:10).
// Firefox falls back on plain OCSP when must-staple is not configured on the host certificate.
// [1] https://scotthelme.co.uk/revocation-is-broken/
// [2] https://blog.mozilla.org/security/2013/07/29/ocsp-stapling-in-firefox/
// [3] https://github.com/arkenfox/user.js/issues/1576#issuecomment-1304590235

// PREF: disable OCSP fetching to confirm current validity of certificates
// OCSP (non-stapled) leaks information about the sites you visit to the CA (cert authority).
// It's a trade-off between security (checking) and privacy (leaking info to the CA).
// Unlike Chrome, Firefox’s default settings also query OCSP responders to confirm the validity
// of SSL/TLS certificates. However, because OCSP query failures are so common, Firefox
// (like other browsers) implements a “soft-fail” policy.
// [NOTE] This pref only controls OCSP fetching and does not affect OCSP stapling
// [SETTING] Privacy & Security>Security>Certificates>Query OCSP responder servers...
// [1] https://en.wikipedia.org/wiki/Ocsp
// [2] https://www.ssl.com/blogs/how-do-browsers-handle-revoked-ssl-tls-certificates/#ftoc-heading-3
// 0=disabled, 1=enabled (default), 2=enabled for EV certificates only
pref("security.OCSP.enabled", 0); // [DEFAULT: 1]
      
// PREF: enable CRLite
// CRLite covers valid certs, and it doesn't fall back to OCSP in mode 2 [FF84+]
// 0 = disabled
// 1 = consult CRLite but only collect telemetry
// 2 = consult CRLite and enforce both "Revoked" and "Not Revoked" results
// 3 = consult CRLite and enforce "Not Revoked" results, but defer to OCSP for "Revoked" [FF99+, default FF100+]
// [1] https://bugzilla.mozilla.org/buglist.cgi?bug_id=1429800,1670985,1753071
// [2] https://blog.mozilla.org/security/tag/crlite/
pref("security.remote_settings.crlite_filters.enabled", true);
pref("security.pki.crlite_mode", 2);

// PREF: enable strict pinning
// MOZILLA_PKIX_ERROR_KEY_PINNING_FAILURE
// If you rely on an AV (antivirus) to protect your web browsing
// by inspecting ALL your web traffic, then leave at current default=1
// PKP (Public Key Pinning) 0=disabled, 1=allow user MiTM (such as your antivirus), 2=strict
// [1] https://gitlab.torproject.org/tpo/applications/tor-browser/-/issues/16206
pref("security.cert_pinning.enforcement_level", 1);

/****************************************************************************
 * SECTION: SSL (Secure Sockets Layer) / TLS (Transport Layer Security)    *
****************************************************************************/

// PREF: display warning on the padlock for "broken security"
// Bug: warning padlock not indicated for subresources on a secure page! [2]
// [TEST] (January 2022) https://www.unibs.it/it
// [1] https://wiki.mozilla.org/Security:Renegotiation
// [2] https://bugzilla.mozilla.org/1353705
pref("security.ssl.treat_unsafe_negotiation_as_broken", true);

// PREF: display advanced information on Insecure Connection warning pages
// [TEST] https://expired.badssl.com/
pref("browser.xul.error_pages.expert_bad_cert", true);

// PREF: disable TLS 1.3 0-RTT (round-trip time) [FF51+]
// This data is not forward secret, as it is encrypted solely under keys derived using
// the offered PSK. There are no guarantees of non-replay between connections.
// [1] https://github.com/tlswg/tls13-spec/issues/1001
// [2] https://www.rfc-editor.org/rfc/rfc9001.html#name-replay-attacks-with-0-rtt
// [3] https://blog.cloudflare.com/tls-1-3-overview-and-q-and-a/
pref("security.tls.enable_0rtt_data", false); // disable 0 RTT to improve tls 1.3 security

/****************************************************************************
 * SECTION: DISK AVOIDANCE                                                  *
****************************************************************************/

// PREF: prevent media cache from writing to disk in Private Browsing
// [NOTE] MSE (Media Source Extensions) are already stored in-memory in PB
pref("browser.privatebrowsing.forceMediaMemoryCache", true);

/******************************************************************************
 * SECTION: SHUTDOWN & SANITIZING                           *
******************************************************************************/

// PREF: set History section to show all options
// Settings>Privacy>History>Use custom settings for history
// [INFOGRAPHIC] https://bugzilla.mozilla.org/show_bug.cgi?id=1765533#c1
pref("privacy.history.custom", true);

/******************************************************************************
 * SECTION: SPECULATIVE CONNECTIONS                           *
******************************************************************************/

// Disable DNS prefetch, to put less load on infrastructure.
pref("network.dns.disablePrefetch", true);
pref("network.dns.disablePrefetchFromHTTPS", true);

// PREF: early hints
// [1] https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/103
pref("network.early-hints.enabled", true);
pref("network.early-hints.preconnect.enabled", true);
pref("network.early-hints.preconnect.max_connections", 10);

// PREF: Network Predictor (NP)
// Keeps track of components that were loaded during page visits so that the browser knows next time
// which resources to request from the server: It uses a local file to remember which resources were
// needed when the user visits a webpage (such as image.jpg and script.js), so that the next time the
// user prepares to go to that webpage (upon navigation? URL bar? mouseover?), this history can be used
// to predict what resources will be needed rather than wait for the document to link those resources.
// NP only performs pre-connect, not prefetch, by default, including DNS pre-resolve and TCP preconnect
// (which includes SSL handshake). No data is actually sent to the site until a user actively clicks
// a link. However, NP is still opening TCP connections and doing SSL handshakes, so there is still
// information leakage about your browsing patterns. This isn't desirable from a privacy perspective.
// [NOTE] Disabling DNS prefetching disables the DNS prefetching behavior of NP.
// [1] https://wiki.mozilla.org/Privacy/Reviews/Necko
// [2] https://www.ghacks.net/2014/05/11/seer-disable-firefox/
// [3] https://github.com/dillbyrne/random-agent-spoofer/issues/238#issuecomment-110214518
// [4] https://www.igvita.com/posa/high-performance-networking-in-google-chrome/#predictor
pref("network.predictor.enabled", false);

// PREF: NP fetches resources on the page ahead of time, to accelerate rendering of the page
// Performs both pre-connect and prefetch
pref("network.predictor.enable-prefetch", false);

/******************************************************************************
 * SECTION: SEARCH / URL BAR                              *
******************************************************************************/

// PREF: disable trimming certain parts of the URL
// [1] https://udn.realityripple.com/docs/Mozilla/Preferences/Preference_reference/browser.urlbar.trimURLs
// [2] https://winaero.com/firefox-75-strips-https-and-www-from-address-bar-results/
pref("browser.urlbar.trimURLs", false);

// PREF: disable search terms [FF110+]
// [SETTING] Search>Search Bar>Use the address bar for search and navigation>Show search terms instead of URL...
//pref("browser.urlbar.showSearchTerms.enabled", false);

// PREF: enable seperate search engine for Private Windows
// [SETTINGS] Preferences>Search>Default Search Engine>"Use this search engine in Private Windows"
pref("browser.search.separatePrivateDefault.ui.enabled", true);
// [SETTINGS] "Choose a different default search engine for Private Windows only"
pref("browser.search.separatePrivateDefault", true); // DEFAULT

// PREF: enable option to add custom search
// [SETTINGS] Settings -> Search -> Search Shortcuts -> Add
// [EXAMPLE] https://search.brave.com/search?q=%s
// [EXAMPLE] https://lite.duckduckgo.com/lite/?q=%s
// [1] https://reddit.com/r/firefox/comments/xkzswb/adding_firefox_search_engine_manually/
pref("browser.urlbar.update2.engineAliasRefresh", true); // HIDDEN

// PREF: disable Firefox Suggest
// [1] https://github.com/arkenfox/user.js/issues/1257
pref("browser.urlbar.quicksuggest.enabled", false); // controls whether the UI is shown
pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);

// PREF: display "Not Secure" text on HTTP sites
// Needed with HTTPS-First Policy; not needed with HTTPS-Only Mode
pref("security.insecure_connection_text.enabled", true);
pref("security.insecure_connection_text.pbmode.enabled", true);

// PREF: Enforce Punycode for Internationalized Domain Names to eliminate possible spoofing
// Firefox has some protections, but it is better to be safe than sorry.
// [!] Might be undesirable for non-latin alphabet users since legitimate IDN's are also punycoded.
// [TEST] https://www.xn--80ak6aa92e.com/ (www.apple.com)
// [1] https://wiki.mozilla.org/IDN_Display_Algorithm
// [2] https://en.wikipedia.org/wiki/IDN_homograph_attack
// [3] CVE-2017-5383: https://www.mozilla.org/security/advisories/mfsa2017-02/
// [4] https://www.xudongz.com/blog/2017/idn-phishing/
pref("network.IDN_show_punycode", true);

/******************************************************************************
 * SECTION: HTTPS-FIRST POLICY                          *
******************************************************************************/

// PREF: HTTPS-First Policy
// Firefox attempts to make all connections to websites secure, and falls back to insecure
// connections only when a website does not support it. Unlike HTTPS-Only Mode, Firefox
// will NOT ask for your permission before connecting to a website that doesn’t support secure connections.
// [NOTE] HTTPS-Only Mode needs to be disabled for HTTPS First to work.
// [TEST] http://example.com [upgrade]
// [TEST] http://httpforever.com/ [no upgrade]
// [1] https://blog.mozilla.org/security/2021/08/10/firefox-91-introduces-https-by-default-in-private-browsing/
// [2] https://brave.com/privacy-updates/22-https-by-default/
// [3] https://github.com/brave/adblock-lists/blob/master/brave-lists/https-upgrade-exceptions-list.txt
// [4] https://web.dev/why-https-matters/
// [5] https://www.cloudflare.com/learning/ssl/why-use-https/
pref("dom.security.https_first", true);

/******************************************************************************
 * SECTION: HTTPS-ONLY MODE                              *
******************************************************************************/

// PREF: offer suggestion for HTTPS site when available
// [1] https://nitter.winscloud.net/leli_gibts_scho/status/1371458534186057731
pref("dom.security.https_only_mode_error_page_user_suggestions", true);

// PREF: disable HTTPS-Only mode for local resources
pref("dom.security.https_only_mode.upgrade_local", false); // DEFAULT

/******************************************************************************
 * SECTION: ESNI / ECH                            *
******************************************************************************/

// PREF: enable Encrypted Client Hello (ECH)
// [NOTE] HTTP already isolated with network partitioning
// [1] https://blog.cloudflare.com/encrypted-client-hello/
// [2] https://www.youtube.com/watch?v=tfyrVYqXQRE
// [3] https://groups.google.com/a/chromium.org/g/blink-dev/c/KrPqrd-pO2M/m/Yoe0AG7JAgAJ
pref("network.dns.echconfig.enabled", true);
pref("network.dns.http3_echconfig.enabled", true);
pref("network.dns.use_https_rr_as_altsvc", true); // DEFAULT

/******************************************************************************
 * SECTION: PASSWORDS                             *
******************************************************************************/

// PREF: prevent password truncation when submitting form data
// [1] https://www.ghacks.net/2020/05/18/firefox-77-wont-truncate-text-exceeding-max-length-to-address-password-pasting-issues/
pref("editor.truncate_user_pastes", false);

// Show the view password icon
pref("layout.forms.reveal-password-button.enabled", true);

/******************************************************************************
 * SECTION: MIXED CONTENT + CROSS-SITE                             *
******************************************************************************/

// PREF: limit (or disable) HTTP authentication credentials dialogs triggered by sub-resources
// Hardens against potential credentials phishing.
// 0=don't allow sub-resources to open HTTP authentication credentials dialogs
// 1=don't allow cross-origin sub-resources to open HTTP authentication credentials dialogs
// 2=allow sub-resources to open HTTP authentication credentials dialogs (default)
// [1] https://www.fxsitecompat.com/en-CA/docs/2015/http-auth-dialog-can-no-longer-be-triggered-by-cross-origin-resources/
pref("network.auth.subresource-http-auth-allow", 1);

// PREF: block insecure passive content (images) on HTTPS pages
pref("security.mixed_content.block_display_content", true);

// PREF: upgrade insecure passive content (images) to HTTPS requests
pref("security.mixed_content.upgrade_display_content", true);

// PREF: allow PDFs to load javascript
// https://www.reddit.com/r/uBlockOrigin/comments/mulc86/firefox_88_now_supports_javascript_in_pdf_files/
pref("pdfjs.enableScripting", false);

// PREF: disable bypassing 3rd party extension install prompts
// [1] https://bugzilla.mozilla.org/buglist.cgi?bug_id=1659530,1681331
pref("extensions.postDownloadThirdPartyPrompt", false);

// PREF: disable permissions delegation
// Currently applies to cross-origin geolocation, camera, mic and screen-sharing
// permissions, and fullscreen requests. Disabling delegation means any prompts
// for these will show/use their correct 3rd party origin
// [1] https://groups.google.com/forum/#!topic/mozilla.dev.platform/BdFOMAuCGW8/discussion
pref("permissions.delegation.enabled", false);

/******************************************************************************
 * SECTION: HEADERS / REFERERS                                             *
******************************************************************************/

// PREF: default Referrer Policy for trackers (used unless overriden by the site)
// Applied to third-party trackers when the default
// cookie policy is set to reject third-party trackers.
// 0=no-referrer, 1=same-origin, 2=strict-origin-when-cross-origin (default),
// 3=no-referrer-when-downgrade
// [1] https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Referrer-Policy#examples
pref("network.http.referer.defaultPolicy.trackers", 1);
pref("network.http.referer.defaultPolicy.trackers.pbmode", 1);

/******************************************************************************
 * SECTION: CONTAINERS                                                        *
******************************************************************************/

// PREF: enable Container Tabs and its UI setting [FF50+]
// [NOTE] No longer a privacy benefit due to Firefox upgrades (see State Partitioning and Network Partitioning)
// Useful if you want to login to the same site under different accounts
// You also may want to download Multi-Account Containers for extra options (2)
// [SETTING] General>Tabs>Enable Container Tabs
// [1] https://wiki.mozilla.org/Security/Contextual_Identity_Project/Containers
// [2] https://addons.mozilla.org/en-US/firefox/addon/multi-account-containers/
pref("privacy.userContext.ui.enabled", true);
pref("privacy.userContext.enabled", true);

// PREF: set behavior on "+ Tab" button to display container menu on left click [FF74+]
// [NOTE] The menu is always shown on long press and right click
// [SETTING] General>Tabs>Enable Container Tabs>Settings>Select a container for each new tab ***/
pref("privacy.userContext.newTabContainerOnLeftClick.enabled", false);

/******************************************************************************
 * SECTION: WEBRTC                                                            *
******************************************************************************/

// PREF: enable WebRTC Global Mute Toggles
pref("privacy.webrtc.globalMuteToggles", true);

// PREF: force WebRTC inside the proxy [FF70+]
pref("media.peerconnection.ice.proxy_only_if_behind_proxy", true);

// PREF: force a single network interface for ICE candidates generation [FF42+]
// When using a system-wide proxy, it uses the proxy interface.
// [1] https://developer.mozilla.org/en-US/docs/Web/API/RTCIceCandidate
// [2] https://wiki.mozilla.org/Media/WebRTC/Privacy
pref("media.peerconnection.ice.default_address_only", true);

/******************************************************************************
 * SECTION: SAFE BROWSING (SB)                                                *
******************************************************************************/

// A full url is never sent to Google, only a part-hash of the prefix,
// hidden with noise of other real part-hashes. Firefox takes measures such as
// stripping out identifying parameters, and since SBv4 (FF57+), doesn't even use cookies.
// (Turn on browser.safebrowsing.debug to monitor this activity)
// [1] https://feeding.cloud.geek.nz/posts/how-safe-browsing-works-in-firefox/
// [2] https://wiki.mozilla.org/Security/Safe_Browsing
// [3] https://support.mozilla.org/kb/how-does-phishing-and-malware-protection-work
// [4] https://educatedguesswork.org/posts/safe-browsing-privacy/

// PREF: disable Safe Browsing
// [WARNING] Be sure to have alternate security measures if you disable SB! Adblockers do not count!
// [SETTING] Privacy & Security>Security>... Block dangerous and deceptive content
// [ALTERNATIVE] Enable local checks only: https://github.com/yokoffing/Betterfox/issues/87
// [1] https://support.mozilla.org/en-US/kb/how-does-phishing-and-malware-protection-work#w_what-information-is-sent-to-mozilla-or-its-partners-when-phishing-and-malware-protection-is-enabled
// [2] https://wiki.mozilla.org/Security/Safe_Browsing
// [3] https://developers.google.com/safe-browsing/v4
// [4] https://github.com/privacyguides/privacyguides.org/discussions/423#discussioncomment-1752006
// [5] https://github.com/privacyguides/privacyguides.org/discussions/423#discussioncomment-1767546
// [6] https://wiki.mozilla.org/Security/Safe_Browsing
// [7] https://ashkansoltani.org/2012/02/25/cookies-from-nowhere (outdated)
// [8] https://blog.cryptographyengineering.com/2019/10/13/dear-apple-safe-browsing-might-not-be-that-safe/ (outdated)
// [9] https://the8-bit.com/apple-proxies-google-safe-browsing-privacy/
// [10] https://github.com/brave/brave-browser/wiki/Deviations-from-Chromium-(features-we-disable-or-remove)#services-we-proxy-through-brave-servers
pref("browser.safebrowsing.malware.enabled", true); // all checks happen locally
pref("browser.safebrowsing.phishing.enabled", true); // all checks happen locally
pref("browser.safebrowsing.blockedURIs.enabled", true);
pref("browser.safebrowsing.provider.google4.gethashURL", "");
pref("browser.safebrowsing.provider.google4.updateURL", "");
pref("browser.safebrowsing.provider.google.gethashURL", "");
pref("browser.safebrowsing.provider.google.updateURL", "");

// PREF: disable SB checks for downloads
// This is the master switch for the safebrowsing.downloads prefs (both local lookups + remote).
// [NOTE] Still enable this for checks to happen locally.
// [SETTING] Privacy & Security>Security>... "Block dangerous downloads"
pref("browser.safebrowsing.downloads.enabled", false); // all checks happen locally
      
// PREF: disable SB checks for downloads (remote)
// To verify the safety of certain executable files, Firefox may submit some information about the
// file, including the name, origin, size and a cryptographic hash of the contents, to the Google
// Safe Browsing service which helps Firefox determine whether or not the file should be blocked.
// [NOTE] If you do not understand the consequences, override this.
pref("browser.safebrowsing.downloads.remote.enabled", false);
pref("browser.safebrowsing.downloads.remote.url", "");
// disable SB checks for unwanted software
// [SETTING] Privacy & Security>Security>... "Warn you about unwanted and uncommon software"
pref("browser.safebrowsing.downloads.remote.block_potentially_unwanted", false);
pref("browser.safebrowsing.downloads.remote.block_uncommon", false);

// PREF: allow user to "ignore this warning" on SB warnings
// If clicked, it bypasses the block for that session. This is a means for admins to enforce SB.
// Report false positives to [2]
// [TEST] see https://github.com/arkenfox/user.js/wiki/Appendix-A-Test-Sites#-mozilla
// [1] https://bugzilla.mozilla.org/1226490
// [2] https://safebrowsing.google.com/safebrowsing/report_general/
pref("browser.safebrowsing.allowOverride", true); // DEFAULT

/******************************************************************************
 * SECTION: MOZILLA                                                   *
******************************************************************************/

// PREF: disable Firefox View [FF106+]
// [1] https://support.mozilla.org/en-US/kb/how-set-tab-pickup-firefox-view#w_what-is-firefox-view
pref("browser.tabs.firefox-view", false);
pref("browser.firefox-view.feature-tour", "{\"screen\":\"\",\"complete\":true}");

// PREF: use Mozilla geolocation service instead of Google when geolocation is enabled
pref("geo.provider.network.url", "");

// PREF: disable using the OS's geolocation service
#if defined(XP_WIN)
pref("geo.provider.ms-windows-location", true); // [WINDOWS]
#elif defined(XP_MACOSX)
pref("geo.provider.use_corelocation", true); // [MAC]
#elif defined(XP_UNIX)
pref("geo.provider.use_geoclue", true); // [FF102+] [LINUX]
#endif

// PREF: remove webchannel whitelist
pref("webchannel.allowObject.urlWhitelist", "");

// PREF: disable mozAddonManager Web API [FF57+]
// [NOTE] To allow extensions to work on AMO, you also need extensions.webextensions.restrictedDomains.
// [1] https://bugzilla.mozilla.org/buglist.cgi?bug_id=1384330,1406795,1415644,1453988
pref("privacy.resistFingerprinting.block_mozAddonManager", true); // [HIDDEN PREF FF57-108]

// PREF: do not require signing for extensions [ESR/DEV/NIGHTLY ONLY]
// [1] https://support.mozilla.org/en-US/kb/add-on-signing-in-firefox#w_what-are-my-options-if-i-want-to-use-an-unsigned-add-on-advanced-users
pref("xpinstall.signatures.required", false, locked);

// PREF: disable Quarantined Domains [FF115+]
// Users may see a notification when running add-ons that are not monitored by Mozilla when they visit certain sites.
// The notification informs them that “some extensions are not allowed” and were blocked from running on that site.
// There's no details as to which sites are affected.
// [1] https://support.mozilla.org/en-US/kb/quarantined-domains
// [2] https://www.ghacks.net/2023/07/04/firefox-115-new-esr-base-and-some-add-ons-may-be-blocked-from-running-on-certain-sites/
pref("extensions.quarantinedDomains.enabled", false, locked);

/******************************************************************************
 * SECTION: TELEMETRY                                                   *
******************************************************************************/
// Disable all the various Mozilla telemetry, studies, reports, etc.

// PREF: Telemetry
pref("toolkit.telemetry.unified", false, locked);
pref("toolkit.telemetry.enabled", false, locked);
pref("toolkit.telemetry.server", "data:,", locked);
pref("toolkit.telemetry.archive.enabled", false, locked);
pref("toolkit.telemetry.newProfilePing.enabled", false, locked);
pref("toolkit.telemetry.shutdownPingSender.enabled", false, locked);
pref("toolkit.telemetry.updatePing.enabled", false, locked);
pref("toolkit.telemetry.bhrPing.enabled", false, locked);
pref("toolkit.telemetry.firstShutdownPing.enabled", false, locked);
pref("toolkit.telemetry.dap_enabled", false, locked); // DEFAULT [FF108]

// PREF: Check bundled omni JARs for corruption
// [1] https://github.com/ghostery/user-agent-desktop/issues/141
// [2] https://github.com/arkenfox/user.js/issues/791
pref("corroborator.enabled", false);

// PREF: Telemetry Coverage
pref("toolkit.telemetry.coverage.opt-out", true, locked);
pref("toolkit.coverage.opt-out", true, locked);
pref("toolkit.coverage.endpoint.base", "", locked);

// PREF: Health Reports
// [SETTING] Privacy & Security>Firefox Data Collection & Use>Allow Firefox to send technical data.
pref("datareporting.healthreport.uploadEnabled", false, locked);

// PREF: new data submission, master kill switch
// If disabled, no policy is shown or upload takes place, ever
// [1] https://bugzilla.mozilla.org/1195552
pref("datareporting.policy.dataSubmissionEnabled", false, locked);

// PREF: Studies
// [SETTING] Privacy & Security>Firefox Data Collection & Use>Allow Firefox to install and run studies
pref("app.shield.optoutstudies.enabled", false, locked);

// Personalized Extension Recommendations in about:addons and AMO
// [NOTE] This pref has no effect when Health Reports are disabled.
// [SETTING] Privacy & Security>Firefox Data Collection & Use>Allow Firefox to make personalized extension recommendations
pref("browser.discovery.enabled", false, locked);

// PREF: disable crash reports
pref("breakpad.reportURL", "", locked);
pref("browser.tabs.crashReporting.sendReport", false, locked);
    //pref("browser.crashReports.unsubmittedCheck.enabled", false); // DEFAULT
// PREF: enforce no submission of backlogged crash reports
pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false, locked);

// PREF: "report extensions for abuse"
pref("extensions.abuseReport.enabled", false);

// PREF: Normandy/Shield [extensions tracking]
// Shield is an telemetry system (including Heartbeat) that can also push and test "recipes"
pref("app.normandy.enabled", false, locked);
pref("app.normandy.api_url", "", locked);

// PREF: PingCentre telemetry (used in several System Add-ons)
// Currently blocked by 'datareporting.healthreport.uploadEnabled'
pref("browser.ping-centre.telemetry", false, locked);

// PREF: disable Firefox Home (Activity Stream) telemetry 
pref("browser.newtabpage.activity-stream.telemetry", false, locked);
pref("browser.newtabpage.activity-stream.feeds.telemetry", false, locked);