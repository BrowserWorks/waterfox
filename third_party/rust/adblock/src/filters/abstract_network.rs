use memchr::memrchr as find_char_reverse;

use super::network::NetworkFilterError;

use regex::Regex;
use std::sync::LazyLock;

/// For now, only support `$removeparam` with simple alphanumeric/dash/underscore patterns.
static VALID_PARAM: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-zA-Z0-9_\-]+$").unwrap());

#[derive(Clone, Copy)]
pub(crate) enum NetworkFilterLeftAnchor {
    /// A `||` token, which represents a match to the start of a domain or subdomain segment.
    DoublePipe,
    /// A `|` token, which represents a match to the exact start of the URL.
    SinglePipe,
}

#[derive(Clone, Copy)]
pub(crate) enum NetworkFilterRightAnchor {
    /// A `|` token, which represents a match to the exact end of the URL.
    SinglePipe,
}

/// Pattern for a network filter, describing what URLs to match against.
#[derive(Clone)]
pub(crate) struct NetworkFilterPattern {
    pub(crate) left_anchor: Option<NetworkFilterLeftAnchor>,
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) right_anchor: Option<NetworkFilterRightAnchor>,
}

#[derive(Clone, Copy)]
pub(crate) enum HttpMethod {
    Get,
    Head,
    Post,
}

/// Any option that appears on the right side of a network filter as initiated by a `$` character.
/// All `bool` arguments below are `true` if the option stands alone, or `false` if the option is
/// negated using a prepended `~`.
#[derive(Clone)]
pub(crate) enum NetworkFilterOption<'a> {
    Domain(Vec<(bool, &'a str)>),
    Badfilter,
    Important,
    MatchCase,
    ThirdParty(bool),
    FirstParty(bool),
    Tag(&'a str),
    Redirect(&'a str),
    RedirectRule(&'a str),
    Csp(Option<&'a str>),
    Removeparam(&'a str),
    Generichide,
    Document,
    Image(bool),
    Media(bool),
    Object(bool),
    Other(bool),
    Ping(bool),
    Script(bool),
    Stylesheet(bool),
    Subdocument(bool),
    XmlHttpRequest(bool),
    Websocket(bool),
    Font(bool),
    All,
    Method(Vec<(bool, HttpMethod)>),
}

impl NetworkFilterOption<'_> {
    pub fn is_content_type(&self) -> bool {
        matches!(
            self,
            Self::Document
                | Self::Image(..)
                | Self::Media(..)
                | Self::Object(..)
                | Self::Other(..)
                | Self::Ping(..)
                | Self::Script(..)
                | Self::Stylesheet(..)
                | Self::Subdocument(..)
                | Self::XmlHttpRequest(..)
                | Self::Websocket(..)
                | Self::Font(..)
                | Self::All
        )
    }

    pub fn is_redirection(&self) -> bool {
        matches!(self, Self::Redirect(..) | Self::RedirectRule(..))
    }
}

/// Abstract syntax representation of a network filter. This representation can fully specify the
/// string representation of a filter as written, with the exception of aliased options like `1p`
/// or `ghide`. This allows separation of concerns between parsing and interpretation.
pub(crate) struct AbstractNetworkFilter<'a> {
    pub(crate) exception: bool,
    pub(crate) pattern: NetworkFilterPattern,
    pub(crate) options: Option<Vec<NetworkFilterOption<'a>>>,
}

impl AbstractNetworkFilter<'_> {
    pub(crate) fn parse<'a>(
        line: &'a str,
    ) -> Result<AbstractNetworkFilter<'a>, NetworkFilterError> {
        let mut filter_index_start: usize = 0;
        let mut filter_index_end: usize = line.len();

        let mut exception = false;
        if line.starts_with("@@") {
            filter_index_start += 2;
            exception = true;
        }

        let maybe_options_index: Option<usize> = find_char_reverse(b'$', line.as_bytes());

        let mut options = None;
        if let Some(options_index) = maybe_options_index {
            filter_index_end = options_index;

            // slicing here is safe; the first byte after '$' will be a character boundary
            let raw_options = &line[filter_index_end + 1..];

            options = Some(parse_filter_options(raw_options)?);
        }

        let left_anchor = if line[filter_index_start..].starts_with("||") {
            filter_index_start += 2;
            Some(NetworkFilterLeftAnchor::DoublePipe)
        } else if line[filter_index_start..].starts_with('|') {
            filter_index_start += 1;
            Some(NetworkFilterLeftAnchor::SinglePipe)
        } else {
            None
        };

        let right_anchor = if filter_index_end > 0
            && filter_index_end > filter_index_start
            && line[..filter_index_end].ends_with('|')
        {
            filter_index_end -= 1;
            Some(NetworkFilterRightAnchor::SinglePipe)
        } else {
            None
        };

        Ok(AbstractNetworkFilter {
            exception,
            pattern: NetworkFilterPattern {
                left_anchor,
                start: filter_index_start,
                end: filter_index_end,
                right_anchor,
            },
            options,
        })
    }
}

fn parse_filter_options<'a>(
    raw_options: &'a str,
) -> Result<Vec<NetworkFilterOption<'a>>, NetworkFilterError> {
    let mut result = vec![];

    for raw_option in raw_options.split(',') {
        // Check for negation: ~option
        let negation = raw_option.starts_with('~');
        let maybe_negated_option = raw_option.trim_start_matches('~');

        // Check for options: option=value1|value2
        let mut option_and_values = maybe_negated_option.splitn(2, '=');
        let (option, value) = (
            option_and_values.next().unwrap(),
            option_and_values.next().unwrap_or_default(),
        );

        result.push(match (option, negation) {
            ("domain", _) | ("from", _) => {
                let domains: Vec<(bool, &'a str)> = value
                    .split('|')
                    .map(|domain| {
                        if let Some(negated_domain) = domain.strip_prefix('~') {
                            (false, negated_domain)
                        } else {
                            (true, domain)
                        }
                    })
                    .filter(|(_, d)| !(d.starts_with('/') && d.ends_with('/')))
                    .collect();
                if domains.is_empty() {
                    return Err(NetworkFilterError::NoSupportedDomains);
                }
                NetworkFilterOption::Domain(domains)
            }
            ("badfilter", true) => return Err(NetworkFilterError::NegatedBadFilter),
            ("badfilter", false) => NetworkFilterOption::Badfilter,
            ("important", true) => return Err(NetworkFilterError::NegatedImportant),
            ("important", false) => NetworkFilterOption::Important,
            ("match-case", true) => return Err(NetworkFilterError::NegatedOptionMatchCase),
            ("match-case", false) => NetworkFilterOption::MatchCase,
            ("third-party", negated) | ("3p", negated) => NetworkFilterOption::ThirdParty(!negated),
            ("first-party", negated) | ("1p", negated) => NetworkFilterOption::FirstParty(!negated),
            ("tag", true) => return Err(NetworkFilterError::NegatedTag),
            ("tag", false) => NetworkFilterOption::Tag(value),
            // `rewrite` is the ABP-syntax alias for `redirect`. The `abp-resource:`-prefixed
            // values it uses are shipped by uBO as aliases of the corresponding redirect
            // resources, so no further translation is needed here.
            ("redirect", true) | ("rewrite", true) => {
                return Err(NetworkFilterError::NegatedRedirection);
            }
            ("redirect", false) | ("rewrite", false) => {
                // Ignore this filter if no redirection resource is specified
                if value.is_empty() {
                    return Err(NetworkFilterError::EmptyRedirection);
                }

                NetworkFilterOption::Redirect(value)
            }
            ("redirect-rule", true) => return Err(NetworkFilterError::NegatedRedirection),
            ("redirect-rule", false) => {
                if value.is_empty() {
                    return Err(NetworkFilterError::EmptyRedirection);
                }

                NetworkFilterOption::RedirectRule(value)
            }
            ("csp", _) => {
                NetworkFilterOption::Csp(if !value.is_empty() { Some(value) } else { None })
            }
            ("removeparam", true) => return Err(NetworkFilterError::NegatedRemoveparam),
            ("removeparam", false) => {
                if value.is_empty() {
                    return Err(NetworkFilterError::EmptyRemoveparam);
                }
                if !VALID_PARAM.is_match(value) {
                    return Err(NetworkFilterError::RemoveparamRegexUnsupported);
                }
                NetworkFilterOption::Removeparam(value)
            }
            ("generichide", true) | ("ghide", true) => {
                return Err(NetworkFilterError::NegatedGenericHide);
            }
            ("generichide", false) | ("ghide", false) => NetworkFilterOption::Generichide,
            ("document", true) | ("doc", true) => return Err(NetworkFilterError::NegatedDocument),
            ("document", false) | ("doc", false) => NetworkFilterOption::Document,
            ("image", negated) => NetworkFilterOption::Image(!negated),
            ("media", negated) => NetworkFilterOption::Media(!negated),
            ("object", negated) | ("object-subrequest", negated) => {
                NetworkFilterOption::Object(!negated)
            }
            ("other", negated) => NetworkFilterOption::Other(!negated),
            ("ping", negated) | ("beacon", negated) => NetworkFilterOption::Ping(!negated),
            ("script", negated) => NetworkFilterOption::Script(!negated),
            ("stylesheet", negated) | ("css", negated) => NetworkFilterOption::Stylesheet(!negated),
            ("subdocument", negated) | ("frame", negated) => {
                NetworkFilterOption::Subdocument(!negated)
            }
            ("xmlhttprequest", negated) | ("xhr", negated) => {
                NetworkFilterOption::XmlHttpRequest(!negated)
            }
            ("websocket", negated) => NetworkFilterOption::Websocket(!negated),
            ("font", negated) => NetworkFilterOption::Font(!negated),
            ("all", true) => return Err(NetworkFilterError::NegatedAll),
            ("all", false) => NetworkFilterOption::All,
            ("method", true) => return Err(NetworkFilterError::UnrecognisedOption),
            ("method", false) => {
                if value.is_empty() {
                    return Err(NetworkFilterError::UnrecognisedOption);
                }
                let methods: Vec<(bool, HttpMethod)> = value
                    .split('|')
                    .filter_map(|method| {
                        let (enabled, name) = if let Some(negated) = method.strip_prefix('~') {
                            (false, negated)
                        } else {
                            (true, method)
                        };
                        if name.eq_ignore_ascii_case("get") {
                            Some((enabled, HttpMethod::Get))
                        } else if name.eq_ignore_ascii_case("head") {
                            Some((enabled, HttpMethod::Head))
                        } else if name.eq_ignore_ascii_case("post") {
                            Some((enabled, HttpMethod::Post))
                        } else {
                            None
                        }
                    })
                    .collect();
                if methods.is_empty() {
                    return Err(NetworkFilterError::UnrecognisedOption);
                }
                NetworkFilterOption::Method(methods)
            }
            (_, _) => return Err(NetworkFilterError::UnrecognisedOption),
        });
    }
    Ok(result)
}
