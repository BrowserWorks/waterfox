# Blocker assets and licensing

Waterfox ships fallback blocker assets so the blocker can start when the profile cache is empty or a network refresh is unavailable. The catalog is `waterfox/browser/components/blocker/assets/list_catalog.json`; bundled fallback files live under `waterfox/browser/components/blocker/assets/filters/` and `waterfox/browser/components/blocker/assets/resources/`.

## Bundled fallback assets

The default bundled assets are:

- EasyList and EasyPrivacy fallback lists.
- uBlock Origin fallback filter lists from `uBlockOrigin/uAssets`.
- AdGuard tracking parameter fallback rules.
- Peter Lowe's Ad and Tracking Server fallback list.
- Brave `adblock-resources` redirect and script resources.
- Generated uBlock Origin redirect resource data.
- Generated uBlock Origin scriptlet data.

Regional and optional catalog entries can be downloaded through the blocker list cache, but they are not currently bundled in the tree unless their catalog entry sets `bundled` and a matching file exists under `assets/filters/`.

## Licence handling

`about:license` is the notice shown in the product. Keep it in sync whenever a bundled blocker asset is added, removed, regenerated from a new upstream source, or relicensed.

| Asset | Upstream | Licence or notice |
| --- | --- | --- |
| Brave entries in `resources/resources.json` | Brave `adblock-resources` | MPL-2.0 |
| uBO redirect entries in `resources/resources.json` | `gorhill/uBlock` | GPL-3.0 |
| `resources/ubo-scriptlets.json` | `gorhill/uBlock` | GPL-3.0 |
| `ublock-*.txt` fallback filters | `uBlockOrigin/uAssets` | GPL-3.0 |
| `adguard-tracking-protection.txt` | `AdguardTeam/AdGuardFilters` | GPL-3.0 |
| `easylist.txt` and `easyprivacy.txt` | EasyList authors | GPL-3.0-or-later or CC BY-SA-3.0-or-later. Waterfox uses the GPL-3.0 option in `about:license`. |
| `easylist-cookie.txt` | EasyList authors | CC BY 3.0 |
| `peter-lowe-adservers.txt` | Peter Lowe | Upstream credit and policy notice. The bundled file does not identify a standard licence header. |
| `list_catalog.json` and integration code | Waterfox | MPL-2.0 |

## Update checklist

When refreshing bundled blocker assets:

1. Regenerate or replace only the intended files under `assets/`.
2. Check each refreshed file's leading metadata for title, source, licence, and
   policy URLs.
3. Update `waterfox/browser/components/blocker/README.md` if the asset set or
   licence handling changes.
4. Update `toolkit/content/license.html` for any notices that changed in the product.
5. Regenerate the `resources.json` and `ubo-scriptlets.json` bundles served by
   AUS from the same outputs when the server update pipeline is refreshed.
6. Record the source URLs, revisions, and validation in the migration or release
   notes for the change.
