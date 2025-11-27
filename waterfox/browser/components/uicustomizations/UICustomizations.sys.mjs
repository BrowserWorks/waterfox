/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { BrowserUtils } from "resource:///modules/BrowserUtils.sys.mjs";
import { PrefUtils } from "resource:///modules/PrefUtils.sys.mjs";

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
      (value) => {
        UICustomizations.executeInAllWindows((window) => {
          const { document } = window;
          UICustomizations.moveTabBar(window, value);
          UICustomizations.styleMenuBar(document, window);
        });
      }
    );
    // Set Bookmark bar position
    this.bookmarkBarPositionListener = PrefUtils.addObserver(
      this.PREF_BOOKMARKPOS,
      (value) => {
        UICustomizations.executeInAllWindows((window) => {
          UICustomizations.moveBookmarksBar(window, value);
        });
      }
    );
  },

  initListeners(aWindow) {
      // Hide tabs toolbar buttonbox if menubar displayed
      if (aWindow.document) {
        const menuBar = aWindow.document.getElementById("toolbar-menubar");
        const observer = new aWindow.MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (
              mutation.type === "attributes" &&
              mutation.attributeName === "autohide"
            ) {
              UICustomizations.styleButtonBox(aWindow.document);
              UICustomizations.styleMenuBar(aWindow.document, aWindow);
            }
          }
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
        const menuBar = doc.getElementById("toolbar-menubar");
        const buttonBox = doc.querySelector(
          "#TabsToolbar .titlebar-buttonbox-container"
        );

        // If menuBar is not found, we cannot get its "autohide" attribute.
        if (!menuBar) {
          console.warn(
            "UICustomizations.sys.mjs: #toolbar-menubar element not found in styleButtonBox. Cannot determine button box visibility."
          );
          return;
        }

        // If buttonBox is not found, we cannot style it.
        if (!buttonBox) {
          console.warn(
            "UICustomizations.sys.mjs: #TabsToolbar .titlebar-buttonbox-container element not found in styleButtonBox. Cannot style button box."
          );
          return;
        }

        if (menuBar.getAttribute("autohide") === "false") {
          buttonBox.style.display = "none";
        } else {
          buttonBox.style.display = "-moz-box";
        }
      },

  styleMenuBar(doc, win) {
    const menuBar = doc.getElementById("toolbar-menubar");
    // If menuBar (toolbar-menubar) doesn't exist, we can't proceed with its styling.
    if (!menuBar) {
      console.warn(
        "UICustomizations.sys.mjs: toolbar-menubar element not found. Cannot apply custom menubar styling."
      );
      return;
    }

    // The original code used a 'titleBar' element which has been removed in recent changes.
    // We will now apply the conditional styling directly to the 'menuBar' element itself.

    const fullscreen = win.windowState === win.STATE_MAXIMIZED;
    if (
      PrefUtils.get(this.PREF_TOOLBARPOS) !== "topabove" &&
      menuBar.getAttribute("autohide") === "true"
    ) {
      if (fullscreen) {
        menuBar.setAttribute("style", "appearance: none; padding-top: 6px;");
      } else {
        menuBar.setAttribute("style", "appearance: none;");
      }
    } else {
      // If conditions are not met, clear any inline style from menuBar.
      menuBar.setAttribute("style", "");
    }
  },

  moveTabBar(aWindow, aValue) {
      const doc = aWindow.document; // Use a shorthand for document

      // Get elements used in various cases, check them early if crucial.
      const tabsToolbar = doc.querySelector("#TabsToolbar");
      if (!tabsToolbar) {
        console.warn(
          "UICustomizations.sys.mjs: #TabsToolbar not found. Cannot move tab bar."
        );
        return;
      }

      const navigatorToolbox = doc.querySelector("#navigator-toolbox");
      const bottomBox = doc.querySelector("#browser-bottombox");
      // bottomBookmarksBar is queried specifically in the 'bottomabove' case.

      let effectiveValue = aValue;
      if (!effectiveValue) {
        effectiveValue = PrefUtils.get(this.PREF_TOOLBARPOS);
      }

      switch (effectiveValue) {
        case "topabove": {
          // Original logic used 'titlebar'. #titlebar is removed.
          // #titlebar used to contain #toolbar-menubar then #TabsToolbar.
          // So, "beforeend" of #titlebar meant #TabsToolbar came after #toolbar-menubar.
          const menuBar = doc.querySelector("#toolbar-menubar");
          // Ensure menuBar exists and is a child of navigatorToolbox for sensible placement.
          if (menuBar && menuBar.parentElement === navigatorToolbox) {
            menuBar.insertAdjacentElement("afterend", tabsToolbar);
          } else if (navigatorToolbox) {
            // Fallback: if menubar isn't suitable/found, place tabs at the start of navigator-toolbox.
            navigatorToolbox.insertAdjacentElement("afterbegin", tabsToolbar);
          } else {
            console.warn(
              "UICustomizations.sys.mjs: Could not place TabsToolbar 'topabove'. #navigator-toolbox or #toolbar-menubar not suitable."
            );
          }
          break;
        }
        case "topbelow":
          if (navigatorToolbox) {
            navigatorToolbox.appendChild(tabsToolbar);
          } else {
            console.warn(
              "UICustomizations.sys.mjs: #navigator-toolbox not found. Cannot move tab bar to 'topbelow'."
            );
          }
          break;
        case "bottomabove": {
          // Above status bar
          if (!bottomBox) {
            console.warn(
              "UICustomizations.sys.mjs: #browser-bottombox not found for 'bottomabove'."
            );
            break;
          }
          bottomBox.collapsed = false;
          const bottomBookmarksBar = doc.querySelector(
            "#browser-bottombox #PersonalToolbar"
          );
          if (bottomBookmarksBar) {
            bottomBookmarksBar.insertAdjacentElement("afterend", tabsToolbar);
          } else {
            bottomBox.insertAdjacentElement("afterbegin", tabsToolbar);
          }
          break;
        }
        case "bottombelow":
          // Below status bar
          if (!bottomBox) {
            console.warn(
              "UICustomizations.sys.mjs: #browser-bottombox not found for 'bottombelow'."
            );
            break;
          }
          bottomBox.collapsed = false;
          bottomBox.insertAdjacentElement("beforeend", tabsToolbar);
          break;
      }

      // This call was common to all cases, so move it after the switch.
      // Also, ensure the first tab exists before trying to set its title.
      const firstTab = doc.querySelector(".tabbrowser-tab:first-child");
      if (firstTab && aWindow.gBrowser) {
        aWindow.gBrowser.setTabTitle(firstTab);
      }

      // Set title on top bar when title bar is disabled and tab bar position is different than default
      const topBar = doc.querySelector("#toolbar-menubar-pagetitle");
      const activeTab = doc.querySelector('tab[selected="true"]');
      if (topBar && activeTab) {
        topBar.textContent = activeTab.getAttribute("label");
      }
    },

    moveBookmarksBar(aWindow, aValue) {
            const doc = aWindow.document;
            const bottomTabs = doc.querySelector("#browser-bottombox #TabsToolbar");
            const bookmarksBar = doc.querySelector("#PersonalToolbar");

            let effectiveValue = aValue;
            if (!effectiveValue) {
              effectiveValue = PrefUtils.get(this.PREF_BOOKMARKPOS, "top");
            }
            // Don't move if already in correct position
            // Note: The original code has a potential null pointer issue here if bookmarksBar is null
            // and bookmarksBar.parentElement is accessed. This change only addresses the
            // "parameter reassignment" diagnostic and does not alter that specific behavior.
            if (
              bookmarksBar?.parentElement && // Added a guard for parentElement before accessing its id
              ((effectiveValue === "top" &&
                bookmarksBar.parentElement.id === "navigator-toolbox") ||
              (effectiveValue === "bottom" &&
                bookmarksBar.parentElement.id === "browser-bottombox"))
            ) {
              return;
            }

            switch (effectiveValue) {
              case "top": {
                const navBar = doc.querySelector("#nav-bar");
                if (navBar && bookmarksBar) {
                  navBar.insertAdjacentElement("afterend", bookmarksBar);
                } else {
                  if (!bookmarksBar) {
                    console.warn(
                      "UICustomizations.sys.mjs: #PersonalToolbar not found. Cannot move bookmarks bar."
                    );
                  }
                  // Ensure this warning is only logged if navBar is indeed the missing element,
                  // and not because bookmarksBar was also missing (though the above handles that).
                  if (!navBar && bookmarksBar) {
                    console.warn(
                      "UICustomizations.sys.mjs: #nav-bar not found. Cannot move bookmarks bar to top."
                    );
                  }
                }
                break;
              }
              case "bottom":
                if (!bookmarksBar) {
                  console.warn(
                    "UICustomizations.sys.mjs: #PersonalToolbar not found. Cannot move bookmarks bar."
                  );
                  break;
                }
                if (bottomTabs) {
                  bottomTabs.insertAdjacentElement("beforebegin", bookmarksBar);
                } else {
                  const bottomBox = doc.querySelector("#browser-bottombox");
                  if (bottomBox) {
                    bottomBox.insertAdjacentElement("afterbegin", bookmarksBar);
                  } else {
                    console.warn(
                      "UICustomizations.sys.mjs: #browser-bottombox not found. Cannot move bookmarks bar to bottom."
                    );
                  }
                }
                break;
            }
          },
};

// Inherited props
UICustomizations.executeInAllWindows = BrowserUtils.executeInAllWindows;
