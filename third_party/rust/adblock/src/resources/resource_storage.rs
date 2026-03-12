//! Storage and retrieval for redirect and scriptlet resources.

use std::collections::HashMap;

use base64::{engine::Engine as _, prelude::BASE64_STANDARD};
use once_cell::sync::Lazy;
use regex::Regex;
use thiserror::Error;

use super::{PermissionMask, Resource, ResourceType};

#[derive(Clone)]
enum ResourceContent {
    /// A valid utf8 string. Used for text/* mime types or for ResourceType:Template
    Text(String),

    /// Raw content in the form of a byte array. Used for other mime types like
    /// "image/gif" or "audio/mp3"
    Raw(Vec<u8>),
}

impl ResourceContent {
    fn text_from_base64(base64: &str) -> Result<Self, AddResourceError> {
        let decoded = BASE64_STANDARD.decode(base64)?;
        Ok(Self::Text(String::from_utf8(decoded)?))
    }

    fn raw_from_base64(base64: &str) -> Result<Self, AddResourceError> {
        let decoded = BASE64_STANDARD.decode(base64)?;
        Ok(Self::Raw(decoded))
    }
}

#[derive(Clone)]
/// A internal representation of a Resource to store. Stores the content
/// in the decoded form to use less memory.
/// See [Resource] for details
pub struct ResourceImpl {
    name: String,
    kind: ResourceType,
    content: ResourceContent,
    dependencies: Vec<String>,
    permission: PermissionMask,
}

/// Unified resource storage for both redirects and scriptlets.
///
/// By default, this uses an in-memory storage implementation, however this can be changed using
/// a custom [ResourceStorageBackend] if desired.
pub struct ResourceStorage {
    #[cfg(not(feature = "single-thread"))]
    backend: Box<dyn ResourceStorageBackend + Sync + Send>,
    #[cfg(feature = "single-thread")]
    backend: Box<dyn ResourceStorageBackend>,
}

/// Loads an empty `InMemoryResourceStorage` backend.
impl Default for ResourceStorage {
    fn default() -> Self {
        Self {
            backend: Box::new(InMemoryResourceStorage::default()),
        }
    }
}

impl ResourceStorage {
    #[cfg(not(feature = "single-thread"))]
    pub fn from_backend<S: ResourceStorageBackend + 'static + Sync + Send>(backend: S) -> Self {
        Self {
            backend: Box::new(backend),
        }
    }

    #[cfg(feature = "single-thread")]
    pub fn from_backend<S: ResourceStorageBackend + 'static>(backend: S) -> Self {
        Self {
            backend: Box::new(backend),
        }
    }

    /// Constructor using an `InMemoryResourceStorage` as the backend with the given resources.
    #[cfg(test)]
    pub fn in_memory_from_resources(resources: impl IntoIterator<Item = Resource>) -> Self {
        Self::from_backend(InMemoryResourceStorage::from_resources(resources))
    }
}

/// Customizable backend for [Resource] storage.
/// Custom implementations could be used to enable (for example) sharing of resources between
/// multiple [crate::Engine]s, an on-disk backend, or special caching behavior.
pub trait ResourceStorageBackend {
    /// Gets the resource associated with `resource_ident`, respecting aliases if necessary.
    fn get_resource(&self, resource_ident: &str) -> Option<ResourceImpl>;
}

/// Default implementation of [ResourceStorageBackend] that stores all resources in memory.
#[derive(Default, Clone)]
pub struct InMemoryResourceStorage {
    /// Stores each resource by its canonical name
    resources: HashMap<String, ResourceImpl>,
    /// Stores mappings from aliases to their canonical resource names
    aliases: HashMap<String, String>,
}

impl ResourceStorageBackend for InMemoryResourceStorage {
    fn get_resource(&self, resource_ident: &str) -> Option<ResourceImpl> {
        let resource = if let Some(resource) = self.resources.get(resource_ident) {
            Some(resource)
        } else if let Some(canonical_name) = self.aliases.get(resource_ident) {
            self.resources.get(canonical_name)
        } else {
            None
        };

        resource.cloned()
    }
}

impl InMemoryResourceStorage {
    /// Convenience constructor that allows building storage for many resources at once. Errors are
    /// silently consumed.
    pub fn from_resources(resources: impl IntoIterator<Item = Resource>) -> Self {
        let mut self_ = Self::default();

        resources.into_iter().for_each(|resource| {
            #[allow(clippy::unnecessary_lazy_evaluations)]
            self_.add_resource(resource).unwrap_or_else(|_e| {
                #[cfg(test)]
                eprintln!("Failed to add resource: {_e:?}")
            })
        });

        self_
    }

    /// Adds a resource to storage so that it can be retrieved later.
    pub fn add_resource(&mut self, resource: Resource) -> Result<(), AddResourceError> {
        let resource_content: ResourceContent;

        if let ResourceType::Mime(content_type) = &resource.kind {
            if !resource.dependencies.is_empty() && !content_type.supports_dependencies() {
                return Err(AddResourceError::ContentTypeDoesNotSupportDependencies);
            }

            if content_type.is_textual() {
                resource_content = ResourceContent::text_from_base64(&resource.content)?;
            } else {
                resource_content = ResourceContent::raw_from_base64(&resource.content)?;
            }
        } else {
            resource_content = ResourceContent::text_from_base64(&resource.content)?;
        }

        for ident in std::iter::once(&resource.name).chain(resource.aliases.iter()) {
            if self.resources.contains_key(ident) || self.aliases.contains_key(ident) {
                return Err(AddResourceError::NameAlreadyAdded);
            }
        }

        resource.aliases.iter().for_each(|alias| {
            self.aliases.insert(alias.clone(), resource.name.clone());
        });
        let resource_impl = ResourceImpl {
            name: resource.name.clone(),
            kind: resource.kind,
            content: resource_content,
            dependencies: resource.dependencies,
            permission: resource.permission,
        };
        self.resources.insert(resource.name, resource_impl);
        Ok(())
    }

    pub fn take_resources(&mut self) -> HashMap<String, ResourceImpl> {
        std::mem::take(&mut self.resources)
    }
}

/// Formats `arg` such that it either is a JSON string, or is safe to insert within a JSON string,
/// depending on `QUOTED`.
///
/// Implementation modified from `json-rust` (MIT license).
/// https://github.com/maciejhirsz/json-rust
#[inline(always)]
fn stringify_arg<const QUOTED: bool>(arg: &str) -> String {
    const QU: u8 = b'"';
    const BS: u8 = b'\\';
    const BB: u8 = b'b';
    const TT: u8 = b't';
    const NN: u8 = b'n';
    const FF: u8 = b'f';
    const RR: u8 = b'r';
    const UU: u8 = b'u';
    const __: u8 = 0;

    // Look up table for characters that need escaping in a product string
    static ESCAPED: [u8; 256] = [
        // 0   1   2   3   4   5   6   7   8   9   A   B   C   D   E   F
        UU, UU, UU, UU, UU, UU, UU, UU, BB, TT, NN, UU, FF, RR, UU, UU, // 0
        UU, UU, UU, UU, UU, UU, UU, UU, UU, UU, UU, UU, UU, UU, UU, UU, // 1
        __, __, QU, __, __, __, __, __, __, __, __, __, __, __, __, __, // 2
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // 3
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // 4
        __, __, __, __, __, __, __, __, __, __, __, __, BS, __, __, __, // 5
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // 6
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // 7
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // 8
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // 9
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // A
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // B
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // C
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // D
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // E
        __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, __, // F
    ];

    #[inline(never)]
    fn write_string_complex(output: &mut Vec<u8>, string: &str, mut start: usize) {
        output.extend_from_slice(&string.as_bytes()[..start]);

        for (index, ch) in string.bytes().enumerate().skip(start) {
            let escape = ESCAPED[ch as usize];
            if escape > 0 {
                output.extend_from_slice(&string.as_bytes()[start..index]);
                output.extend_from_slice(&[b'\\', escape]);
                start = index + 1;
            }
            if escape == b'u' {
                output.extend_from_slice(format!("{ch:04x}").as_bytes());
            }
        }
        output.extend_from_slice(&string.as_bytes()[start..]);
    }

    let mut output = Vec::with_capacity(arg.len() + 2);
    if QUOTED {
        output.push(b'"');
    }

    'process: {
        for (index, ch) in arg.bytes().enumerate() {
            if ESCAPED[ch as usize] > 0 {
                write_string_complex(&mut output, arg, index);
                break 'process;
            }
        }

        output.extend_from_slice(arg.as_bytes());
    }

    if QUOTED {
        output.push(b'"');
    }

    // unwrap safety: input is always valid UTF8; output processing only replaces some ASCII
    // characters with other valid ones
    String::from_utf8(output).unwrap()
}

/// Gets the function name from a JS function definition
fn extract_function_name(fn_def: &str) -> Option<&str> {
    // This is not bulletproof, but should be robust against most issues.
    static FUNCTION_NAME_RE: Lazy<Regex> =
        Lazy::new(|| Regex::new(r#"^function\s+([^\(\)\{\}\s]+)\s*\("#).unwrap());

    FUNCTION_NAME_RE.captures(fn_def).map(|captures| {
        // capture 1 is always present in the above regex if any match was made
        captures.get(1).unwrap().as_str()
    })
}

impl ResourceStorage {
    /// Given the contents of the `+js(...)` parts of multiple filters, return a script string
    /// appropriate for injection in a page.
    pub fn get_scriptlet_resources<'a>(
        &self,
        script_injections: impl IntoIterator<Item = (&'a str, PermissionMask)>,
    ) -> String {
        let mut deps = vec![];
        let mut invokations = String::new();

        script_injections.into_iter().for_each(|(s, mask)| {
            if let Ok(invokation) = self.get_scriptlet_resource(s, mask, &mut deps) {
                invokations += "try {\n";
                invokations += &invokation;
                invokations += "\n} catch ( e ) { }\n";
            }
        });

        let mut result = String::new();

        for dep in deps.iter() {
            if let ResourceContent::Text(content) = &dep.content {
                result += content;
                result += "\n";
            }
        }

        result += &invokations;

        result
    }

    /// Add all dependencies of `new_dep` to `prev_deps`, recursively and uniquely. If the given
    /// permission is insufficient for any dependency, this will return an `Error`.
    ///
    /// Note that no ordering is guaranteed; function definitions in JS can appear after they are
    /// used.
    fn recursive_dependencies(
        &self,
        new_dep: &str,
        prev_deps: &mut Vec<ResourceImpl>,
        filter_permission: PermissionMask,
    ) -> Result<(), ScriptletResourceError> {
        if prev_deps.iter().any(|dep| dep.name == new_dep) {
            return Ok(());
        }

        let resource = self.get_permissioned_resource(new_dep, filter_permission)?;

        let deps = resource.dependencies.clone();
        prev_deps.push(resource);

        for dep in deps.iter() {
            self.recursive_dependencies(dep, prev_deps, filter_permission)?;
        }

        Ok(())
    }

    /// Given the contents of a single `+js(...)` filter part, return a scriptlet string
    /// appropriate for injection in a page.
    fn get_scriptlet_resource(
        &self,
        scriptlet_args: &str,
        filter_permission: PermissionMask,
        required_deps: &mut Vec<ResourceImpl>,
    ) -> Result<String, ScriptletResourceError> {
        // `unwrap` is safe because these are guaranteed valid at filter parsing.
        let scriptlet_args = parse_scriptlet_args(scriptlet_args).unwrap();

        if scriptlet_args.is_empty() {
            return Err(ScriptletResourceError::MissingScriptletName);
        }

        let scriptlet_name = with_js_extension(scriptlet_args[0].as_ref());

        let args = &scriptlet_args[1..];
        if args.len() == 1 && args[0].starts_with('{') && args[0].ends_with('}') {
            return Err(ScriptletResourceError::ScriptletArgObjectSyntaxUnsupported);
        }

        let resource = self.get_permissioned_resource(&scriptlet_name, filter_permission)?;

        if !resource.kind.supports_scriptlet_injection() {
            return Err(ScriptletResourceError::ContentTypeNotInjectable);
        }

        for dep in resource.dependencies.iter() {
            self.recursive_dependencies(dep, required_deps, filter_permission)?;
        }

        let template = match &resource.content {
            ResourceContent::Raw(_content) => {
                return Err(ScriptletResourceError::ContentTypeNotInjectable);
            }
            ResourceContent::Text(content) => content.clone(),
        };

        if let Some(function_name) = extract_function_name(&template) {
            // newer function-style resource: pass args using function call syntax

            // add the scriptlet itself as a dependency and invoke via function name
            if !required_deps.iter().any(|dep| dep.name == resource.name) {
                required_deps.push(resource);
            }

            use itertools::Itertools as _;
            Ok(format!(
                "{}({})",
                function_name,
                args.iter().map(|arg| stringify_arg::<true>(arg)).join(", ")
            ))
        } else {
            // older template-style resource: replace first instances with args
            Ok(patch_template_scriptlet(
                template,
                args.iter().map(|arg| stringify_arg::<false>(arg)),
            ))
        }
    }

    /// Get a data-URL formatted resource appropriate for a `$redirect` response.
    pub fn get_redirect_resource(&self, resource_ident: &str) -> Option<String> {
        let resource = self.backend.get_resource(resource_ident);

        resource.and_then(|resource| {
            if !resource.permission.is_default() {
                return None;
            }
            if !resource.kind.supports_redirect() {
                return None;
            }
            if let ResourceType::Mime(mime) = &resource.kind {
                let bytes = match &resource.content {
                    ResourceContent::Raw(content) => content,
                    ResourceContent::Text(content) => content.as_bytes(),
                };
                let encoded = BASE64_STANDARD.encode(bytes);
                Some(format!("data:{mime};base64,{encoded}"))
            } else {
                None
            }
        })
    }

    fn get_permissioned_resource(
        &self,
        scriptlet_name: &str,
        filter_permission: PermissionMask,
    ) -> Result<ResourceImpl, ScriptletResourceError> {
        let resource = self
            .backend
            .get_resource(scriptlet_name)
            .ok_or(ScriptletResourceError::NoMatchingScriptlet)?;

        if !resource.permission.is_injectable_by(filter_permission) {
            return Err(ScriptletResourceError::InsufficientPermissions);
        }

        Ok(resource)
    }
}

/// Describes failure cases when preparing [`Resource`]s to be used for adblocking.
#[derive(Debug, Error, PartialEq)]
pub enum AddResourceError {
    #[error("invalid base64 content")]
    InvalidBase64Content,
    #[error("invalid utf-8 content")]
    InvalidUtf8Content,
    #[error("resource name already added")]
    NameAlreadyAdded,
    #[error("resource content type does not support dependencies")]
    ContentTypeDoesNotSupportDependencies,
}

impl From<base64::DecodeError> for AddResourceError {
    fn from(_: base64::DecodeError) -> Self {
        AddResourceError::InvalidBase64Content
    }
}

impl From<std::string::FromUtf8Error> for AddResourceError {
    fn from(_: std::string::FromUtf8Error) -> Self {
        AddResourceError::InvalidUtf8Content
    }
}

/// Describes failure cases when attempting to retrieve a resource for scriptlet injection.
#[derive(Debug, Error, PartialEq)]
pub enum ScriptletResourceError {
    #[error("no scriptlet has the provided name")]
    NoMatchingScriptlet,
    #[error("no scriptlet name was provided")]
    MissingScriptletName,
    #[error("object syntax for scriptlet arguments is unsupported")]
    ScriptletArgObjectSyntaxUnsupported,
    #[error("scriptlet content was corrupted")]
    CorruptScriptletContent,
    #[error("resource content type cannot be used for a scriptlet injection")]
    ContentTypeNotInjectable,
    #[error("filter rule is not authorized to inject the intended scriptlet")]
    InsufficientPermissions,
}

impl From<base64::DecodeError> for ScriptletResourceError {
    fn from(_: base64::DecodeError) -> Self {
        Self::CorruptScriptletContent
    }
}

impl From<std::string::FromUtf8Error> for ScriptletResourceError {
    fn from(_: std::string::FromUtf8Error) -> Self {
        Self::CorruptScriptletContent
    }
}

static TEMPLATE_ARGUMENT_RE: [Lazy<Regex>; 9] = [
    Lazy::new(|| template_argument_regex(1)),
    Lazy::new(|| template_argument_regex(2)),
    Lazy::new(|| template_argument_regex(3)),
    Lazy::new(|| template_argument_regex(4)),
    Lazy::new(|| template_argument_regex(5)),
    Lazy::new(|| template_argument_regex(6)),
    Lazy::new(|| template_argument_regex(7)),
    Lazy::new(|| template_argument_regex(8)),
    Lazy::new(|| template_argument_regex(9)),
];

fn template_argument_regex(i: usize) -> Regex {
    Regex::new(&format!(r"\{{\{{{i}\}}\}}")).unwrap()
}

/// Omit the 0th element of `args` (the scriptlet name) when calling this method.
fn patch_template_scriptlet(
    mut template: String,
    args: impl IntoIterator<Item = impl AsRef<str>>,
) -> String {
    // `regex` treats `$` as a special character. Instead, `$$` is interpreted as a literal `$`
    // character.
    args.into_iter()
        .take(TEMPLATE_ARGUMENT_RE.len())
        .enumerate()
        .for_each(|(i, arg)| {
            template = TEMPLATE_ARGUMENT_RE[i]
                .replace(&template, arg.as_ref().replace('$', "$$"))
                .to_string();
        });
    template
}

/// Scriptlet injections must be JS resources. However, the `.js` extension may need to be added as
/// a canonicalization step, since it can be omitted in filter rules.
fn with_js_extension(scriptlet_name: &str) -> String {
    if scriptlet_name.ends_with(".js") {
        scriptlet_name.to_string()
    } else {
        format!("{scriptlet_name}.js")
    }
}

/// Returns the index of the next unescaped separator, as well as a boolean indicating whether or
/// not the string must be postprocessed to normalize any separators along the way.
fn index_next_unescaped_separator(s: &str, separator: char) -> (Option<usize>, bool) {
    assert!(separator != '\\');
    let mut new_arg_end = 0;
    let mut needs_transform = false;
    // guaranteed to terminate:
    // - loop only proceeds if there is an odd number of escape characters
    // - new_arg_end increases by at least 1 in that case
    // - s has finite length
    while new_arg_end < s.len() {
        let rest = &s[new_arg_end..];

        if let Some(i) = rest.find(separator) {
            // check how many escape characters there are before the matched separator
            let mut trailing_escapes = 0;
            while trailing_escapes < i && rest[..i - trailing_escapes].ends_with('\\') {
                trailing_escapes += 1;
            }
            if trailing_escapes % 2 == 0 {
                // even number; all escape characters are literal backslashes
                new_arg_end += i;
                break;
            } else {
                // odd number; the last escape character is escaping this separator
                new_arg_end += i + 1;
                needs_transform = true;
                continue;
            }
        } else {
            // no match
            return (None, needs_transform);
        }
    }
    // don't index beyond the end of the string
    let new_arg_end = if new_arg_end >= s.len() {
        None
    } else {
        Some(new_arg_end)
    };
    (new_arg_end, needs_transform)
}

/// Replaces escaped instances of `separator` in `arg` with unescaped characters.
fn normalize_arg(arg: &str, separator: char) -> String {
    assert!(separator != '\\');

    let mut output = String::with_capacity(arg.len());
    let mut escaped = false;
    for i in arg.chars() {
        if i == '\\' {
            if escaped {
                escaped = false;
                output += "\\\\";
            } else {
                escaped = true;
            }
            continue;
        }

        if escaped {
            if i != separator {
                output.push('\\');
            }
            escaped = false;
        }

        output.push(i);
    }

    output
}

/// Parses the inner contents of a `+js(...)` operator of a cosmetic filter.
///
/// Returns `None` if the contents are malformed.
pub(crate) fn parse_scriptlet_args(mut args: &str) -> Option<Vec<String>> {
    let mut args_vec = vec![];
    if args.trim().is_empty() {
        return Some(args_vec);
    }

    // guaranteed to terminate:
    // - each branch of the `match` consumes at least 1 character from the beginning of `args`
    // - loop exits if `args` is empty
    loop {
        // n.b. `args.trim_start()` leaves an empty string if it's only whitespace
        if let Some(i) = args.find(|c: char| !c.is_whitespace()) {
            args = &args[i..];
        }

        let (arg, needs_transform);

        match args.chars().next() {
            Some(qc) if qc == '"' || qc == '\'' || qc == '`' => {
                args = &args[1..];
                let i;
                (i, needs_transform) = index_next_unescaped_separator(args, qc);
                if let Some(i) = i {
                    arg = &args[..i];
                    args = &args[i + 1..];
                    // consume whitespace following the quote
                    if let Some(i) = args.find(|c: char| !c.is_whitespace()) {
                        args = &args[i..];
                    }
                    // consume comma separator
                    if args.starts_with(',') {
                        args = &args[1..];
                    } else if !args.is_empty() {
                        // uBO pushes everything up to the next comma without escapes, but it's
                        // very weird and probably not what the filter list author intended.
                        // Treating it as an error for now.
                        return None;
                    }
                } else {
                    // uBO pushes the entire argument, including the unmatched quote. Again, weird
                    // and probably not intended.
                    return None;
                }
            }
            Some(_) => {
                let i;
                (i, needs_transform) = index_next_unescaped_separator(args, ',');
                arg = args[..i.unwrap_or(args.len())].trim_end();
                args = &args[i.map(|i| i + 1).unwrap_or(args.len())..];
            }
            None => {
                // `args` is empty
                break;
            }
        }

        let arg = if needs_transform {
            normalize_arg(arg, ',')
        } else {
            arg.to_string()
        };
        args_vec.push(arg);
    }

    Some(args_vec)
}

#[cfg(test)]
#[path = "../../tests/unit/resources/resource_storage.rs"]
mod unit_tests;
