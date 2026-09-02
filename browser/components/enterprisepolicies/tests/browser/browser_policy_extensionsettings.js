/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */
"use strict";

const BASE_URL =
  "http://mochi.test:8888/browser/browser/components/enterprisepolicies/tests/browser/";

const AMO_BASE_URL =
  "https://example.com/browser/browser/components/enterprisepolicies/tests/browser/";

/**
 * Wait for the given PopupNotification to display
 *
 * @param {string} name
 *        The name of the notification to wait for.
 *
 * @returns {Promise}
 *          Resolves with the notification window.
 */
function promisePopupNotificationShown(name) {
  return new Promise(resolve => {
    function popupshown() {
      let notification = PopupNotifications.getNotification(name);
      if (!notification) {
        return;
      }

      ok(notification, `${name} notification shown`);
      ok(PopupNotifications.isPanelOpen, "notification panel open");

      PopupNotifications.panel.removeEventListener("popupshown", popupshown);
      resolve(PopupNotifications.panel.firstElementChild);
    }

    PopupNotifications.panel.addEventListener("popupshown", popupshown);
  });
}

add_setup(async function setupTestEnvironment() {
  await SpecialPowers.pushPrefEnv({
    set: [
      // Relax the user input requirements while running this test.
      ["xpinstall.userActivation.required", false],
      // Simulated AMO installs.
      ["extensions.webapi.testing", true],
      ["extensions.install.requireBuiltInCerts", false],
    ],
  });
});

add_task(async function test_install_source_blocked_link() {
  await setupPolicyEngineWithJson({
    policies: {
      ExtensionSettings: {
        "*": {
          install_sources: ["http://blocks.other.install.sources/*"],
        },
      },
    },
  });
  let popupPromise = promisePopupNotificationShown(
    "addon-install-policy-blocked"
  );
  let tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: BASE_URL + "extensionsettings.html",
    waitForStateStop: true,
  });

  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.getElementById("policytest").click();
  });
  await popupPromise;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_install_source_blocked_mozAddonManager() {
  await setupPolicyEngineWithJson({
    policies: {
      ExtensionSettings: {
        "*": {
          install_sources: ["http://blocks.other.install.sources/*"],
          blocked_install_message: "blocked_install_message",
        },
      },
    },
  });
  let popupPromise = promisePopupNotificationShown(
    "addon-install-policy-blocked"
  );
  let tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: AMO_BASE_URL + "extensionsettings.html",
    waitForStateStop: true,
  });

  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.getElementById("policytest_mozaddonmanager").click();
  });
  let popup = await popupPromise;
  let description = popup.querySelector(".popup-notification-description");
  ok(
    description.textContent.endsWith("blocked_install_message"),
    "Custom install message present"
  );
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_install_source_blocked_otherdomain() {
  await setupPolicyEngineWithJson({
    policies: {
      ExtensionSettings: {
        "*": {
          install_sources: ["http://mochi.test/*"],
        },
      },
    },
  });
  let popupPromise = promisePopupNotificationShown(
    "addon-install-policy-blocked"
  );
  let tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: BASE_URL + "extensionsettings.html",
    waitForStateStop: true,
  });

  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.getElementById("policytest_otherdomain").click();
  });
  await popupPromise;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_install_source_blocked_direct() {
  await setupPolicyEngineWithJson({
    policies: {
      ExtensionSettings: {
        "*": {
          install_sources: ["http://blocks.other.install.sources/*"],
        },
      },
    },
  });
  let popupPromise = promisePopupNotificationShown(
    "addon-install-policy-blocked"
  );
  let tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: BASE_URL + "extensionsettings.html",
    waitForStateStop: true,
  });

  await SpecialPowers.spawn(
    tab.linkedBrowser,
    [{ baseUrl: BASE_URL }],
    async function ({ baseUrl }) {
      // Trigger navigation from the content principal. Without wrappedJSObject
      // we would trigger a navigation from a system principal, which users are
      // not going to encounter in practice (such requests would be initiated
      // from the parent process instead of the child process).
      content.wrappedJSObject.location.href = baseUrl + "policytest_v0.1.xpi";
    }
  );
  await popupPromise;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_install_source_allowed_link() {
  await setupPolicyEngineWithJson({
    policies: {
      ExtensionSettings: {
        "*": {
          install_sources: ["http://mochi.test/*"],
        },
      },
    },
  });
  let popupPromise = promisePopupNotificationShown("addon-webext-permissions");
  let tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: BASE_URL + "extensionsettings.html",
    waitForStateStop: true,
  });

  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.getElementById("policytest").click();
  });
  await popupPromise;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_install_source_allowed_mozAddonManager() {
  await setupPolicyEngineWithJson({
    policies: {
      ExtensionSettings: {
        "*": {
          install_sources: ["https://example.com/*"],
        },
      },
    },
  });
  let popupPromise = promisePopupNotificationShown("addon-webext-permissions");
  let tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: AMO_BASE_URL + "extensionsettings.html",
    waitForStateStop: true,
  });

  info("Trigger addon install and wait for add-on install permissions dialog");
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.getElementById("policytest_mozaddonmanager").click();
  });
  await popupPromise;
  info("Got addon-webext-permissions dialog show");
  // NOTE: wait for mozAddonManager promise to be resolved (prevents to
  // hit NS_ERROR_NOT_INITIALIZED if the promise is resolved after the
  // tab has been already closed).
  await SpecialPowers.spawn(tab.linkedBrowser, [], async () => {
    const { addonInstall, promiseCompleted } = content.wrappedJSObject;
    addonInstall.cancel();
    const res = await promiseCompleted.catch(err => {
      return err;
    });
    if (res instanceof content.Error) {
      if (res.message.includes("Install failed: onDownloadCancelled")) {
        dump(`Expect addon install to be cancelled: ${res}\n`);
        return;
      }
      // Re-throw unexpected error.
      throw res;
    }
    throw new Error(
      "Unxpected mozAddonManager install promise resolved as successful"
    );
  });
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_install_source_allowed_otherdomain() {
  await setupPolicyEngineWithJson({
    policies: {
      ExtensionSettings: {
        "*": {
          install_sources: ["http://mochi.test/*", "http://example.org/*"],
        },
      },
    },
  });
  let popupPromise = promisePopupNotificationShown("addon-webext-permissions");
  let tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: BASE_URL + "extensionsettings.html",
    waitForStateStop: true,
  });

  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.getElementById("policytest_otherdomain").click();
  });
  await popupPromise;
  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_install_source_allowed_direct() {
  await setupPolicyEngineWithJson({
    policies: {
      ExtensionSettings: {
        "*": {
          install_sources: ["http://mochi.test/*"],
        },
      },
    },
  });
  let popupPromise = promisePopupNotificationShown("addon-webext-permissions");
  let tab = await BrowserTestUtils.openNewForegroundTab({
    gBrowser,
    opening: BASE_URL + "extensionsettings.html",
    waitForStateStop: true,
  });

  await SpecialPowers.spawn(
    tab.linkedBrowser,
    [{ baseUrl: BASE_URL }],
    async function ({ baseUrl }) {
      // Trigger navigation from the content principal. Without wrappedJSObject
      // we would trigger a navigation from a system principal, which users are
      // not going to encounter in practice (such requests would be initiated
      // from the parent process instead of the child process).
      content.wrappedJSObject.location.href = baseUrl + "policytest_v0.1.xpi";
    }
  );
  await popupPromise;
  BrowserTestUtils.removeTab(tab);
});
