/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const _gTreePane = {
  init() {
    window.Preferences.addAll(this.preferences);
  },

  get preferences() {
    return [
      { id: "browser.sidebar.faviconizePinnedTabs", type: "bool" },
      { id: "browser.sidebar.stickyActiveTab", type: "bool" },
      { id: "browser.sidebar.stickySoundPlayingTab", type: "bool" },
      { id: "browser.sidebar.stickySharingTab", type: "bool" },
      { id: "browser.sidebar.autoCollapseExpandSubtreeOnAttach", type: "bool" },
      { id: "browser.sidebar.autoCollapseExpandSubtreeOnSelect", type: "bool" },
      { id: "browser.sidebar.treeDoubleClickBehavior", type: "unichar" },
      { id: "browser.sidebar.successorTabControlLevel", type: "unichar" },
      { id: "browser.sidebar.dropLinksOnTabBehavior", type: "unichar" },
      { id: "browser.sidebar.autoAttachOnOpenedWithOwner", type: "unichar" },
      { id: "browser.sidebar.insertNewTabFromPinnedTabAt", type: "unichar" },
      { id: "browser.sidebar.autoAttachOnNewTabCommand", type: "unichar" },
      { id: "browser.sidebar.autoAttachOnNewTabButtonMiddleClick", type: "unichar" },
      { id: "browser.sidebar.autoAttachOnDuplicated", type: "unichar" },
      { id: "browser.sidebar.autoAttachSameSiteOrphan", type: "unichar" },
      { id: "browser.sidebar.autoAttachOnOpenedFromExternal", type: "unichar" },
      { id: "browser.sidebar.autoAttachOnAnyOtherTrigger", type: "unichar" },
    ];
  },
};
