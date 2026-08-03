//! Builder for creating flatbuffer with serialized engine.

use std::collections::HashMap;

use flatbuffers::WIPOffset;

use crate::flatbuffers::containers::flat_serialize::FlatBuilder;
use crate::flatbuffers::unsafe_tools::VerifiedFlatbufferMemory;
use crate::utils::Hash;

use super::flat::fb;

#[derive(Default)]
pub(crate) struct EngineFlatBuilder<'a> {
    fb_builder: flatbuffers::FlatBufferBuilder<'a>,
    unique_domains_hashes: Vec<Hash>,
    unique_domains_hashes_map: HashMap<Hash, u32>,
}

impl<'a> EngineFlatBuilder<'a> {
    pub fn get_or_insert_unique_domain_hash(&mut self, h: &Hash) -> u32 {
        if let Some(&index) = self.unique_domains_hashes_map.get(h) {
            return index;
        }
        let index = self.unique_domains_hashes.len() as u32;
        self.unique_domains_hashes.push(*h);
        self.unique_domains_hashes_map.insert(*h, index);
        index
    }

    pub fn finish(
        mut self,
        network_rules: flatbuffers::WIPOffset<
            flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<fb::NetworkFilterList<'a>>>,
        >,
        cosmetic_rules: WIPOffset<fb::CosmeticFilters<'_>>,
        source_info_vec: WIPOffset<
            flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<fb::SourceInfo<'a>>>,
        >,
        debug: bool,
    ) -> VerifiedFlatbufferMemory {
        let unique_domains_hashes =
            Some(self.fb_builder.create_vector(&self.unique_domains_hashes));
        let engine = fb::Engine::create(
            self.raw_builder(),
            &fb::EngineArgs {
                network_rules: Some(network_rules),
                unique_domains_hashes,
                cosmetic_filters: Some(cosmetic_rules),
                debug,
                source_info: Some(source_info_vec),
            },
        );
        self.raw_builder().finish(engine, None);
        VerifiedFlatbufferMemory::from_builder(self.into_raw_builder())
    }
}

impl<'a> FlatBuilder<'a> for EngineFlatBuilder<'a> {
    fn create_string(&mut self, s: &str) -> WIPOffset<&'a str> {
        self.fb_builder.create_string(s)
    }

    fn raw_builder(&mut self) -> &mut flatbuffers::FlatBufferBuilder<'a> {
        &mut self.fb_builder
    }

    fn into_raw_builder(self) -> flatbuffers::FlatBufferBuilder<'a> {
        self.fb_builder
    }
}
