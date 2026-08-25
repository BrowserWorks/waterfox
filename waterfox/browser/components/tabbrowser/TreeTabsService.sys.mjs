/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const PREF_ENABLED = "browser.tabs.verticalTabs.tree.enabled";
const PREF_AUTO_ATTACH = "browser.tabs.verticalTabs.tree.autoAttach";
const PREF_AUTO_EXPAND_ON_ATTACH =
  "browser.tabs.verticalTabs.tree.autoExpand.onAttach";
const PREF_CLOSE_PARENT_BEHAVIOR =
  "browser.tabs.verticalTabs.tree.closeParentBehavior";
const PREF_MAX_DEPTH = "browser.tabs.verticalTabs.tree.maxDepth";
const PREF_SUCCESSOR_CONTROL =
  "browser.tabs.verticalTabs.tree.successorControl";
const PREF_AUTO_GROUP_PINNED_OPENER =
  "browser.tabs.verticalTabs.tree.autoGroup.pinnedOpener";

function getBoolPref(name, fallback) {
  try {
    return Services.prefs.getBoolPref(name, fallback);
  } catch (error) {
    return fallback;
  }
}

function getIntPref(name, fallback) {
  try {
    return Services.prefs.getIntPref(name, fallback);
  } catch (error) {
    return fallback;
  }
}

function clampIndex(index, length) {
  if (!Number.isFinite(index)) {
    return length;
  }
  if (index < 0) {
    return 0;
  }
  if (index > length) {
    return length;
  }
  return index;
}

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TreeTabsGroups: "resource:///modules/TreeTabsGroups.sys.mjs",
  TreeTabsStore: "resource:///modules/TreeTabsStore.sys.mjs",
});

export const TreeTabsService = {
  _windowStates: new Map(),

  get enabled() {
    return this._isEnabled();
  },

  isActive(window) {
    return this._isEnabled() && this._isVerticalMode(window);
  },

  init(window) {
    if (!window) {
      return;
    }
    const state = this._getWindowState(window, { create: true });
    this._reconcile(state, window);
  },

  uninit(window) {
    if (!window) {
      return;
    }
    this._windowStates.delete(window);
  },

  getParent(tab) {
    if (!this._isEnabled()) {
      return null;
    }
    const node = this._getNode(tab);
    return node?.parent ?? null;
  },

  getChildren(tab) {
    if (!this._isEnabled()) {
      return [];
    }
    const node = this._getNode(tab);
    return node ? node.children.slice() : [];
  },

  getDescendants(tab) {
    if (!this._isEnabled()) {
      return [];
    }
    const { state } = this._getStateForTab(tab);
    if (!state || !tab) {
      return [];
    }
    return this._getDescendantsFromState(state, tab);
  },

  getAncestors(tab) {
    if (!this._isEnabled()) {
      return [];
    }
    const { state } = this._getStateForTab(tab);
    if (!state || !tab) {
      return [];
    }
    return this._getAncestorsFromState(state, tab);
  },

  getLevel(tab) {
    if (!this._isEnabled()) {
      return 0;
    }
    const { state } = this._getStateForTab(tab);
    if (!state || !tab) {
      return 0;
    }
    return this._getLevelFromState(state, tab);
  },

  isCollapsed(tab) {
    if (!this._isEnabled()) {
      return false;
    }
    const node = this._getNode(tab);
    return Boolean(node?.collapsed);
  },

  isSubtreeCollapsed(tab) {
    if (!this._isEnabled()) {
      return false;
    }
    const { state } = this._getStateForTab(tab);
    if (!state || !tab) {
      return false;
    }
    let current = this._getNode(tab)?.parent;
    while (current) {
      const parentNode = state.nodes.get(current);
      if (!parentNode) {
        break;
      }
      if (parentNode.collapsed) {
        return true;
      }
      current = parentNode.parent;
    }
    return false;
  },

  getRootTabs(window) {
    if (!this._isEnabled()) {
      return [];
    }
    const state = this._getWindowState(window);
    return state ? state.roots.slice() : [];
  },

  getVisibleTabs(window) {
    if (!this._isEnabled()) {
      return [];
    }
    const state = this._getWindowState(window);
    if (!state) {
      return [];
    }
    const visible = [];
    const visit = (tab, ancestorCollapsed) => {
      const node = state.nodes.get(tab);
      if (!node) {
        return;
      }
      if (ancestorCollapsed) {
        return;
      }
      visible.push(tab);
      const nextAncestorCollapsed = node.collapsed;
      if (nextAncestorCollapsed) {
        return;
      }
      for (const child of node.children) {
        visit(child, nextAncestorCollapsed);
      }
    };

    for (const root of state.roots) {
      visit(root, false);
    }

    return visible;
  },

  attachTab(child, parent, options = {}) {
    if (!this._isEnabled()) {
      return false;
    }
    if (!child || !parent || child === parent) {
      return false;
    }
    if (parent.pinned || child.pinned) {
      return false;
    }
    const { state, window } = this._getStateForTab(child, { create: true });
    if (!state) {
      return false;
    }
    const parentWindow = this._getWindowForTab(parent);
    if (parentWindow && parentWindow !== window) {
      return false;
    }
    if ((child.group || null) !== (parent.group || null)) {
      return false;
    }
    if (this._isAncestor(state, child, parent)) {
      return false;
    }
    if (this._wouldExceedMaxDepth(state, parent, child)) {
      return false;
    }
    const childNode = this._ensureNode(state, child);
    const parentNode = this._ensureNode(state, parent);
    const previousParent = childNode.parent;

    if (previousParent) {
      const previousParentNode = state.nodes.get(previousParent);
      if (previousParentNode) {
        this._removeFromArray(previousParentNode.children, child);
      }
    } else {
      this._removeFromArray(state.roots, child);
    }

    childNode.parent = parent;

    const insertIndex = this._resolveInsertIndex(parentNode.children, options);
    parentNode.children.splice(insertIndex, 0, child);

    if (
      !options.suppressAutoExpand &&
      getBoolPref(PREF_AUTO_EXPAND_ON_ATTACH, true)
    ) {
      this.expandSubtree(parent);
    }

    this._notify("tree-tabs-attached", {
      tab: child,
      parent,
      previousParent,
    });

    return true;
  },

  detachTab(tab) {
    if (!this._isEnabled()) {
      return;
    }
    const { state } = this._getStateForTab(tab, { create: true });
    if (!state || !tab) {
      return;
    }
    const node = this._ensureNode(state, tab);
    const previousParent = node.parent;

    if (previousParent) {
      const parentNode = state.nodes.get(previousParent);
      if (parentNode) {
        this._removeFromArray(parentNode.children, tab);
      }
    }

    node.parent = null;

    if (previousParent) {
      const rootAncestor = this._getRootAncestor(state, previousParent);
      const rootIndex = state.roots.indexOf(rootAncestor);
      const insertAfterRoot =
        rootIndex === -1 ? state.roots.length : rootIndex + 1;
      this._addRoot(state, tab, insertAfterRoot);
    } else if (!state.roots.includes(tab)) {
      this._addRoot(state, tab, state.roots.length);
    }

    if (previousParent) {
      this._notify("tree-tabs-detached", {
        tab,
        previousParent,
      });
    }
  },

  detachAllChildren(tab, options = {}) {
    if (!this._isEnabled()) {
      return;
    }
    const { state } = this._getStateForTab(tab, { create: true });
    if (!state || !tab) {
      return;
    }
    const node = this._ensureNode(state, tab);
    const children = node.children.slice();
    node.children = [];

    const reparentTo = options.reparentTo || null;
    for (const child of children) {
      if (reparentTo) {
        this.attachTab(child, reparentTo, options);
      } else {
        this.detachTab(child);
      }
    }
  },

  moveTabSubtree(tab, newIndex) {
    if (!this._isEnabled()) {
      return;
    }
    const { state, window } = this._getStateForTab(tab);
    if (!state || !tab) {
      return;
    }
    this._moveWithinContainer(state, tab, newIndex);
    this._notifyStructureChanged(window);
  },

  collapseSubtree(tab) {
    if (!this._isEnabled()) {
      return;
    }
    const node = this._getNode(tab, { create: true });
    if (!node || node.collapsed) {
      return;
    }
    node.collapsed = true;
    this._notify("tree-tabs-subtree-collapsed-changed", {
      tab,
      collapsed: true,
    });
  },

  expandSubtree(tab) {
    if (!this._isEnabled()) {
      return;
    }
    const node = this._getNode(tab, { create: true });
    if (!node || !node.collapsed) {
      return;
    }
    node.collapsed = false;
    this._notify("tree-tabs-subtree-collapsed-changed", {
      tab,
      collapsed: false,
    });
  },

  toggleCollapsed(tab) {
    if (!this._isEnabled()) {
      return;
    }
    if (this.isCollapsed(tab)) {
      this.expandSubtree(tab);
    } else {
      this.collapseSubtree(tab);
    }
  },

  onTabOpened(tab, info = {}) {
    if (!this._isEnabled()) {
      return;
    }
    const { state, window } = this._getStateForTab(tab, { create: true });
    if (!state || !tab) {
      return;
    }
    this._ensureNode(state, tab);

    if (!this.isActive(window)) {
      return;
    }

    if (info.duplicate && info.opener) {
      this._placeNextSibling(state, tab, info.opener, window);
      return;
    }

    if (info.nextSiblingOf) {
      this._placeNextSibling(state, tab, info.nextSiblingOf, window);
      return;
    }

    const autoAttach = getIntPref(PREF_AUTO_ATTACH, 1);

    if (autoAttach === 0) {
      this.detachTab(tab);
      return;
    }

    if (autoAttach === 1) {
      const opener = info.opener || info.openerTab || tab.openerTab;
      if (opener && !opener.pinned) {
        let options = {};
        if (info.insertAfter) {
          options = { insertAfter: info.insertAfter };
        } else {
          // Preserve strip position, so a duplicate stays directly after its
          // opener.
          const anchor = this._getChildAnchorByPosition(state, opener, tab);
          if (anchor !== undefined) {
            options = anchor ? { insertAfter: anchor } : { index: 0 };
          }
        }
        this.attachTab(tab, opener, options);
        return;
      }
      if (opener?.pinned && getBoolPref(PREF_AUTO_GROUP_PINNED_OPENER, true)) {
        const openerGuid = lazy.TreeTabsStore.getTabGuid(opener, {
          create: true,
        });
        const existingGroup = lazy.TreeTabsGroups.findGroupTabForOpener(
          window,
          openerGuid
        );
        if (existingGroup) {
          this.attachTab(tab, existingGroup);
          return;
        }
        const relatedTabs = Array.from(window.gBrowser.tabs).filter(
          candidate =>
            candidate !== tab &&
            !candidate.pinned &&
            !candidate.closing &&
            candidate.openerTab === opener &&
            !lazy.TreeTabsGroups.isGroupTab(candidate)
        );
        if (relatedTabs.length) {
          lazy.TreeTabsGroups.groupTabs(window, [...relatedTabs, tab], {
            automaticTitle: true,
            openerGuid,
            temporary: true,
          });
          return;
        }
      }
      const sameSiteBase = this._getSameSiteBase(info, window);
      if (sameSiteBase) {
        // An openerless tab on the same site as the current tab reads as
        // opened from it, so it becomes its last child.
        this.attachTab(tab, sameSiteBase);
        return;
      }
      this.detachTab(tab);
      return;
    }

    if (autoAttach === 2) {
      const current =
        info.currentTab || tab.documentGlobal?.gBrowser?.selectedTab;
      if (current) {
        const parent = this.getParent(current);
        if (parent) {
          this.attachTab(tab, parent, { insertAfter: current });
        } else {
          const { state: currentState } = this._getStateForTab(current, {
            create: true,
          });
          const index = currentState?.roots.indexOf(current);
          if (currentState && index !== undefined && index !== -1) {
            this._addRoot(currentState, tab, index + 1);
          } else {
            this.detachTab(tab);
          }
        }
        return;
      }
      this.detachTab(tab);
      return;
    }

    this.detachTab(tab);
  },

  // The tab after which a new tab should be inserted so its strip position
  // matches where onTabOpened will attach it (the end of the subtree).
  // Returns null when the default Firefox placement should apply.
  getNewTabAnchor(opener, currentTab, info = {}) {
    if (!this.isActive(this._getWindowForTab(opener || currentTab))) {
      return null;
    }
    const autoAttach = getIntPref(PREF_AUTO_ATTACH, 1);
    let base = null;
    if (autoAttach === 1) {
      base = opener && !opener.pinned ? opener : null;
      if (!base && !opener) {
        base = this._getSameSiteBase(
          { ...info, currentTab },
          this._getWindowForTab(currentTab)
        );
      }
    } else if (autoAttach === 2) {
      base = currentTab && !currentTab.pinned ? currentTab : null;
    }
    if (!base) {
      return null;
    }
    const { state } = this._getStateForTab(base);
    if (!state) {
      return null;
    }
    // If the attach is going to be refused, leave the placement alone too.
    if (this._wouldExceedMaxDepth(state, base, null)) {
      return null;
    }
    return this.getSubtreeEndAnchor(base);
  },

  // A tab opened from a pinned tab stays a root but is grouped at the top of
  // the normal area: after the subtree of the last tab opened from the same
  // pinned tab, or right after the pinned block.
  getPinnedOpenerAnchor(opener, lastRelatedTab, window) {
    if (!this.isActive(window) || !opener?.pinned) {
      return null;
    }
    if (lastRelatedTab && !lastRelatedTab.pinned && !lastRelatedTab.closing) {
      return this.getSubtreeEndAnchor(lastRelatedTab);
    }
    const tabs = window?.gBrowser?.tabs;
    if (!tabs) {
      return null;
    }
    let lastPinned = null;
    for (const tab of tabs) {
      if (tab.pinned) {
        lastPinned = tab;
      }
    }
    return lastPinned;
  },

  // The active tab counts as the opener of an openerless tab pointed at the
  // same site, mirroring how such tabs are usually opened from it.
  _getSameSiteBase(info, window) {
    if (info.fromExternal || info.bulk || !info.url) {
      return null;
    }
    const current = info.currentTab || window?.gBrowser?.selectedTab || null;
    if (!current || current.pinned || current.closing) {
      return null;
    }
    const currentSpec = current.linkedBrowser?.currentURI?.spec;
    if (!currentSpec || info.url === currentSpec) {
      return null;
    }
    const siteMatcher = /^\w+:\/\/([^/]+)(?:$|\/)/;
    const newSite = info.url.match(siteMatcher);
    const currentSite = currentSpec.match(siteMatcher);
    if (!newSite || !currentSite || newSite[1] !== currentSite[1]) {
      return null;
    }
    return current;
  },

  // The last tab of the subtree in strip order, skipping closing tabs and
  // hidden ones so insertions land before trailing hidden tabs.
  getSubtreeEndAnchor(base) {
    if (!base || !this.isActive(this._getWindowForTab(base))) {
      return null;
    }
    const { state } = this._getStateForTab(base);
    if (!state) {
      return null;
    }
    let anchor = base;
    for (const descendant of this._getDescendantsFromState(state, base)) {
      if (descendant.closing || descendant.hidden) {
        continue;
      }
      if (descendant._tPos > anchor._tPos) {
        anchor = descendant;
      }
    }
    return anchor;
  },

  // Tree-aware pick for the tab to select when the active tab goes away:
  // the first surviving child, then the next sibling, then the visually
  // previous tab, so selection stays inside the tree while it has members.
  // A pinned tab hands off to another pinned tab.
  getSuccessor(tab, excludeTabs = new Set()) {
    if (
      !this.isActive(this._getWindowForTab(tab)) ||
      !getBoolPref(PREF_SUCCESSOR_CONTROL, true)
    ) {
      return null;
    }
    const { state, window } = this._getStateForTab(tab);
    if (!state || !tab) {
      return null;
    }
    const tabs = window?.gBrowser?.tabs;
    if (!tabs) {
      return null;
    }
    const acceptable = candidate =>
      candidate &&
      candidate !== tab &&
      !candidate.closing &&
      !candidate.hidden &&
      !excludeTabs.has(candidate);

    if (tab.pinned) {
      const pinned = Array.from(tabs).filter(other => other.pinned);
      const index = pinned.indexOf(tab);
      for (let i = index + 1; i < pinned.length; i += 1) {
        if (acceptable(pinned[i])) {
          return pinned[i];
        }
      }
      for (let i = index - 1; i >= 0; i -= 1) {
        if (acceptable(pinned[i])) {
          return pinned[i];
        }
      }
      return null;
    }

    const node = state.nodes.get(tab);
    if (!node) {
      return null;
    }

    if (this._getEffectiveCloseBehavior(node, window) !== 2) {
      for (const child of node.children) {
        if (acceptable(child)) {
          return child;
        }
      }
    }

    const siblings = node.parent
      ? state.nodes.get(node.parent)?.children || []
      : state.roots;
    for (let i = siblings.indexOf(tab) + 1; i < siblings.length; i += 1) {
      if (acceptable(siblings[i])) {
        return siblings[i];
      }
    }

    const visible = this.getVisibleTabs(window);
    for (let i = visible.indexOf(tab) - 1; i >= 0; i -= 1) {
      if (acceptable(visible[i])) {
        return visible[i];
      }
    }
    return null;
  },

  getTabsClosingWith(tab, info = {}) {
    if (!this._isEnabled()) {
      return [tab].filter(Boolean);
    }
    const { state, window } = this._getStateForTab(tab);
    const node = state?.nodes.get(tab);
    if (!node) {
      return [tab].filter(Boolean);
    }
    const behavior = this._getEffectiveCloseBehavior(
      node,
      window,
      info.isUserTriggered !== false
    );
    return behavior === 2
      ? [tab, ...this._getDescendantsFromState(state, tab)]
      : [tab];
  },

  onTabClosed(tab, info = {}) {
    if (!this._isEnabled()) {
      return [];
    }
    const { state, window } = this._getStateForTab(tab);
    if (!state || !tab) {
      return [];
    }
    const node = state.nodes.get(tab);
    if (!node) {
      return [];
    }

    let behavior;
    if (info.adopted) {
      // The tab moved to another window; its children stay behind, so
      // promote them instead of applying the close behaviour.
      behavior = 1;
    } else {
      behavior = this._getEffectiveCloseBehavior(
        node,
        window,
        info.isUserTriggered !== false
      );
    }
    if (behavior === 2) {
      const descendants = this._getDescendantsFromState(state, tab);
      this._detachChildrenToRoots(state, tab);
      this._removeNode(state, tab);
      this._notifyStructureChanged(window);
      if (descendants.length) {
        this._notify("tree-tabs-close-requested", {
          window,
          tabs: descendants,
          baseTab: tab,
        });
      }
      return descendants;
    }

    if (behavior === 4) {
      const children = node.children.filter(child => !child.closing);
      const replacedParentCount =
        lazy.TreeTabsGroups.getReplacedParentCount(tab);
      if (children.length > 1 && replacedParentCount < 1) {
        const siblings = node.parent
          ? state.nodes.get(node.parent)?.children || []
          : state.roots;
        const siblingIndex = siblings.indexOf(tab);
        const payload = {
          window,
          title: tab.label,
          parent: node.parent,
          children,
          insertBefore: siblings[siblingIndex + 1] || null,
          insertAfter: siblings[siblingIndex - 1] || null,
          siblingIndex,
          replacedParentCount: replacedParentCount + 1,
        };
        this._promoteAllChildren(state, tab);
        this._removeNode(state, tab);
        this._notifyStructureChanged(window);
        this._notify("tree-tabs-group-replace-requested", payload);
        return [];
      }
      behavior = node.parent ? 1 : 0;
    }

    if (node.children.length) {
      switch (behavior) {
        case 0:
          // A parent closed as the last child leaves no following sibling to
          // absorb the tree shape, so all children join the grandparent.
          if (node.parent && this._isLastChild(state, tab)) {
            this._promoteAllChildren(state, tab);
          } else {
            this._promoteFirstChild(state, tab);
          }
          break;
        case 1:
          this._promoteAllChildren(state, tab);
          break;
        case 3:
          this._detachChildrenToRoots(state, tab);
          break;
        default:
          this._promoteAllChildren(state, tab);
          break;
      }
    }

    this._removeNode(state, tab);
    this._notifyStructureChanged(window);
    return [];
  },

  onTabMoved(tab, info = {}) {
    if (!this._isEnabled()) {
      return;
    }
    const { state, window } = this._getStateForTab(tab);
    if (!state || !tab) {
      return;
    }

    if (info.detachChildren) {
      this._detachChildrenForMove(state, tab);
    }

    let newIndex = info.newIndex;
    if (!Number.isFinite(newIndex)) {
      newIndex = this._getVisualSiblingIndex(state, tab);
    }

    if (Number.isFinite(newIndex)) {
      this._moveWithinContainer(state, tab, newIndex);
    }

    this._notifyStructureChanged(window);
  },

  snapshotSubtree(tab) {
    if (!this._isEnabled()) {
      return null;
    }
    const { state } = this._getStateForTab(tab);
    return state && tab ? this._snapshotSubtree(state, tab) : null;
  },

  onTabDetached(tab) {
    if (!this._isEnabled()) {
      return null;
    }
    const { state, window } = this._getStateForTab(tab);
    if (!state || !tab) {
      return null;
    }

    const snapshot = this._snapshotSubtree(state, tab);
    this._removeSubtree(state, tab);
    this._notifyStructureChanged(window);
    return snapshot;
  },

  restoreSubtreeSnapshot(snapshot, adoptedTabMap) {
    if (!snapshot?.root || !snapshot.nodes?.length || !adoptedTabMap?.size) {
      return null;
    }
    const firstMappedNode = snapshot.nodes.find(node =>
      adoptedTabMap.has(node.tab)
    );
    const firstTab = adoptedTabMap.get(firstMappedNode?.tab);
    const { window } = this._getStateForTab(firstTab, { create: true });
    if (!window) {
      return null;
    }

    const nodesByTab = new Map(snapshot.nodes.map(node => [node.tab, node]));
    for (const node of snapshot.nodes) {
      const tab = adoptedTabMap.get(node.tab);
      if (tab?.documentGlobal == window) {
        this.detachTab(tab);
      }
    }

    const previousByParent = new Map();
    const restoreNode = oldTab => {
      const node = nodesByTab.get(oldTab);
      if (!node) {
        return;
      }
      const tab = adoptedTabMap.get(oldTab);
      if (tab?.documentGlobal == window) {
        let oldParent = node.parent;
        while (oldParent && !adoptedTabMap.has(oldParent)) {
          oldParent = nodesByTab.get(oldParent)?.parent || null;
        }
        const parent = adoptedTabMap.get(oldParent);
        if (parent?.documentGlobal == window && parent != tab) {
          let options;
          if (oldTab == snapshot.root) {
            const insertBefore = adoptedTabMap.get(snapshot.insertBefore);
            const insertAfter = adoptedTabMap.get(snapshot.insertAfter);
            options = {
              insertBefore,
              insertAfter,
              index: snapshot.siblingIndex,
              suppressAutoExpand: true,
            };
          } else {
            const previous = previousByParent.get(parent);
            options = previous
              ? { insertAfter: previous, suppressAutoExpand: true }
              : { index: 0, suppressAutoExpand: true };
          }
          this.attachTab(tab, parent, options);
          previousByParent.set(parent, tab);
        } else {
          const previous = previousByParent.get(null);
          const roots = this.getRootTabs(window);
          const currentIndex = roots.indexOf(tab);
          let targetIndex = 0;
          if (oldTab == snapshot.root) {
            const insertBefore = adoptedTabMap.get(snapshot.insertBefore);
            const insertAfter = adoptedTabMap.get(snapshot.insertAfter);
            if (insertBefore && roots.includes(insertBefore)) {
              targetIndex = roots.indexOf(insertBefore);
            } else if (insertAfter && roots.includes(insertAfter)) {
              targetIndex = roots.indexOf(insertAfter) + 1;
            } else if (Number.isInteger(snapshot.siblingIndex)) {
              targetIndex = snapshot.siblingIndex;
            }
          } else if (previous && roots.includes(previous)) {
            targetIndex = roots.indexOf(previous) + 1;
          }
          if (currentIndex >= 0 && currentIndex < targetIndex) {
            targetIndex -= 1;
          }
          this.moveTabSubtree(tab, targetIndex);
          previousByParent.set(null, tab);
        }
      }
      for (const child of node.children || []) {
        restoreNode(child);
      }
    };
    restoreNode(snapshot.root);

    for (const node of snapshot.nodes) {
      const tab = adoptedTabMap.get(node.tab);
      if (!tab || tab.documentGlobal != window) {
        continue;
      }
      if (node.collapsed) {
        this.collapseSubtree(tab);
      } else {
        this.expandSubtree(tab);
      }
    }
    this._notifyStructureChanged(window);
    return adoptedTabMap.get(snapshot.root) || firstTab;
  },

  onTabRestored(tab) {
    if (!this._isEnabled()) {
      return;
    }
    const { state, window } = this._getStateForTab(tab, { create: true });
    if (!state || !tab) {
      return;
    }
    const node = this._ensureNode(state, tab);
    if (!node.parent && !state.roots.includes(tab)) {
      this._addRoot(state, tab, state.roots.length);
    }
    this._notifyStructureChanged(window);
  },

  removeGroupTab(tab) {
    if (!this._isEnabled() || !lazy.TreeTabsGroups.isGroupTab(tab)) {
      return false;
    }
    const { state, window } = this._getStateForTab(tab);
    if (!state || !window || !state.nodes.has(tab)) {
      return false;
    }
    tab._treeTabsCleanupAncestors = this.getAncestors(tab);
    this._promoteAllChildren(state, tab);
    this._removeNode(state, tab);
    this._notifyStructureChanged(window);
    window.gBrowser.removeTab(tab);
    return true;
  },

  closeTree(tab) {
    if (!this._isEnabled()) {
      return [];
    }
    const { state, window } = this._getStateForTab(tab);
    if (!state || !tab) {
      return [];
    }
    const removed = this._removeSubtree(state, tab);
    this._notifyStructureChanged(window);
    return removed;
  },

  closeDescendants(tab) {
    if (!this._isEnabled()) {
      return [];
    }
    const { state, window } = this._getStateForTab(tab);
    if (!state || !tab) {
      return [];
    }
    const node = state.nodes.get(tab);
    if (!node || node.children.length === 0) {
      return [];
    }
    const descendants = this._getDescendantsFromState(state, tab);
    for (const child of node.children.slice()) {
      this._removeSubtree(state, child);
    }
    node.children = [];
    this._notifyStructureChanged(window);
    return descendants;
  },

  collapseAll(window) {
    if (!this._isEnabled()) {
      return;
    }
    const state = this._getWindowState(window);
    if (!state) {
      return;
    }
    for (const node of state.nodes.values()) {
      if (node.children.length && !node.collapsed) {
        node.collapsed = true;
        this._notify("tree-tabs-subtree-collapsed-changed", {
          tab: node.tab,
          collapsed: true,
        });
      }
    }
  },

  expandAll(window) {
    if (!this._isEnabled()) {
      return;
    }
    const state = this._getWindowState(window);
    if (!state) {
      return;
    }
    for (const node of state.nodes.values()) {
      if (node.collapsed) {
        node.collapsed = false;
        this._notify("tree-tabs-subtree-collapsed-changed", {
          tab: node.tab,
          collapsed: false,
        });
      }
    }
  },

  _isEnabled() {
    return getBoolPref(PREF_ENABLED, false);
  },

  _getEffectiveCloseBehavior(node, window, userTriggered = true) {
    if (!this._isVerticalMode(window)) {
      return 1;
    }
    let behavior = getIntPref(PREF_CLOSE_PARENT_BEHAVIOR, 0);
    if (userTriggered && node.children.length && node.collapsed) {
      // A collapsed subtree reads as one item on the strip, so a close the
      // user asked for there takes all of it. Programmatic closes see only
      // the one tab and use the configured behaviour instead.
      behavior = 2;
    }
    return behavior;
  },

  _isVerticalMode(window) {
    const tabContainer = window?.gBrowser?.tabContainer;
    return tabContainer ? !!tabContainer.verticalMode : true;
  },

  // Bring the node map in line with the window's tabs. Tabs opened or
  // closed while the pref was off are missed by the event hooks.
  _reconcile(state, window) {
    const tabs = window.gBrowser?.tabs;
    if (!tabs) {
      return;
    }
    const live = new Set(tabs);
    const dead = [];
    for (const tab of state.nodes.keys()) {
      if (!live.has(tab)) {
        dead.push(tab);
      }
    }
    for (const tab of dead) {
      this._promoteAllChildren(state, tab);
      this._removeNode(state, tab);
    }
    for (const tab of tabs) {
      this._ensureNode(state, tab);
    }
  },

  _getWindowForTab(tab) {
    return tab?.documentGlobal || null;
  },

  _getWindowState(window, { create = false } = {}) {
    if (!window) {
      return null;
    }
    let state = this._windowStates.get(window);
    if (!state && create) {
      state = { nodes: new Map(), roots: [] };
      this._windowStates.set(window, state);
    }
    return state || null;
  },

  _getStateForTab(tab, options = {}) {
    const window = this._getWindowForTab(tab);
    const state = this._getWindowState(window, options);
    return { state, window };
  },

  _getNode(tab, options = {}) {
    const { state } = this._getStateForTab(tab, options);
    if (!state || !tab) {
      return null;
    }
    if (options.create) {
      return this._ensureNode(state, tab);
    }
    return state.nodes.get(tab) || null;
  },

  _ensureNode(state, tab) {
    let node = state.nodes.get(tab);
    if (!node) {
      node = {
        tab,
        parent: null,
        children: [],
        collapsed: false,
      };
      state.nodes.set(tab, node);
      if (!state.roots.includes(tab)) {
        state.roots.push(tab);
      }
    }
    return node;
  },

  _addRoot(state, tab, index = state.roots.length) {
    const existingIndex = state.roots.indexOf(tab);
    const targetIndex = clampIndex(index, state.roots.length);
    if (existingIndex === -1) {
      state.roots.splice(targetIndex, 0, tab);
      return;
    }
    if (existingIndex !== targetIndex) {
      state.roots.splice(existingIndex, 1);
      state.roots.splice(clampIndex(targetIndex, state.roots.length), 0, tab);
    }
  },

  _removeNode(state, tab) {
    const node = state.nodes.get(tab);
    if (!node) {
      return;
    }
    if (node.parent) {
      const parentNode = state.nodes.get(node.parent);
      if (parentNode) {
        this._removeFromArray(parentNode.children, tab);
      }
    } else {
      this._removeFromArray(state.roots, tab);
    }
    node.parent = null;
    node.children = [];
    state.nodes.delete(tab);
  },

  _removeFromArray(array, item) {
    const index = array.indexOf(item);
    if (index !== -1) {
      array.splice(index, 1);
    }
  },

  // Return null to prepend, undefined when position is unavailable and callers
  // should append, or the preceding direct child otherwise.
  _getChildAnchorByPosition(state, parent, tab) {
    if (!Number.isInteger(tab._tPos)) {
      return undefined;
    }
    const parentNode = state.nodes.get(parent);
    let anchor = null;
    for (const child of parentNode?.children || []) {
      if (Number.isInteger(child._tPos) && child._tPos < tab._tPos) {
        anchor = child;
      }
    }
    return anchor;
  },

  _resolveInsertIndex(children, options) {
    if (options.insertBefore) {
      const index = children.indexOf(options.insertBefore);
      if (index !== -1) {
        return index;
      }
    }
    if (options.insertAfter) {
      const index = children.indexOf(options.insertAfter);
      if (index !== -1) {
        return index + 1;
      }
    }
    if (Number.isFinite(options.index)) {
      return clampIndex(options.index, children.length);
    }
    return children.length;
  },

  _getAncestorsFromState(state, tab) {
    const ancestors = [];
    let current = state.nodes.get(tab)?.parent || null;
    while (current) {
      ancestors.push(current);
      const node = state.nodes.get(current);
      current = node?.parent || null;
    }
    return ancestors;
  },

  _getDescendantsFromState(state, tab) {
    const result = [];
    const startNode = state.nodes.get(tab);
    if (!startNode) {
      return result;
    }
    const stack = startNode.children.slice().reverse();
    while (stack.length) {
      const current = stack.pop();
      result.push(current);
      const node = state.nodes.get(current);
      if (node && node.children.length) {
        for (let i = node.children.length - 1; i >= 0; i -= 1) {
          stack.push(node.children[i]);
        }
      }
    }
    return result;
  },

  _getLevelFromState(state, tab) {
    let level = 0;
    let current = state.nodes.get(tab)?.parent || null;
    while (current) {
      level += 1;
      current = state.nodes.get(current)?.parent || null;
    }
    return level;
  },

  _isLastChild(state, tab) {
    const node = state.nodes.get(tab);
    const siblings = node?.parent
      ? state.nodes.get(node.parent)?.children
      : state.roots;
    return siblings ? siblings[siblings.length - 1] === tab : false;
  },

  _isAncestor(state, possibleAncestor, tab) {
    let current = tab;
    while (current) {
      if (current === possibleAncestor) {
        return true;
      }
      const node = state.nodes.get(current);
      current = node?.parent || null;
    }
    return false;
  },

  _wouldExceedMaxDepth(state, parent, child) {
    const maxDepth = getIntPref(PREF_MAX_DEPTH, -1);
    if (maxDepth < 0) {
      return false;
    }
    const parentLevel = this._getLevelFromState(state, parent);
    // The child brings its own subtree along, so count its height too.
    return parentLevel + 1 + this._getSubtreeHeight(state, child) > maxDepth;
  },

  _getSubtreeHeight(state, tab) {
    const node = state.nodes.get(tab);
    if (!node || !node.children.length) {
      return 0;
    }
    let height = 0;
    for (const child of node.children) {
      const childHeight = 1 + this._getSubtreeHeight(state, child);
      if (childHeight > height) {
        height = childHeight;
      }
    }
    return height;
  },

  _getVisualSiblingIndex(state, tab) {
    const node = state.nodes.get(tab);
    if (!node) {
      return null;
    }

    const siblings = node.parent
      ? state.nodes.get(node.parent)?.children
      : state.roots;
    if (!siblings?.length) {
      return null;
    }

    const window = this._getWindowForTab(tab);
    const windowTabs = window?.gBrowser?.tabs;
    if (!windowTabs) {
      return null;
    }

    const siblingSet = new Set(siblings);
    const orderedSiblings = Array.from(windowTabs).filter(candidate =>
      siblingSet.has(candidate)
    );
    return orderedSiblings.indexOf(tab);
  },

  _moveWithinContainer(state, tab, newIndex) {
    const node = state.nodes.get(tab);
    if (!node) {
      return;
    }
    const container = node.parent
      ? state.nodes.get(node.parent)?.children
      : state.roots;
    if (!container) {
      return;
    }
    const currentIndex = container.indexOf(tab);
    if (currentIndex === -1) {
      return;
    }
    const targetIndex = clampIndex(newIndex, container.length - 1);
    if (targetIndex === currentIndex) {
      return;
    }
    container.splice(currentIndex, 1);
    container.splice(clampIndex(targetIndex, container.length), 0, tab);
  },

  _promoteAllChildren(state, tab) {
    const node = state.nodes.get(tab);
    if (!node || node.children.length === 0) {
      return;
    }
    const children = node.children.slice();
    node.children = [];
    const parent = node.parent;
    let container = null;
    if (parent) {
      const parentNode = state.nodes.get(parent);
      container = parentNode?.children || null;
    } else {
      container = state.roots;
    }
    if (container) {
      const index = container.indexOf(tab);
      if (index !== -1) {
        container.splice(index, 1, ...children);
      } else {
        for (const child of children) {
          this._addRoot(state, child);
        }
      }
    }
    for (const child of children) {
      const childNode = this._ensureNode(state, child);
      childNode.parent = parent;
    }
  },

  _promoteFirstChild(state, tab) {
    const node = state.nodes.get(tab);
    if (!node || node.children.length === 0) {
      return;
    }
    const children = node.children.slice();
    node.children = [];
    const [first, ...rest] = children;
    const parent = node.parent;
    let container = null;
    if (parent) {
      const parentNode = state.nodes.get(parent);
      container = parentNode?.children || null;
    } else {
      container = state.roots;
    }
    if (container) {
      const index = container.indexOf(tab);
      if (index !== -1) {
        container.splice(index, 1, first);
      } else {
        this._addRoot(state, first);
      }
    }
    const firstNode = this._ensureNode(state, first);
    firstNode.parent = parent;
    if (rest.length) {
      firstNode.children = firstNode.children.concat(rest);
      for (const child of rest) {
        const childNode = this._ensureNode(state, child);
        childNode.parent = first;
      }
    }
  },

  // Duplicated tabs and "New Tab to the Right" become the next sibling of
  // their base tab: same parent, right after it.
  _placeNextSibling(state, tab, source, window) {
    const parent = state.nodes.get(source)?.parent || null;
    if (parent) {
      this.attachTab(tab, parent, { insertAfter: source });
      return;
    }
    this.detachTab(tab);
    const sourceIndex = state.roots.indexOf(source);
    if (sourceIndex !== -1) {
      this._addRoot(state, tab, sourceIndex + 1);
    }
    this._notifyStructureChanged(window);
  },

  _detachChildrenToRoots(state, tab) {
    const node = state.nodes.get(tab);
    if (!node || node.children.length === 0) {
      return;
    }
    const children = node.children.slice();
    node.children = [];
    let insertIndex = state.roots.length;
    if (!node.parent) {
      const rootIndex = state.roots.indexOf(tab);
      if (rootIndex !== -1) {
        insertIndex = rootIndex + 1;
      }
    }
    for (const child of children) {
      const childNode = this._ensureNode(state, child);
      childNode.parent = null;
      this._addRoot(state, child, insertIndex);
      insertIndex += 1;
    }
  },

  // The children stay behind when their parent moves away: the first child
  // takes the parent's place in the tree and the rest become its children.
  _detachChildrenForMove(state, tab) {
    const node = state.nodes.get(tab);
    if (!node || node.children.length === 0) {
      return;
    }
    const children = node.children.slice();
    node.children = [];
    const [first, ...rest] = children;

    const parent = node.parent;
    const container = parent ? state.nodes.get(parent)?.children : state.roots;
    if (container) {
      let insertIndex = container.indexOf(tab);
      insertIndex = insertIndex === -1 ? container.length : insertIndex + 1;
      container.splice(insertIndex, 0, first);
    }

    const firstNode = this._ensureNode(state, first);
    firstNode.parent = parent;
    if (rest.length) {
      firstNode.children = firstNode.children.concat(rest);
      for (const child of rest) {
        const childNode = this._ensureNode(state, child);
        childNode.parent = first;
      }
    }
  },

  _removeSubtree(state, tab) {
    const removed = [];
    const stack = [tab];
    const rootNode = state.nodes.get(tab);
    if (rootNode?.parent) {
      const parentNode = state.nodes.get(rootNode.parent);
      if (parentNode) {
        this._removeFromArray(parentNode.children, tab);
      }
    } else {
      this._removeFromArray(state.roots, tab);
    }

    while (stack.length) {
      const current = stack.pop();
      const node = state.nodes.get(current);
      if (!node) {
        continue;
      }
      removed.push(current);
      for (const child of node.children) {
        stack.push(child);
      }
      node.parent = null;
      node.children = [];
      state.nodes.delete(current);
      this._removeFromArray(state.roots, current);
    }

    return removed;
  },

  _snapshotSubtree(state, tab) {
    const rootNode = state.nodes.get(tab);
    const siblings = rootNode?.parent
      ? state.nodes.get(rootNode.parent)?.children || []
      : state.roots;
    const siblingIndex = siblings.indexOf(tab);
    const nodes = [];
    const stack = [tab];
    while (stack.length) {
      const current = stack.pop();
      const node = state.nodes.get(current);
      if (!node) {
        continue;
      }
      nodes.push({
        tab: node.tab,
        parent: node.parent,
        children: node.children.slice(),
        collapsed: node.collapsed,
      });
      for (const child of node.children) {
        stack.push(child);
      }
    }
    return {
      root: tab,
      nodes,
      insertBefore: siblings[siblingIndex + 1] || null,
      insertAfter: siblings[siblingIndex - 1] || null,
      siblingIndex,
    };
  },

  _getRootAncestor(state, tab) {
    let current = tab;
    while (current) {
      const node = state.nodes.get(current);
      if (!node || !node.parent) {
        return current;
      }
      current = node.parent;
    }
    return tab;
  },

  _notify(topic, payload) {
    Services.obs.notifyObservers({ wrappedJSObject: payload }, topic);
  },

  _notifyStructureChanged(window) {
    this._notify("tree-tabs-structure-changed", { window });
  },
};
