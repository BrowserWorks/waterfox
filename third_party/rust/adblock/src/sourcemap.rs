//! Utilities for attributing matched filter rules to their original in-list representations.

use serde::Serialize;
use std::fmt;

/// Additional information about any filter rule matched by the [crate::Engine].
///
/// This information is available on a best-effort basis from any engine which has been built from a
/// [crate::FilterSet] with the `debug` argument set to `true`.
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct FilterRuleDebugInfo {
    /// String representation of the original filter rule.
    ///
    /// Note that this may be a "best effort" representation in cases where multiple filters have
    /// been fused as part of an optimization.
    pub raw_line: Option<String>,
    /// Location of the original filter rule within the filter lists.
    ///
    /// This may be missing if multiple filters have been fused together.
    pub source_location: Option<SourceLocation>,
}

impl fmt::Display for FilterRuleDebugInfo {
    fn fmt(&self, f: &mut fmt::Formatter) -> Result<(), fmt::Error> {
        if let Some(location) = &self.source_location {
            write!(f, "{location}: ")
        } else {
            write!(f, "x:x: ")
        }?;

        if let Some(raw_line) = &self.raw_line {
            write!(f, "{raw_line}")
        } else {
            write!(f, "! unknown")
        }
    }
}

/// Location of a filter rule within sources compiled to a [crate::FilterSet].
#[derive(Debug, Default, PartialEq, Serialize)]
pub struct SourceLocation {
    /// The numeric index of the source as per [crate::lists::AddedFiltersRecord::source_index].
    pub source_index: u32,
    /// Zero-indexed line number of the filter within the source list.
    pub line_number: u32,
}

impl fmt::Display for SourceLocation {
    fn fmt(&self, f: &mut fmt::Formatter) -> Result<(), fmt::Error> {
        write!(f, "{}:{}", self.source_index, self.line_number)
    }
}
