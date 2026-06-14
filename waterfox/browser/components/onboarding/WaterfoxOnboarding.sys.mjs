/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

function reviewSettingsAction(args) {
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
      content: {
        fullscreen: true,
        position: "center",
        progress_bar: true,
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
      },
    },
    {
      id: "AW_WATERFOX_IMPORT",
      content: {
        fullscreen: true,
        position: "center",
        progress_bar: true,
        logo: {},
        title: {
          string_id: "waterfox-onboarding-import-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-import-subtitle",
        },
        primary_button: {
          label: {
            string_id: "waterfox-onboarding-import-primary-button",
          },
          action: {
            type: "SHOW_MIGRATION_WIZARD",
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
      },
    },
    {
      id: "AW_WATERFOX_DEFAULT_BROWSER",
      targeting: "needDefault",
      content: {
        fullscreen: true,
        position: "center",
        progress_bar: true,
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
      },
    },
    {
      id: "AW_WATERFOX_APPEARANCE",
      content: {
        fullscreen: true,
        position: "center",
        progress_bar: true,
        logo: {},
        title: {
          string_id: "waterfox-onboarding-appearance-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-appearance-subtitle",
        },
        primary_button: {
          label: {
            string_id: "waterfox-onboarding-appearance-primary-button",
          },
          action: reviewSettingsAction("preferences#appearance"),
        },
        secondary_button: {
          label: {
            string_id: "waterfox-onboarding-next-button",
          },
          action: {
            navigate: true,
          },
        },
      },
    },
    {
      id: "AW_WATERFOX_TABS",
      content: {
        fullscreen: true,
        position: "center",
        progress_bar: true,
        logo: {},
        title: {
          string_id: "waterfox-onboarding-tabs-title",
        },
        subtitle: {
          string_id: "waterfox-onboarding-tabs-subtitle",
        },
        primary_button: {
          label: {
            string_id: "waterfox-onboarding-tabs-primary-button",
          },
          action: reviewSettingsAction("preferences#tabsBrowsing"),
        },
        secondary_button: {
          label: {
            string_id: "waterfox-onboarding-next-button",
          },
          action: {
            navigate: true,
          },
        },
      },
    },
    {
      id: "AW_WATERFOX_PRIVACY",
      content: {
        fullscreen: true,
        position: "center",
        progress_bar: true,
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
          action: reviewSettingsAction("preferences#adBlocking"),
        },
        secondary_button: {
          label: {
            string_id: "waterfox-onboarding-next-button",
          },
          action: {
            navigate: true,
          },
        },
      },
    },
    {
      id: "AW_WATERFOX_FINISH",
      content: {
        fullscreen: true,
        position: "center",
        progress_bar: true,
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
      },
    },
  ],
};

export const WaterfoxOnboarding = {
  getDefaults() {
    return Cu.cloneInto(WATERFOX_ONBOARDING, {});
  },
};
