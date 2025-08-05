/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  configs,
  log as internalLogger,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as TabsStore from '/common/tabs-store.js';
import { Tab } from '/common/TreeItem.js';

import InContentPanelController from '/resources/module/InContentPanelController.js';
import TabGroupMenuPanel from '/resources/module/TabGroupMenuPanel.js'; // the IMPL

function log(...args) {
  internalLogger('sidebar/tab-group-context-menu', ...args);
}

const TAB_GROUP_MENU_LABELS = Object.fromEntries(`
  tabGroupMenu_tab-group-editor-title-create
  tabGroupMenu_tab-group-editor-title-edit
  tabGroupMenu_tab-group-editor-name-label
  tabGroupMenu_tab-group-editor-name-field_placeholder
  tabGroupMenu_tab-group-editor-cancel_label
  tabGroupMenu_tab-group-editor-cancel_accesskey
  tabGroupMenu_tab-group-editor-color-selector_aria-label
  tabGroupMenu_tab-group-editor-color-selector2-blue
  tabGroupMenu_tab-group-editor-color-selector2-blue_title
  tabGroupMenu_tab-group-editor-color-selector2-purple
  tabGroupMenu_tab-group-editor-color-selector2-purple_title
  tabGroupMenu_tab-group-editor-color-selector2-cyan
  tabGroupMenu_tab-group-editor-color-selector2-cyan_title
  tabGroupMenu_tab-group-editor-color-selector2-orange
  tabGroupMenu_tab-group-editor-color-selector2-orange_title
  tabGroupMenu_tab-group-editor-color-selector2-yellow
  tabGroupMenu_tab-group-editor-color-selector2-yellow_title
  tabGroupMenu_tab-group-editor-color-selector2-pink
  tabGroupMenu_tab-group-editor-color-selector2-pink_title
  tabGroupMenu_tab-group-editor-color-selector2-green
  tabGroupMenu_tab-group-editor-color-selector2-green_title
  tabGroupMenu_tab-group-editor-color-selector2-gray
  tabGroupMenu_tab-group-editor-color-selector2-gray_title
  tabGroupMenu_tab-group-editor-color-selector2-red
  tabGroupMenu_tab-group-editor-color-selector2-red_title
  tabGroupMenu_tab-group-editor-action-new-tab_label
  tabGroupMenu_tab-group-editor-action-new-window_label
  tabGroupMenu_tab-group-editor-action-save_label
  tabGroupMenu_tab-group-editor-action-ungroup_label
  tabGroupMenu_tab-group-editor-action-delete_label
  tabGroupMenu_tab-group-editor-done_label
  tabGroupMenu_tab-group-editor-done_accesskey
`.trim().split(/\s+/).map(key => [key.replace(/-/g, '_'), browser.i18n.getMessage(key)]));
const TAB_GROUP_MENU_LABELS_CODE = JSON.stringify(TAB_GROUP_MENU_LABELS);

const mTabGroupMenuPanel = new TabGroupMenuPanel(document.querySelector('#tabGroupContextMenuRoot'), TAB_GROUP_MENU_LABELS);
const mController = new InContentPanelController({
  type:    TabGroupMenuPanel.TYPE,
  logger:  log,
  shouldLog() {
    return configs.logFor['sidebar/tab-group-context-menu'] && configs.debug;
  },
  canRenderInSidebar() {
    return !!(configs.tabGroupMenuPanelRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR);
  },
  canRenderInContent() {
    return !!(configs.tabGroupMenuPanelRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_CONTENT);
  },
  shouldFallbackToSidebar() {
    return !!(configs.tabGroupMenuPanelRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR);
  },
  UIClass: TabGroupMenuPanel,
  inSidebarUI: mTabGroupMenuPanel,
  initializerCode: `
    const root = document.createElement('div');
    appendClosedContents(root);
    const tabGroupMenuPanel = new TabGroupMenuPanel(root, ${TAB_GROUP_MENU_LABELS_CODE});

    let destroy;

    const onMouseDown = event => {
      if (event.target?.closest(window.closedContainerType)) {
        return;
      }
      if (logging)
        console.log('mouse down on out of tab group menu panel, destroy tab group menu container');
      browser.runtime.sendMessage({
        type: 'ws:${TabGroupMenuPanel.TYPE}:hide',
        timestamp: Date.now(),
      });
      destroyClosedContents(destroy);
    };
    document.documentElement.addEventListener('mousedown', onMouseDown, { captuer: true });

    destroy = createClosedContentsDestructor(tabGroupMenuPanel, () => {
      document.documentElement.removeEventListener('mousedown', onMouseDown, { captuer: true });
    });

    return tabGroupMenuPanel;
  `,
});

export async function show(group, creating = false) {
  if (!group?.id) {
    return;
  }

  if (!mTabGroupMenuPanel.windowId) {
    const windowId = TabsStore.getCurrentWindowId();
    mTabGroupMenuPanel.windowId = windowId;
  }

  mController.show({
    anchorItem: group,
    targetItem: group,
    messageParams: {
      groupTitle: group.title,
      groupColor: group.color,
      creating: !!creating,
    },
  });
}

document.querySelector('#tabbar').addEventListener('mousedown', event => {
  if (event.target?.closest('#tabGroupContextMenuRoot')) {
    return;
  }

  const timestamp = Date.now();
  mController.sendInSidebarMessage({
    type: `ws:${TabGroupMenuPanel.TYPE}:hide`,
    timestamp,
  });

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  if (activeTab) {
    mController.sendMessage(activeTab.id, {
      type: `ws:${TabGroupMenuPanel.TYPE}:hide-if-shown`,
      timestamp,
    });
  }
}, { capture: true });
