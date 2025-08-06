// ** Theme Related Options ****************************************************
// == Theme Distribution Settings ==============================================
// The rows that are located continuously must be changed `true`/`false` explicitly because there is a collision.
// https://github.com/black7375/Firefox-UI-Fix/wiki/Options#important
pref("userChrome.tab.connect_to_window",          true); // Original, Photon
pref("userChrome.tab.color_like_toolbar",         true); // Original, Photon

pref("userChrome.tab.lepton_like_padding",        true); // Original
pref("userChrome.tab.photon_like_padding",       false); // Photon

pref("userChrome.tab.dynamic_separator",          true); // Original, Proton
pref("userChrome.tab.static_separator",          false); // Photon
pref("userChrome.tab.static_separator.selected_accent", false); // Just option
pref("userChrome.tab.bar_separator",             false); // Just option

pref("userChrome.tab.newtab_button_like_tab",     true); // Original
pref("userChrome.tab.newtab_button_smaller",     false); // Photon
pref("userChrome.tab.newtab_button_proton",      false); // Proton

pref("userChrome.icon.panel_full",                true); // Original, Proton
pref("userChrome.icon.panel_photon",             false); // Photon

// Original Only
pref("userChrome.tab.box_shadow",                 true);
pref("userChrome.tab.bottom_rounded_corner",      true);

// Photon Only
pref("userChrome.tab.photon_like_contextline",   true);
pref("userChrome.rounding.square_tab",           false);

#ifdef XP_WIN
pref("userChrome.compatibility.os.windows_maximized", true);
pref("userChrome.compatibility.os.win11",             true);
#endif

pref("userChrome.theme.private",             true);

pref("userChrome.compatibility.theme",       false);
pref("userChrome.compatibility.os",          true);

pref("userChrome.theme.built_in_contrast",   true);
pref("userChrome.theme.proton_color",        true);
pref("userChrome.theme.proton_chrome",       true); // Need proton_color
pref("userChrome.theme.fully_color",         false); // Need proton_color
pref("userChrome.theme.fully_dark",          true); // Need proton_color

pref("userChrome.decoration.cursor",         true);
pref("userChrome.decoration.field_border",   true);
pref("userChrome.decoration.download_panel", true);
pref("userChrome.decoration.animate",        true);

pref("userChrome.padding.tabbar_width",      true);
pref("userChrome.padding.tabbar_height",     true);
pref("userChrome.padding.toolbar_button",    true);
pref("userChrome.padding.navbar_width",      false);
pref("userChrome.padding.urlbar",            true);
pref("userChrome.padding.bookmarkbar",       true);
pref("userChrome.padding.infobar",           true);
pref("userChrome.padding.menu",              true);
pref("userChrome.padding.bookmark_menu",     true);
pref("userChrome.padding.global_menubar",    true);
pref("userChrome.padding.panel",             true);
pref("userChrome.padding.popup_panel",       true);

pref("userChrome.tab.multi_selected",        true);
pref("userChrome.tab.unloaded",              true);
pref("userChrome.tab.letters_cleary",        true);
pref("userChrome.tab.close_button_at_hover", true);
pref("userChrome.tab.sound_hide_label",      true);
pref("userChrome.tab.sound_with_favicons",   true);
pref("userChrome.tab.pip",                   true);
pref("userChrome.tab.container",             true);
pref("userChrome.tab.crashed",               true);

pref("userChrome.fullscreen.overlap",        true);
pref("userChrome.fullscreen.show_bookmarkbar", true);

pref("userChrome.icon.library",              true);
pref("userChrome.icon.panel",                true);
pref("userChrome.icon.menu",                 true);
pref("userChrome.icon.context_menu",         true);
pref("userChrome.icon.global_menu",          true);
pref("userChrome.icon.global_menubar",       true);
pref("userChrome.icon.1-25px_stroke",        true);

// -- User Content -------------------------------------------------------------
pref("userContent.player.ui",             true);
pref("userContent.player.icon",           true);
pref("userContent.player.noaudio",        true);
pref("userContent.player.size",           true);
pref("userContent.player.click_to_play",  true);
pref("userContent.player.animate",        true);

pref("userContent.newTab.hidden_logo",    false);
pref("userContent.newTab.full_icon",      true);
pref("userContent.newTab.animate",        true);
pref("userContent.newTab.searchbar",      true);

pref("userContent.page.field_border",     true);
pref("userContent.page.illustration",     true);
pref("userContent.page.proton_color",     true);
pref("userContent.page.dark_mode",        true); // Need proton_color
pref("userContent.page.proton",           true); // Need proton_color
