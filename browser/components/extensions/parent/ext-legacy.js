/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

var { ExtensionError } = ExtensionUtils;

this.legacy = class extends ExtensionAPI {
  async onManifestEntry() {
    if (!this.extension.manifest.legacy) {
      return;
    }

    const manifestMode =
      typeof this.extension.manifest.legacy === "object" &&
      this.extension.manifest.legacy.type === "bootstrap"
        ? "bootstrap"
        : "xul";
    const integratedMode = this.extension.addonData?.startupData?.legacyMode;
    if (integratedMode !== manifestMode) {
      throw new ExtensionError(
        `Legacy mode mismatch for ${this.extension.id}: manifest requests ${manifestMode}, integrated startup data specifies ${integratedMode ?? "none"}`
      );
    }
  }
};
