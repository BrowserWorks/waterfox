/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// This is the main implementation to show the tab preview panel.
// See also: /siedbar/in-content-panel-tooltip.js

import InContentPanel from './InContentPanel.js';

export default class TabPreviewPanel extends InContentPanel {
  static TYPE = 'tab-preview';

  get styleRules() {
    return super.styleRules + `
      .in-content-panel-root.tab-preview-panel {
        bottom: 0;
        height: 100%;
        pointer-events: none;
        z-index: calc(var(--max-32bit-integer) - 100); /* put preview panel below tab group menu always */

        &:hover {
          opacity: 0;
        }

        .in-content-panel {
          overflow: hidden; /* clip the preview with the rounded edges */
          pointer-events: none;

          &.extended {
            max-width: min(100%, calc(var(--panel-width) * 2));
          }

          &.animation.updating,
          &.animation:not(.open) {
            margin-block-start: 1ch; /* The native tab preview panel "popups up" on the vertical tab bar. */
          }
          /*
          &[data-align="left"].updating,
          &[data-align="left"]:not(.open) {
            left: -1ch !important;
          }
          &[data-align="right"].updating,
          &[data-align="right"]:not(.open) {
            right: -1ch !important;
          }
          */

          &.extended .in-content-panel-title,
          &.extended .in-content-panel-url,
          &.extended .in-content-panel-image-container,
          &:not(.extended) .in-content-panel-extended-content {
            display: none;
          }
          &.extended .in-content-panel-contents,
          &.extended .in-content-panel-contents-inner-box {
            max-width: calc(min(100%, calc(var(--panel-width) * 2)) - (2px / var(--in-content-panel-scale)));
          }

          &.blank,
          & .blank,
          &.hidden,
          & .hidden {
            display: none;
          }

          &.loading,
          & .loading {
            opacity: 0;
          }

          &.updating,
          & .updating {
            visibility: hidden;
          }
        }

        .in-content-panel-contents-inner-box {
          max-width: calc(var(--panel-width) - (2px / var(--in-content-panel-scale)));
          min-width: calc(var(--panel-width) - (2px / var(--in-content-panel-scale)));
        }

        .in-content-panel.overflow .in-content-panel-contents {
          mask-image: linear-gradient(to top, transparent 0, black 2em);
        }

        .in-content-panel-title {
          font-size: calc(1em / var(--in-content-panel-scale));
          font-weight: bold;
          margin: var(--panel-border-radius) var(--panel-border-radius) 0;
          max-height: 3em; /* -webkit-line-clamp looks unavailable, so this is a workaround */
          overflow: hidden;
          /* text-overflow: ellipsis; */
          -webkit-line-clamp: 2; /* https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#15-18 */
        }

        .in-content-panel-url {
          font-size: calc(1em / var(--in-content-panel-scale));
          margin: 0 var(--panel-border-radius);
          opacity: 0.69; /* https://searchfox.org/mozilla-central/rev/234f91a9d3ebef0d514868701cfb022d5f199cb5/toolkit/themes/shared/design-system/tokens-shared.css#182 */
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .in-content-panel-extended-content {
          font-size: calc(1em / var(--in-content-panel-scale));
          margin: var(--panel-border-radius);
          white-space: pre;
        }

        .in-content-panel-image-container {
          border-block-start: calc(1px / var(--in-content-panel-scale)) solid var(--panel-border-color);
          margin-block-start: 0.25em;
          max-height: calc(var(--panel-width) * ${parseInt(this.BASE_PANEL_HEIGHT) / parseInt(this.BASE_PANEL_WIDTH)}); /* use relative value instead of 140px */
          overflow: hidden;
        }

        .in-content-panel-image {
          max-width: 100%;
          opacity: 1;

          .in-content-panel.animation:not(.updating) & {
            transition: opacity 0.2s ease-out;
          }

          &.loading {
            min-height: ${this.BASE_PANEL_HEIGHT};
          }
        }

        /* tree */
        .in-content-panel-extended-content {
          ul,
          ul ul {
            margin-block: 0;
            margin-inline: 1em 0;
            padding: 0;
            list-style: disc;
          }

          .title-line {
            display: flex;
            flex-direction: row;
            max-width: 100%;
            white-space: nowrap;

            &.title {
              overflow: hidden;
              text-overflow: ellipsis;
            }

            .cookieStoreName {
              display: flex;
              margin-inline-start: 1ch;

              &::before {
                content: "- ";
              }
            }
          }
        }
      }
    `;
  }

  init(givenRoot) {
    // https://searchfox.org/mozilla-central/rev/dfaf02d68a7cb018b6cad7e189f450352e2cde04/browser/themes/shared/tabbrowser/tab-hover-preview.css#5
    this.BASE_PANEL_WIDTH  = '280px';
    this.BASE_PANEL_HEIGHT = '140px';
    this.DATA_URI_BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIAAAUAAeImBZsAAAAASUVORK5CYII=';

    super.init(givenRoot);

    this.root.classList.add('tab-preview-panel');
  }

  async onBeforeShow(message, _sender) {
    // Simulate the behavior: show tab preview panel with delay
    // only when the panel is not shown yet.
    if (typeof message.waitInitialShowUntil == 'number' &&
        (!this.panel ||
         !this.panel.classList.contains('open'))) {
      const delay = Math.max(0, message.waitInitialShowUntil - Date.now());
      if (delay > 0) {
        await new Promise((resolve, _reject) => {
          setTimeout(resolve, delay);
        });
      }
    }
  }

  get UISource() {
    return `
      <div class="in-content-panel-title"></div>
      <div class="in-content-panel-url"></div>
      <div class="in-content-panel-extended-content"></div>
      <div class="in-content-panel-image-container">
        <img class="in-content-panel-image"/>
      </div>
    `;
  }

  prepareUI() {
    if (this.panel) {
      return;
    }
    super.prepareUI();

    const preview = this.panel.querySelector('.in-content-panel-image');
    preview.addEventListener('load', () => {
      if (preview.src)
        preview.classList.remove('loading');
    });
  }

  onUpdateUI({ targetId, title, url, tooltipHtml, hasPreview, previewURL, logging, complete, scale, ...params }) {
    if (logging)
      console.log(`${this.type} onUpdateUI `, { panel: this.panel, targetId, title, url, tooltipHtml, hasPreview, previewURL, ...params });

    const hasLoadablePreviewURL = previewURL && /^((https?|moz-extension):|data:image\/[^,]+,.+)/.test(previewURL);
    if (previewURL)
      hasPreview = hasLoadablePreviewURL;

    const previewImage = this.panel.querySelector('.in-content-panel-image');
    previewImage.classList.toggle('blank', !hasPreview && !hasLoadablePreviewURL);
    if (!previewURL ||
        (previewURL &&
         previewURL != previewImage.src)) {
      previewImage.classList.add('loading');
      previewImage.src = previewURL || this.DATA_URI_BLANK_PNG;
    }

    if (tooltipHtml) {
      const extendedContent = this.panel.querySelector('.in-content-panel-extended-content');
      extendedContent.innerHTML = tooltipHtml;
      this.panel.classList.add('extended');
    }

    if (typeof title == 'string' ||
        typeof url == 'string') {
      const titleElement = this.panel.querySelector('.in-content-panel-title');
      titleElement.textContent = title;
      const urlElement = this.panel.querySelector('.in-content-panel-url');
      urlElement.textContent = url;
      urlElement.classList.toggle('blank', !url);
      this.panel.classList.remove('extended');
    }

    if (!hasPreview) {
      if (logging) {
        console.log('updateUI: no preview, complete now');
      }
      return;
    }

    try {
      const { width, height } = !previewImage.src || previewImage.src == this.DATA_URI_BLANK_PNG ?
        { width: this.BASE_PANEL_WIDTH, height: this.BASE_PANEL_HEIGHT } :
        this.getPngDimensionsFromDataUri(previewURL);
      if (logging)
        console.log('updateUI: determined preview size: ', { width, height });
      const imageWidth = Math.min(window.innerWidth, Math.min(width, parseInt(this.BASE_PANEL_WIDTH)) / scale);
      const imageHeight = imageWidth / width * height;
      previewImage.style.width = previewImage.style.maxWidth = `min(100%, ${imageWidth}px)`;
      previewImage.style.height = previewImage.style.maxHeight = `${imageHeight}px`;
      requestAnimationFrame(complete);
      return true;
    }
    catch (error) {
      if (logging)
        console.log('updateUI: could not detemine preview size ', error, previewURL);
    }

    // failsafe: if it is not a png or failed to get dimensions, give up to determine the image size before loading.
    previewImage.style.width =
    previewImage.style.height =
    previewImage.style.maxWidth =
    previewImage.style.maxHeight = '';
    previewImage.addEventListener('load', complete, { once: true });
    previewImage.addEventListener('error', complete, { once: true });
    return true;
  }

  onBeforeCompleteUpdate({ complete }) {
    const previewImage = this.panel.querySelector('.in-content-panel-image');
    previewImage.removeEventListener('load', complete);
    previewImage.removeEventListener('error', complete);
  }

  onCompleteUpdate({ logging }) {
    const panelBox = this.panel.getBoundingClientRect();
    const panelHeight = panelBox.height;

    const contentsHeight = this.panel.querySelector('.in-content-panel-contents-inner-box').getBoundingClientRect().height;
    this.panel.classList.toggle('overflow', contentsHeight > panelHeight);
    if (logging)
      console.log(`${this.type} updateUI/complete: overflow: `, contentsHeight, ' > ', panelHeight);
  }

  getPngDimensionsFromDataUri(uri) {
    if (!/^data:image\/png;base64,/i.test(uri))
      throw new Error('impossible to parse as PNG image data ', uri);

    const base64Data = uri.split(',')[1];
    const binaryData = atob(base64Data);
    const byteArray = new Uint8Array(binaryData.length);
    const requiredScanSize = Math.min(binaryData.length, 24);
    for (let i = 0; i < requiredScanSize; i++) {
      byteArray[i] = binaryData.charCodeAt(i);
    }
    const pngSignature = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
    for (let i = 0; i < pngSignature.length; i++) {
      if (byteArray[i] !== pngSignature[i])
        throw new Error('invalid PNG header');
    }
    const width =
    (byteArray[16] << 24) |
    (byteArray[17] << 16) |
    (byteArray[18] << 8) |
    byteArray[19];
    const height =
    (byteArray[20] << 24) |
    (byteArray[21] << 16) |
    (byteArray[22] << 8) |
    byteArray[23];
    return { width, height };
  }
}
