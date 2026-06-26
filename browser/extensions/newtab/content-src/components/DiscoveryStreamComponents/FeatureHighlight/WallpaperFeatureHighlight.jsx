/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import React, { useCallback } from "react";
import { useSelector } from "react-redux";
import { actionCreators as ac, actionTypes as at } from "common/Actions.mjs";
import { FeatureHighlight } from "./FeatureHighlight";

export function WallpaperFeatureHighlight({
  position,
  dispatch,
  handleDismiss,
  handleClick,
  handleBlock,
}) {
  // @nova-cleanup(remove-pref): Remove the nova.enabled pref check and keep the Nova copy and image path as the default once Nova ships.
  const isNova = useSelector(state => state.Prefs.values["nova.enabled"]);
  const onDismiss = useCallback(() => {
    handleDismiss();
    handleBlock();
  }, [handleDismiss, handleBlock]);

  const onToggleClick = useCallback(
    elementId => {
      dispatch({ type: at.SHOW_PERSONALIZE });
      dispatch(ac.UserEvent({ event: "SHOW_PERSONALIZE" }));
      handleClick(elementId);
      onDismiss();
    },
    [dispatch, onDismiss, handleClick]
  );

  // Extract the strings and feature ID from OMC
  const { messageData } = useSelector(state => state.Messages);
  const isWorldCup =
    isNova &&
    messageData?.content?.messageType === "WorldCupWallpaperHighlight";

  const novaHighlightImage = isWorldCup
    ? "chrome://newtab/content/data/content/assets/highlights/wallpaper-callout.png"
    : "chrome://branding/content/about-logo.svg";
  const novaImgWidth = isWorldCup ? "319" : "207";
  const novaImgHeight = isWorldCup ? "204" : "156";
  const novaTitleL10nId = isWorldCup
    ? "newtab-sports-widget-message-wallpapers-title"
    : "newtab-wallpaper-feature-highlight-title";
  const novaSubtitleL10nId = isWorldCup
    ? "newtab-sports-widget-message-wallpapers-body"
    : "newtab-wallpaper-feature-highlight-subtitle";
  const novaCtaL10nId = isWorldCup
    ? "newtab-sports-widget-message-wallpapers-cta"
    : "newtab-wallpaper-feature-highlight-cta";

  return (
    <div
      className={`wallpaper-feature-highlight ${isWorldCup ? "world-cup-variant" : ""} ${messageData.content?.darkModeDismiss ? "is-inverted-dark-dismiss-button" : ""}`}
    >
      <FeatureHighlight
        position={position}
        data-l10n-id="feature-highlight-wallpaper"
        feature={messageData.content.feature}
        dispatch={dispatch}
        modalClassName="wallpaper-feature-highlight-modal"
        message={
          <div className="wallpaper-feature-highlight-content">
            <picture
              className={
                isNova
                  ? "wallpaper-feature-highlight-image"
                  : "follow-section-button-highlight-image"
              }
            >
              <source
                srcSet={
                  messageData.content?.darkModeImageURL ||
                  (isNova
                    ? novaHighlightImage
                    : "chrome://newtab/content/data/content/assets/highlights/omc-newtab-wallpapers.svg")
                }
                media="(prefers-color-scheme: dark)"
              />
              <source
                srcSet={
                  messageData.content?.imageURL ||
                  (isNova
                    ? novaHighlightImage
                    : "chrome://newtab/content/data/content/assets/highlights/omc-newtab-wallpapers.svg")
                }
                media="(prefers-color-scheme: light)"
              />
              <img
                width={isNova ? novaImgWidth : "320"}
                height={isNova ? novaImgHeight : "195"}
                alt=""
              />
            </picture>
            <div className="wallpaper-feature-highlight-copy">
              {!isNova && messageData.content?.cardTitle ? (
                <p className="title">{messageData.content.cardTitle}</p>
              ) : (
                <p
                  className="title"
                  data-l10n-id={
                    isNova
                      ? novaTitleL10nId
                      : messageData.content.title ||
                        "newtab-new-user-custom-wallpaper-title"
                  }
                />
              )}
              {!isNova && messageData.content?.cardMessage ? (
                <p className="subtitle">{messageData.content.cardMessage}</p>
              ) : (
                <p
                  className="subtitle"
                  data-l10n-id={
                    isNova
                      ? novaSubtitleL10nId
                      : messageData.content.subtitle ||
                        "newtab-new-user-custom-wallpaper-subtitle"
                  }
                />
              )}
            </div>
            <span className="button-wrapper">
              {!isNova && messageData.content?.cardCta ? (
                <moz-button
                  type={isNova ? "primary" : "default"}
                  onClick={() => onToggleClick("open-customize-menu")}
                  label={messageData.content.cardCta}
                />
              ) : (
                <moz-button
                  type={isNova ? "primary" : "default"}
                  onClick={() => onToggleClick("open-customize-menu")}
                  data-l10n-id={
                    isNova
                      ? novaCtaL10nId
                      : messageData.content.cta ||
                        "newtab-new-user-custom-wallpaper-cta"
                  }
                />
              )}
            </span>
          </div>
        }
        toggle={<div className="icon icon-help"></div>}
        openedOverride={true}
        showButtonIcon={false}
        dismissCallback={onDismiss}
        outsideClickCallback={handleDismiss}
      />
    </div>
  );
}
