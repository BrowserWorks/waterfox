//! Structures to store network filters to flatbuffer

use std::collections::{HashMap, HashSet};

use flatbuffers::WIPOffset;

use crate::filters::fb_builder::EngineFlatBuilder;
use crate::filters::network::{FilterTokens, NetworkFilter};
use crate::filters::token_selector::TokenSelector;
use crate::utils::TokensBuffer;

use crate::filters::network::NetworkFilterMaskHelper;
use crate::flatbuffers::containers::flat_multimap::FlatMultiMapBuilder;
use crate::flatbuffers::containers::flat_serialize::{FlatBuilder, FlatSerialize, WIPFlatVec};
use crate::optimizer;
use crate::utils::{to_short_hash, Hash, ShortHash};

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

#[derive(Default, Clone)]
pub(crate) struct NetworkFilterListBuilder {
    filters: Vec<NetworkFilter>,
    optimize: bool,
}

pub(crate) struct NetworkRulesBuilder {
    lists: Vec<NetworkFilterListBuilder>,
}

impl<'a> FlatSerialize<'a, EngineFlatBuilder<'a>> for &NetworkFilter {
    type Output = WIPOffset<fb::NetworkFilter<'a>>;

    fn serialize(
        network_filter: &NetworkFilter,
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
            .as_ref()
            .map(|s| builder.create_string(s));

        let hostname = network_filter
            .hostname
            .as_ref()
            .map(|s| builder.create_string(s));

        let tag = network_filter
            .tag
            .as_ref()
            .map(|s| builder.create_string(s));

        let patterns = if network_filter.filter.iter().len() > 0 {
            let offsets: Vec<WIPOffset<&str>> = network_filter
                .filter
                .iter()
                .map(|s| builder.create_string(s))
                .collect();
            Some(FlatSerialize::serialize(offsets, builder))
        } else {
            None
        };

        let raw_line = network_filter
            .raw_line
            .as_ref()
            .map(|v| builder.create_string(v.as_str()));

        let network_filter = fb::NetworkFilter::create(
            builder.raw_builder(),
            &fb::NetworkFilterArgs {
                mask: network_filter.mask.bits(),
                patterns,
                modifier_option,
                opt_domains,
                opt_not_domains,
                hostname,
                tag,
                raw_line,
            },
        );

        network_filter
    }
}

impl NetworkFilterListBuilder {
    fn new(optimize: bool) -> Self {
        Self {
            filters: vec![],
            optimize,
        }
    }
}

impl<'a> FlatSerialize<'a, EngineFlatBuilder<'a>> for NetworkFilterListBuilder {
    type Output = WIPOffset<fb::NetworkFilterList<'a>>;
    fn serialize(
        rule_list: Self,
        builder: &mut EngineFlatBuilder<'a>,
    ) -> WIPOffset<fb::NetworkFilterList<'a>> {
        let mut filter_map_builder = FlatMultiMapBuilder::with_capacity(rule_list.filters.len());

        let mut optimizable = HashMap::<ShortHash, Vec<NetworkFilter>>::new();

        let mut token_frequencies = TokenSelector::new(rule_list.filters.len());
        let mut tokens_buffer = TokensBuffer::default();

        {
            for network_filter in rule_list.filters {
                let flat_filter = if !rule_list.optimize
                    || !optimizer::is_filter_optimizable_by_patterns(&network_filter)
                {
                    Some(FlatSerialize::serialize(&network_filter, builder))
                } else {
                    None
                };

                let mut store_filter = |token: Hash| {
                    let short_token = to_short_hash(token);
                    if let Some(flat_filter) = flat_filter {
                        filter_map_builder.insert(short_token, flat_filter);
                    } else {
                        optimizable
                            .entry(short_token)
                            .or_default()
                            .push(network_filter.clone());
                    }
                };

                let multi_tokens = network_filter.get_tokens(&mut tokens_buffer);
                match multi_tokens {
                    FilterTokens::Empty => {
                        // No tokens, add to fallback bucket (token 0)
                        store_filter(0);
                    }
                    FilterTokens::OptDomains(opt_domains) => {
                        // For OptDomains, each domain is treated as a separate token group
                        for &token in opt_domains.iter() {
                            store_filter(token);
                            token_frequencies.record_usage(token);
                        }
                    }
                    FilterTokens::Other(tokens) => {
                        let best_token = token_frequencies.select_least_used_token(tokens);
                        token_frequencies.record_usage(best_token);
                        store_filter(best_token);
                    }
                }
            }
        }

        if rule_list.optimize {
            // Sort the entries to ensure deterministic iteration order
            let mut optimizable_entries: Vec<_> = optimizable.drain().collect();
            optimizable_entries.sort_unstable_by_key(|(token, _)| *token);

            for (token, v) in optimizable_entries {
                let optimized = optimizer::optimize(v);

                for filter in optimized {
                    let flat_filter = FlatSerialize::serialize(&filter, builder);
                    filter_map_builder.insert(token, flat_filter);
                }
            }
        } else {
            debug_assert!(
                optimizable.is_empty(),
                "Should be empty if optimization is off"
            );
        }

        let flat_filter_map = FlatMultiMapBuilder::finish(filter_map_builder, builder);

        fb::NetworkFilterList::create(
            builder.raw_builder(),
            &fb::NetworkFilterListArgs {
                filter_map_index: Some(flat_filter_map.keys),
                filter_map_values: Some(flat_filter_map.values),
            },
        )
    }
}

impl NetworkRulesBuilder {
    pub fn from_rules(network_filters: Vec<NetworkFilter>, optimize: bool) -> Self {
        let mut lists = vec![];
        for list_id in 0..NetworkFilterListId::Size as usize {
            // Don't optimize removeparam, since it can fuse filters without respecting distinct
            let optimize = optimize && list_id != NetworkFilterListId::RemoveParam as usize;
            lists.push(NetworkFilterListBuilder::new(optimize));
        }
        let mut self_ = Self { lists };

        let mut badfilter_ids: HashSet<Hash> = HashSet::new();

        // Collect badfilter ids in advance.
        for filter in network_filters.iter() {
            if filter.is_badfilter() {
                badfilter_ids.insert(filter.get_id_without_badfilter());
            }
        }

        for filter in network_filters.into_iter() {
            // skip any bad filters
            let filter_id = filter.get_id();
            if badfilter_ids.contains(&filter_id) || filter.is_badfilter() {
                continue;
            }

            // Redirects are independent of blocking behavior.
            if filter.is_redirect() {
                self_.add_filter(filter.clone(), NetworkFilterListId::Redirects);
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
            } else if (filter.is_redirect() && filter.also_block_redirect())
                || !filter.is_redirect()
            {
                FilterId::Filters
            } else {
                continue;
            };

            self_.add_filter(filter, list_id);
        }

        self_
    }

    fn add_filter(&mut self, network_filter: NetworkFilter, list_id: NetworkFilterListId) {
        self.lists[list_id as usize].filters.push(network_filter);
    }
}

impl<'a> FlatSerialize<'a, EngineFlatBuilder<'a>> for NetworkRulesBuilder {
    type Output = WIPFlatVec<'a, NetworkFilterListBuilder, EngineFlatBuilder<'a>>;
    fn serialize(value: Self, builder: &mut EngineFlatBuilder<'a>) -> Self::Output {
        FlatSerialize::serialize(value.lists, builder)
    }
}
