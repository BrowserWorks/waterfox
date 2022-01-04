# Building Waterfox

This guide will walk you through the process of building Waterfox from source code.

## Prerequisites

### System Requirements

- **RAM**: At least 16GB (32GB recommended)
- **Disk Space**: At least 40GB free space
- **CPU**: Modern multi-core processor (8+ cores recommended)

### Operating System

Waterfox can be built on:
- **Linux**: Ubuntu 22.04 or newer recommended
- **macOS**: macOS 15 Sonoma (ideally always the latest version)
- **Windows**: We strongly recommend using WSL2 (Windows Subsystem for Linux) with Ubuntu 24.04 instead of native Windows building

## Development vs. Production Builds

Before starting, understand there are two main build types:

### Development Builds

**Purpose:** Quick iteration, testing, and debugging
- Uses simpler configurations with fewer optimizations
- Faster build times
- Suitable for testing code changes and features

### Production Builds

**Purpose:** Creating optimized, release-quality builds
- Uses aggressive optimizations (LTO, PGO)
- Much slower build times but produces faster executables
- Requires specific toolchain versions
- Uses the same process as our official releases

## Setting Up the Build Environment

### Common Dependencies

1. **Git**: For checking out the source code
2. **Rust**: Install via [rustup](https://rustup.rs/)
3. **Python 3**: Required for the build system

### Linux (Ubuntu/Debian)

```bash
# Install build dependencies
sudo apt update
sudo apt install git python3 python3-pip nasm patchelf

# Set up Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### macOS

```bash
# Install Homebrew if not already installed
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install dependencies
brew install python3 nasm

# Set up Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
```

### Windows (via WSL2)

1. Install WSL2 with Ubuntu:
   ```
   wsl --install ubuntu
   ```

2. Open the Ubuntu terminal and install dependencies:
   ```bash
   sudo apt update
   sudo apt install git python3 python3-pip nasm

   # Set up Rust
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   source $HOME/.cargo/env
   ```

## Getting the Source Code

```bash
# Clone the repository
git clone https://github.com/BrowserWorks/Waterfox.git --recursive
cd Waterfox

# If you forgot the --recursive flag when cloning:
git submodule update --init
```

## Understanding the Bootstrap Process

Waterfox uses Mozilla's bootstrap system which automatically downloads toolchain components. This is important to understand:

- The bootstrap system handles downloading compilers and tools
- For **development builds**, it downloads everything automatically
- For **production builds**, some components need manual installation

To manually bootstrap dependencies:

```bash
# Install browser build dependencies
./mach bootstrap --application-choice=browser
```

## Building Waterfox - Quick Development Builds

For quick development builds, use the default `.mozconfig`:

```bash
# Start the build
./mach build
```

This will:
1. Download necessary toolchains via bootstrap
2. Build Waterfox with basic optimizations
3. Create a development-oriented build

After building, run your development build:

```bash
./mach run
```

## Building Waterfox - Production Builds

Production builds require more setup and time, but produce optimized executables like our official releases.

### Critical Notice: Version Alignment Required

When building production versions of Waterfox, the LLVM version used by Clang **must match** the LLVM version used by Rust. This is not optional - mismatched versions will cause build failures during Link Time Optimization (LTO).

Typical error with mismatched versions:
```
lld: error: Invalid attribute group entry
```

This happens because:
1. LTO requires compatible LLVM IR from both C/C++ (Clang) and Rust code
2. Each Rust version is built with a specific LLVM version
3. When these don't match, the linker cannot properly optimize across languages

### Current Requirements

As of this writing:
- **Rust 1.82-1.86**: Uses LLVM 19, requiring **Clang 19**
- **Rust 1.87+**: Will use LLVM 20, requiring **Clang 20**

This is why we specify exact Clang versions in the production build instructions rather than using system-provided compilers.

For development builds, this alignment isn't necessary because we disable LTO to improve build times.

### Step 1: Install LLVM/Clang manually

Production builds require specific LLVM/Clang versions:

```bash
# Download Mozilla's Clang 19 (pick appropriate platform)
mkdir -p $HOME/.mozbuild

# For Linux:
curl -L https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.cache.level-3.toolchains.v3.linux64-clang-19.latest/artifacts/public/build/clang.tar.zst -o clang.tar.zst
tar -xvf clang.tar.zst -C $HOME/.mozbuild

# For macOS Intel:
# curl -L https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.cache.level-3.toolchains.v3.macosx64-clang-19.latest/artifacts/public/build/clang.tar.zst -o clang.tar.zst
# tar -xvf clang.tar.zst -C $HOME/.mozbuild

# For macOS ARM:
# curl -L https://firefox-ci-tc.services.mozilla.com/api/index/v1/task/gecko.cache.level-3.toolchains.v3.macosx64-aarch64-clang-19.latest/artifacts/public/build/clang.tar.zst -o clang.tar.zst
# tar -xvf clang.tar.zst -C $HOME/.mozbuild
```

### Step 2: Select appropriate platform configuration

Link the configuration for your platform:

```bash
# For Linux:
ln -sf .mozconfig-x86_64-pc-linux-gnu .mozconfig

# For macOS Intel:
# ln -sf .mozconfig-x86_64-apple-darwin .mozconfig

# For macOS ARM64:
# ln -sf .mozconfig-aarch64-apple-darwin .mozconfig

# For Windows (in WSL):
# ln -sf .mozconfig-x86_64-pc-windows-msvc .mozconfig
```

### Step 3: Choose release type

Decide if you're building a release or beta version:

```bash
# For a stable release build:
export WFX_RELEASE=1

# For a beta/pre-release build:
# export WFX_PRE_RELEASE=1
```

### Step 4: Build with Profile Guided Optimization (PGO)

PGO creates faster executables by optimizing based on actual usage patterns. This is a two-stage process:

```bash
# Stage 1: Generate instrumented build
export GEN_PGO=1
./mach build
./mach package

# Run profile collection
./mach python build/pgo/profileserver.py --binary ./obj-*/dist/waterfox/waterfox

# Stage 2: Build with collected profile data
./mach clobber
unset GEN_PGO
export USE_PGO=1
./mach build
./mach package
```

The final package will be in the `obj-*/dist/` directory.

### Step 5: Create package

```bash
./mach package
```

## Understanding Build Configuration Files

Waterfox includes several platform-specific config files:

- `.mozconfig`: Simple version for development builds
- `.mozconfig-x86_64-pc-linux-gnu`: Linux x64 production build
- `.mozconfig-x86_64-apple-darwin`: macOS Intel production build
- `.mozconfig-aarch64-apple-darwin`: macOS ARM64 production build
- `.mozconfig-x86_64-pc-windows-msvc`: Windows x64 production build

### Key differences between development and production configs:

1. **Compiler optimization levels**:
   - Development: `-Os -w` (size optimization)
   - Production: `-O3 -w` with CPU-specific tuning flags

2. **Link Time Optimization (LTO)**:
   - Development: Disabled for faster build times
   - Production: Enabled with `--enable-lto=full`

3. **Rust optimization**:
   - Development: Default level
   - Production: Maximum (`RUSTC_OPT_LEVEL=3`)

4. **Profile-Guided Optimization**:
   - Development: Not used
   - Production: Two-stage process as described above

5. **Bootstrap settings**:
   - Development: Full bootstrap (`--enable-bootstrap`)
   - Production: Partial bootstrap (`--enable-bootstrap=-clang,-sccache`)

6. **Mozilla official flags**:
   - Development: Not set
   - Production: Sets `MOZILLA_OFFICIAL=1`

## Advanced Topics

### Multi-locale Build

To build with multiple language packs:

```bash
./mach package-multi-locale --locales ar cs da de el en-GB en-US es-ES es-MX fr hu id it ja ko lt nl nn-NO pl pt-BR pt-PT ru sv-SE th vi zh-CN zh-TW
```

### Custom Version Display

To set a custom version for display:

```bash
echo "My Custom Version" > browser/config/version_display.txt
```

### Using sccache to Speed Up Builds

To enable compiler caching (reduces rebuild times):

```bash
cargo install sccache
# Make sure your .mozconfig includes:
# ac_add_options --with-ccache=sccache
```

## Troubleshooting

### Common Issues

- **Bootstrap failures**: Check internet connection and try `./mach bootstrap` again
- **Out of memory errors**: Increase available RAM or reduce parallel jobs
- **Rust errors**: Run `rustup update` and add required targets
- **Slow builds**: Enable sccache and ensure adequate disk space
- **Signature verification failures**: Set `MOZ_REQUIRE_SIGNING=0`

### Getting Help

If you encounter issues not covered here:
- Check our [GitHub issues](https://github.com/BrowserWorks/Waterfox/issues)
