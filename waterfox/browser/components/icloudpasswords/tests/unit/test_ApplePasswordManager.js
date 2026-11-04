/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { ApplePasswordManager } = ChromeUtils.importESModule(
  "resource:///modules/ApplePasswordManager.sys.mjs"
);
const { encodeNativeMessage, FakeAppleHost, FakeCrypto } =
  ChromeUtils.importESModule(
    "resource://icloud-passwords-test/ApplePasswordTestUtils.sys.mjs"
  );
const ORIGIN = "https://example.test";

function feedHostMessage(host, message) {
  host.stdout.feed(encodeNativeMessage(message));
}

async function notifyFromHost({ manager, host }, message) {
  let notification = new Promise(resolve => {
    manager.onNotification = resolve;
  });
  feedHostMessage(host, message);
  return notification;
}

function otpScopeKey({ frameURLs, tabId = 0, frameId = 0 }) {
  return JSON.stringify([tabId, frameId, frameURLs]);
}

function managerFixture(options = {}, capabilities = {}) {
  let host = new FakeAppleHost();
  host.otpScopes = new Map();
  let reply = host.reply.bind(host);
  host.reply = frame => {
    let message = JSON.parse(
      new TextDecoder().decode(new Uint8Array(frame, 4))
    );
    if (message.cmd === 16 || message.cmd === 17) {
      let payload = JSON.parse(message.payload);
      let envelope = JSON.parse(payload.SMSG);
      message.body = JSON.parse(envelope.SDATA);
      let qid =
        message.cmd === 16 ? "CmdGetOneTimeCodes" : "CmdDidFillOneTimeCode";
      Assert.equal(payload.QID, qid);
      let scoped = host.otpScopes.get(
        otpScopeKey({ ...message, frameURLs: message.body.frameURLs })
      );
      let selected = (scoped ?? []).filter(
        entry => message.cmd === 16 || entry.username === message.body.username
      );
      host.requests.push(message);
      let response = {
        cmd: message.cmd,
        tabId: message.tabId,
        frameId: message.frameId,
        payload: {
          QID: qid,
          SMSG: {
            TID: envelope.TID,
            SDATA: JSON.stringify({
              STATUS: scoped ? 0 : 3,
              Entries: selected,
            }),
          },
        },
      };
      if (host.otpReply) {
        response = host.otpReply(response, message);
      }
      if (response) {
        feedHostMessage(host, response);
      }
      return Promise.resolve();
    }
    if (message.cmd !== 14) {
      return reply(frame);
    }
    host.requests.push(message);
    feedHostMessage(host, {
      cmd: 14,
      capabilities: {
        secretSessionVersion: 1,
        shouldUseBase64: false,
        ...capabilities,
      },
    });
    return Promise.resolve();
  };
  let manager = new ApplePasswordManager({
    platform: "macosx",
    discoverHost: async () => ({ command: "/synthetic/never-executed" }),
    transportFactory: async () => host,
    cryptoFactory: async () => new FakeCrypto(),
    ...options,
  });
  registerCleanupFunction(() => manager.lock());
  return { manager, host };
}

async function pairedFixture(capabilities = {}) {
  let fixture = managerFixture({}, capabilities);
  await fixture.manager.beginPairing();
  await fixture.manager.completePairing("123456");
  return fixture;
}

add_task(async function test_byte_transport_pairing_and_lookup() {
  let { manager, host } = managerFixture({ transportFactory: undefined });
  let { getSubprocessImplForTest } = ChromeUtils.importESModule(
    "resource://gre/modules/Subprocess.sys.mjs"
  );
  let implementation = getSubprocessImplForTest();
  let { call, isExecutableFile } = implementation;
  try {
    implementation.isExecutableFile = async command => {
      Assert.equal(command, "/synthetic/never-executed");
      return true;
    };
    implementation.call = async options => {
      Assert.equal(
        options.disclaim,
        Services.appinfo.OS === "Darwin",
        "Default launch disclaims responsibility on supported platforms"
      );
      return host;
    };
    await manager.connect();
  } finally {
    Object.assign(implementation, { call, isExecutableFile });
  }
  Assert.equal(manager.state, "locked");
  await manager.beginPairing();
  Assert.equal(manager.state, "pairing");
  Assert.ok(!manager.isReady);
  await manager.completePairing("123456");
  Assert.ok(manager.isReady);
  host.response.RequiresUserAuthenticationToFill = true;
  host.response.Entries[0].RequiresUserAuthenticationToFill = true;
  host.response.Entries[0].sites = ["https://example.test/login"];
  let accounts = await manager.listAccounts(ORIGIN);
  Assert.deepEqual(accounts, [
    { username: "test-user", sites: ["https://example.test/login"] },
  ]);
  Assert.deepEqual(await manager.getPassword(ORIGIN, accounts[0]), {
    username: "test-user",
    password: "synthetic",
    sites: ["https://example.test/login"],
  });
  Assert.equal(host.requests.at(-1).body.URL, "https://example.test/login");
  Assert.equal(host.requests.at(-1).url, "https://example.test/login");
  let requestsBeforeMismatch = host.requests.length;
  await Assert.rejects(
    manager.getPassword(ORIGIN, {
      username: accounts[0].username,
      sites: [
        "https://example.test:8443",
        "https://test",
        "https://unrelated.invalid",
      ],
    }),
    error => error.code === "invalid-argument"
  );
  Assert.equal(
    host.requests.length,
    requestsBeforeMismatch,
    "An unrelated native site is rejected before any request"
  );
  Assert.deepEqual(
    host.requests.map(request => request.cmd),
    [14, 2, 2, 4, 5]
  );
  await manager.lock();
  Assert.ok(!manager.isReady);
  Assert.ok(host.closed);
});

add_task(async function test_save_status_authentication_and_otp_shape() {
  let { manager, host } = await pairedFixture({ canFillOneTimeCodes: true });
  let login = { origin: ORIGIN, username: "test-user", password: "synthetic" };
  host.response = { STATUS: 0, RequiresUserAuthenticationToFill: true };
  // The fake host answers cmd6 with cmd4.
  Assert.deepEqual(await manager.savePassword(login), {
    accepted: true,
    verified: false,
  });
  Assert.ok(manager.isReady, "Accepted save does not invalidate pairing");
  Assert.deepEqual(
    host.requests.map(request => request.cmd),
    [14, 2, 2, 6],
    "Save acknowledgement does not trigger a retry or read"
  );
  Assert.equal(host.requests.at(-1).body.NURL, "example.test");
  Assert.ok(
    !Object.hasOwn(host.requests.at(-1), "url"),
    "Save omits the outer URL while retaining encrypted NURL"
  );
  host.response = { STATUS: 5, RequiresUserAuthenticationToFill: true };
  await Assert.rejects(
    manager.savePassword(login),
    error => error.code === "save-failed"
  );
  let metadata = {
    username: "test-user",
    domain: "example.test",
    source: "totp",
  };
  let nativeCodes = [{ ...metadata, code: "654321" }];
  host.otpScopes.set(otpScopeKey({ frameURLs: [`${ORIGIN}/`] }), nativeCodes);
  Assert.deepEqual(
    await manager.listOneTimeCodes(ORIGIN),
    [metadata],
    "Listing strips codes"
  );
  Assert.deepEqual(
    await manager.getOneTimeCodes(ORIGIN, { username: metadata.username }),
    nativeCodes
  );
  Assert.deepEqual(
    host.requests.slice(-2).map(({ cmd, body, payload, ...outer }) => ({
      cmd,
      body,
      qid: JSON.parse(payload).QID,
      hasOuterURL: Object.hasOwn(outer, "url"),
    })),
    [
      {
        cmd: 16,
        body: { ACT: 5, TYPE: "oneTimeCodes", frameURLs: [`${ORIGIN}/`] },
        qid: "CmdGetOneTimeCodes",
        hasOuterURL: false,
      },
      {
        cmd: 17,
        body: {
          ACT: 2,
          TYPE: "oneTimeCodes",
          frameURLs: [`${ORIGIN}/`],
          username: metadata.username,
        },
        qid: "CmdDidFillOneTimeCode",
        hasOuterURL: false,
      },
    ]
  );
  Assert.deepEqual(await manager.getOneTimeCodes(ORIGIN, { username: "" }), []);
  Assert.strictEqual(
    host.requests.at(-1).body.username,
    "",
    "Empty usernames are preserved"
  );
  let beforeInvalidUsername = host.requests.length;
  await Assert.rejects(
    manager.getOneTimeCodes(ORIGIN),
    error => error.code === "invalid-argument"
  );
  for (let username of [null, 42, "user\0name"]) {
    await Assert.rejects(
      manager.getOneTimeCodes(ORIGIN, { username }),
      error => error.code === "invalid-argument"
    );
  }
  Assert.equal(host.requests.length, beforeInvalidUsername);
  host.response = { STATUS: 3, RequiresUserAuthenticationToFill: true };
  let requestsBeforeRead = host.requests.length;
  Assert.deepEqual(await manager.listAccounts(ORIGIN), []);
  Assert.ok(manager.isReady, "No accounts does not invalidate pairing");
  Assert.ok(!host.closed, "No accounts keeps the native channel open");
  Assert.equal(host.requests.at(-1).cmd, 4);
  Assert.equal(
    host.requests.length,
    requestsBeforeRead + 1,
    "No accounts does not trigger an automatic retry"
  );

  requestsBeforeRead = host.requests.length;
  await Assert.rejects(
    manager.getPassword(ORIGIN, { username: login.username }),
    error => error.code === "no-results"
  );
  Assert.ok(manager.isReady, "No results does not invalidate pairing");
  Assert.ok(!host.closed, "No results keeps the native channel open");
  Assert.equal(
    host.requests.length,
    requestsBeforeRead + 1,
    "No results does not trigger an automatic retry"
  );

  host.response = { STATUS: 0, RequiresUserAuthenticationToFill: true };
  await Assert.rejects(
    manager.getPassword(ORIGIN, { username: login.username }),
    error => error.code === "no-results",
    "Policy metadata alone cannot supply a missing credential"
  );
  Assert.ok(manager.isReady, "Fill policy does not invalidate the session");

  for (let [response, code, state] of [
    [
      { STATUS: 9, RequiresUserAuthenticationToFill: true },
      "invalid-session",
      "locked",
    ],
    [
      { STATUS: 0, RequiresUserAuthenticationToFill: "true" },
      "protocol-error",
      "disconnected",
    ],
  ]) {
    let fixture = await pairedFixture();
    fixture.host.response = response;
    await Assert.rejects(
      fixture.manager.savePassword(login),
      error => error.code === code
    );
    Assert.equal(fixture.manager.state, state);
  }
});

add_task(async function test_site_ports_and_exact_policy_sentinel() {
  let { manager, host } = await pairedFixture();
  for (let [origin, site] of [
    ["https://example.test:8443", "example.test:8443"],
    ["http://example.test:8080", "example.test:8080"],
    ["https://example.test:443", "example.test"],
    ["https://[2001:db8::1]:8443", "[2001:db8::1]:8443"],
  ]) {
    host.response = {
      STATUS: 0,
      Entries: [{ USR: "test-user", PWD: "synthetic", sites: [site] }],
    };
    await manager.listAccounts(origin);
    Assert.equal(host.requests.at(-1).body.URL, site);
    Assert.equal(host.requests.at(-1).url, site);
    await manager.getPassword(origin, { username: "test-user" });
    Assert.equal(host.requests.at(-1).body.URL, site);
    Assert.equal(host.requests.at(-1).url, site);
    await manager.savePassword({
      origin,
      username: "test-user",
      password: "synthetic",
    });
    Assert.deepEqual(host.requests.at(-1).body, {
      ACT: 4,
      URL: "",
      USR: "",
      PWD: "",
      NURL: site,
      NUSR: "test-user",
      NPWD: "synthetic",
    });
    Assert.ok(!Object.hasOwn(host.requests.at(-1), "url"));
  }
  let sentinel = "Passwords\u00a0not\u00a0saved";
  host.response = {
    STATUS: 0,
    Entries: [
      { USR: sentinel },
      { USR: "Passwords not saved", sites: ["example.test"] },
      { USR: `${sentinel} `, sites: ["example.test"] },
    ],
  };
  Assert.deepEqual(await manager.listAccounts(ORIGIN), [
    { username: "Passwords not saved", sites: ["example.test"] },
    { username: `${sentinel} `, sites: ["example.test"] },
  ]);
  await Assert.rejects(
    manager.getPassword(ORIGIN, { username: sentinel }),
    error => error.code === "no-results"
  );
  Assert.ok(manager.isReady);
});

add_task(async function test_otp_capability_lifetime() {
  for (let value of [undefined, false, true]) {
    let capabilities =
      value === undefined ? {} : { canFillOneTimeCodes: value };
    let { manager } = managerFixture({}, capabilities);
    Assert.strictEqual(manager.canFillOneTimeCodes, false);
    await manager.connect();
    Assert.strictEqual(manager.canFillOneTimeCodes, value ?? false);
    await manager.lock();
    Assert.strictEqual(manager.canFillOneTimeCodes, false);
  }
  for (let value of [null, 1, "true"]) {
    let { manager, host } = managerFixture({}, { canFillOneTimeCodes: value });
    await Assert.rejects(
      manager.connect(),
      error => error.code === "unsupported-protocol"
    );
    Assert.strictEqual(manager.canFillOneTimeCodes, false);
    Assert.ok(host.closed);
  }
});

add_task(async function test_exact_native_no_value_set_reset() {
  let fixture = managerFixture({}, { canFillOneTimeCodes: true });
  let { manager, host } = fixture;
  await manager.beginPairing();
  Assert.deepEqual(
    await notifyFromHost(fixture, { cmd: 3, payload: "NoValueSet" }),
    { type: "presentation-changed" },
    "No established session is reset during pairing"
  );
  Assert.equal(manager.state, "pairing");
  await manager.completePairing("123456");
  for (let payload of [
    undefined,
    null,
    "UnknownPage",
    "DoNotRemember",
    "RememberLoginAndPassword",
    "novalueset",
    "NoValueSet ",
    { value: "NoValueSet" },
  ]) {
    Assert.deepEqual(
      await notifyFromHost(fixture, { cmd: 3, payload, STATUS: 9 }),
      { type: "presentation-changed" }
    );
    Assert.ok(manager.isReady, "Other presentation shapes are not resets");
  }
  let sent;
  let requestSent = new Promise(resolve => {
    sent = resolve;
  });
  host.reply = frame => {
    host.requests.push(
      JSON.parse(new TextDecoder().decode(new Uint8Array(frame, 4)))
    );
    sent();
    return Promise.resolve();
  };
  let pending = (async () => {
    await Assert.rejects(
      manager.listAccounts(ORIGIN),
      error => error.code === "invalid-session"
    );
  })();
  await requestSent;
  let beforeReset = host.requests.length;
  Assert.deepEqual(
    await notifyFromHost(fixture, {
      cmd: 3,
      payload: "NoValueSet",
      STATUS: 0,
      tabId: 0,
      frameId: 0,
    }),
    { type: "state-changed" }
  );
  await pending;
  Assert.ok(!manager.isReady);
  Assert.equal(manager.state, "locked");
  Assert.strictEqual(manager.canFillOneTimeCodes, false);
  Assert.ok(host.closed);
  Assert.equal(
    host.requests.length,
    beforeReset,
    "Reset sends no preflight or retry"
  );
});

add_task(async function test_otp_raw_issuer_and_immutable_frame_scope() {
  let { manager, host } = await pairedFixture({ canFillOneTimeCodes: true });
  let context = {
    frameURLs: [`${ORIGIN}/sign-in?flow=OTP#field`, `${ORIGIN}/parent`],
    tabId: 42,
    frameId: 7,
  };
  let identity = {
    username: " Alice@Example ",
    domain: "Other.Issuer / Personal Account",
    source: "totp",
  };
  let code = { ...identity, code: "012345", expiresAt: 4000000000000 };
  host.otpScopes.set(otpScopeKey(context), [code, { ...code, source: "sms" }]);
  let supplied = { ...context, frameURLs: [...context.frameURLs] };
  supplied.frameURLs[Symbol.iterator] = () => {
    throw new Error("Validation must use the bounded indexed array contents");
  };
  let listing = manager.listOneTimeCodes(ORIGIN, supplied);
  supplied.frameURLs[0] = "https://foreign.invalid/";
  supplied.tabId = 99;
  Assert.deepEqual(await listing, [identity]);
  let request = host.requests.at(-1);
  Assert.deepEqual(request.body.frameURLs, context.frameURLs);
  Assert.equal(request.tabId, context.tabId);
  Assert.equal(request.frameId, context.frameId);
  Assert.ok(!Object.hasOwn(request, "url"));
  Assert.deepEqual(
    await manager.getOneTimeCodes(ORIGIN, {
      ...context,
      username: identity.username,
    }),
    [code]
  );
  request = host.requests.at(-1);
  Assert.equal(request.cmd, 17);
  Assert.strictEqual(request.body.username, identity.username);
  Assert.deepEqual(request.body.frameURLs, context.frameURLs);
  Assert.ok(!Object.hasOwn(request.body, "domain"));
  Assert.deepEqual(
    await manager.listOneTimeCodes(ORIGIN, { ...context, frameId: 8 }),
    [],
    "The fake host scopes replies by full frame URLs and routing, not selectors"
  );
  Assert.ok(!host.requests.some(({ cmd }) => [4, 5, 6].includes(cmd)));
});

add_task(
  async function test_otp_rejects_invalid_context_before_native_writes() {
    let { manager, host } = await pairedFixture({ canFillOneTimeCodes: true });
    let before = host.requests.length;
    for (let options of [
      null,
      [],
      { frameURLs: [] },
      { frameURLs: new Array(1) },
      { frameURLs: Array(33).fill(`${ORIGIN}/`) },
      ...[
        "https://foreign.invalid/",
        "https://example.test:8443/",
        "http://example.test/",
        "https://user:synthetic@example.test/",
        "https://@example.test/",
        "https://example.test/path\n",
        "https://example.test/\\path",
        "/relative",
        `${ORIGIN}/${"x".repeat(8192)}`,
      ].map(url => ({ frameURLs: [url] })),
      ...["tabId", "frameId"].flatMap(key =>
        [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, "7", null].map(
          value => ({ [key]: value })
        )
      ),
    ]) {
      await Assert.rejects(manager.listOneTimeCodes(ORIGIN, options), error =>
        ["invalid-origin", "invalid-argument"].includes(error.code)
      );
      await Assert.rejects(
        manager.getOneTimeCodes(
          ORIGIN,
          options === null || Array.isArray(options)
            ? options
            : { ...options, username: "alice" }
        ),
        error => ["invalid-origin", "invalid-argument"].includes(error.code)
      );
    }
    await Assert.rejects(
      manager.listOneTimeCodes("http://example.test"),
      error => error.code === "invalid-origin"
    );
    Assert.equal(host.requests.length, before);
    Assert.ok(manager.isReady);
    let boundary = {
      frameURLs: Array(32).fill(`${ORIGIN}/`),
      tabId: Number.MAX_SAFE_INTEGER,
      frameId: Number.MAX_SAFE_INTEGER,
    };
    Assert.deepEqual(await manager.listOneTimeCodes(ORIGIN, boundary), []);
    Assert.equal(host.requests.at(-1).tabId, boundary.tabId);
    Assert.equal(host.requests.at(-1).frameId, boundary.frameId);
    Assert.equal(host.requests.at(-1).body.frameURLs.length, 32);
  }
);

add_task(async function test_otp_routing_and_raw_identity_validation() {
  let context = { frameURLs: [`${ORIGIN}/otp`], tabId: 42, frameId: 7 };
  let identity = {
    username: "alice",
    domain: "Issuer With Spaces",
    source: "totp",
  };
  for (let command of [16, 17]) {
    for (let [key, value] of [
      ["tabId", 43],
      ["frameId", 8],
      ["frameId", "7"],
      ["tabId", null],
    ]) {
      let { manager, host } = await pairedFixture({
        canFillOneTimeCodes: true,
      });
      host.otpScopes.set(otpScopeKey(context), [
        { ...identity, code: "012345" },
      ]);
      host.otpReply = reply => ({ ...reply, [key]: value });
      await Assert.rejects(
        command === 16
          ? manager.listOneTimeCodes(ORIGIN, context)
          : manager.getOneTimeCodes(ORIGIN, {
              ...context,
              username: identity.username,
            }),
        error => error.code === "protocol-error"
      );
      Assert.ok(
        !manager.isReady,
        "Cross-context or malformed routing fails closed"
      );
    }
  }
  let { manager, host } = await pairedFixture({ canFillOneTimeCodes: true });
  host.otpScopes.set(otpScopeKey(context), [{ ...identity, code: "012345" }]);
  host.otpReply = reply => {
    delete reply.tabId;
    delete reply.frameId;
    return reply;
  };
  Assert.deepEqual(await manager.listOneTimeCodes(ORIGIN, context), [identity]);
  for (let invalid of [
    { domain: "" },
    { domain: "issuer\0other" },
    { domain: "issuer\nother" },
    { domain: "x".repeat(8193) },
    { username: "alice\0other" },
    { username: "x".repeat(4097) },
  ]) {
    let fixture = await pairedFixture({ canFillOneTimeCodes: true });
    fixture.host.otpScopes.set(otpScopeKey(context), [
      { ...identity, ...invalid },
    ]);
    await Assert.rejects(
      fixture.manager.listOneTimeCodes(ORIGIN, context),
      error => error.code === "protocol-error"
    );
  }
});
