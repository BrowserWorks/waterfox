const { WaterfoxTheme } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxTheme.sys.mjs"
);
const MODE_PREF = "browser.theme.enableWaterfoxCustomizations";
const THEME_PREF = "extensions.activeThemeID";

function assertLoaded(loaded, message) {
  is(WaterfoxTheme.stylesEnabled, loaded, message);
}

add_task(async function test_default_state() {
  assertLoaded(true, "Lepton is on by default with the stock theme");
});

add_task(async function test_mode_gating() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, 2]] });
  assertLoaded(false, "Mode 2 keeps the stock look");
  await SpecialPowers.popPrefEnv();

  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, 0]] });
  assertLoaded(true, "Mode 0 applies Lepton with every theme");

  await SpecialPowers.pushPrefEnv({
    set: [[THEME_PREF, "some-third-party-theme@example.com"]],
  });
  assertLoaded(true, "Mode 0 stays on with a third party theme");
  await SpecialPowers.popPrefEnv();
  await SpecialPowers.popPrefEnv();
});

add_task(async function test_theme_gating() {
  await SpecialPowers.pushPrefEnv({ set: [[MODE_PREF, 1]] });

  await SpecialPowers.pushPrefEnv({
    set: [[THEME_PREF, "some-third-party-theme@example.com"]],
  });
  assertLoaded(false, "Mode 1 unloads for a third party theme");
  await SpecialPowers.popPrefEnv();

  assertLoaded(true, "Mode 1 reloads when the stock theme returns");
  await SpecialPowers.popPrefEnv();
});
