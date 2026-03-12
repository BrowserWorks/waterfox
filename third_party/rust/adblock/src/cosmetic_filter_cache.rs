//! Provides behavior related to cosmetic filtering - that is, modifying a page's contents after
//! it's been loaded into a browser. This is primarily used to hide or clean up unwanted page
//! elements that are served inline with the rest of the first-party content from a page, but can
//! also be used to inject JavaScript "scriptlets" that intercept and modify the behavior of
//! scripts on the page at runtime.
//!
//! The primary API exposed by this module is the `CosmeticFilterCache` struct, which stores
//! cosmetic filters and allows them to be queried efficiently at runtime for any which may be
//! relevant to a particular page.
//! To build `CosmeticFilterCache`, use `CosmeticFilterCacheBuilder`.

use crate::cosmetic_filter_utils::decode_script_with_permission;
#[cfg(test)]
use crate::filters::cosmetic::CosmeticFilter;
use crate::filters::cosmetic::{CosmeticFilterAction, CosmeticFilterOperator};
use crate::filters::filter_data_context::FilterDataContextRef;

use crate::flatbuffers::containers::flat_map::FlatMapView;
use crate::flatbuffers::containers::flat_multimap::FlatMultiMapView;
use crate::flatbuffers::containers::hash_map::HashMapStringView;
use crate::flatbuffers::containers::hash_set::HashSetView;
use crate::flatbuffers::unsafe_tools::fb_vector_to_slice;
use crate::resources::{PermissionMask, ResourceStorage};

use crate::utils::Hash;

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

/// Contains cosmetic filter information intended to be used on a particular URL.
#[derive(Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct UrlSpecificResources {
    /// `hide_selectors` is a set of any CSS selector on the page that should be hidden, i.e.
    /// styled as `{ display: none !important; }`.
    pub hide_selectors: HashSet<String>,
    /// Set of JSON-encoded procedural filters or filters with an action.
    pub procedural_actions: HashSet<String>,
    /// `exceptions` is a set of any class or id CSS selectors that should not have generic rules
    /// applied. In practice, these should be passed to `class_id_stylesheet` and not used
    /// otherwise.
    pub exceptions: HashSet<String>,
    /// `injected_script` is the Javascript code for any scriptlets that should be injected into
    /// the page.
    pub injected_script: String,
    /// `generichide` is set to true if there is a corresponding `$generichide` exception network
    /// filter. If so, the page should not query for additional generic rules using
    /// `hidden_class_id_selectors`.
    pub generichide: bool,
}

impl UrlSpecificResources {
    pub fn empty() -> Self {
        Self {
            hide_selectors: HashSet::new(),
            procedural_actions: HashSet::new(),
            exceptions: HashSet::new(),
            injected_script: String::new(),
            generichide: false,
        }
    }
}

/// The main engine driving cosmetic filtering.
///
/// There are two primary methods that should be considered when using this in a browser:
/// `hidden_class_id_selectors`, and `url_cosmetic_resources`.
///
/// Note that cosmetic filtering is imprecise and that this structure is intenionally designed for
/// efficient querying in the context of a browser, optimizing for low memory usage in the page
/// context and good performance. It is *not* designed to provide a 100% accurate report of what
/// will be blocked on any particular page, although when used correctly, all provided rules and
/// scriptlets should be safe to apply.
pub(crate) struct CosmeticFilterCache {
    filter_data_context: FilterDataContextRef,
}

/// Representations of filters with complex behavior that relies on in-page JS logic.
///
/// These get stored in-memory as JSON and should be deserialized/acted on by a content script.
/// JSON is pragmatic here since there are relatively fewer of these type of rules, and they will
/// be handled by in-page JS anyways.
#[derive(Deserialize, Serialize, Clone)]
pub struct ProceduralOrActionFilter {
    /// A selector for elements that this filter applies to.
    /// This may be a plain CSS selector, or it can consist of multiple procedural operators.
    pub selector: Vec<CosmeticFilterOperator>,
    /// An action to apply to matching elements.
    /// If no action is present, the filter assumes default behavior of hiding the element with
    /// a style of `display: none !important`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<CosmeticFilterAction>,
}

impl ProceduralOrActionFilter {
    /// Returns `(selector, style)` if the filter can be expressed in pure CSS.
    pub fn as_css(&self) -> Option<(String, String)> {
        match (&self.selector[..], &self.action) {
            ([CosmeticFilterOperator::CssSelector(selector)], None) => {
                Some((selector.to_string(), "display: none !important".to_string()))
            }
            (
                [CosmeticFilterOperator::CssSelector(selector)],
                Some(CosmeticFilterAction::Style(style)),
            ) => Some((selector.to_string(), style.to_string())),
            _ => None,
        }
    }

    /// Convenience constructor for pure CSS style filters.
    #[cfg(test)]
    pub(crate) fn from_css(selector: String, style: String) -> Self {
        Self {
            selector: vec![CosmeticFilterOperator::CssSelector(selector)],
            action: Some(CosmeticFilterAction::Style(style)),
        }
    }
}

fn hostname_domain_hashes(hostname: &str, domain: &str) -> (Vec<Hash>, Vec<Hash>) {
    let request_entities =
        crate::filters::cosmetic::get_entity_hashes_from_labels(hostname, domain);
    let request_hostnames =
        crate::filters::cosmetic::get_hostname_hashes_from_labels(hostname, domain);

    (request_entities, request_hostnames)
}

impl CosmeticFilterCache {
    pub fn from_context(filter_data_context: FilterDataContextRef) -> Self {
        Self {
            filter_data_context,
        }
    }

    #[cfg(test)]
    pub fn from_rules(rules: Vec<CosmeticFilter>) -> Self {
        use crate::engine::Engine;
        use crate::FilterSet;

        let mut filter_set = FilterSet::new(true);
        filter_set.cosmetic_filters = rules;
        let engine = Engine::from_filter_set(filter_set, true);
        engine.cosmetic_cache()
    }

    /// Generic class/id rules are by far the most common type of cosmetic filtering rule, and they
    /// apply to all sites. Rather than injecting all of these rules onto every page, which would
    /// blow up memory usage, we only inject rules based on classes and ids that actually appear on
    /// the page (in practice, a `MutationObserver` is used to identify those elements). We can
    /// include rules like `.a-class div#ads > .advertisement`, keyed by the `.a-class` selector,
    /// since we know that this rule cannot possibly apply unless there is an `.a-class` element on
    /// the page.
    ///
    /// This method returns all of the generic CSS selectors of elements to hide (i.e. with a
    /// `display: none !important` CSS rule) that could possibly be or become relevant to the page
    /// given the new classes and ids that have appeared on the page. It guarantees that it will be
    /// safe to hide those elements on a particular page by taking into account the page's
    /// hostname-specific set of exception rules.
    ///
    /// The exceptions should be returned directly as they appear in the page's
    /// `UrlSpecificResources`. The exceptions, along with the set of already-seen classes and ids,
    /// must be cached externally as the cosmetic filtering subsystem here is designed to be
    /// stateless with regard to active page sessions.
    pub fn hidden_class_id_selectors(
        &self,
        classes: impl IntoIterator<Item = impl AsRef<str>>,
        ids: impl IntoIterator<Item = impl AsRef<str>>,
        exceptions: &HashSet<String>,
    ) -> Vec<String> {
        let mut selectors = vec![];

        let cosmetic_filters = self.filter_data_context.memory.root().cosmetic_filters();
        let simple_class_rules = HashSetView::new(cosmetic_filters.simple_class_rules());
        let simple_id_rules = HashSetView::new(cosmetic_filters.simple_id_rules());
        let complex_class_rules = HashMapStringView::new(
            cosmetic_filters.complex_class_rules_index(),
            cosmetic_filters.complex_class_rules_values(),
        );
        let complex_id_rules = HashMapStringView::new(
            cosmetic_filters.complex_id_rules_index(),
            cosmetic_filters.complex_id_rules_values(),
        );

        classes.into_iter().for_each(|class| {
            let class = class.as_ref();
            if simple_class_rules.contains(class) && !exceptions.contains(&format!(".{class}")) {
                selectors.push(format!(".{class}"));
            }
            if let Some(values) = complex_class_rules.get(class) {
                for sel in values.data() {
                    if !exceptions.contains(sel) {
                        selectors.push(sel.to_string());
                    }
                }
            }
        });
        ids.into_iter().for_each(|id| {
            let id = id.as_ref();
            if simple_id_rules.contains(id) && !exceptions.contains(&format!("#{id}")) {
                selectors.push(format!("#{id}"));
            }
            if let Some(values) = complex_id_rules.get(id) {
                for sel in values.data() {
                    if !exceptions.contains(sel) {
                        selectors.push(sel.to_string());
                    }
                }
            }
        });

        selectors
    }

    /// Any rules that can't be handled by `hidden_class_id_selectors` are returned by
    /// `hostname_cosmetic_resources`. As soon as a page navigation is committed, this method
    /// should be queried to get the initial set of cosmetic filtering operations to apply to the
    /// page. This provides any rules specifying elements to hide by selectors that are too complex
    /// to be returned by `hidden_class_id_selectors` (i.e. not directly starting with a class or
    /// id selector, like `div[class*="Ads"]`), or any rule that is only applicable to a particular
    /// hostname or set of hostnames (like `example.com##.a-class`). The first category is always
    /// injected into every page, and makes up a relatively small number of rules in practice.
    pub fn hostname_cosmetic_resources(
        &self,
        resources: &ResourceStorage,
        hostname: &str,
        generichide: bool,
    ) -> UrlSpecificResources {
        let domain_str = {
            let (start, end) = crate::url_parser::get_host_domain(hostname);
            &hostname[start..end]
        };

        let (request_entities, request_hostnames) = hostname_domain_hashes(hostname, domain_str);

        let mut specific_hide_selectors = HashSet::new();
        let mut procedural_actions = HashSet::new();
        let mut script_injections = HashMap::<&str, PermissionMask>::new();
        let mut exceptions = HashSet::new();

        let mut except_all_scripts = false;

        let hashes: Vec<&Hash> = request_entities
            .iter()
            .chain(request_hostnames.iter())
            .collect();

        let cosmetic_filters = self.filter_data_context.memory.root().cosmetic_filters();
        let hostname_rules_view = FlatMapView::new(
            fb_vector_to_slice(cosmetic_filters.hostname_index()),
            cosmetic_filters.hostname_values(),
        );
        let hostname_hide_view = FlatMultiMapView::new(
            fb_vector_to_slice(cosmetic_filters.hostname_hide_index()),
            cosmetic_filters.hostname_hide_values(),
        );
        let hostname_inject_script_view = FlatMultiMapView::new(
            fb_vector_to_slice(cosmetic_filters.hostname_inject_script_index()),
            cosmetic_filters.hostname_inject_script_values(),
        );

        for hash in hashes.iter() {
            // Handle top-level hide selectors
            if let Some(hide_iterator) = hostname_hide_view.get(**hash) {
                for hide_selector in hide_iterator {
                    if !exceptions.contains(hide_selector) {
                        specific_hide_selectors.insert(hide_selector.to_owned());
                    }
                }
            }

            // Handle top-level inject scripts with encoded permissions
            if let Some(script_iterator) = hostname_inject_script_view.get(**hash) {
                for encoded_script in script_iterator {
                    let (permission, script) = decode_script_with_permission(encoded_script);
                    script_injections
                        .entry(script)
                        .and_modify(|entry| *entry |= permission)
                        .or_insert(permission);
                }
            }

            // Handle remaining rule types from HostnameSpecificRules
            if let Some(hostname_rules) = hostname_rules_view.get(**hash) {
                // Process procedural actions
                if let Some(procedural_actions_rules) = hostname_rules.procedural_action() {
                    for action in procedural_actions_rules.iter() {
                        procedural_actions.insert(action.to_owned());
                    }
                }
            }
        }

        // Process unhide/exception filters
        for hash in hashes.iter() {
            if let Some(hostname_rules) = hostname_rules_view.get(**hash) {
                // Process unhide selectors (special behavior: they also go in exceptions)
                if let Some(unhide_rules) = hostname_rules.unhide() {
                    for selector in unhide_rules.iter() {
                        specific_hide_selectors.remove(selector);
                        exceptions.insert(selector.to_owned());
                    }
                }

                // Process procedural action exceptions
                if let Some(procedural_exceptions) = hostname_rules.procedural_action_exception() {
                    for action in procedural_exceptions.iter() {
                        procedural_actions.remove(action);
                    }
                }

                // Process script uninjects
                if let Some(uninject_scripts) = hostname_rules.uninject_script() {
                    for script in uninject_scripts.iter() {
                        if script.is_empty() {
                            except_all_scripts = true;
                            script_injections.clear();
                        }
                        if except_all_scripts {
                            continue;
                        }
                        script_injections.remove(script);
                    }
                }
            }
        }

        let hide_selectors = if generichide {
            specific_hide_selectors
        } else {
            let cosmetic_filters = self.filter_data_context.memory.root().cosmetic_filters();
            let misc_generic_selectors_vector = cosmetic_filters.misc_generic_selectors();

            // Calculate the intersection of the two sets, O(n * log m) time
            let mut hide_selectors = HashSet::new();
            for selector in misc_generic_selectors_vector.iter() {
                if !exceptions.contains(selector) {
                    hide_selectors.insert(selector.to_string());
                }
            }
            specific_hide_selectors.into_iter().for_each(|sel| {
                hide_selectors.insert(sel);
            });
            hide_selectors
        };

        let injected_script = resources.get_scriptlet_resources(script_injections);

        UrlSpecificResources {
            hide_selectors,
            procedural_actions,
            exceptions,
            injected_script,
            generichide,
        }
    }
}

#[cfg(test)]
#[path = "../tests/unit/cosmetic_filter_cache.rs"]
mod unit_tests;
