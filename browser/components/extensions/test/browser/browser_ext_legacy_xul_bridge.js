"use strict";

const EXTENSION_ID = "legacy-xul-bridge@test.invalid";
const LEGACY_PACKAGE = "legacybridgetest";
const LEGACY_SKIN_ALIAS = "legacybridgealiastest";
const LEGACY_RESOURCE = "legacybridgeres";
const CONTENT_PROCESS_RESOURCE = "legacybridgecontentres";
const BROWSER_URL = "chrome://browser/content/browser.xhtml";

const { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);

const { Overlays } = ChromeUtils.importESModule(
  "resource:///modules/Overlays.sys.mjs"
);

function getManifest(id = EXTENSION_ID, type = "bootstrap") {
  return {
    manifest_version: 2,
    name: "Legacy XUL bridge test",
    version: "1.0",
    browser_specific_settings: {
      gecko: { id },
    },
    legacy: { type },
  };
}

function assertLegacyOverlay(win, description) {
  const toolbox = win.document.getElementById("navigator-toolbox");
  const before = win.document.getElementById("legacy-bridge-before");
  const after = win.document.getElementById("legacy-bridge-after");
  const forwardTarget = win.document.getElementById(
    "legacy-bridge-forward-target"
  );
  const forwardChild = win.document.getElementById(
    "legacy-bridge-forward-child"
  );

  is(
    toolbox.getAttribute("data-legacy-bridge"),
    "applied",
    `${description}: existing node attributes were merged`
  );
  ok(before, `${description}: the first overlay node was inserted`);
  ok(after, `${description}: the second overlay node was inserted`);
  Assert.ok(forwardTarget, `${description}: the forward target was inserted`);
  Assert.ok(forwardChild, `${description}: the forward child was inserted`);
  is(
    before.nextElementSibling,
    after,
    `${description}: insertafter was honored`
  );
  is(
    after.nextElementSibling,
    forwardTarget,
    `${description}: the forward target was inserted after earlier hooks`
  );
  is(
    forwardTarget.nextElementSibling,
    win.document.getElementById("toolbar-menubar"),
    `${description}: insertbefore was honored`
  );
  is(
    forwardChild.parentNode,
    forwardTarget,
    `${description}: a forward reference across overlays was resolved`
  );
  ok(
    !win.document.getElementById("customizationPanel"),
    `${description}: removeelement removed an existing node`
  );

  const style = win.getComputedStyle(toolbox);
  is(
    style.getPropertyValue("--legacy-manifest-sheet").trim(),
    "applied",
    `${description}: the manifest style directive was applied`
  );
  is(
    style.getPropertyValue("--legacy-overlay-sheet").trim(),
    "applied",
    `${description}: the xml-stylesheet directive was applied`
  );
}

function assertLegacyOverlayRemoved(win, description) {
  const toolbox = win.document.getElementById("navigator-toolbox");
  ok(
    !win.document.getElementById("legacy-bridge-before"),
    `${description}: inserted nodes were removed`
  );
  ok(
    !win.document.getElementById("legacy-bridge-after"),
    `${description}: all inserted nodes were removed`
  );
  ok(
    !win.document.getElementById("legacy-bridge-forward-target"),
    `${description}: the forward-reference target was removed`
  );
  ok(
    !toolbox.hasAttribute("data-legacy-bridge"),
    `${description}: merged attributes were restored`
  );
  ok(
    win.document.getElementById("customizationPanel"),
    `${description}: removeelement was reversed`
  );

  const style = win.getComputedStyle(toolbox);
  is(
    style.getPropertyValue("--legacy-manifest-sheet").trim(),
    "",
    `${description}: the manifest stylesheet was removed`
  );
  is(
    style.getPropertyValue("--legacy-overlay-sheet").trim(),
    "",
    `${description}: the overlay stylesheet was removed`
  );
}

add_task(async function test_signed_legacy_extension_is_rejected() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: getManifest("signed-legacy-xul-bridge@test.invalid", "xul"),
    files: { "chrome.manifest": "" },
  });

  await Assert.rejects(
    extension.startup(),
    /startup failed/,
    "An ordinary signed WebExtension cannot activate the legacy bridge"
  );
});

add_task(async function test_legacy_key_is_rejected_for_themes() {
  const manifest = getManifest("legacy-theme@test.invalid");
  manifest.theme = {
    colors: {
      frame: "#000000",
      tab_background_text: "#ffffff",
    },
  };

  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest,
    files: { "bootstrap.js": "" },
  });

  await Assert.rejects(
    extension.startup(),
    /startup failed/,
    "The legacy key is limited to extension manifests"
  );
});

add_task(async function test_legacy_xul_bridge() {
  const originalRemovedNode = document.getElementById("customizationPanel");
  Assert.ok(originalRemovedNode, "The removeelement test target exists");
  const originalRemovedParent = originalRemovedNode.parentNode;

  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: getManifest(),
    files: {
      "bootstrap.js": "",
      "chrome.manifest": `
        content ${LEGACY_PACKAGE} content/
        skin ${LEGACY_PACKAGE} classic/1.0 skin/
        skin ${LEGACY_SKIN_ALIAS} classic/1.0 chrome://${LEGACY_PACKAGE}/skin/
        resource ${LEGACY_RESOURCE} resources/ process=main contentaccessible=yes
        resource ${CONTENT_PROCESS_RESOURCE} resources/ process=content
        override chrome://${LEGACY_PACKAGE}/content/original.txt chrome://${LEGACY_PACKAGE}/content/replacement.txt
        overlay ${BROWSER_URL} chrome://${LEGACY_PACKAGE}/content/overlay.xhtml
        overlay ${BROWSER_URL} chrome://${LEGACY_PACKAGE}/content/forward-target.xhtml
        overlay about:newtab chrome://${LEGACY_PACKAGE}/content/newtab-overlay.xhtml
        manifest nested/chrome.manifest application=${Services.appinfo.ID}
      `,
      "nested/chrome.manifest": `
        style ${BROWSER_URL} chrome://${LEGACY_PACKAGE}/skin/manifest.css os=${Services.appinfo.OS}
      `,
      "content/original.txt": "original",
      "content/replacement.txt": "replacement",
      "content/overlay.xhtml": `<?xml version="1.0"?>
        <?xml-stylesheet href="chrome://${LEGACY_PACKAGE}/skin/overlay.css" type="text/css"?>
        <overlay xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul">
          <toolbox id="navigator-toolbox" data-legacy-bridge="applied">
            <hbox id="legacy-bridge-before" insertbefore="toolbar-menubar" hidden="true" />
            <hbox id="legacy-bridge-after" insertafter="legacy-bridge-before" hidden="true" />
          </toolbox>
          <template id="customizationPanel" removeelement="true" />
          <hbox id="legacy-bridge-forward-target">
            <label id="legacy-bridge-forward-child" value="resolved" />
          </hbox>
        </overlay>`,
      "content/forward-target.xhtml": `<?xml version="1.0"?>
        <overlay xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul">
          <hbox id="legacy-bridge-forward-target" insertbefore="toolbar-menubar" hidden="true" />
        </overlay>`,
      "content/newtab-overlay.xhtml": `<?xml version="1.0"?>
        <overlay xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul">
          <box id="legacy-bridge-newtab-injection" />
        </overlay>`,
      "resources/data.txt": "resource",
      "skin/manifest.css": `
        #navigator-toolbox { --legacy-manifest-sheet: applied; }
      `,
      "skin/overlay.css": `
        #navigator-toolbox { --legacy-overlay-sheet: applied; }
      `,
    },
  });

  let newWindow;
  let newTab;
  let started = false;

  try {
    await extension.startup();
    started = true;
    ok(
      ExtensionSupport.loadedBootstrapExtensions.has(EXTENSION_ID),
      "The compatibility bootstrap state tracks the running extension"
    );

    const chromeRegistry = Cc[
      "@mozilla.org/chrome/chrome-registry;1"
    ].getService(Ci.nsIChromeRegistry);
    const resourceProtocol = Services.io
      .getProtocolHandler("resource")
      .QueryInterface(Ci.nsIResProtocolHandler);
    const contentURI = Services.io.newURI(
      `chrome://${LEGACY_PACKAGE}/content/replacement.txt`
    );
    const originalURI = Services.io.newURI(
      `chrome://${LEGACY_PACKAGE}/content/original.txt`
    );
    const skinURI = Services.io.newURI(
      `chrome://${LEGACY_PACKAGE}/skin/manifest.css`
    );
    const aliasSkinURI = Services.io.newURI(
      `chrome://${LEGACY_SKIN_ALIAS}/skin/manifest.css`
    );

    const replacement = chromeRegistry.convertChromeURL(contentURI).spec;
    ok(
      replacement.endsWith("/content/replacement.txt"),
      "The legacy content package was registered"
    );
    is(
      chromeRegistry.convertChromeURL(originalURI).spec,
      contentURI.spec,
      "The legacy override was registered"
    );
    ok(
      chromeRegistry
        .convertChromeURL(skinURI)
        .spec.endsWith("/skin/manifest.css"),
      "The local skin file override was registered"
    );
    is(
      chromeRegistry.convertChromeURL(aliasSkinURI).spec,
      chromeRegistry.convertChromeURL(skinURI).spec,
      "The skin-to-skin alias resolved to the local skin file"
    );

    ok(
      resourceProtocol.hasSubstitution(LEGACY_RESOURCE),
      "The process=main resource substitution was registered"
    );
    ok(
      !resourceProtocol.hasSubstitution(CONTENT_PROCESS_RESOURCE),
      "The process=content resource substitution was skipped"
    );
    const resourceURI = Services.io.newURI(
      `resource://${LEGACY_RESOURCE}/data.txt`
    );
    const resolvedResource = resourceURI.schemeIs("resource")
      ? resourceProtocol.resolveURI(resourceURI)
      : resourceURI.spec;
    ok(
      resolvedResource.endsWith("/resources/data.txt"),
      "The resource URL resolves inside the extension package"
    );

    assertLegacyOverlay(window, "existing window");

    newWindow = await BrowserTestUtils.openNewBrowserWindow();
    await TestUtils.waitForCondition(
      () => newWindow.document.getElementById("legacy-bridge-forward-child"),
      "Wait for the legacy overlay in the new browser window"
    );
    assertLegacyOverlay(newWindow, "new window");

    newTab = await BrowserTestUtils.openNewForegroundTab(
      gBrowser,
      "about:newtab",
      true
    );
    const injected = await SpecialPowers.spawn(
      newTab.linkedBrowser,
      [],
      () => !!content.document.getElementById("legacy-bridge-newtab-injection")
    );
    ok(!injected, "The remote about:newtab overlay target was skipped");

    await extension.unload();
    started = false;
    ok(
      !ExtensionSupport.loadedBootstrapExtensions.has(EXTENSION_ID),
      "The compatibility bootstrap state is cleared on unload"
    );

    assertLegacyOverlayRemoved(window, "existing window cleanup");
    assertLegacyOverlayRemoved(newWindow, "new window cleanup");
    is(
      document.getElementById("customizationPanel"),
      originalRemovedNode,
      "The original removed node was restored"
    );
    is(
      originalRemovedNode.parentNode,
      originalRemovedParent,
      "The removed node was restored to its original parent"
    );
    ok(
      !resourceProtocol.hasSubstitution(LEGACY_RESOURCE),
      "The owned resource substitution was removed on unload"
    );
    Assert.throws(
      () => chromeRegistry.convertChromeURL(contentURI),
      error => error.result === Cr.NS_ERROR_FILE_NOT_FOUND,
      "The content registration was removed on unload"
    );
  } finally {
    if (started) {
      await extension.unload();
    }

    if (newTab) {
      BrowserTestUtils.removeTab(newTab);
    }
    if (newWindow && !newWindow.closed) {
      await BrowserTestUtils.closeWindow(newWindow);
    }
  }
});

add_task(async function test_restartless_overlay_scripts_are_rejected() {
  const id = "legacy-overlay-script@test.invalid";
  const packageName = "legacyoverlayscripttest";
  const injectedNodeID = "legacy-overlay-script-injection";
  const marker = "__legacyOverlayScriptRuns";
  const toolbox = document.getElementById("navigator-toolbox");
  const hadMarker = Object.prototype.hasOwnProperty.call(window, marker);
  const originalMarker = window[marker];
  const extension = ExtensionTestUtils.loadExtension({
    useAddonManager: "temporary",
    manifest: getManifest(id),
    files: {
      "bootstrap.js": "",
      "chrome.manifest": `
        content ${packageName} content/
        overlay ${BROWSER_URL} chrome://${packageName}/content/overlay.xhtml
      `,
      "content/overlay.xhtml": `<?xml version="1.0"?>
        <overlay xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul">
          <toolbox id="navigator-toolbox" data-legacy-script-overlay="applied">
            <hbox id="${injectedNodeID}" />
          </toolbox>
          <script>window.${marker} = (window.${marker} || 0) + 1;</script>
        </overlay>`,
    },
  });

  window[marker] = 0;
  try {
    await Assert.rejects(
      extension.startup(),
      /startup failed/,
      "A restartless overlay containing script cannot start"
    );
    ok(
      !ExtensionSupport.loadedBootstrapExtensions.has(id),
      "A failed bootstrap startup is not exposed as loaded"
    );
    is(window[marker], 0, "The rejected overlay script did not execute");
    ok(
      !document.getElementById(injectedNodeID),
      "Nodes inserted before script validation were rolled back"
    );
    ok(
      !toolbox.hasAttribute("data-legacy-script-overlay"),
      "Attributes merged before script validation were rolled back"
    );
  } finally {
    try {
      await extension.unload();
    } catch {}
    if (hadMarker) {
      window[marker] = originalMarker;
    } else {
      delete window[marker];
    }
  }
});

function getAttributeOwnerExtension(scenarioIndex, ownerIndex) {
  const id = `legacy-xul-attribute-owner-${scenarioIndex}-${ownerIndex}@test.invalid`;
  const packageName = `legacybridgeattribute${scenarioIndex}${ownerIndex}`;
  const value = ownerIndex ? "second-owner" : "first-owner";

  return {
    id,
    value,
    extension: ExtensionTestUtils.loadExtension({
      useAddonManager: "temporary",
      manifest: getManifest(id),
      files: {
        "bootstrap.js": "",
        "chrome.manifest": `
          content ${packageName} content/
          overlay ${BROWSER_URL} chrome://${packageName}/content/overlay.xhtml
        `,
        "content/overlay.xhtml": `<?xml version="1.0"?>
          <overlay xmlns="http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul">
            <toolbox id="navigator-toolbox" data-legacy-attribute-owner="${value}" />
          </overlay>`,
      },
    }),
  };
}

add_task(async function test_legacy_overlay_attribute_owner_unload_orders() {
  const attribute = "data-legacy-attribute-owner";
  const baseValue = "base";
  const target = document.getElementById("navigator-toolbox");
  const hadAttribute = target.hasAttribute(attribute);
  const originalValue = target.getAttribute(attribute);
  const activeExtensions = new Set();
  let cleanupError;

  target.setAttribute(attribute, baseValue);

  try {
    const scenarios = [
      {
        label: "older owner unloaded first",
        order: [0, 1],
        remainingValue: "second-owner",
      },
      {
        label: "newer owner unloaded first",
        order: [1, 0],
        remainingValue: "first-owner",
      },
    ];

    for (
      let scenarioIndex = 0;
      scenarioIndex < scenarios.length;
      scenarioIndex++
    ) {
      const scenario = scenarios[scenarioIndex];
      const owners = [0, 1].map(ownerIndex =>
        getAttributeOwnerExtension(scenarioIndex, ownerIndex)
      );

      for (const owner of owners) {
        await owner.extension.startup();
        activeExtensions.add(owner.extension);
        is(
          target.getAttribute(attribute),
          owner.value,
          `${scenario.label}: the latest extension owns the attribute`
        );
      }

      const firstUnloaded = owners[scenario.order[0]];
      await firstUnloaded.extension.unload();
      activeExtensions.delete(firstUnloaded.extension);
      is(
        target.getAttribute(attribute),
        scenario.remainingValue,
        `${scenario.label}: unloading one extension restores the remaining owner`
      );

      const secondUnloaded = owners[scenario.order[1]];
      await secondUnloaded.extension.unload();
      activeExtensions.delete(secondUnloaded.extension);
      is(
        target.getAttribute(attribute),
        baseValue,
        `${scenario.label}: unloading both extensions restores the base value`
      );
    }
  } finally {
    for (const extension of [...activeExtensions].reverse()) {
      try {
        await extension.unload();
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (hadAttribute) {
      target.setAttribute(attribute, originalValue);
    } else {
      target.removeAttribute(attribute);
    }
  }

  if (cleanupError) {
    throw cleanupError;
  }
});

function parseOverlayDocument(source) {
  const overlayDocument = new DOMParser().parseFromString(
    source,
    "application/xml"
  );
  if (overlayDocument.documentElement.localName === "parsererror") {
    throw new Error(overlayDocument.documentElement.textContent);
  }
  return overlayDocument;
}

function getSourceCheckingProvider(allowedURLs, checkedURLs) {
  const allowed = new Set(allowedURLs);
  return {
    package: {
      resolveRegisteredURI(url) {
        checkedURLs.push(url);
        return allowed.has(url) ? Services.io.newURI(url) : null;
      },
    },
  };
}

add_task(async function test_overlays_reject_non_package_sources() {
  const injectedNodeID = "legacy-bridge-rejected-overlay-injection";
  const scriptMarker = "__legacyBridgeRejectedScriptRuns";
  const styleProperty = "--legacy-rejected-overlay-sheet";
  const toolbox = document.getElementById("navigator-toolbox");
  const hadScriptMarker = Object.prototype.hasOwnProperty.call(
    window,
    scriptMarker
  );
  const originalScriptMarker = window[scriptMarker];
  const overlays = [];
  const unrelatedOverlayURL = "chrome://global/content/commonDialog.xhtml";
  const scriptOverlayURL =
    "chrome://legacybridgesourcetest/content/script-overlay.xhtml";
  const stylesheetOverlayURL =
    "chrome://legacybridgesourcetest/content/stylesheet-overlay.xhtml";
  const scriptURL = Services.io.newURI(
    `data:application/javascript;charset=UTF-8,${encodeURIComponent(
      "window.__legacyBridgeRejectedScriptRuns += 1;"
    )}`
  ).spec;
  const stylesheetURL = Services.io.newURI(
    `data:text/css;charset=UTF-8,${encodeURIComponent(
      `#navigator-toolbox { ${styleProperty}: applied; }`
    )}`
  ).spec;

  window[scriptMarker] = 0;

  try {
    const overlayChecks = [];
    const rejectedOverlay = new Overlays(
      getSourceCheckingProvider([], overlayChecks),
      window
    );
    overlays.push(rejectedOverlay);
    let overlayFetches = 0;
    rejectedOverlay.fetchOverlay = async () => {
      overlayFetches++;
      return parseOverlayDocument(`<?xml version="1.0"?>
        <overlay xmlns="urn:legacy-xul-overlay-test">
          <toolbox id="navigator-toolbox">
            <hbox id="${injectedNodeID}" hidden="true" />
          </toolbox>
        </overlay>`);
    };

    await Assert.rejects(
      rejectedOverlay.load([unrelatedOverlayURL]),
      /Refusing to load overlay because it is not local to the overlay package/,
      "An unrelated overlay URL is rejected"
    );
    is(overlayFetches, 0, "The rejected overlay URL was not fetched");
    ok(
      overlayChecks.includes(unrelatedOverlayURL),
      "The overlay URL was checked against the provider package"
    );
    ok(
      !document.getElementById(injectedNodeID),
      "The rejected overlay did not inject any nodes"
    );

    const scriptChecks = [];
    const rejectedScript = new Overlays(
      getSourceCheckingProvider([scriptOverlayURL], scriptChecks),
      window
    );
    overlays.push(rejectedScript);
    rejectedScript.fetchOverlay = async () =>
      parseOverlayDocument(`<?xml version="1.0"?>
        <overlay xmlns="urn:legacy-xul-overlay-test">
          <script src="${scriptURL}" />
        </overlay>`);

    await Assert.rejects(
      rejectedScript.load([scriptOverlayURL]),
      /Refusing to load script because it is not local to the overlay package/,
      "An external overlay script URL is rejected"
    );
    ok(
      scriptChecks.includes(scriptURL),
      "The script URL was checked against the provider package"
    );
    is(window[scriptMarker], 0, "The rejected script did not execute");

    const stylesheetChecks = [];
    const rejectedStylesheet = new Overlays(
      getSourceCheckingProvider([stylesheetOverlayURL], stylesheetChecks),
      window
    );
    overlays.push(rejectedStylesheet);
    rejectedStylesheet.fetchOverlay = async () =>
      parseOverlayDocument(`<?xml version="1.0"?>
        <?xml-stylesheet href="${stylesheetURL}" type="text/css"?>
        <overlay xmlns="urn:legacy-xul-overlay-test" />`);

    await Assert.rejects(
      rejectedStylesheet.load([stylesheetOverlayURL]),
      /Refusing to load stylesheet because it is not local to the overlay package/,
      "An external overlay stylesheet URL is rejected"
    );
    ok(
      stylesheetChecks.includes(stylesheetURL),
      "The stylesheet URL was checked against the provider package"
    );
    is(
      window.getComputedStyle(toolbox).getPropertyValue(styleProperty).trim(),
      "",
      "The rejected stylesheet was not injected"
    );
  } finally {
    for (const overlay of overlays) {
      overlay._destroy();
    }
    document.getElementById(injectedNodeID)?.remove();
    try {
      window.windowUtils.removeSheetUsingURIString(
        stylesheetURL,
        window.windowUtils.AUTHOR_SHEET
      );
    } catch {}
    if (hadScriptMarker) {
      window[scriptMarker] = originalScriptMarker;
    } else {
      delete window[scriptMarker];
    }
  }
});

add_task(async function test_unregister_last_window_listener_queues_unload() {
  const listenerID = "legacy-xul-bridge-pending-load@test.invalid";
  const events = [];
  const loadStarted = Promise.withResolvers();
  const continueLoad = Promise.withResolvers();
  let loadCalls = 0;
  let unloadCalls = 0;
  let registered = false;

  try {
    is(
      ExtensionSupport.registeredWindowListenerCount,
      0,
      "The test starts without registered window listeners"
    );

    registered = ExtensionSupport.registerWindowListener(listenerID, {
      chromeURLs: [BROWSER_URL],
      async onLoadWindow(loadedWindow) {
        if (loadedWindow !== window) {
          return;
        }
        loadCalls++;
        events.push("load-start");
        loadStarted.resolve();
        await continueLoad.promise;
        events.push("load-end");
      },
      onUnloadWindow(unloadedWindow) {
        if (unloadedWindow !== window) {
          return;
        }
        unloadCalls++;
        events.push("unload");
      },
    });
    ok(registered, "The final window listener was registered");
    if (!registered) {
      return;
    }

    await loadStarted.promise;
    is(loadCalls, 1, "The asynchronous load callback started exactly once");

    const unregistered = ExtensionSupport.unregisterWindowListener(listenerID);
    ok(unregistered, "The final window listener was unregistered");
    if (!unregistered) {
      return;
    }
    registered = false;

    is(
      ExtensionSupport.registeredWindowListenerCount,
      0,
      "Unregistering removed the last listener immediately"
    );
    is(unloadCalls, 0, "The unload callback waits for the load callback");
    Assert.deepEqual(
      events,
      ["load-start"],
      "No unload callback ran while the load callback was pending"
    );

    continueLoad.resolve();
    await TestUtils.waitForCondition(
      () => unloadCalls === 1,
      "Wait for the queued unload callback"
    );
    await TestUtils.waitForTick();

    is(loadCalls, 1, "The load callback ran exactly once");
    is(unloadCalls, 1, "The unload callback ran exactly once");
    Assert.deepEqual(
      events,
      ["load-start", "load-end", "unload"],
      "The unload callback ran after the pending load callback"
    );
  } finally {
    continueLoad.resolve();
    if (registered) {
      ExtensionSupport.unregisterWindowListener(listenerID);
    }
    await TestUtils.waitForTick();
  }
});
