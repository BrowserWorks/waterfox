const { LightweightThemeManager } = ChromeUtils.importESModule(
  "resource://gre/modules/LightweightThemeManager.sys.mjs"
);
const { WaterfoxTheme } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxTheme.sys.mjs"
);
const {
  WATERFOX_THEME_COLOR_PREF,
  WATERFOX_THEME_ID,
  WATERFOX_THEME_MODE_PREF,
} = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxThemeColors.sys.mjs"
);

const DEFAULT_THEME_ID = "default-theme@mozilla.org";
const MODE_PREF = "browser.theme.enableWaterfoxCustomizations";
const THEME_PREF = "extensions.activeThemeID";
const THEME_UPDATE_TOPIC = "lightweight-theme-styling-update";

function assertLoaded(loaded, message) {
  is(WaterfoxTheme.stylesEnabled, loaded, message);
}

function makeThemeData(id, toolbarColor) {
  return LightweightThemeManager.themeDataFrom(
    { colors: { toolbar: toolbarColor } },
    null,
    null,
    Services.io.newURI("resource://gre/"),
    id,
    "1.0",
    null
  );
}

function updateTheme(data) {
  LightweightThemeManager.fallbackThemeData = data;
  Services.obs.notifyObservers(data, THEME_UPDATE_TOPIC);
}

function waitForMainThread() {
  return new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
}

async function withPaletteSelection(task) {
  const originalThemeData = LightweightThemeManager.themeData;
  await SpecialPowers.pushPrefEnv({
    set: [
      [THEME_PREF, DEFAULT_THEME_ID],
      [WATERFOX_THEME_MODE_PREF, "light"],
      [WATERFOX_THEME_COLOR_PREF, "pine"],
    ],
  });

  try {
    await task();
  } finally {
    await SpecialPowers.popPrefEnv();
    updateTheme(originalThemeData);
    await waitForMainThread();
  }
}

add_task(async function test_default_state() {
  assertLoaded(false, "Nova leaves Lepton off by default");
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

add_task(async function test_palette_reapplies_after_default_theme_update() {
  await withPaletteSelection(async () => {
    const updates = [];
    const observer = subject => {
      updates.push(subject.wrappedJSObject.theme?.id);
    };
    Services.obs.addObserver(observer, THEME_UPDATE_TOPIC);

    try {
      const reapplied = TestUtils.topicObserved(
        THEME_UPDATE_TOPIC,
        subject => subject.wrappedJSObject.theme?.id === WATERFOX_THEME_ID
      );
      updateTheme(makeThemeData(DEFAULT_THEME_ID, "#ffffff"));
      await reapplied;
      await waitForMainThread();

      is(
        LightweightThemeManager.themeData.theme.id,
        WATERFOX_THEME_ID,
        "The Waterfox palette replaces the late default theme update"
      );
      is(
        LightweightThemeManager.themeData.theme.toolbarColor,
        "#f0fcf5",
        "The persisted palette is reapplied"
      );
      is(
        updates.filter(id => id === WATERFOX_THEME_ID).length,
        1,
        "The Waterfox theme update does not loop"
      );
      is(
        updates[updates.length - 1],
        WATERFOX_THEME_ID,
        "The Waterfox theme is the final update"
      );
    } finally {
      Services.obs.removeObserver(observer, THEME_UPDATE_TOPIC);
    }
  });
});

add_task(async function test_pending_reapply_preserves_new_theme_update() {
  await withPaletteSelection(async () => {
    const thirdPartyThemeId = "third-party-theme@example.com";
    const updates = [];
    const observer = subject => {
      updates.push(subject.wrappedJSObject.theme?.id);
    };
    Services.obs.addObserver(observer, THEME_UPDATE_TOPIC);

    try {
      updateTheme(makeThemeData(DEFAULT_THEME_ID, "#ffffff"));
      updateTheme(makeThemeData(thirdPartyThemeId, "#000000"));
      await waitForMainThread();

      is(
        LightweightThemeManager.themeData.theme.id,
        thirdPartyThemeId,
        "A newer third-party theme update is preserved"
      );
      ok(
        !updates.includes(WATERFOX_THEME_ID),
        "The pending Waterfox reapply is cancelled"
      );
    } finally {
      Services.obs.removeObserver(observer, THEME_UPDATE_TOPIC);
    }
  });
});
