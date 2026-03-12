//! Provides API to prepare and serialize cosmetic filter rules to a flatbuffer.
//! To build the struct, use `CosmeticFilterCacheBuilder`.
//! To use the serialized rules, use `CosmeticFilterCache`.

use crate::cosmetic_filter_cache::ProceduralOrActionFilter;
use crate::cosmetic_filter_utils::SpecificFilterType;
use crate::cosmetic_filter_utils::{encode_script_with_permission, key_from_selector};
use crate::filters::cosmetic::{CosmeticFilter, CosmeticFilterMask, CosmeticFilterOperator};
use crate::filters::fb_builder::{EngineFlatBuilder, ShareableString};
use crate::filters::flatbuffer_generated::fb;
use crate::flatbuffers::containers::flat_map::FlatMapBuilder;
use crate::flatbuffers::containers::flat_multimap::FlatMultiMapBuilder;
use crate::flatbuffers::containers::hash_map::HashMapBuilder;
use crate::flatbuffers::containers::hash_set::HashSetBuilder;

use crate::flatbuffers::containers::flat_serialize::{
    serialize_vec_opt, FlatBuilder, FlatSerialize,
};

use crate::utils::Hash;

use std::collections::{HashMap, HashSet};

use flatbuffers::WIPOffset;

/// Accumulates hostname-specific rules for a single domain before building HostnameSpecificRules
/// Note: hide and inject_script are now handled separately at the top level
/// See HostnameSpecificRules declaration for more details.
#[derive(Default)]
struct HostnameRule {
    unhide: Vec<ShareableString>,
    uninject_script: Vec<ShareableString>,
    procedural_action: Vec<ShareableString>,
    procedural_action_exception: Vec<ShareableString>,
}

impl<'a> FlatSerialize<'a, EngineFlatBuilder<'a>> for HostnameRule {
    type Output = WIPOffset<fb::HostnameSpecificRules<'a>>;

    fn serialize(
        value: Self,
        builder: &mut EngineFlatBuilder<'a>,
    ) -> flatbuffers::WIPOffset<fb::HostnameSpecificRules<'a>> {
        let unhide = serialize_vec_opt(value.unhide, builder);
        let uninject_script = serialize_vec_opt(value.uninject_script, builder);
        let procedural_action = serialize_vec_opt(value.procedural_action, builder);
        let procedural_action_exception =
            serialize_vec_opt(value.procedural_action_exception, builder);

        fb::HostnameSpecificRules::create(
            builder.raw_builder(),
            &fb::HostnameSpecificRulesArgs {
                unhide,
                uninject_script,
                procedural_action,
                procedural_action_exception,
            },
        )
    }
}

#[derive(Default, Clone)]
struct StringVector(Vec<String>);

#[derive(Default)]
pub(crate) struct CosmeticFilterCacheBuilder {
    simple_class_rules: HashSetBuilder<String>,
    simple_id_rules: HashSetBuilder<String>,
    misc_generic_selectors: HashSet<String>,
    complex_class_rules: HashMapBuilder<String, StringVector>,
    complex_id_rules: HashMapBuilder<String, StringVector>,

    hostname_hide: FlatMultiMapBuilder<Hash, ShareableString>,
    hostname_inject_script: FlatMultiMapBuilder<Hash, ShareableString>,

    specific_rules: HashMap<Hash, HostnameRule>,
}

impl CosmeticFilterCacheBuilder {
    pub fn from_rules(rules: Vec<CosmeticFilter>, builder: &mut EngineFlatBuilder) -> Self {
        let mut self_ = Self::default();

        for rule in rules {
            self_.add_filter(rule, builder);
        }

        self_
    }

    pub fn add_filter(&mut self, rule: CosmeticFilter, builder: &mut EngineFlatBuilder) {
        if rule.has_hostname_constraint() {
            if let Some(generic_rule) = rule.hidden_generic_rule() {
                self.add_generic_filter(generic_rule);
            }
            self.store_hostname_rule(rule, builder);
        } else {
            self.add_generic_filter(rule);
        }
    }

    /// Add a filter, assuming it has already been determined to be a generic rule
    fn add_generic_filter(&mut self, rule: CosmeticFilter) {
        let selector = match rule.plain_css_selector() {
            Some(s) => s.to_string(),
            None => {
                // Procedural cosmetic filters cannot be generic.
                // Silently ignoring this filter.
                return;
            }
        };

        if selector.starts_with('.') {
            if let Some(key) = key_from_selector(&selector) {
                assert!(key.starts_with('.'));
                let class = key[1..].to_string();
                if key == selector {
                    self.simple_class_rules.insert(class);
                } else {
                    let selectors = self
                        .complex_class_rules
                        .get_or_insert(class, StringVector::default());
                    selectors.0.push(selector);
                }
            }
        } else if selector.starts_with('#') {
            if let Some(key) = key_from_selector(&selector) {
                assert!(key.starts_with('#'));
                let id = key[1..].to_string();
                if key == selector {
                    self.simple_id_rules.insert(id);
                } else {
                    let selectors = self
                        .complex_id_rules
                        .get_or_insert(id, StringVector::default());
                    selectors.0.push(selector);
                }
            }
        } else {
            self.misc_generic_selectors.insert(selector);
        }
    }

    fn store_hostname_rule(&mut self, rule: CosmeticFilter, builder: &mut EngineFlatBuilder) {
        use SpecificFilterType::*;

        let unhide = rule.mask.contains(CosmeticFilterMask::UNHIDE);
        let script_inject = rule.mask.contains(CosmeticFilterMask::SCRIPT_INJECT);

        let kind = match (
            script_inject,
            rule.plain_css_selector().map(|s| s.to_string()),
            rule.action,
        ) {
            (false, Some(selector), None) => Hide(selector),
            (true, Some(selector), None) => InjectScript((selector, rule.permission)),
            (false, selector, action) => ProceduralOrAction(
                serde_json::to_string(&ProceduralOrActionFilter {
                    selector: selector
                        .map(|selector| vec![CosmeticFilterOperator::CssSelector(selector)])
                        .unwrap_or(rule.selector),
                    action,
                })
                .unwrap(),
            ),
            (true, _, Some(_)) => return, // script injection with action - shouldn't be possible
            (true, None, _) => return, // script injection without plain CSS selector - shouldn't be possible
        };

        let kind = if unhide { kind.negated() } else { kind };

        let tokens_to_insert = std::iter::empty()
            .chain(rule.hostnames.unwrap_or_default())
            .chain(rule.entities.unwrap_or_default());

        self.store_hostname_filter(tokens_to_insert, &kind, builder);

        let negated = kind.negated();
        let tokens_to_insert_negated = std::iter::empty()
            .chain(rule.not_hostnames.unwrap_or_default())
            .chain(rule.not_entities.unwrap_or_default());

        self.store_hostname_filter(tokens_to_insert_negated, &negated, builder);
    }

    fn store_hostname_filter(
        &mut self,
        tokens: impl IntoIterator<Item = Hash>,
        kind: &SpecificFilterType,
        builder: &mut EngineFlatBuilder,
    ) {
        use SpecificFilterType::*;

        match kind {
            // Handle hide and inject_script at top level for better deduplication
            Hide(s) => {
                let mut shareable_string = None;
                for token in tokens {
                    let s = shareable_string.get_or_insert_with(|| builder.add_shareable_string(s));
                    self.hostname_hide.insert(token, s.clone());
                }
            }
            InjectScript((s, permission)) => {
                let mut shareable_string = None;
                for token in tokens {
                    let s = shareable_string.get_or_insert_with(|| {
                        builder.add_shareable_string(&encode_script_with_permission(s, permission))
                    });
                    self.hostname_inject_script.insert(token, s.clone());
                }
            }
            // Handle remaining types through HostnameRule
            Unhide(s) => {
                let mut shareable_string = None;
                for token in tokens {
                    let s = shareable_string.get_or_insert_with(|| builder.add_shareable_string(s));
                    let entry = self.specific_rules.entry(token).or_default();
                    entry.unhide.push(s.clone());
                }
            }
            UninjectScript((s, _)) => {
                let mut shareable_string = None;
                for token in tokens {
                    let s = shareable_string.get_or_insert_with(|| builder.add_shareable_string(s));
                    let entry = self.specific_rules.entry(token).or_default();
                    entry.uninject_script.push(s.clone());
                }
            }
            ProceduralOrAction(s) => {
                let mut shareable_string = None;
                for token in tokens {
                    let s = shareable_string.get_or_insert_with(|| builder.add_shareable_string(s));
                    let entry = self.specific_rules.entry(token).or_default();
                    entry.procedural_action.push(s.clone());
                }
            }
            ProceduralOrActionException(s) => {
                let mut shareable_string = None;
                for token in tokens {
                    let s = shareable_string.get_or_insert_with(|| builder.add_shareable_string(s));
                    let entry = self.specific_rules.entry(token).or_default();
                    entry.procedural_action_exception.push(s.clone());
                }
            }
        }
    }
}

impl<'a, B: FlatBuilder<'a>> FlatSerialize<'a, B> for StringVector {
    type Output = WIPOffset<fb::StringVector<'a>>;

    fn serialize(value: Self, builder: &mut B) -> WIPOffset<fb::StringVector<'a>> {
        let v = FlatSerialize::serialize(value.0, builder);
        fb::StringVector::create(
            builder.raw_builder(),
            &fb::StringVectorArgs { data: Some(v) },
        )
    }
}

impl<'a> FlatSerialize<'a, EngineFlatBuilder<'a>> for CosmeticFilterCacheBuilder {
    type Output = WIPOffset<fb::CosmeticFilters<'a>>;

    fn serialize(
        value: Self,
        builder: &mut EngineFlatBuilder<'a>,
    ) -> WIPOffset<fb::CosmeticFilters<'a>> {
        let complex_class_rules = HashMapBuilder::finish(value.complex_class_rules, builder);
        let complex_id_rules = HashMapBuilder::finish(value.complex_id_rules, builder);

        // Handle top-level hostname hide and inject_script for better deduplication
        let hostname_hide = FlatMultiMapBuilder::finish(value.hostname_hide, builder);
        let hostname_inject_script =
            FlatMultiMapBuilder::finish(value.hostname_inject_script, builder);

        // Handle remaining rule types through HostnameSpecificRules
        let hostname_specific_rules = FlatMapBuilder::finish(value.specific_rules, builder);

        let simple_class_rules = Some(FlatSerialize::serialize(value.simple_class_rules, builder));
        let simple_id_rules = Some(FlatSerialize::serialize(value.simple_id_rules, builder));
        let misc_generic_selectors = Some(FlatSerialize::serialize(
            value.misc_generic_selectors,
            builder,
        ));

        fb::CosmeticFilters::create(
            builder.raw_builder(),
            &fb::CosmeticFiltersArgs {
                simple_class_rules,
                simple_id_rules,
                misc_generic_selectors,
                complex_class_rules_index: Some(complex_class_rules.keys),
                complex_class_rules_values: Some(complex_class_rules.values),
                complex_id_rules_index: Some(complex_id_rules.keys),
                complex_id_rules_values: Some(complex_id_rules.values),
                hostname_hide_index: Some(hostname_hide.keys),
                hostname_hide_values: Some(hostname_hide.values),
                hostname_inject_script_index: Some(hostname_inject_script.keys),
                hostname_inject_script_values: Some(hostname_inject_script.values),
                hostname_index: Some(hostname_specific_rules.keys),
                hostname_values: Some(hostname_specific_rules.values),
            },
        )
    }
}
