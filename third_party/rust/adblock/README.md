# adblock-rust

[![crates.io](https://img.shields.io/crates/v/adblock.svg)](https://crates.io/crates/adblock)
[![npmjs.com](https://img.shields.io/npm/v/adblock-rs.svg)](https://www.npmjs.com/package/adblock-rs)
[![docs.rs](https://docs.rs/adblock/badge.svg)](https://docs.rs/adblock)
![Build Status](https://github.com/brave/adblock-rust/actions/workflows/ci.yml/badge.svg)
[![License](https://img.shields.io/badge/License-MPL--2.0-blue)](LICENSE)

### _Putting you back in control of your browsing experience._

`adblock-rust` is the engine powering [Brave](https://brave.com)'s native adblocker, available as a library for anyone to use. It features:

- Network blocking
- Cosmetic filtering
- Resource replacements
- Hosts syntax
- uBlock Origin syntax extensions
- iOS content-blocking syntax conversion
- Compiling to native code or WASM
- Rust bindings ([crates](https://crates.io/crates/adblock))
- JS bindings ([npm](https://npmjs.com/adblock-rs))
- Community-maintained Python bindings ([pypi](https://pypi.org/project/adblock/))
- High performance!

## Getting started

`adblock-rust` is used in several projects, including browsers, research tools, and proxies.
It may be a good fit for yours, too!

See [docs.rs](https://docs.rs/adblock) for detailed API documentation.

Also check the [Rust example](./examples/example.rs) or the [NodeJS example](./js/example.mjs).

### Optional features

The following `cargo` [features](https://doc.rust-lang.org/cargo/reference/features.html) can be used to tweak `adblock-rust` to best fit your use-case.

#### CSS validation during rule parsing (`css-validation`)

When parsing cosmetic filter rules, it's possible to include a built-in implementation of CSS validation (through the [selectors](https://crates.io/crates/selectors) and [cssparser](https://crates.io/crates/cssparser) crates) by enabling the `css-validation` feature. This will cause `adblock-rust` to reject cosmetic filter rules with invalid CSS syntax.

#### Content blocking format translation (`content-blocking`)

Enabling the `content-blocking` feature gives `adblock-rust` support for conversion of standard ABP-style rules into Apple's [content-blocking format](https://developer.apple.com/documentation/safariservices/creating_a_content_blocker), which can be exported for use on iOS and macOS platforms.

#### External domain resolution (`embedded-domain-resolver`)

By default, `adblock-rust` ships with a built-in domain resolution implementation (through the [addr](https://crates.io/crates/addr) crate) that will generally suffice for standalone use-cases. For more advanced use-cases, disabling the `embedded-domain-resolver` feature will allow `adblock-rust` to use an external domain resolution implementation instead. This is extremely useful to reduce binary bloat and improve consistency when embedding `adblock-rust` within a browser.

#### Parsing resources from uBlock Origin's formats (`resource-assembler`)

`adblock-rust` uses uBlock Origin-compatible resources for scriptlet injection and redirect rules.
The `resource-assembler` feature allows `adblock-rust` to parse these resources directly from the file formats used by the uBlock Origin repository.

#### Thread safety (`single-thread`)

The `single-thread` feature enables optimizations for rule matching speed and the amount of memory used by the engine.
This feature can be disabled to make the engine `Send + Sync`, although it is recommended to only access the engine on a single thread to maintain optimal performance.
