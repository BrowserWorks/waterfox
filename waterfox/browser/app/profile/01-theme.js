#filter dumbComments emptyLines substitution

// -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

pref("browser.theme.enableWaterfoxCustomizations", 1);
pref("browser.uidensity", 1);
pref("extensions.activeThemeID", "default-theme@mozilla.org");

// ** Theme Related Options ****************************************************
// == Theme Distribution Settings ==============================================

pref("userChrome.tab.connect_to_window",          true); // Original, Photon
pref("userChrome.tab.color_like_toolbar",         true); // Original, Photon

pref("userChrome.tab.lepton_like_padding",        false); // Original
pref("userChrome.tab.photon_like_padding",       true); // Photon

pref("userChrome.tab.dynamic_separator",          false); // Original, Proton
pref("userChrome.tab.static_separator",          true); // Photon
pref("userChrome.tab.static_separator.selected_accent", false); // Just option
pref("userChrome.tab.bar_separator",             false); // Just option

pref("userChrome.tab.newtab_button_like_tab",     false); // Original
pref("userChrome.tab.newtab_button_smaller",     true); // Photon
pref("userChrome.tab.newtab_button_proton",      false); // Proton

pref("userChrome.icon.panel_full",                false); // Original, Proton
pref("userChrome.icon.panel_photon",             true); // Photon

// Original Only
pref("userChrome.tab.box_shadow",                 false);
pref("userChrome.tab.bottom_rounded_corner",      false);

// Photon Only
pref("userChrome.tab.photon_like_contextline",   true);
pref("userChrome.rounding.square_tab",           true);

// == Theme Compatibility Settings =============================================
pref("userChrome.compatibility.covered_header_image", false);
pref("userChrome.compatibility.panel_cutoff",         false);
pref("userChrome.compatibility.navbar_top_border",    false);
pref("userChrome.compatibility.dynamic_separator",    false); // Need dynamic_separator

pref("userChrome.compatibility.os.linux_non_native_titlebar_button", false);
pref("userChrome.compatibility.os.windows_maximized", false);
pref("userChrome.compatibility.os.win11",             false);

// == Theme Custom Settings ====================================================
// -- User Chrome --------------------------------------------------------------
pref("userChrome.theme.proton_color.dark_blue_accent", true);
pref("userChrome.theme.monospace",                     false);

pref("userChrome.decoration.disable_panel_animate",    false);
pref("userChrome.decoration.disable_sidebar_animate",  false);
pref("userChrome.decoration.panel_button_separator",   true);
pref("userChrome.decoration.panel_arrow",              true);

pref("userChrome.autohide.tab",                        false);
pref("userChrome.autohide.tab.opacity",                false);
pref("userChrome.autohide.tab.blur",                   false);
pref("userChrome.autohide.tabbar",                     false);
pref("userChrome.autohide.navbar",                     false);
pref("userChrome.autohide.bookmarkbar",                false);
pref("userChrome.autohide.sidebar",                    false);
pref("userChrome.autohide.fill_urlbar",                false);
pref("userChrome.autohide.back_button",                false);
pref("userChrome.autohide.forward_button",             false);
pref("userChrome.autohide.page_action",                false);
pref("userChrome.autohide.toolbar_overlap",            false);
pref("userChrome.autohide.toolbar_overlap.allow_layout_shift", false);

pref("userChrome.hidden.tab_icon",                     false);
pref("userChrome.hidden.tab_icon.always",              false);
pref("userChrome.hidden.tabbar",                       false);
pref("userChrome.hidden.navbar",                       false);
pref("userChrome.hidden.titlebar_container",           false);
pref("userChrome.hidden.sidebar_header",               false);
pref("userChrome.hidden.sidebar_header.vertical_tab_only", false);
pref("userChrome.hidden.urlbar_iconbox",               false);
pref("userChrome.hidden.urlbar_iconbox.label_only",    false);
pref("userChrome.hidden.bookmarkbar_icon",             false);
pref("userChrome.hidden.bookmarkbar_label",            false);
pref("userChrome.hidden.disabled_menu",                false);

pref("userChrome.centered.tab",                        false);
pref("userChrome.centered.tab.label",                  false);
pref("userChrome.centered.urlbar",                     false);
pref("userChrome.centered.bookmarkbar",                false);

pref("userChrome.counter.tab",                         false);
pref("userChrome.counter.bookmark_menu",               false);

pref("userChrome.combined.nav_button",                 false);
pref("userChrome.combined.nav_button.home_button",     false);
pref("userChrome.combined.urlbar.nav_button",          false);
pref("userChrome.combined.urlbar.home_button",         false);
pref("userChrome.combined.urlbar.reload_button",       false);
pref("userChrome.combined.sub_button.none_background", false);
pref("userChrome.combined.sub_button.as_normal",       false);

pref("userChrome.rounding.square_button",              false);
pref("userChrome.rounding.square_dialog",              false);
pref("userChrome.rounding.square_panel",               false);
pref("userChrome.rounding.square_panelitem",           false);
pref("userChrome.rounding.square_menupopup",           false);
pref("userChrome.rounding.square_menuitem",            false);
pref("userChrome.rounding.square_infobox",             false);
pref("userChrome.rounding.square_toolbar",             false);
pref("userChrome.rounding.square_field",               false);
pref("userChrome.rounding.square_urlView_item",        false);
pref("userChrome.rounding.square_checklabel",          false);

pref("userChrome.padding.first_tab",                   false);
pref("userChrome.padding.first_tab.always",            false);
pref("userChrome.padding.drag_space",                  false);
pref("userChrome.padding.drag_space.maximized",        false);

pref("userChrome.padding.toolbar_button.compact",      false);
pref("userChrome.padding.menu_compact",                false);
pref("userChrome.padding.bookmark_menu.compact",       false);
pref("userChrome.padding.urlView_expanding",           false);
pref("userChrome.padding.urlView_result",              false);
pref("userChrome.padding.panel_header",                false);

pref("userChrome.urlbar.iconbox_with_separator",       true);

pref("userChrome.urlView.as_commandbar",               false);
pref("userChrome.urlView.full_width_padding",          false);
pref("userChrome.urlView.always_show_page_actions",    false);
pref("userChrome.urlView.move_icon_to_left",           false);
pref("userChrome.urlView.go_button_when_typing",       false);
pref("userChrome.urlView.focus_item_border",           false);

pref("userChrome.tabbar.as_titlebar",                  false);
pref("userChrome.tabbar.fill_width",                   false);
pref("userChrome.tabbar.multi_row",                    false);
pref("userChrome.tabbar.unscroll",                     false);
pref("userChrome.tabbar.on_bottom",                    false);
pref("userChrome.tabbar.on_bottom.above_bookmark",     false); // Need on_bottom
pref("userChrome.tabbar.on_bottom.menubar_on_top",     false); // Need on_bottom
pref("userChrome.tabbar.on_bottom.hidden_single_tab",  false); // Need on_bottom
pref("userChrome.tabbar.one_liner",                    false);
pref("userChrome.tabbar.one_liner.combine_navbar",     false); // Need one_liner
pref("userChrome.tabbar.one_liner.tabbar_first",       false); // Need one_liner
pref("userChrome.tabbar.one_liner.responsive",         false); // Need one_liner

pref("userChrome.tab.bottom_rounded_corner.all",       false);
pref("userChrome.tab.bottom_rounded_corner.australis", false);
pref("userChrome.tab.bottom_rounded_corner.edge",      false);
pref("userChrome.tab.bottom_rounded_corner.chrome",    false);
pref("userChrome.tab.bottom_rounded_corner.chrome_legacy", false);
pref("userChrome.tab.bottom_rounded_corner.wave",      false);
pref("userChrome.tab.always_show_tab_icon",            false);
pref("userChrome.tab.close_button_at_pinned",          false);
pref("userChrome.tab.close_button_at_pinned.always",   false);
pref("userChrome.tab.close_button_at_pinned.background", false);
pref("userChrome.tab.close_button_at_hover.always",    false); // Need close_button_at_hover
pref("userChrome.tab.close_button_at_hover.with_selected", false);  // Need close_button_at_hover
pref("userChrome.tab.sound_show_label",                false); // Need remove sound_hide_label

pref("userChrome.navbar.as_sidebar",                   false);

pref("userChrome.bookmarkbar.multi_row",               false);

pref("userChrome.findbar.floating_on_top",             false);

pref("userChrome.panel.remove_strip",                  false);
pref("userChrome.panel.full_width_separator",          false);
pref("userChrome.panel.full_width_padding",            false);

pref("userChrome.sidebar.overlap",                     false);

pref("userChrome.icon.disabled",                       false);
pref("userChrome.icon.account_image_to_right",         false);
pref("userChrome.icon.account_label_to_right",         false);
pref("userChrome.icon.menu.full",                      false);
pref("userChrome.icon.global_menu.mac",                false);

// -- User Content -------------------------------------------------------------
pref("userContent.player.ui.twoline",                  false);

pref("userContent.newTab.hidden_logo",                 false);

pref("userContent.page.proton_color.dark_blue_accent", true);
pref("userContent.page.proton_color.system_accent",    false);
pref("userContent.page.monospace",                     false);

// == Theme Default Settings ===================================================
// -- User Chrome --------------------------------------------------------------
pref("userChrome.compatibility.theme",       false);
pref("userChrome.compatibility.os",          false);

pref("userChrome.theme.built_in_contrast",   false);
pref("userChrome.theme.system_default",      true);
pref("userChrome.theme.proton_color",        false);
pref("userChrome.theme.proton_chrome",       false); // Need proton_color
pref("userChrome.theme.fully_color",         false); // Need proton_color
pref("userChrome.theme.fully_dark",          false); // Need proton_color

pref("userChrome.decoration.cursor",         true);
pref("userChrome.decoration.field_border",   true);
pref("userChrome.decoration.download_panel", true);
pref("userChrome.decoration.animate",        true);

pref("userChrome.padding.tabbar_width",      false);
pref("userChrome.padding.tabbar_height",     false);
pref("userChrome.padding.toolbar_button",    false);
pref("userChrome.padding.navbar_width",      false);
pref("userChrome.padding.urlbar",            false);
pref("userChrome.padding.bookmarkbar",       false);
pref("userChrome.padding.infobar",           false);
pref("userChrome.padding.menu",              false);
pref("userChrome.padding.bookmark_menu",     false);
pref("userChrome.padding.global_menubar",    false);
pref("userChrome.padding.panel",             false);
pref("userChrome.padding.popup_panel",       false);

pref("userChrome.tab.multi_selected",        true);
pref("userChrome.tab.unloaded",              true);
pref("userChrome.tab.letters_cleary",        false);
pref("userChrome.tab.close_button_at_hover", true);
pref("userChrome.tab.sound_hide_label",      false);
pref("userChrome.tab.sound_with_favicons",   true);
pref("userChrome.tab.pip",                   true);
pref("userChrome.tab.container",             true);
pref("userChrome.tab.crashed",               true);

pref("userChrome.fullscreen.overlap",        true);
pref("userChrome.fullscreen.show_bookmarkbar", false);

pref("userChrome.icon.library",              true);
pref("userChrome.icon.panel",                true);
pref("userChrome.icon.menu",                 true);
pref("userChrome.icon.context_menu",         true);
pref("userChrome.icon.global_menu",          true);
pref("userChrome.icon.global_menubar",       true);

// -- User Content -------------------------------------------------------------
pref("userContent.player.ui",             true);
pref("userContent.player.icon",           true);
pref("userContent.player.noaudio",        true);
pref("userContent.player.size",           true);
pref("userContent.player.click_to_play",  true);
pref("userContent.player.animate",        true);

pref("userContent.newTab.full_icon",      true);
pref("userContent.newTab.animate",        true);
pref("userContent.newTab.pocket_to_last", true);
pref("userContent.newTab.searchbar",      true);

pref("userContent.page.field_border",     true);
pref("userContent.page.illustration",     true);
pref("userContent.page.proton_color",     true);
pref("userContent.page.dark_mode",        false); // Need proton_color
pref("userContent.page.proton",           true); // Need proton_color

// ** Scrolling Settings *******************************************************
// == Only Sharpen Scrolling ===================================================
//         Pref                                             Value      Original
/*
pref("mousewheel.min_line_scroll_amount",                 10); //        5
pref("general.smoothScroll.mouseWheel.durationMinMS",     80); //       50
pref("general.smoothScroll.currentVelocityWeighting", "0.15"); //   "0.25"
pref("general.smoothScroll.stopDecelerationWeighting", "0.6"); //    "0.4"
*/

// == Smooth Scrolling ==========================================================
// ** Scrolling Options ********************************************************
// based on natural smooth scrolling v2 by aveyo
// this preset will reset couple extra variables for consistency
//         Pref                                              Value                 Original
/*
pref("apz.allow_zooming",                               true);            ///     true
pref("apz.force_disable_desktop_zooming_scrollbars",   false);            ///    false
pref("apz.paint_skipping.enabled",                      true);            ///     true
pref("apz.windows.use_direct_manipulation",             true);            ///     true
pref("dom.event.wheel-deltaMode-lines.always-disabled", true);            ///    false
pref("general.smoothScroll.currentVelocityWeighting", "0.12");            ///   "0.25" <- 1. If scroll too slow, set to "0.15"
pref("general.smoothScroll.durationToIntervalRatio",    1000);            ///      200
pref("general.smoothScroll.lines.durationMaxMS",         100);            ///      150
pref("general.smoothScroll.lines.durationMinMS",           0);            ///      150
pref("general.smoothScroll.mouseWheel.durationMaxMS",    100);            ///      200
pref("general.smoothScroll.mouseWheel.durationMinMS",      0);            ///       50
pref("general.smoothScroll.mouseWheel.migrationPercent", 100);            ///      100
pref("general.smoothScroll.msdPhysics.continuousMotionMaxDeltaMS", 12);   ///      120
pref("general.smoothScroll.msdPhysics.enabled",                  true);   ///    false
pref("general.smoothScroll.msdPhysics.motionBeginSpringConstant", 200);   ///     1250
pref("general.smoothScroll.msdPhysics.regularSpringConstant",     200);   ///     1000
pref("general.smoothScroll.msdPhysics.slowdownMinDeltaMS",         10);   ///       12
pref("general.smoothScroll.msdPhysics.slowdownMinDeltaRatio",  "1.20");   ///    "1.3"
pref("general.smoothScroll.msdPhysics.slowdownSpringConstant",   1000);   ///     2000
pref("general.smoothScroll.other.durationMaxMS",         100);            ///      150
pref("general.smoothScroll.other.durationMinMS",           0);            ///      150
pref("general.smoothScroll.pages.durationMaxMS",         100);            ///      150
pref("general.smoothScroll.pages.durationMinMS",           0);            ///      150
pref("general.smoothScroll.pixels.durationMaxMS",        100);            ///      150
pref("general.smoothScroll.pixels.durationMinMS",          0);            ///      150
pref("general.smoothScroll.scrollbars.durationMaxMS",    100);            ///      150
pref("general.smoothScroll.scrollbars.durationMinMS",      0);            ///      150
pref("general.smoothScroll.stopDecelerationWeighting", "0.6");            ///    "0.4"
pref("layers.async-pan-zoom.enabled",                   true);            ///     true
pref("layout.css.scroll-behavior.spring-constant",   "250.0");            ///   "250.0"
pref("mousewheel.acceleration.factor",                     3);            ///       10
pref("mousewheel.acceleration.start",                     -1);            ///       -1
pref("mousewheel.default.delta_multiplier_x",            100);            ///      100
pref("mousewheel.default.delta_multiplier_y",            100);            ///      100
pref("mousewheel.default.delta_multiplier_z",            100);            ///      100
pref("mousewheel.min_line_scroll_amount",                  0);            ///        5
pref("mousewheel.system_scroll_override.enabled",       true);            ///     true <- 2. If scroll too fast, set to false
pref("mousewheel.system_scroll_override_on_root_content.enabled", false); ///     true
pref("mousewheel.transaction.timeout",                  1500);            ///     1500
pref("toolkit.scrollbox.horizontalScrollDistance",         4);            ///        5
pref("toolkit.scrollbox.verticalScrollDistance",           3);            ///        3
*/