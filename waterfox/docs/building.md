# Building Waterfox

Waterfox uses the Mozilla build system. The usual Firefox setup documentation and `./mach` commands apply. Waterfox adds its own mozconfigs and product files to the upstream tree.

## Mozconfigs

The shared configuration lives in `waterfox/build/mozconfig.common`. The entry files are small parameter manifests that source it:

- `.mozconfig` at the repository root for local host builds. It stays at the root so `./mach` picks it up automatically when `MOZCONFIG` is not set.
- `waterfox/build/mozconfig-x86_64-pc-linux-gnu` for Linux x64 release builds.
- `waterfox/build/mozconfig-aarch64-unknown-linux-gnu` for Linux ARM64 release builds.
- `waterfox/build/mozconfig-x86_64-pc-windows-msvc` for Windows x64 cross builds.
- `waterfox/build/mozconfig-aarch64-pc-windows-msvc` for Windows ARM64 cross builds.
- `waterfox/build/mozconfig-x86_64-apple-darwin` and `waterfox/build/mozconfig-aarch64-apple-darwin` for macOS builds.

CI selects a target with `MOZCONFIG=waterfox/build/mozconfig-<triple>`. The release and prerelease paths are selected with the `WFX_RELEASE` and `WFX_PRE_RELEASE` environment variables. Those modes enable the Waterfox release settings in the mozconfigs, including official build flags and Waterfox update configuration. The manifests pass target specifics to the shared fragment through lowercase `wfx_*` shell variables; keep them lowercase, because configure imports uppercase shell variables from the mozconfig.

## Local build workflow

For normal local development, use the same entry points as Firefox:

```sh
./mach bootstrap
./mach build
./mach package
./mach test --auto
```

Use `./mach build faster` only for front end changes that do not require C++, Rust, or generated binary rebuilds. Use `./mach build binaries` for changes limited to compiled code when front end packaging is not needed.

Before a local release build or package, refresh the bundled Remote Settings dumps:

```sh
python3 scripts/update-remote-settings-dumps.py
```

The script reads `WaterfoxSettingsPolicy.requiredOfflineDumps` and updates the source dumps from Mozilla Remote Settings. Waterfox's search configuration and icons are static browser resources and are not part of this refresh.

## CI build workflow

The GitHub Actions build workflow is `.github/workflows/build.yml`. It builds these targets:

- Windows x64.
- Windows ARM64.
- Linux x64.
- Linux ARM64.
- macOS x86_64.
- macOS aarch64.

Linux x64 and Windows cross builds use the pinned Linux clang toolchain from Taskcluster. macOS uses the pinned macOS aarch64 clang toolchain from Taskcluster. Linux ARM64 builds on the ARM64 Namespace runner with the system `clang` and `lld`; this still needs runner validation.

The Linux and macOS target mozconfigs set `MOZ_PGO=1`, so `./mach build` runs the instrumented build, profile collection, and profile-use build automatically for those native targets. Windows builds run from the Linux build host, so they do not use the automatic `MOZ_PGO=1` path.

Each fresh build job runs `python3 scripts/update-remote-settings-dumps.py` before `./mach build`, so release artefacts use current offline Remote Settings records from Mozilla. The Windows x64 PGO job does not run this step because it profiles the instrumented artefact that was already built.
