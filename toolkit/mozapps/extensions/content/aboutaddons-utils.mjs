/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { gViewController } from "./view-controller.mjs";

const { AddonManager } = ChromeUtils.importESModule(
  "resource://gre/modules/AddonManager.sys.mjs"
);
const { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
const { AddonSettings } = ChromeUtils.importESModule(
  "resource://gre/modules/addons/AddonSettings.sys.mjs"
);

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AddonRepository: "resource://gre/modules/addons/AddonRepository.sys.mjs",
  AbuseReporter: "resource://gre/modules/AbuseReporter.sys.mjs",
  AppConstants: "resource://gre/modules/AppConstants.sys.mjs",
  // eslint-disable-next-line mozilla/no-browser-refs-in-toolkit
  BuiltInThemes: "resource:///modules/BuiltInThemes.sys.mjs",
  ClientID: "resource://gre/modules/ClientID.sys.mjs",
  Extension: "resource://gre/modules/Extension.sys.mjs",
  ExtensionPermissions: "resource://gre/modules/ExtensionPermissions.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
});

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "ABUSE_REPORT_ENABLED",
  "extensions.abuseReport.enabled",
  false
);
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "XPINSTALL_ENABLED",
  "xpinstall.enabled",
  true
);
// When this pref is set and the add-on is already installed, we use the
// "update" flow instead of the "install" (over) flow in `about:addons`.
XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "PREFER_UPDATE_OVER_INSTALL_FOR_EXISTING_ADDON",
  "extensions.webextensions.prefer-update-over-install-for-existing-addon",
  false
);

export const UPDATES_RECENT_TIMESPAN = 2 * 24 * 3600000; // 2 days (in milliseconds)

export const HTML_NS = "http://www.w3.org/1999/xhtml";

export const PERMISSION_MASKS = {
  enable: AddonManager.PERM_CAN_ENABLE,
  "always-activate": AddonManager.PERM_CAN_ENABLE,
  disable: AddonManager.PERM_CAN_DISABLE,
  "never-activate": AddonManager.PERM_CAN_DISABLE,
  uninstall: AddonManager.PERM_CAN_UNINSTALL,
  upgrade: AddonManager.PERM_CAN_UPGRADE,
  "change-privatebrowsing": AddonManager.PERM_CAN_CHANGE_PRIVATEBROWSING_ACCESS,
};

export const PREF_DISCOVER_ENABLED = "extensions.getAddons.showPane";
export const PREF_UI_LASTCATEGORY = "extensions.ui.lastCategory";
export const PREF_DISCOVERY_API_URL = "extensions.getAddons.discovery.api_url";
export const PREF_RECOMMENDATION_ENABLED = "browser.discovery.enabled";
export const PREF_TELEMETRY_ENABLED =
  "datareporting.healthreport.uploadEnabled";
export const PRIVATE_BROWSING_PERM_NAME = "internal:privateBrowsingAllowed";

export const INLINE_OPTIONS_ENABLED = Services.prefs.getBoolPref(
  "extensions.htmlaboutaddons.inline-options.enabled"
);
export const OPTIONS_TYPE_MAP = {
  [AddonManager.OPTIONS_TYPE_DIALOG]: "dialog",
  [AddonManager.OPTIONS_TYPE_TAB]: "tab",
  [AddonManager.OPTIONS_TYPE_INLINE_BROWSER]: INLINE_OPTIONS_ENABLED
    ? "inline"
    : "tab",
};

export function isDiscoverEnabled() {
  try {
    if (!Services.prefs.getBoolPref(PREF_DISCOVER_ENABLED)) {
      return false;
    }
  } catch (e) {}

  if (!lazy.XPINSTALL_ENABLED) {
    return false;
  }

  return true;
}

export function getBrowserElement() {
  return window.docShell.chromeEventHandler;
}

export function promiseEvent(event, target, capture = false) {
  return new Promise(resolve => {
    target.addEventListener(event, resolve, { capture, once: true });
  });
}

// This is similar to `AddonManagerInternal.updatePromptHandler()` except it
// notifies "webextension-permission-prompt" because we want to show the
// permissions prompt directly. The `updatePromptHandler()` will notify a
// different topic and the outcome will be a notification created on the app
// menu button.
//
// TODO: Bug 1974732 - Refactor install prompt handler used in `about:addons`
// to use the logic in the `AddonManager`.
function installPromptHandler(info) {
  const install = this;

  let oldPerms = info.existingAddon.userPermissions;
  if (!oldPerms) {
    // Updating from a legacy add-on, let it proceed
    return Promise.resolve();
  }

  if (Services.policies?.isAddonRequiredByPolicy(info.existingAddon.id)) {
    return Promise.resolve();
  }

  // When an update for an existing add-on includes data collection
  // permissions, which the add-ons didn't have so far, and the manifest
  // contains a flag to indicate that there was a previous consent, then we
  // allow the update to just proceed, unless there are other new required
  // permissions.
  const updateIsMigratingToDataCollectionPerms =
    !info.existingAddon.hasDataCollectionPermissions &&
    info.install.addonHasPreviousConsent;

  let newPerms = info.addon.userPermissions;

  let difference = lazy.Extension.comparePermissions(oldPerms, newPerms);

  // If there are no new permissions, just proceed
  if (
    !difference.origins.length &&
    !difference.permissions.length &&
    (updateIsMigratingToDataCollectionPerms ||
      !difference.data_collection.length)
  ) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let subject = {
      wrappedJSObject: {
        target: getBrowserElement(),
        info: {
          type: "update",
          addon: info.addon,
          icon: info.addon.iconURL,
          // Reference to the related AddonInstall object (used in
          // AMTelemetry to link the recorded event to the other events from
          // the same install flow).
          install,
          permissions: difference,
          resolve,
          reject,
        },
      },
    };
    Services.obs.notifyObservers(subject, "webextension-permission-prompt");
  });
}

export function attachUpdateHandler(install) {
  install.promptHandler = installPromptHandler;
}

export function detachUpdateHandler(install) {
  if (install?.promptHandler === installPromptHandler) {
    install.promptHandler = null;
  }
}

export async function loadReleaseNotes(uri) {
  const res = await fetch(uri.spec, { credentials: "omit" });

  if (!res.ok) {
    throw new Error("Error loading release notes");
  }

  // Load the content.
  const text = await res.text();

  // Setup the content sanitizer.
  const ParserUtils = Cc["@mozilla.org/parserutils;1"].getService(
    Ci.nsIParserUtils
  );
  const flags =
    ParserUtils.SanitizerDropMedia |
    ParserUtils.SanitizerDropNonCSSPresentation |
    ParserUtils.SanitizerDropForms;

  // Sanitize and parse the content to a fragment.
  const context = document.createElementNS(HTML_NS, "div");
  return ParserUtils.parseFragment(text, flags, false, uri, context);
}

export function openOptionsInDialog(addon) {
  let windows = Services.wm.getEnumerator(null);
  while (windows.hasMoreElements()) {
    let win = windows.getNext();
    if (!win.closed && win.document.documentURI == addon.optionsURL) {
      win.focus();
      return;
    }
  }

  let features = "chrome,titlebar,toolbar,centerscreen";
  if (Services.prefs.getBoolPref("browser.preferences.instantApply", false)) {
    features += ",dialog=no";
  } else {
    features += ",modal";
  }
  window.windowRoot.window.openDialog(addon.optionsURL, addon.id, features);
}

export function openOptionsInTab(optionsURL) {
  let mainWindow = window.windowRoot.window;
  if ("switchToTabHavingURI" in mainWindow) {
    mainWindow.switchToTabHavingURI(optionsURL, true, {
      relatedToCurrent: true,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    return true;
  }
  return false;
}

export function openAboutSettingsInTab() {
  let mainWindow = window.windowRoot.window;
  if ("switchToTabHavingURI" in mainWindow) {
    let hasAboutSettings = mainWindow.switchToTabHavingURI(
      "about:settings",
      false,
      {
        ignoreFragment: "whenComparing",
      }
    );
    if (!hasAboutSettings) {
      let systemPrincipal = Services.scriptSecurityManager.getSystemPrincipal();
      mainWindow.switchToTabHavingURI("about:preferences", true, {
        ignoreFragment: "whenComparing",
        triggeringPrincipal: systemPrincipal,
      });
    }
    return true;
  }
  return false;
}

export function shouldShowPermissionsPrompt(addon) {
  if (!addon.isWebExtension || addon.seen) {
    return false;
  }

  let perms = addon.installPermissions;
  return perms?.origins.length || perms?.permissions.length;
}

export function showPermissionsPrompt(addon) {
  return new Promise(resolve => {
    const permissions = addon.installPermissions;
    const target = getBrowserElement();

    const onAddonEnabled = () => {
      // The user has just enabled a sideloaded extension, if the permission
      // can be changed for the extension, show the post-install panel to
      // give the user that opportunity.
      if (
        addon.permissions & AddonManager.PERM_CAN_CHANGE_PRIVATEBROWSING_ACCESS
      ) {
        Services.obs.notifyObservers(
          { addon, target },
          "webextension-install-notify"
        );
      }
      resolve();
    };

    const subject = {
      wrappedJSObject: {
        target,
        info: {
          type: "sideload",
          addon,
          icon: addon.iconURL,
          permissions,
          resolve() {
            addon.markAsSeen();
            addon.enable().then(onAddonEnabled);
          },
          reject() {
            // Ignore a cancelled permission prompt.
          },
        },
      },
    };
    Services.obs.notifyObservers(subject, "webextension-permission-prompt");
  });
}

export function isCorrectlySigned(addon) {
  // Add-ons without an "isCorrectlySigned" property are correctly signed as
  // they aren't the correct type for signing.
  return addon.isCorrectlySigned !== false;
}

export function isUnsignedWarningMessageDisabled() {
  // While running in automation, in a local build or in a Thunderbird
  // application instance, allow to hide the unsigned add-on message bars
  // through the related about:config preference.
  return (
    (Cu.isInAutomation ||
      !lazy.AppConstants.MOZILLA_OFFICIAL ||
      lazy.AppConstants.MOZ_APP_NAME === "thunderbird") &&
    Services.prefs.getBoolPref("extensions.ui.disableUnsignedWarnings", false)
  );
}

export function isDisabledUnsigned(addon) {
  let signingRequired =
    addon.type == "locale"
      ? AddonSettings.LANGPACKS_REQUIRE_SIGNING
      : AddonSettings.REQUIRE_SIGNING;
  return signingRequired && !isCorrectlySigned(addon);
}

export function isPending(addon, action) {
  const amAction = AddonManager["PENDING_" + action.toUpperCase()];
  return !!(addon.pendingOperations & amAction);
}

export async function installAddonsFromFilePicker() {
  let [dialogTitle, filterName] = await document.l10n.formatMessages([
    { id: "addon-install-from-file-dialog-title" },
    { id: "addon-install-from-file-filter-name" },
  ]);
  const nsIFilePicker = Ci.nsIFilePicker;
  var fp = Cc["@mozilla.org/filepicker;1"].createInstance(nsIFilePicker);
  fp.init(
    window.browsingContext,
    dialogTitle.value,
    nsIFilePicker.modeOpenMultiple
  );
  try {
    fp.appendFilter(filterName.value, "*.xpi;*.jar;*.zip");
    fp.appendFilters(nsIFilePicker.filterAll);
  } catch (e) {}

  return new Promise(resolve => {
    fp.open(async result => {
      if (result != nsIFilePicker.returnOK) {
        return;
      }

      let installTelemetryInfo = {
        source: "about:addons",
        method: "install-from-file",
      };

      let browser = getBrowserElement();
      let installs = [];
      for (let file of fp.files) {
        let install = await AddonManager.getInstallForFile(
          file,
          null,
          installTelemetryInfo
        );
        AddonManager.installAddonFromAOMWithOptions(
          browser,
          document.documentURIObject,
          install,
          {
            preferUpdateOverInstall:
              lazy.PREFER_UPDATE_OVER_INSTALL_FOR_EXISTING_ADDON,
          }
        );
        installs.push(install);
      }
      resolve(installs);
    });
  });
}

export function shouldSkipAnimations() {
  return (
    document.body.hasAttribute("skip-animations") ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function callListeners(name, args, listeners) {
  for (let listener of listeners) {
    try {
      if (name in listener) {
        listener[name](...args);
      }
    } catch (e) {
      Cu.reportError(e);
    }
  }
}

export function getUpdateInstall(addon) {
  return (
    // Install object for a pending update.
    addon.updateInstall ||
    // Install object for a postponed upgrade (only for extensions,
    // because is the only addon type that can postpone their own
    // updates).
    (addon.type === "extension" &&
      addon.pendingUpgrade &&
      addon.pendingUpgrade.install)
  );
}

export function isManualUpdate(install) {
  const isExistingHidden = install.existingAddon?.hidden;
  // install.addon can be missing if the install was retrieved from an update
  // check, without having downloaded and parsed the linked xpi yet.
  const isNewHidden = install.addon?.hidden;
  // Not a manual update installation if both the existing and old
  // addon are hidden (which also ensures we are going to hide pending
  // installations for hidden add-ons from both the category button
  // badge counter and from the available updates view when the new
  // addon is also hidden).
  if (isExistingHidden && isNewHidden) {
    return false;
  }
  let isManual =
    install.existingAddon &&
    !AddonManager.shouldAutoUpdate(install.existingAddon);
  let isExtension = install.existingAddon?.type == "extension";
  return (
    (isManual && isInState(install, "available")) ||
    (isExtension && isInState(install, "postponed"))
  );
}

export const AddonManagerListenerHandler = {
  listeners: new Set(),

  addListener(listener) {
    this.listeners.add(listener);
  },

  removeListener(listener) {
    this.listeners.delete(listener);
  },

  delegateEvent(name, args) {
    callListeners(name, args, this.listeners);
  },

  startup() {
    this._listener = new Proxy(
      {},
      {
        has: () => true,
        get:
          (_, name) =>
          (...args) =>
            this.delegateEvent(name, args),
      }
    );
    AddonManager.addAddonListener(this._listener);
    AddonManager.addInstallListener(this._listener);
    AddonManager.addManagerListener(this._listener);
    this._permissionHandler = (type, data) => {
      if (type == "change-permissions") {
        this.delegateEvent("onChangePermissions", [data]);
      }
    };
    lazy.ExtensionPermissions.addListener(this._permissionHandler);
  },

  shutdown() {
    AddonManager.removeAddonListener(this._listener);
    AddonManager.removeInstallListener(this._listener);
    AddonManager.removeManagerListener(this._listener);
    lazy.ExtensionPermissions.removeListener(this._permissionHandler);
  },
};

/**
 * This object wires the AddonManager event listeners into addon-card and
 * addon-details elements rather than needing to add/remove listeners all the
 * time as the view changes.
 */
export const AddonCardListenerHandler = new Proxy(
  {},
  {
    has: () => true,
    get(_, name) {
      return (...args) => {
        let elements = [];
        let addonId;

        // We expect args[0] to be of type:
        // - AddonInstall, on AddonManager install events
        // - AddonWrapper, on AddonManager addon events
        // - undefined, on AddonManager manage events
        if (args[0]) {
          addonId =
            args[0].addon?.id ||
            args[0].existingAddon?.id ||
            args[0].extensionId ||
            args[0].id;
        }

        if (addonId) {
          let cardSelector = `addon-card[addon-id="${addonId}"]`;
          elements = document.querySelectorAll(
            `${cardSelector}, ${cardSelector} addon-details`
          );
        } else if (name == "onUpdateModeChanged") {
          elements = document.querySelectorAll("addon-card");
        }

        callListeners(name, args, elements);
      };
    },
  }
);
AddonManagerListenerHandler.addListener(AddonCardListenerHandler);

export function isAbuseReportSupported(addon) {
  return (
    lazy.ABUSE_REPORT_ENABLED &&
    lazy.AbuseReporter.isSupportedAddonType(addon.type) &&
    !(addon.isBuiltin || addon.isSystem)
  );
}

export async function isAllowedInPrivateBrowsing(addon) {
  // Use the Promise directly so this function stays sync for the other case.
  let perms = await lazy.ExtensionPermissions.get(addon.id);
  return perms.permissions.includes(PRIVATE_BROWSING_PERM_NAME);
}

export function hasPermission(addon, permission) {
  return !!(addon.permissions & PERMISSION_MASKS[permission]);
}

export function isInState(install, state) {
  return install.state == AddonManager["STATE_" + state.toUpperCase()];
}

export function isPendingRestartInstall(install) {
  const addon = install?.addon;
  return !!(
    addon &&
    !install.existingAddon &&
    isInState(install, "installed") &&
    addon.pendingOperations & AddonManager.PENDING_INSTALL &&
    addon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_INSTALL
  );
}

export async function getAddonMessageInfo(
  addon,
  { isCardExpanded, isInDisabledSection }
) {
  const { name } = addon;
  const updateInstall = getUpdateInstall(addon);
  const { STATE_BLOCKED, STATE_SOFTBLOCKED } = Ci.nsIBlocklistService;

  if (addon.blocklistState === STATE_BLOCKED) {
    let typeSuffix = addon.type === "extension" ? "extension" : "other";
    return {
      linkUrl: await addon.getBlocklistURL(),
      linkId: "details-notification-blocked-link2",
      messageId: `details-notification-hard-blocked-${typeSuffix}`,
      type: "error",
    };
  } else if (isDisabledUnsigned(addon)) {
    return {
      linkSumoPage: "unsigned-addons",
      messageId: "details-notification-unsigned-and-disabled2",
      messageArgs: { name },
      type: "error",
    };
  } else if (
    !addon.isCompatible &&
    (AddonManager.checkCompatibility ||
      addon.blocklistState !== STATE_SOFTBLOCKED)
  ) {
    return {
      // TODO: (Bug 1921870) consider adding a SUMO page.
      // NOTE: this messagebar is customized by Thunderbird to include
      // a non-SUMO link (see Bug 1921870 comment 0).
      messageId: "details-notification-incompatible2",
      messageArgs: { name, version: Services.appinfo.version },
      type: "error",
    };
  } else if (isPendingRestartInstall(addon.install)) {
    return {
      action: "cancel-install",
      actionId: "pending-restart-install-cancel-button",
      messageId: "pending-restart-install-description",
      messageArgs: { addon: name },
      type: "warning",
    };
  } else if (
    !isCorrectlySigned(addon) &&
    // In automation, local builds and Thunderbird application instances
    // we allow to disable the unsigned addons message bar.
    !isUnsignedWarningMessageDisabled()
  ) {
    return {
      linkSumoPage: "unsigned-addons",
      messageId: "details-notification-unsigned2",
      messageArgs: { name },
      type: "warning",
    };
  } else if (addon.blocklistState === STATE_SOFTBLOCKED) {
    const softBlockFluentIdsMap = {
      extension: {
        enabled: "details-notification-soft-blocked-extension-enabled2",
        disabled: "details-notification-soft-blocked-extension-disabled2",
      },
      other: {
        enabled: "details-notification-soft-blocked-other-enabled2",
        disabled: "details-notification-soft-blocked-other-disabled2",
      },
    };
    let typeSuffix = addon.type === "extension" ? "extension" : "other";
    let stateSuffix;
    // If the Addon Card is not expanded, delay changing the messagebar
    // string to when the Addon card is refreshed as part of moving
    // it between the enabled and disabled sections.
    if (isCardExpanded) {
      stateSuffix = addon.isActive ? "enabled" : "disabled";
    } else {
      stateSuffix = !isInDisabledSection ? "enabled" : "disabled";
    }
    let messageId = softBlockFluentIdsMap[typeSuffix][stateSuffix];

    return {
      linkUrl: await addon.getBlocklistURL(),
      linkId: "details-notification-softblocked-link2",
      messageId,
      type: "warning",
    };
  } else if (
    addon.pendingOperations & AddonManager.PENDING_ENABLE &&
    addon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_ENABLE
  ) {
    return {
      messageId: "pending-restart-enable-description",
      messageArgs: { addon: name },
      type: "warning",
    };
  } else if (
    addon.pendingOperations & AddonManager.PENDING_DISABLE &&
    addon.operationsRequiringRestart & AddonManager.OP_NEEDS_RESTART_DISABLE
  ) {
    return {
      messageId: "pending-restart-disable-description",
      messageArgs: { addon: name },
      type: "warning",
    };
  } else if (
    addon.pendingOperations & AddonManager.PENDING_UPGRADE &&
    updateInstall &&
    isInState(updateInstall, "installed")
  ) {
    return {
      action: "cancel-update",
      actionId: "pending-uninstall-undo-button",
      messageId: "pending-restart-update-description",
      messageArgs: { addon: name },
      type: "warning",
    };
  } else if (addon.isGMPlugin && !addon.isInstalled && addon.isActive) {
    return {
      messageId: "details-notification-gmp-pending2",
      messageArgs: { name },
      type: "warning",
    };
  }
  return {};
}

export function checkForUpdate(addon) {
  return new Promise(resolve => {
    let listener = {
      onUpdateAvailable(addon, install) {
        if (AddonManager.shouldAutoUpdate(addon)) {
          // Make sure that an update handler is attached to all the install
          // objects when updated xpis are going to be installed automatically.
          attachUpdateHandler(install);

          let failed = () => {
            detachUpdateHandler(install);
            install.removeListener(updateListener);
            resolve({ installed: false, pending: false, found: true });
          };
          let updateListener = {
            onDownloadFailed: failed,
            onInstallCancelled: failed,
            onInstallFailed: failed,
            onInstallEnded: () => {
              detachUpdateHandler(install);
              install.removeListener(updateListener);
              resolve({ installed: true, pending: false, found: true });
            },
            onInstallPostponed: () => {
              detachUpdateHandler(install);
              install.removeListener(updateListener);
              resolve({ installed: false, pending: true, found: true });
            },
          };
          install.addListener(updateListener);
          install.install();
        } else {
          resolve({ installed: false, pending: true, found: true });
        }
      },
      onNoUpdateAvailable() {
        resolve({ found: false });
      },
    };
    addon.findUpdates(listener, AddonManager.UPDATE_WHEN_USER_REQUESTED);
  });
}

export async function checkForUpdates() {
  let addons = await AddonManager.getAddonsByTypes(null);
  addons = addons.filter(addon => hasPermission(addon, "upgrade"));
  let updates = await Promise.all(addons.map(addon => checkForUpdate(addon)));
  gViewController.notifyEMUpdateCheckFinished();
  return updates.reduce(
    (counts, update) => ({
      installed: counts.installed + (update.installed ? 1 : 0),
      pending: counts.pending + (update.pending ? 1 : 0),
      found: counts.found + (update.found ? 1 : 0),
    }),
    { installed: 0, pending: 0, found: 0 }
  );
}

// Check if an add-on has the provided options type, accounting for the pref
// to disable inline options.
export function getOptionsType(addon) {
  return OPTIONS_TYPE_MAP[addon.optionsType];
}

// Check whether the options page can be loaded in the current browser window.
export async function isAddonOptionsUIAllowed(addon) {
  if (
    addon.type !== "extension" ||
    getOptionsType(addon) === "dialog" ||
    !addon.isWebExtension ||
    !getOptionsType(addon)
  ) {
    // Check private browsing only for tab and inline WebExtension options.
    return true;
  }
  if (!lazy.PrivateBrowsingUtils.isContentWindowPrivate(window)) {
    return true;
  }
  if (addon.incognito === "not_allowed") {
    return false;
  }
  // The current page is in a private browsing window, and the add-on does not
  // have the permission to access private browsing windows. Block access.
  return (
    // Note: This function is async because isAllowedInPrivateBrowsing is async.
    isAllowedInPrivateBrowsing(addon)
  );
}

export function nl2br(text) {
  let frag = document.createDocumentFragment();
  let hasAppended = false;
  for (let part of text.split("\n")) {
    if (hasAppended) {
      frag.appendChild(document.createElement("br"));
    }
    frag.appendChild(new Text(part));
    hasAppended = true;
  }
  return frag;
}

/**
 * Select the screeenshot to display above an add-on card.
 *
 * @param {AddonWrapper|DiscoAddonWrapper} addon
 * @returns {string|null}
 *          The URL of the best fitting screenshot, if any.
 */
export function getScreenshotUrlForAddon(addon) {
  if (addon.id == "default-theme@mozilla.org") {
    return "chrome://mozapps/content/extensions/default-theme/preview.svg";
  }
  const builtInThemePreview = lazy.BuiltInThemes.previewForBuiltInThemeId(
    addon.id
  );
  if (builtInThemePreview) {
    return builtInThemePreview;
  }

  let { screenshots } = addon;
  if (!screenshots || !screenshots.length) {
    return null;
  }

  // The image size is defined at .card-heading-image in aboutaddons.css, and
  // is based on the aspect ratio for a 680x92 image. Use the image if possible,
  // and otherwise fall back to the first image and hope for the best.
  let screenshot = screenshots.find(s => s.width === 680 && s.height === 92);
  if (!screenshot) {
    console.warn(`Did not find screenshot with desired size for ${addon.id}.`);
    screenshot = screenshots[0];
  }
  return screenshot.url;
}

/**
 * Adds UTM parameters to a given URL, if it is an AMO URL.
 *
 * @param {string} contentAttribute
 *        Identifies the part of the UI with which the link is associated.
 * @param {string} url
 * @returns {string}
 *          The url with UTM parameters if it is an AMO URL.
 *          Otherwise the url in unmodified form.
 */
export function formatUTMParams(contentAttribute, url) {
  let parsedUrl = new URL(url);
  let domain = `.${parsedUrl.hostname}`;
  if (
    !domain.endsWith(".mozilla.org") &&
    // For testing: addons-dev.allizom.org and addons.allizom.org
    !domain.endsWith(".allizom.org")
  ) {
    return url;
  }

  parsedUrl.searchParams.set("utm_source", "firefox-browser");
  parsedUrl.searchParams.set("utm_medium", "firefox-browser");
  parsedUrl.searchParams.set("utm_content", contentAttribute);
  return parsedUrl.href;
}

// A wrapper around an item from the "results" array from AMO's discovery API.
// See https://addons-server.readthedocs.io/en/latest/topics/api/discovery.html
export class DiscoAddonWrapper {
  /**
   * @param {object} details
   *        An item in the "results" array from AMO's discovery API.
   */
  constructor(details) {
    // Reuse AddonRepository._parseAddon to have the AMO response parsing logic
    // in one place.
    let repositoryAddon = lazy.AddonRepository._parseAddon(details.addon);

    // Note: Any property used by RecommendedAddonCard should appear here.
    // The property names and values should have the same semantics as
    // AddonWrapper, to ease the reuse of helper functions in this file.
    this.id = repositoryAddon.id;
    this.type = repositoryAddon.type;
    this.name = repositoryAddon.name;
    this.screenshots = repositoryAddon.screenshots;
    this.sourceURI = repositoryAddon.sourceURI;
    this.creator = repositoryAddon.creator;
    this.averageRating = repositoryAddon.averageRating;

    this.dailyUsers = details.addon.average_daily_users;

    this.editorialDescription = details.description_text;
    this.iconURL = details.addon.icon_url;
    this.amoListingUrl = details.addon.url;

    this.taarRecommended = details.is_recommendation;
  }
}

/**
 * A helper to retrieve the list of recommended add-ons via AMO's discovery API.
 */
export var DiscoveryAPI = {
  // Map<boolean, Promise> Promises from fetching the API results with or
  // without a client ID. The `false` (no client ID) case could actually
  // have been fetched with a client ID. See getResults() for more info.
  _resultPromises: new Map(),

  /**
   * Fetch the list of recommended add-ons. The results are cached.
   *
   * Pending requests are coalesced, so there is only one request at any given
   * time. If a request fails, the pending promises are rejected, but a new
   * call will result in a new request. A succesful response is cached for the
   * lifetime of the document.
   *
   * @param {boolean} preferClientId
   *                  A boolean indicating a preference for using a client ID.
   *                  This will not overwrite the user preference but will
   *                  avoid sending a client ID if no request has been made yet.
   * @returns {Promise<DiscoAddonWrapper[]>}
   */
  async getResults(preferClientId = true) {
    // Allow a caller to set preferClientId to false, but not true if discovery
    // is disabled.
    preferClientId = preferClientId && this.clientIdDiscoveryEnabled;

    // Reuse a request for this preference first.
    let resultPromise =
      this._resultPromises.get(preferClientId) ||
      // If the client ID isn't preferred, we can still reuse a request with the
      // client ID.
      (!preferClientId && this._resultPromises.get(true));

    if (resultPromise) {
      return resultPromise;
    }

    // Nothing is prepared for this preference, make a new request.
    resultPromise = this._fetchRecommendedAddons(preferClientId).catch(e => {
      // Delete the pending promise, so _fetchRecommendedAddons can be
      // called again at the next property access.
      this._resultPromises.delete(preferClientId);
      Cu.reportError(e);
      throw e;
    });

    // Store the new result for the preference.
    this._resultPromises.set(preferClientId, resultPromise);

    return resultPromise;
  },

  get clientIdDiscoveryEnabled() {
    // These prefs match Discovery.sys.mjs for enabling clientId cookies.
    return (
      Services.prefs.getBoolPref(PREF_RECOMMENDATION_ENABLED, false) &&
      Services.prefs.getBoolPref(PREF_TELEMETRY_ENABLED, false) &&
      !lazy.PrivateBrowsingUtils.isContentWindowPrivate(window)
    );
  },

  async _fetchRecommendedAddons(useClientId) {
    let discoveryApiUrl = new URL(
      Services.urlFormatter.formatURLPref(PREF_DISCOVERY_API_URL)
    );

    if (useClientId) {
      let clientId = await lazy.ClientID.getClientIdHash();
      discoveryApiUrl.searchParams.set("telemetry-client-id", clientId);
    }
    let res = await fetch(discoveryApiUrl.href, {
      credentials: "omit",
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch recommended add-ons, ${res.status}`);
    }
    let { results } = await res.json();
    return results.map(details => new DiscoAddonWrapper(details));
  },
};

/**
 * @param {Element} el The button element.
 */
export function openAmoInTab(el, path) {
  let amoUrl = Services.urlFormatter.formatURLPref(
    "extensions.getAddons.link.url"
  );

  if (path) {
    amoUrl += path;
  }

  amoUrl = formatUTMParams("find-more-link-bottom", amoUrl);
  window.windowRoot.window.openTrustedLinkIn(amoUrl, "tab");
}

// DOMParser instance used by AboutAddonsElementMixin to parse the
// template markup strings provided by the custom elements inheriting
// from an AboutAddonsElementBase class.
const domParser = new DOMParser();

// This helper returns a subclass of a given `Base` class which provides
// a static `fragment` getter which is going to parses an HTML template
// from the string returned by a `markup` static getter, which is meant
// to be provided by the custom elements subclassing the returned class,
// and return its content elements imported into the current document.
export function AboutAddonsElementMixin(Base) {
  let AboutAddonsElementBase = class extends Base {
    static get markup() {
      // This static getter method is expected to be defined
      // by the subclass, throw an error when it is not.
      throw new Error(`${this.name} markup static getter is missing`);
    }

    static get fragment() {
      if (!this.hasOwnProperty("_template")) {
        let doc = domParser.parseFromString(this.markup, "text/html");
        this._template = doc.querySelector("template");
        if (!this._template) {
          throw new Error(
            `${this.name} markup is missing the expected template tag`
          );
        }
      }
      // NOTE: document.importNode is used here to make sure the
      // domain-specific custom elements only registered to the
      // about:addons document are going to be upgraded as expected
      // also when the template content is added to a parent node
      // not yet connected to the document.
      return document.importNode(this._template.content, true);
    }
  };
  // Rename the class to make it easier to distinguish it.
  Object.defineProperty(AboutAddonsElementBase, "name", {
    value: `AboutAddons${Base.name}`,
  });
  return AboutAddonsElementBase;
}

// An HTMLElement subclass which includes by default the static `fragment`
// getter provided by the AboutAddonsElementMixin.
//
// This helper is used by about:addons webcomponents as in the example
// that follows:
//
// class SomeCustomElement extensions AboutAddonsHTMLElement {
//   static get markup() {
//     return `
//       <template>
//         ...
//       </template>
//     `;
//   }
//
//   connectCallback() {
//     this.appendChild(SomeCustomElement.fragment);
//   }
// }
export const AboutAddonsHTMLElement = AboutAddonsElementMixin(HTMLElement);
