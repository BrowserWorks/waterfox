#filter dumbComments emptyLines

// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

// Native tree tabs, shown only while vertical tabs are on. Off by default;
// the master switch lives beside Mozilla's own sidebar.verticalTabs pref.
pref("browser.tabs.verticalTabs.tree.enabled", false);
pref("browser.tabs.verticalTabs.tree.migrated", false);

// How a freshly opened tab joins the tree: 0 always a root, 1 child of its
// opener, 2 sibling of the current tab.
pref("browser.tabs.verticalTabs.tree.autoAttach", 1);
pref("browser.tabs.verticalTabs.tree.autoCollapse.onSelect", false);
// Expand a collapsed parent when a tab is attached under it.
pref("browser.tabs.verticalTabs.tree.autoExpand.onAttach", true);

// What happens to children when their parent closes: 0 promote the first
// child, 1 promote them all, 2 close the whole subtree, 3 detach to roots,
// 4 replace the parent with a group tab.
// A collapsed parent always closes its whole subtree, and with 0 a parent
// closed as the last child promotes all of its children instead.
pref("browser.tabs.verticalTabs.tree.closeParentBehavior", 0);

pref("browser.tabs.verticalTabs.tree.sticky.activeTab", false);
pref("browser.tabs.verticalTabs.tree.propagateMutedState", true);

// Tree-aware pick of the next selected tab when the active tab closes.
pref("browser.tabs.verticalTabs.tree.successorControl", true);

// A link dropped onto a tab: 0 load in that tab, 1 ask, 2 open as child.
pref("browser.tabs.verticalTabs.tree.dropLinksOnTab", 1);
pref("browser.tabs.verticalTabs.tree.autoGroup.pinnedOpener", true);

// Deepest nesting level allowed, -1 for no limit.
pref("browser.tabs.verticalTabs.tree.maxDepth", -1);

// Double click on a tab: 0 collapse or expand, 1 close the tree, 2 nothing.
pref("browser.tabs.verticalTabs.tree.doubleClickBehavior", 0);

// Pixels of indent added per nesting level.
pref("browser.tabs.verticalTabs.tree.indentPx", 16);
