# Waterfox OBS packaging

This directory is the deb and rpm recipe for the openSUSE Build Service. OBS does not compile anything here. It takes the Linux tarball that CI has already built, VMP signed and uploaded to the CDN, repacks it as deb and rpm, signs the packages with the project key and hosts the apt and yum repositories.

The binaries are stripped and VMP signed before they reach OBS. Nothing in this recipe may touch them. Any change to the binaries breaks the Widevine signature and DRM stops working. That is why the spec turns off rpm's post install processing and `debian.rules` overrides `dh_strip`.

## Files

- `_service`: tells OBS to download `Source0` from the CDN.
- `waterfox.spec`: rpm recipe, install only.
- `waterfox.dsc`, `debian.control`, `debian.changelog`, `debian.compat`, `debian.rules`, `debian.waterfox.postinst`, `debian.waterfox.prerm`: deb recipe in OBS's flat `debian.*` layout.
- `waterfox.desktop`, `usr.bin.waterfox` (AppArmor), `waterfox.appdata.xml`, `package-prefs.js`, `waterfox.1`: assets both recipes install. They exist twice, plain for rpm and `debian.`-prefixed for deb, because debtransform only copies prefixed files into `debian/`.

## Versions

Each release has two version strings. The CDN path uses the release tag as is, e.g. `6.7.0-beta.2`. The package version swaps the hyphen for a tilde, `6.7.0~beta.2`, because rpm forbids hyphens in `Version` and both rpm and dpkg sort `~` before the plain release, so a beta upgrades cleanly to the final build. Stable versions are the same in both.

`Source0` downloads from the tag path on `https://cdn.waterfox.com` and renames the file to the package version with the `#/` fragment, so the spec and the dsc agree on the tarball name. The tag path never changes after upload; there is no `latest` object involved.

## Architectures

x86_64 and aarch64 build from the same templates. debtransform only copes with one source tarball per package, so each arch is its own OBS package: `waterfox` and `waterfox-aarch64`. `@RPM_ARCH@` and `@DEB_ARCH@` fill in the CDN path, `ExclusiveArch` and the dsc architecture. The binary packages are all named `waterfox`, so users see one package either way.

## How a release reaches OBS

`scripts/ci/obs-publish.sh` runs from `production.yml` after the tarballs land on the CDN. It:

1. Fills the version and arch placeholders into the templates and commits the result to the `obs/waterfox` branch, one subdirectory per arch. Every release is a normal git commit you can diff and revert.
2. Pokes OBS with a `runservice` trigger token. Each package mirrors its subdirectory of the branch via scmsync, so the poke makes OBS pull the branch and run `download_files`.
3. Polls the public source API until the synced spec has the new version and the services succeeded. A missing or unreachable tarball fails `download_files` and with it the release job.

There is no OBS username or password in CI. The trigger token can start a service run and nothing else. Write access to the recipe is ordinary push access to the packaging branch.

## How it was setup

1. Create the `waterfox` and `waterfox-aarch64` packages in `isv:BrowserWorks` and give every repository both `x86_64` and `aarch64`.
2. Point each package at its subdirectory of the packaging branch (`osc meta pkg isv:BrowserWorks <package> -e`):
   - `waterfox`: `<scmsync>https://github.com/BrowserWorks/waterfox.git?subdir=waterfox#obs/waterfox</scmsync>`
   - `waterfox-aarch64`: `<scmsync>https://github.com/BrowserWorks/waterfox.git?subdir=waterfox-aarch64#obs/waterfox</scmsync>`
3. Create a trigger token with no package binding, so one token can poke both packages: `osc token --create --operation runservice`. Store the secret in GitHub as `OBS_TRIGGER_TOKEN`.
4. The `obs/waterfox` branch must not be protected or CI cannot push to it.
5. Publish the project's signing key (`osc signkey isv:BrowserWorks`) on the website and CDN so users can import it.

## Build notes

- rpm generates Provides and Requires from the bundled libraries and they satisfy each other. Only `libonnxruntime.so` is excluded from that; nothing provides it.
- Installed deb and rpm packages have been checked with working DRM, so a package build that only installs files keeps the VMP signature intact.
