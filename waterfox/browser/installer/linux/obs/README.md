# Waterfox OBS packaging

This directory contains the DEB and RPM recipes for the OpenSUSE Build Service. OBS does not compile anything here. Instead, it takes the Linux tarball that CI has built, VMP-signed and uploaded to the CDN. It then repacks the tarball as DEB and RPM files, signs the packages with the project key, and hosts the APT and YUM repositories.

The binaries are stripped and VMP-signed before reaching OBS. Nothing in this recipe may modify them. Any change to the binaries would break the Widevine signature, causing DRM to stop working. This is why the spec turns off RPM`s post-install processing and the `debian.rules` override `dh_strip`.

## Files

- _service: Fetches the tarball from the CDN and stores it under the package version. It uses `download_url` rather than `download_files` because `download_files` uses cURL to fetch, and cURL transfers from the OBS service hosts fail against the CDN even though the edge returns 200, while `download_url` uses wget, which the CDN serves normally.
- waterfox.spec: RPM recipe for installation only.
- waterfox.dsc, debian.control, debian.changelog, debian.compat, debian.rules, debian.waterfox.postinst, debian.waterfox.prerm: debian recipe in OBS`s flat debian.* layout.
- waterfox.desktop, usr.bin.waterfox (AppArmor), waterfox.appdata.xml, package-prefs.js, waterfox.1: assets that are installed by both recipes. These files exist twice: a plain version for RPM and a version with a `debian.` prefix for DEB, because debtransform only copies prefixed files into `debian/`.

## Versions

Each release has two version strings. The CDN path uses the release tag as it is, e.g. `6.7.0-beta.2`. The package version replaces the hyphen with a tilde, e.g. 6.7.0~beta.2, because RPM does not allow hyphens in the `Version` field. Both RPM and DPKG sort `~` before the plain release, so a beta upgrade can be performed seamlessly. Stable versions are the same in both.

The `_service` downloads from the tag path on `https://cdn.waterfox.com` and its `filename` parameter stores the file under the package version. This means that the spec and the DSC agree on the tarball name. `Source0` keeps the same URL with a `#/` fragment, so RPM resolves that name too. The tag path never changes after upload and there is no `latest` object involved.

## Architectures

The x86_64 and aarch64 builds use the same templates, but debtransform can only handle one source tarball per package. This means that each architecture requires its own OBS package: `waterfox` and `waterfox-aarch64`. The CDN path, ExclusiveArch and the dsc architecture are filled in by @RPM_ARCH@ and @DEB_ARCH@. The binary packages are all named `waterfox`, so users see one package either way.

## How a release reaches OBS

The script `scripts/ci/obs-publish.sh` is run from the file `production.yml` once the tarballs have been delivered to the CDN. It:

1. Fills the version and arch placeholders into the templates; and commits the result to the `obs/waterfox` branch (one subdirectory per arch). Every release is a normal Git commit that can be diffed and reverted.
2. It pokes OBS with a `runservice` trigger token. Each package mirrors its subdirectory of the branch via scmsync, prompting OBS to pull the branch and run the `download_url` service.
3. It polls the public source API until the synced spec has the new version and the services have succeeded. If the tarball is missing or unreachable, the `download_url` service fails and, with it, the release job.

There are no OBS usernames or passwords in CI. The trigger token can start a service run and nothing else. Writing access to the recipe is the same as ordinary push access to the packaging branch.

## How it was setup

1. Create the `waterfox` and `waterfox-aarch64` packages in `isv:BrowserWorks` and assign both `x86_64` and `aarch64` to each repository.
2. Point each package at its subdirectory of the packaging branch using the following command:
   - waterfox: <scmsync>https://github.com/BrowserWorks/waterfox.git?subdir=waterfox#obs/waterfox</scmsync>
   - waterfox-aarch64: https://github.com/BrowserWorks/waterfox.git?subdir=waterfox-aarch64#obs/waterfox
3. Create a trigger token with no package binding so that one token can update both packages: `osc token --create --operation runservice`. Store the secret in GitHub as OBS_TRIGGER_TOKEN.
4. The `obs/waterfox` branch must not be protected, otherwise CI will not be able to push to it.
5. Publish the project's signing key (`osc signkey isv:BrowserWorks` ) on the website and CDN so that users can import it.

## Build notes

- RPM generates Provides and Requires from the bundled libraries, which satisfy each other. However, only libonnxruntime.so is excluded from this process, as nothing provides it.
- Installed DEB and RPM packages have been checked with working DRM, so a package build that only installs files keeps the VMP signature intact.
