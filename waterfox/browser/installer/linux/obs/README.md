# Waterfox OBS packaging recipe

This directory contains the Waterfox deb and rpm packaging recipe for the openSUSE Build Service (OBS). OBS does not build Waterfox from source. It wraps the prebuilt Linux tarball that GitHub Actions signs with Widevine VMP and publishes to the CDN, signs the packages and repositories with the OBS project key, and hosts apt and yum repositories.

The binaries are already stripped and signed with VMP. Nothing here may strip or otherwise alter them, or the VMP signature breaks and DRM stops working. The rpm spec disables rpm post install processing and the Debian rules override `dh_strip`; keep it that way.

## Files

- `_service` - applies the release tag version and fetches `Source0`.
- `waterfox.spec` - rpm recipe (install only).
- `waterfox.dsc`, `debian.control`, `debian.changelog`, `debian.compat`,
  `debian.rules`, `debian.waterfox.postinst`, `debian.waterfox.prerm` - deb
  recipe (install only) in OBS flat `debian.*` form.
- `waterfox.desktop`, `usr.bin.waterfox` (AppArmor), `waterfox.appdata.xml`
  (AppStream), `package-prefs.js`, `waterfox.1` - shared assets installed by
  both recipes.

## Scope and versioning

The recipe is x86_64 only. The CDN base is `https://cdn.waterfox.com`, in `Source0` of `waterfox.spec`.

The OBS workflow file lives at `.obs/workflows.yml` in the repository root. The workflow triggers source services and rebuilds `home:MrAlex94:waterfox/waterfox` for tag push events. Keep that file tracked in Git so OBS can fetch it from the repository when the workflow token receives the trigger.

## Initial setup

1. Install and configure `osc` locally (`osc` reads credentials from
   `~/.config/osc/oscrc`).
2. Check out the OBS package and copy this recipe into it:

   ```sh
   osc checkout home:MrAlex94:waterfox waterfox
   cp waterfox/browser/installer/linux/obs/* home:MrAlex94:waterfox/waterfox/   # adjust paths
   cd home:MrAlex94:waterfox/waterfox
   osc addremove
   osc commit -m "Initialize Waterfox OBS recipe"
   ```

3. In the OBS web UI, confirm the repositories build only `x86_64` (disable any
   32-bit architecture; the spec's `ExclusiveArch` already guards rpm).
4. Publish the OBS project's public signing key (Project -> Signing Keys, or
   `osc signkey home:MrAlex94:waterfox`) on the website and CDN so users can
   import it.
5. Create an OBS workflow token for this repository's workflow integration. OBS
   also needs an SCM token with read access to this repository and commit status
   write access, as described in the OBS SCM/CI workflow integration docs.
6. Store the OBS workflow token ID and secret in GitHub as
   `OBS_WORKFLOW_TOKEN_ID` and `OBS_WORKFLOW_TOKEN_SECRET`.

## Per release

The tarball must exist on the CDN before OBS fetches it. For production releases that are not prereleases, `.github/workflows/production.yml` moves the signed Linux tarball to the release CDN path and then posts a signed GitHub compatible `push` payload with `ref: refs/tags/<version>` to the OBS workflow endpoint.

OBS handles the rest:

1. `.obs/workflows.yml` runs `trigger_services` for the `waterfox` package.
2. `_service` receives the release tag as `@PARENT_TAG@`.
3. `set_version` updates `waterfox.spec`, `waterfox.dsc`, and
   `debian.changelog`. With the current seed values, it rewrites RPM `Version`
   to the tag version and `Release` to `0%{?dist}`, rewrites Debian versions to
   `<version>-0`, and replaces `@VERSION@` in `waterfox.dsc` so the `Files`
   entry names `waterfox-<version>.tar.bz2`.
4. `download_files` reads `Source0` from the updated spec and downloads the
   signed Linux tarball from the CDN.
5. OBS rebuilds the deb and rpm packages and publishes the repositories.

No OBS username or password is stored in GitHub Actions.

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
