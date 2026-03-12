use crate::flatbuffers::unsafe_tools::VerifiedFlatbufferMemory;
use crate::utils::Hash;
use std::collections::HashMap;

#[cfg(feature = "single-thread")]
pub(crate) type FilterDataContextRef = std::rc::Rc<FilterDataContext>;
#[cfg(not(feature = "single-thread"))]
pub(crate) type FilterDataContextRef = std::sync::Arc<FilterDataContext>;

// The struct is used to store the flatbuffer and supporting data
// for both network filter and cosmetic filters.
// Supposed to be stored via FilterDataContextRef to avoid copying the data.
pub(crate) struct FilterDataContext {
    pub(crate) memory: VerifiedFlatbufferMemory,
    pub(crate) unique_domains_hashes_map: HashMap<Hash, u32>,
}

impl FilterDataContext {
    pub(crate) fn new(memory: VerifiedFlatbufferMemory) -> FilterDataContextRef {
        // Reconstruct the unique_domains_hashes_map from the flatbuffer data
        let root = memory.root();
        let mut unique_domains_hashes_map: HashMap<crate::utils::Hash, u32> = HashMap::new();
        for (index, hash) in root.unique_domains_hashes().iter().enumerate() {
            unique_domains_hashes_map.insert(hash, index as u32);
        }
        FilterDataContextRef::new(Self {
            memory,
            unique_domains_hashes_map,
        })
    }
}
