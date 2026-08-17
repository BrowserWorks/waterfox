/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const UIDENSITY_PREF = "browser.uidensity";

async function openOnboardingPage() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.aboutwelcome.enabled", true]],
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:welcome",
    true
  );
  await SpecialPowers.spawn(tab.linkedBrowser, [], async function () {
    await ContentTaskUtils.waitForCondition(
      () => !content.document.getElementById("onboarding")?.hidden,
      "The onboarding page finished initializing"
    );
  });
  return {
    browser: tab.linkedBrowser,
    tab,
    cleanup: async () => {
      BrowserTestUtils.removeTab(tab);
      await SpecialPowers.popPrefEnv();
    },
  };
}

add_task(async function test_waterfox_onboarding_page_renders() {
  const { browser, cleanup } = await openOnboardingPage();

  try {
    await SpecialPowers.spawn(browser, [], async function () {
      const doc = content.document;
      Assert.equal(
        doc.location.href,
        "about:welcome",
        "Serves the onboarding as about:welcome"
      );
      Assert.ok(
        !doc.getElementById("step-welcome").hidden,
        "Shows the welcome step first"
      );
      Assert.ok(
        doc.getElementById("step-import").hidden,
        "Keeps later steps hidden"
      );
      Assert.greaterOrEqual(
        doc.getElementById("locale-select").options.length,
        1,
        "Populates the locale switcher"
      );
      Assert.equal(
        doc.getElementById("color-grid").querySelectorAll(".color-tile").length,
        12,
        "Builds a swatch for every theme color"
      );
      Assert.ok(
        doc.getElementById("back-button").hidden,
        "Hides Back on the first step"
      );
    });
  } finally {
    await cleanup();
  }
});

add_task(async function test_waterfox_onboarding_page_steps_and_applies() {
  const { browser, cleanup } = await openOnboardingPage();

  try {
    await SpecialPowers.spawn(browser, [], async function () {
      const doc = content.document;
      doc.getElementById("next-button").click();
      Assert.ok(
        !doc.getElementById("step-import").hidden,
        "Continue moves to the import step"
      );
      Assert.ok(
        !doc.getElementById("back-button").hidden,
        "Shows Back after the first step"
      );

      doc.getElementById("skip-button").click();
      Assert.ok(
        !doc.getElementById("step-appearance").hidden,
        "Skip moves to the appearance step"
      );
      Assert.equal(
        doc.getElementById("progress").getAttribute("aria-valuenow"),
        "3",
        "Progress follows the current step"
      );

      doc
        .getElementById("density-segments")
        .querySelector("[data-value='compact']")
        .click();
    });

    await TestUtils.waitForCondition(
      () => Services.prefs.getIntPref(UIDENSITY_PREF, -1) === 1,
      "Picking a density writes the density pref"
    );
    Assert.equal(
      Services.prefs.getIntPref(UIDENSITY_PREF),
      1,
      "Compact density is applied"
    );
  } finally {
    if (Services.prefs.prefHasUserValue(UIDENSITY_PREF)) {
      Services.prefs.clearUserPref(UIDENSITY_PREF);
    }
    await cleanup();
  }
});
