use std::marker::PhantomData;

use crate::flatbuffers::containers;
use containers::flat_serialize::{FlatBuilder, FlatMapBuilderOutput, FlatSerialize};
use containers::sorted_index::SortedIndex;
use flatbuffers::{Follow, Vector};

pub(crate) struct FlatMapView<'a, I: Ord, V, Keys>
where
    Keys: SortedIndex<I>,
    V: Follow<'a>,
{
    keys: Keys,
    values: Vector<'a, V>,
    _phantom: PhantomData<I>,
}

impl<'a, I: Ord + Copy, V, Keys> FlatMapView<'a, I, V, Keys>
where
    Keys: SortedIndex<I> + Clone,
    V: flatbuffers::Follow<'a>,
{
    pub fn new(keys: Keys, values: Vector<'a, V>) -> Self {
        debug_assert!(keys.len() == values.len());
        Self {
            keys,
            values,
            _phantom: PhantomData,
        }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn get(&self, key: I) -> Option<<V as Follow<'a>>::Inner> {
        let index = self.keys.partition_point(|x| *x < key);
        if index < self.keys.len() && self.keys.get(index) == key {
            Some(self.values.get(index))
        } else {
            None
        }
    }
}

pub(crate) struct FlatMapBuilder;

impl FlatMapBuilder {
    pub fn finish<'a, I, V, B: FlatBuilder<'a>>(
        value: std::collections::HashMap<I, V>,
        builder: &mut B,
    ) -> FlatMapBuilderOutput<'a, I, V, B>
    where
        I: FlatSerialize<'a, B> + Ord,
        V: FlatSerialize<'a, B>,
    {
        let mut entries: Vec<_> = value.into_iter().collect();
        entries.sort_unstable_by(|(a, _), (b, _)| a.cmp(b));

        let mut indexes = Vec::with_capacity(entries.len());
        let mut values = Vec::with_capacity(entries.len());

        for (key, value) in entries.into_iter() {
            indexes.push(FlatSerialize::serialize(key, builder));
            values.push(FlatSerialize::serialize(value, builder));
        }

        FlatMapBuilderOutput {
            keys: builder.raw_builder().create_vector(&indexes),
            values: builder.raw_builder().create_vector(&values),
        }
    }
}

#[cfg(test)]
#[path = "../../../tests/unit/flatbuffers/containers/flat_map.rs"]
mod unit_tests;
