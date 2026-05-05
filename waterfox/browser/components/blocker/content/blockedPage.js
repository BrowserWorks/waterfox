/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Wires up the blocked page UI for blocked navigations.
 *
 * It reads the blocked URL, matched rule, and bypass token from this page's
 * query string.
 */

/**
 * Parses blocked-page state from the current document URI.
 *
 * @returns {{blockedUrl: string, matchedRule: string, token: string}}
 *   Parsed blocked URL, matched rule text, and bypass token.
 */
function parseState() {
  try {
    // `new URL()` is quirky with about: (non-special) schemes, so slice manually.
    const documentUri = document.documentURI || "";
    const queryIndex = documentUri.indexOf("?");
    const queryString =
      queryIndex >= 0 ? documentUri.slice(queryIndex + 1) : "";
    const params = new URLSearchParams(queryString);
    return {
      blockedUrl: params.get("url") || "",
      matchedRule: params.get("rule") || "",
      token: params.get("token") || "",
    };
  } catch (_) {
    // Malformed page URIs leave the UI in a safe disabled state.
    return {
      blockedUrl: "",
      matchedRule: "",
      token: "",
    };
  }
}

const BLOCKED_PAGE_UNAVAILABLE_L10N_ID = "waterfox-blocked-page-unavailable";
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isValidBlockedUrl(url) {
  return (
    typeof url === "string" &&
    (url.startsWith("http://") || url.startsWith("https://"))
  );
}

function isValidBypassToken(token) {
  return typeof token === "string" && UUID_RE.test(token);
}

/**
 * Updates a UI field with literal text or a localised fallback message.
 *
 * @param {string} id
 *   Element id to update.
 * @param {string} value
 *   Text value to write when available.
 * @param {string} [fallbackL10nId=""]
 *   Localisation id used when `value` is empty.
 */
function setText(id, value, fallbackL10nId = "") {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }

  if (value) {
    if (fallbackL10nId) {
      node.removeAttribute("data-l10n-id");
    }
    node.textContent = value;
    return;
  }

  if (fallbackL10nId) {
    node.textContent = "";
    document.l10n?.setAttributes(node, fallbackL10nId);
    return;
  }

  node.textContent = "";
}

function goBack() {
  if (window.history.length > 1) {
    window.history.back();
    return;
  }

  window.location.href = "about:home";
}

/**
 * Continues to the blocked URL when a valid bypass token is present.
 *
 * @param {{blockedUrl: string, token: string}} state
 *   Parsed blocked-page state from `parseState`.
 */
function loadAnyway(state) {
  if (
    !isValidBlockedUrl(state.blockedUrl) ||
    !isValidBypassToken(state.token)
  ) {
    return;
  }

  // The service consumes the bypass token from this page URI and then adds
  // a temporary site exception while loading the original URL.
  window.location.assign(state.blockedUrl);
}

function initPage() {
  const state = parseState();
  const validBlockedUrl = isValidBlockedUrl(state.blockedUrl);
  const validToken = isValidBypassToken(state.token);

  setText(
    "blocked-url",
    validBlockedUrl ? state.blockedUrl : "Invalid URL",
    BLOCKED_PAGE_UNAVAILABLE_L10N_ID
  );
  setText("matched-rule", state.matchedRule, BLOCKED_PAGE_UNAVAILABLE_L10N_ID);

  const goBackButton = document.getElementById("go-back");
  const loadAnywayButton = document.getElementById("load-anyway");
  if (!goBackButton || !loadAnywayButton) {
    return;
  }

  goBackButton.addEventListener("click", goBack);

  const canLoadAnyway = validBlockedUrl && validToken;
  loadAnywayButton.disabled = !canLoadAnyway;
  loadAnywayButton.addEventListener("click", () => {
    loadAnyway(state);
  });
}

initPage();
