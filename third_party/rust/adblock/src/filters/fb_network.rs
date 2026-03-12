//! Flatbuffer-compatible versions of [NetworkFilter] and related functionality.

use crate::filters::filter_data_context::FilterDataContext;
use crate::filters::network::{NetworkFilterMask, NetworkFilterMaskHelper, NetworkMatchable};
use crate::flatbuffers::unsafe_tools::fb_vector_to_slice;

use crate::regex_manager::RegexManager;
use crate::request::Request;

use crate::filters::flatbuffer_generated::fb;
/// A list of string parts that can be matched against a URL.
pub(crate) struct FlatPatterns<'a> {
    patterns: Option<flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<&'a str>>>,
}

impl<'a> FlatPatterns<'a> {
    #[inline(always)]
    pub fn new(
        patterns: Option<flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<&'a str>>>,
    ) -> Self {
        Self { patterns }
    }

    #[inline(always)]
    pub fn iter(&self) -> FlatPatternsIterator<'_> {
        FlatPatternsIterator {
            patterns: self,
            len: self.patterns.map_or(0, |d| d.len()),
            index: 0,
        }
    }
}

/// Iterator over [FlatPatterns].
pub(crate) struct FlatPatternsIterator<'a> {
    patterns: &'a FlatPatterns<'a>,
    len: usize,
    index: usize,
}

impl<'a> Iterator for FlatPatternsIterator<'a> {
    type Item = &'a str;

    #[inline(always)]
    fn next(&mut self) -> Option<Self::Item> {
        self.patterns.patterns.and_then(|fi| {
            if self.index < self.len {
                self.index += 1;
                Some(fi.get(self.index - 1))
            } else {
                None
            }
        })
    }
}

impl ExactSizeIterator for FlatPatternsIterator<'_> {
    #[inline(always)]
    fn len(&self) -> usize {
        self.len
    }
}

/// Internal implementation of [NetworkFilter] that is compatible with flatbuffers.
pub(crate) struct FlatNetworkFilter<'a> {
    key: u64,
    filter_data_context: &'a FilterDataContext,
    fb_filter: &'a fb::NetworkFilter<'a>,

    pub(crate) mask: NetworkFilterMask,
}

impl<'a> FlatNetworkFilter<'a> {
    #[inline(always)]
    pub fn new(
        filter: &'a fb::NetworkFilter<'a>,
        filter_data_context: &'a FilterDataContext,
    ) -> Self {
        // Use the flatbuffer relative location as key, it's unique for
        // each filter regardless of the filter list it belongs to.
        let key = filter._tab.loc() as u64;

        Self {
            key,
            fb_filter: filter,
            mask: NetworkFilterMask::from_bits_retain(filter.mask()),
            filter_data_context,
        }
    }

    #[inline(always)]
    pub fn tag(&self) -> Option<&'a str> {
        self.fb_filter.tag()
    }

    #[inline(always)]
    pub fn modifier_option(&self) -> Option<String> {
        self.fb_filter.modifier_option().map(|o| o.to_string())
    }

    #[inline(always)]
    pub fn include_domains(&self) -> Option<&[u32]> {
        self.fb_filter
            .opt_domains()
            .map(|data| fb_vector_to_slice(data))
    }

    #[inline(always)]
    pub fn exclude_domains(&self) -> Option<&[u32]> {
        self.fb_filter
            .opt_not_domains()
            .map(|data| fb_vector_to_slice(data))
    }

    #[inline(always)]
    pub fn hostname(&self) -> Option<&'a str> {
        if self.mask.is_hostname_anchor() {
            self.fb_filter.hostname()
        } else {
            None
        }
    }

    #[inline(always)]
    pub fn patterns(&self) -> FlatPatterns<'_> {
        FlatPatterns::new(self.fb_filter.patterns())
    }

    #[inline(always)]
    pub fn raw_line(&self) -> Option<String> {
        self.fb_filter.raw_line().map(|v| v.to_string())
    }
}

impl NetworkFilterMaskHelper for FlatNetworkFilter<'_> {
    #[inline]
    fn has_flag(&self, v: NetworkFilterMask) -> bool {
        self.mask.contains(v)
    }
}

impl NetworkMatchable for FlatNetworkFilter<'_> {
    fn matches(&self, request: &Request, regex_manager: &mut RegexManager) -> bool {
        use crate::filters::network_matchers::{
            check_excluded_domains_mapped, check_included_domains_mapped, check_options,
            check_pattern,
        };
        if !check_options(self.mask, request) {
            return false;
        }
        if !check_included_domains_mapped(
            self.include_domains(),
            request,
            &self.filter_data_context.unique_domains_hashes_map,
        ) {
            return false;
        }
        if !check_excluded_domains_mapped(
            self.exclude_domains(),
            request,
            &self.filter_data_context.unique_domains_hashes_map,
        ) {
            return false;
        }
        check_pattern(
            self.mask,
            self.patterns().iter(),
            self.hostname(),
            self.key,
            request,
            regex_manager,
        )
    }
}
