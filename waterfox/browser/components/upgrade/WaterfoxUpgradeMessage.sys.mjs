/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  WaterfoxBrowserStyle: "resource:///modules/WaterfoxBrowserStyle.sys.mjs",
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  Region: "resource://gre/modules/Region.sys.mjs",
  SearchService: "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  ShellService: "resource:///modules/ShellService.sys.mjs",
  WaterfoxBlockerUtils: "resource:///modules/WaterfoxBlockerUtils.sys.mjs",
  getWaterfoxDefaultSearchEngineId:
    "moz-src:///toolkit/components/search/SearchService.sys.mjs",
});

const DIALOG_VERSION = 153;
const ENABLED_PREF = "browser.startup.upgradeDialog.enabled";
const MESSAGE_ID = "WATERFOX_153_UPGRADE";
const RELEASE_SERIES =
  AppConstants.MOZ_APP_VERSION_DISPLAY.match(/^\d+\.\d+/)?.[0] ??
  AppConstants.MOZ_APP_VERSION_DISPLAY;

// Lepton modes: 0/1 load the Waterfox chrome customisations, 2 turns them off.
const TREE_TABS_PREF = "browser.tabs.verticalTabs.tree.enabled";
const VERTICAL_TABS_PREF = "sidebar.verticalTabs";
const CHECK_DEFAULT_PREF = "browser.shell.checkDefaultBrowser";

function getCurrentStyle() {
  return lazy.WaterfoxBrowserStyle.getStyle();
}

function getCurrentLayout() {
  if (!Services.prefs.getBoolPref(VERTICAL_TABS_PREF, false)) {
    return "horizontal";
  }
  return Services.prefs.getBoolPref(TREE_TABS_PREF, false)
    ? "tree"
    : "vertical";
}

function waterfoxAction(action, value) {
  return {
    type: "WATERFOX_ONBOARDING",
    navigate: true,
    data: {
      action,
      value,
    },
  };
}

function customizeSettingsAction(args) {
  return {
    type: "MULTI_ACTION",
    navigate: true,
    data: {
      orderedExecution: true,
      actions: [
        {
          type: "OPEN_ABOUT_PAGE",
          data: {
            args,
            where: "tabshifted",
          },
        },
      ],
    },
  };
}

function styleTile(style) {
  return {
    id: `waterfox-style-${style}`,
    label: {
      string_id: `waterfox-onboarding-style-${style}-label`,
    },
    icon: {
      background: `center / contain no-repeat url('chrome://browser/content/waterfox/style/waterfox-style-${style}.svg')`,
    },
    action: {
      type: "WATERFOX_ONBOARDING",
      data: {
        action: "style",
        value: style,
      },
    },
  };
}

function getStylePicker() {
  return {
    type: "single-select",
    class_name: "waterfox-style",
    subtitle: {
      string_id: "waterfox-onboarding-tabs-style-legend",
    },
    selected: `waterfox-style-${getCurrentStyle()}`,
    action: {
      picker: "<event>",
    },
    data: [styleTile("nova"), styleTile("proton"), styleTile("photon")],
  };
}

function layoutTile(layout) {
  return {
    id: `waterfox-layout-${layout}`,
    label: {
      string_id: `waterfox-onboarding-tabs-${layout}-label`,
    },
    icon: {
      background: `center / contain no-repeat url('chrome://browser/content/waterfox/onboarding/browser-layout-${layout}.svg')`,
    },
    action: {
      type: "WATERFOX_ONBOARDING",
      data: {
        action: "layout",
        value: layout,
      },
    },
  };
}

function getTabLayoutPicker() {
  return {
    type: "single-select",
    class_name: "waterfox-tab-layout",
    subtitle: {
      string_id: "waterfox-onboarding-tabs-layout-legend",
    },
    selected: `waterfox-layout-${getCurrentLayout()}`,
    action: {
      picker: "<event>",
    },
    data: [
      layoutTile("horizontal"),
      layoutTile("vertical"),
      layoutTile("tree"),
    ],
  };
}

function screen(id, content) {
  return {
    id,
    content: {
      position: "center",
      transition_content: true,
      screen_style: {
        width: "560px",
      },
      logo: {},
      // Every screen can close the dialog outright; setup is optional.
      dismiss_button: {
        action: {
          dismiss: true,
        },
      },
      ...content,
    },
  };
}

function continueButton() {
  return {
    label: {
      string_id: "waterfox-upgrade-dialog-continue-button",
    },
    action: {
      navigate: true,
    },
  };
}

function skipButton() {
  return {
    label: {
      string_id: "waterfox-onboarding-skip-button",
    },
    action: {
      navigate: true,
    },
  };
}

// The dialog answers the blocker extension prompt, so it only offers the
// switch when an ad blocking extension is active.
async function getAdblockExtensionName() {
  try {
    const addons = await lazy.AddonManager.getAddonsByTypes(["extension"]);
    const active = addons.filter(addon =>
      lazy.WaterfoxBlockerUtils.isEnabledAdblockAddon(addon)
    );
    return active.length
      ? lazy.WaterfoxBlockerUtils.addonDisplayName(active[0])
      : null;
  } catch (e) {
    return null;
  }
}

// Offer Qwant only where it is the shipped default for the user's region and
// something else is currently selected.
async function shouldOfferQwant() {
  try {
    if (lazy.getWaterfoxDefaultSearchEngineId(lazy.Region.home) !== "qwant") {
      return false;
    }
    const current = await lazy.SearchService.getDefault();
    if (current?.id === "qwant") {
      return false;
    }
    const qwant = lazy.SearchService.getEngineById("qwant");
    return !!qwant && !qwant.hidden;
  } catch (e) {
    return false;
  }
}

function shouldOfferDefaultBrowser() {
  try {
    return (
      Services.prefs.getBoolPref(CHECK_DEFAULT_PREF, true) &&
      !lazy.ShellService.isDefaultBrowser(false, false)
    );
  } catch (e) {
    return false;
  }
}

async function getUpgradeMessage() {
  const [adblockExtensionName, offerQwant] = await Promise.all([
    getAdblockExtensionName(),
    shouldOfferQwant(),
  ]);

  const screens = [
    screen("WATERFOX_153_UPGRADE_WELCOME", {
      title: {
        string_id: "waterfox-upgrade-dialog-title",
        args: {
          version: RELEASE_SERIES,
        },
      },
      subtitle: {
        string_id: "waterfox-upgrade-dialog-subtitle",
      },
      primary_button: continueButton(),
    }),
    screen("WATERFOX_153_UPGRADE_APPEARANCE", {
      title: {
        string_id: "waterfox-upgrade-dialog-appearance-title",
      },
      subtitle: {
        string_id: "waterfox-upgrade-dialog-appearance-subtitle",
      },
      tiles: getStylePicker(),
      primary_button: continueButton(),
    }),
    screen("WATERFOX_153_UPGRADE_TABS", {
      title: {
        string_id: "waterfox-onboarding-tabs-title",
      },
      subtitle: {
        string_id: "waterfox-upgrade-dialog-tabs-subtitle",
      },
      tiles: getTabLayoutPicker(),
      primary_button: continueButton(),
    }),
  ];

  if (adblockExtensionName) {
    screens.push(
      screen("WATERFOX_153_UPGRADE_BLOCKER", {
        title: {
          string_id: "waterfox-upgrade-dialog-blocker-title",
        },
        subtitle: {
          string_id: "waterfox-upgrade-dialog-blocker-subtitle",
          args: {
            extensionName: adblockExtensionName,
          },
        },
        primary_button: {
          label: {
            string_id: "waterfox-upgrade-dialog-blocker-primary-button",
          },
          action: waterfoxAction("blocker-builtin"),
        },
        secondary_button: {
          label: {
            string_id: "waterfox-upgrade-dialog-blocker-secondary-button",
            args: {
              extensionName: adblockExtensionName,
            },
          },
          action: waterfoxAction("blocker-keep"),
        },
      })
    );
  }

  if (offerQwant) {
    screens.push(
      screen("WATERFOX_153_UPGRADE_SEARCH", {
        title: {
          string_id: "waterfox-upgrade-dialog-search-title",
        },
        subtitle: {
          string_id: "waterfox-upgrade-dialog-search-subtitle",
        },
        primary_button: {
          label: {
            string_id: "waterfox-upgrade-dialog-search-primary-button",
          },
          action: waterfoxAction("search-qwant"),
        },
        secondary_button: skipButton(),
      })
    );
  }

  if (shouldOfferDefaultBrowser()) {
    screens.push(
      screen("WATERFOX_153_UPGRADE_DEFAULT", {
        title: {
          string_id: "waterfox-onboarding-default-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-default-subtitle",
        },
        primary_button: {
          label: {
            string_id: "waterfox-onboarding-default-primary-button",
          },
          action: {
            type: "SET_DEFAULT_BROWSER",
            navigate: true,
          },
        },
        secondary_button: skipButton(),
      })
    );
  }

  screens.push(
    screen("WATERFOX_153_UPGRADE_PRIVACY", {
      title: {
        string_id: "waterfox-onboarding-privacy-title",
      },
      subtitle: {
        string_id: "waterfox-onboarding-privacy-subtitle",
      },
      primary_button: {
        label: {
          string_id: "waterfox-upgrade-dialog-primary-button",
        },
        action: {
          navigate: true,
        },
      },
      secondary_button: {
        label: {
          string_id: "waterfox-onboarding-customize-privacy-button",
        },
        action: customizeSettingsAction("preferences#adBlocking"),
      },
    })
  );

  return {
    id: MESSAGE_ID,
    template: "spotlight",
    targeting: "true",
    content: {
      id: MESSAGE_ID,
      template: "multistage",
      modal: "tab",
      transitions: true,
      metrics: "block",
      screens,
    },
  };
}

export const WaterfoxUpgradeMessage = {
  dialogVersion: DIALOG_VERSION,

  get enabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, true);
  },

  async getUpgradeMessage() {
    return Cu.cloneInto(await getUpgradeMessage(), {});
  },
};
