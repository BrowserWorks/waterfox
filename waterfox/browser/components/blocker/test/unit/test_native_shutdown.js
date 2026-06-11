/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

const { NetUtil } = ChromeUtils.importESModule(
  "resource://gre/modules/NetUtil.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

add_task(
  async function test_pending_work_drains_and_repeated_shutdown_is_safe() {
    do_get_profile();
    Services.prefs.setBoolPref("waterfox.blocker.enabled", true);
    const engine = Cc["@waterfox.com/waterfox-blocker-engine;1"].createInstance(
      Ci.nsIWaterfoxBlockerEngine
    );
    engine.initFromLists(["||ads.example^$important"]);
    engine.useResources("[]");
    engine.publish();
    engine.setNetworkBridge({
      QueryInterface: ChromeUtils.generateQI([
        "nsIContentClassifierAdBlockingBridge",
      ]),
      onAdBlockingAction() {
        Assert.ok(false, "Shutdown cannot apply or count an ad action");
      },
      filterAdBlockingResponse() {},
    });
    const principal = Services.scriptSecurityManager.createContentPrincipal(
      Services.io.newURI("https://publisher.example/"),
      {}
    );
    const channel = NetUtil.newChannel({
      uri: "https://ads.example/ad.js",
      loadingPrincipal: principal,
      triggeringPrincipal: principal,
      securityFlags: Ci.nsILoadInfo.SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL,
      contentPolicyType: Ci.nsIContentPolicy.TYPE_SCRIPT,
    }).QueryInterface(Ci.nsIHttpChannel);
    const request = engine.captureNativeLoad(
      channel.URI,
      channel.loadInfo,
      channel,
      engine.REQUEST
    );
    Assert.equal(JSON.parse(request.checkRequestDetailed()).matched, true);
    const calls = new Map();
    const pending = [];
    for (let i = 0; i < 20; ++i) {
      pending.push(
        new Promise(resolve =>
          request.checkRequestDetailedAsync((status, json) => {
            calls.set(i, (calls.get(i) || 0) + 1);
            Assert.equal(
              status,
              Cr.NS_ERROR_ABORT,
              "Pending results are invalidated by shutdown"
            );
            Assert.equal(json, "");
            resolve();
          })
        )
      );
    }
    let channelCalls = 0;
    pending.push(
      new Promise(resolve =>
        engine.checkChannel(channel, status => {
          Assert.equal(
            status,
            Cr.NS_OK,
            "Accepted channel callbacks complete during shutdown"
          );
          channelCalls++;
          resolve();
        })
      )
    );
    const blocker = engine.classifierService.QueryInterface(
      Ci.nsIAsyncShutdownBlocker
    );
    blocker.blockShutdown(null);
    blocker.blockShutdown(null);
    pending.push(
      new Promise(resolve =>
        request.checkRequestDetailedAsync((status, json) => {
          Assert.equal(
            status,
            Cr.NS_ERROR_NOT_AVAILABLE,
            "Shutdown closes the scheduling window"
          );
          Assert.equal(json, "");
          resolve();
        })
      )
    );
    await Promise.all(pending);
    await TestUtils.waitForCondition(
      () =>
        blocker.state
          .QueryInterface(Ci.nsIPropertyBag2)
          .getPropertyAsUint32("pendingQueues") === 0,
      "Both native queues drain before the shutdown blocker finishes"
    );
    Assert.equal(channelCalls, 1);
    Assert.equal(
      channel.status,
      Cr.NS_OK,
      "A stale channel result is not cancelled"
    );
    Assert.equal(request.isCurrent, false);
    Assert.equal(
      JSON.parse(request.checkRequestDetailed()).matched,
      true,
      "Retired engine references remain safe after queue shutdown"
    );
    Assert.equal(calls.size, 20);
    for (const count of calls.values()) {
      Assert.equal(count, 1);
    }
    Assert.equal(engine.classifierService, null);
    engine.setNetworkBridge(null);
  }
);
