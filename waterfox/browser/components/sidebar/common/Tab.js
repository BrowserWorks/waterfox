/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import EventListenerManager from '/extlib/EventListenerManager.js';
import TabFavIconHelper from '/extlib/TabFavIconHelper.js';

import {
  log as internalLogger,
  dumpTab,
  mapAndFilter,
  mapAndFilterUniq,
  toLines,
  sanitizeForRegExpSource,
  isNewTabCommandTab,
  isFirefoxViewTab,
  configs,
  doProgressively,
} from './common.js';

import * as ApiTabs from '/common/api-tabs.js';
import * as Constants from './constants.js';
import * as ContextualIdentities from './contextual-identities.js';
import * as SidebarConnection from './sidebar-connection.js';
import * as TabsStore from './tabs-store.js';
import * as UniqueId from './unique-id.js';

import Window from './Window.js';

function log(...args) {
  internalLogger('common/Tab', ...args);
}

function successorTabLog(...args) {
  internalLogger('background/successor-tab', ...args);
}


// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/permissions
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/Tab
export const kPERMISSION_ACTIVE_TAB = 'activeTab';
export const kPERMISSION_TABS       = 'tabs';
export const kPERMISSION_COOKIES    = 'cookies';
export const kPERMISSION_INCOGNITO  = 'incognito'; // only for internal use
export const kPERMISSIONS_ALL = new Set([
  kPERMISSION_TABS,
  kPERMISSION_COOKIES,
  kPERMISSION_INCOGNITO
]);


const mOpenedResolvers            = new Map();

const mIncompletelyTrackedTabs = new Map();
const mMovingTabs              = new Map();
const mPromisedTrackedTabs     = new Map();


browser.windows.onRemoved.addListener(windowId => {
  mIncompletelyTrackedTabs.delete(windowId);
  mMovingTabs.delete(windowId);
});

export default class Tab {
  constructor(tab) {
    const alreadyTracked = Tab.get(tab.id);
    if (alreadyTracked)
      return alreadyTracked.$TST;

    log(`tab ${dumpTab(tab)} is newly tracked: `, tab);

    tab.$TST = this;
    this.tab = tab;
    this.id  = tab.id;
    this.trackedAt = Date.now();
    this.opened = new Promise((resolve, reject) => {
      const resolvers = mOpenedResolvers.get(tab.id) || new Set();
      resolvers.add({ resolve, reject });
      mOpenedResolvers.set(tab.id, resolvers);
    });

    // We should not change the shape of the object, so temporary data should be held in this map.
    this.temporaryMetadata = new Map();

    this.updatingOpenerTabIds = []; // this must be an array, because same opener tab id can appear multiple times.

    this.newRelatedTabsCount = 0;

    this.lastSoundStateCounts = {
      soundPlaying: 0,
      muted:        0,
      autoPlayBlocked: 0,
    };
    this.soundPlayingChildrenIds = new Set();
    this.maybeSoundPlayingChildrenIds = new Set();
    this.mutedChildrenIds = new Set();
    this.maybeMutedChildrenIds = new Set();
    this.autoplayBlockedChildrenIds = new Set();
    this.maybeAutoplayBlockedChildrenIds = new Set();

    this.lastSharingStateCounts = {
      camera:     0,
      microphone: 0,
      screen:     0,
    };
    this.sharingCameraChildrenIds = new Set();
    this.maybeSharingCameraChildrenIds = new Set();
    this.sharingMicrophoneChildrenIds = new Set();
    this.maybeSharingMicrophoneChildrenIds = new Set();
    this.sharingScreenChildrenIds = new Set();
    this.maybeSharingScreenChildrenIds = new Set();

    this.highPriorityTooltipTexts = new Map();
    this.lowPriorityTooltipTexts  = new Map();

    this.$exportedForAPI = null;
    this.$exportedForAPIWithPermissions = new Map();

    this.element = null;
    this.classList = null;
    this.promisedElement = new Promise((resolve, _reject) => {
      this._promisedElementResolver = resolve;
    });

    this.states = new Set();
    this.clear();

    this.uniqueId = {
      id:            null,
      originalId:    null,
      originalTabId: null
    };
    this.promisedUniqueId = new Promise((resolve, _reject) => {
      this.onUniqueIdGenerated = resolve;
    });

    TabsStore.tabs.set(tab.id, tab);

    const win = TabsStore.windows.get(tab.windowId) || new Window(tab.windowId);
    win.trackTab(tab);

    // Don't update indexes here, instead Window.prototype.trackTab()
    // updates indexes because indexes are bound to windows.
    // TabsStore.updateIndexesForTab(tab);

    if (tab.active) {
      TabsStore.activeTabInWindow.set(tab.windowId, tab);
      TabsStore.activeTabsInWindow.get(tab.windowId).add(tab);
    }
    else {
      TabsStore.activeTabsInWindow.get(tab.windowId).delete(tab);
    }

    const incompletelyTrackedTabsPerWindow = mIncompletelyTrackedTabs.get(tab.windowId) || new Set();
    incompletelyTrackedTabsPerWindow.add(tab);
    mIncompletelyTrackedTabs.set(tab.windowId, incompletelyTrackedTabsPerWindow);
    this.promisedUniqueId.then(() => {
      incompletelyTrackedTabsPerWindow.delete(tab);
      Tab.onTracked.dispatch(tab);
    });

    // We should initialize private properties with blank value for better performance with a fixed shape.
    this.delayedInheritSoundStateFromChildren = null;
  }

  destroy() {
    mPromisedTrackedTabs.delete(`${this.id}:true`);
    mPromisedTrackedTabs.delete(`${this.id}:false`);

    Tab.onDestroyed.dispatch(this.tab);
    this.detach();

    if (this.temporaryMetadata.has('reservedCleanupNeedlessGroupTab')) {
      clearTimeout(this.temporaryMetadata.get('reservedCleanupNeedlessGroupTab'));
      this.temporaryMetadata.delete('reservedCleanupNeedlessGroupTab');
    }

    TabsStore.tabs.delete(this.id);
    if (this.uniqueId)
      TabsStore.tabsByUniqueId.delete(this.uniqueId.id);

    TabsStore.removeTabFromIndexes(this.tab);

    if (this.element &&
        this.element.parentNode)
      this.element.parentNode.removeChild(this.element);
    this.unbindElement();
    // this.tab.$TST = null; // tab.$TST is used by destruction processes.
    this.tab = null;
    this.promisedUniqueId = null;
    this.uniqueId = null;
    this.destroyed = true;
  }

  clear() {
    this.states.clear();
    this.attributes = {};

    this.parentId = null;
    this.childIds = [];
    this.cachedAncestorIds   = null;
    this.cachedDescendantIds = null;
  }

  bindElement(element) {
    element.$TST   = this;
    element.apiTab = this.tab;
    this.element = element;
    this.classList = element.classList;
    // wait until initialization processes are completed
    (Constants.IS_BACKGROUND ?
      setTimeout : // because window.requestAnimationFrame is decelerate for an invisible document.
      window.requestAnimationFrame)(() => {
      this._promisedElementResolver(element);
      if (!element) { // reset for the next binding
        this.promisedElement = new Promise((resolve, _reject) => {
          this._promisedElementResolver = resolve;
        });
      }
      if (!this.tab) // unbound while waiting!
        return;
      Tab.onElementBound.dispatch(this.tab);
    }, 0);
  }

  unbindElement() {
    if (this.element) {
      for (const state of this.states) {
        this.element.classList.remove(state);
        if (state == Constants.kTAB_STATE_HIGHLIGHTED)
          this.element.removeAttribute('aria-selected');
      }
      for (const name of Object.keys(this.attributes)) {
        this.element.removeAttribute(name);
      }
      this.element.$TST = null;
      this.element.apiTab = null;
    }
    this.element = null;
    this.classList = null;
  }

  startMoving() {
    if (!this.tab)
      return Promise.resolve();
    let onTabMoved;
    const promisedMoved = new Promise((resolve, _reject) => {
      onTabMoved = resolve;
    });
    const movingTabs = mMovingTabs.get(this.tab.windowId) || new Set();
    movingTabs.add(promisedMoved);
    mMovingTabs.set(this.tab.windowId, movingTabs);
    promisedMoved.then(() => {
      movingTabs.delete(promisedMoved);
    });
    return onTabMoved;
  }

  updateUniqueId(options = {}) {
    if (!this.tab) {
      const error = new Error('FATAL ERROR: updateUniqueId() is unavailable for an invalid tab');
      console.log(error);
      throw error;
    }
    if (options.id) {
      if (this.uniqueId.id)
        TabsStore.tabsByUniqueId.delete(this.uniqueId.id);
      this.uniqueId.id = options.id;
      TabsStore.tabsByUniqueId.set(options.id, this.tab);
      this.setAttribute(Constants.kPERSISTENT_ID, options.id);
      return Promise.resolve(this.uniqueId);
    }
    return UniqueId.request(this.tab, options).then(uniqueId => {
      if (uniqueId && TabsStore.ensureLivingTab(this.tab)) { // possibly removed from document while waiting
        this.uniqueId = uniqueId;
        TabsStore.tabsByUniqueId.set(uniqueId.id, this.tab);
        this.setAttribute(Constants.kPERSISTENT_ID, uniqueId.id);
      }
      return uniqueId || {};
    }).catch(error => {
      console.log(`FATAL ERROR: Failed to get unique id for a tab ${this.id}: `, error);
      return {};
    });
  }


  //===================================================================
  // status of tab
  //===================================================================

  get soundPlaying() {
    return !!(this.tab?.audible && !this.tab.mutedInfo.muted);
  }
  get maybeSoundPlaying() {
    return (this.soundPlaying ||
            (this.states.has(Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER) &&
             this.hasChild));
  }

  get muted() {
    return !!(this.tab?.mutedInfo?.muted);
  }
  get maybeMuted() {
    return (this.muted ||
            (this.states.has(Constants.kTAB_STATE_HAS_MUTED_MEMBER) &&
             this.hasChild));
  }

  get autoplayBlocked() {
    return this.states.has(Constants.kTAB_STATE_AUTOPLAY_BLOCKED);
  }
  get maybeAutoplayBlocked() {
    return (this.autoplayBlocked ||
            (this.states.has(Constants.kTAB_STATE_HAS_AUTOPLAY_BLOCKED_MEMBER) &&
             this.hasChild));
  }

  get sharingCamera() {
    return !!(this.tab && this.tab.sharingState && this.tab.sharingState.camera);
  }
  get maybeSharingCamera() {
    return (this.sharingCamera ||
            (this.states.has(Constants.kTAB_STATE_HAS_SHARING_CAMERA_MEMBER) &&
             this.hasChild));
  }

  get sharingMicrophone() {
    return !!(this.tab && this.tab.sharingState && this.tab.sharingState.microphone);
  }
  get maybeSharingMicrophone() {
    return (this.sharingMicrophone ||
            (this.states.has(Constants.kTAB_STATE_HAS_SHARING_MICROPHONE_MEMBER) &&
             this.hasChild));
  }

  get sharingScreen() {
    return !!(this.tab && this.tab.sharingState && this.tab.sharingState.screen);
  }
  get maybeSharingScreen() {
    return (this.sharingScreen ||
            (this.states.has(Constants.kTAB_STATE_HAS_SHARING_SCREEN_MEMBER) &&
             this.hasChild));
  }

  get collapsed() {
    return this.states.has(Constants.kTAB_STATE_COLLAPSED);
  }

  get collapsedCompletely() {
    return this.states.has(Constants.kTAB_STATE_COLLAPSED_DONE);
  }

  get subtreeCollapsed() {
    return this.states.has(Constants.kTAB_STATE_SUBTREE_COLLAPSED);
  }

  get isSubtreeCollapsable() {
    return this.hasChild &&
           !this.collapsed &&
           !this.subtreeCollapsed;
  }

  get isAutoExpandable() {
    return this.hasChild && this.subtreeCollapsed;
  }

  get precedesPinnedTab() {
    const following = this.nearestVisibleFollowingTab;
    return following && following.pinned;
  }

  get followsUnpinnedTab() {
    const preceding = this.nearestVisiblePrecedingTab;
    return preceding && !preceding.pinned;
  }

  get duplicating() {
    return this.states.has(Constants.kTAB_STATE_DUPLICATING);
  }

  get removing() {
    return this.states.has(Constants.kTAB_STATE_REMOVING);
  }

  get sticky() {
    return this.states.has(Constants.kTAB_STATE_STICKY);
  }

  get stuck() {
    return this.element?.parentNode?.classList.contains('sticky-tabs-container');
  }

  get isNewTabCommandTab() {
    if (!this.tab ||
        !configs.guessNewOrphanTabAsOpenedByNewTabCommand)
      return false;

    if (this.tab.$isNewTabCommandTab)
      return true;

    // Firefox sets "New Tab" title to a new tab command tab, even if
    // "Blank Page" is chosen as the new tab page. So we can detect the case
    // safely here.
    // (confirmed on Firefox 124)
    if (isNewTabCommandTab(this.tab))
      return true;

    // Firefox always opens a blank tab as the placeholder, when trying to
    // open a bookmark in a new tab. So, we cannot determine the tab is
    // "really opened as a new blank tab" or "just as a placeholder for an
    // Open in New Tab operation", when the user choose the "Blank Page"
    // as the new tab page and the new tab page is opened without the title
    // "New Tab" due to any reason.
    // But, when "Blank Page" is chosen as the new tab page, Firefox loads
    // "about:blank" into a newly opened blank tab. As the result both current
    // URL and the previous URL become "about:blank". This is an important
    // difference between "a new blank tab" and "a blank tab opened for an
    // Open in New Tab command".
    // (confirmed on Firefox 124)
    if (this.tab.url == 'about:blank' &&
        this.tab.previousUrl != 'about:blank')
      return false;

    return false;
  }

  get isGroupTab() {
    return this.states.has(Constants.kTAB_STATE_GROUP_TAB) ||
           this.hasGroupTabURL;
  }

  get hasGroupTabURL() {
    return !!(this.tab && this.tab.url.indexOf(Constants.kGROUP_TAB_URI) == 0);
  }

  get isTemporaryGroupTab() {
    if (!this.tab || !this.isGroupTab)
      return false;
    return (new URL(this.tab.url)).searchParams.get('temporary') == 'true';
  }

  get isTemporaryAggressiveGroupTab() {
    if (!this.tab || !this.isGroupTab)
      return false;
    return (new URL(this.tab.url)).searchParams.get('temporaryAggressive') == 'true';
  }

  get replacedParentGroupTabCount() {
    if (!this.tab || !this.isGroupTab)
      return 0;
    const count = parseInt((new URL(this.tab.url)).searchParams.get('replacedParentCount'));
    return isNaN(count) ? 0 : count;
  }

  // Firefox Multi-Account Containers
  // https://addons.mozilla.org/firefox/addon/multi-account-containers/
  // Temporary Containers
  // https://addons.mozilla.org/firefox/addon/temporary-containers/
  get mayBeReplacedWithContainer() {
    return !!(
      this.$possiblePredecessorPreviousTab ||
      this.$possiblePredecessorNextTab
    );
  }
  get $possiblePredecessorPreviousTab() {
    const prevTab = this.unsafePreviousTab;
    return (
      prevTab &&
      this.tab &&
      this.tab.cookieStoreId != prevTab.cookieStoreId &&
      this.tab.url == prevTab.url
    ) ? prevTab : null;
  }
  get $possiblePredecessorNextTab() {
    const nextTab = this.unsafeNextTab;
    return (
      nextTab &&
      this.tab &&
      this.tab.cookieStoreId != nextTab.cookieStoreId &&
      this.tab.url == nextTab.url
    ) ? nextTab : null;
  }
  get possibleSuccessorWithDifferentContainer() {
    const firstChild = this.firstChild;
    const nextTab = this.nextTab;
    const prevTab = this.previousTab;
    return (
      (firstChild &&
       firstChild.$TST.$possiblePredecessorPreviousTab == this.tab &&
       firstChild) ||
      (nextTab &&
       !nextTab.$TST.temporaryMetadata.has('openedCompletely') &&
       nextTab.$TST.$possiblePredecessorPreviousTab == this.tab &&
       nextTab) ||
      (prevTab &&
       !prevTab.$TST.temporaryMetadata.has('openedCompletely') &&
       prevTab.$TST.$possiblePredecessorNextTab == this.tab &&
       prevTab)
    );
  }

  get selected() {
    return this.states.has(Constants.kTAB_STATE_SELECTED) ||
             (this.hasOtherHighlighted && !!(this.tab && this.tab.highlighted));
  }

  get multiselected() {
    return this.tab &&
             this.selected &&
             (this.hasOtherHighlighted ||
              TabsStore.selectedTabsInWindow.get(this.tab.windowId).size > 1);
  }

  get hasOtherHighlighted() {
    const highlightedTabs = this.tab && TabsStore.highlightedTabsInWindow.get(this.tab.windowId);
    return !!(highlightedTabs && highlightedTabs.size > 1);
  }

  get canBecomeSticky() {
    if (this.tab?.pinned ||
        this.collapsed ||
        this.states.has(Constants.kTAB_STATE_EXPANDING) ||
        this.states.has(Constants.kTAB_STATE_COLLAPSING))
      return false;

    if (this.sticky)
      return true;

    for (const states of Tab.autoStickyStates.values()) {
      if ((new Set([...this.states, ...states])).size < this.states.size + states.size)
        return true;
    }

    return false;
  }

  get promisedPossibleOpenerBookmarks() {
    if ('possibleOpenerBookmarks' in this)
      return Promise.resolve(this.possibleOpenerBookmarks);
    return new Promise(async (resolve, _reject) => {
      if (!browser.bookmarks || !this.tab)
        return resolve(this.possibleOpenerBookmarks = []);
      // A new tab from bookmark is opened with a title: its URL without the scheme part.
      const url = this.tab.$possibleInitialUrl;
      try {
        const possibleBookmarks = await Promise.all([
          this._safeSearchBookmstksWithUrl(`http://${url}`),
          this._safeSearchBookmstksWithUrl(`http://www.${url}`),
          this._safeSearchBookmstksWithUrl(`https://${url}`),
          this._safeSearchBookmstksWithUrl(`https://www.${url}`),
          this._safeSearchBookmstksWithUrl(`ftp://${url}`),
          this._safeSearchBookmstksWithUrl(`moz-extension://${url}`),
          this._safeSearchBookmstksWithUrl(url), // about:* and so on
        ]);
        log(`promisedPossibleOpenerBookmarks for tab ${this.id} (${url}): `, possibleBookmarks);
        resolve(this.possibleOpenerBookmarks = possibleBookmarks.flat());
      }
      catch(error) {
        log(`promisedPossibleOpenerBookmarks for the tab {this.id} (${url}): `, error);
        // If it is detected as "not a valid URL", then
        // it cannot be a tab opened from a bookmark.
        resolve(this.possibleOpenerBookmarks = []);
      }
    });
  }
  async _safeSearchBookmstksWithUrl(url) {
    try {
      return await browser.bookmarks.search({ url });
    }
    catch(error) {
      log(`_searchBookmstksWithUrl failed: tab ${this.id} (${url}): `, error);
      try {
        // bookmarks.search() does not accept "moz-extension:" URL
        // via a queyr with "url" on Firefox 105 and later - it raises an error as
        // "Uncaught Error: Type error for parameter query (Value must either:
        // be a string value, or .url must match the format "url") for bookmarks.search."
        // Thus we use a query with "query" to avoid the error.
        // See also: https://github.com/piroor/treestyletab/issues/3203
        //           https://bugzilla.mozilla.org/show_bug.cgi?id=1791313
        const bookmarks = await browser.bookmarks.search({ query: url }).catch(_error => []);
        return bookmarks.filter(bookmark => bookmark.url == url);
      }
      catch(_error) {
        return [];
      }
    }
  }

  get cookieStoreName() {
    const identity = this.tab && this.tab.cookieStoreId && ContextualIdentities.get(this.tab.cookieStoreId);
    return identity ? identity.name : null;
  }

  generateTooltipText() {
    return this.cookieStoreName ? `${this.tab.title} - ${this.cookieStoreName}` : this.tab.title;
  }

  generateTooltipTextWithDescendants() {
    const tooltip = [`* ${this.generateTooltipText()}`];
    for (const child of this.children) {
      if (!child)
        continue;
      tooltip.push(child.$TST.generateTooltipTextWithDescendants().replace(/^/gm, '  '));
    }
    return tooltip.join('\n');
  }

  registerTooltipText(ownerId, text, isHighPriority = false) {
    if (isHighPriority) {
      this.highPriorityTooltipTexts.set(ownerId, text);
      this.lowPriorityTooltipTexts.delete(ownerId);
    }
    else {
      this.highPriorityTooltipTexts.delete(ownerId);
      this.lowPriorityTooltipTexts.set(ownerId, text);
    }
    if (Constants.IS_BACKGROUND)
      Tab.broadcastTooltipText(this.tab);
  }

  unregisterTooltipText(ownerId) {
    this.highPriorityTooltipTexts.delete(ownerId);
    this.lowPriorityTooltipTexts.delete(ownerId);
    if (Constants.IS_BACKGROUND)
      Tab.broadcastTooltipText(this.tab);
  }

  getHighPriorityTooltipText() {
    if (this.highPriorityTooltipTexts.size == 0)
      return null;
    return [...this.highPriorityTooltipTexts.values()][this.highPriorityTooltipTexts.size - 1];
  }

  getLowPriorityTooltipText() {
    if (this.lowPriorityTooltipTexts.size == 0)
      return null;
    return [...this.lowPriorityTooltipTexts.values()][this.lowPriorityTooltipTexts.size - 1];
  }

  //===================================================================
  // neighbor tabs
  //===================================================================

  get nextTab() {
    return this.tab && TabsStore.query({
      windowId: this.tab.windowId,
      tabs:     TabsStore.controllableTabsInWindow.get(this.tab.windowId),
      fromId:   this.id,
      controllable: true,
      index:    (index => index > this.tab.index)
    });
  }

  get previousTab() {
    return this.tab && TabsStore.query({
      windowId: this.tab.windowId,
      tabs:     TabsStore.controllableTabsInWindow.get(this.tab.windowId),
      fromId:   this.id,
      controllable: true,
      index:    (index => index < this.tab.index),
      last:     true
    });
  }

  get unsafeNextTab() {
    return this.tab && TabsStore.query({
      windowId: this.tab.windowId,
      fromId:   this.id,
      index:    (index => index > this.tab.index)
    });
  }

  get unsafePreviousTab() {
    return this.tab && TabsStore.query({
      windowId: this.tab.windowId,
      fromId:   this.id,
      index:    (index => index < this.tab.index),
      last:     true
    });
  }

  get nearestCompletelyOpenedNormalFollowingTab() { // including hidden tabs!
    return this.tab && TabsStore.query({
      windowId: this.tab.windowId,
      tabs:     TabsStore.unpinnedTabsInWindow.get(this.tab.windowId),
      states:   [Constants.kTAB_STATE_CREATING, false],
      fromId:   this.id,
      living:   true,
      index:    (index => index > this.tab.index)
    });
  }

  get nearestCompletelyOpenedNormalPrecedingTab() { // including hidden tabs!
    return this.tab && TabsStore.query({
      windowId: this.tab.windowId,
      tabs:     TabsStore.unpinnedTabsInWindow.get(this.tab.windowId),
      states:   [Constants.kTAB_STATE_CREATING, false],
      fromId:   this.id,
      living:   true,
      index:    (index => index < this.tab.index),
      last:     true
    });
  }

  get nearestVisibleFollowingTab() { // visible, not-collapsed
    return this.tab && TabsStore.query({
      windowId: this.tab.windowId,
      tabs:     TabsStore.visibleTabsInWindow.get(this.tab.windowId),
      fromId:   this.id,
      visible:  true,
      index:    (index => index > this.tab.index)
    });
  }

  get unsafeNearestExpandedFollowingTab() { // not-collapsed, possibly hidden
    return this.tab && TabsStore.query({
      windowId: this.tab.windowId,
      tabs:     TabsStore.expandedTabsInWindow.get(this.tab.windowId),
      fromId:   this.id,
      index:    (index => index > this.tab.index)
    });
  }

  get nearestVisiblePrecedingTab() { // visible, not-collapsed
    return this.tab && TabsStore.query({
      windowId: this.tab.windowId,
      tabs:     TabsStore.visibleTabsInWindow.get(this.tab.windowId),
      fromId:   this.id,
      visible:  true,
      index:    (index => index < this.tab.index),
      last:     true
    });
  }

  get unsafeNearestExpandedPrecedingTab() { // not-collapsed, possibly hidden
    return this.tab && TabsStore.query({
      windowId: this.tab.windowId,
      tabs:     TabsStore.expandedTabsInWindow.get(this.tab.windowId),
      fromId:   this.id,
      index:    (index => index < this.tab.index),
      last:     true
    });
  }

  get nearestLoadedTab() {
    const tabs = this.tab && TabsStore.visibleTabsInWindow.get(this.tab.windowId);
    return this.tab && (
      // nearest following tab
      TabsStore.query({
        windowId:  this.tab.windowId,
        tabs,
        discarded: false,
        fromId:    this.id,
        visible:   true,
        index:     (index => index > this.tab.index)
      }) ||
      // nearest preceding tab
      TabsStore.query({
        windowId:  this.tab.windowId,
        tabs,
        discarded: false,
        fromId:    this.id,
        visible:   true,
        index:     (index => index < this.tab.index),
        last:      true
      })
    );
  }

  get nearestLoadedTabInTree() {
    if (!this.tab)
      return null;
    let tab = this.tab;
    const tabs = TabsStore.visibleTabsInWindow.get(tab.windowId);
    let lastLastDescendant;
    while (tab) {
      const parent = tab.$TST.parent;
      if (!parent)
        return null;
      const lastDescendant = parent.$TST.lastDescendant;
      const loadedTab = (
        // nearest following tab
        TabsStore.query({
          windowId:     tab.windowId,
          tabs,
          descendantOf: parent.id,
          discarded:    false,
          '!id':        this.id,
          fromId:       (lastLastDescendant || this.tab).id,
          toId:         lastDescendant.id,
          visible:      true,
          index:        (index => index > this.tab.index)
        }) ||
        // nearest preceding tab
        TabsStore.query({
          windowId:     tab.windowId,
          tabs,
          descendantOf: parent.id,
          discarded:    false,
          '!id':        this.id,
          fromId:       tab.id,
          toId:         parent.$TST.firstChild.id,
          visible:      true,
          index:        (index => index < tab.index),
          last:         true
        })
      );
      if (loadedTab)
        return loadedTab;
      if (!parent.discarded)
        return parent;
      lastLastDescendant = lastDescendant;
      tab = tab.$TST.parent;
    }
    return null;
  }

  get nearestLoadedSiblingTab() {
    const parent = this.parent;
    if (!parent || !this.tab)
      return null;
    const tabs = TabsStore.visibleTabsInWindow.get(this.tab.windowId);
    return (
      // nearest following tab
      TabsStore.query({
        windowId:  this.tab.windowId,
        tabs,
        childOf:   parent.id,
        discarded: false,
        fromId:    this.id,
        toId:      parent.$TST.lastChild.id,
        visible:   true,
        index:     (index => index > this.tab.index)
      }) ||
      // nearest preceding tab
      TabsStore.query({
        windowId:  this.tab.windowId,
        tabs,
        childOf:   parent.id,
        discarded: false,
        fromId:    this.id,
        toId:      parent.$TST.firstChild.id,
        visible:   true,
        index:     (index => index < this.tab.index),
        last:      true
      })
    );
  }

  get nearestSameTypeRenderedTab() {
    let tab = this.tab;
    const pinned = tab.pinned;
    while (tab.$TST.unsafeNextTab) {
      tab = tab.$TST.unsafeNextTab;
      if (tab.pinned != pinned)
        return null;
      if (tab.$TST.element &&
          tab.$TST.element.parentNode)
        return tab;
    }
    return null;
  }

  //===================================================================
  // tree relations
  //===================================================================

  set parent(tab) {
    const newParentId = tab && (typeof tab == 'number' ? tab : tab.id);
    if (!this.tab ||
        newParentId == this.parentId)
      return tab;

    const oldParent = this.parent;
    this.parentId = newParentId;
    this.invalidateCachedAncestors();
    const parent = this.parent;
    if (parent) {
      this.setAttribute(Constants.kPARENT, parent.id);
      parent.$TST.invalidateCachedDescendants();

      if (this.states.has(Constants.kTAB_STATE_SOUND_PLAYING))
        parent.$TST.soundPlayingChildrenIds.add(this.id);
      if (this.states.has(Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER))
        parent.$TST.maybeSoundPlayingChildrenIds.add(this.id);
      if (this.states.has(Constants.kTAB_STATE_MUTED))
        parent.$TST.mutedChildrenIds.add(this.id);
      if (this.states.has(Constants.kTAB_STATE_HAS_MUTED_MEMBER))
        parent.$TST.maybeMutedChildrenIds.add(this.id);
      if (this.states.has(Constants.kTAB_STATE_AUTOPLAY_BLOCKED))
        parent.$TST.autoplayBlockedChildrenIds.add(this.id);
      if (this.states.has(Constants.kTAB_STATE_HAS_AUTOPLAY_BLOCKED_MEMBER))
        parent.$TST.maybeAutoplayBlockedChildrenIds.add(this.id);
      parent.$TST.inheritSoundStateFromChildren();

      if (this.states.has(Constants.kTAB_STATE_SHARING_CAMERA))
        parent.$TST.sharingCameraChildrenIds.add(this.id);
      if (this.states.has(Constants.kTAB_STATE_HAS_SHARING_CAMERA_MEMBER))
        parent.$TST.maybeSharingCameraChildrenIds.add(this.id);
      if (this.states.has(Constants.kTAB_STATE_SHARING_MICROPHONE))
        parent.$TST.sharingMicrophoneChildrenIds.add(this.id);
      if (this.states.has(Constants.kTAB_STATE_HAS_SHARING_MICROPHONE_MEMBER))
        parent.$TST.maybeSharingMicrophoneChildrenIds.add(this.id);
      if (this.states.has(Constants.kTAB_STATE_SHARING_SCREEN))
        parent.$TST.sharingScreenChildrenIds.add(this.id);
      if (this.states.has(Constants.kTAB_STATE_HAS_SHARING_SCREEN_MEMBER))
        parent.$TST.maybeSharingScreenChildrenIds.add(this.id);
      parent.$TST.inheritSharingStateFromChildren();

      TabsStore.removeRootTab(this.tab);
    }
    else {
      this.removeAttribute(Constants.kPARENT);
      TabsStore.addRootTab(this.tab);
    }
    if (oldParent && oldParent.id != this.parentId) {
      oldParent.$TST.soundPlayingChildrenIds.delete(this.id);
      oldParent.$TST.maybeSoundPlayingChildrenIds.delete(this.id);
      oldParent.$TST.mutedChildrenIds.delete(this.id);
      oldParent.$TST.maybeMutedChildrenIds.delete(this.id);
      oldParent.$TST.autoplayBlockedChildrenIds.delete(this.id);
      oldParent.$TST.maybeAutoplayBlockedChildrenIds.delete(this.id);
      oldParent.$TST.inheritSoundStateFromChildren();

      oldParent.$TST.sharingCameraChildrenIds.delete(this.id);
      oldParent.$TST.maybeSharingCameraChildrenIds.delete(this.id);
      oldParent.$TST.sharingMicrophoneChildrenIds.delete(this.id);
      oldParent.$TST.maybeSharingScreenChildrenIds.delete(this.id);
      oldParent.$TST.maybeSharingMicrophoneChildrenIds.delete(this.id);
      oldParent.$TST.maybeSharingScreenChildrenIds.delete(this.id);
      oldParent.$TST.inheritSharingStateFromChildren();

      oldParent.$TST.children = oldParent.$TST.childIds.filter(id => id != this.id);
    }
    return tab;
  }
  get parent() {
    return this.tab && this.parentId && TabsStore.ensureLivingTab(Tab.get(this.parentId));
  }

  get hasParent() {
    return !!this.parentId;
  }

  get ancestorIds() {
    if (!this.cachedAncestorIds)
      this.updateAncestors();
    return this.cachedAncestorIds;
  }

  get ancestors() {
    return mapAndFilter(this.ancestorIds,
                        id => TabsStore.ensureLivingTab(Tab.get(id)) || undefined);
  }

  updateAncestors() {
    const ancestors = [];
    this.cachedAncestorIds = [];
    if (!this.tab)
      return ancestors;
    let descendant = this.tab;
    while (true) {
      const parent = Tab.get(descendant.$TST.parentId);
      if (!parent)
        break;
      ancestors.push(parent);
      this.cachedAncestorIds.push(parent.id);
      descendant = parent;
    }
    return ancestors;
  }

  get level() {
    return this.ancestorIds.length;
  }

  invalidateCachedAncestors() {
    this.cachedAncestorIds = null;
    for (const child of this.children) {
      child.$TST.invalidateCachedAncestors();
    }
    this.invalidateCache();
  }

  get rootTab() {
    const ancestors = this.ancestors;
    return ancestors.length > 0 ? ancestors[ancestors.length-1] : this.tab ;
  }

  get nearestVisibleAncestorOrSelf() {
    for (const ancestor of this.ancestors) {
      if (!ancestor.$TST.collapsed)
        return ancestor;
    }
    if (!this.collapsed)
      return this;
    return null;
  }

  get nearestFollowingRootTab() {
    return TabsStore.query({
      windowId:  this.tab.windowId,
      tabs:      TabsStore.rootTabsInWindow.get(this.tab.windowId),
      fromId:    this.id,
      living:    true,
      index:     (index => index > this.tab.index),
      hasParent: false,
      first:     true
    });
  }

  get nearestFollowingForeignerTab() {
    const base = this.lastDescendant || this.tab;
    return base && base.$TST.nextTab;
  }

  get unsafeNearestFollowingForeignerTab() {
    const base = this.lastDescendant || this.tab;
    return base && base.$TST.unsafeNextTab;
  }

  set children(tabs) {
    if (!this.tab)
      return tabs;
    const ancestorIds = this.ancestorIds;
    const newChildIds = mapAndFilter(tabs, tab => {
      const id = typeof tab == 'number' ? tab : tab && tab.id;
      if (!ancestorIds.includes(id))
        return TabsStore.ensureLivingTab(Tab.get(id)) ? id : undefined;
      console.log('FATAL ERROR: Cyclic tree structure has detected and prevented. ', {
        ancestorsOfSelf: this.ancestors,
        tabs,
        tab,
        stack: new Error().stack
      });
      return undefined;
    });
    if (newChildIds.join('|') == this.childIds.join('|'))
      return tabs;

    const oldChildren = this.children;
    this.childIds = newChildIds;
    this.sortAndInvalidateChildren();
    if (this.childIds.length > 0) {
      this.setAttribute(Constants.kCHILDREN, `|${this.childIds.join('|')}|`);
      if (this.isSubtreeCollapsable)
        TabsStore.addSubtreeCollapsableTab(this.tab);
    }
    else {
      this.removeAttribute(Constants.kCHILDREN);
      TabsStore.removeSubtreeCollapsableTab(this.tab);
    }
    for (const child of Array.from(new Set(this.children.concat(oldChildren)))) {
      if (this.childIds.includes(child.id))
        child.$TST.parent = this.id;
      else
        child.$TST.parent = null;
    }
    return tabs;
  }
  get children() {
    return mapAndFilter(this.childIds,
                        id => TabsStore.ensureLivingTab(Tab.get(id)) || undefined);
  }

  get firstChild() {
    const children = this.children;
    return children.length > 0 ? children[0] : null ;
  }

  get firstVisibleChild() {
    const firstChild = this.firstChild;
    return firstChild && !firstChild.$TST.collapsed && !firstChild.hidden && firstChild;
  }

  get lastChild() {
    const children = this.children;
    return children.length > 0 ? children[children.length - 1] : null ;
  }

  sortAndInvalidateChildren() {
    // Tab.get(tabId) calls into TabsStore.tabs.get(tabId), which is just a
    // Map. This is acceptable to repeat in order to avoid two array copies,
    // especially on larger tab sets.
    this.childIds.sort((a, b) => Tab.compare(Tab.get(a), Tab.get(b)));
    this.invalidateCachedDescendants();
  }

  get hasChild() {
    return this.childIds.length > 0;
  }

  get descendants() {
    if (!this.cachedDescendantIds)
      return this.updateDescendants();
    return mapAndFilter(this.cachedDescendantIds,
                        id => TabsStore.ensureLivingTab(Tab.get(id)) || undefined);
  }

  updateDescendants() {
    let descendants = [];
    this.cachedDescendantIds = [];
    for (const child of this.children) {
      descendants.push(child);
      descendants = descendants.concat(child.$TST.descendants);
      this.cachedDescendantIds.push(child.id);
      this.cachedDescendantIds = this.cachedDescendantIds.concat(child.$TST.cachedDescendantIds);
    }
    return descendants;
  }

  invalidateCachedDescendants() {
    this.cachedDescendantIds = null;
    const parent = this.parent;
    if (parent)
      parent.$TST.invalidateCachedDescendants();
    this.invalidateCache();
  }

  get lastDescendant() {
    const descendants = this.descendants;
    return descendants.length ? descendants[descendants.length-1] : null ;
  }

  get nextSiblingTab() {
    if (!this.tab)
      return null;
    const parent = this.parent;
    if (parent) {
      const siblingIds = parent.$TST.childIds;
      const index = siblingIds.indexOf(this.id);
      const siblingId = index < siblingIds.length - 1 ? siblingIds[index + 1] : null ;
      if (!siblingId)
        return null;
      return Tab.get(siblingId);
    }
    else {
      const nextSibling = TabsStore.query({
        windowId:  this.tab.windowId,
        tabs:      TabsStore.rootTabsInWindow.get(this.tab.windowId),
        fromId:    this.id,
        living:    true,
        index:     (index => index > this.tab.index),
        hasParent: false,
        first:     true
      });
      // We should treat only pinned tab as the next sibling tab of a pinned
      // tab. For example, if the last pinned tab is closed, Firefox moves
      // focus to the first normal tab. But the previous pinned tab looks
      // natural on TST because pinned tabs are visually grouped.
      if (nextSibling &&
          nextSibling.pinned != this.tab.pinned)
        return null;
      return nextSibling;
    }
  }

  get nextVisibleSiblingTab() {
    const nextSibling = this.nextSiblingTab;
    return nextSibling && !nextSibling.$TST.collapsed && !nextSibling.hidden && nextSibling;
  }

  get previousSiblingTab() {
    if (!this.tab)
      return null;
    const parent = this.parent;
    if (parent) {
      const siblingIds = parent.$TST.childIds;
      const index = siblingIds.indexOf(this.id);
      const siblingId = index > 0 ? siblingIds[index - 1] : null ;
      if (!siblingId)
        return null;
      return Tab.get(siblingId);
    }
    else {
      return TabsStore.query({
        windowId:  this.tab.windowId,
        tabs:      TabsStore.rootTabsInWindow.get(this.tab.windowId),
        fromId:    this.id,
        living:    true,
        index:     (index => index < this.tab.index),
        hasParent: false,
        last:      true
      });
    }
  }

  get needToBeGroupedSiblings() {
    if (!this.tab)
      return [];
    const openerTabUniqueId = this.getAttribute(Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID);
    if (!openerTabUniqueId)
      return [];
    return TabsStore.queryAll({
      windowId:   this.tab.windowId,
      tabs:       TabsStore.toBeGroupedTabsInWindow.get(this.tab.windowId),
      normal:     true,
      '!id':      this.id,
      attributes: [
        Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID, openerTabUniqueId,
        Constants.kPERSISTENT_ALREADY_GROUPED_FOR_PINNED_OPENER, ''
      ],
      ordered:    true
    });
  }

  //===================================================================
  // other relations
  //===================================================================

  get openerTab() {
    if (this.tab?.openerTabId == this.id)
      return null;

    if (!this.tab ||
        !this.tab.openerTabId)
      return Tab.getOpenerFromGroupTab(this.tab);

    return TabsStore.query({
      windowId: this.tab.windowId,
      tabs:     TabsStore.livingTabsInWindow.get(this.tab.windowId),
      id:       this.tab.openerTabId,
      living:   true
    });
  }

  get hasPinnedOpener() {
    return this.openerTab?.pinned;
  }

  get hasFirefoxViewOpener() {
    return isFirefoxViewTab(this.openerTab);
  }

  get bundledTab() {
    if (!this.tab)
      return null;
    const substance = Tab.getSubstanceFromAliasGroupTab(this.tab);
    if (substance)
      return substance;
    if (this.tab.pinned)
      return Tab.getGroupTabForOpener(this.tab);
    if (this.isGroupTab)
      return Tab.getOpenerFromGroupTab(this.tab);
    return null;
  }

  get bundledTabId() {
    const tab = this.bundledTab;
    return tab ? tab.id : -1;
  }

  findSuccessor(options = {}) {
    if (!this.tab)
      return null;
    if (typeof options != 'object')
      options = {};
    const ignoredTabs = (options.ignoredTabs || []).slice(0);
    let foundTab = this.tab;
    do {
      ignoredTabs.push(foundTab);
      foundTab = foundTab.$TST.nextTab;
    } while (foundTab && ignoredTabs.includes(foundTab));
    if (!foundTab) {
      foundTab = this.tab;
      do {
        ignoredTabs.push(foundTab);
        foundTab = foundTab.$TST.nearestVisiblePrecedingTab;
      } while (foundTab && ignoredTabs.includes(foundTab));
    }
    return foundTab;
  }

  get lastRelatedTab() {
    return Tab.get(this.lastRelatedTabId) || null;
  }
  set lastRelatedTab(relatedTab) {
    if (!this.tab)
      return relatedTab;
    const previousLastRelatedTabId = this.lastRelatedTabId;
    const win = TabsStore.windows.get(this.tab.windowId);
    if (relatedTab) {
      win.lastRelatedTabs.set(this.id, relatedTab.id);
      this.newRelatedTabsCount++;
      successorTabLog(`set lastRelatedTab for ${this.id}: ${previousLastRelatedTabId} => ${relatedTab.id} (${this.newRelatedTabsCount})`);
    }
    else {
      win.lastRelatedTabs.delete(this.id);
      this.newRelatedTabsCount = 0;
      successorTabLog(`clear lastRelatedTab for ${this.id} (${previousLastRelatedTabId})`);
    }
    win.previousLastRelatedTabs.set(this.id, previousLastRelatedTabId);
    return relatedTab;
  }

  get lastRelatedTabId() {
    if (!this.tab)
      return 0;
    const win = TabsStore.windows.get(this.tab.windowId);
    return win.lastRelatedTabs.get(this.id) || 0;
  }

  get previousLastRelatedTab() {
    if (!this.tab)
      return null;
    const win = TabsStore.windows.get(this.tab.windowId);
    return Tab.get(win.previousLastRelatedTabs.get(this.id)) || null;
  }

  // if all tabs are aldeardy placed at there, we don't need to move them.
  isAllPlacedBeforeSelf(tabs) {
    if (!this.tab ||
        tabs.length == 0)
      return true;
    let nextTab = this.tab;
    if (tabs[tabs.length - 1] == nextTab)
      nextTab = nextTab.$TST.unsafeNextTab;
    if (!nextTab && !tabs[tabs.length - 1].$TST.unsafeNextTab)
      return true;

    tabs = Array.from(tabs);
    let previousTab = tabs.shift();
    for (const tab of tabs) {
      if (tab.$TST.unsafePreviousTab != previousTab)
        return false;
      previousTab = tab;
    }
    return !nextTab ||
           !previousTab ||
           previousTab.$TST.unsafeNextTab == nextTab;
  }

  isAllPlacedAfterSelf(tabs) {
    if (!this.tab ||
        tabs.length == 0)
      return true;
    let previousTab = this.tab;
    if (tabs[0] == previousTab)
      previousTab = previousTab.$TST.unsafePreviousTab;
    if (!previousTab && !tabs[0].$TST.unsafePreviousTab)
      return true;

    tabs = Array.from(tabs).reverse();
    let nextTab = tabs.shift();
    for (const tab of tabs) {
      if (tab.$TST.unsafeNextTab != nextTab)
        return false;
      nextTab = tab;
    }
    return !previousTab ||
           !nextTab ||
           nextTab.$TST.unsafePreviousTab == previousTab;
  }

  detach() {
    this.parent   = null;
    this.children = [];
  }


  //===================================================================
  // State
  //===================================================================

  async toggleState(state, condition, { permanently, toTab, broadcast } = {}) {
    if (condition)
      return this.addState(state, { permanently, toTab, broadcast });
    else
      return this.removeState(state, { permanently, toTab, broadcast });
  }

  async addState(state, { permanently, toTab, broadcast } = {}) {
    state = state && String(state) || undefined;
    if (!this.tab || !state)
      return;

    const modified = this.states && !this.states.has(state);

    if (this.classList)
      this.classList.add(state);
    if (this.states)
      this.states.add(state);

    switch (state) {
      case Constants.kTAB_STATE_HIGHLIGHTED:
        TabsStore.addHighlightedTab(this.tab);
        if (this.element)
          this.element.setAttribute('aria-selected', 'true');
        if (toTab)
          this.tab.highlighted = true;
        break;

      case Constants.kTAB_STATE_SELECTED:
        TabsStore.addSelectedTab(this.tab);
        break;

      case Constants.kTAB_STATE_COLLAPSED:
      case Constants.kTAB_STATE_SUBTREE_COLLAPSED:
        if (this.isSubtreeCollapsable)
          TabsStore.addSubtreeCollapsableTab(this.tab);
        else
          TabsStore.removeSubtreeCollapsableTab(this.tab);
        break;

      case Constants.kTAB_STATE_HIDDEN:
        TabsStore.removeVisibleTab(this.tab);
        TabsStore.removeControllableTab(this.tab);
        if (toTab)
          this.tab.hidden = true;
        break;

      case Constants.kTAB_STATE_PINNED:
        TabsStore.addPinnedTab(this.tab);
        TabsStore.removeUnpinnedTab(this.tab);
        if (toTab)
          this.tab.pinned = true;
        break;

      case Constants.kTAB_STATE_BUNDLED_ACTIVE:
        TabsStore.addBundledActiveTab(this.tab);
        break;

      case Constants.kTAB_STATE_SOUND_PLAYING: {
        const parent = this.parent;
        if (parent)
          parent.$TST.soundPlayingChildrenIds.add(this.id);
      } break;
      case Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeSoundPlayingChildrenIds.add(this.id);
      } break;

      case Constants.kTAB_STATE_AUDIBLE:
        if (toTab)
          this.tab.audible = true;
        break;

      case Constants.kTAB_STATE_MUTED: {
        const parent = this.parent;
        if (parent)
          parent.$TST.mutedChildrenIds.add(this.id);
        if (toTab)
          this.tab.mutedInfo.muted = true;
      } break;
      case Constants.kTAB_STATE_HAS_MUTED_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeMutedChildrenIds.add(this.id);
      } break;

      case Constants.kTAB_STATE_AUTOPLAY_BLOCKED: {
        const parent = this.parent;
        if (parent) {
          parent.$TST.autoplayBlockedChildrenIds.add(this.id);
          parent.$TST.inheritSoundStateFromChildren();
        }
      } break;
      case Constants.kTAB_STATE_HAS_AUTOPLAY_BLOCKED_MEMBER: {
        const parent = this.parent;
        if (parent) {
          parent.$TST.maybeAutoplayBlockedChildrenIds.add(this.id);
          parent.$TST.inheritSoundStateFromChildren();
        }
      } break;

      case Constants.kTAB_STATE_SHARING_CAMERA: {
        const parent = this.parent;
        if (parent)
          parent.$TST.sharingCameraChildrenIds.add(this.id);
        if (toTab && this.tab.sharingState)
          this.tab.sharingState.camera = true;
      } break;
      case Constants.kTAB_STATE_HAS_SHARING_CAMERA_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeSharingCameraChildrenIds.add(this.id);
      } break;

      case Constants.kTAB_STATE_SHARING_MICROPHONE: {
        const parent = this.parent;
        if (parent)
          parent.$TST.sharingMicrophoneChildrenIds.add(this.id);
        if (toTab && this.tab.sharingState)
          this.tab.sharingState.microphone = true;
      } break;
      case Constants.kTAB_STATE_HAS_SHARING_MICROPHONE_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeSharingMicrophoneChildrenIds.add(this.id);
      } break;

      case Constants.kTAB_STATE_SHARING_SCREEN: {
        const parent = this.parent;
        if (parent)
          parent.$TST.sharingScreenChildrenIds.add(this.id);
        if (toTab && this.tab.sharingState)
          this.tab.sharingState.screen = 'Something';
      } break;
      case Constants.kTAB_STATE_HAS_SHARING_SCREEN_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeSharingScreenChildrenIds.add(this.id);
      } break;

      case Constants.kTAB_STATE_GROUP_TAB:
        TabsStore.addGroupTab(this.tab);
        break;

      case Constants.kTAB_STATE_PRIVATE_BROWSING:
        if (toTab)
          this.tab.incognito = true;
        break;

      case Constants.kTAB_STATE_ATTENTION:
        if (toTab)
          this.tab.attention = true;
        break;

      case Constants.kTAB_STATE_DISCARDED:
        if (toTab)
          this.tab.discarded = true;
        break;

      case 'loading':
        TabsStore.addLoadingTab(this.tab);
        if (toTab)
          this.tab.status = state;
        break;

      case 'complete':
        TabsStore.removeLoadingTab(this.tab);
        if (toTab)
          this.tab.status = state;
        break;
    }

    if (this.tab &&
        modified &&
        Constants.IS_BACKGROUND &&
        broadcast !== false)
      Tab.broadcastState(this.tab, {
        add: [state],
      });
    if (permanently) {
      const states = await this.getPermanentStates();
      if (!states.includes(state)) {
        states.push(state);
        await browser.sessions.setTabValue(this.id, Constants.kPERSISTENT_STATES, states).catch(ApiTabs.createErrorSuppressor());
      }
    }
    if (modified) {
      this.invalidateCache();
      if (this.tab)
        Tab.onStateChanged.dispatch(this.tab, state, true);
    }
  }

  async removeState(state, { permanently, toTab, broadcast } = {}) {
    state = state && String(state) || undefined;
    if (!this.tab || !state)
      return;

    const modified = this.states && this.states.has(state);

    if (this.classList)
      this.classList.remove(state);
    if (this.states)
      this.states.delete(state);

    switch (state) {
      case Constants.kTAB_STATE_HIGHLIGHTED:
        TabsStore.removeHighlightedTab(this.tab);
        if (this.element)
          this.element.setAttribute('aria-selected', 'false');
        if (toTab)
          this.tab.highlighted = false;
        break;

      case Constants.kTAB_STATE_SELECTED:
        TabsStore.removeSelectedTab(this.tab);
        break;

      case Constants.kTAB_STATE_COLLAPSED:
      case Constants.kTAB_STATE_SUBTREE_COLLAPSED:
        if (this.isSubtreeCollapsable)
          TabsStore.addSubtreeCollapsableTab(this.tab);
        else
          TabsStore.removeSubtreeCollapsableTab(this.tab);
        break;

      case Constants.kTAB_STATE_HIDDEN:
        if (!this.collapsed)
          TabsStore.addVisibleTab(this.tab);
        TabsStore.addControllableTab(this.tab);
        if (toTab)
          this.tab.hidden = false;
        break;

      case Constants.kTAB_STATE_PINNED:
        TabsStore.removePinnedTab(this.tab);
        TabsStore.addUnpinnedTab(this.tab);
        if (toTab)
          this.tab.pinned = false;
        break;

      case Constants.kTAB_STATE_BUNDLED_ACTIVE:
        TabsStore.removeBundledActiveTab(this.tab);
        break;

      case Constants.kTAB_STATE_SOUND_PLAYING: {
        const parent = this.parent;
        if (parent)
          parent.$TST.soundPlayingChildrenIds.delete(this.id);
      } break;
      case Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeSoundPlayingChildrenIds.delete(this.id);
      } break;

      case Constants.kTAB_STATE_AUDIBLE:
        if (toTab)
          this.tab.audible = false;
        break;

      case Constants.kTAB_STATE_MUTED: {
        const parent = this.parent;
        if (parent)
          parent.$TST.mutedChildrenIds.delete(this.id);
        if (toTab)
          this.tab.mutedInfo.muted = false;
      } break;
      case Constants.kTAB_STATE_HAS_MUTED_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeMutedChildrenIds.delete(this.id);
      } break;

      case Constants.kTAB_STATE_AUTOPLAY_BLOCKED: {
        const parent = this.parent;
        if (parent) {
          parent.$TST.autoplayBlockedChildrenIds.delete(this.id);
          parent.$TST.inheritSoundStateFromChildren();
        }
      } break;
      case Constants.kTAB_STATE_HAS_AUTOPLAY_BLOCKED_MEMBER: {
        const parent = this.parent;
        if (parent) {
          parent.$TST.maybeAutoplayBlockedChildrenIds.delete(this.id);
          parent.$TST.inheritSoundStateFromChildren();
        }
      } break;

      case Constants.kTAB_STATE_SHARING_CAMERA: {
        const parent = this.parent;
        if (parent)
          parent.$TST.sharingCameraChildrenIds.delete(this.id);
        if (toTab && this.tab.sharingState)
          this.tab.sharingState.camera = false;
      } break;
      case Constants.kTAB_STATE_HAS_SHARING_CAMERA_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeSharingCameraChildrenIds.delete(this.id);
      } break;

      case Constants.kTAB_STATE_SHARING_MICROPHONE: {
        const parent = this.parent;
        if (parent)
          parent.$TST.sharingMicrophoneChildrenIds.delete(this.id);
        if (toTab && this.tab.sharingState)
          this.tab.sharingState.microphone = false;
      } break;
      case Constants.kTAB_STATE_HAS_SHARING_MICROPHONE_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeSharingMicrophoneChildrenIds.delete(this.id);
      } break;

      case Constants.kTAB_STATE_SHARING_SCREEN: {
        const parent = this.parent;
        if (parent)
          parent.$TST.sharingScreenChildrenIds.delete(this.id);
        if (toTab && this.tab.sharingState)
          this.tab.sharingState.screen = undefined;
      } break;
      case Constants.kTAB_STATE_HAS_SHARING_SCREEN_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeSharingScreenChildrenIds.delete(this.id);
      } break;

      case Constants.kTAB_STATE_GROUP_TAB:
        TabsStore.removeGroupTab(this.tab);
        break;

      case Constants.kTAB_STATE_PRIVATE_BROWSING:
        if (toTab)
          this.tab.incognito = false;
        break;

      case Constants.kTAB_STATE_ATTENTION:
        if (toTab)
          this.tab.attention = false;
        break;

      case Constants.kTAB_STATE_DISCARDED:
        if (toTab)
          this.tab.discarded = false;
        break;
    }

    if (modified &&
        Constants.IS_BACKGROUND &&
        broadcast !== false)
      Tab.broadcastState(this.tab, {
        remove: [state],
      });
    if (permanently) {
      const states = await this.getPermanentStates();
      const index = states.indexOf(state);
      if (index > -1) {
        states.splice(index, 1);
        await browser.sessions.setTabValue(this.id, Constants.kPERSISTENT_STATES, states).catch(ApiTabs.createErrorSuppressor());
      }
    }
    if (modified) {
      this.invalidateCache();
      Tab.onStateChanged.dispatch(this.tab, state, false);
    }
  }

  async getPermanentStates() {
    const states = this.tab && await browser.sessions.getTabValue(this.id, Constants.kPERSISTENT_STATES).catch(ApiTabs.handleMissingTabError);
    // We need to cleanup invalid values stored accidentally.
    // See also: https://github.com/piroor/treestyletab/issues/2882
    return states && mapAndFilterUniq(states, state => state && String(state) || undefined) || [];
  }

  inheritSoundStateFromChildren() {
    if (!this.tab)
      return;

    // this is called too many times on a session restoration, so this should be throttled for better performance
    if (this.delayedInheritSoundStateFromChildren)
      clearTimeout(this.delayedInheritSoundStateFromChildren);

    this.delayedInheritSoundStateFromChildren = setTimeout(() => {
      this.delayedInheritSoundStateFromChildren = null;
      if (!TabsStore.ensureLivingTab(this.tab))
        return;

      const parent = this.parent;
      let modifiedCount = 0;

      const soundPlayingCount = this.soundPlayingChildrenIds.size + this.maybeSoundPlayingChildrenIds.size;
      if (soundPlayingCount != this.lastSoundStateCounts.soundPlaying) {
        this.lastSoundStateCounts.soundPlaying = soundPlayingCount;
        this.toggleState(Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER, soundPlayingCount > 0);
        if (parent) {
          if (soundPlayingCount > 0)
            parent.$TST.maybeSoundPlayingChildrenIds.add(this.id);
          else
            parent.$TST.maybeSoundPlayingChildrenIds.delete(this.id);
        }
        modifiedCount++;
      }

      const mutedCount = this.mutedChildrenIds.size + this.maybeMutedChildrenIds.size;
      if (mutedCount != this.lastSoundStateCounts.muted) {
        this.lastSoundStateCounts.muted = mutedCount;
        this.toggleState(Constants.kTAB_STATE_HAS_MUTED_MEMBER, mutedCount > 0);
        if (parent) {
          if (mutedCount > 0)
            parent.$TST.maybeMutedChildrenIds.add(this.id);
          else
            parent.$TST.maybeMutedChildrenIds.delete(this.id);
        }
        modifiedCount++;
      }

      const autoplayBlockedCount = this.autoplayBlockedChildrenIds.size + this.maybeAutoplayBlockedChildrenIds.size;
      if (autoplayBlockedCount != this.lastSoundStateCounts.autoplayBlocked) {
        this.lastSoundStateCounts.autoplayBlocked = autoplayBlockedCount;
        this.toggleState(Constants.kTAB_STATE_HAS_AUTOPLAY_BLOCKED_MEMBER, autoplayBlockedCount > 0);
        if (parent) {
          if (autoplayBlockedCount > 0)
            parent.$TST.maybeAutoplayBlockedChildrenIds.add(this.id);
          else
            parent.$TST.maybeAutoplayBlockedChildrenIds.delete(this.id);
        }
        modifiedCount++;
      }

      if (modifiedCount == 0)
        return;

      if (parent)
        parent.$TST.inheritSoundStateFromChildren();

      SidebarConnection.sendMessage({
        type:                  Constants.kCOMMAND_NOTIFY_TAB_SOUND_STATE_UPDATED,
        windowId:              this.tab.windowId,
        tabId:                 this.id,
        hasSoundPlayingMember: this.states.has(Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER),
        hasMutedMember:        this.states.has(Constants.kTAB_STATE_HAS_MUTED_MEMBER),
        hasAutoplayBlockedMember: this.states.has(Constants.kTAB_STATE_HAS_AUTOPLAY_BLOCKED_MEMBER),
      });
    }, 100);
  }

  inheritSharingStateFromChildren() {
    if (!this.tab)
      return;

    // this is called too many times on a session restoration, so this should be throttled for better performance
    if (this.delayedInheritSharingStateFromChildren)
      clearTimeout(this.delayedInheritSharingStateFromChildren);

    this.delayedInheritSharingStateFromChildren = setTimeout(() => {
      this.delayedInheritSharingStateFromChildren = null;
      if (!TabsStore.ensureLivingTab(this.tab))
        return;

      const parent = this.parent;
      let modifiedCount = 0;

      const sharingCameraCount = this.sharingCameraChildrenIds.size + this.maybeSharingCameraChildrenIds.size;
      if (sharingCameraCount != this.lastSharingStateCounts.sharingCamera) {
        this.lastSharingStateCounts.sharingCamera = sharingCameraCount;
        this.toggleState(Constants.kTAB_STATE_HAS_SHARING_CAMERA_MEMBER, sharingCameraCount > 0);
        if (parent) {
          if (sharingCameraCount > 0)
            parent.$TST.maybeSharingCameraChildrenIds.add(this.id);
          else
            parent.$TST.maybeSharingCameraChildrenIds.delete(this.id);
        }
        modifiedCount++;
      }

      const sharingMicrophoneCount = this.sharingMicrophoneChildrenIds.size + this.maybeSharingMicrophoneChildrenIds.size;
      if (sharingMicrophoneCount != this.lastSharingStateCounts.sharingMicrophone) {
        this.lastSharingStateCounts.sharingMicrophone = sharingMicrophoneCount;
        this.toggleState(Constants.kTAB_STATE_HAS_SHARING_MICROPHONE_MEMBER, sharingMicrophoneCount > 0);
        if (parent) {
          if (sharingMicrophoneCount > 0)
            parent.$TST.maybeSharingMicrophoneChildrenIds.add(this.id);
          else
            parent.$TST.maybeSharingMicrophoneChildrenIds.delete(this.id);
        }
        modifiedCount++;
      }

      const sharingScreenCount = this.sharingScreenChildrenIds.size + this.maybeSharingScreenChildrenIds.size;
      if (sharingScreenCount != this.lastSharingStateCounts.sharingScreen) {
        this.lastSharingStateCounts.sharingScreen = sharingScreenCount;
        this.toggleState(Constants.kTAB_STATE_HAS_SHARING_SCREEN_MEMBER, sharingScreenCount > 0);
        if (parent) {
          if (sharingScreenCount > 0)
            parent.$TST.maybeSharingScreenChildrenIds.add(this.id);
          else
            parent.$TST.maybeSharingScreenChildrenIds.delete(this.id);
        }
        modifiedCount++;
      }

      if (modifiedCount == 0)
        return;

      if (parent)
        parent.$TST.inheritSharingStateFromChildren();

      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_NOTIFY_TAB_SHARING_STATE_UPDATED,
        windowId: this.tab.windowId,
        tabId:    this.id,
        hasSharingCameraMember:     this.states.has(Constants.kTAB_STATE_HAS_SHARING_CAMERA_MEMBER),
        hasSharingMicrophoneMember: this.states.has(Constants.kTAB_STATE_HAS_SHARING_MICROPHONE_MEMBER),
        hasSharingScreenMember:     this.states.has(Constants.kTAB_STATE_HAS_SHARING_SCREEN_MEMBER),
      });
    }, 100);
  }


  setAttribute(attribute, value) {
    if (this.element)
      this.element.setAttribute(attribute, value);
    this.attributes[attribute] = value;
    this.invalidateCache();
  }

  getAttribute(attribute) {
    return this.attributes[attribute];
  }

  removeAttribute(attribute) {
    if (this.element)
      this.element.removeAttribute(attribute);
    delete this.attributes[attribute];
    this.invalidateCache();
  }


  resolveOpened() {
    if (!mOpenedResolvers.has(this.id))
      return;
    for (const resolver of mOpenedResolvers.get(this.id)) {
      resolver.resolve();
    }
    mOpenedResolvers.delete(this.id);
  }
  rejectOpened() {
    if (!mOpenedResolvers.has(this.id))
      return;
    for (const resolver of mOpenedResolvers.get(this.id)) {
      resolver.reject();
    }
    mOpenedResolvers.delete(this.id);
  }

  memorizeNeighbors(hint) {
    if (!this.tab) // already closed tab
      return;
    log(`memorizeNeighbors ${this.tab.id} as ${hint}`);
    this.lastPreviousTabId = this.unsafePreviousTab?.id;
    this.lastNextTabId = this.unsafeNextTab?.id;
  }

  // https://github.com/piroor/treestyletab/issues/2309#issuecomment-518583824
  get movedInBulk() {
    const previousTab = this.unsafePreviousTab;
    if (this.lastPreviousTabId &&
        this.lastPreviousTabId != previousTab?.id) {
      log(`not bulkMoved lastPreviousTabId=${this.lastNextTabId}, previousTab=${previousTab?.id}`);
      return false;
    }

    const nextTab = this.unsafeNextTab;
    if (this.lastNextTabId &&
        this.lastNextTabId != nextTab?.id) {
      log(`not bulkMoved lastNextTabId=${this.lastNextTabId}, nextTab=${nextTab?.id}`);
      return false;
    }

    return true;
  }

  get sanitized() {
    if (!this.tab)
      return {};

    const sanitized = {
      ...this.tab,
      '$possibleInitialUrl': null,
      '$TST': null,
      '$exportedForAPI': null,
      '$exportedForAPIWithPermissions': null,
    };
    delete sanitized.$TST;
    return sanitized;
  }

  export(full) {
    const exported = {
      id:         this.id,
      uniqueId:   this.uniqueId,
      states:     Array.from(this.states),
      attributes: this.attributes,
      parentId:   this.parentId,
      childIds:   this.childIds,
      collapsed:  this.collapsed,
      subtreeCollapsed: this.subtreeCollapsed
    };
    if (full)
      return {
        ...this.sanitized,
        $TST: exported
      };
    return exported;
  }

  apply(exported) { // not optimized and unsafe yet!
    if (!this.tab)
      return;

    TabsStore.removeTabFromIndexes(this.tab);

    for (const key of Object.keys(exported)) {
      if (key == '$TST')
        continue;
      if (key in this.tab)
        this.tab[key] = exported[key];
    }

    this.uniqueId = exported.$TST.uniqueId;
    this.promisedUniqueId = Promise.resolve(this.uniqueId);

    this.states     = new Set(exported.$TST.states);
    this.attributes = exported.$TST.attributes;

    this.parent   = exported.$TST.parentId;
    this.children = exported.$TST.childIds || [];

    TabsStore.updateIndexesForTab(this.tab);
  }


  // This function is complex a little, but we should not make a custom class for this purpose,
  // bacause instances of the class will be very short-life and increases RAM usage on
  // massive tabs case.
  async exportForAPI({ addonId, light, isContextTab, interval, permissions, cache, cacheKey } = {}) {
    const permissionsKey = [...permissions].sort().join(',');
    if (!light &&
        configs.cacheAPITreeItems &&
        this.$exportedForAPIWithPermissions.has(permissionsKey))
      return this.$exportedForAPIWithPermissions.get(permissionsKey);

    let exportedTab = configs.cacheAPITreeItems && light ? this.$exportedForAPI : null;
    let favIconUrl;
    if (!exportedTab) {
      const [effectiveFavIconUrl, children] = await Promise.all([
        (light ||
         (!permissions ||
          (!permissions.has(kPERMISSION_TABS) &&
           (!permissions.has(kPERMISSION_ACTIVE_TAB) ||
            !this.tab.active)))) ?
          null :
          (this.tab.id in cache.effectiveFavIconUrls) ?
            cache.effectiveFavIconUrls[this.tab.id] :
            (this.tab.favIconUrl && this.tab.favIconUrl.startsWith('data:')) ?
              this.tab.favIconUrl :
              TabFavIconHelper.getLastEffectiveFavIconURL(this.tab).catch(ApiTabs.handleMissingTabError),
        doProgressively(
          this.tab.$TST.children,
          child => child.$TST.exportForAPI({ addonId, light, isContextTab, interval, permissions, cache, cacheKey }),
          interval
        ),
      ]);
      favIconUrl = effectiveFavIconUrl;

      if (!(this.tab.id in cache.effectiveFavIconUrls))
        cache.effectiveFavIconUrls[this.tab.id] = effectiveFavIconUrl;

      const tabStates = this.tab.$TST.states;
      exportedTab = {
        id:             this.tab.id,
        windowId:       this.tab.windowId,
        states:         Constants.kTAB_SAFE_STATES_ARRAY.filter(state => tabStates.has(state)),
        indent:         parseInt(this.tab.$TST.getAttribute(Constants.kLEVEL) || 0),
        children,
        ancestorTabIds: this.tab.$TST.ancestorIds,
        bundledTabId:   this.tab.$TST.bundledTabId,
      };
      if (this.stuck)
        exportedTab.states.push(Constants.kTAB_STATE_STUCK);
      if (configs.cacheAPITreeItems && light)
        this.$exportedForAPI = exportedTab;
    }

    if (light)
      return exportedTab;

    const fullExportedTab = { ...exportedTab };

    const allowedProperties = new Set([
      // basic tabs.Tab properties
      'active',
      'attention',
      'audible',
      'autoDiscardable',
      'discarded',
      'height',
      'hidden',
      'highlighted',
      //'id',
      'incognito',
      'index',
      'isArticle',
      'isInReaderMode',
      'lastAccessed',
      'mutedInfo',
      'openerTabId',
      'pinned',
      'selected',
      'sessionId',
      'sharingState',
      'status',
      'successorId',
      'width',
      //'windowId',
    ]);

    if (permissions.has(kPERMISSION_TABS) ||
        (permissions.has(kPERMISSION_ACTIVE_TAB) &&
         (this.tab.active ||
          (this.tab == this.tab && this.isContextTab)))) {
      // specially allowed with "tabs" or "activeTab" permission
      allowedProperties.add('favIconUrl');
      allowedProperties.add('title');
      allowedProperties.add('url');
      fullExportedTab.effectiveFavIconUrl = favIconUrl;
    }
    if (permissions.has(kPERMISSION_COOKIES)) {
      allowedProperties.add('cookieStoreId');
      fullExportedTab.cookieStoreName = this.tab.$TST.cookieStoreName;
    }

    for (const property of allowedProperties) {
      if (property in this.tab)
        fullExportedTab[property] = this.tab[property];
    }

    if (configs.cacheAPITreeItems)
      this.$exportedForAPIWithPermissions.set(permissionsKey, fullExportedTab)
    return fullExportedTab;
  }

  invalidateCache() {
    this.$exportedForAPI = null;
    this.$exportedForAPIWithPermissions.clear();
  }


  applyStatesToElement() {
    if (!this.element)
      return;

    this.applyAttributesToElement();

    for (const state of this.states) {
      this.element.classList.add(state);
      if (state == Constants.kTAB_STATE_HIGHLIGHTED)
        this.element.setAttribute('aria-selected', 'true');
    }

    for (const [name, value] of Object.entries(this.attributes)) {
      this.element.setAttribute(name, value);
    }
  }

  applyAttributesToElement() {
    if (!this.element)
      return;

    this.element.applyAttributes();
  }


  /* element utilities */

  invalidateElement(targets) {
    if (this.element?.invalidate)
      this.element.invalidate(targets);
  }

  updateElement(targets) {
    if (this.element?.update)
      this.element.update(targets);
  }

  set favIconUrl(url) {
    if (this.element && 'favIconUrl' in this.element)
      this.element.favIconUrl = url;
    this.invalidateCache();
  }
}

// The list of properties which should be ignored when synchronization from the
// background to sidebars.
Tab.UNSYNCHRONIZABLE_PROPERTIES = new Set([
  'id',
  // Ignore "index" on synchronization, because it maybe wrong for the sidebar.
  // Index of tabs are managed and fixed by other sections like handling of
  // "kCOMMAND_NOTIFY_TAB_CREATING", Window.prototype.trackTab, and others.
  // See also: https://github.com/piroor/treestyletab/issues/2119
  'index',
  'reindexedBy'
]);


//===================================================================
// tracking of tabs
//===================================================================

Tab.onTracked      = new EventListenerManager();
Tab.onDestroyed    = new EventListenerManager();
Tab.onInitialized  = new EventListenerManager();
Tab.onStateChanged  = new EventListenerManager();
Tab.onElementBound = new EventListenerManager();

Tab.track = tab => {
  const trackedTab = Tab.get(tab.id);
  if (!trackedTab ||
      !(tab.$TST instanceof Tab)) {
    new Tab(tab);
  }
  else {
    if (trackedTab)
      tab = trackedTab;
    const win = TabsStore.windows.get(tab.windowId);
    win.trackTab(tab);
  }
  return trackedTab || tab;
};

Tab.untrack = tabId => {
  const tab = Tab.get(tabId);
  if (!tab) // already untracked
    return;
  const win = TabsStore.windows.get(tab.windowId);
  if (win)
    win.untrackTab(tabId);
};

Tab.isTracked = tabId =>  {
  return TabsStore.tabs.has(tabId);
};

Tab.get = tabId =>  {
  return TabsStore.tabs.get(typeof tabId == 'number' ? tabId : tabId?.id);
};

Tab.getByUniqueId = id => {
  if (!id)
    return null;
  return TabsStore.ensureLivingTab(TabsStore.tabsByUniqueId.get(id));
};

Tab.needToWaitTracked = (windowId) => {
  if (windowId) {
    const tabs = mIncompletelyTrackedTabs.get(windowId);
    return tabs && tabs.size > 0;
  }
  for (const tabs of mIncompletelyTrackedTabs.values()) {
    if (tabs && tabs.size > 0)
      return true;
  }
  return false;
};

Tab.waitUntilTrackedAll = async (windowId, options = {}) => {
  const tabSets = windowId ?
    [mIncompletelyTrackedTabs.get(windowId)] :
    [...mIncompletelyTrackedTabs.values()];
  return Promise.all(tabSets.map(tabs => {
    if (!tabs)
      return;
    let tabIds = Array.from(tabs, tab => tab.id);
    if (options.exceptionTabId)
      tabIds = tabIds.filter(id => id != options.exceptionTabId);
    return Tab.waitUntilTracked(tabIds, options);
  }));
};

const mWaitingTasks = new Map();

function destroyWaitingTabTask(task) {
  const tasks = mWaitingTasks.get(task.tabId);
  if (tasks)
    tasks.delete(task);

  if (task.timeout)
    clearTimeout(task.timeout);

  const resolve     = task.resolve;
  const stack       = task.stack;

  task.tabId       = undefined;
  task.resolve     = undefined;
  task.timeout     = undefined;
  task.stack       = undefined;

  return { resolve, stack };
}

function onWaitingTabTracked(tab) {
  if (!tab)
    return;

  const tasks = mWaitingTasks.get(tab.id);
  if (!tasks)
    return;

  mWaitingTasks.delete(tab.id);

  for (const task of tasks) {
    tasks.delete(task);
    const { resolve } = destroyWaitingTabTask(task);
    if (!resolve)
      continue;
    resolve(tab);
  }
}
Tab.onElementBound.addListener(onWaitingTabTracked);
Tab.onTracked.addListener(onWaitingTabTracked);

function onWaitingTabDestroyed(tab) {
  if (!tab)
    return;

  const tasks = mWaitingTasks.get(tab.id);
  if (!tasks)
    return;

  mWaitingTasks.delete(tab.id);

  const scope = TabsStore.getCurrentWindowId() || 'bg';
  for (const task of tasks) {
    tasks.delete(task);
    const { resolve, stack } = destroyWaitingTabTask(task);
    if (!resolve)
      continue;

    log(`Tab.waitUntilTracked: ${tab.id} is destroyed while waiting (in ${scope})\n${stack}`);
    resolve(null);
  }
}
Tab.onDestroyed.addListener(onWaitingTabDestroyed);

function onWaitingTabRemoved(removedTabId, _removeInfo) {
  const tasks = mWaitingTasks.get(removedTabId);
  if (!tasks)
    return;

  mWaitingTasks.delete(removedTabId);

  const scope = TabsStore.getCurrentWindowId() || 'bg';
  for (const task of tasks) {
    tasks.delete(task);
    const { resolve, stack } = destroyWaitingTabTask(task);
    if (!resolve)
      continue;

    log(`Tab.waitUntilTracked: ${removedTabId} is removed while waiting (in ${scope})\n${stack}`);
    resolve(null);
  }
}
browser.tabs.onRemoved.addListener(onWaitingTabRemoved);

async function waitUntilTracked(tabId, options = {}) {
  const stack = configs.debug && new Error().stack;
  const tab = Tab.get(tabId);
  if (tab) {
    onWaitingTabTracked(tab);
    if (options.element)
      return tab.$TST.promisedElement;
    return tab;
  }
  const tasks = mWaitingTasks.get(tabId) || new Set();
  const task = {
    tabId,
    stack,
  };
  tasks.add(task);
  mWaitingTasks.set(tabId, tasks);
  return new Promise((resolve, _reject) => {
    task.resolve = resolve;
    task.timeout = setTimeout(() => {
      const { resolve } = destroyWaitingTabTask(task);
      if (resolve) {
        log(`Tab.waitUntilTracked for ${tabId} is timed out (in ${TabsStore.getCurrentWindowId() || 'bg'})\b${stack}`);
        resolve(null);
      }
    }, configs.maximumDelayUntilTabIsTracked); // Tabs.moveTabs() between windows may take much time
    browser.tabs.get(tabId).catch(_error => null).then(tab => {
      if (tab) {
        if (Tab.get(tabId))
          onWaitingTabTracked(tab);
        return;
      }
      const { resolve } = destroyWaitingTabTask(task);
      if (resolve) {
        log('waitUntilTracked was called for unexisting tab');
        resolve(null);
      }
    });
  }).then(() => destroyWaitingTabTask(task));
}

Tab.waitUntilTracked = async (tabId, options = {}) => {
  if (!tabId)
    return null;

  if (Array.isArray(tabId))
    return Promise.all(tabId.map(id => Tab.waitUntilTracked(id, options)));

  const windowId = TabsStore.getCurrentWindowId();
  if (windowId) {
    const tabs = TabsStore.removedTabsInWindow.get(windowId);
    if (tabs && tabs.has(tabId))
      return null; // already removed tab
  }

  const key = `${tabId}:${!!options.element}`;
  if (mPromisedTrackedTabs.has(key))
    return mPromisedTrackedTabs.get(key);

  const promisedTracked = waitUntilTracked(tabId, options);
  mPromisedTrackedTabs.set(key, promisedTracked);
  return promisedTracked.then(tab => {
    // Don't claer the last promise, because it is required to process following "waitUntilTracked" callbacks sequentically.
    //if (mPromisedTrackedTabs.get(key) == promisedTracked)
    //  mPromisedTrackedTabs.delete(key);
    return tab;
  }).catch(_error => {
    //if (mPromisedTrackedTabs.get(key) == promisedTracked)
    //  mPromisedTrackedTabs.delete(key);
    return null;
  });
};

Tab.needToWaitMoved = (windowId) => {
  if (windowId) {
    const tabs = mMovingTabs.get(windowId);
    return tabs && tabs.size > 0;
  }
  for (const tabs of mMovingTabs.values()) {
    if (tabs && tabs.size > 0)
      return true;
  }
  return false;
};

Tab.waitUntilMovedAll = async windowId => {
  const tabSets = [];
  if (windowId) {
    tabSets.push(mMovingTabs.get(windowId));
  }
  else {
    for (const tabs of mMovingTabs.values()) {
      tabSets.push(tabs);
    }
  }
  return Promise.all(tabSets.map(tabs => tabs && Promise.all(tabs)));
};

Tab.init = (tab, options = {}) => {
  log('initalize tab ', tab);
  if (!tab) {
    const error = new Error('Fatal error: invalid tab is given to Tab.init()');
    console.log(error, error.stack);
    throw error;
  }
  const trackedTab = Tab.get(tab.id);
  if (trackedTab)
    tab = trackedTab;
  tab.$TST = (trackedTab && trackedTab.$TST) || new Tab(tab);
  tab.$TST.updateUniqueId().then(tab.$TST.onUniqueIdGenerated);

  if (tab.active)
    tab.$TST.addState(Constants.kTAB_STATE_ACTIVE);

  // When a new "child" tab was opened and the "parent" tab was closed
  // immediately by someone outside of TST, both new "child" and the
  // "parent" were closed by TST because all new tabs had
  // "subtree-collapsed" state initially and such an action was detected
  // as "closing of a collapsed tree".
  // The initial state was introduced in old versions, but I forgot why
  // it was required. "When new child tab is attached, collapse other
  // tree" behavior works as expected even if the initial state is not
  // there. Thus I remove the initial state for now, to avoid the
  // annoying problem.
  // See also: https://github.com/piroor/treestyletab/issues/2162
  // tab.$TST.addState(Constants.kTAB_STATE_SUBTREE_COLLAPSED);

  Tab.onInitialized.dispatch(tab, options);

  if (options.existing) {
    tab.$TST.addState(Constants.kTAB_STATE_ANIMATION_READY);
    tab.$TST.opened = Promise.resolve(true).then(() => {
      tab.$TST.resolveOpened();
    });
    tab.$TST.temporaryMetadata.delete('opening');
    tab.$TST.temporaryMetadata.set('openedCompletely', true);
  }
  else {
    tab.$TST.temporaryMetadata.set('opening', true);
    tab.$TST.temporaryMetadata.delete('openedCompletely');
    tab.$TST.opened = new Promise((resolve, reject) => {
      tab.$TST.opening = false;
      const resolvers = mOpenedResolvers.get(tab.id) || new Set();
      resolvers.add({ resolve, reject });
      mOpenedResolvers.set(tab.id, resolvers);
    }).then(() => {
      tab.$TST.temporaryMetadata.set('openedCompletely', true);
    });
  }

  return tab;
};

Tab.import = tab => {
  const existingTab = Tab.get(tab.id);
  if (!existingTab) {
    return Tab.init(tab);
  }
  existingTab.$TST.apply(tab);
  return existingTab;
};


//===================================================================
// get single tab
//===================================================================

// Note that this function can return null if it is the first tab of
// a new window opened by the "move tab to new window" command.
Tab.getActiveTab = windowId => {
  return TabsStore.ensureLivingTab(TabsStore.activeTabInWindow.get(windowId));
};

Tab.getFirstTab = windowId => {
  return TabsStore.query({
    windowId,
    tabs:    TabsStore.livingTabsInWindow.get(windowId),
    living:  true,
    ordered: true
  });
};

Tab.getLastTab = windowId => {
  return TabsStore.query({
    windowId,
    tabs:   TabsStore.livingTabsInWindow.get(windowId),
    living: true,
    last:   true
  });
};

Tab.getFirstVisibleTab = windowId => { // visible, not-collapsed, not-hidden
  return TabsStore.query({
    windowId,
    tabs:    TabsStore.visibleTabsInWindow.get(windowId),
    visible: true,
    ordered: true
  });
};

Tab.getLastVisibleTab = windowId => { // visible, not-collapsed, not-hidden
  return TabsStore.query({
    windowId,
    tabs:    TabsStore.visibleTabsInWindow.get(windowId),
    visible: true,
    last:    true,
  });
};

Tab.getLastOpenedTab = windowId => {
  const tabs = Tab.getTabs(windowId);
  return tabs.length > 0 ?
    tabs.sort((a, b) => b.id - a.id)[0] :
    null ;
};

Tab.getLastPinnedTab = windowId => { // visible, pinned
  return TabsStore.query({
    windowId,
    tabs:    TabsStore.pinnedTabsInWindow.get(windowId),
    living:  true,
    ordered: true,
    last:    true
  });
};

Tab.getFirstUnpinnedTab = windowId => { // not-pinned
  return TabsStore.query({
    windowId,
    tabs:    TabsStore.unpinnedTabsInWindow.get(windowId),
    ordered: true
  });
};

Tab.getLastUnpinnedTab = windowId => { // not-pinned
  return TabsStore.query({
    windowId,
    tabs:    TabsStore.unpinnedTabsInWindow.get(windowId),
    ordered: true,
    last:    true
  });
};

Tab.getFirstNormalTab = windowId => { // visible, not-collapsed, not-pinned
  return TabsStore.query({
    windowId,
    tabs:    TabsStore.unpinnedTabsInWindow.get(windowId),
    normal:  true,
    ordered: true
  });
};

Tab.getGroupTabForOpener = opener => {
  if (!opener)
    return null;
  TabsStore.assertValidTab(opener);
  const groupTab = TabsStore.query({
    windowId:   opener.windowId,
    tabs:       TabsStore.groupTabsInWindow.get(opener.windowId),
    living:     true,
    attributes: [
      Constants.kCURRENT_URI,
      new RegExp(`openerTabId=${opener.$TST.uniqueId.id}($|[#&])`)
    ]
  });
  if (!groupTab ||
      groupTab == opener ||
      groupTab.pinned == opener.pinned)
    return null;
  return groupTab;
};

Tab.getOpenerFromGroupTab = groupTab => {
  if (!groupTab.$TST.isGroupTab)
    return null;
  TabsStore.assertValidTab(groupTab);
  const openerTabId = (new URL(groupTab.url)).searchParams.get('openerTabId');
  const openerTab = openerTabId && Tab.getByUniqueId(openerTabId);
  if (!openerTab ||
      openerTab == groupTab ||
      openerTab.pinned == groupTab.pinned)
    return null;
  return openerTab;
};

Tab.getSubstanceFromAliasGroupTab = groupTab => {
  if (!groupTab.$TST.isGroupTab)
    return null;
  TabsStore.assertValidTab(groupTab);
  const aliasTabId = (new URL(groupTab.url)).searchParams.get('aliasTabId');
  const aliasTab = aliasTabId && Tab.getByUniqueId(aliasTabId);
  if (!aliasTab ||
      aliasTab == groupTab ||
      aliasTab.pinned == groupTab.pinned)
    return null;
  return aliasTab;
};


//===================================================================
// grap tabs
//===================================================================

Tab.getActiveTabs = () => {
  return Array.from(TabsStore.activeTabInWindow.values(), TabsStore.ensureLivingTab);
};

Tab.getAllTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:     TabsStore.getTabsMap(TabsStore.livingTabsInWindow, windowId),
    living:   true,
    ordered:  true,
    ...options
  });
};

Tab.getTabAt = (windowId, index) => {
  const tabs    = TabsStore.livingTabsInWindow.get(windowId);
  const allTabs = TabsStore.windows.get(windowId).tabs;
  return TabsStore.query({
    windowId,
    tabs,
    living:       true,
    fromIndex:    Math.max(0, index - (allTabs.size - tabs.size)),
    logicalIndex: index,
    first:        true
  });
};

Tab.getTabs = (windowId = null, options = {}) => { // only visible, including collapsed and pinned
  return TabsStore.queryAll({
    windowId,
    tabs:         TabsStore.getTabsMap(TabsStore.controllableTabsInWindow, windowId),
    controllable: true,
    ordered:      true,
    ...options
  });
};

Tab.getTabsBetween = (begin, end) => {
  if (!begin || !TabsStore.ensureLivingTab(begin) ||
      !end || !TabsStore.ensureLivingTab(end))
    throw new Error('getTabsBetween requires valid two tabs');
  if (begin.windowId != end.windowId)
    throw new Error('getTabsBetween requires two tabs in same window');

  if (begin == end)
    return [];
  if (begin.index > end.index)
    [begin, end] = [end, begin];
  return TabsStore.queryAll({
    windowId: begin.windowId,
    tabs:     TabsStore.getTabsMap(TabsStore.controllableTabsInWindow, begin.windowId),
    id:       (id => id != begin.id && id != end.id),
    fromId:   begin.id,
    toId:     end.id
  });
};

Tab.getNormalTabs = (windowId = null, options = {}) => { // only visible, including collapsed, not pinned
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.unpinnedTabsInWindow, windowId),
    normal:  true,
    ordered: true,
    ...options
  });
};

Tab.getVisibleTabs = (windowId = null, options = {}) => { // visible, not-collapsed, not-hidden
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.visibleTabsInWindow, windowId),
    living:  true,
    ordered: true,
    ...options
  });
};

Tab.getHiddenTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.livingTabsInWindow, windowId),
    living:  true,
    ordered: true,
    hidden:  true,
    ...options
  });
};

Tab.getPinnedTabs = (windowId = null, options = {}) => { // visible, pinned
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.pinnedTabsInWindow, windowId),
    living:  true,
    ordered: true,
    ...options
  });
};


Tab.getUnpinnedTabs = (windowId = null, options = {}) => { // visible, not pinned
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.unpinnedTabsInWindow, windowId),
    living:  true,
    ordered: true,
    ...options
  });
};

Tab.getRootTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:         TabsStore.getTabsMap(TabsStore.rootTabsInWindow, windowId),
    controllable: true,
    ordered:      true,
    ...options
  });
};

Tab.getLastRootTab = (windowId, options = {}) => {
  const tabs = this.getRootTabs(windowId, options);
  return tabs[tabs.length - 1];
};

Tab.collectRootTabs = tabs => {
  return tabs.filter(tab => {
    if (!TabsStore.ensureLivingTab(tab))
      return false;
    const parent = tab.$TST.parent;
    return !parent || !tabs.includes(parent);
  });
};

Tab.getSubtreeCollapsedTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:     TabsStore.getTabsMap(TabsStore.subtreeCollapsableTabsInWindow, windowId),
    living:   true,
    hidden:   false,
    ordered:  true,
    ...options
  });
};

Tab.getGroupTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.groupTabsInWindow, windowId),
    living:  true,
    ordered: true,
    ...options
  });
};

Tab.getLoadingTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.loadingTabsInWindow, windowId),
    living:  true,
    ordered: true,
    ...options
  });
};

Tab.getDraggingTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.draggingTabsInWindow, windowId),
    living:  true,
    ordered: true,
    ...options
  });
};

Tab.getRemovingTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.removingTabsInWindow, windowId),
    ordered: true,
    ...options
  });
};

Tab.getDuplicatingTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.duplicatingTabsInWindow, windowId),
    living:  true,
    ordered: true,
    ...options
  });
};

Tab.getHighlightedTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.highlightedTabsInWindow, windowId),
    living:  true,
    ordered: true,
    ...options
  });
};

Tab.getSelectedTabs = (windowId = null, options = {}) => {
  const tabs = TabsStore.getTabsMap(TabsStore.selectedTabsInWindow, windowId);
  const selectedTabs = TabsStore.queryAll({
    windowId,
    tabs,
    living:  true,
    ordered: true,
    ...options
  });
  const highlightedTabs = TabsStore.getTabsMap(TabsStore.highlightedTabsInWindow, windowId);
  if (!highlightedTabs ||
      highlightedTabs.size < 2)
    return selectedTabs;

  if (options.iterator)
    return (function* () {
      const alreadyReturnedTabs = new Set();
      for (const tab of selectedTabs) {
        yield tab;
        alreadyReturnedTabs.add(tab);
      }
      for (const tab of highlightedTabs.values()) {
        if (!alreadyReturnedTabs.has(tab))
          yield tab;
      }
    })();
  else
    return Tab.sort(Array.from(new Set([...selectedTabs, ...Array.from(highlightedTabs.values())])));
};

Tab.getVirtualScrollRenderableTabs = (windowId = null) => {
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.virtualScrollRenderableTabsInWindow, windowId),
    skipMatching: true,
    ordered: true,
  });
};

Tab.getNeedToBeSynchronizedTabs = (windowId = null, options = {}) => {
  return TabsStore.queryAll({
    windowId,
    tabs:    TabsStore.getTabsMap(TabsStore.unsynchronizedTabsInWindow, windowId),
    visible: true,
    ...options
  });
};

Tab.hasNeedToBeSynchronizedTab = windowId => {
  return !!TabsStore.query({
    windowId,
    tabs:     TabsStore.getTabsMap(TabsStore.unsynchronizedTabsInWindow, windowId),
    visible:  true
  });
};

Tab.hasLoadingTab = windowId => {
  return !!TabsStore.query({
    windowId,
    tabs:     TabsStore.getTabsMap(TabsStore.loadingTabsInWindow, windowId),
    visible:  true
  });
};

Tab.hasDuplicatedTabs = (windowId, options = {}) => {
  const tabs = TabsStore.queryAll({
    windowId,
    tabs:   TabsStore.getTabsMap(TabsStore.livingTabsInWindow, windowId),
    living: true,
    ...options,
    iterator: true
  });
  const tabKeys = new Set();
  for (const tab of tabs) {
    const key = `${tab.cookieStoreId}\n${tab.url}`;
    if (tabKeys.has(key))
      return true;
    tabKeys.add(key);
  }
  return false;
};

Tab.hasMultipleTabs = (windowId, options = {}) => {
  const tabs = TabsStore.queryAll({
    windowId,
    tabs:   TabsStore.getTabsMap(TabsStore.livingTabsInWindow, windowId),
    living: true,
    ...options,
    iterator: true
  });
  let count = 0;
  // eslint-disable-next-line no-unused-vars
  for (const tab of tabs) {
    count++;
    if (count > 1)
      return true;
  }
  return false;
};

// "Recycled tab" is an existing but reused tab for session restoration.
Tab.getRecycledTabs = (windowId = null, options = {}) => {
  const userNewTabUrls = configs.guessNewOrphanTabAsOpenedByNewTabCommandUrl.split('|').map(part => sanitizeForRegExpSource(part.trim())).join('|');
  return TabsStore.queryAll({
    windowId,
    tabs:       TabsStore.getTabsMap(TabsStore.livingTabsInWindow, windowId),
    living:     true,
    states:     [Constants.kTAB_STATE_RESTORED, false],
    attributes: [Constants.kCURRENT_URI, new RegExp(`^(|${userNewTabUrls}|about:newtab|about:blank|about:privatebrowsing)$`)],
    ...options
  });
};


//===================================================================
// general tab events
//===================================================================

Tab.onGroupTabDetected = new EventListenerManager();
Tab.onLabelUpdated     = new EventListenerManager();
Tab.onStateChanged     = new EventListenerManager();
Tab.onPinned           = new EventListenerManager();
Tab.onUnpinned         = new EventListenerManager();
Tab.onHidden           = new EventListenerManager();
Tab.onShown            = new EventListenerManager();
Tab.onTabInternallyMoved     = new EventListenerManager();
Tab.onCollapsedStateChanged  = new EventListenerManager();
Tab.onMutedStateChanged      = new EventListenerManager();
Tab.onAutoplayBlockedStateChanged = new EventListenerManager();
Tab.onSharingStateChanged    = new EventListenerManager();

Tab.onBeforeCreate     = new EventListenerManager();
Tab.onCreating         = new EventListenerManager();
Tab.onCreated          = new EventListenerManager();
Tab.onRemoving         = new EventListenerManager();
Tab.onRemoved          = new EventListenerManager();
Tab.onMoving           = new EventListenerManager();
Tab.onMoved            = new EventListenerManager();
Tab.onActivating       = new EventListenerManager();
Tab.onActivated        = new EventListenerManager();
Tab.onUpdated          = new EventListenerManager();
Tab.onRestored         = new EventListenerManager();
Tab.onWindowRestoring  = new EventListenerManager();
Tab.onAttached         = new EventListenerManager();
Tab.onDetached         = new EventListenerManager();

Tab.onMultipleTabsRemoving = new EventListenerManager();
Tab.onMultipleTabsRemoved  = new EventListenerManager();
Tab.onChangeMultipleTabsRestorability = new EventListenerManager();


//===================================================================
// utilities
//===================================================================

Tab.bufferedTooltipTextChanges = new Map();
Tab.broadcastTooltipText = tabs => {
  if (!Constants.IS_BACKGROUND ||
      !Tab.broadcastTooltipText.enabled)
    return;

  if (!Array.isArray(tabs))
    tabs = [tabs];

  if (tabs.length == 0)
    return;

  for (const tab of tabs) {
    Tab.bufferedTooltipTextChanges.set(tab.id, {
      windowId: tab.windowId,
      tabId:    tab.id,
      high:     tab.$TST.getHighPriorityTooltipText(),
      low:      tab.$TST.getLowPriorityTooltipText(),
    });
  }

  const triedAt = `${Date.now()}-${parseInt(Math.random() * 65000)}`;
  Tab.broadcastTooltipText.triedAt = triedAt;
  (Constants.IS_BACKGROUND ?
    setTimeout : // because window.requestAnimationFrame is decelerate for an invisible document.
    window.requestAnimationFrame)(() => {
    if (Tab.broadcastTooltipText.triedAt != triedAt)
      return;

    // Let's flush buffered changes!
    const messageForWindows = new Map();
    for (const change of Tab.bufferedTooltipTextChanges.values()) {
      const message = messageForWindows.get(change.windowId) || {
        type:     Constants.kCOMMAND_BROADCAST_TAB_TOOLTIP_TEXT,
        windowId: change.windowId,
        tabIds:   [],
        changes:  [],
      };
      message.tabIds.push(change.tabId);
      message.changes.push(change);
    }
    for (const message of messageForWindows) {
      SidebarConnection.sendMessage(message);
    }
    Tab.bufferedTooltipTextChanges.clear();
  }, 0);
};
Tab.broadcastTooltipText.enabled = false;

Tab.bufferedStatesChanges = new Map();
Tab.broadcastState = (tabs, { add, remove } = {}) => {
  if (!Constants.IS_BACKGROUND ||
      !Tab.broadcastState.enabled)
    return;

  if (!Array.isArray(tabs))
    tabs = [tabs];

  if (tabs.length == 0)
    return;

  for (const tab of tabs) {
    const message = Tab.bufferedStatesChanges.get(tab.id) || {
      windowId: tab.windowId,
      tabId:    tab.id,
      add:      new Set(),
      remove:   new Set(),
    };
    if (add)
      for (const state of add) {
        message.add.add(state);
        message.remove.delete(state);
      }
    if (remove)
      for (const state of remove) {
        message.add.delete(state);
        message.remove.add(state);
      }

    Tab.bufferedStatesChanges.set(tab.id, message);
  }

  const triedAt = `${Date.now()}-${parseInt(Math.random() * 65000)}`;
  Tab.broadcastState.triedAt = triedAt;
  (Constants.IS_BACKGROUND ?
    setTimeout : // because window.requestAnimationFrame is decelerate for an invisible document.
    window.requestAnimationFrame)(() => {
    if (Tab.broadcastState.triedAt != triedAt)
      return;

    // Let's flush buffered changes!

    // Unify buffered changes only if same type changes are consecutive.
    // Otherwise the order of changes would be mixed and things may become broken.
    const unifiedMessages = [];
    let lastKey;
    let unifiedMessage = null;
    for (const message of Tab.bufferedStatesChanges.values()) {
      const key = `${message.windowId}/add:${[...message.add]}/remove:${[...message.remove]}`;
      if (key != lastKey) {
        if (unifiedMessage)
          unifiedMessages.push(unifiedMessage);
        unifiedMessage = null;
      }
      lastKey = key;
      unifiedMessage = unifiedMessage || {
        type:     Constants.kCOMMAND_BROADCAST_TAB_STATE,
        windowId: message.windowId,
        tabIds:   new Set(),
        add:      message.add,
        remove:   message.remove,
      };
      unifiedMessage.tabIds.add(message.tabId);
    }
    if (unifiedMessage)
      unifiedMessages.push(unifiedMessage);
    Tab.bufferedStatesChanges.clear();

    // SidebarConnection.sendMessage() has its own bulk-send mechanism,
    // so we don't need to bundle them like an array.
    for (const message of unifiedMessages) {
      SidebarConnection.sendMessage({
        type:     Constants.kCOMMAND_BROADCAST_TAB_STATE,
        windowId: message.windowId,
        tabIds:   [...message.tabIds],
        add:      [...message.add],
        remove:   [...message.remove],
      });
    }
  }, 0);
};
Tab.broadcastState.enabled = false;

Tab.getOtherTabs = (windowId, ignoreTabs, options = {}) => {
  const query = {
    windowId: windowId,
    tabs:     TabsStore.livingTabsInWindow.get(windowId),
    ordered:  true
  };
  if (Array.isArray(ignoreTabs) &&
      ignoreTabs.length > 0)
    query['!id'] = ignoreTabs.map(tab => tab.id);
  return TabsStore.queryAll({ ...query, ...options });
};

function getTabIndex(tab, { ignoreTabs } = {}) {
  if (!TabsStore.ensureLivingTab(tab))
    return -1;
  TabsStore.assertValidTab(tab);
  return Tab.getOtherTabs(tab.windowId, ignoreTabs).indexOf(tab);
}

Tab.calculateNewTabIndex = ({ insertAfter, insertBefore, ignoreTabs } = {}) => {
  // We need to calculate new index based on "insertAfter" at first, to avoid
  // placing of the new tab after hidden tabs (too far from the location it
  // should be.)
  if (insertAfter)
    return getTabIndex(insertAfter, { ignoreTabs }) + 1;
  if (insertBefore)
    return getTabIndex(insertBefore, { ignoreTabs });
  return -1;
};

Tab.doAndGetNewTabs = async (asyncTask, windowId) => {
  const tabsQueryOptions = {
    windowType: 'normal'
  };
  if (windowId) {
    tabsQueryOptions.windowId = windowId;
  }
  const beforeTabs = await browser.tabs.query(tabsQueryOptions).catch(ApiTabs.createErrorHandler());
  const beforeIds  = mapAndFilterUniq(beforeTabs, tab => tab.id, { set: true });
  await asyncTask();
  const afterTabs = await browser.tabs.query(tabsQueryOptions).catch(ApiTabs.createErrorHandler());
  const addedTabs = mapAndFilter(afterTabs,
                                 tab => !beforeIds.has(tab.id) && Tab.get(tab.id) || undefined);
  return addedTabs;
};

Tab.compare = (a, b) => a.index - b.index;

Tab.sort = tabs => tabs.length == 0 ? tabs : tabs.sort(Tab.compare);

Tab.uniqTabsAndDescendantsSet = tabs => {
  if (!Array.isArray(tabs))
    tabs = [tabs];
  return Array.from(new Set(tabs.map(tab => [tab].concat(tab.$TST.descendants)).flat())).sort(Tab.compare);
}

Tab.dumpAll = windowId => {
  if (!configs.debug)
    return;
  let output = 'dumpAllTabs';
  for (const tab of Tab.getAllTabs(windowId, {iterator: true })) {
    output += '\n' + toLines([...tab.$TST.ancestors.reverse(), tab],
                             tab => `${tab.id}${tab.pinned ? ' [pinned]' : ''}`,
                             ' => ');
  }
  log(output);
};


// key = addon ID
// value = Set of states
Tab.autoStickyStates = new Map();

Tab.registerAutoStickyState = (providerId, statesToAdd) => {
  if (!statesToAdd) {
    statesToAdd = providerId;
    providerId = browser.runtime.id;
  }
  const states = Tab.autoStickyStates.get(providerId) || new Set();
  if (!Array.isArray(statesToAdd))
    statesToAdd = [statesToAdd];
  for (const state of statesToAdd) {
    states.add(state)
  }
  if (states.size == 0)
    return;

  Tab.autoStickyStates.set(providerId, states);

  if (Constants.IS_BACKGROUND) {
    SidebarConnection.sendMessage({
      type: Constants.kCOMMAND_BROADCAST_TAB_AUTO_STICKY_STATE,
      providerId,
      add:  [...statesToAdd],
    });
  }
};

Tab.unregisterAutoStickyState = (providerId, statesToRemove) => {
  if (!statesToRemove) {
    statesToRemove = providerId;
    providerId = browser.runtime.id;
  }
  const states = Tab.autoStickyStates.get(providerId);
  if (!states)
    return;
  if (!Array.isArray(statesToRemove))
    statesToRemove = [statesToRemove];
  for (const state of statesToRemove) {
    states.delete(state)
  }
  if (states.size > 0)
    Tab.autoStickyStates.set(providerId, states);
  else
    Tab.autoStickyStates.delete(providerId);

  if (Constants.IS_BACKGROUND) {
    SidebarConnection.sendMessage({
      type:   Constants.kCOMMAND_BROADCAST_TAB_AUTO_STICKY_STATE,
      providerId,
      remove: [...statesToRemove],
    });
  }
};
