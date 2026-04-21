/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Waterfox Farbling — renderer-side fingerprinting noise injection.
 *
 * Injected into page scope by WaterfoxBlockerChild when the effective
 * fingerprinting shield level for the current site is 2 (strict).
 *
 * Overrides:
 *   - CanvasRenderingContext2D.getImageData  → ±1 LSB noise per channel
 *   - HTMLCanvasElement.toDataURL            → noise via getImageData
 *   - HTMLCanvasElement.toBlob              → noise via toDataURL
 *   - AudioBuffer.getChannelData            → multiply by stable fudge factor
 *   - Navigator.language / Navigator.languages → "en-US" / ["en-US", "en"]
 *   - Navigator.plugins / mimeTypes         → empty canonical arrays
 *   - Navigator.hardwareConcurrency         → common bucketed value
 *   - Navigator.pdfViewerEnabled            → false
 *
 * All overrides use a deterministic seed derived from the document origin +
 * a per-session random component so values are stable within a page session
 * but differ across page loads and across origins.
 *
 * The session component is passed in as the `__waterfoxFarblingSession__`
 * global before this script runs (set by the injector in the content process).
 */

(function waterfoxFarbling() {
  "use strict";

  // ── Seed / PRNG ──────────────────────────────────────────────────────────────

  /**
   * FNV-1a 32-bit hash of a string.
   *
   * @param {string} s
   * @returns {number}
   */
  function fnv32a(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h;
  }

  // Combine the document origin with a per-session token provided by the
  // parent.  The parent writes __waterfoxFarblingSession__ before injecting
  // this script so the combined seed is unique per (origin × session).
  const sessionToken =
    typeof globalThis.__waterfoxFarblingSession__ === "number"
      ? globalThis.__waterfoxFarblingSession__
      : 0;
  const originSeed = fnv32a(document.location.origin || "null");
  let _state = (originSeed ^ sessionToken) >>> 0;
  if (_state === 0) {
    _state = 0xdeadbeef;
  }

  /**
   * xorshift32 PRNG — very fast, adequate statistical quality for noise.
   * Returns an unsigned 32-bit integer.
   */
  function rand32() {
    _state ^= _state << 13;
    _state ^= _state >>> 17;
    _state ^= _state << 5;
    _state = _state >>> 0;
    return _state;
  }

  /** Returns an integer in [min, max] (inclusive). */
  function randInt(min, max) {
    return min + (rand32() % (max - min + 1));
  }

  // ── Canvas farbling ──────────────────────────────────────────────────────────

  const _getImageData = CanvasRenderingContext2D.prototype.getImageData;
  const _toDataURL = HTMLCanvasElement.prototype.toDataURL;

  /**
   * Adds ±1 noise to every pixel channel (R, G, B) while leaving alpha
   * unchanged, so the change is invisible but alters fingerprint data.
   *
   * @param {ImageData} imageData
   * @returns {ImageData} mutated in place
   */
  function fuzzImageData(imageData) {
    const data = imageData.data;
    for (let i = 0; i < data.length; i += 4) {
      // Only apply to R, G, B — leave alpha (i+3) untouched.
      for (let c = 0; c < 3; c++) {
        const delta = randInt(-1, 1);
        data[i + c] = Math.max(0, Math.min(255, data[i + c] + delta));
      }
    }
    return imageData;
  }

  CanvasRenderingContext2D.prototype.getImageData =
    function farblingGetImageData(sx, sy, sw, sh, ...rest) {
      const imageData = _getImageData.call(this, sx, sy, sw, sh, ...rest);
      return fuzzImageData(imageData);
    };

  HTMLCanvasElement.prototype.toDataURL = function farblingToDataURL(
    type,
    quality
  ) {
    // Draw the canvas through a shadow canvas, fuzz the pixels, then encode.
    const ctx = this.getContext("2d");
    if (!ctx) {
      return _toDataURL.call(this, type, quality);
    }
    // getImageData is already patched; calling it triggers fuzz.
    const w = this.width;
    const h = this.height;
    if (!w || !h) {
      return _toDataURL.call(this, type, quality);
    }
    const imageData = ctx.getImageData(0, 0, w, h);
    const shadow = document.createElement("canvas");
    shadow.width = w;
    shadow.height = h;
    const shadowCtx = shadow.getContext("2d");
    shadowCtx.putImageData(imageData, 0, 0);
    return _toDataURL.call(shadow, type, quality);
  };

  HTMLCanvasElement.prototype.toBlob = function farblingToBlob(
    callback,
    type,
    quality
  ) {
    // Re-use the fuzzed toDataURL path then convert to Blob.
    const dataURL = this.toDataURL(type, quality);
    const [header, base64] = dataURL.split(",");
    const mimeMatch = header.match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : "image/png";
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mime });
    if (typeof callback === "function") {
      Promise.resolve().then(() => callback(blob));
    }
  };

  // ── Audio farbling ───────────────────────────────────────────────────────────

  const _getChannelData = AudioBuffer.prototype.getChannelData;

  /**
   * Stable per-instance fudge factor: multiply all samples by a value very
   * close to 1.0 (derived from the seed) so the waveform is slightly altered
   * but the audio is perceptually identical.
   */
  const AUDIO_FUDGE = 1.0 + (rand32() % 1000) * 1e-7 * (rand32() % 2 ? 1 : -1);

  AudioBuffer.prototype.getChannelData = function farblingGetChannelData(
    channel
  ) {
    const data = _getChannelData.call(this, channel);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.max(-1, Math.min(1, data[i] * AUDIO_FUDGE));
    }
    return data;
  };

  // ── Navigator language farbling ───────────────────────────────────────────────

  try {
    Object.defineProperty(Navigator.prototype, "language", {
      get() {
        return "en-US";
      },
      configurable: true,
    });
    Object.defineProperty(Navigator.prototype, "languages", {
      get() {
        return Object.freeze(["en-US", "en"]);
      },
      configurable: true,
    });
  } catch (_) {
    // Silently ignore if already defined non-configurable.
  }

  // ── Navigator fingerprint surface reduction ─────────────────────────────────

  function defineGetter(target, prop, getter) {
    try {
      Object.defineProperty(target, prop, {
        get: getter,
        configurable: true,
      });
    } catch (_) {}
  }

  function makeEmptyArrayLike(proto, extraDescriptors = {}) {
    const obj = Object.create(proto || Object.prototype);
    Object.defineProperties(obj, {
      length: {
        value: 0,
        enumerable: false,
      },
      item: {
        value() {
          return null;
        },
        enumerable: false,
      },
      namedItem: {
        value() {
          return null;
        },
        enumerable: false,
      },
      ...extraDescriptors,
    });
    return Object.freeze(obj);
  }

  const emptyPlugins = makeEmptyArrayLike(
    typeof PluginArray !== "undefined" ? PluginArray.prototype : undefined,
    {
      refresh: {
        value() {},
        enumerable: false,
      },
    }
  );

  const emptyMimeTypes = makeEmptyArrayLike(
    typeof MimeTypeArray !== "undefined" ? MimeTypeArray.prototype : undefined
  );

  // Use a stable but common CPU bucket to reduce entropy without thrashing
  // sites that size work pools from this value.
  const HARDWARE_BUCKETS = [2, 4, 8];
  const hardwareConcurrency =
    HARDWARE_BUCKETS[rand32() % HARDWARE_BUCKETS.length];

  defineGetter(Navigator.prototype, "plugins", () => emptyPlugins);
  defineGetter(Navigator.prototype, "mimeTypes", () => emptyMimeTypes);
  defineGetter(
    Navigator.prototype,
    "hardwareConcurrency",
    () => hardwareConcurrency
  );
  defineGetter(Navigator.prototype, "pdfViewerEnabled", () => false);

  // ── WebRTC host-candidate filtering ──────────────────────────────────────────
  //
  // Host ICE candidates reveal the machine's actual LAN/VPN IP address.
  // We intercept RTCPeerConnection to drop any "typ host" candidate event
  // before the page's handler sees it, preventing local IP leaks through
  // WebRTC even when a proxy or VPN is in use.
  //
  // Server-reflexive (srflx) and relay (relay) candidates are kept intact
  // so audio/video calling applications continue to work normally.

  try {
    const _OrigRTC = window.RTCPeerConnection;
    if (typeof _OrigRTC === "function") {
      const _proto = _OrigRTC.prototype;
      const _origAddEventListener = _proto.addEventListener;
      const _origIceCandPropDesc = Object.getOwnPropertyDescriptor(
        _proto,
        "onicecandidate"
      );

      /** Returns true when the SDP candidate line is a "typ host" entry. */
      function _isHostCandidate(event) {
        const c = event && event.candidate;
        return (
          !!c &&
          typeof c.candidate === "string" &&
          /\btyp host\b/.test(c.candidate)
        );
      }

      /**
       * Wraps an icecandidate listener so host candidates are silently
       * dropped before reaching the application handler.
       */
      function _wrapListener(listener) {
        if (typeof listener !== "function") {
          return listener;
        }
        return function _filteredIceCandidateHandler(event) {
          if (!_isHostCandidate(event)) {
            return listener.call(this, event);
          }
        };
      }

      // Patch addEventListener so dynamically added listeners are also wrapped.
      _proto.addEventListener = function farblingAddEventListener(
        type,
        listener,
        ...rest
      ) {
        return _origAddEventListener.call(
          this,
          type,
          type === "icecandidate" ? _wrapListener(listener) : listener,
          ...rest
        );
      };

      // Patch the onicecandidate setter so property-style handlers are wrapped.
      if (_origIceCandPropDesc && _origIceCandPropDesc.set) {
        Object.defineProperty(_proto, "onicecandidate", {
          get: _origIceCandPropDesc.get,
          set(handler) {
            _origIceCandPropDesc.set.call(this, _wrapListener(handler));
          },
          configurable: true,
        });
      }
    }
  } catch (_) {
    // Non-fatal — RTCPeerConnection may not exist in this context.
  }
})();
