//! Joins brotli streams that were compressed to be concatenated (`-appendable` for the first
//! stream, `-catable` for the rest) into one stream.
//!
//! A brotli stream is a sequence of bits, least significant bit first: a window size, then
//! meta-blocks. It ends with an empty meta-block, which is just the two bits ISLAST and
//! ISLASTEMPTY, followed by zero padding to the end of the byte. A catable stream starts with a
//! meta-block whose header leaves the stream byte aligned (an uncompressed or metadata
//! meta-block, or the stream's final empty one), and it never refers back to data before itself.
//!
//! So appending stream B to output A only takes changing a few bits where they meet:
//!
//! ```text
//!   A:            ... | ISLAST ISLASTEMPTY | padding
//!   B:                                       window size | header | padding | aligned bytes ...
//!   A then B:     ... | header | padding | aligned bytes ...
//! ```
//!
//! A's ISLAST/ISLASTEMPTY pair always lies in its last two bytes, so `BroCatli` holds the last two
//! bytes of the output back (the *tail*) until it knows whether another stream follows, and copies
//! everything else straight through.

use core::cmp::min;

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum BroCatliResult {
    Success = 0,
    NeedsMoreInput = 1,
    NeedsMoreOutput = 2,
    BrotliFileNotCraftedForAppend = 124,
    InvalidWindowSize = 125,
    WindowSizeLargerThanPreviousFile = 126,
    BrotliFileNotCraftedForConcatenation = 127,
}

/// How many bytes of a new stream are buffered to find where it becomes byte aligned.
const NUM_STREAM_HEADER_BYTES: usize = 5;

/// The most bytes of a new stream that are read before giving up on finding where it becomes
/// byte aligned: 4, or 5 for a large window size. That fits an uncompressed first meta-block of up
/// to 1 MiB (five length nibbles), or metadata with up to two length bytes.
fn max_header_bytes(header: &[u8]) -> usize {
    match header.first() {
        Some(byte) if byte & 0x7f == 0x11 => 5, // large window size marker
        _ => 4,
    }
}

/// The value of bits `start..end` of `bytes`, least significant bit first.
fn bit_range(bytes: &[u8], start: usize, end: usize) -> u64 {
    let all = bytes
        .iter()
        .rev()
        .fold(0u64, |value, byte| (value << 8) | u64::from(*byte));
    (all >> start) & ((1u64 << (end - start)) - 1)
}

enum ParseError {
    /// More bytes of the stream are needed.
    Incomplete,
    Invalid(BroCatliResult),
}

/// Reads bits from the buffered start of a stream.
struct BitReader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> BitReader<'a> {
    fn read(&mut self, num_bits: usize) -> Result<u64, ParseError> {
        let end = self.position + num_bits;
        if end > self.bytes.len() * 8 {
            return Err(ParseError::Incomplete);
        }
        let value = bit_range(self.bytes, self.position, end);
        self.position = end;
        Ok(value)
    }

    /// Reads the window size (log2 of the window in bytes) that starts every stream.
    fn read_window_size(&mut self) -> Result<u8, ParseError> {
        let invalid = ParseError::Invalid(BroCatliResult::InvalidWindowSize);
        if self.read(1)? == 0 {
            return Ok(16);
        }
        let size = self.read(3)? as u8;
        if size != 0 {
            return Ok(17 + size);
        }
        match self.read(3)? as u8 {
            0 => Ok(17),
            1 => {
                // large window size: a zero bit, then six bits of size
                if self.read(1)? != 0 {
                    return Err(invalid);
                }
                let size = self.read(6)? as u8;
                if (10..=30).contains(&size) {
                    Ok(size)
                } else {
                    Err(invalid)
                }
            }
            size => Ok(8 + size),
        }
    }

    /// Reads the header of a catable stream's first meta-block, after which the stream is byte
    /// aligned.
    fn read_first_metablock_header(&mut self) -> Result<(), ParseError> {
        let not_catable = ParseError::Invalid(BroCatliResult::BrotliFileNotCraftedForConcatenation);
        let is_last = self.read(1)? == 1;
        if is_last && self.read(1)? == 1 {
            return Ok(()); // ISLASTEMPTY: the stream is empty
        }
        let mlen_nibbles = self.read(2)?;
        if mlen_nibbles == 3 {
            // metadata: a reserved zero bit, then the byte count of its length, then its length
            if self.read(1)? != 0 {
                return Err(not_catable);
            }
            let length_bytes = self.read(2)? as usize;
            self.read(8 * length_bytes)?;
            return Ok(());
        }
        self.read(4 * (4 + mlen_nibbles as usize))?;
        // only a meta-block that is not the last has an ISUNCOMPRESSED bit; a compressed one is
        // not byte aligned
        if is_last || self.read(1)? == 0 {
            return Err(not_catable);
        }
        Ok(())
    }
}

/// Assembles bits into bytes, least significant bit first.
#[derive(Default)]
struct BitWriter {
    bits: u64,
    num_bits: usize,
}

impl BitWriter {
    fn write(&mut self, value: u64, num_bits: usize) {
        assert!(self.num_bits + num_bits <= 64);
        self.bits |= value << self.num_bits;
        self.num_bits += num_bits;
    }

    fn write_bytes(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.write(u64::from(*byte), 8);
        }
    }

    /// Writes zero bits up to the next byte boundary.
    fn pad_to_byte(&mut self) {
        self.num_bits = (self.num_bits + 7) / 8 * 8;
    }

    /// Pads the bits to a whole byte, returning the bytes and their count.
    fn finish(mut self) -> ([u8; 8], usize) {
        self.pad_to_byte();
        (self.bits.to_le_bytes(), self.num_bits / 8)
    }
}

/// Splits the final bytes of a stream into the bits before its closing ISLAST + ISLASTEMPTY pair,
/// returning them with their count, or `None` if the bytes don't end that way.
fn remove_final_empty_metablock(final_bytes: &[u8]) -> Option<(u64, usize)> {
    let bits = bit_range(final_bytes, 0, final_bytes.len() * 8);
    if bits == 0 {
        return None;
    }
    let islastempty = 63 - bits.leading_zeros() as usize; // the highest set bit
    if islastempty == 0 || (bits >> (islastempty - 1)) != 0b11 {
        return None;
    }
    let num_bits = islastempty - 1;
    Some((bit_range(final_bytes, 0, num_bits), num_bits))
}

/// A few buffered bytes.
#[derive(Clone, Copy, Default)]
#[cfg_attr(test, derive(Debug, PartialEq))]
struct ByteBuf {
    bytes: [u8; NUM_STREAM_HEADER_BYTES],
    len: u8,
}

impl ByteBuf {
    fn from_slice(bytes: &[u8]) -> ByteBuf {
        let mut buf = ByteBuf::default();
        buf.bytes[..bytes.len()].copy_from_slice(bytes);
        buf.len = bytes.len() as u8;
        buf
    }

    fn as_slice(&self) -> &[u8] {
        &self.bytes[..usize::from(self.len)]
    }
}

#[derive(Clone, Copy)]
#[cfg_attr(test, derive(Debug, PartialEq))]
enum Phase {
    /// Copying the current stream through to the output.
    PassThrough,
    /// Buffering the start of a new stream until it can be spliced onto the output.
    ReadHeader(ByteBuf),
    /// The new stream has been spliced on; these bytes of the splice are waiting for output space.
    WriteSplice { bytes: ByteBuf, written: u8 },
    /// The new stream ended before its first meta-block header did.
    Truncated,
}

impl Default for Phase {
    fn default() -> Phase {
        Phase::PassThrough
    }
}

// eat your vegetables
#[derive(Default)]
#[cfg_attr(test, derive(Debug, PartialEq))]
pub struct BroCatli {
    /// The last bytes of the output (at most two), held back because they hold the ISLAST and
    /// ISLASTEMPTY bits that end the stream, which have to go if another stream is appended.
    tail: [u8; 2],
    tail_len: u8,
    /// The first stream's window size, or 0 before it is known; later streams may not exceed it.
    window_size: u8,
    /// Whether any bytes were written; if none are, `finish` writes an empty stream.
    any_bytes_emitted: bool,
    phase: Phase,
}

// Serialized layout, which the FFI also uses to hold its state:
//   [0..2]    tail                      [8]   tail_len
//   [9]       flags (below)             [10]  open tail bit offset (old versions only)
//   [11]      window_size               [12]  number of buffered bytes
//   [13]      buffered bytes written    [16..16 + NUM_STREAM_HEADER_BYTES]  buffered bytes
const FLAG_OPEN_TAIL: u8 = 1 << 0; // old versions only: the tail's final empty meta-block is removed
const FLAG_TRUNCATED: u8 = 1 << 1;
const FLAG_ANY_BYTES_EMITTED: u8 = 1 << 5;
const FLAG_NEW_STREAM: u8 = 1 << 6; // the phase is not PassThrough
const FLAG_WRITE_SPLICE: u8 = 1 << 7;

impl BroCatli {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn deserialize_from_buffer(buffer: &[u8]) -> Result<BroCatli, ()> {
        if 16 + NUM_STREAM_HEADER_BYTES > buffer.len() {
            return Err(());
        }
        let tail_len = buffer[8];
        let flags = buffer[9];
        let open_tail_bit_offset = buffer[10];
        let window_size = buffer[11];
        if tail_len > 2 || open_tail_bit_offset >= 8 {
            return Err(());
        }
        if window_size != 0 && BroCatli::try_new_with_window_size(window_size).is_err() {
            return Err(());
        }
        let mut buffered = ByteBuf::default();
        buffered
            .bytes
            .copy_from_slice(&buffer[16..16 + NUM_STREAM_HEADER_BYTES]);
        buffered.len = buffer[12];
        let written = buffer[13];
        let phase = if flags & FLAG_NEW_STREAM == 0 {
            Phase::PassThrough
        } else if usize::from(buffered.len) > NUM_STREAM_HEADER_BYTES {
            return Err(());
        } else if flags & FLAG_WRITE_SPLICE != 0 {
            if written > buffered.len {
                return Err(());
            }
            Phase::WriteSplice {
                bytes: buffered,
                written,
            }
        } else if flags & FLAG_TRUNCATED != 0 {
            Phase::Truncated
        } else {
            Phase::ReadHeader(buffered)
        };
        let mut ret = BroCatli {
            tail: [buffer[0], buffer[1]],
            tail_len,
            window_size,
            any_bytes_emitted: flags & FLAG_ANY_BYTES_EMITTED != 0,
            phase,
        };
        if flags & FLAG_OPEN_TAIL != 0 && tail_len != 0 {
            // Old versions removed the tail's final empty meta-block as soon as a new stream
            // started. Put it back; it is removed again when the new stream is spliced on.
            let num_bits = usize::from(tail_len - 1) * 8 + usize::from(open_tail_bit_offset);
            let mut tail = BitWriter::default();
            tail.write(bit_range(&ret.tail, 0, num_bits), num_bits);
            tail.write(0b11, 2);
            let (bytes, len) = tail.finish();
            if len > 2 {
                return Err(());
            }
            ret.set_tail(&bytes[..len]);
        }
        Ok(ret)
    }

    #[inline(always)]
    pub fn serialize_to_buffer(&self, buffer: &mut [u8]) -> Result<(), ()> {
        if 16 + NUM_STREAM_HEADER_BYTES > buffer.len() {
            return Err(());
        }
        let mut flags = 0;
        if self.any_bytes_emitted {
            flags |= FLAG_ANY_BYTES_EMITTED;
        }
        let (buffered, written) = match self.phase {
            Phase::PassThrough => (None, 0),
            Phase::ReadHeader(header) => (Some(header), 0),
            Phase::WriteSplice { bytes, written } => {
                flags |= FLAG_WRITE_SPLICE;
                (Some(bytes), written)
            }
            Phase::Truncated => {
                flags |= FLAG_TRUNCATED;
                (Some(ByteBuf::default()), 0)
            }
        };
        buffer[..2].copy_from_slice(&self.tail);
        buffer[8] = self.tail_len;
        buffer[10] = 0;
        buffer[11] = self.window_size;
        if let Some(buffered) = buffered {
            flags |= FLAG_NEW_STREAM;
            buffer[12] = buffered.len;
            buffer[13] = written;
            // 14, 15 reserved
            buffer[16..16 + NUM_STREAM_HEADER_BYTES].copy_from_slice(&buffered.bytes);
        }
        buffer[9] = flags;
        Ok(())
    }

    /// Creates a `BroCatli` with an initial window size.
    ///
    /// Panics for invalid window sizes. Use `try_new_with_window_size` to detect
    /// invalid input without panicking.
    pub fn new_with_window_size(log_window_size: u8) -> BroCatli {
        Self::try_new_with_window_size(log_window_size).expect("invalid brotli window size")
    }

    /// Creates a `BroCatli` with an initial window size, or returns an error for invalid sizes.
    pub fn try_new_with_window_size(log_window_size: u8) -> Result<BroCatli, BroCatliResult> {
        // Start as if an empty stream with this window size had already been written: the first
        // stream is then spliced onto it, checking its window size like any later stream's.
        let mut empty_stream = BitWriter::default();
        let window_size = u64::from(log_window_size);
        match log_window_size {
            16 => empty_stream.write(0, 1),
            17 => empty_stream.write(0b0000001, 7),
            18..=24 => empty_stream.write(1 | ((window_size - 17) << 1), 4),
            10..=15 => empty_stream.write(1 | ((window_size - 8) << 4), 7),
            25..=30 => {
                empty_stream.write(0x11, 8);
                empty_stream.write(window_size, 6);
            }
            _ => return Err(BroCatliResult::InvalidWindowSize),
        }
        empty_stream.write(0b11, 2); // ISLAST, ISLASTEMPTY
        let (bytes, len) = empty_stream.finish();
        let mut ret = BroCatli {
            window_size: log_window_size,
            ..BroCatli::default()
        };
        ret.set_tail(&bytes[..len]);
        Ok(ret)
    }

    pub fn new_brotli_file(&mut self) {
        self.phase = match self.phase {
            // a stream is spliced as soon as its header is complete, so this one was cut short
            Phase::ReadHeader(header) if header.len != 0 => Phase::Truncated,
            Phase::Truncated => Phase::Truncated,
            _ => Phase::ReadHeader(ByteBuf::default()),
        };
    }

    pub fn stream(
        &mut self,
        in_bytes: &[u8],
        in_offset: &mut usize,
        out_bytes: &mut [u8],
        out_offset: &mut usize,
    ) -> BroCatliResult {
        loop {
            match self.phase {
                Phase::PassThrough => {
                    return self.pass_through(in_bytes, in_offset, out_bytes, out_offset)
                }
                Phase::Truncated => return BroCatliResult::BrotliFileNotCraftedForConcatenation,
                Phase::ReadHeader(mut header) => {
                    while usize::from(header.len) < max_header_bytes(header.as_slice())
                        && *in_offset < in_bytes.len()
                    {
                        header.bytes[usize::from(header.len)] = in_bytes[*in_offset];
                        header.len += 1;
                        *in_offset += 1;
                    }
                    self.phase = Phase::ReadHeader(header);
                    match self.splice(header.as_slice()) {
                        Ok(Some(bytes)) => self.phase = Phase::WriteSplice { bytes, written: 0 },
                        Ok(None) => return BroCatliResult::NeedsMoreInput,
                        Err(err) => return err,
                    }
                }
                Phase::WriteSplice { bytes, written } => {
                    let unwritten = &bytes.as_slice()[usize::from(written)..];
                    let written = written + self.write_out(unwritten, out_bytes, out_offset) as u8;
                    if written != bytes.len {
                        self.phase = Phase::WriteSplice { bytes, written };
                        return BroCatliResult::NeedsMoreOutput;
                    }
                    self.phase = Phase::PassThrough;
                }
            }
        }
    }

    pub fn finish(&mut self, out_bytes: &mut [u8], out_offset: &mut usize) -> BroCatliResult {
        // Write out whatever of the last stream is still pending.
        if let Phase::ReadHeader(header) = self.phase {
            if header.len != 0 {
                self.phase = Phase::Truncated;
            }
        }
        match self.stream(&[], &mut 0, out_bytes, out_offset) {
            BroCatliResult::NeedsMoreInput => {}
            result => return result,
        }
        // The tail holds the final empty meta-block, which now does end the stream.
        while self.tail_len != 0 {
            let byte = self.tail[0];
            if self.write_out(&[byte], out_bytes, out_offset) == 0 {
                return BroCatliResult::NeedsMoreOutput;
            }
            self.tail = [self.tail[1], 0];
            self.tail_len -= 1;
        }
        if !self.any_bytes_emitted {
            // No streams at all: write an empty one.
            if self.write_out(b";", out_bytes, out_offset) == 0 {
                return BroCatliResult::NeedsMoreOutput;
            }
        }
        BroCatliResult::Success
    }

    /// Reads as much of a new stream as splicing it on takes: its window size and, unless it is the
    /// first stream, its first meta-block header. Returns the window size and where that header
    /// starts and ends, in bits.
    fn read_stream_start(&self, header: &[u8]) -> Result<(u8, usize, usize), ParseError> {
        let mut reader = BitReader {
            bytes: header,
            position: 0,
        };
        let window_size = reader.read_window_size()?;
        let metablock_header_start = reader.position;
        if self.window_size != 0 {
            if window_size > self.window_size {
                return Err(ParseError::Invalid(
                    BroCatliResult::WindowSizeLargerThanPreviousFile,
                ));
            }
            reader.read_first_metablock_header()?;
        }
        Ok((window_size, metablock_header_start, reader.position))
    }

    /// Splices the stream that starts with `header` onto the output: the output loses its final
    /// empty meta-block, the stream loses its window size, and the two are joined bit by bit. The
    /// last two bytes of the result become the new tail; the rest is returned, ready to write.
    /// Returns `Ok(None)` if more of the stream is needed to find where it becomes byte aligned.
    fn splice(&mut self, header: &[u8]) -> Result<Option<ByteBuf>, BroCatliResult> {
        let (window_size, start, end) = match self.read_stream_start(header) {
            Ok(parsed) => parsed,
            Err(ParseError::Incomplete) if header.len() < max_header_bytes(header) => {
                return Ok(None)
            }
            Err(ParseError::Incomplete) => {
                return Err(BroCatliResult::BrotliFileNotCraftedForConcatenation)
            }
            Err(ParseError::Invalid(err)) => return Err(err),
        };
        let mut spliced = BitWriter::default();
        if self.window_size == 0 {
            // The first stream is copied as is.
            self.window_size = window_size;
            spliced.write_bytes(header);
        } else {
            let tail = &self.tail[..usize::from(self.tail_len)];
            let (output_bits, num_output_bits) = remove_final_empty_metablock(tail)
                .ok_or(BroCatliResult::BrotliFileNotCraftedForAppend)?;
            spliced.write(output_bits, num_output_bits);
            spliced.write(bit_range(header, start, end), end - start);
            // the stream is padded to a byte boundary after this header, so the rest of it can be
            // copied byte by byte
            spliced.pad_to_byte();
            spliced.write_bytes(&header[(end + 7) / 8..]);
        }
        let (bytes, len) = spliced.finish();
        let tail_len = min(2, len);
        self.set_tail(&bytes[len - tail_len..len]);
        Ok(Some(ByteBuf::from_slice(&bytes[..len - tail_len])))
    }

    /// Copies the current stream through to the output, keeping its last two bytes in the tail.
    fn pass_through(
        &mut self,
        in_bytes: &[u8],
        in_offset: &mut usize,
        out_bytes: &mut [u8],
        out_offset: &mut usize,
    ) -> BroCatliResult {
        loop {
            let input = &in_bytes[*in_offset..];
            if input.is_empty() {
                return BroCatliResult::NeedsMoreInput;
            }
            if self.tail_len < 2 {
                self.tail[usize::from(self.tail_len)] = input[0];
                self.tail_len += 1;
                *in_offset += 1;
                continue;
            }
            if *out_offset == out_bytes.len() {
                return BroCatliResult::NeedsMoreOutput;
            }
            // Of the tail followed by the next `count` input bytes, the first `count` go out and
            // the last two become the tail.
            let count = min(input.len(), out_bytes.len() - *out_offset);
            let output = &mut out_bytes[*out_offset..*out_offset + count];
            if count == 1 {
                output[0] = self.tail[0];
                self.tail = [self.tail[1], input[0]];
            } else {
                output[..2].copy_from_slice(&self.tail);
                output[2..].copy_from_slice(&input[..count - 2]);
                self.tail.copy_from_slice(&input[count - 2..count]);
            }
            *in_offset += count;
            *out_offset += count;
            self.any_bytes_emitted = true;
        }
    }

    /// Writes as much of `bytes` as fits, returning how many bytes that was.
    fn write_out(&mut self, bytes: &[u8], out_bytes: &mut [u8], out_offset: &mut usize) -> usize {
        let count = min(bytes.len(), out_bytes.len() - *out_offset);
        out_bytes[*out_offset..*out_offset + count].copy_from_slice(&bytes[..count]);
        *out_offset += count;
        if count != 0 {
            self.any_bytes_emitted = true;
        }
        count
    }

    fn set_tail(&mut self, bytes: &[u8]) {
        self.tail = [0, 0];
        self.tail[..bytes.len()].copy_from_slice(bytes);
        self.tail_len = bytes.len() as u8;
    }
}

#[cfg(test)]
mod test {
    use super::BroCatli;
    use core::cmp::min;

    fn make_valid_serialized_buffer(buffer: &mut [u8]) {
        buffer[8] = 2;
        buffer[9] = (1 << 6) | (1 << 7);
        buffer[10] = 7;
        buffer[11] = 22;
        buffer[12] = super::NUM_STREAM_HEADER_BYTES as u8;
        buffer[13] = 3;
    }

    #[test]
    fn test_deserialization() {
        let broccoli = BroCatli {
            tail: [0x45, 0x46],
            tail_len: 1,
            window_size: 22,
            any_bytes_emitted: false,
            phase: super::Phase::WriteSplice {
                bytes: super::ByteBuf {
                    bytes: [0x33; super::NUM_STREAM_HEADER_BYTES],
                    len: super::NUM_STREAM_HEADER_BYTES as u8,
                },
                written: 3,
            },
        };
        let mut buffer = [0u8; 248];
        broccoli.serialize_to_buffer(&mut buffer[..]).unwrap();
        let bc = BroCatli::deserialize_from_buffer(&buffer[..]).unwrap();
        assert_eq!(broccoli, bc);
    }
    #[test]
    fn test_deserialization_any_written() {
        let broccoli = BroCatli {
            tail: [0x45, 0x46],
            tail_len: 1,
            window_size: 22,
            any_bytes_emitted: true,
            phase: super::Phase::WriteSplice {
                bytes: super::ByteBuf {
                    bytes: [0x33; super::NUM_STREAM_HEADER_BYTES],
                    len: super::NUM_STREAM_HEADER_BYTES as u8,
                },
                written: 3,
            },
        };
        let mut buffer = [0u8; 248];
        broccoli.serialize_to_buffer(&mut buffer[..]).unwrap();
        let bc = BroCatli::deserialize_from_buffer(&buffer[..]).unwrap();
        assert_eq!(broccoli, bc);
    }
    #[test]
    fn test_serialization() {
        let mut buffer = [0u8; 248];
        let mut broccoli = BroCatli::deserialize_from_buffer(&buffer).unwrap();
        let mut buffer2 = [0u8; 248];
        broccoli.serialize_to_buffer(&mut buffer2[..]).unwrap();
        assert_eq!(&buffer[..], &buffer2[..]);
        for (index, item) in buffer.iter_mut().enumerate() {
            *item = index as u8;
        }
        make_valid_serialized_buffer(&mut buffer[..]);
        broccoli = BroCatli::deserialize_from_buffer(&buffer).unwrap();
        broccoli.serialize_to_buffer(&mut buffer2[..]).unwrap();
        broccoli = BroCatli::deserialize_from_buffer(&buffer2).unwrap();
        for (_index, item) in buffer.iter_mut().enumerate() {
            *item = 0;
        }
        broccoli.serialize_to_buffer(&mut buffer[..]).unwrap();
        assert_eq!(&buffer[..], &buffer2[..]);
        for (index, item) in buffer.iter_mut().enumerate() {
            *item = 0xff ^ index as u8;
        }
        make_valid_serialized_buffer(&mut buffer[..]);
        broccoli = BroCatli::deserialize_from_buffer(&buffer).unwrap();
        broccoli.serialize_to_buffer(&mut buffer2[..]).unwrap();
        broccoli = BroCatli::deserialize_from_buffer(&buffer2).unwrap();
        for (_index, item) in buffer.iter_mut().enumerate() {
            *item = 0;
        }
        broccoli.serialize_to_buffer(&mut buffer[..]).unwrap();
        assert_eq!(&buffer[..], &buffer2[..]);
    }
    #[test]
    fn test_deserialization_rejects_invalid_state_fields() {
        let mut buffer = [0u8; 248];
        make_valid_serialized_buffer(&mut buffer[..]);

        let mut invalid = buffer;
        invalid[8] = 3;
        assert!(BroCatli::deserialize_from_buffer(&invalid[..]).is_err());

        invalid = buffer;
        invalid[10] = 8;
        assert!(BroCatli::deserialize_from_buffer(&invalid[..]).is_err());

        invalid = buffer;
        invalid[11] = 9;
        assert!(BroCatli::deserialize_from_buffer(&invalid[..]).is_err());

        invalid = buffer;
        invalid[12] = super::NUM_STREAM_HEADER_BYTES as u8 + 1;
        assert!(BroCatli::deserialize_from_buffer(&invalid[..]).is_err());

        invalid = buffer;
        invalid[13] = buffer[12] + 1;
        assert!(BroCatli::deserialize_from_buffer(&invalid[..]).is_err());
    }
    #[test]
    fn test_cat_empty_stream() {
        let empty_catable = [b';'];
        let mut bcat = super::BroCatli::default();
        let mut in_offset = 0usize;
        let mut out_bytes = [0u8; 32];
        let mut out_offset = 0usize;
        bcat.new_brotli_file();
        let mut res = bcat.stream(
            &empty_catable[..],
            &mut in_offset,
            &mut out_bytes[..],
            &mut out_offset,
        );
        assert_eq!(res, super::BroCatliResult::NeedsMoreInput);
        bcat.new_brotli_file();
        in_offset = 0;
        res = bcat.stream(
            &empty_catable[..],
            &mut in_offset,
            &mut out_bytes[..],
            &mut out_offset,
        );
        assert_eq!(res, super::BroCatliResult::NeedsMoreInput);
        res = bcat.finish(&mut out_bytes[..], &mut out_offset);
        assert_eq!(res, super::BroCatliResult::Success);
        assert_ne!(out_offset, 0);
        assert_eq!(&out_bytes[..out_offset], &[b';']);
    }
    fn canonical_empty_stream(window: u8) -> ([u8; 2], usize) {
        // window bits followed by ISLAST + ISLASTEMPTY
        match window {
            16 => ([0x06, 0], 1),
            17 => ([0x81, 0x01], 2),
            10..=15 => ([0x01 | ((window - 8) << 4) | 0x80, 0x01], 2),
            18..=24 => ([(3 + (window - 18) * 2) | 0x30, 0], 1),
            _ => ([0x11, window | 0xc0], 2),
        }
    }

    fn concat_chunked(
        mut bcat: BroCatli,
        streams: &[&[u8]],
        in_chunk: usize,
        out_chunk: usize,
        output: &mut [u8],
    ) -> usize {
        let mut output_offset = 0;
        for stream in streams {
            bcat.new_brotli_file();
            for chunk in stream.chunks(in_chunk) {
                let mut input_offset = 0;
                loop {
                    let out_end = min(output.len(), output_offset + out_chunk);
                    match bcat.stream(
                        chunk,
                        &mut input_offset,
                        &mut output[..out_end],
                        &mut output_offset,
                    ) {
                        super::BroCatliResult::NeedsMoreOutput => {}
                        super::BroCatliResult::NeedsMoreInput => break,
                        res => panic!("unexpected {:?}", res),
                    }
                }
                assert_eq!(input_offset, chunk.len());
            }
        }
        loop {
            let out_end = min(output.len(), output_offset + out_chunk);
            match bcat.finish(&mut output[..out_end], &mut output_offset) {
                super::BroCatliResult::NeedsMoreOutput => {}
                super::BroCatliResult::Success => return output_offset,
                res => panic!("unexpected {:?}", res),
            }
        }
    }

    #[test]
    fn test_cat_empty_streams_every_window_and_buffer_size() {
        // An empty stream's ISLAST/ISLASTEMPTY pair straddles a byte boundary whenever it is
        // realigned onto bit offset 7 (windows 10..=15 and 17, and large windows, at offset 14).
        // Concatenating empty streams must reproduce the empty stream regardless of how the
        // caller chunks its input and output buffers.
        for window in 10u8..=30 {
            let (empty, empty_len) = canonical_empty_stream(window);
            let empty = &empty[..empty_len];
            for in_chunk in 1..=3 {
                for out_chunk in 1..=3 {
                    for count in 1..=3 {
                        let streams = [empty; 3];
                        for preseeded in [false, true] {
                            let bcat = if preseeded {
                                BroCatli::new_with_window_size(window)
                            } else {
                                BroCatli::new()
                            };
                            let mut output = [0u8; 32];
                            let len = concat_chunked(
                                bcat,
                                &streams[..count],
                                in_chunk,
                                out_chunk,
                                &mut output,
                            );
                            assert_eq!(
                                &output[..len],
                                empty,
                                "window {window} in_chunk {in_chunk} out_chunk {out_chunk} \
                                 count {count} preseeded {preseeded}",
                            );
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn test_cat_empty_stream_between_streams_with_straddled_final_bits() {
        // window 15 puts an empty stream's ISLAST/ISLASTEMPTY pair at bits 7 and 8, and
        // new_with_window_size(15) realigns the next stream onto bit offset 7
        let empty_w15 = [0x71u8 | 0x80, 1];
        let mut bcat = super::BroCatli::new_with_window_size(15);
        let mut out_bytes = [0u8; 32];
        let mut out_offset = 0usize;
        for _ in 0..3 {
            let mut in_offset = 0usize;
            bcat.new_brotli_file();
            let res = bcat.stream(
                &empty_w15[..],
                &mut in_offset,
                &mut out_bytes[..],
                &mut out_offset,
            );
            assert_eq!(res, super::BroCatliResult::NeedsMoreInput);
        }
        let res = bcat.finish(&mut out_bytes[..], &mut out_offset);
        assert_eq!(res, super::BroCatliResult::Success);
        assert_eq!(&out_bytes[..out_offset], &empty_w15[..]);
    }
    #[test]
    fn test_cat_truncated_metadata_header_fails() {
        let empty_catable = [b';'];
        let mut bcat = super::BroCatli::new_with_window_size(22);
        let mut in_offset = 0usize;
        let mut out_bytes = [0u8; 32];
        let mut out_offset = 0usize;
        let mut res = bcat.stream(
            &empty_catable[..],
            &mut in_offset,
            &mut out_bytes[..],
            &mut out_offset,
        );
        assert_eq!(res, super::BroCatliResult::NeedsMoreInput);

        let truncated_metadata = [0x71, 0x1b, 0, 0];
        bcat.new_brotli_file();
        in_offset = 0;
        out_offset = 0;
        res = bcat.stream(
            &truncated_metadata[..],
            &mut in_offset,
            &mut out_bytes[..],
            &mut out_offset,
        );
        assert_eq!(
            res,
            super::BroCatliResult::BrotliFileNotCraftedForConcatenation
        );
    }
    #[test]
    fn test_try_new_with_window_size_invalid_returns_error() {
        use super::BroCatliResult;
        // Values 0..=9 are invalid window sizes and must return an error, not panic.
        for ws in 0u8..=9 {
            match BroCatli::try_new_with_window_size(ws) {
                Err(BroCatliResult::InvalidWindowSize) => {}
                Err(_) => panic!("window_size {} returned wrong error variant", ws),
                Ok(_) => panic!("window_size {} should be rejected", ws),
            }
            #[cfg(feature = "std")]
            assert!(
                std::panic::catch_unwind(|| BroCatli::new_with_window_size(ws)).is_err(),
                "window_size {} should panic through the legacy constructor",
                ws
            );
        }
    }
    #[test]
    fn test_new_with_window_size_valid() {
        // Values 10..=24 and >24 are valid window sizes.
        for ws in 10u8..=30 {
            let _ = BroCatli::new_with_window_size(ws);
            assert!(
                BroCatli::try_new_with_window_size(ws).is_ok(),
                "window_size {} should be accepted",
                ws
            );
        }
    }

    #[test]
    fn test_cat_empty_stream_after_quality_one_stream() {
        // The first stream is the quality-1 reproduction from #258; the second is empty.
        let first_catable = [
            131, 0, 128, 48, 48, 152, 0, 0, 0, 10, 38, 6, 14, 224, 250, 125, 73, 137, 13, 224, 2,
            28, 94, 161, 1,
        ];
        let empty_catable = [161, 1];
        let mut bcat = BroCatli::new();
        let mut output = [0u8; 32];
        let mut output_offset = 0;

        for stream in [&first_catable[..], &empty_catable[..]] {
            bcat.new_brotli_file();
            let mut input_offset = 0;
            let result = bcat.stream(stream, &mut input_offset, &mut output, &mut output_offset);
            assert_eq!(result, super::BroCatliResult::NeedsMoreInput);
            assert_eq!(input_offset, stream.len());
        }

        let result = bcat.finish(&mut output, &mut output_offset);
        assert_eq!(result, super::BroCatliResult::Success);
        assert_eq!(&output[..output_offset], &first_catable[..]);
    }

    fn concat_single_stream_with_window(window: u8, stream: &[u8], output: &mut [u8; 32]) -> usize {
        let mut bcat = BroCatli::new_with_window_size(window);
        let mut output_offset = 0;
        bcat.new_brotli_file();
        let mut input_offset = 0;
        let result = bcat.stream(stream, &mut input_offset, output, &mut output_offset);
        assert_eq!(result, super::BroCatliResult::NeedsMoreInput);
        assert_eq!(input_offset, stream.len());
        let result = bcat.finish(output, &mut output_offset);
        assert_eq!(result, super::BroCatliResult::Success);
        output_offset
    }

    #[test]
    fn test_cat_empty_stream_with_small_window_size() {
        // Regression test: `new_with_window_size` for windows 10..=17 used to turn a valid
        // empty brotli stream into an undecodable one (reporting Success while doing so).
        //
        // Each `stream` below is an empty brotli stream for the given window as produced by
        // this crate's own encoder with -bytealign -appendable (a metadata block, then an empty
        // last block). It is shorter than a sufficient() header, so it passes through as is.
        // A zero-byte file instead leaves the pre-seed in place, which `finish` closes into the
        // canonical short empty stream (window bits followed by ISLAST + ISLASTEMPTY). All
        // expected outputs decode to zero bytes with a conformant brotli decoder.
        //
        // Windows 10/17 exercise the two-byte pre-seeded `last_bytes` path (the length was
        // left at 2, so `append_eof_metablock_to_last_bytes` overflowed `3u16 << 15`).
        // Window 16 exercises its own pre-seed, whose window bit was incorrectly set.
        let cases: [(u8, &[u8], &[u8]); 3] = [
            (10, &[0x21, 0x03, 0x03], &[0xa1, 0x01]),
            (16, &[0x0c, 0x03], &[0x06]),
            (17, &[0x01, 0x03, 0x03], &[0x81, 0x01]),
        ];
        for (window, stream, canonical) in cases {
            let mut output = [0u8; 32];
            let len = concat_single_stream_with_window(window, stream, &mut output);
            assert_eq!(
                &output[..len],
                stream,
                "unexpected concatenation output for window {window}",
            );
            let len = concat_single_stream_with_window(window, &[], &mut output);
            assert_eq!(
                &output[..len],
                canonical,
                "unexpected zero-byte file output for window {window}",
            );
        }
    }
}
