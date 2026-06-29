# Release workflow validation

The Waterfox release workflows live under `.github/workflows/`:

- `build.yml` builds desktop artefacts.
- `sign.yml` signs Windows, macOS, and Linux artefacts, creates MAR files, and
  writes release metadata.
- `stage.yml` uploads signed artefacts to R2 staging and submits staging AUS
  update metadata.
- `production.yml` moves artefacts to the release paths, creates the GitHub
  release as a draft during the soft release, triggers the OBS package workflow
  for releases that are not prereleases, submits production AUS metadata, and
  controls rollout. The hard release publishes the GitHub release, which also
  creates the release tag.
- `publish.yml` chains staging and production.
- `pipeline.yml` chains build, sign, and publish.

The workflows reuse the infrastructure and secret names from the previous Waterfox release pipeline. The signing helpers and keys are decoded from secrets at runtime and are not stored in the source tree.

## What must be validated on runners

Before treating the pipeline as ready for release, run it on Namespace runners with the real secrets configured and check:

- Windows x64 cross build with `--target=x86_64-pc-windows-msvc`.
- Windows ARM64 cross build with `--target=aarch64-pc-windows-msvc`.
- Windows redist discovery through `--with-redist`.
- PGO on Linux x64, Linux ARM64, macOS x86_64, and macOS aarch64.
- Linux x64 build on the legacy Linux profile.
- Linux ARM64 build on the ARM64 Namespace runner.
- Remote Settings dump refresh step in every fresh build job, excluding the
  Windows x64 PGO job that profiles the instrumented artefact that was already
  built. Confirm `scripts/update-remote-settings-dumps.py` succeeds and logs
  current or updated timestamps for every required dump.
- macOS x86_64 and aarch64 builds, app unification, signing, notarization, and
  DMG creation.
- Azure Trusted Signing for Windows executables, DLLs, and installers.
- Widevine VMP signing on Windows, macOS, and Linux.
- MAR creation for each update platform.
- R2 staging and release paths.
- AUS staging and production JSON shape, including the ARM64 platform keys.
- OBS workflow token trigger with `OBS_WORKFLOW_TOKEN_ID` and
  `OBS_WORKFLOW_TOKEN_SECRET` after the signed Linux tarball reaches the release
  CDN path. Confirm the OBS workflow run reaches `trigger_services`,
  `download_files` downloads `waterfox-<version>.tar.bz2`, and `set_version`
  rewrites RPM and Debian versions before the package rebuild starts.

## Manual re-sign and re-publish

`sign.yml` and `publish.yml` can run standalone against artefacts from an
earlier run. Two constraints apply:

- The "latest successful run" fallback only sees standalone Build or Sign
  dispatches. The chained Deployment pipeline executes inside one workflow run,
  so re-signing or re-publishing a pipeline build requires passing the
  Deployment run id explicitly.
- Workflow artefacts expire after at most 30 days on Namespace runners. After
  that, a release must be rebuilt before it can be re-signed. The CDN release
  paths remain the long term archive.

## Update platforms

The release metadata currently uses these platform keys:

- `WINNT_x86_64`
- `WINNT_aarch64`
- `Darwin_x86_64-aarch64`
- `Linux_x86_64`
- `Linux_aarch64`

macOS ships as a universal app and has one update entry. Windows and Linux have separate x64 and ARM64 entries.

## PGO status

The Linux and macOS target mozconfigs set `MOZ_PGO=1`, which lets `./mach build` run the instrumented build, profile collection, and profile-use build automatically. Windows builds run from the Linux build host, so they do not use the automatic `MOZ_PGO=1` path.

## Package repositories

The GitHub release workflow publishes the signed Linux tarball to the CDN, then triggers the OBS package workflow for production releases that are not prereleases. OBS source services use the release tag to fetch that tarball and package it into deb and rpm repositories. With the current seed files, OBS produces RPM release `0%{?dist}` and Debian revision `-0` packages for the tag version. Do not move Widevine VMP signing into OBS. OBS should never receive the VMP key.
