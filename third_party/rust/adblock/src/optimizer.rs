use crate::filters::network::{
    FilterPart, NetworkFilter, NetworkFilterMask, NetworkFilterMaskHelper,
};
use itertools::*;
use std::borrow::Cow;
use std::collections::HashMap;

trait Optimization {
    fn fusion<'a>(&self, filters: Vec<NetworkFilter<'a>>) -> NetworkFilter<'a>;
    fn group_by_criteria(&self, filter: &NetworkFilter<'_>) -> String;
    fn select(&self, filter: &NetworkFilter<'_>) -> bool;
}

pub fn is_filter_optimizable_by_patterns(filter: &NetworkFilter<'_>) -> bool {
    filter.opt_domains.is_none()
        && filter.opt_not_domains.is_none()
        && !filter.is_hostname_anchor()
        && !filter.is_redirect()
        && !filter.is_csp()
}

/// Fuse `NetworkFilter`s together by applying optimizations sequentially.
pub fn optimize<'a>(filters: Vec<NetworkFilter<'a>>) -> Vec<NetworkFilter<'a>> {
    let mut optimized: Vec<NetworkFilter<'a>> = Vec::new();

    /*
    let union_domain_group = UnionDomainGroup {};
    let (fused, unfused) = apply_optimisation(&union_domain_group, filters);
    optimized.extend(fused);
    */

    let simple_pattern_group = SimplePatternGroup {};
    let (fused, unfused) = apply_optimisation(&simple_pattern_group, filters);
    optimized.extend(fused);

    // Append whatever is still left unfused
    optimized.extend(unfused);

    // Re-sort the list, now that the order has been perturbed
    optimized.sort_by_key(|f| f.id);
    optimized
}

fn apply_optimisation<'a, T: Optimization>(
    optimization: &T,
    filters: Vec<NetworkFilter<'a>>,
) -> (Vec<NetworkFilter<'a>>, Vec<NetworkFilter<'a>>) {
    let (positive, mut negative): (Vec<NetworkFilter<'a>>, Vec<NetworkFilter<'a>>) =
        filters.into_iter().partition_map(|f| {
            if optimization.select(&f) {
                Either::Left(f)
            } else {
                Either::Right(f)
            }
        });

    let mut to_fuse: HashMap<String, Vec<NetworkFilter<'a>>> =
        HashMap::with_capacity(positive.len());
    positive
        .into_iter()
        .for_each(|f| insert_dup(&mut to_fuse, optimization.group_by_criteria(&f), f));

    let mut fused = Vec::with_capacity(to_fuse.len());
    for (_, group) in to_fuse {
        if group.len() > 1 {
            // println!("Fusing {} filters together", group.len());
            fused.push(optimization.fusion(group));
        } else {
            group.into_iter().for_each(|f| negative.push(f));
        }
    }

    fused.shrink_to_fit();

    (fused, negative)
}

fn insert_dup<K, V>(map: &mut HashMap<K, Vec<V>>, k: K, v: V)
where
    K: std::cmp::Ord + std::hash::Hash,
{
    map.entry(k).or_default().push(v)
}

struct SimplePatternGroup {}

impl Optimization for SimplePatternGroup {
    // Group simple patterns, into a single filter

    fn fusion<'a>(&self, filters: Vec<NetworkFilter<'a>>) -> NetworkFilter<'a> {
        let base_filter = &filters[0]; // FIXME: can technically panic, if filters list is empty
        let mut filter = base_filter.clone();

        let is_regex = filters.iter().any(NetworkFilter::is_regex);
        let is_complete_regex = filters.iter().any(|f| f.is_complete_regex());
        filter.mask.set(NetworkFilterMask::IS_REGEX, is_regex);
        filter
            .mask
            .set(NetworkFilterMask::IS_COMPLETE_REGEX, is_complete_regex);

        let combined_raw_line = filters
            .iter()
            .filter_map(|f| f.raw_line.as_deref())
            .join(" <+> ");
        if !combined_raw_line.is_empty() {
            filter.raw_line = Some(Cow::Owned(combined_raw_line));
        }

        // if any filter is empty (meaning matches anything), the entire combiation matches anything
        if filters
            .iter()
            .any(|f| matches!(f.filter, FilterPart::Empty))
        {
            filter.filter = FilterPart::Empty;
        } else {
            let mut flat_patterns: Vec<Cow<'a, str>> = Vec::with_capacity(filters.len());
            for f in filters {
                match f.filter {
                    FilterPart::Empty => (),
                    FilterPart::Simple(s) => flat_patterns.push(s),
                    FilterPart::AnyOf(s) => flat_patterns.extend(s),
                }
            }

            if flat_patterns.is_empty() {
                filter.filter = FilterPart::Empty;
            } else if flat_patterns.len() == 1 {
                filter.filter = FilterPart::Simple(flat_patterns.into_iter().next().unwrap())
            } else {
                filter.filter = FilterPart::AnyOf(flat_patterns)
            }
        }

        filter
    }

    fn group_by_criteria(&self, filter: &NetworkFilter<'_>) -> String {
        format!("{:b}:{:?}", filter.mask, filter.is_complete_regex())
    }
    fn select(&self, filter: &NetworkFilter<'_>) -> bool {
        is_filter_optimizable_by_patterns(filter)
    }
}

/*
struct UnionDomainGroup {}

impl Optimization for UnionDomainGroup {
    fn fusion<'a>(&self, filters: &[NetworkFilter<'a>]) -> NetworkFilter<'a> {
        let base_filter = &filters[0]; // FIXME: can technically panic, if filters list is empty
        let mut filter = base_filter.clone();
        let mut domains = HashSet::new();
        let mut not_domains = HashSet::new();

        filters.iter().for_each(|f| {
            if let Some(opt_domains) = f.opt_domains.as_ref() {
                for d in opt_domains {
                    domains.insert(d);
                }
            }
            if let Some(opt_not_domains) = f.opt_not_domains.as_ref() {
                for d in opt_not_domains {
                    not_domains.insert(d);
                }
            }
        });

        if !domains.is_empty() {
            let mut domains = domains.into_iter().cloned().collect::<Vec<_>>();
            domains.sort_unstable();
            filter.opt_domains = Some(domains);
        }
        if !not_domains.is_empty() {
            let mut domains = not_domains.into_iter().cloned().collect::<Vec<_>>();
            domains.sort_unstable();
            let opt_not_domains_union = Some(domains.iter().fold(0, |acc, x| acc | x));
            filter.opt_not_domains = Some(domains);
            filter.opt_not_domains_union = opt_not_domains_union;
        }

        if base_filter.raw_line.is_some() {
            filter.raw_line = Some(Cow::Owned(
                filters
                    .iter()
                    .flat_map(|f| f.raw_line.as_deref())
                    .join(" <+> "),
            ))
        }

        filter
    }

    fn group_by_criteria(&self, filter: &NetworkFilter<'_>) -> String {
        format!(
            "{:?}:{}:{:b}:{:?}",
            filter.hostname.as_ref(),
            filter.filter.string_view().unwrap_or_default(),
            filter.mask,
            filter.modifier_option.as_ref()
        )
    }

    fn select(&self, filter: &NetworkFilter<'_>) -> bool {
        !filter.is_csp() && (filter.opt_domains.is_some() || filter.opt_not_domains.is_some())
    }
}
*/

#[cfg(test)]
#[path = "../tests/unit/optimizer.rs"]
mod unit_tests;
