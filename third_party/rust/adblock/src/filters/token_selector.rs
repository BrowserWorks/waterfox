//! Token selector for optimizing filter storage by choosing least-used tokens

use crate::utils::{to_short_hash, Hash, ShortHash};
use seahash::SeaHasher;
use std::collections::HashMap;
use std::hash::BuildHasherDefault;

// Two groups of tokens that better be avoided during token selection.
// The list was built by logging each token that triggered .matches() call
// for some network filter in the benchmark.
const WORST_TOKENS: [&str; 4] = ["https", "http", "www", "com"];
const BAD_TOKENS: [&str; 36] = [
    "uk",
    "net",
    "org",
    "io",
    "de",
    "fr",
    "es",
    "it",
    "nl",
    "se",
    "ru",
    "pl",
    "co",
    "js",
    "css",
    "img",
    "jpg",
    "html",
    "png",
    "cdn",
    "static",
    "images",
    "api",
    "wp",
    "ad",
    "ads",
    "content",
    "doubleclick",
    "analytics",
    "assets",
    "id",
    "min",
    "amazon",
    "google",
    "googlesyndication",
    "googleapis",
];

const WORST_TOKEN_USAGE: usize = usize::MAX / 2;
const BAD_TOKEN_USAGE: usize = usize::MAX / 4;

/// Selects the optimal token for filter storage by tracking usage frequencies.
/// Tokens that are used less frequently are preferred for better efficiency.
pub(crate) struct TokenSelector {
    usage: HashMap<ShortHash, usize, BuildHasherDefault<SeaHasher>>,
}

impl TokenSelector {
    /// Creates a new TokenSelector with pre-populated commonly-used tokens.
    pub fn new(capacity: usize) -> Self {
        let mut usage = HashMap::with_capacity_and_hasher(
            capacity + WORST_TOKENS.len() + BAD_TOKENS.len(),
            BuildHasherDefault::<SeaHasher>::default(),
        );
        let mut store_token = |token: &str, count: usize| {
            usage.insert(to_short_hash(crate::utils::fast_hash(token)), count);
        };

        for token in WORST_TOKENS {
            store_token(token, WORST_TOKEN_USAGE);
        }

        for token in BAD_TOKENS {
            store_token(token, BAD_TOKEN_USAGE);
        }

        Self { usage }
    }

    /// Selects the least-used token from the provided list of tokens.
    /// Returns the token with the lowest current usage count.
    pub fn select_least_used_token(&self, tokens: &[Hash]) -> Hash {
        let mut best_token = 0;
        let mut best_token_used = usize::MAX;
        for &token in tokens {
            if token == 0 {
                // 0 is already used as a fallback token.
                continue;
            }

            match self.usage.get(&to_short_hash(token)) {
                Some(&count) => {
                    if count < best_token_used {
                        best_token_used = count;
                        best_token = token;
                    }
                }
                None => {
                    // Token never seen before - this is optimal
                    return token;
                }
            }
        }
        best_token
    }

    /// Records that a token has been used, incrementing its usage count.
    pub fn record_usage(&mut self, token: Hash) {
        *self.usage.entry(to_short_hash(token)).or_insert(0) += 1;
    }
}

#[cfg(test)]
#[path = "../../tests/unit/filters/token_selector.rs"]
mod unit_tests;
