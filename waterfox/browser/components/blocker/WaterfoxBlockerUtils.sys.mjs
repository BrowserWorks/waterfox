/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Profile storage layout.
export const CACHE_ROOT_DIR_NAME = "waterfox-blocker";
export const LISTS_DIR_NAME = "lists";
export const CUSTOM_FILTERS_FILE_NAME = "custom-filters.txt";
export const LISTS_META_FILE_NAME = "metadata.json";

/**
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
  "adnauseam@rednoise.org",
]);

/**
 * @param {string} input
 * @returns {string}
 */
export function toSafeDomain(input) {
  return String(input || "")
    .trim()
    .toLowerCase();
}

/**
 * Callers should provide their own fallback when both name and id are empty
 * (the preferences pane uses a localised "this extension" string, while the
 * extension detector uses a Fluent lookup).
 *
 * @param {object} addon
 * @returns {string}
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
 * Matches only against the curated `KNOWN_ADBLOCK_IDS` list. Pattern matching
 * on names/descriptions is deliberately avoided because descriptions are
 * marketing copy and routinely produce false positives for unrelated privacy
 * tools.
 *
 * @param {object} addon
 * @returns {boolean}
 */
export function isAdblockAddon(addon) {
  if (!addon || addon.type !== "extension") {
    return false;
  }

  return KNOWN_ADBLOCK_IDS.includes(addon.id);
}

/**
 * @param {object} addon
 * @returns {boolean}
 */
export function isEnabledAdblockAddon(addon) {
  return !!addon?.isActive && !addon?.userDisabled && isAdblockAddon(addon);
}
