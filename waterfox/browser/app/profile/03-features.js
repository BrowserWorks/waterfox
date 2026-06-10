#filter dumbComments emptyLines

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// New tab page: keep the page local, no sponsored or remote content.
pref("browser.newtabpage.activity-stream.asrouter.providers.cfr", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.message-groups", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments", "{}", locked);
pref("browser.newtabpage.activity-stream.asrouter.useRemoteL10n", false, locked);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons", false);
pref("browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features", false);
pref("browser.newtabpage.activity-stream.default.sites", "", locked);
pref("browser.newtabpage.activity-stream.discoverystream.enabled", false, locked);
pref("browser.newtabpage.activity-stream.feeds.section.highlights", true);
pref("browser.newtabpage.activity-stream.feeds.section.topstories", false, locked);
pref("browser.newtabpage.activity-stream.feeds.system.topstories", false, locked);
pref("browser.newtabpage.activity-stream.improvesearch.topSiteSearchShortcuts", false);
pref("browser.newtabpage.activity-stream.logowordmark.alwaysVisible", false);
pref("browser.newtabpage.activity-stream.section.highlights.includeBookmarks", true);
pref("browser.newtabpage.activity-stream.section.highlights.includeDownloads", false);
pref("browser.newtabpage.activity-stream.section.highlights.includePocket", false, locked);
pref("browser.newtabpage.activity-stream.section.highlights.includeVisited", true);
pref("browser.newtabpage.activity-stream.section.highlights.rows", 2);
pref("browser.newtabpage.activity-stream.showSearch", true);
pref("browser.newtabpage.activity-stream.showSponsored", false, locked);
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false, locked);
pref("browser.newtabpage.activity-stream.system.showSponsored", false, locked);
pref("browser.newtabpage.activity-stream.showWeather", true);
pref("browser.newtabpage.activity-stream.widgets.weather.enabled", false);
pref("browser.newtabpage.activity-stream.system.showWeather", true);

pref("extensions.getAddons.showPane", false, locked);
pref("extensions.htmlaboutaddons.recommendations.enabled", false, locked);

// Make form autofill available regardless of the detected region.
pref("extensions.formautofill.addresses.supported", "on");
pref("extensions.formautofill.creditCards.supported", "on");

// General-purpose AI and chatbot surfaces are not shipped. Turning off
// browser.ml.chat.enabled alone leaves the context menu, selection shortcuts,
// and sidebar entry visible, so disable each surface plus the
// about:preferences AI controls pane. (Smart tab grouping is disabled below.)
pref("browser.ml.enable", false);
pref("browser.ml.chat.enabled", false);
pref("browser.ml.chat.menu", false);
pref("browser.ml.chat.page", false);
pref("browser.ml.chat.shortcuts", false);
pref("browser.ml.chat.sidebar", false);
pref("browser.ml.linkPreview.enabled", false);
pref("browser.ml.linkPreview.labs", 0, locked);
pref("browser.preferences.aiControls", false);

pref("browser.urlbar.suggest.weather", false);
pref("browser.urlbar.suggest.quicksuggest.sponsored", false, locked);
pref("browser.urlbar.trending.featureGate", false);

pref("browser.search.separatePrivateDefault.ui.enabled", true);

pref("browser.download.always_ask_before_handling_new_types", true);
pref("browser.download.manager.addToRecentDocs", false);
pref("browser.download.open_pdf_attachments_inline", true);

pref("browser.aboutConfig.showWarning", false);
pref("browser.bookmarks.openInTabClosesMenu", false);
pref("browser.menu.showViewImageInfo", true);
pref("browser.history.collectWireframes", true);
pref("browser.link.open_newwindow.restriction", 0);
pref("devtools.debugger.ui.editor-wrapping", true);
pref("findbar.highlightAll", true);
pref("layout.forms.reveal-password-button.enabled", true);
pref("layout.word_select.eat_space_to_next_word", false);
pref("view_source.wrap_long_lines", true);

#ifdef MOZ_WIDGET_GTK
pref("widget.gtk.global-menu.enabled", true);
#endif

// Reject cookie banners when a one click option exists.
pref("cookiebanners.service.mode", 1);
pref("cookiebanners.service.mode.privateBrowsing", 1);
pref("cookiebanners.ui.desktop.enabled", true);

// Web platform features ahead of the Firefox release defaults.
pref("dom.media.webcodecs.h265.enabled", true);
pref("dom.webshare.enabled", true);
pref("image.jxl.enabled", true);
pref("layout.css.scroll-driven-animations.enabled", true);
pref("layout.dynamic-reflow-roots.enabled", true);
pref("mathml.legacy_mathvariant_attribute.disabled", true);
pref("mathml.mathspace_names.disabled", true);
pref("svg.Moz2D.strokeBounds.enabled", true);
pref("svg.new-getBBox.enabled", true);
