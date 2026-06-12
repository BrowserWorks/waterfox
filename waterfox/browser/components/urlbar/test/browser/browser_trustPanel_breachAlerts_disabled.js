/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  UrlbarTestUtils: "resource://testing-common/UrlbarTestUtils.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

UrlbarTestUtils.init(this);

add_task(async function test_disabled_breach_alerts_skip_remote_settings() {
  const { RemoteSettingsClient } = ChromeUtils.importESModule(
    "resource://services-settings/RemoteSettingsClient.sys.mjs"
  );
  const originalGet = RemoteSettingsClient.prototype.get;
  const sandbox = sinon.createSandbox();
  let breachCollectionRequested = false;

  sandbox.stub(RemoteSettingsClient.prototype, "get").callsFake(function (
    ...args
  ) {
    if (this.collectionName == "fxmonitor-breaches") {
      breachCollectionRequested = true;
      return [];
    }
    return originalGet.apply(this, args);
  });

  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.tabs.hoverPreview.enabled", false],
      ["browser.urlbar.trustPanel.breachAlerts", false],
    ],
  });

  const tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: "https://example.org",
    waitForLoad: true,
  });

  try {
    await UrlbarTestUtils.openTrustPanel(window);

    Assert.equal(
      breachCollectionRequested,
      false,
      "disabled breach alerts do not query the breach collection"
    );
    Assert.equal(
      window.document.getElementById("trustpanel-breach-alert-section").hidden,
      true,
      "breach alert section stays hidden"
    );
  } finally {
    await BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
    sandbox.restore();
  }
});
