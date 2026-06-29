/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const TABBAR_PREF = "browser.tabs.toolbarposition";
const BOOKMARKS_PREF = "browser.bookmarks.toolbarposition";
const VERTICAL_TABS_PREF = "sidebar.verticalTabs";

export const UICustomizations = {
  _initialized: false,
  _windows: new WeakSet(),

  init() {
    if (this._initialized) {
      return;
    }
    this._initialized = true;

    Services.prefs.addObserver(TABBAR_PREF, this);
    Services.prefs.addObserver(BOOKMARKS_PREF, this);
    Services.prefs.addObserver(VERTICAL_TABS_PREF, this);
  },

  get tabBarPosition() {
    // The tab strip lives in the sidebar while vertical tabs are on, so
    // the position pref only applies to the horizontal strip.
    if (Services.prefs.getBoolPref(VERTICAL_TABS_PREF, false)) {
      return "topabove";
    }
    return Services.prefs.getStringPref(TABBAR_PREF, "topabove");
  },

  get bookmarksPosition() {
    return Services.prefs.getStringPref(BOOKMARKS_PREF, "top");
  },

  onWindowOpened(win) {
    if (this._windows.has(win)) {
      return;
    }
    this._windows.add(win);

    this.moveTabBar(win);
    this.moveBookmarksBar(win);
    this.styleButtonBox(win);
    this.styleMenuBar(win);

    const menuBar = win.document.getElementById("toolbar-menubar");
    new win.MutationObserver(() => {
      this.styleButtonBox(win);
      this.styleMenuBar(win);
    }).observe(menuBar, { attributes: true, attributeFilter: ["autohide"] });

    win.addEventListener("sizemodechange", () => this.styleMenuBar(win));
  },

  observe(_subject, topic) {
    if (topic != "nsPref:changed") {
      return;
    }
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      if (!this._windows.has(win)) {
        continue;
      }
      this.moveTabBar(win);
      this.moveBookmarksBar(win);
      this.styleMenuBar(win);
    }
  },

  moveTabBar(win) {
    const doc = win.document;
    const tabsToolbar = doc.getElementById("TabsToolbar");
    const toolbox = doc.getElementById("navigator-toolbox");
    const menuBar = doc.getElementById("toolbar-menubar");
    const bottomBox = doc.getElementById("browser-bottombox");

    switch (this.tabBarPosition) {
      case "topbelow":
        if (
          tabsToolbar.parentNode != toolbox ||
          tabsToolbar.nextElementSibling
        ) {
          toolbox.appendChild(tabsToolbar);
        }
        break;
      case "bottomabove": {
        const bottomBookmarks = bottomBox.querySelector("#PersonalToolbar");
        if (bottomBookmarks) {
          bottomBookmarks.insertAdjacentElement("afterend", tabsToolbar);
        } else {
          bottomBox.insertAdjacentElement("afterbegin", tabsToolbar);
        }
        break;
      }
      case "bottombelow":
        bottomBox.appendChild(tabsToolbar);
        break;
      default:
        if (tabsToolbar.previousElementSibling != menuBar) {
          menuBar.insertAdjacentElement("afterend", tabsToolbar);
        }
        break;
    }

    const firstTab = doc.querySelector(".tabbrowser-tab");
    if (firstTab && win.gBrowser) {
      win.gBrowser.setTabTitle(firstTab);
    }
  },

  moveBookmarksBar(win) {
    const doc = win.document;
    const bookmarksBar = doc.getElementById("PersonalToolbar");
    const bottomBox = doc.getElementById("browser-bottombox");
    const position = this.bookmarksPosition;

    if (
      (position == "top" &&
        bookmarksBar.parentNode.id == "navigator-toolbox") ||
      (position == "bottom" &&
        bookmarksBar.parentNode.id == "browser-bottombox")
    ) {
      return;
    }

    if (position == "bottom") {
      const bottomTabs = bottomBox.querySelector("#TabsToolbar");
      if (bottomTabs) {
        bottomTabs.insertAdjacentElement("beforebegin", bookmarksBar);
      } else {
        bottomBox.insertAdjacentElement("afterbegin", bookmarksBar);
      }
    } else {
      doc
        .getElementById("nav-bar")
        .insertAdjacentElement("afterend", bookmarksBar);
    }
  },

  // The window buttons render in the menu bar row whenever the menu bar
  // is permanently shown; hide the copy that sits in the tab bar.
  styleButtonBox(win) {
    const doc = win.document;
    const menuBar = doc.getElementById("toolbar-menubar");
    const buttonBox = doc.querySelector(
      "#TabsToolbar .titlebar-buttonbox-container"
    );
    if (!buttonBox) {
      return;
    }
    buttonBox.style.display =
      menuBar.getAttribute("autohide") == "false" ? "none" : "";
  },

  // With the tab bar away from the top, a hidden menu bar row has no
  // height to host the window buttons when maximized on Windows.
  styleMenuBar(win) {
    const menuBar = win.document.getElementById("toolbar-menubar");
    if (
      this.tabBarPosition != "topabove" &&
      menuBar.getAttribute("autohide") == "true"
    ) {
      const maximized = win.windowState == win.STATE_MAXIMIZED;
      menuBar.style.appearance = "none";
      menuBar.style.paddingTop = maximized ? "6px" : "";
    } else {
      menuBar.style.appearance = "";
      menuBar.style.paddingTop = "";
    }
  },
};
