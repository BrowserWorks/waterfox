#![cfg(all(feature = "ffi-api", feature = "std"))]

// A decoder created without C allocator callbacks allocates from the Rust
// global allocator. A failed allocation there must surface as a decoder error,
// just as a C allocator returning null does, rather than abort the process.
// This file is its own test binary, so the failing global allocator below
// affects nothing else.

extern crate brotli_decompressor;

use std::alloc::{GlobalAlloc, Layout, System};
use std::ptr;

use brotli_decompressor::ffi::interface::BrotliDecoderResult;
use brotli_decompressor::ffi::{
  BrotliDecoderCreateInstance, BrotliDecoderDecompressStream, BrotliDecoderDestroyInstance,
  BrotliDecoderErrorCode, BrotliDecoderFreeU8, BrotliDecoderGetErrorCode, BrotliDecoderMallocU8,
  BrotliDecoderMallocUsize, BrotliDecoderState,
};

// Every allocation of at least this many bytes fails by returning null, the
// way an allocator under memory pressure does. Only a ring buffer for a
// metablock longer than 8 MiB, and the explicit requests below, are that large.
const ALLOCATION_LIMIT: usize = 8 << 20;

struct LimitedAllocator;

unsafe impl GlobalAlloc for LimitedAllocator {
  unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
    if layout.size() >= ALLOCATION_LIMIT {
      return ptr::null_mut();
    }
    System.alloc(layout)
  }

  unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
    if layout.size() >= ALLOCATION_LIMIT {
      return ptr::null_mut();
    }
    System.alloc_zeroed(layout)
  }

  unsafe fn dealloc(&self, allocation: *mut u8, layout: Layout) {
    System.dealloc(allocation, layout)
  }

  unsafe fn realloc(&self, allocation: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
    if new_size >= ALLOCATION_LIMIT {
      return ptr::null_mut();
    }
    System.realloc(allocation, layout, new_size)
  }
}

#[global_allocator]
static GLOBAL: LimitedAllocator = LimitedAllocator;

const EXPECTED: &'static [u8] = b"0123456789abcdefghij";

// Two 10-byte uncompressed meta-blocks followed by an empty last one, with a
// 1 << window_bits byte window. The ring buffer only grows as the data needs,
// so this takes 1 KiB of ring buffer whatever the window.
fn two_block_stream(window_bits: u8) -> Vec<u8> {
  assert!(window_bits >= 18 && window_bits <= 24);
  // WBITS, then ISLAST=0, MNIBBLES=4, MLEN-1=9, ISUNCOMPRESSED=1.
  let mut stream = vec![0x81 | ((window_bits - 17) << 1), 0x04, 0x80];
  stream.extend_from_slice(&EXPECTED[..10]);
  // Byte aligned: ISLAST=0, MNIBBLES=4, MLEN-1=9, ISUNCOMPRESSED=1.
  stream.extend_from_slice(&[0x48, 0x00, 0x08]);
  stream.extend_from_slice(&EXPECTED[10..]);
  // ISLAST=1, ISLASTEMPTY=1.
  stream.push(0x03);
  stream
}

// Packs fields least significant bit first, as brotli streams are laid out.
struct BitWriter {
  bytes: Vec<u8>,
  bits: usize,
}

impl BitWriter {
  // Starts a stream with a 16 MiB window: WBITS=24.
  fn with_16_mib_window() -> BitWriter {
    let mut writer = BitWriter { bytes: Vec::new(), bits: 0 };
    writer.put(1, 1);
    writer.put(3, 24 - 17);
    writer
  }

  fn put(&mut self, count: usize, value: u32) {
    for i in 0..count {
      if self.bits % 8 == 0 {
        self.bytes.push(0);
      }
      *self.bytes.last_mut().unwrap() |= (((value >> i) & 1) as u8) << (self.bits % 8);
      self.bits += 1;
    }
  }

  // A meta-block header up to its ISUNCOMPRESSED bit: ISLAST=0, then the
  // fewest length nibbles that hold MLEN-1.
  fn meta_block(&mut self, length: u32, uncompressed: bool) {
    let nibbles = if length - 1 < 1 << 16 { 4 } else if length - 1 < 1 << 20 { 5 } else { 6 };
    self.put(1, 0);
    self.put(2, nibbles as u32 - 4);
    self.put(4 * nibbles, length - 1);
    self.put(1, uncompressed as u32);
  }

  // Uncompressed data starts at the next byte boundary.
  fn raw(&mut self, data: &[u8]) {
    self.bits = self.bytes.len() * 8;
    self.bytes.extend_from_slice(data);
    self.bits += data.len() * 8;
  }
}

// A 16 MiB meta-block needs a ring buffer over the allocation limit. Nothing
// else in these streams is larger than a few KiB.
const LONG_BLOCK: u32 = 1 << 24;

// A compressed meta-block whose header is complete, with the simplest one
// block type, one tree per group, and one-symbol prefix codes. The ring buffer
// is allocated at the end of the header.
fn long_compressed_block_stream() -> Vec<u8> {
  let mut writer = BitWriter::with_16_mib_window();
  writer.meta_block(LONG_BLOCK, false);
  // NBLTYPESL, NBLTYPESI, NBLTYPESD=1; NPOSTFIX=0, NDIRECT=0; literal context
  // mode 0; NTREESL=1, NTREESD=1.
  writer.put(3, 0);
  writer.put(6, 0);
  writer.put(2, 0);
  writer.put(2, 0);
  // Simple prefix codes (HSKIP=1) with one symbol each for literals (8-bit
  // symbols), insert-and-copy lengths (10-bit) and distances (6-bit).
  for &(bits, symbol) in &[(8, b'a' as u32), (10, 0), (6, 0)] {
    writer.put(2, 1);
    writer.put(2, 0);
    writer.put(bits, symbol);
  }
  writer.bytes
}

// An uncompressed meta-block: its ring buffer is allocated before any of the
// data is copied.
fn long_uncompressed_block_stream() -> Vec<u8> {
  let mut writer = BitWriter::with_16_mib_window();
  writer.meta_block(LONG_BLOCK, true);
  writer.raw(&EXPECTED[..10]);
  writer.bytes
}

// A 10-byte meta-block that fits the initial 1 KiB ring buffer, then one that
// needs it grown past the limit.
fn growing_stream() -> Vec<u8> {
  let mut writer = BitWriter::with_16_mib_window();
  writer.meta_block(10, true);
  writer.raw(&EXPECTED[..10]);
  writer.meta_block(LONG_BLOCK, true);
  writer.raw(&EXPECTED[10..]);
  writer.bytes
}

unsafe fn decompress(
  state: *mut BrotliDecoderState,
  input: &[u8],
) -> (BrotliDecoderResult, Vec<u8>) {
  let mut output = vec![0u8; EXPECTED.len() + 1];
  let mut available_in = input.len();
  let mut next_in = input.as_ptr();
  let mut available_out = output.len();
  let mut next_out = output.as_mut_ptr();
  let mut total_out = 0usize;
  let result = BrotliDecoderDecompressStream(
    state,
    &mut available_in,
    &mut next_in,
    &mut available_out,
    &mut next_out,
    &mut total_out,
  );
  output.truncate(total_out);
  (result, output)
}

#[test]
fn default_allocator_decodes_when_the_ring_buffer_fits() {
  // A 16 MiB window used to cost a 16 MiB ring buffer, over the limit, even
  // for 20 bytes of data.
  for &window_bits in &[22, 24] {
    let state = unsafe { BrotliDecoderCreateInstance(None, None, ptr::null_mut()) };
    assert!(!state.is_null());
    let (result, output) = unsafe { decompress(state, &two_block_stream(window_bits)) };
    assert_eq!(
      result as i32,
      BrotliDecoderResult::BROTLI_DECODER_RESULT_SUCCESS as i32
    );
    assert_eq!(&output[..], EXPECTED);
    unsafe { BrotliDecoderDestroyInstance(state) };
  }
}

// Each stream needs a ring buffer above the allocation limit: allocated whole
// for its first meta-block, or grown for its second one. A failed ring buffer
// allocation used to abort the process inside vec! (via handle_alloc_error,
// which catch_unwind cannot intercept). The error codes are the C decoder's
// for the same streams.
#[test]
fn default_allocator_ring_buffer_failure_is_an_error_not_an_abort() {
  let cases = [
    (long_compressed_block_stream(),
     BrotliDecoderErrorCode::BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2),
    (long_uncompressed_block_stream(),
     BrotliDecoderErrorCode::BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1),
    (growing_stream(),
     BrotliDecoderErrorCode::BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1),
  ];
  for &(ref input, error_code) in cases.iter() {
    let state = unsafe { BrotliDecoderCreateInstance(None, None, ptr::null_mut()) };
    assert!(!state.is_null());
    // The failure is sticky, so a retry must fail the same way.
    for _ in 0..2 {
      let (result, output) = unsafe { decompress(state, input) };
      assert_eq!(
        result as i32,
        BrotliDecoderResult::BROTLI_DECODER_RESULT_ERROR as i32
      );
      assert!(output.is_empty());
      assert_eq!(
        unsafe { BrotliDecoderGetErrorCode(state) } as i32,
        error_code as i32
      );
    }
    unsafe { BrotliDecoderDestroyInstance(state) };
  }
}

#[test]
fn default_allocator_malloc_returns_null_on_failure() {
  let state = unsafe { BrotliDecoderCreateInstance(None, None, ptr::null_mut()) };
  assert!(!state.is_null());
  unsafe {
    assert!(BrotliDecoderMallocU8(state, ALLOCATION_LIMIT).is_null());
    assert!(BrotliDecoderMallocUsize(state, ALLOCATION_LIMIT).is_null());
    let small = BrotliDecoderMallocU8(state, 16);
    assert!(!small.is_null());
    assert_eq!(std::slice::from_raw_parts(small, 16), &[0u8; 16]);
    BrotliDecoderFreeU8(state, small, 16);
    BrotliDecoderDestroyInstance(state);
  }
}
