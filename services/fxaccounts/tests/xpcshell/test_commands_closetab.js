/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { CloseRemoteTab, CommandQueue } = ChromeUtils.importESModule(
  "resource://gre/modules/FxAccountsCommands.sys.mjs"
);

const { COMMAND_CLOSETAB, COMMAND_CLOSETAB_TAIL } = ChromeUtils.importESModule(
  "resource://gre/modules/FxAccountsCommon.sys.mjs"
);

const { getRemoteCommandStore, RemoteCommand } = ChromeUtils.importESModule(
  "resource://services-sync/TabsStore.sys.mjs"
);

const { NimbusTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/NimbusTestUtils.sys.mjs"
);

NimbusTestUtils.init(this);

class TelemetryMock {
  constructor() {
    this._events = [];
    this._uuid_counter = 0;
  }

  recordEvent(object, method, value, extra = undefined) {
    this._events.push({ object, method, value, extra });
  }

  generateFlowID() {
    this._uuid_counter += 1;
    return this._uuid_counter.toString();
  }

  sanitizeDeviceId(id) {
    return id + "-san";
  }
}

function FxaInternalMock(recentDeviceList) {
  return {
    telemetry: new TelemetryMock(),
    device: {
      recentDeviceList,
    },
  };
}

add_task(async function test_closetab_isDeviceCompatible() {
  const closeTab = new CloseRemoteTab(null, null);
  let device = { name: "My device" };
  Assert.ok(!closeTab.isDeviceCompatible(device));
  device = { name: "My device", availableCommands: {} };
  Assert.ok(!closeTab.isDeviceCompatible(device));
  device = {
    name: "My device",
    availableCommands: {
      "https://sync.foxxite.workers.dev/cmd/close-uri/v1": "payload",
    },
  };
  // The feature should be on by default
  Assert.ok(closeTab.isDeviceCompatible(device));

  // Disable the feature
  Services.prefs.setBoolPref(
    "identity.fxaccounts.commands.remoteTabManagement.enabled",
    false
  );
  Assert.ok(!closeTab.isDeviceCompatible(device));

  // clear the pref to test overriding with nimbus
  Services.prefs.clearUserPref(
    "identity.fxaccounts.commands.remoteTabManagement.enabled"
  );
  Assert.ok(closeTab.isDeviceCompatible(device));

  const { cleanup } = await NimbusTestUtils.setupTest();

  // Verify that nimbus can remotely override the pref
  let doExperimentCleanup = await NimbusTestUtils.enrollWithFeatureConfig({
    featureId: "remoteTabManagement",
    // You can add values for each variable you added to the manifest
    value: {
      closeTabsEnabled: false,
    },
  });

  // Feature successfully disabled
  Assert.ok(!closeTab.isDeviceCompatible(device));

  await doExperimentCleanup();
  await cleanup();
});

add_task(async function test_closetab_send() {
  const targetDevice = { id: "dev1", name: "Device 1" };

  const fxai = FxaInternalMock([targetDevice]);
  let fxaCommands = {};
  const closeTab = (fxaCommands.closeTab = new CloseRemoteTab(
    fxaCommands,
    fxai
  ));
  const commandQueue = (fxaCommands.commandQueue = new CommandQueue(
    fxaCommands,
    fxai
  ));
  let commandMock = sinon.mock(closeTab);
  let queueMock = sinon.mock(commandQueue);

  // freeze "now" to a specific time
  let now = Date.now();
  commandQueue.now = () => now;

  // Set the delay to 10ms
  commandQueue.DELAY = 10;

  const store = await getRemoteCommandStore();

  // Queue 3 tabs to close with different timings
  const command1 = new RemoteCommand.CloseTab("https://foo.bar/must-send");
  await store.addRemoteCommandAt(targetDevice.id, command1, now - 15);

  const command2 = new RemoteCommand.CloseTab("https://foo.bar/can-send");
  await store.addRemoteCommandAt(targetDevice.id, command2, now - 12);

  const command3 = new RemoteCommand.CloseTab("https://foo.bar/early");
  await store.addRemoteCommandAt(targetDevice.id, command3, now - 5);

  // Verify initial state
  let pending = await store.getUnsentCommands();
  Assert.equal(pending.length, 3);

  commandMock.expects("sendCloseTabsCommand").never();
  // We expect command1 to be "overdue": 10ms slop + 5ms + 10ms delay
  queueMock.expects("_ensureTimer").once().withArgs(16);

  // Run the flush
  await commandQueue.flushQueue();

  // Verify state after flush - all commands should still be there
  pending = await store.getUnsentCommands();
  Assert.equal(pending.length, 3);

  commandMock.verify();
  queueMock.verify();

  // Move time forward by 15ms
  now += 15;

  // Reset mocks
  commandMock = sinon.mock(closeTab);
  queueMock = sinon.mock(commandQueue);

  commandMock
    .expects("sendCloseTabsCommand")
    .once()
    .withArgs(targetDevice, [
      "https://foo.bar/early",
      "https://foo.bar/can-send",
      "https://foo.bar/must-send",
    ])
    .resolves(true);

  queueMock.expects("_ensureTimer").never();

  await commandQueue.flushQueue();

  // Verify final state - all commands should be sent
  pending = await store.getUnsentCommands();
  Assert.equal(pending.length, 0);

  commandMock.verify();
  queueMock.verify();

  // Testing we don't send commands if there are
  // no "overdue" items but there are "due" ones

  // Queue 2 more tabs
  let command4 = new RemoteCommand.CloseTab("https://foo.bar/due");
  await store.addRemoteCommandAt(targetDevice.id, command4, now - 5);
  let command5 = new RemoteCommand.CloseTab("https://foo.bar/due2");
  await store.addRemoteCommandAt(targetDevice.id, command5, now);

  // Verify initial state
  pending = await store.getUnsentCommands();
  Assert.equal(pending.length, 2);

  commandMock = sinon.mock(closeTab);
  queueMock = sinon.mock(commandQueue);

  commandMock.expects("sendCloseTabsCommand").never();
  queueMock.expects("_ensureTimer").once().withArgs(16); // 10ms slop + 5ms + 1ms delay

  // Move the timer a little but not due enough
  now += 5;

  // Run the flush
  await commandQueue.flushQueue();

  // all commands should still be there
  pending = await store.getUnsentCommands();
  Assert.equal(pending.length, 2);

  commandMock.verify();
  queueMock.verify();

  // Clean up unsent commands
  await store.removeRemoteCommand(targetDevice.id, command4);
  await store.removeRemoteCommand(targetDevice.id, command5);

  commandMock.restore();
  queueMock.restore();
  commandQueue.shutdown();
});

add_task(async function test_closetab_send() {
  const targetDevice = { id: "dev1", name: "Device 1" };

  const fxai = FxaInternalMock([targetDevice]);
  let fxaCommands = {};
  const closeTab = (fxaCommands.closeTab = new CloseRemoteTab(
    fxaCommands,
    fxai
  ));
  const commandQueue = (fxaCommands.commandQueue = new CommandQueue(
    fxaCommands,
    fxai
  ));
  let commandMock = sinon.mock(closeTab);
  let queueMock = sinon.mock(commandQueue);

  // freeze "now" to <= when the command was sent.
  let now = Date.now();
  commandQueue.now = () => now;

  // Set the delay to 10ms
  commandQueue.DELAY = 10;

  // Our command will be written and have a timer set in 21ms.
  queueMock.expects("_ensureTimer").once().withArgs(21);

  // In this test we expect no commands sent but a timer instead.
  closeTab.invoke = sinon.spy((cmd, device, payload) => {
    Assert.equal(payload.encrypted, "encryptedpayload");
  });

  const store = await getRemoteCommandStore();
  Assert.equal((await store.getUnsentCommands()).length, 0);
  // queue a tab to close, recent enough that it remains queued and a new timer is set for it.
  const command = new RemoteCommand.CloseTab(
    "https://foo.bar/send-at-shutdown"
  );
  Assert.ok(
    await store.addRemoteCommandAt(targetDevice.id, command, now),
    "adding the remote command should work"
  );

  // We have the tab queued
  const pending = await store.getUnsentCommands();
  Assert.equal(pending.length, 1);

  await commandQueue.flushQueue();
  // A timer was set for it.
  Assert.equal((await store.getUnsentCommands()).length, 1);

  commandMock.verify();
  queueMock.verify();

  // now pretend we are being shutdown - we should force the send even though the time
  // criteria has not been met.
  commandMock = sinon.mock(closeTab);
  queueMock = sinon.mock(commandQueue);
  queueMock.expects("_ensureTimer").never();
  commandMock
    .expects("sendCloseTabsCommand")
    .once()
    .withArgs(targetDevice, ["https://foo.bar/send-at-shutdown"])
    .resolves(true);

  await commandQueue.flushQueue(true);
  // No tabs waiting
  Assert.equal((await store.getUnsentCommands()).length, 0);

  commandMock.verify();
  queueMock.verify();
  commandMock.restore();
  queueMock.restore();
  commandQueue.shutdown();
});

add_task(async function test_multiple_devices() {
  const device1 = {
    id: "dev1",
    name: "Device 1",
  };
  const device2 = {
    id: "dev2",
    name: "Device 2",
  };
  const fxai = FxaInternalMock([device1, device2]);
  let fxaCommands = {};
  const closeTab = (fxaCommands.closeTab = new CloseRemoteTab(
    fxaCommands,
    fxai
  ));
  const commandQueue = (fxaCommands.commandQueue = new CommandQueue(
    fxaCommands,
    fxai
  ));

  const store = await getRemoteCommandStore();

  const tab1 = "https://foo.bar";
  const tab2 = "https://example.com";

  let commandMock = sinon.mock(closeTab);
  let queueMock = sinon.mock(commandQueue);

  let now = Date.now();
  commandQueue.now = () => now;

  // Set the delay to 10ms
  commandQueue.DELAY = 10;

  commandMock.expects("sendCloseTabsCommand").twice().resolves(true);

  // In this test we expect no commands sent but a timer instead.
  closeTab.invoke = sinon.spy((cmd, device, payload) => {
    Assert.equal(payload.encrypted, "encryptedpayload");
  });

  let command1 = new RemoteCommand.CloseTab(tab1);
  Assert.ok(
    await store.addRemoteCommandAt(device1.id, command1, now - 15),
    "adding the remote command should work"
  );

  let command2 = new RemoteCommand.CloseTab(tab2);
  Assert.ok(
    await store.addRemoteCommandAt(device2.id, command2, now),
    "adding the remote command should work"
  );

  // both tabs should remain pending.
  let unsentCommands = await store.getUnsentCommands();
  Assert.equal(unsentCommands.length, 2);

  // Verify both unsent commands looks as expected for each device
  Assert.equal(unsentCommands[0].deviceId, "dev1");
  Assert.equal(unsentCommands[0].command.url, "https://foo.bar");
  Assert.equal(unsentCommands[1].deviceId, "dev2");
  Assert.equal(unsentCommands[1].command.url, "https://example.com");

  // move "now" to be 20ms timer - ie, pretending the timer fired.
  now += 20;

  await commandQueue.flushQueue();

  // no more in queue
  unsentCommands = await store.getUnsentCommands();
  Assert.equal(unsentCommands.length, 0);

  // This will verify the expectation set after the mock init
  commandMock.verify();
  queueMock.verify();
  commandQueue.shutdown();
  commandMock.restore();
  queueMock.restore();
});

add_task(async function test_timer_reset_on_new_tab() {
  const targetDevice = {
    id: "dev1",
    name: "Device 1",
    availableCommands: { [COMMAND_CLOSETAB]: "payload" },
  };
  const fxai = FxaInternalMock([targetDevice]);
  let fxaCommands = {};
  const closeTab = (fxaCommands.closeTab = new CloseRemoteTab(
    fxaCommands,
    fxai
  ));
  const commandQueue = (fxaCommands.commandQueue = new CommandQueue(
    fxaCommands,
    fxai
  ));
  const store = await getRemoteCommandStore();

  const tab1 = "https://foo.bar/";
  const tab2 = "https://example.com/";

  let commandMock = sinon.mock(closeTab);
  let queueMock = sinon.mock(commandQueue);

  let now = Date.now();
  commandQueue.now = () => now;

  // Set the delay to 10ms
  commandQueue.DELAY = 10;

  const ensureTimerSpy = sinon.spy(commandQueue, "_ensureTimer");

  commandMock.expects("sendCloseTabsCommand").never();

  let command1 = new RemoteCommand.CloseTab(tab1);
  Assert.ok(
    await store.addRemoteCommandAt(targetDevice.id, command1, now - 5),
    "adding the remote command should work"
  );
  await commandQueue.flushQueue();

  let command2 = new RemoteCommand.CloseTab(tab2);
  Assert.ok(
    await store.addRemoteCommandAt(targetDevice.id, command2, now),
    "adding the remote command should work"
  );
  await commandQueue.flushQueue();

  // both tabs should remain pending.
  let unsentCmds = await store.getUnsentCommands();
  Assert.equal(unsentCmds.length, 2);

  // _ensureTimer should've been called at least twice
  Assert.ok(ensureTimerSpy.callCount > 1);
  commandMock.verify();
  queueMock.verify();
  commandQueue.shutdown();
  commandMock.restore();
  queueMock.restore();

  // Clean up any unsent commands for future tests
  for await (const cmd of unsentCmds) {
    console.log(cmd);
    await store.removeRemoteCommand(cmd.deviceId, cmd.command);
  }
});

// Test that once we see the first tab sync complete we wait for the idle service then check the queue.
add_task(async function test_idle_flush() {
  const commandQueue = new CommandQueue({}, {});

  let addIdleObserver = (obs, duration) => {
    Assert.equal(duration, 3);
    obs();
  };
  let spyAddIdleObserver = sinon.spy(addIdleObserver);
  let idleService = {
    addIdleObserver: spyAddIdleObserver,
    removeIdleObserver: sinon.mock(),
  };
  commandQueue._getIdleService = () => {
    return idleService;
  };
  let spyFlushQueue = sinon.spy(commandQueue, "flushQueue");

  // send the notification twice - should flush once.
  Services.obs.notifyObservers(null, "weave:engine:sync:finish", "tabs");
  Services.obs.notifyObservers(null, "weave:engine:sync:finish", "tabs");

  Assert.ok(spyAddIdleObserver.calledOnce);
  Assert.ok(spyFlushQueue.calledOnce);
  commandQueue.shutdown();
  spyFlushQueue.restore();
});

add_task(async function test_telemetry_on_sendCloseTabsCommand() {
  const targetDevice = {
    id: "dev1",
    name: "Device 1",
    availableCommands: { [COMMAND_CLOSETAB]: "payload" },
  };
  const fxai = FxaInternalMock([targetDevice]);

  // Stub out invoke and _encrypt since we're mainly testing
  // the telemetry gets called okay
  const commands = {
    _invokes: [],
    invoke(cmd, device, payload) {
      this._invokes.push({ cmd, device, payload });
    },
  };
  const closeTab = (commands.closeTab = new CloseRemoteTab(commands, fxai));
  const commandQueue = (commands.commandQueue = new CommandQueue(
    commands,
    fxai
  ));

  closeTab._encrypt = () => "encryptedpayload";

  // freeze "now" to <= when the command was sent.
  let now = Date.now();
  commandQueue.now = () => now;

  // Set the delay to 10ms
  commandQueue.DELAY = 10;

  let command1 = new RemoteCommand.CloseTab("https://foo.bar/");

  const store = await getRemoteCommandStore();
  Assert.ok(
    await store.addRemoteCommandAt(targetDevice.id, command1, now - 15),
    "adding the remote command should work"
  );

  await commandQueue.flushQueue();
  // Validate that sendCloseTabsCommand was called correctly
  Assert.deepEqual(fxai.telemetry._events, [
    {
      object: "command-sent",
      method: COMMAND_CLOSETAB_TAIL,
      value: "dev1-san",
      extra: { flowID: "1", streamID: "2" },
    },
  ]);

  commandQueue.shutdown();
});

// Should match the one in the FxAccountsCommands
const COMMAND_MAX_PAYLOAD_SIZE = 16 * 1024;
add_task(async function test_closetab_chunking() {
  const targetDevice = { id: "dev1", name: "Device 1" };

  const fxai = FxaInternalMock([targetDevice]);
  let fxaCommands = {};
  const closeTab = (fxaCommands.closeTab = new CloseRemoteTab(
    fxaCommands,
    fxai
  ));
  const commandQueue = (fxaCommands.commandQueue = new CommandQueue(
    fxaCommands,
    fxai
  ));
  let commandMock = sinon.mock(closeTab);
  let queueMock = sinon.mock(commandQueue);

  // freeze "now" to <= when the command was sent.
  let now = Date.now();
  commandQueue.now = () => now;

  // Set the delay to 10ms
  commandQueue.DELAY = 10;

  // Generate a large number of commands to exceed the 16KB payload limit
  const largeNumberOfCommands = [];
  for (let i = 0; i < 300; i++) {
    largeNumberOfCommands.push(
      new RemoteCommand.CloseTab(
        `https://example.com/addingsomeextralongstring/tab${i}`
      )
    );
  }

  // Add these commands to the store
  const store = await getRemoteCommandStore();
  for (let command of largeNumberOfCommands) {
    await store.addRemoteCommandAt(targetDevice.id, command, now - 15);
  }

  const encoder = new TextEncoder();
  // Calculate expected number of chunks
  const totalPayloadSize = encoder.encode(
    JSON.stringify(largeNumberOfCommands.map(cmd => cmd.url))
  ).byteLength;
  const expectedChunks = Math.ceil(totalPayloadSize / COMMAND_MAX_PAYLOAD_SIZE);

  let flowIDUsed;
  let chunksSent = 0;
  commandMock
    .expects("sendCloseTabsCommand")
    .exactly(expectedChunks)
    .callsFake((device, urls, flowID) => {
      console.log(
        "Chunk sent with size:",
        encoder.encode(JSON.stringify(urls)).length
      );
      chunksSent++;
      if (!flowIDUsed) {
        flowIDUsed = flowID;
      } else {
        Assert.equal(
          flowID,
          flowIDUsed,
          "FlowID should be consistent across chunks"
        );
      }

      const chunkSize = encoder.encode(JSON.stringify(urls)).length;
      Assert.ok(
        chunkSize <= COMMAND_MAX_PAYLOAD_SIZE,
        `Chunk size (${chunkSize}) should not exceed max payload size (${COMMAND_MAX_PAYLOAD_SIZE})`
      );

      return Promise.resolve(true);
    });

  await commandQueue.flushQueue();

  // Check that all commands have been sent
  Assert.equal((await store.getUnsentCommands()).length, 0);
  Assert.equal(
    chunksSent,
    expectedChunks,
    `Should have sent ${expectedChunks} chunks`
  );

  commandMock.verify();
  queueMock.verify();

  // Test edge case: URL exceeding max size
  const oversizedCommand = new RemoteCommand.CloseTab(
    "https://example.com/" + "a".repeat(COMMAND_MAX_PAYLOAD_SIZE)
  );
  await store.addRemoteCommandAt(targetDevice.id, oversizedCommand, now);

  await commandQueue.flushQueue();

  // The oversized command should still be unsent
  Assert.equal((await store.getUnsentCommands()).length, 1);

  commandMock.verify();
  queueMock.verify();
  commandQueue.shutdown();
  commandMock.restore();
  queueMock.restore();
});
