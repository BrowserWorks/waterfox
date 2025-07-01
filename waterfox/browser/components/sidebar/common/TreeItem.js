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
  sanitizeForHTMLText,
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
  internalLogger('common/TreeItem', ...args);
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

export class TreeItem {
  static TYPE_TAB   = 'tab';
  static TYPE_GROUP = 'group';

  static onElementBound = new EventListenerManager();

  // The list of properties which should be ignored when synchronization from the
  // background to sidebars.
  static UNSYNCHRONIZABLE_PROPERTIES = new Set([
    'id',
    // Ignore "index" on synchronization, because it maybe wrong for the sidebar.
    // Index of tabs are managed and fixed by other sections like handling of
    // "kCOMMAND_NOTIFY_TAB_CREATING", Window.prototype.trackTab, and others.
    // See also: https://github.com/piroor/treestyletab/issues/2119
    'index',
    'reindexedBy'
  ]);

  // key = addon ID
  // value = Set of states
  static autoStickyStates = new Map();
  static allAutoStickyStates = new Set();

  constructor(raw) {
    raw.$TST = this;
    this.raw = raw;
    this.id  = raw.id;

    raw.type = this.type || 'unknown';

    this.trackedAt = Date.now();
    this.opened = Promise.resolve(true);

    // We should not change the shape of the object, so temporary data should be held in this map.
    this.temporaryMetadata = new Map();

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
    this.promisedUniqueId = Promise.resolve(null);
  }

  destroy() {
    if (this.element &&
        this.element.parentNode)
      this.element.parentNode.removeChild(this.element);
    this.unbindElement();
    // this.raw.$TST = null; // raw.$TST is used by destruction processes.
    this.raw = null;
    this.promisedUniqueId = null;
    this.uniqueId = null;
    this.destroyed = true;
  }

  clear() {
    this.states.clear();
    this.attributes = {};
  }

  bindElement(element) {
    element.$TST   = this;
    element.apiRaw = this.raw;
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
      if (!this.raw) // unbound while waiting!
        return;
      TreeItem.onElementBound.dispatch(this.raw);
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
      this.element.apiRaw = null;
    }
    this.element = null;
    this.classList = null;
  }

  startMoving() {
    return Promise.resolve();
  }

  updateUniqueId(_options = {}) {
    return Promise.resolve(null);
  }

  get type() {
    return null;
  }

  get renderingId() {
    return `${this.type}:${this.id}`;
  }

  //===================================================================
  // status of tree item
  //===================================================================

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

  get canBecomeSticky() {
    if (this.collapsed ||
        this.states.has(Constants.kTAB_STATE_EXPANDING) ||
        this.states.has(Constants.kTAB_STATE_COLLAPSING))
      return false;

    if (this.sticky)
      return true;

    if ((new Set([...this.states, ...TreeItem.allAutoStickyStates])).size < this.states.size + TreeItem.allAutoStickyStates.size) {
      return true;
    }

    return false;
  }

  get promisedPossibleOpenerBookmarks() {
    return Promise.resolve(null);
  }

  get defaultTooltipText() {
    return this.raw.title;
  }

  get tooltipTextWithDescendants() {
    const tooltip = [`* ${this.defaultTooltipText}`];
    for (const child of this.children) {
      if (!child)
        continue;
      tooltip.push(child.$TST.tooltipTextWithDescendants.replace(/^/gm, '  '));
    }
    return tooltip.join('\n');
  }

  get tooltipHtml() {
    return `<span class="title-line"
                 ><span class="title"
                       >${sanitizeForHTMLText(this.raw.title)}</span></span>`;
  }

  get tooltipHtmlWithDescendants() {
    return `<ul>${this.generateTooltipHtmlWithDescendants()}</ul>`;
  }
  generateTooltipHtmlWithDescendants() {
    let tooltip = `<li>${this.tooltipHtml}`;
    const children = [];
    for (const child of this.children) {
      if (!child)
        continue;
      children.push(child.$TST.generateTooltipHtmlWithDescendants());
    }
    if (children.length > 0)
      tooltip += `<ul>${children.join('')}</ul>`;
    return `${tooltip}</li>`;
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
  }

  unregisterTooltipText(ownerId) {
    this.highPriorityTooltipTexts.delete(ownerId);
    this.lowPriorityTooltipTexts.delete(ownerId);
  }

  get highPriorityTooltipText() {
    if (this.highPriorityTooltipTexts.size == 0)
      return null;
    return [...this.highPriorityTooltipTexts.values()][this.highPriorityTooltipTexts.size - 1];
  }

  get lowPriorityTooltipText() {
    if (this.lowPriorityTooltipTexts.size == 0)
      return null;
    return [...this.lowPriorityTooltipTexts.values()][this.lowPriorityTooltipTexts.size - 1];
  }

  //===================================================================
  // neighbor tabs
  //===================================================================

  get nextTab() { return null; }
  get previousTab() { return null; }
  get unsafeNextTab() { return null; }
  get unsafePreviousTab() { return null; }
  get nearestCompletelyOpenedNormalFollowingTab() { return null; }
  get nearestCompletelyOpenedNormalPrecedingTab() { return null; }
  get nearestVisibleFollowingTab() { return null; }
  get unsafeNearestExpandedFollowingTab() { return null; }
  get nearestVisiblePrecedingTab() { return null; }
  get unsafeNearestExpandedPrecedingTab() { return null; }
  get nearestLoadedTab() { return null; }
  get nearestLoadedTabInTree() { return null; }
  get nearestLoadedSiblingTab() { return null; }
  get nearestSameTypeRenderedTab() { return null; }

  //===================================================================
  // tree relations
  //===================================================================

  get parent() { return null; }
  get hasParent() { return false; }

  get ancestorIds() { return []; }
  get ancestors() { return []; }

  get level() { return 0; }

  get rootTab() { return null; }

  get topmostSubtreeCollapsedAncestor() { return null; }

  get nearestVisibleAncestorOrSelf() { return null; }

  get nearestFollowingRootTab() { return null; }

  get nearestFollowingForeignerTab() {
    const base = this.lastDescendant || this.raw;
    return base?.$TST.nextTab;
  }

  get unsafeNearestFollowingForeignerTab() {
    const base = this.lastDescendant || this.raw;
    return base?.$TST.unsafeNextTab;
  }

  get children() { return []; }

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

  get hasChild() { return false; }

  get descendants() { return []; }

  get lastDescendant() {
    const descendants = this.descendants;
    return descendants.length ? descendants[descendants.length-1] : null ;
  }

  get nextSiblingTab() { return null; }

  get nextVisibleSiblingTab() {
    const nextSibling = this.nextSiblingTab;
    return nextSibling && !nextSibling.$TST.collapsed && !nextSibling.hidden && nextSibling;
  }

  get previousSiblingTab() { return null; }

  get needToBeGroupedSiblings() { return []; }

  //===================================================================
  // other relations
  //===================================================================

  findSuccessor(_options = {}) {
    return null;
  }

  // if all items are aldeardy placed at there, we don't need to move them.
  isAllPlacedBeforeSelf(items) {
    if (!this.raw ||
        items.length == 0)
      return true;
    let nextItem = this.raw;
    if (items[items.length - 1] == nextItem)
      nextItem = nextItem.$TST.unsafeNextTab;
    if (!nextItem && !items[items.length - 1].$TST.unsafeNextTab)
      return true;

    items = Array.from(items);
    let previousItem = items.shift();
    for (const item of items) {
      if (item.$TST.unsafePreviousTab != previousItem)
        return false;
      previousItem = item;
    }
    return !nextItem ||
           !previousItem ||
           previousItem.$TST.unsafeNextTab == nextItem;
  }

  isAllPlacedAfterSelf(items) {
    if (!this.raw ||
        items.length == 0)
      return true;
    let previousItem = this.raw;
    if (items[0] == previousItem)
      previousItem = previousItem.$TST.unsafePreviousTab;
    if (!previousItem && !items[0].$TST.unsafePreviousTab)
      return true;

    items = Array.from(items).reverse();
    let nextItem = items.shift();
    for (const item of items) {
      if (item.$TST.unsafeNextTab != nextItem)
        return false;
      nextItem = item;
    }
    return !previousItem ||
           !nextItem ||
           nextItem.$TST.unsafePreviousTab == previousItem;
  }

  detach() {}

  //===================================================================
  // State
  //===================================================================

  async toggleState(state, condition, { permanently, toTab, broadcast } = {}) {
    if (condition)
      return this.addState(state, { permanently, toTab, broadcast });
    else
      return this.removeState(state, { permanently, toTab, broadcast });
  }

  async addState(state) {
    state = state && String(state) || undefined;
    if (!this.raw || !state)
      return;

    if (this.classList) {
      this.classList.add(state);
    }
    if (this.states) {
      this.states.add(state);
    }
  }

  async removeState(state) {
    state = state && String(state) || undefined;
    if (!this.raw || !state)
      return;

    if (this.classList) {
      this.classList.remove(state);
    }
    if (this.states) {
      this.states.delete(state);
    }
  }

  async getPermanentStates() {
    return Promise.resolve([]);
  }

  inheritSoundStateFromChildren() {}

  inheritSharingStateFromChildren() {}

  onNativeGroupModified() {}

  setAttribute(attribute, value) {
    if (this.element)
      this.element.setAttribute(attribute, value);
    this.attributes[attribute] = value;
  }

  getAttribute(attribute) {
    return this.attributes[attribute];
  }

  removeAttribute(attribute) {
    if (this.element)
      this.element.removeAttribute(attribute);
    delete this.attributes[attribute];
  }

  resolveOpened() {}
  rejectOpened() {}

  memorizeNeighbors(hint) {
    if (!this.raw) // already closed tab
      return;
    log(`memorizeNeighbors ${this.raw.id} as ${hint}`);
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
    if (!this.raw)
      return {};

    const sanitized = {
      ...this.raw,
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

  apply(exported) {
    this.raw.title = exported.title;
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

    let exportedTreeItem = configs.cacheAPITreeItems && light ? this.$exportedForAPI : null;
    if (!exportedTreeItem) {
      const children = await doProgressively(
        this.raw.$TST.children,
        child => child.$TST.exportForAPI({ addonId, light, isContextTab, interval, permissions, cache, cacheKey }),
        interval
      );

      const tabStates = this.raw.$TST.states;
      exportedTreeItem = {
        id:             this.raw.id,
        windowId:       this.raw.windowId,
        type:           this.type,
        states:         tabStates && tabStates.size > 0 &&Constants.kTAB_SAFE_STATES_ARRAY.filter(state => tabStates.has(state)) || [],
        indent:         parseInt(this.raw.$TST.getAttribute(Constants.kLEVEL) || 0),
        children,
        ancestorTabIds: this.raw.$TST.ancestorIds || [],
        bundledTabId:   this.raw.$TST.bundledTabId,
      };
      if (this.stuck)
        exportedTreeItem.states.push(Constants.kTAB_STATE_STUCK);
      if (configs.cacheAPITreeItems && light)
        this.$exportedForAPI = exportedTreeItem;
    }

    if (light)
      return exportedTreeItem;

    const fullExportedTreeItem = { ...exportedTreeItem };

    await this.exportFullTreeItemProperties(fullExportedTreeItem, { isContextTab, interval, permissions, cache });

    if (configs.cacheAPITreeItems)
      this.$exportedForAPIWithPermissions.set(permissionsKey, fullExportedTreeItem)
    return fullExportedTreeItem;
  }

  exportFullTreeItemProperties() {}

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


  //===================================================================
  // class methods
  //===================================================================

  static registerAutoStickyState(providerId, statesToAdd) {
    if (!statesToAdd) {
      statesToAdd = providerId;
      providerId = browser.runtime.id;
    }
    const states = TreeItem.autoStickyStates.get(providerId) || new Set();
    if (!Array.isArray(statesToAdd))
      statesToAdd = [statesToAdd];
    for (const state of statesToAdd) {
      states.add(state)
    }
    if (states.size == 0)
      return;

    TreeItem.autoStickyStates.set(providerId, states);
    for (const state of states) {
      TreeItem.allAutoStickyStates.add(state);
    }

    TreeItem.updateCanBecomeStickyTabsIndex(TabsStore.getCurrentWindowId());

    if (Constants.IS_BACKGROUND) {
      SidebarConnection.sendMessage({
        type: Constants.kCOMMAND_BROADCAST_TAB_AUTO_STICKY_STATE,
        providerId,
        add:  [...statesToAdd],
      });
    }
  }

  static unregisterAutoStickyState(providerId, statesToRemove) {
    if (!statesToRemove) {
      statesToRemove = providerId;
      providerId = browser.runtime.id;
    }
    const states = TreeItem.autoStickyStates.get(providerId);
    if (!states)
      return;
    if (!Array.isArray(statesToRemove))
      statesToRemove = [statesToRemove];
    for (const state of statesToRemove) {
      states.delete(state)
    }
    if (states.size > 0)
      TreeItem.autoStickyStates.set(providerId, states);
    else
      TreeItem.autoStickyStates.delete(providerId);

    TreeItem.allAutoStickyStates = new Set([
      ...TreeItem.autoStickyStates.values(),
    ].flat());

    TreeItem.updateCanBecomeStickyTabsIndex(TabsStore.getCurrentWindowId());

    if (Constants.IS_BACKGROUND) {
      SidebarConnection.sendMessage({
        type:   Constants.kCOMMAND_BROADCAST_TAB_AUTO_STICKY_STATE,
        providerId,
        remove: [...statesToRemove],
      });
    }
  }

  static async updateCanBecomeStickyTabsIndex(windowId) {
    const tabs = await (windowId ? browser.tabs.query({ windowId }) : browser.tabs.query({}));
    for (const tab of tabs) {
      const item = TreeItem.get(tab);
      if (!item) {
        continue;
      }
      if (item.$TST.canBecomeSticky)
        TabsStore.addCanBecomeStickyTab(item);
      else
        TabsStore.removeCanBecomeStickyTab(item);
    }
  }

  static uniqTabsAndDescendantsSet(tabs) {
    if (!Array.isArray(tabs))
      tabs = [tabs];
    return Array.from(new Set(tabs.map(tab => [tab].concat(tab.$TST.descendants)).flat())).sort(TreeItem.compare);
  }

  static compare(a, b) {
    const delta = a.index - b.index;
    if (delta == 0) {
      return (a.type == TreeItem.TYPE_GROUP || !!a.color) ? -1 : 1;
    }
    return delta;
  }

  static sort(tabs) {
    return tabs.length == 0 ? tabs : tabs.sort(TreeItem.compare);
  }
}


export class TabGroup extends TreeItem {
  constructor(raw) {
    super(raw);

    TabsStore.tabGroups.set(raw.id, raw);
    TabsStore.windows.get(raw.windowId)?.tabGroups.set(raw.id, raw);

    this.reindex();
  }

  destroy() {
    const win = TabsStore.windows.get(this.raw.windowId);
    if (win) {
      win.tabGroups.delete(this.id);
    }

    TabsStore.tabGroups.delete(this.id);

    super.destroy();
  }

  get type() {
    return TreeItem.TYPE_GROUP;
  }

  get group() {
    return this.raw;
  }

  get nearestVisibleAncestorOrSelf() {
    return this.raw;
  }

  get members() {
    return TabGroup.getMembers(this.raw.id);
  }

  get firstMember() {
    return TabGroup.getFirstMember(this.raw.id);
  }

  get lastMember() {
    return TabGroup.getLastMember(this.raw.id);
  }

  get children() {
    return this.members.filter(tab => !tab.$TST.parentId);
  }

  get hasChild() {
    return !!this.firstMember;
  }

  get descendants() {
    return this.members;
  }

  reindex(maybeFirstMember) {
    const firstMember = TabGroup.getFirstMember(this.raw.id) || maybeFirstMember;
    if (firstMember) {
      this.raw.index = firstMember.index;
    }
  }

  apply(exported) {
    super.apply(exported);
    this.raw.color = exported.color;
    this.raw.collapsed = exported.collapsed;
  }

  get createParams() {
    return {
      title:     this.raw.title,
      color:     this.raw.color,
      collapsed: this.raw.collapsed,
      windowId:  this.raw.windowId,
    };
  }


  //===================================================================
  // class methods
  //===================================================================

  static get(groupId) {
    return TabsStore.tabGroups.get(groupId);
  }

  static init(group) {
    if (group.$TST instanceof TabGroup) {
      return group;
    }
    if ('index' in group) {
      group.index = -1;
    }
    if ('incognito' in group) {
      group.incognito = false;
    }
    group.$TST = new TabGroup(group);
    return group;
  }

  static getMembers(groupId, options = {}) {
    const windowId = TabGroup.get(groupId)?.windowId || TabsStore.getCurrentWindowId();
    return TabsStore.queryAll({
      windowId,
      tabs:   TabsStore.getTabsMap(TabsStore.nativelyGroupedTabsInWindow, windowId),
      living: true,
      groupId,
      ordered: true,
      ...options
    });
  }

  static getFirstMember(groupId, options = {}) {
    const windowId = TabGroup.get(groupId)?.windowId || TabsStore.getCurrentWindowId();
    return TabsStore.query({
      windowId,
      tabs:   TabsStore.getTabsMap(TabsStore.nativelyGroupedTabsInWindow, windowId),
      living: true,
      groupId,
      ...options,
      ordered: true,
      first: true,
    });
  }

  static getLastMember(groupId, options = {}) {
    const windowId = TabGroup.get(groupId)?.windowId || TabsStore.getCurrentWindowId();
    return TabsStore.query({
      windowId,
      tabs:   TabsStore.getTabsMap(TabsStore.nativelyGroupedTabsInWindow, windowId),
      living: true,
      groupId,
      ...options,
      ordered: true,
      last: true,
    });
  }

  // https://searchfox.org/mozilla-central/rev/578d9c83f046d8c361ac6b98b297c27990d468fd/browser/components/tabbrowser/content/tabgroup-menu.js#25
  static COLORS = [
    'blue',
    'purple',
    'cyan',
    'orange',
    'yellow',
    'pink',
    'green',
    'gray',
    'red',
  ];

  static getUextUnusedColor(windowId = null) {
    if (!windowId) {
      windowId = TabsStore.getCurrentWindowId();
    }
    const unusedColors = new Set(TabGroup.COLORS);
    for (const group of TabsStore.windows.get(windowId).tabGroups.values()) {
      unusedColors.delete(group.color);
    }
    if (unusedColors.size > 0) {
      return [...unusedColors][0];
    }
    // all colors are used
    const index = Math.floor(Math.random() * TabGroup.COLORS.length);
    return TabGroup.COLORS[index];
  }
}


export class Tab extends TreeItem {
  //===================================================================
  // tab tracking events
  //===================================================================

  static onTracked      = new EventListenerManager();
  static onDestroyed    = new EventListenerManager();
  static onInitialized  = new EventListenerManager();

  //===================================================================
  // general tab events
  //===================================================================

  static onGroupTabDetected = new EventListenerManager();
  static onLabelUpdated     = new EventListenerManager();
  static onStateChanged     = new EventListenerManager();
  static onPinned           = new EventListenerManager();
  static onUnpinned         = new EventListenerManager();
  static onHidden           = new EventListenerManager();
  static onShown            = new EventListenerManager();
  static onTabInternallyMoved     = new EventListenerManager();
  static onCollapsedStateChanged  = new EventListenerManager();
  static onMutedStateChanged      = new EventListenerManager();
  static onAutoplayBlockedStateChanged = new EventListenerManager();
  static onSharingStateChanged    = new EventListenerManager();

  static onBeforeCreate     = new EventListenerManager();
  static onCreating         = new EventListenerManager();
  static onCreated          = new EventListenerManager();
  static onRemoving         = new EventListenerManager();
  static onRemoved          = new EventListenerManager();
  static onMoving           = new EventListenerManager();
  static onMoved            = new EventListenerManager();
  static onActivating       = new EventListenerManager();
  static onActivated        = new EventListenerManager();
  static onUpdated          = new EventListenerManager();
  static onRestored         = new EventListenerManager();
  static onWindowRestoring  = new EventListenerManager();
  static onAttached         = new EventListenerManager();
  static onDetached         = new EventListenerManager();

  static onMultipleTabsRemoving = new EventListenerManager();
  static onMultipleTabsRemoved  = new EventListenerManager();
  static onChangeMultipleTabsRestorability = new EventListenerManager();
  static onStateChanged  = new EventListenerManager();
  static onNativeGroupModified = new EventListenerManager();


  constructor(raw) {
    const alreadyTracked = Tab.get(raw.id);
    if (alreadyTracked)
      return alreadyTracked.$TST;

    log(`tab ${dumpTab(raw)} is newly tracked: `, raw);

    super(raw);

    this.promisedUniqueId = new Promise((resolve, _reject) => {
      this.onUniqueIdGenerated = resolve;
    });

    this.index = raw.index;

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

    this.opened = new Promise((resolve, reject) => {
      const resolvers = mOpenedResolvers.get(raw.id) || new Set();
      resolvers.add({ resolve, reject });
      mOpenedResolvers.set(raw.id, resolvers);
    });

    TabsStore.tabs.set(raw.id, raw);

    const win = TabsStore.windows.get(raw.windowId) || new Window(raw.windowId);
    win.trackTab(raw);

    // Don't update indexes here, instead Window.prototype.trackTab()
    // updates indexes because indexes are bound to windows.
    // TabsStore.updateIndexesForTab(raw);

    if (raw.active) {
      TabsStore.activeTabInWindow.set(raw.windowId, raw);
      TabsStore.activeTabsInWindow.get(raw.windowId).add(raw);
    }
    else {
      TabsStore.activeTabsInWindow.get(raw.windowId).delete(raw);
    }

    const incompletelyTrackedTabsPerWindow = mIncompletelyTrackedTabs.get(raw.windowId) || new Set();
    incompletelyTrackedTabsPerWindow.add(raw);
    mIncompletelyTrackedTabs.set(raw.windowId, incompletelyTrackedTabsPerWindow);
    this.promisedUniqueId.then(() => {
      incompletelyTrackedTabsPerWindow.delete(raw);
      Tab.onTracked.dispatch(raw);
    });

    // We should initialize private properties with blank value for better performance with a fixed shape.
    this.delayedInheritSoundStateFromChildren = null;
  }

  destroy() {
    mPromisedTrackedTabs.delete(`${this.id}:true`);
    mPromisedTrackedTabs.delete(`${this.id}:false`);

    Tab.onDestroyed.dispatch(this.raw);
    this.detach();

    if (this.temporaryMetadata.has('reservedCleanupNeedlessGroupTab')) {
      clearTimeout(this.temporaryMetadata.get('reservedCleanupNeedlessGroupTab'));
      this.temporaryMetadata.delete('reservedCleanupNeedlessGroupTab');
    }

    TabsStore.tabs.delete(this.id);
    if (this.uniqueId)
      TabsStore.tabsByUniqueId.delete(this.uniqueId.id);

    TabsStore.removeTabFromIndexes(this.raw);

    super.destroy();
  }

  clear() {
    super.clear();

    this.parentId = null;
    this.childIds = [];
    this.cachedAncestorIds   = null;
    this.cachedDescendantIds = null;
  }

  startMoving() {
    let onTabMoved;
    const promisedMoved = new Promise((resolve, _reject) => {
      onTabMoved = resolve;
    });
    const movingTabs = mMovingTabs.get(this.raw.windowId) || new Set();
    movingTabs.add(promisedMoved);
    mMovingTabs.set(this.raw.windowId, movingTabs);
    promisedMoved.then(() => {
      movingTabs.delete(promisedMoved);
    });
    return onTabMoved;
  }

  updateUniqueId(options = {}) {
    if (!this.raw) {
      const error = new Error('FATAL ERROR: updateUniqueId() is unavailable for an invalid tab');
      console.log(error);
      throw error;
    }
    if (options.id) {
      if (this.uniqueId.id)
        TabsStore.tabsByUniqueId.delete(this.uniqueId.id);
      this.uniqueId.id = options.id;
      TabsStore.tabsByUniqueId.set(options.id, this.raw);
      this.setAttribute(Constants.kPERSISTENT_ID, options.id);
      return Promise.resolve(this.uniqueId);
    }
    return UniqueId.request(this.raw, options).then(uniqueId => {
      if (uniqueId && TabsStore.ensureLivingItem(this.raw)) { // possibly removed from document while waiting
        this.uniqueId = uniqueId;
        TabsStore.tabsByUniqueId.set(uniqueId.id, this.raw);
        this.setAttribute(Constants.kPERSISTENT_ID, uniqueId.id);
      }
      return uniqueId || {};
    }).catch(error => {
      console.log(`FATAL ERROR: Failed to get unique id for a tab ${this.id}: `, error);
      return {};
    });
  }

  get type() {
    return TreeItem.TYPE_TAB;
  }

  get tab() {
    return this.raw;
  }

  get nativeTabGroup() {
    if (this.raw.groupId == -1) {
      return null;
    }
    return TabGroup.get(this.raw.groupId);
  }

  //===================================================================
  // status of tab
  //===================================================================

  get soundPlaying() {
    return !!(this.raw?.audible && !this.raw?.mutedInfo.muted);
  }
  get maybeSoundPlaying() {
    return (this.soundPlaying ||
            (this.states.has(Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER) &&
             this.hasChild));
  }

  get muted() {
    return !!(this.raw?.mutedInfo?.muted);
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
    return !!(this.raw?.sharingState?.camera);
  }
  get maybeSharingCamera() {
    return (this.sharingCamera ||
            (this.states.has(Constants.kTAB_STATE_HAS_SHARING_CAMERA_MEMBER) &&
             this.hasChild));
  }

  get sharingMicrophone() {
    return !!(this.raw?.sharingState?.microphone);
  }
  get maybeSharingMicrophone() {
    return (this.sharingMicrophone ||
            (this.states.has(Constants.kTAB_STATE_HAS_SHARING_MICROPHONE_MEMBER) &&
             this.hasChild));
  }

  get sharingScreen() {
    return !!(this.raw?.sharingState?.screen);
  }
  get maybeSharingScreen() {
    return (this.sharingScreen ||
            (this.states.has(Constants.kTAB_STATE_HAS_SHARING_SCREEN_MEMBER) &&
             this.hasChild));
  }

  get precedesPinnedTab() {
    const following = this.nearestVisibleFollowingTab;
    return following?.pinned;
  }

  get followsUnpinnedTab() {
    const preceding = this.nearestVisiblePrecedingTab;
    return preceding && !preceding.pinned;
  }

  get isNewTabCommandTab() {
    if (!this.raw ||
        !configs.guessNewOrphanTabAsOpenedByNewTabCommand)
      return false;

    if (this.raw.$isNewTabCommandTab)
      return true;

    // Firefox sets "New Tab" title to a new tab command tab, even if
    // "Blank Page" is chosen as the new tab page. So we can detect the case
    // safely here.
    // (confirmed on Firefox 124)
    if (isNewTabCommandTab(this.raw))
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
    if (this.raw.url == 'about:blank' &&
        this.raw.previousUrl != 'about:blank')
      return false;

    return false;
  }

  get isGroupTab() {
    return this.states.has(Constants.kTAB_STATE_GROUP_TAB) ||
           this.hasGroupTabURL;
  }

  get hasGroupTabURL() {
    return !!(this.raw?.url?.indexOf(Constants.kGROUP_TAB_URI) == 0);
  }

  get isTemporaryGroupTab() {
    if (!this.raw || !this.isGroupTab)
      return false;
    return (new URL(this.raw.url)).searchParams.get('temporary') == 'true';
  }

  get isTemporaryAggressiveGroupTab() {
    if (!this.raw || !this.isGroupTab)
      return false;
    return (new URL(this.raw.url)).searchParams.get('temporaryAggressive') == 'true';
  }

  get replacedParentGroupTabCount() {
    if (!this.raw || !this.isGroupTab)
      return 0;
    const count = parseInt((new URL(this.raw.url)).searchParams.get('replacedParentCount'));
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
      this.raw &&
      this.raw.cookieStoreId != prevTab.cookieStoreId &&
      this.raw.url == prevTab.url
    ) ? prevTab : null;
  }
  get $possiblePredecessorNextTab() {
    const nextTab = this.unsafeNextTab;
    return (
      nextTab &&
      this.raw &&
      this.raw.cookieStoreId != nextTab.cookieStoreId &&
      this.raw.url == nextTab.url
    ) ? nextTab : null;
  }
  get possibleSuccessorWithDifferentContainer() {
    const firstChild = this.firstChild;
    const nextTab = this.nextTab;
    const prevTab = this.previousTab;
    return (
      (firstChild &&
       firstChild.$TST.$possiblePredecessorPreviousTab == this.raw &&
       firstChild) ||
      (nextTab &&
       !nextTab.$TST.temporaryMetadata.has('openedCompletely') &&
       nextTab.$TST.$possiblePredecessorPreviousTab == this.raw &&
       nextTab) ||
      (prevTab &&
       !prevTab.$TST.temporaryMetadata.has('openedCompletely') &&
       prevTab.$TST.$possiblePredecessorNextTab == this.raw &&
       prevTab)
    );
  }

  get selected() {
    return this.states.has(Constants.kTAB_STATE_SELECTED) ||
             (this.hasOtherHighlighted && !!(this.raw?.highlighted));
  }

  get multiselected() {
    return this.raw &&
             this.selected &&
             (this.hasOtherHighlighted ||
              TabsStore.selectedTabsInWindow.get(this.raw.windowId).size > 1);
  }

  get hasOtherHighlighted() {
    const highlightedTabs = this.raw && TabsStore.highlightedTabsInWindow.get(this.raw.windowId);
    return !!(highlightedTabs && highlightedTabs.size > 1);
  }

  get canBecomeSticky() {
    if (this.raw?.pinned) {
      return false;
    }
    return super.canBecomeSticky;
  }

  get promisedPossibleOpenerBookmarks() {
    if ('possibleOpenerBookmarks' in this)
      return Promise.resolve(this.possibleOpenerBookmarks);
    return new Promise(async (resolve, _reject) => {
      if (!browser.bookmarks || !this.raw)
        return resolve(this.possibleOpenerBookmarks = []);
      // A new tab from bookmark is opened with a title: its URL without the scheme part.
      const url = this.raw.$possibleInitialUrl;
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
    const identity = this.raw?.cookieStoreId && ContextualIdentities.get(this.raw.cookieStoreId);
    return identity ? identity.name : null;
  }

  get defaultTooltipText() {
    return this.cookieStoreName ? `${this.raw.title} - ${this.cookieStoreName}` : super.defaultTooltipText;
  }

  get tooltipHtml() {
    return this.cookieStoreName ?
      `<span class="title-line"
            ><span class="title"
                  >${sanitizeForHTMLText(this.raw.title)}</span
            ><span class="cookieStoreName"
                  >${sanitizeForHTMLText(this.cookieStoreName)}</span></span>` :
      super.tooltipHtml;
  }

  registerTooltipText(ownerId, text, isHighPriority = false) {
    super.registerTooltipText(ownerId, text, isHighPriority);
    if (Constants.IS_BACKGROUND)
      Tab.broadcastTooltipText(this.raw);
  }

  unregisterTooltipText(ownerId) {
    super.unregisterTooltipText(ownerId);
    if (Constants.IS_BACKGROUND)
      Tab.broadcastTooltipText(this.raw);
  }

  //===================================================================
  // neighbor tabs
  //===================================================================

  get nextTab() {
    return this.raw && TabsStore.query({
      windowId: this.raw.windowId,
      tabs:     TabsStore.controllableTabsInWindow.get(this.raw.windowId),
      fromId:   this.id,
      controllable: true,
      index:    (index => index > this.raw.index)
    });
  }

  get previousTab() {
    return this.raw && TabsStore.query({
      windowId: this.raw.windowId,
      tabs:     TabsStore.controllableTabsInWindow.get(this.raw.windowId),
      fromId:   this.id,
      controllable: true,
      index:    (index => index < this.raw.index),
      last:     true
    });
  }

  get unsafeNextTab() {
    return this.raw && TabsStore.query({
      windowId: this.raw.windowId,
      fromId:   this.id,
      index:    (index => index > this.raw.index)
    });
  }

  get unsafePreviousTab() {
    return this.raw && TabsStore.query({
      windowId: this.raw.windowId,
      fromId:   this.id,
      index:    (index => index < this.raw.index),
      last:     true
    });
  }

  get nearestCompletelyOpenedNormalFollowingTab() { // including hidden tabs!
    return this.raw && TabsStore.query({
      windowId: this.raw.windowId,
      tabs:     TabsStore.unpinnedTabsInWindow.get(this.raw.windowId),
      states:   [Constants.kTAB_STATE_CREATING, false],
      fromId:   this.id,
      living:   true,
      index:    (index => index > this.raw.index)
    });
  }

  get nearestCompletelyOpenedNormalPrecedingTab() { // including hidden tabs!
    return this.raw && TabsStore.query({
      windowId: this.raw.windowId,
      tabs:     TabsStore.unpinnedTabsInWindow.get(this.raw.windowId),
      states:   [Constants.kTAB_STATE_CREATING, false],
      fromId:   this.id,
      living:   true,
      index:    (index => index < this.raw.index),
      last:     true
    });
  }

  get nearestVisibleFollowingTab() { // visible, not-collapsed
    return this.raw && TabsStore.query({
      windowId: this.raw.windowId,
      tabs:     TabsStore.visibleTabsInWindow.get(this.raw.windowId),
      fromId:   this.id,
      visible:  true,
      index:    (index => index > this.raw.index)
    });
  }

  get unsafeNearestExpandedFollowingTab() { // not-collapsed, possibly hidden
    return this.raw && TabsStore.query({
      windowId: this.raw.windowId,
      tabs:     TabsStore.expandedTabsInWindow.get(this.raw.windowId),
      fromId:   this.id,
      index:    (index => index > this.raw.index)
    });
  }

  get nearestVisiblePrecedingTab() { // visible, not-collapsed
    return this.raw && TabsStore.query({
      windowId: this.raw.windowId,
      tabs:     TabsStore.visibleTabsInWindow.get(this.raw.windowId),
      fromId:   this.id,
      visible:  true,
      index:    (index => index < this.raw.index),
      last:     true
    });
  }

  get unsafeNearestExpandedPrecedingTab() { // not-collapsed, possibly hidden
    return this.raw && TabsStore.query({
      windowId: this.raw.windowId,
      tabs:     TabsStore.expandedTabsInWindow.get(this.raw.windowId),
      fromId:   this.id,
      index:    (index => index < this.raw.index),
      last:     true
    });
  }

  get nearestLoadedTab() {
    const tabs = this.raw && TabsStore.visibleTabsInWindow.get(this.raw.windowId);
    return this.raw && (
      // nearest following tab
      TabsStore.query({
        windowId:  this.raw.windowId,
        tabs,
        discarded: false,
        fromId:    this.id,
        visible:   true,
        index:     (index => index > this.raw.index)
      }) ||
      // nearest preceding tab
      TabsStore.query({
        windowId:  this.raw.windowId,
        tabs,
        discarded: false,
        fromId:    this.id,
        visible:   true,
        index:     (index => index < this.raw.index),
        last:      true
      })
    );
  }

  get nearestLoadedTabInTree() {
    if (!this.raw)
      return null;
    let tab = this.raw;
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
          fromId:       (lastLastDescendant || this.raw).id,
          toId:         lastDescendant.id,
          visible:      true,
          index:        (index => index > this.raw.index)
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
    if (!parent || !this.raw)
      return null;
    const tabs = TabsStore.visibleTabsInWindow.get(this.raw.windowId);
    return (
      // nearest following tab
      TabsStore.query({
        windowId:  this.raw.windowId,
        tabs,
        childOf:   parent.id,
        discarded: false,
        fromId:    this.id,
        toId:      parent.$TST.lastChild.id,
        visible:   true,
        index:     (index => index > this.raw.index)
      }) ||
      // nearest preceding tab
      TabsStore.query({
        windowId:  this.raw.windowId,
        tabs,
        childOf:   parent.id,
        discarded: false,
        fromId:    this.id,
        toId:      parent.$TST.firstChild.id,
        visible:   true,
        index:     (index => index < this.raw.index),
        last:      true
      })
    );
  }

  get nearestSameTypeRenderedTab() {
    let tab = this.raw;
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
    if (!this.raw ||
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

      TabsStore.removeRootTab(this.raw);
    }
    else {
      this.removeAttribute(Constants.kPARENT);
      TabsStore.addRootTab(this.raw);
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
    return this.raw && this.parentId && TabsStore.ensureLivingItem(Tab.get(this.parentId));
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
                        id => TabsStore.ensureLivingItem(Tab.get(id)) || undefined);
  }

  updateAncestors() {
    const ancestors = [];
    this.cachedAncestorIds = [];
    if (!this.raw)
      return ancestors;
    let descendant = this.raw;
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
    return ancestors.length > 0 ? ancestors[ancestors.length-1] : this.raw ;
  }

  get topmostSubtreeCollapsedAncestor() {
    for (const ancestor of [...this.ancestors].reverse()) {
      if (ancestor.$TST.subtreeCollapsed)
        return ancestor;
    }
    return null;
  }

  get nearestVisibleAncestorOrSelf() {
    for (const ancestor of this.ancestors) {
      if (!ancestor.$TST.collapsed)
        return ancestor;
    }
    if (!this.collapsed)
      return this.raw;
    return null;
  }

  get nearestFollowingRootTab() {
    return TabsStore.query({
      windowId:  this.raw.windowId,
      tabs:      TabsStore.rootTabsInWindow.get(this.raw.windowId),
      fromId:    this.id,
      living:    true,
      index:     (index => index > this.raw.index),
      hasParent: false,
      first:     true
    });
  }

  set children(tabs) {
    if (!this.raw)
      return tabs;

    const ancestorIds = this.ancestorIds;
    const newChildIds = mapAndFilter(tabs, tab => {
      const id = typeof tab == 'number' ? tab : tab?.id;
      if (!ancestorIds.includes(id))
        return TabsStore.ensureLivingItem(Tab.get(id)) ? id : undefined;
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
        TabsStore.addSubtreeCollapsableTab(this.raw);
    }
    else {
      this.removeAttribute(Constants.kCHILDREN);
      TabsStore.removeSubtreeCollapsableTab(this.raw);
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
                        id => TabsStore.ensureLivingItem(Tab.get(id)) || undefined);
  }

  sortAndInvalidateChildren() {
    // Tab.get(tabId) calls into TabsStore.tabs.get(tabId), which is just a
    // Map. This is acceptable to repeat in order to avoid two array copies,
    // especially on larger tab sets.
    this.childIds.sort((a, b) => TreeItem.compare(Tab.get(a), Tab.get(b)));
    this.invalidateCachedDescendants();
  }

  get hasChild() {
    return this.childIds.length > 0;
  }

  get descendants() {
    if (!this.cachedDescendantIds)
      return this.updateDescendants();
    return mapAndFilter(this.cachedDescendantIds,
                        id => TabsStore.ensureLivingItem(Tab.get(id)) || undefined);
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

  get nextSiblingTab() {
    if (!this.raw)
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
        windowId:  this.raw.windowId,
        tabs:      TabsStore.rootTabsInWindow.get(this.raw.windowId),
        fromId:    this.id,
        living:    true,
        index:     (index => index > this.raw.index),
        hasParent: false,
        first:     true
      });
      // We should treat only pinned tab as the next sibling tab of a pinned
      // tab. For example, if the last pinned tab is closed, Firefox moves
      // focus to the first normal tab. But the previous pinned tab looks
      // natural on TST because pinned tabs are visually grouped.
      if (nextSibling &&
          nextSibling.pinned != this.raw.pinned)
        return null;
      return nextSibling;
    }
  }

  get previousSiblingTab() {
    if (!this.raw)
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
        windowId:  this.raw.windowId,
        tabs:      TabsStore.rootTabsInWindow.get(this.raw.windowId),
        fromId:    this.id,
        living:    true,
        index:     (index => index < this.raw.index),
        hasParent: false,
        last:      true
      });
    }
  }

  get needToBeGroupedSiblings() {
    if (!this.raw)
      return [];
    const openerTabUniqueId = this.getAttribute(Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID);
    if (!openerTabUniqueId)
      return [];
    return TabsStore.queryAll({
      windowId:   this.raw.windowId,
      tabs:       TabsStore.toBeGroupedTabsInWindow.get(this.raw.windowId),
      normal:     true,
      '!id':      this.id,
      attributes: [
        Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID, openerTabUniqueId,
        Constants.kPERSISTENT_ALREADY_GROUPED_FOR_PINNED_OPENER, ''
      ],
      ordered:    true
    });
  }

  get precedingCanBecomeStickyTabs() {
    return TabsStore.queryAll({
      windowId:   this.raw.windowId,
      tabs:       TabsStore.canBecomeStickyTabsInWindow.get(this.raw.windowId),
      normal:     true,
      '!id':      this.id,
      ordered:    true,
      fromId:     this.id,
      reversed:   true,
    });
  }

  get followingCanBecomeStickyTabs() {
    return TabsStore.queryAll({
      windowId:   this.raw.windowId,
      tabs:       TabsStore.canBecomeStickyTabsInWindow.get(this.raw.windowId),
      normal:     true,
      '!id':      this.id,
      ordered:    true,
      fromId:     this.id,
    });
  }

  //===================================================================
  // other relations
  //===================================================================

  get openerTab() {
    if (this.raw?.openerTabId == this.id)
      return null;

    if (!this.raw?.openerTabId)
      return Tab.getOpenerFromGroupTab(this.raw);

    return TabsStore.query({
      windowId: this.raw.windowId,
      tabs:     TabsStore.livingTabsInWindow.get(this.raw.windowId),
      id:       this.raw.openerTabId,
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
    if (!this.raw)
      return null;
    const substance = Tab.getSubstanceFromAliasGroupTab(this.raw);
    if (substance)
      return substance;
    if (this.raw.pinned)
      return Tab.getGroupTabForOpener(this.raw);
    if (this.isGroupTab)
      return Tab.getOpenerFromGroupTab(this.raw);
    return null;
  }

  get bundledTabId() {
    const tab = this.bundledTab;
    return tab ? tab.id : -1;
  }

  findSuccessor(options = {}) {
    if (!this.raw)
      return null;
    if (typeof options != 'object')
      options = {};
    const ignoredTabs = (options.ignoredTabs || []).slice(0);
    let foundTab = this.raw;
    do {
      ignoredTabs.push(foundTab);
      foundTab = foundTab.$TST.nextTab;
    } while (foundTab && ignoredTabs.includes(foundTab));
    if (!foundTab) {
      foundTab = this.raw;
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
    if (!this.raw)
      return relatedTab;
    const previousLastRelatedTabId = this.lastRelatedTabId;
    const win = TabsStore.windows.get(this.raw.windowId);
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
    if (!this.raw)
      return 0;
    const win = TabsStore.windows.get(this.raw.windowId);
    return win.lastRelatedTabs.get(this.id) || 0;
  }

  get previousLastRelatedTab() {
    if (!this.raw)
      return null;
    const win = TabsStore.windows.get(this.raw.windowId);
    return Tab.get(win.previousLastRelatedTabs.get(this.id)) || null;
  }

  detach() {
    this.parent   = null;
    this.children = [];
  }


  //===================================================================
  // State
  //===================================================================

  async addState(state, { permanently, toTab, broadcast } = {}) {
    state = state && String(state) || undefined;
    if (!this.raw || !state)
      return;

    const modified = this.states && !this.states.has(state);

    super.addState(state);

    switch (state) {
      case Constants.kTAB_STATE_HIGHLIGHTED:
        TabsStore.addHighlightedTab(this.raw);
        if (this.element)
          this.element.setAttribute('aria-selected', 'true');
        if (toTab)
          this.raw.highlighted = true;
        break;

      case Constants.kTAB_STATE_SELECTED:
        TabsStore.addSelectedTab(this.raw);
        break;

      case Constants.kTAB_STATE_COLLAPSED:
      case Constants.kTAB_STATE_SUBTREE_COLLAPSED:
        if (this.isSubtreeCollapsable)
          TabsStore.addSubtreeCollapsableTab(this.raw);
        else
          TabsStore.removeSubtreeCollapsableTab(this.raw);
        break;

      case Constants.kTAB_STATE_HIDDEN:
        TabsStore.removeVisibleTab(this.raw);
        TabsStore.removeControllableTab(this.raw);
        if (toTab)
          this.raw.hidden = true;
        break;

      case Constants.kTAB_STATE_PINNED:
        TabsStore.addPinnedTab(this.raw);
        TabsStore.removeUnpinnedTab(this.raw);
        if (toTab)
          this.raw.pinned = true;
        break;

      case Constants.kTAB_STATE_BUNDLED_ACTIVE:
        TabsStore.addBundledActiveTab(this.raw);
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
          this.raw.audible = true;
        break;

      case Constants.kTAB_STATE_MUTED: {
        const parent = this.parent;
        if (parent)
          parent.$TST.mutedChildrenIds.add(this.id);
        if (toTab)
          this.raw.mutedInfo.muted = true;
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
        if (toTab && this.raw.sharingState)
          this.raw.sharingState.camera = true;
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
        if (toTab && this.raw.sharingState)
          this.raw.sharingState.microphone = true;
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
        if (toTab && this.raw.sharingState)
          this.raw.sharingState.screen = 'Something';
      } break;
      case Constants.kTAB_STATE_HAS_SHARING_SCREEN_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeSharingScreenChildrenIds.add(this.id);
      } break;

      case Constants.kTAB_STATE_GROUP_TAB:
        TabsStore.addGroupTab(this.raw);
        break;

      case Constants.kTAB_STATE_PRIVATE_BROWSING:
        if (toTab)
          this.raw.incognito = true;
        break;

      case Constants.kTAB_STATE_ATTENTION:
        if (toTab)
          this.raw.attention = true;
        break;

      case Constants.kTAB_STATE_DISCARDED:
        if (toTab)
          this.raw.discarded = true;
        break;

      case 'loading':
        TabsStore.addLoadingTab(this.raw);
        if (toTab)
          this.raw.status = state;
        break;

      case 'complete':
        TabsStore.removeLoadingTab(this.raw);
        if (toTab)
          this.raw.status = state;
        break;
    }

    if (TreeItem.allAutoStickyStates.has(state)) {
      if (this.canBecomeSticky)
        TabsStore.addCanBecomeStickyTab(this.raw);
      else
        TabsStore.removeCanBecomeStickyTab(this.raw);
    }

    if (this.raw &&
        modified &&
        state != Constants.kTAB_STATE_ACTIVE &&
        Constants.IS_BACKGROUND &&
        broadcast !== false)
      Tab.broadcastState(this.raw, {
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
      if (this.raw)
        Tab.onStateChanged.dispatch(this.raw, state, true);
    }
  }

  async removeState(state, { permanently, toTab, broadcast } = {}) {
    state = state && String(state) || undefined;
    if (!this.raw || !state)
      return;

    const modified = this.states?.has(state);

    super.removeState(state);

    switch (state) {
      case Constants.kTAB_STATE_HIGHLIGHTED:
        TabsStore.removeHighlightedTab(this.raw);
        if (this.element)
          this.element.setAttribute('aria-selected', 'false');
        if (toTab)
          this.raw.highlighted = false;
        break;

      case Constants.kTAB_STATE_SELECTED:
        TabsStore.removeSelectedTab(this.raw);
        break;

      case Constants.kTAB_STATE_COLLAPSED:
      case Constants.kTAB_STATE_SUBTREE_COLLAPSED:
        if (this.isSubtreeCollapsable)
          TabsStore.addSubtreeCollapsableTab(this.raw);
        else
          TabsStore.removeSubtreeCollapsableTab(this.raw);
        break;

      case Constants.kTAB_STATE_HIDDEN:
        if (!this.collapsed)
          TabsStore.addVisibleTab(this.raw);
        TabsStore.addControllableTab(this.raw);
        if (toTab)
          this.raw.hidden = false;
        break;

      case Constants.kTAB_STATE_PINNED:
        TabsStore.removePinnedTab(this.raw);
        TabsStore.addUnpinnedTab(this.raw);
        if (toTab)
          this.raw.pinned = false;
        break;

      case Constants.kTAB_STATE_BUNDLED_ACTIVE:
        TabsStore.removeBundledActiveTab(this.raw);
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
          this.raw.audible = false;
        break;

      case Constants.kTAB_STATE_MUTED: {
        const parent = this.parent;
        if (parent)
          parent.$TST.mutedChildrenIds.delete(this.id);
        if (toTab)
          this.raw.mutedInfo.muted = false;
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
        if (toTab && this.raw.sharingState)
          this.raw.sharingState.camera = false;
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
        if (toTab && this.raw.sharingState)
          this.raw.sharingState.microphone = false;
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
        if (toTab && this.raw.sharingState)
          this.raw.sharingState.screen = undefined;
      } break;
      case Constants.kTAB_STATE_HAS_SHARING_SCREEN_MEMBER: {
        const parent = this.parent;
        if (parent)
          parent.$TST.maybeSharingScreenChildrenIds.delete(this.id);
      } break;

      case Constants.kTAB_STATE_GROUP_TAB:
        TabsStore.removeGroupTab(this.raw);
        break;

      case Constants.kTAB_STATE_PRIVATE_BROWSING:
        if (toTab)
          this.raw.incognito = false;
        break;

      case Constants.kTAB_STATE_ATTENTION:
        if (toTab)
          this.raw.attention = false;
        break;

      case Constants.kTAB_STATE_DISCARDED:
        if (toTab)
          this.raw.discarded = false;
        break;
    }

    if (TreeItem.allAutoStickyStates.has(state)) {
      if (this.canBecomeSticky)
        TabsStore.addCanBecomeStickyTab(this.raw);
      else
        TabsStore.removeCanBecomeStickyTab(this.raw);
    }

    if (modified &&
        state != Constants.kTAB_STATE_ACTIVE &&
        Constants.IS_BACKGROUND &&
        broadcast !== false)
      Tab.broadcastState(this.raw, {
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
      Tab.onStateChanged.dispatch(this.raw, state, false);
    }
  }

  async getPermanentStates() {
    const states = this.raw && await browser.sessions.getTabValue(this.id, Constants.kPERSISTENT_STATES).catch(ApiTabs.handleMissingTabError);
    // We need to cleanup invalid values stored accidentally.
    // See also: https://github.com/piroor/treestyletab/issues/2882
    return states && mapAndFilterUniq(states, state => state && String(state) || undefined) || [];
  }

  inheritSoundStateFromChildren() {
    if (!this.raw)
      return;

    // this is called too many times on a session restoration, so this should be throttled for better performance
    if (this.delayedInheritSoundStateFromChildren)
      clearTimeout(this.delayedInheritSoundStateFromChildren);

    this.delayedInheritSoundStateFromChildren = setTimeout(() => {
      this.delayedInheritSoundStateFromChildren = null;
      if (!TabsStore.ensureLivingItem(this.raw))
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
        windowId:              this.raw.windowId,
        tabId:                 this.id,
        hasSoundPlayingMember: this.states.has(Constants.kTAB_STATE_HAS_SOUND_PLAYING_MEMBER),
        hasMutedMember:        this.states.has(Constants.kTAB_STATE_HAS_MUTED_MEMBER),
        hasAutoplayBlockedMember: this.states.has(Constants.kTAB_STATE_HAS_AUTOPLAY_BLOCKED_MEMBER),
      });
    }, 100);
  }

  inheritSharingStateFromChildren() {
    if (!this.raw)
      return;

    // this is called too many times on a session restoration, so this should be throttled for better performance
    if (this.delayedInheritSharingStateFromChildren)
      clearTimeout(this.delayedInheritSharingStateFromChildren);

    this.delayedInheritSharingStateFromChildren = setTimeout(() => {
      this.delayedInheritSharingStateFromChildren = null;
      if (!TabsStore.ensureLivingItem(this.raw))
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
        windowId: this.raw.windowId,
        tabId:    this.id,
        hasSharingCameraMember:     this.states.has(Constants.kTAB_STATE_HAS_SHARING_CAMERA_MEMBER),
        hasSharingMicrophoneMember: this.states.has(Constants.kTAB_STATE_HAS_SHARING_MICROPHONE_MEMBER),
        hasSharingScreenMember:     this.states.has(Constants.kTAB_STATE_HAS_SHARING_SCREEN_MEMBER),
      });
    }, 100);
  }


  onNativeGroupModified(oldGroupId) {
    if (this.raw.groupId == -1) {
      TabsStore.removeNativelyGroupedTab(this.raw);
    }
    else {
      TabsStore.addNativelyGroupedTab(this.raw);
    }

    this.setAttribute(Constants.kGROUP_ID, this.raw.groupId);

    const group = this.nativeTabGroup;
    if (group) {
      group.incognito = this.tab.incognito;
      group.$TST.reindex(this.raw);
    }

    if (oldGroupId && oldGroupId != -1) {
      TabGroup.get(oldGroupId)?.$TST.reindex();
    }

    Tab.onNativeGroupModified.dispatch(this.raw);
  }


  setAttribute(attribute, value) {
    super.setAttribute(attribute, value);
    this.invalidateCache();
  }

  removeAttribute(attribute) {
    super.removeAttribute(attribute);
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

  apply(exported) { // not optimized and unsafe yet!
    if (!this.raw)
      return;

    TabsStore.removeTabFromIndexes(this.raw);

    for (const key of Object.keys(exported)) {
      if (key == '$TST')
        continue;
      if (key in this.raw)
        this.raw[key] = exported[key];
    }

    this.uniqueId = exported.$TST.uniqueId;
    this.promisedUniqueId = Promise.resolve(this.uniqueId);

    this.states     = new Set(exported.$TST.states);
    this.attributes = exported.$TST.attributes;

    this.parent   = exported.$TST.parentId;
    this.children = exported.$TST.childIds || [];

    TabsStore.updateIndexesForTab(this.raw);
  }

  async exportFullTreeItemProperties(fullExportedTreeItem, { isContextTab, permissions, cache } = {}) {
    const favIconUrl = await (
      (!permissions ||
       (!permissions.has(kPERMISSION_TABS) &&
        (!permissions.has(kPERMISSION_ACTIVE_TAB) ||
         !this.raw?.active))) ?
        null :
        (this.raw?.id in cache.effectiveFavIconUrls) ?
          cache.effectiveFavIconUrls[this.raw?.id] :
          this.raw?.favIconUrl?.startsWith('data:') ?
            this.raw?.favIconUrl :
            TabFavIconHelper.getLastEffectiveFavIconURL(this.raw).catch(ApiTabs.handleMissingTabError)
    );

    if (!(this.raw.id in cache.effectiveFavIconUrls))
      cache.effectiveFavIconUrls[this.raw.id] = favIconUrl;

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
         (this.raw.active ||
          isContextTab))) {
      // specially allowed with "tabs" or "activeTab" permission
      allowedProperties.add('favIconUrl');
      allowedProperties.add('title');
      allowedProperties.add('url');
      fullExportedTreeItem.effectiveFavIconUrl = favIconUrl;
    }
    if (permissions.has(kPERMISSION_COOKIES)) {
      allowedProperties.add('cookieStoreId');
      fullExportedTreeItem.cookieStoreName = this.raw.$TST.cookieStoreName;
    }

    for (const property of allowedProperties) {
      if (property in this.raw)
        fullExportedTreeItem[property] = this.raw[property];
    }
  }


  applyStatesToElement() {
    if (!this.element)
      return;

    super.applyStatesToElement();

    if (this.states.has(Constants.kTAB_STATE_HIGHLIGHTED)) {
      this.element.setAttribute('aria-selected', 'true');
    }
  }

  set favIconUrl(url) {
    if (this.element && 'favIconUrl' in this.element)
      this.element.favIconUrl = url;
    this.invalidateCache();
  }


  //===================================================================
  // class methods
  //===================================================================

  static track(tab) {
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
  }

  static untrack(tabId) {
    const tab = Tab.get(tabId);
    if (!tab) // already untracked
      return;
    const win = TabsStore.windows.get(tab.windowId);
    if (win)
      win.untrackTab(tabId);
  }

  static isTracked(tabId) {
    return TabsStore.tabs.has(tabId);
  }

  static get(tabId) {
    if (!tabId) {
      return null;
    }
    if (tabId && typeof tabId.color !== 'undefined') { // for backward compatibility
      return TabGroup.get(tabId.id);
    }
    return TabsStore.tabs.get(typeof tabId == 'number' ? tabId : tabId?.id);
  }

  static getByUniqueId(id) {
    if (!id)
      return null;
    return TabsStore.ensureLivingItem(TabsStore.tabsByUniqueId.get(id));
  }

  static needToWaitTracked(windowId) {
    if (windowId) {
      const tabs = mIncompletelyTrackedTabs.get(windowId);
      return tabs && tabs.size > 0;
    }
    for (const tabs of mIncompletelyTrackedTabs.values()) {
      if (tabs && tabs.size > 0)
        return true;
    }
    return false;
  }

  static async waitUntilTrackedAll(windowId, options = {}) {
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
  }

  static async waitUntilTracked(tabId, options = {}) {
    if (!tabId)
      return null;

    if (Array.isArray(tabId))
      return Promise.all(tabId.map(id => Tab.waitUntilTracked(id, options)));

    const windowId = TabsStore.getCurrentWindowId();
    if (windowId) {
      const tabs = TabsStore.removedTabsInWindow.get(windowId);
      if (tabs?.has(tabId))
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
  }

  static needToWaitMoved(windowId) {
    if (windowId) {
      const tabs = mMovingTabs.get(windowId);
      return tabs && tabs.size > 0;
    }
    for (const tabs of mMovingTabs.values()) {
      if (tabs && tabs.size > 0)
        return true;
    }
    return false;
  }

  static async waitUntilMovedAll(windowId) {
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
  }

  static init(tab, options = {}) {
    log('initalize tab ', tab);
    if (!tab) {
      const error = new Error('Fatal error: invalid tab is given to Tab.init()');
      console.log(error, error.stack);
      throw error;
    }
    const trackedTab = Tab.get(tab.id);
    if (trackedTab)
      tab = trackedTab;
    tab.$TST = trackedTab?.$TST || new Tab(tab);
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
  }

  static import(tab) {
    const existingTab = Tab.get(tab.id);
    if (!existingTab) {
      return Tab.init(tab);
    }
    existingTab.$TST.apply(tab);
    return existingTab;
  }

  //===================================================================
  // get single tab
  //===================================================================

  // Note that this function can return null if it is the first tab of
  // a new window opened by the "move tab to new window" command.
  static getActiveTab(windowId) {
    return TabsStore.ensureLivingItem(TabsStore.activeTabInWindow.get(windowId));
  }

  static getFirstTab(windowId) {
    return TabsStore.query({
      windowId,
      tabs:    TabsStore.livingTabsInWindow.get(windowId),
      living:  true,
      ordered: true
    });
  }

  static getLastTab(windowId) {
    return TabsStore.query({
      windowId,
      tabs:   TabsStore.livingTabsInWindow.get(windowId),
      living: true,
      last:   true
    });
  }

  static getFirstVisibleTab(windowId) { // visible, not-collapsed, not-hidden
    return TabsStore.query({
      windowId,
      tabs:    TabsStore.visibleTabsInWindow.get(windowId),
      visible: true,
      ordered: true
    });
  }

  static getLastVisibleTab(windowId) { // visible, not-collapsed, not-hidden
    return TabsStore.query({
      windowId,
      tabs:    TabsStore.visibleTabsInWindow.get(windowId),
      visible: true,
      last:    true,
    });
  }

  static getLastOpenedTab(windowId) {
    const tabs = Tab.getTabs(windowId);
    return tabs.length > 0 ?
      tabs.sort((a, b) => b.id - a.id)[0] :
      null ;
  }

  static getLastPinnedTab(windowId) { // visible, pinned
    return TabsStore.query({
      windowId,
      tabs:    TabsStore.pinnedTabsInWindow.get(windowId),
      living:  true,
      ordered: true,
      last:    true
    });
  }

  static getFirstUnpinnedTab(windowId) { // not-pinned
    return TabsStore.query({
      windowId,
      tabs:    TabsStore.unpinnedTabsInWindow.get(windowId),
      ordered: true
    });
  }

  static getLastUnpinnedTab(windowId) { // not-pinned
    return TabsStore.query({
      windowId,
      tabs:    TabsStore.unpinnedTabsInWindow.get(windowId),
      ordered: true,
      last:    true
    });
  }

  static getFirstNormalTab(windowId) { // visible, not-collapsed, not-pinned
    return TabsStore.query({
      windowId,
      tabs:    TabsStore.unpinnedTabsInWindow.get(windowId),
      normal:  true,
      ordered: true
    });
  }

  static getGroupTabForOpener(opener) {
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
  }

  static getOpenerFromGroupTab(groupTab) {
    if (!groupTab.$TST.isGroupTab)
      return null;
    TabsStore.assertValidTab(groupTab);
    const openerTabId = (new URL(groupTab.url)).searchParams.get('openerTabId');
    const openerTab = Tab.getByUniqueId(openerTabId);
    if (!openerTab ||
        openerTab == groupTab ||
        openerTab.pinned == groupTab.pinned)
      return null;
    return openerTab;
  }

  static getSubstanceFromAliasGroupTab(groupTab) {
    if (!groupTab.$TST.isGroupTab)
      return null;
    TabsStore.assertValidTab(groupTab);
    const aliasTabId = (new URL(groupTab.url)).searchParams.get('aliasTabId');
    const aliasTab = Tab.getByUniqueId(aliasTabId);
    if (!aliasTab ||
        aliasTab == groupTab ||
        aliasTab.pinned == groupTab.pinned)
      return null;
    return aliasTab;
  }

  //===================================================================
  // grap tabs
  //===================================================================

  static getActiveTabs() {
    return Array.from(TabsStore.activeTabInWindow.values(), TabsStore.ensureLivingItem);
  }

  static getAllTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:     TabsStore.getTabsMap(TabsStore.livingTabsInWindow, windowId),
      living:   true,
      ordered:  true,
      ...options
    });
  }

  static getTabAt(windowId, index) {
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
  }

  static getTabs(windowId = null, options = {}) { // only visible, including collapsed and pinned
    return TabsStore.queryAll({
      windowId,
      tabs:         TabsStore.getTabsMap(TabsStore.controllableTabsInWindow, windowId),
      controllable: true,
      ordered:      true,
      ...options
    });
  }

  static getTabsBetween(begin, end) {
    if (!begin || !TabsStore.ensureLivingItem(begin) ||
        !end || !TabsStore.ensureLivingItem(end))
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
  }

  static getNormalTabs(windowId = null, options = {}) { // only visible, including collapsed, not pinned
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.unpinnedTabsInWindow, windowId),
      normal:  true,
      ordered: true,
      ...options
    });
  }

  static getVisibleTabs(windowId = null, options = {}) { // visible, not-collapsed, not-hidden
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.visibleTabsInWindow, windowId),
      living:  true,
      ordered: true,
      ...options
    });
  }

  static getHiddenTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.livingTabsInWindow, windowId),
      living:  true,
      ordered: true,
      hidden:  true,
      ...options
    });
  }

  static getPinnedTabs(windowId = null, options = {}) { // visible, pinned
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.pinnedTabsInWindow, windowId),
      living:  true,
      ordered: true,
      ...options
    });
  }

  static getUnpinnedTabs(windowId = null, options = {}) { // visible, not pinned
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.unpinnedTabsInWindow, windowId),
      living:  true,
      ordered: true,
      ...options
    });
  }

  static getRootTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:         TabsStore.getTabsMap(TabsStore.rootTabsInWindow, windowId),
      controllable: true,
      ordered:      true,
      ...options
    });
  }

  static getLastRootTab(windowId, options = {}) {
    const tabs = Tab.getRootTabs(windowId, options);
    return tabs[tabs.length - 1];
  }

  static collectRootTabs(tabs) {
    const tabsSet = new Set(tabs);
    return tabs.filter(tab => {
      if (!TabsStore.ensureLivingItem(tab))
        return false;
      const parent = tab.$TST.parent;
      return !parent || !tabsSet.has(parent);
    });
  }

  static getSubtreeCollapsedTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:     TabsStore.getTabsMap(TabsStore.subtreeCollapsableTabsInWindow, windowId),
      living:   true,
      hidden:   false,
      ordered:  true,
      ...options
    });
  }

  static getGroupTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.groupTabsInWindow, windowId),
      living:  true,
      ordered: true,
      ...options
    });
  }

  static getLoadingTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.loadingTabsInWindow, windowId),
      living:  true,
      ordered: true,
      ...options
    });
  }

  static getDraggingTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.draggingTabsInWindow, windowId),
      living:  true,
      ordered: true,
      ...options
    });
  }

  static getRemovingTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.removingTabsInWindow, windowId),
      ordered: true,
      ...options
    });
  }

  static getDuplicatingTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.duplicatingTabsInWindow, windowId),
      living:  true,
      ordered: true,
      ...options
    });
  }

  static getHighlightedTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.highlightedTabsInWindow, windowId),
      living:  true,
      ordered: true,
      ...options
    });
  }

  static getSelectedTabs(windowId = null, options = {}) {
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
      return TreeItem.sort(Array.from(new Set([...selectedTabs, ...Array.from(highlightedTabs.values())])));
  }

  static getNeedToBeSynchronizedTabs(windowId = null, options = {}) {
    return TabsStore.queryAll({
      windowId,
      tabs:    TabsStore.getTabsMap(TabsStore.unsynchronizedTabsInWindow, windowId),
      visible: true,
      ...options
    });
  }

  static hasNeedToBeSynchronizedTab(windowId) {
    return !!TabsStore.query({
      windowId,
      tabs:     TabsStore.getTabsMap(TabsStore.unsynchronizedTabsInWindow, windowId),
      visible:  true
    });
  }

  static hasLoadingTab(windowId) {
    return !!TabsStore.query({
      windowId,
      tabs:     TabsStore.getTabsMap(TabsStore.loadingTabsInWindow, windowId),
      visible:  true
    });
  }

  static hasDuplicatedTabs(windowId, options = {}) {
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
  }

  static hasMultipleTabs(windowId, options = {}) {
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
  }

  // "Recycled tab" is an existing but reused tab for session restoration.
  static getRecycledTabs(windowId = null, options = {}) {
    const userNewTabUrls = configs.guessNewOrphanTabAsOpenedByNewTabCommandUrl.split('|').map(part => sanitizeForRegExpSource(part.trim())).join('|');
    return TabsStore.queryAll({
      windowId,
      tabs:       TabsStore.getTabsMap(TabsStore.livingTabsInWindow, windowId),
      living:     true,
      states:     [Constants.kTAB_STATE_RESTORED, false],
      attributes: [Constants.kCURRENT_URI, new RegExp(`^(|${userNewTabUrls}|about:newtab|about:blank|about:privatebrowsing)$`)],
      ...options
    });
  }

  //===================================================================
  // utilities
  //===================================================================

  static bufferedTooltipTextChanges = new Map();
  static broadcastTooltipText(tabs) {
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
        high:     tab.$TST.highPriorityTooltipText,
        low:      tab.$TST.lowPriorityTooltipText,
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
  }

  static bufferedStatesChanges = new Map();
  static broadcastState(tabs, { add, remove } = {}) {
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
  }

  static getOtherTabs(windowId, ignoreTabs, options = {}) {
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

  static getIndex(tab, { ignoreTabs } = {}) {
    if (!TabsStore.ensureLivingItem(tab))
      return -1;
    TabsStore.assertValidTab(tab);
    return Tab.getOtherTabs(tab.windowId, ignoreTabs).indexOf(tab);
  }

  static calculateNewTabIndex({ insertAfter, insertBefore, ignoreTabs } = {}) {
    // We need to calculate new index based on "insertAfter" at first, to avoid
    // placing of the new tab after hidden tabs (too far from the location it
    // should be.)
    if (insertAfter)
      return Tab.getIndex(insertAfter, { ignoreTabs }) + 1;
    if (insertBefore)
      return Tab.getIndex(insertBefore, { ignoreTabs });
    return -1;
  }

  static async doAndGetNewTabs(asyncTask, windowId) {
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
  }

  static dumpAll(windowId) {
    if (!configs.debug)
      return;
    let output = 'dumpAllTabs';
    for (const tab of Tab.getAllTabs(windowId, {iterator: true })) {
      output += '\n' + toLines([...tab.$TST.ancestors.reverse(), tab],
                               tab => `${tab.id}${tab.pinned ? ' [pinned]' : ''}`,
                               ' => ');
    }
    log(output);
  }
}


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
TreeItem.onElementBound.addListener(onWaitingTabTracked);
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
  if (!tabId) {
    return null;
  }
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

Tab.broadcastTooltipText.enabled = false;
Tab.broadcastState.enabled = false;

// utility
TreeItem.get = item => {
  if (!item) {
    return null;
  }
  if (item?.type == TreeItem.TYPE_TAB) {
    return Tab.get(item.id);
  }
  if (item?.type == TreeItem.TYPE_GROUP) {
    return TabGroup.get(item.id);
  }
  return TabGroup.get(item) || Tab.get(item);
};
