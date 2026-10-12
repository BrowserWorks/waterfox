/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

AddonTestUtils.initMochitest(this);

// The fallback dropdown should be hidden when only one language is installed.
add_task(async function testFallbackHiddenWithSingleLanguage() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["intl.multilingual.enabled", true],
      ["intl.multilingual.downloadEnabled", false],
    ],
  });

  is(Services.locale.availableLocales.length, 1, "Only one language available");

  let doc = await openLanguagesPrefs();
  let win = doc.defaultView;
  await waitForLanguageUI(doc);

  let fallbackControl = getSettingControl("browserLanguageFallback", win);
  is(
    fallbackControl.hidden,
    true,
    "Fallback dropdown is hidden with one language"
  );

  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

// The fallback dropdown should appear when >=2 languages are installed and the
// preferred language isn't the default locale.
add_task(async function testFallbackVisibleWithMultipleLanguages() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["intl.multilingual.enabled", true],
      ["intl.multilingual.downloadEnabled", false],
      ["extensions.langpacks.signatures.required", false],
    ],
  });

  let addon = await installLangpack("fr");
  let doc = await openLanguagesPrefs();
  let win = doc.defaultView;
  await waitForLanguageUI(doc);

  // Fallback stays hidden while the preferred language is still the default.
  let fallbackControl = getSettingControl("browserLanguageFallback", win);
  is(
    fallbackControl.hidden,
    true,
    "Fallback is hidden while preferred matches the default locale"
  );

  await changeLocale(doc, "fr");
  await waitForSettingVisible("browserLanguageFallback", win);

  await addon.uninstall();
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

// The fallback dropdown should remain hidden when the preferred language is
// the default locale, even with multiple languages installed.
add_task(async function testFallbackHiddenWhenPreferredIsDefault() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["intl.multilingual.enabled", true],
      ["intl.multilingual.downloadEnabled", false],
      ["extensions.langpacks.signatures.required", false],
      // Pin requested locale so this test's precondition (preferred ==
      // default) holds independent of state leaked by earlier tests.
      ["intl.locale.requested", Services.locale.defaultLocale],
    ],
  });

  let addons = await installLangpacks(["fr", "de"]);
  let doc = await openLanguagesPrefs();
  let win = doc.defaultView;
  await waitForLanguageUI(doc);

  let fallbackControl = getSettingControl("browserLanguageFallback", win);
  is(
    fallbackControl.hidden,
    true,
    "Fallback is hidden when preferred equals the default locale"
  );

  await Promise.all(addons.map(addon => addon.uninstall()));
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

// The fallback dropdown should only contain installed locales, not remote ones.
add_task(async function testFallbackOnlyShowsInstalledLocales() {
  let sandbox = sinon.createSandbox();
  sandbox
    .stub(LangPackMatcher.mockable, "getAvailableLangpacks")
    .resolves(["de", "it"].map(createRemoteLangpack));

  await SpecialPowers.pushPrefEnv({
    set: [
      ["intl.multilingual.enabled", true],
      ["intl.multilingual.downloadEnabled", true],
      ["extensions.langpacks.signatures.required", false],
    ],
  });

  let addon = await installLangpack("fr");
  let doc = await openLanguagesPrefs();
  let win = doc.defaultView;
  await waitForLanguageUI(doc);

  // Fallback only becomes visible once preferred differs from the default.
  await changeLocale(doc, "fr");

  let fallbackControl = getSettingControl("browserLanguageFallback", win);
  await waitForSettingVisible("browserLanguageFallback", win);

  let children = Array.from(fallbackControl.controlEl.children);
  let visibleOptions = children.filter(el => !el.hidden).map(el => el.value);
  Assert.deepEqual(
    visibleOptions,
    ["en-US"],
    "Fallback only shows installed locales, excluding preferred"
  );
  ok(!visibleOptions.includes("de"), "Remote-only locale de not in fallback");
  ok(!visibleOptions.includes("it"), "Remote-only locale it not in fallback");

  await addon.uninstall();
  sandbox.restore();
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

// The fallback dropdown should not include the currently preferred language.
add_task(async function testFallbackExcludesPreferredLanguage() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["intl.multilingual.enabled", true],
      ["intl.multilingual.downloadEnabled", false],
      ["intl.locale.requested", "en-US"],
      ["extensions.langpacks.signatures.required", false],
    ],
  });

  let addons = await installLangpacks(["fr", "fr-CA", "de"]);
  let doc = await openLanguagesPrefs();
  let win = doc.defaultView;
  await waitForLanguageUI(doc);

  // Make preferred non-default so the fallback dropdown appears.
  await changeLocale(doc, "fr");

  let fallbackControl = getSettingControl("browserLanguageFallback", win);
  await waitForSettingVisible("browserLanguageFallback", win);

  is(
    fallbackControl.controlEl.value,
    "en-US",
    "Fallback reflects the requested locale, not an automatically negotiated variant"
  );

  let children = Array.from(fallbackControl.controlEl.children);
  let fr = children.find(el => el.value === "fr");
  ok(fr?.hidden, "Preferred locale fr is hidden in fallback options");
  let visibleOptions = children.filter(el => !el.hidden).map(el => el.value);
  ok(
    visibleOptions.includes("en-US"),
    "Installed en-US is in fallback options"
  );
  ok(visibleOptions.includes("de"), "Installed de is in fallback options");

  await Promise.all(addons.map(addon => addon.uninstall()));
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});

// Changing the fallback language when liveReload is off should show a restart
// message and record the "reorder" telemetry event.
add_task(async function testFallbackChangeShowsRestart() {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["intl.multilingual.enabled", true],
      ["intl.multilingual.downloadEnabled", false],
      ["intl.multilingual.liveReload", true],
      ["intl.multilingual.liveReloadBidirectional", true],
      ["intl.locale.requested", "en-US"],
      ["extensions.langpacks.signatures.required", false],
    ],
  });

  let addons = await installLangpacks(["fr", "de"]);
  let doc = await openLanguagesPrefs();
  let win = doc.defaultView;
  await waitForLanguageUI(doc);

  // Live-reload to fr so preferred != default (fallback becomes visible)
  // without triggering a restart message.
  await changeLocale(doc, "fr");
  await BrowserTestUtils.waitForCondition(
    () => Services.locale.requestedLocales[0] === "fr",
    "fr is live-applied"
  );

  let fallbackControl = getSettingControl("browserLanguageFallback", win);
  await waitForSettingVisible("browserLanguageFallback", win);
  assertRestartMessageHidden(doc);

  // Turn off live reload so a fallback change triggers the restart flow.
  await SpecialPowers.pushPrefEnv({
    set: [
      ["intl.multilingual.liveReload", false],
      ["intl.multilingual.liveReloadBidirectional", false],
    ],
  });

  await changeMozSelectValue(fallbackControl.controlEl, "de");
  await waitForRestartMessage(doc);

  await Promise.all(addons.map(addon => addon.uninstall()));
  BrowserTestUtils.removeTab(gBrowser.selectedTab);
});
