#filter dumbComments emptyLines substitution

// -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// --- Region detection ---
pref("browser.region.network.scan", false, locked); // Already false by default, but better safe than sorry
pref("browser.region.network.url", "", locked);
pref("browser.region.update.enabled", false, locked);
pref("browser.search.region", "US", locked); // Set a neutral region
pref("browser.search.serpEventTelemetryCategorization.enabled", false, locked);

// --- Waterfox Adblocking ---
// Master toggle for Waterfox's built-in blocker.
pref("waterfox.blocker.enabled", true);
// Show ad blocking controls in about:preferences.
pref("waterfox.blocker.ui.enabled", true);
// Show blocked count badge on the blocker toolbar button.
pref("waterfox.blocker.showBadge", true);
// Allow ads on configured Waterfox search partner domains.
pref("waterfox.blocker.allowSearchPartnerAds", true);
// Additional custom filter list URLs as a JSON array string.
pref("waterfox.blocker.filterListUrls", "[]");
// Per-list enabled overrides as a JSON object mapping list IDs to booleans.
pref("waterfox.blocker.enabledLists", "{}");
// Whether to suppress startup detection notifications for ad blocker extensions.
pref("waterfox.blocker.extensionDetectionDismissed", false);
// Extension IDs for which install warnings have already been dismissed.
pref("waterfox.blocker.dismissedExtensionInstallWarnings", "[]");
// Alow the built-in blocker to runs alongside adblock
// extensions.
pref("waterfox.blocker.coexist", false);
// Fetch uBO scriptlets and supplementary resources from Waterfox AUS at
// runtime. When false, the engine uses only the build-bundled copies.
pref("waterfox.blocker.remoteResourcesEnabled", true);

// --- Tracking Protection & Fingerprinting Resistance ---
// Lower the priority of network loads for resources on tracking protection lists.
pref("privacy.trackingprotection.lower_network_priority", true);
// Disable access to the Battery Status API to prevent fingerprinting.
pref("dom.battery.enabled", false);
// Disable UITour backend, which can be a fingerprinting vector or used for unwanted popups.
pref("browser.uitour.enabled", false);
pref("browser.uitour.url", ""); // Clear UITour URL
// Enable Global Privacy Control (GPC) to signal websites not to sell or share personal data.
pref("privacy.globalprivacycontrol.enabled", true);
pref("privacy.globalprivacycontrol.functionality.enabled", true);
// Block fingerprinting attempts via the mozAddonManager Web API.
pref("privacy.resistFingerprinting.block_mozAddonManager", true);

// --- Cookies & Site Data ---
// Enforce that SameSite=None cookies must also be Secure.
pref("network.cookie.sameSite.noneRequiresSecure", true);
// Prevent media cache from writing to disk in Private Browsing mode, forcing it to memory.
pref("browser.privatebrowsing.forceMediaMemoryCache", true);
pref("dom.cookieStore.extra.enabled", true);
// Whether to support CHIPS(Cookies Having Independent Partitioned State).
pref("network.cookie.CHIPS.enabled", true);
pref("network.cookie.sameSite.schemeful", true);

// --- Certificate & Connection Security ---
// OCSP (Online Certificate Status Protocol)
pref("security.OCSP.enabled", 0); // 0=disable, 1=validate good certs, 2=validate all certs (old default)

// CRLite (Compressed Revocation List)
// Enables a more private way to check for revoked certificates.
pref("security.remote_settings.crlite_filters.enabled", true);
pref("security.pki.crlite_mode", 2); // 0=off, 1=check only, 2=check and enforce.

// SSL/TLS Settings
// Display a warning on the padlock icon for connections with unsafe TLS negotiation.
pref("security.ssl.treat_unsafe_negotiation_as_broken", true);
// Disable TLS 1.3 0-RTT (Zero Round Trip Time Resumption) to improve forward secrecy.
pref("security.tls.enable_0rtt_data", false);

// Error Pages
// Display more detailed technical information on "Insecure Connection" warning pages.
pref("browser.xul.error_pages.expert_bad_cert", true);

// --- History, Referrers, and URL Display ---
// Set History section in preferences to show all options, allowing for custom history settings.
pref("privacy.history.custom", true);

// Referrer Policy
// Control how much referrer information is sent with requests.
// 2 = Send origin, path, and querystring for same-origin, but only origin for cross-origin.
pref("network.http.referer.XOriginTrimmingPolicy", 2);
// Default Referrer Policy for trackers (1 = strict-origin-when-cross-origin).
pref("network.http.referer.defaultPolicy.trackers", 1);
pref("network.http.referer.defaultPolicy.trackers.pbmode", 1); // Same for private browsing.

// URL Bar
// Disable trimming of "http://", "https://", "www." etc. from URLs in the address bar.
pref("browser.urlbar.trimURLs", false);
// Enable UI option to add custom search engines.
pref("browser.urlbar.update2.engineAliasRefresh", true);
// Disable Firefox Suggest (sponsored and non-sponsored suggestions based on browsing).
pref("browser.urlbar.suggest.quicksuggest.sponsored", false);
pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false);

// --- HTTPS-Only Mode & Mixed Content ---
// Display "Not Secure" text on HTTP sites for better visual indication.
pref("security.insecure_connection_text.enabled", true);
pref("security.insecure_connection_text.pbmode.enabled", true); // Also in private browsing.

// HTTPS-First Policy (attempts to upgrade HTTP to HTTPS automatically)
pref("dom.security.https_first", true);

// HTTPS-Only Mode Settings
pref("dom.security.https_only_mode_error_page_user_suggestions", true); // Show suggestions on HTTPS-Only error pages.
pref("dom.security.https_only_mode.upgrade_local", false); // Do not attempt to upgrade local addresses (e.g., localhost).

// Mixed Content Blocking
// Block active mixed content (e.g., scripts) and passive mixed content (e.g., images).
pref("security.mixed_content.block_display_content", true); // Blocks passive mixed content
pref("security.mixed_content.upgrade_display_content", true); // Attempts to upgrade passive mixed content to HTTPS

// --- Passwords, Forms & Paste Handling ---
// Disable truncating user pastes into form fields (can interfere with long strings).
pref("editor.truncate_user_pastes", false);
// Enable the built-in reveal password button in password fields.
pref("layout.forms.reveal-password-button.enabled", true);
// Allow subresource HTTP authentication (1 = allow same-origin, 2 = allow cross-origin).
pref("network.auth.subresource-http-auth-allow", 1);

// --- PDF Viewer Security ---
// Disable JavaScript execution within the built-in PDF viewer for security.
pref("pdfjs.enableScripting", false);

// --- Extensions & Add-ons Security/Privacy ---
// Disable the prompt that appears after downloading a third-party extension (XPI file).
pref("extensions.postDownloadThirdPartyPrompt", false);
// Disable signing requirement for extensions (use with caution, for development or trusted sources only).
pref("xpinstall.signatures.required", false, locked);
// Disable the "Quarantined Domains" feature which restricts extension capabilities on certain domains.
pref("extensions.quarantinedDomains.enabled", false, locked);
// Disable personalized extension recommendations in about:addons and AMO.
pref("browser.discovery.enabled", false, locked); // Also affects other "discovery" features.
// Disable extension abuse reporting feature.
pref("extensions.abuseReport.enabled", false);
// Whether we block opening pickers from hidden extension pages in WebExtensions.
// This includes background pages and devtools pages, but not background tabs.
pref("browser.disable_pickers_in_hidden_extension_pages", true);


// --- Container Tabs ---
// Enable Container Tabs feature and its UI elements.
pref("privacy.userContext.ui.enabled", true);
pref("privacy.userContext.enabled", true);
// Control behavior of the "+ Tab" button regarding containers (false = default new tab).
pref("privacy.userContext.newTabContainerOnLeftClick.enabled", false);

// --- WebRTC Privacy ---
// Enable global mute toggles for microphone/camera in WebRTC.
pref("privacy.webrtc.globalMuteToggles", true);
// Force WebRTC connections to use a proxy if one is configured.
pref("media.peerconnection.ice.proxy_only_if_behind_proxy", true);
// Force WebRTC to use only the default network interface for ICE candidates (can prevent IP leaks).
pref("media.peerconnection.ice.default_address_only", true);

// --- Geolocation Services ---
// Clear the URL for Mozilla's geolocation service, effectively disabling it if not manually re-enabled.
// (To use a specific provider, set this to its URL, or "" to rely on OS-level services if available)
pref("geo.provider.network.url", "");

// --- Safe Browsing ---
// Disable Safe Browsing features for downloads and remote checks.
pref("browser.safebrowsing.downloads.remote.enabled", false);
pref("browser.safebrowsing.downloads.remote.url", ""); // Clear remote check URL
pref("browser.safebrowsing.provider.google4.gethashURL", ""); // Clear Google Safe Browsing v4 gethash URL
pref("browser.safebrowsing.provider.google4.updateURL", ""); // Clear Google Safe Browsing v4 update URL
pref("browser.safebrowsing.provider.google.gethashURL", ""); // Clear Google Safe Browsing v2 gethash URL (legacy)
pref("browser.safebrowsing.provider.google.updateURL", ""); // Clear Google Safe Browsing v2 update URL (legacy)
pref("browser.safebrowsing.downloads.enabled", false); // Disable Safe Browsing checks for downloaded files.

// --- Telemetry, Experiments & Data Reporting ---
// These settings aim to disable various forms of data collection and reporting to Mozilla or third parties.

// Core Telemetry System
pref("toolkit.telemetry.unified", false, locked); // Master switch for new telemetry system.
pref("toolkit.telemetry.enabled", false, locked); // General telemetry enabled/disabled.
pref("toolkit.telemetry.server", "data:,", locked); // Send telemetry data to a null void.
pref("toolkit.telemetry.archive.enabled", false, locked); // Disable archiving of telemetry data.
pref("toolkit.telemetry.newProfilePing.enabled", false, locked); // Disable ping sent for new profiles.
pref("toolkit.telemetry.shutdownPingSender.enabled", false, locked); // Disable ping sent at shutdown.
pref("toolkit.telemetry.updatePing.enabled", false, locked); // Disable ping sent for updates.
pref("toolkit.telemetry.bhrPing.enabled", false, locked); // Disable Background Hang Reporter pings.
pref("toolkit.telemetry.firstShutdownPing.enabled", false, locked); // Disable first shutdown ping.
pref("toolkit.telemetry.dap_enabled", false, locked); // Disable Data Aggregation Platform related telemetry.

// Telemetry Coverage (additional telemetry for measuring code coverage by telemetry)
pref("toolkit.telemetry.coverage.opt-out", true, locked);
pref("toolkit.coverage.opt-out", true, locked);
pref("toolkit.coverage.endpoint.base", "", locked);

// Health Reports & Data Reporting Policy
pref("datareporting.healthreport.uploadEnabled", false, locked); // Disable Firefox Health Report (FHR).
pref("datareporting.policy.dataSubmissionEnabled", false, locked); // General policy switch for data submission.

// Studies, Normandy & Shield (Mozilla's system for deploying studies, features, and fixes)
pref("app.shield.optoutstudies.enabled", false, locked); // Opt-out of Shield studies.
pref("app.normandy.enabled", false, locked); // Disable Normandy (Shield's successor).
pref("app.normandy.api_url", "", locked); // Clear Normandy API URL.

// Crash Reporting
pref("breakpad.reportURL", "", locked); // Clear URL for sending crash reports.
pref("browser.tabs.crashReporting.sendReport", false, locked); // Don't send reports for tab crashes.
pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false, locked); // Don't auto-submit unsent crash reports.

// Component-Specific Telemetry
pref("browser.newtabpage.activity-stream.feeds.telemetry", false, locked); // Disable telemetry for New Tab Page feeds.
pref("browser.newtabpage.activity-stream.telemetry", false, locked); // Disable general New Tab Page telemetry.
pref("dom.security.unexpected_system_load_telemetry_enabled", false, locked); // Telemetry for unexpected system load.
pref("network.trr.confirmation_telemetry_enabled", false, locked); // Telemetry for TRR/DoH confirmation.
pref("security.app_menu.recordEventTelemetry", false, locked); // Telemetry for app menu interactions.
pref("security.certerrors.recordEventTelemetry", false, locked); // Telemetry for certificate error page interactions.
pref("security.identitypopup.recordEventTelemetry", false, locked); // Telemetry for identity popup (site info) interactions.
pref("security.protectionspopup.recordEventTelemetry", false, locked); // Telemetry for protections popup interactions.

// --- Miscellaneous Privacy & Security Settings ---
// Check bundled omni.ja JAR files for corruption (can be disabled for minor performance gain, security implications if disabled).
pref("corroborator.enabled", false);
// Allow the OS to check for captive portals
pref("network.captive-portal-service.enabled", false);
// Clear the webchannel whitelist, restricting its use (WebChannel allows web pages to communicate with specific XPCOM components).
pref("webchannel.allowObject.urlWhitelist", "");
// Enable the HTML Sanitizer API, which provides a standards-based way to sanitize HTML fragments.
pref("dom.security.sanitizer.enabled", true);
pref("dom.w3c_pointer_events.getcoalescedevents_only_in_securecontext", true);

// --- Content Blocking Reports ---
// Disable various promotional features in the content blocking report.
pref("browser.contentblocking.report.lockwise.enabled", false, locked);
pref("browser.contentblocking.report.monitor.enabled", false, locked);
pref("browser.contentblocking.report.show_mobile_app", false, locked);
