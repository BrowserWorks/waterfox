/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { ApplePasswordManager, validateApplePasswordSetupURI } =
  ChromeUtils.importESModule(
    "resource:///modules/ApplePasswordManager.sys.mjs"
  );
const { ApplePasswordError } = ChromeUtils.importESModule(
  "resource:///modules/ApplePasswordCrypto.sys.mjs"
);
const { ICloudPasswordsService, ICloudPasswordsError } =
  ChromeUtils.importESModule("resource:///modules/ICloudPasswords.sys.mjs");
const { FakeAppleHost, FakeCrypto } = ChromeUtils.importESModule(
  "resource://icloud-passwords-test/ApplePasswordTestUtils.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const ORIGIN = "https://setup.example.test:8443";
const OTHER_ORIGIN = "https://other.example.test";
const SECRET = "JBSWY3DPEHPK3PXP";
const SETUP_URI = `otpauth://totp/Synthetic%3Atest%40example.test?secret=${SECRET}&issuer=Synthetic`;
const PARENT = Object.freeze({ id: "synthetic-parent" });
const PREF_BRANCH = "waterfox.passwords.icloud.";
const CREDENTIAL_METHODS = [
  "listAccounts",
  "getPassword",
  "savePassword",
  "listOneTimeCodes",
  "getOneTimeCodes",
];

function setupURI(secret = SECRET, parameters = "") {
  return `otpauth://totp/Synthetic?secret=${encodeURIComponent(secret)}${parameters}`;
}

async function settle(action) {
  try {
    return { value: await action() };
  } catch (error) {
    return { error };
  }
}

function assertRedacted(value) {
  let text = [
    String(value),
    JSON.stringify(value),
    String(value?.message ?? ""),
    String(value?.cause ?? ""),
    JSON.stringify(value?.cause),
  ].join("\n");
  Assert.ok(
    ![
      SECRET,
      SECRET.toLowerCase(),
      SETUP_URI,
      "otpauth://",
      "apple-otpauth://",
    ].some(sensitive => text.includes(sensitive)),
    "Public results and errors contain neither setup URIs nor secret material"
  );
}

function assertSafeError(error, code, provider = false) {
  Assert.ok(
    provider
      ? error instanceof ICloudPasswordsError
      : error instanceof ApplePasswordError,
    "Failures use the sanitized public error class"
  );
  if (code) {
    Assert.strictEqual(
      error.code === code,
      true,
      `The safe error code is ${code}`
    );
  }
  assertRedacted(error);
  if (provider) {
    Assert.ok(
      typeof error.l10nId === "string" &&
        error.l10nId.startsWith("icloud-passwords-error-") &&
        error.message === error.l10nId,
      "The injected localization exposes only the Fluent error ID"
    );
  }
}

async function expectError(action, code, provider = false) {
  let result = await settle(action);
  assertSafeError(result.error, code, provider);
  return result.error;
}

async function expectDispatched(action) {
  let result = await action();
  Assert.ok(
    result?.dispatched === true && Object.keys(result).length === 1,
    "The result reports dispatch only, never enrollment or storage confirmation"
  );
  assertRedacted(result);
}

async function expectBoundary(boundary, pending) {
  let reached = await Promise.race([
    boundary.promise.then(() => true),
    pending.then(() => false),
  ]);
  Assert.ok(reached, "The action reaches the intended synthetic race boundary");
}

function assertBlocked(result) {
  assertSafeError(result.error, null, true);
  Assert.ok(
    [
      "session-changed",
      "locked",
      "disabled",
      "otp-disabled",
      "setup-unavailable",
      "cancelled",
    ].includes(result.error.code),
    "Invalidation rejects instead of dispatching or claiming enrollment"
  );
}

function feedHostMessage(host, message) {
  let bytes = new TextEncoder().encode(JSON.stringify(message));
  let frame = new Uint8Array(4 + bytes.length);
  frame.set(new Uint8Array(Uint32Array.of(bytes.length).buffer));
  frame.set(bytes, 4);
  host.stdout.feed(frame);
}

function managerFixture(options = {}, capabilities = { scanForOTPURI: true }) {
  let host = new FakeAppleHost();
  let reply = host.reply.bind(host);
  host.reply = frame => {
    let message = JSON.parse(
      new TextDecoder().decode(new Uint8Array(frame, 4))
    );
    if (message.cmd === 2) {
      return reply(frame);
    }
    host.requests.push(message);
    if (message.cmd === 14) {
      return Promise.resolve(host.beforeHello?.()).then(() => {
        feedHostMessage(host, {
          cmd: 14,
          capabilities: {
            secretSessionVersion: 1,
            shouldUseBase64: false,
            ...capabilities,
          },
        });
      });
    }
    if (message.cmd === 13) {
      // The shared host expects encrypted payloads; command 13 has no reply.
      return Promise.resolve(host.beforeDispatch?.());
    }
    throw new Error("Unexpected credential command in setup-only fixture");
  };
  let manager = new ApplePasswordManager({
    platform: "macosx",
    discoverHost: async () => ({ command: "/synthetic/never-executed" }),
    transportFactory: async () => host,
    cryptoFactory: async () => new FakeCrypto(),
    requestTimeoutMS: 1000,
    ...options,
  });
  registerCleanupFunction(async () => {
    await manager.lock();
    Assert.ok(
      host.requests.every(message => [2, 13, 14].includes(message.cmd)),
      "Setup never sends command 6 or another credential retrieval/save command"
    );
  });
  return { manager, host };
}

async function pair(manager) {
  await manager.beginPairing();
  await manager.completePairing("123456");
}

function dispatches(host) {
  return host.requests.filter(message => message.cmd === 13);
}

function managerAction(manager, action, options) {
  if (action === "setup") {
    return manager.setUpOneTimeCode(ORIGIN, SETUP_URI, options);
  }
  return manager.openPasswordsApp(ORIGIN, options);
}

function providerAction(service, action, options) {
  if (action === "setup") {
    return service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT, options);
  }
  return service.openManager(ORIGIN, options);
}

function memoryPrefs() {
  let values = new Map([
    [`${PREF_BRANCH}enabled`, true],
    [`${PREF_BRANCH}otp.enabled`, true],
    [`${PREF_BRANCH}idleTimeout`, 300],
  ]);
  let observers = new Map();
  return {
    getBoolPref: (name, fallback) => values.get(name) ?? fallback,
    getIntPref: (name, fallback) => values.get(name) ?? fallback,
    prefIsLocked: () => false,
    setBoolPref(name, value) {
      values.set(name, value);
      for (let [observer, prefix] of observers) {
        if (name.startsWith(prefix)) {
          observer.observe(null, "nsPref:changed", name);
        }
      }
    },
    addObserver(prefix, observer) {
      observers.set(observer, prefix);
    },
    removeObserver(_prefix, observer) {
      observers.delete(observer);
    },
  };
}

function providerFixture(options = {}) {
  let prefs = memoryPrefs();
  let notifications = [];
  let calls = [];
  let launches = [];
  let prompts = [];
  let client = options.client ?? {
    supported: true,
    state: "disconnected",
    helloCapability: true,
    canSetUpOneTimeCodes: false,
    canFillOneTimeCodes: false,
    dispatches: [],
    guardChecks: [],
    dispatchChecks: [],
    get isReady() {
      return this.state === "ready";
    },
    setState(state, error) {
      this.state = state;
      this.onStateChange?.(state, { error });
    },
    getStatus() {
      return { supported: true, available: true, state: this.state };
    },
    async connect() {
      calls.push("connect");
      await this.beforeConnect?.();
      this.canSetUpOneTimeCodes = this.helloCapability ?? false;
      if (!this.isReady) {
        this.setState("locked");
      }
    },
    async beginPairing() {
      calls.push("begin-pairing");
      this.setState("pairing");
    },
    async completePairing(pin) {
      calls.push("complete-pairing");
      Assert.strictEqual(
        pin === "123456",
        true,
        "Only the synthetic PIN is used"
      );
      this.setState("ready");
    },
    async lock() {
      calls.push("lock");
      this.canSetUpOneTimeCodes = false;
      this.setState("locked");
    },
    async guardedDispatch(
      kind,
      origin,
      uri,
      { isCurrent, beforeDispatch } = {}
    ) {
      calls.push(kind);
      await this.beforeDispatch?.();
      Assert.equal(
        typeof isCurrent,
        "function",
        "The provider supplies a queue-time guard"
      );
      Assert.equal(
        typeof beforeDispatch,
        "function",
        "The provider forwards an async dispatch guard"
      );
      let current;
      try {
        current = isCurrent();
      } catch (error) {
        this.guardChecks.push(false);
        throw error;
      }
      this.guardChecks.push(current);
      if (current !== true) {
        throw new ApplePasswordError("setup-unavailable");
      }
      calls.push("before-dispatch");
      let targetIsCurrent = await beforeDispatch();
      this.dispatchChecks.push(targetIsCurrent);
      if (targetIsCurrent !== true || isCurrent() !== true) {
        throw new ApplePasswordError("invalid-session");
      }
      this.dispatches.push({ kind, origin, uri });
      return { dispatched: true };
    },
    async setUpOneTimeCode(origin, uri, context) {
      Assert.ok(this.isReady, "Setup requires an unlocked synthetic session");
      return this.guardedDispatch("setup", origin, uri, context);
    },
    async openPasswordsApp(origin, context) {
      if (this.state === "disconnected") {
        await this.connect();
      }
      return this.guardedDispatch("open", origin, undefined, context);
    },
  };
  if (!options.client) {
    for (let method of CREDENTIAL_METHODS) {
      client[method] = async () => {
        calls.push(method);
        throw new Error("Setup must not access credentials");
      };
    }
  }
  let service = new ICloudPasswordsService({
    platform: options.platform ?? "macosx",
    platformVersion: "23.0.0",
    prefs,
    observers: {
      addObserver() {},
      removeObserver() {},
      notifyObservers(subject, topic, data) {
        notifications.push({ subject, topic, data });
      },
    },
    clientFactory({ onStateChange }) {
      calls.push("create");
      client.onStateChange = onStateChange;
      return client;
    },
    promptPIN(parent, context) {
      calls.push("pin");
      prompts.push({ parent, signal: context.signal });
      Assert.strictEqual(
        client.canSetUpOneTimeCodes === true,
        true,
        "Capability probing precedes PIN UI"
      );
      return options.promptPIN ? options.promptPIN(parent, context) : "123456";
    },
    localization: {
      async formatValues(messages) {
        return messages.map(message => message.id);
      },
      async formatValue(id) {
        return id;
      },
    },
    timerFactory: () => ({ cancel() {} }),
    now: () => 0,
    openManager(platform) {
      launches.push(platform);
      return options.openManager?.(platform);
    },
  });
  registerCleanupFunction(async () => {
    await service.destroy();
    Assert.ok(
      !calls.some(call => CREDENTIAL_METHODS.includes(call)),
      "Setup and contextual opening never list, retrieve, save, or verify credentials"
    );
    assertRedacted(notifications);
  });
  return { service, client, prefs, calls, launches, prompts, notifications };
}

add_task(async function test_setup_uri_preserves_valid_input() {
  let values = [
    SETUP_URI,
    SETUP_URI.replace("otpauth:", "apple-otpauth:"),
    setupURI(SECRET.toLowerCase()),
    setupURI(SECRET, "&algorithm=SHA256&digits=8&period=3600"),
    `otpauth://totp/%E2%98%83%20Synthetic?issuer=Synthetic&secret=${SECRET}`,
  ];
  for (let algorithm of ["SHA1", "sha256", "sHa512"]) {
    values.push(setupURI(SECRET, `&algorithm=${algorithm}`));
  }
  for (let digits of [6, 8]) {
    values.push(setupURI(SECRET, `&digits=${digits}`));
  }
  for (let period of [1, 30, 3600]) {
    values.push(setupURI(SECRET, `&period=${period}`));
  }
  for (let uri of values) {
    let result = await settle(() => validateApplePasswordSetupURI(uri));
    Assert.ok(!result.error, "A supported synthetic setup URI validates");
    Assert.strictEqual(
      result.value === uri,
      true,
      "Validation preserves the original URI byte for byte"
    );
  }
});

add_task(async function test_setup_uri_base32_canonical_encoding() {
  for (let length of [16, 18, 20, 21, 23, 24, 128]) {
    let secret = "A".repeat(length);
    let padding = "=".repeat((8 - (length % 8)) % 8);
    for (let value of new Set([secret, secret + padding])) {
      let uri = setupURI(value);
      let result = await settle(() => validateApplePasswordSetupURI(uri));
      Assert.ok(
        !result.error && result.value === uri,
        "Canonical Base32 is accepted with or without correct padding"
      );
    }
  }
  let invalid = [
    "A".repeat(15),
    "A".repeat(129),
    ...[17, 19, 22].map(length => "A".repeat(length)),
    ...[18, 20, 21, 23].map(length => "A".repeat(length - 1) + "B"),
    "A".repeat(16) + "=",
    "A".repeat(18) + "=====",
    "A".repeat(18) + "=======",
    "A".repeat(8) + "=" + "A".repeat(8),
    "A".repeat(15) + "0",
    "A".repeat(15) + "1",
    "A".repeat(15) + "8",
    "A".repeat(15) + "9",
    "A".repeat(15) + "-",
    "A".repeat(15) + "_",
    SECRET + " ",
    SECRET + "\u0000",
  ];
  for (let secret of invalid) {
    let error = await expectError(
      () => validateApplePasswordSetupURI(setupURI(secret)),
      "invalid-argument"
    );
    Assert.ok(
      !error.message.includes(secret),
      "Invalid Base32 is not reflected in the error"
    );
  }
});

add_task(async function test_setup_uri_malformed_structure_and_parameters() {
  let invalid = [
    undefined,
    null,
    false,
    42,
    {},
    "",
    SETUP_URI.replace("otpauth:", "https:"),
    SETUP_URI.replace("//totp/", "//hotp/"),
    SETUP_URI.replace("//totp/", "//unknown/"),
    SETUP_URI.replace("//totp/", "//user:synthetic@totp/"),
    SETUP_URI.replace("//totp/", "//totp:443/"),
    SETUP_URI + "#fragment",
    SETUP_URI + "#",
    `otpauth://totp/?secret=${SECRET}`,
    `otpauth://totp/%?secret=${SECRET}`,
    `otpauth://totp/%GG?secret=${SECRET}`,
    `otpauth://totp/%C3%28?secret=${SECRET}`,
    "otpauth://totp/Synthetic",
    "otpauth://totp/Synthetic?secret=",
    setupURI(SECRET, `&secret=${SECRET}`),
    setupURI(SECRET, `&secre%74=${SECRET}`),
    setupURI(SECRET, "&secret=invalid"),
    `otpauth://totp/Synthetic?secret=invalid&secret=${SECRET}`,
    `otpauth://totp/Synthetic?SECRET=${SECRET}`,
    setupURI(SECRET, "&counter=1"),
    setupURI(SECRET, "&image=https%3A%2F%2Fexample.test%2Fimage"),
    setupURI(SECRET, "&unknown=value"),
    setupURI(SECRET, "&issuer=One&issuer=Two"),
    setupURI(SECRET, "&algorithm=SHA1&algorithm=SHA1"),
    setupURI(SECRET, "&digits=6&digits=8"),
    setupURI(SECRET, "&period=30&period=30"),
  ];
  for (let [name, values] of [
    ["algorithm", ["", "MD5", "SHA-1", "SHA384"]],
    ["digits", ["", "0", "7", "06", "6.0", "6e0", "+6"]],
    ["period", ["", "0", "-1", "3601", "1.5", "1e2", "+1", "Infinity", "0x20"]],
  ]) {
    for (let value of values) {
      invalid.push(setupURI(SECRET, `&${name}=${encodeURIComponent(value)}`));
    }
  }
  for (let character of [
    " ",
    "\t",
    "\r",
    "\n",
    "\u0000",
    "\u007f",
    "\u0085",
    "\u00a0",
    "\u2003",
    "\\",
  ]) {
    invalid.push(character + SETUP_URI, SETUP_URI + character);
    invalid.push(SETUP_URI.replace("Synthetic", `Syn${character}thetic`));
  }
  for (let [index, uri] of invalid.entries()) {
    let result = await settle(() => validateApplePasswordSetupURI(uri));
    Assert.ok(
      !!result.error,
      `Malformed setup input index ${index} is rejected`
    );
    assertSafeError(result.error, "invalid-argument");
  }
});

add_task(async function test_setup_capability_lifetime_and_malformed_hello() {
  for (let value of [undefined, false, true]) {
    let capabilities = value === undefined ? {} : { scanForOTPURI: value };
    let { manager, host } = managerFixture({}, capabilities);
    Assert.strictEqual(manager.canSetUpOneTimeCodes, false);
    await manager.connect();
    Assert.strictEqual(manager.canSetUpOneTimeCodes, value ?? false);
    Assert.ok(!manager.isReady, "Probing setup support does not authenticate");
    await manager.lock();
    Assert.strictEqual(manager.canSetUpOneTimeCodes, false);
    Assert.ok(host.closed);
  }
  for (let value of [null, 1, "true", {}]) {
    let { manager, host } = managerFixture({}, { scanForOTPURI: value });
    await expectError(() => manager.connect(), "unsupported-protocol");
    Assert.strictEqual(manager.canSetUpOneTimeCodes, false);
    Assert.ok(
      host.closed,
      "Malformed hello tears down the synthetic transport"
    );
  }
  let { manager, host } = managerFixture();
  await manager.connect();
  feedHostMessage(host, { cmd: 0 });
  await TestUtils.waitForCondition(
    () => manager.state === "disconnected",
    "Synthetic disconnect is observed"
  );
  Assert.strictEqual(manager.canSetUpOneTimeCodes, false);
});

add_task(async function test_native_contextual_open_without_pairing_or_ack() {
  let { manager, host } = managerFixture({}, {});
  await expectDispatched(() => manager.openPasswordsApp(ORIGIN));
  await expectDispatched(() => manager.openPasswordsApp(OTHER_ORIGIN));
  Assert.deepEqual(
    host.requests.map(message => message.cmd),
    [14, 13, 13]
  );
  Assert.ok(
    !manager.isReady,
    "Contextual opening never creates a paired session"
  );
  let messages = dispatches(host);
  Assert.ok(
    messages[0].searchQueryURL === ORIGIN &&
      messages[1].searchQueryURL === OTHER_ORIGIN,
    "Contextual search sends the exact HTTPS origins"
  );
  Assert.ok(
    messages.every(
      message => Object.keys(message).sort().join() === "cmd,searchQueryURL"
    ),
    "Contextual opening contains no enrollment or password payload"
  );
});

add_task(
  async function test_native_setup_dispatch_is_not_storage_confirmation() {
    let { manager, host } = managerFixture();
    await pair(manager);
    Assert.strictEqual(
      manager.canFillOneTimeCodes,
      false,
      "Setup support is independent of OTP retrieval support"
    );
    for (let uri of [
      SETUP_URI,
      SETUP_URI.replace("otpauth:", "apple-otpauth:"),
    ]) {
      await expectDispatched(() => manager.setUpOneTimeCode(ORIGIN, uri));
      let message = dispatches(host).at(-1);
      Assert.strictEqual(
        message.setUpTOTPPageURL === new URL(ORIGIN).hostname,
        true,
        "Setup sends the hostname, not an origin, port, or page URL"
      );
      Assert.strictEqual(
        message.setUpTOTPURI === uri,
        true,
        "The native setup URI is not normalized or rewritten"
      );
      Assert.strictEqual(
        Object.keys(message).sort().join() ===
          "cmd,setUpTOTPPageURL,setUpTOTPURI",
        true,
        "Setup sends only command 13 and the two setup fields"
      );
    }
    Assert.deepEqual(
      host.requests.map(message => message.cmd),
      [14, 2, 2, 13, 13]
    );
  }
);

add_task(async function test_native_app_dispatch_transfers_buffer_ownership() {
  for (const action of ["manager", "setup"]) {
    const { manager, host } = managerFixture();
    const write = host.stdin.write;
    let transfers = 0;
    host.stdin.write = buffer => {
      const owned = buffer.transfer();
      Assert.equal(buffer.byteLength, 0, "The transport detaches its input");
      transfers++;
      return write(owned);
    };
    if (action === "setup") {
      await pair(manager);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await expectDispatched(() => managerAction(manager, action));
      Assert.equal(dispatches(host).length, attempt + 1);
      Assert.ok(!host.closed, "Successful writes retain the transport");
    }
    Assert.equal(transfers, action === "setup" ? 5 : 3);
    Assert.equal(manager.isReady, action === "setup");
  }
});

add_task(async function test_native_setup_requires_ready_and_capability() {
  let { manager, host } = managerFixture();
  await expectError(
    () => manager.setUpOneTimeCode(ORIGIN, SETUP_URI),
    "locked"
  );
  Assert.equal(
    host.requests.length,
    0,
    "Setup itself never connects or initiates pairing"
  );
  await manager.connect();
  await expectError(
    () => manager.setUpOneTimeCode(ORIGIN, SETUP_URI),
    "locked"
  );
  Assert.deepEqual(
    host.requests.map(message => message.cmd),
    [14]
  );
  for (let capabilities of [{}, { scanForOTPURI: false }]) {
    let fixture = managerFixture({}, capabilities);
    await pair(fixture.manager);
    await expectError(
      () => fixture.manager.setUpOneTimeCode(ORIGIN, SETUP_URI),
      "setup-unavailable"
    );
    Assert.equal(dispatches(fixture.host).length, 0);
  }
});

function invalidOrigins() {
  return [
    null,
    42,
    "",
    "http://setup.example.test",
    "file:///synthetic",
    `${ORIGIN}/path`,
    `${ORIGIN}?query=synthetic`,
    `${ORIGIN}#fragment`,
    "https://user:synthetic@setup.example.test",
    ` ${ORIGIN}`,
    `${ORIGIN}\n`,
    "https://setup.example.test\\path",
  ];
}

add_task(
  async function test_native_context_validation_is_local_and_sanitized() {
    let { manager, host } = managerFixture();
    await pair(manager);
    let before = host.requests.length;
    for (let origin of invalidOrigins()) {
      await expectError(
        () => manager.openPasswordsApp(origin),
        "invalid-origin"
      );
      await expectError(
        () => manager.setUpOneTimeCode(origin, SETUP_URI),
        "invalid-origin"
      );
    }
    await expectError(
      () => manager.setUpOneTimeCode(ORIGIN, SETUP_URI + "&secret=invalid"),
      "invalid-argument"
    );
    Assert.equal(
      host.requests.length,
      before,
      "Invalid arguments never reach the native transport"
    );
  }
);

add_task(async function test_native_context_guard_is_rechecked_after_connect() {
  let { manager, host } = managerFixture();
  let entered = Promise.withResolvers();
  let resume = Promise.withResolvers();
  let current = true;
  host.beforeHello = () => {
    entered.resolve();
    return resume.promise;
  };
  let result = settle(() =>
    manager.openPasswordsApp(ORIGIN, { isCurrent: () => current })
  );
  await expectBoundary(entered, result);
  current = false;
  resume.resolve();
  assertSafeError((await result).error, "invalid-session");
  Assert.deepEqual(
    host.requests.map(message => message.cmd),
    [14]
  );
});

add_task(async function test_native_initially_stale_guards_do_not_write() {
  for (let action of ["openPasswordsApp", "setUpOneTimeCode"]) {
    let { manager, host } = managerFixture();
    await pair(manager);
    let argumentsForAction =
      action === "setUpOneTimeCode" ? [ORIGIN, SETUP_URI] : [ORIGIN];
    await expectError(
      () => manager[action](...argumentsForAction, { isCurrent: () => false }),
      "invalid-session"
    );
    Assert.equal(
      dispatches(host).length,
      0,
      "Initially stale actions never write command 13"
    );
  }
});

add_task(async function test_native_guard_at_the_serial_write_boundary() {
  for (let action of ["openPasswordsApp", "setUpOneTimeCode"]) {
    let { manager, host } = managerFixture();
    await pair(manager);
    let current = true;
    let argumentsForAction =
      action === "setUpOneTimeCode" ? [ORIGIN, SETUP_URI] : [ORIGIN];
    let entered = Promise.withResolvers();
    let resume = Promise.withResolvers();
    host.beforeDispatch = () => {
      entered.resolve();
      return resume.promise;
    };
    let first = settle(() => manager.openPasswordsApp(OTHER_ORIGIN));
    await expectBoundary(entered, first);
    let queued = settle(() =>
      manager[action](...argumentsForAction, { isCurrent: () => current })
    );
    Assert.equal(
      dispatches(host).length,
      1,
      "The second write waits in the serial queue"
    );
    current = false;
    host.beforeDispatch = null;
    resume.resolve();
    await expectDispatched(async () => (await first).value);
    assertSafeError((await queued).error, "invalid-session");
    Assert.equal(
      dispatches(host).length,
      1,
      "A queued stale action is not dispatched"
    );
  }
});

add_task(async function test_native_dispatch_queue_is_bounded_and_times_out() {
  let { manager, host } = managerFixture({
    maxQueue: 2,
    requestTimeoutMS: 100,
  });
  await pair(manager);
  let entered = Promise.withResolvers();
  let resume = Promise.withResolvers();
  host.beforeDispatch = () => {
    entered.resolve();
    return resume.promise;
  };
  let first = settle(() => manager.openPasswordsApp(ORIGIN));
  await expectBoundary(entered, first);
  let second = settle(() => manager.setUpOneTimeCode(ORIGIN, SETUP_URI));
  await expectError(() => manager.openPasswordsApp(OTHER_ORIGIN), "queue-full");
  assertSafeError((await first).error, "timeout");
  assertSafeError((await second).error, "timeout");
  resume.resolve();
  Assert.ok(
    host.closed,
    "A stuck write closes the transport within the configured timeout"
  );
  Assert.strictEqual(manager.canSetUpOneTimeCodes, false);
  Assert.equal(
    dispatches(host).length,
    1,
    "Timeout never releases queued enrollment onto the pipe"
  );
});

add_task(async function test_native_lock_invalidates_queued_enrollment() {
  let { manager, host } = managerFixture();
  await pair(manager);
  let entered = Promise.withResolvers();
  let resume = Promise.withResolvers();
  host.beforeDispatch = () => {
    entered.resolve();
    return resume.promise;
  };
  let first = settle(() => manager.openPasswordsApp(ORIGIN));
  await expectBoundary(entered, first);
  let second = settle(() => manager.setUpOneTimeCode(ORIGIN, SETUP_URI));
  await manager.lock();
  resume.resolve();
  assertSafeError((await first).error, "locked");
  assertSafeError((await second).error, "locked");
  Assert.equal(dispatches(host).length, 1);
  Assert.strictEqual(manager.canSetUpOneTimeCodes, false);
});

add_task(async function test_native_write_failure_redaction_and_no_retry() {
  let { manager, host } = managerFixture();
  const write = host.stdin.write;
  host.stdin.write = buffer => write(buffer.transfer());
  await pair(manager);
  host.beforeDispatch = () => {
    throw new Error(`${SETUP_URI} ${SECRET}`);
  };
  let result = await settle(() => manager.setUpOneTimeCode(ORIGIN, SETUP_URI));
  assertSafeError(result.error);
  Assert.equal(
    dispatches(host).length,
    1,
    "A failed dispatch is never retried"
  );
  Assert.ok(host.closed, "A failed transferred write closes the transport");
  Assert.ok(!manager.isReady);
});

add_task(async function test_provider_setup_error_ids_and_local_validation() {
  for (let code of ["setup-invalid", "setup-unavailable"]) {
    let error = new ICloudPasswordsError(code);
    assertSafeError(error, code, true);
    Assert.strictEqual(
      error.l10nId === `icloud-passwords-error-${code}`,
      true,
      "Setup errors have dedicated Fluent IDs"
    );
  }
  let { service, calls, launches } = providerFixture();
  for (let origin of invalidOrigins()) {
    await expectError(
      () => service.setUpOneTimeCode(origin, SETUP_URI, PARENT),
      "invalid-origin",
      true
    );
    await expectError(
      () => service.openManager(origin),
      "invalid-origin",
      true
    );
  }
  for (let uri of [
    null,
    "",
    SETUP_URI + "&secret=invalid",
    SETUP_URI.replace("//totp/", "//hotp/"),
  ]) {
    await expectError(
      () => service.setUpOneTimeCode(ORIGIN, uri, PARENT),
      "setup-invalid",
      true
    );
  }
  Assert.deepEqual(
    calls,
    [],
    "Local validation neither constructs a client nor prompts for a PIN"
  );
  Assert.deepEqual(
    launches,
    [],
    "Invalid contextual requests never use the generic app launcher"
  );
});

add_task(async function test_provider_setup_requires_enabled_and_otp_prefs() {
  for (let [setting, expected] of [
    ["enabled", "disabled"],
    ["otp.enabled", "otp-disabled"],
  ]) {
    let { service, prefs, calls } = providerFixture();
    prefs.setBoolPref(PREF_BRANCH + setting, false);
    await expectError(
      () => service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT),
      expected,
      true
    );
    Assert.deepEqual(
      calls,
      [],
      "Disabled setup never constructs or authenticates a client"
    );
  }
  let { service, calls } = providerFixture({ platform: "linux" });
  await expectError(
    () => service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT),
    "unsupported",
    true
  );
  Assert.deepEqual(calls, []);
});

add_task(async function test_provider_probes_support_before_pairing_or_pin() {
  for (let capability of [undefined, false]) {
    let { service, client, calls, prompts } = providerFixture();
    client.helloCapability = capability;
    await service.getStatus();
    Assert.ok(
      !calls.includes("connect") && !calls.includes("pin"),
      "Passive status does not prompt or probe a native connection"
    );
    await expectError(
      () => service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT),
      "setup-unavailable",
      true
    );
    Assert.ok(
      calls.includes("connect"),
      "Missing setup support is established by connecting first"
    );
    Assert.ok(
      !calls.includes("begin-pairing") && !calls.includes("complete-pairing")
    );
    Assert.equal(prompts.length, 0, "Unsupported setup never asks for a PIN");
    Assert.equal(client.dispatches.length, 0);
  }
});

add_task(async function test_provider_explicit_setup_unlocks_and_dispatches() {
  let { service, client, calls, prompts, notifications } = providerFixture();
  Assert.strictEqual(client.canSetUpOneTimeCodes, false);
  await expectDispatched(() =>
    service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT)
  );
  Assert.ok(
    calls.indexOf("connect") < calls.indexOf("begin-pairing") &&
      calls.indexOf("begin-pairing") < calls.indexOf("pin") &&
      calls.indexOf("pin") < calls.indexOf("complete-pairing") &&
      calls.indexOf("complete-pairing") < calls.indexOf("setup"),
    "Capability probing precedes pairing, PIN UI, and dispatch"
  );
  Assert.equal(prompts.length, 1);
  Assert.strictEqual(
    prompts[0].parent === PARENT,
    true,
    "Only the explicit action's synthetic parent owns the PIN prompt"
  );
  Assert.ok(
    client.dispatches[0].origin === ORIGIN &&
      client.dispatches[0].uri === SETUP_URI,
    "The provider preserves the validated context and original setup URI"
  );
  await expectDispatched(() =>
    service.setUpOneTimeCode(OTHER_ORIGIN, SETUP_URI, PARENT)
  );
  Assert.equal(
    prompts.length,
    1,
    "An already-ready session does not prompt again"
  );
  Assert.equal(client.dispatches.length, 2);
  assertRedacted(await service.getStatus());
  assertRedacted(notifications);
});

add_task(async function test_provider_cancelled_pin_never_dispatches() {
  let { service, client, prompts } = providerFixture({ promptPIN: () => null });
  let result = await settle(() =>
    service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT)
  );
  if (result.error) {
    assertSafeError(result.error, "cancelled", true);
  } else {
    Assert.ok(
      result.value === false || result.value === null,
      "Cancellation is not dispatch or enrollment success"
    );
  }
  Assert.equal(prompts.length, 1);
  Assert.equal(client.dispatches.length, 0);
});

async function invalidate(fixture, transition, setCurrent) {
  let { service, client, prefs } = fixture;
  switch (transition) {
    case "stale":
      setCurrent(false);
      break;
    case "disable":
      service.setEnabled(false);
      break;
    case "otp-disabled":
      prefs.setBoolPref(`${PREF_BRANCH}otp.enabled`, false);
      break;
    case "capability-lost":
      client.canSetUpOneTimeCodes = false;
      break;
    case "lock":
      await service.lock();
      break;
    case "destroy":
      await service.destroy();
      break;
    case "replace-session":
      await service.lock();
      await service.unlock(PARENT);
      break;
    case "native-relock":
      client.setState("locked");
      client.setState("ready");
      break;
  }
}

add_task(async function test_provider_invalidates_capability_probe() {
  for (let transition of [
    "stale",
    "disable",
    "otp-disabled",
    "lock",
    "destroy",
  ]) {
    let fixture = providerFixture();
    let entered = Promise.withResolvers();
    let resume = Promise.withResolvers();
    let current = true;
    fixture.client.beforeConnect = () => {
      entered.resolve();
      return resume.promise;
    };
    let pending = settle(() =>
      fixture.service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT, {
        isCurrent: () => current,
      })
    );
    await expectBoundary(entered, pending);
    await invalidate(fixture, transition, value => {
      current = value;
    });
    resume.resolve();
    assertBlocked(await pending);
    Assert.equal(
      fixture.prompts.length,
      0,
      "An invalidated capability probe never proceeds to PIN UI"
    );
    Assert.equal(fixture.client.dispatches.length, 0);
  }
});

add_task(async function test_provider_invalidates_setup_while_pin_is_pending() {
  for (let transition of [
    "stale",
    "disable",
    "otp-disabled",
    "lock",
    "destroy",
  ]) {
    let entered = Promise.withResolvers();
    let resume = Promise.withResolvers();
    let fixture = providerFixture({
      promptPIN() {
        entered.resolve();
        return resume.promise;
      },
    });
    let current = true;
    let pending = settle(() =>
      fixture.service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT, {
        isCurrent: () => current,
      })
    );
    await expectBoundary(entered, pending);
    await invalidate(fixture, transition, value => {
      current = value;
    });
    resume.resolve("123456");
    assertBlocked(await pending);
    Assert.equal(
      fixture.prompts.length,
      1,
      "Invalidation never silently retries authentication"
    );
    Assert.equal(
      fixture.client.dispatches.length,
      0,
      "A PIN from a stale action cannot dispatch setup"
    );
  }
});

add_task(async function test_provider_rejects_replaced_unlock_generation() {
  for (let transition of ["replace-session", "native-relock"]) {
    let fixture = providerFixture();
    let { service, client } = fixture;
    let unlock = service.unlock.bind(service);
    let entered = Promise.withResolvers();
    let resume = Promise.withResolvers();
    service.unlock = async parent => {
      let result = await unlock(parent);
      entered.resolve();
      await resume.promise;
      return result;
    };
    let pending = settle(() =>
      service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT)
    );
    await expectBoundary(entered, pending);
    if (transition === "replace-session") {
      await service.lock();
      await unlock(PARENT);
    } else {
      await invalidate(fixture, transition);
    }
    resume.resolve();
    assertBlocked(await pending);
    Assert.equal(
      client.dispatches.length,
      0,
      "A matching but stale unlock cannot start setup in a new session"
    );
    Assert.ok(
      service.isReady,
      "Rejecting the stale action preserves the replacement session"
    );
  }
});

add_task(async function test_provider_composes_queue_guard() {
  for (let transition of [
    "stale",
    "disable",
    "otp-disabled",
    "capability-lost",
    "lock",
    "replace-session",
    "native-relock",
    "destroy",
  ]) {
    let fixture = providerFixture();
    let { service, client } = fixture;
    await service.unlock(PARENT);
    let entered = Promise.withResolvers();
    let resume = Promise.withResolvers();
    let current = true;
    client.beforeDispatch = () => {
      entered.resolve();
      return resume.promise;
    };
    let pending = settle(() =>
      service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT, {
        isCurrent: () => current,
      })
    );
    await expectBoundary(entered, pending);
    await invalidate(fixture, transition, value => {
      current = value;
    });
    resume.resolve();
    assertBlocked(await pending);
    Assert.strictEqual(
      client.guardChecks.at(-1) === false,
      true,
      "The manager's final queue-time guard observes provider invalidation"
    );
    Assert.equal(
      client.dispatches.length,
      0,
      "No stale setup reaches the native write boundary"
    );
  }
});

add_task(async function test_provider_guard_reaches_the_real_manager_queue() {
  for (let transition of ["stale", "otp-disabled"]) {
    let { manager, host } = managerFixture();
    let fixture = providerFixture({ client: manager });
    let { service } = fixture;
    await service.unlock(PARENT);
    let entered = Promise.withResolvers();
    let resume = Promise.withResolvers();
    let reachedSetup = Promise.withResolvers();
    let enqueue = Promise.withResolvers();
    let queued = Promise.withResolvers();
    host.beforeDispatch = () => {
      entered.resolve();
      return resume.promise;
    };
    let setup = manager.setUpOneTimeCode.bind(manager);
    manager.setUpOneTimeCode = async (...args) => {
      reachedSetup.resolve();
      await enqueue.promise;
      let result = setup(...args);
      queued.resolve();
      return result;
    };
    let current = true;
    let pending = settle(() =>
      service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT, {
        isCurrent: () => current,
      })
    );
    await expectBoundary(reachedSetup, pending);
    let first = settle(() => manager.openPasswordsApp(OTHER_ORIGIN));
    await expectBoundary(entered, first);
    enqueue.resolve();
    await expectBoundary(queued, pending);
    await invalidate(fixture, transition, value => {
      current = value;
    });
    host.beforeDispatch = null;
    resume.resolve();
    await expectDispatched(async () => (await first).value);
    assertBlocked(await pending);
    Assert.equal(
      dispatches(host).length,
      1,
      "The real native queue never writes the invalidated setup URI"
    );
  }
});

add_task(async function test_provider_native_error_redaction_and_no_retry() {
  for (let [method, nativeCode, expected] of [
    ["connect", "unsupported-protocol", "unavailable"],
    ["beginPairing", "native-error", "native-error"],
    ["completePairing", "native-error", "native-error"],
    ["setUpOneTimeCode", "setup-unavailable", "setup-unavailable"],
    ["setUpOneTimeCode", "invalid-argument", "setup-invalid"],
  ]) {
    let { service, client, launches } = providerFixture();
    let attempts = 0;
    client[method] = async () => {
      attempts++;
      throw Object.assign(new Error(`${SETUP_URI} ${SECRET}`), {
        code: nativeCode,
        cause: new Error(SETUP_URI),
      });
    };
    await expectError(
      () => service.setUpOneTimeCode(ORIGIN, SETUP_URI, PARENT),
      expected,
      true
    );
    Assert.equal(attempts, 1, "Setup failures are not automatically retried");
    Assert.equal(client.dispatches.length, 0);
    Assert.deepEqual(launches, []);
    assertRedacted(await service.getStatus());
  }
});

add_task(async function test_provider_generic_and_contextual_open() {
  let { service, client, calls, launches, prefs, prompts } = providerFixture();
  service.setEnabled(false);
  await service.openManager();
  Assert.deepEqual(
    launches,
    ["macosx"],
    "The old generic launcher remains available without enabling the provider"
  );
  Assert.deepEqual(
    calls,
    [],
    "Generic launching does not construct a native client"
  );
  service.setEnabled(true);
  prefs.setBoolPref(`${PREF_BRANCH}otp.enabled`, false);
  client.helloCapability = false;
  await expectDispatched(() => service.openManager(ORIGIN));
  Assert.equal(
    launches.length,
    1,
    "Contextual opening does not use the generic launcher"
  );
  Assert.equal(prompts.length, 0, "Contextual opening never asks for pairing");
  Assert.ok(
    !calls.includes("begin-pairing") && !calls.includes("complete-pairing")
  );
  Assert.ok(
    client.dispatches.length === 1 &&
      client.dispatches[0].kind === "open" &&
      client.dispatches[0].origin === ORIGIN,
    "Contextual opening preserves its exact HTTPS origin even when OTP setup is unavailable"
  );
});

add_task(async function test_provider_contextual_open_never_falls_back() {
  for (let boundary of ["beforeConnect", "beforeDispatch"]) {
    for (let transition of ["stale", "disable", "lock", "destroy"]) {
      let fixture = providerFixture();
      let { service, client, launches, prompts } = fixture;
      let entered = Promise.withResolvers();
      let resume = Promise.withResolvers();
      let current = true;
      client[boundary] = () => {
        entered.resolve();
        return resume.promise;
      };
      let pending = settle(() =>
        service.openManager(ORIGIN, { isCurrent: () => current })
      );
      await expectBoundary(entered, pending);
      await invalidate(fixture, transition, value => {
        current = value;
      });
      resume.resolve();
      assertBlocked(await pending);
      Assert.equal(client.dispatches.length, 0);
      Assert.equal(prompts.length, 0);
      Assert.deepEqual(
        launches,
        [],
        "A stale contextual request never falls back to a generic app launch"
      );
    }
  }
  let { service, client, calls, launches } = providerFixture();
  service.setEnabled(false);
  await expectError(() => service.openManager(ORIGIN), "disabled", true);
  Assert.deepEqual(calls, []);
  service.setEnabled(true);
  client.openPasswordsApp = async () => {
    throw Object.assign(new Error(`${SETUP_URI} ${SECRET}`), {
      code: "setup-unavailable",
    });
  };
  await expectError(
    () => service.openManager(ORIGIN),
    "setup-unavailable",
    true
  );
  Assert.deepEqual(
    launches,
    [],
    "Contextual native failure is never replaced by a generic launch"
  );
});

add_task(async function test_native_before_dispatch_follows_the_queue() {
  for (let action of ["setup", "open"]) {
    info(`Native dispatch guard queue ordering: ${action}`);
    let { manager, host } = managerFixture();
    if (action === "setup") {
      await pair(manager);
    }
    let entered = Promise.withResolvers();
    let resume = Promise.withResolvers();
    host.beforeDispatch = () => {
      entered.resolve();
      return resume.promise;
    };
    let first = settle(() => manager.openPasswordsApp(OTHER_ORIGIN));
    await expectBoundary(entered, first);
    let checks = 0;
    let pending = settle(() =>
      managerAction(manager, action, {
        beforeDispatch: async () => {
          checks++;
          Assert.equal(
            dispatches(host).length,
            1,
            "The hook precedes the target write"
          );
          if (action === "setup") {
            Assert.ok(
              manager.isReady && manager.canSetUpOneTimeCodes,
              "Pairing and capability checks precede the hook"
            );
          }
          return true;
        },
      })
    );
    Assert.equal(
      checks,
      0,
      "The hook does not run while another write owns the queue"
    );
    host.beforeDispatch = null;
    resume.resolve();
    await expectDispatched(async () => (await first).value);
    await expectDispatched(async () => (await pending).value);
    Assert.equal(checks, 1, "The async hook runs exactly once");
    Assert.equal(dispatches(host).length, 2);
    if (action === "open") {
      Assert.ok(
        !host.requests.some(message => message.cmd === 2),
        "Contextual opening never pairs"
      );
    }
  }
});

add_task(async function test_native_before_dispatch_requires_strict_true() {
  let denied = [false, undefined, 1, {}];
  for (let action of ["setup", "open"]) {
    for (let index = 0; index <= denied.length; index++) {
      info(`Native dispatch guard result: ${action}, index ${index}`);
      let { manager, host } = managerFixture();
      if (action === "setup") {
        await pair(manager);
      }
      let checks = 0;
      await expectError(
        () =>
          managerAction(manager, action, {
            beforeDispatch: async () => {
              checks++;
              if (index === denied.length) {
                throw new Error(`${SETUP_URI} ${SECRET}`);
              }
              return denied[index];
            },
          }),
        index === denied.length ? "protocol-error" : "invalid-session"
      );
      Assert.equal(checks, 1);
      Assert.equal(
        dispatches(host).length,
        0,
        "A denied or throwing hook never writes command 13"
      );
      if (action === "open") {
        Assert.ok(
          !host.requests.some(message => message.cmd === 2),
          "A failed contextual hook never pairs"
        );
      }
    }
  }
});

add_task(async function test_native_before_dispatch_rechecks_after_await() {
  for (let action of ["setup", "open"]) {
    for (let transition of ["stale", "truthy-current", "disconnect", "lock"]) {
      info(`Native pending dispatch guard: ${action}, ${transition}`);
      let { manager, host } = managerFixture();
      if (action === "setup") {
        await pair(manager);
      }
      let entered = Promise.withResolvers();
      let resume = Promise.withResolvers();
      let current = true;
      let pending = settle(() =>
        managerAction(manager, action, {
          isCurrent: () => current,
          beforeDispatch: () => {
            entered.resolve();
            return resume.promise;
          },
        })
      );
      await expectBoundary(entered, pending);
      Assert.equal(
        dispatches(host).length,
        0,
        "A pending hook prevents native dispatch"
      );
      if (transition === "stale") {
        current = false;
      } else if (transition === "truthy-current") {
        current = 1;
      } else if (transition === "disconnect") {
        host.kill();
        await TestUtils.waitForCondition(
          () => manager.state === "disconnected",
          "The synthetic host disconnects during the hook"
        );
      } else if (transition === "lock") {
        await manager.lock();
      }
      resume.resolve(true);
      let code =
        { disconnect: "connection-closed", lock: "locked" }[transition] ??
        "invalid-session";
      assertSafeError((await pending).error, code);
      Assert.equal(
        dispatches(host).length,
        0,
        "Late hook approval cannot revive an invalid action"
      );
      if (action === "open") {
        Assert.ok(!host.requests.some(message => message.cmd === 2));
      }
    }
  }
  let session = new FakeCrypto();
  let { manager, host } = managerFixture({
    cryptoFactory: async () => session,
  });
  await pair(manager);
  let entered = Promise.withResolvers();
  let resume = Promise.withResolvers();
  let pending = settle(() =>
    manager.setUpOneTimeCode(ORIGIN, SETUP_URI, {
      beforeDispatch: () => {
        entered.resolve();
        return resume.promise;
      },
    })
  );
  await expectBoundary(entered, pending);
  session.isVerified = false;
  resume.resolve(true);
  assertSafeError((await pending).error, "locked");
  Assert.equal(
    dispatches(host).length,
    0,
    "Readiness is checked again even without a generation change"
  );
});

add_task(async function test_dispatch_callback_types_are_validated_locally() {
  let invalid = [null, true, {}];
  for (let action of ["setup", "open"]) {
    let { manager, host } = managerFixture();
    if (action === "setup") {
      await pair(manager);
    }
    let before = host.requests.length;
    let fixture = providerFixture();
    for (let name of ["beforeDispatch", "isCurrent"]) {
      for (let [index, value] of invalid.entries()) {
        info(`Invalid callback: ${action}, ${name}, index ${index}`);
        await expectError(
          () => managerAction(manager, action, { [name]: value }),
          "invalid-argument"
        );
        await expectError(
          () => providerAction(fixture.service, action, { [name]: value }),
          "session-changed",
          true
        );
      }
    }
    Assert.equal(
      host.requests.length,
      before,
      "Invalid callback types never connect or write"
    );
    Assert.deepEqual(
      fixture.calls,
      [],
      "The service rejects invalid callbacks before client creation or authentication"
    );
    Assert.equal(fixture.client.dispatches.length, 0);
    Assert.deepEqual(fixture.launches, []);
  }
});

add_task(async function test_provider_before_dispatch_requires_strict_true() {
  let denied = [false, undefined, 1, {}];
  for (let action of ["setup", "open"]) {
    for (let index = 0; index <= denied.length; index++) {
      info(`Provider dispatch guard result: ${action}, index ${index}`);
      let { service, client, launches, prompts } = providerFixture();
      let checks = 0;
      await expectError(
        () =>
          providerAction(service, action, {
            beforeDispatch: async () => {
              checks++;
              if (index === denied.length) {
                throw new Error(`${SETUP_URI} ${SECRET}`);
              }
              return denied[index];
            },
          }),
        index === denied.length ? "native-error" : "locked",
        true
      );
      Assert.equal(
        checks,
        1,
        "The service forwards the callback rather than silently omitting it"
      );
      if (index < denied.length) {
        Assert.strictEqual(
          client.dispatchChecks.at(-1) === false,
          true,
          "The service wrapper converts every non-true result to a boolean denial"
        );
      }
      Assert.equal(client.dispatches.length, 0);
      Assert.deepEqual(
        launches,
        [],
        "Guard failure cannot trigger a generic app launch"
      );
      Assert.equal(prompts.length, action === "setup" ? 1 : 0);
    }
  }
});

add_task(async function test_provider_pending_hook_observes_invalidation() {
  for (let action of ["setup", "open"]) {
    let transitions = ["lock", "destroy"];
    if (action === "setup") {
      transitions.push("capability-lost", "native-relock");
    }
    for (let transition of transitions) {
      info(`Provider pending dispatch guard: ${action}, ${transition}`);
      let fixture = providerFixture();
      let { service, client, launches } = fixture;
      let entered = Promise.withResolvers();
      let resume = Promise.withResolvers();
      let pending = settle(() =>
        providerAction(service, action, {
          beforeDispatch: () => {
            entered.resolve();
            return resume.promise;
          },
        })
      );
      await expectBoundary(entered, pending);
      Assert.equal(
        client.dispatches.length,
        0,
        "A pending caller callback prevents dispatch"
      );
      await invalidate(fixture, transition);
      resume.resolve(true);
      assertBlocked(await pending);
      Assert.strictEqual(
        client.dispatchChecks.at(-1) === false,
        true,
        "The service wrapper rejects invalidation after the caller callback resolves true"
      );
      Assert.equal(client.dispatches.length, 0);
      Assert.deepEqual(launches, []);
    }
  }
});

add_task(async function test_forwarded_hook_gates_the_native_command() {
  for (let action of ["setup", "open"]) {
    let transitions = [
      "allow",
      "false",
      "stale",
      "disable",
      "replace-session",
      "disconnect",
    ];
    if (action === "setup") {
      transitions.push("otp-disabled");
    }
    for (let transition of transitions) {
      info(`Forwarded native dispatch guard: ${action}, ${transition}`);
      let { manager, host } = managerFixture();
      let fixture = providerFixture({ client: manager });
      let { service, prompts, launches } = fixture;
      let entered = Promise.withResolvers();
      let resume = Promise.withResolvers();
      let current = true;
      let checks = 0;
      let pending = settle(() =>
        providerAction(service, action, {
          isCurrent: () => current,
          beforeDispatch: () => {
            checks++;
            entered.resolve();
            return resume.promise;
          },
        })
      );
      await expectBoundary(entered, pending);
      Assert.equal(
        checks,
        1,
        "The real manager invokes the callback forwarded through the service"
      );
      Assert.equal(
        dispatches(host).length,
        0,
        "No native command is written while the callback awaits"
      );
      Assert.deepEqual(
        host.requests.map(message => message.cmd),
        action === "setup" ? [14, 2, 2] : [14],
        "The hook runs only after connection and any required pairing"
      );
      if (transition === "disconnect") {
        host.kill();
        await TestUtils.waitForCondition(
          () => manager.state === "disconnected",
          "The synthetic host disconnects while the forwarded hook awaits"
        );
      } else if (transition === "replace-session") {
        await service.lock();
        await service.getStatus();
      } else if (!["allow", "false"].includes(transition)) {
        await invalidate(fixture, transition, value => {
          current = value;
        });
      }
      resume.resolve(transition !== "false");
      if (transition === "allow") {
        await expectDispatched(async () => (await pending).value);
        Assert.equal(dispatches(host).length, 1);
      } else {
        let result = await pending;
        if (transition === "disconnect") {
          assertSafeError(result.error, "unavailable", true);
        } else {
          assertBlocked(result);
        }
        Assert.equal(
          dispatches(host).length,
          0,
          "Denied or invalidated approval never sends command 13"
        );
      }
      Assert.equal(
        prompts.length,
        action === "setup" ? 1 : 0,
        "The hook never initiates or retries authentication"
      );
      Assert.deepEqual(launches, []);
    }
  }
});
