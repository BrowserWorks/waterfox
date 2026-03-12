/// A HashSet implementation backed by a HashIndex.
/// Uses more memory than FlatSet, but gives faster lookup.
use crate::flatbuffers::containers::{
    fb_index::FbIndex,
    flat_serialize::{FlatBuilder, FlatSerialize, WIPFlatVec},
    hash_index::{FbHashKey, HashIndexBuilder, HashIndexView, HashKey},
};

/// A builder for a HashSet that can be serialized into a flatbuffer.
/// A default value is used to mark empty slots, so it can't be added.
#[derive(Default)]
pub(crate) struct HashSetBuilder<I: HashKey> {
    builder: HashIndexBuilder<I, ()>,
}

impl<I: HashKey> HashSetBuilder<I> {
    pub fn insert(&mut self, key: I) {
        self.builder.insert(key, (), false /* allow_duplicate */);
    }
}

impl<'b, B: FlatBuilder<'b>, I: FlatSerialize<'b, B> + HashKey> FlatSerialize<'b, B>
    for HashSetBuilder<I>
{
    type Output = WIPFlatVec<'b, I, B>;

    fn serialize(value: Self, builder: &mut B) -> Self::Output
    where
        I: FlatSerialize<'b, B>,
    {
        let (indexes, _) = HashIndexBuilder::consume(value.builder);
        let v = indexes
            .into_iter()
            .map(|x| FlatSerialize::serialize(x, builder))
            .collect::<Vec<_>>();
        builder.raw_builder().create_vector(&v)
    }
}

/// A view of a HashSet stored in a flatbuffer.
/// The default value is considered as an empty slot, `contains(default_value)`
/// always returns false.
pub(crate) struct HashSetView<I: FbHashKey, Keys: FbIndex<I>> {
    view: HashIndexView<I, (), Keys, ()>,
}

impl<I: FbHashKey, Keys: FbIndex<I>> HashSetView<I, Keys> {
    pub fn new(keys: Keys) -> Self {
        Self {
            view: HashIndexView::new(keys, ()),
        }
    }

    pub fn contains(&self, key: I) -> bool {
        self.view.get_single(key).is_some()
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.view.len()
    }

    #[cfg(test)]
    pub fn capacity(&self) -> usize {
        self.view.capacity()
    }
}

#[cfg(test)]
#[path = "../../../tests/unit/flatbuffers/containers/hash_set.rs"]
mod unit_tests;
