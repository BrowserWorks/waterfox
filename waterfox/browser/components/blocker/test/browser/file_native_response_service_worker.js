/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const cacheName = new URL(self.location.href).searchParams.get("cacheName");

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  switch (url.searchParams.get("case")) {
    case "sw-synthetic":
      event.respondWith(
        new Response("synthetic-body", {
          headers: { "Content-Type": "text/plain" },
        })
      );
      break;
    case "sw-cache":
      event.respondWith(
        caches.open(cacheName).then(async cache => {
          const response = await cache.match(event.request);
          if (!response) {
            throw new Error("Missing Stage 3 Cache API fixture");
          }
          return response;
        })
      );
      break;
  }
});
