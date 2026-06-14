/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";

const DIALOG_VERSION = 153;
const ENABLED_PREF = "browser.startup.upgradeDialog.enabled";
const MESSAGE_ID = "WATERFOX_153_UPGRADE";
const RELEASE_SERIES =
  AppConstants.MOZ_APP_VERSION_DISPLAY.match(/^\d+\.\d+/)?.[0] ??
  AppConstants.MOZ_APP_VERSION_DISPLAY;

const NOVA_PREF = "browser.nova.enabled";
const STYLE_PREF = "browser.theme.enableWaterfoxCustomizations";
// Lepton modes: 0/1 load the Waterfox chrome customisations, 2 turns them off.
const LEPTON_OFF = 2;

function getCurrentStyle() {
  if (Services.prefs.getIntPref(STYLE_PREF, LEPTON_OFF) != LEPTON_OFF) {
    return "photon";
  }
  return Services.prefs.getBoolPref(NOVA_PREF, false) ? "nova" : "proton";
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

function getUpgradeMessage() {
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
      screens: [
        {
          id: "WATERFOX_153_UPGRADE_WELCOME",
          content: {
            position: "center",
            transition_content: true,
            screen_style: {
              width: "560px",
            },
            logo: {},
            title: {
              string_id: "waterfox-upgrade-dialog-title",
              args: {
                version: RELEASE_SERIES,
              },
            },
            subtitle: {
              string_id: "waterfox-upgrade-dialog-subtitle",
            },
            primary_button: {
              label: {
                string_id: "waterfox-upgrade-dialog-continue-button",
              },
              action: {
                navigate: true,
              },
            },
          },
        },
        {
          id: "WATERFOX_153_UPGRADE_APPEARANCE",
          content: {
            position: "center",
            transition_content: true,
            screen_style: {
              width: "560px",
            },
            logo: {},
            title: {
              string_id: "waterfox-upgrade-dialog-appearance-title",
            },
            subtitle: {
              string_id: "waterfox-upgrade-dialog-appearance-subtitle",
            },
            tiles: getStylePicker(),
            primary_button: {
              label: {
                string_id: "waterfox-upgrade-dialog-primary-button",
              },
              action: {
                navigate: true,
              },
            },
          },
        },
      ],
    },
  };
}

export const WaterfoxUpgradeMessage = {
  dialogVersion: DIALOG_VERSION,

  get enabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, true);
  },

  async getUpgradeMessage() {
    return Cu.cloneInto(getUpgradeMessage(), {});
  },
};
