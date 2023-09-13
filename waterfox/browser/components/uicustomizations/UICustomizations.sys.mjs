/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* global */

import { PrefUtils } from "resource:///modules/PrefUtils.sys.mjs";

import { BrowserUtils } from "resource:///modules/BrowserUtils.sys.mjs";

export const UICustomizations = {
  PREF_TOOLBARPOS: "browser.tabs.toolbarposition",
  PREF_BOOKMARKPOS: "browser.bookmarks.toolbarposition",

  init(window) {
    this.styleButtonBox(window.document);
    this.styleMenuBar(window.document, window);
    this.moveTabBar(window);
    this.moveBookmarksBar(window);
    this.initListeners(window);
    this.initPrefObservers();
  },

  initPrefObservers() {
    // Set Tab toolbar position
    this.toolbarPositionListener = PrefUtils.addObserver(
      this.PREF_TOOLBARPOS,
      value => {
        UICustomizations.executeInAllWindows(window => {
          const { document } = window;
          UICustomizations.moveTabBar(window, value);
          UICustomizations.styleMenuBar(document, window);
        });
      }
    );
    // Set Bookmark bar position
    this.bookmarkBarPositionListener = PrefUtils.addObserver(
      this.PREF_BOOKMARKPOS,
      value => {
        UICustomizations.executeInAllWindows(window => {
          UICustomizations.moveBookmarksBar(window, value);
        });
      }
    );

  },

  initListeners(aWindow) {
    // Hide tabs toolbar buttonbox if menubar displayed
    if (aWindow.document) {
      let menuBar = aWindow.document.getElementById("toolbar-menubar");
      var observer = new aWindow.MutationObserver(mutations => {
        mutations.forEach(mutation => {
          if (
            mutation.type === "attributes" &&
            mutation.attributeName == "autohide"
          ) {
            UICustomizations.styleButtonBox(aWindow.document);
            UICustomizations.styleMenuBar(aWindow.document, aWindow);
          }
        });
      });

      observer.observe(menuBar, {
        attributes: true, //configure it to listen to attribute changes
      });
    }
    // Ensure menu bar/ nav bar not cut off when maximized in Windows
    aWindow.addEventListener(
      "sizemodechange",
      function updateTitleBarStyling() {
        UICustomizations.styleMenuBar(aWindow.document, aWindow);
      }
    );
  },

  styleButtonBox(doc) {
    let menuBar = doc.getElementById("toolbar-menubar");
    let buttonBox = doc.querySelector(
      "#TabsToolbar .titlebar-buttonbox-container"
    );
    menuBar.getAttribute("autohide") == "false"
      ? (buttonBox.style.display = "none")
      : (buttonBox.style.display = "-moz-box");
  },

  styleMenuBar(doc, win) {
    let menuBar = doc.getElementById("toolbar-menubar");
    let titleBar = doc.getElementById("titlebar");
    // Appearance should be none if windowed and menu-bar not displaying,
    // should be none with padding-top: 6px if fullscreen and menu-bar not displaying,
    // else should be ""
    let fullscreen = win.windowState == win.STATE_MAXIMIZED;
    if (
      PrefUtils.get(this.PREF_TOOLBARPOS) != "topabove" &&
      menuBar.getAttribute("autohide") == "true"
    ) {
      if (fullscreen) {
        titleBar.setAttribute("style", "appearance: none; padding-top: 6px;");
      } else {
        titleBar.setAttribute("style", "appearance: none;");
      }
    } else {
      titleBar.setAttribute("style", "");
    }
  },

  moveTabBar(aWindow, aValue) {
    let bottomBookmarksBar = aWindow.document.querySelector(
      "#browser-bottombox #PersonalToolbar"
    );
    let bottomBox = aWindow.document.querySelector("#browser-bottombox");
    let tabsToolbar = aWindow.document.querySelector("#TabsToolbar");
    let titlebar = aWindow.document.querySelector("#titlebar");

    if (!aValue) {
      aValue = PrefUtils.get(this.PREF_TOOLBARPOS);
    }
    switch (aValue) {
      case "topabove":
        titlebar.insertAdjacentElement("beforeend", tabsToolbar);
        aWindow.gBrowser.setTabTitle(
          aWindow.document.querySelector(".tabbrowser-tab:first-child")
        );
        break;
      case "topbelow":
        aWindow.document
          .querySelector("#navigator-toolbox")
          .appendChild(tabsToolbar);
        aWindow.gBrowser.setTabTitle(
          aWindow.document.querySelector(".tabbrowser-tab:first-child")
        );
        break;
      case "bottomabove":
        // Above status bar
        bottomBox.collapsed = false;
        if (bottomBookmarksBar) {
          bottomBookmarksBar.insertAdjacentElement("afterend", tabsToolbar);
        } else {
          bottomBox.insertAdjacentElement("afterbegin", tabsToolbar);
        }
        aWindow.gBrowser.setTabTitle(
          aWindow.document.querySelector(".tabbrowser-tab:first-child")
        );
        break;
      case "bottombelow":
        // Below status bar
        bottomBox.collapsed = false;
        bottomBox.insertAdjacentElement("beforeend", tabsToolbar);
        aWindow.gBrowser.setTabTitle(
          aWindow.document.querySelector(".tabbrowser-tab:first-child")
        );
        break;
    }

    // Set title on top bar when title bar is disabled and tab bar position is different than default
    const topBar = aWindow.document.querySelector("#toolbar-menubar-pagetitle");
    const activeTab = aWindow.document.querySelector('tab[selected="true"]');
    if (topBar && activeTab) {
      topBar.textContent = activeTab.getAttribute("label");
    }
  },

  moveBookmarksBar(aWindow, aValue) {
    let bottomTabs = aWindow.document.querySelector(
      "#browser-bottombox #TabsToolbar"
    );
    let bookmarksBar = aWindow.document.querySelector("#PersonalToolbar");

    if (!aValue) {
      aValue = PrefUtils.get(this.PREF_BOOKMARKPOS, "top");
    }
    // Don't move if already in correct position
    if (
      (aValue == "top" &&
        bookmarksBar.parentElement.id == "navigator-toolbox") ||
      (aValue == "bottom" &&
        bookmarksBar.parentElement.id == "browser-bottombox")
    ) {
      return;
    }

    switch (aValue) {
      case "top":
        aWindow.document
          .querySelector("#nav-bar")
          .insertAdjacentElement("afterend", bookmarksBar);
        break;
      case "bottom":
        if (bottomTabs) {
          bottomTabs.insertAdjacentElement("beforebegin", bookmarksBar);
        } else {
          aWindow.document
            .querySelector("#browser-bottombox")
            .insertAdjacentElement("afterbegin", bookmarksBar);
        }
        break;
    }
  },
};

// Inherited props
UICustomizations.executeInAllWindows = BrowserUtils.executeInAllWindows;
