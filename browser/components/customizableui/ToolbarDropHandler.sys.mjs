/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

let lazy = {};

ChromeUtils.defineLazyGetter(lazy, "FluentStrings", function () {
  return new Localization(["browser/toolbarDropHandler.ftl"], true);
});

ChromeUtils.defineESModuleGetters(lazy, {
  HomePage: "resource:///modules/HomePage.sys.mjs",
  OpenInTabsUtils:
    "moz-src:///browser/components/tabbrowser/OpenInTabsUtils.sys.mjs",
  URILoadingHelper: "resource:///modules/URILoadingHelper.sys.mjs",
  UrlbarUtils: "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs",
});

export var ToolbarDropHandler = {
  _canDropLink: aEvent => Services.droppedLinkHandler.canDropLink(aEvent, true),

  onDragOver(aEvent) {
    if (this._canDropLink(aEvent)) {
      aEvent.preventDefault();
    }
  },

  async _openHomeDialog(aURL, win) {
    const [promptTitle, promptMsgSingle, promptMsgMultiple] =
      await lazy.FluentStrings.formatValues([
        "toolbar-drop-on-home-title",
        "toolbar-drop-on-home-msg",
        "toolbar-drop-on-home-msg-multiple",
      ]);

    var promptMsg;
    if (aURL.includes("|")) {
      promptMsg = promptMsgMultiple;
    } else {
      promptMsg = promptMsgSingle;
    }

    var pressedVal = Services.prompt.confirmEx(
      win,
      promptTitle,
      promptMsg,
      Services.prompt.STD_YES_NO_BUTTONS,
      null,
      null,
      null,
      null,
      { value: 0 }
    );

    if (pressedVal == 0) {
      lazy.HomePage.set(aURL).catch(console.error);
    }
  },

  onDropHomeButtonObserver(aEvent) {
    // disallow setting home pages that inherit the principal
    let links = Services.droppedLinkHandler.dropLinks(aEvent, true);
    if (links.length) {
      let urls = [];
      for (let link of links) {
        if (link.url.includes("|")) {
          urls.push(...link.url.split("|"));
        } else {
          urls.push(link.url);
        }
      }

      try {
        Services.droppedLinkHandler.validateURIsForDrop(aEvent, urls);
      } catch (e) {
        return;
      }

      const win = aEvent.target.documentGlobal;
      win.setTimeout(this._openHomeDialog, 0, urls.join("|"), win);
    }
  },

  async onDropNewTabButtonObserver(aEvent) {
    const win = aEvent.target.documentGlobal;
    let links = Services.droppedLinkHandler.dropLinks(aEvent);
    if (
      links.length >=
      Services.prefs.getIntPref("browser.tabs.maxOpenBeforeWarn")
    ) {
      // Sync dialog cannot be used inside drop event handler.
      let answer = await lazy.OpenInTabsUtils.promiseConfirmOpenInTabs(
        links.length,
        win
      );
      if (!answer) {
        return;
      }
    }

    let where = aEvent.shiftKey ? "tabshifted" : "tab";
    let triggeringPrincipal =
      Services.droppedLinkHandler.getTriggeringPrincipal(aEvent);
    let policyContainer =
      Services.droppedLinkHandler.getPolicyContainer(aEvent);
    for (let link of links) {
      if (link.url) {
        let data = await lazy.UrlbarUtils.getShortcutOrURIAndPostData(link.url);
        // Allow third-party services to fix up this URL.
        lazy.URILoadingHelper.openLinkIn(win, data.url, where, {
          postData: data.postData,
          allowThirdPartyFixup: true,
          triggeringPrincipal,
          policyContainer,
        });
      }
    }
  },

  async onDropNewWindowButtonObserver(aEvent) {
    const win = aEvent.target.documentGlobal;
    let links = Services.droppedLinkHandler.dropLinks(aEvent);
    if (
      links.length >=
      Services.prefs.getIntPref("browser.tabs.maxOpenBeforeWarn")
    ) {
      // Sync dialog cannot be used inside drop event handler.
      let answer = await lazy.OpenInTabsUtils.promiseConfirmOpenInTabs(
        links.length,
        win
      );
      if (!answer) {
        return;
      }
    }

    let triggeringPrincipal =
      Services.droppedLinkHandler.getTriggeringPrincipal(aEvent);
    let policyContainer =
      Services.droppedLinkHandler.getPolicyContainer(aEvent);
    for (let link of links) {
      if (link.url) {
        let data = await lazy.UrlbarUtils.getShortcutOrURIAndPostData(link.url);
        // Allow third-party services to fix up this URL.
        lazy.URILoadingHelper.openLinkIn(win, data.url, "window", {
          // TODO fix allowInheritPrincipal
          // (this is required by javascript: drop to the new window) Bug 1475201
          allowInheritPrincipal: true,
          postData: data.postData,
          allowThirdPartyFixup: true,
          triggeringPrincipal,
          policyContainer,
        });
      }
    }
  },
};
