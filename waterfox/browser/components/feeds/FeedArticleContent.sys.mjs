/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { MAX_ITEM_CONTENT_LENGTH } from "resource:///modules/FeedConstants.sys.mjs";

const XHTML_NS = "http://www.w3.org/1999/xhtml";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const ALLOWED_ELEMENTS = new Set([
  "a",
  "abbr",
  "address",
  "article",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "dd",
  "del",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "section",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tfoot",
  "time",
  "tr",
  "u",
  "ul",
  "var",
  "wbr",
]);
const DROPPED_ELEMENTS = new Set([
  "applet",
  "audio",
  "base",
  "button",
  "canvas",
  "embed",
  "fieldset",
  "form",
  "frame",
  "frameset",
  "head",
  "iframe",
  "input",
  "link",
  "math",
  "meta",
  "noscript",
  "object",
  "option",
  "plaintext",
  "script",
  "select",
  "source",
  "style",
  "svg",
  "template",
  "textarea",
  "track",
  "video",
  "xmp",
]);
const VOID_ELEMENTS = new Set(["br", "hr", "img", "wbr"]);

function httpURL(value, baseURL) {
  if (typeof value != "string") {
    return "";
  }
  value = value.trim();
  if (!value || value.length > 4096 || /[\p{Cc}\s]/u.test(value)) {
    return "";
  }
  try {
    const url = new URL(value, baseURL || undefined);
    if (
      ["http:", "https:"].includes(url.protocol) &&
      url.hostname &&
      !url.username &&
      !url.password &&
      !/^(?:https?:)?\/\/[^/?#]*@/i.test(value.replace(/\\/g, "/")) &&
      url.href.length <= 4096
    ) {
      return url.href;
    }
  } catch (error) {}
  return "";
}

function escapeHTML(value) {
  return value
    .toWellFormed()
    .replace(/\p{Cc}/gu, char => ("\t\n\r".includes(char) ? char : ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Sanitize an HTML fragment without loading resources. Returns an empty string
 * for absent, invalid or oversized content; callers should keep plain-text fallback.
 *
 * @param {string} value - Untrusted HTML, at most MAX_ITEM_CONTENT_LENGTH code units.
 * @param {string} [baseURL] - HTTP(S) base for relative links and images.
 * @returns {string} Bounded HTML with only allowlisted elements and attributes.
 */
export function sanitizeFeedArticleContent(value, baseURL = "") {
  if (
    typeof value != "string" ||
    value.length > MAX_ITEM_CONTENT_LENGTH ||
    !value.trim()
  ) {
    return "";
  }
  // Gecko's DOMParser data documents neither execute scripts nor load images.
  const root = new DOMParser().parseFromString(value, "text/html").body;
  return sanitizeFeedArticleNode(root, baseURL);
}

/**
 * Sanitize children of a parsed XML/HTML container without reparsing XML as HTML.
 *
 * @param {Element} root - Container whose own xml:base is already in baseURL.
 * @param {string} baseURL - Inherited base; descendant xml:base is resolved here.
 * @returns {string} The same bounded HTML contract as sanitizeFeedArticleContent.
 */
export function sanitizeFeedArticleNode(root, baseURL) {
  const parts = [];
  const initialBase = httpURL(baseURL);
  let hasContent = false;
  let length = 0;
  let nodes = 0;
  let exceeded = false;
  const append = value => {
    length += value.length;
    if (length > MAX_ITEM_CONTENT_LENGTH) {
      exceeded = true;
    } else {
      parts.push(value);
    }
  };
  const visit = (node, base, depth) => {
    if (exceeded) {
      return;
    }
    if (++nodes > 20000 || depth > 64) {
      exceeded = true;
      return;
    }
    if (
      node.nodeType == node.TEXT_NODE ||
      node.nodeType == node.CDATA_SECTION_NODE
    ) {
      const text = escapeHTML(node.data);
      hasContent ||= !!text.trim();
      append(text);
      return;
    }
    if (
      node.nodeType != node.ELEMENT_NODE ||
      (node.namespaceURI && node.namespaceURI != XHTML_NS)
    ) {
      return;
    }
    const name = node.localName.toLowerCase();
    if (DROPPED_ELEMENTS.has(name)) {
      return;
    }
    if (node.hasAttributeNS(XML_NS, "base")) {
      const value = node.getAttributeNS(XML_NS, "base").trim();
      if (value) {
        base = httpURL(value, base);
      }
    }
    const allowed = ALLOWED_ELEMENTS.has(name);
    if (allowed) {
      let attributes = "";
      if (name == "a" || name == "img") {
        const attribute = name == "a" ? "href" : "src";
        const url = httpURL(node.getAttribute(attribute), base);
        if (name == "img" && !url) {
          const alt = escapeHTML(node.getAttribute("alt") || "");
          hasContent ||= !!alt.trim();
          append(alt);
          return;
        }
        if (url) {
          attributes += ` ${attribute}="${escapeHTML(url)}"`;
        }
      }
      if (name == "img") {
        hasContent = true;
        if (node.hasAttribute("alt")) {
          attributes += ` alt="${escapeHTML(node.getAttribute("alt"))}"`;
        }
        for (const attribute of ["width", "height"]) {
          const value = node.getAttribute(attribute);
          if (!/^\d{1,5}$/.test(value)) {
            continue;
          }
          const dimension = Number(value);
          if (dimension > 0 && dimension <= 10000) {
            attributes += ` ${attribute}="${dimension}"`;
          }
        }
      }
      append(`<${name}${attributes}>`);
    }
    for (const child of node.childNodes) {
      visit(child, base, depth + 1);
      if (exceeded) {
        break;
      }
    }
    if (allowed && !VOID_ELEMENTS.has(name)) {
      append(`</${name}>`);
    }
  };
  for (const child of root.childNodes) {
    visit(child, initialBase, 0);
    if (exceeded) {
      return "";
    }
  }
  return hasContent ? parts.join("").trim() : "";
}
