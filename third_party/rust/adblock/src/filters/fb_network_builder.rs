//! Structures to store network filters to flatbuffer

use std::collections::{HashMap, HashSet};

use flatbuffers::WIPOffset;

use crate::filters::fb_builder::EngineFlatBuilder;
use crate::filters::fb_network::NO_SOURCE_LINE_INFO;
use crate::filters::network::{FilterTokens, NetworkFilter};
use crate::filters::token_selector::TokenSelector;
use crate::utils::TokensBuffer;

use crate::filters::network::NetworkFilterMaskHelper;
use crate::flatbuffers::containers::flat_multimap::FlatMultiMapBuilder;
use crate::flatbuffers::containers::flat_serialize::{FlatBuilder, FlatSerialize};
use crate::optimizer;
use crate::utils::{Hash, ShortHash, to_short_hash};

use super::flat::fb;

pub(crate) enum NetworkFilterListId {
    Csp = 0,
    Exceptions = 1,
    Importants = 2,
    Redirects = 3,
    RemoveParam = 4,
    Filters = 5,
    GenericHide = 6,
    TaggedFiltersAll = 7,
    Size = 8,
}

struct NetworkFilterFlatEntry<'a> {
    filter: WIPOffset<fb::NetworkFilter<'a>>,
    id: Hash,
}

#[derive(Debug, Clone)]
pub(crate) struct NetworkFilterDebugData {
    pub(crate) source_index: u32,
    pub(crate) line_number: u32,
}

impl Default for NetworkFilterDebugData {
    fn default() -> Self {
        Self {
            source_index: NO_SOURCE_LINE_INFO,
            line_number: NO_SOURCE_LINE_INFO,
        }
    }
}

struct NetworkFilterListBuilder<'a, 'f> {
    flat_map_builder: FlatMultiMapBuilder<ShortHash, NetworkFilterFlatEntry<'a>>,
    token_frequencies: TokenSelector,
    filters_to_optimize: HashMap<ShortHash, Vec<NetworkFilter<'f>>>,
    tokens_buffer: TokensBuffer,
    optimize: bool,
}

pub(crate) struct NetworkRulesBuilder<'a, 'f> {
    lists: Vec<NetworkFilterListBuilder<'a, 'f>>,
    bad_filter_ids: HashSet<Hash>,
}

impl<'a, 'f> FlatSerialize<'a, EngineFlatBuilder<'a>>
    for (NetworkFilter<'f>, NetworkFilterDebugData)
{
    type Output = WIPOffset<fb::NetworkFilter<'a>>;

    fn serialize(
        (network_filter, debug_data): (NetworkFilter<'f>, NetworkFilterDebugData),
        builder: &mut EngineFlatBuilder<'a>,
    ) -> WIPOffset<fb::NetworkFilter<'a>> {
        let opt_domains = network_filter.opt_domains.as_ref().map(|v| {
            let mut o: Vec<u32> = v
                .iter()
                .map(|x| builder.get_or_insert_unique_domain_hash(x))
                .collect();
            o.sort_unstable();
            o.dedup();
            FlatSerialize::serialize(o, builder)
        });

        let opt_not_domains = network_filter.opt_not_domains.as_ref().map(|v| {
            let mut o: Vec<u32> = v
                .iter()
                .map(|x| builder.get_or_insert_unique_domain_hash(x))
                .collect();
            o.sort_unstable();
            o.dedup();
            FlatSerialize::serialize(o, builder)
        });

        let modifier_option = network_filter
            .modifier_option
            .map(|s| builder.create_string(s));

        let hostname = network_filter
            .hostname
            .as_ref()
            .map(|s| builder.create_string(s.as_ref()));

        let tag = network_filter.tag.map(|s| builder.create_string(s));

        let mut filter_iter = network_filter.filter.iter();
        let filter_count = filter_iter.len();

        // Use single_pattern for the common case of 0 or 1 patterns to avoid
        // the overhead of a FlatBuffers vector (extra table + offset indirection).
        let (single_pattern, multi_patterns) = if filter_count <= 1 {
            let single = filter_iter.next().map(|s| builder.create_string(s));
            (single, None)
        } else {
            (
                None,
                Some(FlatSerialize::serialize(
                    filter_iter.collect::<Vec<_>>(),
                    builder,
                )),
            )
        };

        let raw_line = network_filter
            .raw_line
            .as_ref()
            .map(|v| builder.create_string(v.as_ref()));

        fb::NetworkFilter::create(
            builder.raw_builder(),
            &fb::NetworkFilterArgs {
                mask: network_filter.mask.bits(),
                single_pattern,
                multi_patterns,
                modifier_option,
                opt_domains,
                opt_not_domains,
                hostname,
                tag,
                raw_line,
                source_index: debug_data.source_index,
                line_number: debug_data.line_number,
            },
        )
    }
}

impl<'a, 'f> NetworkFilterListBuilder<'a, 'f> {
    fn new(optimize: bool) -> Self {
        Self {
            flat_map_builder: FlatMultiMapBuilder::with_capacity(1024),
            token_frequencies: TokenSelector::new(1024),
            filters_to_optimize: HashMap::new(),
            tokens_buffer: TokensBuffer::default(),
            optimize,
        }
    }

    fn add_filter(
        &mut self,
        network_filter: NetworkFilter<'f>,
        debug_data: NetworkFilterDebugData,
        builder: &mut EngineFlatBuilder<'a>,
    ) {
        let multi_tokens = network_filter.get_tokens(&mut self.tokens_buffer);
        let id = network_filter.get_id();

        // Resolve token(s) and record frequencies up-front so the
        // serialized/optimizable branches share no token logic.
        let single_token: Hash;
        let tokens: &[Hash] = match multi_tokens {
            FilterTokens::Empty => {
                // No tokens, add to fallback bucket (token 0)
                &[0]
            }
            FilterTokens::OptDomains => {
                // tokens_buffer has been populated by get_tokens
                self.tokens_buffer.as_slice()
            }
            FilterTokens::Other => {
                single_token = self
                    .token_frequencies
                    .select_least_used_token(self.tokens_buffer.as_slice());
                std::slice::from_ref(&single_token)
            }
        };

        if !self.optimize
            || !optimizer::is_filter_optimizable_by_patterns(&network_filter)
            || multi_tokens != FilterTokens::Empty
        {
            // Serialize now (even if it matches to a bad filter later);
            // Although store the id for later bad-filter pruning.
            let filter = FlatSerialize::serialize((network_filter, debug_data), builder);
            for &token in tokens {
                self.token_frequencies.record_usage(token);
                self.flat_map_builder
                    .insert(to_short_hash(token), NetworkFilterFlatEntry { filter, id });
            }
        } else {
            // Defer serialization to the optimizer
            for &token in tokens {
                self.token_frequencies.record_usage(token);
                self.filters_to_optimize
                    .entry(to_short_hash(token))
                    .or_default()
                    .push(network_filter.clone());
            }
        }
    }
}

impl<'a, 'f> NetworkRulesBuilder<'a, 'f> {
    pub fn new(optimize: bool) -> Self {
        let lists = (0..NetworkFilterListId::Size as usize)
            .map(|list_id| {
                // Don't optimize removeparam, since it can fuse filters without respecting distinct
                let optimize = optimize && list_id != NetworkFilterListId::RemoveParam as usize;
                NetworkFilterListBuilder::new(optimize)
            })
            .collect::<Vec<_>>();
        Self {
            lists,
            bad_filter_ids: HashSet::with_capacity(1024),
        }
    }

    pub fn add_filter(
        &mut self,
        filter: NetworkFilter<'f>,
        debug_data: NetworkFilterDebugData,
        builder: &mut EngineFlatBuilder<'a>,
    ) {
        if filter.is_badfilter() {
            // Note: `get_id()` doesn't include BAD_FILTER bit.
            self.bad_filter_ids.insert(filter.get_id());
            return;
        }

        // Redirects are independent of blocking behavior.
        if filter.is_redirect() {
            self.add_filter_internal(
                filter.clone(),
                debug_data.clone(),
                NetworkFilterListId::Redirects,
                builder,
            );
        }
        type FilterId = NetworkFilterListId;

        let list_id: FilterId = if filter.is_csp() {
            FilterId::Csp
        } else if filter.is_removeparam() {
            FilterId::RemoveParam
        } else if filter.is_generic_hide() {
            FilterId::GenericHide
        } else if filter.is_exception() {
            FilterId::Exceptions
        } else if filter.is_important() {
            FilterId::Importants
        } else if filter.tag.is_some() && !filter.is_redirect() {
            // `tag` + `redirect` is unsupported for now.
            FilterId::TaggedFiltersAll
        } else if (filter.is_redirect() && filter.also_block_redirect()) || !filter.is_redirect() {
            FilterId::Filters
        } else {
            return;
        };

        self.add_filter_internal(filter, debug_data, list_id, builder);
    }

    fn add_filter_internal(
        &mut self,
        network_filter: NetworkFilter<'f>,
        debug_data: NetworkFilterDebugData,
        list_id: NetworkFilterListId,
        builder: &mut EngineFlatBuilder<'a>,
    ) {
        self.lists[list_id as usize].add_filter(network_filter, debug_data, builder);
    }
}

impl<'a> FlatSerialize<'a, EngineFlatBuilder<'a>> for NetworkFilterFlatEntry<'a> {
    type Output = WIPOffset<fb::NetworkFilter<'a>>;

    fn serialize(
        value: Self,
        _builder: &mut EngineFlatBuilder<'a>,
    ) -> WIPOffset<fb::NetworkFilter<'a>> {
        value.filter
    }
}

impl<'a, 'f> FlatSerialize<'a, EngineFlatBuilder<'a>> for NetworkRulesBuilder<'a, 'f> {
    type Output =
        WIPOffset<flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<fb::NetworkFilterList<'a>>>>;

    fn serialize(value: Self, builder: &mut EngineFlatBuilder<'a>) -> Self::Output {
        let mut serialized_lists = vec![];

        for mut rule_list in value.lists {
            if !rule_list.filters_to_optimize.is_empty() {
                // Sort entries for deterministic iteration order.
                let mut optimizable_entries: Vec<_> =
                    rule_list.filters_to_optimize.drain().collect();
                optimizable_entries.sort_unstable_by_key(|(token, _)| *token);

                for (token, mut v) in optimizable_entries {
                    v.retain(|f| !value.bad_filter_ids.contains(&f.get_id()));
                    let optimized = optimizer::optimize(v);

                    for filter in optimized {
                        let id = filter.get_id();
                        let filter =
                            FlatSerialize::serialize((filter, Default::default()), builder);
                        rule_list
                            .flat_map_builder
                            .insert(token, NetworkFilterFlatEntry { filter, id });
                    }
                }
            }

            // Prune already-serialized entries that were cancelled by a $badfilter.
            rule_list
                .flat_map_builder
                .retain_by_value(|entry| !value.bad_filter_ids.contains(&entry.id));

            let flat_filter_map = FlatMultiMapBuilder::finish(rule_list.flat_map_builder, builder);

            serialized_lists.push(fb::NetworkFilterList::create(
                builder.raw_builder(),
                &fb::NetworkFilterListArgs {
                    filter_map_index: Some(flat_filter_map.keys),
                    filter_map_values: Some(flat_filter_map.values),
                },
            ));
        }

        FlatSerialize::serialize(serialized_lists, builder)
    }
}
