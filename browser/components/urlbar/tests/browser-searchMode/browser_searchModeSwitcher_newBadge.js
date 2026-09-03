/* Any copyright is dedicated to the Public Domain.
   https://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * Tests that the "New" badge is shown for new application-provided engines in
 * the Unified Search Button dropdown menu, but is hidden when the application-provided
 * engine has been overridden by a third-party engine.
 */

"use strict";

const { RemoteSettings } = ChromeUtils.importESModule(
  "resource://services-settings/remote-settings.sys.mjs"
);

let isNewUntil = Temporal.Now.plainDateISO().add({ days: 4 }).toString();

// A config to test new app-provided engine only.
const CONFIG = [
  {
    identifier: "basic",
    variants: [
      {
        environment: { allRegionsAndLocales: true },
        isNewUntil,
      },
    ],
  },
];

// A config to test a new app-provided engine is overridden by third-party engine.
// Extends the original config by adding the engine that will be overridden.
const CONFIG_OVERRIDDEN_ENGINE = [
  ...CONFIG,
  {
    identifier: "engine-id",
    base: {
      name: "engine-name",
      urls: {
        search: {
          base: "https://example.com/search",
          params: [{ name: "pc", value: "{partnerCode}" }],
          searchTermParamName: "q",
        },
      },
      partnerCode: "partner-code",
    },
    variants: [
      {
        environment: { allRegionsAndLocales: true },
        isNewUntil,
      },
    ],
  },
];

add_setup(async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.scotchBonnet.enableOverride", true]],
  });

  let allowlist = RemoteSettings(SearchUtils.SETTINGS_ALLOWLIST_KEY);
  sinon.stub(allowlist, "get").returns([
    {
      thirdPartyId: "thirdparty@tests.mozilla.org",
      overridesAppIdv2: "engine-id",
      urls: [
        {
          search_url: "https://example.com/search-third-party",
          search_url_get_params: "?pc=thirdparty&q={searchTerms}",
        },
      ],
    },
  ]);

  await SearchTestUtils.updateRemoteSettingsConfig(CONFIG);

  registerCleanupFunction(async () => {
    sinon.restore();
  });
});

add_task(async function test_new_badge_displayed_for_new_app_provided_engine() {
  let engine = SearchService.getEngineByName("basic");
  Assert.ok(engine.isNew(), "Engine is new");
  Assert.ok(!engine.overriddenById, "Engine is not overridden.");

  info("New application provided engine should show the New badge");
  let unifiedDropDownMenu =
    await UrlbarTestUtils.openSearchModeSwitcher(window);
  let item = unifiedDropDownMenu.querySelector(
    `panel-item[data-engine-name="basic"]`
  );
  Assert.ok(
    item,
    "The app-provided engine is in the unified button dropdown menu"
  );
  Assert.equal(item.getAttribute("badge-type"), "new", "New badge is shown");

  let unifiedDropDownMenuHidden =
    UrlbarTestUtils.searchModeSwitcherPopupClosed(window);
  EventUtils.synthesizeKey("KEY_Escape");
  await unifiedDropDownMenuHidden;
});

add_task(
  async function test_new_badge_hidden_when_app_provided_is_overridden() {
    let extension = await SearchTestUtils.installSearchExtension(
      {
        id: "thirdparty@tests.mozilla.org",
        name: "engine-name",
        is_default: true,
        search_url: "https://example.com/search-third-party",
        search_url_get_params: "?pc=thirdparty&q={searchTerms}",
      },
      { setAsDefault: true, skipUnload: true }
    );

    let addonEngine = SearchService.getEngineByName("engine-name");
    Assert.ok(!addonEngine.isNew(), "The add-on engine is not new");

    info("The add-on engine should not show the New badge");
    let unifiedDropDownMenu =
      await UrlbarTestUtils.openSearchModeSwitcher(window);
    let item = unifiedDropDownMenu.querySelector(
      `panel-item[data-engine-name="engine-name"]`
    );
    Assert.ok(item, "The add-on engine is in the unified button dropdown menu");
    Assert.ok(
      !item.hasAttribute("badge-type"),
      "The add-on engine does not show the New badge"
    );

    let unifiedDropDownMenuHidden =
      UrlbarTestUtils.searchModeSwitcherPopupClosed(window);
    EventUtils.synthesizeKey("KEY_Escape");
    await unifiedDropDownMenuHidden;

    // Loading a new app-provided engine with the same name as the third-party
    // add-on that was set as default above causes the add-on to override the
    // app-provided engine, because the add-on is in the default override allowlist.
    info("Load the new app-provided engine with the same name as the add-on");
    await SearchTestUtils.updateRemoteSettingsConfig(CONFIG_OVERRIDDEN_ENGINE);

    let engine = SearchService.getEngineByName("engine-name");
    Assert.ok(engine.overriddenById, "The app-provided engine is overridden");
    Assert.ok(!engine.isNew(), "The overridden app-provided engine is not new");

    info("The overridden app-provided engine should not show the New badge");
    unifiedDropDownMenu = await UrlbarTestUtils.openSearchModeSwitcher(window);
    item = unifiedDropDownMenu.querySelector(
      `panel-item[data-engine-name="engine-name"]`
    );
    Assert.ok(
      item,
      "The app-provided engine is in the unified button dropdown menu"
    );
    Assert.ok(
      !item.hasAttribute("badge-type"),
      "The overridden app-provided engine does not show the New badge"
    );

    let submission = engine.getSubmission("test");
    Assert.ok(
      submission.uri.spec.startsWith("https://example.com/search-third-party"),
      "The app-provided engine's search URL is overridden by the add-on"
    );

    unifiedDropDownMenuHidden =
      UrlbarTestUtils.searchModeSwitcherPopupClosed(window);
    EventUtils.synthesizeKey("KEY_Escape");
    await unifiedDropDownMenuHidden;

    await extension.unload();
  }
);
