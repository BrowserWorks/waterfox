/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { html } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

/**
 * Small card for use in the Trust Panel that alerts the user of website breaches
 */
export default class BreachAlert extends MozLitElement {
  static properties = {
    hidden: {
      type: Boolean,
      // If this is not set to `true`, nothing will show up after toggling the
      // pref on for the first time and then viewing the trust panel on a
      // breached website:
      reflect: true,
    },
    breachStatus: { type: String },
    breachNames: { type: Array },
  };

  constructor() {
    super();
    this.hidden = false;
    this.breachStatus = "disabled";
  }

  async _handleCta(_event) {
    Glean.trustpanel.breachAlertDiscoveredMonitor.record();
    this.documentGlobal.switchToTabHavingURI(
      "https://monitor.mozilla.org/?utm_medium=referral&utm_source=firefox-desktop&utm_campaign=privacy-panel&utm_content=sign-up-global",
      true
    );

    // Store dismissal when user clicks to check monitor
    await this._dismissBreach();
    this.hidden = true;
  }

  async _handleDismiss(_event) {
    Glean.trustpanel.breachAlertDismissed.record({
      breach_status: this.breachStatus,
    });

    // Store dismissal
    await this._dismissBreach();
    this.hidden = true;
  }

  async _dismissBreach() {
    if (!this.breachNames) {
      console.warn("Cannot dismiss breach alert: no breach names provided");
      return;
    }

    this.dispatchEvent(
      new CustomEvent("dismissBreachAlert", {
        detail: { breachNames: this.breachNames },
        bubbles: true,
        composed: true,
      })
    );
  }

  render() {
    if (
      this.breachStatus === "disabled" ||
      this.breachStatus === "not-breached"
    ) {
      return null;
    }

    return html`
      <link
        rel="stylesheet"
        href="chrome://browser/content/controlcenter/components/breach-alert-panel.css"
      />
      <div class="container" ?hidden=${this.hidden}>
        <div class="card">
          <div class="main">
            <img
              class="fox-icon-legacy"
              src="chrome://branding/content/about-logo.svg"
              alt=""
            />
            <div class="content">
              <h2
                class="heading"
                data-l10n-id="trustpanel-breachalerts-anonymous-breached-header"
              ></h2>
              <p
                data-l10n-id="trustpanel-breachalerts-anonymous-breached-description"
              ></p>
            </div>
            <img
              class="shield-icon"
              src="chrome://browser/content/controlcenter/assets/breach-alert-shield-warning.svg"
              alt=""
            />
          </div>
          <moz-button-group>
            <moz-button
              @click=${this._handleDismiss}
              data-l10n-id="trustpanel-breachalerts-anonymous-breached-button-dismiss"
            ></moz-button>
            <moz-button
              type="primary"
              @click=${this._handleCta}
              data-l10n-id="trustpanel-breachalerts-anonymous-breached-button-check-monitor"
            ></moz-button>
          </moz-button-group>
        </div>
      </div>
    `;
  }
}

customElements.define("breach-alert-panel", BreachAlert);
