/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

export const kCOMMAND_GET_INSTANCE_ID                = 'ws:get-instance-id';
export const kCOMMAND_RELOAD                         = 'ws:reload';
export const kCOMMAND_PING_TO_BACKGROUND             = 'ws:ping-to-background';
export const kCOMMAND_PING_TO_SIDEBAR                = 'ws:ping-to-sidebar';
export const kCOMMAND_REQUEST_CONNECT_PREFIX         = 'ws:request-connect-from:';
export const kCOMMAND_REQUEST_UNIQUE_ID              = 'ws:request-unique-id';
export const kCOMMAND_GET_THEME_DECLARATIONS         = 'ws:get-theme-declarations';
export const kCOMMAND_GET_CONTEXTUAL_IDENTITIES_COLOR_INFO = 'ws:get-contextual-identities-color-info';
export const kCOMMAND_GET_CONFIG_VALUE               = 'ws:get-config-value';
export const kCOMMAND_SET_CONFIG_VALUE               = 'ws:set-config-value';
export const kCOMMAND_GET_USER_STYLE_RULES           = 'ws:get-user-style-rules';
export const kCOMMAND_PULL_TABS                      = 'ws:pull-tabs';
export const kCOMMAND_SYNC_TABS_ORDER                = 'ws:sync-tabs-order';
export const kCOMMAND_PULL_TABS_ORDER                = 'ws:pull-tabs-order';
export const kCOMMAND_PULL_TREE_STRUCTURE            = 'ws:pull-tree-structure';
export const kCOMMAND_GET_RENDERED_TAB_IDS           = 'ws:get-rendered-tab-ids';
export const kCOMMAND_ASK_TAB_IS_IN_VIEWPORT         = 'ws:ask-tab-is-in-viewport';
export const kCOMMAND_LOAD_URI                       = 'ws:load-uri';
export const kCOMMAND_OPEN_TAB                       = 'ws:open-tab';
export const kCOMMAND_NEW_WINDOW_FROM_TABS           = 'ws:open-new-window-from-tabs';
export const kCOMMAND_NEW_TABS                       = 'ws:open-new-tabs';
export const kCOMMAND_NEW_TAB_AS                     = 'ws:open-new-tab-as';
export const kCOMMAND_REMOVE_TABS_BY_MOUSE_OPERATION = 'ws:remove-tabs-by-mouse-operation';
export const kCOMMAND_REMOVE_TABS_INTERNALLY         = 'ws:remove-tabs-internally';
export const kCOMMAND_UPDATE_LOADING_STATE           = 'ws:update-loading-state';
export const kCOMMAND_CONFIRM_TO_CLOSE_TABS          = 'ws:confirm-to-close-tabs';
export const kCOMMAND_SHOW_DIALOG                    = 'ws:show-dialog';
export const kCOMMAND_NOTIFY_BACKGROUND_READY        = 'ws:notify-background-ready';
export const kCOMMAND_NOTIFY_CONNECTION_READY        = 'ws:notify-connection-ready';
export const kCOMMAND_NOTIFY_TAB_CREATING            = 'ws:notify-tab-creating';
export const kCOMMAND_NOTIFY_TAB_CREATED             = 'ws:notify-tab-created';
export const kCOMMAND_NOTIFY_TAB_UPDATED             = 'ws:notify-tab-updated';
export const kCOMMAND_NOTIFY_TAB_MOVED               = 'ws:notify-tab-moved';
export const kCOMMAND_NOTIFY_TAB_INTERNALLY_MOVED    = 'ws:notify-tab-internally-moved';
export const kCOMMAND_NOTIFY_TAB_REMOVING            = 'ws:notify-tab-removing';
export const kCOMMAND_NOTIFY_TAB_REMOVED             = 'ws:notify-tab-removed';
export const kCOMMAND_NOTIFY_TAB_ACTIVATING          = 'ws:notify-tab-activating';
export const kCOMMAND_NOTIFY_TAB_ACTIVATED           = 'ws:notify-tab-activated';
export const kCOMMAND_NOTIFY_MAY_START_TAB_SWITCH    = 'ws:notify-may-start-tab-switch';
export const kCOMMAND_NOTIFY_MAY_END_TAB_SWITCH      = 'ws:notify-may-end-tab-switch';
export const kCOMMAND_NOTIFY_TAB_ATTACHED_TO_WINDOW   = 'ws:notify-tab-attached-to-window';
export const kCOMMAND_NOTIFY_TAB_DETACHED_FROM_WINDOW = 'ws:notify-tab-detached-from-window';
export const kCOMMAND_NOTIFY_PERMISSIONS_GRANTED     = 'ws:notify-permissions-granted';
export const kCOMMAND_NOTIFY_TAB_PINNED              = 'ws:notify-tab-pinned';
export const kCOMMAND_NOTIFY_TAB_UNPINNED            = 'ws:notify-tab-unpinned';
export const kCOMMAND_NOTIFY_TAB_SHOWN               = 'ws:notify-tab-shown';
export const kCOMMAND_NOTIFY_TAB_HIDDEN              = 'ws:notify-tab-hidden';
export const kCOMMAND_NOTIFY_TAB_RESTORING           = 'ws:notify-tab-restoring';
export const kCOMMAND_NOTIFY_TAB_RESTORED            = 'ws:notify-tab-restored';
export const kCOMMAND_NOTIFY_TAB_LABEL_UPDATED       = 'ws:notify-tab-label-updated';
export const kCOMMAND_NOTIFY_TAB_FAVICON_UPDATED     = 'ws:notify-tab-favicon-updated';
export const kCOMMAND_NOTIFY_TAB_SOUND_STATE_UPDATED = 'ws:notify-tab-sound-state-updated';
export const kCOMMAND_NOTIFY_TAB_SHARING_STATE_UPDATED = 'ws:notify-tab-sharing-state-updated';
export const kCOMMAND_NOTIFY_TABS_CLOSING            = 'ws:notify-tabs-closing';
export const kCOMMAND_NOTIFY_HIGHLIGHTED_TABS_CHANGED = 'ws:notify-highlighted-tabs-changed';
export const kCOMMAND_NOTIFY_TABS_HIGHLIGHTING_IN_PROGRESS = 'ws:notify-tabs-highlighting-in-progress';
export const kCOMMAND_NOTIFY_TABS_HIGHLIGHTING_COMPLETE    = 'ws:notify-tabs-highlighting-complete';
export const kCOMMAND_NOTIFY_GROUP_TAB_DETECTED      = 'ws:notify-group-tab-detected';
export const kCOMMAND_NOTIFY_CHILDREN_CHANGED        = 'ws:notify-children-changed';
export const kCOMMAND_NOTIFY_TAB_COLLAPSED_STATE_CHANGED     = 'ws:notify-tab-collapsed-state-changed';
export const kCOMMAND_NOTIFY_SUBTREE_COLLAPSED_STATE_CHANGED = 'ws:notify-subtree-collapsed-state-changed';
export const kCOMMAND_SET_SUBTREE_COLLAPSED_STATE                   = 'ws:set-subtree-collapsed-state';
export const kCOMMAND_SET_SUBTREE_COLLAPSED_STATE_INTELLIGENTLY_FOR = 'ws:set-subtree-collapsed-state-intelligently-for';
export const kCOMMAND_TOGGLE_STICKY                  = 'ws:toggle-sticky';
export const kCOMMAND_NOTIFY_TAB_LEVEL_CHANGED       = 'ws:notify-tab-level-changed';
export const kCOMMAND_NOTIFY_TAB_ATTACHED_COMPLETELY = 'ws:notify-tab-attached-completely';
export const kCOMMAND_BROADCAST_CURRENT_DRAG_DATA    = 'ws:broadcast-current-drag-data';
export const kCOMMAND_SHOW_CONTAINER_SELECTOR        = 'ws:show-container-selector';
export const kCOMMAND_SCROLL_TABBAR                  = 'ws:scroll-tabbar';
export const kCOMMAND_TOGGLE_SUBPANEL                = 'ws:toggle-subpanel';
export const kCOMMAND_SWITCH_SUBPANEL                = 'ws:switch-subpanel';
export const kCOMMAND_INCREASE_SUBPANEL              = 'ws:increase-subpanel';
export const kCOMMAND_DECREASE_SUBPANEL              = 'ws:decrease-subpanel';
export const kCOMMAND_REQUEST_QUERY_LOGS             = 'ws:request-query-logs';
export const kCOMMAND_RESPONSE_QUERY_LOGS            = 'ws:response-query-logs';
export const kCOMMAND_REQUEST_CONNECTION_MESSAGE_LOGS  = 'ws:request-connection-message-logs';
export const kCOMMAND_RESPONSE_CONNECTION_MESSAGE_LOGS = 'ws:response-connection-message-logs';
export const kCOMMAND_NOTIFY_TEST_KEY_CHANGED        = 'ws:notify-test-key-changed';
export const kCOMMAND_SIMULATE_SIDEBAR_MESSAGE       = 'ws:simulate-sidebar-message';
export const kCOMMAND_GET_CONTEXT_MENU_ITEMS         = 'ws:contextMenu-get-items';
export const kCOMMAND_NOTIFY_CONTEXT_MENU_UPDATED    = 'ws:contextMenu-updated';
export const kCOMMAND_NOTIFY_CONTEXT_ITEM_CHECKED_STATUS_CHANGED = 'ws:contextMenu-item-checked-status-changed';
export const kCOMMAND_NOTIFY_CONTEXT_OVERRIDDEN      = 'ws:notify-context-overridden';
export const kCOMMAND_AUTODETECT_DUPLICATED_TAB_DETECTION_DELAY = 'ws:autodetect-duplicated-tab-detection-delay';
export const kCOMMAND_TEST_DUPLICATED_TAB_DETECTION             = 'ws:test-duplicated-tab-detection';
export const kCOMMAND_WAIT_UNTIL_SUCCESSORS_UPDATED = 'ws:wait-until-successors-updated';
export const kCOMMAND_GET_BOUNDING_CLIENT_RECT      = 'ws:get-bounding-client-rect';

export const kCOMMAND_ACTIVATE_TAB            = 'ws:activate-tab';
export const kCOMMAND_HIGHLIGHT_TABS          = 'ws:highlight-tabs';
export const kCOMMAND_TOGGLE_MUTED_FROM_SOUND_BUTTON = 'ws:toggle-muted-from-sound-button';
export const kCOMMAND_UNBLOCK_AUTOPLAY_FROM_SOUND_BUTTON = 'ws:unblock-autoplay-from-sound-button';
export const kCOMMAND_PERFORM_TABS_DRAG_DROP  = 'ws:perform-tabs-drag-drop';
export const kCOMMAND_BLOCK_USER_OPERATIONS   = 'ws:block-user-operations';
export const kCOMMAND_UNBLOCK_USER_OPERATIONS = 'ws:unblock-user-operations';
export const kCOMMAND_PROGRESS_USER_OPERATIONS = 'ws:progress-user-operations';
export const kCOMMAND_BROADCAST_TAB_STATE     = 'ws:broadcast-tab-state';
export const kCOMMAND_BROADCAST_TAB_TOOLTIP_TEXT = 'ws:broadcast-tab-tooltip-text';
export const kCOMMAND_BROADCAST_TAB_AUTO_STICKY_STATE = 'ws:broadcast-tab-auto-sticky-state';

export const kCOMMAND_BOOKMARK_TAB_WITH_DIALOG  = 'ws:bookmark-tab-with-dialog';
export const kCOMMAND_BOOKMARK_TABS_WITH_DIALOG = 'ws:bookmark-tabs-with-dialog';

export const kNOTIFY_TAB_MOUSEDOWN  = 'ws:tab-mousedown';
export const kNOTIFY_TAB_MOUSEDOWN_EXPIRED  = 'ws:tab-mousedown-expired';

export const kNOTIFY_SIDEBAR_FOCUS = 'ws:sidebar-focus';
export const kNOTIFY_SIDEBAR_BLUR  = 'ws:sidebar-blur';

export const kNOTIFY_CONFIRMATION_DIALOG_READY  = 'ws:confirmation-dialog-ready';

export const kCONNECTION_HEARTBEAT = 'ws:connection-heartbeat';

export const kAPI_TAB_ID       = 'data-tab-id';
export const kAPI_WINDOW_ID    = 'data-window-id';

export const kPARENT        = 'data-parent-id';
export const kCHILDREN      = 'data-child-ids';
export const kLEVEL         = 'data-level';
export const kCLOSED_SET_ID = 'data-closed-set-id';
export const kCURRENT_URI   = 'data-current-uri';
export const kCURRENT_FAVICON_URI = 'data-current-favicon-uri';
export const kCONTEXTUAL_IDENTITY_NAME = 'data-contextual-identity-name';
export const kMAX_TREE_LEVEL = 'data-max-tree-level';
export const kLABEL_OVERFLOW = 'data-label-overflow';

export const kPERSISTENT_ID            = 'data-persistent-id';
export const kPERSISTENT_ANCESTORS     = 'ancestors';
export const kPERSISTENT_CHILDREN      = 'children';
export const kPERSISTENT_INSERT_BEFORE = 'insert-before';
export const kPERSISTENT_INSERT_AFTER  = 'insert-after';
export const kPERSISTENT_INSERT_AFTER_LEGACY = 'isnert-after';
export const kPERSISTENT_STATES        = 'special-tab-states';
export const kPERSISTENT_SUBTREE_COLLAPSED = 'subtree-collapsed'; // obsolete
export const kPERSISTENT_ORIGINAL_OPENER_TAB_ID            = 'data-original-opener-tab-id';
export const kPERSISTENT_ALREADY_GROUPED_FOR_PINNED_OPENER = 'data-already-grouped-for-pinned-opener';

export const kFAVICON_IMAGE   = 'favicon-image';
export const kFAVICON_BUILTIN = 'favicon-builtin';
export const kFAVICON_DEFAULT = 'favicon-default'; // just for backward compatibility, and this should be removed from future versions
export const kFAVICON_SHARING_STATE = 'favicon-sharing-state';
export const kFAVICON_STICKY_STATE = 'favicon-sticky-state';
export const kBACKGROUND      = 'background';
export const kTHROBBER        = 'throbber';
export const kHIGHLIGHTER     = 'highlighter';
export const kBURSTER         = 'burster';
export const kNEWTAB_BUTTON   = 'newtab-button';
export const kEXTRA_ITEMS_CONTAINER        = 'extra-items-container';
export const kCONTEXTUAL_IDENTITY_MARKER   = 'contextual-identity-marker';
export const kCONTEXTUAL_IDENTITY_SELECTOR = 'contextual-identities-selector';
export const kCONTEXTUAL_IDENTITY_SELECTOR_CONTEXT_MENU = 'contextual-identities-selector-context';
export const kNEWTAB_ACTION_SELECTOR       = 'newtab-action-selector';
export const kTABBAR_SPACER   = 'tabs-spacer';

export const kTAB_STATE_ACTIVE                    = 'active';
export const kTAB_STATE_PINNED                    = 'pinned';
export const kTAB_STATE_LAST_ROW                  = 'last-row';
export const kTAB_STATE_LAST_VISIBLE              = 'last-visible';
export const kTAB_STATE_AUDIBLE                   = 'audible';
export const kTAB_STATE_SOUND_PLAYING             = 'sound-playing';
export const kTAB_STATE_HAS_SOUND_PLAYING_MEMBER  = 'has-sound-playing-member';
export const kTAB_STATE_MUTED                     = 'muted';
export const kTAB_STATE_HAS_MUTED_MEMBER          = 'has-muted-member';
export const kTAB_STATE_AUTOPLAY_BLOCKED          = 'autoplay-blocked';
export const kTAB_STATE_HAS_AUTOPLAY_BLOCKED_MEMBER = 'has-autoplay-blocked-member';
export const kTAB_STATE_PRIVATE_BROWSING          = 'private-browsing';
export const kTAB_STATE_HIDDEN                    = 'hidden';
export const kTAB_STATE_SHARING_CAMERA            = 'sharing-camera';
export const kTAB_STATE_SHARING_MICROPHONE        = 'sharing-microphone';
export const kTAB_STATE_SHARING_SCREEN            = 'sharing-screen';
export const kTAB_STATE_HAS_SHARING_CAMERA_MEMBER     = 'has-sharing-camera-member';
export const kTAB_STATE_HAS_SHARING_MICROPHONE_MEMBER = 'has-sharing-microphone-member';
export const kTAB_STATE_HAS_SHARING_SCREEN_MEMBER     = 'has-sharing-screen-member';
export const kTAB_STATE_ANIMATION_READY           = 'animation-ready';
export const kTAB_STATE_NOT_ACTIVATED_SINCE_LOAD  = 'not-activated-since-load';
export const kTAB_STATE_BURSTING                  = 'bursting';
export const kTAB_STATE_CREATING                  = 'creating';
export const kTAB_STATE_TO_BE_REMOVED             = 'to-be-removed';
export const kTAB_STATE_REMOVING                  = 'removing';
export const kTAB_STATE_COLLAPSED                 = 'collapsed';
export const kTAB_STATE_COLLAPSED_DONE            = 'collapsed-completely';
export const kTAB_STATE_COLLAPSING                = 'collapsing';
export const kTAB_STATE_EXPANDING                 = 'expanding';
export const kTAB_STATE_MOVING                    = 'moving';
export const kTAB_STATE_SHOWING                   = 'showing';
export const kTAB_STATE_SUBTREE_COLLAPSED         = 'subtree-collapsed';
export const kTAB_STATE_SUBTREE_EXPANDED_MANUALLY = 'subtree-expanded-manually';
export const kTAB_STATE_FAVICONIZED               = 'faviconized';
export const kTAB_STATE_UNREAD                    = 'unread';
export const kTAB_STATE_HIGHLIGHTED               = 'highlighted';
export const kTAB_STATE_BUNDLED_ACTIVE            = 'bundled-active';
export const kTAB_STATE_SOME_DESCENDANTS_HIGHLIGHTED = 'some-descendants-highlighted';
export const kTAB_STATE_ALL_DESCENDANTS_HIGHLIGHTED  = 'all-descendants-highlighted';
export const kTAB_STATE_ATTENTION                 = 'attention';
export const kTAB_STATE_DISCARDED                 = 'discarded';
export const kTAB_STATE_SELECTED                  = 'selected';
export const kTAB_STATE_DRAGGING                  = 'dragging';
export const kTAB_STATE_DUPLICATING               = 'duplicating';
export const kTAB_STATE_DUPLICATED                = 'duplicated';
export const kTAB_STATE_RESTORED                  = 'restored';
export const kTAB_STATE_FROM_EXTERNAL             = 'from-external';
export const kTAB_STATE_FROM_FIREFOX_VIEW         = 'from-firefox-view';
export const kTAB_STATE_THROBBER_UNSYNCHRONIZED   = 'throbber-unsynchronized';
export const kTAB_STATE_GROUP_TAB                 = 'group-tab';
export const kTAB_STATE_NEW_TAB_COMMAND_TAB       = 'newtab-command-tab';
export const kTAB_STATE_OPENED_FOR_SAME_WEBSITE   = 'opened-for-same-website';
export const kTAB_STATE_STICKY                    = 'sticky';
export const kTAB_INTERNAL_STATES = new Set([ // TST specific states
  'tab',
  kTAB_STATE_LAST_ROW,
  kTAB_STATE_LAST_VISIBLE,
  kTAB_STATE_ANIMATION_READY,
  kTAB_STATE_COLLAPSED_DONE,
  kTAB_STATE_CREATING,
  kTAB_STATE_DUPLICATING,
  kTAB_STATE_COLLAPSING,
  kTAB_STATE_EXPANDING,
  kTAB_STATE_MOVING,
  kTAB_STATE_TO_BE_REMOVED,
  kTAB_STATE_REMOVING,
  kTAB_STATE_SHOWING,
  kTAB_STATE_THROBBER_UNSYNCHRONIZED,
  kTAB_STATE_NEW_TAB_COMMAND_TAB,
  kTAB_STATE_DUPLICATED,
  kTAB_STATE_RESTORED,
  kTAB_STATE_FROM_EXTERNAL,
  kTAB_STATE_FROM_FIREFOX_VIEW,
  kTAB_STATE_OPENED_FOR_SAME_WEBSITE,
  kTAB_STATE_STICKY,
]);
export const kTAB_TEMPORARY_STATES = new Set([ // states not trigger updating of cache
  kTAB_STATE_CREATING,
  kTAB_STATE_BURSTING,
  kTAB_STATE_COLLAPSING,
  kTAB_STATE_DUPLICATING,
  kTAB_STATE_EXPANDING,
  kTAB_STATE_MOVING,
  kTAB_STATE_TO_BE_REMOVED,
  kTAB_STATE_REMOVING,
  kTAB_STATE_SHOWING,
  kTAB_STATE_NEW_TAB_COMMAND_TAB,
  kTAB_STATE_DUPLICATED,
  kTAB_STATE_RESTORED,
  kTAB_STATE_FROM_EXTERNAL,
  kTAB_STATE_FROM_FIREFOX_VIEW,
  kTAB_STATE_OPENED_FOR_SAME_WEBSITE,
]);
export const kTAB_SAFE_STATES = new Set([ // exportable via API
  kTAB_STATE_COLLAPSED,
  kTAB_STATE_SUBTREE_COLLAPSED,
  kTAB_STATE_GROUP_TAB,
  kTAB_STATE_CREATING,
  kTAB_STATE_NEW_TAB_COMMAND_TAB,
  kTAB_STATE_DUPLICATED,
  kTAB_STATE_RESTORED,
  kTAB_STATE_FROM_EXTERNAL,
  kTAB_STATE_FROM_FIREFOX_VIEW,
  kTAB_STATE_OPENED_FOR_SAME_WEBSITE,
  kTAB_STATE_STICKY,
]);
export const kTAB_SAFE_STATES_ARRAY = Array.from(kTAB_SAFE_STATES);

export const kTABBAR_STATE_OVERFLOW               = 'overflow';
export const kTABBAR_STATE_SCROLLED               = 'scrolled';
export const kTABBAR_STATE_FULLY_SCROLLED         = 'fully-scrolled';
export const kTABBAR_STATE_BLOCKING               = 'blocking';
export const kTABBAR_STATE_BLOCKING_WITH_THROBBER = 'blocking-throbber';
export const kTABBAR_STATE_BLOCKING_WITH_SHADE    = 'blocking-shade';
export const kTABBAR_STATE_HAVE_LOADING_TAB       = 'have-loading-tab';
export const kTABBAR_STATE_HAVE_UNSYNCHRONIZED_THROBBER = 'have-unsynchronized-throbber';
export const kTABBAR_STATE_THROBBER_SYNCHRONIZING = 'throbber-synchronizing';
export const kTABBAR_STATE_CONTEXTUAL_IDENTITY_SELECTABLE = 'contextual-identity-selectable';
export const kTABBAR_STATE_NEWTAB_ACTION_SELECTABLE = 'newtab-action-selectable';
export const kTABBAR_STATE_MULTIPLE_HIGHLIGHTED   = 'mutiple-highlighted';
export const kTABBAR_STATE_HAS_VISUAL_GAP         = 'has-visual-gap';
export const kTABBAR_STATE_HOVER_ON_TOP_EDGE      = 'hover-on-top-edge';
export const kTABBAR_STATE_SCROLLBAR_AUTOHIDE     = 'scrollbar-autohide';
export const kTABBAR_STATE_FAVICONIZE_PINNED_TABS = 'faviconize-pinned-tabs';

export const kWINDOW_STATE_TREE_STRUCTURE  = 'tree-structure';
export const kWINDOW_STATE_SCROLL_POSITION = 'scroll-position';
export const kWINDOW_STATE_SUBPANEL_PROVIDER_ID = 'subpanel-provider-id';
export const kWINDOW_STATE_SUBPANEL_HEIGHT = 'subpanel-height';
export const kWINDOW_STATE_SUBPANEL_EFFECTIVE_HEIGHT = 'subpanel-effective-height';
export const kWINDOW_STATE_CACHED_TABS     = 'cached-tabs';
export const kWINDOW_STATE_CACHED_SIDEBAR  = 'cached-sidebar-contents';
export const kWINDOW_STATE_CACHED_SIDEBAR_CONTENTS  = 'cached-sidebar-contents:contents';
export const kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY = 'cached-sidebar-contents:tabs-dirty';
export const kWINDOW_STATE_CACHED_SIDEBAR_COLLAPSED_DIRTY = 'cached-sidebar-contents:collapsed-dirty';

export const kCACHE_KEYS = [
  kWINDOW_STATE_CACHED_TABS,
  kWINDOW_STATE_CACHED_SIDEBAR,
  kWINDOW_STATE_CACHED_SIDEBAR_CONTENTS,
  kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY,
  kWINDOW_STATE_CACHED_SIDEBAR_COLLAPSED_DIRTY,
];

export const kCOUNTER_ROLE_ALL_TABS       = 1;
export const kCOUNTER_ROLE_CONTAINED_TABS = 2;

export const kTABBAR_POSITION_AUTO  = 0;
export const kTABBAR_POSITION_LEFT  = 1;
export const kTABBAR_POSITION_RIGHT = 2;

export const kACTION_MOVE   = 1 << 0;
export const kACTION_ATTACH = 1 << 10;
export const kACTION_DETACH = 1 << 11;

export const kDROPLINK_ASK    = 0;
export const kDROPLINK_LOAD   = 1 << 0;
export const kDROPLINK_NEWTAB = 1 << 1;

export const kGROUP_BOOKMARK_ASK                         = 0;
export const kGROUP_BOOKMARK_SUBTREE                     = 1 << 0;
export const kGROUP_BOOKMARK_SEPARATE                    = 1 << 1;
export const kGROUP_BOOKMARK_FIXED                       = kGROUP_BOOKMARK_SUBTREE | kGROUP_BOOKMARK_SEPARATE;
export const kGROUP_BOOKMARK_USE_DUMMY                   = 1 << 8;
export const kGROUP_BOOKMARK_USE_DUMMY_FORCE             = 1 << 10;
export const kGROUP_BOOKMARK_DONT_RESTORE_TREE_STRUCTURE = 1 << 9;
export const kGROUP_BOOKMARK_EXPAND_ALL_TREE             = 1 << 11;
export const kGROUP_BOOKMARK_CANCEL                      = -1;

export const kGROUP_TAB_TEMPORARY_STATE_NOTHING = 0;
export const kGROUP_TAB_TEMPORARY_STATE_PASSIVE = 1;
export const kGROUP_TAB_TEMPORARY_STATE_AGGRESSIVE = 2;

export const kPARENT_TAB_OPERATION_BEHAVIOR_MODE_PARALLEL   = 0;
export const kPARENT_TAB_OPERATION_BEHAVIOR_MODE_CONSISTENT = 1;
export const kPARENT_TAB_OPERATION_BEHAVIOR_MODE_CUSTOM     = -1;

export const kPARENT_TAB_OPERATION_CONTEXT_CLOSE = 1;
export const kPARENT_TAB_OPERATION_CONTEXT_MOVE  = 2;

export const kPARENT_TAB_OPERATION_BEHAVIOR_ENTIRE_TREE                = 2;
export const kPARENT_TAB_OPERATION_BEHAVIOR_PROMOTE_FIRST_CHILD        = 3;
export const kPARENT_TAB_OPERATION_BEHAVIOR_PROMOTE_ALL_CHILDREN       = 0;
export const kPARENT_TAB_OPERATION_BEHAVIOR_PROMOTE_INTELLIGENTLY      = 6;
export const kPARENT_TAB_OPERATION_BEHAVIOR_DETACH_ALL_CHILDREN        = 1;
export const kPARENT_TAB_OPERATION_BEHAVIOR_SIMPLY_DETACH_ALL_CHILDREN = 4; // just for internal use
export const kPARENT_TAB_OPERATION_BEHAVIOR_REPLACE_WITH_GROUP_TAB     = 5;

// just for migration from old versions
export const kPARENT_TAB_BEHAVIOR_ALWAYS            = 0;
export const kPARENT_TAB_BEHAVIOR_ONLY_WHEN_VISIBLE = 1;
export const kPARENT_TAB_BEHAVIOR_ONLY_ON_SIDEBAR   = 2;

export const kINSERT_NO_CONTROL = -1;
export const kINSERT_INHERIT    = -2;
export const kINSERT_TOP        = 0;
export const kINSERT_END        = 1;
export const kINSERT_NEAREST    = 2;
export const kINSERT_NEXT_TO_LAST_RELATED_TAB = 3;
export const kCONTROLLED_INSERTION_POSITION = new Set([
  kINSERT_TOP,
  kINSERT_NEAREST,
  kINSERT_NEXT_TO_LAST_RELATED_TAB,
]);

export const kSUCCESSOR_TAB_CONTROL_NEVER            = 0;
export const kSUCCESSOR_TAB_CONTROL_SIMULATE_DEFAULT = 1;
export const kSUCCESSOR_TAB_CONTROL_IN_TREE          = 2;

export const kTREE_DOUBLE_CLICK_BEHAVIOR_NONE                  = 0;
export const kTREE_DOUBLE_CLICK_BEHAVIOR_TOGGLE_COLLAPSED      = 1;
export const kTREE_DOUBLE_CLICK_BEHAVIOR_TOGGLE_STICKY         = 4;
export const kTREE_DOUBLE_CLICK_BEHAVIOR_CLOSE                 = 3;
// 2 is a retired number for a removed feature

export const kDRAG_BEHAVIOR_NONE           = 0;
export const kDRAG_BEHAVIOR_ENTIRE_TREE     = 1 << 0;
export const kDRAG_BEHAVIOR_ALLOW_BOOKMARK = 1 << 1;
export const kDRAG_BEHAVIOR_TEAR_OFF       = 1 << 2;
export const kDRAG_BEHAVIOR_MOVE           = 1 << 3;

export const kNEWTAB_DO_NOTHING           = -1;
export const kNEWTAB_OPEN_AS_ORPHAN       = 0;
export const kNEWTAB_OPEN_AS_CHILD        = 1; // no control about position
export const kNEWTAB_OPEN_AS_CHILD_NEXT_TO_LAST_RELATED_TAB = 5;
export const kNEWTAB_OPEN_AS_CHILD_TOP    = 6;
export const kNEWTAB_OPEN_AS_CHILD_END    = 7;
export const kNEWTAB_OPEN_AS_SIBLING      = 2;
export const kNEWTAB_OPEN_AS_NEXT_SIBLING = 3;
export const kNEWTAB_OPEN_AS_NEXT_SIBLING_WITH_INHERITED_CONTAINER = 4;
export const kCONTROLLED_NEWTAB_POSITION = new Set([
  kNEWTAB_OPEN_AS_CHILD,
  kNEWTAB_OPEN_AS_CHILD_NEXT_TO_LAST_RELATED_TAB,
  kNEWTAB_OPEN_AS_CHILD_TOP,
  kNEWTAB_OPEN_AS_CHILD_END,
  kNEWTAB_OPEN_AS_SIBLING,
  kNEWTAB_OPEN_AS_NEXT_SIBLING,
  kNEWTAB_OPEN_AS_NEXT_SIBLING_WITH_INHERITED_CONTAINER,
]);

export const kCONTEXTUAL_IDENTITY_DEFAULT          = 0;
export const kCONTEXTUAL_IDENTITY_FROM_PARENT      = 1;
export const kCONTEXTUAL_IDENTITY_FROM_LAST_ACTIVE = 2;

export const kSCROLL_TO_NEW_TAB_IGNORE      = 0;
export const kSCROLL_TO_NEW_TAB_IF_POSSIBLE = 1;

export const kTABBAR_UPDATE_REASON_RESIZE        = 1 << 0;
export const kTABBAR_UPDATE_REASON_COLLAPSE      = 1 << 1;
export const kTABBAR_UPDATE_REASON_EXPAND        = 1 << 2;
export const kTABBAR_UPDATE_REASON_ANIMATION_END = 1 << 3;
export const kTABBAR_UPDATE_REASON_TAB_OPEN      = 1 << 4;
export const kTABBAR_UPDATE_REASON_TAB_CLOSE     = 1 << 5;
export const kTABBAR_UPDATE_REASON_TAB_MOVE      = 1 << 6;
export const kTABBAR_UPDATE_REASON_VIRTUAL_SCROLL_VIEWPORT_UPDATE = 1 << 7;

export const kDEFAULT_MIN_INDENT = 3;

export const kGROUP_TAB_URI = browser.runtime.getURL('resources/group-tab.html');
export const kGROUP_TAB_DEFAULT_TITLE_MATCHER = new RegExp(`^${browser.i18n.getMessage('groupTab_label', '.+')}$`);
export const kGROUP_TAB_FROM_PINNED_DEFAULT_TITLE_MATCHER = new RegExp(`^${browser.i18n.getMessage('groupTab_fromPinnedTab_label', '.+')}$`);
export const kSHORTHAND_CUSTOM_URI = /^ext\+ws:([^:?#]+)(?:[:?]([^#]*))?(#.*)?$/;
export const kSHORTHAND_ABOUT_URI = /^about:ws-([^?]+)/;
export const kSHORTHAND_URIS = {
  tabbar:  browser.runtime.getURL('sidebar/sidebar.html'),
  group:   kGROUP_TAB_URI,
  options: browser.runtime.getURL('options/options.html?independent=true'),
  startup: browser.runtime.getURL('resources/startup.html'),
  testRunner:    browser.runtime.getURL('tests/runner.html'),
  'test-runner': browser.runtime.getURL('tests/runner.html')
};

export const kINSERTION_CONTEXT_MOVED = 1;
export const kINSERTION_CONTEXT_SHOWN = 2;
export const kINSERTION_CONTEXT_CREATED = 3;

export const kAGGRESSIVE_OPENER_TAB_DETECTION_RULES_WITH_URL = [
  { opener: /^about:addons/,
    child:  /^https:\/\/addons.mozilla.org\/([^\/]+\/)?[^\/]+\/search\// }
];

export const kNOTIFICATION_DEFAULT_ICON = '/resources/64x64.svg#default-bright';

// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/storage/sync
// Use 6 * 1024 instead of 8 * 1024 (max of the quota) for safety.
// For example, 6 * 8 = 48KB is the max size of the user style rules.
export const kSYNC_STORAGE_SAFE_QUOTA = 6 * 1024;

export const kSYNC_DATA_TYPE_TABS = 'tabs';

export const IS_BACKGROUND = location.href.startsWith(browser.runtime.getURL('background/background.html'));
export const IS_SIDEBAR    = location.href.startsWith(browser.runtime.getURL('sidebar/sidebar.html'));
