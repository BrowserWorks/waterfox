const { WaterfoxTheme } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxTheme.sys.mjs"
);
const MODE_PREF = "browser.theme.waterfox.chromeSheet";
const THEME_PREF = "extensions.activeThemeID";

function assertLoaded(loaded, message) {
  is(WaterfoxTheme.stylesEnabled, loaded, message);
}

add_task(async function test_default_state() {
  is(Services.prefs.getIntPref(MODE_PREF), 0, "The sheet defaults on");
  assertLoaded(true, "The chrome sheet loads by default");
});

add_task(async function test_on_off() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, 2]] });
  assertLoaded(false, "Off keeps the stock look");
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, 0]] });
  assertLoaded(true, "On applies Lepton with every theme");

  await SpecialPowers.pushPrefEnv({
    set: [[THEME_PREF, "some-third-party-theme@example.com"]],
  });
  assertLoaded(true, "On stays enabled with a third party theme");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_legacy_mode_is_enabled() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, 1]] });

  await SpecialPowers.pushPrefEnv({
    set: [[THEME_PREF, "some-third-party-theme@example.com"]],
  });
  assertLoaded(true, "Legacy mode 1 stays enabled with a third party theme");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});
