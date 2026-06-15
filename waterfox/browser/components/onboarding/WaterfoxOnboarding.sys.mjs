/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { WaterfoxThemeColors } from "resource:///modules/WaterfoxThemeColors.sys.mjs";

const SPLIT_BACKGROUND =
  "var(--waterfox-onboarding-split-background, linear-gradient(135deg, color-mix(in srgb, var(--button-background-color-primary) 14%, var(--background-color-canvas)), var(--background-color-canvas)))";

function splitContent(content) {
  return {
    fullscreen: true,
    position: "split",
    progress_bar: true,
    background: SPLIT_BACKGROUND,
    split_content_justify_content: "center",
    ...content,
  };
}

function waterfoxAction(action, value, navigate = false) {
  return {
    type: "WATERFOX_ONBOARDING",
    navigate,
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

function themeModeTile(mode, stringId) {
  return {
    id: `waterfox-theme-mode-${mode}`,
    type: "waterfox-theme-mode-option",
    label: {
      string_id: stringId,
    },
    icon: {},
    action: waterfoxAction("theme-mode", mode),
  };
}

function themeColorTile({ id, labelId, swatch }) {
  return {
    id: `waterfox-color-${id}`,
    type: "waterfox-color-option",
    label: {
      string_id: labelId,
    },
    icon: {
      background: swatch,
    },
    action: waterfoxAction("theme-color", id),
  };
}

function styleTile(style) {
  return {
    id: `waterfox-style-${style}`,
    label: {
      string_id: `waterfox-onboarding-style-${style}-label`,
    },
    body: {
      string_id: `waterfox-onboarding-style-${style}-body`,
    },
    icon: {
      background: `center / contain no-repeat url('chrome://browser/content/waterfox/style/waterfox-style-${style}.svg')`,
    },
    action: waterfoxAction("style", style),
  };
}

function densityTile(density, stringId) {
  return {
    id: `waterfox-density-${density}`,
    type: "waterfox-density-option",
    label: {
      string_id: stringId,
    },
    icon: {},
    action: waterfoxAction("density", density),
  };
}

function layoutTile({ id, labelId, bodyId, icon }) {
  return {
    id: `waterfox-layout-${id}`,
    label: {
      string_id: labelId,
    },
    body: {
      string_id: bodyId,
    },
    icon: {
      background: `center / contain no-repeat url('${icon}')`,
    },
    action: waterfoxAction("layout", id),
  };
}

function tabLocationTile(location, stringId) {
  return {
    id: `waterfox-location-${location}`,
    type: "waterfox-location-option",
    label: {
      string_id: stringId,
    },
    icon: {},
    action: waterfoxAction("tab-location", location),
  };
}

const WATERFOX_ONBOARDING = {
  id: "WATERFOX_ONBOARDING",
  template: "multistage",
  transitions: Services.prefs.getBoolPref(
    "browser.aboutwelcome.transitions",
    true
  ),
  backdrop:
    "var(--mr-welcome-background-color) var(--mr-welcome-background-gradient)",
  screens: [
    {
      id: "AW_WATERFOX_WELCOME",
      content: splitContent({
        logo: {
          imageURL: "chrome://branding/content/about-logo.svg",
          height: "80px",
          width: "80px",
        },
        title: {
          string_id: "waterfox-onboarding-welcome-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-welcome-subtitle",
        },
        primary_button: {
          label: {
            string_id: "waterfox-onboarding-start-button",
          },
          action: {
            navigate: true,
          },
        },
      }),
    },
    {
      id: "AW_WATERFOX_IMPORT",
      content: splitContent({
        hide_secondary_section: "responsive",
        logo: {},
        tiles: {
          type: "migration-wizard",
          migration_wizard_options: {
            migrator_key: "firefox-import",
            force_show_import_all: true,
            selection_header_string: "",
            hide_option_expander_subtitle: true,
            checkbox_margin_block: "4px",
            header_font_size: "1em",
            header_font_weight: "var(--font-weight-heading)",
            header_margin_block: "0 var(--space-medium)",
            subheader_font_size: "0.9em",
            subheader_margin_block: "0 var(--space-medium)",
          },
        },
        title: {
          string_id: "waterfox-onboarding-import-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-import-subtitle",
        },
        migrate_start: {
          action: {},
        },
        migrate_close: {
          action: {
            navigate: true,
          },
        },
        secondary_button: {
          label: {
            string_id: "waterfox-onboarding-skip-button",
          },
          action: {
            navigate: true,
          },
        },
      }),
    },
    {
      id: "AW_WATERFOX_STYLE",
      content: splitContent({
        logo: {},
        title: {
          string_id: "waterfox-onboarding-style-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-style-subtitle",
        },
        tiles: [
          {
            type: "single-select",
            class_name: "waterfox-style",
            selected: "waterfox-style-nova",
            action: {
              picker: "<event>",
            },
            data: [styleTile("nova"), styleTile("proton"), styleTile("photon")],
          },
          {
            type: "single-select",
            class_name: "waterfox-density",
            selected: "waterfox-density-compact",
            action: {
              picker: "<event>",
            },
            data: [
              densityTile(
                "compact",
                "waterfox-onboarding-density-compact-label"
              ),
              densityTile("normal", "waterfox-onboarding-density-normal-label"),
            ],
          },
        ],
        primary_button: {
          label: {
            string_id: "waterfox-onboarding-continue-button",
          },
          action: {
            navigate: true,
          },
        },
        secondary_button: {
          label: {
            string_id: "waterfox-onboarding-customize-appearance-button",
          },
          action: customizeSettingsAction("preferences#appearance"),
        },
      }),
    },
    {
      id: "AW_WATERFOX_THEME_COLOR",
      content: splitContent({
        title: {
          string_id: "waterfox-onboarding-theme-color-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-theme-color-subtitle",
        },
        tiles: [
          {
            type: "single-select",
            class_name: "waterfox-theme-mode",
            selected: "waterfox-theme-mode-system",
            action: {
              picker: "<event>",
            },
            data: [
              themeModeTile(
                "system",
                "waterfox-onboarding-theme-mode-system-label"
              ),
              themeModeTile(
                "light",
                "waterfox-onboarding-theme-mode-light-label"
              ),
              themeModeTile(
                "dark",
                "waterfox-onboarding-theme-mode-dark-label"
              ),
            ],
          },
          {
            type: "single-select",
            class_name: "waterfox-color-grid",
            selected: "waterfox-color-default",
            action: {
              picker: "<event>",
            },
            data: WaterfoxThemeColors.colors.map(themeColorTile),
          },
        ],
        primary_button: {
          label: {
            string_id: "waterfox-onboarding-save-continue-button",
          },
          action: {
            navigate: true,
          },
        },
        secondary_button: {
          label: {
            string_id: "waterfox-onboarding-skip-step-button",
          },
          has_arrow_icon: true,
          action: {
            navigate: true,
          },
        },
      }),
    },
    {
      id: "AW_WATERFOX_TABS",
      content: splitContent({
        logo: {},
        title: {
          string_id: "waterfox-onboarding-tabs-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-tabs-subtitle",
        },
        tiles: [
          {
            type: "single-select",
            selected: "waterfox-layout-horizontal",
            action: {
              picker: "<event>",
            },
            data: [
              layoutTile({
                id: "horizontal",
                labelId: "waterfox-onboarding-tabs-horizontal-label",
                bodyId: "waterfox-onboarding-tabs-horizontal-body",
                icon: "chrome://browser/content/waterfox/onboarding/browser-layout-horizontal.svg",
              }),
              layoutTile({
                id: "vertical",
                labelId: "waterfox-onboarding-tabs-vertical-label",
                bodyId: "waterfox-onboarding-tabs-vertical-body",
                icon: "chrome://browser/content/waterfox/onboarding/browser-layout-vertical.svg",
              }),
              layoutTile({
                id: "tree",
                labelId: "waterfox-onboarding-tabs-tree-label",
                bodyId: "waterfox-onboarding-tabs-tree-body",
                icon: "chrome://browser/content/waterfox/onboarding/browser-layout-tree.svg",
              }),
            ],
          },
          {
            type: "single-select",
            class_name: "waterfox-tab-location",
            selected: "waterfox-location-topabove",
            action: {
              picker: "<event>",
            },
            data: [
              tabLocationTile(
                "topabove",
                "waterfox-onboarding-location-top-above-label"
              ),
              tabLocationTile(
                "topbelow",
                "waterfox-onboarding-location-top-below-label"
              ),
              tabLocationTile(
                "bottomabove",
                "waterfox-onboarding-location-bottom-above-label"
              ),
              tabLocationTile(
                "bottombelow",
                "waterfox-onboarding-location-bottom-below-label"
              ),
            ],
          },
        ],
        primary_button: {
          label: {
            string_id: "waterfox-onboarding-continue-button",
          },
          action: {
            navigate: true,
          },
        },
        secondary_button: {
          label: {
            string_id: "waterfox-onboarding-customize-tabs-button",
          },
          action: customizeSettingsAction("preferences#tabsBrowsing"),
        },
      }),
    },
    {
      id: "AW_WATERFOX_PRIVACY",
      content: splitContent({
        logo: {},
        title: {
          string_id: "waterfox-onboarding-privacy-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-privacy-subtitle",
        },
        primary_button: {
          label: {
            string_id: "waterfox-onboarding-privacy-primary-button",
          },
          action: waterfoxAction("privacy-defaults", true, true),
        },
        secondary_button: {
          label: {
            string_id: "waterfox-onboarding-customize-privacy-button",
          },
          action: customizeSettingsAction("preferences#adBlocking"),
        },
      }),
    },
    {
      id: "AW_WATERFOX_DEFAULT_BROWSER",
      targeting: "needDefault",
      content: splitContent({
        logo: {},
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
        secondary_button: {
          label: {
            string_id: "waterfox-onboarding-skip-button",
          },
          action: {
            navigate: true,
          },
        },
      }),
    },
    {
      id: "AW_WATERFOX_FINISH",
      content: splitContent({
        logo: {
          imageURL: "chrome://branding/content/about-logo.svg",
          height: "80px",
          width: "80px",
        },
        title: {
          string_id: "waterfox-onboarding-finish-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-finish-subtitle",
        },
        primary_button: {
          label: {
            string_id: "waterfox-onboarding-finish-primary-button",
          },
          action: {
            type: "OPEN_ABOUT_PAGE",
            navigate: true,
            data: {
              args: "home",
              where: "current",
            },
          },
        },
      }),
    },
  ],
};

export const WaterfoxOnboarding = {
  getDefaults() {
    return Cu.cloneInto(WATERFOX_ONBOARDING, {});
  },
};
