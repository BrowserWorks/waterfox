//! Compiled regexes can take up large amounts of memory. To reduce the overall memory footprint of
//! the [`crate::Engine`], infrequently used regexes can be discarded. The [`RegexManager`] is
//! responsible for managing the storage of regexes used by filters.

use crate::filters::network::{NetworkFilterMask, NetworkFilterMaskHelper};

use regex::{
    bytes::Regex as BytesRegex, bytes::RegexBuilder as BytesRegexBuilder,
    bytes::RegexSet as BytesRegexSet, bytes::RegexSetBuilder as BytesRegexSetBuilder, Regex,
};

use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

#[cfg(test)]
#[cfg(not(target_arch = "wasm32"))]
use mock_instant::thread_local::Instant;
#[cfg(not(test))]
#[cfg(not(target_arch = "wasm32"))]
use std::time::Instant;

#[cfg(target_arch = "wasm32")]
#[derive(Clone, Copy)]
pub struct Instant;
#[cfg(target_arch = "wasm32")]
impl Instant {
    pub fn now() -> Self {
        Self
    }
}

/// `*const NetworkFilter` could technically leak across threads through `RegexDebugEntry::id`, but
/// it's disguised as a unique identifier and not intended to be dereferenced.
unsafe impl Send for RegexManager {}

const DEFAULT_CLEAN_UP_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_DISCARD_UNUSED_TIME: Duration = Duration::from_secs(180);

/// Reports [`RegexManager`] metrics that may be useful for creating an optimized
/// [`RegexManagerDiscardPolicy`].
#[cfg(feature = "debug-info")]
pub struct RegexDebugInfo {
    /// Information about each regex contained in the [`RegexManager`].
    pub regex_data: Vec<RegexDebugEntry>,
    /// Total count of compiled regexes.
    pub compiled_regex_count: usize,
}

/// Describes metrics about a single regex from the [`RegexManager`].
#[cfg(feature = "debug-info")]
pub struct RegexDebugEntry {
    /// Id for this particular regex, which is constant and unique for its lifetime.
    ///
    /// Note that there are no guarantees about a particular id's constancy or uniqueness beyond
    /// the lifetime of a corresponding regex.
    pub id: u64,
    /// A string representation of this regex, if available. It may be `None` if the regex has been
    /// cleaned up to conserve memory.
    pub regex: Option<String>,
    /// When this regex was last used.
    pub last_used: Instant,
    /// How many times this regex has been used.
    pub usage_count: usize,
}

#[derive(Debug, Clone)]
pub enum CompiledRegex {
    Compiled(BytesRegex),
    CompiledSet(BytesRegexSet),
    MatchAll,
    RegexParsingError(regex::Error),
}

impl CompiledRegex {
    pub fn is_match(&self, pattern: &str) -> bool {
        match &self {
            CompiledRegex::MatchAll => true, // simple case for matching everything, e.g. for empty filter
            CompiledRegex::RegexParsingError(_e) => false, // no match if regex didn't even compile
            CompiledRegex::Compiled(r) => r.is_match(pattern.as_bytes()),
            CompiledRegex::CompiledSet(r) => {
                // let matches: Vec<_> = r.matches(pattern).into_iter().collect();
                // println!("Matching {} against RegexSet: {:?}", pattern, matches);
                r.is_match(pattern.as_bytes())
            }
        }
    }
}

impl fmt::Display for CompiledRegex {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        match &self {
            CompiledRegex::MatchAll => write!(f, ".*"), // simple case for matching everything, e.g. for empty filter
            CompiledRegex::RegexParsingError(_e) => write!(f, "ERROR"), // no match if regex didn't even compile
            CompiledRegex::Compiled(r) => write!(f, "{}", r.as_str()),
            CompiledRegex::CompiledSet(r) => write!(f, "{}", r.patterns().join(" | ")),
        }
    }
}

struct RegexEntry {
    regex: Option<CompiledRegex>,
    last_used: Instant,
    usage_count: usize,
}

/// Used for customization of regex discarding behavior in the [`RegexManager`].
pub struct RegexManagerDiscardPolicy {
    /// The [`RegexManager`] will check for and cleanup unused filters on this interval.
    pub cleanup_interval: Duration,
    /// The [`RegexManager`] will discard a regex if it hasn't been used for this much time.
    pub discard_unused_time: Duration,
}

impl Default for RegexManagerDiscardPolicy {
    fn default() -> Self {
        Self {
            cleanup_interval: DEFAULT_CLEAN_UP_INTERVAL,
            discard_unused_time: DEFAULT_DISCARD_UNUSED_TIME,
        }
    }
}

type RandomState = std::hash::BuildHasherDefault<seahash::SeaHasher>;

/// A manager that creates and stores all regular expressions used by filters.
/// Rarely used entries are discarded to save memory.
///
/// The [`RegexManager`] is not thread safe, so any access to it must be synchronized externally.
pub struct RegexManager {
    map: HashMap<u64, RegexEntry, RandomState>,
    compiled_regex_count: usize,
    now: Instant,
    #[cfg_attr(target_arch = "wasm32", allow(unused))]
    last_cleanup: Instant,
    discard_policy: RegexManagerDiscardPolicy,
}

impl Default for RegexManager {
    fn default() -> Self {
        Self {
            map: Default::default(),
            compiled_regex_count: 0,
            now: Instant::now(),
            last_cleanup: Instant::now(),
            discard_policy: Default::default(),
        }
    }
}

fn make_regexp<'a, FiltersIter>(mask: NetworkFilterMask, filters: FiltersIter) -> CompiledRegex
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    compile_regex(
        filters,
        mask.is_right_anchor(),
        mask.is_left_anchor(),
        mask.is_complete_regex(),
    )
}

/// Compiles a filter pattern to a regex. This is only performed *lazily* for
/// filters containing at least a * or ^ symbol. Because Regexes are expansive,
/// we try to convert some patterns to plain filters.
#[allow(clippy::trivial_regex)]
pub(crate) fn compile_regex<'a, I>(
    filters: I,
    is_right_anchor: bool,
    is_left_anchor: bool,
    is_complete_regex: bool,
) -> CompiledRegex
where
    I: Iterator<Item = &'a str> + ExactSizeIterator,
{
    use once_cell::sync::Lazy;
    // Escape special regex characters: |.$+?{}()[]\
    static SPECIAL_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r"([\|\.\$\+\?\{\}\(\)\[\]])").unwrap());
    // * can match anything
    static WILDCARD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\*").unwrap());
    // ^ can match any separator or the end of the pattern
    static ANCHOR_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\^(.)").unwrap());
    // ^ can match any separator or the end of the pattern
    static ANCHOR_RE_EOL: Lazy<Regex> = Lazy::new(|| Regex::new(r"\^$").unwrap());

    let mut escaped_patterns = Vec::with_capacity(filters.len());
    for filter_str in filters {
        // If any filter is empty, the entire set matches anything
        if filter_str.is_empty() {
            return CompiledRegex::MatchAll;
        }
        if is_complete_regex {
            // unescape unrecognised escaping sequences, otherwise a normal regex
            let unescaped = filter_str[1..filter_str.len() - 1]
                .replace("\\/", "/")
                .replace("\\:", ":");

            escaped_patterns.push(unescaped);
        } else {
            let repl = SPECIAL_RE.replace_all(filter_str, "\\$1");
            let repl = WILDCARD_RE.replace_all(&repl, ".*");
            // in adblock rules, '^' is a separator.
            // The separator character is anything but a letter, a digit, or one of the following: _ - . %
            let repl = ANCHOR_RE.replace_all(&repl, "(?:[^\\w\\d\\._%-])$1");
            let repl = ANCHOR_RE_EOL.replace_all(&repl, "(?:[^\\w\\d\\._%-]|$)");

            // Should match start or end of url
            let left_anchor = if is_left_anchor { "^" } else { "" };
            let right_anchor = if is_right_anchor { "$" } else { "" };
            let filter = format!("{left_anchor}{repl}{right_anchor}");

            escaped_patterns.push(filter);
        }
    }

    if escaped_patterns.is_empty() {
        CompiledRegex::MatchAll
    } else if escaped_patterns.len() == 1 {
        let pattern = &escaped_patterns[0];
        match BytesRegexBuilder::new(pattern).unicode(false).build() {
            Ok(compiled) => CompiledRegex::Compiled(compiled),
            Err(e) => {
                // println!("Regex parsing failed ({:?})", e);
                CompiledRegex::RegexParsingError(e)
            }
        }
    } else {
        match BytesRegexSetBuilder::new(escaped_patterns)
            .unicode(false)
            .build()
        {
            Ok(compiled) => CompiledRegex::CompiledSet(compiled),
            Err(e) => CompiledRegex::RegexParsingError(e),
        }
    }
}

impl RegexManager {
    /// Check whether or not a regex network filter matches a certain URL pattern, using the
    /// [`RegexManager`]'s managed regex storage.
    pub fn matches<'a, FiltersIter>(
        &mut self,
        mask: NetworkFilterMask,
        filters: FiltersIter,
        key: u64,
        pattern: &str,
    ) -> bool
    where
        FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
    {
        if !mask.is_regex() && !mask.is_complete_regex() {
            return true;
        }
        use std::collections::hash_map::Entry;
        match self.map.entry(key) {
            Entry::Occupied(mut e) => {
                let v = e.get_mut();
                v.usage_count += 1;
                v.last_used = self.now;
                if v.regex.is_none() {
                    // A discarded entry, recreate it:
                    v.regex = Some(make_regexp(mask, filters));
                    self.compiled_regex_count += 1;
                }
                v.regex.as_ref().unwrap().is_match(pattern)
            }
            Entry::Vacant(e) => {
                self.compiled_regex_count += 1;
                let new_entry = RegexEntry {
                    regex: Some(make_regexp(mask, filters)),
                    last_used: self.now,
                    usage_count: 1,
                };
                e.insert(new_entry)
                    .regex
                    .as_ref()
                    .unwrap()
                    .is_match(pattern)
            }
        }
    }

    /// The [`RegexManager`] is just a struct and doesn't manage any worker threads, so this method
    /// must be called periodically to ensure that it can track usage patterns of regexes over
    /// time. This method will handle periodically discarding filters if necessary.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn update_time(&mut self) {
        self.now = Instant::now();
        if !self.discard_policy.cleanup_interval.is_zero()
            && self.now - self.last_cleanup >= self.discard_policy.cleanup_interval
        {
            self.last_cleanup = self.now;
            self.cleanup();
        }
    }

    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn cleanup(&mut self) {
        let now = self.now;
        for v in self.map.values_mut() {
            if now - v.last_used >= self.discard_policy.discard_unused_time {
                // Discard the regex to save memory.
                v.regex = None;
            }
        }
    }

    /// Customize the discard behavior of this [`RegexManager`].
    pub fn set_discard_policy(&mut self, new_discard_policy: RegexManagerDiscardPolicy) {
        self.discard_policy = new_discard_policy;
    }

    /// Discard one regex, identified by its id from a [`RegexDebugEntry`].
    #[cfg(feature = "debug-info")]
    pub fn discard_regex(&mut self, regex_id: u64) {
        self.map
            .iter_mut()
            .filter(|(k, _)| { **k } == regex_id)
            .for_each(|(_, v)| {
                v.regex = None;
            });
    }

    #[cfg(feature = "debug-info")]
    pub(crate) fn get_debug_regex_data(&self) -> Vec<RegexDebugEntry> {
        use itertools::Itertools;
        self.map
            .iter()
            .map(|(k, e)| RegexDebugEntry {
                id: { *k },
                regex: e.regex.as_ref().map(|x| x.to_string()),
                last_used: e.last_used,
                usage_count: e.usage_count,
            })
            .collect_vec()
    }

    #[cfg(feature = "debug-info")]
    pub(crate) fn get_compiled_regex_count(&self) -> usize {
        self.compiled_regex_count
    }

    /// Collect metrics that may be useful for creating an optimized [`RegexManagerDiscardPolicy`].
    #[cfg(feature = "debug-info")]
    pub fn get_debug_info(&self) -> RegexDebugInfo {
        RegexDebugInfo {
            regex_data: self.get_debug_regex_data(),
            compiled_regex_count: self.get_compiled_regex_count(),
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/regex_manager.rs"]
mod unit_tests;
