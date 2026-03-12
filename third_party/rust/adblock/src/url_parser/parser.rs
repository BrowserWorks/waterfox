// Copyright 2013-2016 The rust-url developers.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

use std::error::Error;
use std::fmt::{self, Formatter, Write};

use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use std::ops::{Range, RangeFrom, RangeTo};

/// https://url.spec.whatwg.org/#fragment-percent-encode-set
const FRAGMENT: &AsciiSet = &CONTROLS.add(b' ').add(b'"').add(b'<').add(b'>').add(b'`');

/// https://url.spec.whatwg.org/#path-percent-encode-set
const PATH: &AsciiSet = &FRAGMENT.add(b'#').add(b'?').add(b'{').add(b'}');

/// https://url.spec.whatwg.org/#userinfo-percent-encode-set
pub(crate) const USERINFO: &AsciiSet = &PATH
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'=')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'|');

#[derive(Clone)]
pub(super) struct Hostname {
    serialization: String,

    // Components
    pub(super) scheme_end: usize, // Before ':'
    pub(super) host_start: usize,
    pub(super) host_end: usize,
}

impl Hostname {
    pub fn parse(input: &str) -> Result<Hostname, ParseError> {
        Parser {
            serialization: String::with_capacity(input.len()),
        }
        .parse_url(input)
    }

    /// Equivalent to `url.host().is_some()`.
    ///
    /// # Examples
    ///
    /// ```
    /// use url::Url;
    /// # use url::ParseError;
    ///
    /// # fn run() -> Result<(), ParseError> {
    /// let url = Url::parse("ftp://rms@example.com")?;
    /// assert!(url.has_host());
    ///
    /// let url = Url::parse("unix:/run/foo.socket")?;
    /// assert!(!url.has_host());
    ///
    /// let url = Url::parse("data:text/plain,Stuff")?;
    /// assert!(!url.has_host());
    /// # Ok(())
    /// # }
    /// # run().unwrap();
    /// ```
    fn has_host(&self) -> bool {
        self.host_end > self.host_start
    }

    /// Return the string representation of the host (domain or IP address) for this URL, if any.
    ///
    /// Non-ASCII domains are punycode-encoded per IDNA.
    /// IPv6 addresses are given between `[` and `]` brackets.
    ///
    /// Cannot-be-a-base URLs (typical of `data:` and `mailto:`) and some `file:` URLs
    /// don’t have a host.
    ///
    /// See also the `host` method.
    ///
    /// # Examples
    ///
    /// ```
    /// use url::Url;
    /// # use url::ParseError;
    ///
    /// # fn run() -> Result<(), ParseError> {
    /// let url = Url::parse("https://127.0.0.1/index.html")?;
    /// assert_eq!(url.host_str(), Some("127.0.0.1"));
    ///
    /// let url = Url::parse("ftp://rms@example.com")?;
    /// assert_eq!(url.host_str(), Some("example.com"));
    ///
    /// let url = Url::parse("unix:/run/foo.socket")?;
    /// assert_eq!(url.host_str(), None);
    ///
    /// let url = Url::parse("data:text/plain,Stuff")?;
    /// assert_eq!(url.host_str(), None);
    /// # Ok(())
    /// # }
    /// # run().unwrap();
    /// ```
    pub fn host_str(&self) -> Option<&str> {
        if self.has_host() {
            Some(self.slice(self.host_start..self.host_end))
        } else {
            None
        }
    }

    pub fn url_str(&self) -> &str {
        &self.serialization
    }

    // Private helper methods:

    fn slice<R>(&self, range: R) -> &str
    where
        R: RangeArg,
    {
        range.slice_of(&self.serialization)
    }
}

trait RangeArg {
    fn slice_of<'a>(&self, s: &'a str) -> &'a str;
}

impl RangeArg for Range<usize> {
    fn slice_of<'a>(&self, s: &'a str) -> &'a str {
        &s[self.start..self.end]
    }
}

impl RangeArg for RangeFrom<usize> {
    fn slice_of<'a>(&self, s: &'a str) -> &'a str {
        &s[self.start..]
    }
}

impl RangeArg for RangeTo<usize> {
    fn slice_of<'a>(&self, s: &'a str) -> &'a str {
        &s[..self.end]
    }
}

pub type ParseResult<T> = Result<T, ParseError>;

macro_rules! simple_enum_error {
    ($($name: ident => $description: expr,)+) => {
        /// Errors that can occur during parsing.
        #[derive(PartialEq, Eq, Clone, Copy, Debug)]
        pub enum ParseError {
            $(
                $name,
            )+
        }

        impl Error for ParseError {}

        impl fmt::Display for ParseError {
            fn fmt(&self, fmt: &mut Formatter) -> fmt::Result {
                match *self {
                    $(
                        ParseError::$name => $description,
                    )+
                }.fmt(fmt)
            }
        }
    }
}

simple_enum_error! {
    // EmptyHost => "empty host",
    IdnaError => "invalid international domain name",
    // InvalidPort => "invalid port number",
    // InvalidIpv4Address => "invalid IPv4 address",
    // InvalidIpv6Address => "invalid IPv6 address",
    // InvalidDomainCharacter => "invalid domain character",
    // HostParseError => "internal host parse error",
    RelativeUrlWithoutBase => "relative URL without a base",
    // RelativeUrlWithCannotBeABaseBase => "relative URL with a cannot-be-a-base base",
    // SetHostOnCannotBeABaseUrl => "a cannot-be-a-base URL doesn’t have a host to set",
    // Overflow => "URLs more than 4 GB are not supported",
    FileUrlNotSupported => "file URLs are not supported",
    ExpectedMoreChars => "Expected more characters",
}

impl From<idna::Errors> for ParseError {
    fn from(_: idna::Errors) -> ParseError {
        ParseError::IdnaError
    }
}

#[derive(Copy, Clone)]
pub enum SchemeType {
    File,
    SpecialNotFile,
    NotSpecial,
}

impl SchemeType {
    pub fn is_special(self) -> bool {
        !matches!(self, SchemeType::NotSpecial)
    }

    pub fn from(s: &str) -> Self {
        match s {
            "http" | "https" | "ws" | "wss" | "ftp" | "gopher" => SchemeType::SpecialNotFile,
            "file" => SchemeType::File,
            _ => SchemeType::NotSpecial,
        }
    }
}

#[derive(Clone)]
pub struct Input<'i> {
    chars: std::str::Chars<'i>,
}

impl<'i> Input<'i> {
    pub fn new(input: &'i str) -> Self {
        let input = input.trim_matches(c0_control_or_space);
        Input {
            chars: input.chars(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.clone().next().is_none()
    }

    fn starts_with<P: Pattern>(&self, p: P) -> bool {
        p.split_prefix(&mut self.clone())
    }

    pub fn split_prefix<P: Pattern>(&self, p: P) -> Option<Self> {
        let mut remaining = self.clone();
        if p.split_prefix(&mut remaining) {
            Some(remaining)
        } else {
            None
        }
    }

    fn count_matching<F: Fn(char) -> bool>(&self, f: F) -> (u32, Self) {
        let mut count = 0;
        let mut remaining = self.clone();
        loop {
            let mut input = remaining.clone();
            if matches!(input.next(), Some(c) if f(c)) {
                remaining = input;
                count += 1;
            } else {
                return (count, remaining);
            }
        }
    }

    fn next_utf8(&mut self) -> Option<(char, &'i str)> {
        loop {
            let utf8 = self.chars.as_str();
            match self.chars.next() {
                Some(c) => {
                    if !matches!(c, '\t' | '\n' | '\r') {
                        return Some((c, &utf8[..c.len_utf8()]));
                    }
                }
                None => return None,
            }
        }
    }
}

pub trait Pattern {
    fn split_prefix(self, input: &mut Input) -> bool;
}

impl Pattern for char {
    fn split_prefix(self, input: &mut Input) -> bool {
        input.next() == Some(self)
    }
}

impl Pattern for &str {
    fn split_prefix(self, input: &mut Input) -> bool {
        for c in self.chars() {
            if input.next() != Some(c) {
                return false;
            }
        }
        true
    }
}

impl<F: FnMut(char) -> bool> Pattern for F {
    fn split_prefix(self, input: &mut Input) -> bool {
        input.next().is_some_and(self)
    }
}

impl Iterator for Input<'_> {
    type Item = char;
    fn next(&mut self) -> Option<char> {
        self.chars.next() //by_ref().find(|&c| !matches!(c, '\t' | '\n' | '\r'))
    }
}

pub struct Parser {
    pub serialization: String,
}

impl Parser {
    /// https://url.spec.whatwg.org/#concept-basic-url-parser
    pub fn parse_url(mut self, input: &str) -> ParseResult<Hostname> {
        // println!("Parse {}", input);
        let input = Input::new(input);
        if let Ok(remaining) = self.parse_scheme(input.clone()) {
            return self.parse_with_scheme(remaining);
        }

        // No-scheme state
        Err(ParseError::RelativeUrlWithoutBase)
    }

    pub fn parse_scheme<'i>(&mut self, mut input: Input<'i>) -> Result<Input<'i>, ()> {
        if input.is_empty() || !input.starts_with(|c: char| c.is_ascii_alphabetic()) {
            return Err(());
        }
        debug_assert!(self.serialization.is_empty());
        while let Some(c) = input.next() {
            match c {
                'a'..='z' => self.serialization.push(c),
                'A'..='Z' => self.serialization.push(c.to_ascii_lowercase()),
                '0'..='9' | '+' | '-' | '.' => self.serialization.push(c),
                ':' => return Ok(input),
                _ => {
                    self.serialization.clear();
                    return Err(());
                }
            }
        }

        Err(())
    }

    fn parse_with_scheme(mut self, input: Input) -> ParseResult<Hostname> {
        let scheme_end = self.serialization.len();
        let scheme_type = SchemeType::from(&self.serialization);
        self.serialization.push(':');
        match scheme_type {
            SchemeType::File => {
                // println!("Parse file - not supported");
                Err(ParseError::FileUrlNotSupported)
            }
            SchemeType::SpecialNotFile => {
                // println!("Parse special, not file");
                // special relative or authority state
                let (_, remaining) = input.count_matching(|c| matches!(c, '/' | '\\'));
                // special authority slashes state
                // println!("Parse after double slash {}", remaining.chars.as_str());
                self.after_double_slash(remaining, scheme_type, scheme_end)
            }
            SchemeType::NotSpecial => {
                // println!("Parse non special {}", &self.serialization);
                self.parse_non_special(input, scheme_type, scheme_end)
            }
        }
    }

    /// Scheme other than file, http, https, ws, ws, ftp, gopher.
    fn parse_non_special(
        mut self,
        input: Input,
        scheme_type: SchemeType,
        scheme_end: usize,
    ) -> ParseResult<Hostname> {
        // path or authority state (
        if let Some(input) = input.split_prefix("//") {
            return self.after_double_slash(input, scheme_type, scheme_end);
        }
        // Anarchist URL (no authority)
        let path_start = self.serialization.len();
        let host_start = path_start;
        let host_end = path_start;
        self.serialization.push_str(input.chars.as_str());
        let ser_remaining = self.serialization.as_mut_str().get_mut(host_end..);
        ser_remaining.map(|s| {
            s.make_ascii_lowercase();
            &*s
        });

        Ok(Hostname {
            serialization: self.serialization,
            scheme_end,
            host_start,
            host_end,
        })
    }

    fn after_double_slash(
        mut self,
        input: Input,
        scheme_type: SchemeType,
        scheme_end: usize,
    ) -> ParseResult<Hostname> {
        self.serialization.push_str("//");
        // authority state
        let (_username_end, remaining) = self.parse_userinfo(input, scheme_type)?;
        // host state
        let host_start = self.serialization.len();
        let (host_end, remaining) = self.parse_host(remaining, scheme_type)?;
        self.serialization.push_str(remaining.chars.as_str());
        Ok(Hostname {
            serialization: self.serialization,
            scheme_end,
            host_start,
            host_end,
        })
    }

    /// Return (username_end, remaining)
    fn parse_userinfo<'i>(
        &mut self,
        mut input: Input<'i>,
        scheme_type: SchemeType,
    ) -> ParseResult<(usize, Input<'i>)> {
        let mut last_at = None;
        let mut remaining = input.clone();
        let mut char_count = 0;
        while let Some(c) = remaining.next() {
            match c {
                '@' => last_at = Some((char_count, remaining.clone())),
                '/' | '?' | '#' => break,
                '\\' if scheme_type.is_special() => break,
                _ => (),
            }
            char_count += 1;
        }
        let (mut userinfo_char_count, remaining) = match last_at {
            None => return Ok((self.serialization.len(), input)),
            Some((0, remaining)) => return Ok((self.serialization.len(), remaining)),
            Some(x) => x,
        };

        let mut username_end = None;
        let mut has_password = false;
        let mut has_username = false;
        while userinfo_char_count > 0 {
            let (c, utf8_c) = input.next_utf8().ok_or(ParseError::ExpectedMoreChars)?;
            userinfo_char_count -= 1;
            if c == ':' && username_end.is_none() {
                // Start parsing password
                username_end = Some(self.serialization.len());
                // We don't add a colon if the password is empty
                if userinfo_char_count > 0 {
                    self.serialization.push(':');
                    has_password = true;
                }
            } else {
                if !has_password {
                    has_username = true;
                }
                self.serialization
                    .extend(utf8_percent_encode(utf8_c, USERINFO));
            }
        }
        let username_end = match username_end {
            Some(i) => i,
            None => self.serialization.len(),
        };
        if has_username || has_password {
            self.serialization.push('@');
        }
        Ok((username_end, remaining))
    }

    pub fn parse_host<'i>(
        &mut self,
        mut input: Input<'i>,
        scheme_type: SchemeType,
    ) -> ParseResult<(usize, Input<'i>)> {
        // Undo the Input abstraction here to avoid allocating in the common case
        // where the host part of the input does not contain any tab or newline
        let input_str = input.chars.as_str();
        let mut remaining = input.clone();
        let mut inside_square_brackets = false;
        let mut has_ignored_chars = false;
        let mut non_ignored_chars = 0;
        let mut bytes = 0;
        for c in input_str.chars() {
            match c {
                ':' if !inside_square_brackets => break,
                '\\' if scheme_type.is_special() => break,
                '/' | '?' | '#' => break,
                '\t' | '\n' | '\r' => {
                    has_ignored_chars = true;
                }
                '[' => {
                    inside_square_brackets = true;
                    non_ignored_chars += 1
                }
                ']' => {
                    inside_square_brackets = false;
                    non_ignored_chars += 1
                }
                _ => non_ignored_chars += 1,
            }
            remaining.next();
            bytes += c.len_utf8();
        }
        let replaced: String;
        let host_str;
        {
            let host_input = input.by_ref().take(non_ignored_chars);
            if has_ignored_chars {
                replaced = host_input.collect();
                host_str = &*replaced
            } else {
                for _ in host_input {}
                host_str = &input_str[..bytes]
            }
        }

        if host_str.is_ascii() {
            write!(&mut self.serialization, "{host_str}").unwrap();
        } else {
            let encoded = idna::domain_to_ascii(host_str)?;
            write!(&mut self.serialization, "{encoded}").unwrap();
        }

        let host_end = self.serialization.len();
        Ok((host_end, remaining))
    }
}

/// https://url.spec.whatwg.org/#c0-controls-and-space
#[inline]
fn c0_control_or_space(ch: char) -> bool {
    ch <= ' ' // U+0000 to U+0020
}
