/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

export const kTAB_SHARING_STATE_ELEMENT_NAME = 'tab-sharing-state';

export class TabSharingStateElement extends HTMLElement {
  static define() {
    window.customElements.define(kTAB_SHARING_STATE_ELEMENT_NAME, TabSharingStateElement);
  }

  constructor() {
    super();
    // We should initialize private properties with blank value for better performance with a fixed shape.
    this._reservedUpdate = null;
    this.initialized = false;
  }

  connectedCallback() {
    this.invalidate();
    this.initialized = true;
  }

  disconnectedCallback() {
    if (this._reservedUpdate) {
      this.removeEventListener('mouseover', this._reservedUpdate);
      this._reservedUpdate = null;
    }
  }

  invalidate() {
    if (this._reservedUpdate)
      return;

    this._reservedUpdate = () => {
      this._reservedUpdate = null;
      this._updateTooltip();
    };
    this.addEventListener('mouseover', this._reservedUpdate, { once: true });
  }

  _updateTooltip() {
    const tab = this.owner;
    if (!tab || !tab.$TST)
      return;

    const key = tab.$TST.maybeSharingScreen ?
      'tab_sharingState_sharingScreen_tooltip' :
      tab.$TST.maybeSharingMicrophone ?
        'tab_sharingState_sharingMicrophone_tooltip' :
        tab.$TST.maybeSharingCamera ?
          'tab_sharingState_sharingCamera_tooltip' :
          null;

    const tooltip = browser.i18n.getMessage(key);
    if (key)
      this.setAttribute('title', tooltip);
    else
      this.removeAttribute('title');
  }
}
