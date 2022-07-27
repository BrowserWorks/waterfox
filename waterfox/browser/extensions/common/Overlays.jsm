/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Load overlays in a similar way as XUL did for legacy XUL add-ons.
 */

"use strict";

this.EXPORTED_SYMBOLS = ["Overlays"];

const { ConsoleAPI } = ChromeUtils.import("resource://gre/modules/Console.jsm");
ChromeUtils.defineModuleGetter(
  this,
  "Services",
  "resource://gre/modules/Services.jsm"
);
ChromeUtils.defineModuleGetter(
  this,
  "setTimeout",
  "resource://gre/modules/Timer.jsm"
);

let oconsole = new ConsoleAPI({
  prefix: "Overlays.jsm",
  consoleID: "overlays-jsm",
  maxLogLevelPref: "extensions.overlayloader.loglevel",
});

/**
 * The overlays class, providing support for loading overlays like they used to work. This class
 * should likely be called through its static method Overlays.load()
 */
class Overlays {
  /**
   * Load overlays for the given window using the overlay provider, which can for example be a
   * ChromeManifest object.
   *
   * @param {ChromeManifest} overlayProvider        The overlay provider that contains information
   *                                                  about styles and overlays.
   * @param {DOMWindow} window                      The window to load into
   */
  static load(overlayProvider, window) {
    let instance = new Overlays(overlayProvider, window);

    let urls = overlayProvider.overlay.get(instance.location, false);
    instance.load(urls);
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
  load(urls) {
    let unloadedOverlays = this._collectOverlays(this.document).concat(urls);
    let forwardReferences = [];
    let unloadedScripts = [];
    let unloadedSheets = [];
    this._toolbarsToResolve = [];
    let xulStore = Services.xulStore;
    this.persistedIDs = new Set();

    // Load css styles from the registry
    for (let sheet of this.overlayProvider.style.get(this.location, false)) {
      unloadedSheets.push(sheet);
    }

    if (!unloadedOverlays.length && !unloadedSheets.length) {
      return;
    }

    while (unloadedOverlays.length) {
      let url = unloadedOverlays.shift();
      let xhr = this.fetchOverlay(url);
      let doc = xhr.responseXML;

      oconsole.debug(`Applying ${url} to ${this.location}`);

      // clean the document a bit
      let emptyNodes = doc.evaluate(
        "//text()[normalize-space(.) = '']",
        doc,
        null,
        7,
        null
      );
      for (let i = 0, len = emptyNodes.snapshotLength; i < len; ++i) {
        let node = emptyNodes.snapshotItem(i);
        node.remove();
      }

      let commentNodes = doc.evaluate("//comment()", doc, null, 7, null);
      for (let i = 0, len = commentNodes.snapshotLength; i < len; ++i) {
        let node = commentNodes.snapshotItem(i);
        node.remove();
      }

      // Load css styles from the registry
      for (let sheet of this.overlayProvider.style.get(url, false)) {
        unloadedSheets.push(sheet);
      }

      // Load css processing instructions from the overlay
      let stylesheets = doc.evaluate(
        "/processing-instruction('xml-stylesheet')",
        doc,
        null,
        7,
        null
      );
      for (let i = 0, len = stylesheets.snapshotLength; i < len; ++i) {
        let node = stylesheets.snapshotItem(i);
        let match = node.nodeValue.match(/href=["']([^"']*)["']/);
        if (match) {
          unloadedSheets.push(new URL(match[1], node.baseURI).href);
        }
      }

      // Prepare loading further nested xul overlays from the overlay
      unloadedOverlays.push(...this._collectOverlays(doc));

      // Prepare loading further nested xul overlays from the registry
      for (let overlayUrl of this.overlayProvider.overlay.get(url, false)) {
        unloadedOverlays.push(overlayUrl);
      }

      // Run through all overlay nodes on the first level (hookup nodes). Scripts will be deferred
      // until later for simplicity (c++ code seems to process them earlier?).
      for (let node of doc.documentElement.children) {
        if (node.localName == "script") {
          unloadedScripts.push(node);
        } else {
          forwardReferences.push(node);
        }
      }
    }

    let ids = xulStore.getIDsEnumerator(this.location);
    while (ids.hasMore()) {
      this.persistedIDs.add(ids.getNext());
    }

    // At this point, all (recursive) overlays are loaded. Unloaded scripts and sheets are ready and
    // in order, and forward references are good to process.
    let previous = 0;
    while (forwardReferences.length && forwardReferences.length != previous) {
      previous = forwardReferences.length;
      let unresolved = [];

      for (let ref of forwardReferences) {
        if (!this._resolveForwardReference(ref)) {
          unresolved.push(ref);
        }
      }

      forwardReferences = unresolved;
    }

    if (forwardReferences.length) {
      oconsole.warn(
        `Could not resolve ${forwardReferences.length} references`,
        forwardReferences
      );
    }

    // Loading the sheets now to avoid race conditions with xbl bindings
    for (let sheet of unloadedSheets) {
      this.loadCSS(sheet);
    }

    this._decksToResolve = new Map();
    for (let id of this.persistedIDs.values()) {
      let element = this.document.getElementById(id);
      if (element) {
        let attrNames = xulStore.getAttributeEnumerator(this.location, id);
        while (attrNames.hasMore()) {
          let attrName = attrNames.getNext();
          let attrValue = xulStore.getValue(this.location, id, attrName);
          if (attrName == "selectedIndex" && element.localName == "deck") {
            this._decksToResolve.set(element, attrValue);
          } else {
            element.setAttribute(attrName, attrValue);
          }
        }
      }
    }

    // We've resolved all the forward references we can, we can now go ahead and load the scripts
    let deferredLoad = [];
    for (let script of unloadedScripts) {
      deferredLoad.push(...this.loadScript(script));
    }

    if (this.document.readyState == "complete") {
      let sheet;
      let overlayTrigger = this.document.createXULElement("overlayTrigger");
      overlayTrigger.addEventListener(
        "bindingattached",
        () => {
          oconsole.debug("XBL binding attached, continuing with load");
          if (sheet) {
            sheet.remove();
          }
          overlayTrigger.remove();

          setTimeout(() => {
            this._finish();

            // Now execute load handlers since we are done loading scripts
            let bubbles = [];
            for (let { listener, useCapture } of deferredLoad) {
              if (useCapture) {
                this._fireEventListener(listener);
              } else {
                bubbles.push(listener);
              }
            }

            for (let listener of bubbles) {
              this._fireEventListener(listener);
            }
          }, 0);
        },
        { once: true }
      );
      this.document.documentElement.appendChild(overlayTrigger);
      if (overlayTrigger.parentNode) {
        sheet = this.loadCSS("chrome://messenger/content/overlayBindings.css");
      }
    } else {
      this.document.defaultView.addEventListener(
        "load",
        this._finish.bind(this),
        { once: true }
      );
    }
  }

  _finish() {
    for (let [deck, selectedIndex] of this._decksToResolve.entries()) {
      deck.setAttribute("selectedIndex", selectedIndex);
    }

    for (let bar of this._toolbarsToResolve) {
      let currentset = Services.xulStore.getValue(
        this.location,
        bar.id,
        "currentset"
      );
      if (currentset) {
        bar.currentSet = currentset;
      } else if (bar.getAttribute("defaultset")) {
        bar.currentSet = bar.getAttribute("defaultset");
      }
    }
  }

  /**
   * Gets the overlays referenced by processing instruction on a document.
   *
   * @param {DOMDocument} document  The document to read instuctions from
   * @returns {string[]}             URLs of the overlays from the document
   */
  _collectOverlays(doc) {
    let urls = [];
    let instructions = doc.evaluate(
      "/processing-instruction('xul-overlay')",
      doc,
      null,
      7,
      null
    );
    for (let i = 0, len = instructions.snapshotLength; i < len; ++i) {
      let node = instructions.snapshotItem(i);
      let match = node.nodeValue.match(/href=["']([^"']*)["']/);
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
    let fakeEvent = new this.window.UIEvent("load", { view: this.window });
    if (typeof listener == "function") {
      listener(fakeEvent);
    } else if (listener && typeof listener == "object") {
      listener.handleEvent(fakeEvent);
    } else {
      oconsole.error("Unknown listener type", listener);
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
      let target = this.document.getElementById(node.id);
      if (node.localName == "toolbarpalette") {
        let box;
        if (target) {
          box = target.closest("toolbox");
        } else {
          // These vanish from the document but still exist via the palette property
          let boxes = [...this.document.getElementsByTagName("toolbox")];
          box = boxes.find(box => box.palette && box.palette.id == node.id);
          let palette = box ? box.palette : null;

          if (!palette) {
            oconsole.debug(
              `The palette for ${node.id} could not be found, deferring to later`
            );
            return false;
          }

          target = palette;
        }

        this._toolbarsToResolve.push(
          ...box.querySelectorAll('toolbar:not([type="menubar"])')
        );
      } else if (!target) {
        oconsole.debug(
          `The node ${node.id} could not be found, deferring to later`
        );
        return false;
      }

      this._mergeElement(target, node);
    } else {
      this._insertElement(this.document.documentElement, node);
    }
    return true;
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
    for (let element of node.querySelectorAll("menulist, radiogroup")) {
      if (element.id && this.persistedIDs.has(element.id)) {
        element.setAttribute(
          "value",
          Services.xulStore.getValue(this.location, element.id, "value")
        );
      }
    }

    let wasInserted = false;
    let pos = node.getAttribute("insertafter");
    let after = true;

    if (!pos) {
      pos = node.getAttribute("insertbefore");
      after = false;
    }

    if (pos) {
      for (let id of pos.split(",")) {
        let targetchild = this.document.getElementById(id);
        if (targetchild && targetchild.parentNode == parent) {
          parent.insertBefore(
            node,
            after ? targetchild.nextSibling : targetchild
          );
          wasInserted = true;
          break;
        }
      }
    }

    if (!wasInserted) {
      // position is 1-based
      let position = parseInt(node.getAttribute("position"), 10);
      if (position > 0 && position - 1 <= parent.childNodes.length) {
        parent.insertBefore(node, parent.childNodes[position - 1]);
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
   */
  _mergeElement(target, node) {
    for (let attribute of node.attributes) {
      if (attribute.name == "id") {
        continue;
      }

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

    for (let i = 0, len = node.childElementCount; i < len; i++) {
      let child = node.firstElementChild;
      child.remove();

      let elementInDocument = child.id
        ? this.document.getElementById(child.id)
        : null;
      let parentId = elementInDocument ? elementInDocument.parentNode.id : null;

      if (parentId && parentId == target.id) {
        this._mergeElement(elementInDocument, child);
      } else {
        this._insertElement(target, child);
      }
    }
  }

  /**
   * Fetches the overlay from the given chrome:// or resource:// URL. This happen synchronously so
   * we have a chance to complete before the load event.
   *
   * @param {string} srcUrl                         The URL to load
   * @returns {XMLHttpRequest}                       The completed XHR.
   */
  fetchOverlay(srcUrl) {
    if (!srcUrl.startsWith("chrome://") && !srcUrl.startsWith("resource://")) {
      throw new Error(
        "May only load overlays from chrome:// or resource:// uris"
      );
    }

    let xhr = new XMLHttpRequest();
    xhr.overrideMimeType("application/xml");
    xhr.open("GET", srcUrl, false);

    // Elevate the request, so DTDs will work. Should not be a security issue since we
    // only load chrome, resource and file URLs, and that is our privileged chrome package.
    try {
      xhr.channel.owner = Services.scriptSecurityManager.getSystemPrincipal();
    } catch (ex) {
      oconsole.error(
        "Failed to set system principal while fetching overlay " + srcUrl
      );
      xhr.close();
      throw new Error("Failed to set system principal");
    }

    xhr.send(null);
    return xhr;
  }

  /**
   * Loads scripts described by the given script node. The node can either have a src attribute, or
   * be an inline script with textContent.
   *
   * @param {Element} node                          The <script> element to load the script from
   * @returns {Object[]}                             An object with listener and useCapture,
   *                                                  describing load handlers the script creates
   *                                                  when first run.
   */
  loadScript(node) {
    let deferredLoad = [];

    let oldAddEventListener = this.window.addEventListener;
    if (this.document.readyState == "complete") {
      this.window.addEventListener = function(
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
      let url = new URL(node.getAttribute("src"), node.baseURI).href;
      oconsole.debug(`Loading script ${url} into ${this.window.location}`);
      try {
        Services.scriptloader.loadSubScript(url, this.window);
      } catch (ex) {
        Cu.reportError(ex);
      }
    } else if (node.textContent) {
      oconsole.debug(`Loading eval'd script into ${this.window.location}`);
      try {
        let dataURL =
          "data:application/javascript," + encodeURIComponent(node.textContent);
        // It would be great if we could have script errors show the right url, but for now
        // loadSubScript will have to do.
        Services.scriptloader.loadSubScript(dataURL, this.window);
      } catch (ex) {
        Cu.reportError(ex);
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
    oconsole.debug(`Loading ${url} into ${this.window.location}`);

    // domWindowUtils.loadSheetUsingURIString doesn't record the sheet in document.styleSheets,
    // adding a html link element seems to do so.
    let link = this.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "link"
    );
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("type", "text/css");
    link.setAttribute("href", url);

    this.document.documentElement.appendChild(link);
    return link;
  }
}
