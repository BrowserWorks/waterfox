/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { Spotlight } = ChromeUtils.importESModule(
  "resource:///modules/asrouter/Spotlight.sys.mjs"
);
const { WaterfoxBlockerExtensionDetector } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBlockerExtensionDetector.sys.mjs"
);

const PREF_DISMISSED_INSTALL_WARNINGS =
  "waterfox.blocker.dismissedExtensionInstallWarnings";
const PREF_DETECTION_DISMISSED = "waterfox.blocker.extensionDetectionDismissed";

add_task(
  async function test_successful_string_preload_is_kept_for_sync_prompts() {
    WaterfoxBlockerExtensionDetector._localizedStringCache.clear();
    WaterfoxBlockerExtensionDetector._localizedStringLoadPromise = null;

    await WaterfoxBlockerExtensionDetector._preloadLocalizedStrings();
    const preloadPromise =
      WaterfoxBlockerExtensionDetector._localizedStringLoadPromise;

    Assert.ok(
      preloadPromise,
      "Successful string preload should keep the resolved promise"
    );

    await WaterfoxBlockerExtensionDetector._preloadLocalizedStrings();
    Assert.equal(
      WaterfoxBlockerExtensionDetector._localizedStringLoadPromise,
      preloadPromise,
      "Later preload calls should reuse the successful preload promise"
    );

    const originalPrompt = Services.prompt;
    const promptCalls = [];
    Services.prompt = {
      BUTTON_POS_0: originalPrompt.BUTTON_POS_0,
      BUTTON_POS_1: originalPrompt.BUTTON_POS_1,
      BUTTON_TITLE_IS_STRING: originalPrompt.BUTTON_TITLE_IS_STRING,
      MODAL_TYPE_TAB: originalPrompt.MODAL_TYPE_TAB,
      QueryInterface: ChromeUtils.generateQI(["nsIPromptService"]),
      confirmExBC(...args) {
        promptCalls.push(args);
        return 1;
      },
    };

    Services.prefs.clearUserPref(PREF_DISMISSED_INSTALL_WARNINGS);

    try {
      const result = WaterfoxBlockerExtensionDetector._showInstallWarning(
        {
          gBrowser: {
            selectedBrowser: {
              browsingContext: {},
            },
          },
        },
        {
          id: "adblock@example.com",
          name: "Example Blocker",
        }
      );

      Assert.equal(result, false, "Button 1 should cancel the install");
      Assert.equal(
        promptCalls.length,
        1,
        "The install warning should prompt once"
      );

      const [, , title, message, , installAnyway, keepBuiltIn] = promptCalls[0];
      Assert.ok(
        !String(title).includes("waterfox-blocker-prompt-title"),
        "Prompt title should be localized"
      );
      Assert.ok(
        !String(message).includes("waterfox-blocker-extension-install-warning"),
        "Prompt message should use the localized warning"
      );
      Assert.ok(
        !String(message).includes(
          "waterfox-blocker-extension-install-manage-settings"
        ),
        "Prompt message should use the localized settings text"
      );
      Assert.ok(
        !String(installAnyway).includes(
          "waterfox-blocker-extension-install-anyway"
        ),
        "Install button should be localized"
      );
      Assert.ok(
        !String(keepBuiltIn).includes(
          "waterfox-blocker-extension-install-keep-built-in"
        ),
        "Cancel button should be localized"
      );
    } finally {
      Services.prompt = originalPrompt;
      Services.prefs.clearUserPref(PREF_DISMISSED_INSTALL_WARNINGS);
    }
  }
);

add_task(async function test_upgrade_message_ids_are_monotonic() {
  const originalPrewarm =
    WaterfoxBlockerExtensionDetector._prewarmUpgradeMessage;
  const originalShowSpotlightDialog = Spotlight.showSpotlightDialog;
  const originalDateNow = Date.now;
  const shownMessages = [];

  WaterfoxBlockerExtensionDetector._detectionActive = true;
  WaterfoxBlockerExtensionDetector._messageIdCounter = 0;
  Services.prefs.clearUserPref(PREF_DETECTION_DISMISSED);
  Date.now = () => 1000;

  WaterfoxBlockerExtensionDetector._prewarmUpgradeMessage = async () => ({
    content: {
      screens: [
        {
          content: {},
          id: "UPGRADE_SET_DEFAULT",
        },
      ],
    },
    id: "UPGRADE_BASE",
  });
  Spotlight.showSpotlightDialog = async (_browser, message) => {
    shownMessages.push({
      messageId: message.id,
      screenId: message.content.screens[0].id,
    });
    return true;
  };

  try {
    const win = { gBrowser: {} };
    const browser = {};

    Assert.equal(
      await WaterfoxBlockerExtensionDetector._showDetectionUpgradeModal(
        win,
        browser,
        "Example Blocker"
      ),
      true,
      "First modal should be shown"
    );
    Assert.equal(
      await WaterfoxBlockerExtensionDetector._showDetectionUpgradeModal(
        win,
        browser,
        "Example Blocker"
      ),
      true,
      "Second modal should be shown"
    );

    Assert.equal(shownMessages.length, 2, "Two messages should be shown");
    Assert.notEqual(
      shownMessages[0].messageId,
      shownMessages[1].messageId,
      "Message IDs should be unique even when Date.now is stable"
    );
    Assert.notEqual(
      shownMessages[0].screenId,
      shownMessages[1].screenId,
      "Screen IDs should be unique even when Date.now is stable"
    );
  } finally {
    WaterfoxBlockerExtensionDetector._prewarmUpgradeMessage = originalPrewarm;
    WaterfoxBlockerExtensionDetector._detectionActive = false;
    Spotlight.showSpotlightDialog = originalShowSpotlightDialog;
    Date.now = originalDateNow;
    Services.prefs.clearUserPref(PREF_DETECTION_DISMISSED);
  }
});
