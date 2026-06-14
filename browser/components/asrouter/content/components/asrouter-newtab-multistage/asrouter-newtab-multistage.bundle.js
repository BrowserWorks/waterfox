/*! THIS FILE IS AUTO-GENERATED: webpack.base.config.js */
/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	// The require scope
/******/ 	var __webpack_require__ = {};
/******/ 	
/************************************************************************/
/******/ 	/* webpack/runtime/compat get default export */
/******/ 	(() => {
/******/ 		// getDefaultExport function for compatibility with non-harmony modules
/******/ 		__webpack_require__.n = (module) => {
/******/ 			var getter = module && module.__esModule ?
/******/ 				() => (module['default']) :
/******/ 				() => (module);
/******/ 			__webpack_require__.d(getter, { a: getter });
/******/ 			return getter;
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/define property getters */
/******/ 	(() => {
/******/ 		// define getter functions for harmony exports
/******/ 		__webpack_require__.d = (exports, definition) => {
/******/ 			for(var key in definition) {
/******/ 				if(__webpack_require__.o(definition, key) && !__webpack_require__.o(exports, key)) {
/******/ 					Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
/******/ 				}
/******/ 			}
/******/ 		};
/******/ 	})();
/******/ 	
/******/ 	/* webpack/runtime/hasOwnProperty shorthand */
/******/ 	(() => {
/******/ 		__webpack_require__.o = (obj, prop) => (Object.prototype.hasOwnProperty.call(obj, prop))
/******/ 	})();
/******/ 	
/************************************************************************/

;// external "React"
const external_React_namespaceObject = React;
var external_React_default = /*#__PURE__*/__webpack_require__.n(external_React_namespaceObject);
;// external "ReactDOM"
const external_ReactDOM_namespaceObject = ReactDOM;
;// ./content-src/components/MSLocalized.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */


const CONFIGURABLE_STYLES = ["background", "color", "display", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "marginBlock", "marginBlockStart", "marginBlockEnd", "marginInline", "paddingBlock", "paddingBlockStart", "paddingBlockEnd", "paddingInline", "paddingInlineStart", "paddingInlineEnd", "textAlign", "whiteSpace", "width", "height", "borderBlockStart", "borderBlockEnd", "top", "bottom", "left", "right", "inset", "insetBlock", "insetInline", "minHeight", "minWidth"];
const ZAP_SIZE_THRESHOLD = 160;

/**
 * Based on the .text prop, localizes an inner element if a string_id
 * is provided, OR renders plain text, OR hides it if nothing is provided.
 * Allows configuring of some styles including zap underline and color.
 *
 * Examples:
 *
 * Localized text
 * ftl:
 *  title = Welcome
 * jsx:
 *   <Localized text={{string_id: "title"}}><h1 /></Localized>
 * output:
 *   <h1 data-l10n-id="title">Welcome</h1>
 *
 * Unlocalized text
 * jsx:
 *   <Localized text="Welcome"><h1 /></Localized>
 *   <Localized text={{raw: "Welcome"}}><h1 /></Localized>
 * output:
 *   <h1>Welcome</h1>
 */

const Localized = ({
  text,
  children
}) => {
  // Dynamically determine the size of the zap style.
  const zapRef = /*#__PURE__*/external_React_default().createRef();
  (0,external_React_namespaceObject.useEffect)(() => {
    const {
      current
    } = zapRef;
    if (current) {
      requestAnimationFrame(() => current?.classList.replace("short", current.getBoundingClientRect().width > ZAP_SIZE_THRESHOLD ? "long" : "short"));
    }
  });

  // Skip rendering of children with no text.
  if (!text) {
    return null;
  }

  // Allow augmenting existing child container properties.
  const props = {
    children: [],
    className: "",
    style: {},
    ...children?.props
  };
  // Support nested Localized by starting with their children.
  const textNodes = Array.isArray(props.children) ? props.children : [props.children];

  // Pick desired fluent or raw/plain text to render.
  if (text.string_id) {
    // Set the key so React knows not to reuse when switching to plain text.
    props.key = text.string_id;
    props["data-l10n-id"] = text.string_id;
    if (text.args) {
      props["data-l10n-args"] = JSON.stringify(text.args);
    }
  } else if (text.raw) {
    textNodes.push(text.raw);
  } else if (typeof text === "string") {
    textNodes.push(text);
  }

  // Add zap style and content in a way that allows fluent to insert too.
  if (text.zap) {
    props.className += " welcomeZap";
    textNodes.push(/*#__PURE__*/external_React_default().createElement("span", {
      className: "short zap",
      "data-l10n-name": "zap",
      ref: zapRef
    }, text.zap));
  }
  if (text.aria_label) {
    props["aria-label"] = text.aria_label;
  }

  // Apply certain configurable styles.
  CONFIGURABLE_STYLES.forEach(style => {
    if (text[style] !== undefined) {
      props.style[style] = text[style];
    }
  });
  return /*#__PURE__*/external_React_default().cloneElement(
  // Provide a default container for the text if necessary.
  children ?? /*#__PURE__*/external_React_default().createElement("span", null), props,
  // Conditionally pass in as void elements can't accept empty array.
  textNodes.length ? textNodes : null);
};
;// ./content-src/lib/multistage-utils.mjs
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

// If the container has a "page" data attribute, then this is
// a Spotlight modal or Feature Callout. Otherwise, this is
// about:welcome and we should return the current page.
const page =
  document.querySelector(
    "#multi-stage-message-root.onboardingContainer[data-page]"
  )?.dataset.page || document.location.href;

const MultiStageUtils = {
  handleUserAction(action) {
    return window.AWSendToParent("SPECIAL_ACTION", action);
  },
  handleImpressionAction(action, messageId, screenId) {
    return Promise.resolve(
      window.AWSendImpressionAction?.({
        action,
        message_id: messageId,
        screen_id: screenId,
      })
    ).then(fired => {
      // Record action telemetry only when the parent actually ran the action;
      // it may be rejected by the allowlist or suppressed by `once`.
      if (fired) {
        this.sendActionTelemetry(messageId, action.type, "IMPRESSION_ACTION");
      }
    });
  },
  sendImpressionTelemetry(messageId, context = {}) {
    window.AWSendEventTelemetry?.({
      event: "IMPRESSION",
      event_context: {
        ...context,
        page,
      },
      message_id: messageId,
    });
  },
  sendActionTelemetry(
    messageId,
    elementId,
    eventName = "CLICK_BUTTON",
    context = {}
  ) {
    const ping = {
      event: eventName,
      event_context: {
        source: elementId,
        page,
        ...context,
      },
      message_id: messageId,
    };
    window.AWSendEventTelemetry?.(ping);
  },
  sendDismissTelemetry(messageId, elementId, context = {}) {
    // Don't send DISMISS telemetry in spotlight modals since they already send
    // their own equivalent telemetry.
    if (page !== "spotlight") {
      this.sendActionTelemetry(messageId, elementId, "DISMISS", context);
    }
  },
  async fetchFlowParams(metricsFlowUri) {
    let flowParams;
    try {
      const response = await fetch(metricsFlowUri, {
        credentials: "omit",
      });
      if (response.status === 200) {
        const { deviceId, flowId, flowBeginTime } = await response.json();
        flowParams = { deviceId, flowId, flowBeginTime };
      } else {
        console.error("Non-200 response", response);
      }
    } catch (e) {
      flowParams = null;
    }
    return flowParams;
  },
  sendEvent(type, detail) {
    document.dispatchEvent(
      new CustomEvent(`AWPage:${type}`, {
        bubbles: true,
        detail,
      })
    );
  },
  getLoadingStrategyFor(url) {
    return url?.startsWith("http") ? "lazy" : "eager";
  },
  handleCampaignAction(action, messageId, context) {
    window.AWSendToParent("HANDLE_CAMPAIGN_ACTION", action).then(handled => {
      if (handled) {
        this.sendActionTelemetry(
          messageId,
          "CAMPAIGN_ACTION",
          "CLICK_BUTTON",
          context
        );
      }
    });
  },
  getValidStyle(style, validStyles, allowVars) {
    if (!style) {
      return null;
    }
    return Object.keys(style)
      .filter(
        key => validStyles.includes(key) || (allowVars && key.startsWith("--"))
      )
      .reduce((obj, key) => {
        obj[key] = style[key];
        return obj;
      }, {});
  },
  getTileStyle(tile, validStyle) {
    const preferredTileStyle = tile?.style;
    const legacyTileStyle = tile?.tiles?.style ?? null;

    return this.getValidStyle(
      preferredTileStyle ?? legacyTileStyle,
      validStyle,
      true
    );
  },
};

;// ./content-src/components/LanguageSwitcher.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */





/**
 * The language switcher implements a hook that should be placed at a higher level
 * than the actual language switcher component, as it needs to preemptively fetch
 * and install langpacks for the user if there is a language mismatch screen.
 */
function useLanguageSwitcher(appAndSystemLocaleInfo, screens, screenIndex, setScreenIndex) {
  const languageMismatchScreenIndex = screens.findIndex(({
    id
  }) => id === "AW_LANGUAGE_MISMATCH");
  const mismatchScreen = screens[languageMismatchScreenIndex];

  // Ensure fluent messages have the negotiatedLanguage args set, as they are rendered
  // before the negotiatedLanguage is known. If the arg isn't present then Firefox will
  // crash in development mode.
  (0,external_React_namespaceObject.useEffect)(() => {
    if (mismatchScreen?.content?.languageSwitcher) {
      for (const text of Object.values(mismatchScreen.content.languageSwitcher)) {
        if (text?.args && text.args.negotiatedLanguage === undefined) {
          text.args.negotiatedLanguage = "";
        }
      }
    }
  }, [mismatchScreen]);

  // If there is a mismatch, then Firefox can negotiate a better langpack to offer
  // the user.
  const [negotiatedLanguage, setNegotiatedLanguage] = (0,external_React_namespaceObject.useState)(null);
  (0,external_React_namespaceObject.useEffect)(function getNegotiatedLanguage() {
    if (!appAndSystemLocaleInfo) {
      return;
    }
    if (appAndSystemLocaleInfo.matchType !== "language-mismatch") {
      // There is no language mismatch, so there is no need to negotiate a langpack.
      return;
    }
    (async () => {
      const {
        langPack,
        langPackDisplayName
      } = await window.AWNegotiateLangPackForLanguageMismatch(appAndSystemLocaleInfo);
      if (langPack) {
        setNegotiatedLanguage({
          langPackDisplayName,
          appDisplayName: appAndSystemLocaleInfo.displayNames.appLanguage,
          langPack,
          requestSystemLocales: [langPack.target_locale, appAndSystemLocaleInfo.appLocaleRaw],
          originalAppLocales: [appAndSystemLocaleInfo.appLocaleRaw]
        });
      } else {
        setNegotiatedLanguage({
          langPackDisplayName: null,
          appDisplayName: null,
          langPack: null,
          requestSystemLocales: null
        });
      }
    })();
  }, [appAndSystemLocaleInfo]);

  /**
   * @type {
   *  "before-installation"
   *  | "installing"
   *  | "installed"
   *  | "installation-error"
   *  | "none-available"
   * }
   */
  const [langPackInstallPhase, setLangPackInstallPhase] = (0,external_React_namespaceObject.useState)("before-installation");
  (0,external_React_namespaceObject.useEffect)(function ensureLangPackInstalled() {
    if (!negotiatedLanguage) {
      // There are no negotiated languages to download yet.
      return;
    }
    setLangPackInstallPhase("installing");
    window.AWEnsureLangPackInstalled(negotiatedLanguage, mismatchScreen?.content).then(content => {
      // Update screen content with strings that might have changed.
      mismatchScreen.content = content;
      setLangPackInstallPhase("installed");
    }, error => {
      console.error(error);
      setLangPackInstallPhase("installation-error");
    });
  }, [negotiatedLanguage, mismatchScreen]);
  const [languageFilteredScreens, setLanguageFilteredScreens] = (0,external_React_namespaceObject.useState)(screens);
  (0,external_React_namespaceObject.useEffect)(function filterScreen() {
    // Remove the language screen if it exists (already removed for no live
    // reload) and we either don't-need-to or can't switch.
    if (mismatchScreen && (appAndSystemLocaleInfo?.matchType !== "language-mismatch" || negotiatedLanguage?.langPack === null)) {
      if (screenIndex > languageMismatchScreenIndex) {
        setScreenIndex(screenIndex - 1);
      }
      setLanguageFilteredScreens(screens.filter(s => s.id !== "AW_LANGUAGE_MISMATCH"));
    } else {
      setLanguageFilteredScreens(screens);
    }
  },
  // Removing screenIndex as a dependency as it's causing infinite re-renders (1873019)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [appAndSystemLocaleInfo?.matchType, languageMismatchScreenIndex, negotiatedLanguage, mismatchScreen, screens, setScreenIndex]);
  return {
    negotiatedLanguage,
    langPackInstallPhase,
    languageFilteredScreens
  };
}

/**
 * The language switcher is a separate component as it needs to perform some asynchronous
 * network actions such as retrieving the list of langpacks available, and downloading
 * a new langpack. On a fast connection, this won't be noticeable, but on slow or unreliable
 * internet this may fail for a user.
 */
function LanguageSwitcher(props) {
  const {
    content,
    handleAction,
    negotiatedLanguage,
    langPackInstallPhase,
    messageId
  } = props;
  const [isAwaitingLangpack, setIsAwaitingLangpack] = (0,external_React_namespaceObject.useState)(false);

  // Determine the status of the langpack installation.
  (0,external_React_namespaceObject.useEffect)(() => {
    if (isAwaitingLangpack && langPackInstallPhase !== "installing") {
      window.AWSetRequestedLocales(negotiatedLanguage.requestSystemLocales);
      requestAnimationFrame(() => {
        handleAction(
        // Simulate the click event.
        {
          currentTarget: {
            value: "download_complete"
          }
        });
      });
    }
  }, [handleAction, isAwaitingLangpack, langPackInstallPhase, negotiatedLanguage?.requestSystemLocales]);
  let showWaitingScreen = false;
  let showPreloadingScreen = false;
  let showReadyScreen = false;
  if (isAwaitingLangpack && langPackInstallPhase !== "installed") {
    showWaitingScreen = true;
  } else if (langPackInstallPhase === "before-installation") {
    showPreloadingScreen = true;
  } else {
    showReadyScreen = true;
  }

  // Use {display: "none"} rather than if statements to prevent layout thrashing with
  // the localized text elements rendering as blank, then filling in the text.
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "action-buttons language-switcher-container"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    style: {
      display: showPreloadingScreen ? "block" : "none"
    }
  }, /*#__PURE__*/external_React_default().createElement("button", {
    className: "primary",
    value: "primary_button",
    disabled: true,
    type: "button"
  }, /*#__PURE__*/external_React_default().createElement("img", {
    className: "language-loader",
    src: "chrome://global/skin/icons/loading.svg",
    alt: ""
  }), /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.languageSwitcher.waiting
  })), /*#__PURE__*/external_React_default().createElement("div", {
    className: "secondary-cta"
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.languageSwitcher.skip
  }, /*#__PURE__*/external_React_default().createElement("button", {
    value: "decline_waiting",
    type: "button",
    className: "secondary text-link arrow-icon",
    onClick: handleAction
  })))), /*#__PURE__*/external_React_default().createElement("div", {
    style: {
      display: showWaitingScreen ? "block" : "none"
    }
  }, /*#__PURE__*/external_React_default().createElement("button", {
    className: "primary",
    value: "primary_button",
    disabled: true,
    type: "button"
  }, /*#__PURE__*/external_React_default().createElement("img", {
    className: "language-loader",
    src: "chrome://global/skin/icons/loading.svg",
    alt: ""
  }), /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.languageSwitcher.downloading
  })), /*#__PURE__*/external_React_default().createElement("div", {
    className: "secondary-cta"
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.languageSwitcher.cancel
  }, /*#__PURE__*/external_React_default().createElement("button", {
    type: "button",
    className: "secondary text-link",
    onClick: () => {
      setIsAwaitingLangpack(false);
      handleAction({
        currentTarget: {
          value: "cancel_waiting"
        }
      });
    }
  })))), /*#__PURE__*/external_React_default().createElement("div", {
    style: {
      display: showReadyScreen ? "block" : "none"
    }
  }, /*#__PURE__*/external_React_default().createElement("div", null, /*#__PURE__*/external_React_default().createElement("button", {
    className: "primary",
    value: "primary_button",
    onClick: () => {
      MultiStageUtils.sendActionTelemetry(messageId, "download_langpack", "CLICK_BUTTON");
      setIsAwaitingLangpack(true);
    }
  }, content.languageSwitcher.switch ? /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.languageSwitcher.switch
  }) :
  // This is the localized name from the Intl.DisplayNames API.
  negotiatedLanguage?.langPackDisplayName)), /*#__PURE__*/external_React_default().createElement("div", null, /*#__PURE__*/external_React_default().createElement("button", {
    type: "button",
    className: "primary",
    value: "decline",
    onClick: event => {
      window.AWSetRequestedLocales(negotiatedLanguage.originalAppLocales);
      handleAction(event);
    }
  }, content.languageSwitcher.continue ? /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.languageSwitcher.continue
  }) :
  // This is the localized name from the Intl.DisplayNames API.
  negotiatedLanguage?.appDisplayName))));
}
;// ./content-src/components/CTAParagraph.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */




const CTAParagraph = props => {
  const {
    content,
    handleAction
  } = props;
  if (!content?.text) {
    return null;
  }
  const onClick = external_React_default().useCallback(event => {
    handleAction(event);
    event.preventDefault();
  }, [handleAction]);
  return /*#__PURE__*/external_React_default().createElement("h2", {
    className: `cta-paragraph ${content?.info_tile ? "info-tile" : ""}`,
    style: {
      ...MultiStageUtils.getValidStyle(content?.style, CONFIGURABLE_STYLES)
    }
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "cta-paragraph-icon-wrapper"
  }, /*#__PURE__*/external_React_default().createElement("img", {
    className: "cta-paragraph-icon",
    src: content?.icon?.iconURL,
    style: MultiStageUtils.getValidStyle(content?.icon, CONFIGURABLE_STYLES)
  })), /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.text
  }, content.text.string_name && typeof handleAction === "function" ? /*#__PURE__*/external_React_default().createElement("span", {
    "data-l10n-id": content.text.string_id,
    onClick: onClick,
    onKeyUp: event => ["Enter", " "].includes(event.key) ? onClick(event) : null,
    value: "cta_paragraph"
  }, " ", /*#__PURE__*/external_React_default().createElement("a", {
    "data-l10n-name": content.text.string_name,
    tabIndex: "0",
    role: "link"
  })) : null));
};
;// ./content-src/components/HeroImage.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */



const HeroImage = props => {
  const {
    height,
    url,
    alt
  } = props;
  if (!url) {
    return null;
  }
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "hero-image"
  }, /*#__PURE__*/external_React_default().createElement("img", {
    style: height ? {
      height
    } : null,
    src: url,
    loading: MultiStageUtils.getLoadingStrategyFor(url),
    alt: alt || "",
    role: alt ? null : "presentation"
  }));
};
;// ./content-src/components/OnboardingVideo.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */


const OnboardingVideo = props => {
  const vidUrl = props.content.video_url;
  const autoplay = props.content.autoPlay;
  const handleVideoAction = event => {
    props.handleAction({
      currentTarget: {
        value: event
      }
    });
  };
  return /*#__PURE__*/external_React_default().createElement("div", null, /*#__PURE__*/external_React_default().createElement("video", {
    // eslint-disable-line jsx-a11y/media-has-caption
    controls: true,
    autoPlay: autoplay,
    src: vidUrl,
    width: "604px",
    height: "340px",
    onPlay: () => handleVideoAction("video_start"),
    onEnded: () => handleVideoAction("video_end")
  }, /*#__PURE__*/external_React_default().createElement("source", {
    src: vidUrl
  })));
};
;// ./content-src/components/SubmenuButton.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */



const SubmenuButton = props => {
  return document.createXULElement ? /*#__PURE__*/external_React_default().createElement(SubmenuButtonInner, props) : null;
};
function translateMenuitem(item, element) {
  let {
    label
  } = item;
  if (!label) {
    return;
  }
  if (label.raw) {
    element.setAttribute("label", label.raw);
  }
  if (label.access_key) {
    element.setAttribute("accesskey", label.access_key);
  }
  if (label.aria_label) {
    element.setAttribute("aria-label", label.aria_label);
  }
  if (label.tooltip_text) {
    element.setAttribute("tooltiptext", label.tooltip_text);
  }
  if (label.string_id) {
    element.setAttribute("data-l10n-id", label.string_id);
    if (label.args) {
      element.setAttribute("data-l10n-args", JSON.stringify(label.args));
    }
  }
}
function addMenuitems(items, popup) {
  for (let item of items) {
    switch (item.type) {
      case "separator":
        popup.appendChild(document.createXULElement("menuseparator"));
        break;
      case "menu":
        {
          let menu = document.createXULElement("menu");
          menu.className = "fxms-multi-stage-menu";
          translateMenuitem(item, menu);
          if (item.id) {
            menu.value = item.id;
          }
          if (item.icon) {
            menu.classList.add("menu-iconic");
            menu.setAttribute("image", item.icon);
          }
          popup.appendChild(menu);
          let submenuPopup = document.createXULElement("menupopup");
          menu.appendChild(submenuPopup);
          addMenuitems(item.submenu, submenuPopup);
          break;
        }
      case "action":
        {
          let menuitem = document.createXULElement("menuitem");
          translateMenuitem(item, menuitem);
          menuitem.config = item;
          if (item.id) {
            menuitem.value = item.id;
          }
          if (item.icon) {
            menuitem.classList.add("menuitem-iconic");
            menuitem.setAttribute("image", item.icon);
          }
          popup.appendChild(menuitem);
          break;
        }
    }
  }
}
const SubmenuButtonInner = ({
  content,
  handleAction,
  buttonType = "submenu"
}) => {
  const ref = (0,external_React_namespaceObject.useRef)(null);
  const [isSubmenuExpanded, setIsSubmenuExpanded] = (0,external_React_namespaceObject.useState)(false);
  const hasDismissButton = content.dismiss_button;
  const buttonConfig = buttonType === "submenu" ? content.submenu_button : content.more_button;
  const isMoreButton = buttonType === "more";
  if (isMoreButton && hasDismissButton) {
    return null;
  }
  const isPrimary = buttonConfig?.style === "primary";
  const submenuItems = buttonConfig?.submenu || [];
  const buttonId = isMoreButton ? "more_button" : "submenu_button";
  const buttonValue = isMoreButton ? "more_button" : "submenu_button";
  const buttonClassName = isMoreButton ? "more-button" : `submenu-button ${isPrimary ? "primary" : "secondary"}`;
  const onCommand = (0,external_React_namespaceObject.useCallback)(event => {
    let {
      config
    } = event.target;
    let mockEvent = {
      currentTarget: ref.current,
      source: config.id,
      name: "command",
      action: config.action
    };
    handleAction(mockEvent);
  }, [handleAction]);
  const onClick = (0,external_React_namespaceObject.useCallback)(() => {
    let button = ref.current;
    let submenu = button?.querySelector(".fxms-multi-stage-submenu");
    if (submenu && !button.hasAttribute("open")) {
      submenu.openPopup(button, {
        position: "after_end"
      });
    }
  }, []);
  (0,external_React_namespaceObject.useEffect)(() => {
    let button = ref.current;
    if (!button || button.querySelector(".fxms-multi-stage-submenu")) {
      return null;
    }
    let menupopup = document.createXULElement("menupopup");
    menupopup.className = "fxms-multi-stage-submenu";
    addMenuitems(submenuItems, menupopup);
    button.appendChild(menupopup);
    let stylesheet;
    if (!document.head.querySelector(`link[href="chrome://global/content/widgets.css"], link[href="chrome://global/skin/global.css"]`)) {
      stylesheet = document.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = "chrome://global/content/widgets.css";
      document.head.appendChild(stylesheet);
    }
    if (!menupopup.listenersRegistered) {
      menupopup.addEventListener("command", onCommand);
      menupopup.addEventListener("popupshowing", event => {
        if (event.target === menupopup && event.target.anchorNode) {
          event.target.anchorNode.toggleAttribute("open", true);
          setIsSubmenuExpanded(true);
        }
      });
      menupopup.addEventListener("popuphiding", event => {
        if (event.target === menupopup && event.target.anchorNode) {
          event.target.anchorNode.toggleAttribute("open", false);
          setIsSubmenuExpanded(false);
        }
      });
      menupopup.listenersRegistered = true;
    }
    return () => {
      menupopup?.remove();
      stylesheet?.remove();
    };
  }, [onCommand]); // eslint-disable-line react-hooks/exhaustive-deps

  // Don't render the button if there's no button config, or no items
  if (!buttonConfig || !submenuItems.length) {
    return null;
  }
  return /*#__PURE__*/external_React_default().createElement(Localized, {
    text: buttonConfig.label ?? {}
  }, /*#__PURE__*/external_React_default().createElement("button", {
    id: buttonId,
    className: buttonClassName,
    value: buttonValue,
    onClick: onClick,
    ref: ref,
    "aria-haspopup": "menu",
    "aria-expanded": isSubmenuExpanded,
    "aria-labelledby": !isMoreButton ? `${buttonConfig.attached_to || content.attached_to || ""} submenu_button`.trim() : null
  }));
};
;// ./content-src/components/AdditionalCTA.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */




const AdditionalCTA = ({
  content,
  handleAction,
  activeMultiSelect,
  textInputs
}) => {
  let buttonStyle = "";
  const isSplitButton = content.submenu_button?.attached_to === "additional_button";
  let className = "additional-cta-box";
  if (isSplitButton) {
    className += " split-button-container";
  }
  if (!content.additional_button?.style) {
    buttonStyle = "primary";
  } else {
    buttonStyle = content.additional_button?.style === "link" ? "cta-link" : content.additional_button?.style;
  }
  const computeDisabled = external_React_default().useCallback(disabledValue => {
    if (disabledValue === "hasActiveMultiSelect") {
      if (!activeMultiSelect) {
        return true;
      }
      for (const key in activeMultiSelect) {
        if (activeMultiSelect[key]?.length > 0) {
          return false;
        }
      }
      return true;
    }
    if (disabledValue === "hasTextInput") {
      // For text input, we check if the user has entered any text in the
      // textarea(s) present on the screen.
      if (!textInputs) {
        return true;
      }
      return Object.values(textInputs).every(input => !input.isValid || input.value.trim().length === 0);
    }
    return disabledValue;
  }, [activeMultiSelect, textInputs]);
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: className
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.additional_button?.label
  }, /*#__PURE__*/external_React_default().createElement("button", {
    id: "additional_button",
    className: `${buttonStyle} additional-cta`,
    onClick: handleAction,
    value: "additional_button",
    disabled: computeDisabled(content.additional_button?.disabled)
  })), isSplitButton ? /*#__PURE__*/external_React_default().createElement(SubmenuButton, {
    content: content,
    handleAction: handleAction
  }) : null);
};
;// ./content-src/components/LinkParagraph.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */



function renderSegment(segment, index, handleAction) {
  if (typeof segment === "string") {
    return segment;
  }
  if (segment?.href) {
    const action = {
      type: "OPEN_URL",
      data: {
        args: segment.href,
        where: segment.where || "tab"
      }
    };
    return /*#__PURE__*/external_React_default().createElement("a", {
      key: index,
      href: segment.href,
      className: "text-link",
      onClick: event => {
        event.preventDefault();
        handleAction(event, action);
      }
    }, /*#__PURE__*/external_React_default().createElement(Localized, {
      text: segment
    }, /*#__PURE__*/external_React_default().createElement("span", null)));
  }
  if (segment?.link_key) {
    return (
      /*#__PURE__*/
      // eslint-disable-next-line jsx-a11y/anchor-is-valid
      external_React_default().createElement("a", {
        key: index,
        value: segment.link_key,
        role: "link",
        className: "text-link",
        tabIndex: "0",
        onClick: handleAction,
        onKeyPress: event => {
          if (event.key === "Enter" && !event.repeat) {
            handleAction(event);
          }
        }
      }, /*#__PURE__*/external_React_default().createElement(Localized, {
        text: segment
      }, /*#__PURE__*/external_React_default().createElement("span", null)))
    );
  }
  return /*#__PURE__*/external_React_default().createElement(Localized, {
    key: index,
    text: segment
  }, /*#__PURE__*/external_React_default().createElement("span", null));
}
const LinkParagraph = props => {
  const {
    text_content,
    handleAction
  } = props;
  const text = text_content?.text;
  const handleParagraphAction = (0,external_React_namespaceObject.useCallback)(event => {
    const anchor = event.target.closest("a");
    if (anchor) {
      handleAction({
        ...event,
        currentTarget: anchor
      });
    }
  }, [handleAction]);
  const onKeyPress = (0,external_React_namespaceObject.useCallback)(event => {
    if (event.key === "Enter" && !event.repeat) {
      handleParagraphAction(event);
    }
  }, [handleParagraphAction]);
  const paragraphClassName = text_content?.font_styles === "legal" ? "legal-paragraph" : "link-paragraph";
  if (Array.isArray(text)) {
    const style = {};
    for (const styleProp of CONFIGURABLE_STYLES) {
      if (text_content[styleProp] !== undefined) {
        style[styleProp] = text_content[styleProp];
      }
    }
    return /*#__PURE__*/external_React_default().createElement("p", {
      className: paragraphClassName,
      style: style
    }, text.map((segment, index) => renderSegment(segment, index, handleAction)));
  }
  return /*#__PURE__*/external_React_default().createElement(Localized, {
    text: text
  }, /*#__PURE__*/external_React_default().createElement("p", {
    className: paragraphClassName,
    onClick: handleParagraphAction,
    value: "link_paragraph",
    onKeyPress: onKeyPress
  }, text_content.link_keys?.map(link => /*#__PURE__*/external_React_default().createElement("a", {
    key: link,
    value: link,
    role: "link",
    className: "text-link",
    "data-l10n-name": link
    // must pass in tabIndex when no href is provided
    ,
    tabIndex: "0"
  }, " "))));
};
;// ./content-src/components/InstallButton.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */



const Loader = () => {
  return /*#__PURE__*/external_React_default().createElement("button", {
    className: "primary"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "loaderContainer"
  }, /*#__PURE__*/external_React_default().createElement("span", {
    className: "loader"
  })));
};
const InstallButton = props => {
  // determine if the addon is already installed so the state is
  // consistent on refresh or navigation
  const [installing, setInstalling] = (0,external_React_namespaceObject.useState)(false);
  const [installComplete, setInstallComplete] = (0,external_React_namespaceObject.useState)(false);
  const defaultInstallLabel = {
    string_id: "amo-picker-install-button-label"
  };
  function getDefaultInstallCompleteLabel(addonType = "") {
    let defaultInstallCompleteLabel;
    if (addonType && addonType === "theme") {
      defaultInstallCompleteLabel = {
        string_id: "return-to-amo-theme-install-complete-label"
      };
    } else if (addonType && addonType === "extension") {
      defaultInstallCompleteLabel = {
        string_id: "return-to-amo-extension-install-complete-label"
      };
    } else {
      defaultInstallCompleteLabel = {
        string_id: "amo-picker-install-complete-label"
      };
    }
    return defaultInstallCompleteLabel;
  }
  (0,external_React_namespaceObject.useEffect)(() => {
    setInstallComplete(props.installedAddons?.includes(props.addonId));
  }, [props.addonId, props.installedAddons]);
  let buttonLabel = installComplete ? props.install_complete_label || getDefaultInstallCompleteLabel(props.addonType) : props.install_label || defaultInstallLabel;
  function onClick(event) {
    props.handleAction(event);
    // Replace the label with the spinner
    setInstalling(true);
    window.AWEnsureAddonInstalled(props.addonId).then(value => {
      if (value === "complete") {
        // Set the label to "Installed"
        setInstallComplete(true);
      }
      // Whether the addon installs or not, we want to remove the spinner
      setInstalling(false);
    });
  }
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "install-button-wrapper"
  }, installing ? /*#__PURE__*/external_React_default().createElement(Loader, null) : /*#__PURE__*/external_React_default().createElement(Localized, {
    text: buttonLabel
  }, /*#__PURE__*/external_React_default().createElement("button", {
    id: `install-button-${props.addonId}`,
    value: props.index,
    onClick: onClick,
    disabled: installComplete,
    className: "primary",
    "data-l10n-args": JSON.stringify({
      "addon-name": props.addonName ?? ""
    })
  })));
};
;// ./content-src/components/AddonsPicker.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */





const AddonsPicker = props => {
  const {
    content,
    installedAddons,
    layout,
    handleAction
  } = props;
  if (!content) {
    return null;
  }
  function handleInstallClick(event) {
    const {
      message_id
    } = props;
    let {
      action,
      source_id
    } = content.tiles.data[event.currentTarget.value];
    if (action.type === "INSTALL_ADDON_FROM_URL") {
      if (!action.data) {
        return;
      }
    }
    handleAction(event, action);
    MultiStageUtils.sendActionTelemetry(message_id, source_id, "CLICK_BUTTON");
  }
  function handleAuthorClick(event, authorId) {
    event.stopPropagation();
    MultiStageUtils.handleUserAction({
      type: "OPEN_URL",
      data: {
        args: `https://addons.mozilla.org/firefox/user/${authorId}/`,
        where: "tab"
      }
    });
  }
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "addons-picker-container"
  }, content.tiles.data.map(({
    id,
    name: addonName,
    type,
    description,
    icon,
    author,
    install_label,
    install_complete_label
  }, index) => addonName ? /*#__PURE__*/external_React_default().createElement("div", {
    key: id,
    className: "addon-container"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "rtamo-icon"
  }, /*#__PURE__*/external_React_default().createElement("img", {
    className: `${type === "theme" ? "rtamo-theme-icon" : "brand-logo"}`,
    src: icon,
    role: "presentation",
    alt: ""
  })), layout === "split" ? /*#__PURE__*/external_React_default().createElement("div", {
    className: "addon-rows-container"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "addon-row"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "addon-author-details"
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: addonName
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "addon-title"
  })), author && /*#__PURE__*/external_React_default().createElement("div", {
    className: "addon-author"
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: author.byLine
  }, /*#__PURE__*/external_React_default().createElement("span", {
    className: "addon-by-line"
  })), /*#__PURE__*/external_React_default().createElement("button", {
    href: "#",
    onClick: e => {
      handleAuthorClick(e, author.id);
    },
    className: "author-link"
  }, /*#__PURE__*/external_React_default().createElement("span", null, author.name)))), /*#__PURE__*/external_React_default().createElement(InstallButton, {
    key: id,
    addonId: id,
    handleAction: handleInstallClick,
    index: index,
    installedAddons: installedAddons,
    install_label: install_label,
    install_complete_label: install_complete_label
  })), /*#__PURE__*/external_React_default().createElement("div", {
    className: "addon-row"
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: description
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "addon-description"
  })))) : /*#__PURE__*/external_React_default().createElement((external_React_default()).Fragment, null, /*#__PURE__*/external_React_default().createElement("div", {
    className: "addon-details"
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: addonName
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "addon-title"
  })), /*#__PURE__*/external_React_default().createElement(Localized, {
    text: description
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "addon-description"
  }))), /*#__PURE__*/external_React_default().createElement(InstallButton, {
    key: id,
    addonId: id,
    handleAction: handleInstallClick,
    index: index,
    installedAddons: installedAddons,
    install_label: install_label,
    install_complete_label: install_complete_label
  }))) : null));
};
;// ./content-src/components/TileButton.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */



const TileButton = props => {
  const {
    content,
    handleAction,
    inputName
  } = props;
  const ref = (0,external_React_namespaceObject.useRef)(null);
  if (!content) {
    return null;
  }
  function onClick(event) {
    let mockEvent = {
      currentTarget: ref.current,
      source: event.target.id,
      name: "command",
      action: content.action
    };
    handleAction(mockEvent);
  }
  return /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.label
  }, /*#__PURE__*/external_React_default().createElement("button", {
    id: `tile-button-${inputName}`,
    onClick: onClick,
    value: "tile_button",
    ref: ref,
    className: `${content.style} tile-button slim`
  }));
};
;// ./content-src/components/TileList.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */




const TileList = props => {
  const {
    content
  } = props;
  if (!content) {
    return null;
  }
  const CONFIGURABLE_STYLES = ["background", "borderRadius", "height", "marginBlock", "marginBlockStart", "marginBlockEnd", "marginInline", "paddingBlock", "paddingBlockStart", "paddingBlockEnd", "paddingInline", "paddingInlineStart", "paddingInlineEnd", "width"];
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "tile-list-container"
  }, content.items.map(({
    icon,
    text
  }, index) => /*#__PURE__*/external_React_default().createElement("div", {
    key: index,
    className: "tile-list-item"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "tile-list-icon-wrapper"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "tile-list-icon",
    style: MultiStageUtils.getValidStyle(icon, CONFIGURABLE_STYLES)
  })), /*#__PURE__*/external_React_default().createElement("div", {
    className: "tile-list-text"
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: text
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "text body-text"
  }))))));
};
;// ./content-src/components/SingleSelect.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */







// This component was formerly "Themes" and continues to support theme
const SingleSelect = ({
  activeSingleSelectSelections = {},
  // This now holds all active selections keyed by `singleSelectId`
  activeTheme,
  content,
  handleAction,
  setActiveSingleSelectSelection,
  singleSelectId
}) => {
  const category = content.tiles?.category?.type || content.tiles?.type;
  const className = ["tiles-single-select-section", category, content.tiles?.class_name, content.tiles?.className].filter(Boolean).join(" ");
  const isSingleSelect = category === "single-select";
  const autoTriggerAllowed = itemAction => {
    // Currently only enabled for sidebar experiment prefs
    const allowedActions = ["SET_PREF"];
    const allowedPrefs = ["sidebar.revamp", "sidebar.verticalTabs", "sidebar.visibility"];
    const checkAction = action => {
      if (!allowedActions.includes(action.type)) {
        return false;
      }
      if (action.type === "SET_PREF" && !allowedPrefs.includes(action.data?.pref.name)) {
        return false;
      }
      return true;
    };
    if (itemAction.type === "MULTI_ACTION") {
      // Only allow autoTrigger if all actions are allowed
      return !itemAction.data.actions.some(action => !checkAction(action));
    }
    return checkAction(itemAction);
  };

  // When screen renders for first time or user navigates back, update state to
  // check default option.
  (0,external_React_namespaceObject.useEffect)(() => {
    if (isSingleSelect && !activeSingleSelectSelections[singleSelectId]) {
      let newActiveSingleSelect = content.tiles?.selected || content.tiles?.data[0].id;
      setActiveSingleSelectSelection(newActiveSingleSelect, singleSelectId);
      let selectedTile = content.tiles?.data.find(opt => opt.id === newActiveSingleSelect);
      // If applicable, automatically trigger the action for the default
      // selected tile.
      if (isSingleSelect && content.tiles?.autoTrigger && autoTriggerAllowed(selectedTile?.action)) {
        handleAction({
          currentTarget: {
            value: selectedTile.id
          }
        });
      }
    }
  }, [activeSingleSelectSelections]); // eslint-disable-line react-hooks/exhaustive-deps

  const CONFIGURABLE_STYLES = ["background", "borderRadius", "height", "marginBlock", "marginBlockStart", "marginBlockEnd", "marginInline", "paddingBlock", "paddingBlockStart", "paddingBlockEnd", "paddingInline", "paddingInlineStart", "paddingInlineEnd", "width"];
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: `tiles-single-select-container`
  }, /*#__PURE__*/external_React_default().createElement("div", null, /*#__PURE__*/external_React_default().createElement("fieldset", {
    className: className
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.tiles?.legend || content.tiles?.subtitle || content.subtitle
  }, /*#__PURE__*/external_React_default().createElement("legend", {
    className: "sr-only"
  })), content.tiles.data.map(({
    description,
    inert,
    icon,
    id,
    label = "",
    body = "",
    subtitle = "",
    theme,
    tooltip,
    type = "",
    flair,
    style,
    tilebutton
  }) => {
    const value = id || theme;
    let inputName = singleSelectId;
    if (!isSingleSelect) {
      inputName = category === "theme" ? "theme" : id; // unique names per item are currently used in the wallpaper picker
    }
    const selected = theme && theme === activeTheme || isSingleSelect && activeSingleSelectSelections[singleSelectId] === value;
    const valOrObj = val => typeof val === "object" ? val : {};
    const handleClick = evt => {
      if (isSingleSelect) {
        setActiveSingleSelectSelection(value, singleSelectId); // Update selection for the specific component
      }
      handleAction(evt);
    };
    const handleKeyDown = evt => {
      if (evt.key === "Enter" || evt.keyCode === 13) {
        // Set target value to the input inside of the selected label
        evt.currentTarget.value = value;
        handleClick(evt);
      }
    };
    return /*#__PURE__*/external_React_default().createElement(Localized, {
      key: value + (isSingleSelect ? "" : label),
      text: valOrObj(tooltip)
    }, /*#__PURE__*/external_React_default().createElement("label", {
      className: `select-item ${type}`,
      onKeyDown: e => handleKeyDown(e),
      style: {
        ...MultiStageUtils.getValidStyle(style, CONFIGURABLE_STYLES),
        ...(icon?.width ? {
          minWidth: icon.width
        } : {})
      }
    }, flair ? /*#__PURE__*/external_React_default().createElement(Localized, {
      text: valOrObj(flair.text)
    }, /*#__PURE__*/external_React_default().createElement("span", {
      className: `flair ${flair.centered ? "centered" : ""} ${flair.spacer ? "spacer" : ""} ${type}`
    })) : "", /*#__PURE__*/external_React_default().createElement(Localized, {
      text: valOrObj(description)
    }, /*#__PURE__*/external_React_default().createElement("input", {
      type: "radio",
      value: value,
      name: inputName,
      checked: selected,
      className: "sr-only input",
      disabled: inert,
      onClick: e => handleClick(e)
    })), /*#__PURE__*/external_React_default().createElement("div", {
      className: `icon ${selected ? " selected" : ""} ${value}`,
      style: MultiStageUtils.getValidStyle(icon, CONFIGURABLE_STYLES)
    }), /*#__PURE__*/external_React_default().createElement(Localized, {
      text: label
    }, /*#__PURE__*/external_React_default().createElement("div", {
      className: "text label-text"
    })), body.items ? /*#__PURE__*/external_React_default().createElement(TileList, {
      content: body
    }) : /*#__PURE__*/external_React_default().createElement(Localized, {
      text: body
    }, /*#__PURE__*/external_React_default().createElement("div", {
      className: "text body-text"
    })), subtitle && selected ? /*#__PURE__*/external_React_default().createElement(Localized, {
      text: subtitle
    }, /*#__PURE__*/external_React_default().createElement("div", {
      className: "text subtitle-text"
    })) : "", tilebutton ? /*#__PURE__*/external_React_default().createElement(TileButton, {
      content: tilebutton,
      handleAction: handleAction,
      inputName: `${singleSelectId}-${value}`
    }) : ""));
  }))));
};
;// ./content-src/components/MobileDownloads.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */




const MarketplaceButtons = props => {
  return /*#__PURE__*/external_React_default().createElement("ul", {
    className: "mobile-download-buttons"
  }, props.buttons.includes("ios") ? /*#__PURE__*/external_React_default().createElement("li", {
    className: "ios"
  }, /*#__PURE__*/external_React_default().createElement("button", {
    "data-l10n-id": "spotlight-ios-marketplace-button",
    value: "ios",
    onClick: props.handleAction
  })) : null, props.buttons.includes("android") ? /*#__PURE__*/external_React_default().createElement("li", {
    className: "android"
  }, /*#__PURE__*/external_React_default().createElement("button", {
    "data-l10n-id": "spotlight-android-marketplace-button",
    value: "android",
    onClick: props.handleAction
  })) : null);
};
const MobileDownloads = props => {
  const {
    QR_code: QRCode
  } = props.data;
  const showEmailLink = props.data.email && window.AWSendToDeviceEmailsSupported();
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "mobile-downloads"
  }, QRCode ? /*#__PURE__*/external_React_default().createElement("img", {
    "data-l10n-id": QRCode.alt_text.string_id ? QRCode.alt_text.string_id : null,
    className: "qr-code-image",
    alt: typeof QRCode.alt_text === "string" ? QRCode.alt_text : "",
    src: QRCode.image_url,
    loading: MultiStageUtils.getLoadingStrategyFor(QRCode.image_url)
  }) : null, showEmailLink ? /*#__PURE__*/external_React_default().createElement("div", null, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: props.data.email.link_text
  }, /*#__PURE__*/external_React_default().createElement("button", {
    className: "email-link",
    value: "email_link",
    onClick: props.handleAction
  }))) : null, props.data.marketplace_buttons ? /*#__PURE__*/external_React_default().createElement(MarketplaceButtons, {
    buttons: props.data.marketplace_buttons,
    handleAction: props.handleAction
  }) : null);
};
;// ./content-src/components/MultiSelect.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */




const MULTI_SELECT_STYLES = [...CONFIGURABLE_STYLES, "flexDirection", "flexWrap", "flexFlow", "flexGrow", "flexShrink", "justifyContent", "alignItems", "gap"];
const TILE_STYLES = ["marginBlock", "marginInline", "paddingBlock", "paddingInline"];

// Do not include styles applied at the content tile level
for (let i = MULTI_SELECT_STYLES.length - 1; i >= 0; i--) {
  if (TILE_STYLES.includes(MULTI_SELECT_STYLES[i])) {
    MULTI_SELECT_STYLES.splice(i, 1);
  }
}
const MULTI_SELECT_ICON_STYLES = [...CONFIGURABLE_STYLES, "width", "height", "background", "backgroundColor", "backgroundImage", "backgroundSize", "backgroundPosition", "backgroundRepeat", "backgroundOrigin", "backgroundClip", "border", "borderRadius", "appearance", "fill", "stroke", "outline", "outlineOffset", "boxShadow"];
const MultiSelect = ({
  content,
  screenMultiSelects,
  setScreenMultiSelects,
  activeMultiSelect,
  setActiveMultiSelect,
  multiSelectId
}) => {
  const {
    data,
    multiSelectItemDesign
  } = content.tiles;
  const isPicker = multiSelectItemDesign === "picker";
  const refs = (0,external_React_namespaceObject.useRef)({});
  const handleChange = (0,external_React_namespaceObject.useCallback)(() => {
    const newActiveMultiSelect = [];
    Object.keys(refs.current).forEach(key => {
      if (refs.current[key]?.checked) {
        newActiveMultiSelect.push(key);
      }
    });
    setActiveMultiSelect(newActiveMultiSelect, multiSelectId);
  }, [setActiveMultiSelect, multiSelectId]);
  const items = (0,external_React_namespaceObject.useMemo)(() => {
    function getOrderedIds() {
      if (screenMultiSelects) {
        return screenMultiSelects;
      }
      let orderedIds = data.map(item => ({
        id: item.id,
        rank: item.randomize ? Math.random() : NaN
      })).sort((a, b) => b.rank - a.rank).map(({
        id
      }) => id);
      setScreenMultiSelects(orderedIds, multiSelectId);
      return orderedIds;
    }
    return getOrderedIds().map(id => data.find(item => item.id === id));
  }, [] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const containerStyle = (0,external_React_namespaceObject.useMemo)(() => MultiStageUtils.getTileStyle(content.tiles, MULTI_SELECT_STYLES), [content.tiles]);
  const PickerIcon = ({
    emoji,
    bgColor,
    isChecked
  }) => {
    return /*#__PURE__*/external_React_default().createElement("span", {
      className: `picker-icon ${isChecked ? "picker-checked" : ""}`,
      style: {
        ...(!isChecked && bgColor && {
          backgroundColor: bgColor
        })
      }
    }, !isChecked && emoji ? emoji : "");
  };

  // This handles interaction for when the user is clicking on or keyboard-interacting
  // with the container element when using the picker design. It is required
  // for appropriate accessibility.
  const handleCheckboxContainerInteraction = e => {
    if (!isPicker) {
      return;
    }
    if (e.type === "keydown") {
      // Prevent scroll on space presses
      if (e.key === " ") {
        e.preventDefault();
      }

      // Only handle space and enter keypresses
      if (e.key !== " " && e.key !== "Enter") {
        return;
      }
    }
    const container = e.currentTarget;
    // Manually flip the hidden checkbox since handleChange relies on it
    const checkbox = container.querySelector('input[type="checkbox"]');
    checkbox.checked = !checkbox.checked;

    // Manually call handleChange to update the multiselect state
    handleChange();
  };

  // When screen renders for first time, update state
  // with checkbox ids that has defaultvalue true
  (0,external_React_namespaceObject.useEffect)(() => {
    if (!activeMultiSelect) {
      let newActiveMultiSelect = [];
      items.forEach(({
        id,
        defaultValue
      }) => {
        if (defaultValue && id) {
          newActiveMultiSelect.push(id);
        }
      });
      setActiveMultiSelect(newActiveMultiSelect, multiSelectId);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return /*#__PURE__*/external_React_default().createElement("div", {
    className: `multi-select-container ${multiSelectItemDesign || ""}`,
    style: containerStyle,
    role: items.some(({
      type,
      group
    }) => type === "radio" && group) ? "radiogroup" : "group",
    "aria-labelledby": "multi-stage-multi-select-label"
  }, content.tiles.label ? /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.tiles.label
  }, /*#__PURE__*/external_React_default().createElement("h2", {
    id: "multi-stage-multi-select-label"
  })) : null, items.map(({
    id,
    label,
    description,
    icon,
    type = "checkbox",
    group,
    style,
    pickerEmoji,
    pickerEmojiBackgroundColor
  }) => /*#__PURE__*/external_React_default().createElement("div", {
    key: id + label,
    className: "checkbox-container multi-select-item",
    style: MultiStageUtils.getValidStyle(style, MULTI_SELECT_STYLES),
    tabIndex: isPicker ? "0" : null,
    onClick: isPicker ? handleCheckboxContainerInteraction : null,
    onKeyDown: isPicker ? handleCheckboxContainerInteraction : null,
    role: isPicker ? "checkbox" : null,
    "aria-checked": isPicker ? activeMultiSelect?.includes(id) : null
  }, /*#__PURE__*/external_React_default().createElement("input", {
    type: type // checkbox or radio
    ,
    id: id,
    value: id,
    name: group,
    checked: activeMultiSelect?.includes(id),
    style: MultiStageUtils.getValidStyle(icon?.style, MULTI_SELECT_ICON_STYLES),
    onChange: handleChange,
    ref: el => refs.current[id] = el,
    "aria-describedby": description ? `${id}-description` : null,
    "aria-labelledby": description ? `${id}-label` : null,
    tabIndex: isPicker ? "-1" : "0"
  }), isPicker && /*#__PURE__*/external_React_default().createElement(PickerIcon, {
    emoji: pickerEmoji,
    bgColor: pickerEmojiBackgroundColor,
    isChecked: activeMultiSelect?.includes(id)
  }), label ? /*#__PURE__*/external_React_default().createElement(Localized, {
    text: label
  }, /*#__PURE__*/external_React_default().createElement("label", {
    id: `${id}-label`,
    htmlFor: id
  })) : null, description ? /*#__PURE__*/external_React_default().createElement(Localized, {
    text: description
  }, /*#__PURE__*/external_React_default().createElement("p", {
    id: `${id}-description`
  })) : null)), content.tiles.footer ? /*#__PURE__*/external_React_default().createElement(Localized, {
    text: items.some(i => activeMultiSelect?.includes(i.id)) ? content.tiles.footer.checkedLabel : content.tiles.footer.unCheckAllLabel
  }, /*#__PURE__*/external_React_default().createElement("h2", {
    id: "multi-stage-multi-select-footer-label"
  })) : null);
};
;// ./content-src/components/TextAreaTile.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */



const TextAreaTile_CONFIGURABLE_STYLES = ["color", "display", "fontSize", "fontWeight", "letterSpacing", "lineHeight", "marginBlock", "marginInline", "paddingBlock", "paddingInline", "textAlign", "whiteSpace", "width", "border", "borderRadius", "minHeight", "minWidth"];
const TextAreaTile = ({
  content,
  textInputs,
  setTextInput,
  tileIndex
}) => {
  const {
    data
  } = content.tiles;
  const id = data.id || `tile-${tileIndex}`;
  const [isValid, setIsValid] = (0,external_React_namespaceObject.useState)(true);
  const [charCounter, setCharCounter] = (0,external_React_namespaceObject.useState)(data.character_limit || 0);
  const textInput = (0,external_React_namespaceObject.useMemo)(() => {
    if (textInputs) {
      return textInputs?.[id];
    }
    return null;
  }, [textInputs, id]);
  const handleChange = (0,external_React_namespaceObject.useCallback)(event => {
    let valid = isValid;
    if (data.character_limit) {
      setCharCounter(data.character_limit - event.target.value.length);
      valid = event.target.value.length <= data.character_limit;
    }
    setIsValid(valid);
    setTextInput({
      value: event.target.value,
      isValid: valid
    }, id);
  }, [isValid, data.character_limit, id, setTextInput]);
  (0,external_React_namespaceObject.useEffect)(() => {
    if (!textInput) {
      setTextInput({
        value: "",
        isValid: true
      }, id);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "textarea-container",
    style: MultiStageUtils.getValidStyle(data.container_style, TextAreaTile_CONFIGURABLE_STYLES, true)
  }, data.character_limit && /*#__PURE__*/external_React_default().createElement("div", {
    className: `textarea-char-counter ${isValid ? "" : "invalid"}`,
    style: MultiStageUtils.getValidStyle(data.char_counter_style, TextAreaTile_CONFIGURABLE_STYLES, true)
  }, charCounter), /*#__PURE__*/external_React_default().createElement("textarea", {
    name: id,
    className: `textarea-input ${isValid ? "" : "invalid"}`,
    rows: data.rows,
    cols: data.cols,
    onChange: handleChange,
    value: textInput?.value || "",
    placeholder: data.placeholder,
    style: MultiStageUtils.getValidStyle(data.textarea_style, TextAreaTile_CONFIGURABLE_STYLES, true)
  }));
};
;// ./content-src/components/EmbeddedMigrationWizard.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */



/**
 * Embeds a migration wizard component within About:Welcome,
 * and passes configuration options from content to the migration-wizard element
 *
 * @param {function} handleAction - The action handler function that processes migration events
 * @param {object} content - The content object that contains tiles configuration
 * @param {object} content.tiles - The tiles configuration object
 * @param {object} content.tiles.migration_wizard_options - Configuration options for the migration wizard
 *   All options, including migration_wizard_options itself, are optional and have fallback values:
 *   - {boolean} force_show_import_all - Whether to force show import all option
 *   - {string} option_expander_title_string - Title string for the option expander
 *   - {boolean} hide_option_expander_subtitle - Whether or not to hide the option expander subtitle
 *   - {string} data_import_complete_success_string - Success message string after import completion
 *   - {string} migrator_key - The migrator key to select by default
 *   - {string} selection_header_string - Header string for the selection section
 *   - {string} selection_subheader_string - Subheader string for the selection section
 *   - {boolean} hide_select_all - Whether to hide the select all option
 *   - {string} checkbox_margin_inline - Inline margin for checkboxes
 *   - {string} checkbox_margin_block - Block margin for checkboxes
 *   - {string} import_button_string - Text string for the import button
 *   - {string} import_button_class - CSS class for the import button
 *   - {string} header_font_size - Font size for the header
 *   - {string} header_font_weight - Font weight for the header
 *   - {string} header_margin_block - Block margin for the header
 *   - {string} subheader_font_size - Font size for the subheader
 *   - {string} subheader_font_weight - Font weight for the subheader
 *   - {string} subheader_margin_block - Block margin for the subheader
 */
const EmbeddedMigrationWizard = ({
  handleAction,
  content
}) => {
  const ref = (0,external_React_namespaceObject.useRef)();
  const options = content.tiles?.migration_wizard_options;
  (0,external_React_namespaceObject.useEffect)(() => {
    const handleBeginMigration = () => {
      handleAction({
        currentTarget: {
          value: "migrate_start"
        },
        source: "primary_button"
      });
    };
    const handleClose = () => {
      handleAction({
        currentTarget: {
          value: "migrate_close"
        }
      });
    };
    const {
      current
    } = ref;
    current?.addEventListener("MigrationWizard:BeginMigration", handleBeginMigration);
    current?.addEventListener("MigrationWizard:Close", handleClose);
    return () => {
      current?.removeEventListener("MigrationWizard:BeginMigration", handleBeginMigration);
      current?.removeEventListener("MigrationWizard:Close", handleClose);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return /*#__PURE__*/external_React_default().createElement("migration-wizard", {
    "in-aboutwelcome-bundle": "",
    "force-show-import-all": options?.force_show_import_all || "false",
    "auto-request-state": "",
    ref: ref,
    "option-expander-title-string": options?.option_expander_title_string ?? null,
    "hide-option-expander-subtitle": options?.hide_option_expander_subtitle || false,
    "data-import-complete-success-string": options?.data_import_complete_success_string || "",
    "migrator-key": options?.migrator_key || "",
    "selection-header-string": options?.selection_header_string || "",
    "selection-subheader-string": options?.selection_subheader_string || "",
    "hide-select-all": options?.hide_select_all || false,
    "checkbox-margin-inline": options?.checkbox_margin_inline || "",
    "checkbox-margin-block": options?.checkbox_margin_block || "",
    "import-button-string": options?.import_button_string || "",
    "import-button-class": options?.import_button_class || "",
    "header-font-size": options?.header_font_size || "",
    "header-font-weight": options?.header_font_weight || "",
    "header-margin-block": options?.header_margin_block || "",
    "subheader-font-size": options?.subheader_font_size || "",
    "subheader-font-weight": options?.subheader_font_weight || "",
    "subheader-margin-block": options?.subheader_margin_block || ""
  });
};
;// ./content-src/components/EmbeddedFxBackupOptIn.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */


const EmbeddedFxBackupOptIn = ({
  handleAction,
  isEncryptedBackup,
  options,
  messageId
}) => {
  const backupRef = (0,external_React_namespaceObject.useRef)(null);
  const {
    // hide_password_input means it is the file chooser screen
    hide_password_input,
    hide_secondary_button,
    file_path_label,
    turn_on_backup_header,
    create_password_label,
    turn_on_backup_confirm_btn_label,
    turn_on_backup_cancel_btn_label
  } = options || {};
  (0,external_React_namespaceObject.useEffect)(() => {
    const {
      current
    } = backupRef;
    const handleEnableScheduledBackups = () => {
      handleAction({
        currentTarget: {
          value: "tile_button"
        },
        action: {
          navigate: true
        },
        source: "backup_enabled"
      });
    };
    const handleAdvanceScreens = () => {
      handleAction({
        currentTarget: {
          value: "tile_button"
        },
        action: {
          navigate: true
        },
        source: "advance_screens"
      });
    };
    const handleStateUpdate = ({
      detail: {
        state
      }
    }) => {
      if (!current || !state) {
        return;
      }
      let {
        fileName,
        path,
        iconURL
      } = state.defaultParent;
      current.setAttribute("defaultlabel", fileName);
      current.setAttribute("defaultpath", path);
      current.setAttribute("defaulticonurl", iconURL);
      current.supportBaseLink = state.supportBaseLink;
    };
    current?.addEventListener("BackupUI:StateWasUpdated", handleStateUpdate);
    current?.addEventListener("BackupUI:EnableScheduledBackups", handleEnableScheduledBackups);
    current?.addEventListener("SpotlightOnboardingAdvanceScreens", handleAdvanceScreens);
    return () => {
      current?.removeEventListener("BackupUI:EnableScheduledBackups", handleEnableScheduledBackups);
      current?.removeEventListener("BackupUI:StateWasUpdated", handleStateUpdate);
      current?.removeEventListener("SpotlightOnboardingAdvanceScreens", handleAdvanceScreens);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return /*#__PURE__*/external_React_default().createElement("turn-on-scheduled-backups", {
    ref: backupRef,
    source: messageId,
    "hide-headers": "",
    "hide-password-input": !isEncryptedBackup || hide_password_input ? "" : undefined,
    "hide-secondary-button": !isEncryptedBackup || hide_secondary_button ? "" : undefined,
    "hide-file-path-chooser": isEncryptedBackup && !hide_password_input ? "" : undefined,
    "embedded-fx-backup-opt-in": "",
    "backup-is-encrypted": isEncryptedBackup ? "" : undefined,
    "file-path-label-l10n-id": file_path_label,
    "turn-on-backup-header-l10n-id": turn_on_backup_header,
    "create-password-label-l10n-id": create_password_label,
    "turn-on-backup-confirm-btn-l10n-id": turn_on_backup_confirm_btn_label,
    "turn-on-backup-cancel-btn-l10n-id": turn_on_backup_cancel_btn_label
  });
};
;// ./content-src/components/ActionChecklist.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */




async function evaluateTargeting(targeting) {
  return await window.AWEvaluateAttributeTargeting(targeting);
}
const ActionChecklistItem = ({
  item,
  index,
  handleAction,
  showExternalLinkIcon
}) => {
  const [actionTargeting, setActionTargeting] = (0,external_React_namespaceObject.useState)(true);
  (0,external_React_namespaceObject.useEffect)(() => {
    const setInitialTargetingValue = async () => {
      setActionTargeting(await evaluateTargeting(item.targeting));
    };
    setInitialTargetingValue();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function onButtonClick(event) {
    // Immediately set targeting to true to disable the button.
    // It will re-evaluate its targeting on the next load.
    setActionTargeting(true);
    handleAction(event);
  }
  return (
    /*#__PURE__*/
    // if actionTargeting is false, we want the button to be enabled
    // because it signifies that the action is not yet complete.
    // If it is true, the action has been completed, so we can disable the button.
    external_React_default().createElement("button", {
      id: item.id,
      value: index,
      key: item.id,
      disabled: actionTargeting,
      onClick: onButtonClick
    }, /*#__PURE__*/external_React_default().createElement("div", {
      className: "action-checklist-label-container"
    }, /*#__PURE__*/external_React_default().createElement("div", {
      className: "check-icon-container"
    }, actionTargeting ? /*#__PURE__*/external_React_default().createElement("div", {
      className: "check-filled"
    }) : /*#__PURE__*/external_React_default().createElement("div", {
      className: "check-empty"
    })), /*#__PURE__*/external_React_default().createElement(Localized, {
      text: item.label
    }, /*#__PURE__*/external_React_default().createElement("span", null))), !actionTargeting && showExternalLinkIcon && /*#__PURE__*/external_React_default().createElement("div", {
      className: "external-link-icon-container"
    }, /*#__PURE__*/external_React_default().createElement("div", {
      className: "external-link-icon"
    })))
  );
};
const ActionChecklistProgressBar = ({
  progress
}) => {
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "action-checklist-progress-bar"
  }, /*#__PURE__*/external_React_default().createElement("progress", {
    className: "sr-only",
    value: progress || 0,
    max: "100"
  }), /*#__PURE__*/external_React_default().createElement("div", {
    className: "indicator",
    role: "presentation",
    style: {
      "--action-checklist-progress-bar-progress": `${progress || 0}%`
    }
  }));
};
const ActionChecklist = ({
  content,
  message_id
}) => {
  const tiles = content.tiles.data;
  const [progressValue, setProgressValue] = (0,external_React_namespaceObject.useState)(0);
  const [numberOfCompletedActions, setNumberOfCompletedActions] = (0,external_React_namespaceObject.useState)(0);
  function determineProgressValue() {
    let newValue = numberOfCompletedActions / tiles.length * 100;
    setProgressValue(newValue);
  }

  // This instance of useEffect is to evaluate the targeting of each individual action
  // when the component is initially loaded so that we can accurately populate the progress bar.
  // We're doing the heavy lifting here once on load, and keeping the rest of the information
  // regarding how many actions are complete handy in state for quick access,
  // and a lesser performance hit.
  (0,external_React_namespaceObject.useEffect)(() => {
    let evaluateAllActionsTargeting = async () => {
      let completedActions = await Promise.all(tiles.map(async item => await evaluateTargeting(item.targeting)));
      let numCompletedActions = completedActions.filter(item => item).length;
      setNumberOfCompletedActions(numCompletedActions);
    };
    evaluateAllActionsTargeting();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // This instance of useEffect is to initially update the progress bar,
  // and to also update the progress bar each time an action is completed.
  (0,external_React_namespaceObject.useEffect)(() => {
    determineProgressValue();
  }, [numberOfCompletedActions]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleAction(event) {
    let {
      action,
      source_id
    } = content.tiles.data[event.currentTarget.value];
    let {
      type,
      data
    } = action;
    setNumberOfCompletedActions(numberOfCompletedActions + 1);
    MultiStageUtils.handleUserAction({
      type,
      data
    });
    MultiStageUtils.sendActionTelemetry(message_id, source_id, "CLICK_BUTTON");
  }
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "action-checklist"
  }, /*#__PURE__*/external_React_default().createElement("hr", {
    className: "action-checklist-divider"
  }), content.action_checklist_subtitle && /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.action_checklist_subtitle
  }, /*#__PURE__*/external_React_default().createElement("p", {
    className: "action-checklist-subtitle"
  })), /*#__PURE__*/external_React_default().createElement(ActionChecklistProgressBar, {
    progress: progressValue
  }), /*#__PURE__*/external_React_default().createElement("div", {
    className: "action-checklist-items"
  }, tiles.map((item, index) => /*#__PURE__*/external_React_default().createElement(ActionChecklistItem, {
    key: item.id,
    index: index,
    item: item,
    handleAction: handleAction,
    showExternalLinkIcon: item.showExternalLinkIcon
  }))));
};
;// ./content-src/components/EmbeddedBrowser.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */



const BROWSER_STYLES = ["height", "width", "border", "borderRadius", "flex", "margin", "padding"];
const EmbeddedBrowser = props => {
  // Conditionally render the component only if the environment supports XULElements (such as in Spotlight modals)
  return document.createXULElement && props.url ? /*#__PURE__*/external_React_default().createElement(EmbeddedBrowserInner, props) : null;
};
const EmbeddedBrowserInner = ({
  url,
  style
}) => {
  const ref = (0,external_React_namespaceObject.useRef)(null);
  const browserRef = (0,external_React_namespaceObject.useRef)(null);
  (0,external_React_namespaceObject.useEffect)(() => {
    if (!ref.current || browserRef.current) {
      return;
    }
    const browserEl = document.createXULElement("browser");
    const remoteType = window.AWPredictRemoteType({
      url
    });
    const attributes = [["disableglobalhistory", "true"], ["type", "content"], ["remote", "true"], ["maychangeremoteness", "true"], ["nodefaultsrc", "true"], ["remoteType", remoteType]];
    attributes.forEach(([attr, val]) => browserEl.setAttribute(attr, val));
    browserRef.current = browserEl;
    ref.current.appendChild(browserEl);
    // Initialize the browser element only once when the component mounts. The
    // empty dependency array ensures this effect runs only on the first render.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  (0,external_React_namespaceObject.useEffect)(() => {
    if (browserRef.current) {
      browserRef.current.fixupAndLoadURIString(url, {
        triggeringPrincipal: Services.scriptSecurityManager.createNullPrincipal({})
      });
    }
  }, [url]);
  (0,external_React_namespaceObject.useEffect)(() => {
    if (browserRef.current && style) {
      const validStyles = MultiStageUtils.getValidStyle(style, BROWSER_STYLES);
      Object.keys(validStyles).forEach(key => {
        browserRef.current.style.setProperty(key, style[key]);
      });
    }
  }, [style]);
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "embedded-browser-container",
    ref: ref
  });
};
/* harmony default export */ const components_EmbeddedBrowser = (EmbeddedBrowser);
;// ./content-src/components/ConfirmationChecklist.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public * License, v. 2.0. If a copy of the MPL was not distributed with this file, * You can obtain one at http://mozilla.org/MPL/2.0/. */




const ConfirmationChecklist = props => {
  const {
    content,
    handleAction
  } = props;
  if (!content) {
    return null;
  }
  const CONFIGURABLE_STYLES = ["background", "borderRadius", "display", "height", "marginBlock", "marginBlockStart", "marginBlockEnd", "marginInline", "paddingBlock", "paddingBlockStart", "paddingBlockEnd", "paddingInline", "paddingInlineStart", "paddingInlineEnd", "width"];
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: `confirmation-checklist-section`
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: `confirmation-checklist-container`,
    style: MultiStageUtils.getValidStyle(content.style, CONFIGURABLE_STYLES)
  }, content.items.map(({
    icon,
    text,
    subtext,
    link_keys
  }, index) => /*#__PURE__*/external_React_default().createElement("div", {
    key: index,
    className: "confirmation-checklist-item"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "confirmation-checklist-icon-wrapper"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "confirmation-checklist-icon",
    style: MultiStageUtils.getValidStyle(icon, CONFIGURABLE_STYLES)
  }), /*#__PURE__*/external_React_default().createElement("div", {
    className: "confirmation-checklist-text"
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: text
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "text body-text"
  })))), /*#__PURE__*/external_React_default().createElement("div", {
    className: "confirmation-checklist-subtext"
  }, /*#__PURE__*/external_React_default().createElement(LinkParagraph, {
    text_content: {
      text: subtext,
      link_keys
    },
    handleAction: handleAction
  }))))));
};
;// ./content-src/components/EmbeddedBackupRestore.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */




const EmbeddedBackupRestore = ({
  handleAction,
  skipButton
}) => {
  const [recoveryInProgress, setRecoveryInProgress] = (0,external_React_namespaceObject.useState)(false);
  const ref = (0,external_React_namespaceObject.useRef)(null);
  (0,external_React_namespaceObject.useEffect)(() => {
    const loadRestore = async () => {
      await window.AWFindBackupsInWellKnownLocations?.({
        validateFile: true,
        multipleFiles: true
      });
    };
    loadRestore();
    // Clear the pref used to target the restore screen so that users will not
    // automatically see it again the next time they visit about:welcome.
    MultiStageUtils.handleUserAction({
      type: "SET_PREF",
      data: {
        pref: {
          name: "showRestoreFromBackup",
          value: false
        }
      }
    });
  }, []);
  const onRecoveryProgressChange = (0,external_React_namespaceObject.useCallback)(e => {
    setRecoveryInProgress(e.detail.recoveryInProgress);
  }, []);
  (0,external_React_namespaceObject.useEffect)(() => {
    const backupRef = ref.current;
    if (backupRef.backupServiceState) {
      setRecoveryInProgress(backupRef.backupServiceState.recoveryInProgress);
    }
    backupRef.addEventListener("BackupUI:RecoveryProgress", onRecoveryProgressChange);
    return () => {
      backupRef.removeEventListener("BackupUI:RecoveryProgress", onRecoveryProgressChange);
    };
  }, [onRecoveryProgressChange]);
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "embedded-backup-restore-container"
  }, /*#__PURE__*/external_React_default().createElement("restore-from-backup", {
    aboutWelcomeEmbedded: "true",
    labelFontWeight: "600",
    ref: ref
  }), skipButton ? /*#__PURE__*/external_React_default().createElement("div", {
    className: "action-buttons"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "secondary-cta"
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: skipButton.label
  }, /*#__PURE__*/external_React_default().createElement("button", {
    id: "secondary_button",
    className: skipButton?.has_arrow_icon ? "secondary arrow-icon" : "secondary",
    value: "skip_button",
    disabled: recoveryInProgress,
    "aria-busy": recoveryInProgress || undefined,
    onClick: handleAction
  })))) : null);
};
;// ./content-src/components/PinnableSitesList.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */





// Per-item button states.
const IDLE = "idle";
const PENDING = "pending";
const PINNED = "pinned";
const PinnableSitesList = ({
  tile,
  messageId,
  handleAction
}) => {
  const items = tile?.data;
  const pinButtonLabel = tile?.pinButtonLabel;
  const [itemStates, setItemStates] = (0,external_React_namespaceObject.useState)(() => Object.fromEntries((items ?? []).map(item => [item.id, IDLE])));
  if (!items?.length) {
    return null;
  }
  const setItemState = (id, state) => setItemStates(prev => ({
    ...prev,
    [id]: state
  }));
  const handlePin = async (event, item) => {
    setItemState(item.id, PENDING);
    MultiStageUtils.sendActionTelemetry(messageId, item.id, "CLICK_BUTTON");
    const result = await handleAction(event, {
      type: "PIN_TASKBAR_TAB",
      needsAwait: true,
      data: {
        url: item.url,
        name: item.name,
        iconUrl: item.iconUrl
      }
    });
    let pinResultLabel;
    if (result === true) {
      pinResultLabel = "success";
    } else if (result === null) {
      pinResultLabel = "already_pinned";
    } else {
      pinResultLabel = "failure";
    }
    MultiStageUtils.sendActionTelemetry(messageId, item.id, "PIN_SITE", {
      result: pinResultLabel
    });

    // Re-enable the button only on explicit failure so the user can retry.
    setItemState(item.id, result === false ? IDLE : PINNED);
  };
  return /*#__PURE__*/external_React_default().createElement("ul", {
    className: "pinnable-sites-list"
  }, items.map(item => {
    const nameId = `pinnable-site-name-${item.id}`;
    const state = itemStates[item.id] ?? IDLE;
    const isPendingOrPinned = state === PENDING || state === PINNED;
    return /*#__PURE__*/external_React_default().createElement("li", {
      key: item.id,
      className: "pinnable-sites-item"
    }, /*#__PURE__*/external_React_default().createElement("img", {
      className: "pinnable-sites-icon",
      src: item.iconUrl,
      alt: ""
    }), /*#__PURE__*/external_React_default().createElement("div", {
      className: "pinnable-sites-text"
    }, /*#__PURE__*/external_React_default().createElement(Localized, {
      text: item.title ?? item.name
    }, /*#__PURE__*/external_React_default().createElement("span", {
      id: nameId,
      className: "pinnable-sites-name"
    })), item.description && /*#__PURE__*/external_React_default().createElement(Localized, {
      text: item.description
    }, /*#__PURE__*/external_React_default().createElement("span", {
      className: "pinnable-sites-description"
    }))), /*#__PURE__*/external_React_default().createElement("button", {
      className: "pinnable-sites-pin-button primary",
      disabled: isPendingOrPinned,
      onClick: e => handlePin(e, item),
      "aria-describedby": nameId
    }, pinButtonLabel && /*#__PURE__*/external_React_default().createElement(Localized, {
      text: pinButtonLabel
    }, /*#__PURE__*/external_React_default().createElement("span", null))));
  }));
};
;// ./content-src/components/ContentToggle.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */



const ContentToggle = ({
  content,
  toggled,
  onToggle
}) => {
  const {
    data
  } = content.tiles;
  const onChange = external_React_default().useCallback(e => onToggle?.(e.target.checked), [onToggle]);
  if (!data.visible) {
    return null;
  }
  return /*#__PURE__*/external_React_default().createElement("label", {
    className: "content-toggle-label"
  }, /*#__PURE__*/external_React_default().createElement("input", {
    type: "checkbox",
    checked: toggled,
    onChange: onChange
  }), /*#__PURE__*/external_React_default().createElement(Localized, {
    text: data.label
  }, /*#__PURE__*/external_React_default().createElement("span", null)));
};
;// ./content-src/components/TextBoxTile.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */



const TEXTBOX_STYLES = ["backgroundColor", "maxHeight"];
const TextBoxTile = ({
  content,
  contentToggled
}) => {
  const {
    data
  } = content.tiles;
  const activeContent = contentToggled ? data.content : data.alternateContent;
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "textbox-container"
  }, /*#__PURE__*/external_React_default().createElement("div", {
    className: "textbox-input",
    style: MultiStageUtils.getValidStyle(data.style, TEXTBOX_STYLES)
  }, activeContent ?? ""));
};
;// ./content-src/components/ContentTiles.jsx
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */


















const HEADER_STYLES = ["backgroundColor", "border", "padding", "margin", "width", "height"];
const ContentTiles_TILE_STYLES = ["marginBlock", "marginInline", "paddingBlock", "paddingInline"];
const CONTAINER_STYLES = ["padding", "margin", "marginBlock", "marginInline", "paddingBlock", "paddingInline", "flexDirection", "flexWrap", "flexFlow", "flexGrow", "flexShrink", "justifyContent", "alignItems", "gap"];
const ContentTiles = props => {
  const {
    content
  } = props;
  const [expandedTileIndex, setExpandedTileIndex] = (0,external_React_namespaceObject.useState)(null);
  // State for header that toggles showing and hiding all tiles, if applicable
  const [tilesHeaderExpanded, setTilesHeaderExpanded] = (0,external_React_namespaceObject.useState)(false);
  const {
    tiles
  } = content;
  if (!tiles) {
    return null;
  }

  // eslint-disable-next-line react-hooks/rules-of-hooks
  (0,external_React_namespaceObject.useEffect)(() => {
    // Run once when ContentTiles mounts to prefill activeMultiSelect
    if (!props.activeMultiSelect) {
      const tilesArray = Array.isArray(tiles) ? tiles : [tiles];
      tilesArray.forEach((tile, index) => {
        if (tile.type !== "multiselect" || !tile.data) {
          return;
        }
        const multiSelectId = `tile-${index}`;
        const newActiveMultiSelect = [];
        tile.data.forEach(({
          id,
          defaultValue
        }) => {
          if (defaultValue && id) {
            newActiveMultiSelect.push(id);
          }
        });
        if (newActiveMultiSelect.length) {
          props.setActiveMultiSelect(newActiveMultiSelect, multiSelectId);
        }
      });
    }
  }, [tiles]); // eslint-disable-line react-hooks/exhaustive-deps

  (0,external_React_namespaceObject.useEffect)(() => {
    /**
     * In Spotlight dialogs, the VO cursor can move without changing DOM focus.
     * When a user lands on content tiles, or a tile re-renders, DOM focus often
     * stays on or "snaps back" to the dialog’s first tabbable control by
     * SubDialog’s focus enforcement. Pressing Space/Enter then activates that
     * outside control instead of the VO target.
     *
     * To address this, we remember the last real DOM-focused element inside
     * #content-tiles-container. If focus jumps outside tiles without a recent
     * tab, such as with a VO focus move, restore focus to that element on the
     * next rAF. Tab navigation is unaffected.
     */
    const page = document.querySelector("#multi-stage-message-root.onboardingContainer[data-page]")?.dataset.page || document.location.href;
    if (page !== "spotlight") {
      return () => {};
    }
    const tilesEl = document.getElementById("content-tiles-container");
    const dialog = tilesEl?.closest('main[role="alertdialog"]') || null;
    if (!tilesEl || !dialog) {
      return () => {};
    }

    // We use 250ms to tell “intentional tab navigation” from a programmatic
    // snap. It’s long enough to cover a human Tab press (and a quick double-tab
    // / key repeat), but short enough that we don’t delay correcting unintended
    // focus jumps.
    const TAB_GRACE_WINDOW_MS = 250;
    let lastTilesEl = null;
    let lastTabAt = 0;
    let restoring = false;
    let tabFromTiles = false;
    function onKeyDown(e) {
      if (e.key === "Tab") {
        lastTabAt = performance.now();
        if (tilesEl.contains(document.activeElement)) {
          tabFromTiles = true;
        }
      }
    }
    function onFocusIn(event) {
      const {
        target
      } = event;

      // Track true DOM focus inside tiles.
      if (tilesEl.contains(target)) {
        lastTilesEl = target;
        // Reset when focus enters tiles
        tabFromTiles = false;
        return;
      }

      // If focus left tiles without a recent tab, treat as a programmatic snap.
      const tabRecently = performance.now() - lastTabAt < TAB_GRACE_WINDOW_MS;
      if (tabRecently || !lastTilesEl || !document.contains(lastTilesEl) || restoring) {
        tabFromTiles = false;
        return;
      }

      // If tab was pressed while in tiles and focus moved to action buttons, don't restore focus for the intended keyboard navigation
      const actionButtons = dialog.querySelector(".action-buttons");
      if (actionButtons?.contains(target) && tabFromTiles) {
        tabFromTiles = false;
        return;
      }

      // Restore immediately (before paint) to avoid visible flicker.
      restoring = true;
      try {
        lastTilesEl.focus({
          preventScroll: true
        });
      } finally {
        restoring = false;
      }
    }

    // Preempt other dialog handlers.
    dialog.addEventListener("keydown", onKeyDown, true);
    dialog.addEventListener("focusin", onFocusIn, true);
    return () => {
      dialog.removeEventListener("keydown", onKeyDown, true);
      dialog.removeEventListener("focusin", onFocusIn, true);
    };
  }, []);
  const toggleTile = (index, tile) => {
    const tileId = `${tile.type}${tile.id ? "_" : ""}${tile.id ?? ""}_header`;
    MultiStageUtils.sendActionTelemetry(props.messageId, tileId, "CLICK_BUTTON");
    if (tile.type === "link" && tile.action) {
      props.handleAction({
        currentTarget: {
          value: tileId
        }
      }, tile.action);
    } else {
      setExpandedTileIndex(prevIndex => prevIndex === index ? null : index);
    }
  };
  const toggleTiles = () => {
    setTilesHeaderExpanded(prev => !prev);
    MultiStageUtils.sendActionTelemetry(props.messageId, "content_tiles_header", "CLICK_BUTTON");
  };
  function getTileMultiSelects(screenMultiSelects, index) {
    return screenMultiSelects?.[`tile-${index}`];
  }
  function getTileActiveMultiSelect(activeMultiSelect, index) {
    return activeMultiSelect?.[`tile-${index}`];
  }
  const renderContentTile = (tile, index = 0) => {
    const isExpanded = expandedTileIndex === index;
    const {
      header,
      title,
      subtitle
    } = tile;
    const tileHeaderProps = tile.type === "link" ? {
      role: "link"
    } : {
      "aria-expanded": isExpanded,
      "aria-controls": `tile-content-${index}`
    };
    const headerTitle = tile.type === "textbox" && props.contentToggleChecked === false ? header?.alternateTitle ?? header?.title : header?.title;
    return /*#__PURE__*/external_React_default().createElement("div", {
      key: index,
      className: `content-tile ${header ? "has-header" : ""}`,
      style: MultiStageUtils.getTileStyle(tile, ContentTiles_TILE_STYLES)
    }, header?.title && /*#__PURE__*/external_React_default().createElement("button", _extends({
      className: "tile-header secondary",
      onClick: () => toggleTile(index, tile)
    }, tileHeaderProps, {
      style: MultiStageUtils.getValidStyle(header.style, HEADER_STYLES)
    }), /*#__PURE__*/external_React_default().createElement("div", {
      className: "header-text-container"
    }, /*#__PURE__*/external_React_default().createElement(Localized, {
      text: headerTitle
    }, /*#__PURE__*/external_React_default().createElement("span", {
      className: "header-title"
    })), header.subtitle && /*#__PURE__*/external_React_default().createElement(Localized, {
      text: header.subtitle
    }, /*#__PURE__*/external_React_default().createElement("span", {
      className: "header-subtitle"
    }))), /*#__PURE__*/external_React_default().createElement("div", {
      className: tile.type === "link" ? "external-link-icon" : "arrow-icon"
    })), (title || subtitle) && /*#__PURE__*/external_React_default().createElement("div", {
      className: "tile-title-container",
      id: `tile-title-container-${index}`
    }, title && /*#__PURE__*/external_React_default().createElement(Localized, {
      text: title
    }, /*#__PURE__*/external_React_default().createElement("h1", {
      className: "tile-title",
      id: `content-tile-title-${index}`
    })), subtitle && /*#__PURE__*/external_React_default().createElement(Localized, {
      text: subtitle
    }, /*#__PURE__*/external_React_default().createElement("p", {
      className: "tile-subtitle"
    }))), tile.type !== "link" && (isExpanded || !header) ? /*#__PURE__*/external_React_default().createElement("div", {
      className: "tile-content",
      id: `tile-content-${index}`
    }, tile.type === "addons-picker" && tile.data && /*#__PURE__*/external_React_default().createElement(AddonsPicker, {
      content: {
        tiles: tile
      },
      installedAddons: props.installedAddons,
      message_id: props.messageId,
      handleAction: props.handleAction,
      layout: content.position
    }), ["theme", "single-select"].includes(tile.type) && tile.data && /*#__PURE__*/external_React_default().createElement(SingleSelect, {
      content: {
        tiles: tile,
        subtitle: content.subtitle
      },
      activeTheme: props.activeTheme,
      handleAction: props.handleAction,
      activeSingleSelectSelections: props.activeSingleSelectSelections,
      setActiveSingleSelectSelection: props.setActiveSingleSelectSelection,
      singleSelectId: `single-select-${index}`
    }), tile.type === "mobile_downloads" && tile.data && /*#__PURE__*/external_React_default().createElement(MobileDownloads, {
      data: tile.data,
      handleAction: props.handleAction
    }), tile.type === "multiselect" && tile.data && /*#__PURE__*/external_React_default().createElement(MultiSelect, {
      content: {
        tiles: tile
      },
      screenMultiSelects: getTileMultiSelects(props.screenMultiSelects, index),
      setScreenMultiSelects: props.setScreenMultiSelects,
      activeMultiSelect: getTileActiveMultiSelect(props.activeMultiSelect, index),
      setActiveMultiSelect: props.setActiveMultiSelect,
      multiSelectId: `tile-${index}`
    }), tile.type === "textarea" && tile.data && /*#__PURE__*/external_React_default().createElement(TextAreaTile, {
      content: {
        tiles: tile
      },
      textInputs: props.textInputs,
      setTextInput: props.setTextInput,
      tileIndex: index
    }), tile.type === "migration-wizard" && /*#__PURE__*/external_React_default().createElement(EmbeddedMigrationWizard, {
      handleAction: props.handleAction,
      content: {
        tiles: tile
      }
    }), tile.type === "action_checklist" && tile.data && /*#__PURE__*/external_React_default().createElement(ActionChecklist, {
      content: content,
      message_id: props.messageId
    }), tile.type === "embedded_browser" && tile.data?.url && /*#__PURE__*/external_React_default().createElement(EmbeddedBrowser, {
      url: tile.data.url,
      style: tile.data.style
    }), tile.type === "backup_restore" && /*#__PURE__*/external_React_default().createElement(EmbeddedBackupRestore, {
      handleAction: props.handleAction,
      content: {
        tiles: tile
      },
      skipButton: props.content.skip_button
    }), tile.type === "fx_backup_file_path" && /*#__PURE__*/external_React_default().createElement(EmbeddedFxBackupOptIn, {
      handleAction: props.handleAction,
      isEncryptedBackup: content.isEncryptedBackup,
      options: tile.options,
      messageId: props.messageId
    }), tile.type === "fx_backup_password" && /*#__PURE__*/external_React_default().createElement(EmbeddedFxBackupOptIn, {
      handleAction: props.handleAction,
      isEncryptedBackup: content.isEncryptedBackup,
      options: tile.options,
      messageId: props.messageId
    }), tile.type === "confirmation-checklist" && tile.data && /*#__PURE__*/external_React_default().createElement(ConfirmationChecklist, {
      content: tile.data,
      handleAction: props.handleAction
    }), tile.type === "pinnable_sites" && tile.data && /*#__PURE__*/external_React_default().createElement(PinnableSitesList, {
      tile: tile,
      messageId: props.messageId,
      handleAction: props.handleAction
    }), tile.type === "content-toggle" && tile.data && /*#__PURE__*/external_React_default().createElement(ContentToggle, {
      content: {
        tiles: tile
      },
      toggled: props.contentToggleChecked,
      onToggle: props.setContentToggleChecked
    }), tile.type === "textbox" && tile.data && /*#__PURE__*/external_React_default().createElement(TextBoxTile, {
      content: {
        tiles: tile
      },
      contentToggled: props.contentToggleChecked
    })) : null);
  };
  const renderContentTiles = () => {
    if (Array.isArray(tiles)) {
      const containerStyle = content?.tiles_container?.style;
      return /*#__PURE__*/external_React_default().createElement("div", {
        id: "content-tiles-container",
        style: MultiStageUtils.getValidStyle(containerStyle, CONTAINER_STYLES)
      }, tiles.map((tile, index) => renderContentTile(tile, index)));
    }
    // If tiles is not an array render the tile alone without a container
    return renderContentTile(tiles, 0);
  };
  if (content.tiles_header) {
    return /*#__PURE__*/external_React_default().createElement((external_React_default()).Fragment, null, /*#__PURE__*/external_React_default().createElement("button", {
      className: "content-tiles-header secondary",
      onClick: toggleTiles,
      "aria-expanded": tilesHeaderExpanded,
      "aria-controls": `content-tiles-container`
    }, /*#__PURE__*/external_React_default().createElement(Localized, {
      text: content.tiles_header.title
    }, /*#__PURE__*/external_React_default().createElement("span", {
      className: "header-title"
    })), /*#__PURE__*/external_React_default().createElement("div", {
      className: "arrow-icon"
    })), tilesHeaderExpanded && renderContentTiles());
  }
  return renderContentTiles(tiles);
};
;// ./content-src/components/MultiStageProtonScreen.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */














const DEFAULT_AUTO_ADVANCE_MS = 20000;
const MultiStageProtonScreen = props => {
  const {
    autoAdvance,
    advanceOnExperimentLoad,
    handleAction,
    messageId,
    navigate,
    order
  } = props;
  (0,external_React_namespaceObject.useEffect)(() => {
    if (!autoAdvance && !advanceOnExperimentLoad) {
      return () => {};
    }
    if (autoAdvance) {
      const value = autoAdvance?.actionEl ?? autoAdvance;
      const timeout = autoAdvance?.actionTimeMS ?? DEFAULT_AUTO_ADVANCE_MS;
      const timer = setTimeout(() => {
        handleAction({
          currentTarget: {
            value
          },
          name: "AUTO_ADVANCE"
        });
      }, timeout);
      return () => clearTimeout(timer);
    }

    // If not doing a standard auto advance, handle auto advancing when experiments load.

    // Defaults for when advance_on_experiment_load is true.
    const minMsDefault = 3000;
    const maxMsDefault = 8000;
    let minMs = advanceOnExperimentLoad?.minDisplayMs ?? minMsDefault;
    let maxMs = advanceOnExperimentLoad?.maxDisplayMs ?? maxMsDefault;

    // Ensure max >= min.
    if (maxMs < minMs) {
      maxMs = minMs;
    }
    const startTime = performance.now();
    let cancelled = false;
    let advanced = false;
    let minDone = false;
    let experimentsDone = false;
    let nimbusResult = null;
    let maxTimeoutFired = false;
    const doAdvance = () => {
      if (cancelled || advanced) {
        return;
      }
      advanced = true;
      const screen_duration = Math.round(performance.now() - startTime);
      let reason;
      if (maxTimeoutFired) {
        reason = "max_display_timeout";
      } else if (nimbusResult === "error") {
        reason = "nimbus_error";
      } else if (nimbusResult === "timeout") {
        reason = "nimbus_timeout";
      } else {
        reason = "nimbus_ready";
      }
      MultiStageUtils.sendActionTelemetry(messageId, "advance_on_experiment_load", "SPLASH_DISMISSED", {
        reason,
        screen_duration
      });
      navigate(false);
    };
    const maybeAdvance = () => {
      if (minDone && experimentsDone) {
        doAdvance();
      }
    };
    const minTimerId = window.setTimeout(() => {
      minDone = true;
      maybeAdvance();
    }, minMs);
    const maxTimerId = window.setTimeout(() => {
      maxTimeoutFired = true;
      doAdvance();
    }, maxMs);

    // Use an IIFE to keep the effect itself synchronous
    (async () => {
      try {
        if (typeof window.AWWaitForNimbus === "function") {
          nimbusResult = await window.AWWaitForNimbus();
        }
        // If AWWaitForNimbus is missing, treat as "done" immediately.
      } catch (e) {} finally {
        experimentsDone = true;
        maybeAdvance();
      }
    })();
    return () => {
      cancelled = true;
      window.clearTimeout(minTimerId);
      window.clearTimeout(maxTimerId);
    };
  }, [autoAdvance, advanceOnExperimentLoad, handleAction, messageId, order, navigate]);

  // Set narrow on an outer element to allow for use of SCSS outer selector and
  // consolidation of styles for small screen widths with those for messages
  // configured to always be narrow
  if (props.content.narrow) {
    document.querySelector("#multi-stage-message-root")?.setAttribute("narrow", "");
  } else {
    // Clear narrow attribute in case it was set by a previous screen
    document.querySelector("#multi-stage-message-root")?.removeAttribute("narrow");
  }
  function useMediaQuery(query) {
    const [doesMatch, setDoesMatch] = (0,external_React_namespaceObject.useState)(() => window.matchMedia(query).matches);
    (0,external_React_namespaceObject.useEffect)(() => {
      const mediaQueryList = window.matchMedia(query);
      const onChange = event => setDoesMatch(event.matches);
      mediaQueryList.addEventListener("change", onChange);
      return () => mediaQueryList.removeEventListener("change", onChange);
    }, [query]);
    return doesMatch;
  }
  const isWideScreen = useMediaQuery("(min-width: 800px)");
  return /*#__PURE__*/external_React_default().createElement(ProtonScreen, {
    content: props.content,
    id: props.id,
    order: props.order,
    activeTheme: props.activeTheme,
    installedAddons: props.installedAddons,
    screenMultiSelects: props.screenMultiSelects,
    setScreenMultiSelects: props.setScreenMultiSelects,
    activeMultiSelect: props.activeMultiSelect,
    setActiveMultiSelect: props.setActiveMultiSelect,
    activeSingleSelectSelections: props.activeSingleSelectSelections,
    setActiveSingleSelectSelection: props.setActiveSingleSelectSelection,
    textInputs: props.textInputs,
    setTextInput: props.setTextInput,
    contentToggleChecked: props.contentToggleChecked,
    setContentToggleChecked: props.setContentToggleChecked,
    totalNumberOfScreens: props.totalNumberOfScreens,
    handleAction: props.handleAction,
    isFirstScreen: props.isFirstScreen,
    isLastScreen: props.isLastScreen,
    isSingleScreen: props.isSingleScreen,
    previousOrder: props.previousOrder,
    autoAdvance: props.autoAdvance,
    advanceOnExperimentLoad: props.advanceOnExperimentLoad,
    navigate: props.navigate,
    isRtamo: props.isRtamo,
    addonId: props.addonId,
    addonType: props.addonType,
    addonName: props.addonName,
    addonURL: props.addonURL,
    addonIconURL: props.addonIconURL,
    themeScreenshots: props.themeScreenshots,
    messageId: props.messageId,
    negotiatedLanguage: props.negotiatedLanguage,
    langPackInstallPhase: props.langPackInstallPhase,
    forceHideStepsIndicator: props.forceHideStepsIndicator,
    ariaRole: props.ariaRole,
    aboveButtonStepsIndicator: props.aboveButtonStepsIndicator,
    requireAction: props.requireAction,
    isWideScreen: isWideScreen,
    animationsPaused: props.animationsPaused,
    toggleAnimationsPaused: props.toggleAnimationsPaused
  });
};
const ProtonScreenActionButtons = props => {
  const {
    content,
    isRtamo,
    addonId,
    addonType,
    addonName,
    activeMultiSelect,
    activeSingleSelectSelections,
    textInputs,
    installedAddons
  } = props;
  const defaultValue = content.checkbox?.defaultValue;
  const [isChecked, setIsChecked] = (0,external_React_namespaceObject.useState)(defaultValue || false);
  const buttonRef = external_React_default().useRef(null);
  const shouldFocusButton = content?.primary_button?.should_focus_button;
  (0,external_React_namespaceObject.useEffect)(() => {
    if (shouldFocusButton) {
      buttonRef.current?.focus();
    }
  }, [shouldFocusButton]);
  if (!content.primary_button && !content.secondary_button && !content.additional_button) {
    return null;
  }
  if (isRtamo) {
    content.primary_button.label.string_id = addonType?.includes("theme") ? "return-to-amo-add-theme-label" : "mr1-return-to-amo-add-extension-label";
  }

  // If we have a multi-select screen, we want to disable the primary button
  // until the user has selected at least one item.
  const isPrimaryDisabled = disabledValue => {
    if (disabledValue === "hasActiveMultiSelect") {
      if (!activeMultiSelect) {
        return true;
      }

      // Check if there's at least one selection in any of the multiselects
      for (const selectKey in activeMultiSelect) {
        if (activeMultiSelect[selectKey]?.length > 0) {
          return false;
        }
      }
      return true;
    }
    // Only disables the primary button until at least one single-select
    // option is chosen.
    if (disabledValue === "hasActiveSingleSelect") {
      if (!activeSingleSelectSelections) {
        return true;
      }
      return !Object.values(activeSingleSelectSelections).some(val => val && val !== "none");
    }
    if (disabledValue === "hasTextInput") {
      // For text input, we check if the user has entered any text in the
      // textarea(s) present on the screen.
      if (!textInputs) {
        return true;
      }
      return Object.values(textInputs).every(input => !input.isValid || input.value.trim().length === 0);
    }
    return disabledValue;
  };
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: `action-buttons ${content.additional_button ? "additional-cta-container" : ""}`,
    flow: content.additional_button?.flow,
    alignment: content.additional_button?.alignment
  }, isRtamo ? /*#__PURE__*/external_React_default().createElement(InstallButton, {
    key: addonId,
    addonId: addonId,
    addonType: addonType,
    addonName: addonName,
    index: "primary_button",
    handleAction: props.handleAction,
    installedAddons: installedAddons,
    install_label: content.primary_button.label,
    install_complete_label: content.primary_button.install_complete_label
  }) : /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.primary_button?.label
  }, /*#__PURE__*/external_React_default().createElement("button", {
    ref: buttonRef,
    className: `${content.primary_button?.style ?? "primary"}${content.primary_button?.has_arrow_icon ? " arrow-icon" : ""}`
    // Whether or not the checkbox is checked determines which action
    // should be handled. By setting value here, we indicate to
    // this.handleAction() where in the content tree it should take
    // the action to execute from.
    ,
    value: isChecked ? "checkbox" : "primary_button",
    disabled: isPrimaryDisabled(content.primary_button?.disabled),
    onClick: props.handleAction,
    "data-l10n-args": addonName ? JSON.stringify({
      "addon-name": addonName
    }) : ""
  })), content.additional_button ? /*#__PURE__*/external_React_default().createElement(AdditionalCTA, {
    content: content,
    handleAction: props.handleAction,
    activeMultiSelect: activeMultiSelect,
    textInputs: textInputs
  }) : null, content.checkbox ? /*#__PURE__*/external_React_default().createElement("div", {
    className: "checkbox-container"
  }, /*#__PURE__*/external_React_default().createElement("input", {
    type: "checkbox",
    id: "action-checkbox",
    checked: isChecked,
    onChange: () => {
      setIsChecked(!isChecked);
    }
  }), /*#__PURE__*/external_React_default().createElement(Localized, {
    text: content.checkbox.label
  }, /*#__PURE__*/external_React_default().createElement("label", {
    htmlFor: "action-checkbox"
  }))) : null, content.secondary_button ? /*#__PURE__*/external_React_default().createElement(SecondaryCTA, {
    content: content,
    handleAction: props.handleAction,
    activeMultiSelect: activeMultiSelect,
    textInputs: textInputs
  }) : null);
};
class ProtonScreen extends (external_React_default()).PureComponent {
  componentDidMount() {
    // Don't focus on main content if it is a feature callout
    // See Bug 1985939
    if (this.props.content?.position === "callout") {
      return;
    }

    // For requireAction screens, focus the title heading instead of the
    // alertdialog container.
    // Prevents Orca from misreading tab navigated elements.
    if (this.props.requireAction && this.titleHeader) {
      this.titleHeader.focus();
    } else {
      this.mainContentHeader.focus();
    }
  }
  getScreenClassName(includeNoodles, isVideoOnboarding, isAddonsPicker) {
    if (isVideoOnboarding) {
      return "with-video";
    }
    if (isAddonsPicker) {
      return "addons-picker";
    }
    const screenClass = `screen-${this.props.order % 2 !== 0 ? 1 : 2}`;
    const dialogInitial = this.props.isFirstScreen && this.props.previousOrder < 0 ? `dialog-initial` : ``;
    const dialogLast = this.props.isLastScreen ? `dialog-last` : ``;
    return `${screenClass} ${dialogInitial} ${dialogLast} ${includeNoodles ? `with-noodles` : ``}`;
  }
  renderTitle({
    title,
    title_logo
  }) {
    const titleRef = this.props.requireAction ? input => {
      this.titleHeader = input;
    } : null;
    if (title_logo) {
      const {
        alignment,
        ...rest
      } = title_logo;
      return /*#__PURE__*/external_React_default().createElement("div", {
        className: "inline-icon-container",
        alignment: alignment ?? "center"
      }, this.renderPicture({
        ...rest
      }), /*#__PURE__*/external_React_default().createElement(Localized, {
        text: title
      }, /*#__PURE__*/external_React_default().createElement("h1", {
        id: "mainContentHeader",
        tabIndex: this.props.requireAction ? -1 : undefined,
        ref: titleRef
      })));
    }
    return /*#__PURE__*/external_React_default().createElement(Localized, {
      text: title
    }, /*#__PURE__*/external_React_default().createElement("h1", {
      id: "mainContentHeader",
      tabIndex: this.props.requireAction ? -1 : undefined,
      ref: titleRef
    }));
  }
  renderPicture({
    imageURL = "chrome://branding/content/about-logo.svg",
    darkModeImageURL,
    reducedMotionImageURL,
    darkModeReducedMotionImageURL,
    alt = "",
    width,
    height,
    marginBlock,
    marginInline,
    style,
    className = "logo-container"
  }) {
    function getLoadingStrategy() {
      for (let url of [imageURL, darkModeImageURL, reducedMotionImageURL, darkModeReducedMotionImageURL]) {
        if (MultiStageUtils.getLoadingStrategyFor(url) === "lazy") {
          return "lazy";
        }
      }
      return "eager";
    }
    const pictureStyle = {
      marginInline,
      marginBlock,
      ...style
    };
    return /*#__PURE__*/external_React_default().createElement("picture", {
      className: className,
      style: pictureStyle
    }, darkModeReducedMotionImageURL ? /*#__PURE__*/external_React_default().createElement("source", {
      srcset: darkModeReducedMotionImageURL,
      media: "(prefers-color-scheme: dark) and (prefers-reduced-motion: reduce)"
    }) : null, darkModeImageURL ? /*#__PURE__*/external_React_default().createElement("source", {
      srcset: darkModeImageURL,
      media: "(prefers-color-scheme: dark)"
    }) : null, reducedMotionImageURL ? /*#__PURE__*/external_React_default().createElement("source", {
      srcset: reducedMotionImageURL,
      media: "(prefers-reduced-motion: reduce)"
    }) : null, /*#__PURE__*/external_React_default().createElement(Localized, {
      text: alt
    }, /*#__PURE__*/external_React_default().createElement("div", {
      className: "sr-only logo-alt"
    })), /*#__PURE__*/external_React_default().createElement("img", {
      className: "brand-logo",
      style: {
        height,
        width
      },
      src: imageURL,
      alt: "",
      loading: getLoadingStrategy(),
      role: alt ? null : "presentation"
    }));
  }
  renderNoodles() {
    return /*#__PURE__*/external_React_default().createElement((external_React_default()).Fragment, null, /*#__PURE__*/external_React_default().createElement("div", {
      className: "noodle orange-L"
    }), /*#__PURE__*/external_React_default().createElement("div", {
      className: "noodle purple-C"
    }), /*#__PURE__*/external_React_default().createElement("div", {
      className: "noodle solid-L"
    }), /*#__PURE__*/external_React_default().createElement("div", {
      className: "noodle outline-L"
    }), /*#__PURE__*/external_React_default().createElement("div", {
      className: "noodle yellow-circle"
    }));
  }
  renderLanguageSwitcher() {
    return this.props.content.languageSwitcher ? /*#__PURE__*/external_React_default().createElement(LanguageSwitcher, {
      content: this.props.content,
      handleAction: this.props.handleAction,
      negotiatedLanguage: this.props.negotiatedLanguage,
      langPackInstallPhase: this.props.langPackInstallPhase,
      messageId: this.props.messageId
    }) : null;
  }
  renderDismissButton() {
    const {
      size,
      marginBlock,
      marginInline,
      label,
      background
    } = this.props.content.dismiss_button;
    return /*#__PURE__*/external_React_default().createElement("button", {
      className: `dismiss-button ${background ? "with-background" : ""}`,
      onClick: this.props.handleAction,
      value: "dismiss_button",
      "data-l10n-id": label?.string_id || "spotlight-dialog-close-button",
      "button-size": size,
      style: {
        marginBlock,
        marginInline
      }
    });
  }
  renderMoreButton() {
    return /*#__PURE__*/external_React_default().createElement(SubmenuButton, {
      content: this.props.content,
      handleAction: this.props.handleAction,
      buttonType: "more"
    });
  }
  renderStepsIndicator() {
    const {
      order,
      previousOrder,
      content,
      totalNumberOfScreens: total,
      aboveButtonStepsIndicator
    } = this.props;
    const currentStep = (order ?? 0) + 1;
    const previousStep = (previousOrder ?? -1) + 1;
    return /*#__PURE__*/external_React_default().createElement("div", {
      id: "steps",
      className: `steps${content.progress_bar ? " progress-bar" : ""}`,
      "above-button": aboveButtonStepsIndicator ? "" : null,
      "data-l10n-id": content.steps_indicator?.string_id || "onboarding-welcome-steps-indicator-label",
      "data-l10n-args": JSON.stringify({
        current: currentStep,
        total: total ?? 0
      }),
      "data-l10n-attrs": "aria-label",
      role: "progressbar",
      "aria-valuenow": currentStep,
      "aria-valuemin": 1,
      "aria-valuemax": total
    }, content.progress_bar ? /*#__PURE__*/external_React_default().createElement(ProgressBar, {
      step: currentStep,
      previousStep: previousStep,
      totalNumberOfScreens: total
    }) : /*#__PURE__*/external_React_default().createElement(StepsIndicator, {
      order: order,
      totalNumberOfScreens: total
    }));
  }

  // We consider a screen to have animated content when it includes both
  // default and _static versions of its background image or hero_image url.
  // The pause toggle swaps the rendered asset to the _static asset when activated.
  // Without _both_ default and static, there is nothing for the toggle to
  // switch to, so we don't render the toggle button at all.
  hasAnimatedContent(content) {
    return !!(content.background && content.background_static || content.hero_image?.url && content.hero_image?.static_url);
  }
  getEffectiveBackground(content) {
    return this.props.animationsPaused && content.background_static ? content.background_static : content.background;
  }
  getEffectiveHeroImageUrl(content) {
    if (!content.hero_image) {
      return null;
    }
    return this.props.animationsPaused && content.hero_image.static_url ? content.hero_image.static_url : content.hero_image.url;
  }
  renderAnimationPlayPauseButton() {
    const {
      toggleAnimationsPaused
    } = this.props;
    const paused = !!this.props.animationsPaused;
    const labelId = paused ? "onboarding-animation-play-button" : "onboarding-animation-pause-button";
    return /*#__PURE__*/external_React_default().createElement("button", {
      className: `animation-play-pause-button${paused ? " paused" : ""}`,
      type: "button",
      "aria-pressed": paused,
      "data-l10n-id": labelId,
      onClick: toggleAnimationsPaused
    });
  }
  renderSecondarySection(content) {
    const background = this.getEffectiveBackground(content);
    const heroImageUrl = this.getEffectiveHeroImageUrl(content);
    // pinnable_sites exposes its background through a custom property so the
    // stylesheet can swap the wide-layout image for a narrow gradient without
    // overriding an inline `background` shorthand.
    const tiles = Array.isArray(content.tiles) ? content.tiles : [content.tiles];
    const isPinnableSites = tiles.some(tile => tile?.type === "pinnable_sites");
    return /*#__PURE__*/external_React_default().createElement("div", {
      className: `section-secondary ${content.hide_secondary_section ? "with-secondary-section-hidden" : ""}`,
      style: background ? {
        [isPinnableSites ? "--pinnable-sites-bkg" : "background"]: background,
        "--mr-secondary-background-position-y": content.split_narrow_bkg_position
      } : {}
    }, content.dismiss_button && content.reverse_split ? this.renderDismissButton() : null, /*#__PURE__*/external_React_default().createElement(Localized, {
      text: content.image_alt_text
    }, /*#__PURE__*/external_React_default().createElement("div", {
      className: "sr-only image-alt",
      role: "img"
    })), content.hero_image ? /*#__PURE__*/external_React_default().createElement(HeroImage, {
      url: heroImageUrl
    }) : this.renderHeroText(content.hero_text), this.hasAnimatedContent(content) ? this.renderAnimationPlayPauseButton() : null);
  }
  renderHeroText(hero_text) {
    if (!hero_text) {
      return null;
    }

    // Check if hero_text is a string or an object with string_id property
    // essentially checking if we're using old or new design
    const isSimpleText = typeof hero_text === "string" || typeof hero_text === "object" && hero_text !== null && ("string_id" in hero_text || "raw" in hero_text);
    const HeroTextWrapper = ({
      children,
      className
    }) => /*#__PURE__*/external_React_default().createElement((external_React_default()).Fragment, null, /*#__PURE__*/external_React_default().createElement("div", {
      className: `message-text ${className}`
    }, /*#__PURE__*/external_React_default().createElement("div", {
      className: "spacer-top"
    }), children, /*#__PURE__*/external_React_default().createElement("div", {
      className: "spacer-bottom"
    })));
    if (isSimpleText) {
      return /*#__PURE__*/external_React_default().createElement(HeroTextWrapper, {
        className: "simple"
      }, /*#__PURE__*/external_React_default().createElement(Localized, {
        text: hero_text
      }, /*#__PURE__*/external_React_default().createElement("h1", null)));
    }
    return /*#__PURE__*/external_React_default().createElement(HeroTextWrapper, {
      className: "hero-text"
    }, /*#__PURE__*/external_React_default().createElement(Localized, {
      text: hero_text.title
    }, /*#__PURE__*/external_React_default().createElement("h1", null)), hero_text.subtitle && /*#__PURE__*/external_React_default().createElement(Localized, {
      text: hero_text.subtitle
    }, /*#__PURE__*/external_React_default().createElement("h2", null)));
  }
  renderOrderedContent(content) {
    const elements = [];
    for (const item of content) {
      switch (item.type) {
        case "text":
          elements.push(/*#__PURE__*/external_React_default().createElement(LinkParagraph, {
            text_content: item,
            handleAction: this.props.handleAction
          }));
          break;
        case "image":
          elements.push(this.renderPicture({
            imageURL: item.url,
            darkModeImageURL: item.darkModeImageURL,
            height: item.height,
            width: item.width,
            alt: item.alt_text,
            marginInline: item.marginInline,
            className: "inline-image"
          }));
      }
    }
    return /*#__PURE__*/external_React_default().createElement((external_React_default()).Fragment, null, elements);
  }
  renderRTAMOIcon(addonType, themeScreenshots, addonIconURL) {
    return /*#__PURE__*/external_React_default().createElement("div", {
      className: "rtamo-icon"
    }, /*#__PURE__*/external_React_default().createElement("img", {
      className: `${addonType?.includes("theme") ? "rtamo-theme-icon" : "brand-logo"}`,
      src: addonType?.includes("theme") ? themeScreenshots[0].url : addonIconURL,
      loading: MultiStageUtils.getLoadingStrategyFor(addonIconURL),
      alt: "",
      role: "presentation"
    }));
  }
  getCombinedInnerStyles(content, isWideScreen) {
    const CONFIGURABLE_STYLES = ["overflow", "display", "paddingInline", "paddingInlineStart", "paddingInlineEnd", "paddingBlock", "paddingBlockStart", "paddingBlockEnd"];
    const innerContentStyles = isWideScreen ? content.main_content_style || {} : content.main_content_style_narrow || {};
    const validInnerStyles = MultiStageUtils.getValidStyle(innerContentStyles, CONFIGURABLE_STYLES) || {};
    return {
      ...validInnerStyles,
      justifyContent: content.split_content_justify_content
    };
  }
  getActionButtonsPosition(content) {
    const VALID_POSITIONS = ["after_subtitle", "after_supporting_content", "end"];
    if (VALID_POSITIONS.includes(content.action_buttons_position)) {
      return content.action_buttons_position;
    }
    // Legacy mapping
    if (content.action_buttons_above_content) {
      return "after_subtitle";
    }
    // Default
    return "end";
  }
  renderActionButtons(position, content) {
    return this.getActionButtonsPosition(content) === position ? /*#__PURE__*/external_React_default().createElement(ProtonScreenActionButtons, {
      content: content,
      isRtamo: this.props.isRtamo,
      installedAddons: this.props.installedAddons,
      addonId: this.props.addonId,
      addonName: this.props.addonName,
      addonType: this.props.addonType,
      handleAction: this.props.handleAction,
      activeMultiSelect: this.props.activeMultiSelect,
      activeSingleSelectSelections: this.props.activeSingleSelectSelections,
      textInputs: this.props.textInputs
    }) : null;
  }

  // eslint-disable-next-line complexity
  render() {
    const {
      autoAdvance,
      content,
      isRtamo,
      addonType,
      isSingleScreen,
      forceHideStepsIndicator,
      ariaRole,
      aboveButtonStepsIndicator,
      isWideScreen
    } = this.props;
    const includeNoodles = content.has_noodles;
    // The default screen position is "center"
    const isCenterPosition = content.position === "center" || !content.position;
    const hideStepsIndicator = autoAdvance || content?.video_container || isSingleScreen || forceHideStepsIndicator;
    const textColorClass = content.text_color ? `${content.text_color}-text` : "";
    // Assign proton screen style 'screen-1' or 'screen-2' to centered screens
    // by checking if screen order is even or odd.
    const screenClassName = isCenterPosition ? this.getScreenClassName(includeNoodles, content?.video_container, content.tiles?.type === "addons-picker") : "";
    const isEmbeddedMigration = content.tiles?.type === "migration-wizard";
    const isSystemPromptStyleSpotlight = content.isSystemPromptStyleSpotlight === true;
    const combinedStyles = this.getCombinedInnerStyles(content, isWideScreen);
    return /*#__PURE__*/external_React_default().createElement("main", {
      className: `screen ${this.props.id || ""}
          ${screenClassName} ${textColorClass} ${content.transition_content ? "transition-content" : ""}`,
      "reverse-split": content.reverse_split ? "" : null,
      fullscreen: content.fullscreen ? "" : null,
      style: content.screen_style && MultiStageUtils.getValidStyle(content.screen_style, ["overflow", "display"]),
      role: ariaRole ?? "alertdialog",
      layout: content.layout,
      pos: content.position || "center",
      tabIndex: "-1",
      "aria-labelledby": `mainContentHeader${content.subtitle ? " mainContentSubheader" : ""}`,
      "aria-describedby": "mainContentInner",
      ref: input => {
        this.mainContentHeader = input;
      },
      "no-rdm": content.no_rdm ? "" : null
    }, isCenterPosition ? null : this.renderSecondarySection(content), /*#__PURE__*/external_React_default().createElement("div", {
      className: `section-main ${isEmbeddedMigration ? "embedded-migration" : ""}${isSystemPromptStyleSpotlight ? "system-prompt-spotlight" : ""}`,
      "hide-secondary-section": content.hide_secondary_section ? String(content.hide_secondary_section) : null,
      role: "document",
      style: content.screen_style && MultiStageUtils.getValidStyle(content.screen_style, ["width", "padding", "height"])
    }, content.secondary_button_top ? /*#__PURE__*/external_React_default().createElement(SecondaryCTA, {
      content: content,
      handleAction: this.props.handleAction,
      position: "top"
    }) : null, includeNoodles ? this.renderNoodles() : null, content.more_button ? this.renderMoreButton() : null, content.dismiss_button && !content.reverse_split ? this.renderDismissButton() : null, /*#__PURE__*/external_React_default().createElement("div", {
      className: `main-content ${hideStepsIndicator ? "no-steps" : ""}`,
      style: {
        background: isCenterPosition && this.getEffectiveBackground(content) ? this.getEffectiveBackground(content) : null,
        width: content.width && content.position !== "split" ? content.width : null,
        paddingBlock: content.split_content_padding_block ? content.split_content_padding_block : null,
        paddingInline: content.split_content_padding_inline ? content.split_content_padding_inline : null
      }
    }, isCenterPosition && this.hasAnimatedContent(content) ? this.renderAnimationPlayPauseButton() : null, content.logo && !content.fullscreen ? this.renderPicture(content.logo) : null, isRtamo && !content.fullscreen ? this.renderRTAMOIcon(addonType, this.props.themeScreenshots, this.props.addonIconURL) : null, /*#__PURE__*/external_React_default().createElement("div", {
      className: "main-content-inner",
      id: "mainContentInner",
      style: combinedStyles
    }, content.logo && content.fullscreen ? this.renderPicture(content.logo) : null, isRtamo && content.fullscreen ? this.renderRTAMOIcon(addonType, this.props.themeScreenshots, this.props.addonIconURL) : null, content.title || content.subtitle ? /*#__PURE__*/external_React_default().createElement("div", {
      id: "multi-stage-message-welcome-text",
      className: `welcome-text ${content.title_style || ""}`
    }, content.title ? this.renderTitle(content) : null, content.subtitle ? /*#__PURE__*/external_React_default().createElement(Localized, {
      text: content.subtitle
    }, /*#__PURE__*/external_React_default().createElement("h2", {
      "data-l10n-args": JSON.stringify({
        "addon-name": this.props.addonName,
        ...this.props.appAndSystemLocaleInfo?.displayNames
      }),
      "aria-flowto": this.props.messageId?.includes("FEATURE_TOUR") ? "steps" : "",
      id: "mainContentSubheader"
    })) : null, this.renderActionButtons("after_subtitle", content), content.cta_paragraph ? /*#__PURE__*/external_React_default().createElement(CTAParagraph, {
      content: content.cta_paragraph,
      handleAction: this.props.handleAction
    }) : null) : null, content.video_container ? /*#__PURE__*/external_React_default().createElement(OnboardingVideo, {
      content: content.video_container,
      handleAction: this.props.handleAction
    }) : null, this.renderLanguageSwitcher(), content?.tiles_container?.position !== "after_supporting_content" ? /*#__PURE__*/external_React_default().createElement(ContentTiles, this.props) : null, content.above_button_content ? this.renderOrderedContent(content.above_button_content) : null, this.renderActionButtons("after_supporting_content", content), content?.tiles_container?.position === "after_supporting_content" ? /*#__PURE__*/external_React_default().createElement(ContentTiles, this.props) : null, !hideStepsIndicator && aboveButtonStepsIndicator ? this.renderStepsIndicator() : null, this.renderActionButtons("end", content),
    /* Fullscreen dot-style step indicator should sit inside the
    main inner content to share its padding, which will be
    configurable with Bug 1956042 */
    !hideStepsIndicator && !aboveButtonStepsIndicator && !content.progress_bar && content.fullscreen ? this.renderStepsIndicator() : null), !hideStepsIndicator && !aboveButtonStepsIndicator && !(content.fullscreen && !content.progress_bar) ? this.renderStepsIndicator() : null)), /*#__PURE__*/external_React_default().createElement(Localized, {
      text: content.info_text
    }, /*#__PURE__*/external_React_default().createElement("span", {
      className: "info-text"
    })));
  }
}
;// ./content-src/lib/addUtmParams.mjs
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * BASE_PARAMS keys/values can be modified from outside this file
 */
const BASE_PARAMS = {
  utm_source: "activity-stream",
  utm_campaign: "firstrun",
  utm_medium: "referral",
};

/**
 * Takes in a url as a string or URL object and returns a URL object with the
 * utm_* parameters added to it. If a URL object is passed in, the paraemeters
 * are added to it (the return value can be ignored in that case as it's the
 * same object).
 */
function addUtmParams(url, utmTerm) {
  let returnUrl = url;
  if (typeof returnUrl === "string") {
    returnUrl = new URL(url);
  }
  for (let [key, value] of Object.entries(BASE_PARAMS)) {
    if (!returnUrl.searchParams.has(key)) {
      returnUrl.searchParams.append(key, value);
    }
  }
  if (!returnUrl.searchParams.has("utm_term")) {
    returnUrl.searchParams.append("utm_term", utmTerm);
  }
  return returnUrl;
}

;// ./content-src/components/MultiStageAboutWelcome.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */









// Amount of milliseconds for all transitions to complete (including delays).
const TRANSITION_OUT_TIME = 1000;
const LANGUAGE_MISMATCH_SCREEN_ID = "AW_LANGUAGE_MISMATCH";
const MultiStageAboutWelcome = props => {
  const gateInitialPaint = props.gateInitialPaint ?? false;
  let {
    defaultScreens
  } = props;
  const didFilter = (0,external_React_namespaceObject.useRef)(false);
  const [didMount, setDidMount] = (0,external_React_namespaceObject.useState)(false);
  const [contentToggleChecked, setContentToggleChecked] = (0,external_React_namespaceObject.useState)(true);
  const [screens, setScreens] = (0,external_React_namespaceObject.useState)(defaultScreens);
  const [index, setScreenIndex] = (0,external_React_namespaceObject.useState)(props.startScreen);
  const [previousOrder, setPreviousOrder] = (0,external_React_namespaceObject.useState)(props.startScreen - 1);
  // Gate first paint until we've finished the initial filtering pass.
  const [ready, setReady] = (0,external_React_namespaceObject.useState)(false);
  (0,external_React_namespaceObject.useEffect)(() => {
    (async () => {
      // If we want to load index from history state, we don't want to send impression yet
      if (!didMount) {
        return;
      }
      // On about:welcome first load, screensVisited should be empty
      let screensVisited = didFilter.current ? screens.slice(0, index) : [];
      let upcomingScreens = defaultScreens.filter(s => !screensVisited.find(v => v.id === s.id))
      // Filter out Language Mismatch screen from upcoming
      // screens if screens set from useLanguageSwitcher hook
      // has filtered language screen
      .filter(upcomingScreen => !(!screens.find(s => s.id === LANGUAGE_MISMATCH_SCREEN_ID) && upcomingScreen.id === LANGUAGE_MISMATCH_SCREEN_ID));
      let filteredScreens = screensVisited.concat((await window.AWEvaluateScreenTargeting(upcomingScreens)) ?? upcomingScreens);

      // Use existing screen for the filtered screen to carry over any modification
      // e.g. if AW_LANGUAGE_MISMATCH exists, use it from existing screens
      setScreens(filteredScreens.map(filtered => screens.find(s => s.id === filtered.id) ?? filtered));
      // Mark the initial filter pass complete and allow the first paint.
      if (!didFilter.current) {
        didFilter.current = true;
        setReady(true);
      }

      // After completing screen filtering, trigger any unhandled campaign
      // action present in the attribution campaign data. This updates the
      // "trailhead.firstrun.didHandleCampaignAction" preference, marking the
      // actions as complete to prevent them from being handled on subsequent
      // visits to about:welcome. Do not await getting the action to avoid
      // blocking the thread.
      window.AWGetUnhandledCampaignAction?.().then(action => {
        if (typeof action === "string") {
          MultiStageUtils.handleCampaignAction(action, props.message_id);
        }
      }).catch(error => {
        console.error("Failed to get unhandled campaign action:", error);
      });
      const screenInitials = filteredScreens.map(({
        id
      }) => id?.split("_")[1]?.[0]).join("");
      // Send impression ping when respective screen first renders
      // eslint-disable-next-line no-shadow
      filteredScreens.forEach((screen, order) => {
        if (index === order) {
          const messageId = `${props.message_id}_${order}_${screen.id}_${screenInitials}`;
          MultiStageUtils.sendImpressionTelemetry(messageId, {
            screen_family: props.message_id,
            screen_index: order,
            screen_id: screen.id,
            screen_initials: screenInitials
          });

          // Impression actions should be fired before recording the
          // impression, so the check that ensures that actions run only once
          // has an accurate count of how many impressions have actually occured
          if (screen.content?.impression_action) {
            MultiStageUtils.handleImpressionAction(screen.content.impression_action, messageId, screen.id);
          }
          window.AWAddScreenImpression?.(screen);
        }
      });

      // Remember that a new screen has loaded for browser navigation
      if (props.updateHistory && index > window.history.state) {
        window.history.pushState(index, "");
      }

      // Remember the previous screen index so we can animate the transition
      setPreviousOrder(index);
    })();
  }, [index, didMount]); // eslint-disable-line react-hooks/exhaustive-deps

  const [flowParams, setFlowParams] = (0,external_React_namespaceObject.useState)(null);
  const {
    metricsFlowUri
  } = props;
  (0,external_React_namespaceObject.useEffect)(() => {
    (async () => {
      if (metricsFlowUri) {
        setFlowParams(await MultiStageUtils.fetchFlowParams(metricsFlowUri));
      }
    })();
  }, [metricsFlowUri]);

  // Allow "in" style to render to actually transition towards regular state,
  // which also makes using browser back/forward navigation skip transitions.
  const [transition, setTransition] = (0,external_React_namespaceObject.useState)(props.transitions ? "in" : "");
  (0,external_React_namespaceObject.useEffect)(() => {
    if (transition === "in") {
      requestAnimationFrame(() => requestAnimationFrame(() => setTransition("")));
    }
  }, [transition]);

  // Transition to next screen, opening about:home on last screen button CTA
  const handleTransition = goBack => {
    // Only handle transitioning out from a screen once.
    if (transition === "out") {
      return;
    }

    // Start transitioning things "out" immediately when moving forwards.
    setTransition(props.transitions ? "out" : "");

    // Actually move forwards after all transitions finish.
    setTimeout(() => {
      if (goBack) {
        setTransition(props.transitions ? "in" : "");
        setScreenIndex(prevState => prevState - 1);
      } else if (index < screens.length - 1) {
        setTransition(props.transitions ? "in" : "");
        setScreenIndex(prevState => prevState + 1);
      } else {
        window.AWFinish();
      }
    }, props.transitions ? TRANSITION_OUT_TIME : 0);
  };
  (0,external_React_namespaceObject.useEffect)(() => {
    // When about:welcome loads (on refresh or pressing back button
    // from about:home), ensure history state usEffect runs before
    // useEffect hook that send impression telemetry
    setDidMount(true);
    if (props.updateHistory) {
      // Switch to the screen tracked in state (null for initial state)
      // or last screen index if a user navigates by pressing back
      // button from about:home
      const handler = ({
        state
      }) => {
        if (transition === "out") {
          return;
        }
        setTransition(props.transitions ? "out" : "");
        setTimeout(() => {
          setTransition(props.transitions ? "in" : "");
          setScreenIndex(Math.min(state, screens.length - 1));
        }, props.transitions ? TRANSITION_OUT_TIME : 0);
      };

      // Handle page load, e.g., going back to about:welcome from about:home
      const {
        state
      } = window.history;
      if (state) {
        setScreenIndex(Math.min(state, screens.length - 1));
        setPreviousOrder(Math.min(state, screens.length - 1));
      }

      // Watch for browser back/forward button navigation events
      window.addEventListener("popstate", handler);
      return () => window.removeEventListener("popstate", handler);
    }
    return false;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [multiSelects, setMultiSelects] = (0,external_React_namespaceObject.useState)({});

  // Save the active multi select state for each screen as an object keyed by
  // screen id. Each screen id has an array containing checkbox ids used in
  // handleAction to update MULTI_ACTION data. This allows us to remember the
  // state of each screen's multi select checkboxes when navigating back and
  // forth between screens, while also allowing a message to have more than one
  // multi select screen.
  const [activeMultiSelects, setActiveMultiSelects] = (0,external_React_namespaceObject.useState)({});

  // Save the active single select state for each screen as an object keyed
  // by screen id. Similar to above, this allows us to remember the state of
  // each screen's single select picker when navigating back and forth between
  // screens, and allows us to have multiple single selects on a screen.
  const [activeSingleSelectSelections, setActiveSingleSelectSelections] = (0,external_React_namespaceObject.useState)({});

  // Save textarea inputs for each screen as an object keyed by screen id. It's
  // structured like this: { screenId: { textareaId: { value, isValid } } }
  const [textInputs, setTextInputs] = (0,external_React_namespaceObject.useState)({});

  // Whether animated backgrounds/illustrations are paused for this session.
  // Defaults to paused when the user has prefers-reduced-motion: reduce set,
  // so we never autoplay motion for those users. The toggle stays consistent
  // among screens once the user interacts with it.
  const [animationsPaused, setAnimationsPaused] = (0,external_React_namespaceObject.useState)(() => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false);
  const toggleAnimationsPaused = () => setAnimationsPaused(prev => !prev);

  // Get the active theme so the rendering code can make it selected
  // by default.
  const [activeTheme, setActiveTheme] = (0,external_React_namespaceObject.useState)(null);
  const [initialTheme, setInitialTheme] = (0,external_React_namespaceObject.useState)(null);
  (0,external_React_namespaceObject.useEffect)(() => {
    (async () => {
      let theme = await window.AWGetSelectedTheme();
      setInitialTheme(theme);
      setActiveTheme(theme);
    })();
  }, []);
  const {
    negotiatedLanguage,
    langPackInstallPhase,
    languageFilteredScreens
  } = useLanguageSwitcher(props.appAndSystemLocaleInfo, screens, index, setScreenIndex);
  (0,external_React_namespaceObject.useEffect)(() => {
    setScreens(languageFilteredScreens);
  }, [languageFilteredScreens]);
  const [installedAddons, setInstalledAddons] = (0,external_React_namespaceObject.useState)(null);
  (0,external_React_namespaceObject.useEffect)(() => {
    (async () => {
      let addons = await window.AWGetInstalledAddons();
      setInstalledAddons(addons);
    })();
  }, [index]);

  // Do not render anything until the first filtering pass completes if gating
  // initial paint is enabled.
  if (gateInitialPaint && !ready) {
    return null;
  }
  return /*#__PURE__*/external_React_default().createElement((external_React_default()).Fragment, null, /*#__PURE__*/external_React_default().createElement("div", {
    className: `outer-wrapper onboardingContainer proton transition-${transition}`,
    style: props.backdrop ? {
      background: props.backdrop
    } : {}
  }, screens.map((currentScreen, order) => {
    const isFirstScreen = currentScreen === screens[0];
    const isLastScreen = currentScreen === screens[screens.length - 1];
    const totalNumberOfScreens = screens.length;
    const isSingleScreen = totalNumberOfScreens === 1;
    const setActiveMultiSelect = (valueOrFn, multiSelectId) => {
      setActiveMultiSelects(prevState => {
        const currentScreenSelections = prevState[currentScreen.id] || {};
        return {
          ...prevState,
          [currentScreen.id]: {
            ...currentScreenSelections,
            [multiSelectId]: typeof valueOrFn === "function" ? valueOrFn(currentScreenSelections[multiSelectId]) : valueOrFn
          }
        };
      });
    };
    const setScreenMultiSelects = (valueOrFn, multiSelectId) => {
      setMultiSelects(prevState => {
        const currentMultiSelects = prevState[currentScreen.id] || {};
        return {
          ...prevState,
          [currentScreen.id]: {
            ...currentMultiSelects,
            [multiSelectId]: typeof valueOrFn === "function" ? valueOrFn(currentMultiSelects[multiSelectId]) : valueOrFn
          }
        };
      });
    };
    const setActiveSingleSelectSelection = (valueOrFn, singleSelectId) => {
      setActiveSingleSelectSelections(prevState => {
        const currentScreenSelections = prevState[currentScreen.id] || {};
        return {
          ...prevState,
          [currentScreen.id]: {
            ...currentScreenSelections,
            [singleSelectId]: typeof valueOrFn === "function" ? valueOrFn(prevState[currentScreen.id]) : valueOrFn
          }
        };
      });
    };
    const setTextInput = (value, inputId) => {
      setTextInputs(prevState => {
        const currentScreenInputs = prevState[currentScreen.id] || {};
        return {
          ...prevState,
          [currentScreen.id]: {
            ...currentScreenInputs,
            [inputId]: value
          }
        };
      });
    };
    return index === order ? /*#__PURE__*/external_React_default().createElement(WelcomeScreen, {
      key: currentScreen.id + order,
      id: currentScreen.id,
      totalNumberOfScreens: totalNumberOfScreens,
      isFirstScreen: isFirstScreen,
      isLastScreen: isLastScreen,
      isSingleScreen: isSingleScreen,
      order: order,
      previousOrder: previousOrder,
      content: currentScreen.content,
      navigate: handleTransition,
      autoAdvance: currentScreen.auto_advance,
      advanceOnExperimentLoad: currentScreen.advance_on_experiment_load,
      messageId: `${props.message_id}_${order}_${currentScreen.id}`,
      UTMTerm: props.utm_term,
      flowParams: flowParams,
      activeTheme: activeTheme,
      initialTheme: initialTheme,
      setActiveTheme: setActiveTheme,
      setInitialTheme: setInitialTheme,
      screenMultiSelects: multiSelects[currentScreen.id],
      setScreenMultiSelects: setScreenMultiSelects,
      activeMultiSelect: activeMultiSelects[currentScreen.id],
      setActiveMultiSelect: setActiveMultiSelect,
      activeSingleSelectSelections: activeSingleSelectSelections[currentScreen.id],
      setActiveSingleSelectSelection: setActiveSingleSelectSelection,
      textInputs: textInputs[currentScreen.id],
      setTextInput: setTextInput,
      contentToggleChecked: contentToggleChecked,
      setContentToggleChecked: setContentToggleChecked,
      negotiatedLanguage: negotiatedLanguage,
      langPackInstallPhase: langPackInstallPhase,
      forceHideStepsIndicator: currentScreen.force_hide_steps_indicator,
      ariaRole: props.ariaRole,
      requireAction: props.requireAction,
      aboveButtonStepsIndicator: currentScreen.above_button_steps_indicator,
      installedAddons: installedAddons,
      setInstalledAddons: setInstalledAddons,
      addonId: props.addonId,
      addonType: props.addonType,
      addonName: props.addonName,
      addonURL: props.addonURL,
      addonIconURL: props.addonIconURL,
      themeScreenshots: props.themeScreenshots,
      isRtamo: currentScreen.content.isRtamo,
      animationsPaused: animationsPaused,
      toggleAnimationsPaused: toggleAnimationsPaused
    }) : null;
  })));
};
const renderSingleSecondaryCTAButton = ({
  content,
  button,
  targetElement,
  position,
  handleAction,
  activeMultiSelect,
  textInputs,
  isArrayItem,
  index = null
}) => {
  let buttonStyling = button?.has_arrow_icon ? `secondary arrow-icon` : `secondary`;
  const isPrimary = button?.style === "primary";
  const isTextLink = !["split", "callout"].includes(content.position) && content.tiles?.type !== "addons-picker" && !isPrimary;
  const isSplitButton = content.submenu_button?.attached_to === targetElement;
  let className = "secondary-cta";
  if (position) {
    className += ` ${position}`;
  }
  if (isSplitButton) {
    className += " split-button-container";
  }
  const computeDisabled = disabledValue => {
    if (disabledValue === "hasActiveMultiSelect") {
      if (!activeMultiSelect) {
        return true;
      }
      for (const key in activeMultiSelect) {
        if (activeMultiSelect[key]?.length > 0) {
          return false;
        }
      }
      return true;
    }
    if (disabledValue === "hasTextInput") {
      // For text input, we check if the user has entered any text in the
      // textarea(s) present on the screen.
      if (!textInputs) {
        return true;
      }
      return Object.values(textInputs).every(input => !input.isValid || input.value.trim().length === 0);
    }
    return disabledValue;
  };
  if (isTextLink) {
    buttonStyling += " text-link";
  }
  if (isPrimary) {
    buttonStyling = button?.has_arrow_icon ? `primary arrow-icon` : `primary`;
  }

  // We have to provide handleAction with the expected action here,
  // since the data doesn't actually exist in JSON content
  const shimmedHandleAction = event => {
    if (isArrayItem && button?.action) {
      return handleAction(event, button.action);
    }
    return handleAction(event);
  };
  let buttonId = "secondary_button";
  buttonId += index !== null ? `_${index}` : "";
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: className,
    key: targetElement
  }, /*#__PURE__*/external_React_default().createElement(Localized, {
    text: button?.text
  }, /*#__PURE__*/external_React_default().createElement("span", null)), /*#__PURE__*/external_React_default().createElement(Localized, {
    text: button?.label
  }, /*#__PURE__*/external_React_default().createElement("button", {
    id: buttonId,
    className: buttonStyling,
    value: targetElement,
    disabled: computeDisabled(button?.disabled),
    onClick: shimmedHandleAction
  })), isSplitButton ? /*#__PURE__*/external_React_default().createElement(SubmenuButton, {
    content: content,
    handleAction: handleAction
  }) : null);
};
const SecondaryCTA = props => {
  const {
    content,
    position
  } = props;
  const targetElement = position ? `secondary_button_${position}` : "secondary_button";
  const buttonData = content[targetElement];
  if (!buttonData) {
    return null;
  }
  const buttons = external_React_default().useMemo(() => Array.isArray(buttonData) ? buttonData : [buttonData], [buttonData]);
  const [visibleButtons, setVisibleButtons] = external_React_default().useState([]);
  external_React_default().useEffect(() => {
    (async () => {
      const filteredButtons = [];
      for (const button of buttons) {
        // No targeting, show by default for backwards compatibility
        if (!button?.targeting) {
          filteredButtons.push(button);
          continue;
        }
        try {
          const shouldShowButton = await window.AWEvaluateAttributeTargeting(button.targeting);
          if (shouldShowButton) {
            filteredButtons.push(button);
          }
        } catch (e) {
          console.error("SecondaryCTA targeting failed:", button.targeting, e);
        }
      }
      setVisibleButtons(filteredButtons);
    })();
  }, [buttons]);
  if (!visibleButtons.length) {
    return null;
  }
  if (Array.isArray(buttonData)) {
    return /*#__PURE__*/external_React_default().createElement("div", {
      className: "secondary-buttons-top-container"
    }, visibleButtons.map((button, index) => renderSingleSecondaryCTAButton({
      content,
      button,
      targetElement: `${targetElement}_${index}`,
      position,
      handleAction: props.handleAction,
      activeMultiSelect: props.activeMultiSelect,
      textInputs: props.textInputs,
      isArrayItem: true,
      index
    })));
  }
  return renderSingleSecondaryCTAButton({
    content,
    button: visibleButtons[0],
    targetElement,
    position,
    handleAction: props.handleAction,
    activeMultiSelect: props.activeMultiSelect,
    textInputs: props.textInputs,
    isArrayItem: false
  });
};
const StepsIndicator = props => {
  let steps = [];
  for (let i = 0; i < props.totalNumberOfScreens; i++) {
    let className = `${i === props.order ? "current" : ""} ${i < props.order ? "complete" : ""}`;
    steps.push(/*#__PURE__*/external_React_default().createElement("div", {
      key: i,
      className: `indicator ${className}`,
      role: "presentation"
    }));
  }
  return steps;
};
const ProgressBar = ({
  step,
  previousStep,
  totalNumberOfScreens
}) => {
  const [progress, setProgress] = external_React_default().useState(previousStep / totalNumberOfScreens);
  (0,external_React_namespaceObject.useEffect)(() => {
    // We don't need to hook any dependencies because any time the step changes,
    // the screen's entire DOM tree will be re-rendered.
    setProgress(step / totalNumberOfScreens);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "indicator",
    role: "presentation",
    style: {
      "--progress-bar-progress": `${progress * 100}%`
    }
  });
};
class WelcomeScreen extends (external_React_default()).PureComponent {
  constructor(props) {
    super(props);
    this.handleAction = this.handleAction.bind(this);
  }
  handleOpenURL(action, flowParams, UTMTerm) {
    let {
      type,
      data
    } = action;
    if (type === "SHOW_FIREFOX_ACCOUNTS") {
      let params = {
        ...BASE_PARAMS,
        utm_term: `${UTMTerm}-screen`
      };
      if (action.addFlowParams && flowParams) {
        params = {
          ...params,
          ...flowParams
        };
      }
      data = {
        ...data,
        extraParams: {
          ...params,
          ...data?.extraParams
        }
      };
    } else if (type === "OPEN_URL") {
      let url = new URL(data.args);
      addUtmParams(url, `${UTMTerm}-screen`);
      if (action.addFlowParams && flowParams) {
        url.searchParams.append("device_id", flowParams.deviceId);
        url.searchParams.append("flow_id", flowParams.flowId);
        url.searchParams.append("flow_begin_time", flowParams.flowBeginTime);
      }
      data = {
        ...data,
        args: url.toString()
      };
    }
    return MultiStageUtils.handleUserAction({
      type,
      data
    });
  }
  async handleMigrationIfNeeded(action, props) {
    const hasMigrate = a => a.type === "SHOW_MIGRATION_WIZARD" || a.type === "MULTI_ACTION" && a.data?.actions?.some(hasMigrate);
    if (hasMigrate(action)) {
      await window.AWWaitForMigrationClose();
      MultiStageUtils.sendActionTelemetry(props.messageId, "migrate_close", "CLICK_BUTTON");
    }
  }
  applyThemeIfNeeded(action, event) {
    if (!action.theme) {
      return;
    }
    const themeToUse = action.theme === "<event>" ? event.currentTarget.value : this.props.initialTheme || action.theme;
    this.props.setActiveTheme(themeToUse);
    window.AWSelectTheme(themeToUse);
  }
  handlePickerAction(value) {
    const tileGroups = Array.isArray(this.props.content.tiles) ? this.props.content.tiles : [this.props.content.tiles];
    for (const tile of tileGroups) {
      if (!tile?.data) {
        continue;
      }
      for (const opt of tile.data) {
        if (opt.id === value) {
          MultiStageUtils.handleUserAction(opt.action);
          return;
        }
      }
    }
  }
  resolveActionFromContent(value, event, props) {
    if (["submenu_button", "more_button", "tile_button"].includes(value) && event.action) {
      return event.action;
    }
    const {
      content
    } = props;
    const targetContent = content[value] || content.tiles || content.languageSwitcher;
    if (!targetContent) {
      return null;
    }
    if (Array.isArray(targetContent)) {
      for (const tile of targetContent) {
        const matchedTile = tile.data.find(t => t.id === value);
        if (matchedTile?.action) {
          return matchedTile.action;
        }
      }
      return null;
    }
    return targetContent.action ?? null;
  }
  async handleAction(event, providedAction = null) {
    const {
      props
    } = this;
    const value = event.currentTarget.value ?? event.currentTarget.getAttribute("value");
    const source = event.source || value;
    let action = providedAction || this.resolveActionFromContent(value, event, props);
    let actionResult;
    if (!action) {
      console.error("Failed to resolve action");
      return actionResult;
    }
    action = JSON.parse(JSON.stringify(action));
    const context = {};
    if (action.collectContentToggleState) {
      context.contentToggleState = props.contentToggleChecked;
    }
    MultiStageUtils.sendActionTelemetry(props.messageId, source, event.name, context);
    if (value === "dismiss_button" && !event.name) {
      MultiStageUtils.sendDismissTelemetry(props.messageId, source);
    }
    if (action.collectSelect) {
      this.setMultiSelectActions(action);
    }
    if (action.collectTextInput && Object.values(props.textInputs).length) {
      this.setTextInputActions(action);
    }
    if (["OPEN_URL", "SHOW_FIREFOX_ACCOUNTS"].includes(action.type)) {
      this.handleOpenURL(action, props.flowParams, props.UTMTerm);
    } else if (action.type === "INSTALL_ADDON_FROM_URL") {
      const url = props.addonURL && props.isRtamo ? props.addonURL : action.data?.url;
      // Set add-on url in action.data.url property from JSON
      action.data = {
        ...action.data,
        url
      };
      MultiStageUtils.handleUserAction(action);
    } else if (action.type) {
      let actionPromise = MultiStageUtils.handleUserAction(action);
      if (action.needsAwait) {
        actionResult = await actionPromise;
      }
      if (action.type === "FXA_SIGNIN_FLOW") {
        MultiStageUtils.sendActionTelemetry(props.messageId, actionResult ? "sign_in" : "sign_in_cancel", "FXA_SIGNIN_FLOW");
      }
      // Wait until migration closes to complete the action
      await this.handleMigrationIfNeeded(action, props);
    }

    // A special tiles.action.theme value indicates we should use the event's value vs provided value.
    this.applyThemeIfNeeded(action, event);
    if (action.picker) {
      this.handlePickerAction(value);
    }

    // If the action has persistActiveTheme: true, we set the initial theme to the currently active theme
    // so that it can be reverted to in the event that the user navigates away from the screen
    if (action.persistActiveTheme) {
      this.props.setInitialTheme(this.props.activeTheme);
    }

    // `navigate`, `goBack` and `dismiss` can be true/false/undefined, or they can be a
    // string "actionResult" in which case we should use the actionResult
    // (boolean resolved by handleUserAction)
    const shouldDoBehavior = behavior => {
      if (behavior !== "actionResult") {
        return behavior;
      }
      if (action.needsAwait) {
        return actionResult;
      }
      console.error("actionResult is only supported for actions with needsAwait");
      return false;
    };
    if (shouldDoBehavior(action.navigate)) {
      props.navigate(action.goBack);
    }

    // Used by FeatureCallout to advance screens by re-rendering the whole
    // wrapper, updating anchor, page_event_listeners, etc. `navigate` only
    // updates the inner content. Only implemented by FeatureCallout.
    if (action.advance_screens) {
      if (shouldDoBehavior(action.advance_screens.behavior ?? true)) {
        window.AWAdvanceScreens?.(action.advance_screens);
      }
    }
    if (shouldDoBehavior(action.dismiss)) {
      window.AWFinish();
    }
    return actionResult;
  }
  setMultiSelectActions(action) {
    let {
      props
    } = this;
    // Populate MULTI_ACTION data actions property with selected checkbox
    // actions from tiles data
    if (action.type !== "MULTI_ACTION") {
      console.error("collectSelect is only supported for MULTI_ACTION type actions");
      action.type = "MULTI_ACTION";
    }
    if (!Array.isArray(action.data?.actions)) {
      console.error("collectSelect is only supported for MULTI_ACTION type actions with an array of actions");
      action.data = {
        actions: []
      };
    }

    // Prepend the multi-select actions to the CTA's actions array, but keep
    // the actions in the same order they appear in. This way the CTA action
    // can go last, after the multi-select actions are processed. For example,
    // 1. checkbox action 1
    // 2. checkbox action 2
    // 3. radio action
    // 4. CTA action (which perhaps depends on the radio action)
    // Note, this order is only guaranteed if action.data has the
    // `orderedExecution` flag set to true.
    let multiSelectActions = [];
    const processTile = (tile, tileIndex) => {
      if (tile?.type !== "multiselect" || !Array.isArray(tile.data)) {
        return;
      }
      const multiSelectId = `tile-${tileIndex}`;
      const activeSelections = props.activeMultiSelect[multiSelectId] || [];
      for (const checkbox of tile.data) {
        let checkboxAction;
        if (activeSelections.includes(checkbox.id)) {
          checkboxAction = checkbox.checkedAction ?? checkbox.action;
        } else {
          checkboxAction = checkbox.uncheckedAction;
        }
        if (checkboxAction) {
          multiSelectActions.push(checkboxAction);
        }
      }
    };

    // Process tiles (this may be a single tile object or an array consisting of
    // tile objects)
    if (props.content?.tiles) {
      if (Array.isArray(props.content.tiles)) {
        props.content.tiles.forEach(processTile);
      } else {
        // Handle case where tiles is a single tile object
        processTile(props.content.tiles, 0);
      }
    }

    // Prepend the collected multi-select actions to the CTA's actions array
    action.data.actions.unshift(...multiSelectActions);
    for (const value of Object.values(props.activeMultiSelect)) {
      // Send telemetry with selected checkbox ids
      MultiStageUtils.sendActionTelemetry(props.messageId, value.flat(), "SELECT_CHECKBOX");
    }
  }
  setTextInputActions(action) {
    let {
      props
    } = this;
    if (action.type !== "MULTI_ACTION") {
      console.error("collectTextInput is only supported for MULTI_ACTION type actions");
      action.type = "MULTI_ACTION";
    }
    if (!Array.isArray(action.data?.actions)) {
      console.error("collectTextInput is only supported for MULTI_ACTION type actions with an array of actions");
      action.data = {
        actions: []
      };
    }
    const collectedActions = [];

    // If there is no character_limit, we still need to limit the size of the
    // input to avoid sending huge payloads. We'll go with 8KB.
    const truncateToByteSize = (str, maxBytes) => {
      const encoder = new TextEncoder();
      const encoded = encoder.encode(str);
      if (encoded.length <= maxBytes) {
        return str;
      }
      let end = maxBytes;
      // Step back until we find a valid UTF-8 start byte
      while (end > 0 && (encoded[end] & 0b11000000) === 0b10000000) {
        end--; // this is a continuation byte
      }
      return new TextDecoder().decode(encoded.subarray(0, end));
    };
    const processTile = (tile, tileIndex) => {
      if (tile?.type !== "textarea" || !tile.data) {
        return;
      }
      const inputId = tile.data.id || `tile-${tileIndex}`;
      const inputData = props.textInputs[inputId];
      if (inputData?.isValid && inputData.value.trim().length) {
        if (tile.data.action) {
          collectedActions.push(tile.data.action);
        }
        MultiStageUtils.sendActionTelemetry(props.messageId, inputId, "TEXT_INPUT", {
          value: truncateToByteSize(inputData.value, 8192)
        });
      }
    };
    if (props.content?.tiles) {
      if (Array.isArray(props.content.tiles)) {
        for (const [index, tile] of props.content.tiles.entries()) {
          processTile(tile, index);
        }
      } else {
        processTile(props.content.tiles, 0);
      }
    }
    action.data.actions.unshift(...collectedActions);
  }
  render() {
    return /*#__PURE__*/external_React_default().createElement(MultiStageProtonScreen, {
      content: this.props.content,
      id: this.props.id,
      order: this.props.order,
      previousOrder: this.props.previousOrder,
      activeTheme: this.props.activeTheme,
      installedAddons: this.props.installedAddons,
      screenMultiSelects: this.props.screenMultiSelects,
      setScreenMultiSelects: this.props.setScreenMultiSelects,
      activeMultiSelect: this.props.activeMultiSelect,
      setActiveMultiSelect: this.props.setActiveMultiSelect,
      activeSingleSelectSelections: this.props.activeSingleSelectSelections,
      setActiveSingleSelectSelection: this.props.setActiveSingleSelectSelection,
      textInputs: this.props.textInputs,
      setTextInput: this.props.setTextInput,
      contentToggleChecked: this.props.contentToggleChecked,
      setContentToggleChecked: this.props.setContentToggleChecked,
      totalNumberOfScreens: this.props.totalNumberOfScreens,
      appAndSystemLocaleInfo: this.props.appAndSystemLocaleInfo,
      negotiatedLanguage: this.props.negotiatedLanguage,
      langPackInstallPhase: this.props.langPackInstallPhase,
      handleAction: this.handleAction,
      messageId: this.props.messageId,
      isFirstScreen: this.props.isFirstScreen,
      isLastScreen: this.props.isLastScreen,
      isSingleScreen: this.props.isSingleScreen,
      startsWithCorner: this.props.startsWithCorner,
      autoAdvance: this.props.autoAdvance,
      advanceOnExperimentLoad: this.props.advanceOnExperimentLoad,
      navigate: this.props.navigate,
      forceHideStepsIndicator: this.props.forceHideStepsIndicator,
      ariaRole: this.props.ariaRole,
      requireAction: this.props.requireAction,
      aboveButtonStepsIndicator: this.props.aboveButtonStepsIndicator,
      addonId: this.props.addonId,
      addonType: this.props.addonType,
      addonName: this.props.addonName,
      addonURL: this.props.addonURL,
      addonIconURL: this.props.addonIconURL,
      themeScreenshots: this.props.themeScreenshots,
      isRtamo: this.props.content.isRtamo,
      animationsPaused: this.props.animationsPaused,
      toggleAnimationsPaused: this.props.toggleAnimationsPaused
    });
  }
}
;// ./content-src/asrouter-newtab-multistage.jsx
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */




function MultistageWithDismiss({
  config,
  handleDismiss,
  handleBlock
}) {
  function onDismiss() {
    handleBlock?.();
    handleDismiss?.();
  }
  return /*#__PURE__*/external_React_default().createElement("div", {
    className: "multistage-newtab-wrapper"
  }, /*#__PURE__*/external_React_default().createElement("moz-button", {
    type: "icon ghost",
    size: "small",
    iconsrc: "chrome://global/skin/icons/close.svg",
    "data-l10n-id": "newtab-activation-window-message-dismiss-button",
    onClick: onDismiss
  }), /*#__PURE__*/external_React_default().createElement(MultiStageAboutWelcome, {
    defaultScreens: config.screens,
    message_id: config.id,
    transitions: config.transitions ?? false,
    backdrop: config.backdrop,
    startScreen: 0,
    updateHistory: false
  }));
}
window.mountMultistageMessage = function mountMultistageMessage(container, props) {
  const {
    messageData,
    handleDismiss,
    handleBlock,
    handleClick
  } = props;
  const config = messageData.content;
  const awHandlers = {
    AWEvaluateScreenTargeting: screens => window.ASRouterMessage({
      type: "AW_EVALUATE_SCREEN_TARGETING",
      data: screens
    }),
    AWGetFeatureConfig: () => config,
    AWFinish: () => handleDismiss(),
    AWSendToParent: (handlerName, data) => window.ASRouterMessage({
      type: "USER_ACTION",
      data
    }),
    AWAddScreenImpression: screenObj => {
      window.ASRouterMessage({
        type: "AW_ADD_SCREEN_IMPRESSION",
        data: screenObj
      });
    },
    AWSendEventTelemetry: data => {
      if (data.event !== "IMPRESSION") {
        handleClick(data.event);
      }
    },
    AWGetSelectedTheme: () => Promise.resolve(),
    AWGetInstalledAddons: () => Promise.resolve()
  };
  for (const [handlerName, fn] of Object.entries(awHandlers)) {
    window[handlerName] = fn;
  }
  const root = (0,external_ReactDOM_namespaceObject.createRoot)(container);
  root.render(/*#__PURE__*/external_React_default().createElement(MultistageWithDismiss, {
    config: config,
    handleDismiss: handleDismiss,
    handleBlock: handleBlock
  }));
  return function cleanup() {
    root.unmount();
    for (const handlerName of Object.keys(awHandlers)) {
      delete window[handlerName];
    }
  };
};
/******/ })()
;