/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

export {
  MAX_CUSTOM_FILTERS_BYTES,
  MAX_CUSTOM_FILTER_LINE_LENGTH,
  normalizeCustomFiltersText,
} from "resource:///modules/internal/ListStore.sys.mjs";

import {
  isPrivateBrowsingContext,
  isPrivateOriginAttributes,
} from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

const lazy = {};

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

// Prefs
const PREF_ENABLED = "waterfox.blocker.enabled";
const PREF_ALLOW_SEARCH_PARTNER_ADS = "waterfox.blocker.allowSearchPartnerAds";
const PREF_FILTER_LIST_URLS = "waterfox.blocker.filterListUrls";
const PREF_ENABLED_LISTS = "waterfox.blocker.enabledLists";
const PREF_LEGACY_SITE_EXCEPTIONS = "waterfox.blocker.siteExceptions";
const PREF_SITE_EXCEPTIONS_MIGRATED =
  "waterfox.blocker.siteExceptions.migrated";
const PREF_REMOTE_RESOURCES_ENABLED = "waterfox.blocker.remoteResourcesEnabled";
const PREF_BRANCH = "waterfox.blocker.";

const SEARCH_PARTNER_DOMAINS = Object.freeze([
  "1.org",
  "qwant.com",
  "search.waterfox.com",
]);

const BLOCKED_COUNT_MAP_MAX_ENTRIES = 500;
const BLOCKED_COUNT_MAP_TRIM_TO_ENTRIES = 250;
const TOPIC_BLOCKED_COUNT_UPDATED = "WaterfoxBlocker:BlockedCountUpdated";
const TOPIC_BLOCKED_COUNTS_CLEARED = "WaterfoxBlocker:BlockedCountsCleared";
const TOPIC_HTTP_ON_MODIFY_REQUEST = "http-on-modify-request";
const TOPIC_HTTP_ON_EXAMINE_RESPONSE = "http-on-examine-response";
const TOPIC_HTTP_ON_EXAMINE_CACHED_RESPONSE = "http-on-examine-cached-response";
const TOPIC_HTTP_ON_EXAMINE_MERGED_RESPONSE = "http-on-examine-merged-response";
const TOPIC_PREF_CHANGED = "nsPref:changed";

const BLOCKED_PAGE_URL = "about:contentblocked";
const INIT_RETRY_DELAY_MS = 30 * 1000;
const LIST_UPDATE_FALLBACK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TOP_LEVEL_NAVIGATION_BYPASS_TTL_MS = 60 * 1000;
const REMOTE_SETTINGS_POLL_END_TOPIC = "remote-settings:changes-poll-end";
const REPLACE_RESPONSE_MAX_BYTES = 10 * 1024 * 1024;
export const REPLACE_MAX_INPUT_BYTES = 2 * 1024 * 1024;
const BYTE_STRING_CHUNK_SIZE = 0x8000;
export const MAX_REPLACE_DIRECTIVES = 25;
const MAX_HTML_FILTERS = 250;
const MAX_RESPONSE_HEADER_FILTERS = 100;
const MAX_HTML_FILTER_CANDIDATES = 2000;
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
        if (out.length >= MAX_HTML_FILTER_CANDIDATES) {
          return out;
        }
      }
    } catch (_) {
      return [];
    }
  }

  return out;
}

function filterHtmlFilterCandidates(candidates, predicate) {
  const out = [];

  const consider = element => {
    if (element?.nodeType !== 1) {
      return false;
    }

    try {
      if (predicate(element)) {
        out.push(element);
        return out.length >= MAX_HTML_FILTER_CANDIDATES;
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

function applyHtmlFilterUpward(candidates, arg) {
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
          if (out.length >= MAX_HTML_FILTER_CANDIDATES) {
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
        candidates = filterHtmlFilterCandidates(candidates, element =>
          matchesProceduralPattern(element.textContent || "", arg)
        );
        break;
      case "matches-attr":
        candidates = filterHtmlFilterCandidates(candidates, element =>
          matchesHtmlFilterAttr(element, arg)
        );
        break;
      case "matches-css":
        candidates = filterHtmlFilterCandidates(candidates, element =>
          matchesHtmlFilterCss(element, arg)
        );
        break;
      case "matches-css-before":
        candidates = filterHtmlFilterCandidates(candidates, element =>
          matchesHtmlFilterCss(element, arg, "::before")
        );
        break;
      case "matches-css-after":
        candidates = filterHtmlFilterCandidates(candidates, element =>
          matchesHtmlFilterCss(element, arg, "::after")
        );
        break;
      case "matches-path":
        candidates = matchesHtmlFilterPath(documentUrl, arg) ? candidates : [];
        break;
      case "min-text-length":
        candidates = filterHtmlFilterCandidates(candidates, element => {
          const minLength = Number.parseInt(arg, 10);
          return (
            Number.isFinite(minLength) &&
            (element.textContent || "").length >= minLength
          );
        });
        break;
      case "upward":
        candidates = applyHtmlFilterUpward(candidates, arg);
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
 * Owns the native engine, loads and refreshes filter lists, intercepts
 * network channels to block requests and apply CSP, and tracks blocked
 * counts for each tab so the protections UI can read them.
 */
export const WaterfoxBlockerService = {
  QueryInterface: ChromeUtils.generateQI([
    "nsIObserver",
    "nsIWaterfoxBlockerContentPolicyBridge",
  ]),

  _blockedCountByBrowserId: new Map(),
  _topLevelHostByBrowserId: new Map(),
  _topLevelNavigationBypassByBrowserId: new Map(),
  _listUpdatesState: null,
  _listUpdatePromise: null,
  _listUpdateRerunRequested: false,
  _localRebuildWaiters: 0,
  _siteExceptionsState: null,
  _engine: null,
  _engineInitPromise: null,
  _initGeneration: 0,
  _cosmeticResourceGeneration: 0,
  _initRetryTimerId: null,
  _initialized: false,
  _listUpdateObserverRegistered: false,
  __thirdPartyUtil: undefined,

  _customFiltersPath() {
    return lazy.ListStore.customFiltersPath();
  },

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

  _clearBlockedCounts() {
    if (!this._blockedCountByBrowserId.size) {
      return;
    }

    this._blockedCountByBrowserId.clear();
    this._notifyBlockedCountsCleared();
  },

  _clearTopLevelNavigationState() {
    this._topLevelHostByBrowserId.clear();
    this._topLevelNavigationBypassByBrowserId.clear();
  },

  _createEngine() {
    return Cc[CONTRACT_ID].createInstance(Ci.nsIWaterfoxBlockerEngine);
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
      this._engine = engine;
    } catch (_) {
      // Cache missing, corrupt, or incompatible. Async path will rebuild.
    }
  },

  _customFiltersDescriptor() {
    return lazy.ListCatalog.customFiltersDescriptor();
  },

  _getMissingBundledListDescriptors(descriptors, listRecords) {
    return lazy.ListCatalog.getMissingBundledListDescriptors(
      descriptors,
      listRecords
    );
  },

  _normalizeCustomFiltersText(text) {
    return lazy.ListStore.normalizeCustomFiltersText(text);
  },

  async _readCustomFiltersText() {
    return lazy.ListStore.readCustomFiltersText();
  },

  async _readCustomFiltersRecord() {
    return lazy.ListStore.readCustomFiltersRecord(
      this._customFiltersDescriptor()
    );
  },

  _getEnabledListOverrides() {
    return lazy.ListCatalog.getEnabledListOverrides();
  },

  _isCatalogEntryEnabled(entry, userLocale, overrides = null) {
    return lazy.ListCatalog.isCatalogEntryEnabled(entry, userLocale, overrides);
  },

  async _getListDescriptors() {
    return lazy.ListCatalog.getListDescriptors();
  },

  async _resolveLocalListRecords(descriptors) {
    return lazy.ListStore.resolveLocalListRecords(descriptors);
  },

  _preprocessListRecords(listRecords) {
    return listRecords.map(record => ({
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

    const missingBundledDescriptors = this._getMissingBundledListDescriptors(
      descriptors,
      listRecords
    );
    if (!complete) {
      throw new Error(
        `${missingBundledDescriptors.length} bundled filter list(s) unavailable for baseline`
      );
    }
    if (!listRecords.length) {
      this._engine = null;
      await lazy.EngineCache.clear();
      return;
    }

    const listRecordsForEngine = await this._preprocessListRecords(listRecords);
    if (this._initGeneration !== generation) {
      return;
    }

    const nextEngine = this._createEngineFromListRecords(listRecordsForEngine);
    if (!nextEngine) {
      throw new Error("Filter lists contained no valid rules");
    }
    if (this._initGeneration !== generation) {
      return;
    }
    this._engine = nextEngine;
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
    if (!this._engineInitPromise) {
      return;
    }

    try {
      await this._engineInitPromise;
    } catch (_) {
      // Initialisation failures are handled by the init path itself.
    }
  },

  async _loadResourcesAndBumpGeneration() {
    if (!this._engine) {
      return;
    }

    await lazy.Resources.load(this._engine);
    this._cosmeticResourceGeneration++;
  },

  async _doInitializeEngineIfNeeded() {
    // Capture generation so we can detect if the blocker was disabled (or
    // re-initialised) while we were awaiting async work.
    const generation = this._initGeneration;

    if (this._engine) {
      // Engine may already be loaded from the synchronous cache path. Verify
      // it still matches the current list set before trusting it.
      const descriptors = await this._getListDescriptors();
      if (this._initGeneration !== generation) {
        return;
      }

      if (!descriptors.length) {
        this._engine = null;
        return;
      }

      const storedLists = await this._readStoredLists(descriptors);
      const storedListsForEngine = this._preprocessListRecords(storedLists);
      const cacheMatchesCurrentLists =
        storedLists.length &&
        (await lazy.EngineCache.matchesCurrentLists(
          descriptors,
          storedListsForEngine
        ));
      if (!cacheMatchesCurrentLists) {
        const previousEngine = this._engine;
        try {
          await this._initFromLocalSourcesAndCache(descriptors, generation);
        } catch (err) {
          this._engine = previousEngine;
          throw err;
        }

        if (this._initGeneration !== generation) {
          return;
        }
      }

      await this._loadResourcesAndBumpGeneration();
      return;
    }

    const descriptors = await this._getListDescriptors();
    if (this._initGeneration !== generation) {
      return;
    }
    if (!descriptors.length) {
      this._engine = null;
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

    if (this._initGeneration !== generation) {
      return;
    }

    await this._loadResourcesAndBumpGeneration();
  },

  _listsMetadataPath() {
    return lazy.ListStore.listsMetadataPath();
  },

  async _loadCatalog() {
    return lazy.ListCatalog.loadCatalog();
  },

  _mapContentPolicyType(contentPolicyType) {
    switch (contentPolicyType) {
      case Ci.nsIContentPolicy.TYPE_DOCUMENT:
        return "document";
      case Ci.nsIContentPolicy.TYPE_SUBDOCUMENT:
        return "subdocument";
      case Ci.nsIContentPolicy.TYPE_STYLESHEET:
        return "stylesheet";
      case Ci.nsIContentPolicy.TYPE_SCRIPT:
        return "script";
      case Ci.nsIContentPolicy.TYPE_IMAGE:
      case Ci.nsIContentPolicy.TYPE_IMAGESET:
        return "image";
      case Ci.nsIContentPolicy.TYPE_MEDIA:
        return "media";
      case Ci.nsIContentPolicy.TYPE_FONT:
        return "font";
      case Ci.nsIContentPolicy.TYPE_FETCH:
      case Ci.nsIContentPolicy.TYPE_XMLHTTPREQUEST:
        return "xmlhttprequest";
      case Ci.nsIContentPolicy.TYPE_WEBSOCKET:
        return "websocket";
      case Ci.nsIContentPolicy.TYPE_PING:
      case Ci.nsIContentPolicy.TYPE_BEACON:
        return "ping";
      case Ci.nsIContentPolicy.TYPE_CSP_REPORT:
        return "csp_report";
      case Ci.nsIContentPolicy.TYPE_OBJECT:
        return "object";
      default:
        return "other";
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

  _buildBlockedPageUrl(url, result) {
    const params = new URLSearchParams();
    params.set("url", String(url || ""));

    const matchedRule = this._extractMatchedRule(result);
    if (matchedRule) {
      params.set("rule", matchedRule);
    }

    return `${BLOCKED_PAGE_URL}?${params.toString()}`;
  },

  _extractMatchedRule(result) {
    if (!result || typeof result !== "object") {
      return "";
    }

    for (const key of ["rule", "matchedRule", "filter", "rawFilter"]) {
      const value = result[key];
      if (typeof value === "string") {
        const trimmed = value.trim();
        if (trimmed) {
          return trimmed;
        }
      }
    }

    return "";
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

  _getChannelReferrerHost(channel) {
    try {
      const referrerSpec = channel?.referrerInfo?.computedReferrerSpec;
      return referrerSpec ? new URL(referrerSpec).hostname : "";
    } catch (_) {
      return "";
    }
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

  _canUseTopLevelDocumentContext(loadInfo, isTopLevelDocument) {
    if (!isTopLevelDocument) {
      return true;
    }

    const triggeringPrincipal = loadInfo?.triggeringPrincipal;
    return (
      !!triggeringPrincipal &&
      !triggeringPrincipal.isSystemPrincipal &&
      !loadInfo?.loadTriggeredFromExternal &&
      (triggeringPrincipal.isContentPrincipal ||
        triggeringPrincipal.isNullPrincipal ||
        !!loadInfo?.hasValidUserGestureActivation)
    );
  },

  _shouldBypassLoadInfo(
    loadInfo,
    { isTopLevelDocument = false, targetHostname = "" } = {}
  ) {
    const candidateHosts = [
      targetHostname,
      this._getPrincipalHost(loadInfo?.triggeringPrincipal),
      this._getPrincipalHost(loadInfo?.loadingPrincipal),
      this._getPrincipalHost(loadInfo?.principalToInherit),
    ];

    if (this._canUseTopLevelDocumentContext(loadInfo, isTopLevelDocument)) {
      candidateHosts.push(
        this._getBrowsingContextDocumentHost(loadInfo?.browsingContext?.top),
        this._getBrowsingContextDocumentHost(
          loadInfo?.targetBrowsingContext?.top
        ),
        this._getBrowsingContextDocumentHost(
          loadInfo?.workerAssociatedBrowsingContext?.top
        )
      );
    }

    return candidateHosts.some(host => this.shouldBypassBlocking(host));
  },

  _rememberTopLevelHost(browserId, hostname) {
    const id = Number(browserId || 0);
    const host = String(hostname || "").replace(/\.$/, "");
    if (!id || !host) {
      return;
    }

    this._topLevelHostByBrowserId.set(id, host);
    if (this._topLevelHostByBrowserId.size > BLOCKED_COUNT_MAP_MAX_ENTRIES) {
      const firstId = this._topLevelHostByBrowserId.keys().next().value;
      this._topLevelHostByBrowserId.delete(firstId);
      this._topLevelNavigationBypassByBrowserId.delete(firstId);
    }
  },

  _getTopLevelNavigationBypassSourceHost(browserId, channel, loadInfo) {
    const id = Number(browserId || 0);
    const candidateHosts = [
      this._getChannelReferrerHost(channel),
      this._getPrincipalHost(loadInfo?.triggeringPrincipal),
      this._getPrincipalHost(loadInfo?.loadingPrincipal),
      this._getPrincipalHost(loadInfo?.principalToInherit),
      this._getBrowsingContextDocumentHost(loadInfo?.browsingContext?.top),
      this._getBrowsingContextDocumentHost(
        loadInfo?.targetBrowsingContext?.top
      ),
      this._topLevelHostByBrowserId.get(id) || "",
    ];

    if (!id || !this._topLevelHostByBrowserId.has(id)) {
      candidateHosts.push(
        this._getBrowsingContextDocumentHost(
          loadInfo?.browsingContext?.opener?.top
        ),
        this._getBrowsingContextDocumentHost(
          loadInfo?.targetBrowsingContext?.opener?.top
        )
      );
    }

    return candidateHosts.find(host => this.shouldBypassBlocking(host)) || "";
  },

  _hasActiveTopLevelNavigationBypass(browserId) {
    const id = Number(browserId || 0);
    const activeBypass = this._topLevelNavigationBypassByBrowserId.get(id);
    if (activeBypass?.until > Date.now()) {
      if (this.shouldBypassBlocking(activeBypass.sourceHost)) {
        return true;
      }
      this._topLevelNavigationBypassByBrowserId.delete(id);
      return false;
    }

    this._topLevelNavigationBypassByBrowserId.delete(id);
    return false;
  },

  _rememberTopLevelResponse(channel, loadInfo, requestType, hostname) {
    if (requestType !== "document" || !loadInfo?.isTopLevelLoad) {
      return;
    }

    let responseStatus = 0;
    try {
      responseStatus = Number(channel.responseStatus || 0);
    } catch (_) {
      // Some channels do not expose response status yet.
    }

    if (responseStatus >= 300 && responseStatus < 400) {
      return;
    }

    const browserId = this._getTopBrowserId(loadInfo);
    this._rememberTopLevelHost(browserId, hostname);
    this._topLevelNavigationBypassByBrowserId.delete(browserId);
  },

  _shouldBypassTopLevelDocumentRequest(browserId, channel, loadInfo, hostname) {
    const id = Number(browserId || 0);
    const canUseSourceContext = this._canUseTopLevelDocumentContext(
      loadInfo,
      true
    );
    const sourceHost = canUseSourceContext
      ? this._getTopLevelNavigationBypassSourceHost(id, channel, loadInfo)
      : "";

    if (
      this._shouldBypassLoadInfo(loadInfo, {
        isTopLevelDocument: true,
        targetHostname: hostname,
      })
    ) {
      if (id && sourceHost && !this.shouldBypassBlocking(hostname)) {
        this._topLevelNavigationBypassByBrowserId.set(id, {
          sourceHost,
          until: Date.now() + TOP_LEVEL_NAVIGATION_BYPASS_TTL_MS,
        });
      }
      return true;
    }

    if (!canUseSourceContext) {
      return false;
    }

    if (id && this._hasActiveTopLevelNavigationBypass(id)) {
      return true;
    }

    if (!sourceHost) {
      return false;
    }

    if (id) {
      this._topLevelNavigationBypassByBrowserId.set(id, {
        sourceHost,
        until: Date.now() + TOP_LEVEL_NAVIGATION_BYPASS_TTL_MS,
      });
    }
    return true;
  },

  _getTopBrowserId(loadInfo) {
    try {
      return Number(loadInfo?.browsingContext?.top?.browserId || 0);
    } catch (_) {
      // BrowsingContext can disappear during navigation teardown.
      return 0;
    }
  },

  _getRequestMethod(channel) {
    try {
      return channel?.requestMethod || "";
    } catch (_) {
      return "";
    }
  },

  _isThirdPartyChannel(channel) {
    const thirdPartyUtil = this._thirdPartyUtil;
    if (!thirdPartyUtil) {
      return true;
    }

    try {
      return thirdPartyUtil.isThirdPartyChannel(channel);
    } catch (_) {
      // Be conservative if third-party classification fails.
      return true;
    }
  },

  _isThirdPartyLoadInfo(loadInfo) {
    if (!loadInfo) {
      return true;
    }

    try {
      return !!(
        loadInfo.isThirdPartyContextToTopWindow ||
        loadInfo.isInThirdPartyContext
      );
    } catch (_) {
      // Be conservative if third-party classification fails.
      return true;
    }
  },

  _handleTopLevelDocumentRequest(
    channel,
    loadInfo,
    url,
    sourceHostname,
    hostname
  ) {
    const browserId = this._getTopBrowserId(loadInfo);
    if (
      this._shouldBypassTopLevelDocumentRequest(
        browserId,
        channel,
        loadInfo,
        hostname
      )
    ) {
      if (this.shouldBypassBlocking(hostname)) {
        this._rememberTopLevelHost(browserId, hostname);
      }
      return;
    }

    const result = this.checkRequest(
      url,
      sourceHostname,
      hostname,
      "document",
      this._getRequestMethod(channel),
      this._isThirdPartyChannel(channel)
    );
    if (!result.matched || result.exception) {
      this._rememberTopLevelHost(browserId, hostname);
      return;
    }

    try {
      const blockedPageUrl = this._buildBlockedPageUrl(url, result);
      channel.redirectTo(Services.io.newURI(blockedPageUrl));
    } catch (err) {
      console.error(
        "[WaterfoxBlocker] Failed to redirect to blocked page:",
        err
      );
      channel.cancel(Cr.NS_ERROR_ABORT);
    }

    try {
      if (browserId) {
        this.incrementBlockedCount(browserId);
      }
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to increment blocked count:", err);
    }
  },

  /**
   * Redirects blocked top level documents to the blocked page, runs bypass
   * checks, and cancels matched subresource requests. Loads served from
   * internal caches are handled by the `shouldLoad` bridge instead.
   *
   * @param {nsISupports} subject
   */
  _onModifyRequest(subject) {
    if (!this._engine || !this.isEnabled()) {
      return;
    }

    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch (_) {
      // Some observer subjects are not HTTP channels.
      return;
    }

    const uri = channel.URI;
    if (!uri || (!uri.schemeIs("http") && !uri.schemeIs("https"))) {
      return;
    }

    const loadInfo = channel.loadInfo;
    if (!loadInfo) {
      return;
    }

    const requestType = this._mapContentPolicyType(
      loadInfo.externalContentPolicyType
    );
    const url = uri.spec;
    const browserId = this._getTopBrowserId(loadInfo);

    let hostname = "";
    try {
      hostname = uri.host || "";
    } catch (_) {
      // nsIURI.host throws for URI types without an authority component.
    }

    if (requestType === "document" && loadInfo.isTopLevelLoad) {
      this._handleTopLevelDocumentRequest(
        channel,
        loadInfo,
        url,
        this._getPrincipalHost(loadInfo.loadingPrincipal),
        hostname
      );
      return;
    }

    if (this._shouldBypassLoadInfo(loadInfo)) {
      return;
    }

    const result = this.checkRequest(
      url,
      this._getPrincipalHost(loadInfo.loadingPrincipal),
      hostname,
      requestType,
      this._getRequestMethod(channel),
      this._isThirdPartyChannel(channel)
    );

    if (result.matched && !result.exception) {
      // `$redirect`/`$redirect-rule` rules carry a data: URL replacement; serve
      // it instead of cancelling so the request receives a neutered payload.
      const redirected =
        !!result.redirect && this._redirectChannel(channel, result.redirect);
      if (!redirected) {
        channel.cancel(Cr.NS_ERROR_ABORT);
      }

      try {
        if (browserId) {
          this.incrementBlockedCount(browserId);
        }
      } catch (err) {
        console.warn(
          "[WaterfoxBlocker] Failed to increment blocked count:",
          err
        );
      }
      return;
    }

    // `$removeparam` rules rewrite the URL without blocking the request;
    // redirect to the cleaned URL so tracking parameters are stripped.
    if (
      !result.exception &&
      result.rewrittenUrl &&
      result.rewrittenUrl !== url
    ) {
      this._redirectChannel(channel, result.rewrittenUrl);
    }
  },

  /**
   * Redirects a channel to a replacement URL during http-on-modify-request:
   * a `$redirect` data: URL or a `$removeparam` rewritten URL.
   *
   * @param {nsIHttpChannel} channel
   * @param {string} target
   * @returns {boolean} Whether the redirect was applied.
   */
  _redirectChannel(channel, target) {
    try {
      channel.redirectTo(Services.io.newURI(target));
      return true;
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to redirect channel:", err);
      return false;
    }
  },

  /**
   * Applies response-time blocker actions, including `$replace=` body rewrites
   * and `$csp` response headers.
   *
   * @param {nsISupports} subject
   */
  _onExamineResponse(subject) {
    if (!this._engine || !this.isEnabled()) {
      return;
    }

    let channel;
    try {
      channel = subject.QueryInterface(Ci.nsIHttpChannel);
    } catch (_) {
      // Some observer subjects are not HTTP channels.
      return;
    }

    const uri = channel.URI;
    if (!uri || (!uri.schemeIs("http") && !uri.schemeIs("https"))) {
      return;
    }

    const loadInfo = channel.loadInfo;
    if (!loadInfo) {
      return;
    }

    const requestType = this._mapContentPolicyType(
      loadInfo.externalContentPolicyType
    );

    const url = uri.spec;

    let hostname = "";
    try {
      hostname = uri.host || "";
    } catch (_) {
      // uri.host throws for URIs without an authority component (e.g.
      // about: pages).
    }

    const isTopLevelDocument =
      requestType === "document" && loadInfo.isTopLevelLoad;
    const shouldBypassResponse =
      this._shouldBypassLoadInfo(loadInfo, {
        isTopLevelDocument,
        targetHostname: hostname,
      }) ||
      (isTopLevelDocument &&
        this._hasActiveTopLevelNavigationBypass(
          this._getTopBrowserId(loadInfo)
        ));

    this._rememberTopLevelResponse(channel, loadInfo, requestType, hostname);

    if (shouldBypassResponse) {
      return;
    }

    const htmlFilteringResources =
      requestType === "document" || requestType === "subdocument"
        ? this.getHtmlFilteringResources(url)
        : { htmlFilters: [], responseHeaderFilters: [] };
    this._applyResponseHeaderFilters(
      channel,
      htmlFilteringResources.responseHeaderFilters
    );

    this._maybeFilterResponseBody(
      channel,
      loadInfo,
      url,
      hostname,
      requestType,
      htmlFilteringResources.htmlFilters
    );

    if (requestType !== "document" && requestType !== "subdocument") {
      return;
    }

    const directives = this.getCspDirectives(
      url,
      this._getPrincipalHost(loadInfo.loadingPrincipal),
      hostname,
      requestType,
      this._getRequestMethod(channel),
      this._isThirdPartyChannel(channel)
    );
    if (!directives) {
      return;
    }

    try {
      channel.setResponseHeader("Content-Security-Policy", directives, true);
    } catch (err) {
      console.error("[WaterfoxBlocker] Failed to apply CSP directives:", err);
    }
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

  _maybeFilterResponseBody(
    channel,
    loadInfo,
    url,
    hostname,
    requestType,
    htmlFilters
  ) {
    const replaceDirectives = isReplaceEligibleContent(channel, requestType)
      ? this.getReplaceDirectives(
          url,
          this._getPrincipalHost(loadInfo.loadingPrincipal),
          hostname,
          requestType,
          this._getRequestMethod(channel),
          this._isThirdPartyChannel(channel)
        )
      : [];
    const eligibleHtmlFilters = isHtmlFilterEligibleContent(
      channel,
      requestType
    )
      ? htmlFilters
      : [];

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

  async _rebuildEngineFromCurrentSources({
    preservePreviousEngine = false,
  } = {}) {
    const previousEngine = preservePreviousEngine ? this._engine : null;
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

    try {
      await this._initFromLocalSourcesAndCache(descriptors, generation);
      if (this._initGeneration !== generation) {
        return;
      }

      await this._loadResourcesAndBumpGeneration();
    } catch (err) {
      // Preserve the previous engine when a live rebuild fails.
      if (preservePreviousEngine && this._initGeneration === generation) {
        this._engine = previousEngine;
      }
      throw err;
    }
  },

  async _readJSON(path, fallbackValue) {
    return lazy.ListStore.readJSON(path, fallbackValue);
  },

  async _readStoredLists(descriptors) {
    return lazy.ListStore.readStoredLists(descriptors);
  },

  async refreshListsAndEngine() {
    await this._rebuildEngineFromCurrentSources({
      preservePreviousEngine: true,
    });
    await this._updateListsIfNeeded();
  },

  /**
   * Wires up triggers that refresh lists. The RemoteSettings poll observer
   * (`remote-settings:changes-poll-end`) is opportunistic, so a 24 h fallback
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

  get _thirdPartyUtil() {
    if (this.__thirdPartyUtil === undefined) {
      try {
        this.__thirdPartyUtil = Cc["@mozilla.org/thirdpartyutil;1"].getService(
          Ci.mozIThirdPartyUtil
        );
      } catch (_) {
        // Some builds may not expose the third-party utility service.
        this.__thirdPartyUtil = null;
      }
    }
    return this.__thirdPartyUtil;
  },

  _trimBlockedCountMapIfNeeded() {
    if (this._blockedCountByBrowserId.size <= BLOCKED_COUNT_MAP_MAX_ENTRIES) {
      return;
    }

    let removeCount =
      this._blockedCountByBrowserId.size - BLOCKED_COUNT_MAP_TRIM_TO_ENTRIES;
    for (const browserId of this._blockedCountByBrowserId.keys()) {
      this._blockedCountByBrowserId.delete(browserId);
      removeCount--;
      if (removeCount <= 0) {
        break;
      }
    }
  },

  async _tryInitFromCache(descriptors, generation) {
    const storedLists = await this._readStoredLists(descriptors);
    const storedListsForEngine = this._preprocessListRecords(storedLists);
    const cacheMatchesCurrentLists =
      storedLists.length &&
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
    this._engine = candidate;
    return true;
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
        const missingCount = this._getMissingBundledListDescriptors(
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
        this._engine = null;
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
      this._engine = nextEngine;

      await this._loadResourcesAndBumpGeneration();
      if (!this._isCurrentListUpdate(generation)) {
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

  async _runListUpdatePass() {
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
    const result = await this._listUpdates().updateIfNeeded();
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
   */
  async _updateListsIfNeeded() {
    if (this._listUpdatePromise) {
      this._listUpdateRerunRequested = true;
      return this._listUpdatePromise;
    }

    const promise = (async () => {
      do {
        this._listUpdateRerunRequested = false;
        await this._runListUpdatePass();
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
   * Allows the domain for the rest of the browser session. The entry is
   * dropped on browser shutdown.
   *
   * @param {string} domain
   */
  allowSiteForSession(domain) {
    this._siteExceptions().allowSiteForSession(domain);
  },

  _normalizeCheckResult(rawResult) {
    const normalized = {
      exception: false,
      important: false,
      matched: false,
      redirect: "",
      rewrittenUrl: "",
    };

    if (!rawResult || typeof rawResult !== "object") {
      return normalized;
    }

    normalized.matched = !!rawResult.matched;
    normalized.important = !!rawResult.important;
    normalized.exception = !!rawResult.exception;

    if (typeof rawResult.redirect === "string") {
      normalized.redirect = rawResult.redirect;
    }

    if (typeof rawResult.rewrittenUrl === "string") {
      normalized.rewrittenUrl = rawResult.rewrittenUrl;
    }

    return normalized;
  },

  /**
   * @param {string} url
   * @param {string} sourceHostname
   * @param {string} hostname
   * @param {string} requestType adblock-rs request type string.
   * @param {string} requestMethod HTTP request method.
   * @param {boolean} isThirdParty
   * @returns {{matched: boolean, important: boolean, exception: boolean, redirect: string, rewrittenUrl: string}}
   */
  checkRequest(
    url,
    sourceHostname,
    hostname,
    requestType,
    requestMethod,
    isThirdParty
  ) {
    if (!this._engine) {
      return this._normalizeCheckResult(null);
    }

    try {
      // IDL method order:
      // url, sourceHostname, hostname, requestType, requestMethod, isThirdParty
      const json = this._engine.checkRequestDetailed(
        url,
        sourceHostname,
        hostname,
        requestType,
        requestMethod || "",
        !!isThirdParty
      );
      return this._normalizeCheckResult(JSON.parse(json));
    } catch (err) {
      console.error("[WaterfoxBlocker] checkRequest failed:", err);
      return this._normalizeCheckResult(null);
    }
  },

  getBlockedCount(browserId) {
    return this._blockedCountByBrowserId.get(browserId) || 0;
  },

  /**
   * @param {number} newBrowserId
   * @param {string} sourceHost
   */
  recordNewTabSourceHost(newBrowserId, sourceHost) {
    if (this.shouldBypassBlocking(sourceHost)) {
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
    this._notifyBlockedCountUpdated(id, 0);
    return 0;
  },

  /**
   * @param {string} url
   * @param {BrowsingContext|null} [browsingContext=null]
   * @returns {object|null} Parsed cosmetic resource payload from the native engine.
   */
  getCosmeticResources(url, browsingContext = null) {
    if (!this.isEnabled()) {
      return null;
    }

    let hostname = "";
    try {
      hostname = new URL(url).hostname;
    } catch (err) {
      console.error("[WaterfoxBlocker] getCosmeticResources failed:", err);
      return null;
    }

    if (
      !hostname ||
      [
        hostname,
        this._getBrowsingContextDocumentHost(browsingContext),
        this._getBrowsingContextDocumentHost(browsingContext?.top),
      ].some(host => this.shouldBypassBlocking(host))
    ) {
      return null;
    }

    if (!this._engine) {
      return {};
    }

    try {
      const resources = JSON.parse(this._engine.getCosmeticResources(url));
      return resources && typeof resources === "object" ? resources : {};
    } catch (err) {
      console.error("[WaterfoxBlocker] getCosmeticResources failed:", err);
      return {};
    }
  },

  /**
   * @param {string} url
   * @param {string} sourceHostname
   * @param {string} hostname
   * @param {string} requestType
   * @param {string} requestMethod
   * @param {boolean} isThirdParty
   * @returns {string} Directive string, or empty when none apply.
   */
  getCspDirectives(
    url,
    sourceHostname,
    hostname,
    requestType,
    requestMethod,
    isThirdParty
  ) {
    if (!this._engine) {
      return "";
    }

    if (requestType !== "document" && requestType !== "subdocument") {
      return "";
    }

    try {
      if (typeof this._engine.getCspDirectives !== "function") {
        return "";
      }

      return (
        this._engine.getCspDirectives(
          url,
          sourceHostname,
          hostname,
          requestType,
          requestMethod || "",
          !!isThirdParty
        ) || ""
      );
    } catch (err) {
      console.error("[WaterfoxBlocker] getCspDirectives failed:", err);
      return "";
    }
  },

  /**
   * @param {string} url
   * @param {string} sourceHostname
   * @param {string} hostname
   * @param {string} requestType
   * @param {string} requestMethod
   * @param {boolean} isThirdParty
   * @returns {string[]} Matched `$replace=` directive strings.
   */
  getReplaceDirectives(
    url,
    sourceHostname,
    hostname,
    requestType,
    requestMethod,
    isThirdParty
  ) {
    if (!this._engine) {
      return [];
    }

    try {
      if (typeof this._engine.getReplaceDirectives !== "function") {
        return [];
      }

      const rawDirectives = JSON.parse(
        this._engine.getReplaceDirectives(
          url,
          sourceHostname,
          hostname,
          requestType,
          requestMethod || "",
          !!isThirdParty
        ) || "[]"
      );
      return sanitizeStringList(rawDirectives, MAX_REPLACE_DIRECTIVES, 4096);
    } catch (err) {
      console.error("[WaterfoxBlocker] getReplaceDirectives failed:", err);
      return [];
    }
  },

  /**
   * @param {string} url
   * @returns {{htmlFilters: string[], responseHeaderFilters: string[]}}
   */
  getHtmlFilteringResources(url) {
    if (!this._engine) {
      return { htmlFilters: [], responseHeaderFilters: [] };
    }

    try {
      if (typeof this._engine.getCosmeticResources !== "function") {
        return { htmlFilters: [], responseHeaderFilters: [] };
      }

      const resources = JSON.parse(this._engine.getCosmeticResources(url));
      if (!resources || typeof resources !== "object") {
        return { htmlFilters: [], responseHeaderFilters: [] };
      }

      return {
        htmlFilters: sanitizeStringList(
          resources.html_filters,
          MAX_HTML_FILTERS,
          4096
        ),
        responseHeaderFilters: sanitizeResponseHeaderNames(
          resources.response_header_filters
        ),
      };
    } catch (err) {
      console.error("[WaterfoxBlocker] getHtmlFilteringResources failed:", err);
      return { htmlFilters: [], responseHeaderFilters: [] };
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
    const meta = await this._readJSON(this._listsMetadataPath(), { lists: [] });
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
    const normalized = this._normalizeCustomFiltersText(text);
    const path = this._customFiltersPath();
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
      await this._rebuildEngineFromCurrentSources({
        preservePreviousEngine: true,
      });
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

        await this._rebuildEngineFromCurrentSources({
          preservePreviousEngine: true,
        });
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
   * @returns {string[]}
   */
  getHiddenClassIdSelectors(classes = [], ids = [], exceptions = []) {
    if (!this._engine) {
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
        this._engine.getHiddenClassIdSelectors(
          classesJson,
          idsJson,
          exceptionsJson
        )
      );

      return selectors.filter(s => s);
    } catch (err) {
      console.error("[WaterfoxBlocker] getHiddenClassIdSelectors failed:", err);
      return [];
    }
  },

  /**
   * @param {number} browserId
   * @returns {number}
   */
  incrementBlockedCount(browserId) {
    const current = this.getBlockedCount(browserId);
    const next = current + 1;
    this._blockedCountByBrowserId.set(browserId, next);
    this._trimBlockedCountMapIfNeeded();
    this._notifyBlockedCountUpdated(browserId, next);
    return next;
  },

  _networkObserversRegistered: false,

  _registerNetworkObservers() {
    if (this._networkObserversRegistered) {
      return;
    }
    for (const topic of [
      TOPIC_HTTP_ON_MODIFY_REQUEST,
      TOPIC_HTTP_ON_EXAMINE_RESPONSE,
      TOPIC_HTTP_ON_EXAMINE_CACHED_RESPONSE,
      TOPIC_HTTP_ON_EXAMINE_MERGED_RESPONSE,
    ]) {
      Services.obs.addObserver(this, topic);
    }
    this._networkObserversRegistered = true;
  },

  _unregisterNetworkObservers() {
    if (!this._networkObserversRegistered) {
      return;
    }
    for (const topic of [
      TOPIC_HTTP_ON_MODIFY_REQUEST,
      TOPIC_HTTP_ON_EXAMINE_RESPONSE,
      TOPIC_HTTP_ON_EXAMINE_CACHED_RESPONSE,
      TOPIC_HTTP_ON_EXAMINE_MERGED_RESPONSE,
    ]) {
      try {
        Services.obs.removeObserver(this, topic);
      } catch (err) {
        console.warn(
          `[WaterfoxBlocker] Failed to remove observer for ${topic}:`,
          err
        );
      }
    }
    this._networkObserversRegistered = false;
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
      this._registerNetworkObservers();
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
    this._initialized = true;

    this._migrateSiteExceptions();

    if (!this.isEnabled()) {
      return;
    }

    this._registerNetworkObservers();

    // Load the engine from the serialised cache synchronously so it is
    // ready before the first request arrives.
    this._tryInitFromCacheSync();
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
   * @returns {boolean}
   */
  isSiteExcepted(domain) {
    return this._siteExceptions().isSiteExcepted(domain);
  },

  /**
   * @param {nsISupports|null} subject
   * @param {string} topic
   * @param {string} data
   */
  observe(subject, topic, data) {
    if (topic === TOPIC_HTTP_ON_MODIFY_REQUEST) {
      this._onModifyRequest(subject);
      return;
    }

    if (
      topic === TOPIC_HTTP_ON_EXAMINE_RESPONSE ||
      topic === TOPIC_HTTP_ON_EXAMINE_CACHED_RESPONSE ||
      topic === TOPIC_HTTP_ON_EXAMINE_MERGED_RESPONSE
    ) {
      this._onExamineResponse(subject);
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

    switch (data) {
      case PREF_ENABLED:
        if (this.isEnabled()) {
          this._registerNetworkObservers();
          this._initializeEngineWithRetry();
        } else {
          this._clearInitRetryTimer();
          this._unregisterNetworkObservers();
          this._stopListUpdateTriggers();
          this._clearBlockedCounts();
          this._clearTopLevelNavigationState();
          this._listUpdatesState = null;
          this._listUpdateRerunRequested = false;
          this._engine = null;
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

      case PREF_REMOTE_RESOURCES_ENABLED:
        if (this.isEnabled() && this._engine) {
          this._loadResourcesAndBumpGeneration().catch(err => {
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
   */
  removeSiteException(domain) {
    this._siteExceptions().removePermanentSiteException(domain);
  },

  /**
   * Bypass sources:
   * - Site exceptions stored in PermissionManager (persistent or session).
   * - Search partner exemptions when enabled.
   *
   * @param {string} candidateDomain Domain to test as a site exception or partner bypass.
   * @returns {boolean}
   */
  shouldBypassBlocking(candidateDomain) {
    const domain = String(candidateDomain || "").replace(/\.$/, "");
    if (!domain) {
      return false;
    }

    if (this.isSiteExcepted(domain)) {
      return true;
    }

    if (!Services.prefs.getBoolPref(PREF_ALLOW_SEARCH_PARTNER_ADS, true)) {
      return false;
    }

    return SEARCH_PARTNER_DOMAINS.some(
      p => domain === p || domain.endsWith(`.${p}`)
    );
  },

  /**
   * Runs before every load (including loads served from internal caches) and
   * applies the same blocking logic as the observer path for requests that
   * are not top level.
   *
   * @param {nsIURI} contentLocation
   * @param {nsILoadInfo} loadInfo
   * @returns {number} `nsIContentPolicy` decision code.
   */
  shouldLoad(contentLocation, loadInfo) {
    const ACCEPT = Ci.nsIContentPolicy.ACCEPT;
    const REJECT_TYPE = Ci.nsIContentPolicy.REJECT_TYPE;

    if (!this.isEnabled() || !contentLocation || !loadInfo) {
      return ACCEPT;
    }

    if (!this._engine) {
      return ACCEPT;
    }

    if (
      !contentLocation.schemeIs("http") &&
      !contentLocation.schemeIs("https")
    ) {
      return ACCEPT;
    }

    const requestType = this._mapContentPolicyType(
      loadInfo.externalContentPolicyType
    );

    // Top-level documents are handled by `_handleTopLevelDocumentRequest`
    // in the observer path so the blocked-page redirect works.
    if (requestType === "document" && loadInfo.isTopLevelLoad) {
      return ACCEPT;
    }

    const browserId = this._getTopBrowserId(loadInfo);
    if (this._shouldBypassLoadInfo(loadInfo)) {
      return ACCEPT;
    }

    const url = contentLocation.spec || "";
    if (!url) {
      return ACCEPT;
    }

    let hostname = "";
    try {
      hostname = contentLocation.host || "";
    } catch (_) {
      // nsIURI.host throws for URI types without an authority component.
    }

    const result = this.checkRequest(
      url,
      this._getPrincipalHost(loadInfo.loadingPrincipal),
      hostname,
      requestType,
      "",
      this._isThirdPartyLoadInfo(loadInfo)
    );
    if (!result.matched || result.exception) {
      return ACCEPT;
    }

    try {
      if (browserId) {
        this.incrementBlockedCount(browserId);
      }
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to increment blocked count:", err);
    }

    return REJECT_TYPE;
  },

  /**
   * Safe to call more than once.
   */
  uninit() {
    if (!this._initialized) {
      return;
    }

    try {
      Services.prefs.removeObserver(PREF_BRANCH, this);
    } catch (err) {
      console.warn("[WaterfoxBlocker] Failed to remove pref observer:", err);
    }

    this._unregisterNetworkObservers();
    this._clearInitRetryTimer();
    this._stopListUpdateTriggers();
    this._clearBlockedCounts();
    this._clearTopLevelNavigationState();
    this._listUpdatesState = null;
    this._listUpdateRerunRequested = false;
    this._engine = null;
    this._engineInitPromise = null;
    this._initGeneration++;
    this.__thirdPartyUtil = undefined;
    this._siteExceptionsState = null;
    this._initialized = false;
  },
};
