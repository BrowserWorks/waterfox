/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  RemoteResources: "resource:///modules/internal/RemoteResources.sys.mjs",
});

function useResources(engine, resourcesJsonOrObject) {
  if (!engine) {
    return;
  }

  try {
    const payload =
      typeof resourcesJsonOrObject === "string"
        ? resourcesJsonOrObject
        : JSON.stringify(resourcesJsonOrObject ?? []);
    engine.useResources(payload);
  } catch (err) {
    console.error("[WaterfoxBlocker] useResources failed:", err);
  }
}

export const Resources = {
  async load(engine) {
    if (!engine) {
      return;
    }

    const merged = await lazy.RemoteResources.readMergedResources();
    if (merged.length) {
      useResources(engine, merged);
    }
  },
};
