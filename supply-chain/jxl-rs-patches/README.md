# jxl-rs 0.7.3 backport

Production changes from [Firefox bug 2069212](https://bugzilla.mozilla.org/show_bug.cgi?id=2069212):
`9caa5af57eb4` (vendor),
`d3da296c0032` (API adaptation), updated to [0.7.3](https://github.com/libjxl/jxl-rs/releases/tag/v0.7.3)
for truncated codestream handling and reduced stack usage.

## Local differences

- Rust 1.95+ is required; the old macOS x86_64 SIMD workaround is omitted.
- `PoolRunner::num_threads` returns the per-call participant snapshot, not the
  live preference. Parallel decoding stays disabled by default
  (`image.jxl.decode_participants = 1`).
- No test updates or new fixtures: preserve existing test-only content in
  retained files and omit new additions when re-vendoring. Legacy tests and
  rendering expectations may be incompatible. Keep `dither_32x32.bin`;
  it is production data.
