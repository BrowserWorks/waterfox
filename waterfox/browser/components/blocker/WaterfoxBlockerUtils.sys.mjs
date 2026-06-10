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

export function isPrivateOriginAttributes(originAttributes) {
  return Number(originAttributes?.privateBrowsingId || 0) > 0;
}

export function isPrivateBrowsingContext(browsingContext) {
  try {
    const top = browsingContext?.top;
    return !!(
      browsingContext?.usePrivateBrowsing ||
      top?.usePrivateBrowsing ||
      isPrivateOriginAttributes(
        browsingContext?.currentWindowGlobal?.documentPrincipal
          ?.originAttributes
      ) ||
      isPrivateOriginAttributes(
        top?.currentWindowGlobal?.documentPrincipal?.originAttributes
      )
    );
  } catch (_) {
    return false;
  }
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

export const MAX_PROCEDURAL_CANDIDATES = 2000;

export function filterProceduralCandidates(candidates, predicate) {
  const out = [];

  const consider = element => {
    if (element?.nodeType !== 1) {
      return false;
    }

    try {
      if (predicate(element)) {
        out.push(element);
        return out.length >= MAX_PROCEDURAL_CANDIDATES;
      }
    } catch (_) {
      // Invalid procedural checks are treated as non-matches.
    }

    return false;
  };

  for (const candidate of candidates) {
    if (candidate?.nodeType === 1) {
      if (consider(candidate)) {
        break;
      }
      continue;
    }

    if (candidate?.nodeType !== 9 && candidate?.nodeType !== 11) {
      continue;
    }

    try {
      for (const element of candidate.querySelectorAll("*")) {
        if (consider(element)) {
          return out;
        }
      }
    } catch (_) {
      // Invalid selectors are ignored for this candidate set.
    }
  }

  return out;
}

export function applyProceduralUpward(candidates, arg) {
  const out = [];
  const seen = new Set();
  const count = Number.parseInt(arg, 10);

  for (const candidate of candidates) {
    if (candidate?.nodeType !== 1) {
      continue;
    }

    let target = null;
    if (Number.isFinite(count)) {
      target = candidate;
      for (let i = 0; i < count && target; i++) {
        target = target.parentElement;
      }
    } else {
      try {
        target = candidate.closest(arg);
      } catch (_) {
        // Invalid closest() selector.
        target = null;
      }
    }

    if (target && !seen.has(target)) {
      seen.add(target);
      out.push(target);
    }
  }

  return out;
}

export function forEachBrowserWindow(callback) {
  const windows = Services.wm.getEnumerator("navigator:browser");
  while (windows.hasMoreElements()) {
    const win = windows.getNext();
    try {
      callback(win);
    } catch (_) {
      // Keep iterating windows even if one callback fails.
    }
  }
}
