/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const ICLOUD_TEST_ORIGIN = "https://example.com";
const ICLOUD_TEST_PAGE =
  ICLOUD_TEST_ORIGIN +
  "/browser/toolkit/components/passwordmgr/test/browser/form_basic.html";

async function withICloudActorTest(task) {
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  const { ICloudPasswords } = ChromeUtils.importESModule(
    "resource:///modules/ICloudPasswords.sys.mjs"
  );
  const { ICloudPasswordsPrompter } = ChromeUtils.importESModule(
    "resource:///modules/ICloudPasswordsPrompter.sys.mjs"
  );

  const sandbox = sinon.createSandbox();
  const account = {
    username: "icloud-smoke-user",
    sites: [ICLOUD_TEST_ORIGIN],
  };
  const credential = { ...account, password: "icloud-smoke-password" };
  sandbox.stub(ICloudPasswords, "supported").get(() => true);
  let ready = true;
  sandbox
    .stub(ICloudPasswords, "isReady")
    .get(() => ready && ICloudPasswords.enabled);
  sandbox.stub(ICloudPasswords, "unlock").resolves(false);
  sandbox.stub(ICloudPasswords, "listAccounts").resolves([account]);
  sandbox.stub(ICloudPasswords, "getPassword").resolves(credential);
  const otpAccount = {
    username: account.username,
    domain: "Example Issuer",
    source: "totp",
  };
  sandbox.stub(ICloudPasswords, "listOneTimeCodes").resolves([otpAccount]);
  sandbox.stub(ICloudPasswords, "getOneTimeCode").resolves({ code: "123456" });
  sandbox
    .stub(ICloudPasswords, "saveLogin")
    .resolves({ accepted: true, verified: false });
  sandbox.stub(ICloudPasswords, "verifySavedLogin").resolves(true);
  const prompts = sandbox.spy(ICloudPasswordsPrompter, "prompt");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["waterfox.passwords.icloud.enabled", true],
      ["waterfox.passwords.icloud.saveByDefault", true],
      ["waterfox.passwords.icloud.otp.enabled", true],
      ["signon.rememberSignons", true],
      ["signon.autofillForms", false],
      ["signon.suggestImportCount", 0],
      ["signon.showAutoCompleteFooter", true],
      ["signon.userInputRequiredToCapture.enabled", true],
      ["signon.testOnlyUserHasInteractedByPrefValue", false],
    ],
  });
  let tab;
  try {
    tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      ICLOUD_TEST_PAGE
    );
    const browser = tab.linkedBrowser;
    const actor =
      browser.browsingContext.currentWindowGlobal.getActor("LoginManager");
    const selections = sandbox.spy(actor, "onAutoCompleteEntrySelected");
    await SimpleTest.promiseFocus(window);
    await SpecialPowers.spawn(browser, [ICLOUD_TEST_PAGE], async page => {
      const doc = content.document;
      const child = content.windowGlobalChild.getActor("LoginManager");
      await ContentTaskUtils.waitForCondition(() =>
        child.isLoginManagerField(doc.getElementById("form-basic-username"))
      );
      const { LoginHelper } = ChromeUtils.importESModule(
        "resource://gre/modules/LoginHelper.sys.mjs"
      );
      is(
        LoginHelper.testOnlyUserHasInteractedWithDocument,
        null,
        "Capture uses real document interaction, not a test override"
      );
      const target = Object.assign(doc.createElement("iframe"), {
        name: "capture-target",
        hidden: true,
      });
      target.dataset.loads = "0";
      target.addEventListener("load", () => target.dataset.loads++);
      doc.body.append(target);
      doc.forms[0].target = target.name;
      doc.forms[0].action = page + "?submitted";
    });
    const windowEvents = sandbox.spy(window, "addEventListener");
    const tabEvents = sandbox.spy(gBrowser.tabContainer, "addEventListener");
    const removedWindowEvents = sandbox.spy(window, "removeEventListener");
    const removedTabEvents = sandbox.spy(
      gBrowser.tabContainer,
      "removeEventListener"
    );
    await task({
      browser,
      actor,
      sandbox,
      account,
      otpAccount,
      credential,
      provider: ICloudPasswords,
      prompter: ICloudPasswordsPrompter,
      prompts,
      selections,
      windowEvents,
      tabEvents,
      removedWindowEvents,
      removedTabEvents,
      setReady(value) {
        ready = value;
        Services.obs.notifyObservers(null, "icloud-passwords-state-changed");
      },
    });
  } finally {
    PopupNotifications.getNotification(
      "password",
      tab?.linkedBrowser
    )?.remove();
    PopupNotifications.panel.hidePopup();
    document.getElementById("PopupAutoComplete").hidePopup();
    if (tab) {
      await BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
    sandbox.restore();
  }
}

async function selectICloudTestRow(
  context,
  selector,
  predicate,
  { reusePopup = false } = {}
) {
  const { browser, selections, provider } = context;
  const passwordsBefore = provider.getPassword.callCount;
  const codesBefore = provider.getOneTimeCode.callCount;
  const popup = document.getElementById("PopupAutoComplete");
  if (!reusePopup) {
    if (popup.state !== "closed") {
      popup.hidePopup();
      await TestUtils.waitForCondition(() => popup.state === "closed");
    }
    await BrowserTestUtils.synthesizeMouseAtCenter(selector, {}, browser);
    await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
  }
  let index;
  await TestUtils.waitForCondition(() => {
    if (popup.state !== "open") {
      return false;
    }
    index = Array.from({ length: popup.view.matchCount }, (_, i) => i).find(i =>
      predicate(JSON.parse(popup.view.getCommentAt(i) || "{}"))
    );
    return index !== undefined;
  }, "The real autocomplete popup offers the requested row");
  for (
    let attempts = 0;
    popup.selectedIndex !== index && attempts <= popup.view.matchCount;
    attempts++
  ) {
    await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
  }
  is(
    popup.selectedIndex,
    index,
    "Keyboard selection reaches the requested row"
  );
  is(
    provider.getPassword.callCount,
    passwordsBefore,
    "Opening the popup does not retrieve a password"
  );
  is(
    provider.getOneTimeCode.callCount,
    codesBefore,
    "Opening the popup does not retrieve a code"
  );
  const row = JSON.parse(popup.view.getCommentAt(index) || "{}");
  if (row.fillMessageName === "PasswordManager:SelectICloudCredential") {
    Assert.deepEqual(
      Object.keys(row.fillMessageData),
      ["id"],
      "Provider rows expose only an opaque choice handle"
    );
  }
  const before = selections.callCount;
  const hidden = BrowserTestUtils.waitForEvent(popup, "popuphidden");
  EventUtils.synthesizeMouseAtCenter(
    popup.richlistbox.getItemAtIndex(index),
    {}
  );
  await TestUtils.waitForCondition(
    () => selections.callCount > before,
    "A trusted popup click invokes the provider selection"
  );
  await hidden;
  return { completion: selections.returnValues.at(-1) };
}

async function selectICloudTestCredential(
  context,
  selector = "#form-basic-username"
) {
  const { completion } = await selectICloudTestRow(
    context,
    selector,
    row => row.fillMessageName === "PasswordManager:SelectICloudCredential"
  );
  await completion;
  await SpecialPowers.spawn(
    context.browser,
    [context.credential],
    async expected => {
      await ContentTaskUtils.waitForCondition(
        () =>
          content.document.getElementById("form-basic-password").value ===
          expected.password
      );
    }
  );
}

async function typeICloudTestValue(browser, selector, value) {
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, {}, browser);
  await BrowserTestUtils.synthesizeKey("a", { accelKey: true }, browser);
  for (const key of value) {
    await BrowserTestUtils.synthesizeKey(key, {}, browser);
  }
  await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
}

async function submitICloudTestForm({ browser }) {
  const beforeLoad = await SpecialPowers.spawn(browser, [], () =>
    Number(content.document.querySelector("iframe").dataset.loads)
  );
  const captured = TestUtils.topicObserved(
    "passwordmgr-form-submission-detected",
    (_subject, origin) => origin === ICLOUD_TEST_ORIGIN
  );
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#form-basic-submit",
    {},
    browser
  );
  await captured;
  await SpecialPowers.spawn(browser, [beforeLoad], async previous => {
    await ContentTaskUtils.waitForCondition(
      () =>
        Number(content.document.querySelector("iframe").dataset.loads) >
        previous
    );
  });
}

async function showICloudTestSavePrompt(context) {
  const { browser, credential, prompter, sandbox } = context;
  const handle = prompter.prompt(browser, {
    origin: ICLOUD_TEST_ORIGIN,
    username: credential.username,
    password: credential.password,
  });
  const notification = PopupNotifications.getNotification("password", browser);
  const doorhanger = document.getElementById("password-notification");
  await TestUtils.waitForCondition(
    () =>
      PopupNotifications.panel.state === "open" &&
      doorhanger.notification === notification &&
      !doorhanger.button.disabled
  );
  const action = sandbox.spy(notification.mainAction, "callback");
  return { ...handle, notification, doorhanger, action };
}

async function clickICloudTestSaveAction({ doorhanger, action }) {
  const before = action.callCount;
  EventUtils.synthesizeMouseAtCenter(doorhanger.button, {});
  await TestUtils.waitForCondition(() => action.callCount > before);
  return { completion: action.returnValues.at(-1) };
}

async function reopenICloudTestPrompt({ doorhanger, notification }) {
  EventUtils.synthesizeMouseAtCenter(
    document.getElementById("password-notification-icon"),
    {}
  );
  await TestUtils.waitForCondition(
    () =>
      PopupNotifications.panel.state === "open" &&
      doorhanger.notification === notification
  );
}

function iCloudTestRefreshListener(context, type) {
  const calls = type === "activate" ? context.windowEvents : context.tabEvents;
  return calls.getCalls().findLast(call => call.args[0] === type).args[1];
}

// Mock trusted chrome events to avoid OS focus changes.
function mockICloudTestRefresh(context, type, target) {
  return iCloudTestRefreshListener(
    context,
    type
  )({
    type,
    isTrusted: true,
    target: target ?? (type === "activate" ? window : gBrowser.selectedTab),
  });
}

function checkICloudOTPOptions(provider, browsingContext, frameURLs) {
  const options = provider.listOneTimeCodes.lastCall.args[1];
  Assert.deepEqual(
    options,
    {
      frameURLs,
      tabId: browsingContext.top.id,
      frameId: browsingContext.parent ? browsingContext.id : 0,
    },
    "OTP context uses actual document URLs and browsing-context IDs"
  );
  ok(
    Object.isFrozen(options) && Object.isFrozen(options.frameURLs),
    "The OTP choice's request context is immutable"
  );
  return options;
}

async function createICloudOTPFrame(parent, url, name) {
  await SpecialPowers.spawn(parent, [url, name], async (src, frameName) => {
    const frame = Object.assign(content.document.createElement("iframe"), {
      src,
      name: frameName,
      width: "800",
      height: "400",
    });
    const loaded = new Promise(resolve =>
      frame.addEventListener("load", resolve, { once: true })
    );
    content.document.body.replaceChildren(frame);
    await loaded;
  });
  return BrowserTestUtils.getBrowsingContextFrom(parent).children.find(
    context => context.name === name
  );
}

async function prepareICloudOTPForm(browser) {
  await SpecialPowers.spawn(browser, [], () => {
    const doc = content.document;
    const form = doc.createElement("form");
    form.method = "post";
    form.action = content.location.origin + "/login/?mode=totpChallenge";
    form.autocomplete = "off";
    for (const [id, type] of [
      ["email", "email"],
      ["password", "password"],
      ["totpmfa", "text"],
    ]) {
      form.append(
        Object.assign(doc.createElement("input"), { id, name: id, type })
      );
    }
    doc.body.replaceChildren(form);
  });
}

add_task(async function test_unannotated_otp_trusted_focus_and_fill() {
  await withICloudActorTest(async context => {
    const { browser, provider } = context;
    await prepareICloudOTPForm(browser);
    const popup = document.getElementById("PopupAutoComplete");
    const passwordsBefore = provider.listAccounts.callCount;
    await BrowserTestUtils.synthesizeMouseAtCenter("#totpmfa", {}, browser);
    await TestUtils.waitForCondition(
      () => popup.state === "open" && popup.view.matchCount > 0,
      "Trusted focus opens OTP autocomplete without a field autocomplete attribute"
    );
    is(
      popup.view.matchCount,
      1,
      "Only the OTP provider row is offered, without password rows or a footer"
    );
    const options = checkICloudOTPOptions(provider, browser.browsingContext, [
      ICLOUD_TEST_PAGE,
    ]);
    const { completion } = await selectICloudTestRow(
      context,
      "#totpmfa",
      row => row.fillMessageName === "PasswordManager:SelectICloudCredential",
      { reusePopup: true }
    );
    await completion;
    ok(
      provider.getOneTimeCode.calledOnceWithExactly(
        ICLOUD_TEST_ORIGIN,
        context.otpAccount,
        browser,
        options
      ),
      "Selection forwards the exact raw issuer identity and the listing's context object"
    );
    await SpecialPowers.spawn(browser, [], async () => {
      const doc = content.document;
      const field = doc.getElementById("totpmfa");
      await ContentTaskUtils.waitForCondition(
        () => field.value === "123456",
        "The selected synthetic code fills the unannotated field"
      );
      ok(
        !field.hasAttribute("autocomplete"),
        "Filling does not add a field autocomplete attribute"
      );
      is(
        doc.forms[0].autocomplete,
        "off",
        "The page's form-level autocomplete choice is untouched"
      );
      is(
        doc.getElementById("email").value.length,
        0,
        "Code fill does not change the email field"
      );
      is(
        doc.getElementById("password").value.length,
        0,
        "Code fill does not change the password field"
      );
    });
    ok(
      provider.getOneTimeCode.calledOnce,
      "Explicit selection requests a code"
    );
    is(
      provider.listAccounts.callCount,
      passwordsBefore,
      "The code field never queries password accounts"
    );
    ok(
      !provider.getPassword.called && !provider.saveLogin.called,
      "Code fill never retrieves or saves a password"
    );
  });
});

add_task(async function test_otp_raw_issuer_choices_are_distinct_text() {
  await withICloudActorTest(async context => {
    const { browser, provider, setReady } = context;
    const page = ICLOUD_TEST_PAGE + "?otp-context=issuers#challenge";
    await SpecialPowers.spawn(browser, [page], url =>
      content.history.replaceState(null, "", url)
    );
    await TestUtils.waitForCondition(
      () =>
        browser.browsingContext.currentWindowGlobal.documentURI.spec === page
    );
    await prepareICloudOTPForm(browser);
    const accounts = [
      { ...context.otpAccount, domain: "Example Issuer One" },
      { ...context.otpAccount, domain: "Example Issuer Two <img src=x>" },
    ];
    provider.listOneTimeCodes.resolves(accounts);
    const l10n = new Localization(["browser/waterfox/icloud-provider.ftl"]);
    const popup = document.getElementById("PopupAutoComplete");
    await BrowserTestUtils.synthesizeMouseAtCenter("#totpmfa", {}, browser);
    await TestUtils.waitForCondition(
      () => popup.state === "open" && popup.view.matchCount === 2
    );
    const handles = Array.from(
      { length: popup.view.matchCount },
      (_, index) =>
        JSON.parse(popup.view.getCommentAt(index)).fillMessageData.id
    );
    is(
      new Set(handles).size,
      2,
      "Issuers sharing one username have distinct opaque choices"
    );
    for (const [index, account] of accounts.entries()) {
      const secondary = await l10n.formatValue(
        "icloud-passwords-code-issuer-label",
        { issuer: account.domain }
      );
      await TestUtils.waitForCondition(
        () =>
          popup.richlistbox.getItemAtIndex(index)?.querySelector(".line2-label")
            ?.textContent === secondary
      );
      const label = popup.richlistbox
        .getItemAtIndex(index)
        .querySelector(".line2-label");
      ok(
        label.textContent.includes(account.domain),
        "The localized secondary line retains the raw issuer label"
      );
      ok(
        !label.querySelector("img"),
        "Issuer markup is displayed as text, not inserted as HTML"
      );
    }
    for (const [index, account] of accounts.entries()) {
      const selected = await selectICloudTestRow(
        context,
        "#totpmfa",
        row => row.secondary?.includes(account.domain),
        { reusePopup: index === 0 }
      );
      const options = checkICloudOTPOptions(provider, browser.browsingContext, [
        page,
      ]);
      await selected.completion;
      ok(
        provider.getOneTimeCode.lastCall.calledWithExactly(
          ICLOUD_TEST_ORIGIN,
          account,
          browser,
          options
        ),
        "The selected issuer, not another entry with the same username, reaches the provider"
      );
      await SpecialPowers.spawn(browser, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => !!content.document.getElementById("totpmfa").value.length
        );
        content.document.getElementById("totpmfa").value = "";
      });
    }
    setReady(false);
    const genericLabel = await l10n.formatValue("icloud-passwords-code-label");
    const selected = await selectICloudTestRow(
      context,
      "#totpmfa",
      row => row.secondary === genericLabel
    );
    await selected.completion;
    ok(
      provider.unlock.calledOnce,
      "The locked OTP row retains its generic label and unlock action"
    );
    is(
      provider.getOneTimeCode.callCount,
      2,
      "Unlock cancellation never retrieves another code"
    );
    ok(
      !provider.getPassword.called,
      "Issuer choices never route to password retrieval"
    );
  });
});

add_task(async function test_otp_frame_context_is_parent_derived() {
  await withICloudActorTest(async context => {
    const { browser, provider, sandbox } = context;
    for (const foreignBoundary of [false, true]) {
      const root = browser.browsingContext;
      let parent = root;
      if (foreignBoundary) {
        parent = await createICloudOTPFrame(
          parent,
          ICLOUD_TEST_PAGE.replace("example.com", "example.org") +
            "?foreign=1#excluded",
          "otp-foreign"
        );
      }
      const parentURL = ICLOUD_TEST_PAGE + "?otp-parent=1#parent";
      const frameURL = ICLOUD_TEST_PAGE + "?otp-frame=1#challenge";
      parent = await createICloudOTPFrame(parent, parentURL, "otp-parent");
      const frame = await createICloudOTPFrame(parent, frameURL, "otp-frame");
      await prepareICloudOTPForm(frame);
      const actor = frame.currentWindowGlobal.getActor("LoginManager");
      const frameContext = {
        ...context,
        browser: frame,
        actor,
        selections: sandbox.spy(actor, "onAutoCompleteEntrySelected"),
      };
      const frameURLs = [frameURL, parentURL];
      if (!foreignBoundary) {
        frameURLs.push(ICLOUD_TEST_PAGE);
      }
      await actor.doAutocompleteSearch(ICLOUD_TEST_ORIGIN, {
        isOneTimeCode: true,
        actionOrigin: ICLOUD_TEST_ORIGIN,
        frameURLs: [ICLOUD_TEST_PAGE.replace("example.com", "example.org")],
        tabId: frame.id,
        frameId: root.id,
      });
      checkICloudOTPOptions(provider, frame, frameURLs);
      const selected = await selectICloudTestRow(
        frameContext,
        "#totpmfa",
        row => row.fillMessageName === "PasswordManager:SelectICloudCredential"
      );
      const options = checkICloudOTPOptions(provider, frame, frameURLs);
      await selected.completion;
      ok(
        provider.getOneTimeCode.lastCall.calledWithExactly(
          ICLOUD_TEST_ORIGIN,
          context.otpAccount,
          browser,
          options
        ),
        "Listing and retrieval share the same immutable, parent-derived frame context"
      );
      await SpecialPowers.spawn(frame, [], async () => {
        await ContentTaskUtils.waitForCondition(
          () => !!content.document.getElementById("totpmfa").value.length
        );
      });
      if (foreignBoundary) {
        ok(
          !options.frameURLs.includes(ICLOUD_TEST_PAGE),
          "Collection stops at the foreign parent rather than resuming at a same-origin top document"
        );
      }
      await SpecialPowers.spawn(browser, [], () =>
        content.document.body.replaceChildren()
      );
    }
    ok(
      !provider.getPassword.called,
      "Frame OTP selection never requests a password"
    );
  });
});

add_task(
  async function test_otp_rejects_non_https_document_with_inherited_principal() {
    await withICloudActorTest(async context => {
      const { browser, provider } = context;
      const frame = await createICloudOTPFrame(
        browser,
        "about:blank",
        "otp-inherited"
      );
      is(
        frame.currentWindowGlobal.documentPrincipal.originNoSuffix,
        ICLOUD_TEST_ORIGIN,
        "The negative fixture inherits a genuine HTTPS principal"
      );
      const actor = frame.currentWindowGlobal.getActor("LoginManager");
      const result = await actor.doAutocompleteSearch(ICLOUD_TEST_ORIGIN, {
        isOneTimeCode: true,
        actionOrigin: ICLOUD_TEST_ORIGIN,
        frameURLs: [ICLOUD_TEST_PAGE],
      });
      is(
        result.autocompleteItems.length,
        0,
        "An inherited principal cannot replace the actual non-HTTPS document URL"
      );
      ok(
        !provider.listOneTimeCodes.called,
        "Invalid document context is rejected before querying OTP metadata"
      );
    });
  }
);

add_task(async function test_otp_context_change_cancels_pending_fill() {
  await withICloudActorTest(async context => {
    const { browser, provider, sandbox } = context;
    const frameURL = ICLOUD_TEST_PAGE + "?otp-frame=context-change#challenge";
    const frame = await createICloudOTPFrame(browser, frameURL, "otp-frame");
    await prepareICloudOTPForm(frame);
    const actor = frame.currentWindowGlobal.getActor("LoginManager");
    const frameContext = {
      ...context,
      browser: frame,
      actor,
      selections: sandbox.spy(actor, "onAutoCompleteEntrySelected"),
    };
    let resolve;
    provider.getOneTimeCode.callsFake(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const selected = await selectICloudTestRow(
      frameContext,
      "#totpmfa",
      row => row.fillMessageName === "PasswordManager:SelectICloudCredential"
    );
    const options = checkICloudOTPOptions(provider, frame, [
      frameURL,
      ICLOUD_TEST_PAGE,
    ]);
    await TestUtils.waitForCondition(() => !!resolve);
    const changedURL = ICLOUD_TEST_PAGE + "?otp-parent=changed#new-context";
    await SpecialPowers.spawn(browser, [changedURL], url =>
      content.history.replaceState(null, "", url)
    );
    await TestUtils.waitForCondition(
      () =>
        browser.browsingContext.currentWindowGlobal.documentURI.spec ===
        changedURL
    );
    is(
      options.frameURLs[1],
      ICLOUD_TEST_PAGE,
      "Pending requests retain their original immutable context"
    );
    resolve({ code: "123456" });
    await selected.completion;
    await SpecialPowers.spawn(frame, [], () => {
      is(
        content.document.getElementById("totpmfa").value.length,
        0,
        "Changing a same-origin ancestor URL prevents delivery of the old request's code"
      );
    });
    ok(
      !provider.getPassword.called && !provider.saveLogin.called,
      "Cancelled OTP requests never become password operations"
    );
  });
});

add_task(async function test_otp_fallback_semantic_limits() {
  await withICloudActorTest(async context => {
    const { browser, provider } = context;
    await prepareICloudOTPForm(browser);
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      const child = content.windowGlobalChild.getActor("LoginManager");
      for (const [id, type, autocomplete, expected, name = id] of [
        ["otp", "tel", "", true],
        ["mfa-code", "number", "", true],
        ["totpCode", "text", "", true],
        ["otp-totp", "text", "off", true],
        ["unrelated", "text", "one-time-code", true],
        ["code", "text", "", false],
        ["pin", "text", "", false],
        ["coupon-code", "text", "", false],
        ["adoption", "text", "", false],
        ["otp-coupon", "text", "", false],
        ["totp", "email", "", false],
        ["totp", "password", "", false],
        ["totp", "text", "email", false],
        ["totp", "text", "username", false],

        ["totp", "text", "", false, "email"],
        ["totp", "text", "", false, "password"],
        ["totp", "text", "", false, "cc-csc"],
      ]) {
        const field = Object.assign(doc.createElement("input"), {
          id,
          name,
          type,
        });
        if (autocomplete) {
          field.autocomplete = autocomplete;
        }
        doc.forms[0].append(field);
        is(
          child.getAutoCompleteSearchOption(field, "").isOneTimeCode === true,
          expected,
          "Only strong OTP identifiers without competing field semantics use OTP search"
        );
        field.remove();
      }
      for (const [id, autocomplete] of [
        ["coupon-code", ""],
        ["mfa-username", "username"],
        ["totp-credit", "cc-csc"],
        ["totp-password", "current-password"],
      ]) {
        const field = Object.assign(doc.createElement("input"), {
          id,
          name: id,
        });
        if (autocomplete) {
          field.autocomplete = autocomplete;
        }
        doc.forms[0].append(field);
      }
    });
    for (const selector of [
      "#coupon-code",
      "#mfa-username",
      "#totp-credit",
      "#totp-password",
    ]) {
      await BrowserTestUtils.synthesizeMouseAtCenter(selector, {}, browser);
      await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
      await BrowserTestUtils.synthesizeKey("KEY_Tab", {}, browser);
      document.getElementById("PopupAutoComplete").hidePopup();
    }
    ok(
      !provider.listOneTimeCodes.called && !provider.getOneTimeCode.called,
      "Trusted focus on coupon and conflicting autocomplete fields does not request OTPs"
    );
  });
});

add_task(async function test_otp_fallback_revalidates_delayed_fill() {
  await withICloudActorTest(async context => {
    const { browser, provider } = context;
    await prepareICloudOTPForm(browser);
    for (const mutation of [
      "readonly",
      "disabled",
      "semantic",
      "identifier",
      "insecure-action",
      "action",
      "focus",
    ]) {
      let resolve;
      provider.getOneTimeCode.callsFake(
        () =>
          new Promise(done => {
            resolve = done;
          })
      );
      const { completion } = await selectICloudTestRow(
        context,
        "#totpmfa",
        row => row.fillMessageName === "PasswordManager:SelectICloudCredential"
      );
      await TestUtils.waitForCondition(
        () => !!resolve,
        "The selected code request is pending"
      );
      await SpecialPowers.spawn(browser, [mutation], change => {
        const doc = content.document;
        const field = doc.getElementById("totpmfa");
        switch (change) {
          case "readonly":
            field.readOnly = true;
            break;
          case "disabled":
            field.disabled = true;
            break;
          case "semantic":
            field.autocomplete = "username";
            break;
          case "identifier":
            field.id = field.name = "code";
            break;
          case "insecure-action":
            doc.forms[0].action = doc.forms[0].action.replace(
              "https:",
              "http:"
            );
            break;
          case "action":
            doc.forms[0].action = "https://example.org/login/";
            break;
          case "focus":
            doc.getElementById("email").focus();
            break;
        }
      });
      resolve({ code: "123456" });
      await completion;
      await SpecialPowers.spawn(browser, [], () => {
        const fields = content.document.forms[0].elements;
        ok(
          Array.from(fields).every(field => !field.value),
          "A changed or ineligible target receives no code or password"
        );
      });
      await prepareICloudOTPForm(browser);
    }
    ok(
      !provider.getPassword.called && !provider.saveLogin.called,
      "Rejected OTP fills never route to password retrieval or saving"
    );
    await SpecialPowers.spawn(browser, [], () => {
      const form = content.document.forms[0];
      form.action = form.action.replace("https:", "http:");
    });
    const before = provider.listOneTimeCodes.callCount;
    await BrowserTestUtils.synthesizeMouseAtCenter("#totpmfa", {}, browser);
    await BrowserTestUtils.synthesizeKey("KEY_ArrowDown", {}, browser);
    await SpecialPowers.spawn(browser, [], () => {
      const field = content.document.getElementById("totpmfa");
      ok(
        content.document.forms[0].action.startsWith("http:"),
        "The negative fixture has an insecure form action"
      );
      ok(
        !content.windowGlobalChild
          .getActor("LoginManager")
          .shouldSearchForAutoComplete(field, ""),
        "An insecure OTP field cannot search the provider"
      );
      is(field.value.length, 0, "The insecure field remains empty");
    });
    is(
      provider.listOneTimeCodes.callCount,
      before,
      "Insecure focus does not query OTP metadata"
    );
  });
});

add_task(async function test_icloud_actor_integration() {
  await withICloudActorTest(async context => {
    const { browser, provider, account } = context;
    const localCount = await Services.logins.countLoginsAsync("", "", "");
    await selectICloudTestCredential(context);
    await submitICloudTestForm(context);
    ok(
      !PopupNotifications.getNotification("password", browser),
      "Unchanged submission is suppressed"
    );
    ok(!provider.saveLogin.called, "Unchanged submission is not saved");
    const updatedPassword = "icloud-smoke-updated-password";
    await typeICloudTestValue(browser, "#form-basic-password", updatedPassword);
    await submitICloudTestForm(context);
    await TestUtils.waitForCondition(() =>
      PopupNotifications.getNotification("password", browser)
    );
    if (PopupNotifications.panel.state !== "open") {
      EventUtils.synthesizeMouseAtCenter(
        document.getElementById("password-notification-icon"),
        {}
      );
    }
    await TestUtils.waitForCondition(
      () => PopupNotifications.panel.state === "open"
    );
    const notification = PopupNotifications.getNotification(
      "password",
      browser
    );
    is(
      notification.options.passwordNotificationType,
      "password-change",
      "An iCloud update is offered"
    );
    ok(!provider.saveLogin.called, "Capture waits for confirmation");
    const l10n = new Localization([
      "branding/brand.ftl",
      "browser/waterfox/icloud-provider.ftl",
    ]);
    let acceptSave, verifySave;
    provider.saveLogin.callsFake(
      () => new Promise(resolve => (acceptSave = resolve))
    );
    provider.verifySavedLogin.callsFake(
      () => new Promise(resolve => (verifySave = resolve))
    );
    const pendingMessage = await l10n.formatValue(
      "icloud-passwords-capture-verification-pending"
    );
    const doorhanger = document.getElementById("password-notification");
    EventUtils.synthesizeMouseAtCenter(doorhanger.button, {});
    await TestUtils.waitForCondition(() => !!acceptSave);
    ok(!provider.verifySavedLogin.called, "Readback waits for acceptance");
    acceptSave({ accepted: true, verified: false });
    await TestUtils.waitForCondition(
      () =>
        !!verifySave &&
        PopupNotifications.panel.state === "closed" &&
        notification.message === pendingMessage
    );
    ok(notification.dismissed, "Initial readback leaves only the key icon");
    ok(notification.mainAction.disabled, "Acceptance alone is not success");
    ok(
      provider.saveLogin.calledWithMatch(browser, {
        origin: ICLOUD_TEST_ORIGIN,
        username: account.username,
        password: updatedPassword,
      }),
      "The doorhanger submits the update request without claiming persistence"
    );
    ok(
      provider.verifySavedLogin.calledOnceWithExactly(
        browser,
        provider.saveLogin.firstCall.args[1]
      ),
      "Readback verifies the exact submitted credential"
    );
    ok(
      Object.isFrozen(provider.verifySavedLogin.firstCall.args[1]),
      "The expected credential is immutable"
    );
    verifySave(true);
    await TestUtils.waitForCondition(
      () =>
        !PopupNotifications.getNotification("password", browser) &&
        PopupNotifications.panel.state === "closed"
    );
    ok(provider.saveLogin.calledOnce, "Verified saves disappear without Done");

    const beforeGesture = await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      doc.body.replaceChildren();
      for (const [id, type] of [
        ["formless-username", "text"],
        ["formless-password", "password"],
      ]) {
        doc.body.append(
          Object.assign(doc.createElement("input"), { id, name: id, type })
        );
      }
      return doc.lastUserGestureTimeStamp;
    });
    await typeICloudTestValue(browser, "#formless-username", "formless-user");
    await typeICloudTestValue(
      browser,
      "#formless-password",
      "formless-password"
    );
    await SpecialPowers.spawn(browser, [beforeGesture], previous => {
      Assert.greater(
        content.document.lastUserGestureTimeStamp,
        previous,
        "Trusted typing advances the real user-gesture timestamp"
      );
    });
    await TestUtils.waitForCondition(() =>
      PopupNotifications.getNotification("password", browser)
    );
    const editNotification = PopupNotifications.getNotification(
      "password",
      browser
    );
    ok(editNotification.dismissed, "Formless edits offer a dismissed prompt");
    ok(
      document
        .getElementById("password-notification-icon")
        .hasAttribute("showing"),
      "Formless edits expose the password anchor"
    );
    EventUtils.synthesizeMouseAtCenter(
      document.getElementById("password-notification-icon"),
      {}
    );
    await TestUtils.waitForCondition(
      () => PopupNotifications.panel.state === "open"
    );
    is(
      document.getElementById("password-notification").notification,
      editNotification,
      "The password anchor opens the native iCloud prompt"
    );
    PopupNotifications.panel.hidePopup();
    await TestUtils.waitForCondition(
      () => PopupNotifications.panel.state === "closed"
    );
    await SpecialPowers.spawn(browser, [ICLOUD_TEST_PAGE], page => {
      content.document.body.append(
        Object.assign(content.document.createElement("a"), {
          id: "formless-next",
          href: page + "?formless",
          textContent: "Continue",
        })
      );
    });
    const navigated = BrowserTestUtils.browserLoaded(browser);
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#formless-next",
      {},
      browser
    );
    await navigated;
    await TestUtils.waitForCondition(() => {
      const prompt = PopupNotifications.getNotification("password", browser);
      return prompt && prompt !== editNotification && !prompt.dismissed;
    }, "Formless page-initiated navigation opens the native iCloud prompt");
    ok(
      provider.saveLogin.calledOnce,
      "Formless capture still waits for a user Save action"
    );
    is(
      await Services.logins.countLoginsAsync("", "", ""),
      localCount,
      "Local storage is unchanged"
    );
  });
});

add_task(async function test_icloud_save_verification_retries_only_read() {
  await withICloudActorTest(async context => {
    const { browser, provider } = context;
    const localCount = await Services.logins.countLoginsAsync("", "", "");
    provider.verifySavedLogin.resolves(false);
    provider.verifySavedLogin
      .onCall(2)
      .rejects(new Error("sanitized-native-error"));
    provider.verifySavedLogin.onCall(4).resolves(true);
    const l10n = new Localization(["browser/waterfox/icloud-provider.ftl"]);
    const error = await l10n.formatValue(
      "icloud-passwords-capture-verification-error"
    );
    const checkAgain = await l10n.formatValue(
      "icloud-passwords-capture-check-again-button"
    );
    const pendingMessage = await l10n.formatValue(
      "icloud-passwords-capture-verification-pending"
    );
    const prompt = await showICloudTestSavePrompt(context);
    const reshow = context.sandbox.spy(prompt.notification, "reshow");
    let { completion } = await clickICloudTestSaveAction(prompt);
    await completion;
    is(
      PopupNotifications.panel.state,
      "closed",
      "False readback opens no error panel"
    );
    is(
      prompt.notification.message,
      pendingMessage,
      "Missing readback stays neutral"
    );
    ok(prompt.notification.dismissed, "The unverified save remains key-only");
    for (let attempt = 0; attempt < 2; attempt++) {
      await reopenICloudTestPrompt(prompt);
      await TestUtils.waitForCondition(
        () => !prompt.doorhanger.button.disabled
      );
      is(
        prompt.doorhanger.getAttribute("label"),
        pendingMessage,
        "Manual reopen checks again with neutral pending text"
      );
      is(
        prompt.doorhanger.getAttribute("buttonlabel"),
        checkAgain,
        "Accepted saves offer a check-only action"
      );
      is(
        prompt.doorhanger.getAttribute("secondarybuttonhidden"),
        "true",
        "Pending verification cannot switch storage destinations"
      );
      for (const id of ["username", "password"]) {
        const field = document.getElementById("password-notification-" + id);
        ok(field.disabled, "Accepted credentials remain read-only");
        field.value = "must-not-change-readback";
        field.dispatchEvent(new Event("input", { bubbles: true }));
      }
      ({ completion } = await clickICloudTestSaveAction(prompt));
      await completion;
      if (!attempt) {
        is(
          prompt.notification.message,
          error,
          "Only an actual exception sets the sanitized error"
        );
        is(
          PopupNotifications.panel.state,
          "closed",
          "An exception does not reopen the panel"
        );
      }
      ok(provider.saveLogin.calledOnce, "Checking again never writes again");
    }
    ok(!reshow.called, "No accepted-save check automatically reopens a panel");
    await TestUtils.waitForCondition(
      () =>
        !PopupNotifications.getNotification("password", browser) &&
        PopupNotifications.panel.state === "closed"
    );
    ok(provider.saveLogin.calledOnce, "All retries share one native write");
    is(
      provider.verifySavedLogin.callCount,
      5,
      "Save, two reopens and two check actions each perform one readback"
    );
    for (const call of provider.verifySavedLogin.getCalls()) {
      is(call.args[0], browser, "Readback uses the original parent");
      is(
        call.args[1],
        provider.saveLogin.firstCall.args[1],
        "Every readback uses the immutable submitted credential"
      );
      ok(Object.isFrozen(call.args[1]), "The expected credential stays frozen");
    }
    is(
      await Services.logins.countLoginsAsync("", "", ""),
      localCount,
      "Verification failures never save locally"
    );
  });
});

add_task(async function test_icloud_pending_save_event_refresh() {
  await withICloudActorTest(async context => {
    const { browser, provider, sandbox } = context;
    const focus = sandbox.spy(browser, "focus");
    for (const event of ["activate", "TabSelect"]) {
      provider.saveLogin.resetHistory();
      provider.verifySavedLogin.resetHistory();
      provider.verifySavedLogin.resolves(false);
      let resolve;
      provider.verifySavedLogin
        .onCall(1)
        .returns(new Promise(done => (resolve = done)));
      const prompt = await showICloudTestSavePrompt(context);
      const { completion } = await clickICloudTestSaveAction(prompt);
      await completion;
      is(
        PopupNotifications.panel.state,
        "closed",
        "A missing initial readback stays key-only"
      );
      focus.resetHistory();
      void mockICloudTestRefresh(context, event);
      is(
        PopupNotifications.panel.state,
        "closed",
        "Passive refresh never opens a panel"
      );
      ok(!focus.called, "Passive refresh does not focus the browser");
      ok(
        provider.verifySavedLogin.calledTwice,
        "One event starts one new read"
      );
      resolve(true);
      await TestUtils.waitForCondition(
        () =>
          !PopupNotifications.getNotification("password", browser) &&
          PopupNotifications.panel.state === "closed"
      );
      ok(
        provider.saveLogin.calledOnce,
        "An exact event-driven match never resaves"
      );
      ok(
        context.removedWindowEvents.calledWith(
          "activate",
          iCloudTestRefreshListener(context, "activate")
        ),
        "Matching removes the activation listener"
      );
      ok(
        context.removedTabEvents.calledWith(
          "TabSelect",
          iCloudTestRefreshListener(context, "TabSelect")
        ),
        "Matching removes the tab listener"
      );
      ok(
        context.removedWindowEvents.calledWith("unload", prompt.dismiss),
        "Matching removes the unload listener"
      );
      await mockICloudTestRefresh(context, "activate");
      await mockICloudTestRefresh(context, "TabSelect");
      ok(
        provider.verifySavedLogin.calledTwice,
        "Removed listeners cannot revive the request"
      );
    }
  });
});

add_task(
  async function test_icloud_refresh_events_coalesce_without_popup_loop() {
    await withICloudActorTest(async context => {
      const { provider } = context;
      provider.verifySavedLogin.resolves(false);
      let finishRead, finishFollowup;
      provider.verifySavedLogin
        .onCall(1)
        .returns(new Promise(resolve => (finishRead = resolve)));
      provider.verifySavedLogin
        .onCall(2)
        .returns(new Promise(resolve => (finishFollowup = resolve)));
      const prompt = await showICloudTestSavePrompt(context);
      const { completion } = await clickICloudTestSaveAction(prompt);
      await completion;
      await reopenICloudTestPrompt(prompt);
      for (let i = 0; i < 5; i++) {
        void mockICloudTestRefresh(context, "activate");
        void mockICloudTestRefresh(context, "TabSelect");
        PopupNotifications._update();
      }
      ok(
        provider.verifySavedLogin.calledTwice,
        "A burst cannot overlap the active read"
      );
      finishRead(false);
      await TestUtils.waitForCondition(
        () => provider.verifySavedLogin.callCount === 3
      );
      for (let i = 0; i < 5; i++) {
        PopupNotifications._update();
      }
      finishFollowup(false);
      await TestUtils.waitForCondition(
        () => !prompt.doorhanger.button.disabled
      );
      PopupNotifications._update();
      await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
      is(
        provider.verifySavedLogin.callCount,
        3,
        "The burst adds only one follow-up; showing/shown cannot queue more"
      );
      ok(
        provider.saveLogin.calledOnce,
        "Coalesced refreshes never duplicate the write"
      );
      is(
        PopupNotifications.panel.state,
        "open",
        "An explicitly opened pending panel stays usable"
      );
    });
  }
);

add_task(async function test_icloud_refresh_is_owner_foreground_bound() {
  await withICloudActorTest(async context => {
    const { browser, provider } = context;
    provider.verifySavedLogin.resolves(false);
    const prompt = await showICloudTestSavePrompt(context);
    ok(
      !provider.verifySavedLogin.called,
      "No refresh is admitted before acceptance"
    );
    const { completion } = await clickICloudTestSaveAction(prompt);
    await completion;
    await iCloudTestRefreshListener(
      context,
      "activate"
    )({
      isTrusted: false,
      target: window,
    });
    await mockICloudTestRefresh(context, "activate", {});
    ok(
      provider.verifySavedLogin.calledOnce,
      "Untrusted and foreign-window activation are ignored"
    );
    const otherWindow = await BrowserTestUtils.openNewBrowserWindow();
    try {
      await SimpleTest.promiseFocus(otherWindow);
      await mockICloudTestRefresh(context, "activate");
      ok(
        provider.verifySavedLogin.calledOnce,
        "An inactive owner cannot refresh"
      );
    } finally {
      await BrowserTestUtils.closeWindow(otherWindow);
      await SimpleTest.promiseFocus(window);
    }
    await TestUtils.waitForCondition(
      () => !prompt.notification.mainAction.disabled
    );
    const reads = provider.verifySavedLogin.callCount;
    const ownerTab = gBrowser.getTabForBrowser(browser);
    const otherTab = BrowserTestUtils.addTab(gBrowser, "about:blank");
    try {
      await BrowserTestUtils.switchTab(gBrowser, otherTab);
      await mockICloudTestRefresh(context, "activate");
      await mockICloudTestRefresh(context, "TabSelect");
      await mockICloudTestRefresh(context, "TabSelect", ownerTab);
      Assert.strictEqual(
        provider.verifySavedLogin.callCount,
        reads,
        "Background or unrelated tab events cannot read"
      );
      let resolve;
      provider.verifySavedLogin
        .onCall(reads)
        .returns(new Promise(done => (resolve = done)));
      await BrowserTestUtils.switchTab(gBrowser, ownerTab);
      await TestUtils.waitForCondition(
        () => provider.verifySavedLogin.callCount === reads + 1
      );
      void mockICloudTestRefresh(context, "activate");
      await BrowserTestUtils.switchTab(gBrowser, otherTab);
      resolve(false);
      await TestUtils.waitForCondition(
        () => !prompt.notification.mainAction.disabled
      );
      Assert.strictEqual(
        provider.verifySavedLogin.callCount,
        reads + 1,
        "A queued follow-up is dropped when the owner loses foreground"
      );
      provider.verifySavedLogin.onCall(reads + 1).resolves(true);
      await BrowserTestUtils.switchTab(gBrowser, ownerTab);
      await TestUtils.waitForCondition(
        () => !PopupNotifications.getNotification("password", browser)
      );
      is(
        provider.verifySavedLogin.callCount,
        reads + 2,
        "Selecting the owning tab again checks once and removes an exact match"
      );
      ok(provider.saveLogin.calledOnce, "Foreground changes never resave");
    } finally {
      if (gBrowser.selectedTab !== ownerTab) {
        await BrowserTestUtils.switchTab(gBrowser, ownerTab);
      }
      await BrowserTestUtils.removeTab(otherTab);
    }
  });
});

add_task(async function test_icloud_cancelled_save_can_retry_write() {
  await withICloudActorTest(async context => {
    const { provider } = context;
    provider.saveLogin.onCall(0).resolves(false);
    const l10n = new Localization(["browser/waterfox/icloud-provider.ftl"]);
    const cancelled = await l10n.formatValue(
      "icloud-passwords-capture-cancelled"
    );
    const prompt = await showICloudTestSavePrompt(context);
    let { completion } = await clickICloudTestSaveAction(prompt);
    await completion;
    await TestUtils.waitForCondition(
      () =>
        PopupNotifications.panel.state === "open" &&
        prompt.doorhanger.getAttribute("label") === cancelled
    );
    ok(!provider.verifySavedLogin.called, "Cancellation is not acceptance");
    is(
      prompt.doorhanger.getAttribute("buttonlabel"),
      await l10n.formatValue("icloud-passwords-capture-retry-button"),
      "Cancellation before acceptance still offers Retry"
    );
    const password = document.getElementById("password-notification-password");
    ok(!password.disabled, "Cancelled requests can still be edited");
    password.value = "retry-before-acceptance";
    password.dispatchEvent(new Event("input", { bubbles: true }));
    ({ completion } = await clickICloudTestSaveAction(prompt));
    await completion;
    ok(provider.saveLogin.calledTwice, "A cancelled request can retry saving");
    ok(
      provider.verifySavedLogin.calledOnce,
      "Only the accepted retry is verified"
    );
    is(
      provider.saveLogin.secondCall.args[1].password,
      "retry-before-acceptance",
      "The save retry reads the edited credential"
    );
  });
});

add_task(async function test_icloud_pending_save_ui_lifecycle() {
  await withICloudActorTest(async context => {
    const { browser, provider, setReady } = context;
    for (const phase of ["acceptance", "verification"]) {
      for (const interruption of [
        "dismiss",
        "remove",
        "navigation",
        "replacement",
        "session",
        "disable",
      ]) {
        info(`Pending ${phase}: ${interruption}`);
        provider.saveLogin.resetHistory();
        provider.verifySavedLogin.resetHistory();
        provider.saveLogin.resolves({ accepted: true, verified: false });
        provider.verifySavedLogin.resolves(true);
        let resolve;
        const pending = new Promise(done => (resolve = done));
        provider[
          phase === "acceptance" ? "saveLogin" : "verifySavedLogin"
        ].returns(pending);
        const prompt = await showICloudTestSavePrompt(context);
        const { completion } = await clickICloudTestSaveAction(prompt);
        await TestUtils.waitForCondition(() =>
          phase === "acceptance"
            ? provider.saveLogin.calledOnce
            : provider.verifySavedLogin.calledOnce &&
              PopupNotifications.panel.state === "closed"
        );
        if (phase === "verification") {
          void mockICloudTestRefresh(context, "activate");
        }
        let replacement;
        if (interruption === "dismiss") {
          prompt.dismiss();
        } else if (interruption === "remove") {
          prompt.notification.remove();
        } else if (interruption === "navigation") {
          const loaded = BrowserTestUtils.browserLoaded(browser);
          BrowserTestUtils.startLoadingURIString(
            browser,
            ICLOUD_TEST_PAGE + "?pending-" + phase
          );
          await loaded;
        } else if (interruption === "replacement") {
          replacement = await showICloudTestSavePrompt(context);
        } else if (interruption === "disable") {
          Services.prefs.setBoolPref(
            "waterfox.passwords.icloud.enabled",
            false
          );
          Services.prefs.setBoolPref("waterfox.passwords.icloud.enabled", true);
        } else {
          setReady(false);
          setReady(true);
        }
        let result = interruption !== "dismiss";
        if (phase === "acceptance" && result) {
          result = { accepted: true, verified: false };
        }
        resolve(result);
        await completion;
        is(
          PopupNotifications.getNotification("password", browser),
          replacement?.notification ?? null,
          "Late results cannot revive or replace a notification"
        );
        if (phase === "verification") {
          await mockICloudTestRefresh(context, "activate");
          await mockICloudTestRefresh(context, "TabSelect");
        }
        ok(provider.saveLogin.calledOnce, "Lifecycle cleanup never resaves");
        is(
          provider.verifySavedLogin.callCount,
          phase === "acceptance" ? 0 : 1,
          "Stale acceptance does not start readback"
        );
        if (replacement) {
          ok(
            !replacement.doorhanger.button.disabled,
            "Late results leave the replacement UI usable"
          );
          replacement.dismiss();
        }
        await TestUtils.waitForCondition(
          () => PopupNotifications.panel.state === "closed"
        );
      }
    }
  });
});

add_task(async function test_icloud_unverified_save_ui_cleanup() {
  await withICloudActorTest(async context => {
    const { browser, provider, setReady } = context;
    provider.verifySavedLogin.resolves(false);
    for (const interruption of ["navigation", "dismiss", "session"]) {
      provider.saveLogin.resetHistory();
      provider.verifySavedLogin.resetHistory();
      const prompt = await showICloudTestSavePrompt(context);
      const { completion } = await clickICloudTestSaveAction(prompt);
      await completion;
      await TestUtils.waitForCondition(
        () =>
          PopupNotifications.panel.state === "closed" &&
          !prompt.notification.mainAction.disabled
      );
      if (interruption === "navigation") {
        const loaded = BrowserTestUtils.browserLoaded(browser);
        BrowserTestUtils.startLoadingURIString(
          browser,
          ICLOUD_TEST_PAGE + "?unverified"
        );
        await loaded;
      } else if (interruption === "dismiss") {
        await reopenICloudTestPrompt(prompt);
        await TestUtils.waitForCondition(
          () => !prompt.doorhanger.button.disabled
        );
        PopupNotifications.panel.hidePopup();
      } else {
        setReady(false);
        setReady(true);
      }
      await TestUtils.waitForCondition(
        () =>
          !PopupNotifications.getNotification("password", browser) &&
          PopupNotifications.panel.state === "closed",
        "Pending verification is cleaned up without another check action"
      );
      ok(provider.saveLogin.calledOnce, "Cleanup does not write again");
      is(
        provider.verifySavedLogin.callCount,
        interruption === "dismiss" ? 2 : 1,
        "Only the explicit reopen, not cleanup, adds a read"
      );
      const replacement = await showICloudTestSavePrompt(context);
      ok(
        !document.getElementById("password-notification-password").disabled,
        "Cleanup restores shared fields for the next prompt"
      );
      replacement.dismiss();
      await TestUtils.waitForCondition(
        () => PopupNotifications.panel.state === "closed"
      );
    }
  });
});

add_task(async function test_local_password_autocomplete_provenance() {
  await withICloudActorTest(async context => {
    const { browser, prompts, provider } = context;
    const local = Cc["@mozilla.org/login-manager/loginInfo;1"].createInstance(
      Ci.nsILoginInfo
    );
    local.init(
      ICLOUD_TEST_ORIGIN,
      ICLOUD_TEST_ORIGIN,
      null,
      "local-smoke-user",
      "local-smoke-password",
      "username",
      "password"
    );
    const saved = await Services.logins.addLoginAsync(local);
    try {
      for (const afterICloud of [false, true]) {
        if (afterICloud) {
          await selectICloudTestCredential(context);
        }
        await SpecialPowers.spawn(browser, [], () => {
          content.document.getElementById("form-basic-password").value = "";
        });
        PopupNotifications.getNotification("password", browser)?.remove();
        const before = prompts.callCount;
        const { completion } = await selectICloudTestRow(
          context,
          "#form-basic-password",
          row =>
            row.fillMessageName === "PasswordManager:OnFieldAutoComplete" &&
            row.guid === saved.guid
        );
        await completion;
        await SpecialPowers.spawn(browser, [], async () => {
          await ContentTaskUtils.waitForCondition(
            () =>
              content.document.getElementById("form-basic-password").value ===
              "local-smoke-password"
          );
        });
        await typeICloudTestValue(
          browser,
          "#form-basic-password",
          "local-smoke-edited"
        );
        await submitICloudTestForm(context);
        is(
          prompts.callCount,
          before,
          "Local password selection and edits never use the iCloud prompter"
        );
        ok(
          PopupNotifications.getNotification("password", browser),
          "Local capture remains available"
        );
        ok(
          !provider.saveLogin.called,
          "Local capture never calls the iCloud save service"
        );
        PopupNotifications.getNotification("password", browser)?.remove();
      }
    } finally {
      await Services.logins.removeLoginAsync(saved);
    }
  });
});

add_task(async function test_disabled_provenance_does_not_revive() {
  await withICloudActorTest(async context => {
    const { browser, prompts, provider } = context;
    await selectICloudTestCredential(context);
    const before = prompts.callCount;
    for (const enabled of [false, true]) {
      Services.prefs.setBoolPref("waterfox.passwords.icloud.enabled", enabled);
      await SpecialPowers.spawn(browser, [enabled], async expected => {
        await ContentTaskUtils.waitForCondition(
          () =>
            Services.prefs.getBoolPref("waterfox.passwords.icloud.enabled") ===
            expected
        );
      });
      await typeICloudTestValue(
        browser,
        "#form-basic-password",
        enabled ? "reenabled-edit" : "disabled-edit"
      );
      await submitICloudTestForm(context);
      is(
        prompts.callCount,
        before,
        "Revoked iCloud provenance cannot become an iCloud update or upload"
      );
      ok(
        PopupNotifications.getNotification("password", browser),
        "Disabling and re-enabling does not swallow local capture"
      );
      PopupNotifications.getNotification("password", browser)?.remove();
    }
    ok(!provider.saveLogin.called, "Revoked provenance never saves to iCloud");
    await selectICloudTestCredential(context);
    await typeICloudTestValue(
      browser,
      "#form-basic-password",
      "new-session-edit"
    );
    await submitICloudTestForm(context);
    Assert.greater(
      prompts.callCount,
      before,
      "An explicit new iCloud selection establishes fresh provenance"
    );
  });
});

add_task(async function test_cancelled_unlock_can_retry() {
  await withICloudActorTest(async context => {
    const { browser, provider, setReady } = context;
    setReady(false);
    let selected = await selectICloudTestRow(
      context,
      "#form-basic-username",
      row => row.fillMessageName === "PasswordManager:SelectICloudCredential"
    );
    await selected.completion;
    ok(provider.unlock.calledOnce, "The unlock row requests authentication");
    ok(
      !provider.getPassword.called,
      "Cancelling unlock does not fetch a password"
    );
    provider.unlock.callsFake(async () => {
      setReady(true);
      return true;
    });
    selected = await selectICloudTestRow(
      context,
      "#form-basic-username",
      row => row.fillMessageName === "PasswordManager:SelectICloudCredential"
    );
    await selected.completion;
    ok(
      provider.unlock.calledTwice,
      "A cancelled unlock can be retried through the popup"
    );
    ok(
      !provider.getPassword.called,
      "Unlocking alone does not fetch a password"
    );
    const popup = document.getElementById("PopupAutoComplete");
    await TestUtils.waitForCondition(
      () =>
        popup.state === "open" &&
        Array.from({ length: popup.view.matchCount }, (_, i) =>
          popup.view.getLabelAt(i)
        ).includes(context.account.username),
      "Successful unlock refreshes the popup with account metadata"
    );
    selected = await selectICloudTestRow(
      context,
      "#form-basic-username",
      row => row.fillMessageName === "PasswordManager:SelectICloudCredential",
      { reusePopup: true }
    );
    await selected.completion;
    await SpecialPowers.spawn(browser, [context.credential], async expected => {
      await ContentTaskUtils.waitForCondition(
        () =>
          content.document.getElementById("form-basic-password").value ===
          expected.password
      );
    });
    ok(
      provider.getPassword.calledOnceWithExactly(
        ICLOUD_TEST_ORIGIN,
        context.account,
        browser
      ),
      "The refreshed popup requires a new explicit credential selection"
    );
  });
});

add_task(
  async function test_pending_fill_cancelled_by_disable_and_navigation() {
    await withICloudActorTest(async context => {
      const { browser, provider, credential } = context;
      let resolve;
      provider.getPassword.callsFake(
        () =>
          new Promise(done => {
            resolve = done;
          })
      );
      const { completion } = await selectICloudTestRow(
        context,
        "#form-basic-username",
        row => row.fillMessageName === "PasswordManager:SelectICloudCredential"
      );
      await TestUtils.waitForCondition(
        () => !!resolve,
        "The first selected password request starts"
      );
      Services.prefs.setBoolPref("waterfox.passwords.icloud.enabled", false);
      Services.prefs.setBoolPref("waterfox.passwords.icloud.enabled", true);
      resolve(credential);
      await completion;
      await SpecialPowers.spawn(browser, [], () => {
        is(
          content.document.getElementById("form-basic-password").value,
          "",
          "A result from before disable/re-enable cannot fill in the new session"
        );
      });
      resolve = null;
      const pending = await selectICloudTestRow(
        context,
        "#form-basic-username",
        row => row.fillMessageName === "PasswordManager:SelectICloudCredential"
      );
      await TestUtils.waitForCondition(
        () => !!resolve,
        "The second selected password request starts"
      );
      const loaded = BrowserTestUtils.browserLoaded(browser);
      BrowserTestUtils.startLoadingURIString(
        browser,
        ICLOUD_TEST_PAGE + "?cancelled"
      );
      await loaded;
      resolve(credential);
      await pending.completion;
      await SpecialPowers.spawn(browser, [], () => {
        is(
          content.document.getElementById("form-basic-password").value,
          "",
          "Navigation cancels delivery to the old target"
        );
      });
      ok(!provider.saveLogin.called, "Cancelled fills never save");
    });
  }
);
