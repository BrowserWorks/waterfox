use zlib_rs::c_api::*;

use crate::gz::GzMode::GZ_READ;
use crate::{
    deflate, deflateEnd, deflateInit2_, deflateReset, inflate, inflateEnd, inflateInit2_,
    inflateReset, prefix, z_off64_t, z_off_t, zlibVersion,
};
use core::cmp::Ordering;
use core::ffi::{c_char, c_int, c_uint, c_void, CStr};
use core::ptr;
use libc::size_t; // FIXME: Switch to core::ffi::c_size_t when it's stable.
use libc::{O_APPEND, O_CREAT, O_EXCL, O_RDONLY, O_TRUNC, O_WRONLY, SEEK_CUR, SEEK_END, SEEK_SET};
use zlib_rs::deflate::Strategy;
use zlib_rs::MAX_WBITS;

/// In the zlib C API, this structure exposes just enough of the internal state
/// of an open [`gzFile`] to support the `gzgetc` C macro. Since Rust code won't be
/// using that C macro, we define [`gzFile_s`] as an empty structure.
// For ABI compatibility with zlib and zlib-ng, the first fields in [`GzState`] match
// what would be in the C version of [`gzFile_s`]. But we don't want new users to rely
// on this internal implementation, so the Rust [`gzFile_s`] is intentionally opaque.
#[allow(non_camel_case_types)]
pub enum gzFile_s {}

/// File handle for an open gzip file.
#[allow(non_camel_case_types)]
pub type gzFile = *mut gzFile_s;

// The internals of a gzip file handle (the thing gzFile actually points to, with the
// public gzFile_s part at the front for ABI compatibility).
#[repr(C)]
struct GzState {
    // Public interface:
    // These first three fields must match the structure gzFile_s in the C version
    // of zlib. In the C library, a macro called gzgetc() reads and writes these
    // fields directly.
    have: c_uint,       // number of bytes available at next
    next: *const Bytef, // next byte of uncompressed data
    pos: i64,           // current offset in uncompressed data stream

    // End of public interface:
    // All fields after this point are opaque to C code using this library,
    // so they can be rearranged without breaking compatibility.

    // Fields used for both reading and writing
    mode: GzMode,
    fd: c_int, // file descriptor
    source: Source,
    want: usize,     // requested buffer size, default is GZBUFSIZE
    input: *mut u8,  // input buffer (double-sized when writing)
    in_size: usize,  // usable size of input buffer (See [`gz_init`] for explanation.)
    output: *mut u8, // output buffer (double-sized when reading)
    out_size: usize, // size of *output
    direct: bool,    // true in pass-through mode, false if processing gzip data

    // Fields used just for reading
    how: How,
    start: i64,
    eof: bool,  // whether we have reached the end of the input file
    past: bool, // whether a read past the end has been requested

    // Fields used just for writing
    level: i8,
    strategy: Strategy,
    reset: bool, // whether a reset is pending after a Z_FINISH

    // Fields used for seek requests
    skip: i64,  // amount to skip (already rewound if backwards)
    seek: bool, // whether a seek request is pending

    // Error information
    err: c_int,         // last error (0 if no error)
    msg: *const c_char, // error message from last error (NULL if none)

    // zlib inflate or deflate stream
    stream: z_stream,
}

impl GzState {
    fn configure(&mut self, mode: &[u8]) -> Result<(bool, bool), ()> {
        let mut exclusive = false;
        let mut cloexec = false;

        for &ch in mode {
            if ch.is_ascii_digit() {
                self.level = (ch - b'0') as i8;
            } else {
                match ch {
                    b'r' => self.mode = GzMode::GZ_READ,
                    b'w' => self.mode = GzMode::GZ_WRITE,
                    b'a' => self.mode = GzMode::GZ_APPEND,
                    b'+' => {
                        // Read+Write mode isn't supported
                        return Err(());
                    }
                    b'b' => {} // binary mode is the default
                    b'e' => cloexec = true,
                    b'x' => exclusive = true,
                    b'f' => self.strategy = Strategy::Filtered,
                    b'h' => self.strategy = Strategy::HuffmanOnly,
                    b'R' => self.strategy = Strategy::Rle,
                    b'F' => self.strategy = Strategy::Fixed,
                    b'T' => self.direct = true,
                    _ => {} // for compatibility with zlib-ng, ignore unexpected characters in the mode
                }
            }
        }

        Ok((exclusive, cloexec))
    }

    // Get the number of bytes allocated for the `self.input` buffer.
    fn in_capacity(&self) -> usize {
        match self.mode {
            GzMode::GZ_WRITE => self.want * 2,
            _ => self.want,
        }
    }

    // Get the number of bytes allocated for the `self.output` buffer.
    fn out_capacity(&self) -> usize {
        match self.mode {
            GzMode::GZ_READ => self.want * 2,
            _ => self.want,
        }
    }

    /// Compute the number of bytes of input buffered in `self`.
    ///
    /// # Safety
    ///
    /// Either
    /// - `state.input` is null.
    /// - `state.stream.next_in .. state.stream.next_in + state.stream.avail_in`
    ///   is contained in `state.input .. state.input + state.in_size`.
    ///
    /// It is almost always the case that one of those two conditions is true
    /// inside this module. The notable exception is in a specific block within
    /// `gz_write`, where we temporarily set `state.next_in` to point to a
    /// caller-supplied buffer to do a zero-copy optimization when compressing
    /// large inputs.
    unsafe fn input_len(&self) -> usize {
        if self.input.is_null() {
            return 0;
        }

        // Safety: `next_in .. next_in + avail_in` is a subslice, so the preconditions hold.
        let end = unsafe { self.stream.next_in.add(self.stream.avail_in as usize) };

        // Safety: the caller guarantees that the input slice of `stream` is a subslice of `input`.
        (unsafe { end.offset_from(self.input) }) as _
    }
}

// Gzip operating modes
// NOTE: These values match what zlib-ng uses.
#[allow(non_camel_case_types)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GzMode {
    GZ_NONE = 0,
    GZ_READ = 7247,
    GZ_WRITE = 31153,
    GZ_APPEND = 1,
}

// gzip read strategies
// NOTE: These values match what zlib-ng uses.
#[derive(Debug, PartialEq, Eq)]
enum How {
    Look = 0, // look for a gzip header
    Copy = 1, // copy input directly
    Gzip = 2, // decompress a gzip stream
}

const GZBUFSIZE: usize = 128 * 1024;

#[cfg(feature = "rust-allocator")]
use zlib_rs::allocate::RUST as ALLOCATOR;

#[cfg(not(feature = "rust-allocator"))]
#[cfg(feature = "c-allocator")]
use zlib_rs::allocate::C as ALLOCATOR;

#[cfg(not(feature = "rust-allocator"))]
#[cfg(not(feature = "c-allocator"))]
compile_error!("Either rust-allocator or c-allocator feature is required");

// The different ways to specify the source for gzopen_help
enum Source {
    Path(*const c_char),
    Fd(c_int),
}

/// Open a gzip file for reading or writing.
///
/// # Returns
///
/// * If successful, an opaque handle that the caller can later free with [`gzfree`]
/// * On error, a null pointer
///
/// # Safety
///
/// The caller must ensure that `path` and `mode` point to valid C strings. If the
/// return value is non-NULL, caller must delete it using only [`gzclose`].
///
/// [`gzfree`]: crate::z_stream
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzopen64))]
pub unsafe extern "C" fn gzopen64(path: *const c_char, mode: *const c_char) -> gzFile {
    if path.is_null() {
        return ptr::null_mut();
    }
    let source = Source::Path(path);
    unsafe { gzopen_help(source, mode) }
}

/// Open a gzip file for reading or writing.
///
/// # Returns
///
/// * If successful, an opaque handle that the caller can later free with [`gzfree`]
/// * On error, a null pointer
///
/// # Safety
///
/// The caller must ensure that `path` and `mode` point to valid C strings. If the
/// return value is non-NULL, caller must delete it using only [`gzclose`].
///
/// [`gzfree`]: crate::z_stream
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzopen))]
pub unsafe extern "C" fn gzopen(path: *const c_char, mode: *const c_char) -> gzFile {
    if path.is_null() {
        return ptr::null_mut();
    }
    let source = Source::Path(path);
    unsafe { gzopen_help(source, mode) }
}

/// Given an open file descriptor, prepare to read or write a gzip file.
/// NOTE: This is similar to [`gzopen`], but for cases where the caller already
/// has the file open.
///
/// # Returns
///
/// * If successful, an opaque handle that the caller can later free with [`gzfree`]
/// * On error, a null pointer
///
/// The file descriptor is not used until the next `gz{read, write, seek, close}` operation,
/// so `gzdopen` will not detect if `fd` is invalid (unless `fd == -1` which returns a null
/// pointer).
///
/// # Safety
///
/// The caller must ensure that `mode` points to a valid C string. If the
/// return value is non-NULL, caller must delete it using only [`gzclose`].
///
/// [`gzfree`]: crate::z_stream
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzdopen))]
pub unsafe extern "C" fn gzdopen(fd: c_int, mode: *const c_char) -> gzFile {
    // Safety: the caller is responsible for `mode` being a non-null C string.
    unsafe { gzopen_help(Source::Fd(fd), mode) }
}

/// Internal implementation shared by gzopen and gzdopen.
///
/// # Safety
///
/// The caller must ensure that mode points to a valid C string.
unsafe fn gzopen_help(source: Source, mode: *const c_char) -> gzFile {
    if mode.is_null() {
        return ptr::null_mut();
    }

    let Some(state) = ALLOCATOR.allocate_zeroed_raw::<GzState>() else {
        return ptr::null_mut();
    };
    // Safety: the allocate_zeroed_raw call above ensures that the allocated block
    // has the right size and alignment to be used as a GzState. And because the
    // allocator zeroes the allocated space, all the GzState fields are initialized.
    let state = unsafe { state.cast::<GzState>().as_mut() };
    state.in_size = 0;
    state.out_size = 0;
    state.want = GZBUFSIZE;
    state.msg = ptr::null();

    state.mode = GzMode::GZ_NONE;
    state.level = crate::Z_DEFAULT_COMPRESSION as i8;
    state.strategy = Strategy::Default;
    state.direct = false;

    state.stream = z_stream::default();
    state.stream.zalloc = Some(ALLOCATOR.zalloc);
    state.stream.zfree = Some(ALLOCATOR.zfree);
    state.stream.opaque = ALLOCATOR.opaque;

    let mode = unsafe { CStr::from_ptr(mode) };
    let Ok((exclusive, cloexec)) = state.configure(mode.to_bytes()) else {
        // Safety: state is a valid pointer allocated in this function and not used after freeing
        unsafe { free_state(state) };
        return ptr::null_mut();
    };

    // Must specify read, write, or append
    if state.mode == GzMode::GZ_NONE {
        // Safety: we know state is a valid pointer because it was allocated earlier in this
        // function, and it is not used after the free because we return immediately afterward.
        unsafe { free_state(state) };
        return ptr::null_mut();
    }

    // Can't force transparent read
    if state.mode == GzMode::GZ_READ {
        if state.direct {
            // Safety: we know state is a valid pointer because it was allocated earlier in this
            // function, and it is not used after the free because we return immediately afterward.
            unsafe { free_state(state) };
            return ptr::null_mut();
        }
        state.direct = true; // Assume an empty file for now. Later, we'll check for a gzip header.
    }

    // Open the file unless the caller passed a file descriptor.
    match source {
        Source::Fd(fd) => {
            state.fd = fd;
            state.source = Source::Fd(fd);
        }
        Source::Path(path) => {
            // Save the path name for error messages
            // FIXME: support Windows wide characters for compatibility with zlib-ng
            let cloned_path = unsafe { gz_strdup(path) };
            if cloned_path.is_null() {
                unsafe { free_state(state) };
                return ptr::null_mut();
            }
            state.source = Source::Path(cloned_path);
            let mut oflag = 0;

            #[cfg(target_os = "linux")]
            {
                oflag |= libc::O_LARGEFILE;
            }
            #[cfg(target_os = "windows")]
            {
                oflag |= libc::O_BINARY;
            }
            if cloexec {
                #[cfg(target_os = "linux")]
                {
                    oflag |= libc::O_CLOEXEC;
                }
            }

            if state.mode == GzMode::GZ_READ {
                oflag |= O_RDONLY;
            } else {
                oflag |= O_WRONLY | O_CREAT;
                if exclusive {
                    oflag |= O_EXCL;
                }
                if state.mode == GzMode::GZ_WRITE {
                    oflag |= O_TRUNC;
                } else {
                    oflag |= O_APPEND;
                }
            }
            // FIXME: support _wopen for WIN32
            // Safety: We constructed state.path as a valid C string above.
            state.fd = unsafe { libc::open(cloned_path, oflag, 0o666) };
        }
    }

    if state.fd == -1 {
        // Safety: we know state is a valid pointer because it was allocated earlier in this
        // function, and it is not used after the free because we return immediately afterward.
        unsafe { free_state(state) };
        return ptr::null_mut();
    }

    // NOTE: the `lseek64` return value is ignored, an invalid file descriptor will only be
    // detected by the next `gz{read, write, seek, close}`.
    if state.mode == GzMode::GZ_APPEND {
        let _ = lseek64(state.fd, 0, SEEK_END); // so gzoffset() is correct
        state.mode = GzMode::GZ_WRITE; // simplify later checks
    }

    if state.mode == GzMode::GZ_READ {
        // Save the current position for rewinding
        state.start = lseek64(state.fd, 0, SEEK_CUR) as _;
        if state.start == -1 {
            state.start = 0;
        }
    }

    // Initialize stream
    gz_reset(state);

    // FIXME change this to core::ptr::from_mut(state).cast::<gzFile_s>() once MSRV >= 1.76
    (state as *mut GzState).cast::<gzFile_s>()
}

// Format a fake file path corresponding to an fd, for use in error messages.
fn fd_path(buf: &mut [u8; 27], fd: c_int) -> &CStr {
    // This is equivalent to `format!("<fd:{}>\0", fd)`, but without the dependency on std.

    use core::fmt::Write;

    // The array size is chosen so that any file descriptor value will fit. We need space for 6
    // characters, plus space for the largest decimal value for the `c_int` type. On some systems
    // the c_int type can actually be 64 bits. The `i64::MIN` value has 20 digits, and the minus
    // sign, for a total of 6 + 20 + 1 = 27.
    struct Writer<'a> {
        buf: &'a mut [u8; 27],
        len: usize,
    }

    impl Write for Writer<'_> {
        fn write_str(&mut self, s: &str) -> core::fmt::Result {
            let Some(dst) = self.buf.get_mut(self.len..self.len + s.len()) else {
                return Err(core::fmt::Error);
            };

            dst.copy_from_slice(s.as_bytes());
            self.len += s.len();

            Ok(())
        }
    }

    let mut w = Writer { buf, len: 0 };

    write!(w, "<fd:{fd}>\0").unwrap();

    unsafe { CStr::from_ptr(w.buf[..w.len].as_ptr().cast()) }
}

// Reset the internal state of an open gzip stream according to
// its mode (read or write)
fn gz_reset(state: &mut GzState) {
    state.have = 0; // no output data available
    if state.mode == GzMode::GZ_READ {
        state.eof = false; // not at end of file
        state.past = false; // have not read past end yet
        state.how = How::Look; // look for gzip header
    } else {
        state.reset = false; // no deflateReset pending
    }
    state.seek = false; // no seek request pending
                        // Safety: It is valid to pass a null msg pointer to `gz_error`.
    unsafe { gz_error(state, None) }; // clear error status
    state.pos = 0; // no uncompressed data yet
    state.stream.avail_in = 0; // no input data yet
}

// Set the error message for a gzip stream, and deallocate any
// previously set error message.
//
// # Arguments
//
// * `state` - An initialized stream state.
// * `err_msg` - `None` or `Some(err, msg)`. In the latter case, this function will
//   make a deep copy of the `msg` string, so `msg` need not remain in scope after the
//   call to this function.
//
// # Safety
//
// - `state` must be a properly constructed `GzState`, e.g. as produced by [`gzopen`]
unsafe fn gz_error(state: &mut GzState, err_msg: Option<(c_int, &str)>) {
    if !state.msg.is_null() {
        // NOTE: zlib-ng has a special case here: it skips the deallocation if
        // state.err == Z_MEM_ERROR. However, we always set state.msg to null
        // when state.err is set to Z_MEM_ERROR, so that case is unreachable
        // here.
        unsafe { deallocate_cstr(state.msg.cast_mut()) };
        state.msg = ptr::null_mut();
    }

    match err_msg {
        None => {
            state.err = Z_OK;
        }
        Some((err, msg)) => {
            // On error, set state.have to 0 so that the `gzgetc()` C macro fails
            if err != Z_OK && err != Z_BUF_ERROR {
                state.have = 0;
            }

            // Set the error code
            state.err = err;

            // For an out of memory error, don't bother trying to allocate space for an error string.
            // ([`gzerror`] will provide literal string as a special case for OOM errors.)
            if err == Z_MEM_ERROR {
                return;
            }

            // Format the error string to include the file path.
            // Safety: `gzopen` and `gzdopen` ensure that `state.path` is a non-null C string
            let sep = ": ";
            let buf = &mut [0u8; 27];
            state.msg = match state.source {
                Source::Path(path) => unsafe {
                    gz_strcat(&[CStr::from_ptr(path).to_str().unwrap(), sep, msg])
                },
                Source::Fd(fd) => unsafe {
                    gz_strcat(&[fd_path(buf, fd).to_str().unwrap(), sep, msg])
                },
            };

            if state.msg.is_null() {
                state.err = Z_MEM_ERROR;
            }
        }
    }
}

// Deallocate a GzState structure and all heap-allocated fields inside it.
//
// # Safety
//
// - The `state` object and all heap-allocated fields within it must have been obtained
//   using `ALLOCATOR`.
// - The caller must not use the `state` after passing it to this function.
unsafe fn free_state(state: *mut GzState) {
    if state.is_null() {
        return;
    }
    // Safety: `deallocate_cstr` accepts null pointers or C strings, and in this
    // module we use only `ALLOCATOR` to allocate strings assigned to these fields.
    unsafe {
        match (*state).source {
            Source::Path(path) => deallocate_cstr(path.cast_mut()),
            Source::Fd(_) => { /* fd is owned by the caller */ }
        }
        deallocate_cstr((*state).msg.cast_mut());
    }
    // Safety: state is a valid GzState, and free_buffers checks for null
    // input and output pointers internally.
    unsafe { free_buffers(state.as_mut().unwrap()) };

    // Safety: The caller has ensured that `state` was allocated using `ALLOCATOR`.
    unsafe { ALLOCATOR.deallocate(state, 1) };
}

// Deallocate the input and output buffers in a GzState.
//
// # Safety
//
// * `state` must have been obtained from [`gzopen`] or [`gzdopen`].
unsafe fn free_buffers(state: &mut GzState) {
    if !state.input.is_null() {
        // Safety: state.input is always allocated using ALLOCATOR, and
        // its allocation size is stored in state.in_size.
        unsafe { ALLOCATOR.deallocate(state.input, state.in_capacity()) };
        state.input = ptr::null_mut();
    }
    state.in_size = 0;
    if !state.output.is_null() {
        // Safety: state.output is always allocated using ALLOCATOR, and
        // its allocation size is stored in state.out_size.
        unsafe { ALLOCATOR.deallocate(state.output, state.out_capacity()) };
        state.output = ptr::null_mut();
    }
    state.out_size = 0;
}

// Free a string that was allocated with `ALLOCATOR`
//
// # Safety
//
// * `s` must be either null or a null-terminated C string that was allocated with `ALLOCATOR`.
// * If `s` is not null, the length of the string (including the null terminator byte) must
//   exactly match the allocation size.
unsafe fn deallocate_cstr(s: *mut c_char) {
    if s.is_null() {
        return;
    }
    // Safety: We checked above that `s` is non-null, and the caller ensured it
    // is a C string allocated with `ALLOCATOR`.
    unsafe { ALLOCATOR.deallocate::<c_char>(s, libc::strlen(s) + 1) };
}

/// Close an open gzip file and free the internal data structures referenced by the file handle.
///
/// # Returns
///
/// * [`Z_ERRNO`] if closing the file failed
/// * [`Z_OK`] otherwise
///
/// # Safety
///
/// `file` must be one of the following:
/// - A file handle must have been obtained from a function in this library, such as [`gzopen`].
/// - A null pointer.
///
/// This function may be called at most once for any file handle.
///
/// `file` must not be used after this call returns, as the memory it references may have
/// been deallocated.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzclose))]
pub unsafe extern "C" fn gzclose(file: gzFile) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_ref() }) else {
        return Z_STREAM_ERROR;
    };

    match state.mode {
        GzMode::GZ_READ => unsafe { gzclose_r(file) },
        GzMode::GZ_WRITE | GzMode::GZ_APPEND | GzMode::GZ_NONE => unsafe { gzclose_w(file) },
    }
}

/// Close a gzip file that was opened for reading.
///
/// # Returns
///
/// * Z_OK if `state` has no outstanding error and the file is closed successfully.
/// * A Z_ error code if the `state` is null or the file close operation fails.
///
/// # Safety
///
/// `file` must be one of the following:
/// - A file handle must have been obtained from a function in this library, such as [`gzopen`].
/// - A null pointer.
///
/// `file` must not be used after this call returns, as the memory it references may have
/// been deallocated.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzclose_r))]
pub unsafe extern "C" fn gzclose_r(file: gzFile) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return Z_STREAM_ERROR;
    };

    // Check that we're reading.
    if state.mode != GzMode::GZ_READ {
        return Z_STREAM_ERROR;
    }

    // Process any buffered input.
    if state.in_size != 0 {
        // Safety: state.stream was properly initialized as a z_stream in gzopen_help.
        unsafe { inflateEnd(&mut state.stream as *mut z_stream) };
    }

    let err = match state.err {
        Z_BUF_ERROR => Z_BUF_ERROR,
        _ => Z_OK,
    };

    let ret = match unsafe { libc::close(state.fd) } {
        0 => err,
        _ => Z_ERRNO,
    };

    // Delete the underlying allocation.
    // Safety: The `state` reference is not used beyond this point.
    unsafe { free_state(file.cast::<GzState>()) };

    ret
}

/// Close a gzip file that was opened for writing.
///
/// # Returns
///
/// * Z_OK if `state` has no outstanding error and the file is closed successfully.
/// * A Z_ error code if the `state` is null or the file close operation fails.
///
/// # Safety
///
/// `file` must be one of the following:
/// - A file handle must have been obtained from a function in this library, such as [`gzopen`].
/// - A null pointer.
///
/// `file` must not be used after this call returns, as the memory it references may have
/// been deallocated.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzclose_w))]
pub unsafe extern "C" fn gzclose_w(file: gzFile) -> c_int {
    let mut ret = Z_OK;

    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return Z_STREAM_ERROR;
    };

    // Check that we're writing.
    if state.mode != GzMode::GZ_WRITE {
        return Z_STREAM_ERROR;
    }

    // Check for a pending seek request
    if state.seek {
        state.seek = false;
        if gz_zero(state, state.skip as _).is_err() {
            ret = state.err;
        }
    }

    // Compress (if not in direct mode) and output any data left in the input buffer.
    if gz_comp(state, Z_FINISH).is_err() {
        ret = state.err;
    }
    if state.in_size != 0 && !state.direct {
        // Safety: state.stream was properly initialized as a z_stream in gzopen_help.
        unsafe { deflateEnd(&mut state.stream as *mut z_stream) };
    }
    if unsafe { libc::close(state.fd) } == -1 {
        ret = Z_ERRNO;
    }

    // Delete the underlying allocation.
    // Safety: The `state` reference is not used beyond this point.
    unsafe { free_state(file.cast::<GzState>()) };

    ret
}

/// Set the internal buffer size used by this library's functions for `file` to
/// `size`.  The default buffer size is 128 KB.  This function must be called
/// after [`gzopen`] or [`gzdopen`], but before any other calls that read or write
/// the file (including [`gzdirect`]).  The buffer memory allocation is always
/// deferred to the first read or write.  Three times `size` in buffer space is
/// allocated.
///
/// # Returns
///
/// * `0` on success.
/// * `-1` on failure.
///
/// # Arguments
///
/// * `file` - file handle.
/// * `size` - requested buffer size in bytes.
///
/// # Safety
///
/// `file` must be one of the following:
/// - A file handle must have been obtained from a function in this library, such as [`gzopen`].
/// - A null pointer.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzbuffer))]
pub unsafe extern "C" fn gzbuffer(file: gzFile, size: c_uint) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return -1;
    };
    if state.mode != GzMode::GZ_READ && state.mode != GzMode::GZ_WRITE {
        return -1;
    }

    // Make sure we haven't already allocated memory.
    if state.in_size != 0 {
        return -1;
    }

    // Check and set requested size.
    let size = size as usize;
    if size.checked_mul(2).is_none() {
        // We must be able to double the requested size, because one of the two
        // buffers (state.input in write mode, state.output in read mode) will be
        // allocated as twice the requested size. Note: Because the C API specifies `size`
        // is an unsigned int, but we use usize to represent the buffer sizes internally,
        // this error condition is impossible to trigger in the common case where int
        // is 32 bits and usize is 64 bits.
        return -1;
    }

    // Use a minimum buffer size of 8 to work with flush semantics elsewhere in the implementation.
    state.want = Ord::max(size, 8);

    0
}

/// Retrieve the zlib error code and a human-readable string description of
/// the most recent error on a gzip file stream.
///
/// # Arguments
///
/// * `file` - A gzip file handle, or null
/// * `errnum` - A pointer to a C integer in which the zlib error code should be
///   written, or null if the caller does not need the numeric error code.
///
/// # Returns
///
/// * A pointer to a null-terminated C string describing the error, if `file` is non-null
///   and has an error
/// * A pointer to an empty (zero-length), null-terminated C string, if `file` is non-null
///   but has no error
/// * Null otherwise
///
/// # Safety
///
/// `file` must be one of the following:
/// - A file handle obtained from [`gzopen`] or [`gzdopen`].
/// - A null pointer.
///
/// If this function returns a non-null string, the caller must not modifiy or
/// deallocate the string.
///
/// If `errnum` is non-null, it must point to an address at which a [`c_int`] may be written.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzerror))]
pub unsafe extern "C" fn gzerror(file: gzFile, errnum: *mut c_int) -> *const c_char {
    // Get internal structure and check integrity
    let Some(state) = (unsafe { file.cast::<GzState>().as_ref() }) else {
        return ptr::null();
    };
    if state.mode != GzMode::GZ_READ && state.mode != GzMode::GZ_WRITE {
        return ptr::null();
    }

    // Return error information
    if !errnum.is_null() {
        // Safety:
        // * `errnum` is non-null
        // * The caller is responsible for ensuring that `errnum` points to writable
        //   memory with proper alignment.
        unsafe { *errnum = state.err };
    }
    if state.err == Z_MEM_ERROR {
        b"out of memory\0".as_ptr().cast::<c_char>()
    } else if state.msg.is_null() {
        b"\0".as_ptr().cast::<c_char>()
    } else {
        state.msg
    }
}

/// Clear the error and end-of-file state for `file`.
///
/// # Arguments
///
/// * `file` - A gzip file handle, or null
///
/// # Safety
///
/// `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzclearerr))]
pub unsafe extern "C" fn gzclearerr(file: gzFile) {
    // Get internal structure and check integrity
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return;
    };
    if state.mode != GzMode::GZ_READ && state.mode != GzMode::GZ_WRITE {
        return;
    }

    // Clear error and EOF
    if state.mode == GzMode::GZ_READ {
        state.eof = false;
        state.past = false;
    }

    // Safety: we've checked state, and gz_error supports a null message argument.
    unsafe { gz_error(state, None) };
}

/// Check whether a read operation has tried to read beyond the end of `file`.
///
/// # Returns
///
/// * 1 if the end-of-file indicator is set. Note that this indicator is set only
///   if a read tries to go past the end of the input. If the last read request
///   attempted to read exactly the number of bytes remaining in the file, the
///   end-of-file indicator will not be set.
/// * 0 the end-of-file indicator is not set or `file` is null
///
/// # Arguments
///
/// * `file` - A gzip file handle, or null
///
/// # Safety
///
/// `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzeof))]
pub unsafe extern "C" fn gzeof(file: gzFile) -> c_int {
    // Get internal structure and check integrity
    let Some(state) = (unsafe { file.cast::<GzState>().as_ref() }) else {
        return 0;
    };
    if state.mode != GzMode::GZ_READ {
        return 0;
    }

    // Per the semantics described in the function comments above, the return value
    // is based on state.past, rather than state.eof.
    state.past as _
}

/// Check whether `file` is in direct mode (reading or writing literal bytes without compression).
///
/// NOTE: If `gzdirect` is called immediately after [`gzopen`] or [`gzdopen`], it may allocate
/// buffers internally to read the file header and determine whether the content is a gzip file.
/// If [`gzbuffer`] is used, it should be called before `gzdirect`.
///
/// # Returns
///
/// 0 if `file` is null.
///
/// If `file` is being read,
/// * 1 if the contents are being read directly, without decompression.
/// * 0 if the contents are being decompressed when read.
///
/// If `file` is being written,
/// * 1 if transparent mode was requested upon open (with the `"wT"` mode flag for [`gzopen`]).
/// * 0 otherwise.
///
/// # Arguments
///
/// * `file` - A gzip file handle, or null
///
/// # Safety
///
/// `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzdirect))]
pub unsafe extern "C" fn gzdirect(file: gzFile) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return 0;
    };

    // In write mode, the direct flag was set in `gzopen_help`. In read mode, the
    // direct status is determined lazily on the first read operation. If the first
    // read hasn't happened yet, we can look at the header now to determine if the
    // file is in gzip format.
    if state.mode == GzMode::GZ_READ && state.how == How::Look && state.have == 0 {
        let _ = unsafe { gz_look(state) };
    }

    state.direct as _
}

/// Read and decompress up to `len` uncompressed bytes from `file` into `buf`.  If
/// the input file is not in gzip format, `gzread` copies up to `len` bytes into
/// the buffer directly from the file.
///
/// After reaching the end of a gzip stream in the input, `gzread` will continue
/// to read, looking for another gzip stream.  Any number of gzip streams may be
/// concatenated in the input file, and will all be decompressed by `gzread()`.
/// If something other than a gzip stream is encountered after a gzip stream,
/// `gzread` ignores that remaining trailing garbage (and no error is returned).
///
/// `gzread` can be used to read a gzip file that is being concurrently written.
/// Upon reaching the end of the input, `gzread` will return with the available
/// data.  If the error code returned by [`gzerror`] is `Z_OK` or `Z_BUF_ERROR`,
/// then [`gzclearerr`] can be used to clear the end of file indicator in order
/// to permit `gzread` to be tried again.  `Z_OK` indicates that a gzip stream
/// was completed on the last `gzread`.  `Z_BUF_ERROR` indicates that the input
/// file ended in the middle of a gzip stream.  Note that `gzread` does not return
/// `-1` in the event of an incomplete gzip stream.  This error is deferred until
/// [`gzclose`], which will return `Z_BUF_ERROR` if the last gzread ended in the
/// middle of a gzip stream.  Alternatively, `gzerror` can be used before `gzclose`
/// to detect this case.
///
/// If the unsigned value `len` is too large to fit in the signed return type
/// `c_int`, then nothing is read, `-1` is returned, and the error state is set to
/// `Z_STREAM_ERROR`.
///
/// # Returns
///
/// * The number of uncompressed bytes read from the file into `buf`, which may
///   be smaller than `len` if there is insufficient data in the file.
/// * `-1` on error.
///
/// # Arguments
///
/// * `file` - A gzip file handle, or null.
/// * `buf` - Buffer where the read data should be stored. The caller retains ownership of this buffer.
/// * `len` - Number of bytes to attempt to read into `buf`.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
/// - The caller must ensure that `buf` points to at least `len` writable bytes.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzread))]
pub unsafe extern "C" fn gzread(file: gzFile, buf: *mut c_void, len: c_uint) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return -1;
    };

    // Check that we're reading and that there's no (serious) error.
    if state.mode != GzMode::GZ_READ || (state.err != Z_OK && state.err != Z_BUF_ERROR) {
        return -1;
    }

    // Check that the requested number of bytes can be represented by the return type.
    if c_int::try_from(len).is_err() {
        const MSG: &str = "request does not fit in an int";
        // Safety: we confirmed above that state is valid.
        unsafe { gz_error(state, Some((Z_STREAM_ERROR, MSG))) };
        return -1;
    }

    // With the initial checks passed, try the actual read.
    // Safety: The caller is responsible for ensuring that `buf` points to >= `len` writable bytes.
    let got = unsafe { gz_read(state, buf.cast::<u8>(), len as usize) };

    // Check for an error
    if got == 0 && state.err != Z_OK && state.err != Z_BUF_ERROR {
        -1
    } else {
        got as _
    }
}

/// Read and decompress up to `nitems` items of size `size` from `file` into `buf`,
/// otherwise operating as [`gzread`] does. This duplicates the interface of
/// C stdio's `fread()`, with `size_t` request and return types.
///
/// `gzfread` returns the number of full items read of size `size`, or zero if
/// the end of the file was reached and a full item could not be read, or if
/// there was an error.  [`gzerror`] must be consulted if zero is returned in
/// order to determine if there was an error.  If the multiplication of `size` and
/// `nitems` overflows, i.e. the product does not fit in a `size_t`, then nothing
/// is read, zero is returned, and the error state is set to `Z_STREAM_ERROR`.
///
/// In the event that the end of file is reached and only a partial item is
/// available at the end, i.e. the remaining uncompressed data length is not a
/// multiple of `size`, then the final partial item is nevertheless read into `buf`
/// and the end-of-file flag is set.  The length of the partial item read is not
/// provided, but could be inferred from the result of [`gztell`].  This behavior
/// is the same as the behavior of `fread` implementations in common libraries,
/// but it prevents the direct use of `gzfread` to read a concurrently written
/// file, resetting and retrying on end-of-file, when `size` is not 1.
///
/// # Returns
///
/// - The number of complete object of size `size` read into `buf`.
/// - `0` on error or end-of-file.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
/// - The caller must ensure that `buf` points to at least `size * nitems` writable bytes.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzfread))]
pub unsafe extern "C" fn gzfread(
    buf: *mut c_void,
    size: size_t,
    nitems: size_t,
    file: gzFile,
) -> size_t {
    if size == 0 || buf.is_null() {
        return 0;
    }

    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return 0;
    };

    // Check that we're reading and that there's no (serious) error.
    if state.mode != GzMode::GZ_READ || (state.err != Z_OK && state.err != Z_BUF_ERROR) {
        return 0;
    }

    // Compute the number of bytes to read, and make sure it fits in a size_t.
    let Some(len) = size.checked_mul(nitems) else {
        const MSG: &str = "request does not fit in a size_t";
        unsafe { gz_error(state, Some((Z_STREAM_ERROR, MSG))) };
        return 0;
    };

    if len == 0 {
        len
    } else {
        // Safety: The caller is responsible for ensuring that `buf` points to at least
        // `len = size * nitems` writable bytes.
        (unsafe { gz_read(state, buf.cast::<u8>(), len) }) / size
    }
}

// Attempt to read enough bytes from the input to fill the supplied `buf`.
//
// # Returns
//
// The number of bytes read into `buf`. Note: A return value of zero means either end-of-file
// or an error. `state.err` must be consulted to determine which.
//
// # Safety
//
// * `state` must have been properly initialized, e.g. by [`gzopen_help`].
// * `buf` must point to at least `len` bytes of writable memory.
unsafe fn gz_read(state: &mut GzState, mut buf: *mut u8, mut len: usize) -> usize {
    if len == 0 {
        return 0;
    }

    // Process a skip request.
    if state.seek {
        state.seek = false;
        if gz_skip(state, state.skip).is_err() {
            return 0;
        }
    }

    // Loop until we get enough bytes or reach the end of the file.
    let mut got = 0;
    loop {
        // Set n to the maximum amount of len that fits in an unsigned int.
        let mut n = Ord::min(len, c_uint::MAX as usize);

        // First just try copying data from the output buffer. Note: The output
        // buffer contains bytes that have been decompressed by `state.stream` and
        // are waiting to be consumed - or, in direct mode, it contains bytes read
        // directly from the underlying file descriptor.
        if state.have != 0 {
            n = Ord::min(n, state.have as usize);
            // Safety:
            // * n <= state.have, and there are `state.have` readable bytes starting
            //   at `state.next`.
            // * n <= len, and the caller is responsible for ensuring that `buf`
            //   points to at least `len` writable bytes.
            // * `state.next` points into an internal buffer not visible outside the
            //   `GzState`, and `buf` is supplied by the caller, so the source and
            //   destination are guaranteed not to overlap.
            unsafe { ptr::copy_nonoverlapping(state.next, buf, n) };
            state.next = unsafe { state.next.add(n) };
            state.have -= n as c_uint;
        } else if state.eof && state.stream.avail_in == 0 {
            // The output buffer is empty, and we're at the end of the file.
            state.past = true; // Tried to read past end
            break;
        } else if state.how == How::Look || n < state.in_size * 2 {
            // For small len or a new stream, load more data from the file descriptor into
            // the output buffer. Note: If we haven't scanned the file header yet, gz_fetch
            // will read the header and determine whether to use decompression or direct read.
            if unsafe { gz_fetch(state) }.is_err() {
                return 0;
            }

            // Now that we've tried reading, we can try to copy from the output buffer.
            // The copy above assures that we will leave with space in the output buffer,
            // allowing at least one gzungetc() to succeed.
            continue;
        } else if state.how == How::Copy {
            // For a large requested read length, in copy mode (meaning that the input
            // file is not gzip and we're returning its contents directly), bypass the
            // output buffer and read from the file descriptor directly into buf.
            // Safety: n <= len, and the caller is responsible for ensuring that `buf`
            // points to at least `len` writable bytes.
            let Ok(bytes_read) = (unsafe { gz_load(state, buf, n) }) else {
                return 0;
            };
            n = bytes_read;
        } else {
            // We are in gzip mode, and the requested read size is large. Get more data and
            // decompress it directly into buf, bypassing stream.output.
            debug_assert_eq!(state.how, How::Gzip);
            state.stream.avail_out = n as c_uint;
            state.stream.next_out = buf;
            if unsafe { gz_decomp(state) }.is_err() {
                return 0;
            }
            n = state.have as usize;
            state.have = 0;
        }

        // Update progress
        len -= n;
        buf = unsafe { buf.add(n) };
        got += n;
        state.pos += n as i64;

        if len == 0 {
            break;
        }
    }

    got
}

// Given an unsigned value `x`, determine whether `x` is larger than the maximum
// signed 64-bit offset value.
// Note: This can happen only on targets where the C unsigned int is a 64-bit value.
macro_rules! gt_off {
    ($x:expr) => {
        core::mem::size_of_val(&$x) == core::mem::size_of::<i64>()
            && $x as usize > i64::MAX as usize
    };
}

// Skip len uncompressed bytes of output.
//
// # Returns
//
// - `Ok` on success.
// - `Err` on error.
fn gz_skip(state: &mut GzState, mut len: i64) -> Result<(), ()> {
    // Skip over len bytes or reach end-of-file, whichever comes first.
    while len != 0 {
        // Skip over whatever is in output buffer.
        if state.have != 0 {
            // For consistency with zlib-ng, we use `gt_off` to check whether the value
            // of `state.have` is too large to be represented as a signed 64-bit offset.
            // This case can be triggered only if the platform has 64-bit C ints and
            // `state.have` is >= 2^63.
            let n = if gt_off!(state.have) || state.have as i64 > len {
                len as usize
            } else {
                state.have as usize
            };
            state.have -= n as c_uint;
            // Safety: `n` <= `state.have` and there are at least `state.have` accessible
            // bytes after `state.next` in the buffer.
            state.next = unsafe { state.next.add(n) };
            state.pos += n as i64;
            len -= n as i64;
        } else if state.eof && state.stream.avail_in == 0 {
            // Output buffer empty -- return if we're at the end of the input.
            break;
        } else {
            // Need more data to skip -- load up output buffer.
            // Get more output, looking for header if required.
            // Safety: `state` is valid, and `state.have` is zero in this branch.
            if unsafe { gz_fetch(state) }.is_err() {
                return Err(());
            }
        }
    }
    Ok(())
}

// Given a gzip file opened for reading, check for a gzip header, and set
// `state.direct` accordingly.
//
// # Returns
//
// * `Ok` on success
// * `Err` on failure
//
// # Safety
//
// `state` must have been properly initialized, e.g. by [`gzopen_help`].
unsafe fn gz_look(state: &mut GzState) -> Result<(), ()> {
    // Allocate buffers if needed.
    if state.input.is_null() {
        let capacity = state.in_capacity();
        state.in_size = capacity;
        let Some(input) = ALLOCATOR.allocate_slice_raw::<u8>(capacity) else {
            // Safety: The caller confirmed the validity of state.
            unsafe { gz_error(state, Some((Z_MEM_ERROR, "out of memory"))) };
            return Err(());
        };
        state.input = input.as_ptr();

        if state.output.is_null() {
            let capacity = state.out_capacity();
            state.out_size = capacity;
            let Some(output) = ALLOCATOR.allocate_slice_raw::<u8>(capacity) else {
                // Safety: The caller confirmed the validity of state, and free_buffers checks
                // for null input and output pointers internally.
                unsafe { free_buffers(state) };
                // Safety: The caller confirmed the validity of state.
                unsafe { gz_error(state, Some((Z_MEM_ERROR, "out of memory"))) };
                return Err(());
            };
            state.output = output.as_ptr();
        }

        // Allocate memory for inflate.
        state.stream.avail_in = 0;
        state.stream.next_in = ptr::null_mut();
        // Safety: `gzopen_help` initialized `state.stream`'s `zalloc`, `zfree`, and
        // `opaque` fields as needed by `inflateInit2`.
        if unsafe {
            inflateInit2_(
                &mut state.stream as *mut z_stream,
                MAX_WBITS + 16,
                zlibVersion(),
                core::mem::size_of::<z_stream>() as i32,
            )
        } != Z_OK
        {
            // Safety: The caller confirmed the validity of `state`, and `free_buffers` checks
            // for null input and output pointers internally.
            unsafe { free_buffers(state) };
            // Safety: The caller confirmed the validity of `state`.
            unsafe { gz_error(state, Some((Z_MEM_ERROR, "out of memory"))) };
            return Err(());
        }
    }

    // Get at least the magic bytes in the input buffer.
    if state.stream.avail_in < 2 {
        // `gz_avail` attempts to read as much data as available from the underlying file
        // into the input buffer. This will hopefully give us enough bytes to check for a
        // gzip file header.
        // Safety: The caller confirmed the validity of `state`.
        if unsafe { gz_avail(state) }? == 0 {
            return Ok(());
        }
    }

    // Look for gzip magic bytes.
    // Note: If we are reading a partially written gzip file, and all that is available to read is
    // the first byte of the gzip magic number, we cannot tell whether what follows will be the
    // rest of the gzip magic. For simplicity, we assume that the writer of a gzip file will
    // write the header (or at least the magic number at the start of the header) atomically,
    // so if our initial read found a single byte it is a sufficient indication that the file
    // is not in gzip format.
    // Safety: `gz_avail` ensures that `next_in` points to at least `avail_in` readable bytes.
    if state.stream.avail_in > 1
        && unsafe { *state.stream.next_in } == 31
        && unsafe { *state.stream.next_in.add(1) } == 139
    {
        // Safety: We initialized `state.stream` with `inflateInit2` above.
        unsafe { inflateReset(&mut state.stream as *mut z_stream) };
        state.how = How::Gzip;
        state.direct = false;
        return Ok(());
    }

    // No gzip header. If we were decoding gzip before, the remaining bytes
    // are trailing garbage that can be ignored.
    if !state.direct {
        state.stream.avail_in = 0;
        state.eof = true;
        state.have = 0;
        return Ok(());
    }

    // The file is not in gzip format, so enable direct mode, and copy all
    // buffered input to the output.
    // Safety:
    // * `state.output` was allocated above.
    // * `gz_avail` ensures that `next_in` points to at least `avail_in` readable bytes.
    unsafe {
        ptr::copy_nonoverlapping(
            state.stream.next_in,
            state.output,
            state.stream.avail_in as usize,
        )
    };
    state.next = state.output;
    state.have = state.stream.avail_in;
    state.stream.avail_in = 0;
    state.how = How::Copy;
    state.direct = true;

    Ok(())
}

// Load data into the input buffer and set the eof flag if the last of the data has been
// loaded.
//
// # Returns
//
// * `Ok(n)` on success, where `n` is the number of bytes available (`state.stream.avail_in`)
// * `Err` on error
//
// # Safety
//
// `state` must have been properly initialized, e.g. by [`gzopen_help`].
unsafe fn gz_avail(state: &mut GzState) -> Result<usize, ()> {
    if state.err != Z_OK && state.err != Z_BUF_ERROR {
        return Err(());
    }
    if !state.eof {
        if state.stream.avail_in != 0 {
            // Copy any remaining input to the start. Note: The source and destination are
            // within the same buffer, so this may be an overlapping copy.
            unsafe {
                ptr::copy(
                    state.stream.next_in,
                    state.input,
                    state.stream.avail_in as usize,
                )
            };
        }
        let got = unsafe {
            gz_load(
                state,
                state.input.add(state.stream.avail_in as usize),
                state.in_size - state.stream.avail_in as usize,
            )
        }?;
        state.stream.avail_in += got as uInt;
        state.stream.next_in = state.input;
    }
    Ok(state.stream.avail_in as usize)
}

// Read data from `state`'s underlying file descriptor into a buffer.
//
// # Returns
//
// * `Ok(n)` on success, where `n` is the number of bytes read.
// * `Err` on error
//
// # Arguments
//
// * `state` - gzip file handle.
// * `buf` - address at which the data read from the file should be stored.
// * `size` - number of bytes to read
//
// # Safety
//
// * `state` must have been properly initialized, e.g. by [`gzopen_help`].
// * `buf` mut point to a writable block of at least `len` bytes.
unsafe fn gz_load(state: &mut GzState, buf: *mut u8, len: usize) -> Result<usize, ()> {
    let mut have = 0;
    let mut ret = 0;
    while have < len {
        ret = unsafe { libc::read(state.fd, buf.add(have).cast::<_>(), (len - have) as _) };
        if ret <= 0 {
            break;
        }
        have += ret as usize;
    }
    if ret < 0 {
        unsafe { gz_error(state, Some((Z_ERRNO, "read error"))) }; // FIXME implement `zstrerror`
        return Err(());
    }
    if ret == 0 {
        state.eof = true;
    }
    Ok(have)
}

// Fetch data and put it in the output buffer, decompressing if needed. If the header has
// not been read yet, parse it to determine whether the file is in gzip format.
//
// # Returns
//
// * `Ok` on success.
// * `Err` on error. Check [`gzerror`] for more information on the error condition.
//
// # Safety
// * `state` must have been properly initialized, e.g. by [`gzopen_help`].
// * `state.have` must be zero.
//
unsafe fn gz_fetch(state: &mut GzState) -> Result<(), ()> {
    loop {
        // Process the input, which may cause state transitions among Look/Gzip/Copy.
        match &state.how {
            How::Look => {
                // -> Look, Copy (only if never Gzip), or Gzip
                unsafe { gz_look(state) }?;
                if state.how == How::Look {
                    return Ok(());
                }
            }
            How::Copy => {
                // -> Copy
                let bytes_read = unsafe { gz_load(state, state.output, state.out_size) }?;
                state.next = state.output;
                state.have += bytes_read as uInt;
                return Ok(());
            }
            How::Gzip => {
                // -> Gzip or Look (if at end of gzip stream)
                state.stream.avail_out = state.out_size as c_uint;
                state.stream.next_out = state.output;
                unsafe { gz_decomp(state) }?;
            }
        }

        // Keep trying until either:
        // - we have some data in the output buffer (measured by state.have)
        // - or both the input buffer and the underling file have been fully consumed.
        if state.have != 0 || (state.eof && state.stream.avail_in == 0) {
            break;
        }
    }

    Ok(())
}

// Decompress from input and put the result in `state`'s output buffer.
// On return, `state.have` and `state.next` denote the just decompressed
// data.  If the gzip stream completes, `state.how` is reset to `Look`
// to look for the next gzip stream or raw data once the data in the output
// buffer is consumed.
//
// # Returns
//
// * `Ok` on success.
// * `Err` on error.
//
// # Safety
//
// * `state` must have been properly initialized, e.g. by [`gzopen_help`].
unsafe fn gz_decomp(state: &mut GzState) -> Result<(), ()> {
    // Decompress into the output buffer until we run out of either input data
    // or space in the output buffer.
    let had = state.stream.avail_out;
    loop {
        // Get more input for inflate().
        if state.stream.avail_in == 0 && unsafe { gz_avail(state) }.is_err() {
            return Err(());
        }
        if state.stream.avail_in == 0 {
            unsafe { gz_error(state, Some((Z_BUF_ERROR, "unexpected end of file"))) };
            break;
        }

        // Decompress and handle errors.
        match unsafe { inflate(&mut state.stream, Z_NO_FLUSH) } {
            Z_STREAM_ERROR | Z_NEED_DICT => {
                const MSG: &str = "internal error: inflate stream corrupt";
                unsafe { gz_error(state, Some((Z_STREAM_ERROR, MSG))) };
                return Err(());
            }
            Z_MEM_ERROR => {
                unsafe { gz_error(state, Some((Z_MEM_ERROR, "out of memory"))) };
                return Err(());
            }
            Z_DATA_ERROR => {
                // FIXME gz_error(state, Z_DATA_ERROR, strm->msg == NULL ? "compressed data error" : strm->msg);
                unsafe { gz_error(state, Some((Z_DATA_ERROR, "compressed data error"))) };
                return Err(());
            }
            Z_STREAM_END => {
                // If the gzip stream completed successfully, look for another.
                state.how = How::Look;
                break;
            }
            _ => {}
        }

        if state.stream.avail_out == 0 {
            break;
        }
    }

    // Update the size and start of the data in the output buffer.
    state.have = had - state.stream.avail_out;
    state.next = unsafe { state.stream.next_out.sub(state.have as usize) };

    Ok(())
}

/// Compress and write the len uncompressed bytes at buf to file.
///
/// # Returns
///
/// - The number of uncompressed bytes written, on success.
/// - Or 0 in case of error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
/// - `buf` must point to at least `len` bytes of readable memory.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzwrite))]
pub unsafe extern "C" fn gzwrite(file: gzFile, buf: *const c_void, len: c_uint) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return 0;
    };

    // Check that we're writing and that there's no error.
    if state.mode != GzMode::GZ_WRITE || state.err != Z_OK {
        return 0;
    }

    // Check that the requested number of bytes can be represented by the return type.
    if c_int::try_from(len).is_err() {
        const MSG: &str = "requested length does not fit in int";
        // Safety: we confirmed above that state is valid.
        unsafe { gz_error(state, Some((Z_DATA_ERROR, MSG))) };
        return 0;
    }

    // Also check that the requested number of bytes can be represented by usize,
    // which gz_write uses internally.
    let Ok(len) = usize::try_from(len) else {
        const MSG: &str = "requested length does not fit in usize";
        // Safety: we confirmed above that state is valid.
        unsafe { gz_error(state, Some((Z_DATA_ERROR, MSG))) };
        return 0;
    };

    // Safety: We validated state above, and the caller is responsible for ensuring
    // that buf points to at least len bytes of readable memory.
    unsafe { gz_write(state, buf, len) }
}

/// Compress and write `nitems` items of size `size` from `buf` to `file`, duplicating
/// the interface of C stdio's `fwrite`, with `size_t` request and return types.
///
/// # Returns
///
/// - The number of full items written of size `size` on success.
/// - Zero on error.
///
/// Note: If the multiplication of `size` and `nitems` overflows, i.e. the product does
/// not fit in a `size_t`, then nothing is written, zero is returned, and the error state
/// is set to `Z_STREAM_ERROR`.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
/// - The caller must ensure that `buf` points to at least `size * nitems` readable bytes.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzfwrite))]
pub unsafe extern "C" fn gzfwrite(
    buf: *const c_void,
    size: size_t,
    nitems: size_t,
    file: gzFile,
) -> size_t {
    if size == 0 || buf.is_null() {
        return 0;
    }

    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return 0;
    };

    // Check that we're writing and that there's no error.
    if state.mode != GzMode::GZ_WRITE || state.err != Z_OK {
        return 0;
    }

    // Compute the number of bytes to write, and make sure it fits in a size_t.
    let Some(len) = size.checked_mul(nitems) else {
        const MSG: &str = "request does not fit in a size_t";
        unsafe { gz_error(state, Some((Z_STREAM_ERROR, MSG))) };
        return 0;
    };

    if len == 0 {
        len
    } else {
        // Safety: The caller is responsible for ensuring that `buf` points to at least
        // `len = size * nitems` readable bytes.
        (unsafe { gz_write(state, buf, len) }) as size_t / size
    }
}

// Internal implementation of `gzwrite`.
//
// # Returns
// - The number of uncompress bytes written, on success.
// - Or 0 in case of error.
//
// # Safety
//
/// - `state` must have been properly initialized, e.g. by [`gzopen_help`].
/// - `buf` must point to at least `len` bytes of readable memory.
unsafe fn gz_write(state: &mut GzState, mut buf: *const c_void, mut len: usize) -> c_int {
    // If len is zero, avoid unnecessary operations.
    if len == 0 {
        return 0;
    }

    // Allocate memory if this is the first time through.
    if state.input.is_null() && gz_init(state).is_err() {
        return 0;
    }

    if state.seek {
        state.seek = false;
        if gz_zero(state, state.skip as _).is_err() {
            return 0;
        }
    }

    let put = len as c_int;

    // For small len, copy to input buffer, otherwise compress directly.
    if len < state.in_size {
        // Copy to input buffer, compress when full.
        loop {
            if state.stream.avail_in == 0 {
                state.stream.next_in = state.input;
            }
            // Safety: `state.stream.next_in` points into the buffer starting at `state.input`.
            let have = unsafe { state.input_len() };
            let copy = Ord::min(state.in_size.saturating_sub(have), len);
            // Safety: The caller is responsible for ensuring that buf points to at least len readable
            // bytes, and copy is <= len.
            unsafe { ptr::copy(buf, state.input.add(have).cast::<c_void>(), copy) };
            state.stream.avail_in += copy as c_uint;
            state.pos += copy as i64;
            buf = unsafe { buf.add(copy) };
            len -= copy;
            if len != 0 && gz_comp(state, Z_NO_FLUSH).is_err() {
                return 0;
            }
            if len == 0 {
                break;
            }
        }
    } else {
        // Consume any data left in the input buffer.
        if state.stream.avail_in != 0 && gz_comp(state, Z_NO_FLUSH).is_err() {
            return 0;
        }

        // Directly compress user buffer to file.
        // Note: For this operation, we temporarily break the invariant that
        // `state.stream.next_in` points to somewhere in the `state.input` buffer.
        let save_next_in = state.stream.next_in;
        state.stream.next_in = buf.cast::<_>();
        loop {
            let n = Ord::min(len, c_uint::MAX as usize) as c_uint;
            state.stream.avail_in = n;
            state.pos += n as i64;
            if gz_comp(state, Z_NO_FLUSH).is_err() {
                return 0;
            }
            len -= n as usize;
            if len == 0 {
                break;
            }
        }
        state.stream.next_in = save_next_in;
    }

    // Input was all buffered or compressed.
    put
}

// Compress `len` null bytes to output.
//
// # Returns
//
// - `Ok` on success.
// - `Err` on error.
fn gz_zero(state: &mut GzState, mut len: usize) -> Result<(), ()> {
    // Consume whatever is left in the input buffer.
    if state.stream.avail_in != 0 && gz_comp(state, Z_NO_FLUSH).is_err() {
        return Err(());
    }

    // Compress `len` zeros.
    let mut first = true;
    while len != 0 {
        let n = Ord::min(state.in_size, len);
        if first {
            // Safety: `state.input` is non-null here, either because it was initialized
            // before this function was called (enabling the `state.stream.avail_in != 0`
            // case in the check above) or because the call to `gz_comp` initialized it.
            // All initialization paths in this module ensure that, when `state.input` is
            // non-null, it points to `state.in_size` bytes of writable memory. Here we
            // are writing `n` bytes, where `n` is initialized above to be <= `state.in_size`.
            unsafe { state.input.write_bytes(0u8, n) };
            first = false;
        }
        state.stream.avail_in = n as _;
        state.stream.next_in = state.input;
        state.pos += n as i64;
        if gz_comp(state, Z_NO_FLUSH).is_err() {
            return Err(());
        }
        len -= n;
    }

    Ok(())
}

// Initialize `state` for writing a gzip file.  Mark initialization by setting
// `state.input` to non-null.
//
// # Returns
//
// - `Ok` on success.
// - `Err` on error.
fn gz_init(state: &mut GzState) -> Result<(), ()> {
    // Allocate input buffer.
    // The buffer is twice as big as state.want, but we set in_size to half the
    // buffer size (i.e. state.in_size == state.want). The reason for this is to
    // ensure that we always have state.want bytes available for exclusive use
    // by gzprintf.
    let capacity = state.in_capacity();
    state.in_size = capacity / 2;
    let Some(input) = ALLOCATOR.allocate_slice_raw::<u8>(capacity) else {
        // Safety: The caller confirmed the validity of state.
        unsafe { gz_error(state, Some((Z_MEM_ERROR, "out of memory"))) };
        return Err(());
    };
    state.input = input.as_ptr();
    // Note: zlib-ng fills the input buffer with zeroes here, but it's unneeded.

    // Only need output buffer and deflate state if compressing.
    if !state.direct {
        // Allocate output buffer.
        let capacity = state.out_capacity();
        state.out_size = capacity;
        let Some(output) = ALLOCATOR.allocate_slice_raw::<u8>(capacity) else {
            unsafe { free_buffers(state) };
            // Safety: The caller confirmed the validity of state.
            unsafe { gz_error(state, Some((Z_MEM_ERROR, "out of memory"))) };
            return Err(());
        };
        state.output = output.as_ptr();

        // Allocate deflate memory, set up for gzip compression.
        state.stream.zalloc = Some(ALLOCATOR.zalloc);
        state.stream.zfree = Some(ALLOCATOR.zfree);
        state.stream.opaque = ALLOCATOR.opaque;
        const DEF_MEM_LEVEL: c_int = 8;
        if unsafe {
            deflateInit2_(
                &mut state.stream,
                state.level as _,
                Z_DEFLATED,
                MAX_WBITS + 16,
                DEF_MEM_LEVEL,
                state.strategy as _,
                zlibVersion(),
                core::mem::size_of::<z_stream>() as _,
            )
        } != Z_OK
        {
            unsafe { free_buffers(state) };
            // Safety: The caller confirmed the validity of state.
            unsafe { gz_error(state, Some((Z_MEM_ERROR, "out of memory"))) };
            return Err(());
        }
        state.stream.next_in = ptr::null_mut();
    }

    // Note: zlib-ng sets state.size = state.want here to mark the state as initialized.
    // We don't have state.size, so gz_write looks for a non-null state.input buffer
    // (which we allocated above) to tell if the state has been initialized.

    // Initialize write buffer if compressing.
    if !state.direct {
        state.stream.avail_out = state.out_size as _;
        state.stream.next_out = state.output;
        state.next = state.stream.next_out;
    }

    Ok(())
}

// Compress whatever is at avail_in and next_in (unless in direct mode) and write
// to the output file.
//
// # Returns
//
// - `Ok` on success.
// - `Err` on error.
fn gz_comp(state: &mut GzState, flush: c_int) -> Result<(), ()> {
    // Allocate memory if this is the first time through
    if state.input.is_null() && gz_init(state).is_err() {
        return Err(());
    }

    // Write directly if requested.
    if state.direct {
        let got = unsafe {
            libc::write(
                state.fd,
                state.stream.next_in.cast::<c_void>(),
                state.stream.avail_in as _,
            )
        };
        if got < 0 || got as c_uint != state.stream.avail_in {
            // FIXME implement zstrerror and use it instead of a hard-coded error message here.
            unsafe { gz_error(state, Some((Z_ERRNO, "write error"))) };
            return Err(());
        }
        state.stream.avail_in = 0;
        return Ok(());
    }

    // Check for a pending reset.
    if state.reset {
        // Don't start a new gzip stream unless there is data to write.
        if state.stream.avail_in == 0 {
            return Ok(());
        }
        // Safety: `state.reset` is set only in `gz_comp`, which first initializes
        // `state.stream` using `deflateInit2_`.
        let _ = unsafe { deflateReset(&mut state.stream) };
        state.reset = false;
    }

    // Run deflate on the provided input until it produces no more output.
    let mut ret = Z_OK;
    loop {
        // Write out current buffer contents if full, or if flushing, but if
        // doing Z_FINISH then don't write until we get to Z_STREAM_END.
        if state.stream.avail_out == 0
            || (flush != Z_NO_FLUSH && (flush != Z_FINISH || ret == Z_STREAM_END))
        {
            // Safety: Within this gz module, `state.stream.next` and `state.stream.next_out`
            // always point within the same allocated object, `state.stream.output`.
            let have = unsafe { state.stream.next_out.offset_from(state.next) };
            if have < 0 {
                const MSG: &str = "corrupt internal state in gz_comp";
                unsafe { gz_error(state, Some((Z_STREAM_ERROR, MSG))) };
                return Err(());
            }
            if have != 0 {
                let ret = unsafe { libc::write(state.fd, state.next.cast::<c_void>(), have as _) };
                if ret != have as _ {
                    unsafe { gz_error(state, Some((Z_ERRNO, "write error"))) };
                    return Err(());
                }
            }
            if state.stream.avail_out == 0 {
                state.stream.avail_out = state.out_size as _;
                state.stream.next_out = state.output;
            }
            state.next = state.stream.next_out;
        }

        // Compress.
        let mut have = state.stream.avail_out;
        ret = unsafe { deflate(&mut state.stream, flush) };
        if ret == Z_STREAM_ERROR {
            const MSG: &str = "internal error: deflate stream corrupt";
            unsafe { gz_error(state, Some((Z_STREAM_ERROR, MSG))) };
            return Err(());
        }
        have -= state.stream.avail_out;

        if have == 0 {
            break;
        }
    }

    // If that completed a deflate stream, allow another to start.
    if flush == Z_FINISH {
        state.reset = true;
    }

    Ok(())
}

/// Flush all pending output buffered in `file`. The parameter `flush` is interpreted
/// the same way as in the [`deflate`] function. The return value is the zlib error
/// number (see [`gzerror`]). `gzflush` is permitted only when writing.
///
/// # Returns
///
/// - `Z_OK` on success.
/// - a `Z_` error code on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzflush))]
pub unsafe extern "C" fn gzflush(file: gzFile, flush: c_int) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return Z_STREAM_ERROR;
    };

    // Check that we're writing and that there's no error.
    if state.mode != GzMode::GZ_WRITE || state.err != Z_OK {
        return Z_STREAM_ERROR;
    }

    // Check flush parameter.
    if !(0..=Z_FINISH).contains(&flush) {
        return Z_STREAM_ERROR;
    }

    // Check for seek request.
    if state.seek {
        state.seek = false;
        if gz_zero(state, state.skip as _).is_err() {
            return state.err;
        }
    }

    // Compress remaining data with requested flush.
    let _ = gz_comp(state, flush);
    state.err
}

/// Return the starting position for the next [`gzread`] or [`gzwrite`] on `file`.
/// This position represents a number of bytes in the uncompressed data stream,
/// and is zero when starting, even if appending or reading a gzip stream from
/// the middle of a file using [`gzdopen`].
///
/// # Returns
///
/// * The number of bytes prior to the current read or write position in the
///   uncompressed data stream, on success.
/// * -1 on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gztell64))]
pub unsafe extern "C" fn gztell64(file: gzFile) -> z_off64_t {
    let Some(state) = (unsafe { file.cast::<GzState>().as_ref() }) else {
        return -1;
    };

    // Check integrity.
    if state.mode != GzMode::GZ_READ && state.mode != GzMode::GZ_WRITE {
        // Unreachable if `file` was initialized with `gzopen` or `gzdopen`.
        return -1;
    }

    // Return position.
    match state.seek {
        true => (state.pos + state.skip) as z_off64_t,
        false => state.pos as z_off64_t,
    }
}

/// Return the starting position for the next [`gzread`] or [`gzwrite`] on `file`.
/// This position represents a number of bytes in the uncompressed data stream,
/// and is zero when starting, even if appending or reading a gzip stream from
/// the middle of a file using [`gzdopen`].
///
/// # Returns
///
/// * The number of bytes prior to the current read or write position in the
///   uncompressed data stream, on success.
/// * -1 on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gztell))]
pub unsafe extern "C" fn gztell(file: gzFile) -> z_off_t {
    z_off_t::try_from(unsafe { gztell64(file) }).unwrap_or(-1)
}

/// Return the current compressed (actual) read or write offset of `file`.  This
/// offset includes the count of bytes that precede the gzip stream, for example
/// when appending or when using [`gzdopen`] for reading. When reading, the
/// offset does not include as yet unused buffered input. This information can
//  be used for a progress indicator.
///
/// # Returns
///
/// * The number of bytes prior to the current read or write position in the
///   compressed data stream, on success.
/// * -1 on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzoffset64))]
pub unsafe extern "C" fn gzoffset64(file: gzFile) -> z_off64_t {
    let Some(state) = (unsafe { file.cast::<GzState>().as_ref() }) else {
        return -1;
    };

    // Check integrity.
    if state.mode != GzMode::GZ_READ && state.mode != GzMode::GZ_WRITE {
        // Unreachable if `file` was initialized with `gzopen` or `gzdopen`.
        return -1;
    }

    // Compute and return effective offset in file.
    let offset = lseek64(state.fd, 0, SEEK_CUR) as z_off64_t;
    if offset == -1 {
        return -1;
    }

    // When reading, don't count buffered input.
    match state.mode {
        GzMode::GZ_READ => offset - state.stream.avail_in as z_off64_t,
        GzMode::GZ_NONE | GzMode::GZ_WRITE | GzMode::GZ_APPEND => offset,
    }
}

/// Return the current compressed (actual) read or write offset of `file`.  This
/// offset includes the count of bytes that precede the gzip stream, for example
/// when appending or when using [`gzdopen`] for reading. When reading, the
/// offset does not include as yet unused buffered input. This information can
//  be used for a progress indicator.
///
/// # Returns
///
/// * The number of bytes prior to the current read or write position in the
///   compressed data stream, on success.
/// * -1 on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzoffset))]
pub unsafe extern "C" fn gzoffset(file: gzFile) -> z_off_t {
    z_off_t::try_from(unsafe { gzoffset64(file) }).unwrap_or(-1)
}

/// Compress and write `c`, converted to an unsigned 8-bit char, into `file`.
///
/// # Returns
///
///  - The value that was written, on success.
///  - `-1` on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzputc))]
pub unsafe extern "C" fn gzputc(file: gzFile, c: c_int) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return -1;
    };

    // Check that we're writing and that there's no error.
    if state.mode != GzMode::GZ_WRITE || state.err != Z_OK {
        return -1;
    }

    // Check for seek request.
    if state.seek {
        state.seek = false;
        if gz_zero(state, state.skip as _).is_err() {
            return -1;
        }
    }

    // Try writing to input buffer for speed (state.input == null if buffer not initialized).
    if !state.input.is_null() {
        if state.stream.avail_in == 0 {
            state.stream.next_in = state.input;
        }
        // Safety: `state.stream.next_in` points into the buffer starting at `state.input`.
        // (This is an invariant maintained throughout this module, except for a specific
        // block within `gz_write` that does not call any function that might call `gzputc`.)
        let have = unsafe { state.input_len() };
        if have < state.in_size {
            // Safety: `input` has `in_size` bytes, and `have` < `in_size`.
            unsafe { *state.input.add(have) = c as u8 };
            state.stream.avail_in += 1;
            state.pos += 1;
            return c & 0xff;
        }
    }

    // No room in buffer or not initialized, use gz_write.
    let buf = [c as u8];
    // Safety: We have confirmed that `state` is valid, and `buf` contains 1 readable byte of data.
    match unsafe { gz_write(state, buf.as_ptr().cast::<c_void>(), 1) } {
        1 => c & 0xff,
        _ => -1,
    }
}

/// Compress and write the given null-terminated string `s` to file, excluding
/// the terminating null character.
///
/// # Returns
///
/// - the number of characters written, on success.
/// - `-1` in case of error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
/// - `s` must point to a null-terminated C string.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzputs))]
pub unsafe extern "C" fn gzputs(file: gzFile, s: *const c_char) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return -1;
    };

    if s.is_null() {
        return -1;
    }

    // Check that we're writing and that there's no error.
    if state.mode != GzMode::GZ_WRITE || state.err != Z_OK {
        return -1;
    }

    // Write string.
    let len = unsafe { libc::strlen(s) };
    if c_int::try_from(len).is_err() {
        const MSG: &str = "string length does not fit in int";
        unsafe { gz_error(state, Some((Z_STREAM_ERROR, MSG))) };
        return -1;
    }
    let put = unsafe { gz_write(state, s.cast::<c_void>(), len) };
    match put.cmp(&(len as i32)) {
        Ordering::Less => -1,
        Ordering::Equal | Ordering::Greater => len as _,
    }
}

/// Read one decompressed byte from `file`.
///
/// Note: The C header file `zlib.h` provides a macro wrapper for `gzgetc` that implements
/// the fast path inline and calls this function for the slow path.
///
/// # Returns
///
/// - The byte read, on success.
/// - `-1` on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzgetc))]
pub unsafe extern "C" fn gzgetc(file: gzFile) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return -1;
    };

    // Check that we're reading and that there's no (serious) error.
    if state.mode != GzMode::GZ_READ || (state.err != Z_OK && state.err != Z_BUF_ERROR) {
        return -1;
    }

    // Try output buffer (no need to check for skip request).
    if state.have != 0 {
        state.have -= 1;
        state.pos += 1;
        // Safety: Since `state.have` is at least 1, `state.next` points to at least
        // one readable byte within `state.output`.
        let ret = unsafe { *state.next };
        // Safety: Since `state.have` is at least 1, the byte between `state.next` and
        // `state.next + 1` is within the bounds of the `state.output` buffer, as required
        // by the pointer `add` method.
        state.next = unsafe { state.next.add(1) };
        return c_int::from(ret);
    }

    // Nothing there -- try gz_read.
    let mut c = 0u8;
    // Safety: `c` is big enough to hold `len = 1` bytes.
    match unsafe { gz_read(state, core::slice::from_mut(&mut c).as_mut_ptr(), 1) } {
        1 => c_int::from(c),
        _ => -1,
    }
}

/// Backward-compatibility alias for [`gzgetc`].
///
/// # Returns
///
/// - The byte read, on success.
/// - `-1` on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzgetc_))]
pub unsafe extern "C" fn gzgetc_(file: gzFile) -> c_int {
    // Safety: The caller has ensured that `file` is null or a valid file handle.
    unsafe { gzgetc(file) }
}

/// Push `c` back onto the stream for file to be read as the first character on
/// the next read.  At least one character of push-back is always allowed.
///
/// `gzungetc` will fail if `c` is `-1`, and may fail if a character has been pushed
/// but not read yet. If `gzungetc` is used immediately after [`gzopen`] or [`gzdopen`],
/// at least the output buffer size of pushed characters is allowed.  (See [`gzbuffer`].)
///
/// The pushed character will be discarded if the stream is repositioned with
/// [`gzseek`] or [`gzrewind`].
///
/// # Returns
///
/// - The character pushed, on success.
/// - `-1` on failure.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzungetc))]
pub unsafe extern "C" fn gzungetc(c: c_int, file: gzFile) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return -1;
    };

    // Validate the input.
    if c < 0 {
        return -1;
    }

    // Check that we're reading and that there's no (serious) error.
    if state.mode != GzMode::GZ_READ || (state.err != Z_OK && state.err != Z_BUF_ERROR) {
        return -1;
    }

    // In case this was just opened, set up the input buffer.
    if state.how == How::Look && state.have == 0 {
        // We have verified that `state` is valid.
        let _ = unsafe { gz_look(state) };
    }

    // Process a skip request.
    if state.seek {
        state.seek = false;
        if gz_skip(state, state.skip).is_err() {
            return -1;
        }
    }

    // If output buffer empty, put byte at end (allows more pushing).
    if state.have == 0 {
        state.have = 1;
        // Safety: because `state.have` is nonzero, the `state.output` buffer has been
        // allocated. And because the buffer's size is `state.out_size`, a pointer to
        // `output + out_size - 1` points within the buffer.
        state.next = unsafe { state.output.add(state.out_size - 1) };
        // Safety: from the addition above, `state.next` currently points within the
        // `state.output` buffer.
        unsafe { *(state.next as *mut u8) = c as u8 };
        state.pos -= 1;
        state.past = false;
        return c;
    }

    // If no room, give up (must have already done a `gzungetc`).
    if state.have as usize == state.out_size {
        const MSG: &str = "out of room to push characters";
        // Safety: We have verified that `state` is valid.
        unsafe { gz_error(state, Some((Z_DATA_ERROR, MSG))) };
        return -1;
    }

    // Slide output data if needed and insert byte before existing data.
    if state.next == state.output {
        // There are `state.have` bytes of usable content at the front of the buffer
        // `state.output`, which has capacity `state.out_size`. We want to move that
        // content to the end of the buffer, so we copy from `state.output` to
        // `state.output + (state.out_size - state.have)` and update `state.next`
        // to point to the content's new location within the buffer.
        let offset = state.out_size - state.have as usize;

        // Safety: `state.have` < `state.out_size`, or we would have returned in the
        // check for the == case above. Therefore, `offset`, which is `out_size - have`,
        // is in the range `1..=(out_size - 1)`. When we add that to `output`, the result
        // is within the buffer's allocation of `out_size` bytes.
        let dst = unsafe { state.output.add(offset) };

        // Safety: `state.next` points a sequence of `state.have` initialized bytes
        // within the `state.output` buffer. And because `dst` was computed as
        // `state.output + state.out_size - state.have`, we can write `state.have`
        // bytes starting at `dst` and they will all be within the buffer.
        // Note that this may be an overlapping copy.
        unsafe { ptr::copy(state.next, dst as _, state.have as _) };
        state.next = dst;
    }
    state.have += 1;
    // Safety: `state.next` > `state.output`, due to the `state.next = dst` above, so it
    // is safe to decrease `state.next` by 1.
    state.next = unsafe { state.next.sub(1) };
    // Safety: `state.next` >= `state.output` following the subtraction.
    unsafe { *(state.next as *mut u8) = c as u8 };
    state.pos -= 1;
    state.past = false;
    c
}

/// Read decompressed bytes from `file` into `buf`, until `len-1` characters are
/// read, or until a newline character is read and transferred to `buf`, or an
/// end-of-file condition is encountered.  If any characters are read or if `len`
/// is one, the string is terminated with a null character.  If no characters
/// are read due to an end-of-file or `len` is less than one, then the buffer is
/// left untouched.
///
/// Note: This function generally only makes sense for files where the decompressed
/// content is text. If there are any null bytes, this function will copy them into
/// `buf` just like any other character, resulting in early truncation of the
/// returned C string. To read gzip files whose decompressed content is binary,
/// please see [`gzread`].
///
/// # Returns
///
/// - `buf`, which now is a null-terminated string, on success.
/// - `null` on error. If there was an error, the contents at `buf` are indeterminate.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
/// - `buf` must be null or a pointer to at least `len` writable bytes.
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzgets))]
pub unsafe extern "C" fn gzgets(file: gzFile, buf: *mut c_char, len: c_int) -> *mut c_char {
    // Check parameters.
    if buf.is_null() || len < 1 {
        return ptr::null_mut();
    }

    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return ptr::null_mut();
    };

    // Check that we're reading and that there's no (serious) error.
    if state.mode != GzMode::GZ_READ || (state.err != Z_OK && state.err != Z_BUF_ERROR) {
        return ptr::null_mut();
    }

    // Process a skip request.
    if state.seek {
        state.seek = false;
        if gz_skip(state, state.skip).is_err() {
            return ptr::null_mut();
        }
    }

    // Copy output bytes up to newline or `len - 1`, whichever comes first.
    let mut left = len as usize - 1;
    if left == 0 {
        // The caller provided a 1-byte buffer, so write the terminating null and we're done.
        // Safety: `len` is 1 in this block, so it's safe to write 1 byte at `*buf`.
        unsafe { *buf = 0 };
        return buf;
    }
    let mut dst = buf;
    loop {
        // Assure that something is in the output buffer.
        // Safety: `state` is valid based on the checked cast above.
        if state.have == 0 && unsafe { gz_fetch(state) }.is_err() {
            // Error -- couldn't read any data.
            return ptr::null_mut();
        }
        if state.have == 0 {
            // End of file; return whatever we have.
            state.past = true;
            break;
        }

        // Look for newline in current output buffer.
        let mut n = Ord::min(left, state.have as _);
        // Safety: `state.next` points to a block of `state.have` readable bytes. We're scanning
        // the first `n` of those bytes, and `n <= state.have` based on the `min` calculation.
        let eol = unsafe { libc::memchr(state.next.cast::<c_void>(), '\n' as c_int, n as _) };
        if !eol.is_null() {
            // Compute the number of bytes to copy, + 1 because we need to copy the newline itself.
            // Safety: `eol` was found by `memchr` in the same buffer as `state.next`, so `offset_of`
            // is valid. And because `memchr` only scans forward, `eol` will be at or after
            // `state.next`, so we can cast the result of `offset_from` to an unsigned value.
            n = unsafe { eol.cast::<u8>().offset_from(state.next) } as usize + 1;
        }

        // Copy through end of line, or remainder if newline not found.
        // Safety: `state.next` points to at least `n` readable bytes because `n <= state.have`,
        // `dst` points to at least `n` writable bytes because `n <= left`, and the source
        // and destination regions are nonoverlapping because we're copying from an internal
        // buffer to a caller-supplied buffer.
        unsafe { ptr::copy_nonoverlapping(state.next, dst as _, n) };
        state.have -= n as c_uint;
        // Safety: As described above, `state.next` pointed to at least `n` readable bytes, so
        // when we increase it by `n` it will still point into the `output` buffer.
        state.next = unsafe { state.next.add(n) };
        state.pos += n as i64;
        left -= n;
        // Safety: `dst` pointed to at least `n` writable bytes, so when we increase it by `n`
        // it will still point into `buf`.
        dst = unsafe { dst.add(n) };

        if left == 0 || !eol.is_null() {
            break;
        }
    }

    if dst == buf {
        // Nothing was copied.
        ptr::null_mut()
    } else {
        // Something was copied. Null-terminate and return the string.
        // Safety: we copied at most `left = len - 1` bytes, and `dst` points just past
        // the last copied byte, so `dst` is within the block of `len` writable bytes
        // starting at `buf`.
        unsafe { *dst = 0 };
        buf
    }
}

/// Dynamically update the compression level and strategy for `file`. See the
/// description of [`deflateInit2_`] for the meaning of these parameters. Previously
/// provided data is flushed before applying the parameter changes.
///
/// Note: If `level` is not valid, this function will silently fail with a return
/// value of `Z_OK`, matching the semantics of the C zlib version. However, if
/// `strategy` is not valid, this function will return an error.
///
/// # Returns
///
/// - [`Z_OK`] on success.
/// - [`Z_STREAM_ERROR`] if the file was not opened for writing.
/// - [`Z_ERRNO`] if there is an error writing the flushed data.
/// - [`Z_MEM_ERROR`] if there is a memory allocation error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzsetparams))]
pub unsafe extern "C" fn gzsetparams(file: gzFile, level: c_int, strategy: c_int) -> c_int {
    let Ok(strategy) = Strategy::try_from(strategy) else {
        return Z_STREAM_ERROR;
    };
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return Z_STREAM_ERROR;
    };

    // Check that we're writing and that there's no error.
    if state.mode != GzMode::GZ_WRITE || state.err != Z_OK || state.direct {
        return Z_STREAM_ERROR;
    }

    // If no change is requested, then do nothing.
    if level == c_int::from(state.level) && strategy == state.strategy {
        return Z_OK;
    }

    // Check for seek request.
    if state.seek {
        state.seek = false;
        if gz_zero(state, state.skip as _).is_err() {
            return state.err;
        }
    }

    // Change compression parameters for subsequent input.
    if !state.input.is_null() {
        // Flush previous input with previous parameters before changing.
        if state.stream.avail_in != 0 && gz_comp(state, Z_BLOCK).is_err() {
            return state.err;
        }
        // Safety: Because `state` is in write mode and `state.input` is non-null, `state.stream`
        // was initialized using `deflateInit2` in `gz_init`.
        unsafe { super::deflateParams(&mut state.stream, level, strategy as c_int) };
    }
    state.level = level as _;
    state.strategy = strategy;
    Z_OK
}

/// Set the starting position to `offset` relative to `whence` for the next [`gzread`]
/// or [`gzwrite`] on `file`. The `offset` represents a number of bytes in the
/// uncompressed data stream. The `whence` parameter is defined as in `lseek(2)`,
/// but only `SEEK_CUR` (relative to current position) and `SEEK_SET` (absolute from
/// start of the uncompressed data stream) are supported.
///
/// If `file` is open for reading, this function is emulated but can extremely
/// slow (because it operates on the decompressed data stream).  If `file` is open
/// for writing, only forward seeks are supported; `gzseek` then compresses a sequence
/// of zeroes up to the new starting position. If a negative `offset` is specified in
/// write mode, `gzseek` returns -1.
///
/// # Returns
///
/// - The resulting offset location as measured in bytes from the beginning of the uncompressed
///   stream, on success.
/// - `-1` on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzseek64))]
pub unsafe extern "C" fn gzseek64(file: gzFile, offset: z_off64_t, whence: c_int) -> z_off64_t {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return -1;
    };
    if state.mode != GzMode::GZ_READ && state.mode != GzMode::GZ_WRITE {
        // Unreachable if `file` was initialized with `gzopen` or `gzdopen`.
        return -1;
    }

    // Check that there's no error.
    if state.err != Z_OK && state.err != Z_BUF_ERROR {
        return -1;
    }

    // Can only seek from start or relative to current position.
    if whence != SEEK_SET && whence != SEEK_CUR {
        return -1;
    }

    let mut offset: i64 = offset as _;

    // Normalize offset to a SEEK_CUR specification (i.e., relative to current position).
    if whence == SEEK_SET {
        offset -= state.pos;
    } else if state.seek {
        offset += state.skip;
    }
    state.seek = false;

    // If we are reading non-compressed content, just lseek to the right location.
    if state.mode == GZ_READ && state.how == How::Copy && state.pos + offset >= 0 {
        let ret = lseek64(
            state.fd,
            offset as z_off64_t - state.have as z_off64_t,
            SEEK_CUR,
        );
        if ret == -1 {
            return -1;
        }
        state.have = 0;
        state.eof = false;
        state.past = false;
        state.seek = false;
        // Safety: `state` was validated above.
        unsafe { gz_error(state, None) };
        state.stream.avail_in = 0;
        state.pos += offset;
        return state.pos as _;
    }

    // Calculate the skip amount. If we're seeking backwards in a compressed file, we'll
    // need to rewind to the start and decompress content until we arrive at the right spot.
    if offset < 0 {
        if state.mode != GzMode::GZ_READ {
            // Can't go backwards when writing.
            return -1;
        }
        offset += state.pos;
        if offset < 0 {
            // Before start of file!
            return -1;
        }

        // Rewind, then skip to offset.
        // Safety: `file` points to an initialized `GzState`.
        if unsafe { gzrewind_help(state) } == -1 {
            return -1;
        }
    }

    // If reading, skip what's in output buffer. (This simplifies `gzgetc`.)
    if state.mode == GzMode::GZ_READ {
        // For consistency with zlib-ng, we use `gt_off` to check whether the value
        // of `state.have` is too large to be represented as a signed 64-bit offset.
        // This case can be triggered only if the platform has 64-bit C ints and
        // `state.have` is >= 2^63.
        let n = if gt_off!(state.have) || state.have as i64 > offset {
            offset as usize
        } else {
            state.have as usize
        };
        state.have -= n as c_uint;
        // Safety: `n` <= `state.have`, and `state.next` points to at least `state.have`
        // accessible bytes within the buffer.
        state.next = unsafe { state.next.add(n) };
        state.pos += n as i64;
        offset -= n as i64;
    }

    // Request skip (if not zero). The actual seek will happen on the next read or write operation.
    if offset != 0 {
        state.seek = true;
        state.skip = offset;
    }

    (state.pos + offset) as _
}

/// Set the starting position to `offset` relative to `whence` for the next [`gzread`]
/// or [`gzwrite`] on `file`. The `offset` represents a number of bytes in the
/// uncompressed data stream. The `whence` parameter is defined as in `lseek(2)`,
/// but only `SEEK_CUR` (relative to current position) and `SEEK_SET` (absolute from
/// start of the uncompressed data stream) are supported.
///
/// If `file` is open for reading, this function is emulated but can extremely
/// slow (because it operates on the decompressed data stream).  If `file` is open
/// for writing, only forward seeks are supported; `gzseek` then compresses a sequence
/// of zeroes up to the new starting position. If a negative `offset` is specified in
/// write mode, `gzseek` returns -1.
///
/// # Returns
///
/// - The resulting offset location as measured in bytes from the beginning of the uncompressed
///   stream, on success.
/// - `-1` on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzseek))]
pub unsafe extern "C" fn gzseek(file: gzFile, offset: z_off_t, whence: c_int) -> z_off_t {
    z_off_t::try_from(unsafe { gzseek64(file, offset as z_off64_t, whence) }).unwrap_or(-1)
}

/// Rewind `file` to the start. This function is supported only for reading.
///
/// Note: `gzrewind(file)` is equivalent to [`gzseek`]`(file, 0, SEEK_SET)`
///
/// # Returns
///
/// - `0` on success.
/// - `-1` on error.
///
/// # Safety
///
/// - `file`, if non-null, must be an open file handle obtained from [`gzopen`] or [`gzdopen`].
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzrewind))]
pub unsafe extern "C" fn gzrewind(file: gzFile) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return -1;
    };

    unsafe { gzrewind_help(state) }
}

unsafe fn gzrewind_help(state: &mut GzState) -> c_int {
    // Check that we're reading and that there's no error.
    if state.mode != GzMode::GZ_READ || (state.err != Z_OK && state.err != Z_BUF_ERROR) {
        return -1;
    }

    // Back up and start over.
    if lseek64(state.fd, state.start as _, SEEK_SET) == -1 {
        return -1;
    }
    gz_reset(state);
    0
}

/// Convert, format, compress, and write the variadic arguments `...` to a file under control of the string format, as in `fprintf`.
///
/// # Returns
///
/// Returns the number of uncompressed bytes actually written, or a negative zlib error code in case of error.
/// The number of uncompressed bytes written is limited to 8191, or one less than the buffer size given to [`gzbuffer`].
/// The caller should assure that this limit is not exceeded. If it is exceeded, then [`gzprintf`] will return `0` with nothing written.
///
/// Contrary to other implementations that can use the insecure `vsprintf`, the `zlib-rs` library always uses `vsnprintf`,
/// so attempting to write more bytes than the limit can never run into buffer overflow issues.
///
/// # Safety
///
/// - The `format`  must be a valid C string
/// - The variadic arguments must correspond with the format string in number and type
#[cfg(feature = "gzprintf")]
#[cfg_attr(docsrs, doc(cfg(feature = "gzprintf")))]
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzprintf))]
pub unsafe extern "C" fn gzprintf(file: gzFile, format: *const c_char, va: ...) -> c_int {
    unsafe { gzvprintf(file, format, va) }
}

/// Convert, format, compress, and write the variable argument list to a file under control of the string format, as in `vfprintf`.
///
/// # Returns
///
/// Returns the number of uncompressed bytes actually written, or a negative zlib error code in case of error.
/// The number of uncompressed bytes written is limited to 8191, or one less than the buffer size given to [`gzbuffer`].
/// The caller should assure that this limit is not exceeded. If it is exceeded, then [`gzvprintf`] will return `0` with nothing written.
///
/// Contrary to other implementations that can use the insecure `vsprintf`, the `zlib-rs` library always uses `vsnprintf`,
/// so attempting to write more bytes than the limit can never run into buffer overflow issues.
///
/// # Safety
///
/// - The `format`  must be a valid C string
/// - The variadic arguments must correspond with the format string in number and type
#[cfg(feature = "gzprintf")]
#[cfg_attr(docsrs, doc(cfg(feature = "gzprintf")))]
#[cfg_attr(feature = "export-symbols", export_name = prefix!(gzvprintf))]
pub unsafe extern "C" fn gzvprintf(
    file: gzFile,
    format: *const c_char,
    va: core::ffi::VaList,
) -> c_int {
    let Some(state) = (unsafe { file.cast::<GzState>().as_mut() }) else {
        return Z_STREAM_ERROR;
    };

    // Check that we're writing and that there's no error.
    if state.mode != GzMode::GZ_WRITE || state.err != Z_OK {
        return Z_STREAM_ERROR;
    }

    // Make sure we have some buffer space.
    if state.input.is_null() && gz_init(state).is_err() {
        return state.err;
    }

    // Check for seek request.
    if state.seek {
        state.seek = false;
        if gz_zero(state, state.skip as _).is_err() {
            return state.err;
        }
    }

    // Do the printf() into the input buffer, put length in len -- the input
    // buffer is double-sized just for this function, so there is guaranteed to
    // be state.size bytes available after the current contents
    if state.stream.avail_in == 0 {
        state.stream.next_in = state.input;
    }

    // A pointer to the space that can be used by `vsnprintf`. The size of the input buffer
    // is `2 * state.in_size`, just for this function. That means we have at least
    // `state.in_size` bytes available.
    let next = unsafe { (state.stream.next_in).add(state.stream.avail_in as usize) }.cast_mut();

    // NOTE: zlib-ng writes a NULL byte to the last position of the input buffer. It must do so
    // because in some cases it falls back to the `vsprintf` function, which contrary to
    // `vsnprintf` does not guarantee NULL-termination.
    //
    // We do not support using `vsprintf`, and therefore don't need to write or check that byte.

    // This function is not currently exposed by libc, because `core::ffi::VaList` is unstable.
    extern "C" {
        fn vsnprintf(
            s: *mut c_char,
            n: libc::size_t,
            format: *const c_char,
            va: core::ffi::VaList,
        ) -> c_int;
    }

    // Safety: as described earlier, there are at least state.in_size bytes available starting at
    // `next`. We forward `format` and `va`, so the caller is responsible for guarenteeing that
    // these are valid.
    let len = unsafe { vsnprintf(next.cast::<c_char>(), state.in_size, format, va) };

    // Check that printf() results fit in buffer.
    if len == 0 || len as usize >= state.in_size {
        return 0;
    }

    // Update buffer and position, compress first half if past that.
    state.stream.avail_in += len as u32;
    state.pos += i64::from(len);
    if state.stream.avail_in as usize >= state.in_size {
        let left = state.stream.avail_in - state.in_size as u32;
        state.stream.avail_in = state.in_size as u32;
        if gz_comp(state, Z_NO_FLUSH).is_err() {
            return state.err;
        }
        unsafe { core::ptr::copy(state.input.add(state.in_size), state.input, left as usize) };
        state.stream.next_in = state.input;
        state.stream.avail_in = left;
    }

    len
}

// Create a deep copy of a C string using `ALLOCATOR`
//
// # Safety
//
// The caller must ensure that s is either null or a pointer to a null-terminated C string.
unsafe fn gz_strdup(src: *const c_char) -> *mut c_char {
    if src.is_null() {
        return ptr::null_mut();
    }

    // SAFETY: the caller must ensure this is a valid C string
    let src = unsafe { CStr::from_ptr(src) };

    let len = src.to_bytes_with_nul().len();
    let Some(dst) = ALLOCATOR.allocate_slice_raw::<c_char>(len) else {
        return ptr::null_mut();
    };

    // SAFETY: src and dst don't overlap, because dst was just allocated. src is valid for a read
    // of len bytes, and dst is valid for a write of len bytes.
    unsafe { core::ptr::copy_nonoverlapping(src.as_ptr(), dst.as_ptr(), len) };

    dst.as_ptr()
}

// Create a new C string, allocated using `ALLOCATOR`, that contains the
// concatenation of zero or more C strings.
//
// # Returns
//
// * A pointer to a C string, for which the caller receives ownership,
// * Or a null pointer upon error.
//
// # Safety
//
// * The return value, if non-null, must be freed using `ALLOCATOR`.
unsafe fn gz_strcat(strings: &[&str]) -> *mut c_char {
    let mut len = 1; // 1 for null terminator
    for src in strings {
        len += src.len();
    }
    let Some(buf) = ALLOCATOR.allocate_slice_raw::<c_char>(len) else {
        return ptr::null_mut();
    };
    let start = buf.as_ptr().cast::<c_char>();
    let mut dst = start.cast::<u8>();
    for src in strings {
        let size = src.len();
        unsafe {
            ptr::copy_nonoverlapping(src.as_ptr(), dst, size);
        };
        dst = unsafe { dst.add(size) };
    }
    unsafe { *dst = 0 };
    start
}

fn lseek64(fd: c_int, offset: z_off64_t, origin: c_int) -> z_off64_t {
    #[cfg(any(target_os = "linux", target_os = "android", target_os = "windows"))]
    {
        return unsafe { libc::lseek64(fd, offset as _, origin) as z_off64_t };
    }

    #[allow(unused)]
    {
        (unsafe { libc::lseek(fd, offset as _, origin) }) as z_off64_t
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;
    use std::path::Path;

    // Generate a file path relative to the project's root
    fn crate_path(file: &str) -> String {
        path(Path::new(env!("CARGO_MANIFEST_DIR")), file)
    }

    fn path(prefix: &Path, file: &str) -> String {
        let mut path_buf = prefix.to_path_buf();
        path_buf.push(file);
        path_buf.as_path().to_str().unwrap().to_owned()
    }

    #[test]
    fn test_configure() {
        let mut state = core::mem::MaybeUninit::<GzState>::zeroed();
        let state = unsafe { state.assume_init_mut() };

        state.configure(b"r").unwrap();
        assert_eq!(state.mode, GzMode::GZ_READ);
        state.configure(b"rw").unwrap();
        assert_eq!(state.mode, GzMode::GZ_WRITE);
        state.configure(b"wr").unwrap();
        assert_eq!(state.mode, GzMode::GZ_READ);

        state.configure(b"4").unwrap();
        assert_eq!(state.level, 4);
        state.configure(b"64").unwrap();
        assert_eq!(state.level, 4);

        state.configure(b"f").unwrap();
        assert_eq!(state.strategy, Strategy::Filtered);
        state.configure(b"h").unwrap();
        assert_eq!(state.strategy, Strategy::HuffmanOnly);
        state.configure(b"R").unwrap();
        assert_eq!(state.strategy, Strategy::Rle);
        state.configure(b"F").unwrap();
        assert_eq!(state.strategy, Strategy::Fixed);

        // Unknown characters are ignored.
        state.configure(b"xqz").unwrap();

        // Plus errors (read + write mode is not supported)
        state.configure(b"123+").unwrap_err();

        assert_eq!(state.configure(b""), Ok((false, false)));
        assert_eq!(state.configure(b"x"), Ok((true, false)));
        assert_eq!(state.configure(b"e"), Ok((false, true)));
        assert_eq!(state.configure(b"xe"), Ok((true, true)));
    }

    // Map a byte string literal to a C string
    // FIXME: switch to c"example" format once MSRV >= 1.77
    macro_rules! c {
        ($s:literal) => {{
            $s.as_ptr().cast::<c_char>()
        }};
    }

    #[test]
    fn gzdopen_invalid_fd() {
        assert_eq!(unsafe { gzdopen(-1, c!(b"r\0")) }, core::ptr::null_mut())
    }

    #[test]
    fn gzopen_path_null() {
        assert_eq!(
            unsafe { gzopen(core::ptr::null(), c!(b"r\0")) },
            core::ptr::null_mut()
        )
    }

    #[test]
    fn gzopen_mode_null() {
        assert_eq!(
            unsafe { gzopen(c!(b"/foo/bar\0"), core::ptr::null(),) },
            core::ptr::null_mut()
        )
    }

    #[test]
    fn test_gz_strdup() {
        let src = ptr::null();
        let dup = unsafe { gz_strdup(src) };
        assert!(dup.is_null());

        let src = b"\0";
        let dup = unsafe { gz_strdup(src.as_ptr().cast::<c_char>()) };
        assert!(!dup.is_null());
        assert_eq!(unsafe { CStr::from_ptr(dup) }.to_bytes_with_nul(), src);
        unsafe { ALLOCATOR.deallocate(dup, libc::strlen(dup) + 1) };

        let src = b"example\0";
        let dup = unsafe { gz_strdup(src.as_ptr().cast::<c_char>()) };
        assert!(!dup.is_null());
        assert_eq!(unsafe { CStr::from_ptr(dup) }.to_bytes_with_nul(), src);
        unsafe { ALLOCATOR.deallocate(dup, libc::strlen(dup) + 1) };
    }

    #[test]
    fn test_gz_strcat() {
        let src = [];
        let dup = unsafe { gz_strcat(&src) };
        assert!(!dup.is_null());
        assert_eq!(unsafe { libc::strlen(dup) }, 0);
        unsafe { ALLOCATOR.deallocate(dup, libc::strlen(dup) + 1) };

        let src = ["example"];
        let dup = unsafe { gz_strcat(&src) };
        assert!(!dup.is_null());
        assert_eq!(
            unsafe { CStr::from_ptr(dup) }.to_bytes_with_nul(),
            b"example\0"
        );
        unsafe { ALLOCATOR.deallocate(dup, libc::strlen(dup) + 1) };

        let src = ["hello", "", ",", "world"];
        let dup = unsafe { gz_strcat(&src) };
        assert!(!dup.is_null());
        assert_eq!(
            unsafe { CStr::from_ptr(dup) }.to_bytes_with_nul(),
            b"hello,world\0"
        );
        unsafe { ALLOCATOR.deallocate(dup, libc::strlen(dup) + 1) };
    }

    #[test]
    fn test_fd_path() {
        let mut buf = [0u8; 27];
        assert_eq!(fd_path(&mut buf, 0).to_bytes(), b"<fd:0>");
        assert_eq!(fd_path(&mut buf, 9).to_bytes(), b"<fd:9>");
        assert_eq!(fd_path(&mut buf, -1).to_bytes(), b"<fd:-1>");
        assert_eq!(
            fd_path(&mut buf, i32::MIN).to_bytes(),
            format!("<fd:{}>", i32::MIN).as_bytes(),
        );
    }

    #[test]
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        ignore = "lseek is not implemented"
    )]
    fn test_gz_error() {
        // gzerror(null) should return null.
        assert!(unsafe { gzerror(ptr::null_mut(), ptr::null_mut()) }.is_null());

        // Open a gzip stream with an invalid file handle. Initially, no error
        // status should be set.
        let handle = unsafe { gzdopen(-2, c!(b"r\0")) };
        assert!(!handle.is_null());

        let state = (unsafe { handle.cast::<GzState>().as_mut() }).unwrap();
        assert_eq!(state.err, Z_OK);
        assert!(state.msg.is_null());
        let mut err = Z_ERRNO;
        let msg = unsafe { gzerror(handle, &mut err as *mut c_int) };
        assert_eq!(unsafe { CStr::from_ptr(msg) }.to_bytes_with_nul(), b"\0");
        assert_eq!(err, Z_OK);

        // When an error is set, the path should be prepended to the error message automatically.
        let state = (unsafe { handle.cast::<GzState>().as_mut() }).unwrap();
        unsafe { gz_error(state, Some((Z_ERRNO, "example error"))) };
        assert_eq!(state.err, Z_ERRNO);
        assert_eq!(
            unsafe { CStr::from_ptr(state.msg) }.to_bytes_with_nul(),
            b"<fd:-2>: example error\0"
        );
        let mut err = Z_OK;
        let msg = unsafe { gzerror(handle, &mut err as *mut c_int) };
        assert_eq!(
            unsafe { CStr::from_ptr(msg) }.to_bytes_with_nul(),
            b"<fd:-2>: example error\0"
        );
        assert_eq!(err, Z_ERRNO);

        // Setting the error message to null should clear the old error message.
        let state = (unsafe { handle.cast::<GzState>().as_mut() }).unwrap();
        unsafe { gz_error(state, None) };
        assert_eq!(state.err, Z_OK);
        assert!(state.msg.is_null());
        let mut err = Z_ERRNO;
        let msg = unsafe { gzerror(handle, &mut err as *mut c_int) };
        assert_eq!(unsafe { CStr::from_ptr(msg) }.to_bytes_with_nul(), b"\0");
        assert_eq!(err, Z_OK);

        // Setting the error code to Z_MEM_ERROR should clear the internal error message
        // (because gz_error doesn't try to allocate space for a copy of the message if
        // the reason for the error is that allocations are failing).
        let state = (unsafe { handle.cast::<GzState>().as_mut() }).unwrap();
        unsafe { gz_error(state, Some((Z_MEM_ERROR, "should be ignored"))) };
        assert_eq!(state.err, Z_MEM_ERROR);
        assert!(state.msg.is_null());
        let mut err = Z_OK;
        let msg = unsafe { gzerror(handle, &mut err as *mut c_int) };
        assert_eq!(
            unsafe { CStr::from_ptr(msg) }.to_bytes_with_nul(),
            b"out of memory\0"
        );
        assert_eq!(err, Z_MEM_ERROR);

        // gzclose should return an error because the fd is invalid.
        assert_eq!(unsafe { gzclose(handle) }, Z_ERRNO);
    }

    #[test]
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        ignore = "lseek is not implemented"
    )]
    fn test_gzclearerr() {
        // gzclearerr on a null file handle should return quietly.
        unsafe { gzclearerr(ptr::null_mut()) };

        // Open a gzip stream with an invalid file handle. Initially, no error
        // status should be set.
        let handle = unsafe { gzdopen(-2, c!(b"r\0")) };
        assert!(!handle.is_null());

        // gzclearerr should reset the eof and past flags.
        unsafe { handle.cast::<GzState>().as_mut().unwrap().eof = true };
        unsafe { handle.cast::<GzState>().as_mut().unwrap().past = true };
        unsafe { gzclearerr(handle) };
        assert!(!unsafe { handle.cast::<GzState>().as_ref().unwrap().eof });
        assert!(!unsafe { handle.cast::<GzState>().as_ref().unwrap().past });

        // Set an error flag and message.
        unsafe {
            gz_error(
                handle.cast::<GzState>().as_mut().unwrap(),
                Some((Z_STREAM_ERROR, "example error")),
            )
        };
        let mut err = Z_OK;
        let msg = unsafe { gzerror(handle, &mut err as *mut c_int) };
        assert_eq!(err, Z_STREAM_ERROR);
        assert_eq!(
            unsafe { CStr::from_ptr(msg) }.to_bytes_with_nul(),
            b"<fd:-2>: example error\0"
        );

        // gzclearerr should clear the error flag and message.
        unsafe { gzclearerr(handle) };
        let msg = unsafe { gzerror(handle, &mut err as *mut c_int) };
        assert_eq!(err, Z_OK);
        assert_eq!(unsafe { CStr::from_ptr(msg) }.to_bytes_with_nul(), b"\0");

        // gzclose should return an error because the fd is invalid.
        assert_eq!(unsafe { gzclose(handle) }, Z_ERRNO);

        // Test the write and append modes, where gzclearerr should not clear eof or past.
        for mode in [c!(b"w\0"), c!(b"a\0")] {
            // Open a gzip stream for write with an invalid file handle. gzeof should return 0.
            let handle = unsafe { gzdopen(-2, mode) };
            assert!(!handle.is_null());
            assert_eq!(unsafe { gzeof(handle) }, 0);

            // gzclearerr should not reset the eof and past flags in write or append mode.
            unsafe { handle.cast::<GzState>().as_mut().unwrap().eof = true };
            unsafe { handle.cast::<GzState>().as_mut().unwrap().past = true };
            unsafe { gzclearerr(handle) };
            assert!(unsafe { handle.cast::<GzState>().as_ref().unwrap().eof });
            assert!(unsafe { handle.cast::<GzState>().as_ref().unwrap().past });

            // Set an error flag and message.
            unsafe {
                gz_error(
                    handle.cast::<GzState>().as_mut().unwrap(),
                    Some((Z_STREAM_ERROR, "example error")),
                )
            };

            // gzclearerr should clear the error flag and message.
            unsafe { gzclearerr(handle) };
            let msg = unsafe { gzerror(handle, &mut err as *mut c_int) };
            assert_eq!(err, Z_OK);
            assert_eq!(unsafe { CStr::from_ptr(msg) }.to_bytes_with_nul(), b"\0");

            // gzclose should return an error because the fd is invalid.
            assert_eq!(unsafe { gzclose(handle) }, Z_ERRNO);
        }
    }

    #[test]
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        ignore = "lseek is not implemented"
    )]
    fn test_gzeof() {
        // gzeof on a null file handle should return false.
        assert_eq!(unsafe { gzeof(ptr::null_mut()) }, 0);

        // Open a gzip stream for read with an invalid file handle. gzeof should return 0.
        let handle = unsafe { gzdopen(-2, c!(b"r\0")) };
        assert!(!handle.is_null());
        assert_eq!(unsafe { gzeof(handle) }, 0);

        // gzeof should return 1 only if there was a read attempt past the end of the stream.
        unsafe { handle.cast::<GzState>().as_mut().unwrap().eof = true };
        assert_eq!(unsafe { gzeof(handle) }, 0);
        unsafe { handle.cast::<GzState>().as_mut().unwrap().past = true };
        assert_eq!(unsafe { gzeof(handle) }, 1);

        // gzclose should return an error because the fd is invalid.
        assert_eq!(unsafe { gzclose(handle) }, Z_ERRNO);

        // Test the write and append modes, where gzeof should always return 0.
        for mode in [c!(b"w\0"), c!(b"a\0")] {
            // Open a gzip stream for write with an invalid file handle. gzeof should return 0.
            let handle = unsafe { gzdopen(-2, mode) };
            assert!(!handle.is_null());
            assert_eq!(unsafe { gzeof(handle) }, 0);

            // Even with the past flag set, gzeof should still return 0 in write or append mode.
            unsafe { handle.cast::<GzState>().as_mut().unwrap().past = true };
            assert_eq!(unsafe { gzeof(handle) }, 0);

            // gzclose should return an error because the fd is invalid.
            assert_eq!(unsafe { gzclose(handle) }, Z_ERRNO);
        }
    }

    #[test]
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        ignore = "lseek is not implemented"
    )]
    // Open a gzip file for reading. gzdirect should return 0.
    fn test_gzdirect_gzip_file() {
        let file = unsafe {
            gzopen(
                CString::new(crate_path("src/test-data/example.gz"))
                    .unwrap()
                    .as_ptr(),
                CString::new("r").unwrap().as_ptr(),
            )
        };
        assert!(!file.is_null());
        // Set a smaller read batch size to exercise the buffer management code paths.
        const FILE_SIZE: usize = 48; // size of test-data/example.gz
        const BLOCK_SIZE: usize = 40;
        unsafe { file.cast::<GzState>().as_mut().unwrap().want = BLOCK_SIZE };
        assert_eq!(unsafe { gzdirect(file) }, 0);
        // gzdirect should have pulled the first `BLOCK_SIZE` bytes of the file into `file`'s internal input buffer.
        assert_eq!(unsafe { file.cast::<GzState>().as_ref().unwrap().have }, 0);
        assert_eq!(
            unsafe { file.cast::<GzState>().as_ref().unwrap().stream.avail_in },
            BLOCK_SIZE as uInt
        );
        // Consume some of the buffered input and call gz_avail. It should move the remaining
        // input to the front of the input buffer.
        unsafe {
            let state = file.cast::<GzState>().as_mut().unwrap();
            const CONSUME: usize = 10;
            state.stream.next_in = state.stream.next_in.add(CONSUME);
            state.stream.avail_in -= CONSUME as uInt;
            let expected_avail = BLOCK_SIZE - CONSUME + (FILE_SIZE - BLOCK_SIZE);
            assert_eq!(gz_avail(state), Ok(expected_avail));
            assert_eq!(state.stream.avail_in as usize, expected_avail);
        };
        assert_eq!(unsafe { gzclose(file) }, Z_OK);
    }

    // Open a non-gzip file for reading. gzdirect should return 1.
    #[test]
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        ignore = "lseek is not implemented"
    )]
    fn test_gzdirect_non_gzip_file() {
        let file = unsafe {
            gzopen(
                CString::new(crate_path("src/test-data/example.txt"))
                    .unwrap()
                    .as_ptr(),
                CString::new("r").unwrap().as_ptr(),
            )
        };
        assert!(!file.is_null());
        assert_eq!(unsafe { gzdirect(file) }, 1);
        // gzdirect should have pulled the entire contents of the file (which is smaller than
        // GZBUFSIZE) into `file`'s internal output buffer.
        assert_eq!(unsafe { file.cast::<GzState>().as_ref().unwrap().have }, 20);
        assert_eq!(
            unsafe { file.cast::<GzState>().as_ref().unwrap().stream.avail_in },
            0
        );
        assert_eq!(unsafe { gzclose(file) }, Z_OK);

        // Open a file containing only the gzip magic number. gzdirect should return 0.
        let file = unsafe {
            gzopen(
                CString::new(crate_path("src/test-data/magic-only.gz"))
                    .unwrap()
                    .as_ptr(),
                CString::new("r").unwrap().as_ptr(),
            )
        };
        assert!(!file.is_null());
        assert_eq!(unsafe { gzdirect(file) }, 0);
        assert_eq!(unsafe { file.cast::<GzState>().as_ref().unwrap().have }, 0);
        assert_eq!(
            unsafe { file.cast::<GzState>().as_ref().unwrap().stream.avail_in },
            2
        );

        assert_eq!(unsafe { gzclose(file) }, Z_OK);

        // Open a file containing only the first byte of the gzip magic number. gzdirect should return 1.
        let file = unsafe {
            gzopen(
                CString::new(crate_path("src/test-data/incomplete-magic.gz"))
                    .unwrap()
                    .as_ptr(),
                CString::new("r").unwrap().as_ptr(),
            )
        };
        assert!(!file.is_null());
        assert_eq!(unsafe { gzdirect(file) }, 1);
        assert_eq!(unsafe { file.cast::<GzState>().as_ref().unwrap().have }, 1);
        assert_eq!(
            unsafe { file.cast::<GzState>().as_ref().unwrap().stream.avail_in },
            0
        );
        assert_eq!(unsafe { gzclose(file) }, Z_OK);
    }

    #[test]
    #[cfg_attr(
        not(any(target_os = "linux", target_os = "macos")),
        ignore = "lseek is not implemented"
    )]
    fn test_gzbuffer() {
        // gzbuffer on a null file handle should return -1.
        assert_eq!(unsafe { gzbuffer(ptr::null_mut(), 1024) }, -1);

        // Open a valid file handle to test the remaining gzbuffer edge cases.
        let file = unsafe {
            gzopen(
                CString::new(crate_path("src/test-data/example.txt"))
                    .unwrap()
                    .as_ptr(),
                CString::new("r").unwrap().as_ptr(),
            )
        };
        // Temporarily put the file handle in a stat that isn't read or write. gzbuffer should fail.
        unsafe { file.cast::<GzState>().as_mut().unwrap().mode = GzMode::GZ_NONE };
        assert_eq!(unsafe { gzbuffer(file, 1024) }, -1);
        // Put the file handle back in read mode, and now gzbuffer should work.
        unsafe { file.cast::<GzState>().as_mut().unwrap().mode = GzMode::GZ_READ };
        assert_eq!(unsafe { gzbuffer(file, 1024) }, 0);
        assert_eq!(
            unsafe { file.cast::<GzState>().as_ref().unwrap().want },
            1024
        );
        // Request a very small buffer size. gzbuffer should instead use the min size, 8 bytes.
        assert_eq!(unsafe { gzbuffer(file, 5) }, 0);
        assert_eq!(unsafe { file.cast::<GzState>().as_ref().unwrap().want }, 8);
        // Call gzdirect to force the allocation of buffers. After that, gzbuffer should fail.
        assert_eq!(unsafe { gzdirect(file) }, 1);
        assert_eq!(unsafe { gzbuffer(file, 1024) }, -1);
        assert_eq!(unsafe { file.cast::<GzState>().as_ref().unwrap().want }, 8);
        assert_eq!(unsafe { gzclose(file) }, Z_OK);
    }
}
