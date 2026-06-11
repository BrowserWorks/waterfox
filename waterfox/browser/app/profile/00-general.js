#filter dumbComments emptyLines

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

pref("app.support.baseURL", "https://www.waterfox.com/support/");

// Resume the previous session on startup.
pref("browser.startup.page", 3);
pref("browser.tabs.warnOnClose", true);

pref("browser.uidensity", 1);
pref("browser.compactmode.show", true);

// Sheet loading mode: 0 on, 2 off.
pref("browser.theme.waterfox.chromeSheet", 0);
pref("browser.nova.enabled", true);
pref("toolkit.legacyUserProfileCustomizations.stylesheets", true, locked);
pref("general.smoothScroll.msdPhysics.enabled", true);

// Settings redesign is on by default; hide its one-time promo banner.
pref("browser.settings-redesign.promo.dismissed", true);

#ifdef XP_MACOSX
pref("dom.event.treat_ctrl_click_as_right_click.disabled", true);
pref("widget.macos.titlebar-blend-mode.behind-window", true);
#endif

#ifdef XP_WIN
pref("widget.windows.mica", true);
pref("widget.windows.mica.popups", 1);
pref("widget.windows.mica.toplevel-backdrop", 3);
#endif

pref("network.auth.subresource-http-auth-allow", 1);
pref("network.http.http3.retry_different_ip_family", true);
pref("network.http.retry_with_another_half_open", true);

pref("extensions.experiments.enabled", true);
pref("extensions.install_origins.enabled", true);
// The Firefox list without addons.mozilla.org, so extensions can act on the
// add-ons site.
pref("extensions.webextensions.restrictedDomains", "accounts-static.cdn.mozilla.net,accounts.firefox.com,addons.cdn.mozilla.net,api.accounts.firefox.com,content.cdn.mozilla.net,discovery.addons.mozilla.org,oauth.accounts.firefox.com,profile.accounts.firefox.com,support.mozilla.org,sync.services.mozilla.com");

pref("media.navigator.mediadatadecoder_vpx_enabled", true);
pref("media.allowed-to-play.enabled", true);
pref("svg.context-properties.content.enabled", true);
