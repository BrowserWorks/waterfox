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

// --- Waterfox Specific URLs and Services ---
// Defines URLs for Waterfox support pages and services.
pref("accessibility.support.url", "https://www.waterfox.com/support/accessibility-services");
pref("app.support.baseURL", "https://www.waterfox.com/support/");
// URL for updating system add-ons specific to Waterfox.
pref("extensions.systemAddon.update.url", "https://aus.waterfox.com/update/SystemAddons/%DISPLAY_VERSION%/%OS%_%ARCH%/%CHANNEL%/%OS_VERSION%/%SYSTEM_CAPABILITIES%/%DISTRIBUTION%/%DISTRIBUTION_VERSION%/update.xml");
// Waterfox-specific relay for Oblivious HTTP (OHTTP) used with DNS-over-HTTPS (DoH).
pref("network.trr.ohttp.relay_uri", "https://dooh.waterfox.net/");

// --- Application Updates ---
// Configuration for how Waterfox handles updates.
pref("app.update.badgeWaitTime", 0); // Time (ms) to wait before showing update badge.
pref("app.update.enabled", true); // Enable automatic application updates.
pref("app.update.notifyDuringDownload", true); // Notify user during update download.
pref("app.update.promptWaitTime", 3600); // Time (seconds) to wait before prompting for update.
pref("app.update.url.override", "", sticky); // Override URL for application updates (sticky: user set).

// --- Startup, Session, and Basic UI Elements ---
// Defines browser behavior on startup and general UI settings.
pref("browser.startup.page", 3); // 0=blank, 1=home, 2=last visited page, 3=resume previous session.
pref("browser.privateTab.showNewTabButton", false); // Show new private tab button next to existing new tab buttons
pref("browser.tabs.closeButtons", false); // Hide close button on tabs
pref("browser.tabs.pinnedIconOnly", true); // Pinned tabs show only an icon, no text.
pref("browser.tabs.warnOnClose", true); // Warn user when attempting to close multiple tabs.
// Stores the state of toolbar customizations (e.g., button placements).
// It's a JSON string, generally best modified through the UI.
pref("browser.uiCustomization.state", "{\"placements\":{\"widget-overflow-fixed-list\":[],\"unified-extensions-area\":[],\"nav-bar\":[\"sidebar-button\",\"back-button\",\"forward-button\",\"vertical-spacer\",\"stop-reload-button\",\"urlbar-container\",\"save-to-pocket-button\",\"downloads-button\",\"fxa-toolbar-menu-button\",\"unified-extensions-button\",\"reset-pbm-toolbar-button\"],\"TabsToolbar\":[\"firefox-view-button\",\"tabbrowser-tabs\",\"new-tab-button\",\"alltabs-button\"],\"vertical-tabs\":[],\"PersonalToolbar\":[\"import-button\",\"personal-bookmarks\"],\"status-bar\":[\"screenshot-button\",\"fullscreen-button\",\"status-text\"]},\"seen\":[\"developer-button\",\"screenshot-button\"],\"dirtyAreaCache\":[\"nav-bar\",\"status-bar\",\"PersonalToolbar\",\"TabsToolbar\",\"vertical-tabs\"],\"currentVersion\":22,\"newElementCount\":4}");
// Alternative smooth scroll physics. ("MSD" = Mass-Spring-Damper)
pref("general.smoothScroll.msdPhysics.enabled", true);

// --- URL Bar Behavior ---
// Platform-specific settings for how clicks interact with the URL bar.
#ifdef UNIX_BUT_NOT_MAC
// On Linux (excluding macOS), a single click does not select all text in the URL bar.
pref("browser.urlbar.clickSelectsAll", false);
// On Linux (excluding macOS), a double click selects all text.
pref("browser.urlbar.doubleClickSelectsAll", true);
#else
// On other operating systems (Windows, macOS), a single click selects all text.
pref("browser.urlbar.clickSelectsAll", true);
// On other operating systems, double click behavior might be different or not specifically set to select all.
pref("browser.urlbar.doubleClickSelectsAll", false);
#endif

#ifdef XP_MACOSX
// Whether to disable treating ctrl click as right click
pref("dom.event.treat_ctrl_click_as_right_click.disabled", true);
#endif

// --- Top Sites and Partner Integrations ---
// Settings related to "Top Sites" on the New Tab Page and partner integrations.
pref("browser.partnerlink.attributionURL", "", locked); // URL for partner attribution (locked).
pref("browser.partnerlink.campaign.topsites", "", locked); // Campaign info for partner top sites (locked).
pref("browser.topsites.contile.enabled", false, locked); // Disable content tile suggestions (e.g., sponsored content) on Top Sites.
pref("browser.topsites.contile.endpoint", "", locked); // Endpoint for content tile suggestions.
pref("browser.topsites.useRemoteSetting", false, locked); // Do not use remote settings for Top Sites.

// --- Network Configuration ---
// Controls various aspects of network requests and connections.

// DNS Prefetching
// Disables prefetching of DNS records for links on a page.
pref("network.dns.disablePrefetch", true);
pref("network.dns.disablePrefetchFromHTTPS", true); // Also disable for links on HTTPS pages.

// DNS-over-HTTPS (DoH) & Trusted Recursive Resolver (TRR)
// Configuration for encrypted DNS lookups.
pref("doh-rollout.enabled", false, locked); // Disable automatic rollout/enablement of DoH.
pref("doh-rollout.disable-heuristics", true, locked); // Disable heuristics that might enable DoH.
pref("network.trr.max-fails", 5); // Max number of TRR failures before fallback.
pref("network.trr.mode", 2); // DoH mode: 0=Off, 1=Race, 2=TRR first, 3=TRR only, 4=Shadow, 5=Off by user choice.
pref("network.trr.ohttp.config_uri", "https://dooh.cloudflare-dns.com/.well-known/doohconfig"); // Config URI for OHTTP.
pref("network.trr.ohttp.uri", "https://dooh.cloudflare-dns.com/dns-query"); // URI for OHTTP DoH queries.
pref("network.trr.request_timeout_mode_trronly_ms", 1500); // Timeout (ms) when TRR mode is TRR-only.
pref("network.trr.use_ohttp", true); // Enable Oblivious HTTP for DoH requests.
// Include an idempotency-key header for POST requests
pref("network.http.idempotencyKey.enabled", true);
// Disable requests to 0.0.0.0
pref("network.socket.ip_addr_any.disabled", true);
pref("network.http.http3.ecn_mark", true);
pref("network.http.http3.retry_different_ip_family", true);
pref("network.http.retry_with_another_half_open", true);

// --- Extension System and Web Compatibility ---
// Settings related to browser extensions and web compatibility measures.
pref("extensions.experiments.enabled", true); // Allow Mozilla to run studies/experiments using the extension system.
pref("extensions.install_origins.enabled", true); // Allow extensions to be installed from specified origins beyond default stores.
pref("extensions.webcompat.enable_shims", true); // Enable web compatibility shims that fix site-specific issues.
// Defines domains where WebExtension APIs might be restricted, typically for protecting Mozilla services.
pref("extensions.webextensions.restrictedDomains", "accounts-static.cdn.mozilla.net,accounts.firefox.com,addons.cdn.mozilla.net,api.accounts.firefox.com,content.cdn.mozilla.net,discovery.addons.mozilla.org,install.mozilla.org,oauth.accounts.firefox.com,profile.accounts.firefox.com,support.mozilla.org,sync.services.mozilla.com");

// --- Miscellaneous Features & Integrations ---
// Various feature toggles and integration settings.
pref("intl.multilingual.downloadEnabled", false, locked); // Disable automatic download of language packs for multilingual features.
pref("messaging-system.rsexperimentloader.enabled", false, locked); // Disable loading of experiments via the Normandy/Shield messaging system.
// Controls process separation for specific Mozilla domains. Empty means default behavior.
pref("browser.tabs.remote.separatedMozillaDomains", "", locked);

// Sign-On Services and Firefox Relay integration
pref("signon.firefoxRelay.feature", "unavailable"); // Mark Firefox Relay feature as unavailable.
pref("signon.management.page.mobileAndroidURL", "", locked); // URL for managing passwords on Android (locked).
pref("signon.management.page.mobileAppleURL", "", locked); // URL for managing passwords on iOS (locked).
pref("identity.mobilepromo.android", "", locked);
pref("identity.mobilepromo.ios", "", locked);
pref("signon.recipes.remoteRecipes.enabled", false, locked); // Disable fetching of remote recipes for password generation.

// SVG Rendering
pref("svg.context-properties.content.enabled", true); // Enable use of CSS context-properties within SVG content.

// --- MathML Rendering ---
// Whether to disable legacy names "thickmathspace", "mediummathspace",
// "thickmathspace" etc for length attributes.
pref("mathml.mathspace_names.disabled", true);
// Whether to disable the MathML3 support for the mathvariant attribute. For
// MathML Core, support is restricted to the <mi> element and to value "normal".
// Corresponding automatic italicization on single-char <mi> element is also
// implemented via text-transform: auto when that flag is enabled.
pref("mathml.legacy_mathvariant_attribute.disabled", true);

// --- Media Features ---
// Use MediaDataDecoder API for VP8/VP9 in WebRTC. This includes hardware
// acceleration for decoding.
pref("media.navigator.mediadatadecoder_vpx_enabled", true);
// HTMLMediaElement.allowedToPlay should be exposed to web content when
// block autoplay rides the trains to release. Until then, Nightly only.
pref("media.allowed-to-play.enabled", true);
pref("media.webrtc.enable_pq_dtls", true);
pref("media.webrtc.simulcast.vp9.enabled", true);

// --- Security Settings (General) ---
// General security preferences not fitting into more specific categories.
// Disable priming for Man-in-the-Middle (MITM) detection for certificate errors (locked).
pref("security.certerrors.mitm.priming.enabled", false);
// Configuration for Microsoft Family Safety integration on Windows.
pref("security.family_safety.mode", 0); // 0=off, 1=parental controls, 2=filter inappropriate content.
