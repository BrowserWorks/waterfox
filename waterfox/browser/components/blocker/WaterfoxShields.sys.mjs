/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * WaterfoxShields — per-site privacy shields state management.
 *
 * Global defaults are stored as integer prefs:
 *   waterfox.shields.fingerprinting   — 0=off, 1=standard, 2=strict
 *   waterfox.shields.languageReduction — 0=off, 1=standard, 2=strict
 *
 * Per-site overrides are stored as a JSON object in:
 *   waterfox.shields.siteSettings
 *   e.g. { "example.com": { "fingerprinting": 1 } }
 *
 * Fingerprinting level semantics:
 *   0 (off)      — no overrides
 *   1 (standard) — enable Firefox privacy.resistFingerprinting
 *   2 (strict)   — RFP + farbling content-script injection
 *
 * Language reduction level semantics (mirrors Brave's reduce-language behaviour):
 *   0 (off)      — Accept-Language sent verbatim
 *   1 (standard) — primary language tag only, no q-values
 *   2 (strict)   — always "en-US,en;q=0.9"
 */

const PREF_FINGERPRINTING = "waterfox.shields.fingerprinting";
const PREF_LANGUAGE_REDUCTION = "waterfox.shields.languageReduction";
const PREF_SITE_SETTINGS = "waterfox.shields.siteSettings";

// Maps fingerprinting level → privacy.resistFingerprinting pref value.
const RFP_LEVELS = Object.freeze({ 0: false, 1: true, 2: true });

export const WaterfoxShields = {
  // ---------------------------------------------------------------------------
  // Global defaults
  // ---------------------------------------------------------------------------

  /**
   * Returns the global fingerprinting protection level (0/1/2).
   *
   * @returns {number}
   */
  getGlobalFingerprintingLevel() {
    return Services.prefs.getIntPref(PREF_FINGERPRINTING, 0);
  },

  /**
   * Sets the global fingerprinting protection level and syncs the underlying
   * privacy.resistFingerprinting pref so Gecko's built-in protections follow.
   * Also syncs WebRTC ICE prefs to prevent local IP leaks at level ≥ 1.
   *
   * @param {number} level 0, 1, or 2
   */
  setGlobalFingerprintingLevel(level) {
    const clamped = Math.max(0, Math.min(2, Math.trunc(level)));
    Services.prefs.setIntPref(PREF_FINGERPRINTING, clamped);
    // Mirror to Firefox's native RFP engine.
    const rfpValue = RFP_LEVELS[clamped] ?? false;
    Services.prefs.setBoolPref("privacy.resistFingerprinting", rfpValue);
    // Sync WebRTC ICE candidate prefs to match the shield level.
    this._syncWebRtcPrefs(clamped);
  },

  /**
   * Synchronises WebRTC ICE candidate preferences to prevent local IP
   * address leaks at shield level ≥ 1.
   *
   * Level 0 (off)      — restore Gecko defaults.
   * Level 1 (standard) — hide local IPs: use default interface address only.
   * Level 2 (strict)   — also suppress host candidates entirely.
   *
   * @param {number} level 0, 1, or 2
   */
  _syncWebRtcPrefs(level) {
    try {
      if (level >= 2) {
        // Strict: block all host (local IP) ICE candidates.
        Services.prefs.setBoolPref(
          "media.peerconnection.ice.no_host",
          true
        );
        Services.prefs.setBoolPref(
          "media.peerconnection.ice.default_address_only",
          true
        );
      } else if (level >= 1) {
        // Standard: limit to default interface; hides most local IPs.
        Services.prefs.setBoolPref(
          "media.peerconnection.ice.no_host",
          false
        );
        Services.prefs.setBoolPref(
          "media.peerconnection.ice.default_address_only",
          true
        );
      } else {
        // Off: restore Gecko defaults.
        Services.prefs.clearUserPref("media.peerconnection.ice.no_host");
        Services.prefs.clearUserPref(
          "media.peerconnection.ice.default_address_only"
        );
      }
    } catch (_) {
      // Non-fatal — pref API may not be available in all contexts.
    }
  },

  /**
   * Returns the global language-reduction level (0/1/2).
   *
   * @returns {number}
   */
  getGlobalLanguageReduction() {
    return Services.prefs.getIntPref(PREF_LANGUAGE_REDUCTION, 0);
  },

  /**
   * Sets the global language-reduction level.
   *
   * @param {number} level 0, 1, or 2
   */
  setGlobalLanguageReduction(level) {
    const clamped = Math.max(0, Math.min(2, Math.trunc(level)));
    Services.prefs.setIntPref(PREF_LANGUAGE_REDUCTION, clamped);
  },

  // ---------------------------------------------------------------------------
  // Per-site settings
  // ---------------------------------------------------------------------------

  /**
   * Parses and returns the full site-settings map from the pref.
   *
   * @returns {object} mapping hostname → settings object
   */
  _loadSiteSettings() {
    try {
      const raw = Services.prefs.getStringPref(PREF_SITE_SETTINGS, "{}");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch (_) {}
    return {};
  },

  /**
   * Persists the full site-settings map to the pref.
   *
   * @param {object} map
   */
  _saveSiteSettings(map) {
    Services.prefs.setStringPref(PREF_SITE_SETTINGS, JSON.stringify(map));
  },

  /**
   * Returns the saved per-site settings object for a hostname, or `{}` if
   * no override has been recorded.
   *
   * @param {string} hostname
   * @returns {object}
   */
  getSiteSettings(hostname) {
    if (!hostname) {
      return {};
    }
    const map = this._loadSiteSettings();
    return map[hostname] ?? {};
  },

  /**
   * Merges `settings` into the existing per-site record for `hostname` and
   * persists.  Pass `null` for a key to remove that override.
   *
   * @param {string} hostname
   * @param {object} settings  e.g. { fingerprinting: 1 }
   */
  setSiteSettings(hostname, settings) {
    if (!hostname || !settings || typeof settings !== "object") {
      return;
    }
    const map = this._loadSiteSettings();
    const existing = map[hostname] ?? {};
    for (const [key, value] of Object.entries(settings)) {
      if (value === null || value === undefined) {
        delete existing[key];
      } else {
        existing[key] = value;
      }
    }
    if (Object.keys(existing).length === 0) {
      delete map[hostname];
    } else {
      map[hostname] = existing;
    }
    this._saveSiteSettings(map);
  },

  /**
   * Removes all per-site overrides for `hostname`.
   *
   * @param {string} hostname
   */
  clearSiteSettings(hostname) {
    if (!hostname) {
      return;
    }
    const map = this._loadSiteSettings();
    delete map[hostname];
    this._saveSiteSettings(map);
  },

  // ---------------------------------------------------------------------------
  // Effective (merged) values
  // ---------------------------------------------------------------------------

  /**
   * Returns the effective fingerprinting level for `hostname`, combining the
   * per-site override (if any) with the global default.
   *
   * @param {string} hostname
   * @returns {number} 0, 1, or 2
   */
  getEffectiveFingerprintingLevel(hostname) {
    const globalLevel = this.getGlobalFingerprintingLevel();
    if (globalLevel === 0) {
      return 0;
    }

    const site = this.getSiteSettings(hostname);
    if (typeof site.fingerprinting === "number") {
      return Math.max(0, Math.min(2, site.fingerprinting));
    }
    return globalLevel;
  },

  /**
   * Returns the effective language-reduction level for `hostname`.
   *
   * @param {string} hostname
   * @returns {number} 0, 1, or 2
   */
  getEffectiveLanguageReduction(hostname) {
    const globalLevel = this.getGlobalLanguageReduction();
    if (globalLevel === 0) {
      return 0;
    }

    const site = this.getSiteSettings(hostname);
    if (typeof site.languageReduction === "number") {
      return Math.max(0, Math.min(2, site.languageReduction));
    }
    return globalLevel;
  },

  /**
   * Human-readable label for a level number (used in UI and panel).
   *
   * @param {number} level
   * @returns {"off"|"standard"|"strict"}
   */
  levelToLabel(level) {
    switch (level) {
      case 1:
        return "standard";
      case 2:
        return "strict";
      default:
        return "off";
    }
  },
};
