/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function test_aboutlogins_icloud_landing() {
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  const { ICloudPasswords } = ChromeUtils.importESModule(
    "resource:///modules/ICloudPasswords.sys.mjs"
  );
  const { LoginTestUtils } = ChromeUtils.importESModule(
    "resource://testing-common/LoginTestUtils.sys.mjs"
  );
  const sandbox = sinon.createSandbox();
  const fake = sandbox.stub(ICloudPasswords);
  let state = "locked";
  let enabled = true;
  let supported = true;
  sandbox.stub(fake, "supported").get(() => supported);
  sandbox.stub(fake, "enabled").get(() => enabled);
  sandbox.stub(fake, "state").get(() => state);
  sandbox.stub(fake, "isReady").get(() => state === "ready");
  fake.getStatus.callsFake(async () => ({
    supported,
    available: false,
    state,
  }));
  fake.isAvailable.callsFake(async () => supported);
  fake.unlock.callsFake(async () => {
    state = "ready";
  });
  fake.openManager.resolves();
  const settings = sandbox.stub(window, "openPreferences").resolves();
  let tab;
  let login;
  try {
    login = await Services.logins.addLoginAsync(
      LoginTestUtils.testData.formLogin({
        origin: "https://www.example.com",
        formActionOrigin: "https://www.example.com",
        username: "local-user",
        password: "local-password",
      })
    );
    tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "about:logins#icloud"
    );
    const browser = tab.linkedBrowser;
    await SimpleTest.promiseFocus(window);
    const rows = await SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(
        () =>
          doc.documentElement.classList.contains("initialized") &&
          doc.documentElement.classList.contains("waterfox-icloud-landing") &&
          doc.querySelector(
            'link[href="chrome://browser/content/waterfox/icloudpasswords/aboutLogins.css"]'
          )?.sheet &&
          doc
            .getElementById("waterfox-icloud-unlock")
            ?.hasAttribute("disabled") === false
      );
      ok(
        !doc.getElementById("waterfox-icloud-passwords").hidden,
        "iCloud has a dedicated landing view"
      );
      is(
        content.getComputedStyle(doc.querySelector("login-list")).display,
        "none",
        "The local password list is hidden on the landing view"
      );
      is(
        content.getComputedStyle(doc.querySelector("header")).display,
        "none",
        "The local menu and sync controls are hidden"
      );
      is(
        doc
          .getElementById("waterfox-icloud-status")
          .getAttribute("data-l10n-id"),
        "waterfox-icloud-status-locked",
        "Unknown availability is not missing software"
      );
      ok(
        !doc.getElementById("waterfox-icloud-lock"),
        "The landing view has no redundant lock control"
      );
      ok(
        doc.querySelector("login-item"),
        "The native local manager is retained"
      );
      await ContentTaskUtils.waitForCondition(
        () =>
          !!doc
            .querySelector("login-list")
            .shadowRoot.querySelectorAll("login-list-item[data-guid]").length
      );
      return doc
        .querySelector("login-list")
        .shadowRoot.querySelectorAll("login-list-item[data-guid]").length;
    });
    ok(
      !fake.unlock.called &&
        !fake.openManager.called &&
        !fake.setEnabled.called,
      "Opening the page does not unlock, open an app, or opt in"
    );

    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#waterfox-icloud-unlock",
      {},
      browser
    );
    await TestUtils.waitForCondition(() => fake.unlock.calledOnce);
    ok(
      fake.unlock.calledOnceWithExactly(browser),
      "Unlock is scoped to this browser"
    );
    await SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(
        () => doc.getElementById("waterfox-icloud-status").hidden
      );
      ok(
        doc.getElementById("waterfox-icloud-unlock").hidden,
        "Connected state hides unlock"
      );
    });
    for (const [id, called] of [
      ["manager", fake.openManager],
      ["settings", settings],
    ]) {
      await BrowserTestUtils.synthesizeMouseAtCenter(
        `#waterfox-icloud-${id}`,
        {},
        browser
      );
      await TestUtils.waitForCondition(() => called.calledOnce);
    }
    ok(
      settings.calledOnceWithExactly("passwordsAutofill"),
      "Settings opens the existing pane"
    );

    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#waterfox-icloud-local",
      {},
      browser
    );
    await SpecialPowers.spawn(browser, [rows], async count => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(
        () => !doc.documentElement.classList.contains("waterfox-icloud-landing")
      );
      ok(
        doc.getElementById("waterfox-icloud-passwords").hidden,
        "The landing view gives way to the native manager"
      );
      isnot(
        content.getComputedStyle(doc.querySelector("login-list")).display,
        "none",
        "The native list is visible"
      );
      is(
        doc
          .querySelector("login-list")
          .shadowRoot.querySelectorAll("login-list-item[data-guid]").length,
        count,
        "Switching views preserves the local list"
      );
      ok(
        !doc.getElementById("waterfox-icloud-back").hidden,
        "Local passwords offer a way back to iCloud"
      );
    });
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#waterfox-icloud-back",
      {},
      browser
    );
    await SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(() =>
        doc.documentElement.classList.contains("waterfox-icloud-landing")
      );
      doc.documentElement.classList.add("primary-password-auth-required");
      await ContentTaskUtils.waitForCondition(
        () => doc.getElementById("waterfox-icloud-passwords").hidden
      );
      isnot(
        content.getComputedStyle(
          doc.getElementById("primary-password-required-overlay")
        ).display,
        "none",
        "The native primary-password overlay remains visible"
      );
      ok(
        doc.getElementById("waterfox-icloud-back").inert,
        "The return link cannot bypass primary-password authentication"
      );
      doc.documentElement.classList.remove("primary-password-auth-required");
      await ContentTaskUtils.waitForCondition(
        () => !doc.getElementById("waterfox-icloud-passwords").hidden
      );
    });

    for (const value of [false, true]) {
      enabled = value;
      Services.obs.notifyObservers(null, "icloud-passwords-state-changed");
      await SpecialPowers.spawn(browser, [value], async showLanding => {
        await ContentTaskUtils.waitForCondition(
          () =>
            content.document.documentElement.classList.contains(
              "waterfox-icloud-landing"
            ) === showLanding
        );
      });
    }
    supported = false;
    Services.obs.notifyObservers(null, "icloud-passwords-state-changed");
    await SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(
        () => doc.getElementById("waterfox-icloud-passwords").hidden
      );
      ok(
        doc.getElementById("waterfox-icloud-back").hidden,
        "Unsupported systems retain the native manager"
      );
    });
    ok(
      !fake.listAccounts.called &&
        !fake.getPassword.called &&
        !fake.saveLogin.called,
      "The landing view never requests or saves credentials"
    );
  } finally {
    if (tab) {
      await BrowserTestUtils.removeTab(tab);
    }
    if (login) {
      await Services.logins.removeLoginAsync(login);
    }
    sandbox.restore();
  }
});
