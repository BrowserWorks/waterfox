//! In adblocking terms, [`Resource`]s are special placeholder scripts, images,
//! video files, etc. that can be returned as drop-in replacements for harmful
//! equivalents from remote servers. Resources also encompass scriptlets, which
//! can be injected into pages to inhibit malicious behavior.
//!
//! If the `resource-assembler` feature is enabled, the
#![cfg_attr(not(feature = "resource-assembler"), doc = "`resource_assembler`")]
#![cfg_attr(feature = "resource-assembler", doc = "[`resource_assembler`]")]
//! module will assist with the construction of [`Resource`]s directly from the uBlock Origin
//! project.

#[cfg(feature = "resource-assembler")]
pub mod resource_assembler;

mod resource_storage;
pub(crate) use resource_storage::parse_scriptlet_args;
#[doc(inline)]
pub use resource_storage::{
    AddResourceError, InMemoryResourceStorage, ResourceImpl, ResourceStorage,
    ResourceStorageBackend, ScriptletResourceError,
};

use memchr::memrchr as find_char_reverse;
use serde::{Deserialize, Serialize};

/// Specifies a set of permissions required to inject a scriptlet resource.
///
/// Permissions can be specified when parsing individual lists using [`crate::FilterSet`] in
/// order to propagate the permission level to all filters contained in the list.
///
/// In practice, permissions are used to limit the risk of third-party lists having access to
/// powerful scriptlets like uBlock Origin's `trusted-set-cookie`, which has the ability to set
/// arbitrary cookies to arbitrary values on visited sites.
///
/// ### Example
///
/// ```
/// # use adblock::Engine;
/// # use adblock::lists::ParseOptions;
/// # use adblock::resources::{MimeType, PermissionMask, Resource, ResourceStorage, ResourceType};
/// # let mut filter_set = adblock::lists::FilterSet::default();
/// # let untrusted_filters = vec![""];
/// # let trusted_filters = vec![""];
/// const COOKIE_ACCESS: PermissionMask = PermissionMask::from_bits(0b00000001);
/// const LOCALSTORAGE_ACCESS: PermissionMask = PermissionMask::from_bits(0b00000010);
///
/// // `untrusted_filters` will not be able to use privileged scriptlet injections.
/// filter_set.add_filters(
///     untrusted_filters,
///     Default::default(),
/// );
/// // `trusted_filters` will be able to inject scriptlets requiring `COOKIE_ACCESS`
/// // permissions or `LOCALSTORAGE_ACCESS` permissions.
/// filter_set.add_filters(
///     trusted_filters,
///     ParseOptions {
///         permissions: COOKIE_ACCESS | LOCALSTORAGE_ACCESS,
///         ..Default::default()
///     },
/// );
///
/// let mut engine = Engine::from_filter_set(filter_set, true);
/// // The `trusted-set-cookie` scriptlet cannot be injected without `COOKIE_ACCESS`
/// // permission.
/// engine.use_resources([Resource {
///     name: "trusted-set-cookie.js".to_string(),
///     aliases: vec![],
///     kind: ResourceType::Mime(MimeType::ApplicationJavascript),
///     content: base64::encode("document.cookie = '...';"),
///     dependencies: vec![],
///     permission: COOKIE_ACCESS,
/// }]);
/// ```
#[derive(Serialize, Deserialize, Clone, Copy, Default)]
#[repr(transparent)]
#[serde(transparent)]
pub struct PermissionMask(u8);

impl std::fmt::Debug for PermissionMask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "PermissionMask({:b})", self.0)
    }
}

impl core::ops::BitOr<PermissionMask> for PermissionMask {
    type Output = PermissionMask;

    fn bitor(self, rhs: PermissionMask) -> Self::Output {
        Self(self.0 | rhs.0)
    }
}

impl core::ops::BitOrAssign<PermissionMask> for PermissionMask {
    fn bitor_assign(&mut self, rhs: PermissionMask) {
        self.0 |= rhs.0;
    }
}

impl PermissionMask {
    /// Construct a new [`PermissionMask`] with the given bitmask. Use
    /// [`PermissionMask::default()`] instead if you don't want to restrict or grant any
    /// permissions.
    pub const fn from_bits(bits: u8) -> Self {
        Self(bits)
    }

    pub fn to_bits(&self) -> u8 {
        self.0
    }

    /// Can `filter_mask` authorize injecting a resource requiring `self` permissions?
    pub fn is_injectable_by(&self, filter_mask: PermissionMask) -> bool {
        // For any particular bit index, the scriptlet is injectable if:
        //  (there is a requirement, AND the filter meets it) OR (there's no requirement)
        // in other words:
        //  (self & filter_mask) | (!self) == 1
        //  (self | !self) & (filter_mask | !self) == 1
        //  filter_mask | !self == 1
        //  !(filter_mask | !self) == 0
        //  !filter_mask & self == 0
        // which we can compare across *all* bits using bitwise operations, hence:
        !filter_mask.0 & self.0 == 0
    }

    /// The default value for [`PermissionMask`] is one which provides no additional permissions.
    fn is_default(&self) -> bool {
        self.0 == 0
    }
}

/// Struct representing a resource that can be used by an adblocking engine.
#[derive(Serialize, Deserialize, Clone)]
pub struct Resource {
    /// Represents the primary name of the resource, often a filename
    pub name: String,
    /// Represents secondary names that can be used to access the resource
    #[serde(default)]
    pub aliases: Vec<String>,
    /// How to interpret the resource data within `content`
    pub kind: ResourceType,
    /// The resource data, encoded using standard base64 configuration
    pub content: String,
    /// Optionally contains the name of any dependencies used by this resource. Currently, this
    /// only applies to `application/javascript` and `fn/javascript` MIME types.
    ///
    /// Aliases should never be added to this list. It should only contain primary/canonical
    /// resource names.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<String>,
    /// Optionally defines permission levels required to use this resource for a scriptlet
    /// injection. See [`PermissionMask`] for more details.
    ///
    /// If there is any customized permission, this resource cannot be used for redirects.
    ///
    /// This field is similar to the `requiresTrust` field from uBlock Origin's scriptlet
    /// resources, except that it supports up to 8 different trust "domains".
    #[serde(default, skip_serializing_if = "PermissionMask::is_default")]
    pub permission: PermissionMask,
}

impl Resource {
    /// Convenience constructor for tests. Creates a new [`Resource`] with no aliases or
    /// dependencies. Content will be automatically base64-encoded by the constructor.
    #[cfg(test)]
    pub fn simple(name: &str, kind: MimeType, content: &str) -> Self {
        use base64::{engine::Engine as _, prelude::BASE64_STANDARD};
        Self {
            name: name.to_string(),
            aliases: vec![],
            kind: ResourceType::Mime(kind),
            content: BASE64_STANDARD.encode(content),
            dependencies: vec![],
            permission: Default::default(),
        }
    }
}

/// Different ways that the data within the `content` field of a `Resource` can be interpreted.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ResourceType {
    /// Interpret the data according to the MIME type represented by `type`
    Mime(MimeType),
    /// Interpret the data as a Javascript scriptlet template, with embedded template
    /// parameters in the form of `{{1}}`, `{{2}}`, etc. Note that `Mime(ApplicationJavascript)`
    /// can still be used as a templated resource, for compatibility purposes.
    Template,
}

impl ResourceType {
    /// Can resources of this type be used as network redirects?
    pub fn supports_redirect(&self) -> bool {
        !matches!(
            self,
            ResourceType::Template | ResourceType::Mime(MimeType::FnJavascript)
        )
    }

    /// Can resources of this type be used for scriptlet injections?
    pub fn supports_scriptlet_injection(&self) -> bool {
        matches!(
            self,
            ResourceType::Template | ResourceType::Mime(MimeType::ApplicationJavascript)
        )
    }
}

/// Acceptable MIME types for resources used by `$redirect` and `+js(...)` adblock rules.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(into = "&str")]
#[serde(from = "std::borrow::Cow<'static, str>")]
pub enum MimeType {
    /// `"text/css"`
    TextCss,
    /// `"image/gif"`
    ImageGif,
    /// `"text/html"`
    TextHtml,
    /// `"application/javascript"`
    ApplicationJavascript,
    /// `"application/json"`
    ApplicationJson,
    /// `"audio/mp3"`
    AudioMp3,
    /// `"video/mp4"`
    VideoMp4,
    /// `"image/png"`
    ImagePng,
    /// `"text/plain"`
    TextPlain,
    /// `"text/xml"`
    TextXml,
    /// Custom MIME type invented for the uBlock Origin project. Represented by `"fn/javascript"`.
    /// Used to describe JavaScript functions that can be used as dependencies of other JavaScript
    /// resources.
    FnJavascript,
    /// Any other unhandled MIME type. Maps to `"application/octet-stream"` when re-serialized.
    Unknown,
}

impl MimeType {
    /// Infers a resource's MIME type according to the extension of its path
    pub fn from_extension(resource_path: &str) -> Self {
        if let Some(extension_index) = find_char_reverse(b'.', resource_path.as_bytes()) {
            match &resource_path[extension_index + 1..] {
                "css" => MimeType::TextCss,
                "gif" => MimeType::ImageGif,
                "html" => MimeType::TextHtml,
                "js" => MimeType::ApplicationJavascript,
                "json" => MimeType::ApplicationJson,
                "mp3" => MimeType::AudioMp3,
                "mp4" => MimeType::VideoMp4,
                "png" => MimeType::ImagePng,
                "txt" => MimeType::TextPlain,
                "xml" => MimeType::TextXml,
                _ => {
                    #[cfg(test)]
                    eprintln!("Unrecognized file extension on: {resource_path:?}");
                    MimeType::Unknown
                }
            }
        } else {
            MimeType::Unknown
        }
    }

    /// Should the MIME type decode as valid UTF8?
    pub fn is_textual(&self) -> bool {
        matches!(
            self,
            Self::ApplicationJavascript
                | Self::FnJavascript
                | Self::ApplicationJson
                | Self::TextCss
                | Self::TextPlain
                | Self::TextHtml
                | Self::TextXml
        )
    }

    /// Can the MIME type have dependencies on other resources?
    pub fn supports_dependencies(&self) -> bool {
        matches!(self, Self::ApplicationJavascript | Self::FnJavascript)
    }
}

impl From<&str> for MimeType {
    fn from(v: &str) -> Self {
        match v {
            "text/css" => MimeType::TextCss,
            "image/gif" => MimeType::ImageGif,
            "text/html" => MimeType::TextHtml,
            "application/javascript" => MimeType::ApplicationJavascript,
            "application/json" => MimeType::ApplicationJson,
            "audio/mp3" => MimeType::AudioMp3,
            "video/mp4" => MimeType::VideoMp4,
            "image/png" => MimeType::ImagePng,
            "text/plain" => MimeType::TextPlain,
            "text/xml" => MimeType::TextXml,
            "fn/javascript" => MimeType::FnJavascript,
            _ => MimeType::Unknown,
        }
    }
}

impl From<&MimeType> for &str {
    fn from(v: &MimeType) -> Self {
        match v {
            MimeType::TextCss => "text/css",
            MimeType::ImageGif => "image/gif",
            MimeType::TextHtml => "text/html",
            MimeType::ApplicationJavascript => "application/javascript",
            MimeType::ApplicationJson => "application/json",
            MimeType::AudioMp3 => "audio/mp3",
            MimeType::VideoMp4 => "video/mp4",
            MimeType::ImagePng => "image/png",
            MimeType::TextPlain => "text/plain",
            MimeType::TextXml => "text/xml",
            MimeType::FnJavascript => "fn/javascript",
            MimeType::Unknown => "application/octet-stream",
        }
    }
}

// Required for `#[serde(from = "std::borrow::Cow<'static, str>")]`
impl From<std::borrow::Cow<'static, str>> for MimeType {
    fn from(v: std::borrow::Cow<'static, str>) -> Self {
        v.as_ref().into()
    }
}

// Required for `#[serde(into = &str)]`
impl From<MimeType> for &str {
    fn from(v: MimeType) -> Self {
        (&v).into()
    }
}

impl std::fmt::Display for MimeType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s: &str = self.into();
        write!(f, "{s}")
    }
}

#[cfg(test)]
mod permission_tests {
    use super::*;

    #[test]
    fn test_permissions() {
        {
            let resource = PermissionMask(0b00000000);
            assert!(resource.is_injectable_by(PermissionMask(0b00000000)));
            assert!(resource.is_injectable_by(PermissionMask(0b00000001)));
            assert!(resource.is_injectable_by(PermissionMask(0b00000010)));
            assert!(resource.is_injectable_by(PermissionMask(0b00000011)));
            assert!(resource.is_injectable_by(PermissionMask(0b10000000)));
            assert!(resource.is_injectable_by(PermissionMask(0b11111111)));
        }
        {
            let resource = PermissionMask(0b00000001);
            assert!(!resource.is_injectable_by(PermissionMask(0b00000000)));
            assert!(resource.is_injectable_by(PermissionMask(0b00000001)));
            assert!(!resource.is_injectable_by(PermissionMask(0b00000010)));
            assert!(resource.is_injectable_by(PermissionMask(0b00000011)));
            assert!(!resource.is_injectable_by(PermissionMask(0b10000000)));
            assert!(resource.is_injectable_by(PermissionMask(0b11111111)));
        }
        {
            let resource = PermissionMask(0b00000010);
            assert!(!resource.is_injectable_by(PermissionMask(0b00000000)));
            assert!(!resource.is_injectable_by(PermissionMask(0b00000001)));
            assert!(resource.is_injectable_by(PermissionMask(0b00000010)));
            assert!(resource.is_injectable_by(PermissionMask(0b00000011)));
            assert!(!resource.is_injectable_by(PermissionMask(0b10000000)));
            assert!(resource.is_injectable_by(PermissionMask(0b11111111)));
        }
        {
            let resource = PermissionMask(0b00000011);
            assert!(!resource.is_injectable_by(PermissionMask(0b00000000)));
            assert!(!resource.is_injectable_by(PermissionMask(0b00000001)));
            assert!(!resource.is_injectable_by(PermissionMask(0b00000010)));
            assert!(resource.is_injectable_by(PermissionMask(0b00000011)));
            assert!(!resource.is_injectable_by(PermissionMask(0b10000000)));
            assert!(resource.is_injectable_by(PermissionMask(0b11111111)));
        }
        {
            let resource = PermissionMask(0b10000011);
            assert!(!resource.is_injectable_by(PermissionMask(0b00000000)));
            assert!(!resource.is_injectable_by(PermissionMask(0b00000001)));
            assert!(!resource.is_injectable_by(PermissionMask(0b00000010)));
            assert!(!resource.is_injectable_by(PermissionMask(0b00000011)));
            assert!(!resource.is_injectable_by(PermissionMask(0b10000000)));
            assert!(resource.is_injectable_by(PermissionMask(0b11111111)));
        }
    }
}
