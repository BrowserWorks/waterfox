pub(crate) const BROTLI_DECODER_VERSION: u32 = 0x0600_3002;

const fn parse_version_component(component: &str) -> u32 {
    let bytes = component.as_bytes();
    let mut value = 0;
    let mut i = 0;
    while i < bytes.len() {
        let digit = bytes[i];
        if digit < b'0' || digit > b'9' {
            panic!("invalid Cargo package version component");
        }
        value = value * 10 + (digit - b'0') as u32;
        i += 1;
    }
    value
}

const fn cargo_package_version() -> u32 {
    let major = parse_version_component(env!("CARGO_PKG_VERSION_MAJOR"));
    let minor = parse_version_component(env!("CARGO_PKG_VERSION_MINOR"));
    let patch = parse_version_component(env!("CARGO_PKG_VERSION_PATCH"));
    if major > 255 || minor > 4095 || patch > 4095 {
        panic!("Cargo package version exceeds Brotli's C version format");
    }
    (major << 24) | (minor << 12) | patch
}

// Cargo verifies a package build before publishing, including this check.
const _: () = if BROTLI_DECODER_VERSION != cargo_package_version() {
    panic!("update BROTLI_DECODER_VERSION to match Cargo.toml before publishing");
};
