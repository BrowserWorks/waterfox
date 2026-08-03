//! Holds the implementation of [NetworkFilterList] and related functionality.

use std::{collections::HashSet, fmt};

use flatbuffers::ForwardsUOffset;

use crate::filters::fb_network::FlatNetworkFilter;
use crate::filters::filter_data_context::FilterDataContext;
use crate::filters::flatbuffer_generated::fb;
use crate::filters::network::{NetworkFilterMask, NetworkMatchable};
use crate::flatbuffers::containers::flat_multimap::FlatMultiMapView;
use crate::flatbuffers::unsafe_tools::fb_vector_to_slice;
use crate::regex_manager::RegexManager;
use crate::request::Request;
use crate::sourcemap::FilterRuleDebugInfo;
use crate::utils::{ShortHash, to_short_hash};

/// Holds relevant information from a single matching network filter rule as a result of querying a
/// [NetworkFilterList] for a given request.
pub(crate) struct CheckResult {
    pub filter_mask: NetworkFilterMask,
    pub modifier_option: Option<String>,
    pub debug_data: Option<FilterRuleDebugInfo>,
}

impl fmt::Display for CheckResult {
    fn fmt(&self, f: &mut fmt::Formatter) -> Result<(), fmt::Error> {
        if let Some(ref debug_data) = self.debug_data {
            write!(f, "{debug_data}")
        } else {
            write!(f, "{}", self.filter_mask)
        }
    }
}

/// Internal structure to keep track of a collection of network filters.
pub(crate) struct NetworkFilterList<'a> {
    pub(crate) list: fb::NetworkFilterList<'a>,
    pub(crate) filter_data_context: &'a FilterDataContext,
}

type FlatNetworkFilterMap<'a> =
    FlatMultiMapView<'a, ShortHash, ForwardsUOffset<fb::NetworkFilter<'a>>, &'a [ShortHash]>;

impl NetworkFilterList<'_> {
    pub fn get_filter_map(&self) -> FlatNetworkFilterMap<'_> {
        let filters_list = &self.list;
        FlatNetworkFilterMap::new(
            fb_vector_to_slice(filters_list.filter_map_index()),
            filters_list.filter_map_values(),
        )
    }

    /// Returns the first found filter, if any, that matches the given request. The backing storage
    /// has a non-deterministic order, so this should be used for any category of filters where a
    /// match from each would be functionally equivalent. For example, if two different exception
    /// filters match a certain request, it doesn't matter _which_ one is matched - the request
    /// will be excepted either way.
    pub fn check(
        &self,
        request: &Request,
        active_tags: &HashSet<String>,
        regex_manager: &mut RegexManager,
    ) -> Option<CheckResult> {
        let filters_list = self.list;

        if filters_list.filter_map_index().is_empty() {
            return None;
        }

        let filter_map = self.get_filter_map();

        for token in request.get_tokens_for_match() {
            if let Some(iter) = filter_map.get(to_short_hash(*token)) {
                for fb_filter in iter {
                    let filter = FlatNetworkFilter::new(&fb_filter, self.filter_data_context);

                    // if matched, also needs to be tagged with an active tag (or not tagged at all)
                    if filter.matches(request, regex_manager)
                        && filter.tag().is_none_or(|t| active_tags.contains(t))
                    {
                        return Some(CheckResult {
                            filter_mask: filter.mask,
                            modifier_option: filter.modifier_option(),
                            debug_data: filter.get_rule_debug_info(),
                        });
                    }
                }
            }
        }

        None
    }

    /// Returns _all_ filters that match the given request. This should be used for any category of
    /// filters where a match from each may carry unique information. For example, if two different
    /// `$csp` filters match a certain request, they may each carry a distinct CSP directive, and
    /// each directive should be combined for the final result.
    pub fn check_all(
        &self,
        request: &Request,
        active_tags: &HashSet<String>,
        regex_manager: &mut RegexManager,
    ) -> Vec<CheckResult> {
        let mut filters: Vec<CheckResult> = vec![];

        let filters_list = self.list;

        if filters_list.filter_map_index().is_empty() {
            return filters;
        }

        let filter_map = self.get_filter_map();

        for token in request.get_tokens_for_match() {
            if let Some(iter) = filter_map.get(to_short_hash(*token)) {
                for fb_filter in iter {
                    let filter = FlatNetworkFilter::new(&fb_filter, self.filter_data_context);

                    // if matched, also needs to be tagged with an active tag (or not tagged at all)
                    if filter.matches(request, regex_manager)
                        && filter.tag().is_none_or(|t| active_tags.contains(t))
                    {
                        filters.push(CheckResult {
                            filter_mask: filter.mask,
                            modifier_option: filter.modifier_option(),
                            debug_data: filter.get_rule_debug_info(),
                        });
                    }
                }
            }
        }
        filters
    }
}
