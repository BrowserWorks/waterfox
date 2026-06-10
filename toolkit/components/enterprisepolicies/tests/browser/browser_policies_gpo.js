/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

add_task(async function setup_preferences() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "browser.policies.alternateGPO",
        "SOFTWARE\\BrowserWorks\\PolicyTesting",
      ],
    ],
  });
});

add_task(async function test_gpo_policies() {
  let { Policies } = ChromeUtils.importESModule(
    "resource:///modules/policies/Policies.sys.mjs"
  );

  let gpoPolicyRan = false;

  Policies.gpo_policy = {
    onProfileAfterChange(manager, param) {
      is(param, true, "Param matches what was in the registry");
      gpoPolicyRan = true;
    },
  };

  let wrk = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
    Ci.nsIWindowsRegKey
  );
  let regLocation =
    "SOFTWARE\\BrowserWorks\\PolicyTesting\\BrowserWorks\\" +
    Services.appinfo.name;
  wrk.create(wrk.ROOT_KEY_CURRENT_USER, regLocation, wrk.ACCESS_WRITE);
  wrk.writeIntValue("gpo_policy", 1);
  wrk.close();

  await setupPolicyEngineWithJson(
    // empty policies.json since we are using GPO
    {
      policies: {},
    },

    // custom schema
    {
      properties: {
        gpo_policy: {
          type: "boolean",
        },
      },
    }
  );

  is(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "Engine is active"
  );

  ok(gpoPolicyRan, "GPO Policy ran correctly though onProfileAfterChange");

  delete Policies.gpo_policy;

  wrk.open(
    wrk.ROOT_KEY_CURRENT_USER,
    "SOFTWARE\\BrowserWorks",
    wrk.ACCESS_WRITE
  );
  wrk.removeChild("PolicyTesting\\BrowserWorks\\" + Services.appinfo.name);
  wrk.removeChild("PolicyTesting\\BrowserWorks");
  wrk.removeChild("PolicyTesting");
  wrk.close();
});

add_task(async function test_gpo_json_policies() {
  let { Policies } = ChromeUtils.importESModule(
    "resource:///modules/policies/Policies.sys.mjs"
  );

  let gpoPolicyRan = false;
  let jsonPolicyRan = false;
  let coexistPolicyRan = false;

  Policies.gpo_policy = {
    onProfileAfterChange(manager, param) {
      is(param, true, "Param matches what was in the registry");
      gpoPolicyRan = true;
    },
  };
  Policies.json_policy = {
    onProfileAfterChange(manager, param) {
      is(param, true, "Param matches what was in the JSON");
      jsonPolicyRan = true;
    },
  };
  Policies.coexist_policy = {
    onProfileAfterChange(manager, param) {
      is(param, false, "Param matches what was in the registry (over JSON)");
      coexistPolicyRan = true;
    },
  };

  let wrk = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
    Ci.nsIWindowsRegKey
  );
  let regLocation =
    "SOFTWARE\\BrowserWorks\\PolicyTesting\\BrowserWorks\\" +
    Services.appinfo.name;
  wrk.create(wrk.ROOT_KEY_CURRENT_USER, regLocation, wrk.ACCESS_WRITE);
  wrk.writeIntValue("gpo_policy", 1);
  wrk.writeIntValue("coexist_policy", 0);
  wrk.close();

  await setupPolicyEngineWithJson(
    {
      policies: {
        json_policy: true,
        coexist_policy: true,
      },
    },

    // custom schema
    {
      properties: {
        gpo_policy: {
          type: "boolean",
        },
        json_policy: {
          type: "boolean",
        },
        coexist_policy: {
          type: "boolean",
        },
      },
    }
  );

  is(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "Engine is active"
  );

  ok(gpoPolicyRan, "GPO Policy ran correctly though onProfileAfterChange");
  ok(jsonPolicyRan, "JSON Policy ran correctly though onProfileAfterChange");
  ok(
    coexistPolicyRan,
    "Coexist Policy ran correctly though onProfileAfterChange"
  );

  delete Policies.gpo_policy;
  delete Policies.json_policy;
  delete Policies.coexist_policy;

  wrk.open(
    wrk.ROOT_KEY_CURRENT_USER,
    "SOFTWARE\\BrowserWorks",
    wrk.ACCESS_WRITE
  );
  wrk.removeChild("PolicyTesting\\BrowserWorks\\" + Services.appinfo.name);
  wrk.removeChild("PolicyTesting\\BrowserWorks");
  wrk.removeChild("PolicyTesting");
  wrk.close();
});

add_task(async function test_gpo_extensionsettings_value_and_subkey_merge() {
  let { Policies } = ChromeUtils.importESModule(
    "resource:///modules/policies/Policies.sys.mjs"
  );

  let mergeRan = false;
  let originalExtensionSettings = Policies.ExtensionSettings;
  Policies.ExtensionSettings = {
    onProfileAfterChange(manager, param) {
      is(
        param["*"].installation_mode,
        "blocked",
        "Value (REG_SZ JSON) wins for '*'; subkey did not override it"
      );
      is(
        param.addon.installation_mode,
        "force_installed",
        "Entry only present as a subkey survived the merge"
      );
      mergeRan = true;
    },
  };

  let wrk = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
    Ci.nsIWindowsRegKey
  );
  let regLocation =
    "SOFTWARE\\Mozilla\\PolicyTesting\\Mozilla\\" + Services.appinfo.name;
  // ExtensionSettings as a single REG_SZ string of JSON.
  wrk.create(wrk.ROOT_KEY_CURRENT_USER, regLocation, wrk.ACCESS_WRITE);
  wrk.writeStringValue(
    "ExtensionSettings",
    JSON.stringify({ "*": { installation_mode: "blocked" } })
  );
  wrk.close();

  // The same policy as a subkey tree. Its "*" must not override the REG_SZ
  // value, while "addon" (only present here) must still be added.
  wrk.create(
    wrk.ROOT_KEY_CURRENT_USER,
    regLocation + "\\ExtensionSettings\\*",
    wrk.ACCESS_WRITE
  );
  wrk.writeStringValue("installation_mode", "allowed");
  wrk.close();
  wrk.create(
    wrk.ROOT_KEY_CURRENT_USER,
    regLocation + "\\ExtensionSettings\\addon",
    wrk.ACCESS_WRITE
  );
  wrk.writeStringValue("installation_mode", "force_installed");
  wrk.close();

  await setupPolicyEngineWithJson({ policies: {} });

  ok(mergeRan, "ExtensionSettings ran correctly through onProfileAfterChange");

  Policies.ExtensionSettings = originalExtensionSettings;

  wrk.open(wrk.ROOT_KEY_CURRENT_USER, "SOFTWARE\\Mozilla", wrk.ACCESS_WRITE);
  wrk.removeChild(
    "PolicyTesting\\Mozilla\\" +
      Services.appinfo.name +
      "\\ExtensionSettings\\*"
  );
  wrk.removeChild(
    "PolicyTesting\\Mozilla\\" +
      Services.appinfo.name +
      "\\ExtensionSettings\\addon"
  );
  wrk.removeChild(
    "PolicyTesting\\Mozilla\\" + Services.appinfo.name + "\\ExtensionSettings"
  );
  wrk.removeChild("PolicyTesting\\Mozilla\\" + Services.appinfo.name);
  wrk.removeChild("PolicyTesting\\Mozilla");
  wrk.removeChild("PolicyTesting");
  wrk.close();
});

add_task(async function test_gpo_blank_json_policies() {
  let { Policies } = ChromeUtils.importESModule(
    "resource:///modules/policies/Policies.sys.mjs"
  );

  let gpoPolicyRan = false;

  Policies.gpo_policy = {
    onProfileAfterChange(manager, param) {
      is(param, true, "Param matches what was in the registry");
      gpoPolicyRan = true;
    },
  };

  let wrk = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
    Ci.nsIWindowsRegKey
  );
  let regLocation =
    "SOFTWARE\\BrowserWorks\\PolicyTesting\\BrowserWorks\\" +
    Services.appinfo.name;
  wrk.create(wrk.ROOT_KEY_CURRENT_USER, regLocation, wrk.ACCESS_WRITE);
  wrk.writeIntValue("gpo_policy", 1);
  wrk.close();

  await setupPolicyEngineWithJson(
    // policies.json missing the "policies" object entirely
    {},

    // custom schema
    {
      properties: {
        gpo_policy: {
          type: "boolean",
        },
      },
    }
  );

  is(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "Engine is active"
  );

  ok(gpoPolicyRan, "GPO Policy ran correctly though onProfileAfterChange");

  delete Policies.gpo_policy;

  wrk.open(
    wrk.ROOT_KEY_CURRENT_USER,
    "SOFTWARE\\BrowserWorks",
    wrk.ACCESS_WRITE
  );
  wrk.removeChild("PolicyTesting\\BrowserWorks\\" + Services.appinfo.name);
  wrk.removeChild("PolicyTesting\\BrowserWorks");
  wrk.removeChild("PolicyTesting");
  wrk.close();
});

add_task(async function test_gpo_broken_json_policies() {
  let { Policies } = ChromeUtils.importESModule(
    "resource:///modules/policies/Policies.sys.mjs"
  );

  let gpoPolicyRan = false;

  Policies.gpo_policy = {
    onProfileAfterChange(manager, param) {
      is(param, true, "Param matches what was in the registry");
      gpoPolicyRan = true;
    },
  };

  let wrk = Cc["@mozilla.org/windows-registry-key;1"].createInstance(
    Ci.nsIWindowsRegKey
  );
  let regLocation =
    "SOFTWARE\\BrowserWorks\\PolicyTesting\\BrowserWorks\\" +
    Services.appinfo.name;
  wrk.create(wrk.ROOT_KEY_CURRENT_USER, regLocation, wrk.ACCESS_WRITE);
  wrk.writeIntValue("gpo_policy", 1);
  wrk.close();

  await setupPolicyEngineWithJson(
    "config_broken_json.json",
    // custom schema
    {
      properties: {
        gpo_policy: {
          type: "boolean",
        },
      },
    }
  );

  is(
    Services.policies.status,
    Ci.nsIEnterprisePolicies.ACTIVE,
    "Engine is active"
  );

  ok(gpoPolicyRan, "GPO Policy ran correctly though onProfileAfterChange");

  delete Policies.gpo_policy;

  wrk.open(
    wrk.ROOT_KEY_CURRENT_USER,
    "SOFTWARE\\BrowserWorks",
    wrk.ACCESS_WRITE
  );
  wrk.removeChild("PolicyTesting\\BrowserWorks\\" + Services.appinfo.name);
  wrk.removeChild("PolicyTesting\\BrowserWorks");
  wrk.removeChild("PolicyTesting");
  wrk.close();
});
