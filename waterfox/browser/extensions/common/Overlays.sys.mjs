/**
 * Load overlays in a similar way as XUL did for legacy XUL add-ons.
 */

/* exported Overlays */
const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

/**
 * The overlays class, providing support for loading overlays like they used to work. This class
 * should likely be called through its static method Overlays.load()
 */
export class Overlays {
  /**
   * Load overlays for the given window using the overlay provider, which can for example be a
   * ChromeManifest object.
   *
   * @param {ChromeManifest} overlayProvider        The overlay provider that contains information
   *                                                  about styles and overlays.
   * @param {DOMWindow} window                      The window to load into
   */
  static load(overlayProvider, window) {
    const instance = new Overlays(overlayProvider, window);

    const urls = overlayProvider.overlay.get(instance.location, false);
    return instance.load(urls);
  }

  /**
   * Constructs the overlays instance. This class should be called via Overlays.load() instead.
   *
   * @param {ChromeManifest} overlayProvider        The overlay provider that contains information
   *                                                  about styles and overlays.
   * @param {DOMWindow} window                      The window to load into
   */
  constructor(overlayProvider, window) {
    this.overlayProvider = overlayProvider;
    this.window = window;
    if (window.location.protocol == "about:") {
      this.location = window.location.protocol + window.location.pathname;
    } else {
      this.location = window.location.origin + window.location.pathname;
    }
  }

  /**
   * A shorthand to this.window.document
   */
  get document() {
    return this.window.document;
  }

  /**
   * Loads the given urls into the window, recursively loading further overlays as provided by the
   * overlayProvider.
   *
   * @param {string[]} urls                         The urls to load
   */
  async load(urls) {
    const unloadedOverlays = new Set(
      this._collectOverlays(this.document).concat(urls)
    );
    let forwardReferences = [];
    this.unloadedScripts = [];
    const unloadedSheets = [];
    this._toolbarsToResolve = [];
    const xulStore = Services.xulStore;
    this.persistedIDs = new Set();

    // Load css styles from the registry
    for (const sheet of this.overlayProvider.style.get(this.location, false)) {
      unloadedSheets.push(sheet);
    }

    if (!unloadedOverlays.size && !unloadedSheets.length) {
      return;
    }

    for (const url of unloadedOverlays) {
      unloadedOverlays.delete(url);
      const doc = await this.fetchOverlay(url);

      console.debug(`Applying ${url} to ${this.location}`);

      // clean the document a bit
      const emptyNodes = doc.evaluate(
        "//text()[normalize-space(.) = '']",
        doc,
        null,
        7,
        null
      );
      for (let i = 0, len = emptyNodes.snapshotLength; i < len; ++i) {
        const node = emptyNodes.snapshotItem(i);
        node.remove();
      }

      const commentNodes = doc.evaluate("//comment()", doc, null, 7, null);
      for (let i = 0, len = commentNodes.snapshotLength; i < len; ++i) {
        const node = commentNodes.snapshotItem(i);
        node.remove();
      }

      // Force a re-evaluation of inline styles to work around an issue
      // causing inline styles to be initially ignored.
      const styledNodes = doc.evaluate("//*[@style]", doc, null, 7, null);
      for (let i = 0, len = styledNodes.snapshotLength; i < len; ++i) {
        const node = styledNodes.snapshotItem(i);
        node.style.display = node.style.display; // eslint-disable-line no-self-assign
      }

      // Load css styles from the registry
      for (const sheet of this.overlayProvider.style.get(url, false)) {
        unloadedSheets.push(sheet);
      }

      // Load css processing instructions from the overlay
      const stylesheets = doc.evaluate(
        "/processing-instruction('xml-stylesheet')",
        doc,
        null,
        7,
        null
      );
      for (let i = 0, len = stylesheets.snapshotLength; i < len; ++i) {
        const node = stylesheets.snapshotItem(i);
        const match = node.nodeValue.match(/href=["']([^"']*)["']/);
        if (match) {
          unloadedSheets.push(new URL(match[1], node.baseURI).href);
        }
      }

      const t_unloadedOverlays = [];
      // Prepare loading further nested xul overlays from the overlay
      t_unloadedOverlays.push(...this._collectOverlays(doc));

      // Prepare loading further nested xul overlays from the registry
      for (const overlayUrl of this.overlayProvider.overlay.get(url, false)) {
        t_unloadedOverlays.push(overlayUrl);
      }

      t_unloadedOverlays.forEach(o => unloadedOverlays.add(o));

      // Run through all overlay nodes on the first level (hookup nodes). Scripts will be deferred
      // until later for simplicity (c++ code seems to process them earlier?).
      const t_forwardReferences = [];
      for (const node of doc.documentElement.children) {
        if (node.localName == "script") {
          this.unloadedScripts.push(node);
        } else {
          t_forwardReferences.push(node);
        }
      }
      forwardReferences.unshift(...t_forwardReferences);
    }

    // We've resolved all the forward references we can, we can now go ahead and load the scripts
    this.deferredLoad = [];
    for (const script of this.unloadedScripts) {
      this.deferredLoad.push(...this.loadScript(script));
    }

    const ids = xulStore.getIDsEnumerator(this.location);
    while (ids.hasMore()) {
      this.persistedIDs.add(ids.getNext());
    }

    // At this point, all (recursive) overlays are loaded. Unloaded scripts and sheets are ready and
    // in order, and forward references are good to process.
    let previous = 0;
    while (forwardReferences.length && forwardReferences.length != previous) {
      previous = forwardReferences.length;
      const unresolved = [];

      for (const ref of forwardReferences) {
        if (!this._resolveForwardReference(ref)) {
          unresolved.push(ref);
        }
      }

      forwardReferences = unresolved;
    }

    if (forwardReferences.length) {
      console.warn(
        `Could not resolve ${forwardReferences.length} references`,
        forwardReferences
      );
    }

    // Loading the sheets now to avoid race conditions with xbl bindings
    for (const sheet of unloadedSheets) {
      this.loadCSS(sheet);
    }

    this._decksToResolve = new Map();
    for (const id of this.persistedIDs.values()) {
      const element = this.document.getElementById(id);
      if (element) {
        const attrNames = xulStore.getAttributeEnumerator(this.location, id);
        while (attrNames.hasMore()) {
          const attrName = attrNames.getNext();
          const attrValue = xulStore.getValue(this.location, id, attrName);
          if (attrName == "selectedIndex" && element.localName == "deck") {
            this._decksToResolve.set(element, attrValue);
          } else if (
            (element != this.document.documentElement ||
              !["height", "screenX", "screenY", "sizemode", "width"].includes(
                attrName
              )) &&
            element.getAttribute(attrName) != attrValue.toString()
          ) {
            element.setAttribute(attrName, attrValue);
          }
        }
      }
    }

    if (this.document.readyState == "complete") {
      lazy.setTimeout(() => {
        this._finish();

        // Now execute load handlers since we are done loading scripts
        const bubbles = [];
        for (const { listener, useCapture } of this.deferredLoad) {
          if (useCapture) {
            this._fireEventListener(listener);
          } else {
            bubbles.push(listener);
          }
        }

        for (const listener of bubbles) {
          this._fireEventListener(listener);
        }
      });
    } else {
      this.document.defaultView.addEventListener(
        "load",
        this._finish.bind(this),
        { once: true }
      );
    }
  }

  _finish() {
    for (const [deck, selectedIndex] of this._decksToResolve.entries()) {
      deck.setAttribute("selectedIndex", selectedIndex);
    }

    for (const bar of this._toolbarsToResolve) {
      const currentSet = Services.xulStore.getValue(
        this.location,
        bar.id,
        "currentset"
      );
      if (currentSet) {
        bar.currentSet = currentSet;
      } else if (bar.getAttribute("defaultset")) {
        bar.currentSet = bar.getAttribute("defaultset");
      }
    }
  }

  /**
   * Gets the overlays referenced by processing instruction on a document.
   *
   * @param {DOMDocument} document  The document to read instructions from
   * @returns {string[]}             URLs of the overlays from the document
   */
  _collectOverlays(doc) {
    const urls = [];
    const instructions = doc.evaluate(
      "/processing-instruction('xul-overlay')",
      doc,
      null,
      7,
      null
    );
    for (let i = 0, len = instructions.snapshotLength; i < len; ++i) {
      const node = instructions.snapshotItem(i);
      const match = node.nodeValue.match(/href=["']([^"']*)["']/);
      if (match) {
        urls.push(match[1]);
      }
    }
    return urls;
  }

  /**
   * Fires a "load" event for the given listener, using the current window
   *
   * @param {EventListener|Function} listener       The event listener to call
   */
  _fireEventListener(listener) {
    const fakeEvent = new this.window.UIEvent("load", { view: this.window });
    if (typeof listener == "function") {
      listener(fakeEvent);
    } else if (listener && typeof listener == "object") {
      listener.handleEvent(fakeEvent);
    } else {
      console.error("Unknown listener type", listener);
    }
  }

  /**
   * Resolves forward references for the given node. If the node exists in the target document, it
   * is merged in with the target node. If the node has no id it is inserted at documentElement
   * level.
   *
   * @param {Element} node          The DOM Element to resolve in the target document.
   * @returns {boolean}              True, if the node was merged/inserted, false otherwise
   */
  _resolveForwardReference(node) {
    if (node.id) {
      const target = this.document.getElementById(node.id);
      // if (node.localName == "template") {
      //   this._insertElement(this.document.documentElement, node);
      //   return true;
      // } else
      if (node.localName == "toolbarpalette") {
        console.error("toolbarpalette is unsupported type", node.id);
        return false;
      } else if (!target) {
        if (
          node.hasAttribute("insertafter") ||
          node.hasAttribute("insertbefore")
        ) {
          this._insertElement(this.document.documentElement, node);
          return true;
        }
        console.debug(
          `The node ${node.id} could not be found, deferring to later`
        );
        return false;
      }

      // Delete existing element if requested
      if (node.hasAttribute("delete")) {
        this._deleteElement(target);
      } else {
        this._mergeElement(target, node);
      }
    } else if (node.className) {
      const target = this.document.querySelector(
        `${node.nodeName}[class='${node.getAttribute("class")}']`
      );
      if (node.hasAttribute("delete")) {
        this._deleteElement(target);
      }
    } else if (node.getAttribute("data-subcategory")) {
      // This is for removing items in about:preferences#home
      const target = this.document.querySelector(
        `${node.nodeName}[data-subcategory='${node.getAttribute(
          "data-subcategory"
        )}']`
      );
      if (node.hasAttribute("delete")) {
        this._deleteElement(target);
      }
    } else {
      this._insertElement(this.document.documentElement, node);
    }
    return true;
  }

  /**
   * Delete the target node.
   *
   * @param {Element} target     The node to delete.
   */
  _deleteElement(target) {
    if (target) {
      target.remove();
    }
  }

  /**
   * Insert the node in the given parent, observing the insertbefore/insertafter/position attributes
   *
   * @param {Element} parent        The parent element to insert the node into.
   * @param {Element} node          The node to insert.
   */
  _insertElement(parent, node) {
    // These elements need their values set before they are added to
    // the document, or bad things happen.
    for (const element of node.querySelectorAll("menulist")) {
      if (element.id && this.persistedIDs.has(element.id)) {
        element.setAttribute(
          "value",
          Services.xulStore.getValue(this.location, element.id, "value")
        );
      }
    }

    if (node.localName == "toolbar") {
      this._toolbarsToResolve.push(node);
    } else {
      this._toolbarsToResolve.push(...node.querySelectorAll("toolbar"));
    }

    const nodes = node.querySelectorAll("script");
    for (const script of nodes) {
      this.deferredLoad.push(...this.loadScript(script));
    }

    let wasInserted = false;
    let pos = node.getAttribute("insertafter");
    let after = true;

    if (!pos) {
      pos = node.getAttribute("insertbefore");
      after = false;
    }

    if (pos) {
      for (const id of pos.split(",")) {
        const targetChild = this.document.getElementById(id);
        if (targetChild && parent.contains(targetChild.parentNode)) {
          targetChild.parentNode.insertBefore(
            node,
            after ? targetChild.nextElementSibling : targetChild
          );
          wasInserted = true;
          break;
        }
      }
    }

    if (!wasInserted) {
      // position is 1-based
      const position = parseInt(node.getAttribute("position"), 10);
      if (position > 0 && position - 1 <= parent.children.length) {
        parent.insertBefore(node, parent.children[position - 1]);
        wasInserted = true;
      }
    }

    if (!wasInserted) {
      parent.appendChild(node);
    }
  }

  /**
   * Merge the node into the target, adhering to the removeelement attribute, merging further
   * attributes into the target node, and merging children as appropriate for xul nodes. If a child
   * has an id, it will be searched in the target document and recursively merged.
   *
   * @param {Element} target        The node to merge into
   * @param {Element} node          The node that is being merged
   * @param {bool}    shadow        If the target node is in the shadow DOM
   */
  _mergeElement(target, node, shadow = false) {
    for (const attribute of node.attributes) {
      if (attribute.name !== "id") {
        if (attribute.name == "removeelement" && attribute.value == "true") {
          target.remove();
          return;
        }

        target.setAttributeNS(
          attribute.namespaceURI,
          attribute.name,
          attribute.value
        );
      }
    }

    for (const nodes of node.children) {
      if (nodes.localName == "script") {
        this.deferredLoad.push(...this.loadScript(nodes));
      }
    }

    // Get the DocumentFragment
    if (node.localName === "template") {
      node = node.content;
    }

    for (let i = 0, len = node.childElementCount; i < len; i++) {
      const child = node.firstElementChild;
      child.remove();

      let elementInDocument = child.id
        ? this.document.getElementById(child.id)
        : null;
      const parentId = elementInDocument
        ? elementInDocument.parentNode.id
        : null;

      // Strictly to working with shadow DOM elements
      if (target.content) {
        elementInDocument = target.content.children.namedItem(child.id);
      } else if (shadow && target.children.length === 1) {
        // This condition is very specific to adding appMenu items, if we need another
        // use case we will have to re-visit
        elementInDocument = target.children[0];
      }

      // Need an else if nodeName is doc fragment
      if (parentId && parentId == target.id) {
        this._mergeElement(elementInDocument, child);
      } else if (
        elementInDocument &&
        (elementInDocument.parentNode.nodeName === "#document-fragment" ||
          shadow)
      ) {
        // Merging for shadow DOM elements, as getElementById does not work
        this._mergeElement(elementInDocument, child, true);
      } else {
        this._insertElement(target, child);
      }
    }
  }

  /**
   * Fetches the overlay from the given chrome:// or resource:// URL.
   *
   * @param {string} srcUrl          The URL to load
   * @returns {Promise<XMLDocument>}  Returns a promise that is resolved with the XML document.
   */
  fetchOverlay(srcUrl) {
    if (!srcUrl.startsWith("chrome://") && !srcUrl.startsWith("resource://")) {
      throw new Error(
        "May only load overlays from chrome:// or resource:// uris"
      );
    }

    return new Promise((resolve, reject) => {
      const xhr = new this.window.XMLHttpRequest();
      xhr.overrideMimeType("application/xml");
      xhr.open("GET", srcUrl, true);

      // Elevate the request, so DTDs will work. Should not be a security issue since we
      // only load chrome, resource and file URLs, and that is our privileged chrome package.
      try {
        xhr.channel.owner = Services.scriptSecurityManager.getSystemPrincipal();
      } catch (ex) {
        console.error(
          `Failed to set system principal while fetching overlay ${srcUrl}`
        );
        xhr.close();
        reject("Failed to set system principal");
      }

      xhr.onload = () => resolve(xhr.responseXML);
      xhr.onerror = () =>
        reject(`Failed to load ${srcUrl} to ${this.location}`);
      xhr.send(null);
    });
  }

  /**
   * Loads scripts described by the given script node. The node can either have a src attribute, or
   * be an inline script with textContent.
   *
   * @param {Element} node                          The <script> element to load the script from
   * @returns {object[]}                             An object with listener and useCapture,
   *                                                  describing load handlers the script creates
   *                                                  when first run.
   */
  loadScript(node) {
    const deferredLoad = [];

    const oldAddEventListener = this.window.addEventListener;
    if (this.document.readyState == "complete") {
      this.window.addEventListener = function (
        type,
        listener,
        useCapture,
        ...args
      ) {
        if (type == "load") {
          if (typeof useCapture == "object") {
            useCapture = useCapture.capture;
          }

          if (typeof useCapture == "undefined") {
            useCapture = true;
          }
          deferredLoad.push({ listener, useCapture });
          return null;
        }
        return oldAddEventListener.call(
          this,
          type,
          listener,
          useCapture,
          ...args
        );
      };
    }

    if (node.hasAttribute("src")) {
      const url = new URL(node.getAttribute("src"), node.baseURI).href;
      console.debug(`Loading script ${url} into ${this.window.location}`);
      try {
        Services.scriptloader.loadSubScript(url, this.window);
      } catch (ex) {
        console.error(ex);
      }
    } else if (node.textContent) {
      console.debug(`Loading eval'd script into ${this.window.location}`);
      try {
        const dataURL =
          "data:application/javascript," + encodeURIComponent(node.textContent);
        // It would be great if we could have script errors show the right url, but for now
        // loadSubScript will have to do.
        Services.scriptloader.loadSubScript(dataURL, this.window);
      } catch (ex) {
        console.error(ex);
      }
    }

    if (this.document.readyState == "complete") {
      this.window.addEventListener = oldAddEventListener;
    }

    // This works because we only care about immediately executed addEventListener calls and
    // loadSubScript is synchronous. Everyone else should be checking readyState anyway.
    return deferredLoad;
  }

  /**
   * Load the CSS stylesheet from the given url
   *
   * @param {string} url        The url to load from
   * @returns {Element}          An HTML link element for this stylesheet
   */
  loadCSS(url) {
    console.debug(`Loading ${url} into ${this.window.location}`);

    const winUtils = this.window.windowUtils;
    winUtils.loadSheetUsingURIString(url, winUtils.AUTHOR_SHEET);
  }
}
