#filter dumbComments emptyLines

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Ultra Protection: DNS over Oblivious HTTP through the Waterfox relay.
// OHTTP is off by default until Fastly updates the relay;
// the default is standard TRR-first DoH via the default provider, and
// selecting Ultra in Settings re-enables OHTTP.
pref("network.trr.mode", 2);
pref("network.trr.use_ohttp", false);
pref("network.trr.ohttp.relay_uri", "https://dooh.waterfox.net/");
pref("network.trr.ohttp.config_uri", "https://dooh.cloudflare-dns.com/.well-known/doohconfig");
pref("network.trr.ohttp.uri", "https://dooh.cloudflare-dns.com/dns-query");
pref("network.trr.useGET", true);
pref("network.trr.max-fails", 5);
pref("network.trr.request_timeout_mode_trronly_ms", 1500);

// Keep the Mozilla DoH rollout from overriding these choices.
pref("doh-rollout.enabled", false, locked);
pref("doh-rollout.disable-heuristics", true, locked);
