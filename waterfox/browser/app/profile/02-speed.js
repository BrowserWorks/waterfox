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

/****************************************************************************
 * SECTION: GENERAL                                                        *
****************************************************************************/

// PREF: initial paint delay
// How long FF will wait before rendering the page (in ms)
pref("nglayout.initialpaint.delay", 0);
pref("nglayout.initialpaint.delay_in_oopif", 0);

// PREF: page reflow timer
// Rather than wait until a page has completely downloaded to display it to the user,
// web browsers will periodically render what has been received to that point.
// How often the content is redrawn is controlled by the interval value.
// [NOTE] Lowering the interval will increase responsiveness
// but also increase the total load time.
// [WARNING] If this value is set below 1/10 of a second, it starts
// to impact page load performance.
pref("content.notify.interval", 100000);

/****************************************************************************
 * SECTION: TAB UNLOAD                                                     *
****************************************************************************/

// PREF: determine when tabs unload [MACOS]
#ifndef XP_MACOSX
pref("browser.low_commit_space_threshold_mb", 2640);
#endif

// PREF: determine when tabs unload [LINUX]
#ifdef XP_UNIX
pref("browser.low_commit_space_threshold_percent", 33);
#endif

// PREF: determine how long (in ms) tabs are inactive before they unload
pref("browser.tabs.min_inactive_duration_before_unload", 300000);

/****************************************************************************
 * SECTION: GFX RENDERING TWEAKS                                            *
****************************************************************************/

// PREF: Webrender tweaks
pref("gfx.webrender.precache-shaders", true);

// PREF: GPU-accelerated Canvas2D
// [WARNING] May cause issues on some Windows machines using integrated GPUs
// Add to your overrides if you have a dedicated GPU.
// [NOTE] Higher values will use more memory.
pref("gfx.canvas.accelerated.cache-items", 4096);
pref("gfx.canvas.accelerated.cache-size", 512);
pref("gfx.content.skia-font-cache-size", 20);

// PREF: image tweaks
pref("image.mem.decode_bytes_at_a_time", 32768);

/****************************************************************************
 * SECTION: MEDIA CACHE                                                     *
****************************************************************************/

// PREF: increase media cache
pref("media.memory_cache_max_size", 512000);
pref("media.memory_caches_combined_limit_kb", 3145728);

// PREF: adjust video buffering periods when not using MSE (in seconds)
pref("media.cache_readahead_limit", 7200);
pref("media.cache_resume_threshold", 3600);

/****************************************************************************
 * SECTION: NETWORK                                                         *
****************************************************************************/

// PREF: increase the absolute number of HTTP connections
pref("network.http.max-connections", 1800);
pref("network.http.max-persistent-connections-per-server", 10);
pref("network.http.max-urgent-start-excessive-connections-per-host", 5);

// PREF: pacing requests
pref("network.http.pacing.requests.enabled", false);

// PREF: increase TLS token caching
pref("network.ssl_tokens_cache_capacity", 10240);

/****************************************************************************
 * SECTION: SPECULATIVE LOADING                                            *
****************************************************************************/

// PREF: DNS prefetching
pref("network.dns.disablePrefetch", true);
pref("network.dns.disablePrefetchFromHTTPS", true);

// PREF: Network Predictor (NP)
pref("network.predictor.enabled", false);
pref("network.predictor.enable-prefetch", false);

/****************************************************************************
 * SECTION: EXPERIMENTAL                                                    *
****************************************************************************/

// PREF: CSS Masonry Layout [NIGHTLY]
pref("layout.css.grid-template-masonry-value.enabled", true);

// PREF: Prioritized Task Scheduling API [NIGHTLY]
pref("dom.enable_web_task_scheduling", true);

// PREF: CSS :has() selector [NIGHTLY]
pref("layout.css.has-selector.enabled", true);

// PREF: HTML Sanitizer API [NIGHTLY]
pref("dom.security.sanitizer.enabled", true);

// PREF: compression level for cached JavaScript bytecode
pref("browser.cache.jsbc_compression_level", 3);
