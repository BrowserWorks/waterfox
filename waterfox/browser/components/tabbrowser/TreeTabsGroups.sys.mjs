/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  SessionStore: "resource:///modules/sessionstore/SessionStore.sys.mjs",
  TreeTabsService: "resource:///modules/TreeTabsService.sys.mjs",
  TreeTabsStore: "resource:///modules/TreeTabsStore.sys.mjs",
});

ChromeUtils.defineLazyGetter(
  lazy,
  "l10n",
  () => new Localization(["browser/waterfox/tree-tabs.ftl"], true)
);

export const GROUP_TAB_URL =
  "chrome://browser/content/treegroup/group-tab.xhtml";

// Group tabs are lightweight named parents, the native counterpart of TST's
// group-tab.html. All their state lives in the URL query string.
export const TreeTabsGroups = {
  makeGroupTabURI({
    title,
    temporary,
    temporaryAggressive,
    openerGuid,
    aliasGuid,
    replacedParentCount,
  } = {}) {
    const params = new URLSearchParams();
    if (title) {
      params.set("title", title);
    }
    if (temporaryAggressive) {
      params.set("temporaryAggressive", "true");
    } else if (temporary) {
      params.set("temporary", "true");
    }
    if (openerGuid) {
      params.set("openerGuid", openerGuid);
    }
    if (aliasGuid) {
      params.set("aliasGuid", aliasGuid);
    }
    if (replacedParentCount) {
      params.set("replacedParentCount", String(replacedParentCount));
    }
    const query = params.toString();
    return query ? `${GROUP_TAB_URL}?${query}` : GROUP_TAB_URL;
  },

  _getLazyTabURL(tab) {
    try {
      const url = lazy.SessionStore.getLazyTabValue(tab, "url");
      if (url && url != "about:blank") {
        return url;
      }
      return lazy.SessionStore.getLazyTabValue(tab, "userTypedValue") || url;
    } catch {
      return undefined;
    }
  },

  getTabURL(tab) {
    const lazyURL = this._getLazyTabURL(tab);
    if (lazyURL) {
      return lazyURL;
    }
    return tab?.linkedBrowser?.currentURI?.spec || "";
  },

  isGroupTab(tab) {
    return this.getTabURL(tab).startsWith(GROUP_TAB_URL);
  },

  _getURLParams(tab) {
    const url = this.getTabURL(tab);
    if (!url.startsWith(GROUP_TAB_URL)) {
      return null;
    }
    const queryIndex = url.indexOf("?");
    return new URLSearchParams(queryIndex == -1 ? "" : url.slice(queryIndex));
  },

  // 0 permanent, 1 auto-close with no children left, 2 auto-close down to
  // its last child.
  getTemporaryState(tab) {
    const params = this._getURLParams(tab);
    if (!params) {
      return 0;
    }
    if (params.get("temporaryAggressive") == "true") {
      return 2;
    }
    if (params.get("temporary") == "true") {
      return 1;
    }
    return 0;
  },

  getReplacedParentCount(tab) {
    const params = this._getURLParams(tab);
    const count = params ? parseInt(params.get("replacedParentCount"), 10) : 0;
    return Number.isFinite(count) && count > 0 ? count : 0;
  },

  getOpenerGuid(tab) {
    return this._getURLParams(tab)?.get("openerGuid") || null;
  },

  getAliasGuid(tab) {
    return this._getURLParams(tab)?.get("aliasGuid") || null;
  },

  setAliasGuid(tab, aliasGuid) {
    return this.updateGroupTabURI(tab, { aliasGuid: aliasGuid || null });
  },

  findTabByGuid(window, guid) {
    if (!guid || !window?.gBrowser?.tabs) {
      return null;
    }
    for (const tab of window.gBrowser.tabs) {
      if (!tab.closing && lazy.TreeTabsStore.getTabGuid(tab) == guid) {
        return tab;
      }
    }
    return null;
  },

  findGroupTabForOpener(window, openerGuid) {
    if (!openerGuid || !window?.gBrowser?.tabs) {
      return null;
    }
    for (const tab of window.gBrowser.tabs) {
      if (
        !tab.closing &&
        !tab.pinned &&
        this.isGroupTab(tab) &&
        this.getOpenerGuid(tab) == openerGuid
      ) {
        return tab;
      }
    }
    return null;
  },

  // Wrap the given tabs' root tabs under a fresh group tab, inserted right
  // before the first of them and attached in its place in the tree.
  groupTabs(window, tabs, options = {}) {
    const service = lazy.TreeTabsService;
    if (!service.isActive(window)) {
      return null;
    }
    const gBrowser = window.gBrowser;
    const members = [...new Set(tabs)].filter(
      tab => tab && !tab.closing && !tab.pinned && tab.documentGlobal == window
    );
    const memberSet = new Set(members);
    const rootTabs = members.filter(
      tab => !memberSet.has(service.getParent(tab))
    );
    if (!rootTabs.length) {
      return null;
    }

    const title =
      options.title ??
      (options.automaticTitle
        ? null
        : lazy.l10n.formatValueSync("waterfox-tree-group-title-and-more", {
            title: rootTabs[0].label,
          }));
    const uri = this.makeGroupTabURI({
      title,
      temporary: options.temporary !== false,
      temporaryAggressive: options.temporaryAggressive === true,
      openerGuid: options.openerGuid,
      aliasGuid: options.aliasGuid,
      replacedParentCount: options.replacedParentCount,
    });

    const parent =
      options.parent !== undefined
        ? options.parent
        : service.getParent(rootTabs[0]);
    const rootIndex = service.getRootTabs(window).indexOf(rootTabs[0]);

    const nativeGroup = rootTabs.every(tab => tab.group == rootTabs[0].group)
      ? rootTabs[0].group
      : null;
    const groupTab = gBrowser.addTrustedTab(uri, {
      tabIndex: rootTabs[0]._tPos,
      tabGroup: nativeGroup,
      skipAnimation: true,
    });
    if (!groupTab) {
      return null;
    }

    if (parent && !parent.closing) {
      service.attachTab(groupTab, parent, {
        insertBefore: options.insertBefore,
        insertAfter: options.insertAfter,
        index: options.siblingIndex,
        suppressAutoExpand: true,
      });
    } else {
      service.detachTab(groupTab);
      if (rootIndex >= 0) {
        service.moveTabSubtree(groupTab, rootIndex);
      }
    }

    let previousRoot = null;
    for (const rootTab of rootTabs) {
      service.attachTab(
        rootTab,
        groupTab,
        previousRoot
          ? { insertAfter: previousRoot, suppressAutoExpand: true }
          : { index: 0, suppressAutoExpand: true }
      );
      previousRoot = rootTab;
    }

    return groupTab;
  },

  updateGroupTabURI(tab, changes = {}) {
    const lazyURL = this._getLazyTabURL(tab);
    const currentURL = lazyURL || this.getTabURL(tab);
    if (!currentURL.startsWith(GROUP_TAB_URL)) {
      return null;
    }

    const url = new URL(currentURL);
    for (const [name, value] of Object.entries(changes)) {
      if (value === null || value === undefined || value === false) {
        url.searchParams.delete(name);
      } else {
        url.searchParams.set(name, value === true ? "true" : String(value));
      }
    }

    const updatedURL = url.href;
    if (updatedURL == currentURL) {
      return updatedURL;
    }

    const browser = tab?.linkedBrowser;
    if (!browser) {
      return null;
    }
    browser.loadURI(Services.io.newURI(updatedURL), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    return updatedURL;
  },

  // Close needless temporary groups, deepest first: a passive one with
  // nothing left under it (or only another temporary group), and an
  // aggressive one down to its last child.
  cleanupNeedlessGroupTabs(window, tabs) {
    const service = lazy.TreeTabsService;
    if (
      !service.isActive(window) ||
      lazy.TreeTabsStore.isRestorePending(window)
    ) {
      return;
    }
    const toRemove = [];
    for (const tab of tabs.toSorted(
      (a, b) => service.getLevel(b) - service.getLevel(a)
    )) {
      if (!tab || tab.closing || tab.documentGlobal != window) {
        continue;
      }
      const temporaryState = this.getTemporaryState(tab);
      if (!temporaryState) {
        continue;
      }
      const children = service
        .getChildren(tab)
        .filter(child => !toRemove.includes(child));
      if (children.length > 1) {
        continue;
      }
      if (temporaryState == 1) {
        const child = children[0];
        if (
          child &&
          !(this.isGroupTab(child) && this.getTemporaryState(child))
        ) {
          continue;
        }
      }
      toRemove.push(tab);
    }
    for (const tab of toRemove) {
      if (!tab.closing) {
        service.removeGroupTab(tab);
      }
    }
  },

  // The permanent form of a group tab, so a deliberate promotion (say by
  // pinning) is not undone by the auto-cleanup.
  clearTemporaryState(tab) {
    if (!this.isGroupTab(tab)) {
      return null;
    }
    return this.updateGroupTabURI(tab, {
      temporary: null,
      temporaryAggressive: null,
    });
  },
};
