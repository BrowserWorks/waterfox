//! Allows serialization of the adblock engine into a compact binary format, as well as subsequent
//! rapid deserialization back into an engine.
//!
//! In order to support multiple format versions simultaneously, this module wraps around different
//! serialization/deserialization implementations and can automatically dispatch to the appropriate
//! one.
//!
//! The current .dat file format:
//! 1. magic (4 bytes)
//! 2. version (1 byte)
//! 3. seahash of the data (8 bytes)
//! 4. data (the rest of the file)

use thiserror::Error;

/// Newer formats start with this magic byte sequence.
/// Calculated as the leading 4 bytes of `echo -n 'brave/adblock-rust' | sha512sum`.
const ADBLOCK_RUST_DAT_MAGIC: [u8; 4] = [0xd1, 0xd9, 0x3a, 0xaf];

/// The version of the data format.
/// If the data format version is incremented, the data is considered as incompatible.
const ADBLOCK_RUST_DAT_VERSION: u8 = 5;

/// The total length of the header prefix (magic + version + seahash)
const HEADER_PREFIX_LENGTH: usize = 4 + 1 + 8;

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
    assert_eq!(serialized.len(), HEADER_PREFIX_LENGTH);

    serialized.extend_from_slice(data);
    serialized
}

pub(crate) fn deserialize_dat_file(serialized: &[u8]) -> Result<&[u8], DeserializationError> {
    if serialized.len() < HEADER_PREFIX_LENGTH || !serialized.starts_with(&ADBLOCK_RUST_DAT_MAGIC) {
        return Err(DeserializationError::BadHeader);
    }

    let version = serialized[ADBLOCK_RUST_DAT_MAGIC.len()];
    if version != ADBLOCK_RUST_DAT_VERSION {
        return Err(DeserializationError::VersionMismatch(version));
    }
    let data = &serialized[HEADER_PREFIX_LENGTH..];

    // Check the hash to ensure the data isn't corrupted.
    let expected_hash = &serialized[(ADBLOCK_RUST_DAT_MAGIC.len() + 1)..HEADER_PREFIX_LENGTH];
    debug_assert_eq!(HEADER_PREFIX_LENGTH - (ADBLOCK_RUST_DAT_MAGIC.len() + 1), 8);
    let actual_hash = seahash::hash(data).to_le_bytes();
    if expected_hash != actual_hash {
        return Err(DeserializationError::BadChecksum {
            // Unwrap safety: see debug_assert_eq above
            expected: expected_hash.try_into().unwrap(),
            actual: actual_hash,
        });
    }
    Ok(data)
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
        assert_eq!(data, deserialized);
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
