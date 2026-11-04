/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const SPLIT_OTP_ORIGIN = "https://example.com";
const SPLIT_OTP_PAGE =
  SPLIT_OTP_ORIGIN +
  "/browser/toolkit/components/passwordmgr/test/browser/form_basic.html";

async function withSplitOTPTest(task) {
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  const { ICloudPasswords: provider } = ChromeUtils.importESModule(
    "resource:///modules/ICloudPasswords.sys.mjs"
  );
  const sandbox = sinon.createSandbox();
  sandbox.stub(provider, "supported").get(() => true);
  sandbox.stub(provider, "isReady").get(() => provider.enabled);
  sandbox.stub(provider, "unlock").resolves(false);
  sandbox.stub(provider, "listAccounts").resolves([]);
  sandbox.stub(provider, "getPassword").resolves(null);
  sandbox.stub(provider, "saveLogin").resolves(false);
  sandbox
    .stub(provider, "listOneTimeCodes")
    .resolves([
      { username: "split-otp-user", domain: "Split OTP", source: "totp" },
    ]);
  sandbox.stub(provider, "getOneTimeCode").resolves({ code: "123456" });
  await SpecialPowers.pushPrefEnv({
    set: [
      ["waterfox.passwords.icloud.enabled", true],
      ["waterfox.passwords.icloud.otp.enabled", true],
      ["signon.rememberSignons", true],
      ["signon.autofillForms", false],
      ["signon.suggestImportCount", 0],
    ],
  });
  let tab;
  try {
    tab = await BrowserTestUtils.openNewForegroundTab(gBrowser, SPLIT_OTP_PAGE);
    const browser = tab.linkedBrowser;
    const actor =
      browser.browsingContext.currentWindowGlobal.getActor("LoginManager");
    const selections = sandbox.spy(actor, "onAutoCompleteEntrySelected");
    await SimpleTest.promiseFocus(window);
    await SpecialPowers.spawn(browser, [], async () => {
      const child = content.windowGlobalChild.getActor("LoginManager");
      await ContentTaskUtils.waitForCondition(() =>
        child.isLoginManagerField(
          content.document.getElementById("form-basic-username")
        )
      );
    });
    await task({ browser, actor, provider, selections });
    ok(!provider.getPassword.called, "Split OTP never retrieves a password");
    ok(!provider.saveLogin.called, "Split OTP never saves a password");
  } finally {
    const popup = document.getElementById("PopupAutoComplete");
    popup.hidePopup();
    if (tab) {
      await BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
    sandbox.restore();
  }
}

async function prepareSplitOTP(browser, options = {}) {
  await SpecialPowers.spawn(browser, [options], config => {
    const doc = content.document;
    const form = doc.createElement("form");
    form.action = content.location.origin + "/split_otp";
    let group = form;
    if (config.root !== "form") {
      group = doc.createElement(
        config.root === "fieldset" ? "fieldset" : "div"
      );
    }
    group.id = config.semantics === "group" ? "totp" : "digits";
    group.dataset.splitOtpGroup = "true";
    if (config.root === "role") {
      group.setAttribute("role", "group");
    }
    const fields = [];
    for (let index = 0; index < (config.count ?? 6); index++) {
      const field = Object.assign(doc.createElement("input"), {
        id: "split-digit-" + index,
        name:
          config.semantics === "names"
            ? "otp-digit-" + index
            : "digit-" + index,
        maxLength: 1,
        inputMode: "numeric",
        type: config.type ?? "text",
      });
      if (index === 0 && (!config.semantics || config.semantics === "field")) {
        field.autocomplete = "one-time-code";
      }
      fields.push(field);
      if (config.wrapped) {
        const wrapper = doc.createElement("span");
        const label = doc.createElement("label");
        label.append(field);
        wrapper.append(label);
        group.append(wrapper);
      } else {
        group.append(field);
      }
    }
    if (group !== form) {
      form.append(group);
    }
    const unrelatedForm = doc.createElement("form");
    if (config.externalForm) {
      unrelatedForm.id = "split-otp-owner";
      unrelatedForm.action = form.action;
      fields.forEach(field => field.setAttribute("form", unrelatedForm.id));
    }
    const outside = Object.assign(doc.createElement("input"), {
      id: "outside",
      name: "username",
      autocomplete: "username",
    });
    (config.sameFormOutside ? form : unrelatedForm).append(outside);
    const model = doc.createElement("output");
    model.id = "split-otp-model";
    (config.statusInside ? group : unrelatedForm).append(model);
    doc.body.replaceChildren(config.formless ? group : form, unrelatedForm);
    const data = doc.documentElement.dataset;
    data.splitOtpEvents = "0";
    data.splitOtpInputs = "[]";
    data.splitOtpChanges = "0";
    data.splitOtpEnter = "0";
    data.splitOtpSubmits = "0";
    for (const target of [form, unrelatedForm]) {
      target.addEventListener("submit", event => {
        event.preventDefault();
        data.splitOtpSubmits++;
      });
    }
    doc.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        data.splitOtpEnter++;
      }
    });
    group.addEventListener("change", () => data.splitOtpChanges++);
    const values = fields.map(() => "");
    group.addEventListener("input", event => {
      const index = fields.indexOf(event.target);
      if (index < 0) {
        return;
      }
      data.splitOtpEvents++;
      const inputs = JSON.parse(data.splitOtpInputs);
      inputs.push([event.target.id, event.target.value, event.isTrusted]);
      data.splitOtpInputs = JSON.stringify(inputs);
      if (config.attack === "navigate") {
        content.sessionStorage.setItem("split_otp_inputs", data.splitOtpInputs);
      }
      values[index] = event.target.value;
      model.textContent = values.join("");
      if (config.advance) {
        fields[Math.min(index + 1, fields.length - 1)].focus();
      }
      if (config.pageSubmit && values.every(Boolean)) {
        form.requestSubmit();
      }
      if (index !== 0) {
        return;
      }
      switch (config.attack) {
        case "focus-out":
          outside.focus();
          break;
        case "focus-out-and-back":
          outside.focus();
          fields[3].focus();
          break;
        case "transient-readonly":
          fields[1].readOnly = true;
          fields[1].readOnly = false;
          break;
        case "semantic-next":
          fields[1].autocomplete = "username";
          break;
        case "replace-next":
          fields[1].replaceWith(fields[1].cloneNode());
          break;
        case "reorder":
          fields[1].after(fields[0]);
          break;
        case "value-next":
          fields[1].value = "9";
          break;
        case "hide-group":
          group.hidden = true;
          break;
        case "action":
          form.action = form.action.replace("https:", "http:");
          break;
        case "document-url":
          content.history.replaceState(null, "", "?split_otp_during_fill");
          break;
        case "navigate":
          content.location.href = config.destination;
          break;
      }
    });
  });
}

async function showSplitOTP(context, index = 0) {
  const { browser, provider } = context;
  const popup = document.getElementById("PopupAutoComplete");
  if (popup.state !== "closed") {
    popup.hidePopup();
    await TestUtils.waitForCondition(() => popup.state === "closed");
  }
  const reads = provider.getOneTimeCode.callCount;
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#split-digit-" + index,
    {},
    browser
  );
  await TestUtils.waitForCondition(
    () => popup.state === "open" && popup.view.matchCount > 0,
    "The real child and parent offer split OTP autocomplete"
  );
  is(
    popup.view.matchCount,
    1,
    "OTP has no password, generator, or footer rows"
  );
  const row = JSON.parse(popup.view.getCommentAt(0));
  is(
    row.fillMessageName,
    "PasswordManager:SelectICloudCredential",
    "Selection uses the existing native iCloud choice route"
  );
  Assert.deepEqual(
    Object.keys(row.fillMessageData),
    ["id"],
    "Only an opaque native choice is exposed"
  );
  is(provider.getOneTimeCode.callCount, reads, "Opening a popup reads no code");
  return popup;
}

async function selectSplitOTP(context, index = 0) {
  const { selections } = context;
  const popup = await showSplitOTP(context, index);
  const before = selections.callCount;
  const hidden = BrowserTestUtils.waitForEvent(popup, "popuphidden");
  EventUtils.synthesizeMouseAtCenter(popup.richlistbox.getItemAtIndex(0), {});
  await TestUtils.waitForCondition(() => selections.callCount > before);
  await hidden;
  return { completion: selections.returnValues.at(-1) };
}

async function checkSplitOTP(browser, code, focusedIndex, submits = 0) {
  await SpecialPowers.spawn(
    browser,
    [code, focusedIndex, submits],
    async (expected, index, expectedSubmits) => {
      const doc = content.document;
      const fields = Array.from(doc.querySelectorAll("[id^=split-digit-]"));
      if (expected) {
        await ContentTaskUtils.waitForCondition(
          () => fields.map(field => field.value).join("") === expected,
          "One explicit selection fills the complete group in document order"
        );
      }
      Assert.deepEqual(
        fields.map(field => field.value),
        expected ? [...expected] : fields.map(() => ""),
        "No truncated code or partial group is filled"
      );
      is(
        doc.getElementById("outside").value,
        "",
        "Unrelated fields stay empty"
      );
      is(
        doc.documentElement.dataset.splitOtpEvents,
        String(expected.length),
        "Each written digit dispatches a native input event"
      );
      Assert.deepEqual(
        JSON.parse(doc.documentElement.dataset.splitOtpInputs),
        [...expected].map((digit, i) => ["split-digit-" + i, digit, true]),
        "The page receives trusted native values in document order"
      );
      if (expected) {
        Assert.greater(
          Number(doc.documentElement.dataset.splitOtpChanges),
          0,
          "Native change events for off-focus digits are not suppressed"
        );
      }
      is(
        doc.getElementById("split-otp-model").textContent,
        expected,
        "An input-driven controlled widget receives the complete code"
      );
      is(
        doc.documentElement.dataset.splitOtpSubmits,
        String(expectedSubmits),
        "Only the fixture's explicit page submission is observed"
      );
      is(
        doc.documentElement.dataset.splitOtpEnter,
        "0",
        "No synthesized Enter"
      );
      if (index !== undefined) {
        is(
          doc.activeElement,
          doc.getElementById("split-digit-" + index),
          "The user's original focus is preserved after in-group auto-advance"
        );
      }
    }
  );
}

add_task(async function test_split_otp_trusted_selection() {
  await withSplitOTPTest(async context => {
    const { browser, provider } = context;
    for (const config of [
      { count: 4, index: 0, root: "form", wrapped: true },
      { count: 6, index: 3, root: "fieldset", wrapped: true },
      {
        count: 10,
        index: 9,
        semantics: "names",
        type: "tel",
        root: "role",
        wrapped: true,
      },
      { count: 6, index: 2, semantics: "group", type: "number" },
      { count: 6, index: 4, semantics: "group", formless: true, wrapped: true },
      { count: 6, index: 3, wrapped: true, externalForm: true },
      {
        count: 6,
        index: 3,
        wrapped: true,
        advance: true,
        statusInside: true,
        sameFormOutside: true,
      },
    ]) {
      const { count, index } = config;
      const code = "0123456789".slice(0, count);
      provider.getOneTimeCode.resolves({ code });
      await prepareSplitOTP(browser, config);
      const listings = provider.listAccounts.callCount;
      const { completion } = await selectSplitOTP(context, index);
      await completion;
      await checkSplitOTP(browser, code, index);
      is(
        provider.listAccounts.callCount,
        listings,
        "OTP does not list passwords"
      );
    }
  });
});

add_task(async function test_split_otp_keeps_single_field_events() {
  await withSplitOTPTest(async context => {
    await prepareSplitOTP(context.browser, { count: 1 });
    await SpecialPowers.spawn(context.browser, [], () => {
      const doc = content.document;
      const field = doc.getElementById("split-digit-0");
      field.maxLength = 6;
      field.parentElement.replaceWith(field);
      field.addEventListener("input", () => {
        doc.documentElement.dataset.splitOtpEvents++;
      });
    });
    const { completion } = await selectSplitOTP(context);
    await completion;
    await SpecialPowers.spawn(context.browser, [], async () => {
      const doc = content.document;
      await ContentTaskUtils.waitForCondition(
        () => doc.getElementById("split-digit-0").value === "123456"
      );
      is(
        doc.documentElement.dataset.splitOtpEvents,
        "1",
        "Existing single-field OTP still uses setUserInput"
      );
      is(
        doc.documentElement.dataset.splitOtpSubmits,
        "0",
        "No form submission"
      );
      is(doc.getElementById("outside").value, "", "No unrelated fill");
    });
  });
});

add_task(async function test_split_otp_conservative_recognition() {
  await withSplitOTPTest(async ({ browser, provider }) => {
    for (const scenario of [
      "too-short",
      "too-long",
      "ordinary-digits",
      "readonly",
      "disabled",
      "disabled-fieldset",
      "hidden",
      "css-hidden",
      "transparent",
      "inert",
      "password",
      "conflicting-autocomplete",
      "conflicting-name",
      "not-numeric",
      "different-form",
      "barrier",
      "insecure-action",
    ]) {
      info("Unrecognized split OTP: " + scenario);
      await prepareSplitOTP(browser, {
        count: { "too-short": 3, "too-long": 11 }[scenario] ?? 6,
        semantics: scenario === "ordinary-digits" ? "none" : "field",
      });
      await SpecialPowers.spawn(browser, [scenario], change => {
        const doc = content.document;
        const fields = Array.from(doc.querySelectorAll("[id^=split-digit-]"));
        const other = fields[1];
        switch (change) {
          case "readonly":
            other.readOnly = true;
            break;
          case "disabled":
            other.disabled = true;
            break;
          case "disabled-fieldset": {
            const fieldset = doc.createElement("fieldset");
            fieldset.disabled = true;
            fields[0].parentElement.replaceWith(fieldset);
            fieldset.append(...fields);
            break;
          }
          case "hidden":
            other.type = "hidden";
            break;
          case "css-hidden":
            other.hidden = true;
            break;
          case "transparent":
            other.style.opacity = "0";
            break;
          case "inert":
            other.inert = true;
            break;
          case "password":
            other.type = "password";
            other.type = "text";
            break;
          case "conflicting-autocomplete":
            other.autocomplete = "username webauthn";
            break;
          case "conflicting-name":
            other.name = "email";
            break;
          case "not-numeric":
            other.inputMode = "text";
            break;
          case "different-form":
            doc.forms[1].id = "other-form";
            other.setAttribute("form", "other-form");
            break;
          case "barrier":
            fields[3].before(doc.createElement("input"));
            break;
          case "insecure-action":
            doc.forms[0].action = doc.forms[0].action.replace(
              "https:",
              "http:"
            );
            break;
        }
        const field = fields[Math.min(2, fields.length - 1)];
        field.focus();
        const child = content.windowGlobalChild.getActor("LoginManager");
        if (change === "insecure-action") {
          ok(
            !child.shouldSearchForAutoComplete(field, ""),
            "No insecure OTP search"
          );
        } else {
          ok(
            !child.getAutoCompleteSearchOption(field, "").isOneTimeCode,
            "An incomplete, ambiguous, or ineligible group is not OTP"
          );
        }
        const { ContentDOMReference } = ChromeUtils.importESModule(
          "resource://gre/modules/ContentDOMReference.sys.mjs"
        );
        child.receiveMessage({
          name: "PasswordManager:FillICloudCode",
          data: {
            inputElementIdentifier: ContentDOMReference.get(field),
            actionOrigin: content.location.origin,
            code: "123456",
          },
        });
        ok(
          fields.every(input => !input.value),
          "The real child rejects the fill"
        );
      });
      document.getElementById("PopupAutoComplete").hidePopup();
    }
    ok(
      !provider.listOneTimeCodes.called,
      "Invalid groups never list OTP accounts"
    );
    ok(
      !provider.getOneTimeCode.called,
      "Invalid groups never read a native code"
    );
  });
});

add_task(async function test_split_otp_never_merges_neighbor_groups() {
  await withSplitOTPTest(async context => {
    const { browser } = context;
    await prepareSplitOTP(browser, {
      wrapped: true,
      semantics: "group",
      sameFormOutside: true,
    });
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      const neighbor = doc.createElement("fieldset");
      neighbor.id = "neighbor-otp";
      for (let i = 0; i < 6; i++) {
        neighbor.append(
          Object.assign(doc.createElement("input"), {
            id: "neighbor-digit-" + i,
            maxLength: 1,
            inputMode: "numeric",
            autocomplete: "one-time-code",
          })
        );
      }
      doc.forms[0].append(neighbor);
    });
    const { completion } = await selectSplitOTP(context, 3);
    await completion;
    await checkSplitOTP(browser, "123456", 3);
    await SpecialPowers.spawn(browser, [], () => {
      ok(
        Array.from(
          content.document.querySelectorAll("[id^=neighbor-digit-]")
        ).every(field => !field.value),
        "Neither a neighboring OTP group nor ordinary same-form fields are filled"
      );
    });
  });
});

add_task(async function test_split_otp_wrapped_group_boundaries() {
  await withSplitOTPTest(async ({ browser, provider }) => {
    for (const scenario of [
      "fieldset",
      "role",
      "form",
      "named",
      "autocomplete-sections",
      "nested-boundary",
      "unrelated-textarea",
      "too-deep",
      "too-large",
    ]) {
      info("Wrapped OTP boundary: " + scenario);
      await prepareSplitOTP(browser, { wrapped: true });
      await SpecialPowers.spawn(browser, [scenario], change => {
        const doc = content.document;
        const group = doc.querySelector("[data-split-otp-group]");
        const fields = Array.from(group.querySelectorAll("input"));
        if (["fieldset", "role", "form", "named"].includes(change)) {
          const halves = [0, 1].map(index => {
            const half = doc.createElement(
              ["role", "named"].includes(change) ? "div" : change
            );
            if (change === "role") {
              half.setAttribute("role", "group");
            } else if (change === "named") {
              half.id = "otp-" + index;
            }
            return half;
          });
          fields.forEach((field, i) => halves[i < 3 ? 0 : 1].append(field));
          if (change === "form") {
            group.closest("form").replaceWith(...halves);
          } else {
            group.replaceChildren(...halves);
          }
        } else if (change === "autocomplete-sections") {
          fields.forEach((field, index) => {
            field.autocomplete =
              (index < 3 ? "section-left" : "section-right") + " one-time-code";
          });
        } else if (change === "nested-boundary") {
          const boundary = doc.createElement("fieldset");
          fields[1].replaceWith(boundary);
          boundary.append(fields[1]);
        } else if (change === "unrelated-textarea") {
          group.append(
            Object.assign(doc.createElement("textarea"), { name: "username" })
          );
        } else if (change === "too-deep") {
          for (const field of fields) {
            for (let depth = 0; depth < 6; depth++) {
              const wrapper = doc.createElement("span");
              field.replaceWith(wrapper);
              wrapper.append(field);
            }
          }
        } else if (change === "too-large") {
          for (let i = 0; i < 80; i++) {
            group.append(doc.createElement("span"));
          }
        }
        const child = content.windowGlobalChild.getActor("LoginManager");
        const { LoginHelper } = ChromeUtils.importESModule(
          "resource://gre/modules/LoginHelper.sys.mjs"
        );
        const { ContentDOMReference } = ChromeUtils.importESModule(
          "resource://gre/modules/ContentDOMReference.sys.mjs"
        );
        for (const field of fields) {
          field.focus();
          if (field.getAutocompleteInfo()?.fieldName === "one-time-code") {
            ok(
              !child.shouldSearchForAutoComplete(field, ""),
              "A rejected OTP field cannot start a search"
            );
          } else if (LoginHelper.isUsernameFieldType(field)) {
            ok(
              !child.getAutoCompleteSearchOption(field, "").isOneTimeCode,
              "A wrapped group cannot escape its boundary or skip an unrelated field"
            );
          }
          child.receiveMessage({
            name: "PasswordManager:FillICloudCode",
            data: {
              inputElementIdentifier: ContentDOMReference.get(field),
              actionOrigin: content.location.origin,
              code: "123456",
            },
          });
          is(field.value, "", "The real child rejects the invalid group fill");
        }
      });
    }
    ok(
      !provider.getOneTimeCode.called,
      "No native code is read without selection"
    );
  });
});

add_task(async function test_split_otp_unrelated_updates_keep_pending_choice() {
  await withSplitOTPTest(async context => {
    const { browser, provider } = context;
    await prepareSplitOTP(browser, { wrapped: true, statusInside: true });
    let resolve;
    provider.getOneTimeCode.callsFake(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const { completion } = await selectSplitOTP(context, 3);
    await TestUtils.waitForCondition(() => !!resolve);
    await SpecialPowers.spawn(browser, [], () => {
      const doc = content.document;
      const update = doc.createElement("div");
      update.append(doc.createElement("input"));
      doc.body.append(update);
      update.remove();
      doc.getElementById("split-otp-model").textContent = "Waiting for code";
      doc.querySelector("[data-split-otp-group]").classList.add("waiting");
      doc.body.id = "unrelated-page-state";
      doc.forms[1].name = "unrelated-form-state";
      doc.documentElement.dataset.unrelatedUpdate = "complete";
    });
    resolve({ code: "123456" });
    await completion;
    await checkSplitOTP(browser, "123456", 3);
  });
});

add_task(async function test_split_otp_does_not_suppress_page_submission() {
  await withSplitOTPTest(async context => {
    await prepareSplitOTP(context.browser, { wrapped: true, pageSubmit: true });
    const { completion } = await selectSplitOTP(context, 3);
    await completion;
    await checkSplitOTP(context.browser, "123456", 3, 1);
  });
});

add_task(async function test_split_otp_revalidates_native_input_handlers() {
  await withSplitOTPTest(async context => {
    const { browser } = context;
    for (const attack of [
      "focus-out",
      "focus-out-and-back",
      "transient-readonly",
      "semantic-next",
      "replace-next",
      "reorder",
      "value-next",
      "hide-group",
      "action",
      "document-url",
    ]) {
      info("Native input handler guard: " + attack);
      await prepareSplitOTP(browser, { wrapped: true, attack });
      const { completion } = await selectSplitOTP(context, 3);
      await completion;
      await SpecialPowers.spawn(browser, [attack], async behavior => {
        const doc = content.document;
        await ContentTaskUtils.waitForCondition(
          () => doc.documentElement.dataset.splitOtpEvents !== "0"
        );
        Assert.deepEqual(
          JSON.parse(doc.documentElement.dataset.splitOtpInputs),
          [["split-digit-0", "1", true]],
          "Unsafe input behavior prevents all remaining native digit writes"
        );
        for (const field of doc.querySelectorAll("[id^=split-digit-]")) {
          let expected = "";
          if (field.id === "split-digit-0") {
            expected = "1";
          } else if (
            behavior === "value-next" &&
            field.id === "split-digit-1"
          ) {
            expected = "9";
          }
          is(
            field.value,
            expected,
            "Only the first native digit and the site's own edit remain"
          );
        }
        is(
          doc.getElementById("outside").value,
          "",
          "No write follows external focus"
        );
        if (behavior === "focus-out") {
          is(
            doc.activeElement.id,
            "outside",
            "External site focus is not overridden"
          );
        }
        is(
          doc.documentElement.dataset.splitOtpSubmits,
          "0",
          "No direct submission"
        );
        is(
          doc.documentElement.dataset.splitOtpEnter,
          "0",
          "No synthesized Enter"
        );
      });
    }
  });
});

add_task(
  async function test_split_otp_input_navigation_stops_remaining_digits() {
    await withSplitOTPTest(async context => {
      const { browser } = context;
      const destination = SPLIT_OTP_PAGE + "?split_otp_input_navigation";
      await prepareSplitOTP(browser, {
        wrapped: true,
        attack: "navigate",
        destination,
      });
      const loaded = BrowserTestUtils.browserLoaded(
        browser,
        false,
        destination
      );
      const { completion } = await selectSplitOTP(context, 3);
      await completion;
      await loaded;
      await SpecialPowers.spawn(browser, [], () => {
        Assert.deepEqual(
          JSON.parse(content.sessionStorage.getItem("split_otp_inputs")),
          [["split-digit-0", "1", true]],
          "Navigation during native input stops the remaining writes to the old document"
        );
        content.sessionStorage.removeItem("split_otp_inputs");
      });
      await prepareSplitOTP(browser);
      await checkSplitOTP(browser, "");
    });
  }
);

add_task(async function test_split_otp_requires_exact_complete_code() {
  await withSplitOTPTest(async context => {
    for (const code of [
      "12345",
      "1234567",
      "12 456",
      "12345\n",
      "12345\r",
      "123４56",
      null,
    ]) {
      await prepareSplitOTP(context.browser, { wrapped: true });
      context.provider.getOneTimeCode.resolves({ code });
      const { completion } = await selectSplitOTP(context, 3);
      await completion;
      await checkSplitOTP(context.browser, "", 3);
    }
  });
});

async function sendSplitOTPCode(browser, code) {
  await SpecialPowers.spawn(browser, [code], value => {
    const { ContentDOMReference } = ChromeUtils.importESModule(
      "resource://gre/modules/ContentDOMReference.sys.mjs"
    );
    content.windowGlobalChild.getActor("LoginManager").receiveMessage({
      name: "PasswordManager:FillICloudCode",
      data: {
        inputElementIdentifier: ContentDOMReference.get(
          content.document.activeElement
        ),
        actionOrigin: content.location.origin,
        code: value,
      },
    });
  });
}

add_task(async function test_split_otp_requires_fresh_selected_session() {
  await withSplitOTPTest(async context => {
    const { browser, provider } = context;
    await prepareSplitOTP(browser);
    await showSplitOTP(context, 3);
    await sendSplitOTPCode(browser, "123456");
    await checkSplitOTP(browser, "", 3);
    ok(!provider.getOneTimeCode.called, "Focusing alone never reads a code");
    await prepareSplitOTP(browser);
    const { completion } = await selectSplitOTP(context, 3);
    await completion;
    await checkSplitOTP(browser, "123456", 3);
    await sendSplitOTPCode(browser, "999999");
    await checkSplitOTP(browser, "123456", 3);
    ok(
      provider.getOneTimeCode.calledOnce,
      "A consumed session cannot be replayed"
    );
  });
});

add_task(async function test_split_otp_cancels_pending_native_read() {
  await withSplitOTPTest(async context => {
    const { browser, provider } = context;
    for (const scenario of [
      "replace-digit",
      "append",
      "ancestor-transient",
      "root-reinsert",
      "external-form-reinsert",
      "transient-mutation",
      "single-field-downgrade",
      "programmatic-value",
      "focus-and-back",
      "action",
      "document-url",
      "otp-pref-and-back",
      "provider-pref-and-back",
      "password-pref-and-back",
    ]) {
      info("Pending split OTP cancellation: " + scenario);
      await prepareSplitOTP(browser, {
        wrapped: true,
        externalForm: scenario === "external-form-reinsert",
      });
      let resolve;
      provider.getOneTimeCode.callsFake(
        () =>
          new Promise(done => {
            resolve = done;
          })
      );
      const { completion } = await selectSplitOTP(context, 3);
      await TestUtils.waitForCondition(
        () => !!resolve,
        "The native read is pending"
      );
      if (scenario.endsWith("pref-and-back")) {
        const pref = {
          "otp-pref-and-back": "waterfox.passwords.icloud.otp.enabled",
          "provider-pref-and-back": "waterfox.passwords.icloud.enabled",
          "password-pref-and-back": "signon.rememberSignons",
        }[scenario];
        await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
        await SpecialPowers.popPrefEnv();
      } else {
        await SpecialPowers.spawn(browser, [scenario], change => {
          const doc = content.document;
          const field = doc.getElementById("split-digit-1");
          switch (change) {
            case "replace-digit":
              field.replaceWith(field.cloneNode());
              break;
            case "append":
              field.parentElement.append(field.cloneNode());
              break;
            case "ancestor-transient":
              field.form.inert = true;
              field.form.inert = false;
              break;
            case "external-form-reinsert": {
              const owner = field.form;
              owner.remove();
              doc.body.append(owner);
              break;
            }
            case "root-reinsert": {
              const root = doc.querySelector("[data-split-otp-group]");
              const parent = root.parentElement;
              root.remove();
              parent.append(root);
              break;
            }
            case "transient-mutation":
              field.readOnly = true;
              field.readOnly = false;
              break;
            case "single-field-downgrade":
              doc.getElementById("split-digit-3").removeAttribute("maxlength");
              doc.getElementById("split-digit-3").autocomplete =
                "one-time-code";
              break;
            case "programmatic-value":
              field.value = "9";
              break;
            case "focus-and-back":
              doc.getElementById("outside").focus();
              doc.getElementById("split-digit-3").focus();
              break;
            case "action":
              doc.forms[0].action += "?changed";
              break;
            case "document-url":
              content.history.replaceState(null, "", "?split_otp_changed");
              break;
          }
        });
      }
      resolve({ code: "123456" });
      await completion;
      await SpecialPowers.spawn(browser, [scenario], change => {
        const doc = content.document;
        for (const field of doc.querySelectorAll("[id^=split-digit-]")) {
          is(
            field.value,
            change === "programmatic-value" && field.id === "split-digit-1"
              ? "9"
              : "",
            "No digit from the stale native response is written"
          );
        }
        is(doc.getElementById("outside").value, "", "No redirected code fill");
        is(
          doc.documentElement.dataset.splitOtpSubmits,
          "0",
          "No form submission"
        );
      });
    }
  });
});

add_task(async function test_split_otp_navigation_cancels_native_read() {
  await withSplitOTPTest(async context => {
    const { browser, provider } = context;
    await prepareSplitOTP(browser);
    let resolve;
    provider.getOneTimeCode.callsFake(
      () =>
        new Promise(done => {
          resolve = done;
        })
    );
    const { completion } = await selectSplitOTP(context, 3);
    await TestUtils.waitForCondition(() => !!resolve);
    const replacement = SPLIT_OTP_PAGE + "?split_otp_replacement";
    const loaded = BrowserTestUtils.browserLoaded(browser, false, replacement);
    BrowserTestUtils.startLoadingURIString(browser, replacement);
    await loaded;
    await prepareSplitOTP(browser);
    await SpecialPowers.spawn(browser, [], () => {
      content.document.getElementById("split-digit-3").focus();
    });
    resolve({ code: "123456" });
    await completion;
    await checkSplitOTP(browser, "", 3);
  });
});
