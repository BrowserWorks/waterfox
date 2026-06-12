#filter dumbComments emptyLines

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

pref("browser.search.serpEventTelemetryCategorization.enabled", false, locked);

// Tracking protection and fingerprinting.
pref("privacy.trackingprotection.lower_network_priority", true);
pref("privacy.globalprivacycontrol.enabled", true);
pref("privacy.resistFingerprinting.block_mozAddonManager", true);
pref("dom.battery.enabled", false);

// Cookies and storage.
pref("browser.privatebrowsing.forceMediaMemoryCache", true);
pref("network.cookie.sameSite.schemeful", true);

// Certificates and TLS.
pref("security.OCSP.enabled", 0);
pref("security.certerrors.mitm.priming.enabled", false);
pref("security.mixed_content.block_display_content", true);
pref("security.ssl.treat_unsafe_negotiation_as_broken", true);
pref("security.tls.enable_0rtt_data", false);
pref("browser.xul.error_pages.expert_bad_cert", true);
pref("dom.security.https_only_mode_error_page_user_suggestions", true);

// History, referrers and the URL bar.
pref("network.http.referer.XOriginTrimmingPolicy", 2);
pref("network.http.referer.defaultPolicy.trackers", 1);
pref("network.http.referer.defaultPolicy.trackers.pbmode", 1);
pref("browser.urlbar.trimURLs", false);

// Forms and documents.
pref("editor.truncate_user_pastes", false);
pref("pdfjs.enableScripting", false);

// Extension installs are not limited to signed or Mozilla approved ones.
pref("xpinstall.signatures.required", false, locked);
pref("extensions.quarantinedDomains.enabled", false, locked);
pref("extensions.postDownloadThirdPartyPrompt", false);
pref("extensions.abuseReport.enabled", false);
pref("extensions.blocklist.softblock.enabled", false);
pref("browser.disable_pickers_in_hidden_extension_pages", true);

// WebRTC.
pref("privacy.webrtc.globalMuteToggles", true);
pref("media.peerconnection.ice.proxy_only_if_behind_proxy", true);
pref("media.peerconnection.ice.default_address_only", true);

// DRM downloads a proprietary binary, so it stays off until the user opts in,
// either in Settings or from the prompt the first EME site triggers.
pref("media.eme.enabled", false);

// No Mozilla or Google location service.
pref("geo.provider.network.url", "");

// Safe Browsing and remote download reputation are disabled.
pref("browser.safebrowsing.phishing.enabled", false);
pref("browser.safebrowsing.malware.enabled", false);
pref("browser.safebrowsing.blockedURIs.enabled", false);
pref("browser.safebrowsing.globalCache.enabled", false);
pref("browser.safebrowsing.downloads.enabled", false);
pref("browser.safebrowsing.downloads.remote.enabled", false);
pref("browser.safebrowsing.downloads.remote.url", "");
pref("browser.safebrowsing.downloads.remote.block_dangerous", false);
pref("browser.safebrowsing.downloads.remote.block_dangerous_host", false);
pref("browser.safebrowsing.downloads.remote.block_potentially_unwanted", false);
pref("browser.safebrowsing.downloads.remote.block_uncommon", false);
pref("browser.safebrowsing.reportPhishURL", "");
pref("browser.safebrowsing.provider.google.gethashURL", "");
pref("browser.safebrowsing.provider.google.updateURL", "");
pref("browser.safebrowsing.provider.google.reportURL", "");
pref("browser.safebrowsing.provider.google.reportPhishMistakeURL", "");
pref("browser.safebrowsing.provider.google.reportMalwareMistakeURL", "");
pref("browser.safebrowsing.provider.google.advisoryURL", "");
pref("browser.safebrowsing.provider.google4.gethashURL", "");
pref("browser.safebrowsing.provider.google4.updateURL", "");
pref("browser.safebrowsing.provider.google4.reportURL", "");
pref("browser.safebrowsing.provider.google4.reportPhishMistakeURL", "");
pref("browser.safebrowsing.provider.google4.reportMalwareMistakeURL", "");
pref("browser.safebrowsing.provider.google4.advisoryURL", "");
pref("browser.safebrowsing.provider.google4.dataSharingURL", "");
pref("browser.safebrowsing.provider.google4.dataSharing.enabled", false);
pref("browser.safebrowsing.provider.google5.enabled", false);
pref("browser.safebrowsing.provider.google5.lists", "");
pref("browser.safebrowsing.provider.google5.gethashURL", "");
pref("browser.safebrowsing.provider.google5.updateURL", "");
pref("browser.safebrowsing.provider.google5.reportURL", "");
pref("browser.safebrowsing.provider.google5.reportPhishMistakeURL", "");
pref("browser.safebrowsing.provider.google5.reportMalwareMistakeURL", "");
pref("browser.safebrowsing.provider.google5.advisoryURL", "");
pref("browser.safebrowsing.provider.google5.advisoryName", "");

// Telemetry and data reporting stay off.
pref("toolkit.telemetry.unified", false, locked);
pref("toolkit.telemetry.enabled", false, locked);
pref("toolkit.telemetry.server", "data:,", locked);
pref("toolkit.telemetry.archive.enabled", false, locked);
pref("toolkit.telemetry.newProfilePing.enabled", false, locked);
pref("toolkit.telemetry.shutdownPingSender.enabled", false, locked);
pref("toolkit.telemetry.updatePing.enabled", false, locked);
pref("toolkit.telemetry.bhrPing.enabled", false, locked);
pref("toolkit.telemetry.firstShutdownPing.enabled", false, locked);
pref("toolkit.coverage.endpoint.base", "", locked);
pref("datareporting.healthreport.uploadEnabled", false, locked);
pref("datareporting.policy.dataSubmissionEnabled", false, locked);
pref("browser.newtabpage.activity-stream.telemetry", false, locked);
pref("dom.security.unexpected_system_load_telemetry_enabled", false);

// No Terms of Use acceptance flow; data collection is off and locked, so
// there is nothing to agree to on first run or upgrade.
pref("browser.preonboarding.enabled", false, locked);
pref("termsofuse.bypassNotification", true, locked);

// Normandy and Shield.
pref("app.normandy.enabled", false, locked);
pref("app.normandy.api_url", "", locked);
pref("app.shield.optoutstudies.enabled", false, locked);

// Nimbus rollouts and Firefox Labs recipes come from a Remote Settings
// collection that stays offline here, so the loader has nothing to do.
pref("nimbus.rollouts.enabled", false, locked);
pref("nimbus.labs.enabled", false, locked);
pref("browser.preferences.experimental.hidden", true);

// Firefox Monitor breach alerts query a Mozilla breach collection.
pref("signon.management.page.breach-alerts.enabled", false, locked);
pref("browser.urlbar.trustPanel.breachAlerts", false, locked);

// Crash reporting.
pref("breakpad.reportURL", "", locked);
pref("browser.tabs.crashReporting.sendReport", false, locked);

// Network beacons and prefetching.
pref("network.captive-portal-service.enabled", false);
pref("network.connectivity-service.enabled", false);
pref("network.dns.disablePrefetch", true);
pref("network.dns.disablePrefetchFromHTTPS", true);

// No special casing for Mozilla domains.
pref("browser.tabs.remote.separatedMozillaDomains", "", locked);
