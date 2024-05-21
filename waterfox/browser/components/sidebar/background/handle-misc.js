/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  wait,
  mapAndFilterUniq,
  configs,
  loadUserStyleRules,
  doProgressively,
} from '/common/common.js';
import * as ApiTabs from '/common/api-tabs.js';
import * as Bookmark from '/common/bookmark.js';
import * as BrowserTheme from '/common/browser-theme.js';
import * as Constants from '/common/constants.js';
import * as ContextualIdentities from '/common/contextual-identities.js';
import * as Permissions from '/common/permissions.js';
import * as SidebarConnection from '/common/sidebar-connection.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TabsStore from '/common/tabs-store.js';
import * as TabsUpdate from '/common/tabs-update.js';
import * as TreeBehavior from '/common/tree-behavior.js';
import * as TSTAPI from '/common/tst-api.js';

import Tab from '/common/Tab.js';

import * as Background from './background.js';
import * as Commands from './commands.js';
import * as Migration from './migration.js';
import * as TabsGroup from './tabs-group.js';
import * as TabsOpen from './tabs-open.js';
import * as Tree from './tree.js';

function log(...args) {
  internalLogger('background/handle-misc', ...args);
}


/* message observer */

// We cannot start listening of messages of browser.runtime.onMessage(External)
// at here and wait processing until promises are resolved like ApiTabsListener
// and BackgroundConnection, because making listeners asynchornous (async
// functions) will break things - those listeners must not return Promise for
// unneeded cases.
// So we simply ignore messages delivered before completely initialized, for now.
// See also: https://github.com/piroor/treestyletab/issues/2200

const PHASE_LOADING                = 0;
const PHASE_BACKGROUND_INITIALIZED = 1;
const PHASE_BACKGROUND_BUILT       = 2;
const PHASE_BACKGROUND_READY       = 3;
let mInitializationPhase = PHASE_LOADING;

Background.onInit.addListener(() => {
  mInitializationPhase = PHASE_BACKGROUND_INITIALIZED;
});

Background.onBuilt.addListener(() => {
  mInitializationPhase = PHASE_BACKGROUND_BUILT;
});

Background.onReady.addListener(() => {
  mInitializationPhase = PHASE_BACKGROUND_READY;
});

if (browser.sidebarAction)
  (browser.action || browser.browserAction)?.onClicked.addListener(onToolbarButtonClick);
browser.commands.onCommand.addListener(onShortcutCommand);
browser.runtime.onMessage.addListener(onMessage);
TSTAPI.onMessageExternal.addListener(onMessageExternal);


Background.onReady.addListener(() => {
  Bookmark.startTracking();
});

Background.onDestroy.addListener(() => {
  browser.runtime.onMessage.removeListener(onMessage);
  TSTAPI.onMessageExternal.removeListener(onMessageExternal);
  if (browser.sidebarAction)
    (browser.action || browser.browserAction)?.onClicked.removeListener(onToolbarButtonClick);
});


function onToolbarButtonClick(tab) {
  if (mInitializationPhase < PHASE_BACKGROUND_INITIALIZED ||
      Permissions.requestPostProcess())
    return;

  if (typeof browser.sidebarAction.toggle == 'function')
    browser.sidebarAction.toggle();
  else if (SidebarConnection.isSidebarOpen(tab.windowId))
    browser.sidebarAction.close();
  else
    browser.sidebarAction.open();
}

async function onShortcutCommand(command) {
  if (mInitializationPhase < PHASE_BACKGROUND_INITIALIZED)
    return;

  let activeTabs = command.tab ? [command.tab] : await browser.tabs.query({
    active:        true,
    currentWindow: true,
  }).catch(ApiTabs.createErrorHandler());
  if (activeTabs.length == 0)
    activeTabs = await browser.tabs.query({
      currentWindow: true,
    }).catch(ApiTabs.createErrorHandler());
  const activeTab = Tab.get(activeTabs[0].id);
  const selectedTabs = activeTab.$TST.multiselected ? Tab.getSelectedTabs(activeTab.windowId) : [activeTab];
  log('onShortcutCommand ', { command, activeTab, selectedTabs });

  switch (command) {
    case '_execute_browser_action':
      return;

    case 'reloadTree':
      Commands.reloadTree(selectedTabs);
      return;
    case 'reloadDescendants':
      Commands.reloadDescendants(selectedTabs);
      return;
    case 'toggleMuteTree':
      Commands.toggleMuteTree(selectedTabs);
      return;
    case 'toggleMuteDescendants':
      Commands.toggleMuteDescendants(selectedTabs);
      return;
    case 'closeTree':
      Commands.closeTree(selectedTabs);
      return;
    case 'closeDescendants':
      Commands.closeDescendants(selectedTabs);
      return;
    case 'closeOthers':
      Commands.closeOthers(selectedTabs);
      return;
    case 'toggleSticky':
      Commands.toggleSticky(selectedTabs);
      return;
    case 'collapseTree':
      Commands.collapseTree(selectedTabs);
      return;
    case 'collapseTreeRecursively':
      Commands.collapseTree(selectedTabs, { recursively: true });
      return;
    case 'collapseAll':
      Commands.collapseAll(activeTab.windowId);
      return;
    case 'expandTree':
      Commands.expandTree(selectedTabs);
      return;
    case 'expandTreeRecursively':
      Commands.expandTree(selectedTabs, { recursively: true });
      return;
    case 'expandAll':
      Commands.expandAll(activeTab.windowId);
      return;
    case 'bookmarkTree':
      Commands.bookmarkTree(selectedTabs);
      return;

    case 'newIndependentTab':
      Commands.openNewTabAs({
        baseTab: activeTab,
        as:      Constants.kNEWTAB_OPEN_AS_ORPHAN
      });
      return;
    case 'newChildTab':
      Commands.openNewTabAs({
        baseTab: activeTab,
        as:      Constants.kNEWTAB_OPEN_AS_CHILD
      });
      return;
    case 'newChildTabTop':
      Commands.openNewTabAs({
        baseTab: activeTab,
        as:      Constants.kNEWTAB_OPEN_AS_CHILD_TOP
      });
      return;
    case 'newChildTabEnd':
      Commands.openNewTabAs({
        baseTab: activeTab,
        as:      Constants.kNEWTAB_OPEN_AS_CHILD_END
      });
      return;
    case 'newSiblingTab':
      Commands.openNewTabAs({
        baseTab: activeTab,
        as:      Constants.kNEWTAB_OPEN_AS_SIBLING
      });
      return;
    case 'newNextSiblingTab':
      Commands.openNewTabAs({
        baseTab: activeTab,
        as:      Constants.kNEWTAB_OPEN_AS_NEXT_SIBLING
      });
      return;

    case 'newContainerTab':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_SHOW_CONTAINER_SELECTOR,
        windowId: activeTab.windowId
      });
      return;

    case 'tabMoveUp':
      Commands.moveUp(activeTab, { followChildren: false });
      return;
    case 'treeMoveUp':
      Commands.moveUp(activeTab, { followChildren: true });
      return;
    case 'tabMoveDown':
      Commands.moveDown(activeTab, { followChildren: false });
      return;
    case 'treeMoveDown':
      Commands.moveDown(activeTab, { followChildren: true });
      return;

    case 'focusPrevious':
    case 'focusPreviousSilently': {
      const nextActive = activeTab.$TST.nearestVisiblePrecedingTab ||
        Tab.getLastVisibleTab(activeTab.windowId);
      TabsInternalOperation.activateTab(nextActive, {
        silently: /Silently/.test(command)
      });
    }; return;
    case 'focusNext':
    case 'focusNextSilently': {
      const nextActive = activeTab.$TST.nearestVisibleFollowingTab ||
        Tab.getFirstVisibleTab(activeTab.windowId);
      TabsInternalOperation.activateTab(nextActive, {
        silently: /Silently/.test(command)
      });
    }; return;
    case 'focusParent':
      TabsInternalOperation.activateTab(activeTab.$TST.parent);
      return;
    case 'focusFirstChild':
      TabsInternalOperation.activateTab(activeTab.$TST.firstChild);
      return;
    case 'focusLastChild':
      TabsInternalOperation.activateTab(activeTab.$TST.lastChild);
      return;
    case 'focusPreviousSibling':
      TabsInternalOperation.activateTab(
        activeTab.$TST.previousSiblingTab ||
          activeTab.$TST.parent && activeTab.$TST.parent.$TST.lastChild
      );
      return;
    case 'focusNextSibling':
      TabsInternalOperation.activateTab(
        activeTab.$TST.nextSiblingTab ||
          activeTab.$TST.parent && activeTab.$TST.parent.$TST.firstChild
      );
      return;

    case 'tabbarUp':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_SCROLL_TABBAR,
        windowId: activeTab.windowId,
        by:       'lineup'
      });
      return;
    case 'tabbarPageUp':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_SCROLL_TABBAR,
        windowId: activeTab.windowId,
        by:       'pageup'
      });
      return;
    case 'tabbarHome':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_SCROLL_TABBAR,
        windowId: activeTab.windowId,
        to:       'top'
      });
      return;

    case 'tabbarDown':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_SCROLL_TABBAR,
        windowId: activeTab.windowId,
        by:       'linedown'
      });
      return;
    case 'tabbarPageDown':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_SCROLL_TABBAR,
        windowId: activeTab.windowId,
        by:       'pagedown'
      });
      return;
    case 'tabbarEnd':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_SCROLL_TABBAR,
        windowId: activeTab.windowId,
        to:       'bottom'
      });
      return;

    case 'toggleTreeCollapsed':
      if (activeTab.$TST.subtreeCollapsed)
        Commands.expandTree(selectedTabs);
      else
        Commands.collapseTree(selectedTabs);
      return;
    case 'toggleTreeCollapsedRecursively':
      if (activeTab.$TST.subtreeCollapsed)
        Commands.expandTree(selectedTabs, { recursively: true });
      else
        Commands.collapseTree(selectedTabs, { recursively: true });
      return;

    case 'toggleSubPanel':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_TOGGLE_SUBPANEL,
        windowId: activeTab.windowId
      });
      return;
    case 'switchSubPanel':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_SWITCH_SUBPANEL,
        windowId: activeTab.windowId
      });
      return;
    case 'increaseSubPanel':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_INCREASE_SUBPANEL,
        windowId: activeTab.windowId
      });
      return;
    case 'decreaseSubPanel':
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_DECREASE_SUBPANEL,
        windowId: activeTab.windowId
      });
      return;
  }
}

// This must be synchronous and return Promise on demando, to avoid
// blocking to other listeners.
function onMessage(message, sender) {
  if (mInitializationPhase < PHASE_BACKGROUND_BUILT ||
      !message ||
      typeof message.type != 'string' ||
      message.type.indexOf('ws:') != 0)
    return;

  //log('onMessage: ', message, sender);
  switch (message.type) {
    case Constants.kCOMMAND_GET_INSTANCE_ID:
      return Promise.resolve(Background.instanceId);

    case Constants.kCOMMAND_RELOAD:
      return Background.reload({ all: message.all });

    case Constants.kCOMMAND_REQUEST_UNIQUE_ID:
      return (async () => {
        if (!Tab.get(message.tabId))
          await Tab.waitUntilTracked(message.tabId);
        const tab = Tab.get(message.tabId);
        return tab ? tab.$TST.promisedUniqueId : {};
      })();

    case Constants.kCOMMAND_GET_THEME_DECLARATIONS:
      return browser.theme.getCurrent().then(theme => BrowserTheme.generateThemeDeclarations(theme));

    case Constants.kCOMMAND_GET_CONTEXTUAL_IDENTITIES_COLOR_INFO:
      return Promise.resolve(ContextualIdentities.getColorInfo());

    case Constants.kCOMMAND_GET_CONFIG_VALUE:
      if (Array.isArray(message.keys)) {
        const values = {};
        for (const key of message.keys) {
          values[key] = configs[key];
        }
        return Promise.resolve(values);
      }
      return Promise.resolve(configs[message.key]);

    case Constants.kCOMMAND_SET_CONFIG_VALUE:
      return Promise.resolve(configs[message.key] = message.value);

    case Constants.kCOMMAND_GET_USER_STYLE_RULES:
      return Promise.resolve(loadUserStyleRules());

    case Constants.kCOMMAND_PING_TO_BACKGROUND: // return tabs as the pong, to optimizie further initialization tasks in the sidebar
    case Constants.kCOMMAND_PULL_TABS:
      if (message.windowId) {
        TabsUpdate.completeLoadingTabs(message.windowId); // don't wait here for better perfomance
        return Promise.resolve(TabsStore.windows.get(message.windowId).export(true));
      }
      return Promise.resolve(message.tabIds.map(id => {
        const tab = Tab.get(id);
        return tab && tab.$TST.export(true);
      }));

    case Constants.kCOMMAND_PULL_TABS_ORDER:
      return Promise.resolve(TabsStore.windows.get(message.windowId).order);

    case Constants.kCOMMAND_PULL_TREE_STRUCTURE:
      return (async () => {
        while (mInitializationPhase < PHASE_BACKGROUND_READY) {
          await wait(10);
        }
        const structure = TreeBehavior.getTreeStructureFromTabs(
          message.windowId ?
            Tab.getAllTabs(message.windowId) :
            message.tabIds.map(id => Tab.get(id))
        );
        return { structure };
      })();

    case Constants.kCOMMAND_NOTIFY_PERMISSIONS_GRANTED:
      return (async () => {
        const grantedPermission = JSON.stringify(message.permissions);
        if (grantedPermission == JSON.stringify(Permissions.ALL_URLS)) {
          const tabs = await browser.tabs.query({}).catch(ApiTabs.createErrorHandler());
          await Tab.waitUntilTracked(tabs.map(tab => tab.id));
          for (const tab of tabs) {
            Background.tryStartHandleAccelKeyOnTab(Tab.get(tab.id));
          }
        }
        else if (grantedPermission == JSON.stringify(Permissions.BOOKMARKS)) {
          Migration.migrateBookmarkUrls();
          Bookmark.startTracking();
        }
      })();

    case Constants.kCOMMAND_SIMULATE_SIDEBAR_MESSAGE: {
      SidebarConnection.onMessage.dispatch(message.message.windowId, message.message);
    }; break;

    case Constants.kCOMMAND_CONFIRM_TO_CLOSE_TABS:
      log('kCOMMAND_CONFIRM_TO_CLOSE_TABS: ', { message });
      return Background.confirmToCloseTabs(message.tabs, message);

    default:
      if (TSTAPI.INTERNAL_CALL_PREFIX_MATCHER.test(message.type)) {
        return onMessageExternal({
          ...message,
          type: message.type.replace(TSTAPI.INTERNAL_CALL_PREFIX_MATCHER, ''),
        }, sender);
      }
      break;
  }
}

// This must be synchronous and return Promise on demando, to avoid
// blocking to other listeners.
function onMessageExternal(message, sender) {
  if (mInitializationPhase < PHASE_BACKGROUND_INITIALIZED)
    return;

  switch (message.type) {
    case TSTAPI.kGET_VERSION:
      return Promise.resolve(browser.runtime.getManifest().version);

    case TSTAPI.kGET_TREE:
      return (async () => {
        const tabs = await (message.rendered ?
          TSTAPI.getTargetRenderedTabs(message, sender) :
          TSTAPI.getTargetTabs(message, sender));
        const cache = {};
        const treeItems = Array.from(tabs, tab => TSTAPI.exportTab(tab, {
          interval: message.interval,
          cache,
        }));
        const result = TSTAPI.formatTabResult(
          treeItems,
          {
            ...message,
            // This must return an array of root tabs if just the window id is specified.
            // See also: https://github.com/piroor/treestyletab/issues/2763
            ...((message.window || message.windowId) && !message.tab && !message.tabs ? { tab: '*' } : {})
          },
          sender.id
        );
        TSTAPI.clearCache(cache);
        return result;
      })();

    case TSTAPI.kGET_LIGHT_TREE:
      return (async () => {
        const tabs = await (message.rendered ?
          TSTAPI.getTargetRenderedTabs(message, sender) :
          TSTAPI.getTargetTabs(message, sender));
        const cache = {};
        const treeItems = Array.from(tabs, tab => TSTAPI.exportTab(tab, {
          light:    true,
          interval: message.interval,
          cache,
        }));
        const result = TSTAPI.formatTabResult(
          treeItems,
          {
            ...message,
            // This must return an array of root tabs if just the window id is specified.
            // See also: https://github.com/piroor/treestyletab/issues/2763
            ...((message.window || message.windowId) && !message.tab && !message.tabs ? { tab: '*' } : {})
          },
          sender.id
        );
        TSTAPI.clearCache(cache);
        return result;
      })();

    case TSTAPI.kSTICK_TAB:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        await doProgressively(
          tabs,
          tab => Commands.toggleSticky(tab, true),
          message.interval
        );
        return true;
      })();

    case TSTAPI.kUNSTICK_TAB:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        await doProgressively(
          tabs,
          tab => Commands.toggleSticky(tab, false),
          message.interval
        );
        return true;
      })();

    case TSTAPI.kTOGGLE_STICKY_STATE:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        let firstTabIsSticky = undefined;
        await doProgressively(
          tabs,
          tab => {
            if (firstTabIsSticky === undefined)
              firstTabIsSticky = tab.$TST.sticky;
            Commands.toggleSticky(tab, !firstTabIsSticky);
          },
          message.interval
        );
        return true;
      })();

    case TSTAPI.kCOLLAPSE_TREE:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        await doProgressively(
          tabs,
          tab => Commands.collapseTree(tab, {
            recursively: !!message.recursively
          }),
          message.interval
        );
        return true;
      })();

    case TSTAPI.kEXPAND_TREE:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        await doProgressively(
          tabs,
          tab => Commands.expandTree(tab, {
            recursively: !!message.recursively
          }),
          message.interval
        );
        return true;
      })();

    case TSTAPI.kTOGGLE_TREE_COLLAPSED:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        await doProgressively(
          tabs,
          tab => Tree.collapseExpandSubtree(tab, {
            collapsed: !tab.$TST.subtreeCollapsed,
            broadcast: true
          }),
          message.interval
        );
        return true;
      })();

    case TSTAPI.kATTACH:
      return (async () => {
        await Tab.waitUntilTracked([
          message.child,
          message.parent,
          message.insertBefore,
          message.insertAfter
        ]);
        const child  = Tab.get(message.child);
        const parent = Tab.get(message.parent);
        if (!child ||
            !parent ||
            child.windowId != parent.windowId)
          return false;
        await Tree.attachTabTo(child, parent, {
          broadcast:    true,
          insertBefore: Tab.get(message.insertBefore),
          insertAfter:  Tab.get(message.insertAfter)
        });
        if (child.$TST.collapsed &&
            !parent.$TST.collapsed &&
            !parent.$TST.subtreeCollapsed) {
          await Tree.collapseExpandTabAndSubtree(child, {
            collapsed: false,
            bradcast:  true
          });
        }
        return true;
      })();

    case TSTAPI.kDETACH:
      return (async () => {
        await Tab.waitUntilTracked(message.tab);
        const tab = Tab.get(message.tab);
        if (!tab)
          return false;
        await Tree.detachTab(tab, {
          broadcast: true
        });
        if (tab.$TST.collapsed) {
          await Tree.collapseExpandTabAndSubtree(tab, {
            collapsed: false,
            bradcast:  true
          });
        }
        return true;
      })();

    case TSTAPI.kINDENT:
    case TSTAPI.kDEMOTE:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        const results = await doProgressively(
          tabs,
          tab => Commands.indent(tab, message),
          message.interval
        );
        return TSTAPI.formatResult(results, message);
      })();

    case TSTAPI.kOUTDENT:
    case TSTAPI.kPROMOTE:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        const results = await doProgressively(
          tabs,
          tab => Commands.outdent(tab, message),
          message.interval
        );
        return TSTAPI.formatResult(results, message);
      })();

    case TSTAPI.kMOVE_UP:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        const results = await doProgressively(
          tabs,
          tab => Commands.moveUp(tab, message),
          message.interval
        );
        return TSTAPI.formatResult(results, message);
      })();

    case TSTAPI.kMOVE_TO_START:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        await Commands.moveTabsToStart(Array.from(tabs));
        return true;
      })();

    case TSTAPI.kMOVE_DOWN:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        const results = await doProgressively(
          tabs,
          tab => Commands.moveDown(tab, message),
          message.interval
        );
        return TSTAPI.formatResult(results, message);
      })();

    case TSTAPI.kMOVE_TO_END:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        await Commands.moveTabsToEnd(Array.from(tabs));
        return true;
      })();

    case TSTAPI.kMOVE_BEFORE:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        const results = await doProgressively(
          tabs,
          tab => Commands.moveBefore(tab, message),
          message.interval
        );
        return TSTAPI.formatResult(results, message);
      })();

    case TSTAPI.kMOVE_AFTER:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        const results = await doProgressively(
          tabs,
          tab => Commands.moveAfter(tab, message),
          message.interval
        );
        return TSTAPI.formatResult(results, message);
      })();

    case TSTAPI.kFOCUS:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        const tabsArray = await doProgressively(
          tabs,
          tab => {
            TabsInternalOperation.activateTab(tab, {
              silently: message.silently
            });
            return tab;
          },
          message.interval
        );
        return TSTAPI.formatResult(tabsArray.map(() => true), message);
      })();

    case TSTAPI.kCREATE:
      return (async () => {
        const windowId = message.params.windowId;
        const win = TabsStore.windows.get(windowId);
        if (!win)
          throw new Error(`invalid windowId ${windowId}: it must be valid window id`);
        win.bypassTabControlCount++;
        const tab = await TabsOpen.openURIInTab(message.params, { windowId });
        return TSTAPI.exportTab(tab, { addonId: sender.id });
      })();

    case TSTAPI.kDUPLICATE:
      return (async () => {
        const tabs   = await TSTAPI.getTargetTabs(message, sender);
        let behavior = configs.autoAttachOnDuplicated;
        switch (String(message.as || 'sibling').toLowerCase()) {
          case 'child':
            behavior = behavior == Constants.kNEWTAB_OPEN_AS_CHILD_TOP ?
              Constants.kNEWTAB_OPEN_AS_CHILD_TOP :
              behavior == Constants.kNEWTAB_OPEN_AS_CHILD_END ?
                Constants.kNEWTAB_OPEN_AS_CHILD_END :
                Constants.kNEWTAB_OPEN_AS_CHILD;
            break;
          case 'first-child':
            behavior = Constants.kNEWTAB_OPEN_AS_CHILD_TOP;
            break;
          case 'last-child':
            behavior = Constants.kNEWTAB_OPEN_AS_CHILD_END;
            break;
          case 'sibling':
            behavior = Constants.kNEWTAB_OPEN_AS_SIBLING;
            break;
          case 'nextsibling':
            behavior = Constants.kNEWTAB_OPEN_AS_NEXT_SIBLING;
            break;
          case 'orphan':
            behavior = Constants.kNEWTAB_OPEN_AS_ORPHAN;
            break;
          default:
            break;
        }
        const tabsArray = await doProgressively(
          tabs,
          async tab => {
            return Commands.duplicateTab(tab, {
              destinationWindowId: tab.windowId,
              behavior,
              multiselected: false
            });
          },
          message.interval
        );
        return TSTAPI.formatResult(tabsArray.map(() => true), message);
      })();

    case TSTAPI.kGROUP_TABS:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        const tab = await TabsGroup.groupTabs(Array.from(tabs), {
          title:     message.title,
          broadcast: true,
        });
        if (!tab)
          return null;
        return TSTAPI.exportTab(tab, { addonId: sender.id });
      })();

    case TSTAPI.kOPEN_IN_NEW_WINDOW:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        const windowId = await Commands.openTabsInWindow(Array.from(tabs), {
          multiselected: false
        });
        return windowId;
      })();

    case TSTAPI.kREOPEN_IN_CONTAINER:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        const reopenedTabs = await Commands.reopenInContainer(
          Array.from(tabs),
          message.containerId || 'firefox-default'
        );
        const cache = {};
        const result = await TSTAPI.formatTabResult(
          reopenedTabs.map(tab => TSTAPI.exportTab(tab, {
            interval: message.interval,
            addonId:  sender.id,
            cache,
          })),
          message
        );
        TSTAPI.clearCache(cache);
        return result;
      })();

    case TSTAPI.kGET_TREE_STRUCTURE:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        return Promise.resolve(TreeBehavior.getTreeStructureFromTabs(Array.from(tabs)));
      })();

    case TSTAPI.kSET_TREE_STRUCTURE:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        await Tree.applyTreeStructureToTabs(
          Array.from(tabs),
          message.structure,
          { broadcast: true }
        );
        return Promise.resolve(true);
      })();

    case TSTAPI.kADD_TAB_STATE:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        let states = message.state || message.states;
        if (!Array.isArray(states))
          states = [states];
        states = mapAndFilterUniq(states, state => state && String(state) || undefined);
        if (states.length == 0)
          return true;
        const tabsArray = await doProgressively(
          tabs,
          tab => {
            for (const state of states) {
              tab.$TST.addState(state);
            }
            return tab;
          },
          message.interval
        );
        Tab.broadcastState(tabsArray, {
          add: states
        });
        return true;
      })();

    case TSTAPI.kREMOVE_TAB_STATE:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        let states = message.state || message.states;
        if (!Array.isArray(states))
          states = [states];
        states = mapAndFilterUniq(states, state => state && String(state) || undefined);
        if (states.length == 0)
          return true;
        const tabsArray = await doProgressively(
          tabs,
          tab => {
            for (const state of states) {
              tab.$TST.removeState(state);
            }
            return tab;
          },
          message.interval
        );
        Tab.broadcastState(tabsArray, {
          remove: states
        });
        return true;
      })();

    case TSTAPI.kGRANT_TO_REMOVE_TABS:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        configs.grantedRemovingTabIds = mapAndFilterUniq(configs.grantedRemovingTabIds.concat(tabs), tab => {
          tab = TabsStore.ensureLivingTab(tab);
          return tab && tab.id || undefined;
        });
        return true;
      })();

    case TSTAPI.kSTART_CUSTOM_DRAG:
      return (async () => {
        SidebarConnection.sendMessage({
          type:     Constants.kNOTIFY_TAB_MOUSEDOWN_EXPIRED,
          windowId: message.windowId || (await browser.windows.getLastFocused({ populate: false }).catch(ApiTabs.createErrorHandler())).id,
          button:   message.button || 0
        });
      })();

    case TSTAPI.kOPEN_ALL_BOOKMARKS_WITH_STRUCTURE:
      return Commands.openAllBookmarksWithStructure(
        message.id || message.bookmarkId,
        { discarded: message.discarded }
      );

    case TSTAPI.kSET_TOOLTIP_TEXT:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        for (const tab of tabs) {
          tab.$TST.registerTooltipText(sender.id, message.text || '', !!message.force);
        }
        return true;
      })();

    case TSTAPI.kCLEAR_TOOLTIP_TEXT:
      return (async () => {
        const tabs = await TSTAPI.getTargetTabs(message, sender);
        for (const tab of tabs) {
          tab.$TST.unregisterTooltipText(sender.id);
        }
        return true;
      })();

    case TSTAPI.kREGISTER_AUTO_STICKY_STATES:
      Tab.registerAutoStickyState(sender.id, message.state || message.states);
      break;

    case TSTAPI.kUNREGISTER_AUTO_STICKY_STATES:
      Tab.unregisterAutoStickyState(sender.id, message.state || message.states);
      break;
  }
}

Tab.onStateChanged.addListener((tab, state, added) => {
  switch (state) {
    case Constants.kTAB_STATE_STICKY:
      if (TSTAPI.hasListenerForMessageType(TSTAPI.kNOTIFY_TAB_STICKY_STATE_CHANGED)) {
        TSTAPI.broadcastMessage({
          type:   TSTAPI.kNOTIFY_TAB_STICKY_STATE_CHANGED,
          tab,
          sticky: !!added,
        }, { tabProperties: ['tab'] }).catch(_error => {});
      }
      break;
  }
});
