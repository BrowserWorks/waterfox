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

## Waterfox blocker filter lists

waterfox-blocker-filter-lists-window =
    .title = Ad Blocking Filter Lists
waterfox-blocker-filter-lists-dialog =
    .buttonlabelaccept = Save Changes
    .buttonaccesskeyaccept = S
waterfox-blocker-filter-lists-description = Choose built-in lists, add filter list URLs, and write your own rules.

waterfox-blocker-filter-lists-custom-urls = Custom filter lists
waterfox-blocker-filter-lists-custom-urls-description = Add one HTTP or HTTPS filter list URL per line.
waterfox-blocker-filter-lists-custom-urls-placeholder =
    .placeholder = https://example.com/filter-list.txt
waterfox-blocker-filter-lists-custom-rules = Custom rules
waterfox-blocker-filter-lists-custom-rules-description = Add one adblock rule per line. Changes apply after saving.
waterfox-blocker-filter-lists-custom-rules-placeholder =
    .placeholder = ||example.com^
waterfox-blocker-filter-lists-built-in = Built-in filter lists
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
