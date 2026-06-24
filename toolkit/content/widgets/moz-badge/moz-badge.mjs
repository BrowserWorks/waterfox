/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { html, ifDefined } from "../vendor/lit.all.mjs";
import { MozLitElement } from "../lit-utils.mjs";

window.MozXULElement?.insertFTLIfNeeded("toolkit/global/mozBadge.ftl");

/**
 @typedef {"default" | "beta" | "new"} MozBadgeType Types of badges for moz-badge.*

 /**
 * A simple badge element that can be used to indicate status or convey simple messages
 *
 * @tagname moz-badge
 * @property {string} label - Text to display on the badge, by default inferred from type
 * @property {string} iconSrc - The src for an optional icon shown next to the label
 * @property {string} title - The title of the badge, appears as a tooltip on hover
 * @property {MozBadgeType} type - The type of badge (e.g., "new")
 */
export default class MozBadge extends MozLitElement {
  static properties = {
    label: { type: String, fluent: true },
    iconSrc: { type: String },
    title: { type: String, fluent: true, mapped: true },
    type: { type: String, reflect: true },
  };

  constructor() {
    super();
    this.label = "";
    /**
     * @type {MozBadgeType}
     */
    this.type = "default";
  }

  get labelL10nId() {
    if (this.type == "beta") {
      return "moz-badge-beta2";
    }
    if (this.type == "new") {
      return "moz-badge-new2";
    }
    if (this.type == "waterfox-exclusive") {
      return "waterfox-settings-exclusive-badge";
    }

    return undefined;
  }

  render() {
    return html`
      <link
        rel="stylesheet"
        href="chrome://global/content/elements/moz-badge.css"
      />
      <div class="moz-badge" title=${ifDefined(this.title)}>
        ${this.iconSrc
          ? html`<img class="moz-badge-icon" src=${this.iconSrc} role="presentation"></img>`
          : ""}
        <span
          class="moz-badge-label"
          data-l10n-id=${ifDefined(this.label ? null : this.labelL10nId)}
          >${this.label}</span
        >
      </div>
    `;
  }
}
customElements.define("moz-badge", MozBadge);
