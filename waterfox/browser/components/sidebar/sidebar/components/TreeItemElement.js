/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

import {
  configs,
  sanitizeForHTMLText,
} from '/common/common.js';
import * as Constants from '/common/constants.js';
import * as Permissions from '/common/permissions.js';
import * as TabsStore from '/common/tabs-store.js';
import { Tab } from '/common/TreeItem.js';

import TabFavIconHelper from '/extlib/TabFavIconHelper.js';

import { kTAB_TWISTY_ELEMENT_NAME } from './TabTwistyElement.js';
import { kTAB_FAVICON_ELEMENT_NAME } from './TabFaviconElement.js';
import { kTREE_ITEM_LABEL_ELEMENT_NAME } from './TreeItemLabelElement.js';
import { kTAB_COUNTER_ELEMENT_NAME } from './TabCounterElement.js';
import { kTAB_SOUND_BUTTON_ELEMENT_NAME } from './TabSoundButtonElement.js';
import { kTAB_CLOSE_BOX_ELEMENT_NAME } from './TabCloseBoxElement.js';

export const kTREE_ITEM_ELEMENT_NAME = 'tab-item';
export const kTREE_ITEM_SUBSTANCE_ELEMENT_NAME = 'tab-item-substance';

export const kEVENT_TREE_ITEM_SUBSTANCE_ENTER = 'tab-item-substance-enter';
export const kEVENT_TREE_ITEM_SUBSTANCE_LEAVE = 'tab-item-substance-leave';

export const TabInvalidationTarget = Object.freeze({
  Twisty:      1 << 0,
  SoundButton: 1 << 1,
  CloseBox:    1 << 2,
  Tooltip:     1 << 3,
  Overflow:    1 << 4,
  All:         1 << 0 | 1 << 1 | 1 << 2 | 1 << 3 | 1 << 4,
});

export const TabUpdateTarget = Object.freeze({
  Counter:                1 << 0,
  Overflow:               1 << 1,
  DescendantsHighlighted: 1 << 2,
  CollapseExpandState:    1 << 3,
  TabProperties:          1 << 4,
  All:                    1 << 0 | 1 << 1 | 1 << 2 | 1 << 3 | 1 << 4,
});

const kTAB_CLASS_NAME = 'tab';

const NATIVE_PROPERTIES = new Set([
  'active',
  'attention',
  'audible',
  'discarded',
  'hidden',
  'highlighted',
  'pinned'
]);
const IGNORE_CLASSES = new Set([
  'tab',
  Constants.kTAB_STATE_ANIMATION_READY,
  Constants.kTAB_STATE_SUBTREE_COLLAPSED
]);

export class TreeItemElement extends HTMLElement {
  static define() {
    window.customElements.define(kTREE_ITEM_ELEMENT_NAME, TreeItemElement);
  }

  constructor() {
    super();

    // We should initialize private properties with blank value for better performance with a fixed shape.
    this._raw = null;
    this._reservedUpdateTooltip = null;
    this.__onMouseOver = null;
    this.__onMouseEnter = null;
    this.__onMouseLeave = null;
    this.__onWindowResize = null;
    this.__onConfigChange = null;
  }

  connectedCallback() {
    this.setAttribute('role', 'option');

    if (this.initialized) {
      this.initializeContents();
      this.invalidate(TabInvalidationTarget.All);
      this.update(TabUpdateTarget.TabProperties);
      this.applyAttributes();
      this._initExtraItemsContainers();
      this._startListening();
      return;
    }

    // I make ensure to call these operation only once conservatively because:
    //  * If we do these operations in a constructor of this class, Gecko throws `NotSupportedError: Operation is not supported`.
    //    * I'm not familiar with details of the spec, but this is not Gecko's bug.
    //      See https://dom.spec.whatwg.org/#concept-create-element
    //      "6. If result has children, then throw a "NotSupportedError" DOMException."
    //  * `connectedCallback()` may be called multiple times by append/remove operations.
    //
    // FIXME:
    //  Ideally, these descendants should be in shadow tree. Thus I don't change these element to custom elements.
    //  However, I hesitate to do it at this moment by these reasons.
    //  If we move these to shadow tree,
    //    * We need some rewrite our style.
    //      * This includes that we need to move almost CSS code into this file as a string.
    //    * I'm not sure about that whether we should require [CSS Shadow Parts](https://bugzilla.mozilla.org/show_bug.cgi?id=1559074).
    //      * I suspect we can resolve almost problems by using CSS Custom Properties.

    // We preserve this class for backward compatibility with other addons.
    this.classList.add(kTAB_CLASS_NAME);

    this.insertAdjacentHTML('beforeend', `
      <span class="native-tab-group-line"></span>
      <span class="${Constants.kEXTRA_ITEMS_CONTAINER} indent"></span>
      <${kTREE_ITEM_SUBSTANCE_ELEMENT_NAME} draggable="true">
        <span class="${Constants.kBACKGROUND} base"></span>
        <span class="${Constants.kBACKGROUND}">
          <span class="${Constants.kBURSTER}"></span>
        </span>
        <${kTAB_TWISTY_ELEMENT_NAME}></${kTAB_TWISTY_ELEMENT_NAME}>
        <span class="ui">
          <span class="${Constants.kEXTRA_ITEMS_CONTAINER} above"></span>
          <span class="caption">
            <${kTAB_FAVICON_ELEMENT_NAME}></${kTAB_FAVICON_ELEMENT_NAME}>
            <${kTAB_SOUND_BUTTON_ELEMENT_NAME}></${kTAB_SOUND_BUTTON_ELEMENT_NAME}>
            <${kTREE_ITEM_LABEL_ELEMENT_NAME}></${kTREE_ITEM_LABEL_ELEMENT_NAME}>
            <${kTAB_COUNTER_ELEMENT_NAME}></${kTAB_COUNTER_ELEMENT_NAME}>
            <${kTAB_CLOSE_BOX_ELEMENT_NAME}></${kTAB_CLOSE_BOX_ELEMENT_NAME}>
          </span>
          <span class="${Constants.kEXTRA_ITEMS_CONTAINER} below"></span>
          <span class="${Constants.kEXTRA_ITEMS_CONTAINER} behind"></span>
          <span class="${Constants.kEXTRA_ITEMS_CONTAINER} front"></span>
        </span>
        <span class="${Constants.kHIGHLIGHTER}"></span>
        <span class="${Constants.kCONTEXTUAL_IDENTITY_MARKER}"></span>
      </${kTREE_ITEM_SUBSTANCE_ELEMENT_NAME}>
    `.trim().replace(/>\s+</g, '><'));

    this.removeAttribute('draggable');

    this.initializeContents();
    this.invalidate(TabInvalidationTarget.All);
    this.update(TabUpdateTarget.TabProperties);
    this._initExtraItemsContainers();
    this.applyAttributes();
    this._startListening();
  }

  disconnectedCallback() {
    if (this._reservedUpdateTooltip) {
      this.removeEventListener('mouseover', this._reservedUpdateTooltip);
      this._reservedUpdateTooltip = null;
    }
    this._endListening();
    this._raw = null;
  }

  get initialized() {
    return !!this.substanceElement;
  }

  initializeContents() {
    // This can be called after the tab is removed, so
    // we need to initialize contents safely.
    if (this._labelElement) {
      if (!this._labelElement.owner) {
        this._labelElement.addOverflowChangeListener(() => {
          if (!this.$TST ||
              this.$TST.tab?.pinned)
            return;
          this.invalidateTooltip();
        });
      }
      this._labelElement.owner = this;
    }
    if (this.twisty) {
      this.twisty.owner = this;
      this.twisty.makeAccessible();
    }
    if (this._counterElement)
      this._counterElement.owner = this;
    if (this._soundButtonElement) {
      this._soundButtonElement.owner = this;
      this._soundButtonElement.makeAccessible();
    }
    if (this.closeBox) {
      this.closeBox.owner = this;
      this.closeBox.makeAccessible();
    }
  }

  // Elements restored from cache are initialized without bundled tabs.
  // Thus we provide abiltiy to get tab and service objects from cached/restored information.
  get raw() {
    return this._raw || (
      this._raw = (this.getAttribute('type') == 'group' ?
        TabsStore.windows.get(parseInt(this.getAttribute(Constants.kAPI_NATIVE_TAB_GROUP_ID))) :
        Tab.get(parseInt(this.getAttribute(Constants.kAPI_TAB_ID)))
      )
    );
  }
  set raw(value) {
    return this._raw = value;
  }

  get tab() { // for backward compatibility
    return this.raw;
  }
  set tab(value) {
    return this.raw = value;
  }

  get $TST() {
    return this._$TST || (this._$TST = this.raw && this.raw.$TST);
  }
  set $TST(value) {
    return this._$TST = value;
  }

  get substanceElement() {
    return this.querySelector(kTREE_ITEM_SUBSTANCE_ELEMENT_NAME);
  }

  get twisty() {
    return this.querySelector(kTAB_TWISTY_ELEMENT_NAME);
  }

  get favicon() {
    return this.querySelector(kTAB_FAVICON_ELEMENT_NAME);
  }

  get _labelElement() {
    return this.querySelector(kTREE_ITEM_LABEL_ELEMENT_NAME);
  }

  get _soundButtonElement() {
    return this.querySelector(kTAB_SOUND_BUTTON_ELEMENT_NAME);
  }

  get _counterElement() {
    return this.querySelector(kTAB_COUNTER_ELEMENT_NAME);
  }

  get closeBox() {
    return this.querySelector(kTAB_CLOSE_BOX_ELEMENT_NAME);
  }

  applyAttributes() {
    this._labelElement.value = this.dataset.title;
    this.favIconUrl = this._favIconUrl;
    this.setAttribute('aria-selected', this.classList.contains(Constants.kTAB_STATE_HIGHLIGHTED) ? 'true' : 'false');

    // for convenience on customization with custom user styles
    this.substanceElement.setAttribute(Constants.kAPI_TAB_ID, this.getAttribute(Constants.kAPI_TAB_ID));
    this.substanceElement.setAttribute(Constants.kAPI_WINDOW_ID, this.getAttribute(Constants.kAPI_WINDOW_ID));
    this._labelElement.setAttribute(Constants.kAPI_TAB_ID, this.getAttribute(Constants.kAPI_TAB_ID));
    this._labelElement.setAttribute(Constants.kAPI_WINDOW_ID, this.getAttribute(Constants.kAPI_WINDOW_ID));

    if (this.getAttribute('type') == 'tab' &&
        this.tab)
      this.dataset.index =
        this.substanceElement.dataset.index =
          this._labelElement.dataset.index =this.tab.index;

    this._labelElement.applyAttributes();
  }

  invalidate(targets) {
    if (!this.initialized)
      return;

    if (targets & TabInvalidationTarget.Twisty)
      this.twisty?.invalidate();

    if (targets & TabInvalidationTarget.SoundButton)
      this._soundButtonElement?.invalidate();

    if (targets & TabInvalidationTarget.CloseBox)
      this.closeBox?.invalidate();

    if (targets & TabInvalidationTarget.Tooltip)
      this.invalidateTooltip();

    if (targets & TabInvalidationTarget.Overflow) {
      this._labelElement.invalidateOverflow();
      this._needToUpdateOverflow = true;
    }
  }

  invalidateTooltip() {
    if (this._reservedUpdateTooltip)
      return;

    this.useTabPreviewTooltip = false;
    this.hasCustomTooltip = false;
    Permissions.isGranted(Permissions.ALL_URLS); // cache last state for the _updateTooltip()
    this._reservedUpdateTooltip = () => {
      this._reservedUpdateTooltip = null;
      this._updateTooltip();
    };
    this.addEventListener('mouseover', this._reservedUpdateTooltip, { once: true });
  }

  update(targets) {
    if (!this.initialized)
      return;

    if (targets & TabUpdateTarget.Counter)
      this._counterElement?.update();

    if (targets & TabUpdateTarget.Overflow)
      this._updateOverflow();

    if (targets & TabUpdateTarget.DescendantsHighlighted)
      this._updateDescendantsHighlighted();

    if (targets & TabUpdateTarget.CollapseExpandState)
      this._updateCollapseExpandState();

    if (targets & TabUpdateTarget.TabProperties)
      this._updateTabProperties();
  }

  updateOverflow() {
    if (this._needToUpdateOverflow ||
        configs.labelOverflowStyle == 'fade')
      this._updateOverflow();
    this.invalidateTooltip();
  }

  _updateOverflow() {
    this._needToUpdateOverflow = false;
    this._labelElement?.updateOverflow();
  }

  _updateTooltip() {
    if (!this.$TST) // called before binding on restoration from cache
      return;

    const raw = this.$TST.raw;
    const tabElement = raw?.$TST.element;
    if (!tabElement)
      return;

    // Priority of tooltip contents and methods
    // 1. Is the tab preview panel activated by the user? (option)
    //    * NO => Use legacy tooltip anyway.
    //      - Set "title" attribute for the legacy tooltip, if the tab is faviconized,
    //        or the tab has long title with overflow state, or custom tooltip.
    //      - Otherwise remove "title" attribute to suppress the legacy tooltip.
    //    * YES => Go ahead.
    // 2. Can we show tab preview panel in the active tab? (permission)
    //    * YES => Remove "title" attribute to suppress the legacy tooltip.
    //             Tooltip will be shown with tab preview panel in the active tab.
    //    * NO => Go ahead.
    // 3. Do we have custom tooltip? (for collapsed tree, specified via API, etc.)
    //    * YES => Set "title" attribute for the legacy tooltip with custom contents.
    //    * NO => Go ahead for the default tooltip.
    // 4. Can we show tab preview panel in the sidebar for the default tooltip? (option)
    //    * YES => Remove "title" attribute to suppress the legacy tooltip.
    //             The default tooltip will be shown with tab preview panel in the sidebar.
    //    * NO => Set "title" attribute for the legacy tooltip, if the tab is faviconized,
    //            or the tab has long title with overflow state.

    const canCaptureTab = Permissions.isGrantedSync(Permissions.ALL_URLS);
    const canInjectScriptToTab = Permissions.canInjectScriptToTabSync(Tab.getActiveTab(TabsStore.getCurrentWindowId()));
    this.useTabPreviewTooltip = !!(
      configs.tabPreviewTooltip &&
      canCaptureTab &&
      (((configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_CONTENT) &&
        canInjectScriptToTab) ||
       (configs.tabPreviewTooltipRenderIn & Constants.kIN_CONTENT_PANEL_RENDER_IN_SIDEBAR))
    );

    let debugTooltip;
    if (configs.debug) {
      debugTooltip = `
${raw.title}
#${raw.id}
(${tabElement.className})
uniqueId = <${this.$TST.uniqueId.id}>
duplicated = <${!!this.$TST.uniqueId.duplicated}> / <${this.$TST.uniqueId.originalTabId}> / <${this.$TST.uniqueId.originalId}>
restored = <${!!this.$TST.uniqueId.restored}>
rawId = ${raw.id}
windowId = ${raw.windowId}
index = ${raw.index}
`.trim();
      this.$TST.setAttribute('title', debugTooltip);
      if (!this.useTabPreviewTooltip) {
        this.tooltip = debugTooltip;
        this.tooltipHtml = `<pre>${sanitizeForHTMLText(debugTooltip)}</pre>`;
        return;
      }
    }

    this.tooltip                = this.$TST.defaultTooltipText;
    this.tooltipWithDescendants = this.$TST.tooltipTextWithDescendants;
    this.tooltipHtml            = this.$TST.tooltipHtml;
    this.tooltipHtmlWithDescendants = this.$TST.tooltipHtmlWithDescendants;

    const appliedTooltipText = this.appliedTooltipText;
    this.hasCustomTooltip = (
      appliedTooltipText !== null &&
      appliedTooltipText != this.$TST.defaultTooltipText
    );
    //console.log('this.useTabPreviewTooltip ', { useTabPreviewTooltip: this.useTabPreviewTooltip, canRunScript, canInjectScriptToTab, hasCustomTooltip: this.hasCustomTooltip });

    const tooltipText = configs.debug ?
      debugTooltip :
      (this.useTabPreviewTooltip &&
       (canInjectScriptToTab ||
        !(this.hasCustomTooltip && configs.showCollapsedDescendantsByLegacyTooltipOnSidebar))) ?
        null :
        appliedTooltipText;
    if (typeof tooltipText == 'string')
      this.$TST.setAttribute('title', tooltipText);
    else
      this.$TST.removeAttribute('title');
  }

  get appliedTooltipText() {
    if (configs.showCollapsedDescendantsByTooltip &&
        this.$TST.subtreeCollapsed &&
        this.$TST.hasChild) {
      return this.tooltipWithDescendants;
    }

    const highPriorityTooltipText = this.$TST.highPriorityTooltipText;
    if (typeof highPriorityTooltipText == 'string') {
      if (highPriorityTooltipText)
        return highPriorityTooltipText;

      return null;
    }

    let tooltip = null;

    const raw = this.$TST.raw;
    if (this.classList.contains('faviconized') ||
        this.overflow ||
        this.tooltip != raw.title)
      tooltip = this.tooltip;
    else
      tooltip = null;

    const lowPriorityTooltipText = this.$TST.lowPriorityTooltipText;
    if (typeof lowPriorityTooltipText == 'string' &&
        !this.getAttribute('title')) {
      if (lowPriorityTooltipText)
        tooltip = lowPriorityTooltipText;
      else
        tooltip = null;
    }
    return tooltip;
  }

  get appliedTooltipHtml() {
    if (configs.showCollapsedDescendantsByTooltip &&
        this.$TST.subtreeCollapsed &&
        this.$TST.hasChild) {
      return this.tooltipHtmlWithDescendants;
    }

    const highPriorityTooltipText = this.$TST.highPriorityTooltipText;
    if (typeof highPriorityTooltipText == 'string') {
      if (highPriorityTooltipText)
        return sanitizeForHTMLText(highPriorityTooltipText);

      return null;
    }

    let tooltip = null;

    const raw = this.$TST.raw;
    if (this.classList.contains('faviconized') ||
        this.overflow ||
        this.tooltip != raw.title)
      tooltip = this.tooltipHtml;
    else
      tooltip = null;

    const lowPriorityTooltipText = this.$TST.lowPriorityTooltipText;
    if (typeof lowPriorityTooltipText == 'string' &&
        !this.getAttribute('title')) {
      if (lowPriorityTooltipText)
        tooltip = sanitizeForHTMLText(lowPriorityTooltipText);
      else
        tooltip = null;
    }
    return tooltip;
  }

  _initExtraItemsContainers() {
    if (!this.extraItemsContainerIndentRoot) {
      this.extraItemsContainerIndentRoot = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.indent`).attachShadow({ mode: 'open' });
      this.extraItemsContainerIndentRoot.itemById = new Map();
    }
    if (!this.extraItemsContainerBehindRoot) {
      this.extraItemsContainerBehindRoot = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.behind`).attachShadow({ mode: 'open' });
      this.extraItemsContainerBehindRoot.itemById = new Map();
    }
    if (!this.extraItemsContainerFrontRoot) {
      this.extraItemsContainerFrontRoot = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.front`).attachShadow({ mode: 'open' });
      this.extraItemsContainerFrontRoot.itemById = new Map();
    }
    if (!this.extraItemsContainerAboveRoot) {
      this.extraItemsContainerAboveRoot = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.above`).attachShadow({ mode: 'open' });
      this.extraItemsContainerAboveRoot.itemById = new Map();
    }
    if (!this.extraItemsContainerBelowRoot) {
      this.extraItemsContainerBelowRoot = this.querySelector(`.${Constants.kEXTRA_ITEMS_CONTAINER}.below`).attachShadow({ mode: 'open' });
      this.extraItemsContainerBelowRoot.itemById = new Map();
    }
  }

  _startListening() {
    if (this.__onMouseOver)
      return;
    this.addEventListener('mouseover', this.__onMouseOver = this._onMouseOver.bind(this));
    this.addEventListener('mouseenter', this.__onMouseEnter = this._onMouseEnter.bind(this));
    this.substanceElement?.addEventListener('mouseenter', this.__onMouseEnter);
    this.addEventListener('mouseleave', this.__onMouseLeave = this._onMouseLeave.bind(this));
    this.substanceElement?.addEventListener('mouseleave', this.__onMouseLeave);
    window.addEventListener('resize', this.__onWindowResize = this._onWindowResize.bind(this));
    configs.$addObserver(this.__onConfigChange = this._onConfigChange.bind(this));
  }

  _endListening() {
    if (!this.__onMouseOver)
      return;
    this.removeEventListener('mouseover', this.__onMouseOver);
    this.__onMouseOver = null;
    this.removeEventListener('mouseenter', this.__onMouseEnter);
    this.substanceElement?.removeEventListener('mouseenter', this.__onMouseEnter);
    this.__onMouseEnter = null;
    this.removeEventListener('mouseleave', this.__onMouseLeave);
    this.substanceElement?.removeEventListener('mouseleave', this.__onMouseLeave);
    this.__onMouseLeave = null;
    window.removeEventListener('resize', this.__onWindowResize);
    this.__onWindowResize = null;
    configs.$removeObserver(this.__onConfigChange);
    this.__onConfigChange = null;
  }

  _onMouseOver(_event) {
    this._updateTabAndAncestorsTooltip(this.$TST.raw);
  }

  _onMouseEnter(event) {
    if (this.classList.contains('faviconized') != (event.target == this))
      return;
    if (this._reservedUpdateTooltip) {
      this.removeEventListener('mouseover', this._reservedUpdateTooltip);
      this._updateTooltip();
    }
    const tabSubstanceEnterEvent = new MouseEvent(kEVENT_TREE_ITEM_SUBSTANCE_ENTER, {
      ...event,
      clientX: event.clientX,
      clientY: event.clientY,
      screenX: event.screenX,
      screenY: event.screenY,
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(tabSubstanceEnterEvent);
  }

  _onMouseLeave(event) {
    if (this.classList.contains('faviconized') != (event.target == this))
      return;
    const tabSubstanceLeaveEvent = new UIEvent(kEVENT_TREE_ITEM_SUBSTANCE_LEAVE, {
      ...event,
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(tabSubstanceLeaveEvent);
  }

  _onWindowResize(_event) {
    this.invalidateTooltip();
  }

  _onConfigChange(changedKey) {
    switch (changedKey) {
      case 'showCollapsedDescendantsByTooltip':
        this.invalidateTooltip();
        break;

      case 'labelOverflowStyle':
        this.updateOverflow();
        break;
    }
  }

  _updateTabAndAncestorsTooltip(tab) {
    if (!TabsStore.ensureLivingItem(tab))
      return;
    for (const updateTab of [tab].concat(tab.$TST.ancestors)) {
      const tabElement = updateTab.$TST.element;
      if (!tabElement)
        continue;
      tabElement.invalidateTooltip();
      // on the "fade" mode, overflow style was already updated,
      // so we don' need to update the status here.
      if (configs.labelOverflowStyle != 'fade')
        tabElement.updateOverflow();
    }
  }

  _updateDescendantsHighlighted() {
    if (!this.$TST) // called before binding on restoration from cache
      return;

    const children = this.$TST.children;
    if (!this.$TST.hasChild) {
      this.$TST.removeState(Constants.kTAB_STATE_SOME_DESCENDANTS_HIGHLIGHTED);
      this.$TST.removeState(Constants.kTAB_STATE_ALL_DESCENDANTS_HIGHLIGHTED);
      return;
    }
    let someHighlighted = false;
    let allHighlighted  = true;
    for (const child of children) {
      if (child.$TST.states.has(Constants.kTAB_STATE_HIGHLIGHTED)) {
        someHighlighted = true;
        allHighlighted = (
          allHighlighted &&
          (!child.$TST.hasChild ||
           child.$TST.states.has(Constants.kTAB_STATE_ALL_DESCENDANTS_HIGHLIGHTED))
        );
      }
      else {
        if (!someHighlighted &&
            child.$TST.states.has(Constants.kTAB_STATE_SOME_DESCENDANTS_HIGHLIGHTED)) {
          someHighlighted = true;
        }
        allHighlighted = false;
      }
    }
    if (someHighlighted) {
      this.$TST.addState(Constants.kTAB_STATE_SOME_DESCENDANTS_HIGHLIGHTED);
      this.$TST.toggleState(Constants.kTAB_STATE_ALL_DESCENDANTS_HIGHLIGHTED, allHighlighted);
    }
    else {
      this.$TST.removeState(Constants.kTAB_STATE_SOME_DESCENDANTS_HIGHLIGHTED);
      this.$TST.removeState(Constants.kTAB_STATE_ALL_DESCENDANTS_HIGHLIGHTED);
    }
  }

  _updateCollapseExpandState() {
    if (!this.$TST) // called before binding on restoration from cache
      return;

    const classList = this.classList;
    const parent = this.$TST.parent;
    if (this.$TST.collapsed ||
        (parent &&
         (parent.$TST.collapsed ||
          parent.$TST.subtreeCollapsed))) {
      if (!classList.contains(Constants.kTAB_STATE_COLLAPSED))
        classList.add(Constants.kTAB_STATE_COLLAPSED);
      if (!classList.contains(Constants.kTAB_STATE_COLLAPSED_DONE))
        classList.add(Constants.kTAB_STATE_COLLAPSED_DONE);
    }
    else {
      if (classList.contains(Constants.kTAB_STATE_COLLAPSED))
        classList.remove(Constants.kTAB_STATE_COLLAPSED);
      if (classList.contains(Constants.kTAB_STATE_COLLAPSED_DONE))
        classList.remove(Constants.kTAB_STATE_COLLAPSED_DONE);
    }
  }

  _updateTabProperties() {
    if (!this.$TST) // called before binding on restoration from cache
      return;

    const raw       = this.$TST.raw;
    const classList = this.classList;

    this.label = raw.title;

    const tab = this.$TST.tab;
    if (tab) {
      const openerOfGroupTab = tab && this.$TST.isGroupTab && Tab.getOpenerFromGroupTab(tab);
      this.favIconUrl = openerOfGroupTab?.favIconUrl || tab?.favIconUrl;

      for (const state of classList) {
        if (IGNORE_CLASSES.has(state) ||
            NATIVE_PROPERTIES.has(state))
          continue;
        if (!this.$TST.states.has(state))
          classList.remove(state);
      }
      for (const state of this.$TST.states) {
        if (IGNORE_CLASSES.has(state))
          continue;
        if (!classList.contains(state))
          classList.add(state);
      }

      for (const state of NATIVE_PROPERTIES) {
        if (raw[state] == classList.contains(state))
          continue;
        classList.toggle(state, raw[state]);
      }

      if (this.$TST.childIds.length > 0)
        this.setAttribute(Constants.kCHILDREN, `|${this.$TST.childIds.join('|')}|`);
      else
        this.removeAttribute(Constants.kCHILDREN);

      if (this.$TST.parentId)
        this.setAttribute(Constants.kPARENT, this.$TST.parentId);
      else
        this.removeAttribute(Constants.kPARENT);

      const alreadyGrouped = this.$TST.getAttribute(Constants.kPERSISTENT_ALREADY_GROUPED_FOR_PINNED_OPENER) || '';
      if (this.getAttribute(Constants.kPERSISTENT_ALREADY_GROUPED_FOR_PINNED_OPENER) != alreadyGrouped)
        this.setAttribute(Constants.kPERSISTENT_ALREADY_GROUPED_FOR_PINNED_OPENER, alreadyGrouped);

      const opener = this.$TST.getAttribute(Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID) || '';
      if (this.getAttribute(Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID) != opener)
        this.setAttribute(Constants.kPERSISTENT_ORIGINAL_OPENER_TAB_ID, opener);

      const uri = this.$TST.getAttribute(Constants.kCURRENT_URI) || tab?.url;
      if (this.getAttribute(Constants.kCURRENT_URI) != uri)
        this.setAttribute(Constants.kCURRENT_URI, uri);

      const favIconUri = this.$TST.getAttribute(Constants.kCURRENT_FAVICON_URI) || tab?.favIconUrl;
      if (this.getAttribute(Constants.kCURRENT_FAVICON_URI) != favIconUri)
        this.setAttribute(Constants.kCURRENT_FAVICON_URI, favIconUri);

      const level = this.$TST.getAttribute(Constants.kLEVEL) || 0;
      if (this.getAttribute(Constants.kLEVEL) != level)
        this.setAttribute(Constants.kLEVEL, level);

      const id = this.$TST.uniqueId.id;
      if (this.getAttribute(Constants.kPERSISTENT_ID) != id)
        this.setAttribute(Constants.kPERSISTENT_ID, id);

      if (this.$TST.subtreeCollapsed) {
        if (!classList.contains(Constants.kTAB_STATE_SUBTREE_COLLAPSED))
          classList.add(Constants.kTAB_STATE_SUBTREE_COLLAPSED);
      }
      else {
        if (classList.contains(Constants.kTAB_STATE_SUBTREE_COLLAPSED))
          classList.remove(Constants.kTAB_STATE_SUBTREE_COLLAPSED);
      }
    }

    const group = this.$TST.nativeTabGroup || this.$TST.group;
    if (group) {
      this.style.setProperty('--tab-group-color', `var(--tab-group-color-${group.color})`);
      this.style.setProperty('--tab-group-color-pale', `var(--tab-group-color-${group.color}-pale)`);
      this.style.setProperty('--tab-group-color-invert', `var(--tab-group-color-${group.color}-invert)`);
    }
    if (this.$TST.group) {
      classList.toggle(Constants.kTAB_STATE_SUBTREE_COLLAPSED, group.collapsed);
    }
  }

  get favIconUrl() {
    if (!this.initialized)
      return null;

    return this.favicon.src;
  }

  set favIconUrl(url) {
    this._favIconUrl = url;
    if (!this.initialized || !this.$TST)
      return url;

    if (!url || url.startsWith('data:')) { // we don't need to use the helper for data: URI.
      this.favicon.src = url;
      this.favicon.classList.remove('error');
      return url;
    }

    TabFavIconHelper.loadToImage({
      image: this.favicon,
      tab: this.$TST.tab,
      url
    });
    return url;
  }

  get overflow() {
    const label = this._labelElement;
    return label?.overflow;
  }

  get label() {
    const label = this._labelElement;
    return label ? label.value : null;
  }
  set label(value) {
    const label = this._labelElement;
    if (label)
      label.value = value;

    this.dataset.title = value; // for custom CSS https://github.com/piroor/treestyletab/issues/2242

    if (!this.$TST) // called before binding on restoration from cache
      return;

    this.invalidateTooltip();
    if (this.$TST.collapsed) {
      this._labelElement.invalidateOverflow();
      this._needToUpdateOverflow = true;
    }
  }
}
