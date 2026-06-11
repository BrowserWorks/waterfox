/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const OHTTP_PREF = "network.trr.use_ohttp";
const USE_GET_PREF = "network.trr.useGET";
const TRR_MODE_PREF = "network.trr.mode";
const TRR_URI_PREF = "network.trr.uri";
const OHTTP_RELAY_PREF = "network.trr.ohttp.relay_uri";
const OHTTP_ENDPOINT_PREF = "network.trr.ohttp.uri";
const CUSTOM_TRR_URI = "https://example.com/dns-query";
const gDNSOverride = Cc[
  "@mozilla.org/network/native-dns-override;1"
].getService(Ci.nsINativeDNSResolverOverride);

gDNSOverride.addIPOverride("mozilla.cloudflare-dns.com", "127.0.0.1");

async function pushCanonicalUltraPrefs() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [OHTTP_PREF, true],
      [USE_GET_PREF, false],
      [TRR_MODE_PREF, Ci.nsIDNSService.MODE_TRRFIRST],
    ],
    clear: [[TRR_URI_PREF]],
  });
}

async function waitForSettingControl(doc, id) {
  let control = doc.getElementById(`setting-control-${id}`);
  if (!control) {
    await BrowserTestUtils.waitForMutationCondition(
      doc.getElementById("mainPrefPane"),
      { childList: true, subtree: true },
      () => doc.getElementById(`setting-control-${id}`)
    );
    control = doc.getElementById(`setting-control-${id}`);
  }
  await control.updateComplete;
  return control;
}

async function openUltraDnsPane() {
  let tab = await openPrefsTab("dnsOverHttps");
  let doc = tab.linkedBrowser.contentDocument;
  await waitForSettingControl(doc, "dohRadioGroup");
  return { tab, doc };
}

function getDohRadioGroup(doc) {
  let group = doc
    .getElementById("setting-control-dohRadioGroup")
    ?.querySelector("moz-radio-group");
  ok(group, "The DoH radio group renders");
  return group;
}

function getDohRadio(doc, value) {
  let radio = Array.from(
    getDohRadioGroup(doc).querySelectorAll("moz-radio")
  ).find(option => option.value == value);
  ok(radio, `The ${value} DoH radio option renders`);
  return radio;
}

function getFallbackSelect(doc) {
  let select = doc
    .getElementById("setting-control-waterfox-ultra-fallback")
    ?.querySelector("moz-select");
  ok(select, "The Ultra Protection fallback selector renders");
  return select;
}

function getStatusBar(doc) {
  let status = doc
    .getElementById("setting-control-dohStatusBox")
    ?.querySelector("moz-message-bar");
  ok(status, "The DoH status message renders");
  return status;
}

async function waitForDohRadioValue(doc, value, message) {
  await TestUtils.waitForCondition(
    () => getDohRadioGroup(doc).value == value,
    message
  );
}

async function selectDohRadio(doc, value) {
  let radio = getDohRadio(doc, value);
  await radio.updateComplete;
  radio.scrollIntoView({ block: "center" });
  radio.shadowRoot.querySelector("input").click();
  await waitForDohRadioValue(doc, value, `The ${value} DoH radio is selected`);
}

function okNoUserValues(prefs) {
  for (let pref of prefs) {
    ok(!Services.prefs.prefHasUserValue(pref), `${pref} has no user value`);
  }
}

async function waitForBoxItemDescription(doc, id, expected) {
  let item = doc
    .getElementById(`setting-control-${id}`)
    ?.querySelector("moz-box-item");
  ok(item, `The ${id} row renders`);
  await TestUtils.waitForCondition(
    () => item.description == expected,
    `The ${id} row displays ${expected}`
  );
  return item;
}

async function waitForSettingGroupL10nId(doc, groupId, expected) {
  let group =
    doc.querySelector(`setting-group[groupid="${groupId}"]`) ||
    (await settingGroupRenders(doc, groupId));
  await group.updateComplete;
  await TestUtils.waitForCondition(
    () =>
      group.querySelector("moz-fieldset")?.getAttribute("data-l10n-id") ==
      expected,
    `The ${groupId} group uses ${expected}`
  );
  is(
    group.querySelector("moz-fieldset")?.getAttribute("data-l10n-id"),
    expected,
    `The ${groupId} group uses ${expected}`
  );
}

add_task(async function test_shipped_defaults_are_canonical_ultra() {
  let defaults = Services.prefs.getDefaultBranch("");
  is(defaults.getBoolPref(OHTTP_PREF), true, "OHTTP defaults on");
  is(defaults.getBoolPref(USE_GET_PREF), false, "Ultra defaults to POST");
  is(
    defaults.getIntPref(TRR_MODE_PREF),
    Ci.nsIDNSService.MODE_TRRFIRST,
    "Ultra defaults to TRR-first"
  );
  is(
    defaults.getStringPref(TRR_URI_PREF, ""),
    "",
    "Ultra has no standard DoH URI"
  );
  ok(
    defaults.getStringPref(OHTTP_RELAY_PREF, ""),
    "Ultra has an OHTTP relay URI"
  );
  ok(
    defaults.getStringPref(OHTTP_ENDPOINT_PREF, ""),
    "Ultra has an OHTTP endpoint URI"
  );
});

add_task(async function test_main_doh_blurb_uses_ohttp_model() {
  await pushCanonicalUltraPrefs();

  let tab;
  let doc;
  try {
    tab = await openPrefsTab("privacy");
    doc = tab.linkedBrowser.contentDocument;
    await waitForSettingGroupL10nId(
      doc,
      "dnsOverHttps",
      "waterfox-doh-group-ultra"
    );
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_ultra_is_separate_radio_option() {
  await pushCanonicalUltraPrefs();

  let tab;
  let doc;
  try {
    ({ tab, doc } = await openUltraDnsPane());
    let group = getDohRadioGroup(doc);
    await waitForDohRadioValue(
      doc,
      "ultra",
      "Ultra Protection is on by default"
    );

    Assert.deepEqual(
      Array.from(group.querySelectorAll("moz-radio"), radio => radio.value),
      ["ultra", "default", "custom", "off"],
      "Ultra is the first additional DoH option"
    );
    is(
      getDohRadio(doc, "custom").getAttribute("data-l10n-id"),
      "preferences-doh-radio-custom",
      "The Mozilla Custom option keeps its Custom label"
    );
    is(
      getDohRadio(doc, "ultra").getAttribute("data-l10n-id"),
      "waterfox-doh-radio-ultra",
      "The Ultra option has its own Waterfox label"
    );
    ok(
      !doc.querySelector('setting-group[groupid="waterfoxUltraDns"]'),
      "No duplicate Ultra Protection group renders below the DoH radio group"
    );
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_ultra_details_and_status_use_ohttp_model() {
  await pushCanonicalUltraPrefs();

  let tab;
  let doc;
  try {
    ({ tab, doc } = await openUltraDnsPane());
    await waitForDohRadioValue(
      doc,
      "ultra",
      "Ultra Protection starts selected"
    );

    await waitForSettingGroupL10nId(
      doc,
      "dnsOverHttpsAdvanced",
      "waterfox-doh-advanced-section-ultra"
    );

    let relay = Services.prefs.getStringPref(OHTTP_RELAY_PREF, "");
    let endpoint = Services.prefs.getStringPref(OHTTP_ENDPOINT_PREF, "");
    await waitForBoxItemDescription(doc, "waterfox-ultra-relay-uri", relay);
    await waitForBoxItemDescription(
      doc,
      "waterfox-ultra-endpoint-uri",
      endpoint
    );

    let status = getStatusBar(doc);
    await TestUtils.waitForCondition(
      () =>
        status.getAttribute("data-l10n-id") ==
          "waterfox-doh-status-ultra-active" &&
        status.getAttribute("type") == "success",
      "Ultra uses a green Waterfox/OHTTP status message"
    );
    let args = JSON.parse(status.getAttribute("data-l10n-args"));
    is(args.relay, "Waterfox", "The Ultra status includes the relay name");
    is(
      args.provider,
      "Cloudflare",
      "The Ultra status includes the provider name"
    );
    ok(!("endpoint" in args), "The Ultra status keeps endpoint details out");
    ok(
      !("reason" in args),
      "The Ultra status does not expose a raw DNS confirmation error"
    );
    ok(
      !status
        .getAttribute("data-l10n-id")
        .startsWith("preferences-doh-status-item"),
      "The Ultra status is not the standard DoH provider status"
    );
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_selecting_custom_leaves_ultra() {
  await pushCanonicalUltraPrefs();

  let tab;
  let doc;
  try {
    ({ tab, doc } = await openUltraDnsPane());
    await waitForDohRadioValue(doc, "ultra", "Ultra starts enabled");

    await selectDohRadio(doc, "custom");
    await TestUtils.waitForCondition(
      () =>
        !Services.prefs.getBoolPref(OHTTP_PREF) &&
        Services.prefs.getBoolPref(USE_GET_PREF) &&
        !!Services.prefs.getStringPref(TRR_URI_PREF, ""),
      "Selecting Custom applies a standard DoH custom configuration"
    );
    is(
      Services.prefs.getIntPref(TRR_MODE_PREF),
      Ci.nsIDNSService.MODE_TRRFIRST,
      "Custom allows fallback to system DNS by default"
    );
    is(
      getDohRadio(doc, "custom").getAttribute("data-l10n-id"),
      "preferences-doh-radio-custom",
      "Custom remains labeled Custom after leaving Ultra"
    );
    await TestUtils.waitForCondition(
      () =>
        !getStatusBar(doc).getAttribute("data-l10n-id").startsWith("waterfox-"),
      "The status returns to the standard DoH model after selecting Custom"
    );
    await waitForSettingGroupL10nId(
      doc,
      "dnsOverHttpsAdvanced",
      "preferences-doh-advanced-section"
    );

    await selectDohRadio(doc, "ultra");
    await TestUtils.waitForCondition(
      () =>
        !Services.prefs.getStringPref(TRR_URI_PREF, "") &&
        getDohRadioGroup(doc).value == "ultra",
      "Selecting Ultra clears the standard DoH URI and selects Ultra"
    );
    await waitForSettingGroupL10nId(
      doc,
      "dnsOverHttpsAdvanced",
      "waterfox-doh-advanced-section-ultra"
    );
    okNoUserValues([OHTTP_PREF, USE_GET_PREF, TRR_MODE_PREF, TRR_URI_PREF]);
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_useget_custom_state_is_not_ultra() {
  await pushCanonicalUltraPrefs();

  let tab;
  let doc;
  try {
    ({ tab, doc } = await openUltraDnsPane());
    await waitForDohRadioValue(doc, "ultra", "Ultra starts enabled");

    let prefChanged = TestUtils.waitForPrefChange(USE_GET_PREF, value => value);
    Services.prefs.setBoolPref(USE_GET_PREF, true);
    await prefChanged;
    await waitForDohRadioValue(
      doc,
      "custom",
      "A GET-based TRR configuration is Custom, not Ultra"
    );

    await selectDohRadio(doc, "ultra");
    okNoUserValues([OHTTP_PREF, USE_GET_PREF, TRR_MODE_PREF, TRR_URI_PREF]);
    await waitForDohRadioValue(
      doc,
      "ultra",
      "Selecting Ultra reapplies POST-based OHTTP"
    );
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_stale_custom_uri_is_not_ultra() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [OHTTP_PREF, true],
      [USE_GET_PREF, false],
      [TRR_MODE_PREF, Ci.nsIDNSService.MODE_TRRFIRST],
      [TRR_URI_PREF, CUSTOM_TRR_URI],
    ],
  });

  let tab;
  let doc;
  try {
    ({ tab, doc } = await openUltraDnsPane());
    await waitForDohRadioValue(
      doc,
      "custom",
      "A stale standard DoH URI is Custom, not Ultra"
    );

    await selectDohRadio(doc, "ultra");
    await TestUtils.waitForCondition(
      () => !Services.prefs.getStringPref(TRR_URI_PREF, ""),
      "Ultra clears the stale standard DoH URI"
    );
    okNoUserValues([OHTTP_PREF, USE_GET_PREF, TRR_MODE_PREF, TRR_URI_PREF]);
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_fallback_state_after_radio_roundtrip() {
  await pushCanonicalUltraPrefs();

  let tab;
  let doc;
  try {
    ({ tab, doc } = await openUltraDnsPane());
    let fallback = getFallbackSelect(doc);
    await waitForDohRadioValue(doc, "ultra", "Ultra starts enabled");
    await TestUtils.waitForCondition(
      () => fallback.value == "fallback" && !fallback.disabled,
      "Ultra starts with fallback allowed"
    );

    let prefChanged = TestUtils.waitForPrefChange(
      TRR_MODE_PREF,
      value => value == Ci.nsIDNSService.MODE_TRRONLY
    );
    fallback.value = "no-fallback";
    fallback.dispatchEvent(new Event("change", { bubbles: true }));
    await prefChanged;
    await TestUtils.waitForCondition(
      () =>
        fallback.value == "no-fallback" &&
        getDohRadioGroup(doc).value == "ultra",
      "The no-fallback submode remains an Ultra configuration"
    );

    await selectDohRadio(doc, "default");
    await TestUtils.waitForCondition(
      () =>
        !Services.prefs.getBoolPref(OHTTP_PREF) &&
        Services.prefs.getBoolPref(USE_GET_PREF) &&
        Services.prefs.getIntPref(TRR_MODE_PREF) ==
          Ci.nsIDNSService.MODE_NATIVEONLY,
      "Selecting Default leaves Ultra and returns to native DNS"
    );
    await TestUtils.waitForCondition(
      () => fallback.disabled,
      "The Ultra fallback selector disables when Ultra is not selected"
    );

    await selectDohRadio(doc, "ultra");
    await TestUtils.waitForCondition(
      () =>
        fallback.value == "fallback" && getDohRadioGroup(doc).value == "ultra",
      "Selecting Ultra again restores the canonical fallback state"
    );
    okNoUserValues([OHTTP_PREF, USE_GET_PREF, TRR_MODE_PREF, TRR_URI_PREF]);
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});
