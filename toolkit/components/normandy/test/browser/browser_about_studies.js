"use strict";

const { PreferenceExperiments } = ChromeUtils.importESModule(
  "resource://normandy/lib/PreferenceExperiments.sys.mjs"
);
const { RecipeRunner } = ChromeUtils.importESModule(
  "resource://normandy/lib/RecipeRunner.sys.mjs"
);
const { NimbusTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/NimbusTestUtils.sys.mjs"
);
const { ExperimentAPI } = ChromeUtils.importESModule(
  "resource://nimbus/ExperimentAPI.sys.mjs"
);
const { FirefoxLabs } = ChromeUtils.importESModule(
  "resource://nimbus/FirefoxLabs.sys.mjs"
);

const { NormandyTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/NormandyTestUtils.sys.mjs"
);
const { addonStudyFactory, preferenceStudyFactory } =
  NormandyTestUtils.factories;

NimbusTestUtils.init(this);

function withAboutStudies() {
  return function (testFunc) {
    return async args =>
      BrowserTestUtils.withNewTab("about:studies", async browser =>
        testFunc({ ...args, browser })
      );
  };
}

// Test that the code renders at all
decorate_task(
  withAboutStudies(),
  async function testAboutStudiesWorks({ browser }) {
    const appFound = await SpecialPowers.spawn(
      browser,
      [],
      () => !!content.document.getElementById("app")
    );
    ok(appFound, "App element was found");
  }
);

// Test that the learn more element is displayed correctly
decorate_task(
  withPrefEnv({
    set: [["app.normandy.shieldLearnMoreUrl", "http://test/%OS%/"]],
  }),
  withAboutStudies(),
  async function testLearnMore({ browser }) {
    SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(() =>
        doc.getElementById("shield-studies-learn-more")
      );
      doc.getElementById("shield-studies-learn-more").click();
    });
    await BrowserTestUtils.waitForLocationChange(gBrowser);

    const location = browser.currentURI.spec;
    is(
      location,
      AboutPages.aboutStudies.getShieldLearnMoreHref(),
      "Clicking Learn More opens the correct page on SUMO."
    );
    ok(!location.includes("%OS%"), "The Learn More URL is formatted.");
  }
);

// Test that jumping to preferences worked as expected
decorate_task(
  withAboutStudies(),
  async function testUpdatePreferences({ browser }) {
    let loadPromise = BrowserTestUtils.firstBrowserLoaded(window);

    // We have to use gBrowser instead of browser in most spots since we're
    // dealing with a new tab outside of the about:studies tab.
    const tab = await BrowserTestUtils.switchTab(gBrowser, () => {
      SpecialPowers.spawn(browser, [], async () => {
        const doc = content.document;
        await ContentTaskUtils.waitForCondition(() =>
          doc.getElementById("shield-studies-update-preferences")
        );
        content.document
          .getElementById("shield-studies-update-preferences")
          .click();
      });
    });

    await loadPromise;

    const location = gBrowser.currentURI.spec;
    // The Settings Redesign LegacyPaneMappings shim routes "privacy-reports"
    // (the friendly category openDataPreferences passes to openPreferences())
    // to the permissionsData pane instead.
    const expectedLocation = Services.prefs.getBoolPref(
      "browser.settings-redesign.enabled",
      false
    )
      ? "about:preferences#permissionsData"
      : "about:preferences#privacy";
    is(
      location,
      expectedLocation,
      "Clicking Update Preferences opens the privacy section of the new about:preferences."
    );

    BrowserTestUtils.removeTab(tab);
  }
);

// Test that the study listing shows studies in the proper order and grouping
decorate_task(
  AddonStudies.withStudies([
    addonStudyFactory({
      slug: "fake-study-a",
      userFacingName: "A Fake Add-on Study",
      active: true,
      userFacingDescription: "A fake description",
      studyStartDate: new Date(2018, 0, 4),
    }),
    addonStudyFactory({
      slug: "fake-study-b",
      userFacingName: "B Fake Add-on Study",
      active: false,
      userFacingDescription: "B fake description",
      studyStartDate: new Date(2018, 0, 2),
    }),
    addonStudyFactory({
      slug: "fake-study-c",
      userFacingName: "C Fake Add-on Study",
      active: true,
      userFacingDescription: "C fake description",
      studyStartDate: new Date(2018, 0, 1),
    }),
  ]),
  PreferenceExperiments.withMockExperiments([
    preferenceStudyFactory({
      slug: "fake-study-d",
      userFacingName: null,
      userFacingDescription: null,
      lastSeen: new Date(2018, 0, 3),
      expired: false,
    }),
    preferenceStudyFactory({
      slug: "fake-study-e",
      userFacingName: "E Fake Preference Study",
      lastSeen: new Date(2018, 0, 5),
      expired: true,
    }),
    preferenceStudyFactory({
      slug: "fake-study-f",
      userFacingName: "F Fake Preference Study",
      lastSeen: new Date(2018, 0, 6),
      expired: false,
    }),
  ]),
  withAboutStudies(),
  async function testStudyListing({ addonStudies, prefExperiments, browser }) {
    await SpecialPowers.spawn(
      browser,
      [{ addonStudies, prefExperiments }],
      async ({ addonStudies, prefExperiments }) => {
        const doc = content.document;

        function getStudyRow(docElem, slug) {
          return docElem.querySelector(`.study[data-study-slug="${slug}"]`);
        }

        await ContentTaskUtils.waitForCondition(
          () => doc.querySelectorAll(".active-study-list .study").length
        );
        const activeNames = Array.from(
          doc.querySelectorAll(".active-study-list .study")
        ).map(row => row.dataset.studySlug);
        const inactiveNames = Array.from(
          doc.querySelectorAll(".inactive-study-list .study")
        ).map(row => row.dataset.studySlug);

        Assert.deepEqual(
          activeNames,
          [
            prefExperiments[2].slug,
            addonStudies[0].slug,
            prefExperiments[0].slug,
            addonStudies[2].slug,
          ],
          "Active studies are grouped by enabled status, and sorted by date"
        );
        Assert.deepEqual(
          inactiveNames,
          [prefExperiments[1].slug, addonStudies[1].slug],
          "Inactive studies are grouped by enabled status, and sorted by date"
        );

        const activeAddonStudy = getStudyRow(doc, addonStudies[0].slug);
        ok(
          activeAddonStudy
            .querySelector(".study-description")
            .textContent.includes(addonStudies[0].userFacingDescription),
          "Study descriptions are shown in about:studies."
        );
        is(
          activeAddonStudy.querySelector(".study-status").textContent,
          "Active",
          "Active studies show an 'Active' indicator."
        );
        ok(
          activeAddonStudy.querySelector(".remove-button"),
          "Active studies show a remove button"
        );
        is(
          activeAddonStudy
            .querySelector(".study-icon")
            .textContent.toLowerCase(),
          "a",
          "Study icons use the first letter of the study name."
        );

        const inactiveAddonStudy = getStudyRow(doc, addonStudies[1].slug);
        is(
          inactiveAddonStudy.querySelector(".study-status").textContent,
          "Complete",
          "Inactive studies are marked as complete."
        );
        ok(
          !inactiveAddonStudy.querySelector(".remove-button"),
          "Inactive studies do not show a remove button"
        );

        const activePrefStudy = getStudyRow(doc, prefExperiments[0].slug);
        const preferenceName = Object.keys(prefExperiments[0].preferences)[0];
        ok(
          activePrefStudy
            .querySelector(".study-description")
            .textContent.includes(preferenceName),
          "Preference studies show the preference they are changing"
        );
        is(
          activePrefStudy.querySelector(".study-status").textContent,
          "Active",
          "Active studies show an 'Active' indicator."
        );
        ok(
          activePrefStudy.querySelector(".remove-button"),
          "Active studies show a remove button"
        );

        const inactivePrefStudy = getStudyRow(doc, prefExperiments[1].slug);
        is(
          inactivePrefStudy.querySelector(".study-status").textContent,
          "Complete",
          "Inactive studies are marked as complete."
        );
        ok(
          !inactivePrefStudy.querySelector(".remove-button"),
          "Inactive studies do not show a remove button"
        );

        activeAddonStudy.querySelector(".remove-button").click();
        await ContentTaskUtils.waitForCondition(() =>
          getStudyRow(doc, addonStudies[0].slug).matches(".study.disabled")
        );
        ok(
          getStudyRow(doc, addonStudies[0].slug).matches(".study.disabled"),
          "Clicking the remove button updates the UI to show that the study has been disabled."
        );

        activePrefStudy.querySelector(".remove-button").click();
        await ContentTaskUtils.waitForCondition(() =>
          getStudyRow(doc, prefExperiments[0].slug).matches(".study.disabled")
        );
        ok(
          getStudyRow(doc, prefExperiments[0].slug).matches(".study.disabled"),
          "Clicking the remove button updates the UI to show that the study has been disabled."
        );
      }
    );

    const updatedAddonStudy = await AddonStudies.get(addonStudies[0].recipeId);
    ok(
      !updatedAddonStudy.active,
      "Clicking the remove button marks addon studies as inactive in storage."
    );

    const updatedPrefStudy = await PreferenceExperiments.get(
      prefExperiments[0].slug
    );
    ok(
      updatedPrefStudy.expired,
      "Clicking the remove button marks preference studies as expired in storage."
    );
  }
);

// Test that a message is shown when no studies have been run
decorate_task(
  AddonStudies.withStudies([]),
  withAboutStudies(),
  async function testStudyListingNoStudies({ browser }) {
    await SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(
        () => doc.querySelectorAll(".study-list-info").length
      );
      const studyRows = doc.querySelectorAll(".study-list .study");
      is(studyRows.length, 0, "There should be no studies");
      is(
        doc.querySelector(".study-list-info").textContent,
        "You have not participated in any studies.",
        "A message is shown when no studies exist"
      );
    });
  }
);

// Test that the message shown when studies are disabled and studies exist
decorate_task(
  withAboutStudies(),
  AddonStudies.withStudies([
    addonStudyFactory({
      userFacingName: "A Fake Add-on Study",
      slug: "fake-addon-study",
      active: false,
      userFacingDescription: "A fake description",
      studyStartDate: new Date(2018, 0, 4),
    }),
  ]),
  PreferenceExperiments.withMockExperiments([
    preferenceStudyFactory({
      slug: "fake-pref-study",
      userFacingName: "B Fake Preference Study",
      lastSeen: new Date(2018, 0, 5),
      expired: true,
    }),
  ]),
  async function testStudyListingDisabled({ browser }) {
    try {
      RecipeRunner.disable();

      await SpecialPowers.spawn(browser, [], async () => {
        const doc = content.document;
        await ContentTaskUtils.waitForCondition(() =>
          doc.querySelector(".info-box-content > span")
        );

        is(
          doc.querySelector(".info-box-content > span").textContent,
          "This is a list of studies that you have participated in. No new studies will run.",
          "A message is shown when studies are disabled"
        );
      });
    } finally {
      // reset RecipeRunner.enabled
      RecipeRunner.checkPrefs();
    }
  }
);

// Test for bug 1498940 - detects studies disabled when only study opt-out is set
decorate_task(
  withPrefEnv({
    set: [
      ["datareporting.healthreport.uploadEnabled", true],
      ["app.normandy.api_url", "https://example.com"],
      ["app.shield.optoutstudies.enabled", false],
    ],
  }),
  withAboutStudies(),
  AddonStudies.withStudies([]),
  PreferenceExperiments.withMockExperiments([]),
  async function testStudyListingStudiesOptOut({ browser }) {
    RecipeRunner.checkPrefs();
    ok(
      RecipeRunner.enabled,
      "RecipeRunner should be enabled as a Precondition"
    );

    await SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(() => {
        const span = doc.querySelector(".info-box-content > span");
        return span && span.textContent;
      });

      is(
        doc.querySelector(".info-box-content > span").textContent,
        "This is a list of studies that you have participated in. No new studies will run.",
        "A message is shown when studies are disabled"
      );
    });
  }
);

// Test that clicking remove on a study that was disabled by an outside source
// since the page loaded correctly updates.
decorate_task(
  AddonStudies.withStudies([
    addonStudyFactory({
      slug: "fake-addon-study",
      userFacingName: "Fake Add-on Study",
      active: true,
      userFacingDescription: "A fake description",
      studyStartDate: new Date(2018, 0, 4),
    }),
  ]),
  PreferenceExperiments.withMockExperiments([
    preferenceStudyFactory({
      slug: "fake-pref-study",
      userFacingName: "Fake Preference Study",
      lastSeen: new Date(2018, 0, 3),
      expired: false,
    }),
  ]),
  withAboutStudies(),
  async function testStudyListing({
    addonStudies: [addonStudy],
    prefExperiments: [prefStudy],
    browser,
  }) {
    // The content page has already loaded. Disabling the studies here shouldn't
    // affect it, since it doesn't live-update.
    await AddonStudies.markAsEnded(addonStudy, "disabled-automatically-test");
    await PreferenceExperiments.stop(prefStudy.slug, {
      resetValue: false,
      reason: "disabled-automatically-test",
    });

    await SpecialPowers.spawn(
      browser,
      [{ addonStudy, prefStudy }],
      async ({ addonStudy, prefStudy }) => {
        const doc = content.document;

        function getStudyRow(docElem, slug) {
          return docElem.querySelector(`.study[data-study-slug="${slug}"]`);
        }

        await ContentTaskUtils.waitForCondition(
          () => doc.querySelectorAll(".remove-button").length == 2
        );
        let activeNames = Array.from(
          doc.querySelectorAll(".active-study-list .study")
        ).map(row => row.dataset.studySlug);
        let inactiveNames = Array.from(
          doc.querySelectorAll(".inactive-study-list .study")
        ).map(row => row.dataset.studySlug);

        Assert.deepEqual(
          activeNames,
          [addonStudy.slug, prefStudy.slug],
          "Both studies should be listed as active, even though they have been disabled outside of the page"
        );
        Assert.deepEqual(
          inactiveNames,
          [],
          "No studies should be listed as inactive"
        );

        const activeAddonStudy = getStudyRow(doc, addonStudy.slug);
        const activePrefStudy = getStudyRow(doc, prefStudy.slug);

        activeAddonStudy.querySelector(".remove-button").click();
        await ContentTaskUtils.waitForCondition(() =>
          getStudyRow(doc, addonStudy.slug).matches(".study.disabled")
        );
        ok(
          getStudyRow(doc, addonStudy.slug).matches(".study.disabled"),
          "Clicking the remove button updates the UI to show that the study has been disabled."
        );

        activePrefStudy.querySelector(".remove-button").click();
        await ContentTaskUtils.waitForCondition(() =>
          getStudyRow(doc, prefStudy.slug).matches(".study.disabled")
        );
        ok(
          getStudyRow(doc, prefStudy.slug).matches(".study.disabled"),
          "Clicking the remove button updates the UI to show that the study has been disabled."
        );

        activeNames = Array.from(
          doc.querySelectorAll(".active-study-list .study")
        ).map(row => row.dataset.studySlug);

        Assert.deepEqual(
          activeNames,
          [],
          "No studies should be listed as active"
        );
      }
    );
  }
);

// Test that clicking remove on a study updates even about:studies pages
// that are not currently in focus.
decorate_task(
  AddonStudies.withStudies([
    addonStudyFactory({
      slug: "fake-addon-study",
      userFacingName: "Fake Add-on Study",
      active: true,
      userFacingDescription: "A fake description",
      studyStartDate: new Date(2018, 0, 4),
    }),
  ]),
  PreferenceExperiments.withMockExperiments([
    preferenceStudyFactory({
      slug: "fake-pref-study",
      userFacingName: "Fake Preference Study",
      lastSeen: new Date(2018, 0, 3),
      expired: false,
    }),
  ]),
  withAboutStudies(),
  async function testOtherTabsUpdated({
    addonStudies: [addonStudy],
    prefExperiments: [prefStudy],
    browser,
  }) {
    // Ensure that both our studies are active in the current tab.
    await SpecialPowers.spawn(
      browser,
      [{ addonStudy, prefStudy }],
      async ({ addonStudy, prefStudy }) => {
        const doc = content.document;
        await ContentTaskUtils.waitForCondition(
          () => doc.querySelectorAll(".remove-button").length == 2,
          "waiting for page to load"
        );
        let activeNames = Array.from(
          doc.querySelectorAll(".active-study-list .study")
        ).map(row => row.dataset.studySlug);
        let inactiveNames = Array.from(
          doc.querySelectorAll(".inactive-study-list .study")
        ).map(row => row.dataset.studySlug);

        Assert.deepEqual(
          activeNames,
          [addonStudy.slug, prefStudy.slug],
          "Both studies should be listed as active"
        );
        Assert.deepEqual(
          inactiveNames,
          [],
          "No studies should be listed as inactive"
        );
      }
    );

    // Open a new about:studies tab.
    await BrowserTestUtils.withNewTab("about:studies", async browser => {
      // Delete both studies in this tab; this should pass if previous tests have passed.
      await SpecialPowers.spawn(
        browser,
        [{ addonStudy, prefStudy }],
        async ({ addonStudy, prefStudy }) => {
          const doc = content.document;

          function getStudyRow(docElem, slug) {
            return docElem.querySelector(`.study[data-study-slug="${slug}"]`);
          }

          await ContentTaskUtils.waitForCondition(
            () => doc.querySelectorAll(".remove-button").length == 2,
            "waiting for page to load"
          );
          let activeNames = Array.from(
            doc.querySelectorAll(".active-study-list .study")
          ).map(row => row.dataset.studySlug);
          let inactiveNames = Array.from(
            doc.querySelectorAll(".inactive-study-list .study")
          ).map(row => row.dataset.studySlug);

          Assert.deepEqual(
            activeNames,
            [addonStudy.slug, prefStudy.slug],
            "Both studies should be listed as active in the new tab"
          );
          Assert.deepEqual(
            inactiveNames,
            [],
            "No studies should be listed as inactive in the new tab"
          );

          const activeAddonStudy = getStudyRow(doc, addonStudy.slug);
          const activePrefStudy = getStudyRow(doc, prefStudy.slug);

          activeAddonStudy.querySelector(".remove-button").click();
          await ContentTaskUtils.waitForCondition(() =>
            getStudyRow(doc, addonStudy.slug).matches(".study.disabled")
          );
          ok(
            getStudyRow(doc, addonStudy.slug).matches(".study.disabled"),
            "Clicking the remove button updates the UI in the new tab"
          );

          activePrefStudy.querySelector(".remove-button").click();
          await ContentTaskUtils.waitForCondition(() =>
            getStudyRow(doc, prefStudy.slug).matches(".study.disabled")
          );
          ok(
            getStudyRow(doc, prefStudy.slug).matches(".study.disabled"),
            "Clicking the remove button updates the UI in the new tab"
          );

          activeNames = Array.from(
            doc.querySelectorAll(".active-study-list .study")
          ).map(row => row.dataset.studySlug);

          Assert.deepEqual(
            activeNames,
            [],
            "No studies should be listed as active"
          );
        }
      );
    });

    // Ensure that the original tab has updated correctly.
    await SpecialPowers.spawn(
      browser,
      [{ addonStudy, prefStudy }],
      async ({ addonStudy, prefStudy }) => {
        const doc = content.document;
        await ContentTaskUtils.waitForCondition(
          () => doc.querySelectorAll(".inactive-study-list .study").length == 2,
          "Two studies should load into the inactive list, since they were disabled in a different tab"
        );
        let activeNames = Array.from(
          doc.querySelectorAll(".active-study-list .study")
        ).map(row => row.dataset.studySlug);
        let inactiveNames = Array.from(
          doc.querySelectorAll(".inactive-study-list .study")
        ).map(row => row.dataset.studySlug);
        Assert.deepEqual(
          activeNames,
          [],
          "No studies should be listed as active, since they were disabled in a different tab"
        );
        Assert.deepEqual(
          inactiveNames,
          [addonStudy.slug, prefStudy.slug],
          "Both studies should be listed as inactive, since they were disabled in a different tab"
        );
      }
    );
  }
);

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["test.wait300msAfterTabSwitch", true]],
  });
});

add_task(async function test_nimbus_about_studies_experiment() {
  const recipe = NimbusTestUtils.factories.recipe("about-studies-foo");
  const {
    branch: { slug: activeBranchSlug },
  } = await ExperimentAPI.manager.enroll(recipe, "test");
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:studies", activeBranchSlug },
    async browser => {
      const [name, renderedBranchSlug] = await SpecialPowers.spawn(
        browser,
        [],
        async () => {
          await ContentTaskUtils.waitForCondition(
            () => content.document.querySelector(".nimbus .remove-button"),
            "waiting for page to load"
          );
          return [
            content.document.querySelector(".study-name").innerText,
            content.document.querySelector(".study-branch-slug").innerText,
          ];
        }
      );
      // Make sure strings are properly shown
      Assert.equal(
        name,
        recipe.userFacingName,
        "Correct active experiment name"
      );
      Assert.equal(
        renderedBranchSlug,
        activeBranchSlug,
        "Correct active experiment branch slug"
      );
    }
  );
  await ExperimentAPI.manager.unenroll(recipe.slug);
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:studies", activeBranchSlug },
    async browser => {
      const [name, renderedBranchSlug] = await SpecialPowers.spawn(
        browser,
        [],
        async () => {
          await ContentTaskUtils.waitForCondition(
            () => content.document.querySelector(".nimbus.disabled"),
            "waiting for experiment to become disabled"
          );
          return [
            content.document.querySelector(".study-name").innerText,
            content.document.querySelector(".study-branch-slug").innerText,
          ];
        }
      );
      // Make sure strings are properly shown
      Assert.equal(
        name,
        recipe.userFacingName,
        "Correct disabled experiment name"
      );
      Assert.equal(
        renderedBranchSlug,
        activeBranchSlug,
        "Correct disabled experiment branch slug"
      );
    }
  );

  await NimbusTestUtils.assert.storeIsEmpty(ExperimentAPI.manager.store);
});

add_task(async function test_nimbus_about_studies_rollout() {
  let recipe = NimbusTestUtils.factories.recipe(
    "test_nimbus_about_studies_rollout"
  );
  let rollout = {
    ...recipe,
    branches: [recipe.branches[0]],
    isRollout: true,
  };
  await ExperimentAPI.manager.enroll(rollout, "test");
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:studies" },
    async browser => {
      const studyCount = await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => content.document.querySelector("#shield-studies-learn-more"),
          "waiting for page/experiment to load"
        );
        return content.document.querySelectorAll(".study-name").length;
      });
      // Make sure strings are properly shown
      Assert.equal(studyCount, 0, "Rollout not loaded in non-debug mode");
    }
  );
  await SpecialPowers.pushPrefEnv({
    set: [["nimbus.debug", true]],
  });
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:studies" },
    async browser => {
      const [studyName, branchShown] = await SpecialPowers.spawn(
        browser,
        [],
        async () => {
          await ContentTaskUtils.waitForCondition(
            () => content.document.querySelector(".nimbus .remove-button"),
            "waiting for page/experiment to load"
          );
          return [
            content.document.querySelector(".study-header").innerText,
            !!content.document.querySelector(".study-branch-slug"),
          ];
        }
      );
      // Make sure strings are properly shown
      Assert.ok(studyName.includes("Active"), "Rollout loaded in debug mode");
      // Make sure the branch slug is not shown for rollouts
      Assert.ok(!branchShown, "Branch slug not shown for rollouts");
    }
  );
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:studies" },
    async browser => {
      const name = await SpecialPowers.spawn(browser, [], async () => {
        content.document.querySelector(".remove-button").click();
        await ContentTaskUtils.waitForCondition(
          () => content.document.querySelector(".nimbus.disabled"),
          "waiting for experiment to become disabled"
        );
        return content.document.querySelector(".study-header").innerText;
      });
      // Make sure strings are properly shown
      Assert.ok(name.includes("Complete"), "Rollout was removed");
    }
  );
  // Cleanup for multiple test runs
  await NimbusTestUtils.assert.storeIsEmpty(ExperimentAPI.manager.store);
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_getStudiesEnabled() {
  RecipeRunner.initializedPromise = Promise.withResolvers();
  let promise = AboutPages.aboutStudies.getStudiesEnabled();

  RecipeRunner.initializedPromise.resolve();
  let result = await promise;

  Assert.equal(
    result,
    Services.prefs.getBoolPref("app.shield.optoutstudies.enabled") &&
      Services.prefs.getBoolPref("datareporting.healthreport.uploadEnabled"),
    "about:studies is enabled if telemetry and studies are enabled"
  );
});

add_task(async function test_forceEnroll() {
  let sandbox = sinon.createSandbox();

  // This simulates a successful enrollment
  let stub = sandbox.stub(ExperimentAPI, "optInToExperiment");

  await BrowserTestUtils.withNewTab(
    {
      gBrowser,
      url: "about:studies?optin_collection=collection123&optin_branch=branch123&optin_slug=slug123",
    },
    async browser => {
      await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => content.document.querySelector(".opt-in-box"),
          "Should show the opt in message"
        );

        Assert.equal(
          content.document
            .querySelector(".opt-in-box")
            .classList.contains("opt-in-error"),
          false,
          "should not have an error class since the enrollment was successful"
        );

        return true;
      });
    }
  );

  // Simulates a problem force enrolling
  stub.rejects(new Error("Testing error"));
  await BrowserTestUtils.withNewTab(
    {
      gBrowser,
      url: "about:studies?optin_collection=collection123&optin_branch=branch123&optin_slug=slug123",
    },
    async browser => {
      await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => content.document.querySelector(".opt-in-box"),
          "Should show the opt in message"
        );

        Assert.ok(
          content.document
            .querySelector(".opt-in-box")
            .classList.contains("opt-in-error"),
          "should have an error class since the enrollment rejected"
        );

        Assert.equal(
          content.document.querySelector(".opt-in-box").textContent,
          "Testing error",
          "should render the error"
        );

        return true;
      });
    }
  );

  await NimbusTestUtils.assert.storeIsEmpty(ExperimentAPI.manager.store);
  sandbox.restore();
});

add_task(async function test_inactive_rollouts_not_under_completed_studies() {
  // Adds an active experiment and rollout
  const experiment = NimbusTestUtils.factories.recipe("my-testing-experiment");
  const rollout = NimbusTestUtils.factories.recipe("my-testing-rollout", {
    isRollout: true,
  });

  // Enrolls in the experiment and rollout
  await ExperimentAPI.manager.enroll(experiment, "test");
  await ExperimentAPI.manager.enroll(rollout, "test");

  // Checks about:studies to ensure they are both in the active section
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:studies" },
    async browser => {
      const activeListItems = await SpecialPowers.spawn(
        browser,
        [],
        async () => {
          await ContentTaskUtils.waitForCondition(
            () => content.document.querySelector(".nimbus .remove-button"),
            "waiting for page to load"
          );
          return Array.from(
            content.document.querySelectorAll("ul.active-study-list li")
          ).map(el => el.dataset.studySlug);
        }
      );

      Assert.ok(
        activeListItems.includes(experiment.slug),
        "active list should include enrolled experiment"
      );
      Assert.ok(
        !activeListItems.includes(rollout.slug),
        "active list should include enrolled rollout"
      );
      Assert.equal(
        activeListItems.length,
        1,
        "should be 2 elements in active list"
      );
    }
  );

  // Unenrolls from the experiment and rollout
  await ExperimentAPI.manager.unenroll(experiment.slug);
  await ExperimentAPI.manager.unenroll(rollout.slug);

  // Checks about:studies to ensure they are both in the inactive section
  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:studies" },
    async browser => {
      const inactiveListItems = await SpecialPowers.spawn(
        browser,
        [],
        async () => {
          await ContentTaskUtils.waitForCondition(
            () => content.document.querySelector(".nimbus.disabled"),
            "waiting for the experiment to become disabled"
          );
          return Array.from(
            content.document.querySelectorAll("ul.inactive-study-list li")
          ).map(el => el.dataset.studySlug);
        }
      );

      Assert.ok(
        inactiveListItems.includes(experiment.slug),
        "inactive list should include unenrolled experiment"
      );
      Assert.ok(
        !inactiveListItems.includes(rollout.slug),
        "inactive list should not include unenrolled rollout"
      );
      Assert.equal(
        inactiveListItems.length,
        1,
        "should be 2 items in inactive list"
      );
    }
  );

  await SpecialPowers.pushPrefEnv({
    set: [["nimbus.debug", true]],
  });

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:studies" },
    async browser => {
      const inactiveListItems = await SpecialPowers.spawn(
        browser,
        [],
        async () => {
          await ContentTaskUtils.waitForCondition(
            () => content.document.querySelector(".nimbus.disabled"),
            "waiting for the experiment to become disabled"
          );
          return Array.from(
            content.document.querySelectorAll("ul.inactive-study-list li")
          ).map(el => el.dataset.studySlug);
        }
      );

      Assert.ok(
        inactiveListItems.includes(experiment.slug),
        "inactive list should include unenrolled experiment"
      );
      Assert.ok(
        inactiveListItems.includes(rollout.slug),
        "inactive list should include unenrolled rollout in debug"
      );
      Assert.equal(
        inactiveListItems.length,
        2,
        "should be 2 items in inactive list in debug"
      );
    }
  );

  await SpecialPowers.popPrefEnv();

  // Cleanup for multiple test runs
  await NimbusTestUtils.assert.storeIsEmpty(ExperimentAPI.manager.store);
});

add_task(async function testFirefoxLabs() {
  const study = NimbusTestUtils.factories.recipe("study");
  await ExperimentAPI.manager.enroll(study, "rs-loader");

  const optin = NimbusTestUtils.factories.recipe("optin", {
    isRollout: true,
    isFirefoxLabsOptIn: true,
    firefoxLabsTitle: "title",
    firefoxLabsDescription: "description",
    firefoxLabsGroup: "group",
    requiresRestart: false,
  });

  ExperimentAPI.manager.optIns.push({ source: "rs-loader", recipe: optin });

  const labs = await FirefoxLabs.create();
  await labs.enroll("optin", "control");

  await BrowserTestUtils.withNewTab(
    { gBrowser, url: "about:studies" },
    async browser => {
      const nimbusItems = await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => content.document.querySelector(".nimbus .remove-button"),
          "waiting for page to load"
        );

        return Array.from(
          content.document.querySelectorAll(".nimbus"),
          el => el.dataset.studySlug
        );
      });

      Assert.deepEqual(
        nimbusItems,
        ["study"],
        "Firefox Labs opt-in not present"
      );
    }
  );

  await labs.unenroll("optin", "control");
  await ExperimentAPI.manager.unenroll("study");
  ExperimentAPI.manager.optIns.pop();

  Assert.deepEqual(ExperimentAPI.manager.optIns, []);

  await NimbusTestUtils.assert.storeIsEmpty(ExperimentAPI.manager.store);
});
