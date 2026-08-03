//! Flatbuffer-compatible versions of [NetworkFilter] and related functionality.

use crate::filters::filter_data_context::FilterDataContext;
use crate::filters::network::{NetworkFilterMask, NetworkFilterMaskHelper, NetworkMatchable};
use crate::flatbuffers::unsafe_tools::fb_vector_to_slice;

use crate::regex_manager::RegexManager;
use crate::request::Request;

use crate::filters::flatbuffer_generated::fb;
use crate::sourcemap::{FilterRuleDebugInfo, SourceLocation};

pub(crate) const NO_SOURCE_LINE_INFO: u32 = u32::MAX;

/// A list of string parts that can be matched against a URL.
pub(crate) enum FlatPatterns<'a> {
    /// No patterns to match
    Empty,
    /// Memory-usage optimization - ~95% of filters have <= 1 pattern. Special-casing avoids the
    /// need to hold an extra pointer and vector length.
    Single(&'a str),
    /// More than 1 pattern to match
    Multi(flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<&'a str>>),
}

impl<'a> FlatPatterns<'a> {
    #[inline(always)]
    pub fn new(
        single_pattern: Option<&'a str>,
        multi_patterns: Option<flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<&'a str>>>,
    ) -> Self {
        if let Some(single_pattern) = single_pattern {
            FlatPatterns::Single(single_pattern)
        } else if let Some(patterns) = multi_patterns {
            FlatPatterns::Multi(patterns)
        } else {
            FlatPatterns::Empty
        }
    }

    #[inline(always)]
    pub fn iter(&self) -> FlatPatternsIterator<'_> {
        FlatPatternsIterator {
            patterns: self,
            index: 0,
        }
    }
}

/// Iterator over [FlatPatterns].
pub(crate) struct FlatPatternsIterator<'a> {
    patterns: &'a FlatPatterns<'a>,
    index: usize,
}

impl<'a> Iterator for FlatPatternsIterator<'a> {
    type Item = &'a str;

    #[inline(always)]
    fn next(&mut self) -> Option<Self::Item> {
        match &self.patterns {
            FlatPatterns::Empty => None,
            FlatPatterns::Single(s) => {
                if self.index == 0 {
                    self.index += 1;
                    Some(*s)
                } else {
                    None
                }
            }
            FlatPatterns::Multi(v) => {
                if self.index < v.len() {
                    let result = v.get(self.index);
                    self.index += 1;
                    Some(result)
                } else {
                    None
                }
            }
        }
    }
}

impl ExactSizeIterator for FlatPatternsIterator<'_> {
    #[inline(always)]
    fn len(&self) -> usize {
        match &self.patterns {
            FlatPatterns::Empty => 0,
            FlatPatterns::Single(_) => 1_usize.saturating_sub(self.index),
            FlatPatterns::Multi(v) => v.len().saturating_sub(self.index),
        }
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
        FlatPatterns::new(
            self.fb_filter.single_pattern(),
            self.fb_filter.multi_patterns(),
        )
    }

    #[inline(always)]
    pub fn raw_line(&self) -> String {
        debug_assert!(
            self.filter_data_context.debug,
            "raw_line is only available in debug mode"
        );
        match self.fb_filter.raw_line() {
            Some(v) => v.to_string(),
            None => {
                debug_assert!(false, "raw_line is not set");
                Default::default()
            }
        }
    }

    #[inline(always)]
    fn source_index(&self) -> Option<u32> {
        if !self.filter_data_context.debug {
            debug_assert!(false, "source_index is only available in debug mode");
            return None;
        }

        let index = self.fb_filter.source_index();
        if index == NO_SOURCE_LINE_INFO {
            None
        } else {
            Some(index)
        }
    }

    #[inline(always)]
    fn line_number(&self) -> Option<u32> {
        if !self.filter_data_context.debug {
            debug_assert!(false, "line_number is only available in debug mode");
            return None;
        }

        let number = self.fb_filter.line_number();
        if number == NO_SOURCE_LINE_INFO {
            None
        } else {
            Some(number)
        }
    }

    fn source_location(&self) -> Option<SourceLocation> {
        let source_index = self.source_index();
        let line_number = self.line_number();

        match (source_index, line_number) {
            (Some(source_index), Some(line_number)) => Some(SourceLocation {
                source_index,
                line_number,
            }),
            (None, None) => None,
            _ => {
                debug_assert!(
                    false,
                    "source_index and line_number should always be available together"
                );
                None
            }
        }
    }

    /// Gets [FilterRuleDebugInfo] corresponding to the original filter rule if debug information
    /// was enabled.
    pub fn get_rule_debug_info(&self) -> Option<FilterRuleDebugInfo> {
        if !self.filter_data_context.debug {
            return None;
        }

        let raw_line = Some(self.raw_line());
        let source_location = self.source_location();

        Some(FilterRuleDebugInfo {
            raw_line,
            source_location,
        })
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
