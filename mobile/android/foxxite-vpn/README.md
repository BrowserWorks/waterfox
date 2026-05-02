# Foxxite Native Wireguard Integration

This module provides the architecture to integrate the `wireguard-android` library directly into the Foxxite Android browser.

## Architecture

- **WireguardTunnelService**: A Kotlin Foreground Service that keeps the tunnel alive.
- **JNI Integration (Future)**: Connects the C++ network layer of GeckoView directly to the Wireguard tunnel to support "Per-Tab VPN".

## Windows/Desktop Counterpart

For the Windows version of Foxxite, we plan to implement `wireguard-nt` driver integration natively within the C++ layer. For cross-platform desktop support (Linux/Mac), we will leverage the Rust-based `boringtun` library within Mozilla's network stack.
