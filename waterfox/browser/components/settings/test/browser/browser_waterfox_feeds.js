/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { LiveBookmarks } = ChromeUtils.importESModule(
  "resource:///modules/LiveBookmarks.sys.mjs"
);
const { MockFilePicker } = ChromeUtils.importESModule(
  "resource://testing-common/MockFilePicker.sys.mjs"
);
const { PromptTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PromptTestUtils.sys.mjs"
);
const { sinon } = ChromeUtils.importESModule(
  "resource://testing-common/Sinon.sys.mjs"
);

const DISCOVERY_PREF = "browser.feeds.discovery.enabled";
const PREVIEW_PREF = "browser.feeds.preview.enabled";
const LOAD_IMAGES_PREF = "browser.feeds.loadImages";

async function getFeedsControl(doc, id, tag) {
  await settingGroupRenders(doc, "waterfoxFeeds");
  const selector = `#setting-control-${id} ${tag}`;
  await TestUtils.waitForCondition(
    () => doc.querySelector(selector),
    `The ${id} control renders`
  );
  const control = doc.querySelector(selector);
  await control.updateComplete;
  return control;
}

async function withFeedsOPML(task) {
  const sandbox = sinon.createSandbox();
  const init = sandbox.stub(LiveBookmarks, "init").resolves();
  const file = Services.dirsvc.get("TmpD", Ci.nsIFile);
  file.append("waterfox-feeds-settings.opml");
  file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, 0o600);
  MockFilePicker.init(window.browsingContext);
  let tab;
  try {
    await IOUtils.writeUTF8(
      file.path,
      '<opml version="2.0"><body><outline xmlUrl="https://example.com/feed.xml"/></body></opml>'
    );
    MockFilePicker.setFiles([file]);
    tab = await openPrefsTab("feeds");
    const doc = tab.linkedBrowser.contentDocument;
    await settingGroupRenders(doc, "waterfoxFeedsOPML");
    const importButton = await getFeedsControl(
      doc,
      "waterfox-feeds-import",
      "moz-button"
    );
    const exportButton = await getFeedsControl(
      doc,
      "waterfox-feeds-export",
      "moz-button"
    );
    const status = () =>
      doc.querySelector(
        "#setting-control-waterfox-feeds-opml-status moz-message-bar"
      );
    const idle = () => !importButton.disabled && !exportButton.disabled;
    const waitForStatus = async id => {
      await TestUtils.waitForCondition(
        () => idle() && status()?.getAttribute("data-l10n-id") === id,
        `The OPML operation finishes with ${id}`
      );
      return status();
    };
    await task({
      sandbox,
      init,
      doc,
      importButton,
      exportButton,
      status,
      idle,
      waitForStatus,
    });
  } finally {
    MockFilePicker.cleanup();
    sandbox.restore();
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await IOUtils.remove(file.path);
  }
}

add_task(async function test_feeds_navigation_and_open() {
  for (const redesignEnabled of [true, false]) {
    await SpecialPowers.pushPrefEnv({
      set: [
        ["browser.settings-redesign.enabled", redesignEnabled],
        [DISCOVERY_PREF, false],
      ],
    });
    let tab;
    let feedsTab;
    try {
      tab = await openPrefsTab("feeds");
      const doc = tab.linkedBrowser.contentDocument;
      const win = doc.defaultView;
      const navButton = doc.getElementById("category-feeds");
      ok(
        BrowserTestUtils.isVisible(navButton),
        `The Feeds category is visible with redesign ${redesignEnabled}`
      );
      await getFeedsControl(doc, "waterfox-feeds-discovery", "moz-toggle");
      const pane = doc.querySelector('setting-pane[data-category="paneFeeds"]');
      ok(
        BrowserTestUtils.isVisible(pane),
        "The #feeds deep link opens the pane"
      );

      await win.gotoPref("home");
      ok(!BrowserTestUtils.isVisible(pane), "Navigating away hides the pane");
      EventUtils.synthesizeMouseAtCenter(navButton, {}, win);
      await TestUtils.waitForCondition(
        () => BrowserTestUtils.isVisible(pane),
        "Clicking the Feeds category opens the pane"
      );
      is(win.location.hash, "#feeds", "Navigation uses the Feeds deep link");

      const link = await getFeedsControl(
        doc,
        "waterfox-feeds-open",
        "moz-box-link"
      );
      ok(BrowserTestUtils.isVisible(link), "Open Feeds remains available");
      const opened = BrowserTestUtils.waitForNewTab(
        gBrowser,
        "about:feeds",
        true
      );
      link.focus();
      EventUtils.synthesizeKey("KEY_Enter", {}, win);
      feedsTab = await opened;
      is(
        tab.linkedBrowser.currentURI.spec,
        "about:preferences#feeds",
        "Opening Feeds leaves the Settings tab open"
      );
      ok(
        !Services.prefs.getBoolPref(DISCOVERY_PREF),
        "Opening Feeds does not enable discovery"
      );
    } finally {
      if (feedsTab) {
        BrowserTestUtils.removeTab(feedsTab);
      }
      if (tab) {
        BrowserTestUtils.removeTab(tab);
      }
      await SpecialPowers.popPrefEnv();
    }
  }
});

add_task(
  async function test_opml_picker_and_review_cancellation_preserve_status() {
    await withFeedsOPML(
      async ({
        sandbox,
        init,
        doc,
        importButton,
        exportButton,
        status,
        idle,
        waitForStatus,
      }) => {
        let shown = Promise.withResolvers();
        const checkPicker = async () => {
          await TestUtils.waitForCondition(
            () => importButton.disabled && exportButton.disabled,
            "Both operations are disabled while the picker is open"
          );
          synthesizeClick(exportButton);
        };
        MockFilePicker.returnValue = Ci.nsIFilePicker.returnCancel;
        MockFilePicker.showCallback = async () => {
          try {
            await checkPicker();
            ok(
              !status() || !BrowserTestUtils.isVisible(status()),
              "The picker does not show working feedback"
            );
            ok(
              init.notCalled,
              "Canceling the picker does not initialize the service"
            );
            shown.resolve();
          } catch (error) {
            shown.reject(error);
          }
        };
        synthesizeClick(importButton);
        await shown.promise;
        await TestUtils.waitForCondition(
          idle,
          "Canceling the picker enables both operations"
        );
        ok(
          !status() || !BrowserTestUtils.isVisible(status()),
          "Canceling does not create a status message"
        );

        const plan = { newCount: 1, duplicateCount: 0 };
        sandbox.stub(LiveBookmarks, "planOPML").resolves(plan);
        const imported = Promise.withResolvers();
        const commit = sandbox
          .stub(LiveBookmarks, "importOPML")
          .returns(imported.promise);
        const accepted = PromptTestUtils.handleNextPrompt(
          gBrowser.selectedBrowser,
          { modalType: Services.prompt.MODAL_TYPE_CONTENT },
          { buttonNumClick: 0 }
        );
        MockFilePicker.showCallback = null;
        MockFilePicker.returnValue = Ci.nsIFilePicker.returnOK;
        synthesizeClick(importButton);
        await accepted;
        await TestUtils.waitForCondition(
          () => commit.calledOnce,
          "The reviewed import starts"
        );
        is(
          status()?.getAttribute("data-l10n-id"),
          "waterfox-feeds-status-working",
          "The actual import shows working feedback"
        );
        imported.resolve(1);
        await waitForStatus("waterfox-feeds-status-import");

        shown = Promise.withResolvers();
        MockFilePicker.returnValue = Ci.nsIFilePicker.returnCancel;
        MockFilePicker.showCallback = async () => {
          try {
            await checkPicker();
            is(
              status()?.getAttribute("data-l10n-id"),
              "waterfox-feeds-status-import",
              "Opening the next picker keeps the previous status"
            );
            is(
              init.callCount,
              1,
              "A pending picker does not start another operation"
            );
            shown.resolve();
          } catch (error) {
            shown.reject(error);
          }
        };
        synthesizeClick(exportButton);
        await shown.promise;
        await TestUtils.waitForCondition(
          idle,
          "Canceling the next picker enables both operations"
        );
        is(
          doc.l10n.getAttributes(status()).args.count,
          1,
          "Picker cancellation retains the previous status arguments"
        );

        MockFilePicker.showCallback = null;
        MockFilePicker.returnValue = Ci.nsIFilePicker.returnOK;
        const canceled = PromptTestUtils.handleNextPrompt(
          gBrowser.selectedBrowser,
          { modalType: Services.prompt.MODAL_TYPE_CONTENT },
          { buttonNumClick: 1 }
        );
        synthesizeClick(importButton);
        await canceled;
        const restored = await waitForStatus("waterfox-feeds-status-import");
        is(
          doc.l10n.getAttributes(restored).args.count,
          1,
          "Review cancellation restores the previous status arguments"
        );
        is(
          restored.getAttribute("type"),
          "success",
          "Review cancellation retains the previous status type"
        );
        ok(
          commit.calledOnceWithExactly(plan),
          "Canceling the review does not import again"
        );
      }
    );
  }
);

add_task(async function test_opml_errors_explain_the_failure_safely() {
  await withFeedsOPML(
    async ({
      sandbox,
      doc,
      importButton,
      exportButton,
      status,
      waitForStatus,
    }) => {
      const logged = sandbox.stub(doc.defaultView.console, "error");
      const capacity = new Error("Subscription limit reached");
      capacity.code = "SUBSCRIPTION_LIMIT";
      capacity.limit = 200;
      const plan = sandbox.stub(LiveBookmarks, "planOPML").rejects(capacity);
      MockFilePicker.returnValue = Ci.nsIFilePicker.returnOK;
      synthesizeClick(importButton);
      const limited = await waitForStatus(
        "waterfox-feeds-error-subscription-limit"
      );
      is(
        doc.l10n.getAttributes(limited).args.limit,
        200,
        "Capacity errors use the service limit in a localized message"
      );
      ok(
        logged.notCalled,
        "An expected capacity error is not logged as an unexpected failure"
      );

      const message =
        'Invalid OPML: <span data-opml-error="injected">missing feed URL</span>';
      plan.rejects(new Error(message));
      synthesizeClick(importButton);
      const failedImport = await waitForStatus(
        "waterfox-feeds-error-import-details"
      );
      is(
        doc.l10n.getAttributes(failedImport).args.message,
        message,
        "The underlying import error is passed as a Fluent argument"
      );
      await doc.l10n.translateElements([failedImport]);
      await failedImport.updateComplete;
      ok(
        failedImport.getAttribute("message").includes(message),
        "The visible message includes the underlying error text"
      );
      ok(
        !failedImport.querySelector("[data-opml-error]") &&
          !failedImport.shadowRoot.querySelector("[data-opml-error]"),
        "Error details are not interpreted as markup"
      );

      const exportMessage = "The destination is not writable";
      const exporting = Promise.withResolvers();
      const exportOPML = sandbox
        .stub(LiveBookmarks, "exportOPML")
        .returns(exporting.promise);
      synthesizeClick(exportButton);
      try {
        await TestUtils.waitForCondition(
          () =>
            exportOPML.calledOnce &&
            status()?.getAttribute("data-l10n-id") ===
              "waterfox-feeds-status-working",
          "The export starts with working feedback"
        );
        const working = status();
        Assert.deepEqual(
          doc.l10n.getAttributes(working).args,
          {},
          "Working feedback clears the previous error arguments"
        );
        await doc.l10n.translateElements([working]);
      } finally {
        exporting.reject(new Error(exportMessage));
      }
      const failedExport = await waitForStatus(
        "waterfox-feeds-error-export-details"
      );
      is(
        doc.l10n.getAttributes(failedExport).args.message,
        exportMessage,
        "The underlying export error is also shown"
      );
    }
  );
});

add_task(async function test_feeds_toggle_bindings() {
  const cases = [
    [DISCOVERY_PREF, "waterfox-feeds-discovery", true],
    ["browser.feeds.menu.enabled", "waterfox-feeds-menu", true],
    [PREVIEW_PREF, "waterfox-feeds-preview", true],
    [LOAD_IMAGES_PREF, "waterfox-feeds-load-images", false],
  ];
  await SpecialPowers.pushPrefEnv({
    set: cases.map(([pref, , initial]) => [pref, initial]),
  });
  let tab;
  try {
    tab = await openPrefsTab("feeds");
    const doc = tab.linkedBrowser.contentDocument;
    await settingGroupRenders(doc, "waterfoxFeedsSubscribe");
    for (const [pref, id, initial] of cases) {
      const toggle = await getFeedsControl(doc, id, "moz-toggle");
      ok(BrowserTestUtils.isVisible(toggle), `${id} is visible`);
      is(toggle.pressed, initial, `${id} reflects the initial preference`);

      const prefChanged = TestUtils.waitForPrefChange(pref);
      synthesizeClick(toggle);
      await prefChanged;
      is(
        Services.prefs.getBoolPref(pref),
        !initial,
        `${id} writes the preference`
      );
      await TestUtils.waitForCondition(
        () => toggle.pressed === !initial,
        `${id} reflects the click`
      );

      Services.prefs.setBoolPref(pref, initial);
      await TestUtils.waitForCondition(
        () => toggle.pressed === initial,
        `${id} follows external preference changes`
      );
    }
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});
