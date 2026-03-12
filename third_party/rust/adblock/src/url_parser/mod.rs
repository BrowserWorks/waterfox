//! Simplified URL parsing infrastructure, including the domain resolver
//! implementation if the `embedded-domain-resolver` feature is disabled.

mod parser;
// mod parser_regex;

#[cfg(not(feature = "embedded-domain-resolver"))]
static DOMAIN_RESOLVER: once_cell::sync::OnceCell<Box<dyn ResolvesDomain>> =
    once_cell::sync::OnceCell::new();

/// Sets the library's domain resolver implementation.
///
/// If the `embedded-domain-resolver` feature is disabled and the library is
/// used without this having been set, panics may occur!
///
/// Will return the resolver if it has already been previously set.
#[cfg(not(feature = "embedded-domain-resolver"))]
pub fn set_domain_resolver(
    resolver: Box<dyn ResolvesDomain>,
) -> Result<(), Box<dyn ResolvesDomain>> {
    DOMAIN_RESOLVER.set(resolver)
}

/// Default `addr`-based domain resolution implementation used when the
/// `embedded-domain-resolver` feature is enabled.
#[cfg(feature = "embedded-domain-resolver")]
struct DefaultResolver;

#[cfg(feature = "embedded-domain-resolver")]
impl ResolvesDomain for DefaultResolver {
    fn get_host_domain(&self, host: &str) -> (usize, usize) {
        use addr::parser::DomainName;
        use addr::psl::List;

        if host.is_empty() {
            (0, 0)
        } else {
            match List.parse_domain_name(host) {
                Err(_e) => (0, host.len()),
                Ok(domain) => {
                    let host_len = host.len();
                    let domain_len = domain.root().unwrap_or_else(|| domain.suffix()).len();
                    (host_len - domain_len, host_len)
                }
            }
        }
    }
}

/// Required trait for any domain resolution implementation used with this
/// crate.
pub trait ResolvesDomain: Send + Sync {
    /// Return the start and end indices of the domain (eTLD+1) of the given hostname.
    ///
    /// If there isn't a valid domain, `(0, host.len())` should be returned.
    ///
    /// ```
    /// # use adblock::url_parser::ResolvesDomain;
    /// # /// I'd use DefaultResolver here, but I can't use private structs in doctests.
    /// # /// Enjoy this mock implementation instead :(
    /// # struct Resolver;
    /// # impl ResolvesDomain for Resolver {
    /// #     fn get_host_domain(&self, host: &str) -> (usize, usize) {
    /// #         match host {
    /// #             "api.m.example.com" => (6, 17),
    /// #             "a.b.co.uk" => (2, 9),
    /// #             _ => unreachable!()
    /// #         }
    /// #     }
    /// # }
    /// # let resolver = Resolver;
    /// let host = "api.m.example.com";
    /// let (start, end) = resolver.get_host_domain(host);
    /// assert_eq!(&host[start..end], "example.com");
    ///
    /// let host = "a.b.co.uk";
    /// let (start, end) = resolver.get_host_domain(host);
    /// assert_eq!(&host[start..end], "b.co.uk");
    /// ```
    fn get_host_domain(&self, host: &str) -> (usize, usize);
}

/// Parsed URL representation.
pub struct RequestUrl {
    pub url: String,
    schema_end: usize,
    pub hostname_pos: (usize, usize),
    domain: (usize, usize),
}

impl RequestUrl {
    pub fn schema(&self) -> &str {
        &self.url[..self.schema_end]
    }
    pub fn hostname(&self) -> &str {
        &self.url[self.hostname_pos.0..self.hostname_pos.1]
    }
    pub fn domain(&self) -> &str {
        &self.url[self.hostname_pos.0 + self.domain.0..self.hostname_pos.0 + self.domain.1]
    }
}

/// Return the start and end indices of the domain of the given hostname.
pub(crate) fn get_host_domain(host: &str) -> (usize, usize) {
    #[cfg(not(feature = "embedded-domain-resolver"))]
    let domain_resolver = DOMAIN_RESOLVER.get().expect("An external domain resolver must be set when the `embedded-domain-resolver` feature is disabled.");
    #[cfg(feature = "embedded-domain-resolver")]
    let domain_resolver = DefaultResolver;

    domain_resolver.get_host_domain(host)
}

/// Return the string representation of the host (domain or IP address) for
/// this URL, if any together with the URL.
///
/// As part of hostname parsing, punycode decoding is used to convert URLs with
/// UTF characters to plain ASCII ones.  Serialisation then contains this
/// decoded URL that is used for further matching.
pub fn parse_url(url: &str) -> Option<RequestUrl> {
    let parsed = parser::Hostname::parse(url).ok();
    parsed.and_then(|h| match h.host_str() {
        Some(_host) => Some(RequestUrl {
            url: h.url_str().to_owned(),
            schema_end: h.scheme_end,
            hostname_pos: (h.host_start, h.host_end),
            domain: get_host_domain(&h.url_str()[h.host_start..h.host_end]),
        }),
        _ => None,
    })
}

#[cfg(all(test, feature = "embedded-domain-resolver"))]
mod embedded_domain_resolver_tests {
    use super::*;

    #[test]
    fn test_get_host_domain() {
        fn domain(host: &str) -> &str {
            let resolver = DefaultResolver;
            let (a, b) = resolver.get_host_domain(host);
            &host[a..b]
        }
        assert_eq!(domain("www.google.com"), "google.com");
        assert_eq!(domain("google.com."), "google.com.");
        assert_eq!(domain("a.b.co.uk"), "b.co.uk");
        assert_eq!(domain("foo.bar"), "foo.bar");
    }
}
