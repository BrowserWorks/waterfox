# Automatic Tab Grouping Feature

This feature is inspired by the Firefox WebExtension "New Tab Same Group" by onlybets.
(Source: https://github.com/onlybets/firefox-addon-new-tab-same-group/blob/main/README.md)

This module implements automatic tab grouping functionality, which automatically adds new tabs to the same group as the currently active tab.

## Features

- **Automatic Grouping**: When enabled, new tabs are automatically added to the same group as the source tab (the tab that was active when the new tab was created).

- **Configurable Placement**: Users can choose where new tabs appear within the group:
  - After the source tab (default)
  - At the beginning of the group
  - At the end of the group

- **Optional Delay**: Users can enable a 1-second delay before grouping occurs, allowing them to cancel the operation if desired.

- **Keyboard Shortcut**: When delay is enabled, users can press a keyboard shortcut (default: Ctrl+` on Windows/Linux, Alt+` on macOS) to cancel pending grouping operations.

- **Bypass Shortcut**: Press Alt+Shift+T to open a new tab in the standard way (no grouping). This can be configured via preferences.

- **Smart Tab Tracking**: The feature maintains a history of active tabs to handle edge cases where the source tab might not be immediately available.

## Implementation

The feature consists of:

1. **TabGrouping.sys.mjs**: Core module that handles all the grouping logic
2. **Preferences**: User-configurable settings with defaults
3. **UI Overlays**: Integration with the preferences UI
4. **Localization**: User-facing strings in tabgrouping.ftl

## Preferences

- `browser.tabs.autoGroupNewTabs`: Enable/disable the feature (default: true)
- `browser.tabs.autoGroupNewTabs.placement`: Tab placement mode (default: "after")
- `browser.tabs.autoGroupNewTabs.delayEnabled`: Enable grouping delay (default: false)
- `browser.tabs.autoGroupNewTabs.delayMs`: Delay duration in milliseconds (default: 1000)
- `browser.tabs.autoGroupNewTabs.cancelShortcut`: Keyboard shortcut to cancel (platform-specific default)
- `browser.tabs.autoGroupNewTabs.bypassShortcut`: Keyboard shortcut to open a standard new tab without grouping (default: "Alt+Shift+T")

## Architecture

The module:
- Listens for tab creation events via observer notifications
- Tracks active tab history to determine the appropriate source tab
- Manages pending grouping operations with timers
- Handles keyboard shortcuts dynamically when delay is enabled
- Integrates with the existing tab group infrastructure in tabbrowser.js

## Usage

The feature is automatically initialized when the browser starts via WaterfoxGlue.sys.mjs.

This project contains code under two licenses:
- Original implementation: MIT License (see LICENSE)
- Rewritten portions: Mozilla Public License 2.0
