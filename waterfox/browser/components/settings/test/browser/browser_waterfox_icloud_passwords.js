/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from icloud_passwords_test_utils.js */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "icloud_passwords_test_utils.js",
  this
);

async function iCloudControl(doc, id) {
  const selector = `#setting-control-waterfox-icloud-${id}`;
  await TestUtils.waitForCondition(
    () => doc.querySelector(selector)?.controlEl
  );
  const wrapper = doc.querySelector(selector);
  await wrapper.updateComplete;
  return wrapper.controlEl;
}

add_task(async function test_icloud_settings_bindings() {
  await withICloudPasswordsStub(async fake => {
    const tab = await openPrefsTab("passwordsAutofill");
    try {
      const doc = tab.linkedBrowser.contentDocument;
      await settingGroupRenders(doc, "waterfoxICloudPasswords");
      const enabled = await iCloudControl(doc, "enabled");
      await TestUtils.waitForCondition(() => !enabled.disabled);
      ok(!enabled.pressed, "iCloud starts off");
      const experimental = await iCloudControl(doc, "experimental");
      ok(
        !experimental.closest("setting-control").hidden,
        "The experimental notice is visible before opting in"
      );
      for (const id of ["connection", "destination", "otp", "idleTimeout"]) {
        await iCloudControl(doc, id);
        ok(
          doc.getElementById(`setting-control-waterfox-icloud-${id}`).hidden,
          `${id} is hidden while iCloud is off`
        );
      }
      enabled.click();
      await TestUtils.waitForCondition(
        () => enabled.pressed && !enabled.disabled
      );
      ok(
        fake.setEnabled.calledOnceWithExactly(true),
        "Opt-in uses the provider"
      );
      await TestUtils.waitForCondition(
        () =>
          !doc.getElementById("setting-control-waterfox-icloud-connection")
            .hidden
      );
      is(
        (await iCloudControl(doc, "destination")).value,
        "icloud",
        "Enabling chooses iCloud as the save destination"
      );
      ok(
        (await iCloudControl(doc, "otp")).pressed,
        "Enabling also opts in to verification codes"
      );
      ok(
        doc.getElementById("setting-control-waterfox-icloud-lock").hidden,
        "Lock is hidden while locked"
      );
      const timeout = await iCloudControl(doc, "idleTimeout");
      is(timeout.value, "900", "The default timeout is fifteen minutes");

      for (const [id, value] of [
        ["destination", "local"],
        ["idleTimeout", 3600],
      ]) {
        const select = await iCloudControl(doc, id);
        select.value = value;
        select.dispatchEvent(
          new doc.defaultView.Event("change", { bubbles: true })
        );
      }
      (await iCloudControl(doc, "otp")).click();
      await TestUtils.waitForCondition(
        () =>
          !Services.prefs.getBoolPref(
            "waterfox.passwords.icloud.saveByDefault"
          ) &&
          !Services.prefs.getBoolPref(
            "waterfox.passwords.icloud.otp.enabled"
          ) &&
          Services.prefs.getIntPref("waterfox.passwords.icloud.idleTimeout") ===
            3600
      );
      ok(!fake.unlock.called, "Preference changes do not unlock");
      for (const [id, method] of [
        ["unlock", "unlock"],
        ["lock", "lock"],
        ["manager", "openManager"],
      ]) {
        const button = await iCloudControl(doc, id);
        await TestUtils.waitForCondition(() => !button.disabled);
        button.click();
        await TestUtils.waitForCondition(() => fake[method].calledOnce);
        if (id === "unlock") {
          await TestUtils.waitForCondition(
            () =>
              doc.getElementById("setting-control-waterfox-icloud-unlock")
                .hidden
          );
          ok(
            !doc.getElementById("setting-control-waterfox-icloud-lock").hidden,
            "Only Lock is shown once connected"
          );
        }
      }
      enabled.click();
      await TestUtils.waitForCondition(
        () => !enabled.pressed && !enabled.disabled
      );
      for (const id of ["connection", "destination", "otp", "idleTimeout"]) {
        ok(
          doc.getElementById(`setting-control-waterfox-icloud-${id}`).hidden,
          `${id} is hidden again after disabling`
        );
      }
      ok(fake.unlock.calledOnce, "Disabling never unlocks the provider");
    } finally {
      await BrowserTestUtils.removeTab(tab);
    }
  });
});

add_task(async function test_icloud_settings_hidden_when_unavailable() {
  await withICloudPasswordsStub(async fake => {
    fake.isAvailable.resolves(false);
    const tab = await openPrefsTab("passwordsAutofill");
    try {
      const doc = tab.linkedBrowser.contentDocument;
      const group = await settingGroupRenders(doc, "waterfoxICloudPasswords");
      await iCloudControl(doc, "enabled");
      await TestUtils.waitForCondition(
        () =>
          fake.isAvailable.called &&
          doc.defaultView.getComputedStyle(group).display === "none"
      );
      ok(
        !fake.setEnabled.called && !fake.unlock.called,
        "Availability checks do not opt in or unlock"
      );
    } finally {
      await BrowserTestUtils.removeTab(tab);
    }
  });
});
