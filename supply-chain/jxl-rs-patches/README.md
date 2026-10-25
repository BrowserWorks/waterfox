# jxl-rs 0.8.0 backport

Waterfox vendors [jxl-rs 0.8.0](https://github.com/libjxl/jxl-rs/releases/tag/v0.8.0)
and uses its event-based decoder API through `image/rust/jxl`
([Firefox bug 2083544](https://bugzilla.mozilla.org/show_bug.cgi?id=2083544)).
The vendored crates are `jxl`, `jxl_macros`, `jxl_simd`, and `jxl_transforms`.

## Parallel decoding

A dedicated Gecko thread pool handles parallel decoding
([bug 2065753](https://bugzilla.mozilla.org/show_bug.cgi?id=2065753)).
Parallel decoding is enabled by default
([bug 2069326](https://bugzilla.mozilla.org/show_bug.cgi?id=2069326)).

`image.jxl.decode_participants` controls how many threads may work on one image,
including the calling thread:

- `0` (default): use the CPU count, clamped to between 2 and 8 participants.
- `1`: decode on the calling thread without helpers.
- Higher values: use the specified participant limit.

The first parallel decode fixes the pool's thread limit for the process. Lowering
this preference uses fewer helpers; raising it does not enlarge the pool.

## Local differences and test coverage

- The pool snapshots the participant count so a preference change cannot create
  a zero-thread pool. The C++ pool accessor also rejects a zero thread limit.
- `jxl_simd` uses the upstream macOS x86_64 implementation without Firefox's
  SIMD workaround.
- ICC profile generation failures fall back to decoding without color management
  ([bug 2073543](https://bugzilla.mozilla.org/show_bug.cgi?id=2073543)).
- Associated-alpha images are not premultiplied twice. The decoder unpremultiplies
  their pixels when color management or the requested output format needs it
  ([bug 2079663](https://bugzilla.mozilla.org/show_bug.cgi?id=2079663)).
- The gtests from [bug 2065753](https://bugzilla.mozilla.org/show_bug.cgi?id=2065753)
  require exact pixel matches between serial and parallel decoding across
  participant counts, including concurrent decodes. The reference image and
  platform-specific tolerances come from
  [bug 2069212](https://bugzilla.mozilla.org/show_bug.cgi?id=2069212);
  macOS requires an exact match.
- Web-platform references and tolerances include upstream's 0.8.0 updates and
  fixes from [bug 2071453](https://bugzilla.mozilla.org/show_bug.cgi?id=2071453),
  [bug 2053983](https://bugzilla.mozilla.org/show_bug.cgi?id=2053983), and
  [bug 2054821](https://bugzilla.mozilla.org/show_bug.cgi?id=2054821).
- Vendored Rust tests match upstream 0.8.0. The crate excludes the
  `resources/test` corpus needed to run them.
