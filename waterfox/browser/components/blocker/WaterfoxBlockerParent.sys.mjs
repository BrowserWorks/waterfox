/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WaterfoxBlockerService } from "resource:///modules/WaterfoxBlockerService.sys.mjs";

/**
 * @typedef {object} CosmeticResourcesResponse
 * @property {string[]} exceptions
 * @property {boolean} generichide
 * @property {string[]} hideSelectors
 * @property {string} injectedScript
 * @property {Array<any>} proceduralActions
 */

/**
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
   * @param {object} message
   * @param {string} message.name
   * @param {object} [message.data]
   * @returns {CosmeticResourcesResponse|string[]|null|undefined}
   */
  receiveMessage(message) {
    switch (message.name) {
      case "WaterfoxBlocker:IsEnabled":
        return WaterfoxBlockerService.isEnabled();
      case "WaterfoxBlocker:GetCosmeticResources":
        return this._getCosmeticResources(message.data);
      case "WaterfoxBlocker:GetHiddenClassIdSelectors":
        return this._getHiddenClassIdSelectors(message.data);
      default:
        return undefined;
    }
  }

  _getCosmeticResources({ url } = {}) {
    if (!url) {
      return null;
    }

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
