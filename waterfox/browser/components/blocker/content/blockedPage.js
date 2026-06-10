/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * The blocked URL and matched rule are read from this page's query string.
 * The "Load anyway" click is delegated to the WaterfoxBlockedPage actor,
 * which records a permission for the session in the parent before
 * navigating.
 */

/**
 * @returns {{blockedUrl: string, matchedRule: string}}
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
    };
  } catch (_) {
    // Malformed page URIs leave the UI in a safe disabled state.
    return {
      blockedUrl: "",
      matchedRule: "",
    };
  }
}

const BLOCKED_PAGE_UNAVAILABLE_L10N_ID = "waterfox-blocked-page-unavailable";

function isValidBlockedUrl(url) {
  return (
    typeof url === "string" &&
    (url.startsWith("http://") || url.startsWith("https://"))
  );
}

/**
 * @param {string} id
 * @param {string} value
 * @param {string} [fallbackL10nId=""] Used when `value` is empty.
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

function initPage() {
  const state = parseState();
  const validBlockedUrl = isValidBlockedUrl(state.blockedUrl);

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
  loadAnywayButton.disabled = !validBlockedUrl;
  // Navigation runs in WaterfoxBlockedPageChild after the parent records a
  // permission for the session on the blocked host.
}

initPage();
