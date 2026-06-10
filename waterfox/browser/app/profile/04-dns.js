#filter dumbComments emptyLines

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Ultra Protection: DNS over Oblivious HTTP through the Waterfox relay,
// on by default for new profiles.
pref("network.trr.mode", 2);
pref("network.trr.use_ohttp", true);
pref("network.trr.ohttp.relay_uri", "https://dooh.waterfox.com/");
pref("network.trr.ohttp.config_uri", "https://dooh.cloudflare-dns.com/.well-known/doohconfig");
pref("network.trr.ohttp.uri", "https://dooh.cloudflare-dns.com/dns-query");
// OHTTP encapsulates the query, so it must travel as a POST body.
pref("network.trr.useGET", false);
pref("network.trr.max-fails", 5);

// Keep the Mozilla DoH rollout from overriding these choices.
pref("doh-rollout.enabled", false, locked);
pref("doh-rollout.disable-heuristics", true, locked);
