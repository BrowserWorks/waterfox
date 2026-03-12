/// An inner implementation of a HashMap-like container with open addressing.
/// Designed to be used in HashMap, HashSet, HashMultiMap.
/// The load factor is 25%-50%.
/// Uses RustC FxHasher as a hash function.
/// A default value is used to mark empty slots, so it can't be used as a key.
/// Inspired by https://source.chromium.org/chromium/chromium/src/+/main:components/url_pattern_index/closed_hash_map.h
use std::marker::PhantomData;

use crate::flatbuffers::containers::fb_index::FbIndex;

/// A trait for hash table builder keys, i.e. String.
/// The default value is used to mark empty slots.
pub(crate) trait HashKey: Eq + std::hash::Hash + Default + Clone {
    /// Returns true if the key is empty.
    fn is_empty(&self) -> bool;
}

impl<T: Eq + std::hash::Hash + Default + Clone> HashKey for T {
    fn is_empty(&self) -> bool {
        self == &T::default()
    }
}

/// A trait for hash table view keys that can be used in flatbuffers, i.e. &str.
/// The implementation must synchronized with matching HashKey trait.
pub(crate) trait FbHashKey: Eq + std::hash::Hash {
    /// Returns true if the key is empty.
    fn is_empty(&self) -> bool;
}

impl FbHashKey for &str {
    fn is_empty(&self) -> bool {
        str::is_empty(self)
    }
}

/// An internal function to find a slot in the hash table for the given key.
/// Returns the slot index.
/// 'table_size' is the table size. It must be a power of two.
/// 'probe' must return true at least for one slot (supposing the table isn't full).
pub fn find_slot<I: std::hash::Hash>(
    key: &I,
    table_size: usize,
    probe: impl Fn(usize) -> bool,
) -> usize {
    debug_assert!(table_size.is_power_of_two());
    let table_mask = table_size - 1;
    let mut slot = get_hash(&key) & table_mask;
    let mut step = 1;
    loop {
        if probe(slot) {
            return slot;
        }
        slot = (slot + step) & table_mask;
        step += 1;
    }
}

/// A flatbuffer-compatible view of a hash table.
/// It's used to access the hash table without copying the keys and values.
/// Is loaded from HashIndexBuilder data, serialized into a flatbuffer.
pub(crate) struct HashIndexView<I: FbHashKey, V, Keys: FbIndex<I>, Values: FbIndex<V>> {
    indexes: Keys,
    values: Values,
    _phantom_i: PhantomData<I>,
    _phantom_v: PhantomData<V>,
}

impl<I: FbHashKey, V, Keys: FbIndex<I>, Values: FbIndex<V>> HashIndexView<I, V, Keys, Values> {
    pub fn new(indexes: Keys, values: Values) -> Self {
        Self {
            indexes,
            values,
            _phantom_i: PhantomData,
            _phantom_v: PhantomData,
        }
    }

    pub fn capacity(&self) -> usize {
        self.indexes.len()
    }

    pub fn get_single(&self, key: I) -> Option<V> {
        let slot = find_slot(&key, self.capacity(), |slot| -> bool {
            FbHashKey::is_empty(&self.indexes.get(slot)) || self.indexes.get(slot) == key
        });
        if FbHashKey::is_empty(&self.indexes.get(slot)) {
            None
        } else {
            Some(self.values.get(slot))
        }
    }

    #[cfg(test)]
    /// Returns the number of non-empty slots in the hash table.
    /// Slow, use only for tests.
    pub fn len(&self) -> usize {
        let mut len = 0;
        for i in 0..self.capacity() {
            if !FbHashKey::is_empty(&self.indexes.get(i)) {
                len += 1;
            }
        }
        len
    }
}

/// A builder for a hash table.
/// The default value is used to mark empty slots.
/// `consume()` output is suppose to be serialized into a flatbuffer and
/// used as a HashIndexView.
pub(crate) struct HashIndexBuilder<I, V> {
    indexes: Vec<I>,
    values: Vec<V>,
    size: usize,
}

/// An internal function to hash a key.
/// The hash must be persistent across different runs of the program.
fn get_hash<I: std::hash::Hash>(key: &I) -> usize {
    // RustC Hash is 2x faster than DefaultHasher.
    use rustc_hash::FxHasher;
    use std::hash::Hasher;
    let mut hasher = FxHasher::default();
    key.hash(&mut hasher);
    hasher.finish() as usize
}

impl<I: HashKey, V: Default + Clone> Default for HashIndexBuilder<I, V> {
    fn default() -> Self {
        Self::new_with_capacity(4)
    }
}

impl<I: HashKey, V: Default + Clone> HashIndexBuilder<I, V> {
    pub fn new_with_capacity(capacity: usize) -> Self {
        Self {
            size: 0,
            indexes: vec![I::default(); capacity],
            values: vec![V::default(); capacity],
        }
    }

    pub fn insert(&mut self, key: I, value: V, allow_duplicates: bool) -> (usize, &mut V) {
        debug_assert!(!HashKey::is_empty(&key), "Key is empty");

        let slot = find_slot(&key, self.capacity(), |slot| -> bool {
            HashKey::is_empty(&self.indexes[slot])
                || (self.indexes[slot] == key && !allow_duplicates)
        });

        if HashKey::is_empty(&self.indexes[slot]) {
            self.indexes[slot] = key;
            self.values[slot] = value;
            self.size += 1;
            self.maybe_increase_capacity();
            (slot, &mut self.values[slot])
        } else {
            self.values[slot] = value;
            (slot, &mut self.values[slot])
        }
    }

    fn capacity(&self) -> usize {
        self.indexes.len()
    }

    pub fn get_or_insert(&mut self, key: I, value: V) -> &mut V {
        let slot = find_slot(&key, self.capacity(), |slot| -> bool {
            HashKey::is_empty(&self.indexes[slot]) || self.indexes[slot] == key
        });
        if !HashKey::is_empty(&self.indexes[slot]) {
            return &mut self.values[slot];
        }
        let (_, new_value) = self.insert(key, value, false);
        new_value
    }

    fn maybe_increase_capacity(&mut self) {
        if self.size * 2 <= self.capacity() {
            // Use 50% load factor.
            return;
        }

        let new_capacity = (self.capacity() * 2).next_power_of_two();
        let old_indexes = std::mem::take(&mut self.indexes);
        let old_values = std::mem::take(&mut self.values);
        self.indexes = vec![I::default(); new_capacity];
        self.values = vec![V::default(); new_capacity];

        for (key, value) in old_indexes.into_iter().zip(old_values.into_iter()) {
            if !HashKey::is_empty(&key) {
                let slot = find_slot(&key, new_capacity, |slot| -> bool {
                    HashKey::is_empty(&self.indexes[slot])
                });
                self.indexes[slot] = key;
                self.values[slot] = value;
            }
        }
    }

    pub fn consume(value: Self) -> (Vec<I>, Vec<V>) {
        (value.indexes, value.values)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_hash() {
        // Verify get_hash is stable.
        // If the value changes, update ADBLOCK_RUST_DAT_VERSION.
        let message = "If the value changes, update ADBLOCK_RUST_DAT_VERSION.";
        assert_eq!(get_hash(&"adblock-rust"), 15102204115509201409, "{message}");
    }
}
