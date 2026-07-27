/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Overlays } from "resource:///modules/Overlays.sys.mjs";

const PLACEMENT_ATTRIBUTES = new Set([
  "insertafter",
  "insertbefore",
  "position",
]);
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const attributeOwnersByElement = new WeakMap();

function getAttributeKey(namespace, localName) {
  return `${namespace ?? ""}\u0000${localName}`;
}

function hasAttributeValue(element, state, value) {
  return (
    element.hasAttributeNS(state.namespace, state.localName) &&
    element.getAttributeNS(state.namespace, state.localName) === value
  );
}

function claimAttribute(element, attribute, previousOwner) {
  const namespace = attribute.namespaceURI;
  const localName = attribute.localName;
  const key = getAttributeKey(namespace, localName);
  let states = attributeOwnersByElement.get(element);
  let state = states?.get(key);
  const topOwner = state?.owners.at(-1);

  if (topOwner && !hasAttributeValue(element, state, topOwner.value)) {
    state = null;
  }
  if (!states) {
    states = new Map();
    attributeOwnersByElement.set(element, states);
  }
  if (!state) {
    const baseAttribute = element.getAttributeNodeNS(namespace, localName);
    state = {
      base: baseAttribute
        ? { name: baseAttribute.name, value: baseAttribute.value }
        : null,
      localName,
      namespace,
      owners: [],
    };
    states.set(key, state);
  }

  const ownerIndex = previousOwner ? state.owners.indexOf(previousOwner) : -1;
  const owner = ownerIndex === -1 ? {} : previousOwner;
  if (ownerIndex !== -1) {
    state.owners.splice(ownerIndex, 1);
  }
  owner.name = attribute.name;
  owner.value = attribute.value;
  state.owners.push(owner);
  element.setAttributeNS(namespace, attribute.name, attribute.value);
  return owner;
}

function releaseAttribute(element, key, owner) {
  const states = attributeOwnersByElement.get(element);
  const state = states?.get(key);
  const ownerIndex = state?.owners.indexOf(owner) ?? -1;
  if (ownerIndex === -1) {
    return;
  }

  const forgetState = () => {
    states.delete(key);
    if (!states.size) {
      attributeOwnersByElement.delete(element);
    }
  };
  const topOwner = state.owners.at(-1);
  if (!hasAttributeValue(element, state, topOwner.value)) {
    forgetState();
    return;
  }
  if (ownerIndex !== state.owners.length - 1) {
    state.owners.splice(ownerIndex, 1);
    return;
  }

  state.owners.pop();
  const nextOwner = state.owners.at(-1);
  if (nextOwner) {
    element.setAttributeNS(state.namespace, nextOwner.name, nextOwner.value);
  } else if (state.base) {
    element.setAttributeNS(state.namespace, state.base.name, state.base.value);
  } else {
    element.removeAttributeNS(state.namespace, state.localName);
  }

  if (!state.owners.length) {
    forgetState();
  }
}

function getProcessingInstructionHref(data) {
  const match = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(data);
  return match?.[1] ?? match?.[2] ?? null;
}

function resolveURI(value, base) {
  return Services.io.newURI(value, null, Services.io.newURI(base)).spec;
}

function getDocumentTarget(document) {
  const location = document.defaultView?.location;
  if (location?.protocol === "about:") {
    return location.protocol + location.pathname;
  }
  return document.documentURI.replace(/[?#].*$/, "");
}

function isSupportedDocument(document) {
  const window = document.defaultView;
  if (!window || window.closed || !document.nodePrincipal.isSystemPrincipal) {
    return false;
  }

  try {
    const uri = Services.io.newURI(getDocumentTarget(document));
    return uri.schemeIs("chrome") || uri.schemeIs("about");
  } catch {
    return false;
  }
}

function getOpenDocuments() {
  const documents = new Set();
  for (const window of Services.wm.getEnumerator(null)) {
    const docShell = window.docShell;
    if (!docShell) {
      continue;
    }

    let docShells;
    try {
      docShells = docShell.getAllDocShellsInSubtree(
        Ci.nsIDocShellTreeItem.typeAll,
        Ci.nsIDocShell.ENUMERATE_FORWARDS
      );
    } catch {
      docShells = [docShell];
    }

    for (const childDocShell of docShells) {
      const document = childDocShell.docViewer?.DOMDocument;
      if (document) {
        documents.add(document);
      }
    }
  }
  return documents;
}

export class LegacyXULOverlayManager {
  constructor(manifest, extensionId, logger) {
    this.manifest = manifest;
    this.extensionId = extensionId;
    this.logger = logger;
    this.active = false;
    this.sessions = new Set();
    this.sessionsByDocument = new WeakMap();
  }

  async start() {
    if (this.active || !this.manifest.hasDocumentEntries) {
      return;
    }

    this.active = true;
    Services.obs.addObserver(this, "chrome-document-interactive");

    const pending = [];
    for (const document of getOpenDocuments()) {
      if (["interactive", "complete"].includes(document.readyState)) {
        pending.push(this.applyToDocument(document));
      }
    }
    await Promise.all(pending);
  }

  observe(document, topic) {
    if (topic !== "chrome-document-interactive" || !this.active) {
      return;
    }

    this.applyToDocument(document).catch(error => {
      if (this.active) {
        this.logger.error(
          `Failed to apply legacy overlay to ${document.documentURI}`,
          error
        );
      }
    });
  }

  async applyToDocument(document) {
    if (!this.active || !isSupportedDocument(document)) {
      return;
    }

    const target = getDocumentTarget(document);
    const overlays = this.manifest.overlays.get(target) ?? [];
    const styles = this.manifest.styles.get(target) ?? [];
    if (!overlays.length && !styles.length) {
      return;
    }

    if (this.sessionsByDocument.has(document)) {
      await this.sessionsByDocument.get(document).promise;
      return;
    }

    const session = new LegacyOverlaySession(this, document);
    this.sessions.add(session);
    this.sessionsByDocument.set(document, session);
    session.promise = session.apply(overlays, styles);

    try {
      await session.promise;
    } catch (error) {
      session.destroy();
      throw error;
    }
  }

  _forgetSession(session) {
    this.sessions.delete(session);
    this.sessionsByDocument.delete(session.document);
  }

  stop() {
    if (this.active) {
      Services.obs.removeObserver(this, "chrome-document-interactive");
      this.active = false;
    }

    for (const session of [...this.sessions]) {
      session.destroy();
    }
  }
}

// Classic overlays remain loaded until browser restart.
export class LegacyStaticXULOverlayManager {
  constructor(manifest, extensionId, logger) {
    this.manifest = manifest;
    this.extensionId = extensionId;
    this.logger = logger;
    this.active = false;
    this.documents = new WeakSet();
  }

  async start() {
    if (this.active || !this.manifest.hasDocumentEntries) {
      return;
    }
    this.active = true;
    Services.obs.addObserver(this, "chrome-document-interactive");

    const results = await Promise.allSettled(
      [...getOpenDocuments()]
        .filter(document =>
          ["interactive", "complete"].includes(document.readyState)
        )
        .map(document => this.applyToDocument(document))
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.error(
          "Failed to apply a classic legacy overlay",
          result.reason
        );
      }
    }
  }

  observe(document, topic) {
    if (topic !== "chrome-document-interactive" || !this.active) {
      return;
    }
    this.applyToDocument(document).catch(error => {
      if (this.active) {
        this.logger.error(
          `Failed to apply classic overlay to ${document.documentURI}`,
          error
        );
      }
    });
  }

  async applyToDocument(document) {
    const window = document.defaultView;
    if (
      !this.active ||
      this.documents.has(document) ||
      !isSupportedDocument(document)
    ) {
      return;
    }

    const target = getDocumentTarget(document);
    const overlays = this.manifest.overlays.get(target) ?? [];
    const styles = this.manifest.styles.get(target) ?? [];
    if (!overlays.length && !styles.length) {
      return;
    }

    this.documents.add(document);
    await Overlays.load(this.manifest, window);
  }

  stop() {
    if (this.active) {
      Services.obs.removeObserver(this, "chrome-document-interactive");
      this.active = false;
    }
  }
}

class LegacyOverlaySession {
  constructor(manager, document) {
    this.manager = manager;
    this.manifest = manager.manifest;
    this.logger = manager.logger;
    this.document = document;
    this.window = document.defaultView;
    this.attributeChanges = new Map();
    this.insertedNodes = [];
    this.removedNodes = [];
    this.removedNodeSet = new WeakSet();
    this.loadedSheets = new Set();
    this.requests = new Set();
    this.destroyed = false;
    this._onUnload = () => this.destroy();
    this.window.addEventListener("unload", this._onUnload, { once: true });
  }

  async apply(overlayURLs, styleURLs) {
    for (const styleURL of styleURLs) {
      this._loadSheet(styleURL);
    }

    const pendingOverlays = [...overlayURLs];
    const seenOverlays = new Set();
    const scripts = [];
    const forwardReferences = [];

    while (pendingOverlays.length && !this.destroyed) {
      const overlayURL = Services.io.newURI(pendingOverlays.shift()).spec;
      if (seenOverlays.has(overlayURL)) {
        continue;
      }
      seenOverlays.add(overlayURL);

      const overlayDocument = await this._fetchOverlay(overlayURL);
      if (this.destroyed) {
        return;
      }

      for (const styleURL of this.manifest.styles.get(overlayURL) ?? []) {
        this._loadSheet(styleURL);
      }
      for (const nestedURL of this.manifest.overlays.get(overlayURL) ?? []) {
        pendingOverlays.push(nestedURL);
      }

      for (const node of overlayDocument.childNodes) {
        if (node.nodeType !== 7) {
          continue;
        }
        const href = getProcessingInstructionHref(node.data);
        if (!href) {
          continue;
        }
        if (node.target === "xml-stylesheet") {
          this._loadSheet(resolveURI(href, overlayURL));
        } else if (node.target === "xul-overlay") {
          pendingOverlays.push(resolveURI(href, overlayURL));
        }
      }

      for (const script of [
        ...overlayDocument.getElementsByTagNameNS("*", "script"),
      ]) {
        if (script.hasAttribute("src")) {
          scripts.push({
            url: resolveURI(script.getAttribute("src"), overlayURL),
          });
        } else if (script.textContent.trim()) {
          scripts.push({ code: script.textContent, sourceURL: overlayURL });
        }
        script.remove();
      }

      forwardReferences.push(...overlayDocument.documentElement.children);
    }

    this._resolveForwardReferences(forwardReferences);

    for (const script of scripts) {
      if (this.destroyed) {
        return;
      }
      this._loadScript(script);
    }
  }

  _fetchOverlay(url) {
    if (!this.manifest.package.resolveRegisteredURI(url)) {
      throw new Error(`Legacy overlay is not local to the extension: ${url}`);
    }

    return new Promise((resolve, reject) => {
      const request = new this.window.XMLHttpRequest();
      this.requests.add(request);

      const finish = () => {
        this.requests.delete(request);
        request.onload = null;
        request.onerror = null;
        request.onabort = null;
      };

      request.overrideMimeType("application/xml");
      request.open("GET", url, true);
      try {
        request.channel.owner =
          Services.scriptSecurityManager.getSystemPrincipal();
      } catch (error) {
        finish();
        reject(error);
        return;
      }

      request.onload = () => {
        const overlayDocument = request.responseXML;
        finish();
        if (
          !overlayDocument?.documentElement ||
          overlayDocument.documentElement.localName === "parsererror" ||
          overlayDocument.getElementsByTagNameNS("*", "parsererror").length
        ) {
          reject(new Error(`Unable to parse legacy overlay ${url}`));
          return;
        }
        resolve(overlayDocument);
      };
      request.onerror = () => {
        finish();
        reject(new Error(`Unable to load legacy overlay ${url}`));
      };
      request.onabort = () => {
        finish();
        reject(new Error(`Loading legacy overlay was cancelled: ${url}`));
      };
      request.send();
    });
  }

  _resolveForwardReferences(sources) {
    let unresolved = [...sources];
    let madeProgress = true;

    while (unresolved.length && madeProgress) {
      madeProgress = false;
      const remaining = [];
      for (const source of unresolved) {
        if (this._resolveTopLevelHook(source)) {
          madeProgress = true;
        } else {
          remaining.push(source);
        }
      }
      unresolved = remaining;
    }

    if (unresolved.length) {
      const ids = unresolved
        .map(source => source.getAttribute("id") || source.localName)
        .join(", ");
      this.logger.warn(
        `Unable to resolve legacy overlay references in ${this.document.documentURI}: ${ids}`
      );
    }
  }

  _resolveTopLevelHook(source) {
    const id = source.getAttribute("id");
    if (id) {
      const target = this.document.getElementById(id);
      if (target) {
        this._mergeElement(target, source);
        return true;
      }

      if (source.getAttribute("removeelement") === "true") {
        return false;
      }
      if (
        source.hasAttribute("insertafter") ||
        source.hasAttribute("insertbefore") ||
        source.hasAttribute("position")
      ) {
        return Boolean(
          this._insertElement(this.document.documentElement, source, true)
        );
      }
      return false;
    }

    if (source.getAttribute("removeelement") === "true") {
      this.logger.warn(
        "Ignoring removeelement on an overlay node without an id"
      );
      return true;
    }
    this._insertElement(this.document.documentElement, source);
    return true;
  }

  _mergeElement(target, source) {
    if (source.getAttribute("removeelement") === "true") {
      this._removeElement(target);
      return;
    }

    this._mergeAttributes(target, source);
    for (const child of [...source.children]) {
      const id = child.getAttribute("id");
      const existing = id ? this.document.getElementById(id) : null;
      if (existing) {
        this._mergeElement(existing, child);
      } else if (child.getAttribute("removeelement") !== "true") {
        this._insertElement(target, child);
      }
    }
  }

  _removeElement(target) {
    if (!target.parentNode) {
      return;
    }
    if (this.insertedNodes.includes(target)) {
      target.remove();
      return;
    }
    if (this.removedNodeSet.has(target)) {
      return;
    }

    this.removedNodeSet.add(target);
    this.removedNodes.push({
      node: target,
      parent: target.parentNode,
      previousSibling: target.previousSibling,
      nextSibling: target.nextSibling,
    });
    target.remove();
  }

  _mergeAttributes(target, source) {
    for (const attribute of source.attributes) {
      if (
        attribute.name === "id" ||
        attribute.name === "removeelement" ||
        PLACEMENT_ATTRIBUTES.has(attribute.name) ||
        attribute.namespaceURI === XMLNS_NAMESPACE
      ) {
        continue;
      }

      const key = getAttributeKey(attribute.namespaceURI, attribute.localName);
      if (!this.attributeChanges.has(target)) {
        this.attributeChanges.set(target, new Map());
      }
      const changes = this.attributeChanges.get(target);
      changes.set(key, claimAttribute(target, attribute, changes.get(key)));
    }
  }

  _insertElement(fallbackParent, source, deferMissingPlacement = false) {
    if (source.getAttribute("removeelement") === "true") {
      return null;
    }

    let parent = fallbackParent;
    let reference = null;
    let placementResolved = false;

    const after = source.getAttribute("insertafter");
    const before = source.getAttribute("insertbefore");
    const anchorIDs = (after || before || "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean);
    for (const id of anchorIDs) {
      const anchor = this.document.getElementById(id);
      if (
        anchor?.parentNode &&
        (fallbackParent === this.document.documentElement ||
          anchor.parentNode === fallbackParent)
      ) {
        parent = anchor.parentNode;
        reference = after ? anchor.nextSibling : anchor;
        placementResolved = true;
        break;
      }
    }

    if ((after || before) && !placementResolved && deferMissingPlacement) {
      return null;
    }

    if (!after && !before) {
      const position = Number.parseInt(source.getAttribute("position"), 10);
      if (position > 0 && position <= parent.children.length) {
        reference = parent.children[position - 1];
      }
    }

    const node = this.document.importNode(source, true);
    for (const name of PLACEMENT_ATTRIBUTES) {
      node.removeAttribute(name);
    }
    node.removeAttribute("removeelement");
    parent.insertBefore(node, reference);
    this.insertedNodes.push(node);
    return node;
  }

  _loadSheet(url) {
    if (this.loadedSheets.has(url)) {
      return;
    }
    if (!this.manifest.package.resolveRegisteredURI(url)) {
      throw new Error(
        `Legacy stylesheet is not local to the extension: ${url}`
      );
    }

    const windowUtils = this.window.windowUtils;
    windowUtils.loadSheetUsingURIString(url, windowUtils.AUTHOR_SHEET);
    this.loadedSheets.add(url);
  }

  _loadScript(script) {
    throw new Error(
      `Restartless legacy overlays cannot execute scripts: ${script.url ?? script.sourceURL ?? "<inline>"}`
    );
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;

    this.window.removeEventListener("unload", this._onUnload);
    for (const request of this.requests) {
      request.abort();
    }
    this.requests.clear();

    for (const node of this.insertedNodes.reverse()) {
      node.remove();
    }
    this.insertedNodes.length = 0;

    for (const [element, changes] of this.attributeChanges) {
      for (const [key, owner] of changes) {
        releaseAttribute(element, key, owner);
      }
    }
    this.attributeChanges.clear();

    for (const {
      node,
      parent,
      previousSibling,
      nextSibling,
    } of this.removedNodes.reverse()) {
      if (nextSibling?.parentNode === parent) {
        parent.insertBefore(node, nextSibling);
      } else if (previousSibling?.parentNode === parent) {
        parent.insertBefore(node, previousSibling.nextSibling);
      } else {
        parent.appendChild(node);
      }
    }
    this.removedNodes.length = 0;

    for (const url of this.loadedSheets) {
      try {
        const windowUtils = this.window.windowUtils;
        windowUtils.removeSheetUsingURIString(url, windowUtils.AUTHOR_SHEET);
      } catch (error) {
        this.logger.warn(
          `Unable to remove legacy stylesheet ${url} from ${this.document.documentURI}`,
          error
        );
      }
    }
    this.loadedSheets.clear();
    this.manager._forgetSession(this);
  }
}
