//! The adblock [`Engine`] is the primary interface for adblocking.

use crate::blocker::{Blocker, BlockerResult};
use crate::cosmetic_filter_cache::{CosmeticFilterCache, UrlSpecificResources};
use crate::cosmetic_filter_cache_builder::CosmeticFilterCacheBuilder;
use crate::data_format::{deserialize_dat_file, serialize_dat_file, DeserializationError};
use crate::filters::cosmetic::CosmeticFilter;
use crate::filters::fb_builder::EngineFlatBuilder;
use crate::filters::fb_network_builder::NetworkRulesBuilder;
use crate::filters::filter_data_context::{FilterDataContext, FilterDataContextRef};
use crate::filters::network::NetworkFilter;
use crate::flatbuffers::containers::flat_serialize::FlatSerialize;
use crate::flatbuffers::unsafe_tools::VerifiedFlatbufferMemory;
use crate::lists::{FilterSet, ParseOptions};
use crate::regex_manager::RegexManagerDiscardPolicy;
use crate::request::Request;
use crate::resources::{Resource, ResourceStorage, ResourceStorageBackend};

use std::collections::HashSet;

/// Drives high-level blocking logic and is responsible for loading filter lists into an optimized
/// format that can be queried efficiently.
///
/// For performance optimization reasons, the [`Engine`] is not designed to have rules added or
/// removed after its initial creation. Making changes to the rules loaded is accomplished by
/// creating a new engine to replace it.
///
/// ## Usage
///
/// ### Initialization
///
/// You'll first want to combine all of your filter lists in a [`FilterSet`], which will parse list
/// header metadata. Once all lists have been composed together, you can call
/// [`Engine::from_filter_set`] to start using them for blocking.
///
/// You may also want to supply certain assets for `$redirect` filters and `##+js(...)` scriptlet
/// injections. These are known as [`Resource`]s, and can be provided with
/// [`Engine::use_resources`]. See the [`crate::resources`] module for more information.
///
/// ### Network blocking
///
/// Use the [`Engine::check_network_request`] method to determine how to handle a network request.
///
/// If you _only_ need network blocking, consider using a [`Blocker`] directly.
///
/// ### Cosmetic filtering
///
/// Call [`Engine::url_cosmetic_resources`] to determine what actions should be taken to prepare a
/// particular page before it starts loading.
///
/// Once the page has been loaded, any new CSS classes or ids that appear on the page should be passed to
/// [`Engine::hidden_class_id_selectors`] on an ongoing basis to determine additional elements that
/// should be hidden dynamically.
pub struct Engine {
    blocker: Blocker,
    cosmetic_cache: CosmeticFilterCache,
    resources: ResourceStorage,
    filter_data_context: FilterDataContextRef,
}

#[cfg(feature = "debug-info")]
pub struct EngineDebugInfo {
    pub regex_debug_info: crate::regex_manager::RegexDebugInfo,
    pub flatbuffer_size: usize,
}

impl Default for Engine {
    fn default() -> Self {
        Self::from_filter_set(FilterSet::new(false), false)
    }
}

impl Engine {
    /// Loads rules in a single format, enabling optimizations and discarding debug information.
    pub fn from_rules(
        rules: impl IntoIterator<Item = impl AsRef<str>>,
        opts: ParseOptions,
    ) -> Self {
        let mut filter_set = FilterSet::new(false);
        filter_set.add_filters(rules, opts);
        Self::from_filter_set(filter_set, true)
    }

    /// Loads rules, enabling optimizations and including debug information.
    pub fn from_rules_debug(
        rules: impl IntoIterator<Item = impl AsRef<str>>,
        opts: ParseOptions,
    ) -> Self {
        Self::from_rules_parametrised(rules, opts, true, true)
    }

    pub fn from_rules_parametrised(
        filter_rules: impl IntoIterator<Item = impl AsRef<str>>,
        opts: ParseOptions,
        debug: bool,
        optimize: bool,
    ) -> Self {
        let mut filter_set = FilterSet::new(debug);
        filter_set.add_filters(filter_rules, opts);
        Self::from_filter_set(filter_set, optimize)
    }

    #[cfg(test)]
    pub(crate) fn cosmetic_cache(self) -> CosmeticFilterCache {
        self.cosmetic_cache
    }

    #[cfg(test)]
    pub(crate) fn filter_data_context(self) -> FilterDataContextRef {
        self.filter_data_context
    }

    /// Loads rules from the given `FilterSet`. It is recommended to use a `FilterSet` when adding
    /// rules from multiple sources.
    pub fn from_filter_set(set: FilterSet, optimize: bool) -> Self {
        let FilterSet {
            network_filters,
            cosmetic_filters,
            ..
        } = set;

        let memory = make_flatbuffer(network_filters, cosmetic_filters, optimize);

        let filter_data_context = FilterDataContext::new(memory);

        Self {
            blocker: Blocker::from_context(FilterDataContextRef::clone(&filter_data_context)),
            cosmetic_cache: CosmeticFilterCache::from_context(FilterDataContextRef::clone(
                &filter_data_context,
            )),
            resources: ResourceStorage::default(),
            filter_data_context,
        }
    }

    /// Check if a request for a network resource from `url`, of type `request_type`, initiated by
    /// `source_url`, should be blocked.
    pub fn check_network_request(&self, request: &Request) -> BlockerResult {
        self.blocker.check(request, &self.resources)
    }

    #[cfg(test)]
    pub(crate) fn check_network_request_exceptions(&self, request: &Request) -> bool {
        self.blocker.check_exceptions(request)
    }

    pub fn check_network_request_subset(
        &self,
        request: &Request,
        previously_matched_rule: bool,
        force_check_exceptions: bool,
    ) -> BlockerResult {
        self.blocker.check_parameterised(
            request,
            &self.resources,
            previously_matched_rule,
            force_check_exceptions,
        )
    }

    /// Returns a string containing any additional CSP directives that should be added to this
    /// request's response. Only applies to document and subdocument requests.
    ///
    /// If multiple policies are present from different rules, they will be joined by commas.
    pub fn get_csp_directives(&self, request: &Request) -> Option<String> {
        self.blocker.get_csp_directives(request)
    }

    /// Sets this engine's tags to be _only_ the ones provided in `tags`.
    ///
    /// Tags can be used to cheaply enable or disable network rules with a corresponding `$tag`
    /// option.
    pub fn use_tags(&mut self, tags: &[&str]) {
        self.blocker.use_tags(tags);
    }

    /// Sets this engine's tags to additionally include the ones provided in `tags`.
    ///
    /// Tags can be used to cheaply enable or disable network rules with a corresponding `$tag`
    /// option.
    pub fn enable_tags(&mut self, tags: &[&str]) {
        self.blocker.enable_tags(tags);
    }

    /// Sets this engine's tags to no longer include the ones provided in `tags`.
    ///
    /// Tags can be used to cheaply enable or disable network rules with a corresponding `$tag`
    /// option.
    pub fn disable_tags(&mut self, tags: &[&str]) {
        self.blocker.disable_tags(tags);
    }

    /// Checks if a given tag exists in this engine.
    ///
    /// Tags can be used to cheaply enable or disable network rules with a corresponding `$tag`
    /// option.
    pub fn tag_exists(&self, tag: &str) -> bool {
        self.blocker.tags_enabled().contains(&tag.to_owned())
    }

    /// Sets this engine's [Resource]s to be _only_ the ones provided in `resources`.
    ///
    /// The resources will be held in-memory. If you have special caching, management, or sharing
    /// requirements, consider [Engine::use_resource_storage] instead.
    pub fn use_resources(&mut self, resources: impl IntoIterator<Item = Resource>) {
        let storage = crate::resources::InMemoryResourceStorage::from_resources(resources);
        self.use_resource_storage(storage);
    }

    /// Sets this engine's backend for [Resource] storage to a custom implementation of
    /// [ResourceStorageBackend].
    ///
    /// If you're okay with the [Engine] holding these resources in-memory, use
    /// [Engine::use_resources] instead.
    #[cfg(not(feature = "single-thread"))]
    pub fn use_resource_storage<R: ResourceStorageBackend + 'static + Sync + Send>(
        &mut self,
        resources: R,
    ) {
        self.resources = ResourceStorage::from_backend(resources);
    }

    /// Sets this engine's backend for [Resource] storage to a custom implementation of
    /// [ResourceStorageBackend].
    ///
    /// If you're okay with the [Engine] holding these resources in-memory, use
    /// [Engine::use_resources] instead.
    #[cfg(feature = "single-thread")]
    pub fn use_resource_storage<R: ResourceStorageBackend + 'static>(&mut self, resources: R) {
        self.resources = ResourceStorage::from_backend(resources);
    }

    // Cosmetic filter functionality

    /// If any of the provided CSS classes or ids could cause a certain generic CSS hide rule
    /// (i.e. `{ display: none !important; }`) to be required, this method will return a list of
    /// CSS selectors corresponding to rules referencing those classes or ids, provided that the
    /// corresponding rules are not excepted.
    ///
    /// `exceptions` should be passed directly from `UrlSpecificResources`.
    pub fn hidden_class_id_selectors(
        &self,
        classes: impl IntoIterator<Item = impl AsRef<str>>,
        ids: impl IntoIterator<Item = impl AsRef<str>>,
        exceptions: &HashSet<String>,
    ) -> Vec<String> {
        self.cosmetic_cache
            .hidden_class_id_selectors(classes, ids, exceptions)
    }

    /// Returns a set of cosmetic filter resources required for a particular url. Once this has
    /// been called, all CSS ids and classes on a page should be passed to
    /// `hidden_class_id_selectors` to obtain any stylesheets consisting of generic rules (if the
    /// returned `generichide` value is false).
    pub fn url_cosmetic_resources(&self, url: &str) -> UrlSpecificResources {
        let request = if let Ok(request) = Request::new(url, url, "document") {
            request
        } else {
            return UrlSpecificResources::empty();
        };

        let generichide = self.blocker.check_generic_hide(&request);
        self.cosmetic_cache.hostname_cosmetic_resources(
            &self.resources,
            &request.hostname,
            generichide,
        )
    }

    pub fn set_regex_discard_policy(&mut self, new_discard_policy: RegexManagerDiscardPolicy) {
        self.blocker.set_regex_discard_policy(new_discard_policy);
    }

    #[cfg(test)]
    pub fn borrow_regex_manager(&self) -> crate::blocker::RegexManagerRef<'_> {
        self.blocker.borrow_regex_manager()
    }

    #[cfg(feature = "debug-info")]
    pub fn discard_regex(&mut self, regex_id: u64) {
        self.blocker.discard_regex(regex_id);
    }

    #[cfg(feature = "debug-info")]
    pub fn get_debug_info(&self) -> EngineDebugInfo {
        EngineDebugInfo {
            regex_debug_info: self.blocker.get_regex_debug_info(),
            flatbuffer_size: self.filter_data_context.memory.data().len(),
        }
    }

    /// Serializes the `Engine` into a binary format so that it can be quickly reloaded later.
    pub fn serialize(&self) -> Vec<u8> {
        let data = self.filter_data_context.memory.data();
        serialize_dat_file(data)
    }

    /// Deserialize the `Engine` from the binary format generated by `Engine::serialize`.
    ///
    /// Note that the binary format has a built-in version number that may be incremented. There is
    /// no guarantee that later versions of the format will be deserializable across minor versions
    /// of adblock-rust; the format is provided only as a caching optimization.
    pub fn deserialize(&mut self, serialized: &[u8]) -> Result<(), DeserializationError> {
        let current_tags = self.blocker.tags_enabled();

        let data = deserialize_dat_file(serialized)?;
        let memory = VerifiedFlatbufferMemory::from_raw(data)
            .map_err(DeserializationError::FlatBufferParsingError)?;

        let context = FilterDataContext::new(memory);
        self.filter_data_context = context;
        self.blocker =
            Blocker::from_context(FilterDataContextRef::clone(&self.filter_data_context));
        self.blocker
            .use_tags(&current_tags.iter().map(|s| &**s).collect::<Vec<_>>());
        self.cosmetic_cache = CosmeticFilterCache::from_context(FilterDataContextRef::clone(
            &self.filter_data_context,
        ));
        Ok(())
    }
}

/// Static assertions for `Engine: Send + Sync` traits.
#[cfg(not(feature = "single-thread"))]
fn _assertions() {
    fn _assert_send<T: Send>() {}
    fn _assert_sync<T: Sync>() {}

    _assert_send::<Engine>();
    _assert_sync::<Engine>();
}

fn make_flatbuffer(
    network_filters: Vec<NetworkFilter>,
    cosmetic_filters: Vec<CosmeticFilter>,
    optimize: bool,
) -> VerifiedFlatbufferMemory {
    let mut builder = EngineFlatBuilder::default();
    let network_rules_builder = NetworkRulesBuilder::from_rules(network_filters, optimize);
    let network_rules = FlatSerialize::serialize(network_rules_builder, &mut builder);
    let cosmetic_rules = CosmeticFilterCacheBuilder::from_rules(cosmetic_filters, &mut builder);
    let cosmetic_rules = FlatSerialize::serialize(cosmetic_rules, &mut builder);
    builder.finish(network_rules, cosmetic_rules)
}

#[cfg(test)]
#[path = "../tests/unit/engine.rs"]
mod unit_tests;
