/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { Utils } = ChromeUtils.importESModule(
  "resource://services-settings/Utils.sys.mjs"
);
const { WaterfoxSettingsPolicy } = ChromeUtils.importESModule(
  "resource://services-settings/WaterfoxSettingsPolicy.sys.mjs"
);

async function hasPackagedDump(bucket, collection) {
  if (await Utils.hasLocalDump(bucket, collection)) {
    return true;
  }

  // In xpcshell, resource://app resolves one level above firefox-appdir.
  try {
    const response = await fetch(
      `resource://app/browser/defaults/settings/${bucket}/${collection}.json`,
      { method: "HEAD" }
    );
    return response.ok;
  } catch (ex) {
    return false;
  }
}

add_task(async function test_required_offline_dumps_are_bundled() {
  const missing = [];

  for (const [
    bucket,
    collection,
  ] of WaterfoxSettingsPolicy.requiredOfflineDumps) {
    Assert.ok(
      !WaterfoxSettingsPolicy.canSync(bucket, collection),
      `${bucket}/${collection} stays on bundled records`
    );

    if (!(await hasPackagedDump(bucket, collection))) {
      missing.push(`${bucket}/${collection}`);
    }
  }

  Assert.deepEqual(missing, [], "required offline dumps are bundled");
});
