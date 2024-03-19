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
 
// PREF: initial paint delay
// How long FF will wait before rendering the page, in milliseconds
// Reduce the 5ms Firefox waits to render the page
// [1] https://bugzilla.mozilla.org/show_bug.cgi?id=1283302
// [2] https://docs.google.com/document/d/1BvCoZzk2_rNZx3u9ESPoFjSADRI0zIPeJRXFLwWXx_4/edit#heading=h.28ki6m8dg30z
pref("nglayout.initialpaint.delay", 0); // default=5; used to be 250
pref("nglayout.initialpaint.delay_in_oopif", 0); // default=5

// PREF: notification interval (in microseconds) [to avoid layout thrashing]
// When Firefox is loading a page, it periodically reformats
// or "reflows" the page as it loads. The page displays new elements
// every 0.12 seconds by default. These redraws increase the total page load time.
// The default value provides good incremental display of content
// without causing an increase in page load time.
// [NOTE] Lowering the interval will increase responsiveness
// but also increase the total load time.
// [WARNING] If this value is set below 1/10 of a second, it starts
// to impact page load performance.
// [EXAMPLE] 100000 = .10s = 100 reflows/second
// [1] https://searchfox.org/mozilla-central/rev/c1180ea13e73eb985a49b15c0d90e977a1aa919c/modules/libpref/init/StaticPrefList.yaml#1824-1834
// [2] https://dev.opera.com/articles/efficient-javascript/?page=3#reflow
// [3] https://dev.opera.com/articles/efficient-javascript/?page=3#smoothspeed
pref("content.notify.interval", 100000); // (.10s); alt=500000 (.50s)

/****************************************************************************
 * SECTION: TAB UNLOAD                                                      *
****************************************************************************/

// PREF: determine when tabs unload [WINDOWS] [LINUX]
// Notify TabUnloader or send the memory pressure if the memory resource
// notification is signaled AND the available commit space is lower than
// this value.
// Set this to some high value, e.g. 2/3 of total memory available in your system:
// 4GB=2640, 8GB=5280, 16GB=10560, 32GB=21120, 64GB=42240
// [1] https://dev.to/msugakov/taking-firefox-memory-usage-under-control-on-linux-4b02
#ifndef XP_MACOSX
pref("browser.low_commit_space_threshold_mb", 2640); // default=200; WINDOWS LINUX
#endif

// PREF: determine when tabs unload [LINUX]
// On Linux, Firefox checks available memory in comparison to total memory,
// and use this percent value (out of 100) to determine if Firefox is in a
// low memory scenario.
// [1] https://dev.to/msugakov/taking-firefox-memory-usage-under-control-on-linux-4b02
#ifdef XP_UNIX
pref("browser.low_commit_space_threshold_percent", 33); // default=5; LINUX
#endif

// PREF: determine how long (in ms) tabs are inactive before they unload
// 60000=1min; 300000=5min; 600000=10min (default)
pref("browser.tabs.min_inactive_duration_before_unload", 300000); // 5min; default=600000

/****************************************************************************
 * SECTION: EXPERIMENTAL                                                    *
****************************************************************************/

// PREF: CSS Masonry Layout [NIGHTLY]
// [1] https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Grid_Layout/Masonry_Layout
pref("layout.css.grid-template-masonry-value.enabled", true);

// PREF: Prioritized Task Scheduling API [NIGHTLY]
// [1] https://blog.mozilla.org/performance/2022/06/02/prioritized-task-scheduling-api-is-prototyped-in-nightly/
// [2] https://medium.com/airbnb-engineering/building-a-faster-web-experience-with-the-posttask-scheduler-276b83454e91
pref("dom.enable_web_task_scheduling", true);

// PREF: CSS :has() selector [NIGHTLY]
// Needed for some extensions, filters, and customizations.
// [1] https://developer.mozilla.org/en-US/docs/Web/CSS/:has
// [2] https://caniuse.com/css-has
pref("layout.css.has-selector.enabled", true);

// PREF: HTML Sanitizer API [NIGHTLY]
pref("dom.security.sanitizer.enabled", true);

/****************************************************************************
 * SECTION: GFX RENDERING TWEAKS                                            *
****************************************************************************/

// PREF: Webrender tweaks
// [1] https://searchfox.org/mozilla-central/rev/6e6332bbd3dd6926acce3ce6d32664eab4f837e5/modules/libpref/init/StaticPrefList.yaml#6202-6219
// [2] https://hacks.mozilla.org/2017/10/the-whole-web-at-maximum-fps-how-webrender-gets-rid-of-jank/
// [3] https://www.troddit.com/r/firefox/comments/tbphok/is_setting_gfxwebrenderprecacheshaders_to_true/i0bxs2r/
// [4] https://www.troddit.com/r/firefox/comments/z5auzi/comment/ixw65gb?context=3
pref("gfx.webrender.precache-shaders", true);

// PREF: GPU-accelerated Canvas2D preferences
pref("gfx.canvas.accelerated.cache-items", 4096);
pref("gfx.canvas.accelerated.cache-size", 512); 
pref("gfx.content.skia-font-cache-size", 20);

// PREF: image tweaks
pref("image.mem.decode_bytes_at_a_time", 32768);

// PREF: increase media cache
pref("media.memory_cache_max_size", 512000); // alt=512000; also in Securefox (inactive there)
pref("media.memory_caches_combined_limit_kb", 3145728); // preferred=3145728; // default=524288

// PREF: decrease video buffering
// [NOTE] Does not affect videos over 720p since they use DASH playback [1]
// [1] https://lifehacker.com/preload-entire-youtube-videos-by-disabling-dash-playbac-1186454034
//pref("media.cache_size", 2048000); // default=512000
pref("media.cache_readahead_limit", 9000); // default=60; stop reading ahead when our buffered data is this many seconds ahead of the current playback
pref("media.cache_resume_threshold", 6000); // default=30; when a network connection is suspended, don't resume it until the amount of buffered data falls below this threshold (in seconds)

/****************************************************************************
 * SECTION: NETWORK                                                         *
****************************************************************************/

// PREF: increase the absolute number of HTTP connections
// [1] https://kb.mozillazine.org/Network.http.max-connections
// [2] https://kb.mozillazine.org/Network.http.max-persistent-connections-per-server
// [3] https://www.reddit.com/r/firefox/comments/11m2yuh/how_do_i_make_firefox_use_more_of_my_900_megabit/jbfmru6/
pref("network.http.max-connections", 1800); // default=900
pref("network.http.max-persistent-connections-per-server", 10); // default=6; download connections; anything above 10 is excessive
pref("network.http.max-urgent-start-excessive-connections-per-host", 5); // default=3
pref("network.http.max-persistent-connections-per-proxy", 48); // default=32
pref("network.websocket.max-connections", 400); // default=200

// PREF: pacing requests
// Make as many connections as possible, rather than a set limit.
pref("network.http.pacing.requests.enabled", false);

// PREF: the number of threads for DNS
pref("network.dns.max_high_priority_threads", 8); // default=5

// PREF: increase TLS token caching 
pref("network.ssl_tokens_cache_capacity", 32768); // default=2048; more TLS token caching (fast reconnects)
