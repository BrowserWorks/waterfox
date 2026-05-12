# Waterfox blocker component

I use this as a working reference when reading or changing blocker code. The engine is Brave's `adblock-rs` v0.12.1 (MPL-2.0) - the Waterfox integration around it is also MPL-2.0.

## Request and response flow

### Network requests

`WaterfoxBlockerService` observes `http-on-modify-request`, normalises the request context, and calls `checkRequestDetailed(...)` on `nsIWaterfoxBlockerEngine`. XPCOM forwards through the C++ `ContentClassifierEngine` into the Rust FFI and `adblock-rs`. If the request matches and there's no exception, non-document resources are cancelled and top-level documents are redirected to `blockedPage.xhtml`. Clicking "Load anyway" goes through the `WaterfoxBlockedPage` actor, which records a session-scoped `waterfox-blocker` permission in `nsIPermissionManager` and then navigates to the original URL; subsequent loads from the same host bypass the engine until the browser is closed.

### CSP rules

The service also observes `http-on-examine-response` (plus the cached and merged variants). For `document` and `subdocument` loads it calls `getCspDirectives(...)`, and if directives come back it sets `Content-Security-Policy` on the response.

### Cosmetic filters and scriptlets

The child actor asks the parent for cosmetic resources for the current URL, the parent queries the service, and the child applies hide selectors, procedural cosmetic filters, and generic hide updates. Scriptlets are injected into the page's main world when present.

## Filter sources and My Filters

The engine is built from three sources.

Built-in catalog lists are resolved from `assets/list_catalog.json`. Bundled fallback files under `assets/filters/` are used when the profile cache and a network refresh are both unavailable.

Custom filter list URLs come from the Custom Filter Lists dialog and live in `waterfox.blocker.filterListUrls` which must use HTTPS. They're fetched into the profile list cache and refresh through the same path as built-in lists.

My Filters comes from the My Filters dialog and lives in profile text at `ProfD/waterfox-blocker/custom-filters.txt`, using standard uBlock Origin static filter syntax. It supports the same engine features as list filters: network rules, exceptions, cosmetic filters, procedural cosmetics, scriptlets, and CSP rules where `adblock-rs` supports them. My Filters is part of the engine cache hash, so editing it invalidates and rebuilds the serialised engine cache. Import/export uses plain `.txt` files; the downloaded list cache and generated bundled assets aren't included.

My Filters is deliberately separate from uBlock Origin's dynamic "My rules". Dynamic allow/block/noop rules aren't parsed by `adblock-rs` and are out of scope here.

## Scriptlet bundling

uBO scriptlets now ship as ESM. The older `adblock-rs` resource-assembler route is deprecated and doesn't handle that format cleanly, so we follow Brave's Node.js packaging flow instead. The dependency resolution and `fn.toString()` bundling algorithm come from `https://github.com/brave/brave-core-crx-packager/pull/599`.

`scripts/update-bundled-assets.js` loads the uBO built-in scriptlets, expands their dependencies recursively, serialises both dependency and main functions through `fn.toString()`, wraps the placeholder argument handling (`{{1}}` .. `{{9}}`), and writes a base64-encoded `assets/resources/ubo-scriptlets.json`. The script runs offline and the resulting JSON is consumed at runtime as data.

## Licensing

| Item | Source | Licence | Notes |
|---|---|---|---|
| `adblock-rs` (v0.12.1) | Brave | MPL-2.0 | Core blocking engine |
| Supplementary `resources.json` | Brave (`adblock-resources`) | MPL-2.0 | Redirect and script resources |
| uBO scriptlets | `gorhill/uBlock` | GPLv3 | Generated offline from source and bundled as data, never compiled into the Waterfox binary |
| Filter lists | Various maintainers | Various open licences | Terms vary by list and must be checked per source |
| Waterfox integration | Waterfox | MPL-2.0 | Rust/C++/JS integration and UI |
