/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Service Class to observe and record proxy-errors related to IP-Protection
 *
 * @fires IPPNetworkErrorObserver#"proxy-http-error"
 * Fired when the Proxy has received the Connect Request and responded with
 * a non-2xx HTTP status code
 */
export class IPPNetworkErrorObserver {
  constructor() {}

  start() {
    if (this.#active) {
      return;
    }
    Services.obs.addObserver(this, "http-on-stop-request");
    Services.obs.addObserver(this, "http-on-failed-opening-request");
    this.#active = true;
  }
  stop() {
    if (!this.#active) {
      return;
    }
    this.#active = false;
    this.#isolationKeys.clear();
    Services.obs.removeObserver(this, "http-on-failed-opening-request");
    Services.obs.removeObserver(this, "http-on-stop-request");
  }

  addIsolationKey(key) {
    if (typeof key !== "string" || !key) {
      throw new Error("Isolation key must be a non-empty string");
    }
    this.#isolationKeys.add(key);
  }
  removeIsolationKey(key) {
    if (typeof key !== "string" || !key) {
      throw new Error("Isolation key must be a non-empty string");
    }
    this.#isolationKeys.delete(key);
  }
  addEventListener(...args) {
    this._event.addEventListener(...args);
  }

  removeEventListener(...args) {
    this._event.removeEventListener(...args);
  }

  observe(subject, topic, _data) {
    if (
      topic !== "http-on-stop-request" &&
      topic !== "http-on-failed-opening-request"
    ) {
      return;
    }
    try {
      const chan = subject.QueryInterface(Ci.nsIHttpChannel);
      const key = this.getKey(chan);
      if (!key) {
        // If the isolation key is unknown to us or does not
        // exist, no need to care.
        return;
      }
      const proxiedChannel = chan.QueryInterface(Ci.nsIProxiedChannel);
      const proxycode = proxiedChannel.httpProxyConnectResponseCode;
      switch (proxycode) {
        case 0:
        case 200:
          // All good :)
          return;
        default:
          this.#emitProxyHTTPError(this.#classifyLoad(chan), key, proxycode);
      }
    } catch (err) {
      // If the channel is not an nsIHttpChannel or not proxied - all good.
    }
  }
  /**
   * Checks if a channel should be counted.
   *
   * @param {nsIHttpChannel} channel
   * @returns {boolean} true if the channel should be counted.
   */
  getKey(channel) {
    try {
      const proxiedChannel = channel.QueryInterface(Ci.nsIProxiedChannel);
      const proxyInfo = proxiedChannel.proxyInfo;
      if (!proxyInfo) {
        // No proxy info, nothing to do.
        return null;
      }
      const isolationKey = proxyInfo.connectionIsolationKey;
      if (!isolationKey || !this.#isolationKeys.has(isolationKey)) {
        return null;
      }
      return isolationKey;
    } catch (err) {
      // If the channel is not an nsIHttpChannel or nsIProxiedChannel, as it's irrelevant
      // for this class.
    }
    return null;
  }

  #classifyLoad(channel) {
    try {
      if (channel.isMainDocumentChannel) {
        return "error";
      }
      return "warning";
    } catch (_) {}
    return "unknown";
  }

  #emitProxyHTTPError(level, isolationKey, httpStatus) {
    this._event.dispatchEvent(
      new CustomEvent("proxy-http-error", {
        detail: { level, isolationKey, httpStatus },
      })
    );
  }
  _event = new EventTarget();

  #active = false;
  #isolationKeys = new Set();
}

IPPNetworkErrorObserver.prototype.QueryInterface = ChromeUtils.generateQI([
  Ci.nsIObserver,
]);
