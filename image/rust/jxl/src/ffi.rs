/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

use crate::decoder::JxlApiDecoder;
use std::slice;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum JxlDecoderStatus {
    Ok = 0,
    NeedMoreData = 1,
    Error = 2,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct JxlBasicInfo {
    pub width: u32,
    pub height: u32,
    pub has_alpha: bool,
    pub alpha_premultiplied: bool,
    pub is_animated: bool,
    pub num_loops: u32,
    pub valid: bool,
}

#[repr(C)]
#[derive(Debug, Clone, Copy, Default)]
pub struct JxlFrameInfo {
    pub duration_ms: i32,
    pub frame_duration_valid: bool,
}

/// # Safety
/// `has_cms` must be true only when a display color profile is available and CMS is
/// enabled; when true the decoder requests Gray/GrayAlpha output for grayscale images.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_new(metadata_only: bool, has_cms: bool) -> *mut JxlApiDecoder {
    Box::into_raw(Box::new(JxlApiDecoder::new(metadata_only, has_cms)))
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new` and must not
/// have been previously destroyed. After this call, `decoder` is invalid.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_destroy(decoder: *mut JxlApiDecoder) {
    if !decoder.is_null() {
        // SAFETY: Caller guarantees `decoder` is a valid pointer from `jxl_decoder_new`
        // and has not been destroyed. We take ownership and drop it.
        let _ = unsafe { Box::from_raw(decoder) };
    }
}

/// # Safety
/// - `decoder` must be a valid pointer returned by `jxl_decoder_new`.
/// - `data` must be a valid pointer to a `*const u8` pointer.
/// - `data_len` must be a valid pointer to a `usize`.
/// - `*data` must point to a valid byte slice of length `*data_len`, or be null
///   when `*data_len` is 0.
/// - If `output_buffer` is non-null, it must point to a valid writable buffer
///   of at least `output_buffer_len` bytes.
/// - If `k_buffer` is non-null, it must point to a valid writable buffer of at
///   least `k_buffer_len` bytes (for CMYK K channel, 1 byte per pixel).
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_process_data(
    decoder: *mut JxlApiDecoder,
    data: *mut *const u8,
    data_len: *mut usize,
    output_buffer: *mut u8,
    output_buffer_len: usize,
    k_buffer: *mut u8,
    k_buffer_len: usize,
) -> JxlDecoderStatus {
    debug_assert!(!decoder.is_null() && !data.is_null() && !data_len.is_null());

    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &mut *decoder };

    // SAFETY: Caller guarantees `data` and `data_len` are valid pointers, and that
    // `*data` points to a valid byte slice of length `*data_len` (or is null when
    // `*data_len` is 0).
    let mut data_slice = if unsafe { (*data).is_null() } {
        &[]
    } else {
        // SAFETY: See above.
        unsafe { slice::from_raw_parts(*data, *data_len) }
    };

    let output_slice = if output_buffer.is_null() {
        None
    } else {
        // SAFETY: Caller guarantees that when `output_buffer` is non-null, it points
        // to a valid writable buffer of at least `output_buffer_len` bytes.
        Some(unsafe { slice::from_raw_parts_mut(output_buffer, output_buffer_len) })
    };

    let k_slice = if k_buffer.is_null() {
        None
    } else {
        // SAFETY: Caller guarantees that when `k_buffer` is non-null, it points
        // to a valid writable buffer of at least `k_buffer_len` bytes.
        Some(unsafe { slice::from_raw_parts_mut(k_buffer, k_buffer_len) })
    };

    let result = decoder.process_data(&mut data_slice, output_slice, k_slice);

    // SAFETY: Caller guarantees `data` and `data_len` are valid, writable pointers.
    // We update them to reflect how much data was consumed.
    unsafe {
        *data = data_slice.as_ptr();
        *data_len = data_slice.len();
    }

    match result {
        Ok(true) => JxlDecoderStatus::Ok,
        Ok(false) => JxlDecoderStatus::NeedMoreData,
        Err(_) => JxlDecoderStatus::Error,
    }
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_has_black_channel(decoder: *const JxlApiDecoder) -> bool {
    debug_assert!(!decoder.is_null());
    // SAFETY: Caller guarantees valid pointer.
    let decoder = unsafe { &*decoder };
    decoder.has_black_channel()
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_get_basic_info(decoder: *const JxlApiDecoder) -> JxlBasicInfo {
    debug_assert!(!decoder.is_null());

    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &*decoder };

    let Some(info) = decoder.get_basic_info() else {
        return JxlBasicInfo::default();
    };

    JxlBasicInfo {
        width: info.width,
        height: info.height,
        has_alpha: info.has_alpha,
        alpha_premultiplied: info.alpha_premultiplied,
        is_animated: info.is_animated,
        num_loops: info.num_loops,
        valid: true,
    }
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_get_frame_info(decoder: *const JxlApiDecoder) -> JxlFrameInfo {
    debug_assert!(!decoder.is_null());

    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &*decoder };

    match decoder.frame_duration {
        Some(duration) => JxlFrameInfo {
            duration_ms: duration.clamp(0.0, i32::MAX as f64) as i32,
            frame_duration_valid: true,
        },
        None => JxlFrameInfo::default(),
    }
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_is_frame_ready(decoder: *const JxlApiDecoder) -> bool {
    debug_assert!(!decoder.is_null());

    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &*decoder };

    decoder.frame_ready
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_is_gray(decoder: *const JxlApiDecoder) -> bool {
    debug_assert!(!decoder.is_null());
    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &*decoder };
    decoder.is_gray()
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_use_f16(decoder: *const JxlApiDecoder) -> bool {
    debug_assert!(!decoder.is_null());

    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &*decoder };

    decoder.use_f16
}

/// Returns a pointer to the output color profile ICC bytes and sets `*out_len`.
/// The pointer is valid for the lifetime of the decoder. Returns null with len=0
/// if the profile is not yet available (pixel format not set / frame header not parsed).
///
/// # Safety
/// - `decoder` must be a valid pointer returned by `jxl_decoder_new`.
/// - `out_len` must be a valid writable pointer to a `usize`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_get_icc_profile(
    decoder: *mut JxlApiDecoder,
    out_len: *mut usize,
) -> *const u8 {
    debug_assert!(!decoder.is_null() && !out_len.is_null());

    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &mut *decoder };

    let icc = decoder.get_output_icc_profile();

    // SAFETY: Caller guarantees `out_len` is a valid writable pointer.
    unsafe { *out_len = icc.len() };

    if icc.is_empty() {
        std::ptr::null()
    } else {
        icc.as_ptr()
    }
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_decoder_new`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_has_more_frames(decoder: *const JxlApiDecoder) -> bool {
    debug_assert!(!decoder.is_null());

    // SAFETY: Caller guarantees `decoder` is a valid, non-null pointer from `jxl_decoder_new`.
    let decoder = unsafe { &*decoder };

    decoder.inner.has_more_frames()
}

#[no_mangle]
pub extern "C" fn jxl_scanner_new() -> *mut JxlApiDecoder {
    Box::into_raw(Box::new(JxlApiDecoder::new_scanner()))
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_scanner_new` or `jxl_decoder_new`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_get_scanned_frame_count(decoder: *const JxlApiDecoder) -> u32 {
    debug_assert!(!decoder.is_null());
    // SAFETY: Caller guarantees valid pointer.
    let decoder = unsafe { &*decoder };
    decoder.scanned_frames().len() as u32
}

/// # Safety
/// `decoder` must be a valid pointer returned by `jxl_scanner_new` or `jxl_decoder_new`.
/// `index` must be less than the value returned by `jxl_decoder_get_scanned_frame_count`.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_get_scanned_frame_info(
    decoder: *const JxlApiDecoder,
    index: u32,
) -> JxlFrameInfo {
    debug_assert!(!decoder.is_null());
    // SAFETY: Caller guarantees valid pointer.
    let decoder = unsafe { &*decoder };
    let frames = decoder.scanned_frames();
    let i = index as usize;
    if i >= frames.len() {
        return JxlFrameInfo::default();
    }
    let f = &frames[i];
    JxlFrameInfo {
        duration_ms: f.duration_ms.clamp(0.0, i32::MAX as f64) as i32,
        frame_duration_valid: true,
    }
}

/// Flush partially-decoded pixels into `output_buffer`.
/// `k_buffer` receives the K (Black) channel (1 byte/pixel) for CMYK images; pass null otherwise.
/// # Safety
/// - `decoder` must be a valid pointer returned by `jxl_decoder_new`.
/// - `output_buffer` must be non-null and point to a valid writable buffer of
///   at least `output_buffer_len` bytes.
/// - If `k_buffer` is non-null, it must point to a valid writable buffer of at
///   least `k_buffer_len` bytes.
#[no_mangle]
pub unsafe extern "C" fn jxl_decoder_flush_pixels(
    decoder: *mut JxlApiDecoder,
    output_buffer: *mut u8,
    output_buffer_len: usize,
    k_buffer: *mut u8,
    k_buffer_len: usize,
) -> JxlDecoderStatus {
    debug_assert!(!decoder.is_null() && !output_buffer.is_null());
    // SAFETY: Caller guarantees valid pointers.
    let decoder = unsafe { &mut *decoder };
    // SAFETY: Caller guarantees output_buffer is non-null and valid for output_buffer_len bytes.
    let buf = unsafe { slice::from_raw_parts_mut(output_buffer, output_buffer_len) };
    let k_slice = if k_buffer.is_null() {
        None
    } else {
        // SAFETY: Caller guarantees k_buffer is non-null and valid for k_buffer_len bytes.
        Some(unsafe { slice::from_raw_parts_mut(k_buffer, k_buffer_len) })
    };
    // Ok(true) means new pixels were rendered and written to the buffer since
    // the last flush_pixels call.
    // Ok(false) means nothing new was rendered since the last flush_pixels
    // call.
    match decoder.flush_pixels(buf, k_slice) {
        Ok(true) => JxlDecoderStatus::Ok,
        Ok(false) => JxlDecoderStatus::NeedMoreData,
        Err(_) => JxlDecoderStatus::Error,
    }
}
