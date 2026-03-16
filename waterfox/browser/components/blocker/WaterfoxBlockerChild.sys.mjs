/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const COSMETIC_STYLE_ID = "waterfox-blocker-cosmetic-style";
const INITIAL_RESOURCES_RETRY_DELAY_MS = 1000;
const MAX_QUERIED_TOKENS = 50000;

/*
 * Module rationale:
 *
 * This child actor runs in content processes and applies cosmetic filtering
 * and scriptlet decisions from the blocker to live documents.
 *
 * Scriptlets need execution in page scope, not in actor scope, so injection
 * goes through `this.contentWindow.wrappedJSObject`. That is the standard
 * privileged-to-content bridge used in Gecko for script execution in page
 * scope, including `ExtensionContent.sys.mjs`.
 *
 * Updates for selectors used in generic hiding use a `MutationObserver` with
 * timeout debouncing so DOM churn is coalesced before querying the parent
 * actor for additional selectors. This follows the same design used by
 * `ContentBlockingAllowList.sys.mjs` to avoid excessive recomputation.
 */

/**
 * JSWindowActor child for blocker behaviour in content processes.
 *
 * Receives cosmetic resources from the parent actor, applies selectors to the
 * document, and injects scriptlets into page scope.
 */
export class WaterfoxBlockerChild extends JSWindowActorChild {
  /**
   * Handles messages from the parent actor for cosmetic operations.
   *
   * @param {object} message
   * @param {string} message.name
   * @param {object} [message.data]
   * @returns {object|undefined} Operation result for handled messages, or
   *          `undefined` for unhandled message names.
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
      this._onDOMWindowCreated().catch(err => {
        console.error("[WaterfoxBlockerChild] DOMWindowCreated failed:", err);
      });
      return;
    }

    if (event.type === "DOMDocElementInserted") {
      this._flushInitialResources();
    }
  }

  /**
   * Initialises cosmetic and scriptlet state for each document after window creation.
   */
  async _onDOMWindowCreated() {
    const doc = this.document;
    if (!doc) {
      return;
    }

    this._teardownGenericHideObserver();
    this._clearResourceRetryTimeout();
    this._appliedGenericSelectors = new Set();
    this._queriedClasses = new Set();
    this._queriedIds = new Set();
    this._cosmeticExceptions = [];
    this._retriedResources = false;

    let enabled;
    try {
      enabled = await this.sendQuery("WaterfoxBlocker:IsEnabled");
    } catch (_) {
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

    // Cosmetic filtering only makes sense in HTML documents. XML, plain text,
    // and other content types don't understand <style> — injecting one renders
    // the CSS rules as visible text (e.g. update.xml manifests).
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

    if (!resources) {
      return;
    }

    this._pendingInitialResources = resources;
    this._flushInitialResources();

    if (this._isInitialResourcesResponseEmpty(resources)) {
      this._scheduleInitialResourcesRetry(doc);
    }
  }

  didDestroy() {
    this._teardownGenericHideObserver();
    this._clearResourceRetryTimeout();
    this._appliedGenericSelectors = null;
    this._queriedClasses = null;
    this._queriedIds = null;
    this._pendingInitialResources = null;
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

    let url;
    try {
      url = doc.documentURI || doc.location?.href || "";
    } catch (_) {
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
        "[WaterfoxBlockerChild] delayed sendQuery(GetCosmeticResources) failed:",
        err
      );
      return;
    }

    if (!resources) {
      return;
    }

    this._pendingInitialResources = resources;
    this._flushInitialResources();
  }

  /**
   * Applies pending initial resources once the document has an injection target.
   */
  _flushInitialResources() {
    const resources = this._pendingInitialResources;
    if (!resources) {
      return;
    }

    const doc = this.document;
    if (!doc || !this._hasInjectionTarget(doc)) {
      return;
    }

    this._pendingInitialResources = null;

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

    if (!resources.generichide) {
      this._setupGenericHideObserver(resources.exceptions || []);
    }
  }

  _hasInjectionTarget(doc) {
    return !!(doc.head || doc.documentElement || doc.body);
  }

  /**
   * Starts watching for DOM changes and refreshes selectors used in generic hiding.
   *
   * @param {string[]} exceptions Domain exceptions applied during generic hiding matches.
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

    // Initial collect: full DOM scan to establish baseline.
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
   * Extracts only previously unseen class/id tokens from mutation records.
   *
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
        return;
      }

      if (el.id && !seenIds.has(el.id)) {
        newIds.push(el.id);
        seenIds.add(el.id);
      }

      if (el.classList) {
        for (const cls of el.classList) {
          if (cls && !seenClasses.has(cls)) {
            newClasses.push(cls);
            seenClasses.add(cls);
          }
        }
      }
    };

    for (const mutation of mutations) {
      if (mutation.type === "childList") {
        for (const node of mutation.addedNodes) {
          processElement(node);
          if (node.nodeType === 1 && node.querySelectorAll) {
            for (const el of node.querySelectorAll("[class], [id]")) {
              processElement(el);
            }
          }
        }
      } else if (mutation.type === "attributes") {
        processElement(mutation.target);
      }
    }

    return { classes: newClasses, ids: newIds };
  }

  /**
   * Sends only new class/id tokens to the parent for selector resolution,
   * then applies any returned selectors.
   *
   * @param {string[]} classes
   * @param {string[]} ids
   */
  async _queryAndApplyNewSelectors(classes, ids) {
    if (!classes.length && !ids.length) {
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

    const doc = this.document;
    if (!doc) {
      return;
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
        // Invalid selector — skip.
      }
    }
  }

  /**
   * Injects one scriptlet payload into page scope.
   *
   * @param {string} scriptText Script source to inject.
   */
  _injectScriptlet(scriptText) {
    const doc = this.document;
    if (!doc || !scriptText) {
      return;
    }

    let pageWindow;
    try {
      pageWindow = this.contentWindow?.wrappedJSObject;
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] failed to access wrappedJSObject for scriptlet injection:",
        err
      );
      return;
    }

    if (!pageWindow) {
      return;
    }

    const pageDoc = pageWindow.document;
    const parent = pageDoc.head || pageDoc.documentElement;
    if (!parent) {
      return;
    }

    // uBO scriptlets expect scriptletGlobals to exist in their scope.
    // TODO: Pages with strict script-src CSP will silently block this
    // injection. Brave uses world: "MAIN" content scripts instead.
    const prelude = `
if (typeof globalThis.scriptletGlobals === "undefined") {
  globalThis.scriptletGlobals = new Map();
}
const scriptletGlobals = globalThis.scriptletGlobals;
`;

    try {
      const script = pageDoc.createElement("script");
      script.textContent = prelude + scriptText;
      parent.appendChild(script);
      script.remove();
    } catch (err) {
      console.error("[WaterfoxBlockerChild] failed to inject scriptlet:", err);
    }
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
   * Applies static cosmetic selectors to the document style bucket.
   *
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
    if (!style) {
      return { applied: 0, ok: false };
    }

    if (!cleanSelectors.length) {
      style.textContent = "";
      return { applied: 0, ok: true };
    }

    style.textContent = cleanSelectors
      .map(selector => `${selector} { display: none !important; }`)
      .join("\n");

    return { applied: cleanSelectors.length, ok: true };
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
   * Collects bounded class/id snapshots for resolving selectors used in generic hiding.
   *
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

  _normalizeSelectors(selectors) {
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

      // Bound the number of selectors to avoid unbounded memory growth on pages
      // with extremely large or noisy DOM class/id sets.
      if (out.length >= 10000) {
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
