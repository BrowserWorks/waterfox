/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  PageWireframes: "resource:///modules/sessionstore/PageWireframes.sys.mjs",
});

const ZERO_DELAY_ACTIVATION_TIME = 300;

/**
 * Detailed preview card that displays when hovering a tab
 */
export default class TabHoverPreviewPanel {
  constructor(panel) {
    this._panel = panel;
    this._win = panel.ownerGlobal;
    this._tab = null;
    this._thumbnailElement = null;

    // Observe changes to this tab's DOM, and
    // update the preview if the tab title changes
    this._tabObserver = new this._win.MutationObserver(
      (mutationList, _observer) => {
        for (const mutation of mutationList) {
          if (mutation.attributeName === "label") {
            this._updatePreview();
          }
        }
      }
    );

    this._setExternalPopupListeners();

    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "_prefDisableAutohide",
      "ui.popup.disable_autohide",
      false
    );
    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "_prefPreviewDelay",
      "ui.tooltip.delay_ms"
    );
    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "_prefDisplayThumbnail",
      "browser.tabs.hoverPreview.showThumbnails",
      false
    );
    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "_prefCollectWireframes",
      "browser.history.collectWireframes"
    );

    this._panelOpener = new TabPreviewPanelTimedFunction(
      () => {
        if (!this._isDisabled()) {
          if (this._win.SidebarController.treeVerticalTabsEnabled &&
              typeof this.__ws__top == 'number') {
            const [x, y] = this.calculateCoordinatesForVertical();
            this._panel.openPopupAtScreen(x, y, false);
          }
          else {
            this._panel.openPopup(this._tab, this.#popupOptions);
          }
        }
      },
      this._prefPreviewDelay,
      ZERO_DELAY_ACTIVATION_TIME,
      this._win
    );
  }

  get #verticalMode() {
    return this._win.gBrowser.tabContainer.verticalMode;
  }

  get #popupOptions() {
    if (!this.#verticalMode) {
      return {
        position: "bottomleft topleft",
        x: 0,
        y: -2,
      };
    }
    if (!this._win.SidebarController._positionStart) {
      return {
        position: "topleft topright",
        x: 0,
        y: 3,
      };
    }
    return {
      position: "topright topleft",
      x: 0,
      y: 3,
    };
  }

  getPrettyURI(uri) {
    let url = URL.parse(uri);
    if (!url) {
      return uri;
    }

    if (url.protocol == "about:" && url.pathname == "reader") {
      url = URL.parse(url.searchParams.get("url"));
    }

    if (url?.protocol === "about:") {
      return url.href;
    }
    return url ? url.hostname.replace(/^w{3}\./, "") : uri;
  }

  _hasValidWireframeState(tab) {
    return (
      this._prefCollectWireframes &&
      this._prefDisplayThumbnail &&
      tab &&
      !tab.selected &&
      !!lazy.PageWireframes.getWireframeState(tab)
    );
  }

  _hasValidThumbnailState(tab) {
    return (
      this._prefDisplayThumbnail &&
      tab &&
      tab.linkedBrowser &&
      !tab.getAttribute("pending") &&
      !tab.selected
    );
  }

  _maybeRequestThumbnail() {
    let tab = this._tab;

    if (!this._hasValidThumbnailState(tab)) {
      let wireframeElement = lazy.PageWireframes.getWireframeElementForTab(tab);
      if (wireframeElement) {
        this._thumbnailElement = wireframeElement;
        this._updatePreview();
      }
      return;
    }
    let thumbnailCanvas = this._win.document.createElement("canvas");
    thumbnailCanvas.width = 280 * this._win.devicePixelRatio;
    thumbnailCanvas.height = 140 * this._win.devicePixelRatio;

    this._win.PageThumbs.captureTabPreviewThumbnail(
      tab.linkedBrowser,
      thumbnailCanvas
    )
      .then(() => {
        // in case we've changed tabs after capture started, ensure we still want to show the thumbnail
        if (this._tab == tab && this._hasValidThumbnailState(tab)) {
          this._thumbnailElement = thumbnailCanvas;
          this._updatePreview();
        }
      })
      .catch(e => {
        // Most likely the window was killed before capture completed, so just log the error
        console.error(e);
      });
  }

  calculateCoordinatesForVertical() {
    const treeVerticalTabs = this._win.document.querySelector('#tree-vertical-tabs');
    const treeVerticalTabsRect = treeVerticalTabs.getBoundingClientRect();
    const align = Services.prefs.getBoolPref('sidebar.position_start') ? 'left' : 'right';
    const previewRect = this._panel.getBoundingClientRect();
    const x = align == 'left' ?
      treeVerticalTabs.screenX + treeVerticalTabsRect.width - 2 :
      treeVerticalTabs.screenX - previewRect.width + 2;
    const y = Math.min(treeVerticalTabs.screenY + this.__ws__top, treeVerticalTabs.screenY + treeVerticalTabsRect.height - previewRect.height);
    return [x, y];
  }

  activate(tab) {
    if (this._isDisabled()) {
      return;
    }

    this._tab = tab;
    this._tabObserver.observe(this._tab, {
      attributes: true,
    });

    // Calling `moveToAnchor` in advance of the call to `openPopup` ensures
    // that race conditions can be avoided in cases where the user hovers
    // over a different tab while the preview panel is still opening.
    // This will ensure the move operation is carried out even if the popup is
    // in an intermediary state (opening but not fully open).
    //
    // If the popup is closed this call will be ignored.
    this._movePanel();

    this._thumbnailElement = null;
    this._maybeRequestThumbnail();
    if (this._panel.state == "open" || this._panel.state == "showing") {
      this._updatePreview();
    }
    this._panelOpener.execute();
    this._win.addEventListener("TabSelect", this);
    this._panel.addEventListener("popupshowing", this);
  }

  deactivate(leavingTab = null) {
    if (leavingTab) {
      if (this._tab != leavingTab) {
        return;
      }
      this._win.requestAnimationFrame(() => {
        if (this._tab == leavingTab) {
          this.deactivate();
        }
      });
      return;
    }
    this._tab = null;
    this._tabObserver.disconnect();
    this._thumbnailElement = null;
    this._panel.removeEventListener("popupshowing", this);
    this._win.removeEventListener("TabSelect", this);
    if (!this._prefDisableAutohide) {
      this._panel.hidePopup();
    }
    this._panelOpener.setZeroDelay();
  }

  handleEvent(e) {
    switch (e.type) {
      case "popupshowing":
        this._updatePreview();
        break;
      case "TabSelect":
        this.deactivate();
        break;
    }
  }

  _updatePreview() {
    this._panel.querySelector(".tab-preview-title").textContent =
      this._displayTitle;
    this._panel.querySelector(".tab-preview-uri").textContent =
      this._displayURI;

    if (this._win.gBrowser.showPidAndActiveness) {
      this._panel.querySelector(".tab-preview-pid").textContent =
        this._displayPids;
      this._panel.querySelector(".tab-preview-activeness").textContent =
        this._displayActiveness;
    } else {
      this._panel.querySelector(".tab-preview-pid").textContent = "";
      this._panel.querySelector(".tab-preview-activeness").textContent = "";
    }

    let thumbnailContainer = this._panel.querySelector(
      ".tab-preview-thumbnail-container"
    );
    thumbnailContainer.classList.toggle(
      "hide-thumbnail",
      !this._hasValidThumbnailState(this._tab) &&
        !this._hasValidWireframeState(this._tab)
    );
    if (thumbnailContainer.firstChild != this._thumbnailElement) {
      thumbnailContainer.replaceChildren();
      if (this._thumbnailElement) {
        thumbnailContainer.appendChild(this._thumbnailElement);
      }
      this._panel.dispatchEvent(
        new CustomEvent("previewThumbnailUpdated", {
          detail: {
            thumbnail: this._thumbnailElement,
          },
        })
      );
    }
    this._movePanel();
  }

  _movePanel() {
    if (this._tab) {
      if (this._win.SidebarController.treeVerticalTabsEnabled &&
          typeof this.__ws__top == 'number') {
        const [x, y] = this.calculateCoordinatesForVertical();
        this._panel.moveTo(x, y);
        return;
      }
      this._panel.moveToAnchor(
        this._tab,
        this.#popupOptions.position,
        this.#popupOptions.x,
        this.#popupOptions.y
      );
    }
  }

  /**
   * Listen for any panels or menupopups that open or close anywhere else in the DOM tree
   * and maintain a list of the ones that are currently open.
   * This is used to disable tab previews until such time as the other panels are closed.
   */
  _setExternalPopupListeners() {
    // Since the tab preview panel is lazy loaded, there is a possibility that panels could
    // already be open on init. Therefore we need to initialize _openPopups with existing panels
    // the first time.
    const initialPopups = this._win.document.querySelectorAll(
      "panel[panelopen=true]:not(#tab-preview-panel), panel[animating=true]:not(#tab-preview-panel), menupopup[open=true]"
    );
    this._openPopups = new Set(initialPopups);

    const handleExternalPopupEvent = (eventName, setMethod) => {
      this._win.addEventListener(eventName, ev => {
        if (
          ev.target !== this._panel &&
          (ev.target.nodeName == "panel" || ev.target.nodeName == "menupopup")
        ) {
          this._openPopups[setMethod](ev.target);
        }
      });
    };
    handleExternalPopupEvent("popupshowing", "add");
    handleExternalPopupEvent("popuphiding", "delete");
  }

  _isDisabled() {
    return (
      // Other popups are open.
      this._openPopups.size ||
      // TODO (bug 1899556): for now disable in background windows, as there are
      // issues with windows ordering on Linux (bug 1897475), plus intermittent
      // persistence of previews after session restore (bug 1888148).
      this._win != Services.focus.activeWindow
    );
  }

  get _displayTitle() {
    if (!this._tab) {
      return "";
    }
    return this._tab.textLabel.textContent;
  }

  get _displayURI() {
    if (!this._tab || !this._tab.linkedBrowser) {
      return "";
    }
    return this.getPrettyURI(this._tab.linkedBrowser.currentURI.spec);
  }

  get _displayPids() {
    const pids = this._win.gBrowser.getTabPids(this._tab);
    if (!pids.length) {
      return "";
    }

    let pidLabel = pids.length > 1 ? "pids" : "pid";
    return `${pidLabel}: ${pids.join(", ")}`;
  }

  get _displayActiveness() {
    return this._tab?.linkedBrowser?.docShellIsActive ? "[A]" : "";
  }
}

/**
 * A wrapper that allows for delayed function execution, but with the
 * ability to "zero" (i.e. cancel) the delay for a predetermined period
 */
class TabPreviewPanelTimedFunction {
  constructor(target, delay, zeroDelayTime, win) {
    this._target = target;
    this._delay = delay;
    this._zeroDelayTime = zeroDelayTime;
    this._win = win;

    this._timer = null;
    this._useZeroDelay = false;
  }

  execute() {
    if (this.delayActive) {
      return;
    }

    // Always setting a timer, even in the situation where the
    // delay is zero, seems to prevent a class of race conditions
    // where multiple tabs are hovered in quick succession
    this._timer = this._win.setTimeout(
      () => {
        this._timer = null;
        this._target();
      },
      this._useZeroDelay ? 0 : this._delay
    );
  }

  clear() {
    if (this._timer) {
      this._win.clearTimeout(this._timer);
      this._timer = null;
    }
  }

  setZeroDelay() {
    this.clear();

    if (this._useZeroDelay) {
      return;
    }

    this._win.setTimeout(() => {
      this._useZeroDelay = false;
    }, this._zeroDelayTime);
    this._useZeroDelay = true;
  }

  get delayActive() {
    return this._timer !== null;
  }
}
