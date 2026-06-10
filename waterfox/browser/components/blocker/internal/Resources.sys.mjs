/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  RemoteResources: "resource:///modules/internal/RemoteResources.sys.mjs",
});

export const Resources = {
  async read() {
    return JSON.stringify(await lazy.RemoteResources.readMergedResources());
  },

  loadSync(engine) {
    const payload = JSON.stringify(
      lazy.RemoteResources.readMergedResourcesSync()
    );
    engine.useResources(payload);
    return payload;
  },

  async load(engine) {
    if (!engine) {
      return null;
    }

    const payload = await this.read();
    engine.useResources(payload);
    return payload;
  },
};
