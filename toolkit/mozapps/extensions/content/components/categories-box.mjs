/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  html,
  repeat,
  nothing,
} from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";
// eslint-disable-next-line import/no-unassigned-import
import "chrome://global/content/elements/moz-page-nav.mjs";
import {
  AddonManagerListenerHandler,
  getUpdateInstall,
  isDiscoverEnabled,
  isManualUpdate,
  openAboutSettingsInTab,
  PREF_UI_LASTCATEGORY,
} from "../aboutaddons-utils.mjs";
import { gViewController } from "../view-controller.mjs";

const { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
const { AppConstants } = ChromeUtils.importESModule(
  "resource://gre/modules/AppConstants.sys.mjs"
);

// NOTE: The titleL10nId is making sure the sidebar entries are labelled
// when the sidebar is in collapsed mode and their slotted elements
// or text nodes are hidden.
//
// Each of the titleL10nId points to a fluent string that reference the
// l10nId, and so they points to the same localized strings.
const CATEGORIES = [
  {
    name: "discover",
    viewId: "addons://discover/",
    iconSrc: "chrome://global/skin/icons/trophy.svg",
    l10nId: "addon-category-discover",

    titleL10nId: "addon-category-discover-title",
    defaultHidden: true,
  },
  {
    name: "extension",
    viewId: "addons://list/extension",
    iconSrc: "chrome://mozapps/skin/extensions/category-extensions.svg",
    l10nId: "addon-category-extension",
    titleL10nId: "addon-category-extension-title",
    defaultHidden: false,
  },
  {
    name: "theme",
    viewId: "addons://list/theme",
    iconSrc: "chrome://mozapps/skin/extensions/category-themes.svg",
    l10nId: "addon-category-theme",
    titleL10nId: "addon-category-theme-title",
    defaultHidden: false,
  },
  {
    name: "plugin",
    viewId: "addons://list/plugin",
    iconSrc: "chrome://mozapps/skin/extensions/category-plugins.svg",
    l10nId: "addon-category-plugin",
    titleL10nId: "addon-category-plugin-title",
    defaultHidden: false,
  },
  {
    name: "dictionary",
    viewId: "addons://list/dictionary",
    iconSrc: "chrome://mozapps/skin/extensions/category-dictionaries.svg",
    l10nId: "addon-category-dictionary",
    titleL10nId: "addon-category-dictionary-title",
    defaultHidden: true,
  },
  {
    name: "locale",
    viewId: "addons://list/locale",
    iconSrc: "chrome://mozapps/skin/extensions/category-languages.svg",
    l10nId: "addon-category-locale",
    titleL10nId: "addon-category-locale-title",
    defaultHidden: true,
  },
  {
    name: "sitepermission",
    viewId: "addons://list/sitepermission",
    iconSrc: "chrome://mozapps/skin/extensions/category-sitepermission.svg",
    l10nId: "addon-category-sitepermission",
    titleL10nId: "addon-category-sitepermission-title",
    defaultHidden: true,
  },
  {
    name: "mlmodel",
    viewId: "addons://list/mlmodel",
    iconSrc: "chrome://global/skin/icons/highlights.svg",
    l10nId: "addon-category-mlmodel",
    titleL10nId: "addon-category-mlmodel-title",
    defaultHidden: true,
  },
  {
    name: "available-updates",
    viewId: "addons://updates/available",
    iconSrc: "chrome://mozapps/skin/extensions/category-available.svg",
    l10nId: "addon-category-available-updates",
    titleL10nId: "addon-category-available-updates-title",
    defaultHidden: true,
  },
  {
    name: "recent-updates",
    viewId: "addons://updates/recent",
    iconSrc: "chrome://mozapps/skin/extensions/category-recent.svg",
    l10nId: "addon-category-recent-updates",
    titleL10nId: "addon-category-recent-updates-title",
    // AddonManager.hasAddonType returns false for this, so #updateHiddenCategories
    // never processes it. It is unhidden only via about:addons page gear-menu
    // "View Recent Updates" action or pref-restored last view).
    defaultHidden: true,
  },
];

const VIEW_ID_TO_NAME = new Map(CATEGORIES.map(c => [c.viewId, c.name]));
const NAME_TO_VIEW_ID = new Map(CATEGORIES.map(c => [c.name, c.viewId]));

class CategoriesBox extends MozLitElement {
  static properties = {
    _availableUpdatesCount: { state: true },
    _currentView: { state: true },
    _hiddenCategories: { state: true },
  };

  createRenderRoot() {
    return this;
  }

  constructor() {
    super();
    this._hiddenCategories = this.#recomputeInitialHiddenCategories();
    this._availableUpdatesCount = 0;
    // This will resolve when the initial category states have been set from
    // our cached prefs. This is intended for use in testing to verify that we
    // are caching the previous state.
    this.deferredRendered = Promise.withResolvers();
    // TODO: this is only used in one test, we may just tweak the test
    // (browser_sidebar_hidden_categories.js).
    this.promiseRendered = this.deferredRendered.promise;
  }

  connectedCallback() {
    super.connectedCallback();
    // Listens to gViewController view-selected custom events.
    document.addEventListener("view-selected", this);
    AddonManagerListenerHandler.addListener(this);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener("view-selected", this);
    AddonManagerListenerHandler.removeListener(this);
  }

  /**
   * Initialize sidebar by recomputing the hidden category and the available updates counter,
   * called from aboutaddons.mjs initialize helper function as part of the about:addons page
   * initialization.
   *
   * @returns {Promise<void>} A promise resolved after the hidden categories have
   *                          been recomputed and the sidebar rendered.
   */
  async initialize() {
    this._hiddenCategories = this.#recomputeInitialHiddenCategories();
    let waitForHiddenUpdated = this.#asyncHiddenCategoriesUpdate();
    this.#updateAvailableCount();
    await this.updateComplete;
    this.deferredRendered.resolve();
    await waitForHiddenUpdated;
  }

  selectType(type) {
    // NOTE: this is currently called by aboutaddons.mjs
    // gViewController.defineView callbacks.
    this.#selectByViewId(`addons://list/${type}`);
  }

  get currentViewId() {
    // NOTE: used by testing helpers.
    return NAME_TO_VIEW_ID.get(this._currentView);
  }

  handleEvent(e) {
    // Handle view-selected custom events dispatched
    // from gViewController.
    if (e.type === "view-selected") {
      const { type, param } = e.detail;
      const viewId = `addons://${type}/${param}`;
      this.#selectByViewId(viewId);
    }
  }

  // AddonManagerListenerHandler methods.

  onNewInstall() {
    this.#updateAvailableCount();
  }

  onInstallPostponed() {
    this.#updateAvailableCount();
  }

  onInstallCancelled() {
    this.#updateAvailableCount();
  }

  onInstallStarted(install) {
    this.onInstalled(install);
  }

  onInstalled(addon) {
    const name = addon.type;
    if (CATEGORIES.some(c => c.name === name)) {
      const hidden = new Set(this._hiddenCategories);
      hidden.delete(name);
      this._hiddenCategories = hidden;
      this.#setShouldHideCategory(name, false);
    }
    this.#updateAvailableCount();
  }

  // LitElement rendering methods.

  render() {
    // NOTE: the following are the motivations for the properties
    // and attributes set on the moz-page-nav element:
    // - allownoselection="true" + currentView set to a non existing "loading"
    //   view are set to allow the moz-page-nav to not have any
    //   moz-page-nav-button implicitly selected right after rendered.
    // - .hasSecondaryNav is set upfront to avoid a slight flickering
    //   effect when the about:addons page is reloaded (due to the <hr/>
    //   separator being rendered async when a slot="secondary-nav" child
    //   is detected).
    return html`
      <moz-page-nav
        data-l10n-id="aboutaddons-sidebar"
        allownoselection="true"
        currentView=${this._currentView ?? "loading"}
        .hasSecondaryNav=${true}
        @change-view=${this.#handleChangeView}
      >
        ${repeat(
          CATEGORIES,
          category => category.name,
          category => this.#categoryButtonTemplate(category)
        )}
        <moz-page-nav-button
          slot="secondary-nav"
          id="preferencesButton"
          href="about:preferences"
          iconsrc="chrome://global/skin/icons/settings.svg"
          data-l10n-id="sidebar-settings-button-title"
          @click=${this.#handlePreferencesButton}
        >
          <span data-l10n-id="addons-settings-button"></span>
        </moz-page-nav-button>
        <moz-page-nav-button
          slot="secondary-nav"
          support-page="addons-help"
          iconsrc="chrome://global/skin/icons/help.svg"
          data-l10n-id="sidebar-help-button-title"
        >
          <span data-l10n-id="help-button"></span>
        </moz-page-nav-button>
      </moz-page-nav>
    `;
  }

  // Private methods.

  #isBadgedCategory(category) {
    return (
      category.name === "available-updates" && this._availableUpdatesCount > 0
    );
  }

  #categoryButtonBadgeTemplate(category) {
    if (!this.#isBadgedCategory(category)) {
      return nothing;
    }
    const badgeCount = this._availableUpdatesCount;
    return html`<span class="category-badge">${badgeCount}</span>`;
  }

  #categoryButtonTemplate(category) {
    return html`<moz-page-nav-button
      id="category-${category.name}"
      view=${category.name}
      ?hidden=${this._hiddenCategories.has(category.name)}
      ?badged-category=${this.#isBadgedCategory(category)}
      iconsrc=${category.iconSrc}
      @keydown=${this.#handleButtonKeyDown}
      data-l10n-id=${category.titleL10nId}
    >
      <span data-l10n-id=${category.l10nId}></span>
      ${this.#categoryButtonBadgeTemplate(category)}
    </moz-page-nav-button>`;
  }

  async #updateAvailableCount() {
    // Note: This list includes new installs and updates, potentially multiple
    // for the same add-on (because they are not cleaned up - bug 2007749).
    let installs = await AddonManager.getAllInstalls();
    let addonIdsWithUpdate = new Set();
    for (const install of installs) {
      if (isManualUpdate(install) && install.existingAddon) {
        const addon = await AddonManager.getAddonByID(install.existingAddon.id);
        if (
          addon &&
          getUpdateInstall(addon) === install &&
          Services.vc.compare(install.version, addon.version) > 0
        ) {
          addonIdsWithUpdate.add(addon.id);
        }
      }
    }
    const count = addonIdsWithUpdate.size;
    const hidden = new Set(this._hiddenCategories);
    if (count === 0 && this._currentView !== "available-updates") {
      hidden.add("available-updates");
    } else {
      hidden.delete("available-updates");
    }
    this._hiddenCategories = hidden;
    this._availableUpdatesCount = count;
  }

  #selectByViewId(viewId) {
    const name = VIEW_ID_TO_NAME.get(viewId);
    if (name) {
      const hidden = new Set(this._hiddenCategories);
      hidden.delete(name);
      this._hiddenCategories = hidden;
      this._currentView = name;
      // TODO: should this be actually a gViewController responsibility?
      Services.prefs.setStringPref(PREF_UI_LASTCATEGORY, viewId);
    }
  }

  #handleButtonKeyDown(e) {
    // NOTE: On Linux browser_history_navigation.js seems to be hitting a failure
    // due to moz-page-nav's internal keydown handler intercepts all arrow keys
    // regardless of modifiers. As a short term workaround this helper is stopping
    // propagation here for modified arrow keys to prevent moz-page-nav from
    // calling preventDefault() on browser shortcuts like Alt+ArrowLeft (history back).
    //
    // TODO(Bug 2037409): Remove this workaround if the issue being hit can be
    // fixed on the moz-page-nav side.
    //
    // TODO: The goBackKb / goForwardKb XUL key elements are technically customizable
    // from about:keyboard, and so in the long run it would be better to not be
    // hardcoding the keyboard shortcuts we are assuming the back/forward history
    // system actions are actually hooked to.
    const hasExpectedModifier =
      AppConstants.platform === "macosx" ? e.metaKey : e.altKey;
    if (
      hasExpectedModifier &&
      [e.DOM_VK_LEFT, e.DOM_VK_RIGHT].includes(e.keyCode)
    ) {
      e.stopPropagation();
    }
  }

  #handleChangeView(e) {
    const viewId = NAME_TO_VIEW_ID.get(e.target.view);
    if (viewId) {
      gViewController.loadView(viewId);
    }
  }

  #handlePreferencesButton(e) {
    // NOTE: When the preferences button is clicked, it is currently
    // expected that we would switch to an existing about:settings or
    // an about:preferences tab (and browser_sidebar_preferences_button.js
    // covers this behavior explicitly).
    //
    // If openAboutSettingsInTab returns false then it means that
    // a switchToTabHavingURI helper function was not found and we leave
    // the Firefox Settings page to be opened using the logic provided
    // by default by the moz-page-nav component instead.
    if (openAboutSettingsInTab()) {
      e.preventDefault();
    }
  }

  #shouldHideCategory(name) {
    return Services.prefs.getBoolPref(`extensions.ui.${name}.hidden`, true);
  }

  #setShouldHideCategory(name, hide) {
    Services.prefs.setBoolPref(`extensions.ui.${name}.hidden`, hide);
  }

  #isCategoryVisible(category) {
    const { defaultHidden, name } = category;
    if (name === "discover") {
      return isDiscoverEnabled();
    }
    if (!defaultHidden) {
      return true;
    }
    return AddonManager.hasAddonType(name) && !this.#shouldHideCategory(name);
  }

  #recomputeInitialHiddenCategories() {
    return new Set(
      CATEGORIES.filter(category => !this.#isCategoryVisible(category)).map(
        category => category.name
      )
    );
  }

  async #asyncHiddenCategoriesUpdate() {
    const defaultHiddenAddonTypes = CATEGORIES.filter(
      category =>
        category.defaultHidden && AddonManager.hasAddonType(category.name)
    ).map(category => category.name);

    if (!defaultHiddenAddonTypes.length) {
      return;
    }

    const hiddenTypes = new Set(defaultHiddenAddonTypes);
    const getAddons = AddonManager.getAddonsByTypes(defaultHiddenAddonTypes);
    const getInstalls = AddonManager.getInstallsByTypes(
      defaultHiddenAddonTypes
    );

    const promiseAddonsProcessed = getAddons.then(addons =>
      addons.forEach(addon => {
        if (!addon.hidden) {
          this.onInstalled(addon);
          hiddenTypes.delete(addon.type);
        }
      })
    );

    const promiseInstallsProcessed = getInstalls.then(installs =>
      installs.forEach(install => {
        if (
          !install.existingAddon &&
          install.state !== AddonManager.STATE_AVAILABLE
        ) {
          this.onInstalled(install);
          hiddenTypes.delete(install.type);
        }
      })
    );

    await Promise.all([promiseAddonsProcessed, promiseInstallsProcessed]);

    this._hiddenCategories = this._hiddenCategories.union(hiddenTypes);

    for (const type of hiddenTypes) {
      if (this._currentView === type) {
        gViewController.resetState();
      }
      this.#setShouldHideCategory(type, true);
    }
  }
}
customElements.define("categories-box", CategoriesBox);
