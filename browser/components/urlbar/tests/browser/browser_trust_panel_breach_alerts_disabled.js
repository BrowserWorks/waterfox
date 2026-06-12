/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

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

  const breachAlertsPref = "browser.urlbar.trustPanel.breachAlerts";
  const prefs = [["browser.tabs.hoverPreview.enabled", false]];
  if (!Services.prefs.prefIsLocked(breachAlertsPref)) {
    prefs.push([breachAlertsPref, false]);
  }
  await SpecialPowers.pushPrefEnv({ set: prefs });

  let tab;
  try {
    tab = await BrowserTestUtils.openNewForegroundTab({
      gBrowser,
      opening: "https://example.org",
      waitForLoad: true,
    });
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
    sandbox.restore();
    try {
      if (tab) {
        await BrowserTestUtils.removeTab(tab);
      }
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  }
});
