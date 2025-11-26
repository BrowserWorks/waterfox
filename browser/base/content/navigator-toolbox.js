/* -*- indent-tabs-mode: nil; js-indent-level: 2 -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* eslint-env mozilla/browser-window */

document.addEventListener(
  "DOMContentLoaded",
  () => {
    const navigatorToolbox = document.getElementById("navigator-toolbox");
    const widgetOverflow = document.getElementById("widget-overflow");
    const browserBottombox = document.getElementById("browser-bottombox");

    function onPopupShowing(event) {
      switch (event.target.id) {
        case "PlacesChevronPopup":
          document
            .getElementById("PlacesToolbar")
            ._placesView._onChevronPopupShowing(event);
          break;

        case "BMB_bookmarksPopup":
          BookmarkingUI.onPopupShowing(event);
        // fall-through
        case "BMB_bookmarksToolbarPopup":
        case "BMB_unsortedBookmarksPopup":
        case "BMB_mobileBookmarksPopup":
          if (!event.target.parentNode._placesView) {
            let placeMap = {
              BMB_bookmarksPopup: PlacesUtils.bookmarks.menuGuid,
              BMB_bookmarksToolbarPopup: PlacesUtils.bookmarks.toolbarGuid,
              BMB_unsortedBookmarksPopup: PlacesUtils.bookmarks.unfiledGuid,
              BMB_mobileBookmarksPopup: PlacesUtils.bookmarks.mobileGuid,
            };
            new PlacesMenu(event, `place:parent=${placeMap[event.target.id]}`);
          }
          break;
      }
    }
    navigatorToolbox.addEventListener("popupshowing", onPopupShowing);
    widgetOverflow.addEventListener("popupshowing", onPopupShowing);
    browserBottombox.addEventListener("popupshowing", onPopupShowing);

    function onCommand(event) {
      let element = event.target.closest(`
        #firefox-view-button,
        .content-analysis-indicator,
        #bookmarks-toolbar-button,
        #PlacesToolbar,
        #import-button,
        #bookmarks-menu-button,
        #BMB_bookmarksPopup,
        #BMB_viewBookmarksSidebar,
        #BMB_searchBookmarks,
        #BMB_viewBookmarksToolbar`);
      if (!element) {
        return;
      }

      switch (element.id) {
        case "firefox-view-button":
          FirefoxViewHandler.openTab();
          break;

        case "bookmarks-toolbar-button":
          PlacesToolbarHelper.onPlaceholderCommand();
          break;

        case "PlacesToolbar":
        case "BMB_bookmarksPopup":
          BookmarksEventHandler.onCommand(event);
          break;

        case "import-button":
          MigrationUtils.showMigrationWizard(window, {
            entrypoint: MigrationUtils.MIGRATION_ENTRYPOINTS.BOOKMARKS_TOOLBAR,
          });
          break;

        case "bookmarks-menu-button":
          BookmarkingUI.onCommand(event);
          break;

        case "BMB_viewBookmarksSidebar":
          SidebarController.toggle("viewBookmarksSidebar");
          break;

        case "BMB_searchBookmarks":
          PlacesCommandHook.searchBookmarks();
          break;

        case "BMB_viewBookmarksToolbar":
          BookmarkingUI.toggleBookmarksToolbar("bookmarks-widget");
          break;

        default:
          if (element.classList.contains("content-analysis-indicator")) {
            ContentAnalysis.showPanel(element, PanelUI);
          } else {
            throw new Error(`Missing case for #${element.id}`);
          }
      }
    }
    navigatorToolbox.addEventListener("command", onCommand);
    widgetOverflow.addEventListener("command", onCommand);
    browserBottombox.addEventListener("command", onCommand);

    function onMouseDown(event) {
      let element = event.target.closest(`
        #firefox-view-button,
        #alltabs-button,
        #pageActionButton,
        #downloads-button,
        #fxa-toolbar-menu-button,
        #unified-extensions-button,
        #library-button
        `);
      if (!element) {
        return;
      }

      switch (element.id) {
        case "firefox-view-button":
          FirefoxViewHandler.openToolbarMouseEvent(event);
          break;

        case "alltabs-button":
          gTabsPanel.showAllTabsPanel(event, "alltabs-button");
          break;

        case "pageActionButton":
          BrowserPageActions.mainButtonClicked(event);
          break;

        case "downloads-button":
          DownloadsIndicatorView.onCommand(event);
          break;

        case "fxa-toolbar-menu-button":
          gSync.toggleAccountPanel(element, event);
          break;

        case "unified-extensions-button":
          gUnifiedExtensions.togglePanel(event);
          break;

        case "library-button":
          PanelUI.showSubView("appMenu-libraryView", element, event);
          break;

        default:
          throw new Error(`Missing case for #${element.id}`);
      }
    }
    navigatorToolbox.addEventListener("mousedown", onMouseDown);
    widgetOverflow.addEventListener("mousedown", onMouseDown);
    browserBottombox.addEventListener("mousedown", onMouseDown);

    function onMouseUp(event) {
      let element = event.target.closest(`
        #PlacesToolbar,
        #BMB_bookmarksPopup
        `);
      if (!element) {
        return;
      }

      switch (element.id) {
        case "PlacesToolbar":
        case "BMB_bookmarksPopup":
          BookmarksEventHandler.onMouseUp(event);
          break;

        default:
          throw new Error(`Missing case for #${element.id}`);
      }
    }
    navigatorToolbox.addEventListener("mouseup", onMouseUp);
    widgetOverflow.addEventListener("mouseup", onMouseUp);
    browserBottombox.addEventListener("mouseup", onMouseUp);

    function onClick(event) {
      const isLeftClick = event.button === 0;

      let element = event.target.closest(`
        #vertical-tabs-newtab-button,
        #tabs-newtab-button,
        #new-tab-button,
        #back-button,
        #forward-button,
        #reload-button ,
        #urlbar-go-button,
        #reader-mode-button,
        #picture-in-picture-button,
        #urlbar-zoom-button,
        #star-button-box,
        #personal-toolbar-empty-description,
        #home-button,
        #PlacesToolbar,
        #BMB_bookmarksPopup,
        #tracking-protection-icon-container,
        #identity-icon-box,
        #identity-permission-box,
        #translations-button,
        #taskbar-tabs-button
        `);
      if (!element) {
        return;
      }

      switch (element.id) {
        case "vertical-tabs-newtab-button":
        case "tabs-newtab-button":
        case "new-tab-button":
          gBrowser.handleNewTabMiddleClick(element, event);
          break;

        case "back-button":
        case "forward-button":
        case "reload-button":
          checkForMiddleClick(element, event);
          break;

        case "urlbar-go-button":
          gURLBar.handleCommand(event);
          break;

        case "reader-mode-button":
          if (isLeftClick) {
            AboutReaderParent.toggleReaderMode(event);
          }
          break;

        case "picture-in-picture-button":
          if (isLeftClick) {
            PictureInPicture.toggleUrlbar(event);
          }
          break;

        case "urlbar-zoom-button":
          if (isLeftClick) {
            FullZoom.resetFromURLBar();
          }
          break;

        case "star-button-box":
          BrowserPageActions.doCommandForAction(
            PageActions.actionForID("bookmark"),
            event,
            element
          );
          break;

        case "personal-toolbar-empty-description":
          if (isLeftClick && event.target.localName == "a") {
            PlacesCommandHook.showPlacesOrganizer("BookmarksToolbar");
          }
          break;

        case "home-button":
          BrowserCommands.home(event);
          break;

        case "PlacesToolbar":
          BookmarksEventHandler.onClick(event, element._placesView);
          break;

        case "BMB_bookmarksPopup":
          BookmarksEventHandler.onClick(event, element.parentNode._placesView);
          break;

        case "tracking-protection-icon-container":
          gProtectionsHandler.handleProtectionsButtonEvent(event);
          break;

        case "identity-icon-box":
          gIdentityHandler.handleIdentityButtonEvent(event);
          PageProxyClickHandler(event);
          break;

        case "identity-permission-box":
          gPermissionPanel.handleIdentityButtonEvent(event);
          PageProxyClickHandler(event);
          break;

        case "translations-button":
          FullPageTranslationsPanel.open(event);
          break;

        default:
          throw new Error(`Missing case for #${element.id}`);
      }
    }
    navigatorToolbox.addEventListener("click", onClick);
    widgetOverflow.addEventListener("click", onClick);
    browserBottombox.addEventListener("click", onClick);
    document.getElementById("sidebar-main").addEventListener("click", onClick);

    function onKeyPress(event) {
      const isLikeLeftClick = event.key === "Enter" || event.key === " ";

      let element = event.target.closest(`
        #reader-mode-button,
        #picture-in-picture-button,
        #urlbar-zoom-button,
        #star-button-box,
        #personal-toolbar-empty-description,
        #home-button,
        #tracking-protection-icon-container,
        #identity-icon-box,
        #identity-permission-box,
        #translations-button,
        #alltabs-button,
        #pageActionButton,
        #downloads-button,
        #fxa-toolbar-menu-button,
        #unified-extensions-button,
        #library-button
      `);
      if (!element) {
        return;
      }

      switch (element.id) {
        case "reader-mode-button":
          if (isLikeLeftClick) {
            AboutReaderParent.toggleReaderMode(event);
          }
          break;

        case "picture-in-picture-button":
          if (isLikeLeftClick) {
            PictureInPicture.toggleUrlbar(event);
          }
          break;

        case "urlbar-zoom-button":
          if (isLikeLeftClick) {
            FullZoom.resetFromURLBar();
          }
          break;

        case "star-button-box":
          // This already handles checking for enter and space.
          BrowserPageActions.doCommandForAction(
            PageActions.actionForID("bookmark"),
            event,
            element
          );
          break;

        case "personal-toolbar-empty-description":
          if (isLikeLeftClick && event.target.localName == "a") {
            PlacesCommandHook.showPlacesOrganizer("BookmarksToolbar");
          }
          break;

        case "home-button":
          if (isLikeLeftClick) {
            BrowserCommands.home(event);
          }
          break;

        case "tracking-protection-icon-container":
          gProtectionsHandler.handleProtectionsButtonEvent(event);
          break;

        case "identity-icon-box":
          gIdentityHandler.handleIdentityButtonEvent(event);
          break;

        case "identity-permission-box":
          gPermissionPanel.handleIdentityButtonEvent(event);
          break;

        case "translations-button":
          FullPageTranslationsPanel.open(event);
          break;

        case "alltabs-button":
          gTabsPanel.showAllTabsPanel(event, "alltabs-button");
          break;

        case "pageActionButton":
          BrowserPageActions.mainButtonClicked(event);
          break;

        case "downloads-button":
          DownloadsIndicatorView.onCommand(event);
          break;

        case "fxa-toolbar-menu-button":
          gSync.toggleAccountPanel(element, event);
          break;

        case "unified-extensions-button":
          gUnifiedExtensions.togglePanel(event);
          break;

        case "library-button":
          PanelUI.showSubView("appMenu-libraryView", element, event);
          break;

        default:
          throw new Error(`Missing case for #${element.id}`);
      }
    }
    // Make sure this preempts browser-toolbarKeyNav.js.
    navigatorToolbox.addEventListener("keypress", onKeyPress, {
      capture: true,
    });
    widgetOverflow.addEventListener("keypress", onKeyPress, { capture: true });
    browserBottombox.addEventListener("keypress", onKeyPress, {
      capture: true,
    });

    function onDragAndDrop(event) {
      let element = event.target.closest(`
        #new-tab-button,
        #downloads-button,
        #new-window-button,
        #bookmarks-menu-button,
        #home-button
      `);
      if (!element) {
        return;
      }

      switch (element.id) {
        case "new-tab-button":
          if (event.type === "dragenter" || event.type === "dragover") {
            ToolbarDropHandler.onDragOver(event);
          } else if (event.type === "drop") {
            ToolbarDropHandler.onDropNewTabButtonObserver(event);
          }
          break;

        case "downloads-button":
          if (event.type === "dragenter" || event.type === "dragover") {
            DownloadsIndicatorView.onDragOver(event);
          } else if (event.type === "drop") {
            DownloadsIndicatorView.onDrop(event);
          }
          break;

        case "new-window-button":
          if (event.type === "dragenter" || event.type === "dragover") {
            ToolbarDropHandler.onDragOver(event);
          } else if (event.type === "drop") {
            ToolbarDropHandler.onDropNewWindowButtonObserver(event);
          }
          break;

        case "bookmarks-menu-button":
          switch (event.type) {
            case "dragenter":
              PlacesMenuDNDHandler.onDragEnter(event);
              break;
            case "dragover":
              PlacesMenuDNDHandler.onDragOver(event);
              break;
            case "dragleave":
              PlacesMenuDNDHandler.onDragLeave(event);
              break;
            case "drop":
              PlacesMenuDNDHandler.onDrop(event);
              break;
          }
          break;

        case "home-button":
          if (event.type === "dragenter" || event.type === "dragover") {
            if (HomePage.locked) {
              return;
            }
            ToolbarDropHandler.onDragOver(event);
            event.dropEffect = "link";
          } else if (event.type == "drop") {
            ToolbarDropHandler.onDropHomeButtonObserver(event);
          }
          break;

        default:
          throw new Error(`Missing case for #${element.id}`);
      }
    }

    navigatorToolbox.addEventListener("dragenter", onDragAndDrop);
    widgetOverflow.addEventListener("dragenter", onDragAndDrop);
    browserBottombox.addEventListener("dragenter", onDragAndDrop);
    navigatorToolbox.addEventListener("dragover", onDragAndDrop);
    widgetOverflow.addEventListener("dragover", onDragAndDrop);
    browserBottombox.addEventListener("dragover", onDragAndDrop);
    navigatorToolbox.addEventListener("dragleave", onDragAndDrop);
    widgetOverflow.addEventListener("dragleave", onDragAndDrop);
    browserBottombox.addEventListener("dragleave", onDragAndDrop);
    navigatorToolbox.addEventListener("drop", onDragAndDrop);
    widgetOverflow.addEventListener("drop", onDragAndDrop);
    browserBottombox.addEventListener("drop", onDragAndDrop);

    document
      .getElementById("identity-box")
      .addEventListener("dragstart", event => {
        gIdentityHandler.onDragStart(event);
      });

    let trackingProtectionIconContainer = document.getElementById(
      "tracking-protection-icon-container"
    );
    trackingProtectionIconContainer.addEventListener("focus", () => {
      gProtectionsHandler.onTrackingProtectionIconHoveredOrFocused();
    });
    trackingProtectionIconContainer.addEventListener("mouseover", () => {
      gProtectionsHandler.onTrackingProtectionIconHoveredOrFocused();
    });
  },
  { once: true }
);
