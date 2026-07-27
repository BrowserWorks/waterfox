/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const NS_XML = "http://www.w3.org/XML/1998/namespace";
const NS_XMLNS = "http://www.w3.org/2000/xmlns/";
const NS_RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
const NS_NC = "http://home.netscape.com/NC-rdf#";
const RDF_TYPE = `${NS_RDF}type`;
const RDF_CONTAINERS = new Set([
  `${NS_RDF}Alt`,
  `${NS_RDF}Bag`,
  `${NS_RDF}Seq`,
]);
const XML_NAME = /^[A-Za-z_][A-Za-z0-9._-]*$/;
const URI_SUFFIX = /[A-Za-z_][A-Za-z0-9._-]*$/;

function isElement(node) {
  return node?.nodeType === 1;
}

function validateDocument(document) {
  const parserError = document.querySelector("parsererror");
  if (parserError) {
    throw new Error(parserError.textContent.trim());
  }

  if (
    document.documentElement?.namespaceURI !== NS_RDF ||
    document.documentElement.localName !== "RDF"
  ) {
    throw new Error("Install manifest is not an RDF document");
  }
  return document;
}

function getRDFAttribute(element, name) {
  if (element.hasAttributeNS(NS_RDF, name)) {
    return element.getAttributeNS(NS_RDF, name);
  }
  return element.hasAttribute(name) ? element.getAttribute(name) : undefined;
}

function resolveReference(element, value) {
  try {
    return Services.io.newURI(element.baseURI).resolve(value);
  } catch {
    return value;
  }
}

function isDate(value) {
  return Object.prototype.toString.call(value) === "[object Date]";
}

class RDFNode {
  equals(node) {
    if (node?.constructor !== this.constructor) {
      return false;
    }
    if (isDate(this._value)) {
      return (
        isDate(node._value) && node._value.getTime() === this._value.getTime()
      );
    }
    return node._value === this._value;
  }
}

export class RDFLiteral extends RDFNode {
  constructor(value) {
    super();
    this._value = value;
  }

  getValue() {
    return this._value;
  }
}

export class RDFIntLiteral extends RDFLiteral {
  constructor(value) {
    super(Number.parseInt(value));
  }
}

export class RDFDateLiteral extends RDFLiteral {
  constructor(value) {
    if (!isDate(value)) {
      throw new TypeError("RDFDateLiteral requires a Date");
    }
    super(value);
  }
}

class RDFSubject extends RDFNode {
  constructor(dataSource) {
    super();
    this._ds = dataSource;
    this._assertions = new Map();
    this._defined = false;
    this._referenced = false;
  }

  _validateObject(object) {
    if (!(object instanceof RDFLiteral) && !(object instanceof RDFSubject)) {
      throw new TypeError("object must be an RDF node");
    }
    if (object instanceof RDFSubject && object._ds !== this._ds) {
      throw new Error("object must belong to the same datasource");
    }
  }

  _addObject(predicate, object, markDirty) {
    if (typeof predicate !== "string" || !predicate) {
      throw new TypeError("predicate must be a non-empty URI");
    }
    this._validateObject(object);
    if (!this._assertions.has(predicate)) {
      this._assertions.set(predicate, []);
    }
    this._assertions.get(predicate).push(object);
    if (object instanceof RDFSubject) {
      object._referenced = true;
    }
    if (markDirty) {
      this._defined = true;
      this._ds._dirty = true;
    }
  }

  assert(predicate, object) {
    if (predicate === RDF_TYPE && !(object instanceof RDFResource)) {
      throw new TypeError("rdf:type must reference an RDFResource");
    }
    this._addObject(predicate, object, true);
  }

  unassert(predicate, object) {
    const objects = this._assertions.get(predicate);
    if (!objects) {
      return;
    }
    const index = objects.findIndex(candidate => candidate.equals(object));
    if (index === -1) {
      return;
    }
    objects.splice(index, 1);
    if (!objects.length) {
      this._assertions.delete(predicate);
    }
    this._ds._dirty = true;
  }

  getPredicates() {
    return [...this._assertions.keys()];
  }

  getObjects(predicate) {
    return [...(this._assertions.get(predicate) ?? [])];
  }

  _getChildEntries() {
    const entries = [];
    let order = 0;
    for (const [predicate, objects] of this._assertions) {
      const match =
        /^http:\/\/www\.w3\.org\/1999\/02\/22-rdf-syntax-ns#_(\d+)$/.exec(
          predicate
        );
      if (!match) {
        continue;
      }
      for (const object of objects) {
        entries.push({ index: Number(match[1]), object, order: order++ });
      }
    }
    entries.sort((a, b) => a.index - b.index || a.order - b.order);
    return entries;
  }

  getChildren() {
    return this._getChildEntries().map(entry => entry.object);
  }

  _replaceChildren(children) {
    for (const predicate of [...this._assertions.keys()]) {
      if (predicate.startsWith(`${NS_RDF}_`)) {
        this._assertions.delete(predicate);
      }
    }
    children.forEach((object, index) => {
      this._addObject(`${NS_RDF}_${index + 1}`, object, false);
    });
    this._defined = true;
    this._ds._dirty = true;
  }

  removeChildAt(position) {
    const children = this.getChildren();
    if (position < 0 || position >= children.length) {
      throw new Error("no such child");
    }
    children.splice(position, 1);
    this._replaceChildren(children);
  }

  removeChild(object) {
    const children = this.getChildren();
    const position = children.findIndex(candidate => candidate.equals(object));
    if (position === -1) {
      throw new Error("no such child");
    }
    children.splice(position, 1);
    this._replaceChildren(children);
  }

  addChild(object) {
    this._validateObject(object);
    this._replaceChildren([...this.getChildren(), object]);
  }

  reorderChildren() {
    this._replaceChildren(this.getChildren());
  }

  getType() {
    const type = this.getProperty(RDF_TYPE);
    return type instanceof RDFResource ? type.getURI() : null;
  }

  hasProperty(predicate) {
    return this._assertions.has(predicate);
  }

  getProperty(predicate) {
    return this._assertions.get(predicate)?.[0] ?? null;
  }

  setProperty(predicate, object) {
    this._validateObject(object);
    this._assertions.set(predicate, [object]);
    if (object instanceof RDFSubject) {
      object._referenced = true;
    }
    this._defined = true;
    this._ds._dirty = true;
  }

  clearProperty(predicate) {
    if (this._assertions.delete(predicate)) {
      this._ds._dirty = true;
    }
  }

  isContainer() {
    return RDF_CONTAINERS.has(this.getType());
  }

  equals(node) {
    return this === node;
  }
}

export class RDFResource extends RDFSubject {
  constructor(dataSource, uri) {
    if (!(dataSource instanceof RDFDataSource)) {
      throw new TypeError("datasource must be an RDFDataSource");
    }
    if (typeof uri !== "string" || !uri) {
      throw new TypeError("RDFResource requires a non-empty URI");
    }
    super(dataSource);
    this._uri = uri;
  }

  getURI() {
    return this._uri;
  }
}

export class RDFBlankNode extends RDFSubject {
  constructor(dataSource, nodeID = null) {
    if (!(dataSource instanceof RDFDataSource)) {
      throw new TypeError("datasource must be an RDFDataSource");
    }
    super(dataSource);
    this._nodeID = nodeID;
  }

  getNodeID() {
    return this._nodeID;
  }
}

export class RDFDataSource {
  constructor(document = null) {
    this._resources = new Map();
    this._resourceAliases = new Map();
    this._blankNodes = new Map();
    this._allBlankNodes = [];
    this._elementSubjects = new WeakMap();
    this._prefixes = new Map([
      ["rdf", NS_RDF],
      ["NC", NS_NC],
    ]);
    this._dirty = false;

    if (!document) {
      document = new DOMParser().parseFromString(
        `<?xml version="1.0"?><rdf:RDF xmlns:rdf="${NS_RDF}"/>`,
        "application/xml"
      );
    }
    this._document = validateDocument(document);
    this._parseDocument();
  }

  static loadFromString(text) {
    return new RDFDataSource(
      new DOMParser().parseFromString(text, "application/xml")
    );
  }

  static loadFromBuffer(buffer) {
    const bytes =
      buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return new RDFDataSource(
      new DOMParser().parseFromBuffer(bytes, "application/xml")
    );
  }

  static async loadFromFile(uri) {
    if (uri instanceof Ci.nsIFile) {
      uri = Services.io.newFileURI(uri);
    } else if (typeof uri === "string") {
      uri = Services.io.newURI(uri);
    }
    if (!(uri instanceof Ci.nsIURI)) {
      throw new TypeError("RDFDataSource.loadFromFile requires a URI or file");
    }

    const response = await fetch(uri.spec);
    return RDFDataSource.loadFromBuffer(await response.arrayBuffer());
  }

  get document() {
    return this._document;
  }

  get uri() {
    return this._document.documentURI;
  }

  registerPrefix(prefix, namespaceURI) {
    if (typeof prefix !== "string" || typeof namespaceURI !== "string") {
      throw new TypeError("RDF prefixes and namespaces must be strings");
    }
    this._prefixes.set(prefix, namespaceURI);
  }

  getBlankNode(nodeID = null) {
    if (nodeID) {
      if (!XML_NAME.test(nodeID)) {
        throw new Error("rdf:nodeID must be a valid XML name");
      }
      if (this._blankNodes.has(nodeID)) {
        return this._blankNodes.get(nodeID);
      }
    }

    const node = new RDFBlankNode(this, nodeID);
    this._allBlankNodes.push(node);
    if (nodeID) {
      this._blankNodes.set(nodeID, node);
    }
    return node;
  }

  getAllBlankNodes() {
    return [...this._allBlankNodes];
  }

  getResource(uri) {
    if (this._resourceAliases.has(uri)) {
      return this._resourceAliases.get(uri);
    }
    if (this._resources.has(uri)) {
      return this._resources.get(uri);
    }

    const resource = new RDFResource(this, uri);
    this._resources.set(uri, resource);
    return resource;
  }

  hasResource(uri) {
    const resource =
      this._resourceAliases.get(uri) ?? this._resources.get(uri) ?? null;
    return Boolean(resource?._defined);
  }

  getAllResources() {
    return [...this._resources.values()];
  }

  getAllSubjects() {
    return [...this.getAllResources(), ...this._allBlankNodes];
  }

  _registerResourceAlias(alias, resource) {
    if (alias && alias !== resource.getURI()) {
      this._resourceAliases.set(alias, resource);
    }
  }

  _getSubjectForElement(element) {
    const about = getRDFAttribute(element, "about");
    const id = getRDFAttribute(element, "ID");
    const nodeID = getRDFAttribute(element, "nodeID");
    const identities = [about, id, nodeID].filter(value => value !== undefined);
    if (identities.length > 1) {
      throw new Error("RDF subjects may have only one identity");
    }

    if (about !== undefined) {
      const resource = this.getResource(resolveReference(element, about));
      this._registerResourceAlias(about, resource);
      return resource;
    }
    if (id !== undefined) {
      if (!XML_NAME.test(id)) {
        throw new Error("rdf:ID must be a valid XML name");
      }
      const resource = this.getResource(resolveReference(element, `#${id}`));
      this._registerResourceAlias(id, resource);
      this._registerResourceAlias(`#${id}`, resource);
      return resource;
    }
    if (nodeID !== undefined) {
      return this.getBlankNode(nodeID);
    }
    return this.getBlankNode();
  }

  _parseDocument() {
    for (const child of this._document.documentElement.childNodes) {
      if (child.nodeType === 3 && /\S/.test(child.nodeValue)) {
        throw new Error("RDF root cannot contain text");
      }
      if (isElement(child)) {
        this._parseSubjectElement(child);
      }
    }
  }

  _parseSubjectElement(element) {
    if (this._elementSubjects.has(element)) {
      return this._elementSubjects.get(element);
    }

    const subject = this._getSubjectForElement(element);
    this._elementSubjects.set(element, subject);
    subject._defined = true;

    if (
      element.namespaceURI !== NS_RDF ||
      !["Description", "RDF"].includes(element.localName)
    ) {
      if (element.namespaceURI === NS_RDF && element.localName === "li") {
        throw new Error("rdf:li is not a valid subject type");
      }
      subject._addObject(
        RDF_TYPE,
        this.getResource(`${element.namespaceURI}${element.localName}`),
        false
      );
    }

    this._parsePropertyAttributes(element, subject);
    this._parsePropertyChildren(element, subject);
    return subject;
  }

  _parsePropertyAttributes(element, subject) {
    for (const attribute of element.attributes) {
      if (
        attribute.namespaceURI === NS_XML ||
        attribute.namespaceURI === NS_XMLNS ||
        attribute.nodeName === "xmlns"
      ) {
        continue;
      }
      if (
        (!attribute.namespaceURI || attribute.namespaceURI === NS_RDF) &&
        ["about", "ID", "nodeID", "parseType", "resource"].includes(
          attribute.localName
        )
      ) {
        continue;
      }
      if (!attribute.namespaceURI) {
        throw new Error(`Unqualified RDF property ${attribute.localName}`);
      }

      const predicate = `${attribute.namespaceURI}${attribute.localName}`;
      const object =
        predicate === RDF_TYPE
          ? this.getResource(resolveReference(element, attribute.value))
          : new RDFLiteral(attribute.value.trim());
      subject._addObject(predicate, object, false);
    }
  }

  _parsePropertyChildren(element, subject) {
    let listIndex = 1;
    for (const child of element.childNodes) {
      if (child.nodeType === 3 && /\S/.test(child.nodeValue)) {
        throw new Error("RDF subjects cannot contain text");
      }
      if (!isElement(child)) {
        continue;
      }
      if (!child.namespaceURI) {
        throw new Error(`Unqualified RDF property ${child.localName}`);
      }

      let predicate = `${child.namespaceURI}${child.localName}`;
      if (child.namespaceURI === NS_RDF && child.localName === "li") {
        predicate = `${NS_RDF}_${listIndex++}`;
      }
      subject._addObject(predicate, this._parsePropertyObject(child), false);
    }
  }

  _parsePropertyObject(element) {
    const resource = getRDFAttribute(element, "resource");
    const nodeID = getRDFAttribute(element, "nodeID");
    const parseType =
      getRDFAttribute(element, "parseType") ||
      element.getAttributeNS(NS_NC, "parseType") ||
      undefined;
    const specified = [resource, nodeID, parseType].filter(
      value => value !== undefined && value !== ""
    );
    if (specified.length > 1) {
      throw new Error("RDF properties may have only one object form");
    }

    if (resource !== undefined) {
      return this.getResource(resolveReference(element, resource));
    }
    if (nodeID !== undefined) {
      return this.getBlankNode(nodeID);
    }
    if (parseType === "Resource") {
      const subject = this.getBlankNode();
      subject._defined = true;
      this._parsePropertyChildren(element, subject);
      return subject;
    }

    const children = [...element.children];
    if (children.length > 1) {
      throw new Error(`RDF property ${element.nodeName} has multiple objects`);
    }
    if (children.length === 1) {
      return this._parseSubjectElement(children[0]);
    }

    const value = element.textContent.trim();
    if (parseType === "Integer") {
      return new RDFIntLiteral(value);
    }
    if (parseType === "Date") {
      const numericValue = Number(value);
      return new RDFDateLiteral(
        new Date(Number.isNaN(numericValue) ? value : numericValue)
      );
    }
    if (parseType) {
      throw new Error(`Unsupported RDF parseType ${parseType}`);
    }
    return new RDFLiteral(value);
  }

  _ensureBlankNodeID(node) {
    if (node._nodeID) {
      return node._nodeID;
    }
    let index = 1;
    while (this._blankNodes.has(`node${index}`)) {
      index++;
    }
    node._nodeID = `node${index}`;
    this._blankNodes.set(node._nodeID, node);
    return node._nodeID;
  }

  _createSerializedDocument() {
    const document = new DOMParser().parseFromString(
      `<?xml version="1.0"?><rdf:RDF xmlns:rdf="${NS_RDF}" xmlns:NC="${NS_NC}"/>`,
      "application/xml"
    );
    const root = document.documentElement;
    let generatedPrefix = 1;

    const getName = uri => {
      for (const [prefix, namespaceURI] of this._prefixes) {
        if (!uri.startsWith(namespaceURI)) {
          continue;
        }
        const localName = uri.slice(namespaceURI.length);
        if (!XML_NAME.test(localName)) {
          continue;
        }
        if (prefix && !root.hasAttributeNS(NS_XMLNS, prefix)) {
          root.setAttributeNS(NS_XMLNS, `xmlns:${prefix}`, namespaceURI);
        }
        return {
          namespaceURI,
          qualifiedName: prefix ? `${prefix}:${localName}` : localName,
        };
      }

      const match = URI_SUFFIX.exec(uri);
      if (!match) {
        throw new Error(`Cannot serialize RDF predicate ${uri}`);
      }
      const namespaceURI = uri.slice(0, -match[0].length);
      let prefix;
      do {
        prefix = `NS${generatedPrefix++}`;
      } while (root.hasAttributeNS(NS_XMLNS, prefix));
      root.setAttributeNS(NS_XMLNS, `xmlns:${prefix}`, namespaceURI);
      return {
        namespaceURI,
        qualifiedName: `${prefix}:${match[0]}`,
      };
    };

    const resources = this.getAllResources().filter(
      resource => resource._defined || resource._assertions.size
    );
    const blankNodes = this._allBlankNodes.filter(
      node => node._defined || node._referenced || node._assertions.size
    );
    for (const subject of [...resources, ...blankNodes]) {
      const description = document.createElementNS(NS_RDF, "rdf:Description");
      if (subject instanceof RDFResource) {
        description.setAttributeNS(NS_RDF, "rdf:about", subject.getURI());
      } else {
        description.setAttributeNS(
          NS_RDF,
          "rdf:nodeID",
          this._ensureBlankNodeID(subject)
        );
      }

      for (const [predicate, objects] of subject._assertions) {
        const { namespaceURI, qualifiedName } = getName(predicate);
        for (const object of objects) {
          const property = document.createElementNS(
            namespaceURI,
            qualifiedName
          );
          if (object instanceof RDFResource) {
            property.setAttributeNS(NS_RDF, "rdf:resource", object.getURI());
          } else if (object instanceof RDFBlankNode) {
            property.setAttributeNS(
              NS_RDF,
              "rdf:nodeID",
              this._ensureBlankNodeID(object)
            );
          } else if (object instanceof RDFDateLiteral) {
            property.setAttributeNS(NS_NC, "NC:parseType", "Date");
            property.textContent = object.getValue().getTime();
          } else if (object instanceof RDFIntLiteral) {
            property.setAttributeNS(NS_NC, "NC:parseType", "Integer");
            property.textContent = object.getValue();
          } else {
            property.textContent = object.getValue();
          }
          description.appendChild(property);
        }
      }
      root.appendChild(description);
    }
    return document;
  }

  serializeToString() {
    const document = this._dirty
      ? this._createSerializedDocument()
      : this._document;
    return new XMLSerializer().serializeToString(document);
  }

  async saveToFile(file) {
    return IOUtils.writeUTF8(file.path ?? file, this.serializeToString());
  }
}
