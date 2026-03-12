#![allow(dead_code)]

use std::marker::PhantomData;

use crate::flatbuffers::containers;
use containers::flat_serialize::{FlatBuilder, FlatSerialize, WIPFlatVec};
use containers::sorted_index::SortedIndex;

/// A set-like container that uses flatbuffer references.
/// Provides O(log n) lookup time using binary search on the sorted data.
/// I is a key type, Keys is specific container of keys, &[I] for fast indexing (u32, u64)
/// and flatbuffers::Vector<I> if there is no conversion from Vector (str) to slice.
pub(crate) struct FlatSetView<I, Keys>
where
    Keys: SortedIndex<I>,
{
    keys: Keys,
    _phantom: PhantomData<I>,
}

impl<I, Keys> FlatSetView<I, Keys>
where
    I: Ord,
    Keys: SortedIndex<I>,
{
    pub fn new(keys: Keys) -> Self {
        Self {
            keys,
            _phantom: PhantomData,
        }
    }

    pub fn contains(&self, key: I) -> bool {
        let index = self.keys.partition_point(|x| *x < key);
        index < self.keys.len() && self.keys.get(index) == key
    }

    #[inline(always)]
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    #[inline(always)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl<'b, B: FlatBuilder<'b>, T: FlatSerialize<'b, B> + std::hash::Hash + Ord> FlatSerialize<'b, B>
    for std::collections::HashSet<T>
{
    type Output = WIPFlatVec<'b, T, B>;

    fn serialize(value: Self, builder: &mut B) -> Self::Output {
        let mut items = value.into_iter().collect::<Vec<_>>();
        items.sort_unstable();
        let v = items
            .into_iter()
            .map(|x| FlatSerialize::serialize(x, builder))
            .collect::<Vec<_>>();

        builder.raw_builder().create_vector(&v)
    }
}

#[cfg(test)]
#[path = "../../../tests/unit/flatbuffers/containers/flat_set.rs"]
mod unit_tests;
