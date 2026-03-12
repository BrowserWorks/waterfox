//! Contains methods useful for building [`Resource`] descriptors from resources directly from
//! files in the uBlock Origin repository.

use crate::resources::{MimeType, Resource, ResourceType};
use base64::{engine::Engine as _, prelude::BASE64_STANDARD};
use memchr::memmem;
use once_cell::sync::Lazy;
use regex::Regex;
use std::fs::File;
use std::io::Read;
use std::path::Path;

static TOP_COMMENT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"^/\*[\S\s]+?\n\*/\s*"#).unwrap());
static NON_EMPTY_LINE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"\S"#).unwrap());

/// Represents a single entry of the `Map` from uBlock Origin's `redirect-resources.js`.
struct ResourceProperties {
    /// The name of a resource, corresponding to its path in the `web_accessible_resources`
    /// directory
    name: String,
    /// A list of optional additional names that can be used to reference the resource
    alias: Vec<String>,
    /// Either `"text"` or `"blob"`, but is currently unused in `adblock-rust`. Within uBlock
    /// Origin, it's used to prevent text files from being encoded in base64 in a data URL.
    #[allow(unused)]
    data: Option<String>,
}

/// The deserializable represenation of the `alias` field of a resource's properties, which can
/// either be a single string or a list of strings.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum ResourceAliasField {
    SingleString(String),
    ListOfStrings(Vec<String>),
}

impl ResourceAliasField {
    fn into_vec(self) -> Vec<String> {
        match self {
            Self::SingleString(s) => vec![s],
            Self::ListOfStrings(l) => l,
        }
    }
}

/// Directly deserializable representation of a resource's properties from `redirect-resources.js`.
#[derive(serde::Deserialize)]
struct JsResourceProperties {
    #[serde(default)]
    alias: Option<ResourceAliasField>,
    #[serde(default)]
    data: Option<String>,
    #[serde(default)]
    params: Option<Vec<String>>,
}

/// Maps the name of the resource to its properties in a 2-element tuple.
type JsResourceEntry = (String, JsResourceProperties);

const REDIRECTABLE_RESOURCES_DECLARATION: &str = "export default new Map([";
//  ]);
static MAP_END_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#"^\s*\]\s*\)"#).unwrap());

static TRAILING_COMMA_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r#",([\],\}])"#).unwrap());
static UNQUOTED_FIELD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"([\{,])([a-zA-Z][a-zA-Z0-9_]*):"#).unwrap());
// Avoid matching a starting `/*` inside a string
static TRAILING_BLOCK_COMMENT_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"\s*/\*[^'"]*\*/\s*$"#).unwrap());

/// Reads data from a a file in the format of uBlock Origin's `redirect-resources.js` file to
/// determine the files in the `web_accessible_resources` directory, as well as any of their
/// aliases.
///
/// This is read from the exported `Map`.
fn read_redirectable_resource_mapping(mapfile_data: &str) -> Vec<ResourceProperties> {
    // This isn't bulletproof, but it should handle the historical versions of the mapping
    // correctly, and having a strict JSON parser should catch any unexpected format changes. Plus,
    // it prevents dependending on a full JS engine.

    // Extract just the map. It's between REDIRECTABLE_RESOURCES_DECLARATION and MAP_END_RE.
    let mut map: String = mapfile_data
        .lines()
        .skip_while(|line| *line != REDIRECTABLE_RESOURCES_DECLARATION)
        .take_while(|line| !MAP_END_RE.is_match(line))
        // Strip any trailing comments from each line.
        .map(|line| {
            if let Some(i) = memmem::find(line.as_bytes(), b"//") {
                &line[..i]
            } else {
                line
            }
        })
        .map(|line| TRAILING_BLOCK_COMMENT_RE.replace_all(line, ""))
        // Remove all newlines from the entire string.
        .fold(String::new(), |s, line| s + &line);

    // Add back the final square brace that was omitted above as part of MAP_END_RE.
    map.push(']');

    // Trim out the beginning `export default new Map(`.
    // Also, replace all single quote characters with double quotes.
    assert!(map.starts_with(REDIRECTABLE_RESOURCES_DECLARATION));
    map = map[REDIRECTABLE_RESOURCES_DECLARATION.len() - 1..].replace('\'', "\"");

    // Remove all whitespace from the entire string.
    map.retain(|c| !c.is_whitespace());

    // Replace all matches for `,]` or `,}` with `]` or `}`, respectively.
    map = TRAILING_COMMA_RE
        .replace_all(&map, |caps: &regex::Captures| caps[1].to_string())
        .to_string();

    // Replace all property keys directly preceded by a `{` or a `,` and followed by a `:` with
    // double-quoted versions.
    map = UNQUOTED_FIELD_RE
        .replace_all(&map, |caps: &regex::Captures| {
            format!("{}\"{}\":", &caps[1], &caps[2])
        })
        .to_string();

    // It *should* be valid JSON now, so parse it with serde_json.
    let parsed: Vec<JsResourceEntry> = serde_json::from_str(&map).unwrap();

    parsed
        .into_iter()
        .filter_map(|(name, props)| {
            // Ignore resources with params for now, since there's no support for them currently.
            if props.params.is_some() {
                None
            } else {
                Some(ResourceProperties {
                    name,
                    alias: props.alias.map(|a| a.into_vec()).unwrap_or_default(),
                    data: props.data,
                })
            }
        })
        .collect()
}

/// Reads data from a file in the form of uBlock Origin's `scriptlets.js` file and produces
/// templatable scriptlets for use in cosmetic filtering.
fn read_template_resources(scriptlets_data: &str) -> Vec<Resource> {
    let mut resources = Vec::new();

    let uncommented = TOP_COMMENT_RE.replace_all(scriptlets_data, "");
    let mut name: Option<&str> = None;
    let mut details = std::collections::HashMap::<_, Vec<_>>::new();
    let mut script = String::new();

    for line in uncommented.lines() {
        if line.starts_with('#') || line.starts_with("// ") || line == "//" {
            continue;
        }

        if name.is_none() {
            if let Some(stripped) = line.strip_prefix("/// ") {
                name = Some(stripped.trim());
            }
            continue;
        }

        if let Some(stripped) = line.strip_prefix("/// ") {
            let mut line = stripped.split_whitespace();
            let prop = line.next().expect("Detail line has property name");
            let value = line.next().expect("Detail line has property value");
            details
                .entry(prop)
                .and_modify(|v| v.push(value))
                .or_insert_with(|| vec![value]);
            continue;
        }

        if NON_EMPTY_LINE_RE.is_match(line) {
            script += line.trim();
            script.push('\n');
            continue;
        }

        let kind = if script.contains("{{1}}") {
            ResourceType::Template
        } else {
            ResourceType::Mime(MimeType::ApplicationJavascript)
        };

        resources.push(Resource {
            name: name.expect("Resource name must be specified").to_owned(),
            aliases: details
                .get("alias")
                .map(|aliases| aliases.iter().map(|alias| alias.to_string()).collect())
                .unwrap_or_default(),
            kind,
            content: BASE64_STANDARD.encode(&script),
            dependencies: vec![],
            permission: Default::default(),
        });

        name = None;
        details.clear();
        script.clear();
    }

    resources
}

/// Reads byte data from an arbitrary resource file, and assembles a `Resource` from it with the
/// provided `resource_info`.
fn build_resource_from_file_contents(
    resource_contents: &[u8],
    resource_info: &ResourceProperties,
) -> Resource {
    let name = resource_info.name.to_owned();
    let aliases = resource_info
        .alias
        .iter()
        .map(|alias| alias.to_string())
        .collect();
    let mimetype = MimeType::from_extension(&resource_info.name[..]);
    let content = match mimetype {
        MimeType::ApplicationJavascript | MimeType::TextHtml | MimeType::TextPlain => {
            let utf8string = std::str::from_utf8(resource_contents).unwrap();
            BASE64_STANDARD.encode(utf8string.replace('\r', ""))
        }
        _ => BASE64_STANDARD.encode(resource_contents),
    };

    Resource {
        name,
        aliases,
        kind: ResourceType::Mime(mimetype),
        content,
        dependencies: vec![],
        permission: Default::default(),
    }
}

/// Produces a `Resource` from the `web_accessible_resource_dir` directory according to the
/// information in `resource_info.
fn read_resource_from_web_accessible_dir(
    web_accessible_resource_dir: &Path,
    resource_info: &ResourceProperties,
) -> Resource {
    let resource_path = web_accessible_resource_dir.join(&resource_info.name);
    if !resource_path.is_file() {
        panic!("Expected {resource_path:?} to be a file");
    }
    let mut resource_file = File::open(resource_path).expect("open resource file for reading");
    let mut resource_contents = Vec::new();
    resource_file
        .read_to_end(&mut resource_contents)
        .expect("read resource file contents");

    build_resource_from_file_contents(&resource_contents, resource_info)
}

/// Builds a `Vec` of `Resource`s from the specified paths on the filesystem:
///
/// - `web_accessible_resource_dir`: A folder full of resource files
///
/// - `redirect_resources_path`: A file in the format of uBlock Origin's `redirect-resources.js`
///   containing an index of the resources in `web_accessible_resource_dir`
///
/// The resulting resources can be serialized into JSON using `serde_json`.
pub fn assemble_web_accessible_resources(
    web_accessible_resource_dir: &Path,
    redirect_resources_path: &Path,
) -> Vec<Resource> {
    let mapfile_data = std::fs::read_to_string(redirect_resources_path).expect("read aliases path");
    let resource_properties = read_redirectable_resource_mapping(&mapfile_data);

    resource_properties
        .iter()
        .map(|resource_info| {
            read_resource_from_web_accessible_dir(web_accessible_resource_dir, resource_info)
        })
        .collect()
}

/// Parses the _old_ format of uBlock Origin templated scriptlet resources, prior to
/// <https://github.com/gorhill/uBlock/commit/18a84d2819d49444fc31c5350677ecc5b2ec73c6>.
///
/// The newer format is intended to be imported as an ES module, making line-based parsing even
/// more complex and error-prone. Instead, it's recommended to transform them into [Resource]s
/// using JS code. A short prelude containing an array of `[{{1}}, {{2}}, {{3}}, ...]` can be used
/// to backport the newer scriptlet format into the older one; the new one will be directly
/// supported in a future update.
///
/// - `scriptlets_path`: A file in the format of uBlock Origin's `scriptlets.js` containing
///   templatable scriptlet files for use in cosmetic filtering
#[deprecated]
pub fn assemble_scriptlet_resources(scriptlets_path: &Path) -> Vec<Resource> {
    let scriptlets_data = std::fs::read_to_string(scriptlets_path).expect("read scriptlets path");
    read_template_resources(&scriptlets_data)
}

#[cfg(test)]
#[path = "../../tests/unit/resources/resource_assembler.rs"]
mod unit_tests;
