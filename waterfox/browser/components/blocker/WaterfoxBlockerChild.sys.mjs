/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toSafeDomain } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

const COSMETIC_STYLE_ID = "waterfox-blocker-cosmetic-style";
const INITIAL_RESOURCES_RETRY_DELAY_MS = 1000;
const MAX_QUERIED_TOKENS = 50000;
const MAX_PROCEDURAL_ACTIONS = 1000;
const ZAPPER_CLOSE_BUTTON_ID = "waterfox-blocker-zapper-close";
const ZAPPER_HIGHLIGHT_ID = "waterfox-blocker-zapper-highlight";
const ZAPPER_OVERLAY_ID = "waterfox-blocker-zapper-overlay";
const ZAPPER_Z_INDEX = 2147483647;
const PICKER_CLOSE_BUTTON_ID = "waterfox-blocker-picker-close";
const PICKER_HIGHLIGHT_ID = "waterfox-blocker-picker-highlight";
const PICKER_OVERLAY_ID = "waterfox-blocker-picker-overlay";
const PICKER_STATUS_ID = "waterfox-blocker-picker-status";
const PICKER_Z_INDEX = 2147483647;

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

        case "WaterfoxBlocker:StartElementZapper":
          return this._startElementZapper();

        case "WaterfoxBlocker:StopElementZapper":
          this._stopElementZapper();
          return { ok: true };

        case "WaterfoxBlocker:StartElementPicker":
          return this._startElementPicker();

        case "WaterfoxBlocker:StopElementPicker":
          this._stopElementPicker();
          return { ok: true };

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
    this._proceduralActionFilters = [];
    this._retriedResources = false;
    this._shouldResolveGenericSelectors = false;

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
    this._proceduralActionFilters = null;
    this._retriedResources = false;
    this._shouldResolveGenericSelectors = false;
    this._stopElementZapper({ notify: false });
    this._stopElementPicker({ notify: false });

    try {
      this._clearCosmeticSelectors();
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] failed clearing cosmetic selectors during destroy:",
        err
      );
    }
  }

  _startElementZapper() {
    const doc = this.document;
    const contentWin = this.contentWindow;
    if (!doc || !contentWin) {
      return { active: false, ok: false };
    }

    if (this._zapperActive) {
      return { active: true, ok: true };
    }

    const overlay = this._ensureZapperOverlay(doc);
    if (!overlay) {
      return { active: false, ok: false };
    }

    this._zapperActive = true;
    this._zapperHighlight = overlay.firstElementChild;
    this._zapperOverlay = overlay;
    this._zapperTarget = null;

    this._boundZapperMouseMove ||= event => {
      this._onZapperMouseMove(event);
    };
    this._boundZapperMouseDown ||= event => {
      this._onZapperMouseDown(event);
    };
    this._boundZapperClick ||= event => {
      this._onZapperClick(event);
    };
    this._boundZapperKeyDown ||= event => {
      this._onZapperKeyDown(event);
    };
    this._boundZapperViewportChange ||= () => {
      this._updateZapperHighlight();
    };
    this._boundZapperCloseClick ||= event => {
      event.preventDefault();
      event.stopPropagation();
      this._stopElementZapper();
    };

    doc.addEventListener("mousemove", this._boundZapperMouseMove, true);
    doc.addEventListener("mousedown", this._boundZapperMouseDown, true);
    doc.addEventListener("click", this._boundZapperClick, true);
    doc.addEventListener("keydown", this._boundZapperKeyDown, true);
    contentWin.addEventListener(
      "scroll",
      this._boundZapperViewportChange,
      true
    );
    contentWin.addEventListener(
      "resize",
      this._boundZapperViewportChange,
      true
    );
    doc
      .getElementById(ZAPPER_CLOSE_BUTTON_ID)
      ?.addEventListener("click", this._boundZapperCloseClick, true);

    this._notifyZapperStateChange(true);
    return { active: true, ok: true };
  }

  _stopElementZapper({ notify = true } = {}) {
    const doc = this.document;
    const contentWin = this.contentWindow;

    if (doc && this._boundZapperMouseMove) {
      doc.removeEventListener("mousemove", this._boundZapperMouseMove, true);
      doc.removeEventListener("mousedown", this._boundZapperMouseDown, true);
      doc.removeEventListener("click", this._boundZapperClick, true);
      doc.removeEventListener("keydown", this._boundZapperKeyDown, true);
      doc
        .getElementById(ZAPPER_CLOSE_BUTTON_ID)
        ?.removeEventListener("click", this._boundZapperCloseClick, true);
    }

    if (contentWin && this._boundZapperViewportChange) {
      contentWin.removeEventListener(
        "scroll",
        this._boundZapperViewportChange,
        true
      );
      contentWin.removeEventListener(
        "resize",
        this._boundZapperViewportChange,
        true
      );
    }

    this._zapperActive = false;
    this._zapperTarget = null;
    this._zapperHighlight = null;
    this._zapperOverlay?.remove();
    this._zapperOverlay = null;

    if (notify) {
      this._notifyZapperStateChange(false);
    }
  }

  _notifyZapperStateChange(active) {
    try {
      this.sendAsyncMessage("WaterfoxBlocker:ZapperStateChanged", {
        active: !!active,
      });
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] failed to notify zapper state change:",
        err
      );
    }
  }

  _startElementPicker() {
    const doc = this.document;
    const contentWin = this.contentWindow;
    if (!doc || !contentWin) {
      return { active: false, ok: false };
    }

    if (this._pickerActive) {
      return { active: true, ok: true };
    }

    const overlay = this._ensurePickerOverlay(doc);
    if (!overlay) {
      return { active: false, ok: false };
    }

    this._pickerActive = true;
    this._pickerOverlay = overlay;
    this._pickerHighlight = overlay.querySelector(`#${PICKER_HIGHLIGHT_ID}`);
    this._pickerStatus = overlay.querySelector(`#${PICKER_STATUS_ID}`);
    this._pickerTarget = null;

    this._boundPickerMouseMove ||= event => {
      this._onPickerMouseMove(event);
    };
    this._boundPickerMouseDown ||= event => {
      this._onPickerMouseDown(event);
    };
    this._boundPickerClick ||= event => {
      void this._onPickerClick(event);
    };
    this._boundPickerKeyDown ||= event => {
      this._onPickerKeyDown(event);
    };
    this._boundPickerViewportChange ||= () => {
      this._updatePickerHighlight();
    };
    this._boundPickerCloseClick ||= event => {
      event.preventDefault();
      event.stopPropagation();
      this._stopElementPicker();
    };

    this._pickerOriginalCursor = doc.documentElement?.style?.cursor || "";
    this._pickerOriginalBodyCursor = doc.body?.style?.cursor || "";
    if (doc.documentElement?.style) {
      doc.documentElement.style.cursor = "crosshair";
    }
    if (doc.body?.style) {
      doc.body.style.cursor = "crosshair";
    }

    doc.addEventListener("mousemove", this._boundPickerMouseMove, true);
    doc.addEventListener("mousedown", this._boundPickerMouseDown, true);
    doc.addEventListener("click", this._boundPickerClick, true);
    doc.addEventListener("keydown", this._boundPickerKeyDown, true);
    contentWin.addEventListener(
      "scroll",
      this._boundPickerViewportChange,
      true
    );
    contentWin.addEventListener(
      "resize",
      this._boundPickerViewportChange,
      true
    );
    doc
      .getElementById(PICKER_CLOSE_BUTTON_ID)
      ?.addEventListener("click", this._boundPickerCloseClick, true);

    this._updatePickerStatus("Click an element to create a rule.");
    this._notifyPickerStateChange(true);
    return { active: true, ok: true };
  }

  _stopElementPicker({ notify = true } = {}) {
    const doc = this.document;
    const contentWin = this.contentWindow;

    if (doc && this._boundPickerMouseMove) {
      doc.removeEventListener("mousemove", this._boundPickerMouseMove, true);
      doc.removeEventListener("mousedown", this._boundPickerMouseDown, true);
      doc.removeEventListener("click", this._boundPickerClick, true);
      doc.removeEventListener("keydown", this._boundPickerKeyDown, true);
      doc
        .getElementById(PICKER_CLOSE_BUTTON_ID)
        ?.removeEventListener("click", this._boundPickerCloseClick, true);
    }

    if (contentWin && this._boundPickerViewportChange) {
      contentWin.removeEventListener(
        "scroll",
        this._boundPickerViewportChange,
        true
      );
      contentWin.removeEventListener(
        "resize",
        this._boundPickerViewportChange,
        true
      );
    }

    if (doc?.documentElement?.style) {
      doc.documentElement.style.cursor = this._pickerOriginalCursor || "";
    }
    if (doc?.body?.style) {
      doc.body.style.cursor = this._pickerOriginalBodyCursor || "";
    }

    this._pickerActive = false;
    this._pickerTarget = null;
    this._pickerHighlight = null;
    this._pickerStatus = null;
    this._pickerOverlay?.remove();
    this._pickerOverlay = null;
    this._pickerOriginalCursor = "";
    this._pickerOriginalBodyCursor = "";

    if (notify) {
      this._notifyPickerStateChange(false);
    }
  }

  _notifyPickerStateChange(active) {
    try {
      this.sendAsyncMessage("WaterfoxBlocker:PickerStateChanged", {
        active: !!active,
      });
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] failed to notify picker state change:",
        err
      );
    }
  }

  _notifyPickedElementRule(rule, selector, added) {
    try {
      this.sendAsyncMessage("WaterfoxBlocker:PickedElementRule", {
        added: !!added,
        rule,
        selector,
      });
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] failed to notify picked rule:",
        err
      );
    }
  }

  _ensurePickerOverlay(doc) {
    let overlay = doc.getElementById(PICKER_OVERLAY_ID);
    if (overlay) {
      return overlay;
    }

    const container = doc.body || doc.documentElement;
    if (!container) {
      return null;
    }

    overlay = doc.createElement("div");
    overlay.id = PICKER_OVERLAY_ID;
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      pointer-events: none;
      cursor: crosshair;
      z-index: ${PICKER_Z_INDEX};
    `;

    const status = doc.createElement("div");
    status.id = PICKER_STATUS_ID;
    status.style.cssText = `
      position: fixed;
      top: 16px;
      left: 16px;
      max-width: min(460px, calc(100vw - 32px));
      box-sizing: border-box;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(20, 20, 28, 0.94);
      color: #fff;
      font: 13px/1.4 system-ui, sans-serif;
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
      pointer-events: none;
      white-space: pre-wrap;
    `;
    status.textContent = "Click an element to create a rule.";
    overlay.appendChild(status);

    const highlight = doc.createElement("div");
    highlight.id = PICKER_HIGHLIGHT_ID;
    highlight.style.cssText = `
      position: fixed;
      display: none;
      pointer-events: none;
      box-sizing: border-box;
      border: 2px solid #f7d154;
      background: rgba(247, 209, 84, 0.16);
      border-radius: 6px;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
    `;
    overlay.appendChild(highlight);

    const closeButton = doc.createElement("button");
    closeButton.id = PICKER_CLOSE_BUTTON_ID;
    closeButton.type = "button";
    closeButton.textContent = "\u00d7";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.style.cssText = `
      position: fixed;
      bottom: 16px;
      right: 16px;
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 999px;
      background: rgba(20, 20, 28, 0.92);
      color: white;
      font: 600 24px/1 sans-serif;
      pointer-events: auto;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    `;
    overlay.appendChild(closeButton);

    container.appendChild(overlay);
    return overlay;
  }

  _onPickerMouseMove(event) {
    if (!this._pickerActive) {
      return;
    }

    const candidate = this._getPickerCandidateFromPoint(
      event.clientX,
      event.clientY
    );
    this._setPickerTarget(candidate);
  }

  _onPickerMouseDown(event) {
    if (!this._pickerActive || event.button !== 0) {
      return;
    }

    if (event.target?.id === PICKER_CLOSE_BUTTON_ID) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  async _onPickerClick(event) {
    if (!this._pickerActive || event.button !== 0) {
      return;
    }

    if (event.target?.id === PICKER_CLOSE_BUTTON_ID) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const target =
      this._pickerTarget ||
      this._getPickerCandidateFromPoint(event.clientX, event.clientY);
    if (!target) {
      this._updatePickerStatus("Select an element to create a rule.");
      return;
    }

    const generated = this._buildCosmeticRuleForElement(target);
    if (!generated) {
      this._updatePickerStatus("Could not build a rule for that element.");
      return;
    }

    this._updatePickerStatus(`Saving rule:\n${generated.rule}`);
    const result = await this._commitPickedRule(generated);
    if (!result?.ok) {
      this._updatePickerStatus("Could not save the rule. Try another element.");
      return;
    }

    if (result.added) {
      this._applyPickedRulePreview(generated.selector);
    }

    this._notifyPickedElementRule(
      generated.rule,
      generated.selector,
      !!result.added
    );
    this._stopElementPicker();
  }

  _onPickerKeyDown(event) {
    if (!this._pickerActive) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this._stopElementPicker();
    }
  }

  _getPickerCandidateFromPoint(clientX, clientY) {
    const doc = this.document;
    if (!doc) {
      return null;
    }

    if (this._pickerOverlay) {
      this._pickerOverlay.style.display = "none";
    }

    let target = null;
    try {
      target = doc.elementFromPoint(clientX, clientY);
    } catch (_) {
      target = null;
    }

    if (this._pickerOverlay) {
      this._pickerOverlay.style.display = "";
    }

    while (target && this._isPickerUiNode(target)) {
      target = target.parentElement;
    }

    if (!target || target === doc.documentElement || target === doc.body) {
      return null;
    }

    return target;
  }

  _isPickerUiNode(node) {
    return (
      node?.id === PICKER_OVERLAY_ID ||
      node?.id === PICKER_HIGHLIGHT_ID ||
      node?.id === PICKER_CLOSE_BUTTON_ID ||
      node?.id === PICKER_STATUS_ID ||
      node?.closest?.(`#${PICKER_OVERLAY_ID}`) !== null
    );
  }

  _setPickerTarget(target) {
    if (this._pickerTarget === target) {
      return;
    }

    this._pickerTarget = target || null;
    this._updatePickerHighlight();
  }

  _updatePickerHighlight() {
    const highlight = this._pickerHighlight;
    const target = this._pickerTarget;
    if (!highlight || !target?.isConnected) {
      if (highlight) {
        highlight.style.display = "none";
      }
      this._pickerTarget = null;
      this._updatePickerStatus("Click an element to create a rule.");
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      highlight.style.display = "none";
      return;
    }

    highlight.style.display = "block";
    highlight.style.left = `${Math.max(0, rect.left)}px`;
    highlight.style.top = `${Math.max(0, rect.top)}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;

    const generated = this._buildCosmeticRuleForElement(target);
    if (generated) {
      this._updatePickerStatus(`Rule:\n${generated.rule}`);
    }
  }

  _updatePickerStatus(text) {
    if (this._pickerStatus) {
      this._pickerStatus.textContent = String(text || "");
    }
  }

  _applyPickedRulePreview(selector) {
    const doc = this.document;
    if (!doc || !selector) {
      return;
    }

    let style = doc.getElementById(`${PICKER_OVERLAY_ID}-style`);
    if (!style) {
      style = doc.createElement("style");
      style.id = `${PICKER_OVERLAY_ID}-style`;
      (doc.head || doc.documentElement || doc.body)?.appendChild(style);
    }

    try {
      style.textContent = `${selector} { display: none !important; }`;
    } catch (_) {}
  }

  _buildCosmeticRuleForElement(element) {
    const doc = this.document;
    if (!doc || !element || !element.isConnected) {
      return null;
    }

    const host = toSafeDomain(
      doc.location?.hostname || doc.location?.host || ""
    );
    if (!host) {
      return null;
    }

    const selector = this._buildUniqueCssSelector(element);
    if (!selector) {
      return null;
    }

    return {
      host,
      rule: `${host}##${selector}`,
      selector,
    };
  }

  _buildUniqueCssSelector(element) {
    const doc = this.document;
    if (!doc || !element || !element.isConnected) {
      return "";
    }

    const segments = [];
    let current = element;
    for (
      let depth = 0;
      current && current.nodeType === 1 && depth < 8;
      depth++
    ) {
      const segment = this._buildSelectorSegment(current);
      if (!segment) {
        break;
      }

      segments.unshift(segment);
      const selector = segments.join(" > ");
      if (this._isUniqueSelector(selector)) {
        return selector;
      }

      current = current.parentElement;
      if (!current || current === doc.documentElement) {
        break;
      }
    }

    const fallback = segments.join(" > ");
    return this._isUniqueSelector(fallback) ? fallback : fallback || "";
  }

  _isUniqueSelector(selector) {
    const doc = this.document;
    if (!doc || !selector) {
      return false;
    }

    try {
      return doc.querySelectorAll(selector).length === 1;
    } catch (_) {
      return false;
    }
  }

  _buildSelectorSegment(element) {
    const doc = this.document;
    if (!doc || !element || element.nodeType !== 1) {
      return "";
    }

    const tag = String(element.localName || "").toLowerCase();
    if (!tag) {
      return "";
    }

    const id = String(element.id || "").trim();
    if (id) {
      const escapedId = this._escapeCssIdentifier(id);
      if (escapedId) {
        const idSelector = `#${escapedId}`;
        if (this._isUniqueSelector(idSelector)) {
          return idSelector;
        }
      }
    }

    const classes = [];
    if (element.classList?.length) {
      for (const cls of element.classList) {
        const clean = String(cls || "").trim();
        if (!clean || clean.length > 32 || !/^[A-Za-z_]/.test(clean)) {
          continue;
        }
        classes.push(clean);
        if (classes.length >= 2) {
          break;
        }
      }
    }

    let selector = tag;
    if (classes.length) {
      selector += classes
        .map(cls => `.${this._escapeCssIdentifier(cls)}`)
        .join("");
    }

    const siblings = element.parentElement
      ? Array.from(element.parentElement.children).filter(
          child => child.localName === element.localName
        )
      : [];
    if (siblings.length > 1) {
      const index = siblings.indexOf(element) + 1;
      if (index > 0) {
        selector += `:nth-of-type(${index})`;
      }
    }

    return selector;
  }

  _escapeCssIdentifier(value) {
    const text = String(value || "");
    if (!text) {
      return "";
    }

    try {
      if (typeof CSS?.escape === "function") {
        return CSS.escape(text);
      }
    } catch (_) {}

    return text.replace(/[^a-zA-Z0-9_-]/g, char => {
      const hex = char.codePointAt(0).toString(16).toUpperCase();
      return `\\${hex} `;
    });
  }

  async _commitPickedRule({ host, rule, selector } = {}) {
    try {
      return await this.sendQuery("WaterfoxBlocker:CommitPickedRule", {
        host,
        rule,
        selector,
      });
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] failed to commit picked rule:",
        err
      );
      return { added: false, ok: false };
    }
  }

  _ensureZapperOverlay(doc) {
    let overlay = doc.getElementById(ZAPPER_OVERLAY_ID);
    if (overlay) {
      return overlay;
    }

    const container = doc.body || doc.documentElement;
    if (!container) {
      return null;
    }

    overlay = doc.createElement("div");
    overlay.id = ZAPPER_OVERLAY_ID;
    overlay.setAttribute("aria-hidden", "true");
    overlay.style.cssText = `
      position: fixed;
      inset: 0;
      pointer-events: none;
      cursor: crosshair;
      z-index: ${ZAPPER_Z_INDEX};
    `;

    const highlight = doc.createElement("div");
    highlight.id = ZAPPER_HIGHLIGHT_ID;
    highlight.style.cssText = `
      position: fixed;
      display: none;
      pointer-events: none;
      box-sizing: border-box;
      border: 2px solid #36d1ff;
      background: rgba(54, 209, 255, 0.18);
      border-radius: 6px;
      box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
    `;
    overlay.appendChild(highlight);

    const closeButton = doc.createElement("button");
    closeButton.id = ZAPPER_CLOSE_BUTTON_ID;
    closeButton.type = "button";
    closeButton.textContent = "\u00d7";
    closeButton.setAttribute("aria-label", "Close");
    closeButton.style.cssText = `
      position: fixed;
      bottom: 16px;
      right: 16px;
      width: 32px;
      height: 32px;
      border: 0;
      border-radius: 999px;
      background: rgba(20, 20, 28, 0.92);
      color: white;
      font: 600 24px/1 sans-serif;
      pointer-events: auto;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 0;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    `;
    overlay.appendChild(closeButton);

    container.appendChild(overlay);
    return overlay;
  }

  _onZapperMouseMove(event) {
    if (!this._zapperActive) {
      return;
    }

    const candidate = this._getZapperCandidateFromPoint(
      event.clientX,
      event.clientY
    );
    this._setZapperTarget(candidate);
  }

  _onZapperMouseDown(event) {
    if (!this._zapperActive || event.button !== 0) {
      return;
    }

    if (event.target?.id === ZAPPER_CLOSE_BUTTON_ID) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  _onZapperClick(event) {
    if (!this._zapperActive || event.button !== 0) {
      return;
    }

    if (event.target?.id === ZAPPER_CLOSE_BUTTON_ID) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const target =
      this._zapperTarget ||
      this._getZapperCandidateFromPoint(event.clientX, event.clientY);
    if (!target) {
      return;
    }

    this._zapElement(target);
  }

  _onZapperKeyDown(event) {
    if (!this._zapperActive) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this._stopElementZapper();
      return;
    }

    if (event.key !== "Delete" && event.key !== "Backspace") {
      return;
    }

    if (!this._zapperTarget) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    this._zapElement(this._zapperTarget);
  }

  _getZapperCandidateFromPoint(clientX, clientY) {
    const doc = this.document;
    if (!doc) {
      return null;
    }

    if (this._zapperOverlay) {
      this._zapperOverlay.style.display = "none";
    }

    let target = null;
    try {
      target = doc.elementFromPoint(clientX, clientY);
    } catch (_) {
      target = null;
    }

    if (this._zapperOverlay) {
      this._zapperOverlay.style.display = "";
    }

    while (target && this._isZapperUiNode(target)) {
      target = target.parentElement;
    }

    if (!target || target === doc.documentElement || target === doc.body) {
      return null;
    }

    return target;
  }

  _isZapperUiNode(node) {
    return (
      node?.id === ZAPPER_OVERLAY_ID ||
      node?.id === ZAPPER_HIGHLIGHT_ID ||
      node?.id === ZAPPER_CLOSE_BUTTON_ID ||
      node?.closest?.(`#${ZAPPER_OVERLAY_ID}`) !== null
    );
  }

  _setZapperTarget(target) {
    if (this._zapperTarget === target) {
      return;
    }

    this._zapperTarget = target || null;
    this._updateZapperHighlight();
  }

  _updateZapperHighlight() {
    const highlight = this._zapperHighlight;
    const target = this._zapperTarget;
    if (!highlight || !target?.isConnected) {
      if (highlight) {
        highlight.style.display = "none";
      }
      this._zapperTarget = null;
      return;
    }

    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      highlight.style.display = "none";
      return;
    }

    highlight.style.display = "block";
    highlight.style.left = `${Math.max(0, rect.left)}px`;
    highlight.style.top = `${Math.max(0, rect.top)}px`;
    highlight.style.width = `${rect.width}px`;
    highlight.style.height = `${rect.height}px`;
  }

  _zapElement(element) {
    if (!element || !element.isConnected || this._isZapperUiNode(element)) {
      return;
    }

    try {
      element.remove();
    } catch (_) {
      element.style.setProperty("display", "none", "important");
    }

    this._setZapperTarget(null);
    this._restoreDocumentScrolling();
  }

  _restoreDocumentScrolling() {
    const doc = this.document;
    if (!doc) {
      return;
    }

    for (const element of [doc.documentElement, doc.body]) {
      if (!element?.style) {
        continue;
      }
      element.style.removeProperty("overflow");
      element.style.removeProperty("overflow-x");
      element.style.removeProperty("overflow-y");
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

    const proceduralActions = this._parseProceduralActions(
      resources.proceduralActions
    );
    if (proceduralActions.length) {
      this._proceduralActionFilters = proceduralActions;
      this._applyProceduralActions();
    } else {
      this._proceduralActionFilters = [];
    }

    if (!resources.generichide || proceduralActions.length) {
      this._setupGenericHideObserver(
        resources.exceptions || [],
        !resources.generichide
      );
    }
  }

  _hasInjectionTarget(doc) {
    return !!(doc.head || doc.documentElement || doc.body);
  }

  /**
   * Starts watching for DOM changes and refreshes selectors used in generic hiding.
   *
   * @param {string[]} exceptions Domain exceptions applied during generic hiding matches.
   * @param {boolean} shouldResolveGenericSelectors Whether class/id snapshots
   *   should be sent to the parent actor for generic hiding.
   */
  _setupGenericHideObserver(exceptions, shouldResolveGenericSelectors = true) {
    const doc = this.document;
    if (!doc) {
      return;
    }

    this._cosmeticExceptions = Array.isArray(exceptions) ? exceptions : [];
    this._queriedClasses = new Set();
    this._queriedIds = new Set();
    this._shouldResolveGenericSelectors = !!shouldResolveGenericSelectors;

    const contentWin = this.contentWindow;
    if (!contentWin) {
      return;
    }

    this._teardownGenericHideObserver();

    // Initial collect: full DOM scan to establish baseline.
    this._initialCollectTimeout = contentWin.setTimeout(() => {
      this._initialCollectTimeout = null;
      if (this._shouldResolveGenericSelectors) {
        const snapshot = this._collectClassIdSnapshot();
        for (const cls of snapshot.classes) {
          this._queriedClasses.add(cls);
        }
        for (const id of snapshot.ids) {
          this._queriedIds.add(id);
        }
        this._queryAndApplyNewSelectors(snapshot.classes, snapshot.ids);
      }
      if (this._proceduralActionFilters?.length) {
        this._applyProceduralActions();
      }
    }, 100);

    this._pendingClasses = [];
    this._pendingIds = [];

    this._observer = new contentWin.MutationObserver(mutations => {
      if (
        this._shouldResolveGenericSelectors &&
        this._queriedClasses.size + this._queriedIds.size >= MAX_QUERIED_TOKENS
      ) {
        this._shouldResolveGenericSelectors = false;
        if (!this._proceduralActionFilters?.length) {
          this._observer.disconnect();
          return;
        }
      }

      // Extract tokens immediately so we hold only strings, not DOM nodes.
      const delta = this._extractDeltaFromMutations(mutations);
      if (delta.classes.length) {
        this._pendingClasses.push(...delta.classes);
      }
      if (delta.ids.length) {
        this._pendingIds.push(...delta.ids);
      }

      if (delta.elements.length && this._proceduralActionFilters?.length) {
        this._applyProceduralActions(delta.elements);
      }

      if (!this._shouldResolveGenericSelectors) {
        return;
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
   * @returns {{classes: string[], elements: Element[], ids: string[]}}
   */
  _extractDeltaFromMutations(mutations) {
    const newClasses = [];
    const newElements = new Set();
    const newIds = [];
    const seenClasses = this._queriedClasses;
    const seenIds = this._queriedIds;

    const processElement = el => {
      if (!el || el.nodeType !== 1) {
        return;
      }

      newElements.add(el);

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
            for (const el of node.querySelectorAll("*")) {
              processElement(el);
            }
          }
        }
      } else if (mutation.type === "attributes") {
        processElement(mutation.target);
      }
    }

    return {
      classes: newClasses,
      elements: Array.from(newElements),
      ids: newIds,
    };
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

  _parseProceduralActions(actions) {
    if (!Array.isArray(actions)) {
      return [];
    }

    const out = [];
    for (const rawAction of actions) {
      let parsed = rawAction;
      try {
        if (typeof rawAction === "string") {
          parsed = JSON.parse(rawAction);
        }
      } catch (_) {
        continue;
      }

      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray(parsed.selector) ||
        !parsed.selector.length
      ) {
        continue;
      }

      out.push({
        action: parsed.action,
        selector: parsed.selector,
      });

      if (out.length >= MAX_PROCEDURAL_ACTIONS) {
        break;
      }
    }

    return out;
  }

  _applyProceduralActions(addedElements = undefined) {
    const doc = this.document;
    if (!doc || !this._proceduralActionFilters?.length) {
      return;
    }

    for (const { action, selector } of this._proceduralActionFilters) {
      try {
        let matchingElements;
        let startOperator = 0;

        if (
          addedElements === undefined &&
          selector[0]?.type === "css-selector"
        ) {
          matchingElements = Array.from(doc.querySelectorAll(selector[0].arg));
          startOperator = 1;
        } else if (addedElements === undefined) {
          matchingElements = Array.from(doc.querySelectorAll("*"));
        } else {
          matchingElements = addedElements;
        }

        const matches =
          startOperator === selector.length
            ? matchingElements
            : this._applyProceduralSelector(
                selector.slice(startOperator),
                matchingElements
              );

        for (const element of matches) {
          this._performProceduralAction(element, action);
        }
      } catch (err) {
        console.error("[WaterfoxBlockerChild] procedural action failed:", err);
      }
    }
  }

  _applyProceduralSelector(selector, initElements = undefined) {
    if (!Array.isArray(selector) || !selector.length) {
      return [];
    }

    let nodesToConsider = [];
    let startIndex = 0;
    const firstOperator = selector[0];

    if (initElements !== undefined) {
      nodesToConsider = Array.from(initElements).filter(
        el => el?.nodeType === 1
      );
    } else if (firstOperator.type === "css-selector") {
      nodesToConsider = Array.from(
        this.document.querySelectorAll(firstOperator.arg)
      );
      startIndex = 1;
    } else if (firstOperator.type === "xpath") {
      nodesToConsider = this._operatorXPath(
        firstOperator.arg,
        this.document.documentElement
      );
      startIndex = 1;
    } else {
      nodesToConsider = Array.from(this.document.querySelectorAll("*"));
    }

    for (
      let index = startIndex;
      nodesToConsider.length && index < selector.length;
      index++
    ) {
      const operator = selector[index];

      if (
        operator.type === "matches-media" ||
        operator.type === "matches-path"
      ) {
        if (
          !this._applyProceduralOperator(operator, nodesToConsider[0]).length
        ) {
          nodesToConsider = [];
        }
        continue;
      }

      const nextNodes = [];
      for (const element of nodesToConsider) {
        nextNodes.push(...this._applyProceduralOperator(operator, element));
      }
      nodesToConsider = nextNodes;
    }

    return nodesToConsider;
  }

  _applyProceduralOperator(operator, element) {
    if (!operator || !element || element.nodeType !== 1) {
      return [];
    }

    const arg = operator.arg;
    switch (operator.type) {
      case "contains":
      case "has-text":
        return this._matchesText(arg, element.innerText || "") ? [element] : [];

      case "css-selector":
        return this._operatorCssSelector(arg, element);

      case "has":
        return this._operatorHas(arg, element);

      case "matches-attr":
        return this._matchesKeyValueRule(
          arg,
          element.getAttributeNames(),
          name => element.getAttribute(name)
        )
          ? [element]
          : [];

      case "matches-css":
        return this._matchesCssRule(null, arg, element) ? [element] : [];

      case "matches-css-after":
        return this._matchesCssRule("::after", arg, element) ? [element] : [];

      case "matches-css-before":
        return this._matchesCssRule("::before", arg, element) ? [element] : [];

      case "matches-media":
        return this.contentWindow?.matchMedia(arg).matches ? [element] : [];

      case "matches-path":
        return this._matchesPathRule(arg) ? [element] : [];

      case "matches-property":
        return this._matchesPropertyRule(arg, element) ? [element] : [];

      case "min-text-length": {
        return this._operatorMinTextLength(arg, element);
      }

      case "not":
        return this._operatorNot(arg, element);

      case "upward":
        return this._operatorUpward(arg, element);

      case "xpath":
        return this._operatorXPath(arg, element);

      default:
        return [];
    }
  }

  _operatorHas(instruction, element) {
    if (Array.isArray(instruction)) {
      const initElements =
        instruction[0]?.type === "css-selector"
          ? [element]
          : Array.from(element.querySelectorAll("*"));
      return this._applyProceduralSelector(instruction, initElements).length
        ? [element]
        : [];
    }
    return element.querySelector(instruction) ? [element] : [];
  }

  _operatorMinTextLength(instruction, element) {
    const minLength = Number(instruction);
    return Number.isFinite(minLength) &&
      (element.innerText || "").trim().length >= minLength
      ? [element]
      : [];
  }

  _operatorNot(instruction, element) {
    if (Array.isArray(instruction)) {
      return this._applyProceduralSelector(instruction, [element]).length
        ? []
        : [element];
    }
    return element.matches(instruction) ? [] : [element];
  }

  _operatorCssSelector(selector, element) {
    const trimmed = String(selector || "").trimStart();
    try {
      if (trimmed.startsWith("+")) {
        const next = element.nextElementSibling;
        const subSelector = trimmed.slice(1).trimStart();
        return next?.matches(subSelector) ? [next] : [];
      }
      if (trimmed.startsWith("~")) {
        const subSelector = trimmed.slice(1).trimStart();
        const parent = element.parentElement;
        if (!parent) {
          return [];
        }
        return Array.from(parent.children).filter(
          sibling => sibling !== element && sibling.matches(subSelector)
        );
      }
      if (trimmed.startsWith(">")) {
        const subSelector = trimmed.slice(1).trimStart();
        return Array.from(element.children).filter(child =>
          child.matches(subSelector)
        );
      }
      if (String(selector || "").startsWith(" ")) {
        return Array.from(element.querySelectorAll(`:scope ${trimmed}`));
      }
      return element.matches(selector) ? [element] : [];
    } catch (_) {
      return [];
    }
  }

  _operatorUpward(instruction, element) {
    const distance = Number(instruction);
    if (Number.isInteger(distance)) {
      if (distance < 1 || distance >= 256) {
        return [];
      }
      let current = element;
      for (let i = 0; i < distance && current; i++) {
        current = current.parentElement;
      }
      return current ? [current] : [];
    }

    if (Array.isArray(instruction)) {
      let current = element;
      while (current) {
        if (this._applyProceduralSelector(instruction, [current]).length) {
          return [current];
        }
        current = current.parentElement;
      }
      return [];
    }

    let current = element;
    while (current) {
      try {
        if (current.matches(instruction)) {
          return [current];
        }
      } catch (_) {
        return [];
      }
      current = current.parentElement;
    }
    return [];
  }

  _operatorXPath(instruction, element) {
    const doc = this.document;
    if (!doc || !element) {
      return [];
    }

    try {
      const result = doc.evaluate(
        instruction,
        element,
        null,
        this.contentWindow.XPathResult.UNORDERED_NODE_ITERATOR_TYPE,
        null
      );
      const matches = [];
      let currentNode;
      while ((currentNode = result.iterateNext())) {
        if (currentNode.nodeType === 1) {
          matches.push(currentNode);
        }
      }
      return matches;
    } catch (_) {
      return [];
    }
  }

  _performProceduralAction(element, action) {
    if (!element || element.nodeType !== 1) {
      return;
    }

    if (!action) {
      element.style.setProperty("display", "none", "important");
      return;
    }

    switch (action.type) {
      case "style":
        if (typeof action.arg === "string" && action.arg.trim()) {
          element.style.cssText += `;${action.arg}`;
        }
        break;

      case "remove":
        element.remove();
        break;

      case "remove-attr":
        element.removeAttribute(action.arg);
        break;

      case "remove-class":
        if (element.classList?.contains(action.arg)) {
          element.classList.remove(action.arg);
        }
        break;
    }
  }

  _matchesCssRule(pseudoElement, instruction, element) {
    const separatorIndex = String(instruction || "").indexOf(":");
    if (separatorIndex <= 0) {
      return false;
    }

    const property = instruction.slice(0, separatorIndex).trim();
    const expected = instruction.slice(separatorIndex + 1).trim();
    let actual = "";
    try {
      actual = this.contentWindow
        .getComputedStyle(element, pseudoElement)
        .getPropertyValue(property);
    } catch (_) {
      return false;
    }

    return this._matchesText(expected, actual, true);
  }

  _matchesKeyValueRule(instruction, keys, valueGetter) {
    const [keyTest, valueTest] = this._parseKeyValueMatchRules(instruction);
    for (const key of keys) {
      if (!keyTest(key)) {
        continue;
      }
      const value = valueGetter(key);
      if (valueTest && !valueTest(String(value ?? ""))) {
        continue;
      }
      return true;
    }
    return false;
  }

  _matchesPathRule(instruction) {
    const location = this.contentWindow?.location;
    if (!location) {
      return false;
    }

    return this._matchesText(
      this._extractValueFromRule(instruction, true),
      `${location.pathname}${location.search}`
    );
  }

  _matchesPropertyRule(instruction, element) {
    const [keyTest, valueTest] = this._parseKeyValueMatchRules(instruction);
    for (const key of Object.keys(element)) {
      if (!keyTest(key)) {
        continue;
      }

      let value;
      try {
        value = element[key];
      } catch (_) {
        continue;
      }

      if (valueTest && !valueTest(String(value ?? ""))) {
        continue;
      }
      return true;
    }
    return false;
  }

  _parseKeyValueMatchRules(instruction) {
    const text = String(instruction || "");
    const [key, valueStart] = this._extractKeyFromRule(text);
    const keyTest = value => this._matchesText(key, value, true);
    if (valueStart === undefined) {
      return [keyTest, undefined];
    }

    const expectedValue = this._extractValueFromRule(text, false, valueStart);
    return [keyTest, value => this._matchesText(expectedValue, value, true)];
  }

  _extractKeyFromRule(text) {
    const isQuoted = text.startsWith('"');
    const start = isQuoted ? 1 : 0;
    const terminator = isQuoted ? '"=' : "=";
    const index = text.indexOf(terminator, start);
    if (index < 0) {
      return [
        isQuoted && text.endsWith('"') ? text.slice(1, -1) : text,
        undefined,
      ];
    }
    return [text.slice(start, index), index + terminator.length];
  }

  _extractValueFromRule(text, uriEncode = false, start = 0) {
    const isQuoted = text[start] === '"';
    const valueStart = isQuoted ? start + 1 : start;
    const valueEnd =
      isQuoted && text.endsWith('"') ? text.length - 1 : text.length;
    let value = text.slice(valueStart, valueEnd);
    if (uriEncode) {
      value = Array.from(value, char =>
        char.charCodeAt(0) > 0x7f ? encodeURIComponent(char) : char
      ).join("");
    }
    return value;
  }

  _matchesText(expected, actual, exact = false) {
    const test = String(expected || "");
    const value = String(actual || "");
    if (test.startsWith("/") && test.lastIndexOf("/") > 0) {
      try {
        const lastSlash = test.lastIndexOf("/");
        return new RegExp(
          test.slice(1, lastSlash),
          test.slice(lastSlash + 1)
        ).test(value);
      } catch (_) {
        return false;
      }
    }
    if (!test) {
      return !value.trim();
    }
    return exact ? value === test : value.includes(test);
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
