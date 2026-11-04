/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { ICloudPasswordsService } = ChromeUtils.importESModule(
  "resource:///modules/ICloudPasswords.sys.mjs"
);
const PIN_DIALOG_URI =
  "chrome://browser/content/waterfox/icloudpasswords/pinDialog.xhtml";

function createExpiryProvider(name) {
  let prefs = Services.prefs.getBranch(`test.icloud-pin-expiry.${name}.`);
  let client = {
    supported: true,
    state: "disconnected",
    pairingCalls: 0,
    get isReady() {
      return this.state === "ready";
    },
    setState(state, error) {
      this.state = state;
      this.onStateChange(state, { error });
    },
    async connect() {
      this.setState("locked");
    },
    async beginPairing() {
      this.pairingCalls++;
      this.setState("pairing");
    },
    async completePairing() {
      Assert.ok(false, "An expired prompt must not submit a PIN");
    },
    async listAccounts() {
      Assert.ok(false, "An expired unlock must not read accounts");
    },
    async lock() {
      this.setState("locked");
    },
  };
  let provider = new ICloudPasswordsService({
    prefs,
    platform: "macosx",
    clientFactory({ onStateChange }) {
      client.onStateChange = onStateChange;
      return client;
    },
    localization: {
      formatValues(messages) {
        return messages.map(message => message.id);
      },
      async formatValue(id) {
        return id;
      },
    },
  });
  provider.setEnabled(true);
  registerCleanupFunction(async () => {
    await provider.destroy();
    prefs.deleteBranch("");
  });
  return { provider, client };
}

function queueUnrelatedPINDialog() {
  let args = Cc["@mozilla.org/hash-property-bag;1"].createInstance(
    Ci.nsIWritablePropertyBag
  );
  args.setProperty("async", true);
  args.setProperty("title", "Unrelated test dialog");
  args.setProperty("text", "Unrelated test prompt");
  args.setProperty("pin", null);
  let opened = BrowserTestUtils.promiseAlertDialogOpen(null, PIN_DIALOG_URI, {
    isSubDialog: true,
  });
  let closed = window.gDialogBox.open(PIN_DIALOG_URI, args);
  return { args, opened, closed };
}

async function closeUnrelatedPINDialog(pending) {
  let dialogWindow = await pending.opened;
  if (!dialogWindow.closed) {
    dialogWindow.document.querySelector("dialog")?.cancelDialog();
  }
  await pending.closed;
}

add_task(async function test_icloud_pin_dialog() {
  await SpecialPowers.pushPrefEnv({
    set: [["waterfox.passwords.icloud.enabled", true]],
  });
  let pairingCalls = 0;
  const client = {
    supported: true,
    state: "disconnected",
    get isReady() {
      return this.state === "ready";
    },
    async connect() {
      this.state = "locked";
    },
    async beginPairing() {
      this.state = "pairing";
    },
    async completePairing(pin) {
      pairingCalls++;
      Assert.strictEqual(
        pin === "012345",
        true,
        "Pairing preserves the leading zero"
      );
      this.state = "ready";
    },
    async lock() {
      this.state = "locked";
    },
  };
  const provider = new ICloudPasswordsService({ client, platform: "macosx" });
  let dialogWindow;
  registerCleanupFunction(async () => {
    if (dialogWindow && !dialogWindow.closed) {
      dialogWindow.document.querySelector("dialog")?.cancelDialog();
    }
    await provider.destroy();
  });

  let opened = BrowserTestUtils.promiseAlertDialogOpen(null, PIN_DIALOG_URI, {
    isSubDialog: true,
  });
  let unlocking = provider.unlock(gBrowser.selectedBrowser);
  dialogWindow = await opened;
  await dialogWindow.document.mozSubdialogReady;
  await SimpleTest.promiseFocus(dialogWindow);
  let input = dialogWindow.document.getElementById("pin");
  let args = dialogWindow.arguments[0].QueryInterface(
    Ci.nsIWritablePropertyBag
  );
  Assert.equal(input.type, "text", "The PIN is readable rather than masked");
  Assert.equal(
    input.inputMode,
    "numeric",
    "The field requests a numeric keypad"
  );
  Assert.ok(input.labels[0].textContent, "The field has a visible label");
  Assert.equal(
    dialogWindow.document.activeElement,
    input,
    "The field has focus"
  );
  Assert.greater(
    parseFloat(dialogWindow.getComputedStyle(input).fontSize),
    parseFloat(dialogWindow.getComputedStyle(input.labels[0]).fontSize),
    "The code uses larger, readable text"
  );

  input.value = "01234x";
  EventUtils.synthesizeKey("KEY_Enter", {}, dialogWindow);
  Assert.equal(pairingCalls, 0, "Invalid input does not reach pairing");
  Assert.ok(
    !dialogWindow.document.getElementById("pin-error").hidden,
    "Invalid input leaves the dialog open with an explanation"
  );
  input.value = "012345";
  input.dispatchEvent(new dialogWindow.Event("input", { bubbles: true }));
  dialogWindow.document.addEventListener(
    "dialogaccept",
    () => Assert.ok(!input.value, "Acceptance clears the field"),
    { once: true }
  );
  EventUtils.synthesizeKey("KEY_Enter", {}, dialogWindow);
  Assert.ok(await unlocking, "Enter accepts the valid code");
  Assert.equal(pairingCalls, 1, "Only the valid code reaches pairing");

  Assert.strictEqual(
    args.getProperty("pin") === null,
    true,
    "The temporary result is cleared"
  );

  await provider.lock();
  opened = BrowserTestUtils.promiseAlertDialogOpen(null, PIN_DIALOG_URI, {
    isSubDialog: true,
  });
  unlocking = provider.unlock(gBrowser.selectedBrowser);
  dialogWindow = await opened;
  await dialogWindow.document.mozSubdialogReady;
  await SimpleTest.promiseFocus(dialogWindow);
  input = dialogWindow.document.getElementById("pin");
  input.value = "012345";
  dialogWindow.document.addEventListener(
    "dialogcancel",
    () => Assert.ok(!input.value, "Cancellation clears the field"),
    { once: true }
  );
  EventUtils.synthesizeKey("KEY_Escape", {}, dialogWindow);
  Assert.ok(!(await unlocking), "Escape cancels unlocking");
  Assert.equal(pairingCalls, 1, "Cancellation does not submit a code");
});

add_task(async function test_pairing_expiry_closes_only_its_current_dialog() {
  let { provider, client } = createExpiryProvider("current");
  let opened = BrowserTestUtils.promiseAlertDialogOpen(null, PIN_DIALOG_URI, {
    isSubDialog: true,
  });
  let result = provider
    .verifySavedLogin(gBrowser.selectedBrowser, {
      origin: "https://login.example.com",
      username: "synthetic-user",
      password: "synthetic-test-value-not-a-real-credential",
    })
    .then(
      () => null,
      error => error
    );
  let dialogWindow = await opened;
  await dialogWindow.document.mozSubdialogReady;
  let dialog = window.gDialogBox.dialog;
  let input = dialogWindow.document.getElementById("pin");
  let args = dialogWindow.arguments[0].QueryInterface(
    Ci.nsIWritablePropertyBag
  );
  input.value = "123";
  let unrelated = queueUnrelatedPINDialog();
  registerCleanupFunction(async () => {
    await provider.destroy();
    await closeUnrelatedPINDialog(unrelated);
  });

  client.setState("locked", "timeout");
  Assert.ok(!input.value, "Expiry immediately clears the partial PIN input");
  Assert.strictEqual(
    args.getProperty("pin"),
    null,
    "Expiry clears the result bag"
  );
  let error = await result;
  Assert.equal(
    error?.code,
    "timeout",
    "Read-only verification settles on expiry"
  );
  Assert.equal(error?.message, "icloud-passwords-error-timeout");
  Assert.equal(
    provider.lastErrorCode,
    "timeout",
    "Expiry is not manual cancellation"
  );
  Assert.equal(
    client.pairingCalls,
    1,
    "Expiry does not start another challenge"
  );

  let unrelatedWindow = await unrelated.opened;
  await unrelatedWindow.document.mozSubdialogReady;
  let unrelatedDialog = window.gDialogBox.dialog;
  Assert.notEqual(unrelatedDialog, dialog);
  Assert.equal(
    unrelatedWindow.arguments[0].QueryInterface(Ci.nsIWritablePropertyBag),
    unrelated.args,
    "The next dialog belongs to a different request, even at the same URI"
  );
  await provider.lock();
  await provider.destroy();
  Assert.equal(
    window.gDialogBox.dialog,
    unrelatedDialog,
    "Later provider cleanup must not abort the unrelated dialog"
  );
  await closeUnrelatedPINDialog(unrelated);
  Assert.ok(!window.gDialogBox.isOpen);
});

add_task(async function test_pin_expiry_while_its_dialog_is_being_created() {
  let { provider, client } = createExpiryProvider("opening");
  let dialogBox = window.gDialogBox;
  let open = dialogBox.open;
  let closed = BrowserTestUtils.waitForEvent(
    document.getElementById("window-modal-dialog"),
    "close"
  );
  dialogBox.open = function (uri, args) {
    let result = open.call(this, uri, args);
    client.setState("locked", "timeout");
    return result;
  };
  try {
    await Assert.rejects(
      provider.unlock(gBrowser.selectedBrowser),
      error => error.code === "timeout",
      "Expiry during the synchronous open call retains its native timeout"
    );
    await closed;
    await TestUtils.waitForTick();
    Assert.ok(!dialogBox.isOpen, "The loading dialog is also closed");
    Assert.equal(dialogBox._queued.length, 0);
    Assert.equal(
      client.pairingCalls,
      1,
      "No code submission or automatic retry"
    );
  } finally {
    dialogBox.open = open;
    await provider.destroy();
  }
});

add_task(async function test_waiting_pin_opens_only_when_the_host_is_free() {
  let blocker = queueUnrelatedPINDialog();
  let blockerWindow = await blocker.opened;
  await blockerWindow.document.mozSubdialogReady;
  let { provider, client } = createExpiryProvider("waiting");
  registerCleanupFunction(async () => {
    await provider.destroy();
    await closeUnrelatedPINDialog(blocker);
  });
  let unlocking = provider.unlock(gBrowser.selectedBrowser);
  await TestUtils.waitForTick();
  Assert.equal(client.state, "pairing");
  let opened = BrowserTestUtils.promiseAlertDialogOpen(null, PIN_DIALOG_URI, {
    isSubDialog: true,
  });
  await closeUnrelatedPINDialog(blocker);
  let dialogWindow = await opened;
  await dialogWindow.document.mozSubdialogReady;
  dialogWindow.document.querySelector("dialog").cancelDialog();
  Assert.strictEqual(
    await unlocking,
    false,
    "A waiting prompt still cancels normally"
  );
  Assert.equal(provider.lastErrorCode, "cancelled");
  Assert.equal(client.pairingCalls, 1);
  Assert.ok(!window.gDialogBox.isOpen);
});

add_task(async function test_queued_pin_expiry_never_opens_an_orphan() {
  let blocker = queueUnrelatedPINDialog();
  let blockerWindow = await blocker.opened;
  await blockerWindow.document.mozSubdialogReady;
  let blockerDialog = window.gDialogBox.dialog;
  let input = blockerWindow.document.getElementById("pin");
  input.value = "987";
  let next = queueUnrelatedPINDialog();
  let { provider, client } = createExpiryProvider("queued");
  registerCleanupFunction(async () => {
    await provider.destroy();
    await closeUnrelatedPINDialog(blocker);
    await closeUnrelatedPINDialog(next);
  });
  let result = provider.unlock(gBrowser.selectedBrowser).then(
    () => null,
    error => error
  );
  await TestUtils.waitForTick();
  Assert.equal(
    client.state,
    "pairing",
    "The challenge is awaiting its own prompt"
  );
  client.setState("locked", "timeout");
  Assert.equal((await result)?.code, "timeout");
  Assert.equal(window.gDialogBox.dialog, blockerDialog);
  Assert.strictEqual(
    input.value,
    "987",
    "An unrelated dialog's input is untouched"
  );
  Assert.equal(window.gDialogBox._queued.length, 1);
  Assert.equal(
    window.gDialogBox._queued[0].args,
    next.args,
    "Only the unrelated queued request remains"
  );

  await closeUnrelatedPINDialog(blocker);
  let nextWindow = await next.opened;
  await nextWindow.document.mozSubdialogReady;
  Assert.equal(
    nextWindow.arguments[0].QueryInterface(Ci.nsIWritablePropertyBag),
    next.args,
    "Expiry preserves the unrelated queued dialog"
  );
  await closeUnrelatedPINDialog(next);
  await TestUtils.waitForTick();
  Assert.ok(
    !window.gDialogBox.isOpen,
    "The expired PIN prompt never opens later"
  );
  Assert.equal(window.gDialogBox._queued.length, 0);
  Assert.equal(client.pairingCalls, 1, "There is no automatic re-pairing");
});
