/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PLACEMENT_ATTRIBUTES = new Set([
  "insertafter",
  "insertbefore",
  "position",
]);
const OVERLAY_ATTRIBUTES = new Set([
  ...PLACEMENT_ATTRIBUTES,
  "delete",
  "removeelement",
]);
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";
const loadsByDocument = new WeakMap();

function registryValues(registry, key) {
  if (!registry || typeof registry.get !== "function") {
    return [];
  }
  const value = registry.get(key, false);
  if (value == null) {
    return [];
  }
  if (typeof value === "string") {
    return [value];
  }
  return typeof value[Symbol.iterator] === "function" ? [...value] : [];
}

function getProcessingInstructionHref(data) {
  const match = /\bhref\s*=\s*(?:"([^"]+)"|'([^']+)')/i.exec(data);
  return match?.[1] ?? match?.[2] ?? null;
}

function enumeratorValues(enumerator) {
  if (!enumerator) {
    return [];
  }
  if (typeof enumerator[Symbol.iterator] === "function") {
    return [...enumerator];
  }

  const values = [];
  const hasMore =
    typeof enumerator.hasMore === "function"
      ? () => enumerator.hasMore()
      : () => enumerator.hasMoreElements();
  while (hasMore()) {
    values.push(enumerator.getNext());
  }
  return values;
}

function getDocumentLocation(window) {
  const { location } = window;
  if (location.protocol === "about:") {
    return location.protocol + location.pathname;
  }
  if (location.origin && location.origin !== "null") {
    return location.origin + location.pathname;
  }
  const uri = window.document.documentURI || location.href;
  return uri.replace(/[?#].*$/, "");
}

function hasRemovalInstruction(node) {
  return (
    node.hasAttribute("delete") ||
    node.getAttribute("removeelement")?.toLowerCase() === "true"
  );
}

// Only parent-process documents can receive legacy XUL overlays.
export class Overlays {
  static load(overlayProvider, window) {
    if (
      !overlayProvider ||
      (typeof overlayProvider !== "object" &&
        typeof overlayProvider !== "function") ||
      !window?.document
    ) {
      throw new TypeError("Overlays.load requires a provider and a window");
    }

    let providerLoads = loadsByDocument.get(window.document);
    if (!providerLoads) {
      providerLoads = new WeakMap();
      loadsByDocument.set(window.document, providerLoads);
    }
    if (providerLoads.has(overlayProvider)) {
      return providerLoads.get(overlayProvider);
    }

    const instance = new Overlays(overlayProvider, window);
    const overlays = registryValues(
      overlayProvider.overlay ?? overlayProvider.overlays,
      instance.location
    );
    const promise = instance.load(overlays);
    providerLoads.set(overlayProvider, promise);
    promise.catch(() => {
      if (providerLoads.get(overlayProvider) === promise) {
        providerLoads.delete(overlayProvider);
      }
    });
    return promise;
  }

  constructor(overlayProvider, window) {
    this.overlayProvider = overlayProvider;
    this.window = window;
    this.location = getDocumentLocation(window);

    this.unloadedScripts = [];
    this.deferredLoad = [];
    this.persistedIDs = new Set();
    this.requests = new Map();

    this._decksToResolve = new Map();
    this._toolbarsToResolve = new Set();
    this._loadedSheets = new Set();
    this._loadPromise = null;
    this._pendingFinish = null;
    this._loading = false;
    this._destroyed = false;
    this._finished = false;
    this._listeningForUnload = false;
    this._onUnload = () => this._destroy();
  }

  get document() {
    return this.window.document;
  }

  load(urls = []) {
    if (!this._loadPromise) {
      this._loadPromise = this._load(urls);
    }
    return this._loadPromise;
  }

  async _load(urls) {
    if (this._destroyed) {
      throw new Error("Cannot load overlays into an unloaded window");
    }

    this._loading = true;
    this._ensureUnloadListener();
    try {
      const overlayQueue = [];
      const seenOverlays = new Set();
      const forwardReferences = [];
      const sheets = new Set();
      const documentBase = this.document.baseURI || this.location;

      for (const url of this._collectOverlays(this.document, documentBase)) {
        overlayQueue.push(url);
      }
      let initialURLs = [];
      if (typeof urls === "string") {
        initialURLs = [urls];
      } else if (urls && typeof urls[Symbol.iterator] === "function") {
        initialURLs = [...urls];
      }
      for (const url of initialURLs) {
        overlayQueue.push(this._resolveURI(url, documentBase));
      }

      for (const sheet of this._registryValues("style", this.location)) {
        sheets.add(this._resolveURI(sheet, documentBase));
      }
      for (const sheet of this._collectStyles(this.document, documentBase)) {
        sheets.add(sheet);
      }

      if (!overlayQueue.length && !sheets.size) {
        return;
      }
      this._readPersistedIDs();

      for (let index = 0; index < overlayQueue.length; index++) {
        const overlayURL = this._assertAllowedSource(
          overlayQueue[index],
          "overlay",
          documentBase
        );
        if (seenOverlays.has(overlayURL)) {
          continue;
        }
        seenOverlays.add(overlayURL);

        const overlayDocument = await this.fetchOverlay(overlayURL);
        if (this._destroyed) {
          return;
        }

        for (const sheet of this._registryValues("style", overlayURL)) {
          sheets.add(this._resolveURI(sheet, overlayURL));
        }
        for (const sheet of this._collectStyles(overlayDocument, overlayURL)) {
          sheets.add(sheet);
        }

        for (const nested of this._registryValues("overlay", overlayURL)) {
          overlayQueue.push(this._resolveURI(nested, overlayURL));
        }
        overlayQueue.push(
          ...this._collectOverlays(overlayDocument, overlayURL)
        );

        for (const script of [
          ...overlayDocument.getElementsByTagNameNS("*", "script"),
        ]) {
          this.unloadedScripts.push(script);
          script.remove();
        }
        forwardReferences.push(...overlayDocument.documentElement.children);
      }

      this._resolveForwardReferences(forwardReferences);
      this._applyPersistedAttributes();

      for (const sheet of sheets) {
        if (this._destroyed) {
          return;
        }
        this.loadCSS(sheet);
      }

      for (const script of this.unloadedScripts) {
        if (this._destroyed) {
          return;
        }
        this.deferredLoad.push(...this.loadScript(script));
      }

      this._scheduleFinish();
    } finally {
      this._loading = false;
      this._maybeRemoveUnloadListener();
    }
  }

  _registryValues(kind, key) {
    const singular = this.overlayProvider[kind];
    const plural = this.overlayProvider[`${kind}s`];
    return registryValues(singular ?? plural, key);
  }

  _resolveURI(value, base) {
    if (typeof value !== "string" || !value) {
      throw new Error(`Invalid overlay URI: ${value}`);
    }
    try {
      return Services.io.newURI(
        value,
        null,
        base ? Services.io.newURI(base) : null
      ).spec;
    } catch (error) {
      throw new Error(`Malformed URI "${value}": ${error.message}`, {
        cause: error,
      });
    }
  }

  _assertAllowedSource(value, kind, base = null) {
    const url = this._resolveURI(value, base);
    const uri = Services.io.newURI(url);
    if (uri.schemeIs("http") || uri.schemeIs("https")) {
      throw new Error(`Refusing to load ${kind} from remote source ${url}`);
    }

    const extensionPackage = this.overlayProvider.package;
    if (
      typeof extensionPackage?.resolveRegisteredURI === "function" &&
      !extensionPackage.resolveRegisteredURI(url)
    ) {
      throw new Error(
        `Refusing to load ${kind} because it is not local to the overlay package: ${url}`
      );
    }
    return url;
  }

  _collectProcessingInstructions(document, target, fallbackBase) {
    const urls = [];
    for (const node of document.childNodes) {
      if (node.nodeType !== 7 || node.target !== target) {
        continue;
      }
      const href = getProcessingInstructionHref(node.data ?? node.nodeValue);
      if (href) {
        urls.push(this._resolveURI(href, node.baseURI || fallbackBase));
      }
    }
    return urls;
  }

  _collectOverlays(document, fallbackBase = document.baseURI) {
    return this._collectProcessingInstructions(
      document,
      "xul-overlay",
      fallbackBase
    );
  }

  _collectStyles(document, fallbackBase = document.baseURI) {
    return this._collectProcessingInstructions(
      document,
      "xml-stylesheet",
      fallbackBase
    );
  }

  _resolveForwardReferences(sources) {
    let unresolved = [...sources];
    let previousLength = -1;

    while (unresolved.length && unresolved.length !== previousLength) {
      previousLength = unresolved.length;
      const remaining = [];
      for (const source of unresolved) {
        if (!this._resolveForwardReference(source)) {
          remaining.push(source);
        }
      }
      unresolved = remaining;
    }

    if (unresolved.length) {
      console.warn(
        `Could not resolve ${unresolved.length} overlay references for ${this.location}`,
        unresolved
      );
    }
  }

  _resolveForwardReference(node) {
    const id = node.getAttribute("id");
    if (node.localName === "toolbarpalette") {
      const target = id ? this._findElementById(id) : null;
      return this._mergeToolbarPalette(target, node);
    }

    if (id) {
      const target = this._findElementById(id);
      if (target) {
        this._mergeElement(target, node);
        return true;
      }
      if (hasRemovalInstruction(node)) {
        return false;
      }
      if (
        node.hasAttribute("insertafter") ||
        node.hasAttribute("insertbefore") ||
        node.hasAttribute("position")
      ) {
        return Boolean(
          this._insertElement(this.document.documentElement, node, true, true)
        );
      }
      return false;
    }

    if (hasRemovalInstruction(node)) {
      const target = this._findDeleteTarget(node);
      if (target) {
        this._deleteElement(target);
      }
      return true;
    }

    this._insertElement(this.document.documentElement, node);
    return true;
  }

  _findDeleteTarget(node) {
    const className = node.getAttribute("class");
    const subcategory = node.getAttribute("data-subcategory");
    if (!className && !subcategory) {
      return null;
    }

    for (const candidate of this.document.getElementsByTagNameNS(
      node.namespaceURI || "*",
      node.localName
    )) {
      if (
        (className && candidate.getAttribute("class") === className) ||
        (subcategory &&
          candidate.getAttribute("data-subcategory") === subcategory)
      ) {
        return candidate;
      }
    }
    return null;
  }

  _deleteElement(target) {
    target?.remove();
  }

  _mergeElement(target, source) {
    if (hasRemovalInstruction(source)) {
      this._deleteElement(target);
      return;
    }
    if (source.localName === "toolbarpalette") {
      this._mergeToolbarPalette(target, source);
      return;
    }

    this._mergeAttributes(target, source);
    if (target.localName === "toolbar") {
      this._toolbarsToResolve.add(target);
    }

    const sourceContainer =
      source.localName === "template" && source.content
        ? source.content
        : source;
    const targetContainer =
      target.localName === "template" && target.content
        ? target.content
        : target;

    for (const child of [...sourceContainer.children]) {
      if (child.localName === "toolbarpalette") {
        const childTarget = child.id ? this._findElementById(child.id) : target;
        if (this._mergeToolbarPalette(childTarget ?? target, child)) {
          continue;
        }
      }

      const existing = child.id ? this._findElementById(child.id) : null;
      if (existing) {
        this._mergeElement(existing, child);
      } else if (!hasRemovalInstruction(child)) {
        this._insertElement(targetContainer, child);
      }
    }
  }

  _mergeAttributes(target, source) {
    if (!target?.setAttributeNS) {
      return;
    }
    for (const attribute of source.attributes) {
      if (
        attribute.name === "id" ||
        OVERLAY_ATTRIBUTES.has(attribute.name) ||
        attribute.namespaceURI === XMLNS_NAMESPACE
      ) {
        continue;
      }
      target.setAttributeNS(
        attribute.namespaceURI,
        attribute.name,
        attribute.value
      );
    }
  }

  _mergeToolbarPalette(target, source) {
    let palette = this._getPaletteContainer(target);
    if (!palette) {
      const template = source.id
        ? this.document.getElementById(source.id)
        : null;
      palette = this._getPaletteContainer(template);
    }
    if (!palette) {
      palette = this.window.gNavToolbox?.palette ?? null;
    }
    if (!palette) {
      return false;
    }

    if (target) {
      this._mergeAttributes(target, source);
    }
    for (const child of [...source.children]) {
      const existing = child.id ? this._findElementById(child.id) : null;
      if (existing) {
        this._mergeElement(existing, child);
      } else if (!hasRemovalInstruction(child)) {
        this._insertElement(palette, child);
      }
    }
    return true;
  }

  _getPaletteContainer(target) {
    if (!target) {
      return null;
    }
    if (target.localName === "template" && target.content) {
      return target.content;
    }
    if (target.localName === "toolbarpalette") {
      return target;
    }
    if (target.palette) {
      return target.palette;
    }
    return target.closest?.("toolbox")?.palette ?? null;
  }

  _findElementById(id) {
    const element = this.document.getElementById(id);
    if (element) {
      return element;
    }

    const roots = [];
    if (this.window.gNavToolbox?.palette) {
      roots.push(this.window.gNavToolbox.palette);
    }
    for (const template of this.document.getElementsByTagNameNS(
      "*",
      "template"
    )) {
      if (template.content) {
        roots.push(template.content);
      }
    }

    for (const root of roots) {
      if (typeof root.getElementById === "function") {
        const match = root.getElementById(id);
        if (match) {
          return match;
        }
      }
      for (const candidate of root.querySelectorAll?.("[id]") ?? []) {
        if (candidate.id === id) {
          return candidate;
        }
      }
    }
    return null;
  }

  _insertElement(
    fallbackParent,
    source,
    deferMissingPlacement = false,
    topLevel = false
  ) {
    if (hasRemovalInstruction(source)) {
      return null;
    }
    if (source.localName === "toolbarpalette") {
      return this._mergeToolbarPalette(fallbackParent, source)
        ? fallbackParent
        : null;
    }

    let parent = fallbackParent;
    let reference = null;
    let placementResolved = false;
    const after = source.getAttribute("insertafter");
    const before = source.getAttribute("insertbefore");
    const anchors = (after || before || "")
      .split(",")
      .map(id => id.trim())
      .filter(Boolean);

    for (const id of anchors) {
      const anchor = this._findElementById(id);
      if (
        anchor?.parentNode &&
        (topLevel ||
          anchor.parentNode === fallbackParent ||
          fallbackParent.contains?.(anchor.parentNode))
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

    if (!after && !before && source.hasAttribute("position")) {
      const position = Number.parseInt(source.getAttribute("position"), 10);
      if (position > 0) {
        reference = parent.children?.[position - 1] ?? null;
        placementResolved = true;
      }
    }

    const node = this.document.importNode(source, true);
    this._stripOverlayAttributes(node);
    this._restoreBeforeInsertion(node);
    parent.insertBefore(node, reference);
    this._trackToolbars(node);
    return node;
  }

  _stripOverlayAttributes(node) {
    const elements = [node, ...(node.querySelectorAll?.("*") ?? [])];
    for (const element of elements) {
      for (const attribute of OVERLAY_ATTRIBUTES) {
        element.removeAttribute(attribute);
      }
    }
  }

  _trackToolbars(node) {
    const toolbars = [];
    if (node.localName === "toolbar") {
      toolbars.push(node);
    }
    toolbars.push(...(node.querySelectorAll?.("toolbar") ?? []));

    for (const toolbar of toolbars) {
      this._toolbarsToResolve.add(toolbar);
      const customizableUI = this.window.CustomizableUI;
      if (
        toolbar.isConnected &&
        typeof customizableUI?.registerToolbarNode === "function"
      ) {
        try {
          customizableUI.registerToolbarNode(toolbar);
        } catch {}
      }
    }
  }

  _readPersistedIDs() {
    let xulStore;
    try {
      xulStore = Services.xulStore;
    } catch {
      return;
    }
    if (typeof xulStore?.getIDsEnumerator !== "function") {
      return;
    }

    this.xulStore = xulStore;
    for (const id of enumeratorValues(
      xulStore.getIDsEnumerator(this.location)
    )) {
      this.persistedIDs.add(id);
    }
  }

  _restoreBeforeInsertion(node) {
    if (!this.xulStore) {
      return;
    }

    const menulists = [];
    if (node.localName === "menulist") {
      menulists.push(node);
    }
    menulists.push(...(node.querySelectorAll?.("menulist[id]") ?? []));
    for (const menulist of menulists) {
      if (menulist.id && this.persistedIDs.has(menulist.id)) {
        menulist.setAttribute(
          "value",
          this.xulStore.getValue(this.location, menulist.id, "value")
        );
      }
    }
  }

  _applyPersistedAttributes() {
    if (!this.xulStore) {
      return;
    }

    for (const id of this.persistedIDs) {
      const element = this._findElementById(id);
      if (!element) {
        continue;
      }

      const attributes = enumeratorValues(
        this.xulStore.getAttributeEnumerator(this.location, id)
      );
      for (const name of attributes) {
        const value = this.xulStore.getValue(this.location, id, name);
        if (name === "selectedIndex" && element.localName === "deck") {
          this._decksToResolve.set(element, value);
        } else if (
          (element !== this.document.documentElement ||
            !["height", "screenX", "screenY", "sizemode", "width"].includes(
              name
            )) &&
          element.getAttribute(name) !== String(value)
        ) {
          element.setAttribute(name, value);
        }
      }
    }
  }

  _finish() {
    if (this._finished || this._destroyed) {
      return;
    }
    this._finished = true;

    for (const [deck, selectedIndex] of this._decksToResolve) {
      deck.setAttribute("selectedIndex", selectedIndex);
    }

    for (const toolbar of this._toolbarsToResolve) {
      if (!toolbar.id) {
        continue;
      }
      const currentSet =
        this.xulStore?.getValue(this.location, toolbar.id, "currentset") ||
        toolbar.getAttribute("defaultset");
      if (!currentSet) {
        continue;
      }
      try {
        if ("currentSet" in toolbar) {
          toolbar.currentSet = currentSet;
        } else {
          toolbar.setAttribute("currentset", currentSet);
        }
      } catch (error) {
        console.error(`Unable to restore toolbar ${toolbar.id}`, error);
      }
    }
  }

  _scheduleFinish() {
    const finish = () => {
      this._finish();
      this._fireDeferredLoadHandlers();
    };

    if (this.document.readyState === "complete") {
      finish();
      return;
    }

    const onLoad = () => {
      this._cleanupPendingFinish();
      finish();
      this._maybeRemoveUnloadListener();
    };
    this._pendingFinish = onLoad;
    this.window.addEventListener("load", onLoad, {
      capture: true,
      once: true,
    });

    if (this.document.readyState === "complete") {
      this._cleanupPendingFinish();
      finish();
    }
  }

  _cleanupPendingFinish() {
    if (!this._pendingFinish) {
      return;
    }
    this.window.removeEventListener("load", this._pendingFinish, true);
    this._pendingFinish = null;
  }

  _fireDeferredLoadHandlers() {
    const captures = [];
    const bubbles = [];
    for (const entry of this.deferredLoad.splice(0)) {
      (entry.useCapture ? captures : bubbles).push(entry.listener);
    }

    for (const listener of [...captures, ...bubbles]) {
      try {
        this._fireEventListener(listener);
      } catch (error) {
        console.error("Overlay load handler failed", error);
      }
    }
  }

  _fireEventListener(listener) {
    const event = new this.window.UIEvent("load", { view: this.window });
    if (typeof listener === "function") {
      listener.call(this.window, event);
    } else if (listener && typeof listener.handleEvent === "function") {
      listener.handleEvent(event);
    } else {
      throw new TypeError("Invalid overlay load listener");
    }
  }

  fetchOverlay(srcUrl) {
    const url = this._assertAllowedSource(
      srcUrl,
      "overlay",
      this.document.baseURI || this.location
    );
    this._ensureUnloadListener();

    return new Promise((resolve, reject) => {
      if (this._destroyed) {
        reject(new Error(`Window unloaded before ${url} could be loaded`));
        return;
      }

      const request = new this.window.XMLHttpRequest();
      let settled = false;
      const cleanup = () => {
        this.requests.delete(request);
        request.onload = null;
        request.onerror = null;
        request.onabort = null;
        request.ontimeout = null;
      };
      const settle = (callback, value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callback(value);
        this._maybeRemoveUnloadListener();
      };
      const cancel = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        try {
          request.abort();
        } catch {}
        try {
          request.close?.();
        } catch {}
        reject(new Error(`Window unloaded while loading overlay ${url}`));
      };
      this.requests.set(request, { cancel });

      request.onload = () => {
        try {
          if (request.responseURL) {
            this._assertAllowedSource(request.responseURL, "overlay");
          }
          if (
            request.status &&
            (request.status < 200 || request.status >= 300)
          ) {
            throw new Error(
              `Overlay request returned status ${request.status}`
            );
          }

          const document = request.responseXML;
          if (
            !document?.documentElement ||
            document.documentElement.localName === "parsererror" ||
            document.getElementsByTagNameNS("*", "parsererror").length
          ) {
            throw new Error(`Unable to parse overlay ${url}`);
          }
          settle(resolve, document);
        } catch (error) {
          settle(reject, error);
        }
      };
      request.onerror = () =>
        settle(reject, new Error(`Unable to load overlay ${url}`));
      request.onabort = () =>
        settle(reject, new Error(`Loading overlay was cancelled: ${url}`));
      request.ontimeout = () =>
        settle(reject, new Error(`Loading overlay timed out: ${url}`));

      try {
        request.overrideMimeType("application/xml");
        request.open("GET", url, true);
        if (request.channel) {
          request.channel.owner =
            Services.scriptSecurityManager.getSystemPrincipal();
        }
        request.send(null);
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  loadScript(node) {
    const deferredLoad = [];
    const interceptLoad = this.document.readyState === "complete";
    const originalAddEventListener = this.window.addEventListener;
    const originalAddEventListenerDescriptor = Object.getOwnPropertyDescriptor(
      this.window,
      "addEventListener"
    );
    let patched = false;

    if (interceptLoad) {
      try {
        this.window.addEventListener = function (
          type,
          listener,
          options,
          ...args
        ) {
          if (type === "load") {
            const useCapture =
              typeof options === "boolean"
                ? options
                : Boolean(options?.capture);
            deferredLoad.push({ listener, useCapture });
            return undefined;
          }
          return originalAddEventListener.call(
            this,
            type,
            listener,
            options,
            ...args
          );
        };
        patched = true;
      } catch {}
    }

    try {
      if (node.hasAttribute("src")) {
        const source = node.getAttribute("src");
        if (!source) {
          throw new Error("Overlay script has an empty source");
        }
        const url = this._assertAllowedSource(
          source,
          "script",
          node.baseURI || node.ownerDocument?.documentURI || this.location
        );
        Services.scriptloader.loadSubScript(url, this.window, "UTF-8");
      } else if (node.textContent) {
        const url = `data:application/javascript;charset=UTF-8,${encodeURIComponent(
          node.textContent
        )}`;
        Services.scriptloader.loadSubScript(url, this.window, "UTF-8");
      }
    } finally {
      if (patched) {
        if (originalAddEventListenerDescriptor) {
          Object.defineProperty(
            this.window,
            "addEventListener",
            originalAddEventListenerDescriptor
          );
        } else {
          delete this.window.addEventListener;
        }
      }
    }

    return deferredLoad;
  }

  loadCSS(url) {
    const sheet = this._assertAllowedSource(
      url,
      "stylesheet",
      this.document.baseURI || this.location
    );
    if (this._loadedSheets.has(sheet)) {
      return;
    }

    const windowUtils = this.window.windowUtils;
    if (typeof windowUtils?.loadSheetUsingURIString === "function") {
      windowUtils.loadSheetUsingURIString(sheet, windowUtils.AUTHOR_SHEET);
    } else if (typeof windowUtils?.loadSheet === "function") {
      windowUtils.loadSheet(
        Services.io.newURI(sheet),
        windowUtils.AUTHOR_SHEET
      );
    } else {
      throw new Error(`Unable to load stylesheet ${sheet}`);
    }
    this._loadedSheets.add(sheet);
  }

  _ensureUnloadListener() {
    if (this._listeningForUnload || this._destroyed) {
      return;
    }
    this.window.addEventListener("unload", this._onUnload, { once: true });
    this._listeningForUnload = true;
  }

  _maybeRemoveUnloadListener() {
    if (
      this._listeningForUnload &&
      !this._loading &&
      !this.requests.size &&
      !this._pendingFinish
    ) {
      this.window.removeEventListener("unload", this._onUnload);
      this._listeningForUnload = false;
    }
  }

  _destroy() {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;
    this._cleanupPendingFinish();

    if (this._listeningForUnload) {
      this.window.removeEventListener("unload", this._onUnload);
      this._listeningForUnload = false;
    }
    for (const { cancel } of [...this.requests.values()]) {
      cancel();
    }
    this.requests.clear();
    this.deferredLoad.length = 0;
  }
}
