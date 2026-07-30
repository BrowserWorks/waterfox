# Waterfox OBS packaging recipe

This directory contains the Waterfox deb and rpm packaging recipe for the openSUSE Build Service (OBS). OBS does not build Waterfox from source. It wraps the prebuilt Linux tarball that GitHub Actions signs with Widevine VMP and publishes to the CDN, signs the packages and repositories with the OBS project key, and hosts apt and yum repositories.

The binaries are already stripped and signed with VMP. Nothing here may strip or otherwise alter them, or the VMP signature breaks and DRM stops working. The rpm spec disables rpm post install processing and the Debian rules override `dh_strip`.å

## Files

- `_service` - fetches the materialized recipe's `Source0`.
- `waterfox.spec` - rpm recipe (install only).
- `waterfox.dsc`, `debian.control`, `debian.changelog`, `debian.compat`,
  `debian.rules`, `debian.waterfox.postinst`, `debian.waterfox.prerm` - deb
  recipe (install only) in OBS flat `debian.*` form.
- `waterfox.desktop`, `usr.bin.waterfox` (AppArmor), `waterfox.appdata.xml`
  (AppStream), `package-prefs.js`, `waterfox.1` - shared assets installed by
  both recipes.

## Scope and versioning

The recipe covers x86_64 and aarch64. The CDN base is `https://cdn.waterfox.com`, in `Source0` of `waterfox.spec`.

OBS `debtransform` can only handle a single source tarball per Debian package, so each architecture gets its own OBS package: `waterfox` (x86_64/amd64) and `waterfox-aarch64` (aarch64/arm64). Both are rendered from this one template directory; `@RPM_ARCH@` and `@DEB_ARCH@` select the CDN path and the package architectures. The binary packages are all named `waterfox`, so users see one package per repository regardless of architecture.

Release automation keeps two versions. The upstream version is the exact release tag used by the CDN, such as `6.7.0-beta.2`. The package version uses `~` for prereleases, such as `6.7.0~beta.2`, so both rpm and dpkg order it before `6.7.0`. Stable versions are unchanged.

`Source0` fetches the immutable raw CDN path and uses the RPM URL fragment syntax to store the archive under the package-version filename expected by the Debian recipe.

The recipe reaches OBS through git, not through authenticated API commits. `scripts/ci/obs-publish.sh` substitutes the two versions into the templates and pushes the result to the `obs/waterfox` orphan branch of this repository, and the OBS package mirrors that branch with `scmsync`. The only OBS credential in GitHub is a trigger token that can start a service run and nothing else.

## Initial setup

1. Create the `waterfox` and `waterfox-aarch64` packages in `home:MrAlex94:waterfox` and configure the project repositories for `x86_64` and `aarch64` only.
2. Point each package at its subdirectory of the packaging branch (`osc meta pkg home:MrAlex94:waterfox <package> -e`):
   - `waterfox`: `<scmsync>https://github.com/BrowserWorks/waterfox.git?subdir=waterfox#obs/waterfox</scmsync>`
   - `waterfox-aarch64`: `<scmsync>https://github.com/BrowserWorks/waterfox.git?subdir=waterfox-aarch64#obs/waterfox</scmsync>`
3. Create a service trigger token that can reach both packages: `osc token --create --operation runservice` (no package binding). Store the secret in GitHub as `OBS_TRIGGER_TOKEN`.
4. Make sure the `obs/waterfox` branch is not protected, so the release credentials can push to it.
5. Publish the OBS project's public signing key (Project -> Signing Keys, or `osc signkey home:MrAlex94:waterfox`) on the website and CDN so users can import it.

## Per release

The tarball must exist on the CDN before OBS fetches it. For every production release, including prereleases, `.github/workflows/production.yml` runs `scripts/ci/obs-publish.sh`, which:

1. Renders the recipe once per architecture (version and arch placeholders) into the `waterfox/` and `waterfox-aarch64/` subdirectories of the `obs/waterfox` branch, so every release is a plain git commit that can be diffed and reverted.
2. Kicks both OBS `scmsync` mirrors with the `runservice` trigger token, which re-syncs the sources and runs `download_files`.
3. Polls the anonymous `/public/source` OBS API until each synced spec carries the new version and the services report success, so a missing or unreachable CDN source fails the release job.

The synced sources trigger the deb and rpm builds. OBS only ever clones the tiny packaging branch, no mutable latest-version object is involved, and no OBS username or password is stored in GitHub Actions.

## Status and what to expect

- The x86_64 rpm recipe builds successfully on the Fedora and openSUSE targets.
  The bundled libraries must remain visible to rpm's generated Provides and
  Requires so they satisfy themselves; only `libonnxruntime.so` is excluded.
- The x86_64 Debian recipe builds successfully through OBS `debtransform`.
  Shared assets intentionally exist twice, once as plain filenames for rpm and
  once as `debian.*` filenames for deb, because `debtransform` only copies the
  prefixed files into `debian/`.
- Installed deb and rpm packages have been run with working DRM, confirming that
  the VMP signature survives a package build that only installs files.
