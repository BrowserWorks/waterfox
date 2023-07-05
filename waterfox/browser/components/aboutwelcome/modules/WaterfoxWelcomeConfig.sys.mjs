/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * WaterfoxWelcomeConfig - Custom configuration system for about:welcome
 *
 * This module provides Waterfox-specific configuration overrides for the
 * about:welcome onboarding experience, replacing Nimbus experiment configuration.
 */

const lazy = {};

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  const { Logger } = ChromeUtils.importESModule(
    "resource://messaging-system/lib/Logger.sys.mjs"
  );
  return new Logger("WaterfoxWelcomeConfig");
});

// Simplified Waterfox-specific welcome configuration for testing
const WATERFOX_WELCOME_CONFIG = {
  template: "multistage",
  backdrop: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",

  screens: [
    {
      id: "AW_WATERFOX_WELCOME",
      content: {
        fullscreen: true,
        position: "split",
        progress_bar: true,
        logo: {},
        background: "url('chrome://onboarding/content/assets/loving-doodle.svg') center center / 400px no-repeat var(--mr-screen-background-color)",
        title: {
          raw: "Welcome to Waterfox",
        },
        subtitle: {
          raw: "The privacy-focused browser that puts you in control of your web experience",
        },
        primary_button: {
          label: {
            raw: "Let's Get Started",
          },
          action: {
            navigate: true,
          },
        },
      },
    },
    {
      id: "AW_IMPORT_SETTINGS",
      content: {
        fullscreen: true,
        position: "split",
        progress_bar: true,
        background: "url('chrome://activity-stream/content/data/content/assets/mr-import.svg') var(--mr-secondary-position) no-repeat var(--mr-screen-background-color)",
        title: {
          raw: "Import your data",
        },
        subtitle: {
          raw: "Bring your bookmarks, passwords, and more from your previous browser",
        },
        tiles: {
          type: "migration-wizard",
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
            raw: "Skip",
          },
          action: {
            navigate: true,
          },
          has_arrow_icon: true,
        },
      },
    },
    {
      id: "AW_CHOOSE_THEME",
      content: {
        fullscreen: true,
        position: "split",
        progress_bar: true,
        title: {
          raw: "Choose your theme",
        },
        background: "url('chrome://onboarding/content/assets/plant-doodle.svg') center center / 400px no-repeat var(--mr-screen-background-color)",
        subtitle: {
          raw: "Make Waterfox look the way you want",
        },
        tiles: {
          type: "theme",
          action: {
            theme: "<event>",
          },
          data: [
            {
              theme: "automatic",
              label: "Automatic",
              tooltip: "Follow your system appearance",
              description: "Adapts to your system settings",
            },
            {
              theme: "light",
              label: "Light",
              tooltip: "Use a light appearance",
              description: "Bright and clean interface",
            },
            {
              theme: "dark",
              label: "Dark",
              tooltip: "Use a dark appearance",
              description: "Easy on the eyes",
            },
            {
              theme: "alpenglow",
              label: "Alpenglow",
              tooltip: "Use a colorful appearance",
              description: "Vibrant and dynamic",
            },
          ],
        },
        primary_button: {
          label: {
            raw: "Save and Continue",
          },
          action: {
            navigate: true,
          },
        },
      },
    },
    {
      id: "AW_ADDON_RECOMMENDATIONS",
      content: {
        fullscreen: true,
        position: "split",
        progress_bar: true,
        title: {
          raw: "Recommended Extensions",
        },
        background: "url('chrome://onboarding/content/assets/float-doodle.svg') center center / 400px no-repeat var(--mr-screen-background-color)",
        subtitle: {
          raw: "Enhance your Waterfox experience with these popular extensions",
        },
        tiles: {
          type: "addons-picker",
          data: [
            {
              id: "sponsorBlocker@ajay.app",
              name: "SponsorBlock",
              type: "extension",
              description: "Skip sponsorships, subscription begging and more on YouTube videos. Report sponsors on videos you watch to save others' time.",
              icon: "https://addons.mozilla.org/user-media/addon_icons/2590/2590937-64.png",
              author: {
                name: "Ajay Ramachandran",
                byLine: "by",
                id: "13574006",
              },
              install_label: "Add to Waterfox",
              install_complete_label: "Added",
              action: {
                type: "INSTALL_ADDON_FROM_URL",
                data: {
                  url: "https://addons.mozilla.org/firefox/downloads/latest/sponsorblock",
                },
              },
            },
            {
              id: "password-manager-firefox-extension@apple.com",
              name: "iCloud Passwords",
              type: "extension",
              description: "Access your iCloud Keychain passwords and passkeys in Firefox.",
              icon: "https://addons.mozilla.org/user-media/addon_icons/2819/2819247-64.png",
              author: {
                name: "Apple Inc.",
                byLine: "by",
                id: "4757635",
              },
              install_label: "Add to Waterfox",
              install_complete_label: "Added",
              action: {
                type: "INSTALL_ADDON_FROM_URL",
                data: {
                  url: "https://addons.mozilla.org/firefox/downloads/latest/icloud-passwords",
                },
              },
            },
            {
              id: "@testpilot-containers",
              name: "Multi-Account Containers",
              type: "extension",
              description: "Multi-Account Containers lets you keep parts of your online life separated into color-coded tabs.",
              icon: "https://addons.mozilla.org/user-media/addon_icons/782/782160-64.png",
              author: {
                name: "Mozilla Firefox",
                byLine: "by",
                id: "4757636",
              },
              install_label: "Add to Waterfox",
              install_complete_label: "Added",
              action: {
                type: "INSTALL_ADDON_FROM_URL",
                data: {
                  url: "https://addons.mozilla.org/firefox/downloads/latest/multi-account-containers",
                },
              },
            },
          ],
        },
        primary_button: {
          label: {
            raw: "Continue",
          },
          action: {
            navigate: true,
          },
        },
      },
    },
    {
      id: "AW_SET_DEFAULT_AND_PIN",
      content: {
        fullscreen: true,
        position: "split",
        progress_bar: true,
        background: "url('chrome://activity-stream/content/data/content/assets/mr-pintaskbar.svg') var(--mr-secondary-position) no-repeat var(--mr-screen-background-color)",
        title: {
          raw: "Make Waterfox your default",
        },
        subtitle: {
          raw: "Set Waterfox as your default browser and pin it for easy access",
        },
        tiles: {
          type: "multiselect",
          data: [
            {
              id: "checkbox-1",
              defaultValue: true,
              label: {
                raw: "Set as default browser",
              },
              action: {
                type: "SET_DEFAULT_BROWSER",
              },
            },
            {
              id: "checkbox-2",
              defaultValue: true,
              label: {
                raw: "Pin Waterfox to taskbar",
              },
              action: {
                type: "MULTI_ACTION",
                data: {
                  actions: [
                    {
                      type: "PIN_FIREFOX_TO_TASKBAR",
                    },
                    {
                      type: "PIN_FIREFOX_TO_START_MENU",
                    },
                  ],
                },
              },
            },
          ],
        },
        primary_button: {
          label: {
            raw: "Continue",
          },
          action: {
            type: "MULTI_ACTION",
            collectSelect: true,
            navigate: true,
            data: {
              actions: [],
            },
          },
        },
        secondary_button: {
          label: {
            raw: "Skip",
          },
          action: {
            navigate: true,
          },
          has_arrow_icon: true,
        },
      },
    },
    {
      id: "AW_MOBILE_DOWNLOAD",
      content: {
        fullscreen: true,
        position: "split",
        progress_bar: true,
        title: {
          raw: "Get Waterfox for Android",
        },
        subtitle: {
          raw: "Scan the QR code to download Waterfox for your Android device",
        },
        background: "url('chrome://onboarding/content/assets/laying-doodle.svg') center center / 400px no-repeat var(--mr-screen-background-color)",
        tiles: {
          type: "mobile_downloads",
          data: {
            QR_code: {
              image_url: "chrome://onboarding/content/assets/qr-play-google-com.svg",
              alt_text: "QR code to download Waterfox for Android",
            },
          },
        },
        primary_button: {
          label: {
            raw: "Continue",
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
        position: "split",
        progress_bar: true,
        background: "url('chrome://onboarding/content/assets/roller-skating-doodle.svg') center center / 80% no-repeat var(--mr-screen-background-color)",
        title: {
          raw: "You're all set!",
        },
        subtitle: {
          raw: "Welcome to Waterfox - your privacy-focused browsing journey begins now!",
        },
        primary_button: {
          label: {
            raw: "Start Browsing",
          },
          action: {
            navigate: true,
            type: "OPEN_URL",
            data: {
              args: "about:home",
            },
          },
        },
      },
    },
  ],
};

export const WaterfoxWelcomeConfig = {
  /**
   * Get the complete Waterfox welcome configuration
   * @returns {Object} The merged configuration object
   */
  getConfig() {
    let config = Cu.cloneInto(WATERFOX_WELCOME_CONFIG, {});

    try {
      lazy.log.debug("Generated Waterfox welcome config", config);
    } catch (e) {
      lazy.log.error("Error generating Waterfox welcome config:", e);
    }

    return config;
  },

  /**
   * Get feature variables (Nimbus compatibility method)
   * @returns {Object} Feature configuration variables
   */
  getAllVariables() {
    return this.getConfig();
  },

  /**
   * Get enrollment metadata (Nimbus compatibility method)
   * @returns {Object} Empty metadata object
   */
  getEnrollmentMetadata() {
    return {
      slug: "waterfox-default",
      branch: "control",
      source: "waterfox-config",
    };
  },

  /**
   * Check if Waterfox welcome customization is enabled
   * @returns {Boolean} True if enabled
   */
  isEnabled() {
    return true;
  },
};
