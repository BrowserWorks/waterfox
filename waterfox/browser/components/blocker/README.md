# Waterfox blocker component

Reference notes for reading or changing blocker code. The engine is Brave's `adblock-rs` v0.13.2 (MPL-2.0). The Waterfox integration around it is also MPL-2.0.

## Request and response flow

### Network requests

`WaterfoxBlockerService` observes `http-on-modify-request`, normalises the request context, and calls `checkRequestDetailed(...)` on `nsIWaterfoxBlockerEngine`. XPCOM forwards through the C++ `ContentClassifierEngine` into the Rust FFI and `adblock-rs`.

If the request matches and there is no exception, resources that are not documents are cancelled and documents loaded at the top level are redirected to `blockedPage.xhtml`. Clicking "Load anyway" goes through the `WaterfoxBlockedPage` actor, records a `waterfox-blocker` permission for the session, and navigates to the original URL. Later loads from the same host bypass the engine until the browser is closed.

### CSP rules

The service also observes `http-on-examine-response` (plus the cached and merged variants). For `document` and `subdocument` loads it calls `getCspDirectives(...)`, and if directives come back it sets `Content-Security-Policy` on the response.

### Cosmetic filters and scriptlets

The child actor asks the parent for cosmetic resources for the current URL, the parent queries the service, and the child applies hide selectors, procedural cosmetic filters, and generic hide updates. Scriptlets are injected into the page's main world when present.

## Filter sources and My Filters

The engine is built from three sources.

Catalog lists are resolved from `assets/list_catalog.json`. Stored profile copies take precedence, and each missing bundled catalog list is filled from `assets/filters/` before the initial engine is created. Remote updates run after that local baseline is active and replace the engine atomically.

Custom filter list URLs come from the Custom Filter Lists dialog and live in `waterfox.blocker.filterListUrls`, which must use HTTPS. They are fetched into the profile list cache after local initialization and refresh through the same path as catalog lists.

My Filters reads from profile text at `ProfD/waterfox-blocker/custom-filters.txt`, using standard uBlock Origin static filter syntax. It supports the same engine features as list filters: network rules, exceptions, cosmetic filters, procedural cosmetics, scriptlets, and CSP rules where `adblock-rs` supports them. My Filters is part of the engine cache hash, so editing it invalidates and rebuilds the serialised engine cache. Import/export uses plain `.txt` files; the downloaded list cache and generated bundled assets are not included.

My Filters is deliberately separate from uBlock Origin's dynamic "My rules". Dynamic allow/block/noop rules are not parsed by `adblock-rs` and are out of scope here.

## Scriptlet bundling

uBO scriptlets now ship as ESM. The older `adblock-rs` resource assembler route is deprecated and does not handle that format well, so Waterfox follows Brave's Node.js packaging flow instead. The dependency resolution and `fn.toString()` bundling algorithm come from `https://github.com/brave/brave-core-crx-packager/pull/599`.

`scripts/update-bundled-assets.js` also reads uBO's redirect resource mapping and resources that can be reached from the web, then merges those redirect resources, encoded as base64, into `assets/resources/resources.json` alongside Brave's supplementary resources. The matching AUS `resources.json` bundle must be regenerated from the same output in the server update pipeline.

`scripts/update-bundled-assets.js` loads the uBO scriptlets, expands their dependencies recursively, serialises both dependency and main functions through `fn.toString()`, wraps the placeholder argument handling (`{{1}}` .. `{{9}}`), and writes `assets/resources/ubo-scriptlets.json` with base64 data. The script runs offline and the resulting JSON is consumed at runtime as data. The matching AUS `ubo-scriptlets.json` bundle must be regenerated from the same output in the server update pipeline.

## Licensing

| Item | Source | Licence or notice | Notes |
| --- | --- | --- | --- |
| `adblock-rs` (v0.13.2) | Brave | MPL-2.0 | Core blocking engine |
| Brave entries in `resources/resources.json` | Brave (`adblock-resources`) | MPL-2.0 | Redirect and script resources |
| uBO redirect entries in `resources/resources.json` | `gorhill/uBlock` | GPL-3.0 | Generated offline from resources that can be reached from the web and bundled as data, never compiled into the Waterfox binary |
| Generated `resources/ubo-scriptlets.json` | `gorhill/uBlock` | GPL-3.0 | Generated offline from source and bundled as data, never compiled into the Waterfox binary |
| uBO fallback filter files | `uBlockOrigin/uAssets` | GPL-3.0 | Files named `ublock-*.txt` in `assets/filters/` |
| AdGuard tracking parameter fallback list | `AdguardTeam/AdGuardFilters` | GPL-3.0 | `assets/filters/adguard-tracking-protection.txt` |
| EasyList and EasyPrivacy fallback lists | EasyList authors | GPL-3.0-or-later or CC BY-SA-3.0-or-later | Waterfox uses the GPL-3.0 option in `about:license` |
| EasyList Cookie fallback list | EasyList authors | CC BY 3.0 | `assets/filters/easylist-cookie.txt` |
| Peter Lowe's Ad and Tracking Server fallback list | Peter Lowe | Credit and policy notice | The bundled file has upstream credit and policy URLs, but no standard licence header |
| Filter catalog and Waterfox integration | Waterfox | MPL-2.0 | Rust/C++/JS integration, UI, and catalog metadata |
