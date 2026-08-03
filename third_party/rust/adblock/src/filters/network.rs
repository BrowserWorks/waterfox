//! Filters that take effect at the network request level, including blocking and response
//! modification.

use memchr::memchr as find_char;
use regex::Regex;
use rustc_hash::FxHasher;
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::hash::Hasher;
use std::sync::LazyLock;
use thiserror::Error;

use std::fmt;

use crate::filters::abstract_network::{
    AbstractNetworkFilter, HttpMethod, NetworkFilterLeftAnchor, NetworkFilterOption,
    NetworkFilterRightAnchor,
};
use crate::lists::ParseOptions;
use crate::regex_manager::RegexManager;
use crate::request;
use crate::utils::{self, Hash, TokensBuffer};

/// For now, only support `$removeparam` with simple alphanumeric/dash/underscore patterns.
static VALID_PARAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_\-]+$").unwrap());

bitflags::bitflags! {
  /// Features that are properties used to classify the filter, but not stored
  /// in the flatbuffer serialized format. For that reason, not available
  /// for FlatNetworkFilter (use NetworkFilterMask instead).
  #[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Default)]
  pub struct NetworkFilterFeaturesMask: u32 {
    const BAD_FILTER = 1 << 0;
    const IS_REMOVEPARAM = 1 << 1;
    const GENERIC_HIDE = 1 << 2;
    const IS_CSP = 1 << 3;
    const IS_REDIRECT = 1 << 4;

    /// Specifies that a redirect rule should also create a corresponding block rule.
    /// This is used to avoid returning two separate rules from `NetworkFilter::parse`.
    const ALSO_BLOCK_REDIRECT = 1 << 5;
  }
}

#[non_exhaustive]
#[derive(Debug, Error, PartialEq, Clone)]
pub enum NetworkFilterError {
    #[error("failed to parse filter")]
    FilterParseError,
    #[error("negated badfilter option")]
    NegatedBadFilter,
    #[error("negated important")]
    NegatedImportant,
    #[error("negated match-case")]
    NegatedOptionMatchCase,
    #[error("negated explicitcancel")]
    NegatedExplicitCancel,
    #[error("negated redirection")]
    NegatedRedirection,
    #[error("negated tag")]
    NegatedTag,
    #[error("negated generichide")]
    NegatedGenericHide,
    #[error("negated document")]
    NegatedDocument,
    #[error("negated all")]
    NegatedAll,
    #[error("generichide without exception")]
    GenericHideWithoutException,
    #[error("method with generichide")]
    MethodWithGenerichide,
    #[error("empty redirection")]
    EmptyRedirection,
    #[error("empty removeparam")]
    EmptyRemoveparam,
    #[error("negated removeparam")]
    NegatedRemoveparam,
    #[error("removeparam with exception")]
    RemoveparamWithException,
    #[error("removeparam regex unsupported")]
    RemoveparamRegexUnsupported,
    #[error("redirection url invalid")]
    RedirectionUrlInvalid,
    #[error("multiple modifier options")]
    MultipleModifierOptions,
    #[error("unrecognised option")]
    UnrecognisedOption,
    #[error("no regex")]
    NoRegex,
    #[error("full regex unsupported")]
    FullRegexUnsupported,
    #[error("regex parsing error")]
    RegexParsingError(regex::Error),
    #[error("punycode error")]
    PunycodeError,
    #[error("csp with content type")]
    CspWithContentType,
    #[error("match-case without full regex")]
    MatchCaseWithoutFullRegex,
    #[error("no supported domains")]
    NoSupportedDomains,
}

bitflags::bitflags! {
    #[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq)]
    #[serde(transparent)]
    pub struct NetworkFilterMask: u32 {
        const FROM_IMAGE = 1; // 1 << 0;
        const FROM_MEDIA = 1 << 1;
        const FROM_OBJECT = 1 << 2;
        const FROM_OTHER = 1 << 3;
        const FROM_PING = 1 << 4;
        const FROM_SCRIPT = 1 << 5;
        const FROM_STYLESHEET = 1 << 6;
        const FROM_SUBDOCUMENT = 1 << 7;
        const FROM_WEBSOCKET = 1 << 8; // e.g.: ws, ws
        const FROM_XMLHTTPREQUEST = 1 << 9;
        const FROM_FONT = 1 << 10;
        const FROM_HTTP = 1 << 11;
        const FROM_HTTPS = 1 << 12;
        const IS_IMPORTANT = 1 << 13;
        const MATCH_CASE = 1 << 14;
        const THIRD_PARTY = 1 << 16;
        const FIRST_PARTY = 1 << 17;
        // Full document rules are not implied by negated types.
        const FROM_DOCUMENT = 1 << 29;

        // Kind of pattern
        const IS_REGEX = 1 << 18;
        const IS_LEFT_ANCHOR = 1 << 19;
        const IS_RIGHT_ANCHOR = 1 << 20;
        const IS_HOSTNAME_ANCHOR = 1 << 21;
        const IS_EXCEPTION = 1 << 22;
        const IS_COMPLETE_REGEX = 1 << 24;
        const IS_HOSTNAME_REGEX = 1 << 28;

        // "Other" network request types
        const UNMATCHED = 1 << 25;

        const FROM_GET = 1 << 26;
        const FROM_HEAD = 1 << 27;
        const FROM_POST = 1 << 30;

        const FROM_ANY_METHODS = Self::FROM_GET.bits() |
            Self::FROM_HEAD.bits() |
            Self::FROM_POST.bits();

        // Includes all request types that are implied by any negated types.
        const FROM_NETWORK_TYPES = Self::FROM_FONT.bits() |
            Self::FROM_IMAGE.bits() |
            Self::FROM_MEDIA.bits() |
            Self::FROM_OBJECT.bits() |
            Self::FROM_OTHER.bits() |
            Self::FROM_PING.bits() |
            Self::FROM_SCRIPT.bits() |
            Self::FROM_STYLESHEET.bits() |
            Self::FROM_SUBDOCUMENT.bits() |
            Self::FROM_WEBSOCKET.bits() |
            Self::FROM_XMLHTTPREQUEST.bits();

        // Includes all remaining types, not implied by any negated types.
        // TODO Could also include popup, inline-font, inline-script
        const FROM_ALL_TYPES = Self::FROM_NETWORK_TYPES.bits() |
            Self::FROM_DOCUMENT.bits();

        // Unless filter specifies otherwise, all these options are set by default
        const DEFAULT_OPTIONS = Self::FROM_NETWORK_TYPES.bits() |
            Self::FROM_HTTP.bits() |
            Self::FROM_HTTPS.bits() |
            Self::THIRD_PARTY.bits() |
            Self::FIRST_PARTY.bits();

        // Careful with checking for NONE - will always match
        const NONE = 0;
    }
}

impl NetworkFilterMask {
    #[inline]
    pub(crate) fn check_method_allowed(self, method: Option<&request::RequestMethod>) -> bool {
        if !self.intersects(Self::FROM_ANY_METHODS) {
            return true;
        }
        let Some(method) = method else {
            return false;
        };
        let method_mask = Self::from(method);
        if method_mask.is_empty() {
            return false;
        }
        self.contains(method_mask)
    }
}

pub trait NetworkFilterMaskHelper {
    fn has_flag(&self, v: NetworkFilterMask) -> bool;

    #[inline]
    fn is_exception(&self) -> bool {
        self.has_flag(NetworkFilterMask::IS_EXCEPTION)
    }

    #[inline]
    fn is_hostname_anchor(&self) -> bool {
        self.has_flag(NetworkFilterMask::IS_HOSTNAME_ANCHOR)
    }

    #[inline]
    fn is_right_anchor(&self) -> bool {
        self.has_flag(NetworkFilterMask::IS_RIGHT_ANCHOR)
    }

    #[inline]
    fn is_left_anchor(&self) -> bool {
        self.has_flag(NetworkFilterMask::IS_LEFT_ANCHOR)
    }

    #[inline]
    fn match_case(&self) -> bool {
        self.has_flag(NetworkFilterMask::MATCH_CASE)
    }

    #[inline]
    fn is_important(&self) -> bool {
        self.has_flag(NetworkFilterMask::IS_IMPORTANT)
    }

    #[inline]
    fn is_regex(&self) -> bool {
        self.has_flag(NetworkFilterMask::IS_REGEX)
    }

    #[inline]
    fn is_complete_regex(&self) -> bool {
        self.has_flag(NetworkFilterMask::IS_COMPLETE_REGEX)
    }

    #[inline]
    fn is_plain(&self) -> bool {
        !self.is_regex()
    }

    #[inline]
    fn third_party(&self) -> bool {
        self.has_flag(NetworkFilterMask::THIRD_PARTY)
    }

    #[inline]
    fn first_party(&self) -> bool {
        self.has_flag(NetworkFilterMask::FIRST_PARTY)
    }

    #[inline]
    fn for_http(&self) -> bool {
        self.has_flag(NetworkFilterMask::FROM_HTTP)
    }

    #[inline]
    fn for_https(&self) -> bool {
        self.has_flag(NetworkFilterMask::FROM_HTTPS)
    }

    #[inline]
    fn check_cpt_allowed(&self, cpt: &request::RequestType) -> bool {
        match NetworkFilterMask::from(cpt) {
            // TODO this is not ideal, but required to allow regexed exception rules without an
            // explicit `$document` option to apply uBO-style.
            // See also: https://github.com/uBlockOrigin/uBlock-issues/issues/1501
            NetworkFilterMask::FROM_DOCUMENT => {
                self.has_flag(NetworkFilterMask::FROM_DOCUMENT) || self.is_exception()
            }
            mask => self.has_flag(mask),
        }
    }
}

impl NetworkFilterMaskHelper for NetworkFilterMask {
    #[inline]
    fn has_flag(&self, v: NetworkFilterMask) -> bool {
        self.contains(v)
    }
}

impl fmt::Display for NetworkFilterMask {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "{:b}", &self)
    }
}

impl From<&request::RequestMethod> for NetworkFilterMask {
    fn from(method: &request::RequestMethod) -> NetworkFilterMask {
        match method {
            request::RequestMethod::Get => NetworkFilterMask::FROM_GET,
            request::RequestMethod::Head => NetworkFilterMask::FROM_HEAD,
            request::RequestMethod::Post => NetworkFilterMask::FROM_POST,
            _ => NetworkFilterMask::NONE,
        }
    }
}

impl From<&request::RequestType> for NetworkFilterMask {
    fn from(request_type: &request::RequestType) -> NetworkFilterMask {
        match request_type {
            request::RequestType::Beacon => NetworkFilterMask::FROM_PING,
            request::RequestType::Csp => NetworkFilterMask::UNMATCHED,
            request::RequestType::Document => NetworkFilterMask::FROM_DOCUMENT,
            request::RequestType::Dtd => NetworkFilterMask::FROM_OTHER,
            request::RequestType::Fetch => NetworkFilterMask::FROM_OTHER,
            request::RequestType::Font => NetworkFilterMask::FROM_FONT,
            request::RequestType::Image => NetworkFilterMask::FROM_IMAGE,
            request::RequestType::Media => NetworkFilterMask::FROM_MEDIA,
            request::RequestType::Object => NetworkFilterMask::FROM_OBJECT,
            request::RequestType::Other => NetworkFilterMask::FROM_OTHER,
            request::RequestType::Ping => NetworkFilterMask::FROM_PING,
            request::RequestType::Script => NetworkFilterMask::FROM_SCRIPT,
            request::RequestType::Stylesheet => NetworkFilterMask::FROM_STYLESHEET,
            request::RequestType::Subdocument => NetworkFilterMask::FROM_SUBDOCUMENT,
            request::RequestType::Websocket => NetworkFilterMask::FROM_WEBSOCKET,
            request::RequestType::Xlst => NetworkFilterMask::FROM_OTHER,
            request::RequestType::Xmlhttprequest => NetworkFilterMask::FROM_XMLHTTPREQUEST,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FilterPart<'a> {
    Empty,
    Simple(Cow<'a, str>),
    AnyOf(Vec<Cow<'a, str>>),
}

#[derive(Debug, PartialEq)]
pub(crate) enum FilterTokens {
    Empty,
    OptDomains,
    Other,
}

pub struct FilterPartIterator<'a> {
    filter_part: &'a FilterPart<'a>,
    index: usize,
}

impl<'a> Iterator for FilterPartIterator<'a> {
    type Item = &'a str;

    fn next(&mut self) -> Option<Self::Item> {
        match self.filter_part {
            FilterPart::Empty => None,
            FilterPart::Simple(s) => {
                if self.index == 0 {
                    self.index += 1;
                    Some(s.as_ref())
                } else {
                    None
                }
            }
            FilterPart::AnyOf(vec) => {
                if self.index < vec.len() {
                    let result = Some(vec[self.index].as_ref());
                    self.index += 1;
                    result
                } else {
                    None
                }
            }
        }
    }
}

// Implement ExactSizeIterator for FilterPartIterator
impl ExactSizeIterator for FilterPartIterator<'_> {
    fn len(&self) -> usize {
        match self.filter_part {
            FilterPart::Empty => 0,
            FilterPart::Simple(_) => 1usize.saturating_sub(self.index),
            FilterPart::AnyOf(vec) => vec.len().saturating_sub(self.index),
        }
    }
}

impl FilterPart<'_> {
    pub fn string_view(&self) -> Option<String> {
        match &self {
            FilterPart::Empty => None,
            FilterPart::Simple(s) => Some(s.to_string()),
            FilterPart::AnyOf(s) => Some(
                s.iter()
                    .map(|part| part.as_ref())
                    .collect::<Vec<_>>()
                    .join("|"),
            ),
        }
    }

    pub fn iter(&self) -> FilterPartIterator<'_> {
        FilterPartIterator {
            filter_part: self,
            index: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NetworkFilter<'a> {
    pub mask: NetworkFilterMask,
    pub features_mask: NetworkFilterFeaturesMask,
    pub filter: FilterPart<'a>,
    pub opt_domains: Option<Vec<Hash>>,
    pub opt_not_domains: Option<Vec<Hash>>,
    /// Used for `$redirect`, `$redirect-rule`, `$csp`, and `$removeparam` - only one of which is
    /// supported per-rule.
    pub modifier_option: Option<&'a str>,
    pub hostname: Option<Cow<'a, str>>,
    pub(crate) tag: Option<&'a str>,

    pub raw_line: Option<Cow<'a, str>>,

    pub id: Hash,
}

// TODO - restrict the API so that this is always true - i.e. lazy-calculate IDs from actual data,
// prevent field access, and don't load the ID from the serialized format.
/// The ID of a filter is assumed to be correctly calculated for the purposes of this
/// implementation.
impl PartialEq for NetworkFilter<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

/// Filters are sorted by ID to preserve a stable ordering of data in the serialized format.
impl PartialOrd for NetworkFilter<'_> {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        self.id.partial_cmp(&other.id)
    }
}

/// Ensure that no invalid option combinations were provided for a filter.
fn validate_options(options: &[NetworkFilterOption<'_>]) -> Result<(), NetworkFilterError> {
    let mut has_csp = false;
    let mut has_content_type = false;
    let mut modifier_options = 0;
    for option in options {
        if matches!(option, NetworkFilterOption::Csp(..)) {
            has_csp = true;
            modifier_options += 1;
        } else if option.is_content_type() {
            has_content_type = true;
        } else if option.is_redirection() || matches!(option, NetworkFilterOption::Removeparam(..))
        {
            modifier_options += 1;
        }
    }
    if has_csp && has_content_type {
        return Err(NetworkFilterError::CspWithContentType);
    }
    if modifier_options > 1 {
        return Err(NetworkFilterError::MultipleModifierOptions);
    }

    Ok(())
}

fn cow_ascii_lowercase<'a>(s: &'a str) -> Cow<'a, str> {
    if s.as_bytes().iter().any(|byte| byte.is_ascii_uppercase()) {
        Cow::Owned(s.to_ascii_lowercase())
    } else {
        Cow::Borrowed(s)
    }
}

fn decode_hostname<'a>(host: &'a [u8]) -> Result<Cow<'a, str>, NetworkFilterError> {
    idna::domain_to_ascii_cow(host, idna::AsciiDenyList::EMPTY)
        .map_err(|_| NetworkFilterError::PunycodeError)
}

impl<'a> NetworkFilter<'a> {
    pub fn parse(
        line: &'a str,
        debug: bool,
        _opts: ParseOptions,
    ) -> Result<Self, NetworkFilterError> {
        let parsed = AbstractNetworkFilter::parse(line)?;

        // Represent options as a bitmask
        let mut mask: NetworkFilterMask = NetworkFilterMask::THIRD_PARTY
            | NetworkFilterMask::FIRST_PARTY
            | NetworkFilterMask::FROM_HTTPS
            | NetworkFilterMask::FROM_HTTP;
        let mut features_mask: NetworkFilterFeaturesMask = Default::default();

        // Temporary masks for positive (e.g.: $script) and negative (e.g.: $~script)
        // content type options.
        let mut cpt_mask_positive: NetworkFilterMask = NetworkFilterMask::NONE;
        let mut cpt_mask_negative: NetworkFilterMask = NetworkFilterMask::NONE;
        let mut method_mask_positive: NetworkFilterMask = NetworkFilterMask::NONE;
        let mut method_mask_negative: NetworkFilterMask = NetworkFilterMask::NONE;

        let mut hostname: Option<&'a [u8]> = None;

        let mut opt_domains: Option<Vec<Hash>> = None;
        let mut opt_not_domains: Option<Vec<Hash>> = None;

        let mut modifier_option: Option<&'a str> = None;
        let mut tag: Option<&'a str> = None;

        if parsed.exception {
            mask.set(NetworkFilterMask::IS_EXCEPTION, true);
        }

        if let Some(options) = parsed.options {
            validate_options(&options)?;

            macro_rules! apply_content_type {
                ($content_type:ident, $enabled:ident) => {
                    if $enabled {
                        cpt_mask_positive.set(NetworkFilterMask::$content_type, true);
                    } else {
                        cpt_mask_negative.set(NetworkFilterMask::$content_type, true);
                    }
                };
            }

            macro_rules! apply_method {
                ($method:ident, $enabled:ident) => {
                    if $enabled {
                        method_mask_positive.set(NetworkFilterMask::$method, true);
                    } else {
                        method_mask_negative.set(NetworkFilterMask::$method, true);
                    }
                };
            }

            options.into_iter().for_each(|option| {
                match option {
                    NetworkFilterOption::Domain(domains) => {
                        let mut opt_domains_array: Vec<Hash> = vec![];
                        let mut opt_not_domains_array: Vec<Hash> = vec![];

                        for (enabled, domain) in domains {
                            let domain_hash = utils::fast_hash(domain);
                            if !enabled {
                                opt_not_domains_array.push(domain_hash);
                            } else {
                                opt_domains_array.push(domain_hash);
                            }
                        }

                        if !opt_domains_array.is_empty() {
                            opt_domains_array.sort_unstable();
                            // Some rules have duplicate domain options - avoid including duplicates
                            opt_domains_array.dedup();
                            opt_domains = Some(opt_domains_array);
                        }
                        if !opt_not_domains_array.is_empty() {
                            opt_not_domains_array.sort_unstable();
                            // Some rules have duplicate domain options - avoid including duplicates
                            opt_not_domains_array.dedup();
                            opt_not_domains = Some(opt_not_domains_array);
                        }
                    }
                    NetworkFilterOption::Badfilter => {
                        features_mask.set(NetworkFilterFeaturesMask::BAD_FILTER, true)
                    }
                    NetworkFilterOption::Important => {
                        mask.set(NetworkFilterMask::IS_IMPORTANT, true)
                    }
                    NetworkFilterOption::MatchCase => mask.set(NetworkFilterMask::MATCH_CASE, true),
                    NetworkFilterOption::ThirdParty(false)
                    | NetworkFilterOption::FirstParty(true) => {
                        mask.set(NetworkFilterMask::THIRD_PARTY, false)
                    }
                    NetworkFilterOption::ThirdParty(true)
                    | NetworkFilterOption::FirstParty(false) => {
                        mask.set(NetworkFilterMask::FIRST_PARTY, false)
                    }
                    NetworkFilterOption::Tag(value) => tag = Some(value),
                    NetworkFilterOption::Redirect(value) => {
                        features_mask.set(NetworkFilterFeaturesMask::IS_REDIRECT, true);
                        features_mask.set(NetworkFilterFeaturesMask::ALSO_BLOCK_REDIRECT, true);
                        modifier_option = Some(value);
                    }
                    NetworkFilterOption::RedirectRule(value) => {
                        features_mask.set(NetworkFilterFeaturesMask::IS_REDIRECT, true);
                        modifier_option = Some(value);
                    }
                    NetworkFilterOption::Removeparam(value) => {
                        features_mask.set(NetworkFilterFeaturesMask::IS_REMOVEPARAM, true);
                        modifier_option = Some(value);
                    }
                    NetworkFilterOption::Csp(value) => {
                        features_mask.set(NetworkFilterFeaturesMask::IS_CSP, true);
                        // CSP rules can never have content types, and should always match against
                        // subdocument and document rules. Rules do not match against document
                        // requests by default, so this must be explicitly added.
                        mask.set(NetworkFilterMask::FROM_DOCUMENT, true);
                        modifier_option = value;
                    }
                    NetworkFilterOption::Generichide => {
                        features_mask.set(NetworkFilterFeaturesMask::GENERIC_HIDE, true)
                    }
                    NetworkFilterOption::Document => {
                        cpt_mask_positive.set(NetworkFilterMask::FROM_DOCUMENT, true)
                    }
                    NetworkFilterOption::Image(enabled) => apply_content_type!(FROM_IMAGE, enabled),
                    NetworkFilterOption::Media(enabled) => apply_content_type!(FROM_MEDIA, enabled),
                    NetworkFilterOption::Object(enabled) => {
                        apply_content_type!(FROM_OBJECT, enabled)
                    }
                    NetworkFilterOption::Other(enabled) => apply_content_type!(FROM_OTHER, enabled),
                    NetworkFilterOption::Ping(enabled) => apply_content_type!(FROM_PING, enabled),
                    NetworkFilterOption::Script(enabled) => {
                        apply_content_type!(FROM_SCRIPT, enabled)
                    }
                    NetworkFilterOption::Stylesheet(enabled) => {
                        apply_content_type!(FROM_STYLESHEET, enabled)
                    }
                    NetworkFilterOption::Subdocument(enabled) => {
                        apply_content_type!(FROM_SUBDOCUMENT, enabled)
                    }
                    NetworkFilterOption::XmlHttpRequest(enabled) => {
                        apply_content_type!(FROM_XMLHTTPREQUEST, enabled)
                    }
                    NetworkFilterOption::Websocket(enabled) => {
                        apply_content_type!(FROM_WEBSOCKET, enabled)
                    }
                    NetworkFilterOption::Font(enabled) => apply_content_type!(FROM_FONT, enabled),
                    NetworkFilterOption::All => apply_content_type!(FROM_ALL_TYPES, true),
                    NetworkFilterOption::Method(methods) => {
                        for (enabled, method) in methods {
                            match method {
                                HttpMethod::Get => apply_method!(FROM_GET, enabled),
                                HttpMethod::Head => apply_method!(FROM_HEAD, enabled),
                                HttpMethod::Post => apply_method!(FROM_POST, enabled),
                            }
                        }
                    }
                }
            });
        }

        mask |= cpt_mask_positive;

        // If any negated "network" types were set, then implicitly enable all network types.
        // The negated types will be applied later.
        //
        // This doesn't apply to removeparam filters.
        if !features_mask.contains(NetworkFilterFeaturesMask::IS_REMOVEPARAM)
            && (cpt_mask_negative & NetworkFilterMask::FROM_NETWORK_TYPES)
                != NetworkFilterMask::NONE
        {
            mask |= NetworkFilterMask::FROM_NETWORK_TYPES;
        }
        // If no positive types were set, then the filter should apply to all network types.
        if (cpt_mask_positive & NetworkFilterMask::FROM_ALL_TYPES).is_empty() {
            // Removeparam is again a special case.
            if features_mask.contains(NetworkFilterFeaturesMask::IS_REMOVEPARAM) {
                mask |= NetworkFilterMask::FROM_DOCUMENT
                    | NetworkFilterMask::FROM_SUBDOCUMENT
                    | NetworkFilterMask::FROM_XMLHTTPREQUEST;
            } else {
                mask |= NetworkFilterMask::FROM_NETWORK_TYPES;
            }
        }

        match parsed.pattern.left_anchor {
            Some(NetworkFilterLeftAnchor::DoublePipe) => {
                mask.set(NetworkFilterMask::IS_HOSTNAME_ANCHOR, true)
            }
            Some(NetworkFilterLeftAnchor::SinglePipe) => {
                mask.set(NetworkFilterMask::IS_LEFT_ANCHOR, true)
            }
            None => (),
        }

        // TODO these need to actually be handled differently than trailing `^`.
        let mut end_url_anchor = false;
        if let Some(NetworkFilterRightAnchor::SinglePipe) = parsed.pattern.right_anchor {
            mask.set(NetworkFilterMask::IS_RIGHT_ANCHOR, true);
            end_url_anchor = true;
        }

        let pattern = &line[parsed.pattern.start..parsed.pattern.end];

        let is_regex = check_is_regex(pattern);
        mask.set(NetworkFilterMask::IS_REGEX, is_regex);

        if pattern.starts_with('/') && pattern.ends_with('/') && pattern.len() > 1 {
            #[cfg(feature = "full-regex-handling")]
            {
                mask.set(NetworkFilterMask::IS_COMPLETE_REGEX, true);
            }

            #[cfg(not(feature = "full-regex-handling"))]
            {
                return Err(NetworkFilterError::FullRegexUnsupported);
            }
        } else if !(mask & NetworkFilterMask::MATCH_CASE).is_empty() {
            return Err(NetworkFilterError::MatchCaseWithoutFullRegex);
        }

        let (mut filter_index_start, mut filter_index_end) = (0, pattern.len());

        if let Some(NetworkFilterLeftAnchor::DoublePipe) = parsed.pattern.left_anchor {
            if is_regex {
                // Split at the first '/', '*' or '^' character to get the hostname
                // and then the pattern.
                // TODO - this could be made more efficient if we could match between two
                // indices. Once again, we have to do more work than is really needed.
                static SEPARATOR: LazyLock<Regex> = LazyLock::new(|| Regex::new("[/^*]").unwrap());
                if let Some(first_separator) = SEPARATOR.find(pattern) {
                    let first_separator_start = first_separator.start();
                    // NOTE: `first_separator` shall never be -1 here since `IS_REGEX` is true.
                    // This means there must be at least an occurrence of `*` or `^`
                    // somewhere.

                    // If the first separator is a wildcard, included in in hostname
                    if first_separator_start < pattern.len()
                        && pattern[first_separator_start..=first_separator_start].starts_with('*')
                    {
                        mask.set(NetworkFilterMask::IS_HOSTNAME_REGEX, true);
                    }

                    hostname = Some(&pattern.as_bytes()[..first_separator_start]);
                    filter_index_start = first_separator_start;

                    // If the only symbol remaining for the selector is '^' then ignore it
                    // but set the filter as right anchored since there should not be any
                    // other label on the right
                    if filter_index_end - filter_index_start == 1
                        && pattern[filter_index_start..].starts_with('^')
                    {
                        mask.set(NetworkFilterMask::IS_REGEX, false);
                        filter_index_start = filter_index_end;
                        mask.set(NetworkFilterMask::IS_RIGHT_ANCHOR, true);
                    } else {
                        mask.set(NetworkFilterMask::IS_LEFT_ANCHOR, true);
                        mask.set(
                            NetworkFilterMask::IS_REGEX,
                            check_is_regex(&pattern[filter_index_start..filter_index_end]),
                        );
                    }
                }
            } else {
                // Look for next /
                let slash_index = find_char(b'/', pattern.as_bytes());
                slash_index
                    .map(|i| {
                        hostname = Some(&pattern.as_bytes()[..i]);
                        filter_index_start += i;
                        mask.set(NetworkFilterMask::IS_LEFT_ANCHOR, true);
                    })
                    .or_else(|| {
                        hostname = Some(pattern.as_bytes());
                        filter_index_start = filter_index_end;
                        None
                    });
            }
        }

        // Remove trailing '*'
        if filter_index_end > filter_index_start && pattern.ends_with('*') {
            filter_index_end -= 1;
        }

        // Remove leading '*' if the filter is not hostname anchored.
        if filter_index_end > filter_index_start && pattern[filter_index_start..].starts_with('*') {
            mask.set(NetworkFilterMask::IS_LEFT_ANCHOR, false);
            filter_index_start += 1;
        }

        // Transform filters on protocol (http, https, ws)
        if mask.contains(NetworkFilterMask::IS_LEFT_ANCHOR) {
            if filter_index_end == filter_index_start + 5
                && pattern[filter_index_start..].starts_with("ws://")
            {
                mask.set(NetworkFilterMask::FROM_WEBSOCKET, true);
                mask.set(NetworkFilterMask::FROM_HTTP, false);
                mask.set(NetworkFilterMask::FROM_HTTPS, false);
                mask.set(NetworkFilterMask::IS_LEFT_ANCHOR, false);
                filter_index_start = filter_index_end;
            } else if filter_index_end == filter_index_start + 7
                && pattern[filter_index_start..].starts_with("http://")
            {
                mask.set(NetworkFilterMask::FROM_HTTP, true);
                mask.set(NetworkFilterMask::FROM_HTTPS, false);
                mask.set(NetworkFilterMask::IS_LEFT_ANCHOR, false);
                filter_index_start = filter_index_end;
            } else if filter_index_end == filter_index_start + 8
                && pattern[filter_index_start..].starts_with("https://")
            {
                mask.set(NetworkFilterMask::FROM_HTTPS, true);
                mask.set(NetworkFilterMask::FROM_HTTP, false);
                mask.set(NetworkFilterMask::IS_LEFT_ANCHOR, false);
                filter_index_start = filter_index_end;
            } else if filter_index_end == filter_index_start + 8
                && pattern[filter_index_start..].starts_with("http*://")
            {
                mask.set(NetworkFilterMask::FROM_HTTPS, true);
                mask.set(NetworkFilterMask::FROM_HTTP, true);
                mask.set(NetworkFilterMask::IS_LEFT_ANCHOR, false);
                filter_index_start = filter_index_end;
            }
        }

        let filter = if filter_index_end > filter_index_start {
            let filter_str = &pattern[filter_index_start..filter_index_end];
            mask.set(NetworkFilterMask::IS_REGEX, check_is_regex(filter_str));
            if mask.contains(NetworkFilterMask::MATCH_CASE) {
                Some(Cow::Borrowed(filter_str))
            } else {
                Some(cow_ascii_lowercase(filter_str))
            }
        } else {
            None
        };

        // TODO: ignore hostname anchor is not hostname provided

        let hostname_decoded = hostname.map(decode_hostname).transpose()?;

        if features_mask.contains(NetworkFilterFeaturesMask::GENERIC_HIDE) && !parsed.exception {
            return Err(NetworkFilterError::GenericHideWithoutException);
        }

        if features_mask.contains(NetworkFilterFeaturesMask::IS_REMOVEPARAM) && parsed.exception {
            return Err(NetworkFilterError::RemoveparamWithException);
        }

        // uBlock Origin would block main document `https://example.com` requests with all of the
        // following filters:
        // - ||example.com
        // - ||example.com/
        // - example.com
        // - https://example.com
        // However, it relies on checking the URL post-match against information from the matched
        // filter, which isn't saved in Brave unless running with filter lists compiled in "debug"
        // mode. Instead, we apply the implicit document matching more strictly, only for hostname
        // filters of the form `||example.com^`.
        if (cpt_mask_positive & NetworkFilterMask::FROM_ALL_TYPES).is_empty()
            && (cpt_mask_negative & NetworkFilterMask::FROM_ALL_TYPES).is_empty()
            && mask.contains(NetworkFilterMask::IS_HOSTNAME_ANCHOR)
            && mask.contains(NetworkFilterMask::IS_RIGHT_ANCHOR)
            && !end_url_anchor
            && !features_mask.contains(NetworkFilterFeaturesMask::IS_REMOVEPARAM)
        {
            mask |= NetworkFilterMask::FROM_ALL_TYPES;
        }
        // Finally, apply any explicitly negated request types
        mask &= !cpt_mask_negative;

        if !method_mask_positive.is_empty() || !method_mask_negative.is_empty() {
            mask |= method_mask_positive;
            if (method_mask_negative & NetworkFilterMask::FROM_ANY_METHODS)
                != NetworkFilterMask::NONE
                && (method_mask_positive & NetworkFilterMask::FROM_ANY_METHODS).is_empty()
            {
                mask |= NetworkFilterMask::FROM_ANY_METHODS;
            }
            mask &= !method_mask_negative;
        }

        if features_mask.contains(NetworkFilterFeaturesMask::GENERIC_HIDE)
            && mask.intersects(NetworkFilterMask::FROM_ANY_METHODS)
        {
            return Err(NetworkFilterError::MethodWithGenerichide);
        }

        Ok(NetworkFilter {
            filter: if let Some(simple_filter) = filter {
                FilterPart::Simple(simple_filter)
            } else {
                FilterPart::Empty
            },
            hostname: hostname_decoded,
            mask,
            features_mask,
            opt_domains,
            opt_not_domains,
            tag,
            raw_line: if debug {
                Some(Cow::Borrowed(line))
            } else {
                None
            },
            modifier_option,
            id: utils::fast_hash(line),
        })
    }

    /// Given a hostname, produces an equivalent filter parsed from the form `"||hostname^"`, to
    /// emulate the behavior of hosts-style blocking.
    pub fn parse_hosts_style(hostname: &'a str, debug: bool) -> Result<Self, NetworkFilterError> {
        // Make sure the hostname doesn't contain any invalid characters
        static INVALID_CHARS: LazyLock<Regex> =
            LazyLock::new(|| Regex::new("[/^*!?$&(){}\\[\\]+=~`\\s|@,'\"><:;]").unwrap());
        if INVALID_CHARS.is_match(hostname) {
            return Err(NetworkFilterError::FilterParseError);
        }

        // This shouldn't be used to block an entire TLD, and the hostname shouldn't end with a dot
        if find_char(b'.', hostname.as_bytes()).is_none()
            || (hostname.starts_with('.') && find_char(b'.', &hostname.as_bytes()[1..]).is_none())
            || hostname.ends_with('.')
        {
            return Err(NetworkFilterError::FilterParseError);
        }

        let decoded_hostname = decode_hostname(hostname.as_bytes())?;

        let mask = NetworkFilterMask::THIRD_PARTY
            | NetworkFilterMask::FIRST_PARTY
            | NetworkFilterMask::FROM_HTTPS
            | NetworkFilterMask::FROM_HTTP
            | NetworkFilterMask::FROM_NETWORK_TYPES
            | NetworkFilterMask::FROM_ALL_TYPES
            | NetworkFilterMask::IS_HOSTNAME_ANCHOR
            | NetworkFilterMask::IS_RIGHT_ANCHOR;

        let mut rule = String::with_capacity(hostname.len() + 3);
        rule.push_str("||");
        rule.push_str(hostname);
        rule.push('^');
        let id = utils::fast_hash(&rule);

        Ok(NetworkFilter {
            filter: FilterPart::Empty,
            hostname: Some(decoded_hostname),
            mask,
            features_mask: Default::default(),
            opt_domains: None,
            opt_not_domains: None,
            tag: None,
            raw_line: if debug { Some(Cow::Owned(rule)) } else { None },
            modifier_option: None,
            id,
        })
    }

    pub fn get_id(&self) -> Hash {
        compute_filter_id(
            self.modifier_option,
            self.mask,
            self.features_mask,
            &self.filter,
            self.hostname.as_deref(),
            self.opt_domains.as_ref(),
            self.opt_not_domains.as_ref(),
        )
    }

    /// Returns the tokens that the filter matches to.
    ///
    /// For `!FilterTokens::Empty`, the result is stored in the given `tokens_buffer`.
    pub(crate) fn get_tokens(&self, tokens_buffer: &mut TokensBuffer) -> FilterTokens {
        tokens_buffer.clear();

        // If there is only one domain and no domain negation, we also use this
        // domain as a token.
        if self.opt_domains.is_some()
            && self.opt_not_domains.is_none()
            && self.opt_domains.as_ref().map(|d| d.len()) == Some(1)
            && let Some(domains) = self.opt_domains.as_ref()
            && let Some(domain) = domains.first()
        {
            tokens_buffer.push(*domain);
        }

        // Get tokens from filter
        match &self.filter {
            FilterPart::Simple(f) if !self.is_complete_regex() => {
                let skip_last_token =
                    (self.is_plain() || self.is_regex()) && !self.is_right_anchor();
                let skip_first_token = self.is_right_anchor();

                utils::tokenize_filter_to(
                    f.as_ref(),
                    skip_first_token,
                    skip_last_token,
                    tokens_buffer,
                );
            }
            FilterPart::AnyOf(_) => (), // across AnyOf set of filters no single token is guaranteed to match to a request
            _ => (),
        }

        // Append tokens from hostname, if any
        if !self.mask.contains(NetworkFilterMask::IS_HOSTNAME_REGEX) {
            if let Some(hostname) = self.hostname.as_ref() {
                utils::tokenize_to(hostname.as_ref(), tokens_buffer);
            }
        } else if let Some(hostname) = self.hostname.as_ref() {
            // Find last dot to tokenize the prefix
            let last_dot_pos = hostname.rfind('.');
            if let Some(last_dot_pos) = last_dot_pos {
                utils::tokenize_to(&hostname.as_ref()[..last_dot_pos], tokens_buffer);
            }
        }

        if tokens_buffer.is_empty()
            && self
                .features_mask
                .contains(NetworkFilterFeaturesMask::IS_REMOVEPARAM)
            && let Some(removeparam) = &self.modifier_option
            && VALID_PARAM.is_match(removeparam.as_ref())
        {
            utils::tokenize_to(&removeparam.to_ascii_lowercase(), tokens_buffer);
        }

        // If we got no tokens for the filter/hostname part, then we will dispatch
        // this filter in multiple buckets based on the domains option.
        if tokens_buffer.is_empty() && self.opt_domains.is_some() && self.opt_not_domains.is_none()
        {
            if let Some(opt_domains) = self.opt_domains.as_ref()
                && !opt_domains.is_empty()
            {
                let cap = tokens_buffer.remaining_capacity();
                if opt_domains.len() <= cap {
                    tokens_buffer.extend(opt_domains.iter().copied());
                    return FilterTokens::OptDomains;
                }
                // Too many domains to bucket individually; fall back to the catch-all
                // bucket (token 0).
            }
            FilterTokens::Empty
        } else {
            // Add optional token for protocol
            if self.for_http() && !self.for_https() {
                tokens_buffer.push(utils::fast_hash("http"));
            } else if self.for_https() && !self.for_http() {
                tokens_buffer.push(utils::fast_hash("https"));
            }

            if tokens_buffer.is_empty() {
                FilterTokens::Empty
            } else {
                FilterTokens::Other
            }
        }
    }

    pub fn is_badfilter(&self) -> bool {
        self.features_mask
            .contains(NetworkFilterFeaturesMask::BAD_FILTER)
    }

    pub fn is_removeparam(&self) -> bool {
        self.features_mask
            .contains(NetworkFilterFeaturesMask::IS_REMOVEPARAM)
    }

    pub fn is_generic_hide(&self) -> bool {
        self.features_mask
            .contains(NetworkFilterFeaturesMask::GENERIC_HIDE)
    }

    pub fn is_csp(&self) -> bool {
        self.features_mask
            .contains(NetworkFilterFeaturesMask::IS_CSP)
    }

    pub fn is_redirect(&self) -> bool {
        self.features_mask
            .contains(NetworkFilterFeaturesMask::IS_REDIRECT)
    }

    pub fn also_block_redirect(&self) -> bool {
        self.features_mask
            .contains(NetworkFilterFeaturesMask::ALSO_BLOCK_REDIRECT)
    }

    #[cfg(test)]
    pub(crate) fn matches_test(&self, request: &request::Request) -> bool {
        let engine = crate::Engine::new_with_parsed_rules(vec![self.clone()], vec![]);
        if self.is_exception() {
            engine.check_network_request_exceptions(request)
        } else {
            engine.check_network_request(request).filter.is_some()
        }
    }
}

impl NetworkFilterMaskHelper for NetworkFilter<'_> {
    fn has_flag(&self, v: NetworkFilterMask) -> bool {
        self.mask.contains(v)
    }
}

impl fmt::Display for NetworkFilter<'_> {
    fn fmt(&self, f: &mut fmt::Formatter) -> Result<(), fmt::Error> {
        match self.raw_line.as_deref() {
            Some(r) => write!(f, "{r}"),
            None => write!(f, "NetworkFilter"),
        }
    }
}

pub(crate) trait NetworkMatchable {
    fn matches(&self, request: &request::Request, regex_manager: &mut RegexManager) -> bool;
}

// ---------------------------------------------------------------------------
// Filter parsing
// ---------------------------------------------------------------------------

#[inline]
fn write_str_to_hasher(hasher: &mut impl Hasher, s: &str) {
    hasher.write_usize(s.len());
    hasher.write(s.as_bytes());
}

fn compute_filter_id(
    modifier_option: Option<&str>,
    mask: NetworkFilterMask,
    features_mask: NetworkFilterFeaturesMask,
    filter: &FilterPart<'_>,
    hostname: Option<&str>,
    opt_domains: Option<&Vec<Hash>>,
    opt_not_domains: Option<&Vec<Hash>>,
) -> Hash {
    let mut hasher = FxHasher::default();

    hasher.write_u64(u64::from(mask.bits()));

    // Exclude BAD_FILTER from the hash
    let features_mask_bits = features_mask.bits() & !NetworkFilterFeaturesMask::BAD_FILTER.bits();
    hasher.write_u64(u64::from(features_mask_bits));

    if let Some(s) = modifier_option {
        write_str_to_hasher(&mut hasher, s);
    }

    if let Some(domains) = opt_domains {
        for d in domains {
            hasher.write_u64(*d);
        }
    }

    if let Some(domains) = opt_not_domains {
        for d in domains {
            hasher.write_u64(*d);
        }
    }

    match filter {
        FilterPart::Empty => {}
        FilterPart::Simple(s) => write_str_to_hasher(&mut hasher, s.as_ref()),
        FilterPart::AnyOf(parts) => {
            hasher.write_u64(parts.len() as u64);
            for part in parts {
                write_str_to_hasher(&mut hasher, part);
            }
        }
    }

    if let Some(s) = hostname {
        write_str_to_hasher(&mut hasher, s);
    }

    hasher.finish()
}

/// Check if the sub-string contained between the indices start and end is a
/// regex filter (it contains a '*' or '^' char). Here we are limited by the
/// capability of javascript to check the presence of a pattern between two
/// indices (same for Regex...).
fn check_is_regex(filter: &str) -> bool {
    // TODO - we could use sticky regex here
    let start_index = find_char(b'*', filter.as_bytes());
    let separator_index = find_char(b'^', filter.as_bytes());
    start_index.is_some() || separator_index.is_some()
}
#[cfg(test)]
#[path = "../../tests/unit/filters/network.rs"]
mod unit_tests;
