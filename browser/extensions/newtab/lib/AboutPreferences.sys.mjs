/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  actionTypes as at,
  actionCreators as ac,
} from "resource://newtab/common/Actions.mjs";
import {
  WIDGET_REGISTRY,
  isWidgetToggleVisible,
  isWidgetsContainerVisible,
} from "resource://newtab/common/WidgetsRegistry.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonManager: "resource://gre/modules/AddonManager.sys.mjs",
  BrowserUtils: "resource://gre/modules/BrowserUtils.sys.mjs",
  ExtensionPreferencesManager:
    "resource://gre/modules/ExtensionPreferencesManager.sys.mjs",
  ExtensionSettingsStore:
    "resource://gre/modules/ExtensionSettingsStore.sys.mjs",
  HomePage: "resource:///modules/HomePage.sys.mjs",
  Management: "resource://gre/modules/Extension.sys.mjs",
});

const DEFAULT_HOMEPAGE_URL = "about:home";
const BLANK_HOMEPAGE_URL = "chrome://browser/content/blanktab.html";
const HOMEPAGE_OVERRIDE_KEY = "homepage_override";
const URL_OVERRIDES_TYPE = "url_overrides";
const NEW_TAB_KEY = "newTabURL";
const PREF_SETTING_TYPE = "prefs";

export const PREFERENCES_LOADED_EVENT = "home-pane-loaded";
export const PREFERENCES_LOADED_EVENT_SUBPANE = "customHomepage-pane-loaded";

// These "section" objects are formatted in a way to be similar to the ones from
// SectionsManager to construct the preferences view.
// @nova-cleanup(remove-conditional): Remove novaEnabled check; hardcode feed: "widgets.weather.enabled" and shouldHidePref using widgets.system.weather.enabled; convert function body back to arrow returning array literal
const PREFS_FOR_SETTINGS = () => {
  const novaEnabled = Services.prefs.getBoolPref(
    "browser.newtabpage.activity-stream.nova.enabled",
    false
  );
  return [
    {
      id: "web-search",
      pref: {
        feed: "showSearch",
        titleString: "home-prefs-search-header",
      },
    },
    {
      id: "weather",
      pref: {
        feed: novaEnabled ? "widgets.weather.enabled" : "showWeather",
        titleString: "home-prefs-weather-header",
        descString: "home-prefs-weather-description",
        learnMore: {
          link: {
            href: "https://support.mozilla.org/kb/customize-items-on-firefox-new-tab-page",
            id: "home-prefs-weather-learn-more-link",
          },
        },
      },
      eventSource: "WEATHER",
      shouldHidePref: !Services.prefs.getBoolPref(
        novaEnabled
          ? "browser.newtabpage.activity-stream.widgets.system.weather.enabled"
          : "browser.newtabpage.activity-stream.system.showWeather",
        false
      ),
    },
    {
      id: "topsites",
      pref: {
        feed: "feeds.topsites",
        titleString: "home-prefs-shortcuts-header",
        descString: "home-prefs-shortcuts-description",
      },
      maxRows: 4,
      rowsPref: "topSitesRows",
      eventSource: "TOP_SITES",
    },
    {
      id: "topstories",
      pref: {
        feed: "feeds.section.topstories",
        titleString: {
          id: "home-prefs-recommended-by-header-generic",
        },
        descString: {
          id: "home-prefs-recommended-by-description-generic",
        },
      },
      shouldHidePref: !Services.prefs.getBoolPref(
        "browser.newtabpage.activity-stream.feeds.system.topstories",
        true
      ),
      eventSource: "TOP_STORIES",
    },
    {
      id: "support-firefox",
      pref: {
        feed: "showSponsoredCheckboxes",
        titleString: "home-prefs-support-firefox-header",
        nestedPrefs: [
          {
            name: "showSponsoredTopSites",
            titleString: "home-prefs-shortcuts-by-option-sponsored",
            eventSource: "SPONSORED_TOP_SITES",
          },
          {
            name: "showSponsored",
            titleString: "home-prefs-recommended-by-option-sponsored-stories",
            eventSource: "POCKET_SPOCS",
            shouldHidePref: !Services.prefs.getBoolPref(
              "browser.newtabpage.activity-stream.feeds.system.topstories",
              true
            ),
            shouldDisablePref: !Services.prefs.getBoolPref(
              "browser.newtabpage.activity-stream.feeds.section.topstories",
              true
            ),
          },
        ],
      },
    },
  ];
};

/**
 * Queries ExtensionSettingsStore for active extensions of the given type/key
 * and returns dropdown option objects for each.
 *
 * @param {string} type - The setting type (e.g. "prefs" or "url_overrides").
 * @param {string} key - The setting key (e.g. "homepage_override" or "newTabURL").
 * @returns {Promise<Array<{value: string, l10nId: string, l10nArgs: object}>>}
 */
async function getExtensionOptions(type, key) {
  await lazy.ExtensionSettingsStore.initialize();
  let extensionSettings = lazy.ExtensionSettingsStore.getAllSettings(type, key);
  let options = [];
  // Skip extensions that have already been disabled or uninstalled — the
  // store can briefly still list them after the extension has shut down.
  for (let { id } of extensionSettings) {
    let policy = WebExtensionPolicy.getByID(id);
    if (policy) {
      options.push({
        value: policy.id,
        l10nId: "home-prefs-homepage-extension-option",
        l10nArgs: { extension: policy.name },
      });
    }
  }
  return options;
}

function getActiveExtensionForSetting(type, key) {
  try {
    let setting = lazy.ExtensionSettingsStore.getSetting(type, key);
    return setting?.id && WebExtensionPolicy.getByID(setting.id);
  } catch (e) {
    // ExtensionSettingsStore can throw if not yet initialized.
    console.error(e);
    return null;
  }
}

function getHomepageActiveExtension() {
  let ext = getActiveExtensionForSetting(
    PREF_SETTING_TYPE,
    HOMEPAGE_OVERRIDE_KEY
  );
  if (ext) {
    return ext;
  }
  let prefVal = Services.prefs.getStringPref("browser.startup.homepage", "");
  try {
    let uri = Services.io.newURI(prefVal);
    return WebExtensionPolicy.getByURI(uri);
  } catch {
    return null;
  }
}

/**
 * Build an AddonManager listener that runs `refreshFn` for any of the four
 * lifecycle events that affect the dropdown.
 *
 * @param {() => void} refreshFn
 * @returns {object}
 */
function makeAddonListenerForRefresh(refreshFn) {
  return {
    onEnabled: refreshFn,
    onDisabled: refreshFn,
    onInstalled: refreshFn,
    onUninstalled: refreshFn,
  };
}

/**
 * Build a Management "extension-setting-changed" handler that runs `refreshFn`
 * when the changed setting matches the given type and key.
 *
 * @param {string} type
 * @param {string} key
 * @param {() => void} refreshFn
 * @returns {(eventName: string, changedSetting: object) => void}
 */
function makeExtensionSettingChangedListener(type, key, refreshFn) {
  return (_evt, changedSetting) => {
    if (changedSetting.key === key && changedSetting.type === type) {
      refreshFn();
    }
  };
}

/**
 * Force the moz-select value after the DOM has settled. Setting the value
 * in the same tick that the option is added doesn't take effect, so we
 * defer to the next animation frame.
 *
 * @param {Window} window - The preferences window.
 * @param {string} settingId - The setting ID (e.g. "homepageNewWindows").
 * @param {string|null} value - The value to set on the moz-select.
 */
function forceSelectValue(window, settingId, value) {
  if (!value || window.closed) {
    return;
  }
  window.requestAnimationFrame(() => {
    let control = window.document.getElementById(
      `setting-control-${settingId}`
    );
    // Setting may live on the home pane while we're rendered on the
    // customHomepage subpage — silently skip if the control isn't on the
    // active pane.
    if (!control) {
      return;
    }
    control.controlEl.value = value;
  });
}

export class AboutPreferences {
  init() {
    Services.obs.addObserver(this, PREFERENCES_LOADED_EVENT);
    Services.obs.addObserver(this, PREFERENCES_LOADED_EVENT_SUBPANE);
    // Load the extension-settings modules so that "extension-setting-changed"
    // events fire reliably for the listeners registered in setup().
    lazy.Management.asyncLoadSettingsModules();
  }

  uninit() {
    Services.obs.removeObserver(this, PREFERENCES_LOADED_EVENT);
    Services.obs.removeObserver(this, PREFERENCES_LOADED_EVENT_SUBPANE);
  }

  onAction(action) {
    switch (action.type) {
      case at.INIT:
        this.init();
        break;
      case at.UNINIT:
        this.uninit();
        break;
      case at.SETTINGS_OPEN:
        action._target.window.openPreferences("paneHome");
        break;
      // This is used to open the web extension settings page for an extension
      case at.OPEN_WEBEXT_SETTINGS:
        action._target.window.BrowserAddonUI.openAddonsMgr(
          `addons://detail/${encodeURIComponent(action.data)}`
        );
        break;
    }
  }

  setupUserEvent(element, eventSource) {
    element.addEventListener("command", e => {
      const { checked } = e.target;
      if (typeof checked === "boolean") {
        this.store.dispatch(
          ac.UserEvent({
            event: "PREF_CHANGED",
            source: eventSource,
            value: { status: checked, menu_source: "ABOUT_PREFERENCES" },
          })
        );
      }
    });
  }

  observe(window) {
    if (Services.prefs.getBoolPref("browser.settings-redesign.enabled")) {
      const { SettingGroupManager } = window;

      window.MozXULElement.insertFTLIfNeeded("browser/newtab/newtab.ftl");

      // We observe 2 signals that about:settings is loading - the
      // PREFERENCES_LOADED_EVENT and PREFERENCES_LOADED_EVENT_SUBPANE
      // observer notifications. The first is fired anytime about:settings
      // is loaded directly. The second (and not the first) fires if loading
      // about:preferences#customHomepage. We handle those cases by observing
      // both, and checking to see if the "homepage" settings group was already
      // registered. If so, we take that as a sign that we don't need to
      // re-register and then we bail out.
      try {
        if (SettingGroupManager.get("homepage")) {
          // The homepage group has already been registered for this load of
          // about:settings, so no need to do it again. Bail out.
          return;
        }
      } catch (e) {
        // We didn't find the homepage settings group registered. That's okay,
        // we'll register the group(s) now - that's what we're here for.
      }

      this._registerPreferences(window);

      SettingGroupManager.registerGroups({
        homepage: this._setupHomepageGroup(window),
        customHomepage: this._setupCustomHomepageGroup(window),
        home: this._setupHomeGroup(window),
      });
      return;
    }

    // Legacy settings UI
    const { document, Preferences } = window;

    // Extract just the "Recent activity" pref info from SectionsManager as we have everything else already
    const highlights = this.store
      .getState()
      .Sections.find(el => el.id === "highlights");

    const allSections = [...PREFS_FOR_SETTINGS(), highlights];

    // Render the preferences
    allSections.forEach(pref => {
      this.renderPreferenceSection(pref, document, Preferences);
    });

    // Update the visibility of the Restore Defaults button based on checked prefs
    this.toggleRestoreDefaults(window.gHomePane);
  }

  /** @param {Window} window */
  _registerPreferences(window) {
    const { Preferences } = window;

    Preferences.addAll([
      { id: "browser.newtabpage.activity-stream.showSearch", type: "bool" },
      {
        id: "browser.newtabpage.activity-stream.hideLogo",
        type: "bool",
        inverted: true,
      },
      {
        id: "browser.newtabpage.activity-stream.system.showWeather",
        type: "bool",
      },
      { id: "browser.newtabpage.activity-stream.showWeather", type: "bool" },
      {
        id: "browser.newtabpage.activity-stream.widgets.system.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.system.weather.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.weather.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.system.lists.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.lists.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.system.focusTimer.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.focusTimer.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.system.sportsWidget.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.sportsWidget.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.system.clocks.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.widgets.clocks.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.feeds.topsites",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.topSitesRows",
        type: "int",
      },
      {
        id: "browser.newtabpage.activity-stream.feeds.system.topstories",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.feeds.section.topstories",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.discoverystream.sections.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.discoverystream.topicLabels.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.discoverystream.sections.personalization.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.discoverystream.sections.customizeMenuPanel.enabled",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.showSponsoredCheckboxes",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.showSponsoredTopSites",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.showSponsored",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.feeds.section.highlights",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.section.highlights.rows",
        type: "int",
      },
      {
        id: "browser.newtabpage.activity-stream.section.highlights.includeVisited",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.section.highlights.includeBookmarks",
        type: "bool",
      },
      {
        id: "browser.newtabpage.activity-stream.section.highlights.includeDownloads",
        type: "bool",
      },
    ]);
  }

  /** @param {Window} window */
  _setupHomepageGroup(window) {
    const { Preferences } = window;

    // Set up `browser.startup.homepage` to show homepage options for Homepage / New Windows
    let homepageExtOptions = [];
    Preferences.addSetting(
      /** @type {{ useCustomHomepage: boolean } & SettingConfig } */ ({
        id: "homepageNewWindows",
        pref: "browser.startup.homepage",
        useCustomHomepage: false,
        setup(onChange) {
          let refreshExtensions = async () => {
            homepageExtOptions = await getExtensionOptions(
              PREF_SETTING_TYPE,
              HOMEPAGE_OVERRIDE_KEY
            );
            if (!window.closed) {
              onChange();
              let ext = getHomepageActiveExtension();
              forceSelectValue(window, "homepageNewWindows", ext?.id);
            }
          };

          refreshExtensions().catch(e =>
            console.error("Failed to refresh homepage extensions", e)
          );

          // Refresh whenever the homepage pref changes — covers third-party
          // writes (enterprise policy, manual edits) that bypass the
          // extension-setting-changed event.
          let homepagePrefObserver = () => {
            onChange();
            let ext = getHomepageActiveExtension();
            forceSelectValue(window, "homepageNewWindows", ext?.id);
          };
          Services.prefs.addObserver(
            "browser.startup.homepage",
            homepagePrefObserver
          );

          let onExtensionChange = makeExtensionSettingChangedListener(
            PREF_SETTING_TYPE,
            HOMEPAGE_OVERRIDE_KEY,
            refreshExtensions
          );
          lazy.Management.on("extension-setting-changed", onExtensionChange);

          let addonListener = makeAddonListenerForRefresh(refreshExtensions);
          lazy.AddonManager.addAddonListener(addonListener);

          return () => {
            lazy.AddonManager.removeAddonListener(addonListener);
            lazy.Management.off("extension-setting-changed", onExtensionChange);
            Services.prefs.removeObserver(
              "browser.startup.homepage",
              homepagePrefObserver
            );
          };
        },
        get(prefVal) {
          if (this.useCustomHomepage) {
            return "custom";
          }
          let ext = getHomepageActiveExtension();
          if (ext) {
            return ext.id;
          }
          switch (prefVal) {
            case DEFAULT_HOMEPAGE_URL:
              return "home";
            case BLANK_HOMEPAGE_URL:
              return "blank";
            // Custom value can be any string so leaving it as default value to catch
            // non-default/blank entries.
            default:
              return "custom";
          }
        },
        set(inputVal, _, setting) {
          let wasCustomHomepage = this.useCustomHomepage;
          this.useCustomHomepage = inputVal === "custom";
          if (wasCustomHomepage !== this.useCustomHomepage) {
            setting.onChange();
          }

          // Deselection uses the low-level ExtensionSettingsStore API
          // because the pref is already being set by the return value.
          if (["home", "blank", "custom"].includes(inputVal)) {
            let currentAddon = getActiveExtensionForSetting(
              PREF_SETTING_TYPE,
              HOMEPAGE_OVERRIDE_KEY
            );
            if (currentAddon) {
              try {
                lazy.ExtensionSettingsStore.select(
                  null,
                  PREF_SETTING_TYPE,
                  HOMEPAGE_OVERRIDE_KEY
                );
              } catch (e) {
                console.error("Failed to deselect homepage extension", e);
              }
            }
          }

          switch (inputVal) {
            case "home":
              return DEFAULT_HOMEPAGE_URL;
            case "blank":
              return BLANK_HOMEPAGE_URL;
            case "custom":
              return setting.pref.value;
            default:
              // Selection uses ExtensionPreferencesManager.selectSetting,
              // which also applies the extension's pref value.
              lazy.ExtensionPreferencesManager.selectSetting(
                inputVal,
                HOMEPAGE_OVERRIDE_KEY
              ).catch(e =>
                console.error("Failed to select homepage extension", e)
              );
              return setting.pref.value;
          }
        },
        getControlConfig(config) {
          // `config` is retained across renders, so filter back to the
          // static builtins before reattaching the current extension entries.
          let builtinValues = new Set(["home", "blank", "custom"]);
          let builtinOptions = config.options.filter(o =>
            builtinValues.has(o.value)
          );
          let extOptions = [...homepageExtOptions];
          // Add an option for extensions that set the homepage pref
          // directly without registering in ExtensionSettingsStore.
          let ext = getHomepageActiveExtension();
          if (ext && !extOptions.some(o => o.value === ext.id)) {
            extOptions.push({
              value: ext.id,
              l10nId: "home-prefs-homepage-extension-option",
              l10nArgs: { extension: ext.name },
            });
          }
          return {
            ...config,
            options: [...builtinOptions, ...extOptions],
          };
        },
      })
    );

    // Set up `browser.startup.homepage` again to update and display its value
    // on the Homepage and Custom Homepage settings panes.
    Preferences.addSetting({
      id: "homepageDisplayPref",
      pref: "browser.startup.homepage",
    });

    Preferences.addSetting({
      id: "disableCurrentPagesButton",
      pref: "pref.browser.homepage.disable_button.current_page",
    });

    Preferences.addSetting({
      id: "disableBookmarkButton",
      pref: "pref.browser.homepage.disable_button.bookmark_page",
    });

    // Homepage / Choose Custom Homepage URL Button
    Preferences.addSetting({
      id: "homepageGoToCustomHomepageUrlPanel",
      deps: ["homepageNewWindows", "homepageDisplayPref"],
      visible: ({ homepageNewWindows }) => {
        return homepageNewWindows.value === "custom";
      },
      onUserClick: () => {
        window.gotoPref("customHomepage");
      },

      getControlConfig(config, { homepageDisplayPref }) {
        let customURLsDescription;

        // Make sure we only show user-provided values for custom URLs rather than
        // values we set in `browser.startup.homepage` for "Firefox Home",
        // "Blank Page", or extension-controlled URLs.
        let prefVal = homepageDisplayPref.value.trim();
        if ([DEFAULT_HOMEPAGE_URL, BLANK_HOMEPAGE_URL].includes(prefVal)) {
          customURLsDescription = null;
        } else {
          // Add a comma-separated list of Custom URLs the user set for their homepage
          // to the description part of the "Choose a specific site" box button.
          customURLsDescription = homepageDisplayPref.value
            .split("|")
            .map(uri => lazy.BrowserUtils.formatURIStringForDisplay(uri))
            .filter(Boolean)
            .join(", ");
        }

        return {
          ...config,
          controlAttrs: {
            ...config.controlAttrs,
            ".description": customURLsDescription,
          },
        };
      },
    });

    // Homepage / New Tabs
    let newTabExtOptions = [];
    Preferences.addSetting({
      id: "homepageNewTabs",
      pref: "browser.newtabpage.enabled",
      setup(onChange) {
        let refreshExtensions = async () => {
          newTabExtOptions = await getExtensionOptions(
            URL_OVERRIDES_TYPE,
            NEW_TAB_KEY
          );
          if (!window.closed) {
            onChange();
            let activeId = getActiveExtensionForSetting(
              URL_OVERRIDES_TYPE,
              NEW_TAB_KEY
            )?.id;
            forceSelectValue(window, "homepageNewTabs", activeId);
          }
        };

        refreshExtensions().catch(e =>
          console.error("Failed to refresh new tab extensions", e)
        );

        let onExtensionChange = makeExtensionSettingChangedListener(
          URL_OVERRIDES_TYPE,
          NEW_TAB_KEY,
          refreshExtensions
        );
        lazy.Management.on("extension-setting-changed", onExtensionChange);

        // Pick up extension installs that set AboutNewTab.newTabURL directly.
        let newTabObserver = () => refreshExtensions();
        Services.obs.addObserver(newTabObserver, "newtab-url-changed");

        let addonListener = makeAddonListenerForRefresh(refreshExtensions);
        lazy.AddonManager.addAddonListener(addonListener);

        return () => {
          lazy.AddonManager.removeAddonListener(addonListener);
          Services.obs.removeObserver(newTabObserver, "newtab-url-changed");
          lazy.Management.off("extension-setting-changed", onExtensionChange);
        };
      },
      get(prefVal) {
        // No URL-based fallback — new tab extensions always register
        // through ExtensionSettingsStore.
        let activeId = getActiveExtensionForSetting(
          URL_OVERRIDES_TYPE,
          NEW_TAB_KEY
        )?.id;
        if (activeId) {
          return activeId;
        }
        return prefVal ? "home" : "blank";
      },
      set(inputVal) {
        if (inputVal === "home" || inputVal === "blank") {
          let currentAddon = getActiveExtensionForSetting(
            URL_OVERRIDES_TYPE,
            NEW_TAB_KEY
          );
          if (currentAddon) {
            try {
              // Deselecting via the low-level API is sufficient here;
              // the url_overrides machinery listens for this and resets
              // AboutNewTab.newTabURL.
              lazy.ExtensionSettingsStore.select(
                null,
                URL_OVERRIDES_TYPE,
                NEW_TAB_KEY
              );
            } catch (e) {
              console.error("Failed to deselect new tab extension", e);
            }
          }
          return inputVal === "home";
        }
        try {
          lazy.ExtensionSettingsStore.select(
            inputVal,
            URL_OVERRIDES_TYPE,
            NEW_TAB_KEY
          );
        } catch (e) {
          console.error("Failed to select new tab extension", e);
        }
        return true;
      },
      getControlConfig(config) {
        // `config` is retained across renders, so filter back to the
        // static builtins before reattaching the current extension entries.
        let builtinValues = new Set(["home", "blank"]);
        let builtinOptions = config.options.filter(o =>
          builtinValues.has(o.value)
        );
        return {
          ...config,
          options: [...builtinOptions, ...newTabExtOptions],
        };
      },
    });

    // Homepage / Restore Defaults button
    Preferences.addSetting({
      id: "homepageRestoreDefaults",
      pref: "pref.browser.homepage.disable_button.restore_default",
      deps: ["homepageNewWindows", "homepageNewTabs"],
      disabled: ({ homepageNewWindows, homepageNewTabs }) => {
        return (
          homepageNewWindows.value === "home" &&
          homepageNewTabs.value === "home"
        );
      },
      onUserClick: (e, { homepageNewWindows, homepageNewTabs }) => {
        e.preventDefault();

        homepageNewWindows.value = "home";
        homepageNewTabs.value = "home";
      },
    });

    return {
      inProgress: true,
      headingLevel: 2,
      iconSrc: "chrome://branding/content/about-logo.svg",
      l10nId: "home-homepage-title",
      subcategory: "homepage",
      items: [
        {
          id: "homepageNewWindows",
          subcategory: "homeOverride",
          control: "moz-select",
          l10nId: "home-homepage-new-windows",
          options: [
            {
              value: "home",
              l10nId: "home-mode-choice-default-fx-srd",
            },
            { value: "blank", l10nId: "home-mode-choice-blank-srd" },
            { value: "custom", l10nId: "home-mode-choice-custom-srd" },
          ],
        },
        {
          id: "homepageGoToCustomHomepageUrlPanel",
          control: "moz-box-button",
          l10nId: "home-homepage-custom-homepage-button",
          loadPane: "customHomepage",
        },
        {
          id: "homepageNewTabs",
          subcategory: "newtabOverride",
          control: "moz-select",
          l10nId: "home-homepage-new-tabs",
          options: [
            {
              value: "home",
              l10nId: "home-mode-choice-default-fx-srd",
            },
            { value: "blank", l10nId: "home-mode-choice-blank-srd" },
          ],
        },
        {
          id: "homepageRestoreDefaults",
          control: "moz-button",
          iconSrc: "chrome://global/skin/icons/arrow-counterclockwise-16.svg",
          l10nId: "home-restore-defaults-srd",
          controlAttrs: { id: "restoreDefaultHomePageBtn" },
        },
      ],
    };
  }

  /** @param {Window} window */
  _setupCustomHomepageGroup(window) {
    const { Preferences } = window;

    Preferences.addSetting(
      /** @type {{ _inputValue: string } & SettingConfig } */ ({
        id: "customHomepageAddUrlInput",
        deps: ["homepageDisplayPref"],
        _inputValue: "",
        get() {
          return this._inputValue;
        },
        set(val, _, setting) {
          this._inputValue = val.trim();
          setting.onChange();
        },
        disabled({ homepageDisplayPref }) {
          return homepageDisplayPref.locked;
        },
      })
    );

    Preferences.addSetting({
      id: "customHomepageAddAddressButton",
      deps: ["homepageDisplayPref", "customHomepageAddUrlInput"],
      onUserClick(e, { homepageDisplayPref, customHomepageAddUrlInput }) {
        // Focus is being stolen by a parent component here (moz-fieldset).
        // Focus on the button to get the input value.
        e.target.focus();

        let inputVal = customHomepageAddUrlInput.value;

        // Don't do anything for empty strings
        if (!inputVal) {
          return;
        }

        let currentVal = homepageDisplayPref.value.trim();
        if (
          [DEFAULT_HOMEPAGE_URL, BLANK_HOMEPAGE_URL].includes(currentVal) ||
          currentVal.startsWith("moz-extension://")
        ) {
          // Replace non-custom homepage values with the new Custom URL.
          homepageDisplayPref.value = inputVal;
        } else {
          // Append this URL to the list of Custom URLs saved in prefs.
          let urls = lazy.HomePage.parseCustomHomepageURLs(
            homepageDisplayPref.value
          );
          urls.push(inputVal);
          homepageDisplayPref.value = urls.join("|");
        }

        // Reset the field to empty string
        customHomepageAddUrlInput.value = "";
      },
      disabled({ homepageDisplayPref }) {
        return homepageDisplayPref.locked;
      },
    });

    Preferences.addSetting({
      id: "customHomepageReplaceWithCurrentPagesButton",
      deps: ["homepageDisplayPref", "disableCurrentPagesButton"],
      // Re-evaluate disabled state on tab open/close (add/remove tabs) and
      // pin/unpin (changes what getTabsForCustomHomepage() captures).
      setup(emitChange) {
        let win = /** @type {any} */ (
          Services.wm.getMostRecentWindow("navigator:browser")
        );
        if (!win) {
          return () => {};
        }
        const { tabContainer } = win.gBrowser;
        // Best-effort filter: skip events from tabs already showing about:preferences.
        // TabOpen fires before the URI is set, so it isn't caught here;
        // the real exclusion happens inside getTabsForCustomHomepage().
        const onTabChange = (/** @type {Event & { target: any }} */ event) => {
          if (
            event.target.linkedBrowser?.currentURI?.spec?.startsWith(
              "about:preferences"
            )
          ) {
            return;
          }
          emitChange();
        };
        tabContainer.addEventListener("TabOpen", onTabChange);
        tabContainer.addEventListener("TabClose", onTabChange);
        tabContainer.addEventListener("TabPinned", onTabChange);
        tabContainer.addEventListener("TabUnpinned", onTabChange);
        return () => {
          tabContainer.removeEventListener("TabOpen", onTabChange);
          tabContainer.removeEventListener("TabClose", onTabChange);
          tabContainer.removeEventListener("TabPinned", onTabChange);
          tabContainer.removeEventListener("TabUnpinned", onTabChange);
        };
      },
      onUserClick(e, { homepageDisplayPref }) {
        let tabs = lazy.HomePage.getTabsForCustomHomepage();

        if (tabs.length) {
          homepageDisplayPref.value = tabs
            .map(t => t.linkedBrowser.currentURI.spec)
            .join("|");
        }
      },
      disabled: ({ disableCurrentPagesButton, homepageDisplayPref }) =>
        // Disable this button if the only open tab is `about:preferences`/`about:settings`
        // or when an enterprise policy sets a special pref to true
        lazy.HomePage.getTabsForCustomHomepage().length < 1 ||
        disableCurrentPagesButton?.value === true ||
        homepageDisplayPref.locked,
    });

    Preferences.addSetting({
      id: "customHomepageReplaceWithBookmarksButton",
      deps: ["homepageDisplayPref", "disableBookmarkButton"],
      onUserClick(e, { homepageDisplayPref }) {
        const rv = { urls: null, names: null };

        // Callback to use when bookmark dialog closes
        const closingCallback = event => {
          if (event.detail.button !== "accept") {
            return;
          }
          if (rv.urls) {
            homepageDisplayPref.value = rv.urls.join("|");
          }
        };

        window.gSubDialog.open(
          "chrome://browser/content/preferences/dialogs/selectBookmark.xhtml",
          {
            features: "resizable=yes, modal=yes",
            closingCallback,
          },
          rv
        );
      },
      disabled: ({ disableBookmarkButton, homepageDisplayPref }) =>
        // Disable this button if an enterprise policy sets a special pref to true
        disableBookmarkButton?.value === true || homepageDisplayPref.locked,
    });

    Preferences.addSetting({
      id: "customHomepageBoxGroup",
      deps: ["homepageDisplayPref"],
      setup(onChange) {
        // Refresh the list when an extension's policy registers or
        // unregisters, so an extension URL in the pref renders as
        // "Extension (Name)" once the policy becomes available (and falls
        // back to the raw URL if it goes away).
        let onExtensionChange = makeExtensionSettingChangedListener(
          PREF_SETTING_TYPE,
          HOMEPAGE_OVERRIDE_KEY,
          onChange
        );
        lazy.Management.on("extension-setting-changed", onExtensionChange);

        let addonListener = makeAddonListenerForRefresh(onChange);
        lazy.AddonManager.addAddonListener(addonListener);

        return () => {
          lazy.AddonManager.removeAddonListener(addonListener);
          lazy.Management.off("extension-setting-changed", onExtensionChange);
        };
      },
      getControlConfig(config, { homepageDisplayPref }) {
        const urls = lazy.HomePage.parseCustomHomepageURLs(
          homepageDisplayPref.value
        );
        let listItems = [];
        let type = "list";

        // Show a reorderable list of Custom URLs if the user has provided any.
        // Make sure to exclude "Firefox Home", "Blank Page", and
        // extension-controlled URLs that are also stored in the homepage pref.
        let currentPrefVal = homepageDisplayPref.value.trim();
        if (
          ![DEFAULT_HOMEPAGE_URL, BLANK_HOMEPAGE_URL].includes(currentPrefVal)
        ) {
          type = homepageDisplayPref.locked ? "list" : "reorderable-list";
          listItems = urls.map((url, index) => ({
            id: `customHomepageUrl-${index}`,
            key: `url-${index}-${url}`,
            control: "moz-box-item",
            controlAttrs: {
              label: lazy.BrowserUtils.formatURIStringForDisplay(url),
              "data-url": url,
            },
            options: homepageDisplayPref.locked
              ? []
              : [
                  {
                    control: "moz-button",
                    iconSrc: "chrome://global/skin/icons/delete.svg",
                    l10nId: "home-custom-homepage-delete-address-button",
                    slot: "actions-start",
                    controlAttrs: {
                      "data-action": "delete",
                      "data-index": index,
                    },
                  },
                ],
          }));
        } else {
          // If no custom URLs have been set, show the "no results" string instead.
          listItems = [
            {
              control: "moz-box-item",
              l10nId: "home-custom-homepage-no-results",
              controlAttrs: {
                class: "description-deemphasized",
              },
            },
          ];
        }

        return {
          ...config,
          controlAttrs: {
            ...config.controlAttrs,
            type,
          },
          options: [
            {
              id: "customHomepageBoxForm",
              control: "moz-box-item",
              slot: "header",
              items: [
                {
                  id: "customHomepageAddUrlInput",
                  l10nId: "home-custom-homepage-address",
                  control: "moz-input-text",
                },
                {
                  id: "customHomepageAddAddressButton",
                  l10nId: "home-custom-homepage-address-button",
                  control: "moz-button",
                  slot: "actions",
                },
              ],
            },
            ...listItems,
            {
              id: "customHomepageBoxActions",
              control: "moz-box-item",
              l10nId: "home-custom-homepage-replace-with-prompt",
              slot: "footer",
              items: [
                {
                  id: "customHomepageReplaceWithCurrentPagesButton",
                  l10nId: "home-custom-homepage-current-pages-button",
                  control: "moz-button",
                  slot: "actions",
                },
                {
                  id: "customHomepageReplaceWithBookmarksButton",
                  l10nId: "home-custom-homepage-bookmarks-button",
                  control: "moz-button",
                  slot: "actions",
                },
              ],
            },
          ],
        };
      },
      onUserReorder(e, { homepageDisplayPref }) {
        let urls = lazy.HomePage.parseCustomHomepageURLs(
          homepageDisplayPref.value
        );
        urls = e.target.reorderArrayFromEvent(urls, e);
        homepageDisplayPref.value = urls.join("|");
      },
      onUserClick(e, { homepageDisplayPref }) {
        let urls = lazy.HomePage.parseCustomHomepageURLs(
          homepageDisplayPref.value
        );

        if (
          e.target.localName === "moz-button" &&
          e.target.getAttribute("data-action") === "delete"
        ) {
          let index = Number(e.target.dataset.index);
          if (Number.isInteger(index) && index >= 0 && index < urls.length) {
            urls.splice(index, 1);
            homepageDisplayPref.value = urls.join("|");
          }
        }
      },
    });

    return {
      inProgress: true,
      headingLevel: 2,
      l10nId: "home-custom-homepage-card-header",
      iconSrc: "chrome://global/skin/icons/link.svg",
      items: [
        {
          id: "customHomepageBoxGroup",
          control: "moz-box-group",
          controlAttrs: {
            type: "list",
          },
        },
      ],
    };
  }

  /** @param {Window} window */
  // eslint-disable-next-line max-statements
  _setupHomeGroup(window) {
    const { Preferences } = window;

    // A widget toggle is shown when its system pref is on OR a trainhop (Nimbus)
    // config enables it. The system-pref half reads the live dep value so the
    // toggle reacts to pref changes without a page refresh; the trainhopConfig
    // half is a snapshot (Nimbus sets it at load, it doesn't change live). The
    // dep id matches the registry trainhopEnabledKey by convention.
    const widgetPrefs = this.store.getState()?.Prefs?.values ?? {};
    const widgetToggleVisible = registryId => {
      const widget = WIDGET_REGISTRY.find(w => w.id === registryId);
      // Resolve via the shared registry helper, but feed the LIVE system-pref
      // value from deps so the toggle still reacts to about:config changes
      // without a page refresh; the trainhop/widgetsSettings terms are a snapshot.
      return deps =>
        isWidgetToggleVisible(widget, {
          ...widgetPrefs,
          [widget.systemEnabledPref]: deps[widget.trainhopEnabledKey]?.value,
        });
    };

    // Build-time snapshot of whether the Widgets container is shown, used only
    // to decide Weather's placement in the items list below. The Widgets group's
    // own visibility is resolved reactively inline.
    const widgetsSystemEnabled = isWidgetsContainerVisible(widgetPrefs);

    // The Firefox Home section should be disabled when neither "New windows"
    // nor "New tabs" is set to Firefox Home.
    const firefoxHomeDeps = ["homepageNewWindows", "homepageNewTabs"];
    const firefoxHomeActive = ({ homepageNewWindows, homepageNewTabs }) =>
      homepageNewWindows.value === "home" || homepageNewTabs.value === "home";

    const HOME_CUSTOMIZE_URL = "about:home#customize";
    const HOME_CUSTOMIZE_TOPICS_URL = "about:home#customize-topics";

    // Open in a new tab if "New tabs" is Firefox Home, else a new window.
    const dispatchForHomeLink = ({ homepageNewTabs }) =>
      homepageNewTabs.value === "home" ? "tab" : "window";

    Preferences.addSetting({
      id: "firefoxHomeDisabledNotice",
      deps: firefoxHomeDeps,
      visible: deps => !firefoxHomeActive(deps),
    });

    // @nova-cleanup(remove-conditional): Remove this lookup and inline `true` at every novaEnabled check below.
    const novaEnabled = Services.prefs.getBoolPref(
      "browser.newtabpage.activity-stream.nova.enabled",
      false
    );

    // hideLogo only affects rendering when Nova is enabled (see Base.jsx),
    // so the toggle is registered only in that branch.
    if (novaEnabled) {
      Preferences.addSetting({
        id: "firefoxLogo",
        pref: "browser.newtabpage.activity-stream.hideLogo",
        deps: firefoxHomeDeps,
        disabled: deps => !firefoxHomeActive(deps),
      });
    }

    // Search
    Preferences.addSetting({
      id: "webSearch",
      pref: "browser.newtabpage.activity-stream.showSearch",
      deps: firefoxHomeDeps,
      disabled: deps => !firefoxHomeActive(deps),
    });

    // Weather
    // @nova-cleanup(remove-conditional): Remove novaEnabled check and else branch; keep only the Nova registration block (weatherEnabled + weather addSetting calls)
    if (novaEnabled) {
      Preferences.addSetting({
        id: "weatherEnabled",
        pref: "browser.newtabpage.activity-stream.widgets.system.weather.enabled",
      });

      Preferences.addSetting({
        id: "weather",
        pref: "browser.newtabpage.activity-stream.widgets.weather.enabled",
        deps: ["weatherEnabled", ...firefoxHomeDeps],
        visible: widgetToggleVisible("weather"),
        disabled: deps => !firefoxHomeActive(deps),
      });
    } else {
      Preferences.addSetting({
        id: "showWeather",
        pref: "browser.newtabpage.activity-stream.system.showWeather",
      });

      Preferences.addSetting({
        id: "weather",
        pref: "browser.newtabpage.activity-stream.showWeather",
        deps: ["showWeather", ...firefoxHomeDeps],
        visible: ({ showWeather }) => showWeather.value,
        disabled: deps => !firefoxHomeActive(deps),
      });
    }

    // Widgets: general
    Preferences.addSetting({
      id: "widgetsEnabled",
      pref: "browser.newtabpage.activity-stream.widgets.system.enabled",
    });

    Preferences.addSetting({
      id: "widgets",
      pref: "browser.newtabpage.activity-stream.widgets.enabled",
      deps: ["widgetsEnabled", ...firefoxHomeDeps],
      visible: ({ widgetsEnabled }) =>
        isWidgetsContainerVisible({
          ...widgetPrefs,
          "widgets.system.enabled": widgetsEnabled.value,
        }),
      disabled: deps => !firefoxHomeActive(deps),
    });

    // Widgets: lists
    Preferences.addSetting({
      id: "listsEnabled",
      pref: "browser.newtabpage.activity-stream.widgets.system.lists.enabled",
    });

    Preferences.addSetting({
      id: "lists",
      pref: "browser.newtabpage.activity-stream.widgets.lists.enabled",
      deps: ["listsEnabled"],
      visible: widgetToggleVisible("lists"),
    });

    // Widgets: timer
    Preferences.addSetting({
      id: "timerEnabled",
      pref: "browser.newtabpage.activity-stream.widgets.system.focusTimer.enabled",
    });

    Preferences.addSetting({
      id: "timer",
      pref: "browser.newtabpage.activity-stream.widgets.focusTimer.enabled",
      deps: ["timerEnabled"],
      visible: widgetToggleVisible("focusTimer"),
    });

    // Widgets: sports
    Preferences.addSetting({
      id: "sportsWidgetEnabled",
      pref: "browser.newtabpage.activity-stream.widgets.system.sportsWidget.enabled",
    });

    Preferences.addSetting({
      id: "sportsWidget",
      pref: "browser.newtabpage.activity-stream.widgets.sportsWidget.enabled",
      deps: ["sportsWidgetEnabled"],
      visible: widgetToggleVisible("sportsWidget"),
    });

    Preferences.addSetting({
      id: "clocksEnabled",
      pref: "browser.newtabpage.activity-stream.widgets.system.clocks.enabled",
    });

    Preferences.addSetting({
      id: "clocks",
      pref: "browser.newtabpage.activity-stream.widgets.clocks.enabled",
      deps: ["clocksEnabled"],
      visible: widgetToggleVisible("clocks"),
    });

    // Shortcuts
    Preferences.addSetting({
      id: "shortcuts",
      pref: "browser.newtabpage.activity-stream.feeds.topsites",
      deps: firefoxHomeDeps,
      disabled: deps => !firefoxHomeActive(deps),
    });
    Preferences.addSetting({
      id: "shortcutsRows",
      pref: "browser.newtabpage.activity-stream.topSitesRows",
    });

    // Dependency prefs for stories & sponsored stories visibility
    Preferences.addSetting({
      id: "systemTopstories",
      pref: "browser.newtabpage.activity-stream.feeds.system.topstories",
    });

    // Stories
    Preferences.addSetting({
      id: "stories",
      pref: "browser.newtabpage.activity-stream.feeds.section.topstories",
      deps: ["systemTopstories", ...firefoxHomeDeps],
      visible: ({ systemTopstories }) => systemTopstories.value,
      disabled: deps => !firefoxHomeActive(deps),
    });

    // Dependencies for "manage topics" checkbox
    Preferences.addSetting({
      id: "sectionsEnabled",
      pref: "browser.newtabpage.activity-stream.discoverystream.sections.enabled",
    });
    Preferences.addSetting({
      id: "topicLabelsEnabled",
      pref: "browser.newtabpage.activity-stream.discoverystream.topicLabels.enabled",
    });
    Preferences.addSetting({
      id: "sectionsPersonalizationEnabled",
      pref: "browser.newtabpage.activity-stream.discoverystream.sections.personalization.enabled",
    });
    Preferences.addSetting({
      id: "sectionsCustomizeMenuPanelEnabled",
      pref: "browser.newtabpage.activity-stream.discoverystream.sections.customizeMenuPanel.enabled",
    });

    Preferences.addSetting({
      id: "manageTopics",
      deps: [
        "sectionsEnabled",
        "sectionsPersonalizationEnabled",
        "sectionsCustomizeMenuPanelEnabled",
        "stories",
        ...firefoxHomeDeps,
      ],
      visible: deps => {
        const {
          sectionsEnabled,
          sectionsPersonalizationEnabled,
          sectionsCustomizeMenuPanelEnabled,
          stories,
        } = deps;
        return (
          firefoxHomeActive(deps) &&
          sectionsEnabled.value &&
          sectionsPersonalizationEnabled.value &&
          sectionsCustomizeMenuPanelEnabled.value &&
          stories.value
        );
      },
      onUserClick: (e, deps) => {
        e.preventDefault();
        window.openTrustedLinkIn(
          HOME_CUSTOMIZE_TOPICS_URL,
          dispatchForHomeLink(deps)
        );
      },
    });

    // Support Firefox: sponsored content
    Preferences.addSetting({
      id: "supportFirefox",
      pref: "browser.newtabpage.activity-stream.showSponsoredCheckboxes",
      deps: ["sponsoredShortcuts", "sponsoredStories", ...firefoxHomeDeps],
      disabled: deps => !firefoxHomeActive(deps),
      onUserChange(value, { sponsoredShortcuts, sponsoredStories }) {
        // When supportFirefox changes, automatically update child preferences to match
        sponsoredShortcuts.value = !!value;
        sponsoredStories.value = !!value;
      },
    });
    Preferences.addSetting({
      id: "topsitesEnabled",
      pref: "browser.newtabpage.activity-stream.feeds.topsites",
    });
    Preferences.addSetting({
      id: "sponsoredShortcuts",
      pref: "browser.newtabpage.activity-stream.showSponsoredTopSites",
      deps: ["topsitesEnabled"],
      disabled: ({ topsitesEnabled }) => !topsitesEnabled.value,
    });
    Preferences.addSetting({
      id: "sponsoredStories",
      pref: "browser.newtabpage.activity-stream.showSponsored",
      deps: ["systemTopstories", "stories"],
      visible: ({ systemTopstories }) => !!systemTopstories.value,
      disabled: ({ stories }) => !stories.value,
    });
    // Not disabled when Firefox Home is off — the promo remains visible
    // regardless of the homepage setting.
    Preferences.addSetting({
      id: "supportFirefoxPromo",
      deps: ["supportFirefox"],
    });

    // Recent activity
    Preferences.addSetting({
      id: "recentActivity",
      pref: "browser.newtabpage.activity-stream.feeds.section.highlights",
      deps: firefoxHomeDeps,
      disabled: deps => !firefoxHomeActive(deps),
    });
    Preferences.addSetting({
      id: "recentActivityRows",
      pref: "browser.newtabpage.activity-stream.section.highlights.rows",
    });
    Preferences.addSetting({
      id: "recentActivityVisited",
      pref: "browser.newtabpage.activity-stream.section.highlights.includeVisited",
    });
    Preferences.addSetting({
      id: "recentActivityBookmarks",
      pref: "browser.newtabpage.activity-stream.section.highlights.includeBookmarks",
    });
    Preferences.addSetting({
      id: "recentActivityDownloads",
      pref: "browser.newtabpage.activity-stream.section.highlights.includeDownloads",
    });

    // Hidden when Firefox Home is off — the wallpaper page only applies when
    // Firefox Home is the active destination for new windows or new tabs.
    Preferences.addSetting({
      id: "chooseWallpaper",
      deps: firefoxHomeDeps,
      visible: deps => firefoxHomeActive(deps),
      onUserClick: (e, deps) => {
        e.preventDefault();
        window.openTrustedLinkIn(HOME_CUSTOMIZE_URL, dispatchForHomeLink(deps));
      },
    });

    // Base shape used when Weather is nested inside the Widgets group, where it
    // matches its sibling widget checkboxes (no explicit control). The
    // standalone row below adds control: "moz-toggle" to render as a top-level
    // toggle like the other Firefox Home rows.
    const weatherItem = {
      id: "weather",
      subcategory: "weather",
      l10nId: "home-prefs-weather-header-srd",
    };

    return {
      inProgress: true,
      headingLevel: 2,
      l10nId: "home-prefs-content-header",
      iconSrc: "chrome://browser/skin/home.svg",
      subcategory: "contents",
      items: [
        {
          id: "firefoxHomeDisabledNotice",
          control: "moz-message-bar",
          l10nId: "home-prefs-firefox-home-disabled-notice",
          controlAttrs: {
            type: "info",
          },
        },
        {
          id: "webSearch",
          subcategory: "web-search",
          l10nId: "home-prefs-search-header2",
          control: "moz-toggle",
        },
        // Weather nests inside the Widgets group only when that group is shown
        // (Nova + the resolved widgets container gate, the same gate the group's
        // visibility uses). When the container is off but weather is
        // independently enabled (the current default), keep Weather as its own
        // row so it stays reachable.
        ...(novaEnabled && widgetsSystemEnabled
          ? []
          : [{ ...weatherItem, control: "moz-toggle" }]),
        {
          id: "widgets",
          l10nId: "home-prefs-widgets-header",
          control: "moz-toggle",
          // Bug 2046503: this hardcoded widget list should be generated
          // dynamically from WIDGET_REGISTRY (WidgetsRegistry.mjs) so new
          // widgets appear here automatically.
          items: [
            {
              id: "lists",
              l10nId: "home-prefs-lists-header",
            },
            {
              id: "timer",
              l10nId: "home-prefs-timer-header",
            },
            {
              id: "sportsWidget",
              l10nId: "home-prefs-sports-widget-header",
            },
            {
              id: "clocks",
              l10nId: "home-prefs-clocks-header",
            },
            ...(novaEnabled && widgetsSystemEnabled ? [weatherItem] : []),
          ],
        },
        {
          id: "shortcuts",
          subcategory: "topsites",
          l10nId: "home-prefs-shortcuts-header-srd",
          control: "moz-toggle",
          items: [
            {
              id: "shortcutsRows",
              l10nId: "home-prefs-shortcuts-select",
              control: "moz-select",
              options: [
                {
                  value: 1,
                  l10nId: "home-prefs-sections-rows-option-srd",
                  l10nArgs: { num: 1 },
                },
                {
                  value: 2,
                  l10nId: "home-prefs-sections-rows-option-srd",
                  l10nArgs: { num: 2 },
                },
                {
                  value: 3,
                  l10nId: "home-prefs-sections-rows-option-srd",
                  l10nArgs: { num: 3 },
                },
                {
                  value: 4,
                  l10nId: "home-prefs-sections-rows-option-srd",
                  l10nArgs: { num: 4 },
                },
              ],
            },
          ],
        },
        {
          id: "stories",
          subcategory: "topstories",
          l10nId: "home-prefs-stories-header2",
          control: "moz-toggle",
          items: [
            {
              id: "manageTopics",
              l10nId: "home-prefs-manage-topics-link2",
              control: "moz-box-link",
              controlAttrs: {
                href: HOME_CUSTOMIZE_TOPICS_URL,
              },
            },
          ],
        },
        {
          id: "supportFirefox",
          subcategory: "support-firefox",
          l10nId: "home-prefs-support-firefox-header-srd",
          control: "moz-toggle",
          items: [
            {
              id: "sponsoredShortcuts",
              l10nId: "home-prefs-shortcuts-by-option-sponsored-srd",
            },
            {
              id: "sponsoredStories",
              l10nId: "home-prefs-recommended-by-option-sponsored-stories-srd",
            },
            {
              id: "supportFirefoxPromo",
              l10nId: "home-prefs-mission-message2",
              control: "moz-promo",
              options: [
                {
                  control: "a",
                  l10nId: "home-prefs-mission-message-learn-more-link-srd",
                  slot: "support-link",
                  controlAttrs: {
                    is: "moz-support-link",
                    "support-page": "sponsor-privacy",
                    "utm-content": "inproduct",
                  },
                },
              ],
            },
          ],
        },
        {
          id: "recentActivity",
          subcategory: "highlights",
          l10nId: "home-prefs-recent-activity-header-srd",
          control: "moz-toggle",
          items: [
            {
              id: "recentActivityRows",
              l10nId: "home-prefs-recent-activity-select",
              control: "moz-select",
              options: [
                {
                  value: 1,
                  l10nId: "home-prefs-sections-rows-option-srd",
                  l10nArgs: { num: 1 },
                },
                {
                  value: 2,
                  l10nId: "home-prefs-sections-rows-option-srd",
                  l10nArgs: { num: 2 },
                },
                {
                  value: 3,
                  l10nId: "home-prefs-sections-rows-option-srd",
                  l10nArgs: { num: 3 },
                },
                {
                  value: 4,
                  l10nId: "home-prefs-sections-rows-option-srd",
                  l10nArgs: { num: 4 },
                },
              ],
            },
            {
              id: "recentActivityVisited",
              l10nId: "home-prefs-highlights-option-visited-pages-srd",
            },
            {
              id: "recentActivityBookmarks",
              l10nId: "home-prefs-highlights-options-bookmarks-srd",
            },
            {
              id: "recentActivityDownloads",
              l10nId: "home-prefs-highlights-option-most-recent-download-srd",
            },
          ],
        },
        {
          id: "chooseWallpaper",
          l10nId: "home-prefs-choose-wallpaper-link2",
          control: "moz-box-link",
          controlAttrs: {
            href: HOME_CUSTOMIZE_URL,
          },
          iconSrc: "chrome://browser/skin/customize.svg",
        },
        ...(novaEnabled
          ? [
              {
                id: "firefoxLogo",
                l10nId: "home-prefs-firefox-logo-header",
                control: "moz-toggle",
              },
            ]
          : []),
      ],
    };
  }

  /**
   * Render a single preference with all the details, e.g. description, links,
   * more granular preferences.
   *
   * @param sectionData
   * @param document
   * @param Preferences
   */

  /**
   * We can remove this eslint exception once the Settings redesign is complete.
   * In fact, we can probably remove this entire method. When removing, also
   * drop the `pref:` blocks on the `highlights` and `topstories` sections in
   * SectionsManager.sys.mjs — they exist only to feed this renderer.
   */
  // eslint-disable-next-line max-statements
  renderPreferenceSection(sectionData, document, Preferences) {
    /* Do not render old-style settings if new settings UI is enabled - this is needed to avoid
     * registering prefs twice and ensuing errors */
    if (Services.prefs.getBoolPref("browser.settings-redesign.enabled")) {
      return;
    }

    const {
      id,
      pref: prefData,
      maxRows,
      rowsPref,
      shouldHidePref,
      eventSource,
    } = sectionData;
    const {
      feed: name,
      titleString = {},
      descString,
      nestedPrefs = [],
    } = prefData || {};

    // Helper to link a UI element to a preference for updating
    const linkPref = (element, prefName, type) => {
      const fullPref = `browser.newtabpage.activity-stream.${prefName}`;
      element.setAttribute("preference", fullPref);
      Preferences.add({ id: fullPref, type });

      // Prevent changing the UI if the preference can't be changed
      element.disabled = Preferences.get(fullPref).locked;
    };

    // Don't show any sections that we don't want to expose in preferences UI
    if (shouldHidePref) {
      return;
    }

    // Add the main preference for turning on/off a section
    const sectionVbox = document.getElementById(id);
    sectionVbox.setAttribute("data-subcategory", id);
    const checkbox = this.createAppend(document, "checkbox", sectionVbox);
    checkbox.classList.add("section-checkbox");
    // Set up a user event if we have an event source for this pref.
    if (eventSource) {
      this.setupUserEvent(checkbox, eventSource);
    }
    document.l10n.setAttributes(
      checkbox,
      this.getString(titleString),
      titleString.values
    );

    linkPref(checkbox, name, "bool");

    // Specially add a link for Weather
    if (id === "weather") {
      const hboxWithLink = this.createAppend(document, "hbox", sectionVbox);
      hboxWithLink.appendChild(checkbox);
      checkbox.classList.add("tail-with-learn-more");

      const link = this.createAppend(document, "label", hboxWithLink, {
        is: "text-link",
      });
      link.setAttribute("href", sectionData.pref.learnMore.link.href);
      document.l10n.setAttributes(link, sectionData.pref.learnMore.link.id);
    }

    // Add more details for the section (e.g., description, more prefs)
    const detailVbox = this.createAppend(document, "vbox", sectionVbox);
    detailVbox.classList.add("indent");
    if (descString) {
      const description = this.createAppend(
        document,
        "description",
        detailVbox
      );
      description.classList.add("text-deemphasized");
      document.l10n.setAttributes(
        description,
        this.getString(descString),
        descString.values
      );

      // Add a rows dropdown if we have a pref to control and a maximum
      if (rowsPref && maxRows) {
        const detailHbox = this.createAppend(document, "hbox", detailVbox);
        detailHbox.setAttribute("align", "center");
        description.setAttribute("flex", 1);
        detailHbox.appendChild(description);

        // Add box so the search tooltip is positioned correctly
        const tooltipBox = this.createAppend(document, "hbox", detailHbox);

        // Add appropriate number of localized entries to the dropdown
        const menulist = this.createAppend(document, "menulist", tooltipBox);
        menulist.setAttribute("crop", "none");
        const menupopup = this.createAppend(document, "menupopup", menulist);
        for (let num = 1; num <= maxRows; num++) {
          const item = this.createAppend(document, "menuitem", menupopup);
          document.l10n.setAttributes(item, "home-prefs-sections-rows-option", {
            num,
          });
          item.setAttribute("value", num);
        }
        linkPref(menulist, rowsPref, "int");
      }
    }

    const subChecks = [];
    const fullName = `browser.newtabpage.activity-stream.${sectionData.pref.feed}`;
    const pref = Preferences.get(fullName);

    // Add a checkbox pref for any nested preferences
    nestedPrefs.forEach(nested => {
      if (nested.shouldHidePref !== true) {
        const subcheck = this.createAppend(document, "checkbox", detailVbox);
        // Set up a user event if we have an event source for this pref.
        if (nested.eventSource) {
          this.setupUserEvent(subcheck, nested.eventSource);
        }
        document.l10n.setAttributes(subcheck, nested.titleString);

        linkPref(subcheck, nested.name, "bool");

        subChecks.push(subcheck);
        subcheck.disabled = !pref._value;
        if (nested.shouldDisablePref) {
          subcheck.disabled = nested.shouldDisablePref;
        }
        subcheck.hidden = nested.hidden;
      }
    });

    // Special cases to like the nested prefs with another pref,
    // so we can disable it real time.
    if (id === "support-firefox") {
      function setupSupportFirefoxSubCheck(triggerPref, subPref) {
        const subCheckFullName = `browser.newtabpage.activity-stream.${triggerPref}`;
        const subCheckPref = Preferences.get(subCheckFullName);

        subCheckPref?.on("change", () => {
          const showSponsoredFullName = `browser.newtabpage.activity-stream.${subPref}`;
          const showSponsoredSubcheck = subChecks.find(
            subcheck =>
              subcheck.getAttribute("preference") === showSponsoredFullName
          );
          if (showSponsoredSubcheck) {
            showSponsoredSubcheck.disabled = !Services.prefs.getBoolPref(
              subCheckFullName,
              true
            );
          }
        });
      }

      setupSupportFirefoxSubCheck("feeds.section.topstories", "showSponsored");
      setupSupportFirefoxSubCheck("feeds.topsites", "showSponsoredTopSites");
    }

    pref.on("change", () => {
      subChecks.forEach(subcheck => {
        // Update child preferences for the "Support Firefox" checkbox group
        // so that they're turned on and off at the same time.
        if (id === "support-firefox") {
          const subPref = Preferences.get(subcheck.getAttribute("preference"));
          subPref.value = pref.value;
        }

        // Disable any nested checkboxes if the parent pref is not enabled.
        subcheck.disabled = !pref._value;
      });
    });
  }

  /**
   * Update the visibility of the Restore Defaults button based on checked prefs.
   *
   * @param gHomePane
   */
  toggleRestoreDefaults(gHomePane) {
    gHomePane.toggleRestoreDefaultsBtn();
  }

  /**
   * A helper function to append XUL elements on the page.
   *
   * @param document
   * @param tag
   * @param parent
   * @param options
   */
  createAppend(document, tag, parent, options = {}) {
    return parent.appendChild(document.createXULElement(tag, options));
  }

  /**
   * Helper to get fluentIDs sometimes encase in an object
   *
   * @param message
   * @returns string
   */
  getString(message) {
    return typeof message !== "object" ? message : message.id;
  }
}
