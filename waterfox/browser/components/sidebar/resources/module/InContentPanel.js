/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// This is the base class of implementations to show custom UI on contents.

// This script can be loaded in three ways:
//  * REGULAR case:
//    loaded into a public webpage
//  * SIDEBAR case:
//    loaded into the TST sidebar

export default class InContentPanel {
  static TYPE = 'in-content-panel';
  get type() {
    return this.constructor.TYPE;
  }

  panel;
  root;
  windowId; // for SIDEBAR case

  // -moz-platform @media rules looks unavailable on Web contents...
  isWindows = /^Win/i.test(navigator.platform);
  isLinux = /Linux/i.test(navigator.platform);
  isMac = /^Mac/i.test(navigator.platform);

  get styleRules() {
    return `
      .in-content-panel-root {
        --in-content-panel-show-hide-animation: opacity 0.1s ease-out;
        --in-content-panel-scale: 1; /* Web contents may be zoomed by the user, and we need to cancel the zoom effect. */
        --max-32bit-integer: 2147483647;
        background: transparent;
        border: 0 none;
        bottom: auto;
        height: 0px;
        left: 0;
        opacity: 1;
        overflow: hidden;
        position: fixed;
        right: 0;
        top: 0;
        transition: var(--in-content-panel-show-hide-animation);
        width: 100%;
        z-index: var(--max-32bit-integer);

        .in-content-panel {
          /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/toolkit/themes/shared/popup.css#11-63 */
          color-scheme: light dark;

          --panel-background: Menu;
          --panel-color: MenuText;
          --panel-padding-block: calc(4px / var(--in-content-panel-scale));
          --panel-padding: var(--panel-padding-block) 0;
          --panel-border-radius: calc(4px / var(--in-content-panel-scale));
          --panel-border-color: ThreeDShadow;
          --panel-width: initial;

          --panel-shadow-margin: 0px;
          --panel-shadow: 0px 0px var(--panel-shadow-margin) hsla(0,0%,0%,.2);
          -moz-window-input-region-margin: var(--panel-shadow-margin);
          margin: calc(-1 * var(--panel-shadow-margin));

          /* Panel design token theming */
          --background-color-canvas: var(--panel-background);

          /*@media (-moz-platform: linux) {*/
          ${this.isLinux ? '' : '/*'}
            --panel-border-radius: calc(8px / var(--in-content-panel-scale));
            --panel-padding-block: calc(3px / var(--in-content-panel-scale));

            @media (prefers-contrast) {
              --panel-border-color: color-mix(in srgb, currentColor 60%, transparent);
            }
          ${this.isLinux ? '' : '*/'}
          /*}*/

          /*@media (-moz-platform: linux) or (-moz-platform: windows) {*/
          ${this.isLinux || this.isWindows ? '' : '/*'}
            --panel-shadow-margin: calc(4px / var(--in-content-panel-scale));
          ${this.isLinux || this.isWindows ? '' : '*/'}
          /*}*/

          /* On some linux WMs we need to draw square menus because alpha is not available */
          @media /*(-moz-platform: linux) and*/ (not (-moz-gtk-csd-transparency-available)) {
            ${this.isLinux ? '' : '/*'}
            --panel-shadow-margin: 0px !important;
            --panel-border-radius: 0px !important;
            ${this.isLinux ? '' : '*/'}
          }

          /*@media (-moz-platform: macos) {*/
          ${this.isMac ? '' : '/*'}
            appearance: auto;
            -moz-default-appearance: menupopup;
            background-color: Menu;
            --panel-background: white /* https://searchfox.org/mozilla-central/rev/86c208f86f35d53dc824f18f8e540fe5b0663870/browser/themes/shared/browser-colors.css#89 https://searchfox.org/mozilla-central/rev/86c208f86f35d53dc824f18f8e540fe5b0663870/toolkit/themes/shared/global-shared.css#128 */;
            --panel-border-color: transparent;
            --panel-border-radius: calc(6px / var(--in-content-panel-scale));
          ${this.isMac ? '' : '*/'}
          /*}*/

          /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#5 */
          --panel-width: min(100%, calc(${this.BASE_PANEL_WIDTH}px / var(--in-content-panel-scale)));
          --panel-padding: 0;

          /* https://searchfox.org/mozilla-central/rev/b576bae69c6f3328d2b08108538cbbf535b1b99d/toolkit/themes/shared/global-shared.css#111 */
          /* https://searchfox.org/mozilla-central/rev/b576bae69c6f3328d2b08108538cbbf535b1b99d/browser/themes/shared/browser-colors.css#90 */
          --panel-border-color: light-dark(rgb(240, 240, 244), rgb(82, 82, 94));


          @media (prefers-color-scheme: dark) {
            --panel-background: ${this.isMac ? 'rgb(66, 65, 77)' /* https://searchfox.org/mozilla-central/rev/86c208f86f35d53dc824f18f8e540fe5b0663870/browser/themes/shared/browser-colors.css#89 https://searchfox.org/mozilla-central/rev/86c208f86f35d53dc824f18f8e540fe5b0663870/toolkit/themes/shared/global-shared.css#128 */ : 'var(--dark-popup)'};
            --panel-color: var(--dark-popup-text);
            --panel-border-color: var(--dark-popup-border);
          }

          background: var(--panel-background);
          border: var(--panel-border-color) solid calc(1px / var(--in-content-panel-scale));
          border-radius: var(--panel-border-radius);
          box-shadow: var(--panel-shadow);
          box-sizing: border-box;
          color: var(--panel-color);
          direction: ltr;
          font: Message-Box;
          left: auto;
          line-height: 1.5;
          margin-block-start: 0px;
          max-width: var(--panel-width);
          min-width: var(--panel-width);
          opacity: 0;
          padding: 0;
          position: fixed;
          right: auto;
          z-index: var(--max-32bit-integer);

          &.rtl {
            direction: rtl;
          }
          &.animation {
            transition: var(--in-content-panel-show-hide-animation),
                        left 0.1s ease-out,
                        margin-block-start 0.1s ease-out,
                        right 0.1s ease-out;
          }
          &.open {
            opacity: 1;
          }

          &.updating,
          & .updating {
            visibility: hidden;
          }
        }

        .in-content-panel-contents {
          max-width: calc(var(--panel-width) - (2px / var(--in-content-panel-scale)));
          min-width: calc(var(--panel-width) - (2px / var(--in-content-panel-scale)));
        }

        .in-content-panel-contents {
          max-height: calc(var(--panel-max-height) - (2px / var(--in-content-panel-scale)));
        }
      }
    `;
  }

  constructor(givenRoot, ...args) {
    this.lastTimestamp = 0;
    this.lastTimestampFor = new Map();

    this.BASE_PANEL_WIDTH  = '280px';

    try {
      this.init(givenRoot, ...args);

      browser.runtime.sendMessage({
        type: `ws:${this.type}:ready`,
      });
    }
    catch (error) {
      console.log('TST In Content Panel fatal error: ', error);
      this.root = this.onMessageSelf = this.destroySelf = null;
    }
  }
  init(givenRoot) { // this can be overridden by subclasses
    this.destroySelf = this.destroy.bind(this);
    this.onMessageSelf = this.onMessage.bind(this);

    this.root = givenRoot || document.documentElement;
    this.root.classList.add('in-content-panel-root');

    const style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.textContent = this.styleRules;
    this.root.appendChild(style);

    browser.runtime.onMessage.addListener(this.onMessageSelf);
    window.addEventListener('unload', this.destroySelf, { once: true });
    window.addEventListener('pagehide', this.destroySelf, { once: true });
  }

  async onBeforeShow(_message, _sender) {} // this can be overridden by subclasses

  onMessage(message, sender) {
    if ((this.windowId &&
        message?.windowId != this.windowId))
      return;

    if (message?.logging)
      console.log(`${message.type}: `, message);

    switch (message?.type) {
      case `ws:${this.type}:show`:
        return (async () => {
          await this.onBeforeShow(message, sender);
          if (message.timestamp < this.lastTimestamp ||
              message.timestamp < (this.lastTimestampFor.get(message.targetId) || 0)) {
            if (message?.logging)
              console.log(`${this.type} show ${message.targetId}: expired, give up to show/update `, message.timestamp);
            return true;
          }
          if (message?.logging)
            console.log(`${this.type} show ${message.targetId}: invoked, let's show/update `, message.timestamp);
          this.lastTimestamp = message.timestamp;
          this.lastTimestampFor.set(message.targetId, message.timestamp);
          this.prepareUI();
          this.updateUI(message);
          this.panel.classList.add('open');
          return true;
        })();

      case `ws:${this.type}:hide`:
        return (async () => {
          // Ensure the order of messages: "show" for new target =>
          // "hide" for previous target.
          await new Promise(requestAnimationFrame);
          if (!this.panel ||
              (message.targetId &&
               this.panel.dataset.targetId != message.targetId)) {
            if (message?.logging)
              console.log(`${this.type} hide ${message.targetId}: already hidden, nothing to do `, message.timestamp);
            if (!this.panel && !message.targetId) { // on initial case
              this.lastTimestamp = message.timestamp;
            }
            if (message.targetId) {
              this.lastTimestampFor.set(message.targetId, message.timestamp);
            }
            return;
          }
          if (message.timestamp < this.lastTimestamp ||
              (message.targetId &&
               message.timestamp < (this.lastTimestampFor.get(message.targetId) || 0))) {
            if (message?.logging)
              console.log(`${this.type} hide ${message.targetId}: expired, give up to hide `, message.timestamp);
            return true;
          }
          if (message?.logging)
            console.log(`${this.type} hide ${message.targetId}: invoked, let's hide  `, message.timestamp);
          this.lastTimestamp = message.timestamp;
          if (message.targetId) {
            this.lastTimestampFor.set(message.targetId, message.timestamp);
          }
          this.panel.classList.remove('open');
          return true;
        })();

      case 'ws:notify-sidebar-closed':
        if (this.panel) {
          this.panel.classList.remove('open');
        }
        break;
    }
  }

  onBeforeDestroy() {} // this can be overridden by subclasses

  destroy() {
    this.onBeforeDestroy();

    if (!this.onMessageSelf)
      return;

    if (this.panel) {
      this.panel.parentNode.removeChild(this.panel);
      this.panel = null;
    }

    browser.runtime.onMessage.removeListener(this.onMessageSelf);
    window.removeEventListener('unload', this.destroySelf);
    window.removeEventListener('pagehide', this.destroySelf);

    this.lastTimestampFor.clear();
    this.root = this.onMessageSelf = this.destroySelf = null;
  }

  get UISource() { // this can be overridden by subclasses
    return '';
  }

  prepareUI() {
    if (this.panel) {
      return;
    }
    this.root.insertAdjacentHTML('beforeend', `
      <div class="in-content-panel">
        <div class="in-content-panel-contents">
          <div class="in-content-panel-contents-inner-box">
            ${this.UISource}
          </div>
        </div>
      </div>
    `.trim().replace(/>\s+</g, '><'));
    this.panel = this.root.querySelector('.in-content-panel');
  }

  onUpdateUI() {} // this can be overridden by subclasses
  onBeforeCompleteUpdate() {} // this can be overridden by subclasses
  onCompleteUpdate() {} // this can be overridden by subclasses
  onShown() {} // this can be overridden by subclasses

  updateUI({ targetId, anchorTabRect, offsetTop, align, rtl, scale, logging, animation, backgroundColor, borderColor, color, widthInOuterWorld, fixedOffsetTop, ...params }) {
    if (!this.panel)
      return;

    const startAt = this.lastStartedAt = Date.now();

    if (logging)
      console.log(`${this.type} updateUI `, { panel: this.panel, targetId, anchorTabRect, offsetTop, align, rtl, scale, widthInOuterWorld, fixedOffsetTop });

    this.panel.classList.add('updating');
    this.panel.classList.toggle('animation', animation);

    if (backgroundColor) {
      this.panel.style.setProperty('--panel-background', backgroundColor);
    }
    if (borderColor) {
      this.panel.style.setProperty('--panel-border-color', borderColor);
    }
    if (color) {
      this.panel.style.setProperty('--panel-color', color);
    }

    // This cancels the zoom effect by the user.
    // We need to calculate the scale with two devicePixelRatio values
    // from both the sidebar and the content area, because all contents
    // of the browser window can be scaled on a high-DPI display by the
    // platform.
    const isResistFingerprintingMode = window.mozInnerScreenY == window.screenY;
    const devicePixelRatio = window.devicePixelRatio != 1 ?
      window.devicePixelRatio : // devicePixelRatio is always available on macOS with Retina
      ((widthInOuterWorld || window.innerWidth) / window.innerWidth);
    if (logging)
      console.log(`${this.type} updateUI: isResistFingerprintingMode `, isResistFingerprintingMode, { devicePixelRatio });
    // But window.devicePixelRatio is not available if privacy.resistFingerprinting=true,
    // thus we need to calculate it based on tabs.Tab.width.
    scale = devicePixelRatio * (scale || 1);
    this.root.style.setProperty('--in-content-panel-scale', scale);
    this.panel.style.setProperty('--panel-width', `min(${window.innerWidth}px, calc(${this.BASE_PANEL_WIDTH} / ${scale}))`);

    const offsetFromWindowEdge = isResistFingerprintingMode ?
      0 :
      (window.mozInnerScreenY - window.screenY) * scale;
    const sidebarContentsOffset = isResistFingerprintingMode ?
      (fixedOffsetTop || 0) :
      (offsetTop - offsetFromWindowEdge) / scale;

    if (anchorTabRect) {
      const panelTopEdge = this.windowId ? anchorTabRect.bottom : anchorTabRect.top;
      const panelBottomEdge = this.windowId ? anchorTabRect.bottom : anchorTabRect.top;
      const panelMaxHeight = Math.max(window.innerHeight - panelTopEdge - sidebarContentsOffset, panelBottomEdge);
      this.panel.style.maxHeight = `${panelMaxHeight}px`;
      this.panel.style.setProperty('--panel-max-height', `${panelMaxHeight}px`);
      if (logging)
        console.log('updateUI: limit panel height to ', this.panel.style.maxHeight, { anchorTabRect, maxHeight: window.innerHeight, sidebarContentsOffset, offsetFromWindowEdge });
    }

    this.panel.classList.toggle('rtl', !!rtl);

    this.panel.dataset.targetId = targetId;
    if (align)
      this.panel.dataset.align = align;

    const complete = () => {
      if (complete.completed) {
        return;
      }

      this.onBeforeCompleteUpdate({ logging, complete });

      if (this.panel.dataset.targetId != targetId ||
          this.lastStartedAt != startAt)
        return;

      if (!anchorTabRect) {
        this.panel.classList.remove('updating');
        if (logging)
          console.log(`${this.type} updateUI/complete: no tab rect, no need to update the position`);
        return;
      }

      const panelBox = this.panel.getBoundingClientRect();
      if (!panelBox.height &&
          complete.retryCount++ < 10) {
        if (logging)
          console.log(`${this.type} updateUI/complete: panel size is zero, retrying `, complete.retryCount);
        requestAnimationFrame(complete);
        return;
      }

      complete.completed = true;

      this.onCompleteUpdate({ logging });

      const maxY = window.innerHeight / scale;
      const panelHeight = panelBox.height;

      let top;
      if (this.windowId) { // in-sidebar
        if (logging)
          console.log(`${this.type} updateUI/complete: in-sidebar, alignment calculating: `, { half: window.innerHeight, maxY, scale, anchorTabRect });
        if (anchorTabRect.top > (window.innerHeight / 2)) { // align to bottom edge of the tab
          top = `${Math.min(maxY, anchorTabRect.bottom / scale) - panelHeight - anchorTabRect.height}px`;
          if (logging)
            console.log(`${this.type}  => align to bottom edge of the tab, top=`, top);
        }
        else { // align to top edge of the tab
          top = `${Math.max(0, anchorTabRect.top / scale) + anchorTabRect.height}px`;
          if (logging)
            console.log(`${this.type}  => align to top edge of the tab, top=`, top);
        }

        if (logging)
          console.log(`${this.type}  => top=`, top);
      }
      else { // in-content
        // We need to shift the position with the height of the sidebar header.
        const alignToTopPosition = Math.max(0, anchorTabRect.top / scale) + sidebarContentsOffset;
        const alignToBottomPosition = Math.min(maxY, anchorTabRect.bottom + sidebarContentsOffset / scale) - panelHeight;

        if (logging)
          console.log(`${this.type} updateUI/complete: in-content, alignment calculating: `, { offsetFromWindowEdge, sidebarContentsOffset, alignToTopPosition, panelHeight, maxY, scale });
        if (alignToTopPosition + panelHeight >= maxY &&
            alignToBottomPosition >= 0) { // align to bottom edge of the tab
          top = `${alignToBottomPosition}px`;
          if (logging)
            console.log(`${this.type}  => align to bottom edge of the tab, top=`, top);
        }
        else { // align to top edge of the tab
          top = `${alignToTopPosition}px`;
          if (logging)
            console.log(`${this.type}  => align to top edge of the tab, top=`, top);
        }
      }
      // updateUI() may be called multiple times for a target tab
      // (with/without previewURL), so we should not set positions again
      // if not needed. Otherwise the animation may be canceled in middle.
      if (top &&
        this.panel.style.top != top) {
        this.panel.style.top = top;
      }

      let left, right;
      if (align == 'left') {
        left  = 'var(--panel-shadow-margin)';
        right = '';
      }
      else {
        left  = '';
        right = 'var(--panel-shadow-margin)';
      }
      if (this.panel.style.left != left) {
        this.panel.style.left = left;
      }
      if (this.panel.style.right != right) {
        this.panel.style.right = right;
      }

      this.panel.classList.remove('updating');

      this.onShown({ logging });
    };
    complete.retryCount = 0;

    const completed = this.onUpdateUI({
      // common args
      align,
      anchorTabRect,
      animation,
      backgroundColor,
      borderColor,
      color,
      fixedOffsetTop,
      logging,
      offsetTop,
      rtl,
      scale,
      widthInOuterWorld,
      // calculated values
      complete,
      // extra args for subclasses
      ...params,
    });
    if (!completed) {
      complete();
    }
  }

  // for SIDEBAR case
  set windowId(id) {
    return this.windowId = id;
  }
  get windowId() {
    return this.windowId;
  }

  // for SIDEBAR case
  handleMessage(message) {
    return this.onMessage(message);
  }

  getColors() {
    this.prepareUI();

    const style = window.getComputedStyle(this.panel, null);
    try {
      // Computed style's colors may be unexpected value if the element
      // is not rendered on the screen yet and it has colors for light
      // and dark schemes. So we need to get preferred colors manually.
      const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      return {
        backgroundColor: this.getPreferredColor(style.getPropertyValue('--panel-background'), { isDark }),
        borderColor: this.getPreferredColor(style.getPropertyValue('--panel-border-color'), { isDark }),
        color: this.getPreferredColor(style.getPropertyValue('--panel-color'), { isDark }),
      };
    }
    catch(_error) {
    }
    return {
      backgroundColor: style.backgroundColor,
      borderColor: style.borderColor,
      color: style.color,
    };
  }

  // Parse light-dark(<light color>, <dark color>) and return preferred color
  getPreferredColor(color, { isDark } = {}) {
    if (!color.startsWith('light-dark('))
      return color;

    const values = [];
    let buffer = '';
    let inParenCount = 0;
    color = color.substring(11); // remove "light-dark(" prefix
    ColorParse:
    for (let i = 0, maxi = color.length; i < maxi; i++) {
      const character = color.charAt(i);
      switch (character) {
        case '(':
          inParenCount++;
          buffer += character;
          break;

        case ')':
          inParenCount--;
          if (inParenCount < 0) {
            values.push(buffer);
            buffer = '';
            break ColorParse;
          }
          buffer += character;
          break;

        case ',':
          if (inParenCount > 0) {
            buffer += character;
          }
          else {
            values.push(buffer);
            buffer = '';
          }
          break;

        default:
          buffer += character;
          break;
      }
    }

    if (typeof isDark != 'boolean')
      isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    return isDark ? values[1] : values[0];
  }
}
