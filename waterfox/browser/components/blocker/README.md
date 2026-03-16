# Waterfox blocker component

I use this README as a working reference when reading or changing blocker code.
It uses Brave’s `adblock-rs` v0.12.1 under MPL-2.0. Waterfox integration code in this component is also MPL-2.0.

## What this component is

This component is Waterfox’s native content blocker integrated into Gecko through Rust, C++, XPCOM, and browser JS modules.

## Architecture overview

The blocker has seven layers:

1. **Rust FFI layer**
   - File: `toolkit/components/content-classifier/content_classifier_engine/src/lib.rs`
   - Wraps `adblock-rs` and exposes C ABI functions for request checks, CSP directives, cosmetic resources, serialisation, and resource loading. Already implemented by Mozilla, with our changes on top to handle blocking ads as well as trackers.

2. **C++ content-classifier wrapper**
   - `ContentClassifierEngine` bridges Gecko to the Rust FFI and provides typed C++ methods.

3. **XPCOM service wrapper**
   - Files:
     - `waterfox/browser/components/blocker/WaterfoxBlockerXPCOM.cpp`
     - `waterfox/browser/components/blocker/nsIWaterfoxBlocker.idl`
     - `waterfox/browser/components/blocker/components.conf`
   - Exposes `nsIWaterfoxBlockerEngine` to JS.

4. **Browser JS service**
   - File: `waterfox/browser/components/blocker/WaterfoxBlockerService.sys.mjs`
   - Owns engine lifecycle, list fetch/cache/rebuild, request blocking, CSP header application, site exceptions, and tracking of blocked counts.

5. **JSWindowActor pair**
   - Files:
     - `waterfox/browser/components/blocker/WaterfoxBlockerParent.sys.mjs`
     - `waterfox/browser/components/blocker/WaterfoxBlockerChild.sys.mjs`
   - Parent fetches cosmetic/scriptlet data from the service.
   - Child applies selectors and injects scriptlets in content documents.

6. **Preferences UI**
   - File: `waterfox/browser/components/blocker/WaterfoxBlockerPreferences.sys.mjs`
   - Provides blocker controls in `about:preferences`, plus exceptions and filter list dialogs.

7. **Toolbar button/panel and extension conflict detection**
   - Files:
     - `waterfox/browser/components/blocker/WaterfoxBlockerPanel.sys.mjs`
     - `waterfox/browser/components/blocker/WaterfoxBlockerExtensionDetector.sys.mjs`
   - Registers the standalone blocker toolbar widget via `CustomizableUI` (`type: "button"`).
   - Owns standalone `<panel>` injection/lifecycle per browser window, site toggle actions, settings navigation, and per-tab blocked-count badge updates.
   - Detects overlapping adblock extensions and prompts users when needed.

## Toolbar panel architecture notes

- `WaterfoxBlockerPanel.sys.mjs` is the owner of blocker chrome UI outside `about:preferences`.
- A standalone `<panel>` is injected into each browser window (under `mainPopupSet`) and opened with `PanelMultiView.openPopup(...)` anchored to the toolbar button.
- The panel DOM mirrors the protections popup structure (`panel-no-padding` + `panelmultiview` + `PanelUI-subView` with `mainview-with-header="true"` and `has-custom-header="true"`), so width/typography come from existing Gecko panel classes and design tokens.
- Button badge and panel count are sourced from `WaterfoxBlockerService` blocked-count state and refreshed from service observer topics plus tab/navigation events.
- Site toggle semantics remain `pressed = blocking active for current site`; toggling writes/removes a site exception through the service, closes the panel, and reloads the tab.
- Badge visibility is controlled by `waterfox.blocker.showBadge`, while the button remains visible (muted) when global blocking is off.

## Request and response flow

### Network request path

1. `WaterfoxBlockerService` observes `http-on-modify-request`.
2. It normalises request context and calls `checkRequestDetailed(...)` on `nsIWaterfoxBlockerEngine`.
3. XPCOM forwards to C++ `ContentClassifierEngine`, then to Rust FFI, then to `adblock-rs`.
4. If matched and not excepted:
   - requests for non-document resources are cancelled
   - requests for top-level documents are redirected to `blockedPage.xhtml` with a bypass token.

### Response path for CSP rules

1. `WaterfoxBlockerService` observes `http-on-examine-response` (and cached/merged variants).
2. For `document` and `subdocument`, it calls `getCspDirectives(...)`.
3. If directives exist, it sets `Content-Security-Policy` on the response.

### Cosmetic and scriptlet path

1. Child actor asks parent for cosmetic resources for the current URL.
2. Parent queries `WaterfoxBlockerService`.
3. Child applies hide selectors and generic hide updates.
4. Child injects scriptlets into the page main world when present.

## Scriptlet bundling approach

### Why this exists

uBO scriptlets now ship in an ESM format. The older `adblock-rs` resource-assembler route is deprecated and does not handle this format in a way that fits this integration.

Brave’s Node.js packaging flow is the reference approach, and this component follows it.

### Reference implementation

The dependency resolution and `fn.toString()` bundling algorithm are based on:

- https://github.com/brave/brave-core-crx-packager/pull/599

### Waterfox adaptation

The script `waterfox/browser/components/blocker/scripts/update-bundled-assets.js`:

1. Loads uBO `builtinScriptlets` from source.
2. Expands scriptlet dependencies recursively.
3. Serialises dependency functions and main function with `fn.toString()`.
4. Wraps placeholder argument handling (`{{1}}` .. `{{9}}`).
5. Encodes output as base64 resources in `assets/resources/ubo-scriptlets.json`.

These resources are generated offline and consumed at runtime as data.

## Licensing

| Item | Source | Licence | Notes |
|---|---|---|---|
| `adblock-rs` (v0.12.1) | Brave | MPL-2.0 | Core blocking engine |
| Supplementary `resources.json` | Brave (`adblock-resources`) | MPL-2.0 | Redirect and script resources |
| uBO scriptlets | `gorhill/uBlock` | GPLv3 | Generated offline from source and bundled as data, never compiled into Waterfox binary |
| Filter lists | Various maintainers | Various open licences | Terms vary by list and must be checked per source |
| Waterfox blocker integration code | Waterfox | MPL-2.0 | Rust/C++/JS integration and UI |

## Known limitations

1. **`$redirect` is not yet delivered as a synthetic response**
   - Redirect payload is available from engine results, but request handling still cancels matched requests instead of returning the data payload.

2. **Scriptlet timing on first visit**
   - On some pages (mainly YouTube and likely other SPAs where a scriptlet might modify requests), timing on first load can miss the earliest injection window before actor/resource setup settles.

## Practical orientation for contributors

If you are tracing behaviour:

- Start with `WaterfoxBlockerService.sys.mjs` for request lifecycle and cache/rebuild logic.
- Use `WaterfoxBlockerXPCOM.cpp` and `nsIWaterfoxBlocker.idl` for JS to native boundaries.
- Use Rust `content_classifier_engine/src/lib.rs` for exact `adblock-rs` calls.
- Use child/parent actor files for cosmetic filtering and scriptlet injection timing.
- Use preferences/panel/extension-detector modules for UI and policy surface.

The component is usable, but the limitations listed above still apply, especially synthetic redirect handling and edge cases in scriptlet timing on first visit.
