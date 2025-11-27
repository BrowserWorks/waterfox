/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

// Overview of the in-content UI implementation:
//
// In-content UI is processed by the combination of this script
// and content scripts. Players are:
//
// * The playground tab (TAB): tab active tab which the in-content UI is
//   rendered in.
// * The controller module (CONTROLLER): this class.
// * The playground manager (MANAGER): a small content script injected to the
//   playground tab by InContentPanelController#preparePlaygroundTab().
// * The UI implementation module (IMPL): imported as a class (based on
//   `./InContentPanel.js`) and injected to the playground tab by
//   InContentPanelController#preparePlaygroundTab().
//
// When we need to show an in-content UI:
//
// S.1. The CONTROLLER sends a message to the MANAGER in the TAB, like
//      "are you already have a playground to embed in-content UI?"
//      We move toward if the MANAGER responces like "OK, I'm ready!".
//   S.1.1. If no response, the CONTROLLER injects MANAGER and IMPL into
//          the TAB and waits until the IMPL respond.
//   S.1.2. The MANAGER in the TAB starts to instanciate the IMPL.
//   S.1.3. The IMPL responds to the CONTROLLER, like "OK, I'm ready!"
//     S.1.3.1. If these operation is not finished until some seconds, the
//              CONTROLLER gives up and falls back to the UI in sidebar.
//   S.1.4. The CONTROLLER receives the "I'm ready" response from the IMPL
//          in the TAB, and moves toward.
// S.2. The CONTROLLER sends a message to show the UI with less delay.
// S.3. The IMPL shows the UI as soon as possible, for better user experience.
// S.4. If there is more UI parts which require longer load time,
//      we wait until the required resource is prepared successfully.
// S.5. The CONTROLLER sends a follow-up messaeg to the IMPL to complete the
//      UI initialization.
//
// When we need to hide the UI:
//
// H.1. The CONTROLLER sends a message to the MANAGER in the TAB, like
//      "are you already prepared as a playground?"
//      We move toward if the MANAGER responces like "OK, I'm ready!".
//   H.1.1. If no response, the MANAGER gives up to hide the UI.
//          We have nothing to do.
// H.2. The CONTROLLER sends a message to hide the UI in the TAB, to the IMPL,
//      like "hide the UI"
// H.3. The IMPL hides the panel.

import {
  configs,
  shouldApplyAnimation,
  isRTL,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';

import { Tab } from '/common/TreeItem.js';

import InContentPanel from './InContentPanel.js';

export default class InContentPanelController {
  constructor({
    // required
    type,
    UIClass,
    inSidebarUI,
    initializerCode,
    canRenderInSidebar,
    canRenderInContent,
    shouldFallbackToSidebar,
    // optional
    logger,
    shouldLog,
    canSendPossibleExpiredMessage,
  }) {
    this.type            = type;
    this.log             = logger || ((...messages) => console.log(...messages));
    this.shouldLog       = shouldLog;
    this.canRenderInSidebar      = canRenderInSidebar;
    this.canRenderInContent      = canRenderInContent;
    this.shouldFallbackToSidebar = shouldFallbackToSidebar;
    this.canSendPossibleExpiredMessage = canSendPossibleExpiredMessage || (message => message.type != `ws:${this.type}:show`);
    this.UIClass         = UIClass;
    this.inSidebarUI     = inSidebarUI;
    this.initializerCode = initializerCode;

    browser.tabs.onActivated.addListener(activeInfo => {
      const timestamp = Date.now();

      if (activeInfo.windowId != TabsStore.getCurrentWindowId())
        return;

      this.hideInSidebar({ timestamp });
      this.hideIn(activeInfo.tabId, { timestamp });
      this.hideIn(activeInfo.previousTabId, { timestamp });
    });
  }

  value(property) {
    if (typeof property == 'function') {
      return property();
    }
    return property;
  }

  // Generates a custom element name at random. This mainly aims to avoid
  // conflicting of custom element names defined by webpage scripts.
  // The generated name is user-unfriendly, this aims to guard your privacy.
  generateOneTimeCustomElementName() {
    const alphabets = 'abcdefghijklmnopqrstuvwxyz';
    const prefix = alphabets[Math.floor(Math.random() * alphabets.length)];
    return prefix + '-' + Date.now() + '-' + Math.round(Math.random() * 65000);
  }

  // S.1.1. Injects the MANAGER and IMPL into the TAB
  async preparePlaygroundTab(playgroundTabId) {
    const playgroundTab = Tab.get(playgroundTabId);
    if (!playgroundTab)
      return;

    this.log(`preparePlaygroundTab (${this.type}): insert container to the tab contents `, playgroundTab.url);
    await browser.tabs.executeScript(playgroundTabId, {
      matchAboutBlank: true,
      runAt: 'document_start',
      code: `(() => { // the MANAGER
        const logging = ${!!this.value(this.shouldLog)};

        ${InContentPanel.toString()}
        ${this.UIClass.toString()}

        // We cannot use multiple custom element types with contents scripts -
        // otherwise second custom type must fail its construction ("super()" in
        // its constructor raises unexpected error), so we just use only one
        // custom element type and recycle it for multiple purposes.
        window.closedContainerType = window.closedContainerType || '${this.generateOneTimeCustomElementName()}';

        const version = '${browser.runtime.getManifest().version}';
        if (window.lastClosedContainerVersion &&
            window.lastClosedContainerVersion != version) {
          window.clearClosedContents();
        }
        window.lastClosedContainerVersion = version;

        // We cannot undefine custom element types, so we define it just one time.
        if (!window.customElements.get(window.closedContainerType)) {
          window.closedContentsDestructors = new Set();
          // We use a wrapper custom element to enclose all preview elements
          // which can contain privacy information.
          // It should guard them from accesses by webpage scripts.
          class ClosedContainer extends HTMLElement {
            constructor() {
              super();
              const shadow = this.attachShadow({ mode: 'closed' });
              window.appendClosedContents = element => shadow.appendChild(element);
              window.removeClosedContents = element => shadow.removeChild(element);
              window.clearClosedContents = () => {
                for (const destructor of window.closedContentsDestructors) {
                  try {
                    destructor();
                  }
                  catch(error) {
                    console.error(error);
                  }
                }
                for (const element of shadow.childNodes) {
                  removeClosedContents(element);
                }
                closedContentsDestructors.clear();
                lastClosedContainer.parentNode.removeChild(lastClosedContainer);
                window.lastClosedContainer = null;
              };
            }
          }
          window.customElements.define(window.closedContainerType, ClosedContainer);
          window.destroyClosedContents = destructor => {
            try{
              destructor();
            }
            catch(error) {
              console.error(error);
            }
            window.closedContentsDestructors.delete(destructor);
            if (window.closedContentsDestructors.size > 0) {
              return;
            }
            window.lastClosedContainer.parentNode.removeChild(window.lastClosedContainer);
            window.lastClosedContainer = null;
          };
          window.createClosedContentsDestructor = (instance, onDestroy) => {
            let destructor;

            const onMessage = (message, _sender) => {
              switch (message?.type) {
                case 'ws:' + instance.type + ':ask-container-ready':
                  return Promise.resolve(true); // S.1.1. Responds to the CONTROLLER

                case '${Constants.kCOMMAND_NOTIFY_TAB_DETACHED_FROM_WINDOW}':
                  window.destroyClosedContents(destructor);
                  break;
              }
            };
            browser.runtime.onMessage.addListener(onMessage);

            destructor = () => {
              const root = instance.root;
              UIInstances.delete(instance.type);
              instance.destroy();
              onDestroy();
              browser.runtime.onMessage.removeListener(onMessage);
              window.removeEventListener('unload', destructor);
              window.removeEventListener('pagehide', destructor);
              window.removeClosedContents(root);
            };
            window.addEventListener('unload', destructor, { once: true });
            window.addEventListener('pagehide', destructor, { once: true });

            window.closedContentsDestructors.add(destructor);

            return destructor;
          };
        }

        if (!window.lastClosedContainer) {
          window.lastClosedContainer = document.createElement(window.closedContainerType);
          document.documentElement.appendChild(window.lastClosedContainer);
        }

        window.UIInstances = window.UIInstances || new Map();
        const oldInstance = UIInstances.get('${this.type}');
        if (oldInstance) {
          try {
            const root = oldInstance.root;
            oldInstance.destroy();
            removeClosedContents(root);
          }
          catch(_error) {
          }
        }

        UIInstances.set('${this.type}', (() => {
          ${this.initializerCode}
        })());
      })()`,
    });
  }

  // S.1.4 Wait until "I'm ready" message from the IMPL
  async waitUntilPlaygroundTabIsReady(playgroundTabId) {
    let resolver;
    const promisedLoaded = new Promise((resolve, _reject) => {
      resolver = resolve;
    });
    let timeout;
    const onMessage = (message, sender) => {
      if (message?.type != `ws:${this.type}:ready` ||
          sender.tab?.id != playgroundTabId)
        return;
      this.log(`waitUntilPlaygroundTabIsReady(${this.type}): ready in the tab `, playgroundTabId);
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      resolver();
    };
    browser.runtime.onMessage.addListener(onMessage);
    timeout = setTimeout(() => {
      if (!timeout)
        return;
      this.log(`waitUntilPlaygroundTabIsReady(${this.type}): timeout for the tab `, playgroundTabId);
      timeout = null;
      browser.runtime.onMessage.removeListener(onMessage);
      resolver();
    }, 1000);
    return promisedLoaded;
  }

  // S.1. - S.5.
  // returns succeeded or not (boolean)
  async sendMessage(playgroundTabId, message, { promisedMessage, canRenderInSidebar, shouldFallbackToSidebar, deferredResultResolver } = {}) {
    if (!playgroundTabId ||
        !this.value(this.canRenderInContent)) { // in-sidebar mode
      if (this.value(canRenderInSidebar || this.canRenderInSidebar)) {
        this.log(`sendMessage (${this.type}) (${message.type}): no tab specified or sidebar only mode, fallback to in-sidebar UI`);
        return this.sendInSidebarMessage(message, { promisedMessage });
      }
      else {
        this.log(`sendMessage (${this.type}) (${message.type}): no tab specified or not allowed, cancel`);
        return false;
      }
    }

    const retrying = !!deferredResultResolver;
    const playgroundTab = Tab.get(playgroundTabId);
    if (!playgroundTab)
      return false;

    // S.1. Sends a messaeg to the MANAGER
    let rawTab;
    try {
      const [ready, gotRawTab] = await Promise.all([
        browser.tabs.sendMessage(playgroundTabId, {
          type: `ws:${this.type}:ask-container-ready`,
        }).catch(_error => {}),
        browser.tabs.get(playgroundTabId),
      ]);
      rawTab = gotRawTab;
      this.log(`sendMessage (${this.type}) (${message.type}${retrying ? ', retrying' : ''}): response from the tab: `, { ready });
      if (!ready) {
        if (!message.canRetry) {
          this.log(`sendMessage (${this.type}) => no response, give up to send`);
          return false;
        }

        if (retrying) {
          // Retried to init tab preview panel, but failed, so
          // now we fall back to the in-sidebar tab preview.
          if (!this.value(shouldFallbackToSidebar || this.shouldFallbackToSidebar) ||
              !this.canSendPossibleExpiredMessage(message)) {
            this.log(`sendMessage (${this.type}) => no response after retrying, give up to send`);
            deferredResultResolver(false);
            return false;
          }
          this.log(`sendMessage (${this.type}) => no response after retrying, fall back to in-sidebar previes`);
          return this.sendInSidebarMessage(message, { promisedMessage })
            .then(() => {
              deferredResultResolver(true);
              return true;
            });
        }

        // We prepare tab preview panel now, and retry sending after that.
        this.log(`sendMessage (${this.type}) => no response, retry`);
        let resultResolver;
        const promisedResult = new Promise((resolve, _reject) => {
          resultResolver = resolve;
        });
        this.waitUntilPlaygroundTabIsReady(playgroundTabId).then(() => {
          this.sendMessage(playgroundTabId, message, {
            promisedMessage,
            canRenderInSidebar,
            shouldFallbackToSidebar,
            deferredResultResolver: resultResolver,
          });
        });
        // S.1.1. Injects the IMPL
        await this.preparePlaygroundTab(playgroundTabId);
        return promisedResult;
      }
    }
    catch (error) {
      this.log(`sendMessage (${this.type}) (${message.type}${retrying ? ', retrying' : ''}): failed to ask to the tab `, error);
      // We cannot show in-content UI in a tab with privileged contents.
      // Let's fall back to the in-sidebar UI.
      await this.sendInSidebarMessage(message, { promisedMessage });
      if (deferredResultResolver)
        deferredResultResolver(true);
      return true;
    }

    // hide in-sidebar tab preview if in-content tab preview is available
    this.hideInSidebar();

    let response;
    try {
      // S.2. Sends a message to the UI with less delay.
      const timestamp = Date.now();
      response = await browser.tabs.sendMessage(playgroundTabId, {
        timestamp,
        ...message,
        ...this.inSidebarUI.getColors(),
        widthInOuterWorld: rawTab.width,
        fixedOffsetTop: configs.inContentUIOffsetTop,
        animation: shouldApplyAnimation(),
        logging: this.value(this.shouldLog),
      });
      this.log(`sendMessage (${this.type}) (${message.type}${retrying ? ', retrying' : ''}): message was sent, response=`, response, ', promisedMessage =',   promisedMessage);
      if (deferredResultResolver)
        deferredResultResolver(!!response);

      if (response && promisedMessage) {
        // S.5. Sends a follow-up message.
        this.log(`sendMessage (${this.type}) (${message.type}${retrying ? ', retrying' : ''}, with proimsed properties): trying to wait until promised properties are resolved`);
        promisedMessage.then(async resolvedMessage => {
          const response = await browser.tabs.sendMessage(playgroundTabId, {
            timestamp,
            ...message,
            ...(resolvedMessage || {}),
            ...this.inSidebarUI.getColors(),
            widthInOuterWorld: rawTab.width,
            fixedOffsetTop: configs.inContentUIOffsetTop,
            animation: shouldApplyAnimation(),
            logging: this.value(this.shouldLog),
          });
          this.log(`sendMessage (${this.type}) (${message.type}${retrying ? ', retrying' : ''}, with previewURL): message was sent again, response = `,   response);
        });
      }
    }
    catch (error) {
      this.log(`sendMessage (${this.type}) (${message.type}${retrying ? ', retrying' : ''}): failed to send message `, error);
      if (!message.canRetry) {
        this.log(`sendMessage (${this.type}) => no response, give up to send`);
        return false;
      }

      if (retrying) {
        // Retried to initialize in-content UI, but failed, so
        // now we fall back to the in-sidebar UI.
        if (!this.value(shouldFallbackToSidebar || this.shouldFallbackToSidebar) ||
            !this.canSendPossibleExpiredMessage(message)) {
          this.log(`sendMessage (${this.type}) => no response after retrying, give up to send`);
          deferredResultResolver(false);
          return false;
        }
        this.log(`sendMessage (${this.type}) => no response after retrying, fall back to in-sidebar previes`);
        return this.sendInSidebarMessage(message, { promisedMessage })
          .then(() => {
            deferredResultResolver(true);
            return true;
          });
      }

      if (!this.canSendPossibleExpiredMessage(message)) {
        this.log(`sendMessage (${this.type}) => no response, already canceled, give up to send`);
        return false;
      }

      // the panel was destroyed unexpectedly, so we re-prepare it.
      this.log(`sendMessage (${this.type}) => no response, retry`);
      let resultResolver;
      const promisedResult = new Promise((resolve, _reject) => {
        resultResolver = resolve;
      });
      this.waitUntilPlaygroundTabIsReady(playgroundTabId).then(() => {
        this.sendMessage(playgroundTabId, message, {
          promisedMessage,
          canRenderInSidebar,
          shouldFallbackToSidebar,
          deferredResultResolver: resultResolver,
        });
      });
      await this.preparePlaygroundTab(playgroundTabId);
      return promisedResult;
    }

    if (typeof response != 'boolean' &&
        this.canSendPossibleExpiredMessage(message)) {
      this.log(`sendMessage (${this.type}) (${message.type}${retrying ? ', retrying' : ''}): got invalid response, fallback to in-sidebar preview`);
      // Failed to send message to the in-content UI, so
      // now we fall back to the in-sidebar UI.
      return this.sendInSidebarMessage(message, { promisedMessage });
    }

    // Everything is OK!
    return !!response;
  }

  async sendInSidebarMessage(message, { promisedMessage } = {}) {
    const timestamp = message.timestamp || Date.now();
    this.log(`sendInSidebarMessage(${message.type}})`);
    await this.inSidebarUI.handleMessage({
      timestamp,
      ...message,
      windowId: TabsStore.getCurrentWindowId(),
      animation: shouldApplyAnimation(),
      logging: this.value(this.shouldLog),
    });
    if (promisedMessage) {
      promisedMessage.then(resolvedMessage => {
        if (!resolvedMessage) {
          return;
        }
        this.inSidebarUI.handleMessage({
          timestamp,
          ...message,
          ...resolvedMessage,
          windowId: TabsStore.getCurrentWindowId(),
          animation: shouldApplyAnimation(),
          logging: this.value(this.shouldLog),
        });
      });
    }
    return true;
  }

  async show({
    // required
    anchorItem,
    targetItem,
    // optional
    messageParams,
    promisedMessageParams,
    canRenderInSidebar,
    shouldFallbackToSidebar,
    timestamp,
  }) {
    if (!timestamp) {
      timestamp = Date.now();
    }

    const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
    const playgroundTabId = Permissions.canInjectScriptToTabSync(activeTab) ?
      activeTab.id :
      null;

    const anchorTabRawRect = anchorItem?.$TST.element?.substanceElement?.getBoundingClientRect();
    const anchorTabRect = {
      bottom: anchorTabRawRect?.bottom || 0,
      height: anchorTabRawRect?.height || 0,
      left:   anchorTabRawRect?.left || 0,
      right:  anchorTabRawRect?.right || 0,
      top:    anchorTabRawRect?.top || 0,
      width:  anchorTabRawRect?.width || 0,
    };
    const prevItem = anchorItem?.$TST.unsafePreviousTab;
    if (prevItem?.$TST.states.has(Constants.kTAB_STATE_REMOVING)) {
      // When we close a tab by mouse operation and the next tab raises up under the cursor,
      // in-content UI rendered in the sidebar positioned based on the anchorItem will cover
      // the anchorItem itself because it is still shifted for removing tab under the cursor.
      // Thus we calculate the safer anchor coordinates here.
      const prevItemRect = prevItem.$TST.previousTab?.$TST.element?.getBoundingClientRect();
      anchorTabRect.top = (prevItemRect?.bottom || 0) + 1;
      anchorTabRect.bottom = anchorTabRect.top + anchorTabRect.height;
    }

    const mayBeRight = window.mozInnerScreenX - window.screenX > (window.outerWidth - window.innerWidth) / 2;

    this.log(`show (${this.type}, ${targetItem.id}}) [${Date.now() - timestamp}msec from start]: show in ${playgroundTabId || 'sidebar'} `, messageParams);
    const succeeded = await this.sendMessage(
      playgroundTabId,
      {
        type:     `ws:${this.type}:show`,
        targetId: targetItem.id,
        ...(messageParams || {}),
        anchorTabRect,
        /* These information is used to calculate offset of the sidebar header */
        offsetTop: window.mozInnerScreenY - window.screenY,
        offsetLeft: window.mozInnerScreenX - window.screenX,
        align: mayBeRight ? 'right' : 'left',
        rtl: isRTL(),
        scale: 1 / window.devicePixelRatio,
        // Don't call Date.now() here, because it can become larger than
        // the timestamp on mouseleave.
        timestamp,
        canRetry: !!playgroundTabId,
      },
      {
        promisedMessage: promisedMessageParams,
        canRenderInSidebar,
        shouldFallbackToSidebar,
      }
    ).catch(error => {
      this.log(`show (${this.type}$, {targetItem.id}}) failed: `, error);
    });
    this.log(` => ${succeeded ? 'succeeded' : 'failed'}`);
    return succeeded;
  }

  async hide({ timestamp, targetItem } = {}) {
    if (!timestamp) {
      timestamp = Date.now();
    }

    const activeTab = Tab.getActiveTab(TabsStore.getCurrentWindowId());
    const playgroundTabId = await Permissions.canInjectScriptToTab(activeTab) ?
      activeTab.id :
      null;

    if (playgroundTabId) {
      this.hideIn(playgroundTabId, { timestamp, targetItem });
    }
    else {
      this.hideInSidebar({ timestamp, targetItem });
    }
  }

  async hideIn(playgroundTabId, { timestamp, targetItem } = {}) {
    if (!timestamp) {
      timestamp = Date.now();
    }

    this.log(`hide (${this.type}) (${targetItem?.id}}) hide UI in ${playgroundTabId} `, timestamp);
    this.sendMessage(playgroundTabId, {
      type: `ws:${this.type}:hide`,
      targetId: targetItem?.id,
      timestamp,
    });
  }

  async hideInSidebar({ timestamp, targetItem } = {}) {
    if (!timestamp) {
      timestamp = Date.now();
    }

    this.log(`hide (${this.type}) (${targetItem?.id}}) hide UI in sidebar `, timestamp);
    this.sendInSidebarMessage({
      type: `ws:${this.type}:hide`,
      targetId: targetItem?.id,
      timestamp,
    });
  }
}
