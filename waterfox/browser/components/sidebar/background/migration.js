/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  configs,
  saveUserStyleRules,
  notify,
  wait,
  isLinux,
  isMacOS,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Permissions from '/common/permissions.js';

// eslint-disable-next-line no-unused-vars
function log(...args) {
  internalLogger('background/migration', ...args);
}

const kCONFIGS_VERSION = 31;
const kFEATURES_VERSION = 9;

export function migrateConfigs() {
  switch (configs.configsVersion) {
    case 0:
    case 1:
      if (configs.startDragTimeout !== null)
        configs.longPressDuration = configs.startDragTimeout;
      if (configs.emulateDefaultContextMenu !== null)
        configs.emulateDefaultContextMenu = configs.emulateDefaultContextMenu;

    case 2:
      if (configs.simulateSelectOwnerOnClose !== null &&
          !configs.simulateSelectOwnerOnClose)
        configs.successorTabControlLevel = Constants.kSUCCESSOR_TAB_CONTROL_NEVER;

    case 3:
      if (!(configs.tabDragBehavior & Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK))
        configs.tabDragBehavior |= Constants.kDRAG_BEHAVIOR_TEAR_OFF;
      if (!(configs.tabDragBehaviorShift & Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK))
        configs.tabDragBehaviorShift |= Constants.kDRAG_BEHAVIOR_TEAR_OFF;

    case 4:
      if (configs.fakeContextMenu !== null)
        configs.emulateDefaultContextMenu = configs.fakeContextMenu;
      if (configs.context_closeTabOptions_closeTree !== null)
        configs.context_topLevel_closeTree        = configs.context_closeTabOptions_closeTree;
      if (configs.context_closeTabOptions_closeDescendants !== null)
        configs.context_topLevel_closeDescendants = configs.context_closeTabOptions_closeDescendants;
      if (configs.context_closeTabOptions_closeOthers !== null)
        configs.context_topLevel_closeOthers      = configs.context_closeTabOptions_closeOthers;

    case 5:
      if (configs.scrollbarMode !== null) {
        switch (configs.scrollbarMode < 0 ? (isMacOS() ? 3 : 1) : configs.scrollbarMode) {
          case 0: // default, refular width
            configs.userStyleRules += `

/* regular width scrollbar */
#tabbar { scrollbar-width: auto; }`;
            break;
          case 1: // narrow width
            break;
          case 2: // hide
            configs.userStyleRules += `

/* hide scrollbar */
#tabbar { scrollbar-width: none; }

/* cancel spaces for macOS overlay scrollbar */
:root.platform-mac #tabbar:dir(rtl).overflow .tab:not(.pinned) {
  padding-left: 0;
}
:root.platform-mac #tabbar:dir(ltr).overflow .tab:not(.pinned) {
  padding-right: 0;
}`;
            break;
          case 3: // overlay (macOS)
            break;
        }
      }
      if (configs.sidebarScrollbarPosition !== null) {
        switch (configs.sidebarScrollbarPosition) {
          default:
          case 0: // auto
          case 1: // left
            break;
            break;
          case 2: // right
            configs.userStyleRules += `

/* put scrollbar rightside */
:root.left #tabbar { direction: ltr; }`;
            break;
        }
      }

    case 6:
      if (configs.promoteFirstChildForClosedRoot != null &&
          configs.promoteFirstChildForClosedRoot &&
          configs.closeParentBehavior == Constants.kPARENT_TAB_OPERATION_BEHAVIOR_PROMOTE_ALL_CHILDREN)
        configs.closeParentBehavior = Constants.kPARENT_TAB_OPERATION_BEHAVIOR_PROMOTE_INTELLIGENTLY;
      if (configs.parentTabBehaviorForChanges !== null) {
        switch (configs.parentTabBehaviorForChanges) {
          case Constants.kPARENT_TAB_BEHAVIOR_ALWAYS:
            configs.parentTabOperationBehaviorMode = Constants.kPARENT_TAB_OPERATION_BEHAVIOR_MODE_CONSISTENT;
            break;
          default:
          case Constants.kPARENT_TAB_BEHAVIOR_ONLY_WHEN_VISIBLE:
            configs.parentTabOperationBehaviorMode = Constants.kPARENT_TAB_OPERATION_BEHAVIOR_MODE_PARALLEL;
            break;
          case Constants.kPARENT_TAB_BEHAVIOR_ONLY_ON_SIDEBAR:
            configs.parentTabOperationBehaviorMode = Constants.kPARENT_TAB_OPERATION_BEHAVIOR_MODE_CUSTOM;
            configs.closeParentBehavior_outsideSidebar_expanded = configs.closeParentBehavior_noSidebar_expanded = configs.  closeParentBehavior;
            break;
        }
      }

    case 7:
      if (configs.collapseExpandSubtreeByDblClick !== null &&
          configs.collapseExpandSubtreeByDblClick)
        configs.treeDoubleClickBehavior = Constants.kTREE_DOUBLE_CLICK_BEHAVIOR_TOGGLE_COLLAPSED;

    case 8:
      if (configs.autoExpandOnCollapsedChildActive !== null)
        configs.unfocusableCollapsedTab = configs.autoExpandOnCollapsedChildActive;

    case 9:
      if (configs.simulateCloseTabByDblclick !== null &&
          configs.simulateCloseTabByDblclick)
        configs.treeDoubleClickBehavior = Constants.kTREE_DOUBLE_CLICK_BEHAVIOR_CLOSE;

    case 10:
      if (configs.style == 'plain-dark' ||
          configs.style == 'metal')
        configs.style = configs.$default.style;

    case 11:
      if (configs.userStyleRules) {
        configs.userStyleRules0 = configs.userStyleRules;
        configs.userStyleRules = '';
      }

    case 12:
      try {
        saveUserStyleRules(Array.from(new Uint8Array(8), (_, index) => {
          const key = `userStyleRules${index}`;
          if (key in configs) {
            const chunk = configs[key];
            configs[key] = '';
            return chunk || '';
          }
          else {
            return '';
          }
        }).join(''));
      }
      catch(error) {
        console.error(error);
      }

    case 13:
      if (configs.style == 'mixed' ||
          configs.style == 'vertigo')
        configs.style = 'photon';

    case 14:
      if (configs.inheritContextualIdentityToNewChildTab !== null)
        configs.inheritContextualIdentityToChildTabMode = configs.inheritContextualIdentityToNewChildTab ? Constants.kCONTEXTUAL_IDENTITY_FROM_PARENT : Constants.kCONTEXTUAL_IDENTITY_DEFAULT;
      if (configs.inheritContextualIdentityToSameSiteOrphan !== null)
        configs.inheritContextualIdentityToSameSiteOrphanMode = configs.inheritContextualIdentityToSameSiteOrphan ? Constants.kCONTEXTUAL_IDENTITY_FROM_LAST_ACTIVE : Constants.kCONTEXTUAL_IDENTITY_DEFAULT;
      if (configs.inheritContextualIdentityToTabsFromExternal !== null)
        configs.inheritContextualIdentityToTabsFromExternalMode = configs.inheritContextualIdentityToTabsFromExternal ? Constants.kCONTEXTUAL_IDENTITY_FROM_PARENT : Constants.kCONTEXTUAL_IDENTITY_DEFAULT;

    case 15:
      if (configs.moveDroppedTabToNewWindowForUnhandledDragEvent !== null &&
          !configs.moveDroppedTabToNewWindowForUnhandledDragEvent) {
        if (configs.tabDragBehavior & Constants.kDRAG_BEHAVIOR_TEAR_OFF)
          configs.tabDragBehavior = configs.tabDragBehavior ^ Constants.kDRAG_BEHAVIOR_TEAR_OFF;
        else if (configs.tabDragBehavior & Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK)
          configs.tabDragBehavior = configs.tabDragBehavior ^ Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK;

        if (configs.tabDragBehaviorShift & Constants.kDRAG_BEHAVIOR_TEAR_OFF)
          configs.tabDragBehaviorShift = configs.tabDragBehaviorShift ^ Constants.kDRAG_BEHAVIOR_TEAR_OFF;
        else if (configs.tabDragBehaviorShift & Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK)
          configs.tabDragBehaviorShift = configs.tabDragBehaviorShift ^ Constants.kDRAG_BEHAVIOR_ALLOW_BOOKMARK;
      }

    case 16:
      configs.maximumDelayForBug1561879 = Math.max(configs.$default.maximumDelayForBug1561879, configs.maximumDelayForBug1561879);

    case 17:
      configs.tabDragBehavior |= Constants.kDRAG_BEHAVIOR_MOVE;
      configs.tabDragBehaviorShift |= Constants.kDRAG_BEHAVIOR_MOVE;

    case 18:
      if (configs.connectionTimeoutDelay == 5000)
        configs.connectionTimeoutDelay = configs.$default.connectionTimeoutDelay;

    case 19:
      if (configs.suppressGapFromShownOrHiddenToolbar !== null) {
        configs.suppressGapFromShownOrHiddenToolbarOnNewTab =
          configs.suppressGapFromShownOrHiddenToolbarOnFullScreen = configs.suppressGapFromShownOrHiddenToolbar;
      }

    case 20:
      if (configs.treatTreeAsExpandedOnClosedWithNoSidebar !== null) {
        configs.treatTreeAsExpandedOnClosed_noSidebar = configs.treatTreeAsExpandedOnClosedWithNoSidebar;
      }

    case 21:
      if (configs.style == 'plain')
        configs.style = 'photon';

    case 22:
    case 23:
      if (configs.closeParentBehaviorMode !== null) {
        configs.parentTabOperationBehaviorMode = configs.closeParentBehaviorMode;
      }
      if (configs.closeParentBehavior !== null) {
        configs.closeParentBehavior_insideSidebar_expanded =
          configs.closeParentBehavior;
      }
      if (configs.closeParentBehavior_outsideSidebar !== null) {
        configs.closeParentBehavior_outsideSidebar_expanded =
          configs.moveParentBehavior_outsideSidebar_expanded =
          configs.closeParentBehavior_outsideSidebar;
      }
      if (configs.closeParentBehavior_noSidebar !== null) {
        configs.closeParentBehavior_noSidebar_expanded =
          configs.closeParentBehavior_noSidebar_expanded =
          configs.closeParentBehavior_noSidebar;
      }
      if (configs.treatTreeAsExpandedOnClosed_outsideSidebar === true) {
        configs.closeParentBehavior_outsideSidebar_collapsed =
          configs.moveParentBehavior_outsideSidebar_collapsed =
          configs.moveParentBehavior_outsideSidebar_expanded;
      }
      if (configs.treatTreeAsExpandedOnClosed_noSidebar === false) {
        configs.closeParentBehavior_noSidebar_collapsed =
          configs.moveParentBehavior_noSidebar_collapsed =
          Constants.kPARENT_TAB_OPERATION_BEHAVIOR_ENTIRE_TREE;
      }
      if (configs.treatTreeAsExpandedOnClosed_outsideSidebar === true ||
          configs.treatTreeAsExpandedOnClosed_noSidebar === false) {
        configs.parentTabOperationBehaviorMode = Constants.kPARENT_TAB_OPERATION_BEHAVIOR_MODE_CUSTOM;
      }

    case 24:
      if (configs.autoGroupNewTabsTimeout !== null)
        configs.tabBunchesDetectionTimeout = configs.autoGroupNewTabsTimeout;
      if (configs.autoGroupNewTabsDelayOnNewWindow !== null)
        configs.tabBunchesDetectionDelayOnNewWindow = configs.autoGroupNewTabsDelayOnNewWindow;

    case 25:
      if (configs.autoHiddenScrollbarPlaceholderSize !== null)
        configs.shiftTabsForScrollbarDistance = configs.autoHiddenScrollbarPlaceholderSize;

    case 26:
      if (!configs.guessNewOrphanTabAsOpenedByNewTabCommandUrl.includes('about:privatebrowsing'))
        configs.guessNewOrphanTabAsOpenedByNewTabCommandUrl = `${configs.guessNewOrphanTabAsOpenedByNewTabCommandUrl.trim().replace(/\|$/, '')}|about:privatebrowsing`;

    case 27:
      if (configs.openAllBookmarksWithGroupAlways !== null)
        configs.suppressGroupTabForStructuredTabsFromBookmarks = !configs.openAllBookmarksWithGroupAlways;

    case 28:
      if (configs.heartbeatInterval == 1000)
        configs.heartbeatInterval = configs.$default.heartbeatInterval;

    case 29:
      const autoAttachKeys = [
        'autoAttachOnOpenedWithOwner',
        'autoAttachOnNewTabCommand',
        'autoAttachOnContextNewTabCommand',
        'autoAttachOnNewTabButtonMiddleClick',
        'autoAttachOnNewTabButtonAccelClick',
        'autoAttachOnDuplicated',
        'autoAttachSameSiteOrphan',
        'autoAttachOnOpenedFromExternal',
        'autoAttachOnAnyOtherTrigger',
      ];
      if (configs.insertNewChildAt != configs.$default.insertNewChildAt &&
          (configs.insertNewChildAt == Constants.kINSERT_TOP ||
           configs.insertNewChildAt == Constants.kINSERT_END)) {
        for (const key of autoAttachKeys) {
          if (configs[key] != configs.$default[key] &&
              configs[key] != Constants.kNEWTAB_OPEN_AS_CHILD)
            continue;
          if (configs.insertNewChildAt == Constants.kINSERT_TOP)
            configs[key] = Constants.kNEWTAB_OPEN_AS_CHILD_TOP;
          else
            configs[key] = Constants.kNEWTAB_OPEN_AS_CHILD_END;
        }
      }
      else {
        for (const key of autoAttachKeys) {
          if (configs[key] == Constants.kNEWTAB_OPEN_AS_CHILD)
            configs[key] = Constants.kNEWTAB_OPEN_AS_CHILD_TOP;
        }
      }

    case 30:
      browser.windows.getAll().then(windows => {
        for (const win of windows) {
          browser.sessions.removeWindowValue(win.id, Constants.kWINDOW_STATE_CACHED_SIDEBAR);
          browser.sessions.removeWindowValue(win.id, Constants.kWINDOW_STATE_CACHED_SIDEBAR_TABS_DIRTY);
          browser.sessions.removeWindowValue(win.id, Constants.kWINDOW_STATE_CACHED_SIDEBAR_COLLAPSED_DIRTY);
        }
      });
  }
  configs.configsVersion = kCONFIGS_VERSION;
}

export function tryNotifyNewFeatures() {
  /*
  let featuresVersionOffset = 0;
  const browserInfo = await browser.runtime.getBrowserInfo().catch(ApiTabs.createErrorHandler());
  // "search" permission becomes available!
  if (parseInt(browserInfo.version.split('.')[0]) >= 63)
    featuresVersionOffset++;
  // "menus.overrideContext" permission becomes available!
  if (parseInt(browserInfo.version.split('.')[0]) >= 64)
    featuresVersionOffset++;
  */

  const featuresVersion = kFEATURES_VERSION /*+ featuresVersionOffset*/;
  const isInitialInstall = configs.notifiedFeaturesVersion == 0;

  if (configs.notifiedFeaturesVersion >= featuresVersion)
    return;
  configs.notifiedFeaturesVersion = featuresVersion;

  if (isInitialInstall &&
      !configs.syncOtherDevicesDetected &&
      Object.keys(configs.syncDevices).length > 1) {
    configs.syncAvailableNotified = true;
    configs.syncOtherDevicesDetected = true;
  }

  const typeSuffix = isInitialInstall ? 'installed' : 'updated';
  const platformSuffix = isLinux() ? '_linux' : '';
  const url = isInitialInstall ? Constants.kSHORTHAND_URIS.startup : browser.i18n.getMessage('message_startup_history_uri');
  notify({
    url,
    title:   browser.i18n.getMessage(`startup_notification_title_${typeSuffix}`),
    message: browser.i18n.getMessage(`startup_notification_message_${typeSuffix}${platformSuffix}`),
    timeout: 90 * 1000
  });
}


// Auto-migration of bookmarked internal URLs
//
// Internal URLs like "moz-extension://(UUID)/..." are runtime environment
// dependent and unavailable when such bookmarks are loaded in different
// runtime environment, for example they are synchronized from other devices.
// Thus we should migrate such internal URLs to universal shorthand URIs like
// "ext+ws:(name)".

export async function migrateBookmarkUrls() {
  const granted = await Permissions.isGranted(Permissions.BOOKMARKS);
  if (!granted)
    return;

  startBookmarksUrlAutoMigration();

  const urls = new Set(configs.migratedBookmarkUrls);
  const migrations = [];
  const updates = [];
  for (const key in Constants.kSHORTHAND_URIS) {
    const url = Constants.kSHORTHAND_URIS[key].split('?')[0];
    if (urls.has(url))
      continue;

    const shorthand = `ext+ws:${key.toLowerCase()}`;
    migrations.push(browser.bookmarks.search({ query: url })
      .then(bookmarks => {
        for (const bookmark of bookmarks) {
          updates.push(browser.bookmarks.update(bookmark.id, {
            url: bookmark.url.replace(url, shorthand)
          }));
        }
      }));
    urls.add(url);
  }
  if (migrations.length > 0)
    await Promise.all(migrations);
  if (updates.length > 0)
    await Promise.all(updates);
  if (urls.size > configs.migratedBookmarkUrls.length)
    configs.migratedBookmarkUrls = Array.from(urls);
}

async function migrateBookmarkUrl(bookmark) {
  for (const key in Constants.kSHORTHAND_URIS) {
    const url = Constants.kSHORTHAND_URIS[key].split('?')[0];
    if (!bookmark.url.startsWith(url))
      continue;

    const shorthand = `ext+ws:${key.toLowerCase()}`;
    return browser.bookmarks.update(bookmark.id, {
      url: bookmark.url.replace(url, shorthand)
    });
  }
}

let mObservingBookmarks = false;
let mBookmarksListenersRegistered = false;

function onBookmarkCreated(id, bookmark) {
  if (!mObservingBookmarks)
    return;

  if (bookmark.url)
    migrateBookmarkUrl(bookmark);
}

async function onBookmarkChanged(id, changeInfo) {
  if (!mObservingBookmarks)
    return;

  if (changeInfo.url &&
      changeInfo.url.startsWith(browser.runtime.getURL(''))) {
    const bookmark = await browser.bookmarks.get(id);
    if (Array.isArray(bookmark))
      bookmark.forEach(migrateBookmarkUrl);
    else
      migrateBookmarkUrl(bookmark);
  }
}

if (browser.bookmarks &&
    browser.bookmarks.onCreated) {
  browser.bookmarks.onCreated.addListener(onBookmarkCreated);
  browser.bookmarks.onChanged.addListener(onBookmarkChanged);
  mBookmarksListenersRegistered = true;
}

async function startBookmarksUrlAutoMigration() {
  if (mObservingBookmarks)
    return;

  mObservingBookmarks = true;

  if (mBookmarksListenersRegistered ||
      !browser.bookmarks ||
      !browser.bookmarks.onCreated)
    return;

  browser.bookmarks.onCreated.addListener(onBookmarkCreated);
  browser.bookmarks.onChanged.addListener(onBookmarkChanged);
  mBookmarksListenersRegistered = true;
}


configs.$loaded.then(() => {
  configs.$addObserver(async key => {
    // This may be triggered not only "reset all", but while importing of configs also.
    // We should try initial migration after all configs are successfully imported.
    await wait(100);
    if (key == 'configsVersion' &&
        configs.configsVersion == 0)
      migrateConfigs();
  });
});
