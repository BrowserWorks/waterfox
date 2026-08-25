/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  OpenInTabsUtils:
    "moz-src:///browser/components/tabbrowser/OpenInTabsUtils.sys.mjs",
  PlacesUIUtils: "moz-src:///browser/components/places/PlacesUIUtils.sys.mjs",
  TreeTabsBookmarks: "resource:///modules/TreeTabsBookmarks.sys.mjs",
  TreeTabsGroups: "resource:///modules/TreeTabsGroups.sys.mjs",
  TreeTabsService: "resource:///modules/TreeTabsService.sys.mjs",
  TreeTabsStore: "resource:///modules/TreeTabsStore.sys.mjs",
});

ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["browser/waterfox/tree-tabs.ftl"], true)
);

const PREF_ENABLED = "browser.tabs.verticalTabs.tree.enabled";
const PREF_INDENT_PX = "browser.tabs.verticalTabs.tree.indentPx";
const PREF_AUTO_COLLAPSE_ON_SELECT =
  "browser.tabs.verticalTabs.tree.autoCollapse.onSelect";
const PREF_DOUBLE_CLICK_BEHAVIOR =
  "browser.tabs.verticalTabs.tree.doubleClickBehavior";
const PREF_STICKY_ACTIVE_TAB =
  "browser.tabs.verticalTabs.tree.sticky.activeTab";
const PREF_PROPAGATE_MUTED_STATE =
  "browser.tabs.verticalTabs.tree.propagateMutedState";
const PREF_DROP_LINKS_ON_TAB = "browser.tabs.verticalTabs.tree.dropLinksOnTab";
const PREF_AUTO_GROUP_PINNED_OPENER =
  "browser.tabs.verticalTabs.tree.autoGroup.pinnedOpener";
const PREF_EXPAND_NATIVE_GROUP =
  "browser.tabs.verticalTabs.tree.expandNativeGroupOnTreeExpand";
const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";
const RESTORE_RETRY_TIMEOUT_MS = 10000;

const TREE_CONTEXT_MENU = {
  separator: "context_treeTabCommandsSeparator",
  items: [
    {
      id: "context_reloadTree",
      l10nId: "waterfox-tab-context-reload-tree",
    },
    {
      id: "context_toggleMuteTree",
      l10nId: "waterfox-tab-context-mute-tree",
    },
    {
      id: "context_unloadTree",
      l10nId: "waterfox-tab-context-unload-tree",
    },
    {
      id: "context_collapseTree",
      l10nId: "waterfox-tab-context-collapse-tree",
    },
    {
      id: "context_expandTree",
      l10nId: "waterfox-tab-context-expand-tree",
    },
    {
      id: "context_collapseTreeRecursively",
      l10nId: "waterfox-tab-context-collapse-tree-recursively",
    },
    {
      id: "context_expandTreeRecursively",
      l10nId: "waterfox-tab-context-expand-tree-recursively",
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
      id: "context_bookmarkTree",
      l10nId: "waterfox-tab-context-bookmark-tree",
    },
    {
      id: "context_copyTreeLinks",
      l10nId: "waterfox-tab-context-copy-tree-links",
    },
    {
      id: "context_copyDescendantsLinks",
      l10nId: "waterfox-tab-context-copy-descendants-links",
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

    // Track the parent outlined during dragover.
    _lastPreviewParent: null,

    // Keep move fixup suppressed until the matching after* hook; the generation
    // guards the delayed dragend fallback.
    _dropPending: false,
    _dropGeneration: 0,

    _getService(tabContainer) {
      return tabContainer?.documentGlobal?.gBrowser?.TreeTabsService || null;
    },

    _getLogicalTab(item) {
      if (item?.matches?.("tab-split-view-wrapper")) {
        return item.tabs?.[0] || null;
      }
      return item?.splitview?.tabs?.[0] || item || null;
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
        tab.visible &&
        tab.dataset?.treeHidden != "true" &&
        // Only the first pane of a split view pair carries tree links.
        (!tab.splitview || tab.splitview.tabs?.[0] == tab) &&
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
        for (const item of state.movingTabs) {
          if (item?.tabs?.length) {
            for (const tab of item.tabs) {
              moving.add(tab);
            }
          } else {
            moving.add(item);
          }
        }
      } else if (draggedTab) {
        const service = draggedTab.documentGlobal?.gBrowser?.TreeTabsService;
        const tabs = draggedTab.multiselected
          ? draggedTab.documentGlobal.gBrowser.selectedElements
          : this._collectSubtreeTabs(draggedTab, service);
        for (const item of this._toNativeMovingElements(tabs)) {
          for (const tab of item.tabs || [item]) {
            moving.add(tab);
          }
        }
      }
      return moving;
    },

    _getIndentUnit() {
      const px = Services.prefs.getIntPref(PREF_INDENT_PX, 16);
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

    // A vertical drag follows the next row's depth, or root at the end;
    // horizontal movement adjusts it within the levels allowed by neighboring
    // rows.
    _chooseLevel(service, prev, next, draggedTab, event) {
      const prevLevel = service.getLevel(prev);
      const steps = Math.round(
        this._getHorizontalDrag(draggedTab, event) / this._getIndentUnit()
      );
      const minLevel = next ? service.getLevel(next) : 0;
      const maxLevel = prevLevel + 1;
      const neutral = next ? minLevel : 0;
      return Math.max(minLevel, Math.min(neutral + steps, maxLevel));
    },

    // Gesture placement is captured before native cleanup deletes _dragData.
    // External moves instead resolve placement from the final flat order.
    _resolvePlacement(draggedTab, event, state) {
      const service = this._getService(window.gBrowser.tabContainer);
      const draggedItem = draggedTab;
      draggedTab = this._getLogicalTab(draggedTab);
      if (!service || !draggedTab || draggedTab.pinned) {
        return null;
      }
      if (event && state?.placement) {
        const { parent, insertAfter } = state.placement;
        const movingSet = this._getMovingSet(draggedTab, state);
        if (
          [parent, insertAfter].every(
            tab =>
              !tab ||
              (tab.isConnected &&
                !tab.closing &&
                !tab.pinned &&
                tab.documentGlobal == window &&
                !movingSet.has(tab))
          )
        ) {
          return state.placement;
        }
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

      return this._placementBetween(
        service,
        prev,
        next,
        draggedItem,
        event,
        movingSet
      );
    },

    _placementBetween(service, prev, next, draggedItem, event, movingSet) {
      if (!prev) {
        return { parent: null, insertAfter: null };
      }
      const prevLevel = service.getLevel(prev);
      const level = this._chooseLevel(service, prev, next, draggedItem, event);
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
      draggedTab = this._getLogicalTab(draggedTab);
      if (!service || !draggedTab || !placement) {
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

    _getRowBounds(tab) {
      const row = tab.splitview || tab;
      const rect = row.getBoundingClientRect();
      // Native gap animation must not change which row the pointer targets.
      const transform = new window.DOMMatrixReadOnly(
        window.getComputedStyle(row).transform
      );
      return {
        top: rect.top - transform.m42,
        bottom: rect.bottom - transform.m42,
        height: rect.height,
      };
    },

    getAttachTarget(tabContainer, event, draggedTab, state = null) {
      const logicalTab = this._getLogicalTab(draggedTab);
      if (
        !this._isEnabled(tabContainer) ||
        !logicalTab?.classList?.contains("tabbrowser-tab") ||
        logicalTab.pinned ||
        draggedTab.multiselected ||
        logicalTab.multiselected ||
        this._isDropIntoPinnedArea(tabContainer, event)
      ) {
        return null;
      }
      const movingSet = this._getMovingSet(logicalTab, state);
      for (const tab of window.gBrowser.tabs) {
        if (!this._isPlacementCandidate(tab, movingSet)) {
          continue;
        }
        const rect = this._getRowBounds(tab);
        if (
          rect.height &&
          event.clientY >= rect.top + rect.height / 4 &&
          event.clientY <= rect.bottom - rect.height / 4
        ) {
          return tab;
        }
      }
      return null;
    },

    _getNativeDropGap(dragData, tabs, movingSet) {
      if (typeof dragData?.dropBefore != "boolean") {
        return null;
      }
      const dropElement = dragData.dropElement;
      const dropTab = this._getLogicalTab(dropElement);
      const isGroupLabel = window.gBrowser.isTabGroupLabel(dropElement);
      let dropGroup = null;
      if (window.gBrowser.isTabGroup(dropElement)) {
        dropGroup = dropElement;
      } else if (isGroupLabel) {
        dropGroup = dropElement.group;
      }
      let index;
      if (
        dropGroup?.isConnected &&
        dropGroup.documentGlobal == window &&
        dropGroup.tabs.length
      ) {
        const atStart =
          !(isGroupLabel && dragData.shouldDropIntoCollapsedTabGroup) &&
          (dragData.dropBefore || (isGroupLabel && !dropGroup.collapsed));
        index = atStart
          ? dropGroup.tabs[0]._tPos
          : dropGroup.tabs.at(-1)._tPos + 1;
      } else if (tabs.includes(dropTab) && !movingSet.has(dropTab)) {
        index = dropTab._tPos + (dragData.dropBefore ? 0 : 1);
      } else {
        return null;
      }
      const logicalTabs = tabs.filter(
        tab =>
          !tab.pinned &&
          !tab.closing &&
          !movingSet.has(tab) &&
          this._getLogicalTab(tab) == tab
      );
      const previous = logicalTabs.findLast(tab => tab._tPos < index);
      const following = logicalTabs.find(tab => tab._tPos >= index);
      if (
        dropGroup ||
        (previous?.group != following?.group &&
          (previous?.group?.collapsed || following?.group?.collapsed))
      ) {
        // Hidden group members still delimit root-level insertion gaps.
        const service = this._getService(window.gBrowser.tabContainer);
        return {
          index,
          placement: {
            parent: null,
            insertAfter:
              logicalTabs.findLast(
                tab => tab._tPos < index && !service.getParent(tab)
              ) || null,
          },
        };
      }
      return { index };
    },

    // The middle half attaches to the row; edges follow the native insertion
    // gap, retaining both its parent and its preceding sibling.
    _previewDropPlacement(event, draggedTab, state = null) {
      const tabContainer = window.gBrowser.tabContainer;
      const service = this._getService(tabContainer);
      const logicalTab = this._getLogicalTab(draggedTab);
      if (
        !this._isEnabled(tabContainer) ||
        !logicalTab?.classList?.contains("tabbrowser-tab") ||
        logicalTab.pinned ||
        this._isDropIntoPinnedArea(tabContainer, event)
      ) {
        return null;
      }
      const movingSet = this._getMovingSet(logicalTab, state);
      const parent = this.getAttachTarget(
        tabContainer,
        event,
        draggedTab,
        state
      );
      if (parent) {
        return {
          parent,
          insertAfter:
            service.getChildren(parent).findLast(tab => !movingSet.has(tab)) ||
            null,
        };
      }

      const tabs = Array.from(window.gBrowser.tabs);
      const candidates = tabs.filter(tab =>
        this._isPlacementCandidate(tab, movingSet)
      );
      const dragData = draggedTab._dragData || logicalTab._dragData;
      const nativeGap = this._getNativeDropGap(dragData, tabs, movingSet);
      if (nativeGap?.placement) {
        return nativeGap.placement;
      }
      let prev = null;
      let next = null;
      if (nativeGap) {
        const { index } = nativeGap;
        prev = candidates.findLast(tab => tab._tPos < index) || null;
        next = candidates.find(tab => tab._tPos >= index) || null;
      } else {
        for (const tab of candidates) {
          const rect = this._getRowBounds(tab);
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
      }
      return this._placementBetween(
        service,
        prev,
        next,
        draggedTab,
        event,
        movingSet
      );
    },

    _previewDropParent(event, draggedTab) {
      this._lastPreviewParent =
        this._previewDropPlacement(event, draggedTab)?.parent || null;
      return this._lastPreviewParent;
    },

    updateDragOver(tabContainer, event) {
      if (this._isEnabled(tabContainer)) {
        controller._updateDropTarget(event);
      }
    },

    _collectSubtreeTabs(rootTab, treeService) {
      rootTab = this._getLogicalTab(rootTab);
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

      return [rootTab, ...descendants];
    },

    _toNativeMovingElements(tabs) {
      return [...new Set(tabs.map(tab => tab.splitview || tab))];
    },

    _dropElementContainsAnyTab(dropElement, tabs) {
      return (
        tabs.includes(dropElement) ||
        Array.from(dropElement?.tabs || []).some(tab => tabs.includes(tab))
      );
    },

    _isDropIntoPinnedArea(tabContainer, event) {
      const pinnedContainer = tabContainer?.pinnedTabsContainer;
      return !!pinnedContainer?.contains(event.target);
    },

    prepareDrop(tabContainer, event, { draggedTab, movingTabs, dropEffect }) {
      if (!draggedTab) {
        return null;
      }

      const logicalDraggedTab = this._getLogicalTab(draggedTab);
      const state = {
        movingTabs,
        crossWindowSnapshot: null,
        logicalDraggedTab,
        multiselect: false,
      };

      if (dropEffect != "move" || !this._isEnabled(tabContainer)) {
        return state;
      }

      const sourceService =
        logicalDraggedTab?.documentGlobal?.gBrowser?.TreeTabsService;
      if (
        !sourceService ||
        !logicalDraggedTab?.classList?.contains("tabbrowser-tab") ||
        logicalDraggedTab.pinned
      ) {
        return state;
      }

      // Firefox moves selected tabs incrementally, so suppress fixup until the
      // native drop and transition-driven moves finish.
      this._suppressMoveFixup = true;
      this._dropPending = true;
      this._dropGeneration += 1;

      if (draggedTab.multiselected) {
        state.multiselect = true;
        return state;
      }

      // Ctrl detaches the dragged tab's children before the move so they stay
      // behind instead of travelling with it. Alt does the same where Ctrl
      // turns the drag into a copy (Windows and Linux).
      if (event.ctrlKey || event.altKey) {
        sourceService.onTabMoved(logicalDraggedTab, { detachChildren: true });
        state.placement = this._previewDropPlacement(event, draggedTab, state);
        return state;
      }

      const subtreeTabs = this._collectSubtreeTabs(
        logicalDraggedTab,
        sourceService
      );
      const subtreeElements = this._toNativeMovingElements(subtreeTabs);
      const dragData = draggedTab._dragData || logicalDraggedTab._dragData;
      if (
        dragData?.dropElement &&
        this._dropElementContainsAnyTab(dragData.dropElement, subtreeTabs)
      ) {
        sourceService.onTabMoved(logicalDraggedTab, {
          detachChildren: true,
        });
        state.movingTabs = [logicalDraggedTab.splitview || logicalDraggedTab];
      } else if (
        subtreeElements.length > movingTabs.length &&
        !this._isDropIntoPinnedArea(tabContainer, event)
      ) {
        state.movingTabs = subtreeElements;
      }

      if (
        dragData?.dropElement &&
        this._dropElementContainsAnyTab(dragData.dropElement, [
          ...this._getMovingSet(draggedTab, state),
        ])
      ) {
        dragData.dropElement = null;
      }

      if (draggedTab.container == tabContainer) {
        state.placement = this._previewDropPlacement(event, draggedTab, state);
      }

      if (draggedTab.container != tabContainer && subtreeTabs.length > 1) {
        state.crossWindowSnapshot =
          sourceService.onTabDetached(logicalDraggedTab);
      }

      return state;
    },

    afterSameWindowDrop(
      tabContainer,
      event,
      { draggedTab, dropEffect, state }
    ) {
      if (dropEffect != "move" || !this._isEnabled(tabContainer)) {
        this._endDrop();
        return;
      }

      this._suppressMoveFixup = true;
      let changed = false;
      try {
        if (state?.multiselect || draggedTab?.multiselected) {
          // Rebuild links from the final strip order after all selected tabs
          // move.
          const moved = [
            ...new Set(
              (state?.movingTabs || [])
                .flatMap(item => (item?.tabs?.length ? item.tabs : [item]))
                .map(tab => tab?.splitview?.tabs?.[0] || tab)
            ),
          ]
            .filter(tab => tab?.isConnected && !tab.closing && !tab.pinned)
            .sort((a, b) => a._tPos - b._tPos);
          for (const tab of moved) {
            const placement = this._resolvePlacement(tab, null, null);
            if (placement) {
              changed = this._applyPlacement(tab, placement) || changed;
            }
          }
        } else {
          // Ctrl/Alt leaves children behind, but the dragged tab still needs
          // placement.
          const logicalDraggedTab =
            state?.logicalDraggedTab || this._getLogicalTab(draggedTab);
          const placement = this._resolvePlacement(draggedTab, event, state);
          if (placement && this._applyPlacement(logicalDraggedTab, placement)) {
            changed = true;
            this._syncSubtreeStripPosition(logicalDraggedTab);
          }
        }
      } finally {
        this._endDrop();
      }

      if (changed) {
        // A child attach only fires events for the moved tab and its parents,
        // so announce a structure change to refresh every row and fix up the
        // indentation of any descendants that came along with it.
        Services.obs.notifyObservers(
          { wrappedJSObject: { window } },
          "tree-tabs-structure-changed"
        );
      }
    },

    _endDrop() {
      this._suppressMoveFixup = false;
      this._lastPreviewParent = null;
      this._dropPending = false;
      controller._restoreDragAutoExpandedTabs();
    },

    // Native drop can place a previewed attachment above its target; move the
    // subtree to restore tree order in the strip.
    _syncSubtreeStripPosition(tab) {
      const service = this._getService(window.gBrowser.tabContainer);
      tab = this._getLogicalTab(tab);
      if (!service || !tab) {
        return;
      }
      const parent = service.getParent(tab);
      const children = parent
        ? service.getChildren(parent)
        : service
            .getRootTabs(window)
            .filter(root => !root.pinned && this._getLogicalTab(root) == root);
      const index = children.indexOf(tab);
      let anchor = parent;
      if (index > 0) {
        const previousSibling = children[index - 1];
        const descendants = service.getDescendants(previousSibling);
        anchor = descendants[descendants.length - 1] || previousSibling;
      }

      const subtree = this._collectSubtreeTabs(tab, service);
      if (subtree.some(moving => moving.pinned || moving.group != tab.group)) {
        return;
      }
      if (tab.group && anchor?.group != tab.group) {
        anchor = null;
      } else if (!tab.group && anchor?.group) {
        anchor = anchor.group;
      }

      const elements = this._toNativeMovingElements(subtree);
      const wasSuppressingMoveFixup = this._suppressMoveFixup;
      this._suppressMoveFixup = true;
      try {
        if (anchor) {
          window.gBrowser.moveTabsAfter(elements, anchor.splitview || anchor);
        } else {
          const movingSet = this._getMovingSet(tab, { movingTabs: elements });
          let next = Array.from(window.gBrowser.tabs).find(
            item =>
              !item.pinned &&
              !movingSet.has(item) &&
              (!tab.group || item.group == tab.group)
          );
          next = next?.splitview || next;
          if (!next && tab.group) {
            // Anchor a sole grouped subtree to itself, not the outer strip.
            next = elements[0];
          } else if (!tab.group && next?.group) {
            next = next.group;
          }
          window.gBrowser.moveTabsBefore(elements, next);
        }
      } finally {
        this._suppressMoveFixup = wasSuppressingMoveFixup;
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
      { draggedTab, dropEffect, adoptedTabMap, state }
    ) {
      this._endDrop();
      if (
        dropEffect != "move" ||
        !this._isEnabled(tabContainer) ||
        draggedTab?.multiselected ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      // Moving a subtree to another window keeps its shape; nesting it against
      // a target in the new window is left to a later pass.
      if (state?.crossWindowSnapshot) {
        this._restoreAdoptedSubtree(
          tabContainer,
          state.crossWindowSnapshot,
          adoptedTabMap
        );
      }
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

  const isolateDisclosureKeyEvent = event => {
    if (
      !controller._isEnabled() ||
      !controller._tabContainer?.verticalMode ||
      !["Enter", " "].includes(event.key) ||
      !event.target?.closest?.(".tab-tree-disclosure")
    ) {
      return false;
    }
    event.stopPropagation();
    return true;
  };

  const controller = {
    _initialized: false,
    _tabContainer: null,
    _verticalTabsBox: null,
    _dropTargetTab: null,
    _resizeObserver: null,
    _orientationObserver: null,
    _tabContextMenu: null,
    _isWindowRestoring: false,
    _deferringTreeRender: false,
    _treeRenderPending: false,
    _autoCollapseInProgress: false,
    _autoCollapseSuppressDepth: 0,
    _restoreRetryActive: false,
    _restoreRetryTimerId: null,
    _inheritedMuteTabs: new WeakSet(),
    _manuallyExpandedTabs: new WeakSet(),
    _newTabActionButton: null,
    _dragAutoExpandedTabs: new Set(),
    _dragHoverExpandTab: null,
    _dragHoverExpandTimer: null,
    _dragAutoExpandedGroups: new Set(),
    _dragHoverExpandGroup: null,
    _dragHoverExpandGroupTimer: null,
    _splitViewMains: new Map(),
    _splitViewPanes: new Map(),
    _groupCleanupTabs: new Set(),
    _groupCleanupScanAll: false,
    _groupCleanupTimer: null,
    _nativeGroupReconcileTimer: null,
    _switchingExpandTimer: null,
    _switchingModifierHeld: false,

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
      Services.prefs.addObserver(PREF_INDENT_PX, this);
      Services.prefs.addObserver(PREF_STICKY_ACTIVE_TAB, this);
      Services.obs.addObserver(this, "tree-tabs-attached");
      Services.obs.addObserver(this, "tree-tabs-detached");
      Services.obs.addObserver(this, "tree-tabs-subtree-collapsed-changed");
      Services.obs.addObserver(this, "tree-tabs-structure-changed");
      Services.obs.addObserver(this, "tree-tabs-close-requested");
      Services.obs.addObserver(this, "tree-tabs-group-replace-requested");
      window.addEventListener("SSWindowRestoring", this, true);
      window.addEventListener("SSWindowRestored", this, true);

      this._tabContainer.addEventListener("TabOpen", this);
      this._tabContainer.addEventListener("TabClose", this);
      this._tabContainer.addEventListener("SplitViewCreated", this);
      this._tabContainer.addEventListener("SplitViewRemoved", this);
      this._tabContainer.addEventListener("SplitViewTabChange", this);
      this._tabContainer.addEventListener("TabGrouped", this);
      this._tabContainer.addEventListener("TabUngrouped", this);
      this._tabContainer.addEventListener("TabGroupMoved", this);
      this._tabContainer.addEventListener("TabMove", this);
      this._tabContainer.addEventListener("TabPinned", this);
      this._tabContainer.addEventListener("TabAttrModified", this);
      this._tabContainer.addEventListener("TabHide", this);
      this._tabContainer.addEventListener("TabShow", this);
      this._tabContainer.addEventListener("TabSelect", this);
      this._tabContainer.addEventListener("SSTabRestored", this);
      this._tabContainer.addEventListener("mousedown", this, true);
      this._tabContainer.addEventListener("click", this, true);
      this._tabContainer.addEventListener("dblclick", this, true);
      this._tabContainer.addEventListener("dblclick", this);
      this._tabContainer.addEventListener("keydown", this);
      this._tabContainer.addEventListener("dragover", this, true);
      this._tabContainer.addEventListener("drop", this);
      this._tabContainer.addEventListener("drop", this, true);
      this._tabContainer.addEventListener("dragleave", this);
      this._tabContainer.addEventListener("dragend", this);
      window.addEventListener("keydown", this, true);
      window.addEventListener("keyup", this, true);
      // Native tab key handlers run in the separate system event group.
      for (const type of ["keydown", "keyup"]) {
        window.addEventListener(type, isolateDisclosureKeyEvent, {
          capture: true,
          mozSystemGroup: true,
        });
      }
      this._newTabActionButton = document.getElementById(
        "waterfox-tree-newtab-action-button"
      );
      this._newTabActionButton?.addEventListener("command", this);
      this._newTabActionButton?.addEventListener("popupshowing", this);

      if (this._verticalTabsBox) {
        this._resizeObserver = new window.ResizeObserver(() => {
          if (this._isEnabled()) {
            this._updateAllTabs();
          }
        });
        this._resizeObserver.observe(this._verticalTabsBox);
      }

      this._orientationObserver = new window.MutationObserver(() => {
        this._cancelSwitchingExpand();
        this._updateNewTabActionButton();
        if (this._isEnabled()) {
          this._withFinalTreeRender(() => {
            this._revealSelectedTab(window.gBrowser.selectedTab);
            this._updateAllTabs();
          });
        }
      });
      this._orientationObserver.observe(this._tabContainer, {
        attributes: true,
        attributeFilter: ["orient"],
      });

      this._tabContextMenu?.addEventListener("popupshowing", this);
      this._tabContextMenu?.addEventListener("command", this);

      this._updateEnabledState();
    },

    // eslint-disable-next-line complexity
    destroy() {
      if (!this._initialized) {
        return;
      }
      this._initialized = false;

      lazy.TreeTabsStore.uninitWindow(window);
      lazy.TreeTabsService.uninit(window);

      Services.prefs.removeObserver(PREF_ENABLED, this);
      Services.prefs.removeObserver(PREF_INDENT_PX, this);
      Services.prefs.removeObserver(PREF_STICKY_ACTIVE_TAB, this);
      Services.obs.removeObserver(this, "tree-tabs-attached");
      Services.obs.removeObserver(this, "tree-tabs-detached");
      Services.obs.removeObserver(this, "tree-tabs-subtree-collapsed-changed");
      Services.obs.removeObserver(this, "tree-tabs-structure-changed");
      Services.obs.removeObserver(this, "tree-tabs-close-requested");
      Services.obs.removeObserver(this, "tree-tabs-group-replace-requested");
      window.removeEventListener("SSWindowRestoring", this, true);
      window.removeEventListener("SSWindowRestored", this, true);

      this._tabContainer?.removeEventListener("TabOpen", this);
      this._tabContainer?.removeEventListener("TabClose", this);
      this._tabContainer?.removeEventListener("SplitViewCreated", this);
      this._tabContainer?.removeEventListener("SplitViewRemoved", this);
      this._tabContainer?.removeEventListener("SplitViewTabChange", this);
      this._tabContainer?.removeEventListener("TabGrouped", this);
      this._tabContainer?.removeEventListener("TabUngrouped", this);
      this._tabContainer?.removeEventListener("TabGroupMoved", this);
      this._tabContainer?.removeEventListener("TabMove", this);
      this._tabContainer?.removeEventListener("TabPinned", this);
      this._tabContainer?.removeEventListener("TabAttrModified", this);
      this._tabContainer?.removeEventListener("TabHide", this);
      this._tabContainer?.removeEventListener("TabShow", this);
      this._tabContainer?.removeEventListener("TabSelect", this);
      this._tabContainer?.removeEventListener("SSTabRestored", this);
      this._tabContainer?.removeEventListener("mousedown", this, true);
      this._tabContainer?.removeEventListener("click", this, true);
      this._tabContainer?.removeEventListener("dblclick", this, true);
      this._tabContainer?.removeEventListener("dblclick", this);
      this._tabContainer?.removeEventListener("keydown", this);
      this._tabContainer?.removeEventListener("dragover", this, true);
      this._tabContainer?.removeEventListener("drop", this);
      this._tabContainer?.removeEventListener("drop", this, true);
      this._tabContainer?.removeEventListener("dragleave", this);
      this._tabContainer?.removeEventListener("dragend", this);
      window.removeEventListener("keydown", this, true);
      window.removeEventListener("keyup", this, true);
      for (const type of ["keydown", "keyup"]) {
        window.removeEventListener(type, isolateDisclosureKeyEvent, {
          capture: true,
          mozSystemGroup: true,
        });
      }
      this._newTabActionButton?.removeEventListener("command", this);
      this._newTabActionButton?.removeEventListener("popupshowing", this);
      this._newTabActionButton = null;
      this._resizeObserver?.disconnect();
      this._resizeObserver = null;
      this._orientationObserver?.disconnect();
      this._orientationObserver = null;

      this._tabContextMenu?.removeEventListener("popupshowing", this);
      this._tabContextMenu?.removeEventListener("command", this);

      this._restoreDragAutoExpandedTabs();
      this._clearDropTarget();
      this._setTreeContextMenuHidden(true);
      this._stopRestoreRetry({ clearGuard: true });
      TreeTabsNav.unpatch(this._tabContainer);

      this._tabContainer = null;
      this._verticalTabsBox = null;
      this._tabContextMenu = null;
      this._isWindowRestoring = false;
      this._deferringTreeRender = false;
      this._treeRenderPending = false;
      this._autoCollapseInProgress = false;
      this._autoCollapseSuppressDepth = 0;
      this._restoreRetryActive = false;
      this._restoreRetryTimerId = null;
      this._inheritedMuteTabs = new WeakSet();
      this._manuallyExpandedTabs = new WeakSet();
      if (this._groupCleanupTimer) {
        window.clearTimeout(this._groupCleanupTimer);
        this._groupCleanupTimer = null;
      }
      if (this._nativeGroupReconcileTimer) {
        window.clearTimeout(this._nativeGroupReconcileTimer);
        this._nativeGroupReconcileTimer = null;
      }
      this._groupCleanupTabs.clear();
      this._groupCleanupScanAll = false;
      this._dragAutoExpandedGroups.clear();
      this._splitViewMains.clear();
      this._splitViewPanes.clear();

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
      const rendered = this._withFinalTreeRender(() => {
        if (this._maybeTryManualRestore()) {
          this._syncSplitViewTrees();
          this._updateAllTabs();
        }
      });
      if (!rendered) {
        this._updateTab(event.target);
        this._updateHiddenTabs();
      }
    },

    // A split view pair occupies one tree row, owned by its first pane. The
    // other panes carry no tree links of their own, so their children are
    // folded into the shared row and links follow a reordered first pane.
    _syncSplitViewTrees() {
      if (!this._isEnabled()) {
        return false;
      }
      let changed = false;
      const wrappers = new Set(this._tabContainer?.allSplitViews || []);
      for (const [wrapper, main] of this._splitViewMains) {
        if (!wrappers.has(wrapper)) {
          this._handleSplitViewRemoved(
            main,
            this._splitViewPanes.get(wrapper) || []
          );
          this._splitViewMains.delete(wrapper);
          this._splitViewPanes.delete(wrapper);
          changed = true;
        }
      }

      for (const wrapper of wrappers) {
        const tabs = Array.from(wrapper.tabs || []);
        const main = tabs[0];
        if (!main) {
          continue;
        }
        const previousMain = this._splitViewMains.get(wrapper);
        const previousPanes = this._splitViewPanes.get(wrapper);
        const subPanes = tabs.slice(1);
        if (
          previousMain == main &&
          previousPanes?.length == tabs.length &&
          tabs.every((tab, index) => tab == previousPanes[index]) &&
          subPanes.every(
            tab =>
              !lazy.TreeTabsService.getParent(tab) &&
              !lazy.TreeTabsService.getChildren(tab).length &&
              !lazy.TreeTabsService.isCollapsed(tab) &&
              !this._manuallyExpandedTabs.has(tab)
          )
        ) {
          continue;
        }
        changed = true;
        if (
          previousMain &&
          previousMain != main &&
          tabs.includes(previousMain)
        ) {
          this._transferTreeLinks(previousMain, main);
        }
        for (const sub of subPanes) {
          this._mergeSplitTreeLinks(main, sub);
        }
        this._splitViewMains.set(wrapper, main);
        this._splitViewPanes.set(wrapper, tabs);
      }
      return changed;
    },

    _handleSplitViewRemoved(main, panes) {
      const service = lazy.TreeTabsService;
      const livePanes = panes.filter(
        tab => this._ownsTab(tab) && !tab.closing && !tab.splitview
      );
      if (!main || !livePanes.includes(main) || livePanes.length < 2) {
        return;
      }

      const companions = livePanes.filter(tab => tab != main);
      const parent = service.getParent(main);
      let previous = main;
      for (const companion of companions) {
        service.expandSubtree(companion);
        if (parent) {
          service.attachTab(companion, parent, {
            insertAfter: previous,
            suppressAutoExpand: true,
          });
        } else {
          service.detachTab(companion);
          const roots = service.getRootTabs(window);
          service.moveTabSubtree(companion, roots.indexOf(previous) + 1);
        }
        previous = companion;
      }

      const anchor = [main, ...service.getDescendants(main)].reduce(
        (last, tab) => (tab._tPos > last._tPos ? tab : last),
        main
      );
      const wasSuppressingMoveFixup = TreeTabsDnD._suppressMoveFixup;
      TreeTabsDnD._suppressMoveFixup = true;
      try {
        window.gBrowser.moveTabsAfter(companions, anchor);
      } finally {
        TreeTabsDnD._suppressMoveFixup = wasSuppressingMoveFixup;
      }
    },

    _mergeSplitTreeLinks(main, sub) {
      const service = lazy.TreeTabsService;
      const subChildren = service.getChildren(sub);
      const shouldCollapse =
        service.isCollapsed(main) ||
        (!!subChildren.length && service.isCollapsed(sub));
      const manuallyExpanded =
        this._manuallyExpandedTabs.has(main) ||
        (!!subChildren.length && this._manuallyExpandedTabs.has(sub));
      this._manuallyExpandedTabs.delete(sub);

      if (service.getAncestors(main).includes(sub)) {
        this._transferTreeLinks(sub, main);
      } else {
        let previousChild = service.getChildren(main).at(-1) || null;
        for (const child of subChildren) {
          if (
            service.attachTab(child, main, {
              insertAfter: previousChild,
              suppressAutoExpand: true,
            })
          ) {
            previousChild = child;
          }
        }
        if (service.getChildren(sub).length) {
          service.onTabMoved(sub, { detachChildren: true });
        }
        if (service.getParent(sub)) {
          service.detachTab(sub);
        }
        service.expandSubtree(sub);
      }

      if (shouldCollapse) {
        this._manuallyExpandedTabs.delete(main);
        service.collapseSubtree(main);
      } else if (manuallyExpanded) {
        this._manuallyExpandedTabs.add(main);
      }
    },

    _transferTreeLinks(from, to) {
      const service = lazy.TreeTabsService;
      const parent = service.getParent(from);
      const children = service.getChildren(from);
      const collapsed = service.isCollapsed(from);
      const manuallyExpanded =
        !collapsed &&
        (this._manuallyExpandedTabs.has(from) ||
          this._manuallyExpandedTabs.has(to));
      this._manuallyExpandedTabs.delete(from);
      this._manuallyExpandedTabs.delete(to);
      const siblings = parent
        ? service.getChildren(parent)
        : service.getRootTabs(window);
      const siblingIndex = siblings.indexOf(from);

      if (parent && parent != to) {
        service.attachTab(to, parent, {
          insertBefore: siblings[siblingIndex + 1] || null,
          insertAfter: siblings[siblingIndex - 1] || null,
          index: siblingIndex,
          suppressAutoExpand: true,
        });
      } else if (!parent) {
        service.detachTab(to);
        service.moveTabSubtree(to, siblingIndex);
      }

      let previousChild = null;
      for (const child of children) {
        if (child == to) {
          continue;
        }
        service.attachTab(
          child,
          to,
          previousChild
            ? { insertAfter: previousChild, suppressAutoExpand: true }
            : { index: 0, suppressAutoExpand: true }
        );
        previousChild = child;
      }
      if (parent || children.length) {
        service.detachTab(from);
      }
      service.expandSubtree(from);
      if (collapsed) {
        service.collapseSubtree(to);
      } else {
        service.expandSubtree(to);
        if (manuallyExpanded) {
          this._manuallyExpandedTabs.add(to);
        }
      }
    },

    // TabClose fires before the model applies the close behaviour, so a
    // closing pane can hand its tree links to the surviving pane first.
    _handleSplitPaneClose(tab) {
      const wrapper = tab.splitview;
      if (!wrapper) {
        return;
      }
      const owner = this._splitViewMains.get(wrapper) || wrapper.tabs?.[0];
      if (owner != tab) {
        return;
      }
      const heir = Array.from(wrapper.tabs || []).find(
        other =>
          other != tab && !other.closing && !other._closedInMultiselection
      );
      if (!heir) {
        return;
      }
      this._transferTreeLinks(tab, heir);
      this._splitViewMains.set(wrapper, heir);
    },

    _handleTabClose(event) {
      this._inheritedMuteTabs.delete(event.target);
      if (!this._isEnabled()) {
        return;
      }
      const cleanupChain =
        event.target._treeTabsCleanupAncestors ||
        lazy.TreeTabsService.getAncestors(event.target);
      delete event.target._treeTabsCleanupAncestors;
      this._scheduleGroupCleanup(cleanupChain);
      this._handleSplitPaneClose(event.target);
      if (event.detail?.adoptedBy) {
        // Adoption closes the source tab through _beginRemoveTab and skips
        // removeTab, so the model never hears about it there.
        lazy.TreeTabsService.onTabClosed(event.target, { adopted: true });
      }
      this._updateAllTabs();
    },

    // eslint-disable-next-line complexity
    handleEvent(event) {
      switch (event.type) {
        case "TabOpen":
          this._handleTabOpen(event);
          break;
        case "TabClose":
          this._handleTabClose(event);
          break;
        case "SplitViewCreated":
        case "SplitViewRemoved":
        case "SplitViewTabChange":
          this._withFinalTreeRender(() => {
            if (this._syncSplitViewTrees()) {
              this._updateAllTabs();
            }
          });
          this._scheduleNativeGroupReconcile();
          break;
        case "TabGrouped":
        case "TabUngrouped":
        case "TabGroupMoved":
          this._scheduleNativeGroupReconcile();
          break;
        case "TabMove":
          if (!this._isEnabled()) {
            return;
          }
          this._withFinalTreeRender(() => {
            if (event.detail?.previousTabState?.splitViewId == null) {
              this._maybeFixupTreeOnExternalMove(event.target);
            }
            if (this._maybeTryManualRestore()) {
              this._syncSplitViewTrees();
            }
            this._updateAllTabs();
          });
          break;
        case "TabPinned":
          this._handleTabPinned(event.target);
          break;
        case "SSTabRestored":
          this._withFinalTreeRender(() => {
            const restored = this._maybeTryManualRestore();
            const changed = this._syncSplitViewTrees();
            if (restored || changed) {
              this._updateAllTabs();
            }
          });
          this._scheduleNativeGroupReconcile();
          this._scheduleAllGroupCleanup(1000);
          break;
        case "SSWindowRestoring":
          this._isWindowRestoring = true;
          break;
        case "SSWindowRestored":
          this._isWindowRestoring = false;
          if (this._isEnabled()) {
            this._withFinalTreeRender(() => {
              this._maybeRestoreTreeStructure();
              this._syncSplitViewTrees();
              this._updateAllTabs();
            });
            this._scheduleNativeGroupReconcile();
            this._scheduleAllGroupCleanup(1000);
          }
          break;
        case "TabSelect":
          this._handleTabSelect(event);
          break;
        case "TabAttrModified":
          this._handleTabAttrModified(event);
          break;
        case "TabHide":
        case "TabShow":
          this._handleTabHiddenChange(event.target);
          break;
        case "mousedown":
          this._handleTabTwistyMouseDown(event);
          break;
        case "click":
          if (
            event.currentTarget == this._tabContainer &&
            (this._handleTreeCloseButtonClick(event) ||
              this._handleTreeAudioButtonClick(event))
          ) {
            return;
          }
          this._handleTabTwistyClick(event);
          break;
        case "dblclick":
          if (event.eventPhase == Event.CAPTURING_PHASE) {
            this._handleTabTwistyMouseDown(event);
          } else {
            this._handleTabDoubleClick(event);
          }
          break;
        case "keydown":
        case "keyup":
          this._handleKeyEvent(event);
          break;
        case "dragover":
          if (!this._isEnabled()) {
            this._clearDropTarget();
            return;
          }
          this._updateDropTarget(event);
          break;
        case "dragleave":
          TreeTabsDnD._lastPreviewParent = null;
          this._clearDropTarget();
          if (!this._tabContainer.contains(event.relatedTarget)) {
            window.setTimeout(() => this._restoreDragAutoExpandedTabs());
          }
          break;
        case "drop":
          if (event.eventPhase == Event.CAPTURING_PHASE) {
            this._maybeInterceptLinkDrop(event);
            return;
          }
          this._clearDropTarget();
          window.setTimeout(() => this._restoreDragAutoExpandedTabs());
          break;
        case "dragend":
          this._handleDragEnd();
          break;
        case "popupshowing":
          if (event.target == this._tabContextMenu) {
            this._updateTreeContextMenuVisibility();
          } else if (event.currentTarget == this._newTabActionButton) {
            this._updateNewTabActionPopup();
          }
          break;
        case "command":
          if (event.currentTarget == this._newTabActionButton) {
            this._handleNewTabActionCommand(event);
          } else {
            this._handleTreeContextMenuCommand(event);
          }
          break;
        default:
          break;
      }
    },

    // eslint-disable-next-line complexity
    observe(subject, topic, data) {
      if (topic == "nsPref:changed") {
        if (data == PREF_ENABLED) {
          this._updateEnabledState();
        } else if (data == PREF_INDENT_PX && this._isEnabled()) {
          this._updateAllTabs();
        } else if (data == PREF_STICKY_ACTIVE_TAB && this._isEnabled()) {
          this._updateHiddenTabs();
        }
        return;
      }

      if (topic == "tree-tabs-group-replace-requested") {
        const payload = subject?.wrappedJSObject ?? subject;
        if (payload?.window != window || !this._isEnabled()) {
          return;
        }
        const groupTab = lazy.TreeTabsGroups.groupTabs(
          window,
          payload.children || [],
          {
            title: payload.title,
            temporaryAggressive: true,
            replacedParentCount: payload.replacedParentCount,
            parent: payload.parent,
            insertBefore: payload.insertBefore,
            insertAfter: payload.insertAfter,
            siblingIndex: payload.siblingIndex,
          }
        );
        if (groupTab) {
          this._scheduleGroupCleanup([groupTab], 1000);
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
          this._removeTreeTabs(tabsToClose, payload.baseTab || null);
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
          if (
            payload?.previousParent &&
            this._ownsTab(payload.previousParent)
          ) {
            this._scheduleGroupCleanup([
              payload.previousParent,
              ...lazy.TreeTabsService.getAncestors(payload.previousParent),
            ]);
          }
          if (payload?.tab && this._ownsTab(payload.tab)) {
            this._syncOpenerTab(topic == "tree-tabs-attached", payload);
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
            } else {
              if (
                Services.prefs.getBoolPref(PREF_EXPAND_NATIVE_GROUP, true) &&
                payload.tab.group?.collapsed
              ) {
                payload.tab.group.collapsed = false;
              }
              window.requestAnimationFrame(() => {
                payload.tab.scrollIntoView({ block: "nearest" });
              });
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

    _getLogicalTreeTab(tab) {
      if (tab?.matches?.("tab-split-view-wrapper")) {
        return tab.tabs?.[0] || null;
      }
      return tab?.splitview?.tabs?.[0] || tab || null;
    },

    _getTreeNodeTabs(tab) {
      const logicalTab = this._getLogicalTreeTab(tab);
      return logicalTab?.splitview?.tabs?.length
        ? Array.from(logicalTab.splitview.tabs)
        : [logicalTab].filter(Boolean);
    },

    _getTreeCommandTabs(tab, { descendantsOnly = false } = {}) {
      const logicalTab = this._getLogicalTreeTab(tab);
      if (!logicalTab) {
        return [];
      }
      const nodes = descendantsOnly
        ? lazy.TreeTabsService.getDescendants(logicalTab)
        : [logicalTab, ...lazy.TreeTabsService.getDescendants(logicalTab)];
      return [...new Set(nodes.flatMap(node => this._getTreeNodeTabs(node)))];
    },

    _getTreeContextRoots() {
      const contextMenu = window.TabContextMenu;
      const tabs = contextMenu?.multiselected
        ? contextMenu.contextTabs
        : [contextMenu?.contextTab];
      const roots = [
        ...new Set(
          tabs
            .map(tab => this._getLogicalTreeTab(tab))
            .filter(tab => tab && !tab.closing && !tab.pinned)
        ),
      ];
      const rootSet = new Set(roots);
      return roots.filter(
        tab =>
          !lazy.TreeTabsService.getAncestors(tab).some(ancestor =>
            rootSet.has(ancestor)
          )
      );
    },

    _getTreeContextTabs(roots, options) {
      return [
        ...new Set(
          roots.flatMap(root => this._getTreeCommandTabs(root, options))
        ),
      ];
    },

    _setManuallyExpanded(tab, expanded) {
      if (expanded) {
        this._manuallyExpandedTabs.add(tab);
      } else {
        this._manuallyExpandedTabs.delete(tab);
      }
    },

    _updateNewTabActionButton() {
      if (this._newTabActionButton) {
        this._newTabActionButton.hidden = !(
          this._isEnabled() && this._tabContainer?.verticalMode
        );
      }
    },

    _updateNewTabActionPopup() {
      const base = this._getLogicalTreeTab(window.gBrowser?.selectedTab);
      const relationshipAvailable = !!(
        this._isEnabled() &&
        this._tabContainer?.verticalMode &&
        base &&
        !base.closing &&
        !base.pinned &&
        this._ownsTab(base)
      );
      for (const item of this._newTabActionButton?.querySelectorAll(
        "[data-tree-newtab-action]"
      ) || []) {
        item.disabled =
          item.dataset.treeNewtabAction != "independent" &&
          !relationshipAvailable;
      }
    },

    // Mirror the tree parent into openerTab, so extensions reading
    // openerTabId see the tree structure.
    _syncOpenerTab(attached, payload) {
      const tab = payload.tab;
      if (attached) {
        tab.openerTab = payload.parent;
      } else if (tab.openerTab == payload.previousParent) {
        tab.openerTab = null;
      }
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

    _handleTreeCloseButtonClick(event) {
      const path = event.composedPath();
      if (!path.some(node => node?.classList?.contains("tab-close-button"))) {
        return false;
      }
      const tab = path.find(node =>
        node?.classList?.contains("tabbrowser-tab")
      );
      if (
        !tab ||
        this._getLogicalTreeTab(tab) != tab ||
        !lazy.TreeTabsService.isCollapsed(tab)
      ) {
        return false;
      }
      const tabCount = lazy.TreeTabsService.getDescendants(tab).length + 1;
      if (tabCount < 25) {
        return false;
      }

      const [title, button] = window.gBrowser.tabLocalization.formatValuesSync([
        {
          id: "tabbrowser-confirm-close-tabs-title",
          args: { tabCount },
        },
        { id: "tabbrowser-confirm-close-tabs-button" },
      ]);
      const flags =
        Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
        Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_CANCEL;
      const choice = Services.prompt.confirmEx(
        window,
        title,
        null,
        flags,
        button,
        null,
        null,
        null,
        {}
      );
      if (choice == 0) {
        return false;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
    },

    _handleTreeAudioButtonClick(event) {
      const path = event.composedPath();
      const audioButton = path.find(node =>
        node?.classList?.contains("tab-audio-button")
      );
      const tab = this._getLogicalTreeTab(
        path.find(node => node?.classList?.contains("tabbrowser-tab"))
      );
      if (
        !audioButton ||
        !tab ||
        !lazy.TreeTabsService.isCollapsed(tab) ||
        tab.hasAttribute("soundplaying") ||
        tab.hasAttribute("muted") ||
        tab.hasAttribute("activemedia-blocked")
      ) {
        return false;
      }

      const descendants = lazy.TreeTabsService.getDescendants(tab);
      const unmute = descendants.some(
        descendant => descendant.linkedBrowser?.audioMuted
      );
      for (const descendant of descendants) {
        if (!descendant.linkedBrowser || descendant.closing) {
          continue;
        }
        if (unmute) {
          if (descendant.linkedBrowser.audioMuted) {
            descendant.toggleMuteAudio();
          }
          this._inheritedMuteTabs.delete(descendant);
        } else if (
          descendant.hasAttribute("soundplaying") &&
          !descendant.linkedBrowser.audioMuted
        ) {
          descendant.toggleMuteAudio();
          this._inheritedMuteTabs.add(descendant);
        }
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      return true;
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
          if (
            child.dataset.treeHidden != "true" ||
            !child.hasAttribute("soundplaying")
          ) {
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

      // Hidden tabs keep their tree links; only the rendering changes.
      this._updateAllTabs();
    },

    _handleTabPinned(tab) {
      if (!this._isEnabled() || !tab || !this._ownsTab(tab)) {
        return;
      }
      this._withAutoCollapseSuppressed(() => {
        const service = lazy.TreeTabsService;
        const groups = lazy.TreeTabsGroups;
        const parent = service.getParent(tab);
        if (!service.isActive(window)) {
          service.detachAllChildren(tab, parent ? { reparentTo: parent } : {});
          service.detachTab(tab);
          return;
        }
        service.expandSubtree(tab);
        const children = service.getChildren(tab);
        const siblings = parent
          ? service.getChildren(parent)
          : service.getRootTabs(window);
        const siblingIndex = siblings.indexOf(tab);
        const options = {
          automaticTitle: true,
          parent,
          insertBefore: siblings[siblingIndex + 1] || null,
          insertAfter: siblings[siblingIndex - 1] || null,
          siblingIndex,
        };

        if (children.length && groups.isGroupTab(tab)) {
          const alias = groups.groupTabs(window, children, {
            ...options,
            temporary: false,
          });
          if (alias) {
            groups.updateGroupTabURI(tab, {
              temporary: null,
              temporaryAggressive: null,
              aliasGuid: lazy.TreeTabsStore.getTabGuid(alias, { create: true }),
            });
          }
        } else if (
          children.length &&
          Services.prefs.getBoolPref(PREF_AUTO_GROUP_PINNED_OPENER, true)
        ) {
          groups.groupTabs(window, children, {
            ...options,
            openerGuid: lazy.TreeTabsStore.getTabGuid(tab, { create: true }),
            temporary: true,
          });
        } else {
          service.detachAllChildren(tab, parent ? { reparentTo: parent } : {});
        }
        service.detachTab(tab);
      });
      this._updateAllTabs();
    },

    _scheduleNativeGroupReconcile() {
      if (!this._isEnabled()) {
        return;
      }
      if (this._nativeGroupReconcileTimer) {
        window.clearTimeout(this._nativeGroupReconcileTimer);
      }
      this._nativeGroupReconcileTimer = window.setTimeout(() => {
        this._nativeGroupReconcileTimer = null;
        if (!this._isEnabled()) {
          return;
        }
        this._withFinalTreeRender(() => {
          const store = lazy.TreeTabsStore;
          let changed = false;
          if (store.isRestorePending(window)) {
            if (store.tryManualRestore(window)) {
              changed = true;
              this._syncSplitViewTrees();
              this._stopRestoreRetry();
              this._scheduleAllGroupCleanup();
            }
            if (store.isRestorePending(window)) {
              return;
            }
          }
          const service = lazy.TreeTabsService;
          for (const tab of window.gBrowser.tabs) {
            const parent = service.getParent(tab);
            if (parent && parent.group !== tab.group) {
              service.detachTab(tab);
              changed = true;
            }
          }
          if (changed) {
            this._updateAllTabs();
          }
        });
      });
    },

    _scheduleAllGroupCleanup(delay = 100) {
      if (!lazy.TreeTabsService.isActive(window)) {
        return;
      }
      this._groupCleanupScanAll = true;
      this._scheduleGroupCleanup([], delay);
    },

    _scheduleGroupCleanup(tabs, delay = 100) {
      if (!lazy.TreeTabsService.isActive(window)) {
        return;
      }
      for (const tab of tabs) {
        if (tab && !tab.closing && this._ownsTab(tab)) {
          this._groupCleanupTabs.add(tab);
        }
      }
      if (!this._groupCleanupScanAll && !this._groupCleanupTabs.size) {
        return;
      }
      if (this._groupCleanupTimer) {
        window.clearTimeout(this._groupCleanupTimer);
      }
      this._groupCleanupTimer = window.setTimeout(() => {
        this._groupCleanupTimer = null;
        const scanAll = this._groupCleanupScanAll;
        this._groupCleanupScanAll = false;
        const pending = this._groupCleanupTabs;
        this._groupCleanupTabs = new Set();
        if (!lazy.TreeTabsService.isActive(window)) {
          return;
        }
        if (scanAll) {
          for (const tab of window.gBrowser.tabs) {
            if (!tab.closing && lazy.TreeTabsGroups.isGroupTab(tab)) {
              pending.add(tab);
            }
          }
        }
        if (pending.size) {
          lazy.TreeTabsGroups.cleanupNeedlessGroupTabs(
            window,
            Array.from(pending)
          );
        }
      }, delay);
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
      if (!this._isEnabled() || !window.gBrowser?.tabs?.length) {
        return false;
      }

      if (
        this._hasTreeStructure() &&
        !lazy.TreeTabsStore.isRestorePending(window)
      ) {
        return false;
      }

      this._startRestoreRetry();
      return this._maybeTryManualRestore();
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
      if (
        !this._restoreRetryActive ||
        !this._isEnabled() ||
        !window.gBrowser?.tabs?.length ||
        !lazy.TreeTabsStore.tryManualRestore(window)
      ) {
        return false;
      }
      this._stopRestoreRetry();
      return true;
    },

    _isAutoCollapseOnSelectEnabled() {
      return Services.prefs.getBoolPref(PREF_AUTO_COLLAPSE_ON_SELECT, false);
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

      const selectedTab = this._getLogicalTreeTab(event?.target);
      if (!selectedTab || !this._ownsTab(selectedTab) || selectedTab.closing) {
        return;
      }
      this._applyAutoCollapseForTab(selectedTab);
    },

    _applyAutoCollapseForTab(selectedTab) {
      this._autoCollapseInProgress = true;
      try {
        const service = lazy.TreeTabsService;
        const ancestors = service.getAncestors(selectedTab);
        for (let i = ancestors.length - 1; i >= 0; i -= 1) {
          service.expandSubtree(ancestors[i]);
        }
        service.expandSubtree(selectedTab);

        const selectedRoot = this._getTreeRoot(selectedTab);
        if (!selectedRoot) {
          return;
        }
        service.expandSubtree(selectedRoot);

        const path = new Set([selectedTab, ...ancestors]);
        for (const ancestor of ancestors) {
          for (const child of service.getChildren(ancestor)) {
            if (
              !path.has(child) &&
              service.getChildren(child).length &&
              !service.isCollapsed(child) &&
              !this._manuallyExpandedTabs.has(child)
            ) {
              service.collapseSubtree(child);
            }
          }
        }

        for (const root of service.getRootTabs(window)) {
          if (root == selectedRoot) {
            continue;
          }
          if (
            service.getChildren(root).length &&
            !service.isCollapsed(root) &&
            !this._manuallyExpandedTabs.has(root)
          ) {
            service.collapseSubtree(root);
          }
        }
      } finally {
        this._autoCollapseInProgress = false;
      }
    },

    _handleTabSelect(event) {
      if (!this._isEnabled()) {
        return;
      }
      this._maybeAutoCollapseOnSelect(event);
      this._maybeScheduleSwitchingExpand(event.target);
      this._revealSelectedTab(event.target);
      this._updateHiddenTabs();
    },

    _handleTabAttrModified(event) {
      const changed = event.detail?.changed || [];
      if (!Array.isArray(changed)) {
        return;
      }
      if (changed.includes("muted")) {
        this._handleMutedStateChange(event.target);
      }
      if (changed.includes("muted") || changed.includes("soundplaying")) {
        this._updateAncestorSoundIndicators(event.target);
      }
      if (changed.includes("openerTab")) {
        this._handleOpenerChange(event.target);
      }
      if (changed.includes("label") && this._isEnabled()) {
        this._updateTabDisclosureLabel(event.target);
        for (const ancestor of lazy.TreeTabsService.getAncestors(
          event.target
        )) {
          this._updateTabTooltip(ancestor);
        }
      }
    },

    _updateAncestorSoundIndicators(tab) {
      if (!this._isEnabled() || !tab || !this._ownsTab(tab)) {
        return;
      }
      for (const ancestor of lazy.TreeTabsService.getAncestors(tab)) {
        this._updateTabSoundIndicator(ancestor);
      }
    },

    // A parent advertises the audio state of its subtree, so a collapsed
    // tree still shows that something inside it is playing or muted.
    _updateTabSoundIndicator(
      tab,
      descendants = lazy.TreeTabsService.getDescendants(tab)
    ) {
      let hasSound = false;
      let hasMuted = false;
      for (const descendant of descendants) {
        if (descendant.hasAttribute("muted")) {
          hasMuted = true;
        } else if (descendant.hasAttribute("soundplaying")) {
          hasSound = true;
        }
        if (hasSound && hasMuted) {
          break;
        }
      }
      tab.toggleAttribute("data-tree-has-sound-member", hasSound);
      tab.toggleAttribute("data-tree-has-muted-member", hasMuted);
    },

    // An extension changed openerTabId on an existing tab; mirror the new
    // opener into the tree, the reverse of _syncOpenerTab. Our own writes
    // assign openerTab directly and never raise this notification.
    _handleOpenerChange(tab) {
      if (!this._isEnabled() || !tab || tab.closing || !this._ownsTab(tab)) {
        return;
      }
      const service = lazy.TreeTabsService;
      const currentParent = service.getParent(tab);
      const parent = this._getLogicalTreeTab(tab.openerTab);
      const valid = !!(
        this._getLogicalTreeTab(tab) == tab &&
        parent &&
        parent != tab &&
        !parent.closing &&
        !parent.pinned &&
        !tab.pinned &&
        this._ownsTab(parent) &&
        parent.group === tab.group
      );
      if (!valid) {
        if (currentParent) {
          service.detachTab(tab);
        }
        return;
      }
      if (currentParent == parent) {
        return;
      }

      const children = service
        .getChildren(parent)
        .filter(child => child != tab)
        .sort((a, b) => a._tPos - b._tPos);
      const insertBefore = children.find(child => child._tPos > tab._tPos);
      const insertAfter = children.findLast(child => child._tPos < tab._tPos);
      let options = { index: 0 };
      if (insertBefore) {
        options = { insertBefore };
      } else if (insertAfter) {
        options = { insertAfter };
      }
      if (service.attachTab(tab, parent, options)) {
        TreeTabsDnD._syncSubtreeStripPosition(tab);
      }
    },

    _handleKeyEvent(event) {
      if (isolateDisclosureKeyEvent(event)) {
        return;
      }
      if (
        event.type == "keydown" &&
        event.currentTarget == window &&
        this._handleGlobalTreeKeyDown(event)
      ) {
        return;
      }
      const switchingModifier =
        Services.appinfo.OS == "Darwin" ? "Meta" : "Control";
      if (event.key == switchingModifier) {
        if (event.type == "keydown") {
          this._switchingModifierHeld = true;
        } else {
          this._switchingModifierHeld = false;
          this._cancelSwitchingExpand();
        }
      }
      if (event.type == "keydown" && event.currentTarget != window) {
        this._handleTabTreeKeyDown(event);
      }
    },

    _handleGlobalTreeKeyDown(event) {
      if (
        !this._isEnabled() ||
        !this._tabContainer?.verticalMode ||
        event.defaultPrevented ||
        event.isComposing ||
        !event.shiftKey
      ) {
        return false;
      }
      if (
        event
          .composedPath()
          .some(
            node =>
              node?.isContentEditable ||
              ["input", "textarea"].includes(node?.localName)
          )
      ) {
        return false;
      }
      const mac = Services.appinfo.OS == "Darwin";
      if (
        (mac && (!event.ctrlKey || event.altKey || event.metaKey)) ||
        (!mac && (!event.altKey || event.ctrlKey || event.metaKey))
      ) {
        return false;
      }
      if (
        !["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
      ) {
        return false;
      }

      const service = lazy.TreeTabsService;
      const tab = this._getLogicalTreeTab(window.gBrowser.selectedTab);
      if (!tab || tab.pinned) {
        return false;
      }
      let target = null;
      if (event.key == "ArrowLeft") {
        if (service.getChildren(tab).length && !service.isCollapsed(tab)) {
          service.collapseSubtree(tab);
          this._setManuallyExpanded(tab, false);
        } else {
          target = service.getParent(tab);
        }
      } else if (event.key == "ArrowRight") {
        if (service.isCollapsed(tab)) {
          service.expandSubtree(tab);
          this._setManuallyExpanded(tab, true);
        } else {
          target = service.getChildren(tab)[0] || null;
        }
      } else {
        const visible = service.getVisibleTabs(window);
        const index = visible.indexOf(tab);
        target = visible[index + (event.key == "ArrowUp" ? -1 : 1)] || null;
      }
      if (target && !target.closing) {
        this._focusTab(target);
      }
      event.preventDefault();
      event.stopPropagation();
      return true;
    },

    _handleDragEnd() {
      // Some drops skip the after* hook, while transition-driven moves may
      // reach it after dragend; delay the fallback reset for pending drops.
      if (TreeTabsDnD._dropPending) {
        const generation = TreeTabsDnD._dropGeneration;
        window.setTimeout(() => {
          if (
            TreeTabsDnD._dropPending &&
            TreeTabsDnD._dropGeneration == generation
          ) {
            TreeTabsDnD._endDrop();
          }
        }, 2000);
      } else {
        TreeTabsDnD._endDrop();
      }
      this._clearDropTarget();
      this._restoreDragAutoExpandedTabs();
    },

    // A link dropped onto a tab natively replaces that tab's page. Offer
    // opening it as a child of the tab instead: 0 load, 1 ask, 2 child.
    _maybeInterceptLinkDrop(event) {
      if (!this._isEnabled() || !this._tabContainer?.verticalMode) {
        return;
      }
      const types = event.dataTransfer?.types;
      if (!types || types.includes(TAB_DROP_TYPE)) {
        return;
      }

      const target = this._tabContainer.tabDragAndDrop?._getDragTarget?.(
        event,
        { ignoreSides: true }
      );
      const isGroupLabel = window.gBrowser.isTabGroupLabel?.(target);
      const targetTab = target?.classList?.contains("tabbrowser-tab")
        ? target
        : null;
      const targetGroup = target?.group || targetTab?.group || null;
      if (isGroupLabel && targetGroup) {
        this._openDroppedLinksInGroup(event, targetGroup);
        return;
      }

      const behavior = Services.prefs.getIntPref(PREF_DROP_LINKS_ON_TAB, 1);
      if (
        !targetTab ||
        targetTab.pinned ||
        targetTab.closing ||
        (behavior === 0 && !targetGroup)
      ) {
        return;
      }

      const dropped = this._readDroppedLinks(event);
      if (!dropped) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this._clearDropTarget();
      this._openDroppedLinksOnTab({
        ...dropped,
        behavior,
        inBackground: this._getDropInBackground(event),
        targetGroup,
        targetTab,
      });
    },

    _readDroppedLinks(event) {
      let links;
      try {
        links = Services.droppedLinkHandler.dropLinks(event, true);
      } catch {
        return null;
      }
      if (!links?.length) {
        return null;
      }
      return {
        urls: links.map(link => link.url),
        triggeringPrincipal:
          Services.droppedLinkHandler.getTriggeringPrincipal(event),
        policyContainer: Services.droppedLinkHandler.getPolicyContainer(event),
      };
    },

    _getDropInBackground(event) {
      const configured = Services.prefs.getBoolPref(
        "browser.tabs.loadInBackground"
      );
      return event.shiftKey ? !configured : configured;
    },

    async _confirmDroppedLinks(urls) {
      return lazy.OpenInTabsUtils.promiseConfirmOpenInTabs(urls.length, window);
    },

    async _openDroppedLinksOnTab({
      behavior,
      inBackground,
      policyContainer,
      targetGroup,
      targetTab,
      triggeringPrincipal,
      urls,
    }) {
      targetTab = this._getLogicalTreeTab(targetTab);
      targetGroup ||= targetTab?.group || null;
      try {
        let action = behavior;
        if (action === 1) {
          action = await this._promptDropLinkAction();
        }
        if (targetTab.closing || !(await this._confirmDroppedLinks(urls))) {
          return;
        }
        if (action !== 2) {
          window.gBrowser.loadTabs(urls, {
            inBackground: true,
            replace: true,
            allowThirdPartyFixup: true,
            targetTab,
            tabGroup: targetGroup,
            triggeringPrincipal,
            policyContainer,
            userContextId: targetTab.userContextId,
          });
          return;
        }

        const service = lazy.TreeTabsService;
        let previousChild = service.getChildren(targetTab).at(-1) || null;
        let firstTab = null;
        for (const url of urls) {
          const tab = window.gBrowser.addTab(url, {
            triggeringPrincipal,
            policyContainer,
            allowThirdPartyFixup: true,
            openerBrowser: targetTab.linkedBrowser,
            tabGroup: targetGroup,
            userContextId: targetTab.userContextId,
          });
          service.attachTab(
            tab,
            targetTab,
            previousChild ? { insertAfter: previousChild } : { index: 0 }
          );
          TreeTabsDnD._syncSubtreeStripPosition(tab);
          previousChild = tab;
          firstTab ||= tab;
        }
        if (firstTab && !inBackground) {
          window.gBrowser.selectedTab = firstTab;
        }
      } finally {
        this._restoreDragAutoExpandedTabs();
      }
    },

    async _openDroppedLinksInGroup(event, group) {
      const dropped = this._readDroppedLinks(event);
      if (!group || !dropped) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this._clearDropTarget();
      const inBackground = this._getDropInBackground(event);
      try {
        if (!(await this._confirmDroppedLinks(dropped.urls))) {
          return;
        }
        const tabs = window.gBrowser.loadTabs(dropped.urls, {
          inBackground,
          replace: false,
          allowThirdPartyFixup: true,
          tabGroup: group,
          triggeringPrincipal: dropped.triggeringPrincipal,
          policyContainer: dropped.policyContainer,
        });
        if (tabs.length && !inBackground) {
          window.gBrowser.selectedTab = tabs[0];
        }
      } finally {
        this._restoreDragAutoExpandedTabs();
      }
    },

    async _promptDropLinkAction() {
      const [title, message, loadLabel, childLabel, remember] =
        await window.document.l10n.formatValues([
          { id: "waterfox-tree-drop-link-title" },
          { id: "waterfox-tree-drop-link-message" },
          { id: "waterfox-tree-drop-link-load" },
          { id: "waterfox-tree-drop-link-child" },
          { id: "waterfox-tree-drop-link-remember" },
        ]);
      const flags =
        Services.prompt.BUTTON_POS_0 * Services.prompt.BUTTON_TITLE_IS_STRING +
        Services.prompt.BUTTON_POS_1 * Services.prompt.BUTTON_TITLE_IS_STRING;
      const checkState = { value: false };
      const choice = Services.prompt.confirmEx(
        window,
        title,
        message,
        flags,
        childLabel,
        loadLabel,
        null,
        remember,
        checkState
      );
      const action = choice === 0 ? 2 : 0;
      if (checkState.value) {
        Services.prefs.setIntPref(PREF_DROP_LINKS_ON_TAB, action);
      }
      return action;
    },

    _handleNewTabActionCommand(event) {
      const action = event.target?.dataset?.treeNewtabAction;
      if (!action || !this._isEnabled() || !this._tabContainer?.verticalMode) {
        return;
      }
      const gBrowser = window.gBrowser;
      const service = lazy.TreeTabsService;
      const base = this._getLogicalTreeTab(gBrowser.selectedTab);
      if (!base || (action != "independent" && base.pinned)) {
        return;
      }

      let anchor = null;
      let parent = null;
      if (action == "child") {
        parent = base;
        anchor = service.getSubtreeEndAnchor(base);
      } else if (action == "next-sibling") {
        parent = service.getParent(base);
        anchor = service.getSubtreeEndAnchor(base);
      } else if (action == "sibling") {
        parent = service.getParent(base);
        anchor = parent
          ? service.getSubtreeEndAnchor(parent)
          : base.group?.tabs.at(-1) ||
            Array.from(gBrowser.tabs).findLast(tab => !tab.pinned);
      }

      const newTab = gBrowser.addTrustedTab(
        window.BROWSER_NEW_TAB_URL || "about:newtab",
        {
          tabIndex: anchor ? anchor._tPos + 1 : undefined,
          tabGroup: action == "independent" ? null : base.group,
          focusUrlBar: true,
        }
      );
      if (action == "child") {
        service.attachTab(newTab, base);
      } else if (action == "next-sibling") {
        service.onTabOpened(newTab, { nextSiblingOf: base });
      } else if (action == "sibling" && parent) {
        service.attachTab(newTab, parent);
      } else {
        service.detachTab(newTab);
      }
      gBrowser.selectedTab = newTab;
    },

    // Landing on a collapsed parent while cycling tabs with the accelerator
    // held expands it after a short hold, so the next cycle can reach inside.
    _maybeScheduleSwitchingExpand(tab) {
      this._cancelSwitchingExpand();
      tab = this._getLogicalTreeTab(tab);
      if (
        !lazy.TreeTabsService.isActive(window) ||
        !this._switchingModifierHeld ||
        !tab ||
        !this._ownsTab(tab) ||
        !lazy.TreeTabsService.isCollapsed(tab) ||
        !lazy.TreeTabsService.getChildren(tab).length
      ) {
        return;
      }
      this._switchingExpandTimer = window.setTimeout(() => {
        this._switchingExpandTimer = null;
        if (
          !lazy.TreeTabsService.isActive(window) ||
          tab.closing ||
          this._getLogicalTreeTab(window.gBrowser?.selectedTab) != tab ||
          !lazy.TreeTabsService.isCollapsed(tab)
        ) {
          return;
        }
        this._withAutoCollapseSuppressed(() => {
          if (this._isAutoCollapseOnSelectEnabled()) {
            this._applyAutoCollapseForTab(tab);
          } else {
            lazy.TreeTabsService.expandSubtree(tab);
          }
        });
      }, 800);
    },

    _cancelSwitchingExpand() {
      if (this._switchingExpandTimer) {
        window.clearTimeout(this._switchingExpandTimer);
        this._switchingExpandTimer = null;
      }
    },

    // Selection can land on a tab hidden by a collapsed ancestor, e.g. the
    // successor picked when the active tab closes, since Firefox does not
    // know about tree visibility. An invisible active tab is worse than
    // expanding the tree, so reveal it.
    _revealSelectedTab(tab) {
      tab = this._getLogicalTreeTab(tab);
      if (
        !lazy.TreeTabsService.isActive(window) ||
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
      if (
        !lazy.TreeTabsService.isActive(window) ||
        this._isStickyActiveTabEnabled()
      ) {
        return;
      }
      const selected = window.gBrowser?.selectedTab;
      const logicalSelected = this._getLogicalTreeTab(selected);
      if (
        !logicalSelected ||
        logicalSelected == collapsedRoot ||
        !lazy.TreeTabsService.getAncestors(logicalSelected).includes(
          collapsedRoot
        ) ||
        !lazy.TreeTabsService.isSubtreeCollapsed(logicalSelected)
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
        tab.splitview ||
        tab.closing ||
        !this._ownsTab(tab) ||
        this._isWindowRestoring ||
        lazy.TreeTabsStore._restoringWindows?.has(window) ||
        lazy.TreeTabsStore.isRestoringClosedTreeSet(window)
      ) {
        return;
      }
      const service = lazy.TreeTabsService;
      if (service.getChildren(tab).length && !this._isSubtreeContiguous(tab)) {
        if (service.isCollapsed(tab) && this._tabContainer?.verticalMode) {
          // A collapsed subtree moves as one unit, so bring the descendants
          // along, hidden ones included. With no visible tree the subtree
          // stays behind under the promoted first child instead.
          this._moveSubtreeAfter(tab);
        } else {
          service.onTabMoved(tab, { detachChildren: true });
        }
      }
      const placement = TreeTabsDnD._resolvePlacement(tab, null, null);
      if (placement) {
        TreeTabsDnD._applyPlacement(tab, placement);
      }
    },

    _moveSubtreeAfter(tab) {
      const descendants = TreeTabsDnD._toNativeMovingElements(
        lazy.TreeTabsService.getDescendants(tab)
      );
      if (!descendants.length) {
        return;
      }
      const wasSuppressed = TreeTabsDnD._suppressMoveFixup;
      TreeTabsDnD._suppressMoveFixup = true;
      try {
        window.gBrowser.moveTabsAfter(descendants, tab.splitview || tab);
      } finally {
        TreeTabsDnD._suppressMoveFixup = wasSuppressed;
      }
    },

    _isSubtreeContiguous(tab) {
      const elements = TreeTabsDnD._toNativeMovingElements(
        TreeTabsDnD._collectSubtreeTabs(tab, lazy.TreeTabsService)
      );
      const tabs = elements.flatMap(item => item.tabs || [item]);
      return tabs.every((item, index) => item._tPos == tab._tPos + index);
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

    _getTwistyTabFromEvent(event) {
      if (
        !this._isEnabled() ||
        !this._tabContainer?.verticalMode ||
        !this._tabContainer.hasAttribute("expanded") ||
        event?.button != 0
      ) {
        return null;
      }
      const disclosure = event.target?.closest?.(".tab-tree-disclosure");
      const tab = disclosure?.closest(".tabbrowser-tab");
      return disclosure &&
        !disclosure.hidden &&
        this._ownsTab(tab) &&
        !tab.closing &&
        !tab.pinned &&
        lazy.TreeTabsService.getChildren(tab).length
        ? tab
        : null;
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
        const expand = lazy.TreeTabsService.isCollapsed(tab);
        lazy.TreeTabsService.toggleCollapsed(tab);
        this._setManuallyExpanded(tab, expand);
      });
    },

    _closeTreeTabs(tab) {
      this._closeTrees([this._getLogicalTreeTab(tab)]);
    },

    _withClosedTreeSet(tabs, callback) {
      const store = lazy.TreeTabsStore;
      const ownsSnapshot =
        !store.hasActiveClosedTreeSet(window) &&
        store.beginClosedTreeSet(window, tabs);
      try {
        return callback();
      } finally {
        if (ownsSnapshot) {
          store.finishClosedTreeSet(window);
        }
      }
    },

    _closeTrees(roots, { descendantsOnly = false } = {}) {
      const tabsToClose = this._getTreeContextTabs(roots, {
        descendantsOnly,
      }).filter(tab => tab && !tab.closing);
      this._withClosedTreeSet(tabsToClose, () => {
        for (const root of roots) {
          if (descendantsOnly) {
            lazy.TreeTabsService.closeDescendants(root);
          } else {
            lazy.TreeTabsService.closeTree(root);
          }
        }
        this._removeTreeTabs(tabsToClose);
      });
    },

    _removeTreeTabs(tabsToClose, baseTab = null) {
      tabsToClose = [
        ...new Set(tabsToClose.flatMap(tab => this._getTreeNodeTabs(tab))),
      ].filter(tab => tab && !tab.closing);
      const members = baseTab
        ? [...this._getTreeNodeTabs(baseTab), ...tabsToClose]
        : tabsToClose;
      this._withClosedTreeSet(members, () => {
        if (tabsToClose.length) {
          window.gBrowser.removeTabs(tabsToClose);
        }
      });
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

      const tab = this._getLogicalTreeTab(this._getTabFromEvent(event));
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
        const expand = lazy.TreeTabsService.isCollapsed(tab);
        lazy.TreeTabsService.toggleCollapsed(tab);
        this._setManuallyExpanded(tab, expand);
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

      const tab = this._getLogicalTreeTab(
        this._getTabFromEvent(event) || window.gBrowser?.selectedTab
      );
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
          this._setManuallyExpanded(tab, false);
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
        this._setManuallyExpanded(tab, true);
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
      this._updateNewTabActionButton();

      this._clearDropTarget();
      if (enabled) {
        this._withFinalTreeRender(() => {
          this._maybeRestoreTreeStructure();
          this._syncSplitViewTrees();
          this._updateAllTabs();
        });
        this._scheduleNativeGroupReconcile();
        this._scheduleAllGroupCleanup(1000);
      } else {
        // Keep the model so toggling the pref back on brings the tree back.
        this._treeRenderPending = false;
        this._inheritedMuteTabs = new WeakSet();
        this._clearAllTabs();
      }
    },

    // Restore and normalization own their final synchronous projection, including
    // updates requested by model observers and selection repair along the way.
    _withFinalTreeRender(callback) {
      const wasDeferring = this._deferringTreeRender;
      this._deferringTreeRender = true;
      let pending;
      try {
        callback();
      } finally {
        this._deferringTreeRender = wasDeferring;
        pending = this._treeRenderPending;
        if (pending && !wasDeferring && !this._isWindowRestoring) {
          this._updateAllTabs();
        }
      }
      return pending;
    },

    _deferTreeRender() {
      if (this._deferringTreeRender || this._isWindowRestoring) {
        this._treeRenderPending = true;
        return true;
      }
      return false;
    },

    _updateAllTabs() {
      if (this._deferTreeRender()) {
        return;
      }
      this._treeRenderPending = false;
      const indentPx = Services.prefs.getIntPref(PREF_INDENT_PX, 16);
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
      this._tabContainer?._invalidateCachedVisibleTabs?.();
    },

    _updateTab(tab, indentPx, maxVisualLevel) {
      if (!tab || this._deferTreeRender()) {
        return;
      }

      const level = lazy.TreeTabsService.getLevel(tab);
      const maxLevel =
        maxVisualLevel ??
        Math.floor(
          Math.max(
            0,
            (this._verticalTabsBox?.getBoundingClientRect().width || 250) - 120
          ) / (indentPx ?? Services.prefs.getIntPref(PREF_INDENT_PX, 16))
        );
      const clampedLevel = Math.min(level, maxLevel);
      tab.dataset.treeLevel = String(level);
      tab.style.setProperty("--tree-level", clampedLevel);

      // The pair's wrapper takes the indent of its tree-bearing first pane;
      // the panes themselves stay flush inside it.
      const wrapper = tab.splitview;
      if (wrapper && wrapper.tabs?.[0] == tab) {
        wrapper.dataset.treeLevel = String(level);
        wrapper.style.setProperty("--tree-level", clampedLevel);
      }

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

      const descendants = lazy.TreeTabsService.getDescendants(tab);
      this._updateTabSoundIndicator(tab, descendants);
      const collapsed = lazy.TreeTabsService.isCollapsed(tab);
      this._updateTabDisclosure(tab, !!children.length, collapsed);

      const tabContent = tab.querySelector(".tab-content");
      if (collapsed) {
        tab.dataset.treeCollapsed = "true";
        tabContent?.setAttribute(
          "data-tree-counter",
          String(descendants.length)
        );
      } else {
        tab.removeAttribute("data-tree-collapsed");
        tabContent?.removeAttribute("data-tree-counter");
      }
      this._updateTabTooltip(tab, descendants, level);
    },

    _updateTabDisclosure(tab, hasChildren, collapsed) {
      const available =
        hasChildren && !tab.pinned && this._tabContainer?.verticalMode;
      if (available) {
        tab.setAttribute("aria-expanded", String(!collapsed));
      } else {
        tab.removeAttribute("aria-expanded");
      }
      const disclosure = tab.querySelector(".tab-tree-disclosure");
      if (!disclosure) {
        return;
      }
      disclosure.hidden = !available;
      if (!available) {
        disclosure.removeAttribute("aria-expanded");
        disclosure.removeAttribute("aria-label");
      } else if (
        disclosure.getAttribute("aria-expanded") != String(!collapsed)
      ) {
        disclosure.setAttribute("aria-expanded", String(!collapsed));
        this._updateTabDisclosureLabel(tab, disclosure);
      }
    },

    _updateTabDisclosureLabel(
      tab,
      disclosure = tab.querySelector(".tab-tree-disclosure")
    ) {
      if (!disclosure || disclosure.hidden) {
        return;
      }
      disclosure.setAttribute(
        "aria-label",
        lazy.l10n.formatValueSync(
          disclosure.getAttribute("aria-expanded") == "false"
            ? "waterfox-tree-disclosure-expand"
            : "waterfox-tree-disclosure-collapse",
          { tabTitle: tab.label }
        )
      );
    },

    _updateTabTooltip(tab, descendants, level) {
      if (this._deferTreeRender()) {
        return;
      }
      const logicalTab = this._getLogicalTreeTab(tab);
      let tooltip;
      if (logicalTab != tab) {
        tooltip = logicalTab?._treeDescendantsTooltip;
      } else if (lazy.TreeTabsService.isCollapsed(tab)) {
        descendants ??= lazy.TreeTabsService.getDescendants(tab);
        level ??= lazy.TreeTabsService.getLevel(tab);
        tooltip = descendants
          .map(descendant => {
            const relativeLevel =
              lazy.TreeTabsService.getLevel(descendant) - level;
            return `${"  ".repeat(relativeLevel)}${descendant.label}`;
          })
          .join("\n");
      }
      for (const pane of logicalTab == tab
        ? this._getTreeNodeTabs(tab)
        : [tab]) {
        if (tooltip !== undefined) {
          pane._treeDescendantsTooltip = tooltip;
          pane.dataset.treeDescendantsTooltip = "true";
        } else {
          delete pane._treeDescendantsTooltip;
          pane.removeAttribute("data-tree-descendants-tooltip");
        }
      }
    },

    _updateHiddenTabs() {
      if (this._deferTreeRender()) {
        return;
      }
      const visible = new Set(lazy.TreeTabsService.getVisibleTabs(window));
      const stickyActiveTabEnabled = this._isStickyActiveTabEnabled();
      const selectedTab = stickyActiveTabEnabled
        ? window.gBrowser?.selectedTab
        : null;
      const selectedLogicalTab = this._getLogicalTreeTab(selectedTab);
      let changed = false;
      const setHidden = (tab, hidden) => {
        if ((tab.dataset.treeHidden == "true") == hidden) {
          return;
        }
        if (hidden) {
          tab.dataset.treeHidden = "true";
        } else {
          tab.removeAttribute("data-tree-hidden");
        }
        changed = true;
      };

      for (const tab of window.gBrowser.tabs) {
        // A split pane row follows the visibility of its tree-bearing pane.
        const mainPane = tab.splitview?.tabs?.[0];
        const anchor = mainPane && mainPane != tab ? mainPane : tab;
        // TabOpen can precede model registration. A tab without a tree parent
        // cannot be hidden by a collapsed ancestor.
        const shouldShow =
          visible.size === 0 ||
          visible.has(anchor) ||
          !lazy.TreeTabsService.getParent(anchor) ||
          (stickyActiveTabEnabled && anchor == selectedLogicalTab);
        setHidden(tab, !shouldShow);
      }
      for (const wrapper of this._tabContainer?.allSplitViews || []) {
        const hidden = wrapper.tabs?.[0]?.dataset.treeHidden == "true";
        if (wrapper.hasAttribute("data-tree-hidden") != hidden) {
          wrapper.toggleAttribute("data-tree-hidden", hidden);
          changed = true;
        }
      }

      // data-tree-hidden affects tab.visible, so invalidate its dependent
      // caches.
      if (changed) {
        this._tabContainer?._invalidateCachedVisibleTabs?.();
      }
    },

    _clearTab(tab) {
      tab.removeAttribute("data-tree-level");
      tab.removeAttribute("data-tree-parent");
      tab.removeAttribute("data-tree-has-children");
      tab.removeAttribute("data-tree-collapsed");
      this._updateTabDisclosure(tab, false, false);
      tab.querySelector(".tab-content")?.removeAttribute("data-tree-counter");
      tab.removeAttribute("data-tree-hidden");
      tab.removeAttribute("data-tree-drop-target");
      tab.removeAttribute("data-tree-has-sound-member");
      tab.removeAttribute("data-tree-has-muted-member");
      delete tab._treeDescendantsTooltip;
      tab.removeAttribute("data-tree-descendants-tooltip");
      if (tab.splitview) {
        tab.splitview.removeAttribute("data-tree-level");
        tab.splitview.removeAttribute("data-tree-hidden");
        tab.splitview.style.removeProperty("--tree-level");
      }
      tab.style.removeProperty("--tree-level");
    },

    _updateDropTarget(event) {
      const draggedTab = TreeTabsDnD._getDraggedTab(event);
      if (
        event.eventPhase == window.Event.CAPTURING_PHASE &&
        TreeTabsDnD._isEnabled(this._tabContainer) &&
        draggedTab?.container == this._tabContainer &&
        !draggedTab.pinned &&
        !draggedTab.multiselected &&
        !draggedTab._dragData?.fromTabList &&
        this._tabContainer.tabDragAndDrop.getDropEffectForTabDrag(event) ==
          "move"
      ) {
        // The native dragover hook updates the outline after resolving its gap.
        return;
      }
      const parent =
        draggedTab && !draggedTab.multiselected
          ? TreeTabsDnD._previewDropParent(event, draggedTab)
          : null;
      const nativeTarget =
        !draggedTab && event.dataTransfer?.types?.length
          ? this._tabContainer.tabDragAndDrop?._getDragTarget?.(event, {
              ignoreSides: true,
            })
          : null;
      const hoverTab =
        parent ||
        this._getLogicalTreeTab(
          nativeTarget?.classList?.contains("tabbrowser-tab")
            ? nativeTarget
            : null
        );

      if (this._dropTargetTab && this._dropTargetTab != parent) {
        this._dropTargetTab.removeAttribute("data-tree-drop-target");
        this._dropTargetTab = null;
      }

      if (parent) {
        parent.dataset.treeDropTarget = "child";
        this._dropTargetTab = parent;
      }
      if (hoverTab) {
        this._scheduleDragHoverExpand(hoverTab);
      } else {
        this._cancelDragHoverExpand();
      }

      this._maybeScheduleGroupHoverExpand(event);
    },

    _maybeScheduleGroupHoverExpand(event) {
      if (!event.dataTransfer?.types?.length) {
        return;
      }
      const target = this._tabContainer.tabDragAndDrop?._getDragTarget?.(
        event,
        { ignoreSides: true }
      );
      const group = target?.group || null;
      if (!group || !group.collapsed) {
        this._cancelGroupHoverExpand();
        return;
      }
      if (this._dragHoverExpandGroup == group) {
        return;
      }
      this._cancelGroupHoverExpand();
      this._dragHoverExpandGroup = group;
      const delay = Services.prefs.getIntPref(
        "browser.tabs.dragDrop.expandGroup.delayMS",
        500
      );
      this._dragHoverExpandGroupTimer = window.setTimeout(() => {
        this._dragHoverExpandGroupTimer = null;
        this._dragHoverExpandGroup = null;
        if (group.isConnected && group.collapsed) {
          this._dragAutoExpandedGroups.add(group);
          group.collapsed = false;
        }
      }, delay);
    },

    _cancelGroupHoverExpand() {
      if (this._dragHoverExpandGroupTimer) {
        window.clearTimeout(this._dragHoverExpandGroupTimer);
        this._dragHoverExpandGroupTimer = null;
      }
      this._dragHoverExpandGroup = null;
    },

    // Lingering over a collapsed parent while dragging expands it, so the
    // drop can land inside; trees expanded this way fold back after the drag.
    _scheduleDragHoverExpand(tab) {
      if (this._dragHoverExpandTab == tab) {
        return;
      }
      this._cancelDragHoverExpand();
      if (!lazy.TreeTabsService.isCollapsed(tab)) {
        return;
      }
      this._dragHoverExpandTab = tab;
      this._dragHoverExpandTimer = window.setTimeout(() => {
        this._dragHoverExpandTimer = null;
        this._dragHoverExpandTab = null;
        if (
          !tab.isConnected ||
          tab.closing ||
          !lazy.TreeTabsService.isCollapsed(tab)
        ) {
          return;
        }
        this._withAutoCollapseSuppressed(() => {
          lazy.TreeTabsService.expandSubtree(tab);
        });
        this._dragAutoExpandedTabs.add(tab);
      }, 500);
    },

    _cancelDragHoverExpand() {
      if (this._dragHoverExpandTimer) {
        window.clearTimeout(this._dragHoverExpandTimer);
        this._dragHoverExpandTimer = null;
      }
      this._dragHoverExpandTab = null;
    },

    _restoreDragAutoExpandedTabs() {
      this._cancelDragHoverExpand();
      this._cancelGroupHoverExpand();
      if (TreeTabsDnD._dropPending) {
        return;
      }
      for (const group of this._dragAutoExpandedGroups) {
        if (group.isConnected && !group.collapsed) {
          group.collapsed = true;
        }
      }
      this._dragAutoExpandedGroups.clear();
      if (!this._dragAutoExpandedTabs.size) {
        return;
      }
      const service = lazy.TreeTabsService;
      const selected = this._getLogicalTreeTab(window.gBrowser?.selectedTab);
      for (const tab of this._dragAutoExpandedTabs) {
        if (tab.closing || !tab.isConnected) {
          continue;
        }
        // Keep a tree open when the drag left the active tab inside it.
        if (
          selected &&
          (selected == tab || service.getAncestors(selected).includes(tab))
        ) {
          continue;
        }
        this._withAutoCollapseSuppressed(() => {
          service.collapseSubtree(tab);
        });
      }
      this._dragAutoExpandedTabs.clear();
    },

    _clearDropTarget() {
      if (this._dropTargetTab) {
        this._dropTargetTab.removeAttribute("data-tree-drop-target");
        this._dropTargetTab = null;
      }
      this._cancelDragHoverExpand();
      this._cancelGroupHoverExpand();
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
      const contextRoots = this._getTreeContextRoots();
      const treeContextEnabled =
        this._isEnabled() &&
        this._tabContainer?.verticalMode &&
        !!treeService &&
        !!contextRoots.length;

      if (!treeContextEnabled) {
        this._setTreeContextMenuHidden(true);
        return;
      }

      const contextReloadTree = document.getElementById("context_reloadTree");
      const contextToggleMuteTree = document.getElementById(
        "context_toggleMuteTree"
      );
      const contextUnloadTree = document.getElementById("context_unloadTree");
      const contextCollapseTree = document.getElementById(
        "context_collapseTree"
      );
      const contextExpandTree = document.getElementById("context_expandTree");
      const contextCollapseTreeRecursively = document.getElementById(
        "context_collapseTreeRecursively"
      );
      const contextExpandTreeRecursively = document.getElementById(
        "context_expandTreeRecursively"
      );
      const contextCloseTree = document.getElementById("context_closeTree");
      const contextCloseDescendants = document.getElementById(
        "context_closeDescendants"
      );
      const contextCollapseAll = document.getElementById("context_collapseAll");
      const contextExpandAll = document.getElementById("context_expandAll");
      const contextBookmarkTree = document.getElementById(
        "context_bookmarkTree"
      );
      const contextCopyTreeLinks = document.getElementById(
        "context_copyTreeLinks"
      );
      const contextCopyDescendantsLinks = document.getElementById(
        "context_copyDescendantsLinks"
      );

      const descendantNodes = [
        ...new Set(
          contextRoots.flatMap(root => treeService.getDescendants(root))
        ),
      ];
      const hasDescendants = !!descendantNodes.length;
      const treeTabs = this._getTreeContextTabs(contextRoots);
      const allMuted = treeTabs.every(tab => tab.linkedBrowser?.audioMuted);
      document.l10n.setAttributes(
        contextToggleMuteTree,
        allMuted
          ? "waterfox-tab-context-unmute-tree"
          : "waterfox-tab-context-mute-tree"
      );

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

      contextReloadTree.hidden = false;
      contextToggleMuteTree.hidden = false;
      contextUnloadTree.hidden = !treeTabs.some(
        tab => !tab.pinned && !tab.discarded
      );
      contextCollapseTree.hidden = !contextRoots.some(
        root =>
          treeService.getChildren(root).length && !treeService.isCollapsed(root)
      );
      contextExpandTree.hidden = !contextRoots.some(
        root =>
          treeService.getChildren(root).length && treeService.isCollapsed(root)
      );
      contextCollapseTreeRecursively.hidden = !hasDescendants;
      contextExpandTreeRecursively.hidden = ![
        ...contextRoots,
        ...descendantNodes,
      ].some(tab => treeService.isCollapsed(tab));
      contextCloseTree.hidden = !hasDescendants;
      contextCloseDescendants.hidden = !hasDescendants;
      contextBookmarkTree.hidden = false;
      contextCopyTreeLinks.hidden = !hasDescendants;
      contextCopyDescendantsLinks.hidden = !hasDescendants;
      contextCollapseAll.hidden = !hasAnyTree;
      contextExpandAll.hidden = !hasAnyCollapsed;

      separator.hidden =
        contextReloadTree.hidden &&
        contextToggleMuteTree.hidden &&
        contextUnloadTree.hidden &&
        contextCollapseTree.hidden &&
        contextExpandTree.hidden &&
        contextCollapseTreeRecursively.hidden &&
        contextExpandTreeRecursively.hidden &&
        contextCloseTree.hidden &&
        contextCloseDescendants.hidden &&
        contextBookmarkTree.hidden &&
        contextCopyTreeLinks.hidden &&
        contextCopyDescendantsLinks.hidden &&
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
      const contextRoots = this._getTreeContextRoots();
      if (
        !contextRoots.length &&
        commandId != "context_collapseAll" &&
        commandId != "context_expandAll"
      ) {
        return;
      }
      const treeNodes = [
        ...new Set(
          contextRoots.flatMap(root => [
            root,
            ...treeService.getDescendants(root),
          ])
        ),
      ];
      const treeTabs = this._getTreeContextTabs(contextRoots);

      this._withAutoCollapseSuppressed(() => {
        switch (commandId) {
          case "context_reloadTree":
            window.gBrowser.reloadTabs(treeTabs);
            break;
          case "context_toggleMuteTree": {
            const mute = treeTabs.some(tab => !tab.linkedBrowser?.audioMuted);
            for (const tab of treeTabs.toReversed()) {
              if (!!tab.linkedBrowser?.audioMuted != mute) {
                tab.toggleMuteAudio();
              }
            }
            break;
          }
          case "context_unloadTree":
            void window.gBrowser.explicitUnloadTabs(
              treeTabs.filter(tab => !tab.pinned && !tab.discarded)
            );
            break;
          case "context_collapseTree":
            for (const root of contextRoots) {
              treeService.collapseSubtree(root);
              this._setManuallyExpanded(root, false);
            }
            break;
          case "context_expandTree":
            for (const root of contextRoots) {
              treeService.expandSubtree(root);
              this._setManuallyExpanded(root, true);
            }
            break;
          case "context_collapseTreeRecursively":
            for (const tab of treeNodes.toReversed()) {
              if (treeService.getChildren(tab).length) {
                treeService.collapseSubtree(tab);
                this._setManuallyExpanded(tab, false);
              }
            }
            break;
          case "context_expandTreeRecursively":
            for (const tab of treeNodes) {
              treeService.expandSubtree(tab);
              this._setManuallyExpanded(tab, true);
            }
            break;
          case "context_closeTree":
            this._closeTrees(contextRoots);
            break;
          case "context_closeDescendants":
            this._closeTrees(contextRoots, { descendantsOnly: true });
            break;
          case "context_bookmarkTree":
            this._bookmarkTree(contextRoots);
            break;
          case "context_copyTreeLinks":
            this._copyTreeAsLinks(contextRoots);
            break;
          case "context_copyDescendantsLinks":
            this._copyTreeAsLinks(contextRoots, { descendantsOnly: true });
            break;
          case "context_collapseAll":
            treeService.collapseAll(window);
            for (const tab of window.gBrowser.tabs) {
              this._setManuallyExpanded(tab, false);
            }
            break;
          case "context_expandAll":
            treeService.expandAll(window);
            for (const tab of window.gBrowser.tabs) {
              this._setManuallyExpanded(tab, true);
            }
            break;
          default:
            break;
        }
      });
    },

    async _bookmarkTree(contextRoots) {
      const roots = Array.isArray(contextRoots)
        ? contextRoots
        : [this._getLogicalTreeTab(contextRoots)];
      const tabs = roots.flatMap(root => {
        const tree = [root, ...lazy.TreeTabsService.getDescendants(root)];
        return lazy.TreeTabsGroups.isGroupTab(root) && tree.length > 1
          ? tree.slice(1)
          : tree;
      });
      const items = lazy.TreeTabsBookmarks.encodeTabs(tabs);
      if (!items.length) {
        return;
      }
      const URIList = items.map(item => ({
        title: item.title,
        uri: Services.io.createExposableURI(Services.io.newURI(item.url)),
      }));
      await lazy.PlacesUIUtils.showBookmarkPagesDialog(URIList, [], window);
    },

    // The whole tree as an indented link list: plain text gets a bullet
    // outline of URLs, HTML a nested list of titled links, like TST's
    // "Copy this Tree as Links". Collapsed descendants are included, and
    // both panes of a split view pair are emitted for their tree row.
    _copyTreeAsLinks(contextRoots, { descendantsOnly = false } = {}) {
      const service = lazy.TreeTabsService;
      contextRoots = Array.isArray(contextRoots)
        ? contextRoots
        : [this._getLogicalTreeTab(contextRoots)];
      const roots = descendantsOnly
        ? contextRoots.flatMap(tab => service.getChildren(tab))
        : contextRoots;
      if (!roots.length) {
        return;
      }

      const escapeForHTML = text =>
        String(text).replace(
          /[&<>"']/g,
          ch =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[ch]
        );

      const buildItem = itemTab => {
        const paneTabs = itemTab.splitview?.tabs?.length
          ? itemTab.splitview.tabs
          : [itemTab];
        const plainLines = [];
        const richLinks = [];
        for (const paneTab of paneTabs) {
          const url = paneTab.linkedBrowser?.currentURI?.spec || "";
          plainLines.push(`* ${url}`);
          richLinks.push(
            `<a href="${escapeForHTML(url)}">${escapeForHTML(paneTab.label)}</a>`
          );
        }
        let plain = plainLines.join("\n");
        let rich = `<li>${richLinks.join("</li>\n<li>")}`;
        const children = service.getChildren(itemTab).map(buildItem);
        if (children.length) {
          plain +=
            "\n" +
            children.map(child => child.plain.replace(/^/gm, "  ")).join("\n");
          rich += `\n<ul>\n${children.map(child => child.rich).join("\n")}\n</ul>`;
        }
        rich += "</li>";
        return { plain, rich };
      };

      const items = roots.map(buildItem);
      const plainText = items.map(item => item.plain).join("\n");
      const richText = `<ul>\n${items.map(item => item.rich).join("\n")}\n</ul>`;

      const transferable = Cc[
        "@mozilla.org/widget/transferable;1"
      ].createInstance(Ci.nsITransferable);
      transferable.init(window.docShell.QueryInterface(Ci.nsILoadContext));
      for (const [flavor, data] of [
        ["text/html", richText],
        ["text/plain", plainText],
      ]) {
        const supportsString = Cc[
          "@mozilla.org/supports-string;1"
        ].createInstance(Ci.nsISupportsString);
        supportsString.data = data;
        transferable.addDataFlavor(flavor);
        transferable.setTransferData(flavor, supportsString);
      }
      Services.clipboard.setData(
        transferable,
        null,
        Services.clipboard.kGlobalClipboard
      );
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
