# Rust Brotli integration

Waterfox uses [rust-brotli](https://github.com/dropbox/rust-brotli) for compression
and [rust-brotli-decompressor](https://github.com/dropbox/rust-brotli-decompressor)
for decompression. The `brotli` 9.1.0 and `brotli-decompressor` 6.2.0 crates live in
`third_party/rust` and link into the browser through `gkrust-shared`.

Both crates build with `std` and `ffi-api` enabled. The decoder's optional
`unsafe` feature is disabled. Their dependencies include `alloc-no-stdlib`, which
defines allocation interfaces, and `alloc-stdlib`, which implements them using
Rust's standard library. C++ callers use Google's C headers in `modules/brotli`.

## Decoding

Include `mozilla/BrotliUtils.h` for the decoder helpers declared in
`modules/brotli/BrotliUtils.h` and implemented in `modules/brotli/BrotliUtils.cpp`.

`MozBrotliDecoderCreateInstance()` supplies `calloc` and `free` callbacks and
disables large windows. It returns null if decoder creation fails. HTTP and DOM
streaming decompression use this factory and measure output from their buffer
lengths. The HTTP wrapper keeps attached dictionaries alive until the decoder is
destroyed.

`MozBrotliDecoderDecompress(...)` decodes a complete buffer and manages the decoder
lifetime internally. It checks that input and output do not overlap, then clears
the output buffer before Rust borrows it. The helper reports the bytes written
and returns an error if the input is incomplete or the output buffer is too small.
It uses the streaming API to enforce the window limit; the library's buffer
decoder enables large windows by default.

WOFF2, font metadata, TLS certificate decoding and token cache decompression use
the buffer helper. The `Moz` prefix distinguishes these helpers from the library's
C functions.

## Encoding

DOM compression and token cache compression use the library's encoder C API and
default allocator. Both initialize their output buffers before calling Rust.
The token cache limits payloads to 256 KiB and checks the allocation size for
overflow.

Encoder allocation failures can abort the process under Gecko's
`panic = "abort"` profiles. The C interface contains unsafe Rust code, so callers
must supply valid buffers and respect dictionary lifetimes.

The Google headers declare some encoder APIs that the Rust library does not
provide. Check the implementation before adding calls to those APIs.

## Maintenance

Update the Rust dependencies with `./mach vendor rust`. Header updates use
`modules/brotli/moz.yaml`, which preserves the C++ adapter files.

After an update, run the HTTP Brotli and dictionary tests, the compression and
WOFF2 WPT suites, TLS certificate and token cache gtests, and the Netmonitor Brotli
test.
