pub use brotli_decompressor::ffi::interface::{
    brotli_alloc_func, brotli_decoder_metadata_chunk_func, brotli_decoder_metadata_start_func,
    brotli_free_func, c_void,
};
pub use brotli_decompressor::{ffi, BrotliDecoderReturnInfo, HuffmanCode};

pub unsafe extern "C" fn CBrotliDecoderCreateInstance(
    alloc_func: brotli_alloc_func,
    free_func: brotli_free_func,
    opaque: *mut c_void,
) -> *mut ffi::BrotliDecoderState {
    ffi::BrotliDecoderCreateInstance(alloc_func, free_func, opaque)
}

// Mirrors the C prototype: BROTLI_BOOL BrotliDecoderSetParameter(state, param,
// value). The selector is taken as a plain i32 rather than the Rust enum so an
// unrecognized value coming from C cannot form an invalid discriminant; it is
// reported by returning BROTLI_FALSE instead. Rust callers can pass
// `BrotliDecoderParameter::... as i32`.
pub unsafe extern "C" fn CBrotliDecoderSetParameter(
    state_ptr: *mut ffi::BrotliDecoderState,
    selector: i32,
    value: u32,
) -> i32 {
    ffi::BrotliDecoderSetParameter(state_ptr, selector, value)
}

// Mirrors the C prototype: void BrotliDecoderSetMetadataCallbacks(state,
// start_func, chunk_func, opaque). For every metadata meta-block the decoder
// calls start_func once with the block's length, then chunk_func zero or more
// times with consecutive pieces of its payload; either may be NULL. The chunk
// pointer is only valid for the duration of the call.
pub unsafe extern "C" fn CBrotliDecoderSetMetadataCallbacks(
    state_ptr: *mut ffi::BrotliDecoderState,
    start_func: brotli_decoder_metadata_start_func,
    chunk_func: brotli_decoder_metadata_chunk_func,
    opaque: *mut c_void,
) {
    ffi::BrotliDecoderSetMetadataCallbacks(state_ptr, start_func, chunk_func, opaque)
}

#[cfg(feature = "std")] // this requires a default allocator
pub unsafe extern "C" fn CBrotliDecoderDecompress(
    encoded_size: usize,
    encoded_buffer: *const u8,
    decoded_size: *mut usize,
    decoded_buffer: *mut u8,
) -> ffi::interface::BrotliDecoderResult {
    ffi::BrotliDecoderDecompress(encoded_size, encoded_buffer, decoded_size, decoded_buffer)
}

pub unsafe extern "C" fn CBrotliDecoderDecompressStream(
    state_ptr: *mut ffi::BrotliDecoderState,
    available_in: *mut usize,
    input_buf_ptr: *mut *const u8,
    available_out: *mut usize,
    output_buf_ptr: *mut *mut u8,
    total_out: *mut usize,
) -> ffi::interface::BrotliDecoderResult {
    ffi::BrotliDecoderDecompressStream(
        state_ptr,
        available_in,
        input_buf_ptr,
        available_out,
        output_buf_ptr,
        total_out,
    )
}

pub unsafe extern "C" fn CBrotliDecoderDecompressStreaming(
    state_ptr: *mut ffi::BrotliDecoderState,
    available_in: *mut usize,
    input_buf_ptr: *const u8,
    available_out: *mut usize,
    output_buf_ptr: *mut u8,
) -> ffi::interface::BrotliDecoderResult {
    ffi::BrotliDecoderDecompressStreaming(
        state_ptr,
        available_in,
        input_buf_ptr,
        available_out,
        output_buf_ptr,
    )
}

pub unsafe extern "C" fn CBrotliDecoderDecompressWithReturnInfo(
    available_in: usize,
    input_buf_ptr: *const u8,
    available_out_and_scratch: usize,
    output_buf_and_scratch: *mut u8,
) -> BrotliDecoderReturnInfo {
    ffi::BrotliDecoderDecompressWithReturnInfo(
        available_in,
        input_buf_ptr,
        available_out_and_scratch,
        output_buf_and_scratch,
    )
}

pub unsafe extern "C" fn CBrotliDecoderDecompressPrealloc(
    available_in: usize,
    input_buf_ptr: *const u8,
    available_out: usize,
    output_buf_ptr: *mut u8,
    available_u8: usize,
    u8_ptr: *mut u8,
    available_u32: usize,
    u32_ptr: *mut u32,
    available_hc: usize,
    hc_ptr: *mut HuffmanCode,
) -> BrotliDecoderReturnInfo {
    ffi::BrotliDecoderDecompressPrealloc(
        available_in,
        input_buf_ptr,
        available_out,
        output_buf_ptr,
        available_u8,
        u8_ptr,
        available_u32,
        u32_ptr,
        available_hc,
        hc_ptr,
    )
}

pub unsafe extern "C" fn CBrotliDecoderMallocU8(
    state_ptr: *mut ffi::BrotliDecoderState,
    size: usize,
) -> *mut u8 {
    ffi::BrotliDecoderMallocU8(state_ptr, size)
}

pub unsafe extern "C" fn CBrotliDecoderFreeU8(
    state_ptr: *mut ffi::BrotliDecoderState,
    data: *mut u8,
    size: usize,
) {
    ffi::BrotliDecoderFreeU8(state_ptr, data, size)
}

pub unsafe extern "C" fn CBrotliDecoderMallocUsize(
    state_ptr: *mut ffi::BrotliDecoderState,
    size: usize,
) -> *mut usize {
    ffi::BrotliDecoderMallocUsize(state_ptr, size)
}

pub unsafe extern "C" fn CBrotliDecoderFreeUsize(
    state_ptr: *mut ffi::BrotliDecoderState,
    data: *mut usize,
    size: usize,
) {
    ffi::BrotliDecoderFreeUsize(state_ptr, data, size)
}

pub unsafe extern "C" fn CBrotliDecoderDestroyInstance(state_ptr: *mut ffi::BrotliDecoderState) {
    ffi::BrotliDecoderDestroyInstance(state_ptr)
}

pub extern "C" fn CBrotliDecoderVersion() -> u32 {
    ffi::BrotliDecoderVersion()
}

#[no_mangle]
pub extern "C" fn CBrotliDecoderErrorString(c: ffi::BrotliDecoderErrorCode) -> *const u8 {
    ffi::BrotliDecoderErrorString(c)
}

#[no_mangle]
pub unsafe extern "C" fn CBrotliDecoderHasMoreOutput(
    state_ptr: *const ffi::BrotliDecoderState,
) -> i32 {
    ffi::BrotliDecoderHasMoreOutput(state_ptr)
}

#[no_mangle]
pub unsafe extern "C" fn CBrotliDecoderTakeOutput(
    state_ptr: *mut ffi::BrotliDecoderState,
    size: *mut usize,
) -> *const u8 {
    ffi::BrotliDecoderTakeOutput(state_ptr, size)
}

#[no_mangle]
pub unsafe extern "C" fn CBrotliDecoderIsUsed(state_ptr: *const ffi::BrotliDecoderState) -> i32 {
    ffi::BrotliDecoderIsUsed(state_ptr)
}
#[no_mangle]
pub unsafe extern "C" fn CBrotliDecoderIsFinished(
    state_ptr: *const ffi::BrotliDecoderState,
) -> i32 {
    ffi::BrotliDecoderIsFinished(state_ptr)
}
#[no_mangle]
pub unsafe extern "C" fn CBrotliDecoderGetErrorCode(
    state_ptr: *const ffi::BrotliDecoderState,
) -> ffi::BrotliDecoderErrorCode {
    ffi::BrotliDecoderGetErrorCode(state_ptr)
}
#[no_mangle]
pub unsafe extern "C" fn CBrotliDecoderGetErrorString(
    state_ptr: *const ffi::BrotliDecoderState,
) -> *const u8 {
    ffi::BrotliDecoderGetErrorString(state_ptr)
}

#[cfg(all(test, feature = "std"))]
mod test {
    use super::*;
    use core::ptr::null_mut;
    use ffi::compressor::{
        BrotliEncoderCompressStream, BrotliEncoderCreateInstance, BrotliEncoderDestroyInstance,
        BrotliEncoderHasMoreOutput, BrotliEncoderIsFinished, BrotliEncoderOperation,
    };
    use std::vec::Vec;

    const NEEDS_MORE_OUTPUT: i32 =
        ffi::interface::BrotliDecoderResult::BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT as i32;
    const SUCCESS: i32 = ffi::interface::BrotliDecoderResult::BROTLI_DECODER_RESULT_SUCCESS as i32;
    const ERROR: i32 = ffi::interface::BrotliDecoderResult::BROTLI_DECODER_RESULT_ERROR as i32;

    #[derive(Default)]
    struct Recorder {
        starts: Vec<usize>,
        payload: Vec<u8>,
    }

    extern "C" fn on_start(opaque: *mut c_void, size: usize) {
        let recorder = unsafe { &mut *(opaque as *mut Recorder) };
        recorder.starts.push(size);
    }

    extern "C" fn on_chunk(opaque: *mut c_void, data: *const u8, size: usize) {
        let recorder = unsafe { &mut *(opaque as *mut Recorder) };
        recorder
            .payload
            .extend_from_slice(unsafe { core::slice::from_raw_parts(data, size) });
    }

    // Drives one operation to completion. Stopping on "no output produced"
    // does not work: once the input is consumed, every further FLUSH or
    // EMIT_METADATA call emits another empty block, so the loop never ends.
    unsafe fn encode_op(
        state: *mut ::ffi::compressor::BrotliEncoderState,
        op: fn() -> BrotliEncoderOperation,
        input: &[u8],
        output: &mut Vec<u8>,
    ) {
        let finishing = op() as i32 == BrotliEncoderOperation::BROTLI_OPERATION_FINISH as i32;
        let mut available_in = input.len();
        let mut next_in = input.as_ptr();
        loop {
            let mut buf = [0u8; 256];
            let mut available_out = buf.len();
            let mut next_out = buf.as_mut_ptr();
            assert_eq!(
                BrotliEncoderCompressStream(
                    state,
                    op(),
                    &mut available_in,
                    &mut next_in,
                    &mut available_out,
                    &mut next_out,
                    null_mut(),
                ),
                1
            );
            let produced = buf.len() - available_out;
            output.extend_from_slice(&buf[..produced]);
            let done = if finishing {
                BrotliEncoderIsFinished(state) != 0
            } else {
                available_in == 0 && BrotliEncoderHasMoreOutput(state) == 0
            };
            if done {
                break;
            }
        }
    }

    // Two metadata blocks around some compressed data; returns the stream.
    fn stream_with_metadata(first: &[u8], data: &[u8], second: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        unsafe {
            let state = BrotliEncoderCreateInstance(None, None, null_mut());
            assert!(!state.is_null());
            encode_op(
                state,
                || BrotliEncoderOperation::BROTLI_OPERATION_EMIT_METADATA,
                first,
                &mut out,
            );
            encode_op(
                state,
                || BrotliEncoderOperation::BROTLI_OPERATION_PROCESS,
                data,
                &mut out,
            );
            encode_op(
                state,
                || BrotliEncoderOperation::BROTLI_OPERATION_FLUSH,
                &[],
                &mut out,
            );
            encode_op(
                state,
                || BrotliEncoderOperation::BROTLI_OPERATION_EMIT_METADATA,
                second,
                &mut out,
            );
            encode_op(
                state,
                || BrotliEncoderOperation::BROTLI_OPERATION_FINISH,
                &[],
                &mut out,
            );
            BrotliEncoderDestroyInstance(state);
        }
        out
    }

    #[test]
    fn test_metadata_callbacks_report_every_metadata_block() {
        let first: Vec<u8> = (0..300u32).map(|i| (i * 7) as u8).collect();
        let second = b"trailing metadata";
        let data = b"hello hello hello hello world";
        let stream = stream_with_metadata(&first, data, second);

        // Feed one byte at a time so metadata payloads arrive split over calls.
        let mut recorder = Recorder::default();
        let mut decoded = Vec::new();
        unsafe {
            let state = CBrotliDecoderCreateInstance(None, None, null_mut());
            CBrotliDecoderSetMetadataCallbacks(
                state,
                Some(on_start),
                Some(on_chunk),
                &mut recorder as *mut Recorder as *mut c_void,
            );
            let mut result = ERROR;
            for byte in stream.iter() {
                let mut available_in = 1usize;
                let mut next_in = byte as *const u8;
                loop {
                    let mut buf = [0u8; 64];
                    let mut available_out = buf.len();
                    let mut next_out = buf.as_mut_ptr();
                    result = CBrotliDecoderDecompressStream(
                        state,
                        &mut available_in,
                        &mut next_in,
                        &mut available_out,
                        &mut next_out,
                        null_mut(),
                    ) as i32;
                    decoded.extend_from_slice(&buf[..buf.len() - available_out]);
                    if result != NEEDS_MORE_OUTPUT {
                        break;
                    }
                }
                assert!(result != ERROR);
            }
            assert_eq!(result, SUCCESS);
            CBrotliDecoderDestroyInstance(state);
        }
        assert_eq!(&decoded[..], &data[..]);
        // The encoder may add an empty metadata block of its own (e.g. as a
        // flush marker); only the non-empty ones are ours.
        let ours: Vec<usize> = recorder
            .starts
            .iter()
            .cloned()
            .filter(|&s| s != 0)
            .collect();
        assert_eq!(ours, [first.len(), second.len()]);
        let mut expected = first.clone();
        expected.extend_from_slice(second);
        assert_eq!(recorder.payload, expected);
    }

    #[test]
    fn test_metadata_callbacks_accept_null_state_and_funcs() {
        unsafe {
            CBrotliDecoderSetMetadataCallbacks(null_mut(), None, None, null_mut());
            let state = CBrotliDecoderCreateInstance(None, None, null_mut());
            CBrotliDecoderSetMetadataCallbacks(state, None, None, null_mut());
            let stream = stream_with_metadata(b"ignored", b"data", b"");
            let mut decoded = [0u8; 16];
            let mut available_in = stream.len();
            let mut next_in = stream.as_ptr();
            let mut available_out = decoded.len();
            let mut next_out = decoded.as_mut_ptr();
            assert_eq!(
                CBrotliDecoderDecompressStream(
                    state,
                    &mut available_in,
                    &mut next_in,
                    &mut available_out,
                    &mut next_out,
                    null_mut(),
                ) as i32,
                SUCCESS
            );
            assert_eq!(&decoded[..decoded.len() - available_out], b"data");
            CBrotliDecoderDestroyInstance(state);
        }
    }
}
