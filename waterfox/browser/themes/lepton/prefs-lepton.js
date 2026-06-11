#filter dumbComments emptyLines

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// ** Theme Related Options ****************************************************
// == Theme Distribution Settings ==============================================
// The rows that are located continuously must be changed `true`/`false` explicitly because there is a collision.
// https://github.com/black7375/Firefox-UI-Fix/wiki/Options#important
pref("userChrome.tab.connect_to_window",         false); // Original, Photon
pref("userChrome.tab.color_like_toolbar",        false); // Original, Photon

pref("userChrome.tab.lepton_like_padding",       false); // Original
pref("userChrome.tab.photon_like_padding",       false); // Photon

pref("userChrome.tab.dynamic_separator",          false); // Original, Proton
pref("userChrome.tab.static_separator",          false); // Photon
pref("userChrome.tab.static_separator.selected_accent", false); // Just option
pref("userChrome.tab.bar_separator",             false); // Just option

pref("userChrome.tab.newtab_button_like_tab",    false); // Original
pref("userChrome.tab.newtab_button_smaller",     false); // Photon
pref("userChrome.tab.newtab_button_proton",       false); // Proton

pref("userChrome.icon.panel_full",                false); // Original, Proton
pref("userChrome.icon.panel_photon",             true); // Photon

// Original Only
pref("userChrome.tab.box_shadow",                false);
pref("userChrome.tab.bottom_rounded_corner",     false);

// Photon Only
pref("userChrome.tab.photon_like_contextline",  false);
pref("userChrome.rounding.square_tab",          false);

pref("userChrome.theme.private",             true);


pref("userChrome.theme.built_in_contrast",   false);
pref("userChrome.theme.proton_color",        false);
pref("userChrome.theme.proton_chrome",       false); // Requires proton_color.
pref("userChrome.theme.fully_color",         false); // Requires proton_color.
pref("userChrome.theme.fully_dark",          false); // Requires proton_color.

pref("userChrome.decoration.animate",        false);

pref("userChrome.padding.tabbar_width",      false);
pref("userChrome.padding.tabbar_height",     false);
pref("userChrome.padding.toolbar_button",    false);
pref("userChrome.padding.bookmarkbar",       false);
pref("userChrome.padding.infobar",           false);
pref("userChrome.padding.bookmark_menu",     false);
pref("userChrome.padding.global_menubar",    false);

pref("userChrome.tab.multi_selected",        false);
pref("userChrome.tab.unloaded",               true);
pref("userChrome.tab.letters_cleary",        false);
pref("userChrome.tab.close_button_at_hover", false);
pref("userChrome.tab.sound_with_favicons",    true);
pref("userChrome.tab.pip",                   false);
pref("userChrome.tab.container",              true);
pref("userChrome.tab.crashed",               false);


pref("userChrome.icon.library",               true);
pref("userChrome.icon.panel",                 true);
pref("userChrome.icon.menu",                  true);
pref("userChrome.icon.context_menu",          true);
pref("userChrome.icon.global_menu",          false);
pref("userChrome.icon.global_menubar",       false);
pref("userChrome.icon.1-25px_stroke",         true);

// Declared for about:preferences bindings.

pref("userChrome.autohide.back_button",                          false);
pref("userChrome.autohide.bookmarkbar",                          false);
pref("userChrome.autohide.fill_urlbar",                          false);
pref("userChrome.autohide.forward_button",                       true);
pref("userChrome.autohide.infobar",                              false);
pref("userChrome.autohide.navbar",                               false);
pref("userChrome.autohide.page_action",                          false);
pref("userChrome.autohide.tab",                                  false);
pref("userChrome.autohide.tab.blur",                             false);
pref("userChrome.autohide.tab.opacity",                          false);
pref("userChrome.autohide.tabbar",                               false);
pref("userChrome.autohide.toolbar_overlap",                      false);

pref("userChrome.bookmarkbar.multi_row",                         false);

pref("userChrome.centered.bookmarkbar",                          false);
pref("userChrome.centered.tab",                                  false);
pref("userChrome.centered.tab.label",                            false);
pref("userChrome.centered.urlbar",                               false);

pref("userChrome.combined.nav_button",                           false);
pref("userChrome.combined.nav_button.home_button",               false);


pref("userChrome.counter.bookmark_menu",                         false);
pref("userChrome.counter.tab",                                   false);

pref("userChrome.decoration.disable_panel_animate",              false);
pref("userChrome.decoration.disable_sidebar_animate",            false);

pref("userChrome.findbar.floating_on_top",                       false);

pref("userChrome.hidden.bookmarkbar_icon",                       false);
pref("userChrome.hidden.bookmarkbar_label",                      false);
pref("userChrome.hidden.navbar",                                 false);
pref("userChrome.hidden.private_indicator",                      false);
pref("userChrome.hidden.tab_icon",                               false);
pref("userChrome.hidden.tab_icon.always",                        false);
pref("userChrome.hidden.tabbar",                                 false);
pref("userChrome.hidden.titlebar_container",                     false);
pref("userChrome.hidden.urlbar_iconbox",                         false);
pref("userChrome.hidden.urlbar_iconbox.label_only",              false);

pref("userChrome.icon.account_image_to_right",                   false);
pref("userChrome.icon.account_label_to_right",                   false);
pref("userChrome.icon.disabled",                                 false);
pref("userChrome.icon.global_menu.mac",                          false);
pref("userChrome.icon.menu.full",                                false);


pref("userChrome.padding.bookmark_menu.compact",                 false);
pref("userChrome.padding.drag_space",                            false);
pref("userChrome.padding.drag_space.maximized",                  false);
pref("userChrome.padding.first_tab",                             false);
pref("userChrome.padding.first_tab.always",                      false);
pref("userChrome.padding.toolbar_button.compact",                false);
pref("userChrome.padding.urlView_result",                        false);


pref("userChrome.rounding.square_button",                        false);
pref("userChrome.rounding.square_checklabel",                    false);
pref("userChrome.rounding.square_dialog",                        false);
pref("userChrome.rounding.square_field",                         false);
pref("userChrome.rounding.square_infobox",                       false);
pref("userChrome.rounding.square_menuitem",                      false);
pref("userChrome.rounding.square_menupopup",                     false);
pref("userChrome.rounding.square_panel",                         false);
pref("userChrome.rounding.square_panelitem",                     false);
pref("userChrome.rounding.square_toolbar",                       false);
pref("userChrome.rounding.square_urlView_item",                  false);


pref("userChrome.tab.blue_accent",                               false);
pref("userChrome.tab.bottom_rounded_corner.all",                 false);
pref("userChrome.tab.bottom_rounded_corner.australis",           false);
pref("userChrome.tab.bottom_rounded_corner.chrome",              false);
pref("userChrome.tab.bottom_rounded_corner.chrome_legacy",       false);
pref("userChrome.tab.bottom_rounded_corner.edge",                false);
pref("userChrome.tab.bottom_rounded_corner.wave",                false);
pref("userChrome.tab.close_button_at_hover.always",              false);
pref("userChrome.tab.close_button_at_hover.with_selected",       false);
pref("userChrome.tab.close_button_at_pinned",                    false);
pref("userChrome.tab.close_button_at_pinned.always",             false);
pref("userChrome.tab.close_button_at_pinned.background",         false);
pref("userChrome.tab.container.always_long",                     false);
pref("userChrome.tab.container.on_top",                          false);
pref("userChrome.tab.contextline_blue_accent",                   false);
pref("userChrome.tab.selected_bold",                             false);
pref("userChrome.tab.sound_with_favicons.on_center",            false);
pref("userChrome.tab.supernova_like_contextline",                false);

pref("userChrome.tabbar.as_titlebar",                            false);
pref("userChrome.tabbar.fill_width",                             false);

pref("userChrome.tabbar.on_bottom",                              false);
pref("userChrome.tabbar.on_bottom.above_bookmark",               false);
pref("userChrome.tabbar.on_bottom.hidden_single_tab",            false);
pref("userChrome.tabbar.on_bottom.menubar_on_top",               false);
pref("userChrome.tabbar.one_liner",                              false);
pref("userChrome.tabbar.one_liner.combine_navbar",               false);
pref("userChrome.tabbar.one_liner.responsive",                   false);
pref("userChrome.tabbar.one_liner.tabbar_first",                 false);

pref("userChrome.theme.monospace",                               false);
pref("userChrome.theme.system_default",                          false);
pref("userChrome.theme.transparent.frame",                       false);
pref("userChrome.theme.transparent.panel",                       false);

pref("userChrome.urlView.focus_item_border",                     false);

pref("userChrome.urlbar.always_show_page_actions",               false);
pref("userChrome.urlbar.iconbox_with_separator",                 true);

pref("userContent.newTab.animate",             true);
pref("userContent.newTab.background_image",   false);
pref("userContent.newTab.full_icon",           true);
pref("userContent.newTab.hidden_logo",        false);

pref("userContent.page.dark_mode.pdf",        false);
pref("userContent.page.monospace",            false);
pref("userContent.player.animate",             true);
pref("userContent.player.click_to_play",       true);
pref("userContent.player.icon",                true);
pref("userContent.player.noaudio",             true);
pref("userContent.player.size",                true);
pref("userContent.player.ui",                  true);
pref("userContent.player.ui.twoline",         false);

// The build sets OS prefs; the Photon preset sets its theme prefs.
pref("userChrome.compatibility.theme",                           false);
pref("userChrome.compatibility.accent_color",                    false);
pref("userChrome.compatibility.covered_header_image",            false);
pref("userChrome.compatibility.dynamic_separator",               false);
pref("userChrome.compatibility.panel_cutoff",                    false);
#ifdef XP_WIN
pref("userChrome.compatibility.os",                              true);
pref("userChrome.compatibility.os.win11",                        true);
pref("userChrome.compatibility.os.windows_maximized",            true);
pref("userChrome.compatibility.navbar_top_border",               true);
#else
pref("userChrome.compatibility.os",                              false);
pref("userChrome.compatibility.os.win11",                        false);
pref("userChrome.compatibility.os.windows_maximized",            false);
pref("userChrome.compatibility.navbar_top_border",               false);
#endif
