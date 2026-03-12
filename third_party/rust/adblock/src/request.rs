//! Contains structures needed to describe network requests.

use thiserror::Error;

use crate::url_parser;
use crate::utils;

/// The type of resource requested from the URL endpoint.
#[derive(Clone, PartialEq, Debug)]
pub enum RequestType {
    Beacon,
    Csp,
    Document,
    Dtd,
    Fetch,
    Font,
    Image,
    Media,
    Object,
    Other,
    Ping,
    Script,
    Stylesheet,
    Subdocument,
    Websocket,
    Xlst,
    Xmlhttprequest,
}

/// Possible failure reasons when creating a [`Request`].
#[derive(Debug, Error, PartialEq)]
pub enum RequestError {
    #[error("hostname parsing failed")]
    HostnameParseError,
    #[error("source hostname parsing failed")]
    SourceHostnameParseError,
    #[error("invalid Unicode provided")]
    UnicodeDecodingError,
}

impl From<idna::Errors> for RequestError {
    fn from(_err: idna::Errors) -> RequestError {
        RequestError::UnicodeDecodingError
    }
}

impl From<url::ParseError> for RequestError {
    fn from(_err: url::ParseError) -> RequestError {
        RequestError::HostnameParseError
    }
}

fn cpt_match_type(cpt: &str) -> RequestType {
    match cpt {
        "beacon" => RequestType::Ping,
        "csp_report" => RequestType::Csp,
        "document" | "main_frame" => RequestType::Document,
        "font" => RequestType::Font,
        "image" | "imageset" => RequestType::Image,
        "media" => RequestType::Media,
        "object" | "object_subrequest" => RequestType::Object,
        "ping" => RequestType::Ping,
        "script" => RequestType::Script,
        "stylesheet" => RequestType::Stylesheet,
        "sub_frame" | "subdocument" => RequestType::Subdocument,
        "websocket" => RequestType::Websocket,
        "xhr" | "xmlhttprequest" => RequestType::Xmlhttprequest,
        "other" => RequestType::Other,
        "speculative" => RequestType::Other,
        "web_manifest" => RequestType::Other,
        "xbl" => RequestType::Other,
        "xml_dtd" => RequestType::Other,
        "xslt" => RequestType::Other,
        _ => RequestType::Other,
    }
}

/// A network [`Request`], used as an interface for network blocking in the [`crate::Engine`].
#[derive(Clone, Debug)]
pub struct Request {
    pub request_type: RequestType,

    pub is_http: bool,
    pub is_https: bool,
    pub is_supported: bool,
    pub is_third_party: bool,
    pub url: String,
    pub hostname: String,
    pub source_hostname_hashes: Option<Vec<utils::Hash>>,

    pub(crate) url_lower_cased: String,
    pub(crate) request_tokens: Vec<utils::Hash>,
    pub(crate) original_url: String,
}

impl Request {
    pub(crate) fn get_url(&self, case_sensitive: bool) -> &str {
        if case_sensitive {
            &self.url
        } else {
            &self.url_lower_cased
        }
    }

    pub fn get_tokens_for_match(&self) -> impl Iterator<Item = &utils::Hash> {
        // We start matching with source_hostname_hashes for optimization,
        // as it contains far fewer elements.
        self.source_hostname_hashes
            .as_ref()
            .into_iter()
            .flatten()
            .chain(self.get_tokens())
    }

    pub fn get_tokens(&self) -> &Vec<utils::Hash> {
        &self.request_tokens
    }

    #[allow(clippy::too_many_arguments)]
    fn from_detailed_parameters(
        raw_type: &str,
        url: &str,
        schema: &str,
        hostname: &str,
        source_hostname: &str,
        third_party: bool,
        original_url: String,
    ) -> Request {
        let is_http: bool;
        let is_https: bool;
        let is_supported: bool;
        let request_type: RequestType;

        if schema.is_empty() {
            // no ':' was found
            is_https = true;
            is_http = false;
            is_supported = true;
            request_type = cpt_match_type(raw_type);
        } else {
            is_http = schema == "http";
            is_https = !is_http && schema == "https";

            let is_websocket = !is_http && !is_https && (schema == "ws" || schema == "wss");
            is_supported = is_http || is_https || is_websocket;
            if is_websocket {
                request_type = RequestType::Websocket;
            } else {
                request_type = cpt_match_type(raw_type);
            }
        }

        let source_hostname_hashes = if !source_hostname.is_empty() {
            let mut hashes = Vec::with_capacity(4);
            hashes.push(utils::fast_hash(source_hostname));
            for (i, c) in source_hostname.char_indices() {
                if c == '.' && i + 1 < source_hostname.len() {
                    hashes.push(utils::fast_hash(&source_hostname[i + 1..]));
                }
            }
            Some(hashes)
        } else {
            None
        };

        let url_lower_cased = url.to_ascii_lowercase();

        Request {
            request_type,
            url: url.to_owned(),
            url_lower_cased: url_lower_cased.to_owned(),
            hostname: hostname.to_owned(),
            request_tokens: calculate_tokens(&url_lower_cased),
            source_hostname_hashes,
            is_third_party: third_party,
            is_http,
            is_https,
            is_supported,
            original_url,
        }
    }

    /// Construct a new [`Request`].
    pub fn new(url: &str, source_url: &str, request_type: &str) -> Result<Request, RequestError> {
        if let Some(parsed_url) = url_parser::parse_url(url) {
            if let Some(parsed_source) = url_parser::parse_url(source_url) {
                let source_domain = parsed_source.domain();

                let third_party = source_domain != parsed_url.domain();

                Ok(Request::from_detailed_parameters(
                    request_type,
                    &parsed_url.url,
                    parsed_url.schema(),
                    parsed_url.hostname(),
                    parsed_source.hostname(),
                    third_party,
                    url.to_string(),
                ))
            } else {
                Ok(Request::from_detailed_parameters(
                    request_type,
                    &parsed_url.url,
                    parsed_url.schema(),
                    parsed_url.hostname(),
                    "",
                    true,
                    url.to_string(),
                ))
            }
        } else {
            Err(RequestError::HostnameParseError)
        }
    }

    /// If you're building a [`Request`] in a context that already has access to parsed
    /// representations of the input URLs, you can use this constructor to avoid extra lookups from
    /// the public suffix list. Take care to pass data correctly.
    pub fn preparsed(
        url: &str,
        hostname: &str,
        source_hostname: &str,
        request_type: &str,
        third_party: bool,
    ) -> Request {
        let splitter = memchr::memchr(b':', url.as_bytes()).unwrap_or(0);
        let schema: &str = &url[..splitter];

        Request::from_detailed_parameters(
            request_type,
            url,
            schema,
            hostname,
            source_hostname,
            third_party,
            url.to_string(),
        )
    }
}

fn calculate_tokens(url_lower_cased: &str) -> Vec<utils::Hash> {
    let mut tokens = utils::TokensBuffer::default();
    utils::tokenize_pooled(url_lower_cased, &mut tokens);
    // Add zero token as a fallback to wildcard rule bucket
    tokens.push(0);
    tokens.into_iter().collect()
}

#[cfg(test)]
#[path = "../tests/unit/request.rs"]
mod unit_tests;
