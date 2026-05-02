// Cloudflare Worker Script for Foxxite Cloud Backend
// Handles Encrypted Clipboard, Handoff, and general sync replacements.

export default {
  async fetch(request, env) {
    return await handleRequest(request, env);
  }
}

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  // Handle WebSocket connections for realtime sync (Encrypted Clipboard / P2P Chat signaling)
  if (path === "/ws-sync") {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 400 });
    }
    const [client, server] = Object.values(new WebSocketPair());

    // Accept connection
    server.accept();
    server.addEventListener('message', event => {
      // In a real implementation with Durable Objects:
      // We would broadcast the encrypted clipboard/message to other connected devices
      // belonging to the same user profile.
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        return; // ignore invalid JSON
      }

      if (data.type === 'clipboard_update' || data.type === 'handoff_update' || data.type === 'p2p_message') {
        // Echo back for now as a stub.
        // Needs Durable Objects logic to broadcast to peers.
        server.send(JSON.stringify({
          status: 'received',
          original_type: data.type
        }));
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // REST API for general sync replacements (like fxaccounts, tokens, telemetry sink)
  if (path.startsWith('/v1/sync') || path.startsWith('/v1/account')) {
    return new Response(JSON.stringify({ status: "success", source: "Foxxite Cloud Backend" }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  // Null endpoint for telemetry
  if (path.startsWith('/submit/telemetry')) {
    return new Response("ok", { status: 200 });
  }

  return new Response(JSON.stringify({ error: "Not found", path: path }), {
    status: 404,
    headers: { 'content-type': 'application/json' },
  });
}
