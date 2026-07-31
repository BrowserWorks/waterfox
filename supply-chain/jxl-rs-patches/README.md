# jxl-rs 0.8.0 backport

Waterfox vendors [jxl-rs 0.8.0](https://github.com/libjxl/jxl-rs/releases/tag/v0.8.0)
and uses its event-based decoder API through `image/rust/jxl`
([Firefox bug 2083544](https://bugzilla.mozilla.org/show_bug.cgi?id=2083544)).
The vendored crates are `jxl`, `jxl_macros`, `jxl_simd`, and `jxl_transforms`.

## Local differences and test coverage

- `jxl_simd` uses the upstream macOS x86_64 implementation without Firefox's
  SIMD workaround.
- Web-platform references and tolerances include upstream's 0.8.0 updates and
  fixes from [bug 2071453](https://bugzilla.mozilla.org/show_bug.cgi?id=2071453),
  [bug 2053983](https://bugzilla.mozilla.org/show_bug.cgi?id=2053983), and
  [bug 2054821](https://bugzilla.mozilla.org/show_bug.cgi?id=2054821).
- Vendored Rust tests match upstream 0.8.0. The crate excludes the
  `resources/test` corpus needed to run them.
