# jxl-rs 0.7.4 backport

Production changes from [Firefox bug 2073321](https://bugzilla.mozilla.org/show_bug.cgi?id=2073321):
plain upstream vendor of [0.7.4](https://github.com/libjxl/jxl-rs/releases/tag/v0.7.4)
(non-444 LF upscaling fix, missing squeeze tiles treated as zero, TOC decode guard).

## Local differences

- Rust 1.95+ is required; the old macOS x86_64 SIMD workaround is omitted.
- Parallel decoding stays disabled by default (`image.jxl.decode_participants = 1`).
- No test updates or new fixtures have been backported.
