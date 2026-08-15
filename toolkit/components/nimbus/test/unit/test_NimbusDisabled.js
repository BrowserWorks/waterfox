"use strict";

const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

const FEATURE_ID = "waterfoxNimbusDisabledTest";
const FALLBACK_PREF = "test.nimbus.disabled.fallback";
const CACHE_BRANCHES = [
  `nimbus.syncdatastore.${FEATURE_ID}`,
  `nimbus.syncdefaultsstore.${FEATURE_ID}`,
];

add_task(async function test_disabled_nimbus_uses_only_fallback_prefs() {
  if (AppConstants.MOZ_NORMANDY) {
    info("Skipping because Nimbus is enabled in this build");
    return;
  }

  Services.prefs.setBoolPref(FALLBACK_PREF, true);
  for (const branch of CACHE_BRANCHES) {
    Services.prefs.setStringPref(
      branch,
      JSON.stringify({
        slug: "stale-enrollment",
        active: true,
        branch: { slug: "stale-branch" },
      })
    );
    Services.prefs.setBoolPref(`${branch}.enabled`, false);
  }

  try {
    const feature = new ExperimentFeature(FEATURE_ID, {
      variables: {
        enabled: {
          type: "boolean",
          fallbackPref: FALLBACK_PREF,
        },
      },
    });

    Assert.equal(
      feature.getVariable("enabled"),
      true,
      "Ignores stale cached values and uses the fallback pref"
    );
    Assert.equal(
      feature.getAllVariables().enabled,
      true,
      "All variables use fallback prefs"
    );
    Assert.equal(
      feature.getEnrollmentMetadata(),
      null,
      "Hides enrollment data"
    );
    Assert.deepEqual(feature.getAllEnrollments(), [], "Hides all enrollments");
    Assert.equal(await ExperimentAPI.init(), false, "Skips initialization");
    Assert.equal(
      ExperimentAPI._remoteSettingsClient,
      null,
      "Does not construct a recipe client"
    );
    Assert.deepEqual(
      ExperimentAPI._rsLoader.remoteSettingsClients,
      {},
      "Does not construct loader clients"
    );
    Assert.ok(
      !Services.prefs.prefHasUserValue("nimbus.profileId"),
      "Does not create a Nimbus profile ID"
    );
  } finally {
    Services.prefs.clearUserPref(FALLBACK_PREF);
    for (const branch of CACHE_BRANCHES) {
      Services.prefs.deleteBranch(branch);
    }
  }
});
