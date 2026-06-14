/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this file,
 * You can obtain one at http://mozilla.org/MPL/2.0/. */

import React, { useEffect } from "react";

import { Localized } from "./MSLocalized";
import { TileButton } from "./TileButton";
import { TileList } from "./TileList";
import { MultiStageUtils } from "../lib/multistage-utils.mjs";

// This component was formerly "Themes" and continues to support theme
export const SingleSelect = ({
  activeSingleSelectSelections = {}, // This now holds all active selections keyed by `singleSelectId`
  activeTheme,
  content,
  handleAction,
  setActiveSingleSelectSelection,
  singleSelectId,
}) => {
  const category = content.tiles?.category?.type || content.tiles?.type;
  const className = [
    "tiles-single-select-section",
    category,
    content.tiles?.class_name,
    content.tiles?.className,
  ]
    .filter(Boolean)
    .join(" ");
  const isSingleSelect = category === "single-select";

  const autoTriggerAllowed = itemAction => {
    // Currently only enabled for sidebar experiment prefs
    const allowedActions = ["SET_PREF"];
    const allowedPrefs = [
      "sidebar.revamp",
      "sidebar.verticalTabs",
      "sidebar.visibility",
    ];
    const checkAction = action => {
      if (!allowedActions.includes(action.type)) {
        return false;
      }
      if (
        action.type === "SET_PREF" &&
        !allowedPrefs.includes(action.data?.pref.name)
      ) {
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
  useEffect(() => {
    if (isSingleSelect && !activeSingleSelectSelections[singleSelectId]) {
      let newActiveSingleSelect =
        content.tiles?.selected || content.tiles?.data[0].id;

      setActiveSingleSelectSelection(newActiveSingleSelect, singleSelectId);

      let selectedTile = content.tiles?.data.find(
        opt => opt.id === newActiveSingleSelect
      );
      // If applicable, automatically trigger the action for the default
      // selected tile.
      if (
        isSingleSelect &&
        content.tiles?.autoTrigger &&
        autoTriggerAllowed(selectedTile?.action)
      ) {
        handleAction({ currentTarget: { value: selectedTile.id } });
      }
    }
  }, [activeSingleSelectSelections]); // eslint-disable-line react-hooks/exhaustive-deps

  const CONFIGURABLE_STYLES = [
    "background",
    "borderRadius",
    "height",
    "marginBlock",
    "marginBlockStart",
    "marginBlockEnd",
    "marginInline",
    "paddingBlock",
    "paddingBlockStart",
    "paddingBlockEnd",
    "paddingInline",
    "paddingInlineStart",
    "paddingInlineEnd",
    "width",
  ];

  return (
    <div className={`tiles-single-select-container`}>
      <div>
        <fieldset className={className}>
          <Localized
            text={
              content.tiles?.legend ||
              content.tiles?.subtitle ||
              content.subtitle
            }
          >
            <legend className="sr-only" />
          </Localized>
          {content.tiles.data.map(
            ({
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
              tilebutton,
            }) => {
              const value = id || theme;
              let inputName = singleSelectId;
              if (!isSingleSelect) {
                inputName = category === "theme" ? "theme" : id; // unique names per item are currently used in the wallpaper picker
              }
              const selected =
                (theme && theme === activeTheme) ||
                (isSingleSelect &&
                  activeSingleSelectSelections[singleSelectId] === value);
              const valOrObj = val => (typeof val === "object" ? val : {});

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

              return (
                <Localized
                  key={value + (isSingleSelect ? "" : label)}
                  text={valOrObj(tooltip)}
                >
                  {/* eslint-disable jsx-a11y/label-has-associated-control */}
                  {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions */}
                  <label
                    className={`select-item ${type}`}
                    onKeyDown={e => handleKeyDown(e)}
                    style={{
                      ...MultiStageUtils.getValidStyle(
                        style,
                        CONFIGURABLE_STYLES
                      ),
                      ...(icon?.width ? { minWidth: icon.width } : {}),
                    }}
                  >
                    {flair ? (
                      <Localized text={valOrObj(flair.text)}>
                        <span
                          className={`flair ${flair.centered ? "centered" : ""} ${flair.spacer ? "spacer" : ""} ${type}`}
                        ></span>
                      </Localized>
                    ) : (
                      ""
                    )}
                    <Localized text={valOrObj(description)}>
                      <input
                        type="radio"
                        value={value}
                        name={inputName}
                        checked={selected}
                        className="sr-only input"
                        disabled={inert}
                        onClick={e => handleClick(e)}
                      />
                    </Localized>
                    <div
                      className={`icon ${selected ? " selected" : ""} ${value}`}
                      style={MultiStageUtils.getValidStyle(
                        icon,
                        CONFIGURABLE_STYLES
                      )}
                    />
                    <Localized text={label}>
                      <div className="text label-text" />
                    </Localized>
                    {body.items ? (
                      <TileList content={body} />
                    ) : (
                      <Localized text={body}>
                        <div className="text body-text" />
                      </Localized>
                    )}
                    {subtitle && selected ? (
                      <Localized text={subtitle}>
                        <div className="text subtitle-text" />
                      </Localized>
                    ) : (
                      ""
                    )}
                    {tilebutton ? (
                      <TileButton
                        content={tilebutton}
                        handleAction={handleAction}
                        inputName={`${singleSelectId}-${value}`}
                      />
                    ) : (
                      ""
                    )}
                  </label>
                </Localized>
              );
            }
          )}
        </fieldset>
      </div>
    </div>
  );
};
