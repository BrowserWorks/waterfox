# Foxxite Cloud Backend

This directory contains the monorepo for the custom Cloudflare-based backend that replaces Mozilla's infrastructure for the Foxxite browser.

## Architecture

The backend utilizes **Cloudflare Workers** and **Durable Objects** to provide a fast, secure, edge-based synchronization service.

- **Workers:** Handle HTTP requests and WebSocket connections.
- **Durable Objects:** Maintain persistent state across devices for a given user (e.g., active WebSockets for a single user's devices) to enable real-time features like the encrypted clipboard and handoff.
- **KV / R2 (Planned):** For storing larger encrypted blobs like offline buffers for P2P file transfers.

## Current Endpoints

- `wss://sync.foxxite.workers.dev/ws-sync`: WebSocket endpoint for real-time synchronization (Encrypted Clipboard, Handoff, P2P Chat signaling).
- `https://sync.foxxite.workers.dev/v1/sync`: Mock REST endpoint for legacy sync calls.
- `https://telemetry.foxxite.workers.dev/submit/telemetry`: Blackhole endpoint for any residual telemetry.

## Deployment

To deploy this worker, use `wrangler`:

```bash
cd cloud-backend
wrangler publish
```
