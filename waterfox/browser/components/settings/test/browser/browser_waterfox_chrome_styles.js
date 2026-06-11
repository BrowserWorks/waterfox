/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const { WaterfoxBrowserStyle } = ChromeUtils.importESModule(
  "resource:///modules/WaterfoxBrowserStyle.sys.mjs"
);

async function withBrowserStyle(style, task) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.theme.waterfox.chromeSheet", 0],
      ["browser.theme.waterfox.browserStyle", style],
      ["browser.nova.enabled", style === "nova"],
      ...Object.entries(WaterfoxBrowserStyle.PRESETS[style]),
    ],
  });
  try {
    await task();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
}

add_task(async function test_square_searchmode_switcher() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.scotchBonnet.enableOverride", true]],
  });
  const urlbar = document.getElementById("urlbar");
  const switcher = urlbar.querySelector(".searchmode-switcher");
  const originalSearchMode = urlbar.getAttribute("searchmode");
  const originalOpen = switcher.getAttribute("open");
  await switcher.updateComplete;
  const background = switcher.shadowRoot.querySelector(".button-background");
  ok(background, "The switcher has a button background");

  try {
    for (const style of ["nova", "proton", "photon"]) {
      await withBrowserStyle(style, async () => {
        for (const square of [false, true, false]) {
          await SpecialPowers.pushPrefEnv({
            set: [["userChrome.rounding.square_button", square]],
          });
          try {
            for (const state of ["normal", "open", "searchmode"]) {
              switcher.toggleAttribute("open", state === "open");
              urlbar.toggleAttribute("searchmode", state === "searchmode");
              await TestUtils.waitForCondition(() => {
                const radius =
                  window.getComputedStyle(background).borderTopLeftRadius;
                return square ? radius === "0px" : parseFloat(radius) > 0;
              }, `${style}: square buttons=${square} applies in ${state}`);
              const computed = window.getComputedStyle(background);
              for (const corner of [
                "borderTopLeftRadius",
                "borderTopRightRadius",
                "borderBottomLeftRadius",
                "borderBottomRightRadius",
              ]) {
                is(
                  parseFloat(computed[corner]) === 0,
                  square,
                  `${style}: ${corner} respects the square-button preference in ${state}`
                );
              }
            }
          } finally {
            await SpecialPowers.popPrefEnv();
          }
        }
      });
    }
  } finally {
    for (const [element, name, value] of [
      [urlbar, "searchmode", originalSearchMode],
      [switcher, "open", originalOpen],
    ]) {
      if (value === null) {
        element.removeAttribute(name);
      } else {
        element.setAttribute(name, value);
      }
    }
    await SpecialPowers.popPrefEnv();
  }
});

add_task(async function test_unloaded_tab_styling() {
  for (const style of ["nova", "proton", "photon"]) {
    await withBrowserStyle(style, async () => {
      const originalTab = gBrowser.selectedTab;
      const tab = BrowserTestUtils.addTab(gBrowser, "https://example.com/");
      try {
        await BrowserTestUtils.browserLoaded(tab.linkedBrowser);
        const content = tab.querySelector(".tab-content");
        const icon = tab.querySelector(".tab-icon-image");
        async function checkStyle(fade, grayscale, state) {
          const opacity = fade ? "0.7" : "1";
          const filter = grayscale ? "grayscale(1)" : "none";
          await TestUtils.waitForCondition(
            () =>
              window.getComputedStyle(content).opacity === opacity &&
              window.getComputedStyle(icon).filter === filter,
            `${style}: ${state} tab has opacity=${opacity}, filter=${filter}`
          );
          is(
            window.getComputedStyle(content).opacity,
            opacity,
            `${style}: ${state} tab opacity`
          );
          is(
            window.getComputedStyle(icon).filter,
            filter,
            `${style}: ${state} favicon filter`
          );
        }

        await SpecialPowers.pushPrefEnv({
          set: [
            ["userChrome.tab.unloaded", true],
            ["userChrome.tab.unloaded.grayscale", true],
            ["browser.tabs.fadeOutUnloadedTabs", false],
            ["browser.tabs.fadeOutExplicitlyUnloadedTabs", false],
          ],
        });
        try {
          await checkStyle(false, false, "loaded");
          await gBrowser.prepareDiscardBrowser(tab);
          ok(
            gBrowser.discardBrowser(tab, true),
            `${style}: the background tab unloads`
          );
          ok(
            tab.hasAttribute("pending"),
            `${style}: the unloaded tab is pending`
          );
          ok(
            icon.hasAttribute("pending"),
            `${style}: the favicon inherits the pending state`
          );

          for (const [fade, grayscale] of [
            [true, true],
            [true, false],
            [false, false],
            [false, true],
            [true, true],
          ]) {
            await SpecialPowers.pushPrefEnv({
              set: [
                ["userChrome.tab.unloaded", fade],
                ["userChrome.tab.unloaded.grayscale", grayscale],
              ],
            });
            try {
              await checkStyle(fade, fade && grayscale, "unloaded");
            } finally {
              await SpecialPowers.popPrefEnv();
            }
          }

          const restored = BrowserTestUtils.waitForEvent(tab, "SSTabRestored");
          await BrowserTestUtils.switchTab(gBrowser, tab);
          await restored;
          ok(
            !tab.hasAttribute("pending"),
            `${style}: the restored tab is no longer pending`
          );
          ok(
            !icon.hasAttribute("pending"),
            `${style}: the restored favicon is no longer pending`
          );
          await checkStyle(false, false, "restored");
          await BrowserTestUtils.switchTab(gBrowser, originalTab);
          await checkStyle(false, false, "restored background");
        } finally {
          await SpecialPowers.popPrefEnv();
        }
      } finally {
        await BrowserTestUtils.removeTab(tab);
      }
    });
  }
});

add_task(async function test_bookmarks_menubar_density() {
  if (AppConstants.platform === "macosx") {
    info("The native macOS menu bar does not use the chrome menu styling");
    return;
  }

  const popup = document.getElementById("bookmarksMenuPopup");
  const folder = document.createXULElement("menu");
  folder.classList.add("bookmark-item");
  folder.setAttribute("label", "Density test folder");
  const subPopup = document.createXULElement("menupopup");
  const bookmark = document.createXULElement("menuitem");
  bookmark.classList.add("bookmark-item");
  bookmark.setAttribute("label", "Density test bookmark");
  subPopup.appendChild(bookmark);
  folder.appendChild(subPopup);
  popup.appendChild(folder);
  const unrelatedItem = document.createXULElement("menuitem");
  unrelatedItem.setAttribute("label", "Unrelated menu item");
  document.getElementById("menu_ToolsPopup").appendChild(unrelatedItem);

  try {
    for (const style of ["nova", "proton", "photon"]) {
      await withBrowserStyle(style, async () => {
        for (const density of [0, 1, 2]) {
          await SpecialPowers.pushPrefEnv({
            set: [
              ["browser.uidensity", density],
              ["userChrome.padding.global_menubar", false],
              ["userChrome.padding.bookmark_menu", false],
              ["userChrome.padding.bookmark_menu.compact", false],
            ],
          });
          try {
            const unrelatedPadding =
              window.getComputedStyle(unrelatedItem).paddingBlockStart;
            const unrelatedMinHeight =
              window.getComputedStyle(unrelatedItem).minHeight;
            const baseline = [folder, bookmark].map(element => {
              const computed = window.getComputedStyle(element);
              return {
                padding: computed.paddingBlockStart,
                minHeight: computed.minHeight,
              };
            });
            await SpecialPowers.pushPrefEnv({
              set: [
                ["userChrome.padding.bookmark_menu", true],
                ["userChrome.padding.bookmark_menu.compact", true],
              ],
            });
            try {
              is(
                window.getComputedStyle(unrelatedItem).paddingBlockStart,
                unrelatedPadding,
                "Bookmark tightening does not change unrelated menu padding"
              );
              is(
                window.getComputedStyle(unrelatedItem).minHeight,
                unrelatedMinHeight,
                "Bookmark tightening does not change unrelated menu item height"
              );
              for (const [index, element] of [folder, bookmark].entries()) {
                const padding = ["3px", "1.5px", baseline[index].padding][
                  density
                ];
                await TestUtils.waitForCondition(
                  () =>
                    window.getComputedStyle(element).paddingBlockStart ===
                    padding,
                  `${style}: density ${density} sets bookmark menu padding`
                );
                const computed = window.getComputedStyle(element);
                is(
                  computed.paddingBlockEnd,
                  padding,
                  "Block padding is symmetric"
                );
                is(
                  computed.minHeight,
                  density === 2 ? baseline[index].minHeight : "0px",
                  "Compact bookmark items remove the minimum height except in touch mode"
                );
              }
            } finally {
              await SpecialPowers.popPrefEnv();
            }
            for (const [index, element] of [folder, bookmark].entries()) {
              is(
                window.getComputedStyle(element).paddingBlockStart,
                baseline[index].padding,
                "Disabling bookmark tightening restores the original padding"
              );
            }
          } finally {
            await SpecialPowers.popPrefEnv();
          }
        }
      });
    }
  } finally {
    folder.remove();
    unrelatedItem.remove();
  }
});

add_task(async function test_audio_tab_minimum_width() {
  const pref = "userChrome.tab.prevent_audio_widening";
  const audioStates = ["muted", "soundplaying", "activemedia-blocked"];
  const originalOrientation = gBrowser.tabContainer.getAttribute("orient");
  const sidebarPrefs = [
    "sidebar.visibility",
    "browser.uiCustomization.horizontalTabsBackup",
    "browser.uiCustomization.navBarWhenVerticalTabs",
  ].map(name => ({
    name,
    hadUserValue: Services.prefs.prefHasUserValue(name),
    value: Services.prefs.getStringPref(name, ""),
  }));
  await SpecialPowers.pushPrefEnv({
    set: [
      ["sidebar.verticalTabs", false],
      ["browser.tabs.verticalTabs.tree.enabled", false],
      ["sidebar.revamp", true],
      ["sidebar.animation.enabled", false],
      ["sidebar.verticalTabs.dragToPinPromo.dismissed", true],
    ],
  });
  const tab = await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:blank"
  );
  try {
    await TestUtils.waitForCondition(
      () =>
        gBrowser.tabContainer.getAttribute("orient") === "horizontal" &&
        tab.hasAttribute("fadein"),
      "The test tab is in the horizontal tab strip"
    );
    for (const style of ["nova", "proton", "photon"]) {
      await withBrowserStyle(style, async () => {
        for (const density of [0, 1, 2]) {
          await SpecialPowers.pushPrefEnv({
            set: [["browser.uidensity", density]],
          });
          try {
            for (const state of [...audioStates, "tab-note"]) {
              tab.removeAttribute(state);
            }
            await Promise.all(
              tab.getAnimations().map(animation => animation.finished)
            );
            const baseWidth = parseFloat(window.getComputedStyle(tab).minWidth);
            Assert.greater(
              baseWidth,
              0,
              "Horizontal tabs have a positive minimum width"
            );
            for (const prevent of [false, true, false]) {
              await SpecialPowers.pushPrefEnv({ set: [[pref, prevent]] });
              try {
                for (const state of [null, ...audioStates]) {
                  for (const attribute of audioStates) {
                    tab.toggleAttribute(attribute, attribute === state);
                  }
                  for (const note of [false, true]) {
                    tab.toggleAttribute("tab-note", note);
                    const expected =
                      baseWidth +
                      (note ? 20 : 0) +
                      (state && !prevent ? 24 : 0);
                    try {
                      await TestUtils.waitForCondition(
                        () =>
                          parseFloat(window.getComputedStyle(tab).minWidth) ===
                          expected,
                        `${style}, density ${density}: ${state}, note=${note}, prevent widening=${prevent}`
                      );
                    } catch (error) {
                      info(
                        `Expected minimum width=${expected}; actual=${window.getComputedStyle(tab).minWidth}; attributes=${tab.getAttributeNames()}`
                      );
                      throw error;
                    }
                  }
                }
              } finally {
                await SpecialPowers.popPrefEnv();
              }
            }
          } finally {
            await SpecialPowers.popPrefEnv();
          }
        }
      });
    }

    for (const state of [...audioStates, "tab-note"]) {
      tab.removeAttribute(state);
    }
    tab.setAttribute("soundplaying", "true");
    for (const pinned of [true, false]) {
      if (pinned) {
        gBrowser.pinTab(tab);
      } else {
        gBrowser.unpinTab(tab);
      }
      for (const vertical of pinned ? [false, true] : [true]) {
        await SpecialPowers.pushPrefEnv({
          set: [
            ["sidebar.verticalTabs", vertical],
            [pref, false],
          ],
        });
        try {
          await TestUtils.waitForCondition(
            () =>
              gBrowser.tabContainer.getAttribute("orient") ===
              (vertical ? "vertical" : "horizontal"),
            "The tab strip switches orientation"
          );
          const baseline = window.getComputedStyle(tab).minWidth;
          await SpecialPowers.pushPrefEnv({ set: [[pref, true]] });
          try {
            is(
              window.getComputedStyle(tab).minWidth,
              baseline,
              `The preference leaves pinned=${pinned}, vertical=${vertical} tabs unchanged`
            );
          } finally {
            await SpecialPowers.popPrefEnv();
          }
        } finally {
          await SpecialPowers.popPrefEnv();
        }
      }
    }
  } finally {
    for (const state of [...audioStates, "tab-note"]) {
      tab.removeAttribute(state);
    }
    BrowserTestUtils.removeTab(tab);
    await SpecialPowers.popPrefEnv();
    try {
      await TestUtils.waitForCondition(
        () =>
          gBrowser.tabContainer.getAttribute("orient") === originalOrientation,
        "The original tab strip orientation is restored"
      );
    } finally {
      for (const { name, hadUserValue, value } of sidebarPrefs) {
        if (hadUserValue) {
          Services.prefs.setStringPref(name, value);
        } else {
          Services.prefs.clearUserPref(name);
        }
      }
    }
  }
});
