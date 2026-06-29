# Linux packaging

Release deb and rpm packages are built by the openSUSE Build Service (OBS), not by GitHub Actions. The recipe lives in `waterfox/browser/installer/linux/obs/`; its README has the detail.

OBS wraps the prebuilt Linux tarball that GitHub Actions builds, signs with the Widevine VMP key and uploads to the CDN. OBS does not compile Waterfox and never sees the VMP key. It installs the signed files into deb and rpm packages, signs the packages and repositories with the OBS project key, and hosts the apt and yum repositories.

The split is:

- GitHub Actions owns the confidential Widevine VMP signing step.
- OBS owns package and repository signing.
- The recipes must not strip or alter the binaries, or the VMP signature breaks
  and DRM stops working.

Both x86_64 and aarch64 build from the same recipe templates, one OBS package per arch: `waterfox` and `waterfox-aarch64`.

## Per release

`scripts/ci/obs-publish.sh` runs from `.github/workflows/production.yml` once the tarballs are on the CDN. It fills the version and arch placeholders into the recipe, commits the result to the `obs/waterfox` branch, and pokes OBS with a `runservice` trigger token. OBS mirrors that branch via scmsync, downloads the tarballs and rebuilds. The script then polls the public source API and fails the release job if OBS could not fetch a tarball.

CI holds no OBS username or password, only the trigger token (`OBS_TRIGGER_TOKEN`), which can start a service run and nothing else.
