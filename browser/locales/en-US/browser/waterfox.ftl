# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

## Waterfox blocker

waterfox-blocker-header = Ad Blocking
waterfox-blocker-intro-description = Block ads, trackers, and annoyances with { -brand-short-name }’s built-in blocker.

waterfox-blocker-setting-on =
    .label = On
waterfox-blocker-setting-on-description = { -brand-short-name } blocks ads and known tracking requests.
waterfox-blocker-setting-off =
    .label = Off
waterfox-blocker-setting-off-description = Ads and tracking requests are not blocked.

waterfox-blocker-dropdown-label = Search partner ads
waterfox-blocker-dropdown-option-partner-exception =
    .label = Allow search partner ads
waterfox-blocker-dropdown-option-block-everything =
    .label = Block everything
waterfox-blocker-show-badge-pref =
    .label = Show blocked count on the toolbar button
waterfox-blocker-manage-filter-lists =
    .label = Manage Filter Lists…

# Variables:
#   $extensionName (String) - The name of an installed ad blocking extension.
waterfox-blocker-third-party-notice-description = { $extensionName } is already blocking ads. Keep only one ad blocker enabled to avoid site breakage.

## Waterfox blocker panel

waterfox-blocker-toolbar-button =
    .label = Ad Blocking
    .tooltiptext = { -brand-short-name } Ad Blocking
waterfox-blocker-panel-not-available = Ad Blocking
waterfox-blocker-panel-toggle =
    .label = Ad Blocking
waterfox-blocker-panel-settings-button =
    .label = Ad Blocking Settings
waterfox-blocker-panel-cosmetic-filtering-disable =
    .label = Disable Cosmetic Filtering
waterfox-blocker-panel-cosmetic-filtering-enable =
    .label = Enable Cosmetic Filtering
waterfox-blocker-panel-scripting-disable =
    .label = Disable JavaScript
waterfox-blocker-panel-scripting-enable =
    .label = Enable JavaScript
waterfox-blocker-panel-remote-fonts-disable =
    .label = Disable Remote Fonts
waterfox-blocker-panel-remote-fonts-enable =
    .label = Enable Remote Fonts
waterfox-blocker-panel-picker-start =
    .label = Pick Element
waterfox-blocker-panel-picker-stop =
    .label = Stop Picker
waterfox-blocker-panel-zapper-start =
    .label = Zap Element
waterfox-blocker-panel-zapper-stop =
    .label = Stop Zapper
waterfox-blocker-panel-logger-button =
    .label = Open Logger
waterfox-blocker-panel-disabled = Ad blocking is off.
waterfox-blocker-panel-site-excepted = Ad blocking is off for this site.
waterfox-blocker-panel-partner-allowed = Search partner ads are allowed on this site.
# Variables:
#   $count (Number) - The number of requests blocked in the current tab.
waterfox-blocker-stats =
    { $count ->
        [one] { $count } item blocked on this tab
       *[other] { $count } items blocked on this tab
    }

## Waterfox blocker exceptions

waterfox-blocker-exceptions-window =
    .title = Ad Blocking Exceptions
waterfox-blocker-exceptions-description = Add sites where ad blocking should be turned off.
waterfox-blocker-exceptions-entry-field =
    .label = Allowlist entries
waterfox-blocker-exceptions-entry-field-description = Paste one domain or URL per line. Use Ctrl+Enter to add them.
waterfox-blocker-exceptions-placeholder =
    .placeholder = example.com
waterfox-blocker-exceptions-add =
    .label = Add to Allowlist
waterfox-blocker-exceptions-import =
    .label = Import…
waterfox-blocker-exceptions-export =
    .label = Export…
waterfox-blocker-exceptions-import-title = Import Allowlist
waterfox-blocker-exceptions-export-title = Export Allowlist
waterfox-blocker-exceptions-import-error-title = Import failed
waterfox-blocker-exceptions-import-error-message = The selected file could not be read.
waterfox-blocker-exceptions-export-error-title = Export failed
waterfox-blocker-exceptions-export-error-message = The allowlist could not be written.
waterfox-blocker-exceptions-invalid-title = Invalid allowlist entry
# Variables:
#   $count (Number) - Number of invalid entries.
#   $entries (String) - A newline-separated list of entries that could not be used.
waterfox-blocker-exceptions-invalid-message = Could not use { $count } entries:
    { $entries }
waterfox-blocker-exceptions-import-summary-title = Allowlist imported
waterfox-blocker-exceptions-import-summary-message = The allowlist was updated.
waterfox-blocker-exceptions-export-summary-title = Allowlist exported
waterfox-blocker-exceptions-export-summary-message = The allowlist was saved to the selected file.

## Waterfox blocker filter lists

waterfox-blocker-filter-lists-window =
    .title = Ad Blocking Filter Lists
waterfox-blocker-filter-lists-dialog =
    .buttonlabelaccept = Save Changes
    .buttonaccesskeyaccept = S
waterfox-blocker-filter-lists-description = Organize built-in lists, fetched filter lists, and your own rules in one place.

waterfox-blocker-filter-lists-custom-urls = Fetched filter lists
waterfox-blocker-filter-lists-custom-urls-description = Add one HTTP or HTTPS filter list URL per line. These lists are fetched after you save.
waterfox-blocker-filter-lists-custom-urls-placeholder =
    .placeholder = https://example.com/filter-list.txt
waterfox-blocker-filter-lists-import-urls =
    .label = Import URLs…
waterfox-blocker-filter-lists-export-urls =
    .label = Export URLs…
waterfox-blocker-filter-lists-import-urls-title = Import Filter List URLs
waterfox-blocker-filter-lists-export-urls-title = Export Filter List URLs
waterfox-blocker-filter-lists-custom-rules = Your rules
waterfox-blocker-filter-lists-custom-rules-description = Add one adblock rule per line for your own custom blocking and allow rules.
waterfox-blocker-filter-lists-custom-rules-placeholder =
    .placeholder = ||example.com^
waterfox-blocker-filter-lists-import-rules =
    .label = Import rules…
waterfox-blocker-filter-lists-export-rules =
    .label = Export rules…
waterfox-blocker-filter-lists-import-rules-title = Import Custom Rules
waterfox-blocker-filter-lists-export-rules-title = Export Custom Rules
waterfox-blocker-filter-lists-built-in = Built-in filter lists
waterfox-blocker-filter-lists-built-in-description = Turn curated filter list groups on or off by category, search them, and open their sources.
waterfox-blocker-filter-lists-search =
    .label = Search built-in lists
waterfox-blocker-filter-lists-search-placeholder =
    .placeholder = Search by name, source, description, or category
waterfox-blocker-filter-lists-search-clear =
    .label = Clear
# Variables:
#   $shown (Number) - The number of built-in lists currently shown.
#   $total (Number) - The total number of built-in lists available.
waterfox-blocker-filter-lists-search-results = { $shown } of { $total } built-in lists shown
waterfox-blocker-filter-lists-no-matches = No built-in filter lists match your search.
waterfox-blocker-filter-lists-row-status-enabled = Enabled
waterfox-blocker-filter-lists-row-status-disabled = Disabled
waterfox-blocker-filter-lists-row-open-source = Open source
waterfox-blocker-filter-lists-row-copy-source = Copy source URL
waterfox-blocker-filter-lists-empty-state = No filter lists are available.

waterfox-blocker-filter-lists-category-annoyances = Annoyances
waterfox-blocker-filter-lists-category-core = Default
waterfox-blocker-filter-lists-category-optional = Optional
waterfox-blocker-filter-lists-category-privacy = Privacy
waterfox-blocker-filter-lists-category-regional = Regional

waterfox-blocker-filter-lists-invalid-url-title = Invalid filter list URL
# Variables:
#   $urls (String) - A newline-separated list of invalid filter list URLs.
waterfox-blocker-filter-lists-invalid-url-message =
    Use only HTTP or HTTPS URLs. Could not save:
    { $urls }
waterfox-blocker-filter-lists-import-error-title = Import failed
waterfox-blocker-filter-lists-import-error-message = The selected file could not be read.
waterfox-blocker-filter-lists-export-error-title = Export failed
waterfox-blocker-filter-lists-export-error-message = The file could not be written.
waterfox-blocker-filter-lists-import-partial-title = Some entries were skipped
# Variables:
#   $count (Number) - Number of invalid URLs skipped during import.
waterfox-blocker-filter-lists-import-partial-message = { $count } invalid URLs were skipped.
waterfox-blocker-filter-lists-import-done-title = Import complete
# Variables:
#   $count (Number) - Number of entries imported.
waterfox-blocker-filter-lists-import-urls-done-message = Imported { $count } filter list URLs.
waterfox-blocker-filter-lists-import-rules-done-message = Custom rules were imported.
waterfox-blocker-filter-lists-export-done-title = Export complete
waterfox-blocker-filter-lists-export-urls-done-message = Filter list URLs were exported.
waterfox-blocker-filter-lists-export-rules-done-message = Custom rules were exported.

## Waterfox blocker logger

waterfox-blocker-logger-window =
    .title = Blocker Logger
waterfox-blocker-logger-description = Review blocker activity from the current browsing session.
waterfox-blocker-logger-current-tab-only =
    .label = Current tab only
waterfox-blocker-logger-pause =
    .label = Pause
waterfox-blocker-logger-resume =
    .label = Resume
waterfox-blocker-logger-clear =
    .label = Clear
waterfox-blocker-logger-export =
    .label = Export…
waterfox-blocker-logger-export-title = Export Blocker Log
# Variables:
#   $shown (Number) - The number of log entries currently visible.
#   $total (Number) - The total number of log entries loaded in the window.
waterfox-blocker-logger-summary = { $shown } of { $total } entries shown
waterfox-blocker-logger-state-live = Live
waterfox-blocker-logger-state-paused = Paused
waterfox-blocker-logger-details-title = Entry details
waterfox-blocker-logger-details-hint = Select an entry to inspect it.
waterfox-blocker-logger-details-empty = Select an entry to inspect it.
waterfox-blocker-logger-empty = No blocker log entries yet.
waterfox-blocker-logger-empty-filtered = No entries match the current tab filter.
waterfox-blocker-logger-field-time = Timestamp
waterfox-blocker-logger-field-scope = Scope
waterfox-blocker-logger-field-type = Type
waterfox-blocker-logger-field-action = Action
waterfox-blocker-logger-field-url = URL
waterfox-blocker-logger-field-document-url = Document URL
waterfox-blocker-logger-field-rule = Rule
waterfox-blocker-logger-field-message = Message
waterfox-blocker-logger-field-source = Source
waterfox-blocker-logger-field-tab-id = Tab ID
waterfox-blocker-logger-export-done-title = Export complete
waterfox-blocker-logger-export-done-message = The visible blocker log entries were saved.
waterfox-blocker-logger-export-error-title = Export failed
waterfox-blocker-logger-export-error-message = The blocker log could not be written.

## Waterfox blocked page

waterfox-blocked-page-title = Page blocked by { -brand-short-name }
waterfox-blocked-page-heading = { -brand-short-name } blocked this page
waterfox-blocked-page-description = This page matched an ad blocking rule.
waterfox-blocked-page-details =
    .aria-label = Block details
waterfox-blocked-page-blocked-url-label = Blocked URL:
waterfox-blocked-page-matched-rule-label = Matched rule:
waterfox-blocked-page-unavailable = Unavailable
waterfox-blocked-page-hint = You can go back or load the page anyway for this session.
waterfox-blocked-page-go-back = Go Back
waterfox-blocked-page-load-anyway = Load Anyway

## Waterfox blocker extension conflict prompts

waterfox-blocker-prompt-title = Choose an ad blocker
waterfox-blocker-extension-fallback-name-this = this extension
waterfox-blocker-extension-fallback-name-your = your ad blocker
# Variables:
#   $extensionName (String) - The name of the ad blocking extension being installed.
waterfox-blocker-extension-install-warning = { $extensionName } may conflict with { -brand-short-name }’s built-in ad blocker.
waterfox-blocker-extension-install-manage-settings = You can manage { -brand-short-name } Ad Blocking in Settings.
waterfox-blocker-extension-install-anyway = Install Anyway
waterfox-blocker-extension-install-keep-built-in = Keep Built-In Blocker
# Variables:
#   $extensionName (String) - The name of the enabled ad blocking extension.
waterfox-blocker-reenable-conflict-message = { $extensionName } is already blocking ads. Choose which ad blocker should stay enabled.
waterfox-blocker-reenable-use-built-in = Use Built-In Blocker
waterfox-blocker-reenable-keep-extension = Keep Extension

waterfox-blocker-spotlight-title = { -brand-short-name } now includes ad blocking
# Variables:
#   $extensionName (String) - The name of the installed ad blocking extension.
waterfox-blocker-spotlight-subtitle = { $extensionName } is installed. Use one ad blocker at a time to reduce site breakage.
waterfox-blocker-spotlight-primary-button = Keep Built-In Blocker
waterfox-blocker-spotlight-secondary-button = Manage Settings
