/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const BOOKMARK_TITLE_DESCENDANT_MATCHER = /^(>+) /;

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  TreeTabsGroups: "resource:///modules/TreeTabsGroups.sys.mjs",
  TreeTabsService: "resource:///modules/TreeTabsService.sys.mjs",
});

export const TreeTabsBookmarks = {
  parseStructure(items) {
    const ancestors = [];

    return items.map((item, index) => {
      const match = item.title.match(BOOKMARK_TITLE_DESCENDANT_MATCHER);
      if (index == 0 || !match) {
        ancestors.length = 0;
        ancestors.push(index);
        return { parent: null, title: item.title };
      }

      const level = Math.min(match[1].length, ancestors.length);
      ancestors.length = level;
      const parent = ancestors[level - 1];
      ancestors.push(index);
      return {
        parent,
        title: item.title.slice(match[0].length),
      };
    });
  },

  encodeTabs(tabs) {
    if (!tabs.length) {
      return [];
    }

    const levels = tabs.map(tab => lazy.TreeTabsService.getLevel(tab));
    const minLevel = Math.min(...levels);

    return tabs.map((tab, index) => {
      const level = levels[index] - minLevel;
      const rawTitle = tab.linkedBrowser.contentTitle || tab.label;
      const title = level
        ? `${">".repeat(level)} ${rawTitle}`
        : rawTitle.replace(BOOKMARK_TITLE_DESCENDANT_MATCHER, "");
      return {
        tab,
        title,
        url: tab.linkedBrowser.currentURI.spec,
      };
    });
  },

  applyStructure(window, tabs, items, { group = true, groupTitle } = {}) {
    if (tabs.length != items.length) {
      throw new Error("Tabs and structure items must have equal lengths");
    }

    for (let index = 0; index < items.length; index += 1) {
      const { parent } = items[index];
      if (
        parent !== null &&
        (!Number.isInteger(parent) || parent < 0 || parent >= index)
      ) {
        throw new Error(`Invalid parent index for item ${index}`);
      }
    }

    const rootTabs = [];
    const previousSiblings = new Map();
    for (let index = 0; index < tabs.length; index += 1) {
      const tab = tabs[index];
      const { parent } = items[index];
      if (parent === null) {
        lazy.TreeTabsService.detachTab(tab);
        rootTabs.push(tab);
        continue;
      }

      const options = { suppressAutoExpand: true };
      const previousSibling = previousSiblings.get(parent);
      if (previousSibling) {
        options.insertAfter = previousSibling;
      } else {
        options.index = 0;
      }
      lazy.TreeTabsService.attachTab(tab, tabs[parent], options);
      previousSiblings.set(parent, tab);
    }

    if (group && rootTabs.length > 1) {
      return (
        lazy.TreeTabsGroups.groupTabs(window, rootTabs, {
          temporary: true,
          automaticTitle: !groupTitle,
          title: groupTitle,
        }) || rootTabs[0]
      );
    }
    return rootTabs[0] || null;
  },
};
