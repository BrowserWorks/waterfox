/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import {
  classMap,
  html,
  map,
  nothing,
} from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

const { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);

let lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SidebarManager:
    "moz-src:///browser/components/sidebar/SidebarManager.sys.mjs",
});
const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";

/**
 * A promotional card for drag-to-pin tabs.
 *
 * It is only displayed in the expanded sidebar state to vertical tab users who
 * do not have any pinned tabs.
 *
 * The card can be dismissed manually by clicking the X button. It is
 * automatically dismissed by adding a pin via a context menu or by dragging
 * the tab over the card and pinning.
 */
export default class SidebarPinsPromo extends MozLitElement {
  static queries = {
    card: ".promo-card",
    closeButton: ".close-button",
  };

  constructor() {
    super();
    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "verticalTabsEnabled",
      "sidebar.verticalTabs",
      false,
      () => this.requestUpdate()
    );
    XPCOMUtils.defineLazyPreferenceGetter(
      this,
      "dragToPinPromoDismissed",
      "sidebar.verticalTabs.dragToPinPromo.dismissed",
      false,
      () => this.requestUpdate()
    );
    this.launcherObserver = new MutationObserver(() => this.requestUpdate());
  }
  #icons = [
    { name: "firefox", src: "chrome://branding/content/about-logo.svg" },
    { name: "slack", src: "chrome://browser/skin/sidebar/slack.svg" },
    { name: "foxy", src: "chrome://branding/content/about-logo.svg" },
    { name: "gmail", src: "chrome://browser/skin/sidebar/gmail.svg" },
  ];

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("TabPinned", this);
    this.addEventListener("dragover", this);
    this.addEventListener("drop", this);
    this.addEventListener("dragleave", this);
    lazy.SidebarManager.addEventListener("checkForPinnedTabsComplete", this);
    lazy.SidebarManager.checkForPinnedTabs();
    this.launcherObserver.observe(window.SidebarController.sidebarMain, {
      attributeFilter: ["expanded"],
    });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("TabPinned", this);
    this.removeEventListener("dragover", this);
    this.removeEventListener("drop", this);
    this.removeEventListener("dragleave", this);
    lazy.SidebarManager.removeEventListener("checkForPinnedTabsComplete", this);
    this.launcherObserver.disconnect();
  }

  /**
   * Handle drag-and-drop events from MozTabbrowserTab elements.
   *
   * @param {DragEvent} event
   */
  handleEvent(event) {
    switch (event.type) {
      case "dragover":
        if (event.dataTransfer.types.includes(TAB_DROP_TYPE)) {
          event.preventDefault();
          this.card.toggleAttribute("dragactive", true);
        }
        break;
      case "drop":
      case "dragleave":
        this.card.toggleAttribute("dragactive", false);
        break;
      case "TabPinned":
        this.dismissDragToPinPromo();
        break;
      case "checkForPinnedTabsComplete":
        this.requestUpdate();
        break;
    }
  }

  dismissDragToPinPromo() {
    Services.prefs.setBoolPref(
      "sidebar.verticalTabs.dragToPinPromo.dismissed",
      true
    );
  }

  /**
   * Wrap one of the icons to be shown in a dotted border box.
   *
   * @param {object} icon
   * @returns {HTMLDivElement}
   */
  #iconCellTemplate(icon) {
    return html`<div
      class=${classMap({
        "icon-cell": true,
        [`icon-${icon.name}`]: true,
      })}
    >
      <img src=${icon.src} role="presentation" />
    </div>`;
  }

  get shouldRender() {
    return (
      this.verticalTabsEnabled &&
      lazy.SidebarManager.checkForPinnedTabsComplete &&
      !this.dragToPinPromoDismissed &&
      window.SidebarController.sidebarMain.hasAttribute("expanded")
    );
  }

  willUpdate() {
    this.toggleAttribute("hidden", !this.shouldRender);
  }

  render() {
    if (!this.shouldRender) {
      return nothing;
    }
    return html` <link
        rel="stylesheet"
        href="chrome://browser/content/sidebar/sidebar-pins-promo.css"
      />
      <moz-card class="promo-card">
        <div class="promo-text" data-l10n-id="sidebar-pins-promo-text"></div>
        <div class="icon-row">
          ${map(this.#icons, icon => this.#iconCellTemplate(icon))}
        </div>
      </moz-card>
      <moz-button
        class="close-button"
        iconsrc="resource://content-accessible/close-12.svg"
        data-l10n-id="sidebar-panel-header-close-button"
        @click=${this.dismissDragToPinPromo}
        size="small"
        type="icon ghost"
      >
      </moz-button>`;
  }
}

customElements.define("sidebar-pins-promo", SidebarPinsPromo);
