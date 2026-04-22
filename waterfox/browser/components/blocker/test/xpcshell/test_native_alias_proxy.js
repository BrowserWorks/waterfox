"use strict";

const DISGUISED_HOST = "metrics.example.com";
const CANONICAL_HOST = "tracker.example.net";

const overrideService = Cc[
  "@mozilla.org/network/native-dns-override;1"
].getService(Ci.nsINativeDNSResolverOverride);

class Listener {
  constructor() {
    this.promise = new Promise(resolve => {
      this.resolve = resolve;
    });
  }

  onLookupComplete(inRequest, inRecord, inStatus) {
    this.resolve({ inRequest, inRecord, inStatus });
  }
}

Listener.prototype.QueryInterface = ChromeUtils.generateQI(["nsIDNSListener"]);

function resolveCanonical(flags) {
  const listener = new Listener();
  try {
    Services.dns.asyncResolve(
      DISGUISED_HOST,
      Ci.nsIDNSService.RESOLVE_TYPE_DEFAULT,
      flags,
      null,
      listener,
      Services.tm.currentThread,
      {}
    );
  } catch (error) {
    return Promise.resolve({
      inRequest: null,
      inRecord: null,
      inStatus: error.result,
    });
  }
  return listener.promise;
}

add_setup(function setup() {
  Services.prefs.setIntPref("network.proxy.type", 1);
  Services.prefs.setCharPref("network.proxy.socks", "127.0.0.1");
  Services.prefs.setIntPref("network.proxy.socks_port", 9000);
  Services.prefs.setIntPref("network.proxy.socks_version", 5);
  Services.prefs.setBoolPref("network.proxy.socks_remote_dns", true);
  Services.prefs.setBoolPref("network.proxy.socks5_remote_dns", true);

  overrideService.addIPOverride(DISGUISED_HOST, "127.0.0.1");
  overrideService.setCnameOverride(DISGUISED_HOST, CANONICAL_HOST);

  registerCleanupFunction(() => {
    overrideService.clearOverrides();
    Services.dns.clearCache(true);
    Services.prefs.clearUserPref("network.proxy.type");
    Services.prefs.clearUserPref("network.proxy.socks");
    Services.prefs.clearUserPref("network.proxy.socks_port");
    Services.prefs.clearUserPref("network.proxy.socks_version");
    Services.prefs.clearUserPref("network.proxy.socks_remote_dns");
    Services.prefs.clearUserPref("network.proxy.socks5_remote_dns");
  });
});

add_task(async function test_canonical_lookup_stays_blocked_by_remote_socks_dns() {
  Services.dns.clearCache(true);

  let result = await resolveCanonical(Ci.nsIDNSService.RESOLVE_CANONICAL_NAME);
  Assert.equal(
    result.inStatus,
    Cr.NS_ERROR_UNKNOWN_PROXY_HOST,
    "canonical lookup remains blocked by remote SOCKS DNS"
  );
});
