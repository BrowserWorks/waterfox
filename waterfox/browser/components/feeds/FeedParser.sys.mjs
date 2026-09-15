/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adapted from Thunderbird's newsblog parser
const MOZ_PARSERERROR_NS =
  "http://www.mozilla.org/newlayout/xml/parsererror.xml";
const RDF_SYNTAX_NS = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const RSS_NS = "http://purl.org/rss/1.0/";
const DC_NS = "http://purl.org/dc/elements/1.1/";
const FEEDBURNER_NS = "http://rssnamespace.org/feedburner/ext/1.0";
const ATOM_03_NS = "http://purl.org/atom/ns#";
const ATOM_IETF_NS = "http://www.w3.org/2005/Atom";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XHTML_NS = "http://www.w3.org/1999/xhtml";
const MAX_XML_BYTES = 2 * 1024 * 1024;
const MAX_ITEMS = 200;
const MAX_TEXT_LENGTH = 1000;

/**
 * Parse an RSS or Atom document without fetching resources or retaining markup.
 *
 * @param {string} xml - Decoded XML, limited to 2 MiB when encoded as UTF-8.
 * @param {string} feedURL - Absolute HTTP(S) URL used to resolve relative links.
 * @returns {{title: string, siteURL: string, description: string,
 *   items: Array<{id: string, title: string, url: string}>}}
 * @throws {Error} If the input, feed URL, or feed structure is invalid.
 */
export function parseFeed(xml, feedURL) {
  if (typeof xml != "string" || !xml.trim()) {
    throw new TypeError("Feed XML must be a nonempty string");
  }
  if (
    xml.length > MAX_XML_BYTES ||
    new TextEncoder().encode(xml).length > MAX_XML_BYTES
  ) {
    throw new RangeError("Feed XML exceeds 2 MiB");
  }
  // Reject declarations before DOMParser can process any entity definitions.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error(
      "Feed XML must not contain a DOCTYPE or entity declaration"
    );
  }

  const url = absoluteHTTPURL(feedURL);
  if (!url) {
    throw new TypeError(
      "Feed URL must be an absolute HTTP(S) URL without credentials"
    );
  }
  return new FeedParser(url).parseFeed(xml);
}

function absoluteHTTPURL(link, baseURI) {
  if (typeof link != "string" || !link.trim()) {
    return "";
  }
  link = link.trim();
  /* eslint-disable-next-line no-control-regex */
  if (/[\x00-\x20\x7F]/.test(link)) {
    return "";
  }
  try {
    const url = new URL(link, baseURI || undefined);
    if (
      (url.protocol == "http:" || url.protocol == "https:") &&
      url.hostname &&
      !url.username &&
      !url.password
    ) {
      return url.href;
    }
  } catch (ex) {}
  return "";
}

/**
 *
 */
class FeedParser {
  constructor(feedURL) {
    this.feedURL = feedURL;
    this.mParser = new DOMParser();
    this.mSerializer = new XMLSerializer();
    this.baseURIs = new WeakMap();
    this.seenURLs = new Set();
  }

  parseFeed(xml) {
    const aDOM = this.mParser.parseFromString(xml, "application/xml");
    const doc = aDOM.documentElement;
    if (
      !doc ||
      aDOM.doctype ||
      doc.namespaceURI == MOZ_PARSERERROR_NS ||
      aDOM.getElementsByTagNameNS(MOZ_PARSERERROR_NS, "parsererror").length
    ) {
      throw new Error("Invalid feed XML");
    }

    const feed = { title: "", siteURL: "", description: "", items: [] };
    if (doc.localName == "RDF" && doc.namespaceURI == RDF_SYNTAX_NS) {
      this.parseAsRSS1(feed, doc);
    } else if (doc.localName == "feed" && doc.namespaceURI == ATOM_03_NS) {
      this.parseAsAtom(feed, doc);
    } else if (doc.localName == "feed" && doc.namespaceURI == ATOM_IETF_NS) {
      this.parseAsAtomIETF(feed, doc);
    } else if (doc.localName == "rss" && !doc.namespaceURI) {
      this.parseAsRSS2(feed, doc);
    } else {
      throw new Error("Unsupported feed root or namespace");
    }
    feed.title = this.limitText(feed.title);
    feed.description = this.limitText(feed.description);
    return feed;
  }

  parseAsRSS2(aFeed, aDOM) {
    // Get the first channel (assuming there is only one per RSS File).
    const channel = this.childByTagNameNS(aDOM, "", "channel");
    if (!channel) {
      throw new Error("RSS feed is missing a channel");
    }
    const nsURI = "";

    let tags = this.childrenByTagNameNS(channel, nsURI, "title");
    aFeed.title = this.stripTags(this.getNodeValue(tags ? tags[0] : null));
    tags = this.childrenByTagNameNS(channel, nsURI, "description");
    aFeed.description = this.stripTags(
      this.getNodeValue(tags ? tags[0] : null)
    );
    tags = this.childrenByTagNameNS(channel, nsURI, "link");
    aFeed.siteURL = this.nodeLink(tags ? tags[0] : null);
    if (!(aFeed.title || aFeed.description) && aFeed.siteURL) {
      const url = new URL(aFeed.siteURL);
      aFeed.title = `${url.hostname} - ${url.pathname}`;
    }
    if (!(aFeed.title || aFeed.description)) {
      throw new Error("RSS feed is missing a title and description");
    }

    const itemNodes = this.childrenByTagNameNS(channel, nsURI, "item") || [];
    for (const itemNode of itemNodes) {
      if (aFeed.items.length >= MAX_ITEMS) {
        break;
      }
      if (!itemNode.childElementCount) {
        continue;
      }
      const item = {};
      tags = this.childrenByTagNameNS(itemNode, FEEDBURNER_NS, "origLink");
      let link = this.nodeLink(tags ? tags[0] : null);
      if (!link) {
        tags = this.childrenByTagNameNS(itemNode, nsURI, "link");
        link = this.nodeLink(tags ? tags[0] : null);
      }
      tags = this.childrenByTagNameNS(itemNode, nsURI, "guid");
      const guidNode = tags ? tags[0] : null;

      let guid;
      let isPermaLink = false;
      if (guidNode) {
        guid = this.getNodeValue(guidNode);
        // isPermaLink is true if the value is "true" or if the attribute is
        // not present; all other values, including "false" and "False" and
        // for that matter "TRuE" and "meatcake" are false.
        if (
          !guidNode.hasAttribute("isPermaLink") ||
          guidNode.getAttribute("isPermaLink") == "true"
        ) {
          isPermaLink = true;
        }
        // If attribute isPermaLink is missing, it is good to check the validity
        // of <guid> value as an URL to avoid linking to non-URL strings.
        if (!guidNode.hasAttribute("isPermaLink")) {
          isPermaLink = !!absoluteHTTPURL(guid);
        }
        item.id = guid;
      }
      const guidLink = this.validLink(guid, guidNode);
      if (isPermaLink && guidLink) {
        item.url = guidLink;
      } else {
        item.url = link;
      }

      tags = this.childrenByTagNameNS(itemNode, nsURI, "description");
      const description = this.stripTags(
        this.getNodeValue(tags ? tags[0] : null)
      );
      tags = this.childrenByTagNameNS(itemNode, nsURI, "title");
      item.title = this.stripTags(this.getNodeValue(tags ? tags[0] : null));
      if (!item.title) {
        item.title = description.substr(0, 150);
      }
      this.addItem(aFeed, item);
    }
  }

  /**
   * Technically RSS1 is supposed to be treated as RDFXML, but in practice
   * no feed parser anywhere ever does this, and feeds in the wild are
   * pretty shakey on their RDF encoding too. So we just treat it as raw
   * XML and pick out the bits we want.
   *
   * @param {object} feed - The result being populated.
   * @param {Element} doc - The RDF document element.
   */
  parseAsRSS1(feed, doc) {
    const channel = this.childByTagNameNS(doc, RSS_NS, "channel");
    if (!channel) {
      throw new Error("RSS1 feed is missing a channel");
    }
    const titleNode = this.childByTagNameNS(channel, RSS_NS, "title");
    feed.title = this.stripTags(this.getNodeValue(titleNode)) || this.feedURL;
    const descNode = this.childByTagNameNS(channel, RSS_NS, "description");
    feed.description = this.stripTags(this.getNodeValue(descNode));
    const linkNode = this.childByTagNameNS(channel, RSS_NS, "link");
    feed.siteURL = this.nodeLink(linkNode);

    // Now process all the individual items in the feed.
    const itemNodes = this.childrenByTagNameNS(doc, RSS_NS, "item") || [];
    for (const itemNode of itemNodes) {
      if (feed.items.length >= MAX_ITEMS) {
        break;
      }
      const item = {};
      // Prefer the value of the link tag to the item URI since the URI could be
      // a relative URN.
      let itemURI =
        itemNode.getAttributeNS(RDF_SYNTAX_NS, "about") ||
        itemNode.getAttribute("about") ||
        "";
      itemURI = this.removeUnprintableASCII(itemURI.trim());
      const itemLinkNode = this.childByTagNameNS(itemNode, RSS_NS, "link");
      item.id = this.getNodeValue(itemLinkNode) || itemURI;
      item.url =
        this.nodeLink(itemLinkNode) || this.validLink(itemURI, itemNode);

      const itemDescNode = this.childByTagNameNS(
        itemNode,
        RSS_NS,
        "description"
      );
      const description = this.stripTags(this.getNodeValue(itemDescNode));
      const itemTitleNode = this.childByTagNameNS(itemNode, RSS_NS, "title");
      const subjectNode = this.childByTagNameNS(itemNode, DC_NS, "subject");
      item.title = this.stripTags(
        this.getNodeValue(itemTitleNode) || this.getNodeValue(subjectNode)
      );
      if (!item.title && description) {
        item.title = description.substr(0, 150);
      }
      this.addItem(feed, item);
    }
  }

  parseAsAtom(aFeed, channel) {
    let tags = this.childrenByTagNameNS(channel, ATOM_03_NS, "title");
    aFeed.title = this.atom03Text(tags ? tags[0] : null);
    tags = this.childrenByTagNameNS(channel, ATOM_03_NS, "tagline");
    aFeed.description = this.atom03Text(tags ? tags[0] : null);
    tags = this.childrenByTagNameNS(channel, ATOM_03_NS, "link");
    aFeed.siteURL = this.findAtomLink("alternate", tags);
    if (!aFeed.title) {
      throw new Error("Atom feed is missing a title");
    }

    const items = this.childrenByTagNameNS(channel, ATOM_03_NS, "entry") || [];
    for (const itemNode of items) {
      if (aFeed.items.length >= MAX_ITEMS) {
        break;
      }
      if (!itemNode.childElementCount) {
        continue;
      }
      const item = {};
      tags = this.childrenByTagNameNS(itemNode, ATOM_03_NS, "link");
      item.url = this.findAtomLink("alternate", tags);
      tags = this.childrenByTagNameNS(itemNode, ATOM_03_NS, "id");
      item.id = this.getNodeValue(tags ? tags[0] : null);
      tags = this.childrenByTagNameNS(itemNode, ATOM_03_NS, "summary");
      const description = this.atom03Text(tags ? tags[0] : null);
      tags = this.childrenByTagNameNS(itemNode, ATOM_03_NS, "title");
      item.title =
        this.atom03Text(tags ? tags[0] : null) || description.substr(0, 150);
      if (!item.title || !item.id) {
        // We're lenient about other mandatory tags, but insist on these.
        continue;
      }
      this.addItem(aFeed, item);
    }
  }

  parseAsAtomIETF(aFeed, channel) {
    let tags = this.childrenByTagNameNS(channel, ATOM_IETF_NS, "title");
    aFeed.title = this.stripTags(
      this.serializeTextConstruct(tags ? tags[0] : null)
    );
    tags = this.childrenByTagNameNS(channel, ATOM_IETF_NS, "subtitle");
    aFeed.description = this.stripTags(
      this.serializeTextConstruct(tags ? tags[0] : null)
    );
    tags = this.childrenByTagNameNS(channel, ATOM_IETF_NS, "link");
    aFeed.siteURL = this.findAtomLink("alternate", tags);
    if (!aFeed.title) {
      throw new Error("Atom feed is missing a title");
    }

    const items =
      this.childrenByTagNameNS(channel, ATOM_IETF_NS, "entry") || [];
    for (const itemNode of items) {
      if (aFeed.items.length >= MAX_ITEMS) {
        break;
      }
      if (!itemNode.childElementCount) {
        continue;
      }
      const item = {};
      tags = this.childrenByTagNameNS(itemNode, ATOM_IETF_NS, "source");
      const source = tags ? tags[0] : null;
      tags = this.childrenByTagNameNS(itemNode, FEEDBURNER_NS, "origLink");
      item.url = this.nodeLink(tags ? tags[0] : null);
      if (!item.url) {
        tags = this.childrenByTagNameNS(itemNode, ATOM_IETF_NS, "link");
        item.url = this.findAtomLink("alternate", tags);
      }
      tags = this.childrenByTagNameNS(itemNode, ATOM_IETF_NS, "id");
      item.id = this.getNodeValue(tags ? tags[0] : null);
      tags = this.childrenByTagNameNS(itemNode, ATOM_IETF_NS, "summary");
      const description = this.stripTags(
        this.serializeTextConstruct(tags ? tags[0] : null)
      );
      tags = this.childrenByTagNameNS(itemNode, ATOM_IETF_NS, "title");
      if (!tags || !this.getNodeValue(tags[0])) {
        tags = this.childrenByTagNameNS(source, ATOM_IETF_NS, "title");
      }
      item.title =
        this.stripTags(this.serializeTextConstruct(tags ? tags[0] : null)) ||
        description.substr(0, 150);
      if (!item.title || !item.id) {
        // We're lenient about other mandatory tags, but insist on these.
        continue;
      }
      this.addItem(aFeed, item);
    }
  }

  serializeTextConstruct(textElement) {
    let content = "";
    if (textElement) {
      let textType = textElement.getAttribute("type");
      // Atom spec says consider it "text" if not present.
      if (!textType) {
        textType = "text";
      }
      // There could be some strange content type we don't handle.
      if (textType != "text" && textType != "html" && textType != "xhtml") {
        return null;
      }
      if (textType == "xhtml") {
        const div = this.childByTagNameNS(textElement, XHTML_NS, "div");
        if (!div || textElement.childElementCount != 1) {
          return null;
        }
        // Keep XML CDATA and prefixed XHTML out of the HTML parser.
        return this.xmlEscape(this.stripTags(div)) || null;
      } else if (textElement.childElementCount) {
        return null;
      }
      for (const node of textElement.childNodes) {
        if (node.nodeType == node.CDATA_SECTION_NODE) {
          content += this.xmlEscape(node.data);
        } else if (node.nodeType == node.TEXT_NODE) {
          content += this.mSerializer.serializeToString(node);
        }
      }
      if (textType == "html") {
        content = this.xmlUnescape(content);
      }
      content = content.trim();
    }
    // Other parts of the code depend on this being null if there's no content.
    return content ? content : null;
  }

  atom03Text(node) {
    if (!node || node.getAttribute("mode") == "base64") {
      return "";
    }
    const type = node.getAttribute("type") || "text/plain";
    if (type == "text/plain") {
      return this.getNodeValue(node) || "";
    }
    if (type != "text/html" && type != "application/xhtml+xml") {
      return "";
    }
    if (node.getAttribute("mode") == "xml") {
      return this.stripTags(node);
    }
    return this.stripTags(this.getNodeValue(node));
  }

  /**
   * Return a cleaned up node value. This is intended for values that are not
   * multiline and not formatted. A sequence of tab or newline is converted to
   * a space and unprintable ascii is removed.
   *
   * @param {Node} node - A DOM node.
   * @returns {string|null} - A clean string value or null.
   */
  getNodeValue(node) {
    let nodeValue = node?.textContent.trim();
    if (!nodeValue) {
      return null;
    }
    nodeValue = nodeValue.replace(/[\n\r\t]+/g, " ");
    return this.removeUnprintableASCII(nodeValue);
  }

  // Finds elements that are direct children of the first arg.
  childrenByTagNameNS(aElement, aNamespace, aTagName) {
    if (!aElement) {
      return null;
    }
    const matchingChildren = [];
    for (const match of aElement.children) {
      if (
        (match.namespaceURI || "") == aNamespace &&
        match.localName == aTagName
      ) {
        matchingChildren.push(match);
      }
    }
    return matchingChildren.length ? matchingChildren : null;
  }

  childByTagNameNS(element, namespace, tagName) {
    return this.childrenByTagNameNS(element, namespace, tagName)?.[0] || null;
  }

  nodeLink(node) {
    return this.validLink(node?.textContent, node);
  }

  validLink(link, element) {
    return absoluteHTTPURL(link, this.baseURI(element));
  }

  baseURI(element) {
    const ancestors = [];
    while (element && !this.baseURIs.has(element)) {
      ancestors.push(element);
      element = element.parentElement;
    }
    let base = element ? this.baseURIs.get(element) : this.feedURL;
    for (const ancestor of ancestors.reverse()) {
      if (ancestor.hasAttributeNS(XML_NS, "base")) {
        const value = ancestor.getAttributeNS(XML_NS, "base").trim();
        if (value) {
          base = absoluteHTTPURL(value, base);
        }
      }
      this.baseURIs.set(ancestor, base);
    }
    return base;
  }

  findAtomLink(linkRel, linkElements) {
    if (!linkElements) {
      return "";
    }
    for (const alink of linkElements) {
      if (
        alink &&
        // If there's a link rel.
        ((alink.getAttribute("rel") && alink.getAttribute("rel") == linkRel) ||
          // If there isn't, assume 'alternate'.
          (!alink.getAttribute("rel") && linkRel == "alternate")) &&
        alink.getAttribute("href")
      ) {
        const type = alink
          .getAttribute("type")
          ?.split(";", 1)[0]
          .trim()
          .toLowerCase();
        if (type && type != "text/html" && type != "application/xhtml+xml") {
          continue;
        }
        // Atom links are interpreted relative to xml:base.
        const href = this.validLink(alink.getAttribute("href"), alink);
        if (href) {
          return href;
        }
      }
    }
    return "";
  }

  removeUnprintableASCII(s) {
    /* eslint-disable-next-line no-control-regex */
    return s ? s.replace(/[\x00-\x1F\x7F]+/g, "") : "";
  }

  stripTags(someHTML) {
    if (!someHTML) {
      return "";
    }
    const root =
      typeof someHTML == "string"
        ? this.mParser.parseFromString(someHTML, "text/html").body
        : someHTML.cloneNode(true);
    for (const element of root.querySelectorAll("*")) {
      const name = element.localName.split(":").pop().toLowerCase();
      if (["script", "style", "template", "noscript"].includes(name)) {
        element.remove();
      } else if (["br", "p", "div", "li", "tr"].includes(name)) {
        element.before(" ");
        element.after(" ");
      }
    }
    return this.limitText(root.textContent);
  }

  limitText(value) {
    let text = this.removeUnprintableASCII((value || "").replace(/\s+/g, " "))
      .trim()
      .slice(0, MAX_TEXT_LENGTH);
    if (/[\uD800-\uDBFF]$/.test(text)) {
      text = text.slice(0, -1);
    }
    return text;
  }

  addItem(feed, item) {
    const title = this.limitText(item.title);
    if (!item.url || !title) {
      return;
    }
    const key = new URL(item.url);
    key.hash = "";
    if (this.seenURLs.has(key.href)) {
      return;
    }
    this.seenURLs.add(key.href);
    feed.items.push({
      id: this.limitText(item.id) || this.limitText(item.url),
      title,
      url: item.url,
    });
  }

  xmlUnescape(s) {
    s = s.replace(/&lt;/g, "<");
    s = s.replace(/&gt;/g, ">");
    s = s.replace(/&amp;/g, "&");
    return s;
  }

  xmlEscape(s) {
    s = s.replace(/&/g, "&amp;");
    s = s.replace(/>/g, "&gt;");
    s = s.replace(/</g, "&lt;");
    return s;
  }
}
