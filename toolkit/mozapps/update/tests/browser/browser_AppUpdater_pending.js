/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  AppUpdater: "resource://gre/modules/AppUpdater.sys.mjs",
  sinon: "resource://testing-common/Sinon.sys.mjs",
});

async function withPendingUpdater(task) {
  const sandbox = sinon.createSandbox();
  let transition = Promise.withResolvers();
  const aus = {
    disabled: false,
    currentState: Ci.nsIApplicationUpdateService.STATE_PENDING,
    getStateName: state => String(state),
    get stateTransition() {
      return transition.promise;
    },
  };
  const um = { getReadyUpdate: sandbox.stub() };
  const makeUpdate = () => ({
    QueryInterface: ChromeUtils.generateQI(["nsIWritablePropertyBag"]),
    setProperty: sandbox.spy(),
  });
  const fixture = {
    um,
    lookups: [Promise.withResolvers(), Promise.withResolvers()],
    original: makeUpdate(),
    replacement: makeUpdate(),
    checkSettled: false,
    transitionTo(state) {
      if (aus.currentState == state) {
        return;
      }
      aus.currentState = state;
      const previous = transition;
      transition = Promise.withResolvers();
      previous.resolve();
    },
  };
  um.getReadyUpdate.onFirstCall().returns(fixture.lookups[0].promise);
  um.getReadyUpdate.onSecondCall().returns(fixture.lookups[1].promise);

  try {
    sandbox.stub(AppUpdater.prototype, "aus").get(() => aus);
    sandbox.stub(AppUpdater.prototype, "um").get(() => um);
    sandbox.stub(AppUpdater.prototype, "checker").get(() => {
      throw new Error("A pending update must not start a network check");
    });
    fixture.updater = new AppUpdater();
    fixture.check = fixture.updater.check({ checkOnly: true }).then(() => {
      fixture.checkSettled = true;
    });
    await task(fixture);
    Assert.ok(
      fixture.original.setProperty.notCalled,
      "Never assign stale metadata"
    );
  } finally {
    fixture.updater?.stop();
    for (const lookup of fixture.lookups) {
      lookup.resolve(null);
    }
    fixture.transitionTo(Ci.nsIApplicationUpdateService.STATE_IDLE);
    try {
      await fixture.check;
    } finally {
      sandbox.restore();
    }
  }
}

add_task(async function pending_check_can_stop() {
  for (const duringSwap of [false, true]) {
    info(`Stopping during ${duringSwap ? "swap" : "metadata lookup"}`);
    await withPendingUpdater(async fixture => {
      if (duringSwap) {
        fixture.transitionTo(Ci.nsIApplicationUpdateService.STATE_SWAP);
        fixture.lookups[0].resolve(fixture.original);
        await TestUtils.waitForTick();
      }

      fixture.updater.stop();
      await TestUtils.waitForTick();
      Assert.ok(
        fixture.checkSettled,
        "Stop completes without waiting for metadata or a transition"
      );
      Assert.equal(fixture.updater.status, AppUpdater.STATUS.NEVER_CHECKED);

      fixture.transitionTo(Ci.nsIApplicationUpdateService.STATE_PENDING);
      fixture.lookups[0].resolve(fixture.original);
      fixture.lookups[1].resolve(fixture.replacement);
      await TestUtils.waitForTick();
      Assert.strictEqual(
        fixture.updater.update,
        null,
        "Late results stay ignored"
      );
      Assert.equal(fixture.updater.status, AppUpdater.STATUS.NEVER_CHECKED);
    });
  }
});

add_task(async function pending_metadata_refetched_after_swap() {
  for (const swapFinished of [false, true]) {
    info(
      `Metadata lookup resumes ${swapFinished ? "after" : "during"} the swap`
    );
    await withPendingUpdater(async fixture => {
      fixture.transitionTo(Ci.nsIApplicationUpdateService.STATE_SWAP);
      if (swapFinished) {
        fixture.transitionTo(Ci.nsIApplicationUpdateService.STATE_PENDING);
      }
      fixture.lookups[0].resolve(fixture.original);
      await TestUtils.waitForTick();

      if (!swapFinished) {
        Assert.ok(!fixture.checkSettled, "Wait for the swap to finish");
        Assert.equal(
          fixture.um.getReadyUpdate.callCount,
          1,
          "No lookup during SWAP"
        );
        fixture.transitionTo(Ci.nsIApplicationUpdateService.STATE_PENDING);
        await TestUtils.waitForTick();
      }

      Assert.equal(
        fixture.um.getReadyUpdate.callCount,
        2,
        "Refetch after the swap"
      );
      Assert.strictEqual(
        fixture.updater.update,
        null,
        "Do not assign stale metadata"
      );
      Assert.equal(fixture.updater.status, AppUpdater.STATUS.NEVER_CHECKED);
      Assert.ok(!fixture.checkSettled, "Wait for replacement metadata");

      fixture.lookups[1].resolve(fixture.replacement);
      await TestUtils.waitForTick();
      Assert.ok(
        fixture.checkSettled,
        "Check completes with replacement metadata"
      );
      Assert.strictEqual(fixture.updater.update, fixture.replacement);
      Assert.equal(fixture.updater.status, AppUpdater.STATUS.READY_FOR_RESTART);
    });
  }
});
