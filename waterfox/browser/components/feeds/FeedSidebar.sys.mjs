/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const VIEW_ID = "viewFeedsSidebar";
const CONFIG = {
  name: "feeds",
  elementId: "sidebar-switcher-feeds",
  url: "chrome://browser/content/feeds/sidebar.html",
  menuId: "menu_feedsSidebar",
  menuL10nId: "sidebar-menu-feeds-label",
  revampL10nId: "sidebar-menu-feeds-label",
  iconUrl: "chrome://browser/content/feeds/feed.svg",
  l10nResources: ["browser/waterfox/feeds.ftl"],
};

export const FeedSidebar = {
  toolNames: { [VIEW_ID]: CONFIG.name },

  register(win, controller) {
    const { document } = win;
    const sidebar = controller.makeSidebar(CONFIG, VIEW_ID);
    controller.sidebars.set(VIEW_ID, sidebar);
    for (const resource of CONFIG.l10nResources) {
      win.MozXULElement.insertFTLIfNeeded(resource);
    }

    if (!document.getElementById(CONFIG.elementId)) {
      const item = controller.createMenuItem(VIEW_ID, sidebar);
      item.id = CONFIG.elementId;
      item.removeAttribute("type");
      const popup = document.getElementById("sidebarMenu-popup");
      popup.insertBefore(item, popup.querySelector("menuseparator"));
    }
  },
};
