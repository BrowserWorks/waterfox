/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export {
  MAX_CUSTOM_FILTERS_BYTES,
  MAX_CUSTOM_FILTER_LINE_LENGTH,
  normalizeCustomFiltersText,
} from "resource:///modules/internal/ListStore.sys.mjs";

import {
  applyProceduralUpward,
  filterProceduralCandidates,
  isPrivateBrowsingContext,
  MAX_PROCEDURAL_CANDIDATES,
} from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "urlClassifier", () => {
  try {
    return Cc["@mozilla.org/url-classifier/dbservice;1"].getService(
      Ci.nsIURIClassifier
    );
  } catch (_) {
    return null;
  }
});

ChromeUtils.defineLazyGetter(lazy, "trackingClassifierFeature", () => {
  try {
    return lazy.urlClassifier?.getFeatureByName("tracking-annotation") || null;
  } catch (_) {
    return null;
  }
});

ChromeUtils.defineESModuleGetters(lazy, {
  EngineCache: "resource:///modules/internal/EngineCache.sys.mjs",
  ListCatalog: "resource:///modules/internal/ListCatalog.sys.mjs",
  ListPreprocessor: "resource:///modules/internal/ListPreprocessor.sys.mjs",
  ListStore: "resource:///modules/internal/ListStore.sys.mjs",
  ListUpdatesState: "resource:///modules/internal/ListUpdates.sys.mjs",
  RemoteResources: "resource:///modules/internal/RemoteResources.sys.mjs",
  Resources: "resource:///modules/internal/Resources.sys.mjs",
  SiteExceptionsState: "resource:///modules/internal/SiteExceptions.sys.mjs",
  clearInterval: "resource://gre/modules/Timer.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setInterval: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

const CONTRACT_ID = "@waterfox.com/waterfox-blocker-engine;1";

ChromeUtils.defineLazyGetter(lazy, "blockerPolicy", () =>
  Cc[CONTRACT_ID].createInstance(Ci.nsIWaterfoxBlockerEngine)
);

// Prefs
const PREF_ENABLED = "waterfox.blocker.enabled";
const PREF_ALLOW_SEARCH_PARTNER_ADS = "waterfox.blocker.allowSearchPartnerAds";
const PREF_FILTER_LIST_URLS = "waterfox.blocker.filterListUrls";
const PREF_ENABLED_LISTS = "waterfox.blocker.enabledLists";
const PREF_LEGACY_SITE_EXCEPTIONS = "waterfox.blocker.siteExceptions";
const PREF_SITE_EXCEPTIONS_MIGRATED =
  "waterfox.blocker.siteExceptions.migrated";
const PREF_REMOTE_RESOURCES_ENABLED = "waterfox.blocker.remoteResourcesEnabled";
const PREF_GLOBAL_STATS = "waterfox.blocker.globalStats";
const PREF_DOMAIN_EXCEPTIONS = "waterfox.blocker.domainExceptions";
const PREF_BRANCH = "waterfox.blocker.";

const BLOCKED_COUNT_MAP_MAX_ENTRIES = 500;
const BLOCKED_COUNT_MAP_TRIM_TO_ENTRIES = 250;
const BLOCKED_DOMAINS_PER_TAB_MAX = 60;
const DOMAIN_EXCEPTIONS_SITES_MAX = 200;
const DOMAIN_EXCEPTIONS_PER_SITE_MAX = 100;
const GLOBAL_STATS_FLUSH_DELAY_MS = 30 * 1000;
// Rough average payload of a blocked request, used only for the "data saved"
// estimate shown in the panel footer.
const ESTIMATED_BYTES_PER_BLOCKED_REQUEST = 12 * 1024;
// The engine does not report which list a match came from, so blocked
// requests are bucketed for the panel by request shape and by checking the
// domain against the url-classifier tracking tables.
const TRACKER_REQUEST_TYPES = new Set(["ping", "csp_report"]);
const TRACKER_DOMAIN_CACHE_MAX = 500;
const TOPIC_BLOCKED_COUNT_UPDATED = "WaterfoxBlocker:BlockedCountUpdated";
const TOPIC_BLOCKED_COUNTS_CLEARED = "WaterfoxBlocker:BlockedCountsCleared";
const TOPIC_PREF_CHANGED = "nsPref:changed";
const TOPIC_PERMISSION_CHANGED = "perm-changed";

const INIT_RETRY_DELAY_MS = 30 * 1000;
const LIST_UPDATE_FALLBACK_INTERVAL_MS = 60 * 60 * 1000;
const REMOTE_SETTINGS_POLL_END_TOPIC = "remote-settings:changes-poll-end";
const REPLACE_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
export const REPLACE_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const BYTE_STRING_CHUNK_SIZE = 0x8000;
export const MAX_REPLACE_DIRECTIVES = 25;
const MAX_HTML_FILTERS = 250;
const MAX_RESPONSE_HEADER_FILTERS = 100;
const HTML_FILTER_MAX_BYTES = 2 * 1024 * 1024;
const CSS_STYLE_RULE_TYPE = 1;
const REPLACE_ALLOWED_REQUEST_TYPES = new Set([
  "document",
  "subdocument",
  "script",
  "stylesheet",
  "xmlhttprequest",
  "other",
]);
const HTML_FILTER_ALLOWED_CONTENT_TYPES = new Set([
  "application/xhtml+xml",
  "text/html",
]);
const DOCUMENT_STYLE_RULE_CACHE = new WeakMap();

const REPLACE_ALLOWED_CONTENT_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/json",
  "application/ld+json",
  "application/rss+xml",
  "application/xhtml+xml",
  "application/xml",
  "application/x-javascript",
  "image/svg+xml",
  "text/css",
  "text/ecmascript",
  "text/html",
  "text/javascript",
  "text/json",
  "text/plain",
  "text/xml",
]);

// Sanitises strings for safe passage through ACString XPConnect params
function sanitizeStringList(input, maxItems, maxTokenLength = 1024) {
  if (!Array.isArray(input) || !input.length) {
    return [];
  }

  const out = [];
  const seen = new Set();

  for (const token of input) {
    if (typeof token !== "string") {
      continue;
    }

    const normalized = token.toWellFormed().trim();
    if (!normalized || normalized.length > maxTokenLength) {
      continue;
    }

    if (seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    out.push(normalized);

    if (out.length >= maxItems) {
      break;
    }
  }

  return out;
}

/**
 * Produces a JSON string containing only ASCII code points, so it can be
 * passed to an ACString XPCOM parameter without NS_ERROR_ILLEGAL_VALUE.
 *
 * @param {any} value
 * @returns {string}
 */
function toAsciiSafeJson(value) {
  return JSON.stringify(value).replace(
    /[\u0080-\uFFFF]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function getResponseHeader(channel, headerName) {
  try {
    return channel.getResponseHeader(headerName) || "";
  } catch (_) {
    return "";
  }
}

function getResponseContentType(channel) {
  try {
    if (channel.contentType) {
      return channel.contentType;
    }
  } catch (_) {
    // Fall back to the raw header below.
  }
  return getResponseHeader(channel, "Content-Type");
}

function removeResponseContentLength(channel) {
  try {
    channel.setResponseHeader("Content-Length", "", false);
  } catch (_) {
    // Some synthetic or cached channels do not allow header mutation here.
  }
}

function normalizeMimeType(contentType) {
  return String(contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function getDeclaredCharset(channel, contentType) {
  try {
    if (channel.contentCharset) {
      return channel.contentCharset;
    }
  } catch (_) {
    // Fall back to the raw header below.
  }

  const match = String(contentType || "").match(
    /(?:^|;)\s*charset\s*=\s*"?([^";\s]+)"?/i
  );
  return match?.[1] || "utf-8";
}

function isReplaceEligibleContent(channel, requestType) {
  if (!REPLACE_ALLOWED_REQUEST_TYPES.has(requestType)) {
    return false;
  }

  if (
    /^\s*attachment(?:\s*;|$)/i.test(
      getResponseHeader(channel, "Content-Disposition")
    )
  ) {
    return false;
  }

  try {
    const status = Number(channel.responseStatus || 0);
    if (status === 206 || status === 304) {
      return false;
    }
  } catch (_) {
    // Some channels do not expose response status here.
  }

  const mimeType = normalizeMimeType(getResponseContentType(channel));
  if (!mimeType) {
    return requestType === "script" || requestType === "stylesheet";
  }

  return (
    mimeType.startsWith("text/") ||
    REPLACE_ALLOWED_CONTENT_TYPES.has(mimeType) ||
    mimeType.endsWith("+json") ||
    mimeType.endsWith("+xml")
  );
}

function isHtmlFilterEligibleContent(channel, requestType) {
  if (requestType !== "document" && requestType !== "subdocument") {
    return false;
  }

  if (
    /^\s*attachment(?:\s*;|$)/i.test(
      getResponseHeader(channel, "Content-Disposition")
    )
  ) {
    return false;
  }

  try {
    const status = Number(channel.responseStatus || 0);
    if (status === 206 || status === 304 || (status >= 300 && status < 400)) {
      return false;
    }
  } catch (_) {
    // Some channels do not expose response status here.
  }

  const mimeType = normalizeMimeType(getResponseContentType(channel));
  return !mimeType || HTML_FILTER_ALLOWED_CONTENT_TYPES.has(mimeType);
}

function bytesToByteString(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += BYTE_STRING_CHUNK_SIZE) {
    parts.push(
      String.fromCharCode(
        ...bytes.subarray(i, Math.min(i + BYTE_STRING_CHUNK_SIZE, bytes.length))
      )
    );
  }
  return parts.join("");
}

function concatByteChunks(chunks, totalLength) {
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function byteStringToBytes(byteString) {
  const bytes = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    bytes[i] = byteString.charCodeAt(i) & 0xff;
  }
  return bytes;
}

function makeUnicodeConverter(charset) {
  const converter = Cc[
    "@mozilla.org/intl/scriptableunicodeconverter"
  ].createInstance(Ci.nsIScriptableUnicodeConverter);
  converter.charset = charset || "UTF-8";
  return converter;
}

function decodeResponseBytes(bytes, charset) {
  return makeUnicodeConverter(charset).ConvertToUnicode(
    bytesToByteString(bytes)
  );
}

function encodeResponseText(text, charset) {
  const converter = makeUnicodeConverter(charset);
  return byteStringToBytes(
    converter.ConvertFromUnicode(text) + converter.Finish()
  );
}

function readReplaceSegment(input, startIndex) {
  let value = "";
  let escaped = false;

  for (let i = startIndex; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      value += char === "/" ? "/" : `\\${char}`;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "/") {
      return { nextIndex: i + 1, value };
    }

    value += char;
  }

  if (escaped) {
    value += "\\";
  }

  throw new Error("Unterminated replace segment");
}

function parseReplaceDirective(directive) {
  let input = String(directive || "").trim();
  if (input.startsWith("replace=")) {
    input = input.slice("replace=".length);
  }

  if (!input.startsWith("/")) {
    throw new Error("Unsupported replace directive");
  }

  const pattern = readReplaceSegment(input, 1);
  const replacement = readReplaceSegment(input, pattern.nextIndex);
  const flags = input.slice(replacement.nextIndex).trim();

  if (!/^[gims]*$/.test(flags)) {
    throw new Error("Unsupported replace flags");
  }

  return {
    regex: new RegExp(pattern.value, flags),
    replacement: replacement.value,
  };
}

function applyReplaceDirectives(text, directives) {
  let next = text;

  for (const directive of directives) {
    try {
      const { regex, replacement } = parseReplaceDirective(directive);
      next = next.replace(regex, replacement);
    } catch (err) {
      console.warn(
        "[WaterfoxBlocker] Skipping invalid $replace directive:",
        err
      );
    }
  }

  return next;
}

function normalizeProceduralPattern(pattern) {
  const rawPattern = String(pattern || "").trim();
  if (
    rawPattern.length >= 2 &&
    ((rawPattern.startsWith('"') && rawPattern.endsWith('"')) ||
      (rawPattern.startsWith("'") && rawPattern.endsWith("'")))
  ) {
    return rawPattern.slice(1, -1);
  }
  return rawPattern;
}

function matchesProceduralPattern(value, pattern) {
  const text = String(value || "");
  const rawPattern = normalizeProceduralPattern(pattern);
  if (!rawPattern) {
    return false;
  }

  const regexMatch = rawPattern.match(/^\/((?:\\.|[^/])+)\/([gimsuy]*)$/);
  if (regexMatch) {
    try {
      const flags = regexMatch[2].replaceAll("g", "");
      return new RegExp(regexMatch[1], flags).test(text);
    } catch (_) {
      return false;
    }
  }

  return text.includes(rawPattern);
}

function normalizeHtmlFilterSelector(selector) {
  const normalized = String(selector || "").trim();
  if (/^[>+~]/.test(normalized)) {
    return `:scope ${normalized}`;
  }
  return normalized;
}

function queryHtmlFilterSelector(candidates, selector) {
  const normalizedSelector = normalizeHtmlFilterSelector(selector);
  if (!normalizedSelector) {
    return [];
  }

  const out = [];
  const matchCandidate = !normalizedSelector.startsWith(":scope ");
  for (const candidate of candidates) {
    if (
      candidate?.nodeType !== 1 &&
      candidate?.nodeType !== 9 &&
      candidate?.nodeType !== 11
    ) {
      continue;
    }

    try {
      if (
        matchCandidate &&
        candidate.nodeType === 1 &&
        candidate.matches(normalizedSelector)
      ) {
        out.push(candidate);
      }

      for (const element of candidate.querySelectorAll(normalizedSelector)) {
        out.push(element);
        if (out.length >= MAX_PROCEDURAL_CANDIDATES) {
          return out;
        }
      }
    } catch (_) {
      return [];
    }
  }

  return out;
}

function matchesHtmlFilterAttr(element, arg) {
  const match = String(arg || "").match(
    /^\s*([^\s~|^$*!=]+)\s*(?:=\s*(.+))?\s*$/
  );
  if (!match || !element.hasAttribute(match[1])) {
    return false;
  }

  if (match[2] === undefined) {
    return true;
  }

  return matchesProceduralPattern(
    element.getAttribute(match[1]) || "",
    match[2].replace(/^["']|["']$/g, "")
  );
}

function matchesHtmlFilterPath(documentUrl, arg) {
  try {
    const url = new URL(documentUrl);
    const path = `${url.pathname}${url.search}${url.hash}`;
    return (
      matchesProceduralPattern(url.href, arg) ||
      matchesProceduralPattern(path, arg)
    );
  } catch (_) {
    return false;
  }
}

function splitCssSelectorList(selectorText) {
  const selectors = [];
  const input = String(selectorText || "");
  let start = 0;
  let quote = "";
  let escaped = false;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "[") {
      bracketDepth++;
      continue;
    }

    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    if (char === "(") {
      parenDepth++;
      continue;
    }

    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (char === "," && !parenDepth && !bracketDepth) {
      const selector = input.slice(start, i).trim();
      if (selector) {
        selectors.push(selector);
      }
      start = i + 1;
    }
  }

  const selector = input.slice(start).trim();
  if (selector) {
    selectors.push(selector);
  }
  return selectors;
}

function stripCssComments(cssText) {
  return String(cssText || "").replaceAll(/\/\*[\s\S]*?\*\//g, "");
}

function findCssBlockEnd(input, startIndex) {
  let quote = "";
  let escaped = false;
  let depth = 1;

  for (let i = startIndex; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;
      if (!depth) {
        return i;
      }
    }
  }

  return -1;
}

function splitCssDeclarations(blockText) {
  const declarations = [];
  const input = String(blockText || "");
  let start = 0;
  let quote = "";
  let escaped = false;
  let parenDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(") {
      parenDepth++;
      continue;
    }

    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (char === ";" && !parenDepth) {
      declarations.push(input.slice(start, i));
      start = i + 1;
    }
  }

  declarations.push(input.slice(start));
  return declarations;
}

function findCssDeclarationColon(declaration) {
  let quote = "";
  let escaped = false;
  let parenDepth = 0;

  for (let i = 0; i < declaration.length; i++) {
    const char = declaration[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(") {
      parenDepth++;
      continue;
    }

    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (char === ":" && !parenDepth) {
      return i;
    }
  }

  return -1;
}

function parseCssDeclarationBlock(blockText) {
  const declarations = new Map();
  for (const declaration of splitCssDeclarations(blockText)) {
    const colon = findCssDeclarationColon(declaration);
    if (colon < 0) {
      continue;
    }

    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .replace(/\s*!important\s*$/i, "")
      .trim();
    if (property && value) {
      declarations.set(property, value);
    }
  }
  return declarations;
}

function parseStyleTextRules(cssText) {
  const rules = [];
  const input = stripCssComments(cssText);
  let index = 0;

  while (index < input.length) {
    const blockStart = input.indexOf("{", index);
    if (blockStart < 0) {
      break;
    }

    const prelude = input.slice(index, blockStart).trim();
    const blockEnd = findCssBlockEnd(input, blockStart + 1);
    if (blockEnd < 0) {
      break;
    }

    const block = input.slice(blockStart + 1, blockEnd);
    if (prelude.startsWith("@")) {
      rules.push(...parseStyleTextRules(block));
    } else {
      const selectors = splitCssSelectorList(prelude);
      const declarations = parseCssDeclarationBlock(block);
      if (selectors.length && declarations.size) {
        rules.push({ selectors, declarations });
      }
    }

    index = blockEnd + 1;
  }

  return rules;
}

function cssStyleDeclarationToMap(style) {
  const declarations = new Map();
  try {
    for (let i = 0; i < style.length; i++) {
      const property = style.item(i).toLowerCase();
      const value = style.getPropertyValue(property).trim();
      if (property && value) {
        declarations.set(property, value);
      }
    }
  } catch (_) {
    // Ignore stylesheet rules whose declarations cannot be inspected.
  }
  return declarations;
}

function appendCssRules(cssRules, out) {
  for (const rule of cssRules || []) {
    try {
      if (
        rule.type === CSS_STYLE_RULE_TYPE &&
        rule.selectorText &&
        rule.style
      ) {
        const selectors = splitCssSelectorList(rule.selectorText);
        const declarations = cssStyleDeclarationToMap(rule.style);
        if (selectors.length && declarations.size) {
          out.push({ selectors, declarations });
        }
      } else if (rule.cssRules) {
        appendCssRules(rule.cssRules, out);
      }
    } catch (_) {
      // Cross-origin or malformed stylesheet rules are not available here.
    }
  }
}

function getDocumentStyleRules(doc) {
  if (!doc) {
    return [];
  }

  let rules = DOCUMENT_STYLE_RULE_CACHE.get(doc);
  if (rules) {
    return rules;
  }

  rules = [];
  try {
    for (const sheet of doc.styleSheets || []) {
      appendCssRules(sheet.cssRules, rules);
    }
  } catch (_) {
    // Fall back to inline <style> parsing below.
  }

  if (!rules.length) {
    try {
      for (const style of doc.querySelectorAll("style")) {
        rules.push(...parseStyleTextRules(style.textContent || ""));
      }
    } catch (_) {
      // Documents without querySelectorAll simply have no stylesheet fallback.
    }
  }

  DOCUMENT_STYLE_RULE_CACHE.set(doc, rules);
  return rules;
}

function cssIdentifierBoundary(char) {
  return !char || !/[A-Za-z0-9_-]/.test(char);
}

function stripPseudoElementSelector(selector, pseudo) {
  const pseudoName = String(pseudo || "")
    .replace(/^::?/, "")
    .toLowerCase();
  if (!pseudoName) {
    return null;
  }

  const input = String(selector || "");
  let quote = "";
  let escaped = false;
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "[") {
      bracketDepth++;
      continue;
    }

    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    if (char === "(") {
      parenDepth++;
      continue;
    }

    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (char !== ":" || parenDepth || bracketDepth) {
      continue;
    }

    let nameStart = i + 1;
    if (input[nameStart] === ":") {
      nameStart++;
    }

    const nameEnd = nameStart + pseudoName.length;
    if (
      input.slice(nameStart, nameEnd).toLowerCase() === pseudoName &&
      cssIdentifierBoundary(input[nameEnd])
    ) {
      return `${input.slice(0, i)}${input.slice(nameEnd)}`.trim() || "*";
    }
  }

  return null;
}

function stylesheetPropertyValue(element, property, pseudo = null) {
  const normalizedProperty = String(property || "")
    .trim()
    .toLowerCase();
  if (!normalizedProperty) {
    return "";
  }

  let value = "";
  for (const rule of getDocumentStyleRules(element.ownerDocument)) {
    if (!rule.declarations.has(normalizedProperty)) {
      continue;
    }

    for (const selector of rule.selectors) {
      const matchSelector = pseudo
        ? stripPseudoElementSelector(selector, pseudo)
        : selector;
      if (!matchSelector) {
        continue;
      }

      try {
        if (element.matches(matchSelector)) {
          value = rule.declarations.get(normalizedProperty) || "";
          break;
        }
      } catch (_) {
        // Unsupported selector syntax is ignored for stylesheet fallback.
      }
    }
  }

  return value;
}

function splitCssMatcherArg(arg) {
  const input = String(arg || "");
  let quote = "";
  let escaped = false;
  let parenDepth = 0;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === "(") {
      parenDepth++;
      continue;
    }

    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (char === ":" && !parenDepth) {
      return {
        property: input.slice(0, i).trim(),
        pattern: input.slice(i + 1).trim(),
      };
    }
  }

  return null;
}

function cssPropertyValue(element, property, pseudo = null) {
  const normalizedProperty = String(property || "").trim();
  if (!normalizedProperty) {
    return "";
  }

  try {
    const view = element.ownerGlobal;
    const computed = view?.getComputedStyle?.(element, pseudo);
    const value =
      computed?.getPropertyValue(normalizedProperty) ||
      computed?.[normalizedProperty];
    if (value) {
      return value;
    }
  } catch (_) {
    // Detached parser documents do not always have a view with layout.
  }

  if (!pseudo && element.style) {
    try {
      const value =
        element.style.getPropertyValue(normalizedProperty) ||
        element.style[normalizedProperty] ||
        "";
      if (value) {
        return value;
      }
    } catch (_) {
      return "";
    }
  }

  return stylesheetPropertyValue(element, normalizedProperty, pseudo);
}

function matchesHtmlFilterCss(element, arg, pseudo = null) {
  const matcher = splitCssMatcherArg(arg);
  if (!matcher) {
    return false;
  }

  return matchesProceduralPattern(
    cssPropertyValue(element, matcher.property, pseudo),
    matcher.pattern
  );
}

function evaluateHtmlFilterXPath(doc, candidates, expression) {
  const xpathResult = doc.defaultView?.XPathResult || globalThis.XPathResult;
  if (!doc.evaluate || !xpathResult || !expression) {
    return [];
  }

  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    try {
      const snapshot = doc.evaluate(
        expression,
        candidate.nodeType === 9 ? doc : candidate,
        null,
        xpathResult.ORDERED_NODE_SNAPSHOT_TYPE,
        null
      );

      for (let i = 0; i < snapshot.snapshotLength; i++) {
        const element = snapshot.snapshotItem(i);
        if (element?.nodeType === 1 && !seen.has(element)) {
          seen.add(element);
          out.push(element);
          if (out.length >= MAX_PROCEDURAL_CANDIDATES) {
            return out;
          }
        }
      }
    } catch (_) {
      return [];
    }
  }

  return out;
}

function evaluateHtmlFilterOperators(doc, operators, documentUrl) {
  if (!Array.isArray(operators) || !operators.length) {
    return [];
  }

  let candidates = [doc];
  for (const operator of operators) {
    const type = String(operator?.type || "");
    const arg =
      typeof operator?.arg === "string"
        ? operator.arg
        : String(operator?.arg ?? "");

    switch (type) {
      case "css-selector":
        candidates = queryHtmlFilterSelector(candidates, arg);
        break;
      case "has-text":
        candidates = filterProceduralCandidates(candidates, element =>
          matchesProceduralPattern(element.textContent || "", arg)
        );
        break;
      case "matches-attr":
        candidates = filterProceduralCandidates(candidates, element =>
          matchesHtmlFilterAttr(element, arg)
        );
        break;
      case "matches-css":
        candidates = filterProceduralCandidates(candidates, element =>
          matchesHtmlFilterCss(element, arg)
        );
        break;
      case "matches-css-before":
        candidates = filterProceduralCandidates(candidates, element =>
          matchesHtmlFilterCss(element, arg, "::before")
        );
        break;
      case "matches-css-after":
        candidates = filterProceduralCandidates(candidates, element =>
          matchesHtmlFilterCss(element, arg, "::after")
        );
        break;
      case "matches-path":
        candidates = matchesHtmlFilterPath(documentUrl, arg) ? candidates : [];
        break;
      case "min-text-length":
        candidates = filterProceduralCandidates(candidates, element => {
          const minLength = Number.parseInt(arg, 10);
          return (
            Number.isFinite(minLength) &&
            (element.textContent || "").length >= minLength
          );
        });
        break;
      case "upward":
        candidates = applyProceduralUpward(candidates, arg);
        break;
      case "xpath":
        candidates = evaluateHtmlFilterXPath(doc, candidates, arg);
        break;
      default:
        return [];
    }

    if (!candidates.length) {
      return [];
    }
  }

  return candidates.filter(element => element?.nodeType === 1);
}

const HTML_PROCEDURAL_PSEUDOS = new Map([
  ["-abp-contains", "has-text"],
  ["contains", "has-text"],
  ["has-text", "has-text"],
  ["matches-attr", "matches-attr"],
  ["matches-css", "matches-css"],
  ["matches-css-after", "matches-css-after"],
  ["matches-css-before", "matches-css-before"],
  ["matches-path", "matches-path"],
  ["min-text-length", "min-text-length"],
  ["upward", "upward"],
  ["xpath", "xpath"],
]);

const HTML_PROCEDURAL_PSEUDO_NAMES = [...HTML_PROCEDURAL_PSEUDOS.keys()].sort(
  (a, b) => b.length - a.length
);

function readHtmlFilterPseudoArg(selector, startIndex) {
  let arg = "";
  let depth = 0;
  let quote = "";
  let escaped = false;

  for (let i = startIndex; i < selector.length; i++) {
    const char = selector[i];

    if (escaped) {
      arg += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      arg += char;
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      }
      arg += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      arg += char;
      continue;
    }

    if (char === "(") {
      depth++;
      arg += char;
      continue;
    }

    if (char === ")") {
      if (!depth) {
        return { arg, nextIndex: i + 1 };
      }
      depth--;
      arg += char;
      continue;
    }

    arg += char;
  }

  return null;
}

function matchHtmlFilterPseudo(selector, index) {
  if (selector[index] !== ":") {
    return null;
  }

  for (const name of HTML_PROCEDURAL_PSEUDO_NAMES) {
    const prefix = `:${name}(`;
    if (!selector.startsWith(prefix, index)) {
      continue;
    }

    const parsed = readHtmlFilterPseudoArg(selector, index + prefix.length);
    if (!parsed) {
      return null;
    }

    return {
      type: HTML_PROCEDURAL_PSEUDOS.get(name),
      arg: parsed.arg,
      nextIndex: parsed.nextIndex,
    };
  }

  return null;
}

function splitHtmlFilterCssSelector(selector) {
  const rawSelector = String(selector || "");
  const operators = [];
  let segmentStart = 0;
  let index = 0;
  let quote = "";
  let escaped = false;
  let parenDepth = 0;
  let bracketDepth = 0;

  while (index < rawSelector.length) {
    const char = rawSelector[index];

    if (escaped) {
      escaped = false;
      index++;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      index++;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = "";
      }
      index++;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      index++;
      continue;
    }

    if (char === "[") {
      bracketDepth++;
      index++;
      continue;
    }

    if (char === "]") {
      bracketDepth = Math.max(0, bracketDepth - 1);
      index++;
      continue;
    }

    if (char === "(") {
      parenDepth++;
      index++;
      continue;
    }

    if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
      index++;
      continue;
    }

    if (!parenDepth && !bracketDepth) {
      const pseudo = matchHtmlFilterPseudo(rawSelector, index);
      if (pseudo) {
        const cssSelector = rawSelector.slice(segmentStart, index).trim();
        if (cssSelector) {
          operators.push({ type: "css-selector", arg: cssSelector });
        }
        operators.push({ type: pseudo.type, arg: pseudo.arg });
        index = pseudo.nextIndex;
        segmentStart = index;
        continue;
      }
    }

    index++;
  }

  if (!operators.length) {
    return [{ type: "css-selector", arg: rawSelector }];
  }

  const trailingSelector = rawSelector.slice(segmentStart).trim();
  if (trailingSelector) {
    operators.push({ type: "css-selector", arg: trailingSelector });
  }

  return operators;
}

function parseHtmlFilterOperators(rawFilter) {
  const filter =
    typeof rawFilter === "string" ? JSON.parse(rawFilter) : rawFilter;
  let operators = [];
  if (Array.isArray(filter)) {
    operators = filter;
  } else if (Array.isArray(filter?.selector)) {
    operators = filter.selector;
  }

  return operators.flatMap(operator => {
    if (operator?.type !== "css-selector") {
      return [operator];
    }
    return splitHtmlFilterCssSelector(operator.arg);
  });
}

function serializeHtmlDocument(doc, mimeType) {
  const root = doc.documentElement;
  if (!root) {
    throw new Error("HTML filter produced a document without a root element");
  }

  if (mimeType === "application/xhtml+xml") {
    return new XMLSerializer().serializeToString(doc);
  }

  const doctype = doc.doctype
    ? `<!DOCTYPE ${doc.doctype.name}${
        doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : ""
      }${doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : ""}>`
    : "";
  return `${doctype}${root.outerHTML}`;
}

function parseFilterableDocument(text, mimeType) {
  const parseType =
    mimeType === "application/xhtml+xml" ? mimeType : "text/html";
  const doc = new DOMParser().parseFromString(text, parseType);
  if (
    mimeType === "application/xhtml+xml" &&
    doc.getElementsByTagName("parsererror").length
  ) {
    throw new Error("Failed to parse XHTML response for HTML filtering");
  }
  return doc;
}

function applyHtmlFilters(text, filters, documentUrl, mimeType) {
  if (!filters.length) {
    return text;
  }

  const doc = parseFilterableDocument(text, mimeType);
  let removed = 0;

  for (const rawFilter of filters) {
    let elements;
    try {
      elements = evaluateHtmlFilterOperators(
        doc,
        parseHtmlFilterOperators(rawFilter),
        documentUrl
      );
    } catch (err) {
      console.warn("[WaterfoxBlocker] Skipping invalid HTML filter:", err);
      continue;
    }

    for (const element of elements) {
      if (element.isConnected) {
        element.remove();
        removed++;
      }
    }
  }

  return removed ? serializeHtmlDocument(doc, mimeType) : text;
}

function sanitizeResponseHeaderNames(headers) {
  return sanitizeStringList(headers, MAX_RESPONSE_HEADER_FILTERS, 128)
    .map(header => header.toLowerCase())
    .filter(header => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(header));
}

/**
 * Stream listener that buffers a response, applies replace and HTML filter
 * directives to the body, and hands the result to the original listener.
 */
class ResponseFilteringListener {
  constructor(
    channel,
    originalListener,
    { documentUrl, htmlFilters, replaceDirectives }
  ) {
    this.channel = channel;
    this.originalListener = originalListener;
    this.documentUrl = documentUrl;
    this.htmlFilters = htmlFilters;
    this.replaceDirectives = replaceDirectives;
    this.binaryInputStream = Cc[
      "@mozilla.org/binaryinputstream;1"
    ].createInstance(Ci.nsIBinaryInputStream);
    this.chunks = [];
    this.totalLength = 0;
    this.sentOffset = 0;
    this.passThrough = false;
  }

  onStartRequest(request) {
    this.removeContentLength();
    this.originalListener.onStartRequest(request);
  }

  onDataAvailable(request, inputStream, _offset, count) {
    this.binaryInputStream.setInputStream(inputStream);
    const bytes = Uint8Array.from(this.binaryInputStream.readByteArray(count));

    if (this.passThrough) {
      this.emitBytes(request, bytes);
      return;
    }

    if (this.totalLength + bytes.length > REPLACE_RESPONSE_MAX_BYTES) {
      this.passThrough = true;
      this.flushBuffered(request);
      this.emitBytes(request, bytes);
      return;
    }

    this.chunks.push(bytes);
    this.totalLength += bytes.length;
  }

  onStopRequest(request, statusCode) {
    if (!this.passThrough) {
      const originalBytes = concatByteChunks(this.chunks, this.totalLength);
      this.chunks = [];

      try {
        const contentType = getResponseContentType(this.channel);
        const mimeType = normalizeMimeType(contentType);
        const declaredContentType =
          getResponseHeader(this.channel, "Content-Type") || contentType;
        const charset = getDeclaredCharset(this.channel, declaredContentType);
        const canApplyReplace =
          this.replaceDirectives.length &&
          originalBytes.length <= REPLACE_MAX_INPUT_BYTES;
        const canApplyHtml =
          this.htmlFilters.length &&
          originalBytes.length <= HTML_FILTER_MAX_BYTES;

        if (!canApplyReplace && !canApplyHtml) {
          this.emitBytes(request, originalBytes);
        } else {
          const originalText = decodeResponseBytes(originalBytes, charset);
          let rewrittenText = originalText;

          if (
            canApplyReplace &&
            originalText.length <= REPLACE_MAX_INPUT_BYTES
          ) {
            rewrittenText = applyReplaceDirectives(
              originalText,
              this.replaceDirectives
            );
          }

          const htmlFilters =
            canApplyHtml && rewrittenText.length <= HTML_FILTER_MAX_BYTES
              ? this.htmlFilters
              : [];
          rewrittenText = applyHtmlFilters(
            rewrittenText,
            htmlFilters,
            this.documentUrl,
            mimeType
          );

          if (rewrittenText !== originalText) {
            this.emitBytes(request, encodeResponseText(rewrittenText, charset));
          } else {
            this.emitBytes(request, originalBytes);
          }
        }
      } catch (err) {
        console.warn("[WaterfoxBlocker] Failed to filter response body:", err);
        this.emitBytes(request, originalBytes);
      }
    }

    this.originalListener.onStopRequest(request, statusCode);
  }

  flushBuffered(request) {
    for (const chunk of this.chunks) {
      this.emitBytes(request, chunk);
    }
    this.chunks = [];
    this.totalLength = 0;
  }

  emitBytes(request, bytes) {
    if (!bytes.length) {
      return;
    }

    const stream = Cc["@mozilla.org/io/string-input-stream;1"].createInstance(
      Ci.nsIStringInputStream
    );
    stream.setByteStringData(bytesToByteString(bytes));
    this.originalListener.onDataAvailable(
      request,
      stream,
      this.sentOffset,
      bytes.length
    );
    this.sentOffset += bytes.length;
  }

  removeContentLength() {
    removeResponseContentLength(this.channel);
  }

  QueryInterface = ChromeUtils.generateQI([
    "nsIRequestObserver",
    "nsIStreamListener",
  ]);
}

/**
 * Loads and refreshes filter lists, publishes the native engine, adapts
 * response filtering, and provides cosmetic resources and per-tab blocked
 * counts for the protections UI.
 */
export const WaterfoxBlockerService = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIObserver",
    "nsIContentClassifierAdBlockingBridge",
  ]),

  _blockedCountByBrowserId: new Map(),
  _blockedStatsByBrowserId: new Map(),
  _globalStats: null,
  _globalStatsFlushTimerId: null,
  _domainExceptionsBySite: null,
  _listUpdatesState: null,
  _listUpdatePromise: null,
  _listUpdateRerunRequested: false,
  _listUpdateForceRequested: false,
  _localRebuildWaiters: 0,
  _siteExceptionsState: null,
  _engine: null,
  _resourcePayload: null,
  _engineInitPromise: null,
  _initGeneration: 0,
  _initRetryTimerId: null,
  _initialized: false,
  _policyObserverRegistered: false,
  _listUpdateObserverRegistered: false,

  _siteExceptions() {
    if (!this._siteExceptionsState) {
      this._siteExceptionsState = new lazy.SiteExceptionsState();
    }
    return this._siteExceptionsState;
  },

  _listUpdates() {
    if (!this._listUpdatesState) {
      this._listUpdatesState = new lazy.ListUpdatesState();
    }
    return this._listUpdatesState;
  },

  _isPrivateExceptionContext(options = {}) {
    if (typeof options === "boolean") {
      return options;
    }
    if (!options || typeof options !== "object") {
      return false;
    }
    return !!options.isPrivate;
  },

  _clearBlockedCounts() {
    if (!this._blockedCountByBrowserId.size) {
      return;
    }

    this._blockedCountByBrowserId.clear();
    this._blockedStatsByBrowserId.clear();
    this._notifyBlockedCountsCleared();
  },

  _clearTopLevelNavigationState() {
    lazy.blockerPolicy.clearNavigationState();
    this._invalidateRequestPolicy();
  },

  _createEngine() {
    return Cc[CONTRACT_ID].createInstance(Ci.nsIWaterfoxBlockerEngine);
  },

  _publishEngine(engine, resourcePayload) {
    this._registerPolicyObserver();
    engine.publish();
    this._engine = engine;
    this._resourcePayload = resourcePayload;
  },

  _clearEngine() {
    this._engine?.unpublish();
    this._engine = null;
    this._resourcePayload = null;
  },

  _syncNativeDomainAllowances() {
    const sites = [];
    const domains = [];
    for (const [site, allowed] of this._domainExceptions()) {
      for (const domain of allowed) {
        sites.push(site);
        domains.push(domain);
      }
    }
    lazy.blockerPolicy.setDomainAllowances(sites, domains);
  },

  onAdBlockingAction(browserId, hostname, requestType, isPrivate, isTopLevel) {
    this.incrementBlockedCount(browserId, {
      hostname,
      requestType,
      isPrivate,
      topLevel: isTopLevel,
    });
  },

  filterAdBlockingResponse(
    subject,
    url,
    requestType,
    resourcesJson,
    replaceJson
  ) {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    const resources = JSON.parse(resourcesJson);
    const htmlFilters = sanitizeStringList(
      resources.html_filters,
      MAX_HTML_FILTERS,
      4096
    );
    const headers = sanitizeResponseHeaderNames(
      resources.response_header_filters
    );
    this._applyResponseHeaderFilters(channel, headers);
    const replaceDirectives = isReplaceEligibleContent(channel, requestType)
      ? sanitizeStringList(
          JSON.parse(replaceJson),
          MAX_REPLACE_DIRECTIVES,
          4096
        )
      : [];
    const eligibleHtmlFilters = isHtmlFilterEligibleContent(
      channel,
      requestType
    )
      ? htmlFilters
      : [];
    this._installResponseFilters(
      channel,
      url,
      eligibleHtmlFilters,
      replaceDirectives
    );
  },

  _registerPolicyObserver() {
    if (!this._policyObserverRegistered) {
      Services.obs.addObserver(this, TOPIC_PERMISSION_CHANGED);
      this._policyObserverRegistered = true;
    }
  },

  _invalidateRequestPolicy() {
    this._engine?.invalidatePolicy?.();
  },

  async _prepareAndPublishEngine(engine, generation) {
    if (!this._isCurrentListUpdate(generation)) {
      return false;
    }
    const resourcePayload = await lazy.Resources.load(engine);
    if (!this._isCurrentListUpdate(generation)) {
      return false;
    }
    this._publishEngine(engine, resourcePayload);
    return true;
  },

  /**
   * Reads the serialised engine cache before the first load request can run.
   * Hash verification is left to async initialisation and periodic updates.
   */
  _tryInitFromCacheSync() {
    try {
      const cacheData = lazy.EngineCache.readSync();
      if (!cacheData?.length) {
        return;
      }

      const engine = this._createEngine();
      engine.initFromCache(cacheData);
      const resourcePayload = lazy.Resources.loadSync(engine);
      this._publishEngine(engine, resourcePayload);
    } catch (_) {
      // Cache missing, corrupt, or incompatible. Fall back to local sources.
    }
  },

  _ensureStartupEngineSync() {
    if (!this.isEnabled() || this._engine) {
      return;
    }
    try {
      const descriptors = lazy.ListCatalog.getListDescriptorsSync();
      if (
        descriptors.every(descriptor => descriptor.customFilters) &&
        !this._hasSelectedRules(
          lazy.ListStore.readStoredListsSync(descriptors).map(record => ({
            ...record,
            text: lazy.ListPreprocessor.preprocessFilterListText(record.text),
          }))
        )
      ) {
        return;
      }
      this._tryInitFromCacheSync();
      if (!this._engine) {
        this._initFromLocalSourcesSync(descriptors);
      }
    } catch (err) {
      console.error(
        "[WaterfoxBlocker] Failed to initialise local baseline:",
        err
      );
    }
  },

  _hasSelectedRules(records) {
    return records.some(record =>
      String(record.text)
        .split(/\r?\n/)
        .some(line => {
          const rule = line.trim();
          return rule && !rule.startsWith("!") && !rule.startsWith("[");
        })
    );
  },

  _initFromLocalSourcesSync(descriptors = null) {
    if (!this.isEnabled()) {
      return;
    }
    try {
      descriptors ??= lazy.ListCatalog.getListDescriptorsSync();
      const generation = this._initGeneration;
      const { complete, listRecords } =
        lazy.ListStore.resolveLocalListRecordsSync(descriptors);
      if (!complete) {
        throw new Error(
          "Bundled filter lists unavailable for synchronous baseline"
        );
      }
      if (!listRecords.length) {
        return;
      }
      const records = lazy.ListStore.withWaterfoxUnbreakRecordSync(
        listRecords
      ).map(record => ({
        ...record,
        text: lazy.ListPreprocessor.preprocessFilterListText(record.text),
      }));
      if (!this._hasSelectedRules(records.slice(0, listRecords.length))) {
        return;
      }
      const candidate = this._createEngineFromListRecords(records);
      if (!candidate) {
        throw new Error("Filter lists contained no valid rules");
      }
      const resources = lazy.Resources.loadSync(candidate);
      if (this._isCurrentListUpdate(generation)) {
        this._publishEngine(candidate, resources);
      }
    } catch (err) {
      console.error(
        "[WaterfoxBlocker] Failed to initialise local baseline:",
        err
      );
    }
  },

  async _getListDescriptors() {
    return lazy.ListCatalog.getListDescriptors();
  },

  async _resolveLocalListRecords(descriptors) {
    return lazy.ListStore.resolveLocalListRecords(descriptors);
  },

  async _preprocessListRecords(listRecords) {
    const records = await lazy.ListStore.withWaterfoxUnbreakRecord(listRecords);
    return records.map(record => ({
      ...record,
      text: lazy.ListPreprocessor.preprocessFilterListText(record.text),
    }));
  },

  _createEngineFromListRecords(listRecords) {
    const rules = [];
    for (const record of listRecords) {
      for (const line of String(record.text).split(/\r?\n/)) {
        const rule = line.trim();
        if (rule && !rule.startsWith("!") && !rule.startsWith("[")) {
          rules.push(rule);
        }
      }
    }

    if (!rules.length) {
      return null;
    }

    const engine = this._createEngine();
    engine.initFromLists(rules);
    return engine;
  },

  /**
   * Builds from stored lists and fills each missing bundled descriptor from the
   * packaged baseline before remote updates run.
   *
   * @param {Array<object>} descriptors
   * @param {number} generation
   */
  async _initFromLocalSourcesAndCache(descriptors, generation) {
    const { complete, listRecords } =
      await this._resolveLocalListRecords(descriptors);
    if (this._initGeneration !== generation) {
      return;
    }

    const missingBundledDescriptors =
      lazy.ListCatalog.getMissingBundledListDescriptors(
        descriptors,
        listRecords
      );
    if (!complete) {
      throw new Error(
        `${missingBundledDescriptors.length} bundled filter list(s) unavailable for baseline`
      );
    }
    if (!listRecords.length) {
      this._clearEngine();
      await lazy.EngineCache.clear();
      return;
    }

    const listRecordsForEngine = await this._preprocessListRecords(listRecords);
    if (this._initGeneration !== generation) {
      return;
    }

    if (
      !this._hasSelectedRules(listRecordsForEngine.slice(0, listRecords.length))
    ) {
      this._clearEngine();
      await lazy.EngineCache.clear();
      return;
    }

    const nextEngine = this._createEngineFromListRecords(listRecordsForEngine);
    if (!nextEngine) {
      throw new Error("Filter lists contained no valid rules");
    }
    if (this._initGeneration !== generation) {
      return;
    }
    if (!(await this._prepareAndPublishEngine(nextEngine, generation))) {
      return;
    }
    await lazy.EngineCache.write(nextEngine, descriptors, listRecordsForEngine);
  },

  /**
   * Tries the cache first, then falls back to initialisation from text
   * sources. Supplementary resources are awaited so scriptlets and redirects
   * are available on first page load.
   */
  async _initializeEngineIfNeeded() {
    if (this._engineInitPromise) {
      return this._engineInitPromise;
    }

    const promise = this._doInitializeEngineIfNeeded().finally(() => {
      if (this._engineInitPromise === promise) {
        this._engineInitPromise = null;
      }
    });
    this._engineInitPromise = promise;
    return promise;
  },

  /**
   * Resolves once an in-flight engine initialisation has settled.
   */
  async whenEngineReady() {
    while (this._engineInitPromise) {
      const pending = this._engineInitPromise;
      try {
        await pending;
      } catch (_) {
        // Initialisation failures are handled by the init path itself.
      }
      if (this._engineInitPromise === pending) {
        return;
      }
    }
  },

  async _loadResourcesAndBumpGeneration() {
    const engine = this._engine;
    const generation = this._initGeneration;
    if (!engine) {
      return;
    }

    const resourcePayload = await lazy.Resources.read();
    if (
      !this._isCurrentListUpdate(generation) ||
      this._engine !== engine ||
      this._resourcePayload === resourcePayload
    ) {
      return;
    }
    const candidate = this._createEngine();
    candidate.initFromCache(engine.serialize());
    candidate.useResources(resourcePayload);
    this._publishEngine(candidate, resourcePayload);
  },

  async _doInitializeEngineIfNeeded() {
    // Capture generation so we can detect if the blocker was disabled (or
    // re-initialised) while we were awaiting async work.
    const generation = this._initGeneration;
    const verifyExistingEngine = !!this._engine;
    const descriptors = await this._getListDescriptors();
    if (this._initGeneration !== generation) {
      return;
    }
    if (!descriptors.length) {
      this._clearEngine();
      return;
    }

    if (verifyExistingEngine) {
      // Engine may already be loaded from the synchronous cache path. Verify
      // it still matches the current list set before trusting it.
      const storedLists = await this._readStoredLists(descriptors);
      const storedListsForEngine =
        await this._preprocessListRecords(storedLists);
      const cacheMatchesCurrentLists =
        this._hasSelectedRules(
          storedListsForEngine.slice(0, storedLists.length)
        ) &&
        (await lazy.EngineCache.matchesCurrentLists(
          descriptors,
          storedListsForEngine
        ));
      if (!cacheMatchesCurrentLists) {
        await this._initFromLocalSourcesAndCache(descriptors, generation);
      }

      return;
    }

    let loadedFromCache = false;
    try {
      loadedFromCache = await this._tryInitFromCache(descriptors, generation);
    } catch (e) {
      // File not found is expected on first run.
      if (e.result !== Cr.NS_ERROR_FILE_NOT_FOUND) {
        console.error("[WaterfoxBlocker] Unexpected cache error:", e);
      }
    }

    if (this._initGeneration !== generation) {
      return;
    }

    if (!loadedFromCache) {
      await this._initFromLocalSourcesAndCache(descriptors, generation);
    }
  },

  _notifyBlockedCountsCleared() {
    try {
      Services.obs.notifyObservers(null, TOPIC_BLOCKED_COUNTS_CLEARED);
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to notify cleared counts:", err);
    }
  },

  _notifyBlockedCountUpdated(browserId, blockedCount) {
    try {
      Services.obs.notifyObservers(
        {
          wrappedJSObject: {
            blockedCount,
            browserId,
          },
        },
        TOPIC_BLOCKED_COUNT_UPDATED
      );
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to notify blocked count:", err);
    }
  },

  _getURIHost(uri) {
    if (!uri) {
      return "";
    }

    try {
      return uri.host || "";
    } catch (_) {
      // nsIURI.host throws for URI types without an authority component.
      return "";
    }
  },

  _getPrincipalHost(principal) {
    return this._getURIHost(principal?.URI);
  },

  _getBrowsingContextDocumentHost(browsingContext) {
    try {
      const principalHost = this._getPrincipalHost(
        browsingContext?.currentWindowGlobal?.documentPrincipal
      );
      if (principalHost) {
        return principalHost;
      }

      const documentHost = this._getURIHost(
        browsingContext?.currentWindowGlobal?.documentURI
      );
      if (documentHost) {
        return documentHost;
      }

      return this._getURIHost(browsingContext?.embedderElement?.currentURI);
    } catch (_) {
      // BrowsingContext/WindowGlobal can disappear during navigation teardown.
      return "";
    }
  },

  _normalizeHostname(hostname) {
    return String(hostname || "")
      .replace(/\.$/, "")
      .toLowerCase();
  },

  _rememberTopLevelHost(browserId, hostname) {
    lazy.blockerPolicy.rememberTopHost(
      Number(browserId || 0),
      String(hostname || "")
    );
  },

  _rememberBlockedTopLevelDocument(browserId, hostname, url) {
    lazy.blockerPolicy.rememberBlockedDocument(
      Number(browserId || 0),
      String(hostname || ""),
      String(url || "")
    );
  },

  /**
   * Consumes the recorded blocked top-level document for this browser, including
   * on host or URL mismatch. Callers must not treat this as idempotent.
   *
   * @param {number} browserId
   * @param {string} hostname
   * @param {string} [url]
   */
  wasHostBlockedFor(browserId, hostname, url = "") {
    return lazy.blockerPolicy.consumeBlockedDocument(
      Number(browserId || 0),
      String(hostname || ""),
      String(url || "")
    );
  },

  _applyResponseHeaderFilters(channel, responseHeaderFilters) {
    for (const header of responseHeaderFilters) {
      try {
        channel.setResponseHeader(header, "", false);
      } catch (_) {
        // Some channels do not allow this response header to be removed.
      }
    }
  },

  _installResponseFilters(
    channel,
    url,
    eligibleHtmlFilters,
    replaceDirectives
  ) {
    if (!replaceDirectives.length && !eligibleHtmlFilters.length) {
      return;
    }

    try {
      removeResponseContentLength(channel);
      const traceableChannel = channel.QueryInterface(Ci.nsITraceableChannel);
      const listener = new ResponseFilteringListener(channel, null, {
        documentUrl: url,
        htmlFilters: eligibleHtmlFilters,
        replaceDirectives,
      });
      listener.originalListener = traceableChannel.setNewListener(
        listener,
        true
      );
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to install response filter:", err);
    }
  },

  _rebuildEngineFromCurrentSources() {
    const promise = this._doRebuildEngineFromCurrentSources().finally(() => {
      if (this._engineInitPromise === promise) {
        this._engineInitPromise = null;
      }
    });
    this._engineInitPromise = promise;
    return promise;
  },

  async _doRebuildEngineFromCurrentSources() {
    const generation = ++this._initGeneration;
    const pendingUpdate = this._listUpdatePromise;
    if (pendingUpdate) {
      this._localRebuildWaiters++;
      try {
        await pendingUpdate;
      } catch (_) {
      } finally {
        this._localRebuildWaiters--;
      }
    }
    if (this._initGeneration !== generation) {
      return;
    }

    const descriptors = await this._getListDescriptors();
    if (this._initGeneration !== generation) {
      return;
    }

    await this._initFromLocalSourcesAndCache(descriptors, generation);
  },

  async _readJSON(path, fallbackValue) {
    return lazy.ListStore.readJSON(path, fallbackValue);
  },

  async _readStoredLists(descriptors) {
    return lazy.ListStore.readStoredLists(descriptors);
  },

  async refreshListsAndEngine() {
    await this._rebuildEngineFromCurrentSources();
    await this._updateListsIfNeeded(true);
  },

  /**
   * Wires up triggers that refresh lists. The RemoteSettings poll observer
   * (`remote-settings:changes-poll-end`) is opportunistic, so an hourly fallback
   * timer also runs regardless of RemoteSettings state.
   */
  _startListUpdateTriggers() {
    this._stopListUpdateTriggers();
    Services.obs.addObserver(this, REMOTE_SETTINGS_POLL_END_TOPIC);
    this._listUpdateObserverRegistered = true;

    this._fallbackUpdateIntervalId = lazy.setInterval(() => {
      this._updateListsIfNeeded().catch(err => {
        console.warn("[WaterfoxBlocker] Fallback list update failed:", err);
      });
    }, LIST_UPDATE_FALLBACK_INTERVAL_MS);
  },

  _stopListUpdateTriggers() {
    if (this._listUpdateObserverRegistered) {
      try {
        Services.obs.removeObserver(this, REMOTE_SETTINGS_POLL_END_TOPIC);
      } catch (err) {
        console.warn(
          "[WaterfoxBlocker] Failed to remove RS poll observer:",
          err
        );
      }
      this._listUpdateObserverRegistered = false;
    }
    if (this._fallbackUpdateIntervalId) {
      lazy.clearInterval(this._fallbackUpdateIntervalId);
      this._fallbackUpdateIntervalId = null;
    }
  },

  _trimBlockedCountMapIfNeeded() {
    if (this._blockedCountByBrowserId.size <= BLOCKED_COUNT_MAP_MAX_ENTRIES) {
      return;
    }

    let removeCount =
      this._blockedCountByBrowserId.size - BLOCKED_COUNT_MAP_TRIM_TO_ENTRIES;
    for (const browserId of this._blockedCountByBrowserId.keys()) {
      this._blockedCountByBrowserId.delete(browserId);
      this._blockedStatsByBrowserId.delete(browserId);
      removeCount--;
      if (removeCount <= 0) {
        break;
      }
    }
  },

  async _tryInitFromCache(descriptors, generation) {
    const storedLists = await this._readStoredLists(descriptors);
    const storedListsForEngine = await this._preprocessListRecords(storedLists);
    const cacheMatchesCurrentLists =
      this._hasSelectedRules(
        storedListsForEngine.slice(0, storedLists.length)
      ) &&
      (await lazy.EngineCache.matchesCurrentLists(
        descriptors,
        storedListsForEngine
      ));
    if (!cacheMatchesCurrentLists) {
      return false;
    }

    const cacheData = await lazy.EngineCache.read();
    const candidate = this._createEngine();
    try {
      candidate.initFromCache(cacheData);
    } catch (_) {
      // Cache data can be stale or incompatible after engine updates.
      return false;
    }
    if (this._initGeneration !== generation) {
      return false;
    }
    return this._prepareAndPublishEngine(candidate, generation);
  },

  _isCurrentListUpdate(generation) {
    return this.isEnabled() && this._initGeneration === generation;
  },

  async _refreshEngineAfterListUpdate(anyUpdated, descriptors, generation) {
    if (!this._isCurrentListUpdate(generation)) {
      return false;
    }

    if (anyUpdated) {
      const { complete, listRecords } =
        await this._resolveLocalListRecords(descriptors);
      if (!this._isCurrentListUpdate(generation)) {
        return false;
      }
      if (!complete) {
        const missingCount = lazy.ListCatalog.getMissingBundledListDescriptors(
          descriptors,
          listRecords
        ).length;
        console.warn(
          `[WaterfoxBlocker] ${missingCount} bundled filter list(s) unavailable after update; keeping the current engine`
        );
        this._scheduleInitRetry();
        return true;
      }
      if (!listRecords.length) {
        this._clearEngine();
        await lazy.EngineCache.clear();
        return true;
      }

      const listRecordsForEngine =
        await this._preprocessListRecords(listRecords);
      if (!this._isCurrentListUpdate(generation)) {
        return false;
      }

      const nextEngine =
        this._createEngineFromListRecords(listRecordsForEngine);
      if (!nextEngine) {
        return true;
      }
      if (!this._isCurrentListUpdate(generation)) {
        return false;
      }
      if (!(await this._prepareAndPublishEngine(nextEngine, generation))) {
        return false;
      }
      await lazy.EngineCache.write(
        nextEngine,
        descriptors,
        listRecordsForEngine
      );
      return true;
    }

    if (this._engine) {
      await this._loadResourcesAndBumpGeneration();
    }
    return this._isCurrentListUpdate(generation);
  },

  async _runListUpdatePass(force = false) {
    if (this._localRebuildWaiters) {
      this._listUpdateRerunRequested = false;
      return;
    }
    const initPromise = this._engineInitPromise;
    if (initPromise) {
      try {
        await initPromise;
      } catch (_) {}
    }

    if (!this._initialized || !this.isEnabled()) {
      return;
    }

    const generation = this._initGeneration;
    const result = await this._listUpdates().updateIfNeeded(force);
    if (!result) {
      return;
    }

    if (!this._isCurrentListUpdate(generation)) {
      this._listUpdateRerunRequested =
        this._localRebuildWaiters === 0 &&
        this._initialized &&
        this.isEnabled();
      return;
    }

    try {
      await lazy.RemoteResources.refresh();
    } catch (err) {
      console.warn("[WaterfoxBlocker] Remote resource refresh failed:", err);
    }

    if (!this._isCurrentListUpdate(generation)) {
      this._listUpdateRerunRequested =
        this._localRebuildWaiters === 0 &&
        this._initialized &&
        this.isEnabled();
      return;
    }

    const applied = await this._refreshEngineAfterListUpdate(
      result.anyUpdated,
      result.descriptors,
      generation
    );
    if (!applied) {
      this._listUpdateRerunRequested =
        this._localRebuildWaiters === 0 &&
        this._initialized &&
        this.isEnabled();
    }
  },

  /**
   * Refreshes lists and remote resources, then rebuilds the engine when content
   * changed. Calls arriving during an update request one rerun with the latest
   * descriptor set.
   *
   * @param {boolean} force Whether to bypass list expiry.
   */
  async _updateListsIfNeeded(force = false) {
    this._listUpdateForceRequested ||= force;
    if (this._listUpdatePromise) {
      this._listUpdateRerunRequested = true;
      return this._listUpdatePromise;
    }

    const promise = (async () => {
      do {
        this._listUpdateRerunRequested = false;
        const forceUpdate = this._listUpdateForceRequested;
        this._listUpdateForceRequested = false;
        await this._runListUpdatePass(forceUpdate);
      } while (
        this._listUpdateRerunRequested &&
        this._initialized &&
        this.isEnabled()
      );
    })().finally(() => {
      if (this._listUpdatePromise === promise) {
        this._listUpdatePromise = null;
      }
    });
    this._listUpdatePromise = promise;
    return promise;
  },

  /**
   * @param {string} domain
   */
  addSiteException(domain) {
    this._siteExceptions().addPermanentSiteException(domain);
  },

  /**
   * Allows the domain for the rest of the normal browser session or the
   * current private session.
   *
   * @param {string} domain
   * @param {{isPrivate?: boolean}|boolean} [options]
   */
  allowSiteForSession(domain, options = {}) {
    this._siteExceptions().allowSiteForSession(domain, options);
  },

  getBlockedCount(browserId) {
    return this._blockedCountByBrowserId.get(browserId) || 0;
  },

  /**
   * @param {number} newBrowserId
   * @param {string} sourceHost
   * @param {{isPrivate?: boolean}} [options]
   */
  recordNewTabSourceHost(newBrowserId, sourceHost, options = {}) {
    if (this.shouldBypassBlocking(sourceHost, options)) {
      this._rememberTopLevelHost(newBrowserId, sourceHost);
    }
  },

  /**
   * @param {number} browserId
   * @returns {number}
   */
  resetBlockedCount(browserId) {
    const id = Number(browserId || 0);
    if (!id) {
      return 0;
    }

    this._blockedCountByBrowserId.set(id, 0);
    this._blockedStatsByBrowserId.delete(id);
    this._notifyBlockedCountUpdated(id, 0);
    return 0;
  },

  shouldBypassCosmeticFiltering(url, browsingContext = null) {
    if (!this.isEnabled()) {
      return true;
    }

    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch (err) {
      console.error("[WaterfoxBlocker] getCosmeticResources failed:", err);
      return true;
    }

    const options = {
      isPrivate: isPrivateBrowsingContext(browsingContext),
    };
    return (
      !hostname ||
      [
        hostname,
        this._getBrowsingContextDocumentHost(browsingContext),
        this._getBrowsingContextDocumentHost(browsingContext?.top),
      ].some(host => this.shouldBypassBlocking(host, options))
    );
  },

  /**
   * @param {string} url
   * @param {BrowsingContext|null} [browsingContext=null]
   * @param {nsIWaterfoxBlockerEngine|null} [engine=this._engine]
   * @returns {object|null} Parsed cosmetic resource payload from the native engine.
   */
  getCosmeticResources(url, browsingContext = null, engine = this._engine) {
    if (this.shouldBypassCosmeticFiltering(url, browsingContext)) {
      return null;
    }

    if (!engine) {
      return {};
    }

    try {
      const resources = JSON.parse(engine.getCosmeticResources(url));
      return resources && typeof resources === "object" ? resources : {};
    } catch (err) {
      console.error("[WaterfoxBlocker] getCosmeticResources failed:", err);
      return {};
    }
  },

  /**
   * Loads the filter list catalog and annotates entries with their effective
   * enabled state.
   *
   * @returns {Promise<object[]>}
   */
  async getFilterListCatalog() {
    return lazy.ListCatalog.getFilterListCatalog();
  },

  /**
   * @returns {Promise<Array<{url: string, filename: string, lastAttempt: number, lastError: string, lastFetched: number, etag: string, lastModified: string}>>}
   */
  async getFilterListMetadata() {
    const meta = await this._readJSON(lazy.ListStore.listsMetadataPath(), {
      lists: [],
    });
    return meta?.lists || [];
  },

  /**
   * Reads custom filters from the profile directory ("My filters").
   *
   * @returns {Promise<string>}
   */
  async getCustomFiltersText() {
    return lazy.ListStore.getCustomFiltersText();
  },

  /**
   * Replaces custom filters in the profile and rebuilds the engine when
   * active.
   *
   * @param {string} text
   */
  async setCustomFiltersText(text) {
    const normalized = lazy.ListStore.normalizeCustomFiltersText(text);
    const path = lazy.ListStore.customFiltersPath();
    const hadPreviousFile = await IOUtils.exists(path);
    let previousText = "";

    if (hadPreviousFile) {
      try {
        previousText = await IOUtils.readUTF8(path);
      } catch (err) {
        console.warn(
          "[WaterfoxBlocker] Failed reading previous custom filters for rollback:",
          err
        );
      }
    }

    await lazy.ListStore.setCustomFiltersText(normalized, {
      alreadyNormalized: true,
    });

    if (!this.isEnabled()) {
      return;
    }

    try {
      await this._rebuildEngineFromCurrentSources();
    } catch (err) {
      // Roll back the file change before rethrowing the rebuild failure.
      try {
        if (hadPreviousFile) {
          await IOUtils.writeUTF8(path, previousText, {
            tmpPath: `${path}.tmp`,
          });
        } else {
          await IOUtils.remove(path, { ignoreAbsent: true });
        }

        await this._rebuildEngineFromCurrentSources();
      } catch (rollbackErr) {
        console.error(
          "[WaterfoxBlocker] Failed rolling back custom filters after rebuild failure:",
          rollbackErr
        );
      }

      throw err;
    }
  },

  /**
   * @param {string[]} [classes=[]]
   * @param {string[]} [ids=[]]
   * @param {string[]} [exceptions=[]]
   * @param {nsIWaterfoxBlockerEngine|null} [engine=this._engine]
   * @returns {string[]}
   */
  getHiddenClassIdSelectors(
    classes = [],
    ids = [],
    exceptions = [],
    engine = this._engine
  ) {
    if (!this.isEnabled() || !this._engine || !engine) {
      return [];
    }

    try {
      const safeClasses = sanitizeStringList(classes, 5000);
      const safeIds = sanitizeStringList(ids, 5000);
      const safeExceptions = sanitizeStringList(exceptions, 500);

      if (!safeClasses.length && !safeIds.length) {
        return [];
      }

      const classesJson = toAsciiSafeJson(safeClasses);
      const idsJson = toAsciiSafeJson(safeIds);
      const exceptionsJson = toAsciiSafeJson(safeExceptions);

      const selectors = JSON.parse(
        engine.getHiddenClassIdSelectors(classesJson, idsJson, exceptionsJson)
      );

      return selectors.filter(s => s);
    } catch (err) {
      console.error("[WaterfoxBlocker] getHiddenClassIdSelectors failed:", err);
      return [];
    }
  },

  /**
   * @param {number} browserId
   * @param {{hostname?: string, requestType?: string, topLevel?: boolean,
   *          isPrivate?: boolean}|null} [details]
   *   Request details used to bucket the block for the panel UI. Counting
   *   still works when omitted; the block is then attributed to "ads".
   * @returns {number}
   */
  incrementBlockedCount(browserId, details = null) {
    const current = this.getBlockedCount(browserId);
    const next = current + 1;
    this._blockedCountByBrowserId.set(browserId, next);
    this._recordBlockedRequestStats(browserId, details);
    this._trimBlockedCountMapIfNeeded();
    this._notifyBlockedCountUpdated(browserId, next);
    return next;
  },

  _trackerDomainCache: new Map(),

  /**
   * Classifies the domain against the url-classifier tracking tables (the
   * ETP tracking-annotation data). The matched table names distinguish ad
   * networks from other trackers. Results are cached; missing tables or
   * classifier errors resolve to null.
   *
   * @param {string} domain
   * @returns {Promise<"ads"|"trackers"|null>}
   */
  _classifyDomainViaTrackingTables(domain) {
    const cached = this._trackerDomainCache.get(domain);
    if (cached !== undefined) {
      // Either a settled category (or null) or an in-flight promise.
      return Promise.resolve(cached);
    }

    const promise = new Promise(resolve => {
      const feature = lazy.trackingClassifierFeature;
      if (!lazy.urlClassifier || !feature) {
        resolve(null);
        return;
      }

      try {
        lazy.urlClassifier.asyncClassifyLocalWithFeatures(
          Services.io.newURI(`https://${domain}/`),
          [feature],
          Ci.nsIUrlClassifierFeature.blocklist,
          results => {
            const tables = results.map(r => r.list).join(",");
            if (!tables) {
              resolve(null);
            } else if (tables.includes("ads-track")) {
              resolve("ads");
            } else {
              resolve("trackers");
            }
          }
        );
      } catch (_) {
        resolve(null);
      }
    }).then(category => {
      this._trackerDomainCache.set(domain, category);
      return category;
    });

    if (this._trackerDomainCache.size >= TRACKER_DOMAIN_CACHE_MAX) {
      this._trackerDomainCache.clear();
    }
    this._trackerDomainCache.set(domain, promise);
    return promise;
  },

  async _resolveBlockedCategory(details, hostname) {
    if (details?.topLevel) {
      return "popups";
    }

    if (TRACKER_REQUEST_TYPES.has(String(details?.requestType || ""))) {
      return "trackers";
    }

    if (hostname) {
      const category = await this._classifyDomainViaTrackingTables(hostname);
      if (category) {
        return category;
      }
    }

    return "ads";
  },

  _baseDomain(hostname) {
    const host = this._normalizeHostname(hostname);
    if (!host) {
      return "";
    }

    try {
      return Services.eTLD.getBaseDomainFromHost(host);
    } catch (_) {
      // IP literals and hosts without a public suffix are used as entered.
      return host;
    }
  },

  _recordBlockedRequestStats(browserId, details) {
    const id = Number(browserId || 0);
    if (!id) {
      return;
    }

    let stats = this._blockedStatsByBrowserId.get(id);
    if (!stats) {
      stats = {
        counts: { ads: 0, trackers: 0, popups: 0 },
        domains: new Map(),
        lastBlockedAt: 0,
      };
      this._blockedStatsByBrowserId.set(id, stats);
    }

    stats.lastBlockedAt = Date.now();

    if (!details?.isPrivate) {
      this._globalStatsState().totalBlocked++;
      this._scheduleGlobalStatsFlush();
    }

    const domain = this._baseDomain(details?.hostname);
    // Classify the full hostname: subdomains can sit in a different tracking
    // category than their base domain (e.g. adservice.google.com).
    this._resolveBlockedCategory(
      details,
      this._normalizeHostname(details?.hostname)
    )
      .then(category => {
        // A navigation may have replaced or cleared the record meanwhile.
        if (this._blockedStatsByBrowserId.get(id) !== stats) {
          return;
        }

        stats.counts[category]++;

        if (domain) {
          const entry = stats.domains.get(domain);
          if (entry) {
            entry.count++;
          } else if (stats.domains.size < BLOCKED_DOMAINS_PER_TAB_MAX) {
            stats.domains.set(domain, { category, count: 1 });
          }
        }

        this._notifyBlockedCountUpdated(id, this.getBlockedCount(id));
      })
      .catch(() => {});
  },

  /**
   * Blocked counts and domains for one tab, read by the toolbar panel.
   *
   * @param {number} browserId
   * @returns {{total: number, counts: {ads: number, trackers: number,
   *            popups: number}, entries: Array<{domain: string,
   *            category: string, count: number}>, lastBlockedAt: number}}
   */
  getBlockedStats(browserId) {
    const stats = this._blockedStatsByBrowserId.get(Number(browserId || 0));
    if (!stats) {
      return {
        total: 0,
        counts: { ads: 0, trackers: 0, popups: 0 },
        entries: [],
        lastBlockedAt: 0,
      };
    }

    const entries = Array.from(stats.domains, ([domain, entry]) => ({
      domain,
      category: entry.category,
      count: entry.count,
    })).sort((a, b) => b.count - a.count);

    return {
      total: this.getBlockedCount(Number(browserId || 0)),
      counts: { ...stats.counts },
      entries,
      lastBlockedAt: stats.lastBlockedAt,
    };
  },

  _globalStatsState() {
    if (!this._globalStats) {
      let parsed = null;
      try {
        parsed = JSON.parse(
          Services.prefs.getStringPref(PREF_GLOBAL_STATS, "")
        );
      } catch (_) {
        // Missing or corrupt pref starts a fresh stats record.
      }

      this._globalStats = {
        totalBlocked: Math.max(0, Number(parsed?.totalBlocked) || 0),
        since: Number(parsed?.since) || Date.now(),
      };
    }
    return this._globalStats;
  },

  /**
   * @returns {{totalBlocked: number, bytesSaved: number, since: number}}
   */
  getGlobalStats() {
    const stats = this._globalStatsState();
    return {
      totalBlocked: stats.totalBlocked,
      bytesSaved: stats.totalBlocked * ESTIMATED_BYTES_PER_BLOCKED_REQUEST,
      since: stats.since,
    };
  },

  _scheduleGlobalStatsFlush() {
    if (this._globalStatsFlushTimerId) {
      return;
    }

    this._globalStatsFlushTimerId = lazy.setTimeout(() => {
      this._globalStatsFlushTimerId = null;
      this._flushGlobalStats();
    }, GLOBAL_STATS_FLUSH_DELAY_MS);
  },

  _flushGlobalStats() {
    if (!this._globalStats) {
      return;
    }

    try {
      Services.prefs.setStringPref(
        PREF_GLOBAL_STATS,
        JSON.stringify(this._globalStats)
      );
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to persist global stats:", err);
    }
  },

  _domainExceptions() {
    if (!this._domainExceptionsBySite) {
      const map = new Map();
      try {
        const parsed = JSON.parse(
          Services.prefs.getStringPref(PREF_DOMAIN_EXCEPTIONS, "")
        );
        for (const [site, domains] of Object.entries(parsed || {})) {
          if (Array.isArray(domains) && domains.length) {
            map.set(site, new Set(domains.map(d => String(d)).filter(Boolean)));
          }
        }
      } catch (_) {
        // Missing or corrupt pref starts with no domain exceptions.
      }
      this._domainExceptionsBySite = map;
    }
    return this._domainExceptionsBySite;
  },

  _saveDomainExceptions() {
    const serialized = {};
    for (const [site, domains] of this._domainExceptions()) {
      if (domains.size) {
        serialized[site] = Array.from(domains);
      }
    }

    try {
      Services.prefs.setStringPref(
        PREF_DOMAIN_EXCEPTIONS,
        JSON.stringify(serialized)
      );
    } catch (err) {
      console.warn(
        "[WaterfoxBlocker] Failed to persist domain exceptions:",
        err
      );
    }
  },

  /**
   * Allows a single blocked domain on one site, e.g. the panel's per-row
   * "Allow" action. Both hosts collapse to their base domain.
   *
   * @param {string} siteHost
   * @param {string} domain
   */
  addDomainExceptionForSite(siteHost, domain) {
    const site = this._baseDomain(siteHost);
    const allowed = this._baseDomain(domain);
    if (!site || !allowed) {
      return;
    }

    const exceptions = this._domainExceptions();
    let domains = exceptions.get(site);
    if (!domains) {
      if (exceptions.size >= DOMAIN_EXCEPTIONS_SITES_MAX) {
        return;
      }
      domains = new Set();
      exceptions.set(site, domains);
    }

    if (domains.size >= DOMAIN_EXCEPTIONS_PER_SITE_MAX) {
      return;
    }

    domains.add(allowed);
    this._saveDomainExceptions();
  },

  /**
   * @param {string} siteHost
   * @param {string} domain
   */
  removeDomainExceptionForSite(siteHost, domain) {
    const site = this._baseDomain(siteHost);
    const allowed = this._baseDomain(domain);
    const exceptions = this._domainExceptions();
    const domains = exceptions.get(site);
    if (!domains?.delete(allowed)) {
      return;
    }

    if (!domains.size) {
      exceptions.delete(site);
    }
    this._saveDomainExceptions();
  },

  /**
   * @param {string} siteHost
   * @returns {string[]}
   */
  getDomainExceptionsForSite(siteHost) {
    const domains = this._domainExceptions().get(this._baseDomain(siteHost));
    return domains ? Array.from(domains) : [];
  },

  /**
   * @param {string} siteHost
   * @param {string} domain
   * @returns {boolean}
   */
  isDomainExceptedOnSite(siteHost, domain) {
    const domains = this._domainExceptions().get(this._baseDomain(siteHost));
    return !!domains?.has(this._baseDomain(domain));
  },

  /**
   * @returns {number} Count of sites with a permanent blocker exception.
   */
  getSiteExceptionCount() {
    return this._siteExceptions().countPermanentSiteExceptions();
  },

  _clearInitRetryTimer() {
    if (!this._initRetryTimerId) {
      return;
    }

    lazy.clearTimeout(this._initRetryTimerId);
    this._initRetryTimerId = null;
  },

  _scheduleInitRetry() {
    if (this._initRetryTimerId || !this._initialized || !this.isEnabled()) {
      return;
    }

    this._initRetryTimerId = lazy.setTimeout(() => {
      this._initRetryTimerId = null;
      if (!this._initialized || !this.isEnabled()) {
        return;
      }
      this._initializeEngineWithRetry();
    }, INIT_RETRY_DELAY_MS);
  },

  async _initializeEngineWithRetry() {
    try {
      this._clearInitRetryTimer();
      await this._initializeEngineIfNeeded();
      if (this.isEnabled()) {
        this._startListUpdateTriggers();
        this._updateListsIfNeeded().catch(err => {
          console.warn("[WaterfoxBlocker] Initial list update failed:", err);
        });
      }
    } catch (err) {
      console.error("[WaterfoxBlocker] Failed to initialise engine:", err);
      this._scheduleInitRetry();
    }
  },

  /**
   * Migrates site exceptions from the legacy JSON pref into PermissionManager
   * once. Entries collapse to their base domain so storage mirrors ETP's
   * allow list semantics; lossy entries are warned and skipped so a single
   * bad value does not block the rest.
   */
  _migrateSiteExceptions() {
    if (Services.prefs.getBoolPref(PREF_SITE_EXCEPTIONS_MIGRATED, false)) {
      return;
    }

    const raw = Services.prefs.getStringPref(PREF_LEGACY_SITE_EXCEPTIONS, "");
    let entries = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          entries = parsed;
        }
      } catch (err) {
        console.warn(
          "[WaterfoxBlocker] Failed to parse legacy site exceptions pref:",
          err
        );
      }
    }

    const state = this._siteExceptions();
    for (const entry of entries) {
      const host = String(entry || "")
        .trim()
        .toLowerCase();
      if (!host) {
        continue;
      }

      let domain = host;
      try {
        domain = Services.eTLD.getBaseDomainFromHost(host);
      } catch (_) {
        // IP literals, hosts like localhost, and private suffixes have no base
        // domain in the public suffix list. Store as entered.
      }

      try {
        state.addPermanentSiteException(domain);
      } catch (err) {
        console.warn(
          `[WaterfoxBlocker] Failed to migrate site exception "${entry}":`,
          err
        );
      }
    }

    Services.prefs.clearUserPref(PREF_LEGACY_SITE_EXCEPTIONS);
    Services.prefs.setBoolPref(PREF_SITE_EXCEPTIONS_MIGRATED, true);
  },

  async init() {
    if (this._initialized) {
      return;
    }

    Services.prefs.addObserver(PREF_BRANCH, this);
    this._registerPolicyObserver();
    lazy.blockerPolicy.setNetworkBridge(this);
    this._syncNativeDomainAllowances();
    this._initialized = true;

    this._migrateSiteExceptions();

    if (!this.isEnabled()) {
      return;
    }

    // Publish a resource-complete local engine before the first async yield.
    this._ensureStartupEngineSync();
    lazy.EngineCache.cleanupStale().catch(err => {
      console.warn("[WaterfoxBlocker] Cache cleanup failed:", err);
    });

    await this._initializeEngineWithRetry();
  },

  isEnabled() {
    return Services.prefs.getBoolPref(PREF_ENABLED, true);
  },

  /**
   * Matching includes exact host and subdomain suffix matches for the stored
   * exception value: `example.com` matches `www.example.com`, while
   * `www.example.com` does not match `example.com`.
   *
   * @param {string} domain
   * @param {{isPrivate?: boolean}|boolean} [options]
   * @returns {boolean}
   */
  isSiteExcepted(domain, options = {}) {
    return this._siteExceptions().isSiteExcepted(domain, options);
  },

  /**
   * @param {nsISupports|null} subject
   * @param {string} topic
   * @param {string} data
   */
  observe(subject, topic, data) {
    if (topic === TOPIC_PERMISSION_CHANGED) {
      if (!subject || data === "cleared" || data === "batch-deleted") {
        this._invalidateRequestPolicy();
      } else {
        const type = subject.QueryInterface(Ci.nsIPermission).type;
        if (type === "waterfox-blocker" || type === "waterfox-blocker-pb") {
          this._invalidateRequestPolicy();
        }
      }
      return;
    }
    if (topic === REMOTE_SETTINGS_POLL_END_TOPIC) {
      this._updateListsIfNeeded().catch(err => {
        console.warn(
          "[WaterfoxBlocker] List update on RS poll-end failed:",
          err
        );
      });
      return;
    }

    if (topic !== TOPIC_PREF_CHANGED) {
      return;
    }

    if (
      [
        PREF_ENABLED,
        PREF_ALLOW_SEARCH_PARTNER_ADS,
        PREF_DOMAIN_EXCEPTIONS,
        "waterfox.blocker.coexist",
      ].includes(data)
    ) {
      this._invalidateRequestPolicy();
    }
    switch (data) {
      case PREF_ENABLED:
        if (this.isEnabled()) {
          this._ensureStartupEngineSync();
          this._initializeEngineWithRetry();
        } else {
          this._clearInitRetryTimer();
          this._stopListUpdateTriggers();
          this._clearBlockedCounts();
          this._clearTopLevelNavigationState();
          this._listUpdatesState = null;
          this._listUpdateRerunRequested = false;
          this._listUpdateForceRequested = false;
          this._clearEngine();
          this._engineInitPromise = null;
          this._initGeneration++;
        }
        break;

      case PREF_FILTER_LIST_URLS:
        if (this.isEnabled()) {
          this.refreshListsAndEngine().catch(err => {
            console.error(
              "[WaterfoxBlocker] Failed to refresh lists after pref change:",
              err
            );
          });
        }
        break;

      case PREF_ENABLED_LISTS:
        if (this.isEnabled()) {
          this.refreshListsAndEngine().catch(err => {
            console.error(
              "[WaterfoxBlocker] Failed to refresh lists after list toggle:",
              err
            );
          });
        }
        break;

      case PREF_DOMAIN_EXCEPTIONS:
        this._domainExceptionsBySite = null;
        this._syncNativeDomainAllowances();
        break;

      case PREF_REMOTE_RESOURCES_ENABLED:
        if (this.isEnabled()) {
          this._rebuildEngineFromCurrentSources().catch(err => {
            console.error(
              "[WaterfoxBlocker] Failed to reload resources after remoteResourcesEnabled change:",
              err
            );
          });
        }
        break;

      default:
        break;
    }
  },

  /**
   * @param {string} domain
   * @param {{isPrivate?: boolean}|boolean} [options]
   */
  removeSiteException(domain, options = {}) {
    this._siteExceptions().removeSiteException(domain, options);
  },

  /**
   * Bypass sources:
   * - Site exceptions stored in PermissionManager (persistent or session).
   * - Search partner exemptions when enabled.
   *
   * @param {string} candidateDomain Domain to test as a site exception or partner bypass.
   * @param {{isPrivate?: boolean}|boolean} [options]
   * @returns {boolean}
   */
  shouldBypassBlocking(candidateDomain, options = {}) {
    return lazy.blockerPolicy.shouldBypassHost(
      String(candidateDomain || ""),
      this._isPrivateExceptionContext(options)
    );
  },

  /**
   * Safe to call more than once.
   */
  uninit() {
    lazy.blockerPolicy.setNetworkBridge(null);
    if (this._policyObserverRegistered) {
      Services.obs.removeObserver(this, TOPIC_PERMISSION_CHANGED);
      this._policyObserverRegistered = false;
    }
    if (!this._initialized) {
      return;
    }

    try {
      Services.prefs.removeObserver(PREF_BRANCH, this);
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to remove pref observer:", err);
    }

    if (this._globalStatsFlushTimerId) {
      lazy.clearTimeout(this._globalStatsFlushTimerId);
      this._globalStatsFlushTimerId = null;
    }
    this._flushGlobalStats();

    this._clearInitRetryTimer();
    this._stopListUpdateTriggers();
    this._clearBlockedCounts();
    this._clearTopLevelNavigationState();
    this._listUpdatesState = null;
    this._listUpdateRerunRequested = false;
    this._listUpdateForceRequested = false;
    this._clearEngine();
    this._engineInitPromise = null;
    this._initGeneration++;
    this._siteExceptionsState = null;
    this._initialized = false;
  },
};
