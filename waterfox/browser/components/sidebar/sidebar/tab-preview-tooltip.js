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
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';
import { Tab, TreeItem } from '/common/TreeItem.js';

import InContentPanelController from '/resources/module/InContentPanelController.js';
import TabPreviewPanel from '/resources/module/TabPreviewPanel.js'; // the IMPL

import * as EventUtils from './event-utils.js';
import * as Sidebar from './sidebar.js';

import { kEVENT_TREE_ITEM_SUBSTANCE_ENTER, kEVENT_TREE_ITEM_SUBSTANCE_LEAVE } from './components/TreeItemElement.js';

const CAPTURABLE_URLS_MATCHER         = /^(https?|data):/;
const PREVIEW_WITH_HOST_URLS_MATCHER  = /^(https?|moz-extension):/;
const PREVIEW_WITH_TITLE_URLS_MATCHER = /^file:/;

document.addEventListener(kEVENT_TREE_ITEM_SUBSTANCE_ENTER, onTabSubstanceEnter);
document.addEventListener(kEVENT_TREE_ITEM_SUBSTANCE_LEAVE, onTabSubstanceLeave);

function log(...args) {
  internalLogger('sidebar/tab-preview-tooltip', ...args);
}

const hoveringTabIds = new Set();

const mTabPreviewPanel = new TabPreviewPanel(document.querySelector('#tabPreviewRoot'));
const mController = new InContentPanelController({
  type:    TabPreviewPanel.TYPE,
  logger:  log,
  shouldLog() {
    return configs.logFor['sidebar/tab-preview-tooltip'] && configs.debug;
  },
  canRenderInSidebar() {
    return !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR);
  },
  canRenderInContent() {
    return !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_CONTENT);
  },
  shouldFallbackToSidebar() {
    return !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR);
  },
  canSendPossibleExpiredMessage(message) {
    return (
      message.type != `ws:${TabPreviewPanel.TYPE}:show` ||
      hoveringTabIds.has(message.targetId)
    );
  },
  UIClass: TabPreviewPanel,
  inSidebarUI: mTabPreviewPanel,
  initializerCode: `
    const root = document.createElement('div');
    appendClosedContents(root);
    const tabPreviewPanel = new TabPreviewPanel(root);

    let destroy;

    const onMouseMove = () => {
      if (logging)
        console.log('mouse move on the content area, destroy tab preview container');
      browser.runtime.sendMessage({
        type: 'ws:${TabPreviewPanel.TYPE}:hide',
        timestamp: Date.now(),
      });
      destroyClosedContents(destroy);
    };
    document.documentElement.addEventListener('mousemove', onMouseMove, { once: true });

    destroy = createClosedContentsDestructor(tabPreviewPanel, () => {
      window.removeEventListener('mousemove', onMouseMove);
    });

    return tabPreviewPanel;
  `,
});

async function onTabSubstanceEnter(event) {
  const timestamp = Date.now();

  const canCaptureTab = Permissions.isGrantedSync(Permissions.ALL_URLS);
  if (!canCaptureTab)
    return;

  const windowId = TabsStore.getCurrentWindowId();
  const activeTab = Tab.getActiveTab(windowId) || (await browser.tabs.query({ active: true, windowId }))[0];

  if (!configs.tabPreviewTooltip ||
      !(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_ANYWHERE)) {;
    mController.hideIn(activeTab.id);
    return;
  }

  if (!event.target.tab ||
      event.target.tab.type != TreeItem.TYPE_TAB ||
      document.documentElement.classList.contains(Constants.kTABBAR_STATE_TAB_DRAGGING)) {
    return;
  }

  const active = event.target.tab?.id == activeTab.id;
  const url = PREVIEW_WITH_HOST_URLS_MATCHER.test(event.target.tab?.url) ? new URL(event.target.tab?.url).host :
    PREVIEW_WITH_TITLE_URLS_MATCHER.test(event.target.tab?.url) ? null :
      event.target.tab?.url;
  const hasCustomTooltip = !!event.target.hasCustomTooltip;
  const hasPreview = (
    !active &&
    !event.target.tab?.discarded &&
    CAPTURABLE_URLS_MATCHER.test(event.target.tab?.url) &&
    !hasCustomTooltip
  );
  const previewURL = (
    hasPreview &&
    canCaptureTab &&
    configs.tabPreviewTooltip &&
    (async () => { // We just define a getter function for now, because further operations may contain async operations and we can call this at there for more optimization.
      try {
        return await browser.tabs.captureTab(event.target.tab?.id);
      }
      catch (_error) {
      }
      return null;
    })
  ) || null;

  if (!event.target.tab)
    return;

  log(`onTabSubstanceEnter(${event.target.tab.id}}) start `, timestamp);

  hoveringTabIds.add(event.target.tab.id);

  const succeeded = await mController.show({
    anchorItem: event.target.tab,
    targetItem: event.target.tab,
    messageParams: {
      hasCustomTooltip,
      ...(hasCustomTooltip ?
        {
          tooltipHtml: event.target.appliedTooltipHtml,
        } :
        {
          title: event.target.tab.title,
          url,
        }
      ),
      hasPreview,
      previewURL: null,
      // This is required to simulate the behavior:
      // show tab preview panel with delay only when the panel is not shown yet.
      waitInitialShowUntil: timestamp + Math.max(configs.tabPreviewTooltipDelayMsec, 0),
    },
    promisedMessageParams: new Promise(async (resolve, _reject) => {
      const promisedPreviewURL = typeof previewURL == 'function' && previewURL();
      if (!promisedPreviewURL) {
        return resolve(null);
      }
      resolve({
        previewURL: await promisedPreviewURL,
      });
    }),
    canRenderInSidebar() {
      return !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR) &&
        !(hasCustomTooltip && configs.showCollapsedDescendantsByLegacyTooltipOnSidebar);
    },
    shouldFallbackToSidebar() {
      return !!(configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR) &&
        !(hasCustomTooltip && configs.showCollapsedDescendantsByLegacyTooltipOnSidebar);
    },
  });

  if (!event.target.tab) // the tab may be destroyied while we capturing tab preview
    return;

  if (event.target.tab.$TST.element &&
      succeeded)
    event.target.tab.$TST.element.invalidateTooltip();
}
onTabSubstanceEnter = EventUtils.wrapWithErrorHandler(onTabSubstanceEnter);

async function onTabSubstanceLeave(event) {
  const timestamp = Date.now();
  if (!event.target.tab)
    return;

  hoveringTabIds.delete(event.target.tab.id);

  if (!event.target.tab) // the tab was closed while waiting
    return;

  mController.hide({ targetItem: event.target.tab, timestamp });
}
onTabSubstanceLeave = EventUtils.wrapWithErrorHandler(onTabSubstanceLeave);

Sidebar.onReady.addListener(() => {
  const windowId = TabsStore.getCurrentWindowId();
  mTabPreviewPanel.windowId = windowId;
});

function hideOnUserAction(timestamp) {
  hoveringTabIds.clear();

  mController.hideInSidebar({ timestamp });

  const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
  if (activeTab) {
    mController.hide({ timestamp });
  }
}

document.querySelector('#tabbar').addEventListener('mouseleave', async () => {
  const timestamp = Date.now();
  log('mouse is left from the tab bar ', timestamp);
  hideOnUserAction(timestamp);
});

document.querySelector('#tabbar').addEventListener('dragover', async () => {
  const timestamp = Date.now();
  log('mouse is dragover on the tab bar ', timestamp);
  hideOnUserAction(timestamp);
});
