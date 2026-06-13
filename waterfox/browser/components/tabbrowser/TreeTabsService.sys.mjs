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

export const TreeTabsService = {
  _windowStates: new Map(),

  get enabled() {
    return this._isEnabled();
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

    if (getBoolPref(PREF_AUTO_EXPAND_ON_ATTACH, true)) {
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
    const { state } = this._getStateForTab(tab, { create: true });
    if (!state || !tab) {
      return;
    }
    this._ensureNode(state, tab);
    const autoAttach = getIntPref(PREF_AUTO_ATTACH, 1);

    if (autoAttach === 0) {
      this.detachTab(tab);
      return;
    }

    if (autoAttach === 1) {
      const opener = info.opener || info.openerTab || tab.openerTab;
      if (opener && !opener.pinned) {
        this.attachTab(tab, opener, { insertAfter: info.insertAfter });
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
  getNewTabAnchor(opener, currentTab) {
    if (!this._isEnabled()) {
      return null;
    }
    const autoAttach = getIntPref(PREF_AUTO_ATTACH, 1);
    let base = null;
    if (autoAttach === 1) {
      base = opener && !opener.pinned ? opener : null;
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
    let anchor = base;
    for (const descendant of this._getDescendantsFromState(state, base)) {
      if (descendant.closing) {
        continue;
      }
      if (descendant._tPos > anchor._tPos) {
        anchor = descendant;
      }
    }
    return anchor;
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

    let behavior = getIntPref(PREF_CLOSE_PARENT_BEHAVIOR, 1);
    if (info.adopted) {
      // The tab moved to another window; its children stay behind, so
      // promote them instead of applying the close behaviour.
      behavior = 1;
    } else if (behavior === 2 && !this._isVerticalMode(window)) {
      // Never close descendants of a tree the user cannot see.
      behavior = 1;
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
        });
      }
      return descendants;
    }

    if (node.children.length) {
      switch (behavior) {
        case 0:
          this._promoteFirstChild(state, tab);
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

  _detachChildrenForMove(state, tab) {
    const node = state.nodes.get(tab);
    if (!node || node.children.length === 0) {
      return;
    }
    const children = node.children.slice();
    node.children = [];

    const parent = node.parent;
    const container = parent ? state.nodes.get(parent)?.children : state.roots;
    if (!container) {
      return;
    }

    let insertIndex = container.indexOf(tab);
    if (insertIndex === -1) {
      insertIndex = container.length;
    } else {
      insertIndex += 1;
    }

    container.splice(insertIndex, 0, ...children);
    for (const child of children) {
      const childNode = this._ensureNode(state, child);
      childNode.parent = parent;
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
    return { root: tab, nodes };
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
