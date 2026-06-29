# Linux packaging

Waterfox has two Linux package paths in the tree.

## Local repackage templates

The `./mach repackage deb` and `./mach repackage rpm` commands can use the Waterfox templates under `waterfox/browser/installer/linux/app/`:

- `waterfox/browser/installer/linux/app/debian/`
- `waterfox/browser/installer/linux/app/rpm/`

These templates are useful for local package checks. They are not used for shipped deb and rpm packages.

The repackage commands know about Linux ARM64 package roots:

- Debian x64 and architecture independent packages use `/srv/jessie-amd64` when
  that root exists.
- Debian x86 packages use `/srv/jessie-i386` when that root exists.
- Debian ARM64 packages use `/srv/buster-amd64` when that root exists.
- RPM packages use `/srv/rpm-{arch}` when that root exists.

If a root is missing, the command falls back to the current host.

## Release packages through OBS

Release deb and rpm packages are built by the openSUSE Build Service (OBS), not by GitHub Actions. The OBS recipe lives in `waterfox/browser/installer/linux/obs/`.

The OBS recipe wraps the prebuilt Linux tarball that GitHub Actions signs with Waterfox's Widevine VMP key. OBS does not compile Waterfox and never receives the VMP key. It installs the signed files into deb and rpm packages, signs the packages and repositories with the OBS project key, and hosts the apt and yum repositories.

The split is:

- GitHub Actions owns the confidential Widevine VMP signing step.
- OBS owns package and repository signing.
- The package recipes must not strip or alter Waterfox binaries, because that
  would invalidate the VMP signature and break DRM playback.

The current OBS recipe is validated for x86_64.

## Per release OBS update

The release tarball must already be on the CDN before OBS fetches it. For production releases, `.github/workflows/production.yml` moves the signed Linux tarball to the release CDN path, then posts a signed tag push payload to the OBS workflow endpoint. The OBS workflow in `.obs/workflows.yml` triggers source services and rebuilds the `home:MrAlex94:waterfox/waterfox` package.

CI authenticates with OBS using an OBS workflow token, not an OBS account password. Store the token ID and secret as `OBS_WORKFLOW_TOKEN_ID` and `OBS_WORKFLOW_TOKEN_SECRET`. The OBS `_service` uses the tag name as `@PARENT_TAG@`, runs `set_version`, and lets `download_files` fetch the signed Linux tarball from the versioned CDN URL in `waterfox.spec`.

With the current OBS seed files, `set_version` turns the tag into RPM `Version: <version>` with `Release: 0%{?dist}` and Debian `<version>-0` package versions. It also replaces `@VERSION@` in `waterfox.dsc`, so the Debian `Files` entry matches the downloaded `waterfox-<version>.tar.bz2` archive.
