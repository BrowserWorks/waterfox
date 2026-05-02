# Foxxite Cloud Backend

This directory contains the monorepo for the custom Cloudflare-based backend that replaces Mozilla's infrastructure for the Foxxite browser.

## Current Endpoints

- `wss://sync.foxxite.workers.dev/ws-sync`: WebSocket endpoint for real-time synchronization.
- `https://sync.foxxite.workers.dev/v1/sync`: Mock REST endpoint for legacy sync calls.
- `https://telemetry.foxxite.workers.dev/submit/telemetry`: Blackhole endpoint for telemetry.
