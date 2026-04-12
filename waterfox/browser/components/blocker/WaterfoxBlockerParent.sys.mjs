/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WaterfoxBlockerService } from "resource:///modules/WaterfoxBlockerService.sys.mjs";

/*
 * Module rationale:
 *
 * This parent actor is the privileged bridge between blocker logic running in
 * content processes and the blocker service in the parent process.
 *
 * The child actor cannot call service APIs directly, so the IPC surface here
 * is intentionally small: cosmetic resource lookup for the current document
 * URL, and resolution of selectors from class/id snapshots for generic hiding.
 * Payloads are normalised here so the child always sees the same keys,
 * regardless of what the service returns internally.
 */

/**
 * Cosmetic resources returned to the child actor.
 *
 * @typedef {object} CosmeticResourcesResponse
 * @property {string[]} exceptions
 * @property {boolean} generichide
 * @property {string[]} hideSelectors
 * @property {string} injectedScript
 * @property {Array<any>} proceduralActions
 */

/**
 * Selector snapshot request forwarded from the child actor.
 *
 * @typedef {object} HiddenSelectorRequest
 * @property {string[]} [classes]
 * @property {string[]} [ids]
 * @property {string[]} [exceptions]
 */

/**
 * JSWindowActor in the parent process that answers blocker resource queries
 * from the child actor.
 */
export class WaterfoxBlockerParent extends JSWindowActorParent {
  /**
   * Routes incoming child actor messages to blocker service APIs.
   *
   * @param {object} message
   * @param {string} message.name
   * @param {object} [message.data]
   *   Message envelope emitted by `WaterfoxBlockerChild`.
   * @returns {CosmeticResourcesResponse|string[]|null|undefined}
   *   A normalised response for handled messages, `null` for invalid resource
   *   lookups, or `undefined` for unhandled message names.
   */
  receiveMessage(message) {
    switch (message.name) {
      case "WaterfoxBlocker:IsEnabled":
        return WaterfoxBlockerService.isEnabled();
      case "WaterfoxBlocker:GetCosmeticResources":
        return this._getCosmeticResources(message.data);
      case "WaterfoxBlocker:GetHiddenClassIdSelectors":
        return this._getHiddenClassIdSelectors(message.data);
      case "WaterfoxBlocker:CommitPickedRule":
        return this._commitPickedRule(message.data);
      case "WaterfoxBlocker:ZapperStateChanged":
        this._notifyZapperStateChanged(message.data);
        return undefined;
      case "WaterfoxBlocker:PickerStateChanged":
        this._notifyPickerStateChanged(message.data);
        return undefined;
      case "WaterfoxBlocker:PickedElementRule":
        this._notifyPickerRuleAdded(message.data);
        return undefined;
      default:
        return undefined;
    }
  }

  _notifyZapperStateChanged({ active } = {}) {
    const browserId = Number(this.browsingContext?.top?.browserId || 0);
    if (!browserId) {
      return;
    }

    Services.obs.notifyObservers(
      {
        wrappedJSObject: {
          active: !!active,
          browserId,
        },
      },
      "WaterfoxBlocker:ZapperStateChanged"
    );
  }

  _notifyPickerStateChanged({ active } = {}) {
    const browserId = Number(this.browsingContext?.top?.browserId || 0);
    if (!browserId) {
      return;
    }

    Services.obs.notifyObservers(
      {
        wrappedJSObject: {
          active: !!active,
          browserId,
        },
      },
      "WaterfoxBlocker:PickerStateChanged"
    );
  }

  _notifyPickerRuleAdded({ rule = "", selector = "", added = false } = {}) {
    if (!added) {
      return;
    }

    const browserId = Number(this.browsingContext?.top?.browserId || 0);
    if (!browserId) {
      return;
    }

    Services.obs.notifyObservers(
      {
        wrappedJSObject: {
          added: !!added,
          browserId,
          rule,
          selector,
        },
      },
      "WaterfoxBlocker:PickerRuleAdded"
    );
  }

  /**
   * Resolves cosmetic resources for a URL and normalises the response shape.
   *
   * @param {object} [data={}]
   * @param {string} [data.url]
   *   Message payload containing the document URL.
   * @returns {CosmeticResourcesResponse|null}
   *   Normalised cosmetic resources, or `null` when URL is missing or no
   *   resources are available.
   */
  _getCosmeticResources({ url } = {}) {
    if (!url) {
      return null;
    }

    let hostname = "";
    try {
      hostname = new URL(url).hostname || "";
    } catch (_) {}

    if (
      hostname &&
      WaterfoxBlockerService.isCosmeticFilteringDisabled(hostname)
    ) {
      return {
        exceptions: [],
        generichide: true,
        hideSelectors: [],
        injectedScript: "",
        proceduralActions: [],
      };
    }

    const resources = WaterfoxBlockerService.getCosmeticResources(url);
    if (!resources) {
      return null;
    }

    return {
      exceptions: resources.exceptions || [],
      generichide: !!resources.generichide,
      hideSelectors: resources.hide_selectors || [],
      injectedScript: resources.injected_script || "",
      proceduralActions: resources.procedural_actions || [],
    };
  }

  /**
   * Resolves selectors used in generic hiding from class/id snapshot data.
   *
   * @param {HiddenSelectorRequest} [data={}]
   *   Snapshot payload with classes, ids, and exception domains.
   * @returns {string[]}
   *   Matching selectors to hide in the content document.
   */
  _getHiddenClassIdSelectors({ classes, ids, exceptions } = {}) {
    return WaterfoxBlockerService.getHiddenClassIdSelectors(
      classes || [],
      ids || [],
      exceptions || []
    );
  }

  _commitPickedRule({ rule = "", selector = "", host = "" } = {}) {
    const cleanedRule = String(rule || "").trim();
    const cleanedSelector = String(selector || "").trim();
    const cleanedHost = String(host || "").trim();
    const normalizedHost = cleanedHost ? cleanedHost.toLowerCase() : "";

    if (!cleanedRule || !cleanedSelector || !normalizedHost) {
      return { added: false, ok: false };
    }

    let nextRules = "";
    let added = false;

    try {
      const rawRules = Services.prefs.getStringPref(
        "waterfox.blocker.customRules",
        ""
      );
      const existing = rawRules
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
      const existingSet = new Set(existing);

      if (!existingSet.has(cleanedRule)) {
        const updated = rawRules.trim()
          ? `${rawRules.replace(/\s+$/, "")}\n${cleanedRule}`
          : cleanedRule;
        Services.prefs.setStringPref("waterfox.blocker.customRules", updated);
        added = true;
        nextRules = updated;
      } else {
        nextRules = rawRules;
      }
    } catch (err) {
      console.error(
        "[WaterfoxBlockerParent] failed to persist picked rule:",
        err
      );
      return { added: false, ok: false };
    }

    return {
      added,
      ok: true,
      rule: cleanedRule,
      selector: cleanedSelector,
      rules: nextRules,
    };
  }
}
