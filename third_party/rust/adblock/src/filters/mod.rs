//! Contains representations and standalone behaviors of individual filter rules.

mod abstract_network;
mod network_matchers;

pub mod cosmetic;
pub(crate) mod fb_builder;
pub(crate) mod fb_network;
pub(crate) mod fb_network_builder;
pub(crate) mod filter_data_context;
pub mod network;
pub(crate) mod token_selector;

#[allow(unknown_lints)]
#[allow(
    dead_code,
    clippy::all,
    unused_imports,
    unsafe_code,
    mismatched_lifetime_syntaxes
)]
#[path = "../flatbuffers/fb_network_filter_generated.rs"]
mod flat;

pub(crate) mod flatbuffer_generated {
    pub use super::flat::fb;
}
