use flatbuffers::{Follow, Vector};

use crate::flatbuffers::containers::fb_index::FbIndex;

// Represents sorted sequence to perform the binary search.
pub(crate) trait SortedIndex<I>: FbIndex<I> {
    fn partition_point<F>(&self, predicate: F) -> usize
    where
        F: FnMut(&I) -> bool;
}

// Implementation for slices. Prefer using this with fb_vector_to_slice
// if possible, because it faster than getting values with flatbuffer's
// get method.
impl<I: Ord + Copy> SortedIndex<I> for &[I] {
    #[inline(always)]
    fn partition_point<F>(&self, predicate: F) -> usize
    where
        F: FnMut(&I) -> bool,
    {
        debug_assert!(self.is_sorted());
        <[I]>::partition_point(self, predicate)
    }
}

// General implementation for flatbuffers::Vector, it uses get to
// obtain values.
impl<'a, T: Follow<'a>> SortedIndex<T::Inner> for Vector<'a, T>
where
    T::Inner: Ord,
{
    fn partition_point<F>(&self, mut predicate: F) -> usize
    where
        F: FnMut(&T::Inner) -> bool,
    {
        debug_assert!(self.iter().is_sorted());

        let mut left = 0;
        let mut right = self.len();

        while left < right {
            let mid = left + (right - left) / 2;
            let value = self.get(mid);
            if predicate(&value) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        left
    }
}
