/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TreeTabsService: "resource:///modules/TreeTabsService.sys.mjs",
  TreeTabsStore: "resource:///modules/TreeTabsStore.sys.mjs",
});

const PREF_ENABLED = "browser.tabs.verticalTabs.tree.enabled";
const PREF_AUTO_COLLAPSE_ON_SELECT =
  "browser.tabs.verticalTabs.tree.autoCollapse.onSelect";
const PREF_DOUBLE_CLICK_BEHAVIOR =
  "browser.tabs.verticalTabs.tree.doubleClickBehavior";
const PREF_STICKY_ACTIVE_TAB =
  "browser.tabs.verticalTabs.tree.sticky.activeTab";
const PREF_PROPAGATE_MUTED_STATE =
  "browser.tabs.verticalTabs.tree.propagateMutedState";
const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
const RESTORE_RETRY_TIMEOUT_MS = 10000;

const TREE_CONTEXT_MENU = {
  separator: "context_treeTabCommandsSeparator",
  items: [
    {
      id: "context_collapseTree",
      l10nId: "waterfox-tab-context-collapse-tree",
    },
    {
      id: "context_expandTree",
      l10nId: "waterfox-tab-context-expand-tree",
    },
    {
      id: "context_closeTree",
      l10nId: "waterfox-tab-context-close-tree",
    },
    {
      id: "context_closeDescendants",
      l10nId: "waterfox-tab-context-close-descendants",
    },
    {
      id: "context_collapseAll",
      l10nId: "waterfox-tab-context-collapse-all-trees",
    },
    {
      id: "context_expandAll",
      l10nId: "waterfox-tab-context-expand-all-trees",
    },
  ],
};

// Each browser window gets its own controller, built here and torn down on
// unload. The window scoped globals window.TreeTabsDnD and window.TreeTabsNav
// stay the contract that the Mozilla drag and keyboard hooks reach through.
function createTreeTabsController(window) {
  const document = window.document;

  const TreeTabsDnD = {
    // Set while a tree drag is being dropped. Firefox moves the dropped tabs
    // one at a time, so the TabMove fixup would see half-moved subtrees.
    _suppressMoveFixup: false,

    _getService(tabContainer) {
      return tabContainer?.documentGlobal?.gBrowser?.TreeTabsService || null;
    },

    _isEnabled(tabContainer) {
      return (
        !!tabContainer?.verticalMode &&
        Services.prefs.getBoolPref(PREF_ENABLED, false) &&
        !!this._getService(tabContainer)
      );
    },

    _getDraggedTab(event) {
      const dt = event?.dataTransfer;
      if (!dt || !dt.mozItemCount) {
        return null;
      }
      let types;
      try {
        types = dt.mozTypesAt(0);
      } catch (error) {
        return null;
      }
      if (!types || types[0] != TAB_DROP_TYPE) {
        return null;
      }
      try {
        return dt.mozGetDataAt(TAB_DROP_TYPE, 0) || null;
      } catch (error) {
        return null;
      }
    },

    _isPlacementCandidate(tab, movingSet) {
      return !!(
        tab &&
        tab.classList?.contains("tabbrowser-tab") &&
        !tab.pinned &&
        !tab.closing &&
        !tab.hidden &&
        tab.dataset?.treeHidden != "true" &&
        !movingSet.has(tab)
      );
    },

    // The dragged tab plus the descendants that travel with it. The drop path
    // gets the expanded list from prepareDrop; the dragover preview rebuilds it
    // from the live tree.
    _getMovingSet(draggedTab, state) {
      const moving = new Set();
      if (draggedTab) {
        moving.add(draggedTab);
      }
      if (Array.isArray(state?.movingTabs) && state.movingTabs.length) {
        for (const tab of state.movingTabs) {
          moving.add(tab);
        }
      } else if (draggedTab) {
        const service = this._getService(window.gBrowser.tabContainer);
        for (const tab of service?.getDescendants(draggedTab) || []) {
          moving.add(tab);
        }
      }
      return moving;
    },

    _getIndentUnit() {
      const px = Services.prefs.getIntPref(
        "browser.tabs.verticalTabs.tree.indentPx",
        16
      );
      return px > 0 ? px : 16;
    },

    _isRTL() {
      return (
        window.getComputedStyle(window.gBrowser.tabContainer).direction == "rtl"
      );
    },

    // How far the gesture has travelled along the inline axis since it began,
    // in CSS pixels. Mozilla records the start position in _dragData.screenX.
    // Positive means dragged toward deeper nesting, negative toward the root.
    // A null event means there is no gesture, e.g. the TabMove fixup.
    _getHorizontalDrag(draggedTab, event) {
      const startX = draggedTab?._dragData?.screenX;
      if (!event || typeof startX != "number") {
        return 0;
      }
      const delta = event.screenX - startX;
      return this._isRTL() ? -delta : delta;
    },

    // The depth the dragged tab should land at, from how far it was dragged
    // sideways, clamped so the tree stays consistent with the flat tab order:
    // never shallower than the row below, never deeper than one under the row
    // above.
    _chooseLevel(service, prev, next, draggedTab, event) {
      const prevLevel = service.getLevel(prev);
      const originalLevel = service.getLevel(draggedTab);
      const steps = Math.round(
        this._getHorizontalDrag(draggedTab, event) / this._getIndentUnit()
      );
      const minLevel = next ? service.getLevel(next) : 0;
      const maxLevel = prevLevel + 1;
      return Math.max(minLevel, Math.min(originalLevel + steps, maxLevel));
    },

    // Decide the parent and preceding sibling for the dragged tab from its
    // neighbours in the flat list after Mozilla has moved it, plus the sideways
    // drag depth.
    _resolvePlacement(draggedTab, event, state) {
      const service = this._getService(window.gBrowser.tabContainer);
      if (!service) {
        return null;
      }
      const tabs = Array.from(window.gBrowser.tabs);
      const draggedIndex = tabs.indexOf(draggedTab);
      if (draggedIndex < 0) {
        return null;
      }
      const movingSet = this._getMovingSet(draggedTab, state);

      let prev = null;
      for (let i = draggedIndex - 1; i >= 0; i -= 1) {
        if (this._isPlacementCandidate(tabs[i], movingSet)) {
          prev = tabs[i];
          break;
        }
      }
      if (!prev) {
        return { parent: null, insertAfter: null };
      }

      let next = null;
      for (let i = draggedIndex + 1; i < tabs.length; i += 1) {
        if (this._isPlacementCandidate(tabs[i], movingSet)) {
          next = tabs[i];
          break;
        }
      }

      const prevLevel = service.getLevel(prev);
      const level = this._chooseLevel(service, prev, next, draggedTab, event);
      if (level > prevLevel) {
        return { parent: prev, insertAfter: null };
      }

      const chain = [prev, ...service.getAncestors(prev)];
      const atLevel = wanted => chain[prevLevel - wanted] || null;
      if (level <= 0) {
        return { parent: null, insertAfter: atLevel(0) };
      }
      const parent = atLevel(level - 1);
      if (!parent || movingSet.has(parent)) {
        return null;
      }
      return { parent, insertAfter: atLevel(level) };
    },

    _applyPlacement(draggedTab, placement) {
      const service = this._getService(window.gBrowser.tabContainer);
      if (!service || !placement) {
        return false;
      }
      const { parent, insertAfter } = placement;
      if (parent) {
        return service.attachTab(
          draggedTab,
          parent,
          insertAfter ? { insertAfter } : { index: 0 }
        );
      }

      service.detachTab(draggedTab);
      const roots = service.getRootTabs(window);
      const currentIndex = roots.indexOf(draggedTab);
      let target = 0;
      if (insertAfter) {
        const anchorIndex = roots.indexOf(insertAfter);
        if (anchorIndex >= 0) {
          target = anchorIndex + 1;
        }
      }
      if (currentIndex >= 0 && currentIndex < target) {
        target -= 1;
      }
      if (currentIndex != target) {
        service.moveTabSubtree(draggedTab, target);
      }
      return true;
    },

    // The parent the dragged tab would nest under at the current pointer, used
    // to draw the dragover outline. Mirrors _resolvePlacement but finds the row
    // above from the pointer's vertical position, since the tab has not moved
    // yet.
    _previewDropParent(event, draggedTab) {
      const service = this._getService(window.gBrowser.tabContainer);
      if (!service) {
        return null;
      }
      const movingSet = this._getMovingSet(draggedTab, null);
      const candidates = Array.from(window.gBrowser.tabs).filter(tab =>
        this._isPlacementCandidate(tab, movingSet)
      );

      let prev = null;
      let next = null;
      for (const tab of candidates) {
        const rect = tab.getBoundingClientRect();
        if (!rect.height) {
          continue;
        }
        if (rect.top + rect.height / 2 <= event.clientY) {
          prev = tab;
        } else {
          next = tab;
          break;
        }
      }
      if (!prev) {
        return null;
      }

      const prevLevel = service.getLevel(prev);
      const level = this._chooseLevel(service, prev, next, draggedTab, event);
      if (level > prevLevel) {
        return prev;
      }
      if (level <= 0) {
        return null;
      }
      const chain = [prev, ...service.getAncestors(prev)];
      const parent = chain[prevLevel - (level - 1)] || null;
      return parent && !movingSet.has(parent) ? parent : null;
    },

    _collectSubtreeTabs(rootTab, treeService) {
      if (!rootTab || !treeService) {
        return rootTab ? [rootTab] : [];
      }

      let descendants = [];
      try {
        descendants = treeService.getDescendants(rootTab);
      } catch (error) {
        descendants = [];
      }

      if (!descendants.length) {
        return [rootTab];
      }

      const subtreeTabs = new Set([rootTab, ...descendants]);
      const ownerTabs = rootTab.documentGlobal?.gBrowser?.tabs;
      if (!ownerTabs) {
        return [rootTab, ...descendants];
      }
      return Array.from(ownerTabs).filter(tab => subtreeTabs.has(tab));
    },

    prepareDrop(tabContainer, event, { draggedTab, movingTabs, dropEffect }) {
      if (!draggedTab) {
        return null;
      }

      const state = {
        cancel: false,
        movingTabs,
        crossWindowSnapshot: null,
      };

      if (
        dropEffect != "move" ||
        !this._isEnabled(tabContainer) ||
        draggedTab.multiselected
      ) {
        return state;
      }

      const sourceService =
        draggedTab.documentGlobal?.gBrowser?.TreeTabsService;
      if (!sourceService) {
        return state;
      }

      this._suppressMoveFixup = true;

      // Ctrl detaches the dragged tab's children before the move so they stay
      // behind instead of travelling with it. Alt does the same where Ctrl
      // turns the drag into a copy (Windows and Linux).
      if (event.ctrlKey || event.altKey) {
        sourceService.onTabMoved(draggedTab, { detachChildren: true });
        return state;
      }

      const subtreeTabs = this._collectSubtreeTabs(draggedTab, sourceService);
      if (subtreeTabs.length > movingTabs.length) {
        state.movingTabs = subtreeTabs;
      }

      if (draggedTab.container != tabContainer && subtreeTabs.length > 1) {
        state.crossWindowSnapshot = sourceService.onTabDetached(draggedTab);
      }

      return state;
    },

    afterSameWindowDrop(
      tabContainer,
      event,
      { draggedTab, dropEffect, state }
    ) {
      this._suppressMoveFixup = false;
      if (
        dropEffect != "move" ||
        !this._isEnabled(tabContainer) ||
        draggedTab?.multiselected ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      const placement = this._resolvePlacement(draggedTab, event, state);
      if (placement && this._applyPlacement(draggedTab, placement)) {
        // A child attach only fires events for the moved tab and its parents,
        // so announce a structure change to refresh every row and fix up the
        // indentation of any descendants that came along with it.
        Services.obs.notifyObservers(
          { wrappedJSObject: { window } },
          "tree-tabs-structure-changed"
        );
      }
    },

    _restoreAdoptedSubtree(tabContainer, snapshot, adoptedTabMap) {
      if (
        !snapshot ||
        !snapshot.root ||
        !adoptedTabMap ||
        !adoptedTabMap.size ||
        !this._isEnabled(tabContainer)
      ) {
        return;
      }

      const service = this._getService(tabContainer);
      if (!service) {
        return;
      }

      const oldNodesByTab = new Map();
      for (const node of snapshot.nodes || []) {
        oldNodesByTab.set(node.tab, node);
      }

      const oldRootTab = snapshot.root;
      const newRootTab = adoptedTabMap.get(oldRootTab);
      if (!newRootTab) {
        return;
      }

      service.detachTab(newRootTab);

      const attachChildren = oldParentTab => {
        const oldParentNode = oldNodesByTab.get(oldParentTab);
        const newParentTab = adoptedTabMap.get(oldParentTab);
        if (!oldParentNode || !newParentTab) {
          return;
        }

        let previousNewChild = null;
        for (const oldChildTab of oldParentNode.children || []) {
          const newChildTab = adoptedTabMap.get(oldChildTab);
          if (!newChildTab) {
            continue;
          }

          if (previousNewChild) {
            service.attachTab(newChildTab, newParentTab, {
              insertAfter: previousNewChild,
            });
          } else {
            service.attachTab(newChildTab, newParentTab, { index: 0 });
          }

          attachChildren(oldChildTab);
          previousNewChild = newChildTab;
        }
      };

      attachChildren(oldRootTab);

      for (const node of snapshot.nodes || []) {
        const newTab = adoptedTabMap.get(node.tab);
        if (!newTab) {
          continue;
        }
        if (node.collapsed) {
          service.collapseSubtree(newTab);
        } else {
          service.expandSubtree(newTab);
        }
      }
    },

    afterCrossWindowDrop(
      tabContainer,
      event,
      { draggedTab, dropEffect, adoptedDraggedTab, adoptedTabMap, state }
    ) {
      this._suppressMoveFixup = false;
      if (
        dropEffect != "move" ||
        !this._isEnabled(tabContainer) ||
        draggedTab?.multiselected ||
        event.ctrlKey ||
        event.altKey
      ) {
        return null;
      }

      // Moving a subtree to another window keeps its shape; nesting it against
      // a target in the new window is left to a later pass.
      if (state?.crossWindowSnapshot) {
        this._restoreAdoptedSubtree(
          tabContainer,
          state.crossWindowSnapshot,
          adoptedTabMap
        );
        if (adoptedDraggedTab) {
          return adoptedDraggedTab;
        }
      }
      return null;
    },
  };

  window.TreeTabsDnD = TreeTabsDnD;

  const TreeTabsNav = {
    _patchedTabContainer: null,
    _originalCanAdvanceToTab: null,

    patch(tabContainer) {
      if (!tabContainer || this._patchedTabContainer == tabContainer) {
        return;
      }

      this.unpatch(this._patchedTabContainer);

      const originalCanAdvanceToTab = tabContainer._canAdvanceToTab;
      if (typeof originalCanAdvanceToTab != "function") {
        return;
      }

      this._originalCanAdvanceToTab = originalCanAdvanceToTab;
      this._patchedTabContainer = tabContainer;

      tabContainer._canAdvanceToTab = function (tab) {
        const canAdvance = originalCanAdvanceToTab.call(this, tab);
        if (!canAdvance) {
          return false;
        }
        return !window.TreeTabsNav?.shouldSkipTab?.(tab);
      };
    },

    unpatch(tabContainer) {
      if (!tabContainer || this._patchedTabContainer != tabContainer) {
        return;
      }
      if (this._originalCanAdvanceToTab) {
        tabContainer._canAdvanceToTab = this._originalCanAdvanceToTab;
      }
      this._originalCanAdvanceToTab = null;
      this._patchedTabContainer = null;
    },

    shouldSkipTab(tab) {
      if (!Services.prefs.getBoolPref(PREF_ENABLED, false)) {
        return false;
      }
      // Collapse state can linger from vertical mode, but the horizontal
      // strip shows every tab, so none of them may be skipped there.
      if (!window.gBrowser?.tabContainer?.verticalMode) {
        return false;
      }
      return tab?.dataset?.treeHidden == "true";
    },
  };

  window.TreeTabsNav = TreeTabsNav;

  const controller = {
    _initialized: false,
    _tabContainer: null,
    _verticalTabsBox: null,
    _dropTargetTab: null,
    _twistyHoverTab: null,
    _twistyInlinePaddingPx: null,
    _resizeObserver: null,
    _tabContextMenu: null,
    _isWindowRestoring: false,
    _autoCollapseInProgress: false,
    _autoCollapseSuppressDepth: 0,
    _restoreRetryActive: false,
    _restoreRetryTimerId: null,
    _inheritedMuteTabs: new WeakSet(),
    _hiddenTabParents: new Map(),

    init() {
      if (this._initialized) {
        return;
      }

      if (!window.gBrowser?.tabContainer) {
        window.setTimeout(() => this.init(), 50);
        return;
      }

      this._initialized = true;
      this._tabContainer = window.gBrowser.tabContainer;
      this._verticalTabsBox = document.getElementById("vertical-tabs");
      this._tabContextMenu = document.getElementById("tabContextMenu");
      TreeTabsNav.patch(this._tabContainer);

      lazy.TreeTabsStore.initWindow(window);

      Services.prefs.addObserver(PREF_ENABLED, this);
      Services.prefs.addObserver(PREF_STICKY_ACTIVE_TAB, this);
      Services.obs.addObserver(this, "tree-tabs-attached");
      Services.obs.addObserver(this, "tree-tabs-detached");
      Services.obs.addObserver(this, "tree-tabs-subtree-collapsed-changed");
      Services.obs.addObserver(this, "tree-tabs-structure-changed");
      Services.obs.addObserver(this, "tree-tabs-close-requested");
      window.addEventListener("SSWindowRestoring", this, true);
      window.addEventListener("SSWindowRestored", this, true);

      this._tabContainer.addEventListener("TabOpen", this);
      this._tabContainer.addEventListener("TabClose", this);
      this._tabContainer.addEventListener("TabMove", this);
      this._tabContainer.addEventListener("TabPinned", this);
      this._tabContainer.addEventListener("TabAttrModified", this);
      this._tabContainer.addEventListener("TabHide", this);
      this._tabContainer.addEventListener("TabShow", this);
      this._tabContainer.addEventListener("TabSelect", this);
      this._tabContainer.addEventListener("SSTabRestored", this);
      this._tabContainer.addEventListener("mousemove", this);
      this._tabContainer.addEventListener("mouseleave", this);
      this._tabContainer.addEventListener("mousedown", this);
      this._tabContainer.addEventListener("click", this);
      this._tabContainer.addEventListener("dblclick", this);
      this._tabContainer.addEventListener("keydown", this);
      this._tabContainer.addEventListener("dragover", this);
      this._tabContainer.addEventListener("drop", this);
      this._tabContainer.addEventListener("dragleave", this);
      this._tabContainer.addEventListener("dragend", this);
      window.addEventListener("resize", this);

      if (this._verticalTabsBox) {
        this._resizeObserver = new window.ResizeObserver(() => {
          this._invalidateTwistyHitMetrics();
          if (this._isEnabled()) {
            this._updateAllTabs();
          }
        });
        this._resizeObserver.observe(this._verticalTabsBox);
      }

      this._tabContextMenu?.addEventListener("popupshowing", this);
      this._tabContextMenu?.addEventListener("command", this);

      this._maybeRestoreTreeStructure();
      this._updateEnabledState();
    },

    destroy() {
      if (!this._initialized) {
        return;
      }
      this._initialized = false;

      lazy.TreeTabsStore.uninitWindow(window);
      lazy.TreeTabsService.uninit(window);

      Services.prefs.removeObserver(PREF_ENABLED, this);
      Services.prefs.removeObserver(PREF_STICKY_ACTIVE_TAB, this);
      Services.obs.removeObserver(this, "tree-tabs-attached");
      Services.obs.removeObserver(this, "tree-tabs-detached");
      Services.obs.removeObserver(this, "tree-tabs-subtree-collapsed-changed");
      Services.obs.removeObserver(this, "tree-tabs-structure-changed");
      Services.obs.removeObserver(this, "tree-tabs-close-requested");
      window.removeEventListener("SSWindowRestoring", this, true);
      window.removeEventListener("SSWindowRestored", this, true);

      this._tabContainer?.removeEventListener("TabOpen", this);
      this._tabContainer?.removeEventListener("TabClose", this);
      this._tabContainer?.removeEventListener("TabMove", this);
      this._tabContainer?.removeEventListener("TabPinned", this);
      this._tabContainer?.removeEventListener("TabAttrModified", this);
      this._tabContainer?.removeEventListener("TabHide", this);
      this._tabContainer?.removeEventListener("TabShow", this);
      this._tabContainer?.removeEventListener("TabSelect", this);
      this._tabContainer?.removeEventListener("SSTabRestored", this);
      this._tabContainer?.removeEventListener("mousemove", this);
      this._tabContainer?.removeEventListener("mouseleave", this);
      this._tabContainer?.removeEventListener("mousedown", this);
      this._tabContainer?.removeEventListener("click", this);
      this._tabContainer?.removeEventListener("dblclick", this);
      this._tabContainer?.removeEventListener("keydown", this);
      this._tabContainer?.removeEventListener("dragover", this);
      this._tabContainer?.removeEventListener("drop", this);
      this._tabContainer?.removeEventListener("dragleave", this);
      this._tabContainer?.removeEventListener("dragend", this);
      window.removeEventListener("resize", this);
      this._resizeObserver?.disconnect();
      this._resizeObserver = null;

      this._tabContextMenu?.removeEventListener("popupshowing", this);
      this._tabContextMenu?.removeEventListener("command", this);

      this._clearDropTarget();
      this._setTwistyHoverTab(null);
      this._setTreeContextMenuHidden(true);
      this._stopRestoreRetry({ clearGuard: true });
      TreeTabsNav.unpatch(this._tabContainer);

      this._tabContainer = null;
      this._verticalTabsBox = null;
      this._tabContextMenu = null;
      this._twistyHoverTab = null;
      this._twistyInlinePaddingPx = null;
      this._resizeObserver = null;
      this._isWindowRestoring = false;
      this._autoCollapseInProgress = false;
      this._autoCollapseSuppressDepth = 0;
      this._restoreRetryActive = false;
      this._restoreRetryTimerId = null;
      this._inheritedMuteTabs = new WeakSet();
      this._hiddenTabParents.clear();
      this._hiddenTabParents = new Map();

      if (window.TreeTabsDnD == TreeTabsDnD) {
        delete window.TreeTabsDnD;
      }
      if (window.TreeTabsNav == TreeTabsNav) {
        delete window.TreeTabsNav;
      }
    },

    _handleTabOpen(event) {
      if (!this._isEnabled()) {
        return;
      }
      this._updateTab(event.target);
      this._updateHiddenTabs();
      this._maybeTryManualRestore();
    },

    _handleTabClose(event) {
      this._forgetHiddenTabReferences(event.target);
      this._inheritedMuteTabs.delete(event.target);
      if (!this._isEnabled()) {
        return;
      }
      if (event.detail?.adoptedBy) {
        // Adoption closes the source tab through _beginRemoveTab and skips
        // removeTab, so the model never hears about it there.
        lazy.TreeTabsService.onTabClosed(event.target, { adopted: true });
      }
      this._updateAllTabs();
    },

    handleEvent(event) {
      switch (event.type) {
        case "TabOpen":
          this._handleTabOpen(event);
          break;
        case "TabClose":
          this._handleTabClose(event);
          break;
        case "TabMove":
          if (!this._isEnabled()) {
            return;
          }
          this._maybeFixupTreeOnExternalMove(event.target);
          this._updateAllTabs();
          this._maybeTryManualRestore();
          break;
        case "TabPinned":
          this._handleTabPinned(event.target);
          break;
        case "SSTabRestored":
          this._maybeTryManualRestore();
          break;
        case "SSWindowRestoring":
          this._isWindowRestoring = true;
          break;
        case "SSWindowRestored":
          this._isWindowRestoring = false;
          this._maybeRestoreTreeStructure();
          break;
        case "TabSelect":
          if (!this._isEnabled()) {
            return;
          }
          this._maybeAutoCollapseOnSelect(event);
          this._revealSelectedTab(event.target);
          this._updateHiddenTabs();
          break;
        case "TabAttrModified": {
          const tab = event.target;
          const changed = event.detail?.changed || [];
          if (Array.isArray(changed) && changed.includes("muted")) {
            this._handleMutedStateChange(tab);
          }
          break;
        }
        case "TabHide":
        case "TabShow":
          this._handleTabHiddenChange(event.target);
          break;
        case "mousemove":
          this._handleTabTwistyMouseMove(event);
          break;
        case "mouseleave":
          this._setTwistyHoverTab(null);
          break;
        case "mousedown":
          this._handleTabTwistyMouseDown(event);
          break;
        case "click":
          this._handleTabTwistyClick(event);
          break;
        case "dblclick":
          this._handleTabDoubleClick(event);
          break;
        case "keydown":
          this._handleTabTreeKeyDown(event);
          break;
        case "dragover":
          if (!this._isEnabled()) {
            this._clearDropTarget();
            return;
          }
          this._updateDropTarget(event);
          break;
        case "resize":
          this._invalidateTwistyHitMetrics();
          break;
        case "dragleave":
        case "drop":
          this._clearDropTarget();
          break;
        case "dragend":
          // Fires even when the drop never reached one of the after* hooks,
          // e.g. a drop that only pinned or grouped the tab.
          TreeTabsDnD._suppressMoveFixup = false;
          this._clearDropTarget();
          break;
        case "popupshowing":
          if (event.target == this._tabContextMenu) {
            this._updateTreeContextMenuVisibility();
          }
          break;
        case "command":
          this._handleTreeContextMenuCommand(event);
          break;
        default:
          break;
      }
    },

    observe(subject, topic, data) {
      if (topic == "nsPref:changed") {
        if (data == PREF_ENABLED) {
          this._updateEnabledState();
        } else if (data == PREF_STICKY_ACTIVE_TAB && this._isEnabled()) {
          this._updateHiddenTabs();
        }
        return;
      }

      if (topic == "tree-tabs-close-requested") {
        const payload = subject?.wrappedJSObject ?? subject;
        if (payload?.window != window) {
          return;
        }
        this._withAutoCollapseSuppressed(() => {
          const tabsToClose = (payload.tabs || []).filter(
            tab => tab && !tab.closing
          );
          if (tabsToClose.length) {
            window.gBrowser.removeTabs(tabsToClose);
          }
        });
        return;
      }

      if (!this._isEnabled()) {
        return;
      }

      const payload = subject?.wrappedJSObject ?? subject;
      switch (topic) {
        case "tree-tabs-attached":
        case "tree-tabs-detached":
          if (payload?.tab && this._ownsTab(payload.tab)) {
            this._updateTab(payload.tab);
          }
          if (payload?.parent && this._ownsTab(payload.parent)) {
            this._updateTab(payload.parent);
          }
          if (
            payload?.previousParent &&
            this._ownsTab(payload.previousParent)
          ) {
            this._updateTab(payload.previousParent);
          }
          this._updateHiddenTabs();
          break;
        case "tree-tabs-subtree-collapsed-changed":
          if (payload?.tab && this._ownsTab(payload.tab)) {
            this._updateTab(payload.tab);
            if (payload.collapsed) {
              this._moveSelectionOutOfCollapsedSubtree(payload.tab);
            }
            this._updateHiddenTabs();
          }
          break;
        case "tree-tabs-structure-changed":
          if (payload?.window == window) {
            this._updateAllTabs();
          }
          break;
        default:
          break;
      }
    },

    _isEnabled() {
      return Services.prefs.getBoolPref(PREF_ENABLED, false);
    },

    _getDoubleClickBehavior() {
      return Services.prefs.getIntPref(PREF_DOUBLE_CLICK_BEHAVIOR, 0);
    },

    _isStickyActiveTabEnabled() {
      return Services.prefs.getBoolPref(PREF_STICKY_ACTIVE_TAB, false);
    },

    _shouldPropagateMutedState() {
      return Services.prefs.getBoolPref(PREF_PROPAGATE_MUTED_STATE, true);
    },

    _handleMutedStateChange(tab) {
      if (
        !this._isEnabled() ||
        !this._shouldPropagateMutedState() ||
        !tab ||
        tab.closing ||
        !this._ownsTab(tab)
      ) {
        return;
      }

      const descendants = lazy.TreeTabsService.getDescendants(tab);
      if (!descendants.length) {
        return;
      }

      const isMuted = tab.linkedBrowser?.audioMuted;
      if (isMuted && !lazy.TreeTabsService.isCollapsed(tab)) {
        return;
      }

      for (const child of descendants) {
        if (!child?.linkedBrowser || child.closing || !this._ownsTab(child)) {
          continue;
        }

        if (isMuted) {
          // Only propagate mute to descendants currently hidden by tree collapse.
          if (child.dataset.treeHidden != "true") {
            continue;
          }
          if (!child.linkedBrowser.audioMuted) {
            child.toggleMuteAudio();
            this._inheritedMuteTabs.add(child);
          }
          continue;
        }

        if (!this._inheritedMuteTabs.has(child)) {
          continue;
        }

        if (child.linkedBrowser.audioMuted) {
          child.toggleMuteAudio();
        }
        this._inheritedMuteTabs.delete(child);
      }
    },

    _handleTabHiddenChange(tab) {
      if (!this._isEnabled() || !tab || !this._ownsTab(tab) || tab.closing) {
        return;
      }

      // Ignore tree visibility state managed by data-tree-hidden.
      if (tab.hasAttribute("data-tree-hidden")) {
        return;
      }

      if (tab.hidden) {
        const parent = lazy.TreeTabsService.getParent(tab);
        if (parent && !parent.closing) {
          this._hiddenTabParents.set(tab, parent);
          lazy.TreeTabsService.detachTab(tab);
        }
      } else {
        const savedParent = this._hiddenTabParents.get(tab);
        if (
          savedParent &&
          !savedParent.closing &&
          this._ownsTab(savedParent) &&
          !savedParent.hidden
        ) {
          lazy.TreeTabsService.attachTab(tab, savedParent);
        }
        this._hiddenTabParents.delete(tab);
      }

      this._updateAllTabs();
      this._updateHiddenTabs();
    },

    // Pinned tabs live in their own container and cannot collapse, so a
    // pinned tab leaves the tree and its children take its place.
    _handleTabPinned(tab) {
      if (!this._isEnabled() || !tab || !this._ownsTab(tab)) {
        return;
      }
      this._withAutoCollapseSuppressed(() => {
        const service = lazy.TreeTabsService;
        service.expandSubtree(tab);
        const parent = service.getParent(tab);
        service.detachAllChildren(tab, parent ? { reparentTo: parent } : {});
        service.detachTab(tab);
      });
      this._updateAllTabs();
    },

    _forgetHiddenTabReferences(tab) {
      if (!tab || !this._hiddenTabParents.size) {
        return;
      }

      this._hiddenTabParents.delete(tab);
      for (const [hiddenTab, savedParent] of this._hiddenTabParents) {
        if (savedParent == tab || hiddenTab == tab) {
          this._hiddenTabParents.delete(hiddenTab);
        }
      }
    },

    _hasTreeStructure() {
      for (const tab of window.gBrowser.tabs) {
        if (lazy.TreeTabsService.getParent(tab)) {
          return true;
        }
        if (lazy.TreeTabsService.getChildren(tab).length) {
          return true;
        }
      }
      return false;
    },

    _maybeRestoreTreeStructure() {
      if (!this._isEnabled()) {
        return;
      }

      if (!window.gBrowser?.tabs?.length) {
        return;
      }

      if (this._hasTreeStructure()) {
        return;
      }

      this._startRestoreRetry();
      this._maybeTryManualRestore();
    },

    _startRestoreRetry() {
      if (this._restoreRetryActive) {
        return;
      }

      this._restoreRetryActive = true;
      lazy.TreeTabsStore.ensureRestoreGuard(window);

      this._restoreRetryTimerId = window.setTimeout(() => {
        this._stopRestoreRetry({ clearGuard: true });
      }, RESTORE_RETRY_TIMEOUT_MS);
    },

    _stopRestoreRetry({ clearGuard = false } = {}) {
      this._restoreRetryActive = false;

      if (this._restoreRetryTimerId) {
        window.clearTimeout(this._restoreRetryTimerId);
        this._restoreRetryTimerId = null;
      }

      if (clearGuard) {
        lazy.TreeTabsStore.clearRestoreGuard(window);
      }
    },

    _maybeTryManualRestore() {
      if (!this._restoreRetryActive || !this._isEnabled()) {
        return;
      }
      if (!window.gBrowser?.tabs?.length) {
        return;
      }

      if (lazy.TreeTabsStore.tryManualRestore(window)) {
        this._updateAllTabs();
        this._stopRestoreRetry();
      }
    },

    _isAutoCollapseOnSelectEnabled() {
      return Services.prefs.getBoolPref(PREF_AUTO_COLLAPSE_ON_SELECT, true);
    },

    _withAutoCollapseSuppressed(callback) {
      this._autoCollapseSuppressDepth += 1;
      try {
        return callback();
      } finally {
        this._autoCollapseSuppressDepth = Math.max(
          0,
          this._autoCollapseSuppressDepth - 1
        );
      }
    },

    _isUserInitiatedTabSelection(event) {
      if (!event?.isTrusted) {
        return false;
      }
      if (!window.windowUtils?.isHandlingUserInput) {
        return false;
      }
      if (this._isWindowRestoring || this._autoCollapseInProgress) {
        return false;
      }
      if (this._autoCollapseSuppressDepth > 0) {
        return false;
      }
      if (this._tabContainer?.hasAttribute("movingtab")) {
        return false;
      }
      return true;
    },

    _getTreeRoot(tab) {
      if (!tab) {
        return null;
      }
      let root = tab;
      let parent = lazy.TreeTabsService.getParent(root);
      while (parent) {
        root = parent;
        parent = lazy.TreeTabsService.getParent(root);
      }
      return root;
    },

    _maybeAutoCollapseOnSelect(event) {
      if (
        !this._isEnabled() ||
        !this._tabContainer?.verticalMode ||
        !this._isAutoCollapseOnSelectEnabled()
      ) {
        return;
      }
      if (!this._isUserInitiatedTabSelection(event)) {
        return;
      }

      const selectedTab = event?.target;
      if (!selectedTab || !this._ownsTab(selectedTab) || selectedTab.closing) {
        return;
      }

      this._autoCollapseInProgress = true;
      try {
        const ancestors = lazy.TreeTabsService.getAncestors(selectedTab);
        for (let i = ancestors.length - 1; i >= 0; i -= 1) {
          lazy.TreeTabsService.expandSubtree(ancestors[i]);
        }

        const selectedRoot = this._getTreeRoot(selectedTab);
        if (!selectedRoot) {
          return;
        }
        lazy.TreeTabsService.expandSubtree(selectedRoot);

        for (const root of lazy.TreeTabsService.getRootTabs(window)) {
          if (root == selectedRoot) {
            continue;
          }
          if (
            lazy.TreeTabsService.getChildren(root).length &&
            !lazy.TreeTabsService.isCollapsed(root)
          ) {
            lazy.TreeTabsService.collapseSubtree(root);
          }
        }
      } finally {
        this._autoCollapseInProgress = false;
      }
    },

    // Selection can land on a tab hidden by a collapsed ancestor, e.g. the
    // successor picked when the active tab closes, since Firefox does not
    // know about tree visibility. An invisible active tab is worse than
    // expanding the tree, so reveal it.
    _revealSelectedTab(tab) {
      if (
        !tab ||
        tab.closing ||
        !this._ownsTab(tab) ||
        this._isWindowRestoring ||
        this._isStickyActiveTabEnabled() ||
        !lazy.TreeTabsService.isSubtreeCollapsed(tab)
      ) {
        return;
      }
      this._withAutoCollapseSuppressed(() => {
        const ancestors = lazy.TreeTabsService.getAncestors(tab);
        for (let i = ancestors.length - 1; i >= 0; i -= 1) {
          lazy.TreeTabsService.expandSubtree(ancestors[i]);
        }
      });
    },

    // The inverse case: a collapse is hiding the active tab, so selection
    // moves to the nearest visible ancestor, like closing a folder in a
    // file manager.
    _moveSelectionOutOfCollapsedSubtree(collapsedRoot) {
      if (this._isStickyActiveTabEnabled()) {
        return;
      }
      const selected = window.gBrowser?.selectedTab;
      if (
        !selected ||
        selected == collapsedRoot ||
        !lazy.TreeTabsService.getAncestors(selected).includes(collapsedRoot) ||
        !lazy.TreeTabsService.isSubtreeCollapsed(selected)
      ) {
        return;
      }
      let target = collapsedRoot;
      while (target && lazy.TreeTabsService.isSubtreeCollapsed(target)) {
        target = lazy.TreeTabsService.getParent(target);
      }
      if (target && !target.closing) {
        this._withAutoCollapseSuppressed(() => this._focusTab(target));
      }
    },

    // Repair the tree after a move the tree DnD did not make, e.g. "Move
    // Tab to Start" or an extension calling tabs.move. The moved tab keeps
    // children that still sit directly behind it, sheds the rest, and then
    // re-attaches by the same neighbour rules as a gesture-less drop.
    _maybeFixupTreeOnExternalMove(tab) {
      if (
        TreeTabsDnD._suppressMoveFixup ||
        !tab ||
        tab.pinned ||
        tab.group ||
        tab.closing ||
        !this._ownsTab(tab) ||
        !this._tabContainer?.verticalMode ||
        this._isWindowRestoring ||
        lazy.TreeTabsStore._restoringWindows?.has(window)
      ) {
        return;
      }
      const service = lazy.TreeTabsService;
      if (service.getChildren(tab).length && !this._isSubtreeContiguous(tab)) {
        service.onTabMoved(tab, { detachChildren: true });
      }
      const placement = TreeTabsDnD._resolvePlacement(tab, null, null);
      if (placement) {
        TreeTabsDnD._applyPlacement(tab, placement);
      }
    },

    _isSubtreeContiguous(tab) {
      const descendants = lazy.TreeTabsService.getDescendants(tab);
      if (!descendants.length) {
        return true;
      }
      let min = Infinity;
      let max = -Infinity;
      for (const descendant of descendants) {
        min = Math.min(min, descendant._tPos);
        max = Math.max(max, descendant._tPos);
      }
      return min == tab._tPos + 1 && max - tab._tPos == descendants.length;
    },

    _ownsTab(tab) {
      return tab?.documentGlobal == window;
    },

    _getTabFromEvent(event) {
      let node = event?.target;
      while (node && node != this._tabContainer) {
        if (node.classList?.contains("tabbrowser-tab")) {
          return node;
        }
        node = node.parentNode;
      }
      return null;
    },

    _getTabFromClientY(clientY) {
      if (typeof clientY != "number") {
        return null;
      }
      for (const tab of window.gBrowser.tabs) {
        if (!tab || tab.closing) {
          continue;
        }
        const rect = tab.getBoundingClientRect();
        if (rect.height && clientY >= rect.top && clientY <= rect.bottom) {
          return tab;
        }
      }
      return null;
    },

    _invalidateTwistyHitMetrics() {
      this._twistyInlinePaddingPx = null;
    },

    _getTwistyInlinePadding(tab, computedStyle = null) {
      if (this._twistyInlinePaddingPx !== null) {
        return this._twistyInlinePaddingPx;
      }

      const style = computedStyle ?? window.getComputedStyle(tab);
      this._twistyInlinePaddingPx =
        parseFloat(style.getPropertyValue("--tab-inline-padding")) || 8;
      return this._twistyInlinePaddingPx;
    },

    _getTwistyContentInlinePadding(tab) {
      const tabContent = tab.querySelector(".tab-content");
      if (!tabContent) {
        return 0;
      }
      const padding = window.getComputedStyle(tabContent).paddingInlineStart;
      return parseFloat(padding) || 0;
    },

    _getTwistyTabFromEvent(event) {
      if (
        !this._isEnabled() ||
        !this._tabContainer?.verticalMode ||
        (event?.type != "mousemove" &&
          event?.type != "mouseleave" &&
          event?.button != 0)
      ) {
        return null;
      }

      const tab =
        this._getTabFromEvent(event) || this._getTabFromClientY(event.clientY);
      if (!tab || !this._ownsTab(tab) || tab.closing) {
        return null;
      }

      if (!lazy.TreeTabsService.getChildren(tab).length) {
        return null;
      }

      const rect = tab.getBoundingClientRect();
      if (!rect.width || !rect.height) {
        return null;
      }

      if (event.clientY < rect.top || event.clientY > rect.bottom) {
        return null;
      }

      const style = window.getComputedStyle(tab);
      const inlinePadding = this._getTwistyInlinePadding(tab, style);
      const contentInlinePadding = this._getTwistyContentInlinePadding(tab);
      if (contentInlinePadding <= inlinePadding) {
        return null;
      }

      const direction = style.direction;
      if (direction == "rtl") {
        const hitStart = rect.right - contentInlinePadding;
        const hitEnd = rect.right - inlinePadding;
        if (event.clientX < hitStart || event.clientX > hitEnd) {
          return null;
        }
      } else {
        const hitStart = rect.left + inlinePadding;
        const hitEnd = rect.left + contentInlinePadding;
        if (event.clientX < hitStart || event.clientX > hitEnd) {
          return null;
        }
      }

      return tab;
    },

    _setTwistyHoverTab(tab) {
      if (this._twistyHoverTab == tab) {
        return;
      }
      if (this._twistyHoverTab) {
        this._twistyHoverTab.removeAttribute("data-tree-twisty-hover");
      }
      this._twistyHoverTab = tab || null;
      if (this._twistyHoverTab) {
        this._twistyHoverTab.dataset.treeTwistyHover = "true";
      }
    },

    _handleTabTwistyMouseMove(event) {
      this._setTwistyHoverTab(this._getTwistyTabFromEvent(event));
    },

    _handleTabTwistyMouseDown(event) {
      if (!this._getTwistyTabFromEvent(event)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    },

    _handleTabTwistyClick(event) {
      const tab = this._getTwistyTabFromEvent(event);
      if (!tab) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      this._withAutoCollapseSuppressed(() => {
        lazy.TreeTabsService.toggleCollapsed(tab);
      });
    },

    _closeTreeTabs(tab) {
      const tabsToClose = lazy.TreeTabsService.closeTree(tab).filter(
        tabToClose => tabToClose && !tabToClose.closing
      );
      if (tabsToClose.length) {
        window.gBrowser.removeTabs(tabsToClose);
      }
    },

    _handleTabDoubleClick(event) {
      if (this._getTwistyTabFromEvent(event)) {
        return;
      }

      if (
        !this._isEnabled() ||
        !this._tabContainer?.verticalMode ||
        event?.button != 0
      ) {
        return;
      }

      const tab = this._getTabFromEvent(event);
      if (!tab || !this._ownsTab(tab) || tab.closing) {
        return;
      }

      const behavior = this._getDoubleClickBehavior();
      if (behavior == 2) {
        return;
      }

      if (behavior == 0 && !lazy.TreeTabsService.getChildren(tab).length) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      this._withAutoCollapseSuppressed(() => {
        if (behavior == 1) {
          this._closeTreeTabs(tab);
          return;
        }
        lazy.TreeTabsService.toggleCollapsed(tab);
      });
    },

    _focusTab(tab) {
      if (!tab || tab.closing || tab == window.gBrowser.selectedTab) {
        return;
      }
      window.gBrowser.selectedTab = tab;
    },

    _handleTabTreeKeyDown(event) {
      if (
        !this._isEnabled() ||
        !this._tabContainer?.verticalMode ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }

      if (event.key != "ArrowLeft" && event.key != "ArrowRight") {
        return;
      }

      const tab = this._getTabFromEvent(event) || window.gBrowser?.selectedTab;
      if (!tab || !this._ownsTab(tab) || tab.closing) {
        return;
      }

      const children = lazy.TreeTabsService.getChildren(tab);
      const hasChildren = !!children.length;
      const isCollapsed = hasChildren && lazy.TreeTabsService.isCollapsed(tab);

      if (event.key == "ArrowLeft") {
        if (hasChildren && !isCollapsed) {
          event.preventDefault();
          event.stopPropagation();
          lazy.TreeTabsService.collapseSubtree(tab);
          return;
        }

        const parent = lazy.TreeTabsService.getParent(tab);
        if (parent && !parent.closing) {
          event.preventDefault();
          event.stopPropagation();
          this._focusTab(parent);
        }
        return;
      }

      if (!hasChildren) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (isCollapsed) {
        lazy.TreeTabsService.expandSubtree(tab);
        return;
      }

      const firstChild = children[0];
      if (firstChild && !firstChild.closing) {
        this._focusTab(firstChild);
      }
    },

    _updateEnabledState() {
      const enabled = this._isEnabled();
      if (enabled) {
        lazy.TreeTabsService.init(window);
      }

      if (this._verticalTabsBox) {
        this._verticalTabsBox.toggleAttribute("tree-tabs-enabled", enabled);
      }

      this._updateTreeContextMenuVisibility();

      this._clearDropTarget();
      if (enabled) {
        this._updateAllTabs();
        // Covers enabling mid-session in a window that started with the
        // pref off, where the startup restore never ran.
        this._maybeRestoreTreeStructure();
      } else {
        // Keep the model so toggling the pref back on brings the tree back.
        this._inheritedMuteTabs = new WeakSet();
        this._hiddenTabParents.clear();
        this._clearAllTabs();
      }
    },

    _updateAllTabs() {
      const indentPx = Services.prefs.getIntPref(
        "browser.tabs.verticalTabs.tree.indentPx",
        16
      );
      // Feed the per level indent into the stylesheet variable so the pref
      // drives the visual step, not just the depth clamp below.
      this._verticalTabsBox?.style.setProperty(
        "--tree-indent-unit",
        `${indentPx}px`
      );
      const containerWidth =
        this._verticalTabsBox?.getBoundingClientRect().width || 250;
      const minTabContentWidth = 120;
      const maxIndent = Math.max(0, containerWidth - minTabContentWidth);
      const maxVisualLevel = Math.floor(maxIndent / indentPx);
      for (const tab of window.gBrowser.tabs) {
        this._updateTab(tab, indentPx, maxVisualLevel);
      }
      this._updateHiddenTabs();
    },

    _clearAllTabs() {
      for (const tab of window.gBrowser.tabs) {
        this._clearTab(tab);
      }
    },

    _updateTab(tab, indentPx, maxVisualLevel) {
      if (!tab) {
        return;
      }

      const level = lazy.TreeTabsService.getLevel(tab);
      const indent =
        indentPx ??
        Services.prefs.getIntPref(
          "browser.tabs.verticalTabs.tree.indentPx",
          16
        );
      const containerWidth =
        this._verticalTabsBox?.getBoundingClientRect().width || 250;
      const minContentWidth = 120;
      const dynamicMaxIndent = Math.max(0, containerWidth - minContentWidth);
      const maxLevel = maxVisualLevel ?? Math.floor(dynamicMaxIndent / indent);
      const clampedLevel = Math.min(level, maxLevel);
      tab.dataset.treeLevel = String(level);
      tab.style.setProperty("--tree-level", clampedLevel);

      const parent = lazy.TreeTabsService.getParent(tab);
      if (parent?.linkedPanel) {
        tab.dataset.treeParent = parent.linkedPanel;
      } else {
        tab.removeAttribute("data-tree-parent");
      }

      const children = lazy.TreeTabsService.getChildren(tab);
      if (children.length) {
        tab.dataset.treeHasChildren = "true";
      } else {
        tab.removeAttribute("data-tree-has-children");
      }

      if (lazy.TreeTabsService.isCollapsed(tab)) {
        tab.dataset.treeCollapsed = "true";
      } else {
        tab.removeAttribute("data-tree-collapsed");
      }
    },

    _updateHiddenTabs() {
      const visible = new Set(lazy.TreeTabsService.getVisibleTabs(window));
      const stickyActiveTabEnabled = this._isStickyActiveTabEnabled();
      const selectedTab = stickyActiveTabEnabled
        ? window.gBrowser?.selectedTab
        : null;
      if (visible.size === 0) {
        for (const tab of window.gBrowser.tabs) {
          tab.removeAttribute("data-tree-hidden");
        }
        return;
      }

      for (const tab of window.gBrowser.tabs) {
        if (
          visible.has(tab) ||
          (stickyActiveTabEnabled && tab == selectedTab)
        ) {
          tab.removeAttribute("data-tree-hidden");
        } else {
          tab.dataset.treeHidden = "true";
        }
      }
    },

    _clearTab(tab) {
      tab.removeAttribute("data-tree-level");
      tab.removeAttribute("data-tree-parent");
      tab.removeAttribute("data-tree-has-children");
      tab.removeAttribute("data-tree-collapsed");
      tab.removeAttribute("data-tree-hidden");
      tab.removeAttribute("data-tree-drop-target");
      tab.removeAttribute("data-tree-twisty-hover");
      tab.style.removeProperty("--tree-level");
      if (this._twistyHoverTab == tab) {
        this._twistyHoverTab = null;
      }
    },

    _updateDropTarget(event) {
      const draggedTab = TreeTabsDnD._getDraggedTab(event);
      const parent = draggedTab
        ? TreeTabsDnD._previewDropParent(event, draggedTab)
        : null;

      if (this._dropTargetTab && this._dropTargetTab != parent) {
        this._dropTargetTab.removeAttribute("data-tree-drop-target");
        this._dropTargetTab = null;
      }

      if (parent) {
        parent.dataset.treeDropTarget = "child";
        this._dropTargetTab = parent;
      }
    },

    _clearDropTarget() {
      if (this._dropTargetTab) {
        this._dropTargetTab.removeAttribute("data-tree-drop-target");
        this._dropTargetTab = null;
      }
    },

    _getTreeContextMenuElements() {
      const separator = document.getElementById(TREE_CONTEXT_MENU.separator);
      const items = TREE_CONTEXT_MENU.items
        .map(info => document.getElementById(info.id))
        .filter(Boolean);
      return { separator, items };
    },

    _setTreeContextMenuHidden(hidden) {
      const { separator, items } = this._getTreeContextMenuElements();
      if (separator) {
        separator.hidden = hidden;
      }
      for (const item of items) {
        item.hidden = hidden;
      }
    },

    _updateTreeContextMenuVisibility() {
      const { separator } = this._getTreeContextMenuElements();
      if (!separator) {
        return;
      }

      const treeService = window.gBrowser?.TreeTabsService;
      const contextTab = window.TabContextMenu?.contextTab;
      const treeContextEnabled =
        this._isEnabled() &&
        this._tabContainer?.verticalMode &&
        !window.TabContextMenu?.multiselected &&
        !!treeService &&
        !!contextTab;

      if (!treeContextEnabled) {
        this._setTreeContextMenuHidden(true);
        return;
      }

      const contextCollapseTree = document.getElementById(
        "context_collapseTree"
      );
      const contextExpandTree = document.getElementById("context_expandTree");
      const contextCloseTree = document.getElementById("context_closeTree");
      const contextCloseDescendants = document.getElementById(
        "context_closeDescendants"
      );
      const contextCollapseAll = document.getElementById("context_collapseAll");
      const contextExpandAll = document.getElementById("context_expandAll");

      const hasChildren = !!treeService.getChildren(contextTab).length;
      const hasDescendants = !!treeService.getDescendants(contextTab).length;
      const isCollapsed = treeService.isCollapsed(contextTab);

      let hasAnyTree = false;
      let hasAnyCollapsed = false;
      for (const tab of window.gBrowser.tabs) {
        if (!hasAnyTree && !!treeService.getChildren(tab).length) {
          hasAnyTree = true;
        }
        if (!hasAnyCollapsed && treeService.isCollapsed(tab)) {
          hasAnyCollapsed = true;
        }
        if (hasAnyTree && hasAnyCollapsed) {
          break;
        }
      }

      contextCollapseTree.hidden = !hasChildren || isCollapsed;
      contextExpandTree.hidden = !hasChildren || !isCollapsed;
      contextCloseTree.hidden = !hasDescendants;
      contextCloseDescendants.hidden = !hasDescendants;
      contextCollapseAll.hidden = !hasAnyTree;
      contextExpandAll.hidden = !hasAnyCollapsed;

      separator.hidden =
        contextCollapseTree.hidden &&
        contextExpandTree.hidden &&
        contextCloseTree.hidden &&
        contextCloseDescendants.hidden &&
        contextCollapseAll.hidden &&
        contextExpandAll.hidden;
    },

    _handleTreeContextMenuCommand(event) {
      const commandId = event.target?.id;
      if (!TREE_CONTEXT_MENU.items.some(item => item.id == commandId)) {
        return;
      }

      if (
        !this._isEnabled() ||
        !this._tabContainer?.verticalMode ||
        !window.gBrowser?.TreeTabsService
      ) {
        return;
      }

      const treeService = window.gBrowser.TreeTabsService;
      const contextTab = window.TabContextMenu?.contextTab;
      if (
        !contextTab &&
        commandId != "context_collapseAll" &&
        commandId != "context_expandAll"
      ) {
        return;
      }

      this._withAutoCollapseSuppressed(() => {
        switch (commandId) {
          case "context_collapseTree":
            treeService.collapseSubtree(contextTab);
            break;
          case "context_expandTree":
            treeService.expandSubtree(contextTab);
            break;
          case "context_closeTree": {
            this._closeTreeTabs(contextTab);
            break;
          }
          case "context_closeDescendants": {
            const tabsToClose = treeService
              .closeDescendants(contextTab)
              .filter(tab => tab && !tab.closing);
            if (tabsToClose.length) {
              window.gBrowser.removeTabs(tabsToClose);
            }
            break;
          }
          case "context_collapseAll":
            treeService.collapseAll(window);
            break;
          case "context_expandAll":
            treeService.expandAll(window);
            break;
          default:
            break;
        }
      });
    },
  };

  return controller;
}

export const TreeTabsUI = {
  _controllers: new WeakMap(),

  onWindowOpened(window) {
    if (!window || this._controllers.has(window)) {
      return;
    }
    const controller = createTreeTabsController(window);
    this._controllers.set(window, controller);
    controller.init();
    window.addEventListener("unload", () => this.onWindowClosed(window), {
      once: true,
    });
  },

  onWindowClosed(window) {
    const controller = this._controllers.get(window);
    if (!controller) {
      return;
    }
    controller.destroy();
    this._controllers.delete(window);
  },
};
