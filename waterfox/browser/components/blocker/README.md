# Waterfox blocker component

The blocker uses Brave's `adblock-rs` v0.13.5. The `waterfox.blocker.enabled` preference controls ad blocking independently of ETP settings and exceptions.

## Request matching

`AdBlockingPolicy` captures private mode, permissions, domain allowances and navigation state on the main thread. `ContentClassifierService` owns the published engine and checks detached native request snapshots on a background queue separate from engine construction.

The HTTP classifier applies ETP and ad policies independently before connecting. It skips ad checks on channels already cancelled or undergoing ETP cancellation. Native `modify-request` handling rechecks pending redirects and query rewrites before applying them. A synchronous native content policy checks internal cache loads.

Ad matching and cancellation run only in the native blocker, without an ETP `production-list` backend. The JS service handles list providers, resource loading, preferences, UI statistics, cosmetic resources and content actors.

### Blocking and exceptions

When no exception applies, the blocker cancels matching requests for resources other than documents and redirects matching documents in the top frame to `blockedPage.xhtml`. "Load anyway" uses the `WaterfoxBlockedPage` actor to set a session permission in `nsIPermissionManager` and reopen the original URL.

Normal windows use `waterfox-blocker` permissions, including permanent exceptions. Private windows use separate `waterfox-blocker-pb` permissions that clear when the last private context exits. Use the panel in a private window to allow a site for that session.

## Response filtering

Native response observers apply engine CSP to documents and subdocuments in network, cached and merged responses. They preserve the origin's policy and keep blocker CSP out of cached metadata. For authentication retries on the same channel, they clear the previous response's CSP state and markers before processing the authenticated response. The engine accepts unqualified CSP rules and rejects rules such as `$subdocument,csp=...` that specify a resource type.

The JS `filterAdBlockingResponse` adapter uses pinned native inputs for HTML, header and body transformations without recapturing policy or rematching rules. The engine supplies no HTML or header directives, and the replacement FFI returns `[]`. Tests pass directives directly to the adapter.

### Cosmetic filters

The child actor asks the parent for cosmetic resources for the current URL, and the parent queries the service. The child applies hide selectors, procedural filters and generic hide updates, and injects any scriptlets into the page's main world.

## Toolbar panel and statistics

`WaterfoxBlockerPanel` manages the shield button and its doorhanger. The main view shows the tab's blocked count and categories, a site toggle and lifetime totals. The domain view lists each blocked domain with an "Allow" action. The network blocker and the content policy both use these choices from `waterfox.blocker.domainExceptions`, a JSON map keyed by the base domain of the top frame.

`WaterfoxBlockerService.getBlockedStats(browserId)` returns counts for the tab. They reset when its top frame navigates. The engine doesn't report the matching list, so the service assigns categories separately:

- Documents in the top frame count as popups.
- Ping/report types and domains in the URL classifier tracking tables (ETP tracking annotations) count as trackers.
- Other requests count as ads.

Category counts can lag behind the total because classification runs asynchronously and caches results per base domain. On a fresh profile without tracking tables, classification by domain falls back to ads.

The service stores lifetime totals as JSON in `waterfox.blocker.globalStats`, debounces writes and flushes them at shutdown. It estimates "data saved" from the total.

## Filter lists

The engine combines catalog lists, custom lists and My Filters. For entries in `assets/list_catalog.json`, profile copies take precedence. Before building the first engine, the service fills gaps with bundled lists from `assets/filters/`. Remote updates start once the local engine is active and replace it atomically.

Add HTTPS URLs in the Custom Filter Lists dialog. The service saves them in `waterfox.blocker.filterListUrls`, fetches lists into the profile list cache after local initialization and refreshes them through the catalog update path.

### My Filters

My Filters reads standard uBlock Origin static filters from `ProfD/waterfox-blocker/custom-filters.txt`. It supports the same features as list filters: network rules and exceptions, cosmetic filters (including procedural filters), scriptlets and CSP where `adblock-rs` supports them. The engine does not parse dynamic allow/block/noop rules from uBlock Origin's "My rules".

Editing My Filters changes the engine cache hash and triggers a rebuild. Import and export use plain `.txt` files and exclude downloaded list caches and generated bundled assets.

### Domain options

`adblock-rs` v0.13.5 parses the `$to=` option for destination domains but never matches rules that use it, including exceptions. `$from=` and `$domain=` restrict the source domain only.

## Engine caches

`adblock-rs` v0.13.5 uses DAT v8. Cache filenames include the application build ID. DAT v6 (v0.13.3) and DAT v5 (v0.13.2) are incompatible. If a cache fails to load, synchronous and asynchronous initialization both replace it with one rebuilt from local filter text. Redirect and scriptlet resources load separately.

DAT v8 stores the crate version. When the version matches, the loader checks SeaHash and skips FlatBuffer verification. It still verifies the FlatBuffer for compatible caches from other versions.

Load only caches Waterfox serialized, from memory or the local profile. SeaHash detects accidental corruption but does not authenticate the file. Never load downloaded or otherwise untrusted binary engines.

## Scriptlet bundling

The deprecated `adblock-rs` resource assembler handles uBO's ESM scriptlets poorly. Waterfox uses Brave's Node.js packaging flow for dependency resolution and `fn.toString()` bundling (`https://github.com/brave/brave-core-crx-packager/pull/599`).

`scripts/update-bundled-assets.js` runs offline and writes two bundles:

- `assets/resources/resources.json`: the script uses uBO's redirect map to find resources accessible from the web, encodes them in base64 and merges them with Brave's supplementary resources.
- `assets/resources/ubo-scriptlets.json`: the script recursively expands dependencies, serialises the dependency and main functions with `fn.toString()` and wraps placeholder argument handling (`{{1}}` .. `{{9}}`) before base64 encoding.

Waterfox reads both bundles as data at runtime. In the server update pipeline, regenerate the matching AUS `resources.json` and `ubo-scriptlets.json` bundles from the same output.

## Licensing

| Item | Source | Licence or notice | Notes |
| --- | --- | --- | --- |
| `adblock-rs` (v0.13.5) | Brave | MPL-2.0 | Core blocking engine |
| Brave entries in `resources/resources.json` | Brave (`adblock-resources`) | MPL-2.0 | Redirect and script resources |
| uBO redirect entries in `resources/resources.json` | `gorhill/uBlock` | GPL-3.0 | Generated offline from resources that can be reached from the web and bundled as data, never compiled into the Waterfox binary |
| Generated `resources/ubo-scriptlets.json` | `gorhill/uBlock` | GPL-3.0 | Generated offline from source and bundled as data, never compiled into the Waterfox binary |
| uBO fallback filter files | `uBlockOrigin/uAssets` | GPL-3.0 | Files named `ublock-*.txt` in `assets/filters/` |
| AdGuard tracking parameter fallback list | `AdguardTeam/AdGuardFilters` | GPL-3.0 | `assets/filters/adguard-tracking-protection.txt` |
| EasyList and EasyPrivacy fallback lists | EasyList authors | GPL-3.0-or-later or CC BY-SA-3.0-or-later | Waterfox uses the GPL-3.0 option in `about:license` |
| EasyList Cookie fallback list | EasyList authors | CC BY 3.0 | `assets/filters/easylist-cookie.txt` |
| Peter Lowe's Ad and Tracking Server fallback list | Peter Lowe | Credit and policy notice | The bundled file has upstream credit and policy URLs, but no standard licence header |
| Filter catalog and Waterfox integration | Waterfox | MPL-2.0 | Rust/C++/JS integration, UI, and catalog metadata |
