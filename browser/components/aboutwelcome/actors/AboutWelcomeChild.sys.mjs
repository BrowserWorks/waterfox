/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  AboutWelcomeDefaults:
    "resource:///modules/aboutwelcome/AboutWelcomeDefaults.sys.mjs",
  WaterfoxWelcomeConfig:
    "resource:///modules/aboutwelcome/WaterfoxWelcomeConfig.sys.mjs",
  EnrollmentType: "resource://nimbus/ExperimentAPI.sys.mjs",
  NimbusFeatures: "resource://nimbus/ExperimentAPI.sys.mjs",
});

ChromeUtils.defineLazyGetter(lazy, "log", () => {
  const { Logger } = ChromeUtils.importESModule(
    "resource://messaging-system/lib/Logger.sys.mjs"
  );
  return new Logger("AboutWelcomeChild");
});

const DID_SEE_FINAL_SCREEN_PREF = "browser.aboutwelcome.didSeeFinalScreen";

XPCOMUtils.defineLazyPreferenceGetter(
  lazy,
  "toolbarEntrypoint",
  "browser.aboutwelcome.entrypoint",
  ""
);

export class AboutWelcomeChild extends JSWindowActorChild {
  // Can be used to avoid accesses to the document/contentWindow after it's
  // destroyed, which may throw unhandled exceptions.
  _destroyed = false;

  didDestroy() {
    this._destroyed = true;
  }

  actorCreated() {
    this.exportFunctions();
  }

  /**
   * Send event that can be handled by the page
   *
   * @param {{type: string, data?: any}} action
   */
  sendToPage(action) {
    lazy.log.debug(`Sending to page: ${action.type}`);
    const win = this.document.defaultView;
    const event = new win.CustomEvent("AboutWelcomeChromeToContent", {
      detail: Cu.cloneInto(action, win),
    });
    win.dispatchEvent(event);
  }

  /**
   * Export functions that can be called by page js
   */
  exportFunctions() {
    let window = this.contentWindow;

    Cu.exportFunction(this.AWAddScreenImpression.bind(this), window, {
      defineAs: "AWAddScreenImpression",
    });

    Cu.exportFunction(this.AWGetFeatureConfig.bind(this), window, {
      defineAs: "AWGetFeatureConfig",
    });

    Cu.exportFunction(this.AWGetFxAMetricsFlowURI.bind(this), window, {
      defineAs: "AWGetFxAMetricsFlowURI",
    });

    Cu.exportFunction(this.AWGetSelectedTheme.bind(this), window, {
      defineAs: "AWGetSelectedTheme",
    });

    Cu.exportFunction(this.AWSelectTheme.bind(this), window, {
      defineAs: "AWSelectTheme",
    });

    Cu.exportFunction(this.AWEvaluateScreenTargeting.bind(this), window, {
      defineAs: "AWEvaluateScreenTargeting",
    });

    Cu.exportFunction(this.AWEvaluateAttributeTargeting.bind(this), window, {
      defineAs: "AWEvaluateAttributeTargeting",
    });

    Cu.exportFunction(this.AWSendEventTelemetry.bind(this), window, {
      defineAs: "AWSendEventTelemetry",
    });

    Cu.exportFunction(this.AWSendToParent.bind(this), window, {
      defineAs: "AWSendToParent",
    });

    Cu.exportFunction(this.AWWaitForMigrationClose.bind(this), window, {
      defineAs: "AWWaitForMigrationClose",
    });

    Cu.exportFunction(this.AWFinish.bind(this), window, {
      defineAs: "AWFinish",
    });

    Cu.exportFunction(this.AWGetInstalledAddons.bind(this), window, {
      defineAs: "AWGetInstalledAddons",
    });

    Cu.exportFunction(this.AWEnsureAddonInstalled.bind(this), window, {
      defineAs: "AWEnsureAddonInstalled",
    });

    Cu.exportFunction(this.AWEnsureLangPackInstalled.bind(this), window, {
      defineAs: "AWEnsureLangPackInstalled",
    });

    Cu.exportFunction(
      this.AWNegotiateLangPackForLanguageMismatch.bind(this),
      window,
      {
        defineAs: "AWNegotiateLangPackForLanguageMismatch",
      }
    );

    Cu.exportFunction(this.AWSetRequestedLocales.bind(this), window, {
      defineAs: "AWSetRequestedLocales",
    });

    Cu.exportFunction(this.AWSendToDeviceEmailsSupported.bind(this), window, {
      defineAs: "AWSendToDeviceEmailsSupported",
    });

    Cu.exportFunction(this.AWNewScreen.bind(this), window, {
      defineAs: "AWNewScreen",
    });
    Cu.exportFunction(this.AWGetUnhandledCampaignAction.bind(this), window, {
      defineAs: "AWGetUnhandledCampaignAction",
    });
  }

  /**
   * Wrap a promise so content can use Promise methods.
   */
  wrapPromise(promise) {
    return new this.contentWindow.Promise((resolve, reject) =>
      promise.then(resolve, reject)
    );
  }

  /**
   * Clones the result of the query into the content window.
   */
  sendQueryAndCloneForContent(...sendQueryArgs) {
    return this.wrapPromise(
      (async () => {
        return Cu.cloneInto(
          await this.sendQuery(...sendQueryArgs),
          this.contentWindow
        );
      })()
    );
  }

  AWSelectTheme(data) {
    return this.wrapPromise(
      this.sendQuery("AWPage:SELECT_THEME", data.toUpperCase())
    );
  }

  AWEvaluateScreenTargeting(data) {
    return this.sendQueryAndCloneForContent(
      "AWPage:EVALUATE_SCREEN_TARGETING",
      data
    );
  }

  AWEvaluateAttributeTargeting(data) {
    return this.wrapPromise(
      this.sendQuery("AWPage:EVALUATE_ATTRIBUTE_TARGETING", data)
    );
  }

  AWAddScreenImpression(screen) {
    return this.wrapPromise(
      this.sendQuery("AWPage:ADD_SCREEN_IMPRESSION", screen)
    );
  }

  /**
   * Send initial data to page including experiment information
   */
  async getAWContent() {
    let attributionData = await this.sendQuery("AWPage:GET_ATTRIBUTION_DATA");

    // Use Waterfox custom configuration instead of Nimbus if enabled
    let experimentMetadata = {};
    let featureConfig = {};

    if (lazy.WaterfoxWelcomeConfig.isEnabled()) {
      experimentMetadata = lazy.WaterfoxWelcomeConfig.getEnrollmentMetadata();
      featureConfig = lazy.WaterfoxWelcomeConfig.getAllVariables();

      lazy.log.debug(
        `Loading about:welcome with Waterfox custom configuration`
      );
    }

    featureConfig.needDefault = await this.sendQuery("AWPage:NEED_DEFAULT");
    featureConfig.needPin = await this.sendQuery("AWPage:DOES_APP_NEED_PIN");
    if (featureConfig.languageMismatchEnabled) {
      featureConfig.appAndSystemLocaleInfo = await this.sendQuery(
        "AWPage:GET_APP_AND_SYSTEM_LOCALE_INFO"
      );
    }

    // FeatureConfig (from experiments or Waterfox config) has higher precedence
    // to defaults. But the `screens` property isn't defined we shouldn't
    // override the default with `null`
    let defaults = lazy.AboutWelcomeDefaults.getDefaults();

    const content = await lazy.AboutWelcomeDefaults.prepareContentForReact({
      ...attributionData,
      ...experimentMetadata,
      ...defaults,
      ...featureConfig,
      screens: featureConfig.screens ?? defaults.screens,
      backdrop: featureConfig.backdrop ?? defaults.backdrop,
    });

    return Cu.cloneInto(content, this.contentWindow);
  }

  AWGetFeatureConfig() {
    return this.wrapPromise(this.getAWContent());
  }

  AWGetFxAMetricsFlowURI() {
    return this.wrapPromise(this.sendQuery("AWPage:FXA_METRICS_FLOW_URI"));
  }

  AWGetSelectedTheme() {
    return this.wrapPromise(this.sendQuery("AWPage:GET_SELECTED_THEME"));
  }

  /**
   * Send Event Telemetry
   *
   * @param {object} eventData
   */
  AWSendEventTelemetry(eventData) {
    if (lazy.toolbarEntrypoint) {
      eventData.event_context.entrypoint = lazy.toolbarEntrypoint;
    }
    this.AWSendToParent("TELEMETRY_EVENT", {
      ...eventData,
      event_context: {
        ...eventData.event_context,
      },
    });
  }

  /**
   * Send message that can be handled by AboutWelcomeParent.sys.mjs
   *
   * @param {string} type
   * @param {any=} data
   * @returns {Promise<unknown>}
   */
  AWSendToParent(type, data) {
    return this.sendQueryAndCloneForContent(`AWPage:${type}`, data);
  }

  AWWaitForMigrationClose() {
    return this.wrapPromise(this.sendQuery("AWPage:WAIT_FOR_MIGRATION_CLOSE"));
  }

  setDidSeeFinalScreen() {
    this.AWSendToParent("SPECIAL_ACTION", {
      type: "SET_PREF",
      data: {
        pref: {
          name: DID_SEE_FINAL_SCREEN_PREF,
          value: true,
        },
      },
    });
  }

  focusUrlBar() {
    this.AWSendToParent("SPECIAL_ACTION", {
      type: "FOCUS_URLBAR",
    });
  }

  AWFinish() {
    this.setDidSeeFinalScreen();

    this.contentWindow.location.href = "about:home";
    this.focusUrlBar();
  }

  AWEnsureAddonInstalled(addonId) {
    return this.wrapPromise(
      this.sendQuery("AWPage:ENSURE_ADDON_INSTALLED", addonId)
    );
  }

  AWGetInstalledAddons() {
    return this.wrapPromise(
      this.sendQueryAndCloneForContent("AWPage:GET_INSTALLED_ADDONS")
    );
  }

  AWEnsureLangPackInstalled(negotiated, screenContent) {
    const content = Cu.cloneInto(screenContent, {});
    return this.wrapPromise(
      this.sendQuery(
        "AWPage:ENSURE_LANG_PACK_INSTALLED",
        negotiated.langPack
      ).then(() => {
        const formatting = [];
        const l10n = new Localization(
          ["branding/brand.ftl", "browser/newtab/onboarding.ftl"],
          false,
          undefined,
          // Use the system-ish then app then default locale.
          [...negotiated.requestSystemLocales, "en-US"]
        );

        // Add the negotiated language name as args.
        function addMessageArgsAndUseLangPack(obj) {
          for (const value of Object.values(obj)) {
            if (value?.string_id) {
              value.args = {
                ...value.args,
                negotiatedLanguage: negotiated.langPackDisplayName,
              };

              // Expose fluent strings wanting lang pack as raw.
              if (value.useLangPack) {
                formatting.push(
                  l10n.formatValue(value.string_id, value.args).then(raw => {
                    delete value.string_id;
                    value.raw = raw;
                  })
                );
              }
            }
          }
        }
        addMessageArgsAndUseLangPack(content.languageSwitcher);
        addMessageArgsAndUseLangPack(content);
        return Promise.all(formatting).then(() =>
          Cu.cloneInto(content, this.contentWindow)
        );
      })
    );
  }

  AWSetRequestedLocales(requestSystemLocales) {
    return this.sendQueryAndCloneForContent(
      "AWPage:SET_REQUESTED_LOCALES",
      requestSystemLocales
    );
  }

  AWNegotiateLangPackForLanguageMismatch(appAndSystemLocaleInfo) {
    return this.sendQueryAndCloneForContent(
      "AWPage:NEGOTIATE_LANGPACK",
      appAndSystemLocaleInfo
    );
  }

  AWSendToDeviceEmailsSupported() {
    return this.wrapPromise(
      this.sendQuery("AWPage:SEND_TO_DEVICE_EMAILS_SUPPORTED")
    );
  }

  AWNewScreen(screenId) {
    return this.wrapPromise(this.sendQuery("AWPage:NEW_SCREEN", screenId));
  }

  AWGetUnhandledCampaignAction() {
    return this.sendQueryAndCloneForContent(
      "AWPage:GET_UNHANDLED_CAMPAIGN_ACTION"
    );
  }

  /**
   * @param {{type: string, detail?: any}} event
   * @override
   */
  handleEvent(event) {
    lazy.log.debug(`Received page event ${event.type}`);
  }
}
