//! Allows serialization of the adblock engine into a compact binary format, as well as subsequent
//! rapid deserialization back into an engine.
//!
//! In order to support multiple format versions simultaneously, this module wraps around different
//! serialization/deserialization implementations and can automatically dispatch to the appropriate
//! one.
//!
//! The current .dat file format:
//! 1. magic (4 bytes)
//! 2. DAT format version (1 byte)
//! 3. seahash of the data (8 bytes)
//! 4. crate version (16 bytes, NUL-padded `CARGO_PKG_VERSION`)
//! 5. data (the rest of the file)

use thiserror::Error;

/// Newer formats start with this magic byte sequence.
/// Calculated as the leading 4 bytes of `echo -n 'brave/adblock-rust' | sha512sum`.
const ADBLOCK_RUST_DAT_MAGIC: [u8; 4] = [0xd1, 0xd9, 0x3a, 0xaf];

/// The version of the data format.
/// If the data format version is incremented, the data is considered as incompatible.
const ADBLOCK_RUST_DAT_VERSION: u8 = 8;

/// Offset of the 8-byte seahash checksum within the serialized header.
const HASH_OFFSET: usize = ADBLOCK_RUST_DAT_MAGIC.len() + 1;
/// Offset of the 16-byte crate version field within the serialized header.
const PKG_VERSION_OFFSET: usize = HASH_OFFSET + 8;

/// The 16-byte crate version field within the serialized header.
const ADBLOCK_RUST_PKG_VERSION: [u8; 16] = {
    const VERSION_BYTES: &[u8] = env!("CARGO_PKG_VERSION").as_bytes();
    const _: () = assert!(
        4 <= VERSION_BYTES.len() && VERSION_BYTES.len() <= ADBLOCK_RUST_PKG_VERSION.len(),
        "CARGO_PKG_VERSION must fit in ADBLOCK_RUST_PKG_VERSION header field"
    );
    let mut encoded = [0u8; 16];
    let (head, _) = encoded.split_at_mut(VERSION_BYTES.len());
    head.copy_from_slice(VERSION_BYTES);
    encoded
};

/// The total length of the header prefix (magic + version + seahash + crate version)
pub(crate) const HEADER_PREFIX_LENGTH: usize = PKG_VERSION_OFFSET + ADBLOCK_RUST_PKG_VERSION.len();

/// Failure cases for deserialization of the [crate::Engine].
#[derive(Error, Debug, PartialEq)]
pub enum DeserializationError {
    /// The serialized buffer is missing the expected header bytes, including a fixed 4-byte
    /// sequence, version number, and checksum.
    #[error("bad header")]
    BadHeader,
    /// The header's recorded checksum did not match the data itself.
    #[error("bad checksum")]
    BadChecksum { expected: [u8; 8], actual: [u8; 8] },
    /// The buffer was serialized from a previous, incompatible version of this crate. It should be
    /// regenerated from list text instead.
    #[error("version mismatch")]
    VersionMismatch(u8),
    /// The serialized data payload was not a valid flatbuffer format.
    #[error("flatbuffer parsing error")]
    FlatBufferParsingError(flatbuffers::InvalidFlatbuffer),
}

pub(crate) fn serialize_dat_file(data: &[u8]) -> Vec<u8> {
    let mut serialized = Vec::with_capacity(data.len() + HEADER_PREFIX_LENGTH);
    let hash = seahash::hash(data).to_le_bytes();
    serialized.extend_from_slice(&ADBLOCK_RUST_DAT_MAGIC);
    serialized.push(ADBLOCK_RUST_DAT_VERSION);
    serialized.extend_from_slice(&hash);
    serialized.extend_from_slice(&ADBLOCK_RUST_PKG_VERSION);
    assert_eq!(serialized.len(), HEADER_PREFIX_LENGTH);

    serialized.extend_from_slice(data);
    serialized
}

/// Parsed DAT payload.
///
/// `crate_version_matches` is true when the DAT file is produced by this same-version build.
/// That is a reload hint, not proof the file is authentic.
/// See [`crate::Engine::deserialize`].
#[derive(Debug)]
pub(crate) struct DatFilePayload<'a> {
    pub data: &'a [u8],
    pub crate_version_matches: bool,
}

pub(crate) fn deserialize_dat_file(
    serialized: &[u8],
) -> Result<DatFilePayload<'_>, DeserializationError> {
    if serialized.len() < HEADER_PREFIX_LENGTH || !serialized.starts_with(&ADBLOCK_RUST_DAT_MAGIC) {
        return Err(DeserializationError::BadHeader);
    }

    let version = serialized[ADBLOCK_RUST_DAT_MAGIC.len()];
    if version != ADBLOCK_RUST_DAT_VERSION {
        return Err(DeserializationError::VersionMismatch(version));
    }
    let data = &serialized[HEADER_PREFIX_LENGTH..];

    // Check the hash to ensure the data isn't corrupted.
    let expected_hash = &serialized[HASH_OFFSET..PKG_VERSION_OFFSET];
    debug_assert_eq!(PKG_VERSION_OFFSET - HASH_OFFSET, 8);
    let actual_hash = seahash::hash(data).to_le_bytes();
    if expected_hash != actual_hash {
        return Err(DeserializationError::BadChecksum {
            // Unwrap safety: see debug_assert_eq above
            expected: expected_hash.try_into().unwrap(),
            actual: actual_hash,
        });
    }
    let crate_version_matches =
        serialized[PKG_VERSION_OFFSET..HEADER_PREFIX_LENGTH] == ADBLOCK_RUST_PKG_VERSION;
    Ok(DatFilePayload {
        data,
        crate_version_matches,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_magic_bytes() {
        use sha2::Digest;

        let mut hasher = sha2::Sha512::new();

        hasher.update("brave/adblock-rust");

        let result = hasher.finalize();

        assert!(result.starts_with(&ADBLOCK_RUST_DAT_MAGIC));
    }

    #[test]
    fn serialize_deserialize_test() {
        let data = b"test";
        let serialized = serialize_dat_file(data);
        let deserialized = deserialize_dat_file(&serialized).unwrap();
        assert_eq!(data.as_slice(), deserialized.data);
        assert!(deserialized.crate_version_matches);
        assert_eq!(
            &serialized[HEADER_PREFIX_LENGTH - 16..HEADER_PREFIX_LENGTH],
            ADBLOCK_RUST_PKG_VERSION
        );
    }

    #[test]
    fn crate_version_mismatch_still_returns_data() {
        let data = b"test";
        let mut serialized = serialize_dat_file(data);
        serialized[HEADER_PREFIX_LENGTH - 1] ^= 1;
        let deserialized = deserialize_dat_file(&serialized).unwrap();
        assert!(!deserialized.crate_version_matches);
        assert_eq!(data.as_slice(), deserialized.data);
    }

    #[test]
    fn corrupted_data_test() {
        let data = b"test";
        let serialized = serialize_dat_file(data);
        let mut corrupted_serialized = serialized.clone();
        corrupted_serialized[HEADER_PREFIX_LENGTH] = 0;
        std::assert_matches!(
            deserialize_dat_file(&corrupted_serialized),
            Err(DeserializationError::BadChecksum { .. })
        );
    }
}
