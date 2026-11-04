/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* exported withICloudPasswordsStub */

async function withICloudPasswordsStub(task) {
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  const { ICloudPasswords } = ChromeUtils.importESModule(
    "resource:///modules/ICloudPasswords.sys.mjs"
  );
  const sandbox = sinon.createSandbox();
  const setEnabled = ICloudPasswords.setEnabled.bind(ICloudPasswords);
  const fake = sandbox.stub(ICloudPasswords);
  const branch = "waterfox.passwords.icloud.";
  let state = "locked";
  sandbox.stub(fake, "supported").get(() => true);
  sandbox.stub(fake, "state").get(() => state);
  sandbox.stub(fake, "isReady").get(() => state === "ready");
  for (const [getter, pref, fallback] of [
    ["enabled", "enabled", false],
    ["saveByDefault", "saveByDefault", false],
    ["otpEnabled", "otp.enabled", false],
  ]) {
    sandbox
      .stub(fake, getter)
      .get(() => Services.prefs.getBoolPref(branch + pref, fallback));
  }
  fake.getStatus.callsFake(async () => ({
    supported: true,
    available: true,
    state,
  }));
  fake.isAvailable.resolves(true);
  fake.setEnabled.callsFake(setEnabled);
  for (const [method, next] of [
    ["unlock", "ready"],
    ["lock", "locked"],
  ]) {
    fake[method].callsFake(async () => {
      state = next;
    });
  }
  fake.openManager.resolves();
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.settings-redesign.enabled", true],
      [branch + "enabled", false],
      [branch + "saveByDefault", false],
      [branch + "otp.enabled", false],
      [branch + "idleTimeout", 900],
    ],
  });
  try {
    await task(fake);
  } finally {
    try {
      await SpecialPowers.popPrefEnv();
    } finally {
      sandbox.restore();
    }
  }
}
