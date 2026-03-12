use flatbuffers::{Vector, WIPOffset};

// A generic builder trait that is used to serialize flatbuffers.
// flatbuffers::FlatBufferBuilder can be used as Builder.
// Although, you can extend it to create a custom builder.
pub trait FlatBuilder<'a> {
    fn create_string(&mut self, s: &str) -> WIPOffset<&'a str>;
    fn raw_builder(&mut self) -> &mut flatbuffers::FlatBufferBuilder<'a>;
}

// The trait to serialize structure into flatbuffer.
// * Implement the traits directly if the structure has a direct representation
//   as a flatbuffer. I.e. for HashSet, Vec, etc.
// * Prefer using implent the traits for MyStruct instead of &MyStruct to
//   prevent cloning. I.e. FlatMultiMapBuilder (wrapping HashMap<I, Vec<V>>).
// * Make MyStructBuilder implement FlatSerialize, if extra work is required
//   during building.
// * Make MyStructBuilder with finish() INSTEAD of implementing FlatSerialize
//   if the output doesn't fit the trait. I.e. FlatMapBuilder, that returns
//   a pair of vectors.
// * Axillary functions (i.e. string deduplication) can be implemented
//   in a custom builder.
pub trait FlatSerialize<'b, B: FlatBuilder<'b>>: Sized {
    type Output: Sized + Clone + flatbuffers::Push + 'b;
    fn serialize(value: Self, builder: &mut B) -> Self::Output;
}

impl<'b> FlatBuilder<'b> for flatbuffers::FlatBufferBuilder<'b> {
    fn create_string(&mut self, s: &str) -> WIPOffset<&'b str> {
        if s.is_empty() {
            flatbuffers::FlatBufferBuilder::create_shared_string(self, s)
        } else {
            flatbuffers::FlatBufferBuilder::create_string(self, s)
        }
    }

    fn raw_builder(&mut self) -> &mut flatbuffers::FlatBufferBuilder<'b> {
        self
    }
}

impl<'b, B: FlatBuilder<'b>> FlatSerialize<'b, B> for String {
    type Output = WIPOffset<&'b str>;
    fn serialize(value: Self, builder: &mut B) -> Self::Output {
        builder.create_string(&value)
    }
}

impl<'b, B: FlatBuilder<'b>> FlatSerialize<'b, B> for &str {
    type Output = WIPOffset<&'b str>;
    fn serialize(value: Self, builder: &mut B) -> Self::Output {
        builder.create_string(value)
    }
}

impl<'b, B: FlatBuilder<'b>> FlatSerialize<'b, B> for u32 {
    type Output = u32;
    fn serialize(value: Self, _builder: &mut B) -> Self::Output {
        value
    }
}

impl<'b, B: FlatBuilder<'b>> FlatSerialize<'b, B> for u64 {
    type Output = u64;
    fn serialize(value: Self, _builder: &mut B) -> Self::Output {
        value
    }
}

impl<'b, B: FlatBuilder<'b>, T: 'b> FlatSerialize<'b, B> for WIPOffset<T> {
    type Output = WIPOffset<T>;
    fn serialize(value: Self, _builder: &mut B) -> Self::Output {
        value
    }
}

pub(crate) type WIPFlatVec<'b, T, B> =
    WIPOffset<Vector<'b, <<T as FlatSerialize<'b, B>>::Output as flatbuffers::Push>::Output>>;

// Serialize a vector of items if T implements FlatSerialize.
// It puts the items first, then puts the vector of offsets.
impl<'b, B: FlatBuilder<'b>, T: FlatSerialize<'b, B>> FlatSerialize<'b, B> for Vec<T> {
    type Output = WIPFlatVec<'b, T, B>;
    fn serialize(value: Self, builder: &mut B) -> Self::Output {
        let v = value
            .into_iter()
            .map(|x| FlatSerialize::serialize(x, builder))
            .collect::<Vec<_>>();
        builder.raw_builder().create_vector(&v)
    }
}

pub(crate) struct FlatMapBuilderOutput<'b, I, V, B: FlatBuilder<'b>>
where
    I: FlatSerialize<'b, B>,
    V: FlatSerialize<'b, B>,
{
    pub(crate) keys: WIPFlatVec<'b, I, B>,
    pub(crate) values: WIPFlatVec<'b, V, B>,
}

// A helper function to serialize a vector of items if T implements FlatSerialize.
// It returns None if the vector is empty, otherwise it returns the vector of offsets.
#[allow(dead_code)] // Unused code is allowed during cosmetic filter migration
pub(crate) fn serialize_vec_opt<'b, B: FlatBuilder<'b>, T: FlatSerialize<'b, B>>(
    value: Vec<T>,
    builder: &mut B,
) -> Option<WIPFlatVec<'b, T, B>> {
    if value.is_empty() {
        None
    } else {
        Some(FlatSerialize::serialize(value, builder))
    }
}
