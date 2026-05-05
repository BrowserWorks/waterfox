# Waterfox blocker component

I use this as a working reference when reading or changing blocker code. The engine is Brave's `adblock-rs` v0.12.1 (MPL-2.0) - the Waterfox integration around it is also MPL-2.0.

## What it is

Waterfox's native content blocker, wired into Gecko through Rust, C++, XPCOM, and browser JS modules.

1. Rust FFI at `toolkit/components/content-classifier/content_classifier_engine/src/lib.rs` wraps `adblock-rs` and exposes a C ABI for request checks, CSP directives, cosmetic resources, serialisation, and resource loading.
2. The C++ wrapper `ContentClassifierEngine` bridges Gecko to the Rust FFI with typed C++ methods.
3. XPCOM service exposing `nsIWaterfoxBlockerEngine` to JS, defined in `WaterfoxBlockerXPCOM.cpp`, `nsIWaterfoxBlocker.idl`, and `components.conf`.
4. Browser JS service (`WaterfoxBlockerService.sys.mjs`) owns the engine lifecycle, list fetching and caching, My Filters in the profile, request blocking, CSP headers, site exceptions, and the count of blocked requests.
5. JSWindowActor pair (`WaterfoxBlockerParent.sys.mjs`, `WaterfoxBlockerChild.sys.mjs`). The parent fetches cosmetic and scriptlet data from the service, the child applies selectors and injects scriptlets in content documents.
6. Preferences UI (`WaterfoxBlockerPreferences.sys.mjs`) drives the controls in `about:preferences` along with the exceptions, filter list, custom list, and My Filters dialogs.
7. Toolbar button, panel, and detection of conflicting extensions (`WaterfoxBlockerPanel.sys.mjs`, `WaterfoxBlockerExtensionDetector.sys.mjs`). Registers the toolbar widget through `CustomizableUI`, injects a standalone `<panel>` into each browser window, handles the site toggle and badge updates, and prompts the user when a competing ad blocker extension is installed. Setting `waterfox.blocker.coexist` to `true` in `about:config` suppresses the prompt and lets the built-in blocker run alongside extensions.

## Toolbar panel

`WaterfoxBlockerPanel.sys.mjs` owns the blocker's chrome UI outside `about:preferences`. Each browser window gets a standalone `<panel>` injected under `mainPopupSet`, opened with `PanelMultiView.openPopup(...)` anchored to the toolbar button. The DOM mirrors the protections popup (`panel-no-padding` + `panelmultiview` + `PanelUI-subView` with `mainview-with-header="true"` and `has-custom-header="true"`), so width and typography come from existing Gecko panel classes and design tokens.

The button badge and panel count come from the service's running tally of blocked requests, refreshed on its observer topics plus tab and navigation events. Site toggle semantics stay as `pressed = blocking active for current site` - toggling writes or removes a site exception through the service, closes the panel, and reloads the tab. `waterfox.blocker.showBadge` controls badge visibility, and the button itself stays visible (muted) when global blocking is off.

## Request and response flow

### Network requests

`WaterfoxBlockerService` observes `http-on-modify-request`, normalises the request context, and calls `checkRequestDetailed(...)` on `nsIWaterfoxBlockerEngine`. XPCOM forwards through the C++ `ContentClassifierEngine` into the Rust FFI and `adblock-rs`. If the request matches and there's no exception, non-document resources are cancelled and top-level documents are redirected to `blockedPage.xhtml` with a bypass token.

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

## Known limitations

`$redirect` payloads aren't returned as synthetic responses yet. The engine produces the data, but the request handler still cancels matched requests instead of returning the payload.

Scriptlet timing can miss the earliest injection window on the first visit to some SPAs, mainly YouTube, where a scriptlet may need to run before actor and resource setup has settled.

## Where to look

Request lifecycle and cache rebuild logic live in `WaterfoxBlockerService.sys.mjs`. The JS→native boundary is in `WaterfoxBlockerXPCOM.cpp` and `nsIWaterfoxBlocker.idl`. Exact `adblock-rs` calls sit in the Rust FFI at `content_classifier_engine/src/lib.rs`. Cosmetic filtering and scriptlet injection timing are in the parent and child actors. The preferences, panel, and extension-detector modules cover the UI and policy surface.
