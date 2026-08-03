//! The adblock [`Engine`] is the primary interface for adblocking.

use crate::blocker::{Blocker, BlockerResult};
use crate::cosmetic_filter_cache::{CosmeticFilterCache, UrlSpecificResources};
use crate::cosmetic_filter_cache_builder::CosmeticFilterCacheBuilder;
use crate::data_format::{deserialize_dat_file, serialize_dat_file};
use crate::filters::fb_builder::EngineFlatBuilder;
use crate::filters::fb_network_builder::{NetworkFilterDebugData, NetworkRulesBuilder};
use crate::filters::filter_data_context::{FilterDataContext, FilterDataContextRef};
use crate::filters::flatbuffer_generated::fb;
use crate::flatbuffers::containers::flat_serialize::{FlatBuilder, FlatSerialize};
use crate::flatbuffers::unsafe_tools::VerifiedFlatbufferMemory;
use crate::lists::{FilterSet, ParseOptions, ParsedLine, parse_filter};
use crate::regex_manager::RegexManagerDiscardPolicy;
use crate::request::Request;
use crate::resources::{Resource, ResourceStorage, ResourceStorageBackend};

pub use crate::data_format::DeserializationError;

use crate::filters::{cosmetic::CosmeticFilter, network::NetworkFilter};

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
/// [`Engine::new_with_filter_set`] to start using them for blocking.
///
/// You may also want to supply certain assets for `$redirect` filters and `##+js(...)` scriptlet
/// injections. These are known as [`Resource`]s, and can be provided with
/// [`Engine::use_resources`]. See the [`crate::resources`] module for more information.
///
/// ### Network blocking
///
/// Use the [`Engine::check_network_request`] method to determine how to handle a network request.
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
pub struct SourceInfo {
    pub title: Option<String>,
    pub homepage: Option<String>,
    pub network_filter_count: u32,
    pub cosmetic_filter_count: u32,
    pub parse_error: u32,
    pub invalid_lines: Vec<String>,
}

#[cfg(feature = "debug-info")]
pub struct EngineDebugInfo {
    pub regex_debug_info: crate::regex_manager::RegexDebugInfo,
    pub flatbuffer_size: usize,
    pub source_info: Vec<SourceInfo>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new_with_filter_set(FilterSet::new(false))
    }
}

impl Engine {
    /// A helper for tests and benchmarks. Use [`Engine::new_with_filter_set`] instead.
    #[doc(hidden)]
    pub fn new_with_list_text(list_text: impl Into<String>) -> Self {
        let mut filter_set = FilterSet::new(false);
        filter_set.add_filter_list(list_text.into(), ParseOptions::default());
        Self::new_with_filter_set(filter_set)
    }

    #[cfg(test)]
    pub(crate) fn cosmetic_cache(self) -> CosmeticFilterCache {
        self.cosmetic_cache
    }

    #[cfg(test)]
    pub(crate) fn filter_data_context(self) -> FilterDataContextRef {
        self.filter_data_context
    }

    /// A helper for tests and benchmarks. Use [`Engine::new_with_filter_set`] instead.
    #[doc(hidden)]
    pub fn new_with_parsed_rules(
        network_filters: Vec<NetworkFilter>,
        cosmetic_filters: Vec<CosmeticFilter>,
    ) -> Self {
        let mut builder = EngineFlatBuilder::default();
        let mut network_rules_builder = NetworkRulesBuilder::new(true);
        let mut cosmetic_filter_cache_builder = CosmeticFilterCacheBuilder::default();

        for filter in network_filters {
            network_rules_builder.add_filter(filter, Default::default(), &mut builder);
        }
        for filter in cosmetic_filters {
            cosmetic_filter_cache_builder.add_filter(filter, &mut builder);
        }

        Self::new_with_flatbuffer_offsets(
            FlatSerialize::serialize(network_rules_builder, &mut builder),
            FlatSerialize::serialize(cosmetic_filter_cache_builder, &mut builder),
            Vec::new(),
            false,
            builder,
        )
    }

    #[doc(hidden)]
    pub fn new_with_filter_set_no_optimize(set: FilterSet) -> Self {
        Self::new_with_filter_set_internal(set, false)
    }

    /// Loads rules from the given `FilterSet`.
    pub fn new_with_filter_set(set: FilterSet) -> Self {
        Self::new_with_filter_set_internal(set, true)
    }

    fn new_with_filter_set_internal(set: FilterSet, optimize: bool) -> Self {
        let FilterSet {
            debug,
            ref list_sources,
        } = set;
        let mut builder = EngineFlatBuilder::default();
        let mut network_rules_builder = NetworkRulesBuilder::new(optimize);
        let mut cosmetic_filter_cache_builder = CosmeticFilterCacheBuilder::default();
        let mut source_info_vec = Vec::new();

        for (source_index, list_source) in set.list_sources.iter().enumerate() {
            let mut network_filter_count = 0;
            let mut cosmetic_filter_count = 0;
            let mut parse_error = 0;
            let mut invalid_lines = Vec::new();
            for (line_number, line) in list_source.list_text.lines().enumerate() {
                let parsed_line = parse_filter(line, debug, list_source.parse_options);
                match parsed_line {
                    Ok(ParsedLine::Network(filter)) => {
                        let debug_data = if debug {
                            NetworkFilterDebugData {
                                source_index: source_index as u32,
                                line_number: line_number as u32,
                            }
                        } else {
                            Default::default()
                        };
                        network_rules_builder.add_filter(filter, debug_data, &mut builder);
                        network_filter_count += 1;
                    }
                    Ok(ParsedLine::Cosmetic(filter)) => {
                        cosmetic_filter_cache_builder.add_filter(filter, &mut builder);
                        cosmetic_filter_count += 1;
                    }
                    Err(_) => {
                        parse_error += 1;
                        if set.debug {
                            invalid_lines.push(line);
                        }
                    }
                }
            }

            let homepage = list_source
                .metadata
                .homepage
                .as_ref()
                .map(|v| builder.create_string(v.as_str()));
            let title = list_source
                .metadata
                .title
                .as_ref()
                .map(|v| builder.create_string(v.as_str()));

            let invalid_lines = if set.debug {
                Some(FlatSerialize::serialize(invalid_lines, &mut builder))
            } else {
                None
            };

            let source_info = fb::SourceInfo::create(
                builder.raw_builder(),
                &fb::SourceInfoArgs {
                    title,
                    homepage,
                    network_filter_count,
                    cosmetic_filter_count,
                    parse_error,
                    invalid_lines,
                },
            );

            source_info_vec.push(source_info);
        }
        let network_rules_offset = FlatSerialize::serialize(network_rules_builder, &mut builder);
        // Drop the list sources to reduce peak memory usage.
        _ = list_sources;

        let cosmetic_rules_offset =
            FlatSerialize::serialize(cosmetic_filter_cache_builder, &mut builder);

        Self::new_with_flatbuffer_offsets(
            network_rules_offset,
            cosmetic_rules_offset,
            source_info_vec,
            debug,
            builder,
        )
    }

    fn new_with_flatbuffer_offsets<'a>(
        network_rules: flatbuffers::WIPOffset<
            flatbuffers::Vector<'a, flatbuffers::ForwardsUOffset<fb::NetworkFilterList<'a>>>,
        >,
        cosmetic_rules: flatbuffers::WIPOffset<fb::CosmeticFilters<'a>>,
        source_info_vec: Vec<flatbuffers::WIPOffset<fb::SourceInfo<'a>>>,
        debug: bool,
        mut builder: EngineFlatBuilder<'a>,
    ) -> Self {
        let source_info_vec = FlatSerialize::serialize(source_info_vec, &mut builder);
        let memory = builder.finish(network_rules, cosmetic_rules, source_info_vec, debug);
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

    /// Like [Self::check_network_request], but with extra options.
    ///
    /// - `previously_matched_rule` can assume the existence of a blocking rule, which would skip
    ///   checking for other blocking rules and immediately look for matching exceptions.
    /// - `force_check_exceptions` can force the engine to _always_ look for and report matching
    ///   exceptions, even if no blocking rule exists.
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
    #[deprecated(note = "Rebuild the engine with or without the relevant filters instead")]
    pub fn use_tags(&mut self, tags: &[&str]) {
        self.blocker.use_tags(tags);
    }

    /// Sets this engine's tags to additionally include the ones provided in `tags`.
    ///
    /// Tags can be used to cheaply enable or disable network rules with a corresponding `$tag`
    /// option.
    #[deprecated(note = "Rebuild the engine with or without the relevant filters instead")]
    pub fn enable_tags(&mut self, tags: &[&str]) {
        self.blocker.enable_tags(tags);
    }

    /// Sets this engine's tags to no longer include the ones provided in `tags`.
    ///
    /// Tags can be used to cheaply enable or disable network rules with a corresponding `$tag`
    /// option.
    #[deprecated(note = "Rebuild the engine with or without the relevant filters instead")]
    pub fn disable_tags(&mut self, tags: &[&str]) {
        self.blocker.disable_tags(tags);
    }

    /// Checks if a given tag exists in this engine.
    ///
    /// Tags can be used to cheaply enable or disable network rules with a corresponding `$tag`
    /// option.
    #[deprecated(note = "Rebuild the engine with or without the relevant filters instead")]
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
        let request = if let Ok(request) = Request::new(url, url, "document", "get") {
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

    pub fn set_regex_discard_policy(&self, new_discard_policy: RegexManagerDiscardPolicy) {
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
        let engine = self.filter_data_context.memory.root();
        let source_info = engine
            .source_info()
            .iter()
            .map(|s| SourceInfo {
                title: s.title().map(|s| s.to_string()),
                homepage: s.homepage().map(|s| s.to_string()),
                network_filter_count: s.network_filter_count() as u32,
                cosmetic_filter_count: s.cosmetic_filter_count() as u32,
                parse_error: s.parse_error() as u32,
                invalid_lines: s
                    .invalid_lines()
                    .map(|v| v.iter().map(|s| s.to_string()).collect())
                    .unwrap_or_default(),
            })
            .collect();
        EngineDebugInfo {
            regex_debug_info: self.blocker.get_regex_debug_info(),
            flatbuffer_size: self.filter_data_context.memory.data().len(),
            source_info,
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

#[cfg(test)]
#[path = "../tests/unit/engine.rs"]
mod unit_tests;
