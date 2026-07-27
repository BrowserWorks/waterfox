/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AboutAddonsHTMLElement,
  hasPermission,
  isAbuseReportSupported,
  getOptionsType,
  getUpdateInstall,
  isAddonOptionsUIAllowed,
  isInState,
  isPendingRestartInstall,
} from "../aboutaddons-utils.mjs";

export class AddonOptions extends AboutAddonsHTMLElement {
  static get markup() {
    return `
      <template>
        <panel-list>
          <panel-item
            data-l10n-id="remove-addon-button"
            action="remove"
          ></panel-item>
          <panel-item
            data-l10n-id="install-update-button"
            action="install-update"
            badged
          ></panel-item>
          <panel-item
            data-l10n-id="preferences-addon-button"
            action="preferences"
          ></panel-item>
          <hr />
          <panel-item
            data-l10n-id="report-addon-button"
            action="report"
          ></panel-item>
          <hr />
          <panel-item
            data-l10n-id="manage-addon-button"
            action="expand"
          ></panel-item>
        </panel-list>
      </template>
    `;
  }

  connectedCallback() {
    if (!this.children.length) {
      this.render();
    }
  }

  get panel() {
    return this.querySelector("panel-list");
  }

  get panelListId() {
    if (!this.id) {
      // Fail loudly if the element is missing an id to derive the panel-list id
      // from (the addon-card element is expected to be deriving one from the
      // corresponding addon id to ensure the id is unique in the about:addons page).
      const err = new Error(
        `${this.localName} element is missing an id attribute`
      );
      console.error(err, this);
      throw err;
    }
    return `${this.id}-panel-list`;
  }

  updateSeparatorsVisibility() {
    let lastSeparator;
    let elWasVisible = false;

    // Collect the panel-list children that are not already hidden.
    const children = Array.from(this.panel.children).filter(el => !el.hidden);

    for (let child of children) {
      if (child.localName == "hr") {
        child.hidden = !elWasVisible;
        if (!child.hidden) {
          lastSeparator = child;
        }
        elWasVisible = false;
      } else {
        elWasVisible = true;
      }
    }
    if (!elWasVisible && lastSeparator) {
      lastSeparator.hidden = true;
    }
  }

  render() {
    this.appendChild(this.constructor.fragment);
    this.querySelector("panel-list").id = this.panelListId;
  }

  setElementState(el, card, addon, updateInstall) {
    if (isPendingRestartInstall(addon.install)) {
      el.hidden = true;
      return;
    }

    switch (el.getAttribute("action")) {
      case "remove":
        if (hasPermission(addon, "uninstall")) {
          // Regular add-on that can be uninstalled.
          el.disabled = false;
          el.hidden = false;
          document.l10n.setAttributes(el, "remove-addon-button");
        } else if (addon.isBuiltin) {
          // Likely the built-in themes, can't be removed, that's fine.
          el.hidden = true;
        } else {
          // Likely sideloaded, mention that it can't be removed with a link.
          el.hidden = false;
          el.disabled = true;
          if (!el.querySelector('[slot="support-link"]')) {
            let link = document.createElement("a", { is: "moz-support-link" });
            link.setAttribute("data-l10n-name", "link");
            link.setAttribute("support-page", "cant-remove-addon");
            link.setAttribute("slot", "support-link");
            el.appendChild(link);
            document.l10n.setAttributes(el, "remove-addon-disabled-button");
          }
        }
        break;
      case "report":
        el.hidden = !isAbuseReportSupported(addon);
        break;
      case "install-update":
        el.hidden = !updateInstall;
        break;
      case "expand":
        el.hidden = card.expanded;
        break;
      case "preferences": {
        const optionsType = getOptionsType(addon);
        el.hidden =
          optionsType !== "dialog" &&
          optionsType !== "tab" &&
          (optionsType !== "inline" || card.expanded);
        if (!el.hidden) {
          isAddonOptionsUIAllowed(addon).then(allowed => {
            el.hidden = !allowed;
          });
        }
        break;
      }
    }
  }

  update(card, addon, updateInstall) {
    const candidate = updateInstall || getUpdateInstall(addon);
    const effectiveUpdateInstall =
      candidate &&
      (isInState(candidate, "available") || isInState(candidate, "postponed"))
        ? candidate
        : null;
    for (let el of this.items) {
      this.setElementState(el, card, addon, effectiveUpdateInstall);
    }

    // Update the separators visibility based on the updated visibility
    // of the actions in the panel-list.
    this.updateSeparatorsVisibility();
  }

  get items() {
    return this.querySelectorAll("panel-item");
  }

  get visibleItems() {
    return Array.from(this.items).filter(item => !item.hidden);
  }
}
customElements.define("addon-options", AddonOptions);
