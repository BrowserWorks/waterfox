/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { toSafeDomain } from "resource:///modules/WaterfoxBlockerUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  NetUtil: "resource://gre/modules/NetUtil.sys.mjs",
});

const COSMETIC_STYLE_ID = "waterfox-blocker-cosmetic-style";
const FARBLING_SCRIPT_URL =
  "chrome://browser/content/blocker/waterfoxFarbling.js";
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
const PICKER_PANEL_ID = "waterfox-blocker-picker-panel";
const PICKER_PICK_ANOTHER_BUTTON_ID = "waterfox-blocker-picker-pick-another";
const PICKER_PREVIEW_BUTTON_ID = "waterfox-blocker-picker-preview";
const PICKER_CREATE_BUTTON_ID = "waterfox-blocker-picker-create";
const PICKER_NEXT_BUTTON_ID = "waterfox-blocker-picker-next";
const PICKER_PREVIOUS_BUTTON_ID = "waterfox-blocker-picker-previous";
const PICKER_RULE_ID = "waterfox-blocker-picker-rule";
const PICKER_SELECTION_ID = "waterfox-blocker-picker-selection";
const PICKER_STATUS_ID = "waterfox-blocker-picker-status";
const PICKER_Z_INDEX = 2147483647;

let gFarblingScriptTextPromise = null;

function readChromeText(url) {
  if (!gFarblingScriptTextPromise) {
    gFarblingScriptTextPromise = new Promise((resolve, reject) => {
      lazy.NetUtil.asyncFetch(
        { uri: url, loadUsingSystemPrincipal: true },
        (inputStream, status) => {
          if (!Components.isSuccessCode(status)) {
            reject(Components.Exception(`Failed to load ${url}`, status));
            return;
          }

          try {
            resolve(
              lazy.NetUtil.readInputStreamToString(
                inputStream,
                inputStream.available(),
                {
                  charset: "utf-8",
                }
              )
            );
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  }

  return gFarblingScriptTextPromise;
}

/*
 * Module rationale:
 *
 * This child actor runs in content processes and applies cosmetic filtering
 * and scriptlet decisions from the blocker to live documents.
 *
 * Scriptlets need execution in page scope, not in actor scope. We compile them
 * as page scripts and execute them in the content window global, matching the
 * Gecko WebExtensions MAIN-world path and avoiding page CSP checks that would
 * block DOM `<script>` insertion.
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
      this._flushInitialResources().catch(err => {
        console.error(
          "[WaterfoxBlockerChild] failed flushing initial resources:",
          err
        );
      });
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

    let initial;
    try {
      initial = await this.sendQuery("WaterfoxBlocker:GetInitialResources", {
        url,
      });
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] sendQuery(GetInitialResources) failed:",
        err
      );
      return;
    }

    // Allow strict shields to run even when the blocker service is disabled.
    if (!initial?.enabled && !initial?.shieldLevel) {
      return;
    }

    if (initial.enabled) {
      const resources = initial.resources;
      if (resources) {
        this._pendingInitialResources = resources;
        await this._flushInitialResources();

        if (this._isInitialResourcesResponseEmpty(resources)) {
          this._scheduleInitialResourcesRetry(doc);
        }
      }
    }

    if (initial.shieldLevel >= 2) {
      void this._injectFarblingScript(doc);
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
    this._pickerPanel = overlay.querySelector(`#${PICKER_PANEL_ID}`);
    this._pickerRule = overlay.querySelector(`#${PICKER_RULE_ID}`);
    this._pickerSelection = overlay.querySelector(`#${PICKER_SELECTION_ID}`);
    this._pickerStatus = overlay.querySelector(`#${PICKER_STATUS_ID}`);
    this._pickerCandidates = [];
    this._pickerCandidateIndex = 0;
    this._pickerPaused = false;
    this._pickerPreviewEnabled = true;
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
    this._boundPickerButtonClick ||= event => {
      this._onPickerButtonClick(event);
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
    overlay.addEventListener("click", this._boundPickerButtonClick, true);

    this._setPickerPaused(false);
    this._clearPickerPreview();
    this._updatePickerStatus("Click an element to inspect candidate rules.");
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

    this._pickerOverlay?.removeEventListener(
      "click",
      this._boundPickerButtonClick,
      true
    );

    if (doc?.documentElement?.style) {
      doc.documentElement.style.cursor = this._pickerOriginalCursor || "";
    }
    if (doc?.body?.style) {
      doc.body.style.cursor = this._pickerOriginalBodyCursor || "";
    }

    this._pickerActive = false;
    this._pickerPaused = false;
    this._pickerCandidates = [];
    this._pickerCandidateIndex = 0;
    this._pickerPreviewEnabled = true;
    this._pickerPanel = null;
    this._pickerRule = null;
    this._pickerSelection = null;
    this._pickerTarget = null;
    this._pickerHighlight = null;
    this._pickerStatus = null;
    this._clearPickerPreview();
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
    status.textContent = "Click an element to inspect candidate rules.";
    overlay.appendChild(status);

    const panel = doc.createElement("div");
    panel.id = PICKER_PANEL_ID;
    panel.style.cssText = `
      position: fixed;
      top: 92px;
      left: 16px;
      width: min(520px, calc(100vw - 32px));
      max-height: calc(100vh - 124px);
      display: none;
      box-sizing: border-box;
      padding: 12px;
      border-radius: 8px;
      background: rgba(20, 20, 28, 0.96);
      color: #fff;
      font: 13px/1.45 system-ui, sans-serif;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      pointer-events: auto;
      overflow: auto;
    `;

    const selection = doc.createElement("div");
    selection.id = PICKER_SELECTION_ID;
    selection.style.cssText = `
      margin-bottom: 8px;
      font-weight: 600;
      color: rgba(255, 255, 255, 0.92);
    `;
    selection.textContent = "Candidate 0 of 0";
    panel.appendChild(selection);

    const rule = doc.createElement("textarea");
    rule.id = PICKER_RULE_ID;
    rule.readOnly = true;
    rule.rows = 4;
    rule.style.cssText = `
      width: 100%;
      min-height: 88px;
      box-sizing: border-box;
      margin: 0 0 10px;
      padding: 10px 12px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 6px;
      background: rgba(10, 10, 16, 0.84);
      color: inherit;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      resize: vertical;
    `;
    panel.appendChild(rule);

    const actions = doc.createElement("div");
    actions.style.cssText = `
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    `;

    for (const buttonSpec of [
      {
        id: PICKER_PREVIOUS_BUTTON_ID,
        label: "Previous",
      },
      {
        id: PICKER_NEXT_BUTTON_ID,
        label: "Next",
      },
      {
        id: PICKER_PREVIEW_BUTTON_ID,
        label: "Preview on",
      },
      {
        id: PICKER_PICK_ANOTHER_BUTTON_ID,
        label: "Pick another",
      },
      {
        id: PICKER_CREATE_BUTTON_ID,
        label: "Create rule",
      },
      {
        id: PICKER_CLOSE_BUTTON_ID,
        label: "Close",
      },
    ]) {
      const button = doc.createElement("button");
      button.id = buttonSpec.id;
      button.type = "button";
      button.textContent = buttonSpec.label;
      button.style.cssText = `
        border: 0;
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.14);
        color: inherit;
        font: inherit;
        padding: 7px 10px;
        cursor: pointer;
      `;
      actions.appendChild(button);
    }

    panel.appendChild(actions);
    overlay.appendChild(panel);

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
    if (!this._pickerActive || this._pickerPaused) {
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

    if (this._isPickerUiNode(event.target)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
  }

  async _onPickerClick(event) {
    if (!this._pickerActive || event.button !== 0) {
      return;
    }

    if (this._isPickerUiNode(event.target)) {
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

    const candidates = this._buildPickerCandidates(
      target,
      event.clientX,
      event.clientY
    );
    if (!candidates.length) {
      this._updatePickerStatus("Could not build any candidate rules.");
      return;
    }

    this._pickerCandidates = candidates;
    this._pickerCandidateIndex = 0;
    this._setPickerPaused(true);
    this._applyCurrentPickerCandidate();
  }

  _onPickerKeyDown(event) {
    if (!this._pickerActive) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this._stopElementPicker();
      return;
    }

    if (!this._pickerPaused) {
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void this._createCurrentPickerRule();
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      this._stepPickerCandidate(-1);
      return;
    }

    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      this._stepPickerCandidate(1);
      return;
    }

    if (event.key.toLowerCase() === "p") {
      event.preventDefault();
      event.stopPropagation();
      this._togglePickerPreview();
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
      node?.id === PICKER_PANEL_ID ||
      node?.id === PICKER_PICK_ANOTHER_BUTTON_ID ||
      node?.id === PICKER_PREVIEW_BUTTON_ID ||
      node?.id === PICKER_CREATE_BUTTON_ID ||
      node?.id === PICKER_NEXT_BUTTON_ID ||
      node?.id === PICKER_PREVIOUS_BUTTON_ID ||
      node?.id === PICKER_RULE_ID ||
      node?.id === PICKER_SELECTION_ID ||
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
      this._updatePickerStatus("Click an element to inspect candidate rules.");
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

    if (!this._pickerPaused) {
      const generated = this._buildCosmeticRuleForElement(target);
      if (generated) {
        this._updatePickerStatus(`Candidate rule:\n${generated.rule}`);
      }
    }
  }

  _updatePickerStatus(text) {
    if (this._pickerStatus) {
      this._pickerStatus.textContent = String(text || "");
    }
  }

  _onPickerButtonClick(event) {
    const buttonId = event.target?.id;
    if (!buttonId) {
      return;
    }

    switch (buttonId) {
      case PICKER_CLOSE_BUTTON_ID:
        event.preventDefault();
        event.stopPropagation();
        this._stopElementPicker();
        break;

      case PICKER_PICK_ANOTHER_BUTTON_ID:
        event.preventDefault();
        event.stopPropagation();
        this._setPickerPaused(false);
        this._updatePickerHighlight();
        break;

      case PICKER_PREVIOUS_BUTTON_ID:
        event.preventDefault();
        event.stopPropagation();
        this._stepPickerCandidate(-1);
        break;

      case PICKER_NEXT_BUTTON_ID:
        event.preventDefault();
        event.stopPropagation();
        this._stepPickerCandidate(1);
        break;

      case PICKER_PREVIEW_BUTTON_ID:
        event.preventDefault();
        event.stopPropagation();
        this._togglePickerPreview();
        break;

      case PICKER_CREATE_BUTTON_ID:
        event.preventDefault();
        event.stopPropagation();
        void this._createCurrentPickerRule();
        break;
    }
  }

  _setPickerPaused(paused) {
    this._pickerPaused = !!paused;
    if (this._pickerPanel) {
      this._pickerPanel.style.display = this._pickerPaused ? "block" : "none";
    }
    if (!this._pickerPaused) {
      this._pickerCandidates = [];
      this._pickerCandidateIndex = 0;
      this._clearPickerPreview();
      if (this._pickerSelection) {
        this._pickerSelection.textContent = "Candidate 0 of 0";
      }
      if (this._pickerRule) {
        this._pickerRule.value = "";
      }
      this._updatePickerPreviewButton();
      this._updatePickerStatus("Click an element to inspect candidate rules.");
    }
  }

  _stepPickerCandidate(offset) {
    if (!this._pickerCandidates?.length) {
      return;
    }

    const count = this._pickerCandidates.length;
    this._pickerCandidateIndex =
      (this._pickerCandidateIndex + offset + count) % count;
    this._applyCurrentPickerCandidate();
  }

  _togglePickerPreview() {
    this._pickerPreviewEnabled = !this._pickerPreviewEnabled;
    if (!this._pickerPreviewEnabled) {
      this._clearPickerPreview();
    } else {
      this._applyCurrentPickerPreview();
    }
    this._updatePickerPreviewButton();
  }

  _updatePickerPreviewButton() {
    const button = this.document?.getElementById(PICKER_PREVIEW_BUTTON_ID);
    if (button) {
      button.textContent = this._pickerPreviewEnabled
        ? "Preview on"
        : "Preview off";
    }
  }

  _applyCurrentPickerCandidate() {
    const candidate = this._pickerCandidates?.[this._pickerCandidateIndex];
    if (!candidate) {
      return;
    }

    if (this._pickerSelection) {
      this._pickerSelection.textContent = `Candidate ${
        this._pickerCandidateIndex + 1
      } of ${this._pickerCandidates.length} (${candidate.kind})`;
    }
    if (this._pickerRule) {
      this._pickerRule.value = candidate.rule;
    }
    this._applyCurrentPickerPreview();
    this._updatePickerStatus(
      "Review the candidate, preview it, or create the rule."
    );
  }

  _applyCurrentPickerPreview() {
    this._clearPickerPreview();
    if (!this._pickerPreviewEnabled) {
      return;
    }

    const candidate = this._pickerCandidates?.[this._pickerCandidateIndex];
    if (!candidate) {
      return;
    }

    if (candidate.kind === "cosmetic" && candidate.selector) {
      this._applyPickedRulePreview(candidate.selector);
      return;
    }

    if (candidate.kind !== "network") {
      return;
    }

    const doc = this.document;
    if (!doc) {
      return;
    }

    const matches = this._queryElementsForNetworkRule(candidate.rule);
    if (!matches.length) {
      return;
    }

    let style = doc.getElementById(`${PICKER_OVERLAY_ID}-style`);
    if (!style) {
      style = doc.createElement("style");
      style.id = `${PICKER_OVERLAY_ID}-style`;
      (doc.head || doc.documentElement || doc.body)?.appendChild(style);
    }
    style.textContent =
      '[data-waterfox-blocker-picker-preview="true"] { display: none !important; }';

    for (const match of matches) {
      match.setAttribute("data-waterfox-blocker-picker-preview", "true");
    }
  }

  _clearPickerPreview() {
    const doc = this.document;
    if (!doc) {
      return;
    }

    doc
      .querySelectorAll('[data-waterfox-blocker-picker-preview="true"]')
      .forEach(node =>
        node.removeAttribute("data-waterfox-blocker-picker-preview")
      );

    doc.getElementById(`${PICKER_OVERLAY_ID}-style`)?.remove();
  }

  async _createCurrentPickerRule() {
    const candidate = this._pickerCandidates?.[this._pickerCandidateIndex];
    if (!candidate) {
      return;
    }

    this._updatePickerStatus(`Saving rule:\n${candidate.rule}`);
    const result = await this._commitPickedRule(candidate);
    if (!result?.ok) {
      this._updatePickerStatus(
        "Could not save the rule. Try another candidate."
      );
      return;
    }

    if (candidate.kind === "cosmetic" && candidate.selector) {
      this._applyCommittedPickerRule(candidate.selector);
    }

    this._notifyPickedElementRule(
      candidate.rule,
      candidate.selector || "",
      !!result.added
    );
    this._stopElementPicker();
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

  _applyCommittedPickerRule(selector) {
    const doc = this.document;
    if (!doc || !selector) {
      return;
    }

    const [cleanSelector] = this._normalizeSelectors([selector]);
    if (!cleanSelector) {
      return;
    }

    const style = this._ensureStyleElement(doc);
    if (!style) {
      return;
    }

    const sheet = style.sheet;
    if (!sheet) {
      return;
    }

    for (const rule of sheet.cssRules) {
      if (rule?.selectorText === cleanSelector) {
        return;
      }
    }

    try {
      sheet.insertRule(
        `${cleanSelector} { display: none !important; }`,
        sheet.cssRules.length
      );
    } catch (_) {}
  }

  _buildPickerCandidates(target, clientX, clientY) {
    const host = toSafeDomain(
      this.document?.location?.hostname || this.document?.location?.host || ""
    );
    if (!host || !target) {
      return [];
    }

    const candidates = [];
    const seen = new Set();
    const elementsAtPoint = this._getPickerElementsAtPoint(clientX, clientY);

    for (const candidate of this._buildNetworkCandidates(
      elementsAtPoint,
      host
    )) {
      if (seen.has(candidate.rule)) {
        continue;
      }
      seen.add(candidate.rule);
      candidates.push(candidate);
    }

    for (const candidate of this._buildCosmeticCandidates(target, host)) {
      if (seen.has(candidate.rule)) {
        continue;
      }
      seen.add(candidate.rule);
      candidates.push(candidate);
    }

    return candidates;
  }

  _getPickerElementsAtPoint(clientX, clientY) {
    const doc = this.document;
    if (!doc || typeof clientX !== "number" || typeof clientY !== "number") {
      return [];
    }

    if (this._pickerOverlay) {
      this._pickerOverlay.style.display = "none";
    }

    let elements = [];
    try {
      elements = Array.from(doc.elementsFromPoint(clientX, clientY) || []);
    } catch (_) {
      elements = [];
    }

    if (this._pickerOverlay) {
      this._pickerOverlay.style.display = "";
    }

    return elements.filter(
      element =>
        element &&
        element.nodeType === 1 &&
        !this._isPickerUiNode(element) &&
        element !== doc.documentElement &&
        element !== doc.body
    );
  }

  _buildNetworkCandidates(elements, host) {
    const candidates = [];
    const seen = new Set();

    for (const element of elements) {
      for (const resource of this._resourceURLsFromElement(element)) {
        const urls = [resource.url];
        const fullRule = this._formatNetworkRule(resource.url, resource.option);
        if (fullRule && !seen.has(fullRule)) {
          seen.add(fullRule);
          candidates.push({
            host,
            kind: "network",
            option: resource.option,
            rule: fullRule,
            selector: "",
            url: resource.url,
          });
        }

        const questionIndex = resource.url.indexOf("?");
        if (questionIndex > 0) {
          const trimmedUrl = resource.url.slice(0, questionIndex);
          const trimmedRule = this._formatNetworkRule(
            trimmedUrl,
            resource.option
          );
          if (trimmedRule && !seen.has(trimmedRule)) {
            seen.add(trimmedRule);
            candidates.push({
              host,
              kind: "network",
              option: resource.option,
              rule: trimmedRule,
              selector: "",
              url: trimmedUrl,
            });
          }
        }

        if (urls.length >= 4) {
          break;
        }
      }
    }

    return candidates;
  }

  _formatNetworkRule(url, option = "") {
    const normalized = String(url || "").replace(/^https?:\/\//i, "");
    if (!normalized) {
      return "";
    }

    return option ? `||${normalized}$${option}` : `||${normalized}`;
  }

  _resourceURLsFromElement(element) {
    const resources = [];
    const seen = new Set();

    const addResource = (value, option = "") => {
      const normalized = this._normalizePickerUrl(value);
      if (!normalized || seen.has(`${normalized}|${option}`)) {
        return;
      }
      seen.add(`${normalized}|${option}`);
      resources.push({ option, url: normalized });
    };

    switch (String(element.localName || "").toLowerCase()) {
      case "img":
        addResource(element.currentSrc || element.getAttribute("src"), "image");
        break;
      case "iframe":
        addResource(element.getAttribute("src"), "subdocument");
        break;
      case "audio":
      case "video":
        addResource(element.currentSrc || element.getAttribute("src"), "media");
        break;
      case "source":
        addResource(element.currentSrc || element.getAttribute("src"), "media");
        break;
      case "embed":
      case "object":
        addResource(
          element.getAttribute("src") || element.getAttribute("data"),
          "object"
        );
        break;
      case "a":
        addResource(element.getAttribute("href"), "popup");
        break;
    }

    const backgroundImage = this._backgroundImageURLFromElement(element);
    if (backgroundImage) {
      addResource(backgroundImage, "image");
    }

    return resources;
  }

  _normalizePickerUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("data:") || raw.startsWith("blob:")) {
      return "";
    }

    try {
      const url = new URL(raw, this.document?.location?.href || undefined);
      if (url.protocol === "http:" || url.protocol === "https:") {
        return url.href;
      }
    } catch (_) {}

    return "";
  }

  _backgroundImageURLFromElement(element) {
    try {
      const image =
        this.contentWindow?.getComputedStyle(element)?.backgroundImage;
      const match = /url\((["']?)(.*?)\1\)/.exec(image || "");
      return this._normalizePickerUrl(match?.[2] || "");
    } catch (_) {
      return "";
    }
  }

  _buildCosmeticCandidates(element, host) {
    const candidates = [];
    const selectors = [];
    let current = element;
    while (
      current &&
      current.nodeType === 1 &&
      current !== this.document?.body
    ) {
      const selector = this._buildPickerSelectorForElement(current);
      if (!selector) {
        break;
      }

      selectors.push(selector);

      let combined = selectors[0];
      for (let i = 1; i < selectors.length; i++) {
        combined = `${selectors[i]} > ${combined}`;
      }

      candidates.push({
        host,
        kind: "cosmetic",
        rule: `${host}##${combined}`,
        selector: combined,
      });

      current = current.parentElement;
    }

    if (candidates.length) {
      const finalSelector = candidates[candidates.length - 1].selector;
      if (
        finalSelector &&
        !finalSelector.startsWith("#") &&
        !finalSelector.startsWith("body > ") &&
        this._countSelectorMatches(finalSelector) > 1
      ) {
        candidates.push({
          host,
          kind: "cosmetic",
          rule: `${host}##body > ${finalSelector}`,
          selector: `body > ${finalSelector}`,
        });
      }
    }

    return candidates;
  }

  _queryElementsForNetworkRule(rule) {
    const doc = this.document;
    if (!doc || !rule.startsWith("||")) {
      return [];
    }

    const [pattern, option] = rule.split("$");
    const needle = pattern.slice(2);
    if (!needle) {
      return [];
    }

    let selector = "a,audio,embed,iframe,img,object,source,video,*";
    switch (option) {
      case "subdocument":
        selector = "iframe";
        break;
      case "image":
        selector = "img";
        break;
      case "media":
        selector = "audio,source,video";
        break;
      case "object":
        selector = "embed,object";
        break;
    }

    const matches = [];
    for (const element of doc.querySelectorAll(selector)) {
      const resources = this._resourceURLsFromElement(element);
      if (
        resources.some(resource =>
          resource.url.replace(/^https?:\/\//i, "").startsWith(needle)
        )
      ) {
        matches.push(element);
      }
    }
    return matches;
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

    const selector = this._buildPickerCosmeticSelector(element);
    if (!selector) {
      return null;
    }

    return {
      host,
      rule: `${host}##${selector}`,
      selector,
    };
  }

  _buildPickerCosmeticSelector(element) {
    const doc = this.document;
    if (!doc || !element || !element.isConnected) {
      return "";
    }

    const selectors = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== doc.body) {
      const selector = this._buildPickerSelectorForElement(current);
      if (!selector) {
        break;
      }

      selectors.push(selector);

      current = current.parentElement;
      if (!current || current === doc.documentElement) {
        break;
      }
    }

    if (!selectors.length) {
      return "";
    }

    let candidate = selectors[0];
    if (this._countSelectorMatches(candidate) <= 1) {
      return candidate;
    }

    for (let i = 1; i < selectors.length; i++) {
      candidate = `${selectors[i]} > ${candidate}`;
      if (this._countSelectorMatches(candidate) <= 1) {
        return candidate;
      }
    }

    if (
      doc.body &&
      !candidate.startsWith("#") &&
      !candidate.startsWith("body > ")
    ) {
      const bodyCandidate = `body > ${candidate}`;
      if (this._countSelectorMatches(bodyCandidate) <= 1) {
        return bodyCandidate;
      }
      return bodyCandidate;
    }

    return candidate;
  }

  _countSelectorMatches(selector) {
    const doc = this.document;
    if (!doc || !selector) {
      return Number.POSITIVE_INFINITY;
    }

    try {
      return doc.querySelectorAll(selector).length;
    } catch (_) {
      return Number.POSITIVE_INFINITY;
    }
  }

  _countScopedSelectorMatches(parent, selector) {
    if (!parent || !selector) {
      return Number.POSITIVE_INFINITY;
    }

    try {
      return parent.querySelectorAll(`:scope > ${selector}`).length;
    } catch (_) {
      return Number.POSITIVE_INFINITY;
    }
  }

  _buildPickerSelectorForElement(element) {
    const doc = this.document;
    if (!doc || !element || element.nodeType !== 1) {
      return "";
    }

    const tagName = this._escapeCssIdentifier(
      String(element.localName || "").toLowerCase()
    );
    if (!tagName) {
      return "";
    }

    let selector = "";

    const idValue = String(element.id || "").trim();
    if (idValue) {
      const escapedId = this._escapeCssIdentifier(idValue);
      if (escapedId) {
        selector = `#${escapedId}`;
      }
    }

    if (element.classList?.length) {
      for (let i = element.classList.length - 1; i >= 0; i--) {
        const className = this._escapeCssIdentifier(element.classList.item(i));
        if (className) {
          selector += `.${className}`;
        }
      }
    }

    if (!selector) {
      selector = this._buildPickerAttributeSelector(element, tagName);
    }

    const parent = element.parentElement || element.parentNode;
    if (!selector || this._countScopedSelectorMatches(parent, selector) > 1) {
      selector = `${tagName}${selector}`;
    }

    if (this._countScopedSelectorMatches(parent, selector) > 1) {
      let index = 1;
      let previous = element.previousSibling;
      while (previous !== null) {
        if (
          typeof previous.localName === "string" &&
          previous.localName === element.localName
        ) {
          index++;
        }
        previous = previous.previousSibling;
      }
      if (index > 0) {
        selector += `:nth-of-type(${index})`;
      }
    }

    return selector;
  }

  _buildPickerAttributeSelector(element, tagName) {
    switch (tagName) {
      case "a": {
        let href = element.getAttribute("href");
        if (href) {
          href = href.trim().replace(/\?.*$/, "");
          if (href.length) {
            return this._formatPickerAttributeSelector(element, "href", href);
          }
        }
        break;
      }

      case "iframe":
      case "img": {
        let src = element.getAttribute("src");
        if (src && src.length !== 0) {
          src = src.trim();
          if (src.startsWith("data:")) {
            const pos = src.indexOf(",");
            if (pos !== -1) {
              src = src.slice(0, pos + 1);
            }
          } else if (src.startsWith("blob:")) {
            try {
              const url = new URL(src.slice(5));
              url.pathname = "";
              src = `blob:${url.href}`;
            } catch (_) {}
          }

          return this._formatPickerAttributeSelector(
            element,
            "src",
            src.slice(0, 256)
          );
        }

        const alt = element.getAttribute("alt");
        if (alt && alt.length !== 0) {
          return this._formatPickerAttributeSelector(element, "alt", alt);
        }
        break;
      }

      default:
        break;
    }

    return "";
  }

  _formatPickerAttributeSelector(element, key, value) {
    const rawValue = String(value || "");
    if (!rawValue) {
      return "";
    }

    const actualValue = String(element.getAttribute(key) || "");
    if (!actualValue) {
      return "";
    }

    const escapedValue = rawValue.replace(/([^\\])"/g, '$1\\"');
    if (rawValue === actualValue) {
      return `[${key}="${escapedValue}"]`;
    }
    if (actualValue.startsWith(rawValue)) {
      return `[${key}^="${escapedValue}"]`;
    }
    return `[${key}*="${escapedValue}"]`;
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
    await this._flushInitialResources();
  }

  /**
   * Applies pending initial resources once the document has an injection target.
   */
  async _flushInitialResources() {
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
      await this._injectScriptlet(resources.injectedScript);
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
   * Wraps code so top-level scriptlet globals resolve like page globals.
   *
   * @param {string} scriptText Script source to run.
   * @param {string} [prelude] Additional source to run before the payload.
   * @returns {string}
   */
  _wrapPageScopeScript(scriptText, prelude = "") {
    return `
(function(window, self, globalThis, document) {
${prelude}
${scriptText}
}).call(window, window, window, window, window.document);
`;
  }

  /**
   * Executes JavaScript in the page's main global without using DOM script tags.
   *
   * This mirrors Gecko's WebExtensions MAIN-world implementation: compile the
   * string to a PrecompiledScript, then execute it in the content window global.
   * That preserves page-scope behaviour while avoiding strict page CSP.
   *
   * @param {string} scriptText Script source to run.
   * @param {string} filename Redacted filename shown in developer tooling.
   * @returns {Promise<boolean>} Whether the script ran.
   */
  async _executePageScopeScript(scriptText, filename) {
    const targetWindow = this.contentWindow;
    const targetDocument = this.document;
    if (!targetWindow || !targetDocument || !scriptText) {
      return false;
    }

    try {
      const dataUrl = `data:text/javascript;charset=utf-8,${encodeURIComponent(
        scriptText
      )}`;
      const script = await ChromeUtils.compileScript(dataUrl, {
        filename,
      });

      if (
        this.contentWindow !== targetWindow ||
        this.document !== targetDocument
      ) {
        return false;
      }

      script.executeInGlobal(targetWindow, { reportExceptions: true });
      return true;
    } catch (err) {
      console.error("[WaterfoxBlockerChild] page-scope script failed:", err);
      return false;
    }
  }

  /**
   * Injects one scriptlet payload into page scope.
   *
   * @param {string} scriptText Script source to inject.
   * @returns {Promise<boolean>} Whether the scriptlet ran.
   */
  async _injectScriptlet(scriptText) {
    const doc = this.document;
    if (!doc || !scriptText) {
      return false;
    }

    const prelude = `
const scriptletGlobals = (() => {
  const forwardedMapMethods = ["has", "get", "set"];
  const handler = {
    get(target, prop) {
      if (forwardedMapMethods.includes(prop)) {
        return Map.prototype[prop].bind(target);
      }
      return target.get(prop);
    },
    set(target, prop, value) {
      if (!forwardedMapMethods.includes(prop)) {
        target.set(prop, value);
      }
      return true;
    },
  };
  return new Proxy(new Map(), handler);
})();
let deAmpEnabled = false;
`;

    return this._executePageScopeScript(
      this._wrapPageScopeScript(scriptText, prelude),
      "waterfox-blocker-scriptlet.js"
    );
  }

  async _injectFarblingScript(doc) {
    if (!doc) {
      return;
    }

    const sessionToken = Math.trunc(Math.random() * 0xffffffff);

    try {
      const scriptText = await readChromeText(FARBLING_SCRIPT_URL);
      await this._executePageScopeScript(
        this._wrapPageScopeScript(
          scriptText,
          `globalThis.__waterfoxFarblingSession__ = ${sessionToken};`
        ),
        "waterfox-farbling.js"
      );
    } catch (err) {
      console.error(
        "[WaterfoxBlockerChild] failed to inject farbling script:",
        err
      );
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
