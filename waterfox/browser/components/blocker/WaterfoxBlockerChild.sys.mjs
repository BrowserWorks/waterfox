/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const COSMETIC_STYLE_ID = "waterfox-blocker-cosmetic-style";
const INITIAL_RESOURCES_RETRY_DELAY_MS = 1000;
const MAX_PROCEDURAL_ACTIONS = 250;
const MAX_PROCEDURAL_CANDIDATES = 2000;
const MAX_QUERIED_TOKENS = 50000;
const MAX_MUTATION_DELTA_CLASSES = 500;
const MAX_MUTATION_DELTA_IDS = 500;
const MAX_COSMETIC_SELECTORS = 10000;
const PROCEDURAL_ACTION_DELAY_MS = 250;

/**
 * JSWindowActor child for blocker behaviour in content processes. Receives
 * cosmetic resources from the parent actor, applies selectors to the
 * document, and injects scriptlets into page scope.
 */
export class WaterfoxBlockerChild extends JSWindowActorChild {
  /**
   * @param {object} message
   * @param {string} message.name
   * @param {object} [message.data]
   * @returns {object|undefined}
   */
  receiveMessage(message) {
    try {
      switch (message.name) {
        case "WaterfoxBlocker:ApplyCosmeticSelectors":
          return this._applyCosmeticSelectors(message.data?.selectors || []);

        case "WaterfoxBlocker:ClearCosmeticSelectors":
          this._clearCosmeticSelectors();
          return { ok: true };

        case "WaterfoxBlocker:CollectClassIdSnapshot":
          return this._collectClassIdSnapshot(message.data || {});

        default:
          return undefined;
      }
    } catch (err) {
      console.error("[WaterfoxBlockerChild] receiveMessage failed:", err);
      return { error: String(err), ok: false };
    }
  }

  handleEvent(event) {
    if (event.type === "DOMWindowCreated") {
      this._initializeForCurrentDocument("DOMWindowCreated");
      return;
    }

    if (event.type === "DOMDocElementInserted") {
      this._flushInitialResources();
      this._initializeForCurrentDocument("DOMDocElementInserted");
    }
  }

  _initializeForCurrentDocument(eventName) {
    let doc;
    try {
      doc = this.document;
    } catch (_) {
      // The actor may already be detached from its document.
      return;
    }

    if (
      !doc ||
      this._initializedDocument === doc ||
      this._initializingDocument === doc
    ) {
      return;
    }

    const documentURI = this._getDocumentURI(doc);
    this._initializingDocument = doc;
    this._onDOMWindowCreated()
      .then(() => {
        try {
          if (
            this.document === doc &&
            this._getDocumentURI(doc) === documentURI
          ) {
            this._initializedDocument = doc;
          }
        } catch (_) {
          // The document can disappear while async initialisation finishes.
        }
      })
      .catch(err => {
        console.error(
          `[WaterfoxBlockerChild] ${eventName} initialization failed:`,
          err
        );
      })
      .finally(() => {
        if (this._initializingDocument === doc) {
          this._initializingDocument = null;
        }
      });
  }

  async _onDOMWindowCreated() {
    const doc = this.document;
    if (!doc) {
      return;
    }

    const documentURI = this._getDocumentURI(doc);
    this._teardownGenericHideObserver();
    this._teardownProceduralActionObserver();
    this._clearResourceRetryTimeout();
    this._appliedGenericSelectors = new Set();
    this._queriedClasses = new Set();
    this._queriedIds = new Set();
    this._pendingInitialResources = null;
    this._pendingInitialResourcesURI = null;
    this._cosmeticExceptions = [];
    this._proceduralActions = [];
    this._retriedResources = false;

    let enabled;
    try {
      enabled = await this.sendQuery("WaterfoxBlocker:IsEnabled");
    } catch (_) {
      // Actor shutdown can reject pending parent queries.
      return;
    }

    if (this.document !== doc || !this._isCurrentDocumentURI(documentURI)) {
      return;
    }

    if (!enabled) {
      return;
    }

    let url;
    try {
      url = doc.documentURI || doc.location?.href;
    } catch (err) {
      console.error("[WaterfoxBlockerChild] failed to get URL:", err);
      return;
    }

    // Non-HTML documents can render injected <style> contents as visible text.
    if (doc.contentType !== "text/html") {
      return;
    }

    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      return;
    }

    let resources;
    try {
      resources = await this.sendQuery("WaterfoxBlocker:GetCosmeticResources", {
        url,
      });
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] sendQuery(GetCosmeticResources) failed:",
        err
      );
      return;
    }

    if (this.document !== doc || !this._isCurrentDocumentURI(documentURI)) {
      return;
    }

    if (!resources) {
      return;
    }

    this._pendingInitialResources = resources;
    this._pendingInitialResourcesURI = documentURI;
    this._flushInitialResources();

    if (this._isInitialResourcesResponseEmpty(resources)) {
      this._scheduleInitialResourcesRetry(doc);
    }
  }

  didDestroy() {
    this._teardownGenericHideObserver();
    this._teardownProceduralActionObserver();
    this._clearResourceRetryTimeout();
    this._appliedGenericSelectors = null;
    this._queriedClasses = null;
    this._queriedIds = null;
    this._pendingInitialResources = null;
    this._pendingInitialResourcesURI = null;
    this._proceduralActions = null;
    this._initializedDocument = null;
    this._initializingDocument = null;
    this._retriedResources = false;

    try {
      this._clearCosmeticSelectors();
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] failed clearing cosmetic selectors during destroy:",
        err
      );
    }
  }

  _getDocumentURI(doc) {
    try {
      return doc?.documentURI || "";
    } catch (_) {
      // Some document getters throw during teardown.
      return "";
    }
  }

  _isCurrentDocumentURI(documentURI) {
    try {
      return this.document?.documentURI === documentURI;
    } catch (_) {
      // The actor may already be detached from its document.
      return false;
    }
  }

  _isInitialResourcesResponseEmpty(resources) {
    if (!resources || typeof resources !== "object") {
      return true;
    }

    const hasHideSelectors =
      Array.isArray(resources.hideSelectors) && resources.hideSelectors.length;
    const hasProceduralActions =
      Array.isArray(resources.proceduralActions) &&
      resources.proceduralActions.length;
    const hasInjectedScript =
      typeof resources.injectedScript === "string"
        ? !!resources.injectedScript.trim()
        : !!resources.injectedScript;

    return !hasHideSelectors && !hasInjectedScript && !hasProceduralActions;
  }

  _clearResourceRetryTimeout() {
    if (!this._resourceRetryTimeout) {
      return;
    }

    try {
      this.contentWindow?.clearTimeout(this._resourceRetryTimeout);
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] failed to clear resource retry timeout:",
        err
      );
    }

    this._resourceRetryTimeout = null;
  }

  _scheduleInitialResourcesRetry(targetDocument) {
    if (this._retriedResources || !targetDocument) {
      return;
    }

    const timeoutId = this.contentWindow?.setTimeout(() => {
      this._resourceRetryTimeout = null;
      this._retryInitialResources(targetDocument).catch(err => {
        console.error(
          "[WaterfoxBlockerChild] delayed cosmetic resources retry failed:",
          err
        );
      });
    }, INITIAL_RESOURCES_RETRY_DELAY_MS);

    if (timeoutId === undefined || timeoutId === null) {
      return;
    }

    this._retriedResources = true;
    this._resourceRetryTimeout = timeoutId;
  }

  async _retryInitialResources(targetDocument) {
    const doc = this.document;
    if (!doc || doc !== targetDocument) {
      return;
    }

    const documentURI = this._getDocumentURI(doc);
    let url;
    try {
      url = doc.documentURI || doc.location?.href || "";
    } catch (_) {
      // Document URL access can fail during navigation teardown.
      return;
    }

    if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
      return;
    }

    if (this._getDocumentURI(targetDocument) !== documentURI) {
      return;
    }

    let resources;
    try {
      resources = await this.sendQuery("WaterfoxBlocker:GetCosmeticResources", {
        url,
      });
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] delayed sendQuery(GetCosmeticResources) failed:",
        err
      );
      return;
    }

    if (
      !this._isCurrentDocumentURI(documentURI) ||
      this.document !== targetDocument
    ) {
      return;
    }

    if (!resources) {
      return;
    }

    this._pendingInitialResources = resources;
    this._pendingInitialResourcesURI = documentURI;
    this._flushInitialResources();
  }

  _flushInitialResources() {
    const resources = this._pendingInitialResources;
    if (!resources) {
      return;
    }

    const pendingURI = this._pendingInitialResourcesURI;
    const doc = this.document;
    if (!doc || !this._hasInjectionTarget(doc)) {
      return;
    }

    if (pendingURI && this._getDocumentURI(doc) !== pendingURI) {
      this._pendingInitialResources = null;
      this._pendingInitialResourcesURI = null;
      return;
    }

    this._pendingInitialResources = null;
    this._pendingInitialResourcesURI = null;

    const allSelectors = [];
    if (
      Array.isArray(resources.hideSelectors) &&
      resources.hideSelectors.length
    ) {
      allSelectors.push(...resources.hideSelectors);
    }

    if (allSelectors.length) {
      this._applyCosmeticSelectors(allSelectors);
    }

    if (resources.injectedScript) {
      this._injectScriptlet(resources.injectedScript);
    }

    if (Array.isArray(resources.proceduralActions)) {
      this._setupProceduralActions(resources.proceduralActions);
    }

    if (!resources.generichide) {
      this._setupGenericHideObserver(resources.exceptions || []);
    }
  }

  _hasInjectionTarget(doc) {
    return !!(doc.head || doc.documentElement || doc.body);
  }

  _setupProceduralActions(actions) {
    const doc = this.document;
    const contentWin = this.contentWindow;
    if (!doc || !contentWin) {
      return;
    }

    this._teardownProceduralActionObserver();

    this._proceduralActions = this._normalizeProceduralActions(actions);
    if (!this._proceduralActions.length) {
      return;
    }

    this._applyProceduralActions();

    this._proceduralObserver = new contentWin.MutationObserver(() => {
      if (this._applyingProceduralActions || this._proceduralMutationTimeout) {
        return;
      }

      this._proceduralMutationTimeout = contentWin.setTimeout(() => {
        this._proceduralMutationTimeout = null;
        this._applyProceduralActions();
      }, PROCEDURAL_ACTION_DELAY_MS);
    });

    this._proceduralObserver.observe(doc.documentElement || doc, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
  }

  _normalizeProceduralActions(actions) {
    if (!Array.isArray(actions)) {
      return [];
    }

    const out = [];
    const seen = new Set();

    for (const rawAction of actions) {
      let action = rawAction;
      try {
        if (typeof rawAction === "string") {
          action = JSON.parse(rawAction);
        }
      } catch (_) {
        // Ignore malformed procedural action payloads.
        continue;
      }

      if (!action || !Array.isArray(action.selector)) {
        continue;
      }

      const key = JSON.stringify(action);
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      out.push(action);

      if (out.length >= MAX_PROCEDURAL_ACTIONS) {
        break;
      }
    }

    return out;
  }

  _applyProceduralActions() {
    const doc = this.document;
    if (!doc || !this._proceduralActions?.length) {
      return;
    }

    this._applyingProceduralActions = true;
    try {
      for (const action of this._proceduralActions) {
        const elements = this._evaluateProceduralSelector(
          action.selector || []
        );
        for (const element of elements) {
          this._applyProceduralAction(element, action.action || null);
        }
      }
      this._proceduralObserver?.takeRecords();
    } finally {
      this._applyingProceduralActions = false;
    }
  }

  _evaluateProceduralSelector(operators) {
    const doc = this.document;
    if (!doc || !Array.isArray(operators) || !operators.length) {
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
          candidates = this._queryProceduralSelector(candidates, arg);
          break;
        case "has-text":
          candidates = this._filterProceduralCandidates(candidates, element =>
            this._matchesProceduralPattern(element.textContent || "", arg)
          );
          break;
        case "matches-attr":
          candidates = this._filterProceduralCandidates(candidates, element =>
            this._matchesProceduralAttr(element, arg)
          );
          break;
        case "matches-css":
          candidates = this._filterProceduralCandidates(candidates, element =>
            this._matchesProceduralStyle(element, arg)
          );
          break;
        case "matches-css-before":
          candidates = this._filterProceduralCandidates(candidates, element =>
            this._matchesProceduralStyle(element, arg, "::before")
          );
          break;
        case "matches-css-after":
          candidates = this._filterProceduralCandidates(candidates, element =>
            this._matchesProceduralStyle(element, arg, "::after")
          );
          break;
        case "matches-path":
          candidates = this._matchesProceduralPath(arg) ? candidates : [];
          break;
        case "min-text-length":
          candidates = this._filterProceduralCandidates(candidates, element => {
            const minLength = Number.parseInt(arg, 10);
            return (
              Number.isFinite(minLength) &&
              (element.textContent || "").length >= minLength
            );
          });
          break;
        case "upward":
          candidates = this._applyProceduralUpward(candidates, arg);
          break;
        case "xpath":
          candidates = this._evaluateProceduralXPath(candidates, arg);
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

  _queryProceduralSelector(candidates, selector) {
    if (!selector) {
      return [];
    }

    const out = [];
    for (const candidate of candidates) {
      if (
        candidate?.nodeType !== 1 &&
        candidate?.nodeType !== 9 &&
        candidate?.nodeType !== 11
      ) {
        continue;
      }

      try {
        if (candidate.nodeType === 1 && candidate.matches(selector)) {
          out.push(candidate);
        }

        for (const element of candidate.querySelectorAll(selector)) {
          out.push(element);
          if (out.length >= MAX_PROCEDURAL_CANDIDATES) {
            return out;
          }
        }
      } catch (_) {
        // Invalid selector.
        return [];
      }
    }

    return out;
  }

  _filterProceduralCandidates(candidates, predicate) {
    const out = [];

    const consider = element => {
      if (element?.nodeType !== 1) {
        return false;
      }

      try {
        if (predicate(element)) {
          out.push(element);
          return out.length >= MAX_PROCEDURAL_CANDIDATES;
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

  _matchesProceduralPattern(value, pattern) {
    const text = String(value || "");
    const rawPattern = String(pattern || "");
    if (!rawPattern) {
      return false;
    }

    const regexMatch = rawPattern.match(/^\/(.+)\/([gimsuy]*)$/);
    if (regexMatch) {
      try {
        const flags = regexMatch[2].replaceAll("g", "");
        return new RegExp(regexMatch[1], flags).test(text);
      } catch (_) {
        // Invalid filter regex.
        return false;
      }
    }

    return text.includes(rawPattern);
  }

  _matchesProceduralAttr(element, arg) {
    const match = String(arg || "").match(
      /^\s*([^\s~|^$*!=]+)\s*(?:=\s*(.+))?\s*$/
    );
    if (!match) {
      return false;
    }

    const attrName = match[1];
    if (!element.hasAttribute(attrName)) {
      return false;
    }

    if (match[2] === undefined) {
      return true;
    }

    return this._matchesProceduralPattern(
      element.getAttribute(attrName) || "",
      match[2].replace(/^["']|["']$/g, "")
    );
  }

  _matchesProceduralStyle(element, arg, pseudo = null) {
    const separator = String(arg || "").indexOf(":");
    if (separator <= 0) {
      return false;
    }

    const property = arg.slice(0, separator).trim();
    const expected = arg.slice(separator + 1).trim();
    if (!property || !expected) {
      return false;
    }

    const contentWin = this.contentWindow;
    if (!contentWin) {
      return false;
    }

    const computed = contentWin.getComputedStyle(element, pseudo);
    return this._matchesProceduralPattern(
      computed.getPropertyValue(property).trim(),
      expected
    );
  }

  _matchesProceduralPath(arg) {
    let href = "";
    let path = "";
    try {
      const url = new URL(this.document.documentURI);
      href = url.href;
      path = `${url.pathname}${url.search}${url.hash}`;
    } catch (_) {
      // Invalid document URI.
      return false;
    }

    return (
      this._matchesProceduralPattern(href, arg) ||
      this._matchesProceduralPattern(path, arg)
    );
  }

  _applyProceduralUpward(candidates, arg) {
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
          // Invalid closest() selector.
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

  _evaluateProceduralXPath(candidates, expression) {
    const doc = this.document;
    const contentWin = this.contentWindow;
    if (!doc || !contentWin?.XPathResult || !expression) {
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
          contentWin.XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
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
        // Invalid XPath expression.
        return [];
      }
    }

    return out;
  }

  _applyProceduralAction(element, action) {
    if (!element || element.nodeType !== 1) {
      return;
    }

    if (!action) {
      this._setProceduralInlineStyle(element, "display", "none", "important");
      return;
    }

    const type = String(action.type || "");
    const arg = typeof action.arg === "string" ? action.arg : "";

    switch (type) {
      case "remove":
        if (element.isConnected) {
          element.remove();
        }
        break;
      case "style":
        this._applyProceduralStyle(element, arg);
        break;
      case "remove-attr":
        if (arg && element.hasAttribute(arg)) {
          element.removeAttribute(arg);
        }
        break;
      case "remove-class":
        for (const token of arg.split(/\s+/)) {
          if (token && element.classList.contains(token)) {
            element.classList.remove(token);
          }
        }
        break;
      default:
        this._setProceduralInlineStyle(element, "display", "none", "important");
        break;
    }
  }

  _applyProceduralStyle(element, styleText) {
    for (const declaration of String(styleText || "").split(";")) {
      const separator = declaration.indexOf(":");
      if (separator <= 0) {
        continue;
      }

      const property = declaration.slice(0, separator).trim();
      let value = declaration.slice(separator + 1).trim();
      if (!property || !value) {
        continue;
      }

      const important = /!important\s*$/i.test(value);
      value = value.replace(/!important\s*$/i, "").trim();
      this._setProceduralInlineStyle(
        element,
        property,
        value,
        important ? "important" : ""
      );
    }
  }

  _setProceduralInlineStyle(element, property, value, priority = "") {
    const currentValue = element.style.getPropertyValue(property).trim();
    const currentPriority = element.style.getPropertyPriority(property);
    if (currentValue === value && currentPriority === priority) {
      return;
    }

    element.style.setProperty(property, value, priority);
  }

  _teardownProceduralActionObserver() {
    if (this._proceduralObserver) {
      try {
        this._proceduralObserver.disconnect();
      } catch (err) {
        console.error(
          "[WaterfoxBlockerChild] failed to disconnect procedural observer:",
          err
        );
      }
      this._proceduralObserver = null;
    }

    const contentWin = this.contentWindow;
    if (this._proceduralMutationTimeout) {
      try {
        contentWin?.clearTimeout(this._proceduralMutationTimeout);
      } catch (err) {
        console.error(
          "[WaterfoxBlockerChild] failed to clear procedural timeout:",
          err
        );
      }
      this._proceduralMutationTimeout = null;
    }
  }

  /**
   * @param {string[]} exceptions
   */
  _setupGenericHideObserver(exceptions) {
    const doc = this.document;
    if (!doc) {
      return;
    }

    this._cosmeticExceptions = Array.isArray(exceptions) ? exceptions : [];
    this._queriedClasses = new Set();
    this._queriedIds = new Set();

    const contentWin = this.contentWindow;
    if (!contentWin) {
      return;
    }

    this._teardownGenericHideObserver();

    // Full DOM scan to establish a baseline.
    this._initialCollectTimeout = contentWin.setTimeout(() => {
      this._initialCollectTimeout = null;
      const snapshot = this._collectClassIdSnapshot();
      for (const cls of snapshot.classes) {
        this._queriedClasses.add(cls);
      }
      for (const id of snapshot.ids) {
        this._queriedIds.add(id);
      }
      this._queryAndApplyNewSelectors(snapshot.classes, snapshot.ids);
    }, 100);

    this._pendingClasses = [];
    this._pendingIds = [];

    this._observer = new contentWin.MutationObserver(mutations => {
      if (
        this._queriedClasses.size + this._queriedIds.size >=
        MAX_QUERIED_TOKENS
      ) {
        this._observer.disconnect();
        return;
      }

      // Extract tokens immediately so we hold only strings, not DOM nodes.
      const delta = this._extractDeltaFromMutations(mutations);
      if (delta.classes.length) {
        this._pendingClasses.push(...delta.classes);
      }
      if (delta.ids.length) {
        this._pendingIds.push(...delta.ids);
      }

      if (this._mutationTimeout) {
        return;
      }

      this._mutationTimeout = contentWin.setTimeout(() => {
        this._mutationTimeout = null;
        const classes = this._pendingClasses;
        const ids = this._pendingIds;
        this._pendingClasses = [];
        this._pendingIds = [];
        if (classes.length || ids.length) {
          this._queryAndApplyNewSelectors(classes, ids);
        }
      }, 250);
    });

    this._observer.observe(doc.documentElement || doc, {
      attributeFilter: ["class", "id"],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  /**
   * @param {MutationRecord[]} mutations
   * @returns {{classes: string[], ids: string[]}}
   */
  _extractDeltaFromMutations(mutations) {
    const newClasses = [];
    const newIds = [];
    const seenClasses = this._queriedClasses;
    const seenIds = this._queriedIds;

    const processElement = el => {
      if (!el || el.nodeType !== 1) {
        return false;
      }

      if (
        newIds.length < MAX_MUTATION_DELTA_IDS &&
        el.id &&
        !seenIds.has(el.id)
      ) {
        newIds.push(el.id);
        seenIds.add(el.id);
      }

      if (newClasses.length < MAX_MUTATION_DELTA_CLASSES && el.classList) {
        for (const cls of el.classList) {
          if (cls && !seenClasses.has(cls)) {
            newClasses.push(cls);
            seenClasses.add(cls);
            if (newClasses.length >= MAX_MUTATION_DELTA_CLASSES) {
              break;
            }
          }
        }
      }

      return (
        newClasses.length >= MAX_MUTATION_DELTA_CLASSES ||
        newIds.length >= MAX_MUTATION_DELTA_IDS
      );
    };

    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          if (processElement(node)) {
            return { classes: newClasses, ids: newIds };
          }
          if (node.nodeType === 1 && node.querySelectorAll) {
            for (const el of node.querySelectorAll("[class], [id]")) {
              if (processElement(el)) {
                return { classes: newClasses, ids: newIds };
              }
            }
          }
        }
      } else if (mutation.type === "attributes") {
        if (processElement(mutation.target)) {
          return { classes: newClasses, ids: newIds };
        }
      }
    }

    return { classes: newClasses, ids: newIds };
  }

  /**
   * @param {string[]} classes
   * @param {string[]} ids
   */
  async _queryAndApplyNewSelectors(classes, ids) {
    if (!classes.length && !ids.length) {
      return;
    }

    const doc = this.document;
    const documentURI = this._getDocumentURI(doc);
    if (!doc || !documentURI) {
      return;
    }

    let selectors;
    try {
      selectors = await this.sendQuery(
        "WaterfoxBlocker:GetHiddenClassIdSelectors",
        {
          classes,
          exceptions: this._cosmeticExceptions || [],
          ids,
        }
      );
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] sendQuery(GetHiddenClassIdSelectors) failed:",
        err
      );
      return;
    }

    if (this.document !== doc || !this._isCurrentDocumentURI(documentURI)) {
      return;
    }

    if (!selectors?.length) {
      return;
    }

    const cleanSelectors = this._normalizeSelectors(selectors);
    if (!cleanSelectors.length) {
      return;
    }

    if (!this._appliedGenericSelectors) {
      this._appliedGenericSelectors = new Set();
    }

    const toApply = cleanSelectors.filter(
      selector => !this._appliedGenericSelectors.has(selector)
    );
    if (!toApply.length) {
      return;
    }

    for (const selector of toApply) {
      this._appliedGenericSelectors.add(selector);
    }

    const style = this._ensureStyleElement(doc);
    if (!style?.sheet) {
      return;
    }

    const sheet = style.sheet;
    for (const selector of toApply) {
      try {
        sheet.insertRule(
          `${selector} { display: none !important; }`,
          sheet.cssRules.length
        );
      } catch (_) {
        // Invalid selector, skip.
      }
    }
  }

  /**
   * @param {string} scriptText
   */
  _injectScriptlet(scriptText) {
    const doc = this.document;
    const contentWindow = this.contentWindow;
    if (!doc || !contentWindow || !scriptText) {
      return;
    }

    const documentURI = this._getDocumentURI(doc);

    // uBO scriptlets expect scriptletGlobals to exist in their scope.
    // Compile and execute directly in the page's main world, following
    // ExtensionContent's "MAIN" world path. This avoids page CSP blocking a
    // DOM <script> element and avoids waiving Xrays to call page DOM APIs.
    const prelude = `
if (typeof globalThis.scriptletGlobals === "undefined" ||
  !(globalThis.scriptletGlobals instanceof Map)) {
  globalThis.scriptletGlobals = new Map();
}
const scriptletGlobals = globalThis.scriptletGlobals;
`;

    let compiledScript;
    try {
      const scriptUrl = `data:text/javascript,${encodeURIComponent(
        prelude + scriptText
      )}`;
      compiledScript = ChromeUtils.compileScript(scriptUrl, {
        filename: "waterfox-blocker-scriptlet.js",
      });
    } catch (err) {
      console.error("[WaterfoxBlockerChild] failed to compile scriptlet:", err);
      return;
    }

    compiledScript
      .then(script => {
        let currentDocument;
        let currentWindow;
        try {
          currentDocument = this.document;
          currentWindow = this.contentWindow;
        } catch (_) {
          // The actor may be detached before script compilation finishes.
          return;
        }

        if (
          currentDocument !== doc ||
          currentWindow !== contentWindow ||
          this._getDocumentURI(currentDocument) !== documentURI
        ) {
          return;
        }

        script.executeInGlobal(contentWindow, { reportExceptions: true });
      })
      .catch(err => {
        console.error(
          "[WaterfoxBlockerChild] failed to inject scriptlet:",
          err
        );
      });
  }

  _teardownGenericHideObserver() {
    if (this._observer) {
      try {
        this._observer.disconnect();
      } catch (err) {
        console.error(
          "[WaterfoxBlockerChild] failed to disconnect generic-hide observer:",
          err
        );
      }
      this._observer = null;
    }

    this._pendingClasses = null;
    this._pendingIds = null;

    const contentWin = this.contentWindow;
    if (this._mutationTimeout) {
      try {
        contentWin?.clearTimeout(this._mutationTimeout);
      } catch (err) {
        console.error(
          "[WaterfoxBlockerChild] failed to clear mutation timeout:",
          err
        );
      }
      this._mutationTimeout = null;
    }
    if (this._initialCollectTimeout) {
      try {
        contentWin?.clearTimeout(this._initialCollectTimeout);
      } catch (err) {
        console.error(
          "[WaterfoxBlockerChild] failed to clear initial collection timeout:",
          err
        );
      }
      this._initialCollectTimeout = null;
    }
  }

  /**
   * @param {string[]} selectors
   * @returns {{ok: boolean, applied: number}}
   */
  _applyCosmeticSelectors(selectors) {
    const doc = this.document;
    if (!doc) {
      return { applied: 0, ok: false };
    }

    const cleanSelectors = this._normalizeSelectors(selectors);
    const style = this._ensureStyleElement(doc);
    if (!style?.sheet) {
      return { applied: 0, ok: false };
    }

    style.textContent = "";

    if (!cleanSelectors.length) {
      return { applied: 0, ok: true };
    }

    let applied = 0;
    const sheet = style.sheet;
    for (const selector of cleanSelectors) {
      try {
        sheet.insertRule(
          `${selector} { display: none !important; }`,
          sheet.cssRules.length
        );
        applied++;
      } catch (_) {
        // Invalid selector, skip.
      }
    }

    return { applied, ok: true };
  }

  _clearCosmeticSelectors() {
    const doc = this.document;
    if (!doc) {
      return;
    }

    const style = doc.getElementById(COSMETIC_STYLE_ID);
    if (style) {
      style.remove();
    }
  }

  /**
   * @param {object} [options={}]
   * @param {number} [options.maxClasses]
   * @param {number} [options.maxIds]
   * @returns {{classes: string[], ids: string[]}}
   */
  _collectClassIdSnapshot(options = {}) {
    const doc = this.document;
    if (!doc) {
      return { classes: [], ids: [] };
    }

    const maxClasses = Number(options.maxClasses) || 5000;
    const maxIds = Number(options.maxIds) || 5000;

    const classes = new Set();
    const ids = new Set();

    for (const el of doc.querySelectorAll("[class], [id]")) {
      if (ids.size < maxIds && el.id) {
        ids.add(el.id);
      }

      if (classes.size < maxClasses && el.classList?.length) {
        for (const cls of el.classList) {
          if (!cls) {
            continue;
          }
          classes.add(cls);
          if (classes.size >= maxClasses) {
            break;
          }
        }
      }

      if (classes.size >= maxClasses && ids.size >= maxIds) {
        break;
      }
    }

    return {
      classes: Array.from(classes),
      ids: Array.from(ids),
    };
  }

  _normalizeSelectors(selectors, maxSelectors = MAX_COSMETIC_SELECTORS) {
    if (!Array.isArray(selectors)) {
      return [];
    }

    const out = [];
    const seen = new Set();

    for (const selector of selectors) {
      if (typeof selector !== "string") {
        continue;
      }

      const trimmed = selector.trim();
      if (!trimmed || seen.has(trimmed)) {
        continue;
      }

      seen.add(trimmed);
      out.push(trimmed);

      if (out.length >= maxSelectors) {
        break;
      }
    }

    return out;
  }

  _ensureStyleElement(doc) {
    const existing = doc.getElementById(COSMETIC_STYLE_ID);
    if (existing) {
      return existing;
    }

    const parent = doc.head || doc.documentElement || doc.body;
    if (!parent) {
      return null;
    }

    const style = doc.createElement("style");
    style.id = COSMETIC_STYLE_ID;
    parent.appendChild(style);

    return style;
  }
}
