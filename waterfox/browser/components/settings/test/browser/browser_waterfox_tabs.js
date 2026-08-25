/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

registerCleanupFunction(() => {
  Services.prefs.clearUserPref("browser.tabs.toolbarposition");
  Services.prefs.clearUserPref("browser.tabs.duplicateTab");
  Services.prefs.clearUserPref("browser.tabs.autoGroupNewTabs");
});

add_task(async function test_tabs_group_renders() {
  let tab = await openPrefsTab("tabsBrowsing");
  let doc = tab.linkedBrowser.contentDocument;

  let group = await settingGroupRenders(doc, "waterfoxTabs");
  ok(group, "The Waterfox tabs group renders on the tabs pane");

  let select = doc
    .getElementById("setting-control-waterfox-tab-bar-position")
    ?.querySelector("moz-select");
  ok(select, "The tab bar position select renders");
  is(select.value, "topabove", "The tab bar sits at the top by default");

  let prefChanged = TestUtils.waitForPrefChange("browser.tabs.toolbarposition");
  select.value = "bottombelow";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await prefChanged;
  is(
    Services.prefs.getStringPref("browser.tabs.toolbarposition"),
    "bottombelow",
    "Choosing a bottom position writes the pref"
  );

  await SpecialPowers.pushPrefEnv({ set: [["sidebar.verticalTabs", true]] });
  await TestUtils.waitForCondition(
    () => select.disabled,
    "The position select disables while vertical tabs are on"
  );
  await SpecialPowers.popPrefEnv();
  await TestUtils.waitForCondition(
    () => !select.disabled,
    "The position select enables again with horizontal tabs"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_menu_toggle_writes_pref() {
  let tab = await openPrefsTab("tabsBrowsing");
  let doc = tab.linkedBrowser.contentDocument;

  await settingGroupRenders(doc, "waterfoxTabs");
  let toggle = doc
    .getElementById("setting-control-waterfox-tabs-duplicate-menu")
    ?.querySelector("moz-toggle");
  ok(toggle, "The duplicate tab toggle renders");
  ok(toggle.pressed, "The duplicate tab entry shows by default");

  let prefChanged = TestUtils.waitForPrefChange("browser.tabs.duplicateTab");
  synthesizeClick(toggle);
  await prefChanged;
  is(
    Services.prefs.getBoolPref("browser.tabs.duplicateTab"),
    false,
    "Turning the toggle off writes the pref"
  );

  BrowserTestUtils.removeTab(tab);
});

add_task(async function test_unread_italics_toggle() {
  const pref = "browser.tabs.italicizeUnread";
  await SpecialPowers.pushPrefEnv({ clear: [[pref]] });
  let tab;
  try {
    tab = await openPrefsTab("tabsBrowsing");
    const doc = tab.linkedBrowser.contentDocument;
    await settingGroupRenders(doc, "waterfoxTabs");
    const toggle = doc
      .getElementById("setting-control-waterfox-tabs-italicize-unread")
      ?.querySelector("moz-toggle");
    ok(toggle, "The unread tab italics toggle renders");
    ok(!toggle.pressed, "Unread tab italics are off by default");

    for (const value of [true, false]) {
      const prefChanged = TestUtils.waitForPrefChange(pref);
      synthesizeClick(toggle);
      await prefChanged;
      is(
        Services.prefs.getBoolPref(pref),
        value,
        `Clicking the unread tab italics toggle writes ${value}`
      );
      await TestUtils.waitForCondition(
        () => toggle.pressed === value,
        `The toggle reflects ${value}`
      );
    }
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    Services.prefs.clearUserPref(pref);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_tree_auto_collapse_layout_and_binding() {
  const pref = "browser.tabs.verticalTabs.tree.autoCollapse.onSelect";
  is(
    Services.prefs.getDefaultBranch("").getBoolPref(pref),
    false,
    "Automatic collapse on tab selection is off by default"
  );
  await SpecialPowers.pushPrefEnv({
    set: [["browser.tabs.verticalTabs.tree.enabled", true]],
    clear: [[pref]],
  });

  let tab;
  try {
    tab = await openPrefsTab("tabsBrowsing");
    let doc = tab.linkedBrowser.contentDocument;
    let layout = await settingGroupRenders(doc, "browserLayout");
    await layout.updateComplete;

    let toggle = doc
      .getElementById("setting-control-waterfox-tree-auto-collapse-on-select")
      ?.querySelector("moz-toggle");
    ok(toggle, "The automatic collapse toggle renders");
    is(
      toggle.closest("setting-group"),
      layout,
      "The automatic collapse toggle is in Browser layout"
    );
    is(
      toggle.closest("moz-fieldset")?.id,
      "waterfox-tabs-tree",
      "The toggle is inside the Tree tabs fieldset"
    );
    ok(BrowserTestUtils.isVisible(toggle), "The toggle is visible");
    ok(!toggle.disabled, "The toggle is enabled while tree tabs are on");
    ok(!toggle.pressed, "The toggle reflects the default off state");
    ok(
      toggle.getAttribute("searchkeywords").includes("auto-collapse"),
      "The toggle includes an auto-collapse search keyword"
    );

    for (let value of [true, false]) {
      let prefChanged = TestUtils.waitForPrefChange(pref);
      synthesizeClick(toggle);
      await prefChanged;
      is(
        Services.prefs.getBoolPref(pref),
        value,
        `Clicking the toggle writes ${value} to the selection collapse pref`
      );
      await TestUtils.waitForCondition(
        () => toggle.pressed === value,
        `The toggle reflects ${value} after clicking`
      );
    }

    for (let value of [true, false]) {
      Services.prefs.setBoolPref(pref, value);
      await TestUtils.waitForCondition(
        () => toggle.pressed === value,
        `The toggle reflects an external pref change to ${value}`
      );
    }
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    Services.prefs.clearUserPref(pref);
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_additional_tree_settings() {
  const prefix = "browser.tabs.verticalTabs.tree.";
  await SpecialPowers.pushPrefEnv({
    set: [
      [prefix + "enabled", true],
      [prefix + "successorControl", true],
      [prefix + "expandNativeGroupOnTreeExpand", true],
      [prefix + "dropLinksOnTab", 2],
      [prefix + "indentPx", 16],
      [prefix + "maxDepth", -1],
    ],
  });
  let tab;
  try {
    tab = await openPrefsTab("tabsBrowsing");
    const doc = tab.linkedBrowser.contentDocument;
    const layout = await settingGroupRenders(doc, "browserLayout");
    await layout.updateComplete;
    const control = id => doc.getElementById(`waterfox-tree-${id}`);
    const input = async (element, value) => {
      element.inputEl.value = String(value);
      for (const type of ["input", "change"]) {
        element.inputEl.dispatchEvent(
          new doc.defaultView.Event(type, { bubbles: true })
        );
      }
      await element.updateComplete;
    };
    const bindings = [
      ["successor", "successorControl", false],
      ["expand-native-group", "expandNativeGroupOnTreeExpand", false],
      ["drop-links", "dropLinksOnTab", 1],
      ["indent", "indentPx", 24],
    ];
    for (const [id, name, value] of bindings) {
      const changed = TestUtils.waitForPrefChange(prefix + name);
      if (typeof value == "boolean") {
        synthesizeClick(control(id));
      } else {
        await input(control(id), value);
      }
      await changed;
      const actual =
        typeof value == "boolean"
          ? Services.prefs.getBoolPref(prefix + name)
          : Services.prefs.getIntPref(prefix + name);
      is(
        actual,
        value,
        `${id} writes its preference, including returning link drops to Ask`
      );
    }

    await input(control("indent"), "");
    is(
      Services.prefs.getIntPref(prefix + "indentPx"),
      24,
      "Empty input does not overwrite indentation"
    );
    synthesizeClick(control("limit-depth"));
    await TestUtils.waitForCondition(() => !control("max-depth").disabled);
    for (const value of [0, 1, 12]) {
      await input(control("max-depth"), value);
      is(
        Services.prefs.getIntPref(prefix + "maxDepth"),
        value,
        `Depth ${value} is available`
      );
    }
    for (const value of [-1, 12]) {
      const changed = TestUtils.waitForPrefChange(prefix + "maxDepth");
      synthesizeClick(control("limit-depth"));
      await changed;
      is(
        Services.prefs.getIntPref(prefix + "maxDepth"),
        value,
        "Unlimited nesting and the last finite limit can be restored"
      );
      await control("limit-depth").updateComplete;
    }
    Services.prefs.setBoolPref(prefix + "enabled", false);
    await TestUtils.waitForCondition(
      () =>
        [...bindings.map(([id]) => id), "limit-depth", "max-depth"].every(
          id => control(id).disabled
        ),
      "The new controls follow the tree master switch"
    );
  } finally {
    if (tab) {
      BrowserTestUtils.removeTab(tab);
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_grouping_placement_follows_master() {
  let tab = await openPrefsTab("tabsBrowsing");
  let doc = tab.linkedBrowser.contentDocument;

  await settingGroupRenders(doc, "waterfoxTabs");
  let placement = doc
    .getElementById("setting-control-waterfox-auto-group-placement")
    ?.querySelector("moz-select");
  ok(placement, "The placement select renders");
  ok(placement.disabled, "The placement select disables while grouping is off");

  let prefChanged = TestUtils.waitForPrefChange(
    "browser.tabs.autoGroupNewTabs"
  );
  let toggle = doc
    .getElementById("setting-control-waterfox-auto-group-tabs")
    ?.querySelector("moz-toggle");
  synthesizeClick(toggle);
  await prefChanged;

  await TestUtils.waitForCondition(
    () => !placement.disabled,
    "The placement select enables once grouping is on"
  );

  BrowserTestUtils.removeTab(tab);
});
