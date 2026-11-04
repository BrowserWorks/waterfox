/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { ICloudPasswordsService } = ChromeUtils.importESModule(
  "resource:///modules/ICloudPasswords.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
const ICLOUD_ORIGIN = "https://login.example.com";
const TEST_CREDENTIAL = "synthetic-test-value-not-a-real-credential";
const TEST_LOGIN = Object.freeze({
  origin: ICLOUD_ORIGIN,
  username: "alice",
  password: TEST_CREDENTIAL,
});

do_get_profile();

function otpScopeKey(origin, { frameURLs, tabId = 0, frameId = 0 }) {
  return JSON.stringify([origin, tabId, frameId, frameURLs]);
}

function createProvider(name, { enableOTP = true, ...options } = {}) {
  let prefs = Services.prefs.getBranch(`test.icloud-passwords.${name}.`);
  if (enableOTP) {
    prefs.setBoolPref("waterfox.passwords.icloud.otp.enabled", true);
  }
  let client = {
    supported: true,
    canFillOneTimeCodes: true,
    state: "disconnected",
    calls: [],
    accounts: [{ username: "alice", sites: ["example.com"] }],
    passwordResult: {
      username: "alice",
      sites: ["example.com"],
      password: TEST_CREDENTIAL,
    },
    codes: [],
    otpScopes: new Map(),
    otpRequests: [],
    scopedCodes(origin, context) {
      let key = otpScopeKey(origin, context);
      if (this.otpScopes.has(key)) {
        return this.otpScopes.get(key);
      }
      return key ===
        otpScopeKey(ICLOUD_ORIGIN, { frameURLs: [`${ICLOUD_ORIGIN}/`] })
        ? this.codes
        : [];
    },
    get isReady() {
      return this.state == "ready";
    },
    setState(state, error) {
      this.calls.push(state);
      this.state = state;
      this.onStateChange?.(state, { error });
    },
    getStatus() {
      this.calls.push("status");
      return { supported: true, available: true, state: this.state };
    },
    async connect() {
      this.setState("locked");
    },
    async beginPairing() {
      this.setState("pairing");
    },
    async completePairing(pin) {
      Assert.equal(pin, "123456");
      this.setState("ready");
    },
    async lock() {
      this.setState("locked");
    },
    async listAccounts() {
      this.calls.push("list-accounts");
      return this.accounts;
    },
    async getPassword() {
      this.calls.push("get-password");
      return this.passwordResult;
    },
    async savePassword() {
      this.calls.push("save-password");
      return { accepted: true, verified: false };
    },
    async listOneTimeCodes(origin, context) {
      this.calls.push("list-codes");
      this.otpRequests.push({ command: 16, origin, context });
      return this.scopedCodes(origin, context).map(entry => ({ ...entry }));
    },
    async getOneTimeCodes(origin, context) {
      this.calls.push("get-codes");
      this.otpRequests.push({ command: 17, origin, context });
      return this.scopedCodes(origin, context)
        .filter(entry => entry.username === context.username)
        .map(entry => ({ ...entry }));
    },
  };
  let service = new ICloudPasswordsService({
    platform: "macosx",
    platformVersion: "23.0.0",
    prefs,
    observers: Services.obs,
    clientFactory({ onStateChange }) {
      client.calls.push("create");
      client.onStateChange = onStateChange;
      return client;
    },
    promptPIN() {
      Assert.equal(
        client.state,
        "pairing",
        "The native challenge precedes the prompt"
      );
      return "123456";
    },
    localization: {
      async formatValues(messages) {
        return messages.map(message => message.id);
      },
      async formatValue(id) {
        return id;
      },
    },
    ...options,
  });
  registerCleanupFunction(async () => {
    await service.destroy();
    prefs.deleteBranch("");
  });
  return { service, client, prefs };
}

add_task(async function test_provider_features_require_explicit_opt_in() {
  const { service, client, prefs } = createProvider("opt-in-defaults", {
    enableOTP: false,
  });
  const defaults = Services.prefs.getDefaultBranch("");
  for (const pref of ["enabled", "saveByDefault", "otp.enabled"]) {
    Assert.strictEqual(
      defaults.getBoolPref(`waterfox.passwords.icloud.${pref}`),
      false,
      "Each shipped feature default is disabled"
    );
    Assert.ok(
      !Services.prefs.prefIsLocked(`waterfox.passwords.icloud.${pref}`)
    );
  }
  Assert.ok(!service.enabled);
  Assert.ok(!service.saveByDefault);
  Assert.ok(!service.otpEnabled, "Missing OTP preferences also fail closed");
  Assert.equal(
    defaults.getIntPref("waterfox.passwords.icloud.idleTimeout"),
    900,
    "The shipped lock timeout is fifteen minutes"
  );
  await service.getStatus();
  Assert.deepEqual(
    client.calls,
    [],
    "Defaults do not construct a native client"
  );
  service.setEnabled(true);
  Assert.ok(
    service.otpEnabled,
    "Enabling passwords opts in to verification codes"
  );
  Assert.ok(service.saveByDefault, "Enabling selects iCloud for new passwords");
  prefs.setBoolPref("waterfox.passwords.icloud.otp.enabled", false);
  Assert.ok(
    !service.otpEnabled,
    "Verification codes can be disabled separately"
  );
});

add_task(async function test_platform_version_gate() {
  for (const [platform, version, supported] of [
    ["linux", "6.8.0", false],
    ["macosx", "22.6.0", false],
    ["macosx", "23.0.0", true],
    ["macosx", "24.0.0", true],
  ]) {
    const { service, client } = createProvider(`${platform}-${version}`, {
      platform,
      platformVersion: version,
    });
    Assert.equal(service.supported, supported);
    Assert.equal(await service.isAvailable(), supported);
    if (!supported) {
      service.setEnabled(true);
      await Assert.rejects(
        service.unlock(null),
        error => error.code === "unsupported"
      );
    }
    Assert.deepEqual(
      client.calls,
      [],
      "Platform checks never construct or unlock the native client"
    );
  }
});

add_task(async function test_windows_requires_installed_native_host() {
  const executable = PathUtils.join(
    do_get_tempdir().path,
    "icloud-passwords-ui-test.exe"
  );
  await IOUtils.writeUTF8(executable, "synthetic test file");
  registerCleanupFunction(() => IOUtils.remove(executable));
  for (const [name, host, expected] of [
    ["missing-registration", null, false],
    ["missing-executable", { command: `${executable}.missing` }, false],
    ["installed", { command: executable }, true],
    ["directory", { command: PathUtils.parent(executable) }, false],
  ]) {
    const { service, client } = createProvider(`windows-${name}`, {
      platform: "win",
      discoverHost: async ({ platform }) => {
        Assert.equal(platform, "win");
        return host;
      },
    });
    Assert.equal(await service.isAvailable(), expected);
    Assert.deepEqual(
      client.calls,
      [],
      "Installation detection does not launch or pair with the native host"
    );
  }
});

add_task(async function test_passive_queries_and_explicit_unlock_lock() {
  let { service, client } = createProvider("passive");
  Assert.ok(!service.enabled);
  await service.getStatus();
  Assert.deepEqual(await service.listAccounts(ICLOUD_ORIGIN), []);
  Assert.deepEqual(await service.listOneTimeCodes(ICLOUD_ORIGIN), []);
  Assert.deepEqual(
    client.calls,
    [],
    "Disabled queries do not construct the client"
  );
  service.setEnabled(true);
  await service.getStatus();
  Assert.deepEqual(await service.listAccounts(ICLOUD_ORIGIN), []);
  Assert.deepEqual(await service.listOneTimeCodes(ICLOUD_ORIGIN), []);
  Assert.deepEqual(
    client.calls,
    ["create", "status"],
    "Passive queries never pair"
  );
  Assert.ok(await service.unlock(null));
  Assert.ok(service.isReady);
  await service.lock();
  Assert.ok(!service.isReady);
  Assert.equal(client.state, "locked");
});

add_task(async function test_pending_pin_is_invalidated_without_repairing() {
  for (let transition of [
    "timeout",
    "connection-closed",
    "native-lock",
    "disable",
    "sleep",
    "lock",
    "destroy",
  ]) {
    let prompted = Promise.withResolvers();
    let response = Promise.withResolvers();
    let signals = [];
    let { service, client } = createProvider(`pin-expiry-${transition}`, {
      promptPIN(_parent, { signal }) {
        signals.push(signal);
        prompted.resolve();
        return signals.length === 1 ? response.promise : "123456";
      },
    });
    service.setEnabled(true);
    let rejected = service.verifySavedLogin(null, TEST_LOGIN).then(
      () => null,
      error => error
    );
    await prompted.promise;
    let concurrent = service.unlock(null).then(
      () => null,
      error => error
    );
    let expected = "session-changed";
    switch (transition) {
      case "timeout":
        client.setState("locked", "timeout");
        expected = "timeout";
        break;
      case "connection-closed":
        client.setState("disconnected", "connection-closed");
        expected = "unavailable";
        break;
      case "native-lock":
        client.setState("locked");
        expected = "locked";
        break;
      case "disable":
        service.setEnabled(false);
        break;
      case "sleep":
        service.observe(null, "sleep_notification");
        break;
      case "lock":
        await service.lock();
        break;
      case "destroy":
        await service.destroy();
        break;
    }
    Assert.ok(signals[0].aborted, "The exact pending challenge is aborted");
    Assert.equal(signals[0].reason.code, expected);
    for (let error of await Promise.all([rejected, concurrent])) {
      Assert.equal(error?.code, expected);
      Assert.equal(
        error?.message,
        error?.l10nId,
        "Only a safe error is exposed"
      );
    }
    Assert.equal(service.lastErrorCode, expected);
    Assert.equal(signals.length, 1, "Expiry never prompts again automatically");
    Assert.equal(client.calls.filter(call => call === "pairing").length, 1);
    Assert.ok(!client.calls.includes("ready"), "No PIN was submitted");
    Assert.ok(
      !client.calls.includes("list-accounts") &&
        !client.calls.includes("get-password") &&
        !client.calls.includes("save-password"),
      "Aborting unlock never reads or writes a credential"
    );
    if (transition !== "destroy") {
      service.setEnabled(true);
      Assert.ok(
        await service.unlock(null),
        "Only an explicit unlock can retry"
      );
      Assert.notEqual(signals[0], signals[1]);
      Assert.ok(!signals[1].aborted, "The new challenge has its own signal");
    }
    response.resolve("123456");
    await TestUtils.waitForTick();
    Assert.equal(
      client.calls.filter(call => call === "ready").length,
      transition === "destroy" ? 0 : 1,
      "A late result from the expired prompt is never submitted"
    );
    await service.destroy();
  }
});

add_task(
  async function test_pin_expiry_during_localization_never_opens_prompt() {
    let localizing = Promise.withResolvers();
    let localized = Promise.withResolvers();
    let { service, client } = createProvider("pin-expiry-localization", {
      localization: {
        formatValues() {
          localizing.resolve();
          return localized.promise;
        },
        async formatValue(id) {
          return id;
        },
      },
      promptPIN() {
        Assert.ok(false, "An expired challenge must not open a PIN prompt");
      },
    });
    service.setEnabled(true);
    let rejected = service.unlock(null).then(
      () => null,
      error => error
    );
    await localizing.promise;
    client.setState("locked", "timeout");
    Assert.equal((await rejected)?.code, "timeout");
    localized.resolve(["Synthetic title", "Synthetic text"]);
    await TestUtils.waitForTick();
    Assert.equal(client.calls.filter(call => call === "pairing").length, 1);
    Assert.ok(!client.calls.includes("ready"));
  }
);

add_task(
  async function test_ready_session_reuse_and_fifteen_minute_idle_lock() {
    let now = 0;
    let timers = [];
    let { service, client } = createProvider("pin-session-reuse", {
      now: () => now,
      timerFactory(callback, delay) {
        timers.push({ callback, delay });
        return { cancel() {} };
      },
    });
    service.setEnabled(true);
    Assert.ok(await service.unlock(null));
    now = 120000;
    Assert.ok(await service.unlock(null), "A ready session needs no new PIN");
    Assert.equal(client.calls.filter(call => call === "pairing").length, 1);
    Assert.equal(
      timers.at(-1).delay,
      900000,
      "Idle timeout is fifteen minutes"
    );
    now += 899999;
    Assert.ok(service.isReady);
    now++;
    timers.at(-1).callback();
    Assert.ok(!service.isReady, "The session locks at the idle deadline");
    Assert.equal(client.calls.filter(call => call === "pairing").length, 1);
    Assert.ok(
      await service.unlock(null),
      "Reauthentication requires a new request"
    );
    Assert.equal(client.calls.filter(call => call === "pairing").length, 2);
  }
);

add_task(async function test_origin_and_selected_credential_identity() {
  let { service, client } = createProvider("identity");
  service.setEnabled(true);
  await service.unlock(null);
  client.accounts[0].sites = ["https://example.com/login"];
  client.getPassword = async (_origin, selected) => {
    Assert.deepEqual(selected.sites, ["https://example.com/login"]);
    return client.passwordResult;
  };
  client.accounts.push({
    username: "other",
    sites: ["example.com.evil.invalid"],
  });
  let accounts = await service.listAccounts(ICLOUD_ORIGIN);
  Assert.deepEqual(accounts, [
    { username: "alice", sites: ["https://example.com"] },
  ]);
  await Assert.rejects(
    service.getPassword("http://login.example.com", accounts[0], null),
    error => error.code == "invalid-origin"
  );
  let password = await service.getPassword(ICLOUD_ORIGIN, accounts[0], null);
  Assert.strictEqual(password.password, TEST_CREDENTIAL);
  client.passwordResult.username = "other";
  await Assert.rejects(
    service.getPassword(ICLOUD_ORIGIN, accounts[0], null),
    error => error.code == "account-mismatch"
  );
});

add_task(async function test_otp_requires_explicit_native_capability() {
  let { service, client } = createProvider("otp-capability");
  service.setEnabled(true);
  await service.unlock(null);
  let selection = { username: "alice", domain: "example.com", source: "totp" };
  client.codes = [{ ...selection, code: "123456" }];
  for (let capability of [false, undefined]) {
    client.canFillOneTimeCodes = capability;
    Assert.deepEqual(await service.listOneTimeCodes(ICLOUD_ORIGIN), []);
    await Assert.rejects(
      service.getOneTimeCode(ICLOUD_ORIGIN, selection, null),
      error => error.code === "no-code"
    );
  }
  Assert.ok(
    !client.calls.includes("list-codes") && !client.calls.includes("get-codes")
  );
});

add_task(async function test_stale_password_and_save_responses() {
  let { service, client } = createProvider("stale");
  service.setEnabled(true);
  await service.unlock(null);
  let account = (await service.listAccounts(ICLOUD_ORIGIN))[0];
  for (let method of ["getPassword", "savePassword"]) {
    let requested = Promise.withResolvers();
    let response = Promise.withResolvers();
    client[method] = async () => {
      requested.resolve();
      return response.promise;
    };
    let result =
      method === "getPassword"
        ? service.getPassword(ICLOUD_ORIGIN, account, null)
        : service.saveLogin(null, TEST_LOGIN);
    let rejected = result.then(
      () => null,
      error => error
    );
    await requested.promise;
    service.setEnabled(false);
    service.setEnabled(true);
    await service.unlock(null);
    response.resolve(
      method === "getPassword"
        ? client.passwordResult
        : { accepted: true, verified: false }
    );
    Assert.equal((await rejected)?.code, "session-changed");
    Assert.ok(
      service.isReady,
      "Rejecting an old result does not lock the new session"
    );
  }
});

add_task(async function test_accepted_native_save_without_local_persistence() {
  let { service, client } = createProvider("save");
  let before = (await Services.logins.getAllLogins()).map(login => login.guid);
  let acknowledgement = Promise.withResolvers();
  let sent = Promise.withResolvers();
  client.savePassword = async request => {
    Assert.deepEqual(request, TEST_LOGIN);
    sent.resolve();
    await acknowledgement.promise;
    return { accepted: true, verified: false };
  };
  service.setEnabled(true);
  let settled = false;
  let saving = service.saveLogin(null, TEST_LOGIN).then(result => {
    settled = true;
    return result;
  });
  await sent.promise;
  Assert.ok(!settled, "Save waits for the native client's acknowledgement");
  acknowledgement.resolve();
  Assert.deepEqual(await saving, { accepted: true, verified: false });
  client.savePassword = async () => undefined;
  await Assert.rejects(
    service.saveLogin(null, TEST_LOGIN),
    error => error.code == "save-failed",
    "A legacy empty result is not save acceptance"
  );
  client.savePassword = async () => {
    throw Object.assign(new Error("Synthetic save failure"), {
      code: "save-failed",
    });
  };
  await Assert.rejects(
    service.saveLogin(null, TEST_LOGIN),
    error => error.code == "save-failed"
  );
  let after = (await Services.logins.getAllLogins()).map(entry => entry.guid);
  Assert.deepEqual(
    after,
    before,
    "Native acceptance and failure never add local logins"
  );
});

add_task(async function test_verify_save_acceptance_and_read_only_retry() {
  let { service, client } = createProvider("verify-retry");
  let before = (await Services.logins.getAllLogins()).map(login => login.guid);
  service.setEnabled(true);
  client.accounts = [];
  Assert.deepEqual(await service.saveLogin(null, TEST_LOGIN), {
    accepted: true,
    verified: false,
  });
  Assert.ok(
    !client.calls.includes("list-accounts") &&
      !client.calls.includes("get-password"),
    "Save acceptance is not read-back proof"
  );
  Assert.strictEqual(await service.verifySavedLogin(null, TEST_LOGIN), false);
  Assert.ok(
    !client.calls.includes("get-password"),
    "A missing selected account never retrieves another password"
  );
  client.accounts = [{ username: "alice", sites: ["example.com"] }];
  Assert.strictEqual(await service.verifySavedLogin(null, TEST_LOGIN), true);
  client.passwordResult.password = "synthetic-different-value";
  Assert.strictEqual(
    await service.verifySavedLogin(null, TEST_LOGIN),
    false,
    "Verification always reads again rather than caching proof"
  );
  Assert.equal(
    client.calls.filter(call => call === "save-password").length,
    1,
    "Check-only retries never repeat the write"
  );
  Assert.deepEqual(
    (await Services.logins.getAllLogins()).map(login => login.guid),
    before,
    "Verification never persists a local login"
  );
});

add_task(async function test_verify_exact_native_account_and_site_provenance() {
  let { service, client } = createProvider("verify-provenance");
  let origin = "https://login.example.com:8443";
  let nativeSite = "https://example.com:8443/login?source=fixture";
  let filteredSites = [
    "https://example.com",
    "https://example.com:9443",
    "https://unrelated.invalid:8443",
    "https://other.example.com:8443",
    "https://com:8443",
    "https://example.com.evil.invalid:8443",
  ];
  client.accounts = [
    { username: "other", sites: [nativeSite] },
    { username: "Alice", sites: [nativeSite] },
    ...filteredSites.map(site => ({ username: "alice", sites: [site] })),
    { username: "alice", sites: [...filteredSites, nativeSite] },
  ];
  client.listAccounts = async requestedOrigin => {
    Assert.equal(requestedOrigin, origin);
    client.calls.push("list-accounts");
    return client.accounts;
  };
  client.getPassword = async (requestedOrigin, selected) => {
    Assert.equal(requestedOrigin, origin);
    Assert.deepEqual(selected, { username: "alice", sites: [nativeSite] });
    client.calls.push("get-password");
    return {
      username: "alice",
      sites: ["https://example.com:8443"],
      password: TEST_CREDENTIAL,
    };
  };
  service.setEnabled(true);
  Assert.strictEqual(
    await service.verifySavedLogin(null, {
      ...TEST_LOGIN,
      origin,
      oldUsername: "other",
      oldPassword: "synthetic-previous-value",
    }),
    true
  );
  Assert.equal(
    client.calls.filter(call => call === "get-password").length,
    1,
    "Only the unique selected username and matching native sites are read"
  );
  Assert.ok(!client.calls.includes("save-password"));
});

add_task(async function test_verify_rejects_duplicate_account_ambiguity() {
  let { service, client } = createProvider("verify-ambiguous");
  service.setEnabled(true);
  await service.unlock(null);
  for (let sites of [
    ["example.com"],
    ["https://example.com/login"],
    [ICLOUD_ORIGIN],
  ]) {
    client.accounts = [
      { username: "alice", sites: ["example.com"] },
      { username: "alice", sites },
    ];
    await Assert.rejects(
      service.verifySavedLogin(null, TEST_LOGIN),
      error => error.code === "ambiguous-account",
      "Even identical or canonically identical native duplicates are ambiguous"
    );
  }
  Assert.ok(
    !client.calls.includes("get-password") &&
      !client.calls.includes("save-password"),
    "Ambiguity never chooses the first account or performs a write"
  );
});

add_task(async function test_verify_validates_before_native_authentication() {
  let { service, client } = createProvider("verify-validation");
  service.setEnabled(true);
  for (let login of [
    undefined,
    null,
    {},
    ...[
      "http://login.example.com",
      "https://login.example.com/path",
      "https://login.example.com?query=1",
      "https://login.example.com#fragment",
      "https://user:synthetic@login.example.com",
      "https://login.example.com\0",
    ].map(origin => ({ ...TEST_LOGIN, origin })),
  ]) {
    await Assert.rejects(
      service.verifySavedLogin(null, login),
      error => error.code === "invalid-origin"
    );
  }
  for (let key of ["username", "password"]) {
    for (let value of [
      undefined,
      null,
      42,
      "synthetic\0value",
      "x".repeat(key === "username" ? 4097 : 1048577),
    ]) {
      await Assert.rejects(
        service.verifySavedLogin(null, { ...TEST_LOGIN, [key]: value }),
        error => error.code === "account-mismatch"
      );
    }
  }
  Assert.deepEqual(
    client.calls,
    [],
    "Invalid requests neither construct the client nor authenticate"
  );
});

add_task(async function test_verify_missing_accounts_and_mismatched_readback() {
  let { service, client } = createProvider("verify-mismatch");
  service.setEnabled(true);
  for (let accounts of [
    [],
    [{ username: "other", sites: ["example.com"] }],
    [{ username: "Alice", sites: ["example.com"] }],
    [{ username: "alice", sites: ["unrelated.invalid"] }],
    [{ username: "alice", sites: ["https://example.com:8443"] }],
  ]) {
    client.accounts = accounts;
    Assert.strictEqual(await service.verifySavedLogin(null, TEST_LOGIN), false);
  }
  Assert.ok(
    !client.calls.includes("get-password"),
    "No password is read without a unique matching account"
  );
  client.accounts = [{ username: "alice", sites: ["example.com"] }];
  for (let result of [
    null,
    { ...client.passwordResult, username: "other" },
    { ...client.passwordResult, username: "Alice" },
    { ...client.passwordResult, sites: ["unrelated.invalid"] },
    { ...client.passwordResult, sites: ["https://example.com:8443"] },
    { ...client.passwordResult, sites: [ICLOUD_ORIGIN] },
    ...[undefined, null, 42, "", TEST_CREDENTIAL.toUpperCase()].map(
      password => ({
        ...client.passwordResult,
        password,
      })
    ),
  ]) {
    client.getPassword = async () => result;
    Assert.strictEqual(
      await service.verifySavedLogin(null, TEST_LOGIN),
      false,
      "Only an exact returned identity and password can verify"
    );
  }
  client.getPassword = async () => {
    throw Object.assign(new Error("Synthetic no results"), {
      code: "no-results",
    });
  };
  Assert.strictEqual(await service.verifySavedLogin(null, TEST_LOGIN), false);
  Assert.ok(!client.calls.includes("save-password"));
});

add_task(
  async function test_verify_native_errors_are_sanitized_without_retry() {
    for (let method of ["listAccounts", "getPassword"]) {
      for (let [nativeCode, expectedCode] of [
        ["timeout", "timeout"],
        ["canceled", "cancelled"],
        ["native-auth-required", "authentication-failed"],
        ["unknown-error", "native-error"],
      ]) {
        let { service, client } = createProvider(
          `verify-${method}-${nativeCode}`
        );
        let reads = 0;
        client[method] = async () => {
          reads++;
          throw Object.assign(new Error(TEST_CREDENTIAL), { code: nativeCode });
        };
        service.setEnabled(true);
        await Assert.rejects(
          service.verifySavedLogin(null, TEST_LOGIN),
          error =>
            error.code === expectedCode &&
            !error.message.includes(TEST_CREDENTIAL) &&
            error.l10nId === error.message,
          "Native failures reject with safe provider errors, never save acceptance"
        );
        Assert.equal(reads, 1, "Read failures are not automatically retried");
        Assert.ok(!client.calls.includes("save-password"));
        await service.destroy();
      }
    }
  }
);

add_task(async function test_cancelled_authentication_and_verification_gates() {
  let { service: cancelled, client: cancelledClient } = createProvider(
    "verify-cancelled",
    { promptPIN: () => null }
  );
  cancelled.setEnabled(true);
  for (let method of ["saveLogin", "verifySavedLogin"]) {
    Assert.strictEqual(await cancelled[method](null, TEST_LOGIN), false);
    Assert.ok(!cancelled.isReady);
    Assert.equal(cancelled.lastErrorCode, "cancelled");
  }
  Assert.ok(
    !cancelledClient.calls.includes("ready") &&
      !cancelledClient.calls.includes("list-accounts") &&
      !cancelledClient.calls.includes("get-password") &&
      !cancelledClient.calls.includes("save-password"),
    "Cancelled authentication never reads or writes credentials"
  );
  for (let [name, options, enable, expectedCode] of [
    ["disabled", {}, false, "disabled"],
    ["unsupported", { platform: "linux" }, true, "unsupported"],
  ]) {
    let { service, client } = createProvider(`verify-${name}`, options);
    service.setEnabled(enable);
    await Assert.rejects(
      service.verifySavedLogin(null, TEST_LOGIN),
      error => error.code === expectedCode
    );
    Assert.deepEqual(client.calls, []);
  }
});

add_task(
  async function test_verify_binds_listing_and_password_to_one_session() {
    for (let method of ["listAccounts", "getPassword"]) {
      for (let transition of [
        "disable",
        "replace-session",
        "lock",
        "native-lock",
        "native-relock",
        "silent-native-lock",
        "sleep",
        "idle",
        "destroy",
      ]) {
        let now = 0;
        let { service, client } = createProvider(
          `verify-${method}-${transition}`,
          {
            now: () => now,
            timerFactory: () => ({ cancel() {} }),
          }
        );
        service.setEnabled(true);
        await service.unlock(null);
        let requested = Promise.withResolvers();
        let response = Promise.withResolvers();
        client[method] = async () => {
          client.calls.push(
            method === "listAccounts" ? "list-accounts" : "get-password"
          );
          requested.resolve();
          return response.promise;
        };
        let rejected = service.verifySavedLogin(null, TEST_LOGIN).then(
          () => null,
          error => error
        );
        await requested.promise;
        switch (transition) {
          case "disable":
            service.setEnabled(false);
            break;
          case "replace-session":
            service.setEnabled(false);
            service.setEnabled(true);
            await service.unlock(null);
            break;
          case "lock":
            await service.lock();
            break;
          case "native-lock":
            client.setState("locked");
            break;
          case "native-relock":
            client.setState("locked");
            client.setState("ready");
            break;
          case "silent-native-lock":
            client.state = "locked";
            break;
          case "sleep":
            service.observe(null, "sleep_notification");
            break;
          case "idle":
            now = 900000;
            break;
          case "destroy":
            await service.destroy();
            break;
        }
        response.resolve(
          method === "listAccounts" ? client.accounts : client.passwordResult
        );
        Assert.equal(
          (await rejected)?.code,
          transition === "silent-native-lock" ? "locked" : "session-changed",
          "A matching stale response cannot verify or resume in a new session"
        );
        Assert.equal(
          client.calls.filter(call => call === "get-password").length,
          method === "getPassword" ? 1 : 0,
          "Invalidating the account listing prevents the password read"
        );
        Assert.ok(!client.calls.includes("save-password"));
        if (["replace-session", "native-relock"].includes(transition)) {
          Assert.ok(
            service.isReady,
            "Stale results do not lock the new session"
          );
        }
        await service.destroy();
      }
    }
  }
);

add_task(
  async function test_verify_stale_read_error_is_not_a_missing_account() {
    for (let method of ["listAccounts", "getPassword"]) {
      let { service, client } = createProvider(`verify-stale-error-${method}`);
      service.setEnabled(true);
      await service.unlock(null);
      let requested = Promise.withResolvers();
      let response = Promise.withResolvers();
      client[method] = async () => {
        requested.resolve();
        return response.promise;
      };
      let rejected = service.verifySavedLogin(null, TEST_LOGIN).then(
        () => null,
        error => error
      );
      await requested.promise;
      await service.lock();
      await service.unlock(null);
      response.reject(
        Object.assign(new Error(TEST_CREDENTIAL), { code: "no-results" })
      );
      Assert.equal((await rejected)?.code, "session-changed");
      Assert.ok(service.isReady);
      Assert.ok(!client.calls.includes("save-password"));
    }
  }
);

add_task(async function test_verify_rejects_unlock_from_replaced_session() {
  for (let transition of ["replace-session", "native-relock"]) {
    let { service, client } = createProvider(`verify-unlock-${transition}`);
    service.setEnabled(true);
    let unlock = service.unlock.bind(service);
    await unlock(null);
    let authenticated = Promise.withResolvers();
    let resume = Promise.withResolvers();
    service.unlock = async parent => {
      let result = await unlock(parent);
      authenticated.resolve();
      await resume.promise;
      return result;
    };
    let rejected = service.verifySavedLogin(null, TEST_LOGIN).then(
      () => null,
      error => error
    );
    await authenticated.promise;
    if (transition === "replace-session") {
      await service.lock();
      await unlock(null);
    } else {
      client.setState("locked");
      client.setState("ready");
    }
    resume.resolve();
    Assert.equal((await rejected)?.code, "session-changed");
    Assert.ok(service.isReady);
    Assert.ok(
      !client.calls.includes("list-accounts") &&
        !client.calls.includes("get-password") &&
        !client.calls.includes("save-password"),
      "A stale unlock never starts a read or write in the replacement session"
    );
  }
});

add_task(async function test_verify_can_authenticate_after_idle_expiry() {
  let now = 0;
  let { service, client } = createProvider("verify-after-idle", {
    now: () => now,
    timerFactory: () => ({ cancel() {} }),
  });
  service.setEnabled(true);
  await service.unlock(null);
  now = 900000;
  Assert.strictEqual(await service.verifySavedLogin(null, TEST_LOGIN), true);
  Assert.equal(
    client.calls.filter(call => call === "pairing").length,
    2,
    "An expired session requires the existing native authentication again"
  );
  Assert.ok(!client.calls.includes("save-password"));
});

add_task(async function test_verify_snapshots_expected_credential() {
  let { service, client } = createProvider("verify-snapshot");
  service.setEnabled(true);
  let requested = Promise.withResolvers();
  let response = Promise.withResolvers();
  client.getPassword = async () => {
    requested.resolve();
    return response.promise;
  };
  let login = { ...TEST_LOGIN, password: "synthetic-different-value" };
  let verification = service.verifySavedLogin(null, login);
  await requested.promise;
  login.origin = "https://unrelated.invalid";
  login.username = "other";
  login.password = TEST_CREDENTIAL;
  response.resolve(client.passwordResult);
  Assert.strictEqual(
    await verification,
    false,
    "Mutating the caller's login during a read cannot change the expected proof"
  );
  Assert.ok(!client.calls.includes("save-password"));
});

add_task(
  async function test_otp_issuer_is_raw_identity_in_trusted_frame_scope() {
    let { service, client } = createProvider("otp-raw-issuer");
    let context = {
      frameURLs: [
        `${ICLOUD_ORIGIN}/sign-in?step=OTP#field`,
        `${ICLOUD_ORIGIN}/parent`,
      ],
      tabId: 42,
      frameId: 7,
    };
    let identity = {
      username: " Alice@Example ",
      domain: " Other.Issuer / Personal Account ",
      source: "totp",
    };
    let code = { ...identity, code: "012345" };
    let other = { ...identity, username: "Other account" };
    client.otpScopes.set(otpScopeKey(ICLOUD_ORIGIN, context), [
      code,
      { ...other, code: "654321" },
      { ...code, source: "sms" },
    ]);
    client.accounts = [];
    client.listAccounts = async () =>
      Assert.ok(false, "OTP never joins password sites");
    client.getPassword = async () =>
      Assert.ok(false, "OTP never reads a password");
    service.setEnabled(true);
    await service.unlock(null);
    Assert.deepEqual(await service.listOneTimeCodes(ICLOUD_ORIGIN, context), [
      identity,
      other,
    ]);
    Assert.deepEqual(
      await service.getOneTimeCode(
        ICLOUD_ORIGIN,
        { ...identity, code: "999999" },
        null,
        context
      ),
      code,
      "Only the freshly retrieved native code is returned; raw issuer case/spaces survive"
    );
    Assert.deepEqual(
      client.otpRequests.map(({ command }) => command),
      [16, 16, 17]
    );
    let metadata = client.otpRequests.at(-2).context;
    let retrieval = client.otpRequests.at(-1).context;
    Assert.deepEqual(metadata, context);
    Assert.ok(Object.isFrozen(metadata) && Object.isFrozen(metadata.frameURLs));
    Assert.ok(Object.isFrozen(retrieval));
    Assert.strictEqual(metadata.frameURLs, retrieval.frameURLs);
    Assert.strictEqual(retrieval.username, identity.username);
    Assert.ok(!Object.hasOwn(retrieval, "domain"));
    code.code = "234567";
    Assert.equal(
      (await service.getOneTimeCode(ICLOUD_ORIGIN, identity, null, context))
        .code,
      code.code,
      "Explicit retrieval does not cache plaintext codes"
    );
    let before = client.calls.filter(call => call === "get-codes").length;
    await Assert.rejects(
      service.getOneTimeCode(ICLOUD_ORIGIN, identity, null, {
        ...context,
        frameId: 8,
      }),
      error => error.code === "account-mismatch",
      "An identity from another routing context is not a selector for this context"
    );
    await Assert.rejects(
      service.getOneTimeCode("https://foreign.invalid", identity, null),
      error => error.code === "account-mismatch"
    );
    Assert.equal(
      client.calls.filter(call => call === "get-codes").length,
      before
    );
    Assert.ok(!client.calls.includes("save-password"));
  }
);

add_task(
  async function test_otp_relist_rejects_spoofed_and_duplicate_selectors() {
    let { service, client } = createProvider("otp-relist");
    let identity = {
      username: "Alice",
      domain: " Issuer.Example Login ",
      source: "totp",
    };
    client.codes = [{ ...identity, code: "012345" }];
    service.setEnabled(true);
    await service.unlock(null);
    for (let selection of [
      null,
      { username: identity.username, sites: [ICLOUD_ORIGIN] },
      { ...identity, username: "alice" },
      { ...identity, domain: identity.domain.trim() },
      { ...identity, domain: identity.domain.toLowerCase() },
      { ...identity, domain: "Unlisted Issuer", code: "012345" },
      { ...identity, source: "TOTP" },
      { ...identity, source: undefined },
      { ...identity, username: "alice\0other" },
      { ...identity, domain: "" },
      { ...identity, domain: "Issuer\0Other" },
      { ...identity, domain: "Issuer\nOther" },
      { ...identity, domain: "x".repeat(8193) },
      { ...identity, username: "x".repeat(4097) },
    ]) {
      await Assert.rejects(
        service.getOneTimeCode(ICLOUD_ORIGIN, selection, null),
        error => error.code === "account-mismatch"
      );
    }
    Assert.ok(!client.calls.includes("get-codes"));
    client.codes.push({ ...client.codes[0] });
    Assert.deepEqual(await service.listOneTimeCodes(ICLOUD_ORIGIN), [identity]);
    await Assert.rejects(
      service.getOneTimeCode(ICLOUD_ORIGIN, identity, null),
      error => error.code === "ambiguous-account",
      "Deduplicated display metadata does not erase native selection ambiguity"
    );
    Assert.ok(!client.calls.includes("get-codes"));
    Assert.ok(!client.calls.includes("save-password"));
  }
);

add_task(async function test_otp_context_validation_precedes_authentication() {
  let { service, client } = createProvider("otp-context-validation");
  let identity = { username: "alice", domain: "Issuer", source: "totp" };
  service.setEnabled(true);
  for (let context of [
    null,
    [],
    { frameURLs: [] },
    { frameURLs: Array(33).fill(`${ICLOUD_ORIGIN}/`) },
    ...[
      "https://foreign.invalid/",
      "https://login.example.com:8443/",
      "https://user:synthetic@login.example.com/",
      "https://@login.example.com/",
      "http://login.example.com/",
      `${ICLOUD_ORIGIN}/path\0`,
      `${ICLOUD_ORIGIN}/path\n`,
      "/relative",
    ].map(url => ({ frameURLs: [url] })),
    { tabId: -1 },
    { frameId: "7" },
    { tabId: Number.MAX_SAFE_INTEGER + 1 },
    { frameId: 1.5 },
  ]) {
    for (let operation of [
      () => service.listOneTimeCodes(ICLOUD_ORIGIN, context),
      () => service.getOneTimeCode(ICLOUD_ORIGIN, identity, null, context),
    ]) {
      await Assert.rejects(operation(), error =>
        ["invalid-origin", "native-error"].includes(error.code)
      );
    }
  }
  Assert.deepEqual(
    client.calls,
    [],
    "Invalid frame contexts never authenticate or query"
  );
});

add_task(async function test_otp_snapshots_selector_and_frame_context() {
  let { service, client } = createProvider("otp-context-snapshot");
  let context = { frameURLs: [`${ICLOUD_ORIGIN}/otp`], tabId: 42, frameId: 7 };
  let selection = { username: "alice", domain: "Raw Issuer", source: "totp" };
  let nativeCode = { ...selection, code: "012345" };
  client.otpScopes.set(otpScopeKey(ICLOUD_ORIGIN, context), [nativeCode]);
  service.setEnabled(true);
  await service.unlock(null);
  let requested = Promise.withResolvers();
  let resume = Promise.withResolvers();
  let list = client.listOneTimeCodes.bind(client);
  client.listOneTimeCodes = async (origin, validated) => {
    let result = await list(origin, validated);
    requested.resolve();
    await resume.promise;
    return result;
  };
  let options = { ...context, frameURLs: [...context.frameURLs] };
  let operation = service.getOneTimeCode(
    ICLOUD_ORIGIN,
    selection,
    null,
    options
  );
  await requested.promise;
  options.frameURLs[0] = "https://foreign.invalid/";
  options.tabId = 999;
  selection.username = "other";
  selection.domain = "Other Issuer";
  resume.resolve();
  Assert.deepEqual(await operation, nativeCode);
  Assert.deepEqual(
    client.otpRequests.at(-1).context.frameURLs,
    context.frameURLs
  );
  Assert.equal(client.otpRequests.at(-1).context.tabId, context.tabId);
  Assert.equal(client.otpRequests.at(-1).context.frameId, context.frameId);
  Assert.equal(client.otpRequests.at(-1).context.username, nativeCode.username);
});

add_task(
  async function test_otp_code_response_requires_exact_unique_raw_identity() {
    let { service, client } = createProvider("otp-code-identity");
    let identity = {
      username: "Alice",
      domain: " Raw.Issuer ",
      source: "totp",
    };
    let nativeCode = { ...identity, code: "012345" };
    client.codes = [nativeCode];
    service.setEnabled(true);
    await service.unlock(null);
    for (let [entries, expected] of [
      [[{ ...nativeCode, domain: identity.domain.trim() }], "no-code"],
      [[{ ...nativeCode, domain: identity.domain.toLowerCase() }], "no-code"],
      [[{ ...nativeCode, username: "alice" }], "no-code"],
      [[{ ...nativeCode, source: "sms" }], "no-code"],
      [[{ ...nativeCode, source: "TOTP" }], "no-code"],
      [[nativeCode, { ...nativeCode }], "ambiguous-account"],
      ...[null, 123456, "123", "1234x6"].map(code => [
        [{ ...nativeCode, code }],
        "no-code",
      ]),
      ...[0, NaN, Infinity].map(expiresAt => [
        [{ ...nativeCode, expiresAt }],
        "no-code",
      ]),
    ]) {
      client.getOneTimeCodes = async (_origin, context) => {
        client.calls.push("get-codes");
        Assert.strictEqual(context.username, identity.username);
        return entries;
      };
      await Assert.rejects(
        service.getOneTimeCode(ICLOUD_ORIGIN, identity, null),
        error => error.code === expected
      );
    }
    Assert.ok(!client.calls.includes("save-password"));
  }
);

add_task(async function test_otp_stale_metadata_codes_and_gate_changes() {
  for (let method of ["listOneTimeCodes", "getOneTimeCodes"]) {
    for (let transition of [
      "lock",
      "replace-session",
      "native-lock",
      "otp-disabled",
      "capability-disabled",
    ]) {
      let { service, client, prefs } = createProvider(
        `otp-stale-${method}-${transition}`
      );
      let identity = {
        username: "alice",
        domain: "Raw Issuer",
        source: "totp",
      };
      client.codes = [{ ...identity, code: "012345" }];
      service.setEnabled(true);
      await service.unlock(null);
      let requested = Promise.withResolvers();
      let response = Promise.withResolvers();
      client[method] = async () => {
        client.calls.push(
          method === "listOneTimeCodes" ? "list-codes" : "get-codes"
        );
        requested.resolve();
        return response.promise;
      };
      let rejected = service.getOneTimeCode(ICLOUD_ORIGIN, identity, null).then(
        () => null,
        error => error
      );
      await requested.promise;
      if (transition === "lock" || transition === "replace-session") {
        await service.lock();
        if (transition === "replace-session") {
          await service.unlock(null);
        }
      } else if (transition === "native-lock") {
        client.state = "locked";
      } else if (transition === "otp-disabled") {
        prefs.setBoolPref("waterfox.passwords.icloud.otp.enabled", false);
      } else {
        client.canFillOneTimeCodes = false;
      }
      response.resolve(client.codes.map(entry => ({ ...entry })));
      Assert.equal(
        (await rejected)?.code,
        {
          "native-lock": "locked",
          "otp-disabled": "otp-disabled",
          "capability-disabled": "no-code",
        }[transition] ?? "session-changed"
      );
      Assert.equal(
        client.calls.filter(call => call === "get-codes").length,
        method === "getOneTimeCodes" ? 1 : 0,
        "A stale or disabled metadata result never starts command 17"
      );
      Assert.ok(!client.calls.includes("save-password"));
      if (transition === "replace-session") {
        Assert.ok(
          service.isReady,
          "A stale result does not lock the replacement session"
        );
      }
      await service.destroy();
    }
  }
});

add_task(
  async function test_otp_cancel_and_native_errors_do_not_query_or_save() {
    let identity = { username: "alice", domain: "Raw Issuer", source: "totp" };
    let { service, client } = createProvider("otp-cancel", {
      promptPIN: () => null,
    });
    service.setEnabled(true);
    Assert.strictEqual(
      await service.getOneTimeCode(ICLOUD_ORIGIN, identity, null),
      null
    );
    Assert.ok(
      !client.calls.some(call =>
        ["list-codes", "get-codes", "save-password"].includes(call)
      )
    );
    for (let method of ["listOneTimeCodes", "getOneTimeCodes"]) {
      let fixture = createProvider(`otp-native-cancel-${method}`);
      fixture.client.codes = [{ ...identity, code: "012345" }];
      fixture.service.setEnabled(true);
      await fixture.service.unlock(null);
      let attempts = 0;
      fixture.client[method] = async () => {
        attempts++;
        throw Object.assign(new Error(TEST_CREDENTIAL), { code: "canceled" });
      };
      await Assert.rejects(
        fixture.service.getOneTimeCode(ICLOUD_ORIGIN, identity, null),
        error =>
          error.code === "cancelled" && !error.message.includes(TEST_CREDENTIAL)
      );
      Assert.equal(attempts, 1);
      if (method === "listOneTimeCodes") {
        Assert.ok(!fixture.client.calls.includes("get-codes"));
      }
      Assert.ok(!fixture.client.calls.includes("save-password"));
    }
  }
);

add_task(async function test_otp_rejects_unlock_from_replaced_session() {
  for (let transition of ["replace-session", "native-relock"]) {
    let { service, client } = createProvider(`otp-unlock-${transition}`);
    let identity = { username: "alice", domain: "Raw Issuer", source: "totp" };
    client.codes = [{ ...identity, code: "012345" }];
    service.setEnabled(true);
    let unlock = service.unlock.bind(service);
    await unlock(null);
    let authenticated = Promise.withResolvers();
    let resume = Promise.withResolvers();
    service.unlock = async parent => {
      let result = await unlock(parent);
      authenticated.resolve();
      await resume.promise;
      return result;
    };
    let rejected = service.getOneTimeCode(ICLOUD_ORIGIN, identity, null).then(
      () => null,
      error => error
    );
    await authenticated.promise;
    if (transition === "replace-session") {
      await service.lock();
      await unlock(null);
    } else {
      client.setState("locked");
      client.setState("ready");
    }
    resume.resolve();
    Assert.equal((await rejected)?.code, "session-changed");
    Assert.ok(service.isReady);
    Assert.ok(
      !client.calls.some(call =>
        ["list-codes", "get-codes", "save-password"].includes(call)
      )
    );
  }
});
