/// A HashMap implementation backed by a HashIndex.
/// Uses more memory than FlatMap, but gives faster lookup.
use crate::flatbuffers::containers::{
    fb_index::FbIndex,
    flat_serialize::{FlatBuilder, FlatMapBuilderOutput, FlatSerialize},
    hash_index::{FbHashKey, HashIndexBuilder, HashIndexView, HashKey},
};

/// A builder for a HashMap that can be serialized into a flatbuffer.
/// A default key is used to mark empty slots, so (default_key, _) pair
/// can't be added.
#[derive(Default)]
pub(crate) struct HashMapBuilder<I: HashKey, V: Default + Clone> {
    builder: HashIndexBuilder<I, V>,
}

impl<I: HashKey, V: Default + Clone> HashMapBuilder<I, V> {
    #[allow(unused)]
    pub fn insert(&mut self, key: I, value: V) {
        self.builder.insert(key, value, false /* allow_duplicate */);
    }

    pub fn get_or_insert(&mut self, key: I, value: V) -> &mut V {
        self.builder.get_or_insert(key, value)
    }

    pub fn finish<'b, B: FlatBuilder<'b>>(
        value: Self,
        builder: &mut B,
    ) -> FlatMapBuilderOutput<'b, I, V, B>
    where
        I: FlatSerialize<'b, B>,
        V: FlatSerialize<'b, B>,
    {
        let (indexes, values) = HashIndexBuilder::consume(value.builder);

        let keys = indexes
            .into_iter()
            .map(|i| FlatSerialize::serialize(i, builder))
            .collect::<Vec<_>>();
        let values = values
            .into_iter()
            .map(|v| FlatSerialize::serialize(v, builder))
            .collect::<Vec<_>>();

        let keys = builder.raw_builder().create_vector(&keys);
        let values = builder.raw_builder().create_vector(&values);

        FlatMapBuilderOutput { keys, values }
    }
}

/// A view of a HashMap stored in a flatbuffer.
/// The default key is considered as an empty slot, `get(default_key)` always
/// returns None.
pub(crate) struct HashMapView<I, V, Keys, Values>
where
    I: FbHashKey,
    Keys: FbIndex<I>,
    Values: FbIndex<V>,
{
    view: HashIndexView<I, V, Keys, Values>,
}

impl<I, V, Keys, Values> HashMapView<I, V, Keys, Values>
where
    I: FbHashKey,
    Keys: FbIndex<I>,
    Values: FbIndex<V>,
{
    pub fn new(keys: Keys, values: Values) -> Self {
        assert_eq!(keys.len(), values.len());
        Self {
            view: HashIndexView::new(keys, values),
        }
    }

    pub fn get(&self, key: I) -> Option<V> {
        self.view.get_single(key)
    }

    #[cfg(test)]
    pub fn capacity(&self) -> usize {
        self.view.capacity()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.view.len()
    }
}

pub type HashMapStringView<'a, V> = HashMapView<
    &'a str,
    V,
    flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<&'a str>>,
    flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<<V as flatbuffers::Follow<'a>>::Inner>>,
>;

#[cfg(test)]
#[path = "../../../tests/unit/flatbuffers/containers/hash_map.rs"]
mod unit_tests;
