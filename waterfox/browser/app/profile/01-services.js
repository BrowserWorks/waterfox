#filter dumbComments emptyLines

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Application updates.
pref("app.update.enabled", true);
pref("app.update.notifyDuringDownload", true);
pref("app.update.url.override", "", sticky);
pref("extensions.systemAddon.update.url", "https://aus.waterfox.com/update/SystemAddons/%DISPLAY_VERSION%/%OS%_%ARCH%/%CHANNEL%/%OS_VERSION%/%SYSTEM_CAPABILITIES%/%DISTRIBUTION%/%DISTRIBUTION_VERSION%/update.xml");

pref("intl.multilingual.downloadEnabled", false, locked);

// Mozilla promotions and sponsored content.
pref("browser.preferences.moreFromMozilla", false);
pref("browser.vpn_promo.enabled", false, locked);
pref("browser.promo.focus.enabled", false, locked);
pref("browser.promo.pin.enabled", false, locked);
pref("browser.contentblocking.report.lockwise.enabled", false, locked);
pref("browser.contentblocking.report.show_mobile_app", false, locked);
pref("browser.contentblocking.report.vpn-promo.url", "", locked);
pref("browser.discovery.enabled", false, locked);
pref("browser.uitour.enabled", false);
pref("browser.uitour.url", "");
pref("browser.partnerlink.attributionURL", "", locked);
pref("browser.partnerlink.campaign.topsites", "", locked);
pref("browser.topsites.contile.enabled", false, locked);
pref("browser.topsites.contile.endpoint", "", locked);
pref("browser.topsites.useRemoteSetting", false, locked);

// Mozilla account extras and mobile promotions.
pref("identity.fxaccounts.toolbar.pxiToolbarEnabled.monitorEnabled", false);
pref("identity.fxaccounts.toolbar.pxiToolbarEnabled.relayEnabled", false);
pref("identity.fxaccounts.toolbar.pxiToolbarEnabled.vpnEnabled", false);
pref("identity.mobilepromo.android", "", locked);
pref("identity.mobilepromo.ios", "", locked);
pref("signon.firefoxRelay.feature", "unavailable");
pref("signon.recipes.remoteRecipes.enabled", false, locked);
