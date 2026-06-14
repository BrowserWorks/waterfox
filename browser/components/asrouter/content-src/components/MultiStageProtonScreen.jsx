/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import React, { useEffect, useState } from "react";
import { Localized } from "./MSLocalized";
import { MultiStageUtils } from "../lib/multistage-utils.mjs";
import {
  SecondaryCTA,
  StepsIndicator,
  ProgressBar,
} from "./MultiStageAboutWelcome";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { CTAParagraph } from "./CTAParagraph";
import { HeroImage } from "./HeroImage";
import { OnboardingVideo } from "./OnboardingVideo";
import { AdditionalCTA } from "./AdditionalCTA";
import { LinkParagraph } from "./LinkParagraph";
import { ContentTiles } from "./ContentTiles";
import { InstallButton } from "./InstallButton";
import { SubmenuButton } from "./SubmenuButton";

const DEFAULT_AUTO_ADVANCE_MS = 20000;

export const MultiStageProtonScreen = props => {
  const {
    autoAdvance,
    advanceOnExperimentLoad,
    handleAction,
    messageId,
    navigate,
    order,
  } = props;
  useEffect(() => {
    if (!autoAdvance && !advanceOnExperimentLoad) {
      return () => {};
    }

    if (autoAdvance) {
      const value = autoAdvance?.actionEl ?? autoAdvance;
      const timeout = autoAdvance?.actionTimeMS ?? DEFAULT_AUTO_ADVANCE_MS;

      const timer = setTimeout(() => {
        handleAction({
          currentTarget: {
            value,
          },
          name: "AUTO_ADVANCE",
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
      MultiStageUtils.sendActionTelemetry(
        messageId,
        "advance_on_experiment_load",
        "SPLASH_DISMISSED",
        { reason, screen_duration }
      );

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
      } catch (e) {
      } finally {
        experimentsDone = true;
        maybeAdvance();
      }
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(minTimerId);
      window.clearTimeout(maxTimerId);
    };
  }, [
    autoAdvance,
    advanceOnExperimentLoad,
    handleAction,
    messageId,
    order,
    navigate,
  ]);

  // Set narrow on an outer element to allow for use of SCSS outer selector and
  // consolidation of styles for small screen widths with those for messages
  // configured to always be narrow
  if (props.content.narrow) {
    document
      .querySelector("#multi-stage-message-root")
      ?.setAttribute("narrow", "");
  } else {
    // Clear narrow attribute in case it was set by a previous screen
    document
      .querySelector("#multi-stage-message-root")
      ?.removeAttribute("narrow");
  }

  function useMediaQuery(query) {
    const [doesMatch, setDoesMatch] = useState(
      () => window.matchMedia(query).matches
    );

    useEffect(() => {
      const mediaQueryList = window.matchMedia(query);
      const onChange = event => setDoesMatch(event.matches);

      mediaQueryList.addEventListener("change", onChange);
      return () => mediaQueryList.removeEventListener("change", onChange);
    }, [query]);

    return doesMatch;
  }

  const isWideScreen = useMediaQuery("(min-width: 800px)");

  return (
    <ProtonScreen
      content={props.content}
      id={props.id}
      order={props.order}
      activeTheme={props.activeTheme}
      installedAddons={props.installedAddons}
      screenMultiSelects={props.screenMultiSelects}
      setScreenMultiSelects={props.setScreenMultiSelects}
      activeMultiSelect={props.activeMultiSelect}
      setActiveMultiSelect={props.setActiveMultiSelect}
      activeSingleSelectSelections={props.activeSingleSelectSelections}
      setActiveSingleSelectSelection={props.setActiveSingleSelectSelection}
      textInputs={props.textInputs}
      setTextInput={props.setTextInput}
      contentToggleChecked={props.contentToggleChecked}
      setContentToggleChecked={props.setContentToggleChecked}
      totalNumberOfScreens={props.totalNumberOfScreens}
      handleAction={props.handleAction}
      isFirstScreen={props.isFirstScreen}
      isLastScreen={props.isLastScreen}
      isSingleScreen={props.isSingleScreen}
      previousOrder={props.previousOrder}
      autoAdvance={props.autoAdvance}
      advanceOnExperimentLoad={props.advanceOnExperimentLoad}
      navigate={props.navigate}
      isRtamo={props.isRtamo}
      addonId={props.addonId}
      addonType={props.addonType}
      addonName={props.addonName}
      addonURL={props.addonURL}
      addonIconURL={props.addonIconURL}
      themeScreenshots={props.themeScreenshots}
      messageId={props.messageId}
      negotiatedLanguage={props.negotiatedLanguage}
      langPackInstallPhase={props.langPackInstallPhase}
      forceHideStepsIndicator={props.forceHideStepsIndicator}
      ariaRole={props.ariaRole}
      aboveButtonStepsIndicator={props.aboveButtonStepsIndicator}
      requireAction={props.requireAction}
      isWideScreen={isWideScreen}
      animationsPaused={props.animationsPaused}
      toggleAnimationsPaused={props.toggleAnimationsPaused}
    />
  );
};

export const ProtonScreenActionButtons = props => {
  const {
    content,
    isRtamo,
    addonId,
    addonType,
    addonName,
    activeMultiSelect,
    activeSingleSelectSelections,
    textInputs,
    installedAddons,
  } = props;
  const defaultValue = content.checkbox?.defaultValue;

  const [isChecked, setIsChecked] = useState(defaultValue || false);
  const buttonRef = React.useRef(null);

  const shouldFocusButton = content?.primary_button?.should_focus_button;

  useEffect(() => {
    if (shouldFocusButton) {
      buttonRef.current?.focus();
    }
  }, [shouldFocusButton]);

  if (
    !content.primary_button &&
    !content.secondary_button &&
    !content.additional_button
  ) {
    return null;
  }

  if (isRtamo) {
    content.primary_button.label.string_id = addonType?.includes("theme")
      ? "return-to-amo-add-theme-label"
      : "mr1-return-to-amo-add-extension-label";
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
      return !Object.values(activeSingleSelectSelections).some(
        val => val && val !== "none"
      );
    }
    if (disabledValue === "hasTextInput") {
      // For text input, we check if the user has entered any text in the
      // textarea(s) present on the screen.
      if (!textInputs) {
        return true;
      }
      return Object.values(textInputs).every(
        input => !input.isValid || input.value.trim().length === 0
      );
    }
    return disabledValue;
  };

  return (
    <div
      className={`action-buttons ${
        content.additional_button ? "additional-cta-container" : ""
      }`}
      flow={content.additional_button?.flow}
      alignment={content.additional_button?.alignment}
    >
      {isRtamo ? (
        <InstallButton
          key={addonId}
          addonId={addonId}
          addonType={addonType}
          addonName={addonName}
          index={"primary_button"}
          handleAction={props.handleAction}
          installedAddons={installedAddons}
          install_label={content.primary_button.label}
          install_complete_label={content.primary_button.install_complete_label}
        />
      ) : (
        <Localized text={content.primary_button?.label}>
          <button
            ref={buttonRef}
            className={`${content.primary_button?.style ?? "primary"}${
              content.primary_button?.has_arrow_icon ? " arrow-icon" : ""
            }`}
            // Whether or not the checkbox is checked determines which action
            // should be handled. By setting value here, we indicate to
            // this.handleAction() where in the content tree it should take
            // the action to execute from.
            value={isChecked ? "checkbox" : "primary_button"}
            disabled={isPrimaryDisabled(content.primary_button?.disabled)}
            onClick={props.handleAction}
            data-l10n-args={
              addonName
                ? JSON.stringify({
                    "addon-name": addonName,
                  })
                : ""
            }
          />
        </Localized>
      )}
      {content.additional_button ? (
        <AdditionalCTA
          content={content}
          handleAction={props.handleAction}
          activeMultiSelect={activeMultiSelect}
          textInputs={textInputs}
        />
      ) : null}
      {content.checkbox ? (
        <div className="checkbox-container">
          <input
            type="checkbox"
            id="action-checkbox"
            checked={isChecked}
            onChange={() => {
              setIsChecked(!isChecked);
            }}
          ></input>
          <Localized text={content.checkbox.label}>
            <label htmlFor="action-checkbox"></label>
          </Localized>
        </div>
      ) : null}
      {content.secondary_button ? (
        <SecondaryCTA
          content={content}
          handleAction={props.handleAction}
          activeMultiSelect={activeMultiSelect}
          textInputs={textInputs}
        />
      ) : null}
    </div>
  );
};

export class ProtonScreen extends React.PureComponent {
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
    const dialogInitial =
      this.props.isFirstScreen && this.props.previousOrder < 0
        ? `dialog-initial`
        : ``;
    const dialogLast = this.props.isLastScreen ? `dialog-last` : ``;

    return `${screenClass} ${dialogInitial} ${dialogLast} ${includeNoodles ? `with-noodles` : ``}`;
  }

  renderTitle({ title, title_logo }) {
    const titleRef = this.props.requireAction
      ? input => {
          this.titleHeader = input;
        }
      : null;
    if (title_logo) {
      const { alignment, ...rest } = title_logo;
      return (
        <div
          className="inline-icon-container"
          alignment={alignment ?? "center"}
        >
          {this.renderPicture({ ...rest })}
          <Localized text={title}>
            <h1
              id="mainContentHeader"
              tabIndex={this.props.requireAction ? -1 : undefined}
              ref={titleRef}
            />
          </Localized>
        </div>
      );
    }
    return (
      <Localized text={title}>
        <h1
          id="mainContentHeader"
          tabIndex={this.props.requireAction ? -1 : undefined}
          ref={titleRef}
        />
      </Localized>
    );
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
    className = "logo-container",
  }) {
    function getLoadingStrategy() {
      for (let url of [
        imageURL,
        darkModeImageURL,
        reducedMotionImageURL,
        darkModeReducedMotionImageURL,
      ]) {
        if (MultiStageUtils.getLoadingStrategyFor(url) === "lazy") {
          return "lazy";
        }
      }
      return "eager";
    }

    const pictureStyle = {
      marginInline,
      marginBlock,
      ...style,
    };

    return (
      <picture className={className} style={pictureStyle}>
        {darkModeReducedMotionImageURL ? (
          <source
            srcset={darkModeReducedMotionImageURL}
            media="(prefers-color-scheme: dark) and (prefers-reduced-motion: reduce)"
          />
        ) : null}
        {darkModeImageURL ? (
          <source
            srcset={darkModeImageURL}
            media="(prefers-color-scheme: dark)"
          />
        ) : null}
        {reducedMotionImageURL ? (
          <source
            srcset={reducedMotionImageURL}
            media="(prefers-reduced-motion: reduce)"
          />
        ) : null}
        <Localized text={alt}>
          <div className="sr-only logo-alt" />
        </Localized>
        <img
          className="brand-logo"
          style={{ height, width }}
          src={imageURL}
          alt=""
          loading={getLoadingStrategy()}
          role={alt ? null : "presentation"}
        />
      </picture>
    );
  }

  renderNoodles() {
    return (
      <React.Fragment>
        <div className={"noodle orange-L"} />
        <div className={"noodle purple-C"} />
        <div className={"noodle solid-L"} />
        <div className={"noodle outline-L"} />
        <div className={"noodle yellow-circle"} />
      </React.Fragment>
    );
  }

  renderLanguageSwitcher() {
    return this.props.content.languageSwitcher ? (
      <LanguageSwitcher
        content={this.props.content}
        handleAction={this.props.handleAction}
        negotiatedLanguage={this.props.negotiatedLanguage}
        langPackInstallPhase={this.props.langPackInstallPhase}
        messageId={this.props.messageId}
      />
    ) : null;
  }

  renderDismissButton() {
    const { size, marginBlock, marginInline, label, background } =
      this.props.content.dismiss_button;
    return (
      <button
        className={`dismiss-button ${background ? "with-background" : ""}`}
        onClick={this.props.handleAction}
        value="dismiss_button"
        data-l10n-id={label?.string_id || "spotlight-dialog-close-button"}
        button-size={size}
        style={{ marginBlock, marginInline }}
      ></button>
    );
  }

  renderMoreButton() {
    return (
      <SubmenuButton
        content={this.props.content}
        handleAction={this.props.handleAction}
        buttonType="more"
      />
    );
  }

  renderStepsIndicator() {
    const {
      order,
      previousOrder,
      content,
      totalNumberOfScreens: total,
      aboveButtonStepsIndicator,
    } = this.props;
    const currentStep = (order ?? 0) + 1;
    const previousStep = (previousOrder ?? -1) + 1;
    return (
      <div
        id="steps"
        className={`steps${content.progress_bar ? " progress-bar" : ""}`}
        above-button={aboveButtonStepsIndicator ? "" : null}
        data-l10n-id={
          content.steps_indicator?.string_id ||
          "onboarding-welcome-steps-indicator-label"
        }
        data-l10n-args={JSON.stringify({
          current: currentStep,
          total: total ?? 0,
        })}
        data-l10n-attrs="aria-label"
        role="progressbar"
        aria-valuenow={currentStep}
        aria-valuemin={1}
        aria-valuemax={total}
      >
        {content.progress_bar ? (
          <ProgressBar
            step={currentStep}
            previousStep={previousStep}
            totalNumberOfScreens={total}
          />
        ) : (
          <StepsIndicator order={order} totalNumberOfScreens={total} />
        )}
      </div>
    );
  }

  // We consider a screen to have animated content when it includes both
  // default and _static versions of its background image or hero_image url.
  // The pause toggle swaps the rendered asset to the _static asset when activated.
  // Without _both_ default and static, there is nothing for the toggle to
  // switch to, so we don't render the toggle button at all.
  hasAnimatedContent(content) {
    return !!(
      (content.background && content.background_static) ||
      (content.hero_image?.url && content.hero_image?.static_url)
    );
  }

  getEffectiveBackground(content) {
    return this.props.animationsPaused && content.background_static
      ? content.background_static
      : content.background;
  }

  getEffectiveHeroImageUrl(content) {
    if (!content.hero_image) {
      return null;
    }
    return this.props.animationsPaused && content.hero_image.static_url
      ? content.hero_image.static_url
      : content.hero_image.url;
  }

  renderAnimationPlayPauseButton() {
    const { toggleAnimationsPaused } = this.props;
    const paused = !!this.props.animationsPaused;
    const labelId = paused
      ? "onboarding-animation-play-button"
      : "onboarding-animation-pause-button";
    return (
      <button
        className={`animation-play-pause-button${paused ? " paused" : ""}`}
        type="button"
        aria-pressed={paused}
        data-l10n-id={labelId}
        onClick={toggleAnimationsPaused}
      />
    );
  }

  renderSecondarySection(content) {
    const background = this.getEffectiveBackground(content);
    const heroImageUrl = this.getEffectiveHeroImageUrl(content);
    // pinnable_sites exposes its background through a custom property so the
    // stylesheet can swap the wide-layout image for a narrow gradient without
    // overriding an inline `background` shorthand.
    const tiles = Array.isArray(content.tiles)
      ? content.tiles
      : [content.tiles];
    const isPinnableSites = tiles.some(tile => tile?.type === "pinnable_sites");
    return (
      <div
        className={`section-secondary ${
          content.hide_secondary_section ? "with-secondary-section-hidden" : ""
        }`}
        style={
          background
            ? {
                [isPinnableSites ? "--pinnable-sites-bkg" : "background"]:
                  background,
                "--mr-secondary-background-position-y":
                  content.split_narrow_bkg_position,
              }
            : {}
        }
      >
        {content.dismiss_button && content.reverse_split
          ? this.renderDismissButton()
          : null}
        <Localized text={content.image_alt_text}>
          <div className="sr-only image-alt" role="img" />
        </Localized>
        {content.hero_image ? (
          <HeroImage url={heroImageUrl} />
        ) : (
          this.renderHeroText(content.hero_text)
        )}
        {this.hasAnimatedContent(content)
          ? this.renderAnimationPlayPauseButton()
          : null}
      </div>
    );
  }

  renderHeroText(hero_text) {
    if (!hero_text) {
      return null;
    }

    // Check if hero_text is a string or an object with string_id property
    // essentially checking if we're using old or new design
    const isSimpleText =
      typeof hero_text === "string" ||
      (typeof hero_text === "object" &&
        hero_text !== null &&
        ("string_id" in hero_text || "raw" in hero_text));

    const HeroTextWrapper = ({ children, className }) => (
      <React.Fragment>
        <div className={`message-text ${className}`}>
          <div className="spacer-top" />
          {children}
          <div className="spacer-bottom" />
        </div>
      </React.Fragment>
    );

    if (isSimpleText) {
      return (
        <HeroTextWrapper className="simple">
          <Localized text={hero_text}>
            <h1 />
          </Localized>
        </HeroTextWrapper>
      );
    }

    return (
      <HeroTextWrapper className="hero-text">
        <Localized text={hero_text.title}>
          <h1 />
        </Localized>
        {hero_text.subtitle && (
          <Localized text={hero_text.subtitle}>
            <h2 />
          </Localized>
        )}
      </HeroTextWrapper>
    );
  }

  renderOrderedContent(content) {
    const elements = [];
    for (const item of content) {
      switch (item.type) {
        case "text":
          elements.push(
            <LinkParagraph
              text_content={item}
              handleAction={this.props.handleAction}
            />
          );
          break;
        case "image":
          elements.push(
            this.renderPicture({
              imageURL: item.url,
              darkModeImageURL: item.darkModeImageURL,
              height: item.height,
              width: item.width,
              alt: item.alt_text,
              marginInline: item.marginInline,
              className: "inline-image",
            })
          );
      }
    }
    return <>{elements}</>;
  }

  renderRTAMOIcon(addonType, themeScreenshots, addonIconURL) {
    return (
      <div className="rtamo-icon">
        <img
          className={`${addonType?.includes("theme") ? "rtamo-theme-icon" : "brand-logo"}`}
          src={
            addonType?.includes("theme")
              ? themeScreenshots[0].url
              : addonIconURL
          }
          loading={MultiStageUtils.getLoadingStrategyFor(addonIconURL)}
          alt=""
          role="presentation"
        />
      </div>
    );
  }

  getCombinedInnerStyles(content, isWideScreen) {
    const CONFIGURABLE_STYLES = [
      "overflow",
      "display",
      "paddingInline",
      "paddingInlineStart",
      "paddingInlineEnd",
      "paddingBlock",
      "paddingBlockStart",
      "paddingBlockEnd",
    ];

    const innerContentStyles = isWideScreen
      ? content.main_content_style || {}
      : content.main_content_style_narrow || {};

    const validInnerStyles =
      MultiStageUtils.getValidStyle(innerContentStyles, CONFIGURABLE_STYLES) ||
      {};

    return {
      ...validInnerStyles,
      justifyContent: content.split_content_justify_content,
    };
  }

  getActionButtonsPosition(content) {
    const VALID_POSITIONS = [
      "after_subtitle",
      "after_supporting_content",
      "end",
    ];

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
    return this.getActionButtonsPosition(content) === position ? (
      <ProtonScreenActionButtons
        content={content}
        isRtamo={this.props.isRtamo}
        installedAddons={this.props.installedAddons}
        addonId={this.props.addonId}
        addonName={this.props.addonName}
        addonType={this.props.addonType}
        handleAction={this.props.handleAction}
        activeMultiSelect={this.props.activeMultiSelect}
        activeSingleSelectSelections={this.props.activeSingleSelectSelections}
        textInputs={this.props.textInputs}
      />
    ) : null;
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
      isWideScreen,
    } = this.props;
    const includeNoodles = content.has_noodles;
    // The default screen position is "center"
    const isCenterPosition = content.position === "center" || !content.position;
    const hideStepsIndicator =
      autoAdvance ||
      content?.video_container ||
      isSingleScreen ||
      forceHideStepsIndicator;
    const textColorClass = content.text_color
      ? `${content.text_color}-text`
      : "";
    // Assign proton screen style 'screen-1' or 'screen-2' to centered screens
    // by checking if screen order is even or odd.
    const screenClassName = isCenterPosition
      ? this.getScreenClassName(
          includeNoodles,
          content?.video_container,
          content.tiles?.type === "addons-picker"
        )
      : "";
    const isEmbeddedMigration = content.tiles?.type === "migration-wizard";
    const isSystemPromptStyleSpotlight =
      content.isSystemPromptStyleSpotlight === true;
    const combinedStyles = this.getCombinedInnerStyles(content, isWideScreen);

    return (
      <main
        className={`screen ${this.props.id || ""}
          ${screenClassName} ${textColorClass} ${
            content.transition_content ? "transition-content" : ""
          }`}
        reverse-split={content.reverse_split ? "" : null}
        fullscreen={content.fullscreen ? "" : null}
        style={
          content.screen_style &&
          MultiStageUtils.getValidStyle(content.screen_style, [
            "overflow",
            "display",
          ])
        }
        role={ariaRole ?? "alertdialog"}
        layout={content.layout}
        pos={content.position || "center"}
        tabIndex="-1"
        aria-labelledby={`mainContentHeader${content.subtitle ? " mainContentSubheader" : ""}`}
        aria-describedby="mainContentInner"
        ref={input => {
          this.mainContentHeader = input;
        }}
        no-rdm={content.no_rdm ? "" : null}
      >
        {isCenterPosition ? null : this.renderSecondarySection(content)}
        <div
          className={`section-main ${
            isEmbeddedMigration ? "embedded-migration" : ""
          }${isSystemPromptStyleSpotlight ? "system-prompt-spotlight" : ""}`}
          hide-secondary-section={
            content.hide_secondary_section
              ? String(content.hide_secondary_section)
              : null
          }
          role="document"
          style={
            content.screen_style &&
            MultiStageUtils.getValidStyle(content.screen_style, [
              "width",
              "padding",
              "height",
            ])
          }
        >
          {content.secondary_button_top ? (
            <SecondaryCTA
              content={content}
              handleAction={this.props.handleAction}
              position="top"
            />
          ) : null}
          {includeNoodles ? this.renderNoodles() : null}
          {content.more_button ? this.renderMoreButton() : null}
          {content.dismiss_button && !content.reverse_split
            ? this.renderDismissButton()
            : null}
          <div
            className={`main-content ${hideStepsIndicator ? "no-steps" : ""}`}
            style={{
              background:
                isCenterPosition && this.getEffectiveBackground(content)
                  ? this.getEffectiveBackground(content)
                  : null,
              width:
                content.width && content.position !== "split"
                  ? content.width
                  : null,
              paddingBlock: content.split_content_padding_block
                ? content.split_content_padding_block
                : null,
              paddingInline: content.split_content_padding_inline
                ? content.split_content_padding_inline
                : null,
            }}
          >
            {isCenterPosition && this.hasAnimatedContent(content)
              ? this.renderAnimationPlayPauseButton()
              : null}
            {content.logo && !content.fullscreen
              ? this.renderPicture(content.logo)
              : null}
            {isRtamo && !content.fullscreen
              ? this.renderRTAMOIcon(
                  addonType,
                  this.props.themeScreenshots,
                  this.props.addonIconURL
                )
              : null}
            <div
              className="main-content-inner"
              id="mainContentInner"
              style={combinedStyles}
            >
              {content.logo && content.fullscreen
                ? this.renderPicture(content.logo)
                : null}
              {isRtamo && content.fullscreen
                ? this.renderRTAMOIcon(
                    addonType,
                    this.props.themeScreenshots,
                    this.props.addonIconURL
                  )
                : null}
              {content.title || content.subtitle ? (
                <div
                  id="multi-stage-message-welcome-text"
                  className={`welcome-text ${content.title_style || ""}`}
                >
                  {content.title ? this.renderTitle(content) : null}

                  {content.subtitle ? (
                    <Localized text={content.subtitle}>
                      <h2
                        data-l10n-args={JSON.stringify({
                          "addon-name": this.props.addonName,
                          ...this.props.appAndSystemLocaleInfo?.displayNames,
                        })}
                        aria-flowto={
                          this.props.messageId?.includes("FEATURE_TOUR")
                            ? "steps"
                            : ""
                        }
                        id="mainContentSubheader"
                      />
                    </Localized>
                  ) : null}
                  {this.renderActionButtons("after_subtitle", content)}
                  {content.cta_paragraph ? (
                    <CTAParagraph
                      content={content.cta_paragraph}
                      handleAction={this.props.handleAction}
                    />
                  ) : null}
                </div>
              ) : null}
              {content.video_container ? (
                <OnboardingVideo
                  content={content.video_container}
                  handleAction={this.props.handleAction}
                />
              ) : null}
              {this.renderLanguageSwitcher()}
              {content?.tiles_container?.position !==
              "after_supporting_content" ? (
                <ContentTiles {...this.props} />
              ) : null}
              {content.above_button_content
                ? this.renderOrderedContent(content.above_button_content)
                : null}
              {this.renderActionButtons("after_supporting_content", content)}
              {content?.tiles_container?.position ===
              "after_supporting_content" ? (
                <ContentTiles {...this.props} />
              ) : null}
              {!hideStepsIndicator && aboveButtonStepsIndicator
                ? this.renderStepsIndicator()
                : null}
              {this.renderActionButtons("end", content)}
              {
                /* Fullscreen dot-style step indicator should sit inside the
              main inner content to share its padding, which will be
              configurable with Bug 1956042 */
                !hideStepsIndicator &&
                !aboveButtonStepsIndicator &&
                !content.progress_bar &&
                content.fullscreen
                  ? this.renderStepsIndicator()
                  : null
              }
            </div>
            {!hideStepsIndicator &&
            !aboveButtonStepsIndicator &&
            !(content.fullscreen && !content.progress_bar)
              ? this.renderStepsIndicator()
              : null}
          </div>
        </div>
        <Localized text={content.info_text}>
          <span className="info-text" />
        </Localized>
      </main>
    );
  }
}
