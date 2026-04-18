/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Shared constants and pure functions used by multiple blocker modules.
 *
 * Addon detection lists, domain normalisation, and display name helpers live
 * here so the extension detector, preferences pane, and panel code stay in
 * sync without duplicating logic.
 */

/**
 * Extension IDs known to provide ad/content blocking.
 *
 * Keep this list focused on extensions whose primary purpose is ad or tracker
 * blocking. Privacy tools like NoScript or Privacy Badger that do not
 * primarily block ads should not be listed here.
 */
export const KNOWN_ADBLOCK_IDS = Object.freeze([
  "uBlock0@raymondhill.net",
  "{d10d0bf8-f5b5-c8b4-a8b2-2b9879e08c5d}", // Adblock Plus
  "jid1-NIfFY2CA8fy1tg@jetpack", // AdBlock
  "adguardadblocker@nicola.nicola", // AdGuard
  "addon@nicola.nicola", // Ghostery
]);

/**
 * Name/description patterns that suggest an extension provides ad blocking.
 */
export const ADBLOCK_NAME_PATTERNS = Object.freeze([
  /\badblock/i,
  /\bad\s*block/i,
  /\bublock/i,
  /\bad\s*guard/i,
  /\bad\s*blocker/i,
]);

/**
 * Normalises a domain string for safe comparison.
 *
 * @param {string} input
 * @returns {string} Trimmed, lowercased domain or empty string.
 */
export function toSafeDomain(input) {
  return String(input || "")
    .trim()
    .toLowerCase();
}

/**
 * Returns a human-readable name for an addon, falling back to its id.
 *
 * Callers should provide their own fallback when both name and id are empty
 * (the preferences pane uses a localised "this extension" string, while the
 * extension detector uses a Fluent lookup).
 *
 * @param {object} addon
 * @returns {string} Display name, addon id, or empty string.
 */
export function addonDisplayName(addon) {
  const name = String(addon?.name || "").trim();
  if (name) {
    return name;
  }

  const id = String(addon?.id || "").trim();
  if (id) {
    return id;
  }

  return "";
}

/**
 * Returns whether an addon looks like an ad/content blocker.
 *
 * Checks the known ID list first, then falls back to conservative name
 * matching for well-known ad blocker terms.
 *
 * @param {object} addon
 * @returns {boolean}
 */
export function isAdblockAddon(addon) {
  if (!addon || addon.type !== "extension") {
    return false;
  }

  if (KNOWN_ADBLOCK_IDS.includes(addon.id)) {
    return true;
  }

  const searchableName = String(addon.name || "");
  if (!searchableName.trim()) {
    return false;
  }

  return ADBLOCK_NAME_PATTERNS.some(pattern => pattern.test(searchableName));
}

/**
 * Returns whether an addon is both active and looks like an ad blocker.
 *
 * @param {object} addon
 * @returns {boolean}
 */
export function isEnabledAdblockAddon(addon) {
  return !!addon?.isActive && !addon?.userDisabled && isAdblockAddon(addon);
}
