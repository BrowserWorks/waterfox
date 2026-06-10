/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WaterfoxBlockerService } from "resource:///modules/WaterfoxBlockerService.sys.mjs";

/**
 * @typedef {object} CosmeticResourcesResponse
 * @property {string[]} exceptions
 *   Selector exceptions for the document.
 * @property {boolean} generichide
 *   Whether generic hiding is disabled for the document.
 * @property {string[]} hideSelectors
 *   CSS selectors to hide.
 * @property {string} injectedScript
 *   Scriptlet code to run in the page.
 * @property {Array<any>} proceduralActions
 *   Procedural cosmetic filter actions.
 */

/**
 * @typedef {object} HiddenSelectorRequest
 * @property {string[]} [classes]
 *   Class names seen in the document.
 * @property {string[]} [ids]
 *   Element ids seen in the document.
 * @property {string[]} [exceptions]
 *   Selector exceptions to apply.
 */

/**
 * JSWindowActor in the parent process that answers blocker resource queries
 * from the child actor.
 */
export class WaterfoxBlockerParent extends JSWindowActorParent {
  /**
   * @param {object} message
   * @param {string} message.name
   * @param {object} [message.data]
   * @returns {Promise<CosmeticResourcesResponse|null>|string[]|null|undefined}
   */
  receiveMessage(message) {
    switch (message.name) {
      case "WaterfoxBlocker:GetCosmeticResources":
        return this._getCosmeticResources(message.data);
      case "WaterfoxBlocker:GetHiddenClassIdSelectors":
        return this._getHiddenClassIdSelectors(message.data);
      default:
        return undefined;
    }
  }

  async _getCosmeticResources({ url } = {}) {
    if (!url) {
      return null;
    }

    // Cold start: wait for an in-flight engine initialisation so the first
    // navigations after launch receive scriptlets instead of an empty payload.
    await WaterfoxBlockerService.whenEngineReady();

    const resources = WaterfoxBlockerService.getCosmeticResources(
      url,
      this.browsingContext
    );
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

  _getHiddenClassIdSelectors({ classes, ids, exceptions } = {}) {
    return WaterfoxBlockerService.getHiddenClassIdSelectors(
      classes || [],
      ids || [],
      exceptions || []
    );
  }
}
