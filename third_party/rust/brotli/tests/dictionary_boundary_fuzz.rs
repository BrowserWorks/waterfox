extern crate brotli;

// Run a larger sweep with BROTLI_BOUNDARY_FUZZ_CASES=10000 cargo test --test dictionary_boundary_fuzz.

mod harness {
    use brotli::enc::encode::{
        BrotliEncoderOperation, BrotliEncoderParameter, BrotliEncoderStateStruct,
    };
    use brotli::enc::{BrotliEncoderMaxCompressedSize, StandardAlloc};
    use brotli::{Allocator, Decompressor, SliceWrapperMut};
    use std::io::Read;

    const MULTIPLIER: u64 = 0x9E37_79B9_7F4A_7C15;

    pub fn corpus(seed: u64, dict_len: usize, data_len: usize, shape: u8) -> (Vec<u8>, Vec<u8>) {
        let mut x = seed.wrapping_mul(MULTIPLIER) | 1;
        let total = dict_len + data_len;
        let mut all = Vec::with_capacity(total);
        for i in 0..total {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let v = match shape % 6 {
                0 => b'a' + ((x >> 32) % 3) as u8,
                1 => b'a' + ((x >> 32) % 2) as u8,
                2 => b'a' + (i.wrapping_add(seed as usize) % 4) as u8,
                3 => (x >> 32) as u8,
                4 => b'a' + ((i / 7).wrapping_add(seed as usize) % 3) as u8,
                _ => b'a' + ((i / 3).wrapping_add((x >> 32) as usize) % 3) as u8,
            };
            all.push(v);
        }
        (all[..dict_len].to_vec(), all[dict_len..].to_vec())
    }

    fn decompress_with_dict(compressed: &[u8], dictionary: &[u8]) -> Result<Vec<u8>, String> {
        let mut alloc = StandardAlloc::default();
        let mut dict_mem =
            <StandardAlloc as Allocator<u8>>::alloc_cell(&mut alloc, dictionary.len());
        dict_mem.slice_mut().copy_from_slice(dictionary);
        let mut decoder = Decompressor::new_with_custom_dict(compressed, 4096, dict_mem);
        let mut plain = Vec::new();
        decoder
            .read_to_end(&mut plain)
            .map_err(|err| format!("decompress: {}", err))?;
        Ok(plain)
    }

    fn compress_dict(
        dictionary: &[u8],
        input: &[u8],
        quality: u32,
        catable: bool,
    ) -> Result<Vec<u8>, String> {
        let mut state = BrotliEncoderStateStruct::new(StandardAlloc::default());
        let params = [
            (BrotliEncoderParameter::BROTLI_PARAM_QUALITY, quality),
            (BrotliEncoderParameter::BROTLI_PARAM_LGWIN, 22),
            (BrotliEncoderParameter::BROTLI_PARAM_CATABLE, catable as u32),
            (
                BrotliEncoderParameter::BROTLI_PARAM_APPENDABLE,
                catable as u32,
            ),
        ];
        for &(key, value) in &params {
            if !state.set_parameter(key, value) {
                return Err(format!("set_parameter failed for q={}", quality));
            }
        }
        state.set_custom_dictionary(dictionary.len(), dictionary);
        let mut output = vec![0u8; BrotliEncoderMaxCompressedSize(input.len()) + 1024];
        let (mut in_offset, mut out_offset) = (0usize, 0usize);
        for _ in 0..16 {
            let mut avail_in = input.len() - in_offset;
            let mut avail_out = output.len() - out_offset;
            let mut total_out = Some(out_offset);
            let ok = state.compress_stream(
                BrotliEncoderOperation::BROTLI_OPERATION_FINISH,
                &mut avail_in,
                input,
                &mut in_offset,
                &mut avail_out,
                &mut output,
                &mut out_offset,
                &mut total_out,
                &mut |_, _, _, _| (),
            );
            if !ok {
                return Err(format!("compress_stream returned false q={}", quality));
            }
            if state.is_finished() {
                output.truncate(out_offset);
                return Ok(output);
            }
            if avail_out == 0 {
                return Err("output buffer exhausted".to_owned());
            }
        }
        Err("compression failed to finish in 16 iterations".to_owned())
    }

    pub fn check_dict(
        dictionary: &[u8],
        input: &[u8],
        quality: u32,
        catable: bool,
    ) -> Result<usize, String> {
        let compressed = compress_dict(dictionary, input, quality, catable)?;
        let plain = decompress_with_dict(&compressed, dictionary)?;
        if plain != input {
            return Err(format!(
                "mismatch: decoded {} bytes, expected {}",
                plain.len(),
                input.len()
            ));
        }
        Ok(compressed.len())
    }
}

#[test]
fn dictionary_boundary_issue_280() {
    let (dictionary, input) = harness::corpus(50, 16, 4096, 0);
    for quality in 5..10 {
        let catable = quality < 7;
        harness::check_dict(&dictionary, &input, quality, catable).unwrap_or_else(|message| {
            panic!(
                "issue #280: quality={} catable={}: {}",
                quality, catable, message
            )
        });
    }
}

#[test]
fn dictionary_boundary_seeded_cases() {
    let cases = std::env::var("BROTLI_BOUNDARY_FUZZ_CASES")
        .map(|value| {
            value
                .parse::<u64>()
                .expect("invalid BROTLI_BOUNDARY_FUZZ_CASES")
        })
        .unwrap_or(1000);
    for seed in 0..cases {
        let dict_len = [2usize, 4, 8, 16, 31, 63, 127, 1024][(seed % 8) as usize];
        let data_len = [128usize, 1024, 4096, 8192][((seed / 8) % 4) as usize];
        let quality = (seed % 12) as u32;
        let shape = ((seed / 3) % 6) as u8;
        let catable = seed % 2 == 0;
        let (dictionary, input) = harness::corpus(seed, dict_len, data_len, shape);
        harness::check_dict(&dictionary, &input, quality, catable).unwrap_or_else(|message| {
            panic!(
                "seed={} dict={} len={} shape={} quality={} catable={}: {}",
                seed, dict_len, data_len, shape, quality, catable, message
            )
        });
    }
}
