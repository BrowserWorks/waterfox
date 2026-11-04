/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const SETUP_ROOT = getRootDirectory(gTestPath).replace(
  "chrome://mochitests/content",
  "https://example.com"
);
const SETUP_PAGE = SETUP_ROOT + "icloud_setup_fixture.html";
const SETUP_KEY = "A".repeat(32);
const SETUP_URI = `otpauth://totp/Fixture?secret=${SETUP_KEY}&issuer=Fixture`;
const SETUP_WORKER =
  "chrome://browser/content/waterfox/icloudpasswords/ICloudPasswordsQRWorker.js";

async function configureSetupFixture(browser, uri = SETUP_URI) {
  const { QR } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/qrcode/encoder.mjs"
  );
  const { matrix } = QR.encodeToMatrix(uri, "M");
  await SpecialPowers.spawn(
    browser,
    [
      matrix,
      uri,
      SETUP_KEY,
      SETUP_ROOT.replace("https://example.com", "https://example.org") +
        "icloud_setup_marker.svg",
    ],
    async (dots, value, key, markerURL) => {
      const doc = content.document;
      doc.getElementById("setup-link").href = value;
      doc.getElementById("setup-apple-link").href = value.replace(
        /^otpauth:/,
        "apple-otpauth:"
      );
      doc.getElementById("setup-key").textContent = key;
      const cell = 4;
      const margin = 4;
      const size = (dots.length + 2 * margin) * cell;
      const canvas = doc.getElementById("setup-canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, size, size);
      ctx.fillStyle = "black";
      let path = "";
      for (let y = 0; y < dots.length; y++) {
        for (let x = 0; x < dots.length; x++) {
          if (dots[y][x]) {
            const left = (x + margin) * cell;
            const top = (y + margin) * cell;
            ctx.fillRect(left, top, cell, cell);
            path += `M${left},${top}h${cell}v${cell}h-${cell}z`;
          }
        }
      }
      const image = doc.getElementById("setup-image");
      image.src = canvas.toDataURL();
      await image.decode();
      const svg = doc.getElementById("setup-svg");
      svg.setAttribute("width", size);
      svg.setAttribute("height", size);
      svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
      const background = doc.createElementNS(svg.namespaceURI, "rect");
      background.setAttribute("width", size);
      background.setAttribute("height", size);
      background.setAttribute("fill", "white");
      const modules = doc.createElementNS(svg.namespaceURI, "path");
      modules.setAttribute("d", path);
      svg.replaceChildren(background, modules);
      const unreadable =
        await content.wrappedJSObject.icloudSetupTaintCanvas(markerURL);
      ok(unreadable, "The cross-origin canvas cannot be read by the page");
      await new Promise(resolve =>
        content.requestAnimationFrame(() =>
          content.requestAnimationFrame(resolve)
        )
      );
    }
  );
}

async function withSetupTest(task, { insecure = false, localize } = {}) {
  const { sinon } = ChromeUtils.importESModule(
    "resource://testing-common/Sinon.sys.mjs"
  );
  const { ICloudPasswords } = ChromeUtils.importESModule(
    "resource:///modules/ICloudPasswords.sys.mjs"
  );
  const { ICloudPasswordsSetup, ICloudPasswordsSetupController } =
    ChromeUtils.importESModule(
      "resource:///modules/ICloudPasswordsSetup.sys.mjs"
    );
  const sandbox = sinon.createSandbox();
  const menu = document.getElementById("contentAreaContextMenu");
  let controller;
  let tab;
  let prefsPushed = false;
  let singletonSuspended = false;
  try {
    let supported = true;
    sandbox.stub(ICloudPasswords, "supported").get(() => supported);
    const setup = sandbox
      .stub(ICloudPasswords, "setUpOneTimeCode")
      .callsFake(
        async (origin, uri, parentWindow, { isCurrent, beforeDispatch }) => {
          ok(
            isCurrent(),
            "Native setup is dispatched only for a current scope"
          );
          const accepted = !beforeDispatch || (await beforeDispatch()) === true;
          return { dispatched: accepted && isCurrent() };
        }
      );
    const manager = sandbox
      .stub(ICloudPasswords, "openManager")
      .callsFake(async (origin, { isCurrent, beforeDispatch }) => {
        ok(isCurrent(), "Contextual manager dispatch retains a current scope");
        const accepted = !beforeDispatch || (await beforeDispatch()) === true;
        return { dispatched: accepted && isCurrent() };
      });
    const forbidden = [
      "unlock",
      "getStatus",
      "listAccounts",
      "getPassword",
      "listOneTimeCodes",
      "getOneTimeCode",
    ].map(method =>
      sandbox
        .stub(ICloudPasswords, method)
        .rejects(new Error("Unexpected native inspection"))
    );
    const confirm = sandbox.stub().resolves(new Map([["buttonNumClicked", 1]]));
    const alert = sandbox.stub();
    controller = new ICloudPasswordsSetupController({
      prompt: { asyncConfirmEx: confirm, alert },
      localize,
    });
    ICloudPasswordsSetup.destroy();
    singletonSuspended = true;
    await SpecialPowers.pushPrefEnv({
      set: [
        ["waterfox.passwords.icloud.enabled", true],
        ["waterfox.passwords.icloud.otp.enabled", true],
        ["widget.macos.native-context-menus", false],
        ["dom.security.https_first", false],
        ["dom.security.https_only_mode", false],
      ],
    });
    prefsPushed = true;
    controller.init();
    tab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      (insecure ? SETUP_PAGE.replace("https:", "http:") : SETUP_PAGE) +
        "?private=fixture"
    );
    const browser = tab.linkedBrowser;
    await SimpleTest.promiseFocus(window);
    if (!insecure) {
      await configureSetupFixture(browser);
    }
    const context = {
      tab,
      browser,
      menu,
      sandbox,
      setup,
      manager,
      confirm,
      alert,
      controller,
      activationSpies: new Map(),
      setSupported(value) {
        supported = value;
      },
      assertNoInspection() {
        for (const stub of forbidden) {
          is(
            stub.callCount,
            0,
            "Inspection does not pair, authenticate, or retrieve credentials/codes"
          );
        }
      },
    };
    await task(context);
    context.assertNoInspection();
  } finally {
    try {
      await hideSetupMenu({ menu });
    } finally {
      try {
        if (tab?.isConnected) {
          await BrowserTestUtils.removeTab(tab);
        }
      } finally {
        try {
          controller?.destroy();
          if (prefsPushed) {
            await SpecialPowers.popPrefEnv();
          }
        } finally {
          sandbox.restore();
          if (singletonSuspended) {
            ICloudPasswordsSetup.init();
          }
        }
      }
    }
  }
}

async function openSetupMenu(context, selector) {
  const { menu, browser, controller, activationSpies, sandbox } = context;
  await SpecialPowers.spawn(browser, [selector], async query => {
    content.document
      .querySelector(query)
      .scrollIntoView({ block: "center", inline: "center" });
    await new Promise(resolve =>
      content.requestAnimationFrame(() =>
        content.requestAnimationFrame(resolve)
      )
    );
  });
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  await BrowserTestUtils.synthesizeMouseAtCenter(
    selector,
    { type: "contextmenu", button: 2 },
    browser
  );
  await shown;
  await controller.whenReady(menu);
  try {
    const actor = gContextMenu.actor.manager.getActor("ICloudPasswordsSetup");
    if (!activationSpies.has(actor)) {
      activationSpies.set(actor, sandbox.spy(actor, "activate"));
    }
    context.actor = actor;
    context.activations = activationSpies.get(actor);
  } catch {
    context.actor = context.activations = null;
  }
  context.assertNoInspection();
  is(context.setup.callCount, 0, "Opening a menu never enrolls a code");
  is(context.manager.callCount, 0, "Opening a menu never launches Passwords");
  return document.getElementById("context-icloud-setup-code");
}

async function hideSetupMenu(context) {
  if (context.menu.state !== "closed") {
    const hidden = BrowserTestUtils.waitForPopupEvent(context.menu, "hidden");
    context.menu.hidePopup();
    await hidden;
  }
}

async function activateSetupItem(context, id = "context-icloud-setup-code") {
  const item = document.getElementById(id);
  ok(item, "The requested chrome command is offered");
  const before = context.activations.callCount;
  context.menu.activateItem(item);
  await TestUtils.waitForCondition(
    () => context.activations.callCount === before + 1,
    "A trusted menu command admits exactly one action"
  );
  return context.activations.lastCall.returnValue;
}

add_task(async function test_setup_localizes_detached_items_before_insertion() {
  for (const dismiss of [false, true]) {
    let release;
    let localized;
    let detachedItems;
    await withSetupTest(
      async context => {
        try {
          const shown = BrowserTestUtils.waitForPopupEvent(
            context.menu,
            "shown"
          );
          await BrowserTestUtils.synthesizeMouseAtCenter(
            "#setup-link",
            { type: "contextmenu", button: 2 },
            context.browser
          );
          await shown;
          const ready = context.controller.whenReady(context.menu);
          await TestUtils.waitForCondition(
            () => !!release,
            "Detached menu localization is pending"
          );
          ok(
            detachedItems.every(item => !item.isConnected),
            "Menu commands stay detached while localization is pending"
          );
          if (dismiss) {
            await hideSetupMenu(context);
          }
          release();
          await localized;
          await ready;
          if (dismiss) {
            ok(
              detachedItems.every(item => !item.isConnected),
              "A late translation never inserts into a dismissed menu"
            );
          } else {
            ok(
              detachedItems.every(
                item =>
                  item.parentNode === context.menu &&
                  item.getAttribute("label")?.trim()
              ),
              "Both commands are localized before insertion"
            );
          }
        } finally {
          release?.();
        }
      },
      {
        localize(document, items) {
          detachedItems = items;
          localized = new Promise(resolve => {
            release = resolve;
          }).then(() => document.l10n.translateElements(items));
          return localized;
        },
      }
    );
  }
});

add_task(
  { skip_if: () => Services.appinfo.OS !== "Darwin" },
  async function test_setup_native_menu_has_no_duplicate_commands() {
    for (const canSetUp of [true, false]) {
      await withSetupTest(async context => {
        const actor =
          context.browser.browsingContext.currentWindowGlobal.getActor(
            "ICloudPasswordsSetup"
          );
        context.sandbox.stub(actor, "inspect").resolves({
          handle: "native-menu-fixture",
          canSetUp,
        });
        const batches = [];
        const observer = new MutationObserver(records => {
          for (const record of records) {
            batches.push(Array.from(record.addedNodes));
          }
        });
        observer.observe(context.menu, { childList: true });
        try {
          await openSetupMenu(context, "#setup-link");
          await TestUtils.waitForTick();
        } finally {
          observer.disconnect();
        }
        const ids = [
          ...(canSetUp ? ["context-icloud-setup-code"] : []),
          "context-icloud-open-site",
        ];
        const group = ids.map(id => document.getElementById(id));
        group.unshift(group[0].previousElementSibling);
        const popup = document.createXULElement("menupopup");
        const baseline = document.createXULElement("menuitem");
        baseline.id = "native-menu-baseline";
        baseline.setAttribute("label", "Baseline");
        popup.appendChild(baseline);
        const nativeMenu = Cc[
          "@mozilla.org/widget/standalonenativemenu;1"
        ].createInstance(Ci.nsIStandaloneNativeMenu);
        nativeMenu.init(popup);
        popup.addEventListener(
          "popupshown",
          () => {
            // Replay the controller's batching while Cocoa considers the menu open.
            for (const batch of batches) {
              const clones = batch
                .filter(node => group.includes(node))
                .map(node => node.cloneNode(true));
              if (clones.length === 1) {
                popup.appendChild(clones[0]);
              } else if (clones.length) {
                const fragment = document.createDocumentFragment();
                fragment.append(...clones);
                popup.appendChild(fragment);
              }
            }
          },
          { once: true }
        );
        const commands = [];
        popup.addEventListener("command", event => {
          commands.push(event.target.id);
        });
        try {
          for (let opening = 0; opening < 2; opening++) {
            nativeMenu.menuWillOpen();
            commands.length = 0;
            nativeMenu.activateNativeMenuItemAt("0");
            for (let index = 0; index < ids.length; index++) {
              nativeMenu.activateNativeMenuItemAt(String(index + 2));
            }
            Assert.deepEqual(
              commands,
              [baseline.id, ...ids],
              "Native commands occur exactly once in controller order"
            );
            Assert.throws(
              () => nativeMenu.activateNativeMenuItemAt(String(ids.length + 2)),
              /NS_ERROR_FAILURE/,
              "No duplicate or extra native item follows the final command"
            );
          }
        } finally {
          popup.replaceChildren();
        }
      });
    }
  }
);

add_task(async function test_setup_direct_links_and_private_handles() {
  for (const selector of ["#setup-link", "#setup-apple-link"]) {
    await withSetupTest(async context => {
      const item = await openSetupMenu(context, selector);
      ok(item, "A strict TOTP URI is recognized");
      ok(
        !item.outerHTML.includes(SETUP_KEY),
        "The menu contains no seed or URI"
      );
      const actor = context.actor;
      const inspect = context.sandbox.spy(actor, "inspect");
      await hideSetupMenu(context);
      ok(
        !document.getElementById("context-icloud-setup-code"),
        "Dismissal removes the setup item"
      );
      await openSetupMenu(context, selector);
      const opaque = (await inspect.lastCall.returnValue).handle;
      ok(
        typeof opaque === "string" && !opaque.includes(SETUP_KEY),
        "Only an opaque handle crosses into chrome UI"
      );
      const result = await activateSetupItem(context);
      is(
        result.status,
        "dispatched",
        "Native confirmation owns the dispatch result"
      );
      is(context.setup.callCount, 1, "Enrollment is dispatched once");
      const [origin, uri, owner] = context.setup.firstCall.args;
      is(
        origin,
        "https://example.com",
        "Only the exact HTTPS origin is supplied"
      );
      is(
        uri,
        SETUP_URI.replace(
          /^otpauth:/,
          selector.includes("apple") ? "apple-otpauth:" : "otpauth:"
        ),
        "The validated fixture URI reaches the provider without account guessing"
      );
      is(
        owner,
        window,
        "Native confirmation is parented to the browser window"
      );
      is(
        context.confirm.callCount,
        0,
        "A full URI does not require guessed-settings confirmation"
      );
      is(
        (await actor.activate(opaque, "setup", window, () => true)).status,
        "stale",
        "A handle cannot be replayed"
      );
    });
  }
});

add_task(async function test_setup_rendered_qr_targets() {
  for (const selector of [
    "#setup-image",
    "#setup-canvas",
    "#setup-svg",
    "#setup-tainted",
  ]) {
    await withSetupTest(async context => {
      ok(
        await openSetupMenu(context, selector),
        "The exact rendered QR target is recognized"
      );
      const result = await activateSetupItem(context);
      is(result.status, "dispatched", "Rendered QR enrollment dispatches");
      is(
        context.setup.callCount,
        1,
        "Only a user command dispatches the QR URI"
      );
      is(
        context.setup.firstCall.args[1],
        SETUP_URI,
        "Off-thread decoding recovers the synthetic payload"
      );
    });
  }
});

add_task(
  async function test_setup_plain_selection_cancellation_and_confirmation() {
    for (const accept of [false, true]) {
      await withSetupTest(async context => {
        context.confirm.resolves(
          new Map([["buttonNumClicked", accept ? 0 : 1]])
        );
        await SpecialPowers.spawn(context.browser, [], () => {
          const text = content.document.getElementById("setup-key").firstChild;
          const range = content.document.createRange();
          range.selectNodeContents(text);
          const selection = content.document.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        });
        ok(
          await openSetupMenu(context, "#setup-key"),
          "A selected, bounded plaintext Base32 key is recognized"
        );
        is(
          context.confirm.callCount,
          0,
          "Inspection does not prompt for enrollment"
        );
        const result = await activateSetupItem(context);
        is(
          result.status,
          accept ? "dispatched" : "cancelled",
          "The user explicitly chooses standard settings"
        );
        is(
          context.setup.callCount,
          accept ? 1 : 0,
          "Cancel is not an enrollment"
        );
        const args = context.confirm.firstCall.args;
        ok(
          args[4] & Ci.nsIPromptService.BUTTON_POS_1_DEFAULT,
          "Cancel is the default button"
        );
        ok(
          !args.some(
            value => typeof value === "string" && value.includes(SETUP_KEY)
          ),
          "The prompt never displays the key"
        );
        if (accept) {
          const uri = new URL(context.setup.firstCall.args[1]);
          is(
            uri.pathname,
            "/example.com",
            "The site hostname is a display label, not a username"
          );
          is(
            uri.searchParams.get("algorithm"),
            "SHA1",
            "The confirmed algorithm is explicit"
          );
          is(
            uri.searchParams.get("digits"),
            "6",
            "The confirmed digit count is explicit"
          );
          is(
            uri.searchParams.get("period"),
            "30",
            "The confirmed period is explicit"
          );
          ok(
            !uri.searchParams.has("username"),
            "No account identity is fabricated"
          );
        }
      });
    }
  }
);

add_task(async function test_setup_unknown_targets_and_contextual_manager() {
  await withSetupTest(async context => {
    ok(
      !(await openSetupMenu(context, "#setup-invalid-link")),
      "HOTP does not offer TOTP enrollment"
    );
    await hideSetupMenu(context);
    ok(
      !(await openSetupMenu(context, "#setup-plain")),
      "Ordinary text offers no setup action"
    );
    const result = await activateSetupItem(context, "context-icloud-open-site");
    is(
      result.status,
      "dispatched",
      "The contextual manager is a separate explicit action"
    );
    is(context.manager.callCount, 1, "The manager opens once");
    is(
      context.manager.firstCall.args[0],
      "https://example.com",
      "The manager gets an origin without the page path or query"
    );
    is(
      context.setup.callCount,
      0,
      "Manager navigation does not enroll anything"
    );
  });
});

add_task(async function test_setup_pref_gates() {
  for (const pref of [
    "waterfox.passwords.icloud.enabled",
    "waterfox.passwords.icloud.otp.enabled",
  ]) {
    await withSetupTest(async context => {
      await SpecialPowers.pushPrefEnv({ set: [[pref, false]] });
      try {
        ok(
          !(await openSetupMenu(context, "#setup-link")),
          "The disabled feature never offers enrollment"
        );
        is(
          !!document.getElementById("context-icloud-open-site"),
          pref.endsWith("otp.enabled"),
          "The manager remains available when only code enrollment is disabled"
        );
      } finally {
        await hideSetupMenu(context);
        await SpecialPowers.popPrefEnv();
      }
    });
  }
  await withSetupTest(async context => {
    ok(await openSetupMenu(context, "#setup-link"), "Setup starts enabled");
    await SpecialPowers.pushPrefEnv({
      set: [["waterfox.passwords.icloud.otp.enabled", false]],
    });
    try {
      ok(
        !document.getElementById("context-icloud-setup-code"),
        "Disabling a pref revokes an open menu"
      );
      is(context.setup.callCount, 0, "Revocation never dispatches");
    } finally {
      await SpecialPowers.popPrefEnv();
    }
  });
});

add_task(async function test_setup_unsupported_provider_is_inert() {
  await withSetupTest(async context => {
    context.setSupported(false);
    ok(
      !(await openSetupMenu(context, "#setup-link")),
      "An unsupported provider offers no enrollment"
    );
    ok(
      !document.getElementById("context-icloud-open-site"),
      "An unsupported provider offers no manager action"
    );
  });
});

add_task(
  async function test_setup_rejects_insecure_context_and_synthetic_events() {
    await withSetupTest(
      async context => {
        ok(
          !(await openSetupMenu(context, "#setup-invalid-link")),
          "An HTTP document cannot enroll"
        );
        ok(
          !document.getElementById("context-icloud-open-site"),
          "An HTTP document gets no contextual manager action"
        );
      },
      { insecure: true }
    );
    await withSetupTest(async context => {
      await SpecialPowers.spawn(context.browser, [], () => {
        ok(
          !content.wrappedJSObject.icloudSetupSyntheticContextMenu(),
          "The page-created contextmenu event is untrusted"
        );
      });
      await TestUtils.waitForTick();
      is(
        context.menu.state,
        "closed",
        "Synthetic page context menus are not authority"
      );
      ok(
        await openSetupMenu(context, "#setup-link"),
        "A real user context menu works"
      );
      is(
        context.setup.callCount,
        0,
        "Page events and inspection cannot dispatch setup"
      );
    });
  }
);

add_task(async function test_setup_rejects_stale_target_and_changed_qr() {
  for (const change of ["replace", "href", "canvas"]) {
    await withSetupTest(async context => {
      const selector = change === "canvas" ? "#setup-canvas" : "#setup-link";
      ok(
        await openSetupMenu(context, selector),
        "The original candidate is recognized"
      );
      await SpecialPowers.spawn(context.browser, [change], operation => {
        const doc = content.document;
        const target = doc.getElementById(
          operation === "canvas" ? "setup-canvas" : "setup-link"
        );
        if (operation === "replace") {
          target.replaceWith(target.cloneNode(true));
        } else if (operation === "href") {
          target.href = "https://example.com/changed";
        } else {
          target.getContext("2d").clearRect(0, 0, target.width, target.height);
        }
      });
      const result = await activateSetupItem(context);
      is(
        result.status,
        "stale",
        "A replaced, changed, or repainted target is rejected"
      );
      is(
        context.setup.callCount,
        0,
        "A stale target never reaches the native provider"
      );
    });
  }
});

add_task(
  async function test_setup_revokes_during_tab_switch_navigation_and_confirmation() {
    for (const change of ["tab", "navigation", "selection"]) {
      await withSetupTest(async context => {
        await SpecialPowers.spawn(context.browser, [], () => {
          const range = content.document.createRange();
          range.selectNodeContents(
            content.document.getElementById("setup-key").firstChild
          );
          const selection = content.document.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        });
        let finishConfirmation;
        context.confirm.callsFake(
          () =>
            new Promise(resolve => {
              finishConfirmation = resolve;
            })
        );
        ok(
          await openSetupMenu(context, "#setup-key"),
          "A key is recognized before confirmation"
        );
        const action = activateSetupItem(context);
        await TestUtils.waitForCondition(
          () => !!finishConfirmation,
          "Settings confirmation is pending"
        );
        let otherTab;
        try {
          if (change === "tab") {
            otherTab = await BrowserTestUtils.openNewForegroundTab(
              gBrowser,
              "about:blank"
            );
          } else if (change === "navigation") {
            await BrowserTestUtils.loadURIString({
              browser: context.browser,
              uriString: SETUP_PAGE + "?changed",
            });
          } else {
            await SpecialPowers.spawn(context.browser, [], () =>
              content.document.getSelection().removeAllRanges()
            );
          }
          finishConfirmation(new Map([["buttonNumClicked", 0]]));
          is(
            (await action).status,
            "stale",
            "A changed tab, document, or selection revokes pending enrollment"
          );
          is(
            context.setup.callCount,
            0,
            "Stale confirmation cannot dispatch setup"
          );
        } finally {
          finishConfirmation(new Map([["buttonNumClicked", 1]]));
          if (otherTab) {
            await BrowserTestUtils.removeTab(otherTab);
          }
        }
      });
    }
  }
);

add_task(async function test_setup_inspection_race_and_dismissed_handle() {
  await withSetupTest(async context => {
    await openSetupMenu(context, "#setup-link");
    const actor = context.actor;
    const inspect = context.sandbox.spy(actor, "inspect");
    await hideSetupMenu(context);
    await openSetupMenu(context, "#setup-link");
    const handle = (await inspect.lastCall.returnValue).handle;
    await hideSetupMenu(context);
    is(
      (await actor.activate(handle, "manager", window, () => true)).status,
      "stale",
      "Dismissal revokes even manager handles"
    );

    let release;
    inspect.restore();
    const original = actor.inspect.bind(actor);
    context.sandbox.stub(actor, "inspect").callsFake(async options => {
      const result = await original(options);
      await new Promise(resolve => {
        release = resolve;
      });
      return result;
    });
    const shown = BrowserTestUtils.waitForPopupEvent(context.menu, "shown");
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#setup-link",
      { type: "contextmenu", button: 2 },
      context.browser
    );
    await shown;
    const ready = context.controller.whenReady(context.menu);
    await TestUtils.waitForCondition(
      () => !!release,
      "Inspection is paused after recognition"
    );
    await hideSetupMenu(context);
    release();
    await ready;
    ok(
      !document.getElementById("context-icloud-setup-code"),
      "A late result cannot repopulate a dismissed menu"
    );
  });
});

add_task(async function test_setup_https_frame_requires_secure_ancestors() {
  for (const insecure of [false, true]) {
    await withSetupTest(
      async context => {
        const loaded = BrowserTestUtils.browserLoaded(context.browser, {
          includeSubFrames: true,
          wantLoad: SETUP_PAGE,
        });
        await SpecialPowers.spawn(context.browser, [SETUP_PAGE], page => {
          const frame = content.document.createElement("iframe");
          frame.width = 700;
          frame.height = 160;
          frame.src = page;
          content.document.body.replaceChildren(frame);
        });
        await loaded;
        const frame = context.browser.browsingContext.children[0];
        await SpecialPowers.spawn(frame, [SETUP_URI], uri => {
          content.document.getElementById("setup-link").href = uri;
        });
        const shown = BrowserTestUtils.waitForPopupEvent(context.menu, "shown");
        await BrowserTestUtils.synthesizeMouseAtCenter(
          "#setup-link",
          {
            type: "contextmenu",
            button: 2,
          },
          frame
        );
        await shown;
        await context.controller.whenReady(context.menu);
        is(
          !!document.getElementById("context-icloud-setup-code"),
          !insecure,
          "A secure target frame cannot bypass an insecure ancestor"
        );
        is(
          !!document.getElementById("context-icloud-open-site"),
          !insecure,
          "The contextual manager also requires secure ancestors"
        );
        is(context.setup.callCount, 0, "Frame inspection never enrolls");
      },
      { insecure }
    );
  }
});

add_task(
  async function test_setup_native_wait_revalidates_target_and_errors_are_sanitized() {
    await withSetupTest(async context => {
      let release;
      let stillCurrent;
      let dispatched = false;
      context.setup.callsFake(
        async (origin, uri, owner, { isCurrent, beforeDispatch }) => {
          stillCurrent = isCurrent;
          await new Promise(resolve => {
            release = resolve;
          });
          const accepted = !beforeDispatch || (await beforeDispatch()) === true;
          dispatched = accepted && isCurrent();
          return { dispatched };
        }
      );
      ok(
        await openSetupMenu(context, "#setup-link"),
        "The original link is recognized"
      );
      const action = activateSetupItem(context);
      await TestUtils.waitForCondition(
        () => !!release,
        "The mocked native operation is pending"
      );
      try {
        await SpecialPowers.spawn(context.browser, [], () => {
          content.document.getElementById("setup-link").remove();
        });
        await TestUtils.waitForCondition(
          () => !stillCurrent(),
          "Target invalidation reaches the provider's current-scope callback"
        );
      } finally {
        release();
      }
      is(
        (await action).status,
        "stale",
        "An asynchronous native wait cannot outlive its target"
      );
      ok(!dispatched, "The mock does not dispatch after target revocation");
      is(
        context.alert.callCount,
        0,
        "Staleness does not surface as a native error"
      );
    });
    await withSetupTest(async context => {
      context.setup.rejects({ code: "native-error", message: SETUP_KEY });
      await openSetupMenu(context, "#setup-link");
      is(
        (await activateSetupItem(context)).status,
        "failed",
        "A native failure has a sanitized status"
      );
      await TestUtils.waitForCondition(
        () => context.alert.called,
        "The explicit user action gets a localized error"
      );
      ok(
        !context.alert.firstCall.args.some(
          value => typeof value === "string" && value.includes(SETUP_KEY)
        ),
        "The native error's message and seed never reach UI"
      );
    });
  }
);

add_task(
  async function test_setup_final_dispatch_rechecks_canvas_after_native_wait() {
    const { QR } = ChromeUtils.importESModule(
      "moz-src:///toolkit/components/qrcode/encoder.mjs"
    );
    const { matrix } = QR.encodeToMatrix(
      SETUP_URI.replace(SETUP_KEY, "B".repeat(32)),
      "M"
    );
    for (const [action, change] of [
      ["setup", "unchanged"],
      ["setup", "repaint"],
      ["setup", "clear"],
      ["manager", "repaint"],
    ]) {
      await withSetupTest(async context => {
        let release;
        let stillCurrent;
        let guardResult;
        let dispatched;
        async function waitBeforeWrite({ isCurrent, beforeDispatch }) {
          stillCurrent = isCurrent;
          await new Promise(resolve => {
            release = resolve;
          });
          guardResult = await beforeDispatch();
          dispatched = guardResult === true && isCurrent();
          return { dispatched };
        }
        context.setup.callsFake((origin, uri, owner, options) =>
          waitBeforeWrite(options)
        );
        context.manager.callsFake((origin, options) =>
          waitBeforeWrite(options)
        );
        ok(
          await openSetupMenu(context, "#setup-canvas"),
          "The original rendered QR is recognized before the native wait"
        );
        const id =
          action === "setup"
            ? "context-icloud-setup-code"
            : "context-icloud-open-site";
        const pending = activateSetupItem(context, id);
        await TestUtils.waitForCondition(
          () => !!release,
          "The mocked provider is waiting before its final queue write"
        );
        try {
          await SpecialPowers.spawn(
            context.browser,
            [change, matrix],
            async (operation, dots) => {
              const canvas = content.document.getElementById("setup-canvas");
              const painter = canvas.getContext("2d");
              if (operation === "clear") {
                painter.clearRect(0, 0, canvas.width, canvas.height);
              } else if (operation === "repaint") {
                const cell = 4;
                const margin = 4;
                painter.fillStyle = "white";
                painter.fillRect(0, 0, canvas.width, canvas.height);
                painter.fillStyle = "black";
                for (let y = 0; y < dots.length; y++) {
                  for (let x = 0; x < dots.length; x++) {
                    if (dots[y][x]) {
                      painter.fillRect(
                        (x + margin) * cell,
                        (y + margin) * cell,
                        cell,
                        cell
                      );
                    }
                  }
                }
              }
              await new Promise(resolve =>
                content.requestAnimationFrame(() =>
                  content.requestAnimationFrame(resolve)
                )
              );
            }
          );
          is(
            stillCurrent(),
            true,
            "Pixel changes leave the synchronous document-and-target scope current"
          );
        } finally {
          release();
        }
        const result = await pending;
        const unchanged = change === "unchanged";
        is(
          guardResult,
          unchanged,
          "The final guard accepts only the originally selected QR payload"
        );
        is(dispatched, unchanged, "Changed pixels cannot dispatch");
        is(
          result.status,
          unchanged ? "dispatched" : "stale",
          "The actor reports the guarded operation without claiming storage"
        );
      });
    }
  }
);

add_task(async function test_setup_destroy_revokes_pending_menu() {
  await withSetupTest(async context => {
    const inspect = context.sandbox.spy(
      context.browser.browsingContext.currentWindowGlobal.getActor(
        "ICloudPasswordsSetup"
      ),
      "inspect"
    );
    try {
      await openSetupMenu(context, "#setup-link");
      const { handle } = await inspect.lastCall.returnValue;
      context.controller.destroy();
      ok(
        !document.getElementById("context-icloud-setup-code"),
        "Destroy removes contextual UI"
      );
      is(
        (await context.actor.activate(handle, "setup", window, () => true))
          .status,
        "stale",
        "Destroy revokes pending handles"
      );
    } finally {
      context.controller.init();
    }
  });
});

add_task(async function test_setup_worker_limits_timeout_and_abort() {
  const { decodeICloudSetupQR } = ChromeUtils.importESModule(
    "resource:///modules/ICloudPasswordsSetupParent.sys.mjs"
  );
  const pixels = () => ({
    width: 16,
    height: 16,
    data: new Uint8ClampedArray(16 * 16 * 4),
  });
  let created = 0;
  let terminated = 0;
  const workerFactory = () => {
    created++;
    return {
      postMessage() {},
      terminate() {
        terminated++;
      },
    };
  };
  is(
    await decodeICloudSetupQR({ ...pixels(), width: 1025 }, { workerFactory }),
    null,
    "Oversized dimensions are rejected before worker creation"
  );
  is(
    await decodeICloudSetupQR(
      { ...pixels(), data: new Uint8ClampedArray(1) },
      { workerFactory }
    ),
    null,
    "Invalid pixel lengths are rejected"
  );
  is(
    await decodeICloudSetupQR(
      {
        ...pixels(),
        data: new Uint8ClampedArray(new ArrayBuffer(2048), 0, 1024),
      },
      { workerFactory }
    ),
    null,
    "A bounded view cannot smuggle an oversized backing buffer"
  );
  is(created, 0, "Rejected requests never start a worker");
  is(
    await decodeICloudSetupQR(pixels(), { workerFactory, timeout: 1 }),
    null,
    "A stalled decode times out"
  );
  is(terminated, 1, "A timed-out worker is terminated");
  const abort = new AbortController();
  const pending = decodeICloudSetupQR(pixels(), {
    workerFactory,
    signal: abort.signal,
  });
  abort.abort();
  is(await pending, null, "A revoked scope cancels decoding");
  is(terminated, 2, "An aborted worker is terminated");
  is(
    await decodeICloudSetupQR(pixels(), {
      workerFactory,
      signal: abort.signal,
    }),
    null,
    "An already-aborted scope starts no work"
  );
  is(created, 2, "No worker starts after cancellation");

  for (const request of [
    { width: 1025, height: 16, rgba: new Uint8ClampedArray(0) },
    { width: 16, height: 16, rgba: new Uint8ClampedArray(3) },
    { width: Infinity, height: 16, rgba: new Uint8ClampedArray(0) },
    {
      width: 16,
      height: 16,
      rgba: new Uint8ClampedArray(new ArrayBuffer(2048), 0, 1024),
    },
  ]) {
    const worker = new ChromeWorker(SETUP_WORKER);
    let result;
    let failed = false;
    try {
      worker.onmessage = event => {
        result = event.data;
      };
      worker.onerror = event => {
        event.preventDefault();
        failed = true;
      };
      worker.postMessage(request);
      await TestUtils.waitForCondition(
        () => result || failed,
        "The one-shot worker replies or fails"
      );
      ok(!failed, "The worker handles invalid input without an error event");
      is(
        result?.uri,
        null,
        "The actual worker independently rejects invalid buffers"
      );
    } finally {
      worker.terminate();
    }
  }
});
