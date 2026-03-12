//! This file contains the implementation of network filter matching logic for a filtering system.
//! It provides functions to check if a given network request matches specific filter patterns based
//! on various criteria, including hostname anchoring, pattern matching, and regular expressions.
//! The file also handles domain-specific options and ensures that requests are filtered according
//! to their type, protocol, and party (first-party or third-party). The code is designed to
//! efficiently determine if a request should be blocked or allowed based on the defined filters.

use memchr::memmem;

use crate::filters::network::{NetworkFilterMask, NetworkFilterMaskHelper};
use crate::regex_manager::RegexManager;
use crate::request;
use crate::utils::{self, Hash};
use std::collections::HashMap;

fn get_url_after_hostname<'a>(url: &'a str, hostname: &str) -> &'a str {
    let start =
        memmem::find(url.as_bytes(), hostname.as_bytes()).unwrap_or(url.len() - hostname.len());
    &url[start + hostname.len()..]
}

/// Handle hostname anchored filters, given 'hostname' from ||hostname and
/// request's hostname, check if there is a match. This is tricky because
/// filters authors rely and different assumption. We can have prefix of suffix
/// matches of anchor.
fn is_anchored_by_hostname(
    filter_hostname: &str,
    hostname: &str,
    wildcard_filter_hostname: bool,
) -> bool {
    let filter_hostname_len = filter_hostname.len();
    // Corner-case, if `filterHostname` is empty, then it's a match
    if filter_hostname_len == 0 {
        return true;
    }
    let hostname_len = hostname.len();

    if filter_hostname_len > hostname_len {
        // `filterHostname` cannot be longer than actual hostname
        false
    } else if filter_hostname_len == hostname_len {
        // If they have the same len(), they should be equal
        filter_hostname == hostname
    } else if let Some(match_index) = memmem::find(hostname.as_bytes(), filter_hostname.as_bytes())
    {
        if match_index == 0 {
            // `filter_hostname` is a prefix of `hostname` and needs to match full a label.
            //
            // Examples (filter_hostname, hostname):
            //   * (foo, foo.com)
            //   * (sub.foo, sub.foo.com)
            wildcard_filter_hostname
                || filter_hostname.ends_with('.')
                || hostname[filter_hostname_len..].starts_with('.')
        } else if match_index == hostname_len - filter_hostname_len {
            // `filter_hostname` is a suffix of `hostname`.
            //
            // Examples (filter_hostname, hostname):
            //    * (foo.com, sub.foo.com)
            //    * (com, foo.com)
            filter_hostname.starts_with('.') || hostname[match_index - 1..].starts_with('.')
        } else {
            // `filter_hostname` is infix of `hostname` and needs match full labels
            (wildcard_filter_hostname
                || filter_hostname.ends_with('.')
                || hostname[filter_hostname_len..].starts_with('.'))
                && (filter_hostname.starts_with('.')
                    || hostname[match_index - 1..].starts_with('.'))
        }
    } else {
        // No match
        false
    }
}

// pattern
fn check_pattern_plain_filter_filter<'a, FiltersIter>(
    mask: NetworkFilterMask,
    mut filters: FiltersIter,
    request: &request::Request,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    if filters.len() == 0 {
        return true;
    }

    let request_url = request.get_url(mask.match_case());
    filters.any(|f| memmem::find(request_url.as_bytes(), f.as_bytes()).is_some())
}

// pattern|
fn check_pattern_right_anchor_filter<'a, FiltersIter>(
    mask: NetworkFilterMask,
    mut filters: FiltersIter,
    request: &request::Request,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    if filters.len() == 0 {
        return true;
    }
    let request_url = request.get_url(mask.match_case());
    filters.any(|f| request_url.ends_with(f))
}

// |pattern
fn check_pattern_left_anchor_filter<'a, FiltersIter>(
    mask: NetworkFilterMask,
    mut filters: FiltersIter,
    request: &request::Request,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    if filters.len() == 0 {
        return true;
    }
    let request_url = request.get_url(mask.match_case());
    filters.any(|f| request_url.starts_with(f))
}

// |pattern|
fn check_pattern_left_right_anchor_filter<'a, FiltersIter>(
    mask: NetworkFilterMask,
    mut filters: FiltersIter,
    request: &request::Request,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    if filters.len() == 0 {
        return true;
    }
    let request_url = request.get_url(mask.match_case());
    filters.any(|f| request_url == f)
}

// pattern*^
fn check_pattern_regex_filter_at<'a, FiltersIter>(
    mask: NetworkFilterMask,
    filters: FiltersIter,
    key: u64,
    request: &request::Request,
    start_from: usize,
    regex_manager: &mut RegexManager,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    let request_url = request.get_url(mask.match_case());
    regex_manager.matches(mask, filters, key, &request_url[start_from..])
}

fn check_pattern_regex_filter<'a, FiltersIter>(
    mask: NetworkFilterMask,
    filters: FiltersIter,
    key: u64,
    request: &request::Request,
    regex_manager: &mut RegexManager,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    check_pattern_regex_filter_at(mask, filters, key, request, 0, regex_manager)
}

// ||pattern*^
fn check_pattern_hostname_anchor_regex_filter<'a, FiltersIter>(
    mask: NetworkFilterMask,
    filters: FiltersIter,
    hostname: Option<&'a str>,
    key: u64,
    request: &request::Request,
    regex_manager: &mut RegexManager,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    let request_url = request.get_url(mask.match_case());
    hostname
        .as_ref()
        .map(|hostname| {
            if is_anchored_by_hostname(
                hostname,
                &request.hostname,
                mask.contains(NetworkFilterMask::IS_HOSTNAME_REGEX),
            ) {
                check_pattern_regex_filter_at(
                    mask,
                    filters,
                    key,
                    request,
                    memmem::find(request_url.as_bytes(), hostname.as_bytes()).unwrap_or_default()
                        + hostname.len(),
                    regex_manager,
                )
            } else {
                false
            }
        })
        .unwrap_or_else(|| unreachable!()) // no match if filter has no hostname - should be unreachable
}

// ||pattern|
fn check_pattern_hostname_right_anchor_filter<'a, FiltersIter>(
    mask: NetworkFilterMask,
    filters: FiltersIter,
    hostname: Option<&'a str>,
    request: &request::Request,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    hostname
        .as_ref()
        .map(|hostname| {
            if is_anchored_by_hostname(
                hostname,
                &request.hostname,
                mask.contains(NetworkFilterMask::IS_HOSTNAME_REGEX),
            ) {
                if filters.len() == 0 {
                    // In this specific case it means that the specified hostname should match
                    // at the end of the hostname of the request. This allows to prevent false
                    // positive like ||foo.bar which would match https://foo.bar.baz where
                    // ||foo.bar^ would not.
                    request.hostname.len() == hostname.len()        // if lengths are equal, hostname equality is implied by anchoring check
                          || request.hostname.ends_with(hostname)
                } else {
                    check_pattern_right_anchor_filter(mask, filters, request)
                }
            } else {
                false
            }
        })
        .unwrap_or_else(|| unreachable!()) // no match if filter has no hostname - should be unreachable
}

// |||pattern|
fn check_pattern_hostname_left_right_anchor_filter<'a, FiltersIter>(
    mask: NetworkFilterMask,
    mut filters: FiltersIter,
    hostname: Option<&'a str>,
    request: &request::Request,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    // Since this is not a regex, the filter pattern must follow the hostname
    // with nothing in between. So we extract the part of the URL following
    // after hostname and will perform the matching on it.

    hostname
        .as_ref()
        .map(|hostname| {
            if is_anchored_by_hostname(
                hostname,
                &request.hostname,
                mask.contains(NetworkFilterMask::IS_HOSTNAME_REGEX),
            ) {
                let request_url = request.get_url(mask.match_case());
                if filters.len() == 0 {
                    return true;
                }
                let url_after_hostname = get_url_after_hostname(request_url, hostname);
                filters.any(|f| {
                    // Since it must follow immediatly after the hostname and be a suffix of
                    // the URL, we conclude that filter must be equal to the part of the
                    // url following the hostname.
                    url_after_hostname == f
                })
            } else {
                false
            }
        })
        .unwrap_or_else(|| unreachable!()) // no match if filter has no hostname - should be unreachable
}

// ||pattern + left-anchor => This means that a plain pattern needs to appear
// exactly after the hostname, with nothing in between.
fn check_pattern_hostname_left_anchor_filter<'a, FiltersIter>(
    mask: NetworkFilterMask,
    mut filters: FiltersIter,
    hostname: Option<&'a str>,
    request: &request::Request,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    hostname
        .as_ref()
        .map(|hostname| {
            if is_anchored_by_hostname(
                hostname,
                &request.hostname,
                mask.contains(NetworkFilterMask::IS_HOSTNAME_REGEX),
            ) {
                if filters.len() == 0 {
                    return true;
                }
                let request_url = request.get_url(mask.match_case());
                let url_after_hostname = get_url_after_hostname(request_url, hostname);
                filters.any(|f| {
                    // Since this is not a regex, the filter pattern must follow the hostname
                    // with nothing in between. So we extract the part of the URL following
                    // after hostname and will perform the matching on it.
                    url_after_hostname.starts_with(f)
                })
            } else {
                false
            }
        })
        .unwrap_or_else(|| unreachable!()) // no match if filter has no hostname - should be unreachable
}

// ||pattern
fn check_pattern_hostname_anchor_filter<'a, FiltersIter>(
    mask: NetworkFilterMask,
    mut filters: FiltersIter,
    hostname: Option<&'a str>,
    request: &request::Request,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    hostname
        .as_ref()
        .map(|hostname| {
            if is_anchored_by_hostname(
                hostname,
                &request.hostname,
                mask.contains(NetworkFilterMask::IS_HOSTNAME_REGEX),
            ) {
                if filters.len() == 0 {
                    return true;
                }
                let request_url = request.get_url(mask.match_case());
                let url_after_hostname = get_url_after_hostname(request_url, hostname);
                filters.any(|f| {
                    // Filter hostname does not necessarily have to be a full, proper hostname, part of it can be lumped together with the URL
                    url_after_hostname.contains(f)
                })
            } else {
                false
            }
        })
        .unwrap_or_else(|| unreachable!()) // no match if filter has no hostname - should be unreachable
}

/// Efficiently checks if a certain network filter matches against a network
/// request.
pub fn check_pattern<'a, FiltersIter>(
    mask: NetworkFilterMask,
    filters: FiltersIter,
    hostname: Option<&'a str>,
    key: u64,
    request: &request::Request,
    regex_manager: &mut RegexManager,
) -> bool
where
    FiltersIter: Iterator<Item = &'a str> + ExactSizeIterator,
{
    if mask.is_hostname_anchor() {
        if mask.is_regex() {
            check_pattern_hostname_anchor_regex_filter(
                mask,
                filters,
                hostname,
                key,
                request,
                regex_manager,
            )
        } else if mask.is_right_anchor() && mask.is_left_anchor() {
            check_pattern_hostname_left_right_anchor_filter(mask, filters, hostname, request)
        } else if mask.is_right_anchor() {
            check_pattern_hostname_right_anchor_filter(mask, filters, hostname, request)
        } else if mask.is_left_anchor() {
            check_pattern_hostname_left_anchor_filter(mask, filters, hostname, request)
        } else {
            check_pattern_hostname_anchor_filter(mask, filters, hostname, request)
        }
    } else if mask.is_regex() || mask.is_complete_regex() {
        check_pattern_regex_filter(mask, filters, key, request, regex_manager)
    } else if mask.is_left_anchor() && mask.is_right_anchor() {
        check_pattern_left_right_anchor_filter(mask, filters, request)
    } else if mask.is_left_anchor() {
        check_pattern_left_anchor_filter(mask, filters, request)
    } else if mask.is_right_anchor() {
        check_pattern_right_anchor_filter(mask, filters, request)
    } else {
        check_pattern_plain_filter_filter(mask, filters, request)
    }
}

#[inline]
pub fn check_options(mask: NetworkFilterMask, request: &request::Request) -> bool {
    // Bad filter never matches
    if mask.is_badfilter() {
        return false;
    }
    // We first discard requests based on type, protocol and party. This is really
    // cheap and should be done first.
    if !mask.check_cpt_allowed(&request.request_type)
        || (request.is_https && !mask.for_https())
        || (request.is_http && !mask.for_http())
        || (!mask.first_party() && !request.is_third_party)
        || (!mask.third_party() && request.is_third_party)
    {
        return false;
    }
    true
}

#[inline]
pub fn check_included_domains_mapped(
    opt_domains: Option<&[u32]>,
    request: &request::Request,
    mapping: &HashMap<Hash, u32>,
) -> bool {
    // Source URL must be among these domains to match
    if let Some(included_domains) = opt_domains.as_ref() {
        if let Some(source_hashes) = request.source_hostname_hashes.as_ref() {
            if source_hashes.iter().all(|h| {
                mapping
                    .get(h)
                    .is_none_or(|index| !utils::bin_lookup(included_domains, *index))
            }) {
                return false;
            }
        } else {
            // If there are domain restrictions but no source hostname, we can't apply the rule
            return false;
        }
    }
    true
}

#[inline]
pub fn check_excluded_domains_mapped(
    opt_not_domains: Option<&[u32]>,
    request: &request::Request,
    mapping: &HashMap<Hash, u32>,
) -> bool {
    if let Some(excluded_domains) = opt_not_domains.as_ref() {
        if let Some(source_hashes) = request.source_hostname_hashes.as_ref() {
            if source_hashes.iter().any(|h| {
                mapping
                    .get(h)
                    .is_some_and(|index| utils::bin_lookup(excluded_domains, *index))
            }) {
                return false;
            }
        } else {
            // If there are domain restrictions but no source hostname
            // (i.e. about:blank), apply the rule anyway.
            return true;
        }
    }

    true
}

#[cfg(test)]
#[path = "../../tests/unit/filters/network_matchers.rs"]
mod unit_tests;
